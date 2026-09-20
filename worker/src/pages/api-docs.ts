/**
 * API: the endpoints a script, an agent or omarchy-cli uses, with examples.
 * The reference is rows of routes (READ, FACTORY_READ, WRITE_JOBS and
 * WRITE_PEOPLE below), each route written whole —
 * method and path under /api/v1, the query hints beside it — and rendered
 * into the tables; test/lists.test.ts reads the same rows against the
 * router's own source, so a route the Worker serves without a row here, or
 * a row about a route that is gone, fails by name.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { escapeHtml } from "../html";
import { API_HOST, JOURNAL_KINDS, LATE_AFTER_HOURS, type RunningVersion } from "../meta";
import { BUDGET_CAP_USD, BUDGET_GUARD_USD, BUDGET_WARN_USD, ESTIMATE_CADENCE } from "../cost";
import { JOB_KINDS } from "../jobs";

/** A row of the reference: the routes it documents, who may call them (the people table), what they do. */
interface Row {
  routes: string[];
  who?: string;
  text: string;
  /** A route of the Worker's root, not of /api/v1 (the sign-in's own): left out of the comparison with the router. */
  root?: true;
}

const READ: Row[] = [
  { routes: ["GET /version"], text: "The running release, its commit and when it was deployed." },
  { routes: ["GET /signing-key"], text: "The pool's public signing key (fingerprint, user id, armored) — what <code>pacman-key --add</code> imports." },
  { routes: ["GET /status"], text: "Service check, measured now: index (D1) and pool (R2) reachable, with timings. 503 when one is not. What <em>online</em> in the header means." },
  { routes: ["GET /stats"], text: `Everything the overview shows in one response: rings, coverage (a source's row says <code>late</code> when its last sync is older than the pool's one threshold, ${LATE_AFTER_HOURS} hours), pool totals, chart series, the latest metrics snapshot, recent journal entries, OPR recipes by origin per ring (<code>provenance</code>), <code>any</code> packages stored once per architecture and what that costs (<code>any</code>). Cached 60 s.` },
  { routes: ["GET /pacman.conf?ring=&arch=&with="], text: "The pacman.d include for a ring and an architecture — one section per database the ring serves right now, in the include's order; <code>with=</code> names the optional sources to keep. What <a href=\"/setup\">the setup script</a> writes, and what Get started shows." },
  { routes: ["GET /releases/:ring?fields=summary&arch="], text: "The ring's current release and a light row per package (name, version, arch, filename, sha256, sizes, description). This is what <code>omarchy-cli status</code> reads." },
  { routes: ["GET /releases/:ring?arch=&limit=&after=&release_id="], text: "Full manifests, paged (≤ 1000 per request; above 2000 packages paging is required): <code>page.next</code> names the row the next page starts after — pass it as <code>after=</code> (keyset; <code>offset=</code> still works). Add <code>include=files</code> for file lists. <code>release_id</code> pins a release across pages." },
  { routes: ["GET /releases/:ring/history"], text: "The ring's releases, newest first, with lineage (parent, from) and which one is the head." },
  { routes: ["GET /releases/:ring/diff?from=&to=&arch="], text: "What changed between two releases of the ring: packages added, removed and upgraded (same source, name and architecture, another object; another source taking a name over is its add and the other's removal). <code>to</code> defaults to the head, <code>from</code> to its parent; 410 once GC pruned a side's package list. The dashboard's <code>/diff</code> page and <code>pkg-repo diff</code> read this." },
  { routes: ["GET /packages/:sha256", "GET /packages/:sha256/provenance"], text: "One package object's manifest; its seal — where the object came from and the proof: the upstream and its keyring for an imported one, the chain (builder, audit, approval) and the signed attestation for one the pool built." },
  { routes: ["GET /search?q=&ring=&arch=&limit="], text: "Packages in the ring whose name or description matches (exact and prefix matches first)." },
  { routes: ["GET /package/:name?ring=&arch=", "GET /package/:name/files?ring=&arch="], text: "Everything the package page shows: the version in every ring (<code>ring</code> is the one asked, the lab included; <code>shown_ring</code> the one the object comes from — the same, else the most stable that serves it), the manifest, declared dependencies and loaded sonames resolved to their providers, what depends on it (declared or by loading one of its libraries); the file list separately. For an OPR package, <code>provenance</code>: whether its recipe is Omarchy's own or AUR-synced, the AUR commit tracked, the last commit that touched it (<code>omacom/omarchy-pkgs</code>, read daily). While the cost guard is up, <code>GET /package/:name</code> answers an anonymous machine — no session, no bearer token, a user-agent that is empty, an AI crawler's or not a browser's — with a 503 and <code>retry-after: 3600</code>; a signed-in reader, a bearer token, a browser, a search engine's verified crawler and the pool's own clients (<code>omarchy-cli/</code>, <code>pkg-repo/</code>, <code>omarchy-broker/</code>, <code>pacman/</code>) read on, and <code>/files</code> is never closed." },
  { routes: ["GET /graph?ring=&arch=&targets=a,b"], text: "Dependency closure of the targets within the ring's release: the manifests <code>omarchy-cli check</code> evaluates." },
  { routes: ["GET /security/components"], text: "What the rings' packages embed — Go modules and crates.io crates from the binaries' build information — with the sha256 of every served object that embeds each; what the security job asks OSV about." },
  { routes: ["GET /security?ring=&arch="], text: "Packages in the ring with an open advisory: severity, confidence (exact / name-version / name-only), CVEs, exploited-in-the-wild and EPSS, rings already serving a clean version, how many packages it exposes. <code>GET /package/:name</code> carries the same per package plus what it is exposed through." },
  { routes: ["GET /events?kind=&limit="], text: `The journal, one line per ${JOURNAL_KINDS.filter((k) => k !== "all").join(", ")}; <code>kind=</code> filters to one. The <code>metrics</code> snapshot rides the same table and is a number, not a line.` },
  { routes: ["GET /pool/unreferenced?keep=3"], text: "What retention would delete now." },
  { routes: ["GET /cost"], text: `The month's estimated bill, line by line (D1, R2, Workers), the projection and the guard's state. Estimated ${ESTIMATE_CADENCE}; the lines: warn at US$ ${BUDGET_WARN_USD}, pause at US$ ${BUDGET_GUARD_USD}, cap US$ ${BUDGET_CAP_USD}. <code>guard</code> is the word while it is up: the jobs that write are paused and anonymous machines are shed from <code>GET /package/:name</code> and the package page (503, an hour's <code>retry-after</code>).` },
  { routes: ["GET /robots.txt", "GET /sitemap.xml"], root: true, text: `What a crawler may read, at the root of every name: on the dashboard the landing, the docs and the package pages are open to search engines, the API, the sign-in and the pages that are a reader's own are closed to all, and the AI and research crawlers are closed out by name; on <code>${API_HOST}</code> everything is. Every <code>/api/v1</code> answer and the sign-in carry <code>x-robots-tag: noindex, nofollow</code> as well. The sitemap lists the fixed pages, no package pages, nothing read from the database.` },
];

const FACTORY_READ: Row[] = [
  { routes: ["GET /factory?limit="], text: "Workers the pool has heard from (owner, trust, mode, the agent each reported, current task), the queue (every kind: builds, pool jobs, audits — a task's <code>params</code> and <code>result</code> as JSON, the shapes the brain queues and the jobs post), package requests, counts." },
  { routes: ["GET /factory/packages", "GET /factory/built", "GET /factory/tasks/:id"], text: "The registry of packages people brought (a row says <code>landed</code> once a maintainer approved it or the project published it); what the factory built; one task with its log tail, its approval carrying <code>standing</code>." },
  { routes: ["GET /factory/packages/:name/story"], text: "The factory's view of one package: its registration and the request as the form checks it, every chain with its score, the class it has today, the rings it is in. What the package page and a person's rows draw." },
  { routes: ["GET /factory/review"], text: "Staged community builds waiting for a maintainer, each with links to its evidence (PKGBUILD, log, .PKGINFO, the audit), the second agent's verdict (<code>ok</code> / <code>warn</code> / <code>block</code>, or <em>queued</em> / <em>failed</em>) and <code>can</code>: what you may do on the row — approve, reject, build, withdraw — and, where not, why; <code>standing</code> says an approval stands on the row's chain; <code>waits</code> says the row asks for a maintainer's time now — the same for every caller, the rule the Review page highlights by; <code>waiting</code> and <code>oldest_ms</code> count those rows and the age of the oldest — the one number every tile reads. Not cached: the answer is yours." },
  { routes: ["GET /factory/tasks/:id/can"], text: "The same <code>can</code> for one task: <code>{approve, reject, build, withdraw, why}</code> for whoever asks — every page draws every button and greys the ones you may not press with this reason. Not cached." },
  { routes: ["GET /factory/tasks/:id/artifacts", "GET /factory/tasks/:id/artifacts/<file>"], text: "What a task has in staging (key, size, when), then a staged build's evidence: <code>PKGBUILD</code>, <code>build.log</code>, <code>PKGINFO</code>, <code>audit.md</code>, <code>audit.json</code> are public; the package itself is for maintainers." },
  { routes: ["GET /factory/approvals", "GET /factory/maintainers", "GET /factory/trust", "GET /factory/blocks"], text: "The record: every decision with who signed it, whether it stands (<code>standing</code>: approved, not withdrawn) and, for one that stands, where the package is (<code>rings</code>, or none with <code>publish_status</code> and <code>blocked_at</code> — what the pages word as publishing, publish failed or blocked); the maintainers (from <code>factory/MAINTAINERS.toml</code>, with since when); project-trusted workers; what is blocked now and why." },
  { routes: ["GET /users/:login"], text: "A contributor's or maintainer's public profile: packages, builds, approvals, workers, and the <em>track record</em> (<a href=\"/docs/governance\">Governance</a>)." },
  { routes: ["GET /users/:login/can"], text: "What you may do on that page: <code>{request, register, token, build, dequeue, remove, revoke, withdraw, own_only, share_worker, why, packages, workers}</code> — the page draws every control for everyone and greys the ones you may not press with the reason in <code>why</code>; <code>packages</code> answers Remove per registration, <code>workers</code> Revoke and the mode per worker (a revoked one, a project's). Not cached: the answer is yours." },
  { routes: ["GET /factory/workers/self"], text: "With a worker token: what that registration is (id, arch, trust, owner, mode) — how the image decides its mode." },
  { routes: ["GET /factory/workers/:id/log"], text: "The worker's own log — the lines between tasks, as it sent them with its claims — for its owner and the maintainers." },
  { routes: ["GET /factory/me"], text: "With a contributor token or the browser session: who you are, your packages, tasks, workers and staging quota." },
];

const WRITE_JOBS: Row[] = [
  { routes: ["POST /factory/claim", "POST /factory/tasks/:id/heartbeat", "POST /factory/tasks/:id/complete", "POST /factory/tasks/:id/fail"], text: "The worker's protocol: claim the next task of its role and architecture (a lease and the per-job token come back), keep the lease alive, hand the result in, or say why not." },
  { routes: ["PUT /pool/:sha256?filename=&arch=", "PUT /pool/:sha256/sig?filename=&arch=", "POST /pool/:sha256/multipart?filename=&arch=", "PUT /pool/multipart/:upload/part/:n?key=", "POST /pool/multipart/:upload/complete?key="], text: "Store a package object (integrity-checked, never overwritten) and its upstream signature; a large archive in parts." },
  { routes: ["POST /pool/:sha256/sign?filename=&arch="], text: "The pool signs a package it built (source <em>factory</em>) with its own key; the key never leaves the service." },
  { routes: ["POST /packages?source=&arch=", "POST /packages/known"], text: "Index a manifest; ask which sha256s are already indexed." },
  { routes: ["POST /releases"], text: "Create, promote or roll back a release (an index write). An added package replaces its own source's build of that name; another source's stays (the include's order decides between them). <code>remove</code> drops a name from every source, <code>remove_from</code> (<code>{source, name}</code>) from one; <code>arch</code> moves one architecture only while the other keeps what the ring serves. The lab (<code>ring=lab</code>) takes any object and is never promoted from or into." },
  { routes: ["PUT /releases/:id/artifacts/:kind?repo=&arch="], text: "Publish a rendered database beside the packages (<code>db</code>, <code>db.sig</code>, <code>files</code>, <code>files.sig</code>); the pool signs it as it stores it." },
  { routes: ["PUT /security/advisories", "PUT /security/matches", "POST /security/prune"], text: "The security job's writes: the advisories it read from the feeds, what they match in the rings (a row that did not change is not written), and the prune of what the run did not post — its body is the run's advisory ids and (sha256, advisory) matches; without them it is refused." },
  { routes: ["POST /events", "POST /pool/gc", "POST /pool/relayout"], text: "Record a journal entry — the project's jobs and maintainers only, a community build's token carries no <code>events</code> scope, and a run link must be https, a release an id; run retention; one step of the one-time move to one directory per source (the <code>relayout</code> job)." },
  { routes: ["POST /factory/enqueue", "POST /factory/tasks/:id/cancel"], text: "The enqueue job's writes (a maintainer by hand too): queue the project's build of a package for its architectures, cancel a task." },
  { routes: ["PUT /factory/tasks/:id/artifacts/<file>", "POST /factory/tasks/:id/artifacts/<file>/multipart"], text: "A community build's token uploads its evidence to its own staging workspace, a large file in parts; an audit's token adds <code>audit.json</code> / <code>audit.md</code> to a staged build, and nothing else." },
];

const WRITE_PEOPLE: Row[] = [
  { routes: ["POST /factory/register", "POST /factory/token"], who: "contributor", text: "A GitHub token, used once to read your login and never stored, answers a contributor token (<code>omc_…</code>); signed in on the dashboard, mint or replace the same token from your page." },
  { routes: ["POST /factory/packages", "POST /factory/packages/:name/build", "DELETE /factory/packages/:name/builds/:id", "DELETE /factory/packages/:name", "DELETE /factory/tasks/:id/artifacts"], who: "contributor", text: "Request a package (the project's URL, a description, the licence, the checklist — written once to the record), ask for a build, take a queued build out, remove the request, or drop a finished task's staging objects (the 5 GB quota; the pool reclaims superseded, rejected and published builds itself)." },
  { routes: ["POST /factory/workers", "DELETE /factory/workers/:id", "POST /factory/workers/:id/mode", "POST /factory/workers/self/mode"], who: "contributor", text: "Register a worker (the token is shown once), revoke it, set whether it builds everyone's queue or its owner's packages only — from the page, or the worker itself through its token (<code>omarchy-worker share on|off</code>)." },
  { routes: ["POST /factory/tasks/:id/build", "POST /factory/tasks/:id/approve", "POST /factory/tasks/:id/reject", "POST /factory/tasks/:id/withdraw"], who: "maintainer", text: "Have the project build a contributor's staged package again (its agent, a trusted worker, its own recipe); approve the project's build into edge — the decision on the record, a publish job; send either back with a note; or take a standing approval back, the reason on the record. Never your own package — a withdrawal excepted: undoing is not deciding. A refusal answers the reason <code>can</code> gives." },
  { routes: ["POST /factory/packages/:name/category"], who: "maintainer", text: "Settle the package's category (<a href=\"/docs/governance#categories\">one of the list</a>) — at review or any time after; a <code>category</code> line in the journal says who and from what." },
  { routes: ["POST /factory/jobs"], who: "maintainer", text: `Queue a pool job by hand (${JOB_KINDS.join(", ")}) — what <code>pkg-repo job</code> calls.` },
  { routes: ["POST /factory/workers/:id/trust"], who: "maintainer", text: "Project trust on two maintainers' word: the first call proposes (<code>202</code>), a second maintainer's — never the same person's; the owner's counts as the second word, never the first — confirms; <code>{\"trust\":\"community\"}</code> takes it back at one word. Each step an event; the trust a signed record under <code>workers/&lt;id&gt;/</code>." },
  { routes: ["POST /factory/record/withdraw"], who: "maintainer", text: "<code>{key, reason}</code> — a record taken off the public bucket (a log that carried what it should not have); its signature and staging copy go with it, and a signed <code>&lt;key&gt;.tombstone.json</code> says who, why and what was there." },
  { routes: ["POST /factory/contributors/:login/block", "POST /factory/contributors/:login/unblock", "POST /factory/packages/:name/block", "POST /factory/packages/:name/unblock"], who: "maintainer", text: "The brake, with a reason on the record: a blocked contributor gets nothing more in (workers revoked, tasks cancelled, packages out of the rings, their projects closed to new accounts); a blocked package leaves every ring. Lifting is by another maintainer." },
  { routes: ["GET /auth/github", "GET /auth/me", "GET /auth/logout"], who: "anyone", root: true, text: "Sign in with GitHub (a session cookie for the dashboard); who is signed in; sign out — the session stops working on the server, the CLI token is untouched." },
];

/** Every route the reference documents under /api/v1, as "METHOD /path" with the query hint dropped — what the test holds against the router. */
export const DOCUMENTED_ROUTES: string[] = [...READ, ...FACTORY_READ, ...WRITE_JOBS, ...WRITE_PEOPLE].filter((r) => !r.root).flatMap((r) => r.routes.map((x) => x.replace(/\?.*$/, "")));

/** A route's cell: every route whole, in a code each. */
const cell = (routes: string[]) => routes.map((r) => `<code>${escapeHtml(r)}</code>`).join(" · ");
const rows = (list: Row[]) => list.map((r) => `      <tr><td>${cell(r.routes)}</td>${r.who ? `<td>${r.who}</td>` : ""}<td>${r.text}</td></tr>`).join("\n");

/** The page's HTML. The API's address is meta's one name for it; the pool's is the deployment's (POOL_URL), so the examples name what this deployment serves. */
const body = (pool: string) => String.raw`
  <h1>API</h1>
  <p class="lede">Everything this site shows comes from a small JSON API at <code>https://${API_HOST}/api/v1</code>. Reads need no authentication and allow cross-origin requests; writes need the per-job token a worker gets when it claims a task — there is no shared secret — or, on the factory's own routes, a maintainer's token.</p>

  <section id="read">
    <h2>Read</h2>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it returns</th></tr></thead><tbody>
${rows(READ)}
    </tbody></table></div>
  </section>

  <section id="factory">
    <h2>The factory (read)</h2>
    <p class="sub">What the factory's pages — Factory, Pipeline, Workers, People, Review, a person's — show. Public, cached briefly.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it returns</th></tr></thead><tbody>
${rows(FACTORY_READ)}
    </tbody></table></div>
  </section>
  <section id="examples">
    <h2>Examples</h2>
    <div class="steps">
      <div class="step"><h3>Which version of a package does each ring serve?</h3>
<pre>for ring in edge rc stable; do
  curl -s "https://${API_HOST}/api/v1/releases/$ring?fields=summary&amp;arch=x86_64" \
    | jq -r --arg r "$ring" '.packages[] | select(.name == "openssl") | "\($r)\t\(.version)"'
done</pre></div>
      <div class="step"><h3>What changed in stable today?</h3>
<pre>curl -s https://${API_HOST}/api/v1/events?kind=promote | jq '.events[0]'
curl -s https://${API_HOST}/api/v1/releases/stable/history | jq '.releases[0:3]'</pre></div>
      <div class="step"><h3>Is the pool healthy right now?</h3>
<pre>curl -s https://${API_HOST}/api/v1/stats \
  | jq '[.latest[] | select(.kind == "health") | {ring, arch: .source, status, at: .created_at}]'</pre></div>
      <div class="step"><h3>The static side (what pacman reads)</h3>
<pre>curl -sI ${pool}/core/x86_64/omarchy-core-stable.db | head -3
curl -s  ${pool}/core/x86_64/omarchy-core-stable.db | tar -tz | head</pre></div>
    </div>
  </section>

  <section id="write-jobs">
    <h2>Write (jobs only)</h2>
    <p class="sub">Bearer <code>omj.…</code>: the per-job token issued at <code>POST /factory/claim</code>, scoped to what that task needs (<code>pool:write</code>, <code>release:&lt;ring&gt;</code>, <code>artifacts:*:&lt;ring&gt;</code>, <code>security:write</code>, <code>gc</code>, <code>events</code>) and valid for its lease. Used by <code>pkg-repo work</code>; documented in <a href="/docs/security-model">the security model</a>. A maintainer queues one of these jobs by hand with <code>POST /factory/jobs</code>.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it does</th></tr></thead><tbody>
${rows(WRITE_JOBS)}
    </tbody></table></div>
  </section>

  <section id="write-people">
    <h2>Write (people)</h2>
    <p class="sub">Bearer <code>omc_…</code> (a contributor token from your profile) or the browser session after <em>Sign in with GitHub</em>. Nothing here touches the pool directly: maintainers queue jobs and approve builds; workers do the work with per-job tokens.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Who</th><th>What it does</th></tr></thead><tbody>
${rows(WRITE_PEOPLE)}
    </tbody></table></div>
  </section>
`;

export function apiDocsHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/api",
    title: "API · omarchy-pool",
    description: "The omarchy-pool JSON API: rings, releases, packages, dependency graph, journal.",
    active: "docs",
    doc: "api",
    body: body(poolUrl.replace(/\/$/, "")),
    poolUrl,
    version,
  });
}

/**
 * What /api is made of.
 * The page is a reference: its tables are rows of claims about routes, so
 * each table's entry reads or acts through every endpoint its rows name,
 * on the fixture — a row about a route that is gone, or that answers
 * another shape, fails here by the table's name. A row's anchor is its
 * endpoint's code, not the hint text beside it. The write tables act with
 * the roles the rows refuse, with a body the handler stops at the door, or
 * on a row the fixture has already decided, so the fixture leaves this page
 * as it came; what a decision does is the Review page's and the person's
 * page's to prove.
 */
export const API_DOCS_COMPONENTS = (F: Fixture): Component[] => {
  const stable = `ring=stable&arch=${F.arch}`;
  const noSession = { anonymous: 401, contributor: 401, maintainer: 401 } as const;
  const stagedPackage = `${F.factoryPkg}-1.0-1-${F.arch}.pkg.tar.zst`;
  return [
    {
      id: "api.hero",
      page: "/api",
      anchor: ["<h1>API</h1>", '<p class="lede">Everything this site shows comes from a small JSON API'],
      visible: EVERYONE,
    },
    {
      id: "api.docs-search",
      page: "/api",
      anchor: ['id="docs-q"', 'id="docs-hits"'],
      script: ['$("#docs-q")', '$("#docs-hits")', '$("#docs-nav")', 'class="hit"'],
      visible: EVERYONE,
    },
    {
      id: "api.docs-chapters",
      page: "/api",
      anchor: [
        'id="docs-nav"',
        '<details open><summary><a href="/api" class="on">API</a><small>5</small></summary>',
        'href="/api#read"', 'href="/api#factory"', 'href="/api#examples"', 'href="/api#write-jobs"', 'href="/api#write-people"',
      ],
      visible: EVERYONE,
    },
    {
      id: "api.read-table",
      page: "/api",
      // Every row's cell, as rendered from READ: a row dropped from the served table fails by its routes.
      anchor: ['id="read"', ...READ.map((r) => cell(r.routes))],
      reads: [
        { path: "/api/v1/version", fields: ["version", "commit", "deployed_at", "release_url", "commit_url"] },
        { path: `/api/v1/pacman.conf?ring=stable&arch=${F.arch}`, json: false },
        { path: "/api/v1/signing-key", fields: ["fingerprint", "user", "armored"] },
        { path: "/api/v1/status", fields: ["ok", "state", "api.ok", "index.ok", "index.ms", "pool.ok", "pool.ms", "signing", "checked_at"] },
        {
          path: "/api/v1/stats",
          fields: ["rings", "rings.0.ring", "rings.0.release", "coverage", "coverage.0.late", "pool.objects", "pool.bytes", "series.imports_daily", "series.health", "metrics", "events", "latest", "provenance", "any"],
        },
        {
          path: `/api/v1/releases/stable?fields=summary&arch=${F.arch}`,
          fields: ["release.id", "release.ring", "packages", "packages.0.name", "packages.0.version", "packages.0.arch", "packages.0.filename", "packages.0.sha256", "packages.0.size_download", "packages.0.size_installed", "packages.0.description"],
        },
        { path: `/api/v1/releases/stable?arch=${F.arch}&limit=1&release_id=${F.release}`, fields: ["release.id", "page.limit", "page.returned", "page.total", "page.next", "packages", "packages.0.name"] },
        { path: `/api/v1/releases/stable?arch=${F.arch}&limit=1&after=${F.pkg2}/${F.arch}/core`, fields: ["page.after", "packages", "packages.0.name"] },
        { path: "/api/v1/releases/stable/history", fields: ["ring", "releases", "releases.0.id", "releases.0.seq", "releases.0.parent_id", "releases.0.source_id", "releases.0.is_head"] },
        { path: `/api/v1/releases/stable/diff?arch=${F.arch}`, fields: ["ring", "from", "to.id", "counts.added", "counts.removed", "counts.upgraded", "added", "removed", "upgraded"] },
        { path: `/api/v1/packages/${F.sha}`, fields: ["name", "version", "arch", "sha256", "filename", "size_download", "size_installed", "provides", "requires"] },
        { path: `/api/v1/packages/${F.sha}/provenance`, fields: ["sha256", "name", "source", "object", "origin", "seal", "summary", "upstream.project", "upstream.keyring", "signature", "chain", "attestation"] },
        { path: `/api/v1/search?q=${F.pkg}&${stable}&limit=10`, fields: ["ring", "arch", "release_id", "query", "packages", "packages.0.name", "packages.0.version", "packages.0.description"] },
        {
          path: `/api/v1/package/${F.pkg}?${stable}`,
          fields: ["name", "ring", "shown_ring", "rings", "package.version", "package.sha256", "manifest", "depends", "links", "required_by", "security.advisories", "security.exposed", "provenance", "pool_url"],
        },
        { path: `/api/v1/package/${F.pkg}/files?${stable}`, fields: ["name", "ring", "arch", "files"] },
        { path: `/api/v1/graph?${stable}&targets=${F.pkg2}`, fields: ["ring", "arch", "release_id", "source_order", "packages", "packages.0.name", "missing_targets", "truncated"] },
        { path: "/api/v1/security/components", fields: ["components"] },
        {
          path: `/api/v1/security?${stable}`,
          fields: [
            "ring", "arch", "totals.packages", "totals.exposed", "totals.kev", "vulnerable", "vulnerable.0.name", "vulnerable.0.worst", "vulnerable.0.kev", "vulnerable.0.epss",
            "vulnerable.0.fixed_in", "vulnerable.0.exposure", "vulnerable.0.advisories.0.cves", "vulnerable.0.advisories.0.match",
          ],
        },
        { path: "/api/v1/events?kind=promote&limit=12", fields: ["events", "events.0.id", "events.0.kind", "events.0.ring", "events.0.source", "events.0.status", "events.0.summary", "events.0.payload", "events.0.created_at"] },
        { path: "/api/v1/pool/unreferenced?keep=3", fields: ["keep", "grace_days", "protected_releases", "kept_checkpoints", "count", "bytes", "packages"] },
        { path: "/api/v1/cost", fields: ["estimated_at", "status", "month", "month_to_date_usd", "projected_usd", "guard", "lines_usd.warn", "lines_usd.guard", "lines_usd.cap"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "api.factory-read-table",
      page: "/api",
      anchor: ['id="factory"', ...FACTORY_READ.map((r) => cell(r.routes))],
      reads: [
        {
          path: "/api/v1/factory?limit=10",
          fields: ["generated_at", "lease_minutes", "limit", "counts", "workers", "workers.0.id", "workers.0.owner", "workers.0.trust", "workers.0.mode", "workers.0.agent", "workers.0.current_task", "tasks", "tasks.0.id", "tasks.0.kind", "tasks.0.status"],
        },
        { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.name", "packages.0.owner", "packages.0.status", "packages.0.arches", "packages.0.staged_builds"] },
        { path: "/api/v1/factory/built", fields: ["built", "built.0.name", "built.0.arch", "built.0.version", "built.0.status", "built.0.id"] },
        {
          path: `/api/v1/factory/tasks/${F.projectTask}`,
          fields: ["task.id", "task.kind", "task.status", "task.name", "task.log_tail", "worker", "from", "audit", "trial", "publish", "approval", "chain", "score", "package", "evidence", "evidence.0.name", "evidence.0.url", "evidence.0.public"],
        },
        {
          path: "/api/v1/factory/review",
          fields: ["staged", "waiting", "oldest_ms", "staged.0.id", "staged.0.kind", "staged.0.owner", "staged.0.waits", "staged.0.evidence.pkgbuild", "staged.0.evidence.log", "staged.0.evidence.pkginfo", "staged.0.evidence.audit", "staged.0.vet", "staged.0.audit.status", "staged.0.trial", "staged.0.can.approve", "staged.0.can.reject", "staged.0.can.build", "staged.0.can.withdraw", "staged.0.can.why"],
        },
        { path: `/api/v1/factory/tasks/${F.stagedTask}/can`, fields: ["task", "can.approve", "can.reject", "can.build", "can.withdraw", "can.why.approve"] },
        { path: `/api/v1/factory/tasks/${F.stagedTask}/can`, as: "maintainer", fields: ["task", "can.approve", "can.reject", "can.build", "can.withdraw", "can.why.approve"] },
        { path: `/api/v1/factory/packages/${F.factoryPkg}/story`, fields: ["package", "package.name", "request", "chains", "rings"] },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts`, fields: ["task", "objects", "objects.0.key", "objects.0.size", "objects.0.uploaded_at"] },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/PKGBUILD`, json: false },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/${stagedPackage}`, status: 403 },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/${stagedPackage}`, as: "maintainer", json: false },
        { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.id", "approvals.0.task_id", "approvals.0.name", "approvals.0.decision", "approvals.0.by", "approvals.0.standing", "approvals.0.rings", "approvals.0.publish_status", "approvals.0.blocked_at"] },
        { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login", "maintainers.0.since", "source", "synced_at"] },
        { path: "/api/v1/factory/trust", fields: ["workers", "workers.0.id", "workers.0.trust", "workers.0.trusted_by", "maintainers", "listed", "source"] },
        { path: "/api/v1/factory/blocks", fields: ["contributors", "packages"] },
        {
          path: `/api/v1/users/${F.owner}`,
          fields: ["login", "role", "github", "packages", "packages.0.name", "builds", "builds.0.id", "build_counts.total", "approvals", "approved_packages", "record", "workers", "workers.0.id"],
        },
        { path: `/api/v1/users/${F.owner}/can`, fields: ["login", "can.request", "can.register", "can.token", "can.build", "can.dequeue", "can.remove", "can.revoke", "can.withdraw", "can.own_only", "can.share_worker", "can.why.request", `can.packages.${F.factoryPkg}.remove`, `can.workers.${F.communityWorker}.revoke`] },
        { path: `/api/v1/users/${F.owner}/can`, as: "owner", fields: ["login", "can.build", "can.remove", "can.why.withdraw", `can.packages.${F.factoryPkg}.remove`, `can.packages.${F.factoryPkg}.why`] },
        { path: `/api/v1/users/${F.owner}/can`, as: "maintainer", fields: ["login", "can.revoke", "can.withdraw", "can.why.build", `can.packages.${F.factoryPkg}.remove`] },
        { path: "/api/v1/factory/workers/self", status: 401 },
        { path: "/api/v1/factory/workers/self", as: "maintainer", status: 401 },
        { path: `/api/v1/factory/workers/${F.worker}/log`, status: 401 },
        { path: `/api/v1/factory/workers/${F.worker}/log`, as: "contributor", status: 403 },
        { path: `/api/v1/factory/workers/${F.worker}/log`, as: "maintainer", fields: ["id", "log", "at"] },
        { path: "/api/v1/factory/me", status: 401 },
        { path: "/api/v1/factory/me", as: "owner", fields: ["contributor.login", "packages", "packages.0.name", "workers", "workers.0.id", "tasks", "tasks.0.id", "staging.bytes", "staging.quota_bytes"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "api.examples",
      page: "/api",
      anchor: [
        'id="examples"',
        "<h3>Which version of a package does each ring serve?</h3>", "<h3>What changed in stable today?</h3>", "<h3>Is the pool healthy right now?</h3>", "<h3>The static side (what pacman reads)</h3>",
      ],
      reads: [
        { path: `/api/v1/releases/stable?fields=summary&arch=${F.arch}`, fields: ["packages.0.name", "packages.0.version"] },
        { path: "/api/v1/events?kind=promote", fields: ["events.0"] },
        { path: "/api/v1/releases/stable/history", fields: ["releases.0"] },
        { path: "/api/v1/stats", fields: ["latest", "latest.0.kind", "latest.0.ring", "latest.0.source", "latest.0.status", "latest.0.created_at"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "api.write-jobs-table",
      page: "/api",
      anchor: ['id="write-jobs"', "<code>POST /factory/claim</code>", ...WRITE_JOBS.map((r) => cell(r.routes))],
      acts: [
        { method: "POST", path: "/api/v1/factory/claim", expect: noSession },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/heartbeat`, expect: noSession },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/complete`, expect: noSession },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/fail`, expect: noSession },
        { method: "PUT", path: "/api/v1/pool/multipart/upload/part/1?key=x", expect: noSession },
        { method: "POST", path: "/api/v1/pool/multipart/upload/complete?key=x", expect: noSession },
        { method: "PUT", path: "/api/v1/security/advisories", expect: noSession },
        { method: "PUT", path: "/api/v1/security/matches", expect: noSession },
        { method: "POST", path: "/api/v1/security/prune", expect: noSession },
        { method: "POST", path: "/api/v1/factory/enqueue", expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/cancel`, expect: { anonymous: 401, contributor: 403 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/artifacts/build.log/multipart`, expect: noSession },
        { method: "PUT", path: `/api/v1/pool/${F.sha}`, expect: noSession },
        { method: "PUT", path: `/api/v1/pool/${F.sha}/sig`, expect: noSession },
        { method: "POST", path: `/api/v1/pool/${F.sha}/multipart`, expect: noSession },
        { method: "POST", path: `/api/v1/pool/${F.sha}/sign`, expect: noSession },
        { method: "POST", path: "/api/v1/packages", expect: noSession },
        { method: "POST", path: "/api/v1/releases", body: { ring: "stable" }, expect: noSession },
        { method: "PUT", path: `/api/v1/releases/${F.release}/artifacts/db`, expect: noSession },
        { method: "POST", path: "/api/v1/events", expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: "/api/v1/pool/gc", expect: noSession },
        { method: "POST", path: "/api/v1/pool/relayout", expect: noSession },
        { method: "PUT", path: `/api/v1/factory/tasks/${F.stagedTask}/artifacts/build.log`, expect: noSession },
      ],
      visible: EVERYONE,
    },
    {
      id: "api.write-people-table",
      page: "/api",
      anchor: ['id="write-people"', ...WRITE_PEOPLE.map((r) => cell(r.routes))],
      reads: [
        { path: "/auth/github?next=/api", status: 302, json: false },
        { path: "/auth/me", status: 401 },
        { path: "/auth/me", as: "contributor", fields: ["login", "name", "avatar_url", "role"] },
        { path: "/auth/logout", status: 302, json: false },
      ],
      acts: [
        { method: "POST", path: "/api/v1/factory/register", expect: { anonymous: 400, contributor: 400 } },
        { method: "POST", path: "/api/v1/factory/packages", expect: { anonymous: 401, contributor: 400 } },
        { method: "DELETE", path: `/api/v1/factory/packages/${F.factoryPkg}/builds/${F.stagedTask}`, expect: { anonymous: 401, contributor: 403 } },
        // A stranger is refused either way: not his while the worker stands (403), the row's own word once the person's page's manifest, run before this one, has revoked it (404).
        { method: "POST", path: `/api/v1/factory/workers/${F.communityWorker}/mode`, body: { mode: "shared" }, expect: { anonymous: 401, contributor: [403, 404] } },
        { method: "POST", path: "/api/v1/factory/workers/self/mode", body: { mode: "shared" }, expect: { anonymous: 401, contributor: 401 } },
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/category`, body: { category: "other" }, expect: { anonymous: 401, contributor: 403 } },
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/build`, expect: { anonymous: 401, contributor: 404 } },
        { method: "DELETE", path: `/api/v1/factory/packages/${F.factoryPkg}`, expect: { anonymous: 401, contributor: 403 } },
        { method: "DELETE", path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts`, expect: { anonymous: 401, contributor: 403 } },
        { method: "POST", path: "/api/v1/factory/workers", expect: { anonymous: 401, contributor: 400 } },
        { method: "DELETE", path: `/api/v1/factory/workers/${F.communityWorker}`, expect: { anonymous: 401, contributor: 404 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/build`, expect: { anonymous: 401, contributor: 403, owner: 403 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.projectTask}/approve`, body: { note: "reads well" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/reject`, body: { note: "the source is not the upstream's" }, expect: { anonymous: 401, contributor: 403, owner: 403 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/withdraw`, body: { note: "nothing stands on this one" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 404 } },
        { method: "POST", path: "/api/v1/factory/jobs", expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/workers/${F.worker}/trust`, body: { trust: "project" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } },
        { method: "POST", path: "/api/v1/factory/record/withdraw", expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/contributors/${F.contributor}/block`, expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/contributors/${F.contributor}/unblock`, expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/block`, expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/unblock`, expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
      ],
      visible: EVERYONE,
    },
  ];
};
