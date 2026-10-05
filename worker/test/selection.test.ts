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
 *   spent, it is not marked again; one larger than every host alive is
 *   clamped; an emulated one of any size starts when the emulated lanes hold
 *   nothing; a claim's memory offer bounds that claim only;
 * - a drained, below-minimum, suspended or behind native host never makes an
 *   emulated lane wait;
 * - and a legacy registration as a host with one lane and one build.
 */
import { describe, expect, it } from "vitest";
import {
  alive, buildsOf, diskOf, largestSize, nativeCapacity, noRoom, ownerCap, ownersLeased, reserve, select, sizeOf, takes, thresholdMs, unitsOf,
  ALIVE_MS, HELPER_KINDS, LANE_KINDS, MIN, OWNER_DIVISOR, RESERVE_AFTER_MS, RESERVE_FOR_MS, T_MAX_MS, T_MIN_MS,
  type Candidate, type Fleet, type Held, type Member, type Mode,
} from "../src/selection";
import { selectionRules, HEAD_LIMIT, OWNERS_LIMIT, RESERVE_CANDIDATES, RESERVE_WINDOW } from "../src/routes/factory";
import { readSizing, shippedSizing } from "../src/sizing";
import { BUILD_GB_PER_SIZE, COMMUNITY_MAX_SIZE, DISK_FLOOR_GB, EMULATED_SHARE, MAX_SIZE, TASK_UNITS } from "../src/hosts";

const R = selectionRules();
const T0 = Date.parse("2026-10-01T00:00:00.000Z");

/** A host registration: its native lane, the lanes it runs emulated, its units as the pool counts them. */
function host(id: string, arch: string, units: number, o: Partial<Member> & { emulated?: string[] } = {}): Member {
  const { emulated = [], ...rest } = o;
  return {
    id, legacy: false, lanes: [{ arch, mode: "native" }, ...emulated.map((a) => ({ arch: a, mode: "emulated" as Mode }))], units, agent_slots: 2,
    disk: { work: 400, engine: 200 }, kinds: ["build", "trial", "audit", "sync", "health"], probe_ok: true, drained: false, below_minimum: false, may_claim: true, behind: false,
    seen_at: T0, reserving: null, scope: { trust: "host", owner: null, shared: false }, ...rest,
  };
}

/** A legacy registration: one lane, its arch, emulated when its labels say so. */
function legacy(id: string, arch: string, o: Partial<Member> & { emulated?: boolean; trust?: "project" | "community" } = {}): Member {
  const { emulated = false, trust = "project", ...rest } = o;
  return {
    id, legacy: true, lanes: [{ arch, mode: emulated ? "emulated" : "native" }], units: 0, agent_slots: 0, disk: null, kinds: ["build", "trial", "audit"], probe_ok: true,
    drained: false, below_minimum: false, may_claim: true, behind: false, seen_at: T0, reserving: null, scope: { trust, owner: null, shared: true }, ...rest,
  };
}

let ids = 0;
function task(o: Partial<Candidate> & { arch: string }): Candidate {
  const id = ++ids;
  return { id, name: `p${id}`, kind: "build", trust: "project", owner: null, priority: 100, queued_at: T0, pinned_to: null, needs_native: false, model: false, size: null, disk_gb: null, native_ms: null, ...o };
}

interface Lease extends Held { ends: number; started: number }
interface Ran { task: Candidate; by: string; lane: Mode | null; at: number; size: number | null; asked: number | null; share: boolean }

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
  constructor(public members: Member[], public minutes: (t: Candidate, lane: Mode | null) => number = (_t, lane) => (lane === "emulated" ? 90 : 30), public rules = R) {}
  fleet(): Fleet {
    return { members: this.members, leases: this.leases };
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
   * contributor's first build of each arch, the first native task whatever its size, the task it reserves for — and, at a host's claim,
   * the oldest builds the reservation weighs.
   */
  reads(m: Member): { candidates: Candidate[]; oldest: Candidate[] } {
    const r = this.rules, now = this.now, fleet = this.fleet(), queue = this.candidates();
    const held = m.legacy ? [] : this.leases.filter((l) => l.by === m.id);
    const largest = largestSize(fleet, now, r);
    const cap = ownerCap(fleet, now, r);
    const capped = new Set([...ownersLeased(fleet)].filter(([, n]) => n >= cap).map(([o]) => o));
    const isCapped = (c: Candidate) => c.kind === "build" && c.trust === "community" && c.owner !== null && capped.has(c.owner);
    const scope = (c: Candidate) => takes(m, c) && !(m.legacy && m.lanes[0].mode === "emulated" && c.needs_native);
    const fits = (c: Candidate) => {
      const z = sizeOf(c, largest, r)?.size ?? null;
      return !noRoom(m, held, c, unitsOf(c.kind, z, r), diskOf(c, z, r), r) && !isCapped(c);
    };
    const byOrder = (a: Candidate, b: Candidate) => a.priority - b.priority || a.id - b.id;
    const neutral = (k: string) => !LANE_KINDS.includes(k) && !HELPER_KINDS.includes(k);
    const emulatedOnly = (a: string) => !m.lanes.some((l) => l.arch === a && l.mode === "native");
    const out = new Map<number, Candidate>();
    const put = (cs: Candidate[]) => cs.forEach((c) => out.set(c.id, c));
    const owners = [...new Set(queue.filter((c) => c.trust === "community" && c.owner).map((c) => c.owner!))].sort().slice(0, OWNERS_LIMIT);
    for (const a of [...new Set(m.lanes.map((l) => l.arch))]) {
      if (m.legacy) put(queue.filter((c) => (c.arch === a || r.legacy_any_arch.includes(c.kind)) && scope(c) && fits(c)).sort(byOrder).slice(0, HEAD_LIMIT));
      else put(queue.filter((c) => c.arch === a && !neutral(c.kind) && scope(c) && fits(c) && !(emulatedOnly(a) && c.needs_native)).sort(byOrder).slice(0, HEAD_LIMIT));
      if (m.kinds.includes("build") && m.scope.trust !== "project") {
        for (const o of owners) {
          if (capped.has(o)) continue;
          put(queue.filter((c) => c.trust === "community" && c.owner === o && c.arch === a && c.kind === "build" && scope(c) && fits(c) && !(!m.legacy && emulatedOnly(a) && c.needs_native)).sort(byOrder).slice(0, 1));
        }
      }
    }
    let oldest: Candidate[] = [];
    if (!m.legacy) {
      put(queue.filter((c) => neutral(c.kind) && scope(c) && fits(c)).sort(byOrder).slice(0, HEAD_LIMIT));
      const native = m.lanes.find((l) => l.mode === "native")!.arch;
      if (m.lanes.some((l) => l.mode === "emulated")) put(queue.filter((c) => c.arch === native && LANE_KINDS.includes(c.kind) && scope(c) && !isCapped(c)).sort(byOrder).slice(0, 1));
      if (m.reserving) put(queue.filter((c) => c.id === m.reserving!.task && scope(c)));
      const hosts = this.members.filter((x) => !x.legacy && alive(x, now) && x.may_claim && !x.below_minimum && !x.drained && !x.behind);
      const runs = (c: Candidate, native: boolean) => hosts.some((x) => x.lanes.some((l) => l.arch === c.arch && (!native || l.mode === "native")));
      if (largest >= 2 && hosts.length) {
        oldest = queue
          .filter((c) => c.kind === "build" && runs(c, false) && (!c.needs_native || runs(c, true)) && !isCapped(c) && (c.pinned_to === null || hosts.some((x) => x.id === c.pinned_to)) && (c.reserved_at == null || c.reserved_at > now - RESERVE_FOR_MS))
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
        }
      }
      const c = select(m, this.fleet(), candidates, this.now, this.rules)[0];
      if (!c) return got;
      const t = this.queue.find((q) => q.id === c.id)!;
      this.queue = this.queue.filter((q) => q.id !== c.id);
      for (const x of this.members) if (x.reserving?.task === c.id) x.reserving = null;
      this.leases.push({ task: t.id, by: m.id, kind: t.kind, arch: t.arch, lane: c.lane, units: c.units, model: t.model, trust: t.trust, owner: t.owner, disk_gb: c.disk_gb ?? 0, started: this.now, ends: this.now + this.minutes(t, c.lane) * MIN });
      const r: Ran = { task: t, by: m.id, lane: c.lane, at: this.now, size: c.size, asked: c.asked, share: c.share };
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
      const t = this.ran.find((r) => r.task.id === l.task)!.task;
      if (l.lane === "native" && t.kind === "build") this.history.set(`${t.name}/${t.arch}`, l.ends - l.started);
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

  it("a mark clears when its task leaves the queue, when its host leaves, or after 2 hours — and its task is not marked again; one at a time; a size-1 build or a host that could never run it is never reserved for", () => {
    const studio = host("studio", "aarch64", 11, { reserving: { task: 1, since: T0 } });
    const t1 = { ...task({ arch: "aarch64", size: 4, queued_at: T0 - 60 * MIN }), id: 1, reserved_at: T0 };
    const busy: Held = { task: 500, by: "studio", kind: "build", arch: "aarch64", lane: "native", units: 8, model: false, trust: "project", owner: null, disk_gb: 20 };
    const waits = () => true;
    expect(reserve({ members: [studio], leases: [busy] }, [t1], waits, T0 + MIN, R)).toEqual({ set: null, clear: [] });
    // Its task leased or cancelled: gone, and the oldest marked again when it waits.
    expect(reserve({ members: [studio], leases: [busy] }, [t1], () => false, T0 + MIN, R).clear).toEqual(["studio"]);
    // Its two hours spent: the mark clears, and its task is not marked again until it is leased — the host goes back to selection.
    const later = T0 + RESERVE_FOR_MS + MIN;
    expect(reserve({ members: [{ ...studio, seen_at: later }], leases: [busy] }, [t1], waits, later, R)).toEqual({ set: null, clear: ["studio"] });
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

  it("its two hours spent, the host goes back to selection, and the task is not marked again until it is leased", () => {
    const studio = host("studio", "aarch64", 11);
    let k = 0;
    // One build ends at minute 100, the other four at 400: the size-4 task cannot fit within its window.
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
    // Two hours after the mark: cleared, not set again, and the next small build takes the two free units.
    s.now = since + RESERVE_FOR_MS - MIN;
    s.run(10);
    expect(studio.reserving).toBeNull();
    expect(s.queue.find((t) => t.id === big.id)!.reserved_at).toBe(since);
    expect(s.startOf(smalls[0])?.at).toBeGreaterThan(since + RESERVE_FOR_MS - MIN);
    s.run(60);
    expect(studio.reserving).toBeNull();
    expect(s.startOf(big)).toBeUndefined();
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
    // In the claim: the drained host's arch runs emulated at once.
    const s = new Sim([studio, box({ drained: true })]);
    const [x] = s.add({ arch: "x86_64" });
    s.run(1);
    expect(s.startOf(x)).toMatchObject({ by: "studio", lane: "emulated", at: T0 });
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
    // Its scope until #343: a project one takes no contributor's build, a dedicated community one only its owner's.
    const project = legacy("pool-aarch64", "aarch64", { trust: "project" });
    expect(select(project, { members: [project], leases: [] }, [task({ arch: "aarch64", trust: "community", owner: "alice" })], T0, R)).toEqual([]);
    const mine = legacy("dave-aarch64", "aarch64", { trust: "community", scope: { trust: "community", owner: "dave", shared: false } });
    expect(select(mine, { members: [mine], leases: [] }, [task({ arch: "aarch64", trust: "community", owner: "erin" }), task({ arch: "aarch64", trust: "community", owner: "dave" })], T0, R).map((c) => c.id)).toEqual([ids]);
  });
});
