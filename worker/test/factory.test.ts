/**
 * The factory's brain inside workerd: registered workers claim with their
 * own token and get a lease and a per-job token; a community build stages
 * its evidence and queues the audit; only a project worker with the kind
 * takes the audit and only its report may be written; maintainers approve
 * — never their own package, no exception — and nothing of the contributor's
 * is copied: the project builds the recipe a maintainer merged, and that
 * build is linked back to the approval it answers. The same story
 * tests/e2e-worker.sh tells with real containers, in seconds.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { requeueExpiredLeases, workerReady } from "../src/routes/factory";
import { packageKey } from "../src/r2";
import { jobOf } from "../src/jobtoken";
import { STAGING_QUOTA_BYTES, sweepStaging } from "../src/staging";

const API = "http://pool.test/api/v1";

async function call(method: string, path: string, body?: unknown, token?: string, raw?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(API + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

// Two project workers (aarch64) and one community worker owned by a
// contributor; one group whose maintainer is 'm1' — exactly what
// POST /factory/workers, a maintainer's trust and MAINTAINERS.toml produce.
beforeAll(async () => {
  const h = (t: string) => sha256Hex(t);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES
      ('w1', 'aarch64', 'm1', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z'),
      ('w2', 'aarch64', 'm1', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z'),
      ('w3', 'aarch64', 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z')`).bind(await h("omw_w1"), await h("omw_w2"), await h("omw_w3")),
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, role) VALUES ('m1', ?, 'maintainer'), ('m2', ?, 'maintainer'), ('alice', ?, 'contributor')`).bind(await h("omc_m1"), await h("omc_m2"), await h("omc_alice")),
  ]);
});

describe("claims and leases", () => {
  it("a worker claims only with its own token, for its own architecture, and gets nothing from an empty queue", async () => {
    expect((await call("POST", "/factory/claim", { arch: "aarch64" })).status).toBe(401);
    expect((await call("POST", "/factory/claim", { arch: "x86_64" }, "omw_w1")).status).toBe(400);
    expect((await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w1")).status).toBe(204);
    const self = await call("GET", "/factory/workers/self", undefined, "omw_w3");
    expect(self.json).toMatchObject({ id: "w3", arch: "aarch64", trust: "community", owner: "alice", mode: "dedicated" });
  });

  it("a maintainer enqueues a project build; a project worker takes it with a lease and a job token; a failure requeues it", async () => {
    expect((await call("POST", "/factory/enqueue", { name: "tool", pkgbuild_ref: "abc123", reason: "test", arches: ["aarch64"] })).status).toBe(401);
    const q = await call("POST", "/factory/enqueue", { name: "tool", pkgbuild_ref: "abc123", reason: "test", arches: ["aarch64"], version: "1.0-1" }, "omc_m1");
    expect(q.status, JSON.stringify(q.json)).toBe(201);
    expect(q.json.tasks).toHaveLength(1);
    const id = q.json.tasks[0].id ?? q.json.tasks[0];
    // The community worker never sees a project build.
    expect((await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3")).status).toBe(204);
    // The claim carries what the machine uses — the worker's own average; a malformed one is dropped, not refused.
    const c = await call("POST", "/factory/claim", { arch: "aarch64", hostname: "test", agent: "openai/gpt-5", version: "v0.0.1", usage: { cpu: 12.4, ram: 40, disk: 61, cores: 8, ram_gb: 16, disk_gb: 200.4, minutes: 60 } }, "omw_w1");
    expect(c.status).toBe(200);
    expect(c.json.task.id).toBe(id);
    expect(c.json.task.status).toBe("leased");
    expect(c.json.token).toMatch(/^omj\./);
    expect(c.json.pkgbuild_path).toBe("factory/sizing/tool"); // a task made after the project's recipes left the repository
    // The task is leased: nobody else gets it; the job token heartbeats and moves the lease.
    expect((await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w2")).status).toBe(204);
    expect((await call("POST", `/factory/tasks/${id}/heartbeat`, {}, "omw_w2")).status).toBe(409);
    const hb = await call("POST", `/factory/tasks/${id}/heartbeat`, {}, c.json.token);
    expect(hb.status).toBe(200);
    expect(hb.json.token).toMatch(/^omj\./);
    // What the worker reported it runs shows on the Factory list; the key never travels.
    const fac = await call("GET", "/factory");
    expect(fac.json.workers.find((w: any) => w.id === "w1")).toMatchObject({ agent: "openai/gpt-5", current_task: id, version: "v0.0.1", usage: { cpu: 12, ram: 40, disk: 61, cores: 8, ram_gb: 16, disk_gb: 200, minutes: 60 }, last_task: null });
    expect(fac.json.workers.find((w: any) => w.id === "w1").usage_at).toBeTruthy();
    // Fail: back in the queue behind its peers, attempts counted — and the worker's row remembers the attempt.
    const f = await call("POST", `/factory/tasks/${id}/fail`, { error: "boom" }, hb.json.token);
    expect(f.json).toMatchObject({ status: "queued", attempts: 1 });
    // (GET /factory is edge-cached by URL for ten seconds: a different limit is a different key.)
    expect((await call("GET", "/factory?limit=11")).json.workers.find((w: any) => w.id === "w1").last_task).toMatchObject({ id, kind: "build", name: "tool", version: "1.0-1", status: "failed" });
    // The other project worker takes it; completing needs the package in the pool first.
    // A claim with nothing usable as usage keeps what the row had (nothing yet); the claim itself is fine.
    const c2 = await call("POST", "/factory/claim", { arch: "aarch64", usage: { cpu: "high" } }, "omw_w2");
    expect(c2.json.task.id).toBe(id);
    expect((await call("GET", "/factory?limit=12")).json.workers.find((w: any) => w.id === "w2").usage).toBeNull();
    expect((await call("POST", `/factory/tasks/${id}/complete`, { sha256: "0".repeat(64), filename: "nope" }, c2.json.token)).status).toBe(409);
    const filename = "tool-1.0-1-aarch64.pkg.tar.zst";
    const bytes = new TextEncoder().encode("fake tool");
    await env.PACKAGES.put(packageKey("factory", "aarch64", filename), bytes);
    const sha = "a".repeat(64);
    const idx = await call("POST", "/packages?source=factory&arch=aarch64", { schema_version: 1, name: "tool", version: "1.0-1", arch: "aarch64", sha256: sha, filename, size_download: bytes.length, size_installed: 1, provides: ["tool"], requires: [] }, c2.json.token);
    expect(idx.status, JSON.stringify(idx.json)).toBe(201);
    const done = await call("POST", `/factory/tasks/${id}/complete`, { sha256: sha, filename, version: "1.0-1", duration_ms: 1200 }, c2.json.token);
    expect(done.json).toMatchObject({ task: id, status: "done" });
    expect((await call("GET", "/factory?limit=13")).json.workers.find((w: any) => w.id === "w2")).toMatchObject({ builds_done: 1, last_task: { id, kind: "build", name: "tool", version: "1.0-1", status: "done" } });
    // The job token dies with the task.
    expect((await call("POST", `/factory/tasks/${id}/heartbeat`, {}, c2.json.token)).status).toBe(409);
    const built = await call("GET", "/factory/built");
    expect(built.json.built.some((t: any) => t.name === "tool" && t.arch === "aarch64")).toBe(true);
    // The lease is over, but who held it stays on the row: the load per worker and the seal read it later.
    const row = await env.DB.prepare("SELECT status, lease_owner, lease_expires_at FROM build_tasks WHERE id = ?").bind(id).first<{ status: string; lease_owner: string | null; lease_expires_at: string | null }>();
    expect(row).toMatchObject({ status: "done", lease_owner: "w2", lease_expires_at: null });
    const stats = await call("GET", "/stats");
    expect(stats.json.series.workers_daily.some((w: any) => w.worker === "w2" && Number(w.ms) === 1200)).toBe(true);
  });
});

describe("a community build, its audit and the review", () => {
  let task: number;
  let jobToken: string;
  let req: number;

  it("the owner's worker stages the evidence with its job token; the builder cannot write the audit", async () => {
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('mine', 'aarch64', '1.0-1', 'draft:https://github.com/alice/mine@latest', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
    // Project workers never build a contributor's package.
    expect((await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w1")).status).toBe(204);
    // A draft is the agent's work: a worker with no agent, or one whose probe failed, gets nothing; one whose agent answered gets it.
    expect((await call("POST", "/factory/claim", { arch: "aarch64", agent: "" }, "omw_w3")).status).toBe(204);
    expect((await call("POST", "/factory/claim", { arch: "aarch64", agent: "openai/gpt-5", agent_status: "error", agent_error: "HTTP 402: insufficient credit" }, "omw_w3")).status).toBe(204);
    // (GET /factory is edge-cached for ten seconds: the row is the check.)
    const w3row = async () => (await env.DB.prepare("SELECT last_seen, kinds, trust, agent, agent_status, agent_error FROM build_workers WHERE id = 'w3'").first<{ last_seen: string; kinds: string | null; trust: string; agent: string | null; agent_status: string | null; agent_error: string | null }>())!;
    let w3 = await w3row();
    expect(w3).toMatchObject({ agent: "openai/gpt-5", agent_status: "error", agent_error: "HTTP 402: insufficient credit", kinds: '["build"]' });
    expect(workerReady(w3, Date.now() - 600000)).toBe(false);
    const c = await call("POST", "/factory/claim", { arch: "aarch64", agent: "openai/gpt-5", agent_status: "ok", agent_checked_at: "2026-09-15T12:00:00Z" }, "omw_w3");
    expect(c.status).toBe(200);
    w3 = await w3row();
    expect(w3).toMatchObject({ agent_status: "ok", agent_error: null });
    expect(workerReady(w3, Date.now() - 600000)).toBe(true);
    task = c.json.task.id;
    jobToken = c.json.token;
    expect(c.json.upload).toBe(`/api/v1/factory/tasks/${task}/artifacts/<filename>`);
    // The package this build is for: requested (record #), so the evidence has a place on the record.
    req = (await env.DB.prepare(`INSERT INTO package_requests (name, owner, project, source, version, description, license, arches, checklist, record, sha256) VALUES ('mine', 'alice', 'https://github.com/alice/mine', 'https://github.com/alice/mine/archive/refs/tags/v1.0.tar.gz', 'v1.0', 'Mine, a tool', 'MIT', '["aarch64"]', '{}', 'factory/mine/0/request.json', 'x') RETURNING id`).first<{ id: number }>())!.id;
    await env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status, request_id, project) VALUES ('mine', 'alice', 'https://github.com/alice/mine', '["aarch64"]', 'building', ?, 'https://github.com/alice/mine')`).bind(req).run();
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", "tests.log", "mine-1.0-1-aarch64.pkg.tar.zst"]) {
      expect((await call("PUT", `/factory/tasks/${task}/artifacts/${f}`, undefined, jobToken, `evidence ${f}`)).status).toBe(201);
    }
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/audit.json`, undefined, jobToken, "{}")).status).toBe(403);
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/PKGBUILD`, undefined, "omw_w1", "x")).status).toBe(409);
    // Completing before the package is uploaded is refused; after, the build is staged and the audit queued.
    expect((await call("POST", `/factory/tasks/${task}/complete`, { sha256: "b".repeat(64), filename: "other.pkg.tar.zst" }, jobToken)).status).toBe(409);
    // A gate that failed never stages: the worker reports a failure instead.
    await call("PUT", `/factory/tasks/${task}/artifacts/vet.json`, undefined, jobToken, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "fail", checks: [{ name: "smoke", status: "fail", detail: "a binary does not start" }] }));
    const refused = await call("POST", `/factory/tasks/${task}/complete`, { sha256: "b".repeat(64), filename: "mine-1.0-1-aarch64.pkg.tar.zst", version: "1.0-1" }, jobToken);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/gate failed \(smoke\)/);
    await call("PUT", `/factory/tasks/${task}/artifacts/vet.json`, undefined, jobToken, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "pass", checks: [{ name: "checksums", status: "pass", detail: "" }, { name: "check", status: "warn", detail: "no check()" }] }));
    const st = await call("POST", `/factory/tasks/${task}/complete`, { sha256: "b".repeat(64), filename: "mine-1.0-1-aarch64.pkg.tar.zst", version: "1.0-1" }, jobToken);
    expect(st.json.status).toBe("staged");
    // The gate's verdict stays with the task; the evidence — not the package — is on the record, signed when the pool signs.
    expect(JSON.parse((await env.DB.prepare("SELECT result FROM build_tasks WHERE id = ?").bind(task).first<{ result: string }>())!.result)).toEqual({ vet: { verdict: "pass", fails: 0, warnings: 1, failed: [], warned: ["check"] } });
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", "tests.log", "vet.json"]) expect(await env.PACKAGES.head(`factory/mine/${req}/build-${task}/${f}`), f).not.toBeNull();
    expect(await env.PACKAGES.head(`factory/mine/${req}/build-${task}/mine-1.0-1-aarch64.pkg.tar.zst`)).toBeNull();
    const review = await call("GET", "/factory/review");
    const row = review.json.staged.find((t: any) => t.id === task);
    expect(row.audit).toEqual({ status: "queued" });
    expect(row.evidence.audit).toBe(`/api/v1/factory/tasks/${task}/artifacts/audit.md`);
    expect(row.vet).toEqual({ verdict: "pass", fails: 0, warnings: 1, failed: [], warned: ["check"] });
    expect(row.evidence.vet).toBe(`/api/v1/factory/tasks/${task}/artifacts/vet.json`);
    // The PKGBUILD, the log and the .PKGINFO are public; the package is not.
    const ctx = createExecutionContext();
    const pk = await worker.fetch(new Request(`${API}/factory/tasks/${task}/artifacts/PKGINFO`), env, ctx);
    expect(await pk.text()).toBe("evidence PKGINFO");
    expect((await call("GET", `/factory/tasks/${task}/artifacts/mine-1.0-1-aarch64.pkg.tar.zst`)).status).toBe(403);
  });

  it("only a project worker declaring the kind takes the audit, and it may write the report only", async () => {
    expect((await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["audit"] }, "omw_w3")).status).toBe(204);
    // The second agent must answer too: a project worker whose agent is down is not handed the audit.
    expect((await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["audit"], agent: "claude-code/claude-sonnet-5", agent_status: "error", agent_error: "claude-code: no answer in 90 s" }, "omw_w1")).status).toBe(204);
    const c = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["audit"], agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w1");
    // The label with a hyphen in the provider is kept (it was refused until 2026-09-15: every Studio worker showed no agent).
    expect(await env.DB.prepare("SELECT agent, agent_status FROM build_workers WHERE id = 'w1'").first()).toEqual({ agent: "claude-code/claude-sonnet-5", agent_status: "ok" });
    expect(c.status).toBe(200);
    expect(c.json.task.kind).toBe("audit");
    expect(c.json.task.params.task).toBe(task);
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/PKGBUILD`, undefined, c.json.token, "x")).status).toBe(400);
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/audit.json`, undefined, c.json.token, '{"verdict":"warn"}')).status).toBe(201);
    expect((await call("PUT", `/factory/tasks/${task}/artifacts/audit.md`, undefined, c.json.token, "# Audit: warn")).status).toBe(201);
    const done = await call("POST", `/factory/tasks/${c.json.task.id}/complete`, { summary: "warn", result: { verdict: "warn", summary: "SKIP checksum", model: "test", category: "terminal", findings: [{ severity: "high", area: "supply-chain" }] } }, c.json.token);
    expect(done.json.status).toBe("done");
    const review = await call("GET", "/factory/review");
    expect(review.json.staged.find((t: any) => t.id === task).audit).toMatchObject({ status: "done", verdict: "warn", findings: 1, high: 1, model: "test" });
    // The report joins the evidence on the record.
    expect(await env.PACKAGES.head(`factory/mine/${req}/build-${task}/audit.md`)).not.toBeNull();
    // The agent's category is a proposal: the registration took it because none was set, and the review row shows it.
    expect(review.json.staged.find((t: any) => t.id === task).category).toBe("terminal");
  });

  it("a maintainer settles the category — any maintainer, from the fixed list — and a second audit does not undo it", async () => {
    expect((await call("POST", "/factory/packages/mine/category", { category: "editors" }, "omc_alice")).status).toBe(403);
    expect((await call("POST", "/factory/packages/mine/category", { category: "desktop-stuff" }, "omc_m1")).status).toBe(400);
    expect((await call("POST", "/factory/packages/nothing/category", { category: "editors" }, "omc_m1")).status).toBe(404);
    const set = await call("POST", "/factory/packages/mine/category", { category: "editors" }, "omc_m1");
    expect(set.json).toMatchObject({ package: "mine", category: "editors", was: "terminal", by: "m1" });
    expect((await env.DB.prepare("SELECT category FROM factory_packages WHERE name = 'mine'").first())!.category).toBe("editors");
    expect((await env.DB.prepare("SELECT summary FROM events WHERE kind = 'category' ORDER BY id DESC LIMIT 1").first())!.summary).toBe("mine: editors (was terminal), settled by m1");
    // What the agent proposes later is only a proposal: a settled category stays.
    await env.DB.prepare("UPDATE factory_packages SET category = 'editors' WHERE name = 'mine'").run();
    const again = await env.DB.prepare("UPDATE factory_packages SET category = 'games' WHERE name = 'mine' AND category IS NULL").run();
    expect(again.meta.changes).toBe(0);
  });

  it("a newer build of the same package supersedes the staged one before it", async () => {
    // alice's worker builds mine again (a fix): the earlier staged row is cancelled with its pending audit, and the review queue shows one.
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('mine', 'aarch64', '1.0-2', 'draft:https://github.com/alice/mine@latest', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
    const c = await call("POST", "/factory/claim", { arch: "aarch64", agent: "openai/gpt-5", agent_status: "ok" }, "omw_w3");
    expect(c.status).toBe(200);
    const again = c.json.task.id;
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", "mine-1.0-2-aarch64.pkg.tar.zst"]) await call("PUT", `/factory/tasks/${again}/artifacts/${f}`, undefined, c.json.token, `evidence ${f}`);
    expect((await call("POST", `/factory/tasks/${again}/complete`, { sha256: "d".repeat(64), filename: "mine-1.0-2-aarch64.pkg.tar.zst", version: "1.0-2" }, c.json.token)).json.status).toBe("staged");
    expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE id = ?").bind(task).first()).toMatchObject({ status: "cancelled", error: `superseded by task ${again} (1.0-2)` });
    // The superseded build's package gave the quota back on the spot; its recipe and log stay (and are on the record).
    expect(await env.STAGING.head(`staging/alice/mine/${task}/mine-1.0-1-aarch64.pkg.tar.zst`)).toBeNull();
    expect(await env.STAGING.head(`staging/alice/mine/${task}/PKGBUILD`)).not.toBeNull();
    expect((await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ? ORDER BY key").bind(task).all<{ key: string }>()).results.map((r) => r.key.split("/").pop())).toEqual(["PKGBUILD", "PKGINFO", "audit.json", "audit.md", "build.log", "tests.log", "vet.json"]);
    const staged = (await call("GET", "/factory/review")).json.staged.filter((t: any) => t.name === "mine");
    expect(staged.map((t: any) => t.id)).toEqual([again]);
    // The rest of the story continues with the build that stands.
    task = again;
  });

  it("a contributor's build cannot be approved; a maintainer — never the owner — has the project build it", async () => {
    // Nothing of the contributor's is ever what users get: the approval is refused outright.
    const refused = await call("POST", `/factory/tasks/${task}/approve`, {}, "omc_m2");
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/have the project build it first/);
    expect((await call("POST", `/factory/tasks/${task}/build`, {}, "omc_alice")).status).toBe(403);
    // The owner is who requested the package (the registration), not who happened to build it.
    await env.DB.prepare("UPDATE factory_packages SET owner = 'm1' WHERE name = 'mine'").run();
    const own = await call("POST", `/factory/tasks/${task}/build`, {}, "omc_m1");
    expect(own.status).toBe(403);
    expect(own.json.error).toMatch(/another maintainer/);
    await env.DB.prepare(`INSERT OR IGNORE INTO factory_maintainers (login) VALUES ('m2')`).run();
    const asked = await call("POST", `/factory/tasks/${task}/build`, { note: "reads well" }, "omc_m2");
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    expect(asked.json).toMatchObject({ from: task, by: "m2", task: expect.any(Number) });
    expect((await call("POST", `/factory/tasks/${task}/build`, {}, "omc_m2")).status).toBe(409); // once at a time
    const t = await env.DB.prepare("SELECT trust, kind, pkgbuild_ref, publish, owner, params FROM build_tasks WHERE id = ?").bind(asked.json.task).first<{ trust: string; kind: string; pkgbuild_ref: string; publish: number; owner: string; params: string }>();
    expect(t).toMatchObject({ trust: "project", kind: "build", pkgbuild_ref: `review:${task}`, publish: 0, owner: "m1" });
    expect(JSON.parse(t!.params)).toMatchObject({ review: task, request: req, project: "https://github.com/alice/mine", by: "m2", description: null });
    // No build ever starts from the staged artifact itself.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE pkgbuild_ref LIKE 'staging:%' AND kind = 'build'").first<{ n: number }>())!.n).toBe(0);
    // The review row says the project is on it.
    const row = (await call("GET", "/factory/review")).json.staged.find((x: any) => x.id === task);
    expect(row).toMatchObject({ kind: "contributor", project_build: { id: asked.json.task, status: "queued" } });
    projectTask = asked.json.task;
  });

  let projectTask: number;
  let projectToken: string;

  it("the project's review build runs on a trusted worker with its agent, stages its own package and evidence, and queues its audit", async () => {
    // A worker whose agent is down is not handed it (a review build drafts with the agent); one whose agent answers is.
    expect((await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["build"], agent: "claude-code/claude-sonnet-5", agent_status: "error" }, "omw_w1")).status).toBe(204);
    const c = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["build"], agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w1");
    expect(c.status).toBe(200);
    expect(c.json.task.id).toBe(projectTask);
    expect(c.json.task.pkgbuild_ref).toBe(`review:${task}`);
    expect(c.json.upload).toBe(`/api/v1/factory/tasks/${projectTask}/artifacts/<filename>`);
    expect(c.json.pkgbuild_path).toBeNull();
    projectToken = c.json.token;
    // Everything to the project's staging space — no quota, its own prefix.
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", "tests.log", "mine-1.0-1-aarch64.pkg.tar.zst"]) {
      expect((await call("PUT", `/factory/tasks/${projectTask}/artifacts/${f}`, undefined, projectToken, `the project's ${f}`)).status).toBe(201);
    }
    await call("PUT", `/factory/tasks/${projectTask}/artifacts/vet.json`, undefined, projectToken, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "pass", checks: [{ name: "smoke", status: "pass", detail: "" }] }));
    expect((await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ? AND key LIKE '%PKGBUILD'").bind(projectTask).first<{ key: string }>())!.key).toBe(`staging/@project/mine/${projectTask}/PKGBUILD`);
    const st = await call("POST", `/factory/tasks/${projectTask}/complete`, { sha256: "e".repeat(64), filename: "mine-1.0-1-aarch64.pkg.tar.zst", version: "1.0-1", duration_ms: 90000 }, projectToken);
    expect(st.json.status).toBe("staged");
    expect(await env.DB.prepare("SELECT status, detail FROM factory_packages WHERE name = 'mine'").first()).toMatchObject({ status: "staged", detail: expect.stringMatching(/built by the project \(task \d+\), gate pass/) });
    // Its evidence is on the record, its audit queued, and the review shows it as the project's — the contributor's row points at it.
    expect(await env.PACKAGES.head(`factory/mine/${req}/build-${projectTask}/PKGBUILD`)).not.toBeNull();
    expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE kind = 'audit' AND json_extract(params, '$.task') = ?").bind(projectTask).first()).toMatchObject({ status: "queued" });
    const rows = (await call("GET", "/factory/review")).json.staged;
    expect(rows.find((x: any) => x.id === projectTask)).toMatchObject({ kind: "project", from: task, owner: "m1", vet: { verdict: "pass" }, trial: { status: "queued" } });
    expect(rows.find((x: any) => x.id === task)).toMatchObject({ project_build: { id: projectTask, status: "staged" }, trial: { status: "none" } });
    // The trial: queued for the project's build only, for its architecture; its worker reads the staged package and writes the lab, never a promised ring.
    const trial = await env.DB.prepare("SELECT id, arch, params FROM build_tasks WHERE kind = 'trial' AND json_extract(params, '$.task') = ?").bind(projectTask).first<{ id: number; arch: string; params: string }>();
    expect(trial).toMatchObject({ arch: "aarch64" });
    expect(JSON.parse(trial!.params)).toMatchObject({ task: projectTask, name: "mine", files: ["mine-1.0-1-aarch64.pkg.tar.zst"] });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE kind = 'trial' AND json_extract(params, '$.task') = ?").bind(task).first()).toMatchObject({ n: 0 });
    expect((await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["trial"] }, "omw_w3")).status).toBe(204); // community trust: builds only
    const tc = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["trial"] }, "omw_w1");
    expect(tc.status).toBe(200);
    expect(tc.json.task.id).toBe(trial!.id);
    const scopes = (await jobOf(new Request(API, { headers: { authorization: `Bearer ${tc.json.token}` } }), env))!.s;
    expect(scopes).toEqual(expect.arrayContaining([`staging:${projectTask}`, "pool:write", "release:lab", "artifacts:*:lab"]));
    expect(scopes.some((x: string) => x.startsWith("release:") && x !== "release:lab")).toBe(false);
    const tctx = createExecutionContext();
    expect((await worker.fetch(new Request(`${API}/factory/tasks/${projectTask}/artifacts/mine-1.0-1-aarch64.pkg.tar.zst`, { headers: { authorization: `Bearer ${tc.json.token}` } }), env, tctx)).status).toBe(200);
    await waitOnExecutionContext(tctx);
    // The transcript goes beside the evidence; the verdict on the row.
    expect((await call("PUT", `/factory/tasks/${projectTask}/artifacts/trial.log`, undefined, tc.json.token, "== pacman -S mine\nTRIAL=ok")).status).toBe(201);
    expect((await call("POST", `/factory/tasks/${trial!.id}/complete`, { result: { verdict: "ok", packages: ["mine"], task: projectTask }, duration_ms: 30000 }, tc.json.token)).json).toMatchObject({ status: "done" });
    const tried = (await call("GET", "/factory/review")).json.staged.find((x: any) => x.id === projectTask);
    expect(tried.trial).toEqual({ status: "done", verdict: "ok", packages: ["mine"] });
    expect(tried.evidence.trial).toBe(`/api/v1/factory/tasks/${projectTask}/artifacts/trial.log`);
    const tctx2 = createExecutionContext();
    const tl = await worker.fetch(new Request(`http://pool.test${tried.evidence.trial}`), env, tctx2);
    expect(tl.status).toBe(200);
    expect(await tl.text()).toContain("TRIAL=ok");
    await waitOnExecutionContext(tctx2);
  });

  it("a maintainer — never the owner, no exception — approves the project's build; a publish job carries it into the pool; the seal tells the chain", async () => {
    await env.DB.prepare(`DELETE FROM factory_maintainers WHERE login = 'm2'`).run();
    const sole = await call("POST", `/factory/tasks/${projectTask}/approve`, {}, "omc_m1");
    expect(sole.status).toBe(403);
    expect(sole.json.error).toMatch(/with one maintainer, that maintainer.s own packages wait/);
    await env.DB.prepare(`INSERT OR IGNORE INTO factory_maintainers (login) VALUES ('m2')`).run();
    const other = await call("POST", `/factory/tasks/${projectTask}/approve`, { note: "looks right" }, "omc_m2");
    expect(other.status, JSON.stringify(other.json)).toBe(200);
    expect(other.json).toMatchObject({ task: projectTask, decision: "approved", by: "m2", publish: expect.any(Number) });
    expect((await call("POST", `/factory/tasks/${projectTask}/approve`, {}, "omc_m2")).status).toBe(409);
    expect(await env.DB.prepare("SELECT task_id, rebuild_task FROM approvals ORDER BY id DESC LIMIT 1").first()).toEqual({ task_id: projectTask, rebuild_task: projectTask });
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'mine'").first()).toMatchObject({ status: "approved" });
    // The build's page reads one call: the row, the worker that built it, what it came from, its audit and trial, the decision, its evidence.
    const whole = await call("GET", `/factory/tasks/${projectTask}?whole=1`);
    expect(whole.status).toBe(200);
    expect(whole.json.task).toMatchObject({ id: projectTask, kind: "build", trust: "project", status: "staged" });
    expect(whole.json.from).toMatchObject({ id: task, owner: "alice" });
    expect(whole.json.approval).toMatchObject({ decision: "approved", by: "m2", note: "looks right" });
    expect(whole.json.trial[0]).toMatchObject({ kind: "trial", status: "done" });
    expect(whole.json.worker).toMatchObject({ id: "w1", trust: "project" });
    expect(whole.json.evidence.map((e: any) => e.name).sort()).toEqual(["PKGBUILD", "PKGINFO", "build.log", "mine-1.0-1-aarch64.pkg.tar.zst", "tests.log", "trial.log", "vet.json"]);
    expect(whole.json.evidence.find((e: any) => e.name === "PKGBUILD")).toMatchObject({ public: true, url: `/api/v1/factory/tasks/${projectTask}/artifacts/PKGBUILD` });
    expect(whole.json.evidence.find((e: any) => e.name.endsWith(".pkg.tar.zst")).public).toBe(false);
    expect(whole.json.publish[0]).toMatchObject({ kind: "publish", status: "queued" });
    // The chain and its score: the maintainer's half green (50), the contributor's with no gate, an audit still queued and a bare registration (15) — class C, and not "ready" because the audit never answered.
    expect(whole.json.chain).toMatchObject({ contributor: { id: task }, project: { id: projectTask }, approval: { by: "m2" } });
    expect(whole.json.score).toMatchObject({ points: 65, max: 100, class: "C", ready: false });
    expect(whole.json.score.items.filter((i: any) => i.who === "maintainer").reduce((n: number, i: any) => n + i.points, 0)).toBe(50);
    // The package's story: every chain with its class, the rings, for the package page — and a synced package has none.
    const story = await call("GET", "/factory/packages/mine/story");
    expect(story.status).toBe(200);
    expect(story.json).toMatchObject({ name: "mine", class: "C", package: { owner: "m1" } });
    expect(story.json.chains.find((c: any) => c.project && c.project.id === projectTask)).toMatchObject({ contributor: { id: task }, score: { points: 65 } });
    expect((await call("GET", "/factory/packages/zlib/story")).status).toBe(404);
    // A later build of the same name, version and architecture is nothing to decide: Review says so and keeps it out of the count.
    const again = await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, finished_at) VALUES ('mine', 'aarch64', '1.0-2', 'draft:x', 'built again', 100, 'staged', 0, 'community', 'alice', 'build', ?) RETURNING id").bind(new Date().toISOString()).first<{ id: number }>();
    try {
      const review = await call("GET", "/factory/review?already=1");
      const row = review.json.staged.find((r: any) => r.id === again!.id);
      expect(row.already).toMatchObject({ task: projectTask, by: "m2", rebuild_task: projectTask });
      // A build with no gate and no audit yet is not ready: the class column says D, the contributor's turn.
      expect(row.score).toMatchObject({ class: "D", ready: false });
      expect(review.json.staged.filter((r: any) => r.id !== again!.id).every((r: any) => r.already === null)).toBe(true);
      // The one number every tile reads leaves it out: listed, not waiting.
      expect(review.json.waiting).toBe(review.json.staged.length - 1);
    } finally {
      await env.DB.prepare("DELETE FROM build_tasks WHERE id = ?").bind(again!.id).run();
    }
    // An approval can be taken back by any maintainer, the reason on the record: void from then on, the package leaves the rings, the chain waits for another maintainer.
    expect((await call("POST", `/factory/tasks/${projectTask}/withdraw`, { note: "no" }, "omc_m2")).status).toBe(400);
    expect((await call("POST", `/factory/tasks/${projectTask}/withdraw`, { note: "approved by mistake" }, "omc_alice")).status).toBe(403);
    expect((await call("POST", `/factory/tasks/${task}/withdraw`, { note: "approved by its own contributor during the bootstrap" }, "omc_m1")).json).toMatchObject({ withdrawn: expect.any(Number), task: projectTask, rebuild_task: projectTask, by: "m1", rings: [] });
    expect((await call("POST", `/factory/tasks/${projectTask}/withdraw`, { note: "again" }, "omc_m1")).status).toBe(404);
    expect(await env.DB.prepare("SELECT withdrawn_by, withdrawn_reason FROM approvals WHERE task_id = ?").bind(projectTask).first()).toEqual({ withdrawn_by: "m1", withdrawn_reason: "approved by its own contributor during the bootstrap" });
    expect((await call("GET", `/factory/tasks/${projectTask}?after=withdraw`)).json).toMatchObject({ approval: { withdrawn_by: "m1" }, chain: { approval: null, withdrawn: { by: "m2", withdrawn_by: "m1" } }, score: { items: expect.arrayContaining([expect.objectContaining({ item: "A decision with a note", points: 0, state: "pending" })]) } });
    expect((await call("GET", "/factory/review?after=withdraw")).json.staged.map((r: any) => r.id)).toContain(projectTask); // the project's build waits again
    expect((await call("GET", "/factory/approvals?after=withdraw")).json.approvals[0]).toMatchObject({ task_id: projectTask, decision: "approved", withdrawn_by: "m1" });
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'mine'").first()).toMatchObject({ status: "staged" });
    expect((await env.DB.prepare("SELECT summary FROM events WHERE kind = 'withdraw' ORDER BY id DESC LIMIT 1").first<{ summary: string }>())!.summary).toContain("withdrawn by m1");
    // …and approved again, by the other maintainer, for the rest of the story.
    const back = await call("POST", `/factory/tasks/${projectTask}/approve`, { note: "looks right" }, "omc_m2");
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE id = ?").bind(other.json.publish).run(); // the first publish job, superseded by this one
    other.json.publish = back.json.publish;
    // The publish job: a project worker takes it; its token may read the staged package (a maintainer's privilege otherwise).
    const pub = await env.DB.prepare("SELECT kind, trust, params FROM build_tasks WHERE id = ?").bind(other.json.publish).first<{ kind: string; trust: string; params: string }>();
    expect(pub).toMatchObject({ kind: "publish", trust: "project" });
    // The trial installed it: the publish job carries that, and its token opens rc and stable — the fast lane.
    expect(JSON.parse(pub!.params)).toMatchObject({ task: projectTask, files: ["mine-1.0-1-aarch64.pkg.tar.zst"], by: "m2", trial: "ok" });
    const c = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["publish"] }, "omw_w1");
    expect(c.status).toBe(200);
    expect(c.json.task.id).toBe(other.json.publish);
    expect((await jobOf(new Request(API, { headers: { authorization: `Bearer ${c.json.token}` } }), env))!.s).toEqual(expect.arrayContaining(["release:edge", "release:rc", "release:stable", "artifacts:*:stable"]));
    const ctx = createExecutionContext();
    const pk = await worker.fetch(new Request(`${API}/factory/tasks/${projectTask}/artifacts/mine-1.0-1-aarch64.pkg.tar.zst`, { headers: { authorization: `Bearer ${c.json.token}` } }), env, ctx);
    expect(pk.status).toBe(200);
    expect(await pk.text()).toBe("the project's mine-1.0-1-aarch64.pkg.tar.zst");
    expect((await worker.fetch(new Request(`${API}/factory/tasks/${projectTask}/artifacts/mine-1.0-1-aarch64.pkg.tar.zst`), env, createExecutionContext())).status).toBe(403);
    // The worker publishes into the pool with the job token, renders, completes; the brain marks the registration published and writes the seal.
    const filename = "mine-1.0-1-aarch64.pkg.tar.zst";
    const bytes = new TextEncoder().encode("the project's build of mine");
    await env.PACKAGES.put(packageKey("factory", "aarch64", filename), bytes);
    const s = "e".repeat(64);
    const indexed = await call("POST", "/packages?source=factory&arch=aarch64", { schema_version: 1, name: "mine", version: "1.0-1", arch: "aarch64", sha256: s, filename, size_download: bytes.length, size_installed: 1, description: "mine", provides: ["mine"], requires: [], files: [] }, c.json.token);
    expect(indexed.status, JSON.stringify(indexed.json)).toBe(201);
    const done = await call("POST", `/factory/tasks/${c.json.task.id}/complete`, { summary: "published", result: { sha256: s, filename, version: "1.0-1", task: projectTask }, duration_ms: 5000 }, c.json.token);
    expect(done.json).toMatchObject({ status: "done" });
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'mine'").first()).toMatchObject({ status: "published" });
    expect(await env.DB.prepare("SELECT status, result_sha256 FROM build_tasks WHERE id = ?").bind(projectTask).first()).toMatchObject({ status: "done", result_sha256: s });
    // In the pool: the staging copies of the package — the project's, and the contributor's it learned from — are gone; both recipes stay.
    expect(await env.STAGING.head(`staging/@project/mine/${projectTask}/mine-1.0-1-aarch64.pkg.tar.zst`)).toBeNull();
    expect(await env.STAGING.head(`staging/alice/mine/${task}/mine-1.0-2-aarch64.pkg.tar.zst`)).toBeNull();
    expect(await env.STAGING.head(`staging/@project/mine/${projectTask}/PKGBUILD`)).not.toBeNull();
    expect(await env.STAGING.head(`staging/alice/mine/${task}/PKGBUILD`)).not.toBeNull();
    // The seal: the project's own build and recipe, learned from the contributor's, approved by m2.
    const seal = (await call("GET", `/packages/${s}/provenance`)).json;
    expect(seal).toMatchObject({ origin: "factory", seal: "built by the Omarchy Pool", name: "mine", version: "1.0-1" });
    expect(seal.chain).toMatchObject({
      builder: { worker: "w1", trust: "project" },
      build: { task: projectTask, arch: "aarch64", gate: { verdict: "pass" } },
      recipe: { ref: `review:${task}`, by: "the project's agent, from the evidence", pkgbuild: `/api/v1/factory/tasks/${projectTask}/artifacts/PKGBUILD`, learned_from: `/api/v1/factory/tasks/${task}/artifacts/PKGBUILD` },
      source_build: { task, worker: "w3", gate: null }, // the superseding build staged no vet.json
      approval: { by: "m2", note: "looks right", of_task: projectTask },
    });
    expect(seal.chain.audit).toMatchObject({ of_task: projectTask, verdict: null, status: "cancelled" });
    expect(seal.summary).toBe("built by the project on w1, approved by m2, signed by the pool");
    expect(seal.attestation.statement).toBe(`${env.POOL_URL}/factory/aarch64/${filename}.provenance.json`);
    const statement = JSON.parse(await (await env.PACKAGES.get(packageKey("factory", "aarch64", `${filename}.provenance.json`)))!.text());
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicate.approval.by).toBe("m2");
    // The decisions say how far the package got: no ring yet, then the rings that serve it, in order.
    const decided = (await call("GET", "/factory/approvals")).json.approvals.find((a: { name: string }) => a.name === "mine");
    expect(decided).toMatchObject({ decision: "approved", by: "m2", rings: [] });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ring_packages (ring, package_id) SELECT 'edge', id FROM packages WHERE sha256 = ?").bind(s),
      env.DB.prepare("INSERT INTO ring_packages (ring, package_id) SELECT 'lab', id FROM packages WHERE sha256 = ?").bind(s),
    ]);
    // (A query string past the edge cache, which keeps the answer for 30 s.)
    expect((await call("GET", "/factory/approvals?now=1")).json.approvals.find((a: { name: string }) => a.name === "mine").rings).toEqual(["lab", "edge"]);
    await env.DB.prepare("DELETE FROM ring_packages WHERE package_id IN (SELECT id FROM packages WHERE sha256 = ?)").bind(s).run();
  });

});

describe("promotion by evidence", () => {
  it("the last sync of a tick queues edge → rc, once; the promote itself decides", async () => {
    const pending = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE kind = 'promote' AND status = 'queued' AND json_extract(params, '$.to') = 'rc'").first<{ n: number }>())!.n;
    const before = await pending();
    const sync = async (arch: string) =>
      (await env.DB.prepare(`INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, priority, status, publish, trust, kind, params) VALUES ('sync', ?, '-', 'test', 50, 'queued', 1, 'project', 'sync', ?) RETURNING id`).bind(arch, JSON.stringify({ arch, sources: "[]" })).first<{ id: number }>())!.id;
    const a = await sync("aarch64"), b = await sync("aarch64");
    const ca = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["sync"] }, "omw_w1");
    expect(ca.json.task.id).toBe(a);
    const cb = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["sync"] }, "omw_w2");
    expect(cb.json.task.id).toBe(b);
    // The first sync done while the other still runs: nothing queued yet.
    expect((await call("POST", `/factory/tasks/${a}/complete`, { result: { arch: "aarch64" }, duration_ms: 1000 }, ca.json.token)).json).toMatchObject({ status: "done" });
    expect(await pending()).toBe(before);
    // The last one: edge → rc queued, by evidence.
    expect((await call("POST", `/factory/tasks/${b}/complete`, { result: { arch: "aarch64" }, duration_ms: 1000 }, cb.json.token)).json).toMatchObject({ status: "done" });
    expect(await pending()).toBe(before + 1);
    const promote = await env.DB.prepare("SELECT params, reason FROM build_tasks WHERE kind = 'promote' AND status = 'queued' ORDER BY id DESC LIMIT 1").first<{ params: string; reason: string }>();
    expect(JSON.parse(promote!.params)).toMatchObject({ from: "edge", to: "rc" });
    expect(promote!.reason).toBe(`sync ${b} done`);
    // Another sync done while that promote still waits: not a second one.
    const c = await sync("aarch64");
    const cc = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["sync"] }, "omw_w1");
    expect(cc.json.task.id).toBe(c);
    await call("POST", `/factory/tasks/${c}/complete`, { result: {}, duration_ms: 1000 }, cc.json.token);
    expect(await pending()).toBe(before + 1);
  });
});

describe("a recipe's failure", () => {
  it("fails at once when the worker says it is final, and the package says why; the infrastructure's is retried", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('broken', 'alice', 'https://github.com/alice/broken', '["aarch64"]', 'waiting')`),
      env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('broken', 'aarch64', '1.0-1', 'https://github.com/alice/broken@HEAD:PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build')`),
    ]);
    // A download that broke: back in the queue, as before.
    let c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.status).toBe(200);
    const id = c.json.task.id;
    const transient = await call("POST", `/factory/tasks/${id}/fail`, { error: "exit 4: curl: (28) Connection timed out", final: false }, c.json.token);
    expect(transient.json).toMatchObject({ status: "queued", attempts: 1 });
    expect((await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'broken'").first<{ status: string }>())!.status).toBe("building");
    // The recipe's: failed now, two attempts unspent, the package back to registered with the reason.
    c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.json.task.id).toBe(id);
    const final = await call("POST", `/factory/tasks/${id}/fail`, { error: "exit 4: error: target not found: ghostty", final: true }, c.json.token);
    expect(final.json).toMatchObject({ status: "failed", attempts: 2 });
    expect((await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3")).status).toBe(204);
    const pkg = await env.DB.prepare("SELECT status, detail FROM factory_packages WHERE name = 'broken'").first<{ status: string; detail: string }>();
    expect(pkg).toMatchObject({ status: "registered", detail: "build failed on w3: exit 4: error: target not found: ghostty" });
  });
});

describe("an expired lease", () => {
  it("puts the package back to waiting with the task, and to registered with the reason when the attempts are spent", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('orphan', 'alice', 'https://github.com/alice/orphan', '["aarch64"]', 'waiting')`),
      env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, max_attempts) VALUES ('orphan', 'aarch64', '1.0-1', 'https://github.com/alice/orphan@HEAD:PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build', 2)`),
    ]);
    const status = async () => (await env.DB.prepare("SELECT status, detail FROM factory_packages WHERE name = 'orphan'").first<{ status: string; detail: string | null }>())!;
    // The worker took it and died: the lease runs out.
    let c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.status).toBe(200);
    const id = c.json.task.id;
    expect((await status()).status).toBe("building");
    await env.DB.prepare("UPDATE build_tasks SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").bind(id).run();
    expect(await requeueExpiredLeases(env)).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(id).first()).toMatchObject({ status: "queued" });
    expect(await status()).toEqual({ status: "waiting", detail: "lease by w3 expired; queued again" });
    // Again, and that was the last attempt.
    c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.json.task.id).toBe(id);
    await env.DB.prepare("UPDATE build_tasks SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").bind(id).run();
    expect(await requeueExpiredLeases(env)).toBe(1);
    expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE id = ?").bind(id).first()).toMatchObject({ status: "failed", error: "lease by w3 expired" });
    expect(await status()).toEqual({ status: "registered", detail: "build failed on w3: lease by w3 expired (the worker stopped mid-build?)" });
    expect(await requeueExpiredLeases(env)).toBe(0);
  });
});

describe("a package request", () => {
  const checklist = { official: true, license: true, unshipped: true, evidence: true };
  it("is checked before anything is written: the checklist, the description, the licence, the source", async () => {
    expect((await call("POST", "/factory/packages", { url: "https://example.org/htop" })).status).toBe(401);
    const noList = await call("POST", "/factory/packages", { url: "https://htop.dev", source: "https://github.com/htop-dev/htop/archive/refs/tags/3.5.3.tar.gz", version: "3.5.3", description: "Interactive process viewer", license: "GPL-2.0-only" }, "omc_alice");
    expect(noList.status).toBe(400);
    expect(noList.json.error).toMatch(/confirm the checklist/);
    expect((await call("POST", "/factory/packages", { url: "https://htop.dev", source: "https://x/y.tar.gz", version: "3.5.3", description: "short", license: "GPL-2.0-only", checklist }, "omc_alice")).json.error).toMatch(/description/);
    expect((await call("POST", "/factory/packages", { url: "https://htop.dev", source: "https://x/y.tar.gz", version: "3.5.3", description: "Interactive process viewer", license: "GPL v2", checklist }, "omc_alice")).json.error).toMatch(/SPDX/);
    expect((await call("POST", "/factory/packages", { url: "https://htop.dev", version: "3.5.3", description: "Interactive process viewer", license: "GPL-2.0-only", checklist }, "omc_alice")).json.error).toMatch(/source is required/);
  });

  it("is written once to the record, signed when the pool signs, and registered for the contributor", async () => {
    const body = { name: "htop", url: "https://htop.dev/", source: "https://github.com/htop-dev/htop/archive/refs/tags/3.5.3.tar.gz", version: "3.5.3", description: "Interactive process viewer", license: "GPL-2.0-only", arches: ["aarch64"], checklist };
    const r = await call("POST", "/factory/packages", body, "omc_alice");
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.package).toMatchObject({ name: "htop", owner: "alice", project: "https://htop.dev", source: body.source, release: "3.5.3", description: body.description, license: "GPL-2.0-only", status: "registered" });
    expect(r.json.request).toMatchObject({ id: expect.any(Number), record: `${env.POOL_URL}/factory/htop/${r.json.request.id}/request.json`, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const obj = await env.PACKAGES.get(`factory/htop/${r.json.request.id}/request.json`);
    const record = JSON.parse(await obj!.text());
    expect(record).toMatchObject({ schema: "omarchy-pool/package-request/1", name: "htop", project: "https://htop.dev", version: "3.5.3", requested_by: "alice", arches: ["aarch64"] });
    expect(Object.keys(record.checklist)).toEqual(["official", "license", "unshipped", "evidence"]);
    // The same project under another name, or the same name by someone else, is refused; the owner may renew their own.
    expect((await call("POST", "/factory/packages", { ...body, name: "htop2" }, "omc_alice")).status).toBe(409);
    expect((await call("POST", "/factory/packages", body, "omc_m2")).status).toBe(409);
    // The build starts by itself, into the shared queue: one task per architecture the request names, its place in the queue in the answer.
    expect(r.json.build).toMatchObject({ tasks: [expect.any(Number)], arches: ["aarch64"], pinned_to: null, queue: { aarch64: { position: expect.any(Number), total: expect.any(Number) } } });
    expect(await env.DB.prepare("SELECT status, shared_after, pinned_to FROM build_tasks WHERE id = ?").bind(r.json.build.tasks[0]).first()).toEqual({ status: "queued", shared_after: null, pinned_to: null });
    const renewed = await call("POST", "/factory/packages", { ...body, version: "3.5.4", source: body.source.replace("3.5.3", "3.5.4") }, "omc_alice");
    expect(renewed.status).toBe(200);
    expect(renewed.json.request.id).toBeGreaterThan(r.json.request.id);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM package_requests WHERE name = 'htop'").first<{ n: number }>())!.n).toBe(2);
    // The old request's queued build leaves the queue; the renewed request queues its own.
    expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE id = ?").bind(r.json.build.tasks[0]).first()).toMatchObject({ status: "cancelled", error: expect.stringMatching(/renewed/) });
    expect(renewed.json.build.tasks[0]).toBeGreaterThan(r.json.build.tasks[0]);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE name = 'htop' AND status = 'queued'").run();
    // A blocked contributor requests nothing and builds nothing.
    await env.DB.prepare("UPDATE contributors SET blocked_at = '2026-09-15T00:00:00Z', blocked_by = 'm1', blocked_reason = 'spam' WHERE login = 'alice'").run();
    expect((await call("POST", "/factory/packages", { ...body, name: "htop3", url: "https://htop.dev/x" }, "omc_alice")).status).toBe(403);
    expect((await call("POST", "/factory/packages/htop/build", {}, "omc_alice")).status).toBe(403);
    await env.DB.prepare("UPDATE contributors SET blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL WHERE login = 'alice'").run();
  });

  it("gives a registration made before requests existed its record, from the staged PKGBUILD", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, detected, status, created_at) VALUES ('older', 'alice', 'https://github.com/alice/recipes', '["aarch64"]', '{"latest_tag":"v9"}', 'staged', '2026-09-14T10:00:00Z')`),
      // A staged build of the version the record will name, through the gate and audited: only the request keeps it from being ready.
      env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix, result) VALUES ('older', 'aarch64', '9', 'https://github.com/alice/recipes@HEAD:older/PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build', 'staged', 'staging/alice/older/1/', '{"vet":{"verdict":"pass","fails":0,"warnings":0}}')`),
    ]);
    const task = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'older'").first<{ id: number }>())!.id;
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, params, result) VALUES ('older', 'aarch64', '9', 'audit', 'audit', 50, 0, 'project', NULL, 'audit', 'done', ?, '{"verdict":"ok","findings":[],"model":"test"}')`).bind(JSON.stringify({ task })).run();
    await env.STAGING.put(`staging/alice/older/${task}/PKGBUILD`, "pkgname=older\npkgdesc=\"An older tool\"\nurl=\"https://github.com/upstream/older\"\nlicense=('Apache-2.0')\n");
    const { backfillRequests } = await import("../src/requests");
    expect(await backfillRequests(env)).toMatch(/older → \d+/);
    const pkg = await env.DB.prepare("SELECT request_id, project, description, license FROM factory_packages WHERE name = 'older'").first<{ request_id: number; project: string; description: string; license: string }>();
    expect(pkg).toMatchObject({ project: "https://github.com/upstream/older", description: "An older tool", license: "Apache-2.0" });
    const record = JSON.parse(await (await env.PACKAGES.get(`factory/older/${pkg!.request_id}/request.json`))!.text());
    expect(record).toMatchObject({ migrated: { pkgbuild_of_task: task }, version: "v9", source: "https://github.com/upstream/older/archive/refs/tags/v9.tar.gz" });
    expect(await backfillRequests(env)).toBe("");
    // The story checks the request as the form checks it today: a migrated record confirmed nothing, so the package is not ready for a maintainer until its owner renews it — from the page, the same form filled from the record.
    const story = await call("GET", "/factory/packages/older/story");
    expect(story.status).toBe(200);
    expect(story.json.request).toMatchObject({ id: pkg!.request_id, version: "v9", migrated: true, complete: false, record: `${env.POOL_URL}/factory/older/${pkg!.request_id}/request.json`, arches: ["aarch64"] });
    expect(story.json.request.checks.map((c: any) => [c.key, c.ok])).toEqual([["project", true], ["source", true], ["description", true], ["license", true], ["checklist", false], ["record", true]]);
    expect(story.json.request.checks.find((c: any) => c.key === "checklist").note).toMatch(/before the request form/);
    expect(story.json.package.arches).toEqual(["aarch64"]);
    expect(story.json.chains[0].score).toMatchObject({ ready: false });
    expect(story.json.chains[0].score.items.find((i: any) => i.item === "A request on the record")).toMatchObject({ points: 2, note: expect.stringMatching(/renew/) });
    // Review sees the same: the staged build — gate passed, audit ok — is not ready for the request alone, and says why in the score.
    const row = (await call("GET", "/factory/review?t=before")).json.staged.find((x: any) => x.name === "older");
    expect(row.score).toMatchObject({ ready: false, points: 47 }); // 50 for the half, less the 3 the request loses
    // The owner renews it while it is staged (nothing is being built): a new request, complete, and the same package is ready again.
    const body = { name: "older", url: "https://older.example", source: "https://older.example/older-9.tar.gz", version: "9", description: "An older tool", license: "Apache-2.0", arches: ["aarch64"], checklist: { official: true, license: true, unshipped: true, evidence: true } };
    const renewed = await call("POST", "/factory/packages", body, "omc_alice");
    expect(renewed.status, JSON.stringify(renewed.json)).toBe(200);
    expect(renewed.json.request.id).toBeGreaterThan(pkg!.request_id);
    // The staged package stays staged; the build stands and is ready now.
    expect(renewed.json.package).toMatchObject({ status: "staged", detail: expect.stringMatching(/renewed as #\d+ \(9\) by alice; the staged build stands/) });
    const after = (await call("GET", "/factory/packages/older/story?t=renewed")).json; // past the edge cache, as the page reads its own
    expect(after.request).toMatchObject({ id: renewed.json.request.id, migrated: false, complete: true });
    const stagedChain = after.chains.find((x: any) => x.contributor && x.contributor.id === task);
    expect(stagedChain.score).toMatchObject({ ready: true });
    expect(stagedChain.score.items.find((i: any) => i.item === "A request on the record")).toMatchObject({ points: 5 });
    // The renewal queued a build of its own; it stands in the shared queue with a place.
    expect(after.chains[0].contributor).toMatchObject({ status: "queued", queue: { position: expect.any(Number), total: expect.any(Number) } });
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE name = 'older' AND status = 'queued'").run();
    expect((await call("GET", "/factory/review?t=after")).json.staged.find((x: any) => x.name === "older").score).toMatchObject({ ready: true });
    // A request that names another version than the staged build is not that build's: the contributor builds again.
    const other = await call("POST", "/factory/packages", { ...body, version: "10", source: "https://older.example/older-10.tar.gz" }, "omc_alice");
    expect(other.status).toBe(200);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE name = 'older' AND status = 'queued'").run();
    const moved = (await call("GET", "/factory/packages/older/story?t=moved")).json;
    const stale = moved.chains.find((x: any) => x.contributor && x.contributor.id === task);
    expect(stale.score).toMatchObject({ ready: false });
    expect(stale.score.items.find((i: any) => i.item === "A request on the record")).toMatchObject({ points: 2, note: expect.stringMatching(/names 10, this build is 9 — build again/) });
    // A build in flight — the project's included, whose lease never touches the package's status — keeps the request as it is.
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, params) VALUES ('older', 'aarch64', '9', 'review:${task}', 'project build', 30, 0, 'project', 'alice', 'build', 'leased', '{"review":${task}}')`).run();
    const busy = await call("POST", "/factory/packages", body, "omc_alice");
    expect(busy.status).toBe(409);
    expect(busy.json.error).toMatch(/being built \(task \d+, the project.s\)/);
    await env.DB.prepare("DELETE FROM build_tasks WHERE name = 'older' AND trust = 'project' AND status = 'leased'").run();
    // In the pool, the record is what it was: the next version's request goes through the form.
    await env.DB.prepare("UPDATE factory_packages SET status = 'published' WHERE name = 'older'").run();
    expect((await call("POST", "/factory/packages", body, "omc_alice")).json.error).toMatch(/not once it is in the pool/);
  });
});

describe("where a build runs", () => {
  const checklist = { official: true, license: true, unshipped: true, evidence: true };
  const req = (name: string) => ({ name, url: `https://${name}.example`, source: `https://${name}.example/${name}-1.tar.gz`, version: "1", description: "A tool for the test", license: "MIT", arches: ["aarch64"], checklist });
  it("a request lands in the shared queue at once — any contributor's shared worker takes it, the owner's own worker too — and says where it stands; the owner takes it out and puts it back", async () => {
    // carol has no worker; w5 is a community worker shared by carol's fellow contributor dave — sharing is anyone's to offer.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contributors (login, token_hash, role) VALUES ('carol', ?, 'contributor'), ('dave', ?, 'contributor')").bind(await sha256Hex("omc_carol"), await sha256Hex("omc_dave")),
      env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, last_seen) VALUES ('w5', 'aarch64', 'dave', ?, 'shared', 'community', '2000-01-01T00:00:00Z')").bind(await sha256Hex("omw_w5")),
    ]);
    const made = await call("POST", "/factory/packages", req("noworker"), "omc_carol");
    expect(made.status).toBe(201);
    const first = made.json.build.tasks[0];
    expect(await env.DB.prepare("SELECT status, shared_after, pinned_to FROM build_tasks WHERE id = ?").bind(first).first()).toEqual({ status: "queued", shared_after: null, pinned_to: null });
    // Its place: the queue of its architecture, among the builds any shared worker may take.
    const story = (await call("GET", "/factory/packages/noworker/story?t=queued")).json;
    expect(story.chains[0].contributor.queue).toEqual({ position: expect.any(Number), total: expect.any(Number) });
    expect(story.chains[0].contributor.queue.position).toBeLessThanOrEqual(story.chains[0].contributor.queue.total);
    // Out of the queue by its owner (nobody else), and nothing puts it back by itself.
    expect((await call("DELETE", `/factory/packages/noworker/builds/${first}`, undefined, "omc_alice")).status).toBe(403);
    expect((await call("DELETE", `/factory/packages/noworker/builds/${first}`, undefined, "omc_carol")).json).toMatchObject({ task: first, status: "cancelled" });
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'noworker'").first()).toEqual({ status: "registered" });
    expect((await call("DELETE", `/factory/packages/noworker/builds/${first}`, undefined, "omc_carol")).status).toBe(409);
    // Back in, by the Build button — the queue again, or a worker.
    const back = await call("POST", "/factory/packages/noworker/build", {}, "omc_carol");
    expect(back.status).toBe(201);
    expect(back.json.tasks[0]).toBeGreaterThan(first);
    expect(back.json.queue.aarch64).toEqual({ position: expect.any(Number), total: expect.any(Number) });
    // dave's shared worker takes carol's build; a dedicated worker (w3, alice's) never does.
    expect((await call("POST", "/factory/claim", { arch: "aarch64", agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w3")).status).toBe(204);
    const c = await call("POST", "/factory/claim", { arch: "aarch64", shared: true, agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w5");
    expect(c.status).toBe(200);
    expect(c.json.task.id).toBe(back.json.tasks[0]);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE name = 'noworker' AND status IN ('queued', 'leased')").run();
    // alice's own request: her own worker w3 takes it at once as well.
    const mine = await call("POST", "/factory/packages", req("hasworker"), "omc_alice");
    expect(mine.status).toBe(201);
    const c3 = await call("POST", "/factory/claim", { arch: "aarch64", agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w3");
    expect(c3.status).toBe(200);
    expect(c3.json.task.id).toBe(mine.json.build.tasks[0]);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE name = 'hasworker' AND status IN ('queued', 'leased')").run();
  });
  it("a build asked for one worker is claimed by that worker only; a worker that is not theirs and not shared is refused; a hint and the last failed build travel with it", async () => {
    // alice's failed build of hasworker is the lesson for the next one; she asks for w5 (shared by m1), with a hint.
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, error) VALUES ('hasworker', 'aarch64', '1', 'draft:https://hasworker.example@1', 'contributor', 100, 0, 'community', 'alice', 'build', 'failed', 'exit 4: no')").run();
    const failed = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'hasworker' AND status = 'failed'").first<{ id: number }>())!.id;
    expect((await call("POST", "/factory/packages/hasworker/build", { arches: ["aarch64"], worker: "w1" }, "omc_alice")).status).toBe(403); // the project's, never a contributor's build
    const p = await call("POST", "/factory/packages/hasworker/build", { worker: "w5", hint: "the binary is called hw; build with make PREFIX=/usr" }, "omc_alice"); // one architecture registered: the worker's
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    expect(p.json).toMatchObject({ pinned_to: "w5", lessons: { aarch64: failed } });
    const task = await env.DB.prepare("SELECT pinned_to, shared_after, params FROM build_tasks WHERE id = ?").bind(p.json.tasks[0]).first<{ pinned_to: string; shared_after: string | null; params: string }>();
    expect(task).toMatchObject({ pinned_to: "w5", shared_after: null });
    expect(JSON.parse(task!.params)).toEqual({ lesson: failed, hint: "the binary is called hw; build with make PREFIX=/usr" });
    // w3 (alice's own) does not get it; w5 does, and the claim hands the params over.
    expect((await call("POST", "/factory/claim", { arch: "aarch64", agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w3")).status).toBe(204);
    const c = await call("POST", "/factory/claim", { arch: "aarch64", shared: true, agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w5");
    expect(c.status).toBe(200);
    expect(c.json.task).toMatchObject({ id: p.json.tasks[0], params: { lesson: failed, hint: expect.stringMatching(/^the binary/) } });
    // Asked again while it waits, with the default choice: unpinned, the rule again (hers first); the same task.
    // (w5 leased it above: a build that runs is not re-routed, nothing new is queued, and the answer says so.)
    const re = await call("POST", "/factory/packages/hasworker/build", { arches: ["aarch64"] }, "omc_alice");
    expect(re.status).toBe(200);
    expect(re.json).toMatchObject({ tasks: [], building: [{ task: p.json.tasks[0], arch: "aarch64", on: "w5" }], note: expect.stringMatching(/^already building/) });
    await env.DB.prepare("UPDATE build_tasks SET status = 'queued', lease_owner = NULL WHERE id = ?").bind(p.json.tasks[0]).run();
    const re2 = await call("POST", "/factory/packages/hasworker/build", { arches: ["aarch64"], hint: "try again" }, "omc_alice");
    expect(re2.status).toBe(201);
    expect(await env.DB.prepare("SELECT pinned_to, params FROM build_tasks WHERE id = ?").bind(p.json.tasks[0]).first()).toMatchObject({ pinned_to: null, params: expect.stringContaining('"hint":"try again"') });
    // Pinned again, then the worker is revoked: the build goes back to any worker that qualifies, at once.
    expect((await call("POST", "/factory/packages/hasworker/build", { arches: ["aarch64"], worker: "w5" }, "omc_alice")).status).toBe(201);
    expect((await call("DELETE", "/factory/workers/w5", undefined, "omc_m1")).json).toMatchObject({ revoked: "w5", freed: 1 });
    expect(await env.DB.prepare("SELECT pinned_to, shared_after FROM build_tasks WHERE id = ?").bind(p.json.tasks[0]).first()).toEqual({ pinned_to: null, shared_after: null });
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE name = 'hasworker' AND status IN ('queued', 'leased')").run();
    // A build after a rejection (cancelled) or one the gate stopped (staged) is the lesson too, not only a failed one.
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix, result) VALUES ('hasworker', 'aarch64', '1', 'draft:https://hasworker.example@1', 'contributor', 100, 0, 'community', 'alice', 'build', 'staged', 'staging/alice/hasworker/9/', '{\"vet\":{\"verdict\":\"fail\",\"fails\":1,\"warnings\":0}}')").run();
    const gated = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'hasworker' AND status = 'staged' ORDER BY id DESC").first<{ id: number }>())!.id;
    const after = await call("POST", "/factory/packages/hasworker/build", { arches: ["aarch64"] }, "omc_alice");
    expect(after.json.lessons).toEqual({ aarch64: gated });
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE name = 'hasworker' AND status IN ('queued', 'leased')").run();
  });
  it("the best idle shared worker has first pick — native over emulated, then cores — for three minutes; then any shared worker takes the build", async () => {
    // w7: dave's second shared worker, native, 12 cores, idle and just seen; w5 claims as emulated with 4 cores.
    await env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, last_seen, labels, usage, agent_status, current_task) VALUES ('w7', 'aarch64', 'dave', ?, 'shared', 'community', ?, '{\"where\":\"big\"}', '{\"cpu\":1,\"ram\":1,\"disk\":1,\"cores\":12,\"ram_gb\":32}', 'ok', NULL)").bind(await sha256Hex("omw_w7"), new Date().toISOString()).run();
    await env.DB.prepare("UPDATE build_workers SET revoked_at = NULL WHERE id = 'w5'").run();
    const made = await call("POST", "/factory/packages/noworker/build", {}, "omc_carol");
    expect(made.status).toBe(201);
    const id = made.json.tasks[0];
    const emu = { arch: "aarch64", shared: true, labels: { emulated: true }, usage: { cpu: 1, ram: 1, disk: 1, cores: 4, ram_gb: 16 }, agent: "claude-code/claude-sonnet-5", agent_status: "ok" };
    expect((await call("POST", "/factory/claim", emu, "omw_w5")).status).toBe(204); // w7 is better and idle: first pick is its
    // w7 busy (a task in hand): the emulated one takes it after all.
    await env.DB.prepare("UPDATE build_workers SET current_task = 1 WHERE id = 'w7'").run();
    const c = await call("POST", "/factory/claim", emu, "omw_w5");
    expect(c.status).toBe(200);
    expect(c.json.task.id).toBe(id);
    await env.DB.prepare("UPDATE build_tasks SET status = 'queued', lease_owner = NULL, created_at = ? WHERE id = ?").bind(new Date(Date.now() - 4 * 60000).toISOString(), id).run();
    await env.DB.prepare("UPDATE build_workers SET current_task = NULL, last_seen = ? WHERE id = 'w7'").bind(new Date().toISOString()).run();
    // Older than three minutes: w7 idle or not, the build is anyone's.
    const c2 = await call("POST", "/factory/claim", emu, "omw_w5");
    expect(c2.status).toBe(200);
    expect(c2.json.task.id).toBe(id);
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE name = 'noworker' AND status IN ('queued', 'leased')").run();
    await env.DB.prepare("UPDATE build_workers SET revoked_at = '2026-01-01T00:00:00Z' WHERE id = 'w7'").run();
  });
  it("a maintainer names the project's worker for the project's build — one that builds this architecture", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status, project, source, description, license) VALUES ('pinme', 'alice', 'https://pinme.example', '[\"aarch64\"]', 'staged', 'https://pinme.example', 'https://pinme.example/pinme-1.tar.gz', 'A tool for the test', 'MIT')"),
      env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix) VALUES ('pinme', 'aarch64', '1', 'draft:https://pinme.example@1', 'contributor', 100, 0, 'community', 'alice', 'build', 'staged', 'staging/alice/pinme/1/')"),
    ]);
    const staged = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'pinme'").first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES ('w6', 'aarch64', 'm1', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z')").bind(await sha256Hex("omw_w6")).run();
    expect((await call("POST", `/factory/tasks/${staged}/build`, { worker: "w3" }, "omc_m2")).status).toBe(400); // a contributor's worker never builds for the project
    expect((await call("POST", `/factory/tasks/${staged}/build`, { worker: "w6" }, "omc_m2")).json.error).toMatch(/no agent that answers/); // pinned to it, the build would wait forever
    expect((await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["build"], agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w6")).status).toBeLessThan(300); // now it builds, with an agent
    expect((await call("POST", `/factory/tasks/${staged}/build`, { worker: "w1" }, "omc_m2")).json.error).toMatch(/does not take builds/); // w1 declared sync last
    const ok = await call("POST", `/factory/tasks/${staged}/build`, { worker: "w6", note: "native, please — link against system zlib" }, "omc_m2");
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.pinned_to).toBe("w6");
    // The maintainer's note is the hint the project's agent drafts with.
    expect(JSON.parse((await env.DB.prepare("SELECT params FROM build_tasks WHERE id = ?").bind(ok.json.task).first<{ params: string }>())!.params)).toMatchObject({ review: staged, note: "native, please — link against system zlib", hint: "native, please — link against system zlib" });
    // Another project worker never gets it (whatever else is queued for it).
    const other = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["build"], agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w1");
    if (other.status === 200) expect(other.json.task.id).not.toBe(ok.json.task);
    const c = await call("POST", "/factory/claim", { arch: "aarch64", kinds: ["build"], agent: "claude-code/claude-sonnet-5", agent_status: "ok" }, "omw_w6");
    expect(c.status).toBe(200);
    expect(c.json.task).toMatchObject({ id: ok.json.task, pinned_to: "w6" });
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled' WHERE name = 'pinme' AND status IN ('queued', 'leased')").run();
  });
});

describe("staging quota", () => {
  it("a PUT and a multipart create are refused once the contributor is over the quota; a failed build gives its package back; the owner drops the rest", async () => {
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('pad', 'aarch64', '1-1', 'https://github.com/alice/recipes@HEAD:pad/PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
    const c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.status).toBe(200);
    const id = c.json.task.id;
    const job = c.json.token as string;
    // How full the owner's workspace is travels with the claim: the worker fails fast at the quota instead of building into a 413.
    expect(c.json.staging).toMatchObject({ quota_bytes: STAGING_QUOTA_BYTES });
    expect(typeof c.json.staging.bytes).toBe("number");
    await env.DB.prepare("INSERT INTO staging_objects (key, owner, task_id, size) VALUES (?, 'alice', ?, ?), (?, 'alice', ?, 1)").bind(`staging/alice/pad/${id}/pad.bin`, id, STAGING_QUOTA_BYTES, `staging/alice/pad/${id}/build.log`, id).run();
    const full = await call("PUT", `/factory/tasks/${id}/artifacts/PKGBUILD`, undefined, job, "pkgname=pad\n");
    expect(full.status).toBe(413);
    expect(full.json).toMatchObject({ quota_bytes: STAGING_QUOTA_BYTES });
    expect(full.json.error).toMatch(/DELETE \/api\/v1\/factory\/tasks\/<id>\/artifacts/);
    expect((await call("POST", `/factory/tasks/${id}/artifacts/pad-1-1-aarch64.pkg.tar.zst/multipart?action=create`, {}, job)).status).toBe(413);
    // The object that fills the quota is the one being uploaded again (a lease that died half-way): it does not count against itself.
    const again = await call("POST", `/factory/tasks/${id}/artifacts/pad.bin/multipart?action=create`, {}, job);
    expect(again.status, JSON.stringify(again.json)).toBe(201);
    expect((await call("POST", `/factory/tasks/${id}/artifacts/pad.bin/multipart?action=abort&upload_id=${again.json.upload_id}`, {}, job)).status).toBe(200);
    expect((await call("DELETE", `/factory/tasks/${id}/artifacts`, undefined, "omc_alice")).status).toBe(409);
    // Failed for good: the package it had landed goes at once; the log stays for the owner (and the record).
    expect((await call("POST", `/factory/tasks/${id}/fail`, { error: "quota", final: true }, job)).status).toBe(200);
    expect((await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ?").bind(id).all<{ key: string }>()).results.map((r) => r.key)).toEqual([`staging/alice/pad/${id}/build.log`]);
    const gone = await call("DELETE", `/factory/tasks/${id}/artifacts`, undefined, "omc_alice");
    expect(gone.status, JSON.stringify(gone.json)).toBe(200);
    expect(gone.json.deleted).toBe(1);
    expect((await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM staging_objects WHERE task_id = ?").bind(id).first<{ bytes: number }>())!.bytes).toBe(0);
    expect((await call("DELETE", `/factory/tasks/${id}/artifacts`, undefined, "omc_m2")).json.deleted).toBe(0);
  });

  it("a multipart complete that overflows leaves neither the object nor a row behind", async () => {
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('pad', 'aarch64', '1-2', 'https://github.com/alice/recipes@HEAD:pad/PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
    const c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    const id = c.json.task.id;
    const job = c.json.token as string;
    // One byte short of 2 GiB elsewhere, and a stale row for the key about to be written: the upload itself is what overflows.
    const before = (await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM staging_objects WHERE owner = 'alice'").first<{ bytes: number }>())!.bytes;
    const pad = STAGING_QUOTA_BYTES - before - 1;
    await env.DB.prepare("INSERT INTO staging_objects (key, owner, task_id, size) VALUES (?, 'alice', ?, ?), (?, 'alice', ?, 1)")
      .bind(`staging/alice/pad/${id}/pad.bin`, id, pad, `staging/alice/pad/${id}/big.bin`, id)
      .run();
    const up = await call("POST", `/factory/tasks/${id}/artifacts/big.bin/multipart?action=create`, {}, job);
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    const part = await call("POST", `/factory/tasks/${id}/artifacts/big.bin/multipart?action=part&part=1&upload_id=${up.json.upload_id}`, undefined, job, "x".repeat(16));
    expect(part.status, JSON.stringify(part.json)).toBe(200);
    const done = await call("POST", `/factory/tasks/${id}/artifacts/big.bin/multipart?action=complete&upload_id=${up.json.upload_id}`, { parts: [{ partNumber: 1, etag: part.json.etag }] }, job);
    expect(done.status, JSON.stringify(done.json)).toBe(413);
    expect(await env.STAGING.head(`staging/alice/pad/${id}/big.bin`)).toBeNull();
    expect((await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM staging_objects WHERE owner = 'alice'").first<{ bytes: number }>())!.bytes).toBe(before + pad);
    await env.DB.prepare("DELETE FROM staging_objects WHERE task_id = ?").bind(id).run();
    await call("POST", `/factory/tasks/${id}/fail`, { error: "quota", final: true }, job);
  });

  it("dropping a staged build cancels it with its audit and sends the package back — never from under the project's build", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('pad', 'alice', 'https://github.com/alice/pad', '["aarch64"]', 'building')`),
      env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('pad', 'aarch64', '1-3', 'draft:https://github.com/alice/pad@latest', 'contributor', 100, 0, 'community', 'alice', 'build')`),
    ]);
    const c = await call("POST", "/factory/claim", { arch: "aarch64", agent: "openai/gpt-5", agent_status: "ok" }, "omw_w3");
    expect(c.status).toBe(200);
    const id = c.json.task.id;
    for (const f of ["PKGBUILD", "build.log", "pad-1-3-aarch64.pkg.tar.zst"]) await call("PUT", `/factory/tasks/${id}/artifacts/${f}`, undefined, c.json.token, `evidence ${f}`);
    const st = await call("POST", `/factory/tasks/${id}/complete`, { sha256: "f".repeat(64), filename: "pad-1-3-aarch64.pkg.tar.zst", version: "1-3" }, c.json.token);
    expect(st.json?.status, JSON.stringify({ claim: c.json, complete: st.json })).toBe("staged");
    expect((await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'pad'").first())!.status).toBe("staged");
    const audit = await env.DB.prepare("SELECT id FROM build_tasks WHERE kind = 'audit' AND status = 'queued' AND json_extract(params, '$.task') = ?").bind(id).first<{ id: number }>();
    expect(audit).not.toBeNull();
    // The project builds from it: its worker reads this evidence, so the owner waits.
    const asked = await call("POST", `/factory/tasks/${id}/build`, { note: "reads well" }, "omc_m2");
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    const refused = await call("DELETE", `/factory/tasks/${id}/artifacts`, undefined, "omc_alice");
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(new RegExp(`task ${asked.json.task} is queued`));
    await env.DB.prepare("UPDATE build_tasks SET status = 'failed' WHERE id = ?").bind(asked.json.task).run();
    const gone = await call("DELETE", `/factory/tasks/${id}/artifacts`, undefined, "omc_alice");
    expect(gone.status, JSON.stringify(gone.json)).toBe(200);
    expect(gone.json.deleted).toBe(3);
    expect(await env.STAGING.head(`staging/alice/pad/${id}/PKGBUILD`)).toBeNull();
    expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE id = ?").bind(id).first()).toMatchObject({ status: "cancelled", error: "staging dropped by alice" });
    expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE id = ?").bind(audit!.id).first()).toMatchObject({ status: "cancelled", error: "the build it audited was dropped" });
    expect(await env.DB.prepare("SELECT status, detail FROM factory_packages WHERE name = 'pad'").first()).toMatchObject({ status: "registered", detail: "staging dropped by alice" });
    expect((await call("GET", "/factory/review")).json.staged.filter((t: any) => t.name === "pad")).toHaveLength(0);
  });

  it("a rejection keeps the note and the evidence, not the package", async () => {
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('pad', 'aarch64', '1-4', 'https://github.com/alice/recipes@HEAD:pad/PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
    const c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.status).toBe(200);
    const id = c.json.task.id;
    for (const f of ["PKGBUILD", "build.log", "pad-1-4-aarch64.pkg.tar.zst"]) await call("PUT", `/factory/tasks/${id}/artifacts/${f}`, undefined, c.json.token, `evidence ${f}`);
    expect((await call("POST", `/factory/tasks/${id}/complete`, { sha256: "a".repeat(64), filename: "pad-1-4-aarch64.pkg.tar.zst", version: "1-4" }, c.json.token)).json.status).toBe("staged");
    expect((await call("POST", `/factory/tasks/${id}/reject`, { note: "the source is not the upstream's" }, "omc_m2")).status).toBe(200);
    expect(await env.STAGING.head(`staging/alice/pad/${id}/pad-1-4-aarch64.pkg.tar.zst`)).toBeNull();
    expect(await env.STAGING.head(`staging/alice/pad/${id}/build.log`)).not.toBeNull();
    expect((await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ? ORDER BY key").bind(id).all<{ key: string }>()).results.map((r) => r.key.split("/").pop())).toEqual(["PKGBUILD", "build.log"]);
  });

  it("the weekly sweep drops what is past 30 days, rows and objects, and the packages of finished builds a transition missed", async () => {
    // A build finished long ago, whose rows a lifecycle rule would have orphaned; a cancelled one (a block cancels in bulk) still holding its package.
    const old = (await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status) VALUES ('pad', 'aarch64', '0-1', 'x', 'contributor', 100, 0, 'community', 'alice', 'build', 'cancelled') RETURNING id`).first<{ id: number }>())!.id;
    const bulk = (await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status) VALUES ('pad', 'aarch64', '0-2', 'x', 'contributor', 100, 0, 'community', 'alice', 'build', 'cancelled') RETURNING id`).first<{ id: number }>())!.id;
    for (const [t, f] of [[old, "PKGBUILD"], [old, "pad-0-1-aarch64.pkg.tar.zst"], [bulk, "PKGBUILD"], [bulk, "pad-0-2-aarch64.pkg.tar.zst"]] as [number, string][]) {
      await env.STAGING.put(`staging/alice/pad/${t}/${f}`, `bytes of ${f}`);
      await env.DB.prepare("INSERT INTO staging_objects (key, owner, task_id, size, uploaded_at) VALUES (?, 'alice', ?, 10, ?)").bind(`staging/alice/pad/${t}/${f}`, t, t === old ? "2026-08-01T00:00:00.000Z" : "2026-09-16T00:00:00.000Z").run();
    }
    const swept = await sweepStaging(env);
    expect(swept).toMatchObject({ expired: 2, expired_bytes: 20, reclaimed: 1, reclaimed_bytes: 10 });
    expect(await env.STAGING.head(`staging/alice/pad/${old}/PKGBUILD`)).toBeNull();
    expect(await env.STAGING.head(`staging/alice/pad/${bulk}/pad-0-2-aarch64.pkg.tar.zst`)).toBeNull();
    expect(await env.STAGING.head(`staging/alice/pad/${bulk}/PKGBUILD`)).not.toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM staging_objects WHERE task_id IN (?, ?)").bind(old, bulk).first<{ n: number }>())!.n).toBe(1);
    // Nothing else of alice's was finished with a package still in staging.
    expect(await sweepStaging(env)).toMatchObject({ expired: 0, reclaimed: 0 });
  });
});

describe("blocking", () => {
  const checklist = { official: true, license: true, unshipped: true, evidence: true };
  it("a maintainer blocks a package: it leaves every ring it is in, its builds stop, its project is refused; another maintainer lifts it", async () => {
    // 'mine' is published in edge (the earlier story); block it.
    expect((await call("POST", "/factory/packages/mine/block", { reason: "ships a token stealer" }, "omc_alice")).status).toBe(403);
    expect((await call("POST", "/factory/packages/mine/block", { reason: "x" }, "omc_m2")).status).toBe(400);
    // The publish job put it in edge (pkg-repo publish creates the release in reality): seeded here as the ring's head.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO releases (ring, seq, note) VALUES ('edge', 1, 'seed')"),
      env.DB.prepare("INSERT INTO ring_heads (ring, release_id) SELECT 'edge', id FROM releases WHERE ring = 'edge' AND seq = 1"),
      env.DB.prepare("INSERT INTO ring_packages (ring, package_id) SELECT 'edge', id FROM packages WHERE sha256 = ?").bind("e".repeat(64)),
    ]);
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM ring_packages rp JOIN packages p ON p.id = rp.package_id WHERE p.name = 'mine' AND rp.ring = 'edge'").first<{ n: number }>())!.n;
    expect(before).toBe(1);
    const blocked = await call("POST", "/factory/packages/mine/block", { reason: "ships a token stealer" }, "omc_m2");
    expect(blocked.status, JSON.stringify(blocked.json)).toBe(200);
    expect(blocked.json).toMatchObject({ blocked: "mine", by: "m2", rings: [{ ring: "edge", release: expect.any(Number) }] });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM ring_packages rp JOIN packages p ON p.id = rp.package_id WHERE p.name = 'mine'").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE kind = 'render' AND status = 'queued' AND json_extract(params, '$.ring') = 'edge'").first<{ n: number }>())!.n).toBe(2);
    expect(await env.DB.prepare("SELECT status, blocked_by FROM factory_packages WHERE name = 'mine'").first()).toMatchObject({ status: "rejected", blocked_by: "m2" });
    expect((await call("POST", "/factory/packages/mine/block", { reason: "again" }, "omc_m2")).status).toBe(409);
    // The record, signed when the pool signs; the door closed to the owner and to a new request of the same project.
    const rec = blocked.json.record.replace(`${env.POOL_URL}/`, "");
    expect(await env.PACKAGES.head(rec)).not.toBeNull();
    expect(rec).toMatch(/^factory\/mine\/\d+\/decision-\d+T\d+\.json$/);
    expect((await call("POST", "/factory/packages/mine/build", {}, "omc_m1")).json.error).toMatch(/blocked by a maintainer/);
    expect((await call("POST", "/factory/packages", { url: "https://github.com/alice/mine", description: "Mine, again", license: "MIT", checklist }, "omc_alice")).status).toBe(403);
    // The one who blocked cannot lift it; another maintainer can.
    expect((await call("POST", "/factory/packages/mine/unblock", { reason: "false alarm" }, "omc_m2")).status).toBe(403);
    const lifted = await call("POST", "/factory/packages/mine/unblock", { reason: "false alarm" }, "omc_m1");
    expect(lifted.status).toBe(200);
    expect(await env.DB.prepare("SELECT blocked_at FROM factory_packages WHERE name = 'mine'").first()).toEqual({ blocked_at: null });
    expect((await call("GET", "/factory/blocks")).json.packages).toEqual([]);
  });

  it("a maintainer blocks a contributor: nothing more from them, their workers revoked, their packages rejected — and their sources stay closed to other accounts", async () => {
    // bob requests something, registers a worker, then gets blocked by m1.
    await env.DB.prepare(`INSERT INTO contributors (login, token_hash, role) VALUES ('bob', ?, 'contributor')`).bind(await sha256Hex("omc_bob")).run();
    const req = await call("POST", "/factory/packages", { url: "https://evil.example/tool", source: "https://evil.example/tool-1.0.tar.gz", version: "1.0", description: "A tool of dubious intent", license: "MIT", arches: ["aarch64"], checklist }, "omc_bob");
    expect(req.status, JSON.stringify(req.json)).toBe(201);
    const w = await call("POST", "/factory/workers", { name: "box", arch: "aarch64" }, "omc_bob");
    expect(w.status).toBe(201);
    expect((await call("POST", "/factory/contributors/bob/block", { reason: "spam requests" }, "omc_alice")).status).toBe(403);
    expect((await call("POST", "/factory/contributors/m2/block", { reason: "no reason at all" }, "omc_m1")).status).toBe(409); // a maintainer is a governance PR
    expect((await call("POST", "/factory/contributors/m1/block", { reason: "no reason at all" }, "omc_m1")).status).toBe(400);
    const blocked = await call("POST", "/factory/contributors/bob/block", { reason: "spam requests" }, "omc_m1");
    expect(blocked.status, JSON.stringify(blocked.json)).toBe(200);
    expect(blocked.json).toMatchObject({ blocked: "bob", by: "m1", packages: ["tool"], workers_revoked: [w.json.worker] });
    expect(await env.PACKAGES.head(blocked.json.record.replace(`${env.POOL_URL}/`, ""))).not.toBeNull();
    expect(await env.DB.prepare("SELECT status FROM factory_packages WHERE name = 'tool'").first()).toEqual({ status: "rejected" });
    expect(await env.DB.prepare("SELECT revoked_at IS NOT NULL AS revoked FROM build_workers WHERE id = ?").bind(w.json.worker).first()).toEqual({ revoked: 1 });
    // Every door: request, build, a worker — refused with the reason.
    expect((await call("POST", "/factory/packages", { url: "https://evil.example/other", source: "https://evil.example/o.tar.gz", version: "1", description: "Another tool of intent", license: "MIT", checklist }, "omc_bob")).json.error).toMatch(/blocked by a maintainer: spam requests/);
    expect((await call("POST", "/factory/workers", { name: "box2", arch: "aarch64" }, "omc_bob")).status).toBe(403);
    expect((await call("GET", "/factory/blocks")).json.contributors).toEqual([expect.objectContaining({ login: "bob", blocked_by: "m1", blocked_reason: "spam requests" })]);
    // A fresh account asking for the same project, or the same source: no.
    await env.DB.prepare(`INSERT INTO contributors (login, token_hash, role) VALUES ('bob2', ?, 'contributor')`).bind(await sha256Hex("omc_bob2")).run();
    const again = await call("POST", "/factory/packages", { name: "tool2", url: "https://evil.example/tool", source: "https://evil.example/tool-1.0.tar.gz", version: "1.0", description: "A tool of dubious intent", license: "MIT", checklist }, "omc_bob2");
    expect(again.status).toBe(403);
    expect(again.json.error).toMatch(/requested by bob, who is blocked/);
    // Lifting: not by the one who blocked.
    expect((await call("POST", "/factory/contributors/bob/unblock", { reason: "talked it over" }, "omc_m1")).status).toBe(403);
    expect((await call("POST", "/factory/contributors/bob/unblock", { reason: "talked it over" }, "omc_m2")).status).toBe(200);
    expect((await call("GET", "/factory/blocks")).json.contributors).toEqual([]);
  });
});

describe("what a public log must not carry", () => {
  it("a token, a key or the worker's own environment in text evidence is refused at the PUT with the kind and the line, never the match; the record never receives it; the public list shows no token hash", async () => {
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('leaky', 'aarch64', '1-1', 'https://github.com/alice/recipes@HEAD:leaky/PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
    const c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.status).toBe(200);
    const id = c.json.task.id;
    const job = c.json.token as string;
    const secret = "omw_" + "Q".repeat(40);
    const put = await call("PUT", `/factory/tasks/${id}/artifacts/build.log`, undefined, job, `==> Making package: leaky 1-1\nOMARCHY_WORKER_TOKEN=${secret}\n==> done\n`);
    expect(put.status).toBe(422);
    expect(put.json).toMatchObject({ kind: "the worker's environment", line: 2 });
    expect(JSON.stringify(put.json)).not.toContain(secret);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staging_objects WHERE task_id = ?").bind(id).first<{ n: number }>()).toMatchObject({ n: 0 });
    const ev = await env.DB.prepare("SELECT summary, payload FROM events WHERE kind = 'leak' ORDER BY id DESC LIMIT 1").first<{ summary: string; payload: string }>();
    expect(ev?.summary).toMatch(/build\.log refused/);
    expect(ev?.payload).not.toContain(secret);
    // The other shapes, the same door.
    for (const [text, kind] of [
      ["curl -H 'authorization: Bearer " + "a".repeat(40) + "' https://x", "a bearer token"],
      ["git clone https://x-access-token:" + "b".repeat(30) + "@github.com/o/r", "a credential in a URL"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----", "a private key block"],
      ["export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-" + "c".repeat(60), "an Anthropic key"],
      ["token: ghp_" + "d".repeat(36), "a GitHub token"],
    ] as const) {
      const r = await call("PUT", `/factory/tasks/${id}/artifacts/tests.log`, undefined, job, text);
      expect(r.status, text).toBe(422);
      expect(r.json.kind, text).toBe(kind);
    }
    // A clean log, and the things logs legitimately say, go in.
    for (const text of ["==> Making package: leaky 1-1\nGITHUB_TOKEN=\nsk-ant is a prefix\nhttps://user@github.com/o/r\nAuthorization: Bearer <token>\n", "pkgname=leaky\nsource=(\"https://github.com/o/r/archive/v1.tar.gz\")\n"]) {
      expect((await call("PUT", `/factory/tasks/${id}/artifacts/build.log`, undefined, job, text)).status).toBe(201);
    }
    // Text evidence has one door: a multipart upload of it is not started.
    expect((await call("POST", `/factory/tasks/${id}/artifacts/build.log/multipart?action=create`, {}, job)).status).toBe(400);
    // The hash of a worker's token is not on the public list.
    const list = await call("GET", "/factory");
    expect(list.status).toBe(200);
    expect(list.json.workers.length).toBeGreaterThan(0);
    for (const w of list.json.workers) expect(w).not.toHaveProperty("token_hash");
  });
});

describe("the log's tail and the error line", () => {
  it("are withheld — never stored, never served — when they carry what looks like a secret; the completion stands and an event says so", async () => {
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('tail', 'aarch64', '1-1', 'https://github.com/alice/recipes@HEAD:tail/PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
    const c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.status).toBe(200);
    const id = c.json.task.id;
    const secret = "ghp_" + "Z".repeat(36);
    const f = await call("POST", `/factory/tasks/${id}/fail`, { error: `exit 4: curl -H 'authorization: Bearer ${secret}' failed`, log_tail: `==> build()\nGITHUB_TOKEN=${secret}\n==> ERROR: A failure occurred in build().`, final: true }, c.json.token);
    expect(f.status).toBe(200);
    const t = (await call("GET", `/factory/tasks/${id}`)).json.task;
    expect(t.status).toBe("failed");
    expect(JSON.stringify(t)).not.toContain(secret);
    expect(t.error).toMatch(/^\[error withheld: it carried what looks like a bearer token/);
    expect(t.log_tail).toMatch(/^\[log_tail withheld: it carried what looks like the worker's environment/);
    const pkg = await env.DB.prepare("SELECT detail FROM factory_packages WHERE name = 'tail'").first<{ detail: string }>();
    if (pkg) expect(pkg.detail).not.toContain(secret);
    const events = await env.DB.prepare("SELECT summary, payload FROM events WHERE kind = 'leak' AND payload LIKE ? ORDER BY id").bind(`%"task":${id},%`).all<{ summary: string; payload: string }>();
    expect(events.results.map((e) => e.summary)).toEqual([`task ${id}: log_tail withheld — it carried what looks like the worker's environment`, `task ${id}: error withheld — it carried what looks like a bearer token`]);
    for (const e of events.results) expect(e.payload).not.toContain(secret);
    // A clean tail is kept as it was.
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('tail2', 'aarch64', '1-1', 'https://github.com/alice/recipes@HEAD:tail2/PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
    const c2 = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    await call("POST", `/factory/tasks/${c2.json.task.id}/fail`, { error: "exit 4: ==> ERROR: A failure occurred in build().", log_tail: "==> build()\n==> ERROR: A failure occurred in build().", final: true }, c2.json.token);
    expect((await call("GET", `/factory/tasks/${c2.json.task.id}`)).json.task.log_tail).toBe("==> build()\n==> ERROR: A failure occurred in build().");
  });
});

describe("who trusts whom", () => {
  it("project trust takes two maintainers' word — never the owner's, never the same person twice — and one word takes it back; each step an event, the trust a signed record", async () => {
    // alice's community worker w3; m1 proposes, m2 confirms.
    expect((await call("POST", "/factory/workers/w3/trust", { trust: "project" }, "omc_alice")).status).toBe(403);
    // A maintainer's own worker: they never propose it, but may confirm another maintainer's proposal (the Studio's workers, with two maintainers in the project).
    await env.DB.prepare("INSERT OR IGNORE INTO build_workers (id, arch, owner, token_hash, mode, trust, last_seen) VALUES ('m1own', 'aarch64', 'm1', ?, 'dedicated', 'community', '2000-01-01T00:00:00Z')").bind(await sha256Hex("omw_m1own")).run();
    expect((await call("POST", "/factory/workers/m1own/trust", { trust: "project" }, "omc_m1")).status).toBe(403);
    expect((await call("POST", "/factory/workers/m1own/trust", { trust: "project" }, "omc_m2")).status).toBe(202);
    const owned = await call("POST", "/factory/workers/m1own/trust", { trust: "project" }, "omc_m1");
    expect(owned.status, JSON.stringify(owned.json)).toBe(200);
    expect(owned.json).toMatchObject({ worker: "m1own", trust: "project", trusted_by: "m2, m1" });
    const first = await call("POST", "/factory/workers/w3/trust", { trust: "project" }, "omc_m1");
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ worker: "w3", trust: "community", proposed_by: "m1" });
    const again = await call("POST", "/factory/workers/w3/trust", { trust: "project" }, "omc_m1");
    expect(again.status).toBe(202); // the same person, still one word
    expect((await env.DB.prepare("SELECT trust, trust_proposed_by FROM build_workers WHERE id = 'w3'").first())).toMatchObject({ trust: "community", trust_proposed_by: "m1" });
    expect((await call("GET", "/factory/trust")).json.workers.find((w: any) => w.id === "w3")).toMatchObject({ trust: "community", trust_proposed_by: "m1" });
    const second = await call("POST", "/factory/workers/w3/trust", { trust: "project" }, "omc_m2");
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ worker: "w3", trust: "project", trusted_by: "m1, m2" });
    expect(second.json.record).toMatch(/\/workers\/w3\/trust-/);
    expect((await env.DB.prepare("SELECT trust, trusted_by, trust_proposed_by FROM build_workers WHERE id = 'w3'").first())).toMatchObject({ trust: "project", trusted_by: "m1, m2", trust_proposed_by: null });
    const records = await env.PACKAGES.list({ prefix: "workers/w3/trust-" });
    expect(records.objects.length).toBe(1);
    expect(JSON.parse(await (await env.PACKAGES.get(records.objects[0].key))!.text())).toMatchObject({ schema: "omarchy-pool/worker-trust/1", worker: "w3", trust: "project", proposed_by: "m1", confirmed_by: "m2" });
    const events = (await env.DB.prepare("SELECT summary FROM events WHERE kind = 'trust' AND payload LIKE '%\"w3\"%' ORDER BY id").all<{ summary: string }>()).results.map((e) => e.summary);
    expect(events).toEqual(["worker w3 proposed for project trust by m1; a second maintainer confirms", "worker w3 set to project trust on the word of m1, m2"]);
    // Already trusted: nothing changes. Back to community: one maintainer's call.
    expect((await call("POST", "/factory/workers/w3/trust", { trust: "project" }, "omc_m1")).json).toMatchObject({ unchanged: true, trusted_by: "m1, m2" });
    expect((await call("POST", "/factory/workers/w3/trust", { trust: "community" }, "omc_m2")).json).toMatchObject({ worker: "w3", trust: "community", by: "m2" });
    expect((await env.DB.prepare("SELECT trust, trusted_by FROM build_workers WHERE id = 'w3'").first())).toMatchObject({ trust: "community", trusted_by: null });
    // A maintainer's own worker: not by them.
    await env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, last_seen) VALUES ('w4', 'aarch64', 'm1', ?, 'dedicated', 'community', '2000-01-01T00:00:00Z')").bind(await sha256Hex("omw_w4")).run();
    const own = await call("POST", "/factory/workers/w4/trust", { trust: "project" }, "omc_m1");
    expect(own.status).toBe(403);
    expect(own.json.error).toMatch(/their own worker/);
    expect((await call("POST", "/factory/workers/w4/trust", { trust: "project" }, "omc_m2")).status).toBe(202);
  });

  it("the Review page names the worker behind every staged build; a record can be withdrawn by a maintainer, with a signed tombstone in its place", async () => {
    // A build staged by alice's worker w3 (registered "where": "her laptop") keeps who built it.
    await env.DB.prepare("UPDATE build_workers SET labels = '{\"where\":\"her laptop\"}' WHERE id = 'w3'").run();
    await env.DB.prepare(`INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind) VALUES ('whence', 'aarch64', '1-1', 'https://github.com/alice/recipes@HEAD:whence/PKGBUILD', 'contributor', 100, 0, 'community', 'alice', 'build')`).run();
    const c = await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3");
    expect(c.status).toBe(200);
    for (const f of ["PKGBUILD", "build.log", "whence-1-1-aarch64.pkg.tar.zst"]) await call("PUT", `/factory/tasks/${c.json.task.id}/artifacts/${f}`, undefined, c.json.token, `evidence ${f}`);
    expect((await call("POST", `/factory/tasks/${c.json.task.id}/complete`, { sha256: "a".repeat(64), filename: "whence-1-1-aarch64.pkg.tar.zst", version: "1-1" }, c.json.token)).status).toBe(200);
    const staged = (await call("GET", "/factory/review")).json.staged as any[];
    const withWorker = staged.filter((t) => t.built_by);
    expect(withWorker.map((t) => t.id)).toEqual([c.json.task.id]);
    expect(withWorker[0].built_by).toEqual({ worker: "w3", owner: "alice", where: "her laptop", trusted_by: null });
    for (const t of staged) expect(t).not.toHaveProperty("worker_labels");
    // A record that should not be public: withdrawn, its signature and staging copy with it.
    const task = withWorker[0].id as number;
    const prefix = withWorker[0].staged_prefix as string;
    const key = `factory/${withWorker[0].name}/9/build-${task}/build.log`;
    await env.PACKAGES.put(key, "==> a log with something in it\n");
    await env.PACKAGES.put(`${key}.sig`, "sig");
    await env.STAGING.put(`${prefix}build.log`, "==> a log with something in it\n");
    await env.DB.prepare("INSERT OR REPLACE INTO staging_objects (key, owner, task_id, size) VALUES (?, ?, ?, 31)").bind(`${prefix}build.log`, withWorker[0].owner, task).run();
    expect((await call("POST", "/factory/record/withdraw", { key, reason: "a token in the log" }, "omc_alice")).status).toBe(403);
    expect((await call("POST", "/factory/record/withdraw", { key, reason: "short" }, "omc_m1")).status).toBe(400);
    expect((await call("POST", "/factory/record/withdraw", { key: "packages/x.pkg.tar.zst", reason: "not a record at all" }, "omc_m1")).status).toBe(400);
    expect((await call("POST", "/factory/record/withdraw", { key: "factory/nothing/1/build-1/build.log", reason: "there is no such thing" }, "omc_m1")).status).toBe(404);
    const gone = await call("POST", "/factory/record/withdraw", { key, reason: "the log carried a token of the worker's" }, "omc_m1");
    expect(gone.status).toBe(200);
    expect(gone.json).toMatchObject({ withdrawn: key, by: "m1", tombstone: `${key}.tombstone.json`, size: 31 });
    expect(await env.PACKAGES.get(key)).toBeNull();
    expect(await env.PACKAGES.get(`${key}.sig`)).toBeNull();
    expect(await env.STAGING.get(`${prefix}build.log`)).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staging_objects WHERE key = ?").bind(`${prefix}build.log`).first()).toMatchObject({ n: 0 });
    const stone = JSON.parse(await (await env.PACKAGES.get(`${key}.tombstone.json`))!.text());
    expect(stone).toMatchObject({ schema: "omarchy-pool/tombstone/1", key, withdrawn_by: "m1", reason: "the log carried a token of the worker's", size: 31 });
    expect(stone.sha256).toMatch(/^[0-9a-f]{64}$/);
    const ev = await env.DB.prepare("SELECT summary FROM events WHERE kind = 'withdraw' ORDER BY id DESC LIMIT 1").first<{ summary: string }>();
    expect(ev?.summary).toBe(`${key} withdrawn from the record by m1: the log carried a token of the worker's`);
    // Withdrawn once: the tombstone is a record, written once too.
    expect((await call("POST", "/factory/record/withdraw", { key, reason: "again, for the test" }, "omc_m1")).status).toBe(404);
    expect((await call("POST", "/factory/record/withdraw", { key: `${key}.tombstone.json`, reason: "a tombstone is not withdrawn" }, "omc_m1")).status).toBe(400);
  });
});

describe("removing a registration", () => {
  it("never leaves a package behind in a ring: the owner is refused while it is served, a maintainer's removal pulls it and says so in the journal", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('ringed', 'alice', 'https://ringed.example', '[\"aarch64\"]', 'staged')"),
      env.DB.prepare("INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES ('ringed-1', 'ringed', '1-1', 'aarch64', 'ringed-1-1-aarch64.pkg.tar.zst', 1, 1, 1, '{}', 'factory', 'factory/aarch64/ringed-1-1-aarch64.pkg.tar.zst', 'aarch64')"),
    ]);
    const pid = (await env.DB.prepare("SELECT id FROM packages WHERE name = 'ringed'").first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT INTO ring_packages (ring, package_id) VALUES ('edge', ?)").bind(pid).run();
    // alice, its owner: not while it stands in edge (felix, 2026-09-17: the registration left, the package stayed in edge).
    const mine = await call("DELETE", "/factory/packages/ringed", undefined, "omc_alice");
    expect(mine.status).toBe(409);
    expect(mine.json.error).toMatch(/in edge: a maintainer withdraws the approval or blocks it first/);
    expect(await env.DB.prepare("SELECT name FROM factory_packages WHERE name = 'ringed'").first()).toEqual({ name: "ringed" });
    // m1, a maintainer: the registration goes, and the package leaves edge with it — a release without it, render jobs queued, a journal line.
    const theirs = await call("DELETE", "/factory/packages/ringed", undefined, "omc_m1");
    expect(theirs.status, JSON.stringify(theirs.json)).toBe(200);
    expect(theirs.json).toMatchObject({ deleted: "ringed", by: "m1", rings: [{ ring: "edge", release: expect.any(Number) }] });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ring_packages WHERE package_id = ?").bind(pid).first()).toEqual({ n: 0 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE kind = 'render' AND status = 'queued' AND json_extract(params, '$.ring') = 'edge'").first<{ n: number }>())!.n).toBeGreaterThan(0);
    expect(await env.DB.prepare("SELECT summary FROM events WHERE kind = 'request' AND summary LIKE 'ringed: registration removed%' ORDER BY id DESC LIMIT 1").first()).toMatchObject({ summary: expect.stringMatching(/removed by m1 — it leaves edge/) });
    // Gone: a second removal finds nothing.
    expect((await call("DELETE", "/factory/packages/ringed", undefined, "omc_m1")).status).toBe(404);
  });
  it("takes the owner's staged build with it — nothing of a removed registration waits for a maintainer, its audit is cancelled, its package leaves staging and its evidence stays", async () => {
    // felix, 2026-09-17: the registration left, build #447 stayed staged — on Review as "waiting for a maintainer", on the Pipeline as a build in the queue.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('gone', 'alice', 'https://gone.example', '[\"aarch64\"]', 'staged')"),
      env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix) VALUES ('gone', 'aarch64', '1', 'draft:https://gone.example@1', 'contributor', 100, 0, 'community', 'alice', 'build', 'staged', 'staging/alice/gone/1/')"),
      env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status) VALUES ('gone', 'x86_64', '1', 'draft:https://gone.example@1', 'contributor', 100, 0, 'community', 'alice', 'build', 'queued')"),
    ]);
    const staged = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'gone' AND status = 'staged'").first<{ id: number }>())!.id;
    const queued = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'gone' AND status = 'queued'").first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, kind, status, params) VALUES ('gone', 'aarch64', '1', 'audit', 'audit', 100, 0, 'project', 'audit', 'queued', ?)").bind(JSON.stringify({ task: staged })).run();
    const prefix = `staging/alice/gone/${staged}/`;
    for (const [f, size] of [["gone-1-1-aarch64.pkg.tar.zst", 40], ["PKGBUILD", 12], ["build.log", 20]] as const) {
      await env.STAGING.put(`${prefix}${f}`, "x".repeat(size));
      await env.DB.prepare("INSERT INTO staging_objects (key, owner, task_id, size) VALUES (?, 'alice', ?, ?)").bind(`${prefix}${f}`, staged, size).run();
    }
    const r = await call("DELETE", "/factory/packages/gone", undefined, "omc_alice");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ deleted: "gone", by: "alice", cancelled: expect.arrayContaining([staged, queued]) });
    for (const id of [staged, queued]) expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE id = ?").bind(id).first()).toEqual({ status: "cancelled", error: "registration removed by alice" });
    expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE kind = 'audit' AND json_extract(params, '$.task') = ?").bind(staged).first()).toEqual({ status: "cancelled" });
    // The package is gone from staging; the recipe and the log are the record.
    expect(await env.STAGING.get(`${prefix}gone-1-1-aarch64.pkg.tar.zst`)).toBeNull();
    expect(await env.STAGING.get(`${prefix}PKGBUILD`)).not.toBeNull();
    expect(await env.STAGING.get(`${prefix}build.log`)).not.toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM staging_objects WHERE task_id = ?").bind(staged).first<{ n: number }>())!.n).toBe(2);
    // Review lists nothing of it; the journal says what went.
    const review = await call("GET", "/factory/review");
    expect(review.json.staged.some((t: { name: string }) => t.name === "gone")).toBe(false);
    expect(await env.DB.prepare("SELECT summary FROM events WHERE kind = 'request' AND summary LIKE 'gone: registration removed%' ORDER BY id DESC LIMIT 1").first()).toMatchObject({ summary: "gone: registration removed by alice — 2 build(s) cancelled" });
  });
  it("a maintainer's removal stops the project's builds and publish jobs with the audits and trials queued for them, and a build another person left staged under the name", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('taken', 'alice', 'https://taken.example', '[\"aarch64\"]', 'staged')"),
      // bob's build, staged before alice took the name over (#184): nothing to approve it against once the registration goes.
      env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix) VALUES ('taken', 'aarch64', '1', 'draft:https://taken.example@1', 'contributor', 100, 0, 'community', 'bob', 'build', 'staged', 'staging/bob/taken/1/')"),
      env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix) VALUES ('taken', 'aarch64', '2', 'draft:https://taken.example@2', 'contributor', 100, 0, 'community', 'alice', 'build', 'staged', 'staging/alice/taken/2/')"),
    ]);
    const bobs = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'taken' AND owner = 'bob'").first<{ id: number }>())!.id;
    const alices = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'taken' AND owner = 'alice'").first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, kind, status, params, staged_prefix) VALUES ('taken', 'aarch64', '2', ?, 'review', 100, 0, 'project', 'build', 'staged', ?, 'staging/alice/taken/3/')").bind(`review:${alices}`, JSON.stringify({ review: alices })).run();
    const projects = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'taken' AND trust = 'project' AND kind = 'build'").first<{ id: number }>())!.id;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, kind, status, params) VALUES ('taken', 'aarch64', '2', 'audit', 'audit', 100, 0, 'project', 'audit', 'queued', ?)").bind(JSON.stringify({ task: projects })),
      env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, kind, status, params) VALUES ('taken', 'aarch64', '2', 'trial', 'trial', 100, 0, 'project', 'trial', 'queued', ?)").bind(JSON.stringify({ task: projects, files: ["taken-2-1-aarch64.pkg.tar.zst"] })),
      env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, kind, status, params) VALUES ('taken', 'aarch64', '2', 'publish', 'publish', 100, 1, 'project', 'publish', 'queued', ?)").bind(JSON.stringify({ task: projects })),
    ]);
    const publish = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'taken' AND kind = 'publish'").first<{ id: number }>())!.id;
    await env.STAGING.put(`staging/alice/taken/3/taken-2-1-aarch64.pkg.tar.zst`, "z".repeat(50));
    await env.DB.prepare("INSERT INTO staging_objects (key, owner, task_id, size) VALUES (?, 'alice', ?, 50)").bind(`staging/alice/taken/3/taken-2-1-aarch64.pkg.tar.zst`, projects).run();
    const r = await call("DELETE", "/factory/packages/taken", undefined, "omc_m1");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.cancelled.sort()).toEqual([bobs, alices, projects, publish].sort());
    for (const id of [bobs, alices, projects, publish]) expect(await env.DB.prepare("SELECT status FROM build_tasks WHERE id = ?").bind(id).first()).toEqual({ status: "cancelled" });
    expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE kind = 'audit' AND json_extract(params, '$.task') = ?").bind(projects).first()).toEqual({ status: "cancelled", error: "the build it audited was cancelled with its registration" });
    expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE kind = 'trial' AND json_extract(params, '$.task') = ?").bind(projects).first()).toEqual({ status: "cancelled", error: "the build it tried was cancelled with its registration" });
    expect(await env.STAGING.get(`staging/alice/taken/3/taken-2-1-aarch64.pkg.tar.zst`)).toBeNull();
    expect(await env.DB.prepare("SELECT summary FROM events WHERE kind = 'request' AND summary LIKE 'taken: registration removed%' ORDER BY id DESC LIMIT 1").first()).toMatchObject({ summary: "taken: registration removed by m1 — 3 build(s) and 1 publish job(s) cancelled" });
  });
  it("cuts off a build still running: its worker's report and uploads are refused, and the lease is not requeued", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO factory_packages (name, owner, url, arches, status) VALUES ('running', 'alice', 'https://running.example', '[\"aarch64\"]', 'building')"),
      env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, lease_owner, lease_expires_at, started_at) VALUES ('running', 'aarch64', '1', 'draft:https://running.example@1', 'contributor', 100, 0, 'community', 'alice', 'build', 'leased', 'w3', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"),
    ]);
    const id = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'running'").first<{ id: number }>())!.id;
    const r = await call("DELETE", "/factory/packages/running", undefined, "omc_alice");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.cancelled).toEqual([id]);
    expect(await env.DB.prepare("SELECT status, lease_expires_at, finished_at IS NOT NULL AS ended FROM build_tasks WHERE id = ?").bind(id).first()).toEqual({ status: "cancelled", lease_expires_at: null, ended: 1 });
    // The worker, still building: nothing it sends lands, nothing overwrites the reason.
    expect((await call("POST", `/factory/tasks/${id}/heartbeat`, {}, "omw_w3")).status).toBe(409);
    expect((await call("POST", `/factory/tasks/${id}/complete`, { sha256: "1111", filename: "running-1-1-aarch64.pkg.tar.zst", version: "1-1" }, "omw_w3")).status).toBe(409);
    expect((await call("POST", `/factory/tasks/${id}/fail`, { error: "too late" }, "omw_w3")).status).toBe(409);
    expect(await env.DB.prepare("SELECT status, error FROM build_tasks WHERE id = ?").bind(id).first()).toEqual({ status: "cancelled", error: "registration removed by alice" });
  });
  it("a maintainer's page says where each standing approval stands — the rings that serve the package — so it can be taken back from there", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO packages (sha256, name, version, arch, filename, size_download, size_installed, has_signature, manifest_json, source, r2_key, repo_arch) VALUES ('stood-1', 'stood', '1-1', 'aarch64', 'stood-1-1-aarch64.pkg.tar.zst', 1, 1, 1, '{}', 'factory', 'factory/aarch64/stood-1-1-aarch64.pkg.tar.zst', 'aarch64')"),
      env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status) VALUES ('stood', 'aarch64', '1', 'draft:https://stood.example@1', 'contributor', 100, 0, 'community', 'alice', 'build', 'staged')"),
    ]);
    const pid = (await env.DB.prepare("SELECT id FROM packages WHERE name = 'stood'").first<{ id: number }>())!.id;
    const tid = (await env.DB.prepare("SELECT id FROM build_tasks WHERE name = 'stood'").first<{ id: number }>())!.id;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ring_packages (ring, package_id) VALUES ('edge', ?), ('rc', ?)").bind(pid, pid),
      env.DB.prepare("INSERT INTO approvals (task_id, name, arch, version, decision, by, note) VALUES (?, 'stood', 'aarch64', '1', 'approved', 'm2', 'fine')").bind(tid),
    ]);
    const page = await call("GET", "/users/m2?t=stood");
    expect(page.status).toBe(200);
    expect(page.json.approvals.find((a: any) => a.name === "stood")).toMatchObject({ decision: "approved", rings: ["edge", "rc"] });
  });
});

describe("every worker follows the latest image", () => {
  it("a worker behind the pool's release past the rollout's grace is handed nothing — 426, alive on the Workers page as outdated, one journal line per release — and keeps no first pick", async () => {
    // The pool at a release, deployed an hour ago; the test's default POOL_VERSION ("test") never refuses.
    const was = { version: env.POOL_VERSION, deployed: env.POOL_DEPLOYED_AT };
    Object.assign(env, { POOL_VERSION: "v0.0.177", POOL_DEPLOYED_AT: new Date(Date.now() - 60 * 60000).toISOString() });
    try {
      await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status) VALUES ('stale', 'aarch64', '1', 'abc123', 'contributor', 100, 0, 'community', 'alice', 'build', 'queued')").run();
      const old = await call("POST", "/factory/claim", { arch: "aarch64", version: "v0.0.167", hostname: "old-box" }, "omw_w3");
      expect(old.status).toBe(426);
      expect(old.json).toMatchObject({ latest: "v0.0.177", yours: "v0.0.167", behind: 10, update: "/docs/workers#update" });
      expect(old.json.error).toMatch(/10 releases behind/);
      // Touched: alive, its version on the record, nothing in hand; the journal said it once.
      const w = await env.DB.prepare("SELECT version, told_update, current_task FROM build_workers WHERE id = 'w3'").first();
      expect(w).toMatchObject({ version: "v0.0.167", told_update: "v0.0.177", current_task: null });
      expect((await call("POST", "/factory/claim", { arch: "aarch64", version: "v0.0.167" }, "omw_w3")).status).toBe(426);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'worker' AND summary LIKE 'w3: handed nothing%'").first<{ n: number }>())!.n).toBe(1);
      // A URL of its own: /factory is kept in the edge cache for ten seconds, and an earlier test read it.
      const listed = (await call("GET", "/factory?limit=41")).json.workers.find((x: { id: string }) => x.id === "w3");
      expect(listed.update).toMatchObject({ outdated: true, behind: 10, required: true });
      // Within the grace of a fresh deploy, the same worker works on (the build is still queued).
      Object.assign(env, { POOL_DEPLOYED_AT: new Date(Date.now() - 5 * 60000).toISOString() });
      const fresh = await call("POST", "/factory/claim", { arch: "aarch64", version: "v0.0.176" }, "omw_w3");
      expect(fresh.status, JSON.stringify(fresh.json)).toBe(200);
      expect(fresh.json.task.name).toBe("stale");
      await call("POST", `/factory/tasks/${fresh.json.task.id}/fail`, { error: "test over", final: true }, "omw_w3");
    } finally {
      Object.assign(env, { POOL_VERSION: was.version, POOL_DEPLOYED_AT: was.deployed });
    }
  });
});

describe("workers follow the brain", () => {
  it("the mode is the registration's once set from the page or the worker's own token: the claim uses it, whatever the container says, from the next claim", async () => {
    // w3 (alice's, dedicated) starts with WORKER_SHARED=1: the flag is the first word.
    expect((await call("POST", "/factory/claim", { arch: "aarch64", shared: true }, "omw_w3")).status).toBe(204);
    expect(await env.DB.prepare("SELECT mode, mode_by FROM build_workers WHERE id = 'w3'").first()).toEqual({ mode: "shared", mode_by: null });
    // A stranger cannot set it; its owner can; a maintainer may take it out of the queue, never put it in (sharing is the owner's word); a project worker has no such mode.
    expect((await call("POST", "/factory/workers/w3/mode", { mode: "shared" }, "omc_m2")).status).toBe(403);
    expect((await call("POST", "/factory/workers/w3/mode", { mode: "dedicated" }, "omc_m2")).status).toBe(200); // m2 is a maintainer
    expect((await call("POST", "/factory/workers/w1/mode", { mode: "shared" }, "omc_m1")).status).toBe(409);
    expect((await call("POST", "/factory/workers/w3/mode", { mode: "sometimes" }, "omc_alice")).status).toBe(400);
    const own = await call("POST", "/factory/workers/w3/mode", { mode: "dedicated" }, "omc_alice");
    expect(own.json).toMatchObject({ id: "w3", mode: "dedicated", by: "alice", note: expect.stringMatching(/its owner's packages only/) });
    // The container still says shared; the brain says own packages: a stranger's queued build is not for it.
    await env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, created_at) VALUES ('theirs', 'aarch64', '1', 'abc123', 'contributor', 100, 0, 'community', 'bob', 'build', 'queued', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'))").run();
    expect((await call("POST", "/factory/claim", { arch: "aarch64", shared: true }, "omw_w3")).status).toBe(204);
    expect(await env.DB.prepare("SELECT mode, mode_by FROM build_workers WHERE id = 'w3'").first()).toEqual({ mode: "dedicated", mode_by: "alice" });
    // The worker's own command line flips it through its token: the next claim takes the stranger's build.
    const viaToken = await call("POST", "/factory/workers/self/mode", { mode: "shared" }, "omw_w3");
    expect(viaToken.json).toMatchObject({ mode: "shared", by: "worker" });
    expect(await env.DB.prepare("SELECT mode_by FROM build_workers WHERE id = 'w3'").first()).toEqual({ mode_by: "worker" });
    const c = await call("POST", "/factory/claim", { arch: "aarch64", shared: false }, "omw_w3");
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.task.name).toBe("theirs");
    expect((await call("GET", "/factory/workers/self", undefined, "omw_w3")).json).toMatchObject({ mode: "shared", mode_by: "worker" });
    await call("POST", `/factory/tasks/${c.json.task.id}/fail`, { error: "test over", final: true }, "omw_w3");
    await call("POST", "/factory/workers/self/mode", { mode: "dedicated" }, "omw_w3");
  });
  it("the worker's own log rides with the claim — kept to the last kilobytes, a line that looks like a secret dropped — and is read by its owner and the maintainers only", async () => {
    await call("POST", "/factory/claim", { arch: "aarch64", log: "[10:00:00] container worker w3 (aarch64) preparing\n[10:00:02] agent ok\n" }, "omw_w3");
    await call("POST", "/factory/claim", { arch: "aarch64", log: "[10:00:32] update required: this worker runs v0.0.1\n" }, "omw_w3");
    await call("POST", "/factory/claim", { arch: "aarch64" }, "omw_w3"); // nothing new: the tail stays
    const mine = await call("GET", "/factory/workers/w3/log", undefined, "omc_alice");
    expect(mine.status).toBe(200);
    expect(mine.json.log).toBe("[10:00:00] container worker w3 (aarch64) preparing\n[10:00:02] agent ok\n[10:00:32] update required: this worker runs v0.0.1\n");
    expect(mine.json.at).toBeTruthy();
    // The public listing carries no log: the icon on the page asks the route, with the session.
    const listed = (await call("GET", "/factory?limit=42")).json.workers.find((x: { id: string }) => x.id === "w3");
    expect(listed.log_tail).toBeUndefined();
    expect(listed.log_at).toBeUndefined();
    expect((await call("GET", "/factory/workers/w3/log", undefined, "omc_m1")).status).toBe(200);
    expect((await call("GET", "/factory/workers/w3/log", undefined, "omc_nobody")).status).toBe(401);
    await env.DB.prepare("INSERT OR IGNORE INTO contributors (login, token_hash, role) VALUES ('carol', ?, 'contributor')").bind(await sha256Hex("omc_carol")).run();
    expect((await call("GET", "/factory/workers/w3/log", undefined, "omc_carol")).status).toBe(403);
    // A secret in a line: the chunk is not kept, a word about it is.
    await call("POST", "/factory/claim", { arch: "aarch64", log: "[10:01:00] env: OMARCHY_WORKER_TOKEN=omw_abcdefghijklmnopqrstuvwxyz0123456789abcdef\n" }, "omw_w3");
    const after = (await call("GET", "/factory/workers/w3/log", undefined, "omc_alice")).json.log;
    expect(after).not.toContain("omw_abcdefghij");
    expect(after).toMatch(/dropped: one looked like/);
    // Bounded: a chunk is its last 4 KB, the history its last 8 KB.
    await call("POST", "/factory/claim", { arch: "aarch64", log: "x".repeat(5000) + "\n" }, "omw_w3");
    await call("POST", "/factory/claim", { arch: "aarch64", log: "y".repeat(5000) + "\n" }, "omw_w3");
    const bounded = (await call("GET", "/factory/workers/w3/log", undefined, "omc_alice")).json.log;
    expect(bounded.length).toBeLessThanOrEqual(8192);
    expect(bounded.endsWith("y".repeat(4095) + "\n")).toBe(true);
    expect(bounded).toContain("x".repeat(4095) + "\n");
  });
});

describe("one job at a time on a ring", () => {
  it("a promotion into rc, a render of rc and the security fast-track wait for each other; a render of stable and a health check do not", async () => {
    // A clean queue: what earlier tests left queued for the project's workers would be handed out first.
    await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'lock test' WHERE status IN ('queued', 'leased') AND trust = 'project'").run();
    const ins = (kind: string, params: Record<string, string>, arch = "aarch64") =>
      env.DB.prepare("INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, kind, status, params) VALUES (?, ?, '-', ?, 'lock', 100, 0, 'project', ?, 'queued', ?)").bind(kind, arch, kind, kind, JSON.stringify(params)).run();
    await ins("promote", { from: "edge", to: "rc", note: "test" });
    await ins("render", { ring: "rc", arch: "aarch64" });
    await ins("security", {});
    await ins("render", { ring: "stable", arch: "aarch64" });
    await ins("health", { ring: "rc", arch: "aarch64" });
    const claim = (w: string) => call("POST", "/factory/claim", { arch: "aarch64", kinds: ["promote", "render", "security", "health"] }, w);
    // w1 takes the promotion (first by id); the render of rc and the fast-track wait behind it — w2 gets the render of stable, then the health.
    const first = await claim("omw_w1");
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.task.kind).toBe("promote");
    const second = await claim("omw_w2");
    expect(second.status).toBe(200);
    expect(second.json.task).toMatchObject({ kind: "render", params: { ring: "stable" } });
    await call("POST", `/factory/tasks/${second.json.task.id}/complete`, { result: {}, summary: "rendered" }, "omw_w2");
    const third = await claim("omw_w2");
    expect(third.status).toBe(200);
    expect(third.json.task.kind).toBe("health");
    await call("POST", `/factory/tasks/${third.json.task.id}/complete`, { result: {}, summary: "checked" }, "omw_w2");
    expect((await claim("omw_w2")).status).toBe(204);
    // The promotion done: the render of rc goes; the fast-track waits for it, being exclusive with every ring.
    await call("POST", `/factory/tasks/${first.json.task.id}/fail`, { error: "test over", final: true }, "omw_w1");
    const fourth = await claim("omw_w1");
    expect(fourth.status).toBe(200);
    expect(fourth.json.task).toMatchObject({ kind: "render", params: { ring: "rc" } });
    expect((await claim("omw_w2")).status).toBe(204);
    await call("POST", `/factory/tasks/${fourth.json.task.id}/complete`, { result: {}, summary: "rendered" }, "omw_w1");
    const fifth = await claim("omw_w2");
    expect(fifth.status).toBe(200);
    expect(fifth.json.task.kind).toBe("security");
    await call("POST", `/factory/tasks/${fifth.json.task.id}/complete`, { result: {}, summary: "matched" }, "omw_w2");
  });
});
