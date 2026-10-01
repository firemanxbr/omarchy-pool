-- Host registrations claim with their capacity, a claim_id and their leases,
-- and every lease carries a generation (#334, epic #307, design v2 §8.1,
-- §8.5, §8.6; D29, D46, D54). A host registration (build_workers.kind =
-- 'host', #321) holds several leases; a legacy registration keeps its one
-- task and writes none of these columns.
--
-- Additive, but for the open-order index: the Worker that runs during the
-- deploy minute reads and writes none of the new columns.

-- The lease, as the claim of a host registration writes it:
ALTER TABLE build_tasks ADD COLUMN lease_gen TEXT;            -- g_<16 hex>, random per lease, in the job token (claim `g`): a token of an older lease of the same task never acts on this one
ALTER TABLE build_tasks ADD COLUMN lane TEXT;                 -- native | emulated: the lane it runs on; P1 leases the native lane only
ALTER TABLE build_tasks ADD COLUMN units INTEGER;             -- the capacity units the lease takes (the signed constants: a build 2 per size, a trial 2, an audit 1, a pool job 1)
ALTER TABLE build_tasks ADD COLUMN size INTEGER;              -- the build's size at lease (factory_packages.size, clamped)
ALTER TABLE build_tasks ADD COLUMN disk_gb INTEGER;           -- a build's disk budget at lease (its size × the signed GB per size)
ALTER TABLE build_tasks ADD COLUMN release TEXT;              -- the release the lease was claimed on (the claim's version)
ALTER TABLE build_tasks ADD COLUMN claim_id TEXT;             -- the claim that leased it: a retry with the same claim_id gets this lease back with a fresh token
ALTER TABLE build_tasks ADD COLUMN host_losses INTEGER NOT NULL DEFAULT 0; -- `lost` reports that gave the attempt back: at most 2 per task (D54)
ALTER TABLE build_tasks ADD COLUMN lease_missed INTEGER NOT NULL DEFAULT 0; -- consecutive host claims that did not list this unfenced lease: at 2, and 2 minutes after the lease began, it is requeued with its attempt back

-- What a package needs, set by the maintainers (P2 sizes them); NULL = size 1.
ALTER TABLE factory_packages ADD COLUMN size INTEGER;
ALTER TABLE factory_packages ADD COLUMN disk_gb INTEGER;

-- Stop is per lease (design v2 §8.6): a host may have one open stop-task per
-- task, so two Stops for two leases of one host are open at once; every other
-- kind keeps one open per worker (its task_id is NULL, counted as 0). A legacy
-- worker's stop-task names a task too, so the index alone no longer holds it
-- to one open stop: its door does (orders.ts: only the task the worker holds
-- now, not fenced already), as it did before. The
-- index keeps its name and its leading (worker_id, kind): the claim's
-- delivery, the sweep and a resume's close read through it as before. The
-- table's other indexes are made again after it, in 0042's order, so the
-- planner weighs them as it did (with no statistics, it breaks a tie by that
-- order) and every other read keeps its plan.
DROP INDEX uq_worker_orders_open_site_agent;
DROP INDEX idx_worker_orders_worker;
DROP INDEX idx_worker_orders_issuer;
DROP INDEX idx_worker_orders_site;
DROP INDEX uq_worker_orders_open_kind;
CREATE UNIQUE INDEX uq_worker_orders_open_kind ON worker_orders (worker_id, kind, COALESCE(task_id, 0)) WHERE state IN ('pending','delivered');
CREATE UNIQUE INDEX uq_worker_orders_open_site_agent ON worker_orders (site) WHERE kind = 'restart-agent' AND state IN ('pending','delivered');
CREATE INDEX idx_worker_orders_worker ON worker_orders (worker_id, issued_at DESC);
CREATE INDEX idx_worker_orders_issuer ON worker_orders (issued_by, issued_at DESC);
CREATE INDEX idx_worker_orders_site ON worker_orders (site, issued_at DESC) WHERE site IS NOT NULL;
