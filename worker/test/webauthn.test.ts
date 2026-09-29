/**
 * The Worker's own WebAuthn verifier (#257, src/webauthn.ts), against the
 * software authenticator (test/soft-authenticator.mjs): CBOR as
 * authenticators write it and every way it can be malformed; authenticatorData
 * and its flags; the three algorithms (ES256, RS256 — Windows Hello — and
 * EdDSA), including the DER-to-raw conversion ECDSA needs; a registration and
 * an assertion that verify, and each check that refuses one — the type, the
 * challenge, the origin, a frame of another site, the RP id's hash, the user
 * present, the user verified, the credential's id, the attestation's shape,
 * the key, the signature, the user handle and the counter.
 */
import { describe, expect, it } from "vitest";
import {
  decodeCbor, decodeCborAll, derToRaw, fromB64url, importCoseKey, parseAuthenticatorData, toB64url, verifyAssertion, verifyRegistration, WebAuthnError,
  ES256, EDDSA, RS256, FLAG_AT, FLAG_ED, FLAG_UP, FLAG_UV, type Cbor,
} from "../src/webauthn";
import { assert as answer, authenticatorData, b64url, cbor, clientDataJSON, concat, createAuthenticator, rawToDer, register, sha256, sign, AT, ED, UP, UV } from "./soft-authenticator.mjs";

const RP = { challenge: b64url(new Uint8Array(32).fill(7)), origin: "https://omarchy-pool.org", rpId: "omarchy-pool.org" };
const HANDLE = new Uint8Array(32).fill(9);

/** The code a verification refused with, or "ok". */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof WebAuthnError) return e.code;
    throw e;
  }
}

describe("CBOR, as authenticators write it", () => {
  it("decodes integers, negative integers, byte and text strings, arrays, maps, false, true and null, and says where each ends", () => {
    const doc = new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], ["fmt", "none"], ["b", new Uint8Array([1, 2, 3])], ["a", [0, 23, 24, 255, 256, 65535, 65536, 4294967296]], ["t", true], ["f", false], ["n", null]]);
    const bytes = cbor(doc);
    const { value, end } = decodeCbor(bytes);
    expect(end).toBe(bytes.length);
    expect(value).toEqual(doc);
    expect(decodeCbor(concat(cbor(-257), new Uint8Array([0xff])))).toEqual({ value: -257, end: 3 });
  });

  it("refuses what no authenticator writes: a tag, a float, undefined, an indefinite length, a duplicate key, a non-scalar key, bad UTF-8, an integer past 2^53, a nesting too deep, a truncated item, a byte after the item", () => {
    const bad: [string, Uint8Array][] = [
      ["tag", new Uint8Array([0xc1, 0x00])],
      ["float", new Uint8Array([0xf9, 0x3c, 0x00])],
      ["undefined", new Uint8Array([0xf7])],
      ["indefinite bytes", new Uint8Array([0x5f, 0x41, 0x00, 0xff])],
      ["indefinite map", new Uint8Array([0xbf, 0xff])],
      ["reserved head", new Uint8Array([0x1c])],
      ["duplicate key", new Uint8Array([0xa2, 0x01, 0x02, 0x01, 0x03])],
      ["array key", new Uint8Array([0xa1, 0x80, 0x00])],
      ["bad utf-8", new Uint8Array([0x62, 0xc3, 0x28])],
      ["past 2^53", new Uint8Array([0x1b, 0x00, 0x40, 0, 0, 0, 0, 0, 0])],
      ["deep", new Uint8Array([...Array(20).fill(0x81), 0x00])],
      ["truncated bytes", new Uint8Array([0x45, 1, 2])],
      ["truncated head", new Uint8Array([0x19, 0x01])],
      ["empty", new Uint8Array([])],
      ["trailing", new Uint8Array([0x00, 0x00])],
    ];
    for (const [what, b] of bad) {
      let code = "ok";
      try {
        decodeCborAll(b);
      } catch (e) {
        code = e instanceof WebAuthnError ? e.code : "threw";
      }
      expect(code, what).toBe("cbor");
    }
  });
});

describe("base64url and DER", () => {
  it("reads unpadded base64url only", () => {
    expect([...fromB64url("AQID")]).toEqual([1, 2, 3]);
    expect(toB64url(new Uint8Array([251, 255]))).toBe("-_8");
    for (const s of ["AQ+D", "AQ/D", "AQID=", "A", "a b"]) expect(() => fromB64url(s), s).toThrow(WebAuthnError);
  });

  it("turns an ECDSA signature's DER into r‖s, padding short integers and dropping a sign byte; refuses what is not DER", () => {
    const r = new Uint8Array(32).fill(0x81), s = new Uint8Array(32);
    s[31] = 5;
    const raw = concat(r, s);
    const der = rawToDer(raw);
    expect([...der.slice(0, 5)]).toEqual([0x30, der.length - 2, 0x02, 33, 0x00]);
    expect(derToRaw(der)).toEqual(raw);
    for (const bad of [
      new Uint8Array([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
      new Uint8Array([0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
      new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x01]),
      new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00]),
      new Uint8Array([0x30, 0x25, 0x02, 0x21, 0x01, ...new Uint8Array(32), 0x02, 0x00]),
      new Uint8Array([0x30, 0x84, 0, 0, 0, 6, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
      new Uint8Array([]),
    ]) expect(() => derToRaw(bad), [...bad].join(",")).toThrow(WebAuthnError);
  });
});

describe("authenticatorData", () => {
  it("reads the RP id's hash, the flags, the counter and the attested credential, and skips the extensions", async () => {
    const a = await createAuthenticator();
    const raw = await authenticatorData({ rpId: "omarchy-pool.org", flags: UP | UV | AT | ED, counter: 0x01020304, attested: { credentialId: a.credentialId, cose: a.cose }, extensions: new Map([["credProtect", 2]]) });
    const d = parseAuthenticatorData(raw);
    expect(d.rpIdHash).toEqual(await sha256("omarchy-pool.org"));
    expect(d.flags).toBe(FLAG_UP | FLAG_UV | FLAG_AT | FLAG_ED);
    expect(d.counter).toBe(0x01020304);
    expect(d.attested!.credentialId).toEqual(a.credentialId);
    expect(d.attested!.publicKey).toEqual(cbor(a.cose));
  });

  it("refuses one that is short, ends inside its credential, or has a byte after its last field", async () => {
    const a = await createAuthenticator();
    const whole = await authenticatorData({ rpId: "x", flags: UP | UV | AT, counter: 1, attested: { credentialId: a.credentialId, cose: a.cose } });
    for (const b of [whole.slice(0, 36), whole.slice(0, 60), whole.slice(0, whole.length - 1), concat(whole, new Uint8Array([0])), concat(await authenticatorData({ rpId: "x", flags: UP, counter: 1 }), new Uint8Array([0]))]) {
      expect(() => parseAuthenticatorData(b)).toThrow(WebAuthnError);
    }
  });
});

describe("COSE keys", () => {
  it("imports ES256, RS256 and EdDSA, and refuses another algorithm, a wrong curve, a short coordinate and a short RSA key", async () => {
    for (const alg of [ES256, RS256, EDDSA]) expect((await importCoseKey((await createAuthenticator({ alg })).cose)).alg).toBe(alg);
    const es = (await createAuthenticator()).cose as Map<Cbor, Cbor>;
    const variants: [string, Map<Cbor, Cbor>, string][] = [
      ["ES384", new Map([...es, [3, -35]]), "algorithm"],
      ["P-384 curve", new Map([...es, [-1, 2]]), "key"],
      ["an OKP kty for ES256", new Map([...es, [1, 1]]), "key"],
      ["a short x", new Map([...es, [-2, new Uint8Array(31)]]), "key"],
      ["no y", new Map([...es].filter(([k]) => k !== -3)), "key"],
      ["a point off the curve", new Map([...es, [-2, new Uint8Array(32).fill(1)], [-3, new Uint8Array(32).fill(1)]]), "key"],
      ["RSA 1024", new Map<Cbor, Cbor>([[1, 3], [3, RS256], [-1, new Uint8Array(128).fill(0xc5)], [-2, new Uint8Array([1, 0, 1])]]), "key"],
      ["Ed448", new Map<Cbor, Cbor>([[1, 1], [3, EDDSA], [-1, 7], [-2, new Uint8Array(57)]]), "key"],
    ];
    for (const [what, cose, code] of variants) expect(await outcome(importCoseKey(cose)), what).toBe(code);
  });
});

describe("a registration", () => {
  it("verifies for each algorithm, and answers the credential's id, its COSE key as written, the algorithm and the counter", async () => {
    for (const alg of [ES256, RS256, EDDSA]) {
      const a = await createAuthenticator({ alg });
      const r = await verifyRegistration(await register(a, RP), RP);
      expect(r).toMatchObject({ credentialId: b64url(a.credentialId), publicKey: b64url(cbor(a.cose)), alg, counter: 0 });
    }
  });

  it("takes a browser that passed the authenticator's own attestation statement, and reads nothing of it", async () => {
    const a = await createAuthenticator();
    const r = await verifyRegistration(await register(a, { ...RP, fmt: "packed", attStmt: new Map<Cbor, Cbor>([["alg", -7], ["sig", new Uint8Array(70)]]) }), RP);
    expect(r.credentialId).toBe(b64url(a.credentialId));
  });

  it("refuses each thing that is not right: the type, the challenge, the origin, a frame of another site, the RP id, the user not present or not verified, no credential, another credential id, a none statement that says something, an attestation object that is not CBOR", async () => {
    const a = await createAuthenticator();
    const other = await createAuthenticator();
    const cases: [string, Record<string, unknown>, string][] = [
      ["a get's type", { type: "webauthn.get" }, "type"],
      ["another challenge", { challenge: b64url(new Uint8Array(32).fill(8)) }, "challenge"],
      ["another origin", { origin: "https://evil.example" }, "origin"],
      ["http on the same name", { origin: "http://omarchy-pool.org" }, "origin"],
      ["a frame of another site", { crossOrigin: true }, "cross_origin"],
      ["another RP id", { signRpId: "evil.example" }, "rp_id"],
      ["nobody present", { flags: UV | AT }, "user_present"],
      ["no user verification", { flags: UP | AT }, "user_verified"],
      ["no attested credential", { flags: UP | UV }, "attested"],
      ["another credential's id", { id: other.credentialId }, "credential"],
      ["a none statement with a signature", { attStmt: new Map([["sig", new Uint8Array(4)]]) }, "attestation"],
      ["an RSA key too short", { cose: new Map<Cbor, Cbor>([[1, 3], [3, RS256], [-1, new Uint8Array(128).fill(0xc5)], [-2, new Uint8Array([1, 0, 1])]]) }, "key"],
    ];
    for (const [what, o, code] of cases) expect(await outcome(verifyRegistration(await register(a, { ...RP, ...o }), RP)), what).toBe(code);
    const good = await register(a, RP);
    expect(await outcome(verifyRegistration({ ...good, attestationObject: b64url(new Uint8Array([0xa1, 0x01])) }, RP))).toBe("attestation");
    expect(await outcome(verifyRegistration({ ...good, attestationObject: b64url(cbor(new Map([["fmt", "none"]]))) }, RP))).toBe("attestation");
    expect(await outcome(verifyRegistration({ ...good, clientDataJSON: b64url(new TextEncoder().encode("not json")) }, RP))).toBe("client_data");
    expect(await outcome(verifyRegistration({ ...good, attestationObject: "not base64url!" }, RP))).toBe("encoding");
    expect(await outcome(verifyRegistration({ ...good, id: "" }, RP))).toBe("encoding");
  });
});

describe("an assertion", () => {
  const stored = async (a: Awaited<ReturnType<typeof createAuthenticator>>, counter = 0) => ({ publicKey: b64url(cbor(a.cose)), alg: a.alg as number, counter, userHandle: HANDLE });
  const input = (x: Record<string, string>) => ({ credential: x.credential, clientDataJSON: x.client_data, authenticatorData: x.authenticator_data, signature: x.signature, userHandle: x.user_handle });

  it("verifies for each algorithm, and answers the new counter", async () => {
    for (const alg of [ES256, RS256, EDDSA]) {
      const a = await createAuthenticator({ alg });
      const s = await stored(a);
      expect(await verifyAssertion(input(await answer(a, RP)), RP, s)).toEqual({ counter: 1, flags: UP | UV });
      expect((await verifyAssertion(input(await answer(a, { ...RP, userHandle: b64url(HANDLE) })), RP, { ...s, counter: 1 })).counter).toBe(2);
    }
  });

  it("takes an authenticator that keeps no counter — zero, both times — and refuses a counter that did not move forward", async () => {
    const zero = await createAuthenticator({ keepsCounter: false });
    expect((await verifyAssertion(input(await answer(zero, RP)), RP, await stored(zero))).counter).toBe(0);
    const a = await createAuthenticator();
    for (const [was, now] of [[5, 5], [5, 4], [5, 0]]) expect(await outcome(verifyAssertion(input(await answer(a, { ...RP, counter: now })), RP, await stored(a, was))), `${was} → ${now}`).toBe("counter");
    expect((await verifyAssertion(input(await answer(a, { ...RP, counter: 6 })), RP, await stored(a, 5))).counter).toBe(6);
  });

  it("refuses each thing that is not right: the type, the challenge, the origin, a frame of another site, the RP id, the user not present or not verified, another key's signature, a signature over other data, a signature cut short, another account's user handle, an algorithm that is not the stored one", async () => {
    const a = await createAuthenticator();
    const other = await createAuthenticator();
    const cases: [string, Record<string, unknown>, string][] = [
      ["a create's type", { type: "webauthn.create" }, "type"],
      ["another challenge", { challenge: b64url(new Uint8Array(32).fill(8)) }, "challenge"],
      ["another origin", { origin: "https://omarchy-pool.org.evil.example" }, "origin"],
      ["a frame of another site", { crossOrigin: true }, "cross_origin"],
      ["another RP id", { signRpId: "localhost" }, "rp_id"],
      ["nobody present", { flags: UV }, "user_present"],
      ["no user verification", { flags: UP }, "user_verified"],
      ["another key's signature", { signer: other }, "signature"],
      ["a signature over other client data", { signedClientData: clientDataJSON({ type: "webauthn.get", challenge: RP.challenge, origin: "https://evil.example" }) }, "signature"],
      ["another account's user handle", { userHandle: b64url(new Uint8Array(32).fill(1)) }, "user_handle"],
    ];
    for (const [what, o, code] of cases) expect(await outcome(verifyAssertion(input(await answer(a, { ...RP, ...o })), RP, await stored(a))), what).toBe(code);
    const good = input(await answer(a, RP));
    const der = fromB64url(good.signature);
    expect(await outcome(verifyAssertion({ ...good, signature: b64url(der.slice(0, der.length - 1)) }, RP, await stored(a)))).toBe("signature");
    expect(await outcome(verifyAssertion(good, RP, { ...(await stored(a)), alg: EDDSA }))).toBe("algorithm");
    // An ES256 signature sent raw (r‖s), as a verifier that skips DER would take: not what an authenticator sends.
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, a.keyPair.privateKey, concat(fromB64url(good.authenticatorData), await sha256(fromB64url(good.clientDataJSON)))));
    expect(await outcome(verifyAssertion({ ...good, signature: b64url(raw) }, RP, await stored(a)))).toBe("signature");
  });

  it("verifies a signature an EdDSA or RS256 authenticator made over the exact bytes, and no other", async () => {
    for (const alg of [RS256, EDDSA]) {
      const a = await createAuthenticator({ alg });
      const x = await answer(a, RP);
      const tampered = fromB64url(x.authenticator_data);
      tampered[36] ^= 1;
      expect(await outcome(verifyAssertion({ ...input(x), authenticatorData: b64url(tampered) }, RP, await stored(a))), String(alg)).toBe("signature");
      expect(await sign(a, new Uint8Array([1]))).toBeInstanceOf(Uint8Array);
    }
  });
});
