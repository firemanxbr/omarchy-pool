/**
 * Hardware-bound host keys, the Linux half (#330, epic #307, design v2 §14;
 * P6): a host's agent makes its key in the machine's TPM where it can — an
 * ECDSA P-256 key, since TPM 2.0 has no Ed25519 — and the pool verifies it as
 * it verifies an Ed25519 key: the enrollment's proof and every signed
 * request, 64-byte signatures (P-256's r and s) over the same words. The
 * enrollment says where the key lives (`key_store`: `file` or `tpm`), held to
 * the key's kind, and why a file key is not in the TPM (`key_held`); the
 * host's page and GET /hosts show it. A host enrolled before says nothing:
 * its Ed25519 key is a file.
 *
 * The TPM's own answers are the recorded ones of tests/tpm-fixtures.sh
 * (swtpm, with the agent's arguments), which the agent's unit tests read too:
 * the pool takes that key's enrollment and verifies its signature of a
 * request. tests/host-key-tpm.sh runs the real agent on a software TPM
 * against a local pool.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { toB64url } from "../src/webauthn";
import { enrollMessage, fingerprint, hostPublicKey, keyStoreFits, signedMessage, verifyHostSignature, HOST_KEY_ALG_NAMES, KEY_HELD_MAX } from "../src/hosts";
import { hostHtml } from "../src/pages/host";
import { userHtml } from "../src/pages/user";
import tpmCasesJson from "../../crates/omarchy-agent/tests/fixtures/tpm/cases.json?raw";

const ORIGIN = "http://pool.test";
const CAPACITY = { cpus: 8, mem_gb: 16, disk_free_gb: { work: 120, engine: 80 }, units: 7, agent_slots: 2, lanes: [{ arch: "x86_64", mode: "native" }] };
const TPM = JSON.parse(tpmCasesJson) as {
  pubkey: string; fingerprint: string;
  enroll: { token: string; message: string; sig: string };
  request: { host: string; method: string; path: string; body: string; ts: number; nonce: string; message: string; sig: string };
};

interface Res { status: number; json: any }
async function call(method: string, path: string, opts: { session?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.session) { headers.cookie = `omc=oms_${opts.session}`; headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** A host key as the agent makes one: Ed25519 (a file), or ECDSA P-256 (in a TPM) — WebCrypto signs P-256 as r and s, the 64 bytes the agent sends. */
interface Key { alg: "ed25519" | "p256"; pub: string; raw: Uint8Array; priv: CryptoKey }
async function newKey(alg: "ed25519" | "p256"): Promise<Key> {
  const params = alg === "ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" };
  const k = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer);
  return { alg, pub: toB64url(raw), raw, priv: k.privateKey };
}
async function sign(k: Key, msg: string): Promise<string> {
  const params = k.alg === "ed25519" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
  return toB64url(new Uint8Array(await crypto.subtle.sign(params, k.priv, new TextEncoder().encode(msg))));
}
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function bodyHash(body: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function signed(k: Key, host: string, method: string, path: string, body = "", o: { nonce?: string; sendBody?: string } = {}): Promise<Res> {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = o.nonce ?? hex(16);
  const sig = await sign(k, signedMessage(host, method, `/api/v1${path}`, await bodyHash(body), ts, nonce));
  return call(method, path, { raw: method === "GET" ? undefined : (o.sendBody ?? body), headers: { "omarchy-host": `${host}; ts=${ts}; nonce=${nonce}; sig=${sig}` } });
}
const mint = (as: string, name: string) => call("POST", "/hosts/enrollments", { session: as, body: { name } });
function enrollBody(token: string, pubkey: string, sig: string, o: Record<string, unknown> = {}) {
  return { token, pubkey, sig, hostname: "box-1", os: "linux", arch: "x86_64", page_kb: 4, isolation: "root", dedicated: true, agent_version: "0.4.0", runtime: { driver: "compose/docker" }, capacity: CAPACITY, ...o };
}
async function enroll(token: string, k: Key, o: Record<string, unknown> = {}): Promise<Res> {
  return call("POST", "/hosts/enroll", { body: enrollBody(token, k.pub, await sign(k, enrollMessage(token, k.pub)), o) });
}
const view = async (id: string) => (await call("GET", `/hosts/${id}`, { session: "m1" })).json.host;

beforeAll(async () => {
  const h = sha256Hex;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES ('m1', ?, ?, 'maintainer', 1001), ('alice', ?, ?, 'contributor', 2001)`)
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_alice"), await h("oms_alice")),
  ]);
  await applyGovernance(env, ["m1"], "sha-start");
});

describe("the host key's kinds (hosts.ts)", () => {
  it("reads an Ed25519 key or an uncompressed P-256 point, and nothing else", async () => {
    const ed = await newKey("ed25519"), p = await newKey("p256");
    expect(hostPublicKey(ed.pub)).toEqual({ alg: "ed25519", raw: ed.raw });
    expect(hostPublicKey(p.pub)).toEqual({ alg: "p256", raw: p.raw });
    expect(p.pub).toHaveLength(87);
    const compressed = new Uint8Array(33); compressed[0] = 0x02;
    const not04 = new Uint8Array(p.raw); not04[0] = 0x05;
    for (const bad of [toB64url(compressed), toB64url(not04), p.pub.slice(1), `${p.pub}A`, "!".repeat(87), 7, null, undefined]) {
      expect(hostPublicKey(bad), String(bad)).toBeNull();
    }
    // A file holds an Ed25519 key, a TPM a P-256 one; the agent makes no other.
    expect([keyStoreFits("file", "ed25519"), keyStoreFits("tpm", "p256"), keyStoreFits("tpm", "ed25519"), keyStoreFits("file", "p256")]).toEqual([true, true, false, false]);
  });

  it("verifies a P-256 signature of r and s over the message's SHA-256, and refuses a changed message, a DER signature, another kind's and a point off the curve without a throw", async () => {
    const p = await newKey("p256"), ed = await newKey("ed25519");
    const key = hostPublicKey(p.pub)!;
    const sig = await sign(p, "omarchy-host-v1\nmsg");
    expect(await verifyHostSignature(key, sig, "omarchy-host-v1\nmsg")).toBe(true);
    expect(await verifyHostSignature(key, sig, "omarchy-host-v1\nmsg ")).toBe(false);
    // The same signature DER-encoded (what `tpm2_sign -f plain` writes): not the 64 bytes the agent sends.
    const raw = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; const v = b.slice(i); return v[0] & 0x80 ? [0, ...v] : [...v]; };
    const r = int(raw.slice(0, 32)), s = int(raw.slice(32));
    const der = new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s]);
    expect(await verifyHostSignature(key, toB64url(der), "omarchy-host-v1\nmsg")).toBe(false);
    expect(await verifyHostSignature(key, await sign(ed, "omarchy-host-v1\nmsg"), "omarchy-host-v1\nmsg")).toBe(false);
    expect(await verifyHostSignature(hostPublicKey(ed.pub)!, sig, "omarchy-host-v1\nmsg")).toBe(false);
    const off = new Uint8Array(p.raw); off[64] ^= 1;
    expect(await verifyHostSignature({ alg: "p256", raw: off }, sig, "omarchy-host-v1\nmsg")).toBe(false);
    expect(await verifyHostSignature(key, "not base64url!", "omarchy-host-v1\nmsg")).toBe(false);
  });

  it("verifies what a TPM signed (recorded from swtpm with the agent's arguments): its enrollment's proof and a request, with the fingerprint the agent prints", async () => {
    const key = hostPublicKey(TPM.pubkey)!;
    expect(key.alg).toBe("p256");
    expect(await fingerprint(key.raw)).toBe(TPM.fingerprint);
    expect(enrollMessage(TPM.enroll.token, TPM.pubkey)).toBe(TPM.enroll.message);
    expect(await verifyHostSignature(key, TPM.enroll.sig, TPM.enroll.message)).toBe(true);
    const q = TPM.request;
    expect(signedMessage(q.host, q.method, q.path, await bodyHash(q.body), q.ts, q.nonce)).toBe(q.message);
    expect(await verifyHostSignature(key, q.sig, q.message)).toBe(true);
    expect(await verifyHostSignature(key, q.sig, TPM.enroll.message)).toBe(false);
  });
});

describe("a host whose key is in its TPM", () => {
  it("enrolls with its P-256 key, says so on its page, and signs every call with it: the token, the state; a changed body and a replay are refused", async () => {
    const m = await mint("m1", "tpm-1");
    const k = await newKey("p256");
    const e = await enroll(m.json.token, k, { key_store: "tpm" });
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    expect(e.json).toMatchObject({ status: "pending-owner", key_store: "tpm", fingerprint: await fingerprint(k.raw) });
    expect(await env.DB.prepare("SELECT key_store, key_held FROM hosts WHERE id = ?").bind(e.json.host).first()).toEqual({ key_store: "tpm", key_held: null });
    expect((await view(e.json.host)).host_key).toEqual({ store: "tpm", alg: "p256", held: null });
    const listed = (await call("GET", "/hosts?owner=m1", { session: "m1" })).json.hosts.find((h: { id: string }) => h.id === e.json.host);
    expect(listed.host_key).toEqual({ store: "tpm", alg: "p256", held: null });
    // Nobody signed in sees where the key lives no more than its fingerprint.
    const anon = (await call("GET", `/hosts/${e.json.host}`)).json.host;
    expect([anon.fingerprint, anon.host_key]).toEqual([undefined, undefined]);
    const c = await call("POST", `/hosts/${e.json.host}/confirm`, { session: "m1", body: {} });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    const t = await signed(k, e.json.host, "POST", "/hosts/self/token");
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    expect(t.json.token).toMatch(/^omw_[0-9a-f]{48}$/);
    const s = await signed(k, e.json.host, "GET", "/hosts/self/state");
    expect([s.status, s.json.status, s.json.fingerprint]).toEqual([200, "active", await fingerprint(k.raw)]);
    const changed = await signed(k, e.json.host, "POST", "/hosts/self/report", '{"agent":{}}', { sendBody: '{"agent":{"x":1}}' });
    expect([changed.status, changed.json.code]).toEqual([401, "host_signature"]);
    const nonce = hex(16);
    expect((await signed(k, e.json.host, "GET", "/hosts/self/state", "", { nonce })).status).toBe(200);
    expect((await signed(k, e.json.host, "GET", "/hosts/self/state", "", { nonce })).json.code).toBe("replay");
    // Another P-256 key is not this host's.
    expect((await signed(await newKey("p256"), e.json.host, "GET", "/hosts/self/state")).json.code).toBe("host_signature");
  });

  it("enrolls the key a TPM made, with the proof the TPM signed (recorded from swtpm)", async () => {
    // The recorded proof is bound to its own token: an enrollment the site minted for it.
    await env.DB.prepare("INSERT INTO host_enrollments (token_hash, id, login, github_id, name, expires_at) VALUES (?, 'he_tpm', 'm1', 1001, 'swtpm', ?)")
      .bind(await sha256Hex(TPM.enroll.token), new Date(Date.now() + 15 * 60000).toISOString()).run();
    const e = await call("POST", "/hosts/enroll", { body: enrollBody(TPM.enroll.token, TPM.pubkey, TPM.enroll.sig, { key_store: "tpm" }) });
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    expect([e.json.fingerprint, e.json.key_store]).toEqual([TPM.fingerprint, "tpm"]);
  });

  it("is held to its key's kind: a TPM's key is P-256, a file's Ed25519; a store the pool does not know and a reason that is not one line of text are refused, nothing written", async () => {
    const ed = await newKey("ed25519"), p = await newKey("p256");
    for (const [k, o, code] of [
      [ed, { key_store: "tpm" }, "key_store"],
      [p, { key_store: "file" }, "key_store"],
      // An agent before #330 says nothing, and makes Ed25519 keys only.
      [p, {}, "key_store"],
      [ed, { key_store: "enclave" }, undefined],
      [ed, { key_store: "file", key_held: 7 }, undefined],
    ] as [Key, Record<string, unknown>, string | undefined][]) {
      const m = await mint("m1", `kind-${hex(3)}`);
      const r = await enroll(m.json.token, k, o);
      expect([r.status, r.json.code], JSON.stringify(o)).toEqual([400, code]);
      expect(await env.DB.prepare("SELECT used_at FROM host_enrollments WHERE token_hash = ?").bind(await sha256Hex(m.json.token)).first("used_at")).toBeNull();
    }
    // A P-256 proof that does not verify is no proof.
    const m = await mint("m1", "kind-proof");
    const r = await call("POST", "/hosts/enroll", { body: enrollBody(m.json.token, p.pub, await sign(p, "something else"), { key_store: "tpm" }) });
    expect([r.status, r.json.code]).toEqual([401, "proof"]);
  });
});

describe("a host whose key is a file", () => {
  it("keeps why it is not in the TPM, one line and cut, for its page; a key in the TPM keeps none", async () => {
    const m = await mint("m1", "file-1");
    const k = await newKey("ed25519");
    const why = "/dev/tpmrm0 is there, but this user (uid 1000) may not open it:\tthe tss group gives it";
    const e = await enroll(m.json.token, k, { key_store: "file", key_held: why });
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    expect((await view(e.json.host)).host_key).toEqual({ store: "file", alg: "ed25519", held: why.replace("\t", " ") });
    const long = await mint("m1", "file-2");
    const l = await enroll(long.json.token, await newKey("ed25519"), { key_store: "file", key_held: "x".repeat(KEY_HELD_MAX + 50) });
    expect((await view(l.json.host)).host_key.held).toHaveLength(KEY_HELD_MAX);
    const t = await mint("m1", "tpm-held");
    const tp = await enroll(t.json.token, await newKey("p256"), { key_store: "tpm", key_held: "said anyway" });
    expect((await view(tp.json.host)).host_key).toEqual({ store: "tpm", alg: "p256", held: null });
  });

  it("an agent before #330 says nothing: its Ed25519 key is a file, and the page says so", async () => {
    const m = await mint("m1", "old-agent");
    const e = await enroll(m.json.token, await newKey("ed25519"));
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    expect(e.json.key_store).toBe("file");
    // A host enrolled before the column: NULL, read as a file.
    await env.DB.prepare("UPDATE hosts SET key_store = NULL, key_held = NULL WHERE id = ?").bind(e.json.host).run();
    expect((await view(e.json.host)).host_key).toEqual({ store: "file", alg: "ed25519", held: null });
  });
});

describe("the pages' words for where a host's key lives", () => {
  // The pages' own functions, read out of the pages they serve, as host-sandbox.test.ts reads sandboxWords.
  const VERSION = { version: "v1.0.0", commit: null, deployed_at: null, release_url: null, commit_url: null, analytics: "" };
  const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const hostPage = hostHtml("h_keywords01", "https://pool.example", VERSION);
  const hostStart = hostPage.indexOf("function keyWords(h) {");
  const keyWords = new Function("esc", "KEY_ALGS", `${hostPage.slice(hostStart, hostPage.indexOf("\n  }\n", hostStart) + 4)}; return keyWords;`)(esc, HOST_KEY_ALG_NAMES) as (h: unknown) => string;
  const userPage = userHtml("m1", "https://pool.example", VERSION);
  const userStart = userPage.indexOf("function keyWhere(h) {");
  const keyWhere = new Function("esc", `${userPage.slice(userStart, userPage.indexOf("\n", userStart))}; return keyWhere;`)(esc) as (h: unknown) => string;
  const held = "/dev/tpmrm0 is there, but this user (uid 1000) may not open it: <b>tss</b> & \"more\"";
  const heldShown = "/dev/tpmrm0 is there, but this user (uid 1000) may not open it: &lt;b&gt;tss&lt;/b&gt; &amp; &quot;more&quot;";

  it("are drawn beside the fingerprint, on the host page and in its owner's hosts and Confirm", () => {
    expect(hostStart).toBeGreaterThan(0);
    expect(hostPage).toContain("'</span><br>' + keyWords(h)");
    expect(userStart).toBeGreaterThan(0);
    expect(userPage).toContain("esc(h.fingerprint) + '</span>' + keyWhere(h)");
    expect(userPage).toContain("'<br><code>' + esc(h.fingerprint) + '</code>' + keyWhere(h)");
  });

  it("say a key in the TPM was made there and never leaves it", () => {
    expect(keyWords({ host_key: { store: "tpm", alg: "p256", held: null } })).toBe("in its TPM (ECDSA P-256): made there, and never out of it — a copy of its agent's files signs nothing on another machine");
    expect(keyWhere({ host_key: { store: "tpm", alg: "p256", held: null } })).toBe(" · its key is in its TPM, never out of it");
  });

  it("say a key is a file, and why not in the TPM when its agent said, escaped", () => {
    expect(keyWords({ host_key: { store: "file", alg: "ed25519", held: null } })).toBe("a file (Ed25519), 0600 in its agent's state directory");
    expect(keyWords({ host_key: { store: "file", alg: "ed25519", held } })).toBe(`a file (Ed25519), 0600 in its agent's state directory<br><span class="muted">not in its TPM: ${heldShown}</span>`);
    expect(keyWhere({ host_key: { store: "file", alg: "ed25519", held: null } })).toBe(" · its key is a file");
    expect(keyWhere({ host_key: { store: "file", alg: "ed25519", held } })).toBe(` · its key is a file (not in its TPM: ${heldShown})`);
    for (const w of [keyWords({ host_key: { store: "file", alg: "ed25519", held } }), keyWhere({ host_key: { store: "file", alg: "ed25519", held } })]) {
      expect(w).not.toContain("<b>");
    }
  });

  it("say nothing in the hosts table where the reader is not shown the key, read a host_key missing as a file, and name an unknown kind as it came, escaped", () => {
    // GET /hosts gives host_key to its owner and the maintainers only: the hosts table says nothing.
    expect(keyWhere({})).toBe("");
    // The pool sends one for every host it shows the fingerprint of (one enrolled before #330: a file); without it, the default.
    expect(keyWords({})).toBe("a file (?), 0600 in its agent's state directory");
    expect(keyWords({ host_key: { store: "file", alg: "<x>", held: null } })).toBe("a file (&lt;x&gt;), 0600 in its agent's state directory");
  });
});
