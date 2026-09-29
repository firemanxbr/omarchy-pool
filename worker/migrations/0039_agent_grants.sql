-- The MCP write tools (#252): an agent acts as one GitHub login through a
-- token that login granted it in the browser (routes/agents.ts, the loopback
-- flow of RFC 8252 with PKCE S256), and drafts the decisions the person
-- confirms there. docs: worker/src/docs/omarchy-cli-mcp.md.
--
-- agent_grants: one row per grant. The Grant form (posted with the session)
-- writes it with the one-time code's hash and the PKCE challenge; the swap
-- (POST /auth/agent/token) sets the token's hash and clears the code in one
-- conditional update. The token is `oma_` and 192 random bits, kept as its
-- SHA-256 like the contributor and worker tokens. `scopes` is a JSON list of
-- contribute, review and block; `expires_at` is set at Grant by scope (seven
-- days for a grant that holds review or block, thirty by default and ninety
-- at most for contribute alone). `last_used` moves once per ten minutes, as
-- contributors.last_seen does.
--
-- drafts: a decision an agent drafted (approve, request changes, reject, or
-- a block) and the person confirms on /auth/confirm/<id>, signed in as the
-- same login. It is spent by one conditional update (used_at) before the
-- decision's handler runs, so one draft decides once; it expires thirty
-- minutes after it was drafted. A draft writes no journal line: until it is
-- confirmed it is on the person's own page only (GET /factory/me).
--
-- package_requests.agent, approvals.agent: the agent a write came through,
-- as JSON {agent, client, grant[, draft]} — NULL for the web and the command
-- line, as every row before this migration.
--
-- contributors.agent_*: the day's counts of what agents wrote for the login
-- (requests, claims — a release counts as one — and drafts), across all its
-- grants and agent names; the day is UTC. A conditional update on the
-- primary key moves a count before the write.
--
-- idx_build_workers_owner: /factory/me reads a person's workers by owner,
-- newest first; it scanned every worker ever registered.
--
-- Additive only: the previous Worker runs on this schema during the deploy
-- minute, and reads and writes none of it.
CREATE TABLE agent_grants (
    id               TEXT PRIMARY KEY,                -- g_<32 hex>: named on the person's page, on drafts and on the record
    login            TEXT NOT NULL,                   -- the GitHub login that granted it (the session's)
    agent            TEXT NOT NULL,                   -- the agent's name, as the person gave it at login
    scopes           TEXT NOT NULL,                   -- JSON: ["contribute"], ["contribute","review","block"], ...
    token_hash       TEXT,                            -- sha256 of the oma_ token; NULL until the code is swapped
    code_hash        TEXT,                            -- sha256 of the one-time code; NULL once swapped
    challenge        TEXT,                            -- PKCE S256 challenge (base64url); NULL once swapped
    code_expires_at  TEXT,                            -- a minute after Grant; NULL once swapped
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at       TEXT NOT NULL,
    revoked_at       TEXT,
    revoked_by       TEXT,                            -- a login, 'logout', 'replaced' (a new grant of the same agent name) or 'blocked'
    last_used        TEXT
);
CREATE UNIQUE INDEX idx_agent_grants_token ON agent_grants (token_hash);
CREATE UNIQUE INDEX idx_agent_grants_code ON agent_grants (code_hash);
CREATE INDEX idx_agent_grants_login ON agent_grants (login, created_at);
-- The codes nobody swapped, by their expiry: the weekly gc deletes them.
CREATE INDEX idx_agent_grants_pending ON agent_grants (code_expires_at) WHERE token_hash IS NULL;

CREATE TABLE drafts (
    id           TEXT PRIMARY KEY,                    -- d_<32 hex>: unguessable, the confirm link's
    grant_id     TEXT NOT NULL,
    login        TEXT NOT NULL,
    agent        TEXT NOT NULL,                       -- the grant's name for the agent
    client       TEXT,                                -- what the agent's client says it is (x-omarchy-client)
    verdict      TEXT NOT NULL CHECK (verdict IN ('approve', 'request_changes', 'reject', 'block')),
    note         TEXT NOT NULL,
    name         TEXT NOT NULL,                       -- the package
    task_id      INTEGER,                             -- the build a verdict was drafted on; NULL for a block
    facts        TEXT NOT NULL,                       -- sha256 of the facts it was drafted on
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at   TEXT NOT NULL,
    used_at      TEXT,                                -- spent: confirmed or discarded, once
    state        TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'confirmed', 'refused', 'discarded')),
    outcome      TEXT                                 -- JSON: the decision's answer, or why it was refused
);
CREATE INDEX idx_drafts_login ON drafts (login, created_at);

ALTER TABLE package_requests ADD COLUMN agent TEXT;
ALTER TABLE approvals ADD COLUMN agent TEXT;

ALTER TABLE contributors ADD COLUMN agent_day TEXT;
ALTER TABLE contributors ADD COLUMN agent_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contributors ADD COLUMN agent_claims INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contributors ADD COLUMN agent_drafts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_build_workers_owner ON build_workers (owner, last_seen);
