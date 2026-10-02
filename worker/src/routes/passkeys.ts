/**
 * Passkeys (#257, #271; docs: worker/src/docs/omarchy-cli-mcp.md, *A passkey
 * for approve and block*). A maintainer registers a passkey on their own
 * page, and approve and block — the web's own buttons and the confirmation
 * of an agent's draft — ask for it: a WebAuthn assertion with user
 * verification — the person's fingerprint, face or PIN on their device,
 * which neither a token nor an agent's software can supply — verified here
 * against the key stored at registration (webauthn.ts, with WebCrypto).
 *
 *   POST /auth/passkeys/challenge     the options navigator.credentials.create() takes, for a maintainer
 *   POST /auth/passkeys               {label, id, clientDataJSON, attestationObject[, assertion]}: the passkey, registered
 *                                     and journaled — the login's first with the session alone, any other with an
 *                                     assertion from one it holds (#271)
 *   POST /auth/passkeys/:id/remove    {assertion}: the person's own passkey removed, with an assertion from one they hold, journaled
 *   POST /auth/passkeys/assert        {for}: the options navigator.credentials.get() takes for one act of the person's on the web (#271)
 *   POST /auth/passkeys/reset         {login, reason, assertion}: a lost authenticator's way back — another maintainer removes
 *                                     every passkey of the login and signs it out, journaled and signed on the record (#271);
 *                                     the login's omc_ token and its agents' grants go with them, a line each (#284)
 *   POST /auth/confirm/:id/challenge  the options navigator.credentials.get() takes for one draft (routes/agents.ts)
 *
 * The web's approve and block (routes/review.ts, routes/blocks.ts) take the
 * assertion in their JSON body (`assertion`), through webGate below, once
 * their own predicate allowed the act and before they write anything. So
 * does a promotion forced past its evidence (jobs.ts, #284).
 *
 * Each takes the browser's session only — a request with an Authorization
 * header is refused, so no token of any kind registers a key, uses one, or
 * approves and blocks — posted from the page's own origin (the Origin
 * header, as the confirmation's forms). The relying party — the RP id and
 * the origin a ceremony must have run on — comes from one list, never from
 * what a request says it is: the dashboard's name in production (every
 * production name serves it: the pages redirect to it), localhost in
 * wrangler dev and the tests (WebAuthn takes no IP address and needs a
 * secure context, which localhost is). Anywhere else a passkey is not
 * offered, and approve and block cannot be confirmed there.
 *
 * A challenge is issued for one purpose — a registration of the login, or
 * an assertion bound to one thing: a draft of the login's (its id,
 * `d_<hex>`), or one act of theirs on the web (a subject, always with a
 * colon: SUBJECT) — lives five minutes, and is deleted by the statement that
 * takes it, whatever the answer turns out to be: an answer is good for one
 * request. A new one replaces the login's earlier one for the same purpose
 * and draft or act — the page answers only the newest, so a prompt the
 * person cancelled holds no slot of the five. The pool stores the
 * credential's id, its public key, the algorithm, the RP id, the counter, a
 * label and two dates; nothing of the authenticator's attestation.
 */
import { json, type Env } from "../index";
import { DASHBOARD_HOST, isProductionHost, PROMOTED_RINGS, REPO_ARCHES } from "../meta";
import { browserSession, randomHex, type Through } from "../agents";
import { contributorOf, isMaintainer, RESET_TOKEN_MARK, sha256Hex, SIGN_IN, type Contributor } from "./contributors";
import { ALGORITHMS, OFFERED_ALGORITHMS, WebAuthnError, fromB64url, sha256, toB64url, verifyAssertion, verifyRegistration, type WebAuthnCode } from "../webauthn";
import { NO_PASSKEY, PASSKEY_ELSEWHERE } from "../pages/agent-auth";
import { putRecord, recordUrl } from "../record";
import { DISCARD_SQL, UNSWAPPED_SQL } from "./agents";

/** Passkeys a login holds at most: an eleventh is refused until one is removed. */
export const MAX_PASSKEYS = 10;
/** A challenge's life: the browser's ceremony (two minutes) and time to spare. */
export const CHALLENGE_MINUTES = 5;
/** Challenges a login holds live at most — one per purpose and draft, as a new one replaces the earlier — so a sixth ceremony at once is refused until one is taken or expires. */
export const LIVE_CHALLENGES = 5;
/** What a person is told when the five are live: in their words, and what to do. */
export const TOO_MANY_CHALLENGES = `Too many passkey requests in the last ${CHALLENGE_MINUTES} minutes: wait a few minutes, then press again.`;
/** How long the browser waits for the authenticator. */
export const CEREMONY_MS = 120_000;
/** The verdicts confirmed with a passkey: the two that change what users get. Request changes and reject keep the session and, for reject, the name typed. */
export const PASSKEY_VERDICTS: readonly string[] = ["approve", "block"];
/** A reset's reason, as the record keeps it: one line of 4 to 300 printable characters. */
export const RESET_REASON = { min: 4, max: 300 };
/**
 * A passkey registered just now (#287): its first use, within ten minutes of
 * its registration — a maintainer who held none registers it in the act's
 * own dialog, then confirms the act with it at the next press. The act's
 * journal line says so ("… with a passkey registered just now"), from the
 * row the assertion reads anyway: nothing more is read or stored.
 */
export const JUST_NOW_MINUTES = 10;

const NO_STORE = { "cache-control": "no-store" };

/** The relying party a passkey is for, and the origin its ceremonies run on. */
export interface RelyingParty {
  id: string;
  origin: string;
  name: string;
}

/**
 * The relying party for the address a request came to, from one list: the
 * dashboard's name for every production name (the session and the pages
 * live there), and localhost — any port — for wrangler dev and the tests.
 * null anywhere else (an IP address, the tests' pool.test): no passkey is
 * offered there.
 */
export function relyingParty(url: URL): RelyingParty | null {
  if (isProductionHost(url.hostname)) return { id: DASHBOARD_HOST, origin: `https://${DASHBOARD_HOST}`, name: "omarchy-pool" };
  if (url.hostname === "localhost") return { id: "localhost", origin: url.origin, name: "omarchy-pool (local)" };
  return null;
}

/** The user handle a login's passkeys are registered under: stable, 32 bytes, and not the login itself (WebAuthn §14.6.1). */
export async function userHandleOf(login: string): Promise<Uint8Array> {
  return sha256(`omarchy-pool passkey user\n${login}`);
}

/** Where a person registers a passkey: the section of their own page. */
export const registerHref = (login: string) => `/user/${encodeURIComponent(login)}#passkeys`;

/** Whether a login holds a passkey at all, as /auth/me tells a maintainer's pages (#287): one entry of the (login, created_at) index. */
export async function holdsPasskey(env: Env, login: string): Promise<boolean> {
  return !!(await env.DB.prepare(HAS_PASSKEY_SQL).bind(login).first());
}

/**
 * What an assertion on the web is for (#271), bound into its challenge
 * (passkey_challenges.draft_id, purpose 'confirm', beside a draft's id):
 * approving a build, blocking a package or a contributor, adding a passkey
 * to a login that holds one, removing one, resetting another login's, and
 * forcing a promotion past its evidence (#284). The door computes it from
 * the route and the body — `approve:<task>`, `block:package:<name>`,
 * `block:contributor:<login>`, `passkey:add`, `passkey:remove:<id>`,
 * `passkey:reset:<login>`, `promote:force:<from>:<to>[:<arch>]` — so an
 * answer made for one act decides no other.
 */
export const SUBJECT = new RegExp(String.raw`^(?:approve:[1-9]\d{0,14}|block:(?:package|contributor):[A-Za-z0-9@._+-]{1,100}|passkey:add|passkey:remove:pk_[0-9a-f]{32}|passkey:reset:[A-Za-z0-9-]{1,39}|promote:force:(?:${PROMOTED_RINGS.join("|")}):(?:${PROMOTED_RINGS.join("|")})(?::(?:${REPO_ARCHES.join("|")}))?|host:(?:resume|retire):h_[0-9a-z]{10}|host:(?:cause|resume-all):[A-Za-z0-9-]{1,39})$`);

/** A forced promotion's act (#284): the rings and the architecture it names, as the door and the Status page's button bind it. */
export const forcedSubject = (from: string, to: string, arch?: string): string => `promote:force:${from}:${to}${arch ? `:${arch}` : ""}`;

/** An act as a refusal names it — "approving build #12", "blocking hers" — and what did not happen when it is refused. */
function actOf(subject: string): { act: string; nothing: string } {
  const [kind, a, b, c, d] = subject.split(":");
  if (kind === "approve") return { act: `approving build #${a}`, nothing: "nothing was decided" };
  if (kind === "block") return { act: `blocking ${b}`, nothing: "nothing was decided" };
  if (kind === "promote") return { act: `forcing ${b} into ${c}${d ? ` on ${d}` : ""}`, nothing: "nothing was queued" };
  // A host's acts (#322): the host's id, or the owner's login.
  if (kind === "host") return { act: a === "resume" ? `resuming host ${b}` : a === "retire" ? `retiring host ${b}` : a === "cause" ? `removing ${b} for cause` : `resuming ${b}'s hosts`, nothing: "nothing changed" };
  if (a === "add") return { act: "adding a passkey", nothing: "no passkey was added" };
  if (a === "remove") return { act: "removing a passkey", nothing: "nothing was removed" };
  return { act: `resetting ${b}'s passkeys`, nothing: "nothing was reset" };
}

// ---------- the statements (every one through an index: agent-tools and passkeys tests ask each for its plan) ----------

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** A login's passkeys, newest first, by (login, created_at): ten at most, the cap. */
export const PASSKEYS_SQL = `SELECT id, credential_id, alg, label, counter, created_at, last_used FROM passkeys WHERE login = ? ORDER BY created_at DESC LIMIT ${MAX_PASSKEYS}`;
/** Whether a login holds a passkey at all: one entry of (login, created_at). */
export const HAS_PASSKEY_SQL = "SELECT 1 AS one FROM passkeys WHERE login = ? LIMIT 1";
/** A passkey by the credential that answered: the unique index on its id — with its two dates, for a first use just after its registration (#287). */
export const PASSKEY_BY_CREDENTIAL_SQL = "SELECT id, login, public_key, alg, counter, rp_id, created_at, last_used FROM passkeys WHERE credential_id = ?";
/** A login's own passkey by its id (primary key), for its removal. */
export const OWN_PASSKEY_SQL = "SELECT id, alg, created_at FROM passkeys WHERE id = ? AND login = ?";
/**
 * A registration: inserted only while the login holds fewer than ten, only a
 * credential not registered already, only while the session that asked is
 * still the login's (?10, its hash: a reset or a sign-out that landed while
 * the ceremony ran leaves nothing behind it, #271), and — unless a passkey
 * the login still holds vouched for it (?9, its id, #271) — only while the
 * login holds none: the first is the session's alone, and two first
 * registrations sent at once store one.
 */
export const PASSKEY_INSERT_SQL = `INSERT INTO passkeys (id, login, credential_id, public_key, alg, rp_id, counter, label)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
   WHERE (SELECT COUNT(*) FROM passkeys WHERE login = ?2) < ${MAX_PASSKEYS} AND NOT EXISTS (SELECT 1 FROM passkeys WHERE credential_id = ?3)
     AND EXISTS (SELECT 1 FROM contributors WHERE login = ?2 AND session_hash = ?10)
     AND (EXISTS (SELECT 1 FROM passkeys WHERE id = ?9 AND login = ?2) OR (?9 IS NULL AND NOT EXISTS (SELECT 1 FROM passkeys WHERE login = ?2)))`;
/** The journal's line of a registration or a removal, written only while the passkey is there (?4 its id, ?5 the login): after the insert, before the delete, in the same batch. */
export const PASSKEY_EVENT_SQL = `INSERT INTO events (kind, ring, source, status, summary, payload)
  SELECT 'passkey', NULL, 'factory', ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM passkeys WHERE id = ?4 AND login = ?5)`;
/** A removal: the login's own passkey only. */
export const PASSKEY_REMOVE_SQL = "DELETE FROM passkeys WHERE id = ? AND login = ?";
/**
 * A passkey used: the counter moves only forward, in one conditional
 * update — two answers that raced with the same counter move it once — and
 * an authenticator that keeps no counter (zero, both times) is taken as it is.
 */
export const PASSKEY_USED_SQL = `UPDATE passkeys SET counter = ?2, last_used = ${NOW} WHERE id = ?1 AND (counter < ?2 OR (counter = 0 AND ?2 = 0))`;
/** A login's expired challenges, deleted when it asks for a new one. */
export const CHALLENGE_PRUNE_SQL = `DELETE FROM passkey_challenges WHERE login = ? AND expires_at <= ${NOW}`;
/**
 * The login's earlier challenge for the same purpose and draft (NULL for a
 * registration), deleted when a new one is issued: the page answers the
 * newest only, so a cancelled or timed-out prompt frees its slot at the next
 * press. Through (login, expires_at), five live rows a login at most.
 */
export const CHALLENGE_REPLACE_SQL = "DELETE FROM passkey_challenges WHERE login = ?1 AND purpose = ?2 AND draft_id IS ?3";
/** A challenge issued, only while the login holds fewer than five live ones. */
export const CHALLENGE_INSERT_SQL = `INSERT INTO passkey_challenges (challenge, login, purpose, draft_id, expires_at)
  SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT COUNT(*) FROM passkey_challenges WHERE login = ?2 AND expires_at > ${NOW}) < ${LIVE_CHALLENGES}`;
/** A challenge taken — deleted by its primary key and read back in the same statement: whatever the answer turns out to be, it is good once. */
export const CHALLENGE_TAKE_SQL = "DELETE FROM passkey_challenges WHERE challenge = ? RETURNING login, purpose, draft_id, expires_at";
/** Every login's expired challenges, for the weekly gc. */
export const EXPIRED_CHALLENGES_SQL = `DELETE FROM passkey_challenges WHERE expires_at < ${NOW}`;
/** A reset's journal line (#271), written only while the login still holds a passkey (?3): before the delete, in the same batch — a reset is never silent, and one sent twice at once writes one line. */
export const RESET_EVENT_SQL = `INSERT INTO events (kind, ring, source, status, summary, payload)
  SELECT 'passkey', NULL, 'factory', 'warn', ?1, ?2 WHERE EXISTS (SELECT 1 FROM passkeys WHERE login = ?3)`;
/** A reset: every passkey of the login, by (login, created_at), read back as it goes. */
export const RESET_SQL = "DELETE FROM passkeys WHERE login = ? RETURNING id, alg, created_at, last_used";
/** …the login's challenges with them, by (login, expires_at): a registration asked for before the reset answers nothing after it. */
export const RESET_CHALLENGES_SQL = "DELETE FROM passkey_challenges WHERE login = ?";
/** …and the login signed out of the browser, by its primary key: the first passkey after a reset is registered on a fresh sign-in with GitHub, never on a session that may have left with the lost device — a registration already under way on it stores nothing (PASSKEY_INSERT_SQL asks for the session). */
export const SIGN_OUT_SQL = "UPDATE contributors SET session_hash = NULL WHERE login = ?";
/**
 * What the lost device may still hold outside the browser goes with the
 * passkeys (#284), each before the delete in the same batch and only while
 * the login still holds one (?1), so two resets at once revoke once. The
 * command line's token: replaced by the primary key with the reset's mark
 * (?2, contributors.ts RESET_TOKEN_MARK and random hex), which no token
 * hashes to — token_hash is NOT NULL and UNIQUE. While it stands, a GitHub
 * token registers the login no new one (POST /factory/register): the person
 * makes it on their page after signing in again.
 */
export const RESET_TOKEN_SQL = "UPDATE contributors SET token_hash = ?2 WHERE login = ?1 AND EXISTS (SELECT 1 FROM passkeys WHERE login = ?1)";
/** …the login's live agent grants — swapped, not revoked, not expired: three at most, through the partial index that holds only those — a journal line each (?2 the words before the agent's name, ?3 who reset, ?4 the record), written before they are revoked… */
export const RESET_GRANT_EVENTS_SQL = `INSERT INTO events (kind, ring, source, status, summary, payload)
  SELECT 'passkey', NULL, 'factory', 'warn', ?2 || agent || ' (' || id || ') revoked', json_object('login', login, 'by', ?3, 'via', 'web', 'action', 'revoke_grant', 'grant', id, 'agent', agent, 'record', ?4)
    FROM agent_grants WHERE login = ?1 AND revoked_at IS NULL AND token_hash IS NOT NULL AND expires_at > ${NOW} AND EXISTS (SELECT 1 FROM passkeys WHERE login = ?1)`;
/** …and revoked, by the same index and read back as they go: `reset`, as a block's say `blocked`. Their waiting drafts are discarded after them (routes/agents.ts DISCARD_SQL), and a code nobody swapped yet is deleted (UNSWAPPED_SQL): swapped after the reset it would be a grant the lost device made. */
export const RESET_GRANTS_SQL = `UPDATE agent_grants SET revoked_at = ${NOW}, revoked_by = 'reset'
  WHERE login = ?1 AND revoked_at IS NULL AND token_hash IS NOT NULL AND expires_at > ${NOW} AND EXISTS (SELECT 1 FROM passkeys WHERE login = ?1) RETURNING id, agent`;

// ---------- challenges ----------

/** A new challenge for the login, for a registration (draft null) or an assertion bound to a draft or an act — replacing the earlier one for the same — or null when five other ceremonies wait already. */
export async function issueChallenge(env: Env, login: string, purpose: "register" | "confirm", draft: string | null): Promise<string | null> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = toB64url(bytes);
  const expires = new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString();
  const [, , ins] = await env.DB.batch([
    env.DB.prepare(CHALLENGE_PRUNE_SQL).bind(login),
    env.DB.prepare(CHALLENGE_REPLACE_SQL).bind(login, purpose, draft),
    env.DB.prepare(CHALLENGE_INSERT_SQL).bind(challenge, login, purpose, draft, expires),
  ]);
  return ins.meta.changes ? challenge : null;
}

/** Whether `challenge` was issued to this login for this purpose (and draft or act), and is still live: taken either way, so it is never good twice. */
export async function takeChallenge(env: Env, challenge: string, login: string, purpose: "register" | "confirm", draft: string | null): Promise<boolean> {
  const row = await env.DB.prepare(CHALLENGE_TAKE_SQL).bind(challenge).first<{ login: string; purpose: string; draft_id: string | null; expires_at: string }>();
  return !!row && row.login === login && row.purpose === purpose && row.draft_id === draft && row.expires_at > new Date().toISOString();
}

/** The challenge a clientDataJSON answers (base64url of 32 bytes), read before anything else is: which row to take. null when it names none. */
export function challengeOf(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== "string" || !clientDataJSON || clientDataJSON.length > 4096) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromB64url(clientDataJSON))) as { challenge?: unknown };
    return typeof c.challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(c.challenge) ? c.challenge : null;
  } catch {
    return null;
  }
}

// ---------- an assertion, checked (a draft's confirmation and the web's acts share it) ----------

/** An assertion as a page posts it: the confirm form's fields, or a JSON body's `assertion` — the same five names. */
export interface AssertionFields {
  credential?: unknown;
  client_data?: unknown;
  authenticator_data?: unknown;
  signature?: unknown;
  user_handle?: unknown;
}

/** Why an assertion was refused, in a word: no passkey at all, none sent, a challenge not for this, a key not the login's (or another relying party's), a counter a racing answer moved first, or the verifier's own code. */
export type AssertionRefusal = { refused: "no_passkey" | "passkey_required" | "challenge" | "not_yours" | "other_rp" | WebAuthnCode; detail?: string };

/** The passkey an act was confirmed with (#271): its id — and, on its first use minutes after its registration (JUST_NOW_MINUTES), that it was registered just now (#287). */
export interface Confirmed {
  passkey: string;
  justNow?: true;
}

/** A passkey's first use, minutes after its registration: the row as the assertion read it, before its use is written. */
const justRegistered = (k: { created_at: string; last_used: string | null }): boolean => k.last_used === null && Date.now() - Date.parse(k.created_at) < JUST_NOW_MINUTES * 60_000;

/** An act's journal words for a passkey registered just now (#287): " with a passkey registered just now", or nothing. */
export const justNowWords = (c: Confirmed): string => (c.justNow ? " with a passkey registered just now" : "");

/**
 * The assertion for one draft or act of this login, verified — the passkey
 * that made it, or why not. The challenge is taken first (issued to this
 * login for exactly this draft or act, five minutes, once); then the
 * passkey by its credential, the login's own and for this relying party;
 * then the assertion (webauthn.ts); then the counter moves forward, or the
 * answer is refused. Nothing sent is `no_passkey` when the login holds none
 * — the way to register one — else `passkey_required`.
 */
async function checkAssertion(env: Env, rp: RelyingParty, login: string, bound: string, f: AssertionFields): Promise<Confirmed | AssertionRefusal> {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const credential = s(f.credential), clientData = s(f.client_data), authData = s(f.authenticator_data), signature = s(f.signature);
  if (!credential || !clientData || !authData || !signature) return { refused: (await env.DB.prepare(HAS_PASSKEY_SQL).bind(login).first()) ? "passkey_required" : "no_passkey" };
  const challenge = challengeOf(clientData);
  if (!challenge || !(await takeChallenge(env, challenge, login, "confirm", bound))) return { refused: "challenge" };
  const key = credential.length <= 1400 ? await env.DB.prepare(PASSKEY_BY_CREDENTIAL_SQL).bind(credential).first<{ id: string; login: string; public_key: string; alg: number; counter: number; rp_id: string; created_at: string; last_used: string | null }>() : null;
  if (!key || key.login !== login) return { refused: "not_yours" };
  if (key.rp_id !== rp.id) return { refused: "other_rp", detail: key.rp_id };
  let counter: number;
  try {
    ({ counter } = await verifyAssertion({ credential, clientDataJSON: clientData, authenticatorData: authData, signature, userHandle: s(f.user_handle) || null }, { challenge, origin: rp.origin, rpId: rp.id }, { publicKey: key.public_key, alg: key.alg, counter: key.counter, userHandle: await userHandleOf(login) }));
  } catch (e) {
    if (e instanceof WebAuthnError) return { refused: e.code, detail: e.message };
    throw e;
  }
  const moved = await env.DB.prepare(PASSKEY_USED_SQL).bind(key.id, counter).run();
  if (!moved.meta.changes) return { refused: "counter" };
  return justRegistered(key) ? { passkey: key.id, justNow: true } : { passkey: key.id };
}

/** A JSON body's `assertion`, as checkAssertion reads it: anything that is not an object is none. */
const assertionIn = (v: unknown): AssertionFields => (v && typeof v === "object" ? (v as AssertionFields) : {});

/** An act's refusal on the web, as JSON (403): the reason in the person's words, what did not happen, and a code a script and a test read; no passkey at all carries the way to register one. */
function refusedAct(r: AssertionRefusal, rp: RelyingParty, login: string, subject: string): Response {
  const { act, nothing } = actOf(subject);
  const why =
    r.refused === "no_passkey" ? `${act} is confirmed with your passkey, and ${login} has none yet: add one on your page (${registerHref(login)}), then press again`
    : r.refused === "passkey_required" ? `${act} is confirmed with your passkey: press it on the pool's page, and your browser asks your device for your fingerprint, face or PIN`
    : r.refused === "challenge" ? `this answer is not for a challenge the pool gave you for ${act}, was used already, or is older than five minutes: press again`
    : r.refused === "not_yours" ? `this passkey is not one of ${login}'s: it was removed, or it is registered to another login`
    : r.refused === "other_rp" ? `this passkey was registered on ${r.detail}, not ${rp.id}`
    : r.refused === "counter" && !r.detail ? "the passkey's counter did not move forward from its last use: a copy of the key may be in use"
    : `the passkey was refused: ${r.detail}`;
  return json({ error: `${why} — ${nothing}`, code: r.refused, ...(r.refused === "no_passkey" ? { register: registerHref(login) } : {}) }, 403, NO_STORE);
}

// ---------- the person ----------

/**
 * The signed-in person in the browser, on an address the relying party list
 * names — or the JSON refusal: a token of any kind (403), nobody (401), an
 * address the list does not name (403), a POST from another page's origin
 * (403), and — `maintainer` — someone who is not a maintainer (403) or is
 * blocked. `holder` is anyone signed in: removing a passkey one holds is
 * theirs whatever their role now (a maintainer once).
 */
async function personOnRp(request: Request, url: URL, env: Env, need: "maintainer" | "holder"): Promise<{ c: Contributor; rp: RelyingParty } | Response> {
  const s = browserSession(request);
  if (s.bearer) return json({ error: "passkeys are registered, used and removed in the browser, with its session: a request that carries an Authorization header is refused", code: "session_only" }, 403, NO_STORE);
  const c = s.session ? await contributorOf(request, env) : null;
  if (!c) return json({ error: SIGN_IN, code: "sign_in" }, 401, NO_STORE);
  const rp = relyingParty(url);
  if (!rp) return json({ error: `passkeys work on ${DASHBOARD_HOST} (and on localhost in development), not on ${url.hostname}`, code: "rp_unavailable" }, 403, NO_STORE);
  // The page's own Origin, as every form of the confirmation checks it (routes/agents.ts sameOrigin); what the authenticator signed is held to the relying party's origin by the verifier.
  if (request.headers.get("origin") !== url.origin) return json({ error: `not from the pool's page: a passkey is registered, used and removed on ${rp.origin}`, code: "origin" }, 403, NO_STORE);
  if (need === "maintainer") {
    const no = maintainerRefusal(c);
    if (no) return no;
  }
  return { c, rp };
}

/** Why someone may not use a passkey for a maintainer's act — register one, approve, block, reset — or null. */
function maintainerRefusal(c: Contributor): Response | null {
  if (!isMaintainer(c)) return json({ error: `a passkey confirms approve and block, which are a maintainer's; ${c.login} is not one (factory/MAINTAINERS.toml)`, code: "maintainer_only" }, 403, NO_STORE);
  if (c.blocked) return json({ error: `${c.login} is blocked by a maintainer${c.blocked.reason ? ": " + c.blocked.reason : ""}`, code: "blocked" }, 403, NO_STORE);
  return null;
}

/** A label as the person gives it: one printable line of 1 to 40 characters — "Passkey" when none. */
export function passkeyLabel(raw: unknown): string | null {
  if (raw !== undefined && raw !== null && typeof raw !== "string") return null;
  const s = (raw ?? "").replace(/\s+/g, " ").trim() || "Passkey";
  return s.length <= 40 && !/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u.test(s) ? s : null;
}

// ---------- the routes ----------

/** POST /auth/passkeys/challenge — what navigator.credentials.create() takes: user verification required, attestation none, the login's passkeys excluded. */
export async function handlePasskeyOptions(url: URL, request: Request, env: Env): Promise<Response> {
  const who = await personOnRp(request, url, env, "maintainer");
  if (who instanceof Response) return who;
  const { c, rp } = who;
  const mine = (await env.DB.prepare(PASSKEYS_SQL).bind(c.login).all<{ credential_id: string }>()).results;
  if (mine.length >= MAX_PASSKEYS) return json({ error: `${c.login} holds ${MAX_PASSKEYS} passkeys: remove one first`, code: "passkey_limit" }, 409, NO_STORE);
  const challenge = await issueChallenge(env, c.login, "register", null);
  if (!challenge) return json({ error: TOO_MANY_CHALLENGES, code: "rate_limited" }, 429, { ...NO_STORE, "retry-after": String(CHALLENGE_MINUTES * 60) });
  return json({
    publicKey: {
      challenge,
      rp: { id: rp.id, name: rp.name },
      user: { id: toB64url(await userHandleOf(c.login)), name: c.login, displayName: c.login },
      pubKeyCredParams: OFFERED_ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
      timeout: CEREMONY_MS,
      attestation: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      excludeCredentials: mine.map((p) => ({ type: "public-key", id: p.credential_id })),
    },
  }, 200, NO_STORE);
}

/**
 * POST /auth/passkeys — the registration: the challenge taken, the answer
 * verified (webauthn.ts), the key stored and the journal's line written in
 * one batch. A login that holds a passkey adds another only with an
 * assertion from one it holds (`assertion`, for `passkey:add`, #271): a
 * session driven by someone else cannot enrol a key of its own. The first
 * stays the session's alone, and the insert holds it so (PASSKEY_INSERT_SQL)
 * — with the session still the login's and the passkey that vouched still
 * held when it runs, so a reset that lands during the ceremony leaves no key
 * behind it.
 */
export async function handlePasskeyRegister(url: URL, request: Request, env: Env): Promise<Response> {
  const who = await personOnRp(request, url, env, "maintainer");
  if (who instanceof Response) return who;
  const { c, rp } = who;
  const b = (await request.json().catch(() => null)) as { label?: unknown; id?: unknown; clientDataJSON?: unknown; attestationObject?: unknown; assertion?: unknown } | null;
  if (!b || typeof b !== "object") return json({ error: "a JSON body: {label, id, clientDataJSON, attestationObject}, as the page sends it" }, 400, NO_STORE);
  const label = passkeyLabel(b.label);
  if (!label) return json({ error: "label: one line of 1 to 40 printable characters", code: "label" }, 400, NO_STORE);
  const challenge = challengeOf(b.clientDataJSON);
  if (!challenge) return json({ error: "clientDataJSON: the browser's own, base64url, with the challenge the pool issued", code: "client_data" }, 400, NO_STORE);
  if (!(await takeChallenge(env, challenge, c.login, "register", null))) {
    return json({ error: "this answer is not for a challenge the pool gave you, was used already, or is older than five minutes: press Add a passkey again", code: "challenge" }, 403, NO_STORE);
  }
  // A second passkey is vouched for by one the login holds (#271); the first has nothing to vouch for it but the session.
  let vouched: string | null = null;
  if (await env.DB.prepare(HAS_PASSKEY_SQL).bind(c.login).first()) {
    const ok = await checkAssertion(env, rp, c.login, "passkey:add", assertionIn(b.assertion));
    if ("refused" in ok) return refusedAct(ok, rp, c.login, "passkey:add");
    vouched = ok.passkey;
  }
  let reg;
  try {
    reg = await verifyRegistration({ id: String(b.id ?? ""), clientDataJSON: String(b.clientDataJSON), attestationObject: String(b.attestationObject ?? "") }, { challenge, origin: rp.origin, rpId: rp.id });
  } catch (e) {
    if (e instanceof WebAuthnError) return json({ error: `the passkey was not registered: ${e.message}`, code: e.code }, 400, NO_STORE);
    throw e;
  }
  const id = `pk_${randomHex(16)}`;
  const alg = ALGORITHMS[reg.alg];
  // The session that asked, as the insert checks it is still the login's: a reset that landed during the ceremony signed it out (#271).
  const session = await sha256Hex(browserSession(request).session ?? "");
  const [ins] = await env.DB.batch([
    env.DB.prepare(PASSKEY_INSERT_SQL).bind(id, c.login, reg.credentialId, reg.publicKey, reg.alg, rp.id, reg.counter, label, vouched, session),
    env.DB.prepare(PASSKEY_EVENT_SQL).bind("ok", `${c.login} registered a passkey (${alg}, ${id})`, JSON.stringify({ login: c.login, by: c.login, via: "web", action: "register", passkey: id, alg, rp: rp.id, ...(vouched ? { confirmed_with: vouched } : {}) }), id, c.login),
  ]);
  if (!ins.meta.changes) {
    const taken = await env.DB.prepare(PASSKEY_BY_CREDENTIAL_SQL).bind(reg.credentialId).first();
    if (taken) return json({ error: "this passkey is registered already", code: "passkey_exists" }, 409, NO_STORE);
    // Signed out while the ceremony ran — another maintainer's reset, or a sign-out: the session that asked is not the login's any more, and nothing it started is stored.
    if ((await contributorOf(request, env))?.login !== c.login) return json({ error: `${c.login} was signed out while the passkey was being added — a reset of the login's passkeys, or a sign-out: sign in with GitHub again, then add it — no passkey was added`, code: "sign_in" }, 401, NO_STORE);
    if (vouched) {
      // The passkey that vouched went meanwhile (removed, or reset): it vouches for nothing.
      if (!(await env.DB.prepare(OWN_PASSKEY_SQL).bind(vouched, c.login).first())) return refusedAct({ refused: "not_yours" }, rp, c.login, "passkey:add");
    } else if (await env.DB.prepare(HAS_PASSKEY_SQL).bind(c.login).first()) {
      // Not vouched for, and the login holds one now: another first registration landed a moment before this one.
      return refusedAct({ refused: "passkey_required" }, rp, c.login, "passkey:add");
    }
    return json({ error: `${c.login} holds ${MAX_PASSKEYS} passkeys: remove one first`, code: "passkey_limit" }, 409, NO_STORE);
  }
  return json({ passkey: { id, label, alg, counter: reg.counter, created_at: new Date().toISOString() }, ...(vouched ? { confirmed_with: vouched } : {}), note: "Approve and block — on the web, and the drafts of your agents — are confirmed with it from now on." }, 201, NO_STORE);
}

/**
 * POST /auth/passkeys/:id/remove — the person's own passkey, with an
 * assertion from one they hold (`assertion`, for `passkey:remove:<id>`,
 * #271) — the one going, or another — and the journal's line, in one
 * batch: nobody else's, whatever their role. A lost only passkey is a
 * reset's (below).
 */
export async function handlePasskeyRemove(id: string, url: URL, request: Request, env: Env): Promise<Response> {
  const who = await personOnRp(request, url, env, "holder");
  if (who instanceof Response) return who;
  const { c, rp } = who;
  const row = await env.DB.prepare(OWN_PASSKEY_SQL).bind(id, c.login).first<{ id: string; alg: number; created_at: string }>();
  if (!row) return json({ error: `${id} is not a passkey of ${c.login}'s`, code: "not_found" }, 404, NO_STORE);
  const b = (await request.json().catch(() => null)) as { assertion?: unknown } | null;
  const subject = `passkey:remove:${id}`;
  const ok = await checkAssertion(env, rp, c.login, subject, assertionIn(b?.assertion));
  if ("refused" in ok) return refusedAct(ok, rp, c.login, subject);
  const alg = ALGORITHMS[row.alg] ?? String(row.alg);
  const [, del] = await env.DB.batch([
    env.DB.prepare(PASSKEY_EVENT_SQL).bind("warn", `${c.login} removed a passkey (${alg}, ${id}, registered ${row.created_at.slice(0, 10)})`, JSON.stringify({ login: c.login, by: c.login, via: "web", action: "remove", passkey: id, alg, registered_at: row.created_at, confirmed_with: ok.passkey }), id, c.login),
    env.DB.prepare(PASSKEY_REMOVE_SQL).bind(id, c.login),
  ]);
  if (!del.meta.changes) return json({ error: `${id} is not a passkey of ${c.login}'s`, code: "not_found" }, 404, NO_STORE);
  return json({ removed: id, by: c.login, confirmed_with: ok.passkey }, 200, NO_STORE);
}

/**
 * POST /auth/passkeys/assert — {for}: the options navigator.credentials.get()
 * takes for one act of the signed-in person's on the web (#271, SUBJECT): a
 * challenge bound to this login and this act, their passkeys, user
 * verification required. Approve, block, a reset and a forced promotion
 * (#284) are a maintainer's; adding a passkey too; removing one is anyone's
 * who holds it. A login
 * without a passkey is told to register one, with the link; its first is
 * added without one (409). Nobody resets their own: that is another
 * maintainer's act, so a stolen session cannot open its own way back; and a
 * login that holds none has nothing to reset (409), said before the
 * resetting maintainer's device is asked.
 */
export async function handlePasskeyAssert(url: URL, request: Request, env: Env): Promise<Response> {
  const who = await personOnRp(request, url, env, "holder");
  if (who instanceof Response) return who;
  const { c, rp } = who;
  const b = (await request.json().catch(() => null)) as { for?: unknown } | null;
  const subject = typeof b?.for === "string" && SUBJECT.test(b.for) ? b.for : null;
  if (!subject) return json({ error: "for: the act the passkey confirms — approve:<task>, block:package:<name>, block:contributor:<login>, passkey:add, passkey:remove:<id>, passkey:reset:<login>, promote:force:<from>:<to>[:<arch>], host:resume:<host>, host:retire:<host>, host:cause:<login> or host:resume-all:<login>", code: "for" }, 400, NO_STORE);
  if (!subject.startsWith("passkey:remove:")) {
    const no = maintainerRefusal(c);
    if (no) return no;
  }
  if (subject === `passkey:reset:${c.login}`) return json({ error: SELF_RESET, code: "second_maintainer" }, 403, NO_STORE);
  if (subject === `host:cause:${c.login}`) return json({ error: SELF_CAUSE, code: "second_maintainer" }, 403, NO_STORE);
  // A login that holds no passkey has nothing to reset: said before the resetting maintainer answers their device, not after.
  const target = subject.startsWith("passkey:reset:") ? subject.slice("passkey:reset:".length) : null;
  if (target && !(await env.DB.prepare(HAS_PASSKEY_SQL).bind(target).first())) return nothingToReset(target);
  const { act, nothing } = actOf(subject);
  if (subject === "passkey:add" && !(await env.DB.prepare(HAS_PASSKEY_SQL).bind(c.login).first())) {
    return json({ error: `${c.login} holds no passkey yet: the first is added with your session alone, with nothing to ask`, code: "first_passkey" }, 409, NO_STORE);
  }
  return assertionOptions(env, rp, c.login, subject, { none: `${act} is confirmed with your passkey, and ${c.login} has none yet: add one on your page (${registerHref(c.login)}), then press again — ${nothing}`, busy: `${TOO_MANY_CHALLENGES} — ${nothing}` });
}

/** Why nobody removes themselves for cause (#322): another maintainer's act, like a reset. */
export const SELF_CAUSE = "nobody removes themselves for cause: another maintainer does, with their passkey and a reason on the record";
/** Why nobody resets their own passkeys, in their words. */
const SELF_RESET = "nobody resets their own passkeys: another maintainer does, with a reason on the record — so a session that left with a lost device cannot open its own way back";
/** A reset of a login that holds no passkey: the options refuse it before the ceremony, and the reset itself when the last one went since. */
const nothingToReset = (login: string): Response => json({ error: `${login} holds no passkey: there is nothing to reset — their next one is added with their session alone`, code: "nothing_to_reset" }, 409, NO_STORE);

const stamp = (): string => new Date().toISOString().replace(/[-:.Z]/g, "");

/**
 * POST /auth/passkeys/reset — {login, reason, assertion}: the way back for a
 * maintainer who lost their only authenticator (#271). Another maintainer —
 * never the login itself — confirms it with their own passkey (for
 * `passkey:reset:<login>`) and writes why. In one batch: the journal's line
 * (who, whose, why, which passkeys), every passkey of the login, its
 * challenges, and its browser session — so its next passkey, the first
 * again and the session's alone, is registered after a fresh sign-in with
 * GitHub — and what else the lost device may hold (#284): the login's
 * `omc_` token and its agents' live grants, revoked with a journal line
 * each, their waiting drafts discarded and a code nobody swapped deleted.
 * The person makes a new token on their page after signing in, and grants
 * their agents again. Then the record, signed by the pool, at
 * contributors/<login>/passkeys-reset-<time>.json, whose address the lines
 * name; a record the bucket refused is said in the answer and on a line of
 * its own, the reset standing. Never an operator's write to D1.
 */
export async function handlePasskeyReset(url: URL, request: Request, env: Env): Promise<Response> {
  const who = await personOnRp(request, url, env, "maintainer");
  if (who instanceof Response) return who;
  const { c, rp } = who;
  const b = (await request.json().catch(() => null)) as { login?: unknown; reason?: unknown; assertion?: unknown } | null;
  const login = typeof b?.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(b.login) ? b.login : null;
  if (!login) return json({ error: "login: the GitHub login whose passkeys are reset", code: "login" }, 400, NO_STORE);
  if (login === c.login) return json({ error: SELF_RESET, code: "second_maintainer" }, 403, NO_STORE);
  const reason = typeof b?.reason === "string" ? b.reason.replace(/\s+/g, " ").trim() : "";
  if (reason.length < RESET_REASON.min || reason.length > RESET_REASON.max || /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u.test(reason)) {
    return json({ error: `reason: why, in ${RESET_REASON.min} to ${RESET_REASON.max} printable characters — it goes on the public journal and the signed record`, code: "reason" }, 400, NO_STORE);
  }
  const held = (await env.DB.prepare(PASSKEYS_SQL).bind(login).all<{ id: string }>()).results;
  if (!held.length) return nothingToReset(login);
  const subject = `passkey:reset:${login}`;
  const ok = await checkAssertion(env, rp, c.login, subject, assertionIn(b?.assertion));
  if ("refused" in ok) return refusedAct(ok, rp, c.login, subject);
  const at = new Date().toISOString();
  const key = `contributors/${login}/passkeys-reset-${stamp()}.json`, address = recordUrl(env, key);
  const ids = held.map((k) => k.id);
  const said = `${c.login} reset ${login}'s passkeys`;
  const [line, , , revoked, , , , del] = await env.DB.batch([
    env.DB.prepare(RESET_EVENT_SQL).bind(`${said} (${ids.length} removed; ${login} signed out): ${reason.slice(0, 140)}`, JSON.stringify({ login, by: c.login, via: "web", action: "reset", passkeys: ids, reason, confirmed_with: ok.passkey, signed_out: true, record: address }), login),
    // What the lost device may hold outside the browser (#284): the command line's token and the agents' grants, a line each, before the passkeys go.
    env.DB.prepare(RESET_EVENT_SQL).bind(`${said}: ${login}'s command-line token revoked`, JSON.stringify({ login, by: c.login, via: "web", action: "revoke_token", record: address }), login),
    env.DB.prepare(RESET_GRANT_EVENTS_SQL).bind(login, `${said}: the grant to `, c.login, address),
    env.DB.prepare(RESET_GRANTS_SQL).bind(login),
    env.DB.prepare(DISCARD_SQL).bind(login, JSON.stringify({ error: `${login}'s passkeys were reset by ${c.login}: the agent's grant ended, and nothing was decided` })),
    env.DB.prepare(UNSWAPPED_SQL).bind(login),
    env.DB.prepare(RESET_TOKEN_SQL).bind(login, `${RESET_TOKEN_MARK}${randomHex(16)}`),
    env.DB.prepare(RESET_SQL).bind(login),
    env.DB.prepare(RESET_CHALLENGES_SQL).bind(login),
    env.DB.prepare(SIGN_OUT_SQL).bind(login),
  ]);
  const removed = del.results as { id: string; alg: number; created_at: string; last_used: string | null }[];
  // Two resets sent at once: the second found nothing left, wrote no line, and says so.
  if (!line.meta.changes || !removed.length) return json({ error: `${login}'s passkeys were reset a moment ago: there is nothing left to reset`, code: "nothing_to_reset" }, 409, NO_STORE);
  const passkeys = removed.map((k) => ({ id: k.id, alg: ALGORITHMS[k.alg] ?? String(k.alg), created_at: k.created_at, last_used: k.last_used }));
  const grants = (revoked.results as { id: string; agent: string }[]).map((g) => ({ id: g.id, agent: g.agent }));
  let record: string | null = address, recordError: string | undefined;
  try {
    await putRecord(env, key, { schema: "omarchy-pool/passkey-reset/1", login, by: c.login, via: "web", at, reason, passkeys, confirmed_with: ok.passkey, signed_out: true, token_revoked: true, grants_revoked: grants });
  } catch (e) {
    record = null;
    recordError = String(e instanceof Error ? e.message : e).slice(0, 200);
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('passkey', NULL, 'factory', 'error', ?, ?)")
      .bind(`the record of ${c.login}'s reset of ${login}'s passkeys was not written: ${recordError}`, JSON.stringify({ login, by: c.login, action: "reset", record: null, record_error: recordError }))
      .run();
  }
  return json({ reset: login, by: c.login, at, reason, passkeys, confirmed_with: ok.passkey, signed_out: true, token_revoked: true, grants_revoked: grants, record, ...(recordError ? { record_error: recordError } : {}) }, 200, NO_STORE);
}

// ---------- the web's approve and block (#271): routes/review.ts and routes/blocks.ts call them ----------

/** The door's half of an act a passkey confirms: given the assertion the page put in the body, the passkey that made it — or the JSON refusal. */
export type PasskeyGate = (assertion: unknown) => Promise<Confirmed | Response>;

/**
 * The web's own approve and block (#271): the browser's session only — a
 * request with an Authorization header is refused, so no token of any kind
 * approves or blocks, a maintainer's `omc_` included — from its page's
 * Origin, on an address the relying party list names, with an assertion
 * for a challenge issued to this login for exactly this act (`subject`:
 * `approve:<task>`, `block:package:<name>`, `block:contributor:<login>`,
 * and since #284 `promote:force:<from>:<to>[:<arch>]`, jobs.ts). The
 * handler runs it once its own predicate allowed the act and before it
 * writes anything (decidedWith), so a refusal of the act is said first and
 * in the same words as anywhere else.
 */
export function webGate(request: Request, url: URL, env: Env, login: string, subject: string): PasskeyGate {
  // The door's words: approve and block, or a promotion forced past its evidence (#284).
  const [are, nothing] = subject.startsWith("promote:") ? ["a promotion forced past its evidence is", "nothing was queued"]
    : subject.startsWith("host:") ? ["a host's resume and retirement, and a removal for cause, are", "nothing changed"]
    : ["approve and block are", "nothing was decided"];
  return async (assertion) => {
    if (browserSession(request).bearer) {
      return json({ error: `${are} confirmed in the browser, with its session and your passkey: a request that carries an Authorization header — a contributor's token, a script's — is refused; ${nothing}`, code: "session_only" }, 403, NO_STORE);
    }
    const rp = relyingParty(url);
    if (!rp) return json({ error: `${are} confirmed with a passkey, which works on ${DASHBOARD_HOST} (and on localhost in development), not on ${url.hostname}; ${nothing}`, code: "rp_unavailable" }, 403, NO_STORE);
    if (request.headers.get("origin") !== url.origin) return json({ error: `not from the pool's page: ${are} confirmed on ${rp.origin}; ${nothing}`, code: "origin" }, 403, NO_STORE);
    const ok = await checkAssertion(env, rp, login, subject, assertionIn(assertion));
    return "refused" in ok ? refusedAct(ok, rp, login, subject) : ok;
  };
}

/**
 * The passkey an approve or a block is decided with, whoever calls its
 * handler (#271): an agent's draft confirmed with one in the browser
 * (through.passkey, routes/agents.ts), or the web's own act with its
 * assertion (the door's gate) — which says too when the passkey was
 * registered just now (#287). A caller with neither is refused — fail
 * closed: a door that forgets the gate decides nothing.
 */
export async function decidedWith(through: Through | undefined, gate: PasskeyGate | undefined, assertion: unknown): Promise<Confirmed | Response> {
  if (through?.passkey) return { passkey: through.passkey };
  if (!gate) return json({ error: "approve and block are confirmed with a passkey, and this door asks for none: nothing was decided", code: "passkey_required" }, 403, NO_STORE);
  return gate(assertion);
}

// ---------- the confirmation's two halves (routes/agents.ts calls them) ----------

/**
 * The options navigator.credentials.get() takes for one draft or act of the
 * login: the challenge bound to the two, the login's passkeys, user
 * verification required. `words`: the refusals in the voice of the door
 * that asks — the draft's page by default.
 */
export async function assertionOptions(env: Env, rp: RelyingParty, login: string, bound: string, words: { none: string; busy: string } = { none: `${NO_PASSKEY} Nothing was decided.`, busy: `${TOO_MANY_CHALLENGES} Nothing was decided.` }): Promise<Response> {
  const keys = (await env.DB.prepare(PASSKEYS_SQL).bind(login).all<{ credential_id: string }>()).results;
  if (!keys.length) return json({ error: words.none, code: "no_passkey", register: registerHref(login) }, 403, NO_STORE);
  const challenge = await issueChallenge(env, login, "confirm", bound);
  if (!challenge) return json({ error: words.busy, code: "rate_limited" }, 429, { ...NO_STORE, "retry-after": String(CHALLENGE_MINUTES * 60) });
  return json({ publicKey: { challenge, rpId: rp.id, timeout: CEREMONY_MS, userVerification: "required", allowCredentials: keys.map((k) => ({ type: "public-key", id: k.credential_id })) } }, 200, NO_STORE);
}

export type PasskeyRefusal = { refused: true; status: number; heading: string; text: string; register?: boolean };

/**
 * The passkey a confirmation of approve or block was made with, verified —
 * or why not, in the page's words, with nothing decided and the draft still
 * waiting. The form's fields are the assertion the page's script put there
 * (credential, client_data, authenticator_data, signature, user_handle),
 * checked for this login and this draft (checkAssertion).
 */
export async function confirmPasskey(env: Env, url: URL, login: string, draft: string, form: URLSearchParams): Promise<Confirmed | PasskeyRefusal> {
  const no = (text: string, heading = "The passkey was refused", status = 403): PasskeyRefusal => ({ refused: true, status, heading, text });
  const rp = relyingParty(url);
  if (!rp) return no(`${PASSKEY_ELSEWHERE} Nothing was decided.`, "Not on this address");
  const got = await checkAssertion(env, rp, login, draft, { credential: form.get("credential"), client_data: form.get("client_data"), authenticator_data: form.get("authenticator_data"), signature: form.get("signature"), user_handle: form.get("user_handle") });
  if (!("refused" in got)) return got;
  if (got.refused === "no_passkey") return { ...no(`${NO_PASSKEY} Nothing was decided.`, "Register a passkey first"), register: true };
  if (got.refused === "passkey_required") return no("Approve and block are confirmed with your passkey: press Confirm on the draft's page, then answer your device with your fingerprint, face or PIN. Nothing was decided.", "Confirm with your passkey");
  if (got.refused === "challenge") return no("This answer is not for a challenge the pool gave you for this draft, was used already, or is older than five minutes: press Confirm again. Nothing was decided.", "Press Confirm again");
  if (got.refused === "not_yours") return no(`This passkey is not one of ${login}'s: it was removed, or it is registered to another login. Nothing was decided.`, "Not your passkey");
  if (got.refused === "other_rp") return no(`This passkey was registered on ${got.detail}, not ${rp.id}. Nothing was decided.`, "Not your passkey");
  if (got.refused === "counter" && !got.detail) return no("The passkey's counter did not move forward from its last use: a copy of the key may be in use. Nothing was decided.");
  const said = got.detail ?? got.refused;
  return no(`${said.charAt(0).toUpperCase()}${said.slice(1)}. Nothing was decided.`);
}
