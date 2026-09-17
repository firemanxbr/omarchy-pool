import { json, type Env } from "../index";
import { RINGS, ringsSql, sortRings } from "../meta";
import { scoreChain } from "../score";
import { requestChecks } from "../request";
import { contributorOf, isMaintainer, MAINTAINER_DECIDES, SIGN_IN, type Contributor } from "./contributors";
import { reclaimStagingPackages } from "../staging";
import { pullFromRings } from "./blocks";
import { chains, chainOf, storyRows, stands, standsSql, type Approval } from "./story";
export { stands };
import { putRecord, recordUrl } from "../record";

/**
 * Review: what maintainers do with staged builds (docs/GOVERNANCE.md).
 *
 *   GET  /factory/review                    staged builds — the contributors' (evidence) and the project's — with
 *                                           their evidence, the gate and the audit (public, no-store: each row says
 *                                           what the caller may do on it, `can`); `waiting` and `oldest_ms` at the
 *                                           top: how many rows ask for a maintainer's time and the age of the oldest
 *   GET  /factory/tasks/:id/can             what the caller may do on one task — the same `can`, no-store
 *   POST /factory/tasks/:id/build   {note?} a maintainer, never the owner, on a contributor's staged build → the
 *                                           project builds the package again on a review worker with the project's
 *                                           agent: the request and the contributor's evidence as the lesson, its own
 *                                           recipe, the gate, staged like any build (review:<id>)
 *   POST /factory/tasks/:id/approve {note?} a maintainer, never the owner, on the *project's* staged build → the
 *                                           decision on the record and a publish job: the project's package into edge
 *   POST /factory/tasks/:id/reject  {note}  a maintainer, never the owner, either kind of staged build → back to registered
 *                                           with the reason
 *   POST /factory/tasks/:id/withdraw {note} any maintainer takes a standing approval back: the package leaves the rings
 *   GET  /factory/approvals                 the record (public); `standing` on every row — an approval not withdrawn
 */

interface Staged {
  id: number;
  name: string;
  arch: string;
  version: string | null;
  owner: string | null;
  status: string;
  staged_prefix: string | null;
  result_sha256: string | null;
  result_filename: string | null;
  duration_ms: number | null;
  finished_at: string | null;
  pkgbuild_ref: string;
  lease_owner: string | null;
}

export async function handleReviewList(env: Env, request: Request): Promise<Response> {
  const c = await contributorOf(request, env);
  const staged = await env.DB.prepare(
    `SELECT t.id, t.name, t.arch, t.version, t.owner, t.status, t.trust, t.params, t.staged_prefix, t.result_sha256, t.result_filename, t.duration_ms, t.finished_at, t.pkgbuild_ref, t.result, t.attempts,
            t.lease_owner, w.owner AS worker_owner, w.labels AS worker_labels, w.hostname AS worker_hostname, w.trusted_by AS worker_trusted_by,
            p.owner AS package_owner, p.url, p.detected, p.category, p.license AS request_license, p.source AS request_source, p.project AS request_project, p.description AS request_description,
            q.id AS request_id, q.version AS request_version, q.checklist AS request_checklist, q.migrated AS request_migrated, q.record AS request_record, q.sha256 AS request_sha256, q.created_at AS request_created_at,
            (SELECT decision FROM approvals a WHERE a.task_id = t.id ORDER BY a.id DESC LIMIT 1) AS decision,
            (SELECT by FROM approvals a WHERE a.task_id = t.id ORDER BY a.id DESC LIMIT 1) AS decided_by,
            (SELECT u.status FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_status,
            (SELECT u.result FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_result,
            (SELECT u.error FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_error,
            (SELECT u.status FROM build_tasks u WHERE u.kind = 'trial' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS trial_status,
            (SELECT u.result FROM build_tasks u WHERE u.kind = 'trial' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS trial_result,
            (SELECT u.error FROM build_tasks u WHERE u.kind = 'trial' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS trial_error
       FROM build_tasks t LEFT JOIN factory_packages p ON p.name = t.name
                          LEFT JOIN package_requests q ON q.id = p.request_id
                          LEFT JOIN build_workers w ON w.id = t.lease_owner
      WHERE t.kind = 'build' AND t.status = 'staged'
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id = t.id AND ${standsSql("a.")})
        -- a contributor's evidence whose project build was approved has served: nothing left to decide on it
        AND NOT EXISTS (SELECT 1 FROM approvals a JOIN build_tasks r ON r.id = a.task_id WHERE ${standsSql("a.")} AND r.name = t.name AND json_extract(r.params, '$.review') = t.id)
      ORDER BY t.id DESC LIMIT 100`,
  ).all();
  // A contributor's build that the project is building again, or built: the review row says so.
  const projectOf = new Map<number, { id: number; status: string; error: string | null; worker: string | null; attempts: number; result: string | null; trial_status: string | null; trial_result: string | null }>();
  const builds = await env.DB.prepare(
    `SELECT id, status, error, params, lease_owner, attempts, result,
            (SELECT u.status FROM build_tasks u WHERE u.kind = 'trial' AND u.name = b.name AND json_extract(u.params, '$.task') = b.id ORDER BY u.id DESC LIMIT 1) AS trial_status,
            (SELECT u.result FROM build_tasks u WHERE u.kind = 'trial' AND u.name = b.name AND json_extract(u.params, '$.task') = b.id ORDER BY u.id DESC LIMIT 1) AS trial_result
       FROM build_tasks b WHERE kind = 'build' AND trust = 'project' AND json_extract(params, '$.review') IS NOT NULL AND status IN ('queued', 'leased', 'staged', 'failed', 'done') ORDER BY id`,
  ).all<{ id: number; status: string; error: string | null; params: string; lease_owner: string | null; attempts: number; result: string | null; trial_status: string | null; trial_result: string | null }>();
  for (const b of builds.results) {
    const from = Number((JSON.parse(b.params) as { review?: number }).review);
    if (from) projectOf.set(from, { id: b.id, status: b.status, error: b.error, worker: b.lease_owner, attempts: b.attempts, result: b.result, trial_status: b.trial_status, trial_result: b.trial_result });
  }
  // The contributor's build behind each of the project's rows in the list (its gate, its audit, its attempts): the score needs both halves.
  const fromIds = staged.results.map((r) => (r.trust === "project" && r.params ? (JSON.parse(r.params as string) as { review?: number }).review : null)).filter((x): x is number => typeof x === "number");
  const fromRows = new Map<number, { id: number; attempts: number; status: string; result: string | null; version: string | null; pkgbuild_ref: string | null; audit_status: string | null; audit_result: string | null }>();
  if (fromIds.length) {
    const rows = await env.DB.prepare(
      `SELECT t.id, t.attempts, t.status, t.result, t.version, t.pkgbuild_ref,
              (SELECT u.status FROM build_tasks u WHERE u.kind = 'audit' AND u.name = t.name AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_status,
              (SELECT u.result FROM build_tasks u WHERE u.kind = 'audit' AND u.name = t.name AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_result
         FROM build_tasks t WHERE t.id IN (${fromIds.map(() => "?").join(", ")})`,
    ).bind(...fromIds).all<{ id: number; attempts: number; status: string; result: string | null; version: string | null; pkgbuild_ref: string | null; audit_status: string | null; audit_result: string | null }>();
    for (const r of rows.results) fromRows.set(r.id, r);
  }
  // The chain's score (score.ts) from what the row and its other half carry; `ready` = the contributor's half is complete, a maintainer's time is well spent.
  const scoreOf = (r: Record<string, unknown>) => {
    const audit = (st: string | null, res: string | null) => { const a = auditOf(st, res, null); return st ? { status: a.status, verdict: a.verdict ?? null, high: a.high, findings: a.findings } : null; };
    const trial = (st: string | null, res: string | null) => { const t = trialOf(st, res, null); return st ? { status: t.status, verdict: t.verdict ?? null } : null; };
    // The request as the form would take it today (request.ts): an incomplete one — the checklist never confirmed, the version unknown — is not ready.
    const req = requestChecks(
      { project: (r.request_project as string | null) ?? null, source: (r.request_source as string | null) ?? null, description: (r.request_description as string | null) ?? null, license: (r.request_license as string | null) ?? null, detected: (r.detected as string | null) ?? null },
      r.request_id ? { id: r.request_id as number, version: (r.request_version as string) ?? "", checklist: (r.request_checklist as string | null) ?? null, migrated: (r.request_migrated as number) ?? 0, record: (r.request_record as string) ?? "", sha256: (r.request_sha256 as string) ?? "", created_at: (r.request_created_at as string) ?? "" } : null,
    );
    const request = { license: (r.request_license as string | null) ?? null, source: (r.request_source as string | null) ?? null, version: (r.request_version as string | null) ?? null, complete: req.complete };
    if (r.trust === "project") {
      const from = r.params ? (JSON.parse(r.params as string) as { review?: number }).review : undefined;
      const c = from ? fromRows.get(from) : undefined;
      return scoreChain({ contributor: c ? { attempts: c.attempts, status: c.status, version: c.version, bump: !!c.pkgbuild_ref?.startsWith("bump:") } : null, vet: c ? vetOf(c.result) : null, audit: c ? audit(c.audit_status, c.audit_result) : null, request, project: { status: r.status as string, attempts: r.attempts as number }, projectVet: vetOf(r.result as string | null), trial: trial(r.trial_status as string | null, r.trial_result as string | null), approval: null, category: (r.category as string | null) ?? null });
    }
    const pb = projectOf.get(r.id as number);
    return scoreChain({ contributor: { attempts: r.attempts as number, status: r.status as string, version: (r.version as string | null) ?? null, bump: String(r.pkgbuild_ref ?? "").startsWith("bump:") }, vet: vetOf(r.result as string | null), audit: audit(r.audit_status as string | null, r.audit_result as string | null), request, project: pb ? { status: pb.status, attempts: pb.attempts } : null, projectVet: pb ? vetOf(pb.result) : null, trial: pb ? trial(pb.trial_status, pb.trial_result) : null, approval: null, category: (r.category as string | null) ?? null });
  };
  // A build of a version a maintainer already approved — the same name,
  // version and architecture, an earlier task — is nothing to decide: the
  // package is in the pool or on its way. The row says so (`already`), the
  // page keeps it out of the count and offers to drop it (felix 2.16.1 was
  // built again three days after its approval and sat as "waiting", 2026-09-16).
  const names = [...new Set(staged.results.map((r) => r.name as string))];
  const prior = names.length
    ? (await env.DB.prepare(
        `SELECT a.task_id, a.name, a.arch, a.version, a.by, a.created_at, a.rebuild_task, r.status AS rebuild_status
           FROM approvals a LEFT JOIN build_tasks r ON r.id = a.rebuild_task
          WHERE ${standsSql("a.")} AND a.name IN (${names.map(() => "?").join(", ")}) ORDER BY a.id DESC`,
      ).bind(...names).all<{ task_id: number; name: string; arch: string; version: string | null; by: string; created_at: string; rebuild_task: number | null; rebuild_status: string | null }>()).results
    : [];
  const already = (r: Record<string, unknown>) => {
    const a = prior.find((x) => x.name === r.name && x.arch === r.arch && x.version === r.version && x.task_id !== r.id && x.rebuild_task !== r.id);
    return a ? { task: a.task_id, by: a.by, at: a.created_at, rebuild_task: a.rebuild_task, rebuild_status: a.rebuild_status } : null;
  };
  // Where the bytes came from: the worker that held the lease, its owner, the host it says it runs on, who vouched for it.
  const builtBy = (r: Record<string, unknown>) => {
    if (!r.lease_owner) return null;
    let where: string | null = null;
    try {
      where = (r.worker_labels ? (JSON.parse(r.worker_labels as string) as { where?: string }).where : null) ?? (r.worker_hostname as string | null) ?? null;
    } catch {
      where = (r.worker_hostname as string | null) ?? null;
    }
    return { worker: r.lease_owner as string, owner: (r.worker_owner as string | null) ?? null, where, trusted_by: (r.worker_trusted_by as string | null) ?? null };
  };
  // The project's builds that still have a package in staging: the sweep
  // (staging.ts, STAGING_DAYS) drops the objects of an old build while the
  // row stays staged, and an approval of such a build has nothing to publish.
  const projectIds = staged.results.filter((r) => r.trust === "project").map((r) => r.id as number);
  const packaged = new Set(
    projectIds.length
      ? (await env.DB.prepare(`SELECT DISTINCT task_id FROM staging_objects WHERE task_id IN (${projectIds.map(() => "?").join(", ")}) AND key LIKE '%.pkg.tar.zst'`).bind(...projectIds).all<{ task_id: number }>()).results.map((x) => x.task_id)
      : [],
  );
  // What the caller may do on the row, from what the list already holds: the
  // registration's owner, the standing approvals of the name (`prior`), the
  // project's build of a contributor's row, the package in staging. The same
  // predicate the POST handlers apply, so a button greyed here is one the
  // server would refuse. `standing` rides along: the Decision cell draws
  // Withdraw where an approval stands, for every viewer alike.
  const rowFacts = (r: Record<string, unknown>): Facts => {
    const id = r.id as number;
    const from = r.trust === "project" && r.params ? ((JSON.parse(r.params as string) as { review?: number }).review ?? null) : null;
    const pb = r.trust === "community" ? projectOf.get(id) : undefined;
    const halves = [id, from, pb?.id].filter((x): x is number => typeof x === "number");
    return {
      owner: (r.package_owner as string | null) ?? (r.owner as string | null) ?? null,
      already: prior.some((x) => x.task_id === id),
      inFlight: pb && ["queued", "leased", "staged"].includes(pb.status) ? { id: pb.id, status: pb.status } : null,
      standing: prior.some((x) => halves.includes(x.task_id) || (x.rebuild_task !== null && halves.includes(x.rebuild_task))),
      packaged: r.trust !== "project" || packaged.has(id),
    };
  };
  const canOf = (r: Record<string, unknown>, f: Facts) => can(decisions(c, { id: r.id as number, name: r.name as string, trust: r.trust as string, status: r.status as string }, f));
  const rows = staged.results.map((r) => ({
    ...r,
    ...(() => { const f = rowFacts(r); return { can: canOf(r, f), standing: f.standing }; })(),
    // contributor: evidence, a maintainer has the project build it · project: the project's own build, a maintainer approves it
    kind: r.trust === "project" ? "project" : "contributor",
    from: r.trust === "project" && r.params ? ((JSON.parse(r.params as string) as { review?: number }).review ?? null) : null,
    project_build: r.trust === "community" ? (() => { const pb = projectOf.get(r.id as number); return pb ? { id: pb.id, status: pb.status, error: pb.error, worker: pb.worker } : null; })() : null,
    built_by: builtBy(r),
    already: already(r),
    package_owner: undefined,
    // The class the chain has today and the one it reaches with the maintainer's half green; ready = the contributor's half is complete.
    score: (() => { const sc = scoreOf(r); return { points: sc.points, class: sc.class, projected: sc.projected, ready: sc.ready }; })(),
    params: undefined,
    lease_owner: undefined,
    worker_owner: undefined,
    worker_labels: undefined,
    worker_hostname: undefined,
    worker_trusted_by: undefined,
    detected: r.detected ? JSON.parse(r.detected as string) : null,
    evidence: { log: `/api/v1/factory/tasks/${r.id}/artifacts/build.log`, pkgbuild: `/api/v1/factory/tasks/${r.id}/artifacts/PKGBUILD`, pkginfo: `/api/v1/factory/tasks/${r.id}/artifacts/PKGINFO`, audit: `/api/v1/factory/tasks/${r.id}/artifacts/audit.md`, tests: `/api/v1/factory/tasks/${r.id}/artifacts/tests.log`, vet: `/api/v1/factory/tasks/${r.id}/artifacts/vet.json`, trial: `/api/v1/factory/tasks/${r.id}/artifacts/trial.log` },
    // The gate (/docs/factory *The gate*): the worker's own checks — checksums, shellcheck, namcap, the file list, the metadata, check(), the smoke test — as vet.json said.
    vet: vetOf(r.result as string | null),
    // The second agent's report (docs/GOVERNANCE.md): a verdict a
    // maintainer reads, never one the pool acts on.
    audit: auditOf(r.audit_status as string | null, r.audit_result as string | null, r.audit_error as string | null),
    // The trial (the lab): a real pacman installed the project's build from the lab above edge — or could not; the transcript is the evidence.
    trial: trialOf(r.trial_status as string | null, r.trial_result as string | null, r.trial_error as string | null),
    audit_status: undefined, audit_result: undefined, audit_error: undefined, trial_status: undefined, trial_result: undefined, trial_error: undefined, result: undefined, attempts: undefined, request_license: undefined, request_source: undefined,
  }));
  // The one number every tile reads — Review's, the Pipeline's, the
  // Factory's — counted here and nowhere else: the rows a maintainer's time
  // is asked for now. Not a build of a version already approved, not a
  // contributor's build the project is building or has built again (the
  // project's row is the one to decide; a failed project build hands it
  // back). The same rule the Review page highlights a row by (decidable),
  // so the count and the rows agree. `oldest_ms` is the age of the oldest
  // of them, from when it was staged; null when nothing waits. Both are
  // counted over the hundred newest staged rows the list shows (LIMIT above):
  // past a hundred, the oldest is the first left out.
  const waiting = rows.filter(waitsForMaintainer);
  const ages = waiting.map((t) => Date.now() - Date.parse((t as { finished_at?: string | null }).finished_at ?? "")).filter((ms) => Number.isFinite(ms) && ms > 0);
  return json(
    { staged: rows, waiting: waiting.length, oldest_ms: ages.length ? Math.max(...ages) : null },
    200,
    { "cache-control": "no-store" },
  );
}

/** A row of GET /factory/review that asks for a maintainer's decision now (the Review page's `decidable`). */
export function waitsForMaintainer(t: { already: unknown; kind: string; project_build: { status: string } | null }): boolean {
  return !t.already && (t.kind === "project" || !t.project_build || t.project_build.status === "failed");
}

interface AuditReport { verdict: string; summary: string; findings: { severity: string; area: string }[]; model?: string }

/** The gate's summary the build's completion kept on the task (build_tasks.result → {vet}); null for a build older than the gate. */
function vetOf(result: string | null): { verdict: string; fails: number; warnings: number; failed: string[]; warned: string[] } | null {
  if (!result) return null;
  try {
    return (JSON.parse(result) as { vet?: { verdict: string; fails: number; warnings: number; failed: string[]; warned: string[] } }).vet ?? null;
  } catch {
    return null;
  }
}

/** The audit as the Review page shows it: its state while pending, the verdict once done. */
function auditOf(status: string | null, result: string | null, error: string | null): { status: string; verdict?: string; summary?: string; findings?: number; high?: number; model?: string; error?: string } {
  if (!status) return { status: "none" };
  if (status !== "done") return { status, error: error ?? undefined };
  try {
    const r = JSON.parse(result ?? "{}") as AuditReport;
    const findings = Array.isArray(r.findings) ? r.findings : [];
    return { status: "done", verdict: r.verdict, summary: r.summary, findings: findings.length, high: findings.filter((f) => f.severity === "high").length, model: r.model };
  } catch {
    return { status: "done", error: "unreadable report" };
  }
}

/** The trial as the Review page shows it: its state while pending, the verdict once done (`ok`, or what stopped it). */
function trialOf(status: string | null, result: string | null, error: string | null): { status: string; verdict?: string; packages?: string[]; error?: string } {
  if (!status) return { status: "none" };
  if (status !== "done") return { status, error: error ?? undefined };
  try {
    const r = JSON.parse(result ?? "{}") as { verdict?: string; packages?: string[] };
    return { status: "done", verdict: r.verdict ?? "unknown", packages: r.packages };
  } catch {
    return { status: "done", error: "unreadable result" };
  }
}

/** The latest trial of a staged build: its status, result and error, as trialOf reads them. */
async function latestTrial(env: Env, taskId: number): Promise<[string | null, string | null, string | null]> {
  const r = await env.DB.prepare("SELECT status, result, error FROM build_tasks WHERE kind = 'trial' AND json_extract(params, '$.task') = ? ORDER BY id DESC LIMIT 1").bind(taskId).first<{ status: string; result: string | null; error: string | null }>();
  return r ? [r.status, r.result, r.error] : [null, null, null];
}

/** A decision on the build ends the audit and the trial that have not started (the reports of those that ran stay as evidence). */
async function cancelPendingAudit(env: Env, taskId: number): Promise<void> {
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build was decided before the audit ran' WHERE kind = 'audit' AND status = 'queued' AND json_extract(params, '$.task') = ?").bind(taskId).run();
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build was decided before the trial ran' WHERE kind = 'trial' AND status = 'queued' AND json_extract(params, '$.task') = ?").bind(taskId).run();
}

/** The owner of a package — the contributor who requested it — from the registration; the task's owner as the fallback. */
async function ownerOf(env: Env, name: string, fallback: string | null): Promise<string | null> {
  const p = await env.DB.prepare("SELECT owner, request_id FROM factory_packages WHERE name = ?").bind(name).first<{ owner: string; request_id: number | null }>();
  return p?.owner ?? fallback;
}

/**
 * The four decisions on a build, decided in one place. Every page draws
 * every button for every reader and greys the ones the reader may not press,
 * with the reason in the button's title (the dashboard's rule: nothing
 * hidden, nothing absent, a disabled control with why). The reason must be
 * the one the server would answer, so the predicate below is what the POST
 * handlers refuse with and what GET /factory/review and
 * GET /factory/tasks/:id/can carry as `can` — computed once, read twice, no
 * drift. The order of the reasons is the order a reader wants them: sign in
 * first, then the role (the main difference on the dashboard), then the
 * build's state, then the owner (who never decides on their own package —
 * /docs/governance, and that holds for a rejection too), then what is
 * already done.
 */
export type Decision = "approve" | "reject" | "build" | "withdraw";

/** What the pages read: true where the caller may, else the reason a person reads in the button's title. */
export interface Can {
  approve: boolean;
  reject: boolean;
  build: boolean;
  withdraw: boolean;
  why: Partial<Record<Decision, string>>;
}

/** A decision allowed, or refused with the status the POST answers and the reason. */
type Verdict = { ok: true } | { ok: false; status: 401 | 403 | 404 | 409; why: string };

/** The task as the predicate reads it: the columns every build_tasks row has. */
interface Decidable { id: number; name: string; trust: string; status: string }

/** What the predicate needs beyond the row: the registration's owner, a standing approval on the task, the project's build in flight, a standing approval anywhere on the chain, a package still in staging (a project's build the sweep emptied has nothing to publish). */
interface Facts { owner: string | null; already: boolean; inFlight: { id: number; status: string } | null; standing: boolean; packaged: boolean }

export function decisions(c: Contributor | null, t: Decidable, f: Facts): Record<Decision, Verdict> {
  const allow: Verdict = { ok: true };
  const no = (status: 401 | 403 | 404 | 409, why: string): Verdict => ({ ok: false, status, why });
  // The two reasons every decision shares: nobody signed in, or somebody who is not a maintainer — the words a person's page greys Withdraw with (workspace() in routes/contributors.ts).
  const person = !c ? no(401, SIGN_IN) : !isMaintainer(c) ? no(403, MAINTAINER_DECIDES) : null;
  const notStaged = t.status !== "staged" ? no(409, `task ${t.id} is ${t.status}, not staged`) : null;
  // Conflict of interest: nobody decides on their own package, and a project with a single maintainer is no
  // exception — that maintainer's own packages wait for a second one (/docs/governance).
  const owner = c && f.owner === c.login ? no(403, `you brought ${t.name} — another maintainer decides; with one maintainer, that maintainer's own packages wait`) : null;
  return {
    // What users get is the project's build: a contributor's build is evidence, and "Build it by the project" comes first.
    approve:
      person ?? notStaged
        ?? (t.trust !== "project" ? no(409, "a contributor's build is evidence, never what users get — have the project build it first, then approve the project's build") : null)
        ?? owner
        ?? (f.already ? no(409, "already approved") : null)
        ?? (!f.packaged ? no(409, "the project's build left no package in staging") : null)
        ?? allow,
    // A chain with a standing approval is decided: the package is served (or on its way) under that approval, and a
    // rejection beside it would mark the registration as if nothing were — the approval is withdrawn first.
    reject: person ?? notStaged ?? owner ?? (f.standing ? no(409, "already approved — withdraw the approval first") : null) ?? allow,
    build:
      person ?? notStaged
        ?? (t.trust !== "community" ? no(409, "the project's own build; the project builds from a contributor's staged build") : null)
        ?? owner
        ?? (f.inFlight ? no(409, `the project is already on it: task ${f.inFlight.id} is ${f.inFlight.status}`) : null)
        ?? allow,
    // Any maintainer may, the one who approved and the owner included: undoing a mistake is not deciding on a package.
    withdraw: person ?? (!f.standing ? no(404, "nothing standing to withdraw") : null) ?? allow,
  };
}

/** The verdicts as a page reads them. */
export function can(v: Record<Decision, Verdict>): Can {
  const why: Partial<Record<Decision, string>> = {};
  for (const d of ["approve", "reject", "build", "withdraw"] as Decision[]) {
    const x = v[d];
    if (!x.ok) why[d] = x.why;
  }
  return { approve: v.approve.ok, reject: v.reject.ok, build: v.build.ok, withdraw: v.withdraw.ok, why };
}

/** The refusal a POST answers: the reason, with its status. */
function refused(v: Verdict): Response | null {
  return v.ok ? null : json({ error: v.why }, v.status);
}

/** The approval that stands on this task's chain — asked by the contributor's build or the project's, it is the same one. */
async function standingApproval(env: Env, name: string, id: number): Promise<Approval | null> {
  const story = await storyRows(env, name);
  const chain = chainOf(chains(story.tasks, story.approvals, story.pkg, story.request), id);
  return chain?.approval?.standing ? chain.approval : null;
}

/** The facts about one task, read for a decision on it: five indexed reads, one of them the package's story. */
async function factsOf(env: Env, t: Decidable & { owner: string | null }): Promise<Facts & { approval: Approval | null }> {
  const [owner, already, inFlight, approval, packaged] = await Promise.all([
    ownerOf(env, t.name, t.owner),
    env.DB.prepare(`SELECT id FROM approvals WHERE task_id = ? AND ${standsSql()}`).bind(t.id).first(),
    env.DB.prepare("SELECT id, status FROM build_tasks WHERE kind = 'build' AND trust = 'project' AND json_extract(params, '$.review') = ? AND status IN ('queued', 'leased', 'staged')").bind(t.id).first<{ id: number; status: string }>(),
    standingApproval(env, t.name, t.id),
    t.trust === "project" ? env.DB.prepare("SELECT 1 AS one FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst' LIMIT 1").bind(t.id).first() : Promise.resolve(true),
  ]);
  return { owner, already: !!already, inFlight, standing: !!approval, packaged: !!packaged, approval };
}

/** GET /factory/tasks/:id/can — what the caller may do on this task, and why not: no-store, it is the caller's. */
export async function handleTaskCan(c: Contributor | null, id: number, env: Env): Promise<Response> {
  const t = await env.DB.prepare("SELECT id, name, trust, status, owner FROM build_tasks WHERE id = ?").bind(id).first<Decidable & { owner: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  return json({ task: id, can: can(decisions(c, t, await factsOf(env, t))) }, 200, { "cache-control": "no-store" });
}

/**
 * "Build it by the project": a maintainer, never the owner, on a
 * contributor's staged build. The project builds the package again on a
 * worker it trusts, with its own agent — the request, the contributor's
 * PKGBUILD, log, gate and audit as the lesson, never the product — through
 * the same gate, staged like any build. Then a maintainer approves *that*.
 */
export async function handleProjectBuild(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string; worker?: unknown };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string }>();
  if (!t) return json({ error: "no such task" }, 404);
  const f = await factsOf(env, t);
  const no = refused(decisions(c, t, f).build);
  if (no) return no;
  const owner = f.owner;
  // Where it runs: one of the project's workers that builds this architecture, when the maintainer says which (the native one, not the emulated one).
  let pinned: string | null = null;
  if (typeof b.worker === "string" && b.worker.trim()) {
    const w = await env.DB.prepare("SELECT id, arch, kinds, agent_status FROM build_workers WHERE id = ? AND revoked_at IS NULL AND trust = 'project'").bind(b.worker.trim()).first<{ id: string; arch: string; kinds: string | null; agent_status: string | null }>();
    if (!w || w.arch !== t.arch) return json({ error: `${b.worker} is not a project worker for ${t.arch}` }, 400);
    // The claim gives a review build only to a worker that declares builds and whose agent answered; pinned to another, it would wait forever.
    const kinds = w.kinds ? (JSON.parse(w.kinds) as string[]) : [];
    if (kinds.length && !kinds.includes("build")) return json({ error: `${w.id} does not take builds (it declares ${kinds.join(", ")})` }, 400);
    if (w.agent_status !== "ok") return json({ error: `${w.id} has no agent that answers; the project's build is drafted by one` }, 400);
    pinned = w.id;
  }
  const pkg = await env.DB.prepare("SELECT request_id, project, source, release, description, license FROM factory_packages WHERE name = ?").bind(t.name).first<{ request_id: number | null; project: string | null; source: string | null; release: string | null; description: string | null; license: string | null }>();
  // The maintainer's note is on the record and is the hint the project's agent drafts with (the worker reads params.hint).
  const params = { review: id, request: pkg?.request_id ?? null, project: pkg?.project ?? null, source: pkg?.source ?? null, version: pkg?.release ?? t.version, description: pkg?.description ?? null, license: pkg?.license ?? null, owner, by: c.login, note: b.note ?? null, hint: typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 600) : null };
  const row = await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, params, pinned_to) VALUES (?, ?, ?, ?, ?, 30, 0, 'project', ?, 'build', ?, ?) RETURNING id`,
  )
    .bind(t.name, t.arch, t.version, `review:${id}`, `project build asked by ${c.login}`, owner, JSON.stringify(params), pinned)
    .first<{ id: number }>();
  await env.DB.prepare("UPDATE factory_packages SET detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`${t.version ?? ""} for ${t.arch}: the project is building it (task ${row?.id}), asked by ${c.login}`, t.name)
    .run();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('review', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${t.arch}): ${c.login} asked the project to build it — task ${row?.id}, from ${owner ?? "?"}'s build ${id}`, JSON.stringify({ task: row?.id, from: id, name: t.name, arch: t.arch, by: c.login, owner, note: b.note ?? null }))
    .run();
  return json({ task: row?.id, from: id, by: c.login, pinned_to: pinned });
}

export async function handleApprove(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string; params: string | null; result_filename: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  const f = await factsOf(env, t);
  const no = refused(decisions(c, t, f).approve);
  if (no) return no;
  const owner = f.owner;
  // The decision, on the record, and the publish job: a project worker
  // carries the staged package into the pool (signed there), renders
  // edge, and handleComplete marks the registration published and links
  // this approval to the build (the seal and the track record read it).
  const files = (await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst'").bind(id).all<{ key: string }>()).results.map((r) => r.key.slice(r.key.lastIndexOf("/") + 1));
  // The predicate said so already (f.packaged); kept as the belt under the publish job, which needs the names.
  if (!files.length) return json({ error: "the project's build left no package in staging" }, 409);
  // The fast lane: a build a real pacman installed from the lab (the trial's
  // verdict) goes to rc and stable with edge — the publish job's token gets
  // those rings only then. Evidence decides the speed; the maintainer decided the build.
  const trial = trialOf(...(await latestTrial(env, id)));
  const publish = await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, params) VALUES (?, ?, ?, '-', ?, 20, 1, 'project', NULL, 'publish', ?) RETURNING id`,
  )
    .bind(t.name, t.arch, t.version, `approved by ${c.login}`, JSON.stringify({ task: id, name: t.name, arch: t.arch, version: t.version, files, by: c.login, trial: trial.status === "done" ? (trial.verdict ?? "unknown") : trial.status }))
    .first<{ id: number }>();
  await env.DB.prepare(`INSERT INTO approvals (task_id, name, arch, version, decision, by, note, rebuild_task) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)`)
    .bind(id, t.name, t.arch, t.version, c.login, b.note ?? null, id)
    .run();
  await env.DB.prepare("UPDATE factory_packages SET status = 'approved', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`${t.version ?? ""} for ${t.arch} approved by ${c.login}; publishing the project's build (job ${publish?.id})`, t.name)
    .run();
  await cancelPendingAudit(env, id);
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', 'edge', 'factory', 'ok', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${t.arch}) approved by ${c.login}${b.note ? " — " + b.note.slice(0, 120) : ""}; the project's build ${id} goes into edge (job ${publish?.id})`, JSON.stringify({ task: id, publish: publish?.id, name: t.name, arch: t.arch, by: c.login, owner, note: b.note ?? null }))
    .run();
  return json({ task: id, decision: "approved", by: c.login, publish: publish?.id });
}

/**
 * A maintainer takes an approval back — one that broke the rule (a
 * package approved by the person who brought it, as felix was during the
 * bootstrap) or one they no longer stand behind. The approval row stays
 * and is marked void; the package leaves every ring it is in (a release
 * per ring, rendered again), its registration is evidence again, and the
 * chain waits for a decision by another maintainer. The reason is on the
 * record — a signed decision, a journal line — and the contributor sees it.
 * Any maintainer may, the one who approved included: undoing a mistake is
 * not deciding on a package.
 */
export async function handleWithdraw(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT id, name, trust, status, owner FROM build_tasks WHERE id = ?").bind(id).first<Decidable & { owner: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  const f = await factsOf(env, t);
  const no = refused(decisions(c, t, f).withdraw);
  if (no) return no;
  // The input after the predicate, as in the other three handlers: a caller who may not is told so, whatever they sent.
  if (!b.note || b.note.trim().length < 4) return json({ error: "a note saying why is required — it goes on the record" }, 400);
  const a = { ...f.approval!, name: t.name };
  const at = new Date().toISOString();
  await env.DB.prepare("UPDATE approvals SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE id = ?").bind(at, c.login, b.note.trim().slice(0, 500), a.id).run();
  // Out of every ring it reached through this approval; the registration is evidence again.
  const rings = await pullFromRings(env, a.name, `approval of ${a.name} ${a.version ?? ""} withdrawn by ${c.login}: ${b.note.trim().slice(0, 120)}`);
  await env.DB.prepare("UPDATE factory_packages SET status = 'staged', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status IN ('approved', 'published')")
    .bind(`approval of ${a.version ?? ""} for ${a.arch} withdrawn by ${c.login}: ${b.note.trim().slice(0, 160)} — waits for another maintainer`, a.name)
    .run();
  const owner = f.owner;
  const record = await putRecord(env, `factory/${a.name}/decisions/${at.replace(/[:.]/g, "-")}-withdrawn.json`, { schema: "omarchy-pool/decision/1", decision: "withdrawn", name: a.name, arch: a.arch, version: a.version, owner, approval: { id: a.id, task: a.task_id, rebuild_task: a.rebuild_task, by: a.by, at: a.created_at, note: a.note }, by: c.login, at, reason: b.note.trim(), rings });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('withdraw', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${a.name} ${a.version ?? ""} (${a.arch}): the approval by ${a.by} withdrawn by ${c.login} — ${b.note.trim().slice(0, 120)}${rings.length ? "; pulled from " + rings.map((r) => r.ring).join(", ") : ""}`, JSON.stringify({ name: a.name, arch: a.arch, version: a.version, approval: a.id, task: a.task_id, rebuild_task: a.rebuild_task, approved_by: a.by, by: c.login, reason: b.note.trim(), rings, record: recordUrl(env, record.key) }))
    .run();
  return json({ withdrawn: a.id, task: a.task_id, rebuild_task: a.rebuild_task, by: c.login, at, rings, record: recordUrl(env, record.key) });
}

export async function handleReject(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string }>();
  if (!t) return json({ error: "no such task" }, 404);
  const no = refused(decisions(c, t, await factsOf(env, t)).reject);
  if (no) return no;
  if (!b.note) return json({ error: "a note saying why is required" }, 400);
  await env.DB.prepare(`INSERT INTO approvals (task_id, name, arch, version, decision, by, note) VALUES (?, ?, ?, ?, 'rejected', ?, ?)`)
    .bind(id, t.name, t.arch, t.version, c.login, b.note)
    .run();
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ? WHERE id = ?").bind(`rejected by ${c.login}: ${b.note.slice(0, 500)}`, id).run();
  await cancelPendingAudit(env, id);
  // The note and the evidence are the record of a rejection; the package is not.
  await reclaimStagingPackages(env, [id]);
  await env.DB.prepare("UPDATE factory_packages SET status = 'registered', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`rejected by ${c.login}: ${b.note.slice(0, 200)}`, t.name)
    .run();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${t.arch}) rejected by ${c.login}: ${b.note.slice(0, 140)}`, JSON.stringify({ task: id, name: t.name, arch: t.arch, by: c.login, owner: t.owner, note: b.note }))
    .run();
  return json({ task: id, decision: "rejected", by: c.login });
}

/**
 * The decisions, newest first — and, for each approval, the rings that
 * serve the package today (`rings`), so a page can show how far it got,
 * and whether it stands (`standing`: approved and not withdrawn), so no
 * page counts a withdrawn approval as landed by reading `decision` alone
 * (#178 made an approval withdrawable; felix was "landed" on the Factory
 * and "withdrawn" on Review at once, 2026-09-17).
 * One query over the factory's packages in the four rings: the ring table's
 * key is (ring, package_id), so every factory package costs four seeks.
 */
export async function handleApprovals(env: Env): Promise<Response> {
  const [rows, served] = await Promise.all([
    env.DB.prepare(
      `SELECT a.*, r.status AS rebuild_status, r.result_filename AS rebuild_result FROM approvals a LEFT JOIN build_tasks r ON r.id = a.rebuild_task ORDER BY a.id DESC LIMIT 100`,
    ).all(),
    env.DB.prepare(
      `SELECT rp.ring, p.name, p.repo_arch AS arch FROM packages p JOIN ring_packages rp ON rp.package_id = p.id AND rp.ring IN (${ringsSql(RINGS)}) WHERE p.source = 'factory'`,
    ).all<{ ring: string; name: string; arch: string }>(),
  ]);
  const rings = new Map<string, string[]>();
  for (const s of served.results) {
    const k = `${s.name}\t${s.arch}`;
    rings.set(k, sortRings([...(rings.get(k) ?? []), s.ring]));
  }
  const approvals = (rows.results as { name: string; arch: string; decision: string; withdrawn_at: string | null }[]).map((a) => ({ ...a, standing: stands(a), rings: rings.get(`${a.name}\t${a.arch}`) ?? [] }));
  return json({ approvals }, 200, { "cache-control": "public, max-age=30" });
}

