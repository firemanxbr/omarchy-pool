/**
 * The owner's control without a visit (#328, epic #307, design v2 §12, §14,
 * D6 b), through the Worker with real Ed25519 host keys, real passkeys (the
 * software authenticator, the virtual authenticator the agent's recorded
 * fixtures were made with) and the page's own sealAgentKey:
 *
 * - Make a pin: the document this host's page asks for (the host, the page's
 *   relying party, ten minutes), any of the owner's passkeys over it, and the
 *   pin the owner pastes at the host — the document, the assertion, and the
 *   passkey's public key as it was registered.
 * - The seal key the agent reports (signed with its host key), and its
 *   owner's confirmation with a passkey.
 * - A widening and agent keys: the document the pool writes (a version above
 *   every one the host was given or took), signed by the passkey pinned at
 *   the host alone, relayed whole in the signed host state; the doors refuse
 *   a contributor, another maintainer, an agent before 0.4.0, a document the
 *   pool did not write or changed, another host's, an assertion for another
 *   act, keys sealed to a key nobody confirmed.
 * - The pool's database holds only ciphertext for agent keys: a key sealed in
 *   the browser to the host's seal key is found in no row of any table — in
 *   no encoding — while the host state carries it whole, and it opens with the
 *   host's private key to the value sealed.
 * - The contract with the agent, written once: the documents of the agent's
 *   recorded fixtures (crates/omarchy-agent/tests/fixtures/owner/cases.json)
 *   are byte for byte what ownerDoc writes; the fixtures' sealed keys open
 *   with the opener here, which opens the page's too; report-owner.json reads
 *   back field by field.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { fromB64url, toB64url } from "../src/webauthn";
import { enrollMessage, ownerDoc, readOwnerDoc, reportedOwnerOf, sealedKeys, sealKeyOf, signedMessage, widening, AGENT_KEY_NAMES, WIDENABLE } from "../src/hosts";
import { OWNER_VERSION_SQL, hostVerdicts } from "../src/routes/hosts";
import { SUBJECT } from "../src/routes/passkeys";
import { sealAgentKey, type SealedKey } from "../src/seal";
import { hostHtml } from "../src/pages/host";
import { assert as answer, b64url, createAuthenticator, register, unb64url, UP, UV } from "./soft-authenticator.mjs";
import { runScript, scriptOf } from "./fixture";
import casesFixture from "../../crates/omarchy-agent/tests/fixtures/owner/cases.json?raw";
import ownerReport from "../../crates/omarchy-agent/tests/fixtures/host-api/report-owner.json?raw";

const ORIGIN = "http://localhost:8787";
const STUDIO = { cpus: 12, mem_gb: 32, disk_free_gb: { work: 410, engine: 220 }, units: 11, job_reserved: 1, agent_slots: 2, lanes: [{ arch: "aarch64", mode: "native" }] };
const CANARY = "sk-ant-oat01-CANARYsealedInTheBrowserNeverInD1-0123456789abcdefABCDEF";
const cases = JSON.parse(casesFixture);

interface Res { status: number; json: any }
async function call(method: string, path: string, opts: { session?: string; token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.session) { headers.cookie = `omc=oms_${opts.session}`; headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  Object.assign(headers, opts.headers ?? {});
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path.startsWith("/auth/") ? "" : "/api/v1"}${path}`, { method, headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

interface Key { pub: string; priv: CryptoKey }
async function newKey(): Promise<Key> {
  const k = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { pub: toB64url(new Uint8Array((await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer)), priv: k.privateKey };
}
const sign = async (k: Key, msg: string) => toB64url(await crypto.subtle.sign({ name: "Ed25519" }, k.priv, new TextEncoder().encode(msg)));
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function signed(k: Key, host: string, method: string, path: string, body = ""): Promise<Res> {
  const ts = Math.floor(Date.now() / 1000), nonce = hex(16);
  const sig = await sign(k, signedMessage(host, method, `/api/v1${path}`, await sha(body), ts, nonce));
  return call(method, path, { raw: method === "GET" ? undefined : body, headers: { "omarchy-host": `${host}; ts=${ts}; nonce=${nonce}; sig=${sig}` } });
}
const state = (k: Key, host: string) => signed(k, host, "GET", "/hosts/self/state");
const report = (k: Key, host: string, r: unknown) => signed(k, host, "POST", "/hosts/self/report", JSON.stringify(r));

async function activeHost(owner: string, name: string, agent = "0.4.0"): Promise<{ k: Key; host: string; worker: string }> {
  const k = await newKey();
  const m = await call("POST", "/hosts/enrollments", { session: owner, body: { name } });
  expect(m.status, JSON.stringify(m.json)).toBe(201);
  const e = await call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(k, enrollMessage(m.json.token, k.pub)), hostname: "box-1", os: "linux", arch: "aarch64", page_kb: 16, isolation: "root", dedicated: true, agent_version: agent, capacity: STUDIO } });
  expect(e.status, JSON.stringify(e.json)).toBe(201);
  const c = await call("POST", `/hosts/${e.json.host}/confirm`, { session: owner, body: {} });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { k, host: e.json.host, worker: c.json.worker };
}

const keys: Record<string, Awaited<ReturnType<typeof createAuthenticator>>> = {};
async function registerFor(login: string): Promise<void> {
  const a = await createAuthenticator();
  const o = await call("POST", "/auth/passkeys/challenge", { session: login, body: {} });
  const reg = await call("POST", "/auth/passkeys", { session: login, body: { label: "laptop", ...(await register(a, { challenge: o.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost" })) } });
  expect(reg.status, JSON.stringify(reg.json)).toBe(201);
  keys[login] = a;
}
/** An act's assertion through the shell's door (POST /auth/passkeys/assert), as passkeyed() asks it. */
async function actAssertion(login: string, subject: string): Promise<Record<string, string>> {
  const c = await call("POST", "/auth/passkeys/assert", { session: login, body: { for: subject } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return answer(keys[login], { challenge: c.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost" });
}
/** What the page's signDoc does: the pool's document and challenge, the owner's passkey over it. `o` makes the answer wrong on purpose. */
async function signDoc(login: string, host: string, body: Record<string, unknown>, o: Record<string, unknown> = {}): Promise<{ doc: string; assertion: Record<string, string>; challenge: Res }> {
  const c = await call("POST", `/hosts/${host}/owner/challenge`, { session: login, body });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const assertion = await answer(keys[login], { challenge: c.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost", ...o });
  return { doc: c.json.doc, assertion, challenge: c };
}

/** The host's X25519 seal key, as its agent keeps it: the private half here, the public half reported. */
async function sealPair(): Promise<{ priv: CryptoKey; pub: string }> {
  const k = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { priv: k.privateKey, pub: toB64url(new Uint8Array((await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer)) };
}
/** The host's half of the seal (crates/omarchy-agent/src/owner/seal.rs), in WebCrypto: what only the host can do. */
async function openSealed(priv: CryptoKey, hostPub: string, host: string, s: SealedKey): Promise<string> {
  const epk = fromB64url(s.epk), pub = fromB64url(hostPub);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: await crypto.subtle.importKey("raw", epk, { name: "X25519" }, false, []) } as unknown as SubtleCryptoDeriveKeyAlgorithm, priv, 256);
  const info = new TextEncoder().encode(`omarchy-agent/seal/1\n${host}\n${s.name}`);
  const salt = new Uint8Array(64);
  salt.set(epk, 0);
  salt.set(pub, 32);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, ikm, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(s.nonce), additionalData: info }, key, fromB64url(s.ct)));
}

/** The agent's report with its owner part: the passkey pinned at it (`credential`, made on this page), and its seal key. */
const ownerPart = (credential: string | null, seal: string, version = 0) => ({
  agent: { version: "0.4.0" }, release: { applied: "v1.20.0" }, orders: [],
  owner: {
    passkey: credential ? { credential, alg: "ES256", rp_id: "localhost", origin: ORIGIN, by: "m1", pinned_at: "2027-01-15T08:00:00Z" } : null,
    version, seal: { key: seal, fingerprint: "SHA256:x" },
    envelope: { max_units: 3, max_cpus: null, max_mem_gb: null, emulate: ["x86_64"], agent_slots: 2, agent_budget: null, diagnostics: false, paths: null },
    agent_keys: ["GEMINI_API_KEY"],
  },
});

beforeAll(async () => {
  const people: [string, string, number | null][] = [["m1", "maintainer", 1001], ["m2", "maintainer", 1002], ["alice", "contributor", 2001]];
  await env.DB.batch(await Promise.all(people.map(async ([l, role, g]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES (?, ?, ?, ?, ?)").bind(l, await sha256Hex(`omc_${l}`), await sha256Hex(`oms_${l}`), role, g))));
  await applyGovernance(env, ["m1", "m2"], "sha-owner");
  for (const m of ["m1", "m2"]) await registerFor(m);
});

describe("the D1 migration (0049)", () => {
  it("takes the two owner orders in host_orders, with its rows and indexes, and adds the seal key's columns", async () => {
    const cols = async (t: string) => (await env.DB.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((r) => r.name);
    expect(await cols("host_orders")).toEqual(["id", "host_id", "kind", "issued_by", "via", "confirmed_with", "issued_at", "not_after", "state", "answered_at", "detail", "arg"]);
    expect(await cols("hosts")).toEqual(expect.arrayContaining(["seal_key", "seal_confirmed"]));
    for (const kind of ["retire-legacy", "set-units", "diagnostics", "widen-envelope", "set-agent-keys"]) {
      await env.DB.prepare("INSERT INTO host_orders (id, host_id, kind, issued_by, not_after) VALUES (?, 'h_mig0000049', ?, 'm1', '2030-01-01T00:00:00.000Z')").bind(`ho_${kind}`, kind).run();
    }
    await expect(env.DB.prepare("INSERT INTO host_orders (id, host_id, kind, issued_by, not_after) VALUES ('ho_x', 'h_mig0000049', 'shell', 'm1', '2030-01-01T00:00:00.000Z')").run()).rejects.toThrow(/CHECK/);
    // One open order per kind and host, still enforced by the engine.
    await expect(env.DB.prepare("INSERT INTO host_orders (id, host_id, kind, issued_by, not_after) VALUES ('ho_y', 'h_mig0000049', 'widen-envelope', 'm1', '2030-01-01T00:00:00.000Z')").run()).rejects.toThrow(/UNIQUE/);
    const indexes = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'host_orders'").all<{ name: string }>()).results.map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["uq_host_orders_open_kind", "idx_host_orders_host", "idx_host_orders_open_until"]));
    const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${OWNER_VERSION_SQL}`).bind("h_mig0000049").all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    expect(plan).toMatch(/USING INDEX (idx_host_orders_host|uq_host_orders_open_kind) \(host_id=\?/);
    await env.DB.prepare("DELETE FROM host_orders WHERE host_id = 'h_mig0000049'").run();
  });
});

describe("the documents, the widening and the sealed keys (pure)", () => {
  it("writes byte for byte the documents the agent's recorded fixtures were signed over", () => {
    for (const doc of [cases.widen.doc, cases.widen_lower.doc, cases.keys.doc, ...cases.refused.map((r: { doc: string }) => r.doc), ...cases.keys_refused.map((r: { doc: string }) => r.doc)]) {
      expect(readOwnerDoc(doc), doc).not.toBeNull();
    }
    const pin = JSON.parse(new TextDecoder().decode(fromB64url(cases.pins.es256)));
    expect(readOwnerDoc(pin.doc)).toMatchObject({ act: "pin-passkey", host: "h_0123456789", rp_id: "omarchy-pool.org", origin: "https://omarchy-pool.org" });
    // A document the pool did not write so — another key order, a space — is none of its.
    const d = JSON.parse(cases.widen.doc);
    expect(readOwnerDoc(JSON.stringify(d, null, 1))).toBeNull();
    expect(readOwnerDoc(JSON.stringify({ ...d, extra: 1 }))).toBeNull();
    expect(readOwnerDoc(ownerDoc(d))).toEqual(d);
  });

  it("checks a proposed envelope as the agent does: its keys, their types and ranges", () => {
    expect(widening({ max_units: 8, emulate: ["x86_64"], agent_budget: { calls_per_day: 9000 }, diagnostics: true, paths: ["/srv/a"], max_cpus: null })).toEqual({ max_units: 8, emulate: ["x86_64"], agent_budget: { calls_per_day: 9000 }, diagnostics: true, paths: ["/srv/a"], max_cpus: null });
    for (const [v, says] of [
      [{}, "at least one key"], [{ allow_socket: true }, "allow_socket is no key"], [{ soak_minutes: 0 }, "soak_minutes is no key"], [{ max_units: 0 }, "1 to 4096"],
      [{ max_units: 5000 }, "1 to 4096"], [{ emulate: ["riscv64"] }, "distinct architectures"], [{ diagnostics: null }, "null is not"],
      [{ agent_budget: { calls_per_hour: 1 } }, "calls_per_hour"], [{ paths: ["/"] }, "plain absolute"], [{ paths: ["/srv/../etc"] }, "plain absolute"], [[], "an object"],
      // The agent's own bounds per budget key: the calls a u32 (dispatcher_env Budget::from_envelope), the tokens and minutes at most 1e12.
      [{ agent_budget: { calls_per_day: 4294967296 } }, "from 1 to 4294967295"], [{ agent_budget: { calls_per_task: 5e9 } }, "from 1 to 4294967295"],
      [{ agent_budget: { tokens_per_task: 1e12 + 1 } }, "from 1 to 1000000000000"], [{ agent_budget: { minutes_per_task: 0 } }, "from 1 to"],
    ] as [unknown, string][]) {
      expect(widening(v), JSON.stringify(v)).toContain(says);
    }
    expect(widening({ agent_budget: { calls_per_day: 4294967295, calls_per_task: 1, tokens_per_task: 1e12, minutes_per_task: 1e12 } })).toEqual({ agent_budget: { calls_per_day: 4294967295, calls_per_task: 1, tokens_per_task: 1e12, minutes_per_task: 1e12 } });
    expect(WIDENABLE).toEqual(["max_units", "max_cpus", "max_mem_gb", "emulate", "agent_slots", "agent_budget", "diagnostics", "paths"]);
  });

  it("takes sealed keys of the six agent keys only, each once, sealed or taken out", async () => {
    const k = await sealPair();
    const s = await sealAgentKey(k.pub, "h_0123456789", "GITHUB_TOKEN", "ghp_x");
    expect(sealedKeys([s, { name: "OPENAI_API_KEY", remove: true }])).toEqual([s, { name: "OPENAI_API_KEY", remove: true }]);
    for (const [v, says] of [
      [[], "one to 6"], [[{ ...s, name: "ANTHROPIC_BASE_URL" }], "each names one of"], [[s, s], "named twice"], [[{ ...s, remove: true }], "taken out and sealed at once"],
      [[{ ...s, ct: "short" }], "not sealed as the page seals"], [[{ ...s, nonce: s.nonce + "AA" }], "not sealed as the page seals"],
    ] as [unknown, string][]) {
      expect(sealedKeys(v), JSON.stringify(v)).toContain(says);
    }
    expect(AGENT_KEY_NAMES).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "GITHUB_TOKEN"]);
  });

  it("seals as the host opens: the page's value opens with the host's key, bound to the host and the name; the fixtures' too", async () => {
    const k = await sealPair();
    const s = await sealAgentKey(k.pub, "h_0123456789", "CLAUDE_CODE_OAUTH_TOKEN", CANARY);
    expect(s.name).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.stringify(s)).not.toContain(CANARY);
    expect(await openSealed(k.priv, k.pub, "h_0123456789", s)).toBe(CANARY);
    await expect(openSealed(k.priv, k.pub, "h_9999999999", s)).rejects.toThrow();
    await expect(openSealed(k.priv, k.pub, "h_0123456789", { ...s, name: "ANTHROPIC_API_KEY" })).rejects.toThrow();
    await expect(sealAgentKey(k.pub, "h_0123456789", "GITHUB_TOKEN", "two words")).rejects.toThrow(/printable/);
    // The agent's recorded keys: sealed by the same function, opened by the host's private key.
    const priv = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "X25519", d: cases.seal.private, x: cases.seal.public }, { name: "X25519" }, false, ["deriveBits"]);
    const doc = JSON.parse(cases.keys.doc);
    expect(await openSealed(priv, cases.seal.public, "h_0123456789", doc.keys[0])).toBe(cases.keys.values.CLAUDE_CODE_OAUTH_TOKEN);
    // The page seals with this very function: its source is inlined in the host page.
    expect(hostHtml("h_0123456789", "http://pool.test", { version: "test", deployed_at: null } as never)).toContain(sealAgentKey.toString());
  });

  it("reads the owner's part of a report as the agent writes it (report-owner.json)", () => {
    const o = reportedOwnerOf(ownerReport)!;
    expect(o.passkey).toEqual({ credential: cases.widen.assertion.credential, alg: "ES256", rp_id: "omarchy-pool.org", origin: "https://omarchy-pool.org", by: "m1", pinned_at: "2027-01-15T08:00:00Z" });
    expect(o.version).toBe(3);
    expect(o.seal).toEqual({ key: cases.seal.public, fingerprint: "SHA256:wIwZGH0JYi29ol7KfewxDD04AEppH3Sn1BWJ8Ci2GsI" });
    expect(o.envelope).toMatchObject({ max_units: 8, emulate: ["x86_64"], agent_budget: { calls_per_day: 5000, calls_per_task: 200 } });
    expect(o.agent_keys).toEqual(["GEMINI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN"]);
    expect(sealKeyOf(cases.seal.public)).toBe(cases.seal.public);
    expect(sealKeyOf("x".repeat(43) + "=")).toBeNull();
    // An envelope value of another shape is shown as none, never as the agent's word.
    const odd = JSON.parse(ownerReport);
    odd.owner.envelope.max_units = "eight";
    odd.owner.passkey.credential = "not base64url!";
    const r = reportedOwnerOf(JSON.stringify(odd))!;
    expect((r.envelope as Record<string, unknown>).max_units).toBeNull();
    expect(r.passkey).toBeNull();
    expect(SUBJECT.test("host:seal-key:h_0123456789") && SUBJECT.test("host:widen-envelope:h_0123456789") && SUBJECT.test("host:set-agent-keys:h_0123456789") && SUBJECT.test("host:pin-passkey:h_0123456789")).toBe(true);
  });
});

describe("an owner widens the envelope and sets agent keys from the browser", () => {
  it("pins a passkey, confirms the seal key, widens the units and seals a key — and the pool's database holds only ciphertext", async () => {
    const h = await activeHost("m1", "box-owner");
    const seal = await sealPair();
    // The agent reports its seal key (signed with its host key); no passkey pinned yet.
    expect((await report(h.k, h.host, ownerPart(null, seal.pub))).status).toBe(200);
    let g = await call("GET", `/hosts/${h.host}`, { session: "m1" });
    expect(g.json.host.seal).toMatchObject({ key: seal.pub, confirmed: null });
    expect(g.json.host.seal.fingerprint).toMatch(/^SHA256:/);
    expect(g.json.can.owner).toBe(true);
    // Nothing pinned: a widening is refused before the device is asked.
    const early = await call("POST", `/hosts/${h.host}/owner/challenge`, { session: "m1", body: { act: "widen-envelope", envelope: { max_units: 8 } } });
    expect([early.status, early.json.code]).toEqual([409, "not_pinned"]);

    // Make a pin: any of m1's passkeys over the pool's document; the pin carries its public key as registered.
    const p = await signDoc("m1", h.host, { act: "pin-passkey" });
    expect(readOwnerDoc(p.doc)).toMatchObject({ act: "pin-passkey", host: h.host, by: "m1", rp_id: "localhost", origin: ORIGIN });
    expect(p.challenge.json.publicKey.allowCredentials).toHaveLength(1);
    const pin = await call("POST", `/hosts/${h.host}/owner/pin`, { session: "m1", body: { doc: p.doc, assertion: p.assertion } });
    expect(pin.status, JSON.stringify(pin.json)).toBe(200);
    expect(pin.json.command).toBe(`omarchy-agent envelope pin-passkey ${pin.json.pin}`);
    const text = JSON.parse(new TextDecoder().decode(fromB64url(pin.json.pin)));
    const stored = await env.DB.prepare("SELECT credential_id, public_key, alg FROM passkeys WHERE login = 'm1'").first<{ credential_id: string; public_key: string; alg: number }>();
    expect(text).toEqual({ doc: p.doc, assertion: p.assertion, public_key: stored!.public_key, alg: stored!.alg });
    // The same answer twice: its challenge was taken.
    const again = await call("POST", `/hosts/${h.host}/owner/pin`, { session: "m1", body: { doc: p.doc, assertion: p.assertion } });
    expect([again.status, again.json.code]).toEqual([403, "challenge"]);

    // Pasted at the host: its agent reports the pin.
    expect((await report(h.k, h.host, ownerPart(stored!.credential_id, seal.pub))).status).toBe(200);
    // Agent keys wait for the seal key's confirmation.
    const unconfirmed = await call("POST", `/hosts/${h.host}/owner/challenge`, { session: "m1", body: { act: "set-agent-keys", keys: [await sealAgentKey(seal.pub, h.host, "CLAUDE_CODE_OAUTH_TOKEN", CANARY)] } });
    expect([unconfirmed.status, unconfirmed.json.code]).toEqual([409, "seal_key"]);
    // Confirm the seal key, with a passkey: another key than the one reported is refused.
    const wrongKey = await call("POST", `/hosts/${h.host}/seal-key`, { session: "m1", body: { key: (await sealPair()).pub, assertion: await actAssertion("m1", `host:seal-key:${h.host}`) } });
    expect([wrongKey.status, wrongKey.json.code]).toEqual([409, "seal_key"]);
    const conf = await call("POST", `/hosts/${h.host}/seal-key`, { session: "m1", body: { key: seal.pub, assertion: await actAssertion("m1", `host:seal-key:${h.host}`) } });
    expect(conf.status, JSON.stringify(conf.json)).toBe(200);
    g = await call("GET", `/hosts/${h.host}`, { session: "m1" });
    expect(g.json.host.seal.confirmed).toMatchObject({ by: "m1", current: true });
    expect(g.json.host.owner_control.passkey.credential).toBe(stored!.credential_id);
    // `owner` stays the owner's login in the detailed view too: the Confirm button and every owner link read it.
    expect(g.json.host.owner).toBe("m1");

    // Widen: the document names the host, the proposed envelope and a version above every one; the pinned passkey alone may answer.
    const w = await signDoc("m1", h.host, { act: "widen-envelope", envelope: { max_units: 8, agent_budget: { calls_per_day: 9000 } } });
    expect(w.challenge.json.publicKey.allowCredentials).toEqual([{ type: "public-key", id: stored!.credential_id }]);
    expect(JSON.parse(w.doc)).toMatchObject({ act: "widen-envelope", host: h.host, version: 1, by: "m1", envelope: { max_units: 8, agent_budget: { calls_per_day: 9000 } } });
    const wo = await call("POST", `/hosts/${h.host}/orders`, { session: "m1", body: { kind: "widen-envelope", doc: w.doc, assertion: w.assertion } });
    expect(wo.status, JSON.stringify(wo.json)).toBe(201);
    expect(wo.json.order.arg).toEqual({ version: 1, envelope: { max_units: 8, agent_budget: { calls_per_day: 9000 } } });

    // Seal a key in the browser, sign it, relay it.
    const sealed = await sealAgentKey(seal.pub, h.host, "CLAUDE_CODE_OAUTH_TOKEN", CANARY);
    const k = await signDoc("m1", h.host, { act: "set-agent-keys", keys: [sealed, { name: "OPENAI_API_KEY", remove: true }] });
    expect(JSON.parse(k.doc)).toMatchObject({ act: "set-agent-keys", version: 2, seal_key: seal.pub });
    const ko = await call("POST", `/hosts/${h.host}/orders`, { session: "m1", body: { kind: "set-agent-keys", doc: k.doc, assertion: k.assertion } });
    expect(ko.status, JSON.stringify(ko.json)).toBe(201);
    expect(ko.json.order.arg).toEqual({ version: 2, keys: ["CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY (taken out)"] });

    // The agent's host state carries both documents and their assertions whole: what the host checks against the passkey pinned there.
    const s = await state(h.k, h.host);
    expect(s.status).toBe(200);
    const widen = s.json.orders.find((o: { kind: string }) => o.kind === "widen-envelope");
    expect(widen).toMatchObject({ doc: w.doc, assertion: { credential: w.assertion.credential, client_data: w.assertion.client_data, authenticator_data: w.assertion.authenticator_data, signature: w.assertion.signature }, version: 1 });
    const keysOrder = s.json.orders.find((o: { kind: string }) => o.kind === "set-agent-keys");
    expect(keysOrder.doc).toBe(k.doc);
    // ...and the sealed key in it opens with the host's private key alone, to what the owner typed.
    expect(await openSealed(seal.priv, seal.pub, h.host, JSON.parse(keysOrder.doc).keys[0])).toBe(CANARY);

    // The pool's database: the plaintext is in no row of any table, in any encoding.
    const enc = new TextEncoder().encode(CANARY);
    let bin = "";
    for (const b of enc) bin += String.fromCharCode(b);
    const forms = [CANARY, btoa(bin), btoa(bin).replace(/=+$/, ""), toB64url(enc), [...enc].map((b) => b.toString(16).padStart(2, "0")).join(""), CANARY.slice(13, 50)];
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>()).results.map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["host_orders", "events", "hosts", "passkey_challenges"]));
    for (const t of tables) {
      const rows = JSON.stringify((await env.DB.prepare(`SELECT * FROM "${t}"`).all()).results);
      for (const f of forms) expect(rows.includes(f), `${t} holds the key (as ${f.slice(0, 12)}…)`).toBe(false);
    }
    // The page shows the orders' versions and names, never the document or a ciphertext.
    g = await call("GET", `/hosts/${h.host}`, { session: "m1" });
    const shown = JSON.stringify(g.json.orders);
    expect(shown).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(shown).not.toContain(sealed.ct);
    expect(shown).not.toContain(w.assertion.signature);

    // The agent answers in its report: the orders close, on the journal in the pool's words.
    const answered = { ...ownerPart(stored!.credential_id, seal.pub, 2), orders: [{ id: wo.json.order.id, kind: "widen-envelope", outcome: "done", detail: "m1's passkey widened the envelope (version 1): max_units 3 → 8", at: "2027-01-15T08:02:16Z" }, { id: ko.json.order.id, kind: "set-agent-keys", outcome: "done", detail: "m1's passkey (version 2): CLAUDE_CODE_OAUTH_TOKEN set", at: "2027-01-15T08:02:22Z" }] };
    const r = await report(h.k, h.host, answered);
    expect(r.json.orders_closed).toBe(2);
    // The next document is above the version the host reports taking.
    const next = await signDoc("m1", h.host, { act: "widen-envelope", envelope: { max_units: 4 } });
    expect(JSON.parse(next.doc).version).toBe(3);
  });

  it("keeps `owner` the owner's login for everyone, pending or active, in the list and the detailed view", async () => {
    const h = await activeHost("m1", "box-login");
    const seal = await sealPair();
    await report(h.k, h.host, ownerPart(null, seal.pub));
    // A host that waits for its owner's Confirm: what the owner's page gates Confirm on.
    const m = await call("POST", "/hosts/enrollments", { session: "m1", body: { name: "box-pending" } });
    const k = await newKey();
    const e = await call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(k, enrollMessage(m.json.token, k.pub)), hostname: "box-2", os: "linux", arch: "aarch64", page_kb: 16, isolation: "root", dedicated: true, agent_version: "0.4.0", capacity: STUDIO } });
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    for (const who of [undefined, "m1", "m2"]) {
      for (const id of [h.host, e.json.host]) {
        const g = await call("GET", `/hosts/${id}`, { session: who });
        expect(g.json.host.owner, `${who} ${id}`).toBe("m1");
      }
      const list = await call("GET", "/hosts?owner=m1", { session: who });
      expect(list.json.hosts.length, String(who)).toBeGreaterThanOrEqual(2);
      for (const x of list.json.hosts) expect(x.owner, `${who} ${x.id}`).toBe("m1");
    }
    // The owner's control is its own key, for the owner and the maintainers only.
    expect((await call("GET", `/hosts/${h.host}`, { session: "m1" })).json.host.owner_control).toMatchObject({ passkey: null, agent_keys: ["GEMINI_API_KEY"] });
    expect((await call("GET", `/hosts/${h.host}`)).json.host.owner_control).toBeUndefined();
  });

  it("refuses a second document signed at the same version before it is relayed, which the host would refuse as a replay", async () => {
    const h = await activeHost("m1", "box-version");
    const seal = await sealPair();
    const cred = (await env.DB.prepare("SELECT credential_id FROM passkeys WHERE login = 'm1'").first<{ credential_id: string }>())!.credential_id;
    await report(h.k, h.host, ownerPart(cred, seal.pub));
    expect((await call("POST", `/hosts/${h.host}/seal-key`, { session: "m1", body: { key: seal.pub, assertion: await actAssertion("m1", `host:seal-key:${h.host}`) } })).status).toBe(200);
    // Two challenges in flight (two tabs): both documents carry version 1.
    const w = await signDoc("m1", h.host, { act: "widen-envelope", envelope: { max_units: 8 } });
    const k = await signDoc("m1", h.host, { act: "set-agent-keys", keys: [await sealAgentKey(seal.pub, h.host, "GEMINI_API_KEY", "gm-x")] });
    expect([JSON.parse(w.doc).version, JSON.parse(k.doc).version]).toEqual([1, 1]);
    expect((await call("POST", `/hosts/${h.host}/orders`, { session: "m1", body: { kind: "widen-envelope", doc: w.doc, assertion: w.assertion } })).status).toBe(201);
    const second = await call("POST", `/hosts/${h.host}/orders`, { session: "m1", body: { kind: "set-agent-keys", doc: k.doc, assertion: k.assertion } });
    expect([second.status, second.json.code]).toEqual([409, "version"]);
    expect(second.json.error).toContain("took version 1");
    // Signed again, it carries the next version and is relayed.
    const k2 = await signDoc("m1", h.host, { act: "set-agent-keys", keys: [await sealAgentKey(seal.pub, h.host, "GEMINI_API_KEY", "gm-x")] });
    expect(JSON.parse(k2.doc).version).toBe(2);
    expect((await call("POST", `/hosts/${h.host}/orders`, { session: "m1", body: { kind: "set-agent-keys", doc: k2.doc, assertion: k2.assertion } })).status).toBe(201);
    expect((await state(h.k, h.host)).json.orders.map((o: { version: number }) => o.version).sort()).toEqual([1, 2]);
  });

  it("the page signs only the document it asked for: another envelope, keys or challenge from the pool's API never reaches the passkey", async () => {
    const h = await activeHost("m1", "box-page");
    const seal = await sealPair();
    const cred = (await env.DB.prepare("SELECT credential_id FROM passkeys WHERE login = 'm1'").first<{ credential_id: string }>())!.credential_id;
    await report(h.k, h.host, ownerPart(cred, seal.pub));
    expect((await call("POST", `/hosts/${h.host}/seal-key`, { session: "m1", body: { key: seal.pub, assertion: await actAssertion("m1", `host:seal-key:${h.host}`) } })).status).toBe(200);
    // The host page's own script as a browser runs it: the software authenticator as navigator.credentials, the Worker behind its fetch —
    // whose answer to the challenge the test may change, as a pool whose API was taken over would.
    let change: ((o: any) => Promise<any>) | null = null;
    const asked: unknown[] = [];
    const buf = (v: string) => unb64url(v).buffer;
    (globalThis as any).__ownerPageNavigator = {
      credentials: {
        get: async (options: any) => {
          asked.push(options.publicKey);
          const k = options.publicKey, x = await answer(keys.m1, { challenge: b64url(k.challenge), origin: ORIGIN, rpId: k.rpId });
          return { rawId: buf(x.credential), response: { clientDataJSON: buf(x.client_data), authenticatorData: buf(x.authenticator_data), signature: buf(x.signature), userHandle: null } };
        },
      },
    };
    const page = async (p: string, init?: RequestInit) => {
      const { cache: _cache, ...rest } = init ?? {};
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(ORIGIN + p, { ...rest, headers: { ...(rest.headers as Record<string, string>), cookie: "omc=oms_m1", origin: ORIGIN } }), env, ctx);
      await waitOnExecutionContext(ctx);
      if (!change || !p.endsWith("/owner/challenge")) return res;
      return new Response(JSON.stringify(await change(await res.json())), { status: res.status, headers: { "content-type": "application/json" } });
    };
    const html = await (await page(`/hosts/${h.host}`)).text();
    const browser = "window.PublicKeyCredential = function () {}; window.isSecureContext = true; var navigator = globalThis.__ownerPageNavigator;";
    const ran = runScript(scriptOf(html).trim().replace(/^\(function \(\) \{/, `(function () {${browser}`), { pathname: `/hosts/${h.host}`, functions: ["signDoc"], variables: ["H"], fetch: page });
    const view = (await call("GET", `/hosts/${h.host}`, { session: "m1" })).json.host;
    ran.setH(view);
    const relay = (kind: string) => (doc: string, a: Record<string, string>) => call("POST", `/hosts/${h.host}/orders`, { session: "m1", body: { kind, doc, assertion: a } }).then((r) => r.json);
    const challengeOf = async (doc: string) => toB64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(doc))));
    const widenBody = { act: "widen-envelope", envelope: { max_units: 8 } };

    // Another envelope than the one shown, with its own challenge: refused before the passkey is asked.
    change = async (o) => { const doc = o.doc.replace('"max_units":8', '"max_units":64'); return { ...o, doc, publicKey: { ...o.publicKey, challenge: await challengeOf(doc) } }; };
    let r = await ran.signDoc(widenBody, relay("widen-envelope"));
    expect(r.code).toBe("no_answer");
    expect(r.error).toContain("its envelope is not the one shown here");
    // The document shown, but a challenge that is not its SHA-256 (another document's): refused too.
    change = async (o) => ({ ...o, publicKey: { ...o.publicKey, challenge: await challengeOf(o.doc.replace('"max_units":8', '"max_units":64')) } });
    r = await ran.signDoc(widenBody, relay("widen-envelope"));
    expect(r.error).toContain("its challenge is not the document's SHA-256");
    // Another host's document: refused.
    change = async (o) => { const doc = o.doc.replace(h.host, "h_9999999999"); return { ...o, doc, publicKey: { ...o.publicKey, challenge: await challengeOf(doc) } }; };
    r = await ran.signDoc(widenBody, relay("widen-envelope"));
    expect(r.error).toContain("it is not for widen-envelope on this host");
    // Keys sealed to another seal key than the one confirmed: refused.
    const other = await sealPair();
    const sealed = await sealAgentKey(seal.pub, h.host, "GEMINI_API_KEY", "gm-x");
    change = async (o) => { const doc = o.doc.replace(seal.pub, other.pub); return { ...o, doc, publicKey: { ...o.publicKey, challenge: await challengeOf(doc) } }; };
    r = await ran.signDoc({ act: "set-agent-keys", keys: [sealed] }, relay("set-agent-keys"));
    expect(r.error).toContain("its keys are not the ones sealed here");
    expect(asked).toHaveLength(0);
    expect((await state(h.k, h.host)).json.orders).toEqual([]);

    // The pool's own answer: the passkey is asked once, and the order is relayed.
    change = null;
    r = await ran.signDoc(widenBody, relay("widen-envelope"));
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    expect(r.order.kind).toBe("widen-envelope");
    expect(asked).toHaveLength(1);
  });

  it("refuses a widening the pool or anyone else could forge, before the host refuses it too", async () => {
    const h = await activeHost("m1", "box-refuse");
    const seal = await sealPair();
    const cred = (await env.DB.prepare("SELECT credential_id FROM passkeys WHERE login = 'm1'").first<{ credential_id: string }>())!.credential_id;
    await report(h.k, h.host, ownerPart(cred, seal.pub));
    const body = { act: "widen-envelope", envelope: { max_units: 8 } };
    // Who: another maintainer, a contributor, a token, nobody.
    expect((await call("POST", `/hosts/${h.host}/owner/challenge`, { session: "m2", body })).status).toBe(403);
    expect((await call("POST", `/hosts/${h.host}/owner/challenge`, { session: "alice", body })).status).toBe(403);
    expect((await call("POST", `/hosts/${h.host}/owner/challenge`, { token: "omc_m1", body })).json.code).toBe("web_only");
    expect((await call("POST", `/hosts/${h.host}/owner/challenge`, { body })).status).toBe(401);
    expect((await call("POST", `/hosts/${h.host}/owner/challenge`, { session: "m1", body: { act: "shell" } })).json.code).toBe("act");
    expect((await call("POST", `/hosts/${h.host}/owner/challenge`, { session: "m1", body: { act: "widen-envelope", envelope: { allow_socket: true } } })).json.code).toBe("arg");
    // A document changed after it was signed: the answer is for another challenge.
    const w = await signDoc("m1", h.host, body);
    const changed = w.doc.replace('"max_units":8', '"max_units":64');
    const o1 = await call("POST", `/hosts/${h.host}/orders`, { session: "m1", body: { kind: "widen-envelope", doc: changed, assertion: w.assertion } });
    expect([o1.status, o1.json.code]).toEqual([403, "challenge"]);
    // A document the pool did not write (another key order) is none of its.
    const w2 = await signDoc("m1", h.host, body);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(w2.doc)).reverse()));
    expect((await call("POST", `/hosts/${h.host}/orders`, { session: "m1", body: { kind: "widen-envelope", doc: reordered, assertion: w2.assertion } })).json.code).toBe("doc");
    // Signed for the widening, posted as agent keys: another act.
    expect((await call("POST", `/hosts/${h.host}/orders`, { session: "m1", body: { kind: "set-agent-keys", doc: w2.doc, assertion: w2.assertion } })).json.code).toBe("doc");
    // Another origin, UP or UV missing: the pool's own verifier refuses, as the host's does.
    for (const [o, code] of [[{ origin: "https://evil.example" }, "origin"], [{ flags: UV }, "user_present"], [{ flags: UP }, "user_verified"]] as [Record<string, unknown>, string][]) {
      const bad = await signDoc("m1", h.host, body, o);
      const r = await call("POST", `/hosts/${h.host}/orders`, { session: "m1", body: { kind: "widen-envelope", doc: bad.doc, assertion: bad.assertion } });
      expect([r.status, r.json.code], code).toEqual([403, code]);
    }
    // Nothing reached the host state.
    expect((await state(h.k, h.host)).json.orders).toEqual([]);
    // An agent before 0.4.0 is given none: it would refuse them as unknown.
    const old = await activeHost("m1", "box-old", "0.3.0");
    const verdict = (await call("GET", `/hosts/${old.host}`, { session: "m1" })).json;
    expect(verdict.can.owner).toBe(false);
    expect(verdict.can.why.owner).toContain("agent 0.4.0");
    expect(hostVerdicts({ login: "m2", maintainer: true, github_id: 1002 }, { name: "x", status: "active", owner_login: "m1", owner_github_id: 1001, agent_version: "0.4.0" }).owner.ok).toBe(false);
    // The pinned passkey moved on: a passkey of m1's that is not pinned there is not offered.
    await report(h.k, h.host, ownerPart("bm90LXRoZS1waW5uZWQtb25l", seal.pub));
    expect((await call("POST", `/hosts/${h.host}/owner/challenge`, { session: "m1", body })).json.code).toBe("not_pinned");
    // The shell's plain door gives no challenge for a document's act: those are signed over the document alone.
    for (const act of ["pin-passkey", "widen-envelope", "set-agent-keys"]) {
      const r = await call("POST", "/auth/passkeys/assert", { session: "m1", body: { for: `host:${act}:${h.host}` } });
      expect([r.status, r.json.code], act).toEqual([400, "for"]);
    }
  });
});
