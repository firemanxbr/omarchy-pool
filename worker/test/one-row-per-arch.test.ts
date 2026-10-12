/**
 * The same bytes indexed once per repository architecture (#421, migration
 * 0055). Omarchy publishes some `-any` archives byte for byte in its x86_64
 * and its aarch64 repository; the index held one row per sha256, so the
 * architecture whose sync came second got a 409 and left the package out
 * of its rings — eight Omarchy packages on x86_64, every sync, from at
 * least 2026-10-12. Now each architecture's sync indexes the bytes for its
 * own repository: a row, an object, lists and ring membership of its own.
 * What reads by sha256 — a release's adds, the security matches and
 * components, the seal, GC — reads every row of the bytes or the one of
 * the architecture it is about, through idx_packages_sha256_repo_arch.
 * Through the Worker's own fetch, with job tokens minted as a claim mints them.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { issueJobToken } from "../src/jobtoken";
import { packageKey } from "../src/r2";
import { INDEXED_SQL, KNOWN_SQL, MANIFEST_SQL } from "../src/routes/packages";
import { ADD_ROWS_OF_ARCH_SQL, ADD_ROWS_SQL } from "../src/routes/releases";
import { ROWS_OF_SHAS_SQL } from "../src/routes/security";
import { SEALED_FIRST_SQL, SEALED_ROW_SQL } from "../src/routes/seal";

const API = "http://pool.test/api/v1";

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

const job = (scopes: string[]) => issueJobToken(env, { t: 1, k: "test", s: scopes, e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });

const sha = (s: string) => Array.from({ length: 64 }, (_, i) => s.charCodeAt(i % s.length).toString(16).slice(-1)).join("");

/** An `-any` archive Omarchy ships in both repositories: one name, one file name, the same bytes. */
interface Any { name: string; filename: string; bytes: Uint8Array; sha256: string }
const anyPackage = (name: string): Any => {
  const filename = `${name}-1.0-1-any.pkg.tar.zst`;
  return { name, filename, bytes: new TextEncoder().encode(`${name}, byte for byte in both repositories`), sha256: sha(`${name}-any`) };
};

/** One architecture's sync of the archive, as `pkg-repo sync` does it: the object under that architecture's directory, then its manifest indexed for it. */
async function syncIndex(p: Any, arch: string, token: string): Promise<{ status: number; json: any }> {
  await env.PACKAGES.put(packageKey("packages", arch, p.filename), p.bytes);
  return call("POST", `/packages?source=packages&arch=${arch}`, {
    schema_version: 1, name: p.name, version: "1.0-1", arch: "any", sha256: p.sha256, filename: p.filename,
    size_download: p.bytes.length, size_installed: 1, description: `${p.name} for tests`,
    provides: [p.name], requires: [], pkginfo: { provides: [] }, files: [`usr/share/${p.name}/data`],
    components: [{ ecosystem: "Go", name: `example.org/${p.name}`, version: "v1.0.0" }],
  }, token);
}

/** The sync's release of one architecture: what it pins, that architecture only (`remove_arch`). */
async function syncRelease(ring: string, arch: string, add: string[], token: string): Promise<number> {
  const r = await call("POST", "/releases", { ring, add, remove_arch: arch, note: `sync packages ${arch}` }, token);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.release.id;
}

/** What a ring serves for one architecture, as a render and `omarchy-cli` read it. */
async function served(ring: string, arch: string): Promise<{ name: string; sha256: string; repo_arch: string }[]> {
  const r = await call("GET", `/releases/${ring}?fields=summary&arch=${arch}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.packages.map((p: any) => ({ name: p.name, sha256: p.sha256, repo_arch: p.repo_arch }));
}

const rowsOf = async (sha256: string) =>
  (await env.DB.prepare("SELECT id, repo_arch, r2_key FROM packages WHERE sha256 = ? ORDER BY id").bind(sha256).all<{ id: number; repo_arch: string; r2_key: string }>()).results;

let pool: string, edge: string, rc: string, gc: string, security: string;

beforeAll(async () => {
  pool = await job(["pool:write"]);
  edge = await job(["release:edge", "artifacts:*:edge"]);
  rc = await job(["release:rc"]);
  gc = await job(["gc"]);
  security = await job(["security:write"]);
});

describe("migration 0055 over the rows already there", () => {
  it("keeps every id, sha256 and list; the other architecture's row of the same bytes is accepted, a second row of the same architecture refused", async () => {
    const tableOf = async () => (await env.DB.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'packages' ORDER BY type, name").all()).results;
    const after0055 = await tableOf();
    // The table as production has it before the migration: sha256 the UNIQUE column.
    await env.DB.batch(["DROP INDEX idx_packages_sha256_repo_arch", "ALTER TABLE packages DROP COLUMN sha256", "ALTER TABLE packages RENAME COLUMN row_key TO sha256"].map((q) => env.DB.prepare(q)));
    const omazed = anyPackage("omazed-legacy");
    await env.PACKAGES.put(packageKey("packages", "aarch64", omazed.filename), omazed.bytes);
    const legacy = (await env.DB.prepare(
      `INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch)
       VALUES (?, ?, '1.0-1', 'any', ?, ?, 1, 1, ?, 'packages', ?, 'aarch64') RETURNING id`,
    ).bind(omazed.sha256, omazed.name, omazed.filename, omazed.bytes.length, JSON.stringify({ name: omazed.name, sha256: omazed.sha256 }), packageKey("packages", "aarch64", omazed.filename)).first<{ id: number }>())!.id;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO package_provides (package_id, capability, declared) VALUES (?, ?, 1)").bind(legacy, omazed.name),
      env.DB.prepare("INSERT INTO package_file_lists (package_id, count, gz) VALUES (?, 1, x'00')").bind(legacy),
      env.DB.prepare("INSERT INTO ring_packages (ring, package_id) VALUES ('edge', ?)").bind(legacy),
    ]);
    // The limit #421 is about: the same bytes for x86_64 were a second row of one sha256.
    await expect(env.DB.prepare("INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, manifest_json, repo_arch) VALUES (?, 'x', '1', 'any', 'f', 1, 1, '{}', 'x86_64')").bind(omazed.sha256).run()).rejects.toThrow(/UNIQUE/);

    // The migration's own statements, as D1 applies them.
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0055_"))!;
    expect(m, "migration 0055 is in the list").toBeTruthy();
    await env.DB.batch(m.queries.map((q) => env.DB.prepare(q)));
    expect(await tableOf()).toEqual(after0055);

    // Nothing of the row moved: its id, its sha256 (now read from the bare key), its lists, its ring.
    expect(await env.DB.prepare("SELECT id, row_key, sha256, repo_arch FROM packages WHERE id = ?").bind(legacy).first()).toEqual({ id: legacy, row_key: omazed.sha256, sha256: omazed.sha256, repo_arch: "aarch64" });
    for (const t of ["package_provides", "package_file_lists"]) expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE package_id = ?`).bind(legacy).first<{ n: number }>())!.n).toBe(1);
    // aarch64's sync finds its row; x86_64's indexes its own beside it.
    expect((await syncIndex(omazed, "aarch64", pool)).json).toMatchObject({ id: legacy, status: "already-indexed" });
    const x86 = await syncIndex(omazed, "x86_64", pool);
    expect(x86.status, JSON.stringify(x86.json)).toBe(201);
    expect(await rowsOf(omazed.sha256)).toEqual([
      { id: legacy, repo_arch: "aarch64", r2_key: packageKey("packages", "aarch64", omazed.filename) },
      { id: x86.json.id, repo_arch: "x86_64", r2_key: packageKey("packages", "x86_64", omazed.filename) },
    ]);
    // The constraint is (sha256, repo_arch): a second aarch64 row of these bytes is refused, whatever its key's form.
    await expect(env.DB.prepare("INSERT INTO packages (row_key, name, version, arch, filename, size_download, size_installed, manifest_json, repo_arch) VALUES (?, 'x', '1', 'any', 'f', 1, 1, '{}', 'aarch64')").bind(`${omazed.sha256}/aarch64`).run()).rejects.toThrow(/UNIQUE/);
    // Nothing writes the generated column.
    await expect(env.DB.prepare("INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, manifest_json) VALUES ('s', 'x', '1', 'any', 'f', 1, 1, '{}')").run()).rejects.toThrow(/generated column/);
  });
});

describe("an -any archive Omarchy ships byte for byte to both architectures", () => {
  const omazed = anyPackage("omazed");

  it("is indexed by both architectures' syncs, and both of edge's architectures serve it", async () => {
    // aarch64's sync first, as on 2026-10-12; then x86_64's — a 409 until #421.
    for (const arch of ["aarch64", "x86_64"]) {
      expect((await call("POST", "/packages/known", { sha256: [omazed.sha256], arch })).json.known).toEqual([]);
      const r = await syncIndex(omazed, arch, pool);
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      expect((await call("POST", "/packages/known", { sha256: [omazed.sha256], arch })).json.known).toEqual([omazed.sha256]);
      await syncRelease("edge", arch, [omazed.sha256], edge);
    }
    for (const arch of ["x86_64", "aarch64"]) expect((await served("edge", arch)).filter((p) => p.name === "omazed")).toEqual([{ name: "omazed", sha256: omazed.sha256, repo_arch: arch }]);
    // Two rows, two objects, one per architecture's directory; both in edge.
    const rows = await rowsOf(omazed.sha256);
    expect(rows.map((r) => [r.repo_arch, r.r2_key])).toEqual([["aarch64", packageKey("packages", "aarch64", omazed.filename)], ["x86_64", packageKey("packages", "x86_64", omazed.filename)]]);
    const inEdge = await env.DB.prepare("SELECT package_id FROM ring_packages WHERE ring = 'edge' AND package_id IN (?, ?) ORDER BY package_id").bind(rows[0].id, rows[1].id).all<{ package_id: number }>();
    expect(inEdge.results.map((r) => r.package_id)).toEqual(rows.map((r) => r.id));
    // The next sync of either finds its own row: nothing to import, no 409.
    for (const arch of ["aarch64", "x86_64"]) expect((await syncIndex(omazed, arch, pool)).json.status).toBe("already-indexed");
  });

  it("an add without an architecture pins every architecture's row of the bytes; `<sha256>/<arch>` pins that one", async () => {
    const one = await call("POST", "/releases", { ring: "rc", add: [`${omazed.sha256}/x86_64`], note: "fast-track omazed for x86_64" }, rc);
    expect(one.status, JSON.stringify(one.json)).toBe(201);
    expect((await served("rc", "x86_64")).map((p) => p.name)).toEqual(["omazed"]);
    expect(await served("rc", "aarch64")).toEqual([]);
    const both = await call("POST", "/releases", { ring: "rc", add: [omazed.sha256], note: "omazed, both" }, rc);
    expect(both.status, JSON.stringify(both.json)).toBe(201);
    expect((await served("rc", "aarch64")).map((p) => p.name)).toEqual(["omazed"]);
    // Within remove_arch, the plain sha256 is that architecture's row; an architecture the bytes are not indexed for is not indexed.
    const scoped = await call("POST", "/releases", { ring: "rc", add: [omazed.sha256], remove_arch: "aarch64", note: "aarch64 only" }, rc);
    expect(scoped.status).toBe(201);
    expect(scoped.json.unchanged_arches).toEqual(["x86_64"]);
    const missing = await call("POST", "/releases", { ring: "rc", add: [`${omazed.sha256}/riscv64`] }, rc);
    expect(missing.status).toBe(404);
    expect(missing.json.error).toContain(`${omazed.sha256}/riscv64`);
  });

  it("an advisory's match is the bytes': both rows carry it, and the components list names the object once", async () => {
    const advisory = "osv:GO-2099-1:omazed";
    expect((await call("PUT", "/security/advisories", { advisories: [{ id: advisory, source: "osv", package: "omazed", cves: [], severity: "high", status: "vulnerable", affected: "v1.0.0", fixed: null, summary: null, url: "https://osv.dev/GO-2099-1" }], updated_at: "2026-10-12T00:00:00Z" }, security)).status).toBe(200);
    const put = await call("PUT", "/security/matches", { matches: [{ sha256: omazed.sha256, advisory, match: "exact", status: "vulnerable" }], updated_at: "2026-10-12T00:00:00Z" }, security);
    expect(put.json).toMatchObject({ matches: 2, unknown_sha256: 0 });
    const held = await env.DB.prepare("SELECT p.repo_arch FROM package_advisories pa JOIN packages p ON p.id = pa.package_id WHERE pa.advisory_id = ? ORDER BY 1").bind(advisory).all<{ repo_arch: string }>();
    expect(held.results.map((r) => r.repo_arch)).toEqual(["aarch64", "x86_64"]);
    const components = (await call("GET", "/security/components")).json.components;
    expect(components.find((c: any) => c.name === "example.org/omazed").sha256s).toEqual([omazed.sha256]);
  });

  it("the seal of each architecture's object is that architecture's", async () => {
    for (const arch of ["x86_64", "aarch64"]) {
      const seal = (await call("GET", `/packages/${omazed.sha256}/provenance?arch=${arch}`)).json;
      expect(seal).toMatchObject({ sha256: omazed.sha256, repo_arch: arch, origin: "opr" });
      expect(seal.object.endsWith(`/${packageKey("packages", arch, omazed.filename)}`)).toBe(true);
    }
    // Without one, the first in the index's order: aarch64's.
    expect((await call("GET", `/packages/${omazed.sha256}/provenance`)).json.repo_arch).toBe("aarch64");
    expect((await call("GET", `/packages/${omazed.sha256}/provenance?arch=riscv64`)).status).toBe(400);
    // The manifest is the bytes': the same whichever row answers.
    expect((await call("GET", `/packages/${omazed.sha256}`)).json).toMatchObject({ name: "omazed", sha256: omazed.sha256 });
  });
});

describe("GC and the same bytes in both architectures", () => {
  it("takes the row no ring serves with its object, and keeps the other architecture's row, object and lists", async () => {
    const ghost = anyPackage("ghost");
    for (const arch of ["aarch64", "x86_64"]) expect((await syncIndex(ghost, arch, pool)).status).toBe(201);
    // aarch64's ring serves it; x86_64's row was never pinned, and is past the grace.
    await syncRelease("edge", "aarch64", [ghost.sha256], edge);
    const [arm, x86] = await rowsOf(ghost.sha256);
    expect([arm.repo_arch, x86.repo_arch]).toEqual(["aarch64", "x86_64"]);
    await env.DB.prepare("UPDATE packages SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").bind(x86.id).run();
    await env.PACKAGES.put(`${x86.r2_key}.sig`, new Uint8Array(1));
    await env.PACKAGES.put(`${arm.r2_key}.sig`, new Uint8Array(1));

    const listed = (await call("GET", "/pool/unreferenced?keep=3")).json.packages.map((p: any) => p.id);
    expect(listed).toContain(x86.id);
    expect(listed).not.toContain(arm.id);
    const run = await call("POST", "/pool/gc?limit=500", undefined, gc);
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(run.json.deleted).toBe(1);
    expect(run.json.objects_kept_for_another_row).toBe(0);

    // x86_64's row, its lists and its object (with its signature) are gone.
    expect(await rowsOf(ghost.sha256)).toEqual([arm]);
    expect(await env.PACKAGES.head(x86.r2_key)).toBeNull();
    expect(await env.PACKAGES.head(`${x86.r2_key}.sig`)).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM package_provides WHERE package_id = ?").bind(x86.id).first<{ n: number }>())!.n).toBe(0);
    // aarch64's — the same bytes — stay whole: its object, its signature, its lists, its ring.
    expect(await env.PACKAGES.head(arm.r2_key)).not.toBeNull();
    expect(await env.PACKAGES.head(`${arm.r2_key}.sig`)).not.toBeNull();
    for (const t of ["package_provides", "package_file_lists", "package_components"]) expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE package_id = ?`).bind(arm.id).first<{ n: number }>())!.n, t).toBeGreaterThan(0);
    expect((await served("edge", "aarch64")).filter((p) => p.name === "ghost")).toEqual([{ name: "ghost", sha256: ghost.sha256, repo_arch: "aarch64" }]);
    // And x86_64's next sync indexes its own again.
    expect((await syncIndex(ghost, "x86_64", pool)).status).toBe(201);
  });
});

describe("every lookup by sha256", () => {
  it("reads idx_packages_sha256_repo_arch, never the table", async () => {
    const s = sha("omazed-any");
    const shas = JSON.stringify([s]);
    const plans: [string, string, unknown[]][] = [
      ["the index's own row", INDEXED_SQL, [s, "x86_64"]],
      ["what a sync already has", KNOWN_SQL, ["x86_64", shas]],
      ["a release's adds", ADD_ROWS_SQL, [shas]],
      ["a release's adds, one architecture", ADD_ROWS_OF_ARCH_SQL, [shas, "aarch64"]],
      ["the security matches' rows", ROWS_OF_SHAS_SQL, [shas]],
      ["the seal's row", SEALED_ROW_SQL, [s, "x86_64"]],
      ["the seal's row, no architecture asked", SEALED_FIRST_SQL, [s]],
      ["the manifest", MANIFEST_SQL, [s]],
    ];
    for (const [what, sql, args] of plans) {
      const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
      expect(plan, what).toMatch(/SEARCH packages USING (COVERING )?INDEX idx_packages_sha256_repo_arch \(sha256=\?/);
      expect(plan, what).not.toMatch(/SCAN packages|TEMP B-TREE/);
    }
    // One row each: the whole key, or the first of the range in the index's order — never a sort of it.
    for (const [what, sql, args] of [["the index's own row", INDEXED_SQL, [s, "x86_64"]], ["the seal's row", SEALED_ROW_SQL, [s, "x86_64"]], ["the first row", SEALED_FIRST_SQL, [s]], ["the manifest", MANIFEST_SQL, [s]]] as [string, string, unknown[]][]) {
      expect((await env.DB.prepare(sql).bind(...args).all()).meta.rows_read, what).toBe(1);
    }
  });
});
