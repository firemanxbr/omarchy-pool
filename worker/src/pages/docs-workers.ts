/**
 * Run a worker: the two container images on GitHub Packages and how to run
 * them with Docker Desktop or Podman — as a contributor building your own
 * packages (and donating your machine, if you like), or as a maintainer
 * running the project's work.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { DASHBOARD_HOST, REPO_URL } from "../meta";

const IMG = "ghcr.io/firemanxbr/omarchy-worker";

const BODY = String.raw`
  <h1>Run a worker</h1>
  <p class="lede">Every build for the pool happens on a worker somebody runs — a contributor's laptop for their own packages, a machine a maintainer trusts for the project's work — and every worker runs the <b>same image</b>: <code>${IMG}</code>, Arch Linux, built for x86_64 and aarch64 on GitHub Packages and signed. There is no technical difference between a contributor's container and a maintainer's; the <b>registration behind the token</b> decides what it may do. Nothing you run holds a key: the pool signs what it publishes, and your token only asks for work.</p>

  <section id="registration">
    <h2>What the registration decides</h2>
    <div class="table-wrap"><table><thead><tr><th>Your registration</th><th>What the container does</th><th>What it needs</th></tr></thead><tbody>
      <tr><td><b>community</b> trust — every registration starts here</td><td>builds <em>your</em> registered packages, one task per container, right inside it, into your staging workspace as evidence for a maintainer. With <code>WORKER_SHARED=1</code> it also builds other contributors' packages (donated compute), with your agent key (<code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code> or <code>XAI_API_KEY</code>) your agent drafts and corrects PKGBUILDs. It never sees a package in review or approved.</td><td>the token</td></tr>
      <tr><td><b>project</b> trust — two maintainers vouched for the registration, neither its owner</td><td>the project's work: the pool's own jobs (sync, promote, health, security, gc, the PKGBUILD reconcile) and the rebuild of packages maintainers approved — what users actually get. Each build and check runs in a <em>fresh</em> Arch container it starts as a sibling. With an agent key it also <b>audits</b> staged builds for the maintainers (the second agent). Never a contributor's build.</td><td>the token, the runtime's socket, a working directory at the same path on both sides</td></tr>
    </tbody></table></div>
    <p class="sub">A maintainer who also contributes packages registers a second worker and leaves it untrusted: one registration per role of a machine. Tags: <code>latest</code> is a multi-architecture manifest (your machine pulls its own), <code>x86_64</code> and <code>aarch64</code> pin one, and every pool release is a tag (<code>v0.0.70</code>). Verify before trusting it:</p>
    <div class="steps"><div class="step"><pre>cosign verify ${IMG}:latest \
  --certificate-identity-regexp 'github.com/firemanxbr/omarchy-pool' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com</pre></div></div>
  </section>

  <section id="roles">
    <h2>The three roles</h2>
    <p class="sub">The project runs its workers as three kinds of container, and anyone donating a machine can run the same. A role is set with <code>OMARCHY_WORKER_ROLE</code>; it narrows what the registration allows, never widens it, and the container refuses to start under a registration that does not match (a <em>pool</em> or <em>review</em> role needs project trust, a <em>community</em> role a community registration). The Factory page shows each worker's role.</p>
    <div class="table-wrap"><table><thead><tr><th>Role</th><th>Registration</th><th>What it does</th><th>Agent key</th></tr></thead><tbody>
      <tr><td><b>pool</b></td><td>project trust</td><td>the pool's own jobs and nothing else: sync, render, promote, rollback, health, security, enqueue, gc, verify. Never a build, never an audit.</td><td>none</td></tr>
      <tr><td><b>review</b></td><td>project trust</td><td>the maintainers' work and nothing else: the rebuild of approved packages in fresh sibling containers, and the audit of every staged build (the second agent). Never a pool job.</td><td>wanted — without one, audits wait</td></tr>
      <tr><td><b>community</b></td><td>community registration</td><td>a shared community worker (<code>WORKER_SHARED=1</code> implied): builds anyone's requested packages with its owner's agent, one task per container — the queue every request lands in. Anyone may share one; a dedicated worker builds only its owner's.</td><td>required — a worker whose agent does not answer the probe is not ready and gets no build</td></tr>
    </tbody></table></div>
    <p class="sub">Two of each — one per architecture — is what the project runs on its own host (RUNBOOK, <em>The Studio host</em>): x86_64 pool jobs are only a label and run natively on any machine; x86_64 <em>builds</em> on an aarch64 host run under user-mode emulation, correct but slower. Without a role the trust decides everything: a project worker takes pool jobs, rebuilds and audits alike; a community worker builds its owner's packages.</p>
  </section>

  <section id="before">
    <h2>Before you start</h2>
    <div class="steps">
      <div class="step"><h3>A container runtime</h3><p><b>Docker Desktop</b> on macOS, Windows or Linux, or <b>Podman</b> — the <code>podman</code> command, or <a href="https://podman-desktop.io/">Podman Desktop</a> with its graphical window. Every command below is shown for both; they differ only in the first word. Give the runtime at least 2 CPUs and 4 GB of memory (Docker Desktop: <em>Settings → Resources</em>; Podman on macOS: <code>podman machine set --cpus 4 --memory 8192</code>); a browser-class package needs far more.</p></div>
      <div class="step"><h3>Which architecture you build</h3><p>A worker builds for its own architecture: an Apple silicon Mac or a Raspberry Pi builds <code>aarch64</code>, an Intel or AMD machine <code>x86_64</code>. Register the worker for the architecture of the machine it will run on; the image refuses a mismatch.</p></div>
      <div class="step"><h3>An account, a worker registration</h3><p>Sign in with GitHub (top right): it lands on <b>your own page</b>, the workspace. Register a worker there: a name and its architecture. You get a <b>token</b>, shown once — that machine's identity. Revoke it on the same page if the machine is lost.</p></div>
    </div>
  </section>

  <section id="contributor">
    <h2>As a contributor: your own packages</h2>
    <div class="steps">
      <div class="step"><h3>1. Start it</h3><p>One command, wherever the worker lives — a machine or a VM with Docker or podman (and compose). It writes the compose file and a <code>.env</code> (in <code>~/.config/omarchy-worker</code>, mode 600), pulls the signed image and starts the set: three containers — the broker and the builder on a network of their own, the updater beside them. The <b>broker</b> holds what is yours — the worker token, your agent's key, a GitHub token — and only receives, processes and answers. The <b>builder</b> beside it is born with nothing: it asks the broker for a build of yours, builds it, uploads the package, the PKGBUILD and the log to your staging workspace through the broker, and exits; the restart policy starts the next one. The <b>updater</b> keeps both on the pool's latest image (<a href="#update">every worker follows it</a>).</p>
<pre>curl -fsSLo omarchy-worker https://${DASHBOARD_HOST}/omarchy-worker &amp;&amp; chmod +x omarchy-worker
./omarchy-worker start --token &lt;omw_…&gt; --github-token &lt;github_pat_…, no permissions&gt;
./omarchy-worker status        # what runs here, what the pool thinks of it
./omarchy-worker logs          # the builder's log (logs broker | updater)
./omarchy-worker stop          # a drain: the build in hand finishes first</pre>
      <p>The same set by hand, with <a href="${REPO_URL}/blob/main/factory/image/compose.yml">compose.yml</a> (also served at <code>/omarchy-worker/compose.yml</code>) and a <code>.env</code> beside it; the updater mounts the directory at the same path, so its absolute path goes in:</p>
<pre>printf 'OMARCHY_WORKER_TOKEN=%s\nGITHUB_TOKEN=%s\nOMARCHY_WORKER_DIR=%s\nCOMPOSE_PROFILES=community\n' omw_… github_pat_… "$PWD" &gt; .env
docker compose up -d           # podman compose works the same</pre>
      <p><b>--github-token</b> (on the broker): the drafter reads GitHub's API for every package it builds — the release, the files — through the broker. Without a token GitHub allows 60 requests an hour from your address, and a queue of ten builds is ten failures; a <a href="https://github.com/settings/personal-access-tokens/new">fine-grained token</a> with <em>no permissions at all</em> gives 5000. Make one for this — never <code>gh auth token</code>, which is your account with write access to your repositories (see <a href="#secrets">what a build can see</a>). A stop is a drain (compose: <code>stop_grace_period: 3h</code>): the build in hand finishes and reports; killed mid-build, the task waits half an hour for its lease to expire. Change the settings between builds, not during one.</p></div>
      <div class="step"><h3>2. Give it work</h3><p><a href="/request">Request a package</a> (the project's URL, a description, the licence, the checklist) and press <b>Build</b> on your page. Your worker picks it up within a minute; the <em>Builds</em> table follows it, and the <em>Workers</em> table shows it alive. When the build is staged, a maintainer sees it on <a href="/review">Review</a>.</p></div>
      <div class="step"><h3>3. Donate the machine, bring your agent</h3><p>Two switches, both yours to flip — the first on the builder, the second on the broker (options of <code>omarchy-worker start</code>; by hand, the same names in <code>.env</code>). The first is the pool's to keep: <b>Share</b> / <b>Own only</b> on your page (or <code>omarchy-worker share on|off</code>) sets the registration's mode, and from the worker's next claim — within the minute, nothing restarts — that is what counts, whatever the container was started with; the container's flag is only the first word.</p>
<pre># the builder: also build other contributors' packages (their bumps after 14 days, package requests at once)
./omarchy-worker start --shared            # or: ./omarchy-worker share on | off, or Share on your page — the pool keeps it (.env's WORKER_SHARED is only the first word)

# the broker: an agent drafts and corrects PKGBUILDs, with your key — the pool never holds one, the builder never sees it;
# one of these is enough (Anthropic, OpenAI, Gemini, xAI), --model picks the model
./omarchy-worker start --anthropic-key sk-… --model claude-sonnet-5   # or --openai-key / --gemini-key / --xai-key
                                                                      # (.env: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, FACTORY_MODEL)
# or your Claude subscription instead of a key (see "A Claude subscription as the agent" below)
./omarchy-worker start --claude-token …    # what 'claude setup-token' printed on your machine (.env: CLAUDE_CODE_OAUTH_TOKEN)</pre>
      <p>The Factory page shows which agent each worker reported (<code>anthropic/claude-sonnet-5</code>, <code>claude-code/claude-sonnet-5</code>, <code>openai/gpt-5</code>, …); the key itself never leaves the broker.</p>
      <p>A shared worker with an agent is what turns a <em>package request</em> (the <a href="/request">request page</a>) into a first PKGBUILD and a first build: the request lands in the shared queue the moment its record is written, and the best idle shared worker of the architecture — native before emulated, then the most cores — takes it first; the others after three minutes. Without one, requests wait, and the page says where they stand. What your agent produces is evidence like any other build: a maintainer reads it before anything reaches users.</p></div>
      <div class="step"><h3>4. Watch it</h3><p><code>./omarchy-worker status</code> says what runs here and what the pool thinks of it; <code>./omarchy-worker logs</code> follows the builder (<code>logs broker</code>, <code>logs updater</code> the others). The worker's own log — the lines between tasks: preparing, the agent's probe, an update required — also reaches the pool with each claim: the log icon beside its id on the <a href="/workers">Workers</a> page and on your page opens the last kilobytes, for its owner and the maintainers (a build's output is on the build's page). In <b>Docker Desktop</b>, <em>Containers</em> lists the three under the <code>omarchy-worker</code> project, each with a <em>Logs</em> tab; in <b>Podman Desktop</b>, the same under <em>Containers</em>. The builder exits after each task (that is by design) and the restart policy brings it back.</p>
      <div class="shot">Screenshot to add: Docker Desktop → Containers, the <code>omarchy-worker</code> project and the builder's Logs tab; Podman Desktop → Containers, the same.</div></div>
    </div>
  </section>

  <section id="project">
    <h2>As a maintainer: the pool's jobs and approved rebuilds</h2>
    <p class="sub">Once a maintainer trusts the registration (<code>POST /api/v1/factory/workers/&lt;id&gt;/trust</code>; the <em>Trust</em> table on <a href="/review">Review</a> lists it), the same image switches to the project's work. Each build and check runs in a fresh Arch container it starts as a sibling through your runtime — so it needs the runtime's socket, and a working directory that has the <b>same path</b> on your machine and inside the container (the sibling containers mount subdirectories of it).</p>
    <div class="steps">
      <div class="step"><h3>0. One command</h3><p>The same <code>omarchy-worker</code>, with that registration's token and <code>--project</code> (the updater beside it, as for a contributor's):</p>
<pre>./omarchy-worker start --token &lt;omw_…&gt; --project --role review     # or --role pool; --work-dir for the working directory</pre></div>
      <div class="step"><h3>1. Docker Desktop, by hand</h3><p>The three steps below run one container without an updater: after every release, <code>docker pull …:latest</code> and recreate it — or the pool refuses it 45 minutes later (<a href="#update">every worker follows the latest image</a>). Step 0 does that for you.</p>
<pre>mkdir -p "$HOME/omarchy-worker"
docker run -d --name omarchy-worker --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/omarchy-worker:$HOME/omarchy-worker" -e OMARCHY_WORK_DIR="$HOME/omarchy-worker" \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; \
  ${IMG}:latest --labels '{"where":"my-machine"}'</pre>
      <p>On Windows, use a path Docker Desktop shares (under your user profile) for the working directory, with the same spelling on both sides of the <code>-v</code>.</p></div>
      <div class="step"><h3>2. Podman</h3>
<pre># Linux (rootless): the socket is your user's — enable it once
systemctl --user enable --now podman.socket
podman run -d --name omarchy-worker --restart unless-stopped --security-opt label=disable \
  -v /run/user/$UID/podman/podman.sock:/var/run/docker.sock \
  -v "$HOME/omarchy-worker:$HOME/omarchy-worker" -e OMARCHY_WORK_DIR="$HOME/omarchy-worker" \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; \
  ${IMG}:latest

# macOS (podman machine, rootful by default): the socket lives inside the VM
podman run -d --name omarchy-worker --restart unless-stopped --security-opt label=disable \
  -v /run/podman/podman.sock:/var/run/docker.sock \
  -v "$HOME/omarchy-worker:$HOME/omarchy-worker" -e OMARCHY_WORK_DIR="$HOME/omarchy-worker" \
  -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; \
  ${IMG}:latest</pre>
      <p><code>--security-opt label=disable</code> lets the container use the socket on SELinux hosts (Fedora, the podman machine). Mounting the socket path you see on macOS (<code>…/podman-machine-default-api.sock</code>) fails with <em>operation not supported</em>: it belongs to the host, not the VM — use the VM's path above.</p></div>
      <div class="step"><h3>3. Or without a container</h3><p>On a Linux host with podman or docker, the release binaries do the same: download <code>omarchy-pool-&lt;version&gt;-&lt;arch&gt;-linux.tar.gz</code> from the <a href="${REPO_URL}/releases/latest">latest release</a> and run <code>pkg-repo work --worker-token omw_… --arch aarch64</code>. Same options as below. The binary is its release's: the pool refuses it 45 minutes after the next one is deployed, until you download that.</p></div>
      <div class="step"><h3>4. Options</h3><p>Anything after the image name goes to <code>pkg-repo work</code>:</p>
<pre>--kind build --kind health   only these kinds (default: everything a project worker may run)
--idle-exit 300           exit after five minutes without work (a fallback worker)
--once                    one task, then exit
--labels '{"where":"…"}'  where it runs; on the Workers page, on the id's hover</pre>
      <p>The worker reports with every claim what its machine uses — CPU, memory and the work directory's disk, an average it keeps over the last hour, from <code>/proc</code> and <code>df</code> — and which release its image is; <a href="/workers">the Workers page</a> shows both per worker, with the last task it finished. Nothing is collected from you: the numbers come from the worker, in the claim it makes anyway.</p>
      <p>A project worker never builds a contributor's package: those run on the contributor's own worker, or on the shared community workers — the project's and anyone's. What it builds is the rebuild a maintainer approved — never one the same maintainer brought — and the pool signs the result.</p></div>
      <div class="step"><h3>5. The second agent</h3><p>Add your agent key — <code>-e ANTHROPIC_API_KEY=sk-…</code>, or <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, <code>XAI_API_KEY</code>, or a Claude subscription as <code>CLAUDE_CODE_OAUTH_TOKEN</code> (<a href="#claude-code">below</a>); your key, on your machine; <code>-e FACTORY_MODEL=…</code> picks the model — and the worker also takes the <b>audit</b> of every build a contributor stages: it reads the PKGBUILD, the log and the <code>.PKGINFO</code> the maintainer will read, asks the model for a structured review — supply chain, security, packaging practice, licence — and attaches the report to the evidence. Every agent — the drafter and the auditor alike — reads the pool's skills first: what every package must pass and what a desktop app or a prebuilt binary must do besides, the same text as <a href="/docs/what-we-test">What we test</a>. <a href="/review">Review</a> shows the verdict next to the build; the maintainer still decides. No such worker running, and the column says <em>waiting</em>.</p></div>
    </div>
  </section>

  <section id="claude-code">
    <h2>A Claude subscription as the agent</h2>
    <p class="sub">A Claude Pro or Max subscription can be the worker's agent instead of an API key: the worker runs <b>Claude Code in print mode</b> — <code>claude -p</code>, no tools, no session, the report as JSON — with a token from your own login. Nothing else changes: the same drafts, the same audits, the same evidence for the maintainer.</p>
    <div class="steps">
      <div class="step"><h3>1. A token, on your machine</h3><p>With Claude Code installed and logged in on the machine you use (the Studio, the laptop — not the worker), run</p>
<pre>claude setup-token</pre>
      <p>It opens the browser for a one-time consent and prints a long-lived token (<code>sk-ant-oat01-…</code>). That token is your subscription: keep it like a password, revoke it from your Claude account when a machine is lost. The worker never needs your login, only this.</p></div>
      <div class="step"><h3>2. Give it to the worker</h3>
<pre># a contributor's broker — the builder beside it never sees the token (docker works the same)
podman run -d --name omarchy-broker --restart unless-stopped --network omarchy-worker \
  -e OMARCHY_WORKER_ROLE=broker -e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt; -e GITHUB_TOKEN=&lt;github_pat_…, no permissions&gt; \
  -e CLAUDE_CODE_OAUTH_TOKEN=&lt;sk-ant-oat01-…&gt; \
  ${IMG}:latest

# with compose: the same variable in the environment or a .env file
CLAUDE_CODE_OAUTH_TOKEN=… OMARCHY_WORKER_TOKEN=… podman compose up -d

# a project host (factory/host): the line goes in etc/agent.env, which the review
# and community services read; FACTORY_PROVIDER makes the choice explicit when an
# API key sits in the same file
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
FACTORY_PROVIDER=claude-code</pre>
      <p>At start the broker installs Claude Code for its architecture (the official installer, checksum verified, into the container's home — about 200 MB, once per container; the image does not ship it) and reports <code>claude-code/claude-sonnet-5</code> as its agent on the Factory page. <code>FACTORY_MODEL</code> picks another model (<code>claude-opus-5</code>); <code>FACTORY_REASONING=low</code> keeps a draft or an audit from thinking longer than it needs. A binary of your own, mounted at <code>/usr/local/bin/claude</code> or named by <code>CLAUDE_CODE_BIN</code>, skips the install.</p></div>
      <div class="step"><h3>3. What it does, exactly</h3><p>Every completion is one process: <code>claude -p --tools "" --max-turns 1 --no-session-persistence --output-format json --model … --system-prompt …</code>, the PKGBUILD and the log on stdin, in an empty directory. No tool is available to the model — it cannot read a file, run a command or reach the network; it answers, and the worker reads the answer. The token goes to the child process; an <code>ANTHROPIC_API_KEY</code> in the same environment is withheld from it, so choosing the subscription means the subscription.</p></div>
      <div class="step"><h3>4. What it costs, and whose rules</h3><p>Nothing on top of the subscription — and the subscription's limits apply: each draft and each audit is a message in the same five-hour and weekly windows as your own use of Claude, and a worker that hits the limit fails the task (<em>You've hit your limit</em>, back in the queue for the next window; the pool retries an audit three times). Your agreement with Anthropic is what allows this use: read their consumer terms on automated and shared use before you put the token on a shared worker or a project host — the API key (<code>ANTHROPIC_API_KEY</code>, a workspace with a spending limit in the Console) is the plain path, and switching is one variable.</p></div>
    </div>
  </section>

  <section id="secrets">
    <h2>What a build can see</h2>
    <p>A build is somebody else's code — the recipe, and the build system of the project it packages — and its log is public: on the API while the build is in staging, on the record once it is staged. So the rule the worker keeps, on your machine and on the project's: <b>the build sees nothing the log cannot show.</b></p>
    <div class="steps">
      <div class="step"><h3>What the broker holds, and the builder does not</h3><p>The worker's token, your agent's key, your <code>GITHUB_TOKEN</code> live in the broker, a container that runs no build: it passes the pool's calls for the one task it claimed (the job token the pool hands out stays with it), answers the agent in the Anthropic shape over whichever provider you gave it, and reads GitHub. The builder is born with nothing — <code>OMARCHY_BROKER</code> and a label — and dies after a task; a variable of yours set on it by mistake is dropped at start and said so. Inside the builder, the build user starts from an empty environment anyway, and a worker started the old way, with the token on it, keeps the token out of every child's environment and lends the key to the drafter alone. A PKGBUILD that prints <code>env</code> prints <code>PATH</code> and <code>HOME</code>.</p></div>
      <div class="step"><h3>What the pool checks anyway</h3><p>Every log, recipe and report uploaded to staging is read for what looks like a secret — the pool's tokens, agents' keys, GitHub's, a private key, a credential in a URL, a dump of the worker's variables — and refused if it carries one: the build fails with the kind and the line (never the match), and nothing reaches the record. That is for the worker the pool does not run; if it fires on yours, the container has something in its environment the worker did not put there — fix the container, queue the build again.</p></div>
      <div class="step"><h3>What you decide</h3><p>Give the broker a <code>GITHUB_TOKEN</code> made for it, with no permissions — not your account's. Keep <code>WORKER_SHARED</code> off unless you mean to run strangers' recipes on this machine; on, give the broker no key you would mind losing. Do not mount your home or a directory of yours into the builder: it needs none. Caches, when you mount one, are kept per package inside — a build reads only what an earlier build of the same package wrote.</p></div>
    </div>
  </section>

  <section id="running">
    <h2>Keeping it running</h2>
    <div class="steps">
      <div class="step" id="update"><h3>Update — every worker follows the latest image</h3><p>The image follows the pool's releases, several a day, and a worker on an old one wastes everyone's time: it drafts the wrong version, links against the wrong objects, misses the rules the rest of the pool keeps. So the pool hands work only to workers on its release: one behind for longer than the rollout's grace (45 minutes after a deploy) is refused at the claim (<code>426</code>), shows <span class="pill warn">outdated</span> on the <a href="/workers">Workers</a> page and on its owner's, and the journal says so once per release. Nothing else changes: the moment it is updated, it works again.</p>
      <p>The <b>updater</b> is what keeps it there, and it is part of the set, not an option: a container of the same image (<code>OMARCHY_WORKER_ROLE=updater</code>) with the runtime's socket and the compose directory, which every fifteen minutes pulls the image and replaces, one service at a time, what changed — a stop is a drain, the build in hand finishes first — itself last. <code>omarchy-worker start</code> runs it; the compose file has it; <code>omarchy-worker update</code> runs one round now. The project's host (the Studio) does the same with <code>factory/host/rollout.sh</code> on a timer. Without an updater, <code>docker compose pull &amp;&amp; docker compose up -d</code> by hand does it — until the next release.</p></div>
      <div class="step"><h3>Stop, remove, revoke</h3><p><code>./omarchy-worker stop</code> drains and stops the set (a build in hand finishes first); <code>./omarchy-worker remove</code> stops it and deletes the files here. The registration stays until you revoke it on your page (or a maintainer does); a revoked token claims nothing, immediately.</p></div>
      <div class="step"><h3>Disk</h3><p>Every task builds in a fresh container that is removed afterwards; images and package caches stay. <code>docker system prune</code> / <code>podman system prune</code> reclaims them. A project worker's working directory holds the upstream keyrings, a checkout of the repository and the last builds — safe to delete when the worker is stopped.</p></div>
      <div class="step"><h3>Something is off</h3><p><em>the pool did not accept this token</em>: it was revoked, or mistyped. <em>registered for aarch64 but this machine is x86_64</em>: register a worker for this machine. <em>mount its socket</em>: the registration is project-trusted and needs the runtime's socket (above). <em>permission denied … docker.sock</em>: add <code>--security-opt label=disable</code> (Podman) or check the socket path. <em>No task for a while</em>: a contributor's worker only sees its owner's tasks unless started shared; a project worker only claims once trusted. The Factory page shows every queued task and every worker the pool has heard from.</p></div>
    </div>
  </section>
`;

export function docsWorkersHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/docs/workers",
    title: "Run a worker · omarchy-pool",
    description: "The container images on GitHub Packages and how to run them with Docker Desktop or Podman, as a contributor or a maintainer.",
    active: "docs",
    doc: "workers",
    body: BODY,
    poolUrl,
    version,
  });
}

/**
 * What /docs/workers is made of. A chapter is prose: every section, table
 * and step card gets its anchor and nothing changes with the role. Three
 * things reach
 * past the page and are checked as such: the one command the contributor
 * step tells the reader to curl is served by the Worker, with the compose
 * file beside it; the trust call the maintainer section names is routed
 * and a maintainer's alone (asked for the trust the project's worker
 * already has, so the fixture stays as it was); and the docs search
 * carries this chapter's map. The header and the footer are the shell's
 * entries. The "Screenshot to add" box in step 4 is an authoring note,
 * not a component: it has no anchor here, so removing it breaks nothing.
 */
export const DOCS_WORKERS_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "docs-workers.docs-sidebar",
    page: "/docs/workers",
    anchor: [
      '<a class="docs-home" href="/docs">Documentation</a>',
      '<nav class="docs-nav" id="docs-nav" aria-label="Chapters">',
      '<details open><summary><a href="/docs/workers" class="on">Run a worker</a><small>8</small></summary>',
      'href="/docs/workers#registration"', 'href="/docs/workers#roles"', 'href="/docs/workers#before"', 'href="/docs/workers#contributor"',
      'href="/docs/workers#project"', 'href="/docs/workers#claude-code"', 'href="/docs/workers#secrets"', 'href="/docs/workers#running"',
      '<div class="docs-group">For people working on the pool</div>',
      '<div class="docs-hint">',
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.docs-search",
    page: "/docs/workers",
    anchor: ['<input type="search" id="docs-q"', '<div class="docs-hits" id="docs-hits" hidden>'],
    script: [
      'var q = $("#docs-q"), hits = $("#docs-hits"), nav = $("#docs-nav")',
      'c.secs.forEach(function (s)',
      '"/docs/glossary#" + g[2]',
      '"href":"/docs/workers","secs":[{"id":"registration","title":"What the registration decides"',
      'nothing in the docs says',
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.title-lede",
    page: "/docs/workers",
    anchor: ["<h1>Run a worker</h1>", '<p class="lede">', `<code>${IMG}</code>`, "<b>registration behind the token</b>"],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.registration-table",
    page: "/docs/workers",
    anchor: [
      '<section id="registration">', "<h2>What the registration decides</h2>",
      "<th>Your registration</th><th>What the container does</th><th>What it needs</th>",
      "<td><b>community</b> trust", "<td><b>project</b> trust", "<code>WORKER_SHARED=1</code>",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.tags-and-cosign",
    page: "/docs/workers",
    anchor: [
      "<code>latest</code> is a multi-architecture manifest", "<code>x86_64</code> and <code>aarch64</code> pin one",
      `<pre>cosign verify ${IMG}:latest`, "--certificate-oidc-issuer https://token.actions.githubusercontent.com",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.roles-table",
    page: "/docs/workers",
    anchor: [
      '<section id="roles">', "<h2>The three roles</h2>", "<code>OMARCHY_WORKER_ROLE</code>",
      "<th>Role</th><th>Registration</th><th>What it does</th><th>Agent key</th>",
      "<td><b>pool</b></td><td>project trust</td>", "<td><b>review</b></td><td>project trust</td>", "<td><b>community</b></td><td>community registration</td>",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.before-steps",
    page: "/docs/workers",
    anchor: [
      '<section id="before">', "<h2>Before you start</h2>",
      "<h3>A container runtime</h3>", 'href="https://podman-desktop.io/"',
      "<h3>Which architecture you build</h3>", "the image refuses a mismatch",
      "<h3>An account, a worker registration</h3>", "Revoke it on the same page",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.contributor-start",
    page: "/docs/workers",
    anchor: [
      '<section id="contributor">', "<h2>As a contributor: your own packages</h2>", "<h3>1. Start it</h3>",
      `<pre>curl -fsSLo omarchy-worker https://${DASHBOARD_HOST}/omarchy-worker &amp;&amp; chmod +x omarchy-worker`,
      "./omarchy-worker start --token &lt;omw_…&gt; --github-token",
      `href="${REPO_URL}/blob/main/factory/image/compose.yml"`, "<code>/omarchy-worker/compose.yml</code>",
      "COMPOSE_PROFILES=community", "docker compose up -d",
      'href="https://github.com/settings/personal-access-tokens/new"', 'href="#secrets"', "<code>stop_grace_period: 3h</code>",
    ],
    reads: [
      { path: "/omarchy-worker", json: false },
      { path: "/omarchy-worker/compose.yml", json: false },
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.contributor-work",
    page: "/docs/workers",
    anchor: ["<h3>2. Give it work</h3>", '<a href="/request">Request a package</a>', "press <b>Build</b> on your page", '<a href="/review">Review</a>'],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.contributor-share-agent",
    page: "/docs/workers",
    anchor: [
      "<h3>3. Donate the machine, bring your agent</h3>", "<b>Share</b> / <b>Own only</b> on your page",
      "./omarchy-worker start --shared", "./omarchy-worker share on | off",
      "./omarchy-worker start --anthropic-key sk-… --model claude-sonnet-5", "ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, FACTORY_MODEL",
      "./omarchy-worker start --claude-token …", "CLAUDE_CODE_OAUTH_TOKEN",
      'the <a href="/request">request page</a>', "the best idle shared worker of the architecture",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.contributor-watch",
    page: "/docs/workers",
    anchor: ["<h3>4. Watch it</h3>", "<code>./omarchy-worker status</code>", "<code>./omarchy-worker logs</code>", 'the log icon beside its id on the <a href="/workers">Workers</a> page'],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.project-intro",
    page: "/docs/workers",
    anchor: [
      '<section id="project">', "<h2>As a maintainer: the pool's jobs and approved rebuilds</h2>",
      "<code>POST /api/v1/factory/workers/&lt;id&gt;/trust</code>", "the <b>same path</b> on your machine and inside the container",
    ],
    acts: [
      { method: "POST", path: `/api/v1/factory/workers/${F.worker}/trust`, body: { trust: "project" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } },
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.project-command",
    page: "/docs/workers",
    anchor: ["<h3>0. One command</h3>", "<pre>./omarchy-worker start --token &lt;omw_…&gt; --project --role review", "--work-dir for the working directory"],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.project-docker",
    page: "/docs/workers",
    anchor: [
      "<h3>1. Docker Desktop, by hand</h3>", 'href="#update"',
      "docker run -d --name omarchy-worker --restart unless-stopped", "-v /var/run/docker.sock:/var/run/docker.sock",
      '-e OMARCHY_WORK_DIR="$HOME/omarchy-worker"', "-e OMARCHY_WORKER_TOKEN=&lt;omw_…&gt;", `${IMG}:latest --labels '{"where":"my-machine"}'`,
      "On Windows, use a path Docker Desktop shares",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.project-podman",
    page: "/docs/workers",
    anchor: [
      "<h3>2. Podman</h3>", "systemctl --user enable --now podman.socket",
      "podman run -d --name omarchy-worker --restart unless-stopped --security-opt label=disable",
      "-v /run/user/$UID/podman/podman.sock:/var/run/docker.sock", "-v /run/podman/podman.sock:/var/run/docker.sock",
      "<code>--security-opt label=disable</code> lets the container use the socket on SELinux hosts", "<em>operation not supported</em>",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.project-binary",
    page: "/docs/workers",
    anchor: ["<h3>3. Or without a container</h3>", `href="${REPO_URL}/releases/latest"`, "<code>pkg-repo work --worker-token omw_… --arch aarch64</code>", "the pool refuses it 45 minutes after the next one is deployed"],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.project-options",
    page: "/docs/workers",
    anchor: [
      "<h3>4. Options</h3>", "<code>pkg-repo work</code>",
      "<pre>--kind build --kind health", "--idle-exit 300", "--once", `--labels '{"where":"…"}'`,
      'CPU, memory and the work directory\'s disk', '<a href="/workers">the Workers page</a>', "A project worker never builds a contributor's package",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.project-second-agent",
    page: "/docs/workers",
    anchor: ["<h3>5. The second agent</h3>", '<a href="#claude-code">below</a>', "<code>-e FACTORY_MODEL=…</code>", '<a href="/docs/what-we-test">What we test</a>', "<em>waiting</em>"],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.claude-code-intro",
    page: "/docs/workers",
    anchor: ['<section id="claude-code">', "<h2>A Claude subscription as the agent</h2>", "<b>Claude Code in print mode</b>", "<code>claude -p</code>"],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.claude-code-token",
    page: "/docs/workers",
    anchor: ["<h3>1. A token, on your machine</h3>", "<pre>claude setup-token</pre>", "<code>sk-ant-oat01-…</code>", "keep it like a password"],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.claude-code-give",
    page: "/docs/workers",
    anchor: [
      "<h3>2. Give it to the worker</h3>",
      "podman run -d --name omarchy-broker --restart unless-stopped --network omarchy-worker", "-e OMARCHY_WORKER_ROLE=broker", "-e CLAUDE_CODE_OAUTH_TOKEN=&lt;sk-ant-oat01-…&gt;",
      "CLAUDE_CODE_OAUTH_TOKEN=… OMARCHY_WORKER_TOKEN=… podman compose up -d", "FACTORY_PROVIDER=claude-code",
      "<code>claude-code/claude-sonnet-5</code>", "<code>FACTORY_REASONING=low</code>", "<code>CLAUDE_CODE_BIN</code>",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.claude-code-exactly",
    page: "/docs/workers",
    anchor: ["<h3>3. What it does, exactly</h3>", '<code>claude -p --tools "" --max-turns 1 --no-session-persistence --output-format json --model … --system-prompt …</code>', "an <code>ANTHROPIC_API_KEY</code> in the same environment is withheld from it"],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.claude-code-cost",
    page: "/docs/workers",
    anchor: ["<h3>4. What it costs, and whose rules</h3>", "<em>You've hit your limit</em>", "the pool retries an audit three times", "read their consumer terms on automated and shared use"],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.secrets",
    page: "/docs/workers",
    anchor: [
      '<section id="secrets">', "<h2>What a build can see</h2>", "<b>the build sees nothing the log cannot show.</b>",
      "<h3>What the broker holds, and the builder does not</h3>", "<code>OMARCHY_BROKER</code> and a label",
      "<h3>What the pool checks anyway</h3>", "the build fails with the kind and the line (never the match)",
      "<h3>What you decide</h3>", "Keep <code>WORKER_SHARED</code> off",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.running",
    page: "/docs/workers",
    anchor: [
      '<section id="running">', "<h2>Keeping it running</h2>",
      '<div class="step" id="update"><h3>Update — every worker follows the latest image</h3>', "refused at the claim (<code>426</code>)", '<span class="pill warn">outdated</span>',
      "<code>OMARCHY_WORKER_ROLE=updater</code>", "<code>omarchy-worker update</code> runs one round now", "<code>factory/host/rollout.sh</code>",
      "<h3>Stop, remove, revoke</h3>", "<code>./omarchy-worker remove</code>",
      "<h3>Disk</h3>", "<code>docker system prune</code> / <code>podman system prune</code>",
      "<h3>Something is off</h3>", "<em>the pool did not accept this token</em>", "<em>registered for aarch64 but this machine is x86_64</em>", "<em>mount its socket</em>",
    ],
    visible: EVERYONE,
  },
];
