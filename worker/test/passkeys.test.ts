/**
 * Passkeys, registered and removed (#257, routes/passkeys.ts): a
 * maintainer's own, from their page's origin with the browser's session only;
 * the options ask for user verification and attestation "none" and exclude
 * the passkeys the login holds; the answer is verified by the Worker
 * (webauthn.ts) against the challenge issued — once, to this login, for a
 * registration, within five minutes — the origin and the RP id; the row
 * holds what verification needs and nothing more; ten a login, five live
 * challenges. Registration and removal are journaled — who, when, which
 * passkey, never the key — and only the owner removes theirs.
 *
 * Since #271 the first passkey is the session's alone and every other one
 * is vouched for by one the login holds, as a removal is: each refusal of
 * that step-up — none, an answer for another act, another login's key, a
 * replayed one — stores and removes nothing. The options for such an act
 * (POST /auth/passkeys/assert) are bound to the login and the act. A lost
 * only passkey is reset by another maintainer, with their own passkey and a
 * reason: the login's passkeys, challenges and browser session go in one
 * batch with the journal's line — its token and its agents' grants too
 * since #284 (passkey-doors.test.ts) — and the pool signs the record; every
 * refusal of it removes nothing. Every new query is asked for its plan. The
 * confirmation of an agent's draft is agent-tools.test.ts's (*a passkey for
 * approve and block*), the web's own approve and block
 * passkey-decisions.test.ts's.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import worker from "../src/index";
import { sha256Hex, ME_PASSKEYS_SQL } from "../src/routes/contributors";
import {
  CHALLENGE_INSERT_SQL, CHALLENGE_PRUNE_SQL, CHALLENGE_REPLACE_SQL, CHALLENGE_TAKE_SQL, EXPIRED_CHALLENGES_SQL, HAS_PASSKEY_SQL, MAX_PASSKEYS, OWN_PASSKEY_SQL, PASSKEY_BY_CREDENTIAL_SQL, PASSKEY_EVENT_SQL,
  PASSKEY_INSERT_SQL, PASSKEY_REMOVE_SQL, PASSKEY_USED_SQL, PASSKEYS_SQL, RESET_CHALLENGES_SQL, RESET_EVENT_SQL, RESET_SQL, SIGN_OUT_SQL, relyingParty, userHandleOf,
} from "../src/routes/passkeys";
import { JOURNAL_KINDS } from "../src/meta";
import { assert as answer, b64url, cbor, createAuthenticator, register, EDDSA, ES256, RS256, UP, AT } from "./soft-authenticator.mjs";

const ORIGIN = "http://localhost:8787";
const RP_ID = "localhost";

async function raw(method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, { method, headers, body, redirect: "manual" }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A call from the person's page: the session's cookie, JSON, and the page's Origin — each can be taken away or changed. */
async function page(path: string, login: string | null, body: unknown = {}, o: { origin?: string | null; bearer?: string; base?: string } = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (login) headers.cookie = `omc=oms_${login}`;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  const origin = o.origin === undefined ? (o.base ?? ORIGIN) : o.origin;
  if (origin) headers.origin = origin;
  const res = await raw("POST", (o.base ?? ORIGIN) + path, headers, JSON.stringify(body));
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}

const options = (login: string) => page("/auth/passkeys/challenge", login);

type Authenticator = Awaited<ReturnType<typeof createAuthenticator>>;
/** The authenticators each login registered in this file, first first: the first vouches for the next (#271). */
const held: Record<string, Authenticator[]> = {};

/** The options for one act of the login's on the web (#271), as the page's script asks for them. */
const assertOptions = (login: string, subject: string) => page("/auth/passkeys/assert", login, { for: subject });

/** An answer from a passkey the login holds — its first here, unless a test names another — for one act (#271). */
async function assertionFor(login: string, subject: string, a: Authenticator = held[login][0]): Promise<Record<string, string>> {
  const o = await assertOptions(login, subject);
  expect(o.status, JSON.stringify(o.json)).toBe(200);
  return answer(a, { challenge: o.json.publicKey.challenge, origin: ORIGIN, rpId: RP_ID });
}

/** The whole registration, as the page runs it: for a login that holds a passkey, that one's answer for adding another (#271); the options, the authenticator's answer, the POST. */
async function registerAs(login: string, o: { alg?: number; label?: string; answer?: Record<string, unknown>; authenticator?: Authenticator; vouch?: false } = {}) {
  const a = o.authenticator ?? (await createAuthenticator({ alg: o.alg ?? ES256 }));
  const vouch = o.vouch === false || !held[login]?.length ? {} : { assertion: await assertionFor(login, "passkey:add") };
  const opts = await options(login);
  expect(opts.status, JSON.stringify(opts.json)).toBe(200);
  const body = await register(a, { challenge: opts.json.publicKey.challenge, origin: ORIGIN, rpId: RP_ID, ...(o.answer ?? {}) });
  const res = await page("/auth/passkeys", login, { label: o.label ?? "laptop", ...body, ...vouch });
  if (res.status === 201) (held[login] ??= []).push(a);
  return { a, res, body, challenge: opts.json.publicKey.challenge as string };
}

const passkeyLines = (login: string) => env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'passkey' AND json_extract(payload, '$.login') = ? ORDER BY id").bind(login).all<{ status: string; summary: string; payload: string }>().then((r) => r.results);

beforeAll(async () => {
  // The reset's record is signed by the pool: a key of its own, made here (signing.test.ts makes one the same way).
  env.SIGNING_KEY = (await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "Pool Test", email: "test@omarchy.invalid" }], format: "armored" })).privateKey;
  const people = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "alice"];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2'), ('m3'), ('m4'), ('m5'), ('m6'), ('m7'), ('m8'), ('m9')"),
    ...(await Promise.all(people.map(async (l) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role) VALUES (?, ?, ?, ?)").bind(l, await sha256Hex(`omc_${l}`), await sha256Hex(`oms_${l}`), l.startsWith("m") ? "maintainer" : "contributor")))),
  ]);
});

describe("the relying party", () => {
  it("comes from one list: the dashboard's name on every production name, localhost on any port, nothing anywhere else", () => {
    for (const host of ["omarchy-pool.org", "www.omarchy-pool.org", "pkgs.omarchy-pool.org", "pkgs.firemanxbr.org", "omarchy-pool.firemanxbr.org"]) {
      expect(relyingParty(new URL(`https://${host}/user/m1`)), host).toMatchObject({ id: "omarchy-pool.org", origin: "https://omarchy-pool.org" });
    }
    expect(relyingParty(new URL("http://localhost:8886/auth/confirm/x"))).toMatchObject({ id: "localhost", origin: "http://localhost:8886" });
    for (const u of ["http://127.0.0.1:8886/", "http://pool.test/", "https://evil.example/", "https://omarchy-pool.org.evil.example/", "http://localhost.evil.example/"]) expect(relyingParty(new URL(u)), u).toBeNull();
  });
});

describe("a registration", () => {
  it("offers a maintainer the options WebAuthn takes: this RP, a user handle that is not the login, the three algorithms, user verification required, attestation none, the login's passkeys excluded", async () => {
    const o = await options("m1");
    expect(o.status).toBe(200);
    expect(o.headers.get("cache-control")).toBe("no-store");
    expect(o.json.publicKey).toMatchObject({
      rp: { id: RP_ID },
      user: { id: b64url(await userHandleOf("m1")), name: "m1", displayName: "m1" },
      pubKeyCredParams: [{ type: "public-key", alg: ES256 }, { type: "public-key", alg: EDDSA }, { type: "public-key", alg: RS256 }],
      timeout: 120000,
      attestation: "none",
      authenticatorSelection: { userVerification: "required" },
      excludeCredentials: [],
    });
    expect(o.json.publicKey.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(o.json.publicKey.user.id).not.toContain("m1");
  });

  it("stores the credential's id, its public key as the authenticator wrote it, the algorithm, the RP id, the counter, the label and the dates — nothing else — and lists it on the owner's /factory/me without the key", async () => {
    const { a, res } = await registerAs("m1", { label: "  work   laptop " });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.passkey).toMatchObject({ label: "work laptop", alg: "ES256", counter: 0 });
    expect(res.json.passkey.id).toMatch(/^pk_[0-9a-f]{32}$/);
    const row = await env.DB.prepare("SELECT * FROM passkeys WHERE id = ?").bind(res.json.passkey.id).first<Record<string, unknown>>();
    expect(Object.keys(row!).sort()).toEqual(["alg", "counter", "created_at", "credential_id", "id", "label", "last_used", "login", "public_key", "rp_id"]);
    expect(row).toMatchObject({ login: "m1", credential_id: b64url(a.credentialId), public_key: b64url(cbor(a.cose)), alg: ES256, rp_id: RP_ID, counter: 0, label: "work laptop", last_used: null });
    const me = await raw("GET", `${ORIGIN}/api/v1/factory/me`, { cookie: "omc=oms_m1" });
    const mine = ((await me.json()) as any).passkeys;
    expect(mine).toEqual([{ id: res.json.passkey.id, label: "work laptop", alg: "ES256", counter: 0, created_at: expect.any(String), last_used: null }]);
    expect(JSON.stringify(mine)).not.toContain(row!.public_key as string);
    // The next options exclude it, so the authenticator is not registered twice.
    expect((await options("m1")).json.publicKey.excludeCredentials).toEqual([{ type: "public-key", id: b64url(a.credentialId) }]);
    // Nobody else's /factory/me lists it.
    expect(((await (await raw("GET", `${ORIGIN}/api/v1/factory/me`, { cookie: "omc=oms_m2" })).json()) as any).passkeys).toEqual([]);
  });

  it("takes RS256 (Windows Hello) and EdDSA keys as well", async () => {
    for (const alg of [RS256, EDDSA]) {
      const { res } = await registerAs("m2", { alg, label: `key ${alg}` });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      expect(res.json.passkey.alg).toBe(alg === RS256 ? "RS256" : "EdDSA");
    }
  });

  it("is journaled: who registered which passkey and when, with the algorithm — never the key, the credential or the label", async () => {
    const { a, res } = await registerAs("m3", { label: "my security key" });
    const lines = await passkeyLines("m3");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "ok", summary: `m3 registered a passkey (ES256, ${res.json.passkey.id})` });
    expect(JSON.parse(lines[0].payload)).toEqual({ login: "m3", by: "m3", via: "web", action: "register", passkey: res.json.passkey.id, alg: "ES256", rp: RP_ID });
    for (const secret of [b64url(cbor(a.cose)), b64url(a.credentialId), "my security key"]) expect(JSON.stringify(lines[0])).not.toContain(secret);
    // The journal serves it, and its filter knows the kind.
    const events = (await (await raw("GET", `${ORIGIN}/api/v1/events?kind=passkey&limit=50`)).json()) as any;
    expect(events.events.map((e: any) => e.summary)).toContain(`m3 registered a passkey (ES256, ${res.json.passkey.id})`);
    expect(JOURNAL_KINDS).toContain("passkey");
  });

  it("takes the browser's session only, from the relying party's origin, and a maintainer who is not blocked — and writes nothing otherwise", async () => {
    const before = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM passkeys) AS keys, (SELECT COUNT(*) FROM passkey_challenges) AS challenges").first();
    const refusals: [string, Promise<{ status: number; json: any }>, number, string][] = [
      ["nobody", options(null as unknown as string), 401, "sign_in"],
      ["a contributor token", page("/auth/passkeys/challenge", null, {}, { bearer: "omc_m1" }), 403, "session_only"],
      ["a token beside the session", page("/auth/passkeys/challenge", "m1", {}, { bearer: "omc_m1" }), 403, "session_only"],
      ["an agent token", page("/auth/passkeys/challenge", "m1", {}, { bearer: "oma_whatever" }), 403, "session_only"],
      ["no Origin", page("/auth/passkeys/challenge", "m1", {}, { origin: null }), 403, "origin"],
      ["another Origin", page("/auth/passkeys/challenge", "m1", {}, { origin: "https://evil.example" }), 403, "origin"],
      ["another port", page("/auth/passkeys/challenge", "m1", {}, { origin: "http://localhost:9999" }), 403, "origin"],
      ["an IP address", page("/auth/passkeys/challenge", "m1", {}, { base: "http://127.0.0.1:8787" }), 403, "rp_unavailable"],
      ["a name the list does not hold", page("/auth/passkeys/challenge", "m1", {}, { base: "http://pool.test" }), 403, "rp_unavailable"],
      ["a contributor", options("alice"), 403, "maintainer_only"],
    ];
    for (const [what, p, status, code] of refusals) {
      const r = await p;
      expect([r.status, r.json?.code], what).toEqual([status, code]);
    }
    await env.DB.prepare("UPDATE contributors SET blocked_at = '2026-09-01T00:00:00Z', blocked_reason = 'test' WHERE login = 'm4'").run();
    expect((await options("m4")).json.code).toBe("blocked");
    await env.DB.prepare("UPDATE contributors SET blocked_at = NULL, blocked_reason = NULL WHERE login = 'm4'").run();
    // The registration itself refuses the same way, before any challenge is read.
    const a = await createAuthenticator();
    const body = await register(a, { challenge: "x".repeat(43), origin: ORIGIN, rpId: RP_ID });
    expect((await page("/auth/passkeys", "alice", body)).json.code).toBe("maintainer_only");
    expect((await page("/auth/passkeys", "m1", body, { origin: "https://evil.example" })).json.code).toBe("origin");
    expect((await page("/auth/passkeys", "m1", body, { bearer: "omc_m1" })).json.code).toBe("session_only");
    expect(await env.DB.prepare("SELECT (SELECT COUNT(*) FROM passkeys) AS keys, (SELECT COUNT(*) FROM passkey_challenges) AS challenges").first()).toEqual(before);
  });

  it("takes a challenge once, for its login and a registration, within five minutes", async () => {
    // Used once: the same answer again is refused, and nothing more is stored.
    const { a, res, body } = await registerAs("m4");
    expect(res.status).toBe(201);
    const again = await page("/auth/passkeys", "m4", { label: "again", ...body });
    expect([again.status, again.json.code]).toEqual([403, "challenge"]);
    // Another login's challenge.
    const theirs = (await options("m2")).json.publicKey.challenge;
    const b = await createAuthenticator();
    expect((await page("/auth/passkeys", "m4", { label: "x", ...(await register(b, { challenge: theirs, origin: ORIGIN, rpId: RP_ID })) })).json.code).toBe("challenge");
    // …and it was taken by the attempt: its own login cannot use it after.
    expect((await page("/auth/passkeys", "m2", { label: "x", ...(await register(b, { challenge: theirs, origin: ORIGIN, rpId: RP_ID })) })).json.code).toBe("challenge");
    // Expired.
    const late = (await options("m4")).json.publicKey.challenge;
    await env.DB.prepare("UPDATE passkey_challenges SET expires_at = '2000-01-01T00:00:00.000Z' WHERE challenge = ?").bind(late).run();
    expect((await page("/auth/passkeys", "m4", { label: "x", ...(await register(b, { challenge: late, origin: ORIGIN, rpId: RP_ID })) })).json.code).toBe("challenge");
    // A challenge issued to confirm a draft does not register a key.
    await env.DB.prepare("INSERT INTO passkey_challenges (challenge, login, purpose, draft_id, expires_at) VALUES (?, 'm4', 'confirm', 'd_x', '2999-01-01T00:00:00.000Z')").bind("c".repeat(43)).run();
    expect((await page("/auth/passkeys", "m4", { label: "x", ...(await register(b, { challenge: "c".repeat(43), origin: ORIGIN, rpId: RP_ID })) })).json.code).toBe("challenge");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE login = 'm4'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE credential_id = ?").bind(b64url(a.credentialId)).first()).toEqual({ n: 1 });
  });

  it("refuses an answer made elsewhere or without the user verified: another origin, another RP id, no user verification, nobody present, a get's type — each with its code, nothing stored", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["another origin", { origin: "https://evil.example" }, "origin"],
      ["another RP id", { signRpId: "evil.example" }, "rp_id"],
      ["no user verification", { flags: UP | AT }, "user_verified"],
      ["nobody present", { flags: 0x04 | AT }, "user_present"],
      ["a get's type", { type: "webauthn.get" }, "type"],
    ];
    const count = () => env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE login = 'm2'").first();
    const before = await count();
    for (const [what, answer, code] of cases) {
      const { res } = await registerAs("m2", { answer });
      expect([res.status, res.json.code], what).toEqual([400, code]);
    }
    expect(await count()).toEqual(before);
  });

  it("refuses a credential registered already — by the same login or another — and a label that is not one line of 1 to 40 printable characters", async () => {
    const a = await createAuthenticator();
    expect((await registerAs("m2", { authenticator: a })).res.status).toBe(201);
    for (const login of ["m2", "m3"]) {
      const { res } = await registerAs(login, { authenticator: a });
      expect([res.status, res.json.code], login).toEqual([409, "passkey_exists"]);
    }
    for (const label of ["x".repeat(41), "a‮b", 42]) {
      const o = await options("m2");
      const res = await page("/auth/passkeys", "m2", { label, ...(await register(await createAuthenticator(), { challenge: o.json.publicKey.challenge, origin: ORIGIN, rpId: RP_ID })) });
      expect([res.status, res.json.code], String(label)).toEqual([400, "label"]);
    }
  });

  it("holds ten passkeys a login and five live challenges — one a purpose and draft, the newest — so the eleventh passkey and a sixth ceremony at once are refused, and retries never are", async () => {
    await env.DB.prepare("DELETE FROM passkey_challenges WHERE login = 'm3'").run();
    const have = (await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE login = 'm3'").first<{ n: number }>())!.n;
    for (let i = have; i < MAX_PASSKEYS; i++) expect((await registerAs("m3", { label: `key ${i}` })).res.status).toBe(201);
    const full = await options("m3");
    expect([full.status, full.json.code]).toEqual([409, "passkey_limit"]);
    // The cap holds at the insert too: an answer whose challenge got past the options' check before the tenth was stored. The options keep one registration challenge a login (a new one replaces the earlier), so that challenge is written straight into the table.
    await env.DB.prepare("DELETE FROM passkeys WHERE id = (SELECT id FROM passkeys WHERE login = 'm3' ORDER BY created_at DESC LIMIT 1)").run();
    await registerAs("m3");
    const early = "r".repeat(43);
    await env.DB.prepare("INSERT INTO passkey_challenges (challenge, login, purpose, draft_id, expires_at) VALUES (?, 'm3', 'register', NULL, ?)").bind(early, new Date(Date.now() + 5 * 60_000).toISOString()).run();
    const eleventh = await page("/auth/passkeys", "m3", { label: "x", ...(await register(await createAuthenticator(), { challenge: early, origin: ORIGIN, rpId: RP_ID })), assertion: await assertionFor("m3", "passkey:add") });
    expect([eleventh.status, eleventh.json.code]).toEqual([409, "passkey_limit"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE login = 'm3'").first()).toEqual({ n: MAX_PASSKEYS });
    // Add a passkey pressed again and again, each prompt cancelled: the newest challenge replaces the one before, so the login holds one for a registration and is never locked out by its own retries; the one before answers nothing.
    await env.DB.prepare("DELETE FROM passkey_challenges WHERE login = 'm2'").run();
    const presses: string[] = [];
    for (let i = 0; i < 8; i++) {
      const o = await options("m2");
      expect(o.status, `press ${i + 1}: ${JSON.stringify(o.json)}`).toBe(200);
      presses.push(o.json.publicKey.challenge);
    }
    expect((await env.DB.prepare("SELECT challenge, purpose, draft_id FROM passkey_challenges WHERE login = 'm2'").all()).results).toEqual([{ challenge: presses[7], purpose: "register", draft_id: null }]);
    const stale = await page("/auth/passkeys", "m2", { label: "x", ...(await register(await createAuthenticator(), { challenge: presses[6], origin: ORIGIN, rpId: RP_ID })) });
    expect([stale.status, stale.json.code]).toEqual([403, "challenge"]);
    // Five ceremonies live at once — confirmations of five drafts — and a sixth is refused, in a person's words.
    await env.DB.prepare("DELETE FROM passkey_challenges WHERE login = 'm2'").run();
    const later = new Date(Date.now() + 5 * 60_000).toISOString();
    for (let i = 0; i < 5; i++) await env.DB.prepare("INSERT INTO passkey_challenges (challenge, login, purpose, draft_id, expires_at) VALUES (?, 'm2', 'confirm', ?, ?)").bind(String(i).repeat(43), `d_${i}`, later).run();
    const sixth = await options("m2");
    expect([sixth.status, sixth.json.code, sixth.headers.get("retry-after")]).toEqual([429, "rate_limited", "300"]);
    expect(sixth.json.error).toBe("Too many passkey requests in the last 5 minutes: wait a few minutes, then press again.");
    // Expired ones do not count, and go at the login's next issue.
    await env.DB.prepare("UPDATE passkey_challenges SET expires_at = '2000-01-01T00:00:00.000Z' WHERE login = 'm2'").run();
    expect((await options("m2")).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkey_challenges WHERE login = 'm2'").first()).toEqual({ n: 1 });
  });
});

describe("a removal", () => {
  it("is the owner's only — another maintainer and a contributor are told it is not theirs — journaled, and final", async () => {
    const { res } = await registerAs("m1", { label: "old phone" });
    const id = res.json.passkey.id;
    for (const login of ["m2", "alice"]) {
      const r = await page(`/auth/passkeys/${id}/remove`, login);
      expect([r.status, r.json.code], login).toEqual([404, "not_found"]);
    }
    expect((await page(`/auth/passkeys/${id}/remove`, "m1", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await page(`/auth/passkeys/${id}/remove`, "m1", {}, { bearer: "omc_m1" })).status).toBe(403);
    expect((await page(`/auth/passkeys/${id}/remove`, null)).status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE id = ?").bind(id).first()).toEqual({ n: 1 });
    const out = await page(`/auth/passkeys/${id}/remove`, "m1", { assertion: await assertionFor("m1", `passkey:remove:${id}`) });
    expect([out.status, out.json]).toEqual([200, { removed: id, by: "m1", confirmed_with: expect.stringMatching(/^pk_[0-9a-f]{32}$/) }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE id = ?").bind(id).first()).toEqual({ n: 0 });
    const lines = await passkeyLines("m1");
    const last = lines[lines.length - 1];
    expect(last.status).toBe("warn");
    expect(last.summary).toMatch(new RegExp(`^m1 removed a passkey \\(ES256, ${id}, registered \\d{4}-\\d{2}-\\d{2}\\)$`));
    expect(JSON.parse(last.payload)).toMatchObject({ login: "m1", by: "m1", action: "remove", passkey: id, alg: "ES256", confirmed_with: out.json.confirmed_with });
    expect(lines.filter((l) => JSON.parse(l.payload).passkey === id).map((l) => JSON.parse(l.payload).action)).toEqual(["register", "remove"]);
    // Gone: removed again is 404, and no second line.
    expect((await page(`/auth/passkeys/${id}/remove`, "m1")).status).toBe(404);
    expect((await passkeyLines("m1")).length).toBe(lines.length);
  });
});

/** A passkey's id, by the credential its authenticator made. */
const idOf = async (a: Authenticator): Promise<string> => (await env.DB.prepare("SELECT id FROM passkeys WHERE credential_id = ?").bind(b64url(a.credentialId)).first<{ id: string }>())!.id;
const countOf = async (login: string): Promise<number> => (await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE login = ?").bind(login).first<{ n: number }>())!.n;

describe("a second passkey, and a removal, with one the login holds (#271)", () => {
  it("the first is the session's alone; a second is refused without an answer from the first — none, one for another act, another login's key, the user not verified, a replayed one — and nothing is stored", async () => {
    // Its first: the session, nothing to ask — the options for adding one say so.
    const none = await assertOptions("m5", "passkey:add");
    expect([none.status, none.json.code]).toEqual([409, "first_passkey"]);
    const first = await registerAs("m5", { label: "first key" });
    expect(first.res.status, JSON.stringify(first.res.json)).toBe(201);
    expect(first.res.json.confirmed_with).toBeUndefined();
    // A second, the way a session driven by someone else would try it: a registration the pool verifies, and no passkey of m5's behind it.
    const add = async (extra: Record<string, unknown>, a?: Authenticator) => {
      const o = await options("m5");
      return page("/auth/passkeys", "m5", { label: "second key", ...(await register(a ?? (await createAuthenticator()), { challenge: o.json.publicKey.challenge, origin: ORIGIN, rpId: RP_ID })), ...extra });
    };
    const forAdd = async (a: Authenticator, o: Record<string, unknown> = {}) => answer(a, { challenge: (await assertOptions("m5", "passkey:add")).json.publicKey.challenge, origin: ORIGIN, rpId: RP_ID, ...o });
    // Each answer is asked for right before its request: a new challenge for the same act replaces the one before.
    const cases: [string, () => Promise<Record<string, unknown>>, string][] = [
      ["no answer", async () => ({}), "passkey_required"],
      ["an answer for another act", async () => ({ assertion: await assertionFor("m5", `passkey:remove:${first.res.json.passkey.id}`) }), "challenge"],
      ["an answer for an approval", async () => ({ assertion: await assertionFor("m5", "approve:7") }), "challenge"],
      ["another login's key", async () => ({ assertion: await forAdd(held.m1[0]) }), "not_yours"],
      ["the user not verified", async () => ({ assertion: await forAdd(held.m5[0], { flags: UP }) }), "user_verified"],
    ];
    for (const [what, extra, code] of cases) {
      const r = await add(await extra());
      expect([r.status, r.json.code], `${what}: ${JSON.stringify(r.json)}`).toEqual([403, code]);
      expect(await countOf("m5"), what).toBe(1);
    }
    // An answer is good for one request, whatever that request decides: spent on a registration refused for its own reason, it vouches for nothing after.
    const once = await assertionFor("m5", "passkey:add");
    const o = await options("m5");
    const bad = await page("/auth/passkeys", "m5", { label: "second key", ...(await register(await createAuthenticator(), { challenge: o.json.publicKey.challenge, origin: "https://evil.example", rpId: RP_ID })), assertion: once });
    expect([bad.status, bad.json.code]).toEqual([400, "origin"]);
    const replayed = await add({ assertion: once });
    expect([replayed.status, replayed.json.code]).toEqual([403, "challenge"]);
    expect(await countOf("m5")).toBe(1);
    // With the first's answer: stored, and the journal names the passkey that vouched for it.
    const was = await env.DB.prepare("SELECT counter, last_used FROM passkeys WHERE id = ?").bind(first.res.json.passkey.id).first<{ counter: number; last_used: string | null }>();
    const second = await registerAs("m5", { label: "second key" });
    expect(second.res.status, JSON.stringify(second.res.json)).toBe(201);
    expect(second.res.json.confirmed_with).toBe(first.res.json.passkey.id);
    const lines = await passkeyLines("m5");
    expect(JSON.parse(lines[lines.length - 1].payload)).toEqual({ login: "m5", by: "m5", via: "web", action: "register", passkey: second.res.json.passkey.id, alg: "ES256", rp: RP_ID, confirmed_with: first.res.json.passkey.id });
    expect(lines[lines.length - 1].summary).toBe(`m5 registered a passkey (ES256, ${second.res.json.passkey.id})`);
    const now = await env.DB.prepare("SELECT counter, last_used FROM passkeys WHERE id = ?").bind(first.res.json.passkey.id).first<{ counter: number; last_used: string | null }>();
    expect(now!.counter).toBeGreaterThan(was!.counter);
    expect(now!.last_used).not.toBeNull();
  });

  it("two first registrations at once store one: the insert holds the rule, whatever the checks before it saw", async () => {
    // The statement alone: for a login that holds one, an insert no passkey vouched for stores nothing, nor one vouched for by a passkey the login does not hold, nor one asked by a session that is not the login's; one vouched for by its own, on its own session, is stored.
    const session = await sha256Hex("oms_m5"), voucher = await idOf(held.m5[0]);
    const insert = (id: string, credential: string, vouchedBy: string | null, asked = session) => env.DB.prepare(PASSKEY_INSERT_SQL).bind(id, "m5", credential, "pQ", ES256, RP_ID, 0, "raw", vouchedBy, asked).run();
    const refused: [string, string | null, string][] = [
      ["no passkey vouched", null, session],
      ["a passkey nobody holds", `pk_${"f".repeat(32)}`, session],
      ["another login's passkey", await idOf(held.m1[0]), session],
      ["a session that is not the login's", voucher, await sha256Hex("oms_m1")],
      ["no session at all", voucher, await sha256Hex("")],
    ];
    for (const [what, vouchedBy, asked] of refused) expect((await insert(`pk_${"a".repeat(32)}`, "raw-a", vouchedBy, asked)).meta.changes, what).toBe(0);
    expect((await insert(`pk_${"b".repeat(32)}`, "raw-b", voucher)).meta.changes).toBe(1);
    await env.DB.prepare("DELETE FROM passkeys WHERE id = ?").bind(`pk_${"b".repeat(32)}`).run();
    // Through the door: m8's first passkey asked for twice (two challenges live, as two tabs would hold them), both answers sent at once.
    const later = new Date(Date.now() + 5 * 60_000).toISOString();
    const tabs = await Promise.all(["1", "2"].map(async (x) => ({ challenge: x.repeat(43), a: await createAuthenticator() })));
    for (const t of tabs) await env.DB.prepare("INSERT INTO passkey_challenges (challenge, login, purpose, draft_id, expires_at) VALUES (?, 'm8', 'register', NULL, ?)").bind(t.challenge, later).run();
    const sent = await Promise.all(tabs.map(async (t) => page("/auth/passkeys", "m8", { label: "raced", ...(await register(t.a, { challenge: t.challenge, origin: ORIGIN, rpId: RP_ID })) })));
    expect(sent.map((r) => r.status).sort()).toEqual([201, 403]);
    expect(sent.find((r) => r.status === 403)!.json.code).toBe("passkey_required");
    expect(await countOf("m8")).toBe(1);
    held.m8 = [tabs[sent.findIndex((r) => r.status === 201)].a];
  });

  it("a removal needs an answer from a passkey the person holds — the one going, or another — and the journal says which; without one nothing is removed", async () => {
    const [first, second] = held.m5;
    const [firstId, secondId] = [await idOf(first), await idOf(second)];
    const remove = (id: string, body: Record<string, unknown>) => page(`/auth/passkeys/${id}/remove`, "m5", body);
    const cases: [string, () => Promise<{ status: number; json: any }>, string][] = [
      ["no answer", () => remove(secondId, {}), "passkey_required"],
      ["an answer for removing the other", async () => remove(secondId, { assertion: await assertionFor("m5", `passkey:remove:${firstId}`) }), "challenge"],
      ["another login's key", async () => remove(secondId, { assertion: await answer(held.m1[0], { challenge: (await assertOptions("m5", `passkey:remove:${secondId}`)).json.publicKey.challenge, origin: ORIGIN, rpId: RP_ID }) }), "not_yours"],
    ];
    for (const [what, send, code] of cases) {
      const r = await send();
      expect([r.status, r.json.code], `${what}: ${JSON.stringify(r.json)}`).toEqual([403, code]);
      expect(await countOf("m5"), what).toBe(2);
    }
    // The one going vouches for its own removal: the person holds it.
    const out = await remove(secondId, { assertion: await assertionFor("m5", `passkey:remove:${secondId}`, second) });
    expect([out.status, out.json]).toEqual([200, { removed: secondId, by: "m5", confirmed_with: secondId }]);
    const lines = await passkeyLines("m5");
    expect(JSON.parse(lines[lines.length - 1].payload)).toMatchObject({ action: "remove", passkey: secondId, confirmed_with: secondId });
    expect(await countOf("m5")).toBe(1);
    held.m5 = [first];
  });
});

describe("the options for an act (#271)", () => {
  it("are a challenge bound to the login and the act, with the login's passkeys and user verification required — for the browser's session only, and by the act's own rules", async () => {
    const o = await assertOptions("m5", "approve:12");
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    expect(o.headers.get("cache-control")).toBe("no-store");
    expect(o.json.publicKey).toEqual({ challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), rpId: RP_ID, timeout: 120000, userVerification: "required", allowCredentials: [{ type: "public-key", id: b64url(held.m5[0].credentialId) }] });
    expect(await env.DB.prepare("SELECT login, purpose, draft_id FROM passkey_challenges WHERE challenge = ?").bind(o.json.publicKey.challenge).first()).toEqual({ login: "m5", purpose: "confirm", draft_id: "approve:12" });
    // Asked again for the same act: the newest replaces it; another act keeps its own.
    const again = await assertOptions("m5", "approve:12");
    await assertOptions("m5", "block:package:hers");
    expect((await env.DB.prepare("SELECT draft_id FROM passkey_challenges WHERE login = 'm5' AND draft_id IN ('approve:12', 'block:package:hers') ORDER BY draft_id").all()).results).toEqual([{ draft_id: "approve:12" }, { draft_id: "block:package:hers" }]);
    expect(await env.DB.prepare("SELECT 1 AS one FROM passkey_challenges WHERE challenge = ?").bind(again.json.publicKey.challenge).first()).toEqual({ one: 1 });
    const refusals: [string, Promise<{ status: number; json: any }>, number, string][] = [
      ["nobody", page("/auth/passkeys/assert", null, { for: "approve:12" }), 401, "sign_in"],
      ["a token", page("/auth/passkeys/assert", null, { for: "approve:12" }, { bearer: "omc_m5" }), 403, "session_only"],
      ["another page", page("/auth/passkeys/assert", "m5", { for: "approve:12" }, { origin: "https://evil.example" }), 403, "origin"],
      ["an address the list does not hold", page("/auth/passkeys/assert", "m5", { for: "approve:12" }, { base: "http://pool.test" }), 403, "rp_unavailable"],
      ["an act it does not know", assertOptions("m5", "withdraw:12"), 400, "for"],
      ["a draft's id: its own page asks for that", assertOptions("m5", `d_${"0".repeat(32)}`), 400, "for"],
      ["a contributor's approval", assertOptions("alice", "approve:12"), 403, "maintainer_only"],
      ["a contributor's block", assertOptions("alice", "block:contributor:bob"), 403, "maintainer_only"],
      ["a contributor's removal, with no passkey", assertOptions("alice", `passkey:remove:pk_${"0".repeat(32)}`), 403, "no_passkey"],
      ["one's own reset", assertOptions("m5", "passkey:reset:m5"), 403, "second_maintainer"],
      ["a reset of a login that holds none, before the device is asked", assertOptions("m5", "passkey:reset:m6"), 409, "nothing_to_reset"],
      ["a maintainer with no passkey", assertOptions("m6", "block:package:hers"), 403, "no_passkey"],
    ];
    for (const [what, p, status, code] of refusals) {
      const r = await p;
      expect([r.status, r.json?.code], what).toEqual([status, code]);
    }
    const m6 = await assertOptions("m6", "approve:12");
    expect(m6.json).toMatchObject({ register: "/user/m6#passkeys" });
    expect(m6.json.error).toBe("approving build #12 is confirmed with your passkey, and m6 has none yet: add one on your page (/user/m6#passkeys), then press again — nothing was decided");
  });
});

describe("a reset, when the only passkey is lost (#271)", () => {
  const REASON = "lost the phone and the key on a train";
  const reset = (by: string | null, body: Record<string, unknown>, o: { origin?: string | null; bearer?: string } = {}) => page("/auth/passkeys/reset", by, body, o);
  const resetLines = async (login: string) => (await passkeyLines(login)).filter((l) => JSON.parse(l.payload).action === "reset");

  it("is another maintainer's, with their own passkey and a reason: the login's passkeys, challenges and browser session go with the journal's line in one batch, and the pool signs the record", async () => {
    await registerAs("m7", { label: "phone" });
    await registerAs("m7", { label: "security key" });
    expect((await options("m7")).status).toBe(200); // a registration asked for before the reset
    const ids = (await env.DB.prepare("SELECT id FROM passkeys WHERE login = 'm7'").all<{ id: string }>()).results.map((r) => r.id).sort();
    expect(ids).toHaveLength(2);
    const keys = (await env.DB.prepare("SELECT public_key, credential_id FROM passkeys WHERE login = 'm7'").all<{ public_key: string; credential_id: string }>()).results;
    const by = await idOf(held.m5[0]);
    const r = await reset("m5", { login: "m7", reason: `  ${REASON} `, assertion: await assertionFor("m5", "passkey:reset:m7") });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ reset: "m7", by: "m5", reason: REASON, confirmed_with: by, signed_out: true });
    expect(r.json.record).toMatch(new RegExp(`^${env.POOL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/contributors/m7/passkeys-reset-\\d{8}T\\d{9}\\.json$`));
    expect(r.json.passkeys.map((k: any) => k.id).sort()).toEqual(ids);
    for (const k of r.json.passkeys) expect(Object.keys(k).sort().concat(k.alg)).toEqual(["alg", "created_at", "id", "last_used", "ES256"]);
    // Gone: the passkeys, the challenge asked for before, the browser's session — and since #284 the command line's token (passkey-doors.test.ts: the agents' grants too, a line each).
    expect(await countOf("m7")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkey_challenges WHERE login = 'm7'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT session_hash FROM contributors WHERE login = 'm7'").first()).toEqual({ session_hash: null });
    expect((await raw("GET", `${ORIGIN}/auth/me`, { cookie: "omc=oms_m7" })).status).toBe(401);
    expect((await raw("GET", `${ORIGIN}/api/v1/factory/me`, { authorization: "Bearer omc_m7" })).status).toBe(401);
    expect(r.json).toMatchObject({ token_revoked: true, grants_revoked: [] });
    // Journaled with who and why — the public journal serves it — never a key.
    const [l] = await resetLines("m7");
    expect(l.status).toBe("warn");
    expect(l.summary).toBe(`m5 reset m7's passkeys (2 removed; m7 signed out): ${REASON}`);
    const payload = JSON.parse(l.payload);
    expect({ ...payload, passkeys: [...payload.passkeys].sort() }).toEqual({ login: "m7", by: "m5", via: "web", action: "reset", passkeys: ids, reason: REASON, confirmed_with: by, signed_out: true, record: r.json.record });
    const events = (await (await raw("GET", `${ORIGIN}/api/v1/events?kind=passkey&limit=50`)).json()) as any;
    expect(events.events.map((e: any) => e.summary)).toContain(l.summary);
    // The record: written once, signed by the pool's key, with who, why and which passkeys — nothing of the keys themselves.
    const key = r.json.record.slice(env.POOL_URL.length + 1);
    const bytes = new Uint8Array(await (await env.PACKAGES.get(key))!.arrayBuffer());
    const sig = new Uint8Array(await (await env.PACKAGES.get(`${key}.sig`))!.arrayBuffer());
    const pub = (await openpgp.readPrivateKey({ armoredKey: env.SIGNING_KEY! })).toPublic();
    const v = await openpgp.verify({ message: await openpgp.createMessage({ binary: bytes }), signature: await openpgp.readSignature({ binarySignature: sig }), verificationKeys: pub, format: "binary" });
    await expect(v.signatures[0].verified).resolves.toBe(true);
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    expect(doc).toMatchObject({ schema: "omarchy-pool/passkey-reset/1", login: "m7", by: "m5", via: "web", reason: REASON, confirmed_with: by, signed_out: true, at: r.json.at });
    expect(doc.passkeys.map((k: any) => k.id).sort()).toEqual(ids);
    for (const k of keys) for (const secret of [k.public_key, k.credential_id]) expect(new TextDecoder().decode(bytes)).not.toContain(secret);
    // The way back: m7 signs in again with GitHub (the tests write the new session's hash, as the callback does) and adds a first passkey with the session alone.
    await env.DB.prepare("UPDATE contributors SET session_hash = ? WHERE login = 'm7'").bind(await sha256Hex("oms_m7")).run();
    held.m7 = [];
    const back = await registerAs("m7", { label: "new phone" });
    expect(back.res.status, JSON.stringify(back.res.json)).toBe(201);
    expect(back.res.json.confirmed_with).toBeUndefined();
  });

  it("leaves nothing behind a registration under way on the session it signs out: no key from the lost device, and the person adds their own after a fresh sign-in", async () => {
    await registerAs("m9", { label: "the lost laptop" });
    // Whoever holds m9's browser session — the lost laptop — registers a key of their own, and m5's reset lands in the middle: after the registration took its challenge, before it read whether m9 holds a passkey (the reviewer's interleaving, one D1 round trip wide).
    const thief = await createAuthenticator();
    const opts = await options("m9");
    const body = await register(thief, { challenge: opts.json.publicKey.challenge, origin: ORIGIN, rpId: RP_ID });
    const resetAnswer = await assertionFor("m5", "passkey:reset:m9");
    let armed = true, resetStatus = 0;
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p !== "prepare") { const v = (t as any)[p]; return typeof v === "function" ? v.bind(t) : v; }
        return (sql: string) => {
          const st = t.prepare(sql);
          if (sql !== HAS_PASSKEY_SQL || !armed) return st;
          armed = false;
          return { bind: (...args: unknown[]) => { const b = st.bind(...args); return { first: async () => { resetStatus = (await reset("m5", { login: "m9", reason: REASON, assertion: resetAnswer })).status; return b.first(); } }; } };
        };
      },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/auth/passkeys`, { method: "POST", headers: { "content-type": "application/json", cookie: "omc=oms_m9", origin: ORIGIN }, body: JSON.stringify({ label: "not mine", ...body }) }), { ...env, DB } as typeof env, ctx);
    await waitOnExecutionContext(ctx);
    const planted = { status: res.status, json: (await res.json()) as any };
    expect(resetStatus).toBe(200);
    expect(await env.DB.prepare("SELECT session_hash FROM contributors WHERE login = 'm9'").first()).toEqual({ session_hash: null });
    // Refused in the person's words, and nothing stored nor journaled: the session that asked is not m9's any more.
    expect([planted.status, planted.json.code], JSON.stringify(planted.json)).toEqual([401, "sign_in"]);
    expect(planted.json.error).toContain("no passkey was added");
    expect(await countOf("m9")).toBe(0);
    expect((await passkeyLines("m9")).filter((l) => JSON.parse(l.payload).action === "register")).toHaveLength(1);
    // The way back stays open: m9 signs in with GitHub again and adds a first passkey of their own with the session alone.
    await env.DB.prepare("UPDATE contributors SET session_hash = ? WHERE login = 'm9'").bind(await sha256Hex("oms_m9")).run();
    held.m9 = [];
    const back = await registerAs("m9", { label: "new laptop" });
    expect(back.res.status, JSON.stringify(back.res.json)).toBe(201);
  });

  it("refuses the login itself, someone who is not a maintainer, a token, another page, no login, no reason, a login that holds none, a maintainer with no passkey, no answer, an answer for another reset — and removes nothing", async () => {
    expect(await countOf("m8")).toBe(1);
    const lines = (await resetLines("m8")).length;
    const cases: [string, () => Promise<{ status: number; json: any }>, number, string][] = [
      ["the login itself", () => reset("m8", { login: "m8", reason: REASON }), 403, "second_maintainer"],
      ["a contributor", () => reset("alice", { login: "m8", reason: REASON }), 403, "maintainer_only"],
      ["a token", () => reset(null, { login: "m8", reason: REASON }, { bearer: "omc_m5" }), 403, "session_only"],
      ["a token beside the session", () => reset("m5", { login: "m8", reason: REASON }, { bearer: "omc_m5" }), 403, "session_only"],
      ["another page", () => reset("m5", { login: "m8", reason: REASON }, { origin: "https://evil.example" }), 403, "origin"],
      ["no login", () => reset("m5", { reason: REASON }), 400, "login"],
      ["a short reason", () => reset("m5", { login: "m8", reason: "why" }), 400, "reason"],
      ["a reason with a control character", () => reset("m5", { login: "m8", reason: "lost it \u0007 all" }), 400, "reason"],
      ["a reason too long", () => reset("m5", { login: "m8", reason: "x".repeat(301) }), 400, "reason"],
      ["a login that holds none", () => reset("m5", { login: "m6", reason: REASON }), 409, "nothing_to_reset"],
      ["a maintainer with no passkey", () => reset("m6", { login: "m8", reason: REASON }), 403, "no_passkey"],
      ["no answer", () => reset("m5", { login: "m8", reason: REASON }), 403, "passkey_required"],
      ["an answer for another reset", async () => reset("m5", { login: "m8", reason: REASON, assertion: await assertionFor("m5", "passkey:reset:m7") }), 403, "challenge"],
    ];
    for (const [what, send, status, code] of cases) {
      const r = await send();
      expect([r.status, r.json?.code], `${what}: ${JSON.stringify(r.json)}`).toEqual([status, code]);
      expect(await countOf("m8"), what).toBe(1);
    }
    expect((await resetLines("m8")).length).toBe(lines);
    expect((await env.DB.prepare("SELECT session_hash FROM contributors WHERE login = 'm8'").first<{ session_hash: string | null }>())!.session_hash).not.toBeNull();
  });

  it("sent twice at once is one reset: one line, and the second is told it is done", async () => {
    const [a, b] = await Promise.all([
      (async () => reset("m5", { login: "m8", reason: REASON, assertion: await assertionFor("m5", "passkey:reset:m8") }))(),
      (async () => reset("m2", { login: "m8", reason: "their key broke in the lab", assertion: await assertionFor("m2", "passkey:reset:m8") }))(),
    ]);
    expect([a.status, b.status].sort(), JSON.stringify([a.json, b.json])).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).json.code).toBe("nothing_to_reset");
    expect((await resetLines("m8")).length).toBe(1);
    expect(await countOf("m8")).toBe(0);
  });

  it("stands when the bucket refuses its record: the answer says so, and a line of its own", async () => {
    expect(await countOf("m7")).toBe(1);
    const real = env.PACKAGES;
    env.PACKAGES = { head: (k: string) => real.head(k), put: async () => { throw new Error("the bucket is down"); } } as unknown as R2Bucket;
    let r: { status: number; json: any };
    try {
      r = await reset("m5", { login: "m7", reason: REASON, assertion: await assertionFor("m5", "passkey:reset:m7") });
    } finally {
      env.PACKAGES = real;
    }
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ reset: "m7", record: null, record_error: "the bucket is down" });
    expect(await countOf("m7")).toBe(0);
    const failed = (await passkeyLines("m7")).filter((l) => l.status === "error");
    expect(failed.map((l) => l.summary)).toEqual(["the record of m5's reset of m7's passkeys was not written: the bucket is down"]);
  });
});

describe("every new query", () => {
  it("is a search through an index, never a scan; the page's list reads as many as the cap", async () => {
    const plan = async (sql: string) => {
      const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
      const n = numbered.length ? Math.max(...numbered) : (sql.match(/\?/g) ?? []).length;
      return (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array.from({ length: n }, () => "x")).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    };
    const expected: [string, string, RegExp[]][] = [
      ["a login's passkeys", PASSKEYS_SQL, [/SEARCH passkeys USING INDEX idx_passkeys_login \(login=\?\)/]],
      ["the owner's page's passkeys", ME_PASSKEYS_SQL, [/SEARCH passkeys USING INDEX idx_passkeys_login \(login=\?\)/]],
      ["whether a login holds one", HAS_PASSKEY_SQL, [/SEARCH passkeys USING COVERING INDEX idx_passkeys_login \(login=\?\)/]],
      ["a passkey by its credential", PASSKEY_BY_CREDENTIAL_SQL, [/SEARCH passkeys USING INDEX idx_passkeys_credential \(credential_id=\?\)/]],
      ["a login's own passkey", OWN_PASSKEY_SQL, [/SEARCH passkeys USING INDEX sqlite_autoindex_passkeys_1 \(id=\?\)/]],
      ["a registration", PASSKEY_INSERT_SQL, [/SEARCH passkeys USING COVERING INDEX idx_passkeys_login \(login=\?\)/, /SEARCH passkeys USING COVERING INDEX idx_passkeys_credential \(credential_id=\?\)/, /SEARCH passkeys USING INDEX sqlite_autoindex_passkeys_1 \(id=\?\)/, /SEARCH contributors (EXISTS )?USING INDEX (sqlite_autoindex_contributors_1 \(login=\?\)|idx_contributors_session \(session_hash=\?\))/]],
      ["the journal's line", PASSKEY_EVENT_SQL, [/SEARCH passkeys (EXISTS )?USING INDEX sqlite_autoindex_passkeys_1 \(id=\?\)/]],
      ["a reset's journal line", RESET_EVENT_SQL, [/SEARCH passkeys (EXISTS )?USING COVERING INDEX idx_passkeys_login \(login=\?\)/]],
      ["a reset", RESET_SQL, [/SEARCH passkeys USING (COVERING )?INDEX idx_passkeys_login \(login=\?\)/]],
      ["a reset's challenges", RESET_CHALLENGES_SQL, [/SEARCH passkey_challenges USING (COVERING )?INDEX idx_passkey_challenges_login \(login=\?\)/]],
      ["a removal", PASSKEY_REMOVE_SQL, [/SEARCH passkeys USING INDEX sqlite_autoindex_passkeys_1 \(id=\?\)/]],
      ["a passkey used", PASSKEY_USED_SQL, [/SEARCH passkeys USING INDEX sqlite_autoindex_passkeys_1 \(id=\?\)/]],
      ["a login's expired challenges", CHALLENGE_PRUNE_SQL, [/SEARCH passkey_challenges USING (COVERING )?INDEX idx_passkey_challenges_login \(login=\? AND expires_at<\?\)/]],
      ["the earlier challenge for the same purpose and draft", CHALLENGE_REPLACE_SQL, [/SEARCH passkey_challenges USING INDEX idx_passkey_challenges_login \(login=\?\)/]],
      ["a challenge issued", CHALLENGE_INSERT_SQL, [/SEARCH passkey_challenges USING COVERING INDEX idx_passkey_challenges_login \(login=\? AND expires_at>\?\)/]],
      ["a challenge taken", CHALLENGE_TAKE_SQL, [/SEARCH passkey_challenges USING INDEX sqlite_autoindex_passkey_challenges_1 \(challenge=\?\)/]],
      ["every expired challenge, in the gc", EXPIRED_CHALLENGES_SQL, [/SEARCH passkey_challenges USING (COVERING )?INDEX idx_passkey_challenges_expires \(expires_at<\?\)/]],
    ];
    for (const [what, sql, want] of expected) {
      const p = await plan(sql);
      for (const re of want) expect(p, `${what}: ${p}`).toMatch(re);
      expect(p, `${what}: ${p}`).not.toMatch(/\bSCAN (passkeys|passkey_challenges)\b/);
    }
    // The registration asks for the session through a unique index (the login's, or the session's own), and the reset signs the login out by its primary key: one row, never a walk of every person.
    expect(await plan(PASSKEY_INSERT_SQL)).not.toMatch(/\bSCAN contributors\b/);
    const out = await plan(SIGN_OUT_SQL);
    expect(out).toMatch(/SEARCH contributors USING INDEX sqlite_autoindex_contributors_1 \(login=\?\)/);
    expect(out).not.toMatch(/\bSCAN contributors\b/);
    expect(ME_PASSKEYS_SQL).toContain(`LIMIT ${MAX_PASSKEYS}`);
    expect(PASSKEYS_SQL).toContain(`LIMIT ${MAX_PASSKEYS}`);
  });

  it("the gc deletes the expired challenges and keeps the live ones", async () => {
    await env.DB.prepare("INSERT INTO passkey_challenges (challenge, login, purpose, draft_id, expires_at) VALUES (?, 'm1', 'register', NULL, '2000-01-01T00:00:00.000Z'), (?, 'm1', 'register', NULL, '2999-01-01T00:00:00.000Z')").bind("e".repeat(43), "l".repeat(43)).run();
    await env.DB.prepare(EXPIRED_CHALLENGES_SQL).run();
    expect((await env.DB.prepare("SELECT challenge FROM passkey_challenges WHERE challenge IN (?, ?)").bind("e".repeat(43), "l".repeat(43)).all()).results).toEqual([{ challenge: "l".repeat(43) }]);
  });
});
