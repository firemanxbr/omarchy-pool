/**
 * The minimal host state and its two host orders (#344, epic #307, design v2
 * §11.1 M4, M5, §13.4, §17.1, §21.1 step 6), through the Worker with real
 * Ed25519 host keys and real passkeys (the software authenticator):
 *
 * - GET /hosts/self/state, signed: the release target (the pool's release,
 *   none from a Worker that runs none), the registration's open Updates, and
 *   the host's open orders with their id and not_after — never one past it,
 *   never another host's; a suspended host refused.
 * - POST /hosts/:id/orders: reconcile-now by its owner or any maintainer,
 *   retire-legacy by its owner only, with a passkey, while its agent reports
 *   a legacy set; an unknown kind, a token, another origin, a contributor,
 *   nobody, a host that is not active, an agent before 0.3.0 and a second
 *   open order of a kind refused; issue on the journal; GET /hosts/:id
 *   carrying the same verdicts, the last orders and the legacy set.
 * - The report's answers close the host's open orders it names — once, and
 *   none of another host's — with a journal line in the pool's words; the
 *   cron and the door expire what its agent did not take; a suspension and a
 *   retirement cancel what is open.
 * - The contract with the agent, written once (crates/omarchy-agent/tests/
 *   fixtures/host-api, which the agent's own tests read too): the state's
 *   keys and value types are the fixture's, and the agent's reports — a
 *   legacy set it would refuse to retire, then a done retire-legacy and a
 *   refused order — close the orders and read back field by field; an answer
 *   that arrives after the pool expired its order still closes it.
 * - Every new statement through an index.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { toB64url } from "../src/webauthn";
import { agentTakesOrders, enrollMessage, legacyOf, orderAnswers, signedMessage, HOST_ORDER_TTL_MIN } from "../src/hosts";
import { ANSWER_HOST_ORDER_SQL, EXPIRE_ALL_HOST_ORDERS_SQL, EXPIRE_HOST_ORDERS_SQL, HOST_OPEN_ORDERS_SQL, HOST_ORDERS_SQL, hostVerdicts, pruneHosts } from "../src/routes/hosts";
import { SUBJECT } from "../src/routes/passkeys";
import { assert as answer, createAuthenticator, register } from "./soft-authenticator.mjs";
import stateFixture from "../../crates/omarchy-agent/tests/fixtures/host-api/state.json?raw";
import reportFixture from "../../crates/omarchy-agent/tests/fixtures/host-api/report.json?raw";
import blockedFixture from "../../crates/omarchy-agent/tests/fixtures/host-api/report-blocked.json?raw";

/** localhost: where a passkey works (relyingParty), as wrangler dev's. */
const ORIGIN = "http://localhost:8787";
const STUDIO = { cpus: 12, mem_gb: 32, disk_free_gb: { work: 410, engine: 220 }, units: 11, agent_slots: 2, lanes: [{ arch: "aarch64", mode: "native" }] };
/** A Worker deployed from a release: the target it names. */
const RELEASED = { ...env, POOL_VERSION: "v1.21.0" } as typeof env;

interface Res { status: number; json: any }
async function call(method: string, path: string, opts: { session?: string; token?: string; body?: unknown; raw?: string; headers?: Record<string, string>; on?: typeof env } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.session) { headers.cookie = `omc=oms_${opts.session}`; headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  Object.assign(headers, opts.headers ?? {});
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path.startsWith("/auth/") ? "" : "/api/v1"}${path}`, { method, headers, body }), opts.on ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

interface Key { pub: string; priv: CryptoKey }
async function newKey(): Promise<Key> {
  const k = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { pub: toB64url(new Uint8Array((await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer)), priv: k.privateKey };
}
const sign = async (k: Key, msg: string) => toB64url(await crypto.subtle.sign({ name: "Ed25519" }, k.priv, new TextEncoder().encode(msg)));
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
/** A signed call of host `host` (its agent's), with `body` for a POST. */
async function signed(k: Key, host: string, method: string, path: string, body = "", on?: typeof env): Promise<Res> {
  const ts = Math.floor(Date.now() / 1000), nonce = hex(16);
  const sig = await sign(k, signedMessage(host, method, `/api/v1${path}`, await sha(body), ts, nonce));
  return call(method, path, { raw: method === "GET" ? undefined : body, headers: { "omarchy-host": `${host}; ts=${ts}; nonce=${nonce}; sig=${sig}` }, on });
}
const state = (k: Key, host: string, on?: typeof env) => signed(k, host, "GET", "/hosts/self/state", "", on);
const report = (k: Key, host: string, r: unknown) => signed(k, host, "POST", "/hosts/self/report", JSON.stringify(r));

/** One maintainer host from nothing to active, enrolled by an agent of `agent`. */
async function activeHost(owner: string, name: string, agent = "0.3.0"): Promise<{ k: Key; host: string; worker: string }> {
  const k = await newKey();
  const m = await call("POST", "/hosts/enrollments", { session: owner, body: { name } });
  expect(m.status, JSON.stringify(m.json)).toBe(201);
  const e = await call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(k, enrollMessage(m.json.token, k.pub)), hostname: "box-1", os: "linux", arch: "aarch64", page_kb: 16, isolation: "root", dedicated: true, agent_version: agent, capacity: STUDIO } });
  expect(e.status, JSON.stringify(e.json)).toBe(201);
  const c = await call("POST", `/hosts/${e.json.host}/confirm`, { session: owner, body: {} });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { k, host: e.json.host, worker: c.json.worker };
}
/** The legacy set as the agent reports it beside its bundle (the Studio's). */
const LEGACY = { project: "omarchy-pool", state: "running", since: "2027-01-01T08:00:00Z", containers: 7, running: 7, dir: "/srv/omarchy-pool", blocked: null };
/** A host whose agent (0.3.0) reports a legacy set. */
async function withLegacy(owner: string, name: string): Promise<{ k: Key; host: string; worker: string }> {
  const h = await activeHost(owner, name);
  const r = await report(h.k, h.host, { agent: { version: "0.3.0" }, release: { applied: "v1.20.0" }, legacy: LEGACY, orders: [] });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return h;
}
const order = (as: string, host: string, body: Record<string, unknown>) => call("POST", `/hosts/${host}/orders`, { session: as, body });
const orderRow = (id: string) => env.DB.prepare("SELECT * FROM host_orders WHERE id = ?").bind(id).first<any>();
const lines = (action: string) => env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'host' AND json_extract(payload, '$.action') = ? ORDER BY id").bind(action).all<{ status: string; summary: string; payload: string }>().then((r) => r.results.map((l) => ({ ...l, payload: JSON.parse(l.payload) })));

const keys: Record<string, Awaited<ReturnType<typeof createAuthenticator>>> = {};
async function registerFor(login: string): Promise<void> {
  const a = await createAuthenticator();
  const o = await call("POST", "/auth/passkeys/challenge", { session: login, body: {} });
  const reg = await call("POST", "/auth/passkeys", { session: login, body: { label: "laptop", ...(await register(a, { challenge: o.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost" })) } });
  expect(reg.status, JSON.stringify(reg.json)).toBe(201);
  keys[login] = a;
}
async function assertion(login: string, subject: string): Promise<Record<string, string>> {
  const c = await call("POST", "/auth/passkeys/assert", { session: login, body: { for: subject } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return answer(keys[login], { challenge: c.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost" });
}

beforeAll(async () => {
  const people: [string, string, number | null][] = [["m1", "maintainer", 1001], ["m2", "maintainer", 1002], ["alice", "contributor", 2001]];
  await env.DB.batch(await Promise.all(people.map(async ([l, role, g]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES (?, ?, ?, ?, ?)").bind(l, await sha256Hex(`omc_${l}`), await sha256Hex(`oms_${l}`), role, g))));
  await applyGovernance(env, ["m1", "m2"], "sha-orders");
  for (const m of ["m1", "m2"]) await registerFor(m);
});

describe("the D1 migration (0046)", () => {
  it("adds host_orders: a closed set of kinds and states, one open order per kind and host", async () => {
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('host_orders')").all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toEqual(["id", "host_id", "kind", "issued_by", "via", "confirmed_with", "issued_at", "not_after", "state", "answered_at", "detail"]);
    const put = (id: string, kind: string, st = "open") => env.DB.prepare("INSERT INTO host_orders (id, host_id, kind, issued_by, not_after, state) VALUES (?, 'h_mig0000001', ?, 'm1', '2030-01-01T00:00:00.000Z', ?)").bind(id, kind, st).run();
    await put("ho_m1", "reconcile-now");
    await expect(put("ho_m2", "reconcile-now")).rejects.toThrow(/UNIQUE/);
    await put("ho_m3", "reconcile-now", "done");
    await put("ho_m4", "retire-legacy");
    await expect(put("ho_m5", "shell")).rejects.toThrow(/CHECK/);
    await expect(put("ho_m6", "set-units", "delivered")).rejects.toThrow(/CHECK/);
    await env.DB.prepare("DELETE FROM host_orders WHERE host_id = 'h_mig0000001'").run();
  });
});

describe("the host state (GET /hosts/self/state)", () => {
  it("names the pool's release, the registration's open Updates and the host's open orders, each with an id and a not_after", async () => {
    const { k, host, worker } = await activeHost("m1", "state");
    // A Worker that runs no release names none; a released one names its own.
    let s = await state(k, host);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json).toMatchObject({ host, status: "active", worker, poll_s: 120, release: { target: null }, updates: [], orders: [] });
    s = await state(k, host, RELEASED);
    expect(s.json.release.target).toBe("v1.21.0");

    // An Update on its registration (it reports a release behind the pool's).
    await report(k, host, { agent: { version: "0.3.0" }, release: { applied: "v1.20.0" } });
    const ctx = createExecutionContext();
    const u = await worker_fetch(RELEASED, `/factory/workers/${worker}/orders`, { kind: "update", reason: "a release" }, ctx);
    expect(u.status, JSON.stringify(u.json)).toBe(201);
    s = await state(k, host, RELEASED);
    expect(s.json.updates).toEqual([u.json.order.id]);

    // A host order.
    const o = await order("m1", host, { kind: "reconcile-now" });
    expect(o.status, JSON.stringify(o.json)).toBe(201);
    expect(o.json.order.id).toMatch(/^ho_[0-9a-f]{32}$/);
    s = await state(k, host);
    expect(s.json.orders).toEqual([{ id: o.json.order.id, kind: "reconcile-now", not_after: o.json.order.not_after }]);
    const left = Date.parse(o.json.order.not_after) - Date.now();
    expect(left).toBeGreaterThan((HOST_ORDER_TTL_MIN - 1) * 60000);
    expect(left).toBeLessThanOrEqual(HOST_ORDER_TTL_MIN * 60000);

    // Never one past its not_after, never another host's.
    const other = await activeHost("m2", "state-b");
    expect((await state(other.k, other.host)).json.orders).toEqual([]);
    await env.DB.prepare("UPDATE host_orders SET not_after = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), o.json.order.id).run();
    expect((await state(k, host)).json.orders).toEqual([]);
  });

  it("is refused to a suspended host, whose open orders the suspension cancelled", async () => {
    const { k, host } = await activeHost("m1", "susp");
    const o = await order("m1", host, { kind: "reconcile-now" });
    expect(o.status).toBe(201);
    const s = await call("POST", `/hosts/${host}/suspend`, { session: "m2", body: { reason: "a test of the cancel" } });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(await state(k, host)).toMatchObject({ status: 403, json: { code: "host_status", status: "suspended" } });
    expect(await orderRow(o.json.order.id)).toMatchObject({ state: "cancelled", detail: "its host was suspended by m2" });
  });
});

/** A session's POST with another env (a Worker that runs a release). */
async function worker_fetch(on: typeof env, path: string, body: unknown, ctx: ExecutionContext): Promise<Res> {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method: "POST", headers: { cookie: "omc=oms_m1", origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) }), on, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe("who gives a host order (POST /hosts/:id/orders)", () => {
  it("reconcile-now: its owner or any maintainer, from the page, one open at a time, on the journal", async () => {
    const { k, host } = await activeHost("m1", "reconcile");
    expect((await call("POST", `/hosts/${host}/orders`, { body: { kind: "reconcile-now" } })).status).toBe(401);
    expect(await order("alice", host, { kind: "reconcile-now" })).toMatchObject({ status: 403, json: { code: "host_right" } });
    expect(await call("POST", `/hosts/${host}/orders`, { token: "omc_m1", body: { kind: "reconcile-now" } })).toMatchObject({ status: 403, json: { code: "web_only" } });
    expect(await call("POST", `/hosts/${host}/orders`, { session: "m1", body: { kind: "reconcile-now" }, headers: { origin: "https://elsewhere.example" } })).toMatchObject({ status: 403, json: { code: "origin" } });
    for (const kind of ["shell", "set-units", "rotate-token", undefined]) expect(await order("m1", host, { kind })).toMatchObject({ status: 400, json: { code: "kind" } });
    // Another maintainer may: a round is "do the same thing now".
    const o = await order("m2", host, { kind: "reconcile-now" });
    expect(o.status, JSON.stringify(o.json)).toBe(201);
    expect(o.json.line).toBe("reconcile of m1: m2 ordered a round now");
    expect(await order("m1", host, { kind: "reconcile-now" })).toMatchObject({ status: 409, json: { code: "order_open" } });
    expect(await orderRow(o.json.order.id)).toMatchObject({ host_id: host, kind: "reconcile-now", issued_by: "m2", via: "web", state: "open", confirmed_with: null });
    const issued = (await lines("order")).find((l) => l.payload.order === o.json.order.id)!;
    expect(issued).toMatchObject({ status: "ok", summary: "reconcile of m1: m2 ordered a round now", payload: { host, by: "m2", kind: "reconcile-now" } });
    // Once answered, the next one may be given.
    await report(k, host, { agent: { version: "0.3.0" }, orders: [{ id: o.json.order.id, outcome: "done", detail: "a round now: host order (render)" }] });
    expect((await order("m1", host, { kind: "reconcile-now" })).status).toBe(201);
  });

  it("is refused for a host that is not active, and for an agent before 0.3.0, with why", async () => {
    const old = await activeHost("m1", "old-agent", "0.2.0");
    const r = await order("m1", old.host, { kind: "reconcile-now" });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("its agent (0.2.0) takes no host order: agent 0.3.0 or later does, and a release brings it by itself; Update on its registration's page reconciles it meanwhile");
    // Its agent updated itself: the report says so, and the order is taken.
    await report(old.k, old.host, { agent: { version: "0.3.0" } });
    expect((await order("m1", old.host, { kind: "reconcile-now" })).status).toBe(201);
    // Waiting for its owner's Confirm.
    const k = await newKey();
    const m = await call("POST", "/hosts/enrollments", { session: "m1", body: { name: "waiting" } });
    const e = await call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(k, enrollMessage(m.json.token, k.pub)), hostname: "w", os: "linux", arch: "aarch64", page_kb: 4, isolation: "root", agent_version: "0.3.0", capacity: STUDIO } });
    expect(await order("m1", e.json.host, { kind: "reconcile-now" })).toMatchObject({ status: 409, json: { error: "waiting waits for its owner's Confirm: it runs nothing yet" } });
    expect((await call("POST", "/hosts/h_nobody0000/orders", { session: "m1", body: { kind: "reconcile-now" } })).status).toBe(404);
  });

  it("retire-legacy: its owner only, with a passkey, while its agent reports a legacy set", async () => {
    const { host } = await withLegacy("m1", "studio");
    // What the page reads, for each of them.
    const page = (as?: string) => call("GET", `/hosts/${host}`, { session: as });
    const mine = await page("m1");
    expect(mine.json.can).toMatchObject({ reconcile: true, retire_legacy: true });
    expect(mine.json.passkey.retire_legacy).toBe(true);
    expect(mine.json.host.legacy).toEqual({ ...LEGACY, order: null });
    expect(mine.json.orders).toEqual([]);
    const theirs = await page("m2");
    expect(theirs.json.can.retire_legacy).toBe(false);
    expect(theirs.json.can.why.retire_legacy).toBe("only m1 retires the legacy set of studio, with their passkey");
    const stranger = await page("alice");
    expect(stranger.json.host.legacy).toBeUndefined();
    expect(stranger.json.orders).toBeUndefined();
    expect(stranger.json.can.why.reconcile).toBe("only m1 or a maintainer orders studio a round");
    expect((await page()).json.can.why.retire_legacy).toBeTruthy();

    // Another maintainer, even with a passkey; a token; the owner without one.
    expect(await order("m2", host, { kind: "retire-legacy", assertion: await assertion("m2", `host:retire-legacy:${host}`) })).toMatchObject({ status: 403, json: { code: "host_right" } });
    expect(await call("POST", `/hosts/${host}/orders`, { token: "omc_m1", body: { kind: "retire-legacy" } })).toMatchObject({ status: 403, json: { code: "web_only" } });
    const bare = await order("m1", host, { kind: "retire-legacy" });
    expect(bare.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM host_orders WHERE host_id = ?").bind(host).first<{ n: number }>()).toEqual({ n: 0 });
    // A passkey for another act does not do.
    expect((await order("m1", host, { kind: "retire-legacy", assertion: await assertion("m1", `host:retire:${host}`) })).status).toBe(403);
    // The owner's, with their passkey.
    const o = await order("m1", host, { kind: "retire-legacy", assertion: await assertion("m1", `host:retire-legacy:${host}`) });
    expect(o.status, JSON.stringify(o.json)).toBe(201);
    expect(o.json.order.confirmed_with).toMatch(/^pk_/);
    expect(o.json.line).toMatch(/^studio of m1: m1(?: with a passkey registered just now)? ordered its legacy set omarchy-pool retired — its agent stops and removes it and leaves its marker$/);
    expect(await orderRow(o.json.order.id)).toMatchObject({ kind: "retire-legacy", issued_by: "m1", confirmed_with: o.json.order.confirmed_with, state: "open" });
    const issued = (await lines("order")).find((l) => l.payload.order === o.json.order.id)!;
    expect(issued).toMatchObject({ status: "warn", payload: { kind: "retire-legacy", confirmed_with: o.json.order.confirmed_with } });
    expect((await order("m1", host, { kind: "retire-legacy", assertion: await assertion("m1", `host:retire-legacy:${host}`) })).json.code).toBe("order_open");
  });

  it("retire-legacy is refused, with why, for a host that reports no legacy set or one retired or being retired", async () => {
    const { k, host } = await activeHost("m1", "nolegacy");
    const why = async () => (await call("GET", `/hosts/${host}`, { session: "m1" })).json.can.why.retire_legacy;
    expect(await why()).toBe("nolegacy reports no legacy set: an install with --legacy records one");
    expect((await order("m1", host, { kind: "retire-legacy", assertion: await assertion("m1", `host:retire-legacy:${host}`) })).status).toBe(409);
    await report(k, host, { agent: { version: "0.3.0" }, legacy: { ...LEGACY, state: "retiring", order: `ho_${"a".repeat(32)}` } });
    expect(await why()).toBe(`nolegacy's legacy set omarchy-pool is being retired (ho_${"a".repeat(32)})`);
    await report(k, host, { agent: { version: "0.3.0" }, legacy: { ...LEGACY, state: "retired", since: "2027-02-01T08:00:00Z" } });
    expect(await why()).toBe("nolegacy's legacy set omarchy-pool was retired already (2027-02-01T08:00:00Z)");
  });

  it("the passkey's subject names the host", () => {
    expect(SUBJECT.test("host:retire-legacy:h_0123456789")).toBe(true);
    for (const no of ["host:retire-legacy:x", "host:retire-legacy:", "host:reconcile-now:h_0123456789"]) expect(SUBJECT.test(no), no).toBe(false);
  });
});

describe("the agent's answers (POST /hosts/self/report, `orders`)", () => {
  it("close the host's open orders they name, once, with a line in the pool's words", async () => {
    const { k, host } = await withLegacy("m1", "answers");
    const o = await order("m1", host, { kind: "retire-legacy", assertion: await assertion("m1", `host:retire-legacy:${host}`) });
    expect(o.status).toBe(201);
    const id = o.json.order.id;
    // Another host cannot close it, nor can an answer that is not one.
    const other = await activeHost("m2", "answers-b");
    expect((await report(other.k, other.host, { orders: [{ id, outcome: "done", detail: "x" }] })).json.orders_closed).toBe(0);
    expect((await report(k, host, { orders: [{ id, outcome: "maybe" }, { id: "ho_short", outcome: "done" }, "ho_x", null] })).json.orders_closed).toBe(0);
    expect((await orderRow(id)).state).toBe("open");
    // Its own agent's answer, and the legacy set it reports retired.
    const detail = "stopped and removed 7 container(s) and 1 network(s) of compose project omarchy-pool; the marker is in /srv/omarchy-pool/.omarchy-agent: rollout.sh, setup.sh, omarchy-worker and the updater refuse there";
    const r = await report(k, host, { agent: { version: "0.3.0" }, legacy: { project: "omarchy-pool", state: "retired", since: "2027-02-01T08:00:00Z", dir: "/srv/omarchy-pool", order: id }, orders: [{ id, kind: "retire-legacy", outcome: "done", detail, at: "2027-02-01T08:00:00Z" }] });
    expect(r.json.orders_closed).toBe(1);
    expect(await orderRow(id)).toMatchObject({ state: "done", detail });
    const answered = (await lines("order-answer")).filter((l) => l.payload.order === id);
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ status: "ok", summary: `answers of m1: its agent answered the host order retire-legacy done (${id})`, payload: { host, kind: "retire-legacy", outcome: "done", by: "m1" } });
    // The agent's words stay off the public line.
    expect(answered[0].summary).not.toContain("/srv/omarchy-pool");
    // Every later report carries it again: it closes nothing more.
    const retired = { project: "omarchy-pool", state: "retired", since: "2027-02-01T08:00:00Z", dir: "/srv/omarchy-pool", order: id };
    expect((await report(k, host, { legacy: retired, orders: [{ id, outcome: "done", detail }] })).json.orders_closed).toBe(0);
    expect(await lines("order-answer").then((l) => l.filter((x) => x.payload.order === id))).toHaveLength(1);
    // The page shows the answer and the set retired; no second retire-legacy.
    const page = (await call("GET", `/hosts/${host}`, { session: "m1" })).json;
    expect(page.orders[0]).toMatchObject({ id, kind: "retire-legacy", issued_by: "m1", state: "done", detail });
    expect(page.host.legacy).toMatchObject({ state: "retired", order: id });
    expect(page.can.retire_legacy).toBe(false);
  });

  it("a refusal and a failure close the order with what the agent said", async () => {
    const { k, host } = await activeHost("m1", "refusals");
    const a = await order("m1", host, { kind: "reconcile-now" });
    await report(k, host, { orders: [{ id: a.json.order.id, outcome: "refused", detail: "expired at 2027-01-15T09:00:00Z" }] });
    expect(await orderRow(a.json.order.id)).toMatchObject({ state: "refused", detail: "expired at 2027-01-15T09:00:00Z" });
    expect((await lines("order-answer")).find((l) => l.payload.order === a.json.order.id)!.status).toBe("warn");
  });
});

/** A JSON value's shape: its keys and each value's type, an array by its first item — the same as the agent's orders_tests. */
function shape(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shape(x)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return typeof v;
}

describe("the contract with the agent (crates/omarchy-agent/tests/fixtures/host-api)", () => {
  it("the host state answers with the fixture's keys and value types, which the agent's parse_state reads", async () => {
    const { k, host, worker } = await activeHost("m1", "contract-state");
    const deployed = { ...RELEASED, POOL_DEPLOYED_AT: "2027-01-15T08:00:00Z" } as typeof env;
    // An open Update on its registration and an open order of each kind, as in the fixture.
    await report(k, host, { agent: { version: "0.3.0" }, release: { applied: "v1.20.0" } });
    const u = await worker_fetch(deployed, `/factory/workers/${worker}/orders`, { kind: "update", reason: "a release" }, createExecutionContext());
    expect(u.status, JSON.stringify(u.json)).toBe(201);
    const later = new Date(Date.now() + 3600_000).toISOString();
    for (const [i, kind] of ["retire-legacy", "reconcile-now"].entries()) {
      await env.DB.prepare("INSERT INTO host_orders (id, host_id, kind, issued_by, issued_at, not_after) VALUES (?, ?, ?, 'm1', ?, ?)")
        .bind(`ho_${hex(16)}`, host, kind, new Date(Date.now() - 2000 + i * 1000).toISOString(), later).run();
    }
    const s = await state(k, host, deployed);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const fixture = JSON.parse(stateFixture);
    expect(shape(s.json)).toEqual(shape(fixture));
    // What the agent reads of it, by name.
    expect(s.json.release.target).toBe("v1.21.0");
    expect(s.json.updates).toEqual([u.json.order.id]);
    expect(s.json.orders.map((o: { kind: string }) => o.kind)).toEqual(["retire-legacy", "reconcile-now"]);
  });

  it("the agent's reports close its orders with its outcome and words, and its legacy set reads back field by field", async () => {
    const { k, host } = await activeHost("m1", "contract-report");
    const name = "contract-report";
    // A legacy set it would refuse to retire: the page shows why and greys the button; the door refuses with the same words.
    const blocked = JSON.parse(blockedFixture);
    expect((await signed(k, host, "POST", "/hosts/self/report", blockedFixture)).status).toBe(200);
    let page = (await call("GET", `/hosts/${host}`, { session: "m1" })).json;
    expect(page.host.legacy).toEqual({ ...blocked.legacy, order: null });
    const why = `${name}'s agent would refuse it: ${blocked.legacy.blocked}`;
    expect(page.can.retire_legacy).toBe(false);
    expect(page.can.why.retire_legacy).toBe(why);
    expect(await order("m1", host, { kind: "retire-legacy", assertion: await assertion("m1", `host:retire-legacy:${host}`) })).toMatchObject({ status: 409, json: { error: why } });
    expect(page.can.reconcile).toBe(true);

    // The two orders the fixture answers, open on this host.
    const after = JSON.parse(reportFixture);
    const later = new Date(Date.now() + 3600_000).toISOString();
    for (const a of after.orders as { id: string; kind: string }[]) {
      await env.DB.prepare("INSERT INTO host_orders (id, host_id, kind, issued_by, not_after) VALUES (?, ?, ?, 'm1', ?)").bind(a.id, host, a.kind, later).run();
    }
    const r = await signed(k, host, "POST", "/hosts/self/report", reportFixture);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.orders_closed).toBe(2);
    for (const a of after.orders as { id: string; outcome: string; detail: string }[]) {
      expect(await orderRow(a.id)).toMatchObject({ state: a.outcome, detail: a.detail });
    }
    page = (await call("GET", `/hosts/${host}`, { session: "m1" })).json;
    expect(page.host.legacy).toEqual({ containers: null, running: null, blocked: null, ...after.legacy });
    expect(page.can.why.retire_legacy).toBe(`${name}'s legacy set omarchy-pool was retired already (${after.legacy.since})`);
  });

  it("an answer that arrives after the pool expired its order still closes it with what the agent did", async () => {
    const { k, host } = await withLegacy("m1", "late");
    const o = await order("m1", host, { kind: "retire-legacy", assertion: await assertion("m1", `host:retire-legacy:${host}`) });
    expect(o.status).toBe(201);
    const id = o.json.order.id;
    // Taken late in its hour; the cron expires it while the agent stops and removes the set.
    await env.DB.prepare("UPDATE host_orders SET not_after = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), id).run();
    await pruneHosts(env);
    expect((await orderRow(id)).state).toBe("expired");
    const detail = "stopped and removed 7 container(s) and 1 network(s) of compose project omarchy-pool";
    const r = await report(k, host, { agent: { version: "0.3.0" }, legacy: { ...LEGACY, state: "retired", order: id }, orders: [{ id, outcome: "done", detail }] });
    expect(r.json.orders_closed).toBe(1);
    expect(await orderRow(id)).toMatchObject({ state: "done", detail });
    expect((await lines("order-answer")).filter((l) => l.payload.order === id)).toHaveLength(1);
    // Carried again, it closes nothing more; an order cancelled by a suspension is never reopened by an answer.
    expect((await report(k, host, { orders: [{ id, outcome: "done", detail }] })).json.orders_closed).toBe(0);
    const c = await order("m1", host, { kind: "reconcile-now" });
    await env.DB.prepare("UPDATE host_orders SET state = 'cancelled' WHERE id = ?").bind(c.json.order.id).run();
    expect((await report(k, host, { orders: [{ id: c.json.order.id, outcome: "done", detail: "x" }] })).json.orders_closed).toBe(0);
    expect((await orderRow(c.json.order.id)).state).toBe("cancelled");
  });
});

describe("orders its agent does not take", () => {
  it("expire past their not_after: by the cron, and by the door before a new one", async () => {
    const { host } = await activeHost("m1", "expiry");
    const a = await order("m1", host, { kind: "reconcile-now" });
    const past = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare("UPDATE host_orders SET not_after = ? WHERE id = ?").bind(past, a.json.order.id).run();
    // The door: the stale one goes, the new one is given.
    const b = await order("m1", host, { kind: "reconcile-now" });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    expect(await orderRow(a.json.order.id)).toMatchObject({ state: "expired", detail: "not taken by its agent before its not_after" });
    // The cron.
    await env.DB.prepare("UPDATE host_orders SET not_after = ? WHERE id = ?").bind(past, b.json.order.id).run();
    expect(await pruneHosts(env)).toBeGreaterThanOrEqual(1);
    expect((await orderRow(b.json.order.id)).state).toBe("expired");
  });

  it("are cancelled when the host is retired", async () => {
    const { host } = await activeHost("m1", "retiring");
    const a = await order("m1", host, { kind: "reconcile-now" });
    expect((await call("POST", `/hosts/${host}/retire`, { session: "m1", body: { reason: "the machine is gone" } })).status).toBe(200);
    expect(await orderRow(a.json.order.id)).toMatchObject({ state: "cancelled", detail: "its host was retired by m1" });
  });
});

describe("the pure rules", () => {
  it("an agent takes host orders from 0.3.0 on; the legacy set and the answers are read field by field", () => {
    for (const [v, ok] of [["0.3.0", true], ["0.3.1", true], ["1.0.0", true], ["0.2.9", false], ["0.2.0", false], [null, false], ["v0.3.0", false], ["0.10.0", true]] as const) expect(agentTakesOrders(v), String(v)).toBe(ok);
    expect(legacyOf(null)).toBeNull();
    expect(legacyOf("{")).toBeNull();
    expect(legacyOf(JSON.stringify({ legacy: { project: "Bad Name" } }))).toBeNull();
    expect(legacyOf(JSON.stringify({ legacy: { project: "omarchy-pool", state: "exploded", containers: -1, dir: "a\nb", order: "x" } }))).toEqual({ project: "omarchy-pool", state: "unknown", since: null, containers: null, running: null, dir: null, blocked: null, order: null });
    const id = `ho_${"b".repeat(32)}`;
    expect(orderAnswers([{ id, outcome: "done", detail: `a\u001b[2Kb ${"x".repeat(600)}` }, { id, outcome: "ok" }, { id: "wo_1", outcome: "done" }])).toEqual([{ id, outcome: "done", detail: `a [2Kb ${"x".repeat(493)}` }]);
    expect(orderAnswers({ id })).toEqual([]);
    expect(orderAnswers(Array.from({ length: 20 }, () => ({ id, outcome: "done" })))).toHaveLength(16);
    const h = { name: "x", status: "active", owner_login: "m1", owner_github_id: 1, agent_version: "0.3.0", report: JSON.stringify({ legacy: LEGACY }) };
    expect(hostVerdicts({ login: "m1", maintainer: true, github_id: 1 }, h).retire_legacy.ok).toBe(true);
    expect(hostVerdicts({ login: "m1", maintainer: false, github_id: 1 }, h).retire_legacy).toMatchObject({ ok: false, status: 403 });
    expect(hostVerdicts({ login: "m1-renamed", maintainer: true, github_id: 1 }, h).retire_legacy.ok).toBe(true);
    expect(hostVerdicts(null, h).reconcile).toMatchObject({ ok: false, status: 401 });
  });

  it("every new statement goes through an index", async () => {
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const now = new Date().toISOString();
    // A host's open orders, in the order they were given: through (host_id, issued_at), no sort.
    expect(await plan(HOST_OPEN_ORDERS_SQL, ["h_0123456789", now])).toMatch(/USING INDEX (idx_host_orders_host|uq_host_orders_open_kind) \(host_id=\?\)/);
    expect(await plan(HOST_ORDERS_SQL, ["h_0123456789"])).toMatch(/USING INDEX idx_host_orders_host \(host_id=\?\)/);
    expect(await plan(EXPIRE_HOST_ORDERS_SQL, [now, "h_0123456789"])).toMatch(/USING INDEX (uq_host_orders_open_kind \(host_id=\?\)|idx_host_orders_open_until)/);
    expect(await plan(EXPIRE_ALL_HOST_ORDERS_SQL, [now])).toMatch(/USING INDEX idx_host_orders_open_until \(not_after<\?\)/);
    expect(await plan(ANSWER_HOST_ORDER_SQL, ["done", now, "", "ho_x", "h_x"])).toMatch(/USING INDEX sqlite_autoindex_host_orders_1 \(id=\?\)|USING INDEX uq_host_orders_open_kind/);
  });
});
