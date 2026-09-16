-- Project trust on two maintainers' word (SECURITY.md, *Trust levels*): the
-- first maintainer proposes, a second — never the worker's owner, never the
-- same person — confirms, and trusted_by names both. Until then the
-- proposal waits here. Workers trusted before this rule keep their trust
-- and the one name; a maintainer can set them back to community and have
-- them proposed again.
ALTER TABLE build_workers ADD COLUMN trust_proposed_by TEXT;
ALTER TABLE build_workers ADD COLUMN trust_proposed_at TEXT;
