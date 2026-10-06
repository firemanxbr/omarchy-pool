/**
 * A sandboxed runtime for a contributor's tasks (#330, epic #307, design v2
 * §10.4; D43; P6): a host's agent finds gVisor's `runsc` or Kata Containers
 * and its dispatcher starts what a contributor wrote — their builds, the
 * project's review rebuilds of them, trials, audits — in it on its native
 * lane, so a container escape lands in the sandbox's kernel, not on the host.
 * Through the Worker with a real D1 and real Ed25519 host keys, as the hosts'
 * agents enroll and report and their dispatchers claim:
 *
 * - the capacity the agent writes (`run/capacity.json`, the agent's own
 *   fixtures, which its tests and the dispatcher's read too) keeps its
 *   `sandbox` — `{runtime, kind}`, `null` for none, absent from an agent
 *   before #330 — and `sandbox_held`, cut; one that does not read is left
 *   out, never a refusal of the report it rides on;
 * - a report's sandbox reaches the host row and GET /hosts/:id answers it
 *   to its owner and the maintainers, inside `capacity`, and to nobody else;
 * - the dispatcher's claims say the sandbox it applies: kept in
 *   hosts.sandbox_applied when it changes — with why its claims hold, and
 *   gone when a dispatcher before #330 claims again — and answered beside
 *   what the agent found; a sandboxed host's emulated lane is handed the
 *   project's own recipe only, what a contributor wrote its native lane, and
 *   a host whose claims say none takes them on its emulated lane as before;
 * - the host page's words for each: the runtime its dispatcher applies and
 *   the lanes it covers; what its agent found while its dispatcher does not
 *   say; none, with why; a hold; an agent that does not say.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { enrollMessage, parseCapacity, signedMessage, HELD_REASON_MAX } from "../src/hosts";
import { hostHtml } from "../src/pages/host";
import { toB64url } from "../src/webauthn";
import sandboxedFixture from "../../crates/omarchy-agent/tests/fixtures/capacity/sandboxed.json?raw";
import emulatedFixture from "../../crates/omarchy-agent/tests/fixtures/capacity/emulated-lane.json?raw";

const ORIGIN = "http://pool.test";
const SANDBOXED = JSON.parse(sandboxedFixture);
const NONE = JSON.parse(emulatedFixture);

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

let names = 0;
/** A maintainer host enrolled by its agent with `capacity`, confirmed by m1. */
async function enrolled(capacity: unknown): Promise<{ k: Key; id: string }> {
  const k = await newKey();
  const m = await call("POST", "/hosts/enrollments", { session: "m1", body: { name: `sbx-${++names}` } });
  expect(m.status, JSON.stringify(m.json)).toBe(201);
  const e = await call("POST", "/hosts/enroll", { body: { token: m.json.token, pubkey: k.pub, sig: await sign(k, enrollMessage(m.json.token, k.pub)), hostname: `sbx-${names}`, os: "linux", arch: "aarch64", page_kb: 16, isolation: "root", dedicated: true, agent_version: "0.4.0", capacity } });
  expect(e.status, JSON.stringify(e.json)).toBe(201);
  expect((await call("POST", `/hosts/${e.json.host}/confirm`, { session: "m1", body: {} })).status).toBe(200);
  return { k, id: e.json.host };
}
const report = (h: { k: Key; id: string }, capacity: unknown) =>
  signed(h.k, h.id, "POST", "/hosts/self/report", JSON.stringify({ agent: { version: "0.4.0" }, release: { applied: "v1.0.0" }, capacity, orders: [] }));
const without = (o: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

beforeAll(async () => {
  const people: [string, string, number][] = [["m1", "maintainer", 1001], ["alice", "contributor", 2001]];
  await env.DB.batch(await Promise.all(people.map(async ([l, role, g]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES (?, ?, ?, ?, ?)").bind(l, await sha256Hex(`omc_${l}`), await sha256Hex(`oms_${l}`), role, g))));
  await applyGovernance(env, ["m1"], "sha-sandbox");
});

describe("the capacity's sandbox, as the agent writes it", () => {
  it("is kept — {runtime, kind}, null for none, absent from an older agent — with why one is not used, cut", () => {
    const on = parseCapacity(SANDBOXED);
    if (typeof on === "string") throw new Error(on);
    expect(on.sandbox).toEqual({ runtime: "runsc", kind: "gvisor" });
    expect(on.lanes.map((l) => l.mode)).toEqual(["native", "emulated"]);
    const none = parseCapacity(NONE);
    if (typeof none === "string") throw new Error(none);
    expect(none.sandbox).toBeNull();
    const older = parseCapacity(without(NONE, "sandbox"));
    if (typeof older === "string") throw new Error(older);
    expect("sandbox" in older).toBe(false);
    const kata = parseCapacity({ ...NONE, sandbox: { runtime: "kata-qemu", kind: "kata" }, sandbox_held: "runsc: the smoke run failed: " + "x".repeat(400) });
    if (typeof kata === "string") throw new Error(kata);
    expect(kata.sandbox).toEqual({ runtime: "kata-qemu", kind: "kata" });
    expect(kata.sandbox_held).toHaveLength(HELD_REASON_MAX);
  });

  it("one that does not read is left out, and the capacity it rides on is still taken", () => {
    for (const sandbox of [{ runtime: "runsc", kind: "runc" }, { runtime: "--privileged", kind: "gvisor" }, { kind: "gvisor" }, "runsc", 1]) {
      const c = parseCapacity({ ...NONE, sandbox, sandbox_held: " " });
      if (typeof c === "string") throw new Error(`${JSON.stringify(sandbox)}: ${c}`);
      expect("sandbox" in c, JSON.stringify(sandbox)).toBe(false);
      expect("sandbox_held" in c).toBe(false);
    }
  });
});

describe("a host's report with its sandbox", () => {
  it("reaches its row and the host's answer for its owner and the maintainers, never for anyone else", async () => {
    // Enrolled by an agent before #330: its capacity says nothing of one.
    const h = await enrolled(without(NONE, "sandbox"));
    let seen = await call("GET", `/hosts/${h.id}`, { session: "m1" });
    expect(seen.json.host.capacity).toBeDefined();
    expect("sandbox" in seen.json.host.capacity).toBe(false);
    // gVisor installed and found: the next report carries it.
    expect((await report(h, SANDBOXED)).status).toBe(200);
    seen = await call("GET", `/hosts/${h.id}`, { session: "m1" });
    expect(seen.json.host.capacity.sandbox).toEqual({ runtime: "runsc", kind: "gvisor" });
    const stored = await env.DB.prepare("SELECT capacity FROM hosts WHERE id = ?").bind(h.id).first<{ capacity: string }>();
    expect(JSON.parse(stored!.capacity).sandbox).toEqual({ runtime: "runsc", kind: "gvisor" });
    // Anyone else sees no capacity at all, so no sandbox.
    for (const session of [undefined, "alice"]) {
      const other = await call("GET", `/hosts/${h.id}`, { session });
      expect(other.status).toBe(200);
      expect(other.json.host.capacity).toBeUndefined();
    }
    // Its owner turned it off, or the runtime failed its smoke run: none, with why.
    expect((await report(h, { ...NONE, sandbox_held: "runsc: the smoke run failed: exit status 128" })).status).toBe(200);
    seen = await call("GET", `/hosts/${h.id}`, { session: "m1" });
    expect(seen.json.host.capacity).toMatchObject({ sandbox: null, sandbox_held: "runsc: the smoke run failed: exit status 128" });
  });
});

describe("the sandbox its dispatcher applies, as its claims say", () => {
  const STUDIO_ID = "sbx-studio", PLAIN_ID = "sbx-plain";
  // The claim's capacity, as the dispatcher sends it (crates/pkg-repo dispatch/capacity.rs): the agent's file, with the sandbox it applies.
  const claimCap = (sandbox: unknown, held?: string) => {
    const { cpus, mem_gb, disk_free_gb, units, job_reserved, agent_slots, lanes, held_lanes } = SANDBOXED;
    return { cpus, mem_gb, disk_free_gb, units, job_reserved, agent_slots, lanes, held_lanes, ...(sandbox === undefined ? {} : { sandbox }), ...(held ? { sandbox_held: held } : {}) };
  };
  let seq = 0;
  const claim = (worker: string, capacity: unknown, want = 1) =>
    call("POST", "/factory/claim", { headers: { authorization: `Bearer omw_${worker}` }, body: {
      arch: "aarch64", version: "v1.0.0", hostname: worker, kinds: ["build", "trial", "audit"], claim_id: `c_sbx${String(++seq).padStart(8, "0")}`, want,
      leases: [], capacity, labels: { role: "dispatcher" }, agent: { provider: "anthropic", model: "claude-test", probe: "ok", checked_at: "2026-10-01T00:00:00Z" },
    } });
  const hostIds = new Map<string, string>();
  /** A Studio host, active, its registration alive: aarch64 native, x86_64 emulated, as the agent's fixture says. */
  async function seedStudio(worker: string): Promise<void> {
    const id = `h_sbx${String(hostIds.size + 1).padStart(7, "0")}`;
    hostIds.set(worker, id);
    const cap = claimCap(SANDBOXED.sandbox);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, arch, capacity, lanes, units, agent_slots, disk_free, worker_id, confirmed_at, last_seen)
                      VALUES (?, 'm1', 1001, ?, ?, 'active', 'aarch64', ?, ?, ?, 2, ?, ?, ?, ?)`)
        .bind(id, worker, toB64url(crypto.getRandomValues(new Uint8Array(32))), JSON.stringify({ ...cap, below_minimum: null }), JSON.stringify(cap.lanes), cap.units, JSON.stringify(cap.disk_free_gb), worker, new Date().toISOString(), new Date().toISOString()),
      env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, kind, host_id, kinds, agent_status) VALUES (?, 'aarch64', 'm1', ?, 'shared', 'project', 'm1', ?, 'host', ?, '[\"build\",\"trial\",\"audit\"]', 'ok')")
        .bind(worker, await sha256Hex(`omw_${worker}`), new Date().toISOString(), id),
    ]);
  }
  const applied = async (worker: string) => (await env.DB.prepare("SELECT sandbox_applied FROM hosts WHERE id = ?").bind(hostIds.get(worker)).first<{ sandbox_applied: string | null }>())!.sandbox_applied;
  let names = 0;
  /** A queued task of an hour ago: a contributor's build, the project's review rebuild of one, its trial, or the project's own recipe. */
  async function queued(arch: string, what: "theirs" | "copy" | "trial" | "own"): Promise<number> {
    const name = `sbx${++names}`;
    const [trust, kind, owner, ref, params] = {
      theirs: ["community", "build", `alice${names}`, `https://github.com/a/${name}@v1:PKGBUILD`, null],
      copy: ["project", "build", "alice", `review:9999`, JSON.stringify({ review: 9999 })],
      trial: ["project", "trial", null, "staging:9999", JSON.stringify({ task: 9999 })],
      own: ["project", "build", null, `https://github.com/x/${name}@v1:PKGBUILD`, null],
    }[what];
    return (await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, created_at) VALUES (?, ?, '1.0-1', ?, 'test', 100, 'queued', ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(name, arch, ref, kind === "build" && trust === "project" && !params ? 1 : 0, trust, owner, kind, params, new Date(Date.now() - 60 * 60000).toISOString()).first<{ id: number }>())!.id;
  }

  it("is kept from each claim when it changes, with why the claims hold, and answered beside what the agent found; a dispatcher before #330 says none", async () => {
    await seedStudio(STUDIO_ID);
    expect(await applied(STUDIO_ID)).toBeNull();
    expect((await claim(STUDIO_ID, claimCap(SANDBOXED.sandbox), 0)).status).toBe(204);
    expect(JSON.parse((await applied(STUDIO_ID))!)).toEqual({ sandbox: { runtime: "runsc", kind: "gvisor" } });
    let seen = await call("GET", `/hosts/${hostIds.get(STUDIO_ID)}`, { session: "m1" });
    expect(seen.json.host.sandbox_applied).toEqual({ sandbox: { runtime: "runsc", kind: "gvisor" } });
    expect(seen.json.host.capacity.sandbox).toEqual({ runtime: "runsc", kind: "gvisor" });
    for (const session of [undefined, "alice"]) expect((await call("GET", `/hosts/${hostIds.get(STUDIO_ID)}`, { session })).json.host.sandbox_applied).toBeUndefined();
    // Its runtime refused a start: the claims hold, and say why.
    const why = "runsc refused task 7's start (unknown or invalid runtime name: runsc): no claim for 30 minutes";
    expect((await claim(STUDIO_ID, claimCap(SANDBOXED.sandbox, why), 0)).status).toBe(204);
    seen = await call("GET", `/hosts/${hostIds.get(STUDIO_ID)}`, { session: "m1" });
    expect(seen.json.host.sandbox_applied).toEqual({ sandbox: { runtime: "runsc", kind: "gvisor" }, held: why });
    // None applied; then a dispatcher from before #330 (a rollback below it) says nothing of it: the host page claims no sandbox.
    expect((await claim(STUDIO_ID, claimCap(null), 0)).status).toBe(204);
    expect(JSON.parse((await applied(STUDIO_ID))!)).toEqual({ sandbox: null });
    expect((await claim(STUDIO_ID, claimCap(undefined), 0)).status).toBe(204);
    expect(await applied(STUDIO_ID)).toBeNull();
    seen = await call("GET", `/hosts/${hostIds.get(STUDIO_ID)}`, { session: "m1" });
    expect(seen.json.host.sandbox_applied).toBeNull();
    expect(seen.json.host.capacity.sandbox).toEqual({ runtime: "runsc", kind: "gvisor" });
  });

  it("a sandboxed host's emulated lane is handed the project's own recipe only, what a contributor wrote its native lane; a host whose claims say none takes them emulated", async () => {
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE status IN ('queued', 'leased')").run();
    const theirs = await queued("x86_64", "theirs"), copy = await queued("x86_64", "copy"), trial = await queued("x86_64", "trial");
    const own = await queued("x86_64", "own"), native = await queued("aarch64", "theirs");
    const got: Record<number, string> = {};
    for (let i = 0; i < 6; i++) {
      const c = await claim(STUDIO_ID, claimCap(SANDBOXED.sandbox));
      if (c.status === 204) break;
      expect(c.status, JSON.stringify(c.json)).toBe(200);
      got[c.json.task.id] = c.json.task.lane;
    }
    expect(got).toEqual({ [own]: "emulated", [native]: "native" });
    // The same Studio whose dispatcher applies none (its owner's `sandbox = "off"`) takes what a contributor wrote on its emulated lane.
    await seedStudio(PLAIN_ID);
    const plain: Record<number, string> = {};
    for (let i = 0; i < 6; i++) {
      const c = await claim(PLAIN_ID, claimCap(null));
      if (c.status === 204) break;
      expect(c.status, JSON.stringify(c.json)).toBe(200);
      plain[c.json.task.id] = c.json.task.lane;
    }
    expect(plain).toEqual({ [theirs]: "emulated", [copy]: "emulated", [trial]: "emulated" });
  });
});

describe("the host page's words for it", () => {
  // The page's own function, read out of the page it serves.
  const script = hostHtml("h_sandbox001", "https://pool.example", { version: "v1.0.0", commit: null, deployed_at: null, release_url: null, commit_url: null, analytics: "" });
  const start = script.indexOf("function sandboxWords(h) {");
  const body = script.slice(start, script.indexOf("\n  }\n", start) + 4);
  const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const words = new Function("esc", "SANDBOX_KINDS", `${body}; return sandboxWords;`)(esc, { gvisor: "gVisor", kata: "Kata Containers" }) as (h: unknown) => string;
  const lanes = SANDBOXED.lanes;
  const gvisor = { sandbox: { runtime: "runsc", kind: "gvisor" } };

  it("is drawn beside the isolation level", () => {
    expect(start).toBeGreaterThan(0);
    expect(script).toContain('kv("Sandbox", sandboxWords(h))');
  });

  it("names the runtime its dispatcher applies and the lanes it covers: what a contributor wrote on the native lane, the project's own recipe only on the emulated one", () => {
    const w = words({ capacity: SANDBOXED, sandbox_applied: gvisor, lanes });
    expect(w).toContain("gVisor (runsc) — what its contributors wrote (their builds, the project's review rebuilds, trials, audits) runs in it on the aarch64 lane: a container escape lands in its kernel, not on the host");
    expect(w).toContain("; its emulated x86_64 lane takes the project's own recipes only");
    expect(words({ capacity: SANDBOXED, sandbox_applied: { sandbox: { runtime: "kata", kind: "kata" } }, lanes: [lanes[0]] })).toBe("Kata Containers (kata) — what its contributors wrote (their builds, the project's review rebuilds, trials, audits) runs in it on the aarch64 lane: a container escape lands in its kernel, not on the host");
    // Its claims hold: the runtime refused a start.
    expect(words({ capacity: SANDBOXED, sandbox_applied: { ...gvisor, held: "runsc refused task 7's start (<x>)" }, lanes })).toContain("its claims hold: runsc refused task 7's start (&lt;x&gt;)");
  });

  it("claims no sandbox its dispatcher does not say it applies: what its agent found, a dispatcher before #330", () => {
    const w = words({ capacity: SANDBOXED, sandbox_applied: null, lanes });
    expect(w).toContain("its agent found gVisor (runsc), but its dispatcher does not say it applies it (one before #330)");
    expect(w).not.toContain("lands in its kernel");
  });

  it("says none, with why one is not used, and an agent that does not say", () => {
    const none = words({ capacity: { ...NONE, sandbox_held: "runsc: its container ran on the engine's own kernel (6.8.0), so it is no sandbox" }, sandbox_applied: { sandbox: null }, lanes });
    expect(none).toContain("none — what its contributors wrote runs on the engine's own runtime, at its isolation level");
    expect(none).toContain("runsc: its container ran on the engine's own kernel (6.8.0), so it is no sandbox");
    expect(words({ capacity: NONE, lanes })).toContain("none — what its contributors wrote runs on the engine's own runtime");
    expect(words({ capacity: without(NONE, "sandbox"), lanes })).toContain("its agent does not say");
    expect(words({ capacity: { ...NONE, sandbox_held: "<b>x</b>" }, lanes })).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
