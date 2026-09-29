/**
 * Passkeys, registered and removed (#257, routes/passkeys.ts): a
 * maintainer's own, from their page's origin with the browser's session only;
 * the options ask for user verification and attestation "none" and exclude
 * the passkeys the login holds; the answer is verified by the Worker
 * (webauthn.ts) against the challenge issued — once, to this login, for a
 * registration, within five minutes — the origin and the RP id; the row
 * holds what verification needs and nothing more; ten a login, five live
 * challenges. Registration and removal are journaled — who, when, which
 * passkey, never the key — and only the owner removes theirs. Every new
 * query is asked for its plan. The confirmation that asks for one is
 * agent-tools.test.ts's (*a passkey for approve and block*).
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex, ME_PASSKEYS_SQL } from "../src/routes/contributors";
import {
  CHALLENGE_INSERT_SQL, CHALLENGE_PRUNE_SQL, CHALLENGE_TAKE_SQL, EXPIRED_CHALLENGES_SQL, HAS_PASSKEY_SQL, MAX_PASSKEYS, OWN_PASSKEY_SQL, PASSKEY_BY_CREDENTIAL_SQL, PASSKEY_EVENT_SQL,
  PASSKEY_INSERT_SQL, PASSKEY_REMOVE_SQL, PASSKEY_USED_SQL, PASSKEYS_SQL, relyingParty, userHandleOf,
} from "../src/routes/passkeys";
import { JOURNAL_KINDS } from "../src/meta";
import { b64url, cbor, createAuthenticator, register, EDDSA, ES256, RS256, UP, AT } from "./soft-authenticator.mjs";

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

/** The whole registration, as the page runs it: the options, the authenticator's answer, the POST. */
async function registerAs(login: string, o: { alg?: number; label?: string; answer?: Record<string, unknown>; authenticator?: Awaited<ReturnType<typeof createAuthenticator>> } = {}) {
  const a = o.authenticator ?? (await createAuthenticator({ alg: o.alg ?? ES256 }));
  const opts = await options(login);
  expect(opts.status, JSON.stringify(opts.json)).toBe(200);
  const body = await register(a, { challenge: opts.json.publicKey.challenge, origin: ORIGIN, rpId: RP_ID, ...(o.answer ?? {}) });
  const res = await page("/auth/passkeys", login, { label: o.label ?? "laptop", ...body });
  return { a, res, body, challenge: opts.json.publicKey.challenge as string };
}

const passkeyLines = (login: string) => env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'passkey' AND json_extract(payload, '$.login') = ? ORDER BY id").bind(login).all<{ status: string; summary: string; payload: string }>().then((r) => r.results);

beforeAll(async () => {
  const people = ["m1", "m2", "m3", "m4", "alice"];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2'), ('m3'), ('m4')"),
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

  it("holds ten passkeys a login and five live challenges: the eleventh and the sixth are refused", async () => {
    await env.DB.prepare("DELETE FROM passkey_challenges WHERE login = 'm3'").run();
    const have = (await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE login = 'm3'").first<{ n: number }>())!.n;
    for (let i = have; i < MAX_PASSKEYS; i++) expect((await registerAs("m3", { label: `key ${i}` })).res.status).toBe(201);
    const full = await options("m3");
    expect([full.status, full.json.code]).toEqual([409, "passkey_limit"]);
    // The cap holds at the insert too: a challenge taken before the tenth was stored.
    await env.DB.prepare("DELETE FROM passkeys WHERE id = (SELECT id FROM passkeys WHERE login = 'm3' ORDER BY created_at DESC LIMIT 1)").run();
    const o = await options("m3");
    await registerAs("m3");
    const eleventh = await page("/auth/passkeys", "m3", { label: "x", ...(await register(await createAuthenticator(), { challenge: o.json.publicKey.challenge, origin: ORIGIN, rpId: RP_ID })) });
    expect([eleventh.status, eleventh.json.code]).toEqual([409, "passkey_limit"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE login = 'm3'").first()).toEqual({ n: MAX_PASSKEYS });
    // Five live challenges per login.
    await env.DB.prepare("DELETE FROM passkey_challenges WHERE login = 'm2'").run();
    for (let i = 0; i < 5; i++) expect((await options("m2")).status).toBe(200);
    const sixth = await options("m2");
    expect([sixth.status, sixth.json.code, sixth.headers.get("retry-after")]).toEqual([429, "rate_limited", "300"]);
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
    const out = await page(`/auth/passkeys/${id}/remove`, "m1");
    expect([out.status, out.json]).toEqual([200, { removed: id, by: "m1" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE id = ?").bind(id).first()).toEqual({ n: 0 });
    const lines = await passkeyLines("m1");
    const last = lines[lines.length - 1];
    expect(last.status).toBe("warn");
    expect(last.summary).toMatch(new RegExp(`^m1 removed a passkey \\(ES256, ${id}, registered \\d{4}-\\d{2}-\\d{2}\\)$`));
    expect(JSON.parse(last.payload)).toMatchObject({ login: "m1", by: "m1", action: "remove", passkey: id, alg: "ES256" });
    expect(lines.filter((l) => JSON.parse(l.payload).passkey === id).map((l) => JSON.parse(l.payload).action)).toEqual(["register", "remove"]);
    // Gone: removed again is 404, and no second line.
    expect((await page(`/auth/passkeys/${id}/remove`, "m1")).status).toBe(404);
    expect((await passkeyLines("m1")).length).toBe(lines.length);
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
      ["a registration", PASSKEY_INSERT_SQL, [/SEARCH passkeys USING COVERING INDEX idx_passkeys_login \(login=\?\)/, /SEARCH passkeys USING COVERING INDEX idx_passkeys_credential \(credential_id=\?\)/]],
      ["the journal's line", PASSKEY_EVENT_SQL, [/SEARCH passkeys (EXISTS )?USING INDEX sqlite_autoindex_passkeys_1 \(id=\?\)/]],
      ["a removal", PASSKEY_REMOVE_SQL, [/SEARCH passkeys USING INDEX sqlite_autoindex_passkeys_1 \(id=\?\)/]],
      ["a passkey used", PASSKEY_USED_SQL, [/SEARCH passkeys USING INDEX sqlite_autoindex_passkeys_1 \(id=\?\)/]],
      ["a login's expired challenges", CHALLENGE_PRUNE_SQL, [/SEARCH passkey_challenges USING (COVERING )?INDEX idx_passkey_challenges_login \(login=\? AND expires_at<\?\)/]],
      ["a challenge issued", CHALLENGE_INSERT_SQL, [/SEARCH passkey_challenges USING COVERING INDEX idx_passkey_challenges_login \(login=\? AND expires_at>\?\)/]],
      ["a challenge taken", CHALLENGE_TAKE_SQL, [/SEARCH passkey_challenges USING INDEX sqlite_autoindex_passkey_challenges_1 \(challenge=\?\)/]],
      ["every expired challenge, in the gc", EXPIRED_CHALLENGES_SQL, [/SEARCH passkey_challenges USING (COVERING )?INDEX idx_passkey_challenges_expires \(expires_at<\?\)/]],
    ];
    for (const [what, sql, want] of expected) {
      const p = await plan(sql);
      for (const re of want) expect(p, `${what}: ${p}`).toMatch(re);
      expect(p, `${what}: ${p}`).not.toMatch(/\bSCAN (passkeys|passkey_challenges)\b/);
    }
    expect(ME_PASSKEYS_SQL).toContain(`LIMIT ${MAX_PASSKEYS}`);
    expect(PASSKEYS_SQL).toContain(`LIMIT ${MAX_PASSKEYS}`);
  });

  it("the gc deletes the expired challenges and keeps the live ones", async () => {
    await env.DB.prepare("INSERT INTO passkey_challenges (challenge, login, purpose, draft_id, expires_at) VALUES (?, 'm1', 'register', NULL, '2000-01-01T00:00:00.000Z'), (?, 'm1', 'register', NULL, '2999-01-01T00:00:00.000Z')").bind("e".repeat(43), "l".repeat(43)).run();
    await env.DB.prepare(EXPIRED_CHALLENGES_SQL).run();
    expect((await env.DB.prepare("SELECT challenge FROM passkey_challenges WHERE challenge IN (?, ?)").bind("e".repeat(43), "l".repeat(43)).all()).results).toEqual([{ challenge: "l".repeat(43) }]);
  });
});
