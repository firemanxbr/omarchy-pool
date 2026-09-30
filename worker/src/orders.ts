/**
 * Workers follow the brain for their health (#277): the pool orders a
 * worker, and the worker obeys. There is no new connection to a host: an
 * order rides the answer to the worker's own claim, which the worker makes
 * every 30 s anyway, and only through that worker's own token. After the
 * v1.0.0 and v1.0.1 releases a maintainer had to reach the Studio host and
 * restart two review workers by hand (#273) while the pool knew both were
 * not ready and had no way to tell them.
 *
 * What is here, and who calls it:
 * - the kinds, the bounds and the constants (the page's footnote quotes them);
 * - the pure core — cleanText, errorClass, canonicalKinds, parsePreviousExit,
 *   claimFacts, instanceStep, probeAge, decideAuto, rulesScale,
 *   orderVerdicts, codeSentence — tested without a database (orders-pure);
 * - what touches D1 — issueOrder (the door and the rules, one atomic batch
 *   with every cap inside the INSERT), takeOrders (delivery at the claim,
 *   observation, staleness), the site and breaker reads, sweepOrders (the
 *   cron) and the statements revoke runs.
 *
 * Every statement here is indexed and bounded, and EXPLAIN QUERY PLAN pins
 * the index it uses (worker-orders.test.ts): a changed WHERE fails a test,
 * not a claim. A claim with nothing open reads no order row and writes
 * nothing it would not write anyway. The whole path fails open: an
 * exception delivers nothing, is logged, and the claim goes on to its task
 * or its 204 — an orders bug must never cost a claim.
 *
 * The first part of #277 (its design's §12) gave re-check, restart and
 * restart the agent service, by the pool and by people. The second gives
 * drain and resume — states the pool enforces at the claim, whatever the
 * worker's image — and Stop its task: the pool fences the task's lease at
 * issue, the heartbeat's 409 stops it on the worker, and the worker's next
 * claim, or the lease's end, gives it back to the queue (lease.ts). The
 * third is Update: never delivered to the worker — its set's updater reads
 * it from the public GET /factory/follow and replaces the set, and the pool
 * closes it when the worker claims on the pool's release (setRollout says
 * whether an updater stands beside a worker at all).
 */
import type { Env } from "./index";
import { findLeak } from "./leak";
import { parseTag, updateState } from "./update";
import { WORKER_ALIVE_MINUTES, version as running, type RunningVersion } from "./meta";
import { FIRST_PICK_MINUTES } from "./queue";
import { afterRequeue, LEASE_MINUTES, requeueStatement, stopError, type LeasedTask } from "./lease";

// ---------- kinds and bounds ----------

export const ORDER_KINDS = ["recheck-agent", "restart", "restart-agent", "drain", "resume", "update", "stop-task"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];
export const isOrderKind = (k: unknown): k is OrderKind => typeof k === "string" && (ORDER_KINDS as readonly string[]).includes(k);

/**
 * What a claim may declare: the kinds the process executes, drain ("I
 * understand notices"), and stop-task ("I stop a task on the heartbeat's
 * `409` with `stop`", #277, part 2) — which the pool and the broker read as
 * the one proof that a process stops on the pool's word: part 1's images
 * declare orders, and run a stopped task on to its lease's end. Update and
 * resume are never declared: the updater and the pool carry them out.
 */
export const DECLARABLE = ["drain", "recheck-agent", "restart", "restart-agent", "stop-task"] as const;

/** The kinds this pool gives (#277, parts 1 and 2), delivered at the claim or carried out by the pool. Update is given too (part 3), but never delivered: its set's updater takes it. */
export const LIVE_KINDS: readonly OrderKind[] = ["recheck-agent", "restart", "restart-agent", "drain", "resume", "stop-task"];
/** The kinds the pool carries out itself: at issue (drain, resume, the stop's fence) and at the claim or the lease's end (the stop's requeue). They work on every image; the worker only hears a drain's notice, and obeys the heartbeat's 409. */
export const POOL_KINDS: readonly OrderKind[] = ["drain", "resume", "stop-task"];

/** The kinds that restart something: they share the per-worker hourly cap, the pool's hourly cap and the per-site pacing. */
export const RESTART_GROUP: readonly OrderKind[] = ["restart", "restart-agent", "update", "stop-task"];
const POOL_RESTARTS: readonly OrderKind[] = ["restart", "restart-agent"];

/** The step machine's timings, in minutes; WORKER_RULES_SCALE divides these five in development only (rulesScale). */
export const RECHECK_AFTER_MIN = 5;
export const RESTART_AFTER_MIN = 10;
export const RESTART_SPACING_MIN = 30;
export const GIVE_UP_AFTER_MIN = 30;
export const SITE_SPACING_MIN = 5;
/** A process younger than this on the pool's clock is never restarted by the pool: never scaled. */
export const MIN_UPTIME_S = 120;
/** Per worker: what the pool itself may order. Every issued order counts, whatever its outcome. */
export const MAX_POOL_RESTARTS_PER_SPELL = 2;
export const MAX_POOL_RESTARTS_PER_DAY = 3;
export const MAX_POOL_RECHECKS_PER_SPELL = 1;
export const MAX_POOL_RECHECKS_PER_DAY = 3;
/** Per worker, from anyone, per hour: the restart group, and the re-checks. */
export const MAX_RESTARTS_PER_HOUR = 6;
export const MAX_RECHECKS_PER_HOUR = 6;
/** Per login per hour (every kind but resume); the pool's restart-type orders per hour, fleet-wide; the pool's orders of any kind per 24 h. */
export const MAX_ORDERS_PER_LOGIN_HOUR = 20;
export const MAX_POOL_RESTARTS_PER_HOUR = 10;
export const MAX_POOL_ORDERS_PER_DAY = 60;
/** The fleet breaker: it trips at BREAKER_SITES sites of one provider with an open spell, and clears once fewer than BREAKER_CLEAR_BELOW have had one for BREAKER_CLEAR_MIN. Never scaled. */
export const BREAKER_SITES = 3;
export const BREAKER_CLEAR_BELOW = 2;
export const BREAKER_CLEAR_MIN = 15;
/**
 * Who the pool is on its own orders: a value no GitHub login can be (a login
 * is letters, digits and single hyphens), so nobody signs in as the pool and
 * spends its budget or skips a person's cap. One per trust: what the rules
 * order a contributor's worker is counted apart, so a contributor's own
 * registrations can spend the community's share of the budget and never
 * the project's.
 */
export const POOL_PROJECT = "pool:project";
export const POOL_COMMUNITY = "pool:community";
export const isPool = (by: string | null | undefined): boolean => by === POOL_PROJECT || by === POOL_COMMUNITY;
export const poolFor = (trust: string | null | undefined): string => (trust === "project" ? POOL_PROJECT : POOL_COMMUNITY);
const POOL_IN = `('${POOL_PROJECT}', '${POOL_COMMUNITY}')`;
/** The community's share of the pool's own orders, inside the fleet's: the project's workers always keep the rest of the day's sixty and the hour's ten. */
export const MAX_POOL_COMMUNITY_ORDERS_PER_DAY = 40;
export const MAX_POOL_COMMUNITY_RESTARTS_PER_HOUR = 6;
/** How long an order waits for its worker: a person's six hours, the pool's half an hour; and how long a delivered one waits for its answer. */
export const TTL_PERSON_MIN = 360;
export const TTL_POOL_MIN = 30;
export const TTL_UPDATE_MIN = 360;
export const ANSWER_WITHIN_MIN = 30;
/** How often a set's updater asks the pool (GET /factory/follow), in seconds: the fleet follows a release, a rollback and an Update within this (#277, Q5). Its own knob is ROLLOUT_POLL; the pages quote this. */
export const FOLLOW_POLL_S = 120;
/** How many workers one follow names at most: a default Studio names five, eight with the emulated profile; a contributor's set one or two. */
export const FOLLOW_MAX_IDS = 16;
/** A process that lived under CHURN_WINDOW_MIN, finished no task and whose end nothing explains counts toward a crash loop; one that lives CHURN_CLEAR_MIN ends it. */
export const CHURN_WINDOW_MIN = 10;
export const CHURN_CLEAR_MIN = 30;
export const CRASH_LOOP_AT = 3;
/** Two processes on one token: the old one claiming again within this window of the new one's first claim; the conflict ends once the other has not claimed for as long. */
export const CONFLICT_WINDOW_MIN = 10;
/** The worker's watchdog (the page quotes them; the worker keeps them). */
export const WATCHDOG_MIN = 20;
export const WATCHDOG_TASK_MIN = 35;
export const WATCHDOG_MAX_MIN = 1440;
export const WATCHDOG_RESET_H = 24;
/** The heartbeat's rhythm (routes/factory.ts TOUCH_MINUTES): a conflict's other process is written at most this often, riding the liveness write. */
const TOUCH_MINUTES = 3;

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (t: number) => new Date(t).toISOString();
const clock = (t: string | number) => new Date(t).toISOString().slice(11, 16);
/** A time of day the pool says to a person who may read it on another clock — a page's dialog says the same moment in the reader's own: "14:17 UTC". */
export const utc = (t: string | number) => `${clock(t)} UTC`;

// ---------- text hygiene ----------

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const BIDI = /[‪-‮⁦-⁩]/g;

/**
 * Text a person or a worker gave, as the pool stores it: escape sequences,
 * control characters (a newline kept only with `lines`), DEL and the bidi
 * overrides removed, cut to `max`; null when what is left looks like a
 * secret (leak.ts) — the caller refuses it, or says so in its place. A
 * reason reaches terminals through `docker logs`, and the page draws it as
 * text: neither may be steered by it.
 */
export function cleanText(s: unknown, max: number, opts: { lines?: boolean } = {}): string | null {
  if (typeof s !== "string") return "";
  let t = s.replace(ANSI, "").replace(BIDI, "");
  t = opts.lines ? t.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "") : t.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  if (!opts.lines) t = t.replace(/\s{2,}/g, " ");
  t = Array.from(t.trim()).slice(0, max).join("");
  return findLeak(t) ? null : t;
}

// ---------- what a claim says ----------

/** What a process's previous one said of its end, when it ended on purpose. */
export interface PreviousExit { why: "idle" | "drain" | "restart" | "watchdog"; at: string | null; stuck_in: "claim" | "task" | "order" | null; n: number | null }

export function parsePreviousExit(v: unknown): PreviousExit | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.why !== "idle" && o.why !== "drain" && o.why !== "restart" && o.why !== "watchdog") return null;
  const at = typeof o.at === "string" && Number.isFinite(Date.parse(o.at)) ? iso(Date.parse(o.at)) : null;
  const stuck = o.stuck_in === "claim" || o.stuck_in === "task" || o.stuck_in === "order" ? o.stuck_in : null;
  const n = typeof o.n === "number" && Number.isInteger(o.n) && o.n > 0 && o.n < 1000 ? o.n : null;
  return { why: o.why, at, stuck_in: o.why === "watchdog" ? stuck : null, n: o.why === "watchdog" ? n : null };
}

/** The kinds a claim declares, in one form whatever order or repetition it came in: known kinds only, sorted, once each. Null when the claim has no `orders` field — an image from before orders. */
export function canonicalKinds(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.filter((k): k is string => typeof k === "string" && (DECLARABLE as readonly string[]).includes(k)))].sort();
}

/** The probe a claim carries (routes/factory.ts agentReport), or undefined when an older client says nothing of it. */
export interface Probe { status: "ok" | "error" | null; error: string | null; checked_at: string | null }

/** The claim's words for the orders path, checked: what is malformed is dropped, never a claim refused over it. */
export interface ClaimFacts {
  /** The kinds this process takes; null = no `orders` field, or no valid `instance` (the protocol's gate: no new answer shape for it). */
  takes: string[] | null;
  /** 32 hex characters, drawn once per process; null when absent or malformed. */
  instance: string | null;
  /** When the process started, on its own clock: display only. */
  started_at: string | null;
  agent_via: "direct" | "sibling" | "broker" | "none" | null;
  site: string | null;
  restarts_left: number | null;
  previous_exit: PreviousExit | null;
  version: string | null;
  probe: Probe | undefined;
  /** The claim came through a broker that exits with its builder on a restart (x-omarchy-broker-takes: pair-restart), a header the broker writes itself. */
  pairRestart: boolean;
  /** What rolls its set out (#277, part 3), as the row keeps it: canonical JSON, or null when the claim says nothing of it (rolloutJson). */
  rollout: string | null;
}

export function claimFacts(b: Record<string, unknown>, headers: Headers, probe: Probe | undefined, now = Date.now()): ClaimFacts {
  const started = typeof b.started_at === "string" ? Date.parse(b.started_at) : NaN;
  const via = b.agent_via === "direct" || b.agent_via === "sibling" || b.agent_via === "broker" || b.agent_via === "none" ? b.agent_via : null;
  const left = typeof b.restarts_left === "number" && Number.isInteger(b.restarts_left) && b.restarts_left >= 0 && b.restarts_left < 10000 ? b.restarts_left : null;
  const instance = typeof b.instance === "string" && /^[0-9a-f]{32}$/.test(b.instance) ? b.instance : null;
  return {
    // A process that says not which one it is declares nothing: an order is bound to the process that took it, and one that
    // names none could take the real process's orders without the two-processes check ever seeing it.
    takes: instance ? canonicalKinds(b.orders) : null,
    instance,
    started_at: Number.isFinite(started) && started <= now + 5 * MIN ? iso(started) : null,
    agent_via: via,
    site: typeof b.site === "string" && /^[0-9a-f]{16}$/.test(b.site) ? b.site : null,
    restarts_left: left,
    previous_exit: parsePreviousExit(b.previous_exit),
    version: typeof b.version === "string" ? b.version : null,
    probe,
    pairRestart: (headers.get("x-omarchy-broker-takes") ?? "").split(",").map((s) => s.trim()).includes("pair-restart"),
    rollout: rolloutJson(parseRollout(b.rollout)),
  };
}

// ---------- the set's rollout (#277, part 3) ----------

/**
 * What rolls a worker's set out, in one word (the design's §1.2 table,
 * total over what a claim can say): an updater from #277 on that follows the
 * pool (`follows`); one from before it (`old-updater`), which rolls out at
 * its own 15-minute round and ignores Update until that round replaces it;
 * an updater and a host timer's rollout.sh from before #277 at once
 * (`both`); the timer alone (`timer`, the Studio before its one-time step);
 * a host moved to an updater with none running (`stopped`); nothing
 * (`none`); or a worker that said nothing of it (`unknown`: a builder, which
 * has no socket; a bare binary; an image from before part 3; a container
 * that could not verify which one it is).
 */
export type SetRollout = "follows" | "old-updater" | "both" | "timer" | "stopped" | "none" | "unknown";
export const SET_ROLLOUTS: readonly SetRollout[] = ["follows", "old-updater", "both", "timer", "stopped", "none", "unknown"];

/**
 * What a worker says of its set with its claims (part 3 of #277 on): the
 * updater service of its own compose project — the release its image says
 * it is (OMARCHY_IMAGE) and whether that image follows the pool
 * (com.omarchy.updater.follows=1) — and the host's rollout.sh by its marker
 * line (`kick-v1`: #277's wake-up; `old`: a script of its own, a timer's;
 * `none`: no file it can read). Or, when it could not look, why: a bare
 * binary, or a container that could not verify which one it is.
 */
export type RolloutReport =
  | { updater: { image: string | null; follows: boolean } | null; host_script: "kick-v1" | "old" | "none" }
  | { unknown: "bare" | "unidentified" };

/** A claim's `rollout`, checked: anything malformed is not reported (null) — never a claim refused over it. */
export function parseRollout(v: unknown): RolloutReport | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.unknown === "bare" || o.unknown === "unidentified") return { unknown: o.unknown };
  const script = o.host_script === "kick-v1" || o.host_script === "old" || o.host_script === "none" ? o.host_script : null;
  if (!script || !("updater" in o)) return null;
  if (o.updater === null) return { updater: null, host_script: script };
  const u = o.updater;
  if (!u || typeof u !== "object" || Array.isArray(u) || typeof (u as Record<string, unknown>).follows !== "boolean") return null;
  const image = (u as Record<string, unknown>).image;
  return { updater: { image: typeof image === "string" && /^[A-Za-z0-9._+-]{1,40}$/.test(image) ? image : null, follows: (u as { follows: boolean }).follows }, host_script: script };
}

/** The report as the row keeps it: one form, whatever order the claim's keys came in — so the same words never write. */
export function rolloutJson(r: RolloutReport | null): string | null {
  if (!r) return null;
  if ("unknown" in r) return JSON.stringify({ unknown: r.unknown });
  return JSON.stringify({ updater: r.updater ? { image: r.updater.image, follows: r.updater.follows } : null, host_script: r.host_script });
}

export function rolloutOf(v: string | null | undefined): RolloutReport | null {
  try { return parseRollout(v ? JSON.parse(v) : null); } catch { return null; }
}

/** The one word, from the report (the design's §1.2 table, W3): every pair of updater and host script maps to exactly one. */
export function setRollout(r: RolloutReport | null): SetRollout {
  if (!r || "unknown" in r) return "unknown";
  if (r.host_script === "old") return r.updater ? "both" : "timer";
  if (!r.updater) return r.host_script === "kick-v1" ? "stopped" : "none";
  return r.updater.follows ? "follows" : "old-updater";
}

/** Why a worker's set is unknown to the pool, by what its claims show: it runs outside a container, it could not verify its own container, or its image is from before it reported its set. */
function unknownWhy(r: RolloutReport | null, version: string | null | undefined): string {
  if (r && "unknown" in r && r.unknown === "bare") return "started without compose: nothing replaces it";
  if (r && "unknown" in r) return "it cannot identify its own container (its log says why), so the pool cannot tell what replaces it";
  return `its image (${versionWord(version, "unknown")}) does not report its set: its host's updater or timer replaces it`;
}

/** The door's word for a project worker whose set does not follow the pool (§1.11.5): Update is refused, and this says why and what would change it. */
export function rolloutRefusal(r: RolloutReport | null, version: string | null | undefined): string | null {
  const word = setRollout(r);
  const image = r && !("unknown" in r) && r.updater ? versionWord(r.updater.image, "its image") : "its image";
  switch (word) {
    case "follows": return null;
    case "timer": return "this host rolls out by its own timer (a rollout.sh from before #277) and has no updater: the runbook's The Studio host has the one-time step. Until then its timer updates it within 15 min of a release";
    case "both": return "two rollouts run on this host (an updater, and a timer's rollout.sh from before #277): finish the one-time step of the runbook's The Studio host";
    case "old-updater": return `its updater (${image}) is older than #277: it rolls this set out at its own 15-min round and cannot take Update. That round replaces it with one that can`;
    case "stopped": return "this host was moved to an updater, but none is running: releases do not reach it. Its ./rollout.sh starts it again";
    case "none": return "no updater runs beside it: omarchy-worker start adds one";
    default: return unknownWhy(r, version);
  }
}

/** The worker page's *Its set* line and Status's words (§5.1): what rolls this worker's set out, in the pool's words — a builder's set is not visible from the pool (it has no socket). */
export function setLine(r: RolloutReport | null, version: string | null | undefined, trust: string | null | undefined): string {
  const word = setRollout(r);
  const image = r && !("unknown" in r) && r.updater && parseTag(r.updater.image) ? ` (${versionWord(r.updater.image)})` : "";
  switch (word) {
    case "follows": return `rolled out by its updater${image} — follows each release within ${FOLLOW_POLL_S / 60} min`;
    case "old-updater": return `rolled out by an updater from before #277${image}, every 15 min — its next round replaces it with one that follows the pool`;
    case "both": return "two rollouts on this host — finish the one-time step of the runbook's The Studio host";
    case "timer": return "rolled out by the host's timer (a rollout.sh from before #277) — the one-time step of the runbook's The Studio host gives it an updater";
    case "stopped": return "this host's updater is not running — releases do not reach it";
    case "none": return "no updater beside it";
    default: return trust !== "project" ? "rolled out by its set's updater (not visible from the pool: a builder has no socket)" : unknownWhy(r, version);
  }
}

/** Whether a claim's version is the pool's release: the same word, or a release the pool's is not newer than — what closes an Update (§1.5). */
export function runsRelease(v: string | null | undefined, pool: Pick<RunningVersion, "version" | "deployed_at">): boolean {
  if (v && v === pool.version) return true;
  return parseTag(v) !== null && parseTag(pool.version) !== null && !updateState(v, pool).outdated;
}

/** An Update nothing executed, in the words its final line keeps (§1.11.5). */
export const UPDATE_EXPIRED = `not replaced within ${TTL_UPDATE_MIN / 60} h: no updater beside it took the order (one from before #277 takes none; it replaces its set at its own 15-min round)`;

// ---------- the worker's row ----------

/** The columns of a worker's row the orders path decides on: workerOf reads them with the token, in the same seek, so a claim pays no read for them. */
export const ORDERS_COLUMNS = "owner, trust, version, kinds, agent, agent_status, agent_error, agent_checked_at, last_seen, last_task, open_orders, order_kinds, instance, instance_prev, instance_since, instance_conflict_at, instance_other_at, instance_churn, instance_finished, crash_loop_since, watchdog_exits, started_at, agent_via, site, restarts_left, rollout, agent_error_since, agent_probed_at, agent_error_class, drained_at, auto_orders, revoked_at";

export interface OrdersRow {
  id: string;
  owner: string | null;
  trust: string;
  version: string | null;
  kinds: string | null;
  agent: string | null;
  agent_status: string | null;
  agent_error: string | null;
  agent_checked_at: string | null;
  last_seen: string | null;
  last_task: string | null;
  open_orders: string | null;
  order_kinds: string | null;
  instance: string | null;
  instance_prev: string | null;
  instance_since: string | null;
  instance_conflict_at: string | null;
  instance_other_at: string | null;
  instance_churn: number | null;
  instance_finished: string | null;
  crash_loop_since: string | null;
  watchdog_exits: string | null;
  started_at: string | null;
  agent_via: string | null;
  site: string | null;
  restarts_left: number | null;
  rollout: string | null;
  agent_error_since: string | null;
  agent_probed_at: string | null;
  agent_error_class: string | null;
  drained_at: string | null;
  auto_orders: string | null;
  revoked_at?: string | null;
}

export interface OpenOrder { id: string; kind: OrderKind; state: "pending" | "delivered"; by: string; at: string; /** stop-task only: the task it fences. */ task?: number }

export function openOrdersOf(v: string | null | undefined): OpenOrder[] {
  if (!v) return [];
  try {
    const a = JSON.parse(v) as unknown;
    return Array.isArray(a) ? (a as OpenOrder[]).filter((o) => o && typeof o.id === "string" && isOrderKind(o.kind)) : [];
  } catch {
    return [];
  }
}

// ---------- the instance step ----------

/** A journal line the step writes, once: `guard` is the column and the value the step wrote, so a race that lost writes no line (the line's INSERT is conditional on the row holding that value). */
export interface StepLine { status: "ok" | "warn"; summary: string; payload: Record<string, unknown>; guard: [string, string | null] }

export interface InstanceStep {
  /** The columns to write, beside the liveness write, only when `instance` still holds `guard` (compare-and-set). Empty: nothing new. */
  set: Record<string, string | number | null>;
  guard: string | null;
  journal: StepLine[];
  /** After this claim: two processes share the token. */
  conflict: boolean;
  /** After this claim: the instance and when it first claimed, on the pool's clock. */
  instance: string | null;
  instanceSince: string | null;
}

interface WatchdogExits { n: number; since: string; last: string; stuck_in: string | null }

/** A process as the public record names it: its first four hex digits. The whole instance is what binds an order to a process — the journal is public, so it never carries one. */
const short = (i: string | null) => (i ? i.slice(0, 4) + "…" : "none");

/** A version as the pool's public words say it: a release tag it parsed, never the worker's own string (a claim's `version` is whatever its sender wrote). */
export function versionWord(v: string | null | undefined, otherwise = "its version"): string {
  const t = parseTag(v);
  return t ? `v${t.join(".")}` : otherwise;
}

/**
 * The site a claim names, as the pool keeps it: the host's hash under the
 * name of who runs it — the project's workers under the project's, a
 * contributor's under their login. A site is a worker's own word, so a
 * hash another worker says it shares means nothing unless the same people
 * run both: a leaked hash cannot join a host's election or its pacing.
 */
export function siteKey(row: Pick<OrdersRow, "trust" | "owner">, site: string | null): string | null {
  if (!site) return null;
  return row.trust === "project" ? `project/${site}` : `${row.owner ?? "?"}/${site}`;
}

/**
 * What a claim says of the process behind it, against the row: one process
 * that goes on (nothing to write), a new one (the fields a process declares
 * once, and the churn that a crash loop shows as), or two on one token (a
 * copied token: journaled once, and orders are held). Pure: the result goes
 * into the claim's one write (touchWorker), guarded by compare-and-set on
 * the instance, so two claims at once never write it twice — and a worker
 * that alternates two processes writes at most once per TOUCH_MINUTES, the
 * liveness write it takes the place of (PR #226).
 *
 * A process that names no instance is one too (an image from before
 * orders, or a sender that leaves it out): it declares nothing and takes
 * no order, and beside a process that does name one it is the second
 * process on the token.
 *
 * While two processes share the token, any claim from a process other than
 * the one the row names is the other's: it is recorded at most every
 * TOUCH_MINUTES, and the process it came from becomes the one the row
 * names. So whichever of the two stops — or a second process that draws a
 * new instance at every claim — the conflict holds while two claim, and
 * ends only once one process has claimed alone for CONFLICT_WINDOW_MIN.
 *
 * A process counts toward a crash loop only when it lived under
 * CHURN_WINDOW_MIN, finished no task, and nothing explains its end: no
 * restart delivered to it, no stop of its task, no new version, no
 * deliberate exit its successor reports. A community builder runs one task
 * per container, so every task is a new process: one that finished its
 * task is never counted, however short its life.
 */
export function instanceStep(row: OrdersRow, c: ClaimFacts, now: number): InstanceStep {
  const at = iso(now);
  const set: InstanceStep["set"] = {};
  const journal: StepLine[] = [];
  const kinds = c.takes === null ? null : JSON.stringify(c.takes);
  const base = { worker: row.id, owner: row.owner };
  const out = (conflict: boolean, instance: string | null, since: string | null): InstanceStep => ({ set, guard: row.instance, journal, conflict, instance, instanceSince: since });
  const ci = c.instance;
  const since = row.instance_since ? Date.parse(row.instance_since) : NaN;
  const otherAt = row.instance_other_at ? Date.parse(row.instance_other_at) : NaN;
  let conflict = !!row.instance_conflict_at;
  if (conflict) {
    if (ci !== row.instance) {
      // The other process claims — the one before, or one never seen: recorded at most every TOUCH_MINUTES, whatever the
      // liveness write's rhythm, and it becomes the process the row names (instance_other_at: when it was recorded).
      if (!(now - otherAt < TOUCH_MINUTES * MIN)) {
        set.instance_prev = row.instance;
        set.instance = ci;
        set.instance_other_at = at;
        set.order_kinds = kinds;
        return out(true, ci, row.instance_since);
      }
      return out(true, row.instance, row.instance_since);
    }
    // The process the row names: the other has not been recorded for CONFLICT_WINDOW_MIN past the rhythm its claims are
    // recorded at, so it has not claimed for CONFLICT_WINDOW_MIN — one process again.
    if (now - otherAt < (CONFLICT_WINDOW_MIN + TOUCH_MINUTES) * MIN) return out(true, row.instance, row.instance_since);
    set.instance_conflict_at = null;
    set.instance_other_at = null;
    conflict = false;
    journal.push({ status: "ok", summary: `${row.id}: one process again on its token — orders are delivered again`, payload: { ...base, instance: short(ci) }, guard: ["instance_conflict_at", null] });
  }
  if (ci === row.instance) {
    // A crash loop ends with a process that stays up.
    if (!conflict && row.crash_loop_since && Number.isFinite(since) && now - since >= CHURN_CLEAR_MIN * MIN) {
      set.crash_loop_since = null;
      set.instance_churn = 0;
      journal.push({ status: "ok", summary: `${row.id}: stays up again — its process has run ${CHURN_CLEAR_MIN} min`, payload: { ...base, instance: short(ci) }, guard: ["crash_loop_since", null] });
    }
    // What a process declares is decided at its start; the same words in another order are the same words.
    if (kinds !== row.order_kinds) set.order_kinds = kinds;
    return out(conflict, row.instance, row.instance_since);
  }
  // The process before this one, back soon after this one first claimed: two processes on one token. The one that claims is
  // recorded, and becomes the one the row names.
  if (ci !== null && row.instance_prev && ci === row.instance_prev && Number.isFinite(since) && now - since < CONFLICT_WINDOW_MIN * MIN) {
    set.instance_conflict_at = at;
    set.instance_prev = row.instance;
    set.instance = ci;
    set.instance_other_at = at;
    set.order_kinds = kinds;
    journal.push({
      status: "warn",
      summary: `${row.id}: two processes share this worker's token (instances ${short(row.instance)} and ${short(ci)}) — orders are held until one stops; if you did not start two, revoke the token on its page`,
      payload: { ...base, instances: [short(row.instance), short(ci)] },
      guard: ["instance_conflict_at", at],
    });
    return out(true, ci, row.instance_since);
  }
  // A new process — or the old one back long after the new one first claimed: a change of process like any other.
  set.instance_prev = row.instance;
  set.instance = ci;
  set.instance_since = at;
  set.order_kinds = kinds;
  set.agent_via = c.agent_via;
  set.site = siteKey(row, c.site);
  set.restarts_left = c.restarts_left;
  if (c.started_at) set.started_at = row.started_at && row.started_at > c.started_at ? row.started_at : c.started_at;
  const open = openOrdersOf(row.open_orders);
  const prev = row.instance;
  const lived = prev !== null && Number.isFinite(since) ? now - since : Infinity;
  const finished = prev !== null && row.instance_finished === prev;
  const explained = !!c.previous_exit || open.some((o) => (o.kind === "restart" && o.state === "delivered") || o.kind === "stop-task") || (row.version ?? null) !== (c.version ?? null);
  let churn = prev !== null && lived < CHURN_WINDOW_MIN * MIN && !finished && !explained ? (row.instance_churn ?? 0) + 1 : 0;
  if (c.previous_exit?.why === "watchdog") {
    churn = 0;
    let w: WatchdogExits | null = null;
    try { w = row.watchdog_exits ? (JSON.parse(row.watchdog_exits) as WatchdogExits) : null; } catch { w = null; }
    const fresh = !w || !(now - Date.parse(w.since) < WATCHDOG_RESET_H * HOUR);
    const n = fresh ? 1 : w!.n + 1;
    const next: WatchdogExits = { n, since: fresh ? at : w!.since, last: at, stuck_in: c.previous_exit.stuck_in };
    set.watchdog_exits = JSON.stringify(next);
    const where = c.previous_exit.stuck_in ? `, stuck in ${c.previous_exit.stuck_in === "task" ? "a task" : c.previous_exit.stuck_in === "order" ? "an order" : "its claim"}` : "";
    if (n === 1) journal.push({ status: "warn", summary: `${row.id}: its watchdog restarted it — no claim and no accepted heartbeat for ${c.previous_exit.stuck_in === "task" ? WATCHDOG_TASK_MIN : WATCHDOG_MIN} min${where} (the next only after longer without progress); its log has why`, payload: { ...base, watchdog: next }, guard: ["watchdog_exits", JSON.stringify(next)] });
    else if (n === 3) journal.push({ status: "warn", summary: `${row.id}: ${n} watchdog restarts since ${clock(next.since)}: it wedges the same way each time — a person looks`, payload: { ...base, watchdog: next }, guard: ["watchdog_exits", JSON.stringify(next)] });
  }
  if (row.crash_loop_since && finished) {
    set.crash_loop_since = null;
    churn = 0;
    let task: number | null = null;
    try { task = row.last_task ? (JSON.parse(row.last_task) as { id?: number }).id ?? null : null; } catch { task = null; }
    journal.push({ status: "ok", summary: `${row.id}: works again${task ? `: it finished task #${task}` : ": it finished a task"}`, payload: { ...base, task }, guard: ["crash_loop_since", null] });
  } else if (churn >= CRASH_LOOP_AT && !row.crash_loop_since) {
    const on = versionWord(c.version, "its image");
    set.crash_loop_since = at;
    journal.push({
      status: "warn",
      summary: `${row.id}: a new process every few minutes on ${on} (${churn} in a row, none finished a task, none explained) — it may be crash-looping; its log has why`,
      payload: { ...base, churn, version: on },
      guard: ["crash_loop_since", at],
    });
  }
  set.instance_churn = churn;
  return out(conflict, ci, at);
}

// ---------- error classes ----------

export type ErrorClass = "auth" | "credit" | "rate" | "remote" | "refused" | "dns" | "install" | "sibling" | "unknown";
/** The classes a restart cannot help: the pool orders nothing for them, not even a re-check — the worker's own backoff keeps probing. */
export const NOTHING_CLASSES: readonly ErrorClass[] = ["auth", "credit", "rate", "remote"];
/** The classes the pool restarts on, and the breaker counts. */
export const RESTART_CLASSES: readonly ErrorClass[] = ["refused", "dns", "install", "sibling"];

/**
 * What kind of failure an agent's error is, from its words and from where
 * the worker's agent is (`agent_via`): a key, a bill or a rate a restart
 * cannot fix; a provider's own trouble (a 5xx, an overload, a timeout, when
 * the worker calls the provider itself) a restart cannot either; a refused
 * connection, a name that does not resolve, an install that did not finish,
 * or a sibling agent service or broker that does not answer — those a
 * restart may. Anything else is unknown, and the pool does not restart on
 * it: an outage worded a new way must not restart the fleet.
 */
export function errorClass(error: string | null | undefined, via: string | null | undefined): ErrorClass {
  const e = (error ?? "").toLowerCase();
  if (!e.trim()) return "unknown";
  if (/\b40[13]\b|invalid[ _-]?(?:x-)?(?:api[ _-]?)?key|unauthori[sz]ed|forbidden|authentication|permission denied/.test(e)) return "auth";
  if (/\b402\b|credit|quota|billing|payment required|insufficient[ _-]?funds|hit your limit/.test(e)) return "credit";
  if (/\b429\b|rate[ _-]?limit|too many requests/.test(e)) return "rate";
  if (/did not install|not installed|no `?claude`? binary|command not found|missing agent binary/.test(e)) return "install";
  if (/connection refused|errno 111|errno 61\b|econnrefused|connection reset|errno 104|econnreset/.test(e)) return "refused";
  if (/name or service not known|nodename nor servname|getaddrinfo|name resolution|could not resolve|errno -[23]\b|enotfound/.test(e)) return "dns";
  const status = /\b(?:500|503|504|529)\b|overloaded|internal server error|service unavailable|gateway timeout/.test(e);
  const timeout = /timed? ?out|timeout|did not answer|no answer/.test(e);
  const gateway = /\b502\b|bad gateway/.test(e);
  if (via === "sibling" || via === "broker") {
    if (status) return "remote"; // a 502 that wraps the provider's own status: the provider's trouble, passed through
    if (gateway || timeout) return "sibling";
    return "unknown";
  }
  if (status || timeout || gateway) return "remote";
  return "unknown";
}

const CLASS_WORDS: Record<ErrorClass, string> = {
  auth: "its key is refused",
  credit: "no credit",
  rate: "rate-limited",
  remote: "the provider's own trouble",
  refused: "connection refused",
  dns: "the name does not resolve",
  install: "its agent is not installed",
  sibling: "its agent service does not answer",
  unknown: "an error the pool does not know",
};

// ---------- the probe's age, on the pool's clock ----------

/**
 * How old the worker's last probe is, on the pool's clock: 0 when this
 * claim brings a new one (its agent_checked_at differs from the row's), the
 * time since the claim that brought the last one otherwise, and infinite
 * when the pool never saw one. The worker's own stamp only says whether the
 * probe changed: a worker clock minutes off changes nothing here.
 */
export function probeAge(row: Pick<OrdersRow, "agent_checked_at" | "agent_probed_at">, probe: Probe | undefined, now: number): number {
  if (probe && probe.checked_at !== row.agent_checked_at) return 0;
  return row.agent_probed_at ? now - Date.parse(row.agent_probed_at) : Infinity;
}

// ---------- the pool's rules ----------

/** The rules' state per worker (build_workers.auto_orders), written only by compare-and-set in the batch that issues the order. */
export interface AutoState {
  /** The spell it counts: the row's agent_error_since. A new spell starts the per-spell counts again. */
  spell: string | null;
  rechecks: number;
  restarts: number;
  last_recheck: string | null;
  last_restart: string | null;
  /** When the pool stopped restarting it in this spell (journaled once). */
  gave_up: string | null;
  /** The pool's issues of the last 24 h: c a re-check, r a restart-type order. */
  day: { k: "c" | "r"; at: string }[];
}

export function autoOf(v: string | null | undefined, spell: string | null, now: number): AutoState {
  let a: Partial<AutoState> = {};
  try { a = v ? (JSON.parse(v) as Partial<AutoState>) : {}; } catch { a = {}; }
  const day = Array.isArray(a.day) ? a.day.filter((d) => d && (d.k === "c" || d.k === "r") && now - Date.parse(d.at) < DAY) : [];
  if (a.spell !== spell) return { spell, rechecks: 0, restarts: 0, last_recheck: null, last_restart: null, gave_up: null, day };
  return { spell, rechecks: a.rechecks ?? 0, restarts: a.restarts ?? 0, last_recheck: a.last_recheck ?? null, last_restart: a.last_restart ?? null, gave_up: a.gave_up ?? null, day };
}

/** The scale of the step timings: honoured only where the running Worker is not a release (wrangler dev, the E2E); a release runs the rules at their real pace, whatever is set. */
export function rulesScale(env: Pick<Env, "POOL_VERSION"> & { WORKER_RULES_SCALE?: string }): { scale: number; ignored: boolean } {
  const n = Number(env.WORKER_RULES_SCALE ?? "");
  const asked = Number.isInteger(n) && n >= 1 && n <= 60 ? n : 1;
  if (parseTag(env.POOL_VERSION) !== null) return { scale: 1, ignored: asked !== 1 };
  return { scale: asked, ignored: false };
}

export function rulesOn(env: { WORKER_RULES?: string }): boolean {
  return (env.WORKER_RULES ?? "").trim().toLowerCase() !== "off";
}

/** What decideAuto proposes: an order, a give-up to journal, or nothing — with why, for the page. */
export type Decision =
  | { kind: "recheck-agent" | "restart" | "restart-agent"; rule: string; reason: string; unless: boolean; next: AutoState; cls: ErrorClass }
  | { kind: "give-up"; summary: string; next: AutoState; cls: ErrorClass }
  | { kind: null; why: string | null; cls: ErrorClass | null };

/** What the rules read of the claim, after this claim's own words. */
export interface RuleInput {
  row: OrdersRow;
  claim: ClaimFacts;
  /** The probe after this claim: status and error. */
  status: string | null;
  error: string | null;
  /** The spell after this claim (agent_error_since), the instance's first claim (the pool's clock), and whether two processes share the token. */
  spell: string | null;
  instanceSince: string | null;
  conflict: boolean;
  /** The worker needs an agent for what it declares (routes/factory.ts workerReady's rule). */
  needsAgent: boolean;
  /** The agent service this worker shares answers for another worker of its host (the site's read, only after a first proposal of restart-agent): this worker's own process is what fails. */
  siblingAnswers?: boolean;
}

/** A span as the reasons say it: seconds under a minute and a half (the rules' timings scaled in development), minutes past it. */
const span = (ms: number) => (ms < 90000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / MIN)} min`);

/**
 * The pool's rules for one claim, pure: a worker whose agent does not
 * answer is re-checked once its own re-check has stalled, then restarted —
 * conditionally, so a worker whose agent answers by then is not — at most
 * twice per spell, 30 minutes apart, then left to a person. A class a
 * restart cannot help gets nothing, not even a re-check. The uptime gate,
 * the per-spell and per-day counts are here; the site election, the breaker
 * and the caps are read or enforced by the caller, only when this proposes
 * a restart-type order.
 */
export function decideAuto(x: RuleInput, now: number, scale = 1): Decision {
  const { row, claim } = x;
  if (claim.takes === null || x.conflict || row.drained_at || !x.needsAgent) return { kind: null, why: null, cls: null };
  if (x.status !== "error" || !x.spell || openOrdersOf(row.open_orders).length) return { kind: null, why: null, cls: null };
  const via = claim.agent_via ?? row.agent_via;
  const cls = errorClass(x.error, via);
  if (NOTHING_CLASSES.includes(cls)) return { kind: null, why: `${cls}: a restart cannot help — its own re-check runs every 30 min`, cls };
  const auto = autoOf(row.auto_orders, x.spell, now);
  if (auto.gave_up) return { kind: null, why: `the pool gave up at ${clock(auto.gave_up)} after ${auto.restarts} restart(s) — a person looks`, cls };
  const step = (m: number) => (m * MIN) / scale;
  const spellAge = now - Date.parse(x.spell);
  const dayOf = (k: "c" | "r") => auto.day.filter((d) => d.k === k).length;
  const spellWords = `not ready for ${span(spellAge)} (${cls})`;
  // Step 0: one re-check, only when the worker's own has stalled (the probe is old on the pool's clock) — before any restart of the spell: a restarted process probes at its start.
  if (spellAge >= step(RECHECK_AFTER_MIN) && auto.restarts === 0 && auto.rechecks < MAX_POOL_RECHECKS_PER_SPELL && claim.takes.includes("recheck-agent") && dayOf("c") < MAX_POOL_RECHECKS_PER_DAY) {
    const age = probeAge(row, claim.probe, now);
    if (age >= step(RECHECK_AFTER_MIN)) {
      return {
        kind: "recheck-agent",
        rule: "recheck-stale",
        reason: `${spellWords}: its own re-check has not run for ${Number.isFinite(age) ? span(age) : "a while"} — the pool re-checks it`,
        unless: false,
        next: { ...auto, rechecks: auto.rechecks + 1, last_recheck: iso(now), day: [...auto.day, { k: "c", at: iso(now) }] },
        cls,
      };
    }
  }
  if (cls === "unknown") return { kind: null, why: "an error the pool does not know: it does not restart on it — a person looks", cls };
  if (auto.restarts >= MAX_POOL_RESTARTS_PER_SPELL) {
    if (auto.last_restart && now - Date.parse(auto.last_restart) >= step(GIVE_UP_AFTER_MIN)) {
      return {
        kind: "give-up",
        summary: `${row.id}: the pool stops restarting it — ${spellWords}, ${auto.restarts} restarts did not bring it back; a person looks: /worker/${row.id}`,
        next: { ...auto, gave_up: iso(now) },
        cls,
      };
    }
    return { kind: null, why: `restarted ${auto.restarts} times in this spell; the pool waits to see`, cls };
  }
  // Which order helps, by where the agent is.
  let kind: "restart" | "restart-agent" | null = null;
  if (via === "sibling") kind = claim.takes.includes("restart-agent") && !x.siblingAnswers ? "restart-agent" : "restart";
  else if (via === "broker") {
    if (!claim.pairRestart) return { kind: null, why: "its broker is older than pair restart: its updater replaces it; the pool only re-checks", cls };
    kind = "restart";
  } else kind = "restart";
  // The sibling was restarted already in this spell: the worker whose own probe still fails is restarted itself.
  if (kind === "restart-agent" && auto.restarts >= 1) kind = "restart";
  if (!claim.takes.includes(kind)) return { kind: null, why: kind === "restart" ? "it declares no restart it can survive: a person looks" : null, cls };
  // Timing: the first restart after RESTART_AFTER_MIN (and RECHECK_AFTER_MIN after the pool's re-check), the second RESTART_SPACING_MIN after the first.
  if (auto.restarts === 0) {
    if (spellAge < step(RESTART_AFTER_MIN)) return { kind: null, why: null, cls };
    if (auto.last_recheck && now - Date.parse(auto.last_recheck) < step(RECHECK_AFTER_MIN)) return { kind: null, why: null, cls };
  } else if (!auto.last_restart || now - Date.parse(auto.last_restart) < step(RESTART_SPACING_MIN)) return { kind: null, why: null, cls };
  // A process younger than MIN_UPTIME_S on the pool's clock is not restarted: the step waits, nothing is issued or counted.
  if (!x.instanceSince || now - Date.parse(x.instanceSince) < MIN_UPTIME_S * 1000) return { kind: null, why: `its process started under ${MIN_UPTIME_S / 60} min ago: the pool waits`, cls };
  if (dayOf("r") >= MAX_POOL_RESTARTS_PER_DAY) return { kind: null, why: `restarted ${MAX_POOL_RESTARTS_PER_DAY} times by the pool in 24 h: a person looks`, cls };
  const n = auto.restarts + 1;
  return {
    kind,
    rule: `${kind}-${n}of${MAX_POOL_RESTARTS_PER_SPELL}`,
    reason: kind === "restart-agent"
      ? `${spellWords}: its agent service does not answer — the pool restarts it through this worker (${n} of ${MAX_POOL_RESTARTS_PER_SPELL} in this spell)`
      : `${spellWords}: ${auto.rechecks ? "its re-checks" : "its own re-checks"} did not bring it back — restart ${n} of ${MAX_POOL_RESTARTS_PER_SPELL} in this spell`,
    unless: true,
    next: { ...auto, restarts: n, last_restart: iso(now), day: [...auto.day, { k: "r", at: iso(now) }] },
    cls,
  };
}

// ---------- who may press what ----------

/** A door's answer: allowed, or refused with the status and the reason the button's title reads. */
export type Verdict = { ok: true } | { ok: false; status: 401 | 403 | 404 | 409; why: string };

/** The buttons of a worker's page, and what the door takes. */
export const ORDER_RIGHTS = ["recheck", "restart", "restart_agent", "drain", "resume", "stop_task", "update", "cancel"] as const;
export type OrderRight = (typeof ORDER_RIGHTS)[number];
export const RIGHT_OF: Record<OrderKind, OrderRight> = { "recheck-agent": "recheck", restart: "restart", "restart-agent": "restart_agent", drain: "drain", resume: "resume", "stop-task": "stop_task", update: "update" };

/** The worker as the predicate reads it. Its trust, its drain and the task in hand (#277, part 2) decide Drain, Resume and Stop its task; its trust and its set's report decide Update (part 3 — a builder's set is not visible from the pool). */
export interface OrderWorker {
  id: string; owner: string | null; revoked_at: string | null; version: string | null; order_kinds: string | null; open_orders: string | null; instance_conflict_at: string | null; restarts_left: number | null; agent_via: string | null;
  trust?: string | null; drained_at?: string | null; drained_by?: string | null; drain_reason?: string | null; current_task?: number | null; rollout?: string | null;
}

/** The task a worker holds, as Stop its task reads it: by the worker row's current_task, the primary key. */
export interface HeldTask { id: number; kind: string; name: string; arch: string; version: string | null; owner: string | null; trust: string; status: string; lease_owner: string | null; lease_expires_at: string | null; stop_order: string | null; attempts: number; max_attempts: number; params: string | null }

/** What the counts say, read once for the door and /can: the worker's orders in the last hour by group — its drains too (#277, part 2) —, the caller's, and when the oldest of each leaves the window — and the task it holds (Stop its task), and the release the pool runs, which Update compares with (part 3). */
export interface OrderFacts { now: number; restartsHour: number; rechecksHour: number; loginHour: number; restartsFreeAt: string | null; rechecksFreeAt: string | null; loginFreeAt: string | null; drainsHour?: number; drainsFreeAt?: string | null; task?: HeldTask | null; pool?: Pick<RunningVersion, "version" | "deployed_at"> }

/** The per-login cap's words, the same at the door, on /can and in the journal's one line. */
export const loginCapWords = (login: string, freeAt: string | null) => `${login} reached ${MAX_ORDERS_PER_LOGIN_HOUR} orders in an hour; further orders refused until ${freeAt ? clock(freeAt) : "the hour ends"}`;

const KIND_WORD: Record<OrderKind, string> = { "recheck-agent": "a re-check", restart: "a restart", "restart-agent": "a restart of its agent service", drain: "a drain", resume: "a resume", "stop-task": "a stop of its task", update: "an update" };

/** Who drained a worker, when (on the pool's clock, said so), and why, as the refusals and the lines say it. */
export const drainWords = (w: { drained_by?: string | null; drained_at?: string | null; drain_reason?: string | null }) => `by ${w.drained_by ?? "?"}, ${w.drained_at ? utc(w.drained_at) : "?"}${w.drain_reason ? `: ${w.drain_reason}` : ""}`;
/** A seventh drain of a worker in an hour, the same words at the door and on /can. */
export const drainCapWords = (freeAt: string | null | undefined) => `drained ${MAX_RESTARTS_PER_HOUR} times in the last hour; the next from ${freeAt ? utc(freeAt) : "within the hour"}`;

/**
 * How soon a stopped task stops, by what runs it (§1.12 of #277's design):
 * the page cannot know which part of a build or a trial runs when the order
 * lands, so the dialog words each kind by its row — `child`, a process of
 * its own the worker kills within one heartbeat; `child-or-call`, a child
 * with transfers in the worker's own process around it; `next-call`, work in
 * the worker's own process, which ends at its next call to the pool; and
 * `lease-end`, an image whose last claim did not declare `stop-task` — one
 * from before #277, or from its first part, which takes orders but runs a
 * stopped task on — which does not stop on the pool's word and is given
 * back when its lease, which nothing renews, ends. A kind this map does not
 * know gets `next-call`: no kind is promised five minutes it may not keep.
 */
export type StopWay = "child" | "child-or-call" | "next-call" | "lease-end";
const STOP_WAYS: Record<string, StopWay> = { audit: "child", health: "child", build: "child-or-call", trial: "child-or-call" };
export function stopWay(kind: string, orderKinds: string | null | undefined): StopWay {
  let takes: unknown = null;
  try { takes = orderKinds ? JSON.parse(orderKinds) : null; } catch { takes = null; }
  if (!Array.isArray(takes) || !takes.includes("stop-task")) return "lease-end";
  return STOP_WAYS[kind] ?? "next-call";
}

/**
 * Who may press what on a worker's page, decided in one place: the door
 * (POST /factory/workers/:id/orders) refuses with the verdict, and
 * GET /factory/workers/:id/can carries the same verdicts for the page to
 * grey its buttons with — computed once, read twice, no drift. Its owner
 * and every maintainer give a worker orders; anyone else is refused
 * server-side. Then the worker's own state: an image that takes no orders,
 * a kind it does not declare, one open already, two processes on its
 * token, a restart policy close to running out, and the hourly caps.
 *
 * Drain, Resume and Stop its task (#277, part 2) are the pool's to carry
 * out, so they work on every image and whatever two processes do:
 * - a drain holds at once, until a Resume; at most six an hour per worker;
 * - who resumes (§1.10's table): a project worker, any maintainer — its
 *   owner, when not a maintainer, only a drain of their own: project trust
 *   is the maintainers' word, and so is keeping such a worker out; a
 *   contributor's worker its owner always — putting a machine back to work
 *   is its owner's word, the rule of sharing (0032) — and a maintainer only
 *   when a maintainer drained it; a maintainer who must keep it out revokes
 *   it, or sets it to its owner's packages only;
 * - Stop its task needs a task in hand, not stopped already; it counts in
 *   the restart group, like a restart.
 *
 * Update (#277, part 3) is its set's updater's to carry out: it needs a
 * worker behind the pool's release and, on a project worker, an updater
 * from #277 on beside it (updateVerdict).
 */
export function orderVerdicts(c: { login: string; role: string } | null, w: OrderWorker, f: OrderFacts): Record<OrderRight, Verdict> {
  const no = (status: 401 | 403 | 404 | 409, why: string): Verdict => ({ ok: false, status, why });
  const allow: Verdict = { ok: true };
  const out = {} as Record<OrderRight, Verdict>;
  const first = !c ? no(401, "sign in with GitHub")
    : w.revoked_at ? no(404, `${w.id} is revoked already`)
    : c.role !== "maintainer" && !(w.owner !== null && c.login === w.owner) ? no(403, w.owner ? `only ${w.owner} or a maintainer gives it orders` : "only a maintainer gives it orders")
    : null;
  const open = openOrdersOf(w.open_orders);
  const takes = w.order_kinds === null ? null : (() => { try { return JSON.parse(w.order_kinds!) as string[]; } catch { return []; } })();
  const login = f.loginHour >= MAX_ORDERS_PER_LOGIN_HOUR ? no(409, loginCapWords(c?.login ?? "you", f.loginFreeAt)) : null;
  const conflict = w.instance_conflict_at ? no(409, `two processes share this token since ${clock(w.instance_conflict_at)}: orders are held`) : null;
  const restartsCap = f.restartsHour >= MAX_RESTARTS_PER_HOUR ? no(409, `restarted ${MAX_RESTARTS_PER_HOUR} times in the last hour; the next from ${f.restartsFreeAt ? clock(f.restartsFreeAt) : "within the hour"}`) : null;
  const waiting = (kind: OrderKind): Verdict | null => {
    const o = open.find((x) => x.kind === kind);
    return o ? no(409, `${KIND_WORD[kind]} is waiting already (${o.id}, by ${o.by}, ${clock(o.at)})`) : null;
  };
  const poolKind = (kind: OrderKind): Verdict => {
    if (kind === "drain") {
      if (w.drained_at) return no(409, `drained already (${drainWords(w)}) — Resume ends it`);
      const drainsCap = (f.drainsHour ?? 0) >= MAX_RESTARTS_PER_HOUR ? no(409, drainCapWords(f.drainsFreeAt)) : null;
      return waiting(kind) ?? drainsCap ?? login ?? allow;
    }
    if (kind === "resume") {
      if (!w.drained_at) return no(409, "it is not drained: there is nothing to resume");
      const owner = w.owner !== null && c!.login === w.owner;
      // A project worker is the maintainers' to keep out: its owner, when not a maintainer, lifts only a drain of their own.
      if (w.trust === "project" && c!.role !== "maintainer" && w.drained_by !== c!.login) {
        return no(403, `${w.drained_by ?? "a maintainer"} drained it (${w.drained_at ? utc(w.drained_at) : "?"}${w.drain_reason ? `: ${w.drain_reason}` : ""}): a project worker goes back to work on a maintainer's word`);
      }
      // A contributor's machine its owner drained goes back to work on its owner's word only.
      if (w.trust !== "project" && !owner && w.owner !== null && w.drained_by === w.owner) {
        return no(403, `${w.owner} drained it (${utc(w.drained_at)}${w.drain_reason ? `: ${w.drain_reason}` : ""}): putting their machine back to work is theirs — to keep it out, revoke it or set it to its owner's packages only`);
      }
      // A resume is never counted — not against a login's twenty, not against the worker's hour: undoing a drain must stay possible.
      return allow;
    }
    // Stop its task: the task it holds now, not stopped already.
    const t = f.task ?? null;
    if (!w.current_task || !t || t.id !== w.current_task || t.status !== "leased" || t.lease_owner !== w.id) return no(409, "idle: there is no task to stop");
    if (t.stop_order) return no(409, `task #${t.id} is being stopped already: it goes back to the queue once this worker has stopped it`);
    return waiting(kind) ?? restartsCap ?? login ?? allow;
  };
  // Update (§1.11.5): its set's updater executes it, never the worker — so what the worker's process takes does not matter; what matters is
  // that it is behind the pool's release, and, for a project worker, that an updater from #277 on stands beside it. A builder cannot see
  // its set (no socket): outdated, it is allowed, and an Update nothing executes expires with UPDATE_EXPIRED's words.
  const updateVerdict = (): Verdict => {
    if (first) return first;
    const pool = f.pool;
    if (!pool || !parseTag(pool.version)) return no(409, `the pool runs no release (${pool?.version ?? "unknown"}): there is nothing to update to`);
    if (!parseTag(w.version)) return no(409, `its image reports no release (${w.version ?? "none"}): the pool cannot tell whether it is behind`);
    const u = updateState(w.version, pool);
    if (!u.outdated) {
      return versionWord(w.version) === versionWord(pool.version)
        ? no(409, `runs ${versionWord(w.version)}, the latest — its updater follows each release within ${FOLLOW_POLL_S / 60} min`)
        : no(409, `runs ${versionWord(w.version)}, newer than the pool's ${versionWord(pool.version)} — its updater follows the pool back within ${FOLLOW_POLL_S / 60} min`);
    }
    if (w.trust === "project") {
      const refused = rolloutRefusal(rolloutOf(w.rollout), w.version);
      if (refused) return no(409, refused);
    }
    return waiting("update") ?? conflict ?? restartsCap ?? login ?? allow;
  };
  const kindVerdict = (kind: OrderKind): Verdict => {
    if (kind === "update") return updateVerdict();
    if (first) return first;
    if (POOL_KINDS.includes(kind)) return poolKind(kind);
    if (takes === null) return no(409, `its image (${w.version ?? "unknown"}) takes no orders — its host's updater replaces it`);
    if (!takes.includes(kind)) {
      if (kind === "recheck-agent") return no(409, "it runs no agent to re-check");
      if (kind === "restart") return no(409, "its container has no restart policy it can count on: a restart would stop it for good");
      return no(409, `it calls no agent service of its own host (its agent is ${w.agent_via === "broker" ? "its broker's" : w.agent_via === "sibling" ? "a service it could not identify" : "the provider's, direct"})`);
    }
    if (kind === "restart" && w.restarts_left !== null && w.restarts_left < 3) return no(409, `its restart policy (on-failure) has ${w.restarts_left} restart${w.restarts_left === 1 ? "" : "s"} left: a restart could stop it for good`);
    const wait = waiting(kind);
    if (wait) return wait;
    if (conflict) return conflict;
    if (kind === "recheck-agent" && f.rechecksHour >= MAX_RECHECKS_PER_HOUR) return no(409, `re-checked ${MAX_RECHECKS_PER_HOUR} times in the last hour; the next from ${f.rechecksFreeAt ? clock(f.rechecksFreeAt) : "within the hour"}`);
    if (RESTART_GROUP.includes(kind) && restartsCap) return restartsCap;
    return login ?? allow;
  };
  for (const kind of ORDER_KINDS) out[RIGHT_OF[kind]] = kindVerdict(kind);
  // Cancel: the same people, on an order still waiting (the row decides which).
  out.cancel = first ?? allow;
  return out;
}

// ---------- the pool's sentences ----------

/** The closed codes of a worker's answer, per kind, with the outcome each belongs to and the pool's public sentence for it. The worker's own words stay private. */
const CODES: Record<string, Record<string, { outcome: Outcome; say: string }>> = {
  "recheck-agent": {
    probed: { outcome: "done", say: "re-checked its agent" },
    "probe-failed": { outcome: "failed", say: "its re-check did not run" },
  },
  restart: {
    exiting: { outcome: "accepted", say: "exiting; its restart policy starts it again" },
    "agent-ok": { outcome: "refused", say: "its agent answers now: no restart needed" },
    "too-young": { outcome: "refused", say: `started under ${MIN_UPTIME_S / 60} min ago: a restart this soon would loop` },
    "no-policy": { outcome: "refused", say: "its container has no restart policy: a restart would stop it for good" },
    "no-retries": { outcome: "refused", say: "its restart policy has too few restarts left: a restart could stop it for good" },
  },
  "restart-agent": {
    restarting: { outcome: "accepted", say: "restarting its agent service" },
    restarted: { outcome: "done", say: "restarted its agent service; it answers again" },
    "not-answering": { outcome: "failed", say: "restarted its agent service, which does not answer yet" },
    "not-a-sibling": { outcome: "refused", say: "it calls no agent service of its own host" },
    "agent-ok": { outcome: "refused", say: "its agent answers now: nothing to restart" },
    "docker-error": { outcome: "failed", say: "the container engine refused the restart" },
  },
};
export type Outcome = "accepted" | "done" | "refused" | "failed";
export const OUTCOMES: readonly Outcome[] = ["accepted", "done", "refused", "failed"];

/** A worker's answer's code as the pool keeps it: one of the kind's, "unknown-kind", or "other" when it is anything else or does not match the outcome. */
export function answerCode(kind: string, outcome: Outcome, code: unknown): string {
  if (code === "unknown-kind" && outcome === "refused") return "unknown-kind";
  const c = typeof code === "string" ? CODES[kind]?.[code] : undefined;
  return c && c.outcome === outcome ? (code as string) : "other";
}

/** The public sentence for a code: only what the pool knows or parsed and bounded — the service name from its own list, a number it checked. */
export function codeSentence(kind: string, code: string, outcome: Outcome, facts: { version?: string | null; service?: string | null; seconds?: number | null } = {}): string {
  if (code === "unknown-kind") return `does not know this order (${versionWord(facts.version)})`;
  const c = CODES[kind]?.[code];
  if (!c) return outcome === "accepted" ? "accepted" : `answered ${outcome}`;
  if (kind === "restart-agent" && (code === "restarted" || code === "not-answering")) {
    const svc = facts.service === "agent-proxy" || facts.service === "broker" ? facts.service : "its agent service";
    const secs = typeof facts.seconds === "number" && Number.isFinite(facts.seconds) && facts.seconds >= 0 && facts.seconds <= 600 ? ` after ${Math.round(facts.seconds)} s` : "";
    return code === "restarted" ? `restarted ${svc}; it answers again${secs}` : `restarted ${svc}, which does not answer yet${secs ? ` (waited${secs.replace(" after", "")})` : ""}`;
  }
  return c.say;
}

// ---------- the record ----------

const STATUS_OF_STATE: Record<string, "ok" | "warn" | "error"> = { done: "ok", refused: "ok", cancelled: "ok", expired: "warn", failed: "error" };

/**
 * The one final line of an order the pool closed at a claim, written only
 * when the row holds what this close wrote (its state, its time, its
 * words): a person's Cancel, the sweep or another claim that closed the
 * order first makes this close change nothing, and it writes no line — one
 * final line per order, whichever path closed it.
 */
function finalLine(env: Env, o: { id: string; worker: string; owner?: string | null; kind: string; by: string; state: string; code?: string | null; detail: string; rule?: string | null; via?: string | null; reason?: string | null; at: string }) {
  return env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'order', NULL, 'factory', ?, ?, ? WHERE EXISTS (SELECT 1 FROM worker_orders WHERE id = ? AND state = ? AND answered_at = ? AND answered_by = 'pool' AND detail IS ?)").bind(
    STATUS_OF_STATE[o.state] ?? "ok",
    `${o.worker}: ${o.kind} ${o.state} — ${o.detail} (order ${o.id})`,
    JSON.stringify({ order: o.id, worker: o.worker, owner: o.owner ?? null, kind: o.kind, by: o.by, via: o.via ?? null, rule: o.rule ?? null, reason: o.reason ?? null, state: o.state, code: o.code ?? null }),
    o.id, o.state, o.at, o.detail,
  );
}

/** The worker's open orders, as its row carries them for the claim and the pages: recomputed from the table, never incremented; written only when it changes. */
export const REFRESH_OPEN_SQL = (() => {
  // A stop-task names the task it fences: the pages say "stopping #812" from the row alone, with no read.
  const v = `(SELECT NULLIF(json_group_array(CASE WHEN o.task_id IS NULL THEN json_object('id', o.id, 'kind', o.kind, 'state', o.state, 'by', o.issued_by, 'at', o.issued_at) ELSE json_object('id', o.id, 'kind', o.kind, 'state', o.state, 'by', o.issued_by, 'at', o.issued_at, 'task', o.task_id) END), '[]') FROM (SELECT id, kind, state, issued_by, issued_at, task_id FROM worker_orders WHERE worker_id = ?1 AND state IN ('pending', 'delivered') ORDER BY kind) o)`;
  return `UPDATE build_workers SET open_orders = ${v} WHERE id = ?1 AND open_orders IS NOT ${v}`;
})();
export const refreshOpen = (env: Env, worker: string) => env.DB.prepare(REFRESH_OPEN_SQL).bind(worker);

// ---------- the issue, atomically ----------

/** The caps' counts, each by the index its WHERE starts with (EXPLAIN QUERY PLAN pins them). */
export const COUNT_WORKER_SQL = "SELECT COUNT(*) AS n, MIN(issued_at) AS oldest FROM worker_orders WHERE worker_id = ?1 AND kind IN (SELECT value FROM json_each(?2)) AND issued_at > ?3";
export const COUNT_ISSUER_SQL = "SELECT COUNT(*) AS n, MIN(issued_at) AS oldest FROM worker_orders WHERE issued_by = ?1 AND kind != 'resume' AND issued_at > ?2";
/** The pool's own orders since a time, both its identities, and those of one of them: its budget's and its hourly cap's counts, for the words a refusal says. */
export const POOL_ORDERS_SQL = `SELECT COUNT(*) AS n, MIN(issued_at) AS oldest FROM worker_orders WHERE issued_by IN ${POOL_IN} AND issued_at > ?1`;
export const POOL_RESTARTS_SQL = `SELECT COUNT(*) AS n FROM worker_orders WHERE issued_by IN ${POOL_IN} AND kind IN ('restart', 'restart-agent') AND issued_at > ?1`;
export const COMMUNITY_RESTARTS_SQL = `SELECT COUNT(*) AS n FROM worker_orders WHERE issued_by = '${POOL_COMMUNITY}' AND kind IN ('restart', 'restart-agent') AND issued_at > ?1`;

/**
 * The INSERT, only under every cap: the worker's group in the last hour
 * (never a resume's: undoing a drain must stay possible, and a resume
 * needs a drain, which is capped), the issuer's twenty (a person), the
 * pool's ten restart-type orders an hour and its sixty a day — of which the community's workers may take six
 * and forty —, the rules' compare-and-set on auto_orders. The
 * unique indexes add one open per kind per worker and one restart-agent per
 * site. D1 runs a batch in one transaction and serialises writers, so two
 * issues at once cannot both pass a count. And the state the pool's own
 * kinds act on (#277, part 2): a drain only of a worker not drained, a
 * resume only of one that is, a stop only of the task the worker holds now,
 * leased to it and not stopped yet — each read by its primary key.
 */
export const ISSUE_SQL = `INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, via, rule, unless_agent_ok, task_id, site, issued_at, expires_at, baseline_at_issue, state, delivered_at, delivered_to, baseline)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
 WHERE (?3 = 'resume' OR (SELECT COUNT(*) FROM worker_orders WHERE worker_id = ?2 AND kind IN (SELECT value FROM json_each(?18)) AND issued_at > ?19) < ?20)
   AND (?5 IN ${POOL_IN} OR ?3 = 'resume' OR (SELECT COUNT(*) FROM worker_orders WHERE issued_by = ?5 AND kind != 'resume' AND issued_at > ?19) < ${MAX_ORDERS_PER_LOGIN_HOUR})
   AND (?5 NOT IN ${POOL_IN} OR ?3 NOT IN ('restart', 'restart-agent') OR (SELECT COUNT(*) FROM worker_orders WHERE issued_by IN ${POOL_IN} AND kind IN ('restart', 'restart-agent') AND issued_at > ?19) < ${MAX_POOL_RESTARTS_PER_HOUR})
   AND (?5 != '${POOL_COMMUNITY}' OR ?3 NOT IN ('restart', 'restart-agent') OR (SELECT COUNT(*) FROM worker_orders WHERE issued_by = '${POOL_COMMUNITY}' AND kind IN ('restart', 'restart-agent') AND issued_at > ?19) < ${MAX_POOL_COMMUNITY_RESTARTS_PER_HOUR})
   AND (?5 NOT IN ${POOL_IN} OR (SELECT COUNT(*) FROM worker_orders WHERE issued_by IN ${POOL_IN} AND issued_at > ?21) < ${MAX_POOL_ORDERS_PER_DAY})
   AND (?5 != '${POOL_COMMUNITY}' OR (SELECT COUNT(*) FROM worker_orders WHERE issued_by = '${POOL_COMMUNITY}' AND issued_at > ?21) < ${MAX_POOL_COMMUNITY_ORDERS_PER_DAY})
   AND (?7 IS NULL OR (SELECT auto_orders FROM build_workers WHERE id = ?2) IS ?22)
   AND (?3 != 'drain' OR (SELECT drained_at FROM build_workers WHERE id = ?2) IS NULL)
   AND (?3 != 'resume' OR (SELECT drained_at FROM build_workers WHERE id = ?2) IS NOT NULL)
   AND (?3 != 'stop-task' OR EXISTS (SELECT 1 FROM build_tasks WHERE id = ?9 AND status = 'leased' AND lease_owner = ?2 AND stop_order IS NULL))`;

export interface IssueAsk {
  worker: string;
  owner: string | null;
  kind: OrderKind;
  reason: string;
  by: string;
  via: "web" | "token" | null;
  rule: string | null;
  unless: boolean;
  site: string | null;
  /** recheck: the row's agent_checked_at now (the order is stale once it moves). */
  baselineAtIssue: string | null;
  /** The rules' compare-and-set: the value read, and the value to write with the order. */
  auto?: { old: string | null; next: string };
  /** The rules issue at a claim and deliver in the same answer: the process, and what observation compares with. */
  deliverTo?: { instance: string; baseline: string | null };
  /** stop-task: the task it fences, which the worker must hold now. */
  task?: number | null;
  /** resume: the pool's words for the resume's own close, and for the drain it ends when that one still waits for a claim. */
  resumed?: { detail: string; drain: string };
  now: number;
  /** The issue line's words and status. */
  line: { status: "ok" | "warn"; summary: string };
}

export type IssueResult =
  | { ok: true; id: string; issued_at: string; expires_at: string }
  | { ok: false; why: "open" | "site" | "cap" };

export function orderId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return "wo_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * A resume closes the drain it ends when that one still waits for a claim:
 * its final line first, while it is open, then the close — each only when
 * the resume's own INSERT went in. The worker's open drain, through the
 * partial index of the open ones (uq_worker_orders_open_kind): the
 * `state IN (…)` term is the index's own, so the planner may use it, and
 * the `state = 'pending'` term keeps a delivered order out.
 */
export const RESUME_DRAIN_LINE_SQL = `INSERT INTO events (kind, ring, source, status, summary, payload)
  SELECT 'order', NULL, 'factory', 'ok', worker_id || ': drain done — ' || ?1 || ' (order ' || id || ')',
         json_object('order', id, 'worker', worker_id, 'kind', kind, 'by', issued_by, 'via', via, 'rule', rule, 'reason', reason, 'state', 'done', 'code', NULL)
    FROM worker_orders WHERE worker_id = ?2 AND kind = 'drain' AND state IN ('pending', 'delivered') AND state = 'pending' AND EXISTS (SELECT 1 FROM worker_orders WHERE id = ?3)`;
export const RESUME_DRAIN_CLOSE_SQL = `UPDATE worker_orders SET state = 'done', answered_at = ?1, answered_by = 'pool', detail = ?2
  WHERE worker_id = ?3 AND kind = 'drain' AND state IN ('pending', 'delivered') AND state = 'pending' AND EXISTS (SELECT 1 FROM worker_orders WHERE id = ?4)`;

/** One order, issued atomically with its line (§4.2 of the design): nothing is written unless the INSERT is. */
export async function issueOrder(env: Env, a: IssueAsk): Promise<IssueResult> {
  const id = orderId();
  const at = iso(a.now);
  const ttl = a.kind === "update" ? TTL_UPDATE_MIN : isPool(a.by) ? TTL_POOL_MIN : TTL_PERSON_MIN;
  const expires = iso(a.now + ttl * MIN);
  const group = RESTART_GROUP.includes(a.kind) ? RESTART_GROUP : [a.kind];
  const cap = a.kind === "recheck-agent" ? MAX_RECHECKS_PER_HOUR : MAX_RESTARTS_PER_HOUR;
  const exists = "EXISTS (SELECT 1 FROM worker_orders WHERE id = ?)";
  const d = a.deliverTo;
  const task = a.kind === "stop-task" ? a.task ?? null : null;
  const payload = (state: string, extra: Record<string, unknown> = {}) => JSON.stringify({ order: id, worker: a.worker, owner: a.owner, kind: a.kind, by: a.by, via: a.via, rule: a.rule, reason: a.reason, state, code: null, ...(task ? { task } : {}), ...extra });
  const stmts = [
    env.DB.prepare(ISSUE_SQL).bind(
      id, a.worker, a.kind, a.reason, a.by, a.via, a.rule, a.unless ? 1 : 0, task, a.site, at, expires, a.baselineAtIssue,
      d ? "delivered" : "pending", d ? at : null, d ? d.instance : null, d ? d.baseline : null,
      JSON.stringify(group), iso(a.now - HOUR), cap, iso(a.now - DAY), a.auto ? a.auto.old : null,
    ),
    ...(a.auto ? [env.DB.prepare(`UPDATE build_workers SET auto_orders = ? WHERE id = ? AND auto_orders IS ? AND ${exists}`).bind(a.auto.next, a.worker, a.auto.old, id)] : []),
    // A drain holds at once: the pool hands the worker nothing from its next claim, whatever its image (§1.10).
    ...(a.kind === "drain" ? [env.DB.prepare(`UPDATE build_workers SET drained_at = ?, drained_by = ?, drain_reason = ? WHERE id = ? AND drained_at IS NULL AND ${exists}`).bind(at, a.by, a.reason, a.worker, id)] : []),
    // Stop its task fences the lease (§1.16, P4): still leased to this worker, so no other worker can claim it and the ring lock
    // (RING_MOVERS) still holds; its heartbeats, reports and uploads are refused and renew nothing. It goes back to the queue at this
    // worker's next claim, or when the lease ends (lease.ts) — never while a token of this lease may still write.
    ...(task ? [env.DB.prepare(`UPDATE build_tasks SET stop_order = ? WHERE id = ? AND status = 'leased' AND lease_owner = ? AND stop_order IS NULL AND ${exists}`).bind(id, task, a.worker, id)] : []),
    // A resume ends the drain now: the drain order, if it still waits for a claim, closes with it — its final line first, while it is open.
    ...(a.kind === "resume" && a.resumed ? [
      env.DB.prepare(RESUME_DRAIN_LINE_SQL).bind(a.resumed.drain, a.worker, id),
      env.DB.prepare(RESUME_DRAIN_CLOSE_SQL).bind(at, a.resumed.drain, a.worker, id),
      env.DB.prepare(`UPDATE build_workers SET drained_at = NULL, drained_by = NULL, drain_reason = NULL WHERE id = ? AND drained_at IS NOT NULL AND ${exists}`).bind(a.worker, id),
      env.DB.prepare("UPDATE worker_orders SET state = 'done', answered_at = ?, answered_by = 'pool', detail = ? WHERE id = ? AND state = 'pending'").bind(at, a.resumed.detail, id),
    ] : []),
    refreshOpen(env, a.worker),
    env.DB.prepare(`INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'order', NULL, 'factory', ?, ?, ? WHERE ${exists}`).bind(
      a.line.status,
      a.line.summary,
      payload(d ? "delivered" : "pending"),
      id,
    ),
    // The resume's own final line: it is done at issue.
    ...(a.kind === "resume" && a.resumed ? [env.DB.prepare(`INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'order', NULL, 'factory', 'ok', ?, ? WHERE EXISTS (SELECT 1 FROM worker_orders WHERE id = ? AND state = 'done' AND answered_at = ?)`).bind(
      `${a.worker}: resume done — ${a.resumed.detail} (order ${id})`, payload("done"), id, at,
    )] : []),
  ];
  try {
    const res = await env.DB.batch(stmts);
    if (!res[0].meta.changes) return { ok: false, why: "cap" };
    return { ok: true, id, issued_at: at, expires_at: expires };
  } catch (e) {
    const m = String(e);
    if (/UNIQUE constraint failed: worker_orders\.site/.test(m)) return { ok: false, why: "site" };
    if (/UNIQUE constraint failed: worker_orders\.worker_id/.test(m)) return { ok: false, why: "open" };
    throw e;
  }
}

/** The counts behind the caps, for the door's words and /can's greys (the INSERT stays the authority). */
export async function orderFacts(env: Env, worker: string, login: string | null, now: number): Promise<OrderFacts> {
  const hourAgo = iso(now - HOUR);
  const freeAt = (oldest: string | null) => (oldest ? iso(Date.parse(oldest) + HOUR) : null);
  const [r, c, d, l] = await Promise.all([
    env.DB.prepare(COUNT_WORKER_SQL).bind(worker, JSON.stringify(RESTART_GROUP), hourAgo).first<{ n: number; oldest: string | null }>(),
    env.DB.prepare(COUNT_WORKER_SQL).bind(worker, JSON.stringify(["recheck-agent"]), hourAgo).first<{ n: number; oldest: string | null }>(),
    env.DB.prepare(COUNT_WORKER_SQL).bind(worker, JSON.stringify(["drain"]), hourAgo).first<{ n: number; oldest: string | null }>(),
    login ? env.DB.prepare(COUNT_ISSUER_SQL).bind(login, hourAgo).first<{ n: number; oldest: string | null }>() : null,
  ]);
  return {
    now, restartsHour: r?.n ?? 0, rechecksHour: c?.n ?? 0, loginHour: l?.n ?? 0, drainsHour: d?.n ?? 0,
    restartsFreeAt: freeAt(r?.oldest ?? null), rechecksFreeAt: freeAt(c?.oldest ?? null), loginFreeAt: freeAt(l?.oldest ?? null), drainsFreeAt: freeAt(d?.oldest ?? null),
    pool: running(env),
  };
}

/** A cap the pool hit is journaled once per window: the key decides. */
async function capLine(env: Env, key: string, status: "warn", summary: string, payload: Record<string, unknown>): Promise<void> {
  const res = await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(key, summary).run();
  if (res.meta.changes) await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('order', NULL, 'factory', ?, ?, ?)").bind(status, summary, JSON.stringify(payload)).run();
}

/** After an INSERT that the caps refused: which cap, in the words the door answers, journaled once per window when it is the login's or the pool's. */
export async function capRefusal(env: Env, a: Pick<IssueAsk, "worker" | "kind" | "by" | "now">): Promise<string> {
  const hourAgo = iso(a.now - HOUR);
  const pool = isPool(a.by);
  const f = await orderFacts(env, a.worker, pool ? null : a.by, a.now);
  if (!pool && f.loginHour >= MAX_ORDERS_PER_LOGIN_HOUR) {
    const hour = iso(a.now).slice(0, 13);
    const why = loginCapWords(a.by, f.loginFreeAt);
    await capLine(env, `order-cap:${a.by}:${hour}`, "warn", why, { by: a.by, cap: MAX_ORDERS_PER_LOGIN_HOUR });
    return why;
  }
  if (pool) {
    const community = a.by === POOL_COMMUNITY;
    const [day, mine] = await Promise.all([
      env.DB.prepare(POOL_ORDERS_SQL).bind(iso(a.now - DAY)).first<{ n: number; oldest: string | null }>(),
      community ? env.DB.prepare(COUNT_ISSUER_SQL).bind(POOL_COMMUNITY, iso(a.now - DAY)).first<{ n: number; oldest: string | null }>() : null,
    ]);
    if ((day?.n ?? 0) >= MAX_POOL_ORDERS_PER_DAY) {
      const from = day?.oldest ? clock(Date.parse(day.oldest) + DAY) : "tomorrow";
      const why = `the pool's daily budget of ${MAX_POOL_ORDERS_PER_DAY} automatic orders is spent: it acts again from ${from} tomorrow; people's orders still work`;
      await capLine(env, `order-budget:${iso(a.now).slice(0, 10)}`, "warn", why, { cap: MAX_POOL_ORDERS_PER_DAY });
      return why;
    }
    if (community && (mine?.n ?? 0) >= MAX_POOL_COMMUNITY_ORDERS_PER_DAY) {
      const from = mine?.oldest ? clock(Date.parse(mine.oldest) + DAY) : "tomorrow";
      const why = `the community's share of the pool's daily budget (${MAX_POOL_COMMUNITY_ORDERS_PER_DAY} of ${MAX_POOL_ORDERS_PER_DAY}) is spent: the pool orders contributors' workers again from ${from} tomorrow; the project's keep the rest, and people's orders still work`;
      await capLine(env, `order-budget:community:${iso(a.now).slice(0, 10)}`, "warn", why, { cap: MAX_POOL_COMMUNITY_ORDERS_PER_DAY });
      return why;
    }
    if (POOL_RESTARTS.includes(a.kind)) {
      const [all, theirs] = await Promise.all([
        env.DB.prepare(POOL_RESTARTS_SQL).bind(hourAgo).first<{ n: number }>(),
        community ? env.DB.prepare(COMMUNITY_RESTARTS_SQL).bind(hourAgo).first<{ n: number }>() : null,
      ]);
      if ((all?.n ?? 0) >= MAX_POOL_RESTARTS_PER_HOUR) {
        const why = `the pool gave ${MAX_POOL_RESTARTS_PER_HOUR} restart-type orders in the last hour across the fleet: it waits for the hour to pass`;
        await capLine(env, `order-cap:pool:all:${iso(a.now).slice(0, 13)}`, "warn", why, { cap: MAX_POOL_RESTARTS_PER_HOUR });
        return why;
      }
      if (community && (theirs?.n ?? 0) >= MAX_POOL_COMMUNITY_RESTARTS_PER_HOUR) {
        const why = `the pool gave contributors' workers ${MAX_POOL_COMMUNITY_RESTARTS_PER_HOUR} restart-type orders in the last hour, their share of ${MAX_POOL_RESTARTS_PER_HOUR}: it waits for the hour to pass`;
        await capLine(env, `order-cap:pool:community:${iso(a.now).slice(0, 13)}`, "warn", why, { cap: MAX_POOL_COMMUNITY_RESTARTS_PER_HOUR });
        return why;
      }
    }
  }
  if (a.kind === "recheck-agent" && f.rechecksHour >= MAX_RECHECKS_PER_HOUR) return `re-checked ${MAX_RECHECKS_PER_HOUR} times in the last hour; the next from ${f.rechecksFreeAt ? clock(f.rechecksFreeAt) : "within the hour"}`;
  if (RESTART_GROUP.includes(a.kind) && f.restartsHour >= MAX_RESTARTS_PER_HOUR) return `restarted ${MAX_RESTARTS_PER_HOUR} times in the last hour; the next from ${f.restartsFreeAt ? clock(f.restartsFreeAt) : "within the hour"}`;
  // A drain is its own group (#277, part 2): six an hour per worker. A resume is never counted: undoing a drain must stay possible.
  if (a.kind === "drain" && (f.drainsHour ?? 0) >= MAX_RESTARTS_PER_HOUR) return drainCapWords(f.drainsFreeAt);
  return "the rules' state moved under this order: the next claim decides again";
}

// ---------- delivery at the claim ----------

/** What a worker's claim answer carries, per order: nothing an order can add an action with — `unless_agent_ok` only restricts. */
export interface OrderOut { id: string; kind: OrderKind; reason: string; issued_by: string; issued_at: string; expires_at: string; unless_agent_ok: boolean; notice: boolean }

interface OpenRow { id: string; kind: OrderKind; reason: string; issued_by: string; issued_at: string; expires_at: string; state: "pending" | "delivered"; delivered_to: string | null; delivered_at: string | null; baseline: string | null; baseline_at_issue: string | null; unless_agent_ok: number; rule: string | null; via: string | null; task_id: number | null }

/** A worker's open orders, through uq_worker_orders_open_kind (the partial index on the open ones): at most one per kind. */
export const OPEN_ORDERS_SQL = "SELECT id, kind, reason, issued_by, issued_at, expires_at, state, delivered_to, delivered_at, baseline, baseline_at_issue, unless_agent_ok, rule, via, task_id FROM worker_orders WHERE worker_id = ? AND state IN ('pending', 'delivered') ORDER BY kind";
/** The task a Stop its task fences, by its primary key: what its requeue and its words need. */
export const STOPPED_TASK_SQL = "SELECT id, name, arch, kind, trust, status, lease_owner, attempts, max_attempts, stop_order FROM build_tasks WHERE id = ?";

type StoppedTask = LeasedTask & { status: string; lease_owner: string | null; stop_order: string | null };

/**
 * A stop whose task is no longer fenced by it, in the pool's words: the
 * lease ended first — the cron gave the task back, or failed it on its last
 * attempt, every token of it expired — or the task was cancelled, or is
 * gone. What became of the task is said from its status, as the build's own
 * line says it.
 */
export function stopEnded(t: Pick<StoppedTask, "id" | "status"> | null, issuedAt: string): { state: "done" | "failed"; detail: string } {
  if (t && t.status === "cancelled") return { state: "done", detail: `task #${t.id} was cancelled meanwhile: nothing left to stop` };
  const end = utc(Date.parse(issuedAt) + LEASE_MINUTES * MIN);
  const then = !t ? ""
    : t.status === "failed" ? `. Task #${t.id} failed then: that was its last attempt`
      : t.status === "done" || t.status === "staged" ? `. Task #${t.id} went back to the queue then, and has run to its end since`
        : `. Task #${t.id} went back to the queue then`;
  return { state: "failed", detail: `no claim before its lease ended at ${end}: its image may not stop on the heartbeat's answer (before #277), or the process is wedged (its watchdog restarts it)${then}` };
}

/** The claim, after its own words: what staleness and observation compare with. */
export interface AfterClaim {
  row: OrdersRow;
  claim: ClaimFacts;
  instance: string | null;
  instanceSince: string | null;
  conflict: boolean;
  /** The probe after this claim. */
  status: string | null;
  checkedAt: string | null;
}

const DELIVERY_ORDER: Record<string, number> = { drain: 0, "recheck-agent": 1, "restart-agent": 2, restart: 3 };

function refusedFor(kind: OrderKind, via: string | null): string {
  if (kind === "recheck-agent") return "it runs no agent to re-check";
  if (kind === "restart") return "its container has no restart policy it can count on: a restart would stop it for good";
  if (kind === "restart-agent") return `it calls no agent service of its own host (its agent is ${via === "broker" ? "its broker's" : "the provider's, direct"})`;
  return "its process does not take this order";
}

/**
 * The claim's delivery (§1.5 of the design): the worker's open orders are
 * read — only when its row says it has some — and each is closed when the
 * claim shows it is done or stale, refused when this process cannot take
 * it, or handed out once, to this process. What was delivered to a process
 * is closed by observation when a later claim shows the result: a new
 * process after a restart, a new probe after a re-check. One batch holds
 * every close, the delivery (conditional on the row still pending, so two
 * claims hand out an order once), the row's open list and one journal line
 * per order that closed.
 */
export async function takeOrders(env: Env, x: AfterClaim, now: number): Promise<OrderOut[]> {
  if (!x.row.open_orders) return [];
  const pool = running(env);
  const rows = (await env.DB.prepare(OPEN_ORDERS_SQL).bind(x.row.id).all<OpenRow>()).results;
  const at = iso(now);
  const closes: { r: OpenRow; state: "done" | "refused" | "failed" | "expired"; detail: string }[] = [];
  const deliver: OpenRow[] = [];
  const notices: OpenRow[] = [];
  const stops: OpenRow[] = [];
  const ok = x.status === "ok";
  for (const r of rows) {
    if (r.state === "delivered") {
      // While two processes share the token, which one claims is not known: a delivered order closes by its answer or at the sweep.
      if (x.conflict) continue;
      const mine = x.instance !== null && x.instance === r.delivered_to;
      if (r.kind === "restart" && x.instance && !mine) {
        closes.push({ r, state: "done", detail: `back as a new process (${Math.round((now - Date.parse(r.issued_at)) / 1000)} s after the order, on the pool's clock)` });
      } else if ((r.kind === "recheck-agent" || r.kind === "restart-agent") && x.instance && !mine) {
        closes.push({ r, state: r.kind === "recheck-agent" ? "expired" : "failed", detail: "its process ended before it answered" });
      } else if (mine && r.kind === "recheck-agent" && x.checkedAt !== r.baseline) {
        closes.push({ r, state: "done", detail: `re-checked: ${x.status ?? "no status"}` });
      } else if (mine && r.kind === "restart-agent" && x.checkedAt !== r.baseline && ok) {
        closes.push({ r, state: "done", detail: "its agent answers again" });
      }
      continue;
    }
    // A drain held at issue (#277): the claim that hears of it closes it — and says it, to a process that understands notices.
    if (r.kind === "drain") {
      if (Date.parse(r.expires_at) <= now) { closes.push({ r, state: "done", detail: "drained while it was not heard from: it is handed nothing until it is resumed" }); continue; }
      if (x.conflict) continue;
      closes.push({ r, state: "done", detail: "drained: it heard, and is handed nothing until it is resumed" });
      if (x.claim.takes !== null) notices.push(r);
      continue;
    }
    // Stop its task (#277): this claim proves the stopped task's processes are gone — the Rust loop claims only once the task's
    // work has returned, a builder from a fresh container — so the fence ends here and the task goes back to the queue. While two
    // processes share the token, the other one may be the one that runs it: nothing is requeued, and the lease's end decides.
    if (r.kind === "stop-task") {
      if (!x.conflict) stops.push(r);
      continue;
    }
    if (Date.parse(r.expires_at) <= now) { closes.push({ r, state: "expired", detail: r.kind === "update" ? UPDATE_EXPIRED : "not delivered in time: the worker did not claim" }); continue; }
    // An Update is never delivered: its set's updater takes it (GET /factory/follow). It is done once the worker claims on the pool's
    // release — whatever its image takes, since the worker executes nothing of it — and waits for the updater otherwise.
    if (r.kind === "update") {
      if (!x.conflict && runsRelease(x.claim.version, pool)) closes.push({ r, state: "done", detail: `now runs ${versionWord(x.claim.version, x.claim.version ?? "the pool's release")}` });
      continue;
    }
    if (!LIVE_KINDS.includes(r.kind)) continue;
    // While two processes share the token, nothing a claim says closes a waiting order: which of them spoke is not known.
    if (x.conflict) continue;
    if (x.claim.takes === null) { closes.push({ r, state: "refused", detail: `its image (${versionWord(x.claim.version, "its version")}) takes no orders — its host's updater replaces it` }); continue; }
    if (!x.claim.takes.includes(r.kind)) { closes.push({ r, state: "refused", detail: refusedFor(r.kind, x.claim.agent_via) }); continue; }
    if (r.kind === "restart" && x.instanceSince && x.instanceSince > r.issued_at) { closes.push({ r, state: "done", detail: `restarted since the order (a new process at ${clock(x.instanceSince)})` }); continue; }
    if (r.kind === "recheck-agent" && x.checkedAt !== r.baseline_at_issue) { closes.push({ r, state: "done", detail: `probed since the order: ${x.status ?? "no status"}` }); continue; }
    if (((r.kind === "restart" && r.unless_agent_ok) || r.kind === "restart-agent") && ok) { closes.push({ r, state: "done", detail: "its agent answers now; nothing to do" }); continue; }
    if (!x.instance) continue;
    deliver.push(r);
  }
  deliver.sort((a, b) => (DELIVERY_ORDER[a.kind] ?? 9) - (DELIVERY_ORDER[b.kind] ?? 9));
  if (!closes.length && !deliver.length && !stops.length) return [];
  const stmts: D1PreparedStatement[] = [];
  for (const c of closes) {
    stmts.push(env.DB.prepare("UPDATE worker_orders SET state = ?, answered_at = ?, answered_by = 'pool', detail = ? WHERE id = ? AND state = ?").bind(c.state, at, c.detail, c.r.id, c.r.state));
    stmts.push(finalLine(env, { id: c.r.id, worker: x.row.id, owner: x.row.owner, kind: c.r.kind, by: c.r.issued_by, state: c.state, detail: c.detail, rule: c.r.rule, via: c.r.via, reason: c.r.reason, at }));
  }
  // The fenced task back to the queue, in this claim's batch (lease.ts's statement, conditional on the fence still being this
  // order's), and the order closed only by the requeue that happened — the cron that got there first closes it at the sweep.
  const requeues: { at: number; task: StoppedTask; error: string }[] = [];
  for (const r of stops) {
    const t = r.task_id ? await env.DB.prepare(STOPPED_TASK_SQL).bind(r.task_id).first<StoppedTask>() : null;
    const line = (state: string, detail: string) => finalLine(env, { id: r.id, worker: x.row.id, owner: x.row.owner, kind: r.kind, by: r.issued_by, state, detail, rule: r.rule, via: r.via, reason: r.reason, at });
    if (t && t.status === "leased" && t.lease_owner === x.row.id && t.stop_order === r.id) {
      const error = stopError(x.row.id, r.issued_by, r.reason, false);
      const mins = Math.max(0, Math.round((now - Date.parse(r.issued_at)) / MIN));
      const last = t.attempts >= t.max_attempts;
      const detail = `stopped: it claimed again ${mins} min after the order; task #${t.id} ${last ? "failed: that was its last attempt" : "is back in the queue"}`;
      requeues.push({ at: stmts.length, task: { ...t, lease_owner: x.row.id }, error });
      stmts.push(requeueStatement(env, { id: t.id, lease_owner: x.row.id }, error, r.id, at));
      stmts.push(env.DB.prepare("UPDATE worker_orders SET state = 'done', answered_at = ?, answered_by = 'pool', detail = ? WHERE id = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM build_tasks WHERE id = ? AND stop_order IS NULL AND error = ?)").bind(at, detail, r.id, t.id, error));
      stmts.push(line("done", detail));
    } else {
      const e = stopEnded(t, r.issued_at);
      stmts.push(env.DB.prepare("UPDATE worker_orders SET state = ?, answered_at = ?, answered_by = 'pool', detail = ? WHERE id = ? AND state = 'pending'").bind(e.state, at, e.detail, r.id));
      stmts.push(line(e.state, e.detail));
    }
  }
  const baselineOf = (r: OpenRow) => (r.kind === "restart" ? x.instance : x.checkedAt);
  // One statement per order: each keeps its own baseline, and RETURNING says which were still pending.
  const deliveries = deliver.map((r) => env.DB.prepare("UPDATE worker_orders SET state = 'delivered', delivered_at = ?, delivered_to = ?, baseline = ? WHERE id = ? AND state = 'pending' RETURNING id").bind(at, x.instance, baselineOf(r), r.id));
  const first = stmts.length;
  stmts.push(...deliveries, refreshOpen(env, x.row.id));
  const res = await env.DB.batch(stmts);
  const handed = new Set<string>();
  for (let i = 0; i < deliveries.length; i++) for (const row of (res[first + i].results ?? []) as { id: string }[]) handed.add(row.id);
  // What follows a requeue — the worker's hand emptied, staged packages of a last attempt reclaimed, the package's word, the targets, the build's line — for each task this claim took back.
  for (const q of requeues) {
    const back = ((res[q.at].results ?? []) as { status: string }[])[0];
    if (back) await afterRequeue(env, q.task, back.status === "failed", q.error, true);
  }
  return [...notices.map(outOf), ...deliver.filter((r) => handed.has(r.id)).map(outOf)];
}

export function outOf(r: { id: string; kind: OrderKind; reason: string; issued_by: string; issued_at: string; expires_at: string; unless_agent_ok: number | boolean }): OrderOut {
  return { id: r.id, kind: r.kind, reason: r.reason, issued_by: r.issued_by, issued_at: r.issued_at, expires_at: r.expires_at, unless_agent_ok: !!r.unless_agent_ok, notice: r.kind === "drain" };
}

// ---------- the site, and the fleet breaker ----------

/** A site's live workers, through idx_build_workers_site: the election of the one that restarts a shared agent service, and the names the reasons give. The site is the pool's key for it (siteKey): only workers the same people run share one. */
export const SITE_WORKERS_SQL = "SELECT id, agent_via, agent_status, agent_error_class, order_kinds, instance_since, agent_error_since, auto_orders FROM build_workers WHERE site = ? AND revoked_at IS NULL AND last_seen > ?";
/** The site's pacing, through idx_worker_orders_site: the restart-type orders open on it now, anyone's — one restart at a time on a host —, and when the pool last issued one. */
export const SITE_PACE_SQL = `SELECT MAX(CASE WHEN issued_by IN ${POOL_IN} THEN issued_at END) AS last, SUM(state IN ('pending', 'delivered')) AS open FROM worker_orders WHERE site = ? AND issued_at > ? AND kind IN ('restart', 'restart-agent')`;
/** The breaker's open spells, every provider at once, through idx_build_workers_not_ready: the fleet's workers in a spell, never a ready worker's row. */
export const OPEN_SPELLS_SQL = "SELECT id, site, agent, agent_error_class, trust FROM build_workers WHERE agent_error_since IS NOT NULL AND agent_status = 'error' AND revoked_at IS NULL AND last_seen > ? AND agent_error_class IN ('refused', 'dns', 'install', 'sibling')";
/** The breakers that stand, by a range on the settings' key. */
export const BREAKER_KEYS_SQL = "SELECT key, value FROM settings WHERE key >= 'worker-breaker:' AND key < 'worker-breaker;'";

export const providerOf = (agent: string | null | undefined) => (agent && agent.includes("/") ? agent.slice(0, agent.indexOf("/")) : agent || "unknown");

export interface SiteWorker { id: string; agent_via: string | null; agent_status: string | null; agent_error_class: string | null; order_kinds: string | null; instance_since: string | null; agent_error_since?: string | null; auto_orders?: string | null }

/** What the site's two reads say: its live workers, and its restart-type orders. */
export interface SiteRead { live: SiteWorker[]; last: string | null; open: number }

export async function readSite(env: Env, site: string, now: number): Promise<SiteRead> {
  const [live, pace] = await Promise.all([
    env.DB.prepare(SITE_WORKERS_SQL).bind(site, iso(now - WORKER_ALIVE_MINUTES * MIN)).all<SiteWorker>(),
    env.DB.prepare(SITE_PACE_SQL).bind(site, iso(now - DAY)).first<{ last: string | null; open: number | null }>(),
  ]);
  return { live: live.results, last: pace?.last ?? null, open: pace?.open ?? 0 };
}

/** The other workers of the site that call the same agent service and are answered by it now: the service answers, so a worker whose own probe still fails is itself what fails. */
export function siblingsAnswering(self: { id: string }, live: SiteWorker[]): string[] {
  return live.filter((s) => s.id !== self.id && s.agent_via === "sibling" && s.agent_status === "ok").map((s) => s.id).sort();
}

export type SiteVerdict = { ok: true; others: string[] } | { ok: false; why: string; giveUp?: boolean };

/**
 * The site's word on a restart-type proposal, pure over its read: the
 * elected worker (the lowest id among the site's live workers in error that
 * declare restart-agent) restarts a shared agent service, the others wait
 * and are told through whom — and once the elected one has given up, they
 * give up too: the service was restarted as often as the pool restarts it,
 * and a person looks. One restart-type order open per site, anyone's, and
 * SITE_SPACING_MIN between two of the pool's.
 */
export function siteVerdict(self: { id: string }, kind: "restart" | "restart-agent", read: SiteRead, now: number, scale: number): SiteVerdict {
  const siblings = read.live.filter((s) => s.agent_via === "sibling" && s.agent_status === "error");
  const others = siblings.map((s) => s.id).filter((id) => id !== self.id).sort();
  if (kind === "restart-agent") {
    const takes = (s: SiteWorker) => { try { return (JSON.parse(s.order_kinds ?? "[]") as string[]).includes("restart-agent"); } catch { return false; } };
    const elected = siblings.filter(takes).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    if (elected && elected.id !== self.id) {
      const gave = elected.agent_error_since ? autoOf(elected.auto_orders ?? null, elected.agent_error_since, now).gave_up : null;
      if (gave) return { ok: false, giveUp: true, why: `its agent service, shared with ${others.join(", ")}, was restarted through ${elected.id}, which did not bring it back` };
      return { ok: false, why: `its agent service is shared with ${others.join(", ")}; the pool restarts it once, through ${elected.id}` };
    }
  }
  if (read.open > 0) return { ok: false, why: "a restart is open on this host already; one at a time" };
  if (read.last && now - Date.parse(read.last) < (SITE_SPACING_MIN * MIN) / scale) return { ok: false, why: `the pool restarted something on this host at ${clock(read.last)}; the next ${SITE_SPACING_MIN} min after it` };
  return { ok: true, others };
}

/**
 * What a worker's page says of its host, in the rules' own words (the
 * site's read, the verdict the rules would reach): who restarts the agent
 * service it shares, that the service answers another worker so the pool
 * restarts this one's own process, or why the pool waits. A restart of its
 * own that waits is on its page already. Null when the host has nothing
 * to say.
 */
export function siteWords(self: { id: string; order_kinds: string | null; open_orders?: string | null }, read: SiteRead, now: number, scale: number): string | null {
  const answering = siblingsAnswering(self, read.live);
  let takes: string[] = [];
  try { takes = self.order_kinds ? (JSON.parse(self.order_kinds) as string[]) : []; } catch { takes = []; }
  const kind = takes.includes("restart-agent") && !answering.length ? "restart-agent" : "restart";
  const mine = openOrdersOf(self.open_orders).some((o) => POOL_RESTARTS.includes(o.kind));
  const v = siteVerdict(self, kind, mine ? { ...read, open: 0, last: null } : read, now, scale);
  const why = v.ok ? null : v.giveUp ? `${v.why}: the pool stops restarting it — a person looks` : v.why;
  if (answering.length) return `its agent service answers for ${answering.join(", ")}: the pool restarts this worker's own process, not the service${why ? ` — ${why}` : ""}`;
  if (why) return why;
  if (v.ok && kind === "restart-agent" && v.others.length) return `its agent service is shared with ${v.others.join(", ")}: the pool restarts it once, through this worker`;
  return null;
}

export interface Breaker { since: string; peak: number; below_since: string | null }

export function breakerOf(v: string | null | undefined): Breaker | null {
  try { const b = v ? (JSON.parse(v) as Breaker) : null; return b && typeof b.since === "string" ? b : null; } catch { return null; }
}

/**
 * Whose spells a worker's breaker counts. A worker's error is its own word:
 * a contributor's registrations could say an outage that is not there. So
 * the project's workers are held only by the project's own spells (the
 * scope "project"), and a contributor's by every worker's ("all") — a
 * contributor can hold the pool's restarts of contributors' workers, never
 * of the project's. Each scope has its key: `worker-breaker:<provider>`,
 * and `worker-breaker:<provider>:project`.
 */
export type BreakerScope = "project" | "all";
export const breakerScope = (trust: string | null | undefined): BreakerScope => (trust === "project" ? "project" : "all");
export const breakerKey = (provider: string, scope: BreakerScope) => `worker-breaker:${provider}${scope === "project" ? ":project" : ""}`;
export function breakerOfKey(key: string): { provider: string; scope: BreakerScope } {
  const rest = key.slice("worker-breaker:".length);
  return rest.endsWith(":project") ? { provider: rest.slice(0, -":project".length), scope: "project" } : { provider: rest, scope: "all" };
}
const SCOPE_WORDS: Record<BreakerScope, { sites: string; workers: string }> = {
  project: { sites: "sites of the project's own", workers: "none of the project's workers of this provider" },
  all: { sites: "sites", workers: "no contributor's worker of this provider" },
};

/** Sites with an open spell, per provider, in a scope: a worker's site, or its own id when it has none. */
export function sitesByProvider(rows: { id: string; site: string | null; agent: string | null; trust?: string | null }[], scope: BreakerScope = "all"): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    if (scope === "project" && r.trust !== "project") continue;
    const p = providerOf(r.agent);
    if (!m.has(p)) m.set(p, new Set());
    m.get(p)!.add(r.site ?? `worker:${r.id}`);
  }
  return m;
}

/**
 * The fleet breaker, at a claim whose rules propose a restart-type order:
 * the key of the provider and the worker's scope, by the primary key —
 * tripped, and nothing more is read — or, without one, the open spells:
 * BREAKER_SITES distinct sites of the provider in the scope, in a class the
 * pool restarts on, the claiming worker among them, trip it. The trip is
 * journaled once, by the INSERT that wrote the key. While it stands the
 * pool restarts none of that provider's workers in the scope: an outage is
 * not fixed by restarting the fleet.
 */
export async function breakerHolds(env: Env, self: { id: string; site: string | null; agent: string | null; cls: ErrorClass; trust: string | null }, now: number): Promise<Breaker | null> {
  const provider = providerOf(self.agent);
  const scope = breakerScope(self.trust);
  const key = breakerKey(provider, scope);
  const held = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (held) return breakerOf(held.value);
  const rows = (await env.DB.prepare(OPEN_SPELLS_SQL).bind(iso(now - WORKER_ALIVE_MINUTES * MIN)).all<{ id: string; site: string | null; agent: string | null; agent_error_class: string | null; trust: string | null }>()).results.filter((r) => r.id !== self.id);
  // The claiming worker counts like any other, by what this claim says of it (its row is written after this read).
  if (RESTART_CLASSES.includes(self.cls)) rows.push({ id: self.id, site: self.site, agent: self.agent, agent_error_class: self.cls, trust: self.trust });
  const n = sitesByProvider(rows, scope).get(provider)?.size ?? 0;
  if (n < BREAKER_SITES) return null;
  const b: Breaker = { since: iso(now), peak: n, below_since: null };
  const res = await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind(key, JSON.stringify(b)).run();
  if (res.meta.changes) {
    const classes = [...new Set(rows.filter((r) => providerOf(r.agent) === provider && (scope === "all" || r.trust === "project")).map((r) => r.agent_error_class ?? "?"))].sort();
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('order', NULL, 'factory', 'warn', ?, ?)")
      .bind(`provider outage suspected: ${n} ${provider} ${SCOPE_WORDS[scope].sites} have an open agent error (${classes.join(", ")}) since ${clock(now)} — the pool restarts ${SCOPE_WORDS[scope].workers} until fewer than ${BREAKER_CLEAR_BELOW} have had one for ${BREAKER_CLEAR_MIN} min`, JSON.stringify({ breaker: provider, scope, sites: n, since: b.since }))
      .run();
    return b;
  }
  return breakerOf((await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value);
}

// ---------- the sweep ----------

/** Open orders past their time: every worker's, through uq_worker_orders_open_kind (the open ones only, a few rows). A waiting one past its TTL; a delivered one ANSWER_WITHIN_MIN after its delivery, whatever its TTL — a restart delivered in its TTL's last minute still has its half hour to answer. */
export const DUE_ORDERS_SQL = "SELECT id, worker_id, kind, reason, issued_by, via, rule, state, expires_at, delivered_at FROM worker_orders WHERE state IN ('pending', 'delivered') AND ((state = 'pending' AND expires_at <= ?) OR delivered_at <= ?)";

/**
 * Open stops whose task is no longer fenced by them (#277, part 2): the
 * lease ended first — the cron gave it back just before this sweep — or the
 * task was cancelled. The open orders through uq_worker_orders_open_kind (a
 * few rows), each task by its primary key.
 */
export const STOPS_DUE_SQL = `SELECT o.id, o.worker_id, o.task_id, o.issued_at, o.issued_by, o.via, o.rule, o.reason, o.state,
       (SELECT t.status FROM build_tasks t WHERE t.id = o.task_id) AS task_status
  FROM worker_orders o
 WHERE o.state IN ('pending', 'delivered') AND o.kind = 'stop-task'
   AND NOT EXISTS (SELECT 1 FROM build_tasks t WHERE t.id = o.task_id AND t.status = 'leased' AND t.lease_owner = o.worker_id AND t.stop_order = o.id)`;
/**
 * Builds pinned to a worker drained for FIRST_PICK_MINUTES or more, a
 * claim's rebuild included (§1.10): the queue through its own index
 * (idx_build_tasks_queue, status first — the queue's rows, bounded), each
 * pinned worker by its primary key. CROSS JOIN is SQLite's word for "this
 * order": the queue, never the workers, is walked.
 */
export const DRAINED_PINS_SQL = `SELECT t.pinned_to AS worker, w.drained_by AS drained_by, json_group_array(t.id) AS tasks
  FROM build_tasks t CROSS JOIN build_workers w ON w.id = t.pinned_to
 WHERE t.status = 'queued' AND t.pinned_to IS NOT NULL AND w.drained_at IS NOT NULL AND w.drained_at <= ?
 GROUP BY t.pinned_to`;
/** Revoke's unpin (routes/contributors.ts), with a word on the task for its page: which drained worker it was asked for, and when it went to the shared queue. */
export const UNPIN_DRAINED_SQL = "UPDATE build_tasks SET pinned_to = NULL, shared_after = NULL, params = json_set(COALESCE(params, '{}'), '$.unpinned', json(?)) WHERE status = 'queued' AND pinned_to = ?";

/**
 * The cron's part (every ten minutes, after the expired leases): an order
 * nobody delivered in time expires — a drain is done then, it held since its
 * issue —, a delivered one nobody answered within ANSWER_WITHIN_MIN is
 * closed — a re-check expired, a restart failed — each with its line; a
 * stop whose lease ended first is failed, the task back in the queue by
 * then (requeueExpiredLeases); the builds pinned to a worker drained for
 * FIRST_PICK_MINUTES go to the shared queue, one line per worker; a tripped
 * breaker clears once fewer than BREAKER_CLEAR_BELOW of its provider's
 * sites have had an open spell for BREAKER_CLEAR_MIN, at every sweep in
 * between; and a release that finds WORKER_RULES_SCALE set says once that
 * it ignores it.
 */
export async function sweepOrders(env: Env & { WORKER_RULES_SCALE?: string }, now = Date.now()): Promise<string> {
  const at = iso(now);
  const due = (await env.DB.prepare(DUE_ORDERS_SQL).bind(at, iso(now - ANSWER_WITHIN_MIN * MIN)).all<{ id: string; worker_id: string; kind: OrderKind; reason: string; issued_by: string; via: string | null; rule: string | null; state: "pending" | "delivered"; expires_at: string; delivered_at: string | null }>()).results
    .filter((o) => o.kind !== "stop-task");
  const stops = (await env.DB.prepare(STOPS_DUE_SQL).all<{ id: string; worker_id: string; task_id: number | null; issued_at: string; issued_by: string; via: string | null; rule: string | null; reason: string; state: "pending" | "delivered"; task_status: string | null }>()).results;
  const workers = new Set<string>();
  const stmts: D1PreparedStatement[] = [];
  for (const o of stops) {
    const e = stopEnded(o.task_status === null || o.task_id === null ? null : { id: o.task_id, status: o.task_status }, o.issued_at);
    stmts.push(env.DB.prepare("UPDATE worker_orders SET state = ?, answered_at = ?, answered_by = 'pool', detail = ? WHERE id = ? AND state = ?").bind(e.state, at, e.detail, o.id, o.state));
    stmts.push(env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'order', NULL, 'factory', ?, ?, ? WHERE EXISTS (SELECT 1 FROM worker_orders WHERE id = ? AND answered_at = ? AND state = ?)").bind(
      STATUS_OF_STATE[e.state], `${o.worker_id}: stop-task ${e.state} — ${e.detail} (order ${o.id})`, JSON.stringify({ order: o.id, worker: o.worker_id, kind: "stop-task", by: o.issued_by, via: o.via, rule: o.rule, reason: o.reason, state: e.state, code: null, task: o.task_id }), o.id, at, e.state,
    ));
    workers.add(o.worker_id);
  }
  for (const o of due) {
    const drain = o.kind === "drain" && o.state === "pending";
    const state = drain ? "done" : o.state === "pending" || o.kind === "recheck-agent" ? "expired" : "failed";
    const detail = drain ? "drained while it was not heard from: it is handed nothing until it is resumed" : o.state === "pending" ? (o.kind === "update" ? UPDATE_EXPIRED : "not delivered in time: the worker did not claim") : `no answer within ${ANSWER_WITHIN_MIN} min of delivery`;
    stmts.push(env.DB.prepare("UPDATE worker_orders SET state = ?, answered_at = ?, answered_by = 'pool', detail = ? WHERE id = ? AND state = ?").bind(state, at, detail, o.id, o.state));
    stmts.push(env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'order', NULL, 'factory', ?, ?, ? WHERE EXISTS (SELECT 1 FROM worker_orders WHERE id = ? AND answered_at = ? AND state = ?)").bind(
      STATUS_OF_STATE[state], `${o.worker_id}: ${o.kind} ${state} — ${detail} (order ${o.id})`, JSON.stringify({ order: o.id, worker: o.worker_id, kind: o.kind, by: o.issued_by, via: o.via, rule: o.rule, reason: o.reason, state, code: null }), o.id, at, state,
    ));
    workers.add(o.worker_id);
  }
  for (const w of workers) stmts.push(refreshOpen(env, w));
  if (stmts.length) await env.DB.batch(stmts);
  // A drained worker's pinned builds go to the shared queue once its drain has held FIRST_PICK_MINUTES: a drain that ends sooner unpins nothing.
  const pins = (await env.DB.prepare(DRAINED_PINS_SQL).bind(iso(now - FIRST_PICK_MINUTES * MIN)).all<{ worker: string; drained_by: string | null; tasks: string }>()).results;
  let unpinned = 0;
  for (const p of pins) {
    let tasks: number[] = [];
    try { tasks = JSON.parse(p.tasks) as number[]; } catch { tasks = []; }
    const res = await env.DB.batch([
      env.DB.prepare(UNPIN_DRAINED_SQL).bind(JSON.stringify({ from: p.worker, at }), p.worker),
      env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('order', NULL, 'factory', 'ok', ?, ?)")
        .bind(`${p.worker} is drained: ${tasks.length} build${tasks.length === 1 ? "" : "s"} pinned to it go${tasks.length === 1 ? "es" : ""} to the shared queue (${tasks.map((t) => `#${t}`).join(", ")})`, JSON.stringify({ worker: p.worker, drained_by: p.drained_by, unpinned: tasks })),
    ]);
    unpinned += res[0].meta.changes ?? 0;
  }
  // The breaker's clear, with hysteresis.
  let cleared = 0;
  const keys = (await env.DB.prepare(BREAKER_KEYS_SQL).all<{ key: string; value: string }>()).results;
  if (keys.length) {
    const rows = (await env.DB.prepare(OPEN_SPELLS_SQL).bind(iso(now - WORKER_ALIVE_MINUTES * MIN)).all<{ id: string; site: string | null; agent: string | null; trust: string | null }>()).results;
    const by = { project: sitesByProvider(rows, "project"), all: sitesByProvider(rows, "all") };
    for (const k of keys) {
      const { provider, scope } = breakerOfKey(k.key);
      const b = breakerOf(k.value) ?? { since: at, peak: 0, below_since: null };
      const n = by[scope].get(provider)?.size ?? 0;
      if (n >= BREAKER_CLEAR_BELOW) {
        const next = { ...b, peak: Math.max(b.peak, n), below_since: null };
        if (next.peak !== b.peak || b.below_since !== null) await env.DB.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?").bind(JSON.stringify(next), at, k.key, k.value).run();
      } else if (!b.below_since) {
        await env.DB.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?").bind(JSON.stringify({ ...b, below_since: at }), at, k.key, k.value).run();
      } else if (now - Date.parse(b.below_since) >= BREAKER_CLEAR_MIN * MIN) {
        const res = await env.DB.prepare("DELETE FROM settings WHERE key = ? AND value = ?").bind(k.key, k.value).run();
        if (res.meta.changes) {
          cleared++;
          await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('order', NULL, 'factory', 'ok', ?, ?)")
            .bind(`provider outage over: fewer than ${BREAKER_CLEAR_BELOW} ${provider} ${SCOPE_WORDS[scope].sites} have had an open agent error since ${clock(b.below_since)} (at most ${b.peak} at once, from ${clock(b.since)}) — the pool restarts again`, JSON.stringify({ breaker: provider, scope, peak: b.peak, since: b.since, cleared: at }))
            .run();
        }
      }
    }
  }
  // A release ignores the development scale, and says so once per deploy.
  const s = rulesScale(env);
  if (s.ignored) {
    await capLine(env, `rules-scale-ignored:${env.POOL_VERSION}`, "warn", `WORKER_RULES_SCALE=${env.WORKER_RULES_SCALE} is set but ignored: a release runs the rules at their real pace`, { version: env.POOL_VERSION });
  }
  return `orders: ${due.length + stops.length} closed, ${unpinned} build(s) unpinned${cleared ? `, ${cleared} breaker(s) cleared` : ""}`;
}

// ---------- revoke ----------

/**
 * What revoking workers does to their orders, in revoke's own batch: one
 * `cancelled` line per open order, then the orders, then the rows' open
 * lists — and their open spells, so a revoked worker leaves the breaker's
 * index at once. `which` is the SQL that names the workers, with its
 * bindings. The orders are read by their worker (idx_worker_orders_worker:
 * a revoked worker's history, bounded by the caps and the 90-day
 * retention — revoke and block are rare), the rows by the key `which`
 * reads them with; EXPLAIN QUERY PLAN pins both.
 */
export const CANCEL_LINES_SQL = (which: string) => `INSERT INTO events (kind, ring, source, status, summary, payload)
       SELECT 'order', NULL, 'factory', 'ok', worker_id || ': ' || kind || ' cancelled — ' || ? || ' (order ' || id || ')',
              json_object('order', id, 'worker', worker_id, 'kind', kind, 'by', issued_by, 'via', via, 'rule', rule, 'reason', reason, 'state', 'cancelled', 'code', NULL)
         FROM worker_orders WHERE worker_id IN (${which}) AND state IN ('pending', 'delivered')`;
export const CANCEL_ORDERS_SQL = (which: string) => `UPDATE worker_orders SET state = 'cancelled', answered_at = ?, answered_by = 'pool', detail = ? WHERE worker_id IN (${which}) AND state IN ('pending', 'delivered')`;
export const CANCEL_ROWS_SQL = (which: string) => `UPDATE build_workers SET open_orders = NULL, agent_error_since = NULL WHERE id IN (${which}) AND (open_orders IS NOT NULL OR agent_error_since IS NOT NULL)`;

export function cancelOrdersOf(env: Env, which: { sql: string; binds: unknown[] }, by: string, at: string): D1PreparedStatement[] {
  const detail = `the worker was revoked by ${by}`;
  return [
    env.DB.prepare(CANCEL_LINES_SQL(which.sql)).bind(detail, ...which.binds),
    env.DB.prepare(CANCEL_ORDERS_SQL(which.sql)).bind(at, detail, ...which.binds),
    env.DB.prepare(CANCEL_ROWS_SQL(which.sql)).bind(...which.binds),
  ];
}
