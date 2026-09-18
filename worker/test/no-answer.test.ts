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
 * the page's line says which list did not answer and why, every tile
 * reads "—" and none reads 0, no empty state — "nothing waiting", "no
 * promotion yet", "no worker alive" — stands in for a list that failed,
 * and a refresh that fails leaves the rows of the last answer on screen.
 * The shell's rule comes first: api() rejects on a 5xx with the body's
 * error (or "HTTP <status>" when there is no body) and resolves a 4xx with
 * its body and __status, since the pages read `can`, a 403 and a 404 from
 * it. No poll may reject unhandled — the runtime would report it here.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { HELPERS } from "../src/pages/layout";
import { runScript, scriptOf, seedDashboard, type Fixture, type Ran } from "./fixture";

let F: Fixture;

beforeAll(async () => {
  F = await seedDashboard(env);
});

/** The Worker's own answer to a path, as a browser on the dashboard would get it: nobody signed in. */
async function real(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const INTERNAL = "internal error";
/** What index.ts answers when a route throws. */
const failed = () => new Response(JSON.stringify({ error: INTERNAL }), { status: 500, headers: { "content-type": "application/json" } });

/**
 * A fetch for the page under test: the session probe answers 401 as it does for nobody, and every other read answers
 * the Worker's 500 — or, while `down` is false, the Worker's real answer over the fixture, for the refresh test.
 */
function fetchThat(state: { down: boolean }): (path: string, init?: RequestInit) => Promise<Response> {
  return (path, init) => {
    if (path === "/auth/me") return Promise.resolve(new Response(JSON.stringify({ error: "no session" }), { status: 401, headers: { "content-type": "application/json" } }));
    return state.down ? Promise.resolve(failed()) : real(path, init);
  };
}

/** The served page's script, run with that fetch; `functions` are the page's own to call again. */
async function run(path: string, state: { down: boolean }, functions: string[] = []): Promise<Ran> {
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
/** Every tile says "—" for its number and the reason under it; none says a number. */
function expectDashes(d: Ran, n: number, reason: string, sel = "#tiles") {
  const t = tiles(d, sel);
  expect(t, `${sel}: ${n} tiles`).toHaveLength(n);
  for (const html of t) {
    expect(html).toContain('<div class="v num">—</div>');
    expect(html).toContain(reason);
    expect(html).not.toMatch(/<div class="v num[^"]*">\d/);
  }
}

describe("the shell's api()", () => {
  const shell = (fetch: (path: string) => Promise<Response>) => {
    const src = HELPERS.split("__POOL_URL__").join("http://pool.test").split("__RINGS_TEXT__").join("{}").split("__WICON__").join("{}").split("__LATE_AFTER_HOURS__").join("9");
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
  it("/review: the note names the list, the tiles and the queue line read —, the table draws no 'nothing waiting'", async () => {
    const d = await run("/review", { down: true });
    await settled();
    const reason = `the review list did not answer: ${INTERNAL}`;
    expect(d.nodes["#queue-note"].textContent).toBe(reason);
    expectDashes(d, 4, reason);
    expect(tiles(d)[0]).toContain("Waiting for review");
    expect(d.nodes["#mine-queue"].innerHTML).toContain("<b>—</b> waiting for a maintainer");
    expect(d.nodes["#mine-queue"].innerHTML).not.toContain("<b>0</b>");
    expect(html(d, "#staged tbody")).not.toContain("nothing waiting for review");
    expect(html(d, "#decisions tbody")).not.toContain("no decision yet");
  });

  it("/review: a refresh that fails leaves the last answer's rows and numbers on screen, and says so", async () => {
    const state = { down: false };
    const d = await run("/review", state, ["load"]);
    await settled();
    // The first load answered over the fixture: three waiting, rows in the table, the note counting them.
    expect(d.nodes["#queue-note"].textContent).toContain("3 waiting for a maintainer");
    const before = tiles(d);
    expect(before[0]).toContain('<div class="v num warn">3</div>');
    const rows = d.nodes["#staged tbody"].innerHTML;
    expect(rows).toContain(`id="t-${F.stagedTask}"`);
    state.down = true;
    d.load();
    await settled();
    expect(d.nodes["#queue-note"].textContent).toBe(`the review list did not answer: ${INTERNAL}`);
    expect(d.nodes["#staged tbody"].innerHTML).toBe(rows);
    expect(tiles(d)).toEqual(before);
  });

  it("/pipeline: the state row's note names the factory's lists, the six tiles read —, the flow and the queue draw nothing in their place, and every other read says so where it draws", async () => {
    const d = await run("/pipeline", { down: true });
    await settled();
    const reason = `the factory's lists did not answer: ${INTERNAL}`;
    expect(d.nodes["#lists-note"].textContent).toBe(reason);
    expectDashes(d, 6, reason);
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
    expectDashes(d, 5, reason);
    expect(tiles(d)[1]).toContain("Waiting for review");
    expect(html(d, "#landed")).toContain(reason);
    expect(html(d, "#landed")).not.toContain("nothing approved yet");
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
    expectDashes(d, 4, reason);
    for (const t of ["#w-project tbody", "#w-review tbody", "#w-community tbody"]) expect(html(d, t)).not.toMatch(/no (project|review|contributor's) worker/);
  });

  it("/people: the two lists say so, the four tiles read —", async () => {
    const d = await run("/people", { down: true });
    await settled();
    const reason = `the people's lists did not answer: ${INTERNAL}`;
    expect(html(d, "#maintainers-list")).toContain(reason);
    expect(html(d, "#contributors-list")).toContain(reason);
    expect(html(d, "#contributors-list")).not.toContain("be the first");
    expectDashes(d, 4, reason);
  });

  it("/: the Made-in-the-open row says so and its four tiles read —", async () => {
    const d = await run("/", { down: true });
    await settled();
    const reason = `the people's lists did not answer: ${INTERNAL}`;
    expect(html(d, "#cc-people")).toContain(reason);
    expect(html(d, "#cc-people")).not.toContain("be the first");
    expectDashes(d, 4, reason, "#open-stats");
  });

  it("/status: the service line says the check did not answer, with the Worker's reason and no TypeError", async () => {
    const d = await run("/status", { down: true });
    await settled();
    const svc = html(d, "#service");
    expect(svc).toContain(`the service check did not answer: ${INTERNAL}`);
    expect(svc).not.toContain("TypeError");
    expect(svc).not.toContain("answering ·");
  });
});
