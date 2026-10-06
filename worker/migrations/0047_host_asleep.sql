-- A Mac host that sleeps (#329, epic #307, design v2 §19.2, P5): its agent
-- reports `asleep: true` before the Mac sleeps and `asleep: false` after the
-- wake (POST /hosts/self/report), and a sleeping host has zero free units —
-- its dispatcher's claims are handed nothing, and selection counts it as no
-- capacity for anyone else's task (worker/src/selection.ts).
--
-- Additive only: the Worker that runs during the deploy minute reads and
-- writes none of it.

-- When the host's report first said it sleeps; NULL while it is awake (and
-- for every host whose agent does not say). It holds while the report that
-- said it is fresh (HOST_REPORT_FRESH_MIN): a dispatcher that claims past it
-- is on a host that woke and whose agent has not said so.
ALTER TABLE hosts ADD COLUMN asleep_at TEXT;
