/**
 * A lease the pool takes back (#277, part 2): what an expired lease does —
 * the task back to the queue behind its peers, or failed on its last
 * attempt, its worker's hand emptied, and what follows for one task — in
 * one place, so the cron (an expired lease) and the claim (the worker a
 * Stop its task fenced claims again: its processes are gone) run the same
 * statements.
 *
 * A stop fences a lease instead of giving it back at once (orders.ts,
 * stop-task): the task stays leased to its worker, `build_tasks.stop_order`
 * names the order, every heartbeat, report and staging upload is refused,
 * and nothing renews the lease or its job token. It goes back here, at the
 * first of two moments: the worker's next claim, or the lease's end — when
 * every token of that lease has expired. So a stopped task never has two
 * runners, whatever the stopped process still does.
 */
import type { Env } from "./index";
import { reclaimStagingPackages } from "./staging";
import { settleTargets } from "./targets";
import { isRevoked } from "./update";

/** How long a lease runs without a heartbeat: the claim and every heartbeat set it; a job token lives as long. */
export const LEASE_MINUTES = 30;

/** The task as a requeue reads it. */
export interface LeasedTask { id: number; name: string; arch: string; kind: string; trust: string; lease_owner: string; attempts: number; max_attempts: number }

/**
 * The requeue itself, one statement, only while the lease is still the one
 * read — leased to this worker, fenced by this order or not fenced at all —
 * so a report or the other path that got there first makes it change
 * nothing. The cron's also only while the lease has still expired
 * (`expiredBefore`, its own now): a heartbeat that renewed it between the
 * cron's read and this write keeps it, with the job token it was just
 * handed — never a fresh token for a task back in the queue. The claim that
 * ends a fence passes none: the fenced lease is never renewed, and the
 * claim itself is the proof its processes are gone. Behind its peers
 * (priority + 10); failed when that was its last attempt, with who held it
 * kept on the row. The fence goes with it, and an audit's independence
 * with the lease that ran it (#339): its next lease writes its own.
 */
export const REQUEUE_SQL = `UPDATE build_tasks SET
    status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
    finished_at = CASE WHEN attempts >= max_attempts THEN ?1 ELSE NULL END,
    error = ?2,
    lease_owner = CASE WHEN attempts >= max_attempts THEN lease_owner ELSE NULL END,
    independent = CASE WHEN attempts >= max_attempts THEN independent ELSE NULL END,
    lease_expires_at = NULL, priority = priority + 10, stop_order = NULL
  WHERE id = ?3 AND status = 'leased' AND lease_owner = ?4 AND stop_order IS ?5 AND (?6 IS NULL OR lease_expires_at < ?6)
  RETURNING id, status`;

export function requeueStatement(env: Env, t: Pick<LeasedTask, "id" | "lease_owner">, error: string, stopOrder: string | null, at: string, expiredBefore: string | null = null): D1PreparedStatement {
  return env.DB.prepare(REQUEUE_SQL).bind(at, error, t.id, t.lease_owner, stopOrder, expiredBefore);
}

/** What a stop's requeue says of the task, on its row and in the journal: who stopped it, on which worker, and why. */
export function stopError(worker: string, by: string, reason: string | null, leaseEnded: boolean): string {
  return `stopped on ${worker} by ${by}${reason ? `: ${reason}` : ""}${leaseEnded ? "; its lease ended" : ""}`.slice(0, 2000);
}

/**
 * The registration's one word after a community build of one architecture
 * failed. A package has one status and may have a build per architecture,
 * each on a worker of its own, so the word follows the builds, not the
 * last worker to speak: while any build of the name is staged for a
 * maintainer the package stays `staged` — Review counts it as waiting and
 * the tile must not count it as not built — and only the detail says what
 * the other architecture ran into; while another architecture's build is
 * still running or queued, it is `building` or `waiting` — one that failed
 * is not supported, and the others go on (#242); with nothing staged and
 * nothing in flight it goes to `fallback`: registered with the reason — no
 * architecture built, the request is back with its owner — or waiting when
 * the task is queued again. Each architecture's own word is its target
 * (targets.ts). omarchy-cli, 2026-09-18: aarch64 staged at 03:50, x86_64
 * gave up at 03:59 and the row read `registered` beside a build waiting for
 * review. The staging-drop handler (contributors.ts) keeps the same rule
 * from its side. `only` narrows the write to a package in that status (the
 * lease path touches a package it left `building`; a worker's own report
 * touches the package whatever the claim or the other architecture wrote
 * since).
 */
export async function packageAfterFailure(env: Env, name: string, fallback: "registered" | "waiting", detail: string, only?: "building"): Promise<void> {
  await env.DB.prepare(
    `UPDATE factory_packages SET
       status = CASE WHEN EXISTS (SELECT 1 FROM build_tasks t WHERE t.kind = 'build' AND t.status = 'staged' AND t.name = factory_packages.name) THEN 'staged'
                     WHEN EXISTS (SELECT 1 FROM build_tasks t WHERE t.status = 'leased' AND t.kind = 'build' AND t.trust = 'community' AND t.name = factory_packages.name) THEN 'building'
                     WHEN EXISTS (SELECT 1 FROM build_tasks t WHERE t.status = 'queued' AND t.kind = 'build' AND t.trust = 'community' AND t.name = factory_packages.name) THEN 'waiting'
                     ELSE ? END,
       detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE name = ?${only ? " AND status = ?" : ""}`,
  )
    .bind(fallback, detail, name, ...(only ? [only] : []))
    .run();
}

/**
 * What follows a requeue, for the one task it took back — the same after an
 * expired lease and after a stop: its worker's hand emptied (only if it
 * still names this task), the packages it may have staged reclaimed when it
 * failed for good (a worker that died mid-upload leaves the package it
 * landed behind — 2026-09-16, four of them at 720 MB; queued again, the next
 * lease writes over the same key and it counts once), the package back to
 * waiting or to registered with the reason — left at "building", obsidian
 * showed a build in progress for hours after its third lease had died
 * (2026-09-15) —, the targets settled, and the build's line.
 */
export async function afterRequeue(env: Env, t: LeasedTask, failed: boolean, error: string, stopped: boolean): Promise<void> {
  await env.DB.prepare("UPDATE build_workers SET current_task = NULL WHERE id = ? AND current_task = ?").bind(t.lease_owner, t.id).run();
  if (failed && t.kind === "build") await reclaimStagingPackages(env, [t.id]);
  if (t.trust === "community" && t.kind === "build") {
    await packageAfterFailure(env, t.name, failed ? "registered" : "waiting", failed ? `build failed on ${t.lease_owner}: ${error}${stopped ? "" : " (the worker stopped mid-build?)"}` : `${error}; queued again`, "building");
  }
  if (t.kind === "build") await settleTargets(env, t.name);
  const summary = `${t.name} for ${t.arch}: ${error}${failed ? (stopped ? " — that was its last attempt: it fails" : " — giving up") : " — back in the queue"}`;
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('build', NULL, 'factory', ?, ?, ?)")
    .bind(failed ? "error" : "warn", summary, JSON.stringify({ task: t.id, worker: t.lease_owner, attempts: t.attempts, ...(stopped ? { stopped: true } : {}) }))
    .run();
}

/**
 * One lease given back, by the cron or by a claim: the requeue, and — only
 * when it took the task back — what follows. False when the lease had moved
 * (renewed, reported, or given back by the other path first). The cron
 * passes `expiredBefore`, its now: a lease renewed since its read is kept.
 */
export async function requeueLease(env: Env, t: LeasedTask, error: string, stopOrder: string | null, at = new Date().toISOString(), expiredBefore: string | null = null): Promise<boolean> {
  const row = await requeueStatement(env, t, error, stopOrder, at, expiredBefore).first<{ id: number; status: string }>();
  if (!row) return false;
  await afterRequeue(env, t, row.status === "failed", error, stopOrder !== null);
  return true;
}

/**
 * A lease of a revoked release, given back (#342, design v2 §8.6, §9.1;
 * D55): its host's dispatcher killed it — on its own revoked set, or on the
 * pool's word at its heartbeat — and reported it, or its host's claims
 * stopped listing it. Nothing it sent on that release is taken. Back in the
 * queue at its place, its attempt given back and no host's loss counted:
 * neither the recipe nor the host failed, the release did. A revoked
 * release leases nothing (the 426 gate, update.ts), so a task comes back
 * this way once per revocation at most. Only while the lease is still the
 * one read, and not fenced (a Stop's end is the orders path's).
 */
export const REVOKED_REQUEUE_SQL = `UPDATE build_tasks SET status = 'queued', finished_at = NULL, error = ?1, lease_owner = NULL, lease_expires_at = NULL,
    attempts = MAX(attempts - 1, 0), independent = NULL, lease_missed = 0
  WHERE id = ?2 AND status = 'leased' AND lease_owner = ?3 AND lease_gen IS ?4 AND stop_order IS NULL RETURNING id, status, attempts`;

/**
 * The refusal every heartbeat, upload, pool write and completion of a lease
 * claimed on a revoked release gets (#342), with `stop`: its host kills it —
 * a dispatcher from before #342 on that very word, as a Stop — and reports
 * it, which requeues it. Null when its release is not revoked.
 */
export function revokedRefusal(task: { id: number; release: string | null }, pool: string): { error: string; stop: true; state: "revoked" } | null {
  if (!isRevoked(task.release)) return null;
  return { error: `task ${task.id} was leased on ${task.release}, which the pool's release ${pool} revokes: nothing of it is taken — its host kills it, and it goes back to the queue with its attempt`, stop: true, state: "revoked" };
}

/** What a revoked lease's requeue says, on its row and in the journal. */
export function revokedError(release: string, pool: string): string {
  return `leased on ${release}, which the pool's release ${pool} revokes: nothing it sent on that release is taken; the attempt is given back`;
}

/**
 * The requeue of a revoked lease, and what follows it: the packages a build
 * staged on that release reclaimed (its next lease stages anew), its
 * package back to waiting, the targets settled, the build's line. False
 * when the lease had moved.
 */
export async function requeueRevoked(env: Env, t: LeasedTask & { lease_gen: string | null }, release: string, pool: string): Promise<boolean> {
  const error = revokedError(release, pool);
  const row = await env.DB.prepare(REVOKED_REQUEUE_SQL).bind(error, t.id, t.lease_owner, t.lease_gen).first<{ id: number; status: string; attempts: number }>();
  if (!row) return false;
  if (t.kind === "build") await reclaimStagingPackages(env, [t.id]);
  await afterRequeue(env, { ...t, attempts: row.attempts }, false, error, false);
  return true;
}
