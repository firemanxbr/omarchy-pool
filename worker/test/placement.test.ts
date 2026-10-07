/**
 * Placement through the Worker (#339, epic #307, design v2 §8.4, §9.5;
 * D35, D36), inside workerd with a real D1, maintainers' hosts claiming as
 * their dispatchers do (their owner on the registration, their model in the
 * claim's `agent`) and real passkeys (the software authenticator):
 *
 * - the requester-host rule: a review rebuild of m1's package is handed to no
 *   host of m1's while m2's host has a lane allowed for it — m2's, however
 *   busy (its disk filled by its builds, below the minimum for that alone,
 *   its builds held back for disk), an emulated lane included; when only
 *   m1's hosts have one (a single maintainer's hosts, `needs_native` with
 *   m2's lane emulated, m2's host too small for the size its page asks,
 *   capped at 0, or asleep, #329) it is held, Review says so at once with
 *   Release to any host for another maintainer (the server's reason for
 *   anyone else), and after m2 releases it with their passkey — on the
 *   task, the journal and the record — m1's host takes it at its next
 *   claim; a claim never pins a rebuild to its requester's host, and
 *   another architecture's same-agent pick is another maintainer's worker
 *   whichever claimed last;
 * - the second opinion: with one provider an audit goes to a host other than
 *   its builder's and a publish-bound one records `independent: none`, a
 *   contributor build's `host`; the Studio's legacy role containers are one
 *   machine (`none`); with two providers a publish-bound audit is
 *   handed only to the other model, however long, and records `model`; a host
 *   with another model last seen 23 hours ago still holds it, 25 hours ago no
 *   longer, and one whose agent has failed for a day, or that is below the
 *   minimum or behind the release, holds nothing however often it claims;
 *   more than HEAD_LIMIT of them waiting hide no other audit; an audit back
 *   in the queue says no independence;
 * - Review's view (the page's own script): the release line and its button
 *   for each viewer, the audit's independence beside its verdict on both
 *   panes;
 * - the migration's CHECK, and every new statement through an index.
 *
 * Tokens: workers omw_<id>, maintainers' sessions oms_<login>, their CLI omc_<login>.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { applyGovernance } from "../src/governance";
import { sha256Hex } from "../src/routes/contributors";
import { unitsOf } from "../src/hosts";
import { HEAD_LIMIT, LANE_HEAD_SQL, LOST_LEASE_SQL, MODELS_SQL, NEUTRAL_HEAD_SQL, PLACEMENTS_SQL, SAME_MODEL_HEAD_SQL } from "../src/routes/factory";
import { REQUEUE_SQL } from "../src/lease";
import { ANY_HOST_SQL, SAME_AGENT_SQL } from "../src/routes/review";
import { SUBJECT } from "../src/routes/passkeys";
import { settleTargets } from "../src/targets";
import { toB64url } from "../src/webauthn";
import { runScript, scriptOf, type Ran } from "./fixture";
import { assert as answer, createAuthenticator, register } from "./soft-authenticator.mjs";

/** localhost: where a passkey works (relyingParty), as wrangler dev's. */
const ORIGIN = "http://localhost:8787";
const MIN = 60000;
const HOUR = 60 * MIN;

interface Res { status: number; json: any }
async function call(method: string, path: string, o: { token?: string; session?: string; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.session) { headers.cookie = `omc=oms_${o.session}`; headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path.startsWith("/auth/") ? "" : "/api/v1"}${path}`, { method, headers, body: o.body === undefined ? (o.session && method === "POST" ? "{}" : undefined) : JSON.stringify(o.body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

type Lane = { arch: string; mode: "native" | "emulated"; via?: string };
interface Box { cpus: number; mem_gb: number; lanes: Lane[] }
const capOf = (b: Box) => ({ cpus: b.cpus, mem_gb: b.mem_gb, disk_free_gb: { work: 410, engine: 220 }, units: unitsOf({ cpus: b.cpus, mem_gb: b.mem_gb, units: null }), job_reserved: 1, agent_slots: 2, lanes: b.lanes });
const ARM: Box = { cpus: 8, mem_gb: 16, lanes: [{ arch: "aarch64", mode: "native" }] };
const STUDIO: Box = { cpus: 12, mem_gb: 32, lanes: [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated", via: "qemu" }] };
const VPS86: Box = { cpus: 8, mem_gb: 16, lanes: [{ arch: "x86_64", mode: "native" }] };
const GITHUB: Record<string, number> = { m1: 1001, m2: 1002, m3: 1003 };
const CLAUDE = "anthropic/claude-a";
const GPT = "openai/gpt-b";

const boxes = new Map<string, { box: Box; model: string }>();
let hostSeq = 0;
/** A legacy registration of the Studio's compose set (until #343): its owner's, one role, its agent's model. */
async function seedLegacy(id: string, owner: string, trust: "project" | "community", kinds: string[]): Promise<void> {
  await env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, kinds, agent, agent_status) VALUES (?, 'aarch64', ?, ?, 'shared', ?, ?, ?, ?, ?, 'ok')")
    .bind(id, owner, await sha256Hex(`omw_${id}`), trust, trust === "project" ? owner : null, new Date().toISOString(), JSON.stringify(kinds), CLAUDE).run();
}
/** A legacy registration's claim, as the worker image sends it: its arch, its kinds, its agent. */
const legacyClaim = (id: string, kinds: string[]) => call("POST", "/factory/claim", { token: `omw_${id}`, body: { arch: "aarch64", kinds, agent: CLAUDE, agent_status: "ok" } });
/** A maintainer's host, active, with its registration — its owner's, the model its claims say — seen `ago` minutes ago. */
async function seedHost(id: string, owner: string, box: Box, model = CLAUDE, ago = 0): Promise<void> {
  const hostId = `h_p${String(++hostSeq).padStart(9, "0")}`;
  const cap = capOf(box);
  const native = box.lanes.find((l) => l.mode === "native")!.arch;
  const seen = new Date(Date.now() - ago * MIN).toISOString();
  boxes.set(id, { box, model });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, arch, capacity, lanes, units, agent_slots, disk_free, worker_id, confirmed_at, last_seen)
                    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 2, ?, ?, ?, ?)`)
      .bind(hostId, owner, GITHUB[owner], id, toB64url(crypto.getRandomValues(new Uint8Array(32))), native, JSON.stringify({ ...cap, below_minimum: null }), JSON.stringify(box.lanes), unitsOf(cap), JSON.stringify(cap.disk_free_gb), id, seen, seen),
    env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen, kind, host_id, kinds, agent, agent_status) VALUES (?, ?, ?, ?, 'dedicated', 'project', ?, ?, 'host', ?, '[\"build\",\"trial\",\"audit\"]', ?, 'ok')")
      .bind(id, native, owner, await sha256Hex(`omw_${id}`), owner, seen, hostId, model),
  ]);
}

let seq = 0;
/** A claim as the host's dispatcher sends it: the leases it holds, its capacity, and its probe sidecar's provider and model. */
const claim = (id: string, leases: { task: number; gen: string }[] = []) => {
  const { box, model } = boxes.get(id)!;
  const [provider, name] = model.split("/");
  return call("POST", "/factory/claim", { token: `omw_${id}`, body: {
    arch: box.lanes.find((l) => l.mode === "native")!.arch, version: "v1.0.2", hostname: id, kinds: ["build", "trial", "audit"], claim_id: `c_place${String(++seq).padStart(8, "0")}`, want: 1,
    leases, capacity: capOf(box), agent: { provider, model: name, probe: "ok", checked_at: "2026-10-01T00:00:00Z" },
  } });
};
const lease = (c: Res) => ({ task: c.json.task.id as number, gen: c.json.task.lease_gen as string });

/** A package `requester` asked for, its contributor's build staged, and the project's copy of it — the review rebuild — queued. */
async function seedCopy(requester: string, o: { arch?: string; params?: Record<string, unknown>; pin?: string } = {}): Promise<{ name: string; contributor: number; copy: number }> {
  const name = `placed${++seq}`, arch = o.arch ?? "aarch64";
  await env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status, project, source, description, license) VALUES (?, ?, ?, ?, 'staged', ?, ?, 'a package placement places', 'MIT')")
    .bind(name, requester, `https://${name}.example`, JSON.stringify([arch]), `https://${name}.example`, `https://${name}.example/${name}-1.tar.gz`).run();
  const contributor = (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, lease_owner, staged_prefix, finished_at)
     VALUES (?, ?, '1.0-1', ?, 'contributor', 100, 'staged', 0, 'community', ?, 'build', 'contrib-box', ?, ?) RETURNING id`,
  ).bind(name, arch, `draft:https://${name}.example@1`, requester, `staging/${requester}/${name}/0/`, new Date().toISOString()).first<{ id: number }>())!.id;
  const copy = (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, pinned_to)
     VALUES (?, ?, '1.0-1', ?, 'project build asked by m3', 30, 'queued', 0, 'project', ?, 'build', ?, ?) RETURNING id`,
  ).bind(name, arch, `review:${contributor}`, requester, JSON.stringify({ review: contributor, by: "m3", agent: null, ...o.params }), o.pin ?? null).first<{ id: number }>())!.id;
  return { name, contributor, copy };
}

/** A staged build `by` built — the project's copy (publish-bound) or a contributor's — and its audit queued, as handleComplete queues it. */
async function seedAudit(by: string, o: { publish: boolean; builtWith?: string | null }): Promise<{ built: number; audit: number }> {
  const name = `audited${++seq}`;
  const built = (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, lease_owner, staged_prefix, finished_at)
     VALUES (?, 'aarch64', '1.0-1', ?, 'built', 30, 'staged', 0, ?, 'alice', 'build', ?, ?, ?, ?) RETURNING id`,
  ).bind(name, o.publish ? "review:1" : `draft:https://${name}.example@1`, o.publish ? "project" : "community", o.publish ? JSON.stringify({ review: 1, built_with: o.builtWith ?? null }) : null, by, `staging/x/${name}/0/`, new Date().toISOString()).first<{ id: number }>())!.id;
  const audit = (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params) VALUES (?, 'aarch64', '1.0-1', ?, ?, 40, 'queued', 0, 'project', NULL, 'audit', ?) RETURNING id`,
  ).bind(name, `staging:${built}`, `staged as task ${built}`, JSON.stringify({ task: built, name, owner: "alice", arch: "aarch64" })).first<{ id: number }>())!.id;
  return { built, audit };
}

const taskOf = (id: number) => env.DB.prepare("SELECT status, lease_owner, lane, independent, params FROM build_tasks WHERE id = ?").bind(id).first<any>();
/** The review list's row of a contributor's build, as `as` reads it: its project build and that build's placement. */
async function reviewRow(contributor: number, as?: string): Promise<any> {
  const r = await call("GET", "/factory/review", as ? { session: as } : {});
  expect(r.status).toBe(200);
  return r.json.staged.find((s: any) => s.id === contributor);
}

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

beforeAll(async () => {
  const people: [string, string, number][] = [["m1", "maintainer", 1001], ["m2", "maintainer", 1002], ["m3", "maintainer", 1003], ["alice", "contributor", 2001]];
  await env.DB.batch(await Promise.all(people.map(async ([l, role, g]) => env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES (?, ?, ?, ?, ?)").bind(l, await sha256Hex(`omc_${l}`), await sha256Hex(`oms_${l}`), role, g))));
  await applyGovernance(env, ["m1", "m2", "m3"], "sha-placement");
  for (const m of ["m2", "m3"]) await registerFor(m);
});

afterEach(async () => {
  vi.useRealTimers();
  await env.DB.batch([
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE status IN ('queued', 'leased')"),
    env.DB.prepare("UPDATE build_workers SET last_seen = '2000-01-01T00:00:00.000Z'"),
  ]);
});

describe("the D1 migration (0047)", () => {
  it("adds build_tasks.independent, one of model, host and none", async () => {
    const { audit } = await seedAudit("nobody", { publish: false });
    for (const ok of ["model", "host", "none"]) await env.DB.prepare("UPDATE build_tasks SET independent = ? WHERE id = ?").bind(ok, audit).run();
    await expect(env.DB.prepare("UPDATE build_tasks SET independent = 'provider' WHERE id = ?").bind(audit).run()).rejects.toThrow(/CHECK/);
  });
});

describe("the requester-host rule (D35): the project's copy is not built on its requester's host", () => {
  it("a review rebuild of m1's own package is handed to no host of m1's while m2's host has a lane for it; m2's takes it once free, and Review offers no release", async () => {
    await seedHost("m1-studio", "m1", STUDIO);
    await seedHost("m2-arm", "m2", ARM);
    // m2's host is full: three builds of the pool's, held for hours.
    const fill: number[] = [];
    for (let i = 0; i < 3; i++) {
      fill.push((await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, kind) VALUES (?, 'aarch64', '1', 'x', 'fill', 200, 'queued', 0, 'project', 'build') RETURNING id").bind(`fill${++seq}`).first<{ id: number }>())!.id);
    }
    const held: { task: number; gen: string }[] = [];
    for (let i = 0; i < 3; i++) held.push(lease(await claim("m2-arm", held)));
    expect(held.map((l) => l.task).sort()).toEqual(fill.sort());
    const { contributor, copy } = await seedCopy("m1");
    // m1's host claims and is handed nothing — not the copy, whatever its free units; m2's host is busy.
    expect((await claim("m1-studio")).status).toBe(204);
    expect((await claim("m2-arm", held)).status).toBe(204);
    expect((await taskOf(copy)).status).toBe("queued");
    // Review: m2's host has a lane allowed for it — it waits for that host, not for a release.
    const row = await reviewRow(contributor, "m2");
    expect(row.project_build).toMatchObject({ id: copy, status: "queued" });
    expect(row.project_build.placement).toMatchObject({ held: false, others: ["m2-arm"], mine: ["m1-studio"], requesters: ["m1"], released: null, any_host: { ok: false } });
    expect(row.project_build.placement.any_host.why).toMatch(/^m2-arm — another maintainer's — can build it/);
    // Its builds fill its disk — its report below the signed minimum for that alone — and its dispatcher, holding builds back for disk,
    // claims trials and audits only: busy, not gone. Review still waits for that host, and offers no release.
    const report = (free: { work: number; engine: number }, below: string | null) => env.DB.batch([
      env.DB.prepare("UPDATE hosts SET disk_free = ?, capacity = json_set(capacity, '$.disk_free_gb', json(?), '$.below_minimum', ?) WHERE worker_id = 'm2-arm'").bind(JSON.stringify(free), JSON.stringify(free), below),
      env.DB.prepare("UPDATE build_workers SET kinds = ? WHERE id = 'm2-arm'").bind(JSON.stringify(below ? ["trial", "audit"] : ["build", "trial", "audit"])),
    ]);
    await report({ work: 24, engine: 160 }, "below the minimum to join: 24 GB free on the work root (60 needed)");
    expect((await reviewRow(contributor, "m2")).project_build.placement).toMatchObject({ held: false, others: ["m2-arm"], mine: ["m1-studio"], any_host: { ok: false } });
    expect((await claim("m1-studio")).status).toBe(204);
    // m2's builds end, and its report says the disk they held is free: its host takes the copy.
    await report({ work: 410, engine: 220 }, null);
    await env.DB.prepare("UPDATE build_tasks SET status = 'done' WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(fill)).run();
    const c = await claim("m2-arm");
    expect(c.json.task).toMatchObject({ id: copy, lease_owner: "m2-arm", lane: "native", independent: null });
  });

  it("a rebuild whose requesters are not known — no owner, its contributor's build gone — is any host's: the rule hides nothing else", async () => {
    await seedHost("m1-anon", "m1", ARM);
    const { copy } = await seedCopy("m1", { params: { review: 999999 } });
    await env.DB.prepare("UPDATE build_tasks SET owner = NULL WHERE id = ?").bind(copy).run();
    const c = await claim("m1-anon");
    expect(c.json.task).toMatchObject({ id: copy, lease_owner: "m1-anon" });
  });

  it("another maintainer's host that could never hold the copy — too small for the size its page asks, or its pool cap 0 — is none to wait for: held at once, the release offered; released, the requester's host builds it at that size", async () => {
    await seedHost("m1-big", "m1", STUDIO);
    await seedHost("m2-small", "m2", ARM);
    const { name, contributor, copy } = await seedCopy("m1");
    // Size 4 on its page: m1's Studio holds it (11 units), m2's 7-unit host never does.
    await env.DB.prepare("UPDATE factory_packages SET size = 4 WHERE name = ?").bind(name).run();
    expect((await claim("m2-small")).status).toBe(204);
    expect((await claim("m1-big")).status).toBe(204);
    expect((await reviewRow(contributor, "m3")).project_build.placement).toMatchObject({ held: true, others: [], mine: ["m1-big"], any_host: { ok: true, why: null } });
    const r = await call("POST", `/factory/tasks/${copy}/any-host`, { session: "m3", body: { assertion: await assertion("m3", `any-host:${copy}`) } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await claim("m1-big")).json.task).toMatchObject({ id: copy, lease_owner: "m1-big", size: 4 });
    // A pool cap of 0 on m2's host ("it claims nothing"): a size-1 copy is held as well.
    const small = await seedCopy("m1");
    expect((await reviewRow(small.contributor, "m3")).project_build.placement).toMatchObject({ held: false, others: ["m2-small"] });
    await env.DB.prepare("UPDATE hosts SET pool_cap_units = 0 WHERE worker_id = 'm2-small'").run();
    expect((await reviewRow(small.contributor, "m3")).project_build.placement).toMatchObject({ held: true, others: [], mine: ["m1-big"], any_host: { ok: true } });
  });

  it("the size the pool learned from its package's builds (#330) counts as the page's: a host too small for it is none to wait for", async () => {
    await seedHost("m1-studio-l", "m1", STUDIO);
    await seedHost("m2-arm-l", "m2", ARM);
    const { name, contributor } = await seedCopy("m1");
    // Learned 4 (the recipe on main ran out of memory at 3), no maintainer's size: only m1's Studio holds it, as with a size 4 set on
    // the page — m2's 7-unit host takes nothing, m1's own waits as the requester's.
    await env.DB.prepare("UPDATE factory_packages SET learned_size = 4, learned_why = 'oom' WHERE name = ?").bind(name).run();
    expect((await claim("m2-arm-l")).status).toBe(204);
    expect((await claim("m1-studio-l")).status).toBe(204);
    expect((await reviewRow(contributor, "m3")).project_build.placement).toMatchObject({ held: true, others: [], mine: ["m1-studio-l"], any_host: { ok: true } });
    // Decayed to 2 (four units): m2's host holds it again.
    await env.DB.prepare("UPDATE factory_packages SET learned_size = 2, learned_why = 'decay' WHERE name = ?").bind(name).run();
    expect((await reviewRow(contributor, "m3")).project_build.placement).toMatchObject({ held: false, others: ["m2-arm-l"], mine: ["m1-studio-l"] });
  });

  it("another maintainer's emulated lane counts, at once — no wait for the requester's native host; with needs_native only the requester's host has a lane, and the rebuild is held", async () => {
    await seedHost("m1-vps86", "m1", VPS86);
    await seedHost("m2-studio", "m2", STUDIO);
    const { copy } = await seedCopy("m1", { arch: "x86_64" });
    expect((await claim("m1-vps86")).status).toBe(204);
    const c = await claim("m2-studio");
    expect(c.json.task).toMatchObject({ id: copy, lane: "emulated" });
    // Sent back by an emulated lane (needs_native): m2's lane is not allowed for it, m1's native host is the only one — held.
    const sent = await seedCopy("m1", { arch: "x86_64", params: { needs_native: 1 } });
    expect((await claim("m2-studio", [lease(c)])).status).toBe(204);
    expect((await claim("m1-vps86")).status).toBe(204);
    const row = await reviewRow(sent.contributor, "m3");
    expect(row.project_build.placement).toMatchObject({ held: true, others: [], mine: ["m1-vps86"], any_host: { ok: true, why: null } });
  });

  it("another maintainer's host whose agent says it sleeps (#329) is none to wait for: held at once, the release offered, no audit left to it; awake again, it takes the copy at its next claim", async () => {
    await seedHost("m1-desk", "m1", STUDIO);
    await seedHost("m2-mac", "m2", ARM);
    const { contributor, copy } = await seedCopy("m1");
    // m2's Mac is awake: the copy waits for it.
    expect((await reviewRow(contributor, "m3")).project_build.placement).toMatchObject({ held: false, others: ["m2-mac"], mine: ["m1-desk"] });
    // Its agent's report says it sleeps (as POST /hosts/self/report writes it): zero free units — its dispatcher's last claim is handed
    // nothing, and the copy is held at once, with the release offered.
    const asleep = (at: string | null) => env.DB.prepare("UPDATE hosts SET asleep_at = ?, reported_at = ? WHERE worker_id = 'm2-mac'").bind(at, new Date().toISOString()).run();
    await asleep(new Date().toISOString());
    expect((await claim("m2-mac")).status).toBe(204);
    expect((await claim("m1-desk")).status).toBe(204);
    expect((await reviewRow(contributor, "m3")).project_build.placement).toMatchObject({ held: true, others: [], mine: ["m1-desk"], any_host: { ok: true, why: null } });
    // Nor is it a machine an audit is left to: the builder takes a contributor build's audit at once.
    const { audit } = await seedAudit("m1-desk", { publish: false });
    expect((await claim("m1-desk")).json.task).toMatchObject({ id: audit, lease_owner: "m1-desk", independent: "none" });
    // Its agent says it woke: not held any more, and its next claim takes the copy.
    await asleep(null);
    expect((await reviewRow(contributor, "m3")).project_build.placement).toMatchObject({ held: false, others: ["m2-mac"] });
    expect((await claim("m2-mac")).json.task).toMatchObject({ id: copy, lease_owner: "m2-mac", lane: "native" });
  });

  it("a single maintainer's hosts: held at once, Review offers m2 the release (the reason to anyone else); released with m2's passkey — on the task, the journal and the record — m1's host takes it", async () => {
    await seedHost("m1-solo", "m1", STUDIO);
    await seedHost("m1-arm2", "m1", ARM);
    const { name, contributor, copy } = await seedCopy("m1");
    // m2's package is m1's hosts' at once.
    const theirs = await seedCopy("m2");
    const first = await claim("m1-solo");
    expect(first.json.task).toMatchObject({ id: theirs.copy });
    expect((await claim("m1-arm2")).status).toBe(204);
    expect((await claim("m1-solo", [lease(first)])).status).toBe(204);
    // At once, not after a timeout: held, and Review says so with the release for another maintainer.
    const asM2 = await reviewRow(contributor, "m2");
    expect(asM2.project_build.placement).toEqual({ held: true, others: [], mine: ["m1-solo", "m1-arm2"], requesters: ["m1"], released: null, any_host: { ok: true, why: null } });
    const why = async (as?: string) => (await reviewRow(contributor, as)).project_build.placement.any_host;
    expect(await why("m1")).toEqual({ ok: false, why: `you brought ${name} — another maintainer releases its rebuild to any host, as another decides on it` });
    expect(await why("alice")).toMatchObject({ ok: false, why: expect.stringMatching(/maintainer/) });
    expect(await why()).toMatchObject({ ok: false, why: expect.stringMatching(/sign in/i) });
    // The door refuses the same way; a maintainer without a passkey's answer, a token, are refused; nothing is released.
    expect(await call("POST", `/factory/tasks/${copy}/any-host`)).toMatchObject({ status: 401 });
    expect(await call("POST", `/factory/tasks/${copy}/any-host`, { session: "alice", body: {} })).toMatchObject({ status: 403, json: { code: "maintainer_only" } });
    expect(await call("POST", `/factory/tasks/${copy}/any-host`, { session: "m1", body: {} })).toMatchObject({ status: 403, json: { code: "conflict_of_interest" } });
    expect(await call("POST", `/factory/tasks/${copy}/any-host`, { session: "m3", body: {} })).toMatchObject({ status: 403, json: { code: "passkey_required" } });
    expect(await call("POST", `/factory/tasks/${copy}/any-host`, { token: "omc_m3", body: {} })).toMatchObject({ status: 403, json: { code: "session_only" } });
    // An answer made for another act releases nothing.
    expect(await call("POST", `/factory/tasks/${copy}/any-host`, { session: "m2", body: { assertion: await assertion("m2", `approve:${copy}`) } })).toMatchObject({ status: 403, json: { code: "challenge" } });
    expect(JSON.parse((await taskOf(copy)).params).any_host).toBeUndefined();
    // m2 releases it, with their passkey for exactly this rebuild.
    const r = await call("POST", `/factory/tasks/${copy}/any-host`, { session: "m2", body: { assertion: await assertion("m2", `any-host:${copy}`) } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ task: copy, any_host: { by: "m2" }, hosts: ["m1-solo", "m1-arm2"], passkey: expect.stringMatching(/^pk_/) });
    expect(r.json.record).toMatch(/any-host/);
    expect(JSON.parse((await taskOf(copy)).params).any_host).toEqual({ by: "m2", at: r.json.any_host.at, passkey: r.json.passkey });
    const line = await env.DB.prepare("SELECT status, summary, payload FROM events WHERE kind = 'review' AND json_extract(payload, '$.action') = 'any_host' ORDER BY id DESC LIMIT 1").first<{ status: string; summary: string; payload: string }>();
    expect(line!.summary).toMatch(new RegExp(`^${name} for aarch64 \\(task ${copy}\\): released to any host by m2(?: with a passkey registered just now)? — only m1's hosts can build it`));
    expect(JSON.parse(line!.payload)).toMatchObject({ task: copy, by: "m2", via: "web", passkey: r.json.passkey, requesters: ["m1"], hosts: ["m1-solo", "m1-arm2"], record: r.json.record });
    // Once: a second release is refused, and the list says who released it.
    expect(await call("POST", `/factory/tasks/${copy}/any-host`, { session: "m3", body: { assertion: await assertion("m3", `any-host:${copy}`) } })).toMatchObject({ status: 409 });
    expect((await reviewRow(contributor, "m3")).project_build.placement).toMatchObject({ held: false, released: { by: "m2", at: r.json.any_host.at }, any_host: { ok: false, why: "released to any host by m2 already" } });
    // m1's host takes it at its next claim.
    const c = await claim("m1-arm2");
    expect(c.json.task).toMatchObject({ id: copy, lease_owner: "m1-arm2" });
  });

  it("a claim never pins the project's copy to its requester's host: a maintainer naming one is refused, and another architecture's same-agent pick is left unpinned", async () => {
    await seedHost("m1-pin", "m1", ARM);
    const { contributor } = await seedCopy("m1");
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE kind = 'build' AND trust = 'project' AND params LIKE ?").bind(`%"review":${contributor}%`).run();
    const r = await call("POST", `/factory/tasks/${contributor}/build`, { token: "omc_m2", body: { worker: "m1-pin" } });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json).toMatchObject({ code: "requester_host", error: expect.stringMatching(/^m1-pin is m1's, who brought placed\d+: the project's copy of a package is not built on its requester's host/) });
    // Both architectures built by m1's contributor build: m2 claims with m3's aarch64 host's agent; the same agent on x86_64 is m1's
    // host alone, so the x86_64 rebuild goes unpinned — to any host the rule allows — rather than wait on m1's for a release.
    await seedHost("m3-pin", "m3", ARM, CLAUDE);
    await seedHost("m1-pin86", "m1", VPS86, CLAUDE);
    const two = await seedCopy("m1");
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(two.copy).run();
    await env.DB.prepare("UPDATE factory_packages SET arches = ? WHERE name = ?").bind(JSON.stringify(["aarch64", "x86_64"]), two.name).run();
    await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, lease_owner, staged_prefix, finished_at)
       VALUES (?, 'x86_64', '1.0-1', ?, 'contributor', 100, 'staged', 0, 'community', 'm1', 'build', 'contrib-box', ?, ?)`,
    ).bind(two.name, `draft:https://${two.name}.example@1`, `staging/m1/${two.name}/1/`, new Date().toISOString()).run();
    await settleTargets(env, two.name);
    const claimed = await call("POST", `/factory/tasks/${two.contributor}/build`, { token: "omc_m2", body: { worker: "m3-pin" } });
    expect(claimed.status, JSON.stringify(claimed.json)).toBe(200);
    expect(claimed.json).toMatchObject({ pinned_to: "m3-pin", agent: CLAUDE });
    const pins = (await env.DB.prepare("SELECT arch, pinned_to FROM build_tasks WHERE id IN (SELECT value FROM json_each(?)) ORDER BY arch").bind(JSON.stringify(claimed.json.tasks)).all<{ arch: string; pinned_to: string | null }>()).results;
    expect(pins).toEqual([{ arch: "aarch64", pinned_to: "m3-pin" }, { arch: "x86_64", pinned_to: null }]);
    // Another maintainer's x86_64 host with the same agent, seen before m1's: the pick is it, whichever claimed last — the statement
    // leaves the requester's workers out rather than drop the one row it reads.
    await seedHost("m3-pin86", "m3", VPS86, CLAUDE, 1);
    const alive = new Date(Date.now() - 10 * MIN).toISOString();
    expect(await env.DB.prepare(SAME_AGENT_SQL).bind("x86_64", CLAUDE, alive, JSON.stringify(["m1"])).first()).toEqual({ id: "m3-pin86" });
    expect(await env.DB.prepare(SAME_AGENT_SQL).bind("x86_64", CLAUDE, alive, "[]").first()).toEqual({ id: "m1-pin86" });
  });
});

describe("the second opinion (D36): elsewhere, with another model when one exists", () => {
  it("one provider: an audit goes to a host other than its builder's; a publish-bound one records none, a contributor build's host", async () => {
    await seedHost("m1-a", "m1", ARM);
    await seedHost("m2-a", "m2", ARM);
    const copy = await seedAudit("m1-a", { publish: true, builtWith: CLAUDE });
    const theirs = await seedAudit("m1-a", { publish: false });
    // The builder claims first: m2's host is idle and can take both, so the builder is handed neither.
    expect((await claim("m1-a")).status).toBe(204);
    const one = await claim("m2-a");
    const two = await claim("m2-a", [lease(one)]);
    const got = new Map([one, two].map((c) => [c.json.task.id as number, c.json.task]));
    expect(got.get(copy.audit)).toMatchObject({ lease_owner: "m2-a", independent: "none" });
    expect(got.get(theirs.audit)).toMatchObject({ lease_owner: "m2-a", independent: "host" });
    expect((await taskOf(copy.audit)).independent).toBe("none");
  });

  it("two providers: a publish-bound audit is never the builder's model while a host with another was alive in the last 24 hours — 23 hours ago too — and records model; 25 hours ago, none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedHost("m1-c", "m1", ARM, CLAUDE);
    await seedHost("m2-g", "m2", ARM, GPT);
    const copy = await seedAudit("m2-g", { publish: true, builtWith: CLAUDE });
    // m1's host runs the model that built it: handed nothing, while m2's host — the other model — is alive.
    expect((await claim("m1-c")).status).toBe(204);
    const c = await claim("m2-g");
    expect(c.json.task).toMatchObject({ id: copy.audit, independent: "model" });
    // m2's host went quiet 23 hours ago: its model still counts — the audit waits.
    const later = await seedAudit("m2-g", { publish: true, builtWith: CLAUDE });
    vi.setSystemTime(t0 + 23 * HOUR);
    expect((await claim("m1-c")).status).toBe(204);
    expect((await taskOf(later.audit)).status).toBe("queued");
    // A day and an hour since: it runs on the same model, and says so.
    vi.setSystemTime(t0 + 25 * HOUR);
    const d = await claim("m1-c");
    expect(d.json.task).toMatchObject({ id: later.audit, lease_owner: "m1-c", independent: "none" });
  });
});

describe("the second opinion's machine and the audits' head (D36)", () => {
  it("the Studio's legacy set is one machine: an audit of what community-* built, taken by review-* beside it, says none; with m2's host alive it goes there first, and says host", async () => {
    await seedLegacy("st-community", "m1", "community", ["build"]);
    await seedLegacy("st-review", "m1", "project", ["audit"]);
    const one = await seedAudit("st-community", { publish: false });
    const c = await legacyClaim("st-review", ["audit"]);
    expect(c.json.task).toMatchObject({ id: one.audit, lease_owner: "st-review", independent: "none" });
    // m2's host alive and idle: review-* leaves the next audit to it, another machine.
    await seedHost("m2-l", "m2", ARM);
    const two = await seedAudit("st-community", { publish: false });
    expect((await legacyClaim("st-review", ["audit"])).status).toBe(204);
    expect((await claim("m2-l")).json.task).toMatchObject({ id: two.audit, lease_owner: "m2-l", independent: "host" });
  });

  it("more than HEAD_LIMIT audits of the project's copy waiting for another model hide no audit the claimer's model can take", async () => {
    await seedHost("m1-h", "m1", ARM, CLAUDE);
    // m2's host runs another model and was seen an hour ago: inside the day, so every audit of the project's copy built with Claude waits for it.
    await seedHost("m2-away", "m2", ARM, GPT, 60);
    const name = `audited${++seq}`;
    const built = (await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, lease_owner, staged_prefix, finished_at)
       VALUES (?, 'aarch64', '1.0-1', 'review:1', 'built', 30, 'staged', 0, 'project', 'alice', 'build', ?, 'm1-h', ?, ?) RETURNING id`,
    ).bind(name, JSON.stringify({ review: 1, built_with: CLAUDE }), `staging/x/${name}/0/`, new Date().toISOString()).first<{ id: number }>())!.id;
    const audit = env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params) VALUES (?, 'aarch64', '1.0-1', ?, 'staged', 40, 'queued', 0, 'project', NULL, 'audit', ?)`);
    await env.DB.batch(Array.from({ length: HEAD_LIMIT + 5 }, () => audit.bind(name, `staging:${built}`, JSON.stringify({ task: built, name, owner: "alice", arch: "aarch64" }))));
    const theirs = await seedAudit("m1-h", { publish: false });
    const c = await claim("m1-h");
    expect(c.json.task).toMatchObject({ id: theirs.audit, independent: "none" });
  });

  it("an audit back in the queue says no independence: the requeue, a lost lease and a failure that is not the last clear it with the lease", async () => {
    await seedHost("m1-q", "m1", ARM);
    await seedHost("m2-q", "m2", ARM);
    const at = () => new Date().toISOString();
    for (const back of ["requeue", "lost", "fail"] as const) {
      const { audit } = await seedAudit("m1-q", { publish: false });
      const c = await claim("m2-q");
      expect(c.json.task).toMatchObject({ id: audit, independent: "host" });
      if (back === "requeue") await env.DB.prepare(REQUEUE_SQL).bind(at(), "the lease expired", audit, "m2-q", null, null).run();
      else if (back === "lost") await env.DB.prepare(LOST_LEASE_SQL).bind("lost on its host", audit, "m2-q", c.json.task.lease_gen, at()).run();
      else expect((await call("POST", `/factory/tasks/${audit}/fail`, { token: c.json.token, body: { error: "the agent did not answer", final: false } })).status).toBe(200);
      expect(await taskOf(audit), back).toMatchObject({ status: "queued", independent: null });
      await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(audit).run();
    }
  });
});

describe("the models a publish-bound audit weighs (D36)", () => {
  it("a host with another model counts while its agent answered in the last 24 hours: one failing for an hour still holds the audit, one failing for a day — however often it claims — no longer", async () => {
    await seedHost("m1-w", "m1", ARM, CLAUDE);
    await seedHost("m3-g", "m3", ARM, GPT);
    const copy = await seedAudit("m2-x", { publish: true, builtWith: CLAUDE });
    // m3's host is alive, its GPT agent failing for an hour: it took nothing since, and the audit waits for it.
    await env.DB.prepare("UPDATE build_workers SET agent_status = 'error', agent_error_since = ? WHERE id = 'm3-g'").bind(new Date(Date.now() - HOUR).toISOString()).run();
    expect((await claim("m1-w")).status).toBe(204);
    // Failing for a day and an hour: no model of it answered in the window — the audit runs on the one alive, and says none.
    await env.DB.prepare("UPDATE build_workers SET agent_error_since = ?, last_seen = ? WHERE id = 'm3-g'").bind(new Date(Date.now() - 25 * HOUR).toISOString(), new Date().toISOString()).run();
    const c = await claim("m1-w");
    expect(c.json.task).toMatchObject({ id: copy.audit, independent: "none" });
  });

  it("a host with another model that is handed nothing — below the signed minimum, or behind the pool's release past the grace — holds no audit, however often it claims", async () => {
    await seedHost("m1-v", "m1", ARM, CLAUDE);
    await seedHost("m3-v", "m3", ARM, GPT);
    const below = await seedAudit("m2-x", { publish: true, builtWith: CLAUDE });
    expect((await claim("m1-v")).status).toBe(204);
    await env.DB.prepare("UPDATE hosts SET capacity = json_set(capacity, '$.below_minimum', 'memory: 6 GB, below the 8 GB a host needs') WHERE worker_id = 'm3-v'").run();
    expect((await claim("m1-v")).json.task).toMatchObject({ id: below.audit, independent: "none" });
    await env.DB.prepare("UPDATE hosts SET capacity = json_set(capacity, '$.below_minimum', json('null')) WHERE worker_id = 'm3-v'").run();
    // The pool at v1.0.2 for an hour; m3's host still on v1.0.0, two releases behind: answered 426, handed nothing.
    const was = { version: env.POOL_VERSION, deployed: env.POOL_DEPLOYED_AT };
    Object.assign(env, { POOL_VERSION: "v1.0.2", POOL_DEPLOYED_AT: new Date(Date.now() - HOUR).toISOString() });
    try {
      const behind = await seedAudit("m2-x", { publish: true, builtWith: CLAUDE });
      expect((await claim("m1-v")).status).toBe(204);
      await env.DB.prepare("UPDATE build_workers SET version = 'v1.0.0' WHERE id = 'm3-v'").run();
      expect((await claim("m1-v")).json.task).toMatchObject({ id: behind.audit, independent: "none" });
    } finally {
      Object.assign(env, { POOL_VERSION: was.version, POOL_DEPLOYED_AT: was.deployed });
    }
  });
});

describe("Review's view (the page's own script)", () => {
  /** /review's script, run over a document that answers nothing: the functions under test, the review list and the viewer set by hand. */
  async function page(): Promise<Ran & Record<string, any>> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://pool.test/review"), env, ctx);
    await waitOnExecutionContext(ctx);
    return runScript(scriptOf(await res.text()), { pathname: "/review", functions: ["renderRebuild", "renderSteps", "independentPill"], variables: ["REVIEW", "WHO", "LOGARCH"] }) as Ran & Record<string, any>;
  }
  const queued = { id: 41, kind: "build", trust: "project", status: "queued", arch: "aarch64", attempts: 0, max_attempts: 3, params: { review: 40 } };
  const placementFor = (any_host: { ok: boolean; why: string | null }, o: Record<string, unknown> = {}) => ({ held: true, others: [], mine: ["m1-studio"], requesters: ["m1"], released: null, any_host, ...o });
  const listWith = (placement: unknown) => ({ staged: [{ id: 40, kind: "contributor", project_build: { id: 41, status: "queued", placement } }], packages: [] });
  const R = [{ arch: "aarch64", asked: true, target: { status: "reviewing", task: 41 }, rebuild: queued }];

  it("a held rebuild: its line names the requester, with Release to any host — live for another maintainer, grey with the server's reason for anyone else; its step and log say what it waits for", async () => {
    const d = await page();
    d.setWHO({ me: { login: "m2", role: "maintainer" }, login: "m2", role: "maintainer" });
    d.setREVIEW(listWith(placementFor({ ok: true, why: null })));
    d.renderRebuild(R, null);
    const line = d.nodes["#rv-place"].innerHTML as string;
    expect(line).toContain('<p class="rv-placed warn">aarch64: waits for a host — only <a href="/user/m1"');
    expect(line).toContain(">@m1</a>'s can build it, and the project's copy is not built on its requester's host while another maintainer's can. ");
    expect(line).toContain('<button type="button" class="op-btn sm" data-anyhost="41">Release to any host</button>');
    expect(d.nodes["#rv-y-log"].innerHTML).toContain("waiting for a host: only its requester's hosts can build it");
    d.renderSteps(R);
    expect(d.nodes["#rv-steps"].innerHTML).toContain('<span class="t">Build aarch64</span><span class="w">a release</span>');
    // The requester, grey with the server's words.
    d.setREVIEW(listWith(placementFor({ ok: false, why: "you brought placed1 — another maintainer releases its rebuild to any host, as another decides on it" })));
    d.renderRebuild(R, null);
    expect(d.nodes["#rv-place"].innerHTML).toContain('<button type="button" class="op-btn sm" data-anyhost="41" disabled aria-disabled="true" title="you brought placed1 — another maintainer releases its rebuild to any host, as another decides on it">Release to any host</button>');
    // Released: who did, and no button. Not held (another maintainer's host can build it): nothing said.
    d.setREVIEW(listWith(placementFor({ ok: false, why: "released to any host by m2 already" }, { held: false, released: { by: "m2", at: "2026-10-06T00:00:00Z" } })));
    d.renderRebuild(R, null);
    expect(d.nodes["#rv-place"].innerHTML).toMatch(/^<p class="rv-placed">aarch64: released to any host by <a href="\/user\/m2"[^>]*>@m2<\/a><\/p>$/);
    d.setREVIEW(listWith(placementFor({ ok: false, why: "m2-arm — another maintainer's — can build it" }, { held: false, others: ["m2-arm"] })));
    d.renderRebuild(R, null);
    expect(d.nodes["#rv-place"].innerHTML).toBe("");
    expect(d.nodes["#rv-y-log"].innerHTML).toContain("queued for a host");
  });

  it("the audit's independence beside its verdict: the rebuild's audit on the right, as the shell words it for each value", async () => {
    const d = await page();
    d.setREVIEW({ staged: [], packages: [] });
    const built = { ...queued, status: "staged", result: { vet: { verdict: "pass", warnings: 0 } } };
    const paudit = { id: 42, kind: "audit", status: "done", result: { verdict: "ok", summary: "reads well", findings: [] }, independent: "model" };
    d.renderRebuild([{ ...R[0], rebuild: built, paudit, trial: null }], null);
    expect(d.nodes["#rv-y-evid"].innerHTML).toContain('<span>audit <span class="pill ok">ok</span> <span class="muted" title="reads well">report</span> <span class="pill ok" title="another model judged it than the one that built it">independent: model</span></span>');
    expect(d.independentPill({ independent: "host" })).toBe(' <span class="pill warn" title="the same model judged it, on another host than the one that built it">independent: host</span>');
    expect(d.independentPill({ independent: "none" })).toMatch(/^ <span class="pill warn" title="the model that built it judged it: the project's copy takes another model whenever a host with one was alive in the last 24 hours[^"]*">independent: none<\/span>$/);
    // An audit not leased yet, or leased before #339, says nothing of it — nor one back in the queue, whatever its lost lease said.
    expect(d.independentPill({ independent: null })).toBe("");
    expect(d.independentPill({ status: "queued", independent: "model" })).toBe("");
    expect(d.independentPill(null)).toBe("");
  });
});

describe("the passkey's act and what the planner reads", () => {
  it("any-host:<task> is an act of its own", () => {
    for (const ok of ["any-host:1", "any-host:123456"]) expect(SUBJECT.test(ok), ok).toBe(true);
    for (const no of ["any-host:", "any-host:0", "any-host:x", "anyhost:1"]) expect(SUBJECT.test(no), no).toBe(false);
  });

  it("the placement reads and the release by their indexes, never a scan of build_tasks", async () => {
    const plan = async (sql: string, args: unknown[]) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const scope = (t: string) => `${t}.kind IN (SELECT value FROM json_each(?)) AND (${t}.pinned_to IS NULL OR ${t}.pinned_to = ?)`;
    const cases: [string, string, unknown[], RegExp][] = [
      ["a lane's head, with what placement reads", LANE_HEAD_SQL(scope("c")), ["aarch64", '["build"]', "w"], /SEARCH c USING INDEX idx_build_tasks_queue \(status=\? AND arch=\?\)/],
      ["the arch-neutral head, with what placement reads", NEUTRAL_HEAD_SQL(scope("c")), ['["audit"]', "w"], /SEARCH c USING INDEX idx_build_tasks_(queue|kind) /],
      ["the audits of the project's copy read apart, with what placement reads", SAME_MODEL_HEAD_SQL(` AND ${scope("c")}`), ['["audit"]', "w"], /SEARCH c USING INDEX idx_build_tasks_(queue|kind) /],
      ["the queued copies Review asks about", PLACEMENTS_SQL, ["[1,2]"], /SEARCH c USING INTEGER PRIMARY KEY/],
      ["the release", ANY_HOST_SQL, ['{"by":"m2"}', 1], /SEARCH build_tasks USING INTEGER PRIMARY KEY/],
    ];
    for (const [what, sql, args, want] of cases) {
      const p = await plan(sql, args);
      expect(p, what).toMatch(want);
      expect(p, what).not.toMatch(/SCAN (build_tasks|c|rq|au)(?! USING)/);
      // Each subquery of placement by a primary key: the contributor's build, the audited build, its registration.
      if (what.includes("placement")) expect(p, what).toMatch(/SEARCH (rq|au) USING INTEGER PRIMARY KEY/);
    }
    // The models alive: the registrations, a few dozen rows, as the fleet's; their hosts by the primary key.
    expect(await plan(MODELS_SQL, ["2026-10-01T00:00:00Z"])).toMatch(/SEARCH h USING INDEX sqlite_autoindex_hosts_1|SEARCH h USING PRIMARY KEY/);
  });
});
