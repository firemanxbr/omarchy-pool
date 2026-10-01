/**
 * Maintainer hosts (#321, epic #307, design v2 §6.1, §6.3, §8.6, §17.2):
 * only a maintainer adds a host; its one-time token is bound to the login and
 * the GitHub user id, works once and for fifteen minutes; the machine proves
 * it holds the key it enrolls, and a host below the release's signed minimum
 * is refused; nothing is registered until the owner confirms the fingerprint;
 * then the host gets one worker registration, the journal a line and the
 * other maintainers a notice. Every later call is signed with the host key —
 * a replay, a changed body or a clock off by more than 120 s is refused —
 * and fetches or rotates the worker token, whose predecessor works ten more
 * minutes while a running task's job token never notices. Real Ed25519 keys,
 * through WebCrypto, as the agent's are.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { issueJobToken, scopesFor } from "../src/jobtoken";
import { toB64url } from "../src/webauthn";
import { belowMinimum, enrollMessage, fingerprint, hostLine, MIN_HOST, parseHostHeader, signedMessage, unitsOf } from "../src/hosts";
import { pruneHosts } from "../src/routes/hosts";
import manifest from "../../factory/bundle/manifest.toml";

const ORIGIN = "http://pool.test";
const STUDIO = { cpus: 12, mem_gb: 32, disk_free_gb: { work: 410, engine: 220 }, units: 11, agent_slots: 2, lanes: [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated", via: "qemu", page16k: true }] };

interface Res { status: number; json: any }
async function call(method: string, path: string, opts: { session?: string; token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.session) { headers.cookie = `omc=oms_${opts.session}`; headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

interface Key { pub: string; priv: CryptoKey; raw: Uint8Array }
async function newKey(): Promise<Key> {
  const k = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer);
  return { pub: toB64url(raw), priv: k.privateKey, raw };
}
const sign = async (k: Key, msg: string) => toB64url(await crypto.subtle.sign({ name: "Ed25519" }, k.priv, new TextEncoder().encode(msg)));
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function bodyHash(body: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A request signed as the agent signs it; each part can be bent to test a refusal. */
async function signed(k: Key, host: string, method: string, path: string, body = "", o: { ts?: number; nonce?: string; sendBody?: string; signPath?: string } = {}): Promise<Res> {
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const nonce = o.nonce ?? hex(16);
  const sig = await sign(k, signedMessage(host, method, `/api/v1${o.signPath ?? path}`, await bodyHash(body), ts, nonce));
  return call(method, path, { raw: method === "GET" ? undefined : (o.sendBody ?? body), headers: { "omarchy-host": `${host}; ts=${ts}; nonce=${nonce}; sig=${sig}` } });
}

const mint = (as: string, name = "box", where?: string) => call("POST", "/hosts/enrollments", { session: as, body: { name, where } });
async function enroll(token: string, k: Key, o: Record<string, unknown> = {}): Promise<Res> {
  return call("POST", "/hosts/enroll", { body: { token, pubkey: k.pub, sig: await sign(k, enrollMessage(token, k.pub)), hostname: "box-1", os: "linux", arch: "aarch64", page_kb: 16, isolation: "root", dedicated: true, agent_version: "0.2.0", runtime: { driver: "compose/docker", rootless: false }, capacity: STUDIO, ...o } });
}
/** One maintainer host from nothing to active: mint, enroll, confirm, fetch its token. */
async function activeHost(owner = "m1", name = "rack"): Promise<{ k: Key; host: string; worker: string; token: string }> {
  const m = await mint(owner, name);
  const k = await newKey();
  const e = await enroll(m.json.token, k);
  expect(e.status, JSON.stringify(e.json)).toBe(201);
  const c = await call("POST", `/hosts/${e.json.host}/confirm`, { session: owner, body: {} });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const t = await signed(k, e.json.host, "POST", "/hosts/self/token");
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  return { k, host: e.json.host, worker: c.json.worker, token: t.json.token };
}

beforeAll(async () => {
  const h = sha256Hex;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES
      ('m1', ?, ?, 'maintainer', 1001), ('m2', ?, ?, 'maintainer', 1002), ('m3', ?, ?, 'maintainer', NULL), ('alice', ?, ?, 'contributor', 2001)`)
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_m3"), await h("oms_m3"), await h("omc_alice"), await h("oms_alice")),
  ]);
  await applyGovernance(env, ["m1", "m2", "m3"], "sha-start");
});

describe("the D1 migration (0043)", () => {
  it("adds hosts, enrollments and nonces, a host's registration and the GitHub user id; a status outside the four and a second registration for one host are refused", async () => {
    const cols = async (t: string) => (await env.DB.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((r) => r.name);
    expect(await cols("hosts")).toEqual(expect.arrayContaining(["owner_login", "owner_github_id", "name", "pubkey", "status", "capacity", "lanes", "units", "agent_slots", "disk_free", "pool_cap_units", "provider", "model", "isolation", "last_seen", "agent_version", "release_applied", "rolled_back_from"]));
    expect(await cols("host_enrollments")).toEqual(expect.arrayContaining(["token_hash", "login", "github_id", "expires_at", "used_at"]));
    expect(await cols("host_nonces")).toEqual(["host_id", "nonce", "at"]);
    expect(await cols("build_workers")).toEqual(expect.arrayContaining(["host_id", "kind"]));
    expect(await cols("hosts")).toEqual(expect.arrayContaining(["prev_token_hash", "prev_token_until", "token_issued_at", "worker_id"]));
    expect(await cols("contributors")).toContain("github_id");
    // A row from before is legacy.
    await env.DB.prepare("INSERT INTO build_workers (id, arch, owner) VALUES ('old-1', 'x86_64', 'm1')").run();
    expect(await env.DB.prepare("SELECT kind FROM build_workers WHERE id = 'old-1'").first("kind")).toBe("legacy");
    await expect(env.DB.prepare("INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status) VALUES ('h_x', 'm1', 1, 'x', 'k', 'busy')").run()).rejects.toThrow(/CHECK/);
    await env.DB.prepare("INSERT INTO build_workers (id, arch, owner, host_id, kind) VALUES ('one', 'x86_64', 'm1', 'h_same', 'host')").run();
    await expect(env.DB.prepare("INSERT INTO build_workers (id, arch, owner, host_id, kind) VALUES ('two', 'x86_64', 'm1', 'h_same', 'host')").run()).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare("DELETE FROM build_workers WHERE id IN ('old-1', 'one')").run();
  });
});

describe("the signed numbers (hosts.ts)", () => {
  it("the minimum and the units are the signed manifest's: a 4-core 8 GB host makes 3 units, the Studio 11", () => {
    expect(manifest).toContain(`cpus = ${MIN_HOST.cpus}`);
    expect(MIN_HOST).toEqual({ cpus: 4, mem_gb: 8, work_disk_gb: 60, engine_disk_gb: 40 });
    expect(unitsOf({ cpus: 4, mem_gb: 8, units: null })).toBe(3);
    expect(unitsOf({ cpus: 12, mem_gb: 32, units: null })).toBe(11);
    expect(unitsOf({ cpus: 16, mem_gb: 64, units: null })).toBe(15);
    // A host that declares fewer gets fewer; one that declares more gets the pool's count.
    expect(unitsOf({ cpus: 12, mem_gb: 32, units: 5 })).toBe(5);
    expect(unitsOf({ cpus: 12, mem_gb: 32, units: 99 })).toBe(11);
    expect(belowMinimum({ cpus: 4, mem_gb: 8, disk_free_gb: { work: 60, engine: 40 } })).toBeNull();
    expect(belowMinimum({ cpus: 2, mem_gb: 6, disk_free_gb: { work: 60, engine: 40 } })).toBe("below the minimum to join: 2 CPUs (4 needed), 6 GB of memory (8 needed)");
    expect(hostLine(STUDIO as any, "root", true)).toBe("12 cores, 32 GB, aarch64 native, x86_64 emulated, isolation root (dedicated)");
  });

  it("reads the Omarchy-Host header strictly", () => {
    const sig = "A".repeat(86);
    expect(parseHostHeader(`h_0123456789; ts=1700000000; nonce=${"a".repeat(32)}; sig=${sig}`)).toEqual({ host: "h_0123456789", ts: 1700000000, nonce: "a".repeat(32), sig });
    for (const bad of [null, "", `h_0123456789; ts=1; nonce=${"a".repeat(32)}`, `x_0123456789; ts=1; nonce=${"a".repeat(32)}; sig=${sig}`, `h_0123456789; ts=1; ts=2; nonce=${"a".repeat(32)}`, `h_0123456789; ts=now; nonce=${"a".repeat(32)}; sig=${sig}`, `h_0123456789; ts=1; nonce=xyz; sig=${sig}`]) {
      expect(parseHostHeader(bad), String(bad)).toBeNull();
    }
  });
});

describe("Add a host: POST /hosts/enrollments", () => {
  it("a maintainer gets a one-time ome_ token, stored as its hash, and one command with the token in the environment of sh, never an argument", async () => {
    const r = await mint("m1", "vps-1", "Hetzner CAX41, Falkenstein");
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.token).toMatch(/^ome_[0-9a-f]{48}$/);
    expect(Date.parse(r.json.expires_at) - Date.now()).toBeGreaterThan(14 * 60000);
    expect(Date.parse(r.json.expires_at) - Date.now()).toBeLessThanOrEqual(15 * 60000);
    expect(r.json.command).toBe(`curl --proto '=https' --tlsv1.2 -fsSL https://github.com/firemanxbr/omarchy-pool/releases/latest/download/install.sh | OMARCHY_ENROLL=${r.json.token} sh -s -- --pool ${ORIGIN}`);
    // The token is the environment of sh: after the pipe, before sh; nothing after sh names it.
    expect(r.json.command.split("| ")[1].indexOf("OMARCHY_ENROLL=")).toBe(0);
    expect(r.json.command.split(" sh")[1]).not.toContain("ome_");
    const row = await env.DB.prepare("SELECT login, github_id, name, \"where\", used_at FROM host_enrollments WHERE token_hash = ?").bind(await sha256Hex(r.json.token)).first();
    expect(row).toEqual({ login: "m1", github_id: 1001, name: "vps-1", where: "Hetzner CAX41, Falkenstein", used_at: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM host_enrollments WHERE token_hash = ? OR id = ?").bind(r.json.token, r.json.token).first("n")).toBe(0);
  });

  it("anyone else is refused server-side: nobody (401), a contributor (403), a session from another site (403), a malformed name (400)", async () => {
    expect((await call("POST", "/hosts/enrollments", { body: { name: "x" } })).status).toBe(401);
    const c = await mint("alice");
    expect([c.status, c.json.code]).toEqual([403, "maintainers_only"]);
    const cli = await call("POST", "/hosts/enrollments", { token: "omc_alice", body: { name: "x" } });
    expect([cli.status, cli.json.code]).toEqual([403, "maintainers_only"]);
    const foreign = await call("POST", "/hosts/enrollments", { body: { name: "x" }, headers: { cookie: "omc=oms_m1", origin: "https://evil.example" } });
    expect([foreign.status, foreign.json.code]).toEqual([403, "origin"]);
    expect((await mint("m1", "Not A Name")).status).toBe(400);
    expect((await mint("m1", "ok", "line\nbreak")).status).toBe(400);
  });

  it("a maintainer whose GitHub user id the pool does not know yet signs in again first (409)", async () => {
    const r = await mint("m3");
    expect([r.status, r.json.code]).toEqual([409, "github_id"]);
  });

  it("a login the last sync took off the list is refused, even with the role still on its row", async () => {
    await applyGovernance(env, ["m1", "m2"], "sha-no-m3");
    await env.DB.prepare("UPDATE contributors SET role = 'maintainer', github_id = 1003 WHERE login = 'm3'").run();
    const r = await mint("m3");
    expect([r.status, r.json.code]).toEqual([403, "maintainers_only"]);
    await applyGovernance(env, ["m1", "m2", "m3"], "sha-m3-back");
  });
});

describe("POST /hosts/enroll", () => {
  it("creates the host in pending-owner, owned by the GitHub user id, with the pool's own unit count and the fingerprint the agent prints; no registration, nothing to claim", async () => {
    const m = await mint("m1", "studio");
    const k = await newKey();
    const e = await enroll(m.json.token, k);
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    expect(e.json).toMatchObject({ status: "pending-owner", owner: "m1", name: "studio", units: 11, fingerprint: await fingerprint(k.raw) });
    expect(e.json.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const row = await env.DB.prepare("SELECT owner_login, owner_github_id, status, worker_id, units, isolation, dedicated, arch, page_kb FROM hosts WHERE id = ?").bind(e.json.host).first();
    expect(row).toEqual({ owner_login: "m1", owner_github_id: 1001, status: "pending-owner", worker_id: null, units: 11, isolation: "root", dedicated: 1, arch: "aarch64", page_kb: 16 });
    // Not confirmed: no registration under it, and its signed state says it waits; its token is refused.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM build_workers WHERE host_id = ?").bind(e.json.host).first("n")).toBe(0);
    expect((await signed(k, e.json.host, "GET", "/hosts/self/state")).json).toMatchObject({ status: "pending-owner", worker: null, token: null });
    const t = await signed(k, e.json.host, "POST", "/hosts/self/token");
    expect([t.status, t.json.code]).toEqual([409, "pending_owner"]);
    // A signed request is no worker: the claim wants a worker token.
    const ts = Math.floor(Date.now() / 1000), nonce = hex(16);
    const sig = await sign(k, signedMessage(e.json.host, "POST", "/api/v1/factory/claim", await bodyHash("{}"), ts, nonce));
    expect((await call("POST", "/factory/claim", { raw: "{}", headers: { "omarchy-host": `${e.json.host}; ts=${ts}; nonce=${nonce}; sig=${sig}` } })).status).toBe(401);
  });

  it("refuses a token after its use, after 15 minutes, never issued — and one whose login left the list before enroll", async () => {
    const m = await mint("m2", "once");
    expect((await enroll(m.json.token, await newKey())).status).toBe(201);
    const again = await enroll(m.json.token, await newKey());
    expect([again.status, again.json.code]).toEqual([401, "token_used"]);

    const late = await mint("m2", "late");
    await env.DB.prepare("UPDATE host_enrollments SET expires_at = ? WHERE token_hash = ?").bind(new Date(Date.now() - 1000).toISOString(), await sha256Hex(late.json.token)).run();
    const expired = await enroll(late.json.token, await newKey());
    expect([expired.status, expired.json.code]).toEqual([401, "token_expired"]);

    const never = await enroll(`ome_${"0".repeat(48)}`, await newKey());
    expect([never.status, never.json.code]).toEqual([401, "token_unknown"]);

    const left = await mint("m2", "left");
    await applyGovernance(env, ["m1", "m3"], "sha-no-m2");
    const gone = await enroll(left.json.token, await newKey());
    expect([gone.status, gone.json.code]).toEqual([403, "not_maintainer"]);
    expect(await env.DB.prepare("SELECT used_at FROM host_enrollments WHERE token_hash = ?").bind(await sha256Hex(left.json.token)).first("used_at")).toBeNull();
    await applyGovernance(env, ["m1", "m2", "m3"], "sha-m2-back");
  });

  it("refuses a token whose login is now another GitHub account (a rename taken by someone else)", async () => {
    const m = await mint("m2", "renamed");
    await env.DB.prepare("UPDATE contributors SET github_id = 9999 WHERE login = 'm2'").run();
    const r = await enroll(m.json.token, await newKey());
    expect([r.status, r.json.code]).toEqual([403, "owner_changed"]);
    await env.DB.prepare("UPDATE contributors SET github_id = 1002 WHERE login = 'm2'").run();
  });

  it("refuses a host below the signed minimum with its numbers, and keeps the token for the fixed machine", async () => {
    const m = await mint("m1", "small");
    const small = await enroll(m.json.token, await newKey(), { capacity: { ...STUDIO, cpus: 2, mem_gb: 6, units: 1 } });
    expect([small.status, small.json.code]).toEqual([422, "below_minimum"]);
    expect(small.json.error).toContain("2 CPUs (4 needed), 6 GB of memory (8 needed)");
    const disk = await enroll(m.json.token, await newKey(), { capacity: { ...STUDIO, disk_free_gb: { work: 59, engine: 220 } } });
    expect(disk.json.error).toContain("59 GB free on the work root (60 needed)");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hosts WHERE name = 'small'").first("n")).toBe(0);
    expect((await enroll(m.json.token, await newKey(), { capacity: { ...STUDIO, cpus: 4, mem_gb: 8, units: 3, disk_free_gb: { work: 60, engine: 40 } } })).status).toBe(201);
  });

  it("refuses a key the machine cannot prove it holds, a malformed body, and a report that carries a secret", async () => {
    const m = await mint("m1", "proof");
    const k = await newKey(), other = await newKey();
    const forged = await call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(other, enrollMessage(m.json.token, k.pub)), hostname: "h", os: "linux", arch: "aarch64", page_kb: 4, isolation: "root", agent_version: "0.2.0", capacity: STUDIO } });
    expect([forged.status, forged.json.code]).toEqual([401, "proof"]);
    expect((await enroll(m.json.token, k, { arch: "sparc" })).status).toBe(400);
    expect((await enroll(m.json.token, k, { arch: "x86_64" })).status).toBe(400); // its native lane is aarch64
    expect((await enroll(m.json.token, k, { runtime: { note: `GITHUB_TOKEN=ghp_${"a".repeat(36)}` } })).status).toBe(422);
    expect((await call("POST", "/hosts/enroll", { raw: "x".repeat(17 * 1024) })).status).toBe(413);
    expect((await enroll(m.json.token, k)).status).toBe(201);
  });
});

describe("Confirm: POST /hosts/:id/confirm", () => {
  it("only its owner confirms; the host becomes active with one registration of kind host and project trust, the journal says it, and the other maintainers see the notice", async () => {
    const m = await mint("m1", "confirmed");
    const k = await newKey();
    const e = await enroll(m.json.token, k);
    expect((await call("POST", `/hosts/${e.json.host}/confirm`, { body: {} })).status).toBe(401);
    const other = await call("POST", `/hosts/${e.json.host}/confirm`, { session: "m2", body: {} });
    expect([other.status, other.json.code]).toEqual([403, "not_owner"]);
    const ok = await call("POST", `/hosts/${e.json.host}/confirm`, { session: "m1", body: {} });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.worker).toMatch(/^m1-confirmed-[0-9a-z]{4}$/);
    const w = await env.DB.prepare("SELECT owner, arch, kind, host_id, trust, trusted_by, token_hash, revoked_at FROM build_workers WHERE id = ?").bind(ok.json.worker).first();
    expect(w).toEqual({ owner: "m1", arch: "aarch64", kind: "host", host_id: e.json.host, trust: "project", trusted_by: "m1", token_hash: null, revoked_at: null });
    // Twice is refused; one registration per host.
    expect((await call("POST", `/hosts/${e.json.host}/confirm`, { session: "m1", body: {} })).status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM build_workers WHERE host_id = ?").bind(e.json.host).first("n")).toBe(1);
    // The journal's info line, D40's words.
    const line = await env.DB.prepare("SELECT kind, status, summary FROM events WHERE kind = 'host' AND payload LIKE ?").bind(`%${e.json.host}%`).first();
    expect(line).toEqual({ kind: "host", status: "ok", summary: "new host of m1: 12 cores, 32 GB, aarch64 native, x86_64 emulated, isolation root (dedicated)" });
    // The other maintainers' notice; not the owner's own, not a contributor's.
    const m2 = await call("GET", "/hosts", { session: "m2" });
    expect(m2.json.notices.find((n: any) => n.host === e.json.host)).toMatchObject({ owner: "m1", line: line!.summary });
    expect((await call("GET", "/hosts", { session: "m1" })).json.notices.some((n: any) => n.host === e.json.host)).toBe(false);
    expect((await call("GET", "/hosts", { session: "alice" })).json.notices).toEqual([]);
  });

  it("the details — fingerprint, capacity, hostname — are the owner's and the maintainers'; anyone sees the name, the status and the architectures", async () => {
    const { host } = await activeHost("m1", "seen");
    const anon = (await call("GET", `/hosts/${host}`)).json.host;
    expect(anon).toMatchObject({ id: host, name: "seen", owner: "m1", status: "active", arches: ["aarch64", "x86_64"] });
    expect(anon.fingerprint).toBeUndefined();
    expect(anon.hostname).toBeUndefined();
    const own = (await call("GET", `/hosts/${host}`, { session: "m1" })).json.host;
    expect(own).toMatchObject({ hostname: "box-1", units: 11, isolation: "root", dedicated: true });
    expect(own.fingerprint).toMatch(/^SHA256:/);
    expect((await call("GET", `/hosts/${host}`, { session: "m2" })).json.host.fingerprint).toBe(own.fingerprint);
    expect((await call("GET", `/hosts/${host}`, { session: "alice" })).json.host.fingerprint).toBeUndefined();
    expect((await call("GET", "/hosts/h_zzzzzzzzzz")).status).toBe(404);
  });

  it("an owner removed from the list before Confirm cannot confirm", async () => {
    const m = await mint("m2", "unconfirmed");
    const e = await enroll(m.json.token, await newKey());
    await applyGovernance(env, ["m1", "m3"], "sha-no-m2-again");
    const r = await call("POST", `/hosts/${e.json.host}/confirm`, { session: "m2", body: {} });
    expect([r.status, r.json.code]).toEqual([403, "maintainers_only"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM build_workers WHERE host_id = ?").bind(e.json.host).first("n")).toBe(0);
    await applyGovernance(env, ["m1", "m2", "m3"], "sha-m2-back-again");
  });
});

describe("host-key-signed requests", () => {
  it("a signed request is taken once: a replay, a changed body, a changed path, another host's key and a clock off by more than 120 s are refused", async () => {
    const { k, host } = await activeHost("m1", "signed");
    const nonce = hex(16);
    expect((await signed(k, host, "GET", "/hosts/self/state", "", { nonce })).status).toBe(200);
    const replay = await signed(k, host, "GET", "/hosts/self/state", "", { nonce });
    expect([replay.status, replay.json.code]).toEqual([401, "replay"]);
    const report = JSON.stringify({ agent: { version: "0.2.0" } });
    const changed = await signed(k, host, "POST", "/hosts/self/report", report, { sendBody: report.replace("0.2.0", "9.9.9") });
    expect([changed.status, changed.json.code]).toEqual([401, "host_signature"]);
    const moved = await signed(k, host, "POST", "/hosts/self/report", report, { signPath: "/hosts/self/token" });
    expect([moved.status, moved.json.code]).toEqual([401, "host_signature"]);
    const stranger = await signed(await newKey(), host, "GET", "/hosts/self/state");
    expect([stranger.status, stranger.json.code]).toEqual([401, "host_signature"]);
    const now = Math.floor(Date.now() / 1000);
    for (const off of [121, -121]) {
      const r = await signed(k, host, "GET", "/hosts/self/state", "", { ts: now + off });
      expect([r.status, r.json.code], String(off)).toEqual([401, "clock"]);
    }
    for (const off of [110, -110]) expect((await signed(k, host, "GET", "/hosts/self/state", "", { ts: now + off })).status, String(off)).toBe(200);
    expect((await call("GET", "/hosts/self/state")).json.code).toBe("host_signature");
  });

  it("a suspended host's key is refused (the statuses of #322)", async () => {
    const { k, host } = await activeHost("m1", "held");
    await env.DB.prepare("UPDATE hosts SET status = 'suspended' WHERE id = ?").bind(host).run();
    const r = await signed(k, host, "GET", "/hosts/self/state");
    expect([r.status, r.json.code]).toEqual([403, "host_status"]);
  });

  it("the cron prunes nonces past the window and unused tokens a day after they expired", async () => {
    await env.DB.prepare("INSERT INTO host_nonces (host_id, nonce, at) VALUES ('h_old', 'n', ?)").bind(new Date(Date.now() - 6 * 60000).toISOString()).run();
    await env.DB.prepare("INSERT INTO host_enrollments (token_hash, id, login, github_id, name, expires_at) VALUES ('t-old', 'he_old', 'm1', 1001, 'x', ?)").bind(new Date(Date.now() - 25 * 3600e3).toISOString()).run();
    expect(await pruneHosts(env)).toBeGreaterThanOrEqual(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM host_nonces WHERE host_id = 'h_old'").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM host_enrollments WHERE id = 'he_old'").first("n")).toBe(0);
  });
});

describe("the host worker token", () => {
  it("claims once fetched; a rotation keeps the old one ten minutes, a running task's job token never notices, and then the old one stops", async () => {
    const { k, host, worker, token } = await activeHost("m1", "rotating");
    expect((await call("GET", "/factory/workers/self", { token })).json).toMatchObject({ id: worker, trust: "project", owner: "m1" });
    // A project build for its architecture: the host's registration takes it.
    const enqueue = await issueJobToken(env, { t: 1, k: "enqueue", s: scopesFor("enqueue", 1, "project", {}), e: Math.floor(Date.now() / 1000) + 3600, w: "w-pool" });
    const q = await call("POST", "/factory/enqueue", { token: enqueue, body: { name: "hosttool", pkgbuild_ref: "abc123", reason: "test", arches: ["aarch64"], version: "1.0-1" } });
    expect(q.status, JSON.stringify(q.json)).toBe(201);
    const c = await call("POST", "/factory/claim", { token, body: { arch: "aarch64" } });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    const job = c.json.token;
    // Rotation: a new token, the old one still good for ten minutes.
    const r = await signed(k, host, "POST", "/hosts/self/token");
    expect(r.status).toBe(200);
    expect(r.json.token).not.toBe(token);
    expect(Date.parse(r.json.previous_valid_until) - Date.now()).toBeGreaterThan(9 * 60000);
    expect(Date.parse(r.json.rotate_after) - Date.parse(r.json.issued_at)).toBe(30 * 24 * 3600e3);
    expect((await call("GET", "/factory/workers/self", { token })).status).toBe(200);
    expect((await call("GET", "/factory/workers/self", { token: r.json.token })).status).toBe(200);
    // The task runs on: its job token does not depend on the worker token.
    expect((await call("POST", `/factory/tasks/${c.json.task.id}/heartbeat`, { token: job, body: {} })).status).toBe(200);
    // Ten minutes later the old token is gone; the new one and the task are not.
    await env.DB.prepare("UPDATE hosts SET prev_token_until = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), host).run();
    expect((await call("GET", "/factory/workers/self", { token })).status).toBe(401);
    expect((await call("POST", "/factory/claim", { token, body: { arch: "aarch64" } })).status).toBe(401);
    expect((await call("GET", "/factory/workers/self", { token: r.json.token })).status).toBe(200);
    expect((await call("POST", `/factory/tasks/${c.json.task.id}/heartbeat`, { token: job, body: {} })).status).toBe(200);
    // The state says when the next rotation is due; the listing never serves a token's hash.
    expect((await signed(k, host, "GET", "/hosts/self/state")).json.token.rotate_after).toBe(r.json.rotate_after);
    const listed = (await call("GET", "/factory?limit=13")).json.workers.find((w: any) => w.id === worker);
    expect(listed).toMatchObject({ kind: "host", host_id: host, set_rollout: "host" });
    expect(listed.token_hash).toBeUndefined();
  });

  it("a confirmed host's registration is never forgotten by the prune of tokenless workers", async () => {
    const m = await mint("m1", "tokenless");
    const e = await enroll(m.json.token, await newKey());
    const c = await call("POST", `/hosts/${e.json.host}/confirm`, { session: "m1", body: {} });
    await env.DB.prepare("UPDATE build_workers SET last_seen = '2000-01-01T00:00:00Z' WHERE id = ?").bind(c.json.worker).run();
    const { pruneWorkers } = await import("../src/routes/factory");
    await pruneWorkers(env);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM build_workers WHERE id = ?").bind(c.json.worker).first("n")).toBe(1);
  });
});

describe("the host report", () => {
  it("is kept with the columns the host page reads; the units are the pool's count; a report over 16 KiB or with a secret is refused", async () => {
    const { k, host } = await activeHost("m1", "reporting");
    const report = {
      agent: { version: "0.2.1", provider: "anthropic", model: "claude-opus-5-5" },
      os: "linux", arch: "aarch64", page_kb: 16,
      runtime: { driver: "compose/docker", isolation: "root", dedicated: true, rootless: false },
      capacity: { ...STUDIO, units: 40 },
      release: { applied: "v1.20.0", target: "v1.21.0" },
      round: { outcome: "rolled-back", from: "v1.21.0", step: "guard" },
      tasks: { running: 1, units_busy: 2 },
    };
    const r = await signed(k, host, "POST", "/hosts/self/report", JSON.stringify(report));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ units: 11, below_minimum: null });
    const row = await env.DB.prepare("SELECT agent_version, release_applied, release_target, rolled_back_from, units, provider, model, reported_at FROM hosts WHERE id = ?").bind(host).first();
    expect(row).toMatchObject({ agent_version: "0.2.1", release_applied: "v1.20.0", release_target: "v1.21.0", rolled_back_from: "v1.21.0", units: 11, provider: "anthropic", model: "claude-opus-5-5" });
    expect((await call("GET", `/hosts/${host}`, { session: "m1" })).json.host).toMatchObject({ alive: true, round: { outcome: "rolled-back" }, release_applied: "v1.20.0" });
    // Below the minimum later: kept, and said.
    const shrunk = await signed(k, host, "POST", "/hosts/self/report", JSON.stringify({ capacity: { ...STUDIO, mem_gb: 6 } }));
    expect(shrunk.json.below_minimum).toContain("6 GB of memory (8 needed)");
    const secret = await signed(k, host, "POST", "/hosts/self/report", JSON.stringify({ round: { detail: `token omw_${"a".repeat(48)}` } }));
    expect([secret.status, secret.json.code]).toEqual([422, "leak"]);
    const big = await signed(k, host, "POST", "/hosts/self/report", JSON.stringify({ x: "a".repeat(17 * 1024) }));
    expect(big.status).toBe(413);
  });
});

describe("Update for a host's registration (the host rollout word)", () => {
  it("is taken while its agent reports a release behind the pool's, and refused, with why, when it does not report", async () => {
    const { k, host, worker } = await activeHost("m1", "updating");
    const on = { ...env, POOL_VERSION: "v1.21.0" } as typeof env;
    // Nothing reported yet.
    let r = await updateOrder(on, worker);
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("reports no release applied");
    await signed(k, host, "POST", "/hosts/self/report", JSON.stringify({ release: { applied: "v1.20.0" } }));
    r = await updateOrder(on, worker);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // An agent silent for longer than the window: refused, with why.
    const { k: k2, host: h2, worker: w2 } = await activeHost("m1", "silent");
    await signed(k2, h2, "POST", "/hosts/self/report", JSON.stringify({ release: { applied: "v1.20.0" } }));
    await env.DB.prepare("UPDATE hosts SET reported_at = ? WHERE id = ?").bind(new Date(Date.now() - 20 * 60000).toISOString(), h2).run();
    const silent = await updateOrder(on, w2);
    expect(silent.status).toBe(409);
    expect(silent.json.error).toContain("its host's agent has not reported for 20 min");
  });
});

async function updateOrder(on: typeof env, id: string): Promise<Res> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1/factory/workers/${id}/orders`, { method: "POST", headers: { cookie: "omc=oms_m1", origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ kind: "update", reason: "a release" }) }), on, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
