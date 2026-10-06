/**
 * The contributor worker path and the community-worker claim code are gone
 * (#343, epic #307, design v2 §8.2, §21.4; S8, S9, D56), inside workerd
 * with a real D1:
 *
 * - the one command that ran a contributor's worker and the compose file it
 *   wrote (`GET /omarchy-worker`) answer 410 with the pointer to the
 *   maintainer-host docs, and so do a worker's mode (`POST
 *   /factory/workers/self/mode`, `/factory/workers/:id/mode`) and per-worker
 *   trust (`POST /factory/workers/:id/trust`), for every caller — nothing
 *   is read or written, and the signed trust records stay in R2;
 * - the maintainers' legacy registrations — the Studio's community pair,
 *   maralcbr's CLI workers, the Studio's project roles — claim through the
 *   host selection as hosts with one lane and one build: a community one
 *   takes any contributor's build, whatever mode its row once held and
 *   whatever its container's claim says; an emulated one waits its T while
 *   a native one is alive and idle; a build a toolchain could not start
 *   emulated never goes to an emulated one; trust is all that is left of
 *   their scope — a project one takes no contributor's build, a community
 *   one no project build; a bump queued before #343 for its owner's worker
 *   first waits for nobody;
 * - a community registration claims only while its owner is a maintainer:
 *   one a contributor made before #331 is refused at the claim (403, with
 *   why and the pointer), counts as nobody's capacity and is never pinned —
 *   it does not become a build machine for everyone's packages;
 * - nothing writes `mode`, `mode_by` or `shared_after` any more: the
 *   columns are history, and the listing serves no mode;
 * - the site's pages and the served docs no longer describe a
 *   contributor-run worker, its shared or dedicated mode, or the command.
 *
 * Tokens: workers omw_<id>, people's CLI omc_<login>, sessions oms_<login>.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { GONE, HOST_DOCS, POOL_HOSTS, sha256Hex } from "../src/routes/contributors";
import { queuePosition } from "../src/queue";

const ORIGIN = "http://pool.test";
const MIN = 60000;

interface Res { status: number; type: string | null; text: string; json: any }
async function fetchAt(method: string, path: string, o: { token?: string; session?: string; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.session) { headers.cookie = `omc=oms_${o.session}`; headers.origin = ORIGIN; }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, type: res.headers.get("content-type"), text, json };
}
const api = (method: string, path: string, o: { token?: string; session?: string; body?: unknown } = {}) => fetchAt(method, `/api/v1${path}`, o);

/** A legacy registration as its row stands: trust, owner, its labels, the mode its row held before #343 and who set it. */
async function seedLegacy(id: string, arch: string, o: { owner: string; trust: "project" | "community"; emulated?: boolean; mode?: string; modeBy?: string | null; kinds?: string[] }): Promise<void> {
  await env.DB.prepare("DELETE FROM build_workers WHERE id = ?").bind(id).run();
  await env.DB.prepare(
    "INSERT INTO build_workers (id, arch, owner, token_hash, mode, mode_by, trust, trusted_by, last_seen, labels, kinds, agent, agent_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'anthropic/claude-test', 'ok')",
  ).bind(id, arch, o.owner, await sha256Hex(`omw_${id}`), o.mode ?? "dedicated", o.modeBy ?? null, o.trust, o.trust === "project" ? "m1, m2" : null, new Date().toISOString(),
    JSON.stringify(o.emulated ? { emulated: true } : {}), o.kinds ? JSON.stringify(o.kinds) : null).run();
}
/** A claim as a legacy image sends it: its labels, its agent answering — and the `shared` its container was started with, which nothing reads. */
const claim = (id: string, arch: string, o: { emulated?: boolean; shared?: boolean; kinds?: string[] } = {}) =>
  api("POST", "/factory/claim", { token: `omw_${id}`, body: { arch, version: "v1.0.2", labels: o.emulated ? { emulated: true } : {}, agent: "anthropic/claude-test", agent_status: "ok", ...(o.kinds ? { kinds: o.kinds } : {}), ...(o.shared === undefined ? {} : { shared: o.shared }) } });

let seq = 0;
/** A queued task, `ago` minutes old. */
async function seedTask(t: { arch: string; trust?: "project" | "community"; owner?: string | null; kind?: string; params?: unknown; ago?: number; sharedAfter?: string }): Promise<number> {
  const name = `pkg${++seq}`;
  return (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, created_at, shared_after) VALUES (?, ?, '1.0-1', ?, 'test', 100, 'queued', 0, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(name, t.arch, `https://github.com/x/${name}@v1:PKGBUILD`, t.trust ?? "community", t.owner ?? (t.trust === "project" ? null : "carol"), t.kind ?? "build", t.params === undefined ? null : JSON.stringify(t.params),
    new Date(Date.now() - (t.ago ?? 0) * MIN).toISOString(), t.sharedAfter ?? null).first<{ id: number }>())!.id;
}
const rowOf = (id: string) => env.DB.prepare("SELECT mode, mode_by, current_task FROM build_workers WHERE id = ?").bind(id).first<{ mode: string; mode_by: string | null; current_task: number | null }>();

beforeAll(async () => {
  const h = sha256Hex;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2'), ('maralcbr')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('m1', ?, ?, 'maintainer'), ('m2', ?, ?, 'maintainer'), ('maralcbr', ?, ?, 'maintainer'), ('carol', ?, ?, 'contributor')`)
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_maralcbr"), await h("oms_maralcbr"), await h("omc_carol"), await h("oms_carol")),
  ]);
});

afterEach(async () => {
  vi.useRealTimers();
  // Each test's fleet and queue are its own: the registrations before it are gone (not alive), their tasks cancelled.
  await env.DB.batch([
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE status IN ('queued', 'leased')"),
    env.DB.prepare("UPDATE build_workers SET last_seen = '2000-01-01T00:00:00.000Z', current_task = NULL"),
  ]);
});

describe("the contributor worker path's doors answer 410 with the pointer to the maintainer-host docs (#343)", () => {
  it("GET /omarchy-worker and the compose file it wrote: 410, text as the script was, with the pointer — no script, no compose file", async () => {
    for (const path of ["/omarchy-worker", "/omarchy-worker.sh", "/omarchy-worker/compose.yml"]) {
      const r = await fetchAt("GET", path);
      expect([r.status, r.type], path).toEqual([410, "text/plain; charset=utf-8"]);
      expect(r.text, path).toBe(`${GONE.cli}: ${ORIGIN}${HOST_DOCS}\n`);
      for (const gone of ["#!/usr/bin/env bash", "services:", "omw_"]) expect(r.text, `${path}: ${gone}`).not.toContain(gone);
    }
    // Where it points is a page the site serves.
    expect((await fetchAt("GET", HOST_DOCS)).status).toBe(200);
  });

  it("a worker's mode and per-worker trust: 410 for every caller — nobody, a contributor, a maintainer, the worker's own token — and nothing is written; the signed trust records stay", async () => {
    await seedLegacy("maralcbr-box", "x86_64", { owner: "maralcbr", trust: "community", mode: "dedicated", modeBy: "maralcbr" });
    await env.PACKAGES.put("workers/maralcbr-box/trust-2026-09-01T00:00:00.000Z.json", JSON.stringify({ schema: "omarchy-pool/worker-trust/1", worker: "maralcbr-box", trust: "community", by: "m1", at: "2026-09-01T00:00:00.000Z" }));
    const before = await env.DB.prepare("SELECT mode, mode_by, trust, trusted_by, trust_proposed_by FROM build_workers WHERE id = 'maralcbr-box'").first();
    const events = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'trust'").first<{ n: number }>())!.n;
    const lines = await events();
    const callers = [{}, { session: "carol" }, { session: "maralcbr" }, { token: "omc_m1" }, { token: "omw_maralcbr-box" }];
    const doors: [string, unknown, keyof typeof GONE][] = [
      ["/factory/workers/self/mode", { mode: "shared" }, "mode"],
      ["/factory/workers/maralcbr-box/mode", { mode: "shared" }, "mode"],
      ["/factory/workers/maralcbr-box/mode", { mode: "dedicated" }, "mode"],
      ["/factory/workers/maralcbr-box/trust", { trust: "project" }, "trust"],
      ["/factory/workers/maralcbr-box/trust", { trust: "community" }, "trust"],
    ];
    for (const [path, body, what] of doors) {
      for (const who of callers) {
        const r = await api("POST", path, { ...who, body });
        expect([r.status, r.json], `${path} as ${JSON.stringify(who)}`).toEqual([410, { error: GONE[what], code: "gone", docs: HOST_DOCS }]);
      }
    }
    expect(await env.DB.prepare("SELECT mode, mode_by, trust, trusted_by, trust_proposed_by FROM build_workers WHERE id = 'maralcbr-box'").first()).toEqual(before);
    expect(await events()).toBe(lines);
    expect((await env.PACKAGES.list({ prefix: "workers/maralcbr-box/trust-" })).objects.map((o) => o.key)).toEqual(["workers/maralcbr-box/trust-2026-09-01T00:00:00.000Z.json"]);
    // A worker asks what its registration is: no mode any more.
    expect((await api("GET", "/factory/workers/self", { token: "omw_maralcbr-box" })).json).toEqual({ id: "maralcbr-box", arch: "x86_64", trust: "community", owner: "maralcbr" });
  });
});

describe("the maintainers' legacy registrations claim through the host selection as hosts with one lane and one build (#343, design v2 §8.2)", () => {
  it("maralcbr's CLI worker, its row saying dedicated and set from the page, takes a contributor's build — not his own, a claim's `shared: false` or not — as one build on its one lane, and nothing writes its mode", async () => {
    await seedLegacy("maralcbr-box", "x86_64", { owner: "maralcbr", trust: "community", mode: "dedicated", modeBy: "maralcbr" });
    const carols = await seedTask({ arch: "x86_64", owner: "carol" });
    const c = await claim("maralcbr-box", "x86_64", { shared: false });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    // One build: size 1, a build's units, its one lane — native — and no lease generation (a host's alone).
    expect(c.json.task).toMatchObject({ id: carols, owner: "carol", lane: "native", size: 1, units: 2, lease_gen: null });
    expect(await rowOf("maralcbr-box")).toEqual({ mode: "dedicated", mode_by: "maralcbr", current_task: carols });
    // The Studio's community pair, its row saying shared: whatever the row and the claim say, the same rule.
    await seedLegacy("studio-community-aarch64", "aarch64", { owner: "m1", trust: "community", mode: "shared", modeBy: null });
    const another = await seedTask({ arch: "aarch64", owner: "dave" });
    const s = await claim("studio-community-aarch64", "aarch64", { shared: true });
    expect(s.json.task).toMatchObject({ id: another, owner: "dave", lane: "native" });
    expect(await rowOf("studio-community-aarch64")).toMatchObject({ mode: "shared", mode_by: null });
  });

  it("the Studio's emulated community worker waits its T while maralcbr's native one is alive and idle, takes the build at once while that one is busy, and after T whatever it does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await seedLegacy("studio-community-x86_64", "x86_64", { owner: "m1", trust: "community", emulated: true, mode: "shared" });
    await seedLegacy("maralcbr-box", "x86_64", { owner: "maralcbr", trust: "community" });
    const first = await seedTask({ arch: "x86_64", owner: "carol" });
    // maralcbr's native worker is alive and idle: the emulated one waits.
    expect((await claim("studio-community-x86_64", "x86_64", { emulated: true })).status).toBe(204);
    // The native one takes it; the next build finds it busy, and the emulated one takes that at once, on its emulated lane.
    expect((await claim("maralcbr-box", "x86_64")).json.task.id).toBe(first);
    const second = await seedTask({ arch: "x86_64", owner: "dave" });
    const e = await claim("studio-community-x86_64", "x86_64", { emulated: true });
    expect(e.json.task).toMatchObject({ id: second, lane: "emulated", size: 1, units: 2 });
    // Idle again: a new build waits for it — until T (3 minutes with no native history), then the emulated one takes it.
    await env.DB.prepare("UPDATE build_tasks SET status = 'done' WHERE id IN (?, ?)").bind(first, second).run();
    await env.DB.prepare("UPDATE build_workers SET current_task = NULL, last_seen = ? WHERE id = 'maralcbr-box'").bind(new Date().toISOString()).run();
    const third = await seedTask({ arch: "x86_64", owner: "erin" });
    expect((await claim("studio-community-x86_64", "x86_64", { emulated: true })).status).toBe(204);
    vi.setSystemTime(t0 + 3.1 * MIN);
    await env.DB.prepare("UPDATE build_workers SET last_seen = ? WHERE id = 'maralcbr-box'").bind(new Date().toISOString()).run();
    expect((await claim("studio-community-x86_64", "x86_64", { emulated: true })).json.task).toMatchObject({ id: third, lane: "emulated" });
  });

  it("a build a toolchain could not start emulated never goes to an emulated legacy registration; a native one takes it", async () => {
    await seedLegacy("studio-community-x86_64", "x86_64", { owner: "m1", trust: "community", emulated: true });
    const t = await seedTask({ arch: "x86_64", owner: "carol", params: { needs_native: 1 }, ago: 120 });
    expect((await claim("studio-community-x86_64", "x86_64", { emulated: true })).status).toBe(204);
    await seedLegacy("maralcbr-box", "x86_64", { owner: "maralcbr", trust: "community" });
    expect((await claim("maralcbr-box", "x86_64")).json.task).toMatchObject({ id: t, lane: "native" });
  });

  it("trust is all that is left of their scope: a community registration takes no project build or pool job, a project one no contributor's build", async () => {
    await seedLegacy("studio-community-aarch64", "aarch64", { owner: "m1", trust: "community", mode: "shared" });
    await seedLegacy("studio-pool-aarch64", "aarch64", { owner: "m1", trust: "project", mode: "shared", kinds: ["build", "sync", "health"] });
    const project = await seedTask({ arch: "aarch64", trust: "project" });
    const job = await seedTask({ arch: "aarch64", trust: "project", kind: "sync", params: { arch: "aarch64", sources: "[]" } });
    // Asked for a job too, a community registration takes builds only — and no project build.
    expect((await claim("studio-community-aarch64", "aarch64", { kinds: ["build", "sync"] })).status).toBe(204);
    const contributor = await seedTask({ arch: "aarch64", owner: "carol" });
    expect((await claim("studio-community-aarch64", "aarch64")).json.task.id).toBe(contributor);
    const contributor2 = await seedTask({ arch: "aarch64", owner: "carol" });
    // The project registration takes the project's work, never the contributor's build waiting beside it.
    const taken = new Set<number>();
    for (let i = 0; i < 3; i++) {
      const p = await claim("studio-pool-aarch64", "aarch64", { kinds: ["build", "sync"] });
      if (p.status !== 200) break;
      taken.add(p.json.task.id);
      await env.DB.prepare("UPDATE build_workers SET current_task = NULL WHERE id = 'studio-pool-aarch64'").run();
    }
    expect([...taken].sort()).toEqual([project, job].sort());
    expect((await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(contributor2).first())).toEqual({ status: "queued" });
  });

  it("a bump queued before #343 for its owner's worker first (shared_after ahead) waits for nobody: any community registration takes it at once, and the queue counts it", async () => {
    const days = new Date(Date.now() + 14 * 86400000).toISOString();
    const bump = await seedTask({ arch: "aarch64", owner: "carol", sharedAfter: days });
    expect(await queuePosition(env, { id: bump, arch: "aarch64", priority: 100 })).toEqual({ position: 1, total: 1 });
    await seedLegacy("maralcbr-box-arm", "aarch64", { owner: "maralcbr", trust: "community" });
    expect((await claim("maralcbr-box-arm", "aarch64")).json.task.id).toBe(bump);
  });
});

describe("a contributor's registration from before #331 claims nothing: it does not become a build machine for everyone's packages (#343)", () => {
  it("refused at the claim with why and the pointer — before #343 it built its owner's packages only, and a community registration now takes anyone's — and nothing is touched or leased", async () => {
    await seedLegacy("carol-laptop", "x86_64", { owner: "carol", trust: "community", mode: "dedicated", modeBy: "carol" });
    const daves = await seedTask({ arch: "x86_64", owner: "dave" });
    const carols = await seedTask({ arch: "x86_64", owner: "carol" });
    const seen = (await env.DB.prepare("SELECT last_seen FROM build_workers WHERE id = 'carol-laptop'").first<{ last_seen: string }>())!.last_seen;
    for (const shared of [false, true]) {
      const c = await claim("carol-laptop", "x86_64", { shared });
      expect([c.status, c.json], `shared: ${shared}`).toEqual([403, {
        error: `carol-laptop: its owner (carol) is no maintainer (factory/MAINTAINERS.toml) — contributors do not run workers (#343), ${POOL_HOSTS}: it claims nothing; revoke it on its page`,
        code: "owner_not_maintainer", docs: HOST_DOCS,
      }]);
    }
    expect((await env.DB.prepare("SELECT status FROM build_tasks WHERE id IN (?, ?) ORDER BY id").bind(daves, carols).all()).results).toEqual([{ status: "queued" }, { status: "queued" }]);
    expect((await env.DB.prepare("SELECT last_seen, current_task FROM build_workers WHERE id = 'carol-laptop'").first())).toEqual({ last_seen: seen, current_task: null });
    // A maintainer's registration takes them, as before.
    await seedLegacy("maralcbr-box", "x86_64", { owner: "maralcbr", trust: "community" });
    expect((await claim("maralcbr-box", "x86_64")).json.task.id).toBe(daves);
  });

  it("counts as nobody's native capacity: the Studio's emulated registration does not wait its T for it", async () => {
    await seedLegacy("carol-laptop", "x86_64", { owner: "carol", trust: "community" });
    await seedLegacy("studio-community-x86_64", "x86_64", { owner: "m1", trust: "community", emulated: true });
    const t = await seedTask({ arch: "x86_64", owner: "dave" });
    // carol's row says it is alive, idle and native; it claims nothing, so the emulated lane takes the build at once.
    expect((await claim("studio-community-x86_64", "x86_64", { emulated: true })).json.task).toMatchObject({ id: t, lane: "emulated" });
  });

  it("is never pinned: a build asked for it is refused, one asked for a maintainer's registration is queued for that one", async () => {
    await seedLegacy("carol-laptop", "x86_64", { owner: "carol", trust: "community" });
    await seedLegacy("maralcbr-box", "x86_64", { owner: "maralcbr", trust: "community" });
    await env.DB.prepare("INSERT OR IGNORE INTO factory_packages (name, owner, url, arches, status, pkgbuild_path) VALUES ('carols', 'carol', 'https://github.com/carol/carols', '[\"x86_64\"]', 'registered', 'PKGBUILD')").run();
    const mine = await api("POST", "/factory/packages/carols/build", { token: "omc_carol", body: { arches: ["x86_64"], worker: "carol-laptop" } });
    expect([mine.status, mine.json.error]).toEqual([403, "carol-laptop is not a worker that builds contributors' packages for x86_64"]);
    const theirs = await api("POST", "/factory/packages/carols/build", { token: "omc_carol", body: { arches: ["x86_64"], worker: "maralcbr-box" } });
    expect([theirs.status, theirs.json.pinned_to]).toEqual([201, "maralcbr-box"]);
  });

  it("a legacy registration made now and a confirmed host's write no mode, and the listing serves none: the column is history", async () => {
    const r = await api("POST", "/factory/workers", { session: "m1", body: { name: "studio-community", arch: "aarch64" } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const row = (await env.DB.prepare("SELECT mode, mode_by FROM build_workers WHERE id = ?").bind(r.json.worker).first<{ mode: string; mode_by: string | null }>())!;
    expect(["shared", "dedicated"]).not.toContain(row.mode);
    expect(row.mode_by).toBeNull();
    const listed = (await api("GET", `/factory?limit=50&fresh=${Date.now()}`)).json.workers as Record<string, unknown>[];
    expect(listed.length).toBeGreaterThan(0);
    for (const w of listed) expect(w, String(w.id)).not.toHaveProperty("mode");
  });
});

describe("the site and the docs no longer describe a contributor-run worker, its mode or the command (#343)", () => {
  // The words of the community worker tier, each on a page it was on: none may come back.
  const GONE_WORDS = [
    "WORKER_SHARED", "--shared", "share on|off", "share on | off", "Own only", "own packages only", "best idle shared worker",
    "a dedicated worker", "a shared worker", "shared workers", "/omarchy-worker/compose.yml", "curl -fsSLo omarchy-worker", "vouch for a worker",
    // What the review of #343 found left over: a build's caption, an adopted package's bumps, the cost of a community token, a contributor's token's rights.
    "its contributor's worker", "bumps come to your workers", "claims of that owner's tasks", "register and revoke their workers", "contributors' workers",
    "the mode per worker", "awaiting a second maintainer's word",
  ];
  it("the docs pages, the Workers page, Governance, How it works, the API page, a package's page, Review, Status and a worker's page carry none of them", async () => {
    // The package page and Review draw their words in their scripts: the served page carries them.
    await env.DB.prepare("INSERT OR IGNORE INTO factory_packages (name, owner, url, arches, status) VALUES ('gone-words', 'carol', 'https://github.com/carol/gone-words', '[\"x86_64\"]', 'registered')").run();
    for (const path of ["/docs/workers", "/docs/factory", "/docs/security-model", "/docs/governance", "/docs/how-it-works", "/docs/worker-host", "/docs/architecture", "/docs/runbook", "/workers", "/api", "/package/gone-words", "/review", "/status", "/worker/maralcbr-box"]) {
      const r = await fetchAt("GET", path);
      expect(r.status, path).toBe(200);
      for (const w of GONE_WORDS) expect(r.text, `${path}: ${w}`).not.toContain(w);
    }
  });
});
