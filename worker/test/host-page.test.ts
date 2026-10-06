/**
 * The host page (#324, design v2 §18.1), inside workerd with a real D1: two
 * maintainer hosts enrolled, confirmed and claiming as their agents and
 * dispatchers do, each reporting a recorded report in the agent's own shape
 * (crates/omarchy-agent run/report.rs; every key of its contract fixture) —
 * the Studio canary's (aarch64, rootful docker, an emulated x86_64 lane, its
 * legacy set) and the P1 host's (x86_64, rootless podman, a lane held for
 * binfmt, limits not enforced, a round the docker group stopped, and what its
 * agent says of itself from 0.5.0, run/needs.rs: linger off, a credential
 * within its user's reach) —:
 *
 * - its owner and the maintainers see everything §18.1 lists from that
 *   report: the runtime, the isolation level and `dedicated`, the agent's and
 *   compose's versions; CPUs, memory, both free disks, the units busy and
 *   free and the reserved job unit, the agent slots, the owner's caps, the
 *   pool's cap, the lanes with `via` and 16K pages or held with why,
 *   `reserving`; each lease with its kind, package, arch, lane, units, since
 *   when and a Stop; applied, target and floor, the rollout's state, the
 *   last round; the "needs a person" box; the legacy set; and a visitor only
 *   the public fields — the page drawn from the same reads says the same;
 * - the pool's cap lowers what the pool hands out and touches nothing of the
 *   envelope (no host order, no setting), and is refused above its units;
 * - a Stop on one lease fences that task only; Drain and Resume keep the
 *   owner rule; Reconcile now is an Update while its agent takes no host order;
 * - D1 is written only on a change, or when the row is five minutes old;
 * - the page's layout at 1280, its colours the themes' tokens, its controls named.
 *
 * Tokens: workers' host tokens as the agent fetches them, sessions oms_<login>.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { toB64url } from "../src/webauthn";
import { enrollMessage, signedMessage, HOST_ROW_TOUCH_MIN, PINNED_TOOLS } from "../src/hosts";
import { handleFleet } from "../src/routes/hosts";
import { declared, runScript, scriptOf } from "./fixture";
// The agent's own report, as its tests hold it (crates/omarchy-agent run/orders_tests.rs: the reports keep the shape the pool reads).
import settingsFixture from "../../crates/omarchy-agent/tests/fixtures/host-api/report-settings.json?raw";

const ORIGIN = "http://pool.test";
const MIN = 60000;
const iso = (ms: number) => new Date(ms).toISOString();

interface Res { status: number; json: any }
interface Opts { session?: string; token?: string; body?: unknown; raw?: string; headers?: Record<string, string>; on?: typeof env }
async function call(method: string, path: string, o: Opts = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  if (o.session) { headers.cookie = `omc=oms_${o.session}`; headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body }), o.on ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function served(path: string): Promise<string> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res.text();
}

// ---------- the host's key and its signed calls, as the agent makes them ----------

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

// ---------- the recorded reports (run/report.rs, agent 0.4.0) ----------

const STUDIO_LANES = [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated", via: "qemu", page16k: true }];
/** A stock host's owner control (#328): no passkey pinned yet, its seal key, the envelope's own keys. */
const OWNER = (key: string) => ({
  agent_keys: [], passkey: null, version: 0, seal: { fingerprint: `SHA256:${key.slice(0, 43)}`, key },
  envelope: { agent_budget: null, agent_slots: null, diagnostics: null, emulate: null, max_cpus: null, max_mem_gb: null, max_units: null, paths: null },
});
/** The Studio canary's report: aarch64, 12 cores, 32 GB, rootful docker without remapping beside its legacy set, an emulated x86_64 lane. */
const STUDIO_REPORT = {
  agent: { version: "0.4.0", skip: null },
  release: { applied: "v1.20.0", target: "v1.20.0", floor: "v1.18.0", min_release: "v1.0.0", soak_minutes: 0, soaking_until: null, github_latest: "v1.20.0", pool_behind_github: null },
  rollout: { state: "idle", since: "2026-10-06T08:00:00Z", target: null },
  round: { at: "2026-10-06T08:00:00Z", outcome: "ok", from: "v1.19.2", step: "guard", detail: "v1.20.0 applied: its guard passed" },
  quarantine: [],
  orders: [],
  legacy: { project: "omarchy-pool", state: "running", since: "2026-09-30T10:00:00Z", containers: 3, running: 3, dir: "/srv/omarchy-pool", blocked: null },
  settings: { units: null, emulate: null, envelope: { max_units: 11, detected_units: 11, emulate: null, detected_lanes: ["x86_64"], diagnostics: false }, effective: { units: 11, emulated: ["x86_64"] }, above: [] },
  brake: { orders_hour: 0, restarts_hour: 1, narrowings_hour: 0, release_change_at: null },
  capacity: {
    schema: 2, at: "2026-10-06T08:00:00Z", cpus: 12, mem_gb: 32, page_kb: 16, disk_free_gb: { work: 410, engine: 220 }, units: 11, job_reserved: 1, agent_slots: 2,
    lanes: STUDIO_LANES, held_lanes: [], isolation: "root", dedicated: true, limits: { cpus_hard: true, memory_hard: true, pids: true }, below_minimum: false,
  },
  runtime: { driver: "compose/docker", switch: null, switch_last: null },
  owner: OWNER("kPbAQFkDOpRmd5cGfSxEvMCe1dsUZErtLxUWtV_s5W0"),
  asleep: false,
  // Its agent sees nothing a person must fix of itself (linger on, no credential within its user's reach).
  needs_person: [],
};
/** The P1 host's report: an x86_64 VPS, rootless podman at the subuid level, the aarch64 lane held for binfmt, --pids-limit ignored, a round the docker group stopped. */
const P1_REPORT = {
  agent: { version: "0.4.0", skip: null },
  release: { applied: "v1.19.2", target: "v1.20.0", floor: "v1.18.0", min_release: "v1.0.0", soak_minutes: 0, soaking_until: null, github_latest: "v1.20.0", pool_behind_github: null },
  rollout: { state: "pulling", since: "2026-10-06T08:10:00Z", target: "v1.20.0" },
  round: { at: "2026-10-06T08:10:00Z", outcome: "pull-failed", from: null, step: "pull", detail: "needs a person: pull: the engine's socket refuses this user (EACCES); log out and back in, or reboot, so the docker group applies (permission denied)" },
  quarantine: [],
  orders: [],
  legacy: null,
  settings: { units: 6, emulate: null, envelope: { max_units: 7, detected_units: 7, emulate: null, detected_lanes: [], diagnostics: true }, effective: { units: 6, emulated: [] }, above: [] },
  brake: { orders_hour: 1, restarts_hour: 0, narrowings_hour: 1, release_change_at: null },
  capacity: {
    schema: 2, at: "2026-10-06T08:10:00Z", cpus: 8, mem_gb: 16, page_kb: 4, disk_free_gb: { work: 120, engine: 80 }, units: 6, job_reserved: 1, agent_slots: 1,
    lanes: [{ arch: "x86_64", mode: "native" }], held_lanes: [{ arch: "aarch64", reason: "needs a person: prep-root.sh installs qemu-user-static-binfmt (no qemu-aarch64 handler in /proc/sys/fs/binfmt_misc)" }],
    isolation: "subuid", dedicated: true, limits: { cpus_hard: true, memory_hard: true, pids: false }, below_minimum: false,
  },
  runtime: { driver: "compose/podman", switch: null, switch_last: null },
  owner: OWNER("Fq8MHTVhn3EHJ0P5yCbvJWAjm8ZLy9fKDn0z1cFgDXk"),
  asleep: false,
  // What only the agent sees of itself (run/needs.rs, looked at hourly): the contract's linger, and a credential in its words.
  needs_person: [
    ...(JSON.parse(settingsFixture).needs_person as { what: string; detail: string }[]),
    { what: "credentials", detail: "credentials within the agent's reach, move them off this user: a gh login: /home/omarchy/.config/gh/hosts.yml" },
  ],
};

// ---------- hosts, from Add a host to claiming ----------

interface Host { k: Key; host: string; worker: string; token: string }
let names = 0;
async function activeHost(owner: string, arch: "aarch64" | "x86_64", capacity: unknown, o: Record<string, unknown> = {}): Promise<Host> {
  const m = await call("POST", "/hosts/enrollments", { session: owner, body: { name: `box-${++names}` } });
  expect(m.status, JSON.stringify(m.json)).toBe(201);
  const k = await newKey();
  const e = await call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(k, enrollMessage(m.json.token, k.pub)), hostname: `box-${names}`, os: "linux", arch, page_kb: arch === "aarch64" ? 16 : 4, isolation: "root", dedicated: true, agent_version: "0.4.0", runtime: { driver: "compose/docker", rootless: false }, capacity, ...o } });
  expect(e.status, JSON.stringify(e.json)).toBe(201);
  const c = await call("POST", `/hosts/${e.json.host}/confirm`, { session: owner, body: {} });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const t = await signed(k, e.json.host, "POST", "/hosts/self/token");
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  return { k, host: e.json.host, worker: c.json.worker, token: t.json.token };
}

let seq = 0;
/** A claim as the host's dispatcher sends it (design v2 §8.1). */
const claim = (h: Host, arch: string, capacity: unknown, leases: { task: number; gen: string }[] = []) => call("POST", "/factory/claim", { token: h.token, body: {
  arch, version: "v1.20.0", hostname: h.worker, kinds: ["build", "trial", "audit"], claim_id: `c_hp${String(++seq).padStart(8, "0")}`, want: 1, leases, capacity,
  agent: { provider: "anthropic", model: "claude-test", probe: "ok", checked_at: "2026-10-01T00:00:00Z" },
} });
/** A queued build of `arch`. */
async function queued(arch: string, name = `pkg${++seq}`): Promise<number> {
  return (await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind) VALUES (?, ?, '1.0-1', ?, 'test', 100, 'queued', 0, 'project', NULL, 'build') RETURNING id")
    .bind(name, arch, `https://github.com/x/${name}@v1:PKGBUILD`).first<{ id: number }>())!.id;
}
const taskOf = (id: number) => env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<any>();
const hostRow = (id: string) => env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<any>();
/** The pool running the release the Studio applied: its pinned tools are the host's. */
const onRelease = (v: string) => ({ ...env, POOL_VERSION: v, POOL_DEPLOYED_AT: iso(Date.now() - 3 * 60 * MIN) }) as typeof env;

/** The page as a browser draws it for `login` (none: a visitor), from the same reads, once its facts are drawn. */
async function drawn(host: string, login?: string) {
  const html = await served(`/hosts/${host}`);
  const fetch = (path: string, init?: RequestInit) => {
    const ctx = createExecutionContext();
    const headers = { ...(init?.headers as Record<string, string> | undefined), ...(login ? { cookie: `omc=oms_${login}` } : {}) };
    return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), onRelease("v1.20.0"), ctx).then(async (r) => { await waitOnExecutionContext(ctx); return r; });
  };
  const d = runScript(scriptOf(html), { pathname: `/hosts/${host}`, functions: [], fetch });
  for (let i = 0; i < 100 && !/<dt>/.test(d.nodes["#hp-kv"]?.innerHTML ?? ""); i++) await new Promise((r) => setTimeout(r, 30));
  return d;
}

let studio: Host, p1: Host;
const leases: { task: number; gen: string }[] = [];
/** Each lease's job token, as the claim handed it to the dispatcher: what its heartbeat carries. */
const jobTokens = new Map<number, string>();

beforeAll(async () => {
  const h = sha256Hex;
  await env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES
      ('m1', ?, ?, 'maintainer', 1001), ('m2', ?, ?, 'maintainer', 1002), ('bob', ?, ?, 'contributor', 2001)`)
    .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_bob"), await h("oms_bob")).run();
  await applyGovernance(env, ["m1", "m2"], "sha-start");
  studio = await activeHost("m1", "aarch64", STUDIO_REPORT.capacity);
  p1 = await activeHost("m2", "x86_64", P1_REPORT.capacity, { isolation: "subuid" });
  expect((await report(studio.k, studio.host, STUDIO_REPORT)).json).toMatchObject({ ok: true, written: true });
  expect((await report(p1.k, p1.host, P1_REPORT)).json).toMatchObject({ ok: true, written: true });
  // Two builds on the Studio's native lane: two leases, two units each.
  for (const name of ["zlib", "xz"]) await queued("aarch64", name);
  for (let i = 0; i < 2; i++) {
    const c = await claim(studio, "aarch64", STUDIO_REPORT.capacity, leases);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    leases.push({ task: c.json.task.id, gen: c.json.task.lease_gen });
    jobTokens.set(c.json.task.id, c.json.token);
  }
});

/** What anyone sees of a host (design v2 §18.1): its name, its architectures, its release and whether it is alive — with whose it is and who stopped it, as the journal says. */
const PUBLIC = ["alive", "arches", "asleep", "asleep_since", "claims_stopped_at", "confirmed_at", "enrolled_at", "id", "name", "owner", "pool_behind_github", "release_applied", "silent", "status", "status_at", "status_by", "status_reason", "worker"];

describe("the host page's read (#324, design v2 §18.1)", () => {
  it("is drawn from reports in the agent's own shape: every key of its contract fixture, nested", () => {
    const keys = (o: Record<string, unknown>, at = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? [at + k, ...keys(v as Record<string, unknown>, `${at}${k}.`)] : [at + k]));
    const contract = keys(JSON.parse(settingsFixture));
    expect(contract).toEqual(expect.arrayContaining(["release.floor", "rollout.state", "round.outcome", "capacity.held_lanes", "capacity.job_reserved", "capacity.limits.pids", "runtime.driver", "settings.envelope.max_units", "needs_person"]));
    for (const r of [STUDIO_REPORT, P1_REPORT]) expect(keys(r)).toEqual(expect.arrayContaining(contract));
  });

  it("gives its owner and the maintainers everything the recorded report says, and a visitor only the public fields", async () => {
    const page = await call("GET", `/hosts/${studio.host}`, { session: "m1", on: onRelease("v1.20.0") });
    expect(page.status).toBe(200);
    const h = page.json.host;
    // The runtime, the isolation level and dedicated, the agent's and compose's versions (the ones the release it applied pins).
    expect(h).toMatchObject({ isolation: "root", dedicated: true, agent_version: "0.4.0", runtime: { driver: "compose/docker" } });
    expect(h.tools).toEqual({ compose: PINNED_TOOLS["aarch64-linux"].compose, docker: PINNED_TOOLS["aarch64-linux"].docker, engine: null, pinned: true });
    expect(h.tools.compose).toMatch(/^\d+\.\d+\.\d+$/);
    // The capacity: CPUs, memory, both free disks, the units — busy on its two leases, free for a task, the one kept for pool jobs —, the agent slots, the owner's caps, the pool's cap.
    expect(h.capacity).toMatchObject({ cpus: 12, mem_gb: 32, disk_free_gb: { work: 410, engine: 220 } });
    expect(h).toMatchObject({ units: 11, units_effective: 11, units_busy: 4, units_free: 6, job_reserved: 1, tasks: 2, agent_slots: 2, pool_cap_units: null, state: "claiming" });
    expect(h.owner_caps).toEqual({ max_units: 11, detected_units: 11, emulate: null });
    // The lanes, emulated with how and 16K pages; none held; the limits enforced; reserving for nothing.
    expect(h.lanes).toEqual(STUDIO_LANES);
    expect(h.held_lanes).toEqual([]);
    expect(h.limits).toEqual({ cpus_hard: true, memory_hard: true, pids: true });
    expect(h.reserving_task).toBeNull();
    // Applied, target and floor; the rollout's state; the last round.
    expect(h).toMatchObject({ release_applied: "v1.20.0", release_target: "v1.20.0", release_floor: "v1.18.0", rollout: { state: "idle", since: "2026-10-06T08:00:00Z", target: null } });
    expect(h.round).toMatchObject({ outcome: "ok", from: "v1.19.2", step: "guard" });
    // The box: the hosting requirement its isolation level does not meet as a new host would (the Studio's recorded exception).
    expect(h.needs_person.map((n: { what: string }) => n.what)).toEqual(["hosting"]);
    expect(h.needs_person[0].text).toContain("the Studio's recorded exception until P6");
    // The recorded legacy project and its state.
    expect(h.legacy).toMatchObject({ project: "omarchy-pool", state: "running", running: 3 });
    // Its leases: kind, package, arch, lane, units, since when, and a Stop its owner may press.
    expect(page.json.leases).toHaveLength(2);
    for (const l of page.json.leases) {
      expect(l).toMatchObject({ kind: "build", arch: "aarch64", lane: "native", units: 2, fenced: false, stop: { ok: true } });
      expect(["zlib", "xz"]).toContain(l.name);
      expect(Date.parse(l.started_at)).toBeGreaterThan(Date.now() - 10 * MIN);
    }
    // Its registration's Drain, as the worker orders' door answers its owner; Reconcile now, a host order (its agent takes them).
    expect(page.json.registration).toMatchObject({ id: studio.worker, drained: null, can: { drain: true, resume: false } });
    expect(page.json.can).toMatchObject({ reconcile: true, reconcile_via: "order", cap: true, suspend: true });
    // Another maintainer sees the same details.
    const m2 = await call("GET", `/hosts/${studio.host}`, { session: "m2" });
    expect(m2.json.host).toMatchObject({ units_busy: 4, isolation: "root" });
    expect(m2.json.leases).toHaveLength(2);
    // Anyone else: the public fields only — no capacity, no lease, no box, no registration's controls.
    for (const who of [undefined, "bob"]) {
      const v = await call("GET", `/hosts/${studio.host}`, { session: who });
      expect(Object.keys(v.json.host).sort(), String(who)).toEqual(PUBLIC);
      expect(v.json.host).toMatchObject({ name: expect.stringMatching(/^box-\d+$/), arches: ["aarch64", "x86_64"], release_applied: "v1.20.0", alive: true, silent: false });
      expect(v.json.leases, String(who)).toBeUndefined();
      expect(v.json.orders).toBeUndefined();
      expect(v.json.update).toBeUndefined();
      expect(v.json.registration).toBeNull();
    }
  });

  it("names on the P1 host what needs a person: the lane held for binfmt, the limits not enforced, the docker group, what its agent says (linger, credentials)", async () => {
    const h = (await call("GET", `/hosts/${p1.host}`, { session: "m2" })).json.host;
    expect(h).toMatchObject({ isolation: "subuid", runtime: { driver: "compose/podman" }, release_applied: "v1.19.2", release_target: "v1.20.0", rollout: { state: "pulling", target: "v1.20.0" } });
    // The pool runs no release here ("test"): the versions are its report's, which names none.
    expect(h.tools).toEqual({ compose: null, docker: null, engine: null, pinned: false });
    expect(h.held_lanes).toEqual([{ arch: "aarch64", reason: P1_REPORT.capacity.held_lanes[0].reason }]);
    expect(h.owner_caps).toEqual({ max_units: 7, detected_units: 7, emulate: null });
    const box = Object.fromEntries(h.needs_person.map((n: { what: string; text: string }) => [n.what, n.text]));
    expect(Object.keys(box).sort()).toEqual(["binfmt", "cgroups", "credentials", "docker-group", "linger"]);
    expect(box.binfmt).toContain("its aarch64 lane is held — needs a person: prep-root.sh installs qemu-user-static-binfmt");
    expect(box.cgroups).toBe("limits cannot be enforced: its runtime ignores --pids-limit — a rootless runtime needs systemd to delegate cpu, memory and pids to the agent's user (cgroup v2)");
    expect(box["docker-group"]).toContain("log out and back in, or reboot, so the docker group applies");
    expect(box.linger).toBe(JSON.parse(settingsFixture).needs_person[0].detail);
    expect(box.linger).toContain("sudo loginctl enable-linger omarchy");
    expect(box.credentials).toBe("credentials within the agent's reach, move them off this user: a gh login: /home/omarchy/.config/gh/hosts.yml");
    // The agent's words are its owner's and the maintainers': Status's public lines carry none of them.
    const fleet = (await call("GET", "/hosts/fleet")).json;
    expect(JSON.stringify(fleet)).not.toMatch(/loginctl|hosts\.yml|binfmt_misc/);
  });

  it("says pending-owner and suspended in the box, and a disk below the floor and below the minimum", async () => {
    const m = await call("POST", "/hosts/enrollments", { session: "m1", body: { name: "waiting" } });
    const k = await newKey();
    const small = { ...STUDIO_REPORT.capacity, disk_free_gb: { work: 8, engine: 30 } };
    const e = await call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(k, enrollMessage(m.json.token, k.pub)), hostname: "waiting-1", os: "linux", arch: "aarch64", page_kb: 16, isolation: "subuid", dedicated: true, agent_version: "0.4.0", capacity: STUDIO_REPORT.capacity } });
    expect(e.status).toBe(201);
    let h = (await call("GET", `/hosts/${e.json.host}`, { session: "m1" })).json.host;
    expect(h.needs_person).toEqual([{ what: "pending-owner", text: "it waits for m1 to compare its fingerprint and press Confirm, on their page: nothing claims before that" }]);
    await call("POST", `/hosts/${e.json.host}/confirm`, { session: "m1", body: {} });
    expect((await report(k, e.json.host, { ...STUDIO_REPORT, legacy: null, capacity: { ...small, isolation: "subuid" } })).json.written).toBe(true);
    expect((await call("POST", `/hosts/${e.json.host}/suspend`, { session: "m2", body: { reason: "its disk is full" } })).status).toBe(200);
    h = (await call("GET", `/hosts/${e.json.host}`, { session: "m1" })).json.host;
    expect(h.needs_person.map((n: { what: string }) => n.what)).toEqual(["suspended", "below-minimum", "disk-low"]);
    expect(h.needs_person[0].text).toBe("suspended by m2: its disk is full — only m1 resumes it, with a passkey");
    expect(h.needs_person[2].text).toContain("8 GB free on the work root and 30 on the engine's data root, below the 10 GB floor");
  });
});

describe("the host page's controls (#324)", () => {
  it("draws what the read says: the runtime, the versions, the units, the lanes, the rollout, a Stop per lease, the box — and a visitor's rows", async () => {
    const draw = (login?: string) => drawn(studio.host, login);
    const m1 = await draw("m1");
    const kv = m1.nodes["#hp-kv"].innerHTML as string;
    for (const s of ["<dt>Runtime</dt><dd>compose on docker", "<dt>Isolation</dt><dd>root (dedicated)", `agent 0.4.0 · compose ${PINNED_TOOLS["aarch64-linux"].compose} · docker CLI ${PINNED_TOOLS["aarch64-linux"].docker}`, "11 the pool counts — 4 busy on 2 tasks, 6 free for a task, 1 kept for pool jobs", "x86_64 emulated (qemu, 16K pages)", "<dt>Owner's caps</dt><dd>11 units of the 11 detected · 2 agent slots", "--cpus, --memory and --pids-limit enforced", "floor v1.18.0", "<dt>Rollout</dt><dd>idle"]) expect(kv).toContain(s);
    const rows = m1.nodes["#hp-lease-rows"].innerHTML as string;
    expect(rows.match(/data-stop="\d+"/g)).toHaveLength(2);
    expect(rows).not.toContain("aria-disabled");
    expect(m1.nodes["#hp-needs"].hidden).toBe(false);
    expect(m1.nodes["#hp-needs-list"].innerHTML).toContain("<li><b>hosting</b>isolation root");
    expect(m1.nodes["#hp-stats"].innerHTML).toContain("4 / 11");
    // Its registration's Drain, live for its owner; Resume claims greyed with the door's words.
    const ops = m1.nodes["#hp-ops"].innerHTML as string;
    expect(ops).toMatch(/data-host-act="drain">/);
    expect(ops).toContain('data-host-act="undrain" disabled aria-disabled="true" title="it is not drained: there is nothing to resume"');
    // A visitor: the name, the arches, the release and whether it is alive; the details are said to be its owner's and the maintainers'.
    const nobody = await draw();
    const pub = nobody.nodes["#hp-kv"].innerHTML as string;
    expect(pub).toContain("<dt>Release</dt><dd>v1.20.0</dd><dt>Alive</dt><dd>its agent reports</dd><dt>Details</dt>");
    expect(nobody.nodes["#hp-lease-rows"].innerHTML).toContain("its owner's and the maintainers' — the Workers page says how many tasks it runs");
    expect(nobody.nodes["#hp-needs"].hidden).toBe(true);
    expect(nobody.nodes["#hp-ops"].innerHTML).toContain('data-host-act="drain" disabled aria-disabled="true" title="sign in with GitHub"');
  });

  it("a Stop on one lease fences that task only; the other runs on, its Stop still live", async () => {
    const [a, b] = leases;
    // Not a stranger's: the worker orders' door, its owner or a maintainer.
    expect((await call("POST", `/factory/workers/${studio.worker}/orders`, { session: "bob", body: { kind: "stop-task", task: a.task } })).status).toBe(403);
    const stop = await call("POST", `/factory/workers/${studio.worker}/orders`, { session: "m1", body: { kind: "stop-task", task: a.task, reason: "a wrong recipe" } });
    expect(stop.status, JSON.stringify(stop.json)).toBe(201);
    expect((await taskOf(a.task)).stop_order).toBe(stop.json.order.id);
    expect((await taskOf(b.task)).stop_order).toBeNull();
    expect((await taskOf(b.task)).status).toBe("leased");
    const page = await call("GET", `/hosts/${studio.host}`, { session: "m1" });
    const byId = new Map(page.json.leases.map((l: { id: number }) => [l.id, l]));
    expect(byId.get(a.task)).toMatchObject({ fenced: true, stop: { ok: false } });
    expect(byId.get(b.task)).toMatchObject({ fenced: false, stop: { ok: true } });
    // The fenced one's heartbeat is told to stop; the other's is taken.
    const beat = (t: { task: number }) => call("POST", `/factory/tasks/${t.task}/heartbeat`, { token: jobTokens.get(t.task), body: {} });
    const fenced = await beat(a);
    expect(fenced.status).toBe(409);
    expect(fenced.json).toMatchObject({ stop: true, state: "stopping" });
    expect((await beat(b)).status).toBe(200);
  });

  it("Drain and Resume on the page keep the owner rule: a drain by the owner is lifted by the owner only", async () => {
    const drain = await call("POST", `/factory/workers/${studio.worker}/orders`, { session: "m1", body: { kind: "drain", reason: "I need the machine tonight" } });
    expect(drain.status, JSON.stringify(drain.json)).toBe(201);
    const m2 = await call("GET", `/hosts/${studio.host}`, { session: "m2" });
    expect(m2.json.registration.can).toMatchObject({ drain: false, resume: false });
    expect(m2.json.registration.why.resume).toContain("m1 drained their host");
    expect(m2.json.host.drained).toMatchObject({ by: "m1", reason: "I need the machine tonight" });
    expect(m2.json.host.state).toBe("drained");
    expect(m2.json.host.units_free).toBe(0);
    expect((await call("POST", `/factory/workers/${studio.worker}/orders`, { session: "m2", body: { kind: "resume" } })).status).toBe(403);
    expect((await call("GET", `/hosts/${studio.host}`, { session: "m1" })).json.registration.can.resume).toBe(true);
    expect((await call("POST", `/factory/workers/${studio.worker}/orders`, { session: "m1", body: { kind: "resume" } })).status).toBe(201);
  });

  it("Reconcile now is a host order for an agent that takes them, and an Update of its registration for one that does not yet", async () => {
    // The pool one release ahead of the Studio's registration (its claims said v1.20.0).
    const ahead = onRelease("v1.21.0");
    expect((await call("GET", `/hosts/${studio.host}`, { session: "m1", on: ahead })).json.can).toMatchObject({ reconcile: true, reconcile_via: "order" });
    await env.DB.prepare("UPDATE hosts SET agent_version = '0.2.0' WHERE id = ?").bind(studio.host).run();
    const old = (await call("GET", `/hosts/${studio.host}`, { session: "m1", on: ahead })).json;
    expect(old.can).toMatchObject({ reconcile: false, reconcile_via: "update" });
    expect(old.can.why.reconcile).toContain("takes no host order");
    expect(old.registration.can.update).toBe(true);
    // A visitor: neither.
    expect((await call("GET", `/hosts/${studio.host}`, { on: ahead })).json.can.reconcile_via).toBeNull();
    await env.DB.prepare("UPDATE hosts SET agent_version = '0.4.0' WHERE id = ?").bind(studio.host).run();
  });

  it("the pool's cap lowers what the pool hands out and touches nothing of the envelope; above the host's units it is refused", async () => {
    // Above its units (11): it would cap nothing.
    const over = await call("POST", `/hosts/${p1.host}/cap`, { session: "m2", body: { units: 7, reason: "one more than it has" } });
    expect(over.status).toBe(400);
    expect(over.json).toMatchObject({ code: "units" });
    expect(over.json.error).toContain(`at most 6, the units the pool counts on`);
    const ordersBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM host_orders WHERE host_id = ?").bind(p1.host).first<{ n: number }>();
    const set = await call("POST", `/hosts/${p1.host}/cap`, { session: "m1", body: { units: 3, reason: "the canary at one build" } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    // Three units: one build of two and nothing more (the job unit is kept), whatever is queued.
    for (let i = 0; i < 3; i++) await queued("x86_64");
    const got: { task: number; gen: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await claim(p1, "x86_64", P1_REPORT.capacity, got);
      if (c.status !== 200) break;
      got.push({ task: c.json.task.id, gen: c.json.task.lease_gen });
    }
    expect(got).toHaveLength(1);
    // The envelope stays as its owner wrote it: no host order, no setting, the host state sends nothing new.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM host_orders WHERE host_id = ?").bind(p1.host).first<{ n: number }>()).toEqual(ordersBefore);
    expect((await hostRow(p1.host)).settings).toBeNull();
    const state = await signed(p1.k, p1.host, "GET", "/hosts/self/state");
    expect(state.json).toMatchObject({ settings: null, orders: [] });
    const page = (await call("GET", `/hosts/${p1.host}`, { session: "m1" })).json.host;
    expect(page).toMatchObject({ pool_cap_units: 3, units_effective: 3, units_busy: 2, units_free: 0, owner_caps: { max_units: 7 } });
    expect((await call("POST", `/hosts/${p1.host}/cap`, { session: "m1", body: { units: null, reason: "the canary passed" } })).status).toBe(200);
    // The page's cap dialog offers none above its units — the door refuses them —, and sixteen while the pool counts none.
    const { capOptions } = runScript(scriptOf(await served(`/hosts/${p1.host}`)), { pathname: `/hosts/${p1.host}`, functions: ["capOptions"] });
    const values = (h: unknown) => (capOptions(h) as { value: string }[]).map((o) => o.value);
    expect(values({ units: 6, pool_cap_units: null })).toEqual(["", "0", "1", "2", "3", "4", "5", "6"]);
    expect(values({ units: null, pool_cap_units: null })).toHaveLength(18);
    expect((capOptions({ units: 6, pool_cap_units: 3 }) as { selected: boolean }[]).filter((o) => o.selected)).toHaveLength(1);
  });
});

describe("D1 writes on a change, or once the row is five minutes old (#324)", () => {
  it("a report the same as the last writes nothing within five minutes; one changed, or the same one later, does", async () => {
    const before = await hostRow(studio.host);
    const again = await report(studio.k, studio.host, STUDIO_REPORT);
    expect(again.json).toMatchObject({ ok: true, written: false });
    expect((await hostRow(studio.host)).reported_at).toBe(before.reported_at);
    // Changed (it goes to sleep): written at once.
    const asleep = await report(studio.k, studio.host, { ...STUDIO_REPORT, asleep: true });
    expect(asleep.json).toMatchObject({ written: true, asleep: true });
    const awake = await report(studio.k, studio.host, STUDIO_REPORT);
    expect(awake.json).toMatchObject({ written: true, asleep: false });
    // The same again, its row HOST_ROW_TOUCH_MIN old: written, so a host that reports is never silent.
    const old = iso(Date.now() - (HOST_ROW_TOUCH_MIN + 1) * MIN);
    await env.DB.prepare("UPDATE hosts SET reported_at = ?, last_seen = ? WHERE id = ?").bind(old, old, studio.host).run();
    expect((await report(studio.k, studio.host, STUDIO_REPORT)).json).toMatchObject({ written: true });
    expect(Date.parse((await hostRow(studio.host)).reported_at)).toBeGreaterThan(Date.now() - MIN);
  });

  it("the host state's poll writes last_seen only once it is five minutes old", async () => {
    const recent = iso(Date.now() - MIN);
    await env.DB.prepare("UPDATE hosts SET last_seen = ? WHERE id = ?").bind(recent, p1.host).run();
    expect((await signed(p1.k, p1.host, "GET", "/hosts/self/state")).status).toBe(200);
    expect((await hostRow(p1.host)).last_seen).toBe(recent);
    const old = iso(Date.now() - (HOST_ROW_TOUCH_MIN + 1) * MIN);
    await env.DB.prepare("UPDATE hosts SET last_seen = ? WHERE id = ?").bind(old, p1.host).run();
    expect((await signed(p1.k, p1.host, "GET", "/hosts/self/state")).status).toBe(200);
    expect(Date.parse((await hostRow(p1.host)).last_seen)).toBeGreaterThan(Date.now() - MIN);
  });
});

describe("alive by the fleet's one rule (#324, design v2 §18.1–§18.3)", () => {
  it("a host whose last sign is twelve minutes old is silent on every page: not alive on its own, the listing, the Workers page's row, a silent line on Status", async () => {
    const h = await activeHost("m1", "x86_64", P1_REPORT.capacity);
    expect((await report(h.k, h.host, { ...P1_REPORT, needs_person: [] })).json).toMatchObject({ ok: true, written: true });
    /** Its last report and its last poll, minutes ago. */
    const signs = (reported: number, polled: number) => env.DB.prepare("UPDATE hosts SET reported_at = ?, last_seen = ? WHERE id = ?").bind(iso(Date.now() - reported * MIN), iso(Date.now() - polled * MIN), h.host).run();
    const views = async () => {
      // The fleet as its handler reads it now: the URL's answer is kept a minute at the edge.
      const fleet = (await (await handleFleet(env)).json()) as any;
      return {
        owner: (await call("GET", `/hosts/${h.host}`, { session: "m1" })).json.host,
        visitor: (await call("GET", `/hosts/${h.host}`)).json.host,
        listed: (await call("GET", "/hosts?owner=m1", { session: "m1" })).json.hosts.find((x: { id: string }) => x.id === h.host),
        row: fleet.hosts.find((x: { id: string }) => x.id === h.host),
        silentLine: fleet.lines.find((l: { kind: string; host?: { id: string } }) => l.kind === "silent" && l.host?.id === h.host),
      };
    };
    // Its machine lost power twelve minutes after its last report, its last poll just after it: Status says it silent; so does
    // every page — the report is younger than HOST_REPORT_FRESH_MIN, but nothing of it came for SILENT_MIN.
    await signs(12, 12);
    let v = await views();
    expect(v.silentLine?.text).toMatch(/^silent for 12 min: nothing of it reached the pool since /);
    expect(v.row).toMatchObject({ alive: false, state: "silent" });
    for (const [who, x] of [["owner", v.owner], ["visitor", v.visitor], ["listed", v.listed]] as const) expect(x, who).toMatchObject({ alive: false, silent: true });
    expect(v.owner.state).toBe("silent");
    expect(v.listed.fleet).toMatchObject({ alive: false, state: "silent" });
    // The page says so, its lede and a visitor's Alive row in Status's words — never "Its agent reports.".
    const owner = await drawn(h.host, "m1");
    expect(owner.nodes["#hp-lede"].innerHTML).toContain('<span class="muted">Silent: nothing of it reached the pool in the last 10 minutes.</span>');
    expect(owner.nodes["#hp-lede"].innerHTML).not.toContain("Its agent reports.");
    const visitor = await drawn(h.host);
    expect(visitor.nodes["#hp-kv"].innerHTML).toContain('<dt>Alive</dt><dd><span class="muted">silent: nothing of it reached the pool in the last 10 minutes</span></dd>');
    // Its report twelve minutes old and a poll a minute ago: it reports, everywhere, and Status says nothing.
    await signs(12, 1);
    v = await views();
    expect(v.silentLine).toBeUndefined();
    for (const [who, x] of [["owner", v.owner], ["visitor", v.visitor], ["listed", v.listed], ["row", v.row]] as const) expect(x, who).toMatchObject({ alive: true });
    expect((await drawn(h.host)).nodes["#hp-kv"].innerHTML).toContain("<dt>Alive</dt><dd>its agent reports</dd>");
    // Its polls go on but no report came for HOST_REPORT_FRESH_MIN: not alive, not silent — the page says no report came.
    await signs(16, 1);
    v = await views();
    expect(v.silentLine).toBeUndefined();
    for (const [who, x] of [["owner", v.owner], ["visitor", v.visitor], ["listed", v.listed]] as const) expect(x, who).toMatchObject({ alive: false, silent: false });
    expect(v.row.alive).toBe(false);
    expect((await drawn(h.host, "m1")).nodes["#hp-lede"].innerHTML).toContain('<span class="muted">Its agent has not reported in the last 15 minutes.</span>');
  });
});

describe("the host page's layout, themes and controls (#324)", () => {
  it("at 1280 its stats sit five to a line and two on a phone, its leases scroll in their card with each Stop whole; every colour is a theme token; every control is named", async () => {
    const html = await served(`/hosts/${studio.host}`);
    expect(declared(html, "#hp-stats")["grid-template-columns"]).toBe("1fr 1fr"); // the @media (max-width: 899px) rule is the later one
    expect(html).toContain("#hp-stats { grid-template-columns: repeat(5, minmax(0, 1fr)); }");
    expect(html).toMatch(/@media \(max-width: 899px\) \{ #hp-stats \{ grid-template-columns: 1fr 1fr; \}/);
    expect(declared(html, ".hp")["max-width"]).toBe("1056px");
    expect(declared(html, ".hp-table")).toMatchObject({ "overflow-x": "auto" });
    expect(declared(html, "#hp-lease-rows td:nth-child(3)")).toMatchObject({ "overflow-wrap": "anywhere" });
    expect(declared(html, "#hp-lease-rows td:last-child")).toMatchObject({ "white-space": "nowrap" });
    expect(declared(html, ".hp-needs-list")).toMatchObject({ "overflow-wrap": "anywhere" });
    // Both themes: the page's own rules name the palette's tokens only, which each theme defines.
    const own = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).find((c) => c.includes(".hp {"))!.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(own).toBeDefined();
    expect(own).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    for (const v of new Set([...own.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))) expect(html, v).toMatch(new RegExp(`${v}:\\s*[^;]+;`));
    // Every button served has a name; the Stop column's header has one; each card is a region with its heading.
    const body = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
    for (const b of body.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []) expect(b.replace(/<[^>]*>/g, "").trim().length > 0 || /aria-label="[^"]+"/.test(b), b).toBe(true);
    expect(body).toContain('<th aria-label="Stop"></th>');
    for (const id of ["hp-needs", "hp-facts", "hp-operate", "hp-orders", "hp-leases"]) expect(body).toMatch(new RegExp(`<section class="[^"]*" id="${id}" aria-labelledby="${id}-h"`));
  });
});
