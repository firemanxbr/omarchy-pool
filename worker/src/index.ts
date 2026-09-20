/**
 * Omarchy packaging staging: immutable package pool (R2), index with pinned
 * releases (D1), generated pacman databases, and a public dashboard.
 *
 * pacman never talks to this worker. Packages and the per-ring databases are
 * plain R2 objects served from the bucket's custom domain (POOL_URL):
 *   <source>/<arch>/<filename>   <source>/<arch>/omarchy-<source>-<ring>.db (.files, .sig)
 *
 * API (JSON; writes need a per-job token — issued when a worker claims a
 * task — or, for the factory's maintainer actions, a maintainer's own token):
 *   PUT  /api/v1/pool/:sha256?filename=&source=&arch=   raw archive → R2 (integrity-checked), under <source>/<arch>/
 *   PUT  /api/v1/pool/:sha256/sig?filename=&source=&arch= detached signature
 *   POST /api/v1/pool/:sha256/multipart?filename=&source=&arch=  large archives: create / parts / complete
 *   POST /api/v1/packages?source=core              manifest JSON → index rows
 *   POST /api/v1/packages/known                    which sha256s are already indexed
 *   GET  /api/v1/packages/:sha256
 *   GET  /api/v1/packages/:sha256/provenance      the seal: where the object came from, and the proof
 *   GET  /api/v1/releases/:ring[?fields=summary|include=files][&arch=&limit=&offset=&release_id=]
 *   GET  /api/v1/releases/:ring/history
 *   GET  /api/v1/releases/:ring/diff?from=&to=&arch=  added / removed / upgraded between two releases
 *   POST /api/v1/releases                          create / promote / roll back
 *   PUT  /api/v1/releases/:id/artifacts/:kind?repo=&arch=
 *   GET  /api/v1/search?q=&ring=&arch=          package search within a ring
 *   GET  /api/v1/package/:name[/files]?ring=&arch=  package page data: rings, manifest, edges
 *   GET  /api/v1/security?ring=&arch=             open advisories in a ring and what they expose
 *   GET  /api/v1/security/components              what the rings' packages embed (Go modules, crates), for OSV
 *   PUT  /api/v1/security/advisories|matches       vulnerability data from the Security workflow
 *   POST /api/v1/security/prune                  {advisories, matches}: the run's keys; the rest goes
 *   GET  /api/v1/factory · POST /factory/{claim,requests,enqueue,jobs} · /factory/tasks/:id/{heartbeat,complete,fail,cancel,approve,reject,artifacts/<file>}
 *   GET  /api/v1/factory/{packages,built,review,approvals,maintainers,trust,workers/self,me} · GET /api/v1/factory/tasks/:id/can · GET /api/v1/users/:login · GET /api/v1/users/:login/can · GET /api/v1/cost
 *                                                  the factory's brain: package requests, build tasks, pull-based workers
 *   GET  /api/v1/graph?targets=a,b&ring=stable
 *   POST /api/v1/events   GET /api/v1/events       activity log
 *   GET  /api/v1/stats                             everything the dashboard shows
 *   GET  /api/v1/version                           running release, commit, deploy time
 *   GET  /api/v1/status                            service check now: index (D1) and pool (R2)
 *   GET  /api/v1/pool/unreferenced?keep=3          retention: what GC would delete
 *   POST /api/v1/pool/gc?keep=3&limit=200          delete it (objects, then rows)
 *   POST /api/v1/pool/relayout?phase=copy|purge     the one-time move to <source>/<arch>/ (the relayout job)
 *   GET  /                                         the dashboard: the Pool (users), /factory (contributors), /pipeline (everyone, live),
 *                                                  /docs, and the detail pages /packages /package/:name /security /status /journal /workers /review /user/:login
 *   GET  /pool/<source>/<arch>/<file>              fallback static origin (dev)
 *   GET  /setup                                    the one-command setup script (curl … | sudo bash -s -- --ring stable)
 *   GET  /omarchy-worker · /omarchy-worker/compose.yml   one command to run a worker (src/omarchy-worker.sh) and the compose file it writes
 *   GET  /api/v1/pacman.conf?ring=&arch=&with=     the pacman.d include a ring serves right now
 */

import { handleMultipartComplete, handleMultipartCreate, handleMultipartPart, handlePutPool, handlePutPoolSig } from "./routes/pool";
import { handleGetPackage, handleKnownPackages, handlePostPackage } from "./routes/packages";
import { handleProvenance } from "./routes/seal";
import { handleCreateRelease, handleGetRelease, handleReleaseHistory, handlePutArtifact, handleReleaseDiff } from "./routes/releases";
import { handleGraph } from "./routes/graph";
import { handlePackage, handlePackageFiles, handleSearch } from "./routes/search";
import { handlePrune, handlePutAdvisories, handlePutMatches, handleSecurity, handleComponents } from "./routes/security";
import {
  handleCancelTask, handleClaim, handleComplete, handleEnqueue, handleFactory, handleFail,
  handleHeartbeat, handleTask, handleBuilt,
} from "./routes/factory";
import { authorize, authorizeRelease, authorizeArtifacts, authorizeJobOrMaintainer, maintainerOf } from "./auth";
import {
  contributorOf, workerOf, handleRegister, handleMe, handleRequestPackage, handleDeletePackage, handleSetCategory, handleBuildPackage, handleRegisterWorker,
  handleRevokeWorker, handleDequeueBuild, handleListPackages, handleStagingPut, handleStagingMultipart, handleStagingList, handleStagingGet, handleStagingDelete,
} from "./routes/contributors";
import type { Actor } from "./routes/factory";
import { jobOf } from "./jobtoken";
import { handleTrustWorker, handleTrustList, handleNewToken, handleWithdrawRecord, handleWorkerMode, handleWorkerLog, SIGN_IN } from "./routes/contributors";
import { maintainersOf, GOVERNANCE_FILE } from "./governance";
import { BUDGET_CAP_USD, BUDGET_GUARD_USD, BUDGET_WARN_USD, readGuard } from "./cost";
import { handleQueueJob } from "./jobs";
import { isMaintainer } from "./routes/contributors";
import { handleReviewList, handleApprove, handleReject, handleApprovals, handleProjectBuild, handleWithdraw, handleTaskCan } from "./routes/review";
import { handleBlockContributor, handleUnblockContributor, handleBlockPackage, handleUnblockPackage, handleBlocks } from "./routes/blocks";
import { handleAuthStart, handleAuthCallback, handleLogout } from "./routes/auth";
import { handleSignPool } from "./routes/pool";
import { signingEnabled, publicKey } from "./signing";
import { reviewHtml } from "./pages/review";
import { buildHtml } from "./pages/build";
import { handlePackageStory } from "./routes/story";
import { icon } from "./pages/icons";
import { robotsTxt, sitemapXml } from "./pages/robots";
import { requestHtml } from "./pages/request";
import { governanceHtml } from "./pages/governance";
import { docsHtml } from "./pages/docs";
import { docsWorkersHtml } from "./pages/docs-workers";
import { workersHtml } from "./pages/workers";
import { userHtml } from "./pages/user";
import { peopleHtml } from "./pages/people";
import { handleUser, handleUserCan } from "./routes/users";
import { handleGetEvents, handlePostEvent } from "./routes/events";
import { handleServiceStatus, handleStats } from "./routes/stats";
import { handleGc, handleUnreferenced } from "./routes/gc";
import { handleRelayout } from "./routes/relayout";
import { overviewHtml } from "./pages/overview";
import { getStartedHtml, picked, sampleUrl } from "./pages/get-started";
import { howItWorksHtml } from "./pages/how-it-works";
import { docsSecurityHtml } from "./pages/docs-security";
import { glossaryHtml } from "./pages/glossary";
import { docHtml, mdChapterAt } from "./pages/doc";
import { statusHtml } from "./pages/status";
import { journalHtml } from "./pages/journal";
import { apiDocsHtml } from "./pages/api-docs";
import { diffHtml } from "./pages/diff";
import { packageHtml, packagesHtml } from "./pages/packages";
import { securityHtml } from "./pages/security";
import { pipelineHtml } from "./pages/pipeline";
import { factoryHtml as factoryPageHtml } from "./pages/contribute";
import { DASHBOARD_HOST, LEGACY_DASHBOARD_HOSTS, isProductionHost, machineOrigin, version } from "./meta";
import { handleStatic } from "./routes/static";
import { pacmanInclude, setupScript, workerCli, workerCompose } from "./routes/setup";
import { runScheduler } from "./scheduler";

export interface Env {
  DB: D1Database;
  PACKAGES: R2Bucket;
  /** Contributors' build results, per workspace; a maintainer's approval moves them on. */
  STAGING: R2Bucket;
  DEFAULT_RING: string;
  POOL_URL: string;
  /** Set by the Release workflow at deploy time (`wrangler deploy --var`); "dev" otherwise. */
  POOL_VERSION?: string;
  POOL_COMMIT?: string;
  /** Page views: a GA4 measurement id (G-XXXXXXX) or a Cloudflare Web Analytics token (32 hex); empty or unset = no script on any page. */
  ANALYTICS?: string;
  POOL_DEPLOYED_AT?: string;
  /** Fine-grained GitHub token (Actions: read and write) for the pool's own scheduler. */
  GITHUB_TOKEN?: string;
  /** "off" only in tests: the request's source URL is not fetched. */
  SOURCE_CHECK?: string;
  /** Signs per-job tokens (jobtoken.ts); any random string. */
  JOB_TOKEN_SECRET?: string;
  /** A Cloudflare API token with Account · Analytics · Read, and the account, for the daily cost estimate (cost.ts) and the daily audience count (audience.ts). */
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_D1_ID?: string;
  /** The pool's OpenPGP signing key (armored private key) and its passphrase, if any — signing.ts. */
  SIGNING_KEY?: string;
  SIGNING_KEY_PASSPHRASE?: string;
  /** GitHub OAuth App for "Sign in with GitHub" (routes/auth.ts). */
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** Task kinds the scheduler creates as pulled jobs instead of GitHub workflows (comma-separated). */
  JOB_KINDS?: string;
}


// The rings live in meta.ts with the ring texts; re-exported here so every route keeps its import.
export { RINGS, PROMOTED_RINGS, RINGS_BY_STABILITY, isRing, type Ring } from "./meta";

const API = "/api/v1";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const { method } = request;

    // A page on a legacy dashboard name moves to the dashboard, path and
    // query kept — 301 for a read, 308 so a client that follows keeps its
    // method; /api/v1/* on them is answered (why: LEGACY_DASHBOARD_HOSTS).
    // http→https is the zone setting Always Use HTTPS at the edge, on both
    // zones, not here.
    if (LEGACY_DASHBOARD_HOSTS.includes(url.hostname) && !path.startsWith(API + "/")) {
      return Response.redirect(`https://${DASHBOARD_HOST}${path}${url.search}`, method === "GET" || method === "HEAD" ? 301 : 308);
    }

    try {
      // While the cost guard is up, an anonymous machine reading a package
      // page or its data is shed here (cost.ts readGuard) — before the API
      // branch, so the 503 is never looked up or stored by cachedApi.
      const shed = await readGuard(request, url, env);
      if (shed) return shed;
      if (path.startsWith(API + "/")) {
        const res = await cachedApi(method, path.slice(API.length), url, request, env, ctx);
        res.headers.set("access-control-allow-origin", "*");
        // No API answer is a page for an index (pages/robots.ts): said on the answer too, for a crawler that reads the API from a page's script.
        res.headers.set("x-robots-tag", "noindex, nofollow");
        return res;
      }
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
      if (path.startsWith("/pool/") && (method === "GET" || method === "HEAD")) {
        return await handleStatic(decodeURIComponent(path.slice("/pool/".length)), request, env);
      }
      if (path === "/") return html(overviewHtml(env.POOL_URL, version(env)));
      // The two old addresses of a door are redirects, not a second page: one page, one address, and a bookmark still lands.
      if (path === "/index.html" || path === "/contribute") {
        url.pathname = path === "/contribute" ? "/factory" : "/";
        return Response.redirect(url.toString(), 301);
      }
      // One command to join a ring: the script, read by people before they pipe it into sudo.
      if (path === "/setup" || path === "/setup.sh") return new Response(setupScript(machineOrigin(url), env.POOL_URL.replace(/\/$/, "")), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
      // One command to run a worker: the script (read before it is run) and the compose file it writes.
      if (path === "/omarchy-worker" || path === "/omarchy-worker.sh") return new Response(workerCli(machineOrigin(url)), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
      if (path === "/omarchy-worker/compose.yml") return new Response(workerCompose(), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
      // Sign in with GitHub: cookie session for the dashboard's pages.
      if (path === "/auth/github" && method === "GET") return handleAuthStart(url, env);
      if (path === "/auth/github/callback" && method === "GET") return handleAuthCallback(url, request, env);
      if (path === "/auth/logout") return handleLogout(url, request, env);
      if (path === "/auth/me" && method === "GET") {
        const c = await contributorOf(request, env);
        return c ? json({ login: c.login, name: c.name, avatar_url: c.avatar_url, role: c.role }, 200, { "cache-control": "no-store" }) : json({ error: "not signed in" }, 401, { "cache-control": "no-store" });
      }
      // The reader's own page: /me is the address the Factory's gate and the
      // sign-in name before the login is known. With a session it is
      // /user/<login>; without one it is the sign-in, which comes back here.
      // The answer depends on the cookie, so no cache keeps it; the Location
      // is relative, as the sign-in's own redirects are.
      if (path === "/me" && (method === "GET" || method === "HEAD")) {
        const c = await contributorOf(request, env);
        return new Response(null, { status: 302, headers: { location: c ? `/user/${encodeURIComponent(c.login)}` : "/auth/github?next=/me", "cache-control": "no-store" } });
      }
      // Documentation: one section, its chapters under /docs; the old addresses redirect.
      if (path === "/docs" || path === "/docs/") return html(docsHtml(env.POOL_URL, version(env)));
      if (path === "/docs/get-started") {
        // The include is the API's answer for the pick, through the API's edge cache under the address the script fetches: one stored answer for the page and its script, pacmanInclude's reads paid once per colo per two minutes, not per view.
        const pick = picked(url, env);
        const res = await cachedApi("GET", "/pacman.conf", sampleUrl(url, pick), request, env, ctx);
        return html(getStartedHtml(env.POOL_URL, version(env), pick, res.ok ? await res.text() : null));
      }
      if (path === "/docs/workers") return html(docsWorkersHtml(env.POOL_URL, version(env)));
      if (path === "/docs/how-it-works") return html(howItWorksHtml(env.POOL_URL, version(env)));
      if (path === "/docs/security") return html(docsSecurityHtml(env.POOL_URL, version(env)));
      if (path === "/docs/glossary") return html(glossaryHtml(env.POOL_URL, version(env)));
      // The chapters written in markdown, their diagrams drawn in place.
      const md = mdChapterAt(path);
      if (md) return html(docHtml(md, env.POOL_URL, version(env)));
      if (path === "/docs/governance") return html(governanceHtml(env.POOL_URL, version(env)));
      if (path === "/get-started" || path === "/how-it-works" || path === "/governance") {
        url.pathname = `/docs${path}`;
        return Response.redirect(url.toString(), 301);
      }
      if (path === "/status") return html(statusHtml(env.POOL_URL, version(env)));
      if (path === "/journal") return html(journalHtml(env.POOL_URL, version(env)));
      if (path === "/workers") return html(workersHtml(env.POOL_URL, version(env)));
      if (path === "/diff") return html(diffHtml(env.POOL_URL, version(env)));
      if (path === "/api" || path === "/api/") return html(apiDocsHtml(env.POOL_URL, version(env)));
      if (path === "/packages") return html(packagesHtml(env.POOL_URL, version(env)));
      if (path === "/security") return html(securityHtml(env.POOL_URL, version(env)));
      if (path === "/factory") return html(factoryPageHtml(env.POOL_URL, version(env)));
      if (path === "/people") return html(peopleHtml(env.POOL_URL, version(env)));
      if (path === "/pipeline") return html(pipelineHtml(env.POOL_URL, version(env)));
      if (path === "/review") return html(reviewHtml(env.POOL_URL, version(env)));
      if (path === "/request") return html(requestHtml(env.POOL_URL, version(env)));
      const user = path.match(/^\/user\/([A-Za-z0-9-]{1,39})$/);
      if (user) return html(userHtml(user[1], env.POOL_URL, version(env)));
      if (path.startsWith("/package/")) return html(packageHtml(decodeURIComponent(path.slice("/package/".length)), env.POOL_URL, version(env)));
      if (/^\/build\/\d+$/.test(path)) return html(buildHtml(Number(path.slice("/build/".length)), env.POOL_URL, version(env)));
      // What a crawler may read (pages/robots.ts): the rules for the name asked on, and the pages worth an index under the dashboard's name on production.
      if (path === "/robots.txt") return new Response(robotsTxt(url.hostname), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } });
      if (path === "/sitemap.xml") return new Response(sitemapXml(isProductionHost(url.hostname) ? `https://${DASHBOARD_HOST}` : url.origin), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=86400" } });
      const ic = icon(path);
      if (ic) return ic;
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "internal error", detail: String(err) }, 500);
    }
  },

  /** Cloudflare cron trigger (every ten minutes): dispatch overdue workflows. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduler(env).then((log) => console.log(log.join("\n"))));
  },
} satisfies ExportedHandler<Env>;

/**
 * The factory's writes. Three kinds of caller: a maintainer (their own token
 * or session, for what maintainers decide), a registered worker (its own token; project
 * trust is a maintainer's decision on the registration) or a job (its
 * per-task token), and a contributor (their token).
 */
async function factoryRoutes(method: string, path: string, url: URL, request: Request, env: Env): Promise<Response | null> {
  let m: RegExpMatchArray | null;
  // Contributors.
  if (method === "POST" && path === "/factory/register") return handleRegister(request, env);
  // Maintainers: the brake — a contributor or a package blocked, or the block lifted by another maintainer.
  if ((m = path.match(/^\/factory\/(contributors|packages)\/([A-Za-z0-9@._+-]+)\/(block|unblock)$/)) && method === "POST") {
    const c = await contributorOf(request, env);
    if (!c) return nobody();
    if (m[1] === "contributors") return m[3] === "block" ? handleBlockContributor(c, m[2], request, env) : handleUnblockContributor(c, m[2], request, env);
    return m[3] === "block" ? handleBlockPackage(c, m[2], request, env) : handleUnblockPackage(c, m[2], request, env);
  }
  // Maintainers: a record withdrawn from the public bucket, a signed tombstone in its place.
  if (method === "POST" && path === "/factory/record/withdraw") {
    const c = await contributorOf(request, env);
    if (!c) return json({ error: "a maintainer's contributor token is required" }, 401);
    return handleWithdrawRecord(c, request, env);
  }
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/artifacts$/)) && method === "DELETE") {
    const c = await contributorOf(request, env);
    if (!c) return nobody();
    return handleStagingDelete(c, Number(m[1]), env);
  }
  // A worker sets its own mode through its token (omarchy-worker share on|off): the brain keeps it from then on.
  if (method === "POST" && path === "/factory/workers/self/mode") {
    const w = await workerOf(request, env);
    return w ? handleWorkerMode({ worker: w.id }, w.id, request, env) : json({ error: "a worker token is required" }, 401);
  }
  if (path === "/factory/packages" || path.startsWith("/factory/packages/") || path === "/factory/workers" || path.startsWith("/factory/workers/")) {
    const c = await contributorOf(request, env);
    if (!c) return nobody();
    if ((m = path.match(/^\/factory\/workers\/([A-Za-z0-9_.-]+)\/mode$/)) && method === "POST") return handleWorkerMode(c, m[1], request, env);
    if (method === "POST" && path === "/factory/packages") return handleRequestPackage(c, request, env);
    if ((m = path.match(/^\/factory\/packages\/([a-z0-9@._+-]+)\/build$/)) && method === "POST") return handleBuildPackage(c, m[1], request, env);
    if ((m = path.match(/^\/factory\/packages\/([a-z0-9@._+-]+)$/)) && method === "DELETE") return handleDeletePackage(c, m[1], env);
    if ((m = path.match(/^\/factory\/packages\/([a-z0-9@._+-]+)\/category$/)) && method === "POST") return handleSetCategory(c, m[1], request, env);
    if (method === "POST" && path === "/factory/workers") return handleRegisterWorker(c, request, env);
    if ((m = path.match(/^\/factory\/packages\/([A-Za-z0-9@._+-]+)\/builds\/(\d+)$/)) && method === "DELETE") return handleDequeueBuild(c, m[1], Number(m[2]), env);
    if ((m = path.match(/^\/factory\/workers\/([A-Za-z0-9_.-]+)$/)) && method === "DELETE") return handleRevokeWorker(c, m[1], env);
    if ((m = path.match(/^\/factory\/workers\/([A-Za-z0-9_.-]+)\/trust$/)) && method === "POST") return handleTrustWorker(c, m[1], request, env);
    return null;
  }
  // Roles are not set here: factory/MAINTAINERS.toml on main names the
  // maintainers (governance.ts); a signed-in contributor may mint a CLI token.
  if (method === "POST" && path === "/factory/token") {
    const c = await contributorOf(request, env);
    return c ? handleNewToken(c, env) : nobody();
  }
  // Maintainers: have the project build a staged package, approve or reject a staged build.
  // Nobody at the door reads the same words the predicate gives a page (decisions() in routes/review.ts): the refusal is the button's title.
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/withdraw$/)) && method === "POST") {
    const c = await contributorOf(request, env);
    if (!c) return nobody();
    return handleWithdraw(c, Number(m[1]), request, env);
  }
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/(approve|reject|build)$/)) && method === "POST") {
    const c = await contributorOf(request, env);
    if (!c) return nobody();
    return m[2] === "approve" ? handleApprove(c, Number(m[1]), request, env) : m[2] === "build" ? handleProjectBuild(c, Number(m[1]), request, env) : handleReject(c, Number(m[1]), request, env);
  }
  // Workers: registered ones only (own token), or a job's token. There is
  // no shared worker secret: every worker is somebody's registration.
  const workerActor = async (): Promise<Actor | Response> => {
    const w = await workerOf(request, env);
    if (w) return { kind: "worker", w };
    const job = await jobOf(request, env);
    return job ? { kind: "job", job } : json({ error: "unauthorized: a worker token (POST /factory/workers) or a job token" }, 401);
  };
  // A job token good for this task's staging, as the worker it was issued to.
  const stagingActor = async (taskId: number) => {
    const w = await workerOf(request, env);
    if (w) return w;
    const job = await jobOf(request, env);
    return job && job.s.includes(`staging:${taskId}`) ? { id: job.w, owner: null, mode: "", packages: [], arch: "", trust: "community", job: job.k } : null;
  };
  if (method === "POST" && path === "/factory/claim") { const a = await workerActor(); return a instanceof Response ? a : handleClaim(request, env, a); }
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/heartbeat$/)) && method === "POST") { const a = await workerActor(); return a instanceof Response ? a : handleHeartbeat(Number(m[1]), env, a); }
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/complete$/)) && method === "POST") { const a = await workerActor(); return a instanceof Response ? a : handleComplete(Number(m[1]), request, env, a); }
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/fail$/)) && method === "POST") { const a = await workerActor(); return a instanceof Response ? a : handleFail(Number(m[1]), request, env, a); }
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/artifacts\/([A-Za-z0-9][A-Za-z0-9._:+-]{0,200})$/)) && method === "PUT") {
    const w = await stagingActor(Number(m[1]));
    if (!w) return json({ error: "a registered worker token or this task's job token is required" }, 401);
    return handleStagingPut(Number(m[1]), m[2], request, env, w);
  }
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/artifacts\/([A-Za-z0-9][A-Za-z0-9._:+-]{0,200})\/multipart$/)) && method === "POST") {
    const w = await stagingActor(Number(m[1]));
    if (!w) return json({ error: "a registered worker token or this task's job token is required" }, 401);
    return handleStagingMultipart(Number(m[1]), m[2], url, request, env, w);
  }
  return null;
}

/**
 * GET responses that declare `cache-control: public, max-age=N` are kept in
 * the edge cache for that long, so a hundred dashboards polling cost one D1
 * round of queries per colo, not a hundred. Everything else goes straight
 * through.
 */
async function cachedApi(method: string, path: string, url: URL, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (method !== "GET") return api(method, path, url, request, env);
  // The key names the API host whichever production name was asked: one copy per zone (the cache is the zone's), not per name.
  const key = new Request(`${machineOrigin(url)}${url.pathname}${url.search}`, { method: "GET" });
  const hit = await edgeHit(key);
  if (hit) return hit;
  const res = await api(method, path, url, request, env);
  // A handler with a key of its own has said hit or miss already, and what
  // it served is never kept under the URL — its key moves, the URL does not.
  if (res.headers.has("x-pool-cache")) return res;
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 0);
  if (res.ok && (res.headers.get("cache-control") ?? "").includes("public") && maxAge > 0) ctx.waitUntil(edgeStore(key, res.clone(), maxAge));
  res.headers.set("x-pool-cache", "miss");
  return res;
}

/**
 * The edge cache by a key of the caller's — the URL for cachedApi, something
 * better where a handler knows one (a release listing is its release's, not
 * its URL's: the head moves, the key moves with it). The platform may rewrite
 * cache-control on stored responses, so the expiry we mean travels in a
 * header of our own; a hit says so and tells the client what is left of it.
 */
export async function edgeHit(key: Request): Promise<Response | null> {
  const hit = await caches.default.match(key);
  const expires = Number(hit?.headers.get("x-pool-expires") ?? 0);
  if (!hit || expires <= Date.now()) return null;
  const res = new Response(hit.body, hit);
  res.headers.set("x-pool-cache", "hit");
  // The stored copy carries the platform's rewritten cache-control (hours),
  // which a browser would honour: the dashboard then shows a four-hour-old
  // pool. What the client may keep is what is left of our own expiry.
  res.headers.set("cache-control", `public, max-age=${Math.max(1, Math.ceil((expires - Date.now()) / 1000))}`);
  res.headers.delete("age");
  return res;
}

export async function edgeStore(key: Request, res: Response, maxAge: number): Promise<void> {
  const stored = new Response(res.body, res);
  stored.headers.set("cache-control", `public, max-age=${maxAge}`);
  stored.headers.set("x-pool-expires", String(Date.now() + maxAge * 1000));
  await caches.default.put(key, stored);
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

function cors(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
}

async function api(method: string, path: string, url: URL, request: Request, env: Env): Promise<Response> {
  let m: RegExpMatchArray | null;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (method === "GET" && path === "/pacman.conf") {
    const withOptional = new Set((url.searchParams.get("with") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const text = await pacmanInclude(env, url.searchParams.get("ring") ?? env.DEFAULT_RING, url.searchParams.get("arch") ?? "x86_64", withOptional, `${machineOrigin(url)}/setup`);
    if (text === null) return json({ error: "unknown ring or arch, or no release yet" }, 404);
    return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=120" } });
  }
  if (method === "GET" && path === "/stats") return handleStats(env);
  if (method === "GET" && path === "/version") return json(version(env), 200, { "cache-control": "public, max-age=30" });
  if (method === "GET" && path === "/status") return handleServiceStatus(env);
  if (method === "GET" && path === "/cost") {
    // The latest estimate (every three hours, settings.cost_latest; the
    // journal line is daily) and the live guard — a maintainer may have
    // lifted it, so it is the setting, not the estimate's verdict.
    const latest = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cost_latest'").first<{ value: string }>();
    const row = latest ? null : await env.DB.prepare("SELECT created_at, status, payload FROM events WHERE kind = 'cost' ORDER BY id DESC LIMIT 1").first<{ created_at: string; status: string; payload: string }>();
    const guard = await env.DB.prepare("SELECT value FROM settings WHERE key = 'cost_guard'").first<{ value: string }>();
    const est = latest ? (JSON.parse(latest.value) as Record<string, unknown>) : row ? { estimated_at: row.created_at, status: row.status, ...JSON.parse(row.payload) } : null;
    // The three lines (cost.ts) ride every answer, the one with no estimate too: they are the pool's budget, not the estimate's, and the Pipeline's panel names them before the first estimate exists.
    const lines_usd = { warn: BUDGET_WARN_USD, guard: BUDGET_GUARD_USD, cap: BUDGET_CAP_USD };
    return json(est ? { ...est, guard: guard?.value ?? null, lines_usd } : { error: "no estimate yet", lines_usd }, est ? 200 : 404, { "cache-control": "public, max-age=300" });
  }
  if (method === "GET" && path === "/signing-key") {
    const k = await publicKey(env);
    return k ? json(k, 200, { "cache-control": "public, max-age=3600" }) : json({ error: "the pool has no signing key configured" }, 404);
  }
  if (method === "GET" && path === "/graph") return handleGraph(url, env);
  if (method === "GET" && path === "/search") return handleSearch(url, env);
  if (method === "GET" && path === "/security") return handleSecurity(url, env);
  if (method === "GET" && path === "/factory") return handleFactory(env, url);
  if (method === "GET" && path === "/factory/blocks") return handleBlocks(env);
  if (method === "GET" && path === "/factory/built") return handleBuilt(env);
  if (method === "GET" && path === "/factory/packages") return handleListPackages(env);
  if (method === "GET" && path === "/factory/trust") return handleTrustList(env);
  if ((m = path.match(/^\/users\/([A-Za-z0-9-]{1,39})$/)) && method === "GET") return handleUser(m[1], env);
  // The page is cached for everyone (public, max-age); what one caller may do on it is theirs alone, so it rides on a no-store answer of its own.
  if ((m = path.match(/^\/users\/([A-Za-z0-9-]{1,39})\/can$/)) && method === "GET") return handleUserCan(await contributorOf(request, env), m[1], env);
  if (method === "GET" && path === "/factory/maintainers") {
    const synced = await env.DB.prepare("SELECT updated_at FROM settings WHERE key = 'governance_sha256'").first<{ updated_at: string }>();
    return json({ maintainers: await maintainersOf(env), source: GOVERNANCE_FILE, synced_at: synced?.updated_at ?? null }, 200, { "cache-control": "public, max-age=60" });
  }
  // No-store: each row says what the caller may do on it.
  if (method === "GET" && path === "/factory/review") return handleReviewList(env, request);
  if (method === "GET" && path === "/factory/approvals") return handleApprovals(env);
  // A worker asks what its registration is (the image decides its mode from this).
  // A worker's own log: its owner's and the maintainers' to read (a contributor token, or the dashboard's session).
  if ((m = path.match(/^\/factory\/workers\/([A-Za-z0-9_.-]+)\/log$/)) && method === "GET") {
    const c = await contributorOf(request, env);
    return c ? handleWorkerLog(c, m[1], env) : json({ error: "a contributor token is required" }, 401);
  }
  if (method === "GET" && path === "/factory/workers/self") {
    const w = await workerOf(request, env);
    return w ? json({ id: w.id, arch: w.arch, trust: w.trust, owner: w.owner, mode: w.mode, mode_by: w.mode_by ?? null }, 200, { "cache-control": "no-store" }) : json({ error: "a worker token is required" }, 401);
  }
  if (method === "GET" && path === "/factory/me") {
    const c = await contributorOf(request, env);
    return c ? handleMe(c, env) : json({ error: "a contributor token is required (POST /factory/register)" }, 401);
  }
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/artifacts$/)) && method === "GET") return handleStagingList(Number(m[1]), env);
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/artifacts\/([A-Za-z0-9][A-Za-z0-9._:+-]{0,200})$/)) && method === "GET") {
    // A package in staging is for maintainers — and for the publish job that carries the project's build into the pool, and the trial that tries it in the lab (their tokens name the task).
    const c = await contributorOf(request, env);
    const job = c ? null : await jobOf(request, env);
    return handleStagingGet(Number(m[1]), m[2], env, (!!c && isMaintainer(c)) || (!!job && (job.k === "publish" || job.k === "trial") && job.s.includes(`staging:${m[1]}`)));
  }
  if ((m = path.match(/^\/factory\/tasks\/(\d+)$/)) && method === "GET") return handleTask(Number(m[1]), env);
  // The task is cached for everyone (public, max-age); what one caller may do on it is theirs alone, so it rides on a no-store answer of its own.
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/can$/)) && method === "GET") return handleTaskCan(await contributorOf(request, env), Number(m[1]), env);
  if ((m = path.match(/^\/factory\/packages\/([A-Za-z0-9@._+-]+)\/story$/)) && method === "GET") return handlePackageStory(m[1], env);
  if (path.startsWith("/factory/") && (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH")) {
    const r = await factoryRoutes(method, path, url, request, env);
    if (r) return r;
  }
  // The factory's writes: the enqueue job (its token carries factory:write) or a maintainer by hand.
  const factoryWrite = () => authorizeJobOrMaintainer(request, env, "factory:write");
  if ((m = path.match(/^\/factory\/tasks\/(\d+)\/cancel$/)) && method === "POST") return (await factoryWrite()) ?? handleCancelTask(Number(m[1]), env);
  if (method === "POST" && path === "/factory/enqueue") return (await factoryWrite()) ?? handleEnqueue(request, env);
  // A maintainer runs a pool job by hand: queued like the scheduler's, executed by a project worker.
  if (method === "POST" && path === "/factory/jobs") {
    const c = await maintainerOf(request, env);
    return c instanceof Response ? c : handleQueueJob(c, request, env);
  }
  if (method === "PUT" && path === "/security/advisories") return (await authorize(request, env, "security:write")) ?? handlePutAdvisories(request, env);
  if (method === "PUT" && path === "/security/matches") return (await authorize(request, env, "security:write")) ?? handlePutMatches(request, env);
  if (method === "POST" && path === "/security/prune") return (await authorize(request, env, "security:write")) ?? handlePrune(request, url, env);
  if (method === "GET" && path === "/security/components") return handleComponents(env);
  if ((m = path.match(/^\/package\/([A-Za-z0-9@._+-]+)$/)) && method === "GET") return handlePackage(m[1], url, env);
  if ((m = path.match(/^\/package\/([A-Za-z0-9@._+-]+)\/files$/)) && method === "GET") return handlePackageFiles(m[1], url, env);
  if (method === "GET" && path === "/events") return handleGetEvents(url, env);
  if (method === "GET" && path === "/pool/unreferenced") return handleUnreferenced(url, env);
  if (method === "POST" && path === "/pool/gc") return (await authorize(request, env, "gc")) ?? handleGc(url, env);
  if (method === "POST" && path === "/pool/relayout") return (await authorize(request, env, "relayout")) ?? handleRelayout(url, env);
  if (method === "POST" && path === "/events") return (await authorizeJobOrMaintainer(request, env, "events")) ?? handlePostEvent(request, env);

  if ((m = path.match(/^\/pool\/([0-9a-f]{64})$/)) && method === "PUT") {
    return (await authorize(request, env, "pool:write")) ?? handlePutPool(m[1], url, request, env);
  }
  if ((m = path.match(/^\/pool\/([0-9a-f]{64})\/sig$/)) && method === "PUT") {
    return (await authorize(request, env, "pool:write")) ?? handlePutPoolSig(m[1], url, request, env);
  }
  if ((m = path.match(/^\/pool\/([0-9a-f]{64})\/sign$/)) && method === "POST") {
    return (await authorize(request, env, "pool:write")) ?? handleSignPool(m[1], url, env);
  }
  if ((m = path.match(/^\/pool\/([0-9a-f]{64})\/multipart$/)) && method === "POST") {
    return (await authorize(request, env, "pool:write")) ?? handleMultipartCreate(m[1], url, env);
  }
  if ((m = path.match(/^\/pool\/multipart\/([A-Za-z0-9._-]+)\/part\/(\d+)$/)) && method === "PUT") {
    const key = url.searchParams.get("key") ?? "";
    return (await authorize(request, env, "pool:write")) ?? handleMultipartPart(key, m[1], Number(m[2]), request, env);
  }
  if ((m = path.match(/^\/pool\/multipart\/([A-Za-z0-9._-]+)\/complete$/)) && method === "POST") {
    const key = url.searchParams.get("key") ?? "";
    return (await authorize(request, env, "pool:write")) ?? handleMultipartComplete(key, m[1], request, env);
  }
  if (path === "/packages" && method === "POST") {
    return (await authorize(request, env, "pool:write")) ?? handlePostPackage(url, request, env);
  }
  if (path === "/packages/known" && method === "POST") {
    return handleKnownPackages(request, env);
  }
  if ((m = path.match(/^\/packages\/([0-9a-f]{64})$/)) && method === "GET") {
    return handleGetPackage(m[1], env);
  }
  if ((m = path.match(/^\/packages\/([0-9a-f]{64})\/provenance$/)) && method === "GET") {
    return handleProvenance(m[1], env);
  }
  if (path === "/releases" && method === "POST") {
    return (await authorizeRelease(request, env)) ?? handleCreateRelease(request, env);
  }
  if ((m = path.match(/^\/releases\/([a-z]+)$/)) && method === "GET") {
    return handleGetRelease(m[1], url, env);
  }
  if ((m = path.match(/^\/releases\/([a-z]+)\/history$/)) && method === "GET") {
    return handleReleaseHistory(m[1], env);
  }
  if ((m = path.match(/^\/releases\/([a-z]+)\/diff$/)) && method === "GET") {
    return handleReleaseDiff(m[1], url, env);
  }
  if ((m = path.match(/^\/releases\/(\d+)\/artifacts\/(db|db\.sig|files|files\.sig)$/)) && method === "PUT") {
    return (await authorizeArtifacts(request, env, Number(m[1]))) ?? handlePutArtifact(Number(m[1]), m[2], url, request, env);
  }
  return json({ error: "not found" }, 404);
}

/** Nobody at a door the dashboard greys: the refusal is the predicate's own first word (SIGN_IN — the title of every grey control for nobody signed in), the way in for a script beside it. */
function nobody(): Response {
  return json({ error: SIGN_IN, hint: "a contributor token (POST /factory/register with a GitHub token) as Authorization: Bearer, or the dashboard's session" }, 401);
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

/** The body as JSON, or the 400 to send: a body that is not JSON is the caller's mistake, refused the way a missing field is — not an internal error, so only the SyntaxError of a malformed body is caught. A route that takes an empty body reads `request.json().catch(() => ({}))` and answers through its field checks. */
export async function readJson<T>(request: Request): Promise<T | Response> {
  try {
    return (await request.json()) as T;
  } catch (err) {
    if (err instanceof SyntaxError) return json({ error: "a JSON body is required" }, 400);
    throw err;
  }
}
