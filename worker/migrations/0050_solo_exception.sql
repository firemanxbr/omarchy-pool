-- The solo-maintainer exception (#394, a maintainer decision of
-- 2026-10-06): while factory/MAINTAINERS.toml carries a [solo] table, the
-- one maintainer it names decides on their own packages — the review's
-- doors, the adoption, the requester-host rule (D35) — and every decision
-- they take that way is marked self-reviewed, in public. The file is the
-- switch: the brain reads it on main every ten minutes, as it reads the list
-- beside it (factory_maintainers), and writes what it read here. Nothing
-- else writes these, and no route sets them: removing the table from the
-- file clears them at the next sync, and the previous rules hold again
-- unchanged.
--
-- - governance_solo: the [solo] table as the last sync applied it — one row
--   while it is in force (id 1: there is never a second), none otherwise —
--   who it names, since when (a date, as the file writes it) and why.
-- - reviews.solo_since: a decision its requester took under the exception —
--   the exception's `since` when it was taken; NULL for every decision taken
--   under the two-person rule. The review's `by` is who took it.
-- - package_maintainers.solo_since: an adoption its own requester took under
--   the exception — the exception's `since` when it was taken; NULL for every
--   other adoption. The row's `login` is who adopted it. The package page
--   and GET /package/:name mark it (maintenance.maintainer.solo_exception)
--   for as long as the adoption stands.
--
-- The Worker that runs during the deploy minute reads and writes neither:
-- with no row the exception is simply not in force.
CREATE TABLE IF NOT EXISTS governance_solo (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    maintainer TEXT NOT NULL,
    since      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
ALTER TABLE reviews ADD COLUMN solo_since TEXT;
ALTER TABLE package_maintainers ADD COLUMN solo_since TEXT;
