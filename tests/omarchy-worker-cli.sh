#!/usr/bin/env bash
# omarchy-worker, the one command (worker/src/omarchy-worker.sh), against a
# stubbed docker and pool: `start --token` writes compose.yml and a .env of
# mode 600 with the token, the directory's absolute path (the updater mounts
# it at the same path), the socket and the profile; the options land in
# .env; `share on|off` flips the switch and restarts the builder; a token
# for the other architecture is refused; a machine without a runtime is
# told so.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home"
export STUB_LOG="$tmp/log" HOME="$tmp/home" STUB_ARCH="$(uname -m)"
[[ "$STUB_ARCH" == arm64 ]] && STUB_ARCH=aarch64
: > "$STUB_LOG"
sed "s|__API__|http://pool.test|g" "$root/worker/src/omarchy-worker.sh" > "$tmp/omarchy-worker"; chmod +x "$tmp/omarchy-worker"
cat > "$tmp/bin/docker" <<'S'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
case "$1 ${2:-}" in
  "compose version"|"info ") exit 0 ;;
  "info -f") echo "Docker Desktop" ;;
  "context inspect") echo "unix://$HOME/.docker/run/docker.sock" ;;
  "compose pull") exit 0 ;;
  "compose up") exit 0 ;;
  "compose ps") printf 'broker Up 1 second\nworker Up 1 second\nupdater Up 1 second\n' ;;
  "compose down"|"compose --profile"|"compose run") exit 0 ;;
  *) exit 0 ;;
esac
S
cat > "$tmp/bin/curl" <<'S'
#!/usr/bin/env bash
url="${@: -1}"; for a in "$@"; do [[ "$a" == http* ]] && url="$a"; done
echo "curl $url" >> "$STUB_LOG"
out=""; for ((i=1; i<=$#; i++)); do [[ "${!i}" == -o ]] && { j=$((i+1)); out="${!j}"; }; done
case "$url" in
  */omarchy-worker/compose.yml) printf 'name: ${COMPOSE_PROJECT_NAME:-omarchy-worker}\nservices: {}\n' > "$out" ;;
  */api/v1/factory/workers/self/mode) echo '{"id":"alice-laptop-ab12","mode":"shared","by":"worker","note":"from its next claim it builds whatever is queued, anyone'"'"'s"}' ;;
  */api/v1/factory/workers/self)
    if [[ "${STUB_SELF_CODE:-200}" != 200 ]]; then printf '{"error":"a worker token is required"}\n%s' "$STUB_SELF_CODE"; exit 0; fi
    printf '{"id":"alice-laptop-ab12","arch":"%s","trust":"community","owner":"alice","mode":"dedicated"}' "$STUB_ARCH"; [[ " $* " == *" -w "* ]] && printf '\n200'; echo ;;
  */api/v1/version) echo '{"version":"v0.0.177"}' ;;
  *) exit 22 ;;
esac
S
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH"

# start: the files, the .env, the pull, the up.
out="$("$tmp/omarchy-worker" start --token omw_test123 --shared --where laptop --github-token github_pat_x --claude-token sk-ant-oat01-x)"
d="$HOME/.config/omarchy-worker"; real="$(cd "$d" && pwd -P)"
[[ -f "$d/compose.yml" && -f "$d/.env" ]] || { echo "start writes compose.yml and .env in $d"; exit 1; }
[[ "$(stat -c %a "$d/.env" 2>/dev/null || stat -f %Lp "$d/.env")" == 600 ]] || { echo ".env holds the token: mode 600"; exit 1; }
# Values single-quoted, compose's way (a # or a $ in a value means nothing); the directory by its real path.
for kv in "OMARCHY_WORKER_TOKEN='omw_test123'" "OMARCHY_WORKER_DIR='$real'" "OMARCHY_SOCKET='/var/run/docker.sock'" "COMPOSE_PROFILES='community'" "COMPOSE_PROJECT_NAME='omarchy-worker'" "WORKER_SHARED='1'" "WHERE='laptop'" "GITHUB_TOKEN='github_pat_x'" "CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-x'"; do
  grep -qxF "$kv" "$d/.env" || { echo "missing in .env: $kv — $(cat "$d/.env")"; exit 1; }
done
grep -q "worker alice-laptop-ab12 ($STUB_ARCH) — docker, $real" <<<"$out" || { echo "start names the registration and the runtime: $out"; exit 1; }
grep -q "docker compose pull" "$STUB_LOG" && grep -q "docker compose up -d --remove-orphans" "$STUB_LOG" || { echo "start pulls and starts: $(cat "$STUB_LOG")"; exit 1; }
grep -q "running: broker Up 1 second · worker Up 1 second · updater Up 1 second" <<<"$out" || { echo "start reports what runs: $out"; exit 1; }

# start again without --token: the token stays; an option changes the .env only where given; a value with # " $ survives as it is.
"$tmp/omarchy-worker" start --own --where 'the #1 "box" $HOME' >/dev/null
grep -qxF "OMARCHY_WORKER_TOKEN='omw_test123'" "$d/.env" && grep -qxF "WORKER_SHARED='0'" "$d/.env" && grep -qxF "WHERE='the #1 \"box\" \$HOME'" "$d/.env" || { echo "a second start keeps the token and the rest, applies the switch, quotes the value: $(cat "$d/.env")"; exit 1; }

# share on: the brain is told (the worker's own token), the .env keeps it, nothing restarts.
: > "$STUB_LOG"
out="$("$tmp/omarchy-worker" share on)"
grep -q "curl http://pool.test/api/v1/factory/workers/self/mode" "$STUB_LOG" && grep -qxF "WORKER_SHARED='1'" "$d/.env" || { echo "share on tells the pool and keeps it in .env: $(cat "$STUB_LOG")"; exit 1; }
grep -q "docker compose up" "$STUB_LOG" && { echo "share on restarts nothing: $(cat "$STUB_LOG")"; exit 1; }
grep -q "from its next claim it builds whatever is queued" <<<"$out" || { echo "share on says what the pool said: $out"; exit 1; }

# A project worker in another directory (--dir after the command works too): the profile, the role, the work directory, a project name of its own.
"$tmp/omarchy-worker" start --token omw_proj --project --role review --dir "$tmp/proj" >/dev/null
grep -qxF "COMPOSE_PROFILES='project'" "$tmp/proj/.env" && grep -qxF "OMARCHY_WORKER_ROLE='review'" "$tmp/proj/.env" && [[ -d "$tmp/proj/work" ]] || { echo "--project: the profile, the role, the work directory: $(cat "$tmp/proj/.env")"; exit 1; }
grep -qE "^COMPOSE_PROJECT_NAME='omarchy-worker-[0-9a-f]{8}'$" "$tmp/proj/.env" || { echo "another directory gets a project name of its own: $(cat "$tmp/proj/.env")"; exit 1; }
# A second start there without --project stays a project set.
"$tmp/omarchy-worker" --dir "$tmp/proj" start >/dev/null
grep -qxF "COMPOSE_PROFILES='project'" "$tmp/proj/.env" || { echo "the profile is remembered: $(cat "$tmp/proj/.env")"; exit 1; }
# --own alone keeps the profile; --community switches it, draining the project set first.
"$tmp/omarchy-worker" --dir "$tmp/proj" start --own >/dev/null
grep -qxF "COMPOSE_PROFILES='project'" "$tmp/proj/.env" || { echo "--own alone keeps the profile (--project/--community change it)"; exit 1; }
: > "$STUB_LOG"
out="$("$tmp/omarchy-worker" --dir "$tmp/proj" start --community)"
grep -q "switching from project to community: the project set drains and stops first" <<<"$out" && grep -q "docker compose --profile project down" "$STUB_LOG" && grep -qxF "COMPOSE_PROFILES='community'" "$tmp/proj/.env" || { echo "a switch drains the old set: $out / $(cat "$STUB_LOG")"; exit 1; }
# stop takes every profile's containers down.
: > "$STUB_LOG"
"$tmp/omarchy-worker" --dir "$tmp/proj" stop >/dev/null
grep -q "docker compose --profile \* down" "$STUB_LOG" || { echo "stop downs every profile: $(cat "$STUB_LOG")"; exit 1; }
# update runs one round of the updater, not its loop.
: > "$STUB_LOG"
"$tmp/omarchy-worker" update >/dev/null
grep -q "docker compose run --rm --no-deps updater --once" "$STUB_LOG" || { echo "update runs the updater once: $(cat "$STUB_LOG")"; exit 1; }

# The other architecture's token: refused before anything starts.
export STUB_ARCH=$([[ "$STUB_ARCH" == aarch64 ]] && echo x86_64 || echo aarch64)
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
grep -q "the pool: alice-laptop-ab12 · community · $STUB_ARCH · own packages only" <<<"$out" || { echo "status asks the pool: $out"; exit 1; }
# No runtime: told what to install. (The stubs answer as an absent or stopped runtime would — a CI runner has a real docker on its PATH.)
printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/bin/docker"; cp "$tmp/bin/docker" "$tmp/bin/podman"; chmod +x "$tmp/bin/docker" "$tmp/bin/podman"
if out="$("$tmp/omarchy-worker" status 2>&1)"; then echo "no runtime must fail: $out"; exit 1; fi
grep -q "no container runtime found" <<<"$out" || { echo "the reason: $out"; exit 1; }
echo "omarchy-worker-cli: ok"
