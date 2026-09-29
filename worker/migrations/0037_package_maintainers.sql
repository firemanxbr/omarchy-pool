-- A package's maintainer in the pool (#244): the maintainer who adopted it
-- (POST /api/v1/factory/packages/:name/adopt, routes/adopt.ts). One row per
-- name — the name is the package (#242) — so adopting is one statement that
-- either takes it or finds whose it is. A package the factory built needs no
-- row: the maintainer whose approval stands looks after it
-- (routes/users.ts, maintenanceOf). Additive: the Worker before this one
-- reads and writes nothing here.
CREATE TABLE package_maintainers (
    name  TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    since TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
