/**
 * Host registrations claim with their capacity, a claim_id and their leases,
 * and every lease carries a generation (#334, epic #307, design v2 §8.1,
 * §8.5, §8.6; D29, D46, D54), inside workerd with a real D1:
 *
 * - a task stopped and re-claimed by the same host before the kill lands:
 *   the old container's token (the older generation) is refused for its
 *   uploads, its heartbeat and its completion;
 * - a claim retried with the same claim_id gets the same lease and a fresh
 *   token, never a second lease;
 * - `want: 0` reconciles and delivers orders, and takes nothing;
 * - an unfenced lease two claims did not list goes back after 2 minutes
 *   with its attempt; a fenced one ends only when a claim stops listing it;
 * - Stop is per lease, capped per login;
 * - `lost` gives the attempt back twice per task, `oom` spends it;
 * - units, the reserved job unit, agent slots and P1's one build and one
 *   audit, from the pool's own leases;
 * - and a legacy registration behaves as before.
 *
 * Tokens: workers omw_<id>, people's CLI omc_<login>.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { hostClaim, HOST_LEASES_SQL, LEASE_GEN, LOST_LEASE_SQL, REPLAY_SQL } from "../src/routes/factory";
import { HELD_TASKS_SQL } from "../src/routes/orders";
import { COUNT_LOGIN_STOPS_SQL, ISSUE_SQL, MAX_STOPS_PER_LOGIN_HOUR } from "../src/orders";

const API = "http://pool.test/api/v1";
const MIN = 60000;
const hex = (n: number) => n.toString(16).padStart(32, "0");

interface Who { token?: string }
async function call(method: string, path: string, body?: unknown, who: Who = {}, raw?: BodyInit): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw !== undefined) headers["content-type"] = "application/octet-stream";
  if (who.token) headers.authorization = `Bearer ${who.token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const cli = (login: string): Who => ({ token: `omc_${login}` });
const job = (token: string): Who => ({ token });
/** A job token's claims, as the pool signed them. */
const claimsOf = (token: string) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { t: number; w: string; g?: string };

/** The Studio's numbers: 11 units, one kept for pool jobs, two agent slots. */
const STUDIO = { cpus: 12, mem_gb: 32, disk_free_gb: { work: 410, engine: 220 }, units: 11, job_reserved: 1, agent_slots: 2, lanes: [{ arch: "aarch64", mode: "native" }] };
let seq = 0;
interface ClaimOpts { want?: 0 | 1; leases?: { task: number; gen: string }[]; claimId?: string; capacity?: unknown; kinds?: string[] }
/** A claim as a host's dispatcher sends it (design v2 §8.1): the probe sidecar's agent, its orders, a claim_id new per attempt. */
const hostBody = (o: ClaimOpts = {}) => ({
  arch: "aarch64", version: "v1.0.2", hostname: "box", kinds: o.kinds ?? ["build", "trial", "audit"],
  claim_id: o.claimId ?? `c_${String(++seq).padStart(10, "0")}`, want: o.want ?? 1, leases: o.leases ?? [], capacity: o.capacity ?? STUDIO,
  agent: { provider: "anthropic", model: "claude-test", probe: "ok", checked_at: "2026-09-30T12:00:00Z" }, agent_via: "direct",
  orders: ["drain", "recheck-agent", "restart", "stop-task"], instance: hex(7),
});
const claim = (id: string, o: ClaimOpts = {}) => call("POST", "/factory/claim", hostBody(o), { token: `omw_${id}` });
const lease = (r: { json: any }) => ({ task: r.json.task.id as number, gen: r.json.task.lease_gen as string });
const taskOf = (id: number) => env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<any>();
const issue = (id: string, body: unknown, who: Who) => call("POST", `/factory/workers/${id}/orders`, body, who);

async function seedHost(id: string, o: { poolCap?: number | null } = {}) {
  const hostId = `h_${id.replace(/[^0-9a-z]/g, "").padEnd(10, "0").slice(0, 10)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, arch, pool_cap_units, worker_id, confirmed_at) VALUES (?, 'm1', 1001, ?, ?, 'active', 'aarch64', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
      .bind(hostId, id, `key-${id}`, o.poolCap ?? null, id),
    env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, kind, host_id) VALUES (?, 'aarch64', 'm1', ?, 'shared', 'project', 'm1', ?, 'host', ?)")
      .bind(id, await sha256Hex(`omw_${id}`), new Date().toISOString(), hostId),
  ]);
}
/** A task pinned to one registration, so the other tests' hosts never take it. */
async function seedTask(t: { name: string; pin: string | null; kind?: string; trust?: "project" | "community"; owner?: string | null; params?: unknown; max_attempts?: number; priority?: number; ref?: string }): Promise<number> {
  return (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, max_attempts, pinned_to) VALUES (?, 'aarch64', '1.2-1', ?, 'test', ?, 'queued', 0, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(t.name, t.ref ?? `https://github.com/x/${t.name}@v1:PKGBUILD`, t.priority ?? 100, t.trust ?? "community", t.owner ?? (t.trust === "project" ? null : "bob"), t.kind ?? "build", t.params === undefined ? null : JSON.stringify(t.params), t.max_attempts ?? 3, t.pin)
    .first<{ id: number }>())!.id;
}
const leasedTo = async (id: string) => (await env.DB.prepare("SELECT id, kind, units FROM build_tasks WHERE status = 'leased' AND lease_owner = ? ORDER BY id").bind(id).all<{ id: number; kind: string; units: number }>()).results;

beforeAll(async () => {
  const h = (t: string) => sha256Hex(t);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2'), ('m3')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('m1', ?, ?, 'maintainer'), ('m2', ?, ?, 'maintainer'), ('m3', ?, ?, 'maintainer'), ('bob', ?, ?, 'contributor')`)
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_m3"), await h("oms_m3"), await h("omc_bob"), await h("oms_bob")),
    env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('felix', 'bob', 'https://github.com/bob/felix', '["aarch64"]', 'waiting'), ('gus', 'bob', 'https://github.com/bob/gus', '["aarch64"]', 'waiting')`),
  ]);
});

afterEach(async () => {
  vi.useRealTimers();
  // Each test's queue is its own.
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE status IN ('queued', 'leased')").run();
});

describe("the D1 migration (0044)", () => {
  it("adds a lease's generation, lane, units, size, disk, release, claim and losses, a package's size and disk; one open stop per task, one open order of every other kind per worker", async () => {
    const cols = async (t: string) => (await env.DB.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((r) => r.name);
    expect(await cols("build_tasks")).toEqual(expect.arrayContaining(["lease_gen", "lane", "units", "size", "disk_gb", "release", "claim_id", "host_losses", "lease_missed"]));
    expect(await cols("factory_packages")).toEqual(expect.arrayContaining(["size", "disk_gb"]));
    const t = await seedTask({ name: "felix", pin: null });
    expect(await taskOf(t)).toMatchObject({ lease_gen: null, host_losses: 0, lease_missed: 0 });
    const order = (id: string, kind: string, task: number | null) => env.DB.prepare("INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, task_id, expires_at) VALUES (?, 'w-mig', ?, 'r', 'm1', ?, '2999-01-01T00:00:00Z')").bind(id, kind, task).run();
    await order("wo_m1", "stop-task", 1);
    await order("wo_m2", "stop-task", 2);
    await expect(order("wo_m3", "stop-task", 1)).rejects.toThrow(/UNIQUE/);
    await order("wo_m4", "drain", null);
    await expect(order("wo_m5", "drain", null)).rejects.toThrow(/UNIQUE/);
    // A closed one leaves room for the next.
    await env.DB.prepare("UPDATE worker_orders SET state = 'done' WHERE id = 'wo_m4'").run();
    await order("wo_m6", "drain", null);
    await env.DB.prepare("DELETE FROM worker_orders WHERE worker_id = 'w-mig'").run();
  });
});

describe("a host's claim", () => {
  it("is read whole: a claim_id, want, its leases, and its capacity when it wants a task", async () => {
    expect(hostClaim({ claim_id: "c_abcdefgh", want: 1, leases: [], capacity: STUDIO })).toMatchObject({ claimId: "c_abcdefgh", want: 1, leases: [] });
    expect(hostClaim({ claim_id: "c_abcdefgh", want: 0, leases: [{ task: 3, gen: "g_0123456789abcdef" }] })).toMatchObject({ want: 0, capacity: null, leases: [{ task: 3, gen: "g_0123456789abcdef" }] });
    expect(hostClaim({ want: 1, leases: [], capacity: STUDIO })).toMatch(/^claim_id/);
    expect(hostClaim({ claim_id: "c_abcdefgh", want: 2, leases: [], capacity: STUDIO })).toMatch(/^want/);
    expect(hostClaim({ claim_id: "c_abcdefgh", want: 1, capacity: STUDIO })).toMatch(/^leases/);
    expect(hostClaim({ claim_id: "c_abcdefgh", want: 1, leases: [{ task: 3, gen: "g_x" }], capacity: STUDIO })).toMatch(/^a lease/);
    expect(hostClaim({ claim_id: "c_abcdefgh", want: 1, leases: [] })).toMatch(/^capacity/);
    await seedHost("h-shape");
    const r = await call("POST", "/factory/claim", { arch: "aarch64", version: "v1.0.2" }, { token: "omw_h-shape" });
    expect(r).toMatchObject({ status: 400, json: { error: expect.stringMatching(/^claim_id/) } });
  });

  it("leases with a generation, the native lane, its units, size, disk budget, release and claim; the job token carries the generation; the row keeps no current_task", async () => {
    await seedHost("h-gen");
    const t = await seedTask({ name: "felix", pin: "h-gen" });
    const c = await claim("h-gen", { claimId: "c_gen0000001" });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.task.id).toBe(t);
    expect(c.json.task.lease_gen).toMatch(LEASE_GEN);
    expect(await taskOf(t)).toMatchObject({ status: "leased", lane: "native", units: 2, size: 1, disk_gb: 20, release: "v1.0.2", claim_id: "c_gen0000001", lease_missed: 0 });
    expect(claimsOf(c.json.token)).toMatchObject({ t, w: "h-gen", g: c.json.task.lease_gen });
    // The replay key and the generation are the pool's: neither public view hands them out.
    const listed = (await call("GET", "/factory?limit=200")).json.tasks.find((x: any) => x.id === t);
    const page = (await call("GET", `/factory/tasks/${t}`)).json.task;
    for (const v of [listed, page]) {
      expect(v).toMatchObject({ id: t, status: "leased" });
      expect(v).not.toHaveProperty("claim_id");
      expect(v).not.toHaveProperty("lease_gen");
    }
    const hb = await call("POST", `/factory/tasks/${t}/heartbeat`, {}, job(c.json.token));
    expect(hb.status).toBe(200);
    expect(claimsOf(hb.json.token).g).toBe(c.json.task.lease_gen);
    expect((await env.DB.prepare("SELECT current_task FROM build_workers WHERE id = 'h-gen'").first("current_task"))).toBeNull();
    // The worker token never acts on a host's lease: only that lease's job token does.
    expect((await call("POST", `/factory/tasks/${t}/heartbeat`, {}, { token: "omw_h-gen" })).status).toBe(409);
    // A host's lease that ends is counted, and the row still names no task.
    expect((await call("POST", `/factory/tasks/${t}/fail`, { error: "x", final: true }, job(c.json.token))).status).toBe(200);
    expect(await env.DB.prepare("SELECT current_task, builds_failed FROM build_workers WHERE id = 'h-gen'").first()).toMatchObject({ current_task: null, builds_failed: 1 });
  });
});

describe("a task stopped and re-claimed by the same host before the kill lands", () => {
  it("the old container's uploads, heartbeat and completion are refused: its token is of the older generation", async () => {
    await seedHost("h-race");
    const t = await seedTask({ name: "felix", pin: "h-race" });
    const first = await claim("h-race");
    expect(first.json.task.id).toBe(t);
    const old = first.json.token;
    const g1 = lease(first);
    expect((await call("PUT", `/factory/tasks/${t}/artifacts/build.log`, undefined, job(old), "==> building\n")).status).toBe(201);
    // Stopped from the host's page: fenced.
    const stop = await issue("h-race", { kind: "stop-task", task: t }, cli("m1"));
    expect(stop.status, JSON.stringify(stop.json)).toBe(201);
    expect((await call("POST", `/factory/tasks/${t}/heartbeat`, {}, job(old))).json).toMatchObject({ stop: true, state: "stopping" });
    // While the claims list it, the fence holds: the dispatcher has not stopped the container yet.
    for (let i = 0; i < 3; i++) expect((await claim("h-race", { want: 0, leases: [g1] })).status).toBe(204);
    expect(await taskOf(t)).toMatchObject({ status: "leased", stop_order: stop.json.order.id });
    // The dispatcher stops listing it — the kill has not landed — and the same host wins the task back, under a new generation.
    const again = await claim("h-race", { leases: [] });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.task.id).toBe(t);
    expect(again.json.task.lease_gen).not.toBe(g1.gen);
    expect((await env.DB.prepare("SELECT state FROM worker_orders WHERE id = ?").bind(stop.json.order.id).first("state"))).toBe("done");
    // The old container: everything refused, nothing written.
    for (const [method, path, body, raw] of [
      ["PUT", `/factory/tasks/${t}/artifacts/build.log`, undefined, "==> stale\n"],
      ["POST", `/factory/tasks/${t}/artifacts/felix-1.2-1-aarch64.pkg.tar.zst/multipart?action=create`, {}, undefined],
      ["POST", `/factory/tasks/${t}/heartbeat`, {}, undefined],
      ["POST", `/factory/tasks/${t}/complete`, { sha256: "a".repeat(64), filename: "felix-1.2-1-aarch64.pkg.tar.zst" }, undefined],
      ["POST", `/factory/tasks/${t}/fail`, { error: "late" }, undefined],
    ] as const) {
      const r = await call(method, path, body, job(old), raw);
      expect(r.status, `${method} ${path}`).toBe(409);
      expect(r.json.stop, `${method} ${path}`).toBe(true);
    }
    expect(await taskOf(t)).toMatchObject({ status: "leased", lease_gen: again.json.task.lease_gen, error: null });
    // The new lease's own token is taken.
    expect((await call("PUT", `/factory/tasks/${t}/artifacts/build.log`, undefined, job(again.json.token), "==> building again\n")).status).toBe(201);
    expect((await call("POST", `/factory/tasks/${t}/heartbeat`, {}, job(again.json.token))).status).toBe(200);
  });

  it("a project build's pool and ring writes are refused to the old container too: pool:write and release:<ring> hold only while their lease does", async () => {
    await seedHost("h-race-p");
    const t = await seedTask({ name: "felix", pin: "h-race-p", trust: "project" });
    await env.DB.prepare("UPDATE build_tasks SET publish = 1 WHERE id = ?").bind(t).run();
    const first = await claim("h-race-p");
    expect(first.json.task.id, JSON.stringify(first.json)).toBe(t);
    const old = first.json.token;
    expect(claimsOf(old)).toMatchObject({ g: first.json.task.lease_gen });
    const sha = "b".repeat(64);
    const poolPut = (who: Who) => call("PUT", `/pool/${sha}?filename=felix-1.2-1-aarch64.pkg.tar.zst`, undefined, who, "x");
    const release = (who: Who) => call("POST", "/releases", { ring: "edge", packages: [] }, who);
    expect((await poolPut(job(old))).json?.stop).toBeUndefined();
    // Stopped, the claim stops listing it, the same host takes it back: a new generation.
    expect((await issue("h-race-p", { kind: "stop-task", task: t }, cli("m1"))).status).toBe(201);
    expect((await poolPut(job(old)))).toMatchObject({ status: 409, json: { stop: true } });
    const again = await claim("h-race-p", { leases: [] });
    expect(again.json.task.id).toBe(t);
    for (const r of [await poolPut(job(old)), await release(job(old)), await call("POST", `/pool/${sha}/sign`, {}, job(old)), await call("POST", "/packages", {}, job(old))]) {
      expect(r).toMatchObject({ status: 409, json: { stop: true } });
    }
    // The new lease's token passes the door (what the route then says of the body is the route's).
    expect((await poolPut(job(again.json.token))).json?.stop).toBeUndefined();
    expect((await release(job(again.json.token))).json?.stop).toBeUndefined();
  });
});

describe("a lost claim answer", () => {
  it("retried with the same claim_id returns the same task with a fresh token, and no second lease exists", async () => {
    await seedHost("h-retry");
    const t1 = await seedTask({ name: "felix", pin: "h-retry" });
    const t2 = await seedTask({ name: "gus", pin: "h-retry", kind: "audit", trust: "project", params: { task: 1 }, ref: "staging:1" });
    const a = await claim("h-retry", { claimId: "c_lostanswer1", kinds: ["build"] });
    expect(a.json.task.id).toBe(t1);
    // The token is a second newer: the answer was lost on the way; the dispatcher sends the same claim again.
    await new Promise((r) => setTimeout(r, 1100));
    const b = await claim("h-retry", { claimId: "c_lostanswer1", kinds: ["build", "audit"] });
    expect(b.status).toBe(200);
    expect(b.json.task.id).toBe(t1);
    expect(b.json.task.lease_gen).toBe(a.json.task.lease_gen);
    expect(b.json.token).not.toBe(a.json.token);
    expect((await taskOf(t1)).attempts).toBe(1);
    expect(await leasedTo("h-retry")).toEqual([{ id: t1, kind: "build", units: 2 }]);
    expect((await taskOf(t2)).status).toBe("queued");
    // A new claim_id is a new claim.
    expect((await claim("h-retry", { leases: [lease(a)] })).json.task.id).toBe(t2);
  });
});

describe("a full host", () => {
  it("claims with want: 0 — its leases reconciled, its orders delivered, nothing more leased", async () => {
    await seedHost("h-full");
    const t = await seedTask({ name: "felix", pin: "h-full" });
    const c = await claim("h-full");
    expect(c.json.task.id).toBe(t);
    const next = await seedTask({ name: "gus", pin: "h-full" });
    // A person's order rides the claim: a restart.
    const o = await issue("h-full", { kind: "restart", reason: "test" }, cli("m2"));
    expect(o.status, JSON.stringify(o.json)).toBe(201);
    const w0 = await claim("h-full", { want: 0, leases: [lease(c)] });
    expect(w0.status).toBe(200);
    expect(w0.json).toMatchObject({ task: null, orders: [{ id: o.json.order.id, kind: "restart" }] });
    expect((await claim("h-full", { want: 0, leases: [lease(c)] })).status).toBe(204);
    expect((await taskOf(next)).status).toBe("queued");
    expect((await taskOf(t)).status).toBe("leased");
  });
});

describe("reconciliation, on a fake clock", () => {
  it("an unfenced lease missing from two consecutive claims goes back once it is 2 minutes old, its attempt given back; one listed again is kept", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedHost("h-rec");
    const t = await seedTask({ name: "felix", pin: "h-rec" });
    const c = await claim("h-rec");
    expect(c.json.task.id).toBe(t);
    const at = (s: number) => vi.setSystemTime(t0 + s * 1000);
    at(30); await claim("h-rec", { want: 0 });
    expect(await taskOf(t)).toMatchObject({ status: "leased", lease_missed: 1 });
    // Listed again: seen, the count starts over.
    at(60); await claim("h-rec", { want: 0, leases: [lease(c)] });
    expect(await taskOf(t)).toMatchObject({ status: "leased", lease_missed: 0 });
    at(90); await claim("h-rec", { want: 0 });
    // Two in a row, but the lease is not 2 minutes old yet: kept.
    at(110); await claim("h-rec", { want: 0 });
    expect(await taskOf(t)).toMatchObject({ status: "leased", lease_missed: 2 });
    // A lease of another generation of the same task listed is not this one.
    at(125); await claim("h-rec", { want: 0, leases: [{ task: t, gen: "g_0000000000000000" }] });
    const back = await taskOf(t);
    expect(back).toMatchObject({ status: "queued", attempts: 0, lease_owner: null, lease_missed: 0, host_losses: 1 });
    expect(back.error).toMatch(/lost: two claims of its host did not list it; the attempt is given back/);
    expect(Date.now() - t0).toBeLessThanOrEqual(2 * MIN + 5000);
  });

  it("a host that keeps losing a task's lease spends its attempt once host_losses is spent (D54), and fails it on the last", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedHost("h-loop");
    const t = await seedTask({ name: "felix", pin: "h-loop", max_attempts: 1 });
    expect((await claim("h-loop")).json.task.id).toBe(t);
    // Lost twice already, by `lost` reports or by reconciliation: the counter is the same.
    await env.DB.prepare("UPDATE build_tasks SET host_losses = 2 WHERE id = ?").bind(t).run();
    for (const s of [150, 180]) {
      vi.setSystemTime(t0 + s * 1000);
      await claim("h-loop", { want: 0 });
    }
    const row = await taskOf(t);
    expect(row).toMatchObject({ status: "failed", attempts: 1, host_losses: 3, lease_owner: "h-loop" });
    expect(row.error).toMatch(/lost too often on its host: the attempt is spent/);
  });

  it("a fenced lease ends only when a claim stops listing it, however long it is listed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedHost("h-fence");
    const t = await seedTask({ name: "felix", pin: "h-fence" });
    const c = await claim("h-fence");
    const stop = await issue("h-fence", { kind: "stop-task", task: t }, cli("m1"));
    expect(stop.status).toBe(201);
    for (let s = 30; s <= 600; s += 30) {
      vi.setSystemTime(t0 + s * 1000);
      await claim("h-fence", { want: 0, leases: [lease(c)] });
    }
    expect(await taskOf(t)).toMatchObject({ status: "leased", stop_order: stop.json.order.id });
    vi.setSystemTime(t0 + 630 * 1000);
    await claim("h-fence", { want: 0 });
    const back = await taskOf(t);
    expect(back).toMatchObject({ status: "queued", stop_order: null, attempts: 1 });
    expect(back.error).toMatch(/^stopped on h-fence by m1/);
  });
});

describe("Stop is per lease", () => {
  it("two Stops for two leases of one host are open at once; the per-login cap applies, not the restart group's", async () => {
    await seedHost("h-two");
    const b = await seedTask({ name: "felix", pin: "h-two" });
    const a = await seedTask({ name: "gus", pin: "h-two", kind: "audit", trust: "project", params: { task: b }, ref: `staging:${b}`, priority: 40 });
    const c1 = await claim("h-two");
    const c2 = await claim("h-two", { leases: [lease(c1)] });
    expect([c1.json.task.id, c2.json.task.id].sort()).toEqual([b, a].sort());
    // Several leases: a stop names its task.
    expect((await issue("h-two", { kind: "stop-task" }, cli("m2"))).json.error).toMatch(/name one of the leases/);
    const s1 = await issue("h-two", { kind: "stop-task", task: b }, cli("m2"));
    const s2 = await issue("h-two", { kind: "stop-task", task: a }, cli("m2"));
    expect([s1.status, s2.status], JSON.stringify([s1.json, s2.json])).toEqual([201, 201]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM worker_orders WHERE worker_id = 'h-two' AND kind = 'stop-task' AND state IN ('pending', 'delivered')").first("n"))).toBe(2);
    expect((await call("GET", "/factory?limit=20")).json.workers.find((w: any) => w.id === "h-two").stoppings.map((s: any) => s.task).sort()).toEqual([b, a].sort());
    expect((await issue("h-two", { kind: "stop-task", task: b }, cli("m2"))).json.error).toMatch(/being stopped already/);
    expect((await issue("h-two", { kind: "stop-task", task: 999999 }, cli("m2"))).json.error).toMatch(/does not hold #999999/);
    // The restart group's six an hour are the host's other orders' alone: a seventh restart-type order is not refused for its stops.
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare("INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, issued_at, expires_at, state) VALUES (?, 'h-two', 'restart', 'r', 'm3', ?, ?, 'done')").bind(`wo_rg${i}`, new Date(Date.now() - (5 - i) * MIN).toISOString(), new Date(Date.now() + 60 * MIN).toISOString()).run();
    }
    expect((await issue("h-two", { kind: "restart", reason: "test" }, cli("m1"))).status).toBe(201);
    // Thirty stops by one login in an hour: the next is refused, with when.
    for (let i = 0; i < MAX_STOPS_PER_LOGIN_HOUR; i++) {
      await env.DB.prepare("INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, task_id, issued_at, expires_at, state) VALUES (?, 'elsewhere', 'stop-task', 'r', 'm3', ?, ?, ?, 'done')").bind(`wo_sc${i}`, 1000 + i, new Date(Date.now() - 30 * MIN).toISOString(), new Date(Date.now() + 60 * MIN).toISOString()).run();
    }
    await env.DB.prepare("UPDATE worker_orders SET state = 'cancelled' WHERE worker_id = 'h-two' AND kind = 'stop-task'").run();
    await env.DB.prepare("UPDATE build_tasks SET stop_order = NULL WHERE id IN (?, ?)").bind(a, b).run();
    await env.DB.prepare("UPDATE build_workers SET open_orders = NULL WHERE id = 'h-two'").run();
    const capped = await issue("h-two", { kind: "stop-task", task: b }, cli("m3"));
    expect(capped).toMatchObject({ status: 409, json: { error: expect.stringContaining(`m3 stopped ${MAX_STOPS_PER_LOGIN_HOUR} host tasks in an hour`) } });
    // The INSERT is the authority: the same cap holds there.
    const now = new Date().toISOString();
    const args = ["wo_capx", "h-two", "stop-task", "r", "m3", "token", null, 0, b, null, now, now, null, "pending", null, null, null, "[]", new Date(Date.now() - 60 * MIN).toISOString(), 6, now, null];
    expect((await env.DB.prepare(ISSUE_SQL).bind(...args).run()).meta.changes).toBe(0);
    expect((await env.DB.prepare(ISSUE_SQL).bind(...args.map((v, i) => (i === 4 ? "m1" : i === 0 ? "wo_capy" : v))).run()).meta.changes).toBe(1);
  });
});

describe("host events and attempts", () => {
  it("lost gives the attempt back at most twice per task; oom spends it and records why; a legacy registration's lost is an ordinary failure", async () => {
    await seedHost("h-lost");
    const t = await seedTask({ name: "felix", pin: "h-lost", max_attempts: 5 });
    const run = async () => {
      const c = await claim("h-lost");
      expect(c.json.task.id).toBe(t);
      return c.json.token as string;
    };
    for (const n of [1, 2]) {
      const r = await call("POST", `/factory/tasks/${t}/fail`, { error: "the engine restarted", lost: true }, job(await run()));
      expect(r.json).toMatchObject({ status: "queued", attempts: 0 });
      expect(await taskOf(t)).toMatchObject({ status: "queued", attempts: 0, host_losses: n });
    }
    // A third loss spends the attempt.
    await call("POST", `/factory/tasks/${t}/fail`, { error: "the engine restarted", lost: true }, job(await run()));
    let row = await taskOf(t);
    expect(row).toMatchObject({ status: "queued", attempts: 1, host_losses: 2 });
    expect(row.error).toMatch(/^lost a third time on its host, the attempt spent: the engine restarted/);
    // Out of memory: spent, its reason on the row.
    await call("POST", `/factory/tasks/${t}/fail`, { error: "Killed (exit 137): rustc took 9 GB", oom: true }, job(await run()));
    row = await taskOf(t);
    expect(row).toMatchObject({ status: "queued", attempts: 2 });
    expect(row.error).toBe("out of memory (the engine killed it): Killed (exit 137): rustc took 9 GB");
    const line = await env.DB.prepare("SELECT payload FROM events WHERE kind = 'build' AND json_extract(payload, '$.task') = ? ORDER BY id DESC LIMIT 1").bind(t).first<{ payload: string }>();
    expect(JSON.parse(line!.payload)).toMatchObject({ oom: true, lost: false });

    // A legacy registration: no generation, a token without one, and `lost` changes nothing.
    await env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES ('legacy-1', 'aarch64', 'm1', ?, 'shared', 'project', 'm1', ?)").bind(await sha256Hex("omw_legacy-1"), new Date().toISOString()).run();
    const l = await seedTask({ name: "promote", pin: "legacy-1", kind: "promote", trust: "project", params: { from: "edge", to: "rc" } });
    const lc = await call("POST", "/factory/claim", { arch: "aarch64", version: "v1.0.2", kinds: ["promote"] }, { token: "omw_legacy-1" });
    expect(lc.json.task.id).toBe(l);
    expect(lc.json.task.lease_gen).toBeNull();
    expect(claimsOf(lc.json.token).g).toBeUndefined();
    expect((await env.DB.prepare("SELECT current_task FROM build_workers WHERE id = 'legacy-1'").first("current_task"))).toBe(l);
    await call("POST", `/factory/tasks/${l}/fail`, { error: "the engine restarted", lost: true }, job(lc.json.token));
    expect(await taskOf(l)).toMatchObject({ status: "queued", attempts: 1, host_losses: 0, error: "the engine restarted" });
  });
});

describe("capacity, from the pool's own leases", () => {
  it("never more units than the recomputed units allow, whatever the host declares; the reserved job unit kept; the pool's cap applied", async () => {
    // 4 CPUs, 8 GB: 3 units by the signed constants, whatever it declares; one kept for pool jobs: a build (2) fits, an audit more does not.
    await seedHost("h-small");
    const small = { ...STUDIO, cpus: 4, mem_gb: 8, units: 99 };
    const b = await seedTask({ name: "felix", pin: "h-small" });
    const a = await seedTask({ name: "gus", pin: "h-small", kind: "audit", trust: "project", params: { task: b }, ref: `staging:${b}`, priority: 200 });
    const c = await claim("h-small", { capacity: small });
    expect(c.json.task.id).toBe(b);
    expect((await claim("h-small", { capacity: small, leases: [lease(c)] })).status).toBe(204);
    expect((await taskOf(a)).status).toBe("queued");
    expect((await leasedTo("h-small")).reduce((n, t) => n + t.units, 0)).toBeLessThanOrEqual(2);
    // Declaring fewer gets fewer: one unit, all of it kept for pool jobs — nothing.
    await seedHost("h-shy");
    await seedTask({ name: "felix", pin: "h-shy" });
    expect((await claim("h-shy", { capacity: { ...STUDIO, units: 1 } })).status).toBe(204);
    // The pool's cap (hosts.pool_cap_units): three units, the Studio's totals — a build, and no audit beside it.
    await seedHost("h-capped", { poolCap: 3 });
    const cb = await seedTask({ name: "felix", pin: "h-capped" });
    await seedTask({ name: "gus", pin: "h-capped", kind: "audit", trust: "project", params: { task: cb }, ref: `staging:${cb}`, priority: 200 });
    const cc = await claim("h-capped");
    expect(cc.json.task.id).toBe(cb);
    expect((await claim("h-capped", { leases: [lease(cc)] })).status).toBe(204);
  });

  it("in P1 one build and one audit per host, model work within its agent slots", async () => {
    await seedHost("h-p1");
    const b1 = await seedTask({ name: "felix", pin: "h-p1" });
    const b2 = await seedTask({ name: "gus", pin: "h-p1" });
    const tr = await seedTask({ name: "gus", pin: "h-p1", kind: "trial", trust: "project", params: { task: b1 }, ref: `staging:${b1}` });
    const a1 = await seedTask({ name: "felix", pin: "h-p1", kind: "audit", trust: "project", params: { task: b1 }, ref: `staging:${b1}`, priority: 200 });
    const a2 = await seedTask({ name: "gus", pin: "h-p1", kind: "audit", trust: "project", params: { task: b2 }, ref: `staging:${b2}`, priority: 200 });
    const held: { task: number; gen: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await claim("h-p1", { leases: held });
      if (c.status === 200) held.push(lease(c));
    }
    expect((await leasedTo("h-p1")).map((t) => t.kind).sort()).toEqual(["audit", "build"]);
    expect(held.map((l) => l.task).sort()).toEqual([b1, a1].sort());
    for (const id of [b2, tr, a2]) expect((await taskOf(id)).status).toBe("queued");
    // No agent slot: an audit is never leased, a build is.
    await seedHost("h-noslot");
    const na = await seedTask({ name: "felix", pin: "h-noslot", kind: "audit", trust: "project", params: { task: b1 }, ref: `staging:${b1}`, priority: 10 });
    const nb = await seedTask({ name: "gus", pin: "h-noslot" });
    const n1 = await claim("h-noslot", { capacity: { ...STUDIO, agent_slots: 0 } });
    expect(n1.json.task.id).toBe(nb);
    expect((await claim("h-noslot", { capacity: { ...STUDIO, agent_slots: 0 }, leases: [lease(n1)] })).status).toBe(204);
    expect((await taskOf(na)).status).toBe("queued");
  });
});

describe("what the planner reads", () => {
  it("a host's leases, the replay, the lost lease, the held tasks and the login's stops by their indexes, never a scan", async () => {
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const now = new Date().toISOString();
    const cases: [string, string, unknown[], RegExp][] = [
      ["a host's leases", HOST_LEASES_SQL, ["w"], /SEARCH build_tasks USING INDEX idx_build_tasks_(lease|queue|kind) /],
      ["the held tasks", HELD_TASKS_SQL, ["w"], /SEARCH build_tasks USING INDEX idx_build_tasks_(lease|queue|kind) /],
      ["the replay", REPLAY_SQL, [now, "w", "c_x"], /SEARCH build_tasks USING INDEX idx_build_tasks_(lease|queue|kind) /],
      ["a lost lease back", LOST_LEASE_SQL, ["e", 1, "w", "g", "2026-10-01T00:00:00Z"], /SEARCH build_tasks USING INTEGER PRIMARY KEY/],
      ["a login's stops", COUNT_LOGIN_STOPS_SQL, ["m1", now], /SEARCH worker_orders USING INDEX idx_worker_orders_issuer/],
    ];
    for (const [what, sql, args, want] of cases) {
      const p = await plan(sql, args);
      expect(p, what).toMatch(want);
      expect(p, what).not.toMatch(/SCAN (worker_orders|build_workers|build_tasks)(?! USING)/);
    }
  });
});
