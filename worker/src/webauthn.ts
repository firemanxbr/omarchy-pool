/**
 * The WebAuthn checks the pool makes itself (#257; docs:
 * worker/src/docs/omarchy-cli-mcp.md, *A passkey for approve and block*):
 * what a passkey's registration and its assertions say, verified with the
 * runtime's WebCrypto and nothing else — no library, no polyfill, no
 * nodejs_compat. The Worker needs a small part of WebAuthn Level 3:
 *
 *   - CBOR (RFC 8949), the subset authenticators write: unsigned and
 *     negative integers, byte and text strings, arrays, maps, false, true,
 *     null — definite lengths only; a tag, a float, an indefinite length, a
 *     duplicate key or a byte left over is refused.
 *   - COSE keys (RFC 9053): ES256 (EC2 on P-256), RS256 (RSA, 2048 bits at
 *     least — Windows Hello) and EdDSA (OKP on Ed25519).
 *   - authenticatorData: the RP id's hash, the flags (user present, user
 *     verified, attested credential data, extensions), the signature
 *     counter, and at registration the credential's id and public key.
 *   - An ECDSA signature arrives DER-encoded (SEQUENCE of two INTEGERs);
 *     WebCrypto verifies the raw r‖s of IEEE P1363, so it is converted.
 *
 * Attestation: the pool asks for "none" and trusts no maker's chain. A
 * browser that still passes the authenticator's own statement is not
 * refused for it; the statement is not read, and nothing is stored from it.
 * What a passkey proves, it proves at every assertion with the key it
 * registered.
 *
 * Every check a verification makes is a refusal with a code of its own
 * (WebAuthnError), so a page can say which one failed and a test can hold
 * each.
 */

export const ES256 = -7;
export const EDDSA = -8;
export const RS256 = -257;
/** The algorithms the pool accepts, by their COSE number, in the order a registration offers them. */
export const ALGORITHMS: Readonly<Record<number, string>> = { [ES256]: "ES256", [EDDSA]: "EdDSA", [RS256]: "RS256" };
export const OFFERED_ALGORITHMS: readonly number[] = [ES256, EDDSA, RS256];

/** authenticatorData's flags (WebAuthn §6.1). */
export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

/** Longest credential id WebAuthn allows (§5.8.3). */
const MAX_CREDENTIAL_ID = 1023;
/** How deep a CBOR item may nest: a COSE key is two levels, an attestation object three. */
const MAX_DEPTH = 16;
/** RSA keys shorter than this are refused (NIST SP 800-131A). */
const MIN_RSA_BYTES = 256;

export type WebAuthnCode =
  | "encoding" | "cbor" | "client_data" | "type" | "challenge" | "origin" | "cross_origin"
  | "auth_data" | "rp_id" | "user_present" | "user_verified" | "attested" | "credential"
  | "attestation" | "algorithm" | "key" | "signature" | "counter" | "user_handle";

/** A refusal: which check failed, in a word (`code`), and why, in the person's words (`message`). */
export class WebAuthnError extends Error {
  readonly code: WebAuthnCode;
  constructor(code: WebAuthnCode, message: string) {
    super(message);
    this.code = code;
    this.name = "WebAuthnError";
  }
}

function fail(code: WebAuthnCode, message: string): never {
  throw new WebAuthnError(code, message);
}

// ---------- base64url ----------

const B64URL = /^[A-Za-z0-9_-]*$/;

/** base64url without padding (RFC 4648 §5), as WebAuthn writes it. */
export function toB64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url to bytes: the unpadded alphabet only — a `+`, a `/`, a space or a length no encoder writes is refused. */
export function fromB64url(s: string, what = "a value"): Uint8Array {
  if (typeof s !== "string" || !B64URL.test(s) || s.length % 4 === 1) fail("encoding", `${what} is not base64url`);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

export async function sha256(bytes: Uint8Array | string): Promise<Uint8Array> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

// ---------- CBOR ----------

export type Cbor = number | string | boolean | null | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

/**
 * One CBOR item from `bytes` at `at`: the value and where it ends. Maps
 * come back as a Map (a COSE key's labels are integers); a key seen twice,
 * an integer past 2^53, a tag, a float, undefined, a simple value or an
 * indefinite length is refused, as is an item that runs past the end.
 */
export function decodeCbor(bytes: Uint8Array, at = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > MAX_DEPTH) fail("cbor", "CBOR nested too deep");
  if (at >= bytes.length) fail("cbor", "CBOR ended early");
  const head = bytes[at];
  const major = head >> 5, info = head & 0x1f;
  let i = at + 1;
  const need = (n: number) => {
    if (i + n > bytes.length) fail("cbor", "CBOR ended early");
  };
  let arg: number;
  if (info < 24) arg = info;
  else if (info === 24) { need(1); arg = bytes[i]; i += 1; }
  else if (info === 25) { need(2); arg = (bytes[i] << 8) | bytes[i + 1]; i += 2; }
  else if (info === 26) { need(4); arg = ((bytes[i] << 24) >>> 0) + ((bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]); i += 4; }
  else if (info === 27) {
    need(8);
    const hi = ((bytes[i] << 24) >>> 0) + ((bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]);
    const lo = ((bytes[i + 4] << 24) >>> 0) + ((bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7]);
    if (hi > 0x1fffff) fail("cbor", "a CBOR integer past 2^53");
    arg = hi * 0x100000000 + lo;
    i += 8;
  } else return fail("cbor", info === 31 ? "an indefinite-length CBOR item" : "a reserved CBOR head");
  switch (major) {
    case 0:
      return { value: arg, end: i };
    case 1:
      return { value: -1 - arg, end: i };
    case 2:
      need(arg);
      return { value: bytes.slice(i, i + arg), end: i + arg };
    case 3: {
      need(arg);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(i, i + arg));
      } catch {
        return fail("cbor", "a CBOR text string that is not UTF-8");
      }
      return { value: text, end: i + arg };
    }
    case 4: {
      const out: Cbor[] = [];
      for (let n = 0; n < arg; n++) {
        const item = decodeCbor(bytes, i, depth + 1);
        out.push(item.value);
        i = item.end;
      }
      return { value: out, end: i };
    }
    case 5: {
      const out = new Map<Cbor, Cbor>();
      for (let n = 0; n < arg; n++) {
        const k = decodeCbor(bytes, i, depth + 1);
        if (typeof k.value !== "number" && typeof k.value !== "string") fail("cbor", "a CBOR map key that is neither an integer nor a text string");
        if (out.has(k.value)) fail("cbor", "a CBOR map with a key twice");
        const v = decodeCbor(bytes, k.end, depth + 1);
        out.set(k.value, v.value);
        i = v.end;
      }
      return { value: out, end: i };
    }
    case 6:
      return fail("cbor", "a CBOR tag");
    default:
      // major 7: false, true and null are what WebAuthn's structures carry; a float or any other simple value is not.
      if (info === 20) return { value: false, end: i };
      if (info === 21) return { value: true, end: i };
      if (info === 22) return { value: null, end: i };
      return fail("cbor", "a CBOR float or simple value");
  }
}

/** A whole CBOR document: one item and not a byte after it. */
export function decodeCborAll(bytes: Uint8Array): Cbor {
  const { value, end } = decodeCbor(bytes);
  if (end !== bytes.length) fail("cbor", "bytes after the CBOR item");
  return value;
}

// ---------- authenticatorData ----------

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  counter: number;
  /** At registration (the AT flag): the authenticator's model, the credential's id and its COSE public key as the bytes it wrote. */
  attested: { aaguid: Uint8Array; credentialId: Uint8Array; publicKey: Uint8Array; cose: Map<Cbor, Cbor> } | null;
}

/** authenticatorData (WebAuthn §6.1): 32 bytes of the RP id's hash, the flags, the counter (big-endian), then what the flags announce — and nothing after it. */
export function parseAuthenticatorData(b: Uint8Array): AuthenticatorData {
  if (b.length < 37) fail("auth_data", "authenticatorData is shorter than 37 bytes");
  const flags = b[32];
  const counter = ((b[33] << 24) >>> 0) + ((b[34] << 16) | (b[35] << 8) | b[36]);
  let i = 37;
  let attested: AuthenticatorData["attested"] = null;
  if (flags & FLAG_AT) {
    if (b.length < i + 18) fail("auth_data", "authenticatorData ends inside its attested credential data");
    const aaguid = b.slice(i, i + 16);
    i += 16;
    const len = (b[i] << 8) | b[i + 1];
    i += 2;
    if (len < 1 || len > MAX_CREDENTIAL_ID || i + len > b.length) fail("auth_data", "authenticatorData's credential id has a length no authenticator writes");
    const credentialId = b.slice(i, i + len);
    i += len;
    let item: { value: Cbor; end: number };
    try {
      item = decodeCbor(b, i);
    } catch (e) {
      return fail("key", `the credential's public key is not CBOR: ${(e as Error).message}`);
    }
    if (!(item.value instanceof Map)) fail("key", "the credential's public key is not a COSE key");
    attested = { aaguid, credentialId, publicKey: b.slice(i, item.end), cose: item.value as Map<Cbor, Cbor> };
    i = item.end;
  }
  if (flags & FLAG_ED) {
    const ext = decodeCbor(b, i);
    if (!(ext.value instanceof Map)) fail("auth_data", "authenticatorData's extensions are not a CBOR map");
    i = ext.end;
  }
  if (i !== b.length) fail("auth_data", "bytes after authenticatorData's last field");
  return { rpIdHash: b.slice(0, 32), flags, counter, attested };
}

// ---------- COSE keys and signatures ----------

function coseBytes(cose: Map<Cbor, Cbor>, label: number, what: string, length?: number): Uint8Array {
  const v = cose.get(label);
  if (!(v instanceof Uint8Array) || (length !== undefined && v.length !== length)) fail("key", `the COSE key's ${what} is missing or the wrong size`);
  return v as Uint8Array;
}

/** A COSE key (RFC 9053) as a WebCrypto key for verify, with its algorithm: ES256 on P-256, RS256 of 2048 bits or more, EdDSA on Ed25519 — anything else is refused. */
export async function importCoseKey(cose: Map<Cbor, Cbor>): Promise<{ alg: number; key: CryptoKey }> {
  const kty = cose.get(1), alg = cose.get(3);
  if (typeof alg !== "number" || !(alg in ALGORITHMS)) return fail("algorithm", `the key's algorithm (${String(alg)}) is not one the pool takes: ES256, EdDSA or RS256`);
  try {
    if (alg === ES256) {
      if (kty !== 2 || cose.get(-1) !== 1) fail("key", "an ES256 key is an EC2 key on P-256");
      const x = coseBytes(cose, -2, "x", 32), y = coseBytes(cose, -3, "y", 32);
      return { alg, key: await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: toB64url(x), y: toB64url(y), ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]) };
    }
    if (alg === RS256) {
      if (kty !== 3) fail("key", "an RS256 key is an RSA key");
      let n = coseBytes(cose, -1, "modulus"), e = coseBytes(cose, -2, "exponent");
      // JWK writes no leading zero octet (RFC 7518 §6.3.1.1); a COSE writer may.
      while (n.length > 1 && n[0] === 0) n = n.subarray(1);
      while (e.length > 1 && e[0] === 0) e = e.subarray(1);
      if (n.length < MIN_RSA_BYTES) fail("key", `an RS256 key of ${n.length * 8} bits: the pool takes 2048 or more`);
      return { alg, key: await crypto.subtle.importKey("jwk", { kty: "RSA", n: toB64url(n), e: toB64url(e), alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]) };
    }
    if (kty !== 1 || cose.get(-1) !== 6) fail("key", "an EdDSA key is an OKP key on Ed25519");
    return { alg, key: await crypto.subtle.importKey("raw", coseBytes(cose, -2, "x", 32), { name: "Ed25519" }, false, ["verify"]) };
  } catch (e) {
    if (e instanceof WebAuthnError) throw e;
    return fail("key", `the credential's public key does not import: ${(e as Error).message}`);
  }
}

/**
 * An ECDSA signature as DER (a SEQUENCE of the INTEGERs r and s, X9.62) to
 * the raw r‖s WebCrypto verifies, each left-padded to `size` bytes. Leading
 * zero octets are dropped; a negative integer, a value wider than the curve,
 * a long-form length or a byte after the sequence is refused.
 */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  function bad(): never {
    return fail("signature", "the ECDSA signature is not DER");
  }
  if (der[i++] !== 0x30) bad();
  let len = der[i++];
  if (len === 0x81) len = der[i++];
  else if (len & 0x80) bad();
  if (len === undefined || i + len !== der.length) bad();
  const integer = (): Uint8Array => {
    if (der[i++] !== 0x02) bad();
    const l = der[i++];
    if (l === undefined || l < 1 || l > size + 1 || i + l > der.length) bad();
    let v = der.subarray(i, i + l);
    i += l;
    if (v[0] & 0x80) bad();
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) bad();
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = integer(), s = integer();
  if (i !== der.length) bad();
  return concat(r, s);
}

/**
 * Whether `signature` is the key's over `data`, in its algorithm's shape: DER
 * for ES256, as it comes for RS256 and EdDSA. A signature WebCrypto cannot
 * even read — not DER, an Ed25519 one that is not 64 bytes — is refused with
 * the code `signature`, never thrown as the runtime's own error.
 */
export async function verifySignature(alg: number, key: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const params = alg === ES256 ? { name: "ECDSA", hash: "SHA-256" } : alg === RS256 ? { name: "RSASSA-PKCS1-v1_5" } : alg === EDDSA ? { name: "Ed25519" } : null;
  if (!params) return fail("algorithm", `algorithm ${alg} is not one the pool takes`);
  // An Ed25519 signature is 64 bytes (RFC 8032 §5.1.6); workerd throws on any other length instead of answering false.
  if (alg === EDDSA && signature.length !== 64) return fail("signature", "the EdDSA signature is not 64 bytes");
  const sig = alg === ES256 ? derToRaw(signature) : signature;
  try {
    return await crypto.subtle.verify(params, key, sig, data);
  } catch {
    // Whatever else the runtime refuses to read (an RSA signature of another length, say) is a signature that is not the passkey's: a refusal, never a 500.
    return fail("signature", "the signature could not be read");
  }
}

// ---------- the ceremonies ----------

/** What a ceremony must match: the challenge the pool issued (base64url), and the relying party the pool is on — its origin and its id. */
export interface Expected {
  challenge: string;
  origin: string;
  rpId: string;
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

/** clientDataJSON (§5.8.1): the ceremony's type, the challenge, the page's origin, and not across origins (an iframe of another site). */
function clientData(bytes: Uint8Array, type: "webauthn.create" | "webauthn.get", expected: Expected): ClientData {
  let c: ClientData;
  try {
    c = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as ClientData;
  } catch {
    return fail("client_data", "clientDataJSON is not JSON");
  }
  if (!c || typeof c !== "object") fail("client_data", "clientDataJSON is not an object");
  if (c.type !== type) fail("type", `clientDataJSON says ${JSON.stringify(c.type)}, not ${type}`);
  if (typeof c.challenge !== "string" || c.challenge !== expected.challenge) fail("challenge", "the answer is not for the challenge the pool issued");
  if (c.origin !== expected.origin) fail("origin", `the answer was made on ${JSON.stringify(c.origin)}, not ${expected.origin}`);
  if (c.crossOrigin === true) fail("cross_origin", "the answer was made in a frame of another site");
  return c;
}

/** The RP id's hash, the user present and — required — the user verified: a touch and a PIN or a biometric, which the agent's software cannot supply. */
async function checkAuthenticator(a: AuthenticatorData, expected: Expected): Promise<void> {
  if (!sameBytes(a.rpIdHash, await sha256(expected.rpId))) fail("rp_id", `the authenticator signed for another relying party, not ${expected.rpId}`);
  if (!(a.flags & FLAG_UP)) fail("user_present", "the authenticator says nobody was present");
  if (!(a.flags & FLAG_UV)) fail("user_verified", "the authenticator did not verify the user (no PIN, no biometric): approve and block need user verification");
}

/** Whether a string field could be what a browser sends: base64url, and not longer than `max` characters. */
function field(v: unknown, what: string, max: number): string {
  if (typeof v !== "string" || !v || v.length > max) fail("encoding", `${what} is missing or too long`);
  return v as string;
}

export interface RegistrationInput {
  /** The credential's id (PublicKeyCredential.rawId, base64url). */
  id: string;
  clientDataJSON: string;
  attestationObject: string;
}

export interface Registered {
  /** base64url of the credential's id. */
  credentialId: string;
  /** base64url of the COSE public key, as the authenticator wrote it. */
  publicKey: string;
  alg: number;
  counter: number;
  /** The authenticator's model (all zero when the browser anonymised it, as "none" asks). */
  aaguid: string;
}

/**
 * A registration (§7.1): clientDataJSON says webauthn.create for this
 * challenge and origin; the attestation object is CBOR with an
 * authenticatorData for this RP id, the user present and verified, and a
 * credential whose id is the one sent and whose key the pool takes. The
 * attestation statement is not verified ("none": see above), except that a
 * "none" statement must be empty.
 */
export async function verifyRegistration(input: RegistrationInput, expected: Expected): Promise<Registered> {
  const idBytes = fromB64url(field(input.id, "the credential's id", 1400), "the credential's id");
  clientData(fromB64url(field(input.clientDataJSON, "clientDataJSON", 4096), "clientDataJSON"), "webauthn.create", expected);
  let att: Cbor;
  try {
    att = decodeCborAll(fromB64url(field(input.attestationObject, "the attestation object", 16384), "the attestation object"));
  } catch (e) {
    if (e instanceof WebAuthnError && e.code === "encoding") throw e;
    return fail("attestation", `the attestation object is not CBOR: ${(e as Error).message}`);
  }
  if (!(att instanceof Map)) return fail("attestation", "the attestation object is not a CBOR map");
  const fmt = att.get("fmt"), stmt = att.get("attStmt"), raw = att.get("authData");
  if (typeof fmt !== "string" || !(stmt instanceof Map) || !(raw instanceof Uint8Array)) return fail("attestation", "the attestation object lacks fmt, attStmt or authData");
  if (fmt === "none" && stmt.size !== 0) fail("attestation", "a \"none\" attestation carries a statement");
  const a = parseAuthenticatorData(raw);
  await checkAuthenticator(a, expected);
  if (!a.attested) return fail("attested", "the authenticator sent no credential (no attested credential data)");
  if (!sameBytes(a.attested.credentialId, idBytes)) fail("credential", "the credential's id is not the one in authenticatorData");
  const { alg } = await importCoseKey(a.attested.cose);
  return { credentialId: toB64url(idBytes), publicKey: toB64url(a.attested.publicKey), alg, counter: a.counter, aaguid: [...a.attested.aaguid].map((x) => x.toString(16).padStart(2, "0")).join("") };
}

export interface AssertionInput {
  /** The credential's id (base64url): which passkey answered. */
  credential: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  /** The user handle the authenticator returned, if it did (base64url). */
  userHandle?: string | null;
}

export interface StoredKey {
  /** base64url of the COSE key stored at registration. */
  publicKey: string;
  alg: number;
  counter: number;
  /** The user handle registered with it, to compare with one the authenticator returns. */
  userHandle: Uint8Array;
}

/**
 * An assertion (§7.2) with the key the pool stored: clientDataJSON says
 * webauthn.get for this challenge and origin; authenticatorData is for this
 * RP id with the user present and verified; the signature is the stored
 * key's over authenticatorData ‖ SHA-256(clientDataJSON); a user handle
 * returned is the one registered; and the counter moved forward — a counter
 * that did not, when the authenticator keeps one (either is not zero), is
 * a cloned key's (§6.1.1) and refused. Answers the new counter.
 */
export async function verifyAssertion(input: AssertionInput, expected: Expected, stored: StoredKey): Promise<{ counter: number; flags: number }> {
  const cd = fromB64url(field(input.clientDataJSON, "clientDataJSON", 4096), "clientDataJSON");
  clientData(cd, "webauthn.get", expected);
  const raw = fromB64url(field(input.authenticatorData, "authenticatorData", 2048), "authenticatorData");
  const a = parseAuthenticatorData(raw);
  await checkAuthenticator(a, expected);
  if (input.userHandle) {
    if (!sameBytes(fromB64url(field(input.userHandle, "the user handle", 128), "the user handle"), stored.userHandle)) fail("user_handle", "the passkey belongs to another account");
  }
  const cose = decodeCborAll(fromB64url(stored.publicKey, "the stored key"));
  if (!(cose instanceof Map)) return fail("key", "the stored key is not a COSE key");
  const { alg, key } = await importCoseKey(cose);
  if (alg !== stored.alg) fail("algorithm", "the stored key's algorithm changed");
  const signature = fromB64url(field(input.signature, "the signature", 1024), "the signature");
  if (!(await verifySignature(alg, key, signature, concat(raw, await sha256(cd))))) fail("signature", "the signature is not the passkey's");
  if ((a.counter !== 0 || stored.counter !== 0) && a.counter <= stored.counter) fail("counter", `the passkey's counter went from ${stored.counter} to ${a.counter}: a copy of the key may be in use`);
  return { counter: a.counter, flags: a.flags };
}
