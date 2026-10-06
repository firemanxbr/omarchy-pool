/**
 * The queue: where a contributor's build waits and where it stands. A
 * request lands here the moment its record is written
 * (routes/contributors.ts queueBuilds); the claim (routes/factory.ts
 * handleClaim, selection.ts) hands it to a host that can take it, the
 * contributors' builds round-robin by owner. Every maintainer host builds
 * every contributor's packages (design v2 §8.2, §21.4): the community
 * worker tier, its shared and own-packages modes and the best idle shared
 * worker's first pick are gone (#343).
 */
import type { Env } from "./index";

/**
 * Where a queued community build stands in the queue of its architecture:
 * its position among the builds any host may take (not pinned), and how
 * many there are. A bump queued before #343 for its owner's worker first
 * waits for nobody now: the claim reads no such delay.
 */
export async function queuePosition(env: Env, task: { id: number; arch: string; priority?: number; pinned_to?: string | null }): Promise<{ position: number; total: number } | null> {
  // Not in the queue every host takes from: asked for one worker.
  if (task.pinned_to) return null;
  const pr = task.priority ?? 100;
  // The place counts as selection hands builds out (#337, selection.ts): by priority, then round-robin by owner, then by age. Every
  // more urgent build is ahead; at its priority, its owner's older builds, and from each other owner as many builds as rounds pass
  // before its own (its owner's builds ahead), one more when that owner's head is older. An estimate: a lane's wait, the per-owner
  // cap and the emulated share move it a little — a contributor's one package behind another's hundred and fifty is second, not last.
  const r = await env.DB.prepare(
    `WITH q AS (SELECT id, owner, priority FROM build_tasks
        WHERE status = 'queued' AND kind = 'build' AND trust = 'community' AND arch = ?1 AND pinned_to IS NULL),
      me AS (SELECT ?2 AS id, ?3 AS pr, (SELECT owner FROM build_tasks WHERE id = ?2) AS owner),
      k AS (SELECT COUNT(*) AS n FROM q, me WHERE q.owner IS me.owner AND q.priority = me.pr AND q.id < me.id),
      o AS (SELECT q.owner, COUNT(*) AS n, MIN(q.id) AS head FROM q, me WHERE q.priority = me.pr AND q.owner IS NOT me.owner GROUP BY q.owner)
    SELECT (SELECT COUNT(*) FROM q, me WHERE q.priority < me.pr) + (SELECT n FROM k)
        + COALESCE((SELECT SUM(MIN(o.n, k.n) + (o.n > k.n AND o.head < me.id)) FROM o, k, me), 0) AS ahead,
      (SELECT COUNT(*) FROM q) AS total`,
  ).bind(task.arch, task.id, pr).first<{ ahead: number | null; total: number }>();
  return { position: (r?.ahead ?? 0) + 1, total: Math.max(r?.total ?? 0, (r?.ahead ?? 0) + 1) };
}
