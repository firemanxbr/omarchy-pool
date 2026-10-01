/**
 * Stopping a maintainer host (#322, epic #307, design v2 §6.2, §6.4, §8.6,
 * §16.4; D20, D39, D57), through the Worker with real Ed25519 host keys and
 * real passkeys (the software authenticator):
 *
 * - Suspend — its owner or any maintainer, with a reason: claims refused at
 *   once, the host key refused, the registration's open orders cancelled,
 *   its running lease fenced (one order row per task, the bulk fence), the
 *   agent's follow refused; Resume by the owner only, with a passkey, and
 *   the same registration claims again with nothing done on the host.
 * - Retire — its owner, or a maintainer with a passkey: the key and the
 *   worker token burnt; a new install enrolls a new host, never the old key.
 * - Drain on a host's registration (D57): an owner's drain is the owner's to
 *   lift, another maintainer's either of the two's.
 * - The maintainer list (D39): an owner removed stops claiming at that sync,
 *   and at the very next claim between syncs, while the running task
 *   heartbeats and uploads; a rename that resolves to the same GitHub user id
 *   changes nothing; listed again, one Resume with a passkey covers all the
 *   owner's hosts.
 * - Removed for cause — another maintainer's passkey and a reason: every host
 *   of the owner suspended and their leases fenced in one statement.
 * - Every act on the journal with who and why; everyone else refused
 *   server-side; every new statement through an index.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance, STOP_REMOVED_OWNERS_SQL } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { issueJobToken, scopesFor } from "../src/jobtoken";
import { toB64url } from "../src/webauthn";
import { enrollMessage, hostClaimRefusal, hostReason, signedMessage, HOST_CLAIM_SQL, OWNER_NOT_MAINTAINER } from "../src/hosts";
import { BULK_FENCE_SQL, FENCE_ORDERS_SQL, FENCED_SQL, hostVerdicts } from "../src/routes/hosts";
import { FOLLOW_SQL } from "../src/routes/orders";
import { requeueExpiredLeases } from "../src/routes/factory";
import { SUBJECT } from "../src/routes/passkeys";
import { assert as answer, createAuthenticator, register } from "./soft-authenticator.mjs";

/** localhost: where a passkey works (relyingParty), as wrangler dev's. */
const ORIGIN = "http://localhost:8787";
const STUDIO = { cpus: 12, mem_gb: 32, disk_free_gb: { work: 410, engine: 220 }, units: 11, agent_slots: 2, lanes: [{ arch: "aarch64", mode: "native" }] };

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
async function signed(k: Key, host: string, method: string, path: string): Promise<Res> {
  const ts = Math.floor(Date.now() / 1000), nonce = hex(16);
  const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const sig = await sign(k, signedMessage(host, method, `/api/v1${path}`, empty, ts, nonce));
  return call(method, path, { raw: method === "GET" ? undefined : "", headers: { "omarchy-host": `${host}; ts=${ts}; nonce=${nonce}; sig=${sig}` } });
}
async function enroll(owner: string, name: string, k: Key): Promise<Res> {
  const m = await call("POST", "/hosts/enrollments", { session: owner, body: { name } });
  expect(m.status, JSON.stringify(m.json)).toBe(201);
  return call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(k, enrollMessage(m.json.token, k.pub)), hostname: "box-1", os: "linux", arch: "aarch64", page_kb: 16, isolation: "root", dedicated: true, agent_version: "0.2.0", capacity: STUDIO } });
}
/** One maintainer host from nothing to active, with its worker token. */
async function activeHost(owner: string, name: string): Promise<{ k: Key; host: string; worker: string; token: string }> {
  const k = await newKey();
  const e = await enroll(owner, name, k);
  expect(e.status, JSON.stringify(e.json)).toBe(201);
  const c = await call("POST", `/hosts/${e.json.host}/confirm`, { session: owner, body: {} });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const t = await signed(k, e.json.host, "POST", "/hosts/self/token");
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  return { k, host: e.json.host, worker: c.json.worker, token: t.json.token };
}

let n = 0;
/** A project build for aarch64, queued, and the host's registration's claim of it: the task and its job token. */
async function leased(token: string): Promise<{ task: number; job: string }> {
  const enqueue = await issueJobToken(env, { t: 1, k: "enqueue", s: scopesFor("enqueue", 1, "project", {}), e: Math.floor(Date.now() / 1000) + 3600, w: "w-pool" });
  const q = await call("POST", "/factory/enqueue", { token: enqueue, body: { name: `hosttool${++n}`, pkgbuild_ref: "abc123", reason: "test", arches: ["aarch64"], version: "1.0-1" } });
  expect(q.status, JSON.stringify(q.json)).toBe(201);
  const c = await claim(token);
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { task: c.json.task.id, job: c.json.token };
}
const claim = (token: string) => call("POST", "/factory/claim", { token, body: { arch: "aarch64" } });
const heartbeat = (task: number, job: string) => call("POST", `/factory/tasks/${task}/heartbeat`, { token: job, body: {} });
const hostRow = (id: string) => env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<any>();
const taskRow = (id: number) => env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<any>();
const hostLines = (action: string) => env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'host' AND json_extract(payload, '$.action') = ? ORDER BY id").bind(action).all<{ status: string; summary: string; payload: string }>().then((r) => r.results.map((l) => ({ ...l, payload: JSON.parse(l.payload) })));
const follow = (worker: string) => call("GET", `/factory/follow?ids=${worker}&n=${hex(4)}`);

/** Each maintainer's passkey, registered on their page. */
const keys: Record<string, Awaited<ReturnType<typeof createAuthenticator>>> = {};
async function registerFor(login: string): Promise<void> {
  const a = await createAuthenticator();
  const o = await call("POST", "/auth/passkeys/challenge", { session: login, body: {} });
  const reg = await call("POST", "/auth/passkeys", { session: login, body: { label: "laptop", ...(await register(a, { challenge: o.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost" })) } });
  expect(reg.status, JSON.stringify(reg.json)).toBe(201);
  keys[login] = a;
}
async function assertion(login: string, subject: string): Promise<Record<string, string>> {
  const c = await call("POST", "/auth/passkeys/assert", { session: login, body: { for: subject } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return answer(keys[login], { challenge: c.json.publicKey.challenge, origin: ORIGIN, rpId: "localhost" });
}
const LIST = ["m1", "m2", "m3", "m4"];
/** A passkey's first use, minutes after its registration, says so on the line (#287). */
const JUST_NOW = "(?: with a passkey registered just now)?";

beforeAll(async () => {
  const h = sha256Hex;
  const people: [string, string, number | null][] = [["m1", "maintainer", 1001], ["m2", "maintainer", 1002], ["m3", "maintainer", 1003], ["m4", "maintainer", 1004], ["alice", "contributor", 2001], ["m4-renamed", "contributor", 1004]];
  await env.DB.batch(await Promise.all(people.map(async ([l, role, g]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES (?, ?, ?, ?, ?)").bind(l, await h(`omc_${l}`), await h(`oms_${l}`), role, g))));
  await applyGovernance(env, LIST, "sha-start");
  for (const m of ["m1", "m2", "m3", "m4"]) await registerFor(m);
});

describe("the D1 migration (0044)", () => {
  it("adds who stopped a host, when and why, and the list's stop; the statuses are 0043's four", async () => {
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('hosts')").all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["status_by", "status_at", "status_reason", "owner_removed_at"]));
    for (const ok of ["pending-owner", "active", "suspended", "retired"]) {
      await env.DB.prepare("INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status) VALUES (?, 'm1', 1001, 'mig', ?, ?)").bind(`h_mig${ok.length}`, `k-${ok}`, ok).run();
    }
    await expect(env.DB.prepare("INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status) VALUES ('h_migx', 'm1', 1001, 'mig', 'k-x', 'draining')").run()).rejects.toThrow(/CHECK/);
    await env.DB.prepare("DELETE FROM hosts WHERE name = 'mig'").run();
  });
});

describe("Suspend and Resume", () => {
  it("stops the claims at once and fences the running lease; the owner's Resume brings the same registration back with no action on the host", async () => {
    const { k, host, worker, token } = await activeHost("m1", "susp");
    const { task, job } = await leased(token);
    // An order waiting for the registration: cancelled by the suspension.
    const now = new Date().toISOString(), later = new Date(Date.now() + 3600e3).toISOString();
    await env.DB.prepare("INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, via, issued_at, expires_at) VALUES (?, ?, 'restart', 'stuck', 'm1', 'web', ?, ?)").bind(`wo_${"a".repeat(32)}`, worker, now, later).run();
    const s = await call("POST", `/hosts/${host}/suspend`, { session: "m2", body: { reason: "fans failing, looking at it" } });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json).toMatchObject({ host, status: "suspended", by: "m2", reason: "fans failing, looking at it", fenced: [task] });
    expect(await hostRow(host)).toMatchObject({ status: "suspended", status_by: "m2", status_reason: "fans failing, looking at it" });
    // Claims refused at once, and why; the host key refused; the agent's follow refused, never cached.
    expect(await claim(token)).toMatchObject({ status: 403, json: { code: "host_suspended", error: "susp is suspended (by m2: fans failing, looking at it): it claims nothing until m1 resumes it" } });
    expect(await signed(k, host, "GET", "/hosts/self/state")).toMatchObject({ status: 403, json: { code: "host_status", status: "suspended" } });
    expect(await follow(worker)).toMatchObject({ status: 403, json: { code: "host_status", status: "suspended" } });
    // The lease is fenced by one closed order row of its own: every heartbeat is refused, nothing renewed.
    const t = await taskRow(task);
    expect(t.status).toBe("leased");
    const o = await env.DB.prepare("SELECT * FROM worker_orders WHERE id = ?").bind(t.stop_order).first<any>();
    expect(o).toMatchObject({ worker_id: worker, kind: "stop-task", task_id: task, issued_by: "m2", reason: "fans failing, looking at it", state: "done" });
    expect(await heartbeat(task, job)).toMatchObject({ status: 409, json: { stop: true, state: "stopping" } });
    expect(await env.DB.prepare("SELECT state, detail FROM worker_orders WHERE id = ?").bind(`wo_${"a".repeat(32)}`).first()).toEqual({ state: "cancelled", detail: "its host was suspended by m2" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM worker_orders WHERE worker_id = ? AND state IN ('pending', 'delivered')").bind(worker).first("n")).toBe(0);
    // The journal: who, why, the fenced task.
    const line = (await hostLines("suspend")).find((l) => l.payload.host === host)!;
    expect(line).toMatchObject({ status: "warn", summary: "susp of m1 suspended by m2: fans failing, looking at it", payload: { by: "m2", reason: "fans failing, looking at it", fenced: [task] } });
    // The fenced lease ends as the pool fenced it: back in the queue at its end, the person and the reason on its line.
    await env.DB.prepare("UPDATE build_tasks SET lease_expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), task).run();
    await requeueExpiredLeases(env);
    expect(await taskRow(task)).toMatchObject({ status: "queued", stop_order: null, error: `stopped on ${worker} by m2: fans failing, looking at it; its lease ended` });

    // Resume: the owner's, with a passkey; another maintainer, a token or no passkey are refused and nothing changes.
    expect(await call("POST", `/hosts/${host}/resume`, { session: "m2", body: {} })).toMatchObject({ status: 403, json: { error: "only m1 resumes susp, with their passkey" } });
    expect(await call("POST", `/hosts/${host}/resume`, { token: "omc_m1", body: {} })).toMatchObject({ status: 403, json: { code: "web_only" } });
    expect(await call("POST", `/hosts/${host}/resume`, { session: "m1", body: {} })).toMatchObject({ status: 403, json: { code: "passkey_required" } });
    expect((await hostRow(host)).status).toBe("suspended");
    const r = await call("POST", `/hosts/${host}/resume`, { session: "m1", body: { assertion: await assertion("m1", `host:resume:${host}`) } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // Nothing done on the host: the same worker token claims, the same key is heard, the follow answers.
    const again = await claim(token);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.task.id).toBe(task);
    expect((await signed(k, host, "GET", "/hosts/self/state")).json.status).toBe("active");
    expect((await follow(worker)).status).toBe(200);
    expect((await hostLines("resume")).find((l) => l.payload.host === host)).toMatchObject({ status: "ok", summary: expect.stringMatching(new RegExp(`^susp of m1 resumed by m1${JUST_NOW} \\(suspended by m2: fans failing, looking at it\\)$`)) });
  });

  it("a claim already past the host's read when a suspension commits leases nothing: the lease's own statement checks the host", async () => {
    const { host, token } = await activeHost("m1", "race");
    const enqueue = await issueJobToken(env, { t: 1, k: "enqueue", s: scopesFor("enqueue", 1, "project", {}), e: Math.floor(Date.now() / 1000) + 3600, w: "w-pool" });
    const name = `hostrace${++n}`;
    expect((await call("POST", "/factory/enqueue", { token: enqueue, body: { name, pkgbuild_ref: "abc123", reason: "test", arches: ["aarch64"], version: "1.0-1" } })).status).toBe(201);
    // The suspension lands between the claim's read of its host and its lease UPDATE: the read said active, the UPDATE runs after.
    const db = env.DB, prepare = db.prepare.bind(db);
    let raced = false;
    (db as { prepare: typeof db.prepare }).prepare = (sql: string) => {
      const stmt = prepare(sql);
      if (!sql.includes("UPDATE build_tasks SET status = 'leased'")) return stmt;
      return { bind: (...args: unknown[]) => ({ first: async () => {
        await prepare("UPDATE hosts SET status = 'suspended', status_by = 'm2', status_reason = 'raced the claim' WHERE id = ?").bind(host).run();
        raced = true;
        return stmt.bind(...args).first();
      } }) } as unknown as D1PreparedStatement;
    };
    try {
      expect((await claim(token)).status).toBe(204);
    } finally {
      (db as { prepare: typeof db.prepare }).prepare = prepare;
    }
    expect(raced).toBe(true);
    expect(await env.DB.prepare("SELECT status, lease_owner FROM build_tasks WHERE name = ?").bind(name).first()).toEqual({ status: "queued", lease_owner: null });
    expect((await claim(token)).json).toMatchObject({ code: "host_suspended" });
    // The queued task is the race's own: the tests after it start with an empty queue.
    await env.DB.prepare("DELETE FROM build_tasks WHERE name = ?").bind(name).run();
  });

  it("is its owner's or a maintainer's, with a reason, from the browser: everyone else is refused server-side and nothing changes", async () => {
    const { host } = await activeHost("m1", "who");
    const reason = { reason: "a reason enough" };
    expect(await call("POST", `/hosts/${host}/suspend`, { body: reason, headers: { origin: ORIGIN } })).toMatchObject({ status: 401 });
    expect(await call("POST", `/hosts/${host}/suspend`, { session: "alice", body: reason })).toMatchObject({ status: 403, json: { error: "only m1 or a maintainer stops who" } });
    expect(await call("POST", `/hosts/${host}/suspend`, { token: "omc_m2", body: reason })).toMatchObject({ status: 403, json: { code: "web_only" } });
    expect(await call("POST", `/hosts/${host}/suspend`, { session: "m2", body: reason, headers: { origin: "https://evil.test" } })).toMatchObject({ status: 403, json: { code: "origin" } });
    for (const bad of [{}, { reason: "no" }, { reason: "x".repeat(301) }, { reason: "ghp_" + "a".repeat(36) }]) {
      expect(await call("POST", `/hosts/${host}/suspend`, { session: "m2", body: bad }), JSON.stringify(bad)).toMatchObject({ status: 400, json: { code: "reason" } });
    }
    expect((await hostRow(host)).status).toBe("active");
    // Its owner suspends it too; a second suspension says so; GET /hosts/:id carries the same verdicts for the page.
    expect((await call("POST", `/hosts/${host}/suspend`, { session: "m1", body: reason })).status).toBe(200);
    expect(await call("POST", `/hosts/${host}/suspend`, { session: "m2", body: reason })).toMatchObject({ status: 409, json: { error: "who is suspended already — its owner's Resume ends it" } });
    const asOwner = (await call("GET", `/hosts/${host}`, { session: "m1" })).json;
    expect(asOwner.can).toMatchObject({ suspend: false, resume: true, retire: true });
    expect(asOwner.passkey).toEqual({ retire: false });
    expect(asOwner.host).toMatchObject({ status: "suspended", status_by: "m1", status_reason: "a reason enough" });
    const asOther = (await call("GET", `/hosts/${host}`, { session: "m2" })).json;
    expect(asOther.can).toMatchObject({ resume: false, retire: true, why: { resume: "only m1 resumes who, with their passkey" } });
    expect(asOther.passkey).toEqual({ retire: true });
    expect((await call("GET", `/hosts/${host}`)).json.can).toMatchObject({ suspend: false, resume: false, retire: false, why: { suspend: "sign in with GitHub" } });
  });
});

describe("Retire", () => {
  it("burns the key and the worker token; a re-install enrolls a new host with a new key, never the old one", async () => {
    const { k, host, worker, token } = await activeHost("m1", "old");
    // Another maintainer: a passkey and a reason.
    expect(await call("POST", `/hosts/${host}/retire`, { session: "m2", body: { reason: "moved to a new box" } })).toMatchObject({ status: 403, json: { code: "passkey_required" } });
    expect(await call("POST", `/hosts/${host}/retire`, { session: "alice", body: { reason: "moved to a new box" } })).toMatchObject({ status: 403 });
    const r = await call("POST", `/hosts/${host}/retire`, { session: "m2", body: { reason: "moved to a new box", assertion: await assertion("m2", `host:retire:${host}`) } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await hostRow(host)).toMatchObject({ status: "retired", status_by: "m2", status_reason: "moved to a new box" });
    // The key: refused, and the status rides the refusal for the agent. The token: revoked, so nothing claims with it.
    expect(await signed(k, host, "GET", "/hosts/self/state")).toMatchObject({ status: 403, json: { status: "retired" } });
    expect((await claim(token)).status).toBe(401);
    expect((await env.DB.prepare("SELECT revoked_at FROM build_workers WHERE id = ?").bind(worker).first<any>()).revoked_at).not.toBeNull();
    expect(await follow(worker)).toMatchObject({ status: 403, json: { status: "retired" } });
    expect(await call("POST", `/hosts/${host}/retire`, { session: "m1", body: { reason: "again please" } })).toMatchObject({ status: 409 });
    expect((await hostLines("retire")).find((l) => l.payload.host === host)).toMatchObject({ status: "warn", summary: expect.stringMatching(new RegExp(`^old of m1 retired by m2${JUST_NOW}: moved to a new box$`)) });
    // The re-install: the old key is never a host again; a new key under the same name is a new host.
    expect(await enroll("m1", "old", k)).toMatchObject({ status: 409, json: { code: "key_taken" } });
    const fresh = await activeHost("m1", "old");
    expect(fresh.host).not.toBe(host);
    expect((await claim(fresh.token)).status).toBe(204);
  });

  it("is its owner's without a passkey, with a reason", async () => {
    const { host } = await activeHost("m3", "mine");
    expect(await call("POST", `/hosts/${host}/retire`, { session: "m3", body: {} })).toMatchObject({ status: 400, json: { code: "reason" } });
    expect((await call("POST", `/hosts/${host}/retire`, { session: "m3", body: { reason: "selling the machine" } })).status).toBe(200);
  });
});

describe("Drain on a host's registration (D57)", () => {
  const order = (worker: string, kind: string, as: string) => call("POST", `/factory/workers/${worker}/orders`, { session: as, body: { kind, reason: kind === "drain" ? "need the machine" : undefined } });
  it("an owner's drain is lifted by the owner only; another maintainer's by either of the two", async () => {
    const { worker, token } = await activeHost("m1", "drn");
    expect((await order(worker, "drain", "m1")).status).toBe(201);
    expect((await claim(token)).status).toBe(204);
    expect(await order(worker, "resume", "m2")).toMatchObject({ status: 403, json: { error: expect.stringMatching(/^m1 drained their host \(.*\): it goes back to work on m1's word only — they may need the machine$/) } });
    expect((await call("GET", `/factory/workers/${worker}/can`, { session: "m2" })).json.can.resume).toBe(false);
    expect((await order(worker, "resume", "m1")).status).toBe(201);
    // Another maintainer's drain: m2's, lifted by m2 or by the owner — not by a third maintainer.
    expect((await order(worker, "drain", "m2")).status).toBe(201);
    expect(await order(worker, "resume", "m3")).toMatchObject({ status: 403, json: { error: expect.stringMatching(/^m2 drained it \(.*\): m1 or m2 resumes it$/) } });
    expect((await order(worker, "resume", "m2")).status).toBe(201);
    expect((await order(worker, "drain", "m2")).status).toBe(201);
    expect((await order(worker, "resume", "m1")).status).toBe(201);
    expect((await claim(token)).status).toBe(204);
  });
});

describe("the maintainer list (D39)", () => {
  it("removing the owner stops the claims within one sync — and at the next claim before it — while the running task heartbeats and uploads", async () => {
    const { host, worker, token } = await activeHost("m4", "list");
    const { task, job } = await leased(token);
    // Between two syncs: the claim joins the owner with the list, so a removal holds at once.
    await env.DB.prepare("DELETE FROM factory_maintainers WHERE login = 'm4'").run();
    expect(await claim(token)).toMatchObject({ status: 403, json: { code: "owner_not_maintainer", error: expect.stringContaining(OWNER_NOT_MAINTAINER) } });
    // The sync: the host is marked, one journal line; nothing is fenced.
    const log = await applyGovernance(env, ["m1", "m2", "m3"], "sha-without-m4");
    expect(log).toContain(`list of m4 stops claiming: ${OWNER_NOT_MAINTAINER}`);
    expect((await hostRow(host)).owner_removed_at).not.toBeNull();
    expect((await hostLines("owner_removed")).filter((l) => l.payload.host === host)).toHaveLength(1);
    expect((await taskRow(task)).stop_order).toBeNull();
    // The running task: its heartbeat renews it, its upload is taken.
    expect((await heartbeat(task, job)).status).toBe(200);
    const bytes = `package of task ${task}\n`;
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const put = await call("PUT", `/pool/${sha}?filename=hosttool-1.0-1-aarch64.pkg.tar.zst&source=extra&arch=aarch64`, { token: job, raw: bytes, headers: { "content-type": "application/octet-stream" } });
    expect(put.status, JSON.stringify(put.json)).toBeLessThan(300);
    expect(await claim(token)).toMatchObject({ status: 403, json: { code: "owner_not_maintainer" } });
    // A second sync writes nothing more; signed requests still work (the agent is not refused: only claims are).
    await applyGovernance(env, ["m1", "m2", "m3"], "sha-without-m4-again");
    expect((await hostLines("owner_removed")).filter((l) => l.payload.host === host)).toHaveLength(1);
    expect((await follow(worker)).status).toBe(200);

    // Listed again: still stopped until the owner's one Resume, with a passkey, which covers all their hosts.
    await applyGovernance(env, LIST, "sha-with-m4");
    expect(await claim(token)).toMatchObject({ status: 403, json: { code: "owner_not_maintainer", error: expect.stringContaining("claims again once m4 resumes their hosts on their page") } });
    expect(await call("POST", "/hosts/owners/m4/resume", { session: "m1", body: {} })).toMatchObject({ status: 403 });
    expect(await call("POST", "/hosts/owners/m4/resume", { session: "m4", body: {} })).toMatchObject({ status: 403, json: { code: "passkey_required" } });
    const r = await call("POST", "/hosts/owners/m4/resume", { session: "m4", body: { assertion: await assertion("m4", "host:resume-all:m4") } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.hosts).toEqual([host]);
    expect((await hostRow(host)).owner_removed_at).toBeNull();
    expect((await claim(token)).status).not.toBe(403);
    expect(await call("POST", "/hosts/owners/m4/resume", { session: "m4", body: {} })).toMatchObject({ status: 409, json: { code: "no_host" } });
    expect(await hostLines("resume_owner")).toHaveLength(1);
  });

  it("a login renamed in the file that resolves to the same GitHub user id changes nothing", async () => {
    const { host, token } = await activeHost("m4", "renamed");
    // m4 renamed their account; they signed in as m4-renamed (the same GitHub user id, 1004), and the file lists the new login.
    const log = await applyGovernance(env, ["m1", "m2", "m3", "m4-renamed"], "sha-renamed");
    expect(log).not.toContain("stops claiming");
    expect((await hostRow(host)).owner_removed_at).toBeNull();
    expect((await claim(token)).status).not.toBe(403);
    // Re-added under the old name: still the same person, still nothing.
    await applyGovernance(env, LIST, "sha-back");
    expect((await claim(token)).status).not.toBe(403);
  });

  it("the sync's statement and the claim's read go through the primary keys", async () => {
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const claimPlan = await plan(HOST_CLAIM_SQL, ["h_0123456789"]);
    expect(claimPlan).toMatch(/SEARCH hosts USING INDEX sqlite_autoindex_hosts_1 \(id=\?\)/);
    expect(claimPlan).toMatch(/SEARCH c USING INDEX sqlite_autoindex_contributors_1 \(login=\?\)/);
    expect(claimPlan).not.toMatch(/SCAN c\b/);
    expect(await plan(FOLLOW_SQL, ['["a"]'])).toMatch(/SEARCH hosts USING INDEX sqlite_autoindex_hosts_1 \(id=\?\)/);
    const fence = await plan(BULK_FENCE_SQL("id = ?5"), [null, null, "2026-01-01T00:00:00.000Z", null, "h_0123456789"]);
    expect(fence).toMatch(/SEARCH build_tasks USING INDEX idx_build_tasks_lease \(status=\?\)/);
    expect(fence).toMatch(/SEARCH o USING INDEX idx_worker_orders_worker \(worker_id=\? AND issued_at=\?\)/);
    expect(await plan(FENCE_ORDERS_SQL("owner_github_id = ?5"), ["r", "m1", "2026-01-01T00:00:00.000Z", "d", 1])).toMatch(/SEARCH t USING INDEX idx_build_tasks_lease \(status=\?\)/);
    expect(await plan(FENCED_SQL, ["2026-01-01T00:00:00.000Z", "m1"])).toMatch(/idx_worker_orders_issuer \(issued_by=\? AND issued_at=\?\)/);
    expect(await plan(STOP_REMOVED_OWNERS_SQL, ["2026-01-01T00:00:00.000Z"])).not.toMatch(/SCAN (contributors|factory_maintainers m)(?! USING)/);
  });
});

describe("Removed for cause", () => {
  it("suspends every host of the owner and fences their leases in one statement, with another maintainer's passkey and a reason", async () => {
    const a = await activeHost("m3", "cause-a");
    const b = await activeHost("m3", "cause-b");
    const ta = await leased(a.token);
    const tb = await leased(b.token);
    const reason = { reason: "account compromised, see #999" };
    expect(await call("POST", "/hosts/owners/m3/cause", { session: "m3", body: reason })).toMatchObject({ status: 403, json: { code: "second_maintainer" } });
    expect(await call("POST", "/auth/passkeys/assert", { session: "m3", body: { for: "host:cause:m3" } })).toMatchObject({ status: 403, json: { code: "second_maintainer" } });
    expect(await call("POST", "/hosts/owners/m3/cause", { session: "alice", body: reason })).toMatchObject({ status: 403, json: { code: "maintainers_only" } });
    expect(await call("POST", "/hosts/owners/m3/cause", { session: "m2", body: reason })).toMatchObject({ status: 403, json: { code: "passkey_required" } });
    expect(await call("POST", "/hosts/owners/m3/cause", { session: "m2", body: { assertion: await assertion("m2", "host:cause:m3") } })).toMatchObject({ status: 400, json: { code: "reason" } });
    expect((await hostRow(a.host)).status).toBe("active");
    const r = await call("POST", "/hosts/owners/m3/cause", { session: "m2", body: { ...reason, assertion: await assertion("m2", "host:cause:m3") } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.hosts.sort()).toEqual([a.host, b.host].sort());
    expect(r.json.fenced.sort()).toEqual([ta.task, tb.task].sort());
    for (const h of [a, b]) {
      expect(await hostRow(h.host)).toMatchObject({ status: "suspended", status_by: "m2", status_reason: "removed for cause: account compromised, see #999" });
      expect(await claim(h.token)).toMatchObject({ status: 403, json: { code: "host_suspended" } });
    }
    for (const t of [ta, tb]) expect(await heartbeat(t.task, t.job)).toMatchObject({ status: 409, json: { stop: true } });
    const line = (await hostLines("cause"))[0];
    expect(line).toMatchObject({ status: "error", summary: expect.stringMatching(new RegExp(`^m3 removed for cause by m2${JUST_NOW}: 2 hosts suspended, their running tasks fenced — account compromised, see #999$`)) });
    expect(line.payload.fenced.sort()).toEqual([ta.task, tb.task].sort());
    // Nothing left to stop now: a second one is refused.
    expect(await call("POST", "/hosts/owners/m1/cause", { session: "m2", body: reason })).toMatchObject({ status: 403 });
  });
});

describe("the rules, pure", () => {
  it("the claim's words, the reasons, the verdicts and the passkey's subjects", () => {
    const row = { name: "x", status: "active", status_by: null, status_at: null, status_reason: null, owner_login: "m1", owner_removed_at: null, listed: 1 };
    expect(hostClaimRefusal(row)).toBeNull();
    expect(hostClaimRefusal({ ...row, listed: 0 })!.code).toBe("owner_not_maintainer");
    expect(hostClaimRefusal({ ...row, status: "retired" })!.code).toBe("host_retired");
    expect(hostClaimRefusal({ ...row, status: "pending-owner" })!.code).toBe("host_status");
    expect(hostReason("  two  words ")).toBe("two words");
    for (const bad of [null, 3, "abc", "x".repeat(301), "tab\u0007bell"]) expect(hostReason(bad)).toBeNull();
    const h = { name: "x", status: "active", owner_login: "m1", owner_github_id: 1 };
    expect(hostVerdicts({ login: "m1", maintainer: false, github_id: 1 }, h).suspend.ok).toBe(true);
    expect(hostVerdicts({ login: "m1", maintainer: false, github_id: 1 }, { ...h, status: "suspended" }).resume).toMatchObject({ ok: false, status: 403 });
    expect(hostVerdicts({ login: "m1-new", maintainer: true, github_id: 1 }, { ...h, status: "suspended" }).resume.ok).toBe(true);
    expect(hostVerdicts({ login: "m1", maintainer: true, github_id: 9 }, { ...h, status: "suspended" }).resume).toMatchObject({ ok: false, status: 403 });
    for (const ok of ["host:resume:h_0123456789", "host:retire:h_0123456789", "host:cause:m1", "host:resume-all:m1"]) expect(SUBJECT.test(ok), ok).toBe(true);
    for (const no of ["host:resume:x", "host:suspend:h_0123456789", "host:cause:", "host:retire:h_012345678"]) expect(SUBJECT.test(no), no).toBe(false);
  });
});
