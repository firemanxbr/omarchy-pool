/**
 * Emulated lanes through the Worker (#338, epic #307, design v2 §7.4, §7.5,
 * §8.6; D33, S6), inside workerd with a real D1 — `needs_native` decided
 * per lane, not per registration:
 *
 * - a `needs_native` from a lease on an emulated lane requeues its task
 *   without spending the attempt, and that task never goes to an emulated
 *   lane again — the same host's or another's, however long it waits — while
 *   a native host takes it at once;
 * - a `needs_native` from a native lane is refused: a failure like any other,
 *   its attempt spent, no mark — on a host that also runs an emulated lane,
 *   and whatever the registration's labels say (a host's are never read);
 * - a legacy registration's lease keeps today's word: its lane, written at
 *   the claim from its labels, and for a lease taken before the claim wrote
 *   lanes, its labels;
 * - the claim takes a host's emulated lanes with how they run (`via`,
 *   `page16k`) and its held lanes with their reasons, for the host page;
 * - a job with helper containers is read by the claim's statements where
 *   selection needs it — a health check on the head of its ring's arch, a
 *   promotion beside the arch-neutral kinds with the arch it names — and an
 *   aarch64 host's emulated x86_64 lane takes the x86_64 health check at once;
 *   hosts claim pool jobs since #340 (HOST_KINDS), so the claim itself hands
 *   the Studio that health check, on its emulated lane.
 *
 * Tokens: workers omw_<id>, jobs the claim's.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { parseCapacity, unitsOf, HELD_REASON_MAX } from "../src/hosts";
import { HOST_KINDS, LANE_HEAD_SQL, NEUTRAL_HEAD_SQL, selectionRules } from "../src/routes/factory";
import { select, type Candidate, type Fleet, type Lane as SelLane, type Member } from "../src/selection";
import { toB64url } from "../src/webauthn";

const ORIGIN = "http://localhost:8787";
const MIN = 60000;

interface Res { status: number; json: any }
async function call(method: string, path: string, o: { token?: string; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

type Lane = { arch: string; mode: "native" | "emulated"; via?: string; page16k?: boolean };
interface Box { cpus: number; mem_gb: number; lanes: Lane[] }
const capOf = (b: Box) => ({ cpus: b.cpus, mem_gb: b.mem_gb, disk_free_gb: { work: 410, engine: 220 }, units: unitsOf({ cpus: b.cpus, mem_gb: b.mem_gb, units: null }), job_reserved: 1, agent_slots: 2, lanes: b.lanes });
/** The Studio: aarch64 native, x86_64 emulated through qemu on 16K pages. */
const STUDIO: Box = { cpus: 12, mem_gb: 32, lanes: [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated", via: "qemu", page16k: true }] };
const VPS86: Box = { cpus: 8, mem_gb: 16, lanes: [{ arch: "x86_64", mode: "native" }] };

const boxes = new Map<string, Box>();
let hostSeq = 0;
/** A maintainer host, active, with its registration, alive now; `labels` what its registration's row says (a host's are never read). */
async function seedHost(id: string, b: Box, labels: unknown = null): Promise<void> {
  const hostId = `h_e${String(++hostSeq).padStart(9, "0")}`;
  const cap = capOf(b);
  const native = b.lanes.find((l) => l.mode === "native")!.arch;
  boxes.set(id, b);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, arch, capacity, lanes, units, agent_slots, disk_free, worker_id, confirmed_at, last_seen)
                    VALUES (?, 'm1', 1001, ?, ?, 'active', ?, ?, ?, ?, 2, ?, ?, ?, ?)`)
      .bind(hostId, id, toB64url(crypto.getRandomValues(new Uint8Array(32))), native, JSON.stringify({ ...cap, below_minimum: null }), JSON.stringify(b.lanes), unitsOf(cap), JSON.stringify(cap.disk_free_gb), id, new Date().toISOString(), new Date().toISOString()),
    env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, kind, host_id, kinds, agent_status, labels) VALUES (?, ?, 'm1', ?, 'shared', 'project', 'm1', ?, 'host', ?, '[\"build\",\"trial\",\"audit\"]', 'ok', ?)")
      .bind(id, native, await sha256Hex(`omw_${id}`), new Date().toISOString(), hostId, labels === null ? null : JSON.stringify(labels)),
  ]);
}

let seq = 0;
/** A claim as the host's dispatcher sends it, listing what it holds. */
const claim = (id: string, leases: { task: number; gen: string }[] = []) => {
  const b = boxes.get(id)!;
  return call("POST", "/factory/claim", { token: `omw_${id}`, body: {
    arch: b.lanes.find((l) => l.mode === "native")!.arch, version: "v1.0.2", hostname: id, kinds: ["build", "trial", "audit"], claim_id: `c_emu${String(++seq).padStart(8, "0")}`, want: 1,
    leases, capacity: capOf(b), labels: { role: "dispatcher" }, agent: { provider: "anthropic", model: "claude-test", probe: "ok", checked_at: "2026-10-01T00:00:00Z" },
  } });
};

/** A queued build, `ago` minutes old. */
async function seedTask(t: { arch: string; params?: unknown; ago?: number }): Promise<number> {
  const name = `emu${++seq}`;
  return (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, kind, params, created_at) VALUES (?, ?, '1.0-1', ?, 'test', 100, 'queued', 0, 'project', 'build', ?, ?) RETURNING id`,
  ).bind(name, t.arch, `https://github.com/x/${name}@v1:PKGBUILD`, t.params === undefined ? null : JSON.stringify(t.params), new Date(Date.now() - (t.ago ?? 0) * MIN).toISOString())
    .first<{ id: number }>())!.id;
}
const taskOf = (id: number) => env.DB.prepare("SELECT status, attempts, lane, lease_owner, priority, params FROM build_tasks WHERE id = ?").bind(id).first<any>();
const lastBuildEvent = () => env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'build' ORDER BY id DESC LIMIT 1").first<{ status: string; summary: string; payload: string }>();
const rustc = "exit 96: rustc cannot start on this worker: emulated x86_64 under qemu on a host whose page size is not the guest's — a native worker is needed for this package";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES ('m1', ?, ?, 'maintainer', 1001)`).bind(await sha256Hex("omc_m1"), await sha256Hex("oms_m1")),
  ]);
});

afterEach(async () => {
  vi.useRealTimers();
  await env.DB.batch([
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE status IN ('queued', 'leased')"),
    env.DB.prepare("UPDATE build_workers SET last_seen = '2000-01-01T00:00:00.000Z'"),
  ]);
});

describe("needs_native per lane (#338, design v2 §8.6)", () => {
  it("from an emulated lane it requeues the task without spending its attempt, and the task never goes to an emulated lane again; a native host takes it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    // The Studio's x86_64 lane takes the build: no native x86_64 host alive, T passed.
    await seedHost("studio-1", STUDIO);
    const id = await seedTask({ arch: "x86_64", params: { hint: "use cargo" }, ago: 10 });
    const c = await claim("studio-1");
    expect(c.json.task).toMatchObject({ id, lane: "emulated", attempts: 1 });
    // The build container's toolchain probe: rustc cannot start under qemu on 16K pages (D33).
    const f = await call("POST", `/factory/tasks/${id}/fail`, { token: c.json.token, body: { error: rustc, duration_ms: 30000, final: false, needs_native: true } });
    expect(f.json).toEqual({ task: id, status: "queued", attempts: 0 });
    const row = await taskOf(id);
    expect(row).toMatchObject({ status: "queued", attempts: 0, lease_owner: null });
    expect(JSON.parse(row.params)).toEqual({ hint: "use cargo", needs_native: 1 });
    const e = (await lastBuildEvent())!;
    expect(e.summary).toMatch(/^emu\d+ for x86_64 on studio-1 needs a native x86_64 worker — back in the queue for one/);
    expect(JSON.parse(e.payload)).toMatchObject({ needs_native: true, attempts: 0 });
    // Never an emulated lane again: the Studio's, now and an hour and a half on, nor another host's.
    expect((await claim("studio-1", [])).status).toBe(204);
    vi.setSystemTime(t0 + 90 * MIN);
    expect((await claim("studio-1")).status).toBe(204);
    await seedHost("studio-2", STUDIO);
    expect((await claim("studio-2")).status).toBe(204);
    // A native x86_64 host takes it at once, the attempt its first.
    await seedHost("vps-1", VPS86);
    const n = await claim("vps-1");
    expect(n.json.task).toMatchObject({ id, lane: "native", attempts: 1, params: { hint: "use cargo", needs_native: 1 } });
  });

  it("from a native lane it is refused — a failure like any other, its attempt spent and no mark — on a host that also runs an emulated lane, whatever its registration's labels say", async () => {
    // The registration's row says emulated (a stale label): a host's lane is its lease's, never its labels.
    await seedHost("studio-3", STUDIO, { emulated: true });
    const id = await seedTask({ arch: "aarch64" });
    const c = await claim("studio-3");
    expect(c.json.task).toMatchObject({ id, lane: "native", attempts: 1 });
    const f = await call("POST", `/factory/tasks/${id}/fail`, { token: c.json.token, body: { error: "exit 96: rustc cannot start on this worker", final: false, needs_native: true } });
    expect(f.json).toEqual({ task: id, status: "queued", attempts: 1 });
    const row = await taskOf(id);
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row.params).toBeNull();
    const e = (await lastBuildEvent())!;
    expect(e.summary).toMatch(/failed on studio-3 \(attempt 1\/3\) \(its needs_native refused: it ran on the native lane\) — back in the queue/);
    expect(JSON.parse(e.payload)).toMatchObject({ needs_native: false, needs_native_refused: true, lane: "native" });
    // Not marked: the same native lane takes it again.
    const again = await claim("studio-3");
    expect(again.json.task).toMatchObject({ id, lane: "native", attempts: 2 });
    // And on its last attempt the refused word does not save it.
    await env.DB.prepare("UPDATE build_tasks SET attempts = max_attempts WHERE id = ?").bind(id).run();
    const last = await call("POST", `/factory/tasks/${id}/fail`, { token: again.json.token, body: { error: "exit 96", final: false, needs_native: true } });
    expect(last.json).toMatchObject({ task: id, status: "failed" });
  });

  it("a legacy registration's lease keeps its word: the lane its claim wrote from its labels, or for a lease from before lanes, its labels", async () => {
    await env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES ('rev-x86', 'x86_64', 'm1', ?, 'shared', 'project', 'm1', ?), ('rev-arm', 'aarch64', 'm1', ?, 'shared', 'project', 'm1', ?)")
      .bind(await sha256Hex("omw_rev-x86"), new Date().toISOString(), await sha256Hex("omw_rev-arm"), new Date().toISOString()).run();
    const agent = { agent: "anthropic/claude-sonnet-5", agent_status: "ok" };
    const emu = { arch: "x86_64", kinds: ["build"], labels: { where: "omarchy-studio", emulated: true, role: "review" }, ...agent };
    const nat = { arch: "aarch64", kinds: ["build"], labels: { where: "omarchy-studio", role: "review" }, ...agent };
    // The Studio's review-x86_64: its claim writes the emulated lane, and its needs_native counts.
    const a = await seedTask({ arch: "x86_64", ago: 10 });
    const c = await call("POST", "/factory/claim", { token: "omw_rev-x86", body: emu });
    expect(c.json.task).toMatchObject({ id: a, lane: "emulated", lease_gen: null });
    expect((await call("POST", `/factory/tasks/${a}/fail`, { token: c.json.token, body: { error: rustc, final: false, needs_native: true } })).json).toEqual({ task: a, status: "queued", attempts: 0 });
    // A lease taken before the claim wrote lanes (lane NULL): the registration's labels, as before.
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(a).run();
    const b = await seedTask({ arch: "x86_64", ago: 10 });
    const c2 = await call("POST", "/factory/claim", { token: "omw_rev-x86", body: emu });
    expect(c2.json.task.id).toBe(b);
    await env.DB.prepare("UPDATE build_tasks SET lane = NULL WHERE id = ?").bind(b).run();
    expect((await call("POST", `/factory/tasks/${b}/fail`, { token: c2.json.token, body: { error: rustc, final: false, needs_native: true } })).json).toEqual({ task: b, status: "queued", attempts: 0 });
    // A native legacy worker's word is refused, its lane native.
    const d = await seedTask({ arch: "aarch64" });
    const c3 = await call("POST", "/factory/claim", { token: "omw_rev-arm", body: nat });
    expect(c3.json.task).toMatchObject({ id: d, lane: "native" });
    expect((await call("POST", `/factory/tasks/${d}/fail`, { token: c3.json.token, body: { error: "exit 96", final: false, needs_native: true } })).json).toEqual({ task: d, status: "queued", attempts: 1 });
    await env.DB.prepare("UPDATE build_workers SET revoked_at = '2026-01-01T00:00:00Z' WHERE id IN ('rev-x86', 'rev-arm')").run();
  });
});

describe("a host's lanes as its capacity reports them (#338, design v2 §7.3, §17.2)", () => {
  it("keeps how each emulated lane runs and the held lanes with their reasons, leaving out what does not read", () => {
    const c = parseCapacity({
      ...capOf(STUDIO),
      held_lanes: [
        { arch: "x86_64", reason: "needs a person: prep-root.sh installs qemu-user-static-binfmt (no qemu-x86_64 handler)" },
        { arch: "riscv64", reason: "not ours" },
        { arch: "aarch64", reason: "" },
        { arch: "aarch64", reason: "x".repeat(HELD_REASON_MAX + 50) },
        // At most four are read.
        { arch: "x86_64", reason: "a fifth" },
      ],
    });
    if (typeof c === "string") throw new Error(c);
    expect(c.lanes).toEqual([{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated", via: "qemu", page16k: true }]);
    expect(c.held_lanes).toEqual([
      { arch: "x86_64", reason: "needs a person: prep-root.sh installs qemu-user-static-binfmt (no qemu-x86_64 handler)" },
      { arch: "aarch64", reason: "x".repeat(HELD_REASON_MAX) },
    ]);
    // A capacity without them (an agent from before #338): none.
    const old = parseCapacity(capOf(VPS86));
    if (typeof old === "string") throw new Error(old);
    expect(old.held_lanes).toEqual([]);
  });

  it("a claim whose emulated lane says how it runs is taken, and its x86_64 lease is on that lane", async () => {
    await seedHost("studio-4", STUDIO);
    const id = await seedTask({ arch: "x86_64", ago: 10 });
    const c = await claim("studio-4");
    expect(c.status).toBe(200);
    expect(c.json.task).toMatchObject({ id, lane: "emulated" });
  });
});

describe("a job with helper containers on a host's lanes (#338, design v2 §7.4, §8.3)", () => {
  /** A pool job as the scheduler queues one (scheduler.ts createJob). */
  const seedJob = async (kind: string, arch: string, params: Record<string, string>) =>
    (await env.DB.prepare(`INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, priority, status, publish, trust, kind, params) VALUES (?, ?, '-', 'test', 50, 'queued', 1, 'project', ?, ?) RETURNING id`)
      .bind(kind, arch, kind, JSON.stringify(params)).first<{ id: number }>())!.id;
  /** A host of the fleet, alive and idle, taking the pool jobs #340 gives hosts. */
  const member = (id: string, lanes: SelLane[], now: number): Member => ({
    id, legacy: false, lanes, units: 11, agent_slots: 2, disk: { work: 400, engine: 200 }, kinds: [...HOST_KINDS, "health", "promote"], probe_ok: true,
    drained: false, below_minimum: false, may_claim: true, behind: false, seen_at: now, reserving: null, scope: { trust: "host" },
  });

  it("the claim's reads bring a health check to the head of its ring's arch and a promotion with the arch it names; the Studio's emulated lane takes the x86_64 health check at once, a host with no x86_64 lane neither", async () => {
    const health = await seedJob("health", "x86_64", { ring: "stable" });
    const promote86 = await seedJob("promote", "x86_64", { from: "rc", to: "stable", arch: "x86_64" });
    const promoteBoth = await seedJob("promote", "x86_64", { from: "rc", to: "stable" });
    // The claim's own scope (kinds and pin), as selectAndLease writes it for a host claiming them.
    const scope = "c.kind IN (SELECT value FROM json_each(?)) AND (c.pinned_to IS NULL OR c.pinned_to = ?)";
    const kinds = JSON.stringify([...HOST_KINDS, "health", "promote"]);
    const read = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).all<any>()).results;
    const x86Head = await read(LANE_HEAD_SQL(scope), "x86_64", kinds, "studio-h");
    const armHead = await read(LANE_HEAD_SQL(scope), "aarch64", kinds, "studio-h");
    const neutral = await read(NEUTRAL_HEAD_SQL(scope), kinds, "studio-h");
    // The health check by its ring's arch, on that lane's head only; the promotions with the arches their helpers run.
    expect(x86Head.map((r) => [r.id, r.kind, r.job_arch])).toEqual([[health, "health", null]]);
    expect(armHead).toEqual([]);
    expect(neutral.map((r) => [r.id, r.job_arch])).toEqual([[promote86, "x86_64"], [promoteBoth, null]]);

    // Selection over those very rows: the Studio (aarch64 native, x86_64 emulated) beside an idle native x86_64 host that is alive.
    const now = Date.now();
    const asCandidate = (r: any): Candidate => ({
      id: r.id, name: r.name, kind: r.kind, arch: r.arch, trust: r.trust, owner: r.owner, priority: r.priority, queued_at: Date.parse(r.created_at), pinned_to: r.pinned_to,
      needs_native: r.needs_native === 1, model: r.model === 1, size: null, disk_gb: null, native_ms: null, reserved_at: null, job_arch: r.job_arch,
    });
    const cands = [...x86Head, ...neutral].map(asCandidate);
    const studio = member("studio-h", [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated" }], now);
    const box = member("vps-h", [{ arch: "x86_64", mode: "native" }], now);
    const plain = member("arm-h", [{ arch: "aarch64", mode: "native" }], now);
    const fleet: Fleet = { members: [studio, box, plain], leases: [] };
    const chosen = (m: Member) => select(m, fleet, cands, now, selectionRules()).map((c) => [c.id, c.lane]);
    expect(chosen(studio)).toEqual(expect.arrayContaining([[health, "emulated"], [promote86, null], [promoteBoth, null]]));
    expect(chosen(studio)).toHaveLength(3);
    // A host with no x86_64 lane: no x86_64 health check, and no promotion whose helpers check x86_64 (one without params.arch checks both).
    expect(chosen(plain)).toEqual([]);

    // The claim itself: hosts take pool jobs since #340 (HOST_KINDS) once the maintainers let them (the host-pool-jobs setting) — the
    // Studio's dispatcher is handed the x86_64 health check, on its emulated lane, the job running in its own process and the check's
    // container through omarchy-task-run.
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('host-pool-jobs', 'studio-5')").run();
    await seedHost("studio-5", STUDIO);
    const c = await call("POST", "/factory/claim", { token: "omw_studio-5", body: {
      arch: "aarch64", version: "v1.0.2", hostname: "studio-5", kinds: ["build", "trial", "audit", "health", "promote"], claim_id: "c_emuhelp0001", want: 1,
      leases: [], capacity: capOf(STUDIO), labels: { role: "dispatcher" }, agent: { provider: "anthropic", model: "claude-test", probe: "ok", checked_at: "2026-10-01T00:00:00Z" },
    } });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(HOST_KINDS).toEqual(expect.arrayContaining(["build", "trial", "audit", "health", "promote"]));
    expect(c.json.task.id).toBe(health);
    expect(await taskOf(health)).toMatchObject({ status: "leased", lane: "emulated" });
  });
});
