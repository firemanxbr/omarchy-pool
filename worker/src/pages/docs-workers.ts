/**
 * Run a worker: the legacy role containers a maintainer still runs beside
 * the hosts until P3 retires them — the image on GitHub Packages, its
 * roles, the sets already running, what a build can see, updates and
 * orders. Maintainers only (#331, epic #307): contributors do not run
 * workers; their packages build on the pool's hosts, which the maintainers
 * provide. A new machine joins as a host (worker-host.md, /docs/worker-host):
 * the contributor worker path — the one command the pool served, its
 * compose file, a worker's mode and per-worker trust — is gone (#343).
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const IMG = "ghcr.io/firemanxbr/omarchy-worker";

const BODY = String.raw`
  <h1>Run a worker</h1>
  <p class="lede" id="maintainers-only"><b>Maintainers only.</b> Contributors do not run workers: the project provides the workers for everyone, and its maintainers are their only providers. A maintainer is vetted by a pull request to <code>factory/MAINTAINERS.toml</code>, and their host is trusted by that same act; <code>POST /factory/workers</code> refuses anyone else, <em>your packages build on the pool's hosts</em> (<a href="/docs/factory#contribute-a-package">how packaging works</a>). A new machine joins the pool as a host — the signed host bundle and one isolated container per task, enrolled from the owner's page (<a href="/docs/worker-host">a maintainer's host</a>). What follows is for the legacy role containers a maintainer already runs beside the hosts, until P3 retires them (#343).</p>
  <p class="lede">Every build for the pool happens on a worker a maintainer runs, and every worker runs the <b>same image</b>: <code>${IMG}</code>, Arch Linux, built for x86_64 and aarch64 on GitHub Packages and signed. The <b>registration behind the token</b> decides what it may do. Nothing you run holds a key: the pool signs what it publishes, and your token only asks for work.</p>

  <section id="registration">
    <h2>What the registration decides</h2>
    <div class="table-wrap"><table><thead><tr><th>Your registration</th><th>What the container does</th><th>What it needs</th></tr></thead><tbody>
      <tr><td><b>community</b> trust — every registration starts here</td><td>builds any contributor's packages from the queue their requests land in, as a host does (#343), one task per container, right inside it, into the contributor's staging workspace as evidence for a maintainer; with your agent key (<code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code> or <code>XAI_API_KEY</code>) your agent drafts and corrects PKGBUILDs. It never sees a package in review or approved.</td><td>the token</td></tr>
      <tr><td><b>project</b> trust — the registrations two maintainers vouched for before a host's trust came from the maintainer list; none is trusted that way any more (#343)</td><td>the project's work: the pool's own jobs (sync, promote, health, security, gc, the PKGBUILD reconcile) and the rebuild of packages maintainers approved — what users actually get. Each build and check runs in a <em>fresh</em> Arch container it starts as a sibling. With an agent key it also <b>audits</b> staged builds for the maintainers (the second agent). Never a contributor's build.</td><td>the token, the runtime's socket, a working directory at the same path on both sides</td></tr>
    </tbody></table></div>
    <p class="sub">One registration per role of a machine. Tags: <code>latest</code> is a multi-architecture manifest (your machine pulls its own), <code>x86_64</code> and <code>aarch64</code> pin one, and every pool release is a tag (<code>v0.0.70</code>). Verify before trusting it:</p>
    <div class="steps"><div class="step"><pre>cosign verify ${IMG}:latest \
  --certificate-identity https://github.com/firemanxbr/omarchy-pool/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com</pre></div></div>
    <p class="sub">The identity is exact: the image was signed by <code>release.yml</code> on <code>main</code> of this repository, and nothing else passes. After a rollback the tags are signed by <code>rollback.yml@refs/heads/main</code>; the same command with that file checks them.</p>
  </section>

  <section id="roles">
    <h2>The three roles</h2>
    <p class="sub">The project runs its workers as three kinds of container, on its maintainers' hosts. A role is set with <code>OMARCHY_WORKER_ROLE</code>; it narrows what the registration allows, never widens it, and the container refuses to start under a registration that does not match (a <em>pool</em> or <em>review</em> role needs project trust, a <em>community</em> role a community registration). The <a href="/workers">Workers</a> page lists each worker under its role.</p>
    <div class="table-wrap"><table><thead><tr><th>Role</th><th>Registration</th><th>What it does</th><th>Agent key</th></tr></thead><tbody>
      <tr><td><b>pool</b></td><td>project trust</td><td>the pool's own jobs and nothing else: sync, render, promote, rollback, health, security, enqueue, gc, verify. Never a build, never an audit.</td><td>none</td></tr>
      <tr><td><b>review</b></td><td>project trust</td><td>the maintainers' work and nothing else: the rebuild of approved packages in fresh sibling containers, and the audit of every staged build (the second agent). Never a pool job.</td><td>wanted — without one, audits wait</td></tr>
      <tr><td><b>community</b></td><td>community registration</td><td>builds any contributor's requested packages with its maintainer's agent, one task per container, from the queue every request lands in.</td><td>required — a worker whose agent does not answer the probe is not ready and gets no build</td></tr>
    </tbody></table></div>
    <p class="sub">Two of each — one per architecture — is what the project runs on its own host (RUNBOOK, <em>The Studio host</em>): x86_64 pool jobs are only a label and run natively on any machine; x86_64 <em>builds</em> on an aarch64 host run under user-mode emulation, correct but slower. Without a role the trust decides everything: a project worker takes pool jobs, rebuilds and audits alike; a community worker builds contributors' packages.</p>
  </section>

  <section id="before">
    <h2>Before you start</h2>
    <div class="steps">
      <div class="step"><h3>A container runtime</h3><p><b>Docker Desktop</b> on macOS, Windows or Linux, or <b>Podman</b> — the <code>podman</code> command, or <a href="https://podman-desktop.io/">Podman Desktop</a> with its graphical window. Every command below is shown for both; they differ only in the first word. Give the runtime at least 2 CPUs and 4 GB of memory (Docker Desktop: <em>Settings → Resources</em>; Podman on macOS: <code>podman machine set --cpus 4 --memory 8192</code>); a browser-class package needs far more.</p></div>
      <div class="step"><h3>Which architecture you build</h3><p>A worker builds for its own architecture: an Apple silicon Mac or a Raspberry Pi builds <code>aarch64</code>, an Intel or AMD machine <code>x86_64</code>. Register the worker for the architecture of the machine it will run on; the image refuses a mismatch.</p></div>
      <div class="step"><h3>An account, a worker registration</h3><p>Sign in with GitHub (top right) as a maintainer: it lands on <b>your own page</b>, the workspace, where a maintainer has the worker form (nobody else does). Register a worker there, for a set you already run: a name and its architecture. You get a <b>token</b>, shown once — that set's identity. Revoke it on the same page if the machine is lost. A new machine is added as a host on the same page instead.</p></div>
    </div>
  </section>

  <section id="contributor">
    <h2>A community set, on a maintainer's host, until P3</h2>
    <div class="steps">
      <div class="step"><h3>1. The set, and its command</h3><p>The pool no longer serves a command that starts a new set, nor its compose file (#343): a new machine joins as a host. A set a maintainer already runs keeps running until P3 retires it, from its own directory (<code>~/.config/omarchy-worker</code> by default) — the compose file and the <code>.env</code> (mode 600) an earlier start wrote there — and <code>omarchy-worker</code>, which now lives in the repository (<a href="${REPO_URL}/blob/main/factory/host/omarchy-worker">factory/host/omarchy-worker</a>), runs it: three containers — the broker and the builder on a network of their own, the updater beside them. The <b>broker</b> holds what is yours — the worker token, your agent's key, a GitHub token — and only receives, processes and answers. The <b>builder</b> beside it is born with nothing: it asks the broker for a build of yours, builds it, uploads the package, the PKGBUILD and the log to your staging workspace through the broker, and exits; the restart policy starts the next one. The <b>updater</b> keeps both on the pool's latest image (<a href="#update">every worker follows it</a>).</p>
<pre>./omarchy-worker start --github-token &lt;github_pat_…, no permissions&gt;   # in the set's directory: start it again, or apply a changed option
./omarchy-worker status        # what runs here, what the pool thinks of it
./omarchy-worker logs          # the builder's log (logs broker | updater)
./omarchy-worker stop          # a drain: the build in hand finishes first</pre>
      <p>The same set by hand, with <a href="${REPO_URL}/blob/main/factory/image/compose.yml">compose.yml</a> and a <code>.env</code> beside it; the updater mounts the directory at the same path, so its absolute path goes in:</p>
<pre>printf 'OMARCHY_WORKER_TOKEN=%s\nGITHUB_TOKEN=%s\nOMARCHY_WORKER_DIR=%s\nCOMPOSE_PROFILES=community\n' omw_… github_pat_… "$PWD" &gt; .env
docker compose up -d           # podman compose works the same</pre>
      <p><b>--github-token</b> (on the broker): the drafter reads GitHub's API for every package it builds — the release, the files — through the broker. Without a token GitHub allows 60 requests an hour from your address, and a queue of ten builds is ten failures; a <a href="https://github.com/settings/personal-access-tokens/new">fine-grained token</a> with <em>no permissions at all</em> gives 5000. Make one for this — never <code>gh auth token</code>, which is your account with write access to your repositories (see <a href="#secrets">what a build can see</a>). A stop is a drain (compose: <code>stop_grace_period: 3h</code>): the build in hand finishes and reports; killed mid-build, the task waits half an hour for its lease to expire. Change the settings between builds, not during one.</p></div>
      <div class="step"><h3>2. Its work</h3><p>A contributor <a href="/factory#request">requests a package</a> (the project's URL, a description, the licence, the checklist). The build starts by itself, in the queue: the next host or community set of the architecture with room takes it, contributors' builds in turn by owner. <b>Build</b> on the contributor's page names a worker, sends a queued build back to the queue or takes it out, and runs it again. The <em>Builds</em> table follows it, and the <em>Workers</em> table shows it alive. When the build is staged, a maintainer sees it on <a href="/review">Review</a>.</p></div>
      <div class="step"><h3>3. Bring your agent</h3><p>On the broker (an option of <code>omarchy-worker start</code>; by hand, the same names in <code>.env</code>). There is no mode to set: a community set builds any contributor's packages, as a host does (#343).</p>
<pre># the broker: an agent drafts and corrects PKGBUILDs, with your key — the pool never holds one, the builder never sees it;
# one of these is enough (Anthropic, OpenAI, Gemini, xAI), --model picks the model
./omarchy-worker start --anthropic-key sk-… --model claude-sonnet-5   # or --openai-key / --gemini-key / --xai-key
                                                                      # (.env: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, FACTORY_MODEL)
# or your Claude subscription instead of a key (see "A Claude subscription as the agent" below)
./omarchy-worker start --claude-token …    # what 'claude setup-token' printed on your machine (.env: CLAUDE_CODE_OAUTH_TOKEN)</pre>
      <p>The <a href="/workers">Workers</a> page shows which agent each worker reported (<code>anthropic/claude-sonnet-5</code>, <code>claude-code/claude-sonnet-5</code>, <code>openai/gpt-5</code>, …); the key itself never leaves the broker.</p>
      <p>A worker with an agent is what turns a <em>package request</em> (the <a href="/factory#request">Factory's request card</a>) into a first PKGBUILD and a first build: the request lands in the queue the moment its record is written, and the next host or community set of the architecture with room takes it — a native lane first, an emulated one after its wait. Without one, requests wait, and the page says where they stand. A build whose toolchain cannot start under emulation (rustc, on a 16 KB-page host) goes back to the queue for a native worker, the attempt uncounted, and waits there until one is alive. What your agent produces is evidence like any other build: a maintainer reads it before anything reaches users.</p></div>
      <div class="step"><h3>4. Watch it</h3><p><code>./omarchy-worker status</code> says what runs here and what the pool thinks of it; <code>./omarchy-worker logs</code> follows the builder (<code>logs broker</code>, <code>logs updater</code> the others). The worker's own log — the lines between tasks: preparing, the agent's probe, an update required — also reaches the pool with each claim: the log icon beside its id on the <a href="/workers">Workers</a> page and on your page opens the last kilobytes, for its owner and the maintainers (a build's output is on the build's page). In <b>Docker Desktop</b>, <em>Containers</em> lists the three under the <code>omarchy-worker</code> project, each with a <em>Logs</em> tab; in <b>Podman Desktop</b>, the same under <em>Containers</em>. The builder exits after each task (that is by design) and the restart policy brings it back.</p>
      <div class="shot">Screenshot to add: Docker Desktop → Containers, the <code>omarchy-worker</code> project and the builder's Logs tab; Podman Desktop → Containers, the same.</div></div>
    </div>
  </section>

  <section id="project">
    <h2>As a maintainer: the pool's jobs and approved rebuilds</h2>
    <p class="sub">A registration with project trust — given on two maintainers' word before #343; who trusted it is in the worker id's tooltip on <a href="/workers">Workers</a>, and <code>POST /api/v1/factory/workers/&lt;id&gt;/trust</code> answers <code>410</code> now — switches the same image to the project's work. Each build and check runs in a fresh Arch container it starts as a sibling through your runtime — so it needs the runtime's socket, and a working directory that has the <b>same path</b> on your machine and inside the container (the sibling containers mount subdirectories of it).</p>
    <div class="steps">
      <div class="step"><h3>0. One command</h3><p>The same <code>omarchy-worker</code>, with that registration's token and <code>--project</code> (the updater beside it, as for a community set's):</p>
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
      <p>A project worker never builds a contributor's package: those run on the maintainers' hosts and their community sets. What it builds is the rebuild a maintainer approved — never one the same maintainer brought — and the pool signs the result.</p></div>
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
<pre># a community set's broker — the builder beside it never sees the token (docker works the same)
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
      <p>At start the broker installs Claude Code for its architecture (the official installer, checksum verified, into the container's home — about 200 MB, once per container; the image does not ship it) and reports <code>claude-code/claude-sonnet-5</code> as its agent on the <a href="/workers">Workers</a> page. <code>FACTORY_MODEL</code> picks another model (<code>claude-opus-5</code>); <code>FACTORY_REASONING=low</code> keeps a draft or an audit from thinking longer than it needs. A binary of your own, mounted at <code>/usr/local/bin/claude</code> or named by <code>CLAUDE_CODE_BIN</code>, skips the install.</p></div>
      <div class="step"><h3>3. What it does, exactly</h3><p>Every completion is one process: <code>claude -p --tools "" --max-turns 1 --no-session-persistence --output-format json --model … --system-prompt …</code>, the PKGBUILD and the log on stdin, in an empty directory. No tool is available to the model — it cannot read a file, run a command or reach the network; it answers, and the worker reads the answer. The token goes to the child process; an <code>ANTHROPIC_API_KEY</code> in the same environment is withheld from it, so choosing the subscription means the subscription.</p></div>
      <div class="step"><h3>4. What it costs, and whose rules</h3><p>Nothing on top of the subscription — and the subscription's limits apply: each draft and each audit is a message in the same five-hour and weekly windows as your own use of Claude, and a worker that hits the limit fails the task (<em>You've hit your limit</em>, back in the queue for the next window; the pool retries an audit three times). Your agreement with Anthropic is what allows this use: read their consumer terms on automated and shared use before you put the token on a community set or a project host — the API key (<code>ANTHROPIC_API_KEY</code>, a workspace with a spending limit in the Console) is the plain path, and switching is one variable.</p></div>
    </div>
  </section>

  <section id="secrets">
    <h2>What a build can see</h2>
    <p>A build is somebody else's code — the recipe, and the build system of the project it packages — and its log is public: on the API while the build is in staging, on the record once it is staged. So the rule the worker keeps, on your machine and on the project's: <b>the build sees nothing the log cannot show.</b></p>
    <div class="steps">
      <div class="step"><h3>What the broker holds, and the builder does not</h3><p>The worker's token, your agent's key, your <code>GITHUB_TOKEN</code> live in the broker, a container that runs no build: it passes the pool's calls for the one task it claimed (the job token the pool hands out stays with it), answers the agent in the Anthropic shape over whichever provider you gave it, and reads GitHub. The builder is born with nothing — <code>OMARCHY_BROKER</code> and a label — and dies after a task; a variable of yours set on it by mistake is dropped at start and said so. Inside the builder, the build user starts from an empty environment anyway, and a worker started the old way, with the token on it, keeps the token out of every child's environment and lends the key to the drafter alone. A PKGBUILD that prints <code>env</code> prints <code>PATH</code> and <code>HOME</code>.</p></div>
      <div class="step"><h3>What the pool checks anyway</h3><p>Every log, recipe and report uploaded to staging is read for what looks like a secret — the pool's tokens, agents' keys, GitHub's, a private key, a credential in a URL, a dump of the worker's variables — and refused if it carries one: the build fails with the kind and the line (never the match), and nothing reaches the record. That is for the worker the pool does not run; if it fires on yours, the container has something in its environment the worker did not put there — fix the container, queue the build again.</p></div>
      <div class="step"><h3>What you decide</h3><p>Give the broker a <code>GITHUB_TOKEN</code> made for it, with no permissions — not your account's. A community set runs strangers' recipes on this machine, each in a fresh container: give the broker no key you would mind losing. Do not mount your home or a directory of yours into the builder: it needs none. Caches, when you mount one, are kept per package inside — a build reads only what an earlier build of the same package wrote.</p></div>
    </div>
  </section>

  <section id="running">
    <h2>Keeping it running</h2>
    <div class="steps">
      <div class="step" id="update"><h3>Update — every worker follows the latest image</h3><p>The image follows the pool's releases, several a day, and a worker on an old one wastes everyone's time: it drafts the wrong version, links against the wrong objects, misses the rules the rest of the pool keeps. So the pool hands work only to workers on its release: one behind for longer than the rollout's grace (45 minutes after a deploy) is refused at the claim (<code>426</code>), shows <span class="pill warn">outdated</span> on the <a href="/workers">Workers</a> page and on its owner's, and the journal says so once per release. Nothing else changes: the moment it is updated, it works again.</p>
      <p><b>A revoked release</b> — one a later release names bad — is refused at the claim at once (<code>426</code> with <code>revoked: true</code>), whatever the grace, and a task already running on it is stopped by the pool's answer (<code>409</code>, state <code>revoked</code>) and goes back to the queue with its attempt given back (<a href="/docs/runbook#a-new-maintainer-host">Runbook</a>, <em>Revoking a release</em>). A task on any other older release finishes on the release it started with. One exception the other way: a host whose agent reverted the pool's release claims on its last-good for six hours, never below the signed minimum, and Status says until when.</p>
      <p>The <b>updater</b> is what keeps it there, and it is part of the set, not an option: a container of the same image (<code>OMARCHY_WORKER_ROLE=updater</code>) with the runtime's socket and the compose directory. It asks the pool every two minutes (<code>GET /api/v1/factory/follow</code>, with the ids of its set's workers and no token) and follows its release: when the pool's release changes — a release, or a rollback — it pulls the image and replaces what changed, the brokers first, each answering before the workers that call them — a stop is a drain, the build in hand finishes first — itself last, and only with an image under which what it replaced stays up. Without an answer from the pool it does the same every fifteen minutes. <code>omarchy-worker start</code> runs it; the compose file has it; <code>omarchy-worker update</code> wakes it for a round now (or runs one round, when no updater runs). The project's host (the Studio) runs the same service, and its <code>factory/host/rollout.sh</code> only wakes it. Without an updater, <code>docker compose pull &amp;&amp; docker compose up -d</code> by hand does it — until the next release.</p>
      <p><b>Update on the worker's page</b>: its set's updater does it within 2 minutes. Its owner or a maintainer presses it on <code>/worker/&lt;id&gt;</code> for a worker behind the pool's release; the order is never delivered to the worker — the updater sees it in its next poll, runs its round, and the order closes when the worker claims on the pool's release. The page says what rolls a worker's set out (<em>Its set</em>), and Update is greyed, with why, where nothing that follows the pool does: a host that rolls out by a timer of its own, an updater from before this, none at all.</p></div>
      <div class="step"><h3>Stop, remove, revoke</h3><p><code>./omarchy-worker stop</code> drains and stops the set (a build in hand finishes first); <code>./omarchy-worker remove</code> stops it and deletes the files here. The registration stays until you revoke it on your page (or a maintainer does); a revoked token claims nothing, immediately.</p></div>
      <div class="step"><h3>Disk</h3><p>Every task builds in a fresh container that is removed afterwards; images and package caches stay. <code>docker system prune</code> / <code>podman system prune</code> reclaims them. A project worker's working directory holds the upstream keyrings, a checkout of the repository and the last builds — safe to delete when the worker is stopped.</p></div>
      <div class="step"><h3>Something is off</h3><p><em>the pool did not accept this token</em>: it was revoked, or mistyped. <em>registered for aarch64 but this machine is x86_64</em>: register a worker for this machine. <em>mount its socket</em>: the registration is project-trusted and needs the runtime's socket (above). <em>permission denied … docker.sock</em>: add <code>--security-opt label=disable</code> (Podman) or check the socket path. <em>No task for a while</em>: a community worker takes contributors' builds only, a project worker the project's work only — and the queue may hold none of its kind. The <a href="/pipeline">Pipeline</a> lists every queued task, the <a href="/workers">Workers</a> page every worker the pool has heard from.</p></div>
    </div>
  </section>

  <section id="orders">
    <h2>When the pool steps in: orders</h2>
    <p class="sub">The pool sees every worker's claims, so it knows before anyone when one has stopped working. It says so with an <b>order</b>, carried on the answer to the worker's own next claim: nothing new listens on your machine, and nothing reaches it but its own token's answers. The worker checks whether the order is still needed, carries it out or refuses it, and answers; the order, who gave it, why and how it ended are on the worker's page, <code>/worker/&lt;id&gt;</code>, and in the journal.</p>
    <div class="table-wrap"><table><thead><tr><th>Order</th><th>Who carries it out</th><th>What it does</th></tr></thead><tbody>
      <tr><td><b>Re-check agent</b></td><td>the worker</td><td>asks its agent now, instead of at its next re-check, and answers with what the agent said</td></tr>
      <tr><td><b>Restart</b></td><td>the worker, then its restart policy</td><td>the worker ends with exit 75 and its restart policy starts it again, a new process with a fresh agent client; "only if its agent is down" makes it ask its agent first and refuse when the agent answers. A builder behind a broker ends with 0, and its broker starts again beside it</td></tr>
      <tr><td><b>Restart agent service</b></td><td>a worker whose agent is a service beside it</td><td>restarts that service on its own engine (the project host's <code>agent-proxy</code>), waits for it, and asks its agent again; one worker of the host does it for all of them</td></tr>
      <tr><td><b>Drain</b></td><td>the pool</td><td>hands the worker nothing from its next claim until someone resumes it — a task in hand runs to its end; whatever its image, and across its restarts. Its first claim hears it once. Builds asked for it by name go to the queue after 3 minutes, and nobody can pin a new one to it</td></tr>
      <tr><td><b>Resume</b></td><td>the pool</td><td>ends a drain: the worker is handed work again from its next claim</td></tr>
      <tr><td><b>Stop its task</b></td><td>the pool, then the worker</td><td>takes back the task the worker runs, for one that hangs: nothing of it is taken any more, and the worker stops it when its next heartbeat hears so (below); the task goes back to the queue once the worker has stopped it. Nothing is cancelled</td></tr>
      <tr><td><b>Update</b></td><td>its set's updater</td><td>never delivered to the worker: the updater beside it sees the order in its next poll (every two minutes) and replaces every service of the set that runs an older image, the brokers first, each stop a drain; the order is done when the worker claims on the pool's release (<a href="#update">Update</a>)</td></tr>
    </tbody></table></div>
    <div class="steps">
      <div class="step"><h3>Who gives them</h3><p>The pool, by itself (below); the worker's owner, on the worker's page or with <code>POST /factory/workers/&lt;id&gt;/orders</code>; any maintainer, on any worker. None of them needs a passkey: an order publishes nothing and decides nothing, and another order undoes it. Every one is bounded — six restarts, six re-checks and six drains an hour per worker, twenty orders an hour per login; a Resume is never counted, so a drain can always be undone — and on the journal with who gave it; one its worker has not taken yet can be cancelled from the page. A drain and a stop hold from the moment they are given: a Resume ends a drain, and a stop ends when its task is back in the queue. Who resumes: a project worker, any maintainer — its owner, when not a maintainer, only a drain of their own; a community set's worker, its owner — and a maintainer only when a maintainer drained it, since putting a machine back to work is its owner's word (a maintainer who must keep it out revokes it). The times the pool writes in its answers are its own, in UTC; the page says them on your clock.</p></div>
      <div class="step"><h3>What the pool does by itself</h3><p>A worker whose agent stops answering re-checks it by itself: 15 s, doubling, up to every 30 minutes. When that is not enough, the pool steps in, one step at a time. After <b>5 minutes</b> not ready, if the worker's own re-check has stalled, the pool re-checks it once. After <b>10 minutes</b>, if the error is one a restart can help — the agent refused the connection, its name did not resolve, its install is broken, the service beside it does not answer — it restarts the worker, or the agent service through it, only if the agent still does not answer; a second time 30 minutes later; after that it stops, and the page says a person looks. It never restarts a process under 2 minutes old, and never more than three times a day per worker.</p>
      <p>An error a restart cannot help — a key refused, credit out, a rate limit, the provider's own failure — gets no order at all, and the page says why. When workers at <b>three sites</b> fail on the same provider at once, the pool takes it for the provider's outage, not theirs, and orders nothing for that provider until fewer than two are failing for 15 minutes. A worker's error is its own word, so the project's workers are held only by the project's own sites; community sets' workers, by every site. At one site, one worker is restarted at a time, five minutes apart — a site is your host as <em>your</em> workers name it, never shared with another person's; across the pool, ten restarts an hour and sixty orders a day at most, of which community sets' workers take six and forty: the project's workers always keep the rest. <code>WORKER_RULES = "off"</code> in the pool's configuration stops the pool's own orders; people's still work.</p></div>
      <div class="step"><h3>What a restart needs from you</h3><p>A <b>restart policy</b> that starts the container again: <code>--restart unless-stopped</code>, as every command on this page has it, or <code>restart: unless-stopped</code> in compose. A worker checks its own container's policy and says what it can survive: without a policy it takes no restart, and the page says why. Under <code>on-failure:N</code>, every exit spends one of the N for the container's whole life — a healthy run in between gives none back — so it takes a restart only with three or more left, and the page shows how many. <code>pkg-repo work</code> run outside a container, under a supervisor that starts it again (a systemd unit with <code>Restart=always</code>), says so with <code>OMARCHY_SUPERVISED=1</code>.</p>
      <p><code>AGENT_RETRY_FIRST_SECONDS</code> sets a project worker's first re-check after a failed probe (15 s by default, up to 30 minutes; a community builder's is <code>AGENT_RETRY_SECONDS</code>); it only makes the worker wait longer, never ask more often. A Claude Code that does not answer <code>claude --version</code> — an install cut short — is removed and installed again when its container starts, so a restart fixes that too.</p></div>
      <div class="step" id="stop"><h3>A task that hangs: Stop its task</h3><p>A worker busy with a task takes no order: every other one waits for the task in hand. <b>Stop its task</b>, on the worker's page, is for one that hangs, and its owner or any maintainer presses it — the owner of the build, if not the worker's, cannot. The pool takes the task back at once: it stays the worker's, so no other worker gets it, but nothing it sends is taken any more — its heartbeats, its report, its uploads — and nothing renews its lease. The worker hears it at its next heartbeat, within 5 minutes: a build, a trial, an audit or a check stops within seconds while its container or script runs — the worker kills its process group, then removes every container labelled with the task, one it only created included —; a build already uploading, a trial publishing into the lab, or a pool job the worker runs in its own process stops at its next call to the pool. A community builder stops its build and ends its container; its broker lets the task go and never takes it up again. The worker's next claim gives the task back to the queue — or the lease's end does, at most 30 minutes after the stop, for a worker too old to stop on the pool's word: a worker says it stops on it by declaring <code>stop-task</code> with its claim, as every image from this part of #277 on does. Nothing is cancelled: the task runs again, on this worker or another, and a stop counts with the restarts (six an hour per worker).</p></div>
      <div class="step" id="watchdog"><h3>A worker that wedges</h3><p>A project worker (<code>pkg-repo work</code>) that makes no progress — no claim between tasks, no heartbeat the pool accepted in a task — for <b>20 minutes</b> (35 in a task: the lease plus one heartbeat) exits 75, when a restart policy starts it again, after stopping the task in hand as above; without one it only says so, at each wait. The wait doubles with each such exit of the container — 40, 80, … up to a day —, counted in its own layer, so at most six in a day; the next process tells the pool, and the worker's page and Status show it from the second. A day of work without one starts the count again.</p></div>
    </div>
  </section>
`;

export function docsWorkersHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/docs/workers",
    title: "Run a worker · omarchy-pool",
    description: "The container images on GitHub Packages and how to run them with Docker Desktop or Podman, on a maintainer's host: contributors do not run workers.",
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
      '<details open><summary><a href="/docs/workers" class="on">Run a worker</a><small>9</small></summary>',
      'href="/docs/workers#registration"', 'href="/docs/workers#roles"', 'href="/docs/workers#before"', 'href="/docs/workers#contributor"',
      'href="/docs/workers#project"', 'href="/docs/workers#claude-code"', 'href="/docs/workers#secrets"', 'href="/docs/workers#running"', 'href="/docs/workers#orders"',
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
    anchor: ["<h1>Run a worker</h1>", '<p class="lede" id="maintainers-only"><b>Maintainers only.</b> Contributors do not run workers', "<em>your packages build on the pool's hosts</em>", '<a href="/docs/factory#contribute-a-package">how packaging works</a>', '<p class="lede">', `<code>${IMG}</code>`, "<b>registration behind the token</b>"],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.registration-table",
    page: "/docs/workers",
    anchor: [
      '<section id="registration">', "<h2>What the registration decides</h2>",
      "<th>Your registration</th><th>What the container does</th><th>What it needs</th>",
      "<td><b>community</b> trust", "<td><b>project</b> trust", "builds any contributor's packages from the queue their requests land in, as a host does (#343)",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.tags-and-cosign",
    page: "/docs/workers",
    anchor: [
      "<code>latest</code> is a multi-architecture manifest", "<code>x86_64</code> and <code>aarch64</code> pin one",
      `<pre>cosign verify ${IMG}:latest`, "--certificate-identity https://github.com/firemanxbr/omarchy-pool/.github/workflows/release.yml@refs/heads/main",
      "--certificate-oidc-issuer https://token.actions.githubusercontent.com", "<code>rollback.yml@refs/heads/main</code>",
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
      '<section id="contributor">', "<h2>A community set, on a maintainer's host, until P3</h2>", "<h3>1. The set, and its command</h3>",
      "The pool no longer serves a command that starts a new set, nor its compose file (#343)", `href="${REPO_URL}/blob/main/factory/host/omarchy-worker"`,
      "./omarchy-worker start --github-token", `href="${REPO_URL}/blob/main/factory/image/compose.yml"`,
      "COMPOSE_PROFILES=community", "docker compose up -d",
      'href="https://github.com/settings/personal-access-tokens/new"', 'href="#secrets"', "<code>stop_grace_period: 3h</code>",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.contributor-work",
    page: "/docs/workers",
    anchor: ["<h3>2. Its work</h3>", '<a href="/factory#request">requests a package</a>', "The build starts by itself, in the queue", "contributors' builds in turn by owner", "<b>Build</b> on the contributor's page names a worker", '<a href="/review">Review</a>'],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.contributor-agent",
    page: "/docs/workers",
    anchor: [
      "<h3>3. Bring your agent</h3>", "There is no mode to set",
      "./omarchy-worker start --anthropic-key sk-… --model claude-sonnet-5", "ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, FACTORY_MODEL",
      "./omarchy-worker start --claude-token …", "CLAUDE_CODE_OAUTH_TOKEN",
      'the <a href="/factory#request">Factory\'s request card</a>', "a native lane first, an emulated one after its wait",
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
      "<code>POST /api/v1/factory/workers/&lt;id&gt;/trust</code> answers <code>410</code> now", "the <b>same path</b> on your machine and inside the container",
    ],
    // Per-worker trust is gone (#343): its door answers 410 to everyone, a maintainer too.
    acts: [
      { method: "POST", path: `/api/v1/factory/workers/${F.worker}/trust`, body: { trust: "project" }, expect: { anonymous: 410, contributor: 410, owner: 410, maintainer: 410 } },
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
      "<h3>What you decide</h3>", "A community set runs strangers' recipes on this machine",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.running",
    page: "/docs/workers",
    anchor: [
      '<section id="running">', "<h2>Keeping it running</h2>",
      '<div class="step" id="update"><h3>Update — every worker follows the latest image</h3>', "refused at the claim (<code>426</code>)", '<span class="pill warn">outdated</span>',
      "<b>A revoked release</b>", "(<code>426</code> with <code>revoked: true</code>), whatever the grace", "(<code>409</code>, state <code>revoked</code>)", "claims on its last-good for six hours",
      "<code>OMARCHY_WORKER_ROLE=updater</code>", "<code>GET /api/v1/factory/follow</code>", "<code>omarchy-worker update</code> wakes it for a round now", "<code>factory/host/rollout.sh</code> only wakes it",
      "<b>Update on the worker's page</b>: its set's updater does it within 2 minutes.",
      "<h3>Stop, remove, revoke</h3>", "<code>./omarchy-worker remove</code>",
      "<h3>Disk</h3>", "<code>docker system prune</code> / <code>podman system prune</code>",
      "<h3>Something is off</h3>", "<em>the pool did not accept this token</em>", "<em>registered for aarch64 but this machine is x86_64</em>", "<em>mount its socket</em>",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.orders",
    page: "/docs/workers",
    anchor: [
      '<section id="orders">', "<h2>When the pool steps in: orders</h2>", "<code>/worker/&lt;id&gt;</code>",
      "<td><b>Re-check agent</b></td>", "<td><b>Restart</b></td>", "<td><b>Restart agent service</b></td>", "<td><b>Drain</b></td>", "<td><b>Resume</b></td>", "<td><b>Stop its task</b></td>", "<td><b>Update</b></td><td>its set's updater</td>",
      '<div class="step" id="stop">', "<h3>A task that hangs: Stop its task</h3>", '<div class="step" id="watchdog">', "<h3>A worker that wedges</h3>",
      "<h3>Who gives them</h3>", "<code>POST /factory/workers/&lt;id&gt;/orders</code>", "twenty orders an hour per login",
      "<h3>What the pool does by itself</h3>", "15 s, doubling, up to every 30 minutes", "<b>three sites</b>", '<code>WORKER_RULES = "off"</code>',
      "<h3>What a restart needs from you</h3>", "<code>--restart unless-stopped</code>", "<code>on-failure:N</code>", "<code>OMARCHY_SUPERVISED=1</code>", "<code>AGENT_RETRY_FIRST_SECONDS</code>",
    ],
    visible: EVERYONE,
  },
];
