/**
 * The MCP write tools' routes (#252; docs: worker/src/docs/omarchy-cli-mcp.md).
 * An agent acts as one GitHub login through a token that login granted it
 * in its own signed-in browser, and a decision the agent drafts is decided
 * only when the person confirms it there.
 *
 *   GET  /auth/agent?agent=&scopes=&port=&state=&challenge=&method=S256[&days=]
 *                                  the grant page, for the signed-in person (the session only)
 *   POST /auth/agent               Grant (or Deny): posted with the session, its Origin and the page's nonce;
 *                                  the one-time code goes to http://127.0.0.1:<port>/ — built from the port,
 *                                  whatever the link asked — with the state
 *   POST /auth/agent/token         {code, code_verifier} → {token: "oma_…", …}: the swap (RFC 8252, PKCE S256),
 *                                  the one route open without a credential: five a minute per address
 *   POST /auth/agent/revoke        the grant of the token sent: omarchy-cli logout
 *   POST /api/v1/factory/grants/:id/revoke     Revoke on the person's own page (the session, or their omc_ token)
 *   POST /api/v1/factory/drafts    {name, verdict, note, task?} with an agent token: a draft of approve,
 *                                  request_changes or reject (review) or block (block) → its confirm link
 *   GET  /api/v1/factory/drafts/:id            the draft, to its login's agent
 *   GET  /auth/confirm/:id         the draft, for its login in the browser (the session only)
 *   POST /auth/confirm/:id/challenge  for approve and block (#257): the options the page's script hands
 *                                  navigator.credentials.get() — a challenge bound to this draft and login,
 *                                  the login's passkeys, user verification required (routes/passkeys.ts)
 *   POST /auth/confirm/:id         Confirm or Discard: the session only, the same login, its Origin and the
 *                                  page's nonce; for approve and block a passkey's assertion, verified against
 *                                  the key the login registered; the package's name typed for reject and block;
 *                                  the predicate is run again, the draft is spent by one conditional update,
 *                                  and only then is the web's own handler called — one draft decides once
 *
 * The grant's row is written by the signed-in person's Grant only; the swap
 * sets the token in that row, by the unique index on the code's hash, in
 * one conditional update — and, in the same batch, replaces a live grant of
 * the same agent name, so a login again under that name never leaves the
 * person without one before the new token exists. A draft writes no journal
 * line: until it is confirmed it is on the person's own page only (GET
 * /factory/me). A grant revoked — logout, Revoke, a replacement, a
 * contributor's block — discards its waiting drafts in the same batch, and a
 * confirm reads the draft's grant again: a revoked agent's draft decides
 * nothing.
 */
import { json, type Env } from "../index";
import { REPO_ARCHES } from "../r2";
import { DASHBOARD_HOST, isProductionHost, type RunningVersion } from "../meta";
import { contributorOf, sha256Hex, type Contributor } from "./contributors";
import { handleApprove, handleChanges, handleReject, verdictOn, DRAFTED } from "./review";
import { blockRefusal, handleBlockPackage } from "./blocks";
import { chains, storyRows } from "./story";
import {
  agentName, browserSession, CALLS_PER_MINUTE, CHALLENGE, CODE_SECONDS, dayCount, DECISION_SCOPES, DRAFT_MINUTES, formNonce, grantExpiry, LIVE_GRANTS,
  parseScopes, randomHex, s256, sameNonce, SWAPS_PER_MINUTE, VERIFIER, type AgentCaller, type Scope, type Through,
} from "../agents";
import { agentMessageHtml, confirmHtml, grantHtml, type ConfirmEvidence, type ConfirmPasskey } from "../pages/agent-auth";
import { assertionOptions, confirmPasskey, HAS_PASSKEY_SQL, PASSKEY_VERDICTS, registerHref, relyingParty } from "./passkeys";

/** The dashboard's origin, where the browser's session lives: the grant and the confirm link are there. */
export function dashboardOrigin(url: URL): string {
  return isProductionHost(url.hostname) ? `https://${DASHBOARD_HOST}` : url.origin;
}

/**
 * One person's page: never kept by a cache, never indexed, never framed (a
 * Grant or a Confirm is pressed on the pool's own page, not under another
 * site's), and its address — a draft's id, a grant's state — never sent to
 * another site as a Referer. `same-origin`, not `no-referrer`: under
 * no-referrer a browser posts the page's own form with `Origin: null`, and
 * the Origin check refuses it.
 */
function personal(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "same-origin", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } });
}

function message(url: URL, env: Env, v: RunningVersion, status: number, heading: string, text: string, tone: "refused" | "done" = "refused", links?: { href: string; label: string }[]): Response {
  return personal(agentMessageHtml({ path: url.pathname, title: heading, heading, text, tone, poolUrl: env.POOL_URL, version: v, links }), status);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A form posted with the session: its fields, or null when the body is not a form. */
async function formOf(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return null;
  return new URLSearchParams(await request.text());
}

/** The Origin a form must come from: this page's own. A browser sends it on every POST; a request without it is not the page's. */
function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("origin") === url.origin;
}

// ---------- the grant ----------

interface GrantAsk { agent: string; scopes: Scope[]; port: number; state: string; challenge: string; days: number | null }

/** The link's (or the form's) parameters, checked: the agent's name, the scopes, a port the system would give, the state and an S256 challenge. */
function grantAsk(p: URLSearchParams): GrantAsk | string {
  const agent = agentName(p.get("agent"));
  if (!agent) return "agent: the agent's name, one line of 1 to 60 characters (omarchy-cli login --agent \"<name>\")";
  const scopes = parseScopes(p.get("scopes"));
  if (!scopes) return "scopes: contribute, review and block, separated by commas";
  const port = Number(p.get("port"));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return "port: the loopback port omarchy-cli listens on (1024 to 65535)";
  const state = p.get("state") ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) return "state: 16 to 128 characters of base64url";
  const challenge = p.get("challenge") ?? "";
  if (!CHALLENGE.test(challenge)) return "challenge: the PKCE S256 challenge of the command's verifier (43 characters of base64url)";
  if ((p.get("method") ?? "S256") !== "S256") return "method: S256 only (RFC 7636)";
  const rawDays = p.get("days");
  const days = rawDays ? Number(rawDays) : null;
  if (days !== null && (!Number.isInteger(days) || days < 1)) return "days: a whole number of days (a contribute grant lives thirty by default, ninety at most)";
  return { agent, scopes, port, state, challenge, days };
}

const grantParts = (session: string, a: GrantAsk, ts: string) => ["grant", session, a.agent, a.scopes.join(","), String(a.port), a.state, a.challenge, a.days === null ? "" : String(a.days), ts];

/** How long the grant page's form is good for: ten minutes to read it and press a button — as long as omarchy-cli login waits for it (login.rs WAIT). */
const GRANT_FORM_MS = 10 * 60_000;

/** The login's live grants — swapped, not revoked, not expired — by the partial index that holds only those (idx_agent_grants_live): three rows at most, whatever the login's history. */
export const LIVE_GRANTS_SQL = "SELECT id, agent, created_at FROM agent_grants WHERE login = ? AND revoked_at IS NULL AND token_hash IS NOT NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ORDER BY created_at DESC";

/** Why a waiting draft ended when its grant was revoked: its outcome, on the person's page and in request_status. */
const REVOKED_OUTCOME = JSON.stringify({ error: "the agent's grant was revoked before anyone confirmed this draft: nothing was decided" });

/**
 * A login's waiting drafts whose grant is revoked, discarded: run in the
 * batch that revokes, after it. The drafts of the last thirty minutes by the
 * range of (login, created_at) — older ones have expired — each grant by its
 * primary key. `login` is how the statement finds the login: `?1`, or the
 * login of the grant whose token hash is `?1` (logout and the swap know the
 * token, not the login).
 */
const discardSql = (login: string) => `UPDATE drafts SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), state = 'discarded', outcome = ?2
 WHERE login = ${login} AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes') AND used_at IS NULL
   AND EXISTS (SELECT 1 FROM agent_grants g WHERE g.id = drafts.grant_id AND g.revoked_at IS NOT NULL)`;
/** The login's waiting drafts of revoked grants, discarded (?1 the login, ?2 the outcome): Revoke on the page, a contributor's block. The thirty minutes are agents.ts DRAFT_MINUTES (the tests hold the two together). */
export const DISCARD_SQL = discardSql("?1");
/** The same, the login found by a token's hash (?1): logout, and the swap's replacement. */
export const DISCARD_BY_TOKEN_SQL = discardSql("(SELECT login FROM agent_grants WHERE token_hash = ?1)");

/** A code nobody swapped, deleted by the person's next Grant: the login's own, through the partial index of unswapped codes — named, so the planner never walks the token's unique index for its NULLs, every login's. */
export const UNSWAPPED_SQL = "DELETE FROM agent_grants INDEXED BY idx_agent_grants_unswapped WHERE login = ? AND token_hash IS NULL";

/** Why Grant is refused to this person for these scopes, in the words the POST answers; null when it is not. */
function grantRefusal(c: Contributor, a: GrantAsk, others: number): string | null {
  if (c.blocked) return `${c.login} is blocked by a maintainer${c.blocked.reason ? ": " + c.blocked.reason : ""}; nothing is granted until another maintainer lifts it`;
  if (a.scopes.some((s) => DECISION_SCOPES.includes(s)) && c.role !== "maintainer") return `review and block are granted to a maintainer only, and ${c.login} is not one (factory/MAINTAINERS.toml): log in without --maintain`;
  if (others >= LIVE_GRANTS) return `${c.login} holds ${LIVE_GRANTS} live grants already: revoke one on your page, or let one expire`;
  return null;
}

/** The signed-in person in the browser, or the page that says why not: a token of any kind is refused, and nobody signed in is sent to sign in and back. */
async function personInBrowser(request: Request, url: URL, env: Env, v: RunningVersion): Promise<{ c: Contributor; session: string } | Response> {
  const s = browserSession(request);
  if (s.bearer) return message(url, env, v, 403, "Not with a token", "This page takes your browser's session only: a request that carries an Authorization header — an agent's token, a contributor's — is refused here.");
  const c = s.session ? await contributorOf(request, env) : null;
  if (!c || !s.session) {
    if (request.method !== "GET") return message(url, env, v, 401, "Sign in first", `Sign in with GitHub, then open the link again.`, "refused", [{ href: `/auth/github?next=${encodeURIComponent(url.pathname)}`, label: "Sign in with GitHub" }]);
    return new Response(null, { status: 302, headers: { location: `/auth/github?next=${encodeURIComponent(url.pathname + url.search)}`, "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  }
  return { c, session: s.session };
}

/** GET /auth/agent — the grant page. */
export async function handleGrantPage(url: URL, request: Request, env: Env, v: RunningVersion): Promise<Response> {
  // The session is the dashboard's: a link to another production name (the API's, which the command knows) starts over there.
  if (isProductionHost(url.hostname) && url.hostname !== DASHBOARD_HOST) return new Response(null, { status: 302, headers: { location: `https://${DASHBOARD_HOST}${url.pathname}${url.search}`, "x-robots-tag": "noindex, nofollow" } });
  const who = await personInBrowser(request, url, env, v);
  if (who instanceof Response) return who;
  const a = grantAsk(url.searchParams);
  if (typeof a === "string") return message(url, env, v, 400, "This link asks for something the pool does not grant", esc(a));
  const live = (await env.DB.prepare(LIVE_GRANTS_SQL).bind(who.c.login).all<{ id: string; agent: string; created_at: string }>()).results;
  const replaces = live.find((g) => g.agent === a.agent) ?? null;
  const ts = String(Date.now());
  return personal(grantHtml({
    login: who.c.login, agent: a.agent, scopes: a.scopes, port: a.port, state: a.state, challenge: a.challenge, days: a.days,
    expires_at: grantExpiry(a.scopes, a.days), refusal: grantRefusal(who.c, a, live.length - (replaces ? 1 : 0)), replaces, live: live.length,
    ts, nonce: await formNonce(env, grantParts(await sha256Hex(who.session), a, ts)),
  }, url.pathname, env.POOL_URL, v));
}

/**
 * The grant, written: the person's code nobody swapped goes, and the new
 * one is inserted only while the login holds fewer than three live grants
 * under other agent names — a live grant of the same name is replaced at
 * the swap, once the new token exists (REPLACE_SQL) — one batch, one
 * transaction. The count reads the live grants' partial index only.
 */
export const GRANT_INSERT_SQL = `INSERT INTO agent_grants (id, login, agent, scopes, code_hash, challenge, code_expires_at, expires_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
   WHERE (SELECT COUNT(*) FROM agent_grants WHERE login = ?2 AND revoked_at IS NULL AND token_hash IS NOT NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND agent != ?3) < ?9`;

/** POST /auth/agent — Grant or Deny, from the grant page. */
export async function handleGrant(url: URL, request: Request, env: Env, v: RunningVersion): Promise<Response> {
  const who = await personInBrowser(request, url, env, v);
  if (who instanceof Response) return who;
  if (!sameOrigin(request, url)) return message(url, env, v, 403, "Not from this page", "The grant is posted from the grant page, on this address; this one came from somewhere else.");
  const form = await formOf(request);
  if (!form) return message(url, env, v, 400, "Not a form", "The grant is posted from the grant page's form.");
  const a = grantAsk(form);
  if (typeof a === "string") return message(url, env, v, 400, "Not granted", esc(a));
  const ts = form.get("ts") ?? "";
  const expected = await formNonce(env, grantParts(await sha256Hex(who.session), a, ts));
  if (!sameNonce(form.get("nonce") ?? "", expected) || !(Date.now() - Number(ts) < GRANT_FORM_MS && Number(ts) <= Date.now())) {
    return message(url, env, v, 403, "Open the link again", "This form is not the one the grant page wrote for your session, or it is older than ten minutes: run omarchy-cli login again.");
  }
  const back = new URL(`http://127.0.0.1:${a.port}/`);
  back.searchParams.set("state", a.state);
  if (form.get("action") !== "grant") {
    back.searchParams.set("error", "access_denied");
    return new Response(null, { status: 303, headers: { location: back.toString(), "cache-control": "no-store" } });
  }
  // The login's Grants, counted at the edge as its agents' calls are (the same binding, its own key): a page that loops Grant writes no row past it.
  if (env.AGENT_CALLS && !(await env.AGENT_CALLS.limit({ key: `grant:${who.c.login}` })).success) {
    return message(url, env, v, 429, "Wait a minute", esc(`${who.c.login} pressed Grant ${CALLS_PER_MINUTE} times this minute: wait a minute, then run omarchy-cli login again.`));
  }
  const live = (await env.DB.prepare(LIVE_GRANTS_SQL).bind(who.c.login).all<{ id: string; agent: string; created_at: string }>()).results;
  const replaces = live.find((g) => g.agent === a.agent) ?? null;
  const no = grantRefusal(who.c, a, live.length - (replaces ? 1 : 0));
  if (no) return message(url, env, v, no.includes("live grants") ? 409 : 403, "Not granted", esc(no), "refused", [{ href: `/user/${encodeURIComponent(who.c.login)}#agents`, label: "Your grants" }]);
  const id = `g_${randomHex(16)}`, code = randomHex(32);
  const now = Date.now();
  const [, ins] = await env.DB.batch([
    // A code nobody took is deleted by the person's next Grant.
    env.DB.prepare(UNSWAPPED_SQL).bind(who.c.login),
    // Logging in again with the same agent name replaces that grant — at the swap, once the new token exists (REPLACE_SQL).
    env.DB.prepare(GRANT_INSERT_SQL).bind(id, who.c.login, a.agent, JSON.stringify(a.scopes), await sha256Hex(code), a.challenge, new Date(now + CODE_SECONDS * 1000).toISOString(), grantExpiry(a.scopes, a.days, now), LIVE_GRANTS),
  ]);
  if (!ins.meta.changes) return message(url, env, v, 409, "Not granted", esc(`${who.c.login} holds ${LIVE_GRANTS} live grants already: revoke one on your page, or let one expire`));
  back.searchParams.set("code", code);
  return new Response(null, { status: 303, headers: { location: back.toString(), "cache-control": "no-store" } });
}

/** The swap: the token set only where the code matches, has not expired, was not taken, and the verifier hashes to the challenge — one conditional update through the code's unique index. */
export const SWAP_SQL = `UPDATE agent_grants SET token_hash = ?1, code_hash = NULL, challenge = NULL, code_expires_at = NULL
 WHERE code_hash = ?2 AND token_hash IS NULL AND revoked_at IS NULL AND challenge = ?3 AND code_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 RETURNING id, login, agent, scopes, expires_at`;

/**
 * Logging in again with the same agent name replaces that grant: the other
 * live grants of the swapped grant's login and name (?1, the new token's
 * hash) end as `replaced`, in the swap's own batch — after the new token is
 * set, never before, so a login that never comes back (a closed command, a
 * browser that cannot reach the loopback) leaves the old grant working.
 * Through the live grants' partial index; nothing when the swap took no row.
 */
export const REPLACE_SQL = `UPDATE agent_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_by = 'replaced'
 WHERE login = (SELECT login FROM agent_grants WHERE token_hash = ?1) AND agent = (SELECT agent FROM agent_grants WHERE token_hash = ?1)
   AND revoked_at IS NULL AND token_hash IS NOT NULL AND token_hash != ?1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/** POST /auth/agent/token — the code and its verifier for the token (JSON: {code, code_verifier}). */
export async function handleSwap(request: Request, env: Env): Promise<Response> {
  // The address's limit before anything is read: five tries a minute.
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (env.AGENT_SWAPS && !(await env.AGENT_SWAPS.limit({ key: `swap:${address}` })).success) {
    return json({ error: `${SWAPS_PER_MINUTE} token swaps a minute from one address: wait a minute`, code: "rate_limited" }, 429, { "retry-after": "60", "cache-control": "no-store" });
  }
  const b = (await request.json().catch(() => ({}))) as { code?: unknown; code_verifier?: unknown };
  const code = typeof b.code === "string" ? b.code : "", verifier = typeof b.code_verifier === "string" ? b.code_verifier : "";
  if (!/^[0-9a-f]{64}$/.test(code) || !VERIFIER.test(verifier)) return json({ error: "code and code_verifier are required: the code the grant page sent to the loopback address, and the verifier its challenge was made from (RFC 7636)", code: "invalid_request" }, 400, { "cache-control": "no-store" });
  const token = `oma_${randomHex(24)}`, hash = await sha256Hex(token);
  // The swap, the same name's grant replaced and its waiting drafts discarded: one batch, one transaction.
  const [swapped] = await env.DB.batch([
    env.DB.prepare(SWAP_SQL).bind(hash, await sha256Hex(code), await s256(verifier)),
    env.DB.prepare(REPLACE_SQL).bind(hash),
    env.DB.prepare(DISCARD_BY_TOKEN_SQL).bind(hash, REVOKED_OUTCOME),
  ]);
  const row = (swapped.results[0] as { id: string; login: string; agent: string; scopes: string; expires_at: string } | undefined) ?? null;
  if (!row) return json({ error: "the code is not valid — expired (a minute), taken already, or not for this verifier: run omarchy-cli login again", code: "invalid_grant" }, 400, { "cache-control": "no-store" });
  return json({ token, grant: row.id, login: row.login, agent: row.agent, scopes: JSON.parse(row.scopes), expires_at: row.expires_at, note: "Shown once; the pool keeps its hash. It acts as you through omarchy-cli's tools only." }, 200, { "cache-control": "no-store" });
}

/** Logout's revocation: the grant of the token sent, by the token's unique index. */
export const LOGOUT_SQL = "UPDATE agent_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_by = 'logout' WHERE token_hash = ? AND revoked_at IS NULL RETURNING id, login";

/** POST /auth/agent/revoke — omarchy-cli logout: the grant of the token sent ends now, and its waiting drafts with it. Always allowed: revoking only takes away. */
export async function handleAgentLogout(request: Request, env: Env): Promise<Response> {
  const h = request.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token.startsWith("oma_")) return json({ error: "an agent token is required: the one to revoke", code: "grant_invalid" }, 401);
  const hash = await sha256Hex(token);
  const [out] = await env.DB.batch([env.DB.prepare(LOGOUT_SQL).bind(hash), env.DB.prepare(DISCARD_BY_TOKEN_SQL).bind(hash, REVOKED_OUTCOME)]);
  const row = (out.results[0] as { id: string; login: string } | undefined) ?? null;
  if (!row) return json({ error: "this agent token is not valid — revoked already, replaced, or never granted", code: "grant_invalid" }, 401);
  return json({ revoked: row.id, login: row.login }, 200, { "cache-control": "no-store" });
}

/** Revoke on the person's page: one grant by its primary key, only the person's own, only while it is not revoked. */
export const REVOKE_GRANT_SQL = "UPDATE agent_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_by = ? WHERE id = ? AND login = ? AND revoked_at IS NULL RETURNING id, agent";

/** POST /api/v1/factory/grants/:id/revoke — Revoke on the person's own page: their own grants only, and their waiting drafts with them. */
export async function handleRevokeGrant(c: Contributor, id: string, env: Env): Promise<Response> {
  const [out] = await env.DB.batch([
    env.DB.prepare(REVOKE_GRANT_SQL).bind(c.login, id, c.login),
    env.DB.prepare(DISCARD_SQL).bind(c.login, REVOKED_OUTCOME),
  ]);
  const row = (out.results[0] as { id: string; agent: string } | undefined) ?? null;
  if (!row) return json({ error: `${id} is not a live grant of ${c.login}'s` }, 404);
  return json({ revoked: row.id, agent: row.agent, by: c.login });
}

// ---------- drafts ----------

type Verdict = "approve" | "request_changes" | "reject" | "block";
const VERDICTS: readonly Verdict[] = ["approve", "request_changes", "reject", "block"];

interface DraftRow { id: string; grant_id: string; login: string; agent: string; client: string | null; verdict: Verdict; note: string; name: string; task_id: number | null; facts: string; created_at: string; expires_at: string; used_at: string | null; state: string; outcome: string | null }

const DRAFT_COLS = "id, grant_id, login, agent, client, verdict, note, name, task_id, facts, created_at, expires_at, used_at, state, outcome";

/** A draft as its login and their agent read it: its state (a waiting one past its thirty minutes is expired), the link, the outcome. */
function draftView(d: DraftRow, origin: string) {
  const expired = d.state === "waiting" && d.expires_at <= new Date().toISOString();
  return { draft: d.id, state: expired ? "expired" : d.state, verdict: d.verdict, name: d.name, task: d.task_id, note: d.note, agent: d.agent, drafted_at: d.created_at, expires_at: d.expires_at, confirm_url: `${origin}/auth/confirm/${d.id}`, outcome: d.outcome ? JSON.parse(d.outcome) : null };
}

/**
 * POST /api/v1/factory/drafts — the agent drafts; nothing is decided. The
 * web's predicate is run first and refuses the way the web refuses — the
 * requester is told they brought it, with `conflict_of_interest`; a build
 * not staged is a 409 — and the day's count moves before it, so an agent
 * that loops on a refusal stops at the cap. A draft writes no journal line.
 */
export async function handleDraft(a: AgentCaller, request: Request, env: Env, origin: string): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { name?: unknown; verdict?: unknown; note?: unknown; task?: unknown };
  const verdict = VERDICTS.find((x) => x === b.verdict);
  if (!verdict) return json({ error: "verdict: approve, request_changes, reject or block" }, 400);
  const need: Scope = verdict === "block" ? "block" : "review";
  if (!a.scopes.includes(need)) return json({ error: `this grant does not hold ${need}: run omarchy-cli login --maintain`, code: "scope" }, 403);
  const name = typeof b.name === "string" ? b.name : "";
  if (!/^[a-z0-9@._+-]{1,100}$/.test(name)) return json({ error: "name: the package's name" }, 400);
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length < 4 || note.length > 500) return json({ error: `${verdict === "block" ? "reason" : "note"}: 4 to 500 characters — it goes on the record` }, 400);
  // A verdict is on a build: without one the arguments are wrong, and are refused before the day counts.
  const id = typeof b.task === "number" && Number.isInteger(b.task) ? b.task : NaN;
  if (verdict !== "block" && !Number.isInteger(id)) return json({ error: "task: the build the verdict is on (request_status and review_context name it)" }, 400);
  const counted = await dayCount(env, a.contributor.login, "drafts");
  if (counted) return counted;
  let task: number | null = null, facts: string;
  if (verdict === "block") {
    const pkg = await blockRefusal(a.contributor, name, note, env);
    if (pkg instanceof Response) return pkg;
    facts = await blockFacts(name, pkg);
  } else {
    const ok = await verdictOn(a.contributor, id, DRAFTED[verdict], env);
    if (ok instanceof Response) return ok;
    if (ok.task.name !== name) return json({ error: `task ${id} is a build of ${ok.task.name}, not ${name}` }, 400);
    task = ok.task.id;
    facts = ok.facts;
  }
  const draft = `d_${randomHex(16)}`;
  const expires = new Date(Date.now() + DRAFT_MINUTES * 60_000).toISOString();
  const row = await env.DB.prepare(`INSERT INTO drafts (id, grant_id, login, agent, client, verdict, note, name, task_id, facts, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${DRAFT_COLS}`)
    .bind(draft, a.grant, a.contributor.login, a.agent, a.client, verdict, note, name, task, facts, expires)
    .first<DraftRow>();
  return json({ ...draftView(row!, origin), next: await nextStep(env, a.contributor.login, verdict, origin) }, 201, { "cache-control": "no-store" });
}

/**
 * What the agent tells its person to do with a draft (the answer's `next`):
 * open the link and confirm. For approve and block (#257) it says the
 * confirmation asks for their passkey — and, when the login holds none yet,
 * that one is registered first, and where — so the person hears it before
 * the page, not from it.
 */
async function nextStep(env: Env, login: string, verdict: Verdict, origin: string): Promise<string> {
  if (!PASSKEY_VERDICTS.includes(verdict)) return `Open the link in a browser signed in as ${login} and confirm. Nothing is decided until then.`;
  if (await env.DB.prepare(HAS_PASSKEY_SQL).bind(login).first()) return `Open the link in a browser signed in as ${login} and confirm with your passkey: your device asks for your fingerprint, face or PIN. Nothing is decided until then.`;
  return `${login} has no passkey yet, and ${verdict === "approve" ? "an approval" : "a block"} is confirmed with one: register it first on ${origin}${registerHref(login)}, then open the link in a browser signed in as ${login} and confirm with it. Nothing is decided until then.`;
}

/** GET /api/v1/factory/drafts/:id — the draft, to its own login's agent. */
export async function handleGetDraft(a: AgentCaller, id: string, env: Env, origin: string): Promise<Response> {
  const d = await env.DB.prepare(`SELECT ${DRAFT_COLS} FROM drafts WHERE id = ?`).bind(id).first<DraftRow>();
  if (!d || d.login !== a.contributor.login) return json({ error: `no draft ${id} of ${a.contributor.login}'s` }, 404, { "cache-control": "no-store" });
  return json(draftView(d, origin), 200, { "cache-control": "no-store" });
}

/** The facts a block is drafted on, and confirmed on only while they hold: the registration's owner, its request, whether it is blocked. */
async function blockFacts(name: string, pkg: { owner: string; request_id: number | null; blocked_at: string | null }): Promise<string> {
  return sha256Hex(JSON.stringify({ name, owner: pkg.owner, request: pkg.request_id, blocked_at: pkg.blocked_at }));
}

// ---------- the confirmation ----------

/** The draft spent: only its login's, only once, only while it waits and has not expired. One draft decides once: this runs before the decision's handler, which reads then inserts. */
export const SPEND_SQL = `UPDATE drafts SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), state = ?3
 WHERE id = ?1 AND login = ?2 AND used_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

const confirmParts = (session: string, id: string) => ["confirm", session, id];

/** The builds of a chain in review: queued, running or staged. */
const IN_REVIEW = ["queued", "leased", "staged"];

/**
 * What the page shows beside the draft: the pool's own evidence of every
 * architecture the decision covers — one review decides them all (#242), so
 * each chain of the package still in review (no approval standing on it, a
 * build queued, running or staged: the round a decision closes, as
 * closeRound reads it) — its builds, their gates, the audit, the trial. The
 * draft's own build first, then by architecture.
 */
async function evidenceOf(env: Env, d: DraftRow): Promise<ConfirmEvidence | null> {
  if (d.task_id === null) return null;
  const story = await storyRows(env, d.name);
  const t = story.tasks.find((x) => x.id === d.task_id);
  if (!t) return null;
  const all = chains(story.tasks, story.approvals, story.pkg, story.request);
  const own = all.find((c) => c.contributor?.id === d.task_id || c.project?.id === d.task_id);
  const round = all.filter((c) => c === own || (!c.approval?.standing && [c.contributor, c.project].some((x) => x && IN_REVIEW.includes(x.status))));
  const archOf = (c: (typeof all)[number]) => (c.contributor ?? c.project)?.arch ?? "";
  round.sort((x, y) => (x === own ? -1 : y === own ? 1 : REPO_ARCHES.indexOf(archOf(x) as (typeof REPO_ARCHES)[number]) - REPO_ARCHES.indexOf(archOf(y) as (typeof REPO_ARCHES)[number])));
  const vet = (x: { result: Record<string, unknown> | null } | null) => ((x?.result?.vet as { verdict?: string } | undefined)?.verdict ?? null);
  const verdictOf = (x: { status: string; result: Record<string, unknown> | null } | null) => (x ? `${x.status}${(x.result as { verdict?: string } | null)?.verdict ? ` · ${(x.result as { verdict: string }).verdict}` : ""}` : null);
  return {
    task: { id: t.id, arch: t.arch, trust: t.trust, status: t.status, version: t.version },
    chains: round.map((c) => ({
      arch: archOf(c),
      contributor: c.contributor ? { id: c.contributor.id, status: c.contributor.status, vet: vet(c.contributor) } : null,
      project: c.project ? { id: c.project.id, status: c.project.status, vet: vet(c.project) } : null,
      audit: verdictOf(c.audit),
      trial: verdictOf(c.trial),
    })),
  };
}

/** The grant a draft came through, by its primary key: a confirm reads it again. */
export const DRAFT_GRANT_SQL = "SELECT revoked_at, revoked_by FROM agent_grants WHERE id = ?";

/** Why the agent's grant is gone, in the person's words. */
function revokedWords(by: string | null): string {
  if (by === "logout") return "omarchy-cli logout";
  if (by === "replaced") return "a new login under the same agent name replaced it";
  if (by === "blocked") return "its person was blocked";
  if (by === "reset") return "its person's passkeys were reset";
  return by ? `revoked on ${by}'s page` : "revoked";
}

/**
 * Whether the draft may be confirmed now: null when it may, else why not in
 * words. Three things, in order. The agent's grant is still live — one the
 * person revoked (or replaced, or lost to a block) since decides nothing
 * through its drafts. The web's predicate allows the verdict on the facts of
 * now, and refuses in its words. And the facts are the ones the draft was
 * made on (drafts.facts): a package that moved in the meantime — an
 * architecture built, rebuilt or failed, a claim taken or let go — is not
 * what the agent drafted on, so it is refused and asked for again.
 */
async function nowRefusal(c: Contributor, d: DraftRow, env: Env): Promise<string | null> {
  const g = await env.DB.prepare(DRAFT_GRANT_SQL).bind(d.grant_id).first<{ revoked_at: string | null; revoked_by: string | null }>();
  if (!g || g.revoked_at) return `the grant to ${d.agent} that drafted this was revoked since (${revokedWords(g?.revoked_by ?? null)}): nothing is decided through a revoked agent's draft — grant it again and ask for a new one`;
  const changed = `${d.name} changed since ${d.agent} drafted this — a build, an architecture or a decision moved: nothing was decided; ask the agent for a new draft on the facts of now`;
  if (d.verdict === "block") {
    const pkg = await blockRefusal(c, d.name, d.note, env);
    if (pkg instanceof Response) return ((await pkg.json()) as { error: string }).error;
    return (await blockFacts(d.name, pkg)) === d.facts ? null : changed;
  }
  const ok = await verdictOn(c, d.task_id ?? 0, DRAFTED[d.verdict], env);
  if (ok instanceof Response) return ((await ok.json()) as { error: string }).error;
  return ok.facts === d.facts ? null : changed;
}

/**
 * Whether a confirmed draft's decision is in the database after its handler
 * threw: the decision's rows carry the draft (approvals.agent, written in the
 * decision's own batch), read by the name's index since the draft was made;
 * a block is the registration's, by this person.
 */
export const DECIDED_BY_DRAFT_SQL = "SELECT 1 AS one FROM approvals WHERE name = ? AND created_at >= ? AND json_extract(agent, '$.draft') = ? LIMIT 1";
async function decidedBy(env: Env, d: DraftRow, login: string): Promise<boolean> {
  if (d.verdict === "block") return !!(await env.DB.prepare("SELECT 1 AS one FROM factory_packages WHERE name = ? AND blocked_at IS NOT NULL AND blocked_by = ?").bind(d.name, login).first());
  return !!(await env.DB.prepare(DECIDED_BY_DRAFT_SQL).bind(d.name, d.created_at, d.id).first());
}

/** The draft by its id, for its own login in the browser — or the page that says why not (without a word of someone else's draft). */
async function ownDraft(url: URL, env: Env, v: RunningVersion, c: Contributor, id: string): Promise<DraftRow | Response> {
  const d = /^d_[0-9a-f]{32}$/.test(id) ? await env.DB.prepare(`SELECT ${DRAFT_COLS} FROM drafts WHERE id = ?`).bind(id).first<DraftRow>() : null;
  if (!d) return message(url, env, v, 404, "No such draft", "The link names no draft: ask the agent for its link again.");
  if (d.login !== c.login) return message(url, env, v, 403, "Not your draft", esc(`This draft is for another login: open it signed in as the person whose agent drafted it. You are signed in as ${c.login}.`));
  return d;
}

/** GET /auth/confirm/:id — the draft, the evidence, and Confirm or Discard. */
export async function handleConfirmPage(id: string, url: URL, request: Request, env: Env, v: RunningVersion): Promise<Response> {
  if (isProductionHost(url.hostname) && url.hostname !== DASHBOARD_HOST) return new Response(null, { status: 302, headers: { location: `https://${DASHBOARD_HOST}${url.pathname}`, "x-robots-tag": "noindex, nofollow" } });
  const who = await personInBrowser(request, url, env, v);
  if (who instanceof Response) return who;
  const d = await ownDraft(url, env, v, who.c, id);
  if (d instanceof Response) return d;
  const expired = d.state === "waiting" && d.expires_at <= new Date().toISOString();
  const state = expired ? "expired" : d.state;
  const pkg = await env.DB.prepare("SELECT owner, status FROM factory_packages WHERE name = ?").bind(d.name).first<{ owner: string; status: string }>();
  return personal(confirmHtml({
    draft: { ...d, state, outcome: d.outcome ? (JSON.parse(d.outcome) as Record<string, unknown>) : null },
    refusal: state === "waiting" ? await nowRefusal(who.c, d, env) : null,
    pkg,
    evidence: await evidenceOf(env, d),
    nonce: await formNonce(env, confirmParts(await sha256Hex(who.session), d.id)),
    passkey: state === "waiting" ? await passkeyState(env, url, who.c.login, d) : null,
  }, url.pathname, env.POOL_URL, v));
}

/**
 * What the confirm page offers for a draft that waits (#257): nothing to
 * ask for request changes and reject; for approve and block, the passkey —
 * "ready" when the login holds one on this address, "none" when it holds
 * none (the page says so and links to the registration: no silent
 * fallback), "unavailable" on an address the relying party list does not
 * name.
 */
async function passkeyState(env: Env, url: URL, login: string, d: DraftRow): Promise<ConfirmPasskey | null> {
  if (!PASSKEY_VERDICTS.includes(d.verdict)) return null;
  if (!relyingParty(url)) return { state: "unavailable", register: registerHref(login) };
  return { state: (await env.DB.prepare(HAS_PASSKEY_SQL).bind(login).first()) ? "ready" : "none", register: registerHref(login) };
}

/**
 * POST /auth/confirm/:id/challenge — for a draft of approve or block that
 * waits: the options the page's script hands navigator.credentials.get().
 * The session only, the same login, the Origin and the page's nonce, as the
 * confirmation itself; the challenge is bound to this draft and login and
 * lives five minutes (routes/passkeys.ts). JSON, never cached.
 */
export async function handleConfirmChallenge(id: string, url: URL, request: Request, env: Env): Promise<Response> {
  const noStore = { "cache-control": "no-store" };
  const s = browserSession(request);
  if (s.bearer) return json({ error: "a draft is confirmed in the browser, with its session: a request that carries an Authorization header is refused", code: "session_only" }, 403, noStore);
  const c = s.session ? await contributorOf(request, env) : null;
  if (!c || !s.session) return json({ error: "sign in with GitHub, then open the draft's link again", code: "sign_in" }, 401, noStore);
  if (!sameOrigin(request, url)) return json({ error: "not from the draft's page: a draft is confirmed on its own page, on this address", code: "origin" }, 403, noStore);
  const form = await formOf(request);
  const d = await env.DB.prepare(`SELECT ${DRAFT_COLS} FROM drafts WHERE id = ?`).bind(id).first<DraftRow>();
  if (!d || d.login !== c.login) return json({ error: `no draft ${id} of ${c.login}'s`, code: "not_found" }, 404, noStore);
  if (!form || !sameNonce(form.get("nonce") ?? "", await formNonce(env, confirmParts(await sha256Hex(s.session), d.id)))) {
    return json({ error: "this is not the form the draft's page wrote for your session: open the link again", code: "nonce" }, 403, noStore);
  }
  if (!PASSKEY_VERDICTS.includes(d.verdict)) return json({ error: "request changes and reject are confirmed without a passkey: the session, and for a rejection the package's name typed", code: "no_passkey_needed" }, 400, noStore);
  if (d.used_at) return json({ error: "this draft was confirmed or discarded already: a draft decides once", code: "spent" }, 409, noStore);
  if (d.expires_at <= new Date().toISOString()) return json({ error: "nobody confirmed this draft within thirty minutes; nothing was decided: ask the agent for a new draft", code: "expired" }, 410, noStore);
  const rp = relyingParty(url);
  if (!rp) return json({ error: `approve and block are confirmed with a passkey, which works on ${DASHBOARD_HOST} only (and on localhost in development)`, code: "rp_unavailable" }, 403, noStore);
  return assertionOptions(env, rp, c.login, d.id);
}

/**
 * POST /auth/confirm/:id — Confirm or Discard. The session only (a request
 * with an Authorization header is refused), the same login, its Origin, the
 * page's nonce; for approve and block, a passkey's assertion with the user
 * verified, checked against the key the login registered (#257) — without
 * one nothing is decided, and a login without a passkey is told to register
 * one; for reject and block, the package's name typed. The predicate runs
 * again on the facts of now — a build decided in the meantime is refused
 * with the reason, and the draft says so. Then the draft is spent
 * (SPEND_SQL) and only then the web's own handler decides, with the draft
 * (and the passkey) on its record and its journal line.
 */
export async function handleConfirm(id: string, url: URL, request: Request, env: Env, v: RunningVersion): Promise<Response> {
  const who = await personInBrowser(request, url, env, v);
  if (who instanceof Response) return who;
  if (!sameOrigin(request, url)) return message(url, env, v, 403, "Not from this page", "A draft is confirmed from its own page, on this address; this request came from somewhere else.");
  const form = await formOf(request);
  if (!form) return message(url, env, v, 400, "Not a form", "A draft is confirmed from its page's form.");
  const d = await ownDraft(url, env, v, who.c, id);
  if (d instanceof Response) return d;
  if (!sameNonce(form.get("nonce") ?? "", await formNonce(env, confirmParts(await sha256Hex(who.session), d.id)))) {
    return message(url, env, v, 403, "Open the draft again", "This form is not the one the draft's page wrote for your session: open the link again.");
  }
  const back = [{ href: `/auth/confirm/${d.id}`, label: "The draft" }, { href: `/user/${encodeURIComponent(who.c.login)}#agents`, label: "Your drafts" }];
  if (form.get("action") === "discard") {
    const res = await env.DB.prepare(`UPDATE drafts SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), state = 'discarded' WHERE id = ? AND login = ? AND used_at IS NULL`).bind(d.id, who.c.login).run();
    return res.meta.changes ? message(url, env, v, 200, "Discarded", `Nothing was decided on ${esc(d.name)}.`, "done", back) : message(url, env, v, 409, "Not discarded", "This draft was confirmed or discarded already.", "refused", back);
  }
  if (d.used_at) {
    // Spent already: said as what became of it — confirmed, refused, or discarded (by the person, or with its grant) — with why.
    const why = d.outcome ? ((JSON.parse(d.outcome) as { error?: unknown }).error ?? null) : null;
    return message(url, env, v, 409, d.state === "discarded" ? "Discarded" : d.state === "refused" ? "Refused" : "Confirmed already", esc(typeof why === "string" ? why : "This draft was confirmed or discarded already: a draft decides once."), "refused", back);
  }
  if (d.expires_at <= new Date().toISOString()) return message(url, env, v, 410, "Expired", "Nobody confirmed this draft within thirty minutes; nothing was decided. Ask the agent for a new draft.", "refused", back);
  // Approve and block: the passkey first — its challenge is taken whatever comes next, so an answer is good for one request — and nothing about the draft changes when it is refused.
  let passkey: string | null = null;
  if (PASSKEY_VERDICTS.includes(d.verdict)) {
    const pk = await confirmPasskey(env, url, who.c.login, d.id, form);
    if ("refused" in pk) return message(url, env, v, pk.status, pk.heading, esc(pk.text), "refused", pk.register ? [{ href: registerHref(who.c.login), label: "Register a passkey" }, ...back] : back);
    passkey = pk.passkey;
  }
  if ((d.verdict === "reject" || d.verdict === "block") && (form.get("name") ?? "").trim() !== d.name) {
    return message(url, env, v, 400, "Type the package's name", esc(`To ${d.verdict} it, type ${d.name} in the box: a rejection and a block are confirmed with the name typed.`), "refused", back);
  }
  // The predicate on the facts of now: a refusal spends the draft and says why, and nothing is decided.
  const no = await nowRefusal(who.c, d, env);
  if (no) {
    await env.DB.prepare(`UPDATE drafts SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), state = 'refused', outcome = ? WHERE id = ? AND login = ? AND used_at IS NULL`).bind(JSON.stringify({ error: no }), d.id, who.c.login).run();
    return message(url, env, v, 409, "Not decided", esc(no), "refused", back);
  }
  // Spent before anything is decided: a second confirm — a double click, a retried request — changes nothing and is told so.
  const spent = await env.DB.prepare(SPEND_SQL).bind(d.id, who.c.login, "confirmed").run();
  if (spent.meta.changes !== 1) return message(url, env, v, 409, "Confirmed already", "This draft was confirmed or discarded already: a draft decides once.", "refused", back);
  const through: Through = { agent: d.agent, client: d.client, grant: d.grant_id, draft: d.id, drafted_at: d.created_at, confirmed_at: new Date().toISOString(), ...(passkey ? { passkey } : {}) };
  // The web's own handler, as the web calls it: the browser's session is the door (via: web), the draft rides on its record and its line.
  const inner = new Request(`${url.origin}/api/v1/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d.verdict === "block" ? { reason: d.note } : { note: d.note }) });
  let res: Response;
  try {
    res = d.verdict === "block"
      ? await handleBlockPackage(who.c, d.name, inner, env, through)
      : await (d.verdict === "approve" ? handleApprove : d.verdict === "reject" ? handleReject : handleChanges)(who.c, d.task_id!, inner, env, through);
  } catch (e) {
    // The handler failed on the pool's side (a database error, say): the draft says what became of it — confirmed only when the decision is in the database — never "confirmed" with nothing decided.
    const decided = await decidedBy(env, d, who.c.login).catch(() => false);
    const why = String(e instanceof Error ? e.message : e).slice(0, 200);
    const said = decided ? `${d.name} was decided, then the pool failed before it finished (${why}): the decision stands; the Review workspace shows what is left to do` : `the pool failed before anything was decided (${why}): nothing was decided — ask the agent for a new draft`;
    await env.DB.prepare("UPDATE drafts SET state = ?, outcome = ? WHERE id = ?").bind(decided ? "confirmed" : "refused", JSON.stringify({ status: 500, error: said }), d.id).run();
    return message(url, env, v, 500, decided ? "Decided, not finished" : "Not decided", esc(said), "refused", back);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  await env.DB.prepare("UPDATE drafts SET state = ?, outcome = ? WHERE id = ?").bind(res.ok ? "confirmed" : "refused", JSON.stringify({ status: res.status, ...body }), d.id).run();
  if (!res.ok) return message(url, env, v, res.status, "Not decided", esc(String(body.error ?? `HTTP ${res.status}`)), "refused", back);
  const words: Record<Verdict, string> = { approve: "approved", request_changes: "sent back with changes requested", reject: "rejected", block: "blocked" };
  return message(url, env, v, 200, `${d.name} ${words[d.verdict]}`, esc(`${d.name} ${words[d.verdict]} by ${who.c.login} — drafted by ${d.agent}, confirmed in the browser${passkey ? " with a passkey" : ""}.`) + (typeof body.record === "string" ? ` <a href="${esc(body.record)}">The signed record →</a>` : ""), "done", [{ href: `/package/${encodeURIComponent(d.name)}`, label: d.name }, back[1]]);
}

// ---------- the tools' routes, with an agent's token ----------

/** The claim or the release through an agent: the day's count first (a release counts as a claim), then the web's own handler, with the agent on its row, its record and its line. */
export async function agentClaimOrRelease(a: AgentCaller, id: number, request: Request, env: Env, handle: (c: Contributor, id: number, request: Request, env: Env, through?: Through) => Promise<Response>): Promise<Response> {
  const counted = await dayCount(env, a.contributor.login, "claims");
  return counted ?? handle(a.contributor, id, request, env, a.through);
}
