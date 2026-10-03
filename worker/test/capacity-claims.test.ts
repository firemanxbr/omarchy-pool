/**
 * Capacity-aware claiming through the Worker (#337, routes/factory.ts
 * selectAndLease, selection.ts; design v2 §7.2, §7.4, §8.3; D29-D31, D50,
 * D51), inside workerd with a real D1 and a fake clock — the fleets of
 * selection.test.ts, as hosts' dispatchers claim:
 *
 * - the P1 host runs its full unit count at once, one lease each; extra
 *   queued tasks wait in the pool's queue and start as units free up;
 * - an x86_64 task goes to a native x86_64 host while one is eligible, to an
 *   aarch64 host's emulated lane after T (3 minutes with no native history,
 *   twice the last native build otherwise), at once when the native host is
 *   full, drained or below the minimum; `needs_native` never runs emulated;
 * - with only x86_64 work queued an aarch64 host fills all but one build
 *   with emulated builds, and native work arriving takes the one kept;
 * - on an aarch64-only fleet the oldest x86_64 build goes first (the share);
 * - a contributor's 150 packages hold one build at a time under the cap,
 *   and with the cap lifted round-robin by owner hands another contributor's
 *   single package the next build;
 * - a size-4 task on a busy host: after 30 minutes the host reserves for
 *   it, takes nothing else, and leases it when its units fit; a task larger
 *   than every host alive is clamped, with a Status line;
 * - out of memory says "out of memory at 4 GB (size 1)", and a maintainer's
 *   Retry at size requeues it at the size chosen; a package's size set on its
 *   page; the pool's cap on a host set by its owner or any maintainer;
 * - a legacy registration as a host with one lane and one build;
 * - and what the planner reads for the new statements.
 *
 * Tokens: workers omw_<id>, people's CLI omc_<login>, sessions oms_<login>.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { FLEET_SQL, LEASES_HELD_SQL, MARKED_WAITING_SQL, NATIVE_MS_SQL, OLDEST_BUILD_SQL, OWNER_CAP_KEY, OWNER_HEADS_SQL, PACKAGE_SIZES_SQL } from "../src/routes/factory";
import { unitsOf } from "../src/hosts";
import { toB64url } from "../src/webauthn";

const ORIGIN = "http://localhost:8787";
const MIN = 60000;

interface Res { status: number; json: any }
async function call(method: string, path: string, o: { token?: string; session?: string; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.session) { headers.cookie = `omc=oms_${o.session}`; headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

type Lane = { arch: string; mode: "native" | "emulated" };
interface Box { cpus: number; mem_gb: number; lanes: Lane[]; agent_slots?: number; disk?: { work: number; engine: number } }
const capOf = (b: Box) => ({ cpus: b.cpus, mem_gb: b.mem_gb, disk_free_gb: b.disk ?? { work: 410, engine: 220 }, units: unitsOf({ cpus: b.cpus, mem_gb: b.mem_gb, units: null }), job_reserved: 1, agent_slots: b.agent_slots ?? 2, lanes: b.lanes });
const STUDIO: Box = { cpus: 12, mem_gb: 32, lanes: [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated" }] }; // 11 units: 5 builds
const VPS86: Box = { cpus: 8, mem_gb: 16, lanes: [{ arch: "x86_64", mode: "native" }] }; // 7 units: 3 builds
const P1: Box = { cpus: 8, mem_gb: 16, lanes: [{ arch: "aarch64", mode: "native" }] };

const boxes = new Map<string, Box>();
let hostSeq = 0;
/** A maintainer host, active, with its registration, alive now: the hosts row as its last report left it. */
async function seedHost(id: string, b: Box, o: { poolCap?: number | null } = {}): Promise<string> {
  const hostId = `h_${String(++hostSeq).padStart(10, "0")}`;
  const cap = capOf(b);
  const native = b.lanes.find((l) => l.mode === "native")!.arch;
  boxes.set(id, b);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, arch, capacity, lanes, units, agent_slots, disk_free, pool_cap_units, worker_id, confirmed_at, last_seen)
                    VALUES (?, 'm1', 1001, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(hostId, id, toB64url(crypto.getRandomValues(new Uint8Array(32))), native, JSON.stringify({ ...cap, below_minimum: null }), JSON.stringify(b.lanes), unitsOf(cap), cap.agent_slots, JSON.stringify(cap.disk_free_gb), o.poolCap ?? null, id, new Date().toISOString(), new Date().toISOString()),
    env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, kind, host_id, kinds, agent_status) VALUES (?, ?, 'm1', ?, 'shared', 'project', 'm1', ?, 'host', ?, '[\"build\",\"trial\",\"audit\"]', 'ok')")
      .bind(id, native, await sha256Hex(`omw_${id}`), new Date().toISOString(), hostId),
  ]);
  return hostId;
}
/** A host that claims nothing but is alive: its last claim was now. */
const keepAlive = (id: string) => env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id = ?").bind(new Date().toISOString(), id).run();

let seq = 0;
interface ClaimOpts { want?: 0 | 1; leases?: { task: number; gen: string }[]; capacity?: unknown }
/** A claim as the host's dispatcher sends it (design v2 §8.1). */
const claim = (id: string, o: ClaimOpts = {}) => {
  const b = boxes.get(id)!;
  return call("POST", "/factory/claim", { token: `omw_${id}`, body: {
    arch: b.lanes.find((l) => l.mode === "native")!.arch, version: "v1.0.2", hostname: id, kinds: ["build", "trial", "audit"], claim_id: `c_cap${String(++seq).padStart(8, "0")}`, want: o.want ?? 1,
    leases: o.leases ?? [], capacity: o.capacity ?? capOf(b), agent: { provider: "anthropic", model: "claude-test", probe: "ok", checked_at: "2026-10-01T00:00:00Z" },
  } });
};
/** Claims until it is handed nothing, as the dispatcher claims again at once after a task: the leases it got. */
async function fill(id: string, held: { task: number; gen: string }[] = [], max = 20): Promise<{ task: number; gen: string; token: string }[]> {
  const got: { task: number; gen: string; token: string }[] = [];
  for (let i = 0; i < max; i++) {
    const c = await claim(id, { leases: [...held, ...got.map(({ task, gen }) => ({ task, gen }))] });
    if (c.status !== 200) break;
    got.push({ task: c.json.task.id, gen: c.json.task.lease_gen, token: c.json.token });
  }
  return got;
}

/** A queued task, `ago` minutes old. */
async function seedTask(t: { name?: string; arch?: string; kind?: string; trust?: "project" | "community"; owner?: string | null; params?: unknown; priority?: number; ago?: number; ref?: string }): Promise<number> {
  const name = t.name ?? `pkg${++seq}`;
  return (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, created_at) VALUES (?, ?, '1.0-1', ?, 'test', ?, 'queued', 0, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(name, t.arch ?? "aarch64", t.ref ?? `https://github.com/x/${name}@v1:PKGBUILD`, t.priority ?? 100, t.trust ?? "project", t.owner ?? (t.trust === "community" ? "bob" : null), t.kind ?? "build", t.params === undefined ? null : JSON.stringify(t.params), new Date(Date.now() - (t.ago ?? 0) * MIN).toISOString())
    .first<{ id: number }>())!.id;
}
const taskOf = (id: number) => env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<any>();
const leasesOf = async (id: string) => (await env.DB.prepare("SELECT id, kind, arch, lane, units, size FROM build_tasks WHERE status = 'leased' AND lease_owner = ? ORDER BY id").bind(id).all<any>()).results;
/** A lease ends as its report would end it: the task done. */
const finish = (task: number) => env.DB.prepare("UPDATE build_tasks SET status = 'done', finished_at = ?, lease_expires_at = NULL WHERE id = ?").bind(new Date().toISOString(), task).run();
const at = (t0: number, min: number) => vi.setSystemTime(t0 + min * MIN);

beforeAll(async () => {
  const h = sha256Hex;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES ('m1', ?, ?, 'maintainer', 1001), ('m2', ?, ?, 'maintainer', 1002), ('bob', ?, ?, 'contributor', 2001)`)
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_bob"), await h("oms_bob")),
  ]);
});

afterEach(async () => {
  vi.useRealTimers();
  // Each test's fleet and queue are its own: the hosts before it are gone (not alive), their tasks cancelled.
  await env.DB.batch([
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE status IN ('queued', 'leased')"),
    env.DB.prepare("UPDATE build_workers SET last_seen = '2000-01-01T00:00:00.000Z'"),
    env.DB.prepare("UPDATE hosts SET reserving_task = NULL, reserving_since = NULL"),
    env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(OWNER_CAP_KEY),
  ]);
});

describe("the D1 migration (0046)", () => {
  it("adds a host's reservation time, and a partial index of each contributor's queued community builds", async () => {
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('hosts')").all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["reserving_task", "reserving_since"]));
    const idx = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_build_tasks_owner_head'").first<{ sql: string }>();
    expect(idx?.sql).toMatch(/\(owner, priority\) WHERE status = 'queued' AND trust = 'community'/);
  });
});

describe("the P1 host at its full unit count", () => {
  it("runs as many tasks at once as its units allow, each its own lease; the rest waits in the queue and starts as units free up", async () => {
    await seedHost("p1", P1); // 7 units: 3 builds and the pool jobs' unit
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await seedTask({}));
    const got = await fill("p1");
    expect(got.map((g) => g.task)).toEqual(ids.slice(0, 3));
    expect(new Set(got.map((g) => g.gen)).size).toBe(3);
    expect((await leasesOf("p1")).map((l) => [l.lane, l.units, l.size])).toEqual([["native", 2, 1], ["native", 2, 1], ["native", 2, 1]]);
    expect((await taskOf(ids[3])).status).toBe("queued");
    // One ends: the next starts at the next claim.
    await finish(ids[0]);
    const next = await fill("p1", got.slice(1));
    expect(next.map((g) => g.task)).toEqual([ids[3]]);
    expect((await taskOf(ids[4])).status).toBe("queued");
  });
});

describe("a host's liveness", () => {
  it("its row is written at least every minute, so selection counts it alive (claimed in the last 2 minutes) between claims that say nothing new", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedHost("p1-live", P1);
    const seen = async () => (await env.DB.prepare("SELECT last_seen FROM build_workers WHERE id = 'p1-live'").first<{ last_seen: string }>())!.last_seen;
    await claim("p1-live", { want: 0 });
    const s0 = await seen();
    at(t0, 0.5); await claim("p1-live", { want: 0 });
    expect(await seen()).toBe(s0);
    at(t0, 1.1); await claim("p1-live", { want: 0 });
    expect(Date.parse(await seen())).toBe(t0 + 1.1 * MIN);
  });
});

describe("native preferred, emulated after T", () => {
  it("an x86_64 task goes to the eligible native x86_64 host; an aarch64 host's emulated lane takes it after T, at once when the native host is full or drained", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedHost("studio-a", STUDIO);
    await seedHost("vps-a", VPS86);
    const first = await seedTask({ arch: "x86_64" });
    // The Studio claims first: an eligible native host is alive, the task is fresh — not the emulated lane's yet.
    expect((await claim("studio-a")).status).toBe(204);
    const n = await claim("vps-a");
    expect(n.json.task).toMatchObject({ id: first, lane: "native" });
    // The native host alive and eligible but not claiming (a stalled dispatcher): the emulated lane waits 3 minutes, no more. The Studio's
    // claims list what it holds, as its dispatcher's do (an unlisted lease would go back to the queue).
    const held: { task: number; gen: string }[] = [];
    const studio = async () => {
      const c = await claim("studio-a", { leases: held });
      if (c.status === 200) held.push({ task: c.json.task.id, gen: c.json.task.lease_gen });
      return c;
    };
    const second = await seedTask({ arch: "x86_64" });
    at(t0, 2); await keepAlive("vps-a");
    expect((await studio()).status).toBe(204);
    at(t0, 3.1); await keepAlive("vps-a");
    expect((await studio()).json.task).toMatchObject({ id: second, lane: "emulated", units: 2 });
    // With a native history of 10 minutes, T is 20.
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, status, trust, kind, lane, duration_ms, created_at) VALUES ('known', 'x86_64', 'x', 'test', 'done', 'project', 'build', 'native', ?, ?)").bind(10 * MIN, new Date(t0 - 60 * MIN).toISOString()).run();
    const known = await seedTask({ arch: "x86_64", name: "known" });
    at(t0, 3.1 + 19); await keepAlive("vps-a");
    expect((await studio()).status).toBe(204);
    at(t0, 3.1 + 20.5); await keepAlive("vps-a");
    expect((await studio()).json.task).toMatchObject({ id: known, lane: "emulated" });
    // A drained native host is no capacity to wait for: at once.
    await env.DB.prepare("UPDATE build_workers SET drained_at = ?, drained_by = 'm1' WHERE id = 'vps-a'").bind(new Date().toISOString()).run();
    const fresh = await seedTask({ arch: "x86_64" });
    expect((await studio()).json.task).toMatchObject({ id: fresh, lane: "emulated" });
    await env.DB.prepare("UPDATE build_workers SET drained_at = NULL, drained_by = NULL WHERE id = 'vps-a'").run();
    // A full one neither: three builds hold its units (the one it took, two more).
    await keepAlive("vps-a");
    for (let i = 0; i < 2; i++) await env.DB.prepare("UPDATE build_tasks SET status = 'leased', lease_owner = 'vps-a', units = 2, lane = 'native' WHERE id = ?").bind(await seedTask({ arch: "x86_64", ago: 100 })).run();
    expect((await leasesOf("vps-a")).reduce((u, l) => u + l.units, 0)).toBe(6);
    const full = await seedTask({ arch: "x86_64" });
    expect((await studio()).json.task).toMatchObject({ id: full, lane: "emulated" });
  });

  it("a build an emulated lane could not run (needs_native) never goes to an emulated lane; a native host takes it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedHost("studio-n", STUDIO);
    const t = await seedTask({ arch: "x86_64", params: { needs_native: 1 }, ago: 120 });
    expect((await claim("studio-n")).status).toBe(204);
    at(t0, 90);
    expect((await claim("studio-n")).status).toBe(204);
    await seedHost("vps-n", VPS86);
    expect((await claim("vps-n")).json.task).toMatchObject({ id: t, lane: "native" });
  });

  it("with only x86_64 work queued an aarch64 host fills all but one of its builds emulated; native work arriving takes the build kept", async () => {
    await seedHost("studio-e", STUDIO);
    for (let i = 0; i < 6; i++) await seedTask({ arch: "x86_64" });
    const emu = await fill("studio-e");
    expect(emu).toHaveLength(4);
    expect((await leasesOf("studio-e")).every((l) => l.lane === "emulated")).toBe(true);
    const native = await seedTask({ arch: "aarch64" });
    const c = await claim("studio-e", { leases: emu.map(({ task, gen }) => ({ task, gen })) });
    expect(c.json.task).toMatchObject({ id: native, lane: "native" });
  });

  it("on an aarch64-only fleet the oldest x86_64 build goes first, ahead of an older aarch64 backlog (the guaranteed share)", async () => {
    await seedHost("studio-s", STUDIO);
    const backlog = [];
    for (let i = 0; i < 8; i++) backlog.push(await seedTask({ arch: "aarch64", ago: 120 }));
    const x86 = await seedTask({ arch: "x86_64", ago: 5 });
    const got = await fill("studio-s");
    expect(got[0].task).toBe(x86);
    expect(got.slice(1).map((g) => g.task)).toEqual(backlog.slice(0, 4));
  });
});

describe("fairness between contributors (D51)", () => {
  it("a contributor's 150 queued packages hold their share at most; with the cap lifted, another contributor's single package takes the next build ahead of them", async () => {
    await seedHost("big-f", { cpus: 10, mem_gb: 20, lanes: [{ arch: "aarch64", mode: "native" }] }); // 9 units: 4 builds
    for (let i = 0; i < 150; i++) await seedTask({ trust: "community", owner: "flood", ago: 60 });
    // The cap: ceil(4 builds / 4) = 1 at a time for a contributor; another's package starts at once.
    const capped = await fill("big-f");
    expect(capped).toHaveLength(1);
    const single = await seedTask({ trust: "community", owner: "single" });
    const s = await claim("big-f", { leases: capped.map(({ task, gen }) => ({ task, gen })) });
    expect(s.json.task.id).toBe(single);
    // The cap lifted (the setting at 0): the flood fills the host; a new contributor's package waits for the next build only.
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, '0')").bind(OWNER_CAP_KEY).run();
    await finish(single);
    const all = await fill("big-f", capped.map(({ task, gen }) => ({ task, gen })));
    expect((await leasesOf("big-f"))).toHaveLength(4);
    const late = await seedTask({ trust: "community", owner: "late" });
    await finish(all[0].task);
    const held = [...capped, ...all.slice(1)].map(({ task, gen }) => ({ task, gen }));
    expect((await claim("big-f", { leases: held })).json.task.id).toBe(late);
  });
});

describe("sizes and the reservation for large tasks (D31)", () => {
  it("a size-4 task on a busy host: after 30 minutes the host reserves for it, takes nothing else, and leases it once its units fit; the mark clears", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const host = await seedHost("studio-r", { ...STUDIO, lanes: [{ arch: "aarch64", mode: "native" }] });
    const busy = [];
    for (let i = 0; i < 5; i++) busy.push(await seedTask({ ago: 40 }));
    const running = await fill("studio-r");
    expect(running).toHaveLength(5);
    await env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status, size) VALUES ('chromium', 'm1', 'https://chromium.org', '[\"aarch64\"]', 'waiting', 4)").run();
    const big = await seedTask({ name: "chromium", ago: 31 });
    for (let i = 0; i < 6; i++) await seedTask({});
    const held = () => running.filter((r) => !ended.includes(r.task)).map(({ task, gen }) => ({ task, gen }));
    const ended: number[] = [];
    // One build ends: 2 units free — the size-4 needs 8. The host reserves for it, with a line, and takes no small build.
    await finish(running[0].task); ended.push(running[0].task);
    expect((await claim("studio-r", { leases: held() })).status).toBe(204);
    const row = await env.DB.prepare("SELECT reserving_task, reserving_since FROM hosts WHERE id = ?").bind(host).first<any>();
    expect(row.reserving_task).toBe(big);
    const line = await env.DB.prepare("SELECT summary FROM events WHERE kind = 'host' AND json_extract(payload, '$.task') = ? ORDER BY id DESC LIMIT 1").bind(big).first<{ summary: string }>();
    expect(line?.summary).toMatch(/^studio-r reserves for chromium \(task \d+, size 4\): it takes nothing else but pool jobs until its units fit it, two hours at most$/);
    for (const r of running.slice(1, 3)) { await finish(r.task); ended.push(r.task); }
    at(t0, 10);
    expect((await claim("studio-r", { leases: held() })).status).toBe(204);
    // Four ended: 8 units free — it is leased at size 4, and the mark goes with it.
    await finish(running[3].task); ended.push(running[3].task);
    const c = await claim("studio-r", { leases: held() });
    expect(c.json.task).toMatchObject({ id: big, size: 4, units: 8, disk_gb: 80 });
    expect((await env.DB.prepare("SELECT reserving_task FROM hosts WHERE id = ?").bind(host).first<any>()).reserving_task).toBeNull();
  });

  it("a task larger than every host alive is clamped to the largest, with a Status line; a contributor's never above 2", async () => {
    await seedHost("p1-c", P1); // 3 builds: size 3 at most
    await env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status, size, disk_gb) VALUES ('rustc', 'm1', 'https://rust-lang.org', '[\"aarch64\"]', 'waiting', 4, 150)").run();
    const t = await seedTask({ name: "rustc" });
    const c = await claim("p1-c");
    expect(c.json.task).toMatchObject({ id: t, size: 3, units: 6, disk_gb: 150 });
    const line = await env.DB.prepare("SELECT status, summary FROM events WHERE kind = 'build' AND json_extract(payload, '$.task') = ? AND json_extract(payload, '$.clamped') = 1").bind(t).first<any>();
    expect(line).toEqual({ status: "warn", summary: `rustc for aarch64 (task ${t}) asked size 4; the largest host alive runs size 3: it runs clamped on p1-c` });
    // A contributor's build of a size-4 package runs at 2.
    const ct = await seedTask({ name: "rustc", trust: "community", owner: "bob" });
    expect((await claim("p1-c", { leases: [{ task: t, gen: c.json.task.lease_gen }] })).status).toBe(204); // 6 of 6 units held
    await finish(t);
    expect((await claim("p1-c")).json.task).toMatchObject({ id: ct, size: 2, units: 4 });
  });
});

describe("out of memory, and Retry at size", () => {
  it("says out of memory at 4 GB (size 1), and a maintainer's Retry at size requeues it at the size chosen, one more try", async () => {
    await seedHost("studio-o", { ...STUDIO, lanes: [{ arch: "aarch64", mode: "native" }] });
    const t = await seedTask({ name: "hungry", trust: "community", owner: "bob", params: { hint: "keep" } });
    await env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('hungry', 'bob', 'https://hungry.example', '[\"aarch64\"]', 'building')").run();
    await env.DB.prepare("UPDATE build_tasks SET max_attempts = 1 WHERE id = ?").bind(t).run();
    const c = await claim("studio-o");
    expect(c.json.task.id).toBe(t);
    const f = await call("POST", `/factory/tasks/${t}/fail`, { token: c.json.token, body: { error: "Killed (exit 137): cc1plus", oom: true } });
    expect(f.json).toMatchObject({ status: "failed" });
    expect((await taskOf(t)).error).toBe("out of memory at 4 GB (size 1) — the engine killed it: Killed (exit 137): cc1plus");
    // Who may, and what.
    expect((await call("POST", `/factory/tasks/${t}/retry`, { token: "omc_bob", body: { size: 2 } })).status).toBe(403);
    expect((await call("POST", `/factory/tasks/${t}/retry`, { token: "omc_m2", body: { size: 3 } })).json.error).toMatch(/^size: a whole number from 1 to 2 \(a contributor's build\)/);
    const r = await call("POST", `/factory/tasks/${t}/retry`, { token: "omc_m2", body: { size: 2 } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ task: t, status: "queued", size: 2, was: 1, attempts: 0, by: "m2" });
    const row = await taskOf(t);
    expect(row).toMatchObject({ status: "queued", lease_owner: null, finished_at: null });
    expect(JSON.parse(row.params)).toEqual({ hint: "keep", size: 2 });
    expect((await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'hungry'").first<any>()).status).toBe("waiting");
    const line = await env.DB.prepare("SELECT summary FROM events WHERE kind = 'build' AND json_extract(payload, '$.by') = 'm2' ORDER BY id DESC LIMIT 1").first<any>();
    expect(line.summary).toBe(`hungry for aarch64 (task ${t}): ran out of memory at size 1; queued again at size 2 by m2`);
    // The claim leases it at that size.
    expect((await claim("studio-o")).json.task).toMatchObject({ id: t, size: 2, units: 4, attempts: 1 });
    // A build that did not run out of memory is not retried this way.
    const plain = await seedTask({});
    expect((await call("POST", `/factory/tasks/${plain}/retry`, { token: "omc_m1", body: { size: 2 } })).json.code).toBe("not_oom");
  });

  it("a size no host alive runs is refused, with the largest", async () => {
    await seedHost("p1-o", P1); // size 3 at most
    const t = await seedTask({});
    await env.DB.prepare("UPDATE build_tasks SET status = 'failed', error = 'out of memory at 4 GB (size 1) — the engine killed it: x' WHERE id = ?").bind(t).run();
    expect((await call("POST", `/factory/tasks/${t}/retry`, { token: "omc_m1", body: { size: 4 } })).json).toMatchObject({ code: "too_large", largest: 3 });
  });
});

describe("a package's size, set on its page", () => {
  it("a maintainer sets its size and disk budget, the story says it, the claim uses it; cleared, factory/sizing's or the default stands", async () => {
    await env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('sized', 'bob', 'https://sized.example', '[\"aarch64\"]', 'waiting')").run();
    expect((await call("POST", "/factory/packages/sized/size", { token: "omc_bob", body: { size: 2 } })).status).toBe(403);
    expect((await call("POST", "/factory/packages/sized/size", { token: "omc_m1", body: { size: 5 } })).status).toBe(400);
    const s = await call("POST", "/factory/packages/sized/size", { token: "omc_m1", body: { size: 3, disk_gb: 90 } });
    expect(s.json).toMatchObject({ package: "sized", sizing: { size: 3, disk_gb: 90, from: "page", disk_from: "page" }, by: "m1" });
    expect((await call("GET", "/factory/packages/sized/story")).json.package.sizing).toEqual({ size: 3, disk_gb: 90, from: "page", disk_from: "page" });
    await seedHost("studio-z", { ...STUDIO, lanes: [{ arch: "aarch64", mode: "native" }] });
    const t = await seedTask({ name: "sized" });
    expect((await claim("studio-z")).json.task).toMatchObject({ id: t, size: 3, units: 6, disk_gb: 90 });
    const cleared = await call("POST", "/factory/packages/sized/size", { token: "omc_m1", body: { size: null, disk_gb: null } });
    expect(cleared.json.sizing).toEqual({ size: 1, disk_gb: 20, from: null, disk_from: null });
  });
});

describe("the pool's cap on a host (design v2 §7.2)", () => {
  it("its owner or any maintainer sets it on the site, with a reason; the claims hold to it; lowered below what it runs, nothing ends", async () => {
    const host = await seedHost("studio-cap", { ...STUDIO, lanes: [{ arch: "aarch64", mode: "native" }] });
    for (let i = 0; i < 6; i++) await seedTask({});
    expect((await call("POST", `/hosts/${host}/cap`, { session: "bob", body: { units: 3, reason: "a canary week" } })).status).toBe(403);
    expect((await call("POST", `/hosts/${host}/cap`, { token: "omc_m2", body: { units: 3, reason: "a canary week" } })).json.code).toBe("web_only");
    expect((await call("POST", `/hosts/${host}/cap`, { session: "m2", body: { units: -1, reason: "a canary week" } })).json.code).toBe("units");
    const c = await call("POST", `/hosts/${host}/cap`, { session: "m2", body: { units: 3, reason: "a canary week" } });
    expect(c.json).toMatchObject({ pool_cap_units: 3, was: null, by: "m2", line: "studio-cap of m1 capped at 3 units by m2 (was none; its count is 11): a canary week" });
    // Three units: one build and the pool jobs' unit.
    const got = await fill("studio-cap");
    expect(got).toHaveLength(1);
    // Lowered to nothing while it runs one: the lease stays, nothing new.
    await call("POST", `/hosts/${host}/cap`, { session: "m1", body: { units: 0, reason: "drain it slowly" } });
    expect((await claim("studio-cap", { leases: got.map(({ task, gen }) => ({ task, gen })) })).status).toBe(204);
    expect((await taskOf(got[0].task)).status).toBe("leased");
    // Lifted: its count again.
    const lift = await call("POST", `/hosts/${host}/cap`, { session: "m1", body: { units: null, reason: "the canary passed" } });
    expect(lift.json).toMatchObject({ pool_cap_units: null, was: 0 });
    expect(await fill("studio-cap", got.map(({ task, gen }) => ({ task, gen })))).toHaveLength(4);
    const page = await call("GET", `/hosts/${host}`, { token: "omc_m1" });
    expect(page.json.can).toMatchObject({ cap: true });
    expect(page.json.leases[0]).toMatchObject({ lane: "native", units: 2, size: 1 });
  });
});

describe("legacy registrations", () => {
  it("are selected as a host with one lane and one build: an emulated one waits T while a native one of its arch is idle, and its lease records its lane", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const legacy = async (id: string, emulated: boolean) => env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, labels, kinds, agent_status) VALUES (?, 'x86_64', 'm1', ?, 'shared', 'project', 'm1', ?, ?, '[\"build\"]', 'ok')")
      .bind(id, await sha256Hex(`omw_${id}`), new Date().toISOString(), JSON.stringify(emulated ? { emulated: true } : {})).run();
    await legacy("review-x86_64-emu", true);
    await legacy("review-x86_64-box", false);
    const t = await seedTask({ arch: "x86_64" });
    const lc = (id: string) => call("POST", "/factory/claim", { token: `omw_${id}`, body: { arch: "x86_64", version: "v1.0.2", kinds: ["build"], labels: id.endsWith("emu") ? { emulated: true } : {}, agent: "claude-code/x", agent_status: "ok" } });
    expect((await lc("review-x86_64-emu")).status).toBe(204);
    at(t0, 3.1);
    await env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id = 'review-x86_64-box'").bind(new Date().toISOString()).run();
    const c = await lc("review-x86_64-emu");
    expect(c.json.task).toMatchObject({ id: t, lane: "emulated", lease_gen: null, size: 1, units: 2 });
  });
});

describe("what the planner reads", () => {
  it("the claim's new statements by their indexes: a contributor's head through the partial index, never a scan of build_tasks", async () => {
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const scope = "c2.kind IN (SELECT value FROM json_each(?)) AND (c2.pinned_to IS NULL OR c2.pinned_to = ?)";
    const cases: [string, string, unknown[], RegExp][] = [
      ["each contributor's head", OWNER_HEADS_SQL(scope), [50, '["build"]', "w"], /USING (COVERING )?INDEX idx_build_tasks_owner_head/],
      ["every lease", LEASES_HELD_SQL, [], /SEARCH build_tasks USING INDEX idx_build_tasks_(lease|queue|kind) /],
      ["the oldest build", OLDEST_BUILD_SQL, [], /SEARCH c USING INDEX idx_build_tasks_kind /],
      ["the packages' sizes", PACKAGE_SIZES_SQL, ['["a"]'], /SEARCH factory_packages USING INDEX sqlite_autoindex_factory_packages_1|SEARCH factory_packages USING PRIMARY KEY|SEARCH factory_packages USING INDEX/],
      ["the native history", NATIVE_MS_SQL, ['[["a","x86_64"]]'], /SEARCH d USING INDEX idx_build_tasks_name /],
      ["the marked tasks still waiting", MARKED_WAITING_SQL, ["[1]"], /SEARCH build_tasks USING INTEGER PRIMARY KEY/],
    ];
    for (const [what, sql, args, want] of cases) {
      const p = await plan(sql, args);
      expect(p, what).toMatch(want);
      expect(p, what).not.toMatch(/SCAN (build_tasks|c|c2|d|t)(?! USING)/);
    }
    // The fleet: the registrations alive, a few dozen rows; the hosts by their primary key.
    expect(await plan(FLEET_SQL, ["2026-10-01T00:00:00Z"])).toMatch(/SEARCH h USING INDEX sqlite_autoindex_hosts_1|SEARCH h USING PRIMARY KEY/);
  });
});
