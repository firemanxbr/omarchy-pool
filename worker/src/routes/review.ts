import { json, type Env } from "../index";
import { REPO_ARCHES, RINGS, ringsSql, sortRings } from "../meta";
import { scoreChain } from "../score";
import { requestChecks } from "../request";
import { contributorOf, isMaintainer, MAINTAINER_DECIDES, SIGN_IN, type Contributor } from "./contributors";
import { reclaimStagingPackages } from "../staging";
import { pullFromRings } from "./blocks";
import { chains, chainOf, storyRows, stands, standsSql, type Approval } from "./story";
export { stands };
import { putRecord, recordUrl } from "../record";
import { packageRows, parseTargets, settleTargets, targetsOf, type PackageRows, type Target, type Targets } from "../targets";

/**
 * Review: what maintainers do with staged builds (docs/GOVERNANCE.md). A
 * package is its name (#242): the builds run per architecture, and a review
 * is of the package — every architecture its contributor built, built again
 * by the project, decided once. The doors stay a task's (the page's rows are
 * builds); what they decide is the package the task is a build of.
 *
 *   GET  /factory/review                    staged builds — the contributors' (evidence) and the project's — with
 *                                           their evidence, the gate and the audit (public, no-store: each row says
 *                                           what the caller may do on it, `can`, and where its package's
 *                                           architectures stand, `targets`); `waiting` and `oldest_ms` at the top: how
 *                                           many packages ask for a maintainer's time and the age of the oldest;
 *                                           `packages`: one entry per package, the row that speaks for it (`lead`)
 *   GET  /factory/tasks/:id/can             what the caller may do on one task — the same `can`, no-store
 *   POST /factory/tasks/:id/build   {note?} a maintainer, never the owner, on a contributor's staged build → the
 *                                           project builds the package again on review workers with the project's
 *                                           agent — every architecture its contributor built, once each is built or
 *                                           not supported: the request and the contributor's evidence as the lesson,
 *                                           its own recipe, the gate, staged like any build (review:<id>)
 *   POST /factory/tasks/:id/approve {note?} a maintainer, never the owner, on the *project's* staged build → one
 *                                           review of the package on the record, covering every architecture the
 *                                           project built again, and a publish job per architecture into edge; one
 *                                           that never built is not supported, outside the decision
 *   POST /factory/tasks/:id/reject  {note}  a maintainer, never the owner, either kind of staged build → the package's
 *                                           builds in review stop, and a request is rejected: the name is free again
 *                                           (a package in the pool keeps it: a new version is what was rejected)
 *   POST /factory/tasks/:id/withdraw {note} any maintainer takes a standing review back, every architecture of it: the
 *                                           package leaves the rings
 *   GET  /factory/approvals                 the record (public), one row per review with its `targets`; `standing` on
 *                                           every row — a review not withdrawn
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
            p.owner AS package_owner, p.url, p.detected, p.category, p.license AS request_license, p.source AS request_source, p.project AS request_project, p.description AS request_description, p.targets,
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
    `SELECT id, name, arch, status, error, params, lease_owner, attempts, result,
            (SELECT u.status FROM build_tasks u WHERE u.kind = 'trial' AND u.name = b.name AND json_extract(u.params, '$.task') = b.id ORDER BY u.id DESC LIMIT 1) AS trial_status,
            (SELECT u.result FROM build_tasks u WHERE u.kind = 'trial' AND u.name = b.name AND json_extract(u.params, '$.task') = b.id ORDER BY u.id DESC LIMIT 1) AS trial_result
       FROM build_tasks b WHERE kind = 'build' AND trust = 'project' AND json_extract(params, '$.review') IS NOT NULL AND status IN ('queued', 'leased', 'staged', 'failed', 'done') ORDER BY id`,
  ).all<{ id: number; name: string; arch: string; status: string; error: string | null; params: string; lease_owner: string | null; attempts: number; result: string | null; trial_status: string | null; trial_result: string | null }>();
  for (const b of builds.results) {
    const from = Number((JSON.parse(b.params) as { review?: number }).review);
    if (from) projectOf.set(from, { id: b.id, status: b.status, error: b.error, worker: b.lease_owner, attempts: b.attempts, result: b.result, trial_status: b.trial_status, trial_result: b.trial_result });
  }
  // The package's other architectures, from what the list holds and the
  // queue: one review covers every architecture (packageFacts), so a row's
  // decision reads its package's builds — the contributors' still queued or
  // running (a read of the queue, the one index walk added here), the
  // staged ones listed, the project's builds of them read above.
  const listed = [...new Set(staged.results.map((r) => r.name as string))];
  const inQueue = listed.length
    ? (await env.DB.prepare("SELECT id, name, arch FROM build_tasks WHERE status IN ('queued', 'leased') AND kind = 'build' AND trust = 'community' AND name IN (SELECT value FROM json_each(?)) ORDER BY id DESC").bind(JSON.stringify(listed)).all<{ id: number; name: string; arch: string }>()).results
    : [];
  const buildsOf = (name: string): PackageBuilds => ({
    building: inQueue.filter((b) => b.name === name),
    staged: staged.results.filter((r) => r.name === name && r.trust !== "project").map((r) => ({ id: r.id as number, arch: r.arch as string, version: (r.version as string | null) ?? null })),
    project: builds.results.filter((b) => b.name === name).map((b) => ({ id: b.id, arch: b.arch, status: b.status, review: Number((JSON.parse(b.params) as { review?: number }).review) })).reverse(),
  });
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
  // project's build of a contributor's row, the package in staging, and
  // where each architecture of the package stands — the registration's
  // targets, the column every transition settles (the doors read them live,
  // by the same rule). The same predicate the POST handlers apply, so a
  // button greyed here is one the server would refuse. `standing` rides
  // along: the Decision cell draws Withdraw where an approval stands, for
  // every viewer alike.
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
      ...packageFacts({ id, arch: r.arch as string, trust: r.trust as string, version: (r.version as string | null) ?? null }, buildsOf(r.name as string), parseTargets(r.targets)),
    };
  };
  const canOf = (r: Record<string, unknown>, f: Facts) => can(decisions(c, { id: r.id as number, name: r.name as string, arch: r.arch as string, trust: r.trust as string, status: r.status as string }, f));
  const shaped = staged.results.map((r) => ({
    ...r,
    ...(() => { const f = rowFacts(r); return { can: canOf(r, f), standing: f.standing, ready: !f.building && !f.rebuilding && !f.superseded && !(r.trust === "project" && f.unbuilt) }; })(),
    // contributor: evidence, a maintainer has the project build it · project: the project's own build, a maintainer approves it
    kind: r.trust === "project" ? "project" : "contributor",
    from: r.trust === "project" && r.params ? ((JSON.parse(r.params as string) as { review?: number }).review ?? null) : null,
    project_build: r.trust === "community" ? (() => { const pb = projectOf.get(r.id as number); return pb ? { id: pb.id, status: pb.status, error: pb.error, worker: pb.worker } : null; })() : null,
    built_by: builtBy(r),
    already: already(r),
    // Where each architecture of the package stands (targets.ts): a row is one build, its package is the name.
    targets: parseTargets(r.targets),
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
  // Every row says whether it asks for a maintainer's time now — `waits`
  // — by the one rule below, and the one number every tile reads —
  // Review's, the Pipeline's, the Factory's — is counted from it here and
  // nowhere else. A package is one decision (#242), so one row speaks for
  // it (`lead`): the project's newest build when the review can decide on
  // it, else the contributor's newest build the project has yet to build
  // again — and none while an architecture of it is still building, by its
  // contributor or by the project (the review covers every architecture
  // once each is built or not supported). Never a build its architecture
  // no longer stands on (a newer build of it failed, or is built): that one
  // is history, listed, not decided. Not a build of a version already
  // approved, not a contributor's build the project is building or has
  // built again (the project's row is the one to decide; a failed project
  // build hands it back). The Review page highlights a row and takes a
  // maintainer's own rows out of "waiting for your decision" by reading
  // `waits`, never by a rule of its own, so the count and the rows agree
  // for every viewer (a page's copy of the rule drifted once, 2026-09-18).
  // `oldest_ms` is the age of the oldest of them, from when it was staged;
  // null when nothing waits. Both are counted over the hundred newest
  // staged rows the list shows (LIMIT above): past a hundred, the oldest is
  // the first left out.
  const col = (t: object, k: string) => (t as Record<string, unknown>)[k];
  const lead = new Map<string, number>();
  for (const kind of ["project", "contributor"]) {
    for (const t of shaped) {
      const name = col(t, "name") as string;
      if (t.kind === kind && !lead.has(name) && t.ready && waitsForMaintainer({ ...t, lead: true })) lead.set(name, col(t, "id") as number);
    }
  }
  const rows = shaped.map((t) => ({ ...t, ready: undefined, lead: lead.get(col(t, "name") as string) === col(t, "id") })).map((t) => ({ ...t, waits: waitsForMaintainer(t) }));
  const waiting = rows.filter((t) => t.waits);
  const ages = waiting.map((t) => Date.now() - Date.parse((t as { finished_at?: string | null }).finished_at ?? "")).filter((ms) => Number.isFinite(ms) && ms > 0);
  // One entry per package in the list, newest first: its rows, the one that speaks for it, where its architectures stand.
  const packages: { name: string; owner: string | null; version: string | null; category: string | null; targets: Targets; lead: number | null; waits: boolean; rows: number[] }[] = [];
  for (const t of rows) {
    const name = col(t, "name") as string;
    let p = packages.find((x) => x.name === name);
    if (!p) packages.push((p = { name, owner: (col(t, "owner") as string | null) ?? null, version: (col(t, "version") as string | null) ?? null, category: (col(t, "category") as string | null) ?? null, targets: t.targets, lead: lead.get(name) ?? null, waits: false, rows: [] }));
    p.rows.push(col(t, "id") as number);
    if (t.waits) p.waits = true;
  }
  return json(
    { staged: rows, waiting: waiting.length, oldest_ms: ages.length ? Math.max(...ages) : null, packages },
    200,
    { "cache-control": "no-store" },
  );
}

/** A row of GET /factory/review that asks for a maintainer's decision now: its `waits`, and what `waiting` counts — the row that speaks for its package (`lead`), by the rule a row reads. */
export function waitsForMaintainer(t: { lead?: boolean; already: unknown; kind: string; project_build: { status: string } | null }): boolean {
  return t.lead === true && !t.already && (t.kind === "project" || !t.project_build || t.project_build.status === "failed");
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
interface Decidable { id: number; name: string; arch: string; trust: string; status: string }

/**
 * The package's builds as a decision on one of its rows reads them — one
 * review covers every architecture (#242): the contributors' builds still
 * queued or running (the review waits until each architecture is built or
 * not supported), the contributors' staged builds no standing approval
 * decided, newest first, with their version, and the project's builds of
 * contributors' builds, newest first.
 */
export interface PackageBuilds {
  building: { id: number; arch: string }[];
  staged: { id: number; arch: string; version: string | null }[];
  project: { id: number; arch: string; status: string; review: number }[];
}

/**
 * What the package says about a decision on one row: a contributor's build
 * still running, the project's build of one still running, an architecture
 * its contributor built that the project has not built again, and whether
 * the row is where its own architecture stands (`superseded`: it is not —
 * a newer build of that architecture failed, or is built, and the row is
 * history).
 */
export interface PackageFacts {
  building: { id: number; arch: string } | null;
  rebuilding: { id: number; arch: string; status: string } | null;
  unbuilt: { id: number; arch: string } | null;
  superseded: { arch: string; task: number | null; status: string } | null;
}

/**
 * The contributor's build an architecture's target stands on — its own
 * staged build (built), or the one the project's build answers (reviewing,
 * reviewed, and not supported by a project's build that failed: the project
 * may try again) — or null: nothing of that architecture is for a review
 * (waiting, building, not supported by its contributor's own build, or
 * decided already).
 */
function reviewedFrom(x: Target | undefined, p: PackageBuilds): number | null {
  if (!x || x.task === null) return null;
  if (x.status === "built") return x.task;
  if (x.status === "reviewing" || x.status === "reviewed" || x.status === "not_supported") return p.project.find((b) => b.id === x.task)?.review ?? null;
  return null;
}

/**
 * The other architectures a review of this row covers, by the one rule
 * (targets.ts): each one's contributor build its target stands on, staged
 * and undecided, of the row's version — one review is one decision on one
 * version of the package. An architecture whose newest build failed is not
 * supported and stays out, whatever older build of it is still staged; one
 * built at another version is not this review's either.
 */
function othersOf(t: { arch: string; version: string | null }, p: PackageBuilds, targets: Targets): PackageBuilds["staged"] {
  return REPO_ARCHES.filter((a) => a !== t.arch)
    .map((a) => { const from = reviewedFrom(targets[a], p); return from === null ? undefined : p.staged.find((s) => s.id === from); })
    .filter((s): s is PackageBuilds["staged"][number] => !!s && s.version === t.version);
}

export function packageFacts(t: { id: number; arch: string; trust: string; version: string | null }, p: PackageBuilds, targets: Targets): PackageFacts {
  // The row's own architecture: a contributor's build is where it stands when its target stands on it, a project's build when the target is that build. No target for it (a registration no transition settled, an architecture no longer requested): the row answers for itself.
  const own = targets[t.arch];
  const current = !own || (t.trust === "project" ? own.task === t.id : reviewedFrom(own, p) === t.id);
  return {
    building: p.building.find((b) => b.id !== t.id) ?? null,
    rebuilding: p.project.find((b) => b.id !== t.id && (b.status === "queued" || b.status === "leased")) ?? null,
    // A project's build that failed is an answer too: that architecture is not supported by this review. One done is spent — published, its approval since taken back — and is built again.
    unbuilt: othersOf(t, p, targets).find((s) => !p.project.some((b) => b.review === s.id && ["queued", "leased", "staged", "failed"].includes(b.status))) ?? null,
    superseded: current ? null : { arch: t.arch, task: own!.task, status: own!.status },
  };
}

/**
 * The package's builds (PackageBuilds) from the rows the targets are kept
 * from (targets.ts, packageRows): the same bounded reads, one rule over them.
 * A staged contributor's build is undecided while no standing approval is on
 * it or on a project's build of it.
 */
export function buildsOfPackage(rows: Pick<PackageRows, "builds" | "decisions">): PackageBuilds {
  const standsOn = (id: number) => rows.decisions.some((a) => a.decision === "approved" && a.withdrawn_at === null && a.task_id === id);
  const newest = [...rows.builds].sort((x, y) => y.id - x.id);
  return {
    building: newest.filter((b) => b.trust === "community" && (b.status === "queued" || b.status === "leased")).map((b) => ({ id: b.id, arch: b.arch })),
    staged: newest
      .filter((b) => b.trust === "community" && b.status === "staged" && !standsOn(b.id) && !newest.some((r) => r.trust === "project" && r.review === b.id && standsOn(r.id)))
      .map((b) => ({ id: b.id, arch: b.arch, version: b.version ?? null })),
    project: newest
      .filter((b) => b.trust === "project" && typeof b.review === "number" && ["queued", "leased", "staged", "failed", "done"].includes(b.status))
      .map((b) => ({ id: b.id, arch: b.arch, status: b.status, review: b.review as number })),
  };
}

/** What the predicate needs beyond the row: the registration's owner, a standing approval on the task, the project's build in flight, a standing approval anywhere on the chain, a package still in staging (a project's build the sweep emptied has nothing to publish), and what the package says (packageFacts). */
interface Facts extends PackageFacts { owner: string | null; already: boolean; inFlight: { id: number; status: string } | null; standing: boolean; packaged: boolean }

export function decisions(c: Contributor | null, t: Decidable, f: Facts): Record<Decision, Verdict> {
  const allow: Verdict = { ok: true };
  const no = (status: 401 | 403 | 404 | 409, why: string): Verdict => ({ ok: false, status, why });
  // The two reasons every decision shares: nobody signed in, or somebody who is not a maintainer — the words a person's page greys Withdraw with (workspace() in routes/contributors.ts).
  const person = !c ? no(401, SIGN_IN) : !isMaintainer(c) ? no(403, MAINTAINER_DECIDES) : null;
  const notStaged = t.status !== "staged" ? no(409, `task ${t.id} is ${t.status}, not staged`) : null;
  // Conflict of interest: nobody decides on their own package, and a project with a single maintainer is no
  // exception — that maintainer's own packages wait for a second one (/docs/governance).
  const owner = c && f.owner === c.login ? no(403, `you brought ${t.name} — another maintainer decides; with one maintainer, that maintainer's own packages wait`) : null;
  // One review covers every architecture: it starts once each is built or not supported, and decides once the project built each again.
  const building = f.building ? no(409, `${f.building.arch} is still building (task ${f.building.id}): one review covers every architecture — it starts once each is built or not supported`) : null;
  // A build its architecture no longer stands on is history: the review decides where each architecture stands now.
  const superseded = f.superseded
    ? no(409, `task ${t.id} is not where ${f.superseded.arch} stands: ${f.superseded.task !== null ? `its newer build, task ${f.superseded.task}, is ${f.superseded.status.replace("_", " ")}` : `${f.superseded.arch} is ${f.superseded.status.replace("_", " ")}`} — one review covers where each architecture stands`)
    : null;
  return {
    // What users get is the project's build: a contributor's build is evidence, and "Build it by the project" comes first.
    approve:
      person ?? notStaged
        ?? (t.trust !== "project" ? no(409, "a contributor's build is evidence, never what users get — have the project build it first, then approve the project's build") : null)
        ?? owner
        ?? (f.already ? no(409, "already approved") : null)
        ?? (!f.packaged ? no(409, "the project's build left no package in staging") : null)
        ?? building
        ?? superseded
        ?? (f.rebuilding ? no(409, `the project is still building ${f.rebuilding.arch} (task ${f.rebuilding.id} is ${f.rebuilding.status}): one review covers every architecture — approve once it is staged`) : null)
        ?? (f.unbuilt ? no(409, `${f.unbuilt.arch} was built by its contributor (task ${f.unbuilt.id}), not yet by the project: have the project build it too — one review covers every architecture`) : null)
        ?? allow,
    // A chain with a standing approval is decided: the package is served (or on its way) under that approval, and a
    // rejection beside it would mark the registration as if nothing were — the approval is withdrawn first.
    reject: person ?? notStaged ?? owner ?? (f.standing ? no(409, "already approved — withdraw the approval first") : null) ?? allow,
    build:
      person ?? notStaged
        ?? (t.trust !== "community" ? no(409, "the project's own build; the project builds from a contributor's staged build") : null)
        ?? owner
        ?? (f.inFlight ? no(409, `the project is already on it: task ${f.inFlight.id} is ${f.inFlight.status}`) : null)
        ?? building
        ?? superseded
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

/**
 * The facts about one task, read for a decision on it: indexed reads of the
 * task's own chain and the package's story, and the package's rows the
 * targets are kept from (packageRows: each read led by the name, bounded),
 * from which its builds and — live, by the one rule — where each of its
 * architectures stands. A decision never reads the stored column: it is a
 * view the next transition settles, not what a decision is taken on.
 */
async function factsOf(env: Env, t: Decidable & { owner: string | null; version?: string | null }): Promise<Facts & { approval: Approval | null; builds: PackageBuilds; targets: Targets }> {
  const [owner, already, approval, packaged, rows] = await Promise.all([
    ownerOf(env, t.name, t.owner),
    env.DB.prepare(`SELECT id FROM approvals WHERE task_id = ? AND ${standsSql()}`).bind(t.id).first(),
    standingApproval(env, t.name, t.id),
    t.trust === "project" ? env.DB.prepare("SELECT 1 AS one FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst' LIMIT 1").bind(t.id).first() : Promise.resolve(true),
    packageRows(env, t.name, { unregistered: true }),
  ]);
  const builds = rows ? buildsOfPackage(rows) : { building: [], staged: [], project: [] };
  const targets = rows ? targetsOf(rows.arches, rows.builds, rows.decisions, rows.closedThrough) : {};
  // The project's build of this one, queued, running or staged: the newest, from the same rows.
  const pb = builds.project.find((b) => b.review === t.id && ["queued", "leased", "staged"].includes(b.status));
  const inFlight = pb ? { id: pb.id, status: pb.status } : null;
  return { owner, already: !!already, inFlight, standing: !!approval, packaged: !!packaged, approval, builds, targets, ...packageFacts({ ...t, version: t.version ?? null }, builds, targets) };
}

/** GET /factory/tasks/:id/can — what the caller may do on this task, and why not: no-store, it is the caller's. */
export async function handleTaskCan(c: Contributor | null, id: number, env: Env): Promise<Response> {
  const t = await env.DB.prepare("SELECT id, name, arch, trust, status, owner, version FROM build_tasks WHERE id = ?").bind(id).first<Decidable & { owner: string | null; version: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  return json({ task: id, can: can(decisions(c, t, await factsOf(env, t))) }, 200, { "cache-control": "no-store" });
}

/**
 * "Build it by the project": a maintainer, never the owner, on a
 * contributor's staged build. The project builds the package again on
 * workers it trusts, with its own agent — the request, the contributor's
 * PKGBUILD, log, gate and audit as the lesson, never the product — through
 * the same gate, staged like any build. One review covers the package, so
 * the project builds every architecture its contributor built: this one,
 * and each other architecture its target says is built, at this version,
 * that the project is not building yet (a failed one is asked again) —
 * never an older build of an architecture whose newest one failed. Then a
 * maintainer approves *those*.
 */
export async function handleProjectBuild(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string; worker?: unknown };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string }>();
  if (!t) return json({ error: "no such task" }, 404);
  const f = await factsOf(env, t);
  const no = refused(decisions(c, t, f).build);
  if (no) return no;
  const owner = f.owner;
  // Where it runs: one of the project's workers that builds this architecture, when the maintainer says which (the native one, not the emulated one); the other architectures go to the queue.
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
  // This build, and each other architecture the review covers (othersOf) that the project is not already building or has built.
  const others = othersOf(t, f.builds, f.targets).filter((s) => !f.builds.project.some((p) => p.review === s.id && ["queued", "leased", "staged"].includes(p.status)));
  const from = [{ id, arch: t.arch, version: t.version }, ...others]
    .sort((x, y) => REPO_ARCHES.indexOf(x.arch as (typeof REPO_ARCHES)[number]) - REPO_ARCHES.indexOf(y.arch as (typeof REPO_ARCHES)[number]));
  const pkg = await env.DB.prepare("SELECT request_id, project, source, release, description, license FROM factory_packages WHERE name = ?").bind(t.name).first<{ request_id: number | null; project: string | null; source: string | null; release: string | null; description: string | null; license: string | null }>();
  const queued: { task: number; arch: string; from: number }[] = [];
  for (const s of from) {
    // The maintainer's note is on the record and is the hint the project's agent drafts with (the worker reads params.hint).
    const params = { review: s.id, request: pkg?.request_id ?? null, project: pkg?.project ?? null, source: pkg?.source ?? null, version: pkg?.release ?? s.version, description: pkg?.description ?? null, license: pkg?.license ?? null, owner, by: c.login, note: b.note ?? null, hint: typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 600) : null };
    const row = await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, params, pinned_to) VALUES (?, ?, ?, ?, ?, 30, 0, 'project', ?, 'build', ?, ?) RETURNING id`,
    )
      .bind(t.name, s.arch, s.version, `review:${s.id}`, `project build asked by ${c.login}`, owner, JSON.stringify(params), s.id === id ? pinned : null)
      .first<{ id: number }>();
    if (row) queued.push({ task: row.id, arch: s.arch, from: s.id });
  }
  const arches = queued.map((q) => q.arch).join(" · ");
  await env.DB.prepare("UPDATE factory_packages SET detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`${t.version ?? ""} for ${arches}: the project is building it (task${queued.length > 1 ? "s" : ""} ${queued.map((q) => q.task).join(", ")}), asked by ${c.login}`, t.name)
    .run();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('review', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${arches}): ${c.login} asked the project to build it — ${queued.map((q) => `task ${q.task} from ${owner ?? "?"}'s build ${q.from}`).join(", ")}`, JSON.stringify({ task: queued.find((q) => q.from === id)?.task, tasks: queued, from: id, name: t.name, arch: t.arch, arches: queued.map((q) => q.arch), by: c.login, owner, note: b.note ?? null }))
    .run();
  await settleTargets(env, t.name);
  return json({ task: queued.find((q) => q.from === id)?.task, tasks: queued.map((q) => q.task), arches: queued.map((q) => q.arch), from: id, by: c.login, pinned_to: pinned });
}

/**
 * Approve: a maintainer, never the owner, on the project's staged build —
 * and with it the package: one review, on the record once, covering every
 * architecture the project built again (this build, and the project's
 * staged build of each other architecture's contributor build). An
 * architecture that never built, or that the project could not build
 * again, is not supported: outside the decision, named on it. A publish job
 * per architecture carries the project's package into the pool (signed
 * there), renders edge, and handleComplete marks the registration published
 * and links the review to the build (the seal and the track record read it).
 */
export async function handleApprove(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string; params: string | null; result_filename: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  const f = await factsOf(env, t);
  const no = refused(decisions(c, t, f).approve);
  if (no) return no;
  const owner = f.owner;
  // The targets: this build for its architecture, and the project's staged build of each other architecture the review covers (othersOf).
  const others = othersOf(t, f.builds, f.targets).map((s) => f.builds.project.find((p) => p.review === s.id)).filter((p): p is PackageBuilds["project"][number] => !!p);
  const staged = others.filter((p) => p.status === "staged");
  const rows = [t, ...(staged.length ? (await env.DB.prepare("SELECT * FROM build_tasks WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(staged.map((p) => p.id))).all<Staged & { trust: string }>()).results : [])]
    .sort((x, y) => REPO_ARCHES.indexOf(x.arch as (typeof REPO_ARCHES)[number]) - REPO_ARCHES.indexOf(y.arch as (typeof REPO_ARCHES)[number]));
  // What never built is not supported: the project's build that failed, and a requested architecture whose own build failed.
  const current = (await settleTargets(env, t.name))[t.name] ?? {};
  const notSupported: Record<string, number | null> = {};
  for (const p of others.filter((x) => x.status === "failed")) notSupported[p.arch] = p.id;
  for (const [arch, x] of Object.entries(current)) if (x.status === "not_supported" && !rows.some((r) => r.arch === arch)) notSupported[arch] = x.task;
  // The staged package of each target: the predicate said so of this one (f.packaged), the publish jobs need the names.
  const targets: { t: Staged & { trust: string }; files: string[]; trial: string }[] = [];
  for (const r of rows) {
    const files = (await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst'").bind(r.id).all<{ key: string }>()).results.map((x) => x.key.slice(x.key.lastIndexOf("/") + 1));
    if (!files.length) return json({ error: r.id === id ? "the project's build left no package in staging" : `the project's build of ${r.arch} (task ${r.id}) left no package in staging` }, 409);
    // The fast lane: a build a real pacman installed from the lab (the trial's
    // verdict) goes to rc and stable with edge — the publish job's token gets
    // those rings only then. Evidence decides the speed; the maintainer decided the build.
    const trial = trialOf(...(await latestTrial(env, r.id)));
    targets.push({ t: r, files, trial: trial.status === "done" ? (trial.verdict ?? "unknown") : trial.status });
  }
  const arches = targets.map((x) => x.t.arch);
  const review = await env.DB.prepare("INSERT INTO reviews (name, version, decision, by, note, arches, not_supported) VALUES (?, ?, 'approved', ?, ?, ?, ?) RETURNING id")
    .bind(t.name, t.version, c.login, b.note ?? null, JSON.stringify(arches), JSON.stringify(notSupported))
    .first<{ id: number }>();
  const publishes: Record<string, number> = {};
  for (const x of targets) {
    // The review it publishes is `review_id`: `review` in a task's params names the contributor's build a project's build answers, and every reader of a task (its page's provenance, the claim's upload, the job's scopes) reads it so.
    const publish = await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, params) VALUES (?, ?, ?, '-', ?, 20, 1, 'project', NULL, 'publish', ?) RETURNING id`,
    )
      .bind(t.name, x.t.arch, x.t.version, `approved by ${c.login}`, JSON.stringify({ task: x.t.id, name: t.name, arch: x.t.arch, version: x.t.version, files: x.files, by: c.login, trial: x.trial, review_id: review?.id ?? null }))
      .first<{ id: number }>();
    if (publish) publishes[x.t.arch] = publish.id;
  }
  const ns = Object.keys(notSupported);
  await env.DB.batch([
    ...targets.map((x) => env.DB.prepare(`INSERT INTO approvals (task_id, name, arch, version, decision, by, note, rebuild_task, review_id) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?)`).bind(x.t.id, t.name, x.t.arch, x.t.version, c.login, b.note ?? null, x.t.id, review?.id ?? null)),
    env.DB.prepare("UPDATE factory_packages SET status = 'approved', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
      .bind(`${t.version ?? ""} for ${arches.join(" · ")} approved by ${c.login}${ns.length ? ` (${ns.join(" · ")} not supported)` : ""}; publishing the project's build${arches.length > 1 ? "s" : ""} (job${arches.length > 1 ? "s" : ""} ${Object.values(publishes).join(", ")})`, t.name),
  ]);
  for (const x of targets) await cancelPendingAudit(env, x.t.id);
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', 'edge', 'factory', 'ok', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${arches.join(", ")}${ns.length ? `; ${ns.join(", ")} not supported` : ""}) approved by ${c.login}${b.note ? " — " + b.note.slice(0, 120) : ""}; the project's build${arches.length > 1 ? "s" : ""} ${targets.map((x) => x.t.id).join(", ")} go${arches.length > 1 ? "" : "es"} into edge (job${arches.length > 1 ? "s" : ""} ${Object.values(publishes).join(", ")})`, JSON.stringify({ review: review?.id ?? null, task: id, publish: publishes[t.arch], publishes, name: t.name, arch: t.arch, arches, not_supported: notSupported, by: c.login, owner, note: b.note ?? null }))
    .run();
  await settleTargets(env, t.name);
  return json({ task: id, decision: "approved", by: c.login, publish: publishes[t.arch], publishes, review: review?.id ?? null, arches, not_supported: notSupported });
}

/**
 * A maintainer takes a review back — one that broke the rule (a package
 * approved by the person who brought it, as felix was during the
 * bootstrap) or one they no longer stand behind — every architecture of it.
 * The rows stay and are marked void; the package leaves every ring it is in
 * (a release per ring, rendered again), its registration is evidence again,
 * and the chains wait for a decision by another maintainer. The reason is on
 * the record — a signed decision, a journal line — and the contributor sees
 * it. Any maintainer may, the one who approved included: undoing a mistake
 * is not deciding on a package.
 */
export async function handleWithdraw(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT id, name, arch, trust, status, owner FROM build_tasks WHERE id = ?").bind(id).first<Decidable & { owner: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  const f = await factsOf(env, t);
  const no = refused(decisions(c, t, f).withdraw);
  if (no) return no;
  // The input after the predicate, as in the other three handlers: a caller who may not is told so, whatever they sent.
  if (!b.note || b.note.trim().length < 4) return json({ error: "a note saying why is required — it goes on the record" }, 400);
  const a = { ...f.approval!, name: t.name };
  const at = new Date().toISOString();
  // The review, whole: every row of it that stands (a row a Worker older than reviews wrote is a review of its own).
  const void_ = a.review_id !== null
    ? (await env.DB.prepare(`SELECT id, arch, task_id, rebuild_task FROM approvals WHERE review_id = ? AND ${standsSql()} ORDER BY id`).bind(a.review_id).all<{ id: number; arch: string; task_id: number; rebuild_task: number | null }>()).results
    : [{ id: a.id, arch: a.arch, task_id: a.task_id, rebuild_task: a.rebuild_task }];
  const arches = void_.map((x) => x.arch);
  await env.DB.batch([
    env.DB.prepare("UPDATE approvals SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE id IN (SELECT value FROM json_each(?))").bind(at, c.login, b.note.trim().slice(0, 500), JSON.stringify(void_.map((x) => x.id))),
    ...(a.review_id !== null ? [env.DB.prepare("UPDATE reviews SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE id = ? AND withdrawn_at IS NULL").bind(at, c.login, b.note.trim().slice(0, 500), a.review_id)] : []),
  ]);
  // Out of every ring it reached through this review; the registration is evidence again.
  const rings = await pullFromRings(env, a.name, `approval of ${a.name} ${a.version ?? ""} withdrawn by ${c.login}: ${b.note.trim().slice(0, 120)}`);
  await env.DB.prepare("UPDATE factory_packages SET status = 'staged', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status IN ('approved', 'published')")
    .bind(`approval of ${a.version ?? ""} for ${arches.join(" · ")} withdrawn by ${c.login}: ${b.note.trim().slice(0, 160)} — waits for another maintainer`, a.name)
    .run();
  const owner = f.owner;
  const record = await putRecord(env, `factory/${a.name}/decisions/${at.replace(/[:.]/g, "-")}-withdrawn.json`, { schema: "omarchy-pool/decision/1", decision: "withdrawn", name: a.name, arch: a.arch, arches, version: a.version, owner, review: a.review_id, approval: { id: a.id, task: a.task_id, rebuild_task: a.rebuild_task, by: a.by, at: a.created_at, note: a.note }, targets: void_, by: c.login, at, reason: b.note.trim(), rings });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('withdraw', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${a.name} ${a.version ?? ""} (${arches.join(", ")}): the approval by ${a.by} withdrawn by ${c.login} — ${b.note.trim().slice(0, 120)}${rings.length ? "; pulled from " + rings.map((r) => r.ring).join(", ") : ""}`, JSON.stringify({ name: a.name, arch: a.arch, arches, version: a.version, review: a.review_id, approval: a.id, task: a.task_id, rebuild_task: a.rebuild_task, approved_by: a.by, by: c.login, reason: b.note.trim(), rings, record: recordUrl(env, record.key) }))
    .run();
  await settleTargets(env, a.name);
  return json({ withdrawn: a.id, review: a.review_id, arches, task: a.task_id, rebuild_task: a.rebuild_task, by: c.login, at, rings, record: recordUrl(env, record.key) });
}

/**
 * Reject: a maintainer, never the owner, on a staged build — and with it
 * the package's builds in review: every build of it in flight or staged
 * that no standing approval decided, every architecture, contributors' and
 * the project's, stops with the note, and one review is on the record. A
 * package request rejected frees its name (#242): the registration says
 * `rejected`, and anyone may request the name again — its owner included,
 * with the note in hand. A package already in the pool keeps its name: what
 * was rejected is the new version, and the approved one stays served.
 */
export async function handleReject(c: Contributor, id: number, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: string };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string }>();
  if (!t) return json({ error: "no such task" }, 404);
  const no = refused(decisions(c, t, await factsOf(env, t)).reject);
  if (no) return no;
  if (!b.note) return json({ error: "a note saying why is required" }, 400);
  // The round: every chain of the package no standing approval decided, its builds still in flight or staged.
  const story = await storyRows(env, t.name);
  const round = chains(story.tasks, story.approvals, story.pkg, story.request)
    .filter((ch) => !ch.approval?.standing)
    .flatMap((ch) => [ch.contributor, ch.project])
    .filter((x): x is NonNullable<typeof x> => !!x && ["queued", "leased", "staged"].includes(x.status));
  if (!round.some((x) => x.id === id)) round.push({ ...(t as unknown as (typeof round)[number]) });
  const ids = round.map((x) => x.id);
  // One row per architecture on the record: its newest build in review, the project's when there is one.
  const byArch = new Map<string, (typeof round)[number]>();
  for (const x of [...round].sort((p, q) => (p.trust === "project" ? 1 : 0) - (q.trust === "project" ? 1 : 0) || p.id - q.id)) if (x.status === "staged") byArch.set(x.arch, x);
  if (!byArch.size) byArch.set(t.arch, round.find((x) => x.id === id)!);
  const decided = REPO_ARCHES.filter((a) => byArch.has(a)).map((a) => byArch.get(a)!);
  const inPool = await env.DB.prepare(`SELECT id FROM approvals WHERE name = ? AND ${standsSql()} LIMIT 1`).bind(t.name).first<{ id: number }>();
  const released = !inPool;
  const review = await env.DB.prepare("INSERT INTO reviews (name, version, decision, by, note, arches, released) VALUES (?, ?, 'rejected', ?, ?, ?, ?) RETURNING id")
    .bind(t.name, t.version, c.login, b.note, JSON.stringify(decided.map((x) => x.arch)), released ? 1 : 0)
    .first<{ id: number }>();
  // The round's last build, by the name's (name, arch, id) index: `+kind` keeps the planner off the index of every build's kind.
  const through = await env.DB.prepare("SELECT MAX(id) AS id FROM build_tasks WHERE name = ? AND +kind = 'build'").bind(t.name).first<{ id: number | null }>();
  await env.DB.batch([
    ...decided.map((x) => env.DB.prepare(`INSERT INTO approvals (task_id, name, arch, version, decision, by, note, review_id) VALUES (?, ?, ?, ?, 'rejected', ?, ?, ?)`).bind(x.id, t.name, x.arch, x.version, c.login, b.note, review?.id ?? null)),
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ?, lease_expires_at = NULL, finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('queued', 'leased', 'staged')").bind(`rejected by ${c.login}: ${b.note.slice(0, 500)}`, JSON.stringify(ids)),
    // A rejected request frees the name — this review is what freed it (freed_by_review; a contributor's block writes `rejected` too, and frees
    // nothing) — and closes the round: what it built is history, not where the package stands. A package in the pool keeps its name, and where
    // its architectures stood — what was rejected is a new version; the next one starts from the factory again.
    env.DB.prepare("UPDATE factory_packages SET status = ?, detail = ?, closed_through = MAX(closed_through, ?), freed_by_review = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
      .bind(released ? "rejected" : "registered", `rejected by ${c.login}: ${b.note.slice(0, 200)}${released ? " — the name is free again" : ""}`, released ? (through?.id ?? 0) : 0, released ? (review?.id ?? null) : null, t.name),
  ]);
  for (const x of ids) await cancelPendingAudit(env, x);
  // The note and the evidence are the record of a rejection; the package is not.
  await reclaimStagingPackages(env, ids);
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${decided.map((x) => x.arch).join(", ")}) rejected by ${c.login}: ${b.note.slice(0, 140)}${released ? " — the name is free again" : ""}`, JSON.stringify({ review: review?.id ?? null, task: id, tasks: ids, name: t.name, arch: t.arch, arches: decided.map((x) => x.arch), by: c.login, owner: t.owner, note: b.note, released }))
    .run();
  await settleTargets(env, t.name);
  return json({ task: id, decision: "rejected", by: c.login, review: review?.id ?? null, released, cancelled: ids });
}

/** An approvals row as the record lists it: the row, the build it published and where its publish job is, the registration's block. */
interface DecisionRow {
  id: number; task_id: number; name: string; arch: string; version: string | null; decision: string; by: string; note: string | null; rebuild_task: number | null; created_at: string;
  withdrawn_at: string | null; withdrawn_by: string | null; withdrawn_reason: string | null; review_id: number | null;
  rebuild_status?: string | null; rebuild_result?: string | null; blocked_at?: string | null; publish_status?: string | null;
  review_arches?: string | null; review_not_supported?: string | null; review_released?: number | null;
}

/**
 * The rows of the record (approvals), one per architecture a review
 * decided, as the reviews they are: newest first, one entry per review —
 * its word, who, the note, whether it stands — with a target per
 * architecture (the build it decided, the project's build it published,
 * where that build's publish job is, the rings serving it). A row a Worker
 * older than reviews wrote is a review of its own. The first target's
 * fields ride at the top too (id, task_id, arch, rebuild_task, …) for a
 * reader of one row per decision from before #242 — `id` stays that row's,
 * the approval id every other answer and the journal name, and the review
 * is `review`; `arches` names every architecture the review decided (the
 * review's own list, whole even where the rows given are not), `rings` is
 * every target's, and `publish_status` the one that says the most: a
 * failed or cancelled publish before one on its way, before done.
 */
export function asReviews<R extends DecisionRow>(rows: R[], ringsOf: (name: string, arch: string) => string[] = () => []) {
  const order: string[] = [];
  const groups = new Map<string, R[]>();
  for (const r of rows) {
    const key = r.review_id !== null ? `r${r.review_id}` : `a${r.id}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(r);
  }
  const worst = ["failed", "cancelled", "queued", "leased", "done"];
  return order.map((key) => {
    const g = groups.get(key)!.sort((x, y) => REPO_ARCHES.indexOf(x.arch as (typeof REPO_ARCHES)[number]) - REPO_ARCHES.indexOf(y.arch as (typeof REPO_ARCHES)[number]) || x.id - y.id);
    const first = g[0];
    const targets = g.map((r) => ({ arch: r.arch, task_id: r.task_id, rebuild_task: r.rebuild_task, version: r.version, rebuild_status: r.rebuild_status ?? null, rebuild_result: r.rebuild_result ?? null, publish_status: r.publish_status ?? null, rings: stands(r) ? ringsOf(r.name, r.arch) : [] }));
    let notSupported: Record<string, number | null> = {};
    try { notSupported = first.review_not_supported ? (JSON.parse(first.review_not_supported) as Record<string, number | null>) : {}; } catch { notSupported = {}; }
    const standing = g.some(stands);
    return {
      ...first,
      review: first.review_id,
      review_arches: undefined, review_not_supported: undefined, review_released: undefined,
      withdrawn_at: standing ? null : first.withdrawn_at,
      standing,
      arches: reviewArches(first.review_arches) ?? targets.map((x) => x.arch),
      not_supported: notSupported,
      released: first.review_released === 1,
      targets,
      rings: sortRings([...new Set(targets.flatMap((x) => x.rings))]),
      publish_status: targets.map((x) => x.publish_status).filter((s): s is string => !!s).sort((x, y) => worst.indexOf(x) - worst.indexOf(y))[0] ?? null,
    };
  });
}

/** A review's own list of the architectures it decided (reviews.arches), or null for a row with no review. */
function reviewArches(v: string | null | undefined): string[] | null {
  if (!v) return null;
  try { const a = JSON.parse(v) as unknown; return Array.isArray(a) ? (a as string[]) : null; } catch { return null; }
}

/**
 * A page of the record, each review in it whole. The record pages by row
 * (ORDER BY id DESC LIMIT n) and lists by review, so a review whose rows
 * straddle the page's end would be listed with part of its targets: those
 * are the reviews with fewer rows on the page than architectures on the
 * review (reviews.arches), and the rest of their rows — all older than the
 * page — are read by the review's index. Most pages have none, and read
 * nothing more.
 */
export async function wholeReviews<R extends DecisionRow>(rows: R[], rest: (reviews: number[], below: number) => Promise<R[]>): Promise<R[]> {
  const have = new Map<number, { n: number; of: number }>();
  for (const r of rows) {
    if (r.review_id === null) continue;
    const x = have.get(r.review_id) ?? { n: 0, of: reviewArches(r.review_arches)?.length ?? 0 };
    x.n += 1;
    have.set(r.review_id, x);
  }
  const cut = [...have].filter(([, x]) => x.n < x.of).map(([id]) => id);
  if (!cut.length) return rows;
  return [...rows, ...(await rest(cut, Math.min(...rows.map((r) => r.id))))];
}

/** The record's rows GET /factory/approvals answers, the newest first (a review cut by the page is completed). */
export const APPROVALS_PAGE = 100;

/**
 * The decisions, newest first — one per review, with its targets — and,
 * for each approval, the rings that serve the package today (`rings`), so a
 * page can show how far it got, and whether it stands (`standing`: approved
 * and not withdrawn), so no page counts a withdrawn approval as landed by
 * reading `decision` alone (#178 made an approval withdrawable; felix was
 * "landed" on the Factory and "withdrawn" on Review at once, 2026-09-17).
 * An approval that stands and no ring serves is on its way only while its
 * publish job is: each target carries the newest publish job of the build
 * it approved (`publish_status` — queued, leased, done, failed, cancelled;
 * null before #182's flow) and the row the package's `blocked_at`, so a page
 * says "publishing" of a job that is queued, not of a failed one or a
 * blocked package. One query over the factory's packages in the four rings:
 * the ring table's key is (ring, package_id), so every factory package
 * costs four seeks; the publish job is found by the build's name, arch and
 * id (idx_build_tasks_name). The record's newest APPROVALS_PAGE rows, each
 * review whole; `truncated` says older decisions exist, so a page that
 * counts over these (People's reviews and what each maintainer maintains)
 * says its number is a floor. One row more is read to know.
 */
export async function handleApprovals(env: Env): Promise<Response> {
  const select = `SELECT a.*, r.status AS rebuild_status, r.result_filename AS rebuild_result, fp.blocked_at,
              v.arches AS review_arches, v.not_supported AS review_not_supported, v.released AS review_released,
              (SELECT p.status FROM build_tasks p WHERE p.name = a.name AND p.arch = a.arch AND p.id > a.task_id AND p.kind = 'publish' AND json_extract(p.params, '$.task') = a.task_id ORDER BY p.id DESC LIMIT 1) AS publish_status
         FROM approvals a LEFT JOIN build_tasks r ON r.id = a.rebuild_task LEFT JOIN factory_packages fp ON fp.name = a.name LEFT JOIN reviews v ON v.id = a.review_id`;
  const [page, served] = await Promise.all([
    env.DB.prepare(`${select} ORDER BY a.id DESC LIMIT ?`).bind(APPROVALS_PAGE + 1).all<DecisionRow>(),
    env.DB.prepare(
      `SELECT rp.ring, p.name, p.repo_arch AS arch FROM packages p JOIN ring_packages rp ON rp.package_id = p.id AND rp.ring IN (${ringsSql(RINGS)}) WHERE p.source = 'factory'`,
    ).all<{ ring: string; name: string; arch: string }>(),
  ]);
  const rings = new Map<string, string[]>();
  for (const s of served.results) {
    const k = `${s.name}\t${s.arch}`;
    rings.set(k, sortRings([...(rings.get(k) ?? []), s.ring]));
  }
  const rows = await wholeReviews(page.results.slice(0, APPROVALS_PAGE), async (reviews, below) =>
    (await env.DB.prepare(`${select} WHERE a.review_id IN (SELECT value FROM json_each(?)) AND a.id < ?`).bind(JSON.stringify(reviews), below).all<DecisionRow>()).results);
  const approvals = asReviews(rows, (name, arch) => rings.get(`${name}\t${arch}`) ?? []);
  return json({ truncated: page.results.length > APPROVALS_PAGE, approvals }, 200, { "cache-control": "public, max-age=30" });
}
