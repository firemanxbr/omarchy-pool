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
import { forgeOf, handleSourceRead, normaliseUrl, readSource, READS_PER_HOUR, spdxOf } from "../src/routes/sources";
import { parseProjectUrl } from "../src/routes/contributors";
import { handleFactory } from "../src/routes/factory";
import { BROWSE_NAME } from "../src/routes/browse";
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
    // Home's box and the packages list offer Request "<name>" by it too: Home's script splices it, the list's API and page read it as BROWSE_NAME.
    expect(ownScriptOf(await page("/"))).toContain(`NAME = ${String(PKGNAME)}`);
    expect(BROWSE_NAME).toBe(PKGNAME);
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
    // Where edge serves a taken name — the one ring the card links it to: zlib and ours are there; lost, approved and its publish failed, is in no ring.
    expect(zlib.json.in_edge).toEqual([F.arch]);
    expect((await call("GET", `/api/v1/factory/names/${F.publishedPkg}?arches=${F.arch}`)).json).toMatchObject({ state: "taken", in_edge: [F.arch] });
    expect((await call("GET", `/api/v1/factory/names/${F.failedPkg}?arches=${F.arch}`)).json).toMatchObject({ state: "taken", in_edge: [] });
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

describe("what runs now", () => {
  it("is the listing's live read: the tasks in flight through the queue's index and no counts — never every task, as the whole listing reads them twice", async () => {
    const seen: { sql: string; args: unknown[] }[] = [];
    const DB = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => { const entry = { sql, args: [] as unknown[] }; seen.push(entry); const stmt = target.prepare(sql); return new Proxy(stmt, { get: (s, k) => (k === "bind" ? (...args: unknown[]) => { entry.args = args; return s.bind(...args); } : typeof Reflect.get(s, k) === "function" ? Reflect.get(s, k).bind(s) : Reflect.get(s, k)) }); };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const live = (await (await handleFactory({ ...env, DB } as Env, new URL("http://pool.test/api/v1/factory?live=1&limit=20"))).json()) as { counts: unknown[]; tasks: { status: string }[]; workers: unknown[] };
    expect(live.counts).toEqual([]);
    expect(live.tasks.length).toBeGreaterThan(0);
    for (const t of live.tasks) expect(["leased", "queued"]).toContain(t.status);
    expect(live.workers.length).toBeGreaterThan(0);
    for (const x of seen) {
      const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${x.sql}`).bind(...x.args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
      expect(plan, x.sql).not.toMatch(/SCAN build_tasks\b/);
    }
    // The whole listing is as it was: the counts, and the tasks of every status.
    const whole = (await call("GET", "/api/v1/factory?limit=60")).json;
    expect(whole.counts.length).toBeGreaterThan(0);
    expect(whole.tasks.some((t: { status: string }) => !["leased", "queued"].includes(t.status))).toBe(true);
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
    // The request's project is the same repository the read names, whichever view was pasted: one project, one registration, and the repository's name the default.
    expect(parseProjectUrl("https://gitlab.com/group/sub/project/-/tree/main")).toMatchObject({ project: "https://gitlab.com/group/sub/project", github: null });
    expect(parseProjectUrl("https://codeberg.org/you/project/src/branch/main")).toMatchObject({ project: "https://codeberg.org/you/project", github: null });
    expect(parseProjectUrl("https://www.gitlab.com/you/project.git/")).toMatchObject({ project: "https://gitlab.com/you/project" });
    expect(parseProjectUrl("https://example.com/you/project/")).toMatchObject({ project: "https://example.com/you/project" });
    expect(spdxOf("gpl-3.0")).toBe("GPL-3.0");
    expect(spdxOf("mit")).toBe("MIT");
    expect(spdxOf("other")).toBeNull();
  });

  it("reads GitHub by the request's own detect(), short of the tree: the words, the licence, the latest release — nothing for the card to send, the request reads GitHub itself", async () => {
    const api = "https://api.github.com/repos/you/marcelo", asked: string[] = [];
    const table = forges({
      [api]: { full_name: "you/marcelo", description: "A keyboard-first note taker ", license: { spdx_id: "MIT" }, default_branch: "main", archived: false },
      [`${api}/releases/latest`]: { tag_name: "v1.2.0", assets: [] },
      [`${api}/git/trees/v1.2.0`]: { tree: [{ path: "Cargo.toml", type: "blob" }] },
    });
    const got = await readSource("https://github.com/you/marcelo", env, (async (input: RequestInfo | URL, init?: RequestInit) => { asked.push(String(input)); return table(input, init); }) as typeof fetch);
    // The card shows no build system: the tree is the request's to read, and the card's read costs the token two calls here, not three.
    expect(got).toEqual({ description: "A keyboard-first note taker", license: "MIT", version: "v1.2.0", source: "https://github.com/you/marcelo/archive/refs/tags/v1.2.0.tar.gz", archived: false, build_system: null, send: {} });
    expect(asked).toEqual([api, `${api}/releases/latest`]);
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
    // Said in a reader's words: the setting's name is the operator's, not the card's.
    expect(r.json).toMatchObject({ url: "https://github.com/you/marcelo", project: "https://github.com/you/marcelo", forge: "GitHub", name: "marcelo", read: false, why: "this pool reads no repository" });
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

  it("keeps a read by the repository, not the address as typed; never reads for a blocked account; and asks a forge at most READS_PER_HOUR times an hour per person", async () => {
    const reading = { ...env, SOURCE_CHECK: undefined } as Env;
    const cb = "https://codeberg.org/api/v1/repos/keep/marcelo", asked: string[] = [];
    const table = forges({ [cb]: { description: "Kept", licenses: ["MIT"] }, [`${cb}/releases/latest`]: { tag_name: "v2" } });
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => { asked.push(String(input)); return table(input, init); }) as typeof fetch;
    const ask = async (address: string, login?: string) => {
      const res = await handleSourceRead(new URL(`http://pool.test/api/v1/factory/source?url=${encodeURIComponent(address)}`), new Request("http://pool.test/", { headers: login ? { cookie: `omc=oms_${login}` } : {} }), reading, counting);
      return { cache: res.headers.get("cache-control"), edge: res.headers.get("x-pool-cache"), json: (await res.json()) as any };
    };
    // carol is blocked: the request refuses her, and so does the read — in the same words, and no forge is asked.
    const carol = await ask("codeberg.org/keep/marcelo", "carol");
    expect(carol.json).toMatchObject({ read: false, why: expect.stringMatching(/^carol is blocked by a maintainer/) });
    expect(asked).toEqual([]);
    // bob reads it; the same repository spelled otherwise — a scheme, a trailing ".git", a view, its case — is the same read, kept, for anyone: the forge is not asked again.
    const bob = await ask("https://codeberg.org/keep/marcelo", "bob");
    expect(bob).toMatchObject({ cache: "public, max-age=600", edge: "miss", json: { read: true, description: "Kept", version: "v2" } });
    const calls = asked.length;
    for (const spelled of ["codeberg.org/keep/marcelo.git", "https://codeberg.org/Keep/Marcelo/src/branch/main", "https://www.codeberg.org/keep/marcelo/"]) {
      const again = await ask(spelled);
      expect(again, spelled).toMatchObject({ edge: "hit", json: { read: true, description: "Kept", url: normaliseUrl(spelled) } });
    }
    expect(asked.length).toBe(calls);
    // A repository that is not there is kept a minute: asked twice, the forge answers once.
    const missing = await ask("https://codeberg.org/keep/nothing-here", "bob");
    expect(missing).toMatchObject({ cache: "public, max-age=60", json: { read: false, why: "keep/nothing-here not found on Codeberg" } });
    const n = asked.length;
    expect((await ask("codeberg.org/keep/nothing-here/", "bob")).edge).toBe("hit");
    expect(asked.length).toBe(n);
    // The hour's reads: one person asks the forge READS_PER_HOUR times at most; the next address is not read, and says why.
    for (let i = 0; i < READS_PER_HOUR; i++) await ask(`https://codeberg.org/spend/repo-${i}`, "dave");
    const before = asked.length;
    const spent = await ask("https://codeberg.org/spend/one-more", "dave");
    expect(spent.json).toMatchObject({ read: false, why: `read ${READS_PER_HOUR} repositories for you this hour; fill the card in, and sending reads it` });
    expect(asked.length).toBe(before);
    // Someone else is not held by dave's hour.
    expect((await ask("https://codeberg.org/spend/one-more", "bob")).json.why).toBe("spend/one-more not found on Codeberg");
  });

  it("records the repository whichever view was pasted: one project, one registration, the repository's name the default", async () => {
    const off = { source: "https://gitlab.com/g/one-repo/-/archive/1.0/one-repo-1.0.tar.gz", version: "1.0", description: "One repository, pasted two ways", license: "MIT", arches: [F.arch], checklist };
    const first = await call("POST", "/api/v1/factory/packages", { ...off, url: "https://gitlab.com/g/one-repo/-/tree/main" }, "bob");
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.json.package).toMatchObject({ name: "one-repo", project: "https://gitlab.com/g/one-repo" });
    const second = await call("POST", "/api/v1/factory/packages", { ...off, url: "https://gitlab.com/g/one-repo", name: "one-repo-again" }, "alice");
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/^https:\/\/gitlab\.com\/g\/one-repo is already in the pool as one-repo/);
  });
});

describe("the page", () => {
  /** The Worker's answers as a browser on the dashboard gets them, a login's session when given; the live listing asked past the edge's ten seconds (a new query each time) so a test sees what it just changed. */
  const real = (login?: string, count?: Record<string, number>) => (path: string, init?: RequestInit) => {
    // A read counted by its path, a write by its method too: a send is not a read of the registry.
    const bare = (init?.method && init.method !== "GET" ? `${init.method} ` : "") + path.split("?")[0];
    if (count) count[bare] = (count[bare] ?? 0) + 1;
    const asked = path === "/api/v1/factory?live=1&limit=20" ? `${path}&t=${Math.random()}` : path;
    return fetchAs(asked, init ?? {}, login);
  };
  const settled = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const run = async (opts: { login?: string; search?: string; count?: Record<string, number>; functions?: string[]; variables?: string[] } = {}): Promise<Ran & Record<string, any>> => {
    const html = await page(`/factory${opts.search ?? ""}`);
    const d = runScript(scriptOf(html), { pathname: "/factory", search: opts.search ?? "", functions: opts.functions ?? [], variables: opts.variables, fetch: real(opts.login, opts.count) });
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
    await settled();
    const reg = (await call("GET", "/api/v1/factory/packages")).json.packages as { name: string; landed: boolean }[];
    const stage = Object.fromEntries(reg.map((p) => [p.name, d.stageOf(p)]));
    // ours is in the pool; disposable and spare are built and wait; lost's next build is queued; hers and pulled are blocked, off the line.
    expect(stage).toMatchObject({ [F.publishedPkg]: 4, [F.disposablePkg]: 2, [F.sparePkg]: 2, [F.failedPkg]: 1, [F.blockedPkg]: -1, [F.pulledPkg]: -1 });
    // Every column counts its own cards — Shipped too: a shipped package on the line again (lost, approved, a new build queued) is a card in Building and only there, never "+1 earlier" under Shipped.
    for (let i = 0; i < 5; i++) expect(d.nodes[`#col-${i}-n`].textContent, `column ${i}`).toBe(String(Object.values(stage).filter((s) => s === i).length));
    expect(reg.filter((p) => p.landed).length, "a landed package is on the line again").toBeGreaterThan(Object.values(stage).filter((s) => s === 4).length);
    expect(d.nodes["#col-4"].innerHTML).not.toContain("earlier");
    // A shipped card leads to the ring its approval says serves it; one on its way, to the lab.
    expect(d.nodes["#col-4"].innerHTML).toContain(`href="/package/${F.publishedPkg}?ring=edge&amp;arch=${F.arch}"`);
    expect(d.nodes["#col-2"].innerHTML).toContain(`href="/package/${F.disposablePkg}?ring=lab&amp;arch=${F.arch}"`);
    // An empty column says so.
    for (let i = 0; i < 5; i++) if (!Object.values(stage).some((s) => s === i)) expect(d.nodes[`#col-${i}`].innerHTML, `column ${i}`).toBe('<p class="fx-none">nothing here now</p>');
    // The tiles: the line's own counts — a landed package on it again said so —, the builds a worker holds (none yet: lost's is queued), the review list's waiting, the registry's landed.
    const onLine = reg.filter((p) => d.stageOf(p) >= 0 && d.stageOf(p) < 4), again = onLine.filter((p) => p.landed).length;
    expect(d.nodes["#t-line-n"].textContent).toBe(String(onLine.length));
    expect(d.nodes["#t-line-s"].innerHTML).toBe(`requests on the line${again ? ` · ${again} of them new versions` : ""}`);
    expect(d.nodes["#t-building-n"].textContent).toBe("0");
    expect(d.nodes["#t-building-s"].innerHTML).toBe(`${Object.values(stage).filter((s) => s === 1).length} queued · 0 of 2 workers busy`);
    expect(d.nodes["#t-ready-n"].textContent).toBe(String((await call("GET", "/api/v1/factory/review")).json.waiting));
    expect(d.nodes["#t-shipped-n"].textContent).toBe(String(reg.filter((p) => p.landed).length));
    expect(d.nodes["#t-shipped-s"].innerHTML).toMatch(/^approved by a maintainer, from \d+ contributors$/);
    expect(d.nodes["#t-shipped-n"].title, "the whole registry: an exact number").toBe("");
    // The workers: every one alive, its agent's mark, idle as the fixture leaves them.
    expect(d.nodes["#fx-busy"].textContent).toBe("0 busy · 2 idle");
    expect(d.nodes["#fx-wlist"].innerHTML).toContain("op-b-claude-color");
    expect(d.nodes["#fx-wlist"].innerHTML).toContain("op-b-openai");
    expect(count["/api/v1/factory/packages"]).toBe(1);
    // Nothing moved: the listing asked again reads no registry.
    await d.loadListing();
    await settled();
    expect(count["/api/v1/factory/packages"]).toBe(1);
    // A pool job queued moves no card: the line is not read for it.
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, kind, params) VALUES ('sync', ?, '-', '-', 'the page test', 50, 0, 'project', 'sync', '{}')").bind(F.arch).run();
    await d.loadListing();
    await settled();
    expect(count["/api/v1/factory/packages"]).toBe(1);
    // A build starts: alice's worker takes lost's queued build. The live read says so, and the line is read again.
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
    // Building now is what a worker holds: lost's build, one.
    expect(d.nodes["#t-building-n"].textContent).toBe("1");
  });

  it("counts Shipped as a floor when the registry says it stopped before its last row, as People counts its contributors", async () => {
    // The registry answers its newest PACKAGES_PAGE rows (routes/contributors.ts); the fixture holds fewer, so the answer is cut here, the rows as served.
    const cut = async (path: string, init?: RequestInit) => {
      const res = await real()(path, init);
      if (path !== "/api/v1/factory/packages" || (init?.method && init.method !== "GET")) return res;
      return new Response(JSON.stringify({ ...((await res.json()) as object), truncated: true }), { status: res.status, headers: res.headers });
    };
    const d = runScript(scriptOf(await page("/factory")), { pathname: "/factory", functions: [], fetch: cut });
    await settled();
    const reg = (await call("GET", "/api/v1/factory/packages")).json.packages as { landed: boolean }[];
    expect(d.nodes["#t-shipped-n"].textContent).toBe(`${reg.filter((p) => p.landed).length}+`);
    expect(d.nodes["#t-shipped-n"].title).toBe(`at least: the registry read here is its newest ${reg.length} requests`);
    expect(d.nodes["#t-shipped-s"].innerHTML).toMatch(/^approved by a maintainer, from \d+\+ contributors$/);
  });

  it("takes a request whose every build failed off the line, and tells its owner; an architecture nobody asked for is the faintest square", async () => {
    const d = await run({ login: F.owner, functions: ["stageOf", "squares", "drawMine"], variables: ["REG"] });
    const failed = { name: "all-failed", owner: F.owner, status: "waiting", release: "1.0", targets: { [F.arch]: { status: "not_supported", task: 1 } }, updated_at: new Date().toISOString(), landed: false, blocked_at: null };
    expect(d.stageOf(failed)).toBe(-1);
    expect(d.stageOf({ ...failed, targets: { [F.arch]: { status: "not_supported", task: 1 }, aarch64: { status: "building", task: 2 } } })).toBe(1);
    expect(d.stageOf({ ...failed, targets: { [F.arch]: { status: "waiting", task: null } } })).toBe(0);
    d.setREG([failed]);
    d.drawMine();
    expect(d.nodes["#mine-list"].innerHTML).toContain("Not built");
    expect(d.nodes["#mine-list"].innerHTML).toContain("every architecture's build failed after its tries");
    // Not supported is the kit's dashed square; not requested is its own, apart from it.
    expect(d.squares(failed)).toContain('<i class="op-arch na" title="x86_64 · its build failed');
    expect(d.squares(failed)).toContain('<i class="op-arch off" title="aarch64 · not requested"></i>');
  });

  it("puts the card on the line the moment it is sent, the name the sender's on the card, the focus on what was sent, and a renewal's card back to a request's", async () => {
    const count: Record<string, number> = {};
    const d = await run({ login: F.contributor, count, functions: ["send", "checkName", "loadRegistry"], variables: ["checklist"] });
    d.setchecklist(() => checklist);
    const name = "sent-from-the-card";
    d.nodes["#fx-name"].value = name;
    d.nodes["#fx-url"].value = `https://${name}.example`;
    d.nodes["#fx-source"].value = `https://${name}.example/${name}-1.0.tar.gz`;
    d.nodes["#fx-version"].value = "1.0";
    d.nodes["#fx-license"].value = "MIT";
    d.nodes["#fx-desc"].value = "A request the card sends in the test";
    d.checkName();
    await settled(400);
    const reads = count["/api/v1/factory/packages"];
    d.send();
    await settled(200);
    expect(d.nodes["#fx-done"].hidden).toBe(false);
    expect(d.nodes["#fx-done"].innerHTML).toContain(`<b>${name}</b> 1.0 sent · name reserved`);
    // On the line at once, from the POST's own answer — the registry's copy at the edge is not asked for it.
    expect(count["/api/v1/factory/packages"]).toBe(reads);
    expect(count["POST /api/v1/factory/packages"]).toBe(1);
    const line = [0, 1, 2, 3, 4].map((i) => d.nodes[`#col-${i}`].innerHTML).join("");
    expect(line).toContain(`<b>${name}</b>`);
    expect(d.nodes["#mine-list"].innerHTML).toContain(`<b>${name}</b>`);
    // A registry answer from before the send (the edge's copy) does not take it off the line: it stays until an answer as new has it.
    await d.loadRegistry();
    await settled();
    expect([0, 1, 2, 3, 4].map((i) => d.nodes[`#col-${i}`].innerHTML).join("")).toContain(`<b>${name}</b>`);
    // The name typed again is the sender's, whatever the check's copy at the edge says.
    d.nodes["#fx-name"].value = name;
    d.checkName();
    expect(d.nodes["#fx-name-say"].innerHTML).toBe("✓ yours · sending renews the request");
    // A renewal sent: the card is a request's again.
    const renew = await run({ login: F.owner, search: `?renew=${F.disposablePkg}`, functions: ["send"], variables: ["checklist"] });
    await settled(400);
    renew.setchecklist(() => checklist);
    expect(renew.nodes["#fx-head"].textContent).toBe(`Renew the request for ${F.disposablePkg}`);
    // disposable's record names no release (the fixture wrote the registration by hand), and its project is off GitHub: the card opens the release's fields and asks for them before anything is sent.
    expect(renew.nodes["#fx-more"].open).toBe(true);
    renew.send();
    expect(renew.nodes["#fx-state"].textContent).toBe("Name the release: its source and its version.");
    renew.nodes["#fx-source"].value = `https://${F.disposablePkg}.example/${F.disposablePkg}-1.0.tar.gz`;
    renew.nodes["#fx-version"].value = "1.0";
    renew.send();
    await settled(200);
    expect(renew.nodes["#fx-state"].textContent).toBe("");
    expect(renew.nodes["#fx-head"].textContent).toBe("Request a package");
    expect(renew.nodes["#fx-send"].textContent).toBe("Send request");
  });

  it("keeps the card across the sign-in: every field, the architectures and the confirmations, drawn again once and then forgotten", async () => {
    const kept: Record<string, string> = {};
    const store = { setItem: (k: string, v: string) => { kept[k] = v; }, getItem: (k: string) => kept[k] ?? null, removeItem: (k: string) => { delete kept[k]; } };
    const before = await run({ functions: ["keepDraft", "signInLink"], variables: ["STORE"] });
    before.setSTORE(store);
    before.nodes["#fx-name"].value = "kept-name";
    before.nodes["#fx-url"].value = "https://kept.example";
    before.nodes["#fx-desc"].value = "Kept across the sign-in";
    before.keepDraft();
    before.signInLink();
    // The way back lands on the card, the name in the address.
    expect(Object.keys(kept)).toHaveLength(1);
    const after = await run({ login: F.contributor, functions: ["draftBack"], variables: ["STORE"] });
    after.setSTORE(store);
    expect(after.draftBack()).toBe(true);
    expect(after.nodes["#fx-name"].value).toBe("kept-name");
    expect(after.nodes["#fx-url"].value).toBe("https://kept.example");
    expect(after.nodes["#fx-desc"].value).toBe("Kept across the sign-in");
    expect(after.draftBack(), "drawn once").toBe(false);
    // A browser that refuses storage keeps nothing and draws nothing, and says nothing either.
    const none = await run({ functions: ["keepDraft", "draftBack"], variables: ["STORE"] });
    none.setSTORE(null);
    none.keepDraft();
    expect(none.draftBack()).toBe(false);
  });

  it("says a check in a few words beside the label and the reason under the field where the reader must act on it", async () => {
    const d = await run({ login: F.owner, functions: ["nameSays", "urlSays"] });
    await settled();
    d.nameSays({ name: F.factoryPkg, state: "taken", owner: F.owner, status: "approved", renew: "mine is in the pool (approval #1); its record stays as it was", why: "x" });
    expect(d.nodes["#fx-name-say"].innerHTML).toBe("✗ yours · can't renew now");
    expect(d.nodes["#fx-name-why"].textContent).toBe("mine is in the pool (approval #1); its record stays as it was");
    expect(d.nodes["#fx-name-why"].hidden).toBe(false);
    d.nameSays({ name: "zlib", state: "available", owner: null, provided: [{ source: "core", arch: F.arch, version: "1.3" }] });
    expect(d.nodes["#fx-name-say"].innerHTML).toBe(`✓ available · ${F.arch} skipped`);
    expect(d.nodes["#fx-name-why"].textContent).toBe(`core ships 1.3 for ${F.arch}: the request builds the other architectures.`);
    // Taken: linked to the package in edge only where edge serves it — never a ring no fact supports.
    d.nameSays({ name: F.publishedPkg, state: "taken", owner: "someone", in_edge: [F.arch], why: "x" });
    expect(d.nodes["#fx-name-say"].innerHTML).toBe(`<a href="/package/${F.publishedPkg}?ring=edge&amp;arch=${F.arch}">✗ taken · open it ›</a>`);
    d.nameSays({ name: F.failedPkg, state: "taken", owner: "someone", in_edge: [], why: "x" });
    expect(d.nodes["#fx-name-say"].innerHTML).toBe("✗ taken");
    d.nameSays({ name: "free", state: "available", owner: null, provided: [] });
    expect(d.nodes["#fx-name-why"].hidden).toBe(true);
    d.urlSays({ forge: null, read: false, why: "not on GitHub, GitLab or Codeberg: name the release — its source and its version" });
    expect(d.nodes["#fx-url-say"].innerHTML).toBe("name the release below");
    expect(d.nodes["#fx-more"].open).toBe(true);
    d.urlSays({ error: "a GitHub URL must be the repository, a release page or a release tarball" });
    expect(d.nodes["#fx-url-say"].innerHTML).toBe("✗ not usable");
    expect(d.nodes["#fx-url-why"].textContent).toBe("a GitHub URL must be the repository, a release page or a release tarball");
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
