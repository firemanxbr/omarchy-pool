/**
 * A ring never stops serving an architecture's databases (#319, routes/releases.ts
 * handleCreateRelease, handlePutArtifact, handleRendered, migration 0053): a release carries the
 * last databases rendered for every architecture until its own render replaces them, so a job that
 * dies between its release and its render — every x86_64 sync on the Studio canary from 2026-10-09
 * to 12, edge#648 to #654 serving no x86_64 database — leaves the ring serving them, never none.
 * Through the Worker's own fetch, with job tokens minted as a claim mints them.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { issueJobToken } from "../src/jobtoken";
import { packageKey } from "../src/r2";
import { AWAITED_SQL, OWN_WAIT_SQL, RENDERED_SQL, WAITED_SQL } from "../src/routes/releases";
import { CARRIED_ARCHES_SQL, RENDERED_BEFORE_SQL } from "../src/db";

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

function job(scopes: string[]): Promise<string> {
  return issueJobToken(env, { t: 1, k: "test", s: scopes, e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
}

const sha = (s: string) => Array.from({ length: 64 }, (_, i) => s.charCodeAt(i % s.length).toString(16).slice(-1)).join("");

async function index(source: string, arch: string, name: string, version: string, token: string): Promise<string> {
  const filename = `${name}-${version}-${arch}.pkg.tar.zst`;
  const bytes = new TextEncoder().encode(filename);
  await env.PACKAGES.put(packageKey(source, arch, filename), bytes);
  const s = sha(`${source}/${arch}/${filename}`);
  const r = await call("POST", `/packages?source=${source}&arch=${arch}`, {
    schema_version: 1, name, version, arch, sha256: s, filename, size_download: bytes.length, size_installed: 1,
    provides: [name], requires: [], pkginfo: {}, files: [`usr/bin/${name}`],
  }, token);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return s;
}

let pool: string;
let edge: string;
let render: string;
const shas: Record<string, string> = {};

/** A render's database put for a release, as `pkg-repo render` puts it. */
async function put(release: number, kind: string, repo: string, arch: string, bytes = 3): Promise<number> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${API}/releases/${release}/artifacts/${kind}?repo=${repo}&arch=${arch}`, { method: "PUT", headers: { authorization: `Bearer ${render}`, "content-type": "application/octet-stream" }, body: new Uint8Array(bytes) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res.status;
}

/** Every database of one architecture, as a render puts them: each source's db and files. */
async function renderArch(release: number, arch: string, sources: string[]): Promise<void> {
  for (const s of sources) for (const kind of ["db", "files"]) expect(await put(release, kind, `omarchy-${s}-edge`, arch)).toBe(201);
}

/** A whole render of one architecture, as `pkg-repo render` makes it: its databases, then the pool told (`rendered`). What it dropped. */
async function renderWhole(release: number, arch: string, sources: string[]): Promise<number> {
  await renderArch(release, arch, sources);
  const done = await call("POST", `/releases/${release}/rendered?arch=${arch}`, undefined, render);
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  return done.json.dropped;
}

let fresh = 0;
/** The sections of edge's include for `arch`, as a user's pacman reads them (a fresh URL: the include sits in the edge cache, and so do the stats). */
async function sections(arch: string): Promise<string[]> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test/api/v1/pacman.conf?ring=edge&arch=${arch}&t=${++fresh}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return [...(await res.text()).matchAll(/^\[([a-z0-9-]+)\]$/gm)].map((m) => m[1]);
}

type Row = { repo: string; arch: string; kind: string; awaits: number | null };
const rowsOf = async (id: number): Promise<Row[]> =>
  (await env.DB.prepare("SELECT repo, arch, kind, awaits FROM release_artifacts WHERE release_id = ? ORDER BY arch, repo, kind").bind(id).all<Row>()).results;

/** A sync's release of one architecture, as `pkg-repo work` makes it (`remove_arch`: the other is unchanged). */
async function sync(arch: string, body: Record<string, unknown> = {}): Promise<{ id: number; unchanged: string[] }> {
  const r = await call("POST", "/releases", { ring: "edge", remove_arch: arch, note: `sync ${arch}`, ...body }, edge);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { id: r.json.release.id, unchanged: r.json.unchanged_arches };
}

beforeAll(async () => {
  pool = await job(["pool:write"]);
  edge = await job(["release:edge", "artifacts:*:edge"]);
  render = await job(["artifacts:*:edge"]);
  shas.zlib = await index("core", "x86_64", "zlib", "1.3-1", pool);
  shas.curl = await index("extra", "x86_64", "curl", "8.10-1", pool);
  shas.zlibArm = await index("core", "aarch64", "zlib", "1.3-1", pool);
  // edge's first release, rendered for both architectures.
  const first = await call("POST", "/releases", { ring: "edge", add: [shas.zlib, shas.curl, shas.zlibArm] }, edge);
  expect(first.status).toBe(201);
  await renderArch(first.json.release.id, "x86_64", ["core", "extra"]);
  await renderArch(first.json.release.id, "aarch64", ["core"]);
});

describe("a ring's head and its databases", () => {
  it("a sync that dies between its release and its render leaves the ring serving the last databases rendered, until its render", async () => {
    expect(await sections("x86_64")).toEqual(["omarchy-core-edge", "omarchy-extra-edge"]);
    // Three attempts of one x86_64 sync, each making its release and dying before its render — edge#648 to #650 on 2026-10-12.
    // The last drops extra's only package: its render will have no extra database to put.
    const attempts = [await sync("x86_64"), await sync("x86_64"), await sync("x86_64", { remove_from: [{ source: "extra", name: "curl" }] })];
    for (const a of attempts) expect(a.unchanged).toEqual(["aarch64"]);
    const head = attempts[2].id;
    // Every head kept both architectures' databases: x86_64's awaiting its render, aarch64's rendered.
    expect(await sections("x86_64")).toEqual(["omarchy-core-edge", "omarchy-extra-edge"]);
    expect(await sections("aarch64")).toEqual(["omarchy-core-edge"]);
    expect(await rowsOf(head)).toEqual([
      { repo: "omarchy-core-edge", arch: "aarch64", kind: "db", awaits: null },
      { repo: "omarchy-core-edge", arch: "aarch64", kind: "files", awaits: null },
      { repo: "omarchy-core-edge", arch: "x86_64", kind: "db", awaits: head },
      { repo: "omarchy-core-edge", arch: "x86_64", kind: "files", awaits: head },
      { repo: "omarchy-extra-edge", arch: "x86_64", kind: "db", awaits: head },
      { repo: "omarchy-extra-edge", arch: "x86_64", kind: "files", awaits: head },
    ]);
    // What the dashboard and the health check read say which databases are the head's own: the stats list the carried
    // apart, so a health check from before the carry (a worker on the release before) finds no x86_64 database of the
    // head, as it did, instead of taking the parent's for the head's evidence.
    const stats = (await call("GET", `/stats?t=${++fresh}`)).json.rings.find((r: any) => r.ring === "edge");
    expect(stats.artifacts.filter((a: any) => a.arch === "x86_64")).toEqual([]);
    expect(stats.artifacts.filter((a: any) => a.arch === "aarch64").map((a: any) => [a.repo, a.kind, a.awaits])).toEqual([["omarchy-core-edge", "db", null], ["omarchy-core-edge", "files", null]]);
    expect(stats.carried.filter((a: any) => a.kind === "db").map((a: any) => [a.repo, a.arch, a.awaits])).toEqual([["omarchy-core-edge", "x86_64", head], ["omarchy-extra-edge", "x86_64", head]]);
    const listing = (await call("GET", "/releases/edge?fields=summary&arch=x86_64")).json;
    expect(listing.artifacts.filter((a: any) => a.arch === "x86_64").every((a: any) => a.awaits === head)).toBe(true);
    // The head's own render: core's databases put, then the pool told it is whole — extra's, a source the head
    // no longer has, go; the ring serves the head's own databases only.
    await renderArch(head, "x86_64", ["core"]);
    const done = await call("POST", `/releases/${head}/rendered?arch=x86_64`, undefined, render);
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ release_id: head, arch: "x86_64", dropped: 2 });
    expect((await rowsOf(head)).map((r) => [r.repo, r.arch, r.kind, r.awaits])).toEqual([
      ["omarchy-core-edge", "aarch64", "db", null],
      ["omarchy-core-edge", "aarch64", "files", null],
      ["omarchy-core-edge", "x86_64", "db", null],
      ["omarchy-core-edge", "x86_64", "files", null],
    ]);
    expect(await sections("x86_64")).toEqual(["omarchy-core-edge"]);
    // Said again, it drops nothing more.
    expect((await call("POST", `/releases/${head}/rendered?arch=x86_64`, undefined, render)).json.dropped).toBe(0);
  });

  it("a release made while its parent's render runs carries what the parent will serve, and the parent's render reaches it", async () => {
    // The x86_64 sync's release, its render still running when the aarch64 sync's release is made from it.
    const p = await sync("x86_64");
    const c = await sync("aarch64");
    expect(c.unchanged).toEqual(["x86_64"]);
    expect((await rowsOf(c.id)).map((r) => [r.arch, r.kind, r.awaits])).toEqual([
      ["aarch64", "db", c.id],
      ["aarch64", "files", c.id],
      ["x86_64", "db", p.id],
      ["x86_64", "files", p.id],
    ]);
    // The parent's render lands: the newer release, which kept the parent's x86_64, serves it as rendered.
    expect(await put(p.id, "db", "omarchy-core-edge", "x86_64", 7)).toBe(201);
    const db = await env.DB.prepare("SELECT size, awaits FROM release_artifacts WHERE release_id = ? AND arch = 'x86_64' AND kind = 'db'").bind(c.id).first();
    expect(db).toEqual({ size: 7, awaits: null });
    expect(await put(p.id, "files", "omarchy-core-edge", "x86_64")).toBe(201);
    expect((await rowsOf(c.id)).filter((r) => r.arch === "x86_64").every((r) => r.awaits === null)).toBe(true);
    // Its aarch64, which it changed, waits for its own render, not the parent's.
    expect((await rowsOf(c.id)).filter((r) => r.arch === "aarch64").every((r) => r.awaits === c.id)).toBe(true);
    await renderArch(c.id, "aarch64", ["core"]);
    expect((await call("POST", `/releases/${c.id}/rendered?arch=aarch64`, undefined, render)).json.dropped).toBe(0);
    expect((await rowsOf(c.id)).every((r) => r.awaits === null)).toBe(true);
  });

  it("a parent with no rows for an architecture (a head from before) gives way to the nearest ancestor that has them", async () => {
    // A head made before releases carried every architecture, whose render died: no x86_64 row at all (edge#654).
    const dead = await sync("x86_64");
    await env.DB.prepare("DELETE FROM release_artifacts WHERE release_id = ? AND arch = 'x86_64'").bind(dead.id).run();
    // The next x86_64 sync's release serves the last x86_64 databases rendered again, awaiting its own render…
    const next = await sync("x86_64");
    expect((await rowsOf(next.id)).filter((r) => r.arch === "x86_64").map((r) => r.awaits)).toEqual([next.id, next.id]);
    expect(await sections("x86_64")).toEqual(["omarchy-core-edge"]);
    // …and an aarch64 one, which kept the dead head's x86_64, awaits the parent's: never rendered (the next sync's
    // repair renders the head, pkg-repo work.rs repair_head).
    await env.DB.prepare("DELETE FROM release_artifacts WHERE release_id = ? AND arch = 'x86_64'").bind(next.id).run();
    const arm = await sync("aarch64");
    expect((await rowsOf(arm.id)).filter((r) => r.arch === "x86_64").map((r) => r.awaits)).toEqual([next.id, next.id]);
  });

  it("a head rendered for a dead release's selection settles the releases made from it while the render ran (the next sync's repair)", async () => {
    // edge rendered whole, then a source of x86_64 that the next x86_64 sync drops.
    const start = (await call("GET", "/releases/edge?fields=summary")).json.release.id;
    await renderWhole(start, "x86_64", ["core"]);
    await renderWhole(start, "aarch64", ["core"]);
    shas.tool = await index("packages", "x86_64", "tool", "1.0-1", pool);
    const added = await sync("x86_64", { add: [shas.tool] });
    await renderWhole(added.id, "x86_64", ["core", "packages"]);
    expect(await sections("x86_64")).toEqual(["omarchy-packages-edge", "omarchy-core-edge"]);
    // That sync makes its release and dies before its render (R1); the aarch64 sync of the tick keeps R1's x86_64 (R2, the head).
    const dead = await sync("x86_64", { remove_from: [{ source: "packages", name: "tool" }] });
    const kept = await sync("aarch64");
    const x86 = async (id: number) => (await rowsOf(id)).filter((r) => r.arch === "x86_64");
    expect((await x86(kept.id)).map((r) => r.awaits)).toEqual([dead.id, dead.id, dead.id, dead.id]);
    // The next tick's x86_64 sync makes no release and renders the head (work.rs repair_head), pinned to R2 at its first
    // page; while it reads R2's pages, that tick's aarch64 sync makes R3 from R2, which copies R2's wait for R1 — a render
    // that will never run. The same race as a normal sync's whose head moves before its render's first page.
    const during = await sync("aarch64");
    expect((await x86(during.id)).map((r) => r.awaits)).toEqual([dead.id, dead.id, dead.id, dead.id]);
    // The repair's databases go to R2, the release it read. R1's selection of x86_64 is R2's and R3's: one render makes all three current.
    expect(await put(kept.id, "db", "omarchy-core-edge", "x86_64", 9)).toBe(201);
    expect(await put(kept.id, "files", "omarchy-core-edge", "x86_64", 9)).toBe(201);
    const done = await call("POST", `/releases/${kept.id}/rendered?arch=x86_64`, undefined, render);
    expect(done.status).toBe(200);
    // packages' two rows of R2, of R1 and of R3: a source that selection no longer has.
    expect(done.json.dropped).toBe(6);
    for (const id of [dead.id, kept.id, during.id]) {
      expect(await x86(id), `release ${id}`).toEqual([
        { repo: "omarchy-core-edge", arch: "x86_64", kind: "db", awaits: null },
        { repo: "omarchy-core-edge", arch: "x86_64", kind: "files", awaits: null },
      ]);
    }
    // The head, R3, serves the repair's databases as its own: nothing of x86_64 carried, the dropped source out of the include.
    const size = await env.DB.prepare("SELECT size FROM release_artifacts WHERE release_id = ? AND arch = 'x86_64' AND kind = 'db'").bind(during.id).first<{ size: number }>();
    expect(size?.size).toBe(9);
    expect(await sections("x86_64")).toEqual(["omarchy-core-edge"]);
    const stats = (await call("GET", `/stats?t=${++fresh}`)).json.rings.find((r: any) => r.ring === "edge");
    expect(stats.release.id).toBe(during.id);
    expect(stats.carried.filter((a: any) => a.arch === "x86_64")).toEqual([]);
    expect(stats.artifacts.filter((a: any) => a.arch === "x86_64" && a.kind === "db").map((a: any) => a.repo)).toEqual(["omarchy-core-edge"]);
  });

  it("an architecture a render left with no database stays without one: no later release brings an earlier one's back", async () => {
    const start = (await call("GET", "/releases/edge?fields=summary")).json.release.id;
    await renderWhole(start, "aarch64", ["core"]);
    // aarch64's last package goes (a remove, or an arch-scoped rollback to a selection without it). Until its render the
    // ring serves the last aarch64 databases rendered; the render puts nothing and drops them.
    const emptied = await sync("aarch64", { remove: ["zlib"] });
    expect(await sections("aarch64")).toEqual(["omarchy-core-edge"]);
    expect(await renderWhole(emptied.id, "aarch64", [])).toBe(2);
    expect(await sections("aarch64")).toEqual([]);
    // The next release keeps that: it carries nothing for aarch64 — not the databases of the release before, awaiting a
    // render that would drop them again, the include listing them meanwhile.
    const next = await sync("x86_64");
    expect((await rowsOf(next.id)).filter((r) => r.arch === "aarch64")).toEqual([]);
    expect(await sections("aarch64")).toEqual([]);
    // aarch64 back: nothing to carry until its render, which serves it again.
    const back = await sync("aarch64", { add: [shas.zlibArm] });
    expect((await rowsOf(back.id)).filter((r) => r.arch === "aarch64")).toEqual([]);
    await renderWhole(back.id, "aarch64", ["core"]);
    expect(await sections("aarch64")).toEqual(["omarchy-core-edge"]);
  });

  it("retention keeps what a carried database lists while the head serves it", async () => {
    // x86_64 rendered with a package in it, then the x86_64 sync that drops it dies before its render…
    shas.old = await index("packages", "x86_64", "old", "0.9-1", pool);
    const withOld = await sync("x86_64", { add: [shas.old] });
    await renderWhole(withOld.id, "x86_64", ["core", "packages"]);
    await sync("x86_64", { remove_from: [{ source: "packages", name: "old" }] });
    // …and four aarch64 syncs, rendered, keep its x86_64 (the ticks while the x86_64 render kept dying): the release that
    // dropped the package is behind the last three that retention protects, and the package is past the grace.
    for (let i = 0; i < 4; i++) await renderWhole((await sync("aarch64")).id, "aarch64", ["core"]);
    await env.DB.prepare("UPDATE packages SET created_at = '2026-01-01T00:00:00.000Z' WHERE sha256 = ?").bind(shas.old).run();
    const unreferenced = async () => (await call("GET", "/pool/unreferenced?keep=3")).json.packages.map((p: any) => p.sha256);
    // The head's include names the packages database that lists it: a user's pacman fetches it from there. GC keeps it.
    expect(await sections("x86_64")).toEqual(["omarchy-packages-edge", "omarchy-core-edge"]);
    expect(await unreferenced()).not.toContain(shas.old);
    // Once the head's render lands, nothing served lists it: past retention like any other.
    const head = (await call("GET", "/releases/edge?fields=summary")).json.release.id;
    await renderWhole(head, "x86_64", ["core"]);
    expect(await sections("x86_64")).toEqual(["omarchy-core-edge"]);
    expect(await unreferenced()).toContain(shas.old);
  });

  it("a whole render is said by a token for the ring's artifacts, of an architecture, of a release that is there", async () => {
    const head = (await call("GET", "/releases/edge?fields=summary")).json.release.id;
    expect((await call("POST", `/releases/${head}/rendered?arch=x86_64`)).status).toBe(401);
    expect((await call("POST", `/releases/${head}/rendered?arch=x86_64`, undefined, await job(["artifacts:*:stable"]))).status).toBe(403);
    expect((await call("POST", `/releases/${head}/rendered?arch=riscv64`, undefined, render)).status).toBe(400);
    expect((await call("POST", "/releases/999999/rendered?arch=x86_64", undefined, render)).status).toBe(404);
  });

  it("reads and writes what awaits a render through an index, never a scan", async () => {
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    expect(await plan(AWAITED_SQL, [1, "omarchy-core-edge", "x86_64", "db", "k", 1])).toContain("USING INDEX idx_release_artifacts_awaits");
    for (const sql of RENDERED_SQL) expect(await plan(sql, [1, "x86_64"])).not.toMatch(/SCAN release_artifacts/);
    expect(await plan(RENDERED_SQL[1], [1, "x86_64"])).toContain("USING INDEX idx_release_artifacts_awaits");
    // What a release's own rows awaited, and which architectures a head carries: its own rows, by the primary key — not
    // every awaiting row of every release, which the partial index holds.
    for (const [sql, args] of [[OWN_WAIT_SQL, [1, "omarchy-core-edge", "x86_64", "db", "db.sig"]], [WAITED_SQL, [1, "x86_64"]], [CARRIED_ARCHES_SQL, [1]]] as const) {
      const p = await plan(sql, [...args]);
      expect(p, sql).not.toMatch(/SCAN release_artifacts/);
      expect(p, sql).not.toContain("idx_release_artifacts_awaits");
    }
    // Retention's look back from a head that carries: down the ring's (ring, seq) key, the artifacts by their primary key.
    expect(await plan(RENDERED_BEFORE_SQL, ["edge", 100, "x86_64"])).not.toMatch(/SCAN (releases|release_artifacts)\b/);
  });
});
