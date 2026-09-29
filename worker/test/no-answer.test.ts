/**
 * A list that did not answer is said, not drawn. The Worker answers every
 * thrown error as { error: "internal error" } with a 500 (index.ts), and
 * the shell's api() used to resolve that body as data: Review read
 * REVIEW.waiting off it, num(undefined) is 0, and the tile said "Waiting
 * for review 0 · nothing waiting" in green — the Pipeline's flow and the
 * Factory's tile the same, the Status page "API down · TypeError" over an
 * API that had answered (the audit of 2026-09-18). This file runs the
 * served pages' own scripts (runScript in test/fixture.ts) — the Pool's
 * people row too — over a fetch that answers every read with that 500,
 * and reads back what they drew:
 * the page's line says which list did not answer and why — once: the
 * tiles read "—" with "did not answer" under them and the reason on
 * hover, not the sentence six times on one screen — none reads 0, no
 * empty state — "nothing waiting", "no promotion yet", "no worker alive",
 * "nothing of yours waiting" for a signed-in reader — stands in for a list
 * that failed, a tile another read fed (the stats poll's builds and worker
 * minutes) keeps its number when only the lists failed, and a refresh that
 * fails leaves the rows of the last answer on screen.
 * The shell's rule comes first: api() rejects on a 5xx with the body's
 * error (or "HTTP <status>" when there is no body) and resolves a 4xx with
 * its body and __status, since the pages read `can`, a 403 and a 404 from
 * it. No poll may reject unhandled — the runtime would report it here.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { HELPERS } from "../src/pages/layout";
import { fetchPage, runScript, scriptOf, seedDashboard, type Fixture, type Ran } from "./fixture";

let F: Fixture;

beforeAll(async () => {
  F = await seedDashboard(env);
});

/** The Worker's own answer to a path, as a browser on the dashboard would get it: nobody signed in. The Pipeline and the Journal redirect to Status since #240, and are drawn by their modules until #248 folds them into it (the fixture's fetchPage). */
async function real(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await fetchPage(new Request(`http://pool.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const INTERNAL = "internal error";
/** What index.ts answers when a route throws. */
const failed = () => new Response(JSON.stringify({ error: INTERNAL }), { status: 500, headers: { "content-type": "application/json" } });

/**
 * A fetch for the page under test: the session probe answers as the Worker does — 401 for nobody, the session's
 * answer for a reader given by `as` (the fixture's session cookie) — and every other read answers the Worker's 500,
 * or the Worker's real answer over the fixture: while `down` is false (the refresh test), and for the paths `up`
 * matches (only the lists failed; the stats poll answered).
 */
type State = { down: boolean; as?: string; up?: RegExp };
function fetchThat(state: State): (path: string, init?: RequestInit) => Promise<Response> {
  return (path, init) => {
    const cookie = state.as ? { cookie: `omc=${state.as}` } : {};
    if (path === "/auth/me") return state.as ? real(path, { headers: cookie }) : Promise.resolve(new Response(JSON.stringify({ error: "no session" }), { status: 401, headers: { "content-type": "application/json" } }));
    if (!state.down || (state.up && state.up.test(path))) return real(path, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...cookie } });
    return Promise.resolve(failed());
  };
}

/** The served page's script, run with that fetch; `functions` are the page's own to call again. */
async function run(path: string, state: State, functions: string[] = []): Promise<Ran> {
  const res = await real(path);
  expect(res.status, path).toBe(200);
  return runScript(scriptOf(await res.text()), { pathname: path, functions, fetch: fetchThat(state) });
}

/** The reads answer on the next turns of the loop: enough of them for a Promise.all over a few answers and a whoami in front. */
const settled = () => new Promise((r) => setTimeout(r, 40));

/** What a page wrote into a node — "" for one it never touched. */
const html = (d: Ran, sel: string): string => d.nodes[sel]?.innerHTML ?? "";
/** The tiles a page drew, each as its inner HTML. */
const tiles = (d: Ran, sel = "#tiles"): string[] => (d.nodes[sel]?.children ?? []).map((c: { innerHTML: string }) => c.innerHTML);
/** What the shell writes under a tile whose list did not answer: two words, the reason on hover. */
const unanswered = (reason: string) => `<div class="s"><span title="${reason}">did not answer</span></div>`;
/**
 * Every tile says "—" for its number and none says a number; the ones the failed list fed say "did not answer" with
 * the reason on hover — the sentence is the page's line's to say, once — and `kept` of them, fed by the stats poll
 * (which answered nothing here either), stay as computed: "—" with no reason, since the reason is not theirs.
 */
function expectDashes(d: Ran, n: number, reason: string, sel = "#tiles", kept = 0) {
  const t = tiles(d, sel);
  expect(t, `${sel}: ${n} tiles`).toHaveLength(n);
  for (const html of t) {
    expect(html).toContain('<div class="v num">—</div>');
    expect(html).not.toMatch(/<div class="v num[^"]*">\d/);
    expect(html, "the sentence under a tile").not.toMatch(/>the [^<]* did not answer: /);
  }
  expect(t.filter((html) => html.includes(unanswered(reason))), `${sel}: tiles the list fed`).toHaveLength(n - kept);
}

describe("the shell's api()", () => {
  const shell = (fetch: (path: string) => Promise<Response>) => {
    const src = HELPERS.split("__POOL_URL__").join("http://pool.test").split("__RINGS_TEXT__").join("{}").split("__WICON__").join("{}").split("__LATE_AFTER_HOURS__").join("9").split("__PROMISED_RINGS__").join("[]").split("__ARCHES__").join('["x86_64"]').split("__SEVERITIES__").join("[]").split("__WORKER_ALIVE_MINUTES__").join("10");
    return runScript(src, { pathname: "/review", functions: ["api"], fetch }) as Ran & { api: (m: string, p: string, b?: unknown) => Promise<any> };
  };

  it("rejects a 500 with the body's error, and a 5xx without a body with its status", async () => {
    const s = shell((p) => Promise.resolve(p === "/json" ? failed() : new Response("bad gateway", { status: 502 })));
    await expect(s.api("GET", "/json")).rejects.toThrow(INTERNAL);
    await expect(s.api("GET", "/text")).rejects.toThrow("HTTP 502");
  });

  it("resolves a 403 and a 404 with the body and the status on it: the pages read `can` and a not-found from them", async () => {
    const s = shell(() => real(`/api/v1/factory/tasks/${F.stagedTask}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    // Nobody signed in: the Worker's 401 is an answer, with its reason.
    const refused = await s.api("POST", `/api/v1/factory/tasks/${F.stagedTask}/approve`, {});
    expect(refused.__status).toBe(401);
    expect(typeof refused.error).toBe("string");
    const s404 = shell(() => real("/api/v1/factory/tasks/0"));
    const missing = await s404.api("GET", "/api/v1/factory/tasks/0");
    expect(missing.__status).toBe(404);
    expect(missing.error).toBeTruthy();
    // And a 200 carries no error and its status.
    const s200 = shell(() => real("/api/v1/factory/review"));
    const list = await s200.api("GET", "/api/v1/factory/review");
    expect(list.__status).toBe(200);
    expect(list.waiting).toBe(3);
  });
});

describe("a list that did not answer is said, not drawn", () => {
  // Review's tiles are the kit's (#247): one op-stat each, the number in .n and the line under it in .s.
  const rvTiles = (d: Ran): string[] => (html(d, "#rv-tiles").match(/<div class="op-stat">[\s\S]*?<\/span><\/div>/g) ?? []);
  it("/review: the note names the list, the tiles read — with the reason on hover, the queue draws no 'Nothing here right now.'", async () => {
    const d = await run("/review", { down: true });
    await settled();
    const reason = `the review list did not answer: ${INTERNAL}`;
    expect(d.nodes["#rv-note"].textContent).toBe(reason);
    const t = rvTiles(d);
    expect(t).toHaveLength(4);
    for (const tile of t) {
      expect(tile).toContain('<b class="n" data-n="">—</b>');
      expect(tile).not.toMatch(/data-n="\d/);
      expect(tile, "the sentence under a tile").not.toMatch(/>the [^<]* did not answer: /);
    }
    expect(t[0]).toContain("Ready for review");
    // The review list's three tiles say which read failed on hover; Blocked is the brake's record's, and says its own.
    expect(t.slice(0, 3).every((x) => x.includes(`<span title="${reason}">did not answer</span>`))).toBe(true);
    expect(t[3]).toContain(`<span title="the brake's record did not answer: ${INTERNAL}">did not answer</span>`);
    expect(html(d, "#rv-rows")).toContain(reason);
    expect(html(d, "#rv-rows")).not.toContain("Nothing here right now.");
  });

  it("/review as alice, whose three builds are staged: the queue says the list did not answer, never 'Nothing here right now.'", async () => {
    // The session probe answers her session; every list answers 500 — the one her rows are drawn from among them.
    const d = await run("/review", { down: true, as: F.sessions.owner });
    await settled();
    const reason = `the review list did not answer: ${INTERNAL}`;
    expect(d.nodes["#rv-note"].textContent).toBe(reason);
    expect(html(d, "#rv-rows")).toContain(reason);
    expect(html(d, "#rv-rows")).not.toContain("Nothing here right now.");
    expect(html(d, "#rv-rows")).not.toContain("yours · locked");
    // Each tab says its own list's reason: the brake's record on Blocked, the registry on No maintainer.
    for (const [tab, what] of [["blocked", "brake's record"], ["unmaintained", "registry"]] as const) {
      const t = runScript(scriptOf(await (await real("/review")).text()), { pathname: "/review", search: `?tab=${tab}`, functions: [], fetch: fetchThat({ down: true, as: F.sessions.owner }) });
      await settled();
      expect(html(t, "#rv-rows"), tab).toContain(`the ${what} did not answer: ${INTERNAL}`);
      expect(html(t, "#rv-rows"), tab).not.toContain("Nothing here right now.");
    }
  });

  it("/review as alice, the review list answering and the brake's record not: her packages are drawn as hers, and the Blocked tab says which read did not answer", async () => {
    const d = await run("/review", { down: true, as: F.sessions.owner, up: /^\/api\/v1\/factory\/(review|approvals|packages)$/ });
    await settled();
    expect(d.nodes["#rv-note"].textContent).toBe("");
    expect(html(d, "#rv-rows")).toContain("yours · locked");
    expect(rvTiles(d)[3]).toContain(`the brake's record did not answer: ${INTERNAL}`);
    const b = runScript(scriptOf(await (await real("/review")).text()), { pathname: "/review", search: "?tab=blocked", functions: [], fetch: fetchThat({ down: true, as: F.sessions.owner, up: /^\/api\/v1\/factory\/(review|approvals|packages)$/ }) });
    await settled();
    expect(html(b, "#rv-rows")).toContain(`the brake's record did not answer: ${INTERNAL}`);
    expect(html(b, "#rv-rows")).not.toContain("Nothing here right now.");
  });

  it("/review: a refresh that fails leaves the last answer's rows and numbers on screen, and says so", async () => {
    const state = { down: false };
    const d = await run("/review", state, ["load"]);
    await settled();
    // The first load answered over the fixture: three packages ready for a claim, their rows drawn.
    const before = rvTiles(d);
    expect(before[0]).toContain('<b class="n" data-n="3">3</b>');
    const rows = d.nodes["#rv-rows"].innerHTML;
    expect(rows).toContain("<b>disposable</b>");
    state.down = true;
    d.load();
    await settled();
    expect(d.nodes["#rv-note"].textContent).toBe(`the review list did not answer: ${INTERNAL}`);
    expect(d.nodes["#rv-rows"].innerHTML).toBe(rows);
    // Every tile, the brake's Blocked among them: its list failed too, and what it drew last stays.
    expect(rvTiles(d)).toEqual(before);
  });

  it("/pipeline: the state row's note names the factory's lists, the six tiles read —, the flow and the queue draw nothing in their place, and every other read says so where it draws", async () => {
    const d = await run("/pipeline", { down: true });
    await settled();
    const reason = `the factory's lists did not answer: ${INTERNAL}`;
    expect(d.nodes["#lists-note"].textContent).toBe(reason);
    expectDashes(d, 6, reason, "#tiles", 1);
    expect(tiles(d)[3]).toContain("Waiting for review");
    expect(html(d, "#flow")).toBe("");
    expect(html(d, "#staged tbody")).not.toContain("nothing staged");
    expect(html(d, "#tasks tbody")).not.toContain("nothing queued or built yet");
    // The hint beside Operations still says who is looking.
    expect(d.nodes["#ops-who"].textContent).toContain("read-only");
    expect(html(d, "#registry tbody")).not.toContain("no package requested yet");
    // The feed, the promotions chart and the budget each say which read did not answer, not an empty state.
    expect(html(d, "#feed")).toContain(`the journal did not answer: ${INTERNAL}`);
    expect(html(d, "#c-promos")).toContain(`the journal did not answer: ${INTERNAL}`);
    expect(html(d, "#c-promos")).not.toContain("no promotion yet");
    expect(html(d, "#budget")).toContain(`the cost estimate did not answer: ${INTERNAL}`);
  });

  it("/factory: the note beside Landed lately, the five tiles read —, Landed says why", async () => {
    const d = await run("/factory", { down: true });
    await settled();
    const reason = `the factory's lists did not answer: ${INTERNAL}`;
    expect(d.nodes["#lists-note"].textContent).toBe(reason);
    expectDashes(d, 5, reason, "#tiles", 1);
    expect(tiles(d)[1]).toContain("Waiting for review");
    expect(html(d, "#landed")).toContain(reason);
    expect(html(d, "#landed")).not.toContain("nothing approved yet");
    // The funnel reads the same lists: it says so in the chart's place, not a heading over nothing.
    expect(html(d, "#c-funnel")).toContain(reason);
  });

  it("/factory and /pipeline, the lists failing and the stats poll answering: the tile the poll feeds keeps its number beside the chart that draws the same series", async () => {
    const up = /^\/api\/v1\/(stats|status|cost|events)/;
    const f = await run("/factory", { down: true, up });
    await settled();
    const reason = `the factory's lists did not answer: ${INTERNAL}`;
    expect(f.nodes["#lists-note"].textContent).toBe(reason);
    const ft = tiles(f);
    expect(ft, "five tiles").toHaveLength(5);
    // The four the lists fed read "—"; Builds this week is the stats series summed — the chart beside it has its bars — and says so, not "the factory's lists did not answer" over the same series.
    expect(ft.filter((t) => t.includes(unanswered(reason)))).toHaveLength(4);
    expect(ft[3]).toContain("Builds this week");
    expect(ft[3]).toMatch(/<div class="v num">\d/);
    expect(ft[3]).toContain(" staged · ");
    expect(ft[3]).not.toContain("did not answer");
    expect(html(f, "#c-builds")).toContain("<svg");
    const p = await run("/pipeline", { down: true, up });
    await settled();
    const pt = tiles(p);
    expect(pt, "six tiles").toHaveLength(6);
    expect(pt.filter((t) => t.includes(unanswered(reason)))).toHaveLength(5);
    expect(pt[5]).toContain("Worker minutes · 7 d");
    expect(pt[5]).toMatch(/<div class="v num">\d/);
    expect(pt[5]).not.toContain("did not answer");
  });

  it("/journal: the count line says the journal did not answer; no 'nothing matches'", async () => {
    const d = await run("/journal", { down: true });
    await settled();
    expect(d.nodes["#count"].textContent).toBe(`the journal did not answer: ${INTERNAL}`);
    expect(html(d, "#events tbody")).not.toContain("nothing matches");
  });

  it("/workers: the note by Every worker, the four tiles read —, no table says 'no worker alive'", async () => {
    const d = await run("/workers", { down: true });
    await settled();
    const reason = `the worker listing did not answer: ${INTERNAL}`;
    expect(d.nodes["#lists-note"].textContent).toBe(reason);
    expectDashes(d, 4, reason, "#tiles", 1);
    for (const t of ["#w-project tbody", "#w-review tbody", "#w-community tbody"]) expect(html(d, t)).not.toMatch(/no (project|review|contributor's) worker/);
  });

  it("/workers, the listing failing and the stats poll answering: the minutes tile keeps its number", async () => {
    const d = await run("/workers", { down: true, up: /^\/api\/v1\/(stats|status)/ });
    await settled();
    const t = tiles(d);
    expect(t).toHaveLength(4);
    expect(t.filter((x) => x.includes(unanswered(`the worker listing did not answer: ${INTERNAL}`)))).toHaveLength(3);
    expect(t[3]).toContain("Worker minutes · 7 d");
    expect(t[3]).toMatch(/<div class="v num">\d/);
  });

  // A kit page (#251): its three tiles are served, and the script writes each number and the line under it — "—" and "did not answer" with the reason on hover, as the shell's tilesUnanswered says it. The Become card is the viewer's own record: when that did not answer either, it cannot tell a signed-in viewer whether they may apply, and says so; when it did, the lists' failure takes nothing from the answer.
  it("/people: the two lists say so, the three tiles read —, and the way in says it could not check", async () => {
    const d = await run("/people", { down: true });
    await settled();
    const reason = `the people's lists did not answer: ${INTERNAL}`;
    expect(html(d, "#maintainers-list")).toContain(reason);
    expect(html(d, "#contributors-list")).toContain(reason);
    expect(html(d, "#contributors-list")).not.toContain("bring the first package");
    expect(html(d, "#maintainers-list")).not.toContain("no maintainer listed yet");
    for (const k of ["maintainers", "contributors", "reviews"]) {
      expect(d.nodes[`#n-${k}`].textContent, k).toBe("—");
      expect(html(d, `#s-${k}`), k).toBe(`<span title="${reason}">did not answer</span>`);
    }
    const signedIn = await run("/people", { down: true, as: F.sessions.owner });
    await settled();
    expect(signedIn.nodes["#you"].textContent).toBe(`@${F.owner} · could not check`);
    expect(html(signedIn, "#apply-slot")).toContain(`title="could not check: your record did not answer: ${INTERNAL}"`);
    expect(html(signedIn, "#apply-slot")).toContain('class="disabled op-btn"');
    const recordUp = await run("/people", { down: true, up: /^\/api\/v1\/users\//, as: F.sessions.owner });
    await settled();
    expect(html(recordUp, "#maintainers-list")).toContain(reason);
    expect(recordUp.nodes["#you"].textContent).toMatch(new RegExp(`^@${F.owner} · \\d+ approved · eligible$`));
  });

  it("/, the stats answering and the rest not: what reached the rings says its list did not answer, the requests draw nothing, the search says it did not answer — no empty state and no Request", async () => {
    const d = await run("/", { down: true, up: /^\/api\/v1\/(stats|status)/ }, ["lookFor"]);
    await settled();
    await settled();
    // The rings' heads have parents in the fixture, so their diffs are asked; every one of them failed.
    expect(html(d, "#pool-new")).toBe(`<p class="home-quiet">the rings' latest changes did not answer: ${INTERNAL}</p>`);
    expect(html(d, "#pool-new")).not.toContain("Nothing new");
    // The requests' row stays as served, hidden and empty: no chip, and no word standing in for a list that failed.
    expect(html(d, "#pool-asked")).toBe("");
    // The stats answered: the numbers are theirs.
    expect(d.nodes["#n-pkgs"]?.textContent).toMatch(/^\d/);
    // A name typed while the search does not answer: said, and never offered to the factory.
    d.lookFor("zzfoo");
    await settled();
    expect(html(d, "#pool-results")).toContain("the package search did not answer: HTTP 500");
    expect(html(d, "#pool-results")).not.toContain("Request it");
    expect(d.nodes["#pool-said"]?.textContent, "said to a screen reader too").toBe("the package search did not answer: HTTP 500");
  });

  it("/, the stats not answering: every number reads — with \"did not answer\" under it and the reason on hover, none reads 0, the chain's figures —, and Live and New in the pool say which read did not answer — nothing stays a skeleton", async () => {
    const d = await run("/", { down: true });
    await settled();
    await settled();
    // The poll's own reason: liveStats reads /api/v1/stats with fetch, so a 500 is its status.
    const reason = "the pool's stats did not answer: HTTP 500";
    for (const k of ["pkgs", "edge", "rel", "src"]) {
      expect(d.nodes[`#n-${k}`]?.textContent, `#n-${k}`).toBe("—");
      expect(html(d, `#s-${k}`), `#s-${k}`).toBe(`<span title="${reason}">did not answer</span>`);
    }
    expect(html(d, "#pool-sources")).not.toMatch(/<b>\d/);
    expect(html(d, "#pool-sources")).toContain("<b>—</b>");
    for (const r of ["edge", "rc", "stable"]) expect(d.nodes[`#fl-${r}`]?.textContent, `#fl-${r}`).toBe("—");
    expect(html(d, "#live-feed")).toBe(`<div><p class="home-quiet">${reason}</p></div>`);
    expect(html(d, "#pool-new")).toBe(`<p class="home-quiet">${reason}</p>`);
    expect(html(d, "#live-feed") + html(d, "#pool-new")).not.toMatch(/skl|No package moved|Nothing new/);
  });

  it("/status: the service line says the check did not answer, with the Worker's reason and no TypeError", async () => {
    const d = await run("/status", { down: true });
    await settled();
    const svc = html(d, "#service");
    expect(svc).toContain(`the service check did not answer: ${INTERNAL}`);
    expect(svc).not.toContain("TypeError");
    expect(svc).not.toContain("answering ·");
  });

  it("/status, the stats answering and the worker listing not: the Jobs tile says the listing did not answer where the workers' clause would be", async () => {
    const d = await run("/status", { down: true, up: /^\/api\/v1\/(stats|status|cost)/ });
    await settled();
    const jobs = tiles(d, "#systiles")[0];
    expect(jobs).toContain("Jobs waiting now");
    expect(jobs).toContain(`the worker listing did not answer: ${INTERNAL}`);
    expect(jobs).not.toContain("worker(s) alive");
  });
});
