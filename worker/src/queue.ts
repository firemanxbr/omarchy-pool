/**
 * The shared queue: where a contributor's build waits, which shared worker
 * takes it first, and where it stands. A request lands here the moment its
 * record is written (routes/contributors.ts queueBuilds); the claim
 * (routes/factory.ts handleClaim) hands the newest builds to the best idle
 * shared worker for a few minutes, then to any that qualifies.
 */
import type { Env } from "./index";

const now = () => new Date().toISOString();

/** How long the best idle shared worker keeps first pick on a queued build before any shared worker may take it. */
export const FIRST_PICK_MINUTES = 3;

/** The rank of a shared worker for the queue: native before emulated, then cores, then memory. */
function workerRank(w: { emulated: boolean; cores: number; ram: number }): [number, number, number] {
  return [w.emulated ? 0 : 1, w.cores, w.ram];
}

/**
 * Is a better shared worker of this architecture alive and idle right now —
 * one that could draft when the queue needs an agent? Read from what the
 * workers reported with their last claim (labels.emulated, usage.cores,
 * usage.ram_gb, agent_status, current_task).
 */
export async function betterIdleWorker(env: Env, me: string, arch: string, mine: { emulated: boolean; cores: number; ram: number }, myAgentOk: boolean): Promise<boolean> {
  const rows = await env.DB.prepare(
    "SELECT id, labels, usage, agent_status FROM build_workers WHERE arch = ? AND trust = 'community' AND mode = 'shared' AND revoked_at IS NULL AND current_task IS NULL AND last_seen > ? AND id != ?",
  ).bind(arch, new Date(Date.now() - IDLE_SEEN_MINUTES * 60000).toISOString(), me).all<{ id: string; labels: string | null; usage: string | null; agent_status: string | null }>();
  const my = workerRank(mine);
  for (const r of rows.results) {
    // A worker whose agent does not answer cannot draft: it is never "better" for a queue of drafted builds when mine can.
    if (myAgentOk && r.agent_status !== "ok") continue;
    let labels: Record<string, unknown> = {}, usage: Record<string, unknown> = {};
    try { labels = r.labels ? (JSON.parse(r.labels) as Record<string, unknown>) : {}; } catch { /* as if none */ }
    try { usage = r.usage ? (JSON.parse(r.usage) as Record<string, unknown>) : {}; } catch { /* as if none */ }
    const its = workerRank({ emulated: !!labels.emulated, cores: Number(usage.cores ?? 0), ram: Number(usage.ram_gb ?? 0) });
    if (its[0] > my[0] || (its[0] === my[0] && (its[1] > my[1] || (its[1] === my[1] && its[2] > my[2])))) return true;
  }
  return false;
}
/** A worker seen this recently, with no task in hand, counts as idle for the queue's first pick. */
const IDLE_SEEN_MINUTES = 2;

/**
 * Where a queued community build stands in the shared queue of its
 * architecture: its position among the builds any shared worker may take
 * (not pinned, not waiting for shared_after), and how many there are.
 */
export async function queuePosition(env: Env, task: { id: number; arch: string }): Promise<{ position: number; total: number }> {
  const r = await env.DB.prepare(
    `SELECT SUM(CASE WHEN id < ? THEN 1 ELSE 0 END) AS ahead, COUNT(*) AS total FROM build_tasks
      WHERE status = 'queued' AND kind = 'build' AND trust = 'community' AND arch = ? AND pinned_to IS NULL AND (shared_after IS NULL OR shared_after <= ?)`,
  ).bind(task.id, task.arch, now()).first<{ ahead: number | null; total: number }>();
  return { position: (r?.ahead ?? 0) + 1, total: Math.max(r?.total ?? 0, (r?.ahead ?? 0) + 1) };
}

