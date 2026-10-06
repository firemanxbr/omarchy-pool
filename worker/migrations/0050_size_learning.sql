-- Automatic task-size learning (#330, epic #307, design v2 §7.4; D31, P6): the
-- size the pool remembers for a package from its own builds, apart from the
-- size a maintainer set (factory_packages.size, factory/sizing/tasks.toml),
-- which wins over it.
--
-- - learned_size: 2 up to the signed max_size, or NULL — nothing learned, size
--   1. Raised one step after the engine killed one of its builds at its memory
--   limit (a host's `oom`, handleFail), never above community_max_size for a
--   contributor's build nor max_size for the project's; one step lower after
--   DECAY_AFTER (5) builds in a row that completed with a memory peak below
--   what the size under it gives (handleComplete, the dispatcher's
--   `ram_peak_mb`). worker/src/sizing.ts afterOom / afterBuild.
-- - learned_lower: those builds in a row so far; an out-of-memory kill, or a
--   build that peaked at or above it, starts the count over.
-- - learned_task, learned_why ('oom' | 'decay'), learned_at: the report that
--   last changed learned_size, as the package page says it.
--
-- Read by the claim after the page's and the file's size (routes/factory.ts
-- askedSql, PACKAGE_SIZES_SQL) and by the package's story (sizingView).
-- Written compare-and-set (learnSize), so two reports of one package at once
-- never count one build twice nor lose a raise.
--
-- Additive only: the Worker that runs during the deploy minute reads and
-- writes none of it.
ALTER TABLE factory_packages ADD COLUMN learned_size INTEGER;
ALTER TABLE factory_packages ADD COLUMN learned_lower INTEGER NOT NULL DEFAULT 0;
ALTER TABLE factory_packages ADD COLUMN learned_task INTEGER;
ALTER TABLE factory_packages ADD COLUMN learned_why TEXT CHECK (learned_why IN ('oom', 'decay'));
ALTER TABLE factory_packages ADD COLUMN learned_at TEXT;
