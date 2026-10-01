-- Maintainer hosts (#321, epic #307, design v2 §6.1, §8.6). Only a maintainer
-- enrolls a host: "Add a host" on their page mints a one-time token bound to
-- their login and their GitHub user id; the machine's agent sends it with its
-- new Ed25519 public key and its capacity report; the host waits in
-- 'pending-owner' until its owner confirms the fingerprint on the site, and
-- only then gets its one worker registration (build_workers.kind = 'host').
-- Every later call of the host is signed with its key (Omarchy-Host header);
-- host_nonces stops a signed request from being replayed.
--
-- The statuses #322 needs (suspended, retired) are in the CHECK now: SQLite
-- cannot widen a CHECK without rebuilding the table. Additive only: the
-- Worker that runs during the deploy minute reads and writes none of it.

-- The GitHub user id behind a login, from the sign-in (and from a GitHub
-- token at POST /factory/register): hosts are owned by the id, so a login
-- renamed or taken by someone else is not their owner.
ALTER TABLE contributors ADD COLUMN github_id INTEGER;

CREATE TABLE host_enrollments (
    token_hash  TEXT PRIMARY KEY,                -- sha256 of ome_<48 hex>; the token itself is shown once
    id          TEXT NOT NULL UNIQUE,            -- he_<16 hex>: what the page polls by, never the token
    login       TEXT NOT NULL,
    github_id   INTEGER NOT NULL,
    name        TEXT NOT NULL,                   -- the host's name, the maintainer's choice
    "where"     TEXT,                            -- where it runs, in the maintainer's words (a VPS, a rack, a room)
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at  TEXT NOT NULL,                   -- created_at + 15 minutes
    used_at     TEXT,                            -- burnt by POST /hosts/enroll, once
    host_id     TEXT                             -- the host it made
);
CREATE INDEX idx_host_enrollments_login ON host_enrollments (login, created_at DESC);

CREATE TABLE hosts (
    id               TEXT PRIMARY KEY,           -- h_<10 base36>
    owner_login      TEXT NOT NULL,
    owner_github_id  INTEGER NOT NULL,
    name             TEXT NOT NULL,
    "where"          TEXT,
    pubkey           TEXT NOT NULL UNIQUE,       -- Ed25519, raw 32 bytes, base64url
    status           TEXT NOT NULL DEFAULT 'pending-owner'
                     CHECK (status IN ('pending-owner', 'active', 'suspended', 'retired')),
    hostname         TEXT,
    os               TEXT,
    arch             TEXT,                       -- the native architecture
    page_kb          INTEGER,
    runtime          TEXT,                       -- JSON: the runtime fingerprint the agent reported
    isolation        TEXT,                       -- root | user | subuid
    dedicated        INTEGER,                    -- 1: a machine or VM used only as a pool host
    capacity         TEXT,                       -- JSON: the last capacity report, as the pool read it
    lanes            TEXT,                       -- JSON [{arch, mode, via?, page16k?}]
    units            INTEGER,                    -- recomputed by the pool from the reported totals and the signed constants
    agent_slots      INTEGER,
    disk_free        TEXT,                       -- JSON {work, engine} in GB
    pool_cap_units   INTEGER,                    -- a pool-side cap (P2); NULL = none
    reserving_task   INTEGER,                    -- P2
    provider         TEXT,
    model            TEXT,
    agent_version    TEXT,
    release_applied  TEXT,
    release_target   TEXT,
    rolled_back_from TEXT,
    report           TEXT,                       -- JSON: the last host report, at most 16 KiB
    reported_at      TEXT,                       -- the pool's time of the last report
    last_seen        TEXT,                       -- the pool's time of the last signed request
    enrolled_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    confirmed_at     TEXT,
    worker_id        TEXT,                       -- its one registration, made at confirm
    token_issued_at  TEXT,                       -- when its worker token was last minted (rotated every 30 days)
    -- Token rotation: the token a rotation replaced stays valid for ten minutes, so
    -- only the dispatcher is recreated and its running tasks never notice. Kept here,
    -- not on build_workers, whose row a Worker from before #321 spreads in its listings.
    prev_token_hash  TEXT,
    prev_token_until TEXT
);
CREATE INDEX idx_hosts_owner ON hosts (owner_login, enrolled_at DESC);
CREATE INDEX idx_hosts_confirmed ON hosts (confirmed_at DESC);
CREATE INDEX idx_hosts_prev_token ON hosts (prev_token_hash) WHERE prev_token_hash IS NOT NULL;

-- A signed request's nonce, kept past the 120-second window and pruned by the
-- cron: the same (host, nonce) twice is a replay.
CREATE TABLE host_nonces (
    host_id TEXT NOT NULL,
    nonce   TEXT NOT NULL,
    at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (host_id, nonce)
) WITHOUT ROWID;
CREATE INDEX idx_host_nonces_at ON host_nonces (at);

-- A host's one worker registration, and the legacy ones (every row before).
ALTER TABLE build_workers ADD COLUMN host_id TEXT;
ALTER TABLE build_workers ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy' CHECK (kind IN ('host', 'legacy'));
CREATE UNIQUE INDEX idx_build_workers_host ON build_workers (host_id) WHERE host_id IS NOT NULL;
