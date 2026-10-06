/**
 * Governance comes from the repository, not from the database. The file
 * factory/MAINTAINERS.toml on main lists the maintainers; changing it is a
 * pull request another maintainer approves. The brain reads main every ten
 * minutes and applies it: a login listed there is a maintainer, everyone
 * else is a contributor. No areas — every maintainer reviews everything;
 * what a package is about is its category (categories.ts), not who may
 * approve it. Nothing here grants a role by hand.
 */
import { parse } from "smol-toml";
import { json, type Env } from "./index";
import { REPO_URL } from "./meta";
import { OWNER_LISTED_SQL, OWNER_NOT_MAINTAINER } from "./hosts";

export const GOVERNANCE_FILE = "factory/MAINTAINERS.toml";
const RAW = `https://raw.githubusercontent.com/firemanxbr/omarchy-pool/main/${GOVERNANCE_FILE}`;

/**
 * The maintainer application: the issue form in
 * .github/ISSUE_TEMPLATE/maintainer.yml, opened on GitHub. Asking is an
 * issue; the decision is still the pull request that changes
 * GOVERNANCE_FILE, which another maintainer approves. The People page's
 * "Open the issue" and the governance chapter link here.
 */
export const APPLY_URL = `${REPO_URL}/issues/new?template=maintainer.yml`;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * The solo-maintainer exception (#394, a maintainer decision of 2026-10-06):
 * the `[solo]` table of the governance file, while it is there. With one
 * maintainer active and one host, the two-person rule would stop every
 * package that maintainer brought — nobody else claims, approves or releases
 * it, and D35 keeps its project's copy off their host — so the file names
 * them, since when and why, and for that maintainer alone the review's doors,
 * the adoption of their own package and the requester-host rule let them
 * through, each decision marked self-reviewed in public (its signed record,
 * its journal line, the pages, Status). Everyone else keeps the rules as they
 * are. Removing the table ends it: the next sync clears it, and the rules
 * hold for them again.
 */
export interface Solo {
  /** The one maintainer it names: a login of the file's list. */
  maintainer: string;
  /** Since when (a date, YYYY-MM-DD), as the file says. */
  since: string;
  /** Why, in one line, as the file says. */
  reason: string;
}

/** The longest reason the table may give: one line, read on Status. */
export const SOLO_REASON_MAX = 300;

/** A calendar date written YYYY-MM-DD that is one (2026-02-30 is none). */
function isDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * The governance file's `[solo]` table, checked the way factory/bin/check-governance
 * checks it (CI refuses a pull request that breaks it): `maintainer`, one
 * login of the list (never a list); `since`, a date written "YYYY-MM-DD";
 * `reason`, one line; nothing else. Null when the file has no table; throws
 * on a table that is not that. `maintainers` is the list parseGovernance read.
 */
export function parseSolo(text: string, maintainers: string[]): Solo | null {
  const doc = parse(text) as { solo?: unknown };
  if (doc.solo === undefined) return null;
  const t = doc.solo as Record<string, unknown>;
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("[solo] must be a table");
  const unknown = Object.keys(t).filter((k) => !["maintainer", "since", "reason"].includes(k)).sort();
  if (unknown.length) throw new Error(`[solo] has unknown field(s) ${unknown.join(", ")}`);
  const m = t.maintainer;
  if (Array.isArray(m)) throw new Error("[solo] maintainer names one maintainer, never a list");
  if (typeof m !== "string" || !LOGIN.test(m)) throw new Error("[solo] maintainer must be a GitHub login");
  if (!maintainers.includes(m)) throw new Error(`[solo] maintainer ${m} is not in \`maintainers\``);
  if (typeof t.since !== "string" || !isDate(t.since)) throw new Error('[solo] since must be a date, written "YYYY-MM-DD"');
  const reason = typeof t.reason === "string" ? t.reason.trim() : "";
  if (!reason) throw new Error("[solo] reason is required: why, in one line");
  if (/[\r\n]/.test(reason) || reason.length > SOLO_REASON_MAX) throw new Error(`[solo] reason is one line of ${SOLO_REASON_MAX} characters at most`);
  return { maintainer: m, since: t.since, reason };
}

/** The exception in force, as the last sync wrote it beside the list (governance_solo: one row, or none). */
export const SOLO_SQL = "SELECT maintainer, since, reason FROM governance_solo WHERE id = 1";

/** The solo-maintainer exception in force (#394), or null: the rules as they are for everyone. */
export async function soloOf(env: Env): Promise<Solo | null> {
  const r = await env.DB.prepare(SOLO_SQL).first<{ maintainer: string; since: string; reason: string }>();
  return r ? { maintainer: r.maintainer, since: r.since, reason: r.reason } : null;
}

/** The words a decision taken under the exception carries on its journal line. */
export const SELF_REVIEWED = "self-reviewed (solo-maintainer exception)";

/** What a decision taken under the exception carries in its journal line's payload, its answer and the task it queued: who it names and since when. */
export type SoloMark = { maintainer: string; since: string };
export function soloMark(s: Solo): SoloMark {
  return { maintainer: s.maintainer, since: s.since };
}

/**
 * Parses the governance file into the list of maintainers; throws on anything
 * else. The older form — `[groups.<name>]` tables, each with a list — is
 * read as the union of its lists, so the file and the brain may change in
 * either order.
 */
export function parseGovernance(text: string): string[] {
  const doc = parse(text) as { maintainers?: unknown; groups?: Record<string, { maintainers?: unknown }> };
  const lists: unknown[] = [];
  if (doc.maintainers !== undefined) lists.push(doc.maintainers);
  else if (doc.groups && typeof doc.groups === "object") for (const g of Object.values(doc.groups)) lists.push(g?.maintainers);
  if (lists.length === 0) throw new Error("no `maintainers` list");
  const out = new Set<string>();
  for (const l of lists) {
    if (!Array.isArray(l) || !l.every((m) => typeof m === "string" && LOGIN.test(m))) throw new Error("maintainers must be a list of GitHub logins");
    for (const m of l as string[]) out.add(m);
  }
  if (out.size === 0) throw new Error("no maintainer listed");
  return [...out].sort((a, b) => a.localeCompare(b));
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The maintainers as last applied. */
export async function maintainersOf(env: Env): Promise<{ login: string; since: string }[]> {
  const rows = await env.DB.prepare("SELECT login, since FROM factory_maintainers ORDER BY login").all<{ login: string; since: string }>();
  return rows.results;
}

/** The role the governance file gives a login: maintainer if listed, else contributor. */
export async function roleFor(env: Env, login: string): Promise<"maintainer" | "contributor"> {
  const row = await env.DB.prepare("SELECT 1 AS yes FROM factory_maintainers WHERE login = ?").bind(login).first<{ yes: number }>();
  return row ? "maintainer" : "contributor";
}

/**
 * Reads the file on main and applies it when it changed: the list replaced,
 * every registered contributor's role recomputed, each change a `role` line
 * in the journal. Returns a one-line log.
 */
/**
 * What this brain reads of the file, beside its text, in the hash it keeps:
 * a brain that reads more of it (the [solo] table, #394) applies a file it
 * has seen before once more, so a table merged while an older brain synced —
 * which stored the file's hash and read only the list — is not left
 * unapplied as "unchanged".
 */
const GOVERNANCE_READS = "maintainers+solo";

export async function syncGovernance(env: Env, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(RAW, { headers: { "user-agent": "omarchy-pool" }, cf: { cacheTtl: 120 } } as RequestInit);
  if (!res.ok) throw new Error(`${GOVERNANCE_FILE}: HTTP ${res.status}`);
  const text = await res.text();
  const hash = await sha256Hex(`${GOVERNANCE_READS}\n${text}`);
  const known = await env.DB.prepare("SELECT value FROM settings WHERE key = 'governance_sha256'").first<{ value: string }>();
  if (known?.value === hash) {
    // The list is the same, but who it resolves to may not be (a sign-in moved a login's GitHub user id): the hosts' step runs at every sync.
    const stopped = await stopHostsOfRemovedOwners(env);
    return `governance: unchanged${stopped.length ? " — " + stopped.join("; ") : ""}`;
  }
  const maintainers = parseGovernance(text);
  // The list applies whatever the [solo] table says (D39: a list that parses is applied); a table that does not parse is no exception —
  // the rules hold for everyone, as without it — and the sync says why (check-governance refuses such a table before it reaches main).
  let solo: Solo | null = null, refused = "";
  try {
    solo = parseSolo(text, maintainers);
  } catch (e) {
    refused = ` — [solo] not applied: ${(e as Error).message}`;
  }
  return (await applyGovernance(env, maintainers, hash, solo)) + refused;
}

/**
 * The maintainer hosts' share of a sync (#322, design v2 §6.2, D39): every
 * host whose owner no longer resolves from the list stops claiming — the
 * claim itself refuses it from the next one (hosts.ts, hostClaimRefusal),
 * and this marks it so it stays stopped until its owner's one Resume once
 * listed again. Nothing is fenced: running leases finish and upload, so a
 * mistaken pull request or a parse slip costs new claims for ten minutes,
 * not builds in flight. One journal line per host.
 */
export const STOP_REMOVED_OWNERS_SQL = `UPDATE hosts SET owner_removed_at = ?1
  WHERE status IN ('active', 'suspended') AND owner_removed_at IS NULL AND NOT ${OWNER_LISTED_SQL("hosts.owner_github_id")}
  RETURNING id, name, owner_login, worker_id`;

export async function stopHostsOfRemovedOwners(env: Env, at = new Date().toISOString()): Promise<string[]> {
  const rows = (await env.DB.prepare(STOP_REMOVED_OWNERS_SQL).bind(at).all<{ id: string; name: string; owner_login: string; worker_id: string | null }>()).results;
  if (!rows.length) return [];
  const lines = rows.map((h) => `${h.name} of ${h.owner_login} stops claiming: ${OWNER_NOT_MAINTAINER} (${GOVERNANCE_FILE}); its running tasks finish and upload`);
  await env.DB.batch(rows.map((h, i) =>
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('host', NULL, 'factory', 'warn', ?, ?)")
      .bind(lines[i], JSON.stringify({ host: h.id, worker: h.worker_id, owner: h.owner_login, action: "owner_removed", source: GOVERNANCE_FILE })),
  ));
  return lines;
}

/**
 * The exception written beside the list (#394), in the same batch: its one row replaced by what the [solo] table says, or taken away
 * when the file has none. The sync is the only writer.
 */
export const CLEAR_SOLO_SQL = "DELETE FROM governance_solo";
export const APPLY_SOLO_SQL = "INSERT INTO governance_solo (id, maintainer, since, reason) VALUES (1, ?, ?, ?)";

export async function applyGovernance(env: Env, maintainers: string[], hash: string, solo: Solo | null = null): Promise<string> {
  // A table naming a login the list does not hold is none (parseSolo refuses it; this keeps a caller's slip from naming a stranger).
  const exception = solo && maintainers.includes(solo.maintainer) ? solo : null;
  const was = await soloOf(env);
  // `since` survives for a login that stays listed; a newcomer gets today.
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM factory_maintainers WHERE login NOT IN (${maintainers.map(() => "?").join(", ") || "''"})`).bind(...maintainers),
    ...maintainers.map((m) => env.DB.prepare("INSERT OR IGNORE INTO factory_maintainers (login) VALUES (?)").bind(m)),
    env.DB.prepare(CLEAR_SOLO_SQL),
    ...(exception ? [env.DB.prepare(APPLY_SOLO_SQL).bind(exception.maintainer, exception.since, exception.reason)] : []),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('governance_sha256', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(hash),
  ];
  await env.DB.batch(stmts);

  const people = await env.DB.prepare("SELECT login, role FROM contributors").all<{ login: string; role: string }>();
  const changes: string[] = [];
  for (const p of people.results) {
    const role = maintainers.includes(p.login) ? "maintainer" : "contributor";
    if (p.role === role) continue;
    await env.DB.prepare("UPDATE contributors SET role = ?, areas = NULL WHERE login = ?").bind(role, p.login).run();
    const line = `${p.login} is ${role} (${GOVERNANCE_FILE})`;
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('role', NULL, 'factory', 'ok', ?, ?)")
      .bind(line, JSON.stringify({ login: p.login, role, was: { role: p.role }, source: GOVERNANCE_FILE }))
      .run();
    changes.push(line);
  }
  // The exception taken up, changed or ended: a `role` line in the journal, in public, as a role change is.
  const line = soloLine(was, exception);
  if (line) {
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('role', NULL, 'factory', ?, ?, ?)")
      .bind(exception ? "warn" : "ok", line, JSON.stringify({ login: exception?.maintainer ?? was?.maintainer ?? null, action: "solo_exception", solo_exception: exception, was: was, source: GOVERNANCE_FILE }))
      .run();
    changes.push(line);
  }
  changes.push(...(await stopHostsOfRemovedOwners(env)));
  return `governance: ${maintainers.length} maintainer(s) applied${changes.length ? " — " + changes.join("; ") : ""}`;
}

/** The journal's words for the exception taken up, changed or ended (#394); null when it is as it was. */
function soloLine(was: Solo | null, now: Solo | null): string | null {
  if (!was && !now) return null;
  if (was && now && was.maintainer === now.maintainer && was.since === now.since && was.reason === now.reason) return null;
  if (!now) return `the solo-maintainer exception for ${was!.maintainer} (since ${was!.since}) ended (${GOVERNANCE_FILE}): nobody decides on their own package again`;
  return `${now.maintainer} builds, reviews and approves their own packages under the solo-maintainer exception since ${now.since} (${GOVERNANCE_FILE}): ${now.reason} — every such decision is marked self-reviewed`;
}

/**
 * The journal lines of the decisions taken under the exception (#394): every door that let its maintainer through writes
 * `solo_exception` into its line's payload — a claim, a release (`review`), an approval, a rejection, changes asked for (`approve`)
 * and an adoption (`adopt`) — and only those kinds hold them. Through the journal's (kind, id) index, newest first.
 */
const SELF_REVIEWED_WHERE = "kind IN ('review', 'approve', 'adopt') AND json_extract(payload, '$.solo_exception') IS NOT NULL";
export const SELF_REVIEWED_SQL = `SELECT id, kind, status, summary, payload, created_at FROM events WHERE ${SELF_REVIEWED_WHERE} ORDER BY id DESC LIMIT ?`;
export const SELF_REVIEWED_COUNT_SQL = `SELECT COUNT(*) AS n FROM events WHERE ${SELF_REVIEWED_WHERE}`;
/**
 * The second opinion beside it (D36, unchanged by the exception): the audits of the project's copies leased since the exception's
 * `since`, and how many recorded no independence — with one host and one model, each of them. The audits by the kind index, each
 * one's build by its primary key.
 */
export const SOLO_AUDITS_SQL = `SELECT COUNT(*) AS audits, COALESCE(SUM(a.independent = 'none'), 0) AS none FROM build_tasks a JOIN build_tasks b ON b.id = json_extract(a.params, '$.task')
  WHERE a.kind = 'audit' AND a.status IN ('leased', 'done', 'failed') AND a.independent IS NOT NULL AND a.created_at >= ?
    AND b.kind = 'build' AND b.trust = 'project' AND json_extract(b.params, '$.review') IS NOT NULL`;

/** Where the list of self-reviewed decisions is read, and where it is shown. */
export const SELF_REVIEWED_API = "/api/v1/factory/self-reviewed";
export const SELF_REVIEWED_PAGE = "/docs/governance#solo";

/** What GET /factory/maintainers and Status say of the exception while it is in force (#394): who, since when, why, what it was used for. */
export interface SoloView extends Solo {
  /** The decisions taken under it, as the journal holds them (all of them, since the first). */
  self_reviewed: number;
  /** The audits of the project's copies since `since`, and how many recorded `independent: none` (D36). */
  audits: { publish_bound: number; none: number };
  /** The list, as the API answers it, and the page that shows it. */
  list: string;
  page: string;
}

export async function soloView(env: Env): Promise<SoloView | null> {
  const solo = await soloOf(env);
  if (!solo) return null;
  const [count, audits] = await env.DB.batch<{ n?: number; audits?: number; none?: number }>([
    env.DB.prepare(SELF_REVIEWED_COUNT_SQL),
    env.DB.prepare(SOLO_AUDITS_SQL).bind(`${solo.since}T00:00:00.000Z`),
  ]);
  const a = audits.results[0] ?? {};
  return { ...solo, self_reviewed: Number(count.results[0]?.n ?? 0), audits: { publish_bound: Number(a.audits ?? 0), none: Number(a.none ?? 0) }, list: SELF_REVIEWED_API, page: SELF_REVIEWED_PAGE };
}

/** One decision taken under the exception, as GET /factory/self-reviewed lists it: the journal line, what it decided, on which package. */
export interface SelfReviewed { id: number; kind: string; at: string; summary: string; name: string | null; by: string | null; decision: string; record: string | null; solo_exception: SoloMark }

/** The journal kind and payload of a decision taken under the exception, in one word: claim, release, approve, reject, changes, adopt. */
function decisionWord(kind: string, status: string, p: Record<string, unknown>): string {
  if (kind === "adopt") return "adopt";
  if (kind === "approve") return p.decision === "changes_requested" ? "changes" : p.decision === "rejected" || status !== "ok" ? "reject" : "approve";
  return status === "ok" ? "claim" : "release";
}

/**
 * GET /factory/self-reviewed — the decisions taken under the solo-maintainer exception (#394), newest first, the journal's own lines
 * (`limit`, at most 200), with how many there are and the exception in force (null once it ended: the list stays, it is the record).
 * Public: the record is everyone's.
 */
export async function handleSelfReviewed(env: Env, url: URL): Promise<Response> {
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200));
  const [rows, count, solo] = await Promise.all([
    env.DB.prepare(SELF_REVIEWED_SQL).bind(limit).all<{ id: number; kind: string; status: string; summary: string; payload: string | null; created_at: string }>(),
    env.DB.prepare(SELF_REVIEWED_COUNT_SQL).first<{ n: number }>(),
    soloOf(env),
  ]);
  const decisions: SelfReviewed[] = rows.results.map((r) => {
    let p: Record<string, unknown> = {};
    try { p = r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {}; } catch { p = {}; }
    const mark = p.solo_exception as { maintainer: string; since: string };
    return { id: r.id, kind: r.kind, at: r.created_at, summary: r.summary, name: typeof p.name === "string" ? p.name : null, by: typeof p.by === "string" ? p.by : null, decision: decisionWord(r.kind, r.status, p), record: typeof p.record === "string" ? p.record : null, solo_exception: { maintainer: mark.maintainer, since: mark.since } };
  });
  return json({ solo, count: count?.n ?? 0, decisions }, 200, { "cache-control": "public, max-age=60" });
}
