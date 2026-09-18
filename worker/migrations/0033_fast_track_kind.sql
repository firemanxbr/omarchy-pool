-- The security job's fast-track wrote its journal line as `fasttrack`,
-- while a factory build's fast lane wrote `fast-track` — the journal's chip,
-- the Pipeline's count and metrics' rings-moved saw half of them. The word
-- is one now (pkg-repo security.rs); the lines already written follow.
UPDATE events SET kind = 'fast-track' WHERE kind = 'fasttrack';
