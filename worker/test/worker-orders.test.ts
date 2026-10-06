/**
 * Workers follow the brain for their health (#277), inside workerd with a
 * real D1: the doors — who may order what, with the page's own guard on a
 * session's writes —, the claim that carries an order and the worker's
 * answer, the pool's own rules on a fake clock (a stubbed agent that comes
 * up late: re-checked, then restarted only if needed, by the pool alone),
 * the site and the fleet breaker, the caps and the daily budget, the
 * record — one issue line and one final line per order, whatever closed
 * it — and what the planner reads, pinned by EXPLAIN QUERY PLAN.
 *
 * The workers are the Studio's default set (#277's design, P10): four
 * project workers on one host — two pool workers and two review workers
 * behind agent-proxy — and a contributor's builder. The emulated profile's
 * host, four review workers behind agent-proxy, is in
 * worker-orders-bounds.test.ts, with the breaker's whole matrix, the
 * budget's shares and the races. Their tokens are omw_<id>; the people's
 * sessions oms_<login>, their CLI tokens omc_<login>.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { handleClaim } from "../src/routes/factory";
import { sha256Hex, workerOf } from "../src/routes/contributors";
import {
  BREAKER_KEYS_SQL, CANCEL_LINES_SQL, CANCEL_ORDERS_SQL, CANCEL_ROWS_SQL, COMMUNITY_RESTARTS_SQL, COUNT_ISSUER_SQL, COUNT_WORKER_SQL, DUE_ORDERS_SQL, ISSUE_SQL, OPEN_ORDERS_SQL, OPEN_SPELLS_SQL,
  POOL_ORDERS_SQL, POOL_RESTARTS_SQL, REFRESH_OPEN_SQL, SITE_PACE_SQL, SITE_WORKERS_SQL,
  MAX_POOL_ORDERS_PER_DAY, MAX_POOL_RESTARTS_PER_HOUR, UPDATE_EXPIRED, sweepOrders,
} from "../src/orders";
import { FOLLOW_SQL, ORDER_BY_ID_SQL, ORDER_OF_WORKER_SQL, WORKER_ORDERS_SQL } from "../src/routes/orders";
import { DEAD_SPELLS_SQL, OLD_ORDER_KEYS_SQL, OLD_ORDERS_SQL } from "../src/routes/gc";

const ORIGIN = "http://pool.test";
const API = `${ORIGIN}/api/v1`;
const MIN = 60000;
const SITE = "5d0e4b1a9c7f2e36";

interface Who { token?: string; cookie?: string; origin?: string | null; type?: string | null; headers?: Record<string, string> }
async function call(method: string, path: string, body?: unknown, who: Who = {}, on: Env = env): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...(who.headers ?? {}) };
  if (body !== undefined && who.type !== null) headers["content-type"] = who.type ?? "application/json";
  if (body === undefined && who.type) headers["content-type"] = who.type;
  if (who.token) headers.authorization = `Bearer ${who.token}`;
  if (who.cookie) headers.cookie = who.cookie;
  if (who.origin) headers.origin = who.origin;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), on, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
/** The page: the session and the pool's own Origin, JSON. */
const page = (login: string): Who => ({ cookie: `omc=oms_${login}`, origin: ORIGIN });
/** A person's curl: their CLI token. */
const cli = (login: string): Who => ({ token: `omc_${login}` });

const hex = (n: number) => n.toString(16).padStart(32, "0");
const ARCH: Record<string, string> = {};

/** What a worker says with a claim: its process, the kinds of order it takes, its agent's last probe — and what rolls its set out (#277, part 3). */
function claimOf(id: string, o: { instance?: number | null; orders?: string[] | null; status?: "ok" | "error" | null; error?: string; checked?: string; via?: string; site?: string | null; version?: string; previous_exit?: unknown; kinds?: string[]; agent?: string; rollout?: unknown } = {}) {
  return {
    arch: ARCH[id], hostname: "studio", version: o.version ?? "v1.0.2", kinds: o.kinds,
    agent: o.agent ?? "claude-code/claude-sonnet-5", agent_status: o.status === undefined ? "ok" : o.status, agent_error: o.error ?? "", agent_checked_at: o.checked ?? "2026-09-29T12:00:00Z",
    ...(o.orders === null ? {} : { orders: o.orders ?? ["drain", "recheck-agent", "restart", "restart-agent"] }),
    ...(o.instance === null ? {} : { instance: hex(o.instance ?? 1) }),
    agent_via: o.via ?? "direct", ...(o.site ? { site: o.site } : {}), ...(o.previous_exit ? { previous_exit: o.previous_exit } : {}), ...(o.rollout !== undefined ? { rollout: o.rollout } : {}),
  };
}
const claim = (id: string, o: Parameters<typeof claimOf>[1] = {}, headers?: Record<string, string>, on: Env = env) => call("POST", "/factory/claim", claimOf(id, o), { token: `omw_${id}`, headers }, on);
const answer = (id: string, oid: string, body: unknown) => call("POST", `/factory/workers/self/orders/${oid}`, body, { token: `omw_${id}` });
const issue = (id: string, body: unknown, who: Who) => call("POST", `/factory/workers/${id}/orders`, body, who);
const rowOf = (id: string) => env.DB.prepare("SELECT * FROM build_workers WHERE id = ?").bind(id).first<any>();
const orderOf = (oid: string) => env.DB.prepare("SELECT * FROM worker_orders WHERE id = ?").bind(oid).first<any>();
const linesOf = async (oid: string) => (await env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'order' AND json_extract(payload, '$.order') = ? ORDER BY id").bind(oid).all<{ status: string; summary: string; payload: string }>()).results;

async function seedWorker(id: string, arch: string, owner: string | null, trust: "project" | "community", extra: Record<string, unknown> = {}) {
  ARCH[id] = arch;
  const cols = ["id", "arch", "owner", "token_hash", "mode", "trust", "trusted_by", "last_seen", ...Object.keys(extra)];
  const vals = [id, arch, owner, await sha256Hex(`omw_${id}`), trust === "project" ? "shared" : "dedicated", trust, trust === "project" ? "m1" : null, new Date().toISOString(), ...Object.values(extra)];
  await env.DB.prepare(`INSERT INTO build_workers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...vals).run();
}

beforeAll(async () => {
  const h = (t: string) => sha256Hex(t);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2'), ('m3'), ('m4')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('m1', ?, ?, 'maintainer'), ('m2', ?, ?, 'maintainer'), ('m3', ?, ?, 'maintainer'), ('m4', ?, ?, 'maintainer'), ('alice', ?, ?, 'contributor'), ('bob', ?, ?, 'contributor')`)
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_m3"), await h("oms_m3"), await h("omc_m4"), await h("oms_m4"), await h("omc_alice"), await h("oms_alice"), await h("omc_bob"), await h("oms_bob")),
  ]);
  // The Studio's default set: four project workers on one host, two of them review workers behind agent-proxy; a contributor's builder.
  for (const [id, arch] of [["studio-pool-x86_64", "x86_64"], ["studio-pool-aarch64", "aarch64"], ["studio-review-aarch64", "aarch64"], ["studio-review2-aarch64", "aarch64"]]) await seedWorker(id, arch, "m1", "project");
  await seedWorker("alice-box-aarch64-1f2e", "aarch64", "alice", "community");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the doors: who gives a worker an order", () => {
  it("its owner and every maintainer, from the page or with a token; anyone else is refused server-side, in the words /can greys the button with", async () => {
    const id = "alice-box-aarch64-1f2e";
    expect((await claim(id, { instance: 1 })).status).toBe(204);
    expect((await issue(id, { kind: "recheck-agent" }, { origin: ORIGIN })).status).toBe(401);
    const stranger = await issue(id, { kind: "recheck-agent" }, page("bob"));
    expect(stranger).toMatchObject({ status: 403, json: { error: "only alice or a maintainer gives it orders" } });
    const can = await call("GET", `/factory/workers/${id}/can`, undefined, page("bob"));
    expect(can.json.can.recheck).toBe(false);
    expect(can.json.why.recheck).toBe(stranger.json.error);
    // The owner, from the page: 201, the note says when it arrives.
    const mine = await issue(id, { kind: "recheck-agent", reason: "stuck since v1.0.1" }, page("alice"));
    expect(mine.status).toBe(201);
    expect(mine.json.order).toMatchObject({ kind: "recheck-agent", issued_by: "alice", via: "web", state: "pending", reason: "stuck since v1.0.1" });
    expect(mine.json.note).toContain("delivered with its next claim");
    // One waiting per kind: the second is refused with the first's words.
    const again = await issue(id, { kind: "recheck-agent" }, cli("m2"));
    expect(again.status).toBe(409);
    expect(again.json.error).toContain("waiting already");
    // A maintainer, with a token: another kind.
    expect((await issue(id, { kind: "restart", unless_agent_ok: true }, cli("m2"))).status).toBe(201);
    // What the door refuses, /can greys, in the same words, for every role and button.
    for (const who of ["bob", "alice", "m2"]) {
      const c = (await call("GET", `/factory/workers/studio-review-aarch64/can`, undefined, page(who))).json;
      for (const [kind, right] of [["recheck-agent", "recheck"], ["restart-agent", "restart_agent"], ["drain", "drain"], ["update", "update"], ["stop-task", "stop_task"], ["resume", "resume"]] as const) {
        if (c.can[right]) continue; // allowed: pressing it would issue; the refusals are what must agree
        const door = await issue("studio-review-aarch64", { kind }, page(who));
        expect(door.json.error, `${who} ${kind}`).toBe(c.why[right]);
      }
    }
  });

  it("refuses an unknown worker, a kind it does not know, an Update on a pool that runs no release, an image that takes no orders, and a reason that looks like a secret", async () => {
    expect((await issue("nobody-here", { kind: "restart" }, cli("m1"))).status).toBe(404);
    expect((await issue("studio-pool-x86_64", { kind: "reboot" }, cli("m1"))).status).toBe(400);
    // Every kind is on this pool (#277, parts 1 to 3): a pool that runs no release has nothing to update to.
    expect((await issue("studio-pool-x86_64", { kind: "update" }, cli("m1")))).toMatchObject({ status: 409, json: { error: "the pool runs no release (test): there is nothing to update to" } });
    // studio-pool-x86_64 has never claimed with orders: its image takes none.
    const old = await issue("studio-pool-x86_64", { kind: "restart" }, cli("m1"));
    expect(old).toMatchObject({ status: 409, json: { error: expect.stringContaining("takes no orders") } });
    await claim("studio-pool-x86_64", { instance: 50, orders: ["drain", "restart"] });
    const secret = await issue("studio-pool-x86_64", { kind: "restart", reason: "token omw_" + "b".repeat(48) }, cli("m1"));
    expect(secret.status).toBe(400);
    const r = await issue("studio-pool-x86_64", { kind: "restart", reason: "red \x1b[31mtext\x1b[0m\r\nand ‮back" }, cli("m1"));
    expect(r.status).toBe(201);
    expect((await orderOf(r.json.order.id)).reason).toBe("red text and back");
    // It runs no agent to re-check: the kind is not declared.
    expect((await issue("studio-pool-x86_64", { kind: "recheck-agent" }, cli("m1"))).json.error).toBe("it runs no agent to re-check");
  });

  it("a session's write comes from the page: JSON and the pool's own Origin; a token's needs the header only with a body", async () => {
    const id = "studio-review2-aarch64";
    await claim(id, { instance: 60 });
    expect((await issue(id, { kind: "recheck-agent" }, { cookie: "omc=oms_m1" })).json).toMatchObject({ code: "origin" });
    expect((await issue(id, { kind: "recheck-agent" }, { cookie: "omc=oms_m1", origin: "https://evil.example" })).status).toBe(403);
    expect((await issue(id, { kind: "recheck-agent" }, { cookie: "omc=oms_m1", origin: ORIGIN, type: "text/plain" })).status).toBe(415);
    expect((await issue(id, { kind: "recheck-agent" }, { token: "omc_m1", type: "text/plain" })).status).toBe(415);
    const ok = await issue(id, { kind: "recheck-agent" }, page("m1"));
    expect(ok.status).toBe(201);
    // Cancel: the page's own DELETE (the shell's api(): the JSON header, no body) passes; from another Origin, or without the header, it does not; a token needs neither.
    const oid = ok.json.order.id;
    expect((await call("DELETE", `/factory/workers/${id}/orders/${oid}`, undefined, { cookie: "omc=oms_m1", origin: ORIGIN })).status).toBe(415);
    expect((await call("DELETE", `/factory/workers/${id}/orders/${oid}`, undefined, { cookie: "omc=oms_m1", origin: "https://evil.example", type: "application/json" })).status).toBe(403);
    expect((await call("DELETE", `/factory/workers/${id}/orders/${oid}`, undefined, { cookie: "omc=oms_m1", origin: ORIGIN, type: "application/json" })).status).toBe(200);
    const again = await issue(id, { kind: "recheck-agent" }, cli("m1"));
    expect((await call("DELETE", `/factory/workers/${id}/orders/${again.json.order.id}`, undefined, cli("m1"))).status).toBe(200);
    expect((await call("DELETE", `/factory/workers/${id}/orders/${again.json.order.id}`, undefined, cli("m1"))).status).toBe(409);
    // An agent's token is refused before anything is read.
    expect((await issue(id, { kind: "recheck-agent" }, { token: "oma_" + "0".repeat(48) })).status).toBe(403);
  });

  it("two orders of one kind at once: one is issued, the other refused, one row", async () => {
    const id = "studio-review-aarch64";
    await claim(id, { instance: 70, via: "sibling", site: SITE });
    const both = await Promise.all([issue(id, { kind: "restart-agent" }, cli("m1")), issue(id, { kind: "restart-agent" }, cli("m2"))]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM worker_orders WHERE worker_id = ? AND kind = 'restart-agent' AND state = 'pending'").bind(id).first<{ n: number }>())!.n).toBe(1);
    // One restart of the host's agent service at a time: another worker of the site is refused while this one waits.
    await claim("studio-review2-aarch64", { instance: 71, via: "sibling", site: SITE });
    const other = await issue("studio-review2-aarch64", { kind: "restart-agent" }, cli("m1"));
    expect(other).toMatchObject({ status: 409, json: { error: expect.stringContaining("through another of its workers") } });
    for (const r of both.filter((x) => x.status === 201)) await call("DELETE", `/factory/workers/${id}/orders/${r.json.order.id}`, undefined, cli("m1"));
  });
});

describe("the claim carries the order, and the worker answers", () => {
  it("an order waits for the next claim, goes to that process once, instead of a task; the process that took it answers, once", async () => {
    const id = "studio-review2-aarch64";
    await claim(id, { instance: 80, via: "sibling", site: SITE });
    const o = (await issue(id, { kind: "restart", reason: "the pool is sure" }, cli("m2"))).json.order;
    // A task is queued for it: the answer that carries the order carries no task.
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, priority, publish, trust, kind) VALUES ('gc', 'aarch64', '-', 'test', 10, 0, 'project', 'gc')").run();
    const c = await claim(id, { instance: 80, via: "sibling", site: SITE });
    expect(c.status).toBe(200);
    expect(c.json).toEqual({ task: null, orders: [{ id: o.id, kind: "restart", reason: "the pool is sure", issued_by: "m2", issued_at: o.issued_at, expires_at: o.expires_at, unless_agent_ok: false, notice: false }] });
    expect((await orderOf(o.id))).toMatchObject({ state: "delivered", delivered_to: hex(80) });
    // Delivered once: the next claim gets the task.
    const next = await claim(id, { instance: 80, via: "sibling", site: SITE });
    expect(next.json.task.kind).toBe("gc");
    await call("POST", `/factory/tasks/${next.json.task.id}/complete`, { summary: "done", result: {} }, { token: next.json.token });
    // Another process of the same token cannot answer it; a job token cannot at all.
    expect((await answer(id, o.id, { instance: hex(81), outcome: "accepted", code: "exiting" })).status).toBe(409);
    expect((await call("POST", `/factory/workers/self/orders/${o.id}`, { instance: hex(80), outcome: "accepted" }, { token: next.json.token })).status).toBe(401);
    expect((await answer("alice-box-aarch64-1f2e", o.id, { instance: hex(80), outcome: "accepted" })).status).toBe(404);
    expect((await answer(id, o.id, { instance: hex(80), outcome: "maybe" })).status).toBe(400);
    // Accepted, once; then the new process claims and the pool sees it back: done by observation, no clock compared.
    expect((await answer(id, o.id, { instance: hex(80), outcome: "accepted", code: "exiting", detail: "exit 75 in a moment" })).status).toBe(200);
    expect((await answer(id, o.id, { instance: hex(80), outcome: "accepted", code: "exiting" })).status).toBe(409);
    await claim(id, { instance: 82, via: "sibling", site: SITE, previous_exit: { why: "restart", at: new Date(Date.now() + 600000).toISOString() } });
    const done = await orderOf(o.id);
    expect(done).toMatchObject({ state: "done", answered_by: "pool" });
    expect(done.detail).toContain("back as a new process");
    expect((await linesOf(o.id)).map((l) => JSON.parse(l.payload).state)).toEqual(["pending", "done"]);
    // The churn does not count a process whose end the restart explains.
    expect((await rowOf(id)).instance_churn).toBe(0);
  });

  it("a re-check is answered with what the agent said; the public sentence is the pool's, the worker's words are its owner's and the maintainers'", async () => {
    const id = "studio-review-aarch64";
    await claim(id, { instance: 90, via: "sibling", site: SITE, status: "error", error: "HTTPError: HTTP Error 502: Bad Gateway", checked: "c1" });
    const o = (await issue(id, { kind: "recheck-agent" }, cli("m1"))).json.order;
    const c = await claim(id, { instance: 90, via: "sibling", site: SITE, status: "error", error: "HTTPError: HTTP Error 502: Bad Gateway", checked: "c1" });
    expect(c.json.orders.map((x: any) => x.kind)).toEqual(["recheck-agent"]);
    const a = await answer(id, o.id, { instance: hex(90), outcome: "done", code: "probed", detail: "probe: ok in 42 ms <b>bold</b> \x1b[31m", agent: { status: "ok", ms: 42 } });
    expect(a.json).toMatchObject({ state: "done", code: "probed" });
    const row = await orderOf(o.id);
    expect(row.detail).toBe("re-checked its agent");
    expect(row.worker_detail).toContain("probe: ok in 42 ms <b>bold</b>");
    expect(row.worker_detail).not.toContain("\x1b");
    // The public read and the journal never carry the worker's words; the owner's and a maintainer's read does, a stranger's is refused.
    const pub = await call("GET", `/factory/workers/${id}`);
    const shown = pub.json.orders.find((x: any) => x.id === o.id);
    expect(shown.detail).toBe("re-checked its agent");
    expect(shown.worker_detail).toBeUndefined();
    expect(JSON.stringify(pub.json)).not.toContain("42 ms");
    expect((await linesOf(o.id)).map((l) => l.payload).join()).not.toContain("42 ms");
    expect((await call("GET", `/factory/workers/${id}/orders`, undefined, page("m2"))).json.orders.find((x: any) => x.id === o.id).worker_detail).toContain("42 ms");
    expect((await call("GET", `/factory/workers/${id}/orders`, undefined, page("bob"))).status).toBe(403);
    expect((await call("GET", `/factory/workers/${id}/orders`)).status).toBe(401);
    // An unknown code is kept as other.
    const o2 = (await issue(id, { kind: "recheck-agent" }, cli("m1"))).json.order;
    await claim(id, { instance: 90, via: "sibling", site: SITE, status: "error", error: "HTTPError: HTTP Error 502: Bad Gateway", checked: "c1" });
    expect((await answer(id, o2.id, { instance: hex(90), outcome: "failed", code: "banana" })).json.code).toBe("other");
  });

  it("an order goes stale at the claim, and one the process cannot take is refused by the pool; an image from before orders gets none", async () => {
    const id = "studio-pool-aarch64";
    await claim(id, { instance: 100, orders: ["drain", "recheck-agent", "restart"] });
    // A restart when a new process claims first: done, not delivered.
    const r1 = (await issue(id, { kind: "restart" }, cli("m1"))).json.order;
    await claim(id, { instance: 101, orders: ["drain", "recheck-agent", "restart"] });
    expect(await orderOf(r1.id)).toMatchObject({ state: "done", delivered_at: null });
    expect((await orderOf(r1.id)).detail).toContain("restarted since the order");
    // A conditional restart when the agent answers: done, "nothing to do".
    const r2 = (await issue(id, { kind: "restart", unless_agent_ok: true }, cli("m1"))).json.order;
    expect((await claim(id, { instance: 101, orders: ["drain", "recheck-agent", "restart"], status: "ok", checked: "later" })).status).toBe(204);
    expect((await orderOf(r2.id)).detail).toBe("its agent answers now; nothing to do");
    // A re-check after the worker probed by itself: done, with what it said.
    const r3 = (await issue(id, { kind: "recheck-agent" }, cli("m1"))).json.order;
    await claim(id, { instance: 101, orders: ["drain", "recheck-agent", "restart"], status: "ok", checked: "later-still" });
    expect((await orderOf(r3.id)).detail).toBe("probed since the order: ok");
    // The same image, rolled back to one from before orders: refused by the pool, with the reason.
    const r4 = (await issue(id, { kind: "restart" }, cli("m1"))).json.order;
    expect((await claim(id, { instance: null, orders: null, version: "v1.0.1" })).status).toBe(204);
    expect(await orderOf(r4.id)).toMatchObject({ state: "refused", answered_by: "pool" });
    expect((await orderOf(r4.id)).detail).toContain("its image (v1.0.1) takes no orders");
    expect((await rowOf(id)).order_kinds).toBeNull();
    // A kind this process does not declare: refused.
    await claim(id, { instance: 102, orders: ["drain", "recheck-agent", "restart"] });
    await env.DB.prepare("UPDATE build_workers SET order_kinds = ? WHERE id = ?").bind('["drain","recheck-agent","restart","restart-agent"]', id).run();
    const r5 = (await issue(id, { kind: "restart-agent" }, cli("m1"))).json.order;
    await claim(id, { instance: 102, orders: ["drain", "recheck-agent", "restart"] });
    expect((await orderOf(r5.id)).state).toBe("refused");
    for (const o of [r1, r2, r3, r4, r5]) expect((await linesOf(o.id)).length, o.id).toBe(2);
  });

  it("while two processes share the token, nothing is delivered, and one line says so", async () => {
    const id = "studio-pool-aarch64";
    await claim(id, { instance: 110, orders: ["drain", "recheck-agent", "restart"] });
    await claim(id, { instance: 111, orders: ["drain", "recheck-agent", "restart"] });
    await claim(id, { instance: 110, orders: ["drain", "recheck-agent", "restart"] });
    const r = await rowOf(id);
    expect(r.instance_conflict_at).not.toBeNull();
    const o = (await issue(id, { kind: "restart" }, cli("m1")));
    expect(o).toMatchObject({ status: 409, json: { error: expect.stringContaining("two processes share this token") } });
    // Alternating claims write nothing new.
    const seen = r.last_seen;
    for (const i of [111, 110, 111]) expect((await claim(id, { instance: i, orders: ["drain", "recheck-agent", "restart"] })).status).toBe(204);
    expect((await rowOf(id)).last_seen).toBe(seen);
    const lines = (await env.DB.prepare("SELECT summary FROM events WHERE kind = 'worker' AND summary LIKE ?").bind(`${id}: two processes%`).all()).results;
    expect(lines).toHaveLength(1);
    // Put it back: one process again.
    await env.DB.prepare("UPDATE build_workers SET instance_conflict_at = NULL, instance_other_at = NULL WHERE id = ?").bind(id).run();
  });

  it("a claim that says the same writes nothing, whatever the order of its kinds; a new probe moves the probe's age on the pool's clock, and a spell begins and ends", async () => {
    const id = "studio-pool-x86_64";
    await claim(id, { instance: 120, orders: ["restart", "drain"] });
    const before = await rowOf(id);
    for (const orders of [["drain", "restart"], ["restart", "drain", "restart"], ["drain", "restart", "update"]]) expect((await claim(id, { instance: 120, orders })).status).toBe(204);
    expect((await rowOf(id)).last_seen).toBe(before.last_seen);
    expect((await rowOf(id)).order_kinds).toBe('["drain","restart"]');
    // A failed probe: the spell begins on the pool's clock, the probe's age with it — whatever the worker's own stamp says.
    await claim(id, { instance: 120, orders: ["drain", "restart"], status: "error", error: "URLError: [Errno 111] Connection refused", checked: "1999-01-01T00:00:00Z" });
    const failed = await rowOf(id);
    expect(failed.agent_error_since).toBe(failed.last_seen);
    expect(failed.agent_probed_at).toBe(failed.last_seen);
    expect(failed.agent_error_class).toBe("refused");
    // The same probe again: nothing moves.
    await env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id = ?").bind(new Date(Date.now() - 4 * MIN).toISOString(), id).run();
    await claim(id, { instance: 120, orders: ["drain", "restart"], status: "error", error: "URLError: [Errno 111] Connection refused", checked: "1999-01-01T00:00:00Z" });
    const same = await rowOf(id);
    expect(same.agent_probed_at).toBe(failed.agent_probed_at);
    expect(same.agent_error_since).toBe(failed.agent_error_since);
    // Another failed probe: the spell goes on, the probe is fresh again. An answer ends the spell.
    await claim(id, { instance: 120, orders: ["drain", "restart"], status: "error", error: "URLError: [Errno 111] Connection refused", checked: "2099-01-01T00:00:00Z" });
    const again = await rowOf(id);
    expect(again.agent_error_since).toBe(failed.agent_error_since);
    expect(again.agent_probed_at).toBe(again.last_seen);
    await claim(id, { instance: 120, orders: ["drain", "restart"], status: "ok", checked: "2099-01-01T00:01:00Z" });
    expect((await rowOf(id)).agent_error_since).toBeNull();
  });

  it("a finished task marks its process as one that finished something, in the write the pool makes anyway", async () => {
    const id = "alice-box-aarch64-1f2e";
    await claim(id, { instance: 130, orders: ["drain", "recheck-agent", "restart"] });
    const t = await env.DB.prepare("INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, lease_owner, lease_expires_at) VALUES ('felix', 'aarch64', 'draft:x', 'test', 10, 0, 'community', 'alice', 'build', 'leased', ?, ?) RETURNING id").bind(id, new Date(Date.now() + 30 * MIN).toISOString()).first<{ id: number }>();
    expect((await call("POST", `/factory/tasks/${t!.id}/fail`, { error: "boom", final: true }, { token: `omw_${id}` })).status).toBe(200);
    expect((await rowOf(id)).instance_finished).toBe(hex(130));
  });
});

describe("the pool's rules, on a fake clock", () => {
  /** A worker's claims every 30 s from `from` for `minutes`, with the agent as `agent(t)` says; the orders it gets, answered as a worker from #277 on answers them. */
  // Each test's workers name a provider of their own: the fleet breaker counts sites per provider, and one test's failing workers must not hold another's.
  async function run(id: string, o: { from: number; minutes: number; instance: () => number; agent: (t: number) => { status: "ok" | "error"; error?: string }; via?: string; site?: string; headers?: Record<string, string>; provider: string }) {
    const got: { t: number; kind: string; id: string; unless: boolean }[] = [];
    let n = 0;
    // What the claims report is the worker's last probe: its own backoff waits AGENT_RETRY_FIRST_SECONDS (1800, as the E2E sets it), so within a
    // run the probe changes only when an order asks for one, or a new process probes at its start.
    const probe = (t: number) => ({ ...o.agent(t), checked: `probe-${++n}` });
    let last = probe(o.from);
    let process = o.instance();
    for (let s = 0; s <= o.minutes * 2; s++) {
      const t = o.from + s * 30000;
      vi.setSystemTime(t);
      if (o.instance() !== process) { process = o.instance(); last = probe(t); }
      const res = await claim(id, { instance: process, status: last.status, error: last.error, checked: last.checked, via: o.via, site: o.site, agent: `${o.provider}/model-1` }, o.headers);
      for (const ord of res.json?.orders ?? []) {
        got.push({ t, kind: ord.kind, id: ord.id, unless: ord.unless_agent_ok });
        // The worker's answer: a re-check probes now; a conditional restart probes too, and exits unless the agent answers.
        last = probe(t);
        const inst = hex(process);
        if (ord.kind === "recheck-agent") await answer(id, ord.id, { instance: inst, outcome: "done", code: "probed", agent: { status: last.status } });
        else if (last.status === "ok") await answer(id, ord.id, { instance: inst, outcome: "refused", code: "agent-ok" });
        else await answer(id, ord.id, { instance: inst, outcome: "accepted", code: ord.kind === "restart" ? "exiting" : "restarting" });
        if (ord.kind === "restart" && last.status !== "ok") restarted.add(id);
      }
      if (restarted.has(id)) { restarted.delete(id); bump.set(id, (bump.get(id) ?? 0) + 1); }
    }
    return got;
  }
  const restarted = new Set<string>();
  const bump = new Map<string, number>();

  it("a worker whose agent comes up late is re-checked, then restarted only if needed — by the pool alone, within its bounds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = "rules-late-aarch64";
    await seedWorker(id, "aarch64", "m1", "project");
    const t0 = Date.now();
    const base = 900;
    const inst = () => base + (bump.get(id) ?? 0);
    // Refused for 25 minutes, then up.
    const got = await run(id, { provider: "p-late", from: t0, minutes: 38, instance: inst, agent: (t) => (t < t0 + 25 * MIN ? { status: "error", error: "URLError: <urlopen error [Errno 111] Connection refused>" } : { status: "ok" }) });
    const kinds = got.map((g) => g.kind);
    // One re-check (the worker's own had stalled), then a conditional restart at 10 min; the second not before 30 more minutes.
    expect(kinds).toEqual(["recheck-agent", "restart"]);
    expect(got[0].t - t0).toBeGreaterThanOrEqual(5 * MIN);
    expect(got[1].t - t0).toBeGreaterThanOrEqual(10 * MIN);
    expect(got[1].unless).toBe(true);
    // The restart closed when the new process claimed; each order has its two lines.
    for (const g of got) expect((await linesOf(g.id)).length, g.kind).toBe(2);
    expect((await orderOf(got[1].id)).state).toBe("done");
  });

  it("a restart is refused by a worker whose agent answers by then: no exit, the record says so", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = "rules-back-aarch64";
    await seedWorker(id, "aarch64", "m1", "project");
    const t0 = Date.now();
    // Down at its start and at the pool's re-check, up just after it: the conditional restart's own probe answers, and nothing exits.
    const got = await run(id, { provider: "p-back", from: t0, minutes: 14, instance: () => 950, agent: (t) => (t < t0 + 7 * MIN ? { status: "error", error: "URLError: [Errno 111] Connection refused" } : { status: "ok" }) });
    expect(got.map((g) => g.kind)).toEqual(["recheck-agent", "restart"]);
    expect(await orderOf(got[1].id)).toMatchObject({ state: "refused", code: "agent-ok", detail: "its agent answers now: no restart needed" });
    expect((await rowOf(id)).instance).toBe(hex(950));
    expect((await linesOf(got[1].id))[1].summary).toContain("no restart needed");
  });

  it("never restarts a process under two minutes old on the pool's clock, and never on an error a restart cannot help", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = "rules-young-aarch64";
    await seedWorker(id, "aarch64", "m1", "project");
    const t0 = Date.now();
    // A new process every 90 s: the uptime gate holds every restart.
    let n = 0;
    const got = await run(id, { provider: "p-young", from: t0, minutes: 20, instance: () => 960 + Math.floor(n++ / 3), agent: () => ({ status: "error", error: "URLError: [Errno 111] Connection refused" }) });
    expect(got.filter((g) => g.kind === "restart")).toEqual([]);
    // Credit: nothing at all, not even a re-check, and nothing written of the rules.
    const credit = "rules-credit-aarch64";
    await seedWorker(credit, "aarch64", "m1", "project");
    const none = await run(credit, { provider: "p-credit", from: t0 + 30 * MIN, minutes: 60, instance: () => 970, agent: () => ({ status: "error", error: "HTTPError: HTTP Error 402: Payment Required" }) });
    expect(none).toEqual([]);
    expect((await rowOf(credit)).auto_orders).toBeNull();
    const view = (await call("GET", `/factory/workers/${credit}`)).json.worker;
    expect(view.pool_waits).toContain("credit");
  });

  it("gives a broker's builder a restart only through a broker that exits with it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    for (const [id, pair] of [["rules-builder-a", false], ["rules-builder-b", true]] as const) {
      await seedWorker(id, "aarch64", "alice", "community");
      const got = await run(id, { provider: `p-broker-${pair ? "pair" : "old"}`, from: t0, minutes: 14, instance: () => (pair ? 980 : 990), via: "broker", agent: () => ({ status: "error", error: "the broker at http://broker:8790 did not answer" }), headers: pair ? { "x-omarchy-broker-takes": "pair-restart" } : undefined });
      expect(got.filter((g) => g.kind === "restart").length, id).toBe(pair ? 1 : 0);
    }
  });

  it("restarts a host's shared agent service once, through its elected worker; the other waits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const site = "a1a1a1a1a1a1a1a1";
    const ids = ["rules-site-review-a", "rules-site-review-b"];
    for (const id of ids) await seedWorker(id, "aarch64", "m1", "project");
    const t0 = Date.now();
    const agent = () => ({ status: "error" as const, error: "HTTPError: HTTP Error 502: Bad Gateway" });
    // Both claim, turn by turn.
    const got: Record<string, string[]> = { [ids[0]]: [], [ids[1]]: [] };
    for (let s = 0; s <= 30; s++) {
      for (const [i, id] of ids.entries()) {
        vi.setSystemTime(t0 + s * 30000 + i * 1000);
        const res = await claim(id, { instance: 1000 + i, status: "error", error: agent().error, checked: "same", via: "sibling", site, agent: "p-site/model-1" });
        for (const o of res.json?.orders ?? []) {
          got[id].push(o.kind);
          await answer(id, o.id, { instance: hex(1000 + i), outcome: o.kind === "recheck-agent" ? "done" : "accepted", code: o.kind === "recheck-agent" ? "probed" : "restarting" });
        }
      }
    }
    expect(got[ids[0]].filter((k) => k === "restart-agent")).toHaveLength(1);
    expect(got[ids[1]].filter((k) => k !== "recheck-agent")).toEqual([]);
    const o = await env.DB.prepare("SELECT reason FROM worker_orders WHERE worker_id = ? AND kind = 'restart-agent'").bind(ids[0]).first<{ reason: string }>();
    expect(o!.reason).toContain(`with ${ids[1]}`);
  });

  it("the fleet breaker: three sites of one provider failing trip it before any restart, one line; it holds as long as the spells stay open, and clears once, after fifteen minutes below two", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const ids = ["brk-a", "brk-b", "brk-c"];
    for (const [i, id] of ids.entries()) await seedWorker(id, "aarch64", "m1", "project", { site: `b${i}`.padEnd(16, "0") });
    const err = "URLError: <urlopen error [Errno 111] Connection refused>";
    const turn = async (t: number, only = ids) => {
      const out: string[] = [];
      for (const [i, id] of ids.entries()) {
        if (!only.includes(id)) continue;
        vi.setSystemTime(t + i * 1000);
        const r = await claim(id, { instance: 2000 + i, status: "error", error: err, checked: "one", site: `b${i}`.padEnd(16, "0"), agent: "brk/model-1" });
        for (const o of r.json?.orders ?? []) { out.push(o.kind); await answer(id, o.id, { instance: hex(2000 + i), outcome: o.kind === "recheck-agent" ? "done" : "accepted", code: o.kind === "recheck-agent" ? "probed" : "exiting" }); }
      }
      return out;
    };
    // Three hours of an outage: re-checks go out, no restart ever; one trip line, the key stays through every sweep.
    const kinds: string[] = [];
    for (let m = 0; m <= 180; m += 1) {
      kinds.push(...(await turn(t0 + m * MIN)));
      if (m % 10 === 0) await sweepOrders(env, t0 + m * MIN + 5000);
    }
    expect(kinds.filter((k) => k !== "recheck-agent")).toEqual([]);
    expect(kinds.filter((k) => k === "recheck-agent").length).toBe(3);
    const trips = (await env.DB.prepare("SELECT summary FROM events WHERE kind = 'order' AND summary LIKE 'provider outage suspected: 3 brk sites%'").all()).results;
    expect(trips).toHaveLength(1);
    expect(await env.DB.prepare("SELECT key FROM settings WHERE key = 'worker-breaker:brk:project'").first()).not.toBeNull();
    // The page says why.
    expect((await call("GET", "/factory/workers/brk-a")).json.breaker).toMatchObject({ provider: "brk" });
    // Two of three recover: one site left, below two — the next sweep marks it, fifteen minutes later the key goes, one clear line.
    let t = t0 + 181 * MIN;
    for (const [i, id] of ids.slice(0, 2).entries()) { vi.setSystemTime(t + i * 1000); await claim(id, { instance: 2000 + i, status: "ok", checked: "two", site: `b${i}`.padEnd(16, "0"), agent: "brk/model-1" }); }
    await sweepOrders(env, t + 10000);
    expect(await env.DB.prepare("SELECT key FROM settings WHERE key = 'worker-breaker:brk:project'").first()).not.toBeNull();
    t += 16 * MIN;
    vi.setSystemTime(t);
    await turn(t, ["brk-c"]);
    await sweepOrders(env, t + 10000);
    expect(await env.DB.prepare("SELECT key FROM settings WHERE key = 'worker-breaker:brk:project'").first()).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'order' AND summary LIKE 'provider outage over: fewer than 2 brk%'").first<{ n: number }>())!.n).toBe(1);
    // The one left gets its restart at its next claim, under the usual caps.
    const after = await turn(t + MIN, ["brk-c"]);
    expect(after).toEqual(["restart"]);
    for (const id of ids) await call("DELETE", `/factory/workers/${id}`, undefined, cli("m1"));
  });
});

describe("the caps and the budget", () => {
  it("a worker's seventh re-check in an hour is refused, cancelled ones counted; a login's twenty-first order is refused and journaled once", async () => {
    const id = "cap-one";
    await seedWorker(id, "aarch64", "m1", "project");
    await claim(id, { instance: 3000 });
    for (let i = 0; i < 6; i++) {
      const r = await issue(id, { kind: "recheck-agent" }, cli("m3"));
      expect(r.status, `re-check ${i + 1}`).toBe(201);
      await call("DELETE", `/factory/workers/${id}/orders/${r.json.order.id}`, undefined, cli("m3"));
    }
    const seventh = await issue(id, { kind: "recheck-agent" }, cli("m3"));
    expect(seventh).toMatchObject({ status: 409, json: { error: expect.stringContaining("re-checked 6 times in the last hour") } });
    // m3 has given 6; fourteen more across fresh workers pass, the twenty-first does not.
    for (let i = 0; i < 15; i++) {
      const w = `cap-many-${i}`;
      await seedWorker(w, "aarch64", "m1", "project", { order_kinds: '["drain","recheck-agent","restart"]' });
      const r = await issue(w, { kind: "restart" }, cli("m3"));
      expect(r.status, `order ${i + 7}`).toBe(i < 14 ? 201 : 409);
      if (i === 14) expect(r.json.error).toContain("reached 20 orders in an hour");
    }
    const w = "cap-many-last";
    await seedWorker(w, "aarch64", "m1", "project", { order_kinds: '["drain","recheck-agent","restart"]' });
    expect((await issue(w, { kind: "restart" }, cli("m3"))).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'order' AND summary LIKE 'm3 reached 20 orders%'").first<{ n: number }>())!.n).toBe(1);
    // Another maintainer is not held by m3's cap.
    expect((await issue(w, { kind: "restart" }, cli("m1"))).status).toBe(201);
  });

  it("the pool's sixty-first order in a day and its eleventh restart in an hour are not issued, each journaled once; a person's order still passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The spent budget is journaled once per UTC day, and the claims below walk 15 minutes on:
    // started in the day's last 20 minutes, the refusals fall on both sides of midnight and are
    // journaled twice. Such a run starts just after midnight instead; what earlier tests wrote
    // stays in the past, as if the run had begun a few minutes later.
    const DAY = 1440 * MIN;
    const now = Date.now();
    vi.setSystemTime(now % DAY > DAY - 20 * MIN ? now - (now % DAY) + DAY + MIN : now);
    const t0 = Date.now();
    const at = (m: number) => new Date(t0 - m * MIN).toISOString();
    // The pool's day: 59 orders already (the tests above gave some), none a restart within the hour.
    const had = (await env.DB.prepare("SELECT COUNT(*) AS n FROM worker_orders WHERE issued_by IN ('pool:project', 'pool:community')").first<{ n: number }>())!.n;
    const rows = Array.from({ length: MAX_POOL_ORDERS_PER_DAY - 1 - had }, (_, i) => `('wo_seed${String(i).padStart(29, "0")}', 'seeded', 'recheck-agent', 'seeded', 'pool:project', '${at(120 + i)}', '${at(0)}', 'done')`);
    await env.DB.prepare(`INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, issued_at, expires_at, state) VALUES ${rows.join(", ")}`).run();
    const id = "budget-one";
    await seedWorker(id, "aarch64", "m1", "project");
    const provider = "p-budget/model-1";
    // Its agent refused for 12 minutes: a re-check (the 60th of the day) — then the restart is refused by the budget.
    const kinds: string[] = [];
    for (let s = 0; s <= 30; s++) {
      vi.setSystemTime(t0 + s * 30000);
      const r = await claim(id, { instance: 3100, status: "error", error: "URLError: [Errno 111] Connection refused", checked: "one", agent: provider });
      for (const o of r.json?.orders ?? []) { kinds.push(o.kind); await answer(id, o.id, { instance: hex(3100), outcome: "done", code: "probed" }); }
    }
    expect(kinds).toEqual(["recheck-agent"]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'order' AND summary LIKE 'the pool''s daily budget%'").first<{ n: number }>())!.n).toBe(1);
    // The auto state did not move for an order that was never issued: the next claim decides again, and is refused again, silently.
    expect(JSON.parse((await rowOf(id)).auto_orders).restarts).toBe(0);
    // People's orders still work.
    expect((await issue(id, { kind: "restart" }, cli("m4"))).status).toBe(201);
    await env.DB.prepare("DELETE FROM worker_orders WHERE worker_id = 'seeded'").run();
  });
});

describe("the record", () => {
  it("expires what nobody took and fails what nobody answered, at the sweep, with one line each; revoke cancels what is open, a line each", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const id = "record-one";
    await seedWorker(id, "aarch64", "m1", "project");
    await claim(id, { instance: 4000 });
    const pending = (await issue(id, { kind: "recheck-agent" }, cli("m4"))).json.order;
    const delivered = (await issue(id, { kind: "restart" }, cli("m4"))).json.order;
    await claim(id, { instance: 4000 });
    // The re-check is delivered too (both went); take the restart only as delivered and unanswered.
    expect((await orderOf(delivered.id)).state).toBe("delivered");
    await sweepOrders(env, t0 + 31 * MIN);
    expect((await orderOf(delivered.id)).state).toBe("failed");
    expect((await orderOf(pending.id)).state).toBe("expired");
    const waiting = (await issue(id, { kind: "restart" }, cli("m4"))).json.order;
    await sweepOrders(env, t0 + 7 * 60 * MIN);
    expect((await orderOf(waiting.id)).state).toBe("expired");
    const a = (await issue(id, { kind: "recheck-agent" }, cli("m4"))).json.order;
    const b = (await issue(id, { kind: "restart" }, cli("m4"))).json.order;
    expect((await call("DELETE", `/factory/workers/${id}`, undefined, cli("m1"))).status).toBe(200);
    for (const o of [a, b]) {
      expect((await orderOf(o.id)).state).toBe("cancelled");
      expect((await linesOf(o.id)).map((l) => l.summary)[1]).toContain("cancelled — the worker was revoked by m1");
    }
    expect((await rowOf(id)).open_orders).toBeNull();
  });

  it("every order has exactly one issue line and exactly one final line — the answer, observation, staleness, the sweep, a cancel, revoke", async () => {
    const orders = (await env.DB.prepare("SELECT id, state FROM worker_orders WHERE worker_id != 'seeded'").all<{ id: string; state: string }>()).results;
    expect(orders.length).toBeGreaterThan(20);
    for (const o of orders) {
      const states = (await linesOf(o.id)).map((l) => JSON.parse(l.payload).state as string);
      const issue = states.filter((s) => s === "pending" || s === "delivered").length;
      const final = states.filter((s) => ["done", "refused", "failed", "expired", "cancelled"].includes(s)).length;
      expect(issue, `${o.id} (${o.state}): ${states}`).toBe(1);
      expect(final, `${o.id} (${o.state}): ${states}`).toBe(["pending", "delivered"].includes(o.state) ? 0 : 1);
    }
  });
});

describe("fail open", () => {
  it("an orders path that throws delivers nothing: the claim still gets its task or its 204, and says why in the log", async () => {
    const id = "studio-pool-x86_64";
    await claim(id, { instance: 5000, orders: ["drain", "restart"] });
    await issue(id, { kind: "restart" }, cli("m1"));
    const broken = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => { if (sql === OPEN_ORDERS_SQL || sql.startsWith("INSERT INTO worker_orders")) throw new Error("boom"); return target.prepare(sql); };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const logs: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => { logs.push(a[0]); });
    const req = new Request(`${API}/factory/claim`, { method: "POST", headers: { authorization: `Bearer omw_${id}`, "content-type": "application/json" }, body: JSON.stringify(claimOf(id, { instance: 5000, orders: ["drain", "restart"] })) });
    const w = (await workerOf(req.clone(), env))!;
    const res = await handleClaim(req, { ...env, DB: broken } as Env, { kind: "worker", w });
    spy.mockRestore();
    expect(res.status).toBe(204);
    expect(logs).toContain("orders:");
  });
});

describe("what the planner reads", () => {
  const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
  it("every statement of the orders path by the index its WHERE starts with, never a scan of the tables", async () => {
    const now = new Date().toISOString();
    const cases: [string, string, unknown[], RegExp][] = [
      ["delivery", OPEN_ORDERS_SQL, ["w"], /uq_worker_orders_open_kind/],
      ["a worker's cap", COUNT_WORKER_SQL, ["w", '["restart"]', now], /idx_worker_orders_worker \(worker_id=\? AND issued_at>\?\)/],
      ["an issuer's cap", COUNT_ISSUER_SQL, ["m1", now], /idx_worker_orders_issuer \(issued_by=\? AND issued_at>\?\)/],
      ["the site's workers", SITE_WORKERS_SQL, ["s", now], /idx_build_workers_site \(site=\?\)/],
      ["the site's pacing", SITE_PACE_SQL, ["s", now], /idx_worker_orders_site \(site=\? AND issued_at>\?\)/],
      ["the breaker's open spells", OPEN_SPELLS_SQL, [now], /idx_build_workers_not_ready \(agent_error_since>\?\)/],
      ["the breakers standing", BREAKER_KEYS_SQL, [], /sqlite_autoindex_settings_1 \(key>\? AND key<\?\)/],
      ["the breaker's key", "SELECT value FROM settings WHERE key = ?", ["worker-breaker:x"], /sqlite_autoindex_settings_1 \(key=\?\)/],
      ["the sweep", DUE_ORDERS_SQL, [now, now], /uq_worker_orders_open_kind/],
      ["a worker's page", WORKER_ORDERS_SQL, ["w", 10], /idx_worker_orders_worker \(worker_id=\?\)/],
      ["the retention", OLD_ORDERS_SQL, [now], /idx_worker_orders_worker \(worker_id=\? AND issued_at<\?\)/],
      ["the pool's day", POOL_ORDERS_SQL, [now], /idx_worker_orders_issuer \(issued_by=\? AND issued_at>\?\)/],
      ["the pool's hour of restarts", POOL_RESTARTS_SQL, [now], /idx_worker_orders_issuer \(issued_by=\? AND issued_at>\?\)/],
      ["the community's hour of restarts", COMMUNITY_RESTARTS_SQL, [now], /idx_worker_orders_issuer \(issued_by=\? AND issued_at>\?\)/],
      ["an answer's order", ORDER_BY_ID_SQL, ["wo_x"], /sqlite_autoindex_worker_orders_1 \(id=\?\)/],
      ["a cancel's order", ORDER_OF_WORKER_SQL, ["wo_x", "w"], /sqlite_autoindex_worker_orders_1 \(id=\?\)/],
      ["a dead spell", DEAD_SPELLS_SQL, [now], /idx_build_workers_not_ready \(agent_error_since>\?\)/],
      // An updater's poll (#277, part 3): the workers it names, by the primary key — never a scan, whatever the fleet.
      ["an updater's follow", FOLLOW_SQL, ['["a","b"]'], /sqlite_autoindex_build_workers_1 \(id=\?\)/],
      ...OLD_ORDER_KEYS_SQL.map((sql, i): [string, string, unknown[], RegExp] => [`a once-per-window key (${i})`, sql, [now], /sqlite_autoindex_settings_1 \(key>\? AND key<\?\)/]),
      // Revoke (one worker) and block (an owner's): the workers' orders by their worker, the rows by their own index.
      ...([["revoke", "SELECT id FROM build_workers WHERE id = ? AND revoked_at = ?", ["w", now], /sqlite_autoindex_build_workers_1 \(id=\?\)/], ["block", "SELECT id FROM build_workers WHERE owner = ? AND revoked_at = ?", ["alice", now], /idx_build_workers_owner \(owner=\?\)/]] as const).flatMap(([what, which, binds, rows]): [string, string, unknown[], RegExp][] => [
        [`${what}: its lines`, CANCEL_LINES_SQL(which), ["d", ...binds], /SEARCH worker_orders USING INDEX idx_worker_orders_worker \(worker_id=\?\)/],
        [`${what}: its orders`, CANCEL_ORDERS_SQL(which), [now, "d", ...binds], /SEARCH worker_orders USING INDEX idx_worker_orders_worker \(worker_id=\?\)/],
        [`${what}: the rows`, CANCEL_ROWS_SQL(which), binds as unknown as unknown[], rows],
      ]),
    ];
    for (const [what, sql, args, want] of cases) {
      const p = await plan(sql, args);
      expect(p, what).toMatch(want);
      expect(p, what).not.toMatch(/SCAN (worker_orders|build_workers|settings)(?! USING)/);
    }
    // The issue's caps, inside the INSERT: each count by its index.
    const issuePlan = await plan(ISSUE_SQL, ["wo_x", "w", "restart", "r", "pool", null, "rule", 1, null, null, now, now, null, "pending", null, null, null, '["restart"]', now, 6, now, null]);
    for (const idx of ["idx_worker_orders_worker", "idx_worker_orders_issuer"]) expect(issuePlan).toContain(idx);
    expect(issuePlan).not.toMatch(/SCAN worker_orders(?! USING)/);
    const refresh = await plan(REFRESH_OPEN_SQL, ["w"]);
    expect(refresh).toMatch(/uq_worker_orders_open_kind/);
  });
});

describe("Update through the set's updater (#277, part 3)", () => {
  // A pool at a release, deployed two hours ago: a worker one behind is past the grace, handed nothing (426), and Update is what brings it.
  const REL = { ...env, POOL_VERSION: "v1.0.3", POOL_DEPLOYED_AT: new Date(Date.now() - 2 * 3600e3).toISOString() } as Env;
  let n = 0;
  /** The updater's poll, past the edge's thirty seconds (the key includes the query). */
  const follow = (q: string, on: Env = REL) => call("GET", `/factory/follow?${q}${q ? "&" : ""}n=${++n}`, undefined, {}, on);
  const up = (id: string, body: unknown, who: Who) => call("POST", `/factory/workers/${id}/orders`, body, who, REL);
  const can = (id: string, who: Who) => call("GET", `/factory/workers/${id}/can`, undefined, who, REL);
  const report = (updater: { image: string | null; follows: boolean } | null, host_script: "kick-v1" | "old" | "none") => ({ updater, host_script });
  const FOLLOWS = report({ image: "v1.0.2", follows: true }, "none");

  it("on an outdated builder: its owner and a maintainer may; follow lists it; no claim answer carries it; a claim on the pool's release closes it done, with one final line", async () => {
    const id = "upd-builder-aarch64-9a1b";
    await seedWorker(id, "aarch64", "alice", "community");
    // A builder from before orders: its image takes none — Update is its set's updater's, never the worker's.
    const old = await claim(id, { instance: null, orders: null, version: "v1.0.2", via: "broker" }, undefined, REL);
    expect(old.status).toBe(426);
    expect((await up(id, { kind: "update" }, page("bob"))).status).toBe(403);
    const mine = await up(id, { kind: "update", reason: "ten releases behind" }, page("alice"));
    expect(mine.status).toBe(201);
    expect(mine.json.order).toMatchObject({ kind: "update", state: "pending", issued_by: "alice" });
    expect(mine.json.note).toContain("its set's updater replaces it within 2 min");
    expect((await up(id, { kind: "update" }, cli("m2")))).toMatchObject({ status: 409, json: { error: expect.stringContaining("update is waiting already") } });
    const o = mine.json.order;
    expect(Date.parse((await orderOf(o.id)).expires_at) - Date.parse(o.issued_at)).toBe(360 * MIN);
    // The updater's poll names it; the public view marks it; a site parameter changes nothing.
    const f = await follow(`ids=${id}`);
    expect(f).toMatchObject({ status: 200, json: { latest: "v1.0.3", deployed_at: REL.POOL_DEPLOYED_AT, poll_s: 120, workers: [{ id, version: "v1.0.2", outdated: true, update: o.id }] } });
    expect((await follow(`ids=${id}&site=5d0e4b1a9c7f2e36`)).json.workers).toEqual(f.json.workers);
    // The worker's claims never carry it: still behind, a 426 with no orders.
    const again = await claim(id, { instance: 7001, orders: ["drain", "restart"], version: "v1.0.2", via: "broker" }, undefined, REL);
    expect(again.status).toBe(426);
    expect(again.json.orders).toBeUndefined();
    expect((await orderOf(o.id)).state).toBe("pending");
    // The updater replaced it: its next process claims on the release, and the order is done by observation.
    const now = await claim(id, { instance: 7002, orders: ["drain", "restart"], version: "v1.0.3", via: "broker" }, undefined, REL);
    expect(now.status).toBe(204);
    expect(await orderOf(o.id)).toMatchObject({ state: "done", answered_by: "pool", detail: "now runs v1.0.3" });
    expect((await linesOf(o.id)).map((l) => JSON.parse(l.payload).state)).toEqual(["pending", "done"]);
    expect((await follow(`ids=${id}`)).json.workers).toEqual([{ id, version: "v1.0.3", outdated: false, update: null }]);
    // On the release now: Update is refused, and says why.
    expect((await up(id, { kind: "update" }, page("alice")))).toMatchObject({ status: 409, json: { error: "runs v1.0.3, the latest — its updater follows each release within 2 min" } });
  });

  it("on a project worker, only where an updater from #277 on rolls its set out — every other set refused with its reason; the report written only when it changes", async () => {
    const cases: [string, unknown, string][] = [
      ["timer", report(null, "old"), "the runbook's The Studio host has the one-time step"],
      ["both", report({ image: "v1.0.2", follows: true }, "old"), "two rollouts run on this host"],
      ["old-updater", report({ image: "v1.0.1", follows: false }, "none"), "its updater (v1.0.1) is older than #277"],
      ["stopped", report(null, "kick-v1"), "releases do not reach it. Its ./rollout.sh starts it again"],
      ["none", report(null, "none"), "omarchy-worker start adds one"],
      ["bare", { unknown: "bare" }, "started without compose: nothing replaces it"],
      ["unidentified", { unknown: "unidentified" }, "it cannot identify its own container"],
      ["unreported", undefined, "its image (v1.0.2) does not report its set"],
    ];
    for (const [word, rollout, why] of cases) {
      const id = `upd-p-${word}`;
      await seedWorker(id, "aarch64", "m1", "project");
      expect((await claim(id, { instance: 7100, version: "v1.0.2", rollout }, undefined, REL)).status).toBe(426);
      const r = await up(id, { kind: "update" }, cli("m2"));
      expect(r.status, word).toBe(409);
      expect(r.json.error, word).toContain(why);
      expect((await can(id, page("m2"))).json.why.update, word).toBe(r.json.error);
      expect((await call("GET", `/factory/workers/${id}`, undefined, {}, REL)).json.worker.set_rollout, word).toBe(word === "bare" || word === "unidentified" || word === "unreported" ? "unknown" : word);
    }
    const id = "upd-p-follows";
    await seedWorker(id, "aarch64", "m1", "project");
    await claim(id, { instance: 7200, version: "v1.0.2", rollout: FOLLOWS }, undefined, REL);
    const row = await rowOf(id);
    expect(row.rollout).toBe(JSON.stringify(FOLLOWS));
    // The same report in another key order, within the liveness write's minutes: nothing written. Another report: written.
    await claim(id, { instance: 7200, version: "v1.0.2", rollout: { host_script: "none", updater: { follows: true, image: "v1.0.2" } } }, undefined, REL);
    expect((await rowOf(id)).last_seen).toBe(row.last_seen);
    await claim(id, { instance: 7200, version: "v1.0.2", rollout: report({ image: "v1.0.3", follows: true }, "kick-v1") }, undefined, REL);
    expect((await rowOf(id)).rollout).toBe(JSON.stringify(report({ image: "v1.0.3", follows: true }, "kick-v1")));
    expect((await call("GET", `/factory/workers/${id}`, undefined, {}, REL)).json.worker).toMatchObject({ set_rollout: "follows", set_line: "rolled out by its updater (v1.0.3) — follows each release within 2 min" });
    expect((await call("GET", `/factory/workers/${id}`, undefined, {}, REL)).json.worker.rollout).toBeUndefined();
    const ok = await up(id, { kind: "update" }, cli("m2"));
    expect(ok.status).toBe(201);
    expect(ok.json.note).toContain("with every service there that runs an older image");
    expect((await follow(`ids=${id},upd-p-timer`)).json.workers.map((w: any) => [w.id, w.update])).toEqual([[id, ok.json.order.id], ["upd-p-timer", null]]);
    // Two processes on one token (a copied token on another host) report two sets: the row keeps the one it had, and no claim flips it.
    const two = "upd-p-two";
    await seedWorker(two, "aarch64", "m1", "project");
    const here = report({ image: "v1.0.2", follows: true }, "none"), there = report(null, "old");
    await claim(two, { instance: 7500, version: "v1.0.2", rollout: here }, undefined, REL);
    await claim(two, { instance: 7501, version: "v1.0.2", rollout: here }, undefined, REL);
    await claim(two, { instance: 7500, version: "v1.0.2", rollout: there }, undefined, REL);
    expect((await rowOf(two)).instance_conflict_at).not.toBeNull();
    for (let i = 0; i < 4; i++) await claim(two, { instance: i % 2 ? 7501 : 7500, version: "v1.0.2", rollout: i % 2 ? here : there }, undefined, REL);
    expect((await rowOf(two)).rollout).toBe(JSON.stringify(here));
  });

  it("an Update nothing carries out expires after six hours, with the words of why and one final line", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = "upd-builder-lonely-5c6d";
    await seedWorker(id, "aarch64", "alice", "community");
    await claim(id, { instance: 7300, version: "v1.0.1", via: "broker" }, undefined, REL);
    const o = (await up(id, { kind: "update" }, cli("alice"))).json.order;
    await sweepOrders(REL, Date.now() + 5 * 60 * MIN);
    expect((await orderOf(o.id)).state).toBe("pending");
    await sweepOrders(REL, Date.now() + 6 * 60 * MIN + 1000);
    expect(await orderOf(o.id)).toMatchObject({ state: "expired", detail: UPDATE_EXPIRED });
    const lines = await linesOf(o.id);
    expect(lines.map((l) => JSON.parse(l.payload).state)).toEqual(["pending", "expired"]);
    expect(lines[1].status).toBe("warn");
  });

  it("names in the dialog the project workers of its host the updater replaces too, from the site's read — the default Studio's four, the emulated profile's six, a builder alone — and never to a stranger", async () => {
    const SITE2 = "a1b2c3d4e5f60718", SITE3 = "0f1e2d3c4b5a6978";
    const def = ["set-pool-x86_64", "set-pool-aarch64", "set-review-aarch64", "set-review2-aarch64"];
    const emu = ["emu-pool-x86_64", "emu-pool-aarch64", "emu-review-x86_64", "emu-review-aarch64", "emu-review2-x86_64", "emu-review2-aarch64"];
    for (const [ids, site] of [[def, SITE2], [emu, SITE3]] as const) {
      for (const [i, id] of ids.entries()) {
        await seedWorker(id, id.endsWith("x86_64") ? "x86_64" : "aarch64", "m1", "project");
        await claim(id, { instance: 7400 + i, version: "v1.0.2", site, rollout: FOLLOWS }, undefined, REL);
      }
    }
    const named = async (id: string, who: Who) => { const c = (await can(id, who)).json; return [id, ...c.update_with].sort(); };
    expect(await named("set-review-aarch64", page("m1"))).toEqual([...def].sort());
    expect(await named("emu-review2-x86_64", page("m2"))).toEqual([...emu].sort());
    const b = (await can("upd-builder-lonely-5c6d", page("alice"))).json;
    expect(b.update_with).toEqual([]);
    expect(b.update_note).toContain("an updater from before #277 replaces it at its own 15-min round");
    const stranger = (await can("set-review-aarch64", page("bob"))).json;
    expect(stranger.can.update).toBe(false);
    expect(stranger.update_with).toEqual([]);
  });

  it("follow: 1 to 16 well-formed ids, unknown and revoked ones left out, the pool's release as /version says it", async () => {
    expect((await follow("")).status).toBe(400);
    expect((await follow("ids=")).status).toBe(400);
    expect((await follow(`ids=${Array.from({ length: 17 }, (_, i) => `w${i}`).join(",")}`)).status).toBe(400);
    expect((await follow(`ids=${Array.from({ length: 16 }, (_, i) => `w${i}`).join(",")}`)).status).toBe(200);
    for (const bad of ["a%20b", "..%2Fx", "a;b", "%3Cscript%3E"]) expect((await follow(`ids=${bad}`)).status, bad).toBe(400);
    await seedWorker("upd-revoked-1", "aarch64", "alice", "community", { revoked_at: new Date().toISOString(), version: "v1.0.2" });
    expect((await follow("ids=upd-revoked-1,nobody-here,upd-p-follows")).json.workers.map((w: any) => w.id)).toEqual(["upd-p-follows"]);
    const version = await call("GET", "/version", undefined, {}, REL);
    const f = await follow("ids=upd-p-follows");
    expect(f.json.latest).toBe(version.json.version);
    expect(f.json.deployed_at).toBe(version.json.deployed_at);
    // What the answer is made of: nothing the listing does not show already — no site, no process, no order but its id.
    expect(Object.keys(f.json.workers[0]).sort()).toEqual(["id", "outdated", "update", "version"]);
  });

  it("follow: the edge keeps an answer thirty seconds per release — a deploy or a rollback is never served an answer from before it", async () => {
    const get = async (on: Env) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`${API}/factory/follow?ids=upd-p-follows&n=edge-release`), on, ctx);
      await waitOnExecutionContext(ctx);
      return { edge: res.headers.get("x-pool-cache"), cache: res.headers.get("cache-control"), latest: ((await res.json()) as any).latest };
    };
    const first = await get(REL);
    expect(first).toMatchObject({ edge: "miss", latest: "v1.0.3" });
    expect(first.cache).toBe("public, max-age=30");
    expect(await get(REL)).toMatchObject({ edge: "hit", latest: "v1.0.3" });
    // The pool moves on (a release) and back (a rollback), inside the thirty seconds: the same URL is read again each time.
    const next = { ...env, POOL_VERSION: "v1.0.4", POOL_DEPLOYED_AT: new Date().toISOString() } as Env;
    expect(await get(next)).toMatchObject({ edge: "miss", latest: "v1.0.4" });
    const back = { ...env, POOL_VERSION: "v1.0.3", POOL_DEPLOYED_AT: new Date(Date.now() + 1000).toISOString() } as Env;
    expect(await get(back)).toMatchObject({ edge: "miss", latest: "v1.0.3" });
    expect(await get(back)).toMatchObject({ edge: "hit", latest: "v1.0.3" });
  });
});
