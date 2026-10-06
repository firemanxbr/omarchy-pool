/**
 * Pool jobs on host registrations (#340, epic #307, design v2 §7.3, §7.4,
 * §8.2, §8.6, §9.2; D34), inside workerd with a real D1:
 *
 * - pool jobs reach a host once the `host-pool-jobs` setting names it (its
 *   name or its registration's id, or `*`), never before: the rollout's
 *   order is the maintainers';
 * - a host takes the pool jobs (`HOST_KINDS`): the arch-neutral ones —
 *   sync, render, rollback, gc, verify, relayout, enqueue, publish — on any
 *   host whatever their row's arch (`ANY_ARCH_KINDS` widened for host rows,
 *   `HOST_ANY_ARCH_KINDS`), leased on no lane, each with its own scopes and
 *   its lease's generation in its job token, one unit each; a health check
 *   and a promotion only on a host with a lane of each arch their helpers
 *   check, native or emulated, with no wait;
 * - the reserved job unit: a sync runs while every build unit and every
 *   other unit holds model work, and nothing else may take that unit; a
 *   pool job leased first holds that unit, never a task's — the minimum
 *   host still runs its one build beside it, the Studio its five;
 * - the automatic rules on a host row (`autoOrder`): an agent fault leads
 *   only to `recheck-agent` — a fresh probe sidecar —, never `restart`,
 *   whatever the spell's length, where a legacy project worker is
 *   restarted.
 *
 * Tokens: workers omw_<id>; jobs the claim's.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { HOST_KINDS } from "../src/routes/factory";
import { poolJobsOn, HOST_CLAIM_SQL, POOL_JOBS_KEY } from "../src/hosts";
import { decideAuto, type ClaimFacts, type OrdersRow, type RuleInput } from "../src/orders";

const API = "http://pool.test/api/v1";
const MIN = 60000;
const hex = (n: number) => n.toString(16).padStart(32, "0");

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const claimsOf = (token: string) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { t: number; w: string; g?: string; s: string[] };

type Lane = { arch: string; mode: "native" | "emulated" };
/** A host's capacity as its dispatcher claims with it: `cpus` and `mem_gb` decide its units (one kept for pool jobs). */
const capacityOf = (cpus: number, mem_gb: number, units: number, lanes: Lane[], agent_slots = 2) => ({ cpus, mem_gb, disk_free_gb: { work: 410, engine: 220 }, units, job_reserved: 1, agent_slots, lanes });
const ARM: Lane[] = [{ arch: "aarch64", mode: "native" }];
const STUDIO: Lane[] = [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated" }];
/** What its dispatcher lists while the pool jobs' unit is free (crates/pkg-repo dispatch KINDS and jobs::POOL_KINDS). */
const DISPATCHER_KINDS = ["build", "trial", "audit", "sync", "render", "promote", "rollback", "security", "gc", "verify", "relayout", "enqueue", "publish", "health"];

let seq = 0;
interface ClaimOpts { leases?: { task: number; gen: string }[]; capacity?: unknown; kinds?: string[]; probe?: { probe: "ok" | "error"; error?: string; checked_at?: string } }
const hostBody = (o: ClaimOpts = {}) => ({
  arch: "aarch64", version: "v1.0.2", hostname: "box", kinds: o.kinds ?? DISPATCHER_KINDS,
  claim_id: `c_pj${String(++seq).padStart(10, "0")}`, want: 1, leases: o.leases ?? [], capacity: o.capacity ?? capacityOf(12, 32, 11, ARM),
  agent: { provider: "anthropic", model: "claude-test", probe: "ok", checked_at: "2026-10-01T12:00:00Z", ...(o.probe ?? {}) },
  orders: ["drain", "recheck-agent", "restart", "restart-agent", "stop-task"], instance: hex(7),
});
const claim = (id: string, o: ClaimOpts = {}) => call("POST", "/factory/claim", hostBody(o), `omw_${id}`);
const lease = (r: { json: any }) => ({ task: r.json.task.id as number, gen: r.json.task.lease_gen as string });
const taskOf = (id: number) => env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<any>();

async function seedHost(id: string) {
  const hostId = `h_${id.replace(/[^0-9a-z]/g, "").padEnd(10, "0").slice(0, 10)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, arch, worker_id, confirmed_at) VALUES (?, 'm1', 1001, ?, ?, 'active', 'aarch64', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
      .bind(hostId, id, `key-${id}`, id),
    env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, kind, host_id) VALUES (?, 'aarch64', 'm1', ?, 'shared', 'project', 'm1', ?, 'host', ?)")
      .bind(id, await sha256Hex(`omw_${id}`), new Date().toISOString(), hostId),
  ]);
}
/** A pool job as the scheduler queues it (src/scheduler.ts createJob), pinned to one registration so the other tests' hosts never take it. */
async function seedJob(kind: string, arch: string, params: Record<string, string>, pin: string, priority = 50): Promise<number> {
  return (await env.DB.prepare(`INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, priority, status, publish, trust, kind, params, pinned_to) VALUES (?, ?, '-', 'test', ?, 'queued', 1, 'project', ?, ?, ?) RETURNING id`)
    .bind(kind, arch, priority, kind, JSON.stringify(params), pin).first<{ id: number }>())!.id;
}
/** A contributor's build, a draft (model work) unless said otherwise, pinned. */
async function seedBuild(name: string, owner: string, pin: string, ref = `draft:${name}`): Promise<number> {
  return (await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, pinned_to) VALUES (?, 'aarch64', '1.2-1', ?, 'test', 100, 'queued', 0, 'community', ?, 'build', ?) RETURNING id`)
    .bind(name, ref, owner, pin).first<{ id: number }>())!.id;
}
const leasedTo = async (id: string) => (await env.DB.prepare("SELECT id, kind, units, lane FROM build_tasks WHERE status = 'leased' AND lease_owner = ? ORDER BY id").bind(id).all<{ id: number; kind: string; units: number; lane: string | null }>()).results;

beforeAll(async () => {
  const h = (t: string) => sha256Hex(t);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES ('m1', ?, ?, 'maintainer', 1001)`).bind(await h("omc_m1"), await h("oms_m1")),
  ]);
  await setPoolJobs("*");
});

/** The `host-pool-jobs` setting, as a maintainer writes it (the runbook's wrangler command); null removes it. */
async function setPoolJobs(v: string | null) {
  if (v === null) await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(POOL_JOBS_KEY).run();
  else await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(POOL_JOBS_KEY, v).run();
}

afterEach(async () => {
  vi.useRealTimers();
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE status IN ('queued', 'leased')").run();
});

describe("the rollout: pool jobs reach a host once the maintainers let them", () => {
  it("no host takes one while the host-pool-jobs setting names none of it — its name, its registration, or *", async () => {
    await seedHost("pj-gated");
    const sync = await seedJob("sync", "x86_64", { arch: "x86_64", sources: "[]" }, "pj-gated");
    const kindsOf = async () => JSON.parse((await env.DB.prepare("SELECT kinds FROM build_workers WHERE id = 'pj-gated'").first<{ kinds: string }>())!.kinds) as string[];
    for (const v of [null, "", "pj-other, studio", " , "]) {
      await setPoolJobs(v);
      expect((await claim("pj-gated")).status, `setting ${JSON.stringify(v)}`).toBe(204);
      expect((await taskOf(sync)).status).toBe("queued");
      // What it takes, as its row says it: its tasks, not the pool jobs its dispatcher lists.
      expect(await kindsOf()).toEqual(["build", "trial", "audit"]);
    }
    // By its host's name (the P1 host first)…
    await setPoolJobs("studio, pj-gated");
    const c = await claim("pj-gated");
    expect(c.json?.task?.id, JSON.stringify(c.json)).toBe(sync);
    expect(await kindsOf()).toEqual(expect.arrayContaining(["sync", "health", "promote"]));
    // … by its registration's id, and every host.
    expect(poolJobsOn("pj-gated", { worker: "pj-gated", name: "box" })).toBe(true);
    expect(poolJobsOn(" * ", { worker: "w", name: "n" })).toBe(true);
    expect(poolJobsOn("pj-gated2", { worker: "pj-gated", name: "box" })).toBe(false);
    expect(poolJobsOn(null, { worker: "pj-gated", name: "box" })).toBe(false);
    await setPoolJobs("*");
  });

  it("the setting rides the claim's one read of its host, by the settings' primary key", async () => {
    const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${HOST_CLAIM_SQL}`).bind("h_0123456789").all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    expect(plan).toMatch(/SEARCH settings USING INDEX sqlite_autoindex_settings_1 \(key=\?\)/);
    expect(plan).not.toMatch(/SCAN settings/);
  });
});

describe("the kinds a host takes (HOST_KINDS)", () => {
  it("every pool job besides builds, trials and audits — the pool's own metrics listed and never queued", () => {
    for (const k of ["build", "trial", "audit", "sync", "render", "promote", "rollback", "security", "gc", "verify", "relayout", "enqueue", "publish", "health"]) expect(HOST_KINDS, k).toContain(k);
  });

  it("an arch-neutral job of either ring arch goes to an aarch64-only host — on no lane, one unit, its own scopes and its lease's generation", async () => {
    await seedHost("pj-neutral");
    const jobs: [string, string, Record<string, string>][] = [
      ["sync", "x86_64", { arch: "x86_64", sources: "[]" }], ["render", "x86_64", { ring: "edge", arch: "x86_64" }], ["rollback", "x86_64", { ring: "edge", to: "4" }],
      ["gc", "x86_64", { keep: "3" }], ["verify", "x86_64", {}], ["relayout", "x86_64", {}], ["enqueue", "x86_64", {}], ["publish", "x86_64", { task: "7" }],
    ];
    const held: { task: number; gen: string }[] = [];
    for (const [kind, arch, params] of jobs) {
      const id = await seedJob(kind, arch, params, "pj-neutral");
      // One job at a time on the host's dispatcher: the one it holds is listed, the unit is the pool's to count.
      const c = await claim("pj-neutral", { leases: held });
      expect(c.status, `${kind}: ${JSON.stringify(c.json)}`).toBe(200);
      expect(c.json.task).toMatchObject({ id, kind, arch });
      expect(await taskOf(id)).toMatchObject({ status: "leased", lane: null, units: 1 });
      const claims = claimsOf(c.json.token);
      expect(claims).toMatchObject({ t: id, w: "pj-neutral", g: c.json.task.lease_gen });
      if (kind === "sync") expect(claims.s).toEqual(expect.arrayContaining(["pool:write", "release:edge", "events"]));
      if (kind === "render") expect(claims.s).toContain("artifacts:*:edge");
      held.push(lease(c));
    }
    // Eight one-unit jobs on 11 units: the pool counts them as units like any lease.
    expect((await leasedTo("pj-neutral")).reduce((n, t) => n + t.units, 0)).toBe(8);
  });

  it("a health check and a promotion need a lane of each arch their helpers check, native or emulated, with no wait", async () => {
    await seedHost("pj-arm");
    await seedHost("pj-studio");
    const h86 = await seedJob("health", "x86_64", { ring: "rc", arch: "x86_64" }, "pj-arm");
    const p86 = await seedJob("promote", "x86_64", { from: "rc", to: "stable" }, "pj-arm");
    const hArm = await seedJob("health", "aarch64", { ring: "rc", arch: "aarch64" }, "pj-arm");
    // An aarch64-only host: its own ring's health check; neither the x86_64 one nor a promotion that checks both.
    const c = await claim("pj-arm");
    expect(c.json.task.id).toBe(hArm);
    expect(await taskOf(hArm)).toMatchObject({ lane: "native", units: 1 });
    expect((await claim("pj-arm", { leases: [lease(c)] })).status).toBe(204);
    expect((await taskOf(h86)).status).toBe("queued");
    expect((await taskOf(p86)).status).toBe("queued");
    // The Studio, x86_64 emulated: the x86_64 health check at once, on its emulated lane, and the promotion of both.
    const s86 = await seedJob("health", "x86_64", { ring: "rc", arch: "x86_64" }, "pj-studio");
    const sp = await seedJob("promote", "x86_64", { from: "rc", to: "stable" }, "pj-studio", 60);
    const s1 = await claim("pj-studio", { capacity: capacityOf(12, 32, 11, STUDIO) });
    expect(s1.json.task.id).toBe(s86);
    expect(await taskOf(s86)).toMatchObject({ lane: "emulated", units: 1 });
    const s2 = await claim("pj-studio", { capacity: capacityOf(12, 32, 11, STUDIO), leases: [lease(s1)] });
    expect(s2.json.task.id).toBe(sp);
    expect((await taskOf(sp)).lane).toBeNull();
  });
});

describe("the reserved job unit", () => {
  it("a sync runs while every build unit and every other unit holds model work, and nothing else takes that unit", async () => {
    // Five units (6 CPUs, 12 GB), one kept for pool jobs: two drafts — model builds of two units each — hold the other four.
    await seedHost("pj-full");
    const cap = capacityOf(6, 12, 5, ARM, 2);
    const d1 = await seedBuild("felix", "bob", "pj-full");
    const d2 = await seedBuild("gus", "dave", "pj-full");
    const held: { task: number; gen: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await claim("pj-full", { capacity: cap, leases: held });
      expect(c.status, JSON.stringify(c.json)).toBe(200);
      held.push(lease(c));
    }
    expect(held.map((l) => l.task).sort()).toEqual([d1, d2].sort());
    // Queued meanwhile: an audit (model work), a plain build, and the sync.
    const audit = (await env.DB.prepare(`INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, priority, status, publish, trust, kind, params, pinned_to) VALUES ('felix', 'aarch64', ?, 'test', 10, 'queued', 0, 'project', 'audit', ?, 'pj-full') RETURNING id`)
      .bind(`staging:${d1}`, JSON.stringify({ task: d1 })).first<{ id: number }>())!.id;
    const build = await seedBuild("hal", "erin", "pj-full", "https://github.com/erin/hal@v1:PKGBUILD");
    const sync = await seedJob("sync", "x86_64", { arch: "x86_64", sources: "[]" }, "pj-full", 90);
    const c = await claim("pj-full", { capacity: cap, leases: held });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.task.id).toBe(sync);
    held.push(lease(c));
    expect((await leasedTo("pj-full")).map((t) => [t.kind, t.units])).toEqual([["build", 2], ["build", 2], ["sync", 1]]);
    // Every unit held now, the pool jobs' too: nothing more, the audit and the build wait.
    expect((await claim("pj-full", { capacity: cap, leases: held })).status).toBe(204);
    expect((await taskOf(audit)).status).toBe("queued");
    expect((await taskOf(build)).status).toBe("queued");
    // And the unit kept for pool jobs is never a task's: with the sync done, the build still waits.
    expect((await call("POST", `/factory/tasks/${sync}/complete`, { summary: "synced", result: {} }, c.json.token)).status).toBe(200);
    expect((await claim("pj-full", { capacity: cap, leases: held.slice(0, 2) })).status).toBe(204);
    expect((await taskOf(build)).status).toBe("queued");
  });
});

describe("a pool job holds the kept unit, never a task's (#340, design v2 §7.3)", () => {
  /** What its dispatcher lists while it holds a pool job: its tasks, none of the pool's kinds (one job at a time). */
  const TASKS_ONLY = ["build", "trial", "audit"];

  it("the minimum host (3 units) still starts its one build beside a sync leased first, and nothing more", async () => {
    await seedHost("pj-min");
    const cap = capacityOf(4, 8, 3, ARM);
    const sync = await seedJob("sync", "x86_64", { arch: "x86_64", sources: "[]" }, "pj-min");
    const build = await seedBuild("ivy", "fay", "pj-min", "https://github.com/fay/ivy@v1:PKGBUILD");
    const c1 = await claim("pj-min", { capacity: cap });
    expect(c1.json?.task?.id, JSON.stringify(c1.json)).toBe(sync);
    // The sync runs for up to 150 min: the build does not wait for it — its claim's room, selection and the lease's own statement agree.
    const c2 = await claim("pj-min", { capacity: cap, leases: [lease(c1)], kinds: TASKS_ONLY });
    expect(c2.status, JSON.stringify(c2.json)).toBe(200);
    expect(c2.json.task.id).toBe(build);
    expect((await leasedTo("pj-min")).map((t) => [t.kind, t.units])).toEqual([["sync", 1], ["build", 2]]);
    // Every unit held: another build and an audit wait.
    const more = await seedBuild("jay", "gil", "pj-min", "https://github.com/gil/jay@v1:PKGBUILD");
    expect((await claim("pj-min", { capacity: cap, leases: [lease(c1), lease(c2)], kinds: TASKS_ONLY })).status).toBe(204);
    expect((await taskOf(more)).status).toBe("queued");
  });

  it("the Studio (11 units) starts five builds beside a job leased first; the sixth waits", async () => {
    await seedHost("pj-five");
    const cap = capacityOf(12, 32, 11, ARM);
    const verify = await seedJob("verify", "x86_64", {}, "pj-five");
    const builds: number[] = [];
    for (const n of ["a", "b", "c", "d", "e", "f"]) builds.push(await seedBuild(`k${n}`, `owner-${n}`, "pj-five", `https://github.com/owner-${n}/k${n}@v1:PKGBUILD`));
    const c = await claim("pj-five", { capacity: cap });
    expect(c.json?.task?.id, JSON.stringify(c.json)).toBe(verify);
    const held = [lease(c)];
    for (let i = 0; i < 5; i++) {
      const b = await claim("pj-five", { capacity: cap, leases: held, kinds: TASKS_ONLY });
      expect(b.status, `build ${i + 1}: ${JSON.stringify(b.json)}`).toBe(200);
      expect(b.json.task.kind).toBe("build");
      held.push(lease(b));
    }
    expect((await claim("pj-five", { capacity: cap, leases: held, kinds: TASKS_ONLY })).status).toBe(204);
    const leased = await leasedTo("pj-five");
    expect(leased.filter((t) => t.kind === "build")).toHaveLength(5);
    expect(leased.reduce((n, t) => n + t.units, 0)).toBe(11);
  });
});

describe("the automatic rules on a host row (autoOrder)", () => {
  it("an agent fault leads only to recheck-agent — a fresh probe sidecar —, never a restart, however long it lasts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await seedHost("pj-faulty");
    const t0 = Date.now();
    const got: { t: number; kind: string }[] = [];
    // An hour of claims every 30 s, its probe refused throughout (a restart could help a legacy worker's: connection refused).
    for (let s = 0; s <= 120; s++) {
      const t = t0 + s * 30000;
      vi.setSystemTime(t);
      const r = await claim("pj-faulty", { probe: { probe: "error", error: "URLError: <urlopen error [Errno 111] Connection refused>", checked_at: new Date(t0).toISOString() } });
      for (const o of r.json?.orders ?? []) {
        got.push({ t, kind: o.kind });
        // The dispatcher answers a re-check with a fresh probe sidecar's word: it still fails.
        await call("POST", `/factory/workers/self/orders/${o.id}`, { instance: hex(7), outcome: "failed", code: "probe-failed", detail: "connection refused" }, "omw_pj-faulty");
      }
    }
    expect(got.map((g) => g.kind)).toEqual(["recheck-agent"]);
    expect(got[0].t - t0).toBeGreaterThanOrEqual(5 * MIN);
    const view = (await call("GET", "/factory/workers/pj-faulty")).json.worker;
    expect(view.pool_waits ?? "").toContain("re-checks it, never restarts");
  });

  it("decideAuto: a host's spell gets the re-check and nothing more, where the same spell restarts a legacy worker", () => {
    const at = (m: number) => new Date(Date.parse("2026-10-01T12:00:00Z") + m * MIN).toISOString();
    const row = { id: "w", owner: "m1", trust: "project", site: null, instance: hex(1), instance_since: at(-30), agent_status: "error", agent_error: "URLError: [Errno 111] Connection refused", agent_checked_at: "p0", agent_probed_at: at(-20), agent_error_since: at(0), agent_via: "direct", auto_orders: null, open_orders: null, drained_at: null } as unknown as OrdersRow;
    const claim = { takes: ["drain", "recheck-agent", "restart", "restart-agent"], agent_via: "direct", probe: { status: "error", error: "URLError: [Errno 111] Connection refused", checked_at: "p0" } } as unknown as ClaimFacts;
    const input = (o: Partial<RuleInput> = {}): RuleInput => ({ row, claim, status: "error", error: "URLError: [Errno 111] Connection refused", spell: at(0), instanceSince: at(-30), conflict: false, needsAgent: true, ...o });
    const now = Date.parse(at(0));
    expect(decideAuto(input({ host: true }), now + 5 * MIN).kind).toBe("recheck-agent");
    // Its re-check made, later in the spell: a legacy project worker is restarted, a host's is not — nor through a sibling's agent service.
    const after = { ...row, auto_orders: JSON.stringify({ spell: at(0), rechecks: 1, restarts: 0, last_recheck: at(5), last_restart: null, gave_up: null, day: [{ k: "c", at: at(5) }] }) } as OrdersRow;
    expect(decideAuto(input({ row: after }), now + 40 * MIN).kind).toBe("restart");
    expect(decideAuto(input({ row: after, host: true }), now + 40 * MIN)).toMatchObject({ kind: null, why: expect.stringContaining("never restarts") });
    expect(decideAuto(input({ row: after, host: true, claim: { ...claim, agent_via: "sibling" } as ClaimFacts }), now + 40 * MIN).kind).toBeNull();
    for (const m of [60, 600, 6000]) expect(decideAuto(input({ row: after, host: true }), now + m * MIN).kind, `${m} min`).toBeNull();
  });
});
