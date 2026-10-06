import { json, type Env } from "../index";
import { REPO_ARCHES, RINGS, ringsSql, sortRings, WORKER_ALIVE_MINUTES } from "../meta";
import { scoreChain } from "../score";
import { requestChecks } from "../request";
import { contributorOf, drainedRefusal, isMaintainer, MAINTAINER_DECIDES, sha256Hex, SIGN_IN, viaOf, type Contributor } from "./contributors";
import { reclaimStagingPackages } from "../staging";
import { pullFromRings } from "./blocks";
import { chains, chainOf, storyRows, stands, standsSql, type Approval, type TaskBrief } from "./story";
export { stands };
import { putRecord, recordKey, recordUrl } from "../record";
import { packageRows, parseTargets, settleTargets, targetsOf, type PackageRows, type Target, type Targets } from "../targets";
import { throughWords, type Through } from "../agents";
import { decidedWith, justNowWords, type PasskeyGate } from "./passkeys";
import { placements, type PlacementView } from "./factory";

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
 *   POST /factory/tasks/:id/approve {note?, assertion} a maintainer, never the owner, on the *project's* staged build,
 *                                           with their passkey (#271: the browser's session and an assertion for this
 *                                           build, routes/passkeys.ts webGate) → one review of the package on the
 *                                           record, covering every architecture the project built again, and a
 *                                           publish job per architecture into edge; one that never built is not
 *                                           supported, outside the decision
 *   POST /factory/tasks/:id/reject  {note}  a maintainer, never the owner, either kind of staged build → the package's
 *                                           builds in review stop, and a request is rejected: the name is free again
 *                                           (a package in the pool keeps it: a new version is what was rejected)
 *   POST /factory/tasks/:id/withdraw {note} any maintainer takes a standing review back, every architecture of it: the
 *                                           package leaves the rings
 *   POST /factory/tasks/:id/changes {note}  a maintainer, never the owner, either kind of staged build → changes
 *                                           requested: the package's builds in review stop, as a rejection's do, and
 *                                           the round goes back to the factory with the note — the name stays the
 *                                           requester's
 *   POST /factory/tasks/:id/release {reason} the maintainer who claimed the package or another, never the owner → the
 *                                           claim let go, whole, while a rebuild of it is still queued or running:
 *                                           every rebuild of the claim is cancelled — the ones staged beside it too —
 *                                           and the package waits for a claim again (a claim whose rebuilds all staged
 *                                           is decided, not released)
 *   POST /factory/tasks/:id/any-host {assertion} a maintainer, never its requester, on the project's rebuild still queued
 *                                           that only its requester's hosts have a lane for (#339, D35: the project's
 *                                           copy is not built on its requester's host while another maintainer's can) →
 *                                           released to any host, with their passkey (any-host:<task>): on the task
 *                                           (params.any_host), the journal and the record
 *   POST /factory/packages/:name/adopt {reason?} Review's No maintainer tab posts to the one Adopt (routes/adopt.ts): a
 *                                           package its owner left unmaintained, with nothing of it in review, becomes
 *                                           the adopter's — its maintainer in the pool, and the registration theirs
 *   GET  /factory/approvals                 the record (public), one row per review with its `targets`; `standing` on
 *                                           every row — a review not withdrawn
 *
 * Every decision — a claim, approve, changes, reject, release, an adoption
 * that takes a registration (routes/adopt.ts), a withdrawal, and a block and
 * its lift (routes/blocks.ts) — is written once to the record, signed by the
 * pool (record.ts), and is a journal line that names who took it, through
 * which door (`via`: the web's session or a token) and the agent the review
 * rests on: the one that rebuilt each
 * architecture on the project's review worker (`built_with`, what the worker
 * ran when it staged the rebuild), else the maintainer's choice at the claim.
 * Review's decisions are beside the package's request
 * (factory/<name>/<request>/decision-<time>-<word>-<id>.json, decisionRecord
 * below); a withdrawal is at factory/<name>/decisions/<time>-withdrawn.json,
 * and a block's are routes/blocks.ts's. A decision is taken once — a second
 * one on the same builds, sent at the same moment, is refused (the review and
 * its rows are written by one conditional statement each, in one batch) — and
 * never rewritten: what takes an approval back is a block, or the withdrawal
 * a maintainer writes a reason for (#178), each a decision of its own on the
 * record.
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
  params: string | null;
}

export async function handleReviewList(env: Env, request: Request): Promise<Response> {
  const c = await contributorOf(request, env);
  const staged = await env.DB.prepare(
    `SELECT t.id, t.name, t.arch, t.version, t.owner, t.status, t.trust, t.params, t.staged_prefix, t.result_sha256, t.result_filename, t.duration_ms, t.created_at, t.finished_at, t.pkgbuild_ref, t.result, t.attempts,
            t.lease_owner, w.owner AS worker_owner, w.labels AS worker_labels, w.hostname AS worker_hostname, w.trusted_by AS worker_trusted_by, w.agent AS worker_agent,
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
  // A contributor's build that the project is building again, or built: the review row says so — and who claimed it, with the agent they chose (the claim's params: `by`, `agent`), since when.
  const projectOf = new Map<number, { id: number; status: string; error: string | null; worker: string | null; attempts: number; result: string | null; trial_status: string | null; trial_result: string | null; by: string | null; agent: string | null; at: string | null }>();
  const builds = await env.DB.prepare(
    `SELECT id, name, arch, status, error, params, lease_owner, pinned_to, attempts, result, created_at,
            (SELECT u.status FROM build_tasks u WHERE u.kind = 'trial' AND u.name = b.name AND json_extract(u.params, '$.task') = b.id ORDER BY u.id DESC LIMIT 1) AS trial_status,
            (SELECT u.result FROM build_tasks u WHERE u.kind = 'trial' AND u.name = b.name AND json_extract(u.params, '$.task') = b.id ORDER BY u.id DESC LIMIT 1) AS trial_result
       FROM build_tasks b WHERE kind = 'build' AND trust = 'project' AND json_extract(params, '$.review') IS NOT NULL AND status IN ('queued', 'leased', 'staged', 'failed', 'done') ORDER BY id`,
  ).all<{ id: number; name: string; arch: string; status: string; error: string | null; params: string; lease_owner: string | null; pinned_to: string | null; attempts: number; result: string | null; created_at: string | null; trial_status: string | null; trial_result: string | null }>();
  for (const b of builds.results) {
    const p = JSON.parse(b.params) as { review?: number; by?: string; agent?: string | null };
    const from = Number(p.review);
    if (from) projectOf.set(from, { id: b.id, status: b.status, error: b.error, worker: b.lease_owner ?? b.pinned_to, attempts: b.attempts, result: b.result, trial_status: b.trial_status, trial_result: b.trial_result, by: p.by ?? null, agent: p.agent ?? null, at: b.created_at });
  }
  // The project's copy of a package while it is queued (#339, D35): where it may run — kept off its requester's hosts, held when only
  // theirs can build it — and whether the caller may release it to any host (anyHostVerdict). The fleet is read only when one is queued.
  const queuedCopies = [...projectOf.values()].filter((b) => b.status === "queued").map((b) => b.id);
  const placed = queuedCopies.length ? await placements(env, queuedCopies) : new Map<number, PlacementView>();
  const placementOf = (name: string, from: number, pb: { id: number; status: string }) => {
    const pl = placed.get(pb.id);
    if (!pl) return null;
    const v = anyHostVerdict(c, { id: pb.id, name, kind: "build", trust: "project", status: pb.status, params: JSON.stringify({ review: from }) }, pl);
    return { ...pl, any_host: { ok: v.ok, why: v.ok ? null : v.why } };
  };
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
  const fromRows = new Map<number, { id: number; owner: string | null; attempts: number; status: string; result: string | null; version: string | null; pkgbuild_ref: string | null; audit_status: string | null; audit_result: string | null }>();
  if (fromIds.length) {
    const rows = await env.DB.prepare(
      `SELECT t.id, t.owner, t.attempts, t.status, t.result, t.version, t.pkgbuild_ref,
              (SELECT u.status FROM build_tasks u WHERE u.kind = 'audit' AND u.name = t.name AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_status,
              (SELECT u.result FROM build_tasks u WHERE u.kind = 'audit' AND u.name = t.name AND json_extract(u.params, '$.task') = t.id ORDER BY u.id DESC LIMIT 1) AS audit_result
         FROM build_tasks t WHERE t.id IN (${fromIds.map(() => "?").join(", ")})`,
    ).bind(...fromIds).all<{ id: number; owner: string | null; attempts: number; status: string; result: string | null; version: string | null; pkgbuild_ref: string | null; audit_status: string | null; audit_result: string | null }>();
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
  // Whose claim a row is under: the project's rebuild of a contributor's build while it is in flight or staged, or the project's row itself (its own params say who asked and with which agent; the worker that built it, when none was chosen).
  const claimRow = (r: Record<string, unknown>) => {
    if (r.trust === "project") {
      const p = r.params ? (JSON.parse(r.params as string) as { by?: string; agent?: string | null }) : {};
      return { task: r.id as number, status: r.status as string, by: p.by ?? null, agent: p.agent ?? (r.worker_agent as string | null) ?? null, at: (r.created_at as string | null) ?? null };
    }
    const pb = projectOf.get(r.id as number);
    return pb && ["queued", "leased", "staged"].includes(pb.status) ? { task: pb.id, status: pb.status, by: pb.by, agent: pb.agent, at: pb.at } : null;
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
      requesters: requestersOf(r.package_owner as string | null, r.owner as string | null, from !== null ? fromRows.get(from)?.owner : null),
      already: prior.some((x) => x.task_id === id),
      inFlight: pb && ["queued", "leased", "staged"].includes(pb.status) ? { id: pb.id, status: pb.status } : null,
      standing: prior.some((x) => halves.includes(x.task_id) || (x.rebuild_task !== null && halves.includes(x.rebuild_task))),
      packaged: r.trust !== "project" || packaged.has(id),
      claim: claimOf(buildsOf(r.name as string)),
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
    project_build: r.trust === "community" ? (() => { const pb = projectOf.get(r.id as number); return pb ? { id: pb.id, status: pb.status, error: pb.error, worker: pb.worker, by: pb.by, agent: pb.agent, at: pb.at, placement: placementOf(r.name as string, r.id as number, pb) } : null; })() : null,
    // The claim the row is under (#247): the project's rebuild a maintainer asked for — the contributor's row's, or the project's row itself — while it is queued, running or staged; who asked, the agent they chose, since when. Review's queue says "claimed by", and Release reads it.
    claim: claimRow(r),
    built_by: builtBy(r),
    // The agent that drafted the build, as its worker reported it: the factory's, on a contributor's row; the project's review worker's, on the project's.
    agent: (r.worker_agent as string | null) ?? null,
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
    worker_agent: undefined,
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
  // Each package's place in the queue by the one rule (queueOf) — the one a package's story weighs its own rows by (queueOfStory).
  const queue = new Map<string, QueueState>();
  for (const name of new Set(shaped.map((t) => col(t, "name") as string))) {
    queue.set(name, queueOf(shaped.filter((t) => col(t, "name") === name).map((t) => ({ id: col(t, "id") as number, kind: t.kind, ready: t.ready, already: t.already, project_build: t.project_build, claim: t.claim }))));
  }
  const lead = new Map([...queue].filter(([, q]) => q.lead !== null).map(([name, q]) => [name, q.lead as number]));
  const rows = shaped.map((t) => ({ ...t, ready: undefined, lead: lead.get(col(t, "name") as string) === col(t, "id") })).map((t) => ({ ...t, waits: waitsForMaintainer(t) }));
  const waiting = rows.filter((t) => t.waits);
  const ages = waiting.map((t) => Date.now() - Date.parse((t as { finished_at?: string | null }).finished_at ?? "")).filter((ms) => Number.isFinite(ms) && ms > 0);
  // One entry per package in the list, newest first: its rows, the one that speaks for it, where its architectures stand.
  // Where it stands in Review's queue (#247), by one rule, here — the page files it by this word and keeps no rule of its own, and the two
  // numbers beside `waiting` are counted from it: `ready`, waiting for a claim (its lead waits and nothing claims it: no project rebuild of
  // it is queued, running or staged — one that failed hands it back); `in_review`, claimed (the project's rebuild a maintainer asked for is
  // in flight or staged, `claim` says whose); null, neither — an architecture still building, or a build of a version already approved.
  const packages: { name: string; owner: string | null; version: string | null; category: string | null; targets: Targets; lead: number | null; waits: boolean; rows: number[]; claim: ReturnType<typeof claimRow>; state: "ready" | "in_review" | null }[] = [];
  for (const t of rows) {
    const name = col(t, "name") as string;
    let p = packages.find((x) => x.name === name);
    if (!p) packages.push((p = { name, owner: (col(t, "owner") as string | null) ?? null, version: (col(t, "version") as string | null) ?? null, category: (col(t, "category") as string | null) ?? null, targets: t.targets, lead: lead.get(name) ?? null, waits: false, rows: [], claim: null, state: null }));
    p.rows.push(col(t, "id") as number);
    if (t.waits) p.waits = true;
    if (!p.claim && t.claim) p.claim = t.claim;
  }
  for (const p of packages) p.state = queue.get(p.name)?.state ?? null;
  return json(
    { staged: rows, waiting: waiting.length, oldest_ms: ages.length ? Math.max(...ages) : null, ready: packages.filter((p) => p.state === "ready").length, in_review: packages.filter((p) => p.state === "in_review").length, packages },
    200,
    { "cache-control": "no-store" },
  );
}

/** A staged build no standing approval decided, as its package's place in the queue weighs it: whether it may speak for the package (`ready`: nothing else of the package builds, it is where its architecture stands, and a project's build has every architecture built again), a version already approved, the project's build of a contributor's build, whether a claim is on it. */
export interface QueueRow { id: number; kind: string; ready: boolean; already: unknown; project_build: { status: string } | null; claim: unknown }
/** Where a package stands in Review's queue: the row that speaks for it (`lead`), and the list's word — in_review, ready, or neither (null). */
export interface QueueState { lead: number | null; state: "ready" | "in_review" | null }

/**
 * The one rule of a package's place in Review's queue, over its staged rows no standing approval decided, newest first. The row that speaks
 * for it (`lead`): the project's newest build when the review can decide on it, else the contributor's newest build the project has yet to
 * build again (waitsForMaintainer). The state: in_review while a claim is on one of its rows (the project's rebuild a maintainer asked for is
 * queued, running or staged); ready, waiting for a claim, while a row speaks for it; else neither — an architecture still building, a build
 * of a version already approved, a contributor's build the project built again and published. The list files every package by it, and a
 * package's story weighs its own rows by it (queueOfStory): its page says the list's word without reading the list (#282).
 */
export function queueOf(rows: QueueRow[]): QueueState {
  const lead = (["project", "contributor"] as const).map((kind) => rows.find((t) => t.kind === kind && t.ready && waitsForMaintainer({ ...t, lead: true }))).find(Boolean) ?? null;
  return { lead: lead ? lead.id : null, state: rows.some((t) => t.claim) ? "in_review" : lead ? "ready" : null };
}

/**
 * A package's place in Review's queue from its own story (story.ts: its newest tasks and approvals, its stored targets): the rows the list
 * would hold of it — each staged build no standing approval decided, nor one on the project's build of it — with the facts the list reads
 * of each (packageFacts, `already`, the project's build of it, the claim), weighed by queueOf. Null when the list would not name it: nothing
 * of it is staged and undecided. No read of its own: a package's page gets it with the story it asks for anyway.
 */
export function queueOfStory(tasks: TaskBrief[], approvals: Approval[], targets: Targets): QueueState | null {
  const builds = tasks.filter((t) => t.kind === "build").map((t) => ({ id: t.id, arch: t.arch, status: t.status, trust: t.trust, version: t.version ?? null, review: typeof t.params.review === "number" ? t.params.review : null }));
  const p = buildsOfPackage({ builds, decisions: approvals });
  const standsOn = (id: number) => approvals.some((a) => stands(a) && a.task_id === id);
  const prior = approvals.filter(stands);
  const rows: QueueRow[] = builds
    .filter((b) => b.status === "staged" && !standsOn(b.id) && !builds.some((r) => r.trust === "project" && r.review === b.id && standsOn(r.id)))
    .sort((x, y) => y.id - x.id)
    .map((r) => {
      const f = packageFacts(r, p, targets);
      const pb = r.trust === "community" ? (p.project.find((b) => b.review === r.id) ?? null) : null;
      return {
        id: r.id,
        kind: r.trust === "project" ? "project" : "contributor",
        ready: !f.building && !f.rebuilding && !f.superseded && !(r.trust === "project" && f.unbuilt),
        already: prior.some((a) => a.arch === r.arch && a.version === r.version && a.task_id !== r.id && a.rebuild_task !== r.id),
        project_build: pb,
        claim: r.trust === "project" || (!!pb && ["queued", "leased", "staged"].includes(pb.status)),
      };
    });
  return rows.length ? queueOf(rows) : null;
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
export type Decision = "approve" | "reject" | "build" | "withdraw" | "changes" | "release";
/** The decisions in the order a page reads them: the four of every build's Decision cell, then Review's two (#247) — request changes, and let a claim go. */
export const DECISIONS: Decision[] = ["approve", "reject", "build", "withdraw", "changes", "release"];

/** What the pages read: true where the caller may, else the reason a person reads in the button's title. */
export interface Can {
  approve: boolean;
  reject: boolean;
  build: boolean;
  withdraw: boolean;
  changes: boolean;
  release: boolean;
  why: Partial<Record<Decision, string>>;
}

/**
 * A decision allowed, or refused with the status the POST answers, the
 * reason, and — for the refusals an agent acts on — a code it can say
 * plainly without parsing the sentence: `sign_in`, `maintainer_only`, and
 * `conflict_of_interest` for a maintainer who asked for the package (#247;
 * the MCP proposal's review tools read it). The role comes first, so a
 * requester who is not a maintainer is told `maintainer_only`: what they
 * lack to decide on any package, theirs or not. Nobody signed in hears
 * `sign_in` from the door before the predicate runs (index.ts, nobody()).
 */
type Verdict = { ok: true } | { ok: false; status: 401 | 403 | 404 | 409; why: string; code?: "sign_in" | "maintainer_only" | "conflict_of_interest" };

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
export function buildsOfPackage(rows: { builds: Omit<PackageRows["builds"][number], "publish">[]; decisions: PackageRows["decisions"] }): PackageBuilds {
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

/**
 * What the predicate needs beyond the row: the registration's owner, who
 * asked for the build (`requesters`), a standing approval on the task, the
 * project's build in flight, a standing approval anywhere on the chain, a
 * package still in staging (a project's build the sweep emptied has nothing
 * to publish), the claim — what a release lets go — and what the package
 * says (packageFacts).
 */
interface Facts extends PackageFacts { owner: string | null; requesters: string[]; already: boolean; inFlight: { id: number; status: string } | null; standing: boolean; packaged: boolean; claim: number[] }

/**
 * The claim on a package, as a release lets it go: the project's rebuilds a
 * maintainer's claim queued and nobody decided — one press of "Build by the
 * project" queues one per architecture, and they stage one by one — while
 * one of them is still queued or running. Those, and the ones already
 * staged beside them (their contributor's build still undecided): the claim
 * is one round, let go whole, so the package really waits for a claim again
 * (a release of the queued half left the staged half in review with nothing
 * on the page to move it, 2026-09-29). A claim whose rebuilds all staged is
 * none: a maintainer decides it, nobody releases it.
 */
export function claimOf(p: Pick<PackageBuilds, "project" | "staged">): number[] {
  const live = (b: PackageBuilds["project"][number]) => b.status === "queued" || b.status === "leased";
  if (!p.project.some(live)) return [];
  const undecided = new Set(p.staged.map((s) => s.id));
  return p.project.filter((b) => live(b) || (b.status === "staged" && undecided.has(b.review))).map((b) => b.id);
}

/** The contributor's build a project's rebuild answers (its params' `review`), or null for any other task. */
function reviewOf(params: string | null | undefined): number | null {
  if (!params) return null;
  try { const r = (JSON.parse(params) as { review?: unknown }).review; return typeof r === "number" ? r : null; } catch { return null; }
}

/** Who asked for a build, as the conflict of interest reads it: the registration's owner today, the build's own owner, and — for the project's rebuild — the owner of the contributor's build it answers. An adoption moves the registration, never who asked for a build in review. */
function requestersOf(...logins: (string | null | undefined)[]): string[] {
  return [...new Set(logins.filter((l): l is string => typeof l === "string" && l !== ""))];
}

export function decisions(c: Contributor | null, t: Decidable, f: Facts): Record<Decision, Verdict> {
  const allow: Verdict = { ok: true };
  const no = (status: 401 | 403 | 404 | 409, why: string, code?: "sign_in" | "maintainer_only" | "conflict_of_interest"): Verdict => ({ ok: false, status, why, ...(code ? { code } : {}) });
  // The two reasons every decision shares: nobody signed in, or somebody who is not a maintainer — the words a person's page greys Withdraw with (workspace() in routes/contributors.ts).
  const person = !c ? no(401, SIGN_IN, "sign_in") : !isMaintainer(c) ? no(403, MAINTAINER_DECIDES, "maintainer_only") : null;
  const notStaged = t.status !== "staged" ? no(409, `task ${t.id} is ${t.status}, not staged`) : null;
  // Conflict of interest: nobody decides on their own package, and a project with a single maintainer is no
  // exception — that maintainer's own packages wait for a second one (/docs/governance). Claiming it is deciding
  // on it too (the claim is the project's rebuild), and so is letting a claim on it go. Their own is the
  // registration's today and every build they asked for: a package adopted from them is still not theirs to
  // review while a build they asked for is in review (an adoption once made the requester a stranger to it).
  const owner = c && (f.owner === c.login || f.requesters.includes(c.login)) ? no(403, `you brought ${t.name} — another maintainer decides; with one maintainer, that maintainer's own packages wait`, "conflict_of_interest") : null;
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
    // Request changes: a rejection that keeps the name the requester's — the same rule, the same round stopped.
    changes: person ?? notStaged ?? owner ?? (f.standing ? no(409, "already approved — withdraw the approval first") : null) ?? allow,
    // Release: the claim let go — the maintainer who claimed it or another, never the requester, who may not claim it
    // either. Only a rebuild still queued or running is released: a staged one is the project's build a maintainer
    // decides on, and a claim released already has nothing left to let go.
    release: person ?? owner ?? (!f.claim.length ? no(409, `nothing to release: no rebuild of ${t.name} is queued or running — a staged rebuild is decided, not released`) : null) ?? allow,
  };
}

/** The verdicts as a page reads them. */
export function can(v: Record<Decision, Verdict>): Can {
  const why: Partial<Record<Decision, string>> = {};
  for (const d of DECISIONS) {
    const x = v[d];
    if (!x.ok) why[d] = x.why;
  }
  return { approve: v.approve.ok, reject: v.reject.ok, build: v.build.ok, withdraw: v.withdraw.ok, changes: v.changes.ok, release: v.release.ok, why };
}

/** The refusal a POST answers: the reason, with its status — and its code, where the predicate gives one. */
function refused(v: Verdict): Response | null {
  return v.ok ? null : json(v.code ? { error: v.why, code: v.code } : { error: v.why }, v.status);
}

/** The agent a worker reported (build_workers.agent, "<provider>/<model>"), by the worker's id: one read by the primary key; null for no worker or none reported. */
export async function workerAgent(env: Env, worker: string | null | undefined): Promise<string | null> {
  if (!worker) return null;
  return (await env.DB.prepare("SELECT agent FROM build_workers WHERE id = ?").bind(worker).first<{ agent: string | null }>())?.agent ?? null;
}

const stamp = (): string => new Date().toISOString().replace(/[-:.Z]/g, "");

/**
 * A decision on the record: one JSON document beside the package's request
 * (factory/<name>/<request>/decision-<time>-<word>-<id>.json), written once
 * and signed by the pool (record.ts). The id is the decision's own — the
 * review's, the rebuild's, the adopter's — so two decisions on one package in
 * one millisecond never share a key (two approvals sent at once named one
 * record, and the second overwrote the first, 2026-09-29), and the bucket
 * refuses a key it holds (putRecord's conditional put) rather than rewrite
 * it. The decision is already in the database when this runs: a record the
 * bucket refused is said in the answer and the journal line (`record: null`,
 * and the reason), not a decision undone.
 */
export async function decisionRecord(env: Env, name: string, word: string, id: string | number, doc: Record<string, unknown>): Promise<{ url: string | null; error?: string }> {
  try {
    const pkg = await env.DB.prepare("SELECT request_id FROM factory_packages WHERE name = ?").bind(name).first<{ request_id: number | null }>();
    const file = `decision-${stamp()}-${word}-${String(id).replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
    const key = pkg?.request_id ? recordKey(name, pkg.request_id, file) : `factory/${name}/0/${file}`;
    const record = await putRecord(env, key, { schema: "omarchy-pool/decision/1", decision: word, name, ...doc });
    return { url: recordUrl(env, record.key) };
  } catch (e) {
    console.error(`the record of ${word} on ${name} was not written: ${String(e)}`);
    return { url: null, error: String(e) };
  }
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
async function factsOf(env: Env, t: Decidable & { owner: string | null; version?: string | null; params?: string | null }): Promise<Facts & { approval: Approval | null; builds: PackageBuilds; targets: Targets }> {
  // The project's rebuild answers a contributor's build: whoever asked for that one asked for this one too (requestersOf), by the primary key.
  const from = t.trust === "project" ? reviewOf(t.params) : null;
  const [owner, already, approval, packaged, rows, asked] = await Promise.all([
    ownerOf(env, t.name, t.owner),
    env.DB.prepare(`SELECT id FROM approvals WHERE task_id = ? AND ${standsSql()}`).bind(t.id).first(),
    standingApproval(env, t.name, t.id),
    t.trust === "project" ? env.DB.prepare("SELECT 1 AS one FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst' LIMIT 1").bind(t.id).first() : Promise.resolve(true),
    packageRows(env, t.name, { unregistered: true }),
    from !== null ? env.DB.prepare("SELECT owner FROM build_tasks WHERE id = ?").bind(from).first<{ owner: string | null }>() : Promise.resolve(null),
  ]);
  const builds = rows ? buildsOfPackage(rows) : { building: [], staged: [], project: [] };
  const targets = rows ? targetsOf(rows.arches, rows.builds, rows.decisions, rows.closedThrough) : {};
  // The project's build of this one, queued, running or staged: the newest, from the same rows.
  const pb = builds.project.find((b) => b.review === t.id && ["queued", "leased", "staged"].includes(b.status));
  const inFlight = pb ? { id: pb.id, status: pb.status } : null;
  return { owner, requesters: requestersOf(owner, t.owner, asked?.owner), already: !!already, inFlight, standing: !!approval, packaged: !!packaged, claim: claimOf(builds), approval, builds, targets, ...packageFacts({ ...t, version: t.version ?? null }, builds, targets) };
}

/** GET /factory/tasks/:id/can — what the caller may do on this task, and why not: no-store, it is the caller's. */
export async function handleTaskCan(c: Contributor | null, id: number, env: Env): Promise<Response> {
  const t = await env.DB.prepare("SELECT id, name, arch, trust, status, owner, version, params FROM build_tasks WHERE id = ?").bind(id).first<Decidable & { owner: string | null; version: string | null; params: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  return json({ task: id, can: can(decisions(c, t, await factsOf(env, t))) }, 200, { "cache-control": "no-store" });
}

/** The decisions an agent drafts (#252), by the words the tool takes, and the one each is on the web. */
export const DRAFTED: Readonly<Record<"approve" | "request_changes" | "reject", "approve" | "changes" | "reject">> = { approve: "approve", request_changes: "changes", reject: "reject" };

/**
 * The web's predicate on one task for a verdict an agent drafts, and again
 * when the person confirms it (routes/agents.ts): the task, and a digest of
 * the facts it was decided on — or the web's own refusal, with its status,
 * its words and its code (conflict_of_interest for the requester). The rule
 * stays decisions()'s; this only reads it. The digest is what the confirm
 * compares: the task, who brought it, the decisions on it, the claim, what
 * is building or rebuilding, and where each architecture stands (the
 * targets, by the one rule) — so a package that moved between the draft and
 * the confirm (an architecture rebuilt, staged or failed) is not confirmed
 * on facts the agent never saw.
 */
export async function verdictOn(c: Contributor, id: number, word: "approve" | "changes" | "reject", env: Env): Promise<{ task: { id: number; name: string; arch: string; trust: string; status: string; version: string | null }; facts: string } | Response> {
  const t = await env.DB.prepare("SELECT id, name, arch, trust, status, owner, version, params FROM build_tasks WHERE id = ? AND kind = 'build'").bind(id).first<Decidable & { owner: string | null; version: string | null; params: string | null }>();
  if (!t) return json({ error: "no such build" }, 404);
  const f = await factsOf(env, t);
  const no = refused(decisions(c, t, f)[word]);
  if (no) return no;
  const targets = Object.keys(f.targets).sort().map((a) => [a, f.targets[a].status, f.targets[a].task]);
  const facts = await sha256Hex(JSON.stringify({ task: t.id, status: t.status, version: t.version, owner: f.owner, requesters: f.requesters, standing: f.standing, already: f.already, claim: f.claim, inFlight: f.inFlight, building: f.building, rebuilding: f.rebuilding, unbuilt: f.unbuilt, superseded: f.superseded, targets }));
  return { task: { id: t.id, name: t.name, arch: t.arch, trust: t.trust, status: t.status, version: t.version }, facts };
}

/**
 * "Build it by the project" — a claim (#247): a maintainer, never the owner,
 * on a contributor's staged build. The project builds the package again on
 * workers it trusts, with its own agent — the request, the contributor's
 * PKGBUILD, log, gate and audit as the lesson, never the product — through
 * the same gate, staged like any build. One review covers the package, so
 * the project builds every architecture its contributor built: this one,
 * and each other architecture its target says is built, at this version,
 * that the project is not building yet (a failed one is asked again) —
 * never an older build of an architecture whose newest one failed. Then a
 * maintainer approves *those*.
 *
 * The maintainer's choice of agent is the worker they name for this
 * architecture; each other architecture goes to a live project worker of it
 * with the same agent when there is one (an idle one first), else to any
 * project worker — and what each ran is kept when it stages (built_with,
 * routes/factory.ts). A claim is one maintainer's: the rebuild of this build
 * is queued by one conditional statement, so a second claim sent at the
 * same moment is refused with whose it is. Claiming is deciding on the
 * package, so it is signed on the record and a journal line like the rest.
 */
/**
 * Another architecture's rebuild goes to a live project worker of it with the same agent, an idle one first — never a drained one
 * (#277): it would wait until it is resumed; nor one of the package's requesters (#339, D35; the last binding, their logins): it would
 * wait for a release.
 */
export const SAME_AGENT_SQL = "SELECT id FROM build_workers WHERE arch = ? AND trust = 'project' AND revoked_at IS NULL AND drained_at IS NULL AND agent = ? AND agent_status = 'ok' AND last_seen > ? AND (kinds IS NULL OR EXISTS (SELECT 1 FROM json_each(kinds) WHERE value = 'build')) AND (owner IS NULL OR owner NOT IN (SELECT value FROM json_each(?))) ORDER BY current_task IS NOT NULL, last_seen DESC LIMIT 1";

export async function handleProjectBuild(c: Contributor, id: number, request: Request, env: Env, through?: Through): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: unknown; worker?: unknown };
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string }>();
  if (!t) return json({ error: "no such task" }, 404);
  const f = await factsOf(env, t);
  const no = refused(decisions(c, t, f).build);
  if (no) return no;
  const owner = f.owner;
  // Where it runs: one of the project's workers that builds this architecture, when the maintainer says which (the native one, not the emulated one).
  let pinned: string | null = null, agent: string | null = null;
  if (typeof b.worker === "string" && b.worker.trim()) {
    const w = await env.DB.prepare("SELECT id, arch, owner, kinds, agent, agent_status, drained_at, drained_by, drain_reason FROM build_workers WHERE id = ? AND revoked_at IS NULL AND trust = 'project'").bind(b.worker.trim()).first<{ id: string; arch: string; owner: string | null; kinds: string | null; agent: string | null; agent_status: string | null; drained_at: string | null; drained_by: string | null; drain_reason: string | null }>();
    if (!w || w.arch !== t.arch) return json({ error: `${b.worker} is not a project worker for ${t.arch}` }, 400);
    // The project's copy of a package is not built on its requester's host (#339, D35): pinned to one, it would wait for a release.
    if (w.owner && f.requesters.includes(w.owner)) return json({ error: `${w.id} is ${w.owner}'s, who brought ${t.name}: the project's copy of a package is not built on its requester's host — choose another maintainer's`, code: "requester_host" }, 409);
    // A drained worker is handed nothing until it is resumed (#277): pinned to it, the rebuild would wait for it.
    if (w.drained_at) return json({ error: drainedRefusal(w) }, 409);
    // The claim gives a review build only to a worker that declares builds and whose agent answered; pinned to another, it would wait forever.
    const kinds = w.kinds ? (JSON.parse(w.kinds) as string[]) : [];
    if (kinds.length && !kinds.includes("build")) return json({ error: `${w.id} does not take builds (it declares ${kinds.join(", ")})` }, 400);
    if (w.agent_status !== "ok") return json({ error: `${w.id} has no agent that answers; the project's build is drafted by one` }, 400);
    pinned = w.id;
    // The maintainer's choice of agent is the worker's: the one that drafts the rebuild (#247), on the record with the claim.
    agent = w.agent;
  }
  // This build first — the claim's own, the conditional one below — then each other architecture the review covers (othersOf) that the project is not already building or has built.
  const others = othersOf(t, f.builds, f.targets).filter((s) => !f.builds.project.some((p) => p.review === s.id && ["queued", "leased", "staged"].includes(p.status)));
  const from = [{ id, arch: t.arch, version: t.version }, ...others.sort((x, y) => REPO_ARCHES.indexOf(x.arch as (typeof REPO_ARCHES)[number]) - REPO_ARCHES.indexOf(y.arch as (typeof REPO_ARCHES)[number]))];
  const round = JSON.stringify(from.map((s) => s.id));
  const pkg = await env.DB.prepare("SELECT request_id, project, source, release, description, license FROM factory_packages WHERE name = ?").bind(t.name).first<{ request_id: number | null; project: string | null; source: string | null; release: string | null; description: string | null; license: string | null }>();
  // The same agent on the other architectures: a live project worker of that architecture that builds, whose agent answered — an idle one first. build_workers is the project's and the contributors' machines, a few dozen rows.
  const alive = new Date(Date.now() - WORKER_ALIVE_MINUTES * 60000).toISOString();
  // Never a worker of the package's requester (#339, D35): the project's copy is not built on its requester's host, so pinned to one it
  // would wait for a release. The statement leaves them out, so another maintainer's live worker with the same agent is found whichever
  // claimed last; with none, the rebuild of that architecture goes unpinned, to any other maintainer's host that runs it.
  const sameAgent = async (arch: string): Promise<string | null> =>
    agent ? ((await env.DB.prepare(SAME_AGENT_SQL).bind(arch, agent, alive, JSON.stringify(f.requesters)).first<{ id: string }>())?.id ?? null) : null;
  const queued: { task: number; arch: string; from: number; pinned_to: string | null; agent: string | null }[] = [];
  for (const s of from) {
    const pin = s.id === id ? pinned : await sameAgent(s.arch);
    // The maintainer's note is on the record and is the hint the project's agent drafts with (the worker reads params.hint) — the web's, never an agent's (#252):
    // text that passed through an agent, which may have read the requester's instructions, is not the maintainer's word, so a claim made with an agent token keeps its note for people and leaves the hint null.
    // What the rebuild starts from is the request's facts, the maintainer's word and the contributor's text evidence as the lesson (read through the public evidence routes): never a staged object of the contributor's — no package, no staging prefix, no checksum — and its job's token reads no staging but its own (jobtoken.ts), so the factory's packages are never downloaded, let alone reused (#247; test/review.test.ts holds it).
    const params = { review: s.id, request: pkg?.request_id ?? null, project: pkg?.project ?? null, source: pkg?.source ?? null, version: pkg?.release ?? s.version, description: pkg?.description ?? null, license: pkg?.license ?? null, owner, by: c.login, ...(through ? { through } : {}), agent: pin ? agent : null, note, hint: note && !through ? note.slice(0, 600) : null };
    // Queued only while no rebuild of the round is queued, running or staged: two claims sent at once are one claim (the name's index, then each row's params).
    const row = await env.DB.prepare(CLAIM_SQL)
      .bind(t.name, s.arch, s.version, `review:${s.id}`, `project build asked by ${c.login}`, owner, JSON.stringify(params), pin, t.name, s.id === id ? round : JSON.stringify([s.id]))
      .first<{ id: number }>();
    if (row) queued.push({ task: row.id, arch: s.arch, from: s.id, pinned_to: pin, agent: pin ? agent : null });
    else if (s.id === id) {
      const by = await env.DB.prepare("SELECT json_extract(params, '$.by') AS by FROM build_tasks WHERE name = ? AND +kind = 'build' AND +trust = 'project' AND +status IN ('queued', 'leased', 'staged') AND json_extract(params, '$.review') IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT 1").bind(t.name, round).first<{ by: string | null }>();
      return json({ error: `${t.name} was claimed a moment ago${by?.by ? ` by ${by.by}` : ""}: the project is already on it` }, 409);
    }
  }
  queued.sort((x, y) => REPO_ARCHES.indexOf(x.arch as (typeof REPO_ARCHES)[number]) - REPO_ARCHES.indexOf(y.arch as (typeof REPO_ARCHES)[number]));
  const arches = queued.map((q) => q.arch).join(" · ");
  const lead = queued.find((q) => q.from === id)!;
  await env.DB.prepare("UPDATE factory_packages SET detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`${t.version ?? ""} for ${arches}: the project is building it (task${queued.length > 1 ? "s" : ""} ${queued.map((q) => q.task).join(", ")}), asked by ${c.login}`, t.name)
    .run();
  const via = viaOf(request), at = new Date().toISOString();
  const record = await decisionRecord(env, t.name, "claim", lead.task, { version: t.version, arches: queued.map((q) => q.arch), owner, from: id, tasks: queued, by: c.login, via, ...(through ? { through } : {}), agent, pinned_to: pinned, at, note });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('review', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${arches}): ${c.login} asked the project to build it${throughWords(through)} — ${queued.map((q) => `task ${q.task} from ${owner ?? "?"}'s build ${q.from}`).join(", ")}${agent ? ` — claimed with ${agent}` : ""}`, JSON.stringify({ task: lead.task, tasks: queued, from: id, name: t.name, arch: t.arch, arches: queued.map((q) => q.arch), by: c.login, via, ...(through ? { through } : {}), agent, pinned_to: pinned, owner, note, record: record.url, ...(record.error ? { record_error: record.error } : {}) }))
    .run();
  await settleTargets(env, t.name);
  return json({ task: lead.task, tasks: queued.map((q) => q.task), arches: queued.map((q) => q.arch), from: id, by: c.login, pinned_to: pinned, agent, ...(through ? { through, hint: null } : {}), record: record.url });
}

/**
 * A claim's rebuild, queued only while none of the round is: no project
 * rebuild of the builds named (`review` in its params) queued, running or
 * staged. One statement, so D1 serialises two claims sent at once and the
 * second queues nothing. Led by the name ((name, arch, id) index; `+` keeps
 * the planner there), then each of its rows' params.
 */
export const CLAIM_SQL = `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, params, pinned_to)
  SELECT ?, ?, ?, ?, ?, 30, 0, 'project', ?, 'build', ?, ?
   WHERE NOT EXISTS (SELECT 1 FROM build_tasks r WHERE r.name = ? AND +r.kind = 'build' AND +r.trust = 'project' AND +r.status IN ('queued', 'leased', 'staged') AND json_extract(r.params, '$.review') IN (SELECT value FROM json_each(?)))
  RETURNING id`;

// ---------- the project's copy, released to any host (#339, design v2 §8.4; D35) ----------

/**
 * Who may release the project's copy of a package to any host (D35), and
 * when: a maintainer — never one of its requesters, whose hosts it is kept
 * off — on a review rebuild still queued and not released yet, that only its
 * requesters' hosts have a lane allowed for (`placement.held`). While
 * another maintainer's host has one, it waits for that host, not for a
 * release; a rebuild no host can run now waits for one as any build does.
 * The same predicate draws Review's button and refuses at the door.
 */
export function anyHostVerdict(c: Contributor | null, t: { id: number; name: string; kind: string; trust: string; status: string; params: string | null }, p: PlacementView | null): Verdict {
  const no = (status: 401 | 403 | 409, why: string, code?: "sign_in" | "maintainer_only" | "conflict_of_interest"): Verdict => ({ ok: false, status, why, ...(code ? { code } : {}) });
  if (!c) return no(401, SIGN_IN, "sign_in");
  if (!isMaintainer(c)) return no(403, MAINTAINER_DECIDES, "maintainer_only");
  if (t.kind !== "build" || t.trust !== "project" || reviewOf(t.params) === null) return no(409, `task ${t.id} is not the project's copy of a package: only a review rebuild is kept off its requester's hosts`);
  if (t.status !== "queued" || !p) return no(409, `task ${t.id} is ${t.status === "leased" ? "building" : t.status}: only a rebuild still queued waits for a host`);
  if (p.requesters.includes(c.login)) return no(403, `you brought ${t.name} — another maintainer releases its rebuild to any host, as another decides on it`, "conflict_of_interest");
  if (p.released) return no(409, `released to any host by ${p.released.by} already`);
  if (p.others.length) return no(409, `${p.others.join(", ")} — another maintainer's — can build it: the project's copy waits for that host, not for a release`);
  if (!p.mine.length) return no(409, "no host can build it now, its requester's included: it waits for one as any build does — nothing to release");
  return { ok: true };
}

/** A release to any host, written once: only while the rebuild is still queued and nobody released it (two maintainers at once write one). */
export const ANY_HOST_SQL = "UPDATE build_tasks SET params = json_set(COALESCE(params, '{}'), '$.any_host', json(?)) WHERE id = ? AND status = 'queued' AND json_extract(params, '$.any_host') IS NULL";

/**
 * POST /factory/tasks/:id/any-host {assertion} — the project's copy of a
 * maintainer's package, held off their hosts while no other maintainer's
 * host has a lane allowed for it (D35), released to any host by another
 * maintainer with their passkey for exactly this rebuild (`any-host:<task>`,
 * routes/passkeys.ts webGate): any host may take it from then on, its
 * requester's included. On the task (`params.any_host`: who, when, the
 * passkey), the journal and the record.
 */
export async function handleAnyHost(c: Contributor, id: number, request: Request, env: Env, gate?: PasskeyGate): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { assertion?: unknown };
  const t = await env.DB.prepare("SELECT id, name, arch, kind, trust, status, params FROM build_tasks WHERE id = ?").bind(id).first<{ id: number; name: string; arch: string; kind: string; trust: string; status: string; params: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  const p = (await placements(env, [id])).get(id) ?? null;
  const no = refused(anyHostVerdict(c, t, p));
  if (no || !p) return no ?? json({ error: "nothing to release" }, 409);
  // Fail closed: a door that forgets the gate releases nothing.
  if (!gate) return json({ error: "a release to any host is confirmed with a passkey, and this door asks for none: nothing was released", code: "passkey_required" }, 403);
  const confirmed = await gate(b.assertion);
  if (confirmed instanceof Response) return confirmed;
  const at = new Date().toISOString();
  const set = await env.DB.prepare(ANY_HOST_SQL).bind(JSON.stringify({ by: c.login, at, passkey: confirmed.passkey }), id).run();
  if (!set.meta.changes) return json({ error: `${t.name}'s rebuild (task ${id}) was released, or left the queue, a moment ago: nothing was released` }, 409);
  const via = viaOf(request);
  const record = await decisionRecord(env, t.name, "any-host", id, { task: id, arch: t.arch, requesters: p.requesters, hosts: p.mine, by: c.login, via, passkey: confirmed.passkey, at });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('review', NULL, 'factory', 'warn', ?, ?)")
    .bind(
      `${t.name} for ${t.arch} (task ${id}): released to any host by ${c.login}${justNowWords(confirmed)} — only ${p.requesters.join(", ")}'s hosts can build it, and the project's copy is not built on its requester's host while another maintainer's can`,
      JSON.stringify({ task: id, name: t.name, arch: t.arch, action: "any_host", by: c.login, via, passkey: confirmed.passkey, requesters: p.requesters, hosts: p.mine, record: record.url, ...(record.error ? { record_error: record.error } : {}) }),
    )
    .run();
  return json({ task: id, any_host: { by: c.login, at }, passkey: confirmed.passkey, hosts: p.mine, record: record.url });
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
export async function handleApprove(c: Contributor, id: number, request: Request, env: Env, through?: Through, gate?: PasskeyGate): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: unknown; assertion?: unknown };
  const note = typeof b.note === "string" ? b.note : null;
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string; params: string | null; result_filename: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  const f = await factsOf(env, t);
  const no = refused(decisions(c, t, f).approve);
  if (no) return no;
  // What users get changes here: decided with a passkey (#271) — the draft's, confirmed in the browser, or the web's own answer for this build — checked once the act is allowed and before anything is written; never skipped.
  const confirmed = await decidedWith(through, gate, b.assertion);
  if (confirmed instanceof Response) return confirmed;
  const passkey = confirmed.passkey, owner = f.owner;
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
  const targets: { t: Staged & { trust: string }; files: string[]; trial: string; agent: string | null }[] = [];
  for (const r of rows) {
    const files = (await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ? AND key LIKE '%.pkg.tar.zst'").bind(r.id).all<{ key: string }>()).results.map((x) => x.key.slice(x.key.lastIndexOf("/") + 1));
    if (!files.length) return json({ error: r.id === id ? "the project's build left no package in staging" : `the project's build of ${r.arch} (task ${r.id}) left no package in staging` }, 409);
    // The fast lane: a build a real pacman installed from the lab (the trial's
    // verdict) goes to rc and stable with edge — the publish job's token gets
    // those rings only then. Evidence decides the speed; the maintainer decided the build.
    const trial = trialOf(...(await latestTrial(env, r.id)));
    targets.push({ t: r, files, trial: trial.status === "done" ? (trial.verdict ?? "unknown") : trial.status, agent: await rebuiltWith(env, r) });
  }
  const arches = targets.map((x) => x.t.arch);
  // The review and its rows, taken at once: a second approval — or a rejection — of these builds sent at the same moment writes nothing.
  const review = await takeRound(env, { name: t.name, version: t.version, decision: "approved", by: c.login, note, arches, notSupported, through, rows: targets.map((x) => ({ task: x.t.id, arch: x.t.arch, version: x.t.version, rebuild: x.t.id })) });
  if (review === null) return decidedAlready(env, t.name, targets.map((x) => x.t.id));
  const publishes: Record<string, number> = {};
  for (const x of targets) {
    // The review it publishes is `review_id`: `review` in a task's params names the contributor's build a project's build answers, and every reader of a task (its page's provenance, the claim's upload, the job's scopes) reads it so.
    const publish = await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, params) VALUES (?, ?, ?, '-', ?, 20, 1, 'project', NULL, 'publish', ?) RETURNING id`,
    )
      .bind(t.name, x.t.arch, x.t.version, `approved by ${c.login}`, JSON.stringify({ task: x.t.id, name: t.name, arch: x.t.arch, version: x.t.version, files: x.files, by: c.login, trial: x.trial, review_id: review }))
      .first<{ id: number }>();
    if (publish) publishes[x.t.arch] = publish.id;
  }
  const ns = Object.keys(notSupported);
  await env.DB.prepare("UPDATE factory_packages SET status = 'approved', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`${t.version ?? ""} for ${arches.join(" · ")} approved by ${c.login}${ns.length ? ` (${ns.join(" · ")} not supported)` : ""}; publishing the project's build${arches.length > 1 ? "s" : ""} (job${arches.length > 1 ? "s" : ""} ${Object.values(publishes).join(", ")})`, t.name)
    .run();
  for (const x of targets) await cancelPendingAudit(env, x.t.id);
  // Signed and journaled: who, through which door, and the agent that rebuilt what ships — per architecture, what its review worker ran (rebuiltWith); `agent` is this build's.
  const via = viaOf(request), agent = targets.find((x) => x.t.id === id)?.agent ?? null, at = new Date().toISOString();
  const record = await decisionRecord(env, t.name, "approve", `r${review}`, { version: t.version, arches, not_supported: notSupported, owner, review, targets: targets.map((x) => ({ arch: x.t.arch, task: x.t.id, files: x.files, trial: x.trial, publish: publishes[x.t.arch] ?? null, agent: x.agent })), by: c.login, via, ...(through ? { through } : { passkey }), agent, at, note });
  // A first use of a passkey registered just now — in the Approve dialog itself, #287 — says so on the line.
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', 'edge', 'factory', 'ok', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${arches.join(", ")}${ns.length ? `; ${ns.join(", ")} not supported` : ""}) approved by ${c.login}${justNowWords(confirmed)}${throughWords(through)}${withAgents(targets.map((x) => ({ arch: x.t.arch, agent: x.agent })))}${note ? " — " + note.slice(0, 120) : ""}; the project's build${arches.length > 1 ? "s" : ""} ${targets.map((x) => x.t.id).join(", ")} go${arches.length > 1 ? "" : "es"} into edge (job${arches.length > 1 ? "s" : ""} ${Object.values(publishes).join(", ")})`, JSON.stringify({ review, task: id, publish: publishes[t.arch], publishes, name: t.name, arch: t.arch, arches, not_supported: notSupported, by: c.login, via, ...(through ? { through } : { passkey }), ...(confirmed.justNow ? { registered_just_now: true } : {}), agent, agents: Object.fromEntries(targets.map((x) => [x.t.arch, x.agent])), owner, note, record: record.url, ...(record.error ? { record_error: record.error } : {}) }))
    .run();
  await settleTargets(env, t.name);
  return json({ task: id, decision: "approved", by: c.login, publish: publishes[t.arch], publishes, review, arches, not_supported: notSupported, via, ...(through ? { through } : { passkey }), agent, record: record.url });
}

/**
 * The agent that rebuilt a project's build: what its review worker ran when
 * it staged it (params.built_with, routes/factory.ts), else the one the
 * maintainer chose at the claim (params.agent), else — a rebuild staged
 * before either was kept — the worker's agent now. A worker re-reports its
 * agent with every claim, so its row is the last resort, never the first: a
 * worker that switched model after the rebuild would have the pool sign the
 * wrong one.
 */
async function rebuiltWith(env: Env, t: { params?: string | Record<string, unknown> | null; lease_owner: string | null }): Promise<string | null> {
  let p: { built_with?: unknown; agent?: unknown } = {};
  try { p = typeof t.params === "string" ? (JSON.parse(t.params) as typeof p) : (t.params ?? {}); } catch { p = {}; }
  if (typeof p.built_with === "string" && p.built_with) return p.built_with;
  if (typeof p.agent === "string" && p.agent) return p.agent;
  return workerAgent(env, t.lease_owner);
}

/** The journal's words for the agents a decision rests on: " (rebuilt with A)", or each architecture's when they differ; nothing when none is known. */
function withAgents(xs: { arch: string; agent: string | null }[]): string {
  const known = xs.filter((x) => x.agent);
  if (!known.length) return "";
  const one = [...new Set(known.map((x) => x.agent))];
  return one.length === 1 ? ` (rebuilt with ${one[0]})` : ` (rebuilt with ${known.map((x) => `${x.agent} on ${x.arch}`).join(", ")})`;
}

/** No live decision on any of the builds named — an approvals row not withdrawn: what both statements of a decision's batch write under. */
const UNDECIDED = "NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id IN (SELECT value FROM json_each(?)) AND a.withdrawn_at IS NULL)";
/** A decision's review, written only while its builds are undecided (UNDECIDED; the approvals' task index). */
export const REVIEW_SQL = `INSERT INTO reviews (name, version, decision, by, note, arches, not_supported, released, changes) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${UNDECIDED} RETURNING id`;
/**
 * Its rows, one per build decided, under the same condition, with the review
 * just written (the name's newest, by the reviews' (name, id) index) — and,
 * for a decision an agent drafted and the person confirmed (#252), the agent
 * it came through (approvals.agent, each row's `through`), in the same
 * statement: never a second write after the decision.
 */
export const ROWS_SQL = `INSERT INTO approvals (task_id, name, arch, version, decision, by, note, rebuild_task, review_id, agent)
  SELECT json_extract(j.value, '$.task'), ?, json_extract(j.value, '$.arch'), json_extract(j.value, '$.version'), ?, ?, ?, json_extract(j.value, '$.rebuild'), (SELECT MAX(id) FROM reviews WHERE name = ?), json_extract(j.value, '$.through')
    FROM json_each(?) j WHERE ${UNDECIDED}`;

/**
 * A decision taken: its review and one approvals row per build it decided,
 * in one batch — a transaction, nothing runs between its two statements —
 * each written only while no live decision is on any of those builds. Two
 * decisions sent at once on the same builds (two approvals; changes and a
 * rejection) are one decision: the facts both read said "undecided", and the
 * second batch writes nothing. The review's id, or null: decided already.
 */
async function takeRound(env: Env, r: { name: string; version: string | null; decision: "approved" | "rejected"; by: string; note: string | null; arches: string[]; notSupported?: Record<string, number | null>; released?: boolean; changes?: boolean; through?: Through; rows: { task: number; arch: string; version: string | null; rebuild: number | null }[] }): Promise<number | null> {
  const decided = JSON.stringify(r.rows.map((x) => x.task));
  const [review] = await env.DB.batch([
    env.DB.prepare(REVIEW_SQL).bind(r.name, r.version, r.decision, r.by, r.note, JSON.stringify(r.arches), JSON.stringify(r.notSupported ?? {}), r.released ? 1 : 0, r.changes ? 1 : 0, decided),
    env.DB.prepare(ROWS_SQL).bind(r.name, r.decision, r.by, r.note, r.name, JSON.stringify(r.rows.map((x) => (r.through ? { ...x, through: r.through } : x))), decided),
  ]);
  return (review.results[0] as { id?: number } | undefined)?.id ?? null;
}

/** The 409 of a decision another maintainer took a moment before: what it was and whose. */
async function decidedAlready(env: Env, name: string, tasks: number[]): Promise<Response> {
  const d = await env.DB.prepare("SELECT decision, by FROM approvals WHERE task_id IN (SELECT value FROM json_each(?)) AND withdrawn_at IS NULL ORDER BY id DESC LIMIT 1").bind(JSON.stringify(tasks)).first<{ decision: string; by: string }>();
  return json({ error: `${name} was decided a moment ago${d ? `: ${d.decision} by ${d.by}` : ""}` }, 409);
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
  const b = (await request.json().catch(() => ({}))) as { note?: unknown };
  const t = await env.DB.prepare("SELECT id, name, arch, trust, status, owner FROM build_tasks WHERE id = ?").bind(id).first<Decidable & { owner: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  const f = await factsOf(env, t);
  const no = refused(decisions(c, t, f).withdraw);
  if (no) return no;
  // The input after the predicate, as in the other three handlers: a caller who may not is told so, whatever they sent.
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length < 4) return json({ error: "a note saying why is required — it goes on the record" }, 400);
  const a = { ...f.approval!, name: t.name };
  const at = new Date().toISOString();
  // The review, whole: every row of it that stands (a row a Worker older than reviews wrote is a review of its own).
  const void_ = a.review_id !== null
    ? (await env.DB.prepare(`SELECT id, arch, task_id, rebuild_task FROM approvals WHERE review_id = ? AND ${standsSql()} ORDER BY id`).bind(a.review_id).all<{ id: number; arch: string; task_id: number; rebuild_task: number | null }>()).results
    : [{ id: a.id, arch: a.arch, task_id: a.task_id, rebuild_task: a.rebuild_task }];
  const arches = void_.map((x) => x.arch);
  await env.DB.batch([
    env.DB.prepare("UPDATE approvals SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE id IN (SELECT value FROM json_each(?))").bind(at, c.login, note.slice(0, 500), JSON.stringify(void_.map((x) => x.id))),
    ...(a.review_id !== null ? [env.DB.prepare("UPDATE reviews SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE id = ? AND withdrawn_at IS NULL").bind(at, c.login, note.slice(0, 500), a.review_id)] : []),
  ]);
  // Out of every ring it reached through this review; the registration is evidence again.
  const rings = await pullFromRings(env, a.name, `approval of ${a.name} ${a.version ?? ""} withdrawn by ${c.login}: ${note.slice(0, 120)}`);
  await env.DB.prepare("UPDATE factory_packages SET status = 'staged', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status IN ('approved', 'published')")
    .bind(`approval of ${a.version ?? ""} for ${arches.join(" · ")} withdrawn by ${c.login}: ${note.slice(0, 160)} — waits for another maintainer`, a.name)
    .run();
  const owner = f.owner;
  const via = viaOf(request);
  const record = await putRecord(env, `factory/${a.name}/decisions/${at.replace(/[:.]/g, "-")}-withdrawn.json`, { schema: "omarchy-pool/decision/1", decision: "withdrawn", name: a.name, arch: a.arch, arches, version: a.version, owner, review: a.review_id, approval: { id: a.id, task: a.task_id, rebuild_task: a.rebuild_task, by: a.by, at: a.created_at, note: a.note }, targets: void_, by: c.login, via, agent: null, at, reason: note, rings });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('withdraw', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${a.name} ${a.version ?? ""} (${arches.join(", ")}): the approval by ${a.by} withdrawn by ${c.login} — ${note.slice(0, 120)}${rings.length ? "; pulled from " + rings.map((r) => r.ring).join(", ") : ""}`, JSON.stringify({ name: a.name, arch: a.arch, arches, version: a.version, review: a.review_id, approval: a.id, task: a.task_id, rebuild_task: a.rebuild_task, approved_by: a.by, by: c.login, via, agent: null, reason: note, rings, record: recordUrl(env, record.key) }))
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
export async function handleReject(c: Contributor, id: number, request: Request, env: Env, through?: Through): Promise<Response> {
  return closeRound(c, id, request, env, "reject", through);
}

/**
 * Request changes (#247): the round stops as a rejection's does — every
 * build of the package in review, every architecture — and goes back to the
 * factory with the note, but the name stays the requester's: the
 * registration is `registered` again, theirs to build once more, and never
 * free. On the record it is a rejection that asked for changes
 * (reviews.changes): the requester reads the note, and a package in the pool
 * keeps its name and what it serves, as with a rejection.
 */
export async function handleChanges(c: Contributor, id: number, request: Request, env: Env, through?: Through): Promise<Response> {
  return closeRound(c, id, request, env, "changes", through);
}

/** The round of a package's review closed by a maintainer: rejected (a request's name freed), or sent back with changes asked for (the name kept). */
async function closeRound(c: Contributor, id: number, request: Request, env: Env, word: "reject" | "changes", through?: Through): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { note?: unknown };
  const t = await env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<Staged & { trust: string }>();
  if (!t) return json({ error: "no such task" }, 404);
  const no = refused(decisions(c, t, await factsOf(env, t))[word]);
  if (no) return no;
  // The input after the predicate, and before any write: a note that is not text is none (a number once wrote the review, then failed on it).
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (!note) return json({ error: word === "changes" ? "a note saying what to change is required — the requester reads it" : "a note saying why is required" }, 400);
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
  // Only a rejection frees a name, and only a request's; changes asked for close the round and keep it the requester's.
  const released = word === "reject" && !inPool;
  const closes = !inPool;
  const done = word === "changes" ? `changes requested by ${c.login}` : `rejected by ${c.login}`;
  // The review and its rows, taken at once: changes and a rejection — or two of either — sent at the same moment are one decision.
  const review = await takeRound(env, { name: t.name, version: t.version, decision: "rejected", by: c.login, note, arches: decided.map((x) => x.arch), released, changes: word === "changes", through, rows: decided.map((x) => ({ task: x.id, arch: x.arch, version: x.version, rebuild: null })) });
  if (review === null) return decidedAlready(env, t.name, decided.map((x) => x.id));
  // The round's last build, by the name's (name, arch, id) index: `+kind` keeps the planner off the index of every build's kind.
  const lastBuild = await env.DB.prepare("SELECT MAX(id) AS id FROM build_tasks WHERE name = ? AND +kind = 'build'").bind(t.name).first<{ id: number | null }>();
  await env.DB.batch([
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ?, lease_expires_at = NULL, finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('queued', 'leased', 'staged')").bind(`${done}: ${note.slice(0, 500)}`, JSON.stringify(ids)),
    // A rejected request frees the name — this review is what freed it (freed_by_review; a contributor's block writes `rejected` too, and frees
    // nothing) — and closes the round: what it built is history, not where the package stands. Changes asked for close the round the same way
    // and keep the name: the registration is the requester's to build again. A package in the pool keeps its name, and where its
    // architectures stood — what was rejected is a new version; the next one starts from the factory again.
    env.DB.prepare("UPDATE factory_packages SET status = ?, detail = ?, closed_through = MAX(closed_through, ?), freed_by_review = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
      .bind(released ? "rejected" : "registered", `${done}: ${note.slice(0, 200)}${released ? " — the name is free again" : word === "changes" && closes ? " — back to the factory, the name stays the requester's" : ""}`, closes ? (lastBuild?.id ?? 0) : 0, released ? review : null, t.name),
  ]);
  for (const x of ids) await cancelPendingAudit(env, x);
  // The note and the evidence are the record of a rejection; the package is not.
  await reclaimStagingPackages(env, ids);
  // Signed and journaled: who, through which door, and the agent that rebuilt each architecture for the review, where the project had (rebuiltWith).
  const rebuilt = await Promise.all(decided.filter((x) => x.trust === "project" && x.status === "staged").map(async (x) => ({ arch: x.arch, agent: await rebuiltWith(env, x) })));
  const via = viaOf(request), agent = rebuilt.find((x) => x.agent)?.agent ?? null, at = new Date().toISOString();
  const arches = decided.map((x) => x.arch);
  const record = await decisionRecord(env, t.name, word, `r${review}`, { version: t.version, arches, owner: t.owner, review, tasks: ids, released, by: c.login, via, ...(through ? { through } : {}), agent, agents: Object.fromEntries(rebuilt.map((x) => [x.arch, x.agent])), at, note });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('approve', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${arches.join(", ")}) ${done}${throughWords(through)}: ${note.slice(0, 140)}${released ? " — the name is free again" : word === "changes" ? " — back to the factory, the name stays the requester's" : ""}`, JSON.stringify({ review, task: id, tasks: ids, name: t.name, arch: t.arch, arches, decision: word === "changes" ? "changes_requested" : "rejected", by: c.login, via, ...(through ? { through } : {}), agent, owner: t.owner, note, released, record: record.url, ...(record.error ? { record_error: record.error } : {}) }))
    .run();
  await settleTargets(env, t.name);
  return json({ task: id, decision: word === "changes" ? "changes_requested" : "rejected", by: c.login, review, released, cancelled: ids, via, ...(through ? { through } : {}), agent, record: record.url });
}

/**
 * Release (#247; the MCP proposal's review_release): a claim let go, so
 * another maintainer can take the package. The claim is the project's
 * rebuild "Build by the project" queued — one per architecture — and the
 * maintainer who claimed it or another may let it go; never the requester,
 * who may not claim it either (the predicate's `release`). It goes whole
 * (claimOf): every rebuild of the claim, the ones still queued or running
 * and the ones staged beside them, cancelled by one conditional update that
 * changes nothing unless one of them is still queued or running — a claim
 * whose rebuilds all staged in the meantime is decided, not released, and a
 * second release finds nothing to cancel: both are a 409. A leased worker's
 * lease is void, and what the claim staged goes (its packages; the text
 * evidence stays). Nothing is decided: the package waits for a claim again.
 * On the record and in the journal, with whose claim it was, who let it go,
 * through which door, the agent the claim had chosen, and why — naming only
 * the rebuilds the update cancelled.
 */
export async function handleRelease(c: Contributor, id: number, request: Request, env: Env, through?: Through): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { reason?: string };
  const t = await env.DB.prepare("SELECT id, name, arch, trust, status, owner, version, params FROM build_tasks WHERE id = ?").bind(id).first<Decidable & { owner: string | null; version: string | null; params: string | null }>();
  if (!t) return json({ error: "no such task" }, 404);
  const f = await factsOf(env, t);
  const no = refused(decisions(c, t, f).release);
  if (no) return no;
  // The input after the predicate, as in the other handlers: a caller who may not is told so, whatever they sent.
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 4) return json({ error: "a reason is required; it is on the record" }, 400);
  // The claim's own rows, by their primary keys: who made it and with which agent (its params), where it runs.
  const rows = (await env.DB.prepare(CLAIM_ROWS_SQL).bind(JSON.stringify(f.claim)).all<{ id: number; arch: string; status: string; lease_owner: string | null; pinned_to: string | null; by: string | null; agent: string | null }>()).results;
  const res = await env.DB.prepare(RELEASE_SQL).bind(`claim released by ${c.login}${throughWords(through)}: ${reason.slice(0, 300)}`, JSON.stringify(f.claim), JSON.stringify(f.claim)).all<{ id: number; arch: string }>();
  const gone = res.results.map((r) => r.id);
  if (!gone.length) return json({ error: `nothing to release: no rebuild of ${t.name} is queued or running — released already, or staged and decided, not released` }, 409);
  // What the claim had staged, or a leased worker had put there: the lease is void, its next PUT is refused, the packages go — of the rebuilds cancelled here, never another's.
  for (const x of gone) await cancelPendingAudit(env, x);
  await reclaimStagingPackages(env, gone);
  const let_ = rows.filter((r) => gone.includes(r.id));
  const claimedBy = let_.map((r) => r.by).find((x) => !!x) ?? null;
  const agent = let_.map((r) => r.agent).find((x) => !!x) ?? (await workerAgent(env, let_.map((r) => r.lease_owner ?? r.pinned_to).find((x) => !!x) ?? null));
  const arches = REPO_ARCHES.filter((a) => let_.some((r) => r.arch === a));
  const staged = let_.filter((r) => r.status === "staged").map((r) => r.arch);
  const via = viaOf(request), at = new Date().toISOString();
  const whose = `${claimedBy === c.login ? `${c.login}'s claim released` : `${claimedBy ?? "the"}${claimedBy ? "'s" : ""} claim released by ${c.login}`}${throughWords(through)}`;
  await env.DB.prepare("UPDATE factory_packages SET detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?")
    .bind(`${whose}: ${reason.slice(0, 200)} — waiting for a maintainer's claim again`, t.name)
    .run();
  const record = await decisionRecord(env, t.name, "release", gone[0], { version: t.version, arches, staged, owner: f.owner, tasks: gone, claimed_by: claimedBy, by: c.login, via, ...(through ? { through } : {}), agent, at, reason });
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('review', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${t.name} ${t.version ?? ""} (${arches.join(", ")}): ${whose}${agent ? ` (the rebuild with ${agent} stopped)` : ""}${staged.length ? `, the rebuild staged for ${staged.join(", ")} with it` : ""} — ${reason.slice(0, 120)}`, JSON.stringify({ name: t.name, arches, staged, tasks: gone, claimed_by: claimedBy, by: c.login, via, ...(through ? { through } : {}), agent, reason, record: record.url, ...(record.error ? { record_error: record.error } : {}) }))
    .run();
  await settleTargets(env, t.name);
  return json({ released: t.name, tasks: gone, arches, staged, claimed_by: claimedBy, by: c.login, via, ...(through ? { through } : {}), agent, record: record.url });
}

/**
 * POST /factory/tasks/:id/cancel by hand — a maintainer's session or token,
 * not the enqueue job's (index.ts). That door stops any queued or running
 * task with no rule about whose it is and no line in the journal, so two
 * kinds of task are not its to stop (#247): a rebuild a maintainer's claim
 * queued is let go through /release — never by the requester, with a
 * reason, signed and journaled — and the publish job of an approval that
 * stands is stopped by what takes an approval back, a block, on the record
 * too. The requester is refused as the release would refuse them; anyone
 * else is told which door is the claim's or the approval's. null: the
 * cancel goes on (a build, an audit, a trial, a job of the pool's).
 */
export async function cancelByHand(c: Contributor, id: number, env: Env): Promise<Response | null> {
  const t = await env.DB.prepare("SELECT id, name, kind, trust, status, params FROM build_tasks WHERE id = ?").bind(id).first<{ id: number; name: string; kind: string; trust: string; status: string; params: string | null }>();
  if (!t || (t.status !== "queued" && t.status !== "leased")) return null;
  let p: { review?: unknown; task?: unknown; by?: unknown } = {};
  try { p = t.params ? (JSON.parse(t.params) as typeof p) : {}; } catch { p = {}; }
  if (t.kind === "build" && t.trust === "project" && typeof p.review === "number") {
    const from = await env.DB.prepare("SELECT id, name, arch, trust, status, owner, version, params FROM build_tasks WHERE id = ?").bind(p.review).first<Decidable & { owner: string | null; version: string | null; params: string | null }>();
    const v = from ? decisions(c, from, await factsOf(env, from)).release : null;
    if (v && !v.ok && v.code === "conflict_of_interest") return refused(v);
    return json({ error: `task ${id} is ${typeof p.by === "string" ? `${p.by}'s` : "a maintainer's"} claim on ${t.name}: let it go with POST /api/v1/factory/tasks/${p.review}/release and a reason — it goes on the record` }, 409);
  }
  if (t.kind === "publish" && typeof p.task === "number") {
    const a = await env.DB.prepare(`SELECT by FROM approvals WHERE task_id = ? AND ${standsSql()} LIMIT 1`).bind(p.task).first<{ by: string }>();
    if (a) return json({ error: `task ${id} publishes ${t.name}, approved by ${a.by}: what takes an approval back is a block (POST /api/v1/factory/packages/${t.name}/block), on the record` }, 409);
  }
  return null;
}

/** The claim's rows, by their primary keys: who made it and with which agent (its params), where it runs. */
export const CLAIM_ROWS_SQL = "SELECT id, arch, status, lease_owner, pinned_to, json_extract(params, '$.by') AS by, json_extract(params, '$.agent') AS agent FROM build_tasks WHERE id IN (SELECT value FROM json_each(?))";
/**
 * The claim let go: every rebuild of it queued, running or staged cancelled,
 * only while one of them is still queued or running (evaluated once, before
 * any row changes) — and the ids it cancelled, the only ones the release
 * reclaims and names. Led by the ids (the primary key): `+status` keeps the
 * planner off the index of every task's status, which it chose over the
 * claim's own rows.
 */
export const RELEASE_SQL = `UPDATE build_tasks SET status = 'cancelled', error = ?, lease_expires_at = NULL, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id IN (SELECT value FROM json_each(?)) AND +status IN ('queued', 'leased', 'staged')
    AND EXISTS (SELECT 1 FROM build_tasks l WHERE l.id IN (SELECT value FROM json_each(?)) AND +l.status IN ('queued', 'leased'))
  RETURNING id, arch`;

/** An approvals row as the record lists it: the row, the build it published and where its publish job is, the registration's block. */
interface DecisionRow {
  id: number; task_id: number; name: string; arch: string; version: string | null; decision: string; by: string; note: string | null; rebuild_task: number | null; created_at: string;
  withdrawn_at: string | null; withdrawn_by: string | null; withdrawn_reason: string | null; review_id: number | null;
  rebuild_status?: string | null; rebuild_result?: string | null; blocked_at?: string | null; publish_status?: string | null;
  review_arches?: string | null; review_not_supported?: string | null; review_released?: number | null; review_changes?: number | null;
  /** approvals.agent (#252): the agent a decision was drafted through, as JSON — served parsed, as `through`, never under `agent`, which is the rebuild's agent (#247). */
  agent?: string | null;
}

/** The agent a decision came through (approvals.agent), parsed; null for the web's and the command line's. */
function throughOf(v: string | null | undefined): Through | null {
  if (!v) return null;
  try { const t = JSON.parse(v) as unknown; return t && typeof t === "object" ? (t as Through) : null; } catch { return null; }
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
      review_arches: undefined, review_not_supported: undefined, review_released: undefined, review_changes: undefined,
      // Who a decision an agent drafted came through (#252) — the agent, its client, the grant, the draft — parsed; `agent` stays #247's word for the rebuild's agent, and is not the column's.
      agent: undefined,
      through: throughOf(first.agent),
      withdrawn_at: standing ? null : first.withdrawn_at,
      standing,
      arches: reviewArches(first.review_arches) ?? targets.map((x) => x.arch),
      not_supported: notSupported,
      released: first.review_released === 1,
      // A rejection that asked for changes (#247): the round went back to the factory, the name stayed the requester's.
      changes: first.review_changes === 1,
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
              v.arches AS review_arches, v.not_supported AS review_not_supported, v.released AS review_released, v.changes AS review_changes,
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
