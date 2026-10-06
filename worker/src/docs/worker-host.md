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
   there, the secrets directory and the envelope's agent budget (#371); a
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

The host's page, `/hosts/<id>`, shows its status, capacity and units, lanes,
isolation level, the release it applied, the pool cap, the large task it
reserves for when it does, and its leases with their lane and units. Every later call of
the host to the pool is signed with its key (`Omarchy-Host`); the pool
refuses a replay, a changed body and a clock more than 120 s off
([Security model](/docs/security-model#maintainer-hosts)). The agent asks
for the host's state every two minutes or so — the release to run, and the
host orders (#344) — and reports what it did.

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
- **Tasks reach only the internet.** The agent puts the same task firewall
  in the VM as on a Linux host: a task reaches no address of your LAN, your
  router or the Mac itself, which preflight's egress probe checks.
- **An x86_64 lane through Rosetta.** With Rosetta 2 installed the VM runs
  with `--vz-rosetta` (4K pages): x86_64 builds run on a lane that reports
  `via: rosetta`, faster than qemu.
- **A LaunchAgent is login-scoped.** The agent starts at your login, again
  after a reboot once you log in, and after the Mac wakes; a headless Mac
  sitting at the login window after a boot runs no agent, and that is not
  supported. While the Mac sleeps it claims nothing: running tasks' leases
  expire and the pool requeues them, as on any host that goes away. After a
  wake the agent holds the VM's clock to the pool's, so tasks that run on
  keep valid job tokens.
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
