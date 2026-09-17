import { json, type Env } from "../index";
import { scoreChain } from "../score";
import { isMaintainer, type Contributor } from "./contributors";
import { reclaimStagingPackages } from "../staging";
import { pullFromRings } from "./blocks";
import { chains, chainOf, storyRows } from "./story";
import { putRecord, recordUrl } from "../record";

/**
 * Review: what maintainers do with staged builds (docs/GOVERNANCE.md).
 *
 *   GET  /factory/review                    staged builds — the contributors' (evidence) and the project's — with
 *                                           their evidence, the gate and the audit (public)
 *   POST /factory/tasks/:id/build   {note?} a maintainer, never the owner, on a contributor's staged build → the
 *                                           project builds the package again on a review worker with the project's
 *                                           agent: the request and the contributor's evidence as the lesson, its own
 *                                           recipe, the gate, staged like any build (review:<id>)
 *   POST /factory/tasks/:id/approve {note?} a maintainer, never the owner, on the *project's* staged build → the
 *                                           decision on the record and a publish job: the project's package into edge
 *   POST /factory/tasks/:id/reject  {note}  maintainer, either kind of staged build → back to registered with the reason
 *   GET  /factory/approvals                 the record (public)
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

export async function handleReviewList(env: Env): Promise<Response> {
  const staged = await env.DB.prepare(
    `SELECT t.id, t.name, t.arch, t.version, t.owner, t.status, t.trust, t.params, t.staged_prefix, t.result_sha256, t.result_filename, t.duration_ms, t.finished_at, t.pkgbuild_ref, t.result, t.attempts,
            t.lease_owner, w.owner AS worker_owner, w.labels AS worker_labels, w.hostname AS worker_hostname, w.trusted_by AS worker_trusted_by,
            p.url, p.detected, p.category, p.license AS request_license, p.source AS request_source,
            (SELECT decision FROM approvals a WHERE a.task_id = t.id ORDER BY a.id DESC LIMIT 1) AS decision,
            (SELECT by FROM approvals a WHERE a.task_id = t.id ORDER BY a.id DESC LIMIT 1) AS decided_by,
            (SELECT u.status FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_status,
            (SELECT u.result FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_result,
            (SELECT u.error FROM build_tasks u WHERE u.kind = 'audit' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_error,
            (SELECT u.status FROM build_tasks u WHERE u.kind = 'trial' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS trial_status,
            (SELECT u.result FROM build_tasks u WHERE u.kind = 'trial' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS trial_result,
            (SELECT u.error FROM build_tasks u WHERE u.kind = 'trial' AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS trial_error
       FROM build_tasks t LEFT JOIN factory_packages p ON p.name = t.name
                          LEFT JOIN build_workers w ON w.id = t.lease_owner
      WHERE t.kind = 'build' AND t.status = 'staged'
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id = t.id AND a.decision = 'approved' AND a.withdrawn_at IS NULL)
        -- a contributor's evidence whose project build was approved has served: nothing left to decide on it
        AND NOT EXISTS (SELECT 1 FROM approvals a JOIN build_tasks r ON r.id = a.task_id WHERE a.decision = 'approved' AND a.withdrawn_at IS NULL AND r.name = t.name AND json_extract(r.params, '$.review') = t.id)
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
  const fromRows = new Map<number, { id: number; attempts: number; status: string; result: string | null; audit_status: string | null; audit_result: string | null }>();
  if (fromIds.length) {
    const rows = await env.DB.prepare(
      `SELECT t.id, t.attempts, t.status, t.result,
              (SELECT u.status FROM build_tasks u WHERE u.kind = 'audit' AND u.name = t.name AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_status,
              (SELECT u.result FROM build_tasks u WHERE u.kind = 'audit' AND u.name = t.name AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_result
         FROM build_tasks t WHERE t.id IN (${fromIds.map(() => "?").join(", ")})`,
    ).bind(...fromIds).all<{ id: number; attempts: number; status: string; result: string | null; audit_status: string | null; audit_result: string | null }>();
    for (const r of rows.results) fromRows.set(r.id, r);
  }
  // The chain's score (score.ts) from what the row and its other half carry; `ready` = the contributor's half is complete, a maintainer's time is well spent.
  const scoreOf = (r: Record<string, unknown>) => {
    const audit = (st: string | null, res: string | null) => { const a = auditOf(st, res, null); return st ? { status: a.status, verdict: a.verdict ?? null, high: a.high, findings: a.findings } : null; };
    const trial = (st: string | null, res: string | null) => { const t = trialOf(st, res, null); return st ? { status: t.status, verdict: t.verdict ?? null } : null; };
    const request = { license: (r.request_license as string | null) ?? null, source: (r.request_source as string | null) ?? null };
    if (r.trust === "project") {
      const from = r.params ? (JSON.parse(r.params as string) as { review?: number }).review : undefined;
      const c = from ? fromRows.get(from) : undefined;
      return scoreChain({ contributor: c ? { attempts: c.attempts, status: c.status } : null, vet: c ? vetOf(c.result) : null, audit: c ? audit(c.audit_status, c.audit_result) : null, request, project: { status: r.status as string, attempts: r.attempts as number }, projectVet: vetOf(r.result as string | null), trial: trial(r.trial_status as string | null, r.trial_result as string | null), approval: null, category: (r.category as string | null) ?? null });
    }
    const pb = projectOf.get(r.id as number);
    return scoreChain({ contributor: { attempts: r.attempts as number, status: r.status as string }, vet: vetOf(r.result as string | null), audit: audit(r.audit_status as string | null, r.audit_result as string | null), request, project: pb ? { status: pb.status, attempts: pb.attempts } : null, projectVet: pb ? vetOf(pb.result) : null, trial: pb ? trial(pb.trial_status, pb.trial_result) : null, approval: null, category: (r.category as string | null) ?? null });
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
          WHERE a.decision = 'approved' AND a.withdrawn_at IS NULL AND a.name IN (${names.map(() => "?").join(", ")}) ORDER BY a.id DESC`,
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
  return json(
    {
      staged: staged.results.map((r) => ({
        ...r,
        // contributor: evidence, a maintainer has the project build it · project: the project's own build, a maintainer approves it
        kind: r.trust === "project" ? "project" : "contributor",
        from: r.trust === "project" && r.params ? ((JSON.parse(r.params as string) as { review?: number }).review ?? null) : null,
        project_build: r.trust === "community" ? (() => { const pb = projectOf.get(r.id as number); return pb ? { id: pb.id, status: pb.status, error: pb.error, worker: pb.worker } : null; })() : null,
        built_by: builtBy(r),
        already: already(r),
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
      })),
    },
    200,
    { "cache-control": "no-store" },
  );
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

function canReview(c: Contributor): boolean {
  return isMaintainer(c);
}

/** The owner of a package — the contributor who requested it — from the registration; the task's owner as the fallback. */
async function ownerOf(env: Env, name: string, fallback: string | null): Promise<string | null> {
  const p = await env.DB.prepare("SELECT owner, request_id FROM factory_packages WHERE name = ?").bind(name).first<{ owner: string; request_id: number | null }>();
  return p?.owner ?? fallback;
}

/**
 * "Build it by the project": a maintainer, never the owner, on a
 * contributor's staged build. The project builds the package again on a
 * worker it trusts, with its own agent — the request, the contributor's
 * PKGBUILD, log, gate and audit as the lesson, never the product — through
 * the same gate, staged like any build. Then a maintainer approves *that*.
 */
export async function handleProjectBuild(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string }>();
  if (!t) return json({ error: "no such task" }, 404);
  if (t.trust !== "community" || t.status !== "staged") return json({ error: `task ${id} is ${t.trust === "project" ? "the project's own build" : t.status}; the project builds from a contributor's staged build` }, 409);
  if (!canReview(c)) return json({ error: "a maintainer is required" }, 403);
  const owner = await ownerOf(env, t.name, t.owner);
  if (owner === c.login) return json({ error: `${c.login} brought ${t.name}; another maintainer must review it` }, 403);
  const inFlight = await env.DB.prepare("SELECT id, status FROM build_tasks WHERE kind = 'build' AND trust = 'project' AND json_extract(params, '$.review') = ? AND status IN ('queued', 'leased', 'staged')").bind(id).first<{ id: number; status: string }>();
  if (inFlight) return json({ error: `the project is already on it: task ${inFlight.id} is ${inFlight.status}` }, 409);
  const pkg = await env.DB.prepare("SELECT request_id, project, source, release, description, license FROM factory_packages WHERE name = ?").bind(t.name).first<{ request_id: number | null; project: string | null; source: string | null; release: string | null; description: string | null; license: string | null }>();
  const params = { review: id, request: pkg?.request_id ?? null, project: pkg?.project ?? null, source: pkg?.source ?? null, version: pkg?.release ?? t.version, description: pkg?.description ?? null, license: pkg?.license ?? null, owner, by: c.login, note: b.note ?? null };
  const row = await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, params) VALUES (?, ?, ?, ?, ?, 30, 0, 'project', ?, 'build', ?) RETURNING id`,
  )
    .bind(t.name, t.arch, t.version, `review:${id}`, `project build asked by ${c.login}`, owner, JSON.stringify(params))
    .first<{ id: number }>();
  await env.DB.prepare("UPDATE factory_packages SET detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`${t.version ?? ""} for ${t.arch}: the project is building it (task ${row?.id}), asked by ${c.login}`, t.name)
    .run();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('review', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${t.arch}): ${c.login} asked the project to build it — task ${row?.id}, from ${owner ?? "?"}'s build ${id}`, JSON.stringify({ task: row?.id, from: id, name: t.name, arch: t.arch, by: c.login, owner, note: b.note ?? null }))
    .run();
  return json({ task: row?.id, from: id, by: c.login });
}

export async function handleApprove(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string; params: string | null; result_filename: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  if (t.status !== "staged") return json({ error: `task ${id} is ${t.status}, not staged` }, 409);
  // What users get is the project's build: a contributor's build cannot be
  // approved — it is evidence, and "Build it by the project" comes first.
  if (t.trust !== "project") return json({ error: `task ${id} is a contributor's build — evidence, never what users get. Have the project build it first (POST /factory/tasks/${id}/build), then approve the project's build` }, 409);
  if (!canReview(c)) return json({ error: "a maintainer is required" }, 403);
  // Conflict of interest: nobody approves their own package, and a project
  // with a single maintainer is no exception — that maintainer's own
  // packages wait for a second one (docs/GOVERNANCE.md).
  const owner = await ownerOf(env, t.name, t.owner);
  if (owner === c.login) return json({ error: `${c.login} brought ${t.name}; another maintainer must approve it — with one maintainer, that maintainer's own packages wait` }, 403);
  const already = await env.DB.prepare("SELECT id FROM approvals WHERE task_id = ? AND decision = 'approved' AND withdrawn_at IS NULL").bind(id).first();
  if (already) return json({ error: "already approved" }, 409);
  // The decision, on the record, and the publish job: a project worker
  // carries the staged package into the pool (signed there), renders
  // edge, and handleComplete marks the registration published and links
  // this approval to the build (the seal and the track record read it).
  const files = (await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst'").bind(id).all<{ key: string }>()).results.map((r) => r.key.slice(r.key.lastIndexOf("/") + 1));
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
  if (!b.note || b.note.trim().length < 4) return json({ error: "a note saying why is required — it goes on the record" }, 400);
  if (!canReview(c)) return json({ error: "a maintainer is required" }, 403);
  // The approval that stands on this task's chain — asked by the contributor's build or the project's, it is the same one.
  const t = await env.DB.prepare("SELECT name FROM build_tasks WHERE id = ?").bind(id).first<{ name: string }>();
  if (!t) return json({ error: "no such task" }, 404);
  const story = await storyRows(env, t.name);
  const chain = chainOf(chains(story.tasks, story.approvals, story.pkg), id);
  const found = chain?.approval && chain.approval.decision === "approved" ? chain.approval : null;
  if (!found) return json({ error: `no standing approval on task ${id}` }, 404);
  const a = { ...found, name: t.name };
  const at = new Date().toISOString();
  await env.DB.prepare("UPDATE approvals SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE id = ?").bind(at, c.login, b.note.trim().slice(0, 500), a.id).run();
  // Out of every ring it reached through this approval; the registration is evidence again.
  const rings = await pullFromRings(env, a.name, `approval of ${a.name} ${a.version ?? ""} withdrawn by ${c.login}: ${b.note.trim().slice(0, 120)}`);
  await env.DB.prepare("UPDATE factory_packages SET status = 'staged', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status IN ('approved', 'published')")
    .bind(`approval of ${a.version ?? ""} for ${a.arch} withdrawn by ${c.login}: ${b.note.trim().slice(0, 160)} — waits for another maintainer`, a.name)
    .run();
  const owner = await ownerOf(env, a.name, null);
  const record = await putRecord(env, `factory/${a.name}/decisions/${at.replace(/[:.]/g, "-")}-withdrawn.json`, { schema: "omarchy-pool/decision/1", decision: "withdrawn", name: a.name, arch: a.arch, version: a.version, owner, approval: { id: a.id, task: a.task_id, rebuild_task: a.rebuild_task, by: a.by, at: a.created_at, note: a.note }, by: c.login, at, reason: b.note.trim(), rings });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('withdraw', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${a.name} ${a.version ?? ""} (${a.arch}): the approval by ${a.by} withdrawn by ${c.login} — ${b.note.trim().slice(0, 120)}${rings.length ? "; pulled from " + rings.map((r) => r.ring).join(", ") : ""}`, JSON.stringify({ name: a.name, arch: a.arch, version: a.version, approval: a.id, task: a.task_id, rebuild_task: a.rebuild_task, approved_by: a.by, by: c.login, reason: b.note.trim(), rings, record: recordUrl(env, record.key) }))
    .run();
  return json({ withdrawn: a.id, task: a.task_id, rebuild_task: a.rebuild_task, by: c.login, at, rings, record: recordUrl(env, record.key) });
}

export async function handleReject(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  if (!b.note) return json({ error: "a note saying why is required" }, 400);
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged>();
  if (!t) return json({ error: "no such task" }, 404);
  if (t.status !== "staged") return json({ error: `task ${id} is ${t.status}, not staged` }, 409);
  if (!canReview(c)) return json({ error: "a maintainer is required" }, 403);
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
 * serve the package today (`rings`), so a page can show how far it got.
 * One query over the factory's packages in the four rings: the ring table's
 * key is (ring, package_id), so every factory package costs four seeks.
 */
export async function handleApprovals(env: Env): Promise<Response> {
  const [rows, served] = await Promise.all([
    env.DB.prepare(
      `SELECT a.*, r.status AS rebuild_status, r.result_filename AS rebuild_result FROM approvals a LEFT JOIN build_tasks r ON r.id = a.rebuild_task ORDER BY a.id DESC LIMIT 100`,
    ).all(),
    env.DB.prepare(
      `SELECT rp.ring, p.name, p.repo_arch AS arch FROM packages p JOIN ring_packages rp ON rp.package_id = p.id AND rp.ring IN ('lab', 'edge', 'rc', 'stable') WHERE p.source = 'factory'`,
    ).all<{ ring: string; name: string; arch: string }>(),
  ]);
  const order = ["lab", "edge", "rc", "stable"];
  const rings = new Map<string, string[]>();
  for (const s of served.results) {
    const k = `${s.name}\t${s.arch}`;
    rings.set(k, [...(rings.get(k) ?? []), s.ring].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  }
  const approvals = (rows.results as { name: string; arch: string }[]).map((a) => ({ ...a, rings: rings.get(`${a.name}\t${a.arch}`) ?? [] }));
  return json({ approvals }, 200, { "cache-control": "public, max-age=30" });
}
