/**
 * Selection (#337, epic #307, design v2 §8.3; D29, D30, D31, D50, D51): which
 * queued task a claim of host H is handed, decided over what the pool itself
 * knows — the registrations alive, the leases it holds, the candidates a
 * bounded read brought — and a clock. Pure: no database and no time but the
 * one given, so worker/test/selection.test.ts runs simulated fleets minute by
 * minute on a fake clock. routes/factory.ts reads the rows, calls `select`,
 * and leases the first choice with one conditional UPDATE (`… WHERE id = ?
 * AND status = 'queued'`): correctness still rests on D1's serialised write.
 *
 * A candidate is one when every filter passes for H:
 * - its kind is in H's kinds, its pin is H's or none, a model kind finds H's
 *   probe answering and an agent slot free (agent slots, like units, are
 *   counted from the pool's own leases);
 * - its units fit H's free units — the reserved job unit only for pool jobs
 *   — and a build's disk budget fits both free-disk values minus the floor
 *   and the budgets of the builds H already holds;
 * - **lane**: a build or a trial of H's native arch is on the native lane;
 *   one of an arch H runs emulated is on the emulated lane when it is not
 *   marked `needs_native` and it waited its threshold T, or no *eligible*
 *   native capacity exists for it; a job with helper containers of a ring's
 *   architecture (`health`; the ABI gate and the health checks inside
 *   `promote`, the fast-track's inside `security`) needs a lane of each
 *   architecture it checks, native or emulated, with no preference and no
 *   wait (#338); every other kind is arch-neutral;
 * - **the emulated cap** (work-conserving): H's emulated lanes hold at most
 *   ceil(builds × share) builds while a native-lane task for H is queued,
 *   builds − 1 otherwise, never below 1 — one emulated build of any size
 *   while they hold none (D50: emulated builds are never discarded, a
 *   size-4 one on a 4-build host included); what runs above it is never
 *   killed;
 * - **memory**: a claim whose dispatcher offers fewer units than it has
 *   free (MemAvailable holds fewer, design v2 §7.6) takes nothing above
 *   that offer — the host's own count, its builds and the largest size it
 *   runs stay what its units say;
 * - **reservation**: a host reserving for a large task takes that task and
 *   pool jobs only while its free units are below the task's; once they
 *   reach it, that task goes first when the host can lease it, and other
 *   work when it cannot (its owner at their cap, the memory this claim
 *   offers, an agent slot), rather than idle out the mark — as it does
 *   while its claim cannot take the task at all (its kinds this round, the
 *   probe), whatever its free units;
 * - **the per-owner cap** (D51): a contributor's community builds leased
 *   across the fleet stay within ceil(total builds / divisor), at least 1 —
 *   the divisor is a setting (`owner-cap-divisor`, 4; 0 lifts the cap);
 * - **placement** (#339, design v2 §8.4; D35, D36): the project's copy of a
 *   package — its review rebuild, publish-bound — is never handed to a host
 *   its requester owns unless another maintainer released it to any host
 *   (Review offers that release, with a passkey, as soon as only the
 *   requester's hosts have a lane allowed for it: `placementOf`); a
 *   publish-bound audit takes a model other than the one that built what it
 *   audits while a registration with another model was alive in the last 24
 *   hours; and an audit leaves the machine that built what it audits — the
 *   registration that built it, or one the pool cannot tell apart from it
 *   (`apart`) — to another that can take it now, for ELSEWHERE_MS. Each
 *   audit's lease records how independent it is (`independenceOf`).
 *
 * Order: priority, then — community builds only — how many builds their
 * owner holds leased across the fleet (fewest first: round-robin by owner),
 * then effective age (the wait minus the lane's penalty: 0 native, T
 * emulated), then id. Before that order, **the guaranteed emulated share**
 * (D50): while H holds no lease of an emulated lane e and no registration
 * alive runs e natively, the oldest candidate of e goes first.
 *
 * Legacy registrations (until #343 and P3 retire them) are selected the
 * same way as a host with one lane — their arch, emulated when their labels
 * say so — and one build: the claim itself is the proof one is idle, so
 * their own leases are not counted, and they have no units, agent slots,
 * disk or reservation of their own.
 */

export type Mode = "native" | "emulated";
export interface Lane { arch: string; mode: Mode }

/** A lease the pool holds, as selection counts it. */
export interface Held {
  task: number;
  /** The registration that holds it. */
  by: string;
  kind: string;
  arch: string;
  lane: Mode | null;
  units: number;
  /** Model work (AGENT_SCOPE): counted against agent slots. */
  model: boolean;
  trust: string;
  owner: string | null;
  disk_gb: number;
}

/**
 * What a registration takes besides its kinds: a host takes every trust
 * (§8.2); a legacy one keeps today's scope until #343 deletes it — a
 * project registration no contributor's build, a community one community
 * builds only, its owner's unless it is shared.
 */
export interface Scope { trust: "host" | "project" | "community"; owner: string | null; shared: boolean }

/** A registration of the fleet. */
export interface Member {
  id: string;
  legacy: boolean;
  lanes: Lane[];
  /** What the pool hands it at most: min(declared units, units recomputed with the signed constants, the pool's cap). */
  units: number;
  agent_slots: number;
  disk: { work: number; engine: number } | null;
  kinds: string[];
  probe_ok: boolean;
  drained: boolean;
  below_minimum: boolean;
  /**
   * Below the minimum (D44) for its free disk alone, its CPUs and memory meeting it: the free disk the minimum asks of its work root and
   * its engine's data root. Placement judges such a host by its disk once idle (`mayRun`): the builds it runs fill it for a while.
   */
  below_disk?: { work: number; engine: number } | null;
  /** A host active with its owner listed; a legacy registration not revoked. */
  may_claim: boolean;
  /** Behind the pool's release past the grace: handed nothing (426). */
  behind: boolean;
  /** The pool's time of its last claim, ms, and how long that counts as alive (ALIVE_MS unless said: a legacy row is written less often). */
  seen_at: number;
  alive_ms?: number;
  reserving: { task: number; since: number } | null;
  scope: Scope;
  /** A legacy registration's row names a task in hand (current_task): not idle, whatever the leases say. */
  busy?: boolean;
  /**
   * The claimer only: the units its dispatcher offers this round when MemAvailable holds fewer than its free units (design v2 §7.6) —
   * no task above it. Undefined: its units decide.
   */
  offer?: number;
  /** Whose registration it is (build_workers.owner: a host's owner login), for the requester-host rule (D35). */
  owner?: string | null;
  /** The model its claims say it runs, "<provider>/<model>" (the claim's `agent`), for the second opinion (D36). */
  model?: string | null;
  /** A host's registration: its host (hosts.id), the machine it runs on (D36, `apart`); none for a legacy one. */
  host_id?: string | null;
}

export interface Candidate {
  id: number;
  name: string;
  kind: string;
  arch: string;
  trust: string;
  owner: string | null;
  priority: number;
  /** When it was queued, ms. */
  queued_at: number;
  pinned_to: string | null;
  needs_native: boolean;
  model: boolean;
  /** The size asked for — a Retry at size, the package's page, factory/sizing — before any clamp; null: 1. */
  size: number | null;
  /** The disk budget set for it; null: its size × the signed GB per size. */
  disk_gb: number | null;
  /** The last native build's duration of this package and arch (build_tasks.duration_ms, lane = 'native'), for T. */
  native_ms: number | null;
  /** When a host was last marked reserving for it, ms (build_tasks.reserved_at): two hours later its window is spent, and it is marked again no sooner than 30 minutes after. */
  reserved_at?: number | null;
  /** The one ring architecture a job names (`params.arch`: a promotion of one architecture); none, it covers both. */
  job_arch?: string | null;
  /**
   * Publish-bound (#339): a build that is the project's copy of a package — its review rebuild, published once a maintainer approves
   * it — or an audit of one.
   */
  publish_bound?: boolean;
  /** A publish-bound build's requesters (D35): who asked for the package — the rebuild's owner, and the owner of the contributor's build it answers. */
  requesters?: string[];
  /** A publish-bound build another maintainer released to any host (D35), with their passkey: their login; none while it is not. */
  any_host?: string | null;
  /** An audit's: the registration that built what it audits, and the model that built it (its `built_with`, else that registration's). */
  built_by?: string | null;
  built_with?: string | null;
  /** An audit's: the machine that built what it audits, as far as the pool tells machines apart — that registration's owner, and its host when it is a host's (`apart`, D36). */
  built_on?: Machine | null;
}

/** A registration's machine, as far as the pool tells machines apart (D36): whose registration it is, and its host when it is a host's. */
export interface Machine { owner?: string | null; host_id?: string | null }

/** The signed constants (hosts.ts, factory/bundle/manifest.toml) and the settings selection runs with. */
export interface Rules {
  build_per_size: number;
  trial: number;
  audit: number;
  job: number;
  job_reserved: number;
  max_size: number;
  community_max_size: number;
  gb_per_size: number;
  floor_gb: number;
  /** capacity.emulated.share_when_native_waits. */
  emulated_share: number;
  /** owner-cap-divisor: a contributor holds at most ceil(total builds / this) community builds; 0 lifts the cap. */
  owner_divisor: number;
  /** What a legacy registration of any arch takes (routes/factory.ts ANY_ARCH_KINDS): its own arch otherwise. */
  legacy_any_arch: readonly string[];
}

/**
 * The fleet: the registrations alive, every lease the pool holds and — for
 * the second opinion (D36) — the models of the registrations that take
 * audits, as their claims said them, with when each last answered (the
 * route reads the last MODEL_WINDOW_MS of them, routes/factory.ts
 * modelsAlive, only when a publish-bound audit is among the candidates).
 */
export interface Fleet { members: Member[]; leases: Held[]; models?: { id: string; model: string; at: number }[] }

/** How independent an audit is of what it audits (D36): another model judged it, the same model on another host, or neither. */
export type Independence = "model" | "host" | "none";

/** A candidate H may take, as its lease is written. */
export interface Choice {
  id: number;
  lane: Mode | null;
  /** A build's size at lease (null for other kinds), and the size asked when the fleet alive clamped it. */
  size: number | null;
  asked: number | null;
  units: number;
  disk_gb: number | null;
  /** first: the guaranteed emulated share put it ahead of the order. */
  share: boolean;
  /** An audit's independence on H (`build_tasks.independent`, #339); null for every other kind. */
  independent: Independence | null;
}

export const MIN = 60_000;
/** A registration is alive when it claimed this recently (§8.3). */
export const ALIVE_MS = 2 * MIN;
/** T: twice the last native duration, clamped to 3..60 minutes; 3 with no native history (today's first pick). */
export const T_MIN_MS = 3 * MIN;
export const T_MAX_MS = 60 * MIN;
/** The oldest queued build waits this long before a host reserves for it, and a mark lasts this long at most. */
export const RESERVE_AFTER_MS = 30 * MIN;
export const RESERVE_FOR_MS = 120 * MIN;
/** D36: a registration with another model counts for a publish-bound audit while it was alive this recently. */
export const MODEL_WINDOW_MS = 24 * 60 * MIN;
/**
 * D36: how long an audit is left by the registration that built what it audits to another that can take it now — today's first pick
 * (T's floor): an idle host claims every 30 seconds, so this is time enough for one to, and a preference never idles the builder for
 * longer.
 */
export const ELSEWHERE_MS = T_MIN_MS;

/**
 * Whether a task's reservation window lapsed less than RESERVE_AFTER_MS ago (`reserved_at`, the time of its last mark): it is not
 * marked again meanwhile, so the host that held it takes other work — a mark holds a host back two hours at a time, never for good —
 * and then it waits its turn again as a build queued 30 minutes does. Never marked again would leave a large build whose host ran
 * something longer than the window unstarted for good under a steady flow of small builds (#337).
 */
export function cooling(reservedAt: number | null | undefined, now: number): boolean {
  return reservedAt != null && reservedAt <= now - RESERVE_FOR_MS && reservedAt > now - RESERVE_FOR_MS - RESERVE_AFTER_MS;
}

/** The per-owner cap's divisor when the setting is absent (D51). */
export const OWNER_DIVISOR = 4;

/** Scheduled by lane, native preferred: they run the task's architecture. */
export const LANE_KINDS: readonly string[] = ["build", "trial"];
/**
 * Jobs whose helper containers run the task's architecture: any lane of it, no preference, no wait. Seam (#340): hosts claim pool
 * jobs from #340 (routes/factory.ts HOST_KINDS is builds, trials and audits until then), so on a host this rule and RING_JOBS's
 * run end to end with it; legacy registrations keep today's rule.
 */
export const HELPER_KINDS: readonly string[] = ["health"];
/** The architectures a ring serves. */
export const RING_ARCHES: readonly string[] = ["x86_64", "aarch64"];
/**
 * Jobs whose helper containers run each ring architecture they cover (#338): `promote` runs the ABI gate (tests/abi-gate.sh) and the
 * health check (tests/health-check.sh) of every architecture it promotes — `params.arch`, or both — and `security` a fast-track's
 * health checks of both. Their own process is arch-neutral (they are read with the arch-neutral kinds, whatever their row's arch),
 * but a host takes one only with a lane — native or emulated, no preference, no wait — of each architecture its helpers run: a
 * promotion whose x86_64 health check could not start would roll a good release back.
 */
export const RING_JOBS: readonly string[] = ["promote", "security"];

/** The architectures a job's helper containers run, or null for a kind that starts none. */
export function helperArches(c: Pick<Candidate, "kind" | "arch" | "job_arch">): readonly string[] | null {
  if (HELPER_KINDS.includes(c.kind)) return [c.arch];
  if (c.kind === "promote") return c.job_arch && RING_ARCHES.includes(c.job_arch) ? [c.job_arch] : RING_ARCHES;
  if (c.kind === "security") return RING_ARCHES;
  return null;
}
/** What is not a pool job: these never take the reserved job unit. */
export const TASK_KINDS: readonly string[] = ["build", "trial", "audit"];

export const alive = (m: Pick<Member, "seen_at" | "alive_ms">, now: number): boolean => m.seen_at > now - (m.alive_ms ?? ALIVE_MS);

/** The threshold an emulated candidate waits for native capacity (D50). */
export function thresholdMs(nativeMs: number | null): number {
  if (nativeMs === null || !(nativeMs > 0)) return T_MIN_MS;
  return Math.min(T_MAX_MS, Math.max(T_MIN_MS, 2 * nativeMs));
}

/** A registration's builds: floor((units − the reserved job unit) / a build's units); a legacy one's is one, when it takes builds. */
export function buildsOf(m: Pick<Member, "legacy" | "units" | "kinds">, r: Rules): number {
  if (m.legacy) return m.kinds.includes("build") ? 1 : 0;
  return Math.max(0, Math.floor((m.units - r.job_reserved) / r.build_per_size));
}

const counts = (m: Member, now: number) => alive(m, now) && m.may_claim && !m.below_minimum;

/** The largest size the fleet alive runs (D31): a task's size is clamped to it at claim time, so it never waits for a host that left. At least 1. */
export function largestSize(fleet: Fleet, now: number, r: Rules): number {
  let best = 1;
  for (const m of fleet.members) if (counts(m, now)) best = Math.max(best, Math.min(r.max_size, buildsOf(m, r)));
  return best;
}

/** The size a build asks for, clamped to the signed maximum (a contributor's lower), and the one it gets at most. */
export function sizeOf(c: Pick<Candidate, "kind" | "trust" | "size">, largest: number, r: Rules): { size: number; asked: number } | null {
  if (c.kind !== "build") return null;
  const max = c.trust === "community" ? r.community_max_size : r.max_size;
  const asked = Math.min(Math.max(c.size ?? 1, 1), max);
  return { size: Math.min(asked, largest), asked };
}

/** The units a task takes (D30): a build 2 per size, a trial 2, an audit 1, a pool job 1. */
export function unitsOf(kind: string, size: number | null, r: Rules): number {
  if (kind === "build") return r.build_per_size * (size ?? 1);
  if (kind === "trial") return r.trial;
  if (kind === "audit") return r.audit;
  return r.job;
}

/** A build's disk budget: the one set for it, or its size × the signed GB per size. */
export function diskOf(c: Pick<Candidate, "kind" | "disk_gb">, size: number | null, r: Rules): number | null {
  if (c.kind !== "build") return null;
  return c.disk_gb ?? r.gb_per_size * (size ?? 1);
}

/** The lane a registration would run a candidate on, or null when it has none for it; `byLane` when native is preferred and the emulated lane waits. */
export function laneFor(m: Pick<Member, "lanes" | "legacy">, c: Pick<Candidate, "kind" | "arch" | "job_arch">, r: Rules): { mode: Mode | null; byLane: boolean } | null {
  const lanes = m.lanes.filter((l) => l.arch === c.arch);
  const native = lanes.some((l) => l.mode === "native");
  if (LANE_KINDS.includes(c.kind)) {
    if (native) return { mode: "native", byLane: true };
    return lanes.length ? { mode: "emulated", byLane: true } : null;
  }
  if (m.legacy) {
    // Today's rule for a legacy registration's one lane: its own arch, or a kind any arch runs.
    if (lanes.length) return { mode: lanes[0].mode, byLane: false };
    return r.legacy_any_arch.includes(c.kind) ? { mode: null, byLane: false } : null;
  }
  if (HELPER_KINDS.includes(c.kind)) return lanes.length ? { mode: native ? "native" : "emulated", byLane: false } : null;
  // A ring job's helpers: a lane of every architecture they run, whichever mode; the job itself runs in the dispatcher's own process.
  const helpers = helperArches(c);
  if (helpers && !helpers.every((a) => m.lanes.some((l) => l.arch === a))) return null;
  return { mode: null, byLane: false };
}

/** Whether a registration takes a candidate at all: its kinds, the pin, the probe for model work, and a legacy one's scope. */
export function takes(m: Member, c: Candidate): boolean {
  if (!m.kinds.includes(c.kind)) return false;
  if (c.pinned_to !== null && c.pinned_to !== m.id) return false;
  if (c.model && !m.probe_ok) return false;
  const s = m.scope;
  if (s.trust === "project" && c.kind === "build" && c.trust === "community") return false;
  if (s.trust === "community" && !(c.trust === "community" && (s.shared || c.owner === s.owner || c.pinned_to === m.id))) return false;
  return true;
}

/** The leases a registration holds, as its own count reads them: a legacy one's never (the claim is the proof it is idle). */
function heldBy(fleet: Fleet, m: Member): Held[] {
  return m.legacy ? [] : fleet.leases.filter((l) => l.by === m.id);
}

/** Why a candidate does not fit a host's free capacity now, or null: units (the reserved one for pool jobs only), agent slots, disk. */
export function noRoom(m: Member, held: Held[], c: Pick<Candidate, "kind" | "model">, units: number, disk: number | null, r: Rules): string | null {
  // A legacy registration is one build: any one task of a build's units or fewer.
  if (m.legacy) return units > r.build_per_size ? "units" : null;
  const used = held.reduce((n, l) => n + l.units, 0);
  const limit = TASK_KINDS.includes(c.kind) ? m.units - r.job_reserved : m.units;
  if (used + units > limit) return "units";
  // The memory available holds fewer than the free units: this claim takes only what still fits (§7.6).
  if (m.offer !== undefined && units > m.offer) return "memory";
  if (c.model && held.filter((l) => l.model).length >= m.agent_slots) return "agent slot";
  if (c.kind === "build") {
    if (!m.disk) return "disk";
    const budgets = held.reduce((n, l) => n + (l.kind === "build" ? l.disk_gb : 0), 0);
    const free = Math.min(m.disk.work, m.disk.engine) - budgets;
    if ((disk ?? 0) + r.floor_gb > free) return "disk";
  }
  return null;
}

/** A host's reservation mark, while it holds: not past RESERVE_FOR_MS. */
export function reservingNow(m: Pick<Member, "reserving">, now: number): { task: number; since: number } | null {
  return m.reserving && m.reserving.since > now - RESERVE_FOR_MS ? m.reserving : null;
}

/**
 * Eligible native capacity for a candidate (§8.3): a registration other than
 * `except`, alive, with a native lane of its arch, whose claim would pass
 * every filter for it now — kinds, pin, probe, scope, not drained, not below
 * the minimum, not behind, not reserving for another task, units, agent slot
 * and disk free (a legacy one: holding nothing). A drained host, or one the
 * requester-host rule excludes (D35), never makes an emulated lane wait.
 */
export function nativeCapacity(fleet: Fleet, c: Candidate, now: number, r: Rules, except: string): boolean {
  const largest = largestSize(fleet, now, r);
  const s = sizeOf(c, largest, r);
  const units = unitsOf(c.kind, s?.size ?? null, r);
  const disk = diskOf(c, s?.size ?? null, r);
  for (const x of fleet.members) {
    if (x.id === except || !counts(x, now) || x.drained || x.behind) continue;
    if (!x.lanes.some((l) => l.arch === c.arch && l.mode === "native")) continue;
    if (!takes(x, c) || requesterHost(x, c)) continue;
    const mark = reservingNow(x, now);
    if (mark && mark.task !== c.id) continue;
    if (x.legacy && (x.busy || fleet.leases.some((l) => l.by === x.id))) continue;
    if (noRoom(x, heldBy(fleet, x), c, units, disk, r)) continue;
    return true;
  }
  return false;
}

// ---------- placement (#339, design v2 §8.4; D35, D36) ----------

/** The project's copy of a package (D35): a publish-bound build — its review rebuild. */
const projectCopy = (c: Pick<Candidate, "kind" | "publish_bound">): boolean => c.kind === "build" && !!c.publish_bound;

/**
 * The requester-host rule (D35): a registration of one of the package's
 * requesters never takes the project's copy of it — the review rebuild,
 * published once another maintainer approves it — unless another
 * maintainer released it to any host. Its leases elsewhere are untouched:
 * a contributor's build of it, its trial and its audit go anywhere.
 */
export function requesterHost(m: Pick<Member, "owner">, c: Pick<Candidate, "kind" | "publish_bound" | "requesters" | "any_host">): boolean {
  return projectCopy(c) && !c.any_host && m.owner != null && (c.requesters ?? []).includes(m.owner);
}

/**
 * Whether a registration has a lane allowed for a task (D35's "can run"):
 * alive and claiming (not drained, behind or below the minimum), taking it —
 * its kinds, the pin, the probe for model work, its scope — on a lane of its
 * arch, native or emulated, with `needs_native` applied, and able to hold it
 * once it holds nothing: the task's units within its count (its pool cap
 * applied; the reserved job unit kept), an agent slot for model work, and a
 * build's disk budget within its free disk less the floor — at the size the
 * task gets in the fleet alive (`largest`, D31), the maintainer's size kept.
 * A host whose cap is 0 or below the task, or too small for it, never takes
 * it: as a drained one, it is none to wait for. What it holds now is not
 * asked: a busy host runs it once its units free up. Nor is the moment its
 * last claim and report caught: what its memory offered that round; its
 * free disk, which the builds it runs (`held`, its leases) are filling (the
 * budgets they hold come back when they end), and the minimum that disk
 * alone keeps it below (`below_disk`); and the builds its dispatcher leaves
 * out of its claims while a disk hold lasts (crates/pkg-repo dispatch
 * KINDS_HELD, DISK_HOLD at most) — every host takes builds (routes/factory.ts
 * HOST_KINDS). An estimate that runs high only makes the copy wait for that
 * host until it is idle, when its own report decides.
 */
export function mayRun(m: Member, c: Candidate, now: number, r: Rules, largest: number, held: readonly Held[] = []): boolean {
  const idle = m.legacy ? m : { ...m, offer: undefined, kinds: m.kinds.includes("build") ? m.kinds : [...m.kinds, "build"], disk: m.disk && idleDisk(m.disk, held) };
  const below = m.below_minimum && !(m.below_disk && idle.disk && idle.disk.work >= m.below_disk.work && idle.disk.engine >= m.below_disk.engine);
  if (!alive(m, now) || !m.may_claim || below || m.drained || m.behind || !takes(idle, c)) return false;
  const lane = laneFor(m, c, r);
  if (!lane || (lane.byLane && lane.mode === "emulated" && c.needs_native)) return false;
  const size = sizeOf(c, largest, r)?.size ?? null;
  return !noRoom(idle, [], c, unitsOf(c.kind, size, r), diskOf(c, size, r), r);
}

/** A host's free disk once the builds it holds end: what it reported, and the budgets they hold back. */
function idleDisk(d: { work: number; engine: number }, held: readonly Held[]): { work: number; engine: number } {
  const budgets = held.reduce((n, l) => n + (l.kind === "build" ? l.disk_gb : 0), 0);
  return { work: d.work + budgets, engine: d.engine + budgets };
}

/** Where the project's copy of a package may run (D35): who may run it, and whether it waits for another maintainer's release. */
export interface Placement {
  /** The registrations of maintainers other than its requesters that have a lane allowed for it. */
  others: string[];
  /** Its requesters' own registrations that have one. */
  mine: string[];
  /** Only its requesters' registrations have one, and nobody released it to any host: Review offers another maintainer the release, at once. */
  held: boolean;
}

/**
 * The placement of the project's copy of a package (D35, design v2 §8.4):
 * while another maintainer's registration has a lane allowed for it, it
 * waits for that one, however busy; when only its requesters' have one, it
 * is `held` — it waits, and Review offers another maintainer, at once and
 * not after a timeout, the release to any host with their passkey. A task
 * nobody can run now (no lane alive at all) is not held: it waits for any
 * host, as every build does.
 */
export function placementOf(fleet: Fleet, c: Candidate, now: number, r: Rules): Placement {
  const others: string[] = [], mine: string[] = [];
  if (projectCopy(c)) {
    const largest = largestSize(fleet, now, r);
    for (const m of fleet.members) {
      if (m.owner == null || !mayRun(m, c, now, r, largest, heldBy(fleet, m))) continue;
      ((c.requesters ?? []).includes(m.owner) ? mine : others).push(m.id);
    }
  }
  return { others, mine, held: projectCopy(c) && !c.any_host && !others.length && mine.length > 0 };
}

/** The models other than the one that built what an audit audits, of the registrations alive with one in the last 24 hours (D36). */
export function otherModels(fleet: Fleet, c: Pick<Candidate, "built_with">, now: number): string[] {
  if (!c.built_with) return [];
  return [...new Set((fleet.models ?? []).filter((x) => x.at > now - MODEL_WINDOW_MS && x.model !== c.built_with).map((x) => x.model))];
}

/**
 * The second opinion's model rule (D36): an audit of a publish-bound build
 * takes another model than the one that built it whenever a registration
 * with another model was alive in the last 24 hours — a host that went
 * quiet an hour ago still holds it, so a one-provider fleet's audits are
 * never "another agent" by accident of who claimed first; with none, the
 * audit runs on the same model and says so (`independent: none`).
 */
export function needsOtherModel(fleet: Fleet, c: Candidate, now: number): boolean {
  return c.kind === "audit" && !!c.publish_bound && otherModels(fleet, c, now).length > 0;
}

/** Whether a registration runs another model than the one that built what an audit audits: both known, and not the same. */
const anotherModel = (m: Pick<Member, "model">, c: Pick<Candidate, "built_with">): boolean => !!m.model && !!c.built_with && m.model !== c.built_with;

/**
 * Whether two registrations are certainly on different machines (D36):
 * different owners, or the registrations of two different hosts. Anything
 * else may be one machine: the legacy role containers of one maintainer —
 * the Studio's `community-*` builds a contributor's package and its
 * `review-*` audits it, until #343 — or a host's registration beside its own
 * legacy set during the canary (§21.1), or an owner the pool does not know.
 */
export function apart(a: Machine, b: Machine): boolean {
  if (a.owner != null && b.owner != null && a.owner !== b.owner) return true;
  return a.host_id != null && b.host_id != null && a.host_id !== b.host_id;
}

/** Whether a registration may be on the machine that built what an audit audits: the registration that built it, or one the pool cannot tell apart from it. */
const besideBuilder = (m: Pick<Member, "id" | "owner" | "host_id">, c: Pick<Candidate, "built_by" | "built_on">): boolean =>
  c.built_by != null && (m.id === c.built_by || !apart(m, c.built_on ?? {}));

/**
 * Whether a registration other than `except`, on another machine than the
 * one that built what an audit audits (`apart`), could take it now (D36:
 * the second opinion prefers another host): alive and claiming, taking it,
 * with the model the rule asks for, not reserving for another task, its
 * units and an agent slot free (a legacy one: holding nothing).
 */
export function auditElsewhere(fleet: Fleet, c: Candidate, now: number, r: Rules, except: string): boolean {
  const model = needsOtherModel(fleet, c, now);
  for (const x of fleet.members) {
    if (x.id === except || besideBuilder(x, c) || !counts(x, now) || x.drained || x.behind) continue;
    if (!takes(x, c) || !laneFor(x, c, r) || (model && !anotherModel(x, c))) continue;
    const mark = reservingNow(x, now);
    if (mark && mark.task !== c.id) continue;
    if (x.legacy && (x.busy || fleet.leases.some((l) => l.by === x.id))) continue;
    if (noRoom(x, heldBy(fleet, x), c, unitsOf(c.kind, null, r), null, r)) continue;
    return true;
  }
  return false;
}

/**
 * How independent an audit leased to `m` is of what it audits (D36), as
 * its lease records it: `model` — another model judges the build; `host` —
 * the same model (or one not known) on a machine certainly not the one that
 * built it (`apart`: another owner's, or another host's registration — never
 * a legacy role container beside the builder's, which says `none`); `none` —
 * neither. A publish-bound audit is independent by
 * its model or not at all: the project's copy is the recipe a model wrote,
 * and the same model on another host is no second opinion of it — so the
 * share of publish-bound audits that say `none` is what asks one host to
 * run another model (#324). Null for every other kind.
 */
export function independenceOf(m: Pick<Member, "id" | "model" | "owner" | "host_id">, c: Pick<Candidate, "kind" | "publish_bound" | "built_by" | "built_with" | "built_on">): Independence | null {
  if (c.kind !== "audit") return null;
  if (anotherModel(m, c)) return "model";
  if (!c.publish_bound && c.built_by != null && !besideBuilder(m, c)) return "host";
  return "none";
}

/** The per-owner cap (D51): at most ceil(the alive fleet's builds / divisor), at least 1; none when the divisor is 0. */
export function ownerCap(fleet: Fleet, now: number, r: Rules): number {
  if (!(r.owner_divisor > 0)) return Number.POSITIVE_INFINITY;
  const total = fleet.members.reduce((n, m) => n + (counts(m, now) ? buildsOf(m, r) : 0), 0);
  return Math.max(1, Math.ceil(total / r.owner_divisor));
}

const communityBuild = (t: { kind: string; trust: string }) => t.kind === "build" && t.trust === "community";

/** Each owner's community builds leased across the fleet. */
export function ownersLeased(fleet: Fleet): Map<string, number> {
  const n = new Map<string, number>();
  for (const l of fleet.leases) if (communityBuild(l) && l.owner) n.set(l.owner, (n.get(l.owner) ?? 0) + 1);
  return n;
}

/**
 * The candidates H may take now, in the order it takes them: the first is
 * leased; when another host took it first (its UPDATE changed nothing), the
 * next. `fleet` holds every lease the pool holds and the registrations
 * alive; H is one of its members.
 */
export function select(H: Member, fleet: Fleet, candidates: Candidate[], now: number, r: Rules): Choice[] {
  const held = heldBy(fleet, H);
  const largest = largestSize(fleet, now, r);
  const cap = ownerCap(fleet, now, r);
  const leased = ownersLeased(fleet);
  const mark = H.legacy ? null : reservingNow(H, now);
  // A host reserving for a large task takes that task and pool jobs only while its free units are below the task's (§8.3: "until its
  // free units reach the task's size"). Once they reach it the task goes first when H can lease it; when it cannot — its owner at their
  // cap, the memory this claim offers, an agent slot, T — H takes other work rather than idle out the mark. A mark whose task is not
  // among the candidates holds nothing: the claim's reads are filtered by what H takes now (its kinds this round — none but trials
  // and audits while its dispatcher holds builds for disk —, the probe, the pin), so that task is one this claim could never lease,
  // and holding for it would idle H until the mark's two hours are up. A mark set at this very claim, after the reads, comes with its
  // task (routes/factory.ts selectAndLease adds it): it fits no host now, so it holds while H's free units are below it.
  const marked = mark ? candidates.find((c) => c.id === mark.task) : undefined;
  const free = H.units - r.job_reserved - held.reduce((n, l) => n + l.units, 0);
  const holding = mark !== null && marked !== undefined && free < unitsOf(marked.kind, sizeOf(marked, largest, r)?.size ?? null, r);
  const pool = holding ? candidates.filter((c) => c.id === mark.task || !TASK_KINDS.includes(c.kind)) : candidates;
  // A native-lane task for H is queued: the emulated lanes keep to their share while it waits.
  const nativeQueued = pool.some((c) => takes(H, c) && laneFor(H, c, r)?.mode === "native" && LANE_KINDS.includes(c.kind));
  const builds = buildsOf(H, r);
  const emulatedCap = Math.max(1, nativeQueued ? Math.ceil(builds * r.emulated_share) : builds - 1) * r.build_per_size;
  const emulatedHeld = held.reduce((n, l) => n + (l.lane === "emulated" && LANE_KINDS.includes(l.kind) ? l.units : 0), 0);
  const ok: (Choice & { c: Candidate; age: number; ownerKey: number })[] = [];
  for (const c of pool) {
    if (!takes(H, c)) continue;
    // The project's copy of a package is not built on its requester's host (D35): it waits for another maintainer's, or their release.
    if (requesterHost(H, c)) continue;
    if (c.kind === "audit") {
      // The second opinion (D36): a publish-bound audit takes another model while one was alive in the last 24 hours, and an audit
      // leaves the machine that built what it audits — its registration, or one the pool cannot tell apart from it — to another that
      // can take it now, for ELSEWHERE_MS.
      if (needsOtherModel(fleet, c, now) && !anotherModel(H, c)) continue;
      if (besideBuilder(H, c) && now - c.queued_at < ELSEWHERE_MS && auditElsewhere(fleet, c, now, r, H.id)) continue;
    }
    const lane = laneFor(H, c, r);
    if (!lane) continue;
    const s = sizeOf(c, largest, r);
    const units = unitsOf(c.kind, s?.size ?? null, r);
    const disk = diskOf(c, s?.size ?? null, r);
    if (noRoom(H, held, c, units, disk, r)) continue;
    let penalty = 0;
    if (lane.byLane && lane.mode === "emulated") {
      if (c.needs_native) continue;
      const T = thresholdMs(c.native_ms);
      if (now - c.queued_at < T && nativeCapacity(fleet, c, now, r, H.id)) continue;
      // Never below one: while H's emulated lanes hold nothing, one emulated build of any size (D50), else a size-4 build on a host
      // of four or five builds would never start emulated.
      if (!H.legacy && emulatedHeld > 0 && emulatedHeld + units > emulatedCap) continue;
      penalty = T;
    }
    if (communityBuild(c) && c.owner && (leased.get(c.owner) ?? 0) >= cap) continue;
    ok.push({
      id: c.id, lane: lane.mode, size: s?.size ?? null, asked: s && s.size < s.asked ? s.asked : null, units, disk_gb: disk, share: false, independent: independenceOf(H, c),
      c, age: now - c.queued_at - penalty, ownerKey: communityBuild(c) && c.owner ? leased.get(c.owner) ?? 0 : 0,
    });
  }
  ok.sort((a, b) => a.c.priority - b.c.priority || a.ownerKey - b.ownerKey || b.age - a.age || a.id - b.id);
  // The guaranteed emulated share (D50): an emulated lane H holds no lease of, whose arch no registration alive runs natively.
  const starved = (arch: string) =>
    (H.legacy || !held.some((l) => l.lane === "emulated" && l.arch === arch)) &&
    !fleet.members.some((m) => alive(m, now) && m.may_claim && m.lanes.some((l) => l.arch === arch && l.mode === "native"));
  const shared = ok
    .filter((x) => x.lane === "emulated" && LANE_KINDS.includes(x.c.kind) && starved(x.c.arch))
    .sort((a, b) => a.c.queued_at - b.c.queued_at || a.id - b.id)[0];
  const order = shared ? [{ ...shared, share: true }, ...ok.filter((x) => x !== shared)] : ok;
  // The task H reserves for goes first once it fits: the units were kept for it, whatever arrived since.
  const own = marked ? order.findIndex((x) => x.id === marked.id) : -1;
  if (own > 0) order.unshift(...order.splice(own, 1));
  return order.map(({ id, lane, size, asked, units, disk_gb, share, independent }) => ({ id, lane, size, asked, units, disk_gb, share, independent }));
}

/**
 * Reservation for large tasks (§8.3): the oldest queued build a host could
 * be kept for — one that waited more than 30 minutes, is larger than one
 * build after the clamp (a size-1 build fits the next build that ends, so
 * nothing needs keeping for it), is not held back by its owner's cap, and
 * some host alive could lease once its units are free (selection on that
 * host as if it held nothing: its lanes, T, the emulated cap,
 * `needs_native`, its disk) — so an older build that waits for another
 * reason (a `needs_native` one on an aarch64-only fleet, a capped
 * contributor's) never turns the reservation off. When it fits no
 * registration now, the host with the most free units among those that
 * could is marked reserving for it. `oldest` is the queue's oldest builds,
 * in its order (routes/factory.ts reads them bounded). One mark at a time;
 * it clears when its task is leased (routes/factory.ts) or leaves the
 * queue, when its host leaves, or after 2 hours — and a task whose 2 hours
 * are spent is not marked again for 30 minutes (`reserved_at`, `cooling`):
 * a mark bounds how long a host holds back work for one task at a time,
 * and the task still starts when its host ran something longer than the
 * window. Returns the marks to write: `set` a host's new mark, `clear` the
 * hosts whose mark ends. `queued` says whether a marked task still waits.
 */
export function reserve(fleet: Fleet, oldest: Candidate[], queued: (task: number) => boolean, now: number, r: Rules): { set: { host: string; task: number } | null; clear: string[] } {
  const clear: string[] = [];
  let kept = false;
  for (const m of fleet.members) {
    if (!m.reserving) continue;
    const mark = reservingNow(m, now);
    if (!mark || !queued(mark.task) || !alive(m, now)) clear.push(m.id);
    else kept = true;
  }
  if (kept) return { set: null, clear };
  const largest = largestSize(fleet, now, r);
  const cap = ownerCap(fleet, now, r);
  const leased = ownersLeased(fleet);
  // No valid mark stands (kept is false): every registration is weighed as not reserving, and without a claim's memory offer.
  const claiming = fleet.members.filter((m) => counts(m, now) && !m.drained && !m.behind).map((m) => ({ ...m, reserving: null, offer: undefined }));
  const free = (m: Member) => m.units - r.job_reserved - heldBy(fleet, m).reduce((n, l) => n + l.units, 0);
  for (const c of oldest) {
    if (c.kind !== "build" || now - c.queued_at <= RESERVE_AFTER_MS) continue;
    if (cooling(c.reserved_at, now)) continue;
    // A build its owner's cap holds back is no task to keep a host for: it could not be leased when the units free up.
    if (communityBuild(c) && c.owner && (leased.get(c.owner) ?? 0) >= cap) continue;
    const s = sizeOf(c, largest, r);
    if (unitsOf(c.kind, s?.size ?? null, r) <= r.build_per_size) continue;
    // Those that could lease it once their units are free: a host alive and claiming, selection as if it held nothing.
    const could = claiming.filter((m) => !m.legacy && select(m, { members: fleet.members, leases: fleet.leases.filter((l) => l.by !== m.id) }, [c], now, r).length > 0);
    if (!could.length) continue;
    // One a registration fits now is leased at its next claim: nothing to keep.
    if (claiming.some((m) => select(m, fleet, [c], now, r).length > 0)) return { set: null, clear };
    const best = could.sort((a, b) => free(b) - free(a) || (a.id < b.id ? -1 : 1))[0];
    return { set: { host: best.id, task: c.id }, clear };
  }
  return { set: null, clear };
}
