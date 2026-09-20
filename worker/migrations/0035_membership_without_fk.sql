-- GC deletes a package row one at a time, and SQLite checks every table
-- that REFERENCES packages (id) for a row that still names it. Two of
-- them, ring_packages (PK ring, package_id) and release_packages (PK
-- release_id, package_id), have no index led by package_id, so each
-- delete scanned both tables end to end: 226-259k rows per victim, 920M
-- rows read for the 3,552 deletes of 2026-09-20 (US$ 0.9 at the billed
-- rate, a fifth of the month's ceiling). An index led by package_id would
-- fix the scan but costs a row written per membership row, and
-- release_packages takes 0.3-1.4M of those a day from checkpoints —
-- migration 0015 dropped exactly that index for that reason.
--
-- The constraint never fired: routes/gc.ts deletes only what no ring and
-- no kept checkpoint lists, after pruning the other checkpoints' rows.
-- Both tables are rebuilt without it, as release_deltas has been since
-- 0017, and the integrity the constraint enforced moves into the code
-- that could break it: GC re-checks each victim against the rings right
-- before deleting it and the DELETE itself is conditional on that
-- (routes/gc.ts), and a reconstruction refuses to write a release whose
-- packages are gone instead of writing dangling rows (db.ts
-- ensureCheckpoint). The 0025 pattern: D1 cannot alter a constraint and
-- ignores PRAGMA foreign_keys = OFF, so each table is built anew, its
-- rows copied, the old one dropped and the new one renamed into place —
-- the file is applied as one batch, so no read sees the gap between the
-- DROP and the RENAME. Nothing references either table (no trigger, no
-- view, no foreign key), and the FK to releases is kept: a release row
-- going takes its checkpoint with it.
CREATE TABLE ring_packages_v2 (
    ring       TEXT    NOT NULL,
    package_id INTEGER NOT NULL,
    PRIMARY KEY (ring, package_id)
);
INSERT INTO ring_packages_v2 (ring, package_id) SELECT ring, package_id FROM ring_packages;

CREATE TABLE release_packages_v3 (
    release_id INTEGER NOT NULL REFERENCES releases (id) ON DELETE CASCADE,
    package_id INTEGER NOT NULL,
    PRIMARY KEY (release_id, package_id)
);
INSERT INTO release_packages_v3 (release_id, package_id) SELECT release_id, package_id FROM release_packages;

DROP TABLE ring_packages;
DROP TABLE release_packages;

ALTER TABLE ring_packages_v2 RENAME TO ring_packages;
ALTER TABLE release_packages_v3 RENAME TO release_packages;
