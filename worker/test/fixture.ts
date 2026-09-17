/**
 * One dashboard's worth of data, seeded the way the pipeline and the
 * factory would have written it — through the Worker's own endpoints where
 * an endpoint exists, straight into D1 where the pipeline writes rows
 * itself — so every page has something to draw and every manifest
 * (src/pages/components.ts) has ids to bind its paths to. The recipes are
 * the ones the endpoint tests use: releases.test.ts for the pool,
 * factory.test.ts for the workers and the review, metrics.test.ts for the
 * journal and the bill, tests/e2e-worker.sh for the sessions and the
 * advisories. What comes back is `Fixture` (components.ts), one field per
 * id a page can be opened on.
 *
 * The people: bob, a contributor with nothing of his own; alice, who
 * requested `mine` and runs the community worker w3 that built it; m1 and
 * m2, the maintainers — w1 is m1's project worker, m2 asked for the
 * project's build and approved it. Every login signs in with the cookie
 * `omc=oms_<login>` and the CLI token `omc_<login>`; the workers' tokens are
 * `omw_<id>`. `F.sessions` maps the three signed-in roles to their cookie.
 *
 * The story of `mine`, in the order the rows were written: alice's
 * request (F.request) queued a build; w3 claimed it, staged its evidence
 * (PKGBUILD, build.log, PKGINFO, tests.log, vet.json) and the package
 * (F.contributorTask); w1 took the audit and wrote its report; m2 had the
 * project build it again (F.projectTask), w1 built and staged that,
 * audited it, ran the trial, and m2 approved it (F.approval) — its publish job sits in the
 * queue. Two later community builds of `mine` are staged and undecided:
 * F.stagedTask for the probes that must not change anything, and
 * F.disposableTask for the act that rejects it.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/index";
import worker from "../src/index";
import { issueJobToken } from "../src/jobtoken";
import { packageKey } from "../src/r2";
import { sha256Hex } from "../src/routes/contributors";
import type { Fixture } from "../src/pages/components";

export type { Fixture };

const API = "http://pool.test/api/v1";

interface Answer { status: number; json: any }

async function call(env: Env, method: string, path: string, body?: unknown, token?: string, raw?: string): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(API + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.json().catch(() => null) };
}

function must(a: Answer, want: number, what: string): Answer {
  if (a.status !== want) throw new Error(`fixture: ${what} answered ${a.status} ${JSON.stringify(a.json)}`);
  return a;
}

/** A job token with the scopes a pipeline job gets, one hour long. */
function job(env: Env, scopes: string[]): Promise<string> {
  return issueJobToken(env, { t: 1, k: "test", s: scopes, e: Math.floor(Date.now() / 1000) + 3600, w: "w-test" });
}

const fakeSha = (s: string) => Array.from({ length: 64 }, (_, i) => s.charCodeAt(i % s.length).toString(16).slice(-1)).join("");

interface Pkg { name: string; version: string; requires?: string[]; provides?: string[] }

/** Puts a fake object in the pool and indexes its manifest, as the sync does. */
async function index(env: Env, source: string, arch: string, p: Pkg, token: string): Promise<string> {
  const filename = `${p.name}-${p.version}-${arch}.pkg.tar.zst`;
  const bytes = new TextEncoder().encode(`fake ${filename}`);
  await env.PACKAGES.put(packageKey(source, arch, filename), bytes);
  const sha = fakeSha(`${source}/${arch}/${filename}`);
  must(
    await call(env, "POST", `/packages?source=${source}&arch=${arch}`, {
      schema_version: 1, name: p.name, version: p.version, arch, sha256: sha, filename,
      size_download: bytes.length, size_installed: bytes.length * 3, description: `${p.name} for the dashboard's tests`,
      provides: [p.name, ...(p.provides ?? [])], requires: p.requires ?? [], pkginfo: { provides: p.provides ?? [] }, files: [`usr/bin/${p.name}`], components: [],
    }, token),
    201,
    `index ${p.name}`,
  );
  return sha;
}

export async function seedDashboard(env: Env): Promise<Fixture> {
  const arch = "x86_64";
  const h = (t: string) => sha256Hex(t);

  // The pool: zlib and xz from core, released to stable.
  const pool = await job(env, ["pool:write"]);
  const stable = await job(env, ["release:edge", "release:rc", "release:stable", "artifacts:*:stable"]);
  const zlib = await index(env, "core", arch, { name: "zlib", version: "1:1.3.2-3", provides: ["libz.so=1-64"] }, pool);
  const xz = await index(env, "core", arch, { name: "xz", version: "5.8.4-1", requires: ["zlib", "libz.so=1-64"], provides: ["liblzma.so=5-64"] }, pool);
  const release = must(await call(env, "POST", "/releases", { ring: "stable", add: [zlib, xz], note: "the dashboard's fixture" }, stable), 201, "release stable").json.release.id as number;

  // The people and the workers, as governance and registration would have written them.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES
      ('w1', ?, 'm1', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z'),
      ('w3', ?, 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z')`).bind(arch, await h("omw_w1"), arch, await h("omw_w3")),
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('m1', ?, ?, 'maintainer'), ('m2', ?, ?, 'maintainer'), ('alice', ?, ?, 'contributor'), ('bob', ?, ?, 'contributor')`)
      .bind(await h("omc_m1"), await h("oms_m1"), await h("omc_m2"), await h("oms_m2"), await h("omc_alice"), await h("oms_alice"), await h("omc_bob"), await h("oms_bob")),
  ]);

  // alice's request: registered, its record on the pool, one build queued for x86_64.
  const requested = must(
    await call(env, "POST", "/factory/packages", {
      name: "mine", url: "https://mine.example", source: "https://mine.example/mine-1.0.tar.gz", version: "1.0",
      description: "Mine, a small tool for the tests", license: "MIT", arches: [arch], checklist: { official: true, license: true, unshipped: true, evidence: true },
    }, "omc_alice"),
    201,
    "request mine",
  ).json;
  const request = requested.request.id as number;

  // Her worker builds it: the claim, the evidence, the gate's verdict, the package — staged, the audit queued.
  const agent = { agent: "openai/gpt-5", agent_status: "ok", agent_checked_at: "2026-09-15T12:00:00Z" };
  const claimed = must(await call(env, "POST", "/factory/claim", { arch, ...agent }, "omw_w3"), 200, "w3 claims").json;
  const contributorTask = claimed.task.id as number;
  const stage = async (task: number, token: string, whose: string) => {
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", "tests.log", `mine-1.0-1-${arch}.pkg.tar.zst`]) must(await call(env, "PUT", `/factory/tasks/${task}/artifacts/${f}`, undefined, token, `${whose} ${f}`), 201, `stage ${f} of ${task}`);
    must(await call(env, "PUT", `/factory/tasks/${task}/artifacts/vet.json`, undefined, token, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "pass", checks: [{ name: "checksums", status: "pass", detail: "" }, { name: "check", status: "warn", detail: "no check()" }] })), 201, `vet.json of ${task}`);
  };
  await stage(contributorTask, claimed.token, "alice's");
  must(await call(env, "POST", `/factory/tasks/${contributorTask}/complete`, { sha256: "b".repeat(64), filename: `mine-1.0-1-${arch}.pkg.tar.zst`, version: "1.0-1", duration_ms: 42000 }, claimed.token), 200, "complete alice's build");

  // The audit of a staged build, by the project's worker with its own agent: the report beside the evidence.
  const project = { arch, kinds: ["build", "audit", "trial", "publish"], agent: "claude-code/claude-sonnet-5", agent_status: "ok" };
  const claimProject = async (kind: string, what: string) => {
    const c = must(await call(env, "POST", "/factory/claim", project, "omw_w1"), 200, `w1 claims ${what}`).json;
    if (c.task.kind !== kind) throw new Error(`fixture: w1 claimed a ${c.task.kind} (task ${c.task.id}), not ${what}`);
    return c;
  };
  const audit = async (task: number) => {
    const a = await claimProject("audit", `the audit of ${task}`);
    if (a.task.params.task !== task) throw new Error(`fixture: the audit w1 claimed is of task ${a.task.params.task}, not ${task}`);
    must(await call(env, "PUT", `/factory/tasks/${task}/artifacts/audit.json`, undefined, a.token, JSON.stringify({ verdict: "ok", summary: "nothing to change", findings: [] })), 201, `audit.json of ${task}`);
    must(await call(env, "PUT", `/factory/tasks/${task}/artifacts/audit.md`, undefined, a.token, "# Audit: ok\n\nNothing to change."), 201, `audit.md of ${task}`);
    must(await call(env, "POST", `/factory/tasks/${a.task.id}/complete`, { summary: "ok", result: { verdict: "ok", summary: "nothing to change", model: "test", category: "terminal", findings: [] } }, a.token), 200, `complete the audit of ${task}`);
  };
  await audit(contributorTask);

  // m2 has the project build it again; w1 builds, stages, audits and tries it; m2 approves.
  const projectTask = must(await call(env, "POST", `/factory/tasks/${contributorTask}/build`, { note: "reads well" }, "omc_m2"), 200, "build by the project").json.task as number;
  const built = await claimProject("build", "the project's build");
  if (built.task.id !== projectTask) throw new Error(`fixture: w1 claimed task ${built.task.id}, not the project's build ${projectTask}`);
  await stage(projectTask, built.token, "the project's");
  must(await call(env, "POST", `/factory/tasks/${projectTask}/complete`, { sha256: "e".repeat(64), filename: `mine-1.0-1-${arch}.pkg.tar.zst`, version: "1.0-1", duration_ms: 90000 }, built.token), 200, "complete the project's build");
  await audit(projectTask);
  const trial = await claimProject("trial", "the trial");
  must(await call(env, "PUT", `/factory/tasks/${projectTask}/artifacts/trial.log`, undefined, trial.token, "== pacman -S mine\nTRIAL=ok"), 201, "trial.log");
  must(await call(env, "POST", `/factory/tasks/${trial.task.id}/complete`, { result: { verdict: "ok", packages: ["mine"], task: projectTask }, duration_ms: 30000 }, trial.token), 200, "complete the trial");
  must(await call(env, "POST", `/factory/tasks/${projectTask}/approve`, { note: "looks right" }, "omc_m2"), 200, "approve");
  const approval = (await env.DB.prepare("SELECT id FROM approvals WHERE task_id = ? AND decision = 'approved'").bind(projectTask).first<{ id: number }>())!.id;

  // Two more of alice's builds, staged and undecided — written as rows, the way a build older than the gate sits in the table.
  const staged = async (version: string) =>
    (await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, lease_owner, staged_prefix, result, finished_at)
       VALUES ('mine', ?, ?, 'draft:https://mine.example@latest', 'contributor', 100, 0, 'community', 'alice', 'build', 'staged', 'w3', ?, '{"vet":{"verdict":"pass","fails":0,"warnings":0,"failed":[],"warned":[]}}', ?) RETURNING id`,
    ).bind(arch, version, `staging/alice/mine/${version}/`, new Date().toISOString()).first<{ id: number }>())!.id;
  const stagedTask = await staged("1.0-2");
  const disposableTask = await staged("1.0-3");

  // The journal and the bill.
  const event = (await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('promote', 'stable', 'x86_64', 'ok', 'stable: 2 packages from core', ?) RETURNING id")
    .bind(JSON.stringify({ release, added: 2 })).first<{ id: number }>())!.id;
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cost_latest', ?)").bind(JSON.stringify({ estimated_at: "2026-09-16T12:00:00Z", status: "ok", month: "2026-09", month_to_date_usd: 8.86, projected_usd: 17.5 })).run();

  // One advisory on zlib, matched on the object stable serves.
  const security = await job(env, ["security:write"]);
  const advisory = "arch:AVG-9999:zlib";
  must(await call(env, "PUT", "/security/advisories", { advisories: [{ id: advisory, source: "arch", package: "zlib", cves: ["CVE-2099-0001"], severity: "high", status: "vulnerable", fixed: null, url: "https://security.archlinux.org/AVG-9999" }], cves: [{ cve: "CVE-2099-0001", kev: true, epss: 0.9 }] }, security), 200, "advisories");
  must(await call(env, "PUT", "/security/matches", { matches: [{ sha256: zlib, advisory, match: "exact", status: "vulnerable" }] }, security), 200, "matches");

  return {
    arch, pkg: "zlib", pkg2: "xz", release, sha: zlib,
    contributor: "bob", owner: "alice", m1: "m1", m2: "m2",
    factoryPkg: "mine", request, worker: "w1", communityWorker: "w3",
    contributorTask, projectTask, approval, stagedTask, disposableTask, event, advisory,
    sessions: { contributor: "oms_bob", owner: "oms_alice", maintainer: "oms_m2" },
  };
}
