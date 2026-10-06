/**
 * Selection with no database (#337, src/selection.ts; design v2 §8.3; D30,
 * D31, D50, D51): simulated fleets on a fake clock, minute by minute. Every
 * minute the leases whose time is up end (a native build's duration is the
 * history T is drawn from), then every registration alive claims as its
 * dispatcher would — again at once while it was handed a task — and is
 * handed the first choice of `select` over the candidates the claim's
 * bounded reads bring (routes/factory.ts selectAndLease, mirrored here on
 * the whole queue: each lane's head, the arch-neutral head, each
 * contributor's first build, the first native task, the reserved one, each
 * bounded and filtered by what the claimer can take now); at a host's claim
 * the reservation is decided as the claim decides it, over the oldest builds
 * it reads. The fleets:
 *
 * - native only: a host runs its full unit count at once, the rest waits
 *   in the queue and starts as units free up; the reserved job unit is
 *   never a build's or an audit's, a pool job's it is;
 * - emulated only: an aarch64 host fills all but one of its builds with
 *   x86_64 builds; native work arriving starts at the next free build and
 *   gets half the builds as they free up;
 * - mixed: an x86_64 task goes to a native x86_64 host when one is
 *   eligible, to an emulated lane after T — twice the last native duration,
 *   3 to 60 minutes — or at once when none is; `needs_native` never runs
 *   emulated;
 * - a continuous aarch64 backlog with x86_64 arrivals on an aarch64-only
 *   fleet: x86_64 tasks still start (the guaranteed emulated share),
 *   however far the backlog runs past the bound a claim reads;
 * - one contributor flooding the queue: another's single package is not
 *   delayed by more than one build, the per-owner cap holds, and a capped
 *   flood longer than the bound hides no project build;
 * - a head of tasks the claimer cannot take now (model work while its
 *   agent slots are full, size-4 builds beyond its free units) hides none
 *   it can;
 * - a size-4 task on busy hosts: the reservation starts it within its
 *   window, whatever older build waits for another reason; its two hours
 *   spent, it is not marked again for 30 minutes, then is, and starts when
 *   its host ran a build longer than the window; a reserving host whose free
 *   units reach the task takes other work while it cannot lease it (its
 *   owner's cap, the claim's memory offer), the task first when it can,
 *   and one whose claim cannot take the task (its probe failing, builds
 *   held for disk) takes other work, whatever its free units; one
 *   larger than every host alive is clamped; an emulated one of any size
 *   starts when the emulated lanes hold nothing; a claim's memory offer
 *   bounds that claim only;
 * - a drained, below-minimum, suspended or behind native host never makes an
 *   emulated lane wait;
 * - a host that sleeps (#329) has zero free units: it takes nothing, makes
 *   no emulated lane wait and leaves the guaranteed share to one that runs
 *   its arch emulated, keeps no reservation mark and counts in no size or
 *   cap; awake again, it takes what waited at once;
 * - a host whose dispatcher applies a sandbox (#330, D43): its emulated
 *   lane takes the project's own recipe only, never what a contributor
 *   wrote — that runs on a native lane, or on a host without a sandbox;
 * - a legacy registration as a host with one lane and one build;
 * - placement (#339, D35, D36), on fleets of maintainers' hosts with the
 *   models their claims say: the project's copy of a maintainer's package
 *   never on that maintainer's host while another maintainer's has a lane
 *   allowed for it (an emulated one counts, at once; `needs_native` applied),
 *   held from the first minute when one maintainer's hosts are all there is,
 *   or when no other maintainer's host could ever hold it (its size, its pool
 *   cap, its disk) or it sleeps, while one only busy is waited for (its disk
 *   filled by its builds, below the minimum for that alone, its builds held
 *   back for disk), and taken at the next claim once released; pins to a
 *   host registration; with one provider an audit leaves the builder's
 *   machine to another that can take it now — never to one that sleeps —,
 *   with two a publish-bound audit takes the other model however long that
 *   host is busy, and a host with another model seen in the last 24 hours
 *   holds it until the day is up, a head of them hiding no other audit; each
 *   audit's independence as its lease records it, of the machine (one
 *   maintainer's legacy role containers are one); and a review rebuild and
 *   its audit placed across two maintainers' hosts.
 */
import { describe, expect, it } from "vitest";
import {
  alive, apart, auditElsewhere, buildsOf, contributorsCode, cooling, diskOf, helperArches, independenceOf, largestSize, mayRun, nativeCapacity, needsOtherModel, noRoom, otherModels, ownerCap, ownersLeased, placementOf, requesterHost, reserve, roomOf, select, sizeOf, takes, thresholdMs, unitsOf,
  ALIVE_MS, ELSEWHERE_MS, HELPER_KINDS, LANE_KINDS, MIN, MODEL_WINDOW_MS, RING_ARCHES, OWNER_DIVISOR, RESERVE_AFTER_MS, RESERVE_FOR_MS, T_MAX_MS, T_MIN_MS,
  type Candidate, type Fleet, type Held, type Independence, type Machine, type Member, type Mode,
} from "../src/selection";
import { selectionRules, HEAD_LIMIT, OWNERS_LIMIT, RESERVE_CANDIDATES, RESERVE_WINDOW } from "../src/routes/factory";
import { readSizing, shippedSizing } from "../src/sizing";
import { BUILD_GB_PER_SIZE, COMMUNITY_MAX_SIZE, DISK_FLOOR_GB, EMULATED_SHARE, MAX_SIZE, TASK_UNITS } from "../src/hosts";

const R = selectionRules();
const T0 = Date.parse("2026-10-01T00:00:00.000Z");

/** A host registration: its native lane, the lanes it runs emulated, its units as the pool counts them; its host is a machine of its own. */
function host(id: string, arch: string, units: number, o: Partial<Member> & { emulated?: string[] } = {}): Member {
  const { emulated = [], ...rest } = o;
  return {
    id, legacy: false, lanes: [{ arch, mode: "native" }, ...emulated.map((a) => ({ arch: a, mode: "emulated" as Mode }))], units, agent_slots: 2,
    disk: { work: 400, engine: 200 }, kinds: ["build", "trial", "audit", "sync", "health"], probe_ok: true, drained: false, below_minimum: false, may_claim: true, behind: false,
    seen_at: T0, reserving: null, scope: { trust: "host" }, host_id: `h_${id}`, ...rest,
  };
}

/** The machine a registration runs on, as an audit of what it built carries it (routes/factory.ts placementCols). */
const machineOf = (m: Member): Machine => ({ owner: m.owner ?? null, host_id: m.host_id ?? null });

/** A legacy registration: one lane, its arch, emulated when its labels say so. */
function legacy(id: string, arch: string, o: Partial<Member> & { emulated?: boolean; trust?: "project" | "community" } = {}): Member {
  const { emulated = false, trust = "project", ...rest } = o;
  return {
    id, legacy: true, lanes: [{ arch, mode: emulated ? "emulated" : "native" }], units: 0, agent_slots: 0, disk: null, kinds: ["build", "trial", "audit"], probe_ok: true,
    drained: false, below_minimum: false, may_claim: true, behind: false, seen_at: T0, reserving: null, scope: { trust }, ...rest,
  };
}

let ids = 0;
function task(o: Partial<Candidate> & { arch: string }): Candidate {
  const id = ++ids;
  return { id, name: `p${id}`, kind: "build", trust: "project", owner: null, priority: 100, queued_at: T0, pinned_to: null, needs_native: false, model: false, size: null, disk_gb: null, native_ms: null, ...o };
}

interface Lease extends Held { ends: number; started: number }
interface Ran { task: Candidate; by: string; lane: Mode | null; at: number; size: number | null; asked: number | null; share: boolean; independent: Independence | null }

/**
 * A fleet on a fake clock. `minutes(task, lane)` is how long a task runs:
 * the simulated dispatchers start each lease at once (no queue on the host).
 */
class Sim {
  now = T0;
  queue: Candidate[] = [];
  leases: Lease[] = [];
  ran: Ran[] = [];
  history = new Map<string, number>();
  /** Registrations that are alive but never claim (a stalled dispatcher): eligible capacity that takes nothing. */
  silent = new Set<string>();
  /** Registrations no longer among the members whose model a publish-bound audit still weighs (D36): last seen at `at`. */
  past: { id: string; model: string; at: number }[] = [];
  /** Whether a build that ends queues its audit, as a staged build does (routes/factory.ts handleComplete): the second opinion (#339). */
  audits = false;
  constructor(public members: Member[], public minutes: (t: Candidate, lane: Mode | null) => number = (_t, lane) => (lane === "emulated" ? 90 : 30), public rules = R) {}
  /** The fleet as a claim reads it — with the models the route reads when a publish-bound audit is a candidate (D36). */
  fleet(): Fleet {
    const models = this.members.filter((m) => m.model && m.kinds.includes("audit") && m.may_claim && !m.drained).map((m) => ({ id: m.id, model: m.model!, at: m.seen_at }));
    return { members: this.members, leases: this.leases, models: [...models, ...this.past] };
  }
  add(o: Partial<Candidate> & { arch: string }, n = 1): Candidate[] {
    const out: Candidate[] = [];
    for (let i = 0; i < n; i++) {
      const t = task({ queued_at: this.now, ...o });
      if (o.name && n > 1) t.name = `${o.name}-${i}`;
      out.push(t);
    }
    this.queue.push(...out);
    return out;
  }
  /** The queue as the claim reads it: the native history of each package and arch. */
  candidates(): Candidate[] {
    return this.queue.map((t) => ({ ...t, native_ms: this.history.get(`${t.name}/${t.arch}`) ?? null }));
  }
  /**
   * The candidates as a claim of `m` reads them (routes/factory.ts selectAndLease), from the whole queue: each read bounded and filtered
   * by what `m` can take now (noRoom, the capped contributors) — the head of each lane's arch, the arch-neutral kinds' head, each
   * contributor's first build of each arch, the first native task whatever its size, the task it reserves for, the audits of the
   * project's copy its model cannot count as another (their own head, #339) — and, at a host's claim, the oldest builds the reservation
   * weighs.
   */
  reads(m: Member): { candidates: Candidate[]; oldest: Candidate[] } {
    const r = this.rules, now = this.now, fleet = this.fleet(), queue = this.candidates();
    const held = m.legacy ? [] : this.leases.filter((l) => l.by === m.id);
    const largest = largestSize(fleet, now, r);
    const cap = ownerCap(fleet, now, r);
    const capped = new Set([...ownersLeased(fleet)].filter(([, n]) => n >= cap).map(([o]) => o));
    const isCapped = (c: Candidate) => c.kind === "build" && c.trust === "community" && c.owner !== null && capped.has(c.owner);
    // The claim's own filters (scopeOf): its kinds, the pin, the probe, an emulated legacy lane's needs_native, and the project's copy of
    // a package its owner requested (D35).
    const scope = (c: Candidate) => takes(m, c) && !(m.legacy && m.lanes[0].mode === "emulated" && c.needs_native) && !requesterHost(m, c);
    const fits = (c: Candidate) => {
      const z = sizeOf(c, largest, r)?.size ?? null;
      return !noRoom(m, held, c, unitsOf(c.kind, z, r), diskOf(c, z, r), r) && !isCapped(c);
    };
    const byOrder = (a: Candidate, b: Candidate) => a.priority - b.priority || a.id - b.id;
    const neutral = (k: string) => !LANE_KINDS.includes(k) && !HELPER_KINDS.includes(k);
    // The audits of the project's copy the claimer's model cannot count as another (sameModelAuditOf): read apart, their own head (D36).
    const sameModel = (c: Candidate) => m.kinds.includes("audit") && c.kind === "audit" && !!c.publish_bound && !(m.model && c.built_with && c.built_with !== m.model);
    const emulatedOnly = (a: string) => !m.lanes.some((l) => l.arch === a && l.mode === "native");
    // A sandboxed host's emulated lane (#330): of the builds and trials, the project's own recipes only.
    const outsideSandbox = (a: string) => !m.legacy && !!m.sandbox && emulatedOnly(a);
    const projectsOwn = (c: Candidate) => !LANE_KINDS.includes(c.kind) || !contributorsCode(c);
    const out = new Map<number, Candidate>();
    const put = (cs: Candidate[]) => cs.forEach((c) => out.set(c.id, c));
    const owners = [...new Set(queue.filter((c) => c.trust === "community" && c.owner).map((c) => c.owner!))].sort().slice(0, OWNERS_LIMIT);
    for (const a of [...new Set(m.lanes.map((l) => l.arch))]) {
      if (m.legacy) put(queue.filter((c) => (c.arch === a || r.legacy_any_arch.includes(c.kind)) && scope(c) && fits(c) && !sameModel(c)).sort(byOrder).slice(0, HEAD_LIMIT));
      else put(queue.filter((c) => c.arch === a && !neutral(c.kind) && scope(c) && fits(c) && !(emulatedOnly(a) && c.needs_native) && (!outsideSandbox(a) || projectsOwn(c))).sort(byOrder).slice(0, HEAD_LIMIT));
      if (m.kinds.includes("build") && m.scope.trust !== "project" && !outsideSandbox(a)) {
        for (const o of owners) {
          if (capped.has(o)) continue;
          put(queue.filter((c) => c.trust === "community" && c.owner === o && c.arch === a && c.kind === "build" && scope(c) && fits(c) && !(!m.legacy && emulatedOnly(a) && c.needs_native)).sort(byOrder).slice(0, 1));
        }
      }
    }
    put(queue.filter((c) => sameModel(c) && (!m.legacy || c.arch === m.lanes[0].arch || r.legacy_any_arch.includes(c.kind)) && scope(c) && fits(c)).sort(byOrder).slice(0, HEAD_LIMIT));
    let oldest: Candidate[] = [];
    if (!m.legacy) {
      put(queue.filter((c) => neutral(c.kind) && scope(c) && fits(c) && !sameModel(c)).sort(byOrder).slice(0, HEAD_LIMIT));
      const native = m.lanes.find((l) => l.mode === "native")!.arch;
      if (m.lanes.some((l) => l.mode === "emulated")) put(queue.filter((c) => c.arch === native && LANE_KINDS.includes(c.kind) && scope(c) && !isCapped(c)).sort(byOrder).slice(0, 1));
      if (m.reserving) put(queue.filter((c) => c.id === m.reserving!.task && scope(c)));
      const hosts = this.members.filter((x) => !x.legacy && alive(x, now) && x.may_claim && !x.below_minimum && !x.drained && !x.behind);
      const runs = (c: Candidate, native: boolean) => hosts.some((x) => x.lanes.some((l) => l.arch === c.arch && (!native || l.mode === "native")));
      if (largest >= 2 && hosts.length) {
        oldest = queue
          .filter((c) => c.kind === "build" && runs(c, false) && (!c.needs_native || runs(c, true)) && !isCapped(c) && (c.pinned_to === null || hosts.some((x) => x.id === c.pinned_to)) && (c.reserved_at == null || c.reserved_at > now - RESERVE_FOR_MS || c.reserved_at <= now - RESERVE_FOR_MS - RESERVE_AFTER_MS))
          .sort((a, b) => a.id - b.id).slice(0, RESERVE_WINDOW)
          .filter((c) => c.queued_at <= now - RESERVE_AFTER_MS && (c.size ?? 1) >= 2).slice(0, RESERVE_CANDIDATES);
      }
    }
    return { candidates: [...out.values()], oldest };
  }
  /** One registration's claims until it is handed nothing (its dispatcher claims again at once after a task). */
  claim(m: Member): Ran[] {
    m.seen_at = this.now;
    const got: Ran[] = [];
    for (;;) {
      const { candidates, oldest } = this.reads(m);
      // A host's claim decides the reservation (a legacy one's does not); the task's window starts with its mark.
      if (!m.legacy) {
        const marks = reserve(this.fleet(), oldest, (id) => this.queue.some((q) => q.id === id), this.now, this.rules);
        for (const id of marks.clear) this.members.find((x) => x.id === id)!.reserving = null;
        if (marks.set) {
          this.members.find((x) => x.id === marks.set!.host)!.reserving = { task: marks.set.task, since: this.now };
          this.queue.find((q) => q.id === marks.set!.task)!.reserved_at = this.now;
          // Marked at this very claim, after the reads: the route hands selection its task too, so the mark holds.
          const t = oldest.find((c) => c.id === marks.set!.task);
          if (marks.set.host === m.id && t && !candidates.some((c) => c.id === t.id)) candidates.push(t);
        }
      }
      const c = select(m, this.fleet(), candidates, this.now, this.rules)[0];
      if (!c) return got;
      const t = this.queue.find((q) => q.id === c.id)!;
      this.queue = this.queue.filter((q) => q.id !== c.id);
      for (const x of this.members) if (x.reserving?.task === c.id) x.reserving = null;
      this.leases.push({ task: t.id, by: m.id, kind: t.kind, arch: t.arch, lane: c.lane, units: c.units, model: t.model, trust: t.trust, owner: t.owner, disk_gb: c.disk_gb ?? 0, started: this.now, ends: this.now + this.minutes(t, c.lane) * MIN });
      const r: Ran = { task: t, by: m.id, lane: c.lane, at: this.now, size: c.size, asked: c.asked, share: c.share, independent: c.independent };
      this.ran.push(r);
      got.push(r);
    }
  }
  /** Minutes pass: leases end (a native build's duration is kept), then every registration alive claims. */
  run(minutes: number, each?: (s: Sim) => void): void {
    for (let i = 0; i < minutes; i++) {
      this.step();
      each?.(this);
      this.now += MIN;
    }
  }
  step(): void {
    for (const l of this.leases.filter((x) => x.ends <= this.now)) {
      // A lease a test put on a host to keep it busy ends with nothing queued after it.
      const t = this.ran.find((r) => r.task.id === l.task)?.task;
      if (!t) continue;
      if (l.lane === "native" && t.kind === "build") this.history.set(`${t.name}/${t.arch}`, l.ends - l.started);
      // Staged: its audit is queued, the build's registration and model on it — publish-bound when the build is the project's copy.
      if (this.audits && t.kind === "build") {
        const by = this.members.find((x) => x.id === l.by);
        this.add({ arch: t.arch, kind: "audit", model: true, trust: "project", priority: 40, name: `audit-${t.name}`, publish_bound: !!t.publish_bound, built_by: l.by, built_with: by?.model ?? null, built_on: by ? machineOf(by) : null });
      }
    }
    this.leases = this.leases.filter((x) => x.ends > this.now);
    for (const m of this.members) {
      if (this.silent.has(m.id)) m.seen_at = this.now;
      else this.claim(m);
    }
  }
  held(id: string, f: (l: Lease) => boolean = () => true): Lease[] {
    return this.leases.filter((l) => l.by === id && f(l));
  }
  startOf(t: Candidate): Ran | undefined {
    return this.ran.find((r) => r.task.id === t.id);
  }
}

describe("the rules selection runs with", () => {
  it("are the release's signed constants: a build 2 per size, a trial 2, an audit 1, a pool job 1, one unit kept for pool jobs, sizes 4 and 2, 20 GB per size, a 10 GB floor, half the builds emulated while native work waits; the per-owner divisor 4", () => {
    expect(R).toMatchObject({ build_per_size: 2, trial: 2, audit: 1, job: 1, job_reserved: 1, max_size: 4, community_max_size: 2, gb_per_size: 20, floor_gb: 10, emulated_share: 0.5, owner_divisor: 4 });
    expect([TASK_UNITS.build_per_size, MAX_SIZE, COMMUNITY_MAX_SIZE, BUILD_GB_PER_SIZE, DISK_FLOOR_GB, EMULATED_SHARE, OWNER_DIVISOR]).toEqual([2, 4, 2, 20, 10, 0.5, 4]);
    expect(buildsOf(host("x", "aarch64", 11), R)).toBe(5);
    expect(buildsOf(host("x", "aarch64", 3), R)).toBe(1);
    expect(buildsOf(legacy("l", "aarch64"), R)).toBe(1);
    expect(buildsOf(legacy("l", "aarch64", { kinds: ["sync"] }), R)).toBe(0);
  });

  it("T is twice the last native duration, clamped to 3..60 minutes, and 3 minutes with no native history", () => {
    expect(thresholdMs(null)).toBe(3 * MIN);
    expect(thresholdMs(0)).toBe(T_MIN_MS);
    expect(thresholdMs(1 * MIN)).toBe(3 * MIN);
    expect(thresholdMs(10 * MIN)).toBe(20 * MIN);
    expect(thresholdMs(45 * MIN)).toBe(T_MAX_MS);
  });

  it("factory/sizing/tasks.toml reads as the release ships it, and a broken one does not", () => {
    expect(shippedSizing()).toBeInstanceOf(Map);
    expect(readSizing('schema = 1\n[package.chromium]\nsize = 4\ndisk_gb = 120\n')).toEqual(new Map([["chromium", { size: 4, disk_gb: 120 }]]));
    expect(readSizing('schema = 1\n[package.x]\nnetwork = "direct"\nreason = "raw sockets"\n')).toEqual(new Map());
    expect(readSizing("schema = 2\n")).toMatch(/schema 2/);
    expect(readSizing("schema = 1\n[package.x]\nsize = 0\n")).toMatch(/whole number from 1/);
    expect(readSizing("schema = 1\n[package.x]\ncores = 4\n")).toMatch(/unknown key cores/);
    expect(readSizing("schema = 1\nextra = 1\n")).toMatch(/unknown key extra/);
    expect(readSizing("schema = ")).toMatch(/does not read/);
  });
});

describe("native only", () => {
  it("a host runs its full unit count at once, each lease its own; the rest waits in the queue and starts as units free up", () => {
    const vps = host("vps", "x86_64", 7); // 8 cores, 16 GB: 7 units, 3 builds and the reserved job unit
    const s = new Sim([vps]);
    s.add({ arch: "x86_64" }, 10);
    s.run(1);
    expect(s.held("vps")).toHaveLength(3);
    expect(s.held("vps").reduce((n, l) => n + l.units, 0)).toBe(6);
    expect(s.queue).toHaveLength(7);
    // Nothing more while the units are taken, whatever the queue holds.
    s.run(29);
    expect(s.held("vps")).toHaveLength(3);
    // The builds end at minute 30: the next three start that same minute.
    s.run(1);
    expect(s.held("vps")).toHaveLength(3);
    expect(s.ran.filter((r) => r.at === T0 + 30 * MIN)).toHaveLength(3);
    s.run(120);
    expect(s.queue).toHaveLength(0);
    expect(s.ran.every((r) => r.lane === "native" && r.size === 1)).toBe(true);
  });

  it("the reserved job unit is never taken by a build or an audit, a pool job takes it; agent slots bound model work", () => {
    const studio = host("studio", "aarch64", 11, { agent_slots: 2 });
    const s = new Sim([studio], () => 600);
    s.add({ arch: "aarch64" }, 5);
    s.add({ arch: "aarch64", kind: "audit", model: true }, 3);
    s.run(1);
    // Five builds: 10 units, the eleventh kept — no audit fits beside them.
    expect(s.held("studio").map((l) => l.kind).sort()).toEqual(["build", "build", "build", "build", "build"]);
    // A pool job takes the kept unit.
    s.add({ arch: "aarch64", kind: "sync" });
    s.run(1);
    expect(s.held("studio", (l) => l.kind === "sync")).toHaveLength(1);
    expect(s.held("studio").reduce((n, l) => n + l.units, 0)).toBe(11);
    // Builds end; audits are model work: two agent slots, two audits, whatever the units allow.
    s.leases = s.leases.filter((l) => l.kind !== "build");
    s.run(1);
    expect(s.held("studio", (l) => l.kind === "audit")).toHaveLength(2);
    expect(s.queue.filter((t) => t.kind === "audit")).toHaveLength(1);
    // A host whose probe fails takes no model work at all.
    const mute = host("mute", "aarch64", 11, { probe_ok: false });
    expect(select(mute, { members: [mute], leases: [] }, [task({ arch: "aarch64", kind: "audit", model: true })], T0, R)).toEqual([]);
  });

  it("a pool job leased first holds the kept unit, never a task's: the minimum host runs its build beside a sync, the Studio its five, whichever came first (#340)", () => {
    const lease = (by: string, kind: string, units: number, n: number): Held => ({ task: 7000 + n, by, kind, arch: "aarch64", lane: kind === "build" ? "native" : null, units, model: false, trust: "project", owner: null, disk_gb: kind === "build" ? 20 : 0 });
    // 4 cores, 8 GB: 3 units, one build and the kept unit (design v2 §7.3).
    const min = host("min", "aarch64", 3);
    const build = task({ arch: "aarch64" });
    expect(roomOf(min, [lease("min", "sync", 1, 1)], R)).toEqual({ task: 2, job: 2 });
    expect(noRoom(min, [lease("min", "sync", 1, 1)], build, 2, 20, R)).toBeNull();
    expect(select(min, { members: [min], leases: [lease("min", "sync", 1, 1)] }, [build], T0, R)).toHaveLength(1);
    // The other order, as before: a build held, the sync takes the kept unit — and once both run, nothing more of either.
    expect(noRoom(min, [lease("min", "build", 2, 2)], { kind: "sync", model: false }, 1, null, R)).toBeNull();
    const both = [lease("min", "sync", 1, 1), lease("min", "build", 2, 2)];
    expect(noRoom(min, both, build, 2, 20, R)).toBe("units");
    expect(noRoom(min, both, { kind: "audit", model: false }, 1, null, R)).toBe("units");
    expect(noRoom(min, both, { kind: "render", model: false }, 1, null, R)).toBe("units");
    // The Studio: a sync first, then five builds beside it, the sixth waits.
    const studio = host("studio", "aarch64", 11);
    const s = new Sim([studio], () => 600);
    s.add({ arch: "aarch64", kind: "sync", priority: 10 });
    s.run(1);
    expect(s.held("studio").map((l) => l.kind)).toEqual(["sync"]);
    s.add({ arch: "aarch64" }, 6);
    s.run(1);
    expect(s.held("studio", (l) => l.kind === "build")).toHaveLength(5);
    expect(s.held("studio").reduce((n, l) => n + l.units, 0)).toBe(11);
    // The reservation counts the same free units: a host that holds a pool job has the task units it would have without it.
    expect(roomOf(studio, [lease("studio", "sync", 1, 1)], R).task).toBe(roomOf(studio, [], R).task);
  });

  it("never more units than the host's count: a pool cap or a smaller declaration holds the rest in the queue", () => {
    const capped = host("capped", "aarch64", 3); // min(declared, recomputed, pool cap) = 3
    const s = new Sim([capped]);
    s.add({ arch: "aarch64" }, 4);
    s.add({ arch: "aarch64", kind: "audit", model: true, priority: 10 });
    s.run(1);
    expect(s.held("capped").reduce((n, l) => n + l.units, 0)).toBeLessThanOrEqual(2);
    // The audit came first (its priority); the build that would take the kept unit beside it waits.
    expect(s.held("capped").map((l) => l.kind)).toEqual(["audit"]);
    // A cap lowered below what it holds: it takes nothing, and nothing it runs is ended.
    capped.units = 1;
    s.run(1);
    expect(s.held("capped")).toHaveLength(1);
  });

  it("a build's disk budget fits both free-disk values minus the floor and the budgets of the builds it holds", () => {
    const small = host("small", "aarch64", 11, { disk: { work: 400, engine: 52 } }); // 52 - 10 = 42: two 20 GB budgets, not a third
    const s = new Sim([small]);
    s.add({ arch: "aarch64" }, 3);
    s.run(1);
    expect(s.held("small")).toHaveLength(2);
    // A budget set for the package counts as set.
    const big = host("big", "aarch64", 11, { disk: { work: 100, engine: 100 } });
    expect(select(big, { members: [big], leases: [] }, [task({ arch: "aarch64", disk_gb: 95 })], T0, R)).toEqual([]);
    expect(select(big, { members: [big], leases: [] }, [task({ arch: "aarch64", disk_gb: 90 })], T0, R)).toHaveLength(1);
  });
});

describe("emulated only, then native work arriving", () => {
  it("an aarch64 host fills all but one of its builds with emulated x86_64 builds; native work starts at the next free build and gets half the builds as they free up", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"] }); // 5 builds
    const s = new Sim([studio], (_t, lane) => (lane === "emulated" ? 60 : 30));
    s.add({ arch: "x86_64" }, 20);
    s.run(1);
    // No native x86_64 host exists: the emulated lane takes them at once, all but one build (work-conserving).
    expect(s.held("studio", (l) => l.lane === "emulated")).toHaveLength(4);
    expect(s.held("studio")).toHaveLength(4);
    // Native work arrives on a host full of emulated builds: the kept build takes it at once.
    s.add({ arch: "aarch64" }, 20);
    s.run(1);
    expect(s.held("studio", (l) => l.lane === "native")).toHaveLength(1);
    // As the emulated builds end, native work waits: the emulated lanes keep to ceil(5/2) = 3, native gets the rest.
    s.run(80);
    for (let i = 0; i < 120; i++) {
      s.run(1);
      expect(s.held("studio", (l) => l.lane === "emulated").length).toBeLessThanOrEqual(3);
      if (s.queue.some((t) => t.arch === "aarch64")) expect(s.held("studio", (l) => l.lane === "native").length).toBeGreaterThanOrEqual(2);
    }
    // Running emulated work above the cap was never ended for it: every emulated lease ran its full hour.
    expect(s.ran.filter((r) => r.lane === "emulated").length).toBeGreaterThan(4);
  });
  it("behind an x86_64 backlog longer than the bound a claim reads, native work arriving still takes the build kept, and an emulated build of any size starts while the emulated lanes hold none", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"] });
    const s = new Sim([studio], () => 600);
    s.add({ arch: "x86_64" }, HEAD_LIMIT + 10);
    s.run(1);
    expect(s.held("studio", (l) => l.lane === "emulated")).toHaveLength(4);
    const [native] = s.add({ arch: "aarch64" });
    s.run(1);
    expect(s.startOf(native)).toMatchObject({ by: "studio", lane: "native" });
    // D50, emulated builds are never discarded: a size-4 x86_64 build on a host of four builds starts when its emulated lanes hold
    // nothing — idle, or with native work queued (the share puts it first on an aarch64-only fleet) — never a second one above the cap.
    const h9 = host("h9", "aarch64", 9, { emulated: ["x86_64"] });
    const big = task({ arch: "x86_64", size: 4 });
    const nat = task({ arch: "aarch64" });
    expect(select(h9, { members: [h9], leases: [] }, [big], T0, R)).toMatchObject([{ id: big.id, lane: "emulated", size: 4, units: 8 }]);
    const both = select(studio, { members: [studio], leases: [] }, [nat, big], T0, R);
    expect(both.map((c) => [c.id, c.lane, c.share])).toEqual([[big.id, "emulated", true], [nat.id, "native", false]]);
    const held: Held = { task: big.id, by: "h9", kind: "build", arch: "x86_64", lane: "emulated", units: 8, model: false, trust: "project", owner: null, disk_gb: 80 };
    expect(select(h9, { members: [h9], leases: [held] }, [task({ arch: "x86_64" })], T0, R)).toEqual([]);
  });
});

describe("mixed backlogs: native preferred, emulated after T", () => {
  it("an x86_64 task goes to a native x86_64 host while one is eligible, never to an emulated lane before its threshold", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"] });
    const box = host("box", "x86_64", 7); // 3 builds
    const s = new Sim([studio, box]); // the Studio claims first every minute
    s.add({ arch: "x86_64" }, 3);
    s.run(1);
    expect(s.held("box")).toHaveLength(3);
    expect(s.held("studio")).toHaveLength(0);
    // The native host full: no eligible native capacity, so the emulated lane takes the next at once.
    const [next] = s.add({ arch: "x86_64" });
    s.run(1);
    expect(s.startOf(next)).toMatchObject({ by: "studio", lane: "emulated" });
  });

  it("an eligible native host that does not claim holds an emulated lane T: 3 minutes with no history, twice the last native build otherwise, at most an hour", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"] });
    const box = host("box", "x86_64", 7);
    const s = new Sim([studio, box]);
    s.silent.add("box"); // alive, eligible, but its dispatcher does not claim
    const [fresh] = s.add({ arch: "x86_64", name: "fresh" });
    s.run(3);
    expect(s.startOf(fresh)).toBeUndefined();
    s.run(1);
    expect(s.startOf(fresh)).toMatchObject({ by: "studio", lane: "emulated", at: T0 + 3 * MIN });
    // With a native history of 10 minutes, T is 20.
    s.history.set("known/x86_64", 10 * MIN);
    const [known] = s.add({ arch: "x86_64", name: "known" });
    const from = s.now;
    s.run(25);
    expect(s.startOf(known)!.at - from).toBe(20 * MIN);
    // An emulated start's effective age carries T: among equals, the native candidate of the Studio's own arch goes first.
    const order = select(studio, s.fleet(), [task({ arch: "x86_64", queued_at: s.now - 4 * MIN }), task({ arch: "aarch64", queued_at: s.now - 2 * MIN })], s.now, R);
    expect(order.map((c) => c.lane)).toEqual(["native", "emulated"]);
  });

  it("a needs_native task never goes to an emulated lane, however long it waits", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"] });
    const s = new Sim([studio]);
    const [t] = s.add({ arch: "x86_64", needs_native: true });
    s.run(180);
    expect(s.startOf(t)).toBeUndefined();
    const box = host("box", "x86_64", 7, { seen_at: s.now });
    s.members.push(box);
    s.run(1);
    expect(s.startOf(t)).toMatchObject({ by: "box", lane: "native" });
  });
});

describe("emulated lanes per lane (#338, design v2 §7.4, §8.6)", () => {
  const JOBS = ["build", "trial", "audit", "sync", "health", "promote", "security"];

  it("needs_native is a lane's word: a host with both lanes takes such a task of its native arch natively and none of its emulated arch", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"] });
    const box = host("box", "x86_64", 7, { emulated: ["aarch64"] });
    const fleet: Fleet = { members: [studio, box], leases: [] };
    // Each sent back by the other's emulated lane, long enough ago for any T.
    const fromBox = task({ arch: "aarch64", needs_native: true, queued_at: T0 - 120 * MIN });
    const fromStudio = task({ arch: "x86_64", needs_native: true, queued_at: T0 - 120 * MIN });
    expect(select(studio, fleet, [fromBox, fromStudio], T0, R).map((c) => [c.id, c.lane])).toEqual([[fromBox.id, "native"]]);
    expect(select(box, fleet, [fromBox, fromStudio], T0, R).map((c) => [c.id, c.lane])).toEqual([[fromStudio.id, "native"]]);
    // Without the mark the emulated lane takes it (no native host of its arch alive but the other, which is busy here).
    const plain = task({ arch: "x86_64", queued_at: T0 - 120 * MIN });
    expect(select(studio, { members: [studio], leases: [] }, [plain], T0, R).map((c) => c.lane)).toEqual(["emulated"]);
  });

  it("a host whose dispatcher applies a sandbox (#330, D43): its emulated lane takes the project's own recipe only — what a contributor wrote goes to its native lane, or to a host without one", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"], sandbox: true });
    const plain = host("plain", "aarch64", 11, { emulated: ["x86_64"] });
    const old = T0 - 120 * MIN;
    // A contributor's build, the project's review rebuild of one (its copy), its trial, and the project's own recipe, all x86_64; a
    // contributor's aarch64 build.
    const theirs = task({ arch: "x86_64", trust: "community", owner: "alice", queued_at: old });
    const copy = task({ arch: "x86_64", publish_bound: true, requesters: ["bob"], queued_at: old });
    const trial = task({ arch: "x86_64", kind: "trial", queued_at: old });
    const own = task({ arch: "x86_64", queued_at: old });
    const native = task({ arch: "aarch64", trust: "community", owner: "carol", queued_at: old });
    const all = [theirs, copy, trial, own, native];
    expect([theirs, copy, trial, native].every(contributorsCode)).toBe(true);
    expect(contributorsCode(own)).toBe(false);
    expect(contributorsCode(task({ arch: "x86_64", kind: "audit" }))).toBe(true);
    const lanes = (m: Member) => new Map(select(m, { members: [m], leases: [] }, all, T0, R).map((c) => [c.id, c.lane]));
    expect(lanes(studio)).toEqual(new Map([[own.id, "emulated"], [native.id, "native"]]));
    expect(lanes(plain)).toEqual(new Map(all.map((c) => [c.id, c === native ? "native" : "emulated"])));
    // Placement counts no such lane as one allowed for the copy (D35): the sandboxed host could never run it there.
    expect(mayRun(studio, copy, T0, R, 4)).toBe(false);
    expect(mayRun(plain, copy, T0, R, 4)).toBe(true);
    // Side by side, minute by minute: every contributor's x86_64 task runs on the host without a sandbox, the project's own on either.
    const s = new Sim([host("studio", "aarch64", 11, { emulated: ["x86_64"], sandbox: true }), host("plain", "aarch64", 11, { emulated: ["x86_64"] })]);
    const contributed = [...s.add({ arch: "x86_64", trust: "community", owner: "alice" }, 3), ...s.add({ arch: "x86_64", kind: "trial" }, 2)];
    s.add({ arch: "x86_64" }, 6);
    s.run(200);
    expect(s.queue).toEqual([]);
    for (const t of contributed) expect(s.startOf(t), `${t.id}`).toMatchObject({ by: "plain", lane: "emulated" });
    expect(s.ran.filter((r) => r.by === "studio").length).toBeGreaterThan(0);
    expect(s.ran.filter((r) => r.by === "studio").every((r) => !contributorsCode(r.task))).toBe(true);
  });

  it("a health check of the x86_64 ring runs on an aarch64 host's emulated lane at once: no wait, no preference for a native host", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"], kinds: JOBS });
    // A native x86_64 host alive, idle and eligible makes no job with helpers wait.
    const box = host("box", "x86_64", 7, { kinds: JOBS });
    const fleet: Fleet = { members: [studio, box], leases: [] };
    const health = task({ arch: "x86_64", kind: "health", queued_at: T0 });
    expect(select(studio, fleet, [health], T0, R)).toEqual([expect.objectContaining({ id: health.id, lane: "emulated", units: R.job, share: false })]);
    // On the reserved job unit: the Studio's task units all held by builds, the health check still starts.
    const busy: Held[] = Array.from({ length: 5 }, (_, i) => ({ task: 900 + i, by: "studio", kind: "build", arch: "aarch64", lane: "native", units: 2, model: false, trust: "project", owner: null, disk_gb: 20 }));
    expect(select(studio, { members: [studio, box], leases: busy }, [health], T0, R).map((c) => c.id)).toEqual([health.id]);
    // The native host's lane is native for it; a host with no x86_64 lane at all takes none.
    expect(select(box, fleet, [health], T0, R).map((c) => c.lane)).toEqual(["native"]);
    const plain = host("plain", "aarch64", 7, { kinds: JOBS });
    expect(select(plain, { members: [plain], leases: [] }, [health], T0, R)).toEqual([]);
    expect(HELPER_KINDS).toEqual(["health"]);
  });

  it("a sandboxed host's emulated lane takes the pool's jobs with helpers as any host's does: they run the project's own scripts on the engine's own runtime (#330, #340)", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"], sandbox: true, kinds: JOBS });
    const fleet: Fleet = { members: [studio], leases: [] };
    const health = task({ arch: "x86_64", kind: "health", queued_at: T0 });
    const promote = task({ arch: "x86_64", kind: "promote" });
    const theirs = task({ arch: "x86_64", trust: "community", owner: "alice", queued_at: T0 - 120 * MIN });
    expect(select(studio, fleet, [health, promote, theirs], T0, R).map((c) => [c.id, c.lane])).toEqual([[health.id, "emulated"], [promote.id, null]]);
  });

  it("a promotion's ABI gates and health checks need a lane of every architecture it promotes, a security job's fast-track both; the job itself has no lane", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"], kinds: JOBS });
    const plain = host("plain", "aarch64", 7, { kinds: JOBS });
    const fleet: Fleet = { members: [studio, plain], leases: [] };
    const both = task({ arch: "x86_64", kind: "promote" });
    const arm = task({ arch: "x86_64", kind: "promote", job_arch: "aarch64" });
    const sec = task({ arch: "x86_64", kind: "security" });
    const sync = task({ arch: "x86_64", kind: "sync" });
    expect(helperArches(both)).toEqual(RING_ARCHES);
    expect(helperArches(arm)).toEqual(["aarch64"]);
    expect(helperArches(sync)).toBeNull();
    const ids = (m: Member) => select(m, fleet, [both, arm, sec, sync], T0, R).map((c) => [c.id, c.lane]);
    expect(ids(studio)).toEqual([[both.id, null], [arm.id, null], [sec.id, null], [sync.id, null]]);
    // An aarch64 host that runs no x86_64 lane: the promotion of aarch64 alone, and the arch-neutral sync.
    expect(ids(plain)).toEqual([[arm.id, null], [sync.id, null]]);
    // A legacy registration keeps today's rule: its any-arch kinds go to it whatever its lane (the Studio's pool-x86_64).
    const pool86 = legacy("pool-x86_64", "x86_64", { kinds: JOBS });
    expect(select(pool86, { members: [pool86], leases: [] }, [both], T0, R).map((c) => c.id)).toEqual([both.id]);
  });
});

describe("a continuous aarch64 backlog with x86_64 arrivals on an aarch64-only fleet", () => {
  it("x86_64 tasks still start: the guaranteed emulated share keeps one moving on every host that can, however long the aarch64 backlog", () => {
    const a = host("studio", "aarch64", 11, { emulated: ["x86_64"] });
    const b = host("vps", "aarch64", 7, { emulated: ["x86_64"] });
    const s = new Sim([a, b], (_t, lane) => (lane === "emulated" ? 50 : 20));
    // An aarch64 backlog, older than any x86_64 task and topped up every minute; an x86_64 task arrives every 20 minutes.
    s.add({ arch: "aarch64" }, 40);
    const x86: Candidate[] = [];
    s.run(600, (sim) => {
      if (sim.queue.filter((t) => t.arch === "aarch64").length < 30) sim.add({ arch: "aarch64" }, 10);
      if ((sim.now - T0) % (20 * MIN) === 0) x86.push(...sim.add({ arch: "x86_64" }));
    });
    // Every hour past the first, x86_64 builds started on both hosts, and most of them did; the share put them ahead of the backlog.
    for (let h = 1; h < 10; h++) {
      for (const by of ["studio", "vps"]) expect(s.ran.some((r) => r.by === by && r.task.arch === "x86_64" && r.at >= T0 + h * 60 * MIN && r.at < T0 + (h + 1) * 60 * MIN), `${by} in hour ${h}`).toBe(true);
    }
    expect(s.ran.some((r) => r.share)).toBe(true);
    // Fair by effective age: no x86_64 task waits longer than the aarch64 backlog's longest wait and one native build — started or still queued.
    const longest = Math.max(...s.ran.filter((r) => r.task.arch === "aarch64").map((r) => r.at - r.task.queued_at));
    for (const t of x86) expect((s.startOf(t)?.at ?? s.now) - t.queued_at, `x86_64 task ${t.id}`).toBeLessThanOrEqual(longest + 20 * MIN);
    // Without the share (a native x86_64 host alive but full), effective age alone orders them: the backlog keeps its place.
    const box = host("box", "x86_64", 3, { seen_at: s.now });
    const fleet: Fleet = { members: [a, box], leases: [{ task: 9999, by: "box", kind: "build", arch: "x86_64", lane: "native", units: 2, model: false, trust: "community", owner: "x", disk_gb: 20 }] };
    const freeA = { ...a, seen_at: s.now, reserving: null };
    const order = select(freeA, { ...fleet, members: [freeA, box] }, [task({ arch: "aarch64", queued_at: s.now - 60 * MIN }), task({ arch: "x86_64", queued_at: s.now - 30 * MIN })], s.now, R);
    expect(order.map((c) => [c.lane, c.share])).toEqual([["native", false], ["emulated", false]]);
  });
  it("however far the aarch64 backlog runs past the bound a claim reads, the oldest x86_64 build is read and goes first", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"] });
    const s = new Sim([studio], () => 600);
    s.add({ arch: "aarch64", queued_at: T0 - 120 * MIN }, HEAD_LIMIT + 10);
    const [x86] = s.add({ arch: "x86_64", queued_at: T0 - 5 * MIN });
    s.run(1);
    expect(s.startOf(x86)).toMatchObject({ by: "studio", lane: "emulated", share: true });
    expect(s.held("studio")).toHaveLength(5);
  });
});

describe("one contributor flooding the queue", () => {
  it("another contributor's single package waits no more than one build, round-robin by owner, with the cap lifted", () => {
    const rules = selectionRules(0);
    const s = new Sim([host("h1", "aarch64", 9), host("h2", "aarch64", 9)], () => 40, rules); // 8 builds
    s.add({ arch: "aarch64", owner: "flood", trust: "community" }, 150);
    s.run(15);
    expect(s.leases).toHaveLength(8);
    const [mine] = s.add({ arch: "aarch64", owner: "single", trust: "community" });
    const from = s.now;
    s.run(60);
    // The fleet was full: it starts when the first build ends, ahead of the 142 older ones.
    expect(s.startOf(mine)!.at - from).toBeLessThanOrEqual(40 * MIN);
    expect(s.ran.filter((r) => r.at > from && r.at < s.startOf(mine)!.at)).toHaveLength(0);
  });

  it("with the per-owner cap (ceil(total builds / 4)), the flood holds at most its share and another's package starts at once", () => {
    const s = new Sim([host("h1", "aarch64", 9), host("h2", "aarch64", 9)], () => 40); // 8 builds: 2 per contributor
    expect(ownerCap(s.fleet(), s.now, R)).toBe(2);
    s.add({ arch: "aarch64", owner: "flood", trust: "community" }, 150);
    s.add({ arch: "aarch64" }, 3);
    s.run(5);
    expect(s.leases.filter((l) => l.owner === "flood")).toHaveLength(2);
    // The project's builds are not a contributor's: no cap.
    expect(s.leases.filter((l) => l.trust === "project")).toHaveLength(3);
    const [mine] = s.add({ arch: "aarch64", owner: "single", trust: "community" });
    s.run(1);
    expect(s.startOf(mine)!.at).toBe(s.now - MIN);
    // A small fleet: still one at least.
    expect(ownerCap({ members: [host("tiny", "aarch64", 3)], leases: [] }, T0, R)).toBe(1);
  });
  it("a capped flood longer than the bound a claim reads hides no project build, nor a requeued one behind it", () => {
    const s = new Sim([host("h1", "aarch64", 9)], () => 600); // 4 builds: 1 per contributor
    s.add({ arch: "aarch64", owner: "flood", trust: "community", queued_at: T0 - 60 * MIN }, HEAD_LIMIT + 10);
    const [project] = s.add({ arch: "aarch64" });
    const [requeued] = s.add({ arch: "aarch64", priority: 110 });
    s.run(1);
    expect(s.leases.filter((l) => l.owner === "flood")).toHaveLength(1);
    expect(s.startOf(project)).toMatchObject({ by: "h1" });
    expect(s.startOf(requeued)).toMatchObject({ by: "h1" });
  });
});

describe("a head of tasks the claimer cannot take now", () => {
  it("audits ahead while its agent slots are full, or size-4 builds ahead of its free units, hide no build it can run", () => {
    // Its agent slots full (the day's agent budget spent: the dispatcher says 0): fifty-five audits ahead of a build.
    const p1 = host("p1", "aarch64", 7, { agent_slots: 0 });
    const s = new Sim([p1], () => 600);
    s.add({ arch: "aarch64", kind: "audit", model: true, priority: 40 }, HEAD_LIMIT + 5);
    const [b] = s.add({ arch: "aarch64" });
    s.run(1);
    expect(s.startOf(b)).toMatchObject({ by: "p1", lane: "native" });
    expect(s.held("p1", (l) => l.kind === "audit")).toHaveLength(0);
    // Two free units: fifty-five size-4 builds ahead of a size-1 one.
    const studio = host("studio", "aarch64", 11);
    const s2 = new Sim([studio], () => 600);
    s2.add({ arch: "aarch64" }, 4);
    s2.run(1);
    s2.add({ arch: "aarch64", size: 4, priority: 50 }, HEAD_LIMIT + 5);
    const [small] = s2.add({ arch: "aarch64" });
    s2.run(1);
    expect(s2.startOf(small)).toMatchObject({ by: "studio", size: 1 });
  });
});

describe("sizes and the reservation for large tasks", () => {
  it("a size-4 task starts on a busy host within the reservation window: after 30 minutes the host takes nothing else until its units reach the task", () => {
    const studio = host("studio", "aarch64", 11); // 10 units for builds
    let k = 0;
    const s = new Sim([studio], (t) => (t.size === 4 ? 120 : 45 + (k++ % 5) * 7));
    s.add({ arch: "aarch64" }, 5);
    s.run(10); // five builds running, staggered ends
    const [big] = s.add({ arch: "aarch64", name: "chromium", size: 4 });
    const at = s.now;
    s.run(240, (sim) => {
      if (sim.queue.filter((t) => t.size !== 4).length < 10) sim.add({ arch: "aarch64" }, 10);
    });
    const r = s.startOf(big)!;
    expect(r, "it started").toBeTruthy();
    expect(r.at - at).toBeLessThanOrEqual(30 * MIN + RESERVE_FOR_MS);
    expect(r.size).toBe(4);
    // While it reserved, the host took no other build.
    const marked = s.ran.filter((x) => x.at > at + 31 * MIN && x.at < r.at);
    expect(marked.filter((x) => x.task.kind === "build")).toHaveLength(0);
  });

  it("a mark clears when its task leaves the queue, when its host leaves, or after 2 hours — and its task is not marked again for 30 minutes; one at a time; a size-1 build or a host that could never run it is never reserved for", () => {
    const studio = host("studio", "aarch64", 11, { reserving: { task: 1, since: T0 } });
    const t1 = { ...task({ arch: "aarch64", size: 4, queued_at: T0 - 60 * MIN }), id: 1, reserved_at: T0 };
    const busy: Held = { task: 500, by: "studio", kind: "build", arch: "aarch64", lane: "native", units: 8, model: false, trust: "project", owner: null, disk_gb: 20 };
    const waits = () => true;
    expect(reserve({ members: [studio], leases: [busy] }, [t1], waits, T0 + MIN, R)).toEqual({ set: null, clear: [] });
    // Its task leased or cancelled: gone, and the oldest marked again when it waits.
    expect(reserve({ members: [studio], leases: [busy] }, [t1], () => false, T0 + MIN, R).clear).toEqual(["studio"]);
    // Its two hours spent: the mark clears, and its task is not marked again for 30 minutes — the host goes back to selection.
    const later = T0 + RESERVE_FOR_MS + MIN;
    expect(reserve({ members: [{ ...studio, seen_at: later }], leases: [busy] }, [t1], waits, later, R)).toEqual({ set: null, clear: ["studio"] });
    expect([T0 + RESERVE_FOR_MS - MIN, T0 + RESERVE_FOR_MS, later, T0 + RESERVE_FOR_MS + RESERVE_AFTER_MS - MIN, T0 + RESERVE_FOR_MS + RESERVE_AFTER_MS].map((n) => cooling(T0, n)))
      .toEqual([false, true, true, true, false]);
    expect(cooling(null, later)).toBe(false);
    // Thirty minutes on, it waits its turn again as a build queued 30 minutes does: marked anew.
    const again = T0 + RESERVE_FOR_MS + RESERVE_AFTER_MS;
    expect(reserve({ members: [{ ...studio, seen_at: again }], leases: [busy] }, [t1], waits, again, R)).toEqual({ set: { host: "studio", task: 1 }, clear: ["studio"] });
    // Another task that waits its turn is marked in its place; one never marked yet is.
    const t2 = task({ arch: "aarch64", size: 4, queued_at: T0 - 40 * MIN });
    expect(reserve({ members: [{ ...studio, seen_at: later }], leases: [busy] }, [t1, t2], waits, later, R)).toEqual({ set: { host: "studio", task: t2.id }, clear: ["studio"] });
    expect(reserve({ members: [{ ...studio, seen_at: T0 - ALIVE_MS - MIN }], leases: [busy] }, [t1], waits, T0, R)).toEqual({ set: null, clear: ["studio"] });
    // One at a time: a valid mark keeps another task from being marked.
    expect(reserve({ members: [studio, host("vps", "aarch64", 11)], leases: [busy] }, [{ ...t1, id: 2 }], waits, T0 + MIN, R).set).toBeNull();
    const free = { ...studio, reserving: null };
    // Waited 30 minutes or less: no mark yet. A task no alive host runs (its arch): none. A size-1 build: none — the next build that ends fits it.
    expect(reserve({ members: [free], leases: [busy] }, [task({ arch: "aarch64", size: 4, queued_at: T0 - 20 * MIN })], waits, T0, R).set).toBeNull();
    expect(reserve({ members: [free], leases: [busy] }, [task({ arch: "x86_64", size: 4, queued_at: T0 - 60 * MIN })], waits, T0, R).set).toBeNull();
    expect(reserve({ members: [free], leases: [busy] }, [task({ arch: "aarch64", queued_at: T0 - 60 * MIN })], waits, T0, R).set).toBeNull();
    // A free host fits it now: nobody needs to reserve.
    expect(reserve({ members: [free], leases: [] }, [{ ...t1, reserved_at: null }], waits, T0, R).set).toBeNull();
  });

  it("an older build that waits for another reason (needs_native, size 1, its owner's cap) turns nothing off: the oldest that could be kept for is", () => {
    // The Studio of an aarch64-only fleet, its five builds busy; a needs_native x86_64 build queued 5 hours ago waits for a native host
    // that does not exist; a size-1 build and a capped contributor's size-2 build are older than the size-4 one too.
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"] });
    const busy: Held[] = [0, 1, 2, 3, 4].map((i) => ({ task: 600 + i, by: "studio", kind: "build", arch: "aarch64", lane: "native", units: 2, model: false, trust: i ? "project" : "community", owner: i ? null : "flood", disk_gb: 20 }));
    const stuck = task({ arch: "x86_64", size: 2, needs_native: true, queued_at: T0 - 300 * MIN });
    const small = task({ arch: "aarch64", queued_at: T0 - 200 * MIN });
    const capped = task({ arch: "aarch64", size: 2, trust: "community", owner: "flood", queued_at: T0 - 150 * MIN });
    const big = task({ arch: "aarch64", name: "chromium", size: 4, queued_at: T0 - 31 * MIN });
    const fleet: Fleet = { members: [studio], leases: busy };
    expect(ownerCap(fleet, T0, R)).toBe(2);
    const capFleet: Fleet = { members: [studio], leases: busy.map((l, i) => (i === 1 ? { ...l, trust: "community", owner: "flood" } : l)) };
    expect(reserve(capFleet, [stuck, small, capped, big], () => true, T0, R)).toEqual({ set: { host: "studio", task: big.id }, clear: [] });
    // An emulated size-4 build on a host of four builds: never marked for — its emulated lanes, the cap and T allow it once the host is idle.
    const h9 = host("h9", "aarch64", 9, { emulated: ["x86_64"] });
    const busy9: Held[] = [0, 1].map((i) => ({ task: 700 + i, by: "h9", kind: "build", arch: "aarch64", lane: "native", units: 2, model: false, trust: "project", owner: null, disk_gb: 20 }));
    const big86 = task({ arch: "x86_64", size: 4, queued_at: T0 - 40 * MIN });
    expect(reserve({ members: [h9], leases: busy9 }, [big86], () => true, T0, R).set).toEqual({ host: "h9", task: big86.id });
    // A host that could never lease it is never marked: a needs_native one on an emulated lane.
    expect(reserve({ members: [h9], leases: busy9 }, [{ ...big86, needs_native: true }], () => true, T0, R).set).toBeNull();
  });

  it("whatever older build waits for another reason: a needs_native x86_64 build on an aarch64-only fleet turns nothing off", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"] });
    let k = 0;
    const s = new Sim([studio], (t) => (t.size === 4 ? 120 : 45 + (k++ % 5) * 7));
    const [stuck] = s.add({ arch: "x86_64", needs_native: true, queued_at: T0 - 300 * MIN });
    s.add({ arch: "aarch64" }, 5);
    s.run(10);
    const [big] = s.add({ arch: "aarch64", name: "chromium", size: 4 });
    const at = s.now;
    s.run(240, (sim) => {
      if (sim.queue.filter((t) => t.size !== 4 && !t.needs_native).length < 10) sim.add({ arch: "aarch64" }, 10);
    });
    const r = s.startOf(big)!;
    expect(r, "it started").toBeTruthy();
    expect(r.at - at).toBeLessThanOrEqual(30 * MIN + RESERVE_FOR_MS);
    expect(s.startOf(stuck)).toBeUndefined();
  });

  it("its two hours spent, the host goes back to selection for 30 minutes, then the task is marked again: it starts the minute the builds longer than its window end", () => {
    const studio = host("studio", "aarch64", 11);
    let k = 0;
    // One build ends at minute 100, the other four at 400: the size-4 task cannot fit within its first window, nor its second.
    const s = new Sim([studio], (t) => (t.size === 4 ? 120 : k++ === 0 ? 100 : 400));
    s.add({ arch: "aarch64" }, 5);
    s.run(1);
    const [big] = s.add({ arch: "aarch64", size: 4 });
    const smalls = s.add({ arch: "aarch64" }, 3);
    s.run(40);
    expect(studio.reserving?.task).toBe(big.id);
    const since = studio.reserving!.since;
    // The first build ends: two units free, and the host keeps them for the task.
    s.run(80);
    expect(smalls.every((t) => !s.startOf(t))).toBe(true);
    // Two hours after the mark: cleared, not set again for 30 minutes, and the next small build takes the two free units.
    s.now = since + RESERVE_FOR_MS - MIN;
    s.run(10);
    expect(studio.reserving).toBeNull();
    expect(s.queue.find((t) => t.id === big.id)!.reserved_at).toBe(since);
    expect(s.startOf(smalls[0])?.at).toBeGreaterThan(since + RESERVE_FOR_MS - MIN);
    s.run(20);
    expect(studio.reserving).toBeNull();
    // Thirty minutes on, marked again: its window starts anew.
    s.run(2);
    const again = since + RESERVE_FOR_MS + RESERVE_AFTER_MS;
    expect(studio.reserving).toEqual({ task: big.id, since: again });
    expect(s.queue.find((t) => t.id === big.id)!.reserved_at).toBe(again);
    // That window lapses too while the four builds run, and the third one stands when they end: it starts that minute, at size 4,
    // ahead of the small builds that waited beside it.
    s.run(300);
    expect(s.startOf(big)).toMatchObject({ at: T0 + 400 * MIN, size: 4 });
    expect(smalls.slice(1).filter((t) => (s.startOf(t)?.at ?? Infinity) < T0 + 400 * MIN)).toEqual([]);
  });

  it("a host whose mark lapses while it runs a build longer than the window: the task is marked again 30 minutes on, and starts under a steady flow of small builds", () => {
    // Two hosts of four builds each: a size-4 build needs one whole. Each runs a 4-hour build; small builds of 17 to 45 minutes refill
    // every unit that frees up.
    const a = host("a", "aarch64", 9), b = host("b", "aarch64", 9);
    let k = 0;
    const s = new Sim([a, b], (t) => (t.size === 4 ? 120 : t.name.startsWith("long") ? 240 : 17 + ((k++ * 7) % 29)));
    s.add({ arch: "aarch64", name: "long-a", pinned_to: "a" });
    s.add({ arch: "aarch64", name: "long-b", pinned_to: "b" });
    const refill = (sim: Sim) => {
      if (sim.queue.filter((t) => t.size !== 4).length < 10) sim.add({ arch: "aarch64" }, 10);
    };
    refill(s);
    s.run(1, refill);
    const [big] = s.add({ arch: "aarch64", name: "chromium", size: 4 });
    const marks: { host: string; since: number }[] = [];
    s.run(400, (sim) => {
      for (const m of sim.members) if (m.reserving && !marks.some((x) => x.since === m.reserving!.since)) marks.push({ host: m.id, since: m.reserving.since });
      refill(sim);
    });
    const r = s.startOf(big)!;
    expect(r, "it started").toBeTruthy();
    expect(r.size).toBe(4);
    // The first window lapsed while both 4-hour builds ran; the second, 30 minutes after it, saw one of them end.
    expect(marks).toHaveLength(2);
    expect(marks[1].since - marks[0].since).toBe(RESERVE_FOR_MS + RESERVE_AFTER_MS);
    expect(r.at).toBeGreaterThan(marks[0].since + RESERVE_FOR_MS);
    expect(r.at).toBeLessThan(marks[1].since + RESERVE_FOR_MS);
    expect(r.by).toBe(marks[1].host);
    // While a mark stood, its host took no other build.
    for (const [i, m] of marks.entries()) {
      const until = i === 0 ? m.since + RESERVE_FOR_MS : r.at;
      expect(s.ran.filter((x) => x.by === m.host && x.at > m.since && x.at < until && x.task.id !== big.id)).toHaveLength(0);
    }
  });

  it("a reserving host whose free units reach its task's takes other work while it cannot lease it — its owner at their cap, the memory its claim offers — and the task first when it can", () => {
    const builds = [0, 1, 2, 3, 4].map(() => task({ arch: "aarch64", queued_at: T0 - 5 * MIN }));
    // G, idle, reserves for alice's size-2 build; alice holds two builds on H, her cap (ceil(8 / 4) = 2).
    const mine = task({ arch: "aarch64", size: 2, trust: "community", owner: "alice", queued_at: T0 - 60 * MIN });
    const g = host("g", "aarch64", 9, { reserving: { task: mine.id, since: T0 - 10 * MIN } });
    const h = host("h", "aarch64", 9);
    const alices: Held[] = [0, 1].map((i) => ({ task: 800 + i, by: "h", kind: "build", arch: "aarch64", lane: "native", units: 2, model: false, trust: "community", owner: "alice", disk_gb: 20 }));
    const fleet: Fleet = { members: [g, h], leases: alices };
    expect(ownerCap(fleet, T0, R)).toBe(2);
    // Its eight free units fit the task, which her cap holds back: G takes the project's builds rather than idle out the mark.
    expect(select(g, fleet, [mine, ...builds], T0, R).map((c) => c.id)).toEqual(builds.map((t) => t.id));
    // While its free units are below the task's, the mark holds: nothing but the task and pool jobs.
    const busy: Held[] = [0, 1, 2].map((i) => ({ task: 810 + i, by: "g", kind: "build", arch: "aarch64", lane: "native", units: 2, model: false, trust: "project", owner: null, disk_gb: 20 }));
    expect(select(g, { members: [g, h], leases: [...alices, ...busy] }, [mine, ...builds], T0, R)).toEqual([]);
    // A size-4 build, the claim's memory offering 6 units of the 8 free: the build waits for memory, and G takes what fits the offer.
    const llvm = task({ arch: "aarch64", size: 4, queued_at: T0 - 60 * MIN });
    const g4 = host("g4", "aarch64", 9, { reserving: { task: llvm.id, since: T0 - 10 * MIN } });
    const short = { ...g4, offer: 6 };
    expect(select(short, { members: [short], leases: [] }, [llvm, ...builds], T0, R).map((c) => c.id)).toEqual(builds.map((t) => t.id));
    // The memory back: the task first, ahead of a more urgent build that arrived since.
    const urgent = task({ arch: "aarch64", priority: 50, queued_at: T0 });
    expect(select(g4, { members: [g4], leases: [] }, [urgent, llvm, ...builds], T0, R)[0]).toMatchObject({ id: llvm.id, size: 4, units: 8 });
    // A mark whose task the claim did not read holds nothing: the reads bring only what this claim can take, so G takes other work
    // rather than idle out the mark's two hours (below: its probe failing, builds held for disk).
    expect(select(g4, { members: [g4], leases: [] }, builds, T0, R).map((c) => c.id)).toEqual(builds.map((t) => t.id));
  });

  it("a reserving host whose claim cannot take its task — its agent's probe failing, builds held for disk — takes other work, whatever its free units; a mark set at the claim itself holds", () => {
    // An 11-unit host reserving for a size-4 model build (a contributor's draft), holding nothing.
    const draft = task({ arch: "aarch64", size: 4, model: true, queued_at: T0 - 60 * MIN });
    const plain = [0, 1, 2].map(() => task({ arch: "aarch64", queued_at: T0 - 5 * MIN }));
    const h = host("h", "aarch64", 11, { reserving: { task: draft.id, since: T0 - 10 * MIN } });
    // Its probe answering, the task read: the task first, then the builds.
    expect(select(h, { members: [h], leases: [] }, [draft, ...plain], T0, R).map((c) => c.id)).toEqual([draft.id, ...plain.map((t) => t.id)]);
    // Its probe failing: the claim's reads leave the model build out (and selection would too), and the three builds are taken.
    const failing: Member = { ...h, probe_ok: false };
    expect(select(failing, { members: [failing], leases: [] }, [draft, ...plain], T0, R).map((c) => c.id)).toEqual(plain.map((t) => t.id));
    expect(select(failing, { members: [failing], leases: [] }, plain, T0, R).map((c) => c.id)).toEqual(plain.map((t) => t.id));
    // Builds held for disk (the claim's kinds: trials and audits): a trial and an audit.
    const trial = task({ arch: "aarch64", kind: "trial", queued_at: T0 - 5 * MIN });
    const audit = task({ arch: "aarch64", kind: "audit", model: true, queued_at: T0 - 5 * MIN });
    const diskHeld: Member = { ...h, kinds: ["trial", "audit"] };
    expect(select(diskHeld, { members: [diskHeld], leases: [] }, [trial, audit], T0, R).map((c) => c.id)).toEqual([trial.id, audit.id]);
    // A mark set at this very claim, after its reads: the claim hands selection its task too (as routes/factory.ts does), so it holds
    // while the host's free units are below it — four free, the task's eight: nothing taken, the small builds wait.
    const studio = host("studio", "aarch64", 11);
    const s = new Sim([studio]);
    s.leases.push(...[0, 1, 2].map((i) => ({ task: 900 + i, by: "studio", kind: "build", arch: "aarch64", lane: "native" as Mode, units: 2, model: false, trust: "project", owner: null, disk_gb: 20, started: T0, ends: T0 + 600 * MIN })));
    const [big] = s.add({ arch: "aarch64", size: 4, queued_at: T0 - 31 * MIN });
    s.add({ arch: "aarch64" }, 2);
    expect(s.claim(studio)).toEqual([]);
    expect(studio.reserving).toEqual({ task: big.id, since: T0 });
  });

  it("a claim's memory offer bounds that claim only: the host's size, its builds and the largest size it runs stay what its units say", () => {
    const studio = host("studio", "aarch64", 11);
    const big = task({ arch: "aarch64", size: 4 });
    const small = task({ arch: "aarch64" });
    const offering: Member = { ...studio, offer: 6 };
    const fleet: Fleet = { members: [offering], leases: [] };
    expect(largestSize(fleet, T0, R)).toBe(4);
    expect(buildsOf(offering, R)).toBe(5);
    // The size-4 build waits for memory rather than run smaller; a size-1 build fits the offer.
    expect(noRoom(offering, [], big, 8, 80, R)).toBe("memory");
    expect(select(offering, fleet, [big, small], T0, R)).toMatchObject([{ id: small.id, size: 1, asked: null }]);
    expect(select(studio, { members: [studio], leases: [] }, [big], T0, R)).toMatchObject([{ id: big.id, size: 4, asked: null }]);
  });

  it("a task larger than every host alive is clamped to the largest, saying what it asked; a contributor's never above 2", () => {
    const vps = host("vps", "aarch64", 7); // 3 builds
    const fleet: Fleet = { members: [vps], leases: [] };
    expect(largestSize(fleet, T0, R)).toBe(3);
    const [c] = select(vps, fleet, [task({ arch: "aarch64", size: 4 })], T0, R);
    expect(c).toMatchObject({ size: 3, asked: 4, units: 6, disk_gb: 60 });
    const [community] = select(vps, fleet, [task({ arch: "aarch64", size: 4, trust: "community", owner: "alice" })], T0, R);
    expect(community).toMatchObject({ size: 2, asked: null, units: 4 });
    // A host that left is no host to wait for.
    const gone = host("gone", "aarch64", 31, { seen_at: T0 - ALIVE_MS - MIN });
    expect(largestSize({ members: [vps, gone], leases: [] }, T0, R)).toBe(3);
    expect(largestSize({ members: [vps, { ...gone, seen_at: T0 }], leases: [] }, T0, R)).toBe(4);
  });
});

describe("eligible native capacity", () => {
  it("a drained, below-minimum, suspended, behind, busy or reserving native host never makes an emulated lane wait", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"] });
    const t = task({ arch: "x86_64" });
    const box = (o: Partial<Member> = {}) => host("box", "x86_64", 7, o);
    const waits = (b: Member, leases: Held[] = []) => nativeCapacity({ members: [studio, b], leases }, t, T0, R, "studio");
    expect(waits(box())).toBe(true);
    expect(waits(box({ drained: true }))).toBe(false);
    expect(waits(box({ below_minimum: true }))).toBe(false);
    expect(waits(box({ may_claim: false }))).toBe(false);
    expect(waits(box({ behind: true }))).toBe(false);
    expect(waits(box({ seen_at: T0 - ALIVE_MS - MIN }))).toBe(false);
    expect(waits(box({ kinds: ["audit"] }))).toBe(false);
    expect(waits(box({ reserving: { task: 12345, since: T0 } }))).toBe(false);
    expect(waits(box({ disk: { work: 400, engine: 25 } }))).toBe(false);
    const full: Held[] = [0, 1, 2].map((i) => ({ task: 900 + i, by: "box", kind: "build", arch: "x86_64", lane: "native", units: 2, model: false, trust: "project", owner: null, disk_gb: 20 }));
    expect(waits(box(), full)).toBe(false);
    // One the requester-host rule excludes (D35, #339): the project's copy of its owner's own package.
    const copy = task({ arch: "x86_64", publish_bound: true, requesters: ["m1"], model: true });
    expect(nativeCapacity({ members: [studio, box({ owner: "m1" })], leases: [] }, copy, T0, R, "studio")).toBe(false);
    expect(nativeCapacity({ members: [studio, box({ owner: "m2" })], leases: [] }, copy, T0, R, "studio")).toBe(true);
    expect(nativeCapacity({ members: [studio, box({ owner: "m1" })], leases: [] }, { ...copy, any_host: "m2" }, T0, R, "studio")).toBe(true);
    // In the claim: the drained host's arch runs emulated at once.
    const s = new Sim([studio, box({ drained: true })]);
    const [x] = s.add({ arch: "x86_64" });
    s.run(1);
    expect(s.startOf(x)).toMatchObject({ by: "studio", lane: "emulated", at: T0 });
  });
});

describe("a host that sleeps (#329)", () => {
  it("has zero free units: it takes nothing, makes no emulated lane wait, keeps no mark and counts in no size or cap; awake again, it takes what waited at once", () => {
    const studio = host("studio", "aarch64", 11, { emulated: ["x86_64"] });
    const box = host("box", "x86_64", 7);
    const sleeping = { ...box, asleep: true };
    const t86 = task({ arch: "x86_64" });
    // Whatever waits, a sleeping host takes none of it.
    expect(select(sleeping, { members: [sleeping], leases: [] }, [task({ arch: "x86_64" })], T0, R)).toEqual([]);
    // Its native lane is no capacity an emulated one waits for, and the Studio's x86_64 lane takes the build at once, as the share.
    expect(nativeCapacity({ members: [studio, box], leases: [] }, t86, T0, R, "studio")).toBe(true);
    expect(nativeCapacity({ members: [studio, sleeping], leases: [] }, t86, T0, R, "studio")).toBe(false);
    const older = task({ arch: "aarch64", queued_at: T0 - 20 * MIN });
    expect(select(studio, { members: [studio, box], leases: [] }, [older, t86], T0, R).map((c) => c.id)).toEqual([older.id]);
    expect(select(studio, { members: [studio, sleeping], leases: [] }, [older, t86], T0, R)).toMatchObject([{ id: t86.id, lane: "emulated", share: true }, { id: older.id }]);
    // No size alive is a sleeping host's, nor its builds in the per-owner cap.
    const p1 = host("p1", "aarch64", 7);
    expect(largestSize({ members: [studio, p1], leases: [] }, T0, R)).toBe(4);
    expect(largestSize({ members: [{ ...studio, asleep: true }, p1], leases: [] }, T0, R)).toBe(3);
    expect(ownerCap({ members: [studio, p1], leases: [] }, T0, R)).toBe(2);
    expect(ownerCap({ members: [{ ...studio, asleep: true }, p1], leases: [] }, T0, R)).toBe(1);
    // A mark it held is cleared, and another host may be marked meanwhile.
    const marked = { ...studio, asleep: true, reserving: { task: 4242, since: T0 } };
    expect(reserve({ members: [marked, p1], leases: [] }, [], () => true, T0, R).clear).toEqual(["studio"]);
    // On a fake clock: a host that sleeps half an hour starts nothing; the minute it reports itself awake it takes the queue.
    const mac = host("mac", "aarch64", 7);
    const s = new Sim([mac]);
    const queued = s.add({ arch: "aarch64" }, 3);
    mac.asleep = true;
    s.run(30);
    expect(s.ran).toEqual([]);
    mac.asleep = false;
    s.run(1);
    expect(s.ran.map((r) => r.task.id)).toEqual(queued.map((t) => t.id));
  });
});

describe("legacy registrations", () => {
  it("are selected as a host with one lane and one build: an emulated one waits T for an idle native one, takes no build above size 1, and its own leases do not hold it", () => {
    const native = legacy("studio-community-aarch64", "aarch64", { trust: "community" });
    const emu = legacy("studio-community-x86_64", "x86_64", { trust: "community", emulated: true });
    const nat86 = legacy("box-x86_64", "x86_64", { trust: "community" });
    const s = new Sim([emu, nat86]);
    s.silent.add("box-x86_64");
    const [t] = s.add({ arch: "x86_64", trust: "community", owner: "alice" });
    s.run(3);
    expect(s.startOf(t)).toBeUndefined();
    s.run(1);
    expect(s.startOf(t)).toMatchObject({ by: "studio-community-x86_64", lane: "emulated" });
    // One build: a claim takes one task, and a lease the pool still holds for it (a restarted worker) does not hold the next.
    const fleet: Fleet = { members: [native], leases: [{ task: 77, by: native.id, kind: "build", arch: "aarch64", lane: "native", units: 2, model: false, trust: "community", owner: "x", disk_gb: 0 }] };
    expect(select(native, fleet, [task({ arch: "aarch64", trust: "community", owner: "alice" })], T0, R)).toHaveLength(1);
    // A size-2 build is a host's, not a legacy registration's, while a host that runs it is alive.
    const big = host("big", "aarch64", 11);
    expect(select(native, { members: [native, big], leases: [] }, [task({ arch: "aarch64", size: 2, trust: "community", owner: "alice" })], T0, R)).toEqual([]);
    expect(select(native, { members: [native], leases: [] }, [task({ arch: "aarch64", size: 2, trust: "community", owner: "alice" })], T0, R)[0]).toMatchObject({ size: 1, asked: 2 });
    // Its trust is all its scope (#343): a project one takes no contributor's build; a community one any contributor's, as a host
    // does — its owner's no sooner than anyone's, whatever its row once said of a mode — and never the project's.
    const project = legacy("pool-aarch64", "aarch64", { trust: "project" });
    expect(select(project, { members: [project], leases: [] }, [task({ arch: "aarch64", trust: "community", owner: "alice" })], T0, R)).toEqual([]);
    const theirs = legacy("dave-aarch64", "aarch64", { trust: "community", owner: "dave" });
    const erin = task({ arch: "aarch64", trust: "community", owner: "erin" }), dave = task({ arch: "aarch64", trust: "community", owner: "dave" });
    expect(select(theirs, { members: [theirs], leases: [] }, [erin, dave], T0, R).map((c) => c.id)).toEqual([erin.id, dave.id]);
    expect(select(theirs, { members: [theirs], leases: [] }, [task({ arch: "aarch64", trust: "project" })], T0, R)).toEqual([]);
  });
});

// ---------- placement (#339, design v2 §8.4; D35, D36) ----------

/** A maintainer's host: its owner, and the model its claims say it runs. */
const owned = (id: string, owner: string, arch: string, units: number, o: Partial<Member> & { emulated?: string[] } = {}) => host(id, arch, units, { owner, model: "anthropic/claude-a", ...o });
/** The project's copy of a package its requesters asked for: the review rebuild, publish-bound, model work. */
const copyOf = (requesters: string[], o: Partial<Candidate> & { arch?: string } = {}) => ({ arch: "aarch64", kind: "build", trust: "project", model: true, publish_bound: true, requesters, priority: 30, ...o });
/** Leases that keep a host's builds busy until `until` minutes. */
const busy = (s: Sim, id: string, n: number, until: number) => s.leases.push(...Array.from({ length: n }, (_, i) => ({ task: 5000 + s.leases.length + i, by: id, kind: "build", arch: "aarch64", lane: "native" as Mode, units: 2, model: false, trust: "project", owner: null, disk_gb: 20, started: T0, ends: T0 + until * MIN })));

describe("the requester-host rule (D35): the project's copy is not built on its requester's host", () => {
  it("a review rebuild of a maintainer's own package never runs on their host while another maintainer's can take it — however busy that one, however long it waits", () => {
    const m1 = owned("m1-studio", "m1", "aarch64", 11);
    const m2 = owned("m2-vps", "m2", "aarch64", 7);
    const s = new Sim([m1, m2], () => 30);
    busy(s, "m2-vps", 3, 240);
    const [copy] = s.add(copyOf(["m1"]));
    // m1's host takes its other work meanwhile: a build of the pool's, and the copy of another maintainer's package.
    const [other] = s.add({ arch: "aarch64" });
    const [theirs] = s.add(copyOf(["m2"]));
    s.run(240);
    expect(s.startOf(copy)).toBeUndefined();
    expect(s.startOf(other)).toMatchObject({ by: "m1-studio", at: T0 });
    expect(s.startOf(theirs)).toMatchObject({ by: "m1-studio", at: T0 });
    // m2's host has a lane allowed for it the whole time: it is not held, nothing to release.
    expect(placementOf(s.fleet(), copy, s.now, R)).toEqual({ others: ["m2-vps"], mine: ["m1-studio"], held: false });
    // m2's builds end: its host takes it at once.
    s.run(1);
    expect(s.startOf(copy)).toMatchObject({ by: "m2-vps", at: T0 + 240 * MIN, lane: "native" });
    expect(s.ran.filter((r) => r.task.id === copy.id).every((r) => r.by !== "m1-studio")).toBe(true);
  });

  it("another maintainer's lane is any lane allowed for the task: an emulated one counts, at once — the requester's native host never makes it wait — and needs_native leaves only the requester's", () => {
    const vps = owned("m1-vps86", "m1", "x86_64", 7);
    const studio = owned("m2-studio", "m2", "aarch64", 11, { emulated: ["x86_64"] });
    const s = new Sim([vps, studio]);
    const [copy] = s.add(copyOf(["m1"], { arch: "x86_64" }));
    s.run(1);
    // No T to wait: the requester's host is excluded, so no native capacity is eligible for it (design v2 §8.3).
    expect(s.startOf(copy)).toMatchObject({ by: "m2-studio", lane: "emulated", at: T0 });
    // A rebuild an emulated lane sent back (needs_native): only the requester's native host has a lane allowed — held at once.
    const native = task(copyOf(["m1"], { arch: "x86_64", needs_native: true }));
    const fleet: Fleet = { members: [vps, studio], leases: [] };
    expect(mayRun(studio, native, T0, R, largestSize(fleet, T0, R))).toBe(false);
    expect(placementOf(fleet, native, T0, R)).toEqual({ others: [], mine: ["m1-vps86"], held: true });
    expect(select(vps, fleet, [native], T0, R)).toEqual([]);
    expect(select(studio, fleet, [native], T0, R)).toEqual([]);
    // Released to any host by another maintainer: the requester's host takes it.
    const released = { ...native, any_host: "m2" };
    expect(placementOf(fleet, released, T0, R)).toEqual({ others: [], mine: ["m1-vps86"], held: false });
    expect(select(vps, fleet, [released], T0, R)).toMatchObject([{ id: native.id, lane: "native" }]);
  });

  it("a single maintainer's hosts only: their own package's copy is held from the first minute — no timeout — and never taken until another maintainer releases it; anyone else's is theirs at once", () => {
    const a = owned("m1-studio", "m1", "aarch64", 11);
    const b = owned("m1-laptop", "m1", "aarch64", 5);
    const s = new Sim([a, b]);
    const [own] = s.add(copyOf(["m1"]));
    const [contributors] = s.add(copyOf(["alice", "m1"]));
    const [theirs] = s.add(copyOf(["m2"]));
    expect(placementOf(s.fleet(), own, T0, R)).toEqual({ others: [], mine: ["m1-studio", "m1-laptop"], held: true });
    s.run(600);
    expect(s.startOf(own)).toBeUndefined();
    // A contributor's package whose build m1 asked for too is m1's request as well (requestersOf), and m2's is m1's hosts' at once.
    expect(s.startOf(contributors)).toBeUndefined();
    expect(s.startOf(theirs)).toMatchObject({ by: "m1-studio", at: T0 });
    // No host alive with a lane for it at all is no hold: it waits for any host, as every build does.
    expect(placementOf({ members: [], leases: [] }, own, T0, R)).toEqual({ others: [], mine: [], held: false });
    // A drained, suspended, behind or silent host of another maintainer's, or one whose agent does not answer, is none to wait for
    // either: held, the release offered; one that can run it is.
    for (const o of [{ drained: true }, { may_claim: false }, { behind: true }, { probe_ok: false }, { seen_at: T0 - ALIVE_MS - MIN }]) {
      expect(placementOf({ members: [a, owned("m2-vps", "m2", "aarch64", 7, o)], leases: [] }, own, T0, R).held, JSON.stringify(o)).toBe(true);
    }
    expect(placementOf({ members: [a, owned("m2-vps", "m2", "aarch64", 7)], leases: [] }, own, T0, R)).toEqual({ others: ["m2-vps"], mine: ["m1-studio"], held: false });
    // Released: taken at the next claim.
    s.queue.find((t) => t.id === own.id)!.any_host = "m2";
    s.run(1);
    expect(s.startOf(own)).toMatchObject({ at: T0 + 600 * MIN });
  });

  it("pins are to a host registration: one pinned to another maintainer's host waits for that host; one pinned to its requester's host is held for a release", () => {
    const m1 = owned("m1-studio", "m1", "aarch64", 11);
    const m2 = owned("m2-vps", "m2", "aarch64", 7);
    const third = owned("m3-box", "m3", "aarch64", 7);
    const fleet: Fleet = { members: [m1, m2, third], leases: [] };
    const toM2 = task(copyOf(["m1"], { pinned_to: "m2-vps" }));
    expect(select(third, fleet, [toM2], T0, R)).toEqual([]);
    expect(select(m1, fleet, [toM2], T0, R)).toEqual([]);
    expect(select(m2, fleet, [toM2], T0, R)).toHaveLength(1);
    const toM1 = task(copyOf(["m1"], { pinned_to: "m1-studio" }));
    expect(placementOf(fleet, toM1, T0, R)).toEqual({ others: [], mine: ["m1-studio"], held: true });
    expect([m1, m2, third].flatMap((m) => select(m, fleet, [toM1], T0, R))).toEqual([]);
    expect(select(m1, fleet, [{ ...toM1, any_host: "m2" }], T0, R)).toHaveLength(1);
  });

  it("another maintainer's host that could never hold the copy — too small for its size, its pool cap 0 or below a build, its disk or agent slots short — is none to wait for: held, the release offered at once", () => {
    const studio = owned("m1-studio", "m1", "aarch64", 11);
    const vps = owned("m2-vps", "m2", "aarch64", 5);
    const fleet: Fleet = { members: [studio, vps], leases: [] };
    // The copy asks size 4 (its page, the sizing file): the largest host alive runs it, and that host is its requester's.
    const big = task(copyOf(["m1"], { size: 4, queued_at: T0 - 3 * 60 * MIN }));
    expect(largestSize(fleet, T0, R)).toBe(4);
    expect(mayRun(vps, big, T0, R, 4)).toBe(false);
    expect(placementOf(fleet, big, T0, R)).toEqual({ others: [], mine: ["m1-studio"], held: true });
    expect(select(studio, fleet, [big], T0, R)).toEqual([]);
    expect(select(vps, fleet, [big], T0, R)).toEqual([]);
    // No reservation for it either: no host it may go to could ever lease it.
    expect(reserve(fleet, [big], () => true, T0, R)).toEqual({ set: null, clear: [] });
    // Released: the requester's host builds it at the size asked — never run smaller on the other host.
    expect(select(studio, fleet, [{ ...big, any_host: "m2" }], T0, R)).toMatchObject([{ id: big.id, size: 4, asked: null }]);
    // At a size the other host holds, it waits for that host, however busy.
    expect(placementOf(fleet, task(copyOf(["m1"], { size: 2 })), T0, R)).toEqual({ others: ["m2-vps"], mine: ["m1-studio"], held: false });
    // A pool cap of 0 ("it claims nothing", routes/hosts.ts), one below a build, a disk short of a build's budget and the floor, no agent slot.
    const small = task(copyOf(["m1"]));
    for (const o of [{ units: 0 }, { units: 2 }, { disk: { work: 25, engine: 200 } }, { disk: null }, { agent_slots: 0 }]) {
      const other = owned("m2-vps", "m2", "aarch64", 5, o);
      expect(placementOf({ members: [studio, other], leases: [] }, small, T0, R), JSON.stringify(o)).toEqual({ others: [], mine: ["m1-studio"], held: true });
      expect(select(other, { members: [studio, other], leases: [] }, [small], T0, R), JSON.stringify(o)).toEqual([]);
    }
    // What a host holds now is not asked: full, it still runs the copy once its units free up.
    const full: Held[] = [0, 1].map((i) => ({ task: 9100 + i, by: "m2-vps", kind: "build", arch: "aarch64", lane: "native", units: 2, model: false, trust: "project", owner: null, disk_gb: 20 }));
    expect(placementOf({ members: [studio, vps], leases: full }, small, T0, R)).toEqual({ others: ["m2-vps"], mine: ["m1-studio"], held: false });
  });

  it("another maintainer's host that is only busy is waited for, whatever its last claim and report caught: its disk filled by the builds it runs — below the minimum for that alone —, its builds held back for disk, its memory's offer", () => {
    const studio = owned("m1-studio", "m1", "aarch64", 11);
    // m2's host: a 60 GB work root, two size-1 builds running (20 GB budgets) that filled 36 GB of it — its report below the signed
    // minimum (60 GB) for its disk alone —, its dispatcher claiming trials and audits only while a disk hold lasts, no memory offered.
    const report: Partial<Member> = { disk: { work: 24, engine: 160 }, below_minimum: true, below_disk: { work: 60, engine: 40 }, kinds: ["trial", "audit"], offer: 0 };
    const box = owned("m2-box", "m2", "aarch64", 7, report);
    const running: Held[] = [0, 1].map((i) => ({ task: 9200 + i, by: "m2-box", kind: "build", arch: "aarch64", lane: "native", units: 2, model: false, trust: "project", owner: null, disk_gb: 20 }));
    const fleet: Fleet = { members: [studio, box], leases: running };
    const copy = task(copyOf(["m1"]));
    expect(mayRun(box, copy, T0, R, largestSize(fleet, T0, R), running)).toBe(true);
    expect(placementOf(fleet, copy, T0, R)).toEqual({ others: ["m2-box"], mine: ["m1-studio"], held: false });
    // Not held: no release is offered, and the requester's host does not take it meanwhile.
    expect(select(studio, fleet, [copy], T0, R)).toEqual([]);
    // Its builds end and its report says the disk they held is free: it takes the copy.
    const idle = owned("m2-box", "m2", "aarch64", 7, { disk: { work: 60, engine: 200 } });
    expect(placementOf({ members: [studio, idle], leases: [] }, copy, T0, R)).toEqual({ others: ["m2-box"], mine: ["m1-studio"], held: false });
    expect(select(idle, { members: [studio, idle], leases: [] }, [copy], T0, R)).toMatchObject([{ id: copy.id, lane: "native" }]);
    // What lasts still decides: the same report with nothing running (its disk is short idle), or below the minimum for its CPUs or memory
    // too (no below_disk) — none to wait for, held.
    for (const [o, leases] of [[report, []], [{ ...report, below_disk: null }, running]] as [Partial<Member>, Held[]][]) {
      const other = owned("m2-box", "m2", "aarch64", 7, o);
      expect(placementOf({ members: [studio, other], leases }, copy, T0, R), JSON.stringify(o)).toEqual({ others: [], mine: ["m1-studio"], held: true });
    }
  });

  it("another maintainer's host that sleeps (#329) is none to wait for: held, the release offered at once; awake again, it takes the copy at its next claim", () => {
    const studio = owned("m1-studio", "m1", "aarch64", 11);
    const mac = owned("m2-mac", "m2", "aarch64", 7, { asleep: true });
    const s = new Sim([studio, mac]);
    const [copy] = s.add(copyOf(["m1"]));
    // Zero free units, however soon it wakes: no lane allowed for the copy, so only the requester's host has one.
    expect(mayRun(mac, copy, T0, R, largestSize(s.fleet(), T0, R))).toBe(false);
    expect(placementOf(s.fleet(), copy, T0, R)).toEqual({ others: [], mine: ["m1-studio"], held: true });
    s.run(30);
    expect(s.startOf(copy)).toBeUndefined();
    // Its agent says it woke: it is the other maintainer's host with a lane for it again — not held — and takes the copy.
    mac.asleep = false;
    expect(placementOf(s.fleet(), copy, s.now, R)).toEqual({ others: ["m2-mac"], mine: ["m1-studio"], held: false });
    s.run(1);
    expect(s.startOf(copy)).toMatchObject({ by: "m2-mac", at: T0 + 30 * MIN, lane: "native" });
  });

  it("is the project's copy's only: a contributor's build of the package, its trial and its audit go to the requester's host as to any other", () => {
    const m1 = owned("m1-studio", "m1", "aarch64", 11);
    for (const t of [task({ arch: "aarch64", trust: "community", owner: "m1" }), task({ arch: "aarch64", kind: "trial", owner: "m1" }), task({ arch: "aarch64", kind: "audit", model: true, publish_bound: true, built_by: "x", built_with: "anthropic/claude-a" })]) {
      expect(requesterHost(m1, t)).toBe(false);
      expect(select(m1, { members: [m1], leases: [] }, [t], T0, R), t.kind).toHaveLength(1);
    }
    // A registration with no owner on the row is nobody's requester.
    expect(requesterHost({ owner: null }, task(copyOf(["m1"])))).toBe(false);
  });
});

describe("the second opinion (D36): elsewhere, and with another model when one exists", () => {
  /** An audit of a build `by` built with `model`, on its machine; publish-bound when it audits the project's copy. */
  const auditOf = (by: Member, model: string, publish = true, o: Partial<Candidate> = {}) =>
    task({ arch: "aarch64", kind: "audit", model: true, trust: "project", priority: 40, publish_bound: publish, built_by: by.id, built_with: model, built_on: machineOf(by), ...o });

  it("independence, as the lease records it: model — another model judged it; host — the same model elsewhere, for an audit that does not ship; none — otherwise", () => {
    const a = owned("a", "m1", "aarch64", 11);
    const b = owned("b", "m2", "aarch64", 11);
    const c = owned("c", "m2", "aarch64", 11, { model: "openai/gpt-b" });
    expect(independenceOf(c, auditOf(a, "anthropic/claude-a"))).toBe("model");
    expect(independenceOf(c, auditOf(a, "anthropic/claude-a", false))).toBe("model");
    expect(independenceOf(b, auditOf(a, "anthropic/claude-a", false))).toBe("host");
    expect(independenceOf(a, auditOf(a, "anthropic/claude-a", false))).toBe("none");
    // A publish-bound audit is independent by its model or not at all.
    expect(independenceOf(b, auditOf(a, "anthropic/claude-a"))).toBe("none");
    // A model not known, on either side, is no other model.
    expect(independenceOf({ id: "c", model: null }, auditOf(a, "anthropic/claude-a"))).toBe("none");
    expect(independenceOf(c, auditOf(a, "", false, { built_with: null }))).toBe("host");
    expect(independenceOf(c, task({ arch: "aarch64" }))).toBeNull();
  });

  it("one provider: an audit leaves the host that built what it audits to another that can take it now, and runs on the builder when none can; the copy's audit says none, a contributor build's host", () => {
    const a = owned("a", "m1", "aarch64", 11);
    const b = owned("b", "m2", "aarch64", 11);
    const s = new Sim([a, b]);
    const copy = s.add({ ...auditOf(a, "anthropic/claude-a"), queued_at: T0 })[0];
    const contributor = s.add({ ...auditOf(a, "anthropic/claude-a", false), queued_at: T0 })[0];
    // The builder claims first, every minute: the other host takes both.
    s.run(1);
    expect(s.startOf(copy)).toMatchObject({ by: "b", independent: "none" });
    expect(s.startOf(contributor)).toMatchObject({ by: "b", independent: "host" });
    expect(needsOtherModel(s.fleet(), copy, T0)).toBe(false);
    // No other host has room: the builder takes it at once — a preference never idles it.
    const full = new Sim([a, b]);
    full.leases.push(...[0, 1].map((i) => ({ task: 7000 + i, by: "b", kind: "audit", arch: "aarch64", lane: null, units: 1, model: true, trust: "project", owner: null, disk_gb: 0, started: T0, ends: T0 + 600 * MIN })));
    const [mine] = full.add(auditOf(a, "anthropic/claude-a"));
    expect(auditElsewhere(full.fleet(), mine, T0, R, "a")).toBe(false);
    full.run(1);
    expect(full.startOf(mine)).toMatchObject({ by: "a", at: T0, independent: "none" });
    // Another host alive that does not claim (a stalled dispatcher): the builder takes it once ELSEWHERE_MS passed.
    const stalled = new Sim([a, b]);
    stalled.silent.add("b");
    const [late] = stalled.add(auditOf(a, "anthropic/claude-a", false));
    stalled.run(ELSEWHERE_MS / MIN);
    expect(stalled.startOf(late)).toBeUndefined();
    stalled.run(1);
    expect(stalled.startOf(late)).toMatchObject({ by: "a", at: T0 + ELSEWHERE_MS, independent: "none" });
    // Another host that sleeps (#329) is no machine to leave it to: zero free units, so the builder takes it at once.
    const sleeping = new Sim([a, { ...b, asleep: true }]);
    const [now] = sleeping.add(auditOf(a, "anthropic/claude-a", false));
    expect(auditElsewhere(sleeping.fleet(), now, T0, R, "a")).toBe(false);
    sleeping.run(1);
    expect(sleeping.startOf(now)).toMatchObject({ by: "a", at: T0, independent: "none" });
  });

  it("two providers: a publish-bound audit never runs on the builder's model while a host with another one is alive, however busy; it runs there, independent by model", () => {
    const a = owned("a", "m1", "aarch64", 11);
    const b = owned("b", "m2", "aarch64", 11, { model: "openai/gpt-b" });
    const s = new Sim([a, b]);
    s.leases.push(...[0, 1].map((i) => ({ task: 7100 + i, by: "b", kind: "audit", arch: "aarch64", lane: null, units: 1, model: true, trust: "project", owner: null, disk_gb: 0, started: T0, ends: T0 + 300 * MIN })));
    const [copy] = s.add(auditOf(a, "anthropic/claude-a"));
    // A contributor build's audit takes another model by preference only: b is full, so the builder takes it once ELSEWHERE_MS is up, or at once.
    const [contributor] = s.add(auditOf(a, "anthropic/claude-a", false));
    expect(otherModels(s.fleet(), copy, T0)).toEqual(["openai/gpt-b"]);
    s.run(300);
    expect(s.startOf(copy)).toBeUndefined();
    expect(s.startOf(contributor)).toMatchObject({ by: "a", at: T0, independent: "none" });
    s.run(1);
    expect(s.startOf(copy)).toMatchObject({ by: "b", at: T0 + 300 * MIN, independent: "model" });
    // The builder's own host, its model changed since: another model, so it may — independent by model.
    const changed = { ...a, model: "google/gemini-c" };
    expect(select(changed, { members: [changed, b], leases: [], models: [{ id: "b", model: "openai/gpt-b", at: T0 }] }, [auditOf(a, "anthropic/claude-a", true, { queued_at: T0 - ELSEWHERE_MS })], T0, R)).toMatchObject([{ independent: "model" }]);
  });

  it("the 24 hours: a host with another model that went quiet still holds a publish-bound audit until a day after it was last seen; then the audit runs and records none", () => {
    const a = owned("a", "m1", "aarch64", 11);
    const b = owned("b", "m2", "aarch64", 11);
    const s = new Sim([a, b]);
    // m3's host ran another model and was last seen at T0 − 23 h: it is not a member alive, its model still counts.
    s.past.push({ id: "m3-box", model: "openai/gpt-c", at: T0 - 23 * 60 * MIN });
    const [copy] = s.add(auditOf(a, "anthropic/claude-a"));
    s.run(60);
    expect(s.startOf(copy)).toBeUndefined();
    expect(needsOtherModel(s.fleet(), copy, s.now - MIN)).toBe(true);
    expect(needsOtherModel(s.fleet(), copy, s.now)).toBe(false);
    s.run(1);
    // An hour on, the day since m3's host was last seen is up: the audit runs on the builder's model — by now any host's, the builder's
    // preference spent (ELSEWHERE_MS) — and says so.
    expect(s.startOf(copy)).toMatchObject({ at: T0 + 60 * MIN, independent: "none" });
    // A drained host's model, or a registration that takes no audits, holds nothing (the route reads neither, routes/factory.ts modelsAlive).
    const drained = new Sim([a, b, owned("c", "m3", "aarch64", 11, { model: "openai/gpt-c", drained: true })]);
    expect(otherModels(drained.fleet(), copy, T0)).toEqual([]);
    const noAudits = new Sim([a, b, owned("c", "m3", "aarch64", 11, { model: "openai/gpt-c", kinds: ["build"] })]);
    expect(otherModels(noAudits.fleet(), copy, T0)).toEqual([]);
  });

  it("independence is of the machine, not the registration: the legacy role containers of one maintainer, and a host beside its own legacy set, are one machine — none; another owner's, or another host of the same owner's, is another", () => {
    // The Studio's legacy compose set until P3: community-aarch64 builds a contributor's package, review-aarch64 audits it — one machine, m1's.
    const community = legacy("community-aarch64", "aarch64", { trust: "community", owner: "m1", kinds: ["build"], model: "anthropic/claude-a" });
    const review = legacy("review-aarch64", "aarch64", { trust: "project", owner: "m1", kinds: ["audit"], model: "anthropic/claude-a" });
    const audit = auditOf(community, "anthropic/claude-a", false);
    expect(apart(machineOf(review), machineOf(community))).toBe(false);
    expect(independenceOf(review, audit)).toBe("none");
    // The canary (design v2 §21.1): the Studio's host registration beside its legacy set — one machine as well.
    const studio = owned("m1-studio", "m1", "aarch64", 11);
    expect(independenceOf(studio, audit)).toBe("none");
    expect(independenceOf(review, auditOf(studio, "anthropic/claude-a", false))).toBe("none");
    // An owner the pool does not know (a project registration of the shared token) could be anyone's: one machine, as far as it can tell.
    expect(independenceOf(legacy("pool-aarch64", "aarch64", { kinds: ["audit"], model: "anthropic/claude-a" }), auditOf(studio, "anthropic/claude-a", false))).toBe("none");
    // Another maintainer's registration, or another host of m1's own: another machine.
    const vps = owned("m2-vps", "m2", "aarch64", 7);
    expect(independenceOf(vps, audit)).toBe("host");
    expect(independenceOf(owned("m1-laptop", "m1", "aarch64", 5), auditOf(studio, "anthropic/claude-a", false))).toBe("host");
    // The preference follows the machine: review-aarch64 leaves the audit to m2's host while it can take it, for ELSEWHERE_MS…
    const fleet: Fleet = { members: [community, review, vps], leases: [] };
    const queued = { ...audit, queued_at: T0 };
    expect(auditElsewhere(fleet, queued, T0, R, "review-aarch64")).toBe(true);
    expect(select(review, fleet, [queued], T0, R)).toEqual([]);
    expect(select(vps, fleet, [queued], T0, R)).toMatchObject([{ id: audit.id, independent: "host" }]);
    // …and a registration on the builder's machine is never "elsewhere": with only the Studio's set, review-aarch64 takes it at once, none.
    const alone: Fleet = { members: [community, review, studio], leases: [] };
    expect(auditElsewhere(alone, queued, T0, R, "review-aarch64")).toBe(false);
    expect(select(review, alone, [queued], T0, R)).toMatchObject([{ id: audit.id, independent: "none" }]);
    // Through a day of the Studio's set and m2's host: every contributor build community-aarch64 makes is audited on m2's host, "host".
    const s = new Sim([community, review, owned("m2-vps", "m2", "aarch64", 7, { kinds: ["audit"] })], (t) => (t.kind === "audit" ? 5 : 20));
    s.audits = true;
    const builds = s.add({ arch: "aarch64", trust: "community", owner: "alice", model: true }, 3);
    s.run(120);
    const audits = s.ran.filter((r) => r.task.kind === "audit");
    expect(builds.every((b) => s.startOf(b)?.by === "community-aarch64")).toBe(true);
    expect(audits).toHaveLength(3);
    expect(audits.every((r) => r.by === "m2-vps" && r.independent === "host")).toBe(true);
  });

  it("a head of publish-bound audits waiting for another model hides no audit the builder's model can take: more than HEAD_LIMIT of them, a contributor build's audit behind them", () => {
    const a = owned("a", "m1", "aarch64", 11);
    const s = new Sim([a]);
    // The only host with another model was last seen an hour ago: inside the day, so every audit of the project's copy waits for it.
    s.past.push({ id: "m3-box", model: "openai/gpt-c", at: T0 - 60 * MIN });
    const copies = s.add({ ...auditOf(a, "anthropic/claude-a"), queued_at: T0 }, HEAD_LIMIT + 5);
    const [contributor] = s.add({ ...auditOf(a, "anthropic/claude-a", false), queued_at: T0 });
    s.run(1);
    expect(copies.some((c) => s.startOf(c))).toBe(false);
    expect(s.startOf(contributor)).toMatchObject({ by: "a", at: T0, independent: "none" });
    // They are its candidates all the same, read apart: the day up, it takes them.
    s.now = T0 + MODEL_WINDOW_MS;
    s.run(1);
    expect(s.ran.filter((r) => r.task.publish_bound).length).toBeGreaterThan(0);
  });

  it("a review rebuild and its audit placed across two maintainers' hosts: the rebuild off its requester's host, its audit on the other model", () => {
    const m1 = owned("m1-studio", "m1", "aarch64", 11);
    const m2 = owned("m2-vps", "m2", "aarch64", 7, { model: "openai/gpt-b" });
    const s = new Sim([m1, m2], (t) => (t.kind === "audit" ? 10 : 30));
    s.audits = true;
    const [copy] = s.add(copyOf(["m1"]));
    s.run(45);
    expect(s.startOf(copy)).toMatchObject({ by: "m2-vps", at: T0 });
    const audit = s.ran.find((r) => r.task.kind === "audit" && r.task.name === `audit-${copy.name}`)!;
    expect(audit).toMatchObject({ by: "m1-studio", at: T0 + 30 * MIN, independent: "model" });
    expect(audit.task).toMatchObject({ publish_bound: true, built_by: "m2-vps", built_with: "openai/gpt-b" });
    // The same with m2's package: its copy on m1's host, its audit on m2's model.
    const [back] = s.add(copyOf(["m2"]));
    s.run(45);
    expect(s.startOf(back)).toMatchObject({ by: "m1-studio" });
    expect(s.ran.find((r) => r.task.name === `audit-${back.name}`)).toMatchObject({ by: "m2-vps", independent: "model" });
  });
});

// The solo-maintainer exception (#394): while factory/MAINTAINERS.toml's [solo] names m1, the claim's reads say so on the project's copy of a
// package (routes/factory.ts placementCols: `solo`), and the requester-host rule (D35) does not hold for m1's own packages — m1's hosts take
// their copies, nothing waits for a release. Nobody else gains anything: another requester's hosts are still kept off a copy, and a
// contributor's package is placed as it always was.
describe("the solo-maintainer exception (#394): the requester-host rule lifted for the maintainer [solo] names, and for nobody else", () => {
  const SOLO = "m1";
  const soloCopy = (requesters: string[], o: Partial<Candidate> & { arch?: string } = {}) => copyOf(requesters, { solo: SOLO, ...o });

  it("one maintainer, one host — the Studio: m1's own copy is built there at the first claim, no release, and Review is told why", () => {
    const studio = owned("m1-studio", "m1", "aarch64", 11);
    const s = new Sim([studio], () => 30);
    const [own] = s.add(soloCopy(["m1"]));
    const [theirs] = s.add(soloCopy(["m2"]));
    // Not held: the exception's own host may take it, and placement says whose and which.
    expect(placementOf(s.fleet(), own, T0, R)).toEqual({ others: [], mine: ["m1-studio"], held: false, solo: { maintainer: "m1", hosts: ["m1-studio"] } });
    expect(requesterHost(studio, own)).toBe(false);
    s.run(1);
    expect(s.startOf(own)).toMatchObject({ by: "m1-studio", at: T0, lane: "native" });
    // Another maintainer's package is the Studio's as it always was, and its placement says nothing of the exception.
    expect(s.startOf(theirs)).toMatchObject({ by: "m1-studio", at: T0 });
    expect(placementOf(s.fleet(), theirs, T0, R)).toEqual({ others: ["m1-studio"], mine: [], held: false });
    // An emulated lane of m1's counts too, and needs_native leaves m1's native host: the exception's, so no hold either.
    const vps = owned("m1-vps86", "m1", "x86_64", 7);
    const both: Fleet = { members: [studio, vps], leases: [] };
    const native = task(soloCopy(["m1"], { arch: "x86_64", needs_native: true }));
    expect(placementOf(both, native, T0, R)).toEqual({ others: [], mine: ["m1-vps86"], held: false, solo: { maintainer: "m1", hosts: ["m1-vps86"] } });
    expect(select(vps, both, [native], T0, R)).toMatchObject([{ id: native.id, lane: "native" }]);
  });

  it("without the table the same fleet holds m1's copy for a release, as today; and the copy carries no exception unless the claim's read says so", () => {
    const studio = owned("m1-studio", "m1", "aarch64", 11);
    const s = new Sim([studio]);
    const [own] = s.add(copyOf(["m1"]));
    expect(placementOf(s.fleet(), own, T0, R)).toEqual({ others: [], mine: ["m1-studio"], held: true });
    s.run(120);
    expect(s.startOf(own)).toBeUndefined();
    // A [solo] naming m1 that the read did not carry (solo: null) is no exception either.
    expect(requesterHost(studio, { ...own, solo: null })).toBe(true);
  });

  it("another maintainer gains nothing: [solo] naming m1 keeps m2's copy off m2's hosts, and with only m2's hosts it is held for a release", () => {
    const m1 = owned("m1-studio", "m1", "aarch64", 11);
    const m2 = owned("m2-vps", "m2", "aarch64", 7);
    const fleet: Fleet = { members: [m1, m2], leases: [] };
    const theirs = task(soloCopy(["m2"]));
    expect(requesterHost(m2, theirs)).toBe(true);
    expect(select(m2, fleet, [theirs], T0, R)).toEqual([]);
    expect(placementOf(fleet, theirs, T0, R)).toEqual({ others: ["m1-studio"], mine: ["m2-vps"], held: false });
    expect(placementOf({ members: [m2], leases: [] }, theirs, T0, R)).toEqual({ others: [], mine: ["m2-vps"], held: true });
    // A package both asked for: m1's host may build it (m1's own), m2's still may not.
    const shared = task(soloCopy(["m2", "m1"]));
    expect(requesterHost(m1, shared)).toBe(false);
    expect(requesterHost(m2, shared)).toBe(true);
    expect(placementOf(fleet, shared, T0, R)).toEqual({ others: [], mine: ["m1-studio", "m2-vps"], held: false, solo: { maintainer: "m1", hosts: ["m1-studio"] } });
    // Only m2's host alive for it: held, as today — the exception's maintainer has no host that can run it.
    expect(placementOf({ members: [m2], leases: [] }, shared, T0, R)).toEqual({ others: [], mine: ["m2-vps"], held: true, solo: { maintainer: "m1", hosts: [] } });
  });

  it("a contributor's package is placed as it always was: its copy anyone's, the exception's host among them, no word of it", () => {
    const m1 = owned("m1-studio", "m1", "aarch64", 11);
    const s = new Sim([m1]);
    const [alices] = s.add(soloCopy(["alice"]));
    expect(placementOf(s.fleet(), alices, T0, R)).toEqual({ others: ["m1-studio"], mine: [], held: false });
    s.run(1);
    expect(s.startOf(alices)).toMatchObject({ by: "m1-studio", at: T0 });
  });

  it("over a simulated day on the Studio alone: every copy of m1's packages built as it arrives, none waiting for a release; another maintainer's built there as before", () => {
    const studio = owned("m1-studio", "m1", "aarch64", 11);
    // Twenty-minute rebuilds: the Studio's two agent slots hold every one of them as it comes (each copy is model work).
    const s = new Sim([studio], () => 20);
    const mine: Candidate[] = [], theirs: Candidate[] = [];
    // A copy of m1's every half hour, and one of m2's every two hours: the Studio is another maintainer's host to m2's, as without the table.
    s.run(24 * 60, (sim) => {
      if ((sim.now - T0) % (30 * MIN) === 0) mine.push(...sim.add(soloCopy(["m1"])));
      if ((sim.now - T0) % (120 * MIN) === 0) theirs.push(...sim.add(soloCopy(["m2"])));
    });
    const waited = (cs: Candidate[]) => cs.filter((c) => c.queued_at < s.now - MIN).map((c) => (s.startOf(c)?.at ?? Number.POSITIVE_INFINITY) - c.queued_at);
    // Every copy queued before the day's last minute started within a few minutes of arriving — no hold, no release asked of anyone.
    expect(waited(mine).length).toBeGreaterThan(40);
    expect(Math.max(...waited(mine))).toBeLessThanOrEqual(5 * MIN);
    expect(Math.max(...waited(theirs))).toBeLessThanOrEqual(5 * MIN);
    expect(s.ran.filter((r) => mine.includes(r.task)).every((r) => r.by === "m1-studio")).toBe(true);
  });
});
