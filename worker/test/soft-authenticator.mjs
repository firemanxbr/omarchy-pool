/**
 * A software authenticator for the tests (#257): what a passkey's
 * authenticator and the browser around it write — a key pair made with
 * WebCrypto, authenticatorData with the RP id's hash, the flags and the
 * counter, clientDataJSON with the ceremony's type, the challenge and the
 * origin, a COSE public key in an attestation object at registration, and a
 * signature over authenticatorData ‖ SHA-256(clientDataJSON) at each
 * assertion — so the Worker's own verifier (src/webauthn.ts) is exercised
 * against valid answers and against each way one can be wrong.
 *
 * Plain JavaScript and WebCrypto only, so the same module runs in the vitest
 * pool (workerd: test/webauthn.test.ts, test/passkeys.test.ts,
 * test/agent-tools.test.ts) and under Node for the end-to-end run
 * (tests/passkey.mjs, called by tests/e2e-worker.sh). It is a test double:
 * it keeps its private key in memory or in a file the test owns, and nothing
 * here is used by the Worker.
 */

export const ES256 = -7;
export const EDDSA = -8;
export const RS256 = -257;
export const UP = 0x01;
export const UV = 0x04;
export const AT = 0x40;
export const ED = 0x80;

const enc = new TextEncoder();

export function b64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(s) {
  const t = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}

// ---------- CBOR, the encoder side: what an authenticator writes ----------

function head(major, n) {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  if (n < 0x100000000) return new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const hi = Math.floor(n / 0x100000000), lo = n >>> 0;
  return new Uint8Array([(major << 5) | 27, (hi >>> 24) & 0xff, (hi >> 16) & 0xff, (hi >> 8) & 0xff, hi & 0xff, (lo >>> 24) & 0xff, (lo >> 16) & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
}

/** CBOR of an integer, bytes, a string, an array, a Map (keys in their order), a plain object (string keys), true, false or null. */
export function cbor(v) {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (typeof v === "string") {
    const b = enc.encode(v);
    return concat(head(3, b.length), b);
  }
  if (Array.isArray(v)) return concat(head(4, v.length), ...v.map(cbor));
  if (v instanceof Map) return concat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
  if (v === false) return new Uint8Array([0xf4]);
  if (v === true) return new Uint8Array([0xf5]);
  if (v === null) return new Uint8Array([0xf6]);
  if (typeof v === "object") return cbor(new Map(Object.entries(v)));
  throw new Error(`cbor: ${typeof v}`);
}

// ---------- signatures ----------

/** A raw P-256 signature (r‖s, what WebCrypto signs) as the DER an authenticator sends. */
export function rawToDer(raw) {
  const int = (x) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    const v = x.subarray(i);
    return v[0] & 0x80 ? concat(new Uint8Array([0x02, v.length + 1, 0]), v) : concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

const ALGS = {
  [ES256]: { gen: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" } },
  [RS256]: { gen: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, sign: { name: "RSASSA-PKCS1-v1_5" } },
  [EDDSA]: { gen: { name: "Ed25519" }, sign: { name: "Ed25519" } },
};

/** The COSE public key (RFC 9053) of a JWK, as an authenticator writes it. */
function coseOf(alg, jwk) {
  if (alg === ES256) return new Map([[1, 2], [3, ES256], [-1, 1], [-2, unb64url(jwk.x)], [-3, unb64url(jwk.y)]]);
  if (alg === RS256) return new Map([[1, 3], [3, RS256], [-1, unb64url(jwk.n)], [-2, unb64url(jwk.e)]]);
  return new Map([[1, 1], [3, EDDSA], [-1, 6], [-2, unb64url(jwk.x)]]);
}

/**
 * A new authenticator with one credential: `alg` ES256 (the default), RS256
 * or EdDSA; `keepsCounter` false for one whose counter stays zero, as many
 * synced passkeys do.
 */
export async function createAuthenticator({ alg = ES256, keepsCounter = true, credentialId } = {}) {
  const keyPair = await crypto.subtle.generateKey(ALGS[alg].gen, true, ["sign", "verify"]);
  const id = credentialId ?? crypto.getRandomValues(new Uint8Array(32));
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return { alg, keyPair, credentialId: id, cose: coseOf(alg, jwk), counter: 0, keepsCounter };
}

/** An authenticator as a file keeps it (tests/passkey.mjs): the key pair as JWK, the credential, the counter. */
export async function saveAuthenticator(a) {
  return { alg: a.alg, credentialId: b64url(a.credentialId), counter: a.counter, keepsCounter: a.keepsCounter, privateKey: await crypto.subtle.exportKey("jwk", a.keyPair.privateKey), publicKey: await crypto.subtle.exportKey("jwk", a.keyPair.publicKey) };
}

export async function loadAuthenticator(s) {
  const usage = (k) => (k === "privateKey" ? ["sign"] : ["verify"]);
  const keyPair = {};
  for (const k of ["privateKey", "publicKey"]) keyPair[k] = await crypto.subtle.importKey("jwk", s[k], ALGS[s.alg].gen, true, usage(k));
  return { alg: s.alg, keyPair, credentialId: unb64url(s.credentialId), cose: coseOf(s.alg, s.publicKey), counter: s.counter, keepsCounter: s.keepsCounter };
}

/** The authenticator's signature over `data`, in WebAuthn's shape: DER for ES256. */
export async function sign(a, data) {
  const sig = new Uint8Array(await crypto.subtle.sign(ALGS[a.alg].sign, a.keyPair.privateKey, data));
  return a.alg === ES256 ? rawToDer(sig) : sig;
}

// ---------- the two ceremonies ----------

/** authenticatorData: the RP id's hash, the flags, the counter (big-endian), then the attested credential and the extensions the flags announce. */
export async function authenticatorData({ rpId, flags, counter, attested = null, extensions = null }) {
  const c = new Uint8Array([(counter >>> 24) & 0xff, (counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff]);
  const parts = [await sha256(rpId), new Uint8Array([flags]), c];
  if (attested) parts.push(attested.aaguid ?? new Uint8Array(16), new Uint8Array([attested.credentialId.length >> 8, attested.credentialId.length & 0xff]), attested.credentialId, cbor(attested.cose));
  if (extensions) parts.push(cbor(extensions));
  return concat(...parts);
}

export function clientDataJSON({ type, challenge, origin, crossOrigin = false }) {
  return enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin }));
}

/**
 * A registration, as navigator.credentials.create() answers it: the body
 * POST /auth/passkeys takes, less the label. Every field can be made wrong
 * on purpose: another type, origin, RP id, flags, format or statement.
 */
export async function register(a, o) {
  const flags = o.flags ?? (UP | UV | AT);
  const raw = await authenticatorData({ rpId: o.signRpId ?? o.rpId, flags, counter: a.counter, attested: flags & AT ? { credentialId: a.credentialId, cose: o.cose ?? a.cose, aaguid: o.aaguid } : null, extensions: o.extensions ?? null });
  const att = new Map([["fmt", o.fmt ?? "none"], ["attStmt", o.attStmt ?? new Map()], ["authData", raw]]);
  return {
    id: b64url(o.id ?? a.credentialId),
    clientDataJSON: b64url(clientDataJSON({ type: o.type ?? "webauthn.create", challenge: o.challenge, origin: o.origin, crossOrigin: o.crossOrigin })),
    attestationObject: b64url(cbor(att)),
  };
}

/**
 * An assertion, as navigator.credentials.get() answers it, in the fields
 * the confirm page's form posts. The counter moves by one each time unless
 * the authenticator keeps none, or the test names one (`counter`).
 */
export async function assert(a, o) {
  if (o.counter !== undefined) a.counter = o.counter;
  else if (a.keepsCounter) a.counter += 1;
  const raw = await authenticatorData({ rpId: o.signRpId ?? o.rpId, flags: o.flags ?? (UP | UV), counter: a.counter, extensions: o.extensions ?? null });
  const cd = clientDataJSON({ type: o.type ?? "webauthn.get", challenge: o.challenge, origin: o.origin, crossOrigin: o.crossOrigin });
  const signature = await sign(o.signer ?? a, concat(raw, await sha256(o.signedClientData ?? cd)));
  return {
    credential: b64url(o.credentialId ?? a.credentialId),
    client_data: b64url(cd),
    authenticator_data: b64url(raw),
    signature: b64url(signature),
    user_handle: o.userHandle ?? "",
  };
}
