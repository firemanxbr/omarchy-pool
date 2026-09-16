/**
 * The factory's record: every step a package takes, written once to the
 * pool bucket under factory/<name>/<request>/… with the pool's detached
 * signature beside it, and never rewritten. Public — the bucket is what
 * pool.firemanxbr.org serves — so anyone can read a request, a decision or
 * a build's evidence and verify who wrote it; nothing in it is private (a
 * GitHub login, a project URL, a licence, a log). The staging bucket stays
 * the workers' scratch space and expires; this does not.
 *
 *   factory/<name>/<request>/request.json            what the contributor asked for (record.ts, PR A)
 *   factory/<name>/<request>/build-<task>/…          a build's evidence, copied from staging when it is staged (PR C)
 *   factory/<name>/<request>/decision-<n>.json       approve / reject / block, with the maintainer's login (PR D)
 *   workers/<id>/trust-<time>.json                   who vouched for a worker (contributors.ts, handleTrustWorker)
 *   <key>.tombstone.json                             a record withdrawn: who, why, what it was (withdrawRecord)
 *
 * Written once, never rewritten — but not irremovable: a log that should
 * not have been public is withdrawn by a maintainer, and a signed tombstone
 * takes its place. The edge keeps a record a day, not a year, so a
 * withdrawal is honoured within the day everywhere.
 */
import type { Env } from "./index";
import { signingEnabled, detachedSignature } from "./signing";
import { findLeak } from "./leak";

export const RECORD_CACHE = "public, max-age=86400";

export function recordKey(name: string, request: number, file: string): string {
  return `factory/${name}/${request}/${file}`;
}

/** The record's public URL, as the dashboard and the API hand it out. */
export function recordUrl(env: Env, key: string): string {
  return `${env.POOL_URL}/${key}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Writes one JSON document and its signature. Refuses to overwrite: a
 * record is written once, a correction is a new record.
 */
export async function putRecord(env: Env, key: string, document: Record<string, unknown>): Promise<{ key: string; sha256: string; signed: boolean }> {
  if (await env.PACKAGES.head(key)) throw new Error(`record ${key} already exists; records are written once`);
  return putRecordBytes(env, key, new TextEncoder().encode(JSON.stringify(document, null, 2) + "\n"), "application/json");
}

/** The same for bytes that are not a document of the pool's — a PKGBUILD, a log, a report — with the pool's signature beside them. */
export async function putRecordBytes(env: Env, key: string, bytes: Uint8Array, contentType: string): Promise<{ key: string; sha256: string; signed: boolean }> {
  await env.PACKAGES.put(key, bytes, { httpMetadata: { contentType, cacheControl: RECORD_CACHE } });
  let signed = false;
  if (signingEnabled(env)) {
    const sig = await detachedSignature(env, bytes);
    await env.PACKAGES.put(`${key}.sig`, sig, { httpMetadata: { contentType: "application/pgp-signature", cacheControl: RECORD_CACHE } });
    signed = true;
  }
  return { key, sha256: await sha256Hex(bytes), signed };
}

/** The evidence files a build leaves; the package itself stays in staging (the project's own build is what gets published). */
export const EVIDENCE_FILES = ["PKGBUILD", "build.log", "PKGINFO", "vet.json", "tests.log", "audit.json", "audit.md"];

/**
 * Copies a build's evidence from the workers' staging space (which
 * expires) to the record (which does not): factory/<name>/<request>/build-<task>/<file>,
 * each signed. Only the files that exist; a file already on the record
 * is left alone (a build is written once too). Returns what was copied.
 */
export async function recordEvidence(env: Env, name: string, request: number | null, task: number, stagingPrefix: string, files: string[] = EVIDENCE_FILES): Promise<string[]> {
  if (!request) return [];
  const copied: string[] = [];
  for (const file of files) {
    const key = recordKey(name, request, `build-${task}/${file}`);
    if (await env.PACKAGES.head(key)) continue;
    const obj = await env.STAGING.get(`${stagingPrefix}${file}`);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) continue; // evidence is text; a package is not evidence
    // The record is public, signed and kept: what looks like a secret never
    // reaches it (leak.ts) — the PUT refused it already; this is for what
    // got into staging another way. An event says which file stayed behind.
    const leak = findLeak(new TextDecoder().decode(bytes));
    if (leak) {
      await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('leak', NULL, 'factory', 'warn', ?, ?)")
        .bind(`task ${task} (${name}): ${file} kept off the record — it carries what looks like ${leak.kind}`, JSON.stringify({ task, name, file, kind: leak.kind, line: leak.line, request }))
        .run();
      continue;
    }
    const type = file.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8";
    await putRecordBytes(env, key, bytes, type);
    copied.push(file);
  }
  return copied;
}

/** The gate's verdict as the review keeps it: enough to show and to decide on, not the whole transcript. */
export function vetSummary(vet: unknown): { verdict: string; fails: number; warnings: number; failed: string[]; warned: string[] } | null {
  if (!vet || typeof vet !== "object") return null;
  const v = vet as { verdict?: string; checks?: { name?: string; status?: string }[] };
  const checks = Array.isArray(v.checks) ? v.checks : [];
  const failed = checks.filter((c) => c.status === "fail").map((c) => String(c.name ?? "?"));
  const warned = checks.filter((c) => c.status === "warn").map((c) => String(c.name ?? "?"));
  return { verdict: v.verdict === "pass" || v.verdict === "fail" ? v.verdict : "unknown", fails: failed.length, warnings: warned.length, failed, warned };
}

/**
 * A record withdrawn: the object and its signature go, and
 * `<key>.tombstone.json` — signed, written once — says who, why, and what
 * was there (its sha256 and size, not its bytes). null when there is no
 * such record. The staging copy of a build's evidence goes with it, so
 * nothing the pool serves keeps the text.
 */
export async function withdrawRecord(env: Env, key: string, by: string, reason: string): Promise<{ tombstone: string; sha256: string; size: number } | null> {
  const obj = await env.PACKAGES.get(key);
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const at = new Date().toISOString();
  const tombstone = `${key}.tombstone.json`;
  await putRecord(env, tombstone, { schema: "omarchy-pool/tombstone/1", key, sha256, size: bytes.length, content_type: obj.httpMetadata?.contentType ?? null, withdrawn_by: by, reason, at });
  await env.PACKAGES.delete([key, `${key}.sig`]);
  // The staging copy of a build's evidence, when the key is one.
  const m = key.match(/^factory\/[^/]+\/\d+\/build-(\d+)\/([^/]+)$/);
  if (m) {
    const row = await env.DB.prepare("SELECT staged_prefix FROM build_tasks WHERE id = ?").bind(Number(m[1])).first<{ staged_prefix: string | null }>();
    if (row?.staged_prefix) {
      const stagingKey = `${row.staged_prefix}${m[2]}`;
      await env.STAGING.delete(stagingKey);
      await env.DB.prepare("DELETE FROM staging_objects WHERE key = ?").bind(stagingKey).run();
    }
  }
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('withdraw', NULL, 'factory', 'warn', ?, ?)")
    .bind(`${key} withdrawn from the record by ${by}: ${reason.slice(0, 200)}`, JSON.stringify({ key, by, reason, sha256, size: bytes.length, tombstone }))
    .run();
  return { tombstone, sha256, size: bytes.length };
}
