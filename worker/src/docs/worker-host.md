# The project's host

What the project runs its workers on: one machine, containers of the one
worker image — eight worker registrations, of which five run by default
(the x86_64 build services are behind the `emulated` profile), their
brokers, `agent-proxy`, and the `updater` that rolls them out (the roles:
[factory/README.md](../README.md) *Three roles*; how the day goes:
[docs/RUNBOOK.md](../../docs/RUNBOOK.md) *The Studio host*). Anyone donating
a machine to the project can use the same four files.

| File | What |
|---|---|
| `setup.sh` | run once with `sudo`: the directory tree (a btrfs subvolume where `/` is btrfs), docker + compose + user-mode emulation for the other architecture, the docker group, the env files to fill in |
| `register.sh` | registers the eight workers with the pool under a maintainer's token, trusts the six project ones, writes each worker token into `etc/<service>.env` — prints only the ids |
| `rollout.sh` | wakes the `updater` service now (`--check`: asks it what it would do). The rollout itself runs in the image (`omarchy-rollout`), brokers first: `agent-proxy` and the community brokers that changed, each waited for until it answers on `:8790` (at most `ROLLOUT_BROKER_WAIT`, 300 s for all of them; past it a warning, and the rollout goes on), then every worker that changed in one `up`: a stop is a *drain* (SIGTERM — the worker finishes the task it holds, claims nothing new, exits; `stop_grace_period: 3h`), then the new container starts; the unchanged ones keep working |
| `compose.yml` | twelve services, eight of them run by default — four under the `emulated` profile, `review-x86_64`, `review2-x86_64`, `community-x86_64` and `broker-community-x86_64`: off unless `COMPOSE_PROFILES=emulated` is in `.env` (see *x86_64 builds* below): `pool-*`, `review-*`, `review2-*` (project trust, the runtime's socket, a work directory at the same path on both sides, the shared package cache; their audits and build containers reach the agent through `agent-proxy` on the `review` network), `broker-community-*` + `community-*` (community trust, shared: the broker holds the token, the agent key and `GITHUB_TOKEN` and only receives, processes and answers; the builder beside it holds nothing, one task per container, on a network the two have to themselves; the x86_64 community builder is an emulated container on an aarch64 host, its broker native), `agent-proxy`, plus `updater`: the rollout, following the pool's release, no token |

```
POOL_ROOT (/srv/omarchy-pool)
├── .env                 POOL_ROOT and WHERE (the label in the worker's tooltip on the Workers page)
├── compose.yml
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
docker compose ps                                 # the eight that run by default (the updater among them), and whether they are up
docker compose logs -f --tail 50 review-aarch64   # one worker; docker compose logs -f updater for the rollout
./rollout.sh                                      # wakes the updater: a rolling upgrade now (it follows each release within 2 minutes by itself), or starts it as it is; --check to only look
docker compose restart pool-x86_64                # a worker stuck in a task — a drain: it finishes its task first (up to 3 h)
docker kill <container>                           # one that must end now, or a stall of the engine itself
```

A worker that looks stuck between tasks is operated from its page,
`/worker/<id>`: **Re-check agent**, **Restart**, **Restart agent service**
for `agent-proxy`, and **Update** once its set's updater follows the pool.
One stuck inside a task claims nothing, so no order reaches it: `docker
compose restart` above until Stop its task, on the same page, comes with
#277's next part.

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
