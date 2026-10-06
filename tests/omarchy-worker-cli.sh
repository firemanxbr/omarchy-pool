#!/usr/bin/env bash
# omarchy-worker (factory/host/omarchy-worker), a maintainer's legacy worker
# set until P3, against a stubbed docker and pool. The pool serves neither
# the command nor its compose file any more (#343): a directory without the
# compose file an earlier start wrote is refused with the pointer to the
# maintainer-host docs, nothing written, and no call ever asks the pool for
# the command, its compose file or a mode — `share` and `--shared` are gone.
# In a set's directory `start --token` writes a .env of mode 600 with the
# token, the directory's absolute path (the updater mounts it at the same
# path), the socket and the profile; the options land in .env; `update`
# wakes the running updater (#277), or runs one round when none runs; a
# token for the other architecture is refused; a machine without a runtime
# is told so; in a set the host agent retired (its .omarchy-agent marker,
# #313) start, update and remove refuse before they change anything.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home"
export STUB_LOG="$tmp/log" STUB_ALL="$tmp/all" HOME="$tmp/home" STUB_ARCH="$(uname -m)" OMARCHY_API=http://pool.test
[[ "$STUB_ARCH" == arm64 ]] && STUB_ARCH=aarch64
: > "$STUB_LOG"; : > "$STUB_ALL"
cp "$root/factory/host/omarchy-worker" "$tmp/omarchy-worker"; chmod +x "$tmp/omarchy-worker"
# What an earlier start wrote in a set's directory: the compose file the pool served then.
seed() { mkdir -p "$1"; printf 'name: ${COMPOSE_PROJECT_NAME:-omarchy-worker}\nservices: {}\n' > "$1/compose.yml"; }
cat > "$tmp/bin/docker" <<'S'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
case "$1 ${2:-}" in
  "compose version"|"info ") exit 0 ;;
  "info -f") echo "Docker Desktop" ;;
  "context inspect") echo "unix://$HOME/.docker/run/docker.sock" ;;
  "compose pull") exit 0 ;;
  "compose up") exit 0 ;;
  # ps -q --status running updater: the running updater's id, none when STUB_NO_UPDATER; the table otherwise.
  "compose ps") if [[ " $* " == *" -q "* ]]; then [[ -n "${STUB_NO_UPDATER:-}" ]] || echo cid-updater; else printf 'broker Up 1 second\nworker Up 1 second\nupdater Up 1 second\n'; fi ;;
  "compose down"|"compose --profile"|"compose run") exit 0 ;;
  *) exit 0 ;;
esac
S
cat > "$tmp/bin/curl" <<'S'
#!/usr/bin/env bash
url="${@: -1}"; for a in "$@"; do [[ "$a" == http* ]] && url="$a"; done
echo "curl $url" >> "$STUB_LOG"; echo "curl $url" >> "$STUB_ALL"
case "$url" in
  */api/v1/factory/workers/self)
    if [[ "${STUB_SELF_CODE:-200}" != 200 ]]; then printf '{"error":"a worker token is required"}\n%s' "$STUB_SELF_CODE"; exit 0; fi
    printf '{"id":"alice-laptop-ab12","arch":"%s","trust":"community","owner":"alice"}' "$STUB_ARCH"; [[ " $* " == *" -w "* ]] && printf '\n200'; echo ;;
  */api/v1/version) echo '{"version":"v0.0.177"}' ;;
  *) exit 22 ;;
esac
S
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH"

# A directory no earlier start set up: refused with the pointer — no file, no runtime, no pool asked; the pool starts no new set.
d="$HOME/.config/omarchy-worker"
if out="$("$tmp/omarchy-worker" start --token omw_test123 2>&1)"; then echo "start in a directory with no set must be refused: $out"; exit 1; fi
grep -qF "omarchy-worker: no worker set here ($(cd "$d" && pwd -P)/compose.yml): the pool no longer starts new worker sets (#343) — contributors run no worker, and a maintainer's machine joins the pool as a host: https://omarchy-pool.org/docs/worker-host" <<<"$out" || { echo "the refusal points at the maintainer-host docs: $out"; exit 1; }
[[ ! -e "$d/.env" && ! -e "$d/compose.yml" && ! -s "$STUB_LOG" ]] || { echo "a refused start writes nothing and calls nothing: $(ls -A "$d") $(cat "$STUB_LOG")"; exit 1; }
if out="$("$tmp/omarchy-worker" update 2>&1)"; then echo "update with no set must be refused: $out"; exit 1; fi
grep -q "no worker set here" <<<"$out" && [[ ! -s "$STUB_LOG" ]] || { echo "update with no set is refused the same way: $out / $(cat "$STUB_LOG")"; exit 1; }

# start in a set's directory: the .env, the pull, the up — and the compose file it has, kept.
seed "$d"
out="$("$tmp/omarchy-worker" start --token omw_test123 --where laptop --github-token github_pat_x --claude-token sk-ant-oat01-x)"
real="$(cd "$d" && pwd -P)"
[[ -f "$d/compose.yml" && -f "$d/.env" ]] || { echo "start keeps compose.yml and writes .env in $d"; exit 1; }
[[ "$(stat -c %a "$d/.env" 2>/dev/null || stat -f %Lp "$d/.env")" == 600 ]] || { echo ".env holds the token: mode 600"; exit 1; }
# Values single-quoted, compose's way (a # or a $ in a value means nothing); the directory by its real path.
for kv in "OMARCHY_WORKER_TOKEN='omw_test123'" "OMARCHY_WORKER_DIR='$real'" "OMARCHY_SOCKET='/var/run/docker.sock'" "COMPOSE_PROFILES='community'" "COMPOSE_PROJECT_NAME='omarchy-worker'" "WHERE='laptop'" "GITHUB_TOKEN='github_pat_x'" "CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-x'"; do
  grep -qxF "$kv" "$d/.env" || { echo "missing in .env: $kv — $(cat "$d/.env")"; exit 1; }
done
grep -q "^WORKER_SHARED=" "$d/.env" && { echo "no mode is written any more: $(cat "$d/.env")"; exit 1; }
grep -qx 'services: {}' "$d/compose.yml" || { echo "start keeps the set's own compose file: $(cat "$d/compose.yml")"; exit 1; }
grep -q "worker alice-laptop-ab12 ($STUB_ARCH) — docker, $real" <<<"$out" || { echo "start names the registration and the runtime: $out"; exit 1; }
grep -q "docker compose pull" "$STUB_LOG" && grep -q "docker compose up -d --remove-orphans" "$STUB_LOG" || { echo "start pulls and starts: $(cat "$STUB_LOG")"; exit 1; }
grep -q "running: broker Up 1 second · worker Up 1 second · updater Up 1 second" <<<"$out" || { echo "start reports what runs: $out"; exit 1; }

# start again without --token: the token stays; an option changes the .env only where given; a value with # " $ survives as it is.
: > "$STUB_LOG"
"$tmp/omarchy-worker" start --where 'the #1 "box" $HOME' >/dev/null
grep -qxF "OMARCHY_WORKER_TOKEN='omw_test123'" "$d/.env" && grep -qxF "WHERE='the #1 \"box\" \$HOME'" "$d/.env" || { echo "a second start keeps the token and the rest, quotes the value: $(cat "$d/.env")"; exit 1; }

# No mode any more (#343): share and --shared / --own are unknown, and change nothing.
cp "$d/.env" "$tmp/env.before"; : > "$STUB_LOG"
for args in "share on" "start --shared" "start --own"; do
  # shellcheck disable=SC2086
  if out="$("$tmp/omarchy-worker" $args 2>&1)"; then echo "$args must be refused: $out"; exit 1; fi
  grep -qE "unknown (command share|option --shared|option --own)" <<<"$out" || { echo "$args is unknown: $out"; exit 1; }
done
cmp -s "$d/.env" "$tmp/env.before" && [[ ! -s "$STUB_LOG" ]] || { echo "an unknown option changes nothing and calls nothing: $(cat "$STUB_LOG")"; exit 1; }

# A project set in another directory (--dir after the command works too): the profile, the role, the work directory, a project name of its own.
seed "$tmp/proj"
"$tmp/omarchy-worker" start --token omw_proj --project --role review --dir "$tmp/proj" >/dev/null
grep -qxF "COMPOSE_PROFILES='project'" "$tmp/proj/.env" && grep -qxF "OMARCHY_WORKER_ROLE='review'" "$tmp/proj/.env" && [[ -d "$tmp/proj/work" ]] || { echo "--project: the profile, the role, the work directory: $(cat "$tmp/proj/.env")"; exit 1; }
grep -qE "^COMPOSE_PROJECT_NAME='omarchy-worker-[0-9a-f]{8}'$" "$tmp/proj/.env" || { echo "another directory gets a project name of its own: $(cat "$tmp/proj/.env")"; exit 1; }
# A second start there without --project stays a project set.
"$tmp/omarchy-worker" --dir "$tmp/proj" start >/dev/null
grep -qxF "COMPOSE_PROFILES='project'" "$tmp/proj/.env" || { echo "the profile is remembered: $(cat "$tmp/proj/.env")"; exit 1; }
# Another option alone keeps the profile; --community switches it, draining the project set first.
"$tmp/omarchy-worker" --dir "$tmp/proj" start --where rack >/dev/null
grep -qxF "COMPOSE_PROFILES='project'" "$tmp/proj/.env" || { echo "--where alone keeps the profile (--project/--community change it)"; exit 1; }
: > "$STUB_LOG"
out="$("$tmp/omarchy-worker" --dir "$tmp/proj" start --community)"
grep -q "switching from project to community: the project set drains and stops first" <<<"$out" && grep -q "docker compose --profile project down" "$STUB_LOG" && grep -qxF "COMPOSE_PROFILES='community'" "$tmp/proj/.env" || { echo "a switch drains the old set: $out / $(cat "$STUB_LOG")"; exit 1; }
# stop takes every profile's containers down.
: > "$STUB_LOG"
"$tmp/omarchy-worker" --dir "$tmp/proj" stop >/dev/null
grep -q "docker compose --profile \* down" "$STUB_LOG" || { echo "stop downs every profile: $(cat "$STUB_LOG")"; exit 1; }
# update wakes the updater that runs (#277): a kick, and no round of its own beside it — the updater's lock and guard are its.
: > "$STUB_LOG"
out="$("$tmp/omarchy-worker" update)"
grep -q "docker compose kill -s USR1 updater" "$STUB_LOG" || { echo "update wakes the running updater: $(cat "$STUB_LOG")"; exit 1; }
grep -q "docker compose run" "$STUB_LOG" && { echo "no round of its own beside a running updater: $(cat "$STUB_LOG")"; exit 1; }
grep -q "woke the updater" <<<"$out" || { echo "update says it woke it: $out"; exit 1; }
# No updater runs: one round of the updater, not its loop.
export STUB_NO_UPDATER=1
: > "$STUB_LOG"
out="$("$tmp/omarchy-worker" update)"
grep -q "docker compose run --rm --no-deps updater --once" "$STUB_LOG" || { echo "update runs the updater once when none runs: $(cat "$STUB_LOG")"; exit 1; }
grep -q "docker compose kill" "$STUB_LOG" && { echo "nothing to wake: $(cat "$STUB_LOG")"; exit 1; }
grep -q "no updater runs here" <<<"$out" || { echo "and says so: $out"; exit 1; }
unset STUB_NO_UPDATER

# The switch guard (#313): in a set the host agent retired (its .omarchy-agent marker in the directory), start, update and remove
# exit non-zero before they touch a file or a container — no docker or pool call, no file of the directory changed — and say what
# to look at instead. The same directories without the marker: the runs above, and the update and remove right below.
snapshot() { (cd "$1" && find . -print | LC_ALL=C sort && find . -type f -exec cksum {} + | LC_ALL=C sort); }
for dir in "$d" "$tmp/proj"; do
  printf 'agent=0.1.0\nhost=h_0123456789abcdef\nsince=2026-10-15T12:00:00Z\n' > "$dir/.omarchy-agent"
  snapshot "$dir" > "$tmp/before"
  for args in "start --token omw_again" "start --project" update remove; do
    : > "$STUB_LOG"
    # shellcheck disable=SC2086
    if out="$("$tmp/omarchy-worker" --dir "$dir" $args 2>&1)"; then echo "$args with the marker must be refused: $out"; exit 1; fi
    grep -qF "omarchy-worker: ${args%% *}: not done, and nothing changed: this machine is a maintainer host managed by omarchy-agent, which retired this set ($(cd "$dir" && pwd -P)/.omarchy-agent) — nothing needs to be run here; see: omarchy-agent status" <<<"$out" || { echo "$args with the marker says what to look at instead: $out"; exit 1; }
    [[ ! -s "$STUB_LOG" ]] || { echo "$args with the marker calls no runtime and no pool: $(cat "$STUB_LOG")"; exit 1; }
    snapshot "$dir" | cmp -s - "$tmp/before" || { echo "$args with the marker changes no file in $dir: $(snapshot "$dir" | diff "$tmp/before" - || true)"; exit 1; }
  done
  rm -f "$dir/.omarchy-agent"
done
# The marker gone: update wakes the updater again, remove removes the set's files.
: > "$STUB_LOG"
"$tmp/omarchy-worker" update >/dev/null
grep -q "docker compose kill -s USR1 updater" "$STUB_LOG" || { echo "update without the marker wakes the updater: $(cat "$STUB_LOG")"; exit 1; }
: > "$STUB_LOG"
"$tmp/omarchy-worker" --dir "$tmp/proj" remove >/dev/null
grep -q "docker compose --profile \* down" "$STUB_LOG" && [[ ! -e "$tmp/proj/.env" && ! -e "$tmp/proj/compose.yml" ]] || { echo "remove without the marker downs the set and removes its files: $(cat "$STUB_LOG")"; exit 1; }

# The other architecture's token: refused before anything starts.
export STUB_ARCH=$([[ "$STUB_ARCH" == aarch64 ]] && echo x86_64 || echo aarch64)
seed "$tmp/other"; seed "$tmp/other2"
if out="$("$tmp/omarchy-worker" --dir "$tmp/other" start --token omw_other 2>&1)"; then echo "a token for the other architecture must be refused: $out"; exit 1; fi
grep -q "the token is for a $STUB_ARCH worker; this machine is" <<<"$out" || { echo "the reason: $out"; exit 1; }
# A token the pool refuses (revoked, mistyped): refused, not "offline".
export STUB_SELF_CODE=401
if out="$("$tmp/omarchy-worker" --dir "$tmp/other2" start --token omw_bad 2>&1)"; then echo "a refused token must not start a set: $out"; exit 1; fi
grep -q "the pool refuses this token (401" <<<"$out" || { echo "the reason: $out"; exit 1; }
unset STUB_SELF_CODE
# status: what runs, what the pool thinks, the image against the pool's release.
export STUB_ARCH="$(uname -m)"; [[ "$STUB_ARCH" == arm64 ]] && STUB_ARCH=aarch64
out="$("$tmp/omarchy-worker" status)"
grep -q "the pool: alice-laptop-ab12 · community · $STUB_ARCH · contributors' builds" <<<"$out" || { echo "status asks the pool: $out"; exit 1; }
# No runtime: told what to install. (The stubs answer as an absent or stopped runtime would — a CI runner has a real docker on its PATH.)
printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/bin/docker"; cp "$tmp/bin/docker" "$tmp/bin/podman"; chmod +x "$tmp/bin/docker" "$tmp/bin/podman"
if out="$("$tmp/omarchy-worker" status 2>&1)"; then echo "no runtime must fail: $out"; exit 1; fi
grep -q "no container runtime found" <<<"$out" || { echo "the reason: $out"; exit 1; }
# Nothing the whole run did asked the pool for the command, its compose file or a mode (#343).
grep -E "/omarchy-worker|/mode$" "$STUB_ALL" && { echo "a call to a door the pool closed"; exit 1; }
echo "omarchy-worker-cli: ok"
