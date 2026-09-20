import { isRing, json, RINGS, RINGS_BY_STABILITY, type Env, type Ring } from "../index";
import { isRepoArch, packageKey } from "../r2";
import { ringHead, ringMembers } from "../db";
import { sourceRank } from "../meta";
import { maintenanceOf } from "./users";
import { sealOf } from "./seal";
import { provenanceOf } from "../provenance";
import { gunzipJson } from "../gzip";

/**
 * Package search and the package page's data, always within a ring's current
 * release and one architecture.
 *
 *   GET /search?q=&ring=stable&arch=x86_64&limit=50
 *   GET /package/:name?ring=stable&arch=x86_64   any of RINGS, the lab included; `shown_ring` says which ring's
 *                                                  object the answer is — the asked one, else the most stable that has it
 *   GET /package/:name/files?ring=stable&arch=x86_64
 */

interface PackageRow {
  id: number;
  name: string;
  version: string;
  arch: string;
  repo_arch: string;
  source: string;
  filename: string;
  sha256: string;
  size_download: number;
  size_installed: number;
  has_signature: number;
  created_at: string;
  // The object's key in the bucket, `<source>/<arch>/<filename>` (r2.ts): the row carries it, the page's links go by it.
  r2_key: string | null;
  manifest_json?: string;
}

function scope(url: URL, env: Env): { ring: Ring; arch: string } | Response {
  const ring = url.searchParams.get("ring") ?? env.DEFAULT_RING;
  const arch = url.searchParams.get("arch") ?? "x86_64";
  if (!isRing(ring)) return json({ error: "unknown ring" }, 400);
  if (!isRepoArch(arch)) return json({ error: "unknown arch" }, 400);
  return { ring, arch };
}

export async function handleSearch(url: URL, env: Env): Promise<Response> {
  const s = scope(url, env);
  if (s instanceof Response) return s;
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 50)), 200);
  if (q.length < 2) return json({ error: "q must have at least 2 characters" }, 400);
  const head = await ringHead(env, s.ring);
  if (!head) return json({ ring: s.ring, arch: s.arch, query: q, packages: [] });
  const like = `%${q.replace(/[%_]/g, (c) => "\\" + c)}%`;
  const rows = await env.DB.prepare(
    `SELECT p.name, p.version, p.repo_arch, p.source, p.size_download, p.sha256,
            json_extract(p.manifest_json, '$.description') AS description
       FROM ${ringMembers(s.ring)} rp JOIN packages p ON p.id = rp.package_id
      WHERE p.repo_arch = ?1
        AND (p.name LIKE ?2 ESCAPE '\\' OR json_extract(p.manifest_json, '$.description') LIKE ?2 ESCAPE '\\')
      ORDER BY CASE WHEN p.name = ?3 THEN 0 WHEN p.name LIKE ?4 ESCAPE '\\' THEN 1 WHEN p.name LIKE ?2 ESCAPE '\\' THEN 2 ELSE 3 END, p.name
      LIMIT ?5`,
  )
    .bind(s.arch, like, q, `${q.replace(/[%_]/g, (c) => "\\" + c)}%`, limit)
    .all();
  return json({ ring: s.ring, arch: s.arch, release_id: head.id, query: q, packages: rows.results }, 200, { "cache-control": "public, max-age=60" });
}

/** The package name (or soname) a dependency string refers to: `foo>=1.2` → `foo`. */
function capabilityOf(dep: string): string {
  return dep.split(/[<>=]/)[0].trim();
}

/**
 * The ring's objects of these names, one architecture: the rows the
 * package page resolves its providers' advisories through, with D1's count
 * of what it read. The order is forced (CROSS JOIN): from the few names
 * through the packages name index, then a point lookup on the ring's
 * primary key — the same trap as the edges below and the 2026-09-15 lesson.
 * Left to itself the planner walked the whole ring for every page view —
 * `p.name IN (json_each)` over the ring's members, 64.8 k rows read per
 * call, 1.6 B a day under the crawl that began on 2026-09-19 — where the
 * same 94 rows of ffmpeg's page are 377 this way. A join driven by
 * json_each answers one row per list entry, so `names` must be unique: the
 * caller hands a Set. test/package-page.test.ts measures it.
 */
export function providersInRing(env: Env, ring: Ring, arch: string, names: string[]) {
  return env.DB.prepare(
    `SELECT p.id, p.name
       FROM json_each(?2) j
       CROSS JOIN packages p ON p.name = j.value AND p.repo_arch = ?1
      WHERE EXISTS (SELECT 1 FROM ring_packages rp WHERE rp.ring = '${ring}' AND rp.package_id = p.id)`,
  )
    .bind(arch, JSON.stringify(names))
    .all<{ id: number; name: string }>();
}

export async function handlePackage(name: string, url: URL, env: Env): Promise<Response> {
  const s = scope(url, env);
  if (s instanceof Response) return s;

  // Where the package is in every ring (for this architecture): one row
  // per source that builds it, in the order of the include — the first is
  // what pacman takes. The page shows the requested ring's object (the
  // requested source's with `source=`, else the winning one), or — when
  // the asked ring does not serve it — the most stable ring that does
  // (RINGS_BY_STABILITY), and says which in `shown_ring`: a link that asks
  // for the lab of a package that already reached stable lands on the
  // object people install, not on edge because it came first in RINGS.
  const wantSource = url.searchParams.get("source");
  const heads = await Promise.all(RINGS.map(async (ring) => ({ ring, head: await ringHead(env, ring) })));
  const inRings: { ring: string; release_id: number; release_seq: number; version: string; sha256: string; size_download: number; source: string; filename: string; created_at: string }[] = [];
  const rowsByRing = new Map<string, PackageRow>();
  for (const { ring, head } of heads) {
    if (!head) continue;
    const rows = await env.DB.prepare(
      `SELECT p.id, p.name, p.version, p.arch, p.repo_arch, p.source, p.filename, p.sha256, p.size_download, p.size_installed, p.has_signature, p.created_at, p.r2_key
         FROM ${ringMembers(ring)} rp JOIN packages p ON p.id = rp.package_id
        WHERE p.name = ?1 AND p.repo_arch = ?2`,
    )
      .bind(name, s.arch)
      .all<PackageRow>();
    const ordered = rows.results.sort((a, b) => sourceRank(a.source) - sourceRank(b.source) || a.source.localeCompare(b.source));
    if (!ordered.length) continue;
    rowsByRing.set(ring, ordered.find((r) => r.source === wantSource) ?? ordered[0]);
    for (const row of ordered) {
      inRings.push({ ring, release_id: head.id, release_seq: head.seq, version: row.version, sha256: row.sha256, size_download: row.size_download, source: row.source, filename: row.filename, created_at: row.created_at });
    }
  }
  const shownRing: Ring | undefined = rowsByRing.has(s.ring) ? s.ring : RINGS_BY_STABILITY.find((r) => rowsByRing.has(r));
  const chosen = shownRing ? rowsByRing.get(shownRing) : undefined;
  const pick = chosen ? inRings.find((r) => r.ring === shownRing && r.sha256 === chosen.sha256) : undefined;
  if (!pick || !chosen || !shownRing) return json({ error: `${name} is not in any ring for ${s.arch}` }, 404);
  const head = heads.find((h) => h.ring === pick.ring)?.head;
  if (!head) return json({ error: "ring vanished" }, 500);
  // The edges — what it depends on, what depends on it, what it is exposed
  // through — are resolved in the ring the object is shown from, so the
  // page reads one ring throughout; resolving them in the asked ring drew
  // stable's object with the lab's (empty) neighbours.
  const ring = shownRing;

  const full = await env.DB.prepare("SELECT manifest_json FROM packages WHERE id = ?").bind(chosen.id).first<{ manifest_json: string }>();
  const manifest = JSON.parse(full?.manifest_json ?? "{}") as {
    description?: string;
    url?: string;
    licenses?: string[];
    pkginfo?: { base?: string; builddate?: number; packager?: string; groups?: string[]; depends?: string[]; optdepends?: string[]; provides?: string[]; conflicts?: string[]; replaces?: string[] };
    provides?: string[];
    requires?: string[];
    optional?: string[];
    files?: string[];
  };
  delete manifest.files;

  // Forward edges: declared dependencies and the sonames its binaries load,
  // each resolved to the package that provides it within this ring.
  const declared = (manifest.pkginfo?.depends ?? []).map(capabilityOf);
  const sonames = (manifest.requires ?? []).filter((r) => /\.so(\.|$|\()/.test(r)).map((r) => r.replace(/\(.*\)$/, ""));
  const wanted = [...new Set([...declared, ...sonames])];
  const providers = new Map<string, { name: string; version: string }>();
  for (let i = 0; i < wanted.length; i += 100) {
    const chunk = wanted.slice(i, i + 100);
    // Two indexed lookups (by name, by provided capability) instead of one
    // OR that scanned every package of the architecture, in a forced order
    // (CROSS JOIN): from the wanted capabilities into the ring, never the
    // other way round — the planner's choice walked the ring's members and
    // read 3.8 M rows for google-chrome's page; 1.4 k this way.
    const rows = await env.DB.prepare(
      `SELECT DISTINCT capability, name, version FROM (
         SELECT cap.value AS capability, p.name, p.version
           FROM json_each(?1) cap
           CROSS JOIN packages p ON p.name = cap.value AND p.repo_arch = ?2
           CROSS JOIN ring_packages rp ON rp.ring = '${ring}' AND rp.package_id = p.id
         UNION ALL
         SELECT cap.value AS capability, p.name, p.version
           FROM json_each(?1) cap
           CROSS JOIN package_provides pv ON pv.capability = cap.value AND (pv.declared = 1 OR cap.value GLOB '*.so.[0-9]*')
           CROSS JOIN packages p ON p.id = pv.package_id AND p.repo_arch = ?2
           CROSS JOIN ring_packages rp ON rp.ring = '${ring}' AND rp.package_id = p.id
       )`,
    )
      .bind(JSON.stringify(chunk), s.arch)
      .all<{ capability: string; name: string; version: string }>();
    for (const r of rows.results) if (!providers.has(r.capability)) providers.set(r.capability, { name: r.name, version: r.version });
  }
  const depends = declared.map((c) => ({ name: c, provider: providers.get(c) ?? null }));
  const links = [...new Set(sonames)].map((so) => ({ soname: so, provider: providers.get(so) ?? null }));

  // Reverse edges: packages in the ring that depend on this one by name or
  // by something it provides (a soname = a binary that actually loads it).
  // Same forced order: capabilities → requirement index → ring (366 k rows
  // read per page before, seven for a package nothing depends on).
  const caps = [chosen.name, ...(manifest.provides ?? []).map(capabilityOf)];
  const reverse = await env.DB.prepare(
    `SELECT DISTINCT p.name, p.version, rq.requirement
       FROM json_each(?1) cap
       CROSS JOIN package_requires rq ON rq.requirement = cap.value AND rq.kind = 'depends'
       CROSS JOIN ring_packages rp ON rp.ring = '${ring}' AND rp.package_id = rq.package_id
       CROSS JOIN packages p ON p.id = rq.package_id AND p.repo_arch = ?2 AND p.name != ?3
      ORDER BY p.name LIMIT 400`,
  )
    .bind(JSON.stringify([...new Set(caps)]), s.arch, chosen.name)
    .all<{ name: string; version: string; requirement: string }>();
  const requiredBy = new Map<string, { name: string; version: string; declared: boolean; sonames: string[] }>();
  for (const r of reverse.results) {
    const e = requiredBy.get(r.name) ?? { name: r.name, version: r.version, declared: false, sonames: [] };
    if (/\.so(\.|$)/.test(r.requirement)) e.sonames.push(r.requirement);
    else e.declared = true;
    requiredBy.set(r.name, e);
  }

  // Security: advisories on this object, and open ones on what it depends on
  // or loads (direct exposure; deeper levels are the graph's job).
  const advisoriesOf = async (ids: number[]) =>
    ids.length
      ? (
          await env.DB.prepare(
            `SELECT pa.package_id, pa.match, pa.status AS object_status, a.id, a.source AS tracker, a.package, a.cves, a.severity, a.fixed, a.summary, a.url,
                    (SELECT MAX(c.kev) FROM cve_meta c WHERE c.cve IN (SELECT value FROM json_each(a.cves))) AS kev,
                    (SELECT MAX(c.epss) FROM cve_meta c WHERE c.cve IN (SELECT value FROM json_each(a.cves))) AS epss
               FROM package_advisories pa JOIN advisories a ON a.id = pa.advisory_id
              WHERE pa.package_id IN (SELECT value FROM json_each(?))
              ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
          )
            .bind(JSON.stringify(ids))
            .all<{ package_id: number; match: string; object_status: string; id: string; tracker: string; package: string; cves: string; severity: string; fixed: string | null; summary: string | null; url: string; kev: number | null; epss: number | null }>()
        ).results.map((r) => ({ ...r, cves: JSON.parse(r.cves) as string[], kev: !!r.kev }))
      : [];
  const own = await advisoriesOf([chosen.id]);
  const providerNames = [...new Set([...depends, ...links].map((x) => x.provider?.name).filter((n): n is string => !!n))];
  const providerIds = providerNames.length ? (await providersInRing(env, ring, s.arch, providerNames)).results : [];
  const providerAdvisories = (await advisoriesOf(providerIds.map((p) => p.id))).filter((a) => a.object_status === "vulnerable");
  const nameOfId = new Map(providerIds.map((p) => [p.id, p.name]));
  const exposed = providerAdvisories.map((a) => ({
    via: nameOfId.get(a.package_id),
    declared: depends.some((d) => d.provider?.name === nameOfId.get(a.package_id)),
    sonames: links.filter((l) => l.provider?.name === nameOfId.get(a.package_id)).map((l) => l.soname),
    advisory: { id: a.id, tracker: a.tracker, cves: a.cves, severity: a.severity, fixed: a.fixed, summary: a.summary, url: a.url, match: a.match, kev: a.kev, epss: a.epss },
  }));

  return json(
    {
      name: chosen.name,
      arch: s.arch,
      // The ring asked for and the ring the object is shown from: equal when the asked ring serves it, else the most stable that does.
      ring: s.ring,
      shown_ring: pick.ring,
      security: {
        advisories: own.map((a) => ({ id: a.id, tracker: a.tracker, cves: a.cves, severity: a.severity, status: a.object_status, match: a.match, fixed: a.fixed, summary: a.summary, url: a.url, kev: a.kev, epss: a.epss })),
        exposed,
      },
      rings: inRings,
      maintenance: await maintenanceOf(env, chosen.name, chosen.source, manifest.pkginfo?.packager),
      // An OPR package: where its recipe comes from (omacom/omarchy-pkgs, read daily).
      provenance: chosen.source === "packages" ? await provenanceOf(env, chosen.name) : null,
      // The seal: where this object came from and the proof (routes/seal.ts).
      seal: await sealOf(env, chosen.sha256),
      package: { version: chosen.version, arch: chosen.arch, source: chosen.source, filename: chosen.filename, sha256: chosen.sha256, size_download: chosen.size_download, size_installed: chosen.size_installed, has_signature: chosen.has_signature === 1, created_at: chosen.created_at },
      manifest,
      depends,
      links,
      required_by: [...requiredBy.values()],
      // The object the page links (download, .sig): by the row's key, as the seal does — the bucket is laid out per
      // source since the relayout, so a key built from the arch alone answers 404. A row indexed before the key column
      // existed gets the same key computed.
      pool_url: `${env.POOL_URL.replace(/\/$/, "")}/${chosen.r2_key ?? packageKey(chosen.source, chosen.repo_arch, chosen.filename)}`,
    },
    200,
    // Ten minutes at the edge: everything behind the page — sync, promote,
    // the security job — moves every three hours (scheduler.ts), so the
    // only thing a reader can see late is a fresh approval or a promotion,
    // by up to ten minutes; a crawler fetching each page a few times a day
    // hit a one-minute cache 13 % of the time (2026-09-19).
    { "cache-control": "public, max-age=600" },
  );
}

export async function handlePackageFiles(name: string, url: URL, env: Env): Promise<Response> {
  const s = scope(url, env);
  if (s instanceof Response) return s;
  const head = await ringHead(env, s.ring);
  if (!head) return json({ error: `ring ${s.ring} has no release yet` }, 404);
  const row = await env.DB.prepare(
    `SELECT p.id, p.manifest_json FROM ${ringMembers(s.ring)} rp JOIN packages p ON p.id = rp.package_id
      WHERE p.name = ?1 AND p.repo_arch = ?2`,
  )
    .bind(name, s.arch)
    .first<{ id: number; manifest_json: string }>();
  if (!row) return json({ error: `${name} is not in ${s.ring} for ${s.arch}` }, 404);
  const gz = await env.DB.prepare("SELECT gz FROM package_file_lists WHERE package_id = ?").bind(row.id).first<{ gz: ArrayBuffer | number[] }>();
  const files = gz ? await gunzipJson<string[]>(gz.gz) : ((JSON.parse(row.manifest_json) as { files?: string[] }).files ?? []);
  return json({ name, ring: s.ring, arch: s.arch, files }, 200, { "cache-control": "public, max-age=300" });
}
