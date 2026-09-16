import { isRing, json, type Env, type Ring } from "../index";
import { ringHead, ringMembers } from "../db";
import { REPO_ARCHES } from "../r2";
import { REPO_ORDER } from "../meta";

const MAX_NODES = 2000;

/** The closure of `targets` within the ring's release, one architecture or all: the rows, with D1's count of what it read. */
export function closureRows(env: Env, ring: Ring, arch: string | null, targets: string[], limit: number) {
  return env.DB.prepare(
    `WITH RECURSIVE
       -- MATERIALIZED: the selection is referenced from the recursive step;
       -- without the hint SQLite re-evaluates it on every iteration, which
       -- took a 29k-package ring past 30 s.
       sel(package_id) AS MATERIALIZED (SELECT rp.package_id FROM ${ringMembers(ring)} rp JOIN packages p ON p.id = rp.package_id
                            WHERE (?3 IS NULL OR p.repo_arch = ?3)),
       -- The closure follows what pacman follows: declared dependencies
       -- (package names, or declared capabilities such as libcrypto.so=3-64)
       -- resolved through *declared* provides — never the sonames a binary
       -- loads or ships. A package bundling its own libstdc++ would otherwise
       -- count as a provider of libstdc++.so and pull half the ring in.
       -- CROSS JOIN and INDEXED BY pin the plan: left as a choice, SQLite
       -- probed the providers through an automatic index on \`declared\`
       -- (every provider, per edge) — 20 to 45 million rows read for one
       -- closure of a 16k-package ring, the ABI gate's whole cost. Pinned,
       -- it walks (capability, declared): the ring once, then the edges.
       closure(package_id) AS (
         SELECT p.id FROM packages p JOIN sel ON sel.package_id = p.id
          WHERE p.name IN (SELECT value FROM json_each(?1))
         UNION
         SELECT pv.package_id FROM closure c
           CROSS JOIN package_requires rq INDEXED BY idx_requires_package ON rq.package_id = c.package_id AND rq.kind = 'depends'
                AND rq.symbol_version IS NULL AND rq.requirement NOT GLOB '*.so.[0-9]*'
           CROSS JOIN package_provides pv INDEXED BY idx_provides_declared ON pv.capability = rq.requirement AND pv.declared = 1
           CROSS JOIN sel ON sel.package_id = pv.package_id
       )
     SELECT p.manifest_json, p.source, p.repo_arch FROM packages p WHERE p.id IN (SELECT package_id FROM closure)
     ORDER BY p.name, p.source LIMIT ?2`,
  )
    .bind(JSON.stringify(targets), limit, arch)
    .all<{ manifest_json: string; source: string; repo_arch: string }>();
}

/**
 * Transitive dependency closure of `targets` within a ring's current release,
 * computed with a recursive CTE: requires → provides, restricted to packages in
 * the release. Requirements satisfied outside the release (e.g. glibc from the
 * Arch repos) simply do not expand; the client checks those against the local
 * pacman database.
 */
export async function handleGraph(url: URL, env: Env): Promise<Response> {
  const targets = (url.searchParams.get("targets") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ring = url.searchParams.get("ring") ?? env.DEFAULT_RING;
  // A multi-architecture release holds one row per (source, name, repo_arch);
  // a client only resolves within its own architecture, and takes one build
  // per name in `source_order` — the include's order (meta.ts REPO_ORDER).
  const arch = url.searchParams.get("arch");
  if (targets.length === 0) return json({ error: "targets is required" }, 400);
  if (arch !== null && !(REPO_ARCHES as readonly string[]).includes(arch)) return json({ error: "unknown arch" }, 400);
  if (!isRing(ring)) return json({ error: "unknown ring" }, 400);
  const head = await ringHead(env, ring);
  if (!head) return json({ error: `ring ${ring} has no release yet` }, 404);
  const rows = await closureRows(env, ring, arch, targets, MAX_NODES + 1);

  const packages = rows.results.slice(0, MAX_NODES).map((r) => {
    const m = JSON.parse(r.manifest_json) as { name: string; source?: string; repo_arch?: string };
    m.source = r.source;
    m.repo_arch = r.repo_arch;
    return m;
  });
  const found = new Set(packages.map((p: { name: string }) => p.name));
  return json({
    ring,
    arch,
    release_id: head.id,
    source_order: REPO_ORDER,
    packages,
    missing_targets: targets.filter((t) => !found.has(t)),
    truncated: rows.results.length > MAX_NODES,
  });
}
