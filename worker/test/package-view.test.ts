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
import { declared, runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";
import { decider } from "./decide";

let F: Fixture;
type Who = "" | "bob" | "alice" | "carol" | "m1" | "m2";

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

interface Page { nodes: Record<string, { innerHTML: string; textContent: string; hidden: boolean; onclick?: () => void }>; asked: string[]; fn: Record<string, (...a: any[]) => any> }

interface Seen {
  /** The script's own functions, handed back to press what a reader presses. */
  functions?: string[];
  /** The script's variables, each settable through set<Name> (runScript's). */
  variables?: string[];
  /** An address rewritten before it is asked (a query of its own, past the edge cache): a read that must not be the one an earlier view kept. */
  fresh?: (p: string) => string;
  /** An answer changed before the script reads it: an older Worker's, or one that never comes. */
  edit?: (p: string, res: Response) => Promise<Response>;
}

/**
 * The served page for `path`, run as `as` would see it: every request the script makes — a GET, or an act's POST with
 * its body — answered by the Worker with that viewer's cookie, until You and the stages are drawn.
 */
async function view(path: string, as: Who, o: Seen = {}): Promise<Page> {
  const page = await call("GET", path, as);
  expect(page.status).toBe(200);
  const asked: string[] = [];
  const url = new URL(`http://pool.test${path}`);
  const ran = runScript(scriptOf(page.text), {
    pathname: url.pathname,
    search: url.search,
    functions: o.functions ?? [],
    variables: o.variables,
    fetch: async (p: string, init?: RequestInit) => {
      asked.push(init?.method && init.method !== "GET" ? `${init.method} ${p}` : p);
      const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}), ...(as ? { cookie: `omc=oms_${as}` } : {}) };
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`http://pool.test${o.fresh ? o.fresh(p) : p}`, { method: init?.method ?? "GET", headers, body: init?.body }), env, ctx);
      await waitOnExecutionContext(ctx);
      return o.edit ? o.edit(p, res) : res;
    },
  });
  const nodes = ran.nodes as Page["nodes"];
  await until(() => !!(nodes["#you"]?.innerHTML && nodes["#stages"]?.innerHTML && asked.includes("/auth/me") && (!as || (nodes["#you-who"]?.textContent ?? "").startsWith("@"))));
  return { nodes, asked, fn: ran as unknown as Page["fn"] };
}

/** Waits (a second at most) for what a page draws after an answer lands. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
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
    // A login is written one way on the page: @login, linked to the person's page.
    expect(p.nodes["#you"].innerHTML).toContain('Maintained by <a href="/user/m2" data-who="m2" title="m2">@m2</a>.');
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
    expect(you).toContain('<a data-href="/factory?renew=mine#request" class="disabled op-btn primary" tabindex="-1" aria-disabled="true" title="approved: a new upstream release is built as a bump, by itself">Request an update</a>');
    expect(you).toContain(`<a href="/user/alice" class="op-btn">Your requests</a>`);
    expect(you).toContain("You can't review your own request.");
    expect(you).not.toContain('data-act="adopt"');
  });

  it("lets another maintainer lift a block, and the one who made it only read why not", async () => {
    const own = await view(`/package/${F.blockedPkg}`, "m1");
    expect(own.nodes["#pkg-state"].innerHTML).toContain("blocked");
    expect(own.nodes["#pkg-blocked"].innerHTML).toContain('Blocked by <a href="/user/m1" data-who="m1" title="m1">@m1</a>');
    expect(own.nodes["#you"].innerHTML).toContain("You blocked it. Another maintainer lifts the block.");
    expect(own.nodes["#you"].innerHTML).toContain(`title="m1 blocked ${F.blockedPkg}; another maintainer lifts it"`);
    const other = await view(`/package/${F.blockedPkg}`, "m2");
    expect(other.nodes["#you"].innerHTML).toMatch(/<button type="button" data-act="unblock" class="op-btn primary">Lift the block<\/button>/);
  });

  it("gives the contributor who requested a blocked package the renewal grey, the block its reason: the server refuses it first", async () => {
    const p = await view(`/package/${F.blockedPkg}`, "carol");
    expect(p.nodes["#you-who"].textContent).toBe("@carol · requester");
    expect(p.nodes["#you"].innerHTML).toContain(`<a data-href="/factory?renew=${F.blockedPkg}#request" class="disabled op-btn primary" tabindex="-1" aria-disabled="true" title="blocked: another maintainer lifts the block first">Request an update</a>`);
  });

  it("draws a name no ring serves and nobody requested as not in the pool — never as a mirror the pool verified", async () => {
    const p = await view("/package/zzfoo", "");
    expect(p.nodes["#pkg-state"].innerHTML).toContain("not in the pool");
    expect(p.nodes["#chain-note"].textContent).toBe("not in the pool · nobody requested it");
    const stages = p.nodes["#stages"].innerHTML;
    expect(stages).toContain("nobody requested it");
    for (const claim of ["verified here", "mirrored", 'class="pkg-stage ok']) expect(stages).not.toContain(claim);
    expect(p.nodes["#who"].innerHTML).not.toContain("mirrored by");
    expect(p.nodes["#seal"].innerHTML).not.toContain("Mirrored as-is");
    expect(p.nodes["#install-b"].innerHTML).toContain('href="/factory?name=zzfoo#request"');
    expect(p.nodes["#you"].innerHTML).toContain('<a href="/factory?name=zzfoo#request" class="op-btn primary">Request zzfoo</a>');
  });

  it("opens an address that names no architecture on the one that serves the package, and says the rest where it does not", async () => {
    const id = (await env.DB.prepare(
      `INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch)
       VALUES ('armonly-sha', 'armonly', '1.0-1', 'aarch64', 'armonly-1.0-1-aarch64.pkg.tar.zst', 40, 120, 1, '{"name":"armonly"}', 'core', 'core/aarch64/armonly-1.0-1-aarch64.pkg.tar.zst', 'aarch64') RETURNING id`,
    ).first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT INTO ring_packages (ring, package_id) VALUES ('stable', ?)").bind(id).run();
    // No architecture in the address: x86_64 has none, aarch64 is read and drawn — a synced package, so no story is asked.
    const plain = await view("/package/armonly", "");
    expect(plain.asked.filter((a) => a.startsWith("/api/v1/"))).toEqual(["/api/v1/package/armonly?ring=stable&arch=x86_64", "/api/v1/package/armonly?ring=stable&arch=aarch64"]);
    expect(plain.nodes["#pkg-chips"].innerHTML).toContain("synced · Arch Linux ARM core");
    expect(plain.nodes["#install-b"].innerHTML).toContain("sudo pacman -S armonly");
    // x86_64 asked for: nothing there, and the page says what it knows of the package anyway — where it comes from, who looks after it (nobody: Adopt), where to install it.
    const x86 = await view("/package/armonly?arch=x86_64", "m1");
    expect(x86.asked.filter((a) => a.startsWith("/api/v1/"))).toEqual(["/api/v1/package/armonly?ring=stable&arch=x86_64"]);
    expect(x86.nodes["#pkg-chips"].innerHTML).toContain("synced · Arch Linux ARM core");
    expect(x86.nodes["#install-b"].innerHTML).toContain('Not served on x86_64. <a href="/package/armonly?ring=stable&arch=aarch64">Open it on aarch64 →</a>');
    expect(x86.nodes["#who"].innerHTML).toContain("none yet");
    expect(x86.nodes["#you"].innerHTML).toContain('data-act="adopt"');
    expect(x86.nodes["#seal"].innerHTML).toContain("aarch64: no advisory open on it");
  });

  it("draws a package from an answer an older Worker cached — no `arches`, no `files` — as served where its rings say", async () => {
    const older = async (p: string, res: Response) => {
      if (!p.startsWith(`/api/v1/package/${F.pkg}?`)) return res;
      const d = (await res.json()) as Record<string, unknown>;
      delete d.arches; delete d.files;
      return new Response(JSON.stringify(d), { status: res.status, headers: { "content-type": "application/json" } });
    };
    const p = await view(`/package/${F.pkg}?ring=stable&arch=${F.arch}`, "", { edit: older });
    expect(p.nodes["#install-b"].innerHTML).toContain(`sudo pacman -S ${F.pkg}`);
    expect(p.nodes["#pkg-chips"].innerHTML).toContain(`${F.arch} ✓`);
    expect(p.nodes["#stages"].innerHTML).toContain(`${F.arch}: served`);
    // The seal reads the same as from today's answer: the object's own signature, the advisory open on it.
    expect(p.nodes["#seal"].innerHTML).toBe((await view(`/package/${F.pkg}?ring=stable&arch=${F.arch}`, "")).nodes["#seal"].innerHTML);
    expect(p.nodes["#seal"].innerHTML).toContain(`${F.arch}: 1 open advisory`);
  });

  it("draws what a factory package's answer holds before its story lands, and the rest after", async () => {
    let land: () => void = () => {};
    const later = (p: string, res: Response) => (p.endsWith("/story") ? new Promise<Response>((r) => { land = () => r(res); }) : Promise.resolve(res));
    const p = await view(`/package/${F.publishedPkg}?ring=edge&arch=${F.arch}`, "", { edit: later });
    // The story is asked, not answered: the tiles and the graph are drawn from the package's answer, the stages wait for it.
    expect(p.asked).toContain(`/api/v1/factory/packages/${F.publishedPkg}/story`);
    expect(p.nodes["#pg-tiles"].innerHTML).toContain("2.0-1");
    expect(p.nodes["#deps"].innerHTML).toContain("pkg-graph");
    expect(p.nodes["#stages"]?.innerHTML ?? "").toBe("");
    land();
    await until(() => !!p.nodes["#stages"]?.innerHTML);
    expect(p.nodes["#stages"].innerHTML).toContain("Factory build");
  });

  it("keeps the brake's reason across a redraw, says a refusal aloud, and closes on Escape", async () => {
    const p = await view(`/package/${F.publishedPkg}?ring=edge&arch=${F.arch}`, "m1", { functions: ["renderYou"], variables: ["ASK"] });
    p.fn.setASK("block");
    p.fn.renderYou();
    expect(p.nodes["#you"].innerHTML).toContain('<p class="err" id="you-err" role="alert" hidden></p>');
    const why = p.nodes["#you-why"] as unknown as { value: string; oninput: () => void };
    why.value = "the source moved";
    why.oninput();
    p.fn.renderYou();
    expect(p.nodes["#you"].innerHTML).toContain('value="the source moved"');
    (p.nodes["#you-ask"] as unknown as { onkeydown: (e: unknown) => void }).onkeydown({ key: "Escape", preventDefault() {} });
    expect(p.nodes["#you"].innerHTML).not.toContain('id="you-ask"');
  });

  it("links every package on the page in the ring it shows, not the one the address asked", async () => {
    const p = await view(`/package/${F.pkg}?ring=lab&arch=${F.arch}`, "");
    expect(p.nodes["#deps"].innerHTML).toContain(`href="/package/${F.pkg2}?ring=stable&arch=${F.arch}"`);
    expect(p.nodes["#deps"].innerHTML).not.toContain("ring=lab");
  });

  it("reads the two recipes of a review only when a reader asks to compare them", async () => {
    // mine with its target on the approved project build: the page opens on the review, whose two recipes are both staged — and reads neither by itself.
    const was = (await env.DB.prepare("SELECT targets FROM factory_packages WHERE name = ?").bind(F.factoryPkg).first<{ targets: string }>())!.targets;
    await env.DB.prepare("UPDATE factory_packages SET targets = ? WHERE name = ?").bind(JSON.stringify({ [F.arch]: { status: "approved", task: F.projectTask } }), F.factoryPkg).run();
    const opened = await view(`/package/${F.factoryPkg}`, "", { fresh: (a) => (a.includes("/story") ? `${a}?t=recipes` : a) });
    await env.DB.prepare("UPDATE factory_packages SET targets = ? WHERE name = ?").bind(was, F.factoryPkg).run();
    expect(opened.nodes["#stage-panel"].innerHTML).toContain('data-recipes>Compare the two recipes</button>');
    expect(opened.asked.filter((a) => a.includes("/artifacts/"))).toEqual([]);
    const p = await view(`/package/${F.publishedPkg}?ring=edge&arch=${F.arch}`, "", { functions: ["loadRecipes"] });
    p.fn.loadRecipes();
    await until(() => p.asked.filter((a) => a.includes("/artifacts/PKGBUILD")).length === 2);
    expect(p.asked.filter((a) => a.includes("/artifacts/PKGBUILD"))).toHaveLength(2);
  });

  it("draws a long file list's first 400 paths and the rest as one block on demand, never an element per file", async () => {
    const files = Array.from({ length: 450 }, (_, i) => `usr/share/big/file-${i}`);
    const id = (await env.DB.prepare(
      `INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch)
       VALUES ('bigfiles-sha', 'bigfiles', '1-1', ?, 'bigfiles-1-1-x86_64.pkg.tar.zst', 40, 120, 1, ?, 'extra', 'extra/x86_64/bigfiles-1-1-x86_64.pkg.tar.zst', ?) RETURNING id`,
    ).bind(F.arch, JSON.stringify({ name: "bigfiles", files }), F.arch).first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT INTO ring_packages (ring, package_id) VALUES ('stable', ?)").bind(id).run();
    const p = await view(`/package/bigfiles?ring=stable&arch=${F.arch}`, "");
    p.nodes["#files"].hidden = true;
    p.nodes["#load-files"].onclick!();
    await until(() => p.nodes["#files"].innerHTML.includes("data-all-files"));
    expect(p.nodes["#files"].innerHTML.match(/<span title="/g)).toHaveLength(400);
    expect(p.nodes["#files"].innerHTML).toContain("Show all 450 files");
  });

  it("says a package built and waiting for a claim is ready for review, and in review only once claimed: the Factory's and Review's words (#274)", async () => {
    // spare is built and nobody claimed it: Review files it ready, the Factory's line Ready for review — the chip said "in review" until #274.
    expect((await call("GET", "/api/v1/factory/review")).json.packages.find((x: { name: string }) => x.name === F.sparePkg)?.state).toBe("ready");
    const p = await view(`/package/${F.sparePkg}`, "m1", { fresh: (a) => (a.includes("/story") ? `${a}?t=ready` : a) });
    expect(p.nodes["#pkg-state"].innerHTML).toBe('<span class="op-pill warn">ready for review</span>');
    expect(p.nodes["#you"].innerHTML).toContain("Ready for a maintainer: have the project build it again, then decide.");
    // Claimed, the project builds it again: in review on every page, until the claim is let go.
    const claimed = await call("POST", `/api/v1/factory/tasks/${F.spareTask}/build`, "m1", { note: "claimed by the package page's test" });
    expect(claimed.status).toBe(200);
    try {
      expect((await call("GET", "/api/v1/factory/review")).json.packages.find((x: { name: string }) => x.name === F.sparePkg)?.state).toBe("in_review");
      const q = await view(`/package/${F.sparePkg}`, "m1", { fresh: (a) => (a.includes("/story") ? `${a}?t=claimed` : a) });
      expect(q.nodes["#pkg-state"].innerHTML).toBe('<span class="op-pill warn">in review</span>');
      expect(q.nodes["#you"].innerHTML).toContain("The project builds it again; the decision follows.");
    } finally {
      expect((await call("POST", `/api/v1/factory/tasks/${F.spareTask}/release`, "m1", { reason: "let go by the package page's test" })).status).toBe(200);
    }
  });

  it("says a rejected package is rejected — not waiting for a worker, nor installable after an approval", async () => {
    expect((await call("POST", `/api/v1/factory/tasks/${F.spareTask}/reject`, "m1", { note: "the recipe fetches outside its sources" })).status).toBe(200);
    const p = await view(`/package/${F.sparePkg}`, "m1", { fresh: (a) => (a.includes("/story") ? `${a}?t=rejected` : a) });
    expect(p.nodes["#pkg-state"].innerHTML).toContain("rejected");
    expect(p.nodes["#stages"].innerHTML).toContain("rejected · back with its requester");
    expect(p.nodes["#stages"].innerHTML).toContain("none · rejected");
    expect(p.nodes["#stages"].innerHTML).not.toContain("waiting for a worker");
    expect(p.nodes["#install-b"].innerHTML).toContain("Rejected: not installable. Its requester can send it again.");
    expect(p.nodes["#you"].innerHTML).toContain('Rejected by <a href="/user/m1"');
  });

  it("keeps the approval that stands and its publish on the page while a newer build of the package waits for a maintainer", async () => {
    const p = await view(`/package/${F.factoryPkg}`, "", { functions: ["timeline"] });
    // The newer build is the review's (ready for review, waiting for a maintainer's claim); m2's approval of 1.0 is what the rings will serve, its publish on its way.
    expect(p.nodes["#pkg-state"].innerHTML).toContain("ready for review");
    expect(p.nodes["#stages"].innerHTML).toContain("publishing into edge");
    expect(p.nodes["#stage-panel"].innerHTML).toContain('stays approved by <a href="/user/m2"');
    expect(p.nodes["#who"].innerHTML).toMatch(/reviewed by<\/span><span class="l"><a href="\/user\/m2"[^>]*>@m2<\/a>/);
    const record = (p.fn.timeline() as string[][]).map((e) => `${e[2]} ${e[3]}`);
    expect(record).toContain(`approved by @m2 · 1.0 · ${F.arch}`);
    expect(record.some((e) => e.startsWith("publishing publish job #"))).toBe(true);
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
    // xz is not on aarch64: the 404 says where it is, whether an advisory is open on the object x86_64 serves, and who looks after it — what the page says of xz on any architecture.
    const no = await call("GET", `/api/v1/package/xz?ring=stable&arch=aarch64`);
    expect(no.status).toBe(404);
    expect(no.json.arches.x86_64.rings.map((r: { ring: string }) => r.ring)).toContain("stable");
    expect(no.json.arches.x86_64.open).toBe(0);
    expect(no.json.arches.aarch64).toEqual({ rings: [], open: null });
    expect(no.json.maintenance).toMatchObject({ maintainer: null });
    // A name no ring serves anywhere reads nothing more.
    expect((await call("GET", "/api/v1/package/no-such-name?ring=stable&arch=aarch64")).json).toEqual({ error: "no-such-name is not in any ring for aarch64", arches: { x86_64: { rings: [], open: null }, aarch64: { rings: [], open: null } } });
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
    // viewpkg500 on aarch64: the 404 of an architecture that does not serve it, with its open count and its maintainer — a few point reads more.
    for (const [name, arch] of [["viewpkg500", "x86_64"], ["no-such-package", "x86_64"], ["viewpkg500", "aarch64"]]) {
      const { db, rows } = counting(env.DB);
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`http://pool.test/api/v1/package/${name}?ring=rc&arch=${arch}`), { ...env, DB: db }, ctx);
      await waitOnExecutionContext(ctx);
      expect([200, 404]).toContain(res.status);
      // The fixture's other rows and the four heads: a few dozen, never the thousand of the ring.
      expect(rows(), `${name} on ${arch}: rows read`).toBeLessThan(120);
    }
  });
});

describe("Adopt: a package the pool serves gets its maintainer in the pool", () => {
  it("pressed on a synced package's page, names its maintainer and leaves it the synced package it was", async () => {
    const p = await view(`/package/zstd?ring=stable&arch=${F.arch}`, "m2", { functions: ["act"] });
    expect(p.nodes["#you"].innerHTML).toContain('data-act="adopt"');
    p.fn.act("adopt", "");
    await until(() => p.nodes["#you"].innerHTML.includes("You maintain this package."));
    expect(p.asked).toContain("POST /api/v1/factory/packages/zstd/adopt");
    expect(p.nodes["#you"].innerHTML).toContain("You maintain this package.");
    // Synced still: its origin, its four stages, its seal's last gate, its people — nothing of the factory's.
    expect(p.nodes["#pkg-chips"].innerHTML).toContain("synced · Arch core");
    expect(p.nodes["#pkg-chips"].innerHTML).not.toContain("factory");
    expect(p.nodes["#stages"].innerHTML).toContain("Upstream");
    expect(p.nodes["#stages"].innerHTML).not.toContain("Factory build");
    expect(p.nodes["#seal"].innerHTML).toContain("Mirrored as-is");
    expect(p.nodes["#who"].innerHTML).toContain("pool maintainer");
    expect(p.nodes["#who"].innerHTML).toContain("@m2</a>");
    expect(p.asked.filter((a) => a.includes("/story"))).toEqual([]);
  });

  it("is a maintainer's: nobody signed in, a contributor and the one who requested it are refused", async () => {
    expect((await call("POST", `/api/v1/factory/packages/${F.pkg}/adopt`, "", {})).status).toBe(401);
    const bob = await call("POST", `/api/v1/factory/packages/${F.pkg}/adopt`, "bob", {});
    expect(bob).toMatchObject({ status: 403, json: { error: "a maintainer adopts a package", code: "maintainer_only" } });
    // alice as a maintainer, on her own request: never her own.
    await env.DB.prepare("UPDATE contributors SET role = 'maintainer' WHERE login = 'alice'").run();
    const own = await call("POST", `/api/v1/factory/packages/${F.publishedPkg}/adopt`, "alice", {});
    await env.DB.prepare("UPDATE contributors SET role = 'contributor' WHERE login = 'alice'").run();
    expect(own).toMatchObject({ status: 403, json: { error: `alice requested ${F.publishedPkg}; another maintainer looks after it`, code: "conflict_of_interest" } });
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
    // One door for both (#247): the line says it took the maintainer of record alone — no registration — and through which door.
    expect(JSON.parse(line!.payload)).toEqual({ name: F.pkg, by: F.m1, source: "core", via: "web", registration: null });
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
  it("pressed on a registration its owner left unmaintained, takes the registration with it: the one door Review's No maintainer tab posts to", async () => {
    // ours, left unmaintained the way updates.ts leaves a package: edge still serves m2's approved build, and nobody builds its bumps — nobody looks after it.
    // alice's build stays staged, the evidence the approved rebuild answered: it has served, and an adoption does not wait for it.
    const before = await env.DB.prepare("SELECT owner, status, detail, updated_at FROM factory_packages WHERE name = ?").bind(F.publishedPkg).first<{ owner: string; status: string; detail: string | null; updated_at: string }>();
    await env.DB.prepare("UPDATE factory_packages SET status = 'unmaintained' WHERE name = ?").bind(F.publishedPkg).run();
    try {
      const fresh = (p: string) => (p.startsWith("/api/v1/package/") || p.includes("/story") ? `${p}${p.includes("?") ? "&" : "?"}t=unmaintained` : p);
      expect((await call("GET", `/api/v1/package/${F.publishedPkg}?ring=edge&arch=${F.arch}&t=left`)).json.maintenance.maintainer).toBeNull();
      const p = await view(`/package/${F.publishedPkg}?ring=edge&arch=${F.arch}`, "m1", { functions: ["act"], fresh });
      expect(p.nodes["#you"].innerHTML).toContain("Left unmaintained by");
      expect(p.nodes["#you"].innerHTML).toContain('data-act="adopt"');
      p.fn.act("adopt", "");
      await until(() => p.nodes["#you"].innerHTML.includes("You adopted this package"));
      expect(p.asked).toContain(`POST /api/v1/factory/packages/${F.publishedPkg}/adopt`);
      expect(p.nodes["#you"].innerHTML).toContain("You adopted this package: its registration is yours, and its bumps come to your workers.");
      expect(p.nodes["#you-who"].textContent).toBe("@m1 · maintainer");
      // Its maintainer, adopted — and nobody named as having requested it who did not.
      expect(p.nodes["#who"].innerHTML).toContain("@m1</a>");
      expect(p.nodes["#who"].innerHTML).not.toContain("requested by");
      // The server says the same: the registration m1's, where it stood before — published — and m1 its maintainer in the pool, on the page's data.
      expect(await env.DB.prepare("SELECT owner, status FROM factory_packages WHERE name = ?").bind(F.publishedPkg).first()).toEqual({ owner: F.m1, status: "published" });
      expect((await call("GET", `/api/v1/package/${F.publishedPkg}?ring=edge&arch=${F.arch}&t=took`)).json.maintenance.maintainer).toMatchObject({ login: F.m1, adopted: true });
      const line = await env.DB.prepare("SELECT summary, payload FROM events WHERE kind = 'adopt' ORDER BY id DESC LIMIT 1").first<{ summary: string; payload: string }>();
      expect(line!.summary).toBe(`${F.publishedPkg} adopted by ${F.m1}: its maintainer in the pool, and its registration, taken from ${F.owner}, who left it unmaintained`);
      expect(JSON.parse(line!.payload)).toMatchObject({ name: F.publishedPkg, by: F.m1, source: "factory", via: "web", registration: { from: F.owner, status: "published" } });
    } finally {
      await env.DB.batch([
        env.DB.prepare("UPDATE factory_packages SET owner = ?, status = ?, detail = ?, updated_at = ? WHERE name = ?").bind(before!.owner, before!.status, before!.detail, before!.updated_at, F.publishedPkg),
        env.DB.prepare("DELETE FROM package_maintainers WHERE name = ?").bind(F.publishedPkg),
      ]);
    }
  });
});

describe("the page draws a factory package from its freshest word", () => {
  it("draws the seal and the people from the approval the rings serve while a newer build of it is in the factory", async () => {
    // A bump of ours queued: its target names the new build, the rings still serve m2's approved 2.0-1.
    const bump = (await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status) VALUES ('ours', ?, '2.1', 'bump:1@2.1', 'bump', 100, 0, 'community', 'alice', 'build', 'queued') RETURNING id`,
    ).bind(F.arch).first<{ id: number }>())!.id;
    await env.DB.prepare("UPDATE factory_packages SET targets = ? WHERE name = 'ours'").bind(JSON.stringify({ [F.arch]: { status: "building", task: bump } })).run();
    const p = await view(`/package/${F.publishedPkg}?ring=edge&arch=${F.arch}`, "", { functions: ["gateCells"], fresh: (a) => (a.includes("/story") ? `${a}?t=bump` : a) });
    expect(p.nodes["#stages"].innerHTML).toContain(`${F.arch} · try 1`);
    expect(p.nodes["#stages"].innerHTML).toContain("@m2 · approved");
    const gates = p.fn.gateCells(F.arch) as string[][];
    expect(gates[1]).toEqual(["ok", "a real pacman installed it in the lab"]);
    expect(gates[5]).toEqual(["ok", `brought by ${F.owner}, rebuilt and approved by ${F.m2}`]);
    expect(p.nodes["#who"].innerHTML).toMatch(/reviewed by<\/span><span class="l"><a href="\/user\/m2"[^>]*>@m2<\/a>/);
  });

  it("takes a package out of the rings as the story says, however long the package's answer is kept, and after a lift pressed on the page", async () => {
    const pkgPath = `/api/v1/package/${F.publishedPkg}?ring=edge&arch=${F.arch}`;
    expect((await call("GET", pkgPath)).json.arches[F.arch].rings.map((r: { ring: string }) => r.ring)).toEqual(["edge"]);
    expect((await decider(env).decide("m1", `/api/v1/factory/packages/${F.publishedPkg}/block`, { reason: "the test of a stale answer" })).status).toBe(200);
    // The package's answer is still the one kept at the edge (in edge); the story is fresh: blocked, in no ring.
    expect((await call("GET", pkgPath)).json.arches[F.arch].rings).toHaveLength(1);
    const blocked = await view(`/package/${F.publishedPkg}?ring=edge&arch=${F.arch}`, "m2", { functions: ["act"], fresh: (a) => (a.includes("/story") ? `${a}?t=blocked` : a) });
    expect(blocked.nodes["#pkg-state"].innerHTML).toContain("blocked");
    expect(blocked.nodes["#install-b"].innerHTML).not.toContain("sudo pacman -S");
    // m2 lifts it from the page: back in the factory, in no ring — no install, no "in rings", no maintainer's "You maintain it".
    blocked.fn.act("unblock", "the reason is answered");
    await until(() => blocked.asked.includes(`POST /api/v1/factory/packages/${F.publishedPkg}/unblock`) && !blocked.nodes["#pkg-state"].innerHTML.includes("blocked"));
    expect(blocked.nodes["#pkg-state"].innerHTML).not.toContain("in rings");
    expect(blocked.nodes["#install-b"].innerHTML).not.toContain("sudo pacman -S");
    expect(blocked.nodes["#you"].innerHTML).not.toContain("You maintain this package.");
    // A fresh load while the old answer is still kept: the story's word wins.
    const lifted = await view(`/package/${F.publishedPkg}?ring=edge&arch=${F.arch}`, "m1", { fresh: (a) => (a.includes("/story") ? `${a}?t=lifted` : a) });
    expect(lifted.nodes["#pkg-state"].innerHTML).not.toContain("in rings");
    expect(lifted.nodes["#install-b"].innerHTML).not.toContain("sudo pacman -S");
    expect(lifted.nodes["#pg-tiles"].innerHTML).not.toContain("edge #");
  });
});

describe("a dependency's name in the graph", () => {
  // The v1.0.0 production check (2026-09-29, #274) found glibc, whose version was 2.44+r50+g1848099f063e-1, drawn as "g…" at 1280: the name
  // was the only part of a node that could shrink, the version never. The name keeps its width and the version is cut, at any width — what
  // the page's stylesheet says, since no browser measures here, and what the page writes: the name before the version, both whole on hover.
  const LONG = "2.44+r50+g1848099f063e-1";
  it("keeps the name whole and cuts the version, however long it is", async () => {
    const long = async (p: string, res: Response) => {
      if (!p.startsWith(`/api/v1/package/${F.pkg2}?`)) return res;
      const j = (await res.json()) as { depends: { name: string; provider: { version: string } | null }[] };
      expect(j.depends.some((d) => d.provider), "a dependency the ring provides").toBe(true);
      return Response.json({ ...j, depends: j.depends.map((d) => (d.provider ? { ...d, provider: { ...d.provider, version: LONG } } : d)) });
    };
    const p = await view(`/package/${F.pkg2}?ring=stable&arch=${F.arch}`, "", { edit: long });
    const graph = p.nodes["#deps"].innerHTML as string;
    expect(graph).toContain(`<span class="nm">${F.pkg}</span><span class="v">${LONG}</span>`);
    expect(graph).toContain(`title="${F.pkg} ${LONG}`);
    const html = (await call("GET", `/package/${F.pkg2}`)).text;
    // The name never shrinks, and is cut only when it alone is wider than the node.
    expect(declared(html, ".pkg-node .nm")).toMatchObject({ flex: "0 0 auto", "max-width": "100%", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" });
    // The version is what shrinks, to nothing if it must, and says so with an ellipsis.
    const v = declared(html, ".pkg-node .v");
    expect(v).toMatchObject({ "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" });
    expect(v.flex ?? "0 1 auto", "the version may shrink").toMatch(/^\d+ [1-9]\d* /);
    expect(v["flex-shrink"] ?? "1").not.toBe("0");
    // Under three characters of room it wraps onto a line the box clips: never a few pixels of a digit with no ellipsis.
    expect(v.flex).toBe("1 1 3ch");
    expect(declared(html, ".pkg-node > span:has(> .nm)")).toMatchObject({ "flex-wrap": "wrap", height: "16px", overflow: "hidden" });
    // The two sit in a box that may shrink inside the node, beside the tag, which never does.
    expect(declared(html, ".pkg-node > span")).toMatchObject({ display: "flex", "min-width": "0" });
    expect(declared(html, ".pkg-node .t")).toMatchObject({ flex: "none" });
  });
});
