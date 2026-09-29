/**
 * One state per worker, everywhere (#277), and the worker's own page: the
 * shell's wtState over every combination of what a listing's row says —
 * revoked, alive, a task in hand, drained, outdated past the grace, ready —
 * against the design's ranks; the counts every header says (a drained or
 * an outdated worker is never counted idle); the marks beside a state; and
 * /worker/:id served for every id, with the worker's own words never in a
 * public answer and its buttons grey, with the door's reason, for a viewer
 * who may not press them.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { HELPERS } from "../src/pages/layout";
import { runScript, scriptOf, seedDashboard, type Fixture } from "./fixture";

let F: Fixture;
beforeAll(async () => {
  F = await seedDashboard(env);
});

function shell(): { wtState: (w: unknown) => string; workerCounts: (ws: unknown[]) => any; wtStatus: (w: unknown) => string; wtMarks: (w: unknown) => string; wtId: (w: unknown) => string; workerName: (w: unknown) => string } {
  const src = HELPERS.split("__POOL_URL__").join("http://pool.test").split("__RINGS_TEXT__").join("{}").split("__WICON__").join("{}").split("__LATE_AFTER_HOURS__").join("9").split("__PROMISED_RINGS__").join("[]").split("__ARCHES__").join("[]").split("__SEVERITIES__").join("[]").split("__WORKER_ALIVE_MINUTES__").join("10");
  return runScript(src, { pathname: "/workers", functions: ["wtState", "workerCounts", "wtStatus", "wtMarks", "wtId", "workerName"] }) as any;
}

async function get(path: string, cookie?: string): Promise<{ status: number; text: string }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, { headers: cookie ? { cookie } : {} }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, text: await res.text() };
}

describe("one state per worker", () => {
  it("is the first of revoked, offline, building, drained, outdated, not ready, idle that holds — over every combination", () => {
    const { wtState } = shell();
    const rank = ["revoked", "offline", "building", "drained", "outdated", "not ready", "idle"];
    for (let bits = 0; bits < 64; bits++) {
      const [revoked, alive, task, drained, outdated, ready] = [1, 2, 4, 8, 16, 32].map((b) => !!(bits & b));
      const w = { id: "w", revoked_at: revoked ? "2026-09-29T00:00:00Z" : null, alive, current_task: task ? 812 : null, drained: drained ? { at: "x", by: "m1", reason: "disk" } : null, update: { required: outdated }, ready, last_seen: "2026-09-29T00:00:00Z" };
      const want = revoked ? "revoked" : !alive ? "offline" : task ? "building" : drained ? "drained" : outdated ? "outdated" : !ready ? "not ready" : "idle";
      expect(wtState(w), JSON.stringify(w)).toBe(want);
      expect(rank).toContain(want);
    }
  });

  it("counts a drained or outdated worker as what it is, never idle; a busy one busy, whatever else it is", () => {
    const { workerCounts, wtStatus } = shell();
    const w = (o: Record<string, unknown>) => ({ id: "w", alive: true, ready: true, current_task: null, drained: null, update: { required: false }, last_seen: "2026-09-29T00:00:00Z", ...o });
    const ws = [
      w({ drained: { by: "m1" } }),
      w({ drained: { by: "m1" }, update: { required: true, yours: "v1", latest: "v2" } }),
      w({ drained: { by: "m1" }, current_task: 812 }),
      w({ update: { required: true, yours: "v1", latest: "v2" }, ready: false }),
      w({ ready: false }),
      w({}),
      w({ alive: false }),
    ];
    const c = workerCounts(ws);
    expect({ building: c.building, idle: c.idle, notReady: c.notReady, outdated: c.outdated, drained: c.drained, alive: c.alive, registered: c.registered }).toEqual({ building: 1, idle: 1, notReady: 1, outdated: 1, drained: 2, alive: 6, registered: 7 });
    expect(wtStatus(ws[0])).toContain(">drained<");
    expect(wtStatus(ws[3])).toContain(">outdated<");
    expect(wtStatus(ws[4])).toContain(">failed<");
  });

  it("draws what the pool does beside the state, as marks that never change it, and links every worker to its page", () => {
    const { wtStatus, wtMarks, wtId, workerName } = shell();
    const w = { id: "studio-review-aarch64", alive: true, ready: false, current_task: null, update: { required: false }, last_seen: "2026-09-29T00:00:00Z", open_orders: [{ id: "wo_1", kind: "restart", state: "pending", by: "pool", at: "2026-09-29T00:00:00Z" }], two_processes_since: "2026-09-29T00:00:00Z", crash_loop_since: "2026-09-29T00:00:00Z", watchdog: { n: 3, since: "2026-09-29T00:00:00Z", stuck_in: "task" }, pool_gave_up: "2026-09-29T00:00:00Z" };
    const marks = wtMarks(w);
    for (const word of ["restart waiting", "two processes", "crash-looping?", "watchdog ×3", "the pool gave up"]) expect(marks).toContain(word);
    expect(wtStatus(w)).toContain(">failed<");
    expect(wtMarks({ id: "x" })).toBe("");
    expect(wtId(w)).toContain('href="/worker/studio-review-aarch64"');
    expect(workerName(w)).toContain('href="/worker/studio-review-aarch64"');
  });
});

describe("the worker's page", () => {
  it("is served for every id, reads the worker and what the viewer may press, and never shows the worker's own words to the public", async () => {
    const page = await get(`/worker/${F.communityWorker}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<b id="wk-operate-h">Operate</b>');
    const script = scriptOf(page.text);
    expect(script).toContain('var ID = decodeURIComponent(location.pathname.replace(/^\\/worker\\//, ""));');
    expect((await get("/worker/nobody-at-all")).status).toBe(200);
    // The public read has the orders the fixture gave w3, with the pool's words and without the worker's.
    const pub = JSON.parse((await get(`/api/v1/factory/workers/${F.communityWorker}`)).text);
    expect(pub.orders.map((o: any) => [o.kind, o.state])).toEqual([["restart", "done"], ["recheck-agent", "done"]]);
    expect(pub.orders[0].detail).toContain("back as a new process");
    expect(JSON.stringify(pub)).not.toContain("812 ms");
    expect(pub.worker).not.toHaveProperty("instance");
    expect(pub.worker).not.toHaveProperty("site");
    expect(pub.worker).not.toHaveProperty("auto_orders");
    expect(pub.worker.takes_orders).toEqual(["drain", "recheck-agent", "restart"]);
    // Its owner reads them.
    const mine = JSON.parse((await get(`/api/v1/factory/workers/${F.communityWorker}/orders`, `omc=${F.sessions.owner}`)).text);
    expect(mine.orders.find((o: any) => o.kind === "recheck-agent").worker_detail).toContain("812 ms");
    // The listing every page reads carries no process, site or rules' state either.
    const listing = JSON.parse((await get("/api/v1/factory?live=1")).text);
    const w3 = listing.workers.find((w: any) => w.id === F.communityWorker);
    for (const k of ["instance", "instance_prev", "site", "auto_orders", "agent_error_class", "agent_probed_at", "worker_detail"]) expect(w3, k).not.toHaveProperty(k);
  });

  it("greys every button with the door's own reason for a viewer who may not press it", async () => {
    const can = async (cookie?: string) => JSON.parse((await get(`/api/v1/factory/workers/${F.communityWorker}/can`, cookie)).text);
    const nobody = await can();
    expect(nobody.can).toMatchObject({ recheck: false, restart: false, restart_agent: false });
    expect(nobody.why.restart).toBe("sign in with GitHub");
    const stranger = await can(`omc=${F.sessions.contributor}`);
    expect(stranger.why.restart).toBe(`only ${F.owner} or a maintainer gives it orders`);
    expect(stranger.details).toBe(false);
    const owner = await can(`omc=${F.sessions.owner}`);
    expect(owner.can).toMatchObject({ recheck: true, restart: true, restart_agent: false });
    expect(owner.why.restart_agent).toContain("it calls no agent service of its own host");
    expect(owner.details).toBe(true);
    const maintainer = await can(`omc=${F.sessions.maintainer}`);
    expect(maintainer.can.restart).toBe(true);
    // m1's project worker has never said it takes orders: its image takes none, for everyone.
    const old = JSON.parse((await get(`/api/v1/factory/workers/${F.worker}/can`, `omc=${F.sessions.maintainer}`)).text);
    expect(old.why.restart).toContain("takes no orders");
  });

  it("says in the Factory's and Status's headers how many are drained and outdated, and never counts them idle", async () => {
    const factory = scriptOf((await get("/factory")).text);
    expect(factory).toContain('(wc.outdated ? " · " + num(wc.outdated) + " outdated" : "") + (wc.drained ? " · " + num(wc.drained) + " drained" : "")');
    const status = scriptOf((await get("/status")).text);
    expect(status).toContain('(c.outdated ? " · " + num(c.outdated) + " outdated" : "") + (c.drained ? " · " + num(c.drained) + " drained" : "")');
  });
});
