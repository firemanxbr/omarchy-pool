-- One name, one package (#242). A package is its name: x86_64 and aarch64
-- are two targets of it — two artifacts, each built on a worker of its
-- architecture — and a request, a review and a block are about the name,
-- never about one architecture of it. Until now a maintainer decided per
-- build (routes/review.ts): a package built for both architectures was two
-- rows waiting on Review, two approvals and two withdrawals, and an
-- architecture that never built was a line in the registration's detail.
--
-- reviews: the decision, once per package. The rows the decisions wrote per
-- architecture (approvals) stay as they are — the record is never rewritten
-- — and each now names the review it is a target of (approvals.review_id):
-- what a review approved on x86_64 is its row whose arch is x86_64, with the
-- build that row published (rebuild_task), read by the seal and the bumps as
-- before. The rows already there are merged below into the decisions they
-- were: the same package, version, word and maintainer, standing or
-- withdrawn alike — each architecture's first row with the other's first,
-- second with second — and a review's id is its first row's, so an approval
-- id on the record (a withdrawal's signed record, a journal line) still
-- names the decision.
--
-- factory_packages.targets: where each architecture of the package stands —
-- {"x86_64": {"status": "built", "task": 12}, "aarch64": {"status":
-- "not_supported", "task": 13}} — kept by the brain at every transition
-- (targets.ts, settleTargets) and derived below for what is there today by
-- the same rule (targetsOf; test/package-identity.test.ts holds the two
-- together). closed_through: the last build of a round that a rejection or
-- a block closed; an older build that ended is history, not where the
-- package stands. freed_by_review: the review whose rejection freed the
-- name — anyone may request it while the registration says `rejected` —
-- and NULL while the name is held; a contributor's block also writes
-- `rejected`, and holds their names. Every row here is NULL: a rejection
-- before this rule freed nothing.
--
-- Additive only, so the Worker and the schema never disagree during a
-- deploy: the Release workflow applies the migrations and then deploys, and
-- for that minute the previous Worker runs on this schema. It reads none of
-- the new columns and writes none of them; an approval it writes then has no
-- review and is read by the new code as a review of its own, and a target it
-- moves without saying so is set right at the package's next transition.
CREATE TABLE reviews (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    version          TEXT,
    decision         TEXT    NOT NULL CHECK (decision IN ('approved', 'rejected')),
    by               TEXT    NOT NULL,                -- maintainer login
    note             TEXT,
    arches           TEXT    NOT NULL DEFAULT '[]',   -- JSON: the targets it decided, one approvals row each, in their order
    not_supported    TEXT    NOT NULL DEFAULT '{}',   -- JSON {arch: task}: requested, never built — outside the decision
    released         INTEGER NOT NULL DEFAULT 0,      -- 1: a rejection that freed the name
    migrated         INTEGER NOT NULL DEFAULT 0,      -- 1: merged here from the rows of one decision per architecture
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    withdrawn_at     TEXT,
    withdrawn_by     TEXT,
    withdrawn_reason TEXT
);
CREATE INDEX idx_reviews_name ON reviews (name, id);

ALTER TABLE approvals ADD COLUMN review_id INTEGER;   -- the review this row is a target of; NULL: written by a Worker older than reviews
CREATE INDEX idx_approvals_review ON approvals (review_id);

ALTER TABLE factory_packages ADD COLUMN targets TEXT;            -- JSON {arch: {status, task}}
ALTER TABLE factory_packages ADD COLUMN closed_through INTEGER NOT NULL DEFAULT 0;
ALTER TABLE factory_packages ADD COLUMN freed_by_review INTEGER;  -- reviews.id; NULL: the name is held

-- The decisions: a row's review is the first row of its group, by id.
UPDATE approvals SET review_id = m.review_id
  FROM (SELECT id, MIN(id) OVER (PARTITION BY name, COALESCE(version, ''), decision, by, withdrawn_at IS NULL, nth) AS review_id
          FROM (SELECT id, name, version, decision, by, withdrawn_at,
                       ROW_NUMBER() OVER (PARTITION BY name, COALESCE(version, ''), decision, by, withdrawn_at IS NULL, arch ORDER BY id) AS nth
                  FROM approvals)) AS m
 WHERE m.id = approvals.id;

INSERT INTO reviews (id, name, version, decision, by, note, arches, migrated, created_at, withdrawn_at, withdrawn_by, withdrawn_reason)
  SELECT a.id, a.name, a.version, a.decision, a.by, a.note,
         (SELECT json_group_array(t.arch) FROM (SELECT arch FROM approvals WHERE review_id = a.id ORDER BY id) AS t),
         1, a.created_at, a.withdrawn_at, a.withdrawn_by, a.withdrawn_reason
    FROM approvals a
   WHERE a.review_id = a.id;

-- Where a round ended: at the newest build a rejection decided — for a
-- package no approval stands on, a request sent back; a new version of one
-- in the pool leaves where its architectures stood — and, for a package
-- blocked now, at its newest build (the block cancelled the rest).
UPDATE factory_packages SET closed_through = COALESCE((
  SELECT MAX(MAX(a.task_id, COALESCE(a.rebuild_task, 0))) FROM approvals a WHERE a.name = factory_packages.name AND a.decision = 'rejected'
), 0)
 WHERE NOT EXISTS (SELECT 1 FROM approvals a WHERE a.name = factory_packages.name AND a.decision = 'approved' AND a.withdrawn_at IS NULL);
UPDATE factory_packages SET closed_through = MAX(closed_through, COALESCE((SELECT MAX(t.id) FROM build_tasks t WHERE t.name = factory_packages.name AND t.kind = 'build'), 0))
 WHERE blocked_at IS NOT NULL;

-- The targets, by targetsOf's rule (targets.ts), computed once into a table
-- of their own and copied onto the packages: per requested architecture (and
-- any other an approval stands on), the newest build that says where it
-- stands — not cancelled, not a dry run, not one a round closed, not a
-- published build whose approval was taken back, and not a failed build of
-- an architecture an approval stands on (its next version's failure: the
-- approved one is still where it stands).
CREATE TABLE target_merge AS
  WITH b AS (
    SELECT t.id, t.name, t.arch, t.status, t.trust, p.closed_through,
           EXISTS (SELECT 1 FROM approvals a WHERE a.name = t.name AND a.arch = t.arch AND a.decision = 'approved' AND a.withdrawn_at IS NULL AND (a.task_id = t.id OR a.rebuild_task = t.id)) AS standing,
           EXISTS (SELECT 1 FROM approvals a WHERE a.name = t.name AND a.arch = t.arch AND a.decision = 'approved' AND a.withdrawn_at IS NOT NULL AND (a.task_id = t.id OR a.rebuild_task = t.id)) AS withdrawn,
           EXISTS (SELECT 1 FROM approvals a WHERE a.name = t.name AND a.arch = t.arch AND a.decision = 'approved' AND a.withdrawn_at IS NULL) AS served
      FROM build_tasks t JOIN factory_packages p ON p.name = t.name
     WHERE t.kind = 'build' AND t.status != 'cancelled' AND t.arch IN ('x86_64', 'aarch64')
       AND NOT (t.trust = 'project' AND json_extract(t.params, '$.review') IS NULL AND t.publish = 0)
  ), c AS (
    SELECT b.*, ROW_NUMBER() OVER (PARTITION BY b.name, b.arch ORDER BY b.id DESC) AS rn
      FROM b
     WHERE (b.status IN ('queued', 'leased', 'staged') OR b.standing OR b.id > b.closed_through)
       AND NOT (b.status = 'done' AND NOT b.standing AND (b.withdrawn OR b.trust = 'community'))
       AND NOT (b.status = 'failed' AND b.served)
  )
  SELECT name, arch, id AS task,
         CASE
           WHEN status IN ('queued', 'leased') THEN CASE WHEN trust = 'project' THEN 'reviewing' ELSE 'building' END
           WHEN status = 'staged' THEN CASE WHEN standing THEN 'approved' WHEN trust = 'project' THEN 'reviewed' ELSE 'built' END
           WHEN status = 'done' THEN 'published'
           ELSE 'not_supported'
         END AS status
    FROM c WHERE rn = 1;

UPDATE factory_packages SET targets = (
  SELECT json_group_object(x.arch, json_object('status', COALESCE(m.status, 'waiting'), 'task', m.task))
    FROM (SELECT arch FROM (SELECT j.value AS arch FROM json_each(factory_packages.arches) j WHERE j.value IN ('x86_64', 'aarch64')
                            UNION
                            SELECT a.arch FROM approvals a WHERE a.name = factory_packages.name AND a.decision = 'approved' AND a.withdrawn_at IS NULL AND a.arch IN ('x86_64', 'aarch64'))
           ORDER BY CASE arch WHEN 'x86_64' THEN 0 ELSE 1 END) AS x
    LEFT JOIN target_merge m ON m.name = factory_packages.name AND m.arch = x.arch
);

DROP TABLE target_merge;
