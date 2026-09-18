import { json, readJson, type Env } from "../index";
import { maintainersOf, roleFor, GOVERNANCE_FILE } from "../governance";
import { CATEGORIES, isCategory } from "../categories";
import { isRepoArch, REPO_ARCHES } from "../r2";
import { providedBy } from "./factory";
import { pullFromRings } from "./blocks";
import { queuePosition } from "../queue";
import { standsSql } from "./story";
import { cookieOf } from "./auth";
import { putRecord, recordKey, recordUrl, withdrawRecord } from "../record";
import { version, RINGS, ringsSql, sortRings } from "../meta";
import { isTextEvidence, reclaimStagingPackages, STAGING_DAYS, STAGING_QUOTA_BYTES } from "../staging";
import { findLeak, leakMessage } from "../leak";
import { CHECKLIST, LICENSE, sourceHasPath } from "../request";

/**
 * Contributors: anyone with a GitHub identity. No permission needed to
 * request a package or run a worker for it; the project pays for nothing
 * until a maintainer starts the project's own build.
 *
 *   POST /factory/register            {github_token}            → {login, token}   the contributor token (shown once)
 *   GET  /factory/me                  (contributor token)       → who am I, my packages, my workers
 *   POST /factory/packages            {url, name?, description, license, arches?, source?, version?, checklist}
 *                                     the package request: checked, written once to the record (R2, signed), registered
 *   POST /factory/packages/:name/build {arches?, reason?}       → community tasks (results go to staging)
 *   DELETE /factory/packages/:name
 *   POST /factory/workers             {name, arch, mode: shared|dedicated, packages?, labels?} → {worker, token}
 *   DELETE /factory/workers/:id       revoke
 *   GET  /factory/packages            the registry (public)
 *
 * The GitHub token is used once, to ask api.github.com who it belongs to,
 * and never stored; a fine-grained token with no permissions is enough.
 */

// The staging quota (STAGING_QUOTA_BYTES) and its lifecycle live in staging.ts.
const QUEUED_QUOTA = 10; // tasks queued or building per contributor

async function stagingBytesUsed(env: Env, owner: string, exceptKey?: string): Promise<number> {
  const row = exceptKey
    ? await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM staging_objects WHERE owner = ? AND key != ?").bind(owner, exceptKey).first<{ bytes: number }>()
    : await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM staging_objects WHERE owner = ?").bind(owner).first<{ bytes: number }>();
  return row?.bytes ?? 0;
}

/** 413 when this upload would put a contributor over the quota. Project staging has no quota. */
async function quotaRefusal(env: Env, space: string, extra: number, exceptKey?: string): Promise<Response | null> {
  if (space === "@project") return null;
  const used = await stagingBytesUsed(env, space, exceptKey);
  if (used + extra > STAGING_QUOTA_BYTES) {
    return json(
      { error: `staging quota of ${STAGING_QUOTA_BYTES} bytes reached for ${space} (${used} used); drop a build you no longer need with DELETE /api/v1/factory/tasks/<id>/artifacts — the pool frees superseded, rejected and published builds itself, the rest after ${STAGING_DAYS} days`, used, quota_bytes: STAGING_QUOTA_BYTES },
      413,
    );
  }
  return null;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(prefix: string): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return `${prefix}_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function bearer(request: Request): string {
  const h = request.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export interface Contributor {
  login: string;
  name: string | null;
  avatar_url: string | null;
  role: string;
  /** Set by a maintainer (docs/GOVERNANCE.md): no requests, no builds, workers revoked. */
  blocked?: { at: string; reason: string | null } | null;
}

/**
 * The contributor behind the request — a `omc_…` bearer token (the CLI /
 * worker credential) or the sign-in cookie (a browser session, `oms_…`,
 * separate so signing in never invalidates a running worker) — or null.
 */
export async function contributorOf(request: Request, env: Env): Promise<Contributor | null> {
  const token = bearer(request);
  const session = token ? "" : (cookieOf(request, "omc") ?? "");
  let row: { login: string; name: string | null; avatar_url: string | null; role: string; blocked_at: string | null; blocked_reason: string | null } | null = null;
  if (token.startsWith("omc_")) {
    row = await env.DB.prepare("SELECT login, name, avatar_url, role, blocked_at, blocked_reason FROM contributors WHERE token_hash = ?").bind(await sha256Hex(token)).first();
  } else if (session.startsWith("oms_")) {
    row = await env.DB.prepare("SELECT login, name, avatar_url, role, blocked_at, blocked_reason FROM contributors WHERE session_hash = ?").bind(await sha256Hex(session)).first();
  }
  if (!row) return null;
  await env.DB.prepare("UPDATE contributors SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE login = ?").bind(row.login).run();
  return { login: row.login, name: row.name, avatar_url: row.avatar_url, role: row.role, blocked: row.blocked_at ? { at: row.blocked_at, reason: row.blocked_reason } : null };
}

// ---------- what a person may do on a person's page ----------

/** The two reasons every door shares, here and on a build's decisions (routes/review.ts): nobody signed in, or somebody who is not a maintainer. */
export const SIGN_IN = "sign in with GitHub";
export const MAINTAINER_DECIDES = "a maintainer decides";

/** The acts on a person's page (pages/user.ts), each a control drawn for every viewer and grey with its reason where the viewer may not press it. Share is not here: the page is public and its link is anyone's to copy — no door, no gate. */
export type Right = "request" | "register" | "token" | "build" | "dequeue" | "remove" | "revoke" | "withdraw" | "own_only" | "share_worker";
export const RIGHTS: Right[] = ["request", "register", "token", "build", "dequeue", "remove", "revoke", "withdraw", "own_only", "share_worker"];

/** An act allowed, or refused with the status the door answers and the reason a person reads in the control's title. */
export type Verdict = { ok: true } | { ok: false; status: 401 | 403 | 404 | 409; why: string };

/** A registration as Remove reads it: whose, where it stands, the rings that serve it, the project's build of it in flight. */
export interface Registration { name: string; owner: string; status: string; served: string[]; reviewing: { id: number; status: string } | null }

/** A worker as its row's buttons read it: whose, of what kind (community: its owner's or shared; project, review: the pool's), and whether it is revoked. */
export interface WorkerRow { id: string; owner: string | null; trust: string; revoked_at: string | null }

/** The three acts on a worker's row. */
export type WorkerRight = "revoke" | "own_only" | "share_worker";
const WORKER_RIGHTS: WorkerRight[] = ["revoke", "own_only", "share_worker"];

/** What the pages read: true where the caller may, else the reason in `why`; `packages` says the same for Remove on each registration, by name, and `workers` for the three acts on each worker, by id. */
export interface Rights extends Record<Right, boolean> {
  why: Partial<Record<Right, string>>;
  packages: Record<string, { remove: boolean; why?: string }>;
  workers: Record<string, Record<WorkerRight, boolean> & { why: Partial<Record<WorkerRight, string>> }>;
}

/** What a worker's own state refuses before whose it is: a revoked one is gone (404, the word the door has always said the second time), a project's or review's worker has no mode to set (409) — the pool's work is not shared or kept. */
const revokedAlready = (w: WorkerRow): Verdict | null => (w.revoked_at ? { ok: false, status: 404, why: `${w.id} is revoked already` } : null);
const noMode = (w: WorkerRow): Verdict | null => (w.trust !== "community" ? { ok: false, status: 409, why: "a project worker takes the project's work; it has no shared or own mode" } : null);

/**
 * What a person may do on a person's page, decided in one place. The page
 * draws the same controls for every viewer — Request, Register, Token,
 * Share, Build and Remove on a registration, Revoke and the mode on a
 * worker, Withdraw on an approval — and greys the ones this viewer may not
 * press with the reason in the title (the dashboard's rule: nothing hidden,
 * nothing absent). The reason must be the one the door would answer, so
 * this predicate is what the handlers below refuse with and what
 * GET /users/:login/can carries as `can` for whoever asks: computed once,
 * read twice, no drift. The order of the reasons is the order a reader
 * wants them: sign in first, then whose page and what role (the difference
 * on the dashboard), then a block, then the registration's state — except
 * on a worker's row, where the state (revoked; a project's, with no mode)
 * is the same grey for every role and so comes before whose it is.
 *
 * Whose acts these are: request, register and token are the owner's alone
 * — the doors behind them act on the caller's own account (POST
 * /factory/token mints the caller's token, whoever's page the button is
 * on), so the page offers them on nobody else's page, and the reason a
 * signed-in reader gets names where their own control is: their page.
 * Build and the queue are the owner's: the project's builds are a
 * maintainer's to start from Review, never a contributor's registration to
 * build. Remove is the owner's while the registration is theirs to free —
 * not approved or published, not in a ring, not under the project's
 * review — and a maintainer's always. Revoke and "own only" are the
 * owner's or any maintainer's; sharing a worker is the owner's word alone.
 * Withdraw is a maintainer's: the role rides here, and whether a row has
 * an approval standing to withdraw is the row's own fact (`withdrawn_at`,
 * `rings` on GET /users/:login, which is cached for everyone) — the page
 * greys the button by the role from this answer and draws it where the
 * row says an approval stands; the POST decides on the task with
 * decisions() in routes/review.ts, which reads the same two words for the
 * same two reasons.
 *
 * What differs by registration — Remove — comes back per name in
 * `packages`, from the registrations given (registrationsOf); `remove`
 * itself is the role's answer, the one the page reads where no
 * registration is named. What differs by worker — a revoked one, a
 * project's with no mode to set — comes back per id in `workers`, the
 * state's word before the role's, as the row greys it; the doors behind
 * Revoke and the mode refuse with the same verdict.
 */
export function workspace(c: Contributor | null, login: string, registrations: Registration[] = [], workers: WorkerRow[] = []): Record<Right, Verdict> & { packages: Record<string, Verdict>; workers: Record<string, Record<WorkerRight, Verdict>> } {
  const allow: Verdict = { ok: true };
  const no = (status: 401 | 403 | 404 | 409, why: string): Verdict => ({ ok: false, status, why });
  const person = !c ? no(401, SIGN_IN) : null;
  const owner = !!c && c.login === login;
  const maintainer = !!c && isMaintainer(c);
  const blocked = c?.blocked ? no(403, `${c.login} is blocked by a maintainer${c.blocked.reason ? ": " + c.blocked.reason : ""}; nothing can be requested or built until another maintainer lifts it`) : null;
  // A name where the record has none (an ownerless row): the sentence still reads.
  const whose = login || "its owner";
  // The owner's alone, and the reader is told where theirs is — the same control on their own page.
  const onlyOwner = (does: string, status: 403 | 404 = 403) => person ?? (owner ? null : no(status, `only ${whose} ${does} — yours is on /user/${c!.login}`));
  const ownerOrMaintainer = (does: string, status: 403 | 404 = 403) => person ?? (owner || maintainer ? null : no(status, `only ${whose} or a maintainer ${does}`));
  const packages: Record<string, Verdict> = {};
  for (const r of registrations) {
    const theirs = !!c && c.login === r.owner;
    packages[r.name] =
      person
        ?? (!theirs && !maintainer ? no(403, `only ${r.owner} removes it, or a maintainer`) : null)
        ?? (!maintainer && landed(r.status) ? no(403, `${r.name} is ${r.status}: a maintainer removes it`) : null)
        ?? (!maintainer && r.served.length ? no(409, `${r.name} is in ${r.served.join(", ")}: a maintainer withdraws the approval or blocks it first — the registration cannot leave a package behind in a ring`) : null)
        // The project's build of it — queued, running, or staged for a decision — is a maintainer's review in progress: the owner waits for it.
        ?? (!maintainer && r.reviewing ? no(409, `${r.name} is under review: the project's build #${r.reviewing.id} is ${r.reviewing.status} — a maintainer decides first`) : null)
        ?? allow;
  }
  const revoke = ownerOrMaintainer("revokes a worker here", 404) ?? allow;
  const ownOnly = ownerOrMaintainer("sets where it builds") ?? allow;
  // Sharing is the owner's word alone (governance): a maintainer may take a worker out of the queue, never put someone's machine in it.
  const shareWorker = person ?? (owner ? null : no(403, "sharing is the owner's word alone: a maintainer can set a worker to its owner's packages, not share it")) ?? allow;
  const byWorker: Record<string, Record<WorkerRight, Verdict>> = {};
  for (const w of workers) {
    // The row's own state first — the same grey for every role — then whose it is.
    const gone = person ?? revokedAlready(w);
    byWorker[w.id] = { revoke: gone ?? revoke, own_only: gone ?? noMode(w) ?? ownOnly, share_worker: gone ?? noMode(w) ?? shareWorker };
  }
  return {
    request: onlyOwner("requests here") ?? blocked ?? allow,
    register: onlyOwner("registers a worker here") ?? blocked ?? allow,
    token: onlyOwner("mints their token") ?? allow,
    // A registration is built by the one who brought it: for anyone else the name is not theirs to build (404, as a name not registered).
    build: onlyOwner("builds here", 404) ?? blocked ?? allow,
    dequeue: onlyOwner("takes their build out of the queue") ?? allow,
    remove: ownerOrMaintainer("removes a registration here") ?? allow,
    revoke,
    withdraw: person ?? (maintainer ? null : no(403, MAINTAINER_DECIDES)) ?? allow,
    own_only: ownOnly,
    share_worker: shareWorker,
    packages,
    workers: byWorker,
  };
}

/** The verdicts as a page reads them. */
export function rights(v: ReturnType<typeof workspace>): Rights {
  const out = { why: {}, packages: {}, workers: {} } as Rights;
  for (const r of RIGHTS) {
    out[r] = v[r].ok;
    if (!v[r].ok) out.why[r] = v[r].why;
  }
  for (const [name, x] of Object.entries(v.packages)) out.packages[name] = x.ok ? { remove: true } : { remove: false, why: x.why };
  for (const [id, x] of Object.entries(v.workers)) {
    const row = { why: {} } as Rights["workers"][string];
    for (const r of WORKER_RIGHTS) {
      row[r] = x[r].ok;
      if (!x[r].ok) row.why[r] = x[r].why;
    }
    out.workers[id] = row;
  }
  return out;
}

/** A person's workers as the row's verdicts read them — revoked ones included, since their rows are drawn too. */
export async function workersOf(env: Env, owner: string): Promise<WorkerRow[]> {
  return (await env.DB.prepare("SELECT id, owner, trust, revoked_at FROM build_workers WHERE owner = ? ORDER BY id").bind(owner).all<WorkerRow>()).results;
}

/** The refusal a door answers: the reason, with its status. */
export function refused(v: Verdict): Response | null {
  return v.ok ? null : json({ error: v.why }, v.status);
}

/**
 * The registrations Remove decides on — a person's, or one by name — with
 * what the decision needs: the rings that serve the package (never out
 * from under a ring) and the project's build of it in flight (a
 * maintainer's review in progress).
 */
export async function registrationsOf(env: Env, by: { owner: string } | { name: string }): Promise<Registration[]> {
  const rows = (await ("owner" in by
    ? env.DB.prepare("SELECT name, owner, status FROM factory_packages WHERE owner = ? ORDER BY name").bind(by.owner)
    : env.DB.prepare("SELECT name, owner, status FROM factory_packages WHERE name = ?").bind(by.name)
  ).all<{ name: string; owner: string; status: string }>()).results;
  if (!rows.length) return [];
  const names = JSON.stringify(rows.map((r) => r.name));
  const [served, reviewing] = await Promise.all([
    env.DB.prepare(`SELECT DISTINCT p.name, rp.ring FROM ring_packages rp JOIN packages p ON p.id = rp.package_id WHERE p.name IN (SELECT value FROM json_each(?)) AND p.source = 'factory' AND rp.ring IN (${ringsSql(RINGS)})`).bind(names).all<{ name: string; ring: string }>(),
    env.DB.prepare("SELECT name, id, status FROM build_tasks WHERE name IN (SELECT value FROM json_each(?)) AND kind = 'build' AND trust = 'project' AND status IN ('queued', 'leased', 'staged') ORDER BY id DESC").bind(names).all<{ name: string; id: number; status: string }>(),
  ]);
  return rows.map((r) => ({
    ...r,
    served: sortRings(served.results.filter((s) => s.name === r.name).map((s) => s.ring)),
    reviewing: reviewing.results.find((t) => t.name === r.name) ?? null,
  }));
}

export interface WorkerIdentity {
  id: string;
  owner: string | null;
  mode: string;
  /** Who set the mode: NULL — the worker's own flag applies at each claim; a login — from the page; 'worker' — through its own token (the command line). */
  mode_by?: string | null;
  packages: string[];
  arch: string;
  /** community: its own or shared builds · project: everything, approved by a maintainer. */
  trust: string;
  /** Set when the caller is a job token rather than a registered worker: the job's kind. */
  job?: string;
}

/** The registered worker behind a `omw_…` token (not revoked), or null. */
export async function workerOf(request: Request, env: Env): Promise<WorkerIdentity | null> {
  const token = bearer(request);
  if (!token.startsWith("omw_")) return null;
  const row = await env.DB.prepare("SELECT id, owner, mode, mode_by, packages, arch, trust FROM build_workers WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await sha256Hex(token))
    .first<{ id: string; owner: string | null; mode: string; mode_by: string | null; packages: string | null; arch: string; trust: string }>();
  return row ? { ...row, packages: row.packages ? JSON.parse(row.packages) : [] } : null;
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  const b = await readJson<{ github_token?: string }>(request);
  if (b instanceof Response) return b;
  if (!b.github_token) return json({ error: "github_token is required (used once, to read your login; a fine-grained token with no permissions is enough)" }, 400);
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${b.github_token}`, accept: "application/vnd.github+json", "user-agent": "omarchy-pool-factory" },
  });
  if (!res.ok) return json({ error: `GitHub did not accept that token (HTTP ${res.status})` }, 401);
  const u = (await res.json()) as { login: string; name?: string; avatar_url?: string; type?: string };
  if (!u.login || u.type === "Bot") return json({ error: "a user account is required" }, 400);
  const token = newToken("omc");
  const role = await roleFor(env, u.login);
  await env.DB.prepare(
    `INSERT INTO contributors (login, name, avatar_url, token_hash, role) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (login) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url, token_hash = excluded.token_hash,
       role = excluded.role, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(u.login, u.name ?? null, u.avatar_url ?? null, await sha256Hex(token), role)
    .run();
  return json({ login: u.login, role, token, note: "Keep this token; registering again replaces it. Use it as `Authorization: Bearer …` for /factory/packages and /factory/workers." }, 201);
}

/** A signed-in contributor mints (or replaces) the CLI / worker token; the browser session stays. */
export async function handleNewToken(c: Contributor, env: Env): Promise<Response> {
  // The caller's own token, on their own page: the predicate says so, and would say why not.
  const no = refused(workspace(c, c.login).token);
  if (no) return no;
  const token = newToken("omc");
  await env.DB.prepare("UPDATE contributors SET token_hash = ? WHERE login = ?").bind(await sha256Hex(token), c.login).run();
  return json({ login: c.login, token, note: "Shown once; it replaces any earlier token. Use it as `Authorization: Bearer …` on the command line and for workers." }, 201);
}

export async function handleMe(c: Contributor, env: Env): Promise<Response> {
  const packages = await env.DB.prepare("SELECT * FROM factory_packages WHERE owner = ? ORDER BY name").bind(c.login).all();
  const workers = await env.DB.prepare("SELECT id, arch, mode, packages, labels, agent, last_seen, current_task, builds_done, builds_failed, revoked_at FROM build_workers WHERE owner = ? ORDER BY last_seen DESC").bind(c.login).all();
  const tasks = await env.DB.prepare("SELECT id, name, arch, version, status, attempts, lease_owner, duration_ms, error, staged_prefix, created_at FROM build_tasks WHERE owner = ? ORDER BY id DESC LIMIT 50").bind(c.login).all();
  const staged = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM staging_objects WHERE owner = ?").bind(c.login).first<{ bytes: number }>();
  return json({ contributor: c, packages: packages.results, workers: workers.results.map((w) => ({ ...w, packages: w.packages ? JSON.parse(w.packages as string) : null, labels: w.labels ? JSON.parse(w.labels as string) : null })), tasks: tasks.results, staging: { bytes: staged?.bytes ?? 0, quota_bytes: STAGING_QUOTA_BYTES } });
}

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** What the drafter needs to know, from the GitHub API: build system, license, latest release. */
async function detect(url: string, env: Env): Promise<Record<string, unknown>> {
  const m = url.match(GITHUB_URL);
  if (!m) return { error: "not a GitHub repository URL" };
  const [, owner, repo] = m;
  const h: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "omarchy-pool-factory" };
  // The scheduler's token raises the rate limit; public data either way.
  if (env.GITHUB_TOKEN) h.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const gh = async (path: string): Promise<Record<string, unknown> | null> => {
    const res = await fetch(`https://api.github.com${path}`, { headers: h });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  try {
    const meta = await gh(`/repos/${owner}/${repo}`);
    if (!meta) return { error: `${owner}/${repo} not found on GitHub` };
    const rel = (await gh(`/repos/${owner}/${repo}/releases/latest`)) as { tag_name?: string; assets?: { name: string }[] } | null;
    let tag = rel?.tag_name ?? null;
    if (!tag) {
      const tags = (await gh(`/repos/${owner}/${repo}/tags?per_page=1`)) as unknown as { name: string }[] | null;
      tag = tags?.[0]?.name ?? null;
    }
    const ref = tag ?? (meta.default_branch as string);
    const tree = (await gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`)) as { tree?: { path: string; type: string }[] } | null;
    const top = new Set((tree?.tree ?? []).filter((t) => t.type === "blob").map((t) => t.path));
    const assets = rel?.assets ?? [];
    const system = top.has("Cargo.toml") ? "rust" : top.has("go.mod") ? "go" : top.has("meson.build") ? "meson" : top.has("CMakeLists.txt") ? "cmake" : top.has("configure.ac") ? "autotools" : top.has("pyproject.toml") || top.has("setup.py") ? "python" : top.has("package.json") ? "node" : top.has("Makefile") ? "make" : assets.some((a) => /linux/i.test(a.name)) ? "binary" : "unknown";
    return {
      full_name: meta.full_name, description: meta.description ?? null, language: meta.language ?? null,
      license: (meta.license as { spdx_id?: string } | null)?.spdx_id ?? null, latest_tag: tag,
      release_assets: assets.map((a) => a.name), build_system: system, has_pkgbuild: top.has("PKGBUILD"),
      default_branch: meta.default_branch, stars: meta.stargazers_count ?? 0, archived: meta.archived ?? false,
    };
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e) };
  }
}

/**
 * The request's URL, in the forms a contributor pastes: a GitHub repository
 * (the tag is the latest release, found by detect()), a GitHub release
 * tarball or release page (the tag is in the URL), or — for a project that
 * is not on GitHub, a vendor's binary release — its home page, with the
 * source and version given separately. The project's home, normalised, is
 * what makes a package unique in the pool.
 */
export function parseProjectUrl(raw: string): { project: string; github: { owner: string; repo: string } | null; tag: string | null; source: string | null } | { error: string } {
  const u = raw.trim();
  if (!/^https:\/\/[^\s]+$/.test(u)) return { error: "url must be https" };
  let m = u.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/archive\/refs\/tags\/([^/\s]+?)\.(?:tar\.gz|zip)$/);
  if (m) return { project: `https://github.com/${m[1]}/${m[2]}`, github: { owner: m[1], repo: m[2] }, tag: decodeURIComponent(m[3]), source: u };
  m = u.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/releases\/tag\/([^/\s]+)\/?$/);
  if (m) return { project: `https://github.com/${m[1]}/${m[2]}`, github: { owner: m[1], repo: m[2] }, tag: decodeURIComponent(m[3]), source: null };
  m = u.match(GITHUB_URL);
  if (m) return { project: `https://github.com/${m[1]}/${m[2]}`, github: { owner: m[1], repo: m[2] }, tag: null, source: null };
  if (/^https:\/\/github\.com\//.test(u)) return { error: "a GitHub URL must be the repository, a release page or a release tarball" };
  try {
    const p = new URL(u);
    return { project: `${p.protocol}//${p.host.toLowerCase()}${p.pathname.replace(/\/+$/, "")}`, github: null, tag: null, source: null };
  } catch {
    return { error: "url is not a URL" };
  }
}

export { CHECKLIST } from "../request";

/** Does the source answer? GitHub tarballs redirect to codeload; a HEAD that lands on 200 is enough. */
async function sourceAnswers(source: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher(source, { method: "HEAD", redirect: "follow", headers: { "user-agent": "omarchy-pool-factory" } });
    if (res.ok) return null;
    if (res.status === 405 || res.status === 403) {
      const get = await fetcher(source, { method: "GET", redirect: "follow", headers: { "user-agent": "omarchy-pool-factory", range: "bytes=0-0" } });
      return get.ok ? null : `HTTP ${get.status}`;
    }
    return `HTTP ${res.status}`;
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
}

/**
 * The package request. Everything is checked before anything is written:
 * the contributor is not blocked, the URL is a project's own, the source of
 * the version answers, the name and the project are not in the pool
 * already (a request of your own can be renewed; somebody else's is
 * theirs), no upstream the pool mirrors ships the name, and the checklist
 * is complete. Then the record: request.json in the pool bucket, signed,
 * written once; the registration points at it and the build can start.
 */
export async function handleRequestPackage(c: Contributor, request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  // A request is the caller's own (a blocked one is refused here, in the words the page greys the button with).
  const no = refused(workspace(c, c.login).request);
  if (no) return no;
  const b = (await request.json().catch(() => ({}))) as { name?: string; url?: string; source?: string; version?: string; description?: string; license?: string; arches?: unknown; checklist?: Record<string, unknown> };
  if (!b.url) return json({ error: "url is required: the project's GitHub repository, a release tarball, or the project's home page" }, 400);
  const parsed = parseProjectUrl(b.url);
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  const missing = Object.keys(CHECKLIST).filter((k) => b.checklist?.[k] !== true);
  if (missing.length) return json({ error: `confirm the checklist: ${missing.map((k) => CHECKLIST[k]).join("; ")}`, checklist: CHECKLIST }, 400);
  const description = (b.description ?? "").trim().replace(/\s+/g, " ");
  if (description.length < 8 || description.length > 120) return json({ error: "description: one line, 8 to 120 characters — what pacman shows as pkgdesc" }, 400);
  const license = (b.license ?? "").trim();
  if (!LICENSE.test(license)) return json({ error: "license must be an SPDX identifier (MIT, GPL-3.0-or-later, Apache-2.0 …) or custom:<name>" }, 400);
  const name = (b.name ?? parsed.github?.repo ?? parsed.project.split("/").pop() ?? "").toLowerCase();
  if (!/^[a-z0-9@._+-]+$/.test(name) || name.length > 100) return json({ error: "name must be a pacman package name (lowercase letters, digits, @ . _ + -)" }, 400);
  const arches = (Array.isArray(b.arches) ? b.arches : [...REPO_ARCHES]).filter((a): a is string => typeof a === "string" && isRepoArch(a));
  if (!arches.length) return json({ error: "arches must include x86_64 and/or aarch64" }, 400);

  // The same project, or the same source, requested before by someone a maintainer blocked: a new account
  // does not open the door again (docs/GOVERNANCE.md, *Blocking*).
  const tainted = await env.DB.prepare(
    `SELECT r.owner, r.name FROM package_requests r JOIN contributors k ON k.login = r.owner
      WHERE k.blocked_at IS NOT NULL AND (r.project = ?1 OR (?2 != '' AND r.source = ?2)) AND r.owner != ?3 LIMIT 1`,
  ).bind(parsed.project, (parsed.source ?? (b.source ?? "").trim()), c.login).first<{ owner: string; name: string }>();
  if (tainted) return json({ error: `${parsed.project} was requested by ${tainted.owner}, who is blocked; a maintainer must lift that first` }, 403);
  // Who has this name, who has this project.
  const byName = await env.DB.prepare("SELECT owner, status, project, release, blocked_at, blocked_reason FROM factory_packages WHERE name = ?").bind(name).first<{ owner: string; status: string; project: string | null; release: string | null; blocked_at: string | null; blocked_reason: string | null }>();
  if (byName?.blocked_at) return json({ error: `${name} is blocked by a maintainer: ${byName.blocked_reason ?? ""}`.trim() }, 403);
  // An unmaintained name (thirty days without a build) is anyone's to take over: the registration becomes theirs, the package stays served until their build is decided.
  if (byName && byName.owner !== c.login && byName.status !== "unmaintained") return json({ error: `${name} is ${byName.status}, requested by ${byName.owner}` }, 409);
  const takeover = byName && byName.owner !== c.login ? byName.owner : null;
  const byProject = await env.DB.prepare("SELECT name, owner, status, blocked_at, blocked_reason FROM factory_packages WHERE project = ? AND name != ?").bind(parsed.project, name).first<{ name: string; owner: string; status: string; blocked_at: string | null; blocked_reason: string | null }>();
  if (byProject?.blocked_at) return json({ error: `${parsed.project} is blocked by a maintainer as ${byProject.name}: ${byProject.blocked_reason ?? ""}`.trim() }, 403);
  if (byProject) return json({ error: `${parsed.project} is already in the pool as ${byProject.name} (${byProject.status}, requested by ${byProject.owner})` }, 409);
  if (byName && !["registered", "waiting", "rejected", "unmaintained", "staged"].includes(byName.status)) return json({ error: `${name} is ${byName.status}; a request can be renewed while it is registered, waiting, staged, rejected or unmaintained — not while it is being built, and not once it is in the pool` }, 409);
  // A package in the pool passes through 'waiting' and 'staged' with every bump: the standing approval, not the status, says it is in the pool — its record stays as it was, new releases come as bumps.
  const inPool = byName ? await env.DB.prepare(`SELECT id FROM approvals WHERE name = ? AND ${standsSql()} LIMIT 1`).bind(name).first<{ id: number }>() : null;
  if (inPool) return json({ error: `${name} is in the pool (approval #${inPool.id}); its record stays as it was — new releases come as bumps, built from the approved recipe` }, 409);
  // The package's status is one word for every architecture and every kind of build: the builds themselves say whether one runs (the project's included).
  const running = byName ? await env.DB.prepare("SELECT id, status, trust FROM build_tasks WHERE name = ? AND kind = 'build' AND status = 'leased' ORDER BY id DESC LIMIT 1").bind(name).first<{ id: number; status: string; trust: string }>() : null;
  if (running) return json({ error: `${name} is being built (task ${running.id}${running.trust === "project" ? ", the project's" : ""}); renew the request once it is done` }, 409);
  const upstream = (await providedBy(env, name)).filter((p) => !["factory", "chaotic"].includes(p.source) && arches.includes(p.arch));
  if (upstream.length === arches.length) {
    return json({ error: `${upstream[0].source} already ships ${name} (${upstream.map((u) => `${u.version} for ${u.arch}`).join(", ")}); install it from the pool`, provided: upstream }, 409);
  }
  const build = arches.filter((a) => !upstream.some((u) => u.arch === a));

  // The version and its source: from GitHub when the project is there, from the request otherwise.
  let detected: Record<string, unknown> = {};
  let tag = parsed.tag ?? (b.version ?? "").trim() ?? "";
  let source = parsed.source ?? (b.source ?? "").trim();
  if (parsed.github) {
    detected = await detect(parsed.project, env);
    if (detected.error) return json({ error: String(detected.error) }, 400);
    if (!tag) tag = String(detected.latest_tag ?? "");
    if (!tag) return json({ error: `${parsed.project} has no release or tag yet; the factory packages releases` }, 400);
    if (!source) source = `${parsed.project}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
    if (detected.license && String(detected.license) !== "NOASSERTION" && String(detected.license).toLowerCase() !== license.toLowerCase()) {
      return json({ error: `GitHub says ${parsed.project} is ${String(detected.license)}; the request says ${license} — one of them is wrong`, detected_license: detected.license }, 400);
    }
  } else {
    if (!source || !/^https:\/\/[^\s]+$/.test(source) || !sourceHasPath(source)) return json({ error: "source is required for a project that is not on GitHub: the https URL of the release tarball or artifact — a file under the host, not its home page" }, 400);
    if (!tag || !/^[A-Za-z0-9._+~-]{1,64}$/.test(tag)) return json({ error: "version is required for a project that is not on GitHub: the release's version or tag" }, 400);
  }
  // Tests run inside workerd without the network (vitest.config.ts): the source is taken as it is.
  const unanswered = env.SOURCE_CHECK === "off" ? null : await sourceAnswers(source, fetcher);
  if (unanswered) return json({ error: `the source does not answer: ${source} (${unanswered})` }, 400);

  // Everything checked out: a build still waiting in the queue is the old request's — it leaves the queue, and the renewed request queues its own.
  if (byName) await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND kind = 'build' AND trust = 'community' AND status = 'queued'").bind(`superseded: the request was renewed by ${c.login}`, name).run();
  // The record, written once; then the registration that points at it.
  const req = await env.DB.prepare(
    `INSERT INTO package_requests (name, owner, project, source, version, description, license, arches, checklist, detected) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`,
  )
    .bind(name, c.login, parsed.project, source, tag, description, license, JSON.stringify(build), JSON.stringify(Object.fromEntries(Object.keys(CHECKLIST).map((k) => [k, true]))), JSON.stringify(detected))
    .first<{ id: number; created_at: string }>();
  if (!req) return json({ error: "the request could not be recorded" }, 500);
  const key = recordKey(name, req.id, "request.json");
  const record = await putRecord(env, key, {
    schema: "omarchy-pool/package-request/1",
    request: req.id, name, project: parsed.project, source, version: tag, description, license, arches: build,
    requested_by: c.login, requested_at: req.created_at,
    checklist: Object.fromEntries(Object.keys(CHECKLIST).map((k) => [k, { confirmed: true, text: CHECKLIST[k] }])),
    detected, pool: version(env).version,
  });
  await env.DB.prepare("UPDATE package_requests SET record = ?, sha256 = ? WHERE id = ?").bind(record.key, record.sha256, req.id).run();
  const row = await env.DB.prepare(
    `INSERT INTO factory_packages (name, owner, url, arches, release, pkgbuild_path, detected, request_id, project, source, description, license, status, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?)
     ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, url = excluded.url, arches = excluded.arches, release = excluded.release, pkgbuild_path = excluded.pkgbuild_path, detected = excluded.detected,
       request_id = excluded.request_id, project = excluded.project, source = excluded.source, description = excluded.description, license = excluded.license,
       status = ?, detail = excluded.detail, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') RETURNING *`,
  )
    // A renewal keeps a staged package staged: its build stands, the record under it is new.
    .bind(name, c.login, parsed.project, JSON.stringify(build), tag, detected.has_pkgbuild ? "PKGBUILD" : null, JSON.stringify(detected), req.id, parsed.project, source, description, license, byName?.status === "staged" ? `request renewed as #${req.id} (${tag}) by ${c.login}; the staged build stands` : `requested ${tag} by ${c.login}; press Build to build it`, byName?.status === "staged" ? "staged" : "registered")
    .first();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('request', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${name} ${tag} requested by ${c.login} from ${parsed.project} (${license}; ${build.join(", ")}) — record ${req.id}${takeover ? ` — taken over from ${takeover}, who left it unmaintained` : ""}`, JSON.stringify({ request: req.id, name, owner: c.login, project: parsed.project, source, version: tag, license, arches: build, skipped: upstream, record: recordUrl(env, record.key), taken_over_from: takeover }))
    .run();
  // The build starts by itself: into the shared queue, the best idle shared worker first, the contributor's own worker at once. A renewal that keeps the version of a staged build keeps that build: nothing to queue.
  const keepsStaged = byName?.status === "staged" && (byName.release ?? "") === tag;
  const queuedNow = keepsStaged ? { tasks: [], building: [], arches: [], pkgbuild_ref: "", pinned_to: null, lessons: {}, hint: null, queue: {} } as Queued : await queueBuilds(env, c, name, {});
  return json({ package: row, request: { id: req.id, record: recordUrl(env, record.key), signature: record.signed ? recordUrl(env, `${record.key}.sig`) : null, sha256: record.sha256 }, skipped: upstream, build: queuedNow instanceof Response ? { error: (await queuedNow.json<{ error: string }>()).error } : queuedNow, next: `queued: the shared workers build it into your staging workspace (a worker of yours takes it at once); follow it on /user/${c.login}` }, byName ? 200 : 201);
}

/**
 * The owner frees the name — never out from under a ring: a package that
 * stands in edge, rc or stable by a standing approval is a maintainer's to
 * withdraw or block first (felix left its registration behind in edge,
 * 2026-09-17). A maintainer frees any name, an unmaintained one included,
 * and a package still served leaves every ring with it — render jobs for
 * the project's workers, a line in the journal.
 */
export async function handleDeletePackage(c: Contributor, name: string, env: Env): Promise<Response> {
  const [pkg] = await registrationsOf(env, { name });
  if (!pkg) return json({ error: "not registered" }, 404);
  // Whose it is to remove, and whether it can leave now: the predicate's answer, the one the page greys the button with.
  const no = refused(workspace(c, pkg.owner, [pkg]).packages[name]);
  if (no) return no;
  const served = pkg.served;
  const rings = served.length ? await pullFromRings(env, name, `registration removed by ${c.login}`) : [];
  // Every build of it stops: the community's builds of the name — queued,
  // running, or staged and waiting for a maintainer; a maintainer's removal
  // takes the project's builds and publish jobs too — so nothing re-enters a
  // ring behind no registration. A staged build that outlived its
  // registration stayed on Review as "waiting for a maintainer" and on the
  // Pipeline as a build in the queue (felix #447, 2026-09-17). The audits
  // and trials queued for them go with them, and their packages leave
  // staging now; what a finished build had put on the record — the recipe,
  // the log, the reports — stays. A build still running is cut off: its
  // worker's uploads and its report are refused, and it leaves nothing.
  const stopping = (await env.DB.prepare(isMaintainer(c)
    ? "SELECT id, kind FROM build_tasks WHERE name = ? AND kind IN ('build', 'publish') AND status IN ('queued', 'leased', 'staged')"
    : "SELECT id, kind FROM build_tasks WHERE name = ? AND trust = 'community' AND kind = 'build' AND status IN ('queued', 'leased', 'staged')")
    .bind(name).all<{ id: number; kind: string }>()).results;
  const ids = stopping.map((r) => r.id);
  const why = `registration removed by ${c.login}`;
  const went = [`${stopping.filter((r) => r.kind === "build").length} build(s)`, ...(stopping.some((r) => r.kind === "publish") ? [`${stopping.filter((r) => r.kind === "publish").length} publish job(s)`] : [])].join(" and ");
  await env.DB.batch([
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ?, lease_expires_at = NULL, finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id IN (SELECT value FROM json_each(?))").bind(why, JSON.stringify(ids)),
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build it audited was cancelled with its registration' WHERE kind = 'audit' AND status = 'queued' AND json_extract(params, '$.task') IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)),
    env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build it tried was cancelled with its registration' WHERE kind = 'trial' AND status = 'queued' AND json_extract(params, '$.task') IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)),
    env.DB.prepare("DELETE FROM factory_packages WHERE name = ?").bind(name),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('request', NULL, 'factory', 'warn', ?, ?)")
      .bind(`${name}: ${why}${ids.length ? ` — ${went} cancelled` : ""}${rings.length ? ` — it leaves ${rings.map((r) => r.ring).join(", ")} (render jobs queued)` : ""}`, JSON.stringify({ name, by: c.login, owner: pkg.owner, rings, cancelled: ids })),
  ]);
  // The registration is gone and the builds are cancelled whatever the
  // bucket says now: a package the reclaim could not drop is the weekly
  // sweep's (cancelled builds are on its list), not a reason to answer 500.
  try {
    await reclaimStagingPackages(env, ids);
  } catch (e) {
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary) VALUES ('request', NULL, 'factory', 'warn', ?)")
      .bind(`${name}: the packages of its cancelled builds stay in staging until the sweep — ${String(e).slice(0, 200)}`).run();
  }
  return json({ deleted: name, by: c.login, rings, cancelled: ids });
}

/**
 * Which workers may build for a contributor, per architecture (the claim's
 * rule, read the other way round): their own, and the ones anyone shares —
 * never the project's, which take the project's builds only.
 */
export async function buildersFor(env: Env, login: string, arch: string): Promise<{ id: string; owner: string | null; mode: string | null; arch: string }[]> {
  const rows = await env.DB.prepare(
    "SELECT id, owner, mode, arch FROM build_workers WHERE revoked_at IS NULL AND trust = 'community' AND arch = ? AND (owner = ? OR mode = 'shared')",
  ).bind(arch, login).all<{ id: string; owner: string | null; mode: string | null; arch: string }>();
  return rows.results;
}

export interface QueueAsk { arches?: string[]; worker?: string | null; hint?: string | null; reason?: string; release?: string }
export interface Queued { tasks: number[]; building: { task: number; arch: string; on: string | null }[]; arches: string[]; pkgbuild_ref: string; pinned_to: string | null; lessons: Record<string, number>; hint: string | null; queue: Record<string, { position: number; total: number }> }

/**
 * Queue community builds of a registered package — the request does it the
 * moment the record is written, the Build button does it again. Results go
 * to staging, never to the pool. A build lands in the shared queue: any
 * shared worker of the architecture may take it, the best idle one first
 * (handleClaim), the owner's own worker always; `worker` names one of
 * theirs (or one anyone shares) and the build waits for that worker only.
 * A build that follows an ended one carries it as the lesson
 * (`params.lesson`): the drafter starts from that PKGBUILD and what stopped
 * it; `hint` is the asker's own word to the agent. Asked again while it
 * waits, the build takes the choice made now.
 */
export async function queueBuilds(env: Env, c: Contributor, name: string, ask: QueueAsk): Promise<Queued | Response> {
  const pkg = await env.DB.prepare("SELECT * FROM factory_packages WHERE name = ?").bind(name).first<{ name: string; owner: string; arches: string; url: string; release: string | null; pkgbuild_path: string | null; detected: string | null; blocked_at: string | null; blocked_reason: string | null }>();
  if (!pkg) return json({ error: "request the package first (POST /factory/packages)" }, 404);
  // A blocked package builds for nobody — the state's word first, as the page greys the button — then the owner builds, nobody else (a blocked owner neither): the predicate's word.
  if (pkg.blocked_at) return json({ error: `${name} is blocked by a maintainer${pkg.blocked_reason ? ": " + pkg.blocked_reason : ""}` }, 403);
  const no = refused(workspace(c, pkg.owner).build);
  if (no) return no;
  const registered = JSON.parse(pkg.arches) as string[];
  const wanted = Array.isArray(ask.arches) && ask.arches.length ? ask.arches : registered;
  const arches = wanted.filter((a) => isRepoArch(a) && registered.includes(a));
  if (!arches.length) return json({ error: `arches must name one the request has: ${registered.join(", ")}` }, 400);
  const hint = typeof ask.hint === "string" && ask.hint.trim() ? ask.hint.trim().slice(0, 600) : null;
  // Where it runs: the shared queue, or one worker.
  const where = typeof ask.worker === "string" && ask.worker.trim() && ask.worker.trim() !== "shared" && ask.worker.trim() !== "queue" ? ask.worker.trim() : null;
  let pinned: string | null = null;
  if (where) {
    if (arches.length !== 1) return json({ error: "a worker builds one architecture: ask for that architecture alone" }, 400);
    const ok = (await buildersFor(env, c.login, arches[0])).find((w) => w.id === where);
    if (!ok) return json({ error: `${where} is not a worker of yours for ${arches[0]}, nor one anyone shares` }, 403);
    pinned = ok.id;
  }
  const detected = pkg.detected ? (JSON.parse(pkg.detected) as { latest_tag?: string }) : {};
  const tag = ask.release ?? pkg.release ?? detected.latest_tag ?? null;
  const ref = pkg.pkgbuild_path ? `${pkg.url}@${tag ?? "HEAD"}:${pkg.pkgbuild_path}` : `draft:${pkg.url}@${tag ?? "latest"}`;
  const version = tag ? tag.replace(/^v/, "").replace(/-/g, "_") : null;
  const ids: number[] = [];
  const building: { task: number; arch: string; on: string | null }[] = [];
  const lessons: Record<string, number> = {};
  for (const arch of arches) {
    // The last build of this architecture that ended — failed, rejected (cancelled), or staged and stopped by the gate or the audit — is the lesson the drafter starts from: its PKGBUILD, its log, the gate's, the audit's.
    const last = await env.DB.prepare("SELECT id, status FROM build_tasks WHERE name = ? AND arch = ? AND kind = 'build' AND trust = 'community' AND status NOT IN ('queued', 'leased') AND pkgbuild_ref LIKE 'draft:%' ORDER BY id DESC LIMIT 1").bind(name, arch).first<{ id: number; status: string }>();
    const params: Record<string, unknown> = {};
    if (last && ref.startsWith("draft:")) { params.lesson = last.id; lessons[arch] = last.id; }
    if (hint) params.hint = hint;
    const dup = await env.DB.prepare("SELECT id, status, lease_owner, params FROM build_tasks WHERE name = ? AND arch = ? AND pkgbuild_ref = ? AND status IN ('queued', 'leased') LIMIT 1").bind(name, arch, ref).first<{ id: number; status: string; lease_owner: string | null; params: string | null }>();
    if (dup) {
      if (dup.status === "queued") {
        // Asked again while it waits: where it goes, the hint and the lesson are what was asked now — the queue when nothing was named.
        // A build sent back for a native worker (needs_native) still waits for one there; a worker named is the asker's own choice.
        if (!pinned && dup.params && (JSON.parse(dup.params) as { needs_native?: number }).needs_native === 1) params.needs_native = 1;
        await env.DB.prepare("UPDATE build_tasks SET pinned_to = ?, shared_after = NULL, params = ? WHERE id = ? AND status = 'queued'")
          .bind(pinned, Object.keys(params).length ? JSON.stringify(params) : null, dup.id).run();
        ids.push(dup.id);
      } else {
        building.push({ task: dup.id, arch, on: dup.lease_owner });
      }
      continue;
    }
    // The quota counts what is inserted, not what is asked again.
    const queued = await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE owner = ? AND status IN ('queued', 'leased')").bind(c.login).first<{ n: number }>();
    if ((queued?.n ?? 0) >= QUEUED_QUOTA) return json({ error: `you have ${queued?.n} tasks queued or building; the limit is ${QUEUED_QUOTA}` }, 429);
    const row = await env.DB.prepare(
      `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, shared_after, pinned_to, params) VALUES (?, ?, ?, ?, ?, 100, 0, 'community', ?, NULL, ?, ?) RETURNING id`,
    )
      .bind(name, arch, version, ref, ask.reason ?? "contributor", c.login, pinned, Object.keys(params).length ? JSON.stringify(params) : null)
      .first<{ id: number }>();
    if (row) ids.push(row.id);
  }
  const queue: Record<string, { position: number; total: number }> = {};
  for (const id of ids) {
    const t = await env.DB.prepare("SELECT id, arch, priority, shared_after, pinned_to FROM build_tasks WHERE id = ?").bind(id).first<{ id: number; arch: string; priority: number; shared_after: string | null; pinned_to: string | null }>();
    const place = t ? await queuePosition(env, t) : null;
    if (t && place) queue[t.arch] = place;
  }
  const out: Queued = { tasks: ids, building, arches: arches.filter((a) => !building.some((b) => b.arch === a)), pkgbuild_ref: ref, pinned_to: pinned, lessons, hint, queue };
  if (!ids.length) return out;
  await env.DB.prepare("UPDATE factory_packages SET status = 'waiting', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status != 'building'")
    .bind(`in the queue (${out.arches.join(", ")})${pinned ? ` — for ${pinned}` : ""}`, name).run();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('enqueue', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${name}${version ? " " + version : ""}: ${ids.length} community build(s) queued by ${c.login} for ${out.arches.join(", ")}${pinned ? ` on ${pinned}` : " — the shared queue"} — results go to staging`, JSON.stringify({ name, owner: c.login, arches: out.arches, tasks: ids, pkgbuild_ref: ref, pinned_to: pinned, lessons, hint, building, queue }))
    .run();
  return out;
}

/** POST /factory/packages/:name/build — the Build button: the same queue the request used, with the asker's choice of worker and hint. */
export async function handleBuildPackage(c: Contributor, name: string, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { arches?: unknown; reason?: string; release?: string; worker?: unknown; hint?: unknown };
  const out = await queueBuilds(env, c, name, { arches: Array.isArray(b.arches) ? (b.arches as string[]) : undefined, worker: typeof b.worker === "string" ? b.worker : null, hint: typeof b.hint === "string" ? b.hint : null, reason: b.reason, release: b.release });
  if (out instanceof Response) return out;
  if (!out.tasks.length) return json({ ...out, note: `already building: ${out.building.map((x) => `#${x.task} (${x.arch}${x.on ? ` on ${x.on}` : ""})`).join(", ")} — ask again when it ends` }, 200);
  return json({ ...out, note: out.pinned_to ? `${out.pinned_to} builds these; nothing else claims them.` : "In the shared queue: the best idle shared worker takes it, or a worker of yours at once." }, 201);
}

/**
 * DELETE /factory/packages/:name/builds/:id — the owner takes their own
 * queued build out of the queue (a build that runs is not stopped: the
 * worker finishes, the evidence stays). Nothing puts it back by itself:
 * the Build button does, with the asker's choice.
 */
export async function handleDequeueBuild(c: Contributor, name: string, id: number, env: Env): Promise<Response> {
  const t = await env.DB.prepare("SELECT id, name, arch, owner, status, trust FROM build_tasks WHERE id = ?").bind(id).first<{ id: number; name: string; arch: string; owner: string | null; status: string; trust: string }>();
  if (!t || t.name !== name) return json({ error: "no such build of this package" }, 404);
  if (t.trust !== "community") return json({ error: "not your build" }, 403);
  const no = refused(workspace(c, t.owner ?? "its owner").dequeue);
  if (no) return no;
  if (t.status !== "queued") return json({ error: `build #${id} is ${t.status}; only a queued build leaves the queue` }, 409);
  const gone = await env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'queued'").bind(`taken out of the queue by ${c.login}`, id).run();
  if (!gone.meta.changes) return json({ error: `build #${id} was just taken by a worker; it runs — the evidence comes` }, 409);
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE name = ? AND kind = 'build' AND status IN ('queued', 'leased')").bind(name).first<{ n: number }>();
  if (!left?.n) await env.DB.prepare("UPDATE factory_packages SET status = 'registered', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND status = 'waiting'").bind(`out of the queue (${t.arch}) by ${c.login}; press Build to queue it again`, name).run();
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('enqueue', NULL, 'factory', 'ok', ?, ?)")
    .bind(`${name} (${t.arch}): build ${id} taken out of the queue by ${c.login}`, JSON.stringify({ name, task: id, arch: t.arch, by: c.login }))
    .run();
  return json({ task: id, status: "cancelled", by: c.login });
}

export async function handleRegisterWorker(c: Contributor, request: Request, env: Env): Promise<Response> {
  // A worker is registered under the caller's own name (a blocked one is refused here, in the words the page greys the button with).
  const no = refused(workspace(c, c.login).register);
  if (no) return no;
  const b = (await request.json().catch(() => ({}))) as { name?: string; arch?: string; labels?: unknown };
  if (!b.arch || !isRepoArch(b.arch)) return json({ error: "arch (x86_64|aarch64) is required" }, 400);
  // A worker builds its owner's packages. Donating it to anyone's is decided
  // where it runs (--shared / WORKER_SHARED=1), never here, so a registration
  // cannot quietly turn a laptop into everybody's build machine.
  const id = `${c.login}-${(b.name ?? b.arch).replace(/[^a-zA-Z0-9_.-]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
  const token = newToken("omw");
  await env.DB.prepare(
    `INSERT INTO build_workers (id, arch, hostname, labels, owner, token_hash, mode, packages, last_seen) VALUES (?, ?, NULL, ?, ?, ?, 'dedicated', '[]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  )
    .bind(id, b.arch, b.labels ? JSON.stringify(b.labels) : null, c.login, await sha256Hex(token))
    .run();
  return json({ worker: id, token, arch: b.arch, note: "Run the Omarchy Packaging image with WORKER_ID and OMARCHY_WORKER_TOKEN set to these; the token is shown once. It builds your packages; start it with WORKER_SHARED=1 to build anyone's." }, 201);
}

/**
 * The mode of a community worker — shared (everyone's queue) or the
 * owner's packages only — set from the brain: its owner or a maintainer
 * from the page, the worker itself through its token (`omarchy-worker
 * share on|off`). From then on the registration's mode is what the claim
 * uses, whatever the container was started with; it takes effect at the
 * worker's next claim, within the minute, nothing restarts.
 */
export async function handleWorkerMode(by: Contributor | { worker: string }, id: string, request: Request, env: Env): Promise<Response> {
  const b = (await request.json().catch(() => ({}))) as { mode?: string };
  if (b.mode !== "shared" && b.mode !== "dedicated") return json({ error: "mode must be shared or dedicated" }, 400);
  const w = await env.DB.prepare("SELECT id, owner, trust, mode, revoked_at FROM build_workers WHERE id = ?").bind(id).first<WorkerRow & { mode: string }>();
  if (!w) return json({ error: "no such worker" }, 404);
  const who = "worker" in by ? "worker" : by.login;
  if ("worker" in by) {
    if (by.worker !== w.id) return json({ error: "not yours" }, 403);
    const no = refused(revokedAlready(w) ?? noMode(w) ?? { ok: true });
    if (no) return no;
  } else {
    // From the page: the row's verdict — revoked already, a project worker's no mode, then its owner or a maintainer sets it to its owner's packages and sharing is the owner's word alone — the one the page greys the button with.
    const no = refused(workspace(by, w.owner ?? "its owner", [], [w]).workers[w.id][b.mode === "shared" ? "share_worker" : "own_only"]);
    if (no) return no;
  }
  await env.DB.prepare("UPDATE build_workers SET mode = ?, mode_by = ? WHERE id = ?").bind(b.mode, who, id).run();
  return json({ id, mode: b.mode, by: who, note: b.mode === "shared" ? "from its next claim it builds whatever is queued, anyone's" : "from its next claim it builds its owner's packages only" });
}

/** The worker's own log — the lines between tasks, as it sent them with its claims — for its owner and the maintainers. */
export async function handleWorkerLog(c: Contributor, id: string, env: Env): Promise<Response> {
  const w = await env.DB.prepare("SELECT id, owner, log_tail, log_at FROM build_workers WHERE id = ?").bind(id).first<{ id: string; owner: string | null; log_tail: string | null; log_at: string | null }>();
  if (!w) return json({ error: "no such worker" }, 404);
  if (!(isMaintainer(c) || (w.owner !== null && w.owner === c.login))) return json({ error: "the worker's log is its owner's and the maintainers' to read" }, 403);
  return json({ id: w.id, log: w.log_tail ?? "", at: w.log_at }, 200, { "cache-control": "no-store" });
}

export async function handleRevokeWorker(c: Contributor, id: string, env: Env): Promise<Response> {
  // Its owner, or a maintainer (any worker): a revoked worker cannot claim again. The row's verdict — revoked already, then whose it is to revoke — is the predicate's answer, the one the page greys the button with.
  const w = await env.DB.prepare("SELECT id, owner, trust, revoked_at FROM build_workers WHERE id = ?").bind(id).first<WorkerRow>();
  if (!w) return json({ error: "no such worker" }, 404);
  const no = refused(workspace(c, w.owner ?? "its owner", [], [w]).workers[w.id].revoke);
  if (no) return no;
  const res = await env.DB.prepare("UPDATE build_workers SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND revoked_at IS NULL").bind(id).run();
  let freed = 0;
  if (res.meta.changes) {
    // A build asked for this worker would wait for it forever: back to the rule, for the shared workers at once.
    freed = (await env.DB.prepare("UPDATE build_tasks SET pinned_to = NULL, shared_after = NULL WHERE pinned_to = ? AND status = 'queued'").bind(id).run()).meta.changes ?? 0;
    await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('trust', NULL, 'factory', 'warn', ?, ?)")
      .bind(`worker ${id} revoked by ${c.login}${freed ? ` — ${freed} queued build(s) asked for it go to any worker that qualifies` : ""}`, JSON.stringify({ worker: id, by: c.login, freed }))
      .run();
  }
  return res.meta.changes ? json({ revoked: id, freed }) : json({ error: `${id} is revoked already` }, 404);
}

/**
 * A registered package that landed: approved by a maintainer, or published
 * once the project's build of it reached edge (factory.ts moves it from one
 * word to the other). The status words are the server's, so the rule is said
 * here once and every row of GET /factory/packages carries it as `landed` —
 * the Pool's, the Factory's, the Pipeline's and the People page's
 * "community packages" all read the flag, never the words.
 */
export function landed(status: string): boolean {
  return status === "approved" || status === "published";
}

export async function handleListPackages(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM build_tasks t WHERE t.name = p.name AND t.status = 'staged') AS staged_builds
       FROM factory_packages p ORDER BY updated_at DESC LIMIT 200`,
  ).all();
  return json({ packages: rows.results.map((r) => ({ ...r, arches: JSON.parse(r.arches as string), detected: r.detected ? JSON.parse(r.detected as string) : null, landed: landed(r.status as string) })) }, 200, { "cache-control": "public, max-age=30" });
}

// ---------- staging uploads (worker token, own task only) ----------

const SINGLE_PUT_MAX = 90 * 1024 * 1024;
/** Text evidence is read whole before it is stored — to be checked for what a public log must not carry (leak.ts). A log past this is not one anyone reads. */
const TEXT_EVIDENCE_MAX = 32 * 1024 * 1024;

export function stagingKey(owner: string, name: string, task: number, filename: string): string {
  return `staging/${owner}/${name}/${task}/${filename}`;
}

/** A task that stages: a contributor's build (their workspace, their quota) or the project's review build (the project's space, no quota). */
function stagingOwner(task: { trust: string; owner: string | null; params: string | null }): string | null {
  if (task.trust === "community") return task.owner;
  try {
    return task.params && (JSON.parse(task.params) as { review?: unknown }).review !== undefined ? "@project" : null;
  } catch {
    return null;
  }
}

/**
 * PUT /factory/tasks/:id/artifacts/:filename — the worker uploads the
 * package(s), PKGBUILD, build.log and manifest.json of a community task it
 * holds. Scope is the task: the key is derived, never given. Up to 90 MB in
 * one request; larger archives use the multipart routes below.
 */
/** What the audit job may add to a staged build's evidence, and nothing else. */
const AUDIT_FILES = ["audit.json", "audit.md"];
/** What the trial job adds: the transcript of the real pacman that installed the build from the lab. */
const TRIAL_FILES = ["trial.log"];

export async function handleStagingPut(taskId: number, filename: string, request: Request, env: Env, w: WorkerIdentity): Promise<Response> {
  const task = await env.DB.prepare("SELECT id, name, owner, status, lease_owner, trust, params FROM build_tasks WHERE id = ?").bind(taskId).first<{ id: number; name: string; owner: string; status: string; lease_owner: string; trust: string; params: string | null }>();
  if (!task) return json({ error: "no such task" }, 404);
  const space = stagingOwner(task);
  if (!space) return json({ error: "project tasks publish to the pool, not to staging" }, 400);
  if (w.job === "audit" || w.job === "trial") {
    // The second agent's report, or the trial's transcript, next to the
    // evidence: only once the build is staged (its own worker is done),
    // only that job's files.
    const allowed = w.job === "audit" ? AUDIT_FILES : TRIAL_FILES;
    if (task.status !== "staged") return json({ error: `task ${taskId} is ${task.status}; the ${w.job} reports on a staged build` }, 409);
    if (!allowed.includes(filename)) return json({ error: `a ${w.job} uploads ${allowed.join(" and ")}` }, 400);
  } else {
    if (task.status !== "leased" || task.lease_owner !== w.id) return json({ error: "the lease is not yours" }, 409);
    // The builder never writes the report about its own build.
    if (AUDIT_FILES.includes(filename) || TRIAL_FILES.includes(filename)) return json({ error: `${filename} is written by the audit or trial job, not by the build` }, 403);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,200}$/.test(filename)) return json({ error: "bad filename" }, 400);
  const len = Number(request.headers.get("content-length") ?? 0);
  const key = stagingKey(space, task.name, task.id, filename);
  const refused = await quotaRefusal(env, space, len, key);
  if (refused) return refused;
  if (len > SINGLE_PUT_MAX) return json({ error: "above 90 MB use /multipart" }, 413);
  if (!request.body) return json({ error: "empty body" }, 400);
  let body: ReadableStream | string = request.body;
  if (isTextEvidence(filename)) {
    // The log, the recipe, the reports are public the moment they land:
    // nothing that looks like a secret goes in (leak.ts). The refusal says
    // what kind and where, never what.
    if (len > TEXT_EVIDENCE_MAX) return json({ error: `${filename} is above ${TEXT_EVIDENCE_MAX} bytes; text evidence that large is not evidence anyone reads — trim the log` }, 413);
    body = new TextDecoder().decode(await request.arrayBuffer()); // the worker sends octet-stream; the file is text
    const leak = findLeak(body);
    if (leak) {
      await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('leak', NULL, 'factory', 'warn', ?, ?)")
        .bind(`task ${task.id} (${task.name}): ${filename} refused — it carried what looks like ${leak.kind}`, JSON.stringify({ task: task.id, name: task.name, file: filename, kind: leak.kind, line: leak.line, worker: w.id }))
        .run();
      return json({ error: leakMessage(filename, leak), kind: leak.kind, line: leak.line }, 422);
    }
  }
  const obj = await env.STAGING.put(key, body, { httpMetadata: { contentType: isTextEvidence(filename) ? "text/plain; charset=utf-8" : "application/octet-stream" } });
  await env.DB.prepare("INSERT OR REPLACE INTO staging_objects (key, owner, task_id, size) VALUES (?, ?, ?, ?)").bind(key, space, task.id, obj?.size ?? len).run();
  return json({ key, size: obj?.size ?? len }, 201);
}

export async function handleStagingMultipart(taskId: number, filename: string, url: URL, request: Request, env: Env, w: WorkerIdentity): Promise<Response> {
  const task = await env.DB.prepare("SELECT id, name, owner, status, lease_owner, trust, params FROM build_tasks WHERE id = ?").bind(taskId).first<{ id: number; name: string; owner: string; status: string; lease_owner: string; trust: string; params: string | null }>();
  const space = task ? stagingOwner(task) : null;
  if (!task || !space) return json({ error: "no such staging task" }, 404);
  if (task.status !== "leased" || task.lease_owner !== w.id) return json({ error: "the lease is not yours" }, 409);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,200}$/.test(filename) || AUDIT_FILES.includes(filename)) return json({ error: "bad filename" }, 400);
  // Text evidence is checked whole at the single PUT (leak.ts); a multipart upload of it would go around that.
  if (isTextEvidence(filename)) return json({ error: `${filename} is text evidence: one PUT, up to ${TEXT_EVIDENCE_MAX} bytes` }, 400);
  const key = stagingKey(space, task.name, task.id, filename);
  const action = url.searchParams.get("action");
  if (action === "create") {
    // Same cap as a single PUT: do not start an upload that already cannot
    // fit. What this key holds now — a lease that died after the package
    // landed and before the PKGBUILD did — is what the upload replaces, so
    // it does not count against itself.
    const refused = await quotaRefusal(env, space, 1, key);
    if (refused) return refused;
    const mp = await env.STAGING.createMultipartUpload(key);
    return json({ upload_id: mp.uploadId, key }, 201);
  }
  const uploadId = url.searchParams.get("upload_id");
  if (!uploadId) return json({ error: "upload_id is required" }, 400);
  const mp = env.STAGING.resumeMultipartUpload(key, uploadId);
  if (action === "part") {
    const n = Number(url.searchParams.get("part"));
    if (!n || !request.body) return json({ error: "part number and body are required" }, 400);
    const part = await mp.uploadPart(n, request.body);
    return json({ part: part.partNumber, etag: part.etag });
  }
  if (action === "complete") {
    const b = await readJson<{ parts: { partNumber: number; etag: string }[] }>(request);
    if (b instanceof Response) return b;
    const obj = await mp.complete(b.parts);
    const refused = await quotaRefusal(env, space, obj.size, key);
    if (refused) {
      // complete() has already overwritten whatever the key held: the
      // object goes, and so does the row that described the old one, or
      // the quota keeps counting bytes that are not there.
      await env.STAGING.delete(key);
      await env.DB.prepare("DELETE FROM staging_objects WHERE key = ?").bind(key).run();
      return refused;
    }
    await env.DB.prepare("INSERT OR REPLACE INTO staging_objects (key, owner, task_id, size) VALUES (?, ?, ?, ?)").bind(key, space, task.id, obj.size).run();
    return json({ key, size: obj.size }, 201);
  }
  if (action === "abort") {
    await mp.abort();
    return json({ aborted: key });
  }
  return json({ error: "action must be create, part, complete or abort" }, 400);
}

/** What a task has in staging (public: logs and PKGBUILDs are the evidence; packages are listed, not served). */
export async function handleStagingList(taskId: number, env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT key, size, uploaded_at FROM staging_objects WHERE task_id = ? ORDER BY key").bind(taskId).all();
  return json({ task: taskId, objects: rows.results });
}

/**
 * The owner (or a maintainer) drops a community task's staging objects so
 * they stop counting toward the quota. Refused while the task is
 * queued or leased: a worker may still be writing. Refused, too, while the
 * project builds from it: its worker reads the PKGBUILD, the log and the
 * audit from here. A staged build whose evidence is gone is cancelled — it
 * is no longer something to review — and the package and the pending audit
 * follow it, as they do on a rejection.
 */
export async function handleStagingDelete(c: Contributor, taskId: number, env: Env): Promise<Response> {
  const task = await env.DB.prepare("SELECT id, name, owner, status, trust FROM build_tasks WHERE id = ?").bind(taskId).first<{ id: number; name: string; owner: string | null; status: string; trust: string }>();
  if (!task) return json({ error: "no such task" }, 404);
  if (task.trust !== "community") return json({ error: "only a contributor's staging can be dropped this way" }, 400);
  if (task.owner !== c.login && !isMaintainer(c)) return json({ error: "not yours (or not a maintainer)" }, 403);
  if (task.status === "queued" || task.status === "leased") return json({ error: `task ${taskId} is ${task.status}; wait for the worker to finish or the lease to expire` }, 409);
  const projectBuild = await env.DB.prepare("SELECT id, status FROM build_tasks WHERE kind = 'build' AND trust = 'project' AND json_extract(params, '$.review') = ? AND status IN ('queued', 'leased')")
    .bind(taskId)
    .first<{ id: number; status: string }>();
  if (projectBuild) return json({ error: `the project is building from task ${taskId} (task ${projectBuild.id} is ${projectBuild.status}); its worker reads this evidence — wait for it` }, 409);
  const rows = await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ?").bind(taskId).all<{ key: string }>();
  const keys = rows.results.map((r) => r.key);
  if (keys.length) await env.STAGING.delete(keys);
  await env.DB.prepare("DELETE FROM staging_objects WHERE task_id = ?").bind(taskId).run();
  if (task.status === "staged") {
    await env.DB.batch([
      env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = ? WHERE id = ?").bind(`staging dropped by ${c.login}`, taskId),
      env.DB.prepare("UPDATE build_tasks SET status = 'cancelled', error = 'the build it audited was dropped' WHERE kind = 'audit' AND status = 'queued' AND json_extract(params, '$.task') = ?").bind(taskId),
      // Back to registered, unless another staged build of the package — the
      // contributor's for another architecture, or the project's — still waits.
      env.DB.prepare(
        `UPDATE factory_packages SET status = 'registered', detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE name = ? AND status = 'staged'
             AND NOT EXISTS (SELECT 1 FROM build_tasks t WHERE t.kind = 'build' AND t.status = 'staged' AND t.name = factory_packages.name AND t.id != ?)`,
      ).bind(`staging dropped by ${c.login}`, task.name, taskId),
    ]);
  }
  return json({ task: taskId, deleted: keys.length });
}

export async function handleStagingGet(taskId: number, filename: string, env: Env, maintainer: boolean): Promise<Response> {
  const row = await env.DB.prepare("SELECT key FROM staging_objects WHERE task_id = ? AND key LIKE ?").bind(taskId, `%/${filename}`).first<{ key: string }>();
  if (!row) return json({ error: "no such object" }, 404);
  const isText = isTextEvidence(filename);
  if (!isText && !maintainer) return json({ error: "packages in staging are for maintainers; the log and the PKGBUILD are public" }, 403);
  const obj = await env.STAGING.get(row.key);
  if (!obj) return json({ error: `gone (packages of decided builds are reclaimed; staging expires after ${STAGING_DAYS} days; the text evidence is on the record)` }, 404);
  return new Response(obj.body, { headers: { "content-type": isText ? "text/plain; charset=utf-8" : "application/octet-stream", "cache-control": "no-store" } });
}

// ---------- maintainers ----------

/** Maintainers are named by factory/MAINTAINERS.toml (governance.ts); there is no other role above contributor. */
export function isMaintainer(c: Contributor): boolean {
  return c.role === "maintainer";
}

/**
 * A maintainer settles a package's category (categories.ts) — at review, or
 * any time after; the agent's proposal, if any, is what it replaces. A
 * `category` line in the journal says who and from what.
 */
export async function handleSetCategory(c: Contributor, name: string, request: Request, env: Env): Promise<Response> {
  if (!isMaintainer(c)) return json({ error: "a maintainer's token is required" }, 403);
  const b = (await request.json().catch(() => ({}))) as { category?: unknown };
  if (!isCategory(b.category)) return json({ error: `category must be one of ${CATEGORIES.join(", ")}` }, 400);
  const pkg = await env.DB.prepare("SELECT category FROM factory_packages WHERE name = ?").bind(name).first<{ category: string | null }>();
  if (!pkg) return json({ error: "not registered" }, 404);
  if (pkg.category === b.category) return json({ package: name, category: b.category, by: c.login, unchanged: true });
  await env.DB.batch([
    env.DB.prepare("UPDATE factory_packages SET category = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").bind(b.category, name),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('category', NULL, 'factory', 'ok', ?, ?)")
      .bind(`${name}: ${b.category} (was ${pkg.category ?? "unset"}), settled by ${c.login}`, JSON.stringify({ name, category: b.category, was: pkg.category, by: c.login })),
  ]);
  return json({ package: name, category: b.category, was: pkg.category, by: c.login });
}

/**
 * Project trust on two maintainers' word (/docs/security-model, *Trust levels*). The
 * first maintainer proposes; a second — never the same person, never the
 * worker's owner — confirms, and trusted_by names both. Back to community
 * is one maintainer's call (taking trust away is always easy). Each step is
 * an event, and the trust itself a signed record under
 * workers/<id>/trust-<time>.json, so anyone can read who vouched for the
 * machine that publishes.
 */
export async function handleTrustWorker(c: Contributor, id: string, request: Request, env: Env): Promise<Response> {
  if (!isMaintainer(c)) return json({ error: "a maintainer's token is required" }, 403);
  const b = await readJson<{ trust?: string }>(request);
  if (b instanceof Response) return b;
  const trust = b.trust === "project" ? "project" : "community";
  const w = await env.DB.prepare("SELECT id, owner, trust, trusted_by, trust_proposed_by FROM build_workers WHERE id = ? AND revoked_at IS NULL")
    .bind(id)
    .first<{ id: string; owner: string | null; trust: string; trusted_by: string | null; trust_proposed_by: string | null }>();
  if (!w) return json({ error: "no such worker (or revoked)" }, 404);
  const now = new Date().toISOString();
  const event = (summary: string, payload: Record<string, unknown>) =>
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('trust', NULL, 'factory', 'ok', ?, ?)").bind(summary, JSON.stringify(payload)).run();
  if (trust === "community") {
    if (w.trust === "community" && !w.trust_proposed_by) return json({ worker: id, trust: "community", unchanged: true });
    await env.DB.prepare("UPDATE build_workers SET trust = 'community', trusted_by = NULL, trusted_at = NULL, trust_proposed_by = NULL, trust_proposed_at = NULL WHERE id = ?").bind(id).run();
    await event(`worker ${id} set to community trust by ${c.login}${w.trust === "project" ? ` (was project, trusted by ${w.trusted_by ?? "?"})` : " (a proposal withdrawn)"}`, { worker: id, trust: "community", by: c.login, was: w.trust, trusted_by: w.trusted_by });
    await putRecord(env, `workers/${id}/trust-${now}.json`, { schema: "omarchy-pool/worker-trust/1", worker: id, owner: w.owner, trust: "community", by: c.login, was: { trust: w.trust, trusted_by: w.trusted_by }, at: now }).catch(() => null);
    return json({ worker: id, trust: "community", by: c.login });
  }
  if (w.trust === "project") return json({ worker: id, trust: "project", trusted_by: w.trusted_by, unchanged: true });
  // The owner never gives the first word — someone else vouches for their
  // machine — but may give the second, once another maintainer has: two
  // maintainers' word, never the owner's alone. With two maintainers in
  // the project (2026-09-17), the rule as "two others" left the Studio's
  // own workers with nobody to trust them.
  if (w.owner === c.login && !w.trust_proposed_by) return json({ error: "a maintainer does not propose their own worker; another maintainer proposes it, and then the owner (or a third) confirms" }, 403);
  if (!w.trust_proposed_by || w.trust_proposed_by === c.login) {
    await env.DB.prepare("UPDATE build_workers SET trust_proposed_by = ?, trust_proposed_at = ? WHERE id = ?").bind(c.login, now, id).run();
    if (w.trust_proposed_by !== c.login) await event(`worker ${id} proposed for project trust by ${c.login}; a second maintainer confirms`, { worker: id, proposed_by: c.login, owner: w.owner });
    return json({ worker: id, trust: "community", proposed_by: c.login, awaiting: "a second maintainer's word — the owner's counts, yours again does not" }, 202);
  }
  const by = `${w.trust_proposed_by}, ${c.login}`;
  await env.DB.prepare("UPDATE build_workers SET trust = 'project', trusted_by = ?, trusted_at = ?, trust_proposed_by = NULL, trust_proposed_at = NULL WHERE id = ?").bind(by, now, id).run();
  await event(`worker ${id} set to project trust on the word of ${by}`, { worker: id, trust: "project", by, owner: w.owner });
  const record = await putRecord(env, `workers/${id}/trust-${now}.json`, { schema: "omarchy-pool/worker-trust/1", worker: id, owner: w.owner, trust: "project", proposed_by: w.trust_proposed_by, confirmed_by: c.login, at: now }).catch(() => null);
  return json({ worker: id, trust: "project", trusted_by: by, record: record ? recordUrl(env, record.key) : null });
}

export async function handleTrustList(env: Env): Promise<Response> {
  const workers = await env.DB.prepare("SELECT id, owner, arch, mode, trust, trusted_by, trusted_at, trust_proposed_by, trust_proposed_at, agent, last_seen, revoked_at FROM build_workers WHERE trust = 'project' OR trust_proposed_by IS NOT NULL OR owner IS NULL ORDER BY trust DESC, last_seen DESC LIMIT 100").all();
  const people = await env.DB.prepare("SELECT login, name, role, last_seen FROM contributors WHERE role = 'maintainer' ORDER BY login").all();
  return json({ workers: workers.results, maintainers: people.results, listed: await maintainersOf(env), source: GOVERNANCE_FILE }, 200, { "cache-control": "public, max-age=30" });
}

/**
 * POST /factory/record/withdraw {key, reason} — a maintainer takes a record
 * off the public bucket: a log that carried what it should not have, a
 * report with someone's data in it. A signed tombstone takes its place
 * (record.ts, withdrawRecord); the reason is required and goes on it.
 */
export async function handleWithdrawRecord(c: Contributor, request: Request, env: Env): Promise<Response> {
  if (!isMaintainer(c)) return json({ error: "a maintainer's token is required" }, 403);
  const b = (await request.json().catch(() => ({}))) as { key?: unknown; reason?: unknown };
  const key = typeof b.key === "string" ? b.key.replace(/^\/+/, "") : "";
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (!/^(factory|workers)\/[A-Za-z0-9@._+/-]+$/.test(key) || key.endsWith(".sig") || key.endsWith(".tombstone.json")) return json({ error: "key must name a record under factory/ or workers/ (not a signature, not a tombstone)" }, 400);
  if (reason.length < 8) return json({ error: "a reason is required (why this record is withdrawn — it goes on the tombstone)" }, 400);
  const done = await withdrawRecord(env, key, c.login, reason);
  if (!done) return json({ error: "no such record" }, 404);
  return json({ withdrawn: key, by: c.login, ...done, tombstone_url: recordUrl(env, done.tombstone) });
}
