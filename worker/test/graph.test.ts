import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";

// A ring of N packages: every package provides its own name and requires
// three names below it (a DAG); the closure of a target set is what the
// thin client's planner asks /graph for — and what the ABI gate pays for.
async function seedRing(n: number) {
  const pk: string[] = [], rq: string[] = [], pv: string[] = [], rp: string[] = [];
  for (let i = 1; i <= n; i++) {
    pk.push(`(${i}, 'sha${i}', 'pkg${i}', '1-1', 'x86_64', 'pkg${i}-1-1-x86_64.pkg.tar.zst', 100, 100, 1, '{"name":"pkg${i}","version":"1-1"}', 'extra', 'extra/x86_64/pkg${i}', 'x86_64')`);
    pv.push(`(${i}, 'pkg${i}', NULL, 1)`);
    for (let k = 1; k <= 3; k++) { const d = i - k * 7; if (d >= 1) rq.push(`(${i}, 'pkg${d}', NULL, 'depends', NULL)`); }
    rp.push(`('stable', ${i})`);
  }
  const chunk = async (rows: string[], head: string) => { for (let i = 0; i < rows.length; i += 400) await env.DB.prepare(`${head} ${rows.slice(i, i + 400).join(",")}`).run(); };
  await chunk(pk, "INSERT INTO packages (id, sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES");
  await chunk(pv, "INSERT INTO package_provides (package_id, capability, version_constraint, declared) VALUES");
  await chunk(rq, "INSERT INTO package_requires (package_id, requirement, version_constraint, kind, symbol_version) VALUES");
  await chunk(rp, "INSERT INTO ring_packages (ring, package_id) VALUES");
  await env.DB.prepare("INSERT INTO releases (ring, seq, note, package_count, bytes) VALUES ('stable', 1, 'seed', ?, ?)").bind(n, n * 100).run();
  await env.DB.prepare("INSERT INTO ring_heads (ring, release_id) VALUES ('stable', (SELECT id FROM releases WHERE ring = 'stable'))").run();
}

// The closure by the plain definition, one edge at a time, as the oracle.
async function closureByHand(targets: string[]): Promise<Set<string>> {
  const idOf = new Map<string, number>(), nameOf = new Map<number, string>();
  for (const r of (await env.DB.prepare("SELECT id, name FROM packages").all<{ id: number; name: string }>()).results) { idOf.set(r.name, r.id); nameOf.set(r.id, r.name); }
  const edges = new Map<number, string[]>();
  for (const r of (await env.DB.prepare("SELECT package_id, requirement FROM package_requires WHERE kind = 'depends'").all<{ package_id: number; requirement: string }>()).results) edges.set(r.package_id, [...(edges.get(r.package_id) ?? []), r.requirement]);
  const out = new Set<string>(), queue = targets.filter((t) => idOf.has(t));
  while (queue.length) { const t = queue.pop()!; if (out.has(t)) continue; out.add(t); for (const d of edges.get(idOf.get(t)!) ?? []) if (idOf.has(d)) queue.push(d); }
  return out;
}

describe("the dependency closure", () => {
  it("reads the ring once and the edges it follows — not every provider per edge", async () => {
    const n = 1200;
    await seedRing(n);
    const targets = Array.from({ length: 40 }, (_, i) => `pkg${n - 5 - i * 20}`);
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request(`http://pool.test/api/v1/graph?ring=stable&arch=x86_64&targets=${targets.join(",")}`), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packages: { name: string }[]; missing_targets: string[]; truncated: boolean };
    expect(body.missing_targets).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(new Set(body.packages.map((p) => p.name))).toEqual(await closureByHand(targets));

    // The same query, measured: with the plan left to the planner it read
    // the ring's providers for every edge (a million rows here, 20–45 M on
    // a real ring); pinned, it is the ring once plus the edges.
    const { closureRows } = await import("../src/routes/graph");
    const rows = await closureRows(env, "stable", "x86_64", targets, 2001);
    expect(rows.meta.rows_read).toBeLessThan(6 * n + 20 * body.packages.length);
  });
});

describe("a page of a release's manifests", () => {
  it("walks the index from the cursor, not the whole ring per page", async () => {
    // The ring is one version of each name; the pool also holds a superseded
    // version of each (retention keeps them a while), which the walk must step over.
    const n = 1200, rows: string[] = [];
    for (let i = 1; i <= n; i++) rows.push(`(${n + i}, 'old${i}', 'pkg${i}', '0-1', 'x86_64', 'pkg${i}-0-1-x86_64.pkg.tar.zst', 90, 90, 1, '{"name":"pkg${i}","version":"0-1"}', 'extra', 'extra/x86_64/old${i}', 'x86_64')`);
    for (let i = 0; i < rows.length; i += 400) await env.DB.prepare(`INSERT INTO packages (id, sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES ${rows.slice(i, i + 400).join(",")}`).run();
    const { releaseManifests } = await import("../src/db");
    const release = (await env.DB.prepare("SELECT id FROM releases WHERE ring = 'stable'").first<{ id: number }>())!.id;
    const first = (await releaseManifests(env, release, "summary", { arch: "x86_64", limit: 500 })) as { name: string; version: string; source: string; repo_arch: string }[];
    expect(first.length).toBe(500);
    expect(first.every((r) => r.version === "1-1")).toBe(true);
    const last = first[first.length - 1];
    const second = (await releaseManifests(env, release, "summary", { arch: "x86_64", limit: 500, after: { name: last.name, repoArch: last.repo_arch, source: last.source } })) as { name: string }[];
    expect(second.length).toBe(500);
    expect(second[0].name > last.name).toBe(true);
    // Every name once across the pages, in index order.
    const third = (await releaseManifests(env, release, "summary", { arch: "x86_64", limit: 500, after: { name: second[499].name, repoArch: "x86_64", source: "extra" } })) as { name: string }[];
    expect(new Set([...first, ...second, ...third].map((r) => r.name)).size).toBe(n);
    // The cost of one page, measured: the index rows walked (a member and a
    // superseded twin per name) and a membership probe each — not the ring.
    const { releaseMemberPredicate } = await import("../src/db");
    const q = await env.DB.prepare(
      `SELECT p.name FROM packages p INDEXED BY idx_packages_name_repo_arch_source WHERE (?1 IS NULL OR p.repo_arch = ?1) AND (p.name, p.repo_arch, p.source) > (?2, ?3, ?4) AND ${await releaseMemberPredicate(env, release, "p")} ORDER BY p.name, p.repo_arch, p.source LIMIT 500`,
    ).bind("x86_64", last.name, last.repo_arch, last.source).all();
    expect(q.results.length).toBe(500);
    expect(q.meta.rows_read).toBeLessThan(500 * 6);
  });
});
