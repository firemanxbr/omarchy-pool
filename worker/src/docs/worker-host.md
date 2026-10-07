# The worker host

What the project runs its tasks on: its maintainers' hosts. The project's
compute is its maintainers' hosts — only a maintainer provides one (#331),
trusted by the pull request that made them a maintainer — and each runs one
bundle: the host agent, which keeps it on the pool's signed release, and one
service, the dispatcher, which runs every task it claims in its own isolated
container, born with nothing, as many at once as the host's capacity allows
(design v2 §3, §9). Contributors do not run workers; their packages build on
the hosts. A machine joins as a host with one command and one click on the
site (*Maintainer hosts* below). The legacy sets of fixed containers from
before hosts, and the files that ran them, retired once every host had
switched (#346). This directory keeps the
root-only `prep-root.sh` a new Linux host runs once, and a Mac's
`prep-mac.sh`.

| What | Where |
|---|---|
| the host set the bundle carries: one `dispatcher` service | `factory/sets/host/` |
| the root-only steps a new Linux host needs once (never run by the agent) | `factory/host/prep-root.sh` |
| a Mac's one-time steps, without sudo (#320) | `factory/host/prep-mac.sh` |
| the agent | `crates/omarchy-agent/`, installed by the release's `install.sh` |
| the dispatcher, the egress sidecar and the task containers' spec | `crates/pkg-repo/src/dispatch/` |

## Maintainer hosts

The way the project's hosts join (#307, #321): one command on the machine
and one click on the site, no SSH and no file to copy.

**The hosting requirement** (design v2 §19.1, D42). Every host runs every
contributor's recipes, so where the agent runs matters, and preflight checks
it. A host qualifies one of two ways:

- **a dedicated machine or VM** (`--dedicated` at install): a VPS, a KVM
  guest, a Colima VM, or hardware used only as a pool host. Any isolation
  level is allowed there; a rootful docker on a new host also gets
  `userns-remap` (set by `prep-root.sh` before anything runs), so a container
  escape lands in an unprivileged subuid, and only the dispatcher runs with
  `userns_mode: host` to reach the socket;
- **a shared machine with a dedicated Unix user** (`omarchy`, not your daily
  login) running rootless podman at the `subuid` level: task containers get
  `--userns=auto`, so a task's root maps to a subuid range that owns nothing
  and cannot reach the socket.

Your daily login on a workstation is refused: an escape there would reach
your GitHub session, your SSH keys and your passkeys, and from those the
approvals, merges and release dispatches the project's trust rests on. The
host's page shows the isolation level (`root`, `user`, `subuid`, `vm`,
`vm-shared`: [the security model's levels](/docs/security-model#isolation))
and says when the level does not meet the requirement. The minimum to join is
the release's signed constants: 4 CPUs, 8 GB, 60 GB free on the work root and
40 GB on the engine's data root; preflight refuses a machine below it.

**Once, as root: `prep-root.sh`** (#310, design v2 §4.1). The steps only
root can take, which the agent never runs — it only reports what is missing,
as *needs a person* on the host's page. On Arch Linux (and Arch Linux ARM) or
Ubuntu LTS:

```bash
sudo factory/host/prep-root.sh --user omarchy --work-root /srv/omarchy-pool/host \
  [--runtime rootful|rootless] [--task-subnets 10.231.0.0/16] [--address-pool 172.16.0.0/12] [--dry-run]
```

Each step is idempotent, and nothing else is done: the runtime,
qemu-user-static with its binfmt handlers (with the `F` flag, for the
emulated lane), `btrfs-progs` and `jq`; on a rootful engine the user in the
docker group, docker's default address pools (so its own networks never
take the task subnets), `userns-remap` on a new daemon only (no container
and no image yet: on a daemon already in use it would change the data root
and strand what is there) and the task firewall (`DOCKER-USER` drops from
the task subnets to private, CGNAT and link-local addresses, and an `INPUT`
drop from them to the host, kept across reboots by
`omarchy-task-firewall.service`); the work root (a btrfs subvolume where its
parent is btrfs, owned by the user, 0750); linger for the user, so its
`systemd --user` unit runs without a login; and on rootless podman cgroup v2
delegation, so task limits hold. It exits 1 when something still needs a
person, and lists it. A Mac runs `factory/host/prep-mac.sh` instead, as its
own user ([A Mac as a maintainer host](#a-mac-as-a-maintainer-host)).

1. On your page (a maintainer's, signed in), **+ add a host**: a name and
   where it runs. The pool checks you are in `factory/MAINTAINERS.toml`
   again and answers one command with a one-time token (`ome_…`, valid 15
   minutes, once), bound to your login and your GitHub user id:

   ```
   curl --proto '=https' --tlsv1.2 -fsSL https://github.com/firemanxbr/omarchy-pool/releases/download/vX.Y.Z/install.sh | OMARCHY_ENROLL=ome_… sh
   ```

   The token rides the environment of `sh`, never a process's arguments, so
   `ps` never shows it; the copy your shell's history keeps is spent once the
   host enrolls, or 15 minutes after. A host is added in the browser only: a
   CLI token does not mint one, and a name you already use is refused.
2. On the machine, as the user the agent runs as: `install.sh` installs the
   agent, which runs its preflight first (one screen of everything to fix,
   nothing written until it passes; the runbook's *Installing a host* has the
   options, `--dedicated` and `--work-root` above all), then makes the host key (never in a
   container): in the machine's TPM where its user may open one (#330 — an
   ECDSA P-256 key made inside the TPM with tpm2-tools, which never lets it
   out), else `host.ed25519` (Ed25519, mode 0600); preflight says which, and
   why not the TPM. It checks the machine against the release's signed minimum (4
   CPUs, 8 GB, 60 GB free on the work root, 40 GB on the engine's data
   root) and enrolls with the token, its public key, a proof it holds the
   key, where the key lives and its capacity report. It prints the key's
   fingerprint and where it lives, and waits.
3. Your page shows the host with the same fingerprint, where its key lives
   (in its TPM, or a file and why), and **Confirm**.
   Compare the two, then confirm: the host gets its one worker registration
   (`<login>-<name>-<4 base36>`, project trust from the maintainer list), the
   journal and Status get an info line, and the other maintainers see a
   notice. Nothing claims before that.
4. The agent fetches the host worker token with a request signed by the host
   key and writes it to `run/host/dispatcher/token` in the set directory
   (0400, in directories only the agent enters, #327). The host set mounts
   that one file read-only into the dispatcher and names it in
   `OMARCHY_WORKER_TOKEN_FILE`, so the token is in no container's
   environment, which anyone who can talk to the engine's socket reads with
   `docker inspect`. It rotates the token every 30 days (`omarchy-agent
   token` does it at once): the file is rewritten, the one it replaces works
   ten more minutes, and only the dispatcher is recreated — its tasks run on
   and it re-adopts them. `etc/dispatcher.env` (0600) names the token's
   registration (`# worker:`), the host's own addresses for every task's
   egress to refuse (`OMARCHY_HOST_ADDRESSES`), and once `agent.toml` is
   there, the secrets directory, the envelope's agent budget (#371), its
   grant of a signed exception's bridge (`OMARCHY_DIRECT_NETWORK`, #373) and
   its cache caps (`OMARCHY_CACHE_PACMAN_GB`, `OMARCHY_CACHE_BUILD_GB`, when
   it has a `cache_caps`, #341). Those come from `agent.toml` alone: a line
   of yours for one of their keys is replaced, so set them in the envelope. A
   rotation keeps them, and every other line you add to the file yourself
   stays. A host that ran the agent before #327 had the token in that file:
   the agent moves it to its own file at its first start, losing nothing,
   and keeps it in `etc/dispatcher.env` too only while a release from before
   #327 is running or being rolled out (its dispatcher reads it there), so a
   rollback to one still works; once none is left it takes it out, which
   recreates the dispatcher once.
5. Only then does it write `agent.toml` with the host and its registration,
   take the agent keys, write the systemd --user unit, enable linger and start
   the agent, whose first round starts the dispatcher (on a Mac, the
   LaunchAgent: [A Mac as a maintainer host](#a-mac-as-a-maintainer-host)).

**Every task on a host is fenced in (#336).** Each task runs on its own
internal network: it reaches public addresses only, through its own egress
sidecar (cloud metadata, the host's LAN and every other private range are
refused, judged by the address a name resolves to, and so are the host's own
addresses: every address of its interfaces and the public one its tasks leave
from, which the agent writes into `etc/dispatcher.env` and keeps current — it
reads the interfaces every minute and asks the pool's edge for the public
address every hour, and within minutes when it did not answer), never another task. A
task that needs a model — a draft, a review rebuild, an audit — gets its own
agent sidecar, which mounts `OMARCHY_SECRETS_DIR/agent.env` read-only; no two
tasks share one, and the dispatcher itself never holds the key. Per task a
sidecar makes at most `OMARCHY_AGENT_CALLS_PER_TASK` calls (200),
`OMARCHY_AGENT_TOKENS_PER_TASK` tokens (2 000 000) and runs
`OMARCHY_AGENT_MINUTES_PER_TASK` (120); the host makes at most
`OMARCHY_AGENT_CALLS_PER_DAY` calls a day (5000, UTC, the probe's one call
each run included), after which it takes no model work until the next
day. To set them, give `agent.toml`'s envelope an `agent_budget` (any of
`calls_per_task`, `tokens_per_task`, `minutes_per_task`, `calls_per_day`,
each a whole number from 1): within a minute the agent writes them into
`etc/dispatcher.env` (`omarchy-agent dispatcher-env --write` does it at once)
and the dispatcher is recreated with them; a key you leave out keeps its
default. The sidecars run as root with no capabilities (no `CAP_DAC_OVERRIDE`),
so `agent.env` must be owned by the uid their root maps to (root on a rootful
engine, the maintainer on a rootless one) at 0600, or be 0644 inside the 0700
`etc/`; otherwise the probe fails and the host takes no model work (#317's
install writes it so). Recommended: a **separate, spend-capped key for
contributor drafts** (the provider's own spending limit), since a
recipe that compromises its draft's sidecar can use that key until the caps
stop it; and a `GITHUB_TOKEN` in `agent.env` with no write scope and no
private-repository read: a classic token with no scope at all, which
reads public repositories only — install and *Set agent keys* refuse a
token with a scope, and a fine-grained or app token, for which GitHub
names no scopes, since whether it may write cannot be told. A package that truly needs direct network access (raw sockets,
its own name resolution) gets `network = "direct"` with a `reason` in
`factory/sizing/tasks.toml`, in a pull request another maintainer approves.
A host runs such a package's tasks only where its owner granted that bridge
(`--direct-network` at install, `direct_network = true` in `agent.toml`;
`--no-direct-network` takes it back), which preflight's egress probe then
checks too; any other host hands them back (#373) as a lost lease, whose
attempt the pool gives back twice per task and spends after that: until the
claim says whether a host runs such packages, a package with the exception
needs a host that grants it among those that claim its tasks. A rootless host cannot grant it: its bridges reach the LAN through
the engine's user-mode network stack, while its tasks, behind their egress
sidecars, never do.

**Its caches are fenced in too (#341).** A build mounts its own package's
build cache only — cargo's registry, Go's caches and ccache's objects under
`<work root>/cache/build/<community|project>/<arch>/<package>` — so a
contributor's recipe never reaches a project cache or another package's.
A build and an audit read the host's pacman cache of their architecture
(`<work root>/cache/pacman/<arch>`) read-only, and download into one of
their own (a trial downloads everything itself: it installs the lab above
edge, whose bytes the shared cache holds); after the task, the dispatcher
copies a download into the shared cache only when its SHA-256 is the one the
pool's signed `edge` databases list for it (fetched hourly into
`cache/syncdb/`, each verified with the pool's key), with the pool's own copy
of the package's upstream `.sig` beside it — which a build's pacman checks
the image's Arch packages by, and fails without — or not at all; it
discards everything else, and on every pass removes a file whose name those
databases have come to list with other bytes. The pacman cache keeps the two newest versions
of each package within `OMARCHY_CACHE_PACMAN_GB` (10 GB), and the build
caches go least recently used first, a package at a time, within
`OMARCHY_CACHE_BUILD_GB` (20 GB), never one a running build mounts. To set
them, give `agent.toml`'s envelope a `cache_caps` (`pacman_gb`, `build_gb`,
each a whole number of GB from 1; the Studio's `{ pacman_gb = 40, build_gb =
120 }`): the agent writes them into `etc/dispatcher.env` within a minute and
the dispatcher is recreated with them. The dispatcher's log says what each
pass merged, discarded and pruned (`caches: …`).

**A host runs as many tasks at once as its units hold (#337).** The pool
hands it one task per claim and its dispatcher claims again at once while
units are free: a build takes 2 units per size, a trial 2, an audit 1, and
one unit stays for pool jobs; whatever does not fit waits in the pool's
queue, never on the host. Native work comes first; a build of an
architecture the host runs emulated waits a little for a native host
(twice that package's last native build, 3 to 60 minutes) unless none
could take it now, and while no host runs that architecture natively each
host keeps one of its builds moving. Before each claim the dispatcher
checks the memory available, so a machine you also use takes only what
still fits. You or any maintainer can lower what the pool hands it with
the **pool cap** on its page — the Studio's canary ran at one build that
way — and raise it again; nothing running ends when you lower it. The
runbook's *How the pool hands a host work* has the rules.

**A host moves the rings too (#340).** The pool jobs — sync, render,
promote, rollback, security, gc, verify, relayout, enqueue, publish and the
health checks — are the release's own signed code, so the dispatcher runs
them itself, one at a time in the unit kept for them (never one of your
builds': the minimum host runs its build beside a sync), each in a process of
its own with a 2 GB memory limit and a time limit of its kind (45 minutes for
a health check, 2½ hours for a sync, 3 for a promotion): one that crashes or
hangs is failed and the pool queues it again, and every task beside it goes
on. They run on any host whatever architecture they are for (a sync of the
x86_64 sources runs natively on an aarch64 host, as the Studio's
`pool-x86_64` always did), except the checks that install a ring's packages
— a health check, a promotion's ABI gate — which need a lane of that ring's
architecture, native or emulated. Those check containers, and the enqueue's
reader of the recipes on `main` (on your host's own architecture), start
through `omarchy-task-run`, which runs them as it runs a task container: on
the job's own network behind its egress sidecar, with no token and nothing
of the host but the job's scratch directory. Nothing to set up on your side:
the dispatcher claims pool jobs on its own, and the pool hands them to a host
only once the maintainers' `host-pool-jobs` setting names it — `*`, every
host, since the legacy pool workers retired (runbook, *Pool jobs on hosts*) —
so a host that never gets a sync is most likely not named there. A host's agent that stops answering is
re-checked by the pool, never restarted: the dispatcher's restart would not
reach it, and would cost the jobs it runs.

**The other architecture runs emulated when the host can (#338).** The
agent turns on an emulated lane for it when your envelope allows it
(`emulate` in `agent.toml`: absent allows it, `emulate = []` keeps it off),
the kernel has qemu's binfmt handler with the `F` flag (`prep-root.sh`
installs it) and the release's build image of that architecture starts
there; otherwise it says why the lane is held (`held_lanes` in
`run/capacity.json`) and the native lane runs on (a Mac's x86_64 lane is
Rosetta's in its VM, below). An emulated build is
slower and shares the host's units; on a 16K-page kernel the lane stays on,
and a build whose toolchain cannot start under qemu goes back to the queue
for a native host without spending its attempt.

**Contributors' builds run in a sandbox when your engine has one (#330).**
Install gVisor (`runsc install` registers it with docker) or Kata Containers
and count the host again: the agent finds it after a smoke run that must
show a kernel other than your machine's, and from then on the dispatcher
starts everything a contributor wrote on your native lane in it — their
builds, the project's review rebuilds of them, trials and audits — so an
escape from a recipe lands in the sandbox's kernel rather than on your
machine. The project's own recipes, the sidecars and the check containers
of the pool's jobs (#340) run on the engine as before. A sandbox does not cover an emulated lane (its kernel has no binfmt
handler), so the pool then hands your emulated lanes the project's own
recipes only. `sandbox = "off"` in your envelope turns it off,
`sandbox = "kata"` picks one — at the host: a widening signed from the
host page (#328) never sets it, nor does a package's signed network
exception (#373) take its task out of it; the host page says which your dispatcher
applies, or why none does (podman's docker API, for one, cannot pass the
runtime on), and why its claims hold if the runtime refuses a start — for 30
minutes, doubled with each further refusal in a row, a day at most: fix the
runtime, then **Restart** on the dispatcher's worker page claims again at
once. The runbook's *A sandboxed runtime for community tasks* has the
steps.

**Where the project's copies and their audits go (#339).** The project's
copy of a package you asked for — its review rebuild, the one that is
signed and published — is never built on your hosts while another
maintainer's host has a lane for it and room to hold it at its size: it
waits for that host, however busy. When only your hosts can build it, it
waits, and Review offers another maintainer **Release to any host**, which
they confirm with their passkey; then your host may take it. A host whose
pool cap is 0, or too small for the copy's size, is none to wait for; one
whose disk its running builds fill is busy, and waited for.
Every audit prefers a machine other than the one that built what it
audits, and an audit of the project's copy takes a model other than the
one that built it whenever a host with another one answered in the last
24 hours. So the model your host's agent runs matters: the provider is the
first key `agent.env` holds, or `FACTORY_PROVIDER`, and `FACTORY_MODEL`
overrides its model. If every host runs one model, those audits record
`independent: none` on Review. A different provider or model on one host
(another key, or `FACTORY_PROVIDER` / `FACTORY_MODEL` in that host's
`agent.env`) makes them `independent: model`. The runbook's *How the pool
hands a host work* has the rules.

The host's page, `/hosts/<id>` (#324), shows you and the other maintainers
everything its agent reports: the runtime and its versions (the agent's,
the compose plugin and docker CLI the release pins), the isolation level
and whether the machine is dedicated; CPUs, memory, the free disk on the
work root and on the engine's data root, the units the pool counts — busy,
free for a task, the one kept for pool jobs —, the agent slots, your caps
(the envelope's) and the pool's cap, which you or any maintainer edit there
(never above its units: it would cap nothing, and it never touches your
envelope); its lanes, native or emulated (with `via` and 16K pages) or
held with why; the large task it reserves for, when it does; the release
it applied, its target and its floor, the rollout's state and the last
round; and its leases — kind, package, arch, lane, units, since when —,
each with a **Stop** that fences that task only: its dispatcher stops it
and it goes back to the queue, the others run on. A **Needs a person** box
says what only someone at the machine (or you, on the site) can fix: your
Confirm, a suspension, below the minimum, the disk under the floor, an
emulated lane held for binfmt, limits the runtime does not enforce
(cgroup delegation), the hosting requirement its isolation level does not
meet, the engine refusing the agent's user (the docker group), and what
the agent says of itself, looked at again hourly (linger off, credentials
within its user's reach — the paths install's preflight named; an agent
before 0.5.0 says neither, and so does a Mac's, whose engine runs in the VM
that mounts nothing of your home directory).
Its buttons are there too: Reconcile now (an Update of its registration
while its agent takes no host order), **Drain** and **Resume claims** —
your drain is lifted by you only —, Suspend and Retire. A host installed
beside a set from before hosts (`--legacy`, the switches of #345 and #332)
shows that set and, while any is queued, the tasks still pinned to its
owner's registrations from then, with **Move pins here** — the switch's
step, done once ([Runbook](/docs/runbook#the-studio-host)). Anyone else sees
its name, architectures, release and whether its agent reports; the
[Workers page](/workers) lists every host with its owner, lanes, units busy
and free, tasks, release and isolation level for anyone, and Status says
when a host needs looking at and which architecture needs a host next
([Runbook](/docs/runbook#a-new-maintainer-host), *What Status says of the hosts*).
Every later call of
the host to the pool is signed with its key (`Omarchy-Host`); the pool
refuses a replay, a changed body and a clock more than 120 s off
([Security model](/docs/security-model#maintainer-hosts)). The agent asks
for the host's state every two minutes or so — the release to run, its
settings and the host orders (#344, #325) — and reports what it did.

## Settings and host orders

A release your host's guard reverts (it rolls back to `last-good/` and
quarantines the release) does not idle it: for six hours its dispatcher
keeps claiming on the release it went back to, never below the signed
`min_release`, and its page and Status say until when (#342). Past that it
is handed nothing until it runs the pool's release. A release the project
revokes later is the one a running task does not survive: the next
dispatcher kills that release's task containers, the pool refuses what they
would upload and puts their tasks back in the queue, attempt given back;
every other task finishes on the release it started with
([Runbook](/docs/runbook#a-new-maintainer-host), *A host reverted a release* and *Revoking a release*).

**Host orders** (#344) are given on the host's page. **Reconcile now** (its
owner or any maintainer) makes its agent run a round at its next poll.
**Retire legacy set** is for a host installed beside a set from before
hosts with `--legacy`: once that set had been drained as the way back for 14
days, its owner retired it, with a passkey. The agent writes the
`.omarchy-agent` marker into the set's directory, then stops and removes
that compose project's containers and networks — nothing else — and the
set's own tools, which that directory still holds from before #346, refuse
there from then on. The page shows the set, its state and
its directory before you press it (and why it would be refused, such as a
directory the agent's user does not own: the button stays greyed until the
agent's next report says it is fixed), and each order with its agent's
answer after
([Runbook](/docs/runbook#a-new-maintainer-host), *The run loop*).

**Settings** (#325): its page narrows the units the host gives and turns
its emulated lanes off (or on again), always inside the envelope its owner
wrote in `agent.toml` at the host — the page shows that envelope and greys
every value above it. The agent takes a setting at its next poll, and the
dispatcher claims by it from its next claim; a task already running above
the new count finishes, nothing is stopped for it. Whatever the pool asks,
the agent itself refuses a value above the envelope, and the page shows the
refusal; only the owner widens the envelope — at the host, by editing
`[envelope]` in `agent.toml` and restarting the agent (`systemctl --user
restart omarchy-agent`), or from the page with the passkey pinned at the
host ([Owner control without a visit](#owner-control-without-a-visit)). A
narrowing needs no signature. The page's **Host orders** card gives the rest, its
owner's or any maintainer's: **Retry release** lifts the quarantine of a
release its guard reverted and tries it again; **Rotate token** gives the
dispatcher a new worker token, in its file (#327; the old one works ten more
minutes);
**Diagnostics** brings the dispatcher's last 500 log lines, scrubbed of the
host's secrets, read on the page — only when the envelope says
`diagnostics = true`. Every order and its agent's answer are on the page's
journal of orders and the pool's journal.

**The host brakes the pool** (#325): whatever the pool sends, the agent
takes host orders at least two seconds apart and at most 20 an hour, at most
4 narrowings and 6 dispatcher restarts an hour — a round that tries a
release again after an Update or **Retry release** counts its restarts too,
its revert's included — and at most one release change every ten minutes (a
rollback under a signed statement excepted); beyond that it answers
`refused: brake` (an Update waits for the next poll), and the page shows how
much of each the last hour spent. On a Mac, a restart of its VM counts as
one of those restarts, though the brake never holds it. Restarting the
agent resets none of it.

**A soak is the owner's, at the host** (#326): `soak_minutes = 30` under
`[envelope]` in `agent.toml` (0, the default, takes a release at once; at
most 100, so the soak and its round fit inside the pool's two-hour grace)
makes the host take a new release that long after its agent first saw the
pool name it, so a bad one can be caught on another host first — a release
that lands meanwhile waits its own soak, but the host is never kept more
than 100 minutes behind. It covers the agent's own update
too, unless the release's manifest sets `agent.urgent` (only a security
release does). A rollback statement skips it and applies at once;
**Reconcile now** never does. Meanwhile the pool keeps the host's
registration out of the 426 gate until the soak ends (and the round's 15
minutes after it), at most two hours after the deploy, unless the host
holds the pool's release in quarantine — it reverted it, and claims on its
last-good instead (above) — and never on a revoked release (#342); its page
says where it stands at the gate and why, to its owner and the maintainers ([Runbook](/docs/runbook#a-new-maintainer-host), *Soak*).

**The host watches the pool** (#326, freeze detection): every six hours
its agent reads the tag of GitHub's latest release, and nothing else. If
GitHub has shown a newer release than the pool names for more than a day
(and no revocation or signed rollback explains it), the host's page and
Status warn `pool-behind-github`: the pool may be held on an old release.
The agent changes nothing for it — it follows only the pool and what is
signed ([Runbook](/docs/runbook#a-new-maintainer-host), *Freeze detection*).

**The runtime is the owner's, at the host** (#325): `omarchy-agent runtime
switch compose/podman` (or `compose/docker`, or `quadlet`: below) moves the
dispatcher to the other engine with the same guard as a release, and back if
it fails there; the pool cannot choose it. Drain the host's registration and
let its tasks finish first: task containers and caches do not move between
engines ([Runbook](/docs/runbook#a-new-maintainer-host), *The run loop*). A
Mac's bundle stays in its VM's engine: the switch is refused there.

## A host on Quadlet

A Linux host with rootless podman and no compose can run its dispatcher as
a unit of your own systemd (#330, design v2 §15): the **Quadlet driver**
(an agent from 0.5.0).
The bundle is the same as every other host's — the release's signed
`compose.yml`, the agent's labels and your `compose.override.yml` — and the
agent renders it, as compose would load it, into
`~/.config/containers/systemd/omarchy-host-dispatcher.container`. podman's
generator turns that file into `omarchy-host-dispatcher.service` at
`systemctl --user daemon-reload`, and the agent applies a release with
`daemon-reload` and `restart`, behind the same guard, revert and quarantine
as compose's rounds. The unit restarts the dispatcher the way the
template's `restart: unless-stopped` does (every exit, a second later, for
as long as it takes: the guard, not systemd's start limit, judges a release
that keeps restarting), stops it with the template's `stop_grace_period`,
and starts it at boot (linger, which install enables). podman's
`AutoUpdate=` is never written: only the agent moves the host to a release,
and only to one release.yml signed. Task containers stay the dispatcher's,
on podman's API socket, which the dispatcher mounts as on any rootless
podman host. The unit holds `agent.toml`'s paths and variables and names
files by path, never a secret: the worker token's own file,
`run/host/dispatcher/token`, is a read-only mount the dispatcher reads
through `OMARCHY_WORKER_TOKEN_FILE`, as on compose (#327), and
`etc/dispatcher.env` its env file. podman never makes a mount's missing
source, so without the token file the unit does not start (the agent holds
the dispatcher until it wrote the file); a rotation (`omarchy-agent token`)
restarts the dispatcher's unit alone, its tasks running on.

- **Choose it at install**: `install.sh … | OMARCHY_ENROLL=… sh -s --
  --driver quadlet` (or `omarchy-agent install --driver quadlet`). It needs
  podman 4.6 or later (its Quadlet generator reads every key the agent
  writes, `Pull=` and `PodmanArgs=` among them: 4.4 and 4.5 ship a
  generator that would make no service of the unit, and preflight refuses
  them), its rootless API socket
  (`systemctl --user enable --now podman.socket`; install asks
  `$XDG_RUNTIME_DIR/podman/podman.sock` unless you give `--socket`) and
  your systemd user manager with linger; preflight says what is missing.
  `agent.toml` then says `driver = "quadlet"` under `[set]`, and its
  envelope's `drivers` name `quadlet`. Running install again keeps the
  driver; to change a running host's, switch it.
- **Or switch to it later**, at the host: name `quadlet` in the envelope's
  `drivers`, drain the host's registration, then `omarchy-agent runtime
  switch quadlet` (refused, with nothing changed, below podman 4.6). Run
  it in your own login session: like install, it asks
  `$XDG_RUNTIME_DIR/podman/podman.sock` unless you give `--socket`, and a
  shell without `XDG_RUNTIME_DIR` (`su`, `sudo -u`) is refused. The agent
  stops the dispatcher where it runs, brings the
  same release up as the unit through a whole round, and writes the driver
  into `agent.toml` only once that round is `ok`; it goes back otherwise.
  From compose on the same rootless podman this keeps the engine (and its
  images); `omarchy-agent runtime switch compose/podman` goes back to
  compose.
- **On the host**: `omarchy-agent status` says `driver: quadlet` and where
  its units are; `systemctl --user status omarchy-host-dispatcher` and
  `journalctl --user -u omarchy-host-dispatcher` show the unit. Change the
  dispatcher through `compose.override.yml`, never the unit file: the next
  round writes it again. An override the driver cannot render as compose
  would run it — a service network, `depends_on`, `profiles`, a string
  command with quotes, a variable `agent.toml` does not set, a bind with
  `create_host_path: true` — is refused at
  the round's lint (`quadlet: …`) and the host keeps running what it ran. A
  unit you stop by hand is started again within 15 minutes, as a stopped
  compose container is. Uninstall stops the unit and removes its file.
- **Your own lines in `etc/dispatcher.env`** reach the dispatcher as
  podman's `--env-file` reads them, not as compose does: `$` is not
  expanded, a ` #` after the value is part of it, and podman 4 keeps
  quotes (`FOO="a b"` gives `"a b"`), where compose's reader expands
  `$VAR`, drops the comment and strips the quotes. Write a line
  unquoted, with no `$` and no comment after its value (`FOO=a b`), and
  it means the same on both drivers; the lines the agent writes are
  already so.

The host's report says `quadlet` as its driver, and the host's page shows
it beside its isolation level.

## Owner control without a visit

Its owner widens a host's envelope and sets its agent keys from the host's
page (#328, design v2 §14, D6 b) — with no visit to the machine, and only
with the one passkey they pinned at the host. The pool relays; the host
checks. An agent 0.4.0 or later takes these; the page's **Owner control**
card shows what its agent reports (the pinned passkey, the seal key, the
envelope a widening starts from, the agent keys' names) and greys each
button with why.

1. **Pin a passkey, once, at the host.** **Make a pin** asks one of your
   passkeys (registered on your page) to sign a pin document for this
   host, and prints `omarchy-agent envelope pin-passkey <pin>`, good for
   ten minutes. Paste it at the host as the agent's user. The agent checks
   the signature itself, with the public key the pin carries, and that the
   pin names this host and its pool's relying party (`omarchy-pool.org` on
   `https://omarchy-pool.org`; `localhost` only for a pool on the same
   machine), then keeps that key in
   `state/owner.json` (0600); its next report shows it pinned. A new pin
   replaces the old one (what the old one signed is refused from then on);
   `omarchy-agent envelope unpin-passkey` removes it, and the site widens
   nothing until one is pinned again. `omarchy-agent status` prints what is
   pinned, and the seal key.
2. **Confirm the seal key, once.** The agent has an X25519 **seal key** of
   its own (a 0600 file, `state/seal.x25519`, on Linux; the login keychain
   on a Mac) and reports its public half. Compare the fingerprint on the
   page with the `seal key:` line of `omarchy-agent status`, then
   **Confirm the seal key** with your passkey. A seal key made again shows
   as changed and is confirmed again before anything is sealed to it; so
   does one other than the key you confirmed in this browser. A browser
   that never confirmed it (another device, a new profile) shows you the
   fingerprint to compare once more before its first seal: the pool's
   record of your confirmation never decides on its own.
3. **Widen the envelope.** `max_units`, `max_cpus`, `max_mem_gb`,
   `emulate`, `agent_slots`, `agent_budget`, `diagnostics` and `paths`:
   **Review and sign** sends what you changed to the pool, which writes the
   document (this host, a version above the last, an hour to live); your
   pinned passkey signs it, and the pool relays it as a `widen-envelope`
   order. The agent refuses it unless the pinned passkey signed exactly that
   document for this host, on its pool's origin, with you present and
   verified, within its hour, under a version above the last it took — so
   a document replayed, or an older one, is refused too. It then sets those
   keys in `[envelope]` of `agent.toml` (its other lines and its mode kept),
   takes the new envelope at once and counts `run/capacity.json` again —
   never more units than the applied release's signed constants and the
   detected hardware give. The dispatcher is recreated with the new file
   and claims by it; a running task is never stopped. A Mac's VM is
   restarted with a new `max_cpus`/`max_mem_gb` as for any change of its
   size — once no task runs, within the brake — and an emulated lane its
   detection never checked comes on at its next count: on Linux, which the
   loop never runs on its own, `omarchy-agent capacity --write` at the
   host; on a Mac, the next start of its VM. Before your passkey is asked,
   the page checks that the pool's document is the one it showed you (this
   host, the envelope you changed, its challenge the document's SHA-256).
4. **Set agent keys.** `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
   `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY` and `GITHUB_TOKEN`
   (the keys a task's agent sidecar reads): **Seal and sign** seals the
   value in your browser to the confirmed seal key — X25519, HKDF-SHA256
   and AES-256-GCM, bound to this host and the key's name — so the pool
   stores and relays ciphertext only, inside a document your pinned
   passkey signed. The agent opens it and writes it to
   `OMARCHY_SECRETS_DIR/agent.env` (0600), keeping the lines you wrote
   there; a `GITHUB_TOKEN` with any scope is refused. Only agent sidecars
   mount that directory, read-only; the dispatcher never does, and the
   journal, the report and the diagnostics scrub every value. A key is
   taken out the same way. A task already running keeps what it started
   with.

Each order and the agent's answer — `done` with what changed, or `refused`
with why (nothing pinned, another passkey, a replay, an expired document,
another host or origin) — are on the page's journal of orders. Whatever
can refuse a widening is checked before anything changes; once `agent.toml`
or `agent.env` holds it, the answer is `done`, with anything that failed
after it said. A setting
that narrows (above) needs no signature
([Security model](/docs/security-model#maintainer-hosts), *Owner control without a visit*;
[Runbook](/docs/runbook#a-new-maintainer-host), *Owner control*).

## Stopping a host

To stop a host, use its page, `/hosts/<id>` (#322). **Suspend** (its
owner or any maintainer, with a reason) stops its claims at once and
fences its running tasks; only its owner resumes it, with a passkey, and
nothing is done on the machine. **Retire** (its owner, or a maintainer
with a passkey) burns its key and its worker token; paste a new command
from your page on the machine to enroll it again as a new host. To let
its tasks finish, drain its registration from the worker's page instead:
a drain you made is yours alone to lift. If a pull request takes you off
`factory/MAINTAINERS.toml`, your hosts stop claiming at the next sync and
their running tasks finish; listed again, **Resume my hosts** on your
page brings all of them back at once
([Security model](/docs/security-model#stopping-a-host)).

## A Mac as a maintainer host

A maintainer's Mac (Apple silicon, macOS 13 or later) can be a pool host
like any other (#320, design v2 §19.2, §19.3, §21.3): the same agent,
enrollment, protocol and release stream. "Native macOS host" means a native
macOS agent whose Arch Linux containers run in a Linux VM, the agent's own
**`omarchy` Colima profile**: no Linux container runs on Darwin itself.

- **The VM is dedicated** (isolation `vm`): a container escape lands in the
  VM, not in your account. It mounts exactly three directories, each at its
  own path — the work root (writable), the secrets directory and the set
  directory (read-only), under `/Users/Shared/omarchy-pool` by default — and
  nothing of your home directory: no `~/.ssh`, no Keychain files, no
  forwarded SSH agent. Preflight refuses any of the three under `~`, or
  below `/Users/Shared` another account's or a link, and checks, from a
  container, that the VM sees them and not your home; the agent checks the
  paths again before every start of the VM.
- **Sized from capacity.** The VM gets the envelope's `max_cpus` and
  `max_mem_gb`, by default half of the Mac: a 16-core, 64 GB Mac gives it 8
  CPUs and 32 GB, which are 7 units (3 builds and the job unit). A Mac that
  cannot give it the release's minimum (4 CPUs, 8 GB) does not join. The
  agent starts, stops and sizes the profile itself, at most once every ten
  minutes and six times a day, and never restarts it for a new size while a
  task runs; after a resize it reports the VM's new size to the pool.
- **Tasks reach only the internet.** A task leaves only through its egress
  sidecar, and the agent puts the same task firewall in the VM as on a Linux
  host: a task reaches no address of your LAN, your router or the Mac
  itself, which preflight's egress probe checks the way a task runs (#373).
- **An x86_64 lane through Rosetta.** With Rosetta 2 installed the VM runs
  with `--vz-rosetta` (4K pages): x86_64 builds run on a lane that reports
  `via: rosetta`, faster than qemu.
- **A LaunchAgent is login-scoped.** The agent starts at your login, again
  after a reboot once you log in, and after the Mac wakes; a headless Mac
  sitting at the login window after a boot runs no agent, and that is not
  supported. After a wake the agent holds the VM's clock to the pool's, so
  tasks that run on keep valid job tokens.
- **A sleeping Mac has zero free units** (#329, design v2 §19.2), whatever
  runtime its engine is in (Colima, Docker Desktop, OrbStack). While a task
  runs — from its claim to its report: a container labelled
  `com.omarchy.task` runs, or the dispatcher holds its lease while it stages
  the inputs or uploads the outputs (one file per lease in `<work
  root>/state/leases/`, rewritten at every heartbeat) — the agent holds a
  `PreventUserIdleSystemSleep` assertion (`caffeinate -i -w <its pid>`,
  which `pmset -g assertions` lists): the Mac does not idle into sleep under
  a task, and may again once none runs. An engine that stops answering keeps
  it 30 minutes at most, a lease's length: past that the pool requeues what
  nobody can confirm, and a laptop is not kept awake on its battery for it.
  When it goes to sleep
  anyway — idle with no task, the lid, the Apple menu — the agent hears it
  first, reports `asleep: true` and only then lets it sleep (macOS waits up
  to 30 s for it): the pool hands the host nothing more, and the host's page
  says *asleep*. After the wake it reports `asleep: false`, asks the pool
  for its target at once and, on Colima, checks the VM's clock; the dispatcher claims
  again with nobody's action. **Closing the lid still sleeps the Mac**, task
  or not: a task the sleep caught is requeued by the pool when its lease
  expires (30 minutes without a heartbeat), as on any host that goes away,
  and nothing on the Mac needs you — once awake, the dispatcher finds no
  heartbeat accepted within the lease and removes that task's containers
  itself. The agent hears the sleep through AppKit's
  `NSWorkspaceWillSleepNotification` (a small `osascript -l JavaScript`
  watcher it starts and ends; no `unsafe` code, no Apple SDK in the agent):
  a watcher that does not start is said once in the journal, and the Mac
  then sleeps as before — the assertion still holds while a task runs. The
  pool holds `asleep` only while the report that said it is fresh (15
  minutes): a dispatcher that claims after that is on a Mac that woke.
- **Docker Desktop and OrbStack** are never installed by the agent; one that
  is already there may be used (isolation `vm-shared`), only with its home
  mount removed and `--dedicated`, your word that nothing else runs in it:

| Runtime | Terms | The agent's use |
|---|---|---|
| Colima (and Lima) | MIT | the default: installed by `factory/host/prep-mac.sh` from Homebrew, driven by the agent |
| Docker Desktop | free only for personal use, education, non-commercial open source, or companies under 250 employees **and** under US$10M revenue; government must pay | used if present (when Colima is not installed, or with `--socket`), never installed; `vm-shared` |
| OrbStack | a paid licence for commercial, freelance, non-profit and government use | used if present, as Docker Desktop, never installed; `vm-shared` |

The runbook's [A new maintainer host](/docs/runbook#a-new-maintainer-host),
under *Installing a Mac*, has the commands.
