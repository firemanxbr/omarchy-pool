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
import type { Env } from "./index";
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
export async function syncGovernance(env: Env, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(RAW, { headers: { "user-agent": "omarchy-pool" }, cf: { cacheTtl: 120 } } as RequestInit);
  if (!res.ok) throw new Error(`${GOVERNANCE_FILE}: HTTP ${res.status}`);
  const text = await res.text();
  const hash = await sha256Hex(text);
  const known = await env.DB.prepare("SELECT value FROM settings WHERE key = 'governance_sha256'").first<{ value: string }>();
  if (known?.value === hash) {
    // The list is the same, but who it resolves to may not be (a sign-in moved a login's GitHub user id): the hosts' step runs at every sync.
    const stopped = await stopHostsOfRemovedOwners(env);
    return `governance: unchanged${stopped.length ? " — " + stopped.join("; ") : ""}`;
  }
  return applyGovernance(env, parseGovernance(text), hash);
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

export async function applyGovernance(env: Env, maintainers: string[], hash: string): Promise<string> {
  // `since` survives for a login that stays listed; a newcomer gets today.
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM factory_maintainers WHERE login NOT IN (${maintainers.map(() => "?").join(", ") || "''"})`).bind(...maintainers),
    ...maintainers.map((m) => env.DB.prepare("INSERT OR IGNORE INTO factory_maintainers (login) VALUES (?)").bind(m)),
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
  changes.push(...(await stopHostsOfRemovedOwners(env)));
  return `governance: ${maintainers.length} maintainer(s) applied${changes.length ? " — " + changes.join("; ") : ""}`;
}
