-- The owner's control without a visit (#328, epic #307, design v2 §12, §14,
-- D6 b): a widening of a host's envelope and its agent keys, given on the
-- site and taken by the host only when the owner's passkey pinned there
-- signed them. The pool relays; it can forge neither, nor read a key.
--
-- - host_orders: its kind's CHECK names the two new orders, widen-envelope
--   and set-agent-keys. SQLite cannot widen a CHECK in place, so the table is
--   made again with the same columns, rows and indexes (0046's, with 0047's
--   arg). Their arg is {"version", "doc", "assertion"}: the document the pool
--   wrote and the owner's passkey signed, relayed whole for the host to check
--   — for agent keys, values sealed in the browser to the host's seal key:
--   ciphertext, never a key.
-- - hosts.seal_key: the X25519 public key the host's agent reports, in a
--   report signed with its host key (base64url, 32 bytes).
-- - hosts.seal_confirmed: the seal key its owner confirmed with a passkey,
--   having compared its fingerprint with the host's own `omarchy-agent
--   status` — {"key", "by", "at", "passkey"}; the browser seals to that key
--   alone, and a key reported since is confirmed again first.
--
-- The Worker that runs during the deploy minute reads and writes host_orders
-- as before: the new table has the old one's columns, and its CHECK only
-- admits more; the two hosts columns it reads and writes none of.
CREATE TABLE host_orders_0049 (
    id             TEXT PRIMARY KEY,
    host_id        TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('retire-legacy','reconcile-now','set-units','set-emulate','rotate-token','retry-release','diagnostics','widen-envelope','set-agent-keys')),
    issued_by      TEXT NOT NULL,
    via            TEXT NOT NULL DEFAULT 'web',
    confirmed_with TEXT,
    issued_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    not_after      TEXT NOT NULL,
    state          TEXT NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open','done','refused','failed','expired','cancelled')),
    answered_at    TEXT,
    detail         TEXT,
    arg            TEXT
);
INSERT INTO host_orders_0049 (id, host_id, kind, issued_by, via, confirmed_with, issued_at, not_after, state, answered_at, detail, arg)
  SELECT id, host_id, kind, issued_by, via, confirmed_with, issued_at, not_after, state, answered_at, detail, arg FROM host_orders;
DROP TABLE host_orders;
ALTER TABLE host_orders_0049 RENAME TO host_orders;
CREATE UNIQUE INDEX uq_host_orders_open_kind ON host_orders (host_id, kind) WHERE state = 'open';
CREATE INDEX idx_host_orders_host ON host_orders (host_id, issued_at DESC);
CREATE INDEX idx_host_orders_open_until ON host_orders (not_after) WHERE state = 'open';
ALTER TABLE hosts ADD COLUMN seal_key TEXT;
ALTER TABLE hosts ADD COLUMN seal_confirmed TEXT;
