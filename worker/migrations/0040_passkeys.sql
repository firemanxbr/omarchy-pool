-- Passkeys (#257): approve and block, drafted by an agent (#252), are
-- confirmed in the browser with a WebAuthn assertion with user verification
-- — a touch and a PIN or a biometric that the agent's software cannot
-- supply — checked by the Worker against the key stored here
-- (worker/src/webauthn.ts, routes/passkeys.ts). docs:
-- worker/src/docs/omarchy-cli-mcp.md, *A passkey for approve and block*.
--
-- passkeys: one row per passkey a maintainer registered on their own page.
-- Only what verification needs: the credential's id, its public key as the
-- authenticator wrote it (COSE), the algorithm, the relying party it is for,
-- the signature counter at its last use, a label the person chose, when it
-- was registered and last used. No attestation, no device name. Removal
-- deletes the row; the journal keeps who registered and removed which one,
-- and when (kind 'passkey'), never the key. Ten per login at most.
--
-- passkey_challenges: what the browser signs, issued once and taken once.
-- A registration's is bound to the login; a confirmation's to the login and
-- one draft. Each lives five minutes, is deleted by the statement that takes
-- it — used or refused — and a login holds five live ones at most; the
-- expired ones go at the login's next issue and in the weekly gc.
--
-- Additive only: the previous Worker runs on this schema during the deploy
-- minute, and reads and writes none of it.
CREATE TABLE passkeys (
    id             TEXT PRIMARY KEY,               -- pk_<32 hex>: on the person's page and the journal line
    login          TEXT NOT NULL,                  -- the GitHub login that registered it (the session's)
    credential_id  TEXT NOT NULL,                  -- base64url of the authenticator's credential id
    public_key     TEXT NOT NULL,                  -- base64url of the COSE public key, as the authenticator wrote it
    alg            INTEGER NOT NULL,               -- COSE: -7 ES256, -8 EdDSA, -257 RS256
    rp_id          TEXT NOT NULL,                  -- the relying party it was registered for: omarchy-pool.org, or localhost in development
    counter        INTEGER NOT NULL DEFAULT 0,     -- the signature counter at its last use; 0 for an authenticator that keeps none
    label          TEXT NOT NULL,                  -- the person's name for it: "laptop", "security key"
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_used      TEXT
);
CREATE UNIQUE INDEX idx_passkeys_credential ON passkeys (credential_id);
CREATE INDEX idx_passkeys_login ON passkeys (login, created_at);

CREATE TABLE passkey_challenges (
    challenge   TEXT PRIMARY KEY,                  -- base64url of 32 random bytes
    login       TEXT NOT NULL,
    purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'confirm')),
    draft_id    TEXT,                              -- the draft a confirmation's challenge is for; NULL for a registration
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at  TEXT NOT NULL
);
-- A login's challenges by their expiry: the five-live cap at issue, and the expired ones deleted then.
CREATE INDEX idx_passkey_challenges_login ON passkey_challenges (login, expires_at);
-- Every login's expired challenges, for the weekly gc.
CREATE INDEX idx_passkey_challenges_expires ON passkey_challenges (expires_at);
