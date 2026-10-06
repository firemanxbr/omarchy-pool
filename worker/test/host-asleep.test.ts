/**
 * A Mac host that sleeps (#329, epic #307, design v2 §19.2; P5): a sleeping
 * host has zero free units. Through the Worker with a real D1, real Ed25519
 * host keys and a fake clock, as the hosts' agents report and their
 * dispatchers claim:
 *
 * - the report's `asleep`: kept from the first report that says so (its
 *   time) until one that does not; an agent that does not say it is awake;
 *   the host's page says it, for anyone;
 * - a host reporting `asleep: true` is handed nothing while work waits — the
 *   claim its dispatcher makes before the VM stops gets a 204 — and its
 *   leases stay its own; the report after the wake, and its next claim takes
 *   work again, with nobody's action; an asleep report that commits between
 *   a claim's read of its host and its lease leaves that claim nothing (the
 *   lease's own statement checks it);
 * - a sleeping host is no capacity for anyone else: an emulated lane does not
 *   wait for its native one, and it counts in no size alive;
 * - a stale `asleep` (no report for 15 minutes) holds nothing: a dispatcher
 *   that claims past it is on a Mac that woke whose agent has not said so;
 * - after the lid closed on a task, its lease expires and the cron requeues
 *   it; the Mac that woke reports itself awake and its claim, still listing
 *   the lease it lost, takes the task again under a new lease — nothing on
 *   the Mac needs a person.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { largestAlive, requeueExpiredLeases } from "../src/routes/factory";
import { asleepNow, enrollMessage, signedMessage, HOST_REPORT_FRESH_MIN } from "../src/hosts";
import { toB64url } from "../src/webauthn";

const ORIGIN = "http://pool.test";
const MIN = 60000;
/** A Mac's `omarchy` VM: 8 CPUs and 32 GB (7 units: 3 builds), its x86_64 lane through Rosetta. */
const MAC = { cpus: 8, mem_gb: 32, disk_free_gb: { work: 200, engine: 90 }, units: 7, agent_slots: 2, lanes: [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated", via: "rosetta" }] };
/** A native x86_64 host (7 units). */
const BOX = { cpus: 8, mem_gb: 16, disk_free_gb: { work: 200, engine: 90 }, units: 7, agent_slots: 2, lanes: [{ arch: "x86_64", mode: "native" }] };
/** A larger aarch64 host (11 units: 5 builds, size 4 at most). */
const STUDIO = { cpus: 12, mem_gb: 32, disk_free_gb: { work: 410, engine: 220 }, units: 11, agent_slots: 2, lanes: [{ arch: "aarch64", mode: "native" }] };

interface Res { status: number; json: any }
async function call(method: string, path: string, opts: { session?: string; token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.session) { headers.cookie = `omc=oms_${opts.session}`; headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
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
/** A signed call of host `host` (its agent's). */
async function signed(k: Key, host: string, method: string, path: string, body = ""): Promise<Res> {
  const ts = Math.floor(Date.now() / 1000), nonce = hex(16);
  const sig = await sign(k, signedMessage(host, method, `/api/v1${path}`, await sha(body), ts, nonce));
  return call(method, path, { raw: method === "GET" ? undefined : body, headers: { "omarchy-host": `${host}; ts=${ts}; nonce=${nonce}; sig=${sig}` } });
}

interface Host { k: Key; id: string; worker: string; token: string; cap: typeof MAC; arch: string }
let names = 0;
/** A maintainer host from nothing to claiming: enrolled by its agent, confirmed by m1, its worker token fetched. */
async function enrolled(cap: typeof MAC, o: { os?: string; isolation?: string } = {}): Promise<Host> {
  const k = await newKey();
  const arch = cap.lanes.find((l) => l.mode === "native")!.arch;
  const m = await call("POST", "/hosts/enrollments", { session: "m1", body: { name: `box-${++names}` } });
  expect(m.status, JSON.stringify(m.json)).toBe(201);
  const e = await call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(k, enrollMessage(m.json.token, k.pub)), hostname: `box-${names}`, os: o.os ?? "macos", arch, page_kb: 16, isolation: o.isolation ?? "vm", dedicated: true, agent_version: "0.3.0", capacity: cap } });
  expect(e.status, JSON.stringify(e.json)).toBe(201);
  const c = await call("POST", `/hosts/${e.json.host}/confirm`, { session: "m1", body: {} });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const t = await signed(k, e.json.host, "POST", "/hosts/self/token");
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  return { k, id: e.json.host, worker: c.json.worker, token: t.json.token, cap, arch };
}

/** The host report as an agent sends it: `asleep` when given (an older agent says nothing). */
const report = (h: Host, asleep?: boolean) => signed(h.k, h.id, "POST", "/hosts/self/report", JSON.stringify({ agent: { version: "0.3.0" }, release: { applied: "v1.0.0" }, capacity: h.cap, orders: [], ...(asleep === undefined ? {} : { asleep }) }));

let seq = 0;
/** A claim as the host's dispatcher sends it (design v2 §8.1), with the leases it holds. */
const claim = (h: Host, leases: { task: number; gen: string }[] = []) => call("POST", "/factory/claim", { token: h.token, body: {
  arch: h.arch, version: "v1.0.2", hostname: h.id, kinds: ["build", "trial", "audit"], claim_id: `c_sleep${String(++seq).padStart(8, "0")}`, want: 1,
  leases, capacity: h.cap, agent: { provider: "anthropic", model: "claude-test", probe: "ok", checked_at: "2026-10-01T00:00:00Z" },
} });

/** A project build queued now. */
async function seedTask(arch = "aarch64"): Promise<number> {
  const name = `pkg-sleep-${++seq}`;
  return (await env.DB.prepare(
    "INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, kind, created_at) VALUES (?, ?, '1.0-1', ?, 'test', 100, 'queued', 0, 'project', 'build', ?) RETURNING id",
  ).bind(name, arch, `https://github.com/x/${name}@v1:PKGBUILD`, new Date().toISOString()).first<{ id: number }>())!.id;
}
const taskOf = (id: number) => env.DB.prepare("SELECT status, lease_owner, lease_gen, lane, error FROM build_tasks WHERE id = ?").bind(id).first<any>();
const rowOf = (h: Host) => env.DB.prepare("SELECT asleep_at, reported_at FROM hosts WHERE id = ?").bind(h.id).first<{ asleep_at: string | null; reported_at: string | null }>();

beforeAll(async () => {
  const people: [string, string, number][] = [["m1", "maintainer", 1001], ["alice", "contributor", 2001]];
  await env.DB.batch(await Promise.all(people.map(async ([l, role, g]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES (?, ?, ?, ?, ?)").bind(l, await sha256Hex(`omc_${l}`), await sha256Hex(`oms_${l}`), role, g))));
  await applyGovernance(env, ["m1"], "sha-sleep");
});

afterEach(async () => {
  vi.useRealTimers();
  // Each test's fleet and queue are its own: the hosts before it are gone (not alive), their tasks cancelled.
  await env.DB.batch([
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE status IN ('queued', 'leased')"),
    env.DB.prepare("UPDATE build_workers SET last_seen = '2000-01-01T00:00:00.000Z'"),
  ]);
});

describe("the D1 migration (0047)", () => {
  it("adds when a host's report first said it sleeps", async () => {
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('hosts')").all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toContain("asleep_at");
  });
});

describe("the report's asleep", () => {
  it("is kept from the first report that says so until one that does not; an agent that does not say is awake; the page says it, for anyone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const mac = await enrolled(MAC);
    expect((await report(mac, false)).json).toMatchObject({ ok: true, asleep: false });
    expect((await rowOf(mac))!.asleep_at).toBeNull();
    const r = await report(mac, true);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.asleep).toBe(true);
    expect((await rowOf(mac))!.asleep_at).toBe(new Date(t0).toISOString());
    // A report a minute later that still says so keeps when it began.
    vi.setSystemTime(t0 + MIN);
    await report(mac, true);
    expect((await rowOf(mac))!.asleep_at).toBe(new Date(t0).toISOString());
    // Anyone sees it on the host's page: it sleeps, since when.
    const seen = await call("GET", `/hosts/${mac.id}`);
    expect(seen.json.host).toMatchObject({ asleep: true, asleep_since: new Date(t0).toISOString(), alive: true });
    expect(seen.json.host.fingerprint).toBeUndefined();
    // Awake again; and an agent before #329, which says nothing, is awake.
    await report(mac, false);
    expect((await rowOf(mac))!.asleep_at).toBeNull();
    await report(mac, true);
    await report(mac);
    expect((await rowOf(mac))!.asleep_at).toBeNull();
    expect((await call("GET", `/hosts/${mac.id}`)).json.host).toMatchObject({ asleep: false, asleep_since: null });
  });

  it("holds while the report that said it is fresh: 15 minutes on, it holds nothing, and the page says what the last report said", () => {
    const at = "2026-10-05T10:00:00.000Z", t = Date.parse(at);
    expect(asleepNow({ asleep_at: at, reported_at: at }, t)).toBe(true);
    expect(asleepNow({ asleep_at: at, reported_at: at }, t + HOST_REPORT_FRESH_MIN * MIN - 1)).toBe(true);
    expect(asleepNow({ asleep_at: at, reported_at: at }, t + HOST_REPORT_FRESH_MIN * MIN)).toBe(false);
    expect(asleepNow({ asleep_at: null, reported_at: at }, t)).toBe(false);
    expect(asleepNow({ asleep_at: at, reported_at: null }, t)).toBe(false);
  });
});

describe("a host that sleeps gets no new task", () => {
  it("its dispatcher's claim before the VM stops is handed nothing while work waits, its lease stays its own; after the wake it claims again with nobody's action", async () => {
    const mac = await enrolled(MAC);
    await report(mac, false);
    const [a, b] = [await seedTask(), await seedTask()];
    const first = await claim(mac);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.task.id).toBe(a);
    const held = { task: a, gen: first.json.task.lease_gen as string };
    // The Mac goes to sleep: its agent reports first, then its dispatcher claims once more before the VM stops.
    expect((await report(mac, true)).status).toBe(200);
    const asleep = await claim(mac, [held]);
    expect(asleep.status, JSON.stringify(asleep.json)).toBe(204);
    expect(await taskOf(b)).toMatchObject({ status: "queued", lease_owner: null });
    expect(await taskOf(a)).toMatchObject({ status: "leased", lease_owner: mac.worker, lease_gen: held.gen });
    // Woke: the agent reports it, and the next claim takes the work that waited.
    expect((await report(mac, false)).status).toBe(200);
    const again = await claim(mac, [held]);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.task.id).toBe(b);
  });

  it("an asleep report that commits between a claim's read of its host and its lease leaves that claim nothing: the lease's own statement checks it", async () => {
    const mac = await enrolled(MAC);
    await report(mac, false);
    const t = await seedTask();
    // The report lands after the claim read its host (awake) and before its lease UPDATE runs.
    const db = env.DB, prepare = db.prepare.bind(db);
    let raced = false;
    (db as { prepare: typeof db.prepare }).prepare = (sql: string) => {
      const stmt = prepare(sql);
      if (!sql.includes("UPDATE build_tasks SET status = 'leased'")) return stmt;
      return { bind: (...args: unknown[]) => ({ first: async () => {
        if (!raced) {
          raced = true;
          expect((await report(mac, true)).status).toBe(200);
        }
        return stmt.bind(...args).first();
      } }) } as unknown as D1PreparedStatement;
    };
    try {
      const got = await claim(mac);
      expect(got.status, JSON.stringify(got.json)).toBe(204);
    } finally {
      (db as { prepare: typeof db.prepare }).prepare = prepare;
    }
    expect(raced).toBe(true);
    expect((await rowOf(mac))!.asleep_at).not.toBeNull();
    expect(await taskOf(t)).toMatchObject({ status: "queued", lease_owner: null });
    // Awake again: the next claim takes it.
    await report(mac, false);
    const again = await claim(mac);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.task.id).toBe(t);
  });

  it("is no capacity for anyone else: an emulated lane does not wait for its native one, and it counts in no size alive", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const mac = await enrolled(MAC);
    const box = await enrolled(BOX, { os: "linux", isolation: "root" });
    await report(mac, false);
    await report(box, false);
    // The x86_64 box claims (alive, idle): an x86_64 build waits its threshold for it rather than run on the Mac's Rosetta lane.
    expect((await claim(box)).status).toBe(204);
    const x = await seedTask("x86_64");
    expect((await claim(mac)).status).toBe(204);
    expect(await taskOf(x)).toMatchObject({ status: "queued" });
    // The box goes to sleep: no native capacity is left for it, and the Mac's emulated lane takes it at once.
    vi.setSystemTime(t0 + 10_000);
    await report(box, true);
    const got = await claim(mac);
    expect(got.status, JSON.stringify(got.json)).toBe(200);
    expect(got.json.task.id).toBe(x);
    expect(await taskOf(x)).toMatchObject({ status: "leased", lease_owner: mac.worker, lane: "emulated" });
    // The largest size alive: a sleeping Studio's size 4 is not the fleet's while it sleeps.
    const studio = await enrolled(STUDIO, { os: "linux", isolation: "root" });
    await report(studio, false);
    expect((await claim(studio)).status).toBe(204);
    expect(await largestAlive(env, Date.now())).toBe(4);
    await report(studio, true);
    expect(await largestAlive(env, Date.now())).toBe(3);
    await report(studio, false);
    expect(await largestAlive(env, Date.now())).toBe(4);
  });

  it("holds nothing once its report is stale: a dispatcher that claims 15 minutes on is on a Mac that woke", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const mac = await enrolled(MAC);
    await report(mac, true);
    const t = await seedTask();
    expect((await claim(mac)).status).toBe(204);
    vi.setSystemTime(t0 + (HOST_REPORT_FRESH_MIN - 1) * MIN);
    expect((await claim(mac)).status).toBe(204);
    vi.setSystemTime(t0 + HOST_REPORT_FRESH_MIN * MIN + 1000);
    const woke = await claim(mac);
    expect(woke.status, JSON.stringify(woke.json)).toBe(200);
    expect(woke.json.task.id).toBe(t);
  });
});

describe("the lid closed on a task", () => {
  it("its lease expires and the cron requeues it; the Mac that woke reports itself awake and its claim, still listing the lease it lost, takes the task again — nothing needs a person", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const mac = await enrolled(MAC);
    await report(mac, false);
    const t = await seedTask();
    const first = await claim(mac);
    expect(first.json.task.id).toBe(t);
    const lost = { task: t, gen: first.json.task.lease_gen as string };
    // The lid closes mid-task: the agent reports asleep, then nothing — no claim, no heartbeat, no report — for 40 minutes.
    await report(mac, true);
    vi.setSystemTime(t0 + 29 * MIN);
    expect(await requeueExpiredLeases(env)).toBe(0);
    vi.setSystemTime(t0 + 40 * MIN);
    expect(await requeueExpiredLeases(env)).toBe(1);
    expect(await taskOf(t)).toMatchObject({ status: "queued", lease_owner: null, error: `lease by ${mac.worker} expired` });
    // The wake: the agent reports first; the dispatcher's claim still lists the lease it held, and takes the task again under a new one.
    await report(mac, false);
    const again = await claim(mac, [lost]);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.task.id).toBe(t);
    expect(again.json.task.lease_gen).not.toBe(lost.gen);
    expect(await taskOf(t)).toMatchObject({ status: "leased", lease_owner: mac.worker, lease_gen: again.json.task.lease_gen });
  });
});
