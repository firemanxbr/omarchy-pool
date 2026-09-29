/**
 * A package's page (#244): one layout for every package, the same for every
 * reader, and only the actions in You change with who is looking. The page
 * is the served script, run as a browser would (runScript in
 * test/fixture.ts) against the Worker's own answers, as each viewer: a
 * visitor, bob (a contributor), alice (who requested `mine` and `ours`), m1
 * and m2 (the maintainers; m1 blocked `hers`). Around it, what the page
 * reads that is new: where each architecture is served (`arches` on
 * GET /package/:name), how many files (`files`), the two recipes of a
 * review (a chain's `recipes`), a package's maintainer in the pool
 * (`maintenance.maintainer`), and the one act that is new — Adopt, a
 * maintainer's, on the journal. The reads stay bounded: a page's rings are
 * read through the name, never the ring, and the seal names the worker that
 * built from the task itself, not from a walk of the journal.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";

let F: Fixture;
type Who = "" | "bob" | "alice" | "m1" | "m2";

beforeAll(async () => {
  F = await seedDashboard(env);
});

async function call(method: string, path: string, as: Who = "", body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = as ? { cookie: `omc=oms_${as}` } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a page */ }
  return { status: res.status, text, json };
}

/** D1 with its reads counted: every statement's rows_read, the batches' too — what one request costs. */
function counting(db: D1Database): { db: D1Database; rows: () => number } {
  let rows = 0;
  const wrap = (stmt: D1PreparedStatement): any => ({
    __raw: stmt,
    bind: (...a: unknown[]) => wrap(stmt.bind(...a)),
    all: async () => { const r = await stmt.all(); rows += r.meta.rows_read ?? 0; return r; },
    run: async () => { const r = await stmt.run(); rows += r.meta.rows_read ?? 0; return r; },
    first: async (col?: string) => { const r = await stmt.all<Record<string, unknown>>(); rows += r.meta.rows_read ?? 0; const row = r.results[0] ?? null; return col ? (row ? row[col] : null) : row; },
  });
  const proxy = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (stmts: any[]) => { const rs = await db.batch(stmts.map((s) => s.__raw ?? s)); for (const r of rs) rows += r.meta.rows_read ?? 0; return rs; },
  };
  return { db: proxy as unknown as D1Database, rows: () => rows };
}

interface Page { nodes: Record<string, { innerHTML: string; textContent: string }>; asked: string[] }

/** The served page for `path`, run as `as` would see it: every read the script makes answered by the Worker with that viewer's cookie, until You and the stages are drawn. */
async function view(path: string, as: Who): Promise<Page> {
  const page = await call("GET", path, as);
  expect(page.status).toBe(200);
  const asked: string[] = [];
  const url = new URL(`http://pool.test${path}`);
  const ran = runScript(scriptOf(page.text), {
    pathname: url.pathname,
    search: url.search,
    functions: [],
    fetch: async (p: string) => {
      asked.push(p);
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`http://pool.test${p}`, { headers: as ? { cookie: `omc=oms_${as}` } : {} }), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    },
  });
  const nodes = ran.nodes as Page["nodes"];
  for (let i = 0; i < 200; i++) {
    if (nodes["#you"]?.innerHTML && nodes["#stages"]?.innerHTML && asked.includes("/auth/me") && (!as || (nodes["#you-who"]?.textContent ?? "").startsWith("@"))) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return { nodes, asked };
}

describe("the package page, drawn for every viewer", () => {
  it("shows a visitor everything and asks them to sign in; a synced package's page asks for no story", async () => {
    const p = await view(`/package/${F.pkg}?ring=stable&arch=${F.arch}`, "");
    expect(p.nodes["#you-who"].textContent).toBe("not signed in");
    expect(p.nodes["#you"].innerHTML).toContain("Sign in with GitHub");
    expect(p.nodes["#you"].innerHTML).toContain('href="/auth/github?next=/package/zlib%3Fring%3Dstable%26arch%3Dx86_64"');
    // The four stages of a synced package: the review is not needed, and says so.
    for (const s of ["Upstream", "Build", "Review", "Rings", "not needed · mirrored"]) expect(p.nodes["#stages"].innerHTML).toContain(s);
    expect(p.nodes["#pkg-state"].innerHTML).toContain("in rings");
    expect(p.nodes["#pkg-chips"].innerHTML).toContain("synced · Arch core");
    // One read for the page: the package; a synced one has no story, and the page does not ask.
    expect(p.asked.filter((a) => a.includes("/story"))).toEqual([]);
    expect(p.asked.filter((a) => a.startsWith("/api/v1/package/"))).toEqual([`/api/v1/package/${F.pkg}?ring=stable&arch=${F.arch}`]);
  });

  it("offers a contributor a report, never a maintainer's act", async () => {
    const p = await view(`/package/${F.pkg}`, "bob");
    expect(p.nodes["#you-who"].textContent).toBe("@bob · contributor");
    expect(p.nodes["#you"].innerHTML).toContain("Report a problem");
    for (const act of ['data-act="block"', 'data-act="adopt"', 'data-act="unblock"']) expect(p.nodes["#you"].innerHTML).not.toContain(act);
  });

  it("gives a maintainer Adopt on a synced package nobody looks after, and Block grey with why: the brake is the factory's", async () => {
    const p = await view(`/package/${F.pkg}`, "m1");
    const you = p.nodes["#you"].innerHTML;
    expect(p.nodes["#you-who"].textContent).toBe("@m1 · maintainer");
    expect(you).toContain("No pool maintainer yet.");
    expect(you).toMatch(/<button type="button" data-act="adopt" class="op-btn primary">Adopt<\/button>/);
    expect(you).toMatch(/<button type="button" data-act="block" class="op-btn danger" disabled aria-disabled="true" title="a synced package is served as its source publishes it; the brake blocks what the factory built">Block<\/button>/);
  });

  it("gives a maintainer Block on a factory package another maintainer looks after, and says whose it is", async () => {
    const p = await view(`/package/${F.publishedPkg}?ring=edge&arch=${F.arch}`, "m1");
    expect(p.nodes["#you"].innerHTML).toContain("Maintained by m2.");
    expect(p.nodes["#you"].innerHTML).toMatch(/<button type="button" data-act="block" class="op-btn danger">Block<\/button>/);
    // A factory package's four stages; its story was read.
    for (const s of ["Request", "Factory build", "Review", "Rings"]) expect(p.nodes["#stages"].innerHTML).toContain(s);
    expect(p.asked).toContain(`/api/v1/factory/packages/${F.publishedPkg}/story`);
    expect(p.nodes["#pkg-chips"].innerHTML).toContain("factory · only in the pool");
    expect(p.nodes["#pkg-chips"].innerHTML).toContain('<span class="pill tgt ok"');
  });

  it("tells the contributor who requested it how to ask for an update, and that they never review it", async () => {
    const p = await view(`/package/${F.factoryPkg}`, "alice");
    const you = p.nodes["#you"].innerHTML;
    expect(p.nodes["#you-who"].textContent).toBe("@alice · requester");
    expect(you).toContain("You requested this package.");
    // mine is approved: its next version is a bump, so the renewal is grey with the reason.
    expect(you).toContain('<a data-href="/request?renew=mine" class="disabled op-btn primary" tabindex="-1" aria-disabled="true" title="approved: a new upstream release is built as a bump, by itself">Request an update</a>');
    expect(you).toContain(`<a href="/user/alice" class="op-btn">Your requests</a>`);
    expect(you).toContain("You can't review your own request.");
    expect(you).not.toContain('data-act="adopt"');
  });

  it("lets another maintainer lift a block, and the one who made it only read why not", async () => {
    const own = await view(`/package/${F.blockedPkg}`, "m1");
    expect(own.nodes["#pkg-state"].innerHTML).toContain("blocked");
    expect(own.nodes["#pkg-blocked"].innerHTML).toContain("Blocked by m1");
    expect(own.nodes["#you"].innerHTML).toContain("You blocked it. Another maintainer lifts the block.");
    expect(own.nodes["#you"].innerHTML).toContain(`title="m1 blocked ${F.blockedPkg}; another maintainer lifts it"`);
    const other = await view(`/package/${F.blockedPkg}`, "m2");
    expect(other.nodes["#you"].innerHTML).toMatch(/<button type="button" data-act="unblock" class="op-btn primary">Lift the block<\/button>/);
  });
});

describe("what the page reads", () => {
  it("says where each architecture of a package is served, and a name this architecture lacks says where the others are", async () => {
    // zlib on aarch64 too, in stable: an object of its own.
    const id = (await env.DB.prepare(
      `INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch)
       VALUES ('arm-zlib-sha', 'zlib', '1:1.3.2-3', 'aarch64', 'zlib-1:1.3.2-3-aarch64.pkg.tar.zst', 40, 120, 1, '{"name":"zlib"}', 'core', 'core/aarch64/zlib-1:1.3.2-3-aarch64.pkg.tar.zst', 'aarch64') RETURNING id`,
    ).first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT INTO ring_packages (ring, package_id) VALUES ('stable', ?)").bind(id).run();
    const x = (await call("GET", `/api/v1/package/zlib?ring=stable&arch=x86_64&t=arches`)).json;
    expect(x.arches.x86_64.rings.map((r: { ring: string }) => r.ring)).toEqual(["stable", "edge"]);
    expect(x.arches.x86_64.open).toBe(1);
    expect(x.arches.aarch64).toEqual({ rings: [{ ring: "stable", release_seq: expect.any(Number), version: "1:1.3.2-3", sha256: "arm-zlib-sha", source: "core", has_signature: true, size_download: 40 }], open: 0 });
    expect(x.files).toBe(1);
    // The same package asked on aarch64 is aarch64's object, and knows x86_64's rings.
    const a = (await call("GET", `/api/v1/package/zlib?ring=stable&arch=aarch64&t=arches`)).json;
    expect(a).toMatchObject({ arch: "aarch64", shown_ring: "stable", package: { sha256: "arm-zlib-sha" } });
    expect(a.arches.x86_64.rings.length).toBe(2);
    // xz is not on aarch64: the 404 says where it is.
    const no = await call("GET", `/api/v1/package/xz?ring=stable&arch=aarch64`);
    expect(no.status).toBe(404);
    expect(no.json.arches.x86_64.rings.map((r: { ring: string }) => r.ring)).toContain("stable");
    expect(no.json.arches.aarch64.rings).toEqual([]);
  });

  it("gives each chain the two recipes a review compares, once each build staged one", async () => {
    const shipped = (await call("GET", `/api/v1/factory/packages/${F.publishedPkg}/story?t=recipes`)).json;
    const chain = shipped.chains.find((c: { project: { id: number } | null }) => c.project);
    expect(chain.recipes).toEqual({ contributor: `/api/v1/factory/tasks/${chain.contributor.id}/artifacts/PKGBUILD`, project: `/api/v1/factory/tasks/${chain.project.id}/artifacts/PKGBUILD` });
    for (const u of Object.values(chain.recipes) as string[]) expect((await call("GET", u)).status).toBe(200);
    // mine's newest build is its contributor's, staged, with no project build behind it yet.
    const mine = (await call("GET", `/api/v1/factory/packages/${F.factoryPkg}/story?t=recipes`)).json;
    expect(mine.chains[0].recipes).toEqual({ contributor: `/api/v1/factory/tasks/${F.stagedTask}/artifacts/PKGBUILD`, project: null });
  });

  it("names the worker that built, from the task: the seal no longer walks the journal's build lines for it", async () => {
    const before = (await call("GET", `/api/v1/package/${F.publishedPkg}?ring=edge&arch=${F.arch}&t=seal1`)).json.seal.chain;
    expect(before.builder.worker).toBe(F.worker);
    expect(before.source_build.worker).toBe(F.communityWorker);
    await env.DB.prepare("DELETE FROM events WHERE kind = 'build'").run();
    const after = (await call("GET", `/api/v1/package/${F.publishedPkg}?ring=edge&arch=${F.arch}&t=seal2`)).json.seal.chain;
    expect(after.builder).toEqual(before.builder);
    expect(after.source_build.worker).toBe(F.communityWorker);
  });

  it("reads the rings of a package through its name, whatever the size of the ring", async () => {
    // A thousand packages in rc: the page of one of them reads that one's rows, never the ring's members.
    const pk: string[] = [], rc: string[] = [];
    for (let i = 1; i <= 1000; i++) {
      pk.push(`(${200000 + i}, 'viewsha${i}', 'viewpkg${i}', '1-1', 'x86_64', 'viewpkg${i}-1-1-x86_64.pkg.tar.zst', 100, 100, 1, '{"name":"viewpkg${i}","version":"1-1"}', 'extra', 'extra/x86_64/viewpkg${i}', 'x86_64')`);
      rc.push(`('rc', ${200000 + i})`);
    }
    for (let i = 0; i < pk.length; i += 400) {
      await env.DB.prepare(`INSERT INTO packages (id, sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES ${pk.slice(i, i + 400).join(",")}`).run();
      await env.DB.prepare(`INSERT INTO ring_packages (ring, package_id) VALUES ${rc.slice(i, i + 400).join(",")}`).run();
    }
    await env.DB.prepare("INSERT INTO ring_heads (ring, release_id) SELECT 'rc', id FROM releases ORDER BY id LIMIT 1 ON CONFLICT (ring) DO NOTHING").run();
    for (const name of ["viewpkg500", "no-such-package"]) {
      const { db, rows } = counting(env.DB);
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`http://pool.test/api/v1/package/${name}?ring=rc&arch=x86_64`), { ...env, DB: db }, ctx);
      await waitOnExecutionContext(ctx);
      expect([200, 404]).toContain(res.status);
      // The fixture's other rows and the four heads: a few dozen, never the thousand of the ring.
      expect(rows(), `${name}: rows read`).toBeLessThan(120);
    }
  });
});

describe("Adopt: a package the pool serves gets its maintainer in the pool", () => {
  it("is a maintainer's: nobody signed in, a contributor and the one who requested it are refused", async () => {
    expect((await call("POST", `/api/v1/factory/packages/${F.pkg}/adopt`, "", {})).status).toBe(401);
    const bob = await call("POST", `/api/v1/factory/packages/${F.pkg}/adopt`, "bob", {});
    expect(bob).toMatchObject({ status: 403, json: { error: "a maintainer adopts a package" } });
    // alice as a maintainer, on her own request: never her own.
    await env.DB.prepare("UPDATE contributors SET role = 'maintainer' WHERE login = 'alice'").run();
    const own = await call("POST", `/api/v1/factory/packages/${F.publishedPkg}/adopt`, "alice", {});
    await env.DB.prepare("UPDATE contributors SET role = 'contributor' WHERE login = 'alice'").run();
    expect(own).toMatchObject({ status: 403, json: { error: `alice requested ${F.publishedPkg}; another maintainer looks after it` } });
  });

  it("is refused for a package no ring serves, and for one that has its maintainer", async () => {
    expect((await call("POST", `/api/v1/factory/packages/${F.factoryPkg}/adopt`, "m1", {})).status).toBe(404);
    expect((await call("POST", "/api/v1/factory/packages/not-a-package/adopt", "m1", {})).status).toBe(404);
    const ours = await call("POST", `/api/v1/factory/packages/${F.publishedPkg}/adopt`, "m1", {});
    expect(ours).toMatchObject({ status: 409, json: { error: `${F.publishedPkg} is maintained by ${F.m2}, whose approval it is served under` } });
    // ours says so on its page: the approval that stands is its maintainer.
    expect((await call("GET", `/api/v1/package/${F.publishedPkg}?ring=edge&arch=${F.arch}&t=m`)).json.maintenance.maintainer).toMatchObject({ login: F.m2, adopted: false });
  });

  it("takes a synced package for the maintainer who adopts it, once, on the journal", async () => {
    const before = (await call("GET", `/api/v1/package/${F.pkg}?ring=stable&arch=${F.arch}&t=a0`)).json;
    expect(before.maintenance).toMatchObject({ packager: "A Packager <packager@example.org>", maintainer: null });
    const took = await call("POST", `/api/v1/factory/packages/${F.pkg}/adopt`, "m1", {});
    expect(took).toMatchObject({ status: 200, json: { adopted: F.pkg, by: F.m1 } });
    const line = await env.DB.prepare("SELECT kind, source, status, summary, payload FROM events WHERE kind = 'adopt' ORDER BY id DESC LIMIT 1").first<{ kind: string; source: string; status: string; summary: string; payload: string }>();
    expect(line).toMatchObject({ kind: "adopt", source: "core", status: "ok", summary: `${F.pkg} adopted by ${F.m1}: its maintainer in the pool` });
    expect(JSON.parse(line!.payload)).toEqual({ name: F.pkg, by: F.m1, source: "core" });
    expect((await call("GET", `/api/v1/package/${F.pkg}?ring=stable&arch=${F.arch}&t=a1`)).json.maintenance.maintainer).toMatchObject({ login: F.m1, adopted: true });
    // Once: another maintainer is told whose it is.
    const again = await call("POST", `/api/v1/factory/packages/${F.pkg}/adopt`, "m2", {});
    expect(again.status).toBe(409);
    expect(again.json.error).toMatch(new RegExp(`^${F.pkg} is maintained by ${F.m1} \\(since `));
  });

  it("is one statement: two maintainers at once, one takes it and the other is told", async () => {
    const both = await Promise.all([call("POST", `/api/v1/factory/packages/${F.pkg2}/adopt`, "m1", {}), call("POST", `/api/v1/factory/packages/${F.pkg2}/adopt`, "m2", {})]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM package_maintainers WHERE name = ?").bind(F.pkg2).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'adopt' AND json_extract(payload, '$.name') = ?").bind(F.pkg2).first<{ n: number }>())!.n).toBe(1);
  });
});
