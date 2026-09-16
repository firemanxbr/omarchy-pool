-- D1 bills rows read. Three readers were paying for scans on every dashboard
-- poll (wrangler d1 insights, 2026-09-16, last 24 h: 414 M rows):
--   · /api/v1/status found the newest rendered database by sorting the whole
--     release_artifacts table — 5,300 rows, 11,000 times a day (58 M);
--   · /api/v1/stats found the latest event of every kind, source and ring
--     with a GROUP BY over the whole events table — 4,900 rows, 4,500 times
--     a day (22 M), and the table grows by a thousand rows a day;
--   · the sync history read events by kind and id with no index for it.
CREATE INDEX IF NOT EXISTS idx_release_artifacts_kind_created ON release_artifacts (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind_id ON events (kind, id DESC);

-- The latest event per (kind, source, ring), kept by a trigger: one row per
-- group, read in one index walk instead of a scan of every event.
CREATE TABLE IF NOT EXISTS latest_events (
  kind TEXT NOT NULL,
  src TEXT NOT NULL,
  rg TEXT NOT NULL,
  id INTEGER NOT NULL,
  PRIMARY KEY (kind, src, rg)
);
INSERT OR REPLACE INTO latest_events (kind, src, rg, id)
  SELECT kind, COALESCE(source, ''), COALESCE(ring, ''), MAX(id) FROM events GROUP BY kind, COALESCE(source, ''), COALESCE(ring, '');
CREATE TRIGGER IF NOT EXISTS trg_events_latest AFTER INSERT ON events
BEGIN
  INSERT INTO latest_events (kind, src, rg, id) VALUES (NEW.kind, COALESCE(NEW.source, ''), COALESCE(NEW.ring, ''), NEW.id)
    ON CONFLICT (kind, src, rg) DO UPDATE SET id = excluded.id;
END;
