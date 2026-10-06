/**
 * An agent key sealed to a host in the owner's browser (#328, design v2 §14): the pool
 * relays only what this returns, and only the host opens it — its agent's half is
 * crates/omarchy-agent/src/owner/seal.rs, which this must match byte for byte:
 *
 *   info   = "omarchy-agent/seal/1\n" + host id + "\n" + the key's name
 *   shared = X25519(a fresh ephemeral private key, the host's seal key)
 *   key    = HKDF-SHA256(ikm = shared, salt = epk ‖ host's seal key, info) → AES-256
 *   ct     = AES-256-GCM(key, nonce = 12 random bytes, the value, additionalData = info)
 *
 * and {name, epk, nonce, ct}, each base64url without padding. The host's seal key is the
 * one its agent reports and its owner confirmed on the host page; `info` binds the
 * ciphertext to that host and that key's name, so the pool can neither read it nor
 * present it as another key or to another host. Sealing is not signing — anyone may seal
 * to a public key — so a sealed key reaches the host only inside a document the owner's
 * passkey signed, which the host checks against the passkey pinned there.
 *
 * The host page inlines this function's own source (pages/host.ts:
 * `sealAgentKey.toString()`), so the browser seals with exactly the code the tests run.
 * That is why it is written the way it is: WebCrypto and the runtime's globals only — no
 * import, no helper, no function defined inside it (the bundler would wrap one in a
 * helper of its own that a page does not have).
 */
export const SEAL_INFO = "omarchy-agent/seal/1";
/** The longest value a sealed key may hold (bytes), as the agent opens one. */
export const SEAL_VALUE_MAX = 1024;

export interface SealedKey { name: string; epk: string; nonce: string; ct: string }

export async function sealAgentKey(sealKey: string, host: string, name: string, value: string): Promise<SealedKey> {
  if (!/^[\x21-\x7e]{1,1024}$/.test(value)) throw new Error(`${name}: one line of printable characters, no space, at most 1024`);
  const raw = atob(sealKey.replace(/-/g, "+").replace(/_/g, "/"));
  const pub = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) pub[i] = raw.charCodeAt(i);
  if (pub.length !== 32) throw new Error("the host's seal key is not an X25519 key");
  const enc = new TextEncoder();
  const hostKey = await crypto.subtle.importKey("raw", pub, { name: "X25519" }, false, []);
  const eph = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const epk = new Uint8Array((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: hostKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, eph.privateKey, 256);
  const info = enc.encode("omarchy-agent/seal/1\n" + host + "\n" + name);
  const salt = new Uint8Array(64);
  salt.set(epk, 0);
  salt.set(pub, 32);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: info }, key, enc.encode(value)));
  const out: string[] = [];
  for (const b of [epk, nonce, ct]) {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    out.push(btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  }
  return { name, epk: out[0], nonce: out[1], ct: out[2] };
}
