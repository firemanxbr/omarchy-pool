# The `host` set

What every maintainer host runs (design v2 §4.1, §4.2; epic #307): one
service, the `dispatcher`, which claims as many tasks as the host's capacity
allows and starts one isolated, credential-less container per task.

| File | What it is |
|---|---|
| `compose.yml` | the template: the dispatcher, its image as `@RELEASE@`, the build and worker images as placeholders release.yml renders to the manifest's digests |
| `set.toml` | schema 3: the compose project name, the rollout guard, the dispatcher's ready check, and what the host needs (`[needs]`) that the agent checks but never does |
| `files/` | host files copied into the set directory, hash-checked and rolled back with the template (none yet; `.gitkeep` only keeps the directory and is not a host file: the bundler, #311, skips dotfiles here) |

release.yml ships it in the signed host bundle (#311, `factory/bin/host-bundle`):
`compose.yml` with the placeholders rendered to digests, `set.toml` and
`files/`, each by its SHA-256 in the manifest; this README stays here.

`omarchy-agent lint-set factory/sets/host` checks the template and
`set.toml` (design v2 §4.3); CI runs it with `docker compose config` of the
rendered template (`tests/host-set.sh`). The root-only steps a new host
needs once are `factory/host/prep-root.sh`, run by a person, never by the
agent.

`run/capacity.json` (schema 2, design v2 §7.3) is the agent's, never the
release's: it detects the host's CPUs, memory, both free disks and limits,
turns them into units with the release's signed constants and the owner's
caps, and rewrites the file only when something in it changed (#333). The
dispatcher reads it read-only; `below_minimum` (with `units` 0) means it
claims nothing. `omarchy-agent capacity --work-root <dir>` prints what the
probes see on a host; with `--bundle`/`--sig` of a release, the units, the
preflight blockers and, with `--write <set dir>`, the file.

On a rootful daemon with `userns-remap` on (what prep-root.sh turns on for a
new daemon, design v2 §19.1), the dispatcher alone needs `userns_mode: host`
to use the socket and the work root. The template leaves it out (design v2
§4.2) and lint allows it only through the envelope (`userns_remap = true`): the
agent's overlay (`agent.yml`, beside its labels, #315) adds it for such a
host.

The legacy files (`factory/host/{compose.yml,setup.sh,rollout.sh,register.sh}`,
`factory/image/compose.yml`) stay unchanged until the switches of design v2
§21; this set is a new template, not a copy of them.
