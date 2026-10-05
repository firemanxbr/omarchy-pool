/**
 * The host's settings and the rest of the host orders (#325, epic #307,
 * design v2 §12, §17.1, §18.1), through the Worker with real Ed25519 host
 * keys:
 *
 * - The migration (0047): a settings order's value, the host's settings, the
 *   diagnostics table.
 * - POST /hosts/:id/orders for set-units, set-emulate, rotate-token,
 *   retry-release and diagnostics: its owner or any maintainer, an agent from
 *   0.4.0 (an older one would refuse them as unknown), a value read field by
 *   field (whether it fits the envelope is the agent's to say), one open per
 *   kind, the line on the journal with the value.
 * - The signed host state: each order with its value, and the settings its
 *   agent took; a done settings order becomes the host's settings, a refused
 *   one changes nothing.
 * - Narrowed units take effect at the host's next claim, and a host holding
 *   more than the new count keeps its leases (nothing fenced), claiming
 *   nothing until they fit.
 * - POST /hosts/self/diagnostics: the lines of a diagnostics order of that
 *   host only, while it waits for its answer, at most 500 and 64 KiB, a line
 *   that looks like a secret dropped and counted; GET
 *   /hosts/:id/diagnostics/:order for its owner and the maintainers; the cron
 *   keeps a week.
 * - The contract with the agent (crates/omarchy-agent/tests/fixtures/
 *   host-api/report-settings.json): the report with settings, posted as the
 *   agent posts it, reads back on the host page field by field.
 * - Every new statement through an index.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { toB64url } from "../src/webauthn";
import { agentTakesSettings, enrollMessage, hostSettingsOf, orderArg, reportedSettingsOf, signedMessage, DIAGNOSTIC_LINES } from "../src/hosts";
import { HOST_DIAGNOSTICS_SQL, HOST_ORDERS_SQL, SETTINGS_FROM_ANSWER_SQL, hostVerdicts, pruneHosts } from "../src/routes/hosts";
import settingsFixture from "../../crates/omarchy-agent/tests/fixtures/host-api/report-settings.json?raw";

const ORIGIN = "http://localhost:8787";
const STUDIO = { cpus: 12, mem_gb: 32, disk_free_gb: { work: 410, engine: 220 }, units: 11, job_reserved: 1, agent_slots: 2, lanes: [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated", via: "qemu" }] };

interface Res { status: number; json: any }
async function call(method: string, path: string, opts: { session?: string; token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.session) { headers.cookie = `omc=oms_${opts.session}`; headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  Object.assign(headers, opts.headers ?? {});
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body }), env, ctx);
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
async function signed(k: Key, host: string, method: string, path: string, body = ""): Promise<Res> {
  const ts = Math.floor(Date.now() / 1000), nonce = hex(16);
  const sig = await sign(k, signedMessage(host, method, `/api/v1${path}`, await sha(body), ts, nonce));
  return call(method, path, { raw: method === "GET" ? undefined : body, headers: { "omarchy-host": `${host}; ts=${ts}; nonce=${nonce}; sig=${sig}` } });
}
const state = (k: Key, host: string) => signed(k, host, "GET", "/hosts/self/state");
const report = (k: Key, host: string, r: unknown) => signed(k, host, "POST", "/hosts/self/report", JSON.stringify(r));

/** One maintainer host from nothing to active, its agent `agent`. */
async function activeHost(owner: string, name: string, agent = "0.4.0"): Promise<{ k: Key; host: string; worker: string }> {
  const k = await newKey();
  const m = await call("POST", "/hosts/enrollments", { session: owner, body: { name } });
  expect(m.status, JSON.stringify(m.json)).toBe(201);
  const e = await call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(k, enrollMessage(m.json.token, k.pub)), hostname: "box-1", os: "linux", arch: "aarch64", page_kb: 16, isolation: "root", dedicated: true, agent_version: agent, capacity: STUDIO } });
  expect(e.status, JSON.stringify(e.json)).toBe(201);
  const c = await call("POST", `/hosts/${e.json.host}/confirm`, { session: owner, body: {} });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { k, host: e.json.host, worker: c.json.worker };
}
const order = (as: string, host: string, body: Record<string, unknown>) => call("POST", `/hosts/${host}/orders`, { session: as, body });
const orderRow = (id: string) => env.DB.prepare("SELECT * FROM host_orders WHERE id = ?").bind(id).first<any>();
const hostRow = (id: string) => env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<any>();
const lines = (action: string) => env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'host' AND json_extract(payload, '$.action') = ? ORDER BY id").bind(action).all<{ status: string; summary: string; payload: string }>().then((r) => r.results.map((l) => ({ ...l, payload: JSON.parse(l.payload) })));

beforeAll(async () => {
  const people: [string, string, number | null][] = [["m1", "maintainer", 1001], ["m2", "maintainer", 1002], ["alice", "contributor", 2001]];
  await env.DB.batch(await Promise.all(people.map(async ([l, role, g]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES (?, ?, ?, ?, ?)").bind(l, await sha256Hex(`omc_${l}`), await sha256Hex(`oms_${l}`), role, g))));
  await applyGovernance(env, ["m1", "m2"], "sha-settings");
});

describe("the D1 migration (0047)", () => {
  it("adds a settings order's value, the host's settings and the diagnostics a host sent", async () => {
    const cols = async (t: string) => (await env.DB.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((r) => r.name);
    expect(await cols("host_orders")).toContain("arg");
    expect(await cols("hosts")).toContain("settings");
    expect(await cols("host_diagnostics")).toEqual(["order_id", "host_id", "at", "lines", "dropped"]);
    // host_orders' CHECK names P4's kinds since 0046.
    for (const kind of ["set-units", "set-emulate", "rotate-token", "retry-release", "diagnostics"]) {
      await env.DB.prepare("INSERT INTO host_orders (id, host_id, kind, issued_by, not_after) VALUES (?, 'h_mig0000047', ?, 'm1', '2030-01-01T00:00:00.000Z')").bind(`ho_${kind}`, kind).run();
    }
    await env.DB.prepare("DELETE FROM host_orders WHERE host_id = 'h_mig0000047'").run();
  });
});

describe("who gives P4's orders (POST /hosts/:id/orders)", () => {
  it("its owner or any maintainer, an agent from 0.4.0, each value read field by field, one open per kind, on the journal with its value", async () => {
    const { k, host } = await activeHost("m1", "narrow");
    expect(await order("alice", host, { kind: "set-units", units: 4 })).toMatchObject({ status: 403, json: { code: "host_right" } });
    expect((await call("POST", `/hosts/${host}/orders`, { body: { kind: "set-units", units: 4 } })).status).toBe(401);
    expect(await call("POST", `/hosts/${host}/orders`, { token: "omc_m1", body: { kind: "set-units", units: 4 } })).toMatchObject({ status: 403, json: { code: "web_only" } });
    for (const bad of [{ units: 0 }, { units: "4" }, { units: 4097 }, { units: 2.5 }, {}]) {
      expect(await order("m1", host, { kind: "set-units", ...bad }), JSON.stringify(bad)).toMatchObject({ status: 400, json: { code: "arg" } });
    }
    for (const bad of [{ emulate: "x86_64" }, { emulate: ["riscv64"] }, { emulate: ["x86_64", "aarch64", "x86_64"] }, {}]) {
      expect(await order("m1", host, { kind: "set-emulate", ...bad }), JSON.stringify(bad)).toMatchObject({ status: 400, json: { code: "arg" } });
    }
    // Another maintainer narrows it: "do less", inside the envelope its owner wrote.
    const u = await order("m2", host, { kind: "set-units", units: 4 });
    expect(u.status, JSON.stringify(u.json)).toBe(201);
    expect(u.json.order.arg).toEqual({ units: 4 });
    expect(u.json.line).toBe("narrow of m1: m2 narrowed it to 4 units");
    expect(await order("m1", host, { kind: "set-units", units: 3 })).toMatchObject({ status: 409, json: { code: "order_open" } });
    expect(await orderRow(u.json.order.id)).toMatchObject({ kind: "set-units", issued_by: "m2", arg: JSON.stringify({ units: 4 }), state: "open" });
    const issued = (await lines("order")).find((l) => l.payload.order === u.json.order.id)!;
    expect(issued).toMatchObject({ status: "ok", payload: { kind: "set-units", units: 4, by: "m2" } });
    // A lane the envelope may exclude passes the door: the agent is the one that knows, and refuses it.
    const e = await order("m1", host, { kind: "set-emulate", emulate: ["x86_64", "x86_64"] });
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    expect(e.json.order.arg).toEqual({ emulate: ["x86_64"] });
    expect(e.json.line).toBe("narrow of m1: m1 set its emulated lanes to x86_64");
    for (const [kind, line] of [
      ["rotate-token", "narrow of m1: m1 ordered its worker token rotated"],
      ["retry-release", "narrow of m1: m1 ordered its quarantined release tried again"],
      ["diagnostics", "narrow of m1: m1 asked for its dispatcher's last log lines"],
    ]) {
      const o = await order("m1", host, { kind });
      expect(o.status, JSON.stringify(o.json)).toBe(201);
      expect(o.json.line).toBe(line);
      expect(o.json.order.arg).toBeUndefined();
    }
    // The state hands them to the agent, in the order given, a settings order with its value.
    const st = await state(k, host);
    expect(st.json.orders.map((o: Record<string, unknown>) => [o.kind, o.units, o.emulate])).toEqual([
      ["set-units", 4, undefined], ["set-emulate", undefined, ["x86_64"]], ["rotate-token", undefined, undefined], ["retry-release", undefined, undefined], ["diagnostics", undefined, undefined],
    ]);
  });

  it("an agent before 0.4.0 is given none of them, and is told why", async () => {
    const old = await activeHost("m1", "old-p4", "0.3.0");
    const r = await order("m1", old.host, { kind: "set-units", units: 4 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("its agent (0.3.0) takes no settings or P4 orders: agent 0.4.0 or later does, and a release brings it by itself");
    const page = (await call("GET", `/hosts/${old.host}`, { session: "m1" })).json;
    expect(page.can).toMatchObject({ reconcile: true, settings: false, rotate_token: false, retry_release: false, diagnostics: false });
    // Its agent updated itself: taken.
    await report(old.k, old.host, { agent: { version: "0.4.0" } });
    expect((await order("m1", old.host, { kind: "set-units", units: 4 })).status).toBe(201);
  });
});

describe("the settings in the host state and the agent's answers", () => {
  it("each order with its value; a done settings order becomes the host's settings, a refused one changes nothing", async () => {
    const { k, host } = await activeHost("m1", "answers-p4");
    const u = await order("m1", host, { kind: "set-units", units: 4 });
    const e = await order("m1", host, { kind: "set-emulate", emulate: [] });
    let s = await state(k, host);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json.settings).toBeNull();
    expect(s.json.orders).toEqual([
      { id: u.json.order.id, kind: "set-units", not_after: u.json.order.not_after, units: 4 },
      { id: e.json.order.id, kind: "set-emulate", not_after: e.json.order.not_after, emulate: [] },
    ]);
    // The agent took the units and refused the lanes (above its envelope).
    const refused = "x86_64's emulated lane is one the envelope excludes (emulate = [] in agent.toml): only its owner widens that, at the host";
    const r = await report(k, host, { agent: { version: "0.4.0" }, orders: [
      { id: u.json.order.id, kind: "set-units", outcome: "done", detail: "units 8 → 4 (its envelope gives 8)" },
      { id: e.json.order.id, kind: "set-emulate", outcome: "refused", detail: refused },
    ] });
    expect(r.json.orders_closed).toBe(2);
    expect(await orderRow(e.json.order.id)).toMatchObject({ state: "refused", detail: refused });
    expect(hostSettingsOf((await hostRow(host)).settings)).toEqual({ units: 4, emulate: null });
    s = await state(k, host);
    expect(s.json.settings).toEqual({ units: 4, emulate: null });
    expect(s.json.orders).toEqual([]);
    // The lanes, done; then the envelope's units back (null).
    const e2 = await order("m1", host, { kind: "set-emulate", emulate: ["x86_64"] });
    const u2 = await order("m1", host, { kind: "set-units", units: null });
    await report(k, host, { orders: [{ id: e2.json.order.id, outcome: "done", detail: "emulated lanes none → x86_64" }, { id: u2.json.order.id, outcome: "done", detail: "units 4 → 8" }] });
    expect((await state(k, host)).json.settings).toEqual({ units: null, emulate: ["x86_64"] });
    // Carried again, an answer changes nothing more; another host's answer changes nothing of this one's.
    const other = await activeHost("m2", "answers-p4-b");
    const u3 = await order("m1", host, { kind: "set-units", units: 2 });
    await report(other.k, other.host, { orders: [{ id: u3.json.order.id, outcome: "done", detail: "x" }] });
    expect((await state(k, host)).json.settings).toEqual({ units: null, emulate: ["x86_64"] });
  });
});

describe("narrowed units at the next claim", () => {
  it("a claim carrying the narrowed units is handed no more, and a host holding more keeps its leases and claims nothing until they fit", async () => {
    const { k, host, worker } = await activeHost("m1", "claims");
    const tok = await signed(k, host, "POST", "/hosts/self/token");
    expect(tok.status, JSON.stringify(tok.json)).toBe(200);
    const token = tok.json.token as string;
    const seed = async (t: { name: string; kind?: string; params?: unknown; ref?: string; priority?: number }) => (await env.DB.prepare(
      "INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, pinned_to) VALUES (?, 'aarch64', '1-1', ?, 'test', ?, 'queued', 0, ?, ?, ?, ?, ?) RETURNING id",
    ).bind(t.name, t.ref ?? `https://github.com/x/${t.name}@v1:PKGBUILD`, t.priority ?? 100, t.kind ? "project" : "community", t.kind ? null : "bob", t.kind ?? "build", t.params === undefined ? null : JSON.stringify(t.params), worker).first<{ id: number }>())!.id;
    let n = 0;
    const claim = (units: number, leases: { task: number; gen: string }[]) => call("POST", "/factory/claim", { token, body: {
      arch: "aarch64", version: "v1.0.2", hostname: "box", kinds: ["build", "audit"], claim_id: `c_narrow${String(++n).padStart(4, "0")}`, want: 1, leases,
      capacity: { ...STUDIO, units }, agent: { provider: "anthropic", model: "m", probe: "ok", checked_at: new Date().toISOString() }, agent_via: "direct",
      orders: ["drain", "recheck-agent", "restart", "stop-task"], instance: hex(7),
    } });
    const b = await seed({ name: "felix" });
    const a = await seed({ name: "felix", kind: "audit", params: { task: b }, ref: `staging:${b}`, priority: 200 });
    // 11 units: the build (2 units) leased.
    const c = await claim(11, []);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.task.id).toBe(b);
    const held = [{ task: b, gen: c.json.task.lease_gen as string }];
    // Narrowed to 2 (its agent rewrote capacity.json; its dispatcher's next claim carries it): the build's 2 units held, one kept for
    // pool jobs — the audit (1 unit) that 11 would take is not handed; the build is not fenced, it runs on.
    expect((await claim(2, held)).status).toBe(204);
    const build = await env.DB.prepare("SELECT status, stop_order FROM build_tasks WHERE id = ?").bind(b).first<{ status: string; stop_order: string | null }>();
    expect(build).toEqual({ status: "leased", stop_order: null });
    expect((await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(a).first<{ status: string }>())!.status).toBe("queued");
    // The envelope's units back: the audit fits again.
    const d = await claim(11, held);
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json.task.id).toBe(a);
  });
});

describe("diagnostics (POST /hosts/self/diagnostics, GET /hosts/:id/diagnostics/:order)", () => {
  it("the lines of a diagnostics order of that host, while it waits for its answer; a line that looks like a secret dropped; its owner's and the maintainers' to read", async () => {
    const { k, host } = await activeHost("m1", "diag");
    const d = await order("m1", host, { kind: "diagnostics" });
    const id = d.json.order.id as string;
    const post = (body: unknown, as = { k, host }) => signed(as.k, as.host, "POST", "/hosts/self/diagnostics", JSON.stringify(body));
    const good = Array.from({ length: 3 }, (_, i) => `2027-01-15T08:00:0${i}Z claimed task ${i}`);
    const leaky = "2027-01-15T08:00:04Z token omw_0123456789abcdef0123456789abcdef0123456789abcdef";
    const r = await post({ order: id, at: "2027-01-15T08:00:05Z", lines: [...good, leaky] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ ok: true, lines: 3, dropped: 1 });
    // The page's read: its owner and a maintainer, nobody else.
    const read = (as?: string) => call("GET", `/hosts/${host}/diagnostics/${id}`, { session: as });
    expect((await read("m1")).json).toMatchObject({ order: id, lines: good, dropped: 1 });
    expect((await read("m2")).status).toBe(200);
    expect((await read("alice")).status).toBe(403);
    expect((await read()).status).toBe(401);
    expect((await call("GET", `/hosts/${host}/diagnostics/ho_${"0".repeat(32)}`, { session: "m1" })).status).toBe(404);
    // The order lists its lines on the page.
    const page = (await call("GET", `/hosts/${host}`, { session: "m1" })).json;
    expect(page.orders.find((o: { id: string }) => o.id === id)).toMatchObject({ kind: "diagnostics", lines: true, arg: null });
    // Another host's order, an order of another kind, one answered already, too many lines, too many bytes: refused.
    const other = await activeHost("m2", "diag-b");
    expect((await post({ order: id, lines: good }, other)).status).toBe(404);
    const u = await order("m1", host, { kind: "set-units", units: 2 });
    expect((await post({ order: u.json.order.id, lines: good })).status).toBe(404);
    expect((await post({ order: id, lines: Array(DIAGNOSTIC_LINES + 1).fill("x") })).status).toBe(400);
    expect((await post({ order: id, lines: ["x".repeat(400)].concat(Array(180).fill("y".repeat(390))) })).status).toBe(413);
    await report(k, host, { orders: [{ id, outcome: "done", detail: "3 line(s) of the dispatcher's log, scrubbed" }] });
    expect((await post({ order: id, lines: good })).status).toBe(409);
    // The cron keeps a week.
    await env.DB.prepare("UPDATE host_diagnostics SET at = ? WHERE order_id = ?").bind(new Date(Date.now() - 8 * 86400_000).toISOString(), id).run();
    await pruneHosts(env);
    expect((await read("m1")).status).toBe(404);
  });
});

/** A JSON value's shape, as host-orders.test.ts's. */
function shape(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shape(x)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return typeof v;
}

describe("the contract with the agent (report-settings.json)", () => {
  it("the report with settings, posted as the agent posts it, reads back on the host page field by field", async () => {
    const { k, host } = await activeHost("m1", "contract-settings");
    const fixture = JSON.parse(settingsFixture);
    for (const a of fixture.orders as { id: string; kind: string }[]) {
      await env.DB.prepare("INSERT INTO host_orders (id, host_id, kind, issued_by, not_after, arg) VALUES (?, ?, ?, 'm1', ?, ?)")
        .bind(a.id, host, a.kind, new Date(Date.now() + 3600_000).toISOString(), a.kind === "set-units" ? JSON.stringify({ units: 4 }) : JSON.stringify({ emulate: [] })).run();
    }
    const r = await signed(k, host, "POST", "/hosts/self/report", settingsFixture);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ orders_closed: 2, units: 4 });
    const page = (await call("GET", `/hosts/${host}`, { session: "m1" })).json;
    expect(page.host.settings).toEqual(fixture.settings);
    expect(shape(page.host.settings)).toEqual(shape(reportedSettingsOf(settingsFixture)));
    expect(page.host.brake).toEqual(fixture.brake);
    expect(page.host.units).toBe(4);
    expect(page.host.lanes).toEqual([{ arch: "aarch64", mode: "native" }]);
    expect(page.host.pool_settings).toEqual({ units: 4, emulate: [] });
    expect(page.can).toMatchObject({ settings: true, rotate_token: true, diagnostics: true });
    expect(page.orders.map((o: { kind: string; arg: unknown }) => [o.kind, o.arg])).toEqual(expect.arrayContaining([["set-units", { units: 4 }], ["set-emulate", { emulate: [] }]]));
    // A contributor sees none of it.
    expect((await call("GET", `/hosts/${host}`, { session: "alice" })).json.host.settings).toBeUndefined();
  });
});

describe("the pure rules", () => {
  it("P4 takes an agent from 0.4.0; values and reported settings are read field by field", () => {
    for (const [v, ok] of [["0.4.0", true], ["0.4.1", true], ["1.0.0", true], ["0.3.9", false], ["0.3.0", false], [null, false]] as const) expect(agentTakesSettings(v), String(v)).toBe(ok);
    expect(orderArg("set-units", { units: null })).toEqual({ units: null });
    expect(orderArg("set-emulate", { emulate: ["x86_64", "aarch64"] })).toEqual({ emulate: ["aarch64", "x86_64"] });
    expect(orderArg("reconcile-now", { units: 3 })).toBeNull();
    expect(hostSettingsOf("{")).toBeNull();
    expect(hostSettingsOf(JSON.stringify({ units: 0, emulate: ["riscv64"] }))).toBeNull();
    expect(reportedSettingsOf(JSON.stringify({ settings: { units: "4", emulate: "x", envelope: { max_units: -1, diagnostics: "yes" }, effective: {}, above: ["a\u0000b", "fine"] } }))).toEqual({
      units: null, emulate: null, envelope: { max_units: null, detected_units: null, emulate: null, detected_lanes: [], diagnostics: null }, effective: { units: null, emulated: [] }, above: ["fine"],
    });
    const h = { name: "x", status: "active", owner_login: "m1", owner_github_id: 1, agent_version: "0.4.0" };
    expect(hostVerdicts({ login: "m2", maintainer: true, github_id: 2 }, h).settings.ok).toBe(true);
    expect(hostVerdicts({ login: "bob", maintainer: false, github_id: 3 }, h).diagnostics).toMatchObject({ ok: false, status: 403 });
    expect(hostVerdicts({ login: "m1", maintainer: true, github_id: 1 }, { ...h, status: "suspended" }).rotate_token).toMatchObject({ ok: false, status: 409 });
  });

  it("every new statement goes through an index", async () => {
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const now = new Date().toISOString();
    const orders = await plan(HOST_ORDERS_SQL, ["h_0123456789"]);
    expect(orders).toMatch(/SEARCH o USING INDEX idx_host_orders_host \(host_id=\?\)/);
    expect(orders).toMatch(/SEARCH d USING COVERING INDEX sqlite_autoindex_host_diagnostics_1 \(order_id=\?\)/);
    expect(await plan(HOST_DIAGNOSTICS_SQL, ["ho_x", "h_x"])).toMatch(/USING INDEX sqlite_autoindex_host_diagnostics_1 \(order_id=\?\)/);
    const settings = await plan(SETTINGS_FROM_ANSWER_SQL, ["ho_x", "h_x", now]);
    expect(settings).toMatch(/hosts USING INDEX sqlite_autoindex_hosts_1 \(id=\?\)/);
    expect(settings).not.toMatch(/SCAN host_orders/);
    expect(await plan("DELETE FROM host_diagnostics WHERE at < ?", [now])).toMatch(/USING INDEX idx_host_diagnostics_at \(at<\?\)/);
  });
});
