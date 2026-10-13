/**
 * Run a host: what a maintainer's machine runs to give the pool its compute
 * — the signed host bundle, its one service (the dispatcher) and one
 * isolated, credential-less container per task — and how it joins: the
 * hosting requirement, prep-root.sh, enrollment and Confirm; its capacity
 * and lanes; a Claude subscription as its agent; what a task can see; how it
 * stays on the pool's release; when the pool steps in. Maintainers only
 * (#331, epic #307): contributors do not run workers, their packages build
 * on the pool's hosts. The legacy registrations from before hosts, their role
 * containers, the updater and the command that ran a worker are gone (#343,
 * #346); a host is the only way a machine joins. The longer reference is the
 * worker-host chapter (worker-host.md, /docs/worker-host) and the runbook's
 * *A new maintainer host*.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const IMG = "ghcr.io/firemanxbr/omarchy-worker";

const BODY = String.raw`
  <h1>Run a host</h1>
  <p class="lede" id="maintainers-only"><b>Maintainers only.</b> Contributors do not run workers: the project provides the workers for everyone, and its maintainers are their only providers. A maintainer is vetted by a pull request to <code>factory/MAINTAINERS.toml</code>, and their host is trusted by that same act; <code>POST /factory/workers</code> refuses anyone else, <em>your packages build on the pool's hosts</em> (<a href="/docs/factory#contribute-a-package">how packaging works</a>), and since the legacy registrations retired it answers <code>410</code> to a maintainer too (#346): a machine joins the pool as a host, enrolled from its owner's page.</p>

  <section id="hosts">
    <h2>The project's compute is its maintainers' hosts</h2>
    <p class="sub">A host is a maintainer's machine — a VPS, a VM, hardware of their own — running <b>one bundle</b>: the host agent, which keeps it on the pool's signed release, and one service, the <b>dispatcher</b>. No container is fixed to a role. The dispatcher claims from the pool as many tasks as the host's capacity allows and runs <b>each task in its own isolated container, born with nothing</b>: no token, no key, no socket. A review is the same, a second opinion by another agent in a fresh container. What no host has room for waits in the pool's queue, never on a host, and <b>adding hosts is how the pool grows</b>. The <a href="/workers">Workers</a> page lists every host with its lanes, units, tasks, release and isolation level.</p>
  </section>

  <section id="image">
    <h2>The image, signed</h2>
    <p class="sub">The host's containers run one image, <code>${IMG}</code>, Arch Linux, built for x86_64 and aarch64 on GitHub Packages and signed; the host bundle names it by digest, so a host runs exactly what the release pinned. Its roles are the bundle's: the <b>dispatcher</b> (<code>pkg-repo dispatch</code>), a task's <b>egress</b> sidecar (<code>pkg-repo egress</code>, public addresses only) and a task's <b>agent</b> sidecar (<code>factory/bin/broker</code>: the agent and GitHub read-only, for that task only). The task containers start from the build image by digest. Tags: every pool release is one (<code>v1.1.0</code>), and <code>latest</code>, <code>x86_64</code> and <code>aarch64</code> stay published and signed. Verify before trusting it:</p>
    <div class="steps"><div class="step"><pre>cosign verify ${IMG}:latest \
  --certificate-identity https://github.com/firemanxbr/omarchy-pool/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com</pre></div></div>
    <p class="sub">The identity is exact: the image was signed by <code>release.yml</code> on <code>main</code> of this repository, and nothing else passes. After a rollback the tags are signed by <code>rollback.yml@refs/heads/main</code>; the same command with that file checks them. The host agent checks the bundle itself against the same identity before it applies a release.</p>
  </section>

  <section id="before">
    <h2>Before you start: the hosting requirement</h2>
    <div class="steps">
      <div class="step"><h3>A machine that runs nothing else of yours</h3><p>Every host runs every contributor's recipes, so where the agent runs matters. A host qualifies one of two ways: <b>a dedicated machine or VM</b> (<code>--dedicated</code> at install) — a VPS, a KVM guest, hardware used only as a pool host; a rootful docker there also gets <code>userns-remap</code>, so a container escape lands in an unprivileged uid — or <b>a shared machine with a dedicated Unix user</b> (<code>omarchy</code>, not your daily login) running rootless podman, whose task containers map root to a subuid range that owns nothing. Your daily login on a workstation is refused: an escape there would reach your GitHub session, your SSH keys and your passkeys.</p></div>
      <div class="step"><h3>The minimum to join</h3><p>4 CPUs, 8 GB of memory, 60 GB free on the work root and 40 GB on the engine's data root, the release's signed constants; the install's preflight checks them and refuses a machine below. A Mac (Apple silicon) joins through its own <code>omarchy</code> VM, which must get 4 CPUs and 8 GB.</p></div>
      <div class="step"><h3>Once, as root: prep-root.sh</h3><p>The root-only steps a new Linux host needs, which the agent never runs — the runtime and qemu's binfmt handlers, the docker group, docker's address pools, <code>userns-remap</code> on a new daemon, the work root (a btrfs subvolume where it can be), linger for the agent's user, cgroup delegation for rootless podman, and the task firewall that drops the task subnets to your LAN and to the host:</p>
<pre>sudo factory/host/prep-root.sh --user omarchy --work-root /srv/omarchy-pool/host   # --runtime rootless for podman; --dry-run to see first</pre>
      <p>Each step is idempotent; a second run changes nothing. A Mac runs <code>factory/host/prep-mac.sh</code> instead, as its own user (Colima and Lima from Homebrew, and the VM's three directories). The script is in the repository: <a href="${REPO_URL}/blob/main/factory/host/prep-root.sh">factory/host/prep-root.sh</a>.</p></div>
    </div>
  </section>

  <section id="add">
    <h2>Adding a host</h2>
    <div class="steps">
      <div class="step"><h3>1. On your page: + add a host</h3><p>Signed in as a maintainer, on your own page: a name and where it runs. The pool checks you are in <code>factory/MAINTAINERS.toml</code> again and answers one command with a one-time token (<code>ome_…</code>, valid 15 minutes, once), bound to your login and your GitHub user id:</p>
<pre>curl --proto '=https' --tlsv1.2 -fsSL https://github.com/firemanxbr/omarchy-pool/releases/download/vX.Y.Z/install.sh | OMARCHY_ENROLL=ome_… sh</pre>
      <p>The token rides the environment of <code>sh</code>, never a process's arguments, so <code>ps</code> never shows it.</p></div>
      <div class="step"><h3>2. On the machine: install, preflight, enroll</h3><p>As the user the agent runs as (never root): the install's <b>preflight</b> says on one screen everything to fix — capacity, the hosting requirement, the engine, an egress probe the way a task runs — and writes nothing until it passes. Then it makes the host key (<code>host.ed25519</code>, mode 0600, never in a container), enrolls with the token and prints the key's fingerprint.</p></div>
      <div class="step"><h3>3. On your page: Confirm</h3><p>Your page shows the host with the same fingerprint and <b>Confirm</b>. Compare the two, then confirm: the host gets its one worker registration, the journal and Status say so, and the other maintainers see a notice. Nothing claims before that. The agent then fetches the host's worker token into a read-only file only the dispatcher mounts, writes its <code>systemd --user</code> unit (a LaunchAgent on a Mac) and starts the dispatcher; from then on nothing on the machine needs you. <a href="/docs/worker-host#maintainer-hosts">The worker host chapter</a> has every step and option.</p></div>
    </div>
  </section>

  <section id="capacity">
    <h2>Capacity and lanes</h2>
    <p class="sub">The agent detects what the machine has and counts it in <b>units</b>: a build takes 2 per size, a trial 2, an audit 1, and one unit stays for the pool's own jobs. The pool hands a host one task per claim and its dispatcher claims again at once while units are free; before each claim it checks the memory available, so a machine you also use takes only what still fits. <b>Native first</b>: a host builds its own architecture natively and, when the kernel has qemu's binfmt handler (<code>prep-root.sh</code> installs it), the other one on an <b>emulated lane</b> — slower, and never left out: while no host runs an architecture natively, each host that can keeps one of its builds moving. Your envelope (<code>agent.toml</code>, at the host) caps what the machine gives; the <b>pool cap</b> on the host's page lowers what the pool hands it, and the page narrows its units or turns its emulated lanes off inside that envelope.</p>
  </section>

  <section id="claude-code">
    <h2>A Claude subscription as the agent</h2>
    <p class="sub">A task that needs a model — a draft, the project's rebuild, an audit — gets its own <b>agent sidecar</b>, which reads the agent keys from <code>OMARCHY_SECRETS_DIR/agent.env</code>, read-only; the dispatcher never holds them. An API key works there (<code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, <code>XAI_API_KEY</code>), and so does a Claude Pro or Max subscription: the sidecar runs <b>Claude Code in print mode</b> — <code>claude -p</code>, no tools, no session, the report as JSON — with a token from your own login.</p>
    <div class="steps">
      <div class="step"><h3>1. A token, on your machine</h3><p>With Claude Code installed and logged in on the machine you use (not the host), run</p>
<pre>claude setup-token</pre>
      <p>It opens the browser for a one-time consent and prints a long-lived token (<code>sk-ant-oat01-…</code>). That token is your subscription: keep it like a password, revoke it from your Claude account when a machine is lost.</p></div>
      <div class="step"><h3>2. Give it to the host</h3><p>At install (<code>--agent-env-from</code>), in the secrets directory's <code>agent.env</code> by hand, or sealed to the host from its page with your passkey (<em>Set agent keys</em>):</p>
<pre>CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
FACTORY_PROVIDER=claude-code</pre>
      <p>Each sidecar installs Claude Code for its architecture at its start (the official installer, checksum verified; the image does not ship it) and reports <code>claude-code/claude-sonnet-5</code> as the host's model. <code>FACTORY_MODEL</code> picks another model; <code>FACTORY_REASONING=low</code> keeps a draft or an audit from thinking longer than it needs.</p></div>
      <div class="step"><h3>3. What it does, exactly</h3><p>Every completion is one process: <code>claude -p --tools "" --max-turns 1 --no-session-persistence --output-format json --model … --system-prompt …</code>, the PKGBUILD and the log on stdin, in an empty directory. No tool is available to the model — it cannot read a file, run a command or reach the network; it answers, and the sidecar hands the answer to its task. An <code>ANTHROPIC_API_KEY</code> in the same file is withheld from it, so choosing the subscription means the subscription.</p></div>
      <div class="step"><h3>4. What it costs, and whose rules</h3><p>Nothing on top of the subscription — and the subscription's limits apply: each draft and each audit is a message in the same five-hour and weekly windows as your own use of Claude; a task that hits the limit fails (<em>You've hit your limit</em>) and goes back to the queue, and the pool retries an audit three times. Every sidecar is capped per task (calls, tokens, minutes) and the host per day. Your agreement with Anthropic is what allows this use: read their consumer terms on automated and shared use before you put the token on a host — an API key is the plain alternative.</p></div>
    </div>
  </section>

  <section id="secrets">
    <h2>What a task can see</h2>
    <p>A task runs somebody else's code — the recipe, and the build system of the project it packages — and its log is public. So the rule a host keeps is that <b>a task is born with nothing</b>: nothing the log could show is in it.</p>
    <div class="steps">
      <div class="step"><h3>What the task container holds: nothing</h3><p>The dispatcher starts every task container through one function: no token of any kind, no agent key, no runtime socket, not the work root nor another task's directory, every capability dropped but the few pacman and makepkg need, its share of CPUs, memory and pids. It calls no pool: the dispatcher stages its inputs before it starts and uploads only the files its kind may upload after it exits, and the pool signs what is published. Its network is its own and internal; its one way out is its <b>egress sidecar</b>, which allows public addresses only (never your LAN, cloud metadata, another task or the host), and a task that needs a model reaches its own <b>agent sidecar</b> and nothing else (<a href="/docs/security-model#isolation">the security model's Isolation</a>).</p></div>
      <div class="step"><h3>What the pool checks anyway</h3><p>Every log, recipe and report uploaded to staging is read for what looks like a secret — the pool's tokens, agents' keys, GitHub's, a private key, a credential in a URL, a dump of variables — and refused if it carries one: the build fails with the kind and the line (never the match), and nothing reaches the record.</p></div>
      <div class="step"><h3>What you decide</h3><p>Give the host a <code>GITHUB_TOKEN</code> with no scope at all (a classic token that reads public repositories only; install refuses one with a scope), and a separate, spend-capped key for contributors' drafts: a recipe that subverts its draft's sidecar can use that key until its caps stop it. Install gVisor or Kata Containers and the dispatcher runs what a contributor wrote in that sandbox; the host's page shows the isolation level and the sandbox it applies.</p></div>
    </div>
  </section>

  <section id="running">
    <h2>Keeping it running</h2>
    <div class="steps">
      <div class="step" id="update"><h3>Update — every host follows the pool's release</h3><p>The host's agent asks the pool which release to run, verifies the signed bundle and rolls it out with a guard that goes back to the last good one if the new one does not come up; the agent replaces itself the same way, upward only, and nothing on the machine needs you. A release never interrupts a task: the dispatcher re-adopts the tasks it runs. The pool hands work only to a host on its release: one behind for longer than the rollout's grace (45 minutes after a deploy, or until its owner's soak ends) is refused at the claim (<code>426</code>) and shows <span class="pill warn">outdated</span> on the <a href="/workers">Workers</a> page and its own; one whose guard reverted the pool's release claims on its last-good for six hours.</p>
      <p><b>A revoked release</b> — one a later release names bad — is refused at the claim at once (<code>426</code> with <code>revoked: true</code>), whatever the grace, and a task already running on it is stopped by the pool's answer (<code>409</code>, state <code>revoked</code>) and goes back to the queue with its attempt given back (<a href="/docs/runbook#a-new-maintainer-host">Runbook</a>, <em>Revoking a release</em>). A host never goes below the highest release it applied on the pool's word alone: only on a rollback statement <code>rollback.yml</code> signs.</p></div>
      <div class="step"><h3>Drain, suspend, retire</h3><p>On the host's page, <code>/hosts/&lt;id&gt;</code>: <b>Drain</b> lets its tasks finish and takes nothing new until you resume it; <b>Suspend</b> (its owner or any maintainer, with a reason) stops its claims at once and fences its running tasks; <b>Retire</b> burns its key and its worker token. If a pull request takes you off <code>factory/MAINTAINERS.toml</code>, your hosts stop claiming at the next sync and their running tasks finish.</p></div>
      <div class="step"><h3>Disk</h3><p>Every task runs in a fresh container that the dispatcher removes after it; its budgets keep both disks above their floor, and a host whose disk falls under it takes nothing until it is freed. The host's page shows the free disk on the work root and on the engine's data root.</p></div>
      <div class="step"><h3>Something is off</h3><p>The host's page has a <b>Needs a person</b> box: what only someone at the machine (or you, on the site) can fix — your Confirm, a suspension, below the minimum, the disk under its floor, an emulated lane held for binfmt, limits the runtime does not enforce, the hosting requirement its isolation level does not meet, the engine refusing the agent's user. <code>omarchy-agent status</code> on the machine says the same.</p></div>
    </div>
  </section>

  <section id="orders">
    <h2>When the pool steps in: orders</h2>
    <p class="sub">Nothing listens on a host: the pool reaches it only through what its own agent and dispatcher ask. The agent asks for the host's state every two minutes or so and takes the <b>host orders</b> given on the host's page; the dispatcher's claims carry the orders given to its registration on its worker's page, <code>/worker/&lt;id&gt;</code>. Each is on the page with who gave it, why and how it ended, and in the journal.</p>
    <div class="table-wrap"><table><thead><tr><th>Order</th><th>Who carries it out</th><th>What it does</th></tr></thead><tbody>
      <tr><td><b>Reconcile now</b></td><td>the agent</td><td>runs a round at its next poll: the pool's release, the host's settings</td></tr>
      <tr><td><b>Settings</b></td><td>the agent</td><td>narrows the units the host gives or turns its emulated lanes off, always inside the owner's envelope; a task already running finishes</td></tr>
      <tr><td><b>Retry release</b>, <b>Rotate token</b>, <b>Diagnostics</b></td><td>the agent</td><td>tries a release its guard reverted again; gives the dispatcher a new worker token; brings the dispatcher's last log lines, scrubbed, when the envelope allows it</td></tr>
      <tr><td><b>Re-check agent</b></td><td>the dispatcher</td><td>a fresh probe sidecar asks the host's model now; the pool never restarts a dispatcher for its agent</td></tr>
      <tr><td><b>Drain</b>, <b>Resume</b></td><td>the pool</td><td>hands the host nothing from its next claim until someone resumes it; a task in hand runs to its end</td></tr>
      <tr><td><b>Stop its task</b>, <b>Stop</b> on a lease</td><td>the pool, then the dispatcher</td><td>takes back one task that hangs: the dispatcher stops its container and the task goes back to the queue; the others run on. Nothing is cancelled</td></tr>
    </tbody></table></div>
    <div class="steps">
      <div class="step"><h3>Who gives them</h3><p>The host's owner and any maintainer; a few are the owner's alone (a resume after their own suspension, a widening of the envelope, sealed agent keys), with a passkey. None publishes anything, and each is bounded: the agent itself takes host orders at least two seconds apart and at most twenty an hour, whatever the pool sends (<a href="/docs/worker-host#settings-and-host-orders">Settings and host orders</a>).</p></div>
    </div>
  </section>
`;

export function docsWorkersHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/docs/workers",
    title: "Run a host · omarchy-pool",
    description: "How a maintainer's machine becomes a pool host: the hosting requirement, prep-root.sh, enrollment and Confirm, capacity and lanes, what a task can see, releases and orders. Contributors do not run workers.",
    active: "docs",
    doc: "workers",
    body: BODY,
    poolUrl,
    version,
  });
}

/**
 * What /docs/workers is made of. A chapter is prose: every section, table
 * and step card gets its anchor and nothing changes with the role. Two
 * things reach past the page and are checked as such: the legacy
 * registration's door, which answers 410 to a maintainer and 403 to a
 * contributor since #346, and per-worker trust, gone since #343. The header,
 * the footer and the docs search are the shell's entries.
 */
export const DOCS_WORKERS_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "docs-workers.lede",
    page: "/docs/workers",
    anchor: ["<h1>Run a host</h1>", '<p class="lede" id="maintainers-only"><b>Maintainers only.</b>', "<em>your packages build on the pool's hosts</em>", "answers <code>410</code> to a maintainer too (#346)"],
    // No legacy registration is made any more (#346): a contributor reads that their packages build on the pool's hosts, a maintainer that the door is gone.
    acts: [{ method: "POST", path: "/api/v1/factory/workers", body: { name: "box", arch: F.arch }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 410 } }],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.hosts",
    page: "/docs/workers",
    anchor: ['<section id="hosts">', "<h2>The project's compute is its maintainers' hosts</h2>", "<b>one bundle</b>", "<b>each task in its own isolated container, born with nothing</b>", "<b>adding hosts is how the pool grows</b>", '<a href="/workers">Workers</a>'],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.image",
    page: "/docs/workers",
    anchor: [
      '<section id="image">', "<h2>The image, signed</h2>", `<code>${IMG}</code>`, "<code>pkg-repo dispatch</code>", "<code>pkg-repo egress</code>", "<code>factory/bin/broker</code>",
      `cosign verify ${IMG}:latest`, "--certificate-identity https://github.com/firemanxbr/omarchy-pool/.github/workflows/release.yml@refs/heads/main", "<code>rollback.yml@refs/heads/main</code>",
    ],
    // Per-worker trust is gone (#343): its door answers 410 to everyone, a maintainer too.
    acts: [{ method: "POST", path: `/api/v1/factory/workers/${F.worker}/trust`, body: { trust: "project" }, expect: { anonymous: 410, contributor: 410, owner: 410, maintainer: 410 } }],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.before",
    page: "/docs/workers",
    anchor: [
      '<section id="before">', "<h2>Before you start: the hosting requirement</h2>",
      "<h3>A machine that runs nothing else of yours</h3>", "<b>a dedicated machine or VM</b>", "<b>a shared machine with a dedicated Unix user</b>", "Your daily login on a workstation is refused",
      "<h3>The minimum to join</h3>", "4 CPUs, 8 GB of memory, 60 GB free on the work root and 40 GB on the engine's data root",
      "<h3>Once, as root: prep-root.sh</h3>", "sudo factory/host/prep-root.sh --user omarchy --work-root /srv/omarchy-pool/host", "<code>factory/host/prep-mac.sh</code>", `href="${REPO_URL}/blob/main/factory/host/prep-root.sh"`,
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.add",
    page: "/docs/workers",
    anchor: [
      '<section id="add">', "<h2>Adding a host</h2>", "<h3>1. On your page: + add a host</h3>", "(<code>ome_…</code>, valid 15 minutes, once)",
      "| OMARCHY_ENROLL=ome_… sh", "<h3>2. On the machine: install, preflight, enroll</h3>", "<b>preflight</b>", "<code>host.ed25519</code>",
      "<h3>3. On your page: Confirm</h3>", '<a href="/docs/worker-host#maintainer-hosts">The worker host chapter</a>',
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.capacity",
    page: "/docs/workers",
    anchor: ['<section id="capacity">', "<h2>Capacity and lanes</h2>", "<b>units</b>", "a build takes 2 per size, a trial 2, an audit 1", "<b>Native first</b>", "<b>emulated lane</b>", "<b>pool cap</b>"],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.claude-code",
    page: "/docs/workers",
    anchor: [
      '<section id="claude-code">', "<h2>A Claude subscription as the agent</h2>", "<b>agent sidecar</b>", "<code>OMARCHY_SECRETS_DIR/agent.env</code>", "<b>Claude Code in print mode</b>", "<code>claude -p</code>",
      "<h3>1. A token, on your machine</h3>", "<pre>claude setup-token</pre>", "<code>sk-ant-oat01-…</code>", "keep it like a password",
      "<h3>2. Give it to the host</h3>", "<code>--agent-env-from</code>", "<em>Set agent keys</em>", "FACTORY_PROVIDER=claude-code", "<code>claude-code/claude-sonnet-5</code>", "<code>FACTORY_REASONING=low</code>",
      "<h3>3. What it does, exactly</h3>", '<code>claude -p --tools "" --max-turns 1 --no-session-persistence --output-format json --model … --system-prompt …</code>',
      "<h3>4. What it costs, and whose rules</h3>", "<em>You've hit your limit</em>", "the pool retries an audit three times", "read their consumer terms on automated and shared use",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.secrets",
    page: "/docs/workers",
    anchor: [
      '<section id="secrets">', "<h2>What a task can see</h2>", "<b>a task is born with nothing</b>",
      "<h3>What the task container holds: nothing</h3>", "<b>egress sidecar</b>", '<a href="/docs/security-model#isolation">the security model\'s Isolation</a>',
      "<h3>What the pool checks anyway</h3>", "the build fails with the kind and the line (never the match)",
      "<h3>What you decide</h3>", "a classic token that reads public repositories only",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.running",
    page: "/docs/workers",
    anchor: [
      '<section id="running">', "<h2>Keeping it running</h2>",
      '<div class="step" id="update"><h3>Update — every host follows the pool\'s release</h3>', "refused at the claim (<code>426</code>)", '<span class="pill warn">outdated</span>', "claims on its last-good for six hours",
      "<b>A revoked release</b>", "(<code>426</code> with <code>revoked: true</code>), whatever the grace", "(<code>409</code>, state <code>revoked</code>)",
      "<h3>Drain, suspend, retire</h3>", "<code>/hosts/&lt;id&gt;</code>", "<h3>Disk</h3>", "<h3>Something is off</h3>", "<b>Needs a person</b>", "<code>omarchy-agent status</code>",
    ],
    visible: EVERYONE,
  },
  {
    id: "docs-workers.orders",
    page: "/docs/workers",
    anchor: [
      '<section id="orders">', "<h2>When the pool steps in: orders</h2>", "<b>host orders</b>", "<code>/worker/&lt;id&gt;</code>",
      "<td><b>Reconcile now</b></td>", "<td><b>Settings</b></td>", "<td><b>Re-check agent</b></td>", "<td><b>Drain</b>, <b>Resume</b></td>", "<td><b>Stop its task</b>, <b>Stop</b> on a lease</td>",
      "<h3>Who gives them</h3>", 'href="/docs/worker-host#settings-and-host-orders"',
    ],
    visible: EVERYONE,
  },
];
