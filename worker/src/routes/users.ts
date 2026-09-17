import { json, type Env } from "../index";
import { updateState } from "../update";
import { version as running, RINGS, ringsSql, sortRings } from "../meta";
import { queuePosition } from "../queue";
import { maintainersOf } from "../governance";
import { registrationsOf, rights, workersOf, workspace, type Contributor } from "./contributors";
import { stands } from "./review";
import { standsSql } from "./story";

/**
 * A person's public page: what they contribute and what they maintain,
 * from the record the pool already keeps — registrations, builds,
 * approvals, workers — linked to their GitHub identity. Only registered
 * logins exist here; nothing private is shown (no tokens, no e-mail).
 */
interface TrackRecord {
  /** As a contributor: distinct packages a maintainer approved, builds that produced evidence, of which bumps, builds this person's workers did for others, rejections. */
  contributed: { approved: number; staged: number; bumps: number; donated: number; rejected: number };
  /** As a maintainer: decisions signed, and approvals whose project rebuild then failed. */
  maintained: { approvals: number; rejections: number; rebuilds_failed: number };
  score: number;
}

/**
 * The track record, from the record the pool keeps anyway — approvals,
 * staged builds, bumps, donated builds. The score is one number with a
 * formula anyone can check (docs/GOVERNANCE.md): it says how much work a
 * person has done here, not who they are. The record counts every
 * approval signed, a withdrawn one included: it is history — the decision
 * was made and stays on the record — not a claim that the approval
 * stands. What stands is `standing` on each row and maintenanceOf().
 */
export function scoreOf(r: Omit<TrackRecord, "score">): number {
  const c = r.contributed, m = r.maintained;
  return 3 * c.approved + c.staged + c.bumps + c.donated - 2 * c.rejected + 2 * m.approvals + m.rejections - 3 * m.rebuilds_failed;
}

export async function recordOf(env: Env, login: string): Promise<TrackRecord> {
  const [built, reviewed, donated, decided] = await Promise.all([
    env.DB.prepare(
      `SELECT SUM(CASE WHEN staged_prefix IS NOT NULL THEN 1 ELSE 0 END) AS staged,
              SUM(CASE WHEN staged_prefix IS NOT NULL AND pkgbuild_ref LIKE 'bump:%' THEN 1 ELSE 0 END) AS bumps
         FROM build_tasks WHERE owner = ? AND kind = 'build' AND trust = 'community'`,
    ).bind(login).first<{ staged: number | null; bumps: number | null }>(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT CASE WHEN a.decision = 'approved' THEN a.name END) AS approved,
              SUM(CASE WHEN a.decision = 'rejected' THEN 1 ELSE 0 END) AS rejected
         FROM approvals a JOIN build_tasks t ON t.id = a.task_id WHERE t.owner = ?`,
    ).bind(login).first<{ approved: number | null; rejected: number | null }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS donated
         FROM build_tasks t JOIN build_workers w ON w.id = t.lease_owner
        WHERE w.owner = ? AND t.owner != ? AND t.kind = 'build' AND t.trust = 'community' AND t.staged_prefix IS NOT NULL`,
    ).bind(login, login).first<{ donated: number | null }>(),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN a.decision = 'approved' THEN 1 ELSE 0 END) AS approvals,
              SUM(CASE WHEN a.decision = 'rejected' THEN 1 ELSE 0 END) AS rejections,
              SUM(CASE WHEN a.decision = 'approved' AND r.status = 'failed' THEN 1 ELSE 0 END) AS rebuilds_failed
         FROM approvals a LEFT JOIN build_tasks r ON r.id = a.rebuild_task WHERE a.by = ?`,
    ).bind(login).first<{ approvals: number | null; rejections: number | null; rebuilds_failed: number | null }>(),
  ]);
  const r = {
    contributed: { approved: reviewed?.approved ?? 0, staged: built?.staged ?? 0, bumps: built?.bumps ?? 0, donated: donated?.donated ?? 0, rejected: reviewed?.rejected ?? 0 },
    maintained: { approvals: decided?.approvals ?? 0, rejections: decided?.rejections ?? 0, rebuilds_failed: decided?.rebuilds_failed ?? 0 },
  };
  return { ...r, score: scoreOf(r) };
}

export async function handleUser(login: string, env: Env): Promise<Response> {
  const person = await env.DB.prepare("SELECT login, name, avatar_url, role, created_at, last_seen, blocked_at, blocked_by, blocked_reason FROM contributors WHERE login = ?")
    .bind(login)
    .first<{ login: string; name: string | null; avatar_url: string | null; role: string; created_at: string; last_seen: string; blocked_at: string | null; blocked_by: string | null; blocked_reason: string | null }>();
  if (!person) return json({ error: "no such contributor" }, 404);
  const [packages, builds, counts, approvals, workers, listed, record] = await Promise.all([
    env.DB.prepare(`SELECT name, category, url, arches, status, detail, updated_at FROM factory_packages WHERE owner = ? ORDER BY name`).bind(login).all(),
    env.DB.prepare(
      `SELECT id, name, arch, version, status, reason, created_at, finished_at, duration_ms, lease_owner, pinned_to, priority, shared_after, trust FROM build_tasks
        WHERE owner = ? AND kind = 'build' ORDER BY id DESC LIMIT 50`,
    )
      .bind(login)
      .all(),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN status = 'staged' THEN 1 ELSE 0 END) AS staged,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS published,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              COUNT(*) AS total
         FROM build_tasks WHERE owner = ? AND kind = 'build'`,
    )
      .bind(login)
      .first<{ staged: number; published: number; failed: number; total: number }>(),
    env.DB.prepare(`SELECT task_id, name, arch, version, decision, note, created_at, withdrawn_at, withdrawn_by, withdrawn_reason FROM approvals WHERE by = ? ORDER BY id DESC LIMIT 50`).bind(login).all(),
    env.DB.prepare("SELECT id, arch, mode, trust, agent, version, last_seen, builds_done, builds_failed, revoked_at FROM build_workers WHERE owner = ? ORDER BY last_seen DESC").bind(login).all(),
    maintainersOf(env),
    recordOf(env, login),
  ]);
  // Packages this person approved into the pool (what they maintain, in practice): the approvals that stand, a withdrawn one no longer theirs to keep.
  const approvedNames = [...new Set((approvals.results as { name: string; decision: string; withdrawn_at: string | null }[]).filter(stands).map((a) => a.name))];
  const alive = new Date(Date.now() - 10 * 60000).toISOString();
  return json(
    {
      login: person.login,
      name: person.name,
      avatar_url: person.avatar_url,
      github: `https://github.com/${person.login}`,
      // The role from the one set the shell reads (GET /factory/maintainers, maintainersOf): listed is a maintainer, anyone else a contributor. contributors.role is the sync's copy of the same list; a login listed before its first sign-in, or a sync that failed between its two writes, must not give this page a second answer.
      role: listed.some((m) => m.login === login) ? "maintainer" : "contributor",
      blocked: person.blocked_at ? { at: person.blocked_at, by: person.blocked_by, reason: person.blocked_reason } : null,
      maintainer_since: listed.find((m) => m.login === login)?.since ?? null,
      since: person.created_at,
      last_seen: person.last_seen,
      packages: packages.results,
      builds: await Promise.all(builds.results.map(async (b) => (b.status === "queued" && b.trust === "community" ? { ...b, queue: await queuePosition(env, b as { id: number; arch: string; priority?: number; shared_after?: string | null; pinned_to?: string | null }) } : b))),
      build_counts: counts ?? { staged: 0, published: 0, failed: 0, total: 0 },
      // Every approval says whether it stands (`standing`, as GET /factory/approvals says it), and a standing one where the package is today: the rings that serve it, from the factory's rows in each ring.
      approvals: await Promise.all((approvals.results as { name: string; arch: string; decision: string; withdrawn_at: string | null }[]).map(async (a) => {
        if (!stands(a)) return { ...a, standing: false };
        const rings = (await env.DB.prepare(`SELECT DISTINCT rp.ring FROM ring_packages rp JOIN packages p ON p.id = rp.package_id WHERE p.name = ? AND p.repo_arch = ? AND p.source = 'factory' AND rp.ring IN (${ringsSql(RINGS)})`).bind(a.name, a.arch).all<{ ring: string }>()).results.map((r) => r.ring);
        return { ...a, standing: true, rings: sortRings(rings) };
      })),
      approved_packages: approvedNames,
      record,
      workers: (workers.results as { last_seen: string; version: string | null }[]).map((w) => ({ ...w, alive: w.last_seen > alive, update: updateState(w.version, running(env)) })),
    },
    200,
    { "cache-control": "public, max-age=60" },
  );
}

/**
 * GET /users/:login/can — what the caller may do on this person's page,
 * and why not: no-store, it is the caller's (the page itself is cached
 * for everyone). The predicate is workspace() in routes/contributors.ts,
 * the one the doors refuse with; Remove is answered per registration in
 * `can.packages`, from the person's registrations as they stand now, and
 * Revoke and the mode per worker in `can.workers`, revoked ones included.
 */
export async function handleUserCan(c: Contributor | null, login: string, env: Env): Promise<Response> {
  const person = await env.DB.prepare("SELECT login FROM contributors WHERE login = ?").bind(login).first<{ login: string }>();
  if (!person) return json({ error: "no such contributor" }, 404);
  const [registrations, workers] = await Promise.all([registrationsOf(env, { owner: person.login }), workersOf(env, person.login)]);
  return json({ login: person.login, can: rights(workspace(c, person.login, registrations, workers)) }, 200, { "cache-control": "no-store" });
}

/**
 * Who stands behind a package the factory built: its owner, its category,
 * the maintainers, the last approval that stands — a withdrawn one is not
 * the approval the package is served under, so the package page's "approved
 * by" card and the Packages table's approver never name it.
 */
export async function maintenanceOf(env: Env, name: string, source: string, packager: string | undefined): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { packager: packager ?? null };
  if (source !== "factory") return out;
  const pkg = await env.DB.prepare(`SELECT owner, category, url, status FROM factory_packages WHERE name = ?`).bind(name).first<{ owner: string; category: string | null; url: string; status: string }>();
  const approval = await env.DB.prepare(`SELECT by, version, arch, created_at, task_id FROM approvals WHERE name = ? AND ${standsSql()} ORDER BY id DESC LIMIT 1`)
    .bind(name)
    .first<{ by: string; version: string | null; arch: string; created_at: string; task_id: number }>();
  out.factory = {
    owner: pkg?.owner ?? null,
    url: pkg?.url ?? null,
    category: pkg?.category ?? null,
    maintainers: (await maintainersOf(env)).map((m) => m.login),
    approved_by: approval?.by ?? null,
    approved_at: approval?.created_at ?? null,
    approved_version: approval?.version ?? null,
    task: approval?.task_id ?? null,
  };
  return out;
}
