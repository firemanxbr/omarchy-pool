import { json, type Env } from "../index";
import { writeAttestation } from "./seal";
import { isRepoArch } from "../r2";
import type { WorkerIdentity } from "./contributors";
import { issueJobToken, scopesFor, type JobClaims } from "../jobtoken";
import { isCategory } from "../categories";
import { recordEvidence, vetSummary } from "../record";
import { isTextEvidence, reclaimStagingPackages, STAGING_QUOTA_BYTES } from "../staging";
import { findLeak } from "../leak";
import { chains, chainOf, storyRows, requestView, type Chain } from "./story";

/**
 * The factory's brain. Cloudflare is the source of truth for package
 * package requests and build tasks; build workers are ephemeral, live anywhere, and
 * *pull* work:
 *
 *   POST /factory/claim                 {arch, hostname?, labels?, version?, kinds?, agent?} → a task with a lease and its job token, or 204
 *   POST /factory/tasks/:id/heartbeat                                  extend the lease (a fresh job token)
 *   POST /factory/tasks/:id/complete    {sha256, filename, version, duration_ms?, log_tail?} · {result, summary} for jobs
 *   POST /factory/tasks/:id/fail        {error, duration_ms?, log_tail?, final?}   → requeued, or failed after max_attempts (at once when final: the recipe's fault, not the worker's)
 * The worker is its registered token (POST /factory/workers); a task's
 * writes use the job token the claim issued.
 *
 * A lease that expires (worker died, build hung) goes back to the queue on
 * the scheduler's next tick. Maintainers (their token) or the enqueue job:
 *
 *   POST /factory/enqueue               {name, arches?, pkgbuild_ref, reason, version?, priority?}
 *   POST /factory/tasks/:id/cancel
 *
 * Read:
 *   GET  /factory                       overview: queue, workers, recent tasks
 */

const LEASE_MINUTES = 30;
const WORKER_ALIVE_MINUTES = 10;

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
  staged_prefix: string | null;
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
  const list = Array.isArray(v) ? v : ["x86_64", "aarch64"];
  return list.filter((a): a is string => typeof a === "string" && isRepoArch(a));
}

/**
 * Who already provides a name in edge. A factory build replaces the same
 * name in the ring, so a package Arch, ALARM or the OPR ship is never built
 * here by accident: it "enters the pool's cycle" as it is. chaotic-aur is the
 * exception — the factory is meant to take its names over.
 */
export async function providedBy(env: Env, name: string): Promise<{ source: string; arch: string; version: string }[]> {
  const rows = await env.DB.prepare(
    `SELECT p.source, p.repo_arch AS arch, p.version FROM ring_packages rp JOIN packages p ON p.id = rp.package_id
      WHERE rp.ring = 'edge' AND p.name = ?`,
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

/** Queue one task per architecture unless an identical one is already queued or running. */
async function enqueue(env: Env, t: { name: string; arches: string[]; pkgbuild_ref: string; reason: string; version?: string | null; priority?: number; publish?: boolean }): Promise<number[]> {
  const ids: number[] = [];
  for (const arch of t.arches) {
    const dup = await env.DB.prepare(
      "SELECT id FROM build_tasks WHERE name = ? AND arch = ? AND pkgbuild_ref = ? AND status IN ('queued', 'leased') LIMIT 1",
    )
      .bind(t.name, arch, t.pkgbuild_ref)
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

export async function handleEnqueue(request: Request, env: Env): Promise<Response> {
  const b = (await request.json()) as { name?: string; arches?: unknown; pkgbuild_ref?: string; reason?: string; version?: string; priority?: number; override?: boolean; publish?: boolean };
  if (!b.name || !b.pkgbuild_ref || !b.reason) return json({ error: "name, pkgbuild_ref and reason are required" }, 400);
  const arches = parseArches(b.arches);
  const { build, skipped } = splitByUpstream(await providedBy(env, b.name), arches, b.override);
  if (!build.length) return nothingToBuild(skipped);
  const tasks = await enqueue(env, { name: b.name, arches: build, pkgbuild_ref: b.pkgbuild_ref, reason: b.reason, version: b.version ?? null, priority: b.priority, publish: b.publish });
  const note = (skipped.length ? `; ${skipped.map((s) => `${s.arch} skipped, ${s.source} ships ${s.version}`).join(", ")}` : "") + (b.publish === false ? "; dry run, nothing will be published" : "");
  await event(env, "enqueue", "ok", `${b.name}${b.version ? " " + b.version : ""}: ${tasks.length} build task(s) queued for ${build.join(", ")} (${b.reason})${note}`, { name: b.name, arches: build, skipped, pkgbuild_ref: b.pkgbuild_ref, reason: b.reason, tasks });
  return json({ tasks, arches: build, skipped }, 201);
}

export async function handleCancelTask(id: number, env: Env): Promise<Response> {
  const res = await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued', 'leased')").bind(now(), id).run();
  if (!res.meta.changes) return json({ error: "task is not queued or leased" }, 409);
  // What a leased worker had already staged: the lease is void, its next PUT is refused, the packages go.
  await reclaimStagingPackages(env, [id]);
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

async function touchWorker(env: Env, w: { worker: string; arch: string; hostname?: string; labels?: unknown; version?: string; mode?: string; agent?: string | null; kinds?: string[]; probe?: AgentReport; usage?: Usage | null }, currentTask: number | null): Promise<void> {
  // The agent is what the worker says it runs ("<provider>/<model>"): a
  // worker that reports none ("" or null) clears it, one that says nothing
  // (an older client) keeps what it last reported. The probe's answer
  // travels the same way.
  // "claude-code/claude-sonnet-5" has a hyphen in the provider: the older
  // pattern refused it, and every Studio worker showed no agent (2026-09-15).
  const agent = w.agent === undefined ? undefined : typeof w.agent === "string" && /^[a-z0-9-]+\/[A-Za-z0-9._:-]{1,60}$/.test(w.agent) ? w.agent : null;
  await env.DB.prepare(
    `INSERT INTO build_workers (id, arch, hostname, labels, version, last_seen, current_task, agent, kinds, agent_status, agent_error, agent_checked_at, usage, usage_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET arch = excluded.arch, hostname = COALESCE(excluded.hostname, hostname), labels = COALESCE(excluded.labels, labels),
       version = COALESCE(excluded.version, version), last_seen = excluded.last_seen, current_task = excluded.current_task, mode = COALESCE(?, mode),
       agent = CASE WHEN ? THEN excluded.agent ELSE agent END, kinds = COALESCE(excluded.kinds, kinds),
       agent_status = CASE WHEN ? THEN excluded.agent_status ELSE agent_status END, agent_error = CASE WHEN ? THEN excluded.agent_error ELSE agent_error END,
       agent_checked_at = CASE WHEN ? THEN excluded.agent_checked_at ELSE agent_checked_at END,
       usage = COALESCE(excluded.usage, usage), usage_at = CASE WHEN excluded.usage IS NULL THEN usage_at ELSE excluded.usage_at END`,
  )
    .bind(
      w.worker, w.arch, w.hostname ?? null, w.labels ? JSON.stringify(w.labels) : null, w.version ?? null, now(), currentTask, agent ?? null,
      w.kinds ? JSON.stringify(w.kinds) : null, w.probe?.status ?? null, w.probe?.error ?? null, w.probe?.checked_at ?? null,
      w.usage ? JSON.stringify(w.usage) : null, w.usage ? now() : null,
      w.mode ?? null, agent === undefined ? 0 : 1, w.probe === undefined ? 0 : 1, w.probe === undefined ? 0 : 1, w.probe === undefined ? 0 : 1,
    )
    .run();
}

/**
 * The worker row after a task: the lease is over, the counter moves, and the
 * row remembers what it just did — the Workers page reads the last task
 * there, one row per worker, not from build_tasks.
 */
async function workerFinished(env: Env, who: string, task: TaskRow, status: "done" | "staged" | "failed", version?: string | null): Promise<void> {
  const last = JSON.stringify({ id: task.id, kind: task.kind, name: task.name, version: version ?? task.version ?? null, status, at: now() });
  await env.DB.prepare(`UPDATE build_workers SET last_seen = ?, current_task = NULL, ${status === "failed" ? "builds_failed = builds_failed + 1" : "builds_done = builds_done + 1"}, last_task = ? WHERE id = ?`)
    .bind(now(), last, who)
    .run();
}

/** The work that needs an agent that answers: a draft (the PKGBUILD is the agent's), the project's review build (its recipe is), and an audit (the second agent). */
export const AGENT_SCOPE = "(kind = 'audit' OR (kind = 'build' AND (pkgbuild_ref LIKE 'draft:%' OR pkgbuild_ref LIKE 'review:%')))";

/** A worker is ready for what it declares when it is alive and, if that includes agent work, its agent answered last time. */
export function workerReady(w: { last_seen: string; kinds: string | null; agent: string | null; agent_status: string | null; trust: string }, aliveSince: number): boolean {
  if (Date.parse(w.last_seen) <= aliveSince) return false;
  const kinds: string[] = w.kinds ? (JSON.parse(w.kinds) as string[]) : w.trust === "project" ? [] : ["build"];
  const needsAgent = kinds.includes("audit") || (kinds.includes("build") && w.trust !== "project");
  return !needsAgent || w.agent_status === "ok";
}

const ALL_KINDS = ["build", "sync", "promote", "rollback", "render", "health", "security", "metrics", "gc", "enqueue", "audit", "verify", "relayout", "publish", "trial"];
/** Jobs any architecture can run: they read the index or the staging area, not packages of one arch. */
const ANY_ARCH_KINDS = "'metrics', 'gc', 'security', 'promote', 'audit', 'verify', 'relayout'";

export async function handleClaim(request: Request, env: Env, actor: Actor): Promise<Response> {
  const b = (await request.json()) as { arch?: string; hostname?: string; labels?: unknown; version?: string; kinds?: unknown; shared?: unknown; agent?: unknown; agent_status?: unknown; agent_error?: unknown; agent_checked_at?: unknown; usage?: unknown };
  if (!b.arch || !isRepoArch(b.arch)) return json({ error: "arch (x86_64|aarch64) is required" }, 400);
  if (actor.kind === "job") return json({ error: "a job token cannot claim; use the worker token" }, 403);
  const probe = agentReport(b);
  const usage = usageReport(b.usage);
  // A worker is its registration: id, owner, trust and what it may build.
  const workerId = actor.w.id;
  if (actor.w.arch !== b.arch) return json({ error: `this worker is registered for ${actor.w.arch}` }, 400);
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
  const kinds = trust === "project" ? wanted : ["build"];
  // Donating a worker to everyone's builds is a maintainer's call: a
  // contributor's worker builds its owner's packages, --shared or not
  // (docs/GOVERNANCE.md, *Workers, compute and agents*).
  const owner = actor.w.owner ? await env.DB.prepare("SELECT role FROM contributors WHERE login = ?").bind(actor.w.owner).first<{ role: string }>() : null;
  const shared = trust === "community" && b.shared === true && owner?.role === "maintainer";
  let scope = `kind IN (SELECT value FROM json_each(?))`;
  const binds: unknown[] = [JSON.stringify(kinds)];
  // Agent work goes only to a worker whose agent answered the probe: a
  // draft or an audit on a worker with no agent, or a failing one, is a
  // failed task an hour later.
  if (probe?.status !== "ok") scope += ` AND NOT ${AGENT_SCOPE}`;
  if (trust === "project") {
    scope += ` AND (kind != 'build' OR trust = 'project')`;
  } else {
    // The owner's worker takes the owner's tasks; a donated worker takes
    // anyone's once shared_after has passed (at once when it is unset).
    scope += ` AND trust = 'community'`;
    if (shared) {
      scope += ` AND (owner = ? OR shared_after IS NULL OR shared_after <= ?)`;
      binds.push(actor.w.owner ?? "-", now());
    } else {
      scope += ` AND owner = ?`;
      binds.push(actor.w.owner ?? "-");
    }
  }
  // One statement claims the next queued task of this architecture: D1
  // serialises writes, so two workers never get the same one.
  const task = await env.DB.prepare(
    `UPDATE build_tasks SET status = 'leased', lease_owner = ?, lease_expires_at = ?, started_at = ?, attempts = attempts + 1, error = NULL
      WHERE id = (SELECT id FROM build_tasks WHERE status = 'queued' AND (arch = ? OR kind IN (${ANY_ARCH_KINDS})) AND ${scope} ORDER BY priority, id LIMIT 1) AND status = 'queued'
      RETURNING *`,
  )
    .bind(workerId, plusMinutes(LEASE_MINUTES), now(), b.arch, ...binds)
    .first<TaskRow>();
  await touchWorker(env, { worker: workerId, arch: b.arch, hostname: b.hostname, labels: b.labels, version: b.version, mode: trust === "community" ? (shared ? "shared" : "dedicated") : undefined, agent: b.agent === undefined ? undefined : typeof b.agent === "string" ? b.agent : null, kinds, probe, usage }, task?.id ?? null);
  if (!task) return new Response(null, { status: 204 });
  if (task.trust === "community" && task.kind === "build") {
    await env.DB.prepare("UPDATE factory_packages SET status = 'building', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`building on ${workerId} (${task.arch})`, task.name).run();
  }
  // The job's own credential: exactly the routes this task needs, until the lease ends.
  const params = task.params ? (JSON.parse(task.params) as Record<string, unknown>) : {};
  const expires = Math.floor(Date.now() / 1000) + LEASE_MINUTES * 60;
  const token = await issueJobToken(env, { t: task.id, k: task.kind, s: scopesFor(task.kind, task.id, task.trust, params), e: expires, w: workerId });
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
    pkgbuild_path: task.kind === "build" && !(task.pkgbuild_ref.includes(":") || task.pkgbuild_ref.startsWith("draft")) ? `factory/pkgbuilds/${task.name}` : null,
    // Where a staged result goes — a contributor's build, or the project's review build: PUT these back with the job token.
    upload: task.trust === "community" || params.review !== undefined ? `/api/v1/factory/tasks/${task.id}/artifacts/<filename>` : null,
    staging,
  });
}

async function owned(env: Env, id: number, actor: Actor): Promise<TaskRow | Response> {
  if (actor.kind === "job" && !actor.job.s.includes(`task:${id}`)) return json({ error: `this job token is for task ${actor.job.t}` }, 403);
  const who = actor.kind === "worker" ? actor.w.id : actor.job.w;
  const task = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<TaskRow>();
  if (!task) return json({ error: "no such task" }, 404);
  if (task.status !== "leased" || task.lease_owner !== who) return json({ error: `task ${id} is ${task.status}${task.lease_owner ? " by " + task.lease_owner : ""}; the lease is not yours` }, 409);
  return task;
}

function workerName(actor: Actor): string {
  return actor.kind === "worker" ? actor.w.id : actor.job.w;
}

export async function handleHeartbeat(id: number, env: Env, actor: Actor): Promise<Response> {
  const task = await owned(env, id, actor);
  if (task instanceof Response) return task;
  const who = workerName(actor);
  const until = plusMinutes(LEASE_MINUTES);
  await env.DB.prepare("UPDATE build_tasks SET lease_expires_at = ? WHERE id = ?").bind(until, id).run();
  await env.DB.prepare("UPDATE build_workers SET last_seen = ?, current_task = ? WHERE id = ?").bind(now(), id, who).run();
  // The lease moved; so does the job's credential.
  const params = task.params ? (JSON.parse(task.params) as Record<string, unknown>) : {};
  const expires = Math.floor(Date.now() / 1000) + LEASE_MINUTES * 60;
  const token = await issueJobToken(env, { t: task.id, k: task.kind, s: scopesFor(task.kind, task.id, task.trust, params), e: expires, w: who });
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
  const b = (await request.json()) as { sha256?: string; filename?: string; version?: string; duration_ms?: number; log_tail?: string; result?: unknown; summary?: string };
  const task = await owned(env, id, actor);
  if (task instanceof Response) return task;
  const who = workerName(actor);
  const tail = (await withheld(env, id, "log_tail", b.log_tail)).slice(-4000);
  if (task.kind !== "build") {
    // A pool job: what it did is its result; the journal gets one line.
    // The lease ends with the status; who held it stays on the row — the
    // journal, the seal and the load per worker read it later.
    await env.DB.prepare("UPDATE build_tasks SET status = 'done', finished_at = ?, duration_ms = ?, log_tail = ?, result = ?, lease_expires_at = NULL WHERE id = ?")
      .bind(now(), b.duration_ms ?? null, tail, b.result ? JSON.stringify(b.result) : null, id)
      .run();
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
    // and the load per worker read it later.
    await env.DB.prepare(
      "UPDATE build_tasks SET status = 'staged', finished_at = ?, result_sha256 = ?, result_filename = ?, result_version = ?, version = COALESCE(version, ?), duration_ms = ?, log_tail = ?, staged_prefix = ?, result = ?, lease_expires_at = NULL WHERE id = ?",
    )
      .bind(now(), b.sha256, b.filename, b.version ?? null, b.version ?? null, b.duration_ms ?? null, tail, prefix, vet ? JSON.stringify({ vet }) : null, id)
      .run();
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
  await env.DB.prepare(
    "UPDATE build_tasks SET status = 'done', finished_at = ?, result_sha256 = ?, result_filename = ?, result_version = ?, duration_ms = ?, log_tail = ?, lease_expires_at = NULL WHERE id = ?",
  )
    .bind(now(), indexed.sha256, b.filename, b.version ?? null, b.duration_ms ?? null, tail, id)
    .run();
  await workerFinished(env, who, task, "done", b.version);
  if (task.publish !== 0) {
    // What users get. A contributor's registration of this name is now
    // published, and the approval that led here keeps the task — the seal
    // and the track record follow that link (docs/GOVERNANCE.md).
    const answered = await env.DB.prepare("SELECT id FROM approvals WHERE name = ? AND arch = ? AND decision = 'approved' AND rebuild_task IS NULL ORDER BY id DESC LIMIT 1").bind(task.name, task.arch).first<{ id: number }>();
    await env.DB.batch([
      env.DB.prepare("UPDATE factory_packages SET status = 'published', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
        .bind(`${b.version ?? ""} for ${task.arch} built by the project (task ${id}), signed, in edge`, task.name),
      ...(answered ? [env.DB.prepare("UPDATE approvals SET rebuild_task = ? WHERE id = ?").bind(id, answered.id)] : []),
    ]);
  }
  await event(env, "build", "ok", `${task.name} ${b.version ?? ""} built for ${task.arch} by ${who}${b.duration_ms ? " in " + Math.round(b.duration_ms / 60000) + " min" : ""}${task.publish === 0 ? " (dry run, not published)" : ""}`, { task: id, arch: task.arch, sha256: indexed.sha256, filename: b.filename, worker: who, attempts: task.attempts, duration_ms: b.duration_ms ?? null });
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
  const b = (await request.json()) as { error?: string; duration_ms?: number; log_tail?: string; final?: boolean };
  const task = await owned(env, id, actor);
  if (task instanceof Response) return task;
  const who = workerName(actor);
  const tail = (await withheld(env, id, "log_tail", b.log_tail)).slice(-4000);
  const error = (await withheld(env, id, "error", b.error ?? "build failed")).slice(0, 2000);
  // Retries are for the infrastructure (a download, a mirror, a container
  // killed), not for the recipe: a PKGBUILD that failed to build fails the
  // same way three times, each in a fresh container — the first
  // contributor's day, 2026-09-15, was 84 failed attempts for 28 tasks. The
  // worker says which is which (`final`); the contributor fixes and queues
  // a new build.
  const exhausted = b.final === true || task.attempts >= task.max_attempts;
  // What the worker uploaded before giving up — the log, the PKGBUILD, the
  // gate's verdict — is evidence too: a failed attempt is on the record.
  const review = task.kind === "build" && task.params ? (JSON.parse(task.params) as { review?: number }).review : undefined;
  if (task.kind === "build" && (task.trust === "community" ? task.owner : review !== undefined)) {
    await recordEvidence(env, task.name, await requestOf(env, task.name), id, `staging/${review !== undefined ? "@project" : task.owner}/${task.name}/${task.id}/`, ["PKGBUILD", "build.log", "vet.json", "tests.log"]);
  }
  // A requeued task goes behind its peers (priority + 10) so one broken
  // PKGBUILD does not hold the queue.
  await env.DB.prepare(
    `UPDATE build_tasks SET status = ?, finished_at = ?, error = ?, log_tail = ?, duration_ms = ?, lease_owner = ?, lease_expires_at = NULL, priority = priority + 10 WHERE id = ?`,
  )
    .bind(exhausted ? "failed" : "queued", exhausted ? now() : null, error, tail, b.duration_ms ?? null, exhausted ? task.lease_owner : null, id)
    .run();
  await workerFinished(env, who, task, "failed");
  // A build that failed for good may have staged its package before the
  // gate or the quota stopped it: the log and the recipe stay, the package goes.
  if (exhausted && task.kind === "build") await reclaimStagingPackages(env, [id]);
  if (task.trust === "community" && exhausted) {
    await env.DB.prepare("UPDATE factory_packages SET status = 'registered', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`build failed on ${who}: ${error.slice(0, 160)}`, task.name).run();
  } else if (review !== undefined && exhausted) {
    // The project's build failed: the contributor's stays staged, and the review row says what the project ran into.
    await env.DB.prepare("UPDATE factory_packages SET detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(`the project's build (task ${id}) failed on ${who}: ${error.slice(0, 160)}`, task.name).run();
  }
  await event(env, "build", exhausted ? "error" : "warn", `${task.name} for ${task.arch} failed on ${who} (attempt ${task.attempts}/${task.max_attempts})${b.final ? " — the recipe's, not retried" : exhausted ? " — giving up" : " — back in the queue"}: ${error.slice(0, 120)}`, { task: id, arch: task.arch, worker: who, attempts: task.attempts, exhausted, final: b.final === true });
  return json({ task: id, status: exhausted ? "failed" : "queued", attempts: task.attempts });
}

/** Leases that expired go back to the queue (or fail when out of attempts). Called by the scheduler. */
export async function requeueExpiredLeases(env: Env): Promise<number> {
  const expired = await env.DB.prepare("SELECT id, name, arch, lease_owner, attempts, max_attempts, trust, kind FROM build_tasks WHERE status = 'leased' AND lease_expires_at < ?")
    .bind(now())
    .all<{ id: number; name: string; arch: string; lease_owner: string; attempts: number; max_attempts: number; trust: string; kind: string }>();
  for (const t of expired.results) {
    const exhausted = t.attempts >= t.max_attempts;
    const error = `lease by ${t.lease_owner} expired`;
    await env.DB.prepare("UPDATE build_tasks SET status = ?, finished_at = ?, error = ?, lease_owner = ?, lease_expires_at = NULL, priority = priority + 10 WHERE id = ? AND status = 'leased'")
      .bind(exhausted ? "failed" : "queued", exhausted ? now() : null, error, exhausted ? t.lease_owner : null, t.id)
      .run();
    await env.DB.prepare("UPDATE build_workers SET current_task = NULL WHERE id = ? AND current_task = ?").bind(t.lease_owner, t.id).run();
    // The worker that died mid-upload leaves the package it landed behind
    // — 2026-09-16, four of them at 720 MB. Out of attempts, it goes; queued
    // again, the next lease writes over the same key and it counts once.
    if (exhausted && t.kind === "build") await reclaimStagingPackages(env, [t.id]);
    // The package follows its task, as it does when the worker reports the
    // failure itself: back to waiting (queued again) or to registered with
    // the reason. Left at "building", obsidian showed a build in progress
    // for hours after its third lease had died (2026-09-15).
    if (t.trust === "community" && t.kind === "build") {
      await env.DB.prepare("UPDATE factory_packages SET status = ?, detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status = 'building'")
        .bind(exhausted ? "registered" : "waiting", exhausted ? `build failed on ${t.lease_owner}: ${error} (the worker stopped mid-build?)` : `${error}; queued again`, t.name)
        .run();
    }
    await event(env, "build", exhausted ? "error" : "warn", `${t.name} for ${t.arch}: ${error}${exhausted ? " — giving up" : " — back in the queue"}`, { task: t.id, worker: t.lease_owner, attempts: t.attempts });
  }
  return expired.results.length;
}

// ---------- read ----------

export async function handleFactory(env: Env, url?: URL): Promise<Response> {
  const limit = Math.min(200, Math.max(10, Number(url?.searchParams.get("limit") ?? 60) || 60));
  const counts = await env.DB.prepare("SELECT status, arch, COUNT(*) AS n FROM build_tasks GROUP BY status, arch").all();
  // Every worker belongs to someone: the project (trust project, granted by
  // a maintainer) or a contributor.
  const workers = await env.DB.prepare(
    "SELECT * FROM build_workers WHERE revoked_at IS NULL ORDER BY (last_seen > ?) DESC, last_seen DESC LIMIT 200",
  )
    .bind(new Date(Date.now() - WORKER_ALIVE_MINUTES * 60000).toISOString())
    .all<{ last_seen: string; labels: string | null; owner: string | null; trust: string; packages: string | null; kinds: string | null; agent: string | null; agent_status: string | null; usage: string | null; last_task: string | null }>();
  const tasks = await env.DB.prepare("SELECT * FROM build_tasks ORDER BY CASE status WHEN 'leased' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, id DESC LIMIT ?").bind(limit).all<TaskRow>();
  const alive = Date.now() - WORKER_ALIVE_MINUTES * 60000;
  return json(
    {
      generated_at: now(),
      lease_minutes: LEASE_MINUTES,
      limit,
      counts: counts.results,
      workers: workers.results.map((w) => ({
        ...w,
        token_hash: undefined, // the hash of a worker's token is the pool's to compare, nobody's to see
        labels: w.labels ? JSON.parse(w.labels) : null,
        packages: w.packages ? JSON.parse(w.packages) : null,
        alive: Date.parse(w.last_seen) > alive,
        // Ready for what it declares: alive, and its agent answered when the work needs one (workerReady).
        ready: workerReady(w, alive),
        kinds: w.kinds ? JSON.parse(w.kinds) : null,
        // What the machine uses (the worker's own average, with the claim) and the last task it finished (with the completion).
        usage: w.usage ? JSON.parse(w.usage) : null,
        last_task: w.last_task ? JSON.parse(w.last_task) : null,
        // omarchy: runs for the project (trusted; owner NULL is an old hosted registration) · community: a contributor's
        side: w.trust === "project" || w.owner === null ? "omarchy" : "community",
      })),
      tasks: tasks.results.map((t) => ({ ...t, log_tail: undefined })),
    },
    200,
    { "cache-control": "public, max-age=10" },
  );
}

/**
 * Workers from before registration (no token of their own: the retired
 * shared secret's ephemeral runners and hosts) can never claim again; a day
 * after their last report they are forgotten. The journal keeps their builds.
 */
export async function pruneWorkers(env: Env): Promise<number> {
  const res = await env.DB.prepare("DELETE FROM build_workers WHERE token_hash IS NULL AND last_seen < ?")
    .bind(new Date(Date.now() - 86400000).toISOString())
    .run();
  return res.meta.changes ?? 0;
}

/**
 * Every (name, arch, version) the factory has a task for, with the latest
 * status. The enqueue workflow reconciles the PKGBUILDs on main against
 * this, so a merge nobody's push event announced (a bot's auto-merge, a
 * deploy race) is still built within the hour.
 */
export async function handleBuilt(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT name, arch, version, status, pkgbuild_ref, id FROM build_tasks t
      WHERE kind = 'build' AND status != 'cancelled' AND id = (SELECT MAX(id) FROM build_tasks u WHERE u.kind = 'build' AND u.name = t.name AND u.arch = t.arch AND u.version IS t.version AND u.status != 'cancelled')
      ORDER BY name, arch, id`,
  ).all();
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
  const parse = (r: { result: string | null }) => { try { return r.result ? JSON.parse(r.result) : null; } catch { return null; } };
  const brief = (r: { id: number; kind: string; status: string; error: string | null; result: string | null; lease_owner: string | null; started_at: string | null; finished_at: string | null; duration_ms: number | null }) => ({ id: r.id, kind: r.kind, status: r.status, error: r.error, result: parse(r), worker: r.lease_owner, started_at: r.started_at, finished_at: r.finished_at, duration_ms: r.duration_ms });
  const isBuild = task.kind === "build";
  const from = typeof params.review === "number" ? params.review : typeof params.task === "number" ? params.task : null;
  const [worker, fromRow, audits, trials, projectBuilds, publishes, approval, pkg, objects] = await Promise.all([
    task.lease_owner ? env.DB.prepare("SELECT id, owner, trust, trusted_by, agent, labels, hostname, version FROM build_workers WHERE id = ?").bind(task.lease_owner).first<{ id: string; owner: string | null; trust: string; trusted_by: string | null; agent: string | null; labels: string | null; hostname: string | null; version: string | null }>() : null,
    from ? env.DB.prepare("SELECT id, kind, status, owner, trust, version, finished_at FROM build_tasks WHERE id = ?").bind(from).first() : null,
    isBuild ? rel("audit", "task", task.id) : null,
    isBuild ? rel("trial", "task", task.id) : null,
    isBuild && task.trust === "community" ? rel("build", "review", task.id) : null,
    isBuild ? rel("publish", "task", task.id) : null,
    isBuild
      ? env.DB.prepare(
          `SELECT a.id, a.task_id, a.decision, a.by, a.note, a.rebuild_task, a.created_at, a.withdrawn_at, a.withdrawn_by, a.withdrawn_reason, r.status AS rebuild_status, r.result_filename AS rebuild_result
             FROM approvals a LEFT JOIN build_tasks r ON r.id = a.rebuild_task WHERE a.task_id = ? OR a.rebuild_task = ? ORDER BY a.id DESC LIMIT 1`,
        ).bind(task.id, task.id).first()
      : null,
    env.DB.prepare("SELECT name, owner, url, status, category, request_id, description, license, project, created_at FROM factory_packages WHERE name = ?").bind(task.name).first(),
    env.DB.prepare("SELECT key, size, uploaded_at FROM staging_objects WHERE task_id = ? ORDER BY key").bind(task.id).all<{ key: string; size: number; uploaded_at: string }>(),
  ]);
  // The chain this task is in — the contributor's build, the project's, the audit, the trial, the decision — and its score (score.ts), from the package's story.
  let chain: Chain | null = null, request: ReturnType<typeof requestView> = null;
  if (isBuild || task.kind === "audit" || task.kind === "trial" || task.kind === "publish") {
    const story = await storyRows(env, task.name);
    chain = chainOf(chains(story.tasks, story.approvals, story.pkg, story.request), task.id);
    request = requestView(env, story.pkg, story.request);
  }
  // The rings that serve this package today, from the factory's rows in each ring.
  const rings = isBuild
    ? (await env.DB.prepare("SELECT rp.ring FROM packages p JOIN ring_packages rp ON rp.package_id = p.id AND rp.ring IN ('lab', 'edge', 'rc', 'stable') WHERE p.source = 'factory' AND p.name = ? AND p.repo_arch = ?").bind(task.name, task.arch).all<{ ring: string }>()).results.map((r) => r.ring)
    : [];
  const order = ["lab", "edge", "rc", "stable"];
  return json(
    {
      task: { ...task, params, result: parse(task) },
      worker: worker ? { ...worker, labels: worker.labels ? JSON.parse(worker.labels) : null } : null,
      from: fromRow,
      audit: audits?.results.map(brief) ?? [],
      trial: trials?.results.map(brief) ?? [],
      project_builds: projectBuilds?.results.map(brief) ?? [],
      publish: publishes?.results.map(brief) ?? [],
      approval,
      chain,
      score: chain?.score ?? null,
      rings: rings.sort((a, b) => order.indexOf(a) - order.indexOf(b)),
      package: pkg,
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
