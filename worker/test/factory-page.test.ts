/**
 * The Factory (#246), over the fixture: a name is taken by one rule —
 * request.ts's PKGNAME, which the request refuses by, the card's script and
 * the ⌘K menu splice in, and no page module types a copy of — and the
 * card's live check says what the request would answer, word for word, for
 * every kind of name the fixture holds (free, reserved by a request, in the
 * pool, shipped by a source, blocked); two requests for one new name at the
 * same moment, one of them has it; the reads behind the check go through the
 * name's indexes. What the pool reads of a repository: the forge and the path
 * from the address, GitHub through the request's own detect(), GitLab and
 * Codeberg through their APIs with the release named for the request —
 * never for a visitor, never where SOURCE_CHECK is off. The page, run over
 * the Worker's answers: "Sign in to send" for nobody, the prompt built from
 * the form, the proposed tools said as proposed; every package on the line
 * where its targets put it, the tiles the line's and the lists' own
 * numbers, the workers the listing's rows with their agent — and read again
 * when a job starts or ends; the reader's own requests, signed in only; a
 * renewal filled from the record.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { PKGNAME, PKGNAME_RULE } from "../src/request";
import { GO_MENU } from "../src/pages/layout";
import { forgeOf, handleSourceRead, normaliseUrl, readSource, spdxOf } from "../src/routes/sources";
import { ownScriptOf, runScript, scriptOf, seedDashboard, type Fixture, type Ran } from "./fixture";

// Every page module's source, as text: no page types a name rule of its own.
const SOURCES = import.meta.glob("../src/pages/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

let F: Fixture;
beforeAll(async () => {
  F = await seedDashboard(env);
});

const checklist = { official: true, license: true, unshipped: true, evidence: true };

async function fetchAs(path: string, init: RequestInit = {}, login?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = { ...(init.headers as Record<string, string> | undefined), ...(login ? { cookie: `omc=oms_${login}` } : {}) };
  const res = await worker.fetch(new Request(`http://pool.test${path}`, { ...init, headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
async function call(method: string, path: string, body?: unknown, login?: string): Promise<{ status: number; json: any }> {
  const res = await fetchAs(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, login);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const page = async (path: string) => (await fetchAs(path)).text();
/** A request as the card sends it for a project off the forges: the release named by hand, a project of its own so only the name is asked about. */
const requestOf = (name: string, project: string) => ({ url: `https://${project}.example`, name, source: `https://${project}.example/${project}-1.0.tar.gz`, version: "1.0", description: "A request the Factory's tests send", license: "MIT", arches: [F.arch], checklist });

describe("a name, by one rule", () => {
  it("is PKGNAME: the request refuses what it refuses in its words, the live check says the same, the card and the ⌘K menu splice it and no page module types a copy", async () => {
    const names = ["ok", "a", "@scope", "_under", "+plus", "x-1.2_3@4+5", "UPPER", "-lead", ".lead", "sp ace", "bang!", "é", "x".repeat(100), "y".repeat(101)];
    for (const [i, n] of names.entries()) {
      const valid = PKGNAME.test(n.toLowerCase());
      const res = await call("POST", "/api/v1/factory/packages", requestOf(n, `rule-${i}`), "bob");
      const refused = res.status === 400 && /^name must be a pacman package name/.test(res.json?.error ?? "");
      expect(refused, `${n}: ${res.status} ${JSON.stringify(res.json)}`).toBe(!valid);
      if (refused) expect(res.json.error).toBe(`name must be a pacman package name (${PKGNAME_RULE})`);
      const check = await call("GET", `/api/v1/factory/names/${encodeURIComponent(n)}?arches=${F.arch}`);
      expect(check.json.state === "invalid", n).toBe(!valid);
      if (!valid) expect(check.json.why).toBe(`name must be a pacman package name (${PKGNAME_RULE})`);
    }
    // One expression, served as it is: the Factory's script and the menu's carry PKGNAME itself.
    expect(ownScriptOf(await page("/factory"))).toContain(`var NAME_RULE = ${String(PKGNAME)}`);
    expect(GO_MENU).toContain(`NAME = ${String(PKGNAME)}`);
    // No page module types a pkgname's character class of its own: the request page and the menu each typed one, and the three disagreed (2026-09-29).
    const typed = Object.entries(SOURCES).filter(([, src]) => /@\._\+-\]/.test(src)).map(([file]) => file);
    expect(typed).toEqual([]);
  });

  it("says in the live check what the request answers: available, reserved, taken, blocked — the refusal word for word, and the holder's own name theirs", async () => {
    const fresh = "a-name-nobody-has";
    const cases: [string, string][] = [[fresh, "available"], [F.disposablePkg, "reserved"], [F.factoryPkg, "taken"], [F.publishedPkg, "taken"], [F.pkg, "taken"], [F.blockedPkg, "blocked"]];
    for (const [i, [name, state]] of cases.entries()) {
      const check = await call("GET", `/api/v1/factory/names/${name}?arches=${F.arch}`);
      expect(check.status, name).toBe(200);
      expect(check.json.state, name).toBe(state);
      // bob, who holds none of them, sends it: taken exactly when the check says available, refused otherwise in the check's own words.
      const sent = await call("POST", "/api/v1/factory/packages", requestOf(name, `said-${i}`), "bob");
      if (state === "available") expect(sent.status, name).toBe(201);
      else {
        expect([403, 409], `${name}: ${JSON.stringify(sent.json)}`).toContain(sent.status);
        expect(sent.json.error, name).toBe(check.json.why);
      }
    }
    // The sources' rows are per architecture: zlib shipped by core on x86_64 is taken for x86_64, and the check names what a request would skip.
    const zlib = await call("GET", `/api/v1/factory/names/${F.pkg}?arches=${F.arch}`);
    expect(zlib.json.provided).toEqual([expect.objectContaining({ source: "core", arch: F.arch })]);
    // The holder: alice's staged disposable is hers to renew (renew is null), her approved mine is not, in the request's words.
    const own = await call("GET", `/api/v1/factory/names/${F.disposablePkg}?arches=${F.arch}`);
    expect(own.json).toMatchObject({ owner: F.owner, status: "staged", renew: null });
    const mine = await call("GET", `/api/v1/factory/names/${F.factoryPkg}?arches=${F.arch}`);
    expect(mine.json.owner).toBe(F.owner);
    const renewal = await call("POST", "/api/v1/factory/packages", requestOf(F.factoryPkg, "said-renewal"), F.owner);
    expect(renewal.status).toBe(409);
    expect(renewal.json.error).toBe(mine.json.renew);
    // The same for everyone, thirty seconds at the edge, as the registry is.
    expect((await fetchAs(`/api/v1/factory/names/${fresh}-2`)).headers.get("cache-control")).toBe("public, max-age=30");
  });

  it("is reserved on send, atomically: two people sending one new name at the same moment, one of them has it and the other is told whose it is", async () => {
    const [a, b] = await Promise.all([
      call("POST", "/api/v1/factory/packages", requestOf("race-for-a-name", "race-alice"), "alice"),
      call("POST", "/api/v1/factory/packages", requestOf("race-for-a-name", "race-bob"), "bob"),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const [won, lost] = a.status === 201 ? [a, b] : [b, a];
    const winner = won.json.package.owner as string;
    expect(lost.json.error).toMatch(new RegExp(`^race-for-a-name is \\w+, requested by ${winner}$`));
    // One registration, one request on the record — the winner's; the live check calls the name reserved, and whose.
    const rows = await env.DB.prepare("SELECT owner FROM factory_packages WHERE name = 'race-for-a-name'").all<{ owner: string }>();
    expect(rows.results).toEqual([{ owner: winner }]);
    const records = await env.DB.prepare("SELECT owner FROM package_requests WHERE name = 'race-for-a-name'").all<{ owner: string }>();
    expect(records.results).toEqual([{ owner: winner }]);
    const check = await call("GET", `/api/v1/factory/names/race-for-a-name?arches=${F.arch}`);
    expect(check.json).toMatchObject({ state: "reserved", owner: winner });
  });

  it("reads the name through its indexes: the registration by its key, the approvals, the builds and the sources by the name — never every package edge serves", async () => {
    const seen: { sql: string; args: unknown[] }[] = [];
    const DB = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => { const entry = { sql, args: [] as unknown[] }; seen.push(entry); const stmt = target.prepare(sql); return new Proxy(stmt, { get: (s, k) => (k === "bind" ? (...args: unknown[]) => { entry.args = args; return s.bind(...args); } : typeof Reflect.get(s, k) === "function" ? Reflect.get(s, k).bind(s) : Reflect.get(s, k)) }); };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const { handleNameStanding } = await import("../src/routes/contributors");
    for (const name of [F.factoryPkg, F.pkg, "nobody-has-this"]) await handleNameStanding(name, new URL(`http://pool.test/api/v1/factory/names/${name}`), { ...env, DB } as Env);
    expect(seen.length).toBeGreaterThanOrEqual(8);
    let rows = 0;
    for (const x of seen) {
      const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${x.sql}`).bind(...x.args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
      // No table read whole, and edge's members never walked by the ring alone (the sources' lookup did: a row per package in edge, per name asked).
      expect(plan, x.sql).not.toMatch(/\bSCAN\b/);
      expect(plan, x.sql).not.toMatch(/ring_packages\S* \(ring=\?\)/);
      rows += Number(((await env.DB.prepare(x.sql).bind(...x.args).all()).meta as { rows_read?: number }).rows_read ?? 0);
    }
    expect(rows, "rows read for three names").toBeLessThan(40);
  });
});

describe("what the pool reads of a repository", () => {
  /** A fetch that answers the forges' API addresses from a table, 404 for the rest: the tests reach no network. */
  const forges = (table: Record<string, unknown>): typeof fetch => (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url in table ? Response.json(table[url]) : new Response("{}", { status: 404 });
  }) as typeof fetch;

  it("names the forge and the repository from the address, as a person pastes it", () => {
    expect(normaliseUrl(" gitlab.com/you/project ")).toBe("https://gitlab.com/you/project");
    expect(normaliseUrl("https://codeberg.org/you/project")).toBe("https://codeberg.org/you/project");
    expect(forgeOf("https://github.com/you/project/tree/main")).toEqual({ forge: "github.com", path: "you/project", repo: "project" });
    expect(forgeOf("https://www.github.com/you/project.git")).toEqual({ forge: "github.com", path: "you/project", repo: "project" });
    expect(forgeOf("https://gitlab.com/group/sub/project/-/tree/main")).toEqual({ forge: "gitlab.com", path: "group/sub/project", repo: "project" });
    expect(forgeOf("https://codeberg.org/you/project/")).toEqual({ forge: "codeberg.org", path: "you/project", repo: "project" });
    for (const u of ["https://example.com/you/project", "http://github.com/you/project", "https://github.com/you", "not a url"]) expect(forgeOf(u), u).toBeNull();
    expect(spdxOf("gpl-3.0")).toBe("GPL-3.0");
    expect(spdxOf("mit")).toBe("MIT");
    expect(spdxOf("other")).toBeNull();
  });

  it("reads GitHub by the request's own detect(): the words, the licence, the latest release — nothing for the card to send, the request reads GitHub itself", async () => {
    const api = "https://api.github.com/repos/you/marcelo";
    const got = await readSource("https://github.com/you/marcelo", env, forges({
      [api]: { full_name: "you/marcelo", description: "A keyboard-first note taker ", license: { spdx_id: "MIT" }, default_branch: "main", archived: false },
      [`${api}/releases/latest`]: { tag_name: "v1.2.0", assets: [] },
      [`${api}/git/trees/v1.2.0`]: { tree: [{ path: "Cargo.toml", type: "blob" }] },
    }));
    expect(got).toEqual({ description: "A keyboard-first note taker", license: "MIT", version: "v1.2.0", source: "https://github.com/you/marcelo/archive/refs/tags/v1.2.0.tar.gz", archived: false, build_system: "rust", send: {} });
    expect(await readSource("https://github.com/you/nothing", env, forges({}))).toEqual({ error: "you/nothing not found on GitHub" });
  });

  it("reads GitLab and Codeberg through their APIs, and names the release the request builds off GitHub", async () => {
    const gl = "https://gitlab.com/api/v4/projects/group%2Fmarcelo";
    expect(await readSource("https://gitlab.com/group/marcelo", env, forges({
      [`${gl}?license=true`]: { description: "Notes", archived: false, license: { key: "gpl-3.0", nickname: "GNU GPLv3" } },
      [`${gl}/releases?per_page=1`]: [{ tag_name: "v2.0" }],
    }))).toEqual({ description: "Notes", license: "GPL-3.0", version: "v2.0", source: "https://gitlab.com/group/marcelo/-/archive/v2.0/marcelo-v2.0.tar.gz", archived: false, build_system: null, send: { source: "https://gitlab.com/group/marcelo/-/archive/v2.0/marcelo-v2.0.tar.gz", version: "v2.0" } });
    const cb = "https://codeberg.org/api/v1/repos/you/marcelo";
    expect(await readSource("https://codeberg.org/you/marcelo", env, forges({
      [cb]: { description: "", archived: true, licenses: ["MIT"] },
      [`${cb}/tags?limit=1`]: [{ name: "1.0.1" }],
    }))).toEqual({ description: null, license: "MIT", version: "1.0.1", source: "https://codeberg.org/you/marcelo/archive/1.0.1.tar.gz", archived: true, build_system: null, send: { source: "https://codeberg.org/you/marcelo/archive/1.0.1.tar.gz", version: "1.0.1" } });
    expect(await readSource("https://example.com/you/marcelo", env, forges({}))).toBeNull();
  });

  it("reads only for a person, only the forges, never where SOURCE_CHECK is off — and keeps a read at the edge, an answer that read nothing never", async () => {
    // The Worker as the tests run it: SOURCE_CHECK is off, so nothing is read, whoever asks.
    let r = await call("GET", "/api/v1/factory/source?url=github.com/you/marcelo", undefined, "alice");
    expect(r.json).toMatchObject({ url: "https://github.com/you/marcelo", project: "https://github.com/you/marcelo", forge: "GitHub", name: "marcelo", read: false, why: "this pool reads no repository (SOURCE_CHECK is off)" });
    r = await call("GET", "/api/v1/factory/source?url=https://marcelo.example/");
    expect(r.json).toMatchObject({ forge: null, name: "marcelo.example", read: false });
    expect(r.json.why).toMatch(/^not on GitHub, GitLab or Codeberg: name the release/);
    r = await call("GET", "/api/v1/factory/source?url=http://github.com/you/marcelo");
    expect(r).toMatchObject({ status: 400, json: { error: "url must be https" } });
    // Where the pool does read: a visitor gets what the address says, a person what the repository says.
    const reading = { ...env, SOURCE_CHECK: undefined } as Env;
    const cb = "https://codeberg.org/api/v1/repos/you/marcelo";
    const table = forges({ [cb]: { description: "Notes", licenses: ["MIT"] }, [`${cb}/releases/latest`]: { tag_name: "v1" } });
    const ask = async (cookie?: string) => {
      const res = await handleSourceRead(new URL("http://pool.test/api/v1/factory/source?url=codeberg.org/you/marcelo"), new Request("http://pool.test/", { headers: cookie ? { cookie } : {} }), reading, table);
      return { cache: res.headers.get("cache-control"), json: (await res.json()) as any };
    };
    const visitor = await ask();
    expect(visitor).toEqual({ cache: "no-store", json: { url: "https://codeberg.org/you/marcelo", project: "https://codeberg.org/you/marcelo", forge: "Codeberg", name: "marcelo", read: false, why: "sign in, and the pool reads the repository" } });
    const person = await ask(`omc=oms_${F.owner}`);
    expect(person.cache).toBe("public, max-age=600");
    expect(person.json).toMatchObject({ forge: "Codeberg", name: "marcelo", read: true, description: "Notes", license: "MIT", version: "v1", send: { version: "v1" } });
  });
});

describe("the page", () => {
  /** The Worker's answers as a browser on the dashboard gets them, a login's session when given; a listing asked past the edge's ten seconds (a new query each time) so a test sees what it just changed. */
  const real = (login?: string, count?: Record<string, number>) => (path: string, init?: RequestInit) => {
    const bare = path.split("?")[0];
    if (count) count[bare] = (count[bare] ?? 0) + 1;
    const asked = path === "/api/v1/factory?limit=10" ? `${path}&t=${Math.random()}` : path;
    return fetchAs(asked, init ?? {}, login);
  };
  const settled = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const run = async (opts: { login?: string; search?: string; count?: Record<string, number>; functions?: string[] } = {}): Promise<Ran & Record<string, any>> => {
    const html = await page(`/factory${opts.search ?? ""}`);
    const d = runScript(scriptOf(html), { pathname: "/factory", search: opts.search ?? "", functions: opts.functions ?? [], fetch: real(opts.login, opts.count) });
    await settled();
    return d as Ran & Record<string, any>;
  };

  it("serves the card to everyone: live fields, Sign in to send for nobody, the prompt built from the form, the proposed tools said as proposed", async () => {
    const html = await page("/factory");
    expect(html).toContain('<a class="op-btn" id="fx-send" href="/auth/github?next=/factory">Sign in to send</a>');
    expect(html).toContain("Sending reserves the name. It's freed if the request is rejected.");
    expect(html).toContain('<span class="op-pill na" title="signed off, not built yet: #252">proposed</span>');
    expect(html).toContain("You never review your own requests. Another maintainer picks them up.");
    const d = await run({ functions: ["prompt"] });
    d.nodes["#fx-name"].value = "marcelo";
    d.nodes["#fx-url"].value = "github.com/you/marcelo";
    d.nodes["#fx-license"].value = "MIT";
    d.prompt();
    expect(d.nodes["#fx-prompt"].textContent).toBe("Request marcelo on omarchy-pool: source https://github.com/you/marcelo, licence MIT, x86_64 and aarch64. Follow it until it is ready for review, and tell me if a build fails.");
    // Nobody signed in: the send stays the sign-in, and nobody's requests are drawn.
    expect(d.nodes["#fx-send-slot"]?.innerHTML ?? "").toBe("");
    expect(d.nodes["#mine"].hidden).toBe(true);
  });

  it("puts every package on the line where its targets say, draws the tiles from the line and the lists, and the workers from the listing — read again when a job starts or ends", async () => {
    const count: Record<string, number> = {};
    const d = await run({ count, functions: ["stageOf", "loadListing"] });
    const reg = (await call("GET", "/api/v1/factory/packages")).json.packages as { name: string; landed: boolean }[];
    const stage = Object.fromEntries(reg.map((p) => [p.name, d.stageOf(p)]));
    // ours is in the pool; disposable and spare are built and wait; lost's next build is queued; hers and pulled are blocked, off the line.
    expect(stage).toMatchObject({ [F.publishedPkg]: 4, [F.disposablePkg]: 2, [F.sparePkg]: 2, [F.failedPkg]: 1, [F.blockedPkg]: -1, [F.pulledPkg]: -1 });
    for (let i = 0; i < 4; i++) expect(d.nodes[`#col-${i}-n`].textContent, `column ${i}`).toBe(String(Object.values(stage).filter((s) => s === i).length));
    // Shipped counts what a maintainer approved (landed), its cards the ones not back on the line.
    expect(d.nodes["#col-4-n"].textContent).toBe(String(reg.filter((p) => p.landed).length));
    expect(d.nodes["#col-4"].innerHTML).toContain(`href="/package/${F.publishedPkg}?ring=edge&amp;arch=${F.arch}"`);
    expect(d.nodes["#col-2"].innerHTML).toContain(`href="/package/${F.disposablePkg}?ring=lab&amp;arch=${F.arch}"`);
    // The tiles: the line's own counts, the review list's waiting, the registry's landed.
    expect(d.nodes["#t-line-n"].textContent).toBe(String(Object.values(stage).filter((s) => s >= 0 && s < 4).length));
    expect(d.nodes["#t-ready-n"].textContent).toBe(String((await call("GET", "/api/v1/factory/review")).json.waiting));
    expect(d.nodes["#t-shipped-n"].textContent).toBe(String(reg.filter((p) => p.landed).length));
    expect(d.nodes["#t-shipped-s"].innerHTML).toMatch(/^approved by a maintainer, from \d+ contributors$/);
    // The workers: every one alive, its agent's mark, idle as the fixture leaves them.
    expect(d.nodes["#fx-busy"].textContent).toBe("0 busy · 2 idle");
    expect(d.nodes["#fx-wlist"].innerHTML).toContain("op-b-claude-color");
    expect(d.nodes["#fx-wlist"].innerHTML).toContain("op-b-openai");
    expect(count["/api/v1/factory/packages"]).toBe(1);
    // Nothing moved: the listing asked again reads no registry.
    await d.loadListing();
    await settled();
    expect(count["/api/v1/factory/packages"]).toBe(1);
    // A job starts: alice's worker takes lost's queued build. The listing says so, and the line is read again.
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE build_tasks SET status = 'leased', lease_owner = ?, started_at = ?, attempts = 1 WHERE name = ? AND kind = 'build' AND status = 'queued'").bind(F.communityWorker, now, F.failedPkg),
      env.DB.prepare("UPDATE build_workers SET current_task = (SELECT id FROM build_tasks WHERE name = ? AND kind = 'build' AND status = 'leased'), last_seen = ? WHERE id = ?").bind(F.failedPkg, now, F.communityWorker),
    ]);
    await d.loadListing();
    await settled();
    expect(count["/api/v1/factory/packages"]).toBe(2);
    expect(d.nodes["#fx-busy"].textContent).toBe("1 busy · 1 idle");
    expect(d.nodes["#fx-wlist"].innerHTML).toContain(`<b>${F.failedPkg}</b>`);
    expect(d.nodes["#fx-wlist"].innerHTML).toMatch(new RegExp(`on ${F.arch}`));
    expect(d.nodes["#col-1"].innerHTML).toMatch(new RegExp(`on ${F.arch}`));
  });

  it("shows a person their own requests, with the rule and the way on: a contributor's approvals, a maintainer's queue", async () => {
    const alice = await run({ login: F.owner });
    expect(alice.nodes["#mine"].hidden).toBe(false);
    const hers = (await call("GET", "/api/v1/factory/packages")).json.packages.filter((p: { owner: string }) => p.owner === F.owner);
    expect(alice.nodes["#mine-n"].textContent).toBe(String(hers.length));
    expect(alice.nodes["#mine-list"].innerHTML).toContain(`<b>${F.disposablePkg}</b>`);
    expect(alice.nodes["#mine-maint"].textContent).toBe(`${hers.filter((p: { landed: boolean }) => p.landed).length} approved · you can apply to maintain ›`);
    expect(alice.nodes["#fx-send-slot"].innerHTML).toBe('<button type="button" class="op-btn" id="fx-send">Send request</button>');
    const bob = await run({ login: F.contributor });
    expect(bob.nodes["#mine-n"].textContent).toBe(String((await call("GET", "/api/v1/factory/packages")).json.packages.filter((p: { owner: string }) => p.owner === F.contributor).length));
    const m2 = await run({ login: F.m2 });
    expect(m2.nodes["#mine-maint"].textContent).toMatch(/^Review queue · \d+ waiting ›$/);
  });

  it("fills a renewal from the record, and takes a name brought in the address", async () => {
    const renew = await run({ login: F.owner, search: `?renew=${F.disposablePkg}` });
    await settled(120);
    expect(renew.nodes["#fx-head"].textContent).toBe(`Renew the request for ${F.disposablePkg}`);
    expect(renew.nodes["#fx-name"].value).toBe(F.disposablePkg);
    expect(renew.nodes["#fx-url"].value).toBe(`https://${F.disposablePkg}.example`);
    expect(renew.nodes["#fx-send-slot"].innerHTML).toContain(">Renew the request</button>");
    const named = await run({ search: "?name=zzfoo" });
    expect(named.nodes["#fx-name"].value).toBe("zzfoo");
    expect(named.nodes["#fx-name-say"].innerHTML).toMatch(/^(⟳ checking|✓ available)$/);
  });
});
