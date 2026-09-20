/** Index queries shared by several routes. */

import type { Env, Ring } from "./index";
import { RINGS, ringsSql } from "./meta";


export interface ReleaseRow {
  id: number;
  ring: Ring;
  seq: number;
  parent_id: number | null;
  source_id: number | null;
  note: string | null;
  created_at: string;
  /** Stored once the release is complete (migration 0015); null on rows older than that. */
  package_count?: number | null;
  bytes?: number | null;
  /** Per (source, arch) slices, JSON, computed once at creation (releaseSources). */
  sources?: string | null;
}

/** Checkpoint every this many releases of a ring (migration 0017): a reconstruction walks at most this many deltas. */
export const CHECKPOINT_EVERY = 24;

/**
 * The SQL that lists what a ring serves now — its head's selection, kept
 * live in ring_packages. A derived table: `JOIN ${ringMembers(ring)} rp ON
 * rp.package_id = p.id`. Ring names come from the `Ring` enum, so inlining
 * them is safe.
 */
export function ringMembers(ring: Ring): string {
  return `(SELECT package_id FROM ring_packages WHERE ring = '${ring}')`;
}

/**
 * The SQL that lists a release's package ids: the ring's live selection
 * when the release is a head (no rows written, nothing reconstructed),
 * otherwise its checkpoint rows, materialised first when it has none.
 */
export async function releaseMembers(env: Env, releaseId: number): Promise<string> {
  const head = await env.DB.prepare("SELECT ring FROM ring_heads WHERE release_id = ?").bind(releaseId).first<{ ring: Ring }>();
  if (head) return ringMembers(head.ring);
  await ensureCheckpoint(env, releaseId);
  return `(SELECT package_id FROM release_packages WHERE release_id = ${Math.floor(releaseId)})`;
}

/**
 * The same membership as a predicate on `${alias}.id`, for a query that
 * walks an index of `packages` and asks, row by row, whether the package is
 * in the release — a point lookup on the membership's primary key, instead
 * of a 30k-row selection materialized for every page.
 */
export async function releaseMemberPredicate(env: Env, releaseId: number, alias: string): Promise<string> {
  const head = await env.DB.prepare("SELECT ring FROM ring_heads WHERE release_id = ?").bind(releaseId).first<{ ring: Ring }>();
  if (head) return `EXISTS (SELECT 1 FROM ring_packages m WHERE m.ring = '${head.ring}' AND m.package_id = ${alias}.id)`;
  await ensureCheckpoint(env, releaseId);
  return `EXISTS (SELECT 1 FROM release_packages m WHERE m.release_id = ${Math.floor(releaseId)} AND m.package_id = ${alias}.id)`;
}

/**
 * Reconstructs a release that is not a checkpoint — the nearest checkpoint
 * behind it, then each delta up to it — and writes its membership into
 * release_packages so the SQL that reads a release by id works on it. A
 * one-off cost the size of the selection, paid only when an older release
 * is actually read (a pinned page, a diff, a rollback target).
 */
export async function ensureCheckpoint(env: Env, releaseId: number): Promise<void> {
  type Row = { id: number; parent_id: number | null; checkpoint: number };
  const start = await env.DB.prepare("SELECT id, parent_id, checkpoint FROM releases WHERE id = ?").bind(releaseId).first<Row>();
  if (!start) throw new Error(`release ${releaseId} does not exist`);
  if (start.checkpoint) return;
  // A head that is not a checkpoint: its rows are the ring's live ones.
  const head = await env.DB.prepare("SELECT ring FROM ring_heads WHERE release_id = ?").bind(releaseId).first<{ ring: Ring }>();
  const chain: Row[] = [start];
  let cur = start;
  while (!cur.checkpoint && !head) {
    if (cur.parent_id === null) throw new Error(`release ${releaseId} cannot be reconstructed: no checkpoint behind it`);
    const parent = await env.DB.prepare("SELECT id, parent_id, checkpoint FROM releases WHERE id = ?").bind(cur.parent_id).first<Row>();
    if (!parent) throw new Error(`release ${releaseId} cannot be reconstructed: release ${cur.parent_id} is gone`);
    chain.push(parent);
    cur = parent;
    if (chain.length > CHECKPOINT_EVERY * 4) throw new Error(`release ${releaseId} cannot be reconstructed: no checkpoint within ${chain.length} releases`);
  }
  const ids = new Set<number>();
  if (head) {
    for (const r of (await env.DB.prepare("SELECT package_id FROM ring_packages WHERE ring = ?").bind(head.ring).all<{ package_id: number }>()).results) ids.add(r.package_id);
  } else {
    const base = chain[chain.length - 1];
    for (const r of (await env.DB.prepare("SELECT package_id FROM release_packages WHERE release_id = ?").bind(base.id).all<{ package_id: number }>()).results) ids.add(r.package_id);
    // Oldest first, the checkpoint itself excluded.
    for (const r of chain.slice(0, -1).reverse()) {
      const deltas = await env.DB.prepare("SELECT package_id, op FROM release_deltas WHERE release_id = ?").bind(r.id).all<{ package_id: number; op: string }>();
      for (const d of deltas.results) {
        if (d.op === "remove") ids.delete(d.package_id);
        else ids.add(d.package_id);
      }
    }
  }
  const list = [...ids];
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < list.length; i += 2000) {
    const chunk = JSON.stringify(list.slice(i, i + 2000));
    // release_packages has no foreign key to packages (migration 0035),
    // so nothing but this check refuses a release whose packages GC took:
    // a release between the kept checkpoint and the protected ones added
    // packages a later release removed, and those are exactly what
    // retention deletes. Written anyway, its rows would name packages
    // that are gone, the page would render short and a rollback to it
    // would serve fewer packages than the release did, silently. The
    // count is a probe of the primary key per id, ~3 rows each.
    const present = await env.DB.prepare("SELECT COUNT(*) AS n FROM packages WHERE id IN (SELECT value FROM json_each(?))").bind(chunk).first<{ n: number }>();
    const missing = Math.min(list.length, i + 2000) - i - (present?.n ?? 0);
    if (missing > 0) throw new Error(`release ${releaseId} cannot be reconstructed: ${missing} of its packages were garbage-collected`);
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO release_packages (release_id, package_id) SELECT ?, value FROM json_each(?)").bind(releaseId, chunk));
  }
  stmts.push(env.DB.prepare("UPDATE releases SET checkpoint = 1 WHERE id = ?").bind(releaseId));
  await env.DB.batch(stmts);
}

/** Retention's defaults: the releases of a ring it protects, and the days an unreferenced object is kept (an import in progress). */
export const KEEP_RELEASES = 3;
export const GRACE_DAYS = 7;

/**
 * Retention: a package is protected while a ring serves it, while any of
 * the last `keep` releases of a ring added or removed it (a rollback
 * inside retention may need it back), while a kept checkpoint lists it,
 * or while it is younger than the grace period (an import in progress has
 * uploaded objects that no release pins yet). A kept checkpoint is, per
 * ring, the newest one at or before the oldest protected release — what
 * reconstructing any protected release starts from (migration 0017) —
 * and any checkpoint among the protected ones. What routes/gc.ts deletes
 * by and what the metrics snapshot counts as reclaimable: one rule.
 */
export async function retention(env: Env, keep: number): Promise<{ protectedReleases: number[]; keptCheckpoints: number[]; checkpointSeq: Record<string, number> }> {
  const protectedReleases: number[] = [];
  const keptCheckpoints: number[] = [];
  const checkpointSeq: Record<string, number> = {};
  for (const ring of RINGS) {
    const rows = await env.DB.prepare("SELECT id, seq, checkpoint FROM releases WHERE ring = ? ORDER BY seq DESC LIMIT ?")
      .bind(ring, keep)
      .all<{ id: number; seq: number; checkpoint: number }>();
    for (const r of rows.results) {
      protectedReleases.push(r.id);
      if (r.checkpoint) keptCheckpoints.push(r.id);
    }
    const oldest = rows.results.at(-1);
    if (!oldest) continue;
    const base = await env.DB.prepare("SELECT id, seq FROM releases WHERE ring = ? AND checkpoint = 1 AND seq <= ? ORDER BY seq DESC LIMIT 1")
      .bind(ring, oldest.seq)
      .first<{ id: number; seq: number }>();
    if (base) {
      if (!keptCheckpoints.includes(base.id)) keptCheckpoints.push(base.id);
      checkpointSeq[ring] = base.seq;
    }
  }
  return { protectedReleases, keptCheckpoints, checkpointSeq };
}

/**
 * The membership half of retention as a predicate on `${alias}.id`: no
 * ring serves the package, no kept checkpoint lists it, no protected
 * release's delta names it. The protected releases are bound as ?1 and
 * the kept checkpoints as ?2, both JSON arrays of ids (retention() above).
 * NOT EXISTS probes on the membership tables' primary keys — (ring,
 * package_id) and (release_id, package_id), so a ring name or a release
 * id leads each — instead of `id NOT IN (SELECT package_id …)`, which
 * materialised every row of ring_packages and of the listed checkpoints
 * per call: 302 k rows read on 2026-09-20 against 66 k, and the form
 * metrics.ts had listed every checkpoint, 1.4 M rows by the end of a
 * week. One probe per ring, in RINGS order, rather than `ring IN (…)`:
 * the AND chain stops at the first ring that serves the package, and edge
 * serves nearly everything, so a served package costs one index row
 * (98 k with the IN list, measured the same day). The ring names are the
 * constants of meta.ts.
 */
export function outsideRetention(alias: string): string {
  return [
    ...RINGS.map((ring) => `NOT EXISTS (SELECT 1 FROM ring_packages r WHERE r.ring = ${ringsSql([ring])} AND r.package_id = ${alias}.id)`),
    `NOT EXISTS (SELECT 1 FROM release_packages rp WHERE rp.release_id IN (SELECT value FROM json_each(?2)) AND rp.package_id = ${alias}.id)`,
    `NOT EXISTS (SELECT 1 FROM release_deltas d WHERE d.release_id IN (SELECT value FROM json_each(?1)) AND d.package_id = ${alias}.id)`,
  ].join("\n        AND ");
}

export async function ringHead(env: Env, ring: Ring): Promise<ReleaseRow | null> {
  return env.DB.prepare(
    "SELECT r.* FROM ring_heads h JOIN releases r ON r.id = h.release_id WHERE h.ring = ?",
  )
    .bind(ring)
    .first<ReleaseRow>();
}

/**
 * Manifests of a release. File lists dominate manifest size (a 10k-package
 * release is ~22 MB with them, ~5 MB without) and only `pkg-repo render`
 * needs them, so they are stripped unless `includeFiles` is set.
 */
export type ManifestDetail = "summary" | "default" | "files";

/** A window over a release's packages: an architecture, and a page of rows. */
export interface ManifestWindow {
  arch?: string | null;
  offset?: number;
  limit?: number;
  /** Keyset paging: the (name, repo_arch, source) of the last row of the previous page — the rows after it, in order (source null: an older cursor, after the name and arch). */
  after?: { name: string; repoArch: string; source: string | null } | null;
}

/**
 * Packages of a release, ordered by (name, arch). A whole 15k-package ring
 * with file lists is far more than one Worker invocation can hold, so callers
 * page through it (`limit`/`offset`) and usually ask for one architecture.
 */
export async function releaseManifests(
  env: Env,
  releaseId: number,
  detail: ManifestDetail = "default",
  window: ManifestWindow = {},
): Promise<unknown[]> {
  const arch = window.arch ?? null;
  // A page: after a (name, repo_arch, source) key — the rows in order from
  // there, a walk of that index (migration 0022) that reads what it
  // returns — or, for an older client, an OFFSET, which sorts the whole
  // selection every page. Two sources' builds of one name are two rows,
  // so the key names the source: a cursor on (name, repo_arch) alone
  // skipped the second one at a page boundary. A cursor without a source
  // (from before the source was part of it) continues after the name.
  const after = window.after ?? null;
  const page = window.limit ? ` LIMIT ${Math.floor(window.limit)}${after ? "" : ` OFFSET ${Math.floor(window.offset ?? 0)}`}` : "";
  const keyset = after ? (after.source === null ? " AND (p.name, p.repo_arch) > (?2, ?3)" : " AND (p.name, p.repo_arch, p.source) > (?2, ?3, ?4)") : "";
  // The page is a walk of the (name, repo_arch, source) index from the
  // cursor, each row asked whether it is in the release (a point lookup).
  // Left to the planner, the query started from the release's members —
  // every one of them, sorted, for every page: 73k rows read per 500
  // returned, and a render of one architecture read the ring 38 times over.
  const from = `packages p INDEXED BY idx_packages_name_repo_arch_source`;
  const where = `WHERE (?1 IS NULL OR p.repo_arch = ?1)${keyset} AND ${await releaseMemberPredicate(env, releaseId, "p")} ORDER BY p.name, p.repo_arch, p.source`;
  const binds = after ? (after.source === null ? [arch, after.name, after.repoArch] : [arch, after.name, after.repoArch, after.source]) : [arch];
  if (detail === "summary") {
    // Enough for status / list / search: ~100 bytes per package instead of ~800.
    const rows = await env.DB.prepare(
      `SELECT p.name, p.version, p.arch, p.repo_arch, p.filename, p.sha256, p.size_download, p.size_installed, p.source,
              json_extract(p.manifest_json, '$.description') AS description
         FROM ${from} ${where}${page}`,
    )
      .bind(...binds)
      .all();
    return rows.results;
  }
  const rows = await env.DB.prepare(
    `SELECT p.id, p.manifest_json, p.source, p.repo_arch FROM ${from} ${where}${page}`,
  )
    .bind(...binds)
    .all<{ id: number; manifest_json: string; source: string; repo_arch: string }>();
  const out = rows.results.map((r) => {
    const m = JSON.parse(r.manifest_json) as { files?: unknown; source?: string; repo_arch?: string };
    m.source = r.source;
    m.repo_arch = r.repo_arch;
    delete m.files;
    return { id: r.id, m };
  });
  if (detail === "files") {
    // Attach the gzip-stored file lists in batches.
    const byId = new Map(out.map((o) => [o.id, o.m]));
    const ids = out.map((o) => o.id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const lists = await env.DB.prepare(
        "SELECT package_id, gz FROM package_file_lists WHERE package_id IN (SELECT value FROM json_each(?))",
      )
        .bind(JSON.stringify(chunk))
        .all<{ package_id: number; gz: ArrayBuffer | number[] }>();
      for (const l of lists.results) {
        const m = byId.get(l.package_id);
        // Still compressed: the reader (pkg-repo render) inflates it; a page
        // of 500 chaotic-aur games decompressed here exceeded the Worker.
        if (m) (m as { files_gz?: string }).files_gz = toBase64(l.gz);
      }
    }
  }
  return out.map((o) => o.m);
}

/**
 * What a release holds, computed once — a release is immutable — and kept
 * on its row (migration 0015): the overview and the release views read
 * three numbers instead of joining thousands of rows on every call.
 */
export async function releaseSummary(env: Env, releaseId: number): Promise<{ package_count: number; size_download: number }> {
  const row = await env.DB.prepare("SELECT package_count, bytes FROM releases WHERE id = ?").bind(releaseId).first<{ package_count: number | null; bytes: number | null }>();
  if (row && row.package_count !== null && row.bytes !== null) return { package_count: row.package_count, size_download: row.bytes };
  const fresh = await env.DB.prepare(
    `SELECT COUNT(*) AS package_count, COALESCE(SUM(p.size_download), 0) AS size_download
       FROM ${await releaseMembers(env, releaseId)} rp JOIN packages p ON p.id = rp.package_id`,
  ).first<{ package_count: number; size_download: number }>();
  const out = fresh ?? { package_count: 0, size_download: 0 };
  await env.DB.prepare("UPDATE releases SET package_count = ?, bytes = ? WHERE id = ?").bind(out.package_count, out.size_download, releaseId).run();
  return out;
}

export interface SourceSlice {
  source: string;
  arch: string;
  packages: number;
  bytes: number;
}

/** Per (source, arch) breakdown of a release, computed once and stored. */
export async function releaseSources(env: Env, releaseId: number): Promise<SourceSlice[]> {
  const row = await env.DB.prepare("SELECT sources FROM releases WHERE id = ?").bind(releaseId).first<{ sources: string | null }>();
  if (row?.sources) return JSON.parse(row.sources) as SourceSlice[];
  const fresh = await env.DB.prepare(
    `SELECT p.source, p.repo_arch AS arch, COUNT(*) AS packages, COALESCE(SUM(p.size_download), 0) AS bytes
       FROM ${await releaseMembers(env, releaseId)} rp JOIN packages p ON p.id = rp.package_id
      GROUP BY p.source, p.repo_arch ORDER BY p.repo_arch, p.source`,
  ).all<SourceSlice>();
  await env.DB.prepare("UPDATE releases SET sources = ? WHERE id = ?").bind(JSON.stringify(fresh.results), releaseId).run();
  return fresh.results;
}

function toBase64(gz: ArrayBuffer | number[]): string {
  const bytes = gz instanceof ArrayBuffer ? new Uint8Array(gz) : Uint8Array.from(gz);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
