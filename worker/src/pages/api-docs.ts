/**
 * API: the endpoints a script, an agent or omarchy-cli uses, with examples.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <h1>API</h1>
  <p class="lede">Everything this site shows comes from a small JSON API at <code>https://pkgs.firemanxbr.org/api/v1</code>. Reads need no authentication and allow cross-origin requests; writes need the per-job token a worker gets when it claims a task — there is no shared secret — or, on the factory's own routes, a maintainer's token.</p>

  <section id="read">
    <h2>Read</h2>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it returns</th></tr></thead><tbody>
      <tr><td><code>GET /version</code></td><td>The running release, its commit and when it was deployed.</td></tr>
      <tr><td><code>GET /signing-key</code></td><td>The pool's public signing key (fingerprint, user id, armored) — what <code>pacman-key --add</code> imports.</td></tr>
      <tr><td><code>GET /status</code></td><td>Service check, measured now: index (D1) and pool (R2) reachable, with timings. 503 when one is not. What <em>online</em> in the header means.</td></tr>
      <tr><td><code>GET /stats</code></td><td>Everything the overview shows in one response: rings, coverage, pool totals, chart series, the latest metrics snapshot, recent journal entries, OPR recipes by origin per ring (<code>provenance</code>), <code>any</code> packages stored once per architecture and what that costs (<code>any</code>). Cached 30 s.</td></tr>
      <tr><td><code>GET /releases/:ring?fields=summary&amp;arch=</code></td><td>The ring's current release and a light row per package (name, version, arch, filename, sha256, sizes, description). This is what <code>omarchy-cli status</code> reads.</td></tr>
      <tr><td><code>GET /releases/:ring?arch=&amp;limit=&amp;after=&amp;release_id=</code></td><td>Full manifests, paged (≤ 1000 per request; above 2000 packages paging is required): <code>page.next</code> names the row the next page starts after — pass it as <code>after=</code> (keyset; <code>offset=</code> still works). Add <code>include=files</code> for file lists. <code>release_id</code> pins a release across pages.</td></tr>
      <tr><td><code>GET /releases/:ring/history</code></td><td>The ring's releases, newest first, with lineage (parent, from) and which one is the head.</td></tr>
      <tr><td><code>GET /releases/:ring/diff?from=&amp;to=&amp;arch=</code></td><td>What changed between two releases of the ring: packages added, removed and upgraded (same source, name and architecture, another object; another source taking a name over is its add and the other's removal). <code>to</code> defaults to the head, <code>from</code> to its parent; 410 once GC pruned a side's package list. The dashboard's <code>/diff</code> page and <code>pkg-repo diff</code> read this.</td></tr>
      <tr><td><code>GET /packages/:sha256</code></td><td>One package object's manifest.</td></tr>
      <tr><td><code>GET /search?q=&amp;ring=&amp;arch=&amp;limit=</code></td><td>Packages in the ring whose name or description matches (exact and prefix matches first).</td></tr>
      <tr><td><code>GET /package/:name?ring=&amp;arch=</code> · <code>/files</code></td><td>Everything the package page shows: the version in every ring, the manifest, declared dependencies and loaded sonames resolved to their providers, what depends on it (declared or by loading one of its libraries); the file list separately. For an OPR package, <code>provenance</code>: whether its recipe is Omarchy's own or AUR-synced, the AUR commit tracked, the last commit that touched it (<code>omacom/omarchy-pkgs</code>, read daily).</td></tr>
      <tr><td><code>GET /graph?ring=&amp;arch=&amp;targets=a,b</code></td><td>Dependency closure of the targets within the ring's release: the manifests <code>omarchy-cli check</code> evaluates.</td></tr>
      <tr><td><code>GET /security/components</code></td><td>What the rings' packages embed — Go modules and crates.io crates from the binaries' build information — with the sha256 of every served object that embeds each; what the security job asks OSV about.</td></tr>
      <tr><td><code>GET /security?ring=&amp;arch=</code></td><td>Packages in the ring with an open advisory: severity, confidence (exact / name-version / name-only), CVEs, exploited-in-the-wild and EPSS, rings already serving a clean version, how many packages it exposes. <code>GET /package/:name</code> carries the same per package plus what it is exposed through.</td></tr>
      <tr><td><code>GET /events?kind=&amp;limit=</code></td><td>The journal: sync, gate, promote, render, health, abi, rollback, deploy, gc, metrics.</td></tr>
      <tr><td><code>GET /pool/unreferenced?keep=3</code></td><td>What retention would delete now.</td></tr>
      <tr><td><code>GET /cost</code></td><td>The month's estimated bill, line by line (D1, R2, Workers), the projection and the guard's state. Estimated every three hours; the lines: warn at US$ 25, pause at US$ 40, cap US$ 50.</td></tr>
    </tbody></table></div>
  </section>

  <section id="factory">
    <h2>The factory (read)</h2>
    <p class="sub">What the Factory, Contributors, Review and profile pages show. Public, cached briefly.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it returns</th></tr></thead><tbody>
      <tr><td><code>GET /factory?limit=</code></td><td>Workers the pool has heard from (owner, trust, mode, the agent each reported, current task), the queue (every kind: builds, pool jobs, audits), package requests, counts.</td></tr>
      <tr><td><code>GET /factory/packages</code> · <code>/built</code> · <code>/tasks/:id</code></td><td>The registry of packages people brought; what the factory built; one task with its log tail.</td></tr>
      <tr><td><code>GET /factory/review</code></td><td>Staged community builds waiting for a maintainer, each with links to its evidence (PKGBUILD, log, .PKGINFO, the audit), the second agent's verdict (<code>ok</code> / <code>warn</code> / <code>block</code>, or <em>queued</em> / <em>failed</em>) and <code>can</code>: what you may do on the row — approve, reject, build, withdraw — and, where not, why. Not cached: the answer is yours.</td></tr>
      <tr><td><code>GET /factory/tasks/:id/can</code></td><td>The same <code>can</code> for one task: <code>{approve, reject, build, withdraw, why}</code> for whoever asks — every page draws every button and greys the ones you may not press with this reason. Not cached.</td></tr>
      <tr><td><code>GET /factory/tasks/:id/artifacts/&lt;file&gt;</code></td><td>A staged build's evidence: <code>PKGBUILD</code>, <code>build.log</code>, <code>PKGINFO</code>, <code>audit.md</code>, <code>audit.json</code> are public; the package itself is for maintainers.</td></tr>
      <tr><td><code>GET /factory/approvals</code> · <code>/maintainers</code> · <code>/trust</code> · <code>/blocks</code></td><td>The record: every decision with who signed it; the maintainers (from <code>factory/MAINTAINERS.toml</code>, with since when); project-trusted workers; what is blocked now and why.</td></tr>
      <tr><td><code>GET /users/:login</code></td><td>A contributor's or maintainer's public profile: packages, builds, approvals, workers, and the <em>track record</em> (<a href="/docs/governance">Governance</a>).</td></tr>
      <tr><td><code>GET /factory/workers/self</code></td><td>With a worker token: what that registration is (id, arch, trust, owner, mode) — how the image decides its mode.</td></tr>
      <tr><td><code>GET /factory/me</code></td><td>With a contributor token or the browser session: who you are, your packages, tasks, workers and staging quota.</td></tr>
    </tbody></table></div>
  </section>

  <section id="examples">
    <h2>Examples</h2>
    <div class="steps">
      <div class="step"><h3>Which version of a package does each ring serve?</h3>
<pre>for ring in edge rc stable; do
  curl -s "https://pkgs.firemanxbr.org/api/v1/releases/$ring?fields=summary&amp;arch=x86_64" \
    | jq -r --arg r "$ring" '.packages[] | select(.name == "openssl") | "\($r)\t\(.version)"'
done</pre></div>
      <div class="step"><h3>What changed in stable today?</h3>
<pre>curl -s https://pkgs.firemanxbr.org/api/v1/events?kind=promote | jq '.events[0]'
curl -s https://pkgs.firemanxbr.org/api/v1/releases/stable/history | jq '.releases[0:3]'</pre></div>
      <div class="step"><h3>Is the pool healthy right now?</h3>
<pre>curl -s https://pkgs.firemanxbr.org/api/v1/stats \
  | jq '[.latest[] | select(.kind == "health") | {ring, arch: .source, status, at: .created_at}]'</pre></div>
      <div class="step"><h3>The static side (what pacman reads)</h3>
<pre>curl -sI https://pool.firemanxbr.org/core/x86_64/omarchy-core-stable.db | head -3
curl -s  https://pool.firemanxbr.org/core/x86_64/omarchy-core-stable.db | tar -tz | head</pre></div>
    </div>
  </section>

  <section id="write-jobs">
    <h2>Write (jobs only)</h2>
    <p class="sub">Bearer <code>omj.…</code>: the per-job token issued at <code>POST /factory/claim</code>, scoped to what that task needs (<code>pool:write</code>, <code>release:&lt;ring&gt;</code>, <code>artifacts:*:&lt;ring&gt;</code>, <code>security:write</code>, <code>gc</code>, <code>events</code>) and valid for its lease. Used by <code>pkg-repo work</code>; documented in <a href="/docs/security-model">the security model</a>. A maintainer queues one of these jobs by hand with <code>POST /factory/jobs</code>.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it does</th></tr></thead><tbody>
      <tr><td><code>PUT /pool/:sha256?filename=&amp;arch=</code> · <code>/sig</code> · <code>/multipart</code></td><td>Store a package object (integrity-checked, never overwritten) and its upstream signature.</td></tr>
      <tr><td><code>POST /pool/:sha256/sign?filename=&amp;arch=</code></td><td>The pool signs a package it built (source <em>factory</em>) with its own key; the key never leaves the service.</td></tr>
      <tr><td><code>POST /packages?source=&amp;arch=</code> · <code>POST /packages/known</code></td><td>Index a manifest; ask which sha256s are already indexed.</td></tr>
      <tr><td><code>POST /releases</code></td><td>Create, promote or roll back a release (an index write). An added package replaces its own source's build of that name; another source's stays (the include's order decides between them). <code>remove</code> drops a name from every source, <code>remove_from</code> (<code>{source, name}</code>) from one; <code>arch</code> moves one architecture only while the other keeps what the ring serves. The lab (<code>ring=lab</code>) takes any object and is never promoted from or into.</td></tr>
      <tr><td><code>PUT /releases/:id/artifacts/:kind?repo=&amp;arch=</code></td><td>Publish a rendered database beside the packages; the pool signs it as it stores it.</td></tr>
      <tr><td><code>POST /events</code> · <code>POST /pool/gc</code> · <code>POST /pool/relayout</code></td><td>Record a journal entry; run retention; one step of the one-time move to one directory per source (the <code>relayout</code> job).</td></tr>
      <tr><td><code>PUT /factory/tasks/:id/artifacts/&lt;file&gt;</code></td><td>A community build's token uploads its evidence to its own staging workspace; an audit's token adds <code>audit.json</code> / <code>audit.md</code> to a staged build, and nothing else.</td></tr>
    </tbody></table></div>
  </section>

  <section id="write-people">
    <h2>Write (people)</h2>
    <p class="sub">Bearer <code>omc_…</code> (a contributor token from your profile) or the browser session after <em>Sign in with GitHub</em>. Nothing here touches the pool directly: maintainers queue jobs and approve builds; workers do the work with per-job tokens.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Who</th><th>What it does</th></tr></thead><tbody>
      <tr><td><code>POST /factory/packages</code> · <code>/packages/:name/build</code> · <code>DELETE /packages/:name</code> · <code>DELETE /factory/tasks/:id/artifacts</code></td><td>contributor</td><td>Request a package (the project's URL, a description, the licence, the checklist — written once to the record), ask for a build, remove the request, or drop a finished task's staging objects (the 5 GB quota; the pool reclaims superseded, rejected and published builds itself).</td></tr>
      <tr><td><code>POST /factory/workers</code> · <code>DELETE /workers/:id</code></td><td>contributor</td><td>Register a worker (the token is shown once), revoke it.</td></tr>
      <tr><td><code>POST /factory/tasks/:id/build</code> · <code>/approve</code> · <code>/reject</code> · <code>/withdraw</code></td><td>maintainer</td><td>Have the project build a contributor's staged package again (its agent, a trusted worker, its own recipe); approve the project's build into edge — the decision on the record, a publish job; send either back with a note; or take a standing approval back, the reason on the record. Never your own package — a withdrawal excepted: undoing is not deciding. A refusal answers the reason <code>can</code> gives.</td></tr>
      <tr><td><code>POST /factory/jobs</code></td><td>maintainer</td><td>Queue a pool job by hand (sync, promote, rollback, render, health, security, gc, enqueue) — what <code>pkg-repo job</code> calls.</td></tr>
      <tr><td><code>POST /factory/workers/:id/trust</code></td><td>maintainer</td><td>Project trust on two maintainers' word: the first call proposes (<code>202</code>), a second maintainer's — never the same person's; the owner's counts as the second word, never the first — confirms; <code>{"trust":"community"}</code> takes it back at one word. Each step an event; the trust a signed record under <code>workers/&lt;id&gt;/</code>.</td></tr>
      <tr><td><code>POST /factory/record/withdraw</code></td><td>maintainer</td><td><code>{key, reason}</code> — a record taken off the public bucket (a log that carried what it should not have); its signature and staging copy go with it, and a signed <code>&lt;key&gt;.tombstone.json</code> says who, why and what was there.</td></tr>
      <tr><td><code>POST /factory/contributors/:login/{block,unblock}</code> · <code>/packages/:name/{block,unblock}</code></td><td>maintainer</td><td>The brake, with a reason on the record: a blocked contributor gets nothing more in (workers revoked, tasks cancelled, packages out of the rings, their projects closed to new accounts); a blocked package leaves every ring. Lifting is by another maintainer.</td></tr>
      <tr><td><code>GET /auth/github</code> · <code>/auth/me</code> · <code>/auth/logout</code></td><td>anyone</td><td>Sign in with GitHub (a session cookie for the dashboard); who is signed in; sign out — the session stops working on the server, the CLI token is untouched.</td></tr>
    </tbody></table></div>
  </section>
`;

export function apiDocsHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "API · omarchy-pool",
    description: "The omarchy-pool JSON API: rings, releases, packages, dependency graph, journal.",
    active: "docs",
    doc: "api",
    body: BODY,
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
      anchor: [
        'id="read"',
        "<code>GET /version</code>", "<code>GET /signing-key</code>", "<code>GET /status</code>", "<code>GET /stats</code>",
        "<code>GET /releases/:ring?fields=summary", "<code>GET /releases/:ring?arch=", "<code>GET /releases/:ring/history</code>", "<code>GET /releases/:ring/diff?",
        "<code>GET /packages/:sha256</code>", "<code>GET /search?", "<code>GET /package/:name?", "<code>/files</code>", "<code>GET /graph?",
        "<code>GET /security/components</code>", "<code>GET /security?", "<code>GET /events?", "<code>GET /pool/unreferenced?", "<code>GET /cost</code>",
      ],
      reads: [
        { path: "/api/v1/version", fields: ["version", "commit", "deployed_at", "release_url", "commit_url"] },
        { path: "/api/v1/signing-key", fields: ["fingerprint", "user", "armored"] },
        { path: "/api/v1/status", fields: ["ok", "state", "api.ok", "index.ok", "index.ms", "pool.ok", "pool.ms", "signing", "checked_at"] },
        {
          path: "/api/v1/stats",
          fields: ["rings", "rings.0.ring", "rings.0.release", "coverage", "pool.objects", "pool.bytes", "series.imports_daily", "series.health", "metrics", "events", "latest", "provenance", "any"],
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
        { path: `/api/v1/search?q=${F.pkg}&${stable}&limit=10`, fields: ["ring", "arch", "release_id", "query", "packages", "packages.0.name", "packages.0.version", "packages.0.description"] },
        {
          path: `/api/v1/package/${F.pkg}?${stable}`,
          fields: ["name", "shown_ring", "rings", "package.version", "package.sha256", "manifest", "depends", "links", "required_by", "security.advisories", "security.exposed", "provenance", "pool_url"],
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
      anchor: [
        'id="factory"',
        "<code>GET /factory?", "<code>GET /factory/packages</code>", "<code>/built</code>", "<code>/tasks/:id</code>", "<code>GET /factory/review</code>",
        "<code>GET /factory/tasks/:id/can</code>", "<code>GET /factory/tasks/:id/artifacts/", "<code>GET /factory/approvals</code>", "<code>/maintainers</code>", "<code>/trust</code>", "<code>/blocks</code>",
        "<code>GET /users/:login</code>", "<code>GET /factory/workers/self</code>", "<code>GET /factory/me</code>",
      ],
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
          fields: ["staged", "staged.0.id", "staged.0.kind", "staged.0.owner", "staged.0.evidence.pkgbuild", "staged.0.evidence.log", "staged.0.evidence.pkginfo", "staged.0.evidence.audit", "staged.0.vet", "staged.0.audit.status", "staged.0.trial", "staged.0.can.approve", "staged.0.can.reject", "staged.0.can.build", "staged.0.can.withdraw", "staged.0.can.why"],
        },
        { path: `/api/v1/factory/tasks/${F.stagedTask}/can`, fields: ["task", "can.approve", "can.reject", "can.build", "can.withdraw", "can.why.approve"] },
        { path: `/api/v1/factory/tasks/${F.stagedTask}/can`, as: "maintainer", fields: ["task", "can.approve", "can.reject", "can.build", "can.withdraw", "can.why.approve"] },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/PKGBUILD`, json: false },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/${stagedPackage}`, status: 403 },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/${stagedPackage}`, as: "maintainer", json: false },
        { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.id", "approvals.0.task_id", "approvals.0.name", "approvals.0.decision", "approvals.0.by", "approvals.0.rings"] },
        { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login", "maintainers.0.since", "source", "synced_at"] },
        { path: "/api/v1/factory/trust", fields: ["workers", "workers.0.id", "workers.0.trust", "workers.0.trusted_by", "maintainers", "listed", "source"] },
        { path: "/api/v1/factory/blocks", fields: ["contributors", "packages"] },
        {
          path: `/api/v1/users/${F.owner}`,
          fields: ["login", "role", "github", "packages", "packages.0.name", "builds", "builds.0.id", "build_counts.total", "approvals", "approved_packages", "record", "workers", "workers.0.id"],
        },
        { path: "/api/v1/factory/workers/self", status: 401 },
        { path: "/api/v1/factory/workers/self", as: "maintainer", status: 401 },
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
      anchor: [
        'id="write-jobs"',
        "<code>POST /factory/claim</code>",
        "<code>PUT /pool/:sha256?", "<code>/sig</code>", "<code>/multipart</code>", "<code>POST /pool/:sha256/sign?",
        "<code>POST /packages?", "<code>POST /packages/known</code>", "<code>POST /releases</code>", "<code>PUT /releases/:id/artifacts/:kind?",
        "<code>POST /events</code>", "<code>POST /pool/gc</code>", "<code>POST /pool/relayout</code>", "<code>PUT /factory/tasks/:id/artifacts/",
      ],
      acts: [
        { method: "POST", path: "/api/v1/factory/claim", expect: noSession },
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
      anchor: [
        'id="write-people"',
        "<code>POST /factory/packages</code>", "<code>/packages/:name/build</code>", "<code>DELETE /packages/:name</code>", "<code>DELETE /factory/tasks/:id/artifacts</code>",
        "<code>POST /factory/workers</code>", "<code>DELETE /workers/:id</code>",
        "<code>POST /factory/tasks/:id/build</code>", "<code>/approve</code>", "<code>/reject</code>", "<code>/withdraw</code>",
        "<code>POST /factory/jobs</code>", "<code>POST /factory/workers/:id/trust</code>", "<code>POST /factory/record/withdraw</code>",
        "<code>POST /factory/contributors/:login/{block,unblock}</code>", "<code>/packages/:name/{block,unblock}</code>",
        "<code>GET /auth/github</code>", "<code>/auth/me</code>", "<code>/auth/logout</code>",
      ],
      reads: [
        { path: "/auth/github?next=/api", status: 302, json: false },
        { path: "/auth/me", status: 401 },
        { path: "/auth/me", as: "contributor", fields: ["login", "name", "avatar_url", "role"] },
        { path: "/auth/logout", status: 302, json: false },
      ],
      acts: [
        { method: "POST", path: "/api/v1/factory/packages", expect: { anonymous: 401, contributor: 400 } },
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
