/**
 * Retention's reads (routes/gc.ts, db.ts, the metrics snapshot's
 * reclaimable count): the list of what is outside retention walks the
 * membership tables' primary keys instead of materialising them per call,
 * the shared-object check per victim goes through the filename index
 * instead of the packages table, the reclaimable tile counts by the rule
 * GC deletes by — and every list is the one the plain forms produced,
 * measured on the same seed.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { issueJobToken } from "../src/jobtoken";
import { RINGS, ringsSql } from "../src/meta";
import { outsideRetention, retention, KEEP_RELEASES, GRACE_DAYS } from "../src/db";
import { snapshotMetrics } from "../src/metrics";
import { packageKey } from "../src/r2";

const API = "http://pool.test/api/v1";

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

const job = (scopes: string[]) => issueJobToken(env, { t: 1, k: "test", s: scopes, e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });

const N = 1200;
const SERVED = 1100;
const OLD = "2026-01-01T00:00:00.000Z";
const file = (i: number) => `pkg${i}-1-1-x86_64.pkg.tar.zst`;
const key = (i: number) => packageKey("extra", "x86_64", file(i));

/**
 * A pool shaped like the real one, the size the plans differ at: N
 * packages past the grace, the first SERVED of them (93 %, as on
 * production) served by every ring; per ring five releases — checkpoints
 * at seq 1 (kept by nothing once keep=3 protects 3–5), seq 2 (the kept
 * base) and seq 4 (kept, protected), each listing the served set; deltas:
 * seq 3 adds one object beyond the served set and seq 4 removes it again
 * (a rollback inside retention may want it back); seq 5 is the head and
 * changed nothing. One package is younger than the grace.
 */
async function seed() {
  const pk: string[] = [], rp: string[] = [];
  for (let i = 1; i <= N; i++) {
    pk.push(`(${i}, 'sha${i}', 'pkg${i}', '1-1', 'x86_64', '${file(i)}', 100, 100, 1, '{}', 'extra', '${key(i)}', 'x86_64', '${OLD}')`);
    if (i <= SERVED) for (const ring of RINGS) rp.push(`('${ring}', ${i})`);
  }
  const chunk = async (rows: string[], head: string) => { for (let i = 0; i < rows.length; i += 400) await env.DB.prepare(`${head} ${rows.slice(i, i + 400).join(",")}`).run(); };
  await chunk(pk, "INSERT INTO packages (id, sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch, created_at) VALUES");
  await chunk(rp, "INSERT INTO ring_packages (ring, package_id) VALUES");
  let r = 0;
  for (const ring of RINGS) {
    r++;
    const ids: number[] = [];
    let parent: number | null = null;
    for (let seq = 1; seq <= 5; seq++) {
      const id = (await env.DB.prepare("INSERT INTO releases (ring, seq, parent_id, note, package_count, bytes, checkpoint) VALUES (?, ?, ?, 'seed', ?, ?, ?) RETURNING id")
        .bind(ring, seq, parent, SERVED, SERVED * 100, seq === 3 || seq === 5 ? 0 : 1).first<{ id: number }>())!.id;
      ids.push(id);
      parent = id;
      if (seq !== 3 && seq !== 5) await chunk(Array.from({ length: SERVED }, (_, i) => `(${id}, ${i + 1})`), "INSERT INTO release_packages (release_id, package_id) VALUES");
      if (seq === 3) await env.DB.prepare("INSERT INTO release_deltas (release_id, package_id, op) VALUES (?, ?, 'add')").bind(id, SERVED + r).run();
      if (seq === 4) await env.DB.prepare("INSERT INTO release_deltas (release_id, package_id, op) VALUES (?, ?, 'remove')").bind(id, SERVED + r).run();
    }
    await env.DB.prepare("INSERT INTO ring_heads (ring, release_id) VALUES (?, ?)").bind(ring, ids[4]).run();
  }
  await env.DB.prepare("UPDATE packages SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(N).run();
}

/** The list as gc.ts wrote it until 2026-09-20: `NOT IN` over the membership tables, the oracle here. */
const oldList = (p: number[], k: number[]) =>
  env.DB.prepare(
    `SELECT id FROM packages
      WHERE id NOT IN (SELECT package_id FROM ring_packages)
        AND id NOT IN (SELECT package_id FROM release_deltas WHERE release_id IN (SELECT value FROM json_each(?1)))
        AND id NOT IN (SELECT package_id FROM release_packages WHERE release_id IN (SELECT value FROM json_each(?2)))
        AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?3)
      ORDER BY id`,
  ).bind(JSON.stringify(p), JSON.stringify(k), `-${GRACE_DAYS} days`).all<{ id: number }>();

/** The reclaimable count as metrics.ts wrote it: nothing any checkpoint lists, kept or not. */
const oldReclaimable = () =>
  env.DB.prepare(
    `SELECT COUNT(*) AS objects, COALESCE(SUM(size_download), 0) AS bytes FROM packages
      WHERE id NOT IN (SELECT package_id FROM ring_packages)
        AND id NOT IN (SELECT package_id FROM release_deltas WHERE release_id IN (SELECT id FROM releases r WHERE r.id IN (
                          SELECT id FROM releases r2 WHERE r2.ring = r.ring ORDER BY seq DESC LIMIT 3)))
        AND id NOT IN (SELECT package_id FROM release_packages)
        AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`,
  ).first<{ objects: number; bytes: number }>();

const newList = (p: number[], k: number[]) =>
  env.DB.prepare(`SELECT id FROM packages p WHERE p.created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?3) AND ${outsideRetention("p")} ORDER BY p.id`)
    .bind(JSON.stringify(p), JSON.stringify(k), `-${GRACE_DAYS} days`).all<{ id: number }>();

let gc: string;

beforeAll(async () => {
  await seed();
  gc = await job(["gc"]);
});

describe("what is outside retention", () => {
  it("is the same list, read through the membership tables' primary keys instead of every row of them", async () => {
    const { protectedReleases, keptCheckpoints } = await retention(env, KEEP_RELEASES);
    // keep=3 protects seq 3–5 of every ring; kept: the checkpoint at seq 4 and the base at seq 2, not the one at seq 1.
    expect(protectedReleases.length).toBe(3 * RINGS.length);
    expect(keptCheckpoints.length).toBe(2 * RINGS.length);
    const before = await oldList(protectedReleases, keptCheckpoints);
    const after = await newList(protectedReleases, keptCheckpoints);
    expect(after.results).toEqual(before.results);
    // What the seed says it should be: beyond the served set, minus the four
    // objects a protected delta names, minus the young one.
    const expected = Array.from({ length: N - SERVED - 1 }, (_, i) => SERVED + 1 + i).filter((id) => id > SERVED + RINGS.length).map((id) => ({ id }));
    expect(after.results).toEqual(expected);
    // Measured: the old form materialised every ring row and every kept
    // checkpoint's rows per call (302 k on production, 2026-09-20, for
    // 34,808 packages); the new one is the packages table once, one index
    // row per served package (edge serves it: the chain stops there) and
    // the probes of the few outside every ring (66 k on production).
    expect(before.meta.rows_read).toBeGreaterThan(N + RINGS.length * SERVED * 2);
    expect(after.meta.rows_read).toBeLessThan(2 * N + (N - SERVED) * 40);
    // The route says the same.
    const un = await call("GET", `/pool/unreferenced?keep=${KEEP_RELEASES}`);
    expect(un.status).toBe(200);
    expect(un.json.packages.map((p: any) => ({ id: p.id }))).toEqual(expected);
    expect(un.json.kept_checkpoints).toEqual(keptCheckpoints);
  });

  it("is what the metrics snapshot counts as reclaimable — GC's own rule, without every checkpoint's rows", async () => {
    // The old count excluded what any checkpoint listed, kept or not, so
    // between two GCs it undercounted by what the checkpoints outside
    // retention still listed and read every row of release_packages for it.
    // Once GC has pruned those rows (`limit=0`: the prune, no deletion) the
    // two agree; the new count says the same before the prune as after.
    const { protectedReleases, keptCheckpoints } = await retention(env, KEEP_RELEASES);
    const rule = await newList(protectedReleases, keptCheckpoints);
    const pruned = await call("POST", "/pool/gc?limit=0", undefined, gc);
    expect(pruned.status).toBe(200);
    expect(pruned.json).toMatchObject({ deleted: 0, membership_rows_pruned: RINGS.length * SERVED, remaining: rule.results.length });
    const before = await oldReclaimable();
    expect(before).toEqual({ objects: rule.results.length, bytes: rule.results.length * 100 });
    await snapshotMetrics(env, new Date());
    const snap = JSON.parse((await env.DB.prepare("SELECT payload FROM events WHERE kind = 'metrics' ORDER BY id DESC LIMIT 1").first<{ payload: string }>())!.payload);
    expect(snap.pool.reclaimable_objects).toBe(before!.objects);
    expect(snap.pool.reclaimable_bytes).toBe(before!.bytes);
  });

  it("deletes the row, and the object only when no other row names it — found through the filename index, not a scan", async () => {
    // Two rows behind one key: a served package and an older rebuild of the
    // same file (different bytes, same filename in the same directory) that
    // retention has let go of. And a victim nobody shares an object with.
    const twin = N + 1, alone = SERVED + RINGS.length + 1;
    await env.DB.prepare(
      `INSERT INTO packages (id, sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch, created_at)
       VALUES (?, 'rebuilt', 'pkg1', '1-1', 'x86_64', ?, 100, 100, 1, '{}', 'extra', ?, 'x86_64', ?)`,
    ).bind(twin, file(1), key(1), OLD).run();
    await env.PACKAGES.put(key(1), new TextEncoder().encode("the served bytes"));
    await env.PACKAGES.put(key(alone), new TextEncoder().encode("nobody else's"));
    await env.PACKAGES.put(`${key(alone)}.sig`, new TextEncoder().encode("its signature"));
    // The check as the loop runs it, measured: the filename index, then the key.
    const shared = await env.DB.prepare("SELECT COUNT(*) AS n FROM packages WHERE filename = ?1 AND id != ?2 AND COALESCE(r2_key, repo_arch || '/' || filename) = ?3")
      .bind(file(1), twin, key(1)).first<{ n: number }>();
    expect(shared!.n).toBe(1);
    const q = await env.DB.prepare("SELECT COUNT(*) AS n FROM packages WHERE filename = ?1 AND id != ?2 AND COALESCE(r2_key, repo_arch || '/' || filename) = ?3").bind(file(1), twin, key(1)).all();
    expect(q.meta.rows_read).toBeLessThan(5);

    const run = await call("POST", "/pool/gc?limit=500", undefined, gc);
    expect(run.status).toBe(200);
    expect(run.json.objects_kept_for_another_row).toBe(1);
    expect(run.json.remaining).toBe(0);
    // The rebuild's row is gone, the served row and its object stay.
    expect(await env.DB.prepare("SELECT id FROM packages WHERE id = ?").bind(twin).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM packages WHERE id = 1").first()).toEqual({ id: 1 });
    expect(await env.PACKAGES.head(key(1))).not.toBeNull();
    // The lone victim went with its object and what sat beside it.
    expect(await env.DB.prepare("SELECT id FROM packages WHERE id = ?").bind(alone).first()).toBeNull();
    expect(await env.PACKAGES.head(key(alone))).toBeNull();
    expect(await env.PACKAGES.head(`${key(alone)}.sig`)).toBeNull();
    // Nothing served, nothing a protected delta names and nothing young went.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM packages").first<{ n: number }>())!.n).toBe(SERVED + RINGS.length + 1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ring_packages r WHERE r.ring IN (${ringsSql(RINGS)}) AND NOT EXISTS (SELECT 1 FROM packages p WHERE p.id = r.package_id)`).first<{ n: number }>())!.n).toBe(0);
  });

  it("relies on every key ending with the filename, which every writer of r2_key keeps", async () => {
    // The index route (routes/packages.ts) is the writer of a new row's
    // key; relayout.test.ts holds the relayout's three forms to the same
    // shape. The seed and the fixture rows are held to it here.
    const pool = await job(["pool:write"]);
    const filename = "new-2.0-1-x86_64.pkg.tar.zst";
    await env.PACKAGES.put(packageKey("core", "x86_64", filename), new TextEncoder().encode("new"));
    const r = await call("POST", "/packages?source=core&arch=x86_64", {
      schema_version: 1, name: "new", version: "2.0-1", arch: "x86_64", sha256: "c".repeat(64), filename,
      size_download: 3, size_installed: 9, description: "new", provides: ["new"], requires: [], pkginfo: { provides: [] }, files: [], components: [],
    }, pool);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const off = await env.DB.prepare("SELECT COUNT(*) AS n FROM packages WHERE substr(COALESCE(r2_key, repo_arch || '/' || filename), -length(filename) - 1) != '/' || filename").first<{ n: number }>();
    expect(off!.n).toBe(0);
  });
});
