-- Workers follow the brain for their health (#277). An order to a worker rides
-- the answer to its own claim, is delivered once to one process (instance),
-- expires, and is answered (done, refused, failed) or closed by the pool when
-- a later claim shows the result. An update is never delivered: its set's
-- updater reads it (GET /factory/follow) and the pool closes it when the
-- worker claims on the new release. A stop-task is never delivered either:
-- the pool fences the task's lease at issue (build_tasks.stop_order), the
-- heartbeat's 409 stops it on the worker, and the worker's next claim (or
-- the lease's end) gives the task back to the queue and closes the order.
-- Every order has one journal line at issue and one at its final state (kind
-- 'order'). Public text is the pool's; the worker's words are private.
--
-- The whole schema of #277 lands here, the columns its later parts read
-- included (drained_*, stop_order, watchdog_exits, rollout): the kind's CHECK
-- lists all seven, and SQLite cannot widen a CHECK without rebuilding the
-- table. Until a part reads them, those columns stay NULL.
--
-- Additive only: the Worker that runs during the deploy minute reads and
-- writes none of it.
CREATE TABLE worker_orders (
    id            TEXT PRIMARY KEY,                -- wo_<32 hex>
    worker_id     TEXT NOT NULL,                   -- build_workers.id; no FK (0035): history outlives a revoke
    kind          TEXT NOT NULL CHECK (kind IN ('recheck-agent','restart','restart-agent','drain','resume','update','stop-task')),
    reason        TEXT NOT NULL,                   -- <= 300, one line, stripped, leak-checked; public
    issued_by     TEXT NOT NULL,                   -- a GitHub login, or 'pool'
    via           TEXT,                            -- web | token for a person; NULL for the pool
    rule          TEXT,                            -- the pool's rule name; NULL for a person
    unless_agent_ok INTEGER NOT NULL DEFAULT 0,    -- restart only: the worker probes first and refuses on ok
    task_id       INTEGER,                         -- stop-task only: the task it held at issue, whose lease the order fences until it goes back to the queue
    site          TEXT,                            -- the worker's site at issue (per-site pacing; restart-agent's uniqueness); NULL without a stable engine id
    issued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at    TEXT NOT NULL,
    baseline_at_issue TEXT,                        -- recheck: the row's agent_checked_at at issue (staleness)
    state         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','delivered','done','refused','failed','expired','cancelled')),
    delivered_at  TEXT,                            -- never set for 'update'
    delivered_to  TEXT,                            -- the instance that took it: the only one whose answer counts
    baseline      TEXT,                            -- at delivery: agent_checked_at (recheck, restart-agent) or the instance (restart)
    accepted_at   TEXT,
    answered_at   TEXT,
    answered_by   TEXT CHECK (answered_by IS NULL OR answered_by IN ('worker','pool')),
    code          TEXT,                            -- the closed answer code; the public sentence is the pool's
    detail        TEXT,                            -- the pool's words; public
    worker_detail TEXT                             -- the worker's words and agent object (<= 500); owner and maintainers only
);
-- One open order per kind per worker, enforced by the engine: the INSERT fails, the door answers 409.
-- It is also the index of the open ones: the claim's delivery (a worker's, by worker_id) and the cron's
-- sweep (every open order: a few rows) read through it; a second index on them would cost a row per order.
CREATE UNIQUE INDEX uq_worker_orders_open_kind ON worker_orders (worker_id, kind) WHERE state IN ('pending','delivered');
-- One restart-agent open per site: two workers of one host cannot both restart agent-proxy. A NULL site is its own.
CREATE UNIQUE INDEX uq_worker_orders_open_site_agent ON worker_orders (site) WHERE kind = 'restart-agent' AND state IN ('pending','delivered');
-- The worker's page and the per-worker caps.
CREATE INDEX idx_worker_orders_worker ON worker_orders (worker_id, issued_at DESC);
-- The per-issuer caps (a login; 'pool' for the fleet-wide caps and the daily budget).
CREATE INDEX idx_worker_orders_issuer ON worker_orders (issued_by, issued_at DESC);
-- Per-site pacing of the pool's restarts.
CREATE INDEX idx_worker_orders_site ON worker_orders (site, issued_at DESC) WHERE site IS NOT NULL;

ALTER TABLE build_workers ADD COLUMN open_orders TEXT;        -- JSON [{id,kind,state,by,at}], NULL = none: a claim with nothing waiting reads no order row
ALTER TABLE build_workers ADD COLUMN order_kinds TEXT;        -- canonical JSON (known kinds, sorted, deduplicated) of its last claim; NULL = an image from before orders
ALTER TABLE build_workers ADD COLUMN instance TEXT;           -- the process that claims (random per process)
ALTER TABLE build_workers ADD COLUMN instance_prev TEXT;      -- the one before it: a claim from it again soon after means two processes
ALTER TABLE build_workers ADD COLUMN instance_since TEXT;     -- the pool's time of the instance's first claim: uptime on the pool's clock
ALTER TABLE build_workers ADD COLUMN instance_conflict_at TEXT; -- two processes share this token since …; NULL = one
ALTER TABLE build_workers ADD COLUMN instance_other_at TEXT;  -- during a conflict: when the other one last claimed (written at most every TOUCH_MINUTES)
ALTER TABLE build_workers ADD COLUMN instance_churn INTEGER NOT NULL DEFAULT 0; -- instances in a row that lived < CHURN_WINDOW_MIN, finished no task, and whose end nothing explains
ALTER TABLE build_workers ADD COLUMN instance_finished TEXT;  -- the instance that last finished a task (complete or fail accepted): stamped by workerFinished's own write
ALTER TABLE build_workers ADD COLUMN crash_loop_since TEXT;   -- set (and journaled) when instance_churn reaches 3; cleared by an instance that lives CHURN_CLEAR_MIN or finishes a task
ALTER TABLE build_workers ADD COLUMN watchdog_exits TEXT;     -- JSON {n, since, last, stuck_in}: watchdog exits reported by previous_exit in the last 24 h; NULL = none
ALTER TABLE build_workers ADD COLUMN started_at TEXT;         -- display only: MAX of what its claims said
ALTER TABLE build_workers ADD COLUMN agent_via TEXT;          -- direct | sibling | broker | none
ALTER TABLE build_workers ADD COLUMN site TEXT;               -- sha256(engine id ‖ "\n" ‖ compose project)[:16]; NULL without a stable engine id: a site of its own
ALTER TABLE build_workers ADD COLUMN restarts_left INTEGER;   -- under on-failure:N; NULL otherwise
ALTER TABLE build_workers ADD COLUMN rollout TEXT;            -- canonical JSON of the claim's rollout report; NULL = not reported
ALTER TABLE build_workers ADD COLUMN agent_error_since TEXT;  -- the first failed probe of the current spell (pool time)
ALTER TABLE build_workers ADD COLUMN agent_probed_at TEXT;    -- the pool's time of the claim that brought a new agent_checked_at: the probe's age on the pool's clock
ALTER TABLE build_workers ADD COLUMN agent_error_class TEXT;  -- errorClass(agent_error, agent_via), written with agent_error
ALTER TABLE build_workers ADD COLUMN drained_at TEXT;
ALTER TABLE build_workers ADD COLUMN drained_by TEXT;
ALTER TABLE build_workers ADD COLUMN drain_reason TEXT;
ALTER TABLE build_workers ADD COLUMN auto_orders TEXT;        -- JSON AutoState; written only by compare-and-set
-- The breaker's open spells: its key moves only when a spell begins or ends, never at a liveness write.
CREATE INDEX idx_build_workers_not_ready ON build_workers (agent_error_since) WHERE agent_status = 'error' AND revoked_at IS NULL;
-- The site election and pacing.
CREATE INDEX idx_build_workers_site ON build_workers (site) WHERE site IS NOT NULL;
-- stop-task's fence: the open order that stopped this lease. While it is set, the task stays
-- leased to its worker, its heartbeats, reports and staging uploads get 409 stop, and nothing renews the lease.
ALTER TABLE build_tasks ADD COLUMN stop_order TEXT;           -- worker_orders.id; NULL = not stopped. Cleared by requeueLease
