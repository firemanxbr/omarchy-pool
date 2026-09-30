/**
 * An agent's credential (#252, the MCP write tools): a token one GitHub login
 * granted to one agent in its own signed-in browser (routes/agents.ts), worth
 * the seven tools of `omarchy-cli mcp` and nothing else. docs:
 * worker/src/docs/omarchy-cli-mcp.md, *Who the agent acts as*.
 *
 *   oma_<48 hex>   192 random bits, handed to the command once, kept as SHA-256 (agent_grants.token_hash)
 *
 * The token is taken only by the routes the tools call (AGENT_ROUTES) and
 * refused everywhere else with 403 and `code: "agent_token"` — every decision
 * route among them (approve, reject, changes, withdraw, cancel, block,
 * unblock, trust, token, the record's withdrawal). contributorOf never takes
 * it; agentOf does, only on a route that names the scope it needs. The
 * server holds every rule: an agent that skips the MCP server and calls the
 * API with the token gains nothing.
 *
 * What a call costs: one read of the grant by its unique index, joined to
 * the login's row by its primary key — the role is read again on every call,
 * so a login taken out of factory/MAINTAINERS.toml loses review and block at
 * its next call. Then the login's burst limit (a rate limiting binding: no
 * D1 row), the scope, the role, and for a write the cost guard (through the
 * read guard's one-minute memo: no row either). `last_used` moves once per
 * ten minutes, as a contributor's `last_seen` does.
 */
import { json, type Env } from "./index";
import { cookieOf } from "./routes/auth";
import { sha256Hex, SEEN_MINUTES, type Contributor } from "./routes/contributors";
import { agentWriteGuard } from "./cost";

/** The three scopes a grant may hold: contribute (request_package, request_status), review (review_claim, review_release, review_context, submit_review) and block (block). */
export type Scope = "contribute" | "review" | "block";
export const SCOPES: readonly Scope[] = ["contribute", "review", "block"];
/** The tools each scope lists in `omarchy-cli mcp` (crates/omarchy-cli/src/mcp.rs holds the same table). */
export const SCOPE_TOOLS: Readonly<Record<Scope, readonly string[]>> = {
  contribute: ["request_package", "request_status"],
  review: ["review_claim", "review_release", "review_context", "submit_review"],
  block: ["block"],
};
/** The scopes that reach a decision: granted to a maintainer only, for seven days, read again on every call. */
export const DECISION_SCOPES: readonly Scope[] = ["review", "block"];

/** A contribute grant's life: thirty days unless the link asks for fewer or more, never more than ninety. */
export const CONTRIBUTE_DAYS = 30;
export const CONTRIBUTE_MAX_DAYS = 90;
/** A grant that holds review or block, whatever the link asked: the scopes that reach a decision are granted again every week. */
export const DECISION_DAYS = 7;
/** Live grants a login holds at most: a fourth is refused at Grant. */
export const LIVE_GRANTS = 3;
/** The one-time code's life: a minute, taken once, worth nothing without the verifier. */
export const CODE_SECONDS = 60;
/** A draft's life: confirmed within thirty minutes, or expired. */
export const DRAFT_MINUTES = 30;
/** Per login, per UTC day, across all its grants and agent names: requests, claims (a release counts as one) and drafts. */
export const DAY_CAPS = { requests: 5, claims: 10, drafts: 30 } as const;
export type DayKind = keyof typeof DAY_CAPS;
/** The bursts (wrangler.toml's rate limiting bindings): per login, per address on the token swap. Said in the refusals. */
export const CALLS_PER_MINUTE = 20;
export const SWAPS_PER_MINUTE = 5;

/**
 * Who a write through an agent came through, on its row, its record and its
 * journal line: the grant's agent name (what the person said the agent is),
 * the client's own name and version from MCP's initialize (what the agent
 * says it is, `x-omarchy-client`), the grant — and for a decision confirmed
 * in the browser, the draft and when it was drafted and confirmed — and, for
 * approve and block (#257), the passkey the person confirmed it with, its
 * user verified — registered just now when it was that passkey's first use,
 * minutes after its registration (#287: the draft's page registers a first
 * one). The door (`via`, contributors.ts viaOf) says "agent" for a write the
 * token made and "web" for a draft confirmed in the browser.
 */
export interface Through {
  agent: string;
  client: string | null;
  grant: string;
  draft?: string;
  drafted_at?: string;
  confirmed_at?: string;
  passkey?: string;
  registered_just_now?: true;
}

/**
 * The journal's words for an agent a write came through: a draft confirmed
 * in the browser — " — drafted by Claude Code, confirmed in the browser",
 * and " with a passkey" for approve and block (#257) — or a write the
 * agent's token made (a request, a claim, a release) — " through Claude
 * Code"; nothing for the web and the command line.
 */
export function throughWords(t: Through | null | undefined): string {
  if (!t) return "";
  return t.draft ? ` — drafted by ${t.agent}, confirmed in the browser${t.passkey ? ` with a passkey${t.registered_just_now ? " registered just now" : ""}` : ""}` : ` through ${t.agent}`;
}

/** The caller behind an agent token, as agentOf read it. */
export interface AgentCaller {
  contributor: Contributor;
  grant: string;
  agent: string;
  client: string | null;
  scopes: Scope[];
  expires_at: string;
  through: Through;
}

const enc = new TextEncoder();

/** `n` random bytes as hex. */
export function randomHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The PKCE S256 challenge of a verifier (RFC 7636 §4.2): base64url(sha256(ascii(verifier))), no padding. */
export async function s256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

/** A verifier as RFC 7636 §4.1 writes one: 43 to 128 unreserved characters. */
export const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** A challenge: the base64url of a SHA-256, 43 characters. */
export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

function bearer(request: Request): string {
  const h = request.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/** Whether the request carries an agent's token. */
export function hasAgentToken(request: Request): boolean {
  return bearer(request).startsWith("oma_");
}

/**
 * A form's nonce, written into the page it posts from and checked when it
 * comes back: an HMAC (JOB_TOKEN_SECRET) over what the form is for and the
 * browser's session, so no D1 row is written to show a page. A form posted
 * from elsewhere has neither the session nor the page's nonce; the Origin
 * header is checked beside it.
 */
export async function formNonce(env: Env, parts: string[]): Promise<string> {
  const secret = env.JOB_TOKEN_SECRET ?? "";
  if (!secret) throw new Error("JOB_TOKEN_SECRET is not set; no form nonce can be made");
  const key = await crypto.subtle.importKey("raw", enc.encode(`form-nonce:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(parts.join("\n"))));
}

/** Constant-time comparison of two nonces. */
export function sameNonce(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * The session a page in the browser is posted with: the `omc` cookie, and
 * nothing else — a request that carries an Authorization header is refused
 * (null with `bearer`), so no token of any kind opens the grant or the
 * confirmation. The session's hash binds the form's nonce.
 */
export function browserSession(request: Request): { session: string; bearer: false } | { session: null; bearer: boolean } {
  if (request.headers.has("authorization")) return { session: null, bearer: true };
  const s = cookieOf(request, "omc") ?? "";
  return s.startsWith("oms_") ? { session: s, bearer: false } : { session: null, bearer: false };
}

/** The client's own name and version (MCP initialize's clientInfo, sent as x-omarchy-client): printable, 80 characters at most, or null. */
export function clientOf(request: Request): string | null {
  const raw = (request.headers.get("x-omarchy-client") ?? "").replace(/[^\x20-\x7e]/g, "").trim();
  return raw ? raw.slice(0, 80) : null;
}

/**
 * What an agent's name may not hold: a control character (C0, DEL, C1), a
 * format character — the bidirectional overrides and isolates that reverse
 * how the rest of a public journal line reads, the zero-width ones that make
 * two names look alike — a private-use character, or half a surrogate pair.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u;

/** An agent's name as the person gives it at login: printable, one line, 1 to 60 characters — escaped wherever a page shows it. */
export function agentName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length >= 1 && s.length <= 60 && !UNPRINTABLE.test(s) ? s : null;
}

/** The scopes a link asks for, in their order; null when one is not a scope. */
export function parseScopes(raw: string | null): Scope[] | null {
  const asked = (raw ?? "contribute").split(/[\s,]+/).filter(Boolean);
  if (!asked.length || asked.some((s) => !(SCOPES as readonly string[]).includes(s))) return null;
  return SCOPES.filter((s) => asked.includes(s));
}

/** When a grant made now expires: seven days for one that holds review or block, whatever was asked; otherwise the days asked, thirty by default, between one and ninety. */
export function grantExpiry(scopes: Scope[], days: number | null, now = Date.now()): string {
  const decides = scopes.some((s) => DECISION_SCOPES.includes(s));
  const d = decides ? DECISION_DAYS : Math.min(CONTRIBUTE_MAX_DAYS, Math.max(1, days ?? CONTRIBUTE_DAYS));
  return new Date(now + d * 86400_000).toISOString();
}

/**
 * The grant's read, every call: the grant by its token's unique index,
 * joined to the login's row by the primary key (the role, read again; a
 * block). Revoked grants are not read.
 */
export const GRANT_SQL = `SELECT g.id, g.login, g.agent, g.scopes, g.expires_at, g.last_used, c.name, c.avatar_url, c.role, c.blocked_at, c.blocked_reason
  FROM agent_grants g JOIN contributors c ON c.login = g.login
 WHERE g.token_hash = ? AND g.revoked_at IS NULL`;

/**
 * The agent behind the request, with the scope the route names — or the
 * refusal to send. Every call that carries an agent token pays the login's
 * burst limit, reads and writes alike; a write is refused while the cost
 * guard is up (503, an hour's retry-after, as the read guard answers).
 * `scope` may name several: any of them will do (a read the tools share).
 */
export async function agentOf(request: Request, env: Env, scope: Scope | Scope[], opts: { write: boolean }): Promise<AgentCaller | Response> {
  const token = bearer(request);
  if (!token.startsWith("oma_")) return json({ error: "an agent token is required (omarchy-cli login)", code: "grant_invalid" }, 401);
  const row = await env.DB.prepare(GRANT_SQL).bind(await sha256Hex(token)).first<{ id: string; login: string; agent: string; scopes: string; expires_at: string; last_used: string | null; name: string | null; avatar_url: string | null; role: string; blocked_at: string | null; blocked_reason: string | null }>();
  if (!row) return json({ error: "this agent token is not valid — revoked, replaced, or never granted: run omarchy-cli login", code: "grant_invalid" }, 401);
  if (row.expires_at <= new Date().toISOString()) return json({ error: `this agent's grant expired at ${row.expires_at}: run omarchy-cli login`, code: "grant_expired" }, 401);
  // The login's burst: twenty calls a minute that carry an agent token, however many grants it holds.
  if (env.AGENT_CALLS && !(await env.AGENT_CALLS.limit({ key: `login:${row.login}` })).success) {
    return json({ error: `${row.login} made ${CALLS_PER_MINUTE} calls through agents this minute: wait a minute`, code: "rate_limited" }, 429, { "retry-after": "60" });
  }
  const scopes = (JSON.parse(row.scopes) as string[]).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  const wanted = Array.isArray(scope) ? scope : [scope];
  const held = wanted.find((s) => scopes.includes(s));
  if (!held) return json({ error: `this grant does not hold ${wanted.join(" or ")} (it holds ${scopes.join(", ")}): run omarchy-cli login${wanted.some((s) => DECISION_SCOPES.includes(s)) ? " --maintain" : ""}`, code: "scope" }, 403);
  // The role, read again: review and block are a maintainer's today, not the day the grant was made.
  if (DECISION_SCOPES.includes(held) && row.role !== "maintainer") {
    return json({ error: `${row.login} is not a maintainer (factory/MAINTAINERS.toml): review and block are a maintainer's`, code: "maintainer_only" }, 403);
  }
  if (row.blocked_at) return json({ error: `${row.login} is blocked by a maintainer${row.blocked_reason ? ": " + row.blocked_reason : ""}`, code: "blocked" }, 403);
  if (opts.write) {
    const guard = await agentWriteGuard(env);
    if (guard) return json({ error: "the pool is over its monthly budget: an agent's writes wait until a maintainer lifts the guard or the estimate is back under the line", code: "cost_guard", guard }, 503, { "retry-after": "3600" });
  }
  if (!row.last_used || Date.now() - Date.parse(row.last_used) > SEEN_MINUTES * 60000) {
    await env.DB.prepare(`UPDATE agent_grants SET last_used = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND (last_used IS NULL OR last_used < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${SEEN_MINUTES} minutes'))`).bind(row.id).run();
  }
  const client = clientOf(request);
  return {
    contributor: { login: row.login, name: row.name, avatar_url: row.avatar_url, role: row.role, blocked: null },
    grant: row.id,
    agent: row.agent,
    client,
    scopes,
    expires_at: row.expires_at,
    through: { agent: row.agent, client, grant: row.id },
  };
}

/** The UTC day a count is for. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const DAY_COLUMNS: Record<DayKind, string> = { requests: "agent_requests", claims: "agent_claims", drafts: "agent_drafts" };

/**
 * One count of the day moved, by the login's primary key, only while it is
 * under its cap: the other two start again on a new day. No row changed —
 * the cap is reached — and the write is not made.
 */
export function daySql(kind: DayKind): string {
  const col = DAY_COLUMNS[kind];
  const resets = Object.values(DAY_COLUMNS).filter((c) => c !== col).map((c) => `${c} = CASE WHEN agent_day = ?1 THEN ${c} ELSE 0 END`);
  return `UPDATE contributors SET ${[...resets, `${col} = CASE WHEN agent_day = ?1 THEN ${col} + 1 ELSE 1 END`, "agent_day = ?1"].join(", ")}
 WHERE login = ?2 AND (agent_day IS NOT ?1 OR ${col} < ?3)`;
}

/** The day's count moved before the write, or the 429 to send (with the seconds to the next UTC day). A write the handler then refuses has still counted. */
export async function dayCount(env: Env, login: string, kind: DayKind, now = new Date()): Promise<Response | null> {
  const res = await env.DB.prepare(daySql(kind)).bind(utcDay(now), login, DAY_CAPS[kind]).run();
  if (res.meta.changes) return null;
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const words = { requests: "requests", claims: "claims and releases", drafts: "drafts" }[kind];
  return json({ error: `${login} made ${DAY_CAPS[kind]} ${words} through agents today (UTC): the next one is taken tomorrow`, code: "day_limit", limit: DAY_CAPS[kind] }, 429, { "retry-after": String(Math.max(1, Math.ceil((tomorrow - now.getTime()) / 1000))) });
}

/**
 * The routes an agent token is taken by — the ones the tools call, each
 * with the scope it needs (index.ts routes them through agentOf) — as
 * method and path under /api/v1. Everything else refuses the token.
 * review_context and request_status's story read public answers without
 * it; logout (POST /auth/agent/revoke) is outside the API and takes the
 * token it revokes.
 */
export const AGENT_ROUTES: readonly { method: string; path: RegExp; scope: Scope | Scope[]; tool: string }[] = [
  { method: "POST", path: /^\/factory\/packages$/, scope: "contribute", tool: "request_package" },
  { method: "GET", path: /^\/factory\/me$/, scope: "contribute", tool: "request_status" },
  { method: "POST", path: /^\/factory\/tasks\/\d+\/build$/, scope: "review", tool: "review_claim" },
  { method: "POST", path: /^\/factory\/tasks\/\d+\/release$/, scope: "review", tool: "review_release" },
  { method: "POST", path: /^\/factory\/drafts$/, scope: ["review", "block"], tool: "submit_review, block" },
  { method: "GET", path: /^\/factory\/drafts\/d_[0-9a-f]{32}$/, scope: ["review", "block"], tool: "submit_review, block" },
];

/** What a refused route does, in a word, for the refusal: "approve", "block", "withdraw a record"… */
function actOf(method: string, path: string): string {
  if (path === "/factory/record/withdraw") return "withdraw a record";
  if (path === "/factory/token") return "mint a contributor token";
  const last = path.split("/").filter(Boolean).pop() ?? "";
  if (/^(approve|reject|changes|withdraw|cancel|block|unblock|trust|adopt|category|mode|revoke)$/.test(last)) return last === "changes" ? "request changes" : last;
  return method === "GET" ? `read ${path}` : `${method} ${path}`;
}

/**
 * The refusal of an agent token on a route that is not the tools': 403, in
 * the words of what the route does — "an agent token may not approve" — so
 * no decision is ever taken on one.
 */
export function agentTokenRefusal(request: Request, method: string, path: string): Response | null {
  if (!hasAgentToken(request)) return null;
  if (AGENT_ROUTES.some((r) => r.method === method && r.path.test(path))) return null;
  return json({ error: `an agent token may not ${actOf(method, path)}: it is taken only by the routes of omarchy-cli's tools, and a decision is confirmed by the person in the browser`, code: "agent_token" }, 403);
}
