import { json, type Env } from "../index";
import { version as running, RINGS, ringsSql, sortRings } from "../meta";
import { queuePosition } from "../queue";
import { maintainersOf } from "../governance";
import { landed, registrationsOf, rights, workersOf, workspace, type Contributor } from "./contributors";
import { asReviews, stands, wholeReviews } from "./review";
import { aliveSince, workerView, type WorkerRow } from "./factory";
import { standsSql } from "./story";
import { parseTargets } from "../targets";

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
 * stands. What stands is `standing` on each row and maintenanceOf(). A
 * decision is a review of a package (#242), counted once whatever the
 * architectures it covered: its rows share a review_id (a row older than
 * reviews is one of its own).
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
              COUNT(DISTINCT CASE WHEN a.decision = 'rejected' THEN COALESCE(a.review_id, -a.id) END) AS rejected
         FROM approvals a JOIN build_tasks t ON t.id = a.task_id WHERE t.owner = ?`,
    ).bind(login).first<{ approved: number | null; rejected: number | null }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS donated
         FROM build_tasks t JOIN build_workers w ON w.id = t.lease_owner
        WHERE w.owner = ? AND t.owner != ? AND t.kind = 'build' AND t.trust = 'community' AND t.staged_prefix IS NOT NULL`,
    ).bind(login, login).first<{ donated: number | null }>(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT CASE WHEN a.decision = 'approved' THEN COALESCE(a.review_id, -a.id) END) AS approvals,
              COUNT(DISTINCT CASE WHEN a.decision = 'rejected' THEN COALESCE(a.review_id, -a.id) END) AS rejections,
              COUNT(DISTINCT CASE WHEN a.decision = 'approved' AND r.status = 'failed' THEN COALESCE(a.review_id, -a.id) END) AS rebuilds_failed
         FROM approvals a LEFT JOIN build_tasks r ON r.id = a.rebuild_task WHERE a.by = ?`,
    ).bind(login).first<{ approvals: number | null; rejections: number | null; rebuilds_failed: number | null }>(),
  ]);
  const r = {
    contributed: { approved: reviewed?.approved ?? 0, staged: built?.staged ?? 0, bumps: built?.bumps ?? 0, donated: donated?.donated ?? 0, rejected: reviewed?.rejected ?? 0 },
    maintained: { approvals: decided?.approvals ?? 0, rejections: decided?.rejections ?? 0, rebuilds_failed: decided?.rebuilds_failed ?? 0 },
  };
  return { ...r, score: scoreOf(r) };
}

/** A person's decisions as the record keeps them: each row with its review's own word on it — the architectures it decided, those not supported, whether it freed the name. */
const DECISIONS = `SELECT a.id, a.task_id, a.name, a.arch, a.version, a.decision, a.by, a.note, a.rebuild_task, a.created_at, a.withdrawn_at, a.withdrawn_by, a.withdrawn_reason, a.review_id,
                          v.arches AS review_arches, v.not_supported AS review_not_supported, v.released AS review_released
                     FROM approvals a LEFT JOIN reviews v ON v.id = a.review_id`;
type DecisionOf = { id: number; task_id: number; name: string; arch: string; version: string | null; decision: string; by: string; note: string | null; rebuild_task: number | null; created_at: string; withdrawn_at: string | null; withdrawn_by: string | null; withdrawn_reason: string | null; review_id: number | null; review_arches: string | null; review_not_supported: string | null; review_released: number | null };

export async function handleUser(login: string, env: Env): Promise<Response> {
  const person = await env.DB.prepare("SELECT login, name, avatar_url, role, created_at, last_seen, blocked_at, blocked_by, blocked_reason FROM contributors WHERE login = ?")
    .bind(login)
    .first<{ login: string; name: string | null; avatar_url: string | null; role: string; created_at: string; last_seen: string; blocked_at: string | null; blocked_by: string | null; blocked_reason: string | null }>();
  if (!person) return json({ error: "no such contributor" }, 404);
  const [packages, builds, counts, approvals, workers, listed, record] = await Promise.all([
    env.DB.prepare(`SELECT name, category, url, arches, targets, status, detail, updated_at FROM factory_packages WHERE owner = ? ORDER BY name`).bind(login).all(),
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
    env.DB.prepare(`${DECISIONS} WHERE a.by = ? ORDER BY a.id DESC LIMIT 50`).bind(login).all<DecisionOf>(),
    // Every worker under this name, the revoked ones too (the page says so on the row): the whole row, served through the listing's own view (workerView) so the page's tile and tables count the same rows by the same words.
    env.DB.prepare("SELECT * FROM build_workers WHERE owner = ? ORDER BY last_seen DESC").bind(login).all<WorkerRow>(),
    maintainersOf(env),
    recordOf(env, login),
  ]);
  // A review whose rows straddle the fifty: the rest of its rows, so the page lists it whole (they are all this person's — a review is one maintainer's).
  const decided = await wholeReviews(approvals.results, async (reviews, below) =>
    (await env.DB.prepare(`${DECISIONS} WHERE a.review_id IN (SELECT value FROM json_each(?)) AND a.id < ?`).bind(JSON.stringify(reviews), below).all<DecisionOf>()).results);
  // Packages this person approved into the pool (what they maintain, in practice): the approvals that stand, a withdrawn one no longer theirs to keep.
  const approvedNames = [...new Set(decided.filter(stands).map((a) => a.name))];
  // Where each standing approval's architecture is served today — the rings, from the factory's rows in each ring — in one read: each
  // (name, arch) seeks the (name, repo_arch, source) index, then the ring table's key per ring. CROSS JOIN holds that order: the
  // planner, left to itself, walked every row of the four rings instead (one query per approval did the same, one after another).
  const pairs = [...new Set(decided.filter(stands).map((a) => JSON.stringify([a.name, a.arch])))];
  const served = new Map<string, string[]>();
  if (pairs.length) {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT rp.ring, p.name, p.repo_arch AS arch FROM json_each(?) k CROSS JOIN packages p CROSS JOIN ring_packages rp
        WHERE p.name = json_extract(k.value, '$[0]') AND p.repo_arch = json_extract(k.value, '$[1]') AND p.source = 'factory' AND rp.package_id = p.id AND rp.ring IN (${ringsSql(RINGS)})`,
    ).bind(`[${pairs.join(",")}]`).all<{ ring: string; name: string; arch: string }>();
    for (const r of rows.results) served.set(`${r.name}\t${r.arch}`, [...(served.get(`${r.name}\t${r.arch}`) ?? []), r.ring]);
  }
  const alive = aliveSince(), pool = running(env);
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
      // A registration is one package: where each of its architectures stands rides with it (targets.ts), and whether it landed, the registry's own flag (landed(), as GET /factory/packages says it) — the People page tells a signed-in viewer they may apply from it.
      packages: packages.results.map((p) => ({ ...p, targets: parseTargets(p.targets), landed: landed(p.status as string) })),
      builds: await Promise.all(builds.results.map(async (b) => (b.status === "queued" && b.trust === "community" ? { ...b, queue: await queuePosition(env, b as { id: number; arch: string; priority?: number; shared_after?: string | null; pinned_to?: string | null }) } : b))),
      build_counts: counts ?? { staged: 0, published: 0, failed: 0, total: 0 },
      // Every decision as the review it is (one per package, its architectures in `arches` and `targets`), saying whether it stands (`standing`, as GET /factory/approvals says it), and a standing one where the package is today: the rings that serve it.
      approvals: asReviews(decided, (name, arch) => sortRings(served.get(`${name}\t${arch}`) ?? [])),
      approved_packages: approvedNames,
      record,
      workers: workers.results.map((w) => workerView(w, alive, pool)),
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
 * Who stands behind a package: its packager upstream, and its maintainer
 * in the pool (#244) — the maintainer who adopted it (routes/adopt.ts),
 * else, for what the factory built, the one whose approval stands; a
 * synced package nobody adopted has none. For a factory package also its
 * owner, its category, the maintainers, the last approval that stands — a
 * withdrawn one is not the approval the package is served under, so the
 * package page's "reviewed by" and the Packages table's approver never
 * name it.
 */
export async function maintenanceOf(env: Env, name: string, source: string, packager: string | undefined): Promise<Record<string, unknown>> {
  const adopted = await env.DB.prepare("SELECT login, since FROM package_maintainers WHERE name = ?").bind(name).first<{ login: string; since: string }>();
  const out: Record<string, unknown> = { packager: packager ?? null, maintainer: adopted ? { login: adopted.login, since: adopted.since, adopted: true } : null };
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
  if (!adopted && approval) out.maintainer = { login: approval.by, since: approval.created_at, adopted: false };
  return out;
}
