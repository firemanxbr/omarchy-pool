-- The security job's prune no longer looks for what an earlier run wrote by
-- updated_at: the index writes an advisory only when a field changed, so the
-- column means "last changed" and the run posts its key set instead
-- (routes/security.ts handlePrune). Nothing reads advisories by updated_at
-- any more; every changed advisory was paying a third row to keep the index.
DROP INDEX IF EXISTS idx_advisories_updated;
