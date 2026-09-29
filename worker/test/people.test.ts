/**
 * The People page (#251), drawn: the served page's own script run as a
 * browser would (runScript in test/fixture.ts) over the Worker's real
 * answers on the fixture, for nobody, for a contributor with nothing
 * approved, for the contributor whose package a maintainer approved and for
 * a maintainer. What it proves: the numbers, the maintainers' cards and the
 * contributors' ranking are the record's — the maintainer set, the
 * decisions, the registry's landed, the workers — and nothing the page
 * types; a number over a window the server cut says it is a floor; and the
 * way in follows the dashboard's rule — one button for everyone, live only
 * for a signed-in contributor with an approved package (their own record
 * says so), grey with the reason in its title for everyone else, never
 * absent. Where a case the fixture does not hold matters (a package two
 * maintainers approved, a long list, a cut window, a maintainer who runs
 * only a contributor's worker), one answer is changed on its way to the
 * page and the rest stay the Worker's.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { APPLY_URL } from "../src/governance";
import { PACKAGES_PAGE, SIGN_IN, handleListPackages } from "../src/routes/contributors";
import { APPROVALS_PAGE, handleApprovals } from "../src/routes/review";
import { declared, fetchPage, runScript, scriptOf, seedDashboard, type Fixture, type Ran } from "./fixture";

let F: Fixture;
let served: string;

beforeAll(async () => {
  F = await seedDashboard(env);
  served = await (await real("/people")).text();
});

/** The Worker's answer to a path, as the browser on the page gets it: with the session's cookie when there is one. */
async function real(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await fetchPage(new Request(`http://pool.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const api = async (path: string) => (await real(path)).json() as Promise<any>;
const tick = () => new Promise((r) => setTimeout(r, 10));

/** An answer changed on its way to the page: the Worker's JSON in, what the page gets out; `HANG` for a read that never answers. */
type Change = (json: any) => any;
const HANG: Change = () => HANG;

/** The page's script, run as `session` (the fixture's cookie value, null for nobody) until the lists are drawn and the Become card is settled for them. */
async function drawnAs(session: string | null, opts: { functions?: string[]; variables?: string[]; answers?: Record<string, Change>; settled?: (d: Ran) => boolean } = {}): Promise<Ran> {
  const cookie = session ? { cookie: `omc=${session}` } : {};
  const d = runScript(scriptOf(served), {
    pathname: "/people",
    functions: opts.functions ?? [],
    variables: opts.variables ?? [],
    fetch: async (path, init) => {
      const change = opts.answers?.[path];
      if (change === HANG) return new Promise<Response>(() => {});
      const res = await real(path, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...cookie } });
      return change ? new Response(JSON.stringify(change(await res.json())), { status: res.status, headers: { "content-type": "application/json" } }) : res;
    },
  });
  const settled = opts.settled ?? ((x: Ran) => !!x.nodes["#contributors-list"]?.innerHTML && !!x.nodes["#apply-slot"]?.innerHTML && !/checking…$/.test(x.nodes["#you"]?.textContent ?? ""));
  for (let i = 0; i < 300 && !settled(d); i++) await tick();
  expect(settled(d), "the page was drawn").toBe(true);
  return d;
}

/** The maintainers' cards as drawn, in order, and the one for a login. */
const cardsOf = (d: Ran) => (d.nodes["#maintainers-list"].innerHTML as string).split('<article class="op-card pp-mcard">').slice(1);
const cardOf = (d: Ran, login: string) => cardsOf(d).find((c) => c.includes(`>@${login}</a>`)) ?? "";

/** A decision as GET /factory/approvals answers one (a review), for an answer changed on its way. */
const decision = (by: string, name: string, arch: string, extra: Record<string, unknown> = {}) => ({
  id: 0, by, name, arch, decision: "approved", standing: true, blocked_at: null, rings: ["edge"], targets: [{ arch, rings: ["edge"] }], arches: [arch], created_at: new Date().toISOString(), ...extra,
});

describe("the People page", () => {
  it("serves the frame of the design: the title, the three tiles, the two lists, the steps and Open the issue grey for nobody", () => {
    expect(served).toContain('<h1 class="op-hero">No owner. A community on the record.</h1>');
    expect(served).toContain('<link rel="stylesheet" href="/assets/kit.');
    for (const [k, line] of [["maintainers", "in MAINTAINERS.toml"], ["contributors", "with a request"], ["reviews", "this month"]]) expect(served).toContain(`<span class="s" id="s-${k}">${line}</span>`);
    for (const step of ["Get one package approved", "Open an issue on GitHub", "Maintainers open a PR"]) expect(served).toContain(`<b>${step}</b>`);
    // Served grey with the sign-in as the reason, its address set aside: what the shell's gate() draws for nobody, so the page reads the same before its script and without one.
    expect(served).toContain(`<a class="disabled op-btn" id="apply" data-href="${APPLY_URL}" tabindex="-1" aria-disabled="true" title="${SIGN_IN}">Open the issue</a>`);
    expect(APPLY_URL).toBe("https://github.com/firemanxbr/omarchy-pool/issues/new?template=maintainer.yml");
    // No worker table here since #251: the Workers page is one link away.
    expect(served).not.toContain('class="wtable"');
    expect(served).toContain('<a id="workers" href="/workers">');
  });

  it("serves its own rules with itself only, after the kit's sheet: no other page pays for them", async () => {
    const kit = served.indexOf('<link rel="stylesheet" href="/assets/kit.'), own = served.indexOf("<style>\n  .pp {");
    expect(kit).toBeGreaterThan(0);
    expect(own, "the page's <style> comes after the kit's sheet, so its rules refine the kit's").toBeGreaterThan(kit);
    // Keyboard focus in the page is the design system's square green line, as in the frame.
    expect(served).toContain(".pp a:focus-visible, .pp button:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }");
    for (const path of ["/", "/workers", `/package/${F.pkg}`]) expect(await (await real(path)).text(), path).not.toContain(".pp-mcard");
  });

  it("reads windows the edge keeps: every public read the page draws from is cached, and so is the viewer's own record", async () => {
    for (const path of ["/api/v1/factory/maintainers", "/api/v1/factory/packages", "/api/v1/factory/approvals", "/api/v1/factory/trust", `/api/v1/users/${F.owner}`]) {
      const r = await real(path);
      expect(r.status, path).toBe(200);
      // A miss says the whole time to live; a hit what is left of it (edgeHit), so any positive public max-age holds.
      expect(Number(/^public, max-age=(\d+)$/.exec(r.headers.get("cache-control") ?? "")?.[1]), path).toBeGreaterThan(0);
    }
  });

  it("counts the record: the maintainers the pool applied, everyone with a request, the decisions signed this month", async () => {
    const d = await drawnAs(null);
    const maint = (await api("/api/v1/factory/maintainers")).maintainers as { login: string }[];
    const pkgs = await api("/api/v1/factory/packages");
    const decisions = await api("/api/v1/factory/approvals");
    const now = new Date(), month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    // The fixture's windows are whole: every number is the count itself, no floor.
    expect([pkgs.truncated, decisions.truncated]).toEqual([false, false]);
    expect(d.nodes["#n-maintainers"].textContent).toBe(String(maint.length));
    expect(d.nodes["#n-contributors"].textContent).toBe(String(new Set((pkgs.packages as { owner: string }[]).map((p) => p.owner)).size));
    expect(d.nodes["#n-reviews"].textContent).toBe(String((decisions.approvals as { created_at: string }[]).filter((a) => Date.parse(a.created_at) >= month).length));
    expect(maint.length).toBeGreaterThan(0);
  });

  it("is the one page that counts the contributors: the Pool's tiles that counted them left with #243", async () => {
    // The Pool's Contributors tile opened /people#contributors and had to count as this page counts, so a click never landed on another number under the same word. #243 replaced the Pool's tiles with the pool's own numbers (names, arrivals, the stable release, the sources): the Pool draws no count of people and opens neither this page's contributors nor the Workers page from a tile, so this page's number is the only one.
    const home = await (await real("/")).text();
    expect(home).not.toContain('id="open-stats"');
    expect(home).not.toContain("/people#contributors");
    expect(home).not.toContain("/people#workers");
    expect(home).not.toMatch(/"Contributors", num\(/);
    const people = await drawnAs(null);
    expect(people.nodes["#n-contributors"].textContent).toMatch(/^\d+$/);
  });

  it("draws a card per maintainer: since when, the agent of a worker of theirs, the decisions signed, what they maintain", async () => {
    const d = await drawnAs(null);
    const cards = cardsOf(d);
    const maint = (await api("/api/v1/factory/maintainers")).maintainers as { login: string }[];
    const decisions = (await api("/api/v1/factory/approvals")).approvals as { by: string; name: string; arch: string; standing: boolean; blocked_at: string | null; targets: { arch: string }[] }[];
    expect(cards.map((c) => /@([A-Za-z0-9-]+)<\/a>/.exec(c)?.[1])).toEqual(maint.map((m) => m.login));
    // What a maintainer maintains: per name and architecture, the newest standing approval's signer.
    const held = new Map<string, string>();
    for (const a of decisions) if (a.standing && !a.blocked_at) for (const t of a.targets) if (!held.has(`${a.name}\t${t.arch}`)) held.set(`${a.name}\t${t.arch}`, a.by);
    for (const [i, m] of maint.entries()) {
      const signed = decisions.filter((a) => a.by === m.login);
      const kept = [...new Set([...held].filter(([, by]) => by === m.login).map(([k]) => k.split("\t")[0]))];
      expect(cards[i], m.login).toContain(`<b>${signed.length}</b><span>reviews</span>`);
      expect(cards[i], m.login).toContain(`<b>${kept.length}</b><span>maintains</span>`);
      for (const name of kept.slice(0, 3)) expect(cards[i], `${m.login} maintains ${name}`).toContain(`>${name}</a>`);
      expect(cards[i], m.login).toMatch(/<span>since [A-Z][a-z]{2} \d{4}<\/span>/);
    }
    // m1's approval of pulled stands, and m2 blocked the package: not one m1 maintains.
    const m1 = cardOf(d, F.m1);
    expect(decisions.some((a) => a.name === F.pulledPkg && a.standing && a.blocked_at)).toBe(true);
    expect(m1).not.toContain(`>${F.pulledPkg}</a>`);
    // m1's project worker reports its agent: the kit's mark, named; m2 runs no worker, and the card says the agent is not known — to a screen reader too.
    expect(m1).toContain('<i class="op-b op-b-claude-color" style="--op-i-s:14px" role="img" aria-label="Claude Code · claude-sonnet-5" title="Claude Code · claude-sonnet-5"></i>');
    expect(cardOf(d, F.m2)).toContain('<span class="pp-agent none" role="img" aria-label="no worker of theirs reports an agent" title="no worker of theirs reports an agent">—</span>');
  });

  it("credits a package to the newest approval that stands on each architecture: approved again by another maintainer, it is theirs", async () => {
    const d = await drawnAs(null, {
      answers: {
        "/api/v1/factory/approvals": () => ({
          truncated: false,
          approvals: [
            // Newest first: m2 approved walker's new version; m1's rejection of mise takes nothing from the approval before it; m1 approved walker before, and on aarch64 only m1 did.
            decision(F.m2, "walker", "x86_64"),
            decision(F.m1, "mise", "x86_64", { decision: "rejected", standing: false }),
            decision(F.m1, "walker", "x86_64"),
            decision(F.m1, "mise", "x86_64"),
            decision(F.m1, "hypr-dock", "aarch64"),
            decision(F.m2, "hypr-dock", "x86_64", { standing: false, withdrawn_at: "2026-09-01T00:00:00Z" }),
          ],
        }),
      },
    });
    const m1 = cardOf(d, F.m1), m2 = cardOf(d, F.m2);
    expect(m2).toContain("<b>1</b><span>maintains</span>");
    expect(m2).toContain(">walker</a>");
    expect(m2).not.toContain(">hypr-dock</a>");
    expect(m1).toContain("<b>2</b><span>maintains</span>");
    expect(m1).not.toContain(">walker</a>");
    for (const name of ["mise", "hypr-dock"]) expect(m1, name).toContain(`>${name}</a>`);
    // The decisions each signed are all theirs, whatever stands.
    expect(m1).toContain("<b>4</b><span>reviews</span>");
    expect(m2).toContain("<b>2</b><span>reviews</span>");
  });

  it("names the first three packages and links the rest as +K to the maintainer's page — nothing drawn out of sight", async () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const d = await drawnAs(null, { answers: { "/api/v1/factory/approvals": () => ({ truncated: false, approvals: names.map((n) => decision(F.m1, n, "x86_64")) }) } });
    const line = /<p class="pp-pk">([\s\S]*?)<\/p>/.exec(cardOf(d, F.m1))?.[1] ?? "";
    expect([...line.matchAll(/<a href="\/package\/[^"]+">([^<]+)<\/a>/g)].map((m) => m[1])).toEqual(names.slice(0, 3));
    expect(line).toContain(`<a class="pp-more" href="/user/${F.m1}" title="3 more: every package @${F.m1} approved is on their page">+3</a>`);
    expect(cardOf(d, F.m1)).toContain("<b>6</b><span>maintains</span>");
    // A maintainer with nothing standing reads what the card's label says, not the Become card's rule.
    expect(cardOf(d, F.m2)).toContain('<span class="pp-none">maintains nothing yet</span>');
  });

  it("names the agent of any worker a maintainer runs, a project worker's first, and never calls another model on an OpenAI-compatible endpoint OpenAI", async () => {
    const worker = (id: string, owner: string, trust: string, agent: string | null, extra: Record<string, unknown> = {}) => ({ id, owner, trust, agent, revoked_at: null, last_seen: "2026-09-29T00:00:00Z", ...extra });
    const d = await drawnAs(null, {
      answers: {
        "/api/v1/factory/trust": (j) => ({
          ...j,
          workers: [
            worker("p1", F.m1, "project", "claude-code/claude-sonnet-5"),
            worker("c1", F.m1, "community", "openai/gpt-5"),
            worker("c2", F.m2, "community", "openai/deepseek-flash"),
            worker("c3", F.m2, "community", "gemini/gemini-3.6-flash", { revoked_at: "2026-09-01T00:00:00Z" }),
          ],
        }),
      },
    });
    expect(cardOf(d, F.m1)).toContain('aria-label="Claude Code · claude-sonnet-5"');
    expect(cardOf(d, F.m2)).toContain('<span class="pp-agent" title="OpenAI-compatible · deepseek-flash"><i class="op-i op-i-bot" role="img" aria-label="OpenAI-compatible · deepseek-flash"></i></span>');
    expect(cardOf(d, F.m2)).not.toContain("op-b-openai");
    // OpenAI's own model, the mark; a list that did not answer, an agent not known, said.
    const gpt = await drawnAs(null, { answers: { "/api/v1/factory/trust": (j) => ({ ...j, workers: [worker("c1", F.m2, "community", "openai/gpt-5")] }) } });
    expect(cardOf(gpt, F.m2)).toContain('<i class="op-b op-b-openai" style="--op-i-s:14px" role="img" aria-label="OpenAI · gpt-5" title="OpenAI · gpt-5"></i>');
  });

  it("draws a count over a window the server cut as a floor, and a month the window holds whole as the count", async () => {
    const pkgs = await api("/api/v1/factory/packages");
    const long = new Date(Date.UTC(2020, 0, 1)).toISOString();
    const d = await drawnAs(null, {
      answers: {
        "/api/v1/factory/packages": (j) => ({ ...j, truncated: true }),
        "/api/v1/factory/approvals": (j) => ({ ...j, truncated: true }),
      },
    });
    const owners = new Set((pkgs.packages as { owner: string }[]).map((p) => p.owner)).size;
    expect(d.nodes["#n-contributors"].textContent).toBe(`${owners}+`);
    expect(d.nodes["#contributors-by"].textContent).toBe(`by approved packages, in the newest ${pkgs.packages.length} requests`);
    expect(cardOf(d, F.m1)).toMatch(/<b title="at least: [^"]+">\d+\+<\/b><span>reviews<\/span>/);
    expect(cardOf(d, F.m1)).toMatch(/<b title="at least: [^"]+">\d+\+<\/b><span>maintains<\/span>/);
    // The fixture's decisions are this month's: a window cut after the month began may have left some of the month out.
    expect(d.nodes["#n-reviews"].textContent).toMatch(/^\d+\+$/);
    // A window that reaches before the first of the month holds the month whole: the count, no floor.
    const whole = await drawnAs(null, { answers: { "/api/v1/factory/approvals": (j) => ({ truncated: true, approvals: [...j.approvals, decision(F.m1, "old", "x86_64", { created_at: long })] }) } });
    expect(whole.nodes["#n-reviews"].textContent).toMatch(/^\d+$/);
  });

  it("ranks the contributors by approved packages, the registry's landed, and tags a maintainer", async () => {
    const d = await drawnAs(null);
    const pkgs = (await api("/api/v1/factory/packages")).packages as { owner: string; landed: boolean }[];
    const rows = [...(d.nodes["#contributors-list"].innerHTML as string).matchAll(/<a class="pp-person" href="\/user\/([^"]+)"[^>]*>[\s\S]*?<span class="pp-st" title="[^"]*">([^<]*)<\/span><\/a>/g)].map((m) => [m[1], m[2]]);
    const approved = (login: string) => pkgs.filter((p) => p.owner === login && p.landed).length;
    expect(rows.map((r) => r[0]).sort()).toEqual([...new Set(pkgs.map((p) => p.owner))].sort());
    for (let i = 1; i < rows.length; i++) expect(approved(rows[i - 1][0]), `${rows[i - 1][0]} before ${rows[i][0]}`).toBeGreaterThanOrEqual(approved(rows[i][0]));
    const requests = (login: string) => pkgs.filter((p) => p.owner === login).length;
    for (const [login, st] of rows) expect(st, login).toBe(approved(login) ? `${approved(login)} approved` : requests(login) === 1 ? "first request in" : `${requests(login)} requests in`);
    expect(rows[0][1]).toMatch(/^\d+ approved$/);
    expect(d.nodes["#contributors-list"].innerHTML).toContain(`title="${approved(F.owner)} approved by a maintainer, built by the project · `);
  });

  it("shows the first rows of a long ranking, all of them on Show all, and hands the keyboard to the first row it added", async () => {
    const d = await drawnAs(null, { functions: ["drawContributors", "showAll"], variables: ["RANKED", "ALL_ROWS"] });
    d.setRANKED(Array.from({ length: 20 }, (_, i) => ({ login: `person${i}`, requests: 1, approved: 20 - i })));
    d.drawContributors();
    const count = () => (d.nodes["#contributors-list"].innerHTML.match(/class="pp-person"/g) ?? []).length;
    expect(count()).toBe(16);
    expect(d.nodes["#contributors-all"]).toMatchObject({ hidden: false, textContent: "Show all 20" });
    let focused = false;
    d.nodes["#contributors-list > .pp-person:nth-child(17)"] = { focus: () => { focused = true; } };
    d.showAll();
    expect(count()).toBe(20);
    expect(d.nodes["#contributors-all"].hidden).toBe(true);
    expect(focused, "the 17th row, the first Show all added, has the focus the hidden button had").toBe(true);
  });

  // The v1.0.0 production check (2026-09-29, #274): at 1280 the rows sit two to a line, and "maintainer" beside a long login was cut to
  // "ma…". The role is a line of its own under the login, so it is whole at every width; the login is what is cut, whole in the row's
  // title. No browser measures here: the page's stylesheet says it, and the row the page writes.
  it("puts a maintainer's role under the login, on a line of its own, whole however long the login is", async () => {
    const login = "a-maintainer-with-a-rather-long-login";
    const d = await drawnAs(null, {
      answers: {
        "/api/v1/factory/maintainers": (j) => ({ ...j, maintainers: [...j.maintainers, { login, since: j.maintainers[0].since }] }),
        "/api/v1/factory/packages": (j) => ({ ...j, packages: [...j.packages, { ...j.packages[0], name: "long-login-package", owner: login, landed: true }] }),
      },
    });
    const list = d.nodes["#contributors-list"].innerHTML as string;
    const row = list.split('<a class="pp-person"').find((r) => r.includes(`@${login}<`));
    expect(row, "the maintainer's row").toBeDefined();
    // The login in its own span, the role beside it in the name's box — never inside the span that is cut.
    expect(row).toContain(`title="${login} · maintainer"`);
    expect(row).toContain(`<span class="pp-name"><span>@${login}</span><em>maintainer</em></span>`);
    // A contributor's row has no role line: the login alone.
    expect(list).toContain(`<span class="pp-name"><span>@${F.owner}</span></span>`);
    // The name's box stacks its two lines; the login is cut with an ellipsis, the role never is.
    expect(declared(served, ".pp-name")).toMatchObject({ display: "grid", "min-width": "0" });
    expect(declared(served, ".pp-name > span")).toMatchObject({ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" });
    const role = declared(served, ".pp-name em");
    expect(role["white-space"]).toBe("nowrap");
    expect(role, "the role is never cut").not.toHaveProperty("overflow");
    expect(role).not.toHaveProperty("text-overflow");
    // Nothing on the name's box cuts its lines: the box is a column the grid gives the rest of the row.
    expect(declared(served, ".pp-name")).not.toHaveProperty("text-overflow");
    expect(declared(served, ".pp-person")["grid-template-columns"]).toBe("24px minmax(0, 1fr) auto");
  });

  // The dashboard's rule: the same button for everyone; live for the one viewer who may apply, grey with the reason in its title for everyone else — nobody reads the sign-in first.
  it("opens the issue only for a signed-in contributor with an approved package, and says why to everyone else", async () => {
    const nobody = await drawnAs(null);
    expect(nobody.nodes["#you"].textContent).toBe("Sign in to see if you are eligible");
    expect(nobody.nodes["#apply-slot"].innerHTML).toBe(`<a class="disabled op-btn" id="apply" data-href="${APPLY_URL}" tabindex="-1" aria-disabled="true" title="${SIGN_IN}">Open the issue</a>`);

    const bob = await drawnAs(F.sessions.contributor);
    expect(bob.nodes["#you"].textContent).toBe(`@${F.contributor} · no package approved yet`);
    expect(bob.nodes["#apply-slot"].innerHTML).toContain('aria-disabled="true" title="get one package approved first">Open the issue</a>');

    const record = (await api(`/api/v1/users/${F.owner}`)) as { packages: { landed: boolean }[] };
    const mine = record.packages.filter((p) => p.landed).length;
    expect(mine).toBeGreaterThan(0);
    const alice = await drawnAs(F.sessions.owner);
    expect(alice.nodes["#you"].textContent).toBe(`@${F.owner} · ${mine} approved · eligible`);
    expect(alice.nodes["#apply-slot"].innerHTML).toBe(`<a class="op-btn primary" id="apply" href="${APPLY_URL}" title="opens the maintainer application on GitHub">Open the issue</a>`);

    const m2 = await drawnAs(F.sessions.maintainer);
    expect(m2.nodes["#you"].textContent).toBe("You are a maintainer.");
    expect(m2.nodes["#apply-slot"].innerHTML).toContain('aria-disabled="true" title="you are a maintainer already">Open the issue</a>');
  });

  it("decides from the viewer's own record, not the registry's window: a package that fell out of the newest requests still counts", async () => {
    const alice = await drawnAs(F.sessions.owner, { answers: { "/api/v1/factory/packages": (j) => ({ ...j, truncated: true, packages: j.packages.filter((p: { owner: string }) => p.owner !== F.owner) }) } });
    expect(alice.nodes["#contributors-list"].innerHTML).not.toContain(`href="/user/${F.owner}"`);
    expect(alice.nodes["#you"].textContent).toMatch(new RegExp(`^@${F.owner} · \\d+ approved · eligible$`));
    expect(alice.nodes["#apply-slot"].innerHTML).toContain('class="op-btn primary"');
  });

  it("names a signed-in viewer at once, and says it is checking while their record is on its way", async () => {
    const alice = await drawnAs(F.sessions.owner, {
      answers: { [`/api/v1/users/${F.owner}`]: HANG },
      settled: (d) => !!d.nodes["#contributors-list"]?.innerHTML && /checking…$/.test(d.nodes["#you"]?.textContent ?? ""),
    });
    expect(alice.nodes["#you"].textContent).toBe(`@${F.owner} · checking…`);
    expect(alice.nodes["#apply-slot"].innerHTML).toContain('aria-disabled="true" title="checking whether a package of yours is approved">Open the issue</a>');
  });
});

// The two windows the page counts over say when they stopped before the end: one row more is read to know, and the answer holds the page's rows only. Called on the handlers, not through the edge: a cut answer must not be the cached copy another test file reads.
describe("the record's windows say when they are cut", () => {
  it("GET /factory/approvals and GET /factory/packages answer truncated once the record goes on past them", async () => {
    const before = { approvals: (await (await handleApprovals(env)).json()) as any, packages: (await (await handleListPackages(env)).json()) as any };
    expect([before.approvals.truncated, before.packages.truncated]).toEqual([false, false]);
    const one = await env.DB.prepare("SELECT task_id, name, arch, version FROM approvals ORDER BY id LIMIT 1").first<{ task_id: number; name: string; arch: string; version: string }>();
    const fill = APPROVALS_PAGE + 1 - Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>())!.n);
    // A registration names a contributor the pool knows (owner references contributors): dave, who brought nothing.
    const owner = F.outsider;
    const pkgFill = PACKAGES_PAGE + 1 - Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM factory_packages").first<{ n: number }>())!.n);
    try {
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO approvals (task_id, name, arch, version, decision, by, note) SELECT ?, ?, ?, ?, 'rejected', 'm1', 'filler' FROM n`,
      ).bind(fill, one!.task_id, one!.name, one!.arch, one!.version).run();
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO factory_packages (name, owner, url, arches, status) SELECT 'filler-' || i, ?, 'https://filler.example', '["x86_64"]', 'registered' FROM n`,
      ).bind(pkgFill, owner).run();
      const approvals = (await (await handleApprovals(env)).json()) as any;
      const packages = (await (await handleListPackages(env)).json()) as any;
      expect(approvals.truncated).toBe(true);
      expect(packages.truncated).toBe(true);
      expect(packages.packages.length).toBe(PACKAGES_PAGE);
      expect((approvals.approvals as { targets: unknown[] }[]).reduce((n, a) => n + a.targets.length, 0)).toBeLessThanOrEqual(APPROVALS_PAGE);
    } finally {
      await env.DB.prepare("DELETE FROM approvals WHERE note = 'filler'").run();
      await env.DB.prepare("DELETE FROM factory_packages WHERE name LIKE 'filler-%'").run();
    }
    expect(((await (await handleApprovals(env)).json()) as any).truncated).toBe(false);
  });
});
