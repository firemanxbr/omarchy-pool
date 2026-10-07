/**
 * The Studio switch's pins (#345, design v2 §21.1 step 4), inside workerd with
 * a real D1: m1's host — the Studio canary, aarch64 native and x86_64
 * emulated — beside m1's legacy registrations (a pool worker, an emulated
 * review worker, a community worker, one revoked), m2's legacy registration
 * and m2's x86_64 host, with queued tasks pinned to them:
 *
 * - the host page tells its owner and the maintainers how many queued tasks
 *   are pinned to its owner's legacy registrations, and on which; a visitor
 *   neither those nor the press;
 * - Move pins here is its owner's or any maintainer's, with a reason, from
 *   the page's own session only, on an active host whose registration is not
 *   drained and whose pool cap is not 0; a host that does not claim now
 *   moves nothing;
 * - what the host could run once idle moves onto its registration — a native
 *   build, an emulated one — each saying so on its page (`params.repinned`),
 *   one journal line with who, why, what moved and what stayed; what it could
 *   not stays, said with why — a `needs_native` task on its emulated lane,
 *   the project's copy of its owner's own package (D35), a size its pool cap
 *   leaves no room for —; another maintainer's pins, a leased task and a
 *   revoked registration's are never touched;
 * - the switch drains the legacy registrations and the drain's sweep sends
 *   what stayed to the queue: no task waits on a drained legacy registration;
 * - the host claims what moved onto it; the way back drains the host's
 *   registration — what was moved onto it goes to the queue at the sweep —
 *   and a resumed legacy registration claims again on the pool's release;
 * - every new statement by its index.
 *
 * Tokens: workers omw_<id>, people's CLI omc_<login>, sessions oms_<login>.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { unitsOf } from "../src/hosts";
import { LEGACY_PIN_COUNTS_SQL, LEGACY_PINS_SQL, REPIN_SQL, REPINNED_SQL } from "../src/routes/factory";
import { sweepOrders } from "../src/orders";
import { toB64url } from "../src/webauthn";
import { runScript, scriptOf } from "./fixture";

const ORIGIN = "http://pool.test";
const MIN = 60000;
const iso = (ms: number) => new Date(ms).toISOString();

interface Res { status: number; json: any }
interface Who { session?: string; token?: string; origin?: boolean }
async function call(method: string, path: string, body?: unknown, who: Who = {}, on: typeof env = env): Promise<Res> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (who.session) { headers.cookie = `omc=oms_${who.session}`; headers["content-type"] = "application/json"; if (who.origin !== false) headers.origin = ORIGIN; }
  if (who.token) headers.authorization = `Bearer ${who.token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), on, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const page = (login: string): Who => ({ session: login });

type Lane = { arch: string; mode: "native" | "emulated"; via?: string; page16k?: boolean };
interface Box { cpus: number; mem_gb: number; lanes: Lane[] }
const capOf = (b: Box) => ({ cpus: b.cpus, mem_gb: b.mem_gb, disk_free_gb: { work: 410, engine: 220 }, units: unitsOf({ cpus: b.cpus, mem_gb: b.mem_gb, units: null }), job_reserved: 1, agent_slots: 2, lanes: b.lanes });
const STUDIO: Box = { cpus: 12, mem_gb: 32, lanes: [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated", via: "qemu", page16k: true }] };
const VPS86: Box = { cpus: 8, mem_gb: 16, lanes: [{ arch: "x86_64", mode: "native" }] };
const GITHUB: Record<string, number> = { m1: 1001, m2: 1002, bob: 2001 };
const CLAUDE = "anthropic/claude-a";

const boxes = new Map<string, Box>();
/** A maintainer's host, active, with its registration (its id the registration's), seen now; the host's id is returned. */
async function seedHost(worker_: string, owner: string, box: Box, host: string): Promise<string> {
  const cap = capOf(box);
  const native = box.lanes.find((l) => l.mode === "native")!.arch;
  const seen = iso(Date.now());
  boxes.set(worker_, box);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, arch, capacity, lanes, units, agent_slots, disk_free, worker_id, confirmed_at, last_seen)
                    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 2, ?, ?, ?, ?)`)
      .bind(host, owner, GITHUB[owner], worker_.replace(`${owner}-`, ""), toB64url(crypto.getRandomValues(new Uint8Array(32))), native, JSON.stringify({ ...cap, below_minimum: null }), JSON.stringify(box.lanes), unitsOf(cap), JSON.stringify(cap.disk_free_gb), worker_, seen, seen),
    env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, trust, trusted_by, last_seen, kind, host_id, kinds, agent, agent_status) VALUES (?, ?, ?, ?, 'project', ?, ?, 'host', ?, '[\"build\",\"trial\",\"audit\"]', ?, 'ok')")
      .bind(worker_, native, owner, await sha256Hex(`omw_${worker_}`), owner, seen, host, CLAUDE),
  ]);
  return host;
}
/** A legacy registration of a maintainer's compose set: its arch, its trust, emulated when its labels say so. */
async function seedLegacy(id: string, owner: string, arch: string, trust: "project" | "community", o: { emulated?: boolean; revoked?: boolean } = {}): Promise<void> {
  await env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, trust, trusted_by, last_seen, labels, kinds, agent, agent_status, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[\"build\",\"trial\",\"audit\"]', ?, 'ok', ?)")
    .bind(id, arch, owner, await sha256Hex(`omw_${id}`), trust, trust === "project" ? owner : null, iso(Date.now()), JSON.stringify({ where: "omarchy-studio", ...(o.emulated ? { emulated: true } : {}) }), CLAUDE, o.revoked ? iso(Date.now() - 60 * MIN) : null).run();
}
let seq = 0;
/** A queued task (or one in another state), pinned where it says. */
async function seedTask(t: { arch: string; pinned_to: string | null; trust?: "project" | "community"; owner?: string | null; params?: Record<string, unknown>; status?: string; ref?: string; lease_owner?: string | null }): Promise<number> {
  const name = `pinned${++seq}`;
  return (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, pinned_to, lease_owner, lease_expires_at)
     VALUES (?, ?, '1.0-1', ?, 'test', 100, ?, 0, ?, ?, 'build', ?, ?, ?, ?) RETURNING id`,
  ).bind(name, t.arch, t.ref ?? `https://github.com/x/${name}@v1:PKGBUILD`, t.status ?? "queued", t.trust ?? "project", t.owner ?? null, t.params ? JSON.stringify(t.params) : null, t.pinned_to, t.lease_owner ?? null, t.status === "leased" ? iso(Date.now() + 60 * MIN) : null)
    .first<{ id: number }>())!.id;
}
const taskOf = (id: number) => env.DB.prepare("SELECT * FROM build_tasks WHERE id = ?").bind(id).first<any>();
const paramsOf = async (id: number) => JSON.parse((await taskOf(id)).params ?? "{}");
/** A host's claim as its dispatcher sends it: its capacity and its probe's provider and model. */
const hostClaim = (worker_: string) => {
  const box = boxes.get(worker_)!;
  return call("POST", "/factory/claim", {
    arch: box.lanes.find((l) => l.mode === "native")!.arch, version: "v1.0.2", hostname: worker_, kinds: ["build", "trial", "audit"], claim_id: `c_pins${String(++seq).padStart(8, "0")}`, want: 1,
    leases: [], capacity: capOf(box), agent: { provider: "anthropic", model: "claude-a", probe: "ok", checked_at: "2026-10-01T00:00:00Z" },
  }, { token: `omw_${worker_}` });
};
/** A legacy registration's claim, as the worker image sends it: its arch, its kinds, its release. */
const legacyClaim = (id: string, arch: string, version: string, on: typeof env = env) => call("POST", "/factory/claim", { arch, version, kinds: ["build"], agent: "claude-code/claude-a", agent_status: "ok" }, { token: `omw_${id}` }, on);
const drain = (id: string, who: string) => call("POST", `/factory/workers/${id}/orders`, { kind: "drain", reason: "the Studio switch (#345)" }, page(who));
const resume = (id: string, who: string) => call("POST", `/factory/workers/${id}/orders`, { kind: "resume", reason: "the way back (#345)" }, page(who));
const pinsLines = async () => (await env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'host' AND json_extract(payload, '$.action') = 'pins' ORDER BY id").all<{ status: string; summary: string; payload: string }>()).results;

let studio: string, vps: string;
/** The tasks: what moves, what stays and why, what is never touched. */
const T = {} as Record<"native" | "emulated" | "needsNative" | "ownCopy" | "big" | "othersPin" | "leased" | "revokedPin", number>;

beforeAll(async () => {
  const h = sha256Hex;
  await env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES
      ('m1', ?, ?, 'maintainer', 1001), ('m2', ?, ?, 'maintainer', 1002), ('bob', ?, ?, 'contributor', 2001)`)
    .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_bob"), await h("oms_bob")).run();
  await applyGovernance(env, ["m1", "m2"], "sha-start");
  studio = await seedHost("m1-studio", "m1", STUDIO, "h_pins000001");
  vps = await seedHost("m2-vps", "m2", VPS86, "h_pins000002");
  await seedLegacy("m1-pool-aarch64", "m1", "aarch64", "project");
  await seedLegacy("m1-review-x86_64", "m1", "x86_64", "project", { emulated: true });
  await seedLegacy("m1-community-aarch64", "m1", "aarch64", "community");
  await seedLegacy("m1-old-aarch64", "m1", "aarch64", "project", { revoked: true });
  await seedLegacy("m2-cli-aarch64", "m2", "aarch64", "community");
  T.native = await seedTask({ arch: "aarch64", pinned_to: "m1-pool-aarch64" });
  T.emulated = await seedTask({ arch: "x86_64", pinned_to: "m1-review-x86_64" });
  T.needsNative = await seedTask({ arch: "x86_64", pinned_to: "m1-review-x86_64", params: { needs_native: 1 } });
  // The project's copy of m1's own package: the contributor's build it answers is m1's, so m1 is its requester (D35).
  const theirs = await seedTask({ arch: "aarch64", pinned_to: null, trust: "community", owner: "m1", status: "staged" });
  const name = (await taskOf(theirs)).name;
  T.ownCopy = (await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, pinned_to)
      VALUES (?, 'aarch64', '1.0-1', ?, 'project build asked by m2', 30, 'queued', 0, 'project', 'm1', 'build', ?, 'm1-community-aarch64') RETURNING id`)
    .bind(name, `review:${theirs}`, JSON.stringify({ review: theirs, by: "m2", agent: CLAUDE })).first<{ id: number }>())!.id;
  // Size 3: six units, more than the four a pool cap of 5 leaves for builds (the job unit kept) while m2's host runs size 3.
  T.big = await seedTask({ arch: "aarch64", pinned_to: "m1-pool-aarch64", params: { size: 3 } });
  T.othersPin = await seedTask({ arch: "aarch64", pinned_to: "m2-cli-aarch64", trust: "community", owner: "bob" });
  T.leased = await seedTask({ arch: "aarch64", pinned_to: "m1-pool-aarch64", status: "leased", lease_owner: "m1-pool-aarch64" });
  T.revokedPin = await seedTask({ arch: "aarch64", pinned_to: "m1-old-aarch64" });
});

describe("the host page says the tasks pinned to its owner's legacy registrations (#345)", () => {
  it("to its owner and the maintainers, with the press their verdict allows; a visitor neither", async () => {
    for (const who of ["m1", "m2"]) {
      const r = await call("GET", `/hosts/${studio}`, undefined, page(who));
      expect(r.status).toBe(200);
      // Five queued tasks on three registrations — never another owner's pin, a leased task or a revoked registration's.
      expect(r.json.host.legacy_pins).toEqual({ tasks: 5, workers: [{ id: "m1-community-aarch64", tasks: 1 }, { id: "m1-pool-aarch64", tasks: 2 }, { id: "m1-review-x86_64", tasks: 2 }] });
      expect(r.json.can.pins).toBe(true);
    }
    for (const who of [undefined, "bob"]) {
      const r = await call("GET", `/hosts/${studio}`, undefined, who ? page(who) : {});
      expect(r.json.host.legacy_pins).toBeUndefined();
      expect(r.json.can.pins).toBe(false);
      expect(r.json.can.why.pins).toMatch(who ? /only m1 or a maintainer moves pinned tasks onto studio/ : /sign in/i);
    }
    // m2's host weighs m2's: one task on its CLI registration.
    expect((await call("GET", `/hosts/${vps}`, undefined, page("m2"))).json.host.legacy_pins).toEqual({ tasks: 1, workers: [{ id: "m2-cli-aarch64", tasks: 1 }] });
  });
});

/** The page as a browser draws it for `login` (none: a visitor), from the same reads, once its facts are drawn. */
async function drawn(host: string, login?: string) {
  const ctx0 = createExecutionContext();
  const html = await (await worker.fetch(new Request(`${ORIGIN}/hosts/${host}`), env, ctx0)).text();
  await waitOnExecutionContext(ctx0);
  const fetch = (path: string, init?: RequestInit) => {
    const ctx = createExecutionContext();
    const headers = { ...(init?.headers as Record<string, string> | undefined), ...(login ? { cookie: `omc=oms_${login}` } : {}) };
    return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, ctx).then(async (r) => { await waitOnExecutionContext(ctx); return r; });
  };
  const d = runScript(scriptOf(html), { pathname: `/hosts/${host}`, functions: [], fetch });
  for (let i = 0; i < 100 && !/<dt>/.test(d.nodes["#hp-kv"]?.innerHTML ?? ""); i++) await new Promise((r) => setTimeout(r, 30));
  return d;
}

describe("the host page draws them (#345)", () => {
  it("the count on each registration and Move pins here, live for its owner and a maintainer; the card hidden from a visitor", async () => {
    for (const who of ["m1", "m2"]) {
      const d = await drawn(studio, who);
      expect(d.nodes["#hp-legacy"].hidden).toBe(false);
      const kv = d.nodes["#hp-legacy-kv"].innerHTML as string;
      expect(kv).toContain("<dt>Pinned</dt><dd>5 queued tasks — ");
      expect(kv).toContain('href="/worker/m1-pool-aarch64">m1-pool-aarch64</a> 2');
      expect(d.nodes["#hp-legacy-ops"].innerHTML).toMatch(/data-host-act="move-pins">/);
    }
    expect((await drawn(studio)).nodes["#hp-legacy"].hidden).toBe(true);
  });
});

describe("Move pins here: who, and on which host (#345)", () => {
  it("refuses nobody, a contributor, a token and a write from another page, with nothing moved", async () => {
    expect((await call("POST", `/hosts/${studio}/pins`, { reason: "the Studio switch" })).status).toBe(401);
    const bob = await call("POST", `/hosts/${studio}/pins`, { reason: "the Studio switch" }, page("bob"));
    expect(bob.status).toBe(403);
    expect(bob.json.error).toContain("only m1 or a maintainer moves pinned tasks onto studio");
    const token = await call("POST", `/hosts/${studio}/pins`, { reason: "the Studio switch" }, { token: "omc_m1" });
    expect(token.status).toBe(403);
    expect(token.json.code).toBe("web_only");
    expect((await call("POST", `/hosts/${studio}/pins`, { reason: "the Studio switch" }, { session: "m1", origin: false })).status).toBe(403);
    const reason = await call("POST", `/hosts/${studio}/pins`, {}, page("m1"));
    expect(reason.status).toBe(400);
    expect(reason.json.code).toBe("reason");
    expect((await taskOf(T.native)).pinned_to).toBe("m1-pool-aarch64");
    expect(await pinsLines()).toEqual([]);
  });

  it("refuses a host that waits for its Confirm, one capped at 0, one drained and one that does not claim now", async () => {
    await env.DB.prepare("INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, arch) VALUES ('h_pins000009', 'm1', 1001, 'waiting', ?, 'pending-owner', 'aarch64')").bind(toB64url(crypto.getRandomValues(new Uint8Array(32)))).run();
    const waiting = await call("POST", "/hosts/h_pins000009/pins", { reason: "the Studio switch" }, page("m1"));
    expect(waiting.status).toBe(409);
    expect(waiting.json.error).toContain("waits for its owner's Confirm");
    await env.DB.prepare("UPDATE hosts SET pool_cap_units = 0 WHERE id = ?").bind(studio).run();
    const capped = await call("POST", `/hosts/${studio}/pins`, { reason: "the Studio switch" }, page("m1"));
    expect(capped.status).toBe(409);
    expect(capped.json.error).toContain("pool cap is 0: raise it first");
    await env.DB.prepare("UPDATE hosts SET pool_cap_units = NULL WHERE id = ?").bind(studio).run();
    await env.DB.prepare("UPDATE build_workers SET drained_at = ?, drained_by = 'm1' WHERE id = 'm1-studio'").bind(iso(Date.now())).run();
    const drained = await call("POST", `/hosts/${studio}/pins`, { reason: "the Studio switch" }, page("m2"));
    expect(drained.status).toBe(409);
    expect(drained.json.error).toContain("registration is drained: resume it first");
    await env.DB.prepare("UPDATE build_workers SET drained_at = NULL, drained_by = NULL WHERE id = 'm1-studio'").run();
    // Its dispatcher last claimed ten minutes ago: a task moved onto it would wait — nothing moves, each task said with why.
    await env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id = 'm1-studio'").bind(iso(Date.now() - 10 * MIN)).run();
    const quiet = await call("POST", `/hosts/${studio}/pins`, { reason: "the Studio switch" }, page("m1"));
    expect(quiet.status).toBe(409);
    expect(quiet.json.code).toBe("not_claiming");
    expect(quiet.json.error).toMatch(/studio takes nothing now — it has not claimed in the last \d+ minutes: nothing was moved/);
    expect(quiet.json.stay).toHaveLength(5);
    await env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id = 'm1-studio'").bind(iso(Date.now())).run();
    for (const id of Object.values(T)) expect((await taskOf(id)).params ?? "").not.toContain("repinned");
    expect(await pinsLines()).toEqual([]);
  });
});

describe("Move pins here: what moves, what stays, and the switch's drain (#345, design v2 §21.1 step 4)", () => {
  it("moves what the host could run onto its registration, says each on its page and the journal, and leaves the rest with why", async () => {
    // The pool's cap leaves two builds: the size-3 build would never fit, while m2's host keeps size 3 alive.
    await env.DB.prepare("UPDATE hosts SET pool_cap_units = 5 WHERE id = ?").bind(studio).run();
    await env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id IN ('m1-studio', 'm2-vps')").bind(iso(Date.now())).run();
    const before = Date.now();
    const r = await call("POST", `/hosts/${studio}/pins`, { reason: "the Studio switch, before the drain" }, page("m2"));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.moved.sort()).toEqual([T.native, T.emulated].sort());
    const stay = new Map((r.json.stay as { task: number; from: string; why: string }[]).map((s) => [s.task, s]));
    expect([...stay.keys()].sort()).toEqual([T.needsNative, T.ownCopy, T.big].sort());
    expect(stay.get(T.needsNative)).toMatchObject({ from: "m1-review-x86_64", why: "it needs a native x86_64 lane, and this host runs x86_64 emulated" });
    expect(stay.get(T.ownCopy)!.why).toContain("is not built on its requester's host (D35)");
    expect(stay.get(T.big)!.why).toContain("could not hold it once idle at its size");
    // On the moved tasks: the host's registration, and a word for their pages.
    for (const [id, from] of [[T.native, "m1-pool-aarch64"], [T.emulated, "m1-review-x86_64"]] as const) {
      const t = await taskOf(id);
      expect(t).toMatchObject({ status: "queued", pinned_to: "m1-studio" });
      const p = await paramsOf(id);
      expect(p.repinned).toMatchObject({ from, to: "m1-studio", by: "m2" });
      expect(Date.parse(p.repinned.at)).toBeGreaterThanOrEqual(before - 1000);
    }
    // What stays and what is never touched: where it was.
    expect((await taskOf(T.needsNative)).pinned_to).toBe("m1-review-x86_64");
    expect((await taskOf(T.ownCopy)).pinned_to).toBe("m1-community-aarch64");
    expect((await taskOf(T.big)).pinned_to).toBe("m1-pool-aarch64");
    expect((await taskOf(T.othersPin)).pinned_to).toBe("m2-cli-aarch64");
    expect(await taskOf(T.leased)).toMatchObject({ status: "leased", pinned_to: "m1-pool-aarch64" });
    expect((await taskOf(T.revokedPin)).pinned_to).toBe("m1-old-aarch64");
    // One journal line: who, why, what moved and what stayed.
    const lines = await pinsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].status).toBe("ok");
    expect(lines[0].summary).toContain("studio of m1: m2 moved 2 queued tasks pinned to m1's legacy registrations onto its registration m1-studio");
    expect(lines[0].summary).toContain(`#${T.native} from m1-pool-aarch64`);
    expect(lines[0].summary).toContain("3 queued tasks stay pinned, for their registration's drain to send to the queue");
    expect(lines[0].summary).toContain(": the Studio switch, before the drain");
    const payload = JSON.parse(lines[0].payload);
    expect(payload).toMatchObject({ host: studio, worker: "m1-studio", owner: "m1", by: "m2", via: "web", action: "pins", reason: "the Studio switch, before the drain" });
    expect(payload.moved.sort()).toEqual([T.native, T.emulated].sort());
    expect(payload.stay).toHaveLength(3);
    // The page's count: what is left on the legacy registrations.
    expect((await call("GET", `/hosts/${studio}`, undefined, page("m1"))).json.host.legacy_pins.tasks).toBe(3);
    // A second press moves nothing more, and says why each stays.
    const again = await call("POST", `/hosts/${studio}/pins`, { reason: "the Studio switch, again" }, page("m1"));
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("nothing_to_move");
    expect(again.json.error).toContain("none of the 3 queued tasks pinned to m1's legacy registrations can move onto studio");
    expect(await pinsLines()).toHaveLength(1);
    // The task's own read carries the word its page draws.
    expect((await call("GET", `/factory/tasks/${T.native}`)).json.task.params.repinned).toMatchObject({ from: "m1-pool-aarch64", to: "m1-studio" });
  });

  it("the switch drains the legacy registrations, and the drain's sweep sends what stayed to the queue: none waits on a drained one", async () => {
    for (const id of ["m1-pool-aarch64", "m1-review-x86_64", "m1-community-aarch64"]) expect((await drain(id, "m1")).status, id).toBe(201);
    // The sweep three minutes on (orders.ts UNPIN_AFTER_DRAIN_MINUTES).
    await sweepOrders(env, Date.now() + 4 * MIN);
    for (const id of [T.needsNative, T.ownCopy, T.big]) {
      const t = await taskOf(id);
      expect(t.pinned_to, `#${id}`).toBeNull();
      expect(JSON.parse(t.params).unpinned.from).toMatch(/^m1-/);
    }
    // What moved stays on the host; nothing queued is pinned to a drained registration of m1's.
    for (const id of [T.native, T.emulated]) expect((await taskOf(id)).pinned_to).toBe("m1-studio");
    const stranded = await env.DB.prepare("SELECT t.id FROM build_tasks t JOIN build_workers w ON w.id = t.pinned_to WHERE t.status = 'queued' AND w.owner = 'm1' AND w.kind = 'legacy' AND w.drained_at IS NOT NULL").all();
    expect(stranded.results).toEqual([]);
    // The page's count follows.
    expect((await call("GET", `/hosts/${studio}`, undefined, page("m1"))).json.host.legacy_pins).toEqual({ tasks: 0, workers: [] });
  });

  it("the host claims what moved onto it", async () => {
    await env.DB.prepare("UPDATE hosts SET pool_cap_units = NULL WHERE id = ?").bind(studio).run();
    const c = await hostClaim("m1-studio");
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.task.id).toBe(T.native);
    expect(await taskOf(T.native)).toMatchObject({ status: "leased", lease_owner: "m1-studio" });
  });

  it("the way back: the host's registration drained, what was moved onto it goes to the queue, and a resumed legacy registration claims on the pool's release", async () => {
    expect((await drain("m1-studio", "m1")).status).toBe(201);
    await sweepOrders(env, Date.now() + 4 * MIN);
    const t = await taskOf(T.emulated);
    expect(t.pinned_to).toBeNull();
    expect(JSON.parse(t.params)).toMatchObject({ repinned: { from: "m1-review-x86_64", to: "m1-studio" }, unpinned: { from: "m1-studio" } });
    // A drained host moves nothing more onto itself.
    expect((await call("POST", `/hosts/${studio}/pins`, { reason: "the way back" }, page("m1"))).json.error).toContain("registration is drained");
    // The legacy registrations resume and claim; their updater kept them on the pool's release, so the gate hands them work (no 426).
    for (const id of ["m1-pool-aarch64", "m1-review-x86_64", "m1-community-aarch64"]) expect((await resume(id, "m1")).status, id).toBe(201);
    const onRelease = { ...env, POOL_VERSION: "v1.20.0", POOL_DEPLOYED_AT: iso(Date.now() - 3 * 60 * MIN) } as typeof env;
    const fresh = await seedTask({ arch: "aarch64", pinned_to: null });
    const back = await legacyClaim("m1-pool-aarch64", "aarch64", "v1.20.0", onRelease);
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    expect(back.json.task.id).toBe(fresh);
    // One still on the release before, past the grace, is handed nothing: what the legacy updater keeps it from.
    const behind = await legacyClaim("m1-community-aarch64", "aarch64", "v1.19.0", onRelease);
    expect(behind.status).toBe(426);
  });
});

describe("what the planner reads (#345)", () => {
  it("every new statement by its index, never a scan of the tables", async () => {
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const now = iso(Date.now());
    const cases: [string, string, unknown[], RegExp][] = [
      ["the tasks pinned to an owner's legacy registrations: the queue by its index", LEGACY_PINS_SQL, ["m1"], /SEARCH c USING INDEX idx_build_tasks_(queue|lease|kind) \(status=\?/],
      ["their counts, the same walk", LEGACY_PIN_COUNTS_SQL, ["m1"], /SEARCH build_tasks USING INDEX idx_build_tasks_(queue|lease) \(status=\?\)/],
      ["the move, by key", REPIN_SQL, ["m1-studio", "m1", now, "[1]", "m1"], /SEARCH build_tasks USING INTEGER PRIMARY KEY \(rowid=\?\)/],
      ["what one move took, by key", REPINNED_SQL, ["[1]", "m1-studio", now], /SEARCH build_tasks USING INTEGER PRIMARY KEY \(rowid=\?\)/],
    ];
    for (const [what, sql, args, want] of cases) {
      const p = await plan(sql, args);
      expect(p, what).toMatch(want);
      expect(p, what).not.toMatch(/SCAN build_tasks(?! USING)/);
    }
  });
});
