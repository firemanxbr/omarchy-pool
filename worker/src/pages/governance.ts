/**
 * Governance: who decides what in the factory, and how one becomes a
 * maintainer. The rules are a file in the repository, changed by pull
 * requests other maintainers approve; this page explains them and shows
 * the maintainers the pool applied from that file.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const FILE = `${REPO_URL}/blob/main/factory/MAINTAINERS.toml`;

const BODY = String.raw`
  <h1>Governance</h1>
  <p class="lede">Two roles, one file, decisions by pull request. Anyone who signs in with GitHub is a <b>contributor</b>: requests packages, runs workers on their own machines, follows their builds — nothing to ask, nothing spent by the project. The logins listed in <a href="${FILE}"><code>factory/MAINTAINERS.toml</code></a> are the <b>maintainers</b> — one list, no areas: every maintainer reviews everything. Nobody is above that — no owner, no superuser, no API that grants a role: the project belongs to its maintainers and contributors, the pool reads the file on <code>main</code> every ten minutes and applies it, and every change is a <code>role</code> line in the journal. This is a community pool: nothing in it is official Omarchy, and no package here is endorsed by the Omarchy project.</p>

  <section id="maintainers">
    <h2>The maintainers</h2>
    <p class="sub">Read live from the pool, which read <code>factory/MAINTAINERS.toml</code> on <code>main</code> <span id="synced"></span>.</p>
    <div class="table-wrap"><table id="maintainers-table"><thead><tr><th>Maintainer</th><th>Since</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section id="learn">
    <h2>We do not use what you built, we learn from it</h2>
    <p class="sub">A contributor uses exactly the tools a maintainer uses — the same signed worker image, the same PKGBUILD conventions, <code>namcap</code>, the same build — to produce a package that respects the packaging practices, is checked for quality and is safer for users. An AI agent may help: nobody knows better than the author how their software should be compiled and packaged, and an agent turns that knowledge into a recipe faster. The agent's key is the contributor's, on their machine; the project runs no agent for them.</p>
    <p class="sub"><b>Nothing the contributor built is ever used — not the package, not the recipe.</b> The maintainer does not trust it and must not. What they have in front of them is not "some software, go package it" — it is a recipe that already built, its log, its manifest, the gate's transcript, the second agent's audit, the corrections made along the way. Evidence. A maintainer (never the owner) reads it and has <b>the project build the package again</b>: on a worker the project trusts, with the project's agent, which gets the request and that evidence as the lesson and writes the project's own recipe from the project's sources — through the same gate, staged like any build, installed by a real pacman in the lab (the trial), its evidence on the record. Then a maintainer approves <em>the project's build</em>, and only that goes into the pool, signed. The pool enforces the line: a contributor's build cannot be approved (the API says so), a worker refuses to start from a staged artifact, and the project's build carries <code>review:&lt;task&gt;</code> — where it learned, never what it copied.</p>
    <p class="sub">Zero trust between people, shared knowledge between them. Users get a package at least <b>two different people</b> stood behind — the contributor who made it work, the maintainer who had it built again and attested it — built twice, on two workers, by two agents, and never the first one.</p>
    <p class="sub"><b>The second agent.</b> The contributor's agent, if any, wrote the recipe; the maintainer's side has one too. When a build is staged the pool queues an <em>audit</em> — a job a review worker takes only if its owner set an agent key. It reads the same evidence the maintainer will — the PKGBUILD, the build log, the <code>.PKGINFO</code> — asks its model for a structured review (supply chain, security, packaging practice, correctness against the log, licence) and attaches <code>audit.json</code> and <code>audit.md</code> to the evidence. <a href="/review">Review</a> shows the verdict next to the build: <code>ok</code>, <code>warn</code> (approve with the findings in mind), <code>block</code> (do not approve as is). Evidence, never a decision: nothing in the pool acts on it, the maintainer does. The builder cannot write those two files, the audit cannot write anything else, and a build decided before the audit ran cancels it. No review worker with a key, no audit: the column says <em>waiting</em>.</p>
  </section>

  <section id="roles">
    <h2>What each role does</h2>
    <div class="tabs" id="role-tabs"></div>
    <div class="cando" id="role-lists"></div>
  </section>

  <section id="categories">
    <h2>Categories, not groups</h2>
    <p class="sub">There are no groups: no package belongs to an area whose maintainers own it, and no maintainer reviews only a part of the pool. What a package <em>is about</em> — for a person browsing — is its <b>category</b>, one of a fixed list: <code>terminal</code>, <code>editors</code>, <code>development</code>, <code>browsers</code>, <code>communication</code>, <code>media</code>, <code>graphics</code>, <code>office</code>, <code>games</code>, <code>system</code>, <code>networking</code>, <code>security</code>, <code>fonts</code>, <code>themes</code>, <code>libraries</code>, <code>other</code>.</p>
    <div class="steps">
      <div class="step"><h3>The project's agent proposes it</h3><p>When it audits a staged build it names a category in its report, from the description, the upstream project and what the package installs. The registration takes the proposal only while nobody settled one (a <code>category</code> line in the journal says so).</p></div>
      <div class="step"><h3>A maintainer settles it</h3><p>On the <a href="/review">Review</a> page, under the package name, or with <code>POST /api/v1/factory/packages/&lt;name&gt;/category</code> — at review, or any time after; the change is a <code>category</code> line in the journal with who and from what. A settled category is never overwritten by a later audit.</p></div>
      <div class="step"><h3>It travels with the package</h3><p>The registry, the package page (<em>who stands behind it</em>), the profile's package list and the seal carry it. It says where to look, never who may approve. The project's recipes live flat, <code>factory/pkgbuilds/&lt;name&gt;/</code>, owned by every maintainer (<code>CODEOWNERS</code>, generated from the governance file).</p></div>
    </div>
  </section>

  <section id="becoming">
    <h2>Becoming a maintainer</h2>
    <div class="steps">
      <div class="step"><h3>1. Contribute first</h3><p>Every maintainer was a contributor: packages registered, builds staged, reviews taken part in. Sign in, and the record of what you did is public on the <a href="/factory">Factory</a> page and your profile.</p></div>
      <div class="step"><h3>2. A maintainer proposes you</h3><p>A pull request adding your login to <code>factory/MAINTAINERS.toml</code>, saying why. It is a decision people make, not a database write.</p></div>
      <div class="step"><h3>3. Another maintainer approves</h3><p>The file (and <code>CODEOWNERS</code>, generated from it) is owned by every maintainer and <code>main</code> requires a code-owner review, so at least one <em>other</em> maintainer approves; nothing about it is auto-merged. The merge is the promotion: within ten minutes the pool applies it and the next sign-in shows the role. A maintainer stepping down is the same pull request with the same review; <code>factory/bin/check-governance --write</code> regenerates <code>CODEOWNERS</code>, and CI fails when the two disagree.</p></div>
      <div class="step"><h3>Bootstrap</h3><p>While the project has a single maintainer there is nobody else to approve <em>the pull request that adds the second one</em>: that maintainer merges it alone, and GitHub records the bypassed review. The exception ends the moment a second maintainer exists, and it never extended to packages — a sole maintainer's own packages wait.</p></div>
    </div>
  </section>

  <section id="workers">
    <h2>Workers, compute and agents</h2>
    <div class="steps">
      <div class="step"><h3>One image, one command, for everyone</h3><p><code>ghcr.io/firemanxbr/omarchy-worker</code>. There is no technical difference between a contributor's container and a maintainer's; the registration behind the token decides. Community trust (every registration starts here) builds the owner's packages and never sees a package in review; project trust — two maintainers' word on the registration, never its owner's — runs the pool's jobs and the rebuild of approved packages. A maintainer who also contributes registers a second, untrusted worker. <a href="/docs/workers">Run a worker →</a></p></div>
      <div class="step"><h3>The project's workers, in three roles</h3><p>Machines two maintainers vouched for — one proposes, another confirms, the trust a signed record, one maintainer enough to take it back. They only do what a maintainer would: a <b>pool</b> worker takes the pool's jobs (sync, promote, health, security, the trial, gc) and nothing else; a <b>review</b> worker takes the maintainers' work and nothing else — the build of the recipes maintainers merge and the audit of every staged build; a shared <b>community</b> worker builds contributors' packages and drafts package requests with an agent key its owner brought. They never build from a contributor's staged artifact, and never pull a new package that has no evidence and no review yet — that is a contributor's worker's job. The Review page names the worker behind every build.</p></div>
      <div class="step"><h3>Yours, and only yours</h3><p>A registered worker builds <b>its owner's packages</b> and nothing else. Donating compute to everyone's builds is a maintainer's call: the project's shared community workers are the ones maintainers run; a contributor's worker is never shared, whatever flag it starts with — the pool ignores it. Nobody's laptop ends up busy with strangers' packages, and no stranger's machine ends up building for everyone.</p></div>
      <div class="step"><h3>Ready is not online</h3><p>A worker is ready for the work it declares when it is alive <em>and</em> what that work needs answers: a build or an audit needs an agent that replies. A key set is not an agent that works — no credit, a revoked token, a dead endpoint, a retired model — so the worker probes its agent at start and every thirty minutes, and says so with every claim. The pool hands a draft or an audit only to a worker whose agent answered; the pool's own jobs need no agent.</p></div>
      <div class="step"><h3>Agent keys stay with the worker's owner — and out of the build</h3><p>A worker that drafts or corrects PKGBUILDs with an agent (community trust), or audits staged builds for the maintainers (project trust), gets the owner's key — <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, <code>XAI_API_KEY</code> or a Claude subscription's <code>CLAUDE_CODE_OAUTH_TOKEN</code> — on the <b>broker</b>, the one process on the host that holds credentials and runs no build; the builder is born with nothing and speaks to it. The worker reports <em>which</em> agent really answers so the Factory page can show it. The pool holds no agent key and GitHub runs no agent — nothing of the pipeline runs there. A build is somebody else's code and its log is public: <em>the build sees nothing the log cannot show</em>, and the pool refuses a log that carries what looks like a secret.</p></div>
      <div class="step"><h3>Package requests</h3><p>Made on the dashboard (<a href="/request">the request page</a>: the project's URL, a description, the licence, the checklist — written once to the public record). The build goes to the project's shared community workers (the project's agent) or to the contributor's own worker (their agent). No ready worker, no draft: the request waits, visibly, on the Factory page.</p></div>
    </div>
  </section>

  <section id="bumps">
    <h2>Bumps and packages nobody builds</h2>
    <p class="sub">A new upstream release of an approved package is built the way the first version was — on the owner's worker, as evidence a maintainer reviews. Once a day the pool queues that build (<code>bump:&lt;task&gt;@&lt;tag&gt;</code>: the contributor's staged PKGBUILD with <code>pkgver</code> moved to the tag; evidence again, never the product). The owner's worker has <b>14 days</b>; after that any shared worker may build it. <b>30 days</b> without a build and the package is <em>unmaintained</em>: no more bumps until its owner builds again, or a maintainer removes the registration so someone else can take the name. The project's recipes — the maintainers' own and the ones written from contributors' evidence — are bumped by pull request, one per package, reviewed by a maintainer, never auto-merged.</p>
  </section>

  <section id="blocking">
    <h2>Blocking</h2>
    <p class="sub">The brake. It is on the <a href="/review">Review</a> page, <em>Blocks</em>, and in the API; it takes a maintainer and a reason, and the reason is what the record and the contributor see.</p>
    <div class="steps">
      <div class="step"><h3>A contributor</h3><p><code>POST /api/v1/factory/contributors/&lt;login&gt;/block</code>. Nothing more in: no package request, no build, no worker registration — the pool answers <code>403</code> with the reason. Their workers are revoked at once, their queued and running tasks cancelled, their registrations rejected and their packages pulled from every ring. Their projects and source URLs stay closed: a new account asking for the same project gets <code>403 requested by &lt;login&gt;, who is blocked</code> — a fresh login does not open the door again. A maintainer cannot block themself or another maintainer; the latter is a governance pull request removing the name from the file.</p></div>
      <div class="step"><h3>A package</h3><p><code>POST /api/v1/factory/packages/&lt;name&gt;/block</code>. Out of every ring the same way, its tasks cancelled, its registration rejected; the project URL answers <code>403</code> to any new request until the block is lifted.</p></div>
      <div class="step"><h3>Lifted by another maintainer</h3><p><code>…/unblock</code>, a reason again — never the one who blocked, the same two-person rule as the approval. Lifting restores nothing: workers register again, packages are requested again, and everything goes through the gate and the review as if for the first time. Every block and every lift is a signed record in the public bucket with who, when and why; <code>GET /api/v1/factory/blocks</code> lists what is in force.</p></div>
    </div>
  </section>

  <section id="record">
    <h2>The record and the score</h2>
    <p class="sub">Role changes are <code>role</code> lines in the <a href="/journal?kind=role">journal</a>, approvals are rows a maintainer signed with their login, trust decisions are <code>trust</code> lines, blocks and their lifting are signed records in the public bucket. The file's history on GitHub is the history of who decided what.</p>
    <p class="sub"><b>Track record.</b> A profile sums that record, so it says how much work a person has done here — not who they are. As a contributor: distinct packages a maintainer let in, builds that produced evidence, of which bumps, builds their workers did for other people, rejections. As a maintainer: approvals, rejections, and approvals whose project build then failed. One number, so that the formula is public and dull: <code>3·let in + staged + bumps + for others − 2·rejected + 2·approvals + rejections − 3·builds failed</code>. No rank, no badge, no threshold; becoming a maintainer is still a pull request another maintainer approves, with this record as one thing they look at.</p>
    <div class="table-wrap"><table id="roles-table"><thead><tr><th>When</th><th>What</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var ROLES = { contributor: ["Contributor", [["register any package, no permission needed", "build on the community's shared workers — a worker of your own is optional, it only speeds things up and helps everyone", "get every build as evidence, publicly", "a public profile and a score"], ["ship bytes to users directly", "approve anything, including their own"]]], maintainer: ["Maintainer", [["read a staged build with the evidence in front of them, and reject it or have the project build it again", "approve or reject the project's build — the approval is the decision, on the record with a name", "settle each package's category", "vouch for a worker as a project worker — with a second maintainer, never the owner", "block a contributor or a package, with the reason on the record — another maintainer lifts it", "roll a ring back, and run any pipeline step by hand", "review recipe and governance pull requests; propose a new maintainer"], ["use anything a contributor built — not the package, not the PKGBUILD: the project builds what its agent wrote", "approve their own package, even as the only maintainer", "be named anywhere but factory/MAINTAINERS.toml"]]], workers: ["The project's workers", [["claim tasks of their role and architecture with a lease", "run the pool's jobs, the audit of a staged build, the project's builds of reviewed packages and of the recipes on main", "write the audit when their owner set an agent key"], ["build from a contributor's staged artifact", "pull a new package that has no evidence and no review yet", "decide anything — the audit is evidence, never a verdict", "hold the pool's signing key: signing happens in the brain"]]] };
  var role = "contributor";
  function drawRoles() {
    $("#role-tabs").innerHTML = Object.keys(ROLES).map(function (k) { return '<button type="button" data-role="' + k + '" class="' + (role === k ? "on" : "") + '">' + ROLES[k][0] + '</button>'; }).join("");
    $("#role-tabs").querySelectorAll("button").forEach(function (b) { b.onclick = function () { role = b.getAttribute("data-role"); drawRoles(); }; });
    var r = ROLES[role][1];
    $("#role-lists").innerHTML = '<div><h4>does</h4><ul class="yes">' + r[0].map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + '</ul></div><div><h4>never</h4><ul class="no">' + r[1].map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + '</ul></div>';
  }
  drawRoles();
  skeletonRows("#maintainers-table", 2, 2); skeletonRows("#roles-table", 5, 2);
  busy(fetch("/api/v1/factory/maintainers")).then(function (r) { return r.json(); }).then(function (d) {
    $("#synced").textContent = d.synced_at ? "(" + ago(d.synced_at) + ")" : "(not yet)";
    pager("#maintainers-table", d.maintainers || [], function (m) {
      return '<tr><td>' + avatarIcon(m.login, "maintainer") + ' <a href="/user/' + encodeURIComponent(m.login) + '"><b>' + esc(m.login) + '</b></a></td><td>' + ago(m.since) + '</td></tr>';
    }, { empty: "nobody applied yet — the pool reads factory/MAINTAINERS.toml on main every ten minutes" });
  }).catch(function () { endSkeleton(); });
  busy(fetch("/api/v1/events?kind=role&limit=50")).then(function (r) { return r.json(); }).then(function (d) {
    pager("#roles-table", d.events || [], function (e) { return '<tr><td class="when">' + ago(e.created_at) + '</td><td>' + esc(e.summary) + '</td></tr>'; }, { empty: "no role change recorded yet" });
  }).catch(function () { endSkeleton(); });
  liveStats(function () {}, 120000);
`;

export function governanceHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Governance · omarchy-pool",
    description: "Contributors and maintainers, categories, and how a pull request is the only way to become a maintainer.",
    active: "docs",
    doc: "governance",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
