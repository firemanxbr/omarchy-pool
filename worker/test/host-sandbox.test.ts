/**
 * A sandboxed runtime for community tasks (#330, epic #307, design v2 §10.4;
 * D43; P6): a host's agent finds gVisor's `runsc` or Kata Containers and its
 * dispatcher starts the community tasks of its native lane in it, so a
 * container escape lands in the sandbox's kernel, not on the host. The pool
 * keeps what the agent reports and the host page says it; it never selects
 * on it. Through the Worker with a real D1 and real Ed25519 host keys, as the
 * hosts' agents enroll and report:
 *
 * - the capacity the agent writes (`run/capacity.json`, the agent's own
 *   fixtures, which its tests and the dispatcher's read too) keeps its
 *   `sandbox` — `{runtime, kind}`, `null` for none, absent from an agent
 *   before #330 — and `sandbox_held`, cut; one that does not read is left
 *   out, never a refusal of the report it rides on;
 * - a report's sandbox reaches the host row and GET /hosts/:id answers it
 *   to its owner and the maintainers, inside `capacity`, and to nobody else;
 * - the host page's words for each: the runtime and the lane it covers, the
 *   emulated lane on the engine's own runtime; none, with why; an agent that
 *   does not say.
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

describe("the host page's words for it", () => {
  // The page's own function, read out of the page it serves.
  const script = hostHtml("h_sandbox001", "https://pool.example", { version: "v1.0.0", commit: null, deployed_at: null, release_url: null, commit_url: null, analytics: "" });
  const start = script.indexOf("function sandboxWords(h) {");
  const body = script.slice(start, script.indexOf("\n  }\n", start) + 4);
  const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const words = new Function("esc", "SANDBOX_KINDS", `${body}; return sandboxWords;`)(esc, { gvisor: "gVisor", kata: "Kata Containers" }) as (h: unknown) => string;
  const lanes = SANDBOXED.lanes;

  it("is drawn beside the isolation level", () => {
    expect(start).toBeGreaterThan(0);
    expect(script).toContain('kv("Sandbox", sandboxWords(h))');
  });

  it("names the runtime and the lane it covers, the emulated lane on the engine's own runtime", () => {
    const w = words({ capacity: SANDBOXED, lanes });
    expect(w).toContain("gVisor (runsc) — its community tasks on the aarch64 lane run in it: a container escape lands in its kernel, not on the host");
    expect(w).toContain("on its emulated x86_64 lane they run on the engine's own runtime");
    expect(words({ capacity: { ...SANDBOXED, sandbox: { runtime: "kata", kind: "kata" } }, lanes: [lanes[0]] })).toBe("Kata Containers (kata) — its community tasks on the aarch64 lane run in it: a container escape lands in its kernel, not on the host");
  });

  it("says none, with why one is not used, and an agent that does not say", () => {
    const none = words({ capacity: { ...NONE, sandbox_held: "runsc: its container ran on the engine's own kernel (6.8.0), so it is no sandbox" }, lanes });
    expect(none).toContain("none — its community tasks run on the engine's own runtime, at its isolation level");
    expect(none).toContain("runsc: its container ran on the engine's own kernel (6.8.0), so it is no sandbox");
    expect(words({ capacity: without(NONE, "sandbox"), lanes })).toContain("its agent does not say");
    expect(words({ capacity: { ...NONE, sandbox_held: "<b>x</b>" }, lanes })).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
