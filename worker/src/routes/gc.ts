import { json, type Env } from "../index";
import { RINGS, ringsSql } from "../meta";
import { sweepStaging } from "../staging";
import { GRACE_DAYS, KEEP_RELEASES, outsideRetention, retention } from "../db";

/**
 * What retention would delete now: what is outside it (db.ts: the rule
 * and its predicate, shared with the metrics snapshot's reclaimable
 * count) and past the grace period. `?keep=N` (default 3), `?grace_days=N`
 * (default 7).
 */
async function unreferenced(env: Env, keep: number, graceDays: number) {
  const { protectedReleases, keptCheckpoints, checkpointSeq } = await retention(env, keep);
  const rows = await env.DB.prepare(
    `SELECT id, sha256, name, version, arch, repo_arch, filename, size_download, source, COALESCE(r2_key, repo_arch || '/' || filename) AS r2_key FROM packages p
      WHERE p.created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?3)
        AND ${outsideRetention("p")}
      ORDER BY p.id`,
  )
    .bind(JSON.stringify(protectedReleases), JSON.stringify(keptCheckpoints), `-${graceDays} days`)
    .all<{ id: number; sha256: string; name: string; version: string; arch: string; repo_arch: string; filename: string; size_download: number; source: string; r2_key: string }>();
  return { protectedReleases, keptCheckpoints, checkpointSeq, packages: rows.results };
}

function graceOf(url: URL): number {
  return Math.max(0, Number(url.searchParams.get("grace_days") ?? GRACE_DAYS));
}

export async function handleUnreferenced(url: URL, env: Env): Promise<Response> {
  const keep = Math.max(1, Number(url.searchParams.get("keep") ?? KEEP_RELEASES));
  const { protectedReleases, keptCheckpoints, packages } = await unreferenced(env, keep, graceOf(url));
  return json({
    keep,
    grace_days: graceOf(url),
    protected_releases: protectedReleases,
    kept_checkpoints: keptCheckpoints,
    count: packages.length,
    bytes: packages.reduce((a, p) => a + p.size_download, 0),
    packages,
  });
}

/**
 * Deletes unreferenced packages: R2 objects first, then the index rows.
 * Before that, the checkpoints nothing inside retention starts from, and
 * the deltas older than a kept checkpoint, are dropped: a release whose
 * objects are being deleted cannot be served or rolled back to anyway, its
 * row, summary and note stay in the history.
 */
export async function handleGc(url: URL, env: Env): Promise<Response> {
  const keep = Math.max(1, Number(url.searchParams.get("keep") ?? KEEP_RELEASES));
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);
  const { protectedReleases, keptCheckpoints, checkpointSeq, packages } = await unreferenced(env, keep, graceOf(url));
  const pruned = await env.DB.prepare("DELETE FROM release_packages WHERE release_id NOT IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(keptCheckpoints))
    .run();
  await env.DB.prepare("UPDATE releases SET checkpoint = 0 WHERE checkpoint = 1 AND id NOT IN (SELECT value FROM json_each(?))").bind(JSON.stringify(keptCheckpoints)).run();
  let deltasPruned = 0;
  for (const [ring, seq] of Object.entries(checkpointSeq)) {
    const d = await env.DB.prepare("DELETE FROM release_deltas WHERE release_id IN (SELECT id FROM releases WHERE ring = ? AND seq <= ?)").bind(ring, seq).run();
    deltasPruned += d.meta.changes ?? 0;
  }
  const victims = packages.slice(0, limit);
  let bytes = 0;
  let objectsKept = 0;
  let deleted = 0;
  let takenBack = 0;
  // The membership tables carry no foreign key to packages (migration
  // 0035: the check scanned both tables for every delete), so what kept a
  // served row from being deleted is this loop. The victims were listed
  // minutes ago and nothing serialises GC against a sync or a rollback: a
  // sync that re-indexes bytes already in the pool gets the old row back
  // ("already-indexed"), and the release that follows puts its id into
  // ring_packages again. So a victim is asked once more, right before its
  // object goes, whether a ring serves it now (a probe of the PK, 2-4
  // rows), and every DELETE of the batch carries the same condition, so
  // the batch can never take a row, or a row's lists, that a ring names:
  // the row's DELETE changing nothing says a ring took it back in between.
  const served = `SELECT 1 FROM ring_packages WHERE ring IN (${ringsSql(RINGS)}) AND package_id = ?1`;
  const unless = `WHERE package_id = ?1 AND NOT EXISTS (${served})`;
  for (const p of victims) {
    if (await env.DB.prepare(`${served} LIMIT 1`).bind(p.id).first()) {
      takenBack++;
      continue;
    }
    // One object per key: an upstream rebuild of the same version with
    // different bytes (the OPR, per channel) can leave two index rows
    // behind one key. The row goes; the object only when no other row —
    // served or not — still names it (a ghost row names no object). Every
    // key form ends with '/' || filename — source/arch/filename (r2.ts
    // packageKey), the flat arch/filename a row had before the relayout,
    // ghost/source/arch/filename (routes/relayout.ts) — so a row that
    // names the same object has the same filename: the filename term only
    // narrows, through idx_packages_filename, and the key equality stays
    // the truth. Without it the check scanned the packages table per
    // victim: 34,808 rows read for each of the 3,552 deletes of 2026-09-20.
    const shared = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM packages WHERE filename = ?1 AND id != ?2 AND COALESCE(r2_key, repo_arch || '/' || filename) = ?3",
    ).bind(p.filename, p.id, p.r2_key).first<{ n: number }>();
    if (shared?.n) objectsKept++;
    else if (!p.r2_key.startsWith("ghost/")) await env.PACKAGES.delete([p.r2_key, `${p.r2_key}.sig`, `${p.r2_key}.provenance.json`, `${p.r2_key}.provenance.json.sig`]);
    const gone = await env.DB.batch([
      env.DB.prepare(`DELETE FROM package_provides ${unless}`).bind(p.id),
      env.DB.prepare(`DELETE FROM package_requires ${unless}`).bind(p.id),
      env.DB.prepare(`DELETE FROM package_files ${unless}`).bind(p.id),
      env.DB.prepare(`DELETE FROM package_file_lists ${unless}`).bind(p.id),
      env.DB.prepare(`DELETE FROM package_components ${unless}`).bind(p.id),
      env.DB.prepare(`DELETE FROM packages WHERE id = ?1 AND NOT EXISTS (${served})`).bind(p.id),
    ]);
    if (!(gone.at(-1)?.meta.changes ?? 0)) {
      takenBack++;
      continue;
    }
    deleted++;
    bytes += p.size_download;
  }
  // Advisories and matches are replaced by every security run (the run
  // prunes what it did not post); the CVE metadata behind them (KEV,
  // EPSS) is not, so a CVE no advisory mentions any more goes after 90
  // days.
  const cves = await env.DB.prepare(
    `DELETE FROM cve_meta WHERE updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')
       AND NOT EXISTS (SELECT 1 FROM advisories a, json_each(a.cves) j WHERE j.value = cve_meta.cve)`,
  ).run();
  // Staging (staging.ts): what is past its 30 days goes with its rows, so a
  // contributor's quota never counts objects the bucket already dropped;
  // the packages of finished builds a transition missed go too.
  const staging = await sweepStaging(env);
  return json({ keep, deleted, taken_back_by_a_ring: takenBack, objects_kept_for_another_row: objectsKept, bytes, remaining: packages.length - victims.length, protected_releases: protectedReleases, kept_checkpoints: keptCheckpoints, membership_rows_pruned: pruned.meta.changes ?? 0, delta_rows_pruned: deltasPruned, cve_meta_pruned: cves.meta.changes ?? 0, staging });
}
