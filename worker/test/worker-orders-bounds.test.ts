/**
 * #277's orders at their edges, inside workerd with a real D1 of their own
 * (a file apart from worker-orders.test.ts, whose record test walks every
 * order it made): what closes an order when two paths race for it, the
 * fleet breaker's whole matrix — which rows count, its hysteresis, a dead
 * site, a trip two claims make at once, a key the weekly gc keeps — and
 * whose spells hold whom; a host's shared agent service, restarted through
 * one worker, then the worker itself once the service answers another; the
 * budget's shares and the pool's own names, which no person can take;
 * a claim that names no process; what a liveness write of a failing worker
 * costs; the kill switch; the orders path that throws; and an order that
 * rides the 426 of an outdated worker.
 *
 * The Studio's default set is two review workers behind one agent-proxy on
 * one host; the emulated profile's is four (#277's design, P10). Tokens are
 * omw_<id>; sessions oms_<login>, CLI tokens omc_<login>.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { handleClaim } from "../src/routes/factory";
import { sha256Hex, workerOf } from "../src/routes/contributors";
import {
  breakerHolds, OPEN_ORDERS_SQL, OPEN_SPELLS_SQL, SITE_WORKERS_SQL, sweepOrders,
  BREAKER_CLEAR_MIN, MAX_POOL_COMMUNITY_ORDERS_PER_DAY, MAX_POOL_COMMUNITY_RESTARTS_PER_HOUR, POOL_COMMUNITY, POOL_PROJECT, TTL_PERSON_MIN,
} from "../src/orders";
import { OLD_ORDER_KEYS_SQL } from "../src/routes/gc";

const ORIGIN = "http://pool.test";
const API = `${ORIGIN}/api/v1`;
const MIN = 60000;
const hex = (n: number) => n.toString(16).padStart(32, "0");
const ARCH: Record<string, string> = {};
const REFUSED = "URLError: <urlopen error [Errno 111] Connection refused>";
const BAD_GATEWAY = "HTTPError: HTTP Error 502: Bad Gateway";

interface Who { token?: string; cookie?: string; origin?: string | null; headers?: Record<string, string> }
async function call(method: string, path: string, body?: unknown, who: Who = {}, on: Env = env): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...(who.headers ?? {}) };
  if (body !== undefined || (method === "DELETE" && who.cookie)) headers["content-type"] = "application/json";
  if (who.token) headers.authorization = `Bearer ${who.token}`;
  if (who.cookie) headers.cookie = who.cookie;
  if (who.origin) headers.origin = who.origin;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), on, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const cli = (login: string): Who => ({ token: `omc_${login}` });

interface Said { instance?: number | null; orders?: string[] | null; status?: "ok" | "error"; error?: string; checked?: string; via?: string; site?: string; version?: string; agent?: string }
function claimOf(id: string, o: Said = {}) {
  return {
    arch: ARCH[id], hostname: "studio", version: o.version ?? "v1.0.2", agent: o.agent ?? "claude-code/claude-sonnet-5",
    agent_status: o.status ?? "ok", agent_error: o.error ?? "", agent_checked_at: o.checked ?? "c0",
    ...(o.orders === null ? {} : { orders: o.orders ?? ["drain", "recheck-agent", "restart", "restart-agent"] }),
    ...(o.instance === null ? {} : { instance: hex(o.instance ?? 1) }),
    agent_via: o.via ?? "direct", ...(o.site ? { site: o.site } : {}),
  };
}
const claim = (id: string, o: Said = {}, on: Env = env) => call("POST", "/factory/claim", claimOf(id, o), { token: `omw_${id}` }, on);
const answer = (id: string, oid: string, body: unknown) => call("POST", `/factory/workers/self/orders/${oid}`, body, { token: `omw_${id}` });
const issue = (id: string, body: unknown, who: Who) => call("POST", `/factory/workers/${id}/orders`, body, who);
const view = (id: string) => call("GET", `/factory/workers/${id}?fresh=${Math.random()}`);
const rowOf = (id: string) => env.DB.prepare("SELECT * FROM build_workers WHERE id = ?").bind(id).first<any>();
const orderOf = (oid: string) => env.DB.prepare("SELECT * FROM worker_orders WHERE id = ?").bind(oid).first<any>();
const linesOf = async (oid: string) => (await env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'order' AND json_extract(payload, '$.order') = ? ORDER BY id").bind(oid).all<{ status: string; summary: string; payload: string }>()).results;
const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;
/** Journal lines that begin with `prefix` (D1 refuses a long LIKE pattern). */
const linesStarting = (prefix: string) => count("SELECT COUNT(*) AS n FROM events WHERE substr(summary, 1, ?) = ?", prefix.length, prefix);

async function seedWorker(id: string, owner: string | null, trust: "project" | "community", extra: Record<string, unknown> = {}, arch = "aarch64") {
  ARCH[id] = arch;
  const cols = ["id", "arch", "owner", "token_hash", "mode", "trust", "trusted_by", "last_seen", ...Object.keys(extra)];
  const vals = [id, arch, owner, await sha256Hex(`omw_${id}`), trust === "project" ? "shared" : "dedicated", trust, trust === "project" ? "m1" : null, new Date().toISOString(), ...Object.values(extra)];
  await env.DB.prepare(`INSERT INTO build_workers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...vals).run();
}

/** A DB that notes every statement it runs — batched or alone — with its SQL and what D1 said it read and wrote. */
function counted(on: Env = env): { env: Env; ran: { sql: string; written: number; read: number }[] } {
  const ran: { sql: string; written: number; read: number }[] = [];
  const sqlOf = new WeakMap<object, string>();
  const real = new WeakMap<object, D1PreparedStatement>();
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
  const DB = new Proxy(on.DB, {
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
  return { env: { ...on, DB } as Env, ran };
}

/** The claim through handleClaim, with an env of the test's making (a DB that throws, or runs something in between). */
async function claimWith(on: Env, id: string, o: Said = {}): Promise<Response> {
  const req = new Request(`${API}/factory/claim`, { method: "POST", headers: { authorization: `Bearer omw_${id}`, "content-type": "application/json" }, body: JSON.stringify(claimOf(id, o)) });
  const w = (await workerOf(req.clone(), env))!;
  return handleClaim(req, on, { kind: "worker", w });
}

/**
 * A worker's claims every 30 s from `from` for `minutes`, its agent as
 * `agent(t)` says; each order answered as a worker from #277 on answers it
 * (a re-check probes now; a restart probes, and exits unless the agent
 * answers; a restart of the agent service restarts it and asks again).
 */
async function run(id: string, o: { from: number; minutes: number; agent: (t: number) => { status: "ok" | "error"; error?: string }; via?: string; site?: string; provider: string; instance?: number; on?: Env; offset?: number }) {
  const got: { t: number; kind: string; id: string }[] = [];
  let n = 0;
  const probe = (t: number) => ({ ...o.agent(t), checked: `${id}-${++n}` });
  let last = probe(o.from);
  const inst = o.instance ?? 1;
  for (let s = 0; s <= o.minutes * 2; s++) {
    const t = o.from + s * 30000 + (o.offset ?? 0);
    vi.setSystemTime(t);
    const res = await claim(id, { instance: inst, status: last.status, error: last.error, checked: last.checked, via: o.via, site: o.site, agent: `${o.provider}/model-1` }, o.on);
    for (const ord of res.json?.orders ?? []) {
      got.push({ t, kind: ord.kind, id: ord.id });
      last = probe(t);
      if (ord.kind === "recheck-agent") await answer(id, ord.id, { instance: hex(inst), outcome: "done", code: "probed" });
      else if (last.status === "ok") await answer(id, ord.id, { instance: hex(inst), outcome: "refused", code: "agent-ok" });
      else await answer(id, ord.id, { instance: hex(inst), outcome: "accepted", code: ord.kind === "restart" ? "exiting" : "restarting" });
    }
  }
  return got;
}

beforeAll(async () => {
  const h = (t: string) => sha256Hex(t);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('m1', ?, ?, 'maintainer'), ('m2', ?, ?, 'maintainer'), ('mallory', ?, ?, 'contributor'), ('pool', ?, ?, 'contributor')`)
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_mallory"), await h("oms_mallory"), await h("omc_pool"), await h("oms_pool")),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("one final line per order, whichever path closed it", () => {
  it("a person's Cancel between the claim's read of its orders and its close: the claim's close changes nothing and writes no line", async () => {
    const id = "race-cancel";
    await seedWorker(id, "m1", "project");
    await claim(id, { instance: 1, orders: ["drain", "recheck-agent", "restart"] });
    const o = (await issue(id, { kind: "restart" }, cli("m1"))).json.order;
    // The claim reads the open orders; while it decides, m2 cancels the restart; then it closes the order it read, refused (this process no longer declares restart).
    const racing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => {
          const st = target.prepare(sql);
          if (sql !== OPEN_ORDERS_SQL) return st;
          return new Proxy(st, { get(s, k) { if (k === "bind") return (...a: unknown[]) => { const b = s.bind(...a); return new Proxy(b, { get(x, kk) { if (kk === "all") return async () => { const r = await x.all(); expect((await call("DELETE", `/factory/workers/${id}/orders/${o.id}`, undefined, cli("m2"))).status).toBe(200); return r; }; const v = Reflect.get(x, kk); return typeof v === "function" ? v.bind(x) : v; } }); }; const v = Reflect.get(s, k); return typeof v === "function" ? v.bind(s) : v; } });
        };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await claimWith({ ...env, DB: racing } as Env, id, { instance: 1, orders: ["drain", "recheck-agent"] });
    expect(res.status).toBe(204);
    expect((await orderOf(o.id)).state).toBe("cancelled");
    expect((await linesOf(o.id)).map((l) => JSON.parse(l.payload).state)).toEqual(["pending", "cancelled"]);
  });

  it("a delivered order keeps its half hour to answer even when it was delivered in its TTL's last minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const id = "late-delivery";
    await seedWorker(id, "m1", "project");
    await claim(id, { instance: 1 });
    const o = (await issue(id, { kind: "restart" }, cli("m1"))).json.order;
    // Delivered a minute before its six hours are up.
    vi.setSystemTime(t0 + (TTL_PERSON_MIN - 1) * MIN);
    expect((await claim(id, { instance: 1 })).json.orders.map((x: any) => x.id)).toEqual([o.id]);
    await sweepOrders(env, t0 + (TTL_PERSON_MIN + 2) * MIN);
    expect((await orderOf(o.id)).state).toBe("delivered");
    await sweepOrders(env, t0 + (TTL_PERSON_MIN - 1 + 31) * MIN);
    expect(await orderOf(o.id)).toMatchObject({ state: "failed", detail: "no answer within 30 min of delivery" });
    expect((await linesOf(o.id)).length).toBe(2);
  });
});

describe("the fleet breaker's matrix", () => {
  /** A failing worker's row of the breaker's read: alive, in a spell, in a class the pool restarts on, of `provider`. */
  async function failing(id: string, provider: string, o: Record<string, unknown> = {}, at = Date.now()) {
    const cols: Record<string, unknown> = { agent: `${provider}/model-1`, agent_status: "error", agent_error: REFUSED, agent_error_class: "refused", agent_error_since: new Date(at - 60 * MIN).toISOString(), last_seen: new Date(at).toISOString(), ...o };
    await seedWorker(id, (cols.owner as string) ?? "m1", (cols.trust as "project" | "community") ?? "project", Object.fromEntries(Object.entries(cols).filter(([k]) => k !== "owner" && k !== "trust" && k !== "last_seen")));
    await env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id = ?").bind(cols.last_seen, id).run();
  }
  const self = (id: string, provider: string, o: { site?: string | null; trust?: string } = {}) => ({ id, site: o.site ?? null, agent: `${provider}/model-1`, cls: "refused" as const, trust: o.trust ?? "project" });
  const key = (provider: string, scope: "project" | "all" = "project") => env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`worker-breaker:${provider}${scope === "project" ? ":project" : ""}`).first<{ value: string }>();

  it("counts three sites of one provider with an open spell, the claiming worker among them; each of these leaves two, and nothing trips", async () => {
    const now = Date.now();
    // Two other sites and the claiming worker (a site of its own, without one): tripped, one line.
    await failing("mx-a1", "mx-a", { site: "project/aa" });
    await failing("mx-a2", "mx-a");
    expect(await breakerHolds(env, self("mx-a0", "mx-a"), now)).toMatchObject({ peak: 3 });
    expect(await linesStarting("provider outage suspected: 3 mx-a sites of the project's own")).toBe(1);
    // Each variant has one of the two others that must not count: nothing trips.
    const variants: [string, Record<string, unknown>][] = [
      ["not seen for 11 min", { last_seen: new Date(now - 11 * MIN).toISOString() }],
      ["revoked", { revoked_at: new Date(now - MIN).toISOString() }],
      ["its key refused (auth)", { agent_error: "HTTP 401", agent_error_class: "auth" }],
      ["the provider's own trouble (remote)", { agent_error: "HTTP 503", agent_error_class: "remote" }],
      ["an error the pool does not know", { agent_error: "KeyError", agent_error_class: "unknown" }],
      ["another provider", { agent: "other-provider/model-1" }],
      ["its spell ended", { agent_status: "ok", agent_error_since: null }],
      ["on the same site as the other", { site: "project/bb" }],
    ];
    for (const [i, [what, o]] of variants.entries()) {
      const p = `mx-v${i}`;
      await failing(`${p}-1`, p, { site: "project/bb" });
      await failing(`${p}-2`, p, o);
      expect(await breakerHolds(env, self(`${p}-0`, p), now), what).toBeNull();
      expect(await key(p), what).toBeNull();
    }
  });

  it("holds a project worker only for the project's own spells: three community registrations saying the same error hold the community ones, never the project's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const provider = "mx-mal";
    // A maintainer's legacy set (#343: a contributor's registration claims nothing): what it says of its agent is still its own word.
    for (const i of [1, 2, 3]) await seedWorker(`comm-fake-${i}`, "m2", "community");
    await seedWorker("mx-studio-review", "m1", "project");
    const agent = () => ({ status: "error" as const, error: REFUSED });
    const got: Record<string, string[]> = {};
    for (let s = 0; s <= 24; s++) {
      for (const id of ["comm-fake-1", "comm-fake-2", "comm-fake-3", "mx-studio-review"]) {
        const t = t0 + s * 30000 + (id.endsWith("review") ? 20000 : Number(id.slice(-1)) * 1000);
        vi.setSystemTime(t);
        const res = await claim(id, { instance: 7, status: "error", error: agent().error, checked: "c1", agent: `${provider}/model-1` });
        for (const o of res.json?.orders ?? []) {
          (got[id] ??= []).push(o.kind);
          await answer(id, o.id, { instance: hex(7), outcome: o.kind === "recheck-agent" ? "done" : "accepted", code: o.kind === "recheck-agent" ? "probed" : "exiting" });
        }
      }
    }
    // The community three trip the breaker of their scope, and get nothing but their re-check.
    expect(await key(provider, "all")).not.toBeNull();
    for (const i of [1, 2, 3]) expect(got[`comm-fake-${i}`]).toEqual(["recheck-agent"]);
    // The project's worker gets its restart: its scope counts the project's own spells, one site.
    expect(await key(provider, "project")).toBeNull();
    expect(got["mx-studio-review"]).toEqual(["recheck-agent", "restart"]);
    // Its page says nothing of a breaker; theirs do.
    expect((await view("mx-studio-review")).json.breaker).toBeNull();
    expect((await view("comm-fake-1")).json.breaker).toMatchObject({ provider, scope: "all" });
  });

  it("clears with hysteresis only: a count back at two starts the wait again; one below for fifteen minutes clears it, once; alternating one and three never does", async () => {
    const t0 = Date.now();
    const p = "mx-h";
    for (const i of [1, 2, 3]) await failing(`${p}-${i}`, p, { site: `project/h${i}` }, t0);
    expect(await breakerHolds(env, self(`${p}-1`, p, { site: "project/h1" }), t0)).not.toBeNull();
    // Keep the rows alive at time t, open (in the spell) or not.
    const at = async (t: number, open: number[]) => {
      for (const i of [1, 2, 3]) await env.DB.prepare("UPDATE build_workers SET last_seen = ?, agent_status = ?, agent_error_since = ? WHERE id = ?").bind(new Date(t).toISOString(), open.includes(i) ? "error" : "ok", open.includes(i) ? new Date(t0 - 60 * MIN).toISOString() : null, `${p}-${i}`).run();
      await sweepOrders(env, t);
      return breakerOfValue((await key(p))?.value);
    };
    const breakerOfValue = (v?: string) => (v ? JSON.parse(v) as { below_since: string | null; peak: number } : null);
    expect(await at(t0 + 10 * MIN, [1])).toMatchObject({ below_since: new Date(t0 + 10 * MIN).toISOString() });
    // Two again at the next sweep: the wait starts over.
    expect(await at(t0 + 20 * MIN, [1, 2])).toMatchObject({ below_since: null });
    expect(await at(t0 + 30 * MIN, [1])).toMatchObject({ below_since: new Date(t0 + 30 * MIN).toISOString() });
    expect(await at(t0 + 40 * MIN, [1])).not.toBeNull();
    expect(await at(t0 + 30 * MIN + BREAKER_CLEAR_MIN * MIN, [1])).toBeNull();
    expect(await linesStarting("provider outage over: fewer than 2 mx-h sites")).toBe(1);
    // No flap: one and three at alternate sweeps for two hours — one trip, no clear.
    const q = "mx-f";
    const u0 = t0 + 200 * MIN;
    for (const i of [1, 2, 3]) await failing(`${q}-${i}`, q, { site: `project/f${i}` }, u0);
    expect(await breakerHolds(env, self(`${q}-1`, q, { site: "project/f1" }), u0)).not.toBeNull();
    for (let k = 1; k <= 12; k++) {
      const t = u0 + k * 10 * MIN;
      for (const i of [1, 2, 3]) await env.DB.prepare("UPDATE build_workers SET last_seen = ?, agent_status = ?, agent_error_since = ? WHERE id = ?").bind(new Date(t).toISOString(), k % 2 || i === 1 ? "error" : "ok", k % 2 || i === 1 ? new Date(u0).toISOString() : null, `${q}-${i}`).run();
      await sweepOrders(env, t);
      expect(await key(q), `sweep ${k}`).not.toBeNull();
    }
    expect(await linesStarting("provider outage over: fewer than 2 mx-f")).toBe(0);
  });

  it("stops counting a site whose worker no longer claims, is never scaled, trips once when two claims trip it at once, and keeps its key through the weekly gc", async () => {
    const now = Date.now();
    // A site whose worker stopped claiming 11 minutes ago: two left, nothing trips.
    const p = "mx-d";
    await failing(`${p}-1`, p, { site: "project/d1" }, now);
    await failing(`${p}-2`, p, { site: "project/d2", last_seen: new Date(now - 11 * MIN).toISOString() }, now);
    expect(await breakerHolds(env, self(`${p}-0`, p), now)).toBeNull();
    // Two claims that trip it at once: one key, one line.
    const q = "mx-t";
    await failing(`${q}-1`, q, { site: "project/t1" }, now);
    await failing(`${q}-2`, q, { site: "project/t2" }, now);
    await failing(`${q}-3`, q, { site: "project/t3" }, now);
    const both = await Promise.all([breakerHolds(env, self(`${q}-1`, q, { site: "project/t1" }), now), breakerHolds(env, self(`${q}-2`, q, { site: "project/t2" }), now)]);
    expect(both.every((b) => b !== null)).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key = ?", `worker-breaker:${q}:project`)).toBe(1);
    expect(await linesStarting(`provider outage suspected: 3 ${q} sites`)).toBe(1);
    // Never scaled: a development pool at 60 times the rules' pace still waits fifteen real minutes below two to clear it.
    const scaled = { ...env, POOL_VERSION: "dev", WORKER_RULES_SCALE: "60" } as Env & { WORKER_RULES_SCALE: string };
    await env.DB.prepare(`UPDATE build_workers SET agent_status = 'ok', agent_error_since = NULL WHERE id IN ('${q}-2', '${q}-3')`).run();
    await sweepOrders(scaled, now + MIN);
    await sweepOrders(scaled, now + 2 * MIN);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key = ?", `worker-breaker:${q}:project`)).toBe(1);
    // The weekly gc prunes the once-per-window keys past a week, never a breaker's.
    await env.DB.prepare("UPDATE settings SET updated_at = ? WHERE key = ?").bind(new Date(now - 8 * 86400000).toISOString(), `worker-breaker:${q}:project`).run();
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('order-cap:m9:2026-01-01T00', 'x', ?)").bind(new Date(now - 8 * 86400000).toISOString()).run();
    await env.DB.batch(OLD_ORDER_KEYS_SQL.map((sql) => env.DB.prepare(sql).bind(new Date(now - 7 * 86400000).toISOString())));
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key = ?", `worker-breaker:${q}:project`)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key = 'order-cap:m9:2026-01-01T00'")).toBe(0);
  });
});

describe("a host's shared agent service", () => {
  /** Workers of one host behind one agent-proxy, claiming turn by turn; `agent(id, t)` is each one's probe. Each test's host is a site of its own. */
  async function host(ids: string[], o: { site: string; t0: number; minutes: number; agent: (id: string, t: number) => { status: "ok" | "error"; error?: string }; at?: (t: number) => Promise<void> }) {
    const SITE = o.site;
    const got: Record<string, string[]> = Object.fromEntries(ids.map((id) => [id, []]));
    const probes: Record<string, { status: string; error?: string; checked: string }> = {};
    // Each worker's process: a restart it accepts ends it, and the next one claims (the restart policy's work).
    const process: Record<string, number> = Object.fromEntries(ids.map((id, i) => [id, 50 + i * 100]));
    let n = 0;
    for (let s = 0; s <= o.minutes * 2; s++) {
      for (const [i, id] of ids.entries()) {
        const t = o.t0 + s * 30000 + i * 1000;
        vi.setSystemTime(t);
        const want = o.agent(id, t);
        if (!probes[id] || probes[id].status !== want.status) probes[id] = { ...want, checked: `p${++n}` };
        const inst = hex(process[id]);
        const res = await claim(id, { instance: process[id], status: probes[id].status as "ok" | "error", error: probes[id].error, checked: probes[id].checked, via: "sibling", site: SITE, agent: "mx-site/model-1" });
        for (const ord of res.json?.orders ?? []) {
          got[id].push(ord.kind);
          probes[id] = { ...o.agent(id, t), checked: `p${++n}` };
          if (ord.kind === "recheck-agent") await answer(id, ord.id, { instance: inst, outcome: "done", code: "probed" });
          else if (ord.kind === "restart-agent") {
            await answer(id, ord.id, { instance: inst, outcome: "accepted", code: "restarting" });
            await answer(id, ord.id, { instance: inst, outcome: probes[id].status === "ok" ? "done" : "failed", code: probes[id].status === "ok" ? "restarted" : "not-answering", service: "agent-proxy", seconds: 20 });
          } else if (probes[id].status === "ok") await answer(id, ord.id, { instance: inst, outcome: "refused", code: "agent-ok" });
          else { await answer(id, ord.id, { instance: inst, outcome: "accepted", code: "exiting" }); process[id]++; }
        }
      }
      if (o.at) await o.at(o.t0 + s * 30000);
    }
    return got;
  }

  it("restarts the service through its elected worker; once it answers that worker, the other whose own probe still fails is restarted itself — and its page says so at each step", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const [a, b] = ["sib-review-a", "sib-review-b"];
    for (const id of [a, b]) await seedWorker(id, "m1", "project");
    let aFixed = Number.POSITIVE_INFINITY;
    const words: string[] = [];
    const got = await host([a, b], {
      site: "a1a1a1a1a1a1a1a1", t0, minutes: 22,
      // a's agent answers once the service was restarted through it; b's own process stays broken.
      agent: (id, t) => (id === a && t >= aFixed ? { status: "ok" } : { status: "error", error: BAD_GATEWAY }),
      at: async (t) => {
        const w = (await view(b)).json.site_word;
        if (w && words[words.length - 1] !== w) words.push(w);
        if (aFixed === Number.POSITIVE_INFINITY && (await count("SELECT COUNT(*) AS n FROM worker_orders WHERE worker_id = ? AND kind = 'restart-agent'", a))) aFixed = t;
      },
    });
    expect(got[a]).toEqual(["recheck-agent", "restart-agent"]);
    expect(got[b]).toEqual(["recheck-agent", "restart"]);
    expect(words[0]).toBe(`its agent service is shared with ${a}; the pool restarts it once, through ${a}`);
    // Then the service answers a: b's own process is what the pool restarts — once the host's pacing lets it.
    const answers = `its agent service answers for ${a}: the pool restarts this worker's own process, not the service`;
    expect(words.slice(1).every((w) => w.startsWith(answers)), words.join(" | ")).toBe(true);
    expect(words.slice(1).some((w) => w.includes("the next 5 min after it"))).toBe(true);
  });

  it("with the emulated profile's four review workers: one restart of the service, through the lowest id; once its worker gives up, the others give up too, once, and read nothing more", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const ids = ["emu-review-aarch64", "emu-review-x86_64", "emu-review2-aarch64", "emu-review2-x86_64"];
    for (const [i, id] of ids.entries()) await seedWorker(id, "m1", "project", {}, i % 2 ? "x86_64" : "aarch64");
    const got = await host(ids, { site: "b2b2b2b2b2b2b2b2", t0, minutes: 75, agent: () => ({ status: "error", error: BAD_GATEWAY }) });
    // The elected worker's two restarts of the service (the second as the worker itself, the rules' own order), then its give-up; the others only their re-check.
    expect(got[ids[0]].filter((k) => k !== "recheck-agent")).toEqual(["restart-agent", "restart"]);
    for (const id of ids.slice(1)) expect(got[id], id).toEqual(["recheck-agent"]);
    for (const id of ids) expect((await rowOf(id)).auto_orders, id).toContain("gave_up\":\"");
    for (const id of ids.slice(1)) {
      expect(await count("SELECT COUNT(*) AS n FROM events WHERE substr(summary, 1, ?) = ? AND instr(summary, ?) > 0", `${id}: the pool stops restarting it — its agent service, shared with `.length, `${id}: the pool stops restarting it — its agent service, shared with `, `was restarted through ${ids[0]}, which did not bring it back`), id).toBe(1);
    }
    // A claim after it: the rules decide nothing, and read nothing of the site.
    const { env: on, ran } = counted();
    vi.setSystemTime(t0 + 80 * MIN);
    await claim(ids[2], { instance: 52, status: "error", error: BAD_GATEWAY, checked: "p-last", via: "sibling", site: "b2b2b2b2b2b2b2b2", agent: "mx-site/model-1" }, on);
    expect(ran.filter((x) => x.sql === SITE_WORKERS_SQL || x.sql === OPEN_SPELLS_SQL || /worker_orders/.test(x.sql))).toEqual([]);
  });

  it("a person's restart of the service waiting through one worker holds the rules' through another, without an issue that fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const SITE = "d3d3d3d3d3d3d3d3";
    const t0 = Date.now();
    const [a, b] = ["held-review-a", "held-review-b"];
    for (const id of [a, b]) await seedWorker(id, "m1", "project");
    vi.setSystemTime(t0);
    for (const [i, id] of [a, b].entries()) await claim(id, { instance: 60 + i, status: "error", error: BAD_GATEWAY, checked: "one", via: "sibling", site: SITE, agent: "mx-held/model-1" });
    // a is offline for the rules' purposes (never claims again); m1's restart of the service waits for it.
    expect((await issue(a, { kind: "restart-agent" }, cli("m1"))).status).toBe(201);
    await env.DB.prepare("UPDATE build_workers SET auto_orders = ? WHERE id = ?").bind(JSON.stringify({ spell: (await rowOf(b)).agent_error_since, rechecks: 1, restarts: 0, last_recheck: new Date(t0).toISOString(), last_restart: null, gave_up: null, day: [] }), b).run();
    const { env: on, ran } = counted();
    for (let s = 20; s <= 30; s++) {
      vi.setSystemTime(t0 + s * 30000);
      const r = await claim(b, { instance: 61, status: "error", error: BAD_GATEWAY, checked: "one", via: "sibling", site: SITE, agent: "mx-held/model-1" }, on);
      expect(r.status).toBe(204);
    }
    expect(ran.filter((x) => x.sql.startsWith("INSERT INTO worker_orders"))).toEqual([]);
    expect((await view(b)).json.site_word).toBe("a restart is open on this host already; one at a time");
  });
});

describe("the pool's own names, and the community's share of its budget", () => {
  it("a person whose login is \"pool\" is a person: their cap, their TTL, their name on the page — never the pool's budget", async () => {
    const id = "pool-person-box";
    // A contributor's registration from before #331 claims nothing (#343): the orders it takes are its row's, as a claim once wrote them.
    await seedWorker(id, "pool", "community", { order_kinds: '["drain","recheck-agent","restart"]' });
    const pools = () => count("SELECT COUNT(*) AS n FROM worker_orders WHERE issued_by IN (?, ?)", POOL_PROJECT, POOL_COMMUNITY);
    const before = await pools();
    const o = (await issue(id, { kind: "restart" }, cli("pool"))).json.order;
    const row = await orderOf(o.id);
    expect(row).toMatchObject({ issued_by: "pool" });
    expect(Date.parse(row.expires_at) - Date.parse(row.issued_at)).toBe(TTL_PERSON_MIN * MIN);
    await call("DELETE", `/factory/workers/${id}/orders/${o.id}`, undefined, cli("pool"));
    // The pool's orders are not theirs: none of their orders counts toward the pool's budget, and their own twenty is their cap.
    expect(await pools()).toBe(before);
    const at = new Date().toISOString();
    const rows = Array.from({ length: 19 }, (_, i) => `('wo_pp${String(i).padStart(30, "0")}', 'pool-seeded', 'recheck-agent', 'seeded', 'pool', '${at}', '${at}', 'done')`);
    await env.DB.prepare(`INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, issued_at, expires_at, state) VALUES ${rows.join(", ")}`).run();
    const cap = await issue(id, { kind: "restart" }, cli("pool"));
    expect(cap).toMatchObject({ status: 409, json: { error: expect.stringContaining("pool reached 20 orders in an hour") } });
    await env.DB.prepare("DELETE FROM worker_orders WHERE worker_id = 'pool-seeded'").run();
  });

  it("community registrations spend at most their share of the day and of the hour; the project's keep the rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A minute into the next hour: the run spans 42 minutes of it, and the once-per-hour and once-per-day lines it counts are keyed by
    // the hour and the day — started at the wall clock's minute, a run near the hour crossed into the next one and wrote a second line.
    vi.setSystemTime(Math.ceil(Date.now() / (60 * MIN)) * 60 * MIN + MIN);
    const t0 = Date.now();
    // The pool's orders of the tests before this one, out of every window: this test counts its own.
    const aside = () => env.DB.prepare("UPDATE worker_orders SET issued_at = '2000-01-01T00:00:00.000Z' WHERE issued_by IN (?, ?) AND worker_id != 'share-seeded'").bind(POOL_PROJECT, POOL_COMMUNITY).run();
    await aside();
    const iso = (m: number) => new Date(t0 - m * MIN).toISOString();
    // The community's forty of the day are spent (none of them restarts within the hour).
    const seed = (n: number, by: string, kind: string, ago: (i: number) => number) => env.DB.prepare(`INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, issued_at, expires_at, state) VALUES ${Array.from({ length: n }, (_, i) => `('wo_${by === POOL_COMMUNITY ? "c" : "p"}${kind[3]}${String(i).padStart(29, "0")}', 'share-seeded', '${kind}', 'seeded', '${by}', '${iso(ago(i))}', '${iso(0)}', 'done')`).join(", ")}`).run();
    await seed(MAX_POOL_COMMUNITY_ORDERS_PER_DAY, POOL_COMMUNITY, "recheck-agent", (i) => 120 + i);
    await seedWorker("share-contrib", "m2", "community");
    await seedWorker("share-project", "m1", "project");
    const kinds: Record<string, string[]> = { "share-contrib": [], "share-project": [] };
    for (let s = 0; s <= 24; s++) {
      for (const [i, id] of ["share-contrib", "share-project"].entries()) {
        vi.setSystemTime(t0 + s * 30000 + i * 1000);
        const r = await claim(id, { instance: 9, status: "error", error: REFUSED, checked: "one", agent: `mx-share-${i}/model-1` });
        for (const o of r.json?.orders ?? []) { kinds[id].push(o.kind); await answer(id, o.id, { instance: hex(9), outcome: o.kind === "recheck-agent" ? "done" : "accepted", code: o.kind === "recheck-agent" ? "probed" : "exiting" }); }
      }
    }
    expect(kinds["share-contrib"]).toEqual([]);
    expect(kinds["share-project"]).toEqual(["recheck-agent", "restart"]);
    expect(await linesStarting("the community's share of the pool's daily budget")).toBe(1);
    // The hour: six restarts of community registrations already; the next one's waits, the project's passes.
    await env.DB.prepare("DELETE FROM worker_orders WHERE worker_id = 'share-seeded'").run();
    await aside();
    await seed(MAX_POOL_COMMUNITY_RESTARTS_PER_HOUR, POOL_COMMUNITY, "restart", (i) => 10 + i);
    await seedWorker("share-contrib-2", "m2", "community");
    const t1 = t0 + 30 * MIN;
    const more: string[] = [];
    for (let s = 0; s <= 24; s++) {
      vi.setSystemTime(t1 + s * 30000);
      const r = await claim("share-contrib-2", { instance: 9, status: "error", error: REFUSED, checked: "one", agent: "mx-share-9/model-1" });
      for (const o of r.json?.orders ?? []) { more.push(o.kind); await answer("share-contrib-2", o.id, { instance: hex(9), outcome: "done", code: "probed" }); }
    }
    expect(more).toEqual(["recheck-agent"]);
    expect(await linesStarting("the pool gave community registrations 6 restart-type orders")).toBe(1);
    await env.DB.prepare("DELETE FROM worker_orders WHERE worker_id = 'share-seeded'").run();
  });
});

describe("a claim that names no process", () => {
  it("takes no order, and beside the real process it is the second one: one line, orders held, no write at every claim", async () => {
    const id = "no-instance";
    await seedWorker(id, "m1", "project");
    await claim(id, { instance: 1 });
    const o = (await issue(id, { kind: "recheck-agent" }, cli("m1"))).json.order;
    // Its orders field says it takes them; without an instance it declares nothing: nothing delivered, nothing bound to the real process.
    const thief = await claim(id, { instance: null });
    expect(thief.status).toBe(204);
    expect((await orderOf(o.id)).delivered_to).toBeNull();
    expect((await rowOf(id)).order_kinds).toBeNull();
    // The real one claims again: two processes on the token, said once.
    await claim(id, { instance: 1 });
    const r = await rowOf(id);
    expect(r.instance_conflict_at).not.toBeNull();
    expect(await linesStarting(`${id}: two processes share`)).toBe(1);
    // Alternating within a minute: nothing written.
    for (const i of [null, 1, null, 1]) expect((await claim(id, { instance: i })).status).toBe(204);
    expect((await rowOf(id)).last_seen).toBe(r.last_seen);
    // The public journal says it, and names no whole instance: a thief who read one could claim as the real process.
    const journal = (await call("GET", "/events?kind=worker&limit=50")).json;
    expect(journal.events.some((e: { summary: string }) => e.summary.startsWith(`${id}: two processes share`))).toBe(true);
    expect(JSON.stringify(journal)).not.toContain(hex(1));
  });
});

describe("what a liveness write costs", () => {
  it("a worker in a long spell writes its liveness row as a ready worker does: the breaker's index is not written", async () => {
    const written = async (id: string, said: Said) => {
      const { env: on, ran } = counted();
      await claim(id, said);
      await env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id = ?").bind(new Date(Date.now() - 4 * MIN).toISOString(), id).run();
      ran.length = 0;
      await claim(id, said, on);
      return ran.filter((x) => x.sql.startsWith("INSERT INTO build_workers")).map((x) => x.written);
    };
    await seedWorker("rw-credit", "m1", "project");
    await seedWorker("rw-ready", "m1", "project");
    const failing = await written("rw-credit", { instance: 1, status: "error", error: "HTTPError: HTTP Error 402: Payment Required", checked: "c1" });
    const ready = await written("rw-ready", { instance: 1, status: "ok", checked: "c1" });
    expect((await rowOf("rw-credit")).agent_error_since).not.toBeNull();
    expect(failing).toHaveLength(1);
    expect(failing).toEqual(ready);
  });
});

describe("the kill switch, and an orders path that throws", () => {
  it("WORKER_RULES=off: a worker whose agent does not answer gets nothing from the pool; a person's order still goes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = "rules-off";
    await seedWorker(id, "m1", "project");
    const off = { ...env, WORKER_RULES: "off" } as Env;
    const got = await run(id, { provider: "mx-off", from: Date.now(), minutes: 15, agent: () => ({ status: "error", error: REFUSED }), on: off });
    expect(got).toEqual([]);
    expect((await issue(id, { kind: "restart" }, cli("m1"))).status).toBe(201);
    expect((await claim(id, { instance: 1, status: "error", error: REFUSED, agent: "mx-off/model-1" }, off)).json.orders.map((o: any) => o.kind)).toEqual(["restart"]);
  });

  it("the breaker's key, the open spells or the site's workers throwing: the claim gets its 204, no order, and says why in the log", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    for (const [i, bad] of ["SELECT value FROM settings WHERE key = ?", OPEN_SPELLS_SQL, SITE_WORKERS_SQL].entries()) {
      const id = `throws-${i}`;
      await seedWorker(id, "m1", "project");
      // Twelve minutes of a refused agent: its re-check, then at its next claim the rules propose a restart and read.
      await run(id, { provider: `mx-throw-${i}`, from: t0, minutes: 9, agent: () => ({ status: "error", error: REFUSED }), site: "c0c0c0c0c0c0c0c0", via: "direct" });
      const broken = new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare") return (sql: string) => { if (sql === bad) throw new Error("boom"); return target.prepare(sql); };
          const v = Reflect.get(target, key);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const logs: unknown[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a) => { logs.push(a[0]); });
      vi.setSystemTime(t0 + 11 * MIN);
      const r = await claimWith({ ...env, DB: broken } as Env, id, { instance: 1, status: "error", error: REFUSED, checked: `${id}-2`, site: "c0c0c0c0c0c0c0c0", agent: `mx-throw-${i}/model-1` });
      spy.mockRestore();
      expect(r.status, bad).toBe(204);
      expect(logs, bad).toContain("orders:");
      expect(await count("SELECT COUNT(*) AS n FROM worker_orders WHERE worker_id = ? AND kind = 'restart'", id), bad).toBe(0);
    }
  });
});

describe("an outdated worker's 426", () => {
  it("carries the order waiting for it: a re-check needs no new image", async () => {
    const id = "outdated-one";
    await seedWorker(id, "m1", "project");
    const was = { version: env.POOL_VERSION, deployed: env.POOL_DEPLOYED_AT };
    Object.assign(env, { POOL_VERSION: "v0.0.177", POOL_DEPLOYED_AT: new Date(Date.now() - 60 * MIN).toISOString() });
    try {
      await claim(id, { instance: 1, version: "v0.0.177" });
      const o = (await issue(id, { kind: "recheck-agent" }, cli("m1"))).json.order;
      const r = await claim(id, { instance: 1, version: "v0.0.167" });
      expect(r.status).toBe(426);
      expect(r.json).toMatchObject({ latest: "v0.0.177", yours: "v0.0.167", orders: [{ id: o.id, kind: "recheck-agent" }] });
      expect((await orderOf(o.id))).toMatchObject({ state: "delivered", delivered_to: hex(1) });
      // Nothing waiting: the 426 as before, without orders.
      expect((await claim(id, { instance: 1, version: "v0.0.167" })).json.orders).toBeUndefined();
    } finally {
      Object.assign(env, { POOL_VERSION: was.version, POOL_DEPLOYED_AT: was.deployed });
    }
  });
});

describe("atomicity", () => {
  it("the worker's cap under concurrent issues of two restart kinds: one passes; a rule and a person at once: one restart; two claims deciding at once: one order, one write of the rules' state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const id = "atomic-one";
    await seedWorker(id, "m1", "project");
    await claim(id, { instance: 1, via: "sibling", site: "e0e0e0e0e0e0e0e0" });
    // Five of the hour's six restart-type orders given and taken back.
    for (let i = 0; i < 5; i++) {
      const r = await issue(id, { kind: "restart" }, cli(i % 2 ? "m1" : "m2"));
      expect(r.status).toBe(201);
      await call("DELETE", `/factory/workers/${id}/orders/${r.json.order.id}`, undefined, cli("m1"));
    }
    const both = await Promise.all([issue(id, { kind: "restart" }, cli("m1")), issue(id, { kind: "restart-agent" }, cli("m2"))]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await count("SELECT COUNT(*) AS n FROM worker_orders WHERE worker_id = ? AND kind IN ('restart', 'restart-agent')", id)).toBe(6);

    // A rule and a person at once: the claim that would issue the pool's restart, and m1's restart.
    const two = "atomic-two";
    await seedWorker(two, "m1", "project");
    vi.setSystemTime(t0);
    await claim(two, { instance: 2, status: "error", error: REFUSED, checked: "a", agent: "mx-atomic/model-1" });
    await env.DB.prepare("UPDATE build_workers SET instance_since = ?, auto_orders = ? WHERE id = ?").bind(new Date(t0 - 30 * MIN).toISOString(), JSON.stringify({ spell: (await rowOf(two)).agent_error_since, rechecks: 1, restarts: 0, last_recheck: new Date(t0).toISOString(), last_restart: null, gave_up: null, day: [] }), two).run();
    vi.setSystemTime(t0 + 11 * MIN);
    await Promise.all([claim(two, { instance: 2, status: "error", error: REFUSED, checked: "a", agent: "mx-atomic/model-1" }), issue(two, { kind: "restart" }, cli("m1"))]);
    expect(await count("SELECT COUNT(*) AS n FROM worker_orders WHERE worker_id = ? AND kind = 'restart'", two)).toBe(1);

    // Two claims deciding at once: one re-check, and the rules' state written once.
    const three = "atomic-three";
    await seedWorker(three, "m1", "project");
    vi.setSystemTime(t0);
    await claim(three, { instance: 3, status: "error", error: REFUSED, checked: "b", agent: "mx-atomic3/model-1" });
    vi.setSystemTime(t0 + 6 * MIN);
    const { env: on, ran } = counted();
    await Promise.all([claim(three, { instance: 3, status: "error", error: REFUSED, checked: "b", agent: "mx-atomic3/model-1" }, on), claim(three, { instance: 3, status: "error", error: REFUSED, checked: "b", agent: "mx-atomic3/model-1" }, on)]);
    expect(await count("SELECT COUNT(*) AS n FROM worker_orders WHERE worker_id = ? AND kind = 'recheck-agent'", three)).toBe(1);
    expect(ran.filter((x) => x.sql.startsWith("UPDATE build_workers SET auto_orders")).reduce((n, x) => n + (x.written ? 1 : 0), 0)).toBe(1);
    expect(JSON.parse((await rowOf(three)).auto_orders).rechecks).toBe(1);
  });
});
