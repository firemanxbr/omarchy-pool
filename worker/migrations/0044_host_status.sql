-- Suspend, retire and the maintainer list's effect on a host (#322, epic #307,
-- design v2 §6.2, §6.4; D20, D39, D57). The statuses themselves (suspended,
-- retired) are 0043's CHECK; this adds who moved a host there and why, and
-- the one fact the MAINTAINERS.toml sync writes.
--
-- Additive only: the Worker that runs during the deploy minute reads and
-- writes none of it.

-- Who suspended, resumed or retired the host last, when and why — what its
-- page says beside the status; the journal keeps every one.
ALTER TABLE hosts ADD COLUMN status_by TEXT;
ALTER TABLE hosts ADD COLUMN status_at TEXT;
ALTER TABLE hosts ADD COLUMN status_reason TEXT;

-- The sync found the host's owner no longer resolved from factory/MAINTAINERS.toml
-- (D39): the host claims nothing from then on, its running leases finish, and it
-- claims again only after its owner's one Resume, once they are listed again.
-- NULL = not stopped by the list.
ALTER TABLE hosts ADD COLUMN owner_removed_at TEXT;
