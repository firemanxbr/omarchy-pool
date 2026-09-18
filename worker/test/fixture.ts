/**
 * One dashboard's worth of data, seeded the way the pipeline and the
 * factory would have written it — through the Worker's own endpoints where
 * an endpoint exists, straight into D1 where the pipeline writes rows
 * itself — so every page has something to draw and every manifest
 * (src/pages/components.ts) has ids to bind its paths to. The recipes are
 * the ones the endpoint tests use: releases.test.ts for the pool,
 * factory.test.ts for the workers, the review and the publish,
 * metrics.test.ts for the journal and the bill, tests/e2e-worker.sh for the
 * sessions and the advisories. What comes back is `Fixture`
 * (components.ts), one field per id a page can be opened on.
 *
 * The pool: core's zlib, xz and bzip2 made the first stable release; the
 * second — the head, F.release — upgraded xz, added zstd and dropped bzip2,
 * so the ring's diff has all three kinds of row. xz declares zlib and loads
 * libz.so.1, so zlib's page has `required_by` and xz's has `depends` and
 * `links`. The advisory is on stable's zlib; edge serves a newer, clean
 * zlib, so the security page has a fix in another ring. The stable head has
 * a rendered database (the pacman.conf sections), and the pool signs — a
 * key made here, so the seal, the artifacts and the signing-key endpoint
 * have something to say.
 *
 * The people: bob, a contributor with nothing of his own; alice, who
 * requested `mine` and `ours` and runs the community worker w3 that built
 * them; carol, blocked by m1 with her package `hers` — the brake's table has
 * a row, and m2 is the other maintainer who could lift it; m1 and m2, the
 * maintainers — w1 is m1's project worker, m2 asked for the project's
 * builds and approved them. Every login signs in with the cookie
 * `omc=oms_<login>` and the CLI token `omc_<login>`; the workers' tokens
 * are `omw_<id>`. `F.sessions` maps the three signed-in roles to their
 * cookie.
 *
 * Two stories, the same steps: a request queued a build; w3 claimed it,
 * staged its evidence (PKGBUILD, build.log, PKGINFO, tests.log, vet.json,
 * resources.json) and the package; w1 took the audit and wrote its report;
 * m2 had the project build it again, w1 built and staged that, audited it,
 * ran the trial, and m2 approved it. `ours` went the whole way: w1 took the
 * publish job, put the object in the pool and released it into edge — its
 * page has the seal's chain and the Who cards' factory branch. `mine`
 * (F.contributorTask, F.projectTask) stops before that: its
 * publish job sits in the queue, so its project build is still staged with
 * its evidence — what the build page, the review and the person's page
 * show. Three later community builds of `mine` are staged and undecided:
 * F.stagedTask for the probes that must not change anything,
 * F.disposableTask and F.spareTask for the acts that reject a row.
 *
 * One pool job of every kind sits done in the queue (F.jobs), its params
 * as the brain queues them and its result as the Rust worker posts it, so
 * the Pipeline's table has every shape it words.
 *
 * The journal has one line of every kind the charts read — a sync, a
 * health check, a promotion, a role change, a day of audience — and the
 * metrics snapshot is taken last, over everything above.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import * as openpgp from "openpgp";
import type { Env } from "../src/index";
import worker from "../src/index";
import { issueJobToken } from "../src/jobtoken";
import { snapshotMetrics } from "../src/metrics";
import { packageKey } from "../src/r2";
import { sha256Hex } from "../src/routes/contributors";
import { syncJobFor } from "../src/scheduler";
import type { Fixture } from "../src/pages/components";
import { HELPERS } from "../src/pages/layout";

export type { Fixture };

/** The inline scripts of a served page, joined: what the page runs, for the tests that read it (components.test.ts, pages.test.ts). */
export const scriptOf = (html: string): string => [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

// The page's own script is what follows the shell: page() splices HELPERS whole, so its last lines mark where the page's statements begin — a check on what a page draws must not read the shell's workerRow, avatar or personLink as the page's. Null when the shell is not spliced whole.
const shellEnd = HELPERS.slice(-120);
export function ownScriptOf(html: string): string | null {
  const script = scriptOf(html), at = script.indexOf(shellEnd);
  return at > 0 ? script.slice(at + shellEnd.length) : null;
}

/** What runScript hands back: the document's nodes by the selector they were asked for, the functions asked for by name, and a setter per variable asked for. */
export type Ran = { nodes: Record<string, any> } & Record<string, any>;

/**
 * A page's script — a served page's whole script with its IIFE opened, or
 * the shell alone — run the way the tests draw with it: ES5 written for a
 * browser, against a document that keeps every node written to by selector
 * (a node's children are what the script appended, so a tile row can be
 * read back) and a fetch that never answers unless the test hands one in
 * (`fetch`: no-answer.test.ts answers every read with a 500), so only the
 * functions that draw are exercised. `functions` names the script's own
 * functions to hand back (decisionCell, gate, a page's button makers),
 * `variables` the script's variables to get a setter for (`setCAN(v)`,
 * `setWHO(v)`). decision-cell.test.ts runs the shell this way,
 * user-page.test.ts a person's page.
 */
export function runScript(code: string, opts: { pathname: string; functions: string[]; variables?: string[]; fetch?: (path: string, init?: RequestInit) => Promise<Response> }): Ran {
  const trimmed = code.trim();
  const body = trimmed.startsWith("(function () {") && trimmed.endsWith("})();") ? trimmed.slice("(function () {".length, -"})();".length) : trimmed;
  const nodes: Record<string, any> = {};
  // A node by selector holds what the script wrote to it; a table's tBodies[0] is the node of "<sel> tbody", so the pager's rows are read back by that selector, and a parent is a node of its own for what the pager builds around a table.
  const node = (sel?: string): any => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, children: [] as any[], hidden: false, innerHTML: "", outerHTML: "", textContent: "", title: "",
    appendChild(c: any) { this.children.push(c); return c; },
    replaceChild(n: any, o: any) { const i = this.children.indexOf(o); if (i >= 0) this.children[i] = n; return o; },
    removeChild(c: any) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    insertBefore(n: any) { this.children.unshift(n); return n; },
    get lastChild() { return this.children[this.children.length - 1] ?? null; },
    get parentElement() { return (this._parent = this._parent || node()); },
    previousElementSibling: null,
    get tBodies() { return sel ? [document.querySelector(`${sel} tbody`)] : [node()]; },
    setAttribute() {}, getAttribute: () => null, insertAdjacentHTML() {}, remove() {}, focus() {}, closest: () => null, addEventListener() {},
    querySelector: () => node(), querySelectorAll: () => [],
  });
  const document = {
    querySelector: (sel: string) => (nodes[sel] = nodes[sel] || node(sel)),
    querySelectorAll: () => [], addEventListener() {}, createElement: () => node(), body: node(), documentElement: { getAttribute: () => null }, title: "",
  };
  const out = [
    "nodes: nodes",
    ...opts.functions.map((f) => `${f}: ${f}`),
    ...(opts.variables ?? []).map((v) => `set${v}: function (x) { ${v} = x; }`),
  ].join(", ");
  const make = new Function("document", "window", "fetch", "location", "innerWidth", "nodes", `${body}\n return { ${out} };`);
  return make(document, { matchMedia: null }, opts.fetch ?? (() => new Promise(() => {})), { pathname: opts.pathname, origin: "http://pool.test" }, 1024, nodes);
}

const API = "http://pool.test/api/v1";

interface Answer { status: number; json: any }

async function call(env: Env, method: string, path: string, body?: unknown, token?: string, raw?: string | Uint8Array): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw instanceof Uint8Array) headers["content-type"] = "application/octet-stream";
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

interface Pkg {
  name: string;
  version: string;
  /** What .PKGINFO declares it depends on. */
  depends?: string[];
  /** Everything its binaries need: the declared names and the sonames they load. */
  requires?: string[];
  /** What .PKGINFO declares it provides. */
  provides?: string[];
  /** The sonames its libraries carry, as the sync reads them from the ELF files. */
  sonames?: string[];
  /** An embedded library the sync found in a static binary. */
  components?: { ecosystem: string; name: string; version: string }[];
}

/** Puts a fake object in the pool and indexes its manifest, as the sync does (manifest.schema.json). */
async function index(env: Env, source: string, arch: string, p: Pkg, token: string): Promise<string> {
  const filename = `${p.name}-${p.version}-${arch}.pkg.tar.zst`;
  const bytes = new TextEncoder().encode(`fake ${filename}`);
  await env.PACKAGES.put(packageKey(source, arch, filename), bytes);
  const sha = fakeSha(`${source}/${arch}/${filename}`);
  must(
    await call(env, "POST", `/packages?source=${source}&arch=${arch}`, {
      schema_version: 1, name: p.name, version: p.version, arch, sha256: sha, filename,
      size_download: bytes.length, size_installed: bytes.length * 3, description: `${p.name} for the dashboard's tests`,
      url: `https://${p.name}.example`, licenses: ["MIT"],
      provides: [p.name, ...(p.provides ?? []), ...(p.sonames ?? [])], requires: p.requires ?? [],
      pkginfo: { base: p.name, builddate: 1757894400, packager: "A Packager <packager@example.org>", depends: p.depends ?? [], provides: p.provides ?? [] },
      files: [`usr/bin/${p.name}`], components: p.components ?? [],
    }, token),
    201,
    `index ${p.name}`,
  );
  return sha;
}

export async function seedDashboard(env: Env): Promise<Fixture> {
  const arch = "x86_64";

  // The pool signs in the tests too: a key of its own, made here (signing.test.ts makes one the same way).
  env.SIGNING_KEY = (await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "Pool Test", email: "test@omarchy.invalid" }], format: "armored" })).privateKey;

  // The pool: core's zlib, xz and bzip2 released to stable; a second stable release upgrades xz, adds zstd and drops bzip2.
  const pool = await job(env, ["pool:write"]);
  const stable = await job(env, ["release:edge", "release:rc", "release:stable", "artifacts:*:stable"]);
  const zlib = await index(env, "core", arch, { name: "zlib", version: "1:1.3.2-3", provides: ["libz.so=1-64"], sonames: ["libz.so.1"], components: [{ ecosystem: "crates.io", name: "libz-sys", version: "1.1.0" }] }, pool);
  const xzLinks = { depends: ["zlib"], requires: ["zlib", "libz.so.1"], provides: ["liblzma.so=5-64"], sonames: ["liblzma.so.5"] };
  const xz = await index(env, "core", arch, { name: "xz", version: "5.8.4-1", ...xzLinks }, pool);
  const bzip2 = await index(env, "core", arch, { name: "bzip2", version: "1.0.8-6", provides: ["libbz2.so=1.0-64"], sonames: ["libbz2.so.1.0"] }, pool);
  const previousRelease = must(await call(env, "POST", "/releases", { ring: "stable", add: [zlib, xz, bzip2], note: "the dashboard's fixture" }, stable), 201, "release stable").json.release.id as number;
  const xzNewer = await index(env, "core", arch, { name: "xz", version: "5.8.5-1", ...xzLinks }, pool);
  const zstd = await index(env, "core", arch, { name: "zstd", version: "1.5.7-1", provides: ["libzstd.so=1-64"], sonames: ["libzstd.so.1"] }, pool);
  const release = must(await call(env, "POST", "/releases", { ring: "stable", add: [xzNewer, zstd], remove: ["bzip2"], note: "xz 5.8.5, zstd in, bzip2 out" }, stable), 201, "release stable again").json.release.id as number;
  // Edge serves a newer zlib with no advisory on it: the fix stable does not have yet.
  const zlibFixed = await index(env, "core", arch, { name: "zlib", version: "1:1.3.2-4", provides: ["libz.so=1-64"], sonames: ["libz.so.1"], components: [{ ecosystem: "crates.io", name: "libz-sys", version: "1.1.1" }] }, pool);
  const edge = must(await call(env, "POST", "/releases", { ring: "edge", add: [zlibFixed], note: "zlib 1:1.3.2-4" }, stable), 201, "release edge").json.release as { id: number; seq: number };
  // The stable head's rendered database, as the render job puts it (releases.test.ts).
  must(await call(env, "PUT", `/releases/${release}/artifacts/db?repo=omarchy-core-stable&arch=${arch}`, undefined, stable, new TextEncoder().encode("a rendered database")), 201, "render stable");

  // The people and the workers, as governance and registration would have written them.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES
      ('w1', ?, 'm1', ?, 'shared', 'project', 'm1', '2000-01-01T00:00:00Z'),
      ('w3', ?, 'alice', ?, 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z')`).bind(arch, await sha256Hex("omw_w1"), arch, await sha256Hex("omw_w3")),
    env.DB.prepare(`INSERT INTO factory_maintainers (login) VALUES ('m1'), ('m2')`),
    env.DB.prepare(`INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('m1', ?, ?, 'maintainer'), ('m2', ?, ?, 'maintainer'), ('alice', ?, ?, 'contributor'), ('bob', ?, ?, 'contributor'), ('carol', ?, ?, 'contributor')`)
      .bind(await sha256Hex("omc_m1"), await sha256Hex("oms_m1"), await sha256Hex("omc_m2"), await sha256Hex("oms_m2"), await sha256Hex("omc_alice"), await sha256Hex("oms_alice"), await sha256Hex("omc_bob"), await sha256Hex("oms_bob"), await sha256Hex("omc_carol"), await sha256Hex("oms_carol")),
  ]);

  // alice's request: registered, its record on the pool, one build queued for x86_64.
  const request = async (name: string, version: string, token: string) =>
    must(
      await call(env, "POST", "/factory/packages", {
        name, url: `https://${name}.example`, source: `https://${name}.example/${name}-${version}.tar.gz`, version,
        description: `${name.slice(0, 1).toUpperCase()}${name.slice(1)}, a small tool for the tests`, license: "MIT", arches: [arch], checklist: { official: true, license: true, unshipped: true, evidence: true },
      }, token),
      201,
      `request ${name}`,
    ).json.request.id as number;

  // A worker's build: the claim, the evidence, the gate's verdict, what it cost, the package — staged, the audit queued.
  const agent = { agent: "openai/gpt-5", agent_status: "ok", agent_checked_at: "2026-09-15T12:00:00Z" };
  const stage = async (task: number, token: string, whose: string, name: string, version: string) => {
    for (const f of ["PKGBUILD", "build.log", "PKGINFO", "tests.log", `${name}-${version}-${arch}.pkg.tar.zst`]) must(await call(env, "PUT", `/factory/tasks/${task}/artifacts/${f}`, undefined, token, `${whose} ${f}`), 201, `stage ${f} of ${task}`);
    must(await call(env, "PUT", `/factory/tasks/${task}/artifacts/vet.json`, undefined, token, JSON.stringify({ schema: "omarchy-pool/vet/1", verdict: "pass", checks: [{ name: "checksums", status: "pass", detail: "" }, { name: "check", status: "warn", detail: "no check()" }] })), 201, `vet.json of ${task}`);
    must(await call(env, "PUT", `/factory/tasks/${task}/artifacts/resources.json`, undefined, token, JSON.stringify({ schema: "omarchy-pool/resources/1", wall_s: 42, cpu_s: 80, ram_peak_mb: 512, disk_mb: 300, cores: 4 })), 201, `resources.json of ${task}`);
  };
  // The project's worker, with its own agent, takes the pool's jobs one kind at a time.
  const project = { arch, agent: "claude-code/claude-sonnet-5", agent_status: "ok" };
  const claimProject = async (kinds: string[], what: string) => {
    const c = must(await call(env, "POST", "/factory/claim", { ...project, kinds }, "omw_w1"), 200, `w1 claims ${what}`).json;
    if (!kinds.includes(c.task.kind)) throw new Error(`fixture: w1 claimed a ${c.task.kind} (task ${c.task.id}), not ${what}`);
    return c;
  };
  const audit = async (task: number) => {
    const a = await claimProject(["audit"], `the audit of ${task}`);
    if (a.task.params.task !== task) throw new Error(`fixture: the audit w1 claimed is of task ${a.task.params.task}, not ${task}`);
    must(await call(env, "PUT", `/factory/tasks/${task}/artifacts/audit.json`, undefined, a.token, JSON.stringify({ verdict: "ok", summary: "nothing to change", findings: [] })), 201, `audit.json of ${task}`);
    must(await call(env, "PUT", `/factory/tasks/${task}/artifacts/audit.md`, undefined, a.token, "# Audit: ok\n\nNothing to change."), 201, `audit.md of ${task}`);
    must(await call(env, "POST", `/factory/tasks/${a.task.id}/complete`, { summary: "ok", result: { verdict: "ok", summary: "nothing to change", model: "test", category: "terminal", findings: [] } }, a.token), 200, `complete the audit of ${task}`);
  };
  /**
   * The story up to the approval: alice's worker builds and stages the
   * request, w1 audits it, m2 has the project build it again, w1 builds,
   * stages, audits and tries it, m2 approves. The publish job is queued.
   */
  const story = async (name: string, version: string) => {
    await request(name, version, "omc_alice");
    const claimed = must(await call(env, "POST", "/factory/claim", { arch, ...agent }, "omw_w3"), 200, `w3 claims ${name}`).json;
    if (claimed.task.name !== name) throw new Error(`fixture: w3 claimed ${claimed.task.name}, not ${name}`);
    const contributorTask = claimed.task.id as number;
    await stage(contributorTask, claimed.token, "alice's", name, `${version}-1`);
    must(await call(env, "POST", `/factory/tasks/${contributorTask}/complete`, { sha256: fakeSha(`alice ${name}`), filename: `${name}-${version}-1-${arch}.pkg.tar.zst`, version: `${version}-1`, duration_ms: 42000 }, claimed.token), 200, `complete alice's build of ${name}`);
    await audit(contributorTask);
    const projectTask = must(await call(env, "POST", `/factory/tasks/${contributorTask}/build`, { note: "reads well" }, "omc_m2"), 200, `build ${name} by the project`).json.task as number;
    const built = await claimProject(["build"], `the project's build of ${name}`);
    if (built.task.id !== projectTask) throw new Error(`fixture: w1 claimed task ${built.task.id}, not the project's build ${projectTask}`);
    await stage(projectTask, built.token, "the project's", name, `${version}-1`);
    const sha = fakeSha(`factory/${arch}/${name}-${version}-1-${arch}.pkg.tar.zst`);
    must(await call(env, "POST", `/factory/tasks/${projectTask}/complete`, { sha256: sha, filename: `${name}-${version}-1-${arch}.pkg.tar.zst`, version: `${version}-1`, duration_ms: 90000 }, built.token), 200, `complete the project's build of ${name}`);
    await audit(projectTask);
    const trial = await claimProject(["trial"], `the trial of ${name}`);
    must(await call(env, "PUT", `/factory/tasks/${projectTask}/artifacts/trial.log`, undefined, trial.token, `== pacman -S ${name}\nTRIAL=ok`), 201, `trial.log of ${name}`);
    must(await call(env, "POST", `/factory/tasks/${trial.task.id}/complete`, { result: { verdict: "ok", packages: [name], task: projectTask }, duration_ms: 30000 }, trial.token), 200, `complete the trial of ${name}`);
    const publish = must(await call(env, "POST", `/factory/tasks/${projectTask}/approve`, { note: "looks right" }, "omc_m2"), 200, `approve ${name}`).json.publish as number;
    return { contributorTask, projectTask, publish, sha };
  };

  // `ours` goes the whole way: w1 takes the publish job, puts the object in the pool, indexes and releases it into edge (factory.test.ts).
  const ours = await story("ours", "2.0");
  const publishing = await claimProject(["publish"], "the publish of ours");
  if (publishing.task.id !== ours.publish) throw new Error(`fixture: w1 claimed task ${publishing.task.id}, not the publish job ${ours.publish}`);
  const oursFile = `ours-2.0-1-${arch}.pkg.tar.zst`;
  const oursBytes = new TextEncoder().encode("the project's build of ours");
  await env.PACKAGES.put(packageKey("factory", arch, oursFile), oursBytes);
  must(
    await call(env, "POST", `/packages?source=factory&arch=${arch}`, {
      schema_version: 1, name: "ours", version: "2.0-1", arch, sha256: ours.sha, filename: oursFile, size_download: oursBytes.length, size_installed: oursBytes.length * 3,
      description: "Ours, a small tool for the tests", url: "https://ours.example", licenses: ["MIT"], provides: ["ours"], requires: [], pkginfo: { base: "ours", builddate: 1757980800, packager: "the project", depends: [], provides: [] }, files: ["usr/bin/ours"], components: [],
    }, publishing.token),
    201,
    "index ours",
  );
  must(await call(env, "POST", `/factory/tasks/${ours.publish}/complete`, { summary: "published", result: { sha256: ours.sha, filename: oursFile, version: "2.0-1", task: ours.projectTask }, duration_ms: 5000 }, publishing.token), 200, "complete the publish of ours");
  must(await call(env, "POST", "/releases", { ring: "edge", add: [ours.sha], note: "ours 2.0-1, approved by m2" }, publishing.token), 201, "release ours into edge");

  // `mine` stops at the approval: its publish job waits, its project build is staged with everything on it.
  const mine = await story("mine", "1.0");

  // Three more of alice's builds of mine, staged and undecided — written as rows, the way a build older than the gate sits in the table.
  const staged = async (version: string) =>
    (await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, lease_owner, staged_prefix, result, finished_at)
       VALUES ('mine', ?, ?, 'draft:https://mine.example@latest', 'contributor', 100, 0, 'community', 'alice', 'build', 'staged', 'w3', ?, '{"vet":{"verdict":"pass","fails":0,"warnings":0,"failed":[],"warned":[]}}', ?) RETURNING id`,
    ).bind(arch, version, `staging/alice/mine/${version}/`, new Date().toISOString()).first<{ id: number }>())!.id;
  const stagedTask = await staged("1.0-2");
  const disposableTask = await staged("1.0-3");
  const spareTask = await staged("1.0-4");

  // One done pool job of every kind the Pipeline's table words, as the
  // brain queued it (src/scheduler.ts, src/jobs.ts: the params) and the
  // Rust worker completed it (crates/pkg-repo/src/work.rs, every
  // `result: serde_json::json!`, copied field for field): the sync is the
  // scheduler's — one task per architecture, its sources as a list, the
  // result per source with the releases it pinned — and the promotion is
  // the one the journal line below records. The rows are written as
  // handleComplete writes them, so the table's words (pool-jobs.test.ts)
  // and the manifest's fields (pipeline.tasks-table) read what production
  // holds; a field renamed in work.rs is renamed here, and the test says
  // where the page still reads the old name.
  const sync = syncJobFor(arch);
  const sources = JSON.parse(sync.params.sources) as { source: string; ring: string }[];
  const jobRows: [string, Record<string, string>, unknown][] = [
    ["sync", sync.params, {
      arch,
      sources: sources.map((s, i) => (i === sources.length - 1
        ? { source: s.source, ring: s.ring, error: "mirror down: connection refused" }
        : { source: s.source, ring: s.ring, upstream_total: i === 0 ? 5 : 40, uploaded: i === 0 ? 2 : 0, removed: 0, failed: i === 1 ? 1 : 0 })),
      releases: [{ ring: "edge", id: edge.id, seq: edge.seq, packages: 1, unchanged: ["aarch64"] }],
      rendered: ["omarchy-core-edge"],
    }],
    ["promote", { from: "rc", to: "stable", note: "by evidence" }, { verdict: "promoted", release_id: release, rendered: ["omarchy-core-stable"] }],
    ["rollback", { ring: "stable", to: String(previousRelease), note: "the fixture's rollback" }, { ring: "stable", to: previousRelease, release_id: release, rendered: ["omarchy-core-stable"] }],
    ["render", { ring: "stable", arch }, { repos: ["omarchy-core-stable"] }],
    ["health", { ring: "stable", arch }, { ok: true }],
    ["gc", {}, { keep: 3 }],
    ["security", {}, { matches_vulnerable: 1, matches_fixed: 0, kev: 1, fast_tracked: [{ ring: "stable", fixes: 1 }], rolled_back: [] }],
    ["verify", {}, { objects: 6, bad_signatures: 0, repaired_signatures: 0, mismatched: 0, repinned: 0, unfixable: 0, repinned_rings: [], details: [] }],
    ["relayout", {}, { moved: 6, ghosts: 0, missing: 0, errors: [], rendered: ["omarchy-core-stable"], purged: 6 }],
    ["enqueue", {}, { commit: "0123456789abcdef0123456789abcdef01234567", queued: ["ours 2.0-1 x86_64"], skipped: [], up_to_date: 3 }],
  ];
  const jobs: Record<string, number> = {};
  for (const [kind, params, result] of jobRows) {
    jobs[kind] = (await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, priority, status, publish, trust, kind, params, attempts, lease_owner, started_at, finished_at, duration_ms, result)
       VALUES (?, ?, '-', 'scheduled', 50, 'done', 1, 'project', ?, ?, 1, 'w1', ?, ?, 20000, ?) RETURNING id`,
    ).bind(kind, arch, kind, JSON.stringify(params), new Date(Date.now() - 20000).toISOString(), new Date().toISOString(), JSON.stringify(result)).first<{ id: number }>())!.id;
  }

  // The brake: carol requested `hers`; m1 blocked the package, then her — m2 is the other maintainer who lifts a block.
  await request("hers", "0.1", "omc_carol");
  must(await call(env, "POST", "/factory/packages/hers/block", { reason: "the source is not the project's" }, "omc_m1"), 200, "block hers");
  must(await call(env, "POST", "/factory/contributors/carol/block", { reason: "requests under a name that is not hers" }, "omc_m1"), 200, "block carol");

  // The journal: one line of every kind the charts read, as the jobs write them (crates/pkg-repo, src/governance.ts, src/audience.ts).
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload, duration_ms) VALUES ('sync', 'edge', 'core', 'ok', 'core x86_64: 2 new packages', ?, 1000)")
      .bind(JSON.stringify({ arch, upstream_total: 5, uploaded: 2, bytes_uploaded: 4096, removed: 0, deferred: 0, concurrency: 4 })),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload, duration_ms) VALUES ('health', 'stable', ?, 'ok', 'stable x86_64: pacman -Sy ok', '{}', 500)").bind(arch),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('role', NULL, 'factory', 'ok', 'm2 is maintainer (factory/MAINTAINERS.toml)', ?)")
      .bind(JSON.stringify({ login: "m2", role: "maintainer", was: { role: "contributor" }, source: "factory/MAINTAINERS.toml" })),
    env.DB.prepare("INSERT INTO events (kind, status, summary, payload) VALUES ('audience', 'ok', ?, ?)")
      .bind(`${today}: about 300 machines`, JSON.stringify({ day: today, machines: 300, by_ring: { stable: 210, rc: 60, edge: 30 }, by_arch: { x86_64: 300 }, requests: 1234, bytes: 5_000_000, sampled: false })),
  ]);
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('promote', 'stable', ?, 'ok', 'stable: 2 packages from core', ?)")
    .bind(arch, JSON.stringify({ release_id: release, from_release_id: previousRelease, note: "xz 5.8.5, zstd in, bzip2 out", arch })).run();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cost_latest', ?)").bind(JSON.stringify({ estimated_at: "2026-09-16T12:00:00Z", status: "ok", month: "2026-09", month_to_date_usd: 8.86, projected_usd: 17.5 })).run();

  // One advisory on zlib, matched on the object stable serves.
  const security = await job(env, ["security:write"]);
  const advisory = "arch:AVG-9999:zlib";
  must(await call(env, "PUT", "/security/advisories", { advisories: [{ id: advisory, source: "arch", package: "zlib", cves: ["CVE-2099-0001"], severity: "high", status: "vulnerable", fixed: null, url: "https://security.archlinux.org/AVG-9999" }], cves: [{ cve: "CVE-2099-0001", kev: true, epss: 0.9 }] }, security), 200, "advisories");
  must(await call(env, "PUT", "/security/matches", { matches: [{ sha256: zlib, advisory, match: "exact", status: "vulnerable" }] }, security), 200, "matches");

  // The snapshot the dashboards read their totals from, over everything above.
  await snapshotMetrics(env);

  return {
    arch, pkg: "zlib", pkg2: "xz", release, previousRelease, sha: zlib,
    contributor: "bob", owner: "alice", m1: "m1", m2: "m2",
    factoryPkg: "mine", publishedPkg: "ours", worker: "w1", communityWorker: "w3",
    contributorTask: mine.contributorTask, projectTask: mine.projectTask, stagedTask, disposableTask, spareTask,
    blockedContributor: "carol", blockedPkg: "hers",
    jobs,
    sessions: { contributor: "oms_bob", owner: "oms_alice", maintainer: "oms_m2" },
  };
}
