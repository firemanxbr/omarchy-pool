import type { Env } from "./index";

/**
 * Staging is where a build's objects wait for a decision; it is not the
 * record. What the pool needs of a build once it is decided — the recipe,
 * the log, the gate, the audit — is on the record (record.ts), signed. The
 * packages are most of the bytes and nobody needs them after: the project
 * builds its own, and that is what users get.
 *
 * So the pool gives a contributor's quota back on its own. The packages of
 * a build it is done with — superseded, rejected, failed for good, published,
 * cancelled — go at the transition (reclaimStagingPackages). Everything
 * older than STAGING_DAYS goes with the weekly gc (sweepStaging), rows and
 * objects together: the bucket's lifecycle rule deletes objects at the same
 * age, and a row without its object would count toward the quota for ever.
 * The sweep also takes the packages of finished builds a transition missed
 * (a block cancels in bulk; builds decided before this code).
 */

/** How long staging keeps a build: the R2 lifecycle rule on the bucket says the same. */
export const STAGING_DAYS = 30;

/**
 * Per contributor. With the pool giving space back on its own, 5 GB is a
 * dozen Electron apps staged at a time; R2 is not where the bill is (D1 is).
 */
export const STAGING_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

/** The evidence anyone may read: the recipe, the log, the metadata, the audit. Packages themselves are for maintainers. */
export function isTextEvidence(filename: string): boolean {
  return filename.endsWith(".log") || filename === "PKGBUILD" || filename === "PKGINFO" || filename.endsWith(".json") || filename.endsWith(".md");
}

type Row = { key: string; size: number };

function basename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/** R2 deletes up to 1000 keys per call; D1 binds up to 100 values, so the rows go by a JSON list. */
async function drop(env: Env, rows: Row[]): Promise<number> {
  if (!rows.length) return 0;
  const keys = rows.map((r) => r.key);
  for (let i = 0; i < keys.length; i += 1000) await env.STAGING.delete(keys.slice(i, i + 1000));
  await env.DB.prepare("DELETE FROM staging_objects WHERE key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(keys)).run();
  return rows.reduce((n, r) => n + r.size, 0);
}

/**
 * The packages of builds the pool is done with, gone now; their text
 * evidence stays until the sweep. Returns the bytes given back.
 */
export async function reclaimStagingPackages(env: Env, taskIds: (number | null | undefined)[]): Promise<number> {
  const ids = taskIds.filter((id): id is number => typeof id === "number" && id > 0);
  if (!ids.length) return 0;
  const rows = await env.DB.prepare("SELECT key, size FROM staging_objects WHERE task_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<Row>();
  return drop(env, rows.results.filter((r) => !isTextEvidence(basename(r.key))));
}

/**
 * The weekly sweep: rows past STAGING_DAYS with their objects, and the
 * packages of finished builds still in staging — cancelled, failed, done,
 * and a contributor's staged build whose project build is done (published:
 * the contributor's package was evidence, never the product).
 */
export async function sweepStaging(env: Env, limit = 500): Promise<{ expired: number; expired_bytes: number; reclaimed: number; reclaimed_bytes: number }> {
  const old = await env.DB.prepare("SELECT key, size FROM staging_objects WHERE uploaded_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) ORDER BY uploaded_at LIMIT ?")
    .bind(`-${STAGING_DAYS} days`, limit)
    .all<Row>();
  const expired_bytes = await drop(env, old.results);
  const finished = await env.DB.prepare(
    `SELECT s.key, s.size FROM staging_objects s JOIN build_tasks t ON t.id = s.task_id
      WHERE t.status IN ('cancelled', 'failed', 'done')
         OR (t.status = 'staged' AND t.trust = 'community'
             AND EXISTS (SELECT 1 FROM build_tasks p WHERE p.kind = 'build' AND p.trust = 'project' AND p.status = 'done' AND json_extract(p.params, '$.review') = t.id))
      LIMIT ?`,
  )
    .bind(limit)
    .all<Row>();
  const packages = finished.results.filter((r) => !isTextEvidence(basename(r.key)));
  const reclaimed_bytes = await drop(env, packages);
  return { expired: old.results.length, expired_bytes, reclaimed: packages.length, reclaimed_bytes };
}
