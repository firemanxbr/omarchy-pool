-- An approval that broke the rule — nobody decides on their own package —
-- or that a maintainer takes back for any reason on the record: the row
-- stays (the record is never rewritten), these three say it is void. A
-- withdrawn approval counts for nothing: the package leaves every ring it
-- reached through it, the chain is evidence again, another maintainer
-- decides. felix, approved by its own contributor during the bootstrap,
-- was the first (2026-09-17).
ALTER TABLE approvals ADD COLUMN withdrawn_at TEXT;
ALTER TABLE approvals ADD COLUMN withdrawn_by TEXT;
ALTER TABLE approvals ADD COLUMN withdrawn_reason TEXT;
