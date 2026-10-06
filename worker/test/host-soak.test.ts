/**
 * The owner's soak and freeze detection (#326, epic #307, design v2 D16,
 * §5.5, §17.2, §18.1, §18.3), through the Worker with real Ed25519 host
 * keys:
 *
 * - The claim grace: a host whose agent reports `release.soaking_until` keeps
 *   its registration out of the 426 gate until the soak ends and the round's
 *   15 minutes after — two releases behind included —, never past two hours
 *   after the deploy, and not at all while it holds the pool's release in
 *   quarantine; the same registration with no soak is refused. The host page
 *   says where it stands at the gate, and why, to its owner and the
 *   maintainers; the listings agree.
 * - The report is read by the Worker's own JSON reader, never by SQL: one
 *   nested past SQLite's JSON depth stops nobody's claims nor the listings.
 * - Freeze detection: a report that says `pool_behind_github` puts the host
 *   on Status (GET /factory's `pool_behind_github`, while the report is
 *   fresh) and on its page — for anyone —, and on the journal once when it
 *   starts and once when it ends.
 * - The contract with the agent (crates/omarchy-agent/tests/fixtures/
 *   host-api/report-soak.json): the report with a soak and a freeze, posted
 *   as the agent posts it, reads back on the host page field by field.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { toB64url } from "../src/webauthn";
import { enrollMessage, poolBehindOf, reportedSoakOf, signedMessage, soakOf, SOAK_COLUMNS } from "../src/hosts";
import { POOL_BEHIND_SQL } from "../src/routes/factory";
import { SOAK_GRACE_MAX_MINUTES, SOAK_ROUND_MINUTES } from "../src/update";
import soakFixture from "../../crates/omarchy-agent/tests/fixtures/host-api/report-soak.json?raw";

const ORIGIN = "http://localhost:8787";
const MIN = 60000;
const STUDIO = { cpus: 12, mem_gb: 32, disk_free_gb: { work: 410, engine: 220 }, units: 11, job_reserved: 1, agent_slots: 2, lanes: [{ arch: "aarch64", mode: "native" }] };

interface Res { status: number; json: any }
async function call(method: string, path: string, opts: { session?: string; token?: string; body?: unknown; raw?: string; headers?: Record<string, string>; env?: typeof env } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.session) { headers.cookie = `omc=oms_${opts.session}`; headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  Object.assign(headers, opts.headers ?? {});
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body }), opts.env ?? env, ctx);
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
const report = (k: Key, host: string, r: unknown) => signed(k, host, "POST", "/hosts/self/report", typeof r === "string" ? r : JSON.stringify(r));

/** One maintainer host from nothing to active, with its worker token. */
async function activeHost(owner: string, name: string): Promise<{ k: Key; host: string; worker: string; token: string }> {
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

/** The pool at `version`, deployed `minutesAgo`. */
const deployed = (version: string, minutesAgo: number) => ({ ...env, POOL_VERSION: version, POOL_DEPLOYED_AT: new Date(Date.now() - minutesAgo * MIN).toISOString() }) as typeof env;
const isoIn = (minutes: number) => new Date(Date.now() + minutes * MIN).toISOString();

/** A claim of the host's registration, its dispatcher on `version`. */
let claims = 0;
const claim = (token: string, version: string, on: typeof env) => call("POST", "/factory/claim", { token, env: on, body: {
  arch: "aarch64", version, hostname: "box", kinds: ["build", "audit"], claim_id: `c_soak${String(++claims).padStart(6, "0")}`, want: 1, leases: [],
  capacity: STUDIO, agent: { provider: "anthropic", model: "m", probe: "ok", checked_at: new Date().toISOString() }, agent_via: "direct",
  orders: ["drain", "recheck-agent", "restart", "stop-task"], instance: hex(7),
} });
const seed = async (worker: string, name: string) => (await env.DB.prepare(
  "INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, pinned_to) VALUES (?, 'aarch64', '1-1', ?, 'test', 100, 'queued', 0, 'community', 'bob', 'build', ?) RETURNING id",
).bind(name, `https://github.com/x/${name}@v1:PKGBUILD`, worker).first<{ id: number }>())!.id;
const lines = (host: string) => env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'host' AND json_extract(payload, '$.action') = 'pool-behind-github' AND json_extract(payload, '$.host') = ? ORDER BY id").bind(host).all<{ status: string; summary: string; payload: string }>().then((r) => r.results);

beforeAll(async () => {
  const people: [string, string, number | null][] = [["m1", "maintainer", 1001], ["m2", "maintainer", 1002], ["alice", "contributor", 2001]];
  await env.DB.batch(await Promise.all(people.map(async ([l, role, g]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES (?, ?, ?, ?, ?)").bind(l, await sha256Hex(`omc_${l}`), await sha256Hex(`oms_${l}`), role, g))));
  await applyGovernance(env, ["m1", "m2"], "sha-soak");
});

describe("a soaking host's claim grace (POST /factory/claim, #326)", () => {
  it("is not refused with 426 during its soak, two releases behind, and is handed work; refused once the soak and its round's margin end", async () => {
    const { k, host, worker, token } = await activeHost("m1", "soaker");
    // The pool deployed v1.0.4 ten minutes ago; the host's dispatcher runs v1.0.2: two behind, refused at once without a soak.
    const pool = deployed("v1.0.4", 10);
    await report(k, host, { agent: { version: "0.4.0" }, release: { applied: "v1.0.2", target: "v1.0.4", soak_minutes: 30, soaking_until: null }, quarantine: [] });
    const refused = await claim(token, "v1.0.2", pool);
    expect(refused.status, JSON.stringify(refused.json)).toBe(426);
    expect(refused.json).toMatchObject({ yours: "v1.0.2", latest: "v1.0.4", behind: 2 });
    // Its agent soaks v1.0.4 for 30 minutes (two releases landed meanwhile): the registration claims, and is handed a build.
    await report(k, host, { agent: { version: "0.4.0" }, release: { applied: "v1.0.2", target: "v1.0.4", soak_minutes: 30, soaking_until: isoIn(20) }, quarantine: [] });
    const task = await seed(worker, "soaked-pkg");
    const c = await claim(token, "v1.0.2", pool);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.task.id).toBe(task);
    // The page says where it stands: claiming through its soak.
    const page = (await call("GET", `/hosts/${host}`, { session: "m1", env: pool })).json;
    expect(page.update).toMatchObject({ outdated: true, required: false, behind: 2, yours: "v1.0.2", latest: "v1.0.4" });
    expect(page.update.words).toContain("it claims through its owner's soak");
    expect(page.host.soak).toMatchObject({ minutes: 30 });
    // The listings (Status, the Workers page, its own page) say the same: behind, but not handed nothing.
    const listed = (await call("GET", "/factory?limit=13", { env: pool })).json.workers.find((w: { id: string }) => w.id === worker);
    expect(listed.update).toMatchObject({ outdated: true, required: false });
    // When the soak ends is its owner's and the maintainers' (the host page's), not the public listings'.
    expect(listed.update.soaking_until).toBeUndefined();
    expect(listed.quarantine).toBeUndefined();
    const own = (await call("GET", `/factory/workers/${worker}`, { env: pool })).json.worker.update;
    expect(own).toMatchObject({ required: false });
    expect(own.soaking_until).toBeUndefined();
    // The soak ended, its round running: the agent still says when, and the round's margin covers it...
    await report(k, host, { agent: { version: "0.4.0" }, release: { applied: "v1.0.2", target: "v1.0.4", soak_minutes: 30, soaking_until: isoIn(-(SOAK_ROUND_MINUTES - 2)) }, quarantine: [] });
    expect((await claim(token, "v1.0.2", pool)).status).not.toBe(426);
    // ... and no more: refused, and the page says why.
    await report(k, host, { agent: { version: "0.4.0" }, release: { applied: "v1.0.2", target: "v1.0.4", soak_minutes: 30, soaking_until: isoIn(-(SOAK_ROUND_MINUTES + 1)) }, quarantine: [] });
    expect((await claim(token, "v1.0.2", pool)).status).toBe(426);
    const after = (await call("GET", `/hosts/${host}`, { session: "m1", env: pool })).json;
    expect(after.update).toMatchObject({ required: true });
    expect(after.update.words).toMatch(/^refused with 426 — its registration runs v1\.0\.2, the pool v1\.0\.4 \(2 releases behind\): its soak ended at/);
  });

  it("never past two hours after the deploy, and none for a host that holds the pool's release in quarantine", async () => {
    const { k, host, token } = await activeHost("m1", "soaker-b");
    const soaking = (until: string, quarantine: string[] = []) => report(k, host, { agent: { version: "0.4.0" }, release: { applied: "v1.0.2", target: "v1.0.4", soak_minutes: 120, soaking_until: until }, quarantine: quarantine.map((r) => ({ release: r, until: null })) });
    // A soak that runs on: within two hours of the deploy it claims, past them it does not.
    await soaking(isoIn(60));
    expect((await claim(token, "v1.0.2", deployed("v1.0.4", SOAK_GRACE_MAX_MINUTES - 5))).status).not.toBe(426);
    expect((await claim(token, "v1.0.2", deployed("v1.0.4", SOAK_GRACE_MAX_MINUTES + 1))).status).toBe(426);
    const late = (await call("GET", `/hosts/${host}`, { session: "m1", env: deployed("v1.0.4", SOAK_GRACE_MAX_MINUTES + 1) })).json;
    expect(late.update.words).toContain("past the pool's grace for a soak, which ends 2 hours after the deploy");
    // It reverted the pool's release: its soak gives no grace (its claim on last-good is another rule's).
    await soaking(isoIn(20), ["v1.0.4"]);
    expect((await claim(token, "v1.0.2", deployed("v1.0.4", 10))).status).toBe(426);
    const held = (await call("GET", `/hosts/${host}`, { session: "m1", env: deployed("v1.0.4", 10) })).json;
    expect(held.update.words).toContain("it holds v1.0.4 in quarantine");
    // An older release in quarantine does not count, nor a later one the pool rolled back from: the host waits for v1.0.4 and soaks it.
    await soaking(isoIn(20), ["v1.0.3"]);
    expect((await claim(token, "v1.0.2", deployed("v1.0.4", 10))).status).not.toBe(426);
    await soaking(isoIn(20), ["v1.0.5"]);
    expect((await claim(token, "v1.0.2", deployed("v1.0.4", 10))).status).not.toBe(426);
    // Nor a quarantine of the pool's release that ended.
    await report(k, host, { agent: { version: "0.4.0" }, release: { applied: "v1.0.2", target: "v1.0.4", soak_minutes: 100, soaking_until: isoIn(20) }, quarantine: [{ release: "v1.0.4", until: isoIn(-1) }] });
    expect((await claim(token, "v1.0.2", deployed("v1.0.4", 10))).status).not.toBe(426);
  });

  it("reads the report with its own JSON reader: one nested past SQLite's JSON depth stops no claim and no listing", async () => {
    // SQLite refuses JSON nested deeper than 1000 levels, and fails the whole statement; V8 reads it. A report of 3 KiB holds 1500.
    const deep = await activeHost("m1", "deep-report");
    const healthy = await activeHost("m2", "healthy-host");
    const pool = deployed("v1.0.4", 10);
    const nested = `{"agent":{"version":"0.4.0"},"release":{"applied":"v1.0.2","target":"v1.0.4","soak_minutes":30,"soaking_until":"${isoIn(20)}","pool_behind_github":{"github":"v1.0.5","pool":"v1.0.4","since":"2027-01-14T08:00:56Z"}},"quarantine":[],"x":${"[".repeat(1500)}${"]".repeat(1500)}}`;
    const r = await report(deep.k, deep.host, nested);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // Its own claim reads its soak, and claims through it; another host's claim selects over the fleet with it in; the listings answer.
    const mine = await seed(deep.worker, "deep-pkg"), theirs = await seed(healthy.worker, "healthy-pkg");
    const c1 = await claim(deep.token, "v1.0.2", pool);
    expect(c1.status, JSON.stringify(c1.json)).toBe(200);
    expect(c1.json.task.id).toBe(mine);
    const c2 = await claim(healthy.token, "v1.0.4", pool);
    expect(c2.status, JSON.stringify(c2.json)).toBe(200);
    expect(c2.json.task.id).toBe(theirs);
    const f = await call("GET", "/factory?limit=14", { env: pool });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    expect(f.json.workers.find((w: { id: string }) => w.id === deep.worker).update).toMatchObject({ required: false });
    expect(f.json.pool_behind_github.some((b: { host: string }) => b.host === deep.host)).toBe(true);
    expect((await call("GET", `/factory/workers/${deep.worker}`, { env: pool })).status).toBe(200);
    expect((await call("GET", "/users/m1")).status).toBe(200);
    expect((await call("GET", `/hosts/${deep.host}`, { session: "m1", env: pool })).json.update).toMatchObject({ required: false });
  });

  it("reads the soak a report carries leniently: none, or one that is no time, is no soak", () => {
    expect(soakOf({ soaking_until: null, quarantine: "[]" })).toBeNull();
    expect(soakOf({ soaking_until: "soon", quarantine: "[]" })).toBeNull();
    expect(soakOf({ soaking_until: "2027-01-15T08:30:00Z", quarantine: '[{"release":"v1.0.4","until":null},{"release":"x"},{"release":"v1.0.3","until":"2027-01-16T08:00:00Z"},{"release":"v1.0.2","until":"later"}]' }))
      .toEqual({ until: "2027-01-15T08:30:00Z", quarantined: [{ release: "v1.0.4", until: null }, { release: "v1.0.3", until: "2027-01-16T08:00:00Z" }, { release: "v1.0.2", until: null }] });
    expect(soakOf({ soaking_until: "2027-01-15T08:30:00Z", quarantine: "{" })).toEqual({ until: "2027-01-15T08:30:00Z", quarantined: [] });
    // The report's quarantine as it comes (an array), as the report's handler reads it.
    expect(soakOf({ soaking_until: "2027-01-15T08:30:00Z", quarantine: [{ release: "v1.0.4", until: null }, null, 7] })).toEqual({ until: "2027-01-15T08:30:00Z", quarantined: [{ release: "v1.0.4", until: null }] });
    expect(reportedSoakOf(JSON.stringify({ release: { soak_minutes: -1, soaking_until: 3, github_latest: "latest" } }))).toBeNull();
    expect(poolBehindOf({ github: "v1.2.0", pool: "dev", since: "2027-01-15T08:00:00Z" })).toBeNull();
    expect(poolBehindOf('{"github":"v1.2.0","pool":"v1.1.0","since":"2027-01-15T08:00:00Z"}')).toEqual({ github: "v1.2.0", pool: "v1.1.0", since: "2027-01-15T08:00:00Z" });
    expect(poolBehindOf("{")).toBeNull();
  });
});

describe("freeze detection on the host page, Status and the journal (#326)", () => {
  it("a report saying pool_behind_github: on its page for anyone, on Status while fresh, on the journal when it starts and ends", async () => {
    const { k, host } = await activeHost("m2", "frozen");
    const behind = { github: "v1.2.0", pool: "v1.1.0", since: "2027-01-14T08:00:56Z" };
    const r = await report(k, host, { agent: { version: "0.4.0" }, release: { applied: "v1.1.0", target: "v1.1.0", github_latest: "v1.2.0", pool_behind_github: behind } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // Anyone sees it on the host's page: it is about the pool.
    expect((await call("GET", `/hosts/${host}`)).json.host.pool_behind_github).toEqual(behind);
    expect((await call("GET", `/hosts/${host}`, { session: "alice" })).json.host.pool_behind_github).toEqual(behind);
    // Status reads it from GET /factory.
    const f = (await call("GET", "/factory?limit=10")).json;
    expect(f.pool_behind_github).toEqual(expect.arrayContaining([{ host, name: "frozen", owner: "m2", ...behind }]));
    // The journal says it once, however many reports carry it.
    await report(k, host, { agent: { version: "0.4.0" }, release: { applied: "v1.1.0", target: "v1.1.0", github_latest: "v1.2.0", pool_behind_github: behind } });
    let l = await lines(host);
    expect(l.map((x) => x.status)).toEqual(["warn"]);
    expect(l[0].summary).toContain("frozen of m2: its agent reports the pool behind GitHub — GitHub's latest release has been v1.2.0 for more than a day");
    // A stale report is no longer Status's.
    await env.DB.prepare("UPDATE hosts SET reported_at = ? WHERE id = ?").bind(new Date(Date.now() - 60 * MIN).toISOString(), host).run();
    // (Another limit: the listing's edge copy lives ten seconds.)
    expect((await call("GET", "/factory?limit=11")).json.pool_behind_github.some((b: { host: string }) => b.host === host)).toBe(false);
    // The pool names GitHub's latest again: over, said once.
    await report(k, host, { agent: { version: "0.4.0" }, release: { applied: "v1.2.0", target: "v1.2.0", github_latest: "v1.2.0", pool_behind_github: null } });
    l = await lines(host);
    expect(l.map((x) => x.status)).toEqual(["warn", "ok"]);
    expect((await call("GET", `/hosts/${host}`)).json.host.pool_behind_github).toBeNull();
    expect((await call("GET", "/factory?limit=12")).json.pool_behind_github.some((b: { host: string }) => b.host === host)).toBe(false);
  });

  it("Status's read is one small statement over the hosts", async () => {
    // The hosts are a handful of maintainers' machines: a scan of them, nothing else.
    const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${POOL_BEHIND_SQL}`).bind(new Date().toISOString()).all<{ detail: string }>()).results.map((r) => r.detail).join("\n");
    expect(plan).toMatch(/hosts/);
    expect(plan).not.toMatch(/build_tasks|build_workers|events/);
  });
});

describe("the contract with the agent (report-soak.json)", () => {
  it("the report with a soak and a freeze, posted as the agent posts it, reads back on the host page field by field", async () => {
    const { k, host } = await activeHost("m1", "contract-soak");
    const fixture = JSON.parse(soakFixture);
    const r = await report(k, host, soakFixture);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const page = (await call("GET", `/hosts/${host}`, { session: "m1" })).json;
    expect(page.host.soak).toEqual({ minutes: fixture.release.soak_minutes, until: fixture.release.soaking_until, github_latest: fixture.release.github_latest });
    expect(page.host.pool_behind_github).toEqual(fixture.release.pool_behind_github);
    expect(page.host.release_target).toBe(fixture.release.target);
    expect(page.host.round).toMatchObject({ outcome: "held" });
    // The soak the claim reads (its columns, which the report's handler fills) is the report's.
    const row = await env.DB.prepare(`SELECT ${SOAK_COLUMNS("hosts")} FROM hosts WHERE id = ?`).bind(host).first<{ soaking_until: unknown; quarantine: unknown }>();
    expect(soakOf(row)).toEqual({ until: fixture.release.soaking_until, quarantined: [] });
    // A contributor and anyone see the freeze (it is about the pool), not the soak nor where it stands at the gate: those tell the
    // releases it holds in quarantine and its owner's soak.
    for (const session of ["alice", undefined]) {
      const pub = (await call("GET", `/hosts/${host}`, { session })).json;
      expect(pub.host.soak).toBeUndefined();
      expect(pub.update).toBeUndefined();
      expect(pub.host.pool_behind_github).toEqual(fixture.release.pool_behind_github);
    }
  });
});
