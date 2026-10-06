/**
 * Drain, Resume and Stop its task (#277, part 2), inside workerd with a
 * real D1: the pool carries them out itself, so they work on every image.
 *
 * - A drain holds from issue: the drained worker's claim is a 204, the
 *   first one hears the notice, the Build and project-build doors refuse to
 *   pin it, and the builds already pinned to it go to the shared queue once
 *   it has been drained FIRST_PICK_MINUTES. Resume ends it, by §1.10's
 *   table of who may.
 * - Stop its task fences the lease: still leased to its worker — no other
 *   worker takes it, the ring lock holds —, every heartbeat, report and
 *   upload refused with `409 {stop: true, state: "stopping"}`, nothing
 *   renewed; back to the queue at the worker's next claim, or when the lease
 *   ends. It never cancels. An audit's or a trial's report beside a staged
 *   build is taken only while the job's own task is still its worker's.
 * - The record: one issue line and one final line per order, whichever
 *   path closed it; and what the planner reads for every new statement.
 *
 * Tokens: workers omw_<id>, people's CLI omc_<login>, sessions oms_<login>.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { requeueExpiredLeases } from "../src/routes/factory";
import { DRAINED_PINS_SQL, ISSUE_SQL, OPEN_ORDERS_SQL, RESUME_DRAIN_CLOSE_SQL, RESUME_DRAIN_LINE_SQL, STOPPED_TASK_SQL, STOPS_DUE_SQL, UNPIN_DRAINED_SQL, sweepOrders } from "../src/orders";
import { HELD_TASK_SQL } from "../src/routes/orders";
import { REQUEUE_SQL } from "../src/lease";
import { authorize } from "../src/auth";
import { SAME_AGENT_SQL } from "../src/routes/review";

const ORIGIN = "http://pool.test";
const API = `${ORIGIN}/api/v1`;
const MIN = 60000;
const hex = (n: number) => n.toString(16).padStart(32, "0");

interface Who { token?: string; cookie?: string; origin?: string | null; headers?: Record<string, string> }
async function call(method: string, path: string, body?: unknown, who: Who = {}, raw?: BodyInit): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...(who.headers ?? {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw !== undefined) headers["content-type"] = "application/octet-stream";
  if (who.token) headers.authorization = `Bearer ${who.token}`;
  if (who.cookie) headers.cookie = who.cookie;
  if (who.origin) headers.origin = who.origin;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const cli = (login: string): Who => ({ token: `omc_${login}` });
const page = (login: string): Who => ({ cookie: `omc=oms_${login}`, origin: ORIGIN });
const ARCH: Record<string, string> = {};
/** A claim of a worker that takes orders (instance n), its agent answering — and stops a task on the heartbeat's 409 (it declares stop-task, #277 part 2). */
const claimBody = (id: string, o: { instance?: number | null; orders?: string[] | null; kinds?: string[]; shared?: boolean } = {}) => ({
  arch: ARCH[id], version: "v1.0.2", agent: "claude-code/claude-sonnet-5", agent_status: "ok", agent_error: "", agent_checked_at: "2026-09-30T12:00:00Z", agent_via: "direct",
  ...(o.kinds ? { kinds: o.kinds } : {}), ...(o.shared ? { shared: true } : {}),
  ...(o.orders === null ? {} : { orders: o.orders ?? ["drain", "recheck-agent", "restart", "stop-task"] }),
  ...(o.instance === null ? {} : { instance: hex(o.instance ?? 1) }),
});
const claim = (id: string, o: Parameters<typeof claimBody>[1] = {}) => call("POST", "/factory/claim", claimBody(id, o), { token: `omw_${id}` });
const issue = (id: string, body: unknown, who: Who) => call("POST", `/factory/workers/${id}/orders`, body, who);
const taskOf = (id: number) => env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<any>();
const rowOf = (id: string) => env.DB.prepare("SELECT * FROM build_workers WHERE id = ?").bind(id).first<any>();
const orderOf = (oid: string) => env.DB.prepare("SELECT * FROM worker_orders WHERE id = ?").bind(oid).first<any>();
/**
 * env.DB, but the first statement whose SQL starts with `trigger` runs `before` first: what lands between a handler's read and the write
 * that follows it — a stop, a heartbeat —, as two requests interleave in production.
 */
function racing(trigger: string, before: () => Promise<unknown>): D1Database {
  let fired = false;
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const st = target.prepare(sql);
        if (fired || !sql.startsWith(trigger)) return st;
        fired = true;
        return { bind: (...a: unknown[]) => { const b = st.bind(...a); return { run: async () => { await before(); return b.run(); }, first: async () => { await before(); return b.first(); }, all: async () => { await before(); return b.all(); } }; } };
      };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}
/** A request through the Worker with another DB binding. */
async function callWith(db: D1Database, method: string, path: string, body: unknown, token: string): Promise<{ status: number; json: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), { ...env, DB: db }, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const linesOf = async (oid: string) => (await env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'order' AND json_extract(payload, '$.order') = ? ORDER BY id").bind(oid).all<{ status: string; summary: string; payload: string }>()).results;

async function seedWorker(id: string, arch: string, owner: string | null, trust: "project" | "community", extra: Record<string, unknown> = {}) {
  ARCH[id] = arch;
  const cols = ["id", "arch", "owner", "token_hash", "mode", "trust", "trusted_by", "last_seen", ...Object.keys(extra)];
  const vals = [id, arch, owner, await sha256Hex(`omw_${id}`), trust === "project" ? "shared" : "shared", trust, trust === "project" ? "m1" : null, new Date().toISOString(), ...Object.values(extra)];
  await env.DB.prepare(`INSERT INTO build_workers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...vals).run();
}
/** A task, as the queue holds it. */
async function seedTask(t: { name: string; arch?: string; kind?: string; trust?: "project" | "community"; owner?: string | null; params?: unknown; status?: string; attempts?: number; max_attempts?: number; pinned_to?: string | null; ref?: string; version?: string; priority?: number }): Promise<number> {
  return (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, attempts, max_attempts, pinned_to) VALUES (?, ?, ?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(t.name, t.arch ?? "aarch64", t.version ?? "1.2-1", t.ref ?? `https://github.com/x/${t.name}@v1:PKGBUILD`, t.priority ?? 100, t.status ?? "queued", t.trust === "project" && (t.kind ?? "build") !== "build" ? 1 : 0, t.trust ?? "community", t.owner ?? null, t.kind ?? "build", t.params === undefined ? null : JSON.stringify(t.params), t.attempts ?? 0, t.max_attempts ?? 3, t.pinned_to ?? null)
    .first<{ id: number }>())!.id;
}

beforeAll(async () => {
  const h = (t: string) => sha256Hex(t);
  await env.DB.batch([
    // m4 and m5 press the stops of the crossing cases: each login has its twenty orders an hour.
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2'), ('m3'), ('m4'), ('m5')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('m1', ?, ?, 'maintainer'), ('m2', ?, ?, 'maintainer'), ('m3', ?, ?, 'maintainer'), ('m4', ?, ?, 'maintainer'), ('m5', ?, ?, 'maintainer'), ('alice', ?, ?, 'contributor'), ('bob', ?, ?, 'contributor'), ('carol', ?, ?, 'contributor')`)
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_m3"), await h("oms_m3"), await h("omc_m4"), await h("oms_m4"), await h("omc_m5"), await h("oms_m5"), await h("omc_alice"), await h("oms_alice"), await h("omc_bob"), await h("oms_bob"), await h("omc_carol"), await h("oms_carol")),
    env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('felix', 'bob', 'https://github.com/bob/felix', '["aarch64"]', 'waiting'), ('gus', 'bob', 'https://github.com/bob/gus', '["aarch64"]', 'waiting'), ('hana', 'bob', 'https://github.com/bob/hana', '["aarch64"]', 'waiting')`),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Stop its task: the lease fenced, the task back in the queue once its worker has stopped", () => {
  it("the owner of a community worker stops a stranger's build it runs: still leased, fenced, nothing cancelled, and nobody else takes it", async () => {
    await seedWorker("alice-box", "aarch64", "alice", "community");
    await seedWorker("carol-box", "aarch64", "carol", "community");
    const t = await seedTask({ name: "felix", owner: "bob" });
    const c = await claim("alice-box", { shared: true, instance: 10 });
    expect(c.status).toBe(200);
    expect(c.json.task.id).toBe(t);
    const before = await taskOf(t);
    // Before the stop, its uploads are taken, as on main.
    expect((await call("PUT", `/factory/tasks/${t}/artifacts/build.log`, undefined, { token: c.json.token }, "==> building\n")).status).toBe(201);
    // Who may not: the build's owner who does not own the worker, another contributor, nobody signed in.
    expect((await issue("alice-box", { kind: "stop-task", task: t }, cli("bob"))).status).toBe(403);
    expect((await issue("alice-box", { kind: "stop-task", task: t }, cli("carol"))).status).toBe(403);
    expect((await issue("alice-box", { kind: "stop-task", task: t }, { origin: ORIGIN })).status).toBe(401);
    expect((await taskOf(t)).stop_order).toBeNull();
    // What /can says of it: the task, how it stops (a build: its child, or its next call while it transfers), the latest it goes back.
    const can = await call("GET", "/factory/workers/alice-box/can", undefined, page("alice"));
    expect(can.json.can.stop_task).toBe(true);
    expect(can.json.stop).toMatchObject({ task: t, kind: "build", stops: "child-or-call", attempt: 1, max_attempts: 3, words: "felix 1.2-1, aarch64, bob's build", stopping: false });
    const r = await issue("alice-box", { kind: "stop-task", task: t, reason: "hangs in check()" }, page("alice"));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // The latest it goes back to the queue, for the page to say on its reader's clock; the door's own note says the pool's, and says so.
    expect(r.json.order).toMatchObject({ kind: "stop-task", task: t, issued_by: "alice", state: "pending", until: before.lease_expires_at });
    expect(r.json.note).toContain("Nothing is cancelled");
    expect(r.json.note).toContain(`(by ${before.lease_expires_at.slice(11, 16)} UTC at the latest)`);
    const after = await taskOf(t);
    expect(after).toMatchObject({ status: "leased", lease_owner: "alice-box", stop_order: r.json.order.id, lease_expires_at: before.lease_expires_at });
    const lines = await linesOf(r.json.order.id);
    expect(lines).toHaveLength(1);
    expect(lines[0].summary).toBe(`alice-box: task #${t} (felix 1.2-1, aarch64, bob's build) stopped by alice — hangs in check(); back in the queue once this worker has stopped it (attempt 1 of 3)`);
    // Another community worker's claim does not get it: it is still leased.
    expect((await claim("carol-box", { shared: true, instance: 20 })).status).toBe(204);
    // The page sees it stopping, from the row alone; /can greys the button with why.
    const view = await call("GET", "/factory/workers/alice-box");
    expect(view.json.worker.stopping).toMatchObject({ task: t, order: r.json.order.id, by: "alice" });
    const stoppingCan = (await call("GET", "/factory/workers/alice-box/can", undefined, page("alice"))).json;
    expect(stoppingCan).toMatchObject({ can: { stop_task: false }, stop: { stopping: true } });
    // An order given now goes once the task is back in the queue: the stop is under way, so the page no longer offers a stop to deliver it sooner.
    expect(stoppingCan.note).toBe(`delivered with its next claim — once task #${t}, which is being stopped, is back in the queue: the claim that gives it back carries the order`);
    // The task view spreads the row: it carries stop_order, which a broker's adopt() reads.
    const tv = await call("GET", `/factory/tasks/${t}?fresh=1`);
    expect(tv.json.task.stop_order).toBe(r.json.order.id);
    // Back in the queue by the fenced lease's own end, which nothing renews: the time the door answered and the worker's page says.
    expect(tv.json.stopping).toMatchObject({ order: r.json.order.id, by: "alice", until: before.lease_expires_at });

    // While it is fenced: every heartbeat refused, the lease not renewed, no token; the uploads and the reports refused.
    for (let i = 0; i < 2; i++) {
      const hb = await call("POST", `/factory/tasks/${t}/heartbeat`, {}, { token: c.json.token });
      expect(hb).toMatchObject({ status: 409, json: { stop: true, state: "stopping" } });
      expect(hb.json.token).toBeUndefined();
    }
    expect((await taskOf(t)).lease_expires_at).toBe(before.lease_expires_at);
    expect((await call("PUT", `/factory/tasks/${t}/artifacts/felix-1.2-1-aarch64.pkg.tar.zst`, undefined, { token: c.json.token }, "pkg")).json).toMatchObject({ stop: true, state: "stopping" });
    expect((await call("POST", `/factory/tasks/${t}/artifacts/big.pkg.tar.zst/multipart?action=create`, undefined, { token: c.json.token })).json).toMatchObject({ stop: true, state: "stopping" });
    expect((await call("POST", `/factory/tasks/${t}/complete`, { sha256: "0".repeat(64), filename: "x" }, { token: c.json.token })).json).toMatchObject({ stop: true, state: "stopping" });
    expect((await call("POST", `/factory/tasks/${t}/fail`, { error: "x" }, { token: c.json.token })).json).toMatchObject({ stop: true, state: "stopping" });
    // Taking it back is refused: the worker may have killed the task already.
    const del = await call("DELETE", `/factory/workers/alice-box/orders/${r.json.order.id}`, undefined, cli("alice"));
    expect(del).toMatchObject({ status: 409, json: { error: `task #${t} is being stopped already: it goes back to the queue once this worker has stopped it` } });
    expect((await taskOf(t)).stop_order).toBe(r.json.order.id);

    // The worker's next claim is the proof its processes are gone: the task goes back to the queue, behind its peers; the order is done.
    const next = await claim("alice-box", { instance: 10 });
    expect(next.status).toBe(204); // alice-box is dedicated at this claim (no shared): nothing of alice's to take
    expect(await taskOf(t)).toMatchObject({ status: "queued", lease_owner: null, lease_expires_at: null, stop_order: null, priority: before.priority + 10 });
    expect((await taskOf(t)).error).toBe("stopped on alice-box by alice: hangs in check()");
    expect((await rowOf("alice-box")).current_task).toBeNull();
    // The task view, read past its edge cache as a broker's adopt() reads it: the fence is gone with the requeue.
    const back = await call("GET", `/factory/tasks/${t}?fresh=2`);
    expect(back.json.task).toMatchObject({ status: "queued", stop_order: null });
    expect(back.json.stopping).toBeNull();
    expect((await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'felix'").first<{ status: string }>())!.status).toBe("waiting");
    const o = await orderOf(r.json.order.id);
    expect(o).toMatchObject({ state: "done", answered_by: "pool" });
    expect(o.detail).toMatch(new RegExp(`^stopped: it claimed again \\d+ min after the order; task #${t} is back in the queue$`));
    expect((await linesOf(r.json.order.id)).map((l) => JSON.parse(l.payload).state)).toEqual(["pending", "done"]);
    const build = await env.DB.prepare("SELECT status, summary FROM events WHERE kind = 'build' AND json_extract(payload, '$.task') = ? ORDER BY id").bind(t).all<{ status: string; summary: string }>();
    expect(build.results.map((l) => l.summary)).toEqual([`felix for aarch64: stopped on alice-box by alice: hangs in check() — back in the queue`]);
    // Nothing of the stranger's was cancelled: another worker takes it.
    const other = await claim("carol-box", { shared: true, instance: 20 });
    expect(other.json.task.id).toBe(t);
    // Once another worker holds it, the stopped token hears whose it is now.
    expect((await call("POST", `/factory/tasks/${t}/heartbeat`, {}, { token: c.json.token })).json).toMatchObject({ stop: true, state: "leased" });
    await call("POST", `/factory/tasks/${t}/fail`, { error: "done testing", final: true }, { token: other.json.token });
  });

  it("a maintainer stops a project worker's task; a worker with no task, or a task it no longer holds, is refused; two stops at once fence once", async () => {
    await seedWorker("pool-c", "aarch64", "m1", "project");
    expect((await issue("pool-c", { kind: "stop-task" }, cli("m2"))).json).toMatchObject({ error: "idle: there is no task to stop" });
    const a = await seedTask({ name: "sync", kind: "sync", trust: "project", params: { arch: "aarch64", sources: "[]" } });
    const c = await claim("pool-c", { kinds: ["sync"], instance: 30 });
    expect(c.json.task.id).toBe(a);
    // The page was stale: it names a task the worker no longer holds.
    expect((await issue("pool-c", { kind: "stop-task", task: a + 1000 }, cli("m2"))).json).toMatchObject({ error: `it holds #${a} now, not #${a + 1000}` });
    expect((await taskOf(a)).stop_order).toBeNull();
    const can = await call("GET", "/factory/workers/pool-c/can", undefined, cli("m2"));
    expect(can.json.stop).toMatchObject({ stops: "next-call" });
    const [x, y] = await Promise.all([issue("pool-c", { kind: "stop-task", task: a }, cli("m2")), issue("pool-c", { kind: "stop-task", task: a }, cli("m3"))]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM worker_orders WHERE worker_id = 'pool-c' AND kind = 'stop-task'").first<{ n: number }>())!.n).toBe(1);
    expect((await taskOf(a)).stop_order).toBe((x.status === 201 ? x : y).json.order.id);
    // Its next claim gives the task back; nothing else is queued for it, so it answers 204 — or takes it again: the task is anyone's.
    const back = await claim("pool-c", { kinds: ["sync"], instance: 30 });
    expect([200, 204]).toContain(back.status);
    if (back.status === 200) await call("POST", `/factory/tasks/${back.json.task.id}/fail`, { error: "test", final: true }, { token: back.json.token });
  });

  it("on its last attempt the task fails at the requeue, its staged packages reclaimed, and the final line says so", async () => {
    await seedWorker("alice-box2", "aarch64", "alice", "community");
    const t = await seedTask({ name: "gus", owner: "bob", attempts: 2, max_attempts: 3 });
    const c = await claim("alice-box2", { shared: true, instance: 40 });
    expect(c.json.task.id).toBe(t);
    expect((await call("PUT", `/factory/tasks/${t}/artifacts/gus-1.2-1-aarch64.pkg.tar.zst`, undefined, { token: c.json.token }, "pkg")).status).toBe(201);
    const r = await issue("alice-box2", { kind: "stop-task", task: t }, cli("alice"));
    expect(r.status).toBe(201);
    expect((await linesOf(r.json.order.id))[0].summary).toContain("; it fails then: that was its last attempt");
    await claim("alice-box2", { instance: 40 });
    expect(await taskOf(t)).toMatchObject({ status: "failed", stop_order: null });
    expect((await orderOf(r.json.order.id)).detail).toContain(`task #${t} failed: that was its last attempt`);
    expect((await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ?").bind(t).all()).results.map((o: any) => o.key.split("/").pop())).toEqual([]);
    expect((await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'gus'").first<{ status: string }>())!.status).toBe("registered");
  });

  it("never cancels: a claim's rebuild goes back to the queue still pinned to its worker, with its params; an approved publish job still publishes", async () => {
    await seedWorker("review-p", "aarch64", "m1", "project", { labels: '{"role":"review"}' });
    const rebuild = await seedTask({ name: "hana", trust: "project", owner: "bob", ref: "review:77", pinned_to: "review-p", params: { review: 77, agent: "claude-code/claude-sonnet-5", by: "m1" } });
    const c = await claim("review-p", { kinds: ["build"], instance: 50 });
    expect(c.json.task.id).toBe(rebuild);
    expect((await issue("review-p", { kind: "stop-task", task: rebuild }, cli("m2"))).status).toBe(201);
    // Its next claim gives it back — pinned to it, so the same claim may take it again.
    const again = await claim("review-p", { kinds: ["build"], instance: 50 });
    const t = await taskOf(rebuild);
    expect(t.pinned_to).toBe("review-p");
    expect(JSON.parse(t.params)).toMatchObject({ review: 77, agent: "claude-code/claude-sonnet-5" });
    expect(t.status === "queued" || (t.status === "leased" && again.json?.task?.id === rebuild)).toBe(true);
    if (again.status === 200) await call("POST", `/factory/tasks/${again.json.task.id}/fail`, { error: "test", final: true }, { token: again.json.token });
    // An approved publish job: back in the queue, a publish still.
    await seedWorker("pool-pub", "aarch64", "m1", "project");
    const pub = await seedTask({ name: "hana", kind: "publish", trust: "project", params: { task: 77, name: "hana", arch: "aarch64" } });
    const pc = await claim("pool-pub", { kinds: ["publish"], instance: 51 });
    expect(pc.json.task.id).toBe(pub);
    expect((await issue("pool-pub", { kind: "stop-task", task: pub }, cli("m2"))).status).toBe(201);
    await claim("pool-pub", { kinds: ["sync"], instance: 51 });
    expect(await taskOf(pub)).toMatchObject({ status: "queued", kind: "publish" });
  });

  it("the ring race (rc#34's shape): a stopped promote holds its ring until its worker has stopped or its lease has ended — never two runners", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedWorker("pool-ra", "aarch64", "m1", "project");
    await seedWorker("pool-rb", "aarch64", "m1", "project");
    const p1 = await seedTask({ name: "promote", kind: "promote", trust: "project", params: { from: "edge", to: "rc" }, priority: 50 });
    const p2 = await seedTask({ name: "promote", kind: "promote", trust: "project", params: { from: "edge", to: "rc" }, priority: 60 });
    const a = await claim("pool-ra", { kinds: ["promote"], instance: 60 });
    expect(a.json.task.id).toBe(p1);
    const r = await issue("pool-ra", { kind: "stop-task", task: p1 }, cli("m1"));
    expect(r.status).toBe(201);
    const canRelease = async () => authorize(new Request(`${API}/releases`, { method: "POST", headers: { authorization: `Bearer ${a.json.token}` } }), env, "release:rc");
    // For 29 minutes, B gets neither the stopped promote nor another mover of rc: the ring lock still sees the lease.
    for (const m of [1, 10, 29]) {
      vi.setSystemTime(t0 + m * MIN);
      expect((await claim("pool-rb", { kinds: ["promote"], instance: 61 })).status, `minute ${m}`).toBe(204);
    }
    // A's token is still valid until its e: a write it makes lands while the task is still A's, and there is no second runner.
    expect(await canRelease()).toBeNull();
    // A never claims (an image that does not stop, or wedged): the lease's end gives the task back, every token of it expired.
    vi.setSystemTime(t0 + 31 * MIN);
    expect(await requeueExpiredLeases(env)).toBe(1);
    expect((await canRelease())!.status).toBe(401);
    expect(await taskOf(p1)).toMatchObject({ status: "queued", stop_order: null });
    expect((await taskOf(p1)).error).toBe("stopped on pool-ra by m1: Stop its task from the worker's page; its lease ended");
    await sweepOrders(env, t0 + 31 * MIN);
    const o = await orderOf(r.json.order.id);
    expect(o.state).toBe("failed");
    expect(o.detail).toContain("no claim before its lease ended");
    expect((await linesOf(r.json.order.id)).map((l) => JSON.parse(l.payload).state)).toEqual(["pending", "failed"]);
    // Only now does B get it.
    const b = await claim("pool-rb", { kinds: ["promote"], instance: 61 });
    expect(b.json.task.id).toBe(p1);
    await call("POST", `/factory/tasks/${p1}/fail`, { error: "test", final: true }, { token: b.json.token });
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(p2).run();
  });

  it("a claim during a two-process conflict requeues nothing, a revoked worker's stop is cancelled and its lease still ends, the restart group's cap counts a stop", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedWorker("pool-cf", "aarch64", "m1", "project");
    // Two processes on the token: 70 claims, then 71, then 70 again — and 70 is handed the task.
    await claim("pool-cf", { kinds: ["render"], instance: 70 });
    vi.setSystemTime(t0 + MIN);
    await claim("pool-cf", { kinds: ["render"], instance: 71 });
    const t = await seedTask({ name: "render", kind: "render", trust: "project", params: { ring: "edge", arch: "aarch64" } });
    vi.setSystemTime(t0 + 2 * MIN);
    const c = await claim("pool-cf", { kinds: ["render"], instance: 70 });
    expect(c.json.task.id).toBe(t);
    expect((await rowOf("pool-cf")).instance_conflict_at).not.toBeNull();
    // A stop is the pool's to carry out: two processes do not hold it.
    const r = await issue("pool-cf", { kind: "stop-task" }, cli("m1"));
    expect(r.status).toBe(201);
    // The other process claims: it may not be the one that ran the task — nothing is requeued; the lease's end decides.
    vi.setSystemTime(t0 + 3 * MIN);
    expect((await claim("pool-cf", { kinds: ["render"], instance: 71 })).status).toBe(204);
    expect(await taskOf(t)).toMatchObject({ status: "leased", stop_order: r.json.order.id });
    // Revoked: the order is cancelled with its line, the fence stays, and the lease's end gives the task back.
    expect((await call("DELETE", "/factory/workers/pool-cf", undefined, cli("m1"))).status).toBe(200);
    expect((await orderOf(r.json.order.id)).state).toBe("cancelled");
    expect((await taskOf(t)).stop_order).toBe(r.json.order.id);
    vi.setSystemTime(t0 + 33 * MIN);
    await requeueExpiredLeases(env);
    expect(await taskOf(t)).toMatchObject({ status: "queued", stop_order: null });
    await sweepOrders(env, t0 + 33 * MIN);
    expect((await linesOf(r.json.order.id)).map((l) => JSON.parse(l.payload).state)).toEqual(["pending", "cancelled"]);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(t).run();
    // Six of the restart group in an hour, a stop among them: the seventh is refused.
    vi.useRealTimers();
    await seedWorker("pool-cap", "aarch64", "m1", "project");
    await claim("pool-cap", { kinds: ["gc"], instance: 80, orders: ["drain", "restart"] });
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare("INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, issued_at, expires_at, state) VALUES (?, 'pool-cap', 'restart', 'r', 'm1', ?, ?, 'done')").bind(`wo_cap${i}`, new Date(Date.now() - (5 - i) * MIN).toISOString(), new Date(Date.now() + 60 * MIN).toISOString()).run();
    }
    const g = await seedTask({ name: "gc", kind: "gc", trust: "project", params: {} });
    expect((await claim("pool-cap", { kinds: ["gc"], instance: 80, orders: ["drain", "restart"] })).json.task.id).toBe(g);
    expect((await issue("pool-cap", { kind: "stop-task" }, cli("m2"))).status).toBe(201);
    await claim("pool-cap", { kinds: ["none"], instance: 80, orders: ["drain", "restart"] });
    const seventh = await issue("pool-cap", { kind: "restart" }, cli("m2"));
    expect(seventh).toMatchObject({ status: 409, json: { error: expect.stringContaining("restarted 6 times in the last hour") } });
  });

  it("an audit's and a trial's report beside a staged build: taken while the job's own task is its worker's; refused once it is stopped, and after, to the stopped token", async () => {
    await seedWorker("pool-au", "aarch64", "m1", "project");
    await seedWorker("pool-av", "aarch64", "m1", "project");
    const staged = await seedTask({ name: "hana", owner: "bob", status: "staged" });
    await env.DB.prepare("UPDATE build_tasks SET staged_prefix = ? WHERE id = ?").bind(`staging/bob/hana/${staged}/`, staged).run();
    for (const [kind, file] of [["audit", "audit.json"], ["trial", "trial.log"]] as const) {
      const job = await seedTask({ name: "hana", kind, trust: "project", params: { task: staged, name: "hana", arch: "aarch64" }, priority: 40 });
      const a = await claim("pool-au", { kinds: [kind], instance: 90 });
      expect(a.json.task.id, kind).toBe(job);
      // Before the stop: taken, as on main.
      expect((await call("PUT", `/factory/tasks/${staged}/artifacts/${file}`, undefined, { token: a.json.token }, "first\n")).status, kind).toBe(201);
      const r = await issue("pool-au", { kind: "stop-task", task: job }, cli("m1"));
      expect(r.status).toBe(201);
      const before = await env.DB.prepare("SELECT size, uploaded_at FROM staging_objects WHERE task_id = ? AND key LIKE ?").bind(staged, `%/${file}`).first();
      // The path names the staged build; the job's own task is fenced: refused, and staging unchanged.
      const put = await call("PUT", `/factory/tasks/${staged}/artifacts/${file}`, undefined, { token: a.json.token }, "stopped one, late\n");
      expect(put, kind).toMatchObject({ status: 409, json: { stop: true, state: "stopping" } });
      expect(await env.DB.prepare("SELECT size, uploaded_at FROM staging_objects WHERE task_id = ? AND key LIKE ?").bind(staged, `%/${file}`).first()).toEqual(before);
      expect(await (await env.STAGING.get(`staging/bob/hana/${staged}/${file}`))!.text()).toBe("first\n");
      // The stopped worker claims again: the job goes back; another worker runs it and attaches its own report.
      await claim("pool-au", { kinds: ["none"], instance: 90 });
      const b = await claim("pool-av", { kinds: [kind], instance: 91 });
      expect(b.json.task.id).toBe(job);
      expect((await call("PUT", `/factory/tasks/${staged}/artifacts/${file}`, undefined, { token: b.json.token }, "second run\n")).status).toBe(201);
      // The stopped token, still within its e, is refused: the report is the second run's.
      expect((await call("PUT", `/factory/tasks/${staged}/artifacts/${file}`, undefined, { token: a.json.token }, "stale\n")).json).toMatchObject({ error: expect.stringContaining("the lease is not yours") });
      expect(await (await env.STAGING.get(`staging/bob/hana/${staged}/${file}`))!.text()).toBe("second run\n");
      await env.DB.prepare("UPDATE build_tasks SET status = 'done' WHERE id = ?").bind(job).run();
    }
  });

  it("how soon, per kind: /can words a check a child, a build a child or a call, a pool job its next call, and an image that takes no orders its lease's end", async () => {
    await seedWorker("pool-hw", "aarch64", "m1", "project");
    const h = await seedTask({ name: "health", kind: "health", trust: "project", params: { ring: "edge", arch: "aarch64" } });
    expect((await claim("pool-hw", { kinds: ["health"], instance: 95 })).json.task.id).toBe(h);
    expect((await call("GET", "/factory/workers/pool-hw/can", undefined, cli("m1"))).json.stop).toMatchObject({ stops: "child" });
    await env.DB.prepare("UPDATE build_workers SET order_kinds = NULL WHERE id = 'pool-hw'").run();
    const old = (await call("GET", "/factory/workers/pool-hw/can", undefined, cli("m1"))).json.stop;
    expect(old.stops).toBe("lease-end");
    expect(old.note).toContain("does not stop on the pool's word");
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(h).run();
  });
});

describe("the heartbeat's stop, whatever took the task back", () => {
  it("a cancelled task's heartbeat says stop on every call; a requeued one says queued, then leased once another worker holds it", async () => {
    await seedWorker("pool-hb", "x86_64", "m1", "project");
    await seedWorker("pool-hb2", "x86_64", "m1", "project");
    const t = await seedTask({ name: "sync", arch: "x86_64", kind: "sync", trust: "project", params: { arch: "x86_64", sources: "[]" } });
    const c = await claim("pool-hb", { kinds: ["sync"], instance: 100 });
    expect(c.json.task.id).toBe(t);
    expect((await call("POST", `/factory/tasks/${t}/heartbeat`, {}, { token: c.json.token })).status).toBe(200);
    // Taken back by the cron (a lease that expired), then another worker: "queued", then "leased".
    await env.DB.prepare("UPDATE build_tasks SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").bind(t).run();
    await requeueExpiredLeases(env);
    expect((await call("POST", `/factory/tasks/${t}/heartbeat`, {}, { token: c.json.token })).json).toMatchObject({ stop: true, state: "queued" });
    const d = await claim("pool-hb2", { kinds: ["sync"], instance: 101 });
    expect(d.json.task.id).toBe(t);
    expect((await call("POST", `/factory/tasks/${t}/heartbeat`, {}, { token: c.json.token })).json).toMatchObject({ stop: true, state: "leased" });
    // Cancelled (the API's door): stop, on every heartbeat.
    expect((await call("POST", `/factory/tasks/${t}/cancel`, undefined, cli("m1"))).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await call("POST", `/factory/tasks/${t}/heartbeat`, {}, { token: d.json.token })).json).toMatchObject({ stop: true, state: "cancelled" });
    // A task that does not exist: 404 (a job token for another task is a 403, as on main).
    expect((await call("POST", "/factory/tasks/999999/heartbeat", {}, { token: "omw_pool-hb2" })).status).toBe(404);
    expect((await call("POST", "/factory/tasks/999999/heartbeat", {}, { token: d.json.token })).status).toBe(403);
  });
});

describe("Drain and Resume: states the pool enforces at the claim", () => {
  it("a drain holds from issue: the worker hears it once, then gets nothing — a task waits for another worker", async () => {
    await seedWorker("pool-dr", "aarch64", "m1", "project");
    await seedWorker("pool-dr-old", "aarch64", "m1", "project");
    const t = await seedTask({ name: "sync", kind: "sync", trust: "project", params: { arch: "aarch64", sources: "[]" } });
    const r = await issue("pool-dr", { kind: "drain", reason: "disk swap" }, cli("m2"));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.note).toContain("the pool hands it nothing from its next claim");
    expect(await rowOf("pool-dr")).toMatchObject({ drained_by: "m2", drain_reason: "disk swap" });
    // An image from before orders is drained too: 204, though a task waits — and its drain is done, with no notice it would not read.
    const od = await issue("pool-dr-old", { kind: "drain" }, cli("m2"));
    const old = await claim("pool-dr-old", { kinds: ["sync"], orders: null, instance: null });
    expect(old.status).toBe(204);
    expect((await orderOf(od.json.order.id)).state).toBe("done");
    // The first claim of a process that understands notices hears it once; the order is done.
    const heard = await claim("pool-dr", { kinds: ["sync"], instance: 110 });
    expect(heard.status).toBe(200);
    expect(heard.json).toMatchObject({ task: null, orders: [{ kind: "drain", notice: true, id: r.json.order.id }] });
    expect(await orderOf(r.json.order.id)).toMatchObject({ state: "done" });
    expect((await claim("pool-dr", { kinds: ["sync"], instance: 110 })).status).toBe(204);
    expect((await taskOf(t)).status).toBe("queued");
    // Drained twice: refused with who and why; a drain cannot be taken back — Resume ends it.
    expect((await issue("pool-dr", { kind: "drain" }, cli("m1"))).json.error).toMatch(/^drained already \(by m2, \d\d:\d\d UTC: disk swap\) — Resume ends it$/);
    // The listing says so, and never counts it idle.
    const view = (await call("GET", "/factory/workers/pool-dr")).json.worker;
    expect(view.drained).toMatchObject({ by: "m2", reason: "disk swap" });
    // Resume: handed work again at its next claim; the resume is done at issue, with its two lines.
    const res = await issue("pool-dr", { kind: "resume" }, cli("m1"));
    expect(res.status).toBe(201);
    expect(res.json.order.state).toBe("done");
    expect((await rowOf("pool-dr")).drained_at).toBeNull();
    expect((await linesOf(res.json.order.id)).map((l) => JSON.parse(l.payload).state)).toEqual(["pending", "done"]);
    expect((await linesOf(res.json.order.id))[0].summary).toContain("(drained by m2");
    const back = await claim("pool-dr", { kinds: ["sync"], instance: 110 });
    expect(back.json.task.id).toBe(t);
    await call("POST", `/factory/tasks/${t}/fail`, { error: "test", final: true }, { token: back.json.token });
    // Resume of a worker that is not drained: nothing to resume.
    expect((await issue("pool-dr", { kind: "resume" }, cli("m1"))).json.error).toBe("it is not drained: there is nothing to resume");
  });

  it("a resume that comes before the drain was heard closes the drain too, one final line each", async () => {
    await seedWorker("pool-dq", "aarch64", "m1", "project");
    const d = await issue("pool-dq", { kind: "drain" }, cli("m1"));
    const r = await issue("pool-dq", { kind: "resume" }, cli("m2"));
    expect(r.status).toBe(201);
    expect(await orderOf(d.json.order.id)).toMatchObject({ state: "done", detail: "resumed by m2 before its next claim" });
    expect((await linesOf(d.json.order.id)).map((l) => JSON.parse(l.payload).state)).toEqual(["pending", "done"]);
  });

  it("who resumes, by §1.10's table — five cells — and nobody else, for each", async () => {
    await seedWorker("proj-t", "aarch64", "m1", "project");
    await seedWorker("alice-t", "aarch64", "alice", "community");
    const drain = async (id: string, who: string) => expect((await issue(id, { kind: "drain", reason: "because" }, cli(who))).status).toBe(201);
    const resume = (id: string, who: string) => issue(id, { kind: "resume" }, cli(who));
    // A project worker any maintainer drained: any maintainer.
    await drain("proj-t", "m2");
    expect((await resume("proj-t", "carol")).status).toBe(403);
    expect((await resume("proj-t", "m3")).status).toBe(201);
    // A contributor's worker its owner drained: its owner only.
    await drain("alice-t", "alice");
    expect((await resume("alice-t", "m1")).json).toMatchObject({ error: expect.stringContaining("alice drained it") });
    expect((await resume("alice-t", "carol")).status).toBe(403);
    expect((await resume("alice-t", "alice")).status).toBe(201);
    // A contributor's worker a maintainer drained: its owner, or any maintainer.
    await drain("alice-t", "m1");
    expect((await resume("alice-t", "carol")).status).toBe(403);
    expect((await resume("alice-t", "alice")).status).toBe(201);
    await drain("alice-t", "m1");
    expect((await resume("alice-t", "m2")).status).toBe(201);
    // /can greys the buttons with the door's words.
    await drain("alice-t", "alice");
    const can = (await call("GET", "/factory/workers/alice-t/can", undefined, cli("m1"))).json;
    expect(can.can.resume).toBe(false);
    expect(can.why.resume).toContain("alice drained it");
    expect((await resume("alice-t", "alice")).status).toBe(201);
    // A login at its twenty orders an hour still undoes a drain: a resume is never counted, at the door nor in the INSERT.
    await drain("proj-t", "m1");
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare("INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, issued_at, expires_at, state) VALUES (?, 'elsewhere', 'recheck-agent', 'r', 'm3', ?, ?, 'done')").bind(`wo_cap_m3_${i}`, new Date(Date.now() - MIN).toISOString(), new Date(Date.now() + 60 * MIN).toISOString()).run();
    }
    expect((await issue("alice-t", { kind: "drain" }, cli("m3"))).json.error).toContain("m3 reached 20 orders in an hour");
    expect((await resume("proj-t", "m3")).status).toBe(201);
    // Six drains of one worker in an hour, then the seventh refused in words that say so.
    await seedWorker("proj-cap", "aarch64", "m1", "project");
    for (let i = 0; i < 6; i++) {
      await env.DB.prepare("INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, issued_at, expires_at, state) VALUES (?, 'proj-cap', 'drain', 'r', 'someone', ?, ?, 'done')").bind(`wo_cap_drain_${i}`, new Date(Date.now() - (10 - i) * MIN).toISOString(), new Date(Date.now() + 60 * MIN).toISOString()).run();
    }
    const seventh = await issue("proj-cap", { kind: "drain" }, cli("m2"));
    expect(seventh.json.error).toMatch(/^drained 6 times in the last hour; the next from \d\d:\d\d UTC$/);
    // /can greys Drain first, in the door's own words.
    const capped = (await call("GET", "/factory/workers/proj-cap/can", undefined, cli("m2"))).json;
    expect(capped.can.drain).toBe(false);
    expect(capped.why.drain).toBe(seventh.json.error);
    // Six resumes of a worker in an hour never keep it drained: a resume is not counted, at the door, on /can, nor in the INSERT.
    await seedWorker("proj-res", "aarch64", "m1", "project");
    for (let i = 0; i < 6; i++) {
      await env.DB.prepare("INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, issued_at, expires_at, state) VALUES (?, 'proj-res', 'resume', 'r', 'someone', ?, ?, 'done')").bind(`wo_cap_resume_${i}`, new Date(Date.now() - (10 - i) * MIN).toISOString(), new Date(Date.now() + 60 * MIN).toISOString()).run();
    }
    expect((await issue("proj-res", { kind: "drain" }, cli("m2"))).status).toBe(201);
    expect((await call("GET", "/factory/workers/proj-res/can", undefined, cli("m3"))).json.can.resume).toBe(true);
    expect((await issue("proj-res", { kind: "resume" }, cli("m3"))).status).toBe(201);
    expect((await rowOf("proj-res")).drained_at).toBeNull();
  });

  it("a project worker whose owner is not a maintainer: a maintainer's drain is lifted by a maintainer only, at the door and on /can; its owner lifts a drain of their own", async () => {
    await env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('dave', ?, ?, 'contributor')`).bind(await sha256Hex("omc_dave"), await sha256Hex("oms_dave")).run();
    await seedWorker("dave-proj", "aarch64", "dave", "project");
    expect((await issue("dave-proj", { kind: "drain", reason: "publishes broken builds" }, cli("m1"))).status).toBe(201);
    const refused = await issue("dave-proj", { kind: "resume" }, cli("dave"));
    expect(refused).toMatchObject({ status: 403, json: { error: expect.stringMatching(/^m1 drained it \(\d\d:\d\d UTC: publishes broken builds\): a project worker goes back to work on a maintainer's word$/) } });
    const can = (await call("GET", "/factory/workers/dave-proj/can", undefined, cli("dave"))).json;
    expect(can.can.resume).toBe(false);
    expect(can.why.resume).toBe(refused.json.error);
    expect((await rowOf("dave-proj")).drained_at).not.toBeNull();
    expect((await issue("dave-proj", { kind: "resume" }, cli("m2"))).status).toBe(201);
    // Its own drain is its owner's to lift.
    expect((await issue("dave-proj", { kind: "drain", reason: "moving it" }, cli("dave"))).status).toBe(201);
    expect((await issue("dave-proj", { kind: "resume" }, cli("dave"))).status).toBe(201);
  });

  it("the Build door and the project-build door refuse to pin a drained worker, and the other architecture is not pinned to one", async () => {
    await seedWorker("bob-shared", "aarch64", "bob", "community");
    expect((await issue("bob-shared", { kind: "drain", reason: "moving house" }, cli("bob"))).status).toBe(201);
    await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status, pkgbuild_path) VALUES ('ivy', 'alice', 'https://github.com/alice/ivy', '["aarch64"]', 'registered', 'PKGBUILD')`).run();
    const built = await call("POST", "/factory/packages/ivy/build", { worker: "bob-shared", arches: ["aarch64"] }, cli("alice"));
    expect(built).toMatchObject({ status: 409, json: { error: expect.stringMatching(/^bob-shared is drained \(by bob, \d\d:\d\d UTC: moving house\) — pin another worker, or use the shared queue$/) } });
    // The project-build door: the named review worker is drained; another architecture's live one with the same agent is, too.
    await seedWorker("rev-a", "aarch64", "m1", "project", { agent: "claude-code/claude-sonnet-5", agent_status: "ok", kinds: '["build"]' });
    await seedWorker("rev-x", "x86_64", "m1", "project", { agent: "claude-code/claude-sonnet-5", agent_status: "ok", kinds: '["build"]' });
    expect((await issue("rev-a", { kind: "drain" }, cli("m1"))).status).toBe(201);
    const staged = await seedTask({ name: "ivy", owner: "alice", status: "staged" });
    const door = await call("POST", `/factory/tasks/${staged}/build`, { worker: "rev-a" }, cli("m2"));
    expect(door).toMatchObject({ status: 409, json: { error: expect.stringContaining("rev-a is drained") } });
    expect((await issue("rev-a", { kind: "resume" }, cli("m1"))).status).toBe(201);
    expect((await issue("rev-x", { kind: "drain" }, cli("m1"))).status).toBe(201);
    const alive = new Date(Date.now() - 10 * MIN).toISOString();
    expect(await env.DB.prepare(SAME_AGENT_SQL).bind("x86_64", "claude-code/claude-sonnet-5", alive, "[]").first()).toBeNull();
    expect((await issue("rev-x", { kind: "resume" }, cli("m1"))).status).toBe(201);
    expect(await env.DB.prepare(SAME_AGENT_SQL).bind("x86_64", "claude-code/claude-sonnet-5", alive, "[]").first()).toEqual({ id: "rev-x" });
  });

  it("a build pinned to a worker drained FIRST_PICK_MINUTES or more goes to the shared queue at the sweep, one line; a drain younger than that unpins nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedWorker("alice-pin", "aarch64", "alice", "community");
    const t = await seedTask({ name: "felix", owner: "alice", pinned_to: "alice-pin" });
    expect((await issue("alice-pin", { kind: "drain" }, cli("alice"))).status).toBe(201);
    await sweepOrders(env, t0 + 2 * MIN);
    expect((await taskOf(t)).pinned_to).toBe("alice-pin");
    await sweepOrders(env, t0 + 4 * MIN);
    const after = await taskOf(t);
    expect(after.pinned_to).toBeNull();
    expect(JSON.parse(after.params).unpinned).toMatchObject({ from: "alice-pin" });
    const lines = await env.DB.prepare("SELECT summary FROM events WHERE kind = 'order' AND json_extract(payload, '$.worker') = 'alice-pin' AND json_extract(payload, '$.unpinned') IS NOT NULL").all<{ summary: string }>();
    expect(lines.results.map((l) => l.summary)).toEqual([`alice-pin is drained: 1 build pinned to it goes to the shared queue (#${t})`]);
    await sweepOrders(env, t0 + 14 * MIN);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'order' AND json_extract(payload, '$.worker') = 'alice-pin' AND json_extract(payload, '$.unpinned') IS NOT NULL").first<{ n: number }>())!.n).toBe(1);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(t).run();
  });
});

describe("a stop, a report and a requeue that cross", () => {
  it("an image of #277's first part takes orders but does not stop on the pool's word: /can and the door say its lease's end", async () => {
    await seedWorker("pool-p1", "aarch64", "m1", "project");
    const h = await seedTask({ name: "health", kind: "health", trust: "project", params: { ring: "edge", arch: "aarch64" } });
    expect((await claim("pool-p1", { kinds: ["health"], instance: 130, orders: ["drain", "recheck-agent", "restart"] })).json.task.id).toBe(h);
    const can = (await call("GET", "/factory/workers/pool-p1/can", undefined, cli("m1"))).json;
    expect(can.stop).toMatchObject({ stops: "lease-end" });
    const r = await issue("pool-p1", { kind: "stop-task", task: h }, cli("m5"));
    expect(r.status).toBe(201);
    expect(r.json.note).toContain("does not stop on the pool's word");
    await claim("pool-p1", { kinds: ["none"], instance: 130, orders: ["drain", "recheck-agent", "restart"] });
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(h).run();
  });

  it("a stop that lands between a heartbeat's, a complete's or a fail's read and its write: nothing renewed, no token, no report taken — the stop said", async () => {
    await seedWorker("pool-race", "aarch64", "m1", "project");
    for (const [what, trigger] of [["heartbeat", "UPDATE build_tasks SET lease_expires_at"], ["complete", "UPDATE build_tasks SET status = 'done'"], ["fail", "UPDATE build_tasks SET status = ?"]] as const) {
      const t = await seedTask({ name: "render", kind: "render", trust: "project", params: { ring: "edge", arch: "aarch64" } });
      const c = await claim("pool-race", { kinds: ["render"], instance: 140 });
      expect(c.json.task.id, what).toBe(t);
      const before = await taskOf(t);
      let oid = "";
      const db = racing(trigger, async () => { oid = (await issue("pool-race", { kind: "stop-task", task: t }, cli("m4"))).json.order.id; });
      const body = what === "complete" ? { summary: "rendered" } : what === "fail" ? { error: "late" } : {};
      const r = await callWith(db, "POST", `/factory/tasks/${t}/${what}`, body, c.json.token);
      expect(oid, what).toMatch(/^wo_[0-9a-f]{32}$/);
      expect(r, what).toMatchObject({ status: 409, json: { stop: true, state: "stopping" } });
      expect(r.json.token, what).toBeUndefined();
      // Still the stopped worker's lease, fenced, never renewed; the attempt not spent twice, nothing journaled as done.
      expect(await taskOf(t), what).toMatchObject({ status: "leased", lease_owner: "pool-race", stop_order: oid, lease_expires_at: before.lease_expires_at, attempts: before.attempts, finished_at: null });
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN ('job', 'build') AND json_extract(payload, '$.task') = ?").bind(t).first<{ n: number }>())!.n, what).toBe(0);
      // Its worker's next claim gives it back, as after any stop.
      await claim("pool-race", { kinds: ["none"], instance: 140 });
      expect((await taskOf(t)).status, what).toBe("queued");
      await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(t).run();
    }
  });

  it("a heartbeat that renews an expired lease between the cron's read and its requeue keeps the lease, and the token it was handed stays the lease's", async () => {
    await seedWorker("pool-cron", "aarch64", "m1", "project");
    const t = await seedTask({ name: "render", kind: "render", trust: "project", params: { ring: "edge", arch: "aarch64" } });
    const c = await claim("pool-cron", { kinds: ["render"], instance: 150 });
    expect(c.json.task.id).toBe(t);
    await env.DB.prepare("UPDATE build_tasks SET lease_expires_at = ? WHERE id = ?").bind(new Date(Date.now() - MIN).toISOString(), t).run();
    let beat: { status: number; json: any } | null = null;
    const db = racing("UPDATE build_tasks SET\n    status = CASE", async () => { beat = await call("POST", `/factory/tasks/${t}/heartbeat`, {}, { token: c.json.token }); });
    await requeueExpiredLeases({ ...env, DB: db } as typeof env);
    expect(beat).toMatchObject({ status: 200, json: { task: t } });
    expect(beat!.json.token).toMatch(/^omj\./);
    const row = await taskOf(t);
    expect(row).toMatchObject({ status: "leased", lease_owner: "pool-cron" });
    expect(Date.parse(row.lease_expires_at)).toBeGreaterThan(Date.now());
    await call("POST", `/factory/tasks/${t}/fail`, { error: "test", final: true }, { token: beat!.json.token });
  });

  it("a fence a Worker from before it left on a queued task goes with the next lease: nobody stopped the worker that claims it", async () => {
    await seedWorker("pool-left", "aarch64", "m1", "project");
    const t = await seedTask({ name: "render", kind: "render", trust: "project", params: { ring: "edge", arch: "aarch64" } });
    await env.DB.prepare("UPDATE build_tasks SET stop_order = ? WHERE id = ?").bind(`wo_${"e".repeat(32)}`, t).run();
    const c = await claim("pool-left", { kinds: ["render"], instance: 160 });
    expect(c.json.task.id).toBe(t);
    expect((await taskOf(t)).stop_order).toBeNull();
    expect((await call("POST", `/factory/tasks/${t}/heartbeat`, {}, { token: c.json.token })).status).toBe(200);
    await call("POST", `/factory/tasks/${t}/fail`, { error: "test", final: true }, { token: c.json.token });
  });

  it("a stop whose lease ends on the task's last attempt: the task fails, and the order's final words say so, not that it went back to the queue", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedWorker("pool-last", "aarch64", "m1", "project");
    const t = await seedTask({ name: "render", kind: "render", trust: "project", params: { ring: "edge", arch: "aarch64" }, attempts: 2, max_attempts: 3 });
    expect((await claim("pool-last", { kinds: ["render"], instance: 170 })).json.task.id).toBe(t);
    const r = await issue("pool-last", { kind: "stop-task", task: t }, cli("m5"));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    vi.setSystemTime(t0 + 31 * MIN);
    await requeueExpiredLeases(env);
    expect((await taskOf(t)).status).toBe("failed");
    await sweepOrders(env, t0 + 31 * MIN);
    const o = await orderOf(r.json.order.id);
    expect(o.state).toBe("failed");
    expect(o.detail).toMatch(new RegExp(`^no claim before its lease ended at \\d\\d:\\d\\d UTC: .*\\. Task #${t} failed then: that was its last attempt$`));
    const lines = await linesOf(r.json.order.id);
    expect(lines.map((l) => JSON.parse(l.payload).state)).toEqual(["pending", "failed"]);
    expect(lines[1].summary).not.toContain("back to the queue");
  });
});

describe("the record, and what the planner reads", () => {
  it("every order of this part has exactly one issue line and exactly one final line — the claim's requeue, the lease's end, a resume, revoke", async () => {
    const orders = (await env.DB.prepare("SELECT id, state, kind FROM worker_orders WHERE id NOT LIKE 'wo\\_cap%' ESCAPE '\\'").all<{ id: string; state: string; kind: string }>()).results;
    expect(orders.filter((o) => o.kind === "stop-task").length).toBeGreaterThan(6);
    expect(orders.filter((o) => o.kind === "drain").length).toBeGreaterThan(5);
    for (const o of orders) {
      const states = (await linesOf(o.id)).map((l) => JSON.parse(l.payload).state as string);
      expect(states.filter((s) => s === "pending" || s === "delivered").length, `${o.id} (${o.kind} ${o.state}): ${states}`).toBe(1);
      expect(states.filter((s) => ["done", "refused", "failed", "expired", "cancelled"].includes(s)).length, `${o.id} (${o.kind} ${o.state}): ${states}`).toBe(["pending", "delivered"].includes(o.state) ? 0 : 1);
    }
  });

  it("every new statement by its index, never a scan of the tables", async () => {
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const now = new Date().toISOString();
    const cases: [string, string, unknown[], RegExp][] = [
      ["the stops the sweep closes", STOPS_DUE_SQL, [], /uq_worker_orders_open_kind/],
      ["their tasks, by key", STOPS_DUE_SQL, [], /SEARCH t USING INTEGER PRIMARY KEY \(rowid=\?\)/],
      ["the drained workers' pinned builds", DRAINED_PINS_SQL, [now], /SEARCH t USING INDEX idx_build_tasks_(queue|lease) \(status=\?\).*SEARCH w USING INDEX sqlite_autoindex_build_workers_1 \(id=\?\)/],
      ["their unpin", UNPIN_DRAINED_SQL, ["{}", "w"], /SEARCH build_tasks USING INDEX idx_build_tasks_(queue|lease) \(status=\?\)/],
      ["a stopped task, by key", STOPPED_TASK_SQL, [1], /SEARCH build_tasks USING INTEGER PRIMARY KEY/],
      ["the task a worker holds", HELD_TASK_SQL, [1], /SEARCH build_tasks USING INTEGER PRIMARY KEY/],
      ["the requeue", REQUEUE_SQL, [now, "e", 1, "w", null, null], /SEARCH build_tasks USING INTEGER PRIMARY KEY/],
      ["the cron's requeue, only while expired", REQUEUE_SQL, [now, "e", 1, "w", null, now], /SEARCH build_tasks USING INTEGER PRIMARY KEY/],
      // A resume's close of the drain it ends: the worker's open drain through the partial index of the open ones, never its whole history.
      ["a resume's line for the drain it ends", RESUME_DRAIN_LINE_SQL, ["d", "w", "wo_x"], /SEARCH worker_orders USING INDEX uq_worker_orders_open_kind \(worker_id=\? AND kind=\?\)/],
      ["a resume's close of that drain", RESUME_DRAIN_CLOSE_SQL, [now, "d", "w", "wo_x"], /SEARCH worker_orders USING INDEX uq_worker_orders_open_kind \(worker_id=\? AND kind=\?\)/],
      ["delivery, with the stop's task", OPEN_ORDERS_SQL, ["w"], /uq_worker_orders_open_kind/],
    ];
    for (const [what, sql, args, want] of cases) {
      const p = await plan(sql, args);
      expect(p, what).toMatch(want);
      expect(p, what).not.toMatch(/SCAN (worker_orders|build_workers|build_tasks|settings)(?! USING)/);
    }
    // The issue's new conditions read the worker and the task by their keys.
    const issue = await plan(ISSUE_SQL, ["wo_x", "w", "stop-task", "r", "m1", "token", null, 0, 1, null, now, now, null, "pending", null, null, null, '["stop-task"]', now, 6, now, null]);
    expect(issue).toMatch(/SEARCH build_tasks USING INTEGER PRIMARY KEY/);
    expect(issue).toMatch(/SEARCH build_workers USING INDEX sqlite_autoindex_build_workers_1 \(id=\?\)/);
    expect(issue).not.toMatch(/SCAN (worker_orders|build_workers|build_tasks)(?! USING)/);
  });
});
