/**
 * What #277's orders cost in D1, held to its design's budget (§7), through
 * the claim itself on a fake clock: an order is about twenty rows written,
 * indexes included; a fleet in an error a restart cannot help costs no
 * order and no row; an outage across the fleet trips the breaker before
 * the first restart and keeps it tripped, each held claim reading one row
 * and writing none; two failing hosts get their bounded restarts; and
 * whatever the fleet does, the pool's own orders stay under sixty a day and
 * their rows under the day's ceiling. Every statement is counted by a DB
 * that notes what it ran and what D1 said it wrote.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { MAX_POOL_ORDERS_PER_DAY, MAX_POOL_RECHECKS_PER_DAY, MAX_POOL_RESTARTS_PER_DAY, sweepOrders } from "../src/orders";

const API = "http://pool.test/api/v1";
const MIN = 60000;
const hex = (n: number) => n.toString(16).padStart(32, "0");

/** A DB that notes every statement it runs — batched or alone — with its SQL and the rows D1 says it wrote and read. */
function counted(): { env: Env; ran: { sql: string; written: number; read: number }[] } {
  const ran: { sql: string; written: number; read: number }[] = [];
  const sqlOf = new WeakMap<object, string>();
  const note = (sql: string, r: { meta?: { rows_written?: number; rows_read?: number } } | null) => ran.push({ sql, written: r?.meta?.rows_written ?? 0, read: r?.meta?.rows_read ?? 0 });
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const p = new Proxy(stmt, {
      get(s, k) {
        if (k === "bind") return (...args: unknown[]) => wrap(s.bind(...args), sql);
        if (k === "run" || k === "all") return async () => { const r = await (s as any)[k](); note(sql, r); return r; };
        if (k === "first") return async (col?: string) => { const r = await s.all(); note(sql, r); const row = (r.results as any[])[0] ?? null; return col ? row?.[col] ?? null : row; };
        const v = Reflect.get(s, k);
        return typeof v === "function" ? v.bind(s) : v;
      },
    });
    sqlOf.set(p, sql);
    real.set(p, stmt);
    return p;
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch") return async (stmts: D1PreparedStatement[]) => {
        const rs = await target.batch(stmts.map((s) => real.get(s) ?? s));
        rs.forEach((r, i) => note(sqlOf.get(stmts[i]) ?? "?", r));
        return rs;
      };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { env: { ...env, DB } as Env, ran };
}

/** The statements that are the orders' own: not the claim's own write, the token's read or the queue's. */
const ORDERS_SQL = /\bworker_orders\b|SET auto_orders|SET open_orders|'order'|FROM settings|INTO settings/;

async function claim(on: Env, id: string, body: Record<string, unknown>): Promise<any> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${API}/factory/claim`, { method: "POST", headers: { authorization: `Bearer omw_${id}`, "content-type": "application/json" }, body: JSON.stringify(body) }), on, ctx);
  await waitOnExecutionContext(ctx);
  return res.status === 200 ? res.json() : null;
}
async function answer(on: Env, id: string, oid: string, body: unknown) {
  const ctx = createExecutionContext();
  await worker.fetch(new Request(`${API}/factory/workers/self/orders/${oid}`, { method: "POST", headers: { authorization: `Bearer omw_${id}`, "content-type": "application/json" }, body: JSON.stringify(body) }), on, ctx);
  await waitOnExecutionContext(ctx);
}

async function seed(ids: string[]) {
  const stmts = [];
  for (const id of ids) stmts.push(env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES (?, 'aarch64', 'm1', ?, 'shared', 'project', 'm1', ?)").bind(id, await sha256Hex(`omw_${id}`), new Date().toISOString()));
  await env.DB.batch(stmts);
}

/**
 * A worker as #277's image runs it, with the agent `agent(t)` says: its
 * claims report its last probe, which changes when an order asks for one
 * or a new process starts — its own backoff waits half an hour, and that
 * is inside the runs below too — and it answers every order it gets.
 */
class Sim {
  n = 0;
  process: number;
  probe: { status: string; error?: string; checked: string };
  constructor(public id: string, public site: string | null, public provider: string, public agent: (t: number) => { status: "ok" | "error"; error?: string }, t0: number, seedN: number) {
    this.process = seedN * 1000;
    this.probe = this.ask(t0);
  }
  ask(t: number) { return { ...this.agent(t), checked: `${this.id}-${++this.n}`, at: t } as { status: string; error?: string; checked: string; at: number }; }
  async tick(on: Env, t: number, orders: { kind: string; t: number }[]) {
    const last = (this.probe as any).at as number;
    if (t - last >= 30 * MIN) this.probe = this.ask(t);
    const body = { arch: "aarch64", version: "v1.0.2", agent: `${this.provider}/model-1`, agent_status: this.probe.status, agent_error: this.probe.error ?? "", agent_checked_at: this.probe.checked, orders: ["drain", "recheck-agent", "restart"], instance: hex(this.process), agent_via: "direct", ...(this.site ? { site: this.site } : {}) };
    const r = await claim(on, this.id, body);
    for (const o of r?.orders ?? []) {
      orders.push({ kind: o.kind, t });
      this.probe = this.ask(t);
      if (o.kind === "recheck-agent") await answer(on, this.id, o.id, { instance: hex(this.process), outcome: "done", code: "probed" });
      else if (this.probe.status === "ok") await answer(on, this.id, o.id, { instance: hex(this.process), outcome: "refused", code: "agent-ok" });
      else {
        await answer(on, this.id, o.id, { instance: hex(this.process), outcome: "accepted", code: "exiting" });
        this.process++;
        this.probe = this.ask(t + 5000);
      }
    }
  }
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES ('m1')"),
    env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('m1', ?, ?, 'maintainer')").bind(await sha256Hex("omc_m1"), await sha256Hex("oms_m1")),
  ]);
});
afterEach(() => vi.useRealTimers());

describe("what an order costs", () => {
  it("about twenty rows written, indexes included: the pool's re-check, issued and delivered at a claim, answered, and its two lines", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { env: on, ran } = counted();
    await seed(["cost-one"]);
    const t0 = Date.now();
    const base = { arch: "aarch64", version: "v1.0.2", agent: "p-cost/model-1", agent_status: "error", agent_error: "URLError: [Errno 111] Connection refused", agent_checked_at: "a", orders: ["drain", "recheck-agent", "restart"], instance: hex(1), agent_via: "direct" };
    await claim(on, "cost-one", base);
    ran.length = 0;
    vi.setSystemTime(t0 + 6 * MIN);
    const got = await claim(on, "cost-one", base);
    expect(got.orders.map((o: any) => o.kind)).toEqual(["recheck-agent"]);
    await answer(on, "cost-one", got.orders[0].id, { instance: hex(1), outcome: "done", code: "probed" });
    const mine = ran.filter((x) => ORDERS_SQL.test(x.sql));
    const written = mine.reduce((n, x) => n + x.written, 0);
    expect(written, mine.map((x) => `${x.written} ${x.sql.slice(0, 60)}`).join("; ")).toBeGreaterThan(0);
    expect(written, mine.map((x) => `${x.written} ${x.sql.slice(0, 60)}`).join("; ")).toBeLessThanOrEqual(22);
  });
});

describe("a fleet, on the worst days", () => {
  it("fifty workers whose agent has no credit, a whole day: no order, no order row, nothing the claims would not write anyway", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { env: on, ran } = counted();
    const ids = Array.from({ length: 50 }, (_, i) => `credit-${i}`);
    await seed(ids);
    const t0 = Date.now();
    const sims = ids.map((id, i) => new Sim(id, null, "p-credit", () => ({ status: "error", error: "HTTPError: HTTP Error 402: Payment Required" }), t0, i + 1));
    const orders: { kind: string; t: number }[] = [];
    for (let m = 0; m <= 24 * 60; m += 60) {
      for (const [i, s] of sims.entries()) { vi.setSystemTime(t0 + m * MIN + i * 100); await s.tick(on, t0 + m * MIN, orders); }
    }
    expect(orders).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM worker_orders WHERE worker_id LIKE 'credit-%'").first<{ n: number }>())!.n).toBe(0);
    expect(ran.filter((x) => ORDERS_SQL.test(x.sql)).map((x) => x.sql)).toEqual([]);
  });

  it("an outage across twelve hosts, a whole day: the breaker trips before the first restart, once, and stays; a held claim reads its key and writes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { env: on, ran } = counted();
    const ids = Array.from({ length: 12 }, (_, i) => `outage-${i}`);
    await seed(ids);
    const t0 = Date.now();
    const sims = ids.map((id, i) => new Sim(id, (i + 1).toString(16).padStart(16, "c"), "p-outage", () => ({ status: "error", error: "URLError: <urlopen error [Errno 111] Connection refused>" }), t0, 100 + i));
    const orders: { kind: string; t: number }[] = [];
    let held = 0;
    for (let m = 0; m <= 24 * 60; m += 10) {
      for (const [i, s] of sims.entries()) {
        vi.setSystemTime(t0 + m * MIN + i * 100);
        const before = ran.length;
        await s.tick(on, t0 + m * MIN, orders);
        const mine = ran.slice(before).filter((x) => ORDERS_SQL.test(x.sql));
        // Past the step-0 re-checks (10 min) and the trip (20 min): a claim the breaker holds reads the key, by its primary key, and nothing else of the orders.
        if (m >= 30 && mine.length) {
          held++;
          expect(mine.map((x) => x.sql), `${s.id} at ${m} min`).toEqual(["SELECT value FROM settings WHERE key = ?"]);
          expect(mine[0].read).toBeLessThanOrEqual(1);
          expect(mine[0].written).toBe(0);
        }
      }
      if (m % 10 === 0) await sweepOrders(on, t0 + m * MIN + 5000);
    }
    expect(held).toBeGreaterThan(1000);
    expect(orders.filter((o) => o.kind !== "recheck-agent")).toEqual([]);
    expect(orders.filter((o) => o.kind === "recheck-agent")).toHaveLength(12);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'order' AND summary LIKE 'provider outage suspected: % p-outage sites%'").first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'order' AND summary LIKE 'provider outage over: % p-outage%'").first<{ n: number }>())!.n).toBe(0);
  });

  it("two hosts failing a whole day: each worker restarted at most three times and re-checked at most three times", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { env: on } = counted();
    const ids = ["pair-a", "pair-b"];
    await seed(ids);
    const t0 = Date.now();
    const per: Record<string, { kind: string; t: number }[]> = { "pair-a": [], "pair-b": [] };
    // Flapping: down for two hours, up for ten minutes, again.
    const agent = (t: number) => (((t - t0) / MIN) % 130 < 120 ? { status: "error" as const, error: "URLError: [Errno 111] Connection refused" } : { status: "ok" as const });
    const sims = ids.map((id, i) => new Sim(id, (i + 1).toString(16).padStart(16, "d"), "p-pair", agent, t0, 200 + i));
    for (let m = 0; m <= 24 * 60; m += 1) {
      for (const [i, s] of sims.entries()) { vi.setSystemTime(t0 + m * MIN + i * 100); await s.tick(on, t0 + m * MIN, per[s.id]); }
      if (m % 10 === 0) await sweepOrders(on, t0 + m * MIN + 5000);
    }
    for (const id of ids) {
      expect(per[id].filter((o) => o.kind === "restart").length, id).toBeGreaterThan(0);
      expect(per[id].filter((o) => o.kind === "restart").length, id).toBeLessThanOrEqual(MAX_POOL_RESTARTS_PER_DAY);
      expect(per[id].filter((o) => o.kind === "recheck-agent").length, id).toBeLessThanOrEqual(MAX_POOL_RECHECKS_PER_DAY);
    }
  });

  it("whatever the fleet does, the pool's orders stay under sixty a day and their rows under the day's ceiling", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { env: on, ran } = counted();
    const rnd = seeded(277);
    const ids = Array.from({ length: 10 }, (_, i) => `any-${i}`);
    await seed(ids);
    const t0 = Date.now();
    const errors = ["URLError: [Errno 111] Connection refused", "URLError: [Errno -2] Name or service not known", "HTTPError: HTTP Error 402: Payment Required", "KeyError: 'content'", "Claude Code did not install", "HTTPError: HTTP Error 503: Service Unavailable"];
    // Each worker's own schedule: spells of a random class, of random length, between random answers.
    const plans = ids.map(() => Array.from({ length: 40 }, () => ({ len: 5 + Math.floor(rnd() * 120), down: rnd() < 0.7, error: errors[Math.floor(rnd() * errors.length)] })));
    const agentOf = (i: number) => (t: number) => {
      let m = (t - t0) / MIN;
      for (const p of plans[i]) { if (m < p.len) return p.down ? { status: "error" as const, error: p.error } : { status: "ok" as const }; m -= p.len; }
      return { status: "ok" as const };
    };
    // Every worker on a host of its own, so the breaker (three hosts) is what the schedule makes of it.
    const sims = ids.map((id, i) => new Sim(id, (i + 1).toString(16).padStart(16, "e"), "p-any", agentOf(i), t0, 300 + i));
    const orders: { kind: string; t: number }[] = [];
    for (let m = 0; m <= 24 * 60; m += 5) {
      for (const [i, s] of sims.entries()) { vi.setSystemTime(t0 + m * MIN + i * 100); await s.tick(on, t0 + m * MIN, orders); }
      if (m % 10 === 0) await sweepOrders(on, t0 + m * MIN + 5000);
    }
    const pool = (await env.DB.prepare("SELECT COUNT(*) AS n FROM worker_orders WHERE issued_by = 'pool' AND worker_id LIKE 'any-%'").first<{ n: number }>())!.n;
    expect(pool).toBe(orders.length);
    expect(pool).toBeLessThanOrEqual(MAX_POOL_ORDERS_PER_DAY);
    const written = ran.filter((x) => ORDERS_SQL.test(x.sql)).reduce((n, x) => n + x.written, 0);
    expect(written).toBeLessThanOrEqual(1300);
  });
});

/** A seeded generator (mulberry32): the same schedule every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
