/**
 * The fleet as people see it (#324, epic #307, design v2 §18): what the host
 * page, the Workers page and Status say of the maintainers' hosts, computed
 * here from rows the routes read (routes/hosts.ts handleFleet, handleHostGet)
 * with no database of its own, so each rule is tested on its own.
 *
 * - A host's fleet row (§18.2): its lanes, its units busy and free (the free
 *   ones the pool could hand it now: none while it does not claim), the
 *   tasks it runs, its release, its isolation level and whether its agent
 *   reports — public, as the Workers page is.
 * - Its "needs a person" box (§18.1): what only someone at the machine (or
 *   its owner, on the site) can fix, from its status and its last report.
 * - The Status lines (§18.3): the warnings and errors of each host; the
 *   capacity per architecture — the project's prompt to add a host, naming
 *   the architecture and whether native matters —; the second opinion; and
 *   the info lines. The pool's own GITHUB_TOKEN probe finding a write scope
 *   is Status's hero already (#308): an error the page says above all of
 *   these.
 *
 * Each line is plain text with the host it is about beside it: the page
 * escapes the words and links the host. The lines are public, as Status is:
 * they say a round's outcome and a verify failure's check, never an agent's
 * own words — those stay on the host's page, its owner's and the maintainers'.
 */
import { DISK_FLOOR_GB, HOST_REPORT_FRESH_MIN, TASK_UNITS, hostLine, type Arch, type Capacity, type Lane } from "./hosts";
import { ALIVE_MS, LANE_KINDS, roomOf, unitsOf, type Rules } from "./selection";
import { UPDATE_GRACE_MINUTES, compareTags, parseTag } from "./update";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A host is silent once nothing of it reached the pool for this long (§18.3): two of its five-minute reports, and a poll. */
export const SILENT_MIN = 10;
/** A host still on an older release this long after the pool's deploy is behind (§18.3): the 426 gate's grace (update.ts). */
export const BEHIND_MIN = UPDATE_GRACE_MINUTES;
/** The capacity line warns once an architecture's oldest queued task waited this long with no free unit taking it (§18.3). */
export const CAPACITY_WAIT_MIN = 60;
/** A host reserving for a large task longer than this is a warning (§18.3; the reservation's window is two hours). */
export const RESERVING_WARN_MIN = 60;
/** A task a host lost (its `lost` fail: a container gone when its dispatcher came back) is a readopt-failed line this long. */
export const LOST_WINDOW_MIN = 60;
/** A task clamped to the largest host alive is a line this long after its lease. */
export const CLAMPED_WINDOW_H = 24;
/** A host confirmed this recently is a new host (an info line). */
export const NEW_HOST_DAYS = 7;
/** The busy ratio's window, and the second opinion's audits'. */
export const WEEK_DAYS = 7;

export type Level = "error" | "warn" | "info";
/** What a line is about, one word each: the page's filter and the tests name them. */
export type LineKind =
  | "silent" | "behind" | "rolled-back" | "readopt-failed" | "disk-low" | "lane-held" | "clamped" | "reserving"
  | "refused"
  | "capacity" | "needs-native"
  | "second-opinion"
  | "new-host" | "agent-rollback";
export interface StatusLine { level: Level; kind: LineKind; text: string; host?: { id: string; name: string; owner: string }; arch?: string; task?: number }

/** A host as the fleet's read gives it (routes/hosts.ts FLEET_HOSTS_SQL): its row, and its registration's liveness and drain. */
export interface FleetHostRow {
  id: string; name: string; owner_login: string; status: string; os: string | null; arch: string | null; lanes: string | null; capacity: string | null;
  units: number | null; pool_cap_units: number | null; agent_slots: number | null; isolation: string | null; dedicated: number | null;
  release_applied: string | null; rolled_back_from: string | null; rolled_back_at: string | null; reported_at: string | null; last_seen: string | null;
  asleep_at: string | null; confirmed_at: string | null; reserving_task: number | null; reserving_since: string | null; soaking_until: string | null;
  owner_removed_at: string | null; report: string | null; worker_id: string | null;
  /** Its registration's last claim, its drain, and the model its claims say it runs ("<provider>/<model>"). */
  reg_last_seen: string | null; drained_at: string | null; agent: string | null;
}
/** A lease as the fleet's read gives it: whose, of what, on which lane, how many units. */
export interface FleetLease { id: number; lease_owner: string; kind: string; arch: string; lane: string | null; units: number | null; size: number | null }

/** What a host's last report is, parsed once; null when it sent none or it does not read. */
export function reportOf(text: string | null): Record<string, any> | null {
  if (!text) return null;
  try {
    const r = JSON.parse(text);
    return r && typeof r === "object" && !Array.isArray(r) ? r : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 400): string | null => (typeof v === "string" && v.length > 0 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v) ? v.slice(0, max) : null);
const tag = (v: unknown): string | null => (typeof v === "string" && /^v\d+\.\d+\.\d+$/.test(v) ? v : null);
const when = (v: unknown): string | null => (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const json = <T>(v: string | null, or: T): T => {
  try {
    return v ? (JSON.parse(v) as T) : or;
  } catch {
    return or;
  }
};

/** A duration as the lines say it: "52 min", "1 h 12 min", "3 d 4 h". */
export function span(ms: number): string {
  const m = Math.max(0, Math.floor(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** The last round as the report says it (design v2 §17.2 `round`), each field checked. */
export interface Round { at: string | null; outcome: string; from: string | null; step: string | null; detail: string }
export function roundOf(r: Record<string, any> | null): Round | null {
  const x = r?.round;
  if (!x || typeof x !== "object") return null;
  const outcome = str(x.outcome, 40);
  return outcome ? { at: when(x.at), outcome, from: tag(x.from), step: str(x.step, 40), detail: str(x.detail, 1000) ?? "" } : null;
}

/**
 * The check a refused round names when its agent's verify refused the bundle (design v2 §18.3: possible tampering) — the
 * signature, the signer's pins (repository, workflow, branch…), the bundle or its content — as the agent words it
 * ("refused (signature): verify refused (signature): …", run/agent.rs). Null for any other round: a refusal by the floor, a
 * revoked release or a statement is the agent keeping its own rules.
 */
export function verifyFailureOf(round: Round | null): string | null {
  if (!round || round.outcome !== "refused") return null;
  return /verify refused \(([a-z0-9._-]{1,40})\)/.exec(round.detail)?.[1] ?? null;
}

/** The capacity the row keeps (routes/hosts.ts writes parseCapacity's), with the held lanes and the pool's below-the-minimum words. */
type KeptCapacity = Capacity & { below_minimum?: string | null };

/** The limits the report's capacity says the runtime enforces (`run/capacity.json` `limits`): null when it does not say. */
export function limitsOf(r: Record<string, any> | null): { cpus_hard: boolean; memory_hard: boolean; pids: boolean } | null {
  const l = r?.capacity?.limits;
  if (!l || typeof l !== "object") return null;
  const b = (v: unknown) => v === true;
  return typeof l.cpus_hard === "boolean" || typeof l.memory_hard === "boolean" || typeof l.pids === "boolean" ? { cpus_hard: b(l.cpus_hard), memory_hard: b(l.memory_hard), pids: b(l.pids) } : null;
}

/** The units a host keeps for pool jobs, as its report's capacity says it, else the signed one. */
export function jobReservedOf(r: Record<string, any> | null): number {
  const n = r?.capacity?.job_reserved;
  return Number.isInteger(n) && n >= 0 && n <= 64 ? n : TASK_UNITS.job_reserved;
}

/** A host's fleet row (design v2 §18.2): public, as the Workers page is. */
export interface FleetHost {
  id: string; name: string; owner: string; status: string; worker: string | null;
  arches: string[]; lanes: Lane[];
  /** What the pool hands it at most (its count under the pool's cap); its leases' units; the free ones it could be handed now; the one kept for pool jobs. */
  units: number | null; units_busy: number; units_free: number; job_reserved: number;
  /** The tasks it runs: its registration's leases. */
  tasks: number;
  release: string | null; isolation: string | null; dedicated: boolean | null;
  /** Its agent reports (a report within HOST_REPORT_FRESH_MIN), whether it sleeps, whether its dispatcher claims (within selection's ALIVE_MS) and is handed work. */
  alive: boolean; asleep: boolean; claims: boolean;
  /** Its one state, in a word the row and Status say: claiming, full, asleep, silent, drained, suspended, pending-owner, below-minimum, not-claiming, stopped. */
  state: string;
}

/** The last sign a host gave the pool: its report or its state poll, whichever is later; null when none. */
export function lastSignOf(h: Pick<FleetHostRow, "reported_at" | "last_seen">): number | null {
  const t = [h.reported_at, h.last_seen].map((v) => (v ? Date.parse(v) : NaN)).filter(Number.isFinite);
  return t.length ? Math.max(...t) : null;
}

/** A host's fleet row from its row and the fleet's leases. */
export function fleetHostOf(h: FleetHostRow, leases: FleetLease[], now: number, r: Rules): FleetHost {
  const lanes = json<Lane[]>(h.lanes, []);
  const report = reportOf(h.report);
  const mine = h.worker_id ? leases.filter((l) => l.lease_owner === h.worker_id) : [];
  const held = mine.map((l) => ({ kind: l.kind, units: l.units ?? unitsOf(l.kind, l.size, r) }));
  const units = h.units === null ? null : Math.min(h.units, h.pool_cap_units ?? Number.MAX_SAFE_INTEGER);
  const alive = !!h.reported_at && now - Date.parse(h.reported_at) < HOST_REPORT_FRESH_MIN * MIN;
  const asleep = h.asleep_at !== null && alive;
  const below = !!json<KeptCapacity | null>(h.capacity, null)?.below_minimum;
  const seen = h.reg_last_seen ? Date.parse(h.reg_last_seen) : NaN;
  const claiming = Number.isFinite(seen) && seen > now - ALIVE_MS;
  const state = h.status === "suspended" ? "suspended" : h.status === "retired" ? "retired" : h.status === "pending-owner" ? "pending-owner"
    : h.owner_removed_at ? "stopped" : asleep ? "asleep" : h.drained_at ? "drained" : below ? "below-minimum"
    : (lastSignOf(h) ?? 0) <= now - SILENT_MIN * MIN ? "silent" : !claiming ? "not-claiming" : "claiming";
  const claims = state === "claiming";
  const job = jobReservedOf(report);
  const room = units === null ? 0 : Math.max(0, roomOf({ units }, held, { job_reserved: job }).task);
  return {
    id: h.id, name: h.name, owner: h.owner_login, status: h.status, worker: h.worker_id,
    arches: [...new Set(lanes.map((l) => l.arch))], lanes,
    units, units_busy: held.reduce((n, l) => n + l.units, 0), units_free: claims ? room : 0, job_reserved: job,
    tasks: mine.length,
    release: h.release_applied, isolation: h.isolation, dedicated: h.dedicated === null ? null : !!h.dedicated,
    alive, asleep, claims, state: claims && room === 0 ? "full" : state,
  };
}

// ---------- the "needs a person" box (design v2 §18.1) ----------

/** What the box names: one word each, the page's icon and the tests key on it. */
export type NeedKind = "pending-owner" | "suspended" | "stopped" | "below-minimum" | "disk-low" | "binfmt" | "cgroups" | "hosting" | "docker-group" | "linger" | "credentials" | "round";
export interface Need { what: NeedKind; text: string }
/** What an agent may say a person must fix in its report's `needs_person` (only it sees them: linger, the credentials within its user's reach). */
const AGENT_NEEDS: readonly NeedKind[] = ["linger", "credentials", "docker-group", "binfmt", "cgroups", "hosting"];

/**
 * What only a person can fix on a host (design v2 §18.1), from its status and its last report: its owner's Confirm; a
 * suspension, or the maintainer list's stop; below the minimum; the free disk under the signed floor; an emulated lane held
 * for binfmt; limits the runtime does not enforce (cgroup delegation); the hosting requirement its isolation level does not
 * meet as a new host would; the engine refusing the agent's user (the docker group); a round's own "needs a person"; and what
 * the agent says of itself in `needs_person` (linger, credentials within its user's reach), each checked.
 */
export function needsPersonOf(h: Pick<FleetHostRow, "status" | "owner_login" | "owner_removed_at" | "capacity" | "isolation" | "dedicated"> & { status_by?: string | null; status_reason?: string | null }, report: Record<string, any> | null): Need[] {
  const out: Need[] = [];
  const add = (what: NeedKind, text: string) => { if (!out.some((n) => n.what === what && n.text === text)) out.push({ what, text }); };
  if (h.status === "pending-owner") add("pending-owner", `it waits for ${h.owner_login} to compare its fingerprint and press Confirm, on their page: nothing claims before that`);
  if (h.status === "suspended") add("suspended", `suspended${h.status_by ? ` by ${h.status_by}` : ""}${h.status_reason ? `: ${h.status_reason}` : ""} — only ${h.owner_login} resumes it, with a passkey`);
  if (h.owner_removed_at && h.status !== "retired") add("stopped", `its claims stopped: the host's owner is no longer a maintainer — listed again, ${h.owner_login} resumes their hosts on their page`);
  const c = json<KeptCapacity | null>(h.capacity, null);
  if (c?.below_minimum) add("below-minimum", `${c.below_minimum}: it keeps its bundle and claims nothing until it meets it`);
  const d = c?.disk_free_gb;
  if (d && (d.work < DISK_FLOOR_GB || d.engine < DISK_FLOOR_GB)) add("disk-low", `${d.work} GB free on the work root and ${d.engine} on the engine's data root, below the ${DISK_FLOOR_GB} GB floor: its dispatcher claims no build until there is room`);
  for (const l of c?.held_lanes ?? []) {
    if (/binfmt|needs a person/i.test(l.reason)) add("binfmt", `its ${l.arch} lane is held — ${l.reason}`);
  }
  const limits = limitsOf(report);
  if (limits && !(limits.cpus_hard && limits.memory_hard && limits.pids)) {
    const missing = [[limits.cpus_hard, "--cpus"], [limits.memory_hard, "--memory"], [limits.pids, "--pids-limit"]].filter(([ok]) => !ok).map(([, f]) => f).join(", ");
    add("cgroups", `limits cannot be enforced: its runtime ignores ${missing}${h.isolation === "user" || h.isolation === "subuid" ? " — a rootless runtime needs systemd to delegate cpu, memory and pids to the agent's user (cgroup v2)" : ""}`);
  }
  // The hosting requirement (D42, design v2 §19.1, §19.3), as install's preflight words it: the level a task-container escape lands at.
  if (h.isolation === "root") add("hosting", "isolation root: a rootful daemon without userns-remap — a task-container escape lands as root on the host; the Studio's recorded exception until P6, refused for a new host (prep-root.sh sets userns-remap on a new daemon)");
  else if (h.isolation === "user" && h.dedicated === 0) add("hosting", "isolation user on a machine not dedicated to it: a rootless runtime at the user level runs only on a dedicated machine or VM — on a shared one, a dedicated Unix user with rootless podman at the subuid level");
  else if (h.isolation === "vm-shared" && h.dedicated === 0) add("hosting", "isolation vm-shared without --dedicated: Docker Desktop's or OrbStack's VM qualifies only with the home mount removed and its owner's word that nothing else runs in it");
  // A round that ended on what only a person fixes (run/rollout.rs): the engine refusing the agent's user, a VM, a clock.
  const round = roundOf(report);
  if (round && /needs a person/i.test(round.detail)) {
    if (/docker group|EACCES/i.test(round.detail)) add("docker-group", "the engine's socket refuses the agent's user (EACCES): log out and back in, or reboot, so the docker group applies");
    else add("round", round.detail.replace(/^.*?needs a person:\s*/i, "").slice(0, 400));
  }
  // What the agent says of itself (only it can see them).
  const said = Array.isArray(report?.needs_person) ? (report!.needs_person as unknown[]).slice(0, 8) : [];
  for (const x of said) {
    const o = x && typeof x === "object" ? (x as { what?: unknown; detail?: unknown }) : {};
    const what = AGENT_NEEDS.find((k) => k === o.what);
    const text = str(o.detail, 400);
    if (what && text) add(what, text);
  }
  return out;
}

// ---------- the Status lines of each host (design v2 §18.3) ----------

/** What the lines read besides the hosts: the pool's release, the lost tasks and the clamps of the journal. */
export interface FleetEvents {
  /** `lost` fails of host leases in the last LOST_WINDOW_MIN (events, kind build): the registration and the task. */
  lost: { worker: string; task: number; at: string }[];
  /** Clamps to the largest host alive in the last CLAMPED_WINDOW_H (events, kind build): the task and the journal's words. */
  clamped: { task: number; summary: string; at: string }[];
}

const who = (h: Pick<FleetHostRow, "id" | "name" | "owner_login">) => ({ id: h.id, name: h.name, owner: h.owner_login });

/**
 * The warnings, errors and info lines of each host (design v2 §18.3), errors first, then warnings, then info, each list in the
 * hosts' order. A retired host says nothing; a host waiting for its owner's Confirm or suspended says it on its page and the
 * Workers page, not here.
 */
export function hostLines(rows: FleetHostRow[], ev: FleetEvents, pool: { version: string; deployed_at: string | null }, now: number): StatusLine[] {
  const out: StatusLine[] = [];
  const p = parseTag(pool.version), deployed = pool.deployed_at ? Date.parse(pool.deployed_at) : NaN;
  for (const h of rows) {
    if (h.status !== "active") continue;
    const host = who(h), report = reportOf(h.report), round = roundOf(report);
    const sign = lastSignOf(h);
    const silent = !h.asleep_at && (sign === null || now - sign >= SILENT_MIN * MIN);
    // Errors: its agent's verify refused the bundle it was to apply — possible tampering, the failed check named.
    const check = verifyFailureOf(round);
    if (check) out.push({ level: "error", kind: "refused", host, text: `refused: its agent's verify failed the ${check} check${round!.at ? ` (${round!.at.slice(0, 16).replace("T", " ")} UTC)` : ""} — possible tampering: it applied nothing and runs what it ran; its page has the round's words` });
    // Warnings.
    if (silent) out.push({ level: "warn", kind: "silent", host, text: sign === null ? "silent: its agent never reported" : `silent for ${span(now - sign)}: nothing of it reached the pool since ${new Date(sign).toISOString().slice(0, 16).replace("T", " ")} UTC — check the machine, its agent and its network` });
    const applied = parseTag(h.release_applied);
    if (h.rolled_back_from) out.push({ level: "warn", kind: "rolled-back", host, text: `rolled-back: its agent's guard reverted ${h.rolled_back_from}${h.rolled_back_at ? ` (${h.rolled_back_at.slice(0, 16).replace("T", " ")} UTC)` : ""} and runs ${h.release_applied ?? "its last-good"}; ${h.rolled_back_from} stays in its quarantine` });
    else if (!silent && p && applied && compareTags(applied, p) < 0 && Number.isFinite(deployed) && now - deployed >= BEHIND_MIN * MIN && !(h.soaking_until && Date.parse(h.soaking_until) > now)) {
      out.push({ level: "warn", kind: "behind", host, text: `behind: it runs ${h.release_applied}, ${span(now - deployed)} after the deploy of ${pool.version} — its last round: ${round ? round.outcome : "none reported"} (its page has why)` });
    }
    const lost = ev.lost.filter((l) => l.worker === h.worker_id);
    if (lost.length) out.push({ level: "warn", kind: "readopt-failed", host, text: `readopt-failed: ${lost.length} task${lost.length === 1 ? "" : "s"} lost in the last ${LOST_WINDOW_MIN === 60 ? "hour" : span(LOST_WINDOW_MIN * MIN)} (${lost.map((l) => `#${l.task}`).join(", ")}) — a container gone when its dispatcher came back (a reboot, an engine restart, the disk watcher); each back in the queue, its attempt given back` });
    const c = json<KeptCapacity | null>(h.capacity, null);
    const d = c?.disk_free_gb;
    if (!silent && d && (d.work < DISK_FLOOR_GB || d.engine < DISK_FLOOR_GB)) out.push({ level: "warn", kind: "disk-low", host, text: `disk-low: ${d.work} GB free on the work root and ${d.engine} on the engine's data root, below the ${DISK_FLOOR_GB} GB floor — it claims no build until there is room` });
    for (const l of c?.held_lanes ?? []) {
      // The envelope's own choice ("off: …") is its owner's, not a warning.
      if (!/^off\b/.test(l.reason)) out.push({ level: "warn", kind: "lane-held", host, arch: l.arch, text: `its ${l.arch} lane is held — ${l.reason}` });
    }
    if (h.reserving_task !== null && h.reserving_since && now - Date.parse(h.reserving_since) > RESERVING_WARN_MIN * MIN) {
      out.push({ level: "warn", kind: "reserving", host, task: h.reserving_task, text: `reserving for task #${h.reserving_task} for ${span(now - Date.parse(h.reserving_since))}: it takes nothing else but pool jobs until its units fit it` });
    }
    // Info: an agent self-rollback, while its agent skips the version that did not pass its health gate.
    const skip = typeof report?.agent?.skip === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(report.agent.skip) ? (report.agent.skip as string) : null;
    if (round?.outcome === "agent-rollback" || skip) out.push({ level: "info", kind: "agent-rollback", host, text: `an agent self-rollback: ${skip ? `agent ${skip} did not pass its health gate and is skipped here until a higher one` : "its last round rolled its agent back (its page has why)"}` });
  }
  // A new host, confirmed this week (D40's notice, for everyone).
  for (const h of rows) {
    if (h.status !== "active" || !h.confirmed_at || now - Date.parse(h.confirmed_at) > NEW_HOST_DAYS * 24 * HOUR) continue;
    const c = json<KeptCapacity | null>(h.capacity, null);
    out.push({ level: "info", kind: "new-host", host: who(h), text: `a new host, confirmed ${span(now - Date.parse(h.confirmed_at))} ago: ${c ? hostLine(c, h.isolation, h.dedicated === null ? null : !!h.dedicated) : h.name}` });
  }
  // A task clamped to the largest host alive, from the journal's own line (routes/factory.ts selectAndLease).
  for (const x of ev.clamped) out.push({ level: "warn", kind: "clamped", task: x.task, text: `clamped: ${x.summary}` });
  const rank: Record<Level, number> = { error: 0, warn: 1, info: 2 };
  return out.map((l, i) => [l, i] as const).sort((a, b) => rank[a[0].level] - rank[b[0].level] || a[1] - b[1]).map(([l]) => l);
}

// ---------- capacity per architecture: the scaling signal (design v2 §18.3) ----------

/** One architecture's queue, as the fleet's read counts it: the tasks a lane runs (builds and trials), the oldest, those waiting for a native host. */
export interface QueueRow { arch: string; n: number; oldest: string | null; needs_native: number | null }
/** Unit-hours a lane spent on tasks over the week, from the leases' own times. */
export interface BusyRow { arch: string; lane: string; unit_hours: number | null }

export interface ArchCapacity {
  arch: string;
  queued: number; oldest_at: string | null; oldest_wait_min: number | null;
  /** Queued tasks an emulated lane sent back (`needs_native`): they wait for a native host of this arch. */
  needs_native: number;
  /** The free units the hosts that claim now could hand a task of this arch: on a native lane, on an emulated one. */
  free_native: number; free_emulated: number;
  /** How many hosts run it natively and emulated. */
  hosts_native: number; hosts_emulated: number;
  /** The share of the week's unit-hours its lanes spent busy, against what the hosts that run them have; null with none. */
  busy_7d: { all: number | null; native: number | null; emulated: number | null };
}

/** The architectures the pool builds for (hosts.ts ARCHES): every one has a row, whether or not a host runs it. */
const ARCH_ORDER: readonly Arch[] = ["x86_64", "aarch64"];

/**
 * The capacity of each architecture (design v2 §18.3): its queue, the free units native and emulated, and the week's busy
 * ratio per lane — against the units the hosts that run it have, each counted from its confirmation within the week.
 */
export function capacityOf(queue: QueueRow[], hosts: FleetHost[], rows: FleetHostRow[], busy: BusyRow[], now: number): ArchCapacity[] {
  const weekAgo = now - WEEK_DAYS * 24 * HOUR;
  const hoursOf = (id: string) => {
    const r = rows.find((x) => x.id === id);
    const from = Math.max(weekAgo, r?.confirmed_at ? Date.parse(r.confirmed_at) : weekAgo);
    return Math.max(0, (now - from) / HOUR);
  };
  const live = hosts.filter((h) => h.status === "active");
  return ARCH_ORDER.map((arch) => {
    const q = queue.find((x) => x.arch === arch);
    const has = (h: FleetHost, mode: "native" | "emulated") => h.lanes.some((l) => l.arch === arch && l.mode === mode);
    const capOf = (hs: FleetHost[]) => hs.reduce((n, h) => n + (h.units ?? 0) * hoursOf(h.id), 0);
    const used = (mode: string | null) => busy.filter((b) => b.arch === arch && (mode === null || b.lane === mode)).reduce((n, b) => n + Number(b.unit_hours ?? 0), 0);
    const ratio = (u: number, c: number) => (c > 0 ? Math.min(1, Math.round((u / c) * 1000) / 1000) : null);
    const native = live.filter((h) => has(h, "native")), emulated = live.filter((h) => has(h, "emulated"));
    return {
      arch,
      queued: q?.n ?? 0, oldest_at: q?.oldest ?? null, oldest_wait_min: q?.oldest ? Math.max(0, Math.floor((now - Date.parse(q.oldest)) / MIN)) : null,
      needs_native: Number(q?.needs_native ?? 0),
      free_native: native.reduce((n, h) => n + h.units_free, 0), free_emulated: emulated.reduce((n, h) => n + h.units_free, 0),
      hosts_native: native.length, hosts_emulated: emulated.length,
      busy_7d: { all: ratio(used(null), capOf(live.filter((h) => has(h, "native") || has(h, "emulated")))), native: ratio(used("native"), capOf(native)), emulated: ratio(used("emulated"), capOf(emulated)) },
    };
  });
}

/**
 * The capacity lines (design v2 §18.3): an architecture whose oldest queued task waited CAPACITY_WAIT_MIN — none of the fleet's
 * free units took it — says how many wait and the free units native and emulated, the project's prompt to add a host of it; and
 * the tasks an emulated lane sent back wait for a native host of their arch, counted.
 */
export function capacityLines(caps: ArchCapacity[]): StatusLine[] {
  const out: StatusLine[] = [];
  for (const c of caps) {
    if (c.queued > 0 && c.oldest_wait_min !== null && c.oldest_wait_min >= CAPACITY_WAIT_MIN) {
      out.push({ level: "warn", kind: "capacity", arch: c.arch, text: `${c.arch}: ${c.queued} task${c.queued === 1 ? "" : "s"} queued, the oldest waited ${span(c.oldest_wait_min * MIN)}; free native units: ${c.free_native}, free emulated units: ${c.free_emulated}${c.hosts_native === 0 ? ` — no host runs ${c.arch} natively` : ""}` });
    }
    if (c.needs_native > 0) out.push({ level: "warn", kind: "needs-native", arch: c.arch, text: `tasks waiting for a native ${c.arch} host: ${c.needs_native}${c.hosts_native === 0 ? " — none runs it natively: only a native host takes them" : ""}` });
  }
  return out;
}

// ---------- the second opinion (design v2 §18.3, D36) ----------

/** The models the alive registrations' claims say they run, with how many registrations each. */
export interface MixRow { agent: string; n: number; hosts: number }
/** The week's publish-bound audits, counted by how independent their lease says they were (#339). */
export interface AuditRow { independent: string | null; n: number }

export interface SecondOpinion {
  mix: { agent: string; provider: string; model: string; registrations: number; hosts: number }[];
  audits: number; none: number; share_none: number | null;
  line: StatusLine;
}

/**
 * The second opinion (design v2 §18.3, D36): the fleet's provider and model mix, and the share of last week's publish-bound
 * audits that were `independent: none` — the same model judged the recipe it wrote; with any, the line asks one host to run
 * another model (its envelope's agent).
 */
export function secondOpinionOf(mix: MixRow[], audits: AuditRow[]): SecondOpinion {
  const m = mix.map((x) => {
    const cut = x.agent.indexOf("/");
    return { agent: x.agent, provider: cut > 0 ? x.agent.slice(0, cut) : x.agent, model: cut > 0 ? x.agent.slice(cut + 1) : x.agent, registrations: Number(x.n), hosts: Number(x.hosts ?? 0) };
  });
  const total = audits.reduce((n, a) => n + Number(a.n), 0), none = audits.filter((a) => a.independent === "none").reduce((n, a) => n + Number(a.n), 0);
  const share = total ? Math.round((none / total) * 1000) / 1000 : null;
  const models = new Set(m.map((x) => x.model));
  const said = m.length ? `the fleet runs ${m.map((x) => `${x.provider} ${x.model} (${x.registrations})`).join(", ")}` : "no registration alive says which model it runs";
  const line: StatusLine = none > 0
    ? { level: "warn", kind: "second-opinion", text: `${said}; ${none} of last week's ${total} publish-bound audits (${Math.round(share! * 100)}%) were independent: none — the same model judged the recipe it wrote: configure a different model on one host` }
    : { level: "info", kind: "second-opinion", text: `${said}; ${total ? `every one of last week's ${total} publish-bound audits was by another model` : "no publish-bound audit last week"}${models.size === 1 && total === 0 ? " — one model only: a different model on one host gives the project's copies a second opinion" : ""}` };
  return { mix: m, audits: total, none, share_none: share, line };
}

/** The kinds a lane runs (selection.ts LANE_KINDS): the capacity line counts these. */
export const QUEUED_KINDS = LANE_KINDS;
