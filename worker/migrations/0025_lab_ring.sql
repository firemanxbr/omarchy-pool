-- The lab: a fourth ring beside edge, rc and stable (worker/src/index.ts
-- RINGS) where a build is tried by a real pacman before a maintainer sends
-- it to edge; nothing in it is promised or promoted. The releases table
-- named the three rings in a CHECK, which SQLite cannot alter, and D1 keeps
-- foreign keys enforced (PRAGMA foreign_keys = OFF is ignored), so the
-- table cannot be dropped under its children: the children go with it.
-- Every table that references releases is rebuilt against the new one,
-- data copied, the old ones dropped (children first: nothing cascades),
-- and the new ones renamed into place — a rename rewrites the references
-- to the new name. Ids, sequences and heads are exactly what they were.
CREATE TABLE releases_v2 (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ring          TEXT    NOT NULL CHECK (ring IN ('edge', 'rc', 'stable', 'lab')),
    seq           INTEGER NOT NULL,
    parent_id     INTEGER REFERENCES releases_v2 (id),
    source_id     INTEGER REFERENCES releases_v2 (id),
    note          TEXT,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    package_count INTEGER,
    bytes         INTEGER,
    sources       TEXT,
    checkpoint    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (ring, seq)
);
INSERT INTO releases_v2 (id, ring, seq, parent_id, source_id, note, created_at, package_count, bytes, sources, checkpoint)
  SELECT id, ring, seq, parent_id, source_id, note, created_at, package_count, bytes, sources, checkpoint FROM releases;

CREATE TABLE release_packages_v2 (
    release_id INTEGER NOT NULL REFERENCES releases_v2 (id) ON DELETE CASCADE,
    package_id INTEGER NOT NULL REFERENCES packages (id),
    PRIMARY KEY (release_id, package_id)
);
INSERT INTO release_packages_v2 (release_id, package_id) SELECT release_id, package_id FROM release_packages;

CREATE TABLE release_deltas_v2 (
    release_id INTEGER NOT NULL REFERENCES releases_v2 (id) ON DELETE CASCADE,
    package_id INTEGER NOT NULL,
    op         TEXT    NOT NULL CHECK (op IN ('add', 'remove')),
    PRIMARY KEY (release_id, package_id)
);
INSERT INTO release_deltas_v2 (release_id, package_id, op) SELECT release_id, package_id, op FROM release_deltas;

CREATE TABLE release_artifacts_v2 (
    release_id INTEGER NOT NULL REFERENCES releases_v2 (id) ON DELETE CASCADE,
    repo       TEXT    NOT NULL,
    arch       TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('db', 'db.sig', 'files', 'files.sig')),
    r2_key     TEXT    NOT NULL,
    size       INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (release_id, repo, arch, kind)
);
INSERT INTO release_artifacts_v2 (release_id, repo, arch, kind, r2_key, size, created_at)
  SELECT release_id, repo, arch, kind, r2_key, size, created_at FROM release_artifacts;

CREATE TABLE ring_heads_v2 (
    ring       TEXT    PRIMARY KEY,
    release_id INTEGER NOT NULL REFERENCES releases_v2 (id)
);
INSERT INTO ring_heads_v2 (ring, release_id) SELECT ring, release_id FROM ring_heads;

DROP TABLE release_packages;
DROP TABLE release_deltas;
DROP TABLE release_artifacts;
DROP TABLE ring_heads;
DROP TABLE releases;

ALTER TABLE releases_v2 RENAME TO releases;
ALTER TABLE release_packages_v2 RENAME TO release_packages;
ALTER TABLE release_deltas_v2 RENAME TO release_deltas;
ALTER TABLE release_artifacts_v2 RENAME TO release_artifacts;
ALTER TABLE ring_heads_v2 RENAME TO ring_heads;
