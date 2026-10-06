#!/usr/bin/env node
// The recorded WebAuthn assertions the agent's tests check (#328): what the owner's
// browser answers the pool's documents with — a pin, a widening of the envelope, agent
// keys sealed to the host — made with the virtual authenticator of
// worker/test/soft-authenticator.mjs, and the keys sealed with the page's own
// sealAgentKey (worker/src/seal.ts). Valid ones, and one for each way a document the
// pool forged or replayed is refused on the host: no assertion, another credential,
// another origin or relying party, UP or UV missing, another challenge, host or type,
// a frame of another site, a signature that is not the key's; the lower or replayed
// version and the expired document are checked by the agent against its own record and
// clock. The documents are written as the pool writes them (worker/src/hosts.ts
// ownerDoc, whose test holds it to these).
//
// Needs node 22.6 or later (it reads the TypeScript of worker/src/seal.ts):
//   node --experimental-strip-types tests/owner-fixtures.mjs
// writes crates/omarchy-agent/tests/fixtures/owner/cases.json. The tests read the file,
// never run this: run it again only when the scheme changes, and commit what it wrote.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, b64url, createAuthenticator, EDDSA, ES256, RS256, sha256, UP, UV } from "../worker/test/soft-authenticator.mjs";
import { sealAgentKey } from "../worker/src/seal.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "crates/omarchy-agent/tests/fixtures/owner/cases.json");

const HOST = "h_0123456789";
const RP = "omarchy-pool.org";
const ORIGIN = "https://omarchy-pool.org";
const BY = "m1";
// The agent's tests run at 2027-01-15T08:00:00Z (run::fake::T0).
const ISSUED = "2027-01-15T07:55:00.000Z";
const NOT_AFTER = "2027-01-15T08:55:00.000Z";
const PIN_NOT_AFTER = "2027-01-15T08:10:00.000Z";

/** A document as the pool writes it (worker/src/hosts.ts ownerDoc): this key order. */
function ownerDoc(d) {
  const o = { schema: "omarchy-agent/owner/1", act: d.act, host: d.host ?? HOST };
  if (d.act !== "pin-passkey") o.version = d.version;
  Object.assign(o, { issued_at: d.issued_at ?? ISSUED, not_after: d.not_after ?? NOT_AFTER, by: BY });
  if (d.act === "pin-passkey") Object.assign(o, { rp_id: RP, origin: ORIGIN });
  if (d.act === "widen-envelope") o.envelope = d.envelope;
  if (d.act === "set-agent-keys") Object.assign(o, { seal_key: d.seal_key, keys: d.keys });
  return JSON.stringify(o);
}

const challengeOf = async (doc) => b64url(await sha256(doc));
/** The owner's passkey answering `doc` as a browser on the pool's page does; `o` makes one field wrong. */
async function answer(a, doc, o = {}) {
  return assert(a, { challenge: o.challenge ?? (await challengeOf(doc)), origin: o.origin ?? ORIGIN, rpId: RP, ...o });
}
/** The COSE key the pool stored at registration. */
const coseOf = (a) => {
  const enc = [];
  const head = (major, n) => (n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255]);
  const int = (i) => (i >= 0 ? head(0, i) : head(1, -1 - i));
  enc.push(...head(5, a.cose.size));
  for (const [k, v] of a.cose) {
    enc.push(...int(k));
    if (typeof v === "number") enc.push(...int(v));
    else enc.push(...head(2, v.length), ...v);
  }
  return b64url(new Uint8Array(enc));
};
/** The pin the site prints: base64url of {doc, assertion, public_key, alg}. */
const pinText = (doc, assertion, a) => b64url(new TextEncoder().encode(JSON.stringify({ doc, assertion, public_key: coseOf(a), alg: a.alg })));

const owner = await createAuthenticator({ alg: ES256 });
const other = await createAuthenticator({ alg: ES256 });
const ed = await createAuthenticator({ alg: EDDSA, keepsCounter: false });
const rsa = await createAuthenticator({ alg: RS256 });

// The host's seal key: its private half is the fixture's (the agent's tests load it).
const sealPair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
const sealJwk = await crypto.subtle.exportKey("jwk", sealPair.privateKey);
const otherSeal = await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])).privateKey);

const pinDoc = ownerDoc({ act: "pin-passkey", not_after: PIN_NOT_AFTER });
const pins = {};
for (const [name, a] of [["es256", owner], ["eddsa", ed], ["rs256", rsa]]) pins[name] = pinText(pinDoc, await answer(a, pinDoc), a);
const pinOtherHost = ownerDoc({ act: "pin-passkey", host: "h_9999999999", not_after: PIN_NOT_AFTER });
pins.other_host = pinText(pinOtherHost, await answer(owner, pinOtherHost), owner);
pins.no_uv = pinText(pinDoc, await answer(owner, pinDoc, { flags: UP }), owner);
pins.other_key = pinText(pinDoc, await answer(owner, pinDoc), other);

const widen = (version, envelope = { max_units: 8 }, extra = {}) => ownerDoc({ act: "widen-envelope", version, envelope, ...extra });
const v2 = widen(2);
const cases = {
  // The owner's widening: version 2, units up to 8 — then the same again (a replay), and a
  // version-1 document signed properly (a lower one).
  widen: { doc: v2, assertion: await answer(owner, v2) },
  widen_lower: { doc: widen(1, { max_units: 16 }), assertion: await answer(owner, widen(1, { max_units: 16 })) },
  // Each other algorithm the pool registers, pinned and signing a widening.
  widen_eddsa: { doc: v2, assertion: await answer(ed, v2) },
  widen_rs256: { doc: v2, assertion: await answer(rsa, v2) },
};
const refused = [
  ["another credential", { doc: v2, assertion: await answer(other, v2) }, "signed with another passkey"],
  ["another origin", { doc: v2, assertion: await answer(owner, v2, { origin: "https://evil.example" }) }, "made on \"https://evil.example\""],
  ["another relying party", { doc: v2, assertion: await answer(owner, v2, { signRpId: "evil.example" }) }, "another relying party"],
  ["no user present", { doc: v2, assertion: await answer(owner, v2, { flags: UV }) }, "nobody was present"],
  ["no user verification", { doc: v2, assertion: await answer(owner, v2, { flags: UP }) }, "did not verify the user"],
  ["a document changed after it was signed", { doc: widen(2, { max_units: 64 }), assertion: await answer(owner, v2) }, "not for this document"],
  ["another host's document", { doc: widen(2, { max_units: 8 }, { host: "h_9999999999" }), assertion: await answer(owner, widen(2, { max_units: 8 }, { host: "h_9999999999" })) }, "for host h_9999999999"],
  ["an expired document", { doc: widen(2, { max_units: 8 }, { issued_at: "2027-01-15T06:00:00.000Z", not_after: "2027-01-15T07:00:00.000Z" }), assertion: await answer(owner, widen(2, { max_units: 8 }, { issued_at: "2027-01-15T06:00:00.000Z", not_after: "2027-01-15T07:00:00.000Z" })) }, "expired at"],
  ["a registration's answer", { doc: v2, assertion: await answer(owner, v2, { type: "webauthn.create" }) }, "not webauthn.get"],
  ["a frame of another site", { doc: v2, assertion: await answer(owner, v2, { crossOrigin: true }) }, "frame of another site"],
  ["a signature that is not the pinned key's", { doc: v2, assertion: await answer(owner, v2, { signer: other }) }, "is not the pinned passkey's"],
  ["a widening of a key the owner keeps at the host", { doc: widen(2, { allow_socket: false }), assertion: await answer(owner, widen(2, { allow_socket: false })) }, "\"allow_socket\" is no key"],
];
cases.refused = refused.map(([why, c, says]) => ({ why, ...c, says }));

// Agent keys sealed to the host's seal key, version 3 (after the widening's 2).
const canary = "sk-ant-oat01-CANARY0fTheSealedKeyThatNeverReachesThePool0123456789";
const token = "ghp_CANARYpublicReadToken0123456789abcdefABCD";
const keysDoc = (keys, seal = sealJwk.x, version = 3) => ownerDoc({ act: "set-agent-keys", version, seal_key: seal, keys });
const sealed = [await sealAgentKey(sealJwk.x, HOST, "CLAUDE_CODE_OAUTH_TOKEN", canary), await sealAgentKey(sealJwk.x, HOST, "GITHUB_TOKEN", token), { name: "OPENAI_API_KEY", remove: true }];
const keys = keysDoc(sealed);
cases.keys = { doc: keys, assertion: await answer(owner, keys), values: { CLAUDE_CODE_OAUTH_TOKEN: canary, GITHUB_TOKEN: token } };
const toOther = keysDoc([await sealAgentKey(otherSeal.x, HOST, "CLAUDE_CODE_OAUTH_TOKEN", canary)], otherSeal.x);
const asOther = keysDoc([{ ...(await sealAgentKey(sealJwk.x, HOST, "OPENAI_API_KEY", canary)), name: "CLAUDE_CODE_OAUTH_TOKEN" }]);
const forOther = keysDoc([await sealAgentKey(sealJwk.x, "h_9999999999", "CLAUDE_CODE_OAUTH_TOKEN", canary)]);
const baseUrl = keysDoc([await sealAgentKey(sealJwk.x, HOST, "ANTHROPIC_BASE_URL", "https://evil.example")]);
cases.keys_refused = [
  ["sealed to another seal key", toOther, "sealed to another seal key"],
  ["sealed under another key's name", asOther, "does not open with this host's seal key"],
  ["sealed for another host", forOther, "does not open with this host's seal key"],
  ["a variable that is no agent key", baseUrl, "\"ANTHROPIC_BASE_URL\" is no agent key"],
].map(([why, doc, says]) => ({ why, doc, says }));
for (const c of cases.keys_refused) c.assertion = await answer(owner, c.doc);

const out = {
  note: "made by tests/owner-fixtures.mjs: the virtual authenticator's answers to the pool's documents, and keys sealed by worker/src/seal.ts",
  host: HOST,
  rp_id: RP,
  origin: ORIGIN,
  by: BY,
  seal: { private: sealJwk.d, public: sealJwk.x },
  pins,
  ...cases,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${OUT}`);
