/**
 * Passkeys (#257; docs: worker/src/docs/omarchy-cli-mcp.md, *A passkey for
 * approve and block*). A maintainer registers a passkey on their own page,
 * and confirming an agent's draft of approve or block asks for it: a
 * WebAuthn assertion with user verification — a touch and a PIN or a
 * biometric that the agent's software cannot supply — verified here against
 * the key stored at registration (webauthn.ts, with WebCrypto).
 *
 *   POST /auth/passkeys/challenge     the options navigator.credentials.create() takes, for a maintainer
 *   POST /auth/passkeys               {label, id, clientDataJSON, attestationObject}: the passkey, registered and journaled
 *   POST /auth/passkeys/:id/remove    the person's own passkey removed, journaled
 *   POST /auth/confirm/:id/challenge  the options navigator.credentials.get() takes for one draft (routes/agents.ts)
 *
 * Each takes the browser's session only — a request with an Authorization
 * header is refused, so no token of any kind registers a key — posted from
 * the page's own origin (the Origin header, as the confirmation's forms). The
 * relying party — the RP id and the origin a ceremony must have run on —
 * comes from one list, never from what a request says it is: the dashboard's
 * name in production (every production name serves it: the pages redirect
 * to it), localhost in wrangler dev and the tests (WebAuthn takes no IP
 * address and needs a secure context, which localhost is). Anywhere else a
 * passkey is not offered, and approve and block cannot be confirmed there.
 *
 * A challenge is issued for one purpose — a registration of the login, or
 * the confirmation of one draft of the login — lives five minutes, and is
 * deleted by the statement that takes it, whatever the answer turns out to
 * be: an answer is good for one request. The pool stores the credential's
 * id, its public key, the algorithm, the RP id, the counter, a label and
 * two dates; nothing of the authenticator's attestation.
 */
import { json, type Env } from "../index";
import { DASHBOARD_HOST, isProductionHost } from "../meta";
import { browserSession, randomHex } from "../agents";
import { contributorOf, SIGN_IN, type Contributor } from "./contributors";
import { ALGORITHMS, OFFERED_ALGORITHMS, WebAuthnError, fromB64url, sha256, toB64url, verifyAssertion, verifyRegistration } from "../webauthn";
import { NO_PASSKEY, PASSKEY_ELSEWHERE } from "../pages/agent-auth";

/** Passkeys a login holds at most: an eleventh is refused until one is removed. */
export const MAX_PASSKEYS = 10;
/** A challenge's life: the browser's ceremony (two minutes) and time to spare. */
export const CHALLENGE_MINUTES = 5;
/** Challenges a login holds live at most: a sixth is refused until one is taken or expires. */
export const LIVE_CHALLENGES = 5;
/** How long the browser waits for the authenticator. */
export const CEREMONY_MS = 120_000;
/** The verdicts confirmed with a passkey: the two that change what users get. Request changes and reject keep the session and, for reject, the name typed. */
export const PASSKEY_VERDICTS: readonly string[] = ["approve", "block"];

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


// ---------- the statements (every one through an index: agent-tools and passkeys tests ask each for its plan) ----------

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** A login's passkeys, newest first, by (login, created_at): ten at most, the cap. */
export const PASSKEYS_SQL = `SELECT id, credential_id, alg, label, counter, created_at, last_used FROM passkeys WHERE login = ? ORDER BY created_at DESC LIMIT ${MAX_PASSKEYS}`;
/** Whether a login holds a passkey at all: one entry of (login, created_at). */
export const HAS_PASSKEY_SQL = "SELECT 1 AS one FROM passkeys WHERE login = ? LIMIT 1";
/** A passkey by the credential that answered: the unique index on its id. */
export const PASSKEY_BY_CREDENTIAL_SQL = "SELECT id, login, public_key, alg, counter, rp_id FROM passkeys WHERE credential_id = ?";
/** A login's own passkey by its id (primary key), for its removal. */
export const OWN_PASSKEY_SQL = "SELECT id, alg, created_at FROM passkeys WHERE id = ? AND login = ?";
/** A registration: inserted only while the login holds fewer than ten, and only a credential not registered already. */
export const PASSKEY_INSERT_SQL = `INSERT INTO passkeys (id, login, credential_id, public_key, alg, rp_id, counter, label)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
   WHERE (SELECT COUNT(*) FROM passkeys WHERE login = ?2) < ${MAX_PASSKEYS} AND NOT EXISTS (SELECT 1 FROM passkeys WHERE credential_id = ?3)`;
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
/** A challenge issued, only while the login holds fewer than five live ones. */
export const CHALLENGE_INSERT_SQL = `INSERT INTO passkey_challenges (challenge, login, purpose, draft_id, expires_at)
  SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT COUNT(*) FROM passkey_challenges WHERE login = ?2 AND expires_at > ${NOW}) < ${LIVE_CHALLENGES}`;
/** A challenge taken — deleted by its primary key and read back in the same statement: whatever the answer turns out to be, it is good once. */
export const CHALLENGE_TAKE_SQL = "DELETE FROM passkey_challenges WHERE challenge = ? RETURNING login, purpose, draft_id, expires_at";
/** Every login's expired challenges, for the weekly gc. */
export const EXPIRED_CHALLENGES_SQL = `DELETE FROM passkey_challenges WHERE expires_at < ${NOW}`;

// ---------- challenges ----------

/** A new challenge for the login, for a registration (draft null) or one draft's confirmation; null when five wait already. */
export async function issueChallenge(env: Env, login: string, purpose: "register" | "confirm", draft: string | null): Promise<string | null> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = toB64url(bytes);
  const expires = new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString();
  const [, ins] = await env.DB.batch([
    env.DB.prepare(CHALLENGE_PRUNE_SQL).bind(login),
    env.DB.prepare(CHALLENGE_INSERT_SQL).bind(challenge, login, purpose, draft, expires),
  ]);
  return ins.meta.changes ? challenge : null;
}

/** Whether `challenge` was issued to this login for this purpose (and draft), and is still live: taken either way, so it is never good twice. */
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

// ---------- the person ----------

/**
 * The signed-in person in the browser, on an address the relying party list
 * names — or the JSON refusal: a token of any kind (403), nobody (401), an
 * address the list does not name (403), a POST from another page's origin
 * (403), and for a registration someone who is not a maintainer (403) or is
 * blocked.
 */
async function personOnRp(request: Request, url: URL, env: Env, registering: boolean): Promise<{ c: Contributor; rp: RelyingParty } | Response> {
  const s = browserSession(request);
  if (s.bearer) return json({ error: "passkeys are registered and removed in the browser, with its session: a request that carries an Authorization header is refused", code: "session_only" }, 403, NO_STORE);
  const c = s.session ? await contributorOf(request, env) : null;
  if (!c) return json({ error: SIGN_IN, code: "sign_in" }, 401, NO_STORE);
  const rp = relyingParty(url);
  if (!rp) return json({ error: `passkeys work on ${DASHBOARD_HOST} (and on localhost in development), not on ${url.hostname}`, code: "rp_unavailable" }, 403, NO_STORE);
  // The page's own Origin, as every form of the confirmation checks it (routes/agents.ts sameOrigin); what the authenticator signed is held to the relying party's origin by the verifier.
  if (request.headers.get("origin") !== url.origin) return json({ error: `not from the pool's page: a passkey is registered and removed on ${rp.origin}`, code: "origin" }, 403, NO_STORE);
  if (registering && c.role !== "maintainer") return json({ error: `a passkey confirms the approve and block an agent drafts, which are a maintainer's; ${c.login} is not one (factory/MAINTAINERS.toml)`, code: "maintainer_only" }, 403, NO_STORE);
  if (registering && c.blocked) return json({ error: `${c.login} is blocked by a maintainer${c.blocked.reason ? ": " + c.blocked.reason : ""}`, code: "blocked" }, 403, NO_STORE);
  return { c, rp };
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
  const who = await personOnRp(request, url, env, true);
  if (who instanceof Response) return who;
  const { c, rp } = who;
  const mine = (await env.DB.prepare(PASSKEYS_SQL).bind(c.login).all<{ credential_id: string }>()).results;
  if (mine.length >= MAX_PASSKEYS) return json({ error: `${c.login} holds ${MAX_PASSKEYS} passkeys: remove one first`, code: "passkey_limit" }, 409, NO_STORE);
  const challenge = await issueChallenge(env, c.login, "register", null);
  if (!challenge) return json({ error: `${LIVE_CHALLENGES} passkey requests of ${c.login}'s wait already: finish one, or wait ${CHALLENGE_MINUTES} minutes`, code: "rate_limited" }, 429, { ...NO_STORE, "retry-after": String(CHALLENGE_MINUTES * 60) });
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

/** POST /auth/passkeys — the registration: the challenge taken, the answer verified (webauthn.ts), the key stored and the journal's line written in one batch. */
export async function handlePasskeyRegister(url: URL, request: Request, env: Env): Promise<Response> {
  const who = await personOnRp(request, url, env, true);
  if (who instanceof Response) return who;
  const { c, rp } = who;
  const b = (await request.json().catch(() => null)) as { label?: unknown; id?: unknown; clientDataJSON?: unknown; attestationObject?: unknown } | null;
  if (!b || typeof b !== "object") return json({ error: "a JSON body: {label, id, clientDataJSON, attestationObject}, as the page sends it" }, 400, NO_STORE);
  const label = passkeyLabel(b.label);
  if (!label) return json({ error: "label: one line of 1 to 40 printable characters", code: "label" }, 400, NO_STORE);
  const challenge = challengeOf(b.clientDataJSON);
  if (!challenge) return json({ error: "clientDataJSON: the browser's own, base64url, with the challenge the pool issued", code: "client_data" }, 400, NO_STORE);
  if (!(await takeChallenge(env, challenge, c.login, "register", null))) {
    return json({ error: "this answer is not for a challenge the pool gave you, was used already, or is older than five minutes: press Add a passkey again", code: "challenge" }, 403, NO_STORE);
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
  const [ins] = await env.DB.batch([
    env.DB.prepare(PASSKEY_INSERT_SQL).bind(id, c.login, reg.credentialId, reg.publicKey, reg.alg, rp.id, reg.counter, label),
    env.DB.prepare(PASSKEY_EVENT_SQL).bind("ok", `${c.login} registered a passkey (${alg}, ${id})`, JSON.stringify({ login: c.login, by: c.login, via: "web", action: "register", passkey: id, alg, rp: rp.id }), id, c.login),
  ]);
  if (!ins.meta.changes) {
    const taken = await env.DB.prepare(PASSKEY_BY_CREDENTIAL_SQL).bind(reg.credentialId).first();
    return json(taken ? { error: "this passkey is registered already", code: "passkey_exists" } : { error: `${c.login} holds ${MAX_PASSKEYS} passkeys: remove one first`, code: "passkey_limit" }, 409, NO_STORE);
  }
  return json({ passkey: { id, label, alg, counter: reg.counter, created_at: new Date().toISOString() }, note: "Approve and block drafted by your agents are confirmed with it from now on." }, 201, NO_STORE);
}

/** POST /auth/passkeys/:id/remove — the person's own passkey, and the journal's line, in one batch: nobody else's, whatever their role. */
export async function handlePasskeyRemove(id: string, url: URL, request: Request, env: Env): Promise<Response> {
  const who = await personOnRp(request, url, env, false);
  if (who instanceof Response) return who;
  const { c } = who;
  const row = await env.DB.prepare(OWN_PASSKEY_SQL).bind(id, c.login).first<{ id: string; alg: number; created_at: string }>();
  if (!row) return json({ error: `${id} is not a passkey of ${c.login}'s`, code: "not_found" }, 404, NO_STORE);
  const alg = ALGORITHMS[row.alg] ?? String(row.alg);
  const [, del] = await env.DB.batch([
    env.DB.prepare(PASSKEY_EVENT_SQL).bind("warn", `${c.login} removed a passkey (${alg}, ${id}, registered ${row.created_at.slice(0, 10)})`, JSON.stringify({ login: c.login, by: c.login, via: "web", action: "remove", passkey: id, alg, registered_at: row.created_at }), id, c.login),
    env.DB.prepare(PASSKEY_REMOVE_SQL).bind(id, c.login),
  ]);
  if (!del.meta.changes) return json({ error: `${id} is not a passkey of ${c.login}'s`, code: "not_found" }, 404, NO_STORE);
  return json({ removed: id, by: c.login }, 200, NO_STORE);
}

// ---------- the confirmation's two halves (routes/agents.ts calls them) ----------

/** The options navigator.credentials.get() takes for one draft of the login: the challenge bound to the two, the login's passkeys, user verification required. */
export async function assertionOptions(env: Env, rp: RelyingParty, login: string, draft: string): Promise<Response> {
  const keys = (await env.DB.prepare(PASSKEYS_SQL).bind(login).all<{ credential_id: string }>()).results;
  if (!keys.length) return json({ error: NO_PASSKEY, code: "no_passkey", register: registerHref(login) }, 403, NO_STORE);
  const challenge = await issueChallenge(env, login, "confirm", draft);
  if (!challenge) return json({ error: `${LIVE_CHALLENGES} passkey requests of ${login}'s wait already: finish one, or wait ${CHALLENGE_MINUTES} minutes`, code: "rate_limited" }, 429, { ...NO_STORE, "retry-after": String(CHALLENGE_MINUTES * 60) });
  return json({ publicKey: { challenge, rpId: rp.id, timeout: CEREMONY_MS, userVerification: "required", allowCredentials: keys.map((k) => ({ type: "public-key", id: k.credential_id })) } }, 200, NO_STORE);
}

export type PasskeyRefusal = { refused: true; status: number; heading: string; text: string; register?: boolean };

/**
 * The passkey a confirmation of approve or block was made with, verified —
 * or why not, in the page's words, with nothing decided and the draft still
 * waiting. The form's fields are the assertion the page's script put there
 * (credential, client_data, authenticator_data, signature, user_handle).
 * The challenge is taken first (bound to this login and draft, five
 * minutes, once); then the passkey by its credential, the login's own and
 * for this relying party; then the assertion (webauthn.ts); then the
 * counter moves forward, or the answer is refused.
 */
export async function confirmPasskey(env: Env, url: URL, login: string, draft: string, form: URLSearchParams): Promise<{ passkey: string } | PasskeyRefusal> {
  const no = (text: string, heading = "The passkey was refused", status = 403): PasskeyRefusal => ({ refused: true, status, heading, text });
  const rp = relyingParty(url);
  if (!rp) return no(PASSKEY_ELSEWHERE, "Not on this address");
  const credential = form.get("credential") ?? "", clientData = form.get("client_data") ?? "", authData = form.get("authenticator_data") ?? "", signature = form.get("signature") ?? "";
  if (!credential || !clientData || !authData || !signature) {
    if (!(await env.DB.prepare(HAS_PASSKEY_SQL).bind(login).first())) return { ...no(NO_PASSKEY, "Register a passkey first"), register: true };
    return no("Approve and block are confirmed with your passkey: press Confirm on the draft's page and answer your browser — a touch and a PIN or a biometric. Nothing was decided.", "Confirm with your passkey");
  }
  const challenge = challengeOf(clientData);
  if (!challenge || !(await takeChallenge(env, challenge, login, "confirm", draft))) {
    return no("This answer is not for a challenge the pool gave you for this draft, was used already, or is older than five minutes: press Confirm again. Nothing was decided.", "Press Confirm again");
  }
  const key = credential.length <= 1400 ? await env.DB.prepare(PASSKEY_BY_CREDENTIAL_SQL).bind(credential).first<{ id: string; login: string; public_key: string; alg: number; counter: number; rp_id: string }>() : null;
  if (!key || key.login !== login) return no(`This passkey is not one of ${login}'s: it was removed, or it is registered to another login. Nothing was decided.`, "Not your passkey");
  if (key.rp_id !== rp.id) return no(`This passkey was registered on ${key.rp_id}, not ${rp.id}. Nothing was decided.`, "Not your passkey");
  let counter: number;
  try {
    ({ counter } = await verifyAssertion({ credential, clientDataJSON: clientData, authenticatorData: authData, signature, userHandle: form.get("user_handle") }, { challenge, origin: rp.origin, rpId: rp.id }, { publicKey: key.public_key, alg: key.alg, counter: key.counter, userHandle: await userHandleOf(login) }));
  } catch (e) {
    if (e instanceof WebAuthnError) return no(`${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}. Nothing was decided.`);
    throw e;
  }
  const moved = await env.DB.prepare(PASSKEY_USED_SQL).bind(key.id, counter).run();
  if (!moved.meta.changes) return no("The passkey's counter did not move forward from its last use: a copy of the key may be in use. Nothing was decided.");
  return { passkey: key.id };
}
