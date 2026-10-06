import { json, readJson, type Env } from "../index";
import { writeAttestation, recipesDir } from "./seal";
import { isRepoArch } from "../r2";
import { isMaintainer, viaOf, type Contributor, type WorkerIdentity } from "./contributors";
import { issueJobToken, scopesFor, type JobClaims } from "../jobtoken";
import { isCategory } from "../categories";
import { recordEvidence, vetSummary } from "../record";
import { isTextEvidence, reclaimStagingPackages, STAGING_QUOTA_BYTES } from "../staging";
import { findLeak } from "../leak";
import { chains, chainOf, storyRows, requestView, placeInQueue, stands, type Chain } from "./story";
import { betterIdleWorker, FIRST_PICK_MINUTES } from "../queue";
import { updateMessage, updateState } from "../update";
import { version as running, RINGS, ringsSql, sortRings, REPO_ARCHES, WORKER_ALIVE_MINUTES, type RunningVersion } from "../meta";
import { parseTargets, settleTargets } from "../targets";
import { afterRequeue, LEASE_MINUTES, packageAfterFailure, requeueLease, stopError } from "../lease";
import { asleepNow, freshSince, parseCapacity, unitsOf, BUILD_GB_PER_SIZE, UNIT, COMMUNITY_MAX_SIZE, DISK_FLOOR_GB, EMULATED_SHARE, HOST_AWAKE_SQL, HOST_CLAIM_SQL, HOST_MAY_LEASE_SQL, hostClaimRefusal, MAX_SIZE, TASK_UNITS, type Capacity, type HostClaimRow } from "../hosts";
import { largestSize, ownerCap, ownersLeased, reserve, select, sizeOf, ALIVE_MS, HELPER_KINDS, LANE_KINDS, RING_JOBS, OWNER_DIVISOR, RESERVE_AFTER_MS, RESERVE_FOR_MS, TASK_KINDS, type Candidate, type Fleet, type Held, type Lane, type Member, type Rules } from "../selection";
import { shippedSizing, sizingView, type Sizing } from "../sizing";
import {
  autoOf, breakerHolds, claimFacts, decideAuto, errorClass, instanceStep, issueOrder, NOTHING_CLASSES, openOrdersOf, outOf, poolFor, readSite, rolloutOf, rulesOn, rulesScale, setLine, setRollout, siblingsAnswering, HOST_ROLLOUT, HOST_SET_LINE, siteVerdict, takeOrders,
  capRefusal, type AfterClaim, type AutoState, type ClaimFacts, type Decision, type InstanceStep, type OrderOut, type OrdersRow,
} from "../orders";

/**
 * The factory's brain. Cloudflare is the source of truth for package
 * package requests and build tasks; build workers are ephemeral, live anywhere, and
 * *pull* work:
 *
 *   POST /factory/claim                 {arch, hostname?, labels?, version?, kinds?, agent?} → a task with a lease and its job token, or 204
 *   POST /factory/tasks/:id/heartbeat                                  extend the lease (a fresh job token)
 *   POST /factory/tasks/:id/complete    {sha256, filename, version, duration_ms?, log_tail?} · {result, summary} for jobs
 *   POST /factory/tasks/:id/fail        {error, duration_ms?, log_tail?, final?, needs_native?}   → requeued, or failed after max_attempts (at once when final: the recipe's fault, not the worker's; needs_native, from a lease on an emulated lane: back in the queue for a native lane — unpinned, the attempt given back; from a native lane it is refused, a failure like any other)
 * The worker is its registered token (POST /factory/workers); a task's
 * writes use the job token the claim issued.
 *
 * A lease that expires (worker died, build hung) goes back to the queue on
 * the scheduler's next tick. Maintainers (their token) or the enqueue job:
 *
 *   POST /factory/enqueue               {name, arches?, pkgbuild_ref, reason, version?, priority?, publish?} — by hand, publish:false only (#284)
 *   POST /factory/tasks/:id/cancel
 *
 * Read:
 *   GET  /factory                       overview: queue, workers, recent tasks
 */

interface TaskRow {
  id: number;
  name: string;
  arch: string;
  version: string | null;
  pkgbuild_ref: string;
  reason: string;
  priority: number;
  status: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result_sha256: string | null;
  result_filename: string | null;
  result_version: string | null;
  duration_ms: number | null;
  log_tail: string | null;
  error: string | null;
  created_at: string;
  kind: string;
  params: string | null;
  result: string | null;
  /** 0 = dry run: build and report, never publish. */
  publish: number;
  /** project: the worker signs and publishes · community: the result goes to staging for a maintainer. */
  trust: string;
  owner: string | null;
  pinned_to: string | null;
  staged_prefix: string | null;
  /** A Stop its task fenced this lease (#277): the open order's id — the task stays leased to its worker, and every heartbeat, report and upload of it is refused until it goes back to the queue. */
  stop_order: string | null;
  /** #334: a host registration's lease — its generation (NULL for a legacy one's), the units it takes, the claim that took it, and the `lost` reports that gave the attempt back. */
  lease_gen: string | null;
  units: number | null;
  /** #337: a build's size at lease. */
  size: number | null;
  /** The lane the lease runs on (#337, #338): native | emulated, NULL for a kind that carries none — and a legacy lease from before #337. */
  lane: string | null;
  claim_id: string | null;
  host_losses: number;
}

/** Who is calling a worker endpoint: a registered worker (own token) or a job (its per-task token). */
export type Actor = { kind: "worker"; w: WorkerIdentity } | { kind: "job"; job: JobClaims };

const now = () => new Date().toISOString();
const plusMinutes = (m: number) => new Date(Date.now() + m * 60000).toISOString();

async function event(env: Env, kind: string, status: string, summary: string, payload: unknown, source: string | null = "factory"): Promise<void> {
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES (?, NULL, ?, ?, ?, ?)")
    .bind(kind, source, status, summary, JSON.stringify(payload))
    .run();
}

function parseArches(v: unknown): string[] {
  const list = Array.isArray(v) ? v : [...REPO_ARCHES];
  return list.filter((a): a is string => typeof a === "string" && isRepoArch(a));
}

/**
 * Who already provides a name in edge. A factory build replaces the same
 * name in the ring, so a package Arch, ALARM or the OPR ship is never built
 * here by accident: it "enters the pool's cycle" as it is. chaotic-aur is the
 * exception — the factory is meant to take its names over.
 */
export async function providedBy(env: Env, name: string): Promise<{ source: string; arch: string; version: string }[]> {
  // From the name into edge, never edge into the name (CROSS JOIN is SQLite's word for "this order", as the package page's lookups say it):
  // with no statistics to go by, the planner walked every package edge serves to find one name — a row read per package in edge, on
  // every request and on every name the Factory's live check asks (#246); the name's rows through its index, each one's place in edge
  // by the key, is a handful.
  const rows = await env.DB.prepare(
    `SELECT p.source, p.repo_arch AS arch, p.version FROM packages p
      CROSS JOIN ring_packages rp ON rp.ring = 'edge' AND rp.package_id = p.id
      WHERE p.name = ?`,
  )
    .bind(name)
    .all<{ source: string; arch: string; version: string }>();
  return rows.results;
}

/**
 * Splits the requested architectures into the ones the factory should build
 * and the ones an upstream source already covers (skipped, with who ships
 * them). Per architecture: the OPR ships many names for x86_64 only, and
 * those are exactly what the factory builds for aarch64.
 */
export function splitByUpstream(provided: { source: string; arch: string; version: string }[], arches: string[], override: boolean | undefined): { build: string[]; skipped: { arch: string; source: string; version: string }[] } {
  const skipped: { arch: string; source: string; version: string }[] = [];
  const build = arches.filter((arch) => {
    const hit = provided.find((p) => p.arch === arch && !["factory", "chaotic"].includes(p.source));
    if (!hit || override) return true;
    skipped.push({ arch, source: hit.source, version: hit.version });
    return false;
  });
  return { build, skipped };
}

function nothingToBuild(skipped: { arch: string; source: string; version: string }[]): Response {
  return json(
    {
      error: `an upstream source already ships this package for every requested architecture (${skipped.map((s) => `${s.source} ${s.version} for ${s.arch}`).join(", ")}); it enters the pool's cycle as it is. Pass override:true to build it here anyway.`,
      skipped,
    },
    409,
  );
}

/**
 * The project's dry runs (#284): a build of its own that publishes nothing
 * and is no review build — by hand, a maintainer's only build. Never what
 * the factory built (`/factory/built`), and never the same task as a build
 * that publishes (ENQUEUE_DUP_SQL).
 */
const dryRun = (t: string) => `(${t}.trust = 'project' AND ${t}.publish = 0 AND json_extract(${t}.params, '$.review') IS NULL)`;
/**
 * An identical task already queued or running: the same recipe, and the same
 * `publish` — a maintainer's dry run never stands in for the enqueue job's
 * build of a recipe on main, nor that build for a dry run (#284). Led by the
 * name, (name, arch, id), as before; `+` keeps the planner there.
 */
export const ENQUEUE_DUP_SQL = "SELECT id FROM build_tasks WHERE name = ? AND arch = ? AND pkgbuild_ref = ? AND status IN ('queued', 'leased') AND +kind = 'build' AND +trust = 'project' AND +publish = ? LIMIT 1";

/** Queue one task per architecture unless an identical one is already queued or running. */
async function enqueue(env: Env, t: { name: string; arches: string[]; pkgbuild_ref: string; reason: string; version?: string | null; priority?: number; publish?: boolean }): Promise<number[]> {
  const ids: number[] = [];
  for (const arch of t.arches) {
    const dup = await env.DB.prepare(ENQUEUE_DUP_SQL)
      .bind(t.name, arch, t.pkgbuild_ref, t.publish === false ? 0 : 1)
      .first<{ id: number }>();
    if (dup) {
      ids.push(dup.id);
      continue;
    }
    const row = await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(t.name, arch, t.version ?? null, t.pkgbuild_ref, t.reason, t.priority ?? 100, t.publish === false ? 0 : 1)
      .first<{ id: number }>();
    if (row) ids.push(row.id);
  }
  return ids;
}

// ---------- maintainers / pipeline ----------

/**
 * POST /factory/enqueue — the project's build of a recipe, for its
 * architectures. The enqueue job (`hand` null: its token carries
 * factory:write) queues the recipes on main, and those publish into edge.
 * A maintainer by hand — the session or an `omc_` token — queues a dry run
 * only (#284): `publish: false`, built and reported, never published. What
 * publishes comes from the enqueue job or from an approval, and an approval
 * takes a passkey; so a build by hand that would publish is refused
 * (`dry_run_only`) before anything is read.
 */
export async function handleEnqueue(request: Request, env: Env, hand: Contributor | null): Promise<Response> {
  const b = await readJson<{ name?: string; arches?: unknown; pkgbuild_ref?: string; reason?: string; version?: string; priority?: number; override?: boolean; publish?: boolean }>(request);
  if (b instanceof Response) return b;
  if (!b.name || !b.pkgbuild_ref || !b.reason) return json({ error: "name, pkgbuild_ref and reason are required" }, 400);
  if (hand && b.publish !== false) return json({ error: `a build queued by hand is a dry run: send "publish": false — it builds and reports, and publishes nothing. What publishes comes from the enqueue job (a recipe on main) or from an approval, confirmed with a passkey; nothing was queued`, code: "dry_run_only" }, 403);
  const arches = parseArches(b.arches);
  const { build, skipped } = splitByUpstream(await providedBy(env, b.name), arches, b.override);
  if (!build.length) return nothingToBuild(skipped);
  const tasks = await enqueue(env, { name: b.name, arches: build, pkgbuild_ref: b.pkgbuild_ref, reason: b.reason, version: b.version ?? null, priority: b.priority, publish: b.publish });
  const note = (skipped.length ? `; ${skipped.map((s) => `${s.arch} skipped, ${s.source} ships ${s.version}`).join(", ")}` : "") + (b.publish === false ? "; dry run, nothing will be published" : "");
  await event(env, "enqueue", "ok", `${b.name}${b.version ? " " + b.version : ""}: ${tasks.length} build task(s) queued for ${build.join(", ")}${hand ? ` by ${hand.login}` : ""} (${b.reason})${note}`, { name: b.name, arches: build, skipped, pkgbuild_ref: b.pkgbuild_ref, reason: b.reason, tasks, ...(hand ? { by: hand.login, via: viaOf(request) } : {}) });
  return json({ tasks, arches: build, skipped }, 201);
}

export async function handleCancelTask(id: number, env: Env): Promise<Response> {
  const res = await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued', 'leased')").bind(now(), id).run();
  if (!res.meta.changes) return json({ error: "task is not queued or leased" }, 409);
  // What a leased worker had already staged: the lease is void, its next PUT is refused, the packages go.
  await reclaimStagingPackages(env, [id]);
  const t = await env.DB.prepare("SELECT name, kind FROM build_tasks WHERE id = ?").bind(id).first<{ name: string; kind: string }>();
  if (t?.kind === "build") await settleTargets(env, t.name);
  return json({ task: id, status: "cancelled" });
}

// ---------- workers ----------

/** The request behind a package name — where its record lives (null for a package that has none yet). */
async function requestOf(env: Env, name: string): Promise<number | null> {
  const r = await env.DB.prepare("SELECT request_id FROM factory_packages WHERE name = ?").bind(name).first<{ request_id: number | null }>();
  return r?.request_id ?? null;
}

/** The gate's verdict, read from the vet.json a worker staged — kept on the task so the review needs no second fetch. */
async function vetOf(env: Env, stagingPrefix: string): Promise<ReturnType<typeof vetSummary>> {
  const obj = await env.STAGING.get(`${stagingPrefix}vet.json`);
  if (!obj) return null;
  try {
    return vetSummary(await obj.json());
  } catch {
    return { verdict: "unknown", fails: 0, warnings: 0, failed: ["vet.json unreadable"], warned: [] };
  }
}

/** What the worker said about its agent with this claim: the probe's answer (factory/bin/agent.py --probe). */
interface AgentReport { status: "ok" | "error" | null; error: string | null; checked_at: string | null }

function agentReport(b: { agent_status?: unknown; agent_error?: unknown; agent_checked_at?: unknown }): AgentReport | undefined {
  if (b.agent_status === undefined) return undefined; // an older client: keeps what it last said
  const status = b.agent_status === "ok" ? "ok" : b.agent_status === "error" ? "error" : null;
  return { status, error: status === "error" && typeof b.agent_error === "string" ? b.agent_error.slice(0, 300) : null, checked_at: typeof b.agent_checked_at === "string" && b.agent_checked_at ? b.agent_checked_at : null };
}

/**
 * What the worker says of its machine with the claim: an average it keeps
 * of the host's CPU, its memory and the work directory's disk, in percent,
 * with the sizes behind them and the minutes the average covers. Anything
 * malformed is dropped, never a claim refused over it.
 */
export interface Usage { cpu: number; ram: number; disk: number; cores?: number; ram_gb?: number; disk_gb?: number; minutes?: number }

export function usageReport(u: unknown): Usage | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
  const cpu = pct(o.cpu), ram = pct(o.ram), disk = pct(o.disk);
  if (cpu === null || ram === null || disk === null) return null;
  const size = (v: unknown, digits: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Number(v.toFixed(digits)) : undefined);
  const out: Usage = { cpu, ram, disk };
  const cores = size(o.cores, 0), ram_gb = size(o.ram_gb, 1), disk_gb = size(o.disk_gb, 0), minutes = size(o.minutes, 0);
  if (cores !== undefined) out.cores = cores;
  if (ram_gb !== undefined) out.ram_gb = ram_gb;
  if (disk_gb !== undefined) out.disk_gb = disk_gb;
  if (minutes !== undefined) out.minutes = minutes;
  return out;
}

/**
 * What a worker sends of its own log with a claim: the lines since the last
 * one, a few kilobytes at most, for its owner and the maintainers to read on
 * the dashboard. A line that looks like a secret (leak.ts) is not kept: the
 * chunk is replaced by a word about it.
 */
export const WORKER_LOG_CHUNK = 4096;
export const WORKER_LOG_KEEP = 8192;
function workerLog(v: unknown): string {
  if (typeof v !== "string" || !v) return "";
  const text = v.length > WORKER_LOG_CHUNK ? v.slice(-WORKER_LOG_CHUNK) : v;
  const leak = findLeak(text);
  return leak ? `[${text.replace(/\n$/, "").split("\n").length} line(s) dropped: one looked like ${leak.kind}]\n` : text.endsWith("\n") ? text : text + "\n";
}

/**
 * A heartbeat is written when it says something new — or every
 * TOUCH_MINUTES, so the row stays younger than WORKER_ALIVE_MINUTES
 * (meta.ts) with three misses of slack. A worker claims every 30 s and an
 * idle one has nothing new to say 119 times in 120: written every time,
 * the eight workers' heartbeats were 20 k rows a day, the noisiest writer
 * of the account (2026-09-20). What counts as new is what the row's readers
 * act on at once — the task taken or finished, a log chunk, the version,
 * the agent and its probe, the kinds, the mode (while the worker's own flag
 * still applies), the labels, the host — never the usage: it is a rolling
 * average, at most TOUCH_MINUTES old, and the 7-day chart reads the metrics
 * events, not the row.
 */
export const TOUCH_MINUTES = 3;
/**
 * A host registration's row is written at least this often (#337): its
 * last claim is what selection counts it alive by — claimed in the last 2
 * minutes (selection.ts ALIVE_MS) — as native capacity an emulated lane
 * waits for, the largest host a size is clamped to, the fleet's builds the
 * per-owner cap divides, and a reservation's holder. A host claims every
 * 30 s, so a row a minute old at most stays alive; there are a handful of
 * hosts, and a legacy registration keeps TOUCH_MINUTES (selection counts it
 * alive that long and a minute more, LEGACY_ALIVE_MS).
 */
export const HOST_TOUCH_MINUTES = 1;
/** How long a legacy registration counts as alive for selection: its row's pace and a claim's slack. */
export const LEGACY_ALIVE_MS = (TOUCH_MINUTES + 1) * 60000;

export async function touchWorker(env: Env, w: { worker: string; arch: string; hostname?: string; labels?: unknown; version?: string; mode?: string; agent?: string | null; kinds?: string[]; probe?: AgentReport; usage?: Usage | null; log?: string; agentVia?: string | null; at?: string; spell?: { from: string | null; to: string | null } | null; touchMinutes?: number }, currentTask: number | null, step?: Pick<InstanceStep, "set" | "guard"> | null): Promise<D1Meta> {
  // The agent is what the worker says it runs ("<provider>/<model>"): a
  // worker that reports none ("" or null) clears it, one that says nothing
  // (an older client) keeps what it last reported. The probe's answer
  // travels the same way.
  // "claude-code/claude-sonnet-5" has a hyphen in the provider: the older
  // pattern refused it, and every Studio worker showed no agent (2026-09-15).
  const agent = w.agent === undefined ? undefined : typeof w.agent === "string" && /^[a-z0-9-]+\/[A-Za-z0-9._:-]{1,60}$/.test(w.agent) ? w.agent : null;
  // The spell and the probe's age on the pool's clock (#277): a spell begins
  // with the first failed probe and ends only with an answer; the probe's
  // age is measured from the claim that brought it, never from the worker's
  // own stamp, which is compared only for equality. The error's class rides
  // the same write, and moves only with the error. The spell's start is
  // assigned only in the write that begins or ends it (the caller says
  // which, from the row it read; compare-and-set on the value it read): it
  // keys the breaker's index, and a column an UPDATE assigns costs that
  // index a row at every liveness write, even when its value stays.
  const cls = w.probe?.status === "error" ? errorClass(w.probe.error, w.agentVia ?? null) : null;
  const spellSql = w.spell ? ", agent_error_since = CASE WHEN agent_error_since IS ? THEN ? ELSE agent_error_since END" : "";
  const spellBinds = w.spell ? [w.spell.from, w.spell.to] : [];
  // What a new process declares, or two on one token (orders.ts instanceStep): only while the row still names the process the step read.
  const extra = step ? Object.entries(step.set) : [];
  const extraSql = extra.map(([col]) => `, ${col} = CASE WHEN instance IS ? THEN ? ELSE ${col} END`).join("");
  const extraBinds = extra.flatMap(([, v]) => [step!.guard, v]);
  const res = await env.DB.prepare(
    `INSERT INTO build_workers (id, arch, hostname, labels, version, last_seen, current_task, agent, kinds, agent_status, agent_error, agent_checked_at, usage, usage_at, log_tail, log_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET arch = excluded.arch, hostname = COALESCE(excluded.hostname, hostname), labels = COALESCE(excluded.labels, labels),
       version = COALESCE(excluded.version, version), last_seen = excluded.last_seen, current_task = excluded.current_task,
       mode = CASE WHEN mode_by IS NULL THEN COALESCE(?, mode) ELSE mode END,
       log_tail = CASE WHEN excluded.log_tail IS NULL THEN log_tail ELSE substr(COALESCE(log_tail, '') || excluded.log_tail, -${WORKER_LOG_KEEP}) END,
       log_at = CASE WHEN excluded.log_tail IS NULL THEN log_at ELSE excluded.log_at END,
       agent = CASE WHEN ? THEN excluded.agent ELSE agent END, kinds = COALESCE(excluded.kinds, kinds),
       agent_status = CASE WHEN ? THEN excluded.agent_status ELSE agent_status END, agent_error = CASE WHEN ? THEN excluded.agent_error ELSE agent_error END,
       agent_checked_at = CASE WHEN ? THEN excluded.agent_checked_at ELSE agent_checked_at END,
       usage = COALESCE(excluded.usage, usage), usage_at = CASE WHEN excluded.usage IS NULL THEN usage_at ELSE excluded.usage_at END,
       agent_error_class = CASE WHEN ? THEN ? ELSE agent_error_class END,
       agent_probed_at = CASE WHEN ? AND agent_checked_at IS NOT excluded.agent_checked_at THEN excluded.last_seen ELSE agent_probed_at END${spellSql}${extraSql}
     WHERE current_task IS NOT excluded.current_task
       OR ?
       OR excluded.log_tail IS NOT NULL
       OR COALESCE(excluded.version, version) IS NOT version
       OR (? AND excluded.agent IS NOT agent)
       OR (? AND (agent_status IS NOT excluded.agent_status OR agent_error IS NOT excluded.agent_error OR agent_checked_at IS NOT excluded.agent_checked_at))
       OR COALESCE(excluded.kinds, kinds) IS NOT kinds
       OR (mode_by IS NULL AND ? IS NOT NULL AND ? IS NOT mode)
       OR COALESCE(excluded.labels, labels) IS NOT labels
       OR excluded.arch IS NOT arch
       OR COALESCE(excluded.hostname, hostname) IS NOT hostname
       OR last_seen < strftime('%Y-%m-%dT%H:%M:%fZ', excluded.last_seen, '-${w.touchMinutes ?? TOUCH_MINUTES} minutes')`,
  )
    .bind(
      w.worker, w.arch, w.hostname ?? null, w.labels ? JSON.stringify(w.labels) : null, w.version ?? null, w.at ?? now(), currentTask, agent ?? null,
      w.kinds ? JSON.stringify(w.kinds) : null, w.probe?.status ?? null, w.probe?.error ?? null, w.probe?.checked_at ?? null,
      w.usage ? JSON.stringify(w.usage) : null, w.usage ? w.at ?? now() : null, w.log || null, w.log ? w.at ?? now() : null,
      w.mode ?? null, agent === undefined ? 0 : 1, w.probe === undefined ? 0 : 1, w.probe === undefined ? 0 : 1, w.probe === undefined ? 0 : 1,
      w.probe === undefined ? 0 : 1, cls, w.probe === undefined ? 0 : 1, ...spellBinds, ...extraBinds,
      extra.length || w.spell ? 1 : 0, agent === undefined ? 0 : 1, w.probe === undefined ? 0 : 1, w.mode ?? null, w.mode ?? null,
    )
    .run();
  return res.meta;
}

/**
 * The worker row after a task: the lease is over, the counter moves, and the
 * row remembers what it just did — the Workers page reads the last task
 * there, one row per worker, not from build_tasks. The process that claimed
 * last is the one that held the task: it finished one (#277), so a
 * community builder, one task per container, is never a crash loop however
 * short each container's life — the same write, no statement of its own.
 */
async function workerFinished(env: Env, who: string, task: TaskRow, status: "done" | "staged" | "failed", version?: string | null): Promise<void> {
  const last = JSON.stringify({ id: task.id, kind: task.kind, name: task.name, version: version ?? task.version ?? null, status, at: now() });
  // A host's lease (#334) is one of several its registration holds: the result is counted, and nothing of the single-task row moves —
  // it has no current_task, and which process finished a task is the dispatcher's own report.
  const single = task.lease_gen === null ? ", current_task = NULL, instance_finished = instance" : "";
  await env.DB.prepare(`UPDATE build_workers SET last_seen = ?${single}, ${status === "failed" ? "builds_failed = builds_failed + 1" : "builds_done = builds_done + 1"}, last_task = ? WHERE id = ?`)
    .bind(now(), last, who)
    .run();
}

/** The work that needs an agent that answers: a draft (the PKGBUILD is the agent's), the project's review build (its recipe is), and an audit (the second agent). */
const agentScope = (t = "") => `(${t}kind = 'audit' OR (${t}kind = 'build' AND (${t}pkgbuild_ref LIKE 'draft:%' OR ${t}pkgbuild_ref LIKE 'review:%')))`;
export const AGENT_SCOPE = agentScope();

/** A worker is ready for what it declares when it is alive and, if that includes agent work, its agent answered last time. */
export function workerReady(w: { last_seen: string; kinds: string | null; agent: string | null; agent_status: string | null; trust: string }, aliveSince: number): boolean {
  if (Date.parse(w.last_seen) <= aliveSince) return false;
  const kinds: string[] = w.kinds ? (JSON.parse(w.kinds) as string[]) : w.trust === "project" ? [] : ["build"];
  const needsAgent = kinds.includes("audit") || (kinds.includes("build") && w.trust !== "project");
  return !needsAgent || w.agent_status === "ok";
}

const ALL_KINDS = ["build", "sync", "promote", "rollback", "render", "health", "security", "metrics", "gc", "enqueue", "audit", "verify", "relayout", "publish", "trial"];
/**
 * Jobs any architecture can run: they read the index or the staging area, not packages of one arch. A legacy registration's
 * rule; a host's is wider (design v2 §7.4, §8.6): every kind but builds, trials and jobs with helper containers (selection.ts).
 */
export const LEGACY_ANY_ARCH: readonly string[] = ["metrics", "gc", "security", "promote", "audit", "verify", "relayout"];
const ANY_ARCH_KINDS = LEGACY_ANY_ARCH.map((k) => `'${k}'`).join(", ");
/** What a host runs on no lane of its own: every kind but those selection schedules by lane or by a helper's arch. */
const HOST_ANY_ARCH_KINDS = ALL_KINDS.filter((k) => !LANE_KINDS.includes(k) && !HELPER_KINDS.includes(k)).map((k) => `'${k}'`).join(", ");
/** The ring jobs whose helpers need a lane of each architecture they check (selection.ts RING_JOBS): their row says which (`params.arch`). */
const RING_JOB_KINDS = RING_JOBS.map((k) => `'${k}'`).join(", ");

/** The signed constants selection runs with (factory/bundle/manifest.toml, hosts.ts), and the per-owner cap's divisor (the `owner-cap-divisor` setting). */
export function selectionRules(ownerDivisor: number = OWNER_DIVISOR): Rules {
  return {
    build_per_size: TASK_UNITS.build_per_size, trial: TASK_UNITS.trial, audit: TASK_UNITS.audit, job: TASK_UNITS.job, job_reserved: TASK_UNITS.job_reserved,
    max_size: MAX_SIZE, community_max_size: COMMUNITY_MAX_SIZE, gb_per_size: BUILD_GB_PER_SIZE, floor_gb: DISK_FLOOR_GB, emulated_share: EMULATED_SHARE,
    owner_divisor: ownerDivisor, legacy_any_arch: LEGACY_ANY_ARCH,
  };
}
/** Jobs that move a ring — one at a time per ring (the claim's lock). */
const RING_MOVERS = "'promote', 'rollback', 'render', 'security'";

/**
 * The claim's one write (touchWorker), with what the instance step says of
 * the process (orders.ts instanceStep) — and its journal lines, each
 * written only when the row holds what the step wrote, so a claim that lost
 * the race writes none. A step that fails to write is dropped, never the
 * claim: the liveness write goes again without it (the orders path fails
 * open).
 */
async function touchSaying(env: Env, said: Parameters<typeof touchWorker>[1], task: number | null, step: InstanceStep | null): Promise<void> {
  if (!step || (!Object.keys(step.set).length && !step.journal.length)) {
    await touchWorker(env, said, task);
    return;
  }
  try {
    await touchWorker(env, said, task, step);
    if (step.journal.length) {
      await env.DB.batch(step.journal.map((l) => env.DB.prepare(`INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'worker', NULL, 'factory', ?, ?, ? WHERE (SELECT ${l.guard[0]} FROM build_workers WHERE id = ?) IS ?`).bind(l.status, l.summary, JSON.stringify(l.payload), said.worker, l.guard[1])));
    }
  } catch (e) {
    console.error("orders:", e);
    await touchWorker(env, said, task);
  }
}

/** The orders path, fail open: whatever it throws is logged, and the claim goes on as if nothing were waiting. */
async function ordersSafely(f: () => Promise<OrderOut[]>): Promise<OrderOut[]> {
  try {
    return await f();
  } catch (e) {
    console.error("orders:", e);
    return [];
  }
}

/** A not-ready spell after a claim's probe: it begins with the first failed probe (the claim's time, the pool's clock), goes on while the probe fails or is not taken yet, and ends with an answer. */
function spellAfter(since: string | null, probe: AgentReport | undefined, at: string): string | null {
  if (!probe) return since;
  return probe.status === "error" ? since ?? at : probe.status === "ok" ? null : since;
}

/** The claim as the orders path reads it: the row with this claim's words on it — the probe, the process — as the write will leave it. */
function afterClaim(row: OrdersRow, facts: ClaimFacts, step: InstanceStep | null, probe: AgentReport | undefined, at: string): AfterClaim & { error: string | null; spell: string | null } {
  const merged = { ...row, ...(step?.set ?? {}) } as OrdersRow;
  const status = probe ? probe.status : row.agent_status;
  // The spell as touchWorker writes it, to the millisecond (spellAfter): it begins with the first failed probe (this claim's time), and ends only with an answer.
  const spell = spellAfter(row.agent_error_since, probe, at);
  return {
    row: merged,
    claim: facts,
    instance: step ? step.instance : row.instance,
    instanceSince: step ? step.instanceSince : row.instance_since,
    conflict: step ? step.conflict : !!row.instance_conflict_at,
    status,
    checkedAt: probe ? probe.checked_at : row.agent_checked_at,
    error: probe ? probe.error : row.agent_error,
    spell,
  };
}

/**
 * The pool's rules at a claim that has nothing waiting (orders.ts
 * decideAuto): at most one order, delivered in this same answer. Only
 * when it proposes a restart-type order does the claim read more — the
 * provider's breaker in the worker's scope, then the site's workers and
 * its pacing — and a hold issues and counts nothing. The site may turn a
 * restart of the shared agent service into a restart of this worker's own
 * process (the service answers for another of its workers), or end the
 * spell's restarts for this worker too (the elected one gave up). The
 * rules' state is written with the order, by compare-and-set: a claim that
 * lost the race issues nothing, and the next one decides again.
 */
async function autoOrder(env: Env, x: AfterClaim & { error: string | null; spell: string | null }, o: { agent: string | null; needsAgent: boolean; at: string; host?: boolean }): Promise<OrderOut | null> {
  const now = Date.parse(o.at);
  const { scale } = rulesScale(env);
  const input = { row: x.row, claim: x.claim, status: x.status, error: x.error, spell: x.spell, instanceSince: x.instanceSince, conflict: x.conflict, needsAgent: o.needsAgent };
  let d: Decision = decideAuto(input, now, scale);
  if (d.kind === null) return null;
  const w = x.row;
  if (d.kind === "give-up") {
    await giveUp(env, w, x.spell, d.next, d.summary);
    return null;
  }
  let reason = d.reason;
  if (d.kind !== "recheck-agent") {
    if (await breakerHolds(env, { id: w.id, site: w.site, agent: o.agent, cls: d.cls, trust: w.trust }, now)) return null;
    if (w.site) {
      const site = await readSite(env, w.site, now);
      // The agent service this worker shares answers for another of its workers: this worker's own process is what fails.
      if (d.kind === "restart-agent" && siblingsAnswering(w, site.live).length) {
        d = decideAuto({ ...input, siblingAnswers: true }, now, scale);
        if (d.kind !== "restart") return null;
        reason = d.reason;
      }
      const v = siteVerdict(w, d.kind, site, now, scale);
      if (!v.ok) {
        if (v.giveUp) {
          const auto: AutoState = autoOf(w.auto_orders, x.spell, now);
          await giveUp(env, w, x.spell, { ...auto, gave_up: new Date(now).toISOString() }, `${w.id}: the pool stops restarting it — ${v.why}; a person looks: /worker/${w.id}`);
        }
        return null;
      }
      if (d.kind === "restart-agent" && v.others.length) reason += ` — shared by ${v.others.length + 1} workers (with ${v.others.join(", ")}), restarted once, through this one`;
    }
  }
  const by = poolFor(w.trust);
  const issued = await issueOrder(env, {
    worker: w.id, owner: w.owner, kind: d.kind, reason: reason.slice(0, 300), by, via: null, rule: d.rule, unless: d.unless, site: w.site, host: o.host,
    baselineAtIssue: x.checkedAt, auto: { old: w.auto_orders, next: JSON.stringify(d.next) },
    deliverTo: { instance: x.instance!, baseline: d.kind === "restart" ? x.instance : x.checkedAt }, now,
    line: { status: d.kind === "recheck-agent" ? "ok" : "warn", summary: `${w.id}: ${d.kind} ordered by the pool — ${reason.slice(0, 300)}` },
  });
  if (!issued.ok) {
    if (issued.why === "cap") await capRefusal(env, { worker: w.id, kind: d.kind, by, now, host: o.host });
    return null;
  }
  return outOf({ id: issued.id, kind: d.kind, reason: reason.slice(0, 300), issued_by: by, issued_at: issued.issued_at, expires_at: issued.expires_at, unless_agent_ok: d.unless });
}

/** The rules stop restarting a worker in this spell: its state says so (compare-and-set), and the journal once, by the write that said it. */
async function giveUp(env: Env, w: OrdersRow, spell: string | null, next: AutoState, summary: string): Promise<void> {
  const value = JSON.stringify(next);
  await env.DB.batch([
    env.DB.prepare("UPDATE build_workers SET auto_orders = ? WHERE id = ? AND auto_orders IS ?").bind(value, w.id, w.auto_orders),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'order', NULL, 'factory', 'warn', ?, ? WHERE (SELECT auto_orders FROM build_workers WHERE id = ?) IS ?")
      .bind(summary, JSON.stringify({ worker: w.id, owner: w.owner, gave_up: next.gave_up, spell_since: spell }), w.id, value),
  ]);
}

// ---------- host registrations (#334) ----------

/** The kinds a host registration takes (design v2 §8.2, §22): builds of every trust, trials and audits; pool jobs join with #340. */
export const HOST_KINDS = ["build", "trial", "audit"];
/** An unfenced lease that two consecutive claims of its host do not list goes back to the queue once it is this old (§8.1). */
export const HOST_LEASE_GRACE_MIN = 2;
/** `lost` gives the attempt back at most this many times per task (D54). */
export const HOST_LOSSES_MAX = 2;
const CLAIM_ID = /^c_[A-Za-z0-9_-]{8,64}$/;
export const LEASE_GEN = /^g_[0-9a-f]{16}$/;
const MAX_LEASES = 64;

/** A new lease generation: random, never `attempts` (needs_native and lost give an attempt back, so its value repeats — D46). */
export function leaseGen(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `g_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** What a host registration's claim adds (design v2 §8.1), read whole: nothing of it is guessed. */
export interface HostClaim {
  claimId: string;
  want: 0 | 1;
  leases: { task: number; gen: string }[];
  capacity: Capacity | null;
  /**
   * The units this claim offers (#337, design v2 §7.6): its free units, or fewer when MemAvailable holds fewer — the pool hands nothing
   * above it this round, and counts the host by its capacity still. Null from a dispatcher that does not say it.
   */
  offer: number | null;
}

export function hostClaim(b: { claim_id?: unknown; want?: unknown; leases?: unknown; capacity?: unknown; offer?: unknown }): HostClaim | string {
  if (typeof b.claim_id !== "string" || !CLAIM_ID.test(b.claim_id)) return "claim_id: c_ and 8 to 64 letters, digits, '_' or '-', new per attempt (a retry after a lost answer sends the same one)";
  if (b.want !== 0 && b.want !== 1) return "want: 1 to take a task, 0 to reconcile and take orders only";
  if (!Array.isArray(b.leases) || b.leases.length > MAX_LEASES) return `leases: every lease the dispatcher holds, [{task, gen}], at most ${MAX_LEASES}`;
  const leases: { task: number; gen: string }[] = [];
  for (const l of b.leases as unknown[]) {
    const x = l as { task?: unknown; gen?: unknown } | null;
    if (!x || typeof x !== "object" || !Number.isSafeInteger(x.task) || (x.task as number) <= 0 || typeof x.gen !== "string" || !LEASE_GEN.test(x.gen)) return "a lease is {task: its id, gen: g_ and 16 hex}";
    leases.push({ task: x.task as number, gen: x.gen });
  }
  let capacity: Capacity | null = null;
  if (b.capacity !== undefined || b.want === 1) {
    const c = parseCapacity(b.capacity);
    if (typeof c === "string") return c;
    capacity = c;
  }
  if (b.offer !== undefined && !(Number.isInteger(b.offer) && (b.offer as number) >= 0 && (b.offer as number) <= 4096)) return "offer: the units this claim offers, a whole number";
  return { claimId: b.claim_id, want: b.want, leases, capacity, offer: b.offer === undefined ? null : (b.offer as number) };
}

/** The probe sidecar's word as a host claims it, `agent: {provider, model, probe, error?, checked_at?}`, in the fields every claim reads. */
function hostAgent(b: Record<string, unknown>): void {
  const a = b.agent;
  if (!a || typeof a !== "object" || Array.isArray(a)) return;
  const o = a as Record<string, unknown>;
  b.agent = typeof o.provider === "string" && typeof o.model === "string" ? `${o.provider}/${o.model}` : null;
  if (b.agent_status === undefined) {
    b.agent_status = o.probe === "ok" || o.probe === "error" ? o.probe : null;
    b.agent_error = typeof o.error === "string" ? o.error : "";
    b.agent_checked_at = typeof o.checked_at === "string" ? o.checked_at : null;
  }
}

/** The leases a host registration holds, by the pool's own rows (the lease index, status = 'leased'). */
export const HOST_LEASES_SQL = "SELECT id, name, arch, kind, trust, lease_owner, attempts, max_attempts, lease_gen, stop_order, started_at, lease_missed FROM build_tasks WHERE status = 'leased' AND lease_owner = ?";
/**
 * An unfenced lease its host lost, only while it is still that lease: back
 * in the queue with its attempt, counted in host_losses as a `lost` report
 * is (D54), so a host that keeps losing its leases cannot hand a task back
 * for ever. Past HOST_LOSSES_MAX the attempt is spent, as an expired lease's
 * is: behind its peers, failed when it was the last.
 */
const SPENT = `host_losses >= ${HOST_LOSSES_MAX}`;
const LAST = `${SPENT} AND attempts >= max_attempts`;
export const LOST_LEASE_SQL = `UPDATE build_tasks SET
    status = CASE WHEN ${LAST} THEN 'failed' ELSE 'queued' END,
    finished_at = CASE WHEN ${LAST} THEN ?5 ELSE NULL END,
    lease_owner = CASE WHEN ${LAST} THEN lease_owner ELSE NULL END,
    attempts = CASE WHEN ${SPENT} THEN attempts ELSE MAX(attempts - 1, 0) END,
    priority = CASE WHEN ${SPENT} THEN priority + 10 ELSE priority END,
    error = CASE WHEN ${SPENT} THEN ?1 || ' — lost too often on its host: the attempt is spent' ELSE ?1 || '; the attempt is given back' END,
    host_losses = host_losses + 1, lease_expires_at = NULL, lease_missed = 0
  WHERE id = ?2 AND status = 'leased' AND lease_owner = ?3 AND lease_gen = ?4 AND stop_order IS NULL RETURNING id, status, attempts, error`;

/**
 * Reconciliation (design v2 §8.1): the claim lists every lease the
 * dispatcher holds, and the pool compares it with its own. An unfenced lease
 * the claim lists is counted as seen; one it does not list is counted as
 * missed, and once two consecutive claims missed it and it is older than
 * HOST_LEASE_GRACE_MIN it goes back to the queue at once, its attempt given
 * back — the dispatcher never saw it, or lost it and killed its container.
 * A fenced lease (a Stop) is the orders path's (orders.ts takeOrders): it
 * ends when a claim no longer lists it, the dispatcher's proof its
 * container is gone, or at the lease's end.
 */
export async function reconcileHost(env: Env, worker: string, leases: HostClaim["leases"], at: string): Promise<number> {
  type Held = { id: number; name: string; arch: string; kind: string; trust: string; lease_owner: string; attempts: number; max_attempts: number; lease_gen: string | null; stop_order: string | null; started_at: string | null; lease_missed: number };
  const held = (await env.DB.prepare(HOST_LEASES_SQL).bind(worker).all<Held>()).results;
  if (!held.length) return 0;
  const listed = new Set(leases.map((l) => `${l.task}:${l.gen}`));
  const old = Date.parse(at) - HOST_LEASE_GRACE_MIN * 60000;
  const counts: D1PreparedStatement[] = [];
  let requeued = 0;
  for (const t of held) {
    if (t.stop_order || !t.lease_gen) continue;
    const seen = listed.has(`${t.id}:${t.lease_gen}`);
    const missed = seen ? 0 : t.lease_missed + 1;
    if (!seen && missed >= 2 && Date.parse(t.started_at ?? at) <= old) {
      const error = `lease by ${worker} lost: two claims of its host did not list it`;
      const back = await env.DB.prepare(LOST_LEASE_SQL).bind(error, t.id, worker, t.lease_gen, at).first<{ id: number; status: string; attempts: number; error: string }>();
      if (back) {
        requeued++;
        await afterRequeue(env, { ...t, attempts: back.attempts }, back.status === "failed", back.error, false);
      }
      continue;
    }
    if (missed !== t.lease_missed) counts.push(env.DB.prepare("UPDATE build_tasks SET lease_missed = ? WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_gen = ?").bind(missed, t.id, worker, t.lease_gen));
  }
  if (counts.length) await env.DB.batch(counts);
  return requeued;
}

/** The claim's answer for a task leased to this worker: the task, its job token for this lease, and where its results go. */
async function taskAnswer(env: Env, task: TaskRow, workerId: string): Promise<Response> {
  // The job's own credential: exactly the routes this task needs, until the lease ends — and, for a host's lease, of this lease only (`g`).
  const params = task.params ? (JSON.parse(task.params) as Record<string, unknown>) : {};
  const expires = Math.floor(Date.now() / 1000) + LEASE_MINUTES * 60;
  // A dry run's (publish 0, #284) writes nothing to the pool nor a ring: scopesFor reads the row's publish.
  const token = await issueJobToken(env, { t: task.id, k: task.kind, s: scopesFor(task.kind, task.id, task.trust, params, task.publish), e: expires, w: workerId, ...(task.lease_gen ? { g: task.lease_gen } : {}) });
  // A contributor's build lands in their workspace: how full it is travels
  // with the claim, so a worker whose owner is at the quota fails the task
  // at once instead of building for an hour into a 413.
  const staging = task.trust === "community" && task.kind === "build" && task.owner
    ? { bytes: (await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM staging_objects WHERE owner = ?").bind(task.owner).first<{ bytes: number }>())?.bytes ?? 0, quota_bytes: STAGING_QUOTA_BYTES }
    : null;
  return json({
    task: { ...task, params },
    token,
    token_expires_at: new Date(expires * 1000).toISOString(),
    lease_minutes: LEASE_MINUTES,
    repo: "https://github.com/firemanxbr/omarchy-pool",
    pkgbuild_path: task.kind === "build" && !(task.pkgbuild_ref.includes(":") || task.pkgbuild_ref.startsWith("draft")) ? `${recipesDir(task.created_at)}/${task.name}` : null,
    // Where a staged result goes — a contributor's build, or the project's review build: PUT these back with the job token.
    upload: task.trust === "community" || params.review !== undefined ? `/api/v1/factory/tasks/${task.id}/artifacts/<filename>` : null,
    staging,
  });
}

/**
 * A claim retried after its answer was lost (§8.1): the lease that claim
 * took, renewed, with a fresh job token of the same lease — never a second
 * lease. A fenced one is not handed back.
 */
export const REPLAY_SQL = `UPDATE build_tasks SET lease_expires_at = ? WHERE status = 'leased' AND lease_owner = ? AND claim_id = ? AND stop_order IS NULL RETURNING *`;

// ---------- selection (#337, design v2 §8.3) ----------

/** The head of each lane a claim reads, and the contributors whose first build it reads beside it: bounded, whatever the backlog. */
export const HEAD_LIMIT = 50;
export const OWNERS_LIMIT = 50;
/** The oldest builds a host's claim weighs for the reservation: the window of the queue it reads them from, and how many it weighs. */
export const RESERVE_WINDOW = 200;
export const RESERVE_CANDIDATES = 10;
/** A lease that another claim took first (its UPDATE changed nothing) gives way to the next choice, this many times. */
const LEASE_TRIES = 3;

/** One job at a time on a ring (`t` the candidate's alias): a promotion into it, a rollback, a render or the fast-track (any ring) is not handed out while another of them holds a lease on the same ring. */
const ringLock = (t: string) => ` AND NOT (${t}.kind IN (${RING_MOVERS}) AND EXISTS (
      SELECT 1 FROM build_tasks l WHERE l.status = 'leased' AND l.trust = 'project' AND l.kind IN (${RING_MOVERS}) AND l.id != ${t}.id
        AND (l.kind = 'security' OR ${t}.kind = 'security'
          OR COALESCE(json_extract(l.params, '$.to'), json_extract(l.params, '$.ring')) = COALESCE(json_extract(${t}.params, '$.to'), json_extract(${t}.params, '$.ring')))))`;

/** A task's own size (a Retry at size, `params.size`) when it is a number (`t` the alias): candidateOf keeps it when it is whole and from 1. */
const ownSize = (t: string) => `CASE WHEN json_type(${t}.params, '$.size') IN ('integer', 'real') THEN json_extract(${t}.params, '$.size') END`;
/** A candidate as selection reads it (`t` the alias). */
const candidateCols = (t: string) => `${t}.id, ${t}.name, ${t}.arch, ${t}.kind, ${t}.trust, ${t}.owner, ${t}.priority, ${t}.created_at, ${t}.pinned_to, ${t}.reserved_at, json_extract(${t}.params, '$.needs_native') AS needs_native, ${ownSize(t)} AS asked, ${agentScope(`${t}.`)} AS model, CASE WHEN ${t}.kind IN (${RING_JOB_KINDS}) THEN json_extract(${t}.params, '$.arch') END AS job_arch`;
interface CandidateRow { id: number; name: string; arch: string; kind: string; trust: string; owner: string | null; priority: number; created_at: string; pinned_to: string | null; reserved_at: string | null; needs_native: number | null; asked: number | null; model: number; job_arch: string | null }

/**
 * A build's size before any clamp, in SQL (`t` the alias; one binding: factory/sizing's sizes, `{name: [size, disk_gb]}`), as
 * candidateOf reads it: its own when whole and from 1, else its package page's, else factory/sizing's, else 1.
 */
const askedSql = (t: string) => `COALESCE(CASE WHEN ${ownSize(t)} >= 1 AND ${ownSize(t)} = CAST(${ownSize(t)} AS INTEGER) THEN CAST(${ownSize(t)} AS INTEGER) END,
    (SELECT p.size FROM factory_packages p WHERE p.name = ${t}.name), (SELECT json_extract(f.value, '$[0]') FROM json_each(?) f WHERE f.key = ${t}.name), 1)`;
/** factory/sizing's sizes and budgets, as the statements bind them. */
const fileSizes = (): string => JSON.stringify(Object.fromEntries([...shippedSizing()].map(([name, z]) => [name, [z.size, z.disk_gb]])));
/** A number written into a statement: one computed here, never a caller's text. */
const lit = (n: number): string => (Number.isFinite(n) ? String(n) : "1e18");

/**
 * Each contributor's first community build of one arch, by the owners of the queue's community builds walked one index entry at a time
 * (a loose index scan: as many reads as owners, not as builds) — so round-robin by owner (D51) sees the contributor whose one package
 * waits behind another's hundred and fifty. A contributor at their cap is skipped before their builds are read. `scope` is the claim's
 * filters on alias c2, with its bindings after the owners' limit, the capped owners and the arch.
 */
export const OWNER_HEADS_SQL = (scope: string) => `WITH RECURSIVE o(owner) AS (
    SELECT (SELECT MIN(owner) FROM build_tasks WHERE status = 'queued' AND trust = 'community')
    UNION ALL
    SELECT (SELECT MIN(t.owner) FROM build_tasks t WHERE t.status = 'queued' AND t.trust = 'community' AND t.owner > o.owner) FROM o WHERE o.owner IS NOT NULL
    LIMIT ?
  )
  SELECT ${candidateCols("c")} FROM o CROSS JOIN build_tasks c ON c.id = (
    SELECT c2.id FROM build_tasks c2 WHERE c2.status = 'queued' AND c2.trust = 'community' AND c2.owner = o.owner AND c2.arch = ? AND c2.kind = 'build' AND ${scope} ORDER BY c2.priority, c2.id LIMIT 1)
  WHERE o.owner NOT IN (SELECT value FROM json_each(?))`;

/** The head of one lane's arch for a host (`filters` on alias c; the arch binds first): a build, a trial or a job with helpers of that arch, by the queue index. */
export const LANE_HEAD_SQL = (filters: string) => `SELECT ${candidateCols("c")} FROM build_tasks c WHERE c.status = 'queued' AND c.arch = ? AND c.kind NOT IN (${HOST_ANY_ARCH_KINDS}) AND ${filters} ORDER BY c.priority, c.id LIMIT ${HEAD_LIMIT}`;
/** The head of the arch-neutral kinds for a host (`filters` on alias c), whatever their arch. */
export const NEUTRAL_HEAD_SQL = (filters: string) => `SELECT ${candidateCols("c")} FROM build_tasks c WHERE c.status = 'queued' AND c.kind IN (${HOST_ANY_ARCH_KINDS}) AND ${filters} ORDER BY c.priority, c.id LIMIT ${HEAD_LIMIT}`;

/** The registrations alive (§8.3: claimed in the last 2 minutes; a legacy one, LEGACY_ALIVE_MS) with their host's capacity, as the fleet. */
export const FLEET_SQL = `SELECT w.id, w.kind, w.arch, w.labels, w.kinds, w.agent_status, w.drained_at, w.trust, w.owner, w.mode, w.version, w.last_seen, w.current_task,
    h.id AS host_id, h.status AS host_status, h.owner_removed_at, h.units, h.lanes, h.agent_slots, h.disk_free, h.capacity, h.pool_cap_units, h.reserving_task, h.reserving_since,
    h.asleep_at, h.reported_at
  FROM build_workers w LEFT JOIN hosts h ON h.id = w.host_id WHERE w.last_seen > ? AND w.revoked_at IS NULL`;
interface FleetRow {
  id: string; kind: string | null; arch: string; labels: string | null; kinds: string | null; agent_status: string | null; drained_at: string | null; trust: string; owner: string | null; mode: string | null; version: string | null; last_seen: string; current_task: number | null;
  host_id: string | null; host_status: string | null; owner_removed_at: string | null; units: number | null; lanes: string | null; agent_slots: number | null; disk_free: string | null; capacity: string | null; pool_cap_units: number | null; reserving_task: number | null; reserving_since: string | null;
  asleep_at: string | null; reported_at: string | null;
}
/** Every lease the pool holds, by the lease index: what each registration holds, each owner's builds, the units and slots in use. */
export const LEASES_HELD_SQL = `SELECT id, lease_owner, kind, arch, lane, units, size, disk_gb, trust, owner, ${AGENT_SCOPE} AS model FROM build_tasks WHERE status = 'leased'`;
interface LeaseRow { id: number; lease_owner: string; kind: string; arch: string; lane: string | null; units: number | null; size: number | null; disk_gb: number | null; trust: string; owner: string | null; model: number }
/**
 * The oldest queued builds a host may reserve for, by the kind index (`filters` on alias w): within the window of the oldest builds some
 * host alive could run — of an arch a host runs, a `needs_native` one only where a host runs its arch natively, not a contributor's at
 * their cap, not pinned to a registration that is not alive, not within 30 minutes of its two hours of reservation spent (selection.ts
 * `cooling`) — those that waited 30 minutes and ask a size above 1. Bindings: the filters', then the time 30 minutes ago, then
 * factory/sizing's sizes.
 */
export const OLDEST_BUILDS_SQL = (filters: string) => `SELECT ${candidateCols("c")} FROM (
    SELECT * FROM build_tasks w WHERE w.kind = 'build' AND w.status = 'queued'${filters} ORDER BY w.id LIMIT ${RESERVE_WINDOW}) c
  WHERE c.created_at <= ? AND ${askedSql("c")} >= 2 ORDER BY c.id LIMIT ${RESERVE_CANDIDATES}`;
/** Whether anything of the claimer's kinds is queued at all, by the kind index: one probe per kind. */
export const ANY_QUEUED_SQL = "SELECT id FROM build_tasks WHERE kind IN (SELECT value FROM json_each(?)) AND status = 'queued' LIMIT 1";
/** The tasks hosts reserve for that still wait, by their primary keys. */
export const MARKED_WAITING_SQL = "SELECT id FROM build_tasks WHERE id IN (SELECT value FROM json_each(?)) AND +status = 'queued'";
/** The sizes and budgets set on the candidates' packages' pages. */
export const PACKAGE_SIZES_SQL = "SELECT name, size, disk_gb FROM factory_packages WHERE name IN (SELECT value FROM json_each(?)) AND (size IS NOT NULL OR disk_gb IS NOT NULL)";
/** The last native build of each (package, arch), by the name index: T for an emulated candidate (D50). */
export const NATIVE_MS_SQL = `SELECT j.value AS k, (SELECT d.duration_ms FROM build_tasks d WHERE d.name = json_extract(j.value, '$[0]') AND d.arch = json_extract(j.value, '$[1]')
    AND d.kind = 'build' AND d.lane = 'native' AND d.status IN ('done', 'staged') AND d.duration_ms IS NOT NULL ORDER BY d.id DESC LIMIT 1) AS ms FROM json_each(?) j`;
/** The setting that divides the fleet's builds into a contributor's cap (D51): 4 when absent, 0 lifts the cap. */
export const OWNER_CAP_KEY = "owner-cap-divisor";

/** A JSON column as what it should hold, or `or` when empty or not JSON. */
const jsonOr = <T>(v: string | null, or: T): T => {
  try {
    return v ? (JSON.parse(v) as T) : or;
  } catch {
    return or;
  }
};

/** A legacy registration's one lane, from its labels: its arch, emulated when they say so. */
function legacyLanes(arch: string, labels: string | null): Lane[] {
  return [{ arch, mode: jsonOr<{ emulated?: unknown }>(labels, {}).emulated ? "emulated" : "native" }];
}

/** Below the signed minimum, as the agent's last capacity report left it on the host's row (routes/hosts.ts; D44). */
const reportedBelow = (capacity: string | null): boolean => !!jsonOr<{ below_minimum?: unknown } | null>(capacity, null)?.below_minimum;

/** A registration of the fleet, from its row (another than the claimer: what it last said). */
function memberOf(r: FleetRow, pool: RunningVersion, nowMs = Date.now()): Member {
  const host = r.kind === "host" && r.host_id !== null;
  const kinds = jsonOr<string[] | null>(r.kinds, null) ?? (host ? HOST_KINDS : r.trust === "project" ? ALL_KINDS : ["build"]);
  const lanes = host ? jsonOr<Lane[] | null>(r.lanes, null) ?? [{ arch: r.arch, mode: "native" }] : legacyLanes(r.arch, r.labels);
  return {
    id: r.id, legacy: !host, lanes, units: Math.min(r.units ?? 0, r.pool_cap_units ?? Number.MAX_SAFE_INTEGER), agent_slots: r.agent_slots ?? 0,
    disk: jsonOr<{ work: number; engine: number } | null>(r.disk_free, null), kinds, probe_ok: r.agent_status === "ok", drained: r.drained_at !== null,
    below_minimum: reportedBelow(r.capacity), may_claim: !host || (r.host_status === "active" && r.owner_removed_at === null), behind: updateState(r.version ?? undefined, pool).required,
    seen_at: Date.parse(r.last_seen), alive_ms: host ? undefined : LEGACY_ALIVE_MS, reserving: r.reserving_task !== null && r.reserving_since ? { task: r.reserving_task, since: Date.parse(r.reserving_since) } : null,
    scope: host ? { trust: "host", owner: null, shared: false } : r.trust === "project" ? { trust: "project", owner: null, shared: false } : { trust: "community", owner: r.owner, shared: r.mode === "shared" },
    busy: !host && r.current_task !== null,
    // A host whose agent says it sleeps has zero free units (#329).
    asleep: host && asleepNow(r, nowMs),
  };
}

/** A candidate for selection: a build's size is its own (a Retry at size), else its package page's, else factory/sizing's; its budget the page's, else the file's. */
function candidateOf(r: CandidateRow, sizes: Map<string, Sizing>, nativeMs: Map<string, number>): Candidate {
  const page = sizes.get(r.name), file = shippedSizing().get(r.name), build = r.kind === "build";
  return {
    id: r.id, name: r.name, kind: r.kind, arch: r.arch, trust: r.trust, owner: r.owner, priority: r.priority, queued_at: Date.parse(r.created_at), pinned_to: r.pinned_to,
    needs_native: r.needs_native === 1, model: r.model === 1,
    size: build ? (Number.isInteger(r.asked) && (r.asked as number) >= 1 ? (r.asked as number) : page?.size ?? file?.size ?? null) : null,
    disk_gb: build ? page?.disk_gb ?? file?.disk_gb ?? null : null, native_ms: nativeMs.get(`${r.name}\0${r.arch}`) ?? null,
    reserved_at: r.reserved_at ? Date.parse(r.reserved_at) : null, job_arch: r.job_arch,
  };
}

/** What the claim knows of the claimer for selection: a host's capacity and lanes, or a legacy registration's one lane and scope. */
interface Claimer {
  workerId: string;
  arch: string;
  version: string | null;
  kinds: string[];
  probeOk: boolean;
  hostId: string | null;
  hc: HostClaim | null;
  legacy: { emulated: boolean; trust: "project" | "community"; owner: string | null; shared: boolean; firstPick: boolean } | null;
}

/**
 * The claim's selection and lease (#337, design v2 §8.3). First what the
 * pool knows — the fleet alive, every lease it holds, the owner-cap setting,
 * the claimer's host row — so the claimer's room is known: its free units
 * (and the units its dispatcher's memory offers), a free agent slot, its
 * disk, the largest size alive, the contributors at their cap. Then the
 * candidates by bounded reads, each filtered in SQL by what is the claim's
 * own (kinds, pin, probe, the ring lock, a legacy registration's scope
 * until #343) and by that room, so a head of tasks the claimer cannot take
 * never hides one it can: the head of each lane's arch — a long backlog of
 * one arch never hides another's, so the guaranteed emulated share and
 * native work arriving are always seen — the head of the arch-neutral
 * kinds, each contributor's first community build of each arch, the first
 * native task whatever its size (which holds the emulated lanes to their
 * share), and the task a host reserves for; for a host's claim also the
 * oldest builds the reservation weighs. Then the sizes set for their
 * packages and their native history; selection (selection.ts) orders them,
 * and the first choice is leased with the single conditional UPDATE — the
 * next when another claim took it first. A build whose size the fleet
 * alive clamped says so in the journal (a Status line).
 */
async function selectAndLease(env: Env, k: Claimer): Promise<TaskRow | null> {
  const host = k.legacy === null;
  const lanes: Lane[] = host ? k.hc!.capacity!.lanes : [{ arch: k.arch, mode: k.legacy!.emulated ? "emulated" : "native" }];
  const at = now();
  const nowMs = Date.parse(at);
  // Nothing queued of the kinds it takes: nothing more is read — an idle fleet's claims, every 30 s from every host, cost one probe of
  // the kind index, never the fleet, the leases or the setting.
  if (!(await env.DB.prepare(ANY_QUEUED_SQL).bind(JSON.stringify(k.kinds)).first())) return null;
  // The fleet, every lease, the setting and the claimer's host row.
  const [fleetRows, leaseRows, setting, self] = await env.DB.batch<unknown>([
    env.DB.prepare(FLEET_SQL).bind(new Date(nowMs - Math.max(ALIVE_MS, LEGACY_ALIVE_MS)).toISOString()),
    env.DB.prepare(LEASES_HELD_SQL),
    env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(OWNER_CAP_KEY),
    env.DB.prepare("SELECT name, capacity, pool_cap_units, reserving_task, reserving_since, asleep_at, reported_at FROM hosts WHERE id = ?").bind(k.hostId ?? ""),
  ]);
  const divisor = Number((setting.results[0] as { value?: string } | undefined)?.value);
  const rules = selectionRules(Number.isInteger(divisor) && divisor >= 0 ? divisor : OWNER_DIVISOR);
  const pool = running(env);
  const members = (fleetRows.results as FleetRow[]).filter((r) => r.id !== k.workerId).map((r) => memberOf(r, pool, nowMs));
  const hostRow = self.results[0] as { name: string; capacity: string | null; pool_cap_units: number | null; reserving_task: number | null; reserving_since: string | null; asleep_at: string | null; reported_at: string | null } | undefined;
  const cap = host ? k.hc!.capacity! : null;
  // The claimer as it claims now: a host's capacity is this claim's — units within min(declared, recomputed, the pool's cap), and what its
  // memory offers this round beside them — but below the minimum as its agent last reported it (D44), as every other host is judged:
  // the claim's own work-root value is the one measured now, and its builds may fill it while they run.
  const me: Member = {
    id: k.workerId, legacy: !host, lanes, units: cap ? Math.min(unitsOf(cap), hostRow?.pool_cap_units ?? Number.MAX_SAFE_INTEGER) : 0, agent_slots: cap?.agent_slots ?? 0,
    disk: cap?.disk_free_gb ?? null, kinds: k.kinds, probe_ok: k.probeOk, drained: false, below_minimum: host ? reportedBelow(hostRow?.capacity ?? null) : false, may_claim: true, behind: false, seen_at: nowMs,
    reserving: hostRow?.reserving_task != null && hostRow.reserving_since ? { task: hostRow.reserving_task, since: Date.parse(hostRow.reserving_since) } : null,
    scope: host ? { trust: "host", owner: null, shared: false } : k.legacy!.trust === "project" ? { trust: "project", owner: null, shared: false } : { trust: "community", owner: k.legacy!.owner, shared: k.legacy!.shared },
    offer: host && k.hc!.offer !== null ? k.hc!.offer : undefined,
    asleep: host && !!hostRow && asleepNow(hostRow, nowMs),
  };
  // A host below the signed minimum keeps its bundle running and claims nothing (D44); one whose agent says it sleeps has zero free
  // units (#329) — a Mac about to sleep, whose dispatcher claims once more before the VM stops — until its agent says it woke.
  if (me.below_minimum || me.asleep) return null;
  members.push(me);
  const leases: Held[] = (leaseRows.results as LeaseRow[]).map((l) => ({
    task: l.id, by: l.lease_owner, kind: l.kind, arch: l.arch, lane: l.lane === "native" || l.lane === "emulated" ? l.lane : null,
    units: l.units ?? unitsOfKind(l.kind, l.size, rules), model: l.model === 1, trust: l.trust, owner: l.owner, disk_gb: l.disk_gb ?? 0,
  }));
  const fleet: Fleet = { members, leases };

  // The claimer's room now, as selection.ts counts it (noRoom), for the statements: a legacy registration is one build.
  const held = host ? leases.filter((l) => l.by === me.id) : [];
  const used = held.reduce((n, l) => n + l.units, 0);
  const offer = me.offer ?? Number.POSITIVE_INFINITY;
  const roomTask = host ? Math.min(me.units - rules.job_reserved - used, offer) : rules.build_per_size;
  const roomJob = host ? Math.min(me.units - used, offer) : rules.build_per_size;
  const slotFree = !host || held.filter((l) => l.model).length < me.agent_slots;
  const diskFree = host && me.disk ? Math.min(me.disk.work, me.disk.engine) - held.reduce((n, l) => n + (l.kind === "build" ? l.disk_gb : 0), 0) - rules.floor_gb : null;
  const largest = largestSize(fleet, nowMs, rules);
  const ownerMax = ownerCap(fleet, nowMs, rules);
  const capped = JSON.stringify([...ownersLeased(fleet)].filter(([, n]) => n >= ownerMax).map(([o]) => o));
  const files = fileSizes();

  const scopeOf = (t: string): { sql: string; binds: unknown[] } => {
    // A build asked for one worker (pinned_to) is claimed by that worker only; the rest is anyone's that qualifies.
    let sql = `${t}.kind IN (SELECT value FROM json_each(?)) AND (${t}.pinned_to IS NULL OR ${t}.pinned_to = ?)`;
    const binds: unknown[] = [JSON.stringify(k.kinds), k.workerId];
    // Agent work goes only to a worker whose agent answered the probe: a draft or an audit on a worker with no agent, or a failing
    // one, is a failed task an hour later.
    if (!k.probeOk) sql += ` AND NOT ${agentScope(`${t}.`)}`;
    if (k.legacy?.emulated) {
      // A build a toolchain could not start emulated (the fail report's needs_native) waits for a native worker of its
      // architecture, whoever's and whatever the trust: handed to an emulated one again it fails the same way, and its attempt is
      // never spent (handleFail). Selection keeps it off every emulated lane; this keeps an emulated legacy registration's bounded
      // read free of them.
      sql += ` AND json_extract(${t}.params, '$.needs_native') IS NOT 1`;
    }
    sql += ringLock(t);
    const lg = k.legacy;
    if (lg?.trust === "project") {
      // Project trust takes any kind it declares, but never a contributor's build: project workers do the work a maintainer would
      // — pool jobs and the rebuild of an approved package — and nothing that has no evidence and no review yet.
      sql += ` AND (${t}.kind != 'build' OR ${t}.trust = 'project')`;
    } else if (lg) {
      // Community trust takes community builds only, and by default only its owner's: a worker started with --shared donates its
      // compute to anyone's once shared_after has passed (at once when it is unset). Community results never reach the pool.
      sql += ` AND ${t}.trust = 'community'`;
      if (lg.shared) {
        sql += ` AND (${t}.owner = ? OR ${t}.shared_after IS NULL OR ${t}.shared_after <= ?)`;
        binds.push(lg.owner ?? "-", at);
        if (lg.firstPick) {
          sql += lg.emulated ? ` AND (${t}.pinned_to = ? OR ${t}.created_at <= ?)` : ` AND (${t}.owner = ? OR ${t}.pinned_to = ? OR ${t}.created_at <= ?)`;
          if (!lg.emulated) binds.push(lg.owner ?? "-");
          binds.push(k.workerId, new Date(nowMs - FIRST_PICK_MINUTES * 60000).toISOString());
        }
      } else {
        // A dedicated worker takes its owner's builds — and one somebody asked for it by name while it was shared.
        sql += ` AND (${t}.owner = ? OR ${t}.pinned_to = ?)`;
        binds.push(lg.owner ?? "-", k.workerId);
      }
    }
    return { sql, binds };
  };
  // The claimer's room in the statements themselves: selection.ts's cheap filters again — units (a build's by its size, clamped as
  // sizeOf clamps it; the reserved job unit for pool jobs only; the memory's offer), a free agent slot, the disk budget, the per-owner
  // cap. selection.ts still decides; this only keeps a head the claimer cannot take — audits while its agent slots are full, size-4
  // builds on two free units, a capped contributor's flood — from filling the bound and hiding one it can.
  const fitsOf = (t: string): { sql: string; binds: unknown[] } => {
    const size = `MIN(${lit(largest)}, CASE WHEN ${t}.trust = 'community' THEN ${lit(rules.community_max_size)} ELSE ${lit(rules.max_size)} END, MAX(1, ${askedSql(t)}))`;
    const units = `CASE ${t}.kind WHEN 'build' THEN ${lit(rules.build_per_size)} * ${size} WHEN 'trial' THEN ${lit(rules.trial)} WHEN 'audit' THEN ${lit(rules.audit)} ELSE ${lit(rules.job)} END`;
    let sql = ` AND ${units} <= CASE WHEN ${t}.kind IN (${TASK_KINDS.map((x) => `'${x}'`).join(", ")}) THEN ${lit(roomTask)} ELSE ${lit(roomJob)} END`;
    const binds: unknown[] = [files];
    if (!slotFree) sql += ` AND NOT ${agentScope(`${t}.`)}`;
    if (host) {
      if (diskFree === null) sql += ` AND ${t}.kind != 'build'`;
      else {
        sql += ` AND (${t}.kind != 'build' OR COALESCE((SELECT p.disk_gb FROM factory_packages p WHERE p.name = ${t}.name), (SELECT json_extract(f.value, '$[1]') FROM json_each(?) f WHERE f.key = ${t}.name), ${lit(rules.gb_per_size)} * ${size}) <= ${lit(diskFree)})`;
        binds.push(files, files);
      }
    }
    sql += ` AND NOT (${t}.kind = 'build' AND ${t}.trust = 'community' AND ${t}.owner IN (SELECT value FROM json_each(?)))`;
    binds.push(capped);
    return { sql, binds };
  };
  const notNeedsNative = (t: string) => ` AND json_extract(${t}.params, '$.needs_native') IS NOT 1`;
  const cols = candidateCols("c");
  const scope = scopeOf("c"), fits = fitsOf("c");
  const scope2 = scopeOf("c2"), fits2 = fitsOf("c2");
  const archs = host ? [...new Set(lanes.map((l) => l.arch))] : [k.arch];
  const native = lanes.find((l) => l.mode === "native")?.arch ?? k.arch;
  const emulatedOnly = (a: string) => !lanes.some((l) => l.arch === a && l.mode === "native");
  const reads: D1PreparedStatement[] = [];
  for (const a of archs) {
    if (host) {
      // Each lane's own head (§7.4): a build or a trial of that arch (a job with helpers too); one an emulated lane could not start
      // (needs_native) waits for a native host and is no candidate here.
      reads.push(env.DB.prepare(LANE_HEAD_SQL(`${scope.sql}${fits.sql}${emulatedOnly(a) ? notNeedsNative("c") : ""}`)).bind(a, ...scope.binds, ...fits.binds));
    } else {
      // A legacy registration's one lane: its arch, or a kind any arch runs.
      reads.push(env.DB.prepare(`SELECT ${cols} FROM build_tasks c WHERE c.status = 'queued' AND (c.arch = ? OR c.kind IN (${ANY_ARCH_KINDS})) AND ${scope.sql}${fits.sql} ORDER BY c.priority, c.id LIMIT ${HEAD_LIMIT}`)
        .bind(a, ...scope.binds, ...fits.binds));
    }
    if (k.kinds.includes("build") && k.legacy?.trust !== "project") {
      reads.push(env.DB.prepare(OWNER_HEADS_SQL(`${scope2.sql}${fits2.sql}${host && emulatedOnly(a) ? notNeedsNative("c2") : ""}`)).bind(OWNERS_LIMIT, a, ...scope2.binds, ...fits2.binds, capped));
    }
  }
  if (host) {
    // The arch-neutral kinds (an audit; pool jobs from P2's dispatcher on), whatever their arch.
    reads.push(env.DB.prepare(NEUTRAL_HEAD_SQL(`${scope.sql}${fits.sql}`)).bind(...scope.binds, ...fits.binds));
    // The first native task for this host, whatever its size: while one waits, its emulated lanes keep to their share (the cap).
    if (lanes.some((l) => l.mode === "emulated")) {
      reads.push(env.DB.prepare(`SELECT ${cols} FROM build_tasks c WHERE c.status = 'queued' AND c.arch = ? AND c.kind IN (${LANE_KINDS.map((x) => `'${x}'`).join(", ")}) AND ${scope.sql}
          AND NOT (c.kind = 'build' AND c.trust = 'community' AND c.owner IN (SELECT value FROM json_each(?))) ORDER BY c.priority, c.id LIMIT 1`).bind(native, ...scope.binds, capped));
    }
    // The task this host reserves for, wherever it stands in the queue: the one it may take while it reserves.
    if (k.hostId) reads.push(env.DB.prepare(`SELECT ${cols} FROM build_tasks c WHERE c.id = (SELECT reserving_task FROM hosts WHERE id = ?) AND c.status = 'queued' AND ${scope.sql}`).bind(k.hostId, ...scope.binds));
  }
  // The oldest builds the reservation weighs (a host's claim decides it): those some host alive could run, larger than one build.
  const claimers = members.filter((m) => !m.legacy && m.seen_at > nowMs - ALIVE_MS && m.may_claim && !m.below_minimum && !m.drained && !m.behind);
  const weighs = host && largest >= 2 && claimers.length > 0;
  if (weighs) {
    const laneArchs = JSON.stringify([...new Set(claimers.flatMap((m) => m.lanes.map((l) => l.arch)))]);
    const nativeArchs = JSON.stringify([...new Set(claimers.flatMap((m) => m.lanes.filter((l) => l.mode === "native").map((l) => l.arch)))]);
    const filters = ` AND w.arch IN (SELECT value FROM json_each(?)) AND (json_extract(w.params, '$.needs_native') IS NOT 1 OR w.arch IN (SELECT value FROM json_each(?)))
        AND NOT (w.trust = 'community' AND w.owner IN (SELECT value FROM json_each(?))) AND (w.pinned_to IS NULL OR w.pinned_to IN (SELECT value FROM json_each(?)))
        AND (w.reserved_at IS NULL OR w.reserved_at > ? OR w.reserved_at <= ?)`;
    reads.push(env.DB.prepare(OLDEST_BUILDS_SQL(filters)).bind(
      laneArchs, nativeArchs, capped, JSON.stringify(claimers.map((m) => m.id)), new Date(nowMs - RESERVE_FOR_MS).toISOString(),
      new Date(nowMs - RESERVE_FOR_MS - RESERVE_AFTER_MS).toISOString(), new Date(nowMs - RESERVE_AFTER_MS).toISOString(), files,
    ));
  }
  const got = await env.DB.batch<CandidateRow>(reads);
  const oldestRows = weighs ? got.pop()!.results : [];
  const rows = new Map<number, CandidateRow>();
  for (const r of got.flatMap((g) => g.results)) if (r.id !== null) rows.set(r.id, r);
  if (!rows.size && !oldestRows.length) return null;
  // What the candidates' packages say of their size, and their native history.
  const cands = [...rows.values(), ...oldestRows.filter((r) => !rows.has(r.id))];
  const emulatedArches = new Set(lanes.filter((l) => l.mode === "emulated").map((l) => l.arch));
  const [sizeRows, msRows] = await env.DB.batch<unknown>([
    env.DB.prepare(PACKAGE_SIZES_SQL).bind(JSON.stringify([...new Set(cands.filter((c) => c.kind === "build").map((c) => c.name))])),
    env.DB.prepare(NATIVE_MS_SQL).bind(JSON.stringify(cands.filter((c) => LANE_KINDS.includes(c.kind) && emulatedArches.has(c.arch)).map((c) => [c.name, c.arch]))),
  ]);
  const sizes = new Map((sizeRows.results as { name: string; size: number | null; disk_gb: number | null }[]).map((r) => [r.name, { size: r.size, disk_gb: r.disk_gb }]));
  const nativeMs = new Map<string, number>();
  for (const r of msRows.results as { k: string; ms: number | null }[]) {
    const [name, arch] = jsonOr<[string, string]>(r.k, ["", ""]);
    if (r.ms !== null) nativeMs.set(`${name}\0${arch}`, r.ms);
  }
  const all = [...rows.values()].map((r) => candidateOf(r, sizes, nativeMs));
  const oldest = oldestRows.map((r) => candidateOf(r, sizes, nativeMs));
  // The reservation for large tasks, decided at a host's claim; the marks it moves are written compare-and-set.
  if (host) {
    // A mark holds while its task still waits in the queue: one cancelled or leased elsewhere frees its host at once.
    const marked = [...new Set(members.flatMap((m) => (m.reserving ? [m.reserving.task] : [])))];
    const waiting = new Set(marked.length ? (await env.DB.prepare(MARKED_WAITING_SQL).bind(JSON.stringify(marked)).all<{ id: number }>()).results.map((r) => r.id) : []);
    const marks = reserve(fleet, oldest, (t) => waiting.has(t), nowMs, rules);
    const hostOf = new Map((fleetRows.results as FleetRow[]).map((r) => [r.id, r.host_id]));
    hostOf.set(k.workerId, k.hostId);
    const writes: D1PreparedStatement[] = [];
    for (const id of marks.clear) {
      const m = members.find((x) => x.id === id)!;
      writes.push(env.DB.prepare("UPDATE hosts SET reserving_task = NULL, reserving_since = NULL WHERE id = ? AND reserving_task IS ?").bind(hostOf.get(id) ?? "", m.reserving?.task ?? null));
      m.reserving = null;
    }
    if (marks.set) {
      const m = members.find((x) => x.id === marks.set!.host)!;
      const t = oldest.find((c) => c.id === marks.set!.task) ?? null;
      const size = t ? sizeOfTask(t, fleet, nowMs, rules) : null;
      writes.push(
        env.DB.prepare("UPDATE hosts SET reserving_task = ?, reserving_since = ? WHERE id = ? AND reserving_task IS NULL").bind(marks.set.task, at, hostOf.get(m.id) ?? ""),
        env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) SELECT 'host', NULL, 'factory', 'ok', ?, ? WHERE changes() > 0")
          .bind(`${m.id} reserves for ${t?.name ?? "task"} (task ${marks.set.task}${size ? `, size ${size}` : ""}): it takes nothing else but pool jobs until its units fit it, two hours at most`, JSON.stringify({ worker: m.id, host: hostOf.get(m.id), task: marks.set.task, size })),
        // The task's window starts with the mark: once its two hours are spent it is not marked again for 30 minutes (selection.ts cooling).
        env.DB.prepare("UPDATE build_tasks SET reserved_at = ? WHERE id = ? AND status = 'queued' AND changes() > 0").bind(at, marks.set.task),
      );
      m.reserving = { task: marks.set.task, since: nowMs };
      // Marked at this very claim, after the reads: its task joins the candidates, so the mark holds while H's free units are below it
      // (selection.ts holds only for a task the claim read — one it can take). It fits no host now, so selection does not choose it.
      if (m === me && t && !all.some((c) => c.id === t.id)) all.push(t);
    }
    if (writes.length) await env.DB.batch(writes);
  }
  const choices = select(me, fleet, all, nowMs, rules);
  const hostOk = k.hostId ? ` AND ${HOST_MAY_LEASE_SQL} AND ${HOST_AWAKE_SQL}` : "";
  // A host's units, again in the statement itself: what it holds plus this task within its count (the reserved unit for pool jobs only).
  const guard = host ? " AND (SELECT COALESCE(SUM(l.units), 0) FROM build_tasks l WHERE l.status = 'leased' AND l.lease_owner = ?) + ? <= ?" : "";
  for (const c of choices.slice(0, LEASE_TRIES)) {
    const limit = TASK_KINDS.includes(all.find((x) => x.id === c.id)!.kind) ? me.units - rules.job_reserved : me.units;
    // One statement leases it: D1 serialises writes, so two claims never get the same task. A fence belongs to one lease (#277): a
    // queued task never carries one — the requeue clears it — but one a Worker from before the fence requeued would stop the new
    // lease on a worker nobody stopped, so the lease starts without it. A host's lease (#334) carries a new generation, its lane,
    // size, units and disk budget, the release it was claimed on and the claim that took it; a legacy one no generation — the
    // column is cleared, so a host's stale one never outlives its lease — and its one lane. A host's registration leases only
    // while its host may claim and does not sleep, checked by this very statement (#322, #329): a suspension, or an asleep report,
    // that commits meanwhile leaves it nothing. A reservation's window ends with the lease: queued again, the task may be reserved
    // for anew.
    const task = await env.DB.prepare(
      `UPDATE build_tasks SET status = 'leased', lease_owner = ?, lease_expires_at = ?, started_at = ?, attempts = attempts + 1, error = NULL, stop_order = NULL,
         lease_gen = ?, lane = ?, size = ?, units = ?, disk_gb = ?, release = ?, claim_id = ?, lease_missed = 0, reserved_at = NULL
       WHERE id = ? AND status = 'queued'${hostOk}${guard} RETURNING *`,
    )
      .bind(
        k.workerId, plusMinutes(LEASE_MINUTES), at, host ? leaseGen() : null, c.lane, c.size, c.units, c.disk_gb, host ? k.version : null, host ? k.hc!.claimId : null, c.id,
        ...(hostOk ? [k.hostId, k.hostId, freshSince(nowMs)] : []), ...(guard ? [k.workerId, c.units, limit] : []),
      )
      .first<TaskRow>();
    if (!task) continue;
    const writes: D1PreparedStatement[] = [];
    // A reservation ends with its task's lease.
    if (members.some((m) => m.reserving?.task === task.id)) writes.push(env.DB.prepare("UPDATE hosts SET reserving_task = NULL, reserving_since = NULL WHERE reserving_task = ?").bind(task.id));
    // Clamped to the largest host alive (D31): a Status line, so a task never waits for a host that left and a maintainer knows why it runs smaller.
    if (c.asked !== null) {
      writes.push(env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('build', NULL, 'factory', 'warn', ?, ?)")
        .bind(`${task.name} for ${task.arch} (task ${task.id}) asked size ${c.asked}; the largest host alive runs size ${c.size}: it runs clamped on ${k.workerId}`, JSON.stringify({ task: task.id, name: task.name, arch: task.arch, asked: c.asked, size: c.size, worker: k.workerId, clamped: true })));
    }
    if (writes.length) await env.DB.batch(writes);
    return task;
  }
  return null;
}

/** A lease's units when its row has none (a legacy one from before #337): by the signed constants. */
const unitsOfKind = (kind: string, size: number | null, r: Rules) => (kind === "build" ? r.build_per_size * (size ?? 1) : kind === "trial" ? r.trial : kind === "audit" ? r.audit : r.job);
/** The size a build runs at in this fleet. */
const sizeOfTask = (t: Candidate, fleet: Fleet, now: number, r: Rules) => sizeOf(t, largestSize(fleet, now, r), r)?.size ?? null;

export async function handleClaim(request: Request, env: Env, actor: Actor): Promise<Response> {
  const b = await readJson<{ arch?: string; hostname?: string; labels?: unknown; version?: string; kinds?: unknown; shared?: unknown; agent?: unknown; agent_status?: unknown; agent_error?: unknown; agent_checked_at?: unknown; usage?: unknown; log?: unknown; orders?: unknown; instance?: unknown; started_at?: unknown; agent_via?: unknown; site?: unknown; restarts_left?: unknown; previous_exit?: unknown; rollout?: unknown }>(request);
  if (b instanceof Response) return b;
  if (!b.arch || !isRepoArch(b.arch)) return json({ error: "arch (x86_64|aarch64) is required" }, 400);
  if (actor.kind === "job") return json({ error: "a job token cannot claim; use the worker token" }, 403);
  // A host's registration (#334) claims with its capacity, a claim_id, want and every lease it holds: read whole, or refused.
  const host = actor.w.kind === "host";
  let hc: HostClaim | null = null;
  if (host) {
    const parsed = hostClaim(b as Record<string, unknown>);
    if (typeof parsed === "string") return json({ error: parsed }, 400);
    hc = parsed;
    hostAgent(b as Record<string, unknown>);
  }
  const probe = agentReport(b);
  const usage = usageReport(b.usage);
  const log = workerLog(b.log);
  // A worker is its registration: id, owner, trust and what it may build.
  const workerId = actor.w.id;
  if (actor.w.arch !== b.arch) return json({ error: `this worker is registered for ${actor.w.arch}` }, 400);
  // A host's native lane is its registration's arch (§8.1): the other lanes say what else it runs.
  if (hc?.capacity && !hc.capacity.lanes.some((l) => l.mode === "native" && l.arch === b.arch)) return json({ error: `capacity.lanes: the native lane is not ${b.arch}` }, 400);
  // A host's registration (#322, design v2 §6.2, §6.4): its host suspended or retired, or its owner no longer a maintainer — the owner's id
  // joined with the list at this very claim, between two syncs too — claims nothing, and is told why. Its running leases are not this
  // door's: a suspension fenced them; a removal lets them finish and upload. One read by the primary key, for host registrations only.
  if (actor.w.host_id) {
    const h = await env.DB.prepare(HOST_CLAIM_SQL).bind(actor.w.host_id).first<HostClaimRow>();
    const no = h ? hostClaimRefusal(h) : { code: "host_status", error: "its host is gone" };
    if (no) return json(no, 403);
  }
  const trust = actor.w.trust === "project" ? "project" : "community";
  // What this worker may claim. Project trust takes any kind it declares,
  // but never a contributor's build: project workers do the work a
  // maintainer would — pool jobs and the rebuild of an approved package —
  // and nothing that has no evidence and no review yet. Community trust
  // takes community builds only, and by default only its owner's: a worker
  // started with --shared (the claim says so) donates its compute to
  // anyone's, so a contributor never ends up building strangers' packages
  // by accident. Community results never reach the pool either way.
  const wanted = (Array.isArray(b.kinds) ? b.kinds.filter((k): k is string => typeof k === "string" && ALL_KINDS.includes(k)) : trust === "project" ? ALL_KINDS : ["build"]);
  // A host takes what the phase enables, of what it declares (§8.2).
  const kinds = host ? (Array.isArray(b.kinds) ? wanted : HOST_KINDS).filter((k) => HOST_KINDS.includes(k)) : trust === "project" ? wanted : ["build"];
  // A worker started with --shared donates its compute to everyone's
  // requests — any contributor's, since 2026-09-17: the shared workers are
  // the queue a request lands in. Community results never reach the pool
  // either way; a dedicated worker builds its owner's packages only. The
  // container's flag is the first word; once the mode was set from the
  // brain — the page, or the worker's own command line — the registration's
  // mode is what counts, at this claim and every one after.
  const shared = trust === "community" && (actor.w.mode_by ? actor.w.mode === "shared" : b.shared === true);
  // Workers follow the brain for their health (#277): what the claim says of
  // its process — the kinds of order it takes, which process it is, where
  // its agent is — against the row workerOf read with the token. The whole
  // orders path fails open: an exception delivers nothing, is logged, and
  // the claim goes on to its task or its 204.
  const at = now();
  const row = actor.w.orders ?? null;
  let facts: ClaimFacts | null = null;
  let step: InstanceStep | null = null;
  try {
    facts = claimFacts(b as Record<string, unknown>, request.headers, probe);
    if (row) step = instanceStep(row, facts, Date.parse(at));
    // What rolls its set out (#277, part 3) changes when its host does — the one-time step, an updater stopped or replaced: written with
    // the claim's one write, only when it says something new (canonical form, so the same words never write), and never while two
    // processes share the token — two hosts' reports would flip the row at every claim (PR #226).
    if (row && step && !step.conflict && facts.rollout !== (row.rollout ?? null)) step.set.rollout = facts.rollout;
  } catch (e) {
    console.error("orders:", e);
  }
  const agent = b.agent === undefined ? undefined : typeof b.agent === "string" ? b.agent : null;
  // The spell's start, written only by the claim that begins or ends it.
  const spellFrom = row?.agent_error_since ?? null;
  const spellTo = row ? spellAfter(spellFrom, probe, at) : spellFrom;
  const said = { worker: workerId, arch: b.arch, hostname: b.hostname, labels: b.labels, version: b.version, mode: trust === "community" ? (shared ? "shared" : "dedicated") : undefined, agent, kinds, probe, usage, log, agentVia: facts?.agent_via ?? row?.agent_via ?? null, at, spell: spellTo !== spellFrom ? { from: spellFrom, to: spellTo } : null, touchMinutes: host ? HOST_TOUCH_MINUTES : undefined };
  // A host's row holds no current_task: its leases are build_tasks.lease_owner's (§8.6).
  const touch = (task: number | null) => touchSaying(env, said, host ? null : task, step);
  const after = row && facts ? afterClaim(row, facts, step, probe, at) : null;
  if (hc) {
    // Its leases, compared with the pool's own: a fence ends in the orders path when the claim stops listing it; a lease the
    // dispatcher lost goes back to the queue here, whatever this claim is answered.
    if (after) after.listed = new Set(hc.leases.map((l) => `${l.task}:${l.gen}`));
    try {
      await reconcileHost(env, workerId, hc.leases, at);
    } catch (e) {
      console.error("reconcile:", e);
    }
  }
  // Every worker follows the latest image (update.ts): one behind past the
  // rollout's grace is touched — alive, and the Workers page says why it
  // idles — told once per release in the journal, and handed nothing.
  const update = updateState(b.version, running(env));
  if (update.required) {
    // Handed nothing, but an order waiting for it rides the refusal: a restart or a re-check does not need the latest image.
    const orders = after ? await ordersSafely(() => takeOrders(env, after, Date.parse(at))) : [];
    await touch(null);
    const told = await env.DB.prepare("SELECT told_update FROM build_workers WHERE id = ?").bind(workerId).first<{ told_update: string | null }>();
    if (told?.told_update !== update.latest) {
      await env.DB.batch([
        env.DB.prepare("UPDATE build_workers SET told_update = ? WHERE id = ?").bind(update.latest, workerId),
        env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('worker', NULL, 'factory', 'warn', ?, ?)")
          .bind(`${workerId}: handed nothing — ${updateMessage(update)}`, JSON.stringify({ worker: workerId, owner: actor.w.owner, yours: update.yours, latest: update.latest, behind: update.behind })),
      ]);
    }
    return json({ error: updateMessage(update), latest: update.latest, yours: update.yours, behind: update.behind, update: "/docs/workers#update", ...(orders.length ? { orders } : {}) }, 426);
  }
  // A retry of a claim whose answer was lost: the same lease, a fresh token (§8.1).
  if (hc?.want === 1) {
    const again = await env.DB.prepare(REPLAY_SQL).bind(plusMinutes(LEASE_MINUTES), workerId, hc.claimId).first<TaskRow>();
    if (again) {
      await touch(null);
      return taskAnswer(env, again, workerId);
    }
  }
  // An order waiting for this worker is delivered before any task, and an
  // answer that carries orders carries no task: the task stays queued for
  // the next claim. With nothing waiting, the pool's rules may give one.
  if (after) {
    const kindsNeedAgent = kinds.includes("audit") || (kinds.includes("build") && trust !== "project");
    const orders = await ordersSafely(async () => {
      const waiting = await takeOrders(env, after, Date.parse(at));
      if (waiting.length || after.claim.takes === null || !rulesOn(env)) return waiting;
      const auto = await autoOrder(env, after, { agent: agent ?? row!.agent, needsAgent: kindsNeedAgent, at, host });
      return auto ? [auto] : [];
    });
    if (orders.length) {
      await touch(null);
      return json({ task: null, orders });
    }
  }
  // Drained (#277): alive, and handed nothing until it is resumed — whatever its image, a column of the row the token was read
  // with, so it holds for a worker from before orders too, and fails closed. Cheaper than a claim: no task statement runs.
  if (row?.drained_at) {
    await touch(null);
    return new Response(null, { status: 204 });
  }
  // A full host reconciles and takes its orders, and nothing more (§8.1).
  if (hc?.want === 0) {
    await touch(null);
    return new Response(null, { status: 204 });
  }
  // What this worker is for the queue: emulated (x86_64 under qemu on an
  // aarch64 host) or native, and its size. (A fresh container's first claim
  // carries no usage yet: what this worker last reported stands in.) A
  // host's lanes are its capacity's.
  let mine = { emulated: !!(b.labels && typeof b.labels === "object" && (b.labels as Record<string, unknown>).emulated), cores: usage?.cores ?? 0, ram: usage?.ram_gb ?? 0 };
  if (!usage && !host) {
    const last = await env.DB.prepare("SELECT labels, usage FROM build_workers WHERE id = ?").bind(workerId).first<{ labels: string | null; usage: string | null }>();
    try { const u = last?.usage ? (JSON.parse(last.usage) as { cores?: number; ram_gb?: number }) : {}; const l = last?.labels ? (JSON.parse(last.labels) as { emulated?: boolean }) : {}; mine = { emulated: mine.emulated || !!l.emulated, cores: u.cores ?? 0, ram: u.ram_gb ?? 0 }; } catch { /* as reported now */ }
  }
  // The best idle shared worker has first pick (a legacy community registration's, until #343): while a better shared worker of
  // this architecture — native over emulated, then more cores, then more memory — is alive and idle, this one leaves the queue's
  // newest builds to it. A native worker keeps its owner's as its own; an emulated one has no first pick of those either — it took
  // omarchy-cli's Rust build at once, installed the toolchain and could not start rustc while a native worker sat idle (#519,
  // 2026-09-18). After three minutes anyone takes them: most packages build fine emulated, and a worker that is alive but never
  // claims holds nobody up.
  const firstPick = !host && trust === "community" && shared && (await betterIdleWorker(env, workerId, b.arch, mine, probe?.status === "ok"));
  const task = await selectAndLease(env, {
    workerId, arch: b.arch, version: b.version ?? null, kinds, probeOk: probe?.status === "ok", hostId: actor.w.host_id ?? null, hc,
    legacy: host ? null : { emulated: mine.emulated, trust, owner: actor.w.owner ?? null, shared, firstPick },
  });
  await touch(task?.id ?? null);
  if (!task) return new Response(null, { status: 204 });
  if (task.trust === "community" && task.kind === "build") {
    await env.DB.prepare("UPDATE factory_packages SET status = 'building', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`building on ${workerId} (${task.arch})`, task.name).run();
  }
  // The package's architecture is being built — by its contributor, or again by the project: its target says so.
  if (task.kind === "build") await settleTargets(env, task.name);
  return taskAnswer(env, task, workerId);
}

async function owned(env: Env, id: number, actor: Actor): Promise<TaskRow | Response> {
  if (actor.kind === "job" && !actor.job.s.includes(`task:${id}`)) return json({ error: `this job token is for task ${actor.job.t}` }, 403);
  const who = actor.kind === "worker" ? actor.w.id : actor.job.w;
  const task = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<TaskRow>();
  if (!task) return json({ error: "no such task" }, 404);
  // A task that is no longer the caller's says so, and says it on every call (#277): `stop` tells the worker to stop the task's
  // processes — a child holding the job token cannot swallow it, it is not a one-time order — and `state` what became of it.
  if (task.status !== "leased" || task.lease_owner !== who) return json({ error: `task ${id} is ${task.status}${task.lease_owner ? " by " + task.lease_owner : ""}; the lease is not yours`, stop: true, state: task.status }, 409);
  // A host's lease (#334, D46) is acted on with the job token of that very lease: the same host may hold the task again, under the
  // same lease_owner, after a stop it re-claimed before the kill landed — the old container's token names the older generation.
  const gen = actor.kind === "job" ? actor.job.g ?? null : null;
  if ((task.lease_gen ?? null) !== gen) return json({ error: `this token is of another lease of task ${id}: a host's lease is acted on with its own job token only`, stop: true, state: task.status }, 409);
  // Stopped from its worker's page: still leased to this worker, so nobody else takes it, but nothing it sends is taken and nothing renews the lease or its token.
  if (task.stop_order) return json({ error: `task ${id} was stopped from its worker's page: it goes back to the queue once this worker has stopped it`, stop: true, state: "stopping" }, 409);
  return task;
}

function workerName(actor: Actor): string {
  return actor.kind === "worker" ? actor.w.id : actor.job.w;
}

/**
 * A write that ends or renews a lease is conditional on the lease owned()
 * read (#277): still leased to the caller, and not fenced. A stop, a cancel
 * or a requeue that landed between that read and the write makes it change
 * nothing — never a lease renewed, a token handed out, or a report taken
 * for a task stopped meanwhile —, and the caller hears what became of the
 * task, in owned()'s words.
 */
const LEASE_HELD = "status = 'leased' AND lease_owner = ? AND lease_gen IS ? AND stop_order IS NULL";
async function leaseMoved(env: Env, id: number, actor: Actor): Promise<Response> {
  const again = await owned(env, id, actor);
  return again instanceof Response ? again : json({ error: `task ${id}'s lease moved meanwhile; send it again` }, 409);
}

/**
 * What a legacy worker registered about itself: x86_64 under qemu on an aarch64 host, or not. Read only for a legacy lease the claim
 * wrote no lane for (one taken before #337 wrote lanes): every other lease's lane is its own (handleFail, #338).
 */
async function emulated(env: Env, workerId: string): Promise<boolean> {
  const w = await env.DB.prepare("SELECT labels FROM build_workers WHERE id = ?").bind(workerId).first<{ labels: string | null }>();
  try { return !!(w?.labels && (JSON.parse(w.labels) as { emulated?: boolean }).emulated); } catch { return false; }
}

export async function handleHeartbeat(id: number, env: Env, actor: Actor): Promise<Response> {
  const task = await owned(env, id, actor);
  if (task instanceof Response) return task;
  const who = workerName(actor);
  const until = plusMinutes(LEASE_MINUTES);
  const renewed = await env.DB.prepare(`UPDATE build_tasks SET lease_expires_at = ? WHERE id = ? AND ${LEASE_HELD}`).bind(until, id, who, task.lease_gen).run();
  if (!renewed.meta.changes) return leaseMoved(env, id, actor);
  // A host's row has no current_task (#334): its leases are build_tasks.lease_owner's.
  if (task.lease_gen === null) await env.DB.prepare("UPDATE build_workers SET last_seen = ?, current_task = ? WHERE id = ?").bind(now(), id, who).run();
  else await env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id = ?").bind(now(), who).run();
  // The lease moved; so does the job's credential — of the same lease.
  const params = task.params ? (JSON.parse(task.params) as Record<string, unknown>) : {};
  const expires = Math.floor(Date.now() / 1000) + LEASE_MINUTES * 60;
  const token = await issueJobToken(env, { t: task.id, k: task.kind, s: scopesFor(task.kind, task.id, task.trust, params, task.publish), e: expires, w: who, ...(task.lease_gen ? { g: task.lease_gen } : {}) });
  return json({ task: id, lease_expires_at: until, token, token_expires_at: new Date(expires * 1000).toISOString() });
}

/**
 * The tail of the log and the error line travel with complete/fail into the
 * row, and out through GET /factory/tasks/:id — a public place the PUT check
 * (leak.ts) does not see. What looks like a secret in them is withheld, with
 * a note in its place and a `leak` event; the completion itself stands.
 */
async function withheld(env: Env, id: number, field: string, text: string | undefined): Promise<string> {
  const t = text ?? "";
  const leak = findLeak(t);
  if (!leak) return t;
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('leak', NULL, 'factory', 'warn', ?, ?)")
    .bind(`task ${id}: ${field} withheld — it carried what looks like ${leak.kind}`, JSON.stringify({ task: id, field, kind: leak.kind, line: leak.line }))
    .run();
  return `[${field} withheld: it carried what looks like ${leak.kind}; the worker's environment must hold nothing the build can see — /docs/workers#secrets]`;
}

export async function handleComplete(id: number, request: Request, env: Env, actor: Actor): Promise<Response> {
  const b = await readJson<{ sha256?: string; filename?: string; version?: string; duration_ms?: number; log_tail?: string; result?: unknown; summary?: string }>(request);
  if (b instanceof Response) return b;
  const task = await owned(env, id, actor);
  if (task instanceof Response) return task;
  const who = workerName(actor);
  const tail = (await withheld(env, id, "log_tail", b.log_tail)).slice(-4000);
  if (task.kind !== "build") {
    // A pool job: what it did is its result; the journal gets one line.
    // The lease ends with the status; who held it stays on the row — the
    // journal, the seal and the load per worker read it later.
    const ended = await env.DB.prepare(`UPDATE build_tasks SET status = 'done', finished_at = ?, duration_ms = ?, log_tail = ?, result = ?, lease_expires_at = NULL WHERE id = ? AND ${LEASE_HELD}`)
      .bind(now(), b.duration_ms ?? null, tail, b.result ? JSON.stringify(b.result) : null, id, who, task.lease_gen)
      .run();
    if (!ended.meta.changes) return leaseMoved(env, id, actor);
    await workerFinished(env, who, task, "done");
    const p = task.params ? (JSON.parse(task.params) as Record<string, string>) : {};
    // Promotion by evidence, when the evidence can exist: the last sync of
    // a tick queues edge → rc (the promote job records the health and ABI
    // of edge on both architectures, then the gate decides). Not while
    // another sync of the tick still runs, and never twice.
    if (task.kind === "sync") {
      const others = await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE kind = 'sync' AND status IN ('queued', 'leased') AND id != ?").bind(id).first<{ n: number }>();
      const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE kind = 'promote' AND status IN ('queued', 'leased') AND json_extract(params, '$.from') = 'edge' AND json_extract(params, '$.to') = 'rc'").first<{ n: number }>();
      if (!others?.n && !pending?.n) {
        const params = JSON.stringify({ from: "edge", to: "rc", note: "by evidence, after the sync" });
        const pid = (await env.DB.prepare(
          `INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, priority, status, publish, trust, kind, params) VALUES ('promote', 'x86_64', '-', ?, 50, 'queued', 1, 'project', 'promote', ?) RETURNING id`,
        ).bind(`sync ${id} done`, params).first<{ id: number }>())?.id ?? 0;
        await event(env, "dispatch", "ok", `promote edge → rc queued as task ${pid} — the sync changed edge; the evidence decides`, { task: pid, after: id });
      }
    }
    const label = task.kind === "audit" || task.kind === "trial" ? `${p.name} (task ${p.task})` : task.kind === "publish" ? `${p.name} ${p.version ?? ""} (${p.arch})` : [p.source, p.arch, p.ring, p.from && p.to ? `${p.from} → ${p.to}` : null].filter(Boolean).join("/");
    if (task.kind === "publish" && p.task) {
      // The project's approved build is in the pool: the registration is published, the build's row says so, the seal is written next to the object.
      const built = Number(p.task);
      const res = (b.result ?? {}) as { sha256?: string; filename?: string; version?: string };
      await env.DB.batch([
        env.DB.prepare("UPDATE factory_packages SET status = 'published', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
          .bind(`${res.version ?? p.version ?? ""} for ${p.arch} built by the project (task ${built}), approved, signed, in edge`, task.name),
        env.DB.prepare("UPDATE build_tasks SET status = 'done', result_sha256 = COALESCE(?, result_sha256), publish = 1 WHERE id = ? AND status = 'staged'").bind(res.sha256 ?? null, built),
      ]);
      // The package is in the pool: its staging copy, and the contributor's
      // build the project learned from, give their bytes back. The text
      // evidence of both stays, and is on the record anyway.
      const from = await env.DB.prepare("SELECT json_extract(params, '$.review') AS review FROM build_tasks WHERE id = ?").bind(built).first<{ review: number | null }>();
      await reclaimStagingPackages(env, [built, from?.review ?? null]);
      if (res.sha256) {
        try {
          await writeAttestation(env, res.sha256);
        } catch (e) {
          await event(env, "build", "warn", `${task.name}: attestation not written — ${String(e)}`, { task: built, sha256: res.sha256 });
        }
      }
      // This architecture of the package is in the pool; the others say where they are.
      await settleTargets(env, task.name);
    }
    if (task.kind === "audit" && p.task) {
      // The second agent's report joins the evidence on the record.
      const audited = await env.DB.prepare("SELECT name, staged_prefix FROM build_tasks WHERE id = ?").bind(Number(p.task)).first<{ name: string; staged_prefix: string | null }>();
      if (audited?.staged_prefix) await recordEvidence(env, audited.name, await requestOf(env, audited.name), Number(p.task), audited.staged_prefix, ["audit.json", "audit.md"]);
      // Its proposal for the category (categories.ts) settles nothing: the
      // registration takes it only while no maintainer set one, and a
      // maintainer may change it at review or any time after.
      const proposed = (b.result as { category?: unknown } | undefined)?.category;
      if (audited && isCategory(proposed)) {
        const set = await env.DB.prepare("UPDATE factory_packages SET category = ? WHERE name = ? AND category IS NULL").bind(proposed, audited.name).run();
        if (set.meta.changes) await event(env, "category", "ok", `${audited.name}: ${proposed}, proposed by the project's agent (audit of task ${p.task}); a maintainer settles it at review`, { name: audited.name, category: proposed, task: Number(p.task), by: "agent" });
      }
    }
    await event(env, "job", "ok", `${task.kind}${label ? " " + label : ""}: ${b.summary ?? "done"} by ${who}${b.duration_ms ? " in " + Math.round(b.duration_ms / 1000) + " s" : ""}`, { task: id, kind: task.kind, params: p, worker: who, result: b.result ?? null, duration_ms: b.duration_ms ?? null });
    return json({ task: id, status: "done" });
  }
  if (!b.sha256 || !b.filename) return json({ error: "sha256 and filename are required" }, 400);
  const review = task.params ? (JSON.parse(task.params) as { review?: number }).review : undefined;
  if (task.trust === "community" || review !== undefined) {
    // The result must be in staging — the contributor's workspace, or the
    // project's for a review build: the package named, its PKGBUILD and
    // the build log.
    const prefix = `staging/${review !== undefined ? "@project" : task.owner}/${task.name}/${task.id}/`;
    const have = (await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ?").bind(id).all<{ key: string }>()).results.map((r) => r.key.slice(prefix.length));
    const missing = [b.filename, "PKGBUILD", "build.log"].filter((f) => !have.includes(f));
    if (missing.length) return json({ error: `upload ${missing.join(", ")} to staging first (PUT /factory/tasks/${id}/artifacts/<filename>)`, have }, 409);
    // The gate (vet.json, the worker's own verdict) travels with the task; a failing gate never stages — the worker reports it as a failure.
    const vet = await vetOf(env, prefix);
    if (vet?.verdict === "fail") return json({ error: `the gate failed (${vet.failed.join(", ")}); report the build as failed, not complete` }, 409);
    // The lease ends with the status; who held it stays on the row — the
    // Review page names the worker behind every build (built_by), the seal
    // and the load per worker read it later. The project's review build
    // keeps the agent its worker ran (built_with, the worker's own word with
    // its claim): the agent a maintainer's decision on it is signed with
    // (#247), whatever the worker runs by then.
    const staged = await env.DB.prepare(
      `UPDATE build_tasks SET status = 'staged', finished_at = ?, result_sha256 = ?, result_filename = ?, result_version = ?, version = COALESCE(version, ?), duration_ms = ?, log_tail = ?, staged_prefix = ?, result = ?, lease_expires_at = NULL, params = CASE WHEN ? THEN json_set(COALESCE(params, '{}'), '$.built_with', (SELECT agent FROM build_workers WHERE id = ?)) ELSE params END WHERE id = ? AND ${LEASE_HELD}`,
    )
      .bind(now(), b.sha256, b.filename, b.version ?? null, b.version ?? null, b.duration_ms ?? null, tail, prefix, vet ? JSON.stringify({ vet }) : null, review !== undefined ? 1 : 0, who, id, who, task.lease_gen)
      .run();
    if (!staged.meta.changes) return leaseMoved(env, id, actor);
    // The evidence outlives staging: on the record, signed.
    await recordEvidence(env, task.name, await requestOf(env, task.name), id, prefix);
    await workerFinished(env, who, task, "staged", b.version);
    // A newer build of the same package and architecture supersedes the
    // staged ones before it: one row per package in the review queue, the
    // audits of the old ones cancelled with them. Their text evidence stays;
    // their packages give the contributor's quota back.
    const older = await env.DB.prepare("SELECT id FROM build_tasks WHERE kind = 'build' AND trust = ? AND status = 'staged' AND name = ? AND arch = ? AND id < ?")
      .bind(task.trust, task.name, task.arch, id)
      .all<{ id: number }>();
    for (const o of older.results) {
      await env.DB.batch([
        env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ? WHERE id = ?").bind(`superseded by task ${id}${b.version ? " (" + b.version + ")" : ""}`, o.id),
        env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build it audited was superseded' WHERE kind = 'audit' AND status = 'queued' AND json_extract(params, '$.task') = ?").bind(o.id),
        env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build it tried was superseded' WHERE kind = 'trial' AND status = 'queued' AND json_extract(params, '$.task') = ?").bind(o.id),
      ]);
    }
    await reclaimStagingPackages(env, older.results.map((o) => o.id));
    await env.DB.prepare("UPDATE factory_packages SET status = 'staged', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
      .bind(review !== undefined ? `${b.version ?? ""} for ${task.arch} built by the project (task ${id}), gate ${vet?.verdict ?? "n/a"}${vet?.warnings ? " with " + vet.warnings + " warning(s)" : ""}; waiting for a maintainer's approval` : `${b.version ?? ""} built for ${task.arch} by ${who}; waiting for a maintainer`, task.name).run();
    await event(env, "build", "ok", review !== undefined
      ? `${task.name} ${b.version ?? ""} built by the project for ${task.arch} on ${who}${b.duration_ms ? " in " + Math.round(b.duration_ms / 60000) + " min" : ""} — from ${task.owner ?? "?"}'s build ${review}, staged for approval`
      : `${task.name} ${b.version ?? ""} built for ${task.arch} by ${who}${b.duration_ms ? " in " + Math.round(b.duration_ms / 60000) + " min" : ""} — staged for a maintainer (${task.owner})`,
      { task: id, arch: task.arch, sha256: b.sha256, filename: b.filename, worker: who, owner: task.owner, staged_prefix: prefix, duration_ms: b.duration_ms ?? null, review: review ?? null });
    // The second agent: a project worker whose owner set an agent key reads
    // the staged PKGBUILD, log and .PKGINFO and attaches a report to the
    // evidence (audit.json, audit.md in the same staging prefix). It runs
    // as a job of its own so the contributor's worker never holds the
    // key or writes the report; the maintainer still decides.
    await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params) VALUES (?, ?, ?, ?, ?, 40, 'queued', 0, 'project', NULL, 'audit', ?)`,
    )
      .bind(task.name, task.arch, b.version ?? null, `staging:${id}`, `staged as task ${id}`, JSON.stringify({ task: id, name: task.name, owner: task.owner, arch: task.arch }))
      .run();
    // The trial, for the project's build only (a contributor's bytes never
    // enter the pool): the package into the lab, a real pacman installs it
    // from the lab above edge in a clean container, the transcript beside
    // the evidence (trial.log). Evidence for the maintainer, never a
    // decision. A worker of the build's architecture takes it.
    if (review !== undefined) {
      await env.DB.prepare(
        `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params) VALUES (?, ?, ?, ?, ?, 40, 'queued', 0, 'project', NULL, 'trial', ?)`,
      )
        .bind(task.name, task.arch, b.version ?? null, `staging:${id}`, `staged as task ${id}`, JSON.stringify({ task: id, name: task.name, arch: task.arch, version: b.version ?? null, files: [b.filename] }))
        .run();
    }
    await settleTargets(env, task.name);
    return json({ task: id, status: "staged", staged_prefix: prefix });
  }
  // The result must be in the pool. A rebuild of a version already stored
  // under the same filename pins the stored object (pkg-repo publish), so
  // the filename settles which sha256 the pool actually serves.
  let indexed = task.publish === 0 ? { sha256: b.sha256 } : null;
  if (!indexed) {
    indexed = await env.DB.prepare("SELECT sha256 FROM packages WHERE sha256 = ? OR (filename = ? AND repo_arch = ?) ORDER BY sha256 = ? DESC LIMIT 1")
      .bind(b.sha256, b.filename, task.arch, b.sha256)
      .first<{ sha256: string }>();
  }
  if (!indexed) return json({ error: "publish the package to the pool first (pkg-repo publish --source factory), then complete" }, 409);
  const done = await env.DB.prepare(
    `UPDATE build_tasks SET status = 'done', finished_at = ?, result_sha256 = ?, result_filename = ?, result_version = ?, duration_ms = ?, log_tail = ?, lease_expires_at = NULL WHERE id = ? AND ${LEASE_HELD}`,
  )
    .bind(now(), indexed.sha256, b.filename, b.version ?? null, b.duration_ms ?? null, tail, id, who, task.lease_gen)
    .run();
  if (!done.meta.changes) return leaseMoved(env, id, actor);
  await workerFinished(env, who, task, "done", b.version);
  if (task.publish !== 0) {
    // What users get. A contributor's registration of this name is now
    // published, and the approval that led here keeps the task — the seal
    // and the track record follow that link (docs/GOVERNANCE.md). The link
    // is history — which approval asked for this build — so it reads
    // `decision` alone, a withdrawn approval included: an approval taken
    // back since still asked; approve sets rebuild_task at once (#182), so
    // this finds the approvals from before that flow, newest first.
    const answered = await env.DB.prepare("SELECT id FROM approvals WHERE name = ? AND arch = ? AND decision = 'approved' AND rebuild_task IS NULL ORDER BY id DESC LIMIT 1").bind(task.name, task.arch).first<{ id: number }>();
    await env.DB.batch([
      env.DB.prepare("UPDATE factory_packages SET status = 'published', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
        .bind(`${b.version ?? ""} for ${task.arch} built by the project (task ${id}), signed, in edge`, task.name),
      ...(answered ? [env.DB.prepare("UPDATE approvals SET rebuild_task = ? WHERE id = ?").bind(id, answered.id)] : []),
    ]);
  }
  await event(env, "build", "ok", `${task.name} ${b.version ?? ""} built for ${task.arch} by ${who}${b.duration_ms ? " in " + Math.round(b.duration_ms / 60000) + " min" : ""}${task.publish === 0 ? " (dry run, not published)" : ""}`, { task: id, arch: task.arch, sha256: indexed.sha256, filename: b.filename, worker: who, attempts: task.attempts, duration_ms: b.duration_ms ?? null });
  if (task.publish !== 0) await settleTargets(env, task.name);
  // The seal, next to the object: the chain that produced it, signed by the pool.
  let attested = false;
  if (task.publish !== 0) {
    try {
      attested = await writeAttestation(env, indexed.sha256);
    } catch (e) {
      await event(env, "build", "warn", `${task.name}: attestation not written — ${String(e)}`, { task: id, sha256: indexed.sha256 });
    }
  }
  return json({ task: id, status: "done", attested });
}

export async function handleFail(id: number, request: Request, env: Env, actor: Actor): Promise<Response> {
  const b = await readJson<{ error?: string; duration_ms?: number; log_tail?: string; final?: boolean; needs_native?: boolean; lost?: boolean; oom?: boolean }>(request);
  if (b instanceof Response) return b;
  const task = await owned(env, id, actor);
  if (task instanceof Response) return task;
  const who = workerName(actor);
  const tail = (await withheld(env, id, "log_tail", b.log_tail)).slice(-4000);
  // Two words of a host's lease (#334, D54): `oom`, the engine's out-of-memory kill — a failure like any other, its reason on the row —
  // and `lost`, a host event (a reboot, an engine restart, the disk watcher's kill), which gives the attempt back like needs_native,
  // at most HOST_LOSSES_MAX times per task so a crash-looping host cannot requeue it for ever. A legacy lease's report has neither.
  const hostLease = task.lease_gen !== null;
  const oom = hostLease && b.oom === true;
  const lost = hostLease && b.lost === true && task.host_losses < HOST_LOSSES_MAX;
  const lostSpent = hostLease && b.lost === true && !lost;
  const said = (await withheld(env, id, "error", b.error ?? "build failed")).slice(0, 2000);
  // Out of memory says the memory its lease had, from its units, and a build's size (#337): "out of memory at 4 GB (size 1)" — the
  // words the package and Review pages show beside a maintainer's Retry at size (OOM_ERROR).
  const oomAt = `out of memory at ${(task.units ?? 1) * UNIT.mem_gb} GB${task.kind === "build" ? ` (size ${task.size ?? 1})` : ""}`;
  const error = (oom ? `${oomAt} — the engine killed it: ${said}` : lostSpent ? `lost a third time on its host, the attempt spent: ${said}` : said).slice(0, 2000);
  // Retries are for the infrastructure (a download, a mirror, a container
  // killed), not for the recipe: a PKGBUILD that failed to build fails the
  // same way three times, each in a fresh container — the first
  // contributor's day, 2026-09-15, was 84 failed attempts for 28 tasks. The
  // worker says which is which (`final`); the contributor fixes and queues
  // a new build. A toolchain that cannot start on the worker (rustc under
  // qemu on a 16 KB-page host, `needs_native`) is the worker's fault, not
  // the recipe's: the build goes back to the queue for a native lane of
  // its architecture (selection hands it to no emulated lane again), and
  // the attempt is given back — a build no worker ran is not an attempt.
  // The word counts from a lease on an emulated lane only (#338, design v2
  // §8.6): the lane the claim wrote on this very lease, never the
  // registration's labels — one host runs a native and an emulated lane
  // under one registration. From a native lane it is refused (a failure
  // like any other, its attempt spent): that lane would be handed the same
  // build back for ever. A legacy lease the claim wrote no lane for (taken
  // before #337 wrote them) is read as its registration said, as before.
  const emulatedLane = task.lane === "emulated" || (task.lane === null && task.lease_gen === null && (await emulated(env, who)));
  const needsNative = !lost && b.needs_native === true && emulatedLane;
  const nativeRefused = !lost && b.needs_native === true && !emulatedLane;
  const exhausted = !needsNative && !lost && (b.final === true || task.attempts >= task.max_attempts);
  const review = task.kind === "build" && task.params ? (JSON.parse(task.params) as { review?: number }).review : undefined;
  // A requeued task goes behind its peers (priority + 10) so one broken
  // PKGBUILD does not hold the queue. One sent back for a native worker
  // waits for no other: not the worker it was pinned to, not the owner's
  // fourteen days of a bump — the one that had it is the one that cannot.
  const failed = await env.DB.prepare(
    `UPDATE build_tasks SET status = ?, finished_at = ?, error = ?, log_tail = ?, duration_ms = ?, lease_owner = ?, lease_expires_at = NULL, priority = priority + 10${needsNative ? ", attempts = attempts - 1, pinned_to = NULL, shared_after = NULL, params = json_set(COALESCE(params, '{}'), '$.needs_native', 1)" : ""}${lost ? ", attempts = attempts - 1, host_losses = host_losses + 1" : ""} WHERE id = ? AND ${LEASE_HELD}`,
  )
    .bind(exhausted ? "failed" : "queued", exhausted ? now() : null, error, tail, b.duration_ms ?? null, exhausted ? task.lease_owner : null, id, who, task.lease_gen)
    .run();
  if (!failed.meta.changes) return leaseMoved(env, id, actor);
  // What the worker uploaded before giving up — the log, the PKGBUILD, the
  // gate's verdict — is evidence too: a failed attempt is on the record (a
  // report the pool took: not one of a lease stopped meanwhile).
  if (task.kind === "build" && (task.trust === "community" ? task.owner : review !== undefined)) {
    await recordEvidence(env, task.name, await requestOf(env, task.name), id, `staging/${review !== undefined ? "@project" : task.owner}/${task.name}/${task.id}/`, ["PKGBUILD", "build.log", "vet.json", "tests.log"]);
  }
  await workerFinished(env, who, task, "failed");
  // A build that failed for good may have staged its package before the
  // gate or the quota stopped it: the log and the recipe stay, the package goes.
  if (exhausted && task.kind === "build") await reclaimStagingPackages(env, [id]);
  if (task.trust === "community" && exhausted) {
    await packageAfterFailure(env, task.name, "registered", `build failed on ${who}: ${error.slice(0, 160)}`);
  } else if (task.trust === "community" && needsNative) {
    // The package follows its task back to waiting, and says what for — the page shows it while no native worker is online.
    await env.DB.prepare("UPDATE factory_packages SET status = 'waiting', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status = 'building'").bind(`waiting for a native ${task.arch} worker (task ${id})`, task.name).run();
  } else if (review !== undefined && exhausted) {
    // The project's build failed: the contributor's stays staged, and the review row says what the project ran into.
    await env.DB.prepare("UPDATE factory_packages SET detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`the project's build (task ${id}) failed on ${who}: ${error.slice(0, 160)}`, task.name).run();
  } else if (review !== undefined && needsNative) {
    await env.DB.prepare("UPDATE factory_packages SET detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`the project's build (task ${id}) waits for a native ${task.arch} worker`, task.name).run();
  }
  if (task.kind === "build") await settleTargets(env, task.name);
  const attempts = needsNative || lost ? task.attempts - 1 : task.attempts;
  const refused = nativeRefused ? ` (its needs_native refused: it ran on ${task.lane === "native" ? "the native lane" : "a native worker"})` : "";
  const tale = lost ? ` lost on ${who} (a host event, ${task.host_losses + 1} of ${HOST_LOSSES_MAX}) — back in the queue, the attempt given back` : needsNative ? ` on ${who} needs a native ${task.arch} worker — back in the queue for one${task.pinned_to ? `, the pin to ${task.pinned_to} dropped` : ""}` : ` failed on ${who} (attempt ${task.attempts}/${task.max_attempts})${refused}${b.final ? " — the recipe's, not retried" : exhausted ? " — giving up" : " — back in the queue"}`;
  await event(env, "build", exhausted ? "error" : "warn", `${task.name} for ${task.arch}${tale}: ${error.slice(0, 120)}`, { task: id, arch: task.arch, worker: who, attempts, exhausted, final: b.final === true, needs_native: needsNative, ...(nativeRefused ? { needs_native_refused: true, lane: task.lane } : {}), ...(hostLease ? { lost: b.lost === true, oom } : {}) });
  return json({ task: id, status: exhausted ? "failed" : "queued", attempts });
}

/** A disk budget a maintainer may set on a package's page, in GB. */
export const DISK_GB_MAX = 4096;

/**
 * POST /factory/packages/:name/size {size, disk_gb} — a maintainer sets the
 * size and the disk budget a package's builds run with (#337, design v2
 * §7.4; D31), on its page: a size from 1 to the signed maximum, a budget in
 * GB; null clears one, and factory/sizing/tasks.toml's word — or size 1 and
 * the signed GB per size — stands again. The page's word wins over the
 * file's until it is cleared; the claim still clamps a contributor's build
 * to 2 and every one to the largest host alive. Journaled with who.
 */
export async function handleSetSize(c: Contributor, name: string, request: Request, env: Env): Promise<Response> {
  if (!isMaintainer(c)) return json({ error: "a maintainer sets a package's size" }, 403);
  const b = await readJson<{ size?: unknown; disk_gb?: unknown }>(request);
  if (b instanceof Response) return b;
  const whole = (v: unknown, max: number) => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max);
  if (b.size === undefined && b.disk_gb === undefined) return json({ error: "size and/or disk_gb: a whole number, or null to clear it" }, 400);
  if (b.size !== undefined && !whole(b.size, MAX_SIZE)) return json({ error: `size: a whole number from 1 to ${MAX_SIZE}, or null for factory/sizing's (or 1)` }, 400);
  if (b.disk_gb !== undefined && !whole(b.disk_gb, DISK_GB_MAX)) return json({ error: `disk_gb: a whole number of GB from 1 to ${DISK_GB_MAX}, or null for factory/sizing's (or ${BUILD_GB_PER_SIZE} per size)` }, 400);
  const pkg = await env.DB.prepare("SELECT name, size, disk_gb FROM factory_packages WHERE name = ?").bind(name).first<{ name: string; size: number | null; disk_gb: number | null }>();
  if (!pkg) return json({ error: "not registered" }, 404);
  const size = b.size === undefined ? pkg.size : (b.size as number | null);
  const disk = b.disk_gb === undefined ? pkg.disk_gb : (b.disk_gb as number | null);
  const view = sizingView({ name, size, disk_gb: disk });
  if (size === pkg.size && disk === pkg.disk_gb) return json({ package: name, sizing: view, by: c.login, unchanged: true });
  const words = (z: number | null, d: number | null) => `size ${z ?? "unset"}, disk ${d === null ? "unset" : `${d} GB`}`;
  await env.DB.batch([
    env.DB.prepare("UPDATE factory_packages SET size = ?, disk_gb = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(size, disk, name),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('build', NULL, 'factory', 'ok', ?, ?)")
      .bind(`${name}: ${words(size, disk)} (was ${words(pkg.size, pkg.disk_gb)}), set by ${c.login} — its builds ask size ${view.size} and ${view.disk_gb} GB from now on`, JSON.stringify({ name, size, disk_gb: disk, was: { size: pkg.size, disk_gb: pkg.disk_gb }, by: c.login, sizing: view })),
  ]);
  return json({ package: name, sizing: view, was: { size: pkg.size, disk_gb: pkg.disk_gb }, by: c.login });
}

/** What an out-of-memory failure's error begins with (handleFail): the builds a maintainer may retry at another size. */
export const OOM_ERROR = /^out of memory at \d+ GB/;

/** The largest size the registrations alive run now (D31, selection.ts): what a retry or a size may ask at most. */
export async function largestAlive(env: Env, at = Date.now()): Promise<number> {
  const rows = (await env.DB.prepare(FLEET_SQL).bind(new Date(at - Math.max(ALIVE_MS, LEGACY_ALIVE_MS)).toISOString()).all<FleetRow>()).results;
  const pool = running(env);
  return largestSize({ members: rows.map((r) => memberOf(r, pool, at)), leases: [] }, at, selectionRules());
}

/**
 * POST /factory/tasks/:id/retry {size} — Retry at size (#337, design v2
 * §7.4; D31): a maintainer queues a build that ran out of memory again at
 * the size they choose, up to the largest host alive and the signed maximum
 * (a contributor's 2). The task's own size (`params.size`) says it: the
 * package's size is not changed — that is factory/sizing's or the
 * package's page's. A failed one gets one more attempt; a queued one (its
 * attempts not spent yet) only its size. The journal says who and why.
 */
export async function handleRetryAtSize(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  if (!isMaintainer(c)) return json({ error: "a maintainer retries a build at another size" }, 403);
  const b = await readJson<{ size?: unknown }>(request);
  if (b instanceof Response) return b;
  const t = await env.DB.prepare("SELECT id, name, arch, kind, trust, owner, status, error, size, attempts, max_attempts, params FROM build_tasks WHERE id = ?").bind(id)
    .first<{ id: number; name: string; arch: string; kind: string; trust: string; owner: string | null; status: string; error: string | null; size: number | null; attempts: number; max_attempts: number; params: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  if (t.kind !== "build" || !OOM_ERROR.test(t.error ?? "") || (t.status !== "failed" && t.status !== "queued")) return json({ error: `task ${id} is no build that ran out of memory and waits: only those are retried at another size`, code: "not_oom" }, 409);
  const max = t.trust === "community" ? COMMUNITY_MAX_SIZE : MAX_SIZE;
  const size = b.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > max) return json({ error: `size: a whole number from 1 to ${max}${t.trust === "community" ? " (a contributor's build)" : ""}` }, 400);
  const largest = await largestAlive(env);
  if (size > largest) return json({ error: `no host alive runs size ${size}: the largest runs ${largest}`, code: "too_large", largest }, 409);
  const was = jsonOr<{ size?: unknown }>(t.params, {}).size ?? t.size ?? 1;
  const back = await env.DB.prepare(
    `UPDATE build_tasks SET status = 'queued', finished_at = NULL, lease_owner = NULL, lease_expires_at = NULL, attempts = MIN(attempts, max_attempts - 1),
       params = json_set(COALESCE(params, '{}'), '$.size', ?) WHERE id = ? AND kind = 'build' AND status IN ('failed', 'queued') AND error LIKE 'out of memory at %' RETURNING id, attempts`,
  ).bind(size, id).first<{ id: number; attempts: number }>();
  if (!back) return json({ error: `task ${id} moved meanwhile; look again` }, 409);
  const review = jsonOr<{ review?: unknown }>(t.params, {}).review;
  if (t.trust === "community") await packageAfterFailure(env, t.name, "waiting", `queued again at size ${size} after running out of memory at size ${was} (task ${id}), by ${c.login}`);
  else if (typeof review === "number") await env.DB.prepare("UPDATE factory_packages SET detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`the project's build (task ${id}) is queued again at size ${size} by ${c.login}`, t.name).run();
  await settleTargets(env, t.name);
  await event(env, "build", "ok", `${t.name} for ${t.arch} (task ${id}): ran out of memory at size ${was}; queued again at size ${size} by ${c.login}`, { task: id, name: t.name, arch: t.arch, size, was, by: c.login, attempts: back.attempts });
  return json({ task: id, status: "queued", size, was, attempts: back.attempts, by: c.login });
}

/**
 * Leases that expired go back to the queue (or fail when out of attempts).
 * Called by the scheduler. A lease a Stop its task fenced (#277) ends here
 * when its worker did not claim again first: nothing renewed it, so every
 * job token of it has expired by now, whatever the stopped process still
 * runs — its line names the stop.
 */
export async function requeueExpiredLeases(env: Env): Promise<number> {
  const at = now();
  const expired = await env.DB.prepare("SELECT id, name, arch, lease_owner, attempts, max_attempts, trust, kind, stop_order FROM build_tasks WHERE status = 'leased' AND lease_expires_at < ?")
    .bind(at)
    .all<{ id: number; name: string; arch: string; lease_owner: string; attempts: number; max_attempts: number; trust: string; kind: string; stop_order: string | null }>();
  for (const t of expired.results) {
    let error = `lease by ${t.lease_owner} expired`;
    if (t.stop_order) {
      const o = await env.DB.prepare("SELECT issued_by, reason FROM worker_orders WHERE id = ?").bind(t.stop_order).first<{ issued_by: string; reason: string }>();
      error = stopError(t.lease_owner, o?.issued_by ?? "?", o?.reason ?? null, true);
    }
    // Only while it has still expired: a heartbeat that renewed it since the read above keeps it, and its fresh token stays the lease's.
    await requeueLease(env, t, error, t.stop_order ?? null, at, at);
  }
  return expired.results.length;
}

// ---------- read ----------

/** A build_workers row as the API serves it. */
export interface WorkerRow {
  last_seen: string; labels: string | null; owner: string | null; trust: string; packages: string | null; kinds: string | null; agent: string | null; agent_status: string | null; usage: string | null; last_task: string | null; version?: string | null;
  // #277's columns (0042): what the view derives its words from, and strips.
  open_orders?: string | null; order_kinds?: string | null; instance?: string | null; instance_prev?: string | null; instance_since?: string | null; instance_conflict_at?: string | null; instance_other_at?: string | null;
  instance_churn?: number | null; instance_finished?: string | null; crash_loop_since?: string | null; watchdog_exits?: string | null; started_at?: string | null; agent_via?: string | null; site?: string | null;
  restarts_left?: number | null; rollout?: string | null; agent_error?: string | null; agent_error_since?: string | null; agent_probed_at?: string | null; agent_error_class?: string | null;
  drained_at?: string | null; drained_by?: string | null; drain_reason?: string | null; auto_orders?: string | null;
  // #321: a host's registration.
  kind?: string | null; host_id?: string | null;
}

/**
 * What the pool does for a worker whose agent does not answer, in its own
 * words, from the row (orders.ts): nothing for an error a restart cannot
 * help, gave up after its restarts, or nothing said — the rules are on it.
 * Read on every listing, so it reads nothing more.
 */
function poolWaits(w: WorkerRow): string | null {
  if (w.agent_status !== "error" || !w.agent_error_since) return null;
  const cls = (w.agent_error_class ?? null) as (typeof NOTHING_CLASSES)[number] | null;
  if (cls && NOTHING_CLASSES.includes(cls)) return `the pool does nothing for this error (${cls}): a restart cannot help — its own re-check runs every 30 min`;
  if (w.order_kinds === null || w.order_kinds === undefined) return "its image takes no orders: its host's updater replaces it";
  if (cls === "unknown") return "an error the pool does not know: it re-checks it at most once and does not restart on it — a person looks";
  return null;
}

/** The stops that fence a worker's tasks, from its open orders: which task, since when, and the latest it goes back to the queue — one per lease on a host (#334), at most one on a legacy registration. */
export function stoppingsOf(open: string | null): { task: number; order: string; by: string; since: string; until: string }[] {
  return openOrdersOf(open)
    .filter((x) => x.kind === "stop-task" && typeof x.task === "number")
    .map((o) => ({ task: o.task!, order: o.id, by: o.by, since: o.at, until: new Date(Date.parse(o.at) + LEASE_MINUTES * 60000).toISOString() }));
}
/** The stop that fences a legacy registration's one task (its page's word). */
export function stoppingOf(open: string | null): { task: number; order: string; by: string; since: string; until: string } | null {
  return stoppingsOf(open)[0] ?? null;
}

/** The moment a heartbeat must be younger than to count as alive: the one rule (meta.ts's WORKER_ALIVE_MINUTES), as a timestamp. */
export function aliveSince(at = Date.now()): number {
  return at - WORKER_ALIVE_MINUTES * 60000;
}

/**
 * A worker's row as every listing serves it — GET /factory and a person's
 * page (routes/users.ts) — so the tile that counts a person's workers
 * counts what the Workers page lists, by the same words: alive by the one
 * threshold, ready (workerReady), where its image stands, its side. The
 * person's page mapped its own rows before, alive by a ten-minute threshold of
 * its own and without ready or side (2026-09-18).
 */
export function workerView<W extends WorkerRow>(w: W, since: number, pool: RunningVersion) {
  const auto = w.agent_error_since ? autoOf(w.auto_orders, w.agent_error_since, Date.now()) : null;
  let watchdog: { n: number; since: string; last: string; stuck_in: string | null } | null = null;
  try { watchdog = w.watchdog_exits ? JSON.parse(w.watchdog_exits) : null; } catch { watchdog = null; }
  return {
    ...w,
    token_hash: undefined, // the hash of a worker's token is the pool's to compare, nobody's to see
    log_tail: undefined, // the worker's own log is its owner's and the maintainers' (GET /factory/workers/:id/log), not the listing's
    log_at: undefined,
    // #277: the process and the rules' bookkeeping are the pool's; the site is never served (it would say which workers share a host).
    instance: undefined, instance_prev: undefined, instance_since: undefined, instance_conflict_at: undefined, instance_other_at: undefined, instance_churn: undefined, instance_finished: undefined,
    site: undefined, auto_orders: undefined, agent_error_class: undefined, agent_probed_at: undefined, rollout: undefined, order_kinds: undefined, watchdog_exits: undefined,
    drained_at: undefined, drained_by: undefined, drain_reason: undefined, agent_error_since: undefined,
    // Up since: the pool's clock, from the process's first claim; started_at is the worker's own word, for the title.
    up_since: w.instance_since ?? null,
    started_at: w.started_at ?? null,
    // The orders it takes (null: an image from before orders), the ones waiting, and what the pool is doing or not doing about its agent.
    takes_orders: w.order_kinds ? (JSON.parse(w.order_kinds) as string[]) : null,
    open_orders: openOrdersOf(w.open_orders ?? null),
    drained: w.drained_at ? { at: w.drained_at, by: w.drained_by ?? null, reason: w.drain_reason ?? null } : null,
    // A Stop its task that fences its task now (#277): from the open order the row carries, no read. Its task goes back to the queue
    // once this worker has stopped it, and at the latest when the fenced lease ends — nothing renews it after the order.
    stopping: stoppingOf(w.open_orders ?? null),
    // A host's (#334): every lease a Stop fences now.
    ...(w.kind === "host" ? { stoppings: stoppingsOf(w.open_orders ?? null) } : {}),
    not_ready_since: w.agent_status === "error" ? w.agent_error_since ?? null : null,
    pool_gave_up: auto?.gave_up ?? null,
    pool_waits: poolWaits(w),
    two_processes_since: w.instance_conflict_at ?? null,
    restarts_left: w.restarts_left ?? null,
    crash_loop_since: w.crash_loop_since ?? null,
    watchdog: watchdog && Date.now() - Date.parse(watchdog.since) < 24 * 3600e3 ? watchdog : null,
    agent_via: w.agent_via ?? null,
    // What rolls its set out (#277, part 3): one word, and the pool's line for it — the report itself stays the pool's.
    // A host's registration (#321) is rolled out by its host's agent: the `host` word.
    set_rollout: w.kind === "host" ? HOST_ROLLOUT : setRollout(rolloutOf(w.rollout ?? null)),
    set_line: w.kind === "host" ? HOST_SET_LINE : setLine(rolloutOf(w.rollout ?? null), w.version ?? null, w.trust),
    labels: w.labels ? JSON.parse(w.labels) : null,
    packages: w.packages ? JSON.parse(w.packages) : null,
    alive: Date.parse(w.last_seen) > since,
    // Ready for what it declares: alive, and its agent answered when the work needs one (workerReady).
    ready: workerReady(w, since),
    // Where its image stands against the pool's release (update.ts): behind past the grace, it is handed nothing.
    update: updateState(w.version, pool),
    kinds: w.kinds ? JSON.parse(w.kinds) : null,
    // What the machine uses (the worker's own average, with the claim) and the last task it finished (with the completion).
    usage: w.usage ? JSON.parse(w.usage) : null,
    last_task: w.last_task ? JSON.parse(w.last_task) : null,
    // omarchy: runs for the project (trusted; owner NULL is an old hosted registration) · community: a contributor's
    side: w.trust === "project" || w.owner === null ? "omarchy" : "community",
  };
}

/** A JSON column (a task's params, its result) as the object it holds; null when empty or not JSON, so a reader never parses text of its own. */
function parseJson(text: string | null): unknown {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/**
 * GET /factory — the workers and the queue. `?live=1` is the read a page
 * polls for what is running now (the Factory's workers card, #246): the
 * tasks in flight only (queued or leased), found through the queue's
 * status index, and no counts — the whole listing reads every task twice
 * (the counts, then an order no index gives), about 2 000 rows a miss in
 * production, the live read the queue's few rows.
 */
export async function handleFactory(env: Env, url?: URL): Promise<Response> {
  const limit = Math.min(200, Math.max(10, Number(url?.searchParams.get("limit") ?? 60) || 60));
  const live = url?.searchParams.get("live") === "1";
  const counts = live ? { results: [] } : await env.DB.prepare("SELECT status, arch, COUNT(*) AS n FROM build_tasks GROUP BY status, arch").all();
  const alive = aliveSince();
  // Every worker belongs to someone: the project (trust project, granted by
  // a maintainer) or a contributor.
  const workers = await env.DB.prepare(
    "SELECT * FROM build_workers WHERE revoked_at IS NULL ORDER BY (last_seen > ?) DESC, last_seen DESC LIMIT 200",
  )
    .bind(new Date(alive).toISOString())
    .all<WorkerRow>();
  const tasks = await env.DB.prepare(`SELECT * FROM build_tasks ${live ? "WHERE status IN ('leased', 'queued') " : ""}ORDER BY CASE status WHEN 'leased' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, id DESC LIMIT ?`).bind(limit).all<TaskRow>();
  const pool = running(env);
  return json(
    {
      generated_at: now(),
      lease_minutes: LEASE_MINUTES,
      limit,
      counts: counts.results,
      // The release the workers are compared with, and when it was deployed: Status says which went silent since (#277).
      pool: { version: pool.version, deployed_at: pool.deployed_at },
      workers: workers.results.map((w) => workerView(w, alive, pool)),
      // A task's params and result are JSON here as they are on the task's own page (handleTask): one shape for a task, whoever reads it.
      // A host lease's claim_id is its replay key and lease_gen its token's generation (#334): the pool's, never a page's.
      tasks: tasks.results.map((t) => ({ ...t, log_tail: undefined, claim_id: undefined, lease_gen: undefined, params: parseJson(t.params), result: parseJson(t.result) })),
    },
    200,
    { "cache-control": "public, max-age=10" },
  );
}

/**
 * Workers from before registration (no token of their own: the retired
 * shared secret's ephemeral runners and hosts) can never claim again; a day
 * after their last report they are forgotten. The journal keeps their builds.
 * A host's registration (#321) has no token until its agent fetches one, and
 * is never one of them.
 */
export async function pruneWorkers(env: Env): Promise<number> {
  const res = await env.DB.prepare("DELETE FROM build_workers WHERE token_hash IS NULL AND host_id IS NULL AND last_seen < ?")
    .bind(new Date(Date.now() - 86400000).toISOString())
    .run();
  return res.meta.changes ?? 0;
}

/**
 * Every (name, arch, version) the factory has a task for, with the latest
 * status. The enqueue job reconciles the recipes on main against this. A
 * dry run is no build of the version (#284): listed, a maintainer's sizing
 * run of a recipe on main would keep the enqueue job from ever queuing the
 * build that publishes it.
 */
export const BUILT_SQL = `SELECT name, arch, version, status, pkgbuild_ref, id FROM build_tasks t
      WHERE kind = 'build' AND status != 'cancelled' AND NOT ${dryRun("t")} AND id = (SELECT MAX(id) FROM build_tasks u WHERE u.kind = 'build' AND u.name = t.name AND u.arch = t.arch AND u.version IS t.version AND u.status != 'cancelled' AND NOT ${dryRun("u")})
      ORDER BY name, arch, id`;
export async function handleBuilt(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(BUILT_SQL).all();
  return json({ built: rows.results }, 200, { "cache-control": "no-store" });
}

/**
 * One task, whole — what a build's page shows and what an agent reads in
 * one call: the row with the log's tail it kept (a pool job has no other
 * log), the worker that held it and its agent, what it came from and what came of
 * it (a contributor's build → its audit, its trial, the project's builds
 * from it; a project build → the contributor's task it answers, its
 * publish job), the decision on the record with the rings the package is
 * in today, the package's registration, and every object in its staging
 * space (the text ones public). The related tasks share the name and the
 * architecture, so each lookup walks the (name, arch) index, not the table.
 */
export async function handleTask(id: number, env: Env): Promise<Response> {
  const task = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<TaskRow>();
  if (!task) return json({ error: "no such task" }, 404);
  const params = task.params ? (JSON.parse(task.params) as Record<string, unknown>) : {};
  const rel = (kind: string, key: string, of: number) =>
    env.DB.prepare(`SELECT id, kind, status, error, result, lease_owner, started_at, finished_at, duration_ms FROM build_tasks WHERE name = ? AND kind = ? AND json_extract(params, '$.${key}') = ? ORDER BY id DESC LIMIT 5`)
      .bind(task.name, kind, of)
      .all<{ id: number; kind: string; status: string; error: string | null; result: string | null; lease_owner: string | null; started_at: string | null; finished_at: string | null; duration_ms: number | null }>();
  const parse = (r: { result: string | null }) => parseJson(r.result);
  const brief = (r: { id: number; kind: string; status: string; error: string | null; result: string | null; lease_owner: string | null; started_at: string | null; finished_at: string | null; duration_ms: number | null }) => ({ id: r.id, kind: r.kind, status: r.status, error: r.error, result: parse(r), worker: r.lease_owner, started_at: r.started_at, finished_at: r.finished_at, duration_ms: r.duration_ms });
  const isBuild = task.kind === "build";
  const from = typeof params.review === "number" ? params.review : typeof params.task === "number" ? params.task : null;
  const [worker, fromRow, audits, trials, projectBuilds, publishes, approval, pkg, objects, stop] = await Promise.all([
    task.lease_owner ? env.DB.prepare("SELECT id, owner, trust, trusted_by, agent, labels, hostname, version FROM build_workers WHERE id = ?").bind(task.lease_owner).first<{ id: string; owner: string | null; trust: string; trusted_by: string | null; agent: string | null; labels: string | null; hostname: string | null; version: string | null }>() : null,
    from ? env.DB.prepare("SELECT id, kind, status, owner, trust, version, finished_at FROM build_tasks WHERE id = ?").bind(from).first() : null,
    isBuild ? rel("audit", "task", task.id) : null,
    isBuild ? rel("trial", "task", task.id) : null,
    isBuild && task.trust === "community" ? rel("build", "review", task.id) : null,
    isBuild ? rel("publish", "task", task.id) : null,
    isBuild
      ? env.DB.prepare(
          `SELECT a.id, a.task_id, a.decision, a.by, a.note, a.rebuild_task, a.created_at, a.withdrawn_at, a.withdrawn_by, a.withdrawn_reason, r.status AS rebuild_status, r.result_filename AS rebuild_result, COALESCE(v.changes, 0) = 1 AS changes
             FROM approvals a LEFT JOIN build_tasks r ON r.id = a.rebuild_task LEFT JOIN reviews v ON v.id = a.review_id WHERE a.task_id = ? OR a.rebuild_task = ? ORDER BY a.id DESC LIMIT 1`,
        ).bind(task.id, task.id).first()
      : null,
    env.DB.prepare("SELECT name, owner, url, status, category, request_id, description, license, project, targets, created_at FROM factory_packages WHERE name = ?").bind(task.name).first<Record<string, unknown>>(),
    env.DB.prepare("SELECT key, size, uploaded_at FROM staging_objects WHERE task_id = ? ORDER BY key").bind(task.id).all<{ key: string; size: number; uploaded_at: string }>(),
    // A Stop its task that fences this lease (#277): who and when, by the order's key — the build's page says when its worker was told.
    task.stop_order ? env.DB.prepare("SELECT id, issued_by, issued_at FROM worker_orders WHERE id = ?").bind(task.stop_order).first<{ id: string; issued_by: string; issued_at: string }>() : null,
  ]);
  // The chain this task is in — the contributor's build, the project's, the audit, the trial, the decision — and its score (score.ts), from the package's story.
  let chain: Chain | null = null, request: ReturnType<typeof requestView> = null;
  if (isBuild || task.kind === "audit" || task.kind === "trial" || task.kind === "publish") {
    const story = await storyRows(env, task.name);
    await placeInQueue(env, story.tasks);
    chain = chainOf(chains(story.tasks, story.approvals, story.pkg, story.request), task.id);
    request = requestView(env, story.pkg, story.request, story.tasks);
  }
  // The rings that serve this package today, from the factory's rows in each ring.
  const rings = isBuild
    ? sortRings((await env.DB.prepare(`SELECT rp.ring FROM packages p JOIN ring_packages rp ON rp.package_id = p.id AND rp.ring IN (${ringsSql(RINGS)}) WHERE p.source = 'factory' AND p.name = ? AND p.repo_arch = ?`).bind(task.name, task.arch).all<{ ring: string }>()).results.map((r) => r.ring))
    : [];
  return json(
    {
      task: { ...task, claim_id: undefined, lease_gen: undefined, params, result: parse(task) },
      // Its lease fenced by a Stop its task (the row's stop_order, spread above): told when, back in the queue by when at the latest — the
      // fenced lease's own end, which nothing renews (the order's issue plus a lease only bounds it): what the worker's page and the stop's dialog say.
      stopping: stop && task.status === "leased" ? { order: stop.id, by: stop.issued_by, since: stop.issued_at, until: task.lease_expires_at ?? new Date(Date.parse(stop.issued_at) + LEASE_MINUTES * 60000).toISOString() } : null,
      worker: worker ? { ...worker, labels: worker.labels ? JSON.parse(worker.labels) : null } : null,
      from: fromRow,
      audit: audits?.results.map(brief) ?? [],
      trial: trials?.results.map(brief) ?? [],
      project_builds: projectBuilds?.results.map(brief) ?? [],
      publish: publishes?.results.map(brief) ?? [],
      // The approval on this build, with `standing` (approved, not withdrawn — stands()) as every approval row the server hands out carries it: the page reads the word, it does not derive it.
      approval: approval ? { ...approval, standing: stands(approval as { decision: string; withdrawn_at: string | null }), changes: (approval as { changes?: number }).changes === 1 } : null,
      chain,
      score: chain?.score ?? null,
      rings,
      // The package this is a build of, with where each of its architectures stands (targets.ts).
      package: pkg ? { ...pkg, targets: parseTargets(pkg.targets) } : null,
      request,
      evidence: objects.results.map((o) => {
        const name = o.key.split("/").pop() ?? o.key;
        return { name, size: o.size, uploaded_at: o.uploaded_at, url: `/api/v1/factory/tasks/${task.id}/artifacts/${encodeURIComponent(name)}`, public: isTextEvidence(name) };
      }),
    },
    200,
    { "cache-control": "public, max-age=30" },
  );
}
