/**
 * Which package a library a binary loads comes from (#275). On x86_64
 * stable, zlib's libc.so.6 resolved to aarch64-linux-gnu-glibc 2.44-1: a
 * cross toolchain's sysroot, an `any` package that ships an aarch64
 * libc.so.6 beside glibc's, indexed before glibc — and the first row the
 * index gave back won. The graph groups by provider, so the wrong one was a
 * second node: the header said Depends on 1, the graph Depends on · 2.
 *
 * A ring of its own, seeded through the Worker's endpoints the way a sync
 * would index it (a–z, the cross toolchains first), each library shipped as
 * pkg-extract records it: the soname and Arch's `libfoo.so=N-64` form (its
 * ELF class), neither declared, and the file where it lies. Three machines
 * ship a libc.so.6 — glibc in core, lib32-glibc (i686) in multilib and the
 * `any` sysroot aarch64-linux-gnu-glibc in extra — and three a
 * libstdc++.so.6: gcc-libs in core, and two x86_64 cross compilers that
 * carry an aarch64 or a riscv64 one in their sysroot (`/usr/<target>/lib`),
 * one of them from a source pacman reads before core. lib32-curl declares
 * the 32-bit libcrypto.so and libz.so, as Arch's does, and not lib32-glibc.
 * The rule: a library a binary loads comes from a package built for the
 * page's architecture, of the binary's ELF class, and never from a sysroot.
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

/** Libraries a package ships, as pkg-extract finds them in its ELF files: their ELF class and the directory they lie in. */
interface Ships { bits: "32" | "64"; sonames: string[]; dir: string }
interface Pkg { source: string; name: string; version: string; arch?: string; depends?: string[]; requires?: string[]; provides?: string[]; ships?: Ships }

/** A fake object in the pool and its manifest indexed, as the sync does (test/fixture.ts's index, with the object's own architecture). */
async function index(p: Pkg, token: string): Promise<string> {
  const arch = p.arch ?? ARCH;
  const filename = `${p.name}-${p.version}-${arch}.pkg.tar.zst`;
  const bytes = new TextEncoder().encode(`fake ${filename}`);
  await env.PACKAGES.put(packageKey(p.source, ARCH, filename), bytes);
  const sha = Array.from({ length: 64 }, (_, i) => `${p.source}/${filename}`.charCodeAt(i % `${p.source}/${filename}`.length).toString(16).slice(-1)).join("");
  // pkg-extract's merge: each soname, and its `libfoo.so=N-<class>` form, is a provide the package does not declare.
  const shipped = (p.ships?.sonames ?? []).flatMap((so) => [so, `${so.slice(0, so.lastIndexOf(".so.") + 3)}=${so.slice(so.lastIndexOf(".so.") + 4)}-${p.ships!.bits}`]);
  const r = await call("POST", `/api/v1/packages?source=${p.source}&arch=${ARCH}`, {
    schema_version: 1, name: p.name, version: p.version, arch, sha256: sha, filename, size_download: bytes.length, size_installed: bytes.length * 3,
    provides: [p.name, ...(p.provides ?? []), ...shipped], requires: p.requires ?? [],
    pkginfo: { base: p.name, packager: "A Packager <packager@example.org>", depends: p.depends ?? [], provides: p.provides ?? [] },
    files: [`/usr/bin/${p.name}`, ...(p.ships?.sonames ?? []).map((so) => `/${p.ships!.dir}/${so}`)],
  }, token);
  expect(r.status, `index ${p.name}`).toBe(201);
  return sha;
}

/** D1 with every statement recorded, its bindings and what it read: the provider lookup's plan and cost. */
function recording(db: D1Database): { db: D1Database; log: { sql: string; args: unknown[]; rows: number }[] } {
  const log: { sql: string; args: unknown[]; rows: number }[] = [];
  const wrap = (sql: string, stmt: D1PreparedStatement, args: unknown[]): any => ({
    __raw: stmt,
    sql,
    bind: (...a: unknown[]) => wrap(sql, stmt.bind(...a), a),
    all: async () => { const r = await stmt.all(); log.push({ sql, args, rows: r.meta.rows_read ?? 0 }); return r; },
    run: async () => { const r = await stmt.run(); log.push({ sql, args, rows: r.meta.rows_read ?? 0 }); return r; },
    first: async (col?: string) => { const r = await stmt.all<Record<string, unknown>>(); log.push({ sql, args, rows: r.meta.rows_read ?? 0 }); const row = r.results[0] ?? null; return col ? (row ? row[col] : null) : row; },
  });
  const proxy = {
    prepare: (sql: string) => wrap(sql, db.prepare(sql), []),
    batch: async (stmts: any[]) => { const rs = await db.batch(stmts.map((s) => s.__raw ?? s)); rs.forEach((r, i) => log.push({ sql: stmts[i].sql ?? "batch", args: [], rows: r.meta.rows_read ?? 0 })); return rs; },
  };
  return { db: proxy as unknown as D1Database, log };
}

const sha: Record<string, string> = {};

beforeAll(async () => {
  const pool = await issueJobToken(env, { t: 1, k: "test", s: ["pool:write"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  const stable = await issueJobToken(env, { t: 1, k: "test", s: ["release:stable"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
  const lib = (bits: "32" | "64", dir: string, ...sonames: string[]): Ships => ({ bits, dir, sonames });
  // As a sync indexes them, a–z: the cross toolchains first, glibc's libc.so.6 after two others.
  for (const p of [
    // The sysroot even declares the 64-bit libc.so its aarch64 one is.
    { source: "extra", name: "aarch64-linux-gnu-glibc", version: "2.44-1", arch: "any", provides: ["libc.so=6-64"], ships: lib("64", "usr/aarch64-linux-gnu/lib", "libc.so.6") },
    { source: "extra", name: "aarch64-linux-gnu-gcc", version: "15.2.0-1", depends: ["aarch64-linux-gnu-glibc"], requires: ["aarch64-linux-gnu-glibc", "libc.so.6"], ships: lib("64", "usr/aarch64-linux-gnu/lib", "libstdc++.so.6", "libgcc_s.so.1") },
    // An OPR build of a cross compiler: its source comes before core in the include.
    { source: "packages", name: "riscv64-linux-gnu-gcc", version: "15.2.0-1", requires: ["libc.so.6"], ships: lib("64", "usr/riscv64-linux-gnu/lib", "libstdc++.so.6") },
    { source: "extra", name: "cmake", version: "4.1.2-1", requires: ["libc.so.6", "libstdc++.so.6", "libgcc_s.so.1"] },
    { source: "core", name: "gcc-libs", version: "15.2.1-1", requires: ["libc.so.6"], ships: lib("64", "usr/lib", "libstdc++.so.6", "libgcc_s.so.1") },
    { source: "multilib", name: "lib32-glibc", version: "2.44+r1-1", ships: lib("32", "usr/lib32", "libc.so.6") },
    { source: "core", name: "glibc", version: "2.44+r1-1", ships: lib("64", "usr/lib", "libc.so.6") },
    { source: "core", name: "openssl", version: "3.6.0-1", depends: ["glibc"], requires: ["glibc", "libc.so.6"], provides: ["libcrypto.so=3-64"], ships: lib("64", "usr/lib", "libcrypto.so.3") },
    { source: "multilib", name: "lib32-openssl", version: "1:3.6.0-1", depends: ["lib32-glibc"], requires: ["lib32-glibc", "libc.so.6"], provides: ["libcrypto.so=3-32"], ships: lib("32", "usr/lib32", "libcrypto.so.3") },
    { source: "core", name: "zlib", version: "1:1.3.2-3", depends: ["glibc"], requires: ["glibc", "libc.so.6", "libc.so.6(GLIBC_2.14)"], provides: ["libz.so=1-64"], ships: lib("64", "usr/lib", "libz.so.1") },
    { source: "multilib", name: "lib32-zlib", version: "1:1.3.2-3", depends: ["lib32-glibc", "zlib"], requires: ["lib32-glibc", "zlib", "libc.so.6"], provides: ["libz.so=1-32"], ships: lib("32", "usr/lib32", "libz.so.1") },
    // Arch's lib32-curl: the 32-bit libcrypto.so and libz.so by name and class, no lib32-glibc.
    { source: "multilib", name: "lib32-curl", version: "8.16.0-1", depends: ["lib32-openssl", "libcrypto.so=3-32", "libz.so=1-32"], requires: ["lib32-openssl", "libcrypto.so=3-32", "libz.so=1-32", "libcrypto.so.3", "libc.so.6", "libz.so.1"], provides: ["libcurl.so=4-32"], ships: lib("32", "usr/lib32", "libcurl.so.4") },
    { source: "extra", name: "pigz", version: "2.8-1", depends: ["zlib"], requires: ["zlib", "libc.so.6", "libz.so.1"] },
    // Arch's rust-aarch64-gnu declares the cross compiler, and its own tools load the machine's libstdc++.
    { source: "extra", name: "rust-aarch64-gnu", version: "1:1.90.0-1", depends: ["aarch64-linux-gnu-gcc"], requires: ["aarch64-linux-gnu-gcc", "libc.so.6", "libstdc++.so.6"] },
  ] as Pkg[]) sha[p.name] = await index(p, pool);
  expect((await call("POST", "/api/v1/releases", { ring: "stable", add: Object.values(sha), note: "cross toolchains and lib32 beside glibc" }, stable)).status).toBe(201);
});

const pkg = (name: string) => call("GET", `/api/v1/package/${name}?ring=stable&arch=${ARCH}`);
const providerOf = (d: any, soname: string) => d.links.find((l: { soname: string }) => l.soname === soname)?.provider?.name ?? null;
const dependents = (d: any) => d.required_by.map((r: { name: string }) => r.name);

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

  it("counts no dependent through what an `any` package ships: the sysroot is required by the compiler that declares it, not by every libc.so.6", async () => {
    const cross = (await pkg("aarch64-linux-gnu-glibc")).json;
    expect(cross.required_by).toEqual([{ name: "aarch64-linux-gnu-gcc", version: "15.2.0-1", declared: true, sonames: [] }]);
    const glibc = (await pkg("glibc")).json;
    expect(dependents(glibc)).toEqual(expect.arrayContaining(["aarch64-linux-gnu-gcc", "pigz", "zlib"]));
    expect(glibc.required_by.find((r: { name: string }) => r.name === "pigz")).toMatchObject({ declared: false, sonames: ["libc.so.6"] });
  });
});

describe("a library resolves to a package of the binary's ELF class", () => {
  it("lib32-curl, which names neither lib32-glibc nor a 64-bit package, loads the 32-bit libc, libcrypto and libz", async () => {
    const curl = (await pkg("lib32-curl")).json;
    expect(curl.links.map((l: any) => [l.soname, l.provider?.name])).toEqual([["libcrypto.so.3", "lib32-openssl"], ["libc.so.6", "lib32-glibc"], ["libz.so.1", "lib32-zlib"]]);
    // What it declares by class, as pacman reads it: libcrypto.so=3-32 is lib32-openssl's provide, not openssl's libcrypto.so=3-64.
    expect(curl.depends.map((d: any) => [d.name, d.provider?.name])).toEqual([["lib32-openssl", "lib32-openssl"], ["libcrypto.so", "lib32-openssl"], ["libz.so", "lib32-zlib"]]);
  });

  it("a lib32 package loads lib32-glibc and a 64-bit one glibc, whatever each declares", async () => {
    expect(providerOf((await pkg("lib32-zlib")).json, "libc.so.6")).toBe("lib32-glibc");
    const pigz = (await pkg("pigz")).json;
    expect(providerOf(pigz, "libc.so.6")).toBe("glibc");
    expect(providerOf(pigz, "libz.so.1")).toBe("zlib");
  });

  it("counts dependents of its own class only: glibc is not loaded by lib32 packages, lib32-glibc by nothing 64-bit", async () => {
    const glibc = dependents((await pkg("glibc")).json);
    for (const lib32 of ["lib32-curl", "lib32-openssl", "lib32-zlib"]) expect(glibc).not.toContain(lib32);
    expect((await pkg("lib32-glibc")).json.required_by).toEqual([
      { name: "lib32-curl", version: "8.16.0-1", declared: false, sonames: ["libc.so.6"] },
      { name: "lib32-openssl", version: "1:3.6.0-1", declared: true, sonames: ["libc.so.6"] },
      { name: "lib32-zlib", version: "1:1.3.2-3", declared: true, sonames: ["libc.so.6"] },
    ]);
    // zlib: lib32-zlib names it, and nothing 32-bit loads its libz.so.1 or declares its libz.so=1-64.
    expect((await pkg("zlib")).json.required_by).toEqual([
      { name: "lib32-zlib", version: "1:1.3.2-3", declared: true, sonames: [] },
      { name: "pigz", version: "2.8-1", declared: true, sonames: ["libz.so.1"] },
    ]);
    // lib32-curl, through the libz.so=1-32 it declares (the page lists a class form with the sonames, as before) and the libz.so.1 it loads.
    expect((await pkg("lib32-zlib")).json.required_by.map((r: any) => ({ ...r, sonames: [...r.sonames].sort() }))).toEqual([{ name: "lib32-curl", version: "8.16.0-1", declared: false, sonames: ["libz.so", "libz.so.1"] }]);
    expect(dependents((await pkg("openssl")).json)).toEqual([]);
  });
});

describe("a package's ELF class", () => {
  it("is what the Worker writes at indexing and migration 0041 computes over the rows already there", async () => {
    const pool = await issueJobToken(env, { t: 1, k: "test", s: ["pool:write"], e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
    // Outside the ring: a package that ships a 64-bit library and declares a 32-bit one — both classes.
    await index({ source: "multilib", name: "steam-like", version: "1.0-1", depends: ["libz.so=1-32"], requires: ["libz.so=1-32"], ships: { bits: "64", dir: "usr/lib", sonames: ["libsteam.so.1"] } }, pool);
    const read = async () => Object.fromEntries((await env.DB.prepare("SELECT name, elf_class FROM packages ORDER BY name").all<{ name: string; elf_class: string | null }>()).results.map((r) => [r.name, r.elf_class]));
    const written = await read();
    expect(Object.entries(written).filter(([, c]) => c !== null)).toEqual([["lib32-curl", "32"], ["lib32-glibc", "32"], ["lib32-openssl", "32"], ["lib32-zlib", "32"], ["steam-like", "32 64"]]);
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0041_"))!;
    expect(m, "migration 0041 is in the list").toBeTruthy();
    await env.DB.prepare("UPDATE packages SET elf_class = NULL").run();
    // The migration's statements after the column it adds, as D1 applies them.
    await env.DB.batch(m.queries.filter((q) => !/^\s*ALTER TABLE/i.test(q)).map((q) => env.DB.prepare(q)));
    expect(await read()).toEqual(written);
  });
});

describe("a library in a cross compiler's sysroot is another machine's", () => {
  it("cmake loads gcc-libs' libstdc++ — not the cross compilers', one of them from a source read before core", async () => {
    const cmake = (await pkg("cmake")).json;
    expect(cmake.links.map((l: any) => [l.soname, l.provider?.name])).toEqual([["libc.so.6", "glibc"], ["libstdc++.so.6", "gcc-libs"], ["libgcc_s.so.1", "gcc-libs"]]);
  });

  it("a package that declares the cross compiler still loads the machine's libstdc++", async () => {
    const rust = (await pkg("rust-aarch64-gnu")).json;
    expect(rust.depends).toEqual([{ name: "aarch64-linux-gnu-gcc", provider: { name: "aarch64-linux-gnu-gcc", version: "15.2.0-1" } }]);
    expect(providerOf(rust, "libstdc++.so.6")).toBe("gcc-libs");
  });

  it("brings a cross compiler no dependent through its sysroot: what declares it, not every C++ program", async () => {
    expect((await pkg("aarch64-linux-gnu-gcc")).json.required_by).toEqual([{ name: "rust-aarch64-gnu", version: "1:1.90.0-1", declared: true, sonames: [] }]);
    expect((await pkg("riscv64-linux-gnu-gcc")).json.required_by).toEqual([]);
    expect(dependents((await pkg("gcc-libs")).json)).toEqual(["cmake", "rust-aarch64-gnu"]);
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
    // What main read over this seed, per view: the provider lookup, the reverse edges, the whole view.
    const main: Record<string, { lookup?: number; reverse: number; view: number }> = {
      zlib: { lookup: 21, reverse: 25, view: 69 },
      cmake: { lookup: 33, reverse: 2, view: 59 },
      "lib32-curl": { lookup: 69, reverse: 4, view: 108 },
      glibc: { reverse: 60, view: 71 },
      "aarch64-linux-gnu-gcc": { lookup: 21, reverse: 24, view: 63 },
    };
    for (const [name, before] of Object.entries(main)) {
      const { db, log } = recording(env.DB);
      // A query of its own, past the edge's copy the tests above left: this view reads D1.
      expect((await call("GET", `/api/v1/package/${name}?ring=stable&arch=${ARCH}&t=rows`, undefined, undefined, db)).status).toBe(200);
      const lookup = log.find((l) => l.sql.includes("FROM json_each(?1) cap") && l.sql.includes("package_provides pv"));
      const reverse = log.find((l) => l.sql.includes("package_requires rq"))!;
      if (name === "zlib") {
        const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${lookup!.sql}`).bind(...lookup!.args).all<{ detail: string }>()).results.map((r) => r.detail);
        // The capabilities (json_each) and the union's own rows are the only scans; every table is searched through an index, the ring by its primary key.
        expect(plan.filter((d) => /^SCAN /.test(d)).every((d) => /^SCAN (cap\b|\(subquery-)/.test(d)), plan.join(" | ")).toBe(true);
        expect(plan.join(" | ")).toMatch(/SEARCH pv USING INDEX idx_provides_(capability|declared)/);
        expect(plan.join(" | ")).toMatch(/SEARCH p USING INTEGER PRIMARY KEY/);
        expect(plan.filter((d) => /\brp\b/.test(d)).every((d) => /SEARCH rp USING (COVERING INDEX|PRIMARY KEY)/.test(d)), plan.join(" | ")).toBe(true);
      }
      // The reverse edges keep their order: the capabilities, the requirement index, the ring's key, the package row the class is read on.
      const rplan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${reverse.sql}`).bind(...reverse.args).all<{ detail: string }>()).results.map((r) => r.detail);
      expect(rplan.filter((d) => /^SCAN /.test(d)).every((d) => /^SCAN (cap|json_each) VIRTUAL TABLE/.test(d)), rplan.join(" | ")).toBe(true);
      expect(rplan.join(" | ")).toMatch(/SEARCH rq USING INDEX idx_requires_requirement .*SEARCH rp USING COVERING INDEX .*SEARCH p USING INTEGER PRIMARY KEY/);
      // A file list is a point read on its primary key: a candidate's, where two or more could answer a library (cmake's libstdc++.so.6), and the page's own.
      for (const l of log.filter((x) => x.sql.includes("FROM package_file_lists"))) {
        expect((await env.DB.prepare(`EXPLAIN QUERY PLAN ${l.sql}`).bind(...(l.args.length ? l.args : [1])).all<{ detail: string }>()).results.map((r) => r.detail)).toEqual([expect.stringMatching(/^SEARCH package_file_lists USING INTEGER PRIMARY KEY/)]);
        expect(l.rows, l.sql).toBeLessThanOrEqual(1);
      }
      // The rules filter on the rows the statements read anyway, and a package of another class is dropped before its
      // ring row is read: what a lib32 twin cost pays for the file lists the machine rule reads (cmake: two, the same view).
      if (before.lookup !== undefined) expect(lookup!.rows, `${name}'s lookup`).toBeLessThanOrEqual(before.lookup);
      expect(reverse.rows, `${name}'s reverse edges`).toBeLessThanOrEqual(before.reverse);
      expect(log.reduce((n, l) => n + l.rows, 0), `${name}'s view`).toBeLessThanOrEqual(before.view);
    }
  });
});

describe("the Security page's exposure follows the same rule", () => {
  it("counts what declares the sysroot, what loads glibc of its own class, and openssl's libcrypto.so=3-64 not for lib32-curl", async () => {
    const ids = Object.fromEntries((await env.DB.prepare("SELECT id, name FROM packages WHERE name IN ('aarch64-linux-gnu-glibc', 'glibc', 'openssl')").all<{ id: number; name: string }>()).results.map((r) => [r.name, r.id]));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO advisories (id, source, package, cves, severity, status, affected, fixed, summary, url, updated_at) VALUES ('test:275', 'arch', 'x', '[\"CVE-2099-275\"]', 'high', 'vulnerable', NULL, NULL, 'a test', 'https://example.org/275', '2026-09-29T00:00:00Z')"),
      ...Object.values(ids).map((id) => env.DB.prepare("INSERT INTO package_advisories (package_id, advisory_id, match, status, updated_at) VALUES (?, 'test:275', 'exact', 'vulnerable', '2026-09-29T00:00:00Z')").bind(id)),
    ]);
    const view = (await call("GET", `/api/v1/security?ring=stable&arch=${ARCH}&_=275`)).json;
    const exposure = Object.fromEntries(view.vulnerable.map((v: any) => [v.name, v.exposure]));
    expect(exposure["aarch64-linux-gnu-glibc"]).toEqual({ declared: 1, loads: 0 });
    // glibc: loaded by every 64-bit package here that loads libc.so.6 — the cross compilers' own tools too — and by nothing 32-bit.
    expect(exposure.glibc).toEqual({ declared: 2, loads: 8 });
    expect(exposure.openssl).toEqual({ declared: 0, loads: 0 });
  });
});
