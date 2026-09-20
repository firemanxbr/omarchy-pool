import { advisoriesKnown } from "./stats";
import { isRing, json, readJson, RINGS, type Env, type Ring } from "../index";
import { isRepoArch } from "../r2";
import { SEVERITIES as META_SEVERITIES } from "../meta";
import { ringHead, ringMembers } from "../db";

/**
 * Security data.
 *
 *   PUT  /security/advisories   {advisories: [...], cves: [...]}   upsert (pipeline)
 *   PUT  /security/matches      {matches: [{sha256, advisory, match, status}]} (pipeline)
 *   POST /security/prune        {advisories: [id], matches: [[sha256, advisory]]}  drop what the run did not post (pipeline)
 *   GET  /security?ring=&arch=  what a ring serves that is vulnerable, and what that exposes
 *
 * The job posts its whole set every three hours (4.6 k advisories, 8 k CVEs,
 * 7.4 k matches on production) and the set changes by dozens of rows a day.
 * D1 bills every row an UPDATE touches, index entries included — an
 * unconditional upsert wrote 3 + 1 + 2 rows per unchanged advisory, CVE and
 * match, 290 k rows a day (2026-09-18/19). Every DO UPDATE below carries a
 * WHERE over the row's values against `excluded`'s (row-value IS NOT, NULLs
 * compare as values), so an unchanged row writes nothing; updated_at is in
 * every SET and in no WHERE, and now means "last changed". That is why the
 * prune can no longer look for what an earlier run wrote by updated_at: the
 * run posts the keys it holds and the prune deletes the rest.
 */

interface AdvisoryIn {
  id: string;
  source: string;
  package: string;
  cves: string[];
  severity: string;
  status: string;
  affected?: string | null;
  fixed?: string | null;
  summary?: string | null;
  url: string;
}
interface CveIn {
  cve: string;
  kev?: boolean;
  kev_added?: string | null;
  epss?: number | null;
  epss_percentile?: number | null;
}
interface MatchIn {
  sha256: string;
  advisory: string;
  match: string;
  status: string;
}

// The severities are meta.ts's, worst first: the shell ranks a package's advisories by the same list.
const SEVERITIES: readonly string[] = META_SEVERITIES;

export async function handlePutAdvisories(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ advisories?: AdvisoryIn[]; cves?: CveIn[]; updated_at?: string }>(request);
  if (body instanceof Response) return body;
  const now = body.updated_at ?? new Date().toISOString();
  const stmts = [];
  for (const a of body.advisories ?? []) {
    if (!a.id || !a.package || !a.url) return json({ error: "advisory needs id, package, url" }, 400);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO advisories (id, source, package, cves, severity, status, affected, fixed, summary, url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET source = excluded.source, package = excluded.package, cves = excluded.cves, severity = excluded.severity,
           status = excluded.status, affected = excluded.affected, fixed = excluded.fixed, summary = excluded.summary, url = excluded.url, updated_at = excluded.updated_at
         WHERE (source, package, cves, severity, status, affected, fixed, summary, url)
            IS NOT (excluded.source, excluded.package, excluded.cves, excluded.severity, excluded.status, excluded.affected, excluded.fixed, excluded.summary, excluded.url)`,
      ).bind(a.id, a.source, a.package, JSON.stringify(a.cves ?? []), SEVERITIES.includes(a.severity) ? a.severity : "unknown", a.status, a.affected ?? null, a.fixed ?? null, a.summary ?? null, a.url, now),
    );
  }
  for (const c of body.cves ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO cve_meta (cve, kev, kev_added, epss, epss_percentile, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (cve) DO UPDATE SET kev = excluded.kev, kev_added = excluded.kev_added, epss = excluded.epss, epss_percentile = excluded.epss_percentile, updated_at = excluded.updated_at
         WHERE (kev, kev_added, epss, epss_percentile) IS NOT (excluded.kev, excluded.kev_added, excluded.epss, excluded.epss_percentile)`,
      ).bind(c.cve, c.kev ? 1 : 0, c.kev_added ?? null, milli(c.epss), milli(c.epss_percentile), now),
    );
  }
  const written = await batched(env, stmts);
  return json({ advisories: (body.advisories ?? []).length, cves: (body.cves ?? []).length, updated_at: now, rows_written: written });
}

/**
 * An EPSS score to three decimals: the pages show it as a percentage, and
 * FIRST republishes every score daily with the fifth decimal moved — kept
 * whole, the refresh rewrote all 8 k CVEs each day for nothing.
 */
const milli = (x: number | null | undefined): number | null => (x == null ? null : Math.round(x * 1000) / 1000);

/** Runs the statements a hundred at a time and adds up the rows D1 wrote — what the job's writes cost, and what the tests pin. */
async function batched(env: Env, stmts: D1PreparedStatement[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < stmts.length; i += 100) for (const r of await env.DB.batch(stmts.slice(i, i + 100))) written += r.meta.rows_written ?? 0;
  return written;
}

export async function handlePutMatches(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ matches?: MatchIn[]; updated_at?: string }>(request);
  if (body instanceof Response) return body;
  const now = body.updated_at ?? new Date().toISOString();
  const matches = body.matches ?? [];
  const shas = [...new Set(matches.map((m) => m.sha256))];
  const ids = new Map<string, number>();
  for (let i = 0; i < shas.length; i += 200) {
    const rows = await env.DB.prepare("SELECT id, sha256 FROM packages WHERE sha256 IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(shas.slice(i, i + 200)))
      .all<{ id: number; sha256: string }>();
    for (const r of rows.results) ids.set(r.sha256, r.id);
  }
  const stmts = [];
  let unknown = 0;
  for (const m of matches) {
    const id = ids.get(m.sha256);
    if (!id) {
      unknown++;
      continue;
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO package_advisories (package_id, advisory_id, match, status, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (package_id, advisory_id) DO UPDATE SET match = excluded.match, status = excluded.status, updated_at = excluded.updated_at
         WHERE (match, status) IS NOT (excluded.match, excluded.status)`,
      ).bind(id, m.advisory, m.match, m.status, now),
    );
  }
  const written = await batched(env, stmts);
  return json({ matches: stmts.length, unknown_sha256: unknown, updated_at: now, rows_written: written });
}

/**
 * The prune closes a run: the body is the key set the run posted — every
 * advisory id and every (sha256, advisory) match — and what the index holds
 * beyond it goes. The index is read whole (4.6 k ids and 7.4 k matches with
 * their sha256, 20 k rows read per run = US$ 0.0002 a day) and diffed here;
 * the deletes name their keys, two hundred at a time, and walk the primary
 * keys (EXPLAIN on production: SEARCH ... USING COVERING INDEX). A body
 * without both arrays is an older pkg-repo's prune, which used to delete by
 * updated_at: it is refused and journalled, and nothing is deleted — the
 * Studio workers follow the latest image within 45 minutes, and a stale
 * match waits for the next run rather than the whole table going.
 */
export async function handlePrune(request: Request, url: URL, env: Env): Promise<Response> {
  const body = await readJson<{ advisories?: unknown; matches?: unknown }>(request);
  if (body instanceof Response) return body;
  const before = url.searchParams.get("before");
  if (!Array.isArray(body.advisories) || !Array.isArray(body.matches)) {
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('security', NULL, NULL, 'warn', ?, ?)")
      .bind("a prune without the run's keys was refused: nothing deleted (an older pkg-repo? the prune posts the advisories and matches it holds)", JSON.stringify({ before, refused: "prune" }))
      .run();
    return json({ error: "the prune needs the run's advisories and matches arrays" }, 400);
  }
  const keptAdvisories = new Set(body.advisories as string[]);
  const keptMatches = new Set((body.matches as [string, string][]).map(([sha256, advisory]) => `${sha256}\0${advisory}`));

  const held = await env.DB.prepare("SELECT pa.package_id, pa.advisory_id, p.sha256 FROM package_advisories pa JOIN packages p ON p.id = pa.package_id")
    .all<{ package_id: number; advisory_id: string; sha256: string }>();
  const goneMatches = held.results.filter((r) => !keptMatches.has(`${r.sha256}\0${r.advisory_id}`)).map((r) => [r.package_id, r.advisory_id]);
  const ids = await env.DB.prepare("SELECT id FROM advisories").all<{ id: string }>();
  const goneAdvisories = ids.results.filter((r) => !keptAdvisories.has(r.id)).map((r) => r.id);

  let matches = 0, advisories = 0;
  for (let i = 0; i < goneMatches.length; i += 200) {
    const r = await env.DB.prepare("DELETE FROM package_advisories WHERE (package_id, advisory_id) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))")
      .bind(JSON.stringify(goneMatches.slice(i, i + 200)))
      .run();
    matches += r.meta.changes ?? 0;
  }
  // An advisory's matches go with it (ON DELETE CASCADE); those were absent from the run too.
  for (let i = 0; i < goneAdvisories.length; i += 200) {
    const r = await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(goneAdvisories.slice(i, i + 200))).run();
    advisories += r.meta.changes ?? 0;
  }
  return json({ pruned: { matches, advisories } });
}

/**
 * GET /security/components — what the rings' packages embed (Go modules,
 * crates.io crates), one entry per (ecosystem, name, version) with the
 * sha256 of every served object that embeds it. The security job asks OSV
 * about these; no soname would ever reveal them.
 */
export async function handleComponents(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT c.ecosystem, c.name, c.version, p.sha256
       FROM package_components c JOIN packages p ON p.id = c.package_id
      WHERE p.id IN (SELECT package_id FROM ring_packages)
      ORDER BY c.ecosystem, c.name, c.version`,
  ).all<{ ecosystem: string; name: string; version: string; sha256: string }>();
  const out = new Map<string, { ecosystem: string; name: string; version: string; sha256s: string[] }>();
  for (const r of rows.results) {
    const k = `${r.ecosystem}\0${r.name}\0${r.version}`;
    const e = out.get(k) ?? { ecosystem: r.ecosystem, name: r.name, version: r.version, sha256s: [] };
    e.sha256s.push(r.sha256);
    out.set(k, e);
  }
  return json({ components: [...out.values()] }, 200, { "cache-control": "public, max-age=300" });
}

/** Open advisories on the objects a ring serves, and what depends on them. */
export async function handleSecurity(url: URL, env: Env): Promise<Response> {
  const ring = url.searchParams.get("ring") ?? env.DEFAULT_RING;
  const arch = url.searchParams.get("arch") ?? "x86_64";
  if (!isRing(ring)) return json({ error: "unknown ring" }, 400);
  if (!isRepoArch(arch)) return json({ error: "unknown arch" }, 400);
  const head = await ringHead(env, ring);
  if (!head) return json({ ring, arch, vulnerable: [], totals: {} });

  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.version, p.source, a.id AS advisory, a.source AS tracker, a.cves, a.severity, a.fixed, a.summary, a.url, pa.match,
            (SELECT MAX(c.kev) FROM cve_meta c WHERE c.cve IN (SELECT value FROM json_each(a.cves))) AS kev,
            (SELECT MAX(c.epss) FROM cve_meta c WHERE c.cve IN (SELECT value FROM json_each(a.cves))) AS epss
       FROM ${ringMembers(ring)} rp
       JOIN packages p ON p.id = rp.package_id AND p.repo_arch = ?1
       JOIN package_advisories pa ON pa.package_id = p.id AND pa.status = 'vulnerable'
       JOIN advisories a ON a.id = pa.advisory_id
      ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, p.name`,
  )
    .bind(arch)
    .all<{ id: number; name: string; version: string; source: string; advisory: string; tracker: string; cves: string; severity: string; fixed: string | null; summary: string | null; url: string; match: string; kev: number | null; epss: number | null }>();

  // Group per package; note whether a fixed object exists in another ring
  // (the fast-track candidate) and how many packages depend on it.
  const byPkg = new Map<string, { id: number; name: string; version: string; source: string; advisories: unknown[]; worst: string; kev: boolean; epss: number | null }>();
  const rank = (s: string) => SEVERITIES.indexOf(s);
  for (const r of rows.results) {
    const e = byPkg.get(r.name) ?? { id: r.id, name: r.name, version: r.version, source: r.source, advisories: [], worst: "unknown", kev: false, epss: null };
    e.advisories.push({ id: r.advisory, tracker: r.tracker, cves: JSON.parse(r.cves), severity: r.severity, fixed: r.fixed, summary: r.summary, url: r.url, match: r.match, kev: !!r.kev, epss: r.epss });
    if (rank(r.severity) < rank(e.worst)) e.worst = r.severity;
    if (r.kev) e.kev = true;
    if (r.epss != null && (e.epss == null || r.epss > e.epss)) e.epss = r.epss;
    byPkg.set(r.name, e);
  }
  const vulnerable = [...byPkg.values()];

  // Where is a version without open advisories? (per ring, same name/arch)
  // Clean must mean examined: a package whose vulnerable object carries
  // embedded components (Go modules, crates — what the OSV advisories are
  // about) is only clean elsewhere when that object was scanned for them
  // too; one indexed before the scan existed has no components and no
  // advisories, and knows nothing (smolvm 1.15.0 "clean" in rc, 2026-09-14).
  // The lab is not a ring a fix can be "in": nothing there is promised.
  const otherHeads = await Promise.all(RINGS.filter((r) => r !== ring && r !== "lab").map(async (r) => ({ ring: r as Ring, head: await ringHead(env, r) })));
  const fixedElsewhere = new Map<string, { ring: string; version: string }[]>();
  if (vulnerable.length) {
    const withComponents = new Set(
      (
        await env.DB.prepare("SELECT DISTINCT p.name FROM package_components c JOIN packages p ON p.id = c.package_id WHERE c.package_id IN (SELECT value FROM json_each(?))")
          .bind(JSON.stringify(vulnerable.map((v) => v.id)))
          .all<{ name: string }>()
      ).results.map((r) => r.name),
    );
    for (const { ring: r, head: h } of otherHeads) {
      if (!h) continue;
      const clean = await env.DB.prepare(
        `SELECT p.name, p.version, EXISTS (SELECT 1 FROM package_components c WHERE c.package_id = p.id) AS scanned
           FROM ${ringMembers(r)} rp JOIN packages p ON p.id = rp.package_id
          WHERE p.repo_arch = ?1 AND p.name IN (SELECT value FROM json_each(?2))
            AND NOT EXISTS (SELECT 1 FROM package_advisories pa WHERE pa.package_id = p.id AND pa.status = 'vulnerable')`,
      )
        .bind(arch, JSON.stringify(vulnerable.map((v) => v.name)))
        .all<{ name: string; version: string; scanned: number }>();
      for (const c of clean.results) {
        if (withComponents.has(c.name) && !c.scanned) continue;
        fixedElsewhere.set(c.name, [...(fixedElsewhere.get(c.name) ?? []), { ring: r, version: c.version }]);
      }
    }
  }

  // Exposure: packages in the ring that depend on a vulnerable one — by
  // declared name, or by loading a library it provides. The join order is
  // forced (CROSS JOIN): from the few vulnerable packages and what they
  // provide, through package_requires' requirement index, into the ring.
  // Left to itself the planner walked the ring instead — every member's
  // requires, then a lookup of the vulnerable set — 3.1 M rows read per
  // call on stable, twice (this and the total), against 108 k for the two
  // together now; the Security page ran it forty times an hour
  // (2026-09-15, the day the cost guard tripped).
  // Only confident advisories (exact, name-version) propagate: a name-only
  // one on glibc would mark the whole ring as exposed and say nothing.
  const confident = vulnerable.filter((v) => (v.advisories as { match: string }[]).some((a) => a.match !== "name-only"));
  const exposure = new Map<string, { declared: number; loads: number }>();
  let exposedTotal = 0;
  if (confident.length) {
    const ex = await env.DB.prepare(
      `WITH vuln(id, name) AS MATERIALIZED (
             SELECT p.id, p.name FROM json_each(?2) j JOIN packages p ON p.id = j.value),
           caps(vuln_id, vuln, capability) AS MATERIALIZED (
             SELECT v.id, v.name, v.name FROM vuln v
             UNION
             SELECT v.id, v.name, pv.capability FROM vuln v JOIN package_provides pv ON pv.package_id = v.id AND pv.capability != v.name),
           hits AS (
             SELECT c.vuln, c.capability = c.vuln AS declared, rq.package_id AS dep
               FROM caps c
               CROSS JOIN package_requires rq ON rq.requirement = c.capability AND rq.kind = 'depends'
               CROSS JOIN ring_packages rp ON rp.ring = '${ring}' AND rp.package_id = rq.package_id
               CROSS JOIN packages d ON d.id = rq.package_id AND d.repo_arch = ?1 AND d.id != c.vuln_id)
       SELECT NULL AS vuln, 0 AS declared, 0 AS loads, COUNT(DISTINCT dep) AS exposed FROM hits
       UNION ALL
       SELECT vuln,
              COUNT(DISTINCT CASE WHEN declared THEN dep END) AS declared,
              COUNT(DISTINCT CASE WHEN NOT declared THEN dep END) AS loads,
              0 AS exposed
         FROM hits GROUP BY vuln`,
    )
      .bind(arch, JSON.stringify(confident.map((v) => v.id)))
      .all<{ vuln: string | null; declared: number; loads: number; exposed: number }>();
    for (const r of ex.results) {
      if (r.vuln === null) exposedTotal = r.exposed;
      else exposure.set(r.vuln, { declared: r.declared, loads: r.loads });
    }
  }

  const totals: Record<string, number> = { packages: vulnerable.length, exposed: exposedTotal, kev: vulnerable.filter((v) => v.kev).length };
  for (const s of SEVERITIES) totals[s] = vulnerable.filter((v) => v.worst === s).length;
  // The last run that matched: a refused prune is a 'security' warn line with no counts.
  const lastRun = await env.DB.prepare("SELECT created_at, payload FROM events WHERE kind = 'security' AND status = 'ok' ORDER BY id DESC LIMIT 1").first<{ created_at: string; payload: string }>();
  const known = lastRun ? advisoriesKnown(JSON.parse(lastRun.payload) as Record<string, unknown>, lastRun.created_at) : null;
  return json(
    {
      ring,
      arch,
      release_id: head.id,
      updated_at: known?.updated_at ?? null,
      advisories_total: known?.advisories ?? 0,
      totals,
      vulnerable: vulnerable.map((v) => ({ ...v, id: undefined, fixed_in: fixedElsewhere.get(v.name) ?? [], exposure: exposure.get(v.name) ?? { declared: 0, loads: 0 } })),
    },
    200,
    // Half an hour at the edge: the layer runs every three hours, and every
    // miss walks the ring's members twice on both architectures.
    { "cache-control": "public, max-age=1800" },
  );
}
