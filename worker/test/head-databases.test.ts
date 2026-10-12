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
import { AWAITED_SQL, RENDERED_SQL } from "../src/routes/releases";

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

let fresh = 0;
/** The sections of edge's include for `arch`, as a user's pacman reads them (a fresh URL: the include sits in the edge cache). */
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
    // What the dashboard and the health check read say which databases are the head's own.
    const stats = (await call("GET", "/stats")).json.rings.find((r: any) => r.ring === "edge");
    expect(stats.artifacts.filter((a: any) => a.arch === "x86_64" && a.kind === "db").map((a: any) => a.awaits)).toEqual([head, head]);
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

  it("a whole render is said by a token for the ring's artifacts, of an architecture, of a release that is there", async () => {
    const head = (await call("GET", "/releases/edge?fields=summary")).json.release.id;
    expect((await call("POST", `/releases/${head}/rendered?arch=x86_64`)).status).toBe(401);
    expect((await call("POST", `/releases/${head}/rendered?arch=x86_64`, undefined, await job(["artifacts:*:stable"]))).status).toBe(403);
    expect((await call("POST", `/releases/${head}/rendered?arch=riscv64`, undefined, render)).status).toBe(400);
    expect((await call("POST", "/releases/999999/rendered?arch=x86_64", undefined, render)).status).toBe(404);
  });

  it("reads and writes what awaits a render through an index, never a scan", async () => {
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const awaited = await plan(AWAITED_SQL, [1, "omarchy-core-edge", "x86_64", "db", "k", 1]);
    expect(awaited).toContain("USING INDEX idx_release_artifacts_awaits");
    for (const sql of RENDERED_SQL) expect(await plan(sql, [1, "x86_64"])).not.toMatch(/SCAN release_artifacts/);
    expect(await plan(RENDERED_SQL[1], [1, "x86_64"])).toContain("USING INDEX idx_release_artifacts_awaits");
  });
});
