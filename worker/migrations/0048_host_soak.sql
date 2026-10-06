-- The owner's soak and freeze detection (#326, epic #307, design v2 D16,
-- §5.5): what a host's last report says of them, read by the report's
-- handler with its own JSON readers (src/hosts.ts soakOf, poolBehindOf) and
-- kept in plain columns, which every claim of its registration
-- (HOST_CLAIM_SQL), the fleet each claim selects over (FLEET_SQL), the
-- workers' listings and Status read. No statement parses hosts.report:
-- SQLite's JSON parser refuses what V8's accepts (nesting deeper than 1000
-- levels), and one host's report would fail every statement that read it,
-- the pool's claims and listings with it.
--
-- - hosts.soaking_until: when its agent says the soak of the release the pool
--   names ends (`release.soaking_until`), an ISO time; null when none.
-- - hosts.soak_quarantine: with a soak, the releases its report holds in
--   quarantine, a JSON array of {"release", "until"} — `until` an ISO time,
--   or null: until a newer release.
-- - hosts.pool_behind_github: `release.pool_behind_github`, {"github",
--   "pool", "since"}; null when its agent does not say it.
--
-- Additive only: the Worker that runs during the deploy minute reads and
-- writes none of it; each host's next report fills them.
ALTER TABLE hosts ADD COLUMN soaking_until TEXT;
ALTER TABLE hosts ADD COLUMN soak_quarantine TEXT;
ALTER TABLE hosts ADD COLUMN pool_behind_github TEXT;
