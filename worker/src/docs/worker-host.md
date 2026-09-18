# The project's host

What the project runs its workers on: one machine, six containers of the
one worker image — two of each role, one per architecture (the roles:
[factory/README.md](../README.md) *Three roles*; how the day goes:
[docs/RUNBOOK.md](../../docs/RUNBOOK.md) *The Studio host*). Anyone donating
a machine to the project can use the same three files.

| File | What |
|---|---|
| `setup.sh` | run once with `sudo`: the directory tree (a btrfs subvolume where `/` is btrfs), docker + compose + user-mode emulation for the other architecture, the docker group, the env files to fill in |
| `register.sh` | registers the six workers with the pool under a maintainer's token, trusts the four project ones, writes each worker token into `etc/<service>.env` — prints only the ids |
| `rollout.sh` | a rolling upgrade to the image the latest release published, one worker at a time: a stop is a *drain* (SIGTERM — the worker finishes the task it holds, claims nothing new, exits; `stop_grace_period: 3h`), then the new container starts; the other five keep working. `--check` only reports. A systemd user timer runs it every 15 minutes |
| `compose.yml` | nine services (three of them, `community-x86_64`, its broker and `review-x86_64`, under the `emulated` profile: off unless `COMPOSE_PROFILES=emulated` is in `.env` — see *x86_64 builds* below): `pool-*`, `review-*` (project trust, the runtime's socket, a work directory at the same path on both sides, the shared package cache; their audits and build containers reach the agent through `agent-proxy` on the `review` network), `broker-community-*` + `community-*` (community trust, shared: the broker holds the token, the agent key and `GITHUB_TOKEN` and only receives, processes and answers; the builder beside it holds nothing, one task per container, on a network the two have to themselves); the x86_64 community builder is an emulated container on an aarch64 host, its broker native |

```
POOL_ROOT (/srv/omarchy-pool)
├── .env                 POOL_ROOT and WHERE (the label in the worker's tooltip on the Workers page)
├── compose.yml
├── register.sh
├── rollout.sh
├── etc/                 mode 700; secrets, yours: one worker token per worker, agent.env with the agent key — read by the brokers, agent-proxy and the review workers' tokens only; no builder reads etc/
├── work/<service>/      OMARCHY_WORK_DIR of each project worker (task dirs, the clone of this repository, the ABI references)
├── cache/pacman/<arch>/ one pacman package cache per architecture, mounted into every build container (OMARCHY_PKG_CACHE)
└── cache/build/       cargo registry, Go module and build caches, ccache — /build/cache in the build containers (OMARCHY_BUILD_CACHE),
    ├── project/<arch>/    the review workers' builds (what the project publishes reads only what the project wrote)
    └── community/<arch>/  the community containers' builds; inside both, one directory per package
```

Install, from a checkout of this repository on the host (or copy the three
files over):

```bash
sudo factory/host/setup.sh                        # then log in again (the docker group)
$EDITOR /srv/omarchy-pool/etc/agent.env           # GEMINI_API_KEY=… (or another provider's)
OMARCHY_CONTRIBUTOR_TOKEN=omc_… /srv/omarchy-pool/register.sh
cd /srv/omarchy-pool && docker compose pull && docker compose up -d
systemctl --user enable --now omarchy-pool-rollout.timer   # rolling upgrades from then on
```

Operate:

```bash
docker compose ps                                 # the six, and whether they are up
docker compose logs -f --tail 50 review-aarch64   # one worker
./rollout.sh                                      # a rolling upgrade now (the timer does it within 15 minutes of a release); --check to only look
systemctl --user list-timers omarchy-pool-rollout.timer   # when it last ran, when it runs next; journalctl --user -u omarchy-pool-rollout for its log
docker compose restart pool-x86_64                # a worker that looks stuck — also a drain: it finishes its task first (up to 3 h); docker kill for one that must die now
```

The Workers page lists the six by role, with the agent each reports; a
worker that is not alive there is not running here. Moving the tree to
another disk (the 4 TB one, when it has a USB enclosure) is `docker compose
down`, copy, mount at the same `POOL_ROOT`, `docker compose up -d`.

## x86_64 builds

The host is aarch64 and its kernel (Asahi) uses 16K pages. x86_64 *pool
jobs* are a label and run natively. x86_64 *builds* would run under
user-mode emulation, and on a 16K-page host qemu cannot map every x86_64
library: `rustc` (through libedit), `sudo` (libldap) and others fail with
*failed to map segment from shared object* — a C package builds, a Rust
one does not. So the two x86_64 build services are behind the `emulated`
profile and off by default: x86_64 build tasks stay queued, the Pipeline
lists them as queued, and nothing burns attempts or agent
calls on them. Any x86_64 machine with docker becomes the x86_64 build
host in minutes: copy `compose.yml`, `.env`, `etc/agent.env`,
`etc/community-x86_64.env` and `etc/review-x86_64.env` there, drop the
`profiles:` lines (they are native there), `docker compose up -d
broker-community-x86_64 community-x86_64 review-x86_64`. `COMPOSE_PROFILES=emulated` in `.env`
turns the emulated pair on here regardless, for C-only packages (a
toolchain that cannot start there sends the build back to the queue: *Run a
worker* in the docs).
