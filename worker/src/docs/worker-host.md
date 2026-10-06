# The project's host

What the project runs its workers on: one machine, containers of the one
worker image — eight worker registrations, of which four run by default
(the x86_64 build services are behind the `emulated` profile, the second
review pair behind `review2`), their
brokers, `agent-proxy`, and the `updater` that rolls them out (the roles:
[factory/README.md](../README.md) *Three roles*; how the day goes:
[docs/RUNBOOK.md](../../docs/RUNBOOK.md) *The Studio host*). The project's
compute is its maintainers' hosts: only a maintainer provides one (#331), and
a maintainer adding a host uses the same four files. Contributors do not run
workers; their packages build here.

| File | What |
|---|---|
| `setup.sh` | run once with `sudo`: the directory tree (a btrfs subvolume where `/` is btrfs), docker + compose + jq + user-mode emulation for the other architecture, the docker group, an env file (mode 600) to fill in for every `env_file` `compose.yml` names. It checks the new `compose.yml` against the host's `.env` and `etc/` before it changes anything (exit 4), keeps the files it replaces in `setup-backup-<time>/` and prints the lines of `compose.yml` it replaces. On a host from before #277 it is the one-time step, which starts and checks the updater before it retires the old timer, and puts everything back when that fails (the runbook, *Once: the updater*) |
| `register.sh` | registers the eight workers with the pool under a maintainer's token, trusts the six project ones, writes each worker token into `etc/<service>.env` — prints only the ids |
| `rollout.sh` | wakes the `updater` service now (`--check`: asks it what it would do). The rollout itself runs in the image (`omarchy-rollout`), brokers first: `agent-proxy` and the community brokers that changed, each waited for until it answers on `:8790` (at most `ROLLOUT_BROKER_WAIT`, 300 s for all of them; past it a warning, and the rollout goes on), then every worker that changed in one `up`: a stop is a *drain* (SIGTERM — the worker finishes the task it holds, claims nothing new, exits; `stop_grace_period: 3h`), then the new container starts; the unchanged ones keep working |
| `compose.yml` | twelve services, seven of them run by default — three under the `emulated` profile, `review-x86_64`, `community-x86_64` and `broker-community-x86_64`: off unless `COMPOSE_PROFILES=emulated` is in `.env` (see *x86_64 builds* below); the second review pair, `review2-x86_64` and `review2-aarch64`, under `review2`: off until `register.sh` has registered it, then `COMPOSE_PROFILES=emulated,review2` (or `review2`) and `./rollout.sh` (until then its two registrations show offline on the Workers page; revoke them there on a host that will not run the pair): `pool-*`, `review-*`, `review2-*` (project trust, the runtime's socket, a work directory at the same path on both sides, the shared package cache; their audits and build containers reach the agent through `agent-proxy` on the `review` network), `broker-community-*` + `community-*` (community trust, shared: the broker holds the token, the agent key and `GITHUB_TOKEN` and only receives, processes and answers; the builder beside it holds nothing, one task per container, on a network the two have to themselves; the x86_64 community builder is an emulated container on an aarch64 host, its broker native), `agent-proxy`, plus `updater`: the rollout, following the pool's release, no token |

```
POOL_ROOT (/srv/omarchy-pool)
├── .env                 POOL_ROOT and WHERE (the label in the worker's tooltip on the Workers page), COMPOSE_PROFILES when a profile is on
├── compose.yml
├── compose.override.yml local changes, if any: compose and the updater read it, setup.sh never touches it
├── register.sh
├── rollout.sh           wakes the updater (# omarchy-rollout: kick-v1 on its second line, which the project workers report)
├── etc/                 mode 700; secrets, yours: one worker token per worker, agent.env with the agent key — read by the brokers, agent-proxy and the review workers' tokens only; no builder reads etc/
├── work/<service>/      OMARCHY_WORK_DIR of each project worker (task dirs, the clone of this repository, the ABI references)
├── cache/pacman/<arch>/ one pacman package cache per architecture, mounted into every build container (OMARCHY_PKG_CACHE)
└── cache/build/       cargo registry, Go module and build caches, ccache — /build/cache in the build containers (OMARCHY_BUILD_CACHE),
    ├── project/<arch>/    the review workers' builds (what the project publishes reads only what the project wrote)
    └── community/<arch>/  the community containers' builds; inside both, one directory per package
```

Install, from a checkout of this repository on the host (or copy the four
files over):

```bash
sudo factory/host/setup.sh                        # then log in again (the docker group)
$EDITOR /srv/omarchy-pool/etc/agent.env           # GEMINI_API_KEY=… (or another provider's)
OMARCHY_CONTRIBUTOR_TOKEN=omc_… /srv/omarchy-pool/register.sh
cd /srv/omarchy-pool && docker compose pull && docker compose up -d
```

`docker compose up -d` starts the updater with the rest, and from then on it
keeps the host on the pool's release. This is the only bare `up -d`. Its
configuration hashes are the host compose's, so the updater's first round
replaces every service once. After it, use `./rollout.sh` (it wakes the
updater, or starts it as it is, never recreated), or `docker compose up -d
--no-deps <service>` for one service: a bare `up -d` re-stamps every
service's hash with the host's compose, and the updater's next round drains
and recreates every service once more. A host installed before #277 does the
runbook's one-time step instead (*The Studio host*, *Once: the updater*).

Operate:

```bash
docker compose ps                                 # the seven that run by default (the updater among them), and whether they are up
docker compose logs -f --tail 50 review-aarch64   # one worker; docker compose logs -f updater for the rollout
./rollout.sh                                      # wakes the updater: a rolling upgrade now (it follows each release within 2 minutes by itself), or starts it as it is; --check to only look
docker kill pool-x86_64                           # only for a stall of the engine itself: everything else is on the worker's page
```

A worker that looks stuck is operated from its page, `/worker/<id>`, not
from here: **Stop its task** if the task hangs — a build, a trial, an
audit or a check stops within 5 minutes while its container or script
runs (its process group killed, the containers labelled with the task
removed); a build already uploading once its container has ended, a trial
publishing into the lab, and a pool job in the worker's own process stop at
their next call to the pool; the task goes back to the queue then, or when
its lease ends — then **Restart**, and **Restart agent service** for
`agent-proxy`. **Drain** keeps a worker out of work until **Resume**,
across its restarts; **Update** replaces it once its set's updater follows
the pool; a worker that wedges is restarted by its own watchdog (20 minutes
without progress, then ever more slowly), and its page says so.

The Workers page lists them by role, with the agent each reports; a
worker that is not alive there is not running here. One whose agent does
not answer is *failed* there and *not ready* on the Factory and Status,
with the agent's error: it checks its agent again (15 s, doubled, back to
every thirty minutes) and is ready again by itself once the agent answers —
the review workers' log on their pages carries the proxy's last lines when
it fails.

`compose.yml` is this host's copy, and the rollout runs in the image. The
one-time step of the runbook's *The Studio host* moved this host to the
updater; a release that adds a service needs that kind of step again.
Moving the tree to another disk (the 4 TB one, when it has a USB enclosure)
is `docker compose down`, copy, mount at the same `POOL_ROOT`, `docker
compose up -d` — which, as at the install, costs every service one more
replacement at the updater's first round.

## x86_64 builds

The host is aarch64 and its kernel (Asahi) uses 16K pages. x86_64 *pool
jobs* are a label and run natively. x86_64 *builds* would run under
user-mode emulation, and on a 16K-page host qemu cannot map every x86_64
library: `rustc` (through libedit), `sudo` (libldap) and others fail with
*failed to map segment from shared object* — a C package builds, a Rust
one does not. So the two x86_64 build services are behind the `emulated`
profile and off by default: x86_64 build tasks stay queued (each build's
page says so), and nothing burns attempts or agent
calls on them. Any x86_64 machine with docker becomes the x86_64 build
host in minutes: copy `compose.yml`, `.env`, `etc/agent.env`,
`etc/community-x86_64.env` and `etc/review-x86_64.env` there, drop the
`profiles:` lines (they are native there), `docker compose up -d
broker-community-x86_64 community-x86_64 review-x86_64`. `COMPOSE_PROFILES=emulated` in `.env`
turns the emulated pair on here regardless, for C-only packages (a
toolchain or a library that cannot start there sends the build back to the
queue for a native worker, from the community builder and the review
worker alike: *Run a worker* in the docs, the runbook's *Studio host*).

## Maintainer hosts

The way the project's hosts join from P1 of the host agent (#307, #321):
one command on the machine and one click on the site, no SSH and no file
to copy.

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
   options, `--dedicated` and `--work-root` above all), then makes the host key (`host.ed25519`, mode 0600, never in a
   container), checks the machine against the release's signed minimum (4
   CPUs, 8 GB, 60 GB free on the work root, 40 GB on the engine's data
   root) and enrolls with the token, its public key, a proof it holds the
   key and its capacity report. It prints the key's fingerprint and waits.
3. Your page shows the host with the same fingerprint and **Confirm**.
   Compare the two, then confirm: the host gets its one worker registration
   (`<login>-<name>-<4 base36>`, project trust from the maintainer list), the
   journal and Status get an info line, and the other maintainers see a
   notice. Nothing claims before that.
4. The agent fetches the host worker token with a request signed by the host
   key and writes it to `etc/dispatcher.env` (0600) for the dispatcher. It
   rotates the token every 30 days; the one it replaces works ten more
   minutes, so only the dispatcher is recreated and its tasks run on. Beside
   the token the agent writes the host's own addresses for every task's
   egress to refuse (`OMARCHY_HOST_ADDRESSES`), and once `agent.toml` is
   there, the secrets directory, the envelope's agent budget (#371) and its
   grant of a signed exception's bridge (`OMARCHY_DIRECT_NETWORK`, #373); a
   rotation keeps them, and the lines you add to the file yourself stay.
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
private-repository read (a fine-grained token, "public repositories,
read-only"). A package that truly needs direct network access (raw sockets,
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
Every task reads the host's pacman cache of its architecture
(`<work root>/cache/pacman/<arch>`) read-only and downloads into one of its
own; after the task, the dispatcher copies a download into the shared cache
only when its SHA-256 is the one the pool's signed `edge` databases list for
it (fetched hourly into `cache/syncdb/`, each verified with the pool's key),
and discards everything else. The pacman cache keeps the two newest versions
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
the **pool cap** on its page — the Studio canary runs at one build that way
— and raise it again; nothing running ends when you lower it. The
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
only once the maintainers' `host-pool-jobs` setting names it — the P1 host
first, the Studio canary a week later (runbook, *Pool jobs on hosts*) — so a
host that never gets a sync is most likely not named there yet. A host's agent that stops answering is
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

The host's page, `/hosts/<id>`, shows its status, capacity and units, lanes,
isolation level, the release it applied, the pool cap, the large task it
reserves for when it does, and its leases with their lane and units. Every later call of
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
**Retire legacy set** is for a host installed beside an older set with
`--legacy` (the Studio's role containers, or an `omarchy-worker` set): once
that set has been drained as the way back for 14 days, its owner retires it,
with a passkey. The agent writes the `.omarchy-agent` marker into the set's
directory, then stops and removes that compose project's containers and
networks — nothing else — so `rollout.sh`, `setup.sh`, `omarchy-worker` and
the updater refuse there from then on. The page shows the set, its state and
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
dispatcher a new worker token (the old one works ten more minutes);
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
switch compose/podman` (or `compose/docker`) moves the dispatcher to the
other engine with the same guard as a release, and back if it fails there;
the pool cannot choose it. Drain the host's registration and let its tasks
finish first: task containers and caches do not move between engines
([Runbook](/docs/runbook#a-new-maintainer-host), *The run loop*). A Mac's
bundle stays in its VM's engine: the switch is refused there.

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
