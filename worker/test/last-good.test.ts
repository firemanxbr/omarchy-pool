/**
 * A host that reverted a release claims on its last-good for up to 6 hours,
 * and the tasks of a revoked release are refused and requeued (#342, epic
 * #307, design v2 §8.6, §9.1, §16.2, §18.3; D55), inside workerd with a real
 * D1 and real Ed25519 host keys:
 *
 * - the migration (0048) and the report: the release its guard reverted is
 *   kept while its reports hold it back, with the time the pool first heard
 *   of it; a retry that reverts again keeps that time; applying it forgets it;
 * - the claim, past the grace, on the release its agent applied: handed work
 *   for six hours, told once in the journal, warned on Status (the listing's
 *   `update.last_good_until`) and on the host page; then 426, told once; 426
 *   below the signed min_release and on another release than its applied one;
 * - a lease claimed on a release the pool's release revokes: its heartbeat,
 *   its staging uploads (single and multipart), its pool writes and its
 *   completion refused with `stop` (state `revoked`); its host's report
 *   requeues it with the attempt given back and no host loss, as does its
 *   host dropping it from its claims; a claim on that release refused with
 *   426; an audit whose own lease is revoked attaches nothing;
 * - a lease claimed on an older release that is not revoked completes after
 *   the pool moved on.
 *
 * The revoked list and the floor are the signed manifest's (hosts.ts
 * RELEASE_POLICY); these tests set their own on it, with releases (v3.x) no
 * other file uses, and put the manifest's back after each.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { toB64url } from "../src/webauthn";
import { enrollMessage, signedMessage, RELEASE_POLICY } from "../src/hosts";
import { REVOKED_REQUEUE_SQL } from "../src/lease";
import { LAST_GOOD_HOURS, UPDATE_GRACE_MINUTES } from "../src/update";

const ORIGIN = "http://localhost:8787";
const HOUR = 3600e3;
const STUDIO = { cpus: 12, mem_gb: 32, disk_free_gb: { work: 410, engine: 220 }, units: 11, job_reserved: 1, agent_slots: 2, lanes: [{ arch: "aarch64", mode: "native" }] };
const SIGNED = { min_release: RELEASE_POLICY.min_release, revoked: [...RELEASE_POLICY.revoked] };
/** The pool at v3.4.2, deployed an hour past the rollout's grace: one release behind is refused but for the exception. */
const released = () => ({ ...env, POOL_VERSION: "v3.4.2", POOL_DEPLOYED_AT: new Date(Date.now() - (UPDATE_GRACE_MINUTES + 60) * 60000).toISOString() }) as typeof env;

interface Res { status: number; json: any }
async function call(method: string, path: string, opts: { session?: string; token?: string; body?: unknown; raw?: string; octets?: string; headers?: Record<string, string>; on?: typeof env } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  let body: string | undefined = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.octets !== undefined) { body = opts.octets; headers["content-type"] = "application/octet-stream"; }
  if (opts.session) { headers.cookie = `omc=oms_${opts.session}`; headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  Object.assign(headers, opts.headers ?? {});
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body }), opts.on ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ---------- a host, as its agent and its dispatcher speak ----------

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
const report = (k: Key, host: string, r: unknown) => signed(k, host, "POST", "/hosts/self/report", JSON.stringify(r));

/** One maintainer host from nothing to active, with its worker token: enrolled by its agent, confirmed by its owner, its token fetched. */
async function enrolled(owner: string, name: string): Promise<{ k: Key; host: string; worker: string; token: string }> {
  const k = await newKey();
  const m = await call("POST", "/hosts/enrollments", { session: owner, body: { name } });
  expect(m.status, JSON.stringify(m.json)).toBe(201);
  const e = await call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(k, enrollMessage(m.json.token, k.pub)), hostname: "box-1", os: "linux", arch: "aarch64", page_kb: 16, isolation: "root", dedicated: true, agent_version: "0.4.0", capacity: STUDIO } });
  expect(e.status, JSON.stringify(e.json)).toBe(201);
  const c = await call("POST", `/hosts/${e.json.host}/confirm`, { session: owner, body: {} });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const t = await signed(k, e.json.host, "POST", "/hosts/self/token");
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  return { k, host: e.json.host, worker: c.json.worker, token: t.json.token };
}

/** A host's registration seeded straight into the tables, for the lease tests: its worker token omw_<id>. */
async function seedHost(id: string): Promise<void> {
  const hostId = `h_${id.replace(/[^0-9a-z]/g, "").padEnd(10, "0").slice(0, 10)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, arch, worker_id, confirmed_at) VALUES (?, 'm1', 1001, ?, ?, 'active', 'aarch64', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
      .bind(hostId, id, `key-${id}`, id),
    env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, kind, host_id) VALUES (?, 'aarch64', 'm1', ?, 'shared', 'project', 'm1', ?, 'host', ?)")
      .bind(id, await sha256Hex(`omw_${id}`), new Date().toISOString(), hostId),
  ]);
}
let seq = 0;
/** A claim as a host's dispatcher sends it (design v2 §8.1), on release `version`. */
const hostClaim = (token: string, version: string, o: { want?: 0 | 1; leases?: { task: number; gen: string }[]; kinds?: string[]; on?: typeof env } = {}) => call("POST", "/factory/claim", {
  token, on: o.on,
  body: {
    arch: "aarch64", version, hostname: "box", kinds: o.kinds ?? ["build", "trial", "audit"], claim_id: `c_lastgood${String(++seq).padStart(6, "0")}`, want: o.want ?? 1, leases: o.leases ?? [], capacity: STUDIO,
    agent: { provider: "anthropic", model: "claude-test", probe: "ok", checked_at: "2026-11-10T12:00:00Z" }, agent_via: "direct", orders: ["drain", "recheck-agent", "restart", "stop-task"], instance: hex(16),
  },
});
/** A task pinned to one registration, so no other test's host takes it. */
async function seedTask(t: { name: string; pin: string; kind?: string; trust?: "project" | "community"; params?: unknown; publish?: number; ref?: string }): Promise<number> {
  return (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, max_attempts, pinned_to) VALUES (?, 'aarch64', '1.2-1', ?, 'test', 100, 'queued', ?, ?, ?, ?, ?, 3, ?) RETURNING id`,
  ).bind(t.name, t.ref ?? `https://github.com/x/${t.name}@v1:PKGBUILD`, t.publish ?? 0, t.trust ?? "community", t.trust === "project" ? null : "bob", t.kind ?? "build", t.params === undefined ? null : JSON.stringify(t.params), t.pin)
    .first<{ id: number }>())!.id;
}
const taskOf = (id: number) => env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<any>();
const hostRow = (id: string) => env.DB.prepare("SELECT rolled_back_from, rolled_back_at, release_applied FROM hosts WHERE id = ?").bind(id).first<any>();
const warnings = (worker: string) => env.DB.prepare("SELECT summary, payload FROM events WHERE kind = 'worker' AND json_extract(payload, '$.worker') = ? ORDER BY id").bind(worker).all<{ summary: string; payload: string }>().then((r) => r.results);

beforeAll(async () => {
  const people: [string, string, number][] = [["m1", "maintainer", 1001], ["m2", "maintainer", 1002], ["bob", "contributor", 2001]];
  await env.DB.batch(await Promise.all(people.map(async ([l, role, g]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES (?, ?, ?, ?, ?)").bind(l, await sha256Hex(`omc_${l}`), await sha256Hex(`oms_${l}`), role, g))));
  await applyGovernance(env, ["m1", "m2"], "sha-last-good");
  await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('felix', 'bob', 'https://github.com/bob/felix', '["aarch64"]', 'building')`).run();
});

afterEach(async () => {
  vi.useRealTimers();
  Object.assign(RELEASE_POLICY, { min_release: SIGNED.min_release, revoked: [...SIGNED.revoked] });
  await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE status IN ('queued', 'leased')").run();
});

describe("the D1 migration (0048)", () => {
  it("adds when the pool first heard a host revert a release", async () => {
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('hosts')").all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["rolled_back_from", "rolled_back_at", "release_applied"]));
  });
});

describe("a host that reverted the pool's release", () => {
  it("is kept as reverting it while its reports hold it back, from the first report that said so; applying it forgets it", async () => {
    const h = await enrolled("m1", "revert-report");
    const r1 = await report(h.k, h.host, { agent: { version: "0.4.0" }, release: { applied: "v3.4.1", target: "v3.4.2" }, round: { at: "2026-11-10T13:00:00Z", outcome: "rolled-back", from: "v3.4.2", step: "guard", detail: "the dispatcher lost /ready (quarantined until 1700000000)" }, quarantine: [{ release: "v3.4.2", until: "2026-11-10T14:00:00Z" }] });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    const first = await hostRow(h.host);
    expect(first).toMatchObject({ rolled_back_from: "v3.4.2", release_applied: "v3.4.1" });
    expect(Date.parse(first.rolled_back_at)).toBeGreaterThan(Date.now() - 60000);
    // Its next rounds say `held` while the release waits in quarantine; its retry reverts again: the first time stays.
    await new Promise((r) => setTimeout(r, 20));
    for (const r of [
      { release: { applied: "v3.4.1" }, round: { outcome: "held", from: null }, quarantine: [{ release: "v3.4.2", until: null }] },
      { release: { applied: "v3.4.1" }, round: { outcome: "rolled-back", from: "v3.4.2" }, quarantine: [{ release: "v3.4.2", until: null }] },
    ]) {
      expect((await report(h.k, h.host, r)).status).toBe(200);
      expect(await hostRow(h.host)).toEqual(first);
    }
    // Its owner and the maintainers read it on the host page.
    const page = await call("GET", `/hosts/${h.host}`, { session: "m1" });
    expect(page.json.host).toMatchObject({ rolled_back_from: "v3.4.2", rolled_back_at: first.rolled_back_at });
    // Applied at last: forgotten.
    expect((await report(h.k, h.host, { release: { applied: "v3.4.2" }, round: { outcome: "ok" }, quarantine: [] })).status).toBe(200);
    expect(await hostRow(h.host)).toMatchObject({ rolled_back_from: null, rolled_back_at: null, release_applied: "v3.4.2" });
  });

  it("claims on its last-good past the grace for six hours with a warning on Status and its page, then is refused with 426; never below min_release, never on another release", async () => {
    const h = await enrolled("m1", "revert-claim");
    const on = released();
    const t = await seedTask({ name: "felix", pin: h.worker });
    // Without a revert, one release behind past the grace: 426.
    const before = await hostClaim(h.token, "v3.4.1", { on });
    expect(before.status, JSON.stringify(before.json)).toBe(426);
    // Its agent reverts v3.4.2 and runs its last-good, v3.4.1.
    expect((await report(h.k, h.host, { release: { applied: "v3.4.1", target: "v3.4.2" }, round: { outcome: "rolled-back", from: "v3.4.2" }, quarantine: [{ release: "v3.4.2", until: null }] })).status).toBe(200);
    const since = Date.parse((await hostRow(h.host)).rolled_back_at);
    const until = new Date(since + LAST_GOOD_HOURS * HOUR).toISOString();
    const c = await hostClaim(h.token, "v3.4.1", { on });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.task.id).toBe(t);
    expect(await taskOf(t)).toMatchObject({ status: "leased", release: "v3.4.1" });
    // Told once in the journal, as a warning, with until when.
    expect((await hostClaim(h.token, "v3.4.1", { on, leases: [{ task: t, gen: c.json.task.lease_gen }] })).status).toBe(204);
    const told = (await warnings(h.worker)).filter((w) => w.summary.includes("last-good"));
    expect(told.map((w) => w.summary)).toEqual([`${h.worker}: its agent reverted v3.4.2: claiming on last-good v3.4.1 until ${until}, then refused like any registration behind the pool's release`]);
    // Status reads it from the listing; the host page from the gate's own word.
    const listed = (await call("GET", "/factory?limit=10", { on })).json.workers.find((w: any) => w.id === h.worker);
    expect(listed.update).toMatchObject({ required: false, outdated: true, yours: "v3.4.1", latest: "v3.4.2", last_good_until: until });
    expect(listed).not.toHaveProperty("rolled_back_at");
    const mine = (await call("GET", "/users/m1", { session: "m1", on })).json.workers.find((w: any) => w.id === h.worker);
    expect(mine.update.last_good_until).toBe(until);
    const page = await call("GET", `/hosts/${h.host}`, { session: "m1", on });
    expect(page.json.host.last_good).toContain(`claiming on last-good v3.4.1 until ${until}`);
    // Its dispatcher on another release than the one its agent applied gets none.
    expect((await hostClaim(h.token, "v3.4.0", { on, want: 0 })).status).toBe(426);
    // Below the signed floor: none.
    RELEASE_POLICY.min_release = "v3.4.2";
    expect((await hostClaim(h.token, "v3.4.1", { on, want: 0 })).status).toBe(426);
    RELEASE_POLICY.min_release = SIGNED.min_release;
    expect((await hostClaim(h.token, "v3.4.1", { on, want: 0 })).status).toBe(204);
    // Six hours after the pool heard of the revert: 426, told once.
    const toldBefore = (await warnings(h.worker)).filter((w) => w.summary.includes("handed nothing")).length;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(since + LAST_GOOD_HOURS * HOUR + 1000);
    for (let i = 0; i < 2; i++) {
      const late = await hostClaim(h.token, "v3.4.1", { on, want: 0 });
      expect(late.status, JSON.stringify(late.json)).toBe(426);
      expect(late.json.error).toMatch(/^this worker runs v3\.4\.1; the pool is at v3\.4\.2 \(1 release behind\)/);
    }
    expect((await warnings(h.worker)).filter((w) => w.summary.includes("handed nothing")).length).toBe(toldBefore + 1);
    const after = (await call("GET", "/factory?limit=10", { on })).json.workers.find((w: any) => w.id === h.worker);
    expect(after.update).toMatchObject({ required: true });
    expect(after.update.last_good_until).toBeUndefined();
  });
});

describe("a lease claimed on a release that becomes revoked", () => {
  it("has its heartbeat, uploads and completion refused with stop; its host's report requeues it with the attempt back; a claim on that release is refused", async () => {
    await seedHost("h-revoke");
    const t = await seedTask({ name: "felix", pin: "h-revoke" });
    const c = await hostClaim("omw_h-revoke", "v3.3.7");
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.task.id).toBe(t);
    const job = c.json.token;
    expect((await call("PUT", `/factory/tasks/${t}/artifacts/build.log`, { token: job, octets: "==> building\n" })).status).toBe(201);
    expect((await call("POST", `/factory/tasks/${t}/heartbeat`, { token: job, body: {} })).status).toBe(200);
    // A later release revokes v3.3.7: what the lease sends is refused, each with `stop` — its host kills it.
    RELEASE_POLICY.revoked = ["v3.3.7"];
    for (const [method, path, opts] of [
      ["POST", `/factory/tasks/${t}/heartbeat`, { body: {} }],
      ["PUT", `/factory/tasks/${t}/artifacts/build.log`, { octets: "==> built\n" }],
      ["PUT", `/factory/tasks/${t}/artifacts/felix-1.2-1-aarch64.pkg.tar.zst`, { octets: "pkg" }],
      ["POST", `/factory/tasks/${t}/artifacts/felix-1.2-1-aarch64.pkg.tar.zst/multipart?action=create`, { body: {} }],
      ["POST", `/factory/tasks/${t}/complete`, { body: { sha256: "a".repeat(64), filename: "felix-1.2-1-aarch64.pkg.tar.zst", version: "1.2-1" } }],
    ] as const) {
      const r = await call(method, path, { token: job, ...opts });
      expect(r.status, `${method} ${path}`).toBe(409);
      expect(r.json, `${method} ${path}`).toMatchObject({ stop: true, state: "revoked" });
      expect(r.json.error).toMatch(/was leased on v3\.3\.7, which the pool's release test revokes: nothing of it is taken/);
    }
    expect(await taskOf(t)).toMatchObject({ status: "leased", attempts: 1 });
    // Its dispatcher kills it and reports it (as `lost`, which a pool from before #342 reads too): back in the queue, the attempt
    // given back, no host loss, nothing of it staged kept but its text evidence.
    const f = await call("POST", `/factory/tasks/${t}/fail`, { token: job, body: { error: "release v3.3.7 is revoked: its container was killed", revoked: true, lost: true, final: false } });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    expect(f.json).toMatchObject({ task: t, status: "queued", attempts: 0, revoked: "v3.3.7" });
    const row = await taskOf(t);
    expect(row).toMatchObject({ status: "queued", attempts: 0, host_losses: 0, lease_owner: null, lease_expires_at: null });
    expect(row.error).toMatch(/^leased on v3\.3\.7, which the pool's release test revokes: nothing it sent on that release is taken; the attempt is given back$/);
    expect((await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'felix'").first("status"))).toBe("waiting");
    const line = await env.DB.prepare("SELECT status, summary FROM events WHERE kind = 'build' AND json_extract(payload, '$.task') = ? ORDER BY id DESC LIMIT 1").bind(t).first<{ status: string; summary: string }>();
    expect(line).toMatchObject({ status: "warn" });
    expect(line!.summary).toMatch(/^felix for aarch64: leased on v3\.3\.7, .* — back in the queue$/);
    // A dispatcher still on the revoked release is handed nothing: 426, whatever the grace.
    const again = await hostClaim("omw_h-revoke", "v3.3.7");
    expect(again.status, JSON.stringify(again.json)).toBe(426);
    expect(again.json).toMatchObject({ revoked: true, yours: "v3.3.7" });
    expect(again.json.error).toMatch(/^this worker runs v3\.3\.7, a release the pool's release \(test\) revokes — it is handed nothing/);
    // On the release after it, the task is taken again — a new lease.
    const next = await hostClaim("omw_h-revoke", "v3.3.8");
    expect(next.json.task.id).toBe(t);
    expect(await taskOf(t)).toMatchObject({ status: "leased", release: "v3.3.8", attempts: 1 });
  });

  it("a project build's pool writes are refused; a lease its host drops from its claims goes back the same way, no host loss", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedHost("h-revoke-p");
    const t = await seedTask({ name: "felix", pin: "h-revoke-p", trust: "project", publish: 1 });
    const c = await hostClaim("omw_h-revoke-p", "v3.3.7");
    expect(c.json.task.id, JSON.stringify(c.json)).toBe(t);
    const poolPut = () => call("PUT", `/pool/${"b".repeat(64)}?filename=felix-1.2-1-aarch64.pkg.tar.zst`, { token: c.json.token, octets: "x" });
    expect((await poolPut()).json?.stop).toBeUndefined();
    RELEASE_POLICY.revoked = ["v3.3.7"];
    expect(await poolPut()).toMatchObject({ status: 409, json: { stop: true, state: "revoked" } });
    expect(await call("POST", "/releases", { token: c.json.token, body: { ring: "edge", packages: [] } })).toMatchObject({ status: 409, json: { stop: true, state: "revoked" } });
    // Its dispatcher killed it but its report did not land: two claims of the release after it do not list it.
    vi.setSystemTime(t0 + 3 * 60000);
    await hostClaim("omw_h-revoke-p", "v3.3.8", { want: 0 });
    vi.setSystemTime(t0 + 4 * 60000);
    await hostClaim("omw_h-revoke-p", "v3.3.8", { want: 0 });
    const row = await taskOf(t);
    expect(row).toMatchObject({ status: "queued", attempts: 0, host_losses: 0, lease_missed: 0 });
    expect(row.error).toMatch(/^leased on v3\.3\.7/);
  });

  it("an audit whose own lease is of the revoked release attaches nothing to the staged build", async () => {
    await seedHost("h-revoke-a");
    const built = await seedTask({ name: "felix", pin: "h-revoke-a" });
    await env.DB.prepare("UPDATE build_tasks SET status = 'staged', staged_prefix = 'staging/bob/felix/' || id || '/' WHERE id = ?").bind(built).run();
    const a = await seedTask({ name: "felix", pin: "h-revoke-a", kind: "audit", trust: "project", params: { task: built, name: "felix", owner: "bob", arch: "aarch64" }, ref: `staging:${built}` });
    const c = await hostClaim("omw_h-revoke-a", "v3.3.7", { kinds: ["audit"] });
    expect(c.json.task.id, JSON.stringify(c.json)).toBe(a);
    expect((await call("PUT", `/factory/tasks/${built}/artifacts/audit.md`, { token: c.json.token, octets: "# fine\n" })).status).toBe(201);
    RELEASE_POLICY.revoked = ["v3.3.7"];
    expect(await call("PUT", `/factory/tasks/${built}/artifacts/audit.json`, { token: c.json.token, octets: "{}" })).toMatchObject({ status: 409, json: { stop: true, state: "revoked" } });
  });

  it("a legacy registration's lease keeps its release too, and is refused the same way", async () => {
    await env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES ('legacy-r', 'aarch64', 'm1', ?, 'shared', 'project', 'm1', ?)").bind(await sha256Hex("omw_legacy-r"), new Date().toISOString()).run();
    const l = await seedTask({ name: "promote", pin: "legacy-r", kind: "promote", trust: "project", params: { from: "edge", to: "rc" } });
    const c = await call("POST", "/factory/claim", { token: "omw_legacy-r", body: { arch: "aarch64", version: "v3.3.7", kinds: ["promote"] } });
    expect(c.json.task.id, JSON.stringify(c.json)).toBe(l);
    expect(await taskOf(l)).toMatchObject({ release: "v3.3.7", lease_gen: null });
    RELEASE_POLICY.revoked = ["v3.3.7"];
    expect(await call("POST", `/factory/tasks/${l}/complete`, { token: c.json.token, body: { result: {}, summary: "done" } })).toMatchObject({ status: 409, json: { stop: true, state: "revoked" } });
    expect((await call("POST", `/factory/tasks/${l}/fail`, { token: c.json.token, body: { error: "stopped by the pool (revoked)" } })).json).toMatchObject({ status: "queued", revoked: "v3.3.7" });
    expect(await taskOf(l)).toMatchObject({ status: "queued", attempts: 0 });
    expect((await env.DB.prepare("SELECT current_task FROM build_workers WHERE id = 'legacy-r'").first("current_task"))).toBeNull();
  });

  it("the requeue reads the task by its primary key", async () => {
    const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${REVOKED_REQUEUE_SQL}`).bind("e", 1, "w", "g").all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    expect(plan).toMatch(/SEARCH build_tasks USING INTEGER PRIMARY KEY/);
  });
});

describe("a task started on an older release that is not revoked", () => {
  it("completes normally after a newer release lands, and its heartbeat and uploads are taken meanwhile", async () => {
    await seedHost("h-older");
    const t = await seedTask({ name: "felix", pin: "h-older" });
    const c = await hostClaim("omw_h-older", "v3.4.1", { on: { ...env, POOL_VERSION: "v3.4.1", POOL_DEPLOYED_AT: new Date().toISOString() } as typeof env });
    expect(c.json.task.id, JSON.stringify(c.json)).toBe(t);
    // v3.4.2 lands, and revokes another release; the dispatcher of v3.4.2 re-adopted the task, which finishes on v3.4.1.
    RELEASE_POLICY.revoked = ["v3.3.7"];
    const on = released();
    const job = c.json.token;
    expect((await call("POST", `/factory/tasks/${t}/heartbeat`, { token: job, body: {}, on })).status).toBe(200);
    for (const f of ["felix-1.2-1-aarch64.pkg.tar.zst", "PKGBUILD", "build.log"]) {
      expect((await call("PUT", `/factory/tasks/${t}/artifacts/${f}`, { token: job, octets: f === "build.log" ? "==> done\n" : "x", on })).status, f).toBe(201);
    }
    const done = await call("POST", `/factory/tasks/${t}/complete`, { token: job, body: { sha256: "c".repeat(64), filename: "felix-1.2-1-aarch64.pkg.tar.zst", version: "1.2-1" }, on });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(await taskOf(t)).toMatchObject({ status: "staged", release: "v3.4.1" });
  });
});
