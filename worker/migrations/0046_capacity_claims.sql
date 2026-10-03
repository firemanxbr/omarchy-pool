-- Capacity-aware claiming (#337, epic #307, design v2 §8.3; D31, D50, D51).
-- A claim reads a bounded head of the queue and, for round-robin by owner,
-- each contributor's first community build; selection (worker/src/selection.ts)
-- orders them and the first is leased with one conditional UPDATE.
--
-- Additive only: the Worker that runs during the deploy minute reads and
-- writes none of it.

-- When a host was marked reserving for a large task (hosts.reserving_task,
-- 0043): the mark ends when the task is leased, when the host leaves, or two
-- hours after this.
ALTER TABLE hosts ADD COLUMN reserving_since TEXT;

-- Each contributor's head of the queue, in the claim's order (priority, id),
-- and the walk over the owners that have one: one index entry per owner,
-- never a contributor's whole backlog. Partial, so only the statements that
-- say `status = 'queued' AND trust = 'community'` can use it, and no other
-- read of build_tasks changes its plan (D1 keeps no statistics).
CREATE INDEX idx_build_tasks_owner_head ON build_tasks (owner, priority) WHERE status = 'queued' AND trust = 'community';
