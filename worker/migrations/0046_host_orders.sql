-- Host orders (#344, epic #307, design v2 §11.1 M4, §17.1, §21.1 step 6): what
-- only a host's agent can do, sent in its signed host state
-- (GET /hosts/self/state), a closed set, each with an id and a not_after. P3
-- gives two: retire-legacy (stop and remove the legacy compose project the
-- host recorded, write the .omarchy-agent marker into its directory) — its
-- owner only, with a passkey — and reconcile-now (a round now) — its owner or
-- any maintainer. The agent refuses an unknown kind, an order past its
-- not_after and an id it took already; it answers in its host report
-- (POST /hosts/self/report, `orders`), which closes the order here.
--
-- The kind's CHECK lists P4's kinds too (#325: set-units, set-emulate,
-- rotate-token, retry-release, diagnostics): SQLite cannot widen a CHECK
-- without rebuilding the table. The door gives only P3's two until then.
--
-- Additive only: the Worker that runs during the deploy minute reads and
-- writes none of it.
CREATE TABLE host_orders (
    id             TEXT PRIMARY KEY,               -- ho_<32 hex>
    host_id        TEXT NOT NULL,                  -- hosts.id; no FK: history outlives a host
    kind           TEXT NOT NULL CHECK (kind IN ('retire-legacy','reconcile-now','set-units','set-emulate','rotate-token','retry-release','diagnostics')),
    issued_by      TEXT NOT NULL,                  -- a GitHub login
    via            TEXT NOT NULL DEFAULT 'web',    -- the browser's session: a token issues none
    confirmed_with TEXT,                           -- the passkey that confirmed it (retire-legacy)
    issued_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    not_after      TEXT NOT NULL,                  -- the agent refuses it after this; the pool expires it
    state          TEXT NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open','done','refused','failed','expired','cancelled')),
    answered_at    TEXT,                           -- the pool's time of the report that closed it, or of its expiry
    detail         TEXT                            -- the agent's words (<= 500, one line, leak-checked with its report); owner and maintainers only
);
-- One open order per kind per host, enforced by the engine: the INSERT fails, the door answers 409.
-- It is also the index of the open ones: the host state reads a host's through it.
CREATE UNIQUE INDEX uq_host_orders_open_kind ON host_orders (host_id, kind) WHERE state = 'open';
-- The host page's last orders.
CREATE INDEX idx_host_orders_host ON host_orders (host_id, issued_at DESC);
-- The cron's expiry of the open ones past their not_after.
CREATE INDEX idx_host_orders_open_until ON host_orders (not_after) WHERE state = 'open';
