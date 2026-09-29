/**
 * Which package a library a binary loads comes from (#275). On x86_64
 * stable, zlib's libc.so.6 resolved to aarch64-linux-gnu-glibc 2.44-1: a
 * cross toolchain's sysroot, an `any` package that ships an aarch64
 * libc.so.6 beside glibc's, indexed before glibc — and the first row the
 * index gave back won. The graph groups by provider, so the wrong one was a
 * second node: the header said Depends on 1, the graph Depends on · 2.
 *
 * A ring of its own, seeded through the Worker's endpoints the way a sync
 * would index it (a–z, the cross toolchain first): glibc in core, lib32-glibc
 * in multilib and aarch64-linux-gnu-glibc in extra all ship a libc.so.6.
 * zlib declares glibc, lib32-zlib declares lib32-glibc, pigz declares
 * neither, and aarch64-linux-gnu-gcc — a program that runs here — declares
 * the cross sysroot it builds against. The rule: a soname found in the ELF
 * files counts only from a package built for the page's architecture; of
 * those, the one the package declares, then the include's order.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { issueJobToken } from "../src/jobtoken";
import { packageKey } from "../src/r2";
import { runScript, scriptOf } from "./fixture";

const ARCH = "x86_64";

async function call(method: string, path: string, body?: unknown, token?: string, db?: D1Database): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), db ? { ...env, DB: db } : env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a page */ }
  return { status: res.status, text, json };
}

interface Pkg { source: string; name: string; version: string; arch?: string; depends?: string[]; requires?: string[]; provides?: string[]; sonames?: string[] }

/** A fake object in the pool and its manifest indexed, as the sync does (test/fixture.ts's index, with the object's own architecture). */
async function index(p: Pkg, token: string): Promise<string> {
  const arch = p.arch ?? ARCH;
  const filename = `${p.name}-${p.version}-${arch}.pkg.tar.zst`;
  const bytes = new TextEncoder().encode(`fake ${filename}`);
  await env.PACKAGES.put(packageKey(p.source, ARCH, filename), bytes);
  const sha = Array.from({ length: 64 }, (_, i) => `${p.source}/${filename}`.charCodeAt(i % `${p.source}/${filename}`.length).toString(16).slice(-1)).join("");
  const r = await call("POST", `/api/v1/packages?source=${p.source}&arch=${ARCH}`, {
    schema_version: 1, name: p.name, version: p.version, arch, sha256: sha, filename, size_download: bytes.length, size_installed: bytes.length * 3,
    provides: [p.name, ...(p.provides ?? []), ...(p.sonames ?? [])], requires: p.requires ?? [],
    pkginfo: { base: p.name, packager: "A Packager <packager@example.org>", depends: p.depends ?? [], provides: p.provides ?? [] },
    files: [`usr/bin/${p.name}`],
  }, token);
  expect(r.status, `index ${p.name}`).toBe(201);
  return sha;
}

/** D1 with every statement recorded, its bindings and what it read: the provider lookup's plan and cost. */
function recording(db: D1Database): { db: D1Database; log: { sql: string; args: unknown[]; rows: number }[] } {
  const log: { sql: string; args: unknown[]; rows: number }[] = [];
  const wrap = (sql: string, stmt: D1PreparedStatement, args: unknown[]): any => ({
    __raw: stmt,
    bind: (...a: unknown[]) => wrap(sql, stmt.bind(...a), a),
    all: async () => { const r = await stmt.all(); log.push({ sql, args, rows: r.meta.rows_read ?? 0 }); return r; },
    run: async () => { const r = await stmt.run(); log.push({ sql, args, rows: r.meta.rows_read ?? 0 }); return r; },
    first: async (col?: string) => { const r = await stmt.all<Record<string, unknown>>(); log.push({ sql, args, rows: r.meta.rows_read ?? 0 }); const row = r.results[0] ?? null; return col ? (row ? row[col] : null) : row; },
  });
  const proxy = {
    prepare: (sql: string) => wrap(sql, db.prepare(sql), []),
    batch: async (stmts: any[]) => { const rs = await db.batch(stmts.map((s) => s.__raw ?? s)); return rs; },
  };
  return { db: proxy as unknown as D1Database, log };
}

const libc = (bits: string) => ({ provides: [`libc.so=6-${bits}`], sonames: ["libc.so.6"] });

beforeAll(async () => {
  const pool = await issueJobToken(env, { t: 1, k: "test", s: ["pool:write"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  const stable = await issueJobToken(env, { t: 1, k: "test", s: ["release:stable"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  // As a sync indexes them, a–z: the cross toolchain's sysroot first, glibc's libc.so.6 after two others.
  const add = [
    await index({ source: "extra", name: "aarch64-linux-gnu-glibc", version: "2.44-1", arch: "any", ...libc("64") }, pool),
    await index({ source: "extra", name: "aarch64-linux-gnu-gcc", version: "15.2.0-1", depends: ["aarch64-linux-gnu-glibc"], requires: ["aarch64-linux-gnu-glibc", "libc.so.6"] }, pool),
    await index({ source: "multilib", name: "lib32-glibc", version: "2.44+r1-1", ...libc("32") }, pool),
    await index({ source: "core", name: "glibc", version: "2.44+r1-1", ...libc("64") }, pool),
    await index({ source: "core", name: "zlib", version: "1:1.3.2-3", depends: ["glibc"], requires: ["glibc", "libc.so.6", "libc.so.6(GLIBC_2.14)"], provides: ["libz.so=1-64"], sonames: ["libz.so.1"] }, pool),
    await index({ source: "multilib", name: "lib32-zlib", version: "1:1.3.2-3", depends: ["lib32-glibc", "zlib"], requires: ["lib32-glibc", "zlib", "libc.so.6"], provides: ["libz.so=1-32"], sonames: ["libz.so.1"] }, pool),
    await index({ source: "extra", name: "pigz", version: "2.8-1", depends: ["zlib"], requires: ["zlib", "libc.so.6", "libz.so.1"] }, pool),
  ];
  expect((await call("POST", "/api/v1/releases", { ring: "stable", add, note: "a cross toolchain beside glibc" }, stable)).status).toBe(201);
});

const pkg = (name: string) => call("GET", `/api/v1/package/${name}?ring=stable&arch=${ARCH}`);
const providerOf = (d: any, soname: string) => d.links.find((l: { soname: string }) => l.soname === soname)?.provider?.name ?? null;

describe("a library resolves to a package built for the page's architecture", () => {
  it("zlib's libc.so.6 on x86_64 is glibc's, not the aarch64 sysroot's a cross toolchain ships", async () => {
    const zlib = (await pkg("zlib")).json;
    expect(zlib.links).toEqual([{ soname: "libc.so.6", provider: { name: "glibc", version: "2.44+r1-1" } }]);
    expect(zlib.depends).toEqual([{ name: "glibc", provider: { name: "glibc", version: "2.44+r1-1" } }]);
  });

  it("never takes an `any` package's soname, even one the package declares: a cross compiler still loads the machine's libc", async () => {
    const gcc = (await pkg("aarch64-linux-gnu-gcc")).json;
    expect(gcc.depends).toEqual([{ name: "aarch64-linux-gnu-glibc", provider: { name: "aarch64-linux-gnu-glibc", version: "2.44-1" } }]);
    expect(providerOf(gcc, "libc.so.6")).toBe("glibc");
  });

  it("takes the provider the package declares — a lib32 package's lib32-glibc — and else the include's order: core before multilib", async () => {
    expect(providerOf((await pkg("lib32-zlib")).json, "libc.so.6")).toBe("lib32-glibc");
    const pigz = (await pkg("pigz")).json;
    expect(providerOf(pigz, "libc.so.6")).toBe("glibc");
    expect(providerOf(pigz, "libz.so.1")).toBe("zlib");
  });

  it("counts no dependent through what an `any` package ships: the sysroot is required by the compiler that declares it, not by every libc.so.6", async () => {
    const cross = (await pkg("aarch64-linux-gnu-glibc")).json;
    expect(cross.required_by).toEqual([{ name: "aarch64-linux-gnu-gcc", version: "15.2.0-1", declared: true, sonames: [] }]);
    // glibc is still loaded by every package that loads libc.so.6.
    const glibc = (await pkg("glibc")).json;
    expect(glibc.required_by.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(["aarch64-linux-gnu-gcc", "pigz", "zlib"]));
    expect(glibc.required_by.find((r: { name: string }) => r.name === "pigz")).toMatchObject({ declared: false, sonames: ["libc.so.6"] });
  });
});

describe("zlib's page", () => {
  it("says Depends on the same number in its header and its graph: one node, glibc, declared and loaded", async () => {
    const page = await call("GET", `/package/zlib?ring=stable&arch=${ARCH}`);
    expect(page.status).toBe(200);
    const ran = runScript(scriptOf(page.text), {
      pathname: "/package/zlib",
      search: `?ring=stable&arch=${ARCH}`,
      functions: [],
      fetch: async (p: string) => {
        const ctx = createExecutionContext();
        const res = await worker.fetch(new Request(`http://pool.test${p}`), env, ctx);
        await waitOnExecutionContext(ctx);
        return res;
      },
    });
    const nodes = ran.nodes as Record<string, { innerHTML: string }>;
    for (let i = 0; i < 200 && !(nodes["#deps"]?.innerHTML ?? "").includes("Depends on ·"); i++) await new Promise((r) => setTimeout(r, 5));
    const tiles = nodes["#pg-tiles"].innerHTML, graph = nodes["#deps"].innerHTML;
    const header = tiles.match(/Depends on<\/span><span class="n [^"]*" title="(\d+)"/)?.[1];
    expect(header).toBe("1");
    expect(graph).toContain(`Depends on · ${header}</span>`);
    expect(graph).toContain('<span class="nm">glibc</span>');
    expect(graph).not.toContain("aarch64-linux-gnu-glibc");
  });

  it("reads what it read before (#227): the lookup goes from the capabilities through the indexes into the ring, a few rows per candidate", async () => {
    const { db, log } = recording(env.DB);
    // A query of its own, past the edge's copy the tests above left: this view reads D1.
    expect((await call("GET", `/api/v1/package/zlib?ring=stable&arch=${ARCH}&t=rows`, undefined, undefined, db)).status).toBe(200);
    const lookup = log.find((l) => l.sql.includes("FROM json_each(?1) cap") && l.sql.includes("package_provides pv"));
    expect(lookup).toBeDefined();
    const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${lookup!.sql}`).bind(...lookup!.args).all<{ detail: string }>()).results.map((r) => r.detail);
    // The capabilities (json_each) and the union's own rows are the only scans; every table is searched through an index, the ring by its primary key.
    expect(plan.filter((d) => /^SCAN /.test(d)).every((d) => /^SCAN (cap\b|\(subquery-)/.test(d)), plan.join(" | ")).toBe(true);
    expect(plan.join(" | ")).toMatch(/SEARCH pv USING INDEX idx_provides_(capability|declared)/);
    expect(plan.join(" | ")).toMatch(/SEARCH p USING INTEGER PRIMARY KEY/);
    expect(plan.filter((d) => /\brp\b/.test(d)).every((d) => /SEARCH rp USING (COVERING INDEX|PRIMARY KEY)/.test(d)), plan.join(" | ")).toBe(true);
    // What main read for this view before the rule, over this seed: 21 rows for the lookup, 60 for the view. The rule
    // filters on the package row the lookup reads anyway and ranks in the Worker, so neither can grow; the view reads
    // fewer (53): one provider, not two, to read the advisories of.
    expect(lookup!.rows).toBeLessThanOrEqual(21);
    expect(log.reduce((n, l) => n + l.rows, 0)).toBeLessThanOrEqual(60);
  });
});
