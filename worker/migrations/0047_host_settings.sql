-- The host's settings and the rest of the host orders (#325, epic #307,
-- design v2 §12, §17.1): the pool may narrow a host's units and emulated
-- lanes inside the envelope its owner wrote at the host — never above it, the
-- agent refuses that — and give it the rest of the closed set: set-units,
-- set-emulate, rotate-token, retry-release and diagnostics (host_orders'
-- CHECK names them since 0046).
--
-- - host_orders.arg: a settings order's value, as its agent reads it beside the
--   order in the host state — {"units": n | null} for set-units,
--   {"emulate": [arch, ...] | null} for set-emulate (null: the envelope's own).
-- - hosts.settings: what its agent took — the value of its last set-units and
--   set-emulate answered done — sent back in the host state, so an agent that
--   lost its own (a state.json gone) narrows again; {"units", "emulate"}.
-- - host_diagnostics: the dispatcher's last log lines a diagnostics order
--   brought (at most 500, scrubbed by the agent, a line that still looks like a
--   secret dropped here and counted); its owner's and the maintainers' to read
--   on the host page; the cron keeps a week.
--
-- Additive only: the Worker that runs during the deploy minute reads and
-- writes none of it.
ALTER TABLE host_orders ADD COLUMN arg TEXT;
ALTER TABLE hosts ADD COLUMN settings TEXT;
CREATE TABLE host_diagnostics (
    order_id  TEXT PRIMARY KEY,                    -- host_orders.id of the diagnostics order
    host_id   TEXT NOT NULL,                       -- hosts.id; no FK: as host_orders
    at        TEXT NOT NULL,                       -- when the pool took them
    lines     TEXT NOT NULL,                       -- a JSON array of strings
    dropped   INTEGER NOT NULL DEFAULT 0           -- lines left out: they looked like a secret
);
-- The cron's week, by when they came.
CREATE INDEX idx_host_diagnostics_at ON host_diagnostics (at);
