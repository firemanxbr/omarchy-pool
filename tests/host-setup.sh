#!/usr/bin/env bash
# The Studio's host files (factory/host/, #277 part 3), against stubs: the
# one-time step of the runbook's *The Studio host*, which moves the host to
# the updater.
#
# - setup.sh installs a compose.yml whose `updater` service has the
#   runtime's socket and POOL_ROOT at the same path, read-only, and no
#   token; and a rollout.sh whose second line is the marker a project
#   worker reports (`# omarchy-rollout: kick-v1`).
# - It writes an env file, mode 600, for every env_file compose.yml names
#   (#295: review2's were missing, and compose loads no project without
#   them), and the review2 pair is behind a profile of its own, so no
#   default or emulated profile starts an unregistered pair.
# - Before anything of a running host changes, it checks the new
#   compose.yml against a staged copy of the host's .env and etc/ — with the
#   placeholders it would write — under the host's profiles and under every
#   profile, and .env's POOL_ROOT; on a host from before #277 also that the
#   updater image follows the pool and that every service compose would run
#   holds a worker token. Any of those: exit 4, the timer untouched.
# - On a host from before #277 it stops (never disables) the user timer
#   that ran the old rollout.sh, as the user who owns it, so a reboot
#   brings it back; waits while a rollout that timer started still runs,
#   installs the new files (the old ones kept in setup-backup-<time>/, the
#   difference in compose.yml shown), starts the updater and checks it
#   stays up and passes its self-test, and only then disables the timer and
#   removes its units — said retired only when that user's systemd says it
#   is stopped. A timer it cannot confirm stopped: said, exit 3, nothing
#   installed. A rollout still running after 4 h, an interrupt during the
#   wait (TERM, HUP), or an updater that does not start, restarts or fails
#   its self-test: the updater stopped and removed, the old files back, the
#   timer enabled again (exit 3, 143, 129, or 5) — all of it even when the
#   output's reader is gone. On a fresh host it writes no timer and starts
#   nothing.
# - rollout.sh only wakes the updater: SIGUSR1 to a running one, and one
#   that is not running started as it is (`--no-recreate`: never recreated
#   onto an image its guard has not passed); `--check` asks the updater's
#   own omarchy-rollout; it runs no rollout of its own.
#
# setup.sh runs as root on a real host: here its root check is lifted in a
# copy, and pacman, systemctl, runuser, chown, install's owner, docker and
# the rest are stubs on PATH that record what they were asked.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/src" "$tmp/home" "$tmp/docker"
export STUB_LOG="$tmp/log" STUB_HOME="$tmp/home"
: > "$STUB_LOG"
fail() { echo "FAIL: $*" >&2; echo "--- log ---" >&2; cat "$STUB_LOG" >&2; exit 1; }

# The host files as a checkout has them, setup.sh's root check lifted (EUID is read-only in bash).
cp "$root/factory/host/compose.yml" "$root/factory/host/register.sh" "$root/factory/host/rollout.sh" "$tmp/src/"
sed 's/\[\[ \$EUID -eq 0 \]\]/[[ 0 -eq 0 ]]/' "$root/factory/host/setup.sh" > "$tmp/src/setup.sh"
grep -q '\[\[ 0 -eq 0 \]\]' "$tmp/src/setup.sh" || fail "the root check was not found to lift"

stub() { # name body
  printf '#!/usr/bin/env bash\n%s\n' "$2" > "$tmp/bin/$1"; chmod +x "$tmp/bin/$1"
}
stub pacman 'echo "pacman $*" >> "$STUB_LOG"'
# The user's systemd: a unit's ActiveState from STUB_UNITS/<unit> — one line a call, the last one again and again — "inactive" when
# there is no file; no answer at all (its bus unreachable) when STUB_UNITS/nobus exists. Each answer about the rollout's service
# notes whether the installed compose.yml has the updater yet.
stub systemctl 'echo "systemctl $*" >> "$STUB_LOG"
[[ "$1" == --user && -e "$STUB_UNITS/nobus" ]] && { echo "Failed to connect to bus: No such file or directory" >&2; exit 1; }
if [[ "$1 $2 $3 $4" == "--user show -p ActiveState" ]]; then
  [[ "$6" == omarchy-pool-rollout.service ]] && { grep -q "^  updater:" "$STUB_POOL/compose.yml" 2>/dev/null && echo "compose has the updater" || echo "compose without the updater"; } >> "$STUB_LOG"
  f="$STUB_UNITS/$6"; [[ -f "$f" ]] || { echo inactive; exit 0; }
  n=$(( $(cat "$f.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f.n"
  line="$(sed -n "${n}p" "$f")"; [[ -n "$line" ]] || line="$(tail -n1 "$f")"; echo "$line"
fi
exit 0'
# sleep: instant; on the call STUB_UNITS/term-at names, a signal to the script that called it — STUB_UNITS/sig names it, TERM when
# it names none (an operator's Ctrl-C, a stop; HUP: a dropped session).
stub sleep 'echo "sleep $*" >> "$STUB_LOG"
if [[ -f "$STUB_UNITS/term-at" ]]; then n=$(( $(cat "$STUB_UNITS/sleeps" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_UNITS/sleeps"; (( n == $(cat "$STUB_UNITS/term-at") )) && kill -"$(cat "$STUB_UNITS/sig" 2>/dev/null || echo TERM)" "$PPID"; fi
exit 0'
stub usermod 'echo "usermod $*" >> "$STUB_LOG"'
stub chown 'echo "chown $*" >> "$STUB_LOG"'
stub loginctl 'echo "loginctl $*" >> "$STUB_LOG"'
stub btrfs 'echo "btrfs $*" >> "$STUB_LOG"; mkdir -p "${@: -1}"'
stub hostname 'echo omarchy-studio'
# stat -f -c %T: not btrfs here.
stub stat 'if [[ "$1" == -f ]]; then echo ext2/ext3; else exec /usr/bin/stat "$@"; fi'
# install -m MODE -o U -g G SRC DST: the copy and the mode, without an owner (no root here).
stub install 'args=(); while [[ $# -gt 0 ]]; do case "$1" in -o|-g) shift 2 ;; -d) shift; mkdir -p "$@"; exit 0 ;; -m) m="$2"; shift 2 ;; *) args+=("$1"); shift ;; esac; done; cp "${args[0]}" "${args[1]}"; chmod "${m:-644}" "${args[1]}"'
stub getent 'case "$1 $2" in "passwd firemanxbr") echo "firemanxbr:x:1000:1000::$STUB_HOME:/bin/bash" ;; "group docker") echo "docker:x:970:firemanxbr" ;; *) exit 2 ;; esac'
# runuser -u USER -- COMMAND…: logged, then the command runs (here, as this user).
stub runuser 'echo "runuser $*" >> "$STUB_LOG"; shift 3; exec "$@"'
stub id 'case "$1" in -u) [[ -n "${2:-}" ]] && echo 1000 || echo 1000 ;; -Gn) echo "firemanxbr docker" ;; -un) echo firemanxbr ;; *) exec /usr/bin/id "$@" ;; esac'
# docker: setup.sh runs compose as the updater does, with no environment of its own (env -i), so the stub carries its paths. What
# it answers, from files in STUB_DOCKER: config.fail, pull.fail, nolabel (the updater image from before #277), config.json (the
# project compose prints), up.fail, restarting, selftest.fail; `running` while the updater it started runs; wait-reader: a stop of
# the updater first waits (up to 120 s, else reader.timeout) until reader.done says the reader of setup.sh's output is gone.
cat > "$tmp/bin/docker" <<S
#!/usr/bin/env bash
STUB_LOG="$STUB_LOG"; STUB_DOCKER="$tmp/docker"
S
cat >> "$tmp/bin/docker" <<'S'
echo "docker $*" >> "$STUB_LOG"
# rollout.sh (the host's own shell, from POOL_ROOT): the updater's container when STUB_UPDATER says it runs.
[[ "$*" == "compose ps -q --status running updater" ]] && { [[ "${STUB_UPDATER:-}" == running ]] && echo 3f9c2a8e1b7d; exit 0; }
if [[ "$1" == compose && "$2" == --project-directory ]]; then
  d="$3"; shift 3; flags=""
  while [[ "$1" == --profile ]]; do flags+="$1 $2 "; shift 2; done
  case "$*" in
    "config -q")
      # As compose does: every env file the project names must be there, or nothing of it loads.
      for rel in $(sed -nE 's/^[[:space:]]*env_file:[[:space:]]*\[(.*)\].*/\1/p' "$d/compose.yml" | tr ',' ' '); do
        [[ -e "$d/$rel" ]] || { echo "env file $d/$rel not found: stat $d/$rel: no such file or directory" >&2; exit 1; }
      done
      [[ -f "$STUB_DOCKER/config.fail" ]] && { echo "services.pool-aarch64 additional properties 'imgae' not allowed" >&2; exit 15; }
      echo "config -q ok: $(grep -h '^COMPOSE_PROFILES=' "$d/.env" 2>/dev/null || echo 'no COMPOSE_PROFILES'), flags: ${flags:-none}, in $(basename "$(dirname "$d")")" >> "$STUB_LOG" ;;
    "config --format json")
      if [[ -f "$STUB_DOCKER/config.json" ]]; then cat "$STUB_DOCKER/config.json"
      else echo '{"name":"omarchy-pool","services":{"agent-proxy":{"image":"ghcr.io/firemanxbr/omarchy-worker:aarch64","environment":{"OMARCHY_WORKER_ROLE":"agent","GEMINI_API_KEY":""}},"pool-aarch64":{"image":"ghcr.io/firemanxbr/omarchy-worker:latest","environment":{"OMARCHY_WORKER_ROLE":"pool","OMARCHY_WORKER_TOKEN":"omw_0123456789abcdef"}},"updater":{"image":"ghcr.io/firemanxbr/omarchy-worker:latest","environment":{"OMARCHY_WORKER_ROLE":"updater"}}}}'; fi ;;
    "pull -q updater") [[ ! -f "$STUB_DOCKER/pull.fail" ]] || { echo "Error response from daemon: Get https://ghcr.io/v2/: net/http: TLS handshake timeout" >&2; exit 1; } ;;
    "up -d --no-deps --no-recreate updater") [[ ! -f "$STUB_DOCKER/up.fail" ]] || { echo "Error response from daemon: pull access denied" >&2; exit 1; }; touch "$STUB_DOCKER/running" ;;
    "ps -a -q updater") [[ -f "$STUB_DOCKER/running" ]] && echo 5d0e1f2a3b4c ;;
    "exec -T updater /usr/local/lib/omarchy-factory/bin/omarchy-rollout --self-test")
      [[ -f "$STUB_DOCKER/selftest.fail" ]] && { echo "self-test: compose does not read the project in /srv/omarchy-pool" >&2; exit 1; }
      echo "self-test: the socket answers; compose reads /srv/omarchy-pool"; echo "follows 1" ;;
    "stop updater")
      if [[ -f "$STUB_DOCKER/wait-reader" ]]; then
        n=0; until [[ -f "$STUB_DOCKER/reader.done" ]]; do (( n++ < 1200 )) || { touch "$STUB_DOCKER/reader.timeout"; break; }; /bin/sleep 0.1; done
      fi ;;
    "rm -f updater") rm -f "$STUB_DOCKER/running" ;;
    *) echo "unexpected compose $*" >&2; exit 9 ;;
  esac
  exit 0
fi
case "$1 $2" in
  "image inspect") [[ -f "$STUB_DOCKER/nolabel" ]] && echo "<no value>" || echo 1 ;;
  "inspect -f") [[ -f "$STUB_DOCKER/restarting" ]] && echo "restarting 3" || echo "running 0" ;;
esac
exit 0
S
chmod +x "$tmp/bin/docker"
export PATH="$tmp/bin:$PATH" STUB_UNITS="$tmp/units"
mkdir -p "$STUB_UNITS"
line() { { grep -n -- "$1" "$STUB_LOG" || true; } | head -1 | cut -d: -f1; }
mode() { /usr/bin/stat -c %a "$1" 2>/dev/null || /usr/bin/stat -f %Lp "$1"; }

# 1. A host from before #277: the timer and its service are there.
units="$tmp/home/.config/systemd/user"
old_timer() { # the timer and its service, as #278's setup.sh wrote them
  mkdir -p "$units"
  printf '[Timer]\nOnUnitActiveSec=15min\n' > "$units/omarchy-pool-rollout.timer"
  printf '[Service]\nExecStart=/srv/omarchy-pool/rollout.sh\n' > "$units/omarchy-pool-rollout.service"
}
POOL="$tmp/srv/omarchy-pool"
export STUB_POOL="$POOL"
# The host runs #278's files: a compose.yml without the updater (with an edit of its own), the old rollout.sh, and the six env files
# setup.sh wrote before #295 — no review2 ones. Its .env turns the emulated profile on, as the Studio's does.
old_host() {
  rm -rf "$POOL" "$tmp/docker"; mkdir -p "$POOL/etc" "$tmp/docker"
  printf 'services:\n  pool-aarch64:\n    image: ghcr.io/firemanxbr/omarchy-worker:latest\n# local edit\n' > "$POOL/compose.yml"
  printf '#!/usr/bin/env bash\n# rollout.sh — a rolling upgrade of the host'"'"'s workers\n' > "$POOL/rollout.sh"
  printf 'POOL_ROOT=%s\nWHERE=omarchy-studio\nCOMPOSE_PROFILES=emulated\n' "$POOL" > "$POOL/.env"
  for svc in pool-x86_64 pool-aarch64 review-x86_64 review-aarch64 community-x86_64 community-aarch64; do printf 'OMARCHY_WORKER_TOKEN=omw_%s0123456789\n' "$svc" > "$POOL/etc/$svc.env"; done
  printf 'GEMINI_API_KEY=k\n' > "$POOL/etc/agent.env"
  cp "$POOL/compose.yml" "$tmp/compose.before"; cp "$POOL/rollout.sh" "$tmp/rollout.before"
  rm -f "$STUB_UNITS"/omarchy-pool-rollout.* "$STUB_UNITS/term-at" "$STUB_UNITS/sleeps" "$STUB_UNITS/sig"
  old_timer; : > "$STUB_LOG"
}
run_setup() { set +e; SUDO_USER=firemanxbr bash "$tmp/src/setup.sh" "${1:-$POOL}" > "$tmp/out" 2>&1; rc=$?; set -e; }
# Nothing of the host changed: its files, its units, no updater started, the timer not touched.
untouched() { # why
  cmp -s "$POOL/compose.yml" "$tmp/compose.before" && cmp -s "$POOL/rollout.sh" "$tmp/rollout.before" || fail "$1: the host's compose.yml and rollout.sh stay as they were"
  [[ -e "$units/omarchy-pool-rollout.timer" && -e "$units/omarchy-pool-rollout.service" ]] || fail "$1: the timer's units stay"
  [[ ! -e "$POOL/etc/review2-aarch64.env" ]] || fail "$1: no env file is written"
  grep -qE "systemctl --user (stop|disable|enable)" "$STUB_LOG" && fail "$1: the timer is not touched"
  grep -q "up -d" "$STUB_LOG" && fail "$1: no updater is started"
  ls -d "$POOL"/setup-backup-* >/dev/null 2>&1 && fail "$1: nothing is backed up either"
  true
}
# Put back: the updater it started gone, the old files back, the timer enabled again (after it was stopped, and never disabled), its
# units still there.
put_back() { # why
  put_back_quiet "$1"
  grep -q "omarchy-pool-rollout.timer is enabled again: this host still rolls out through it" "$tmp/out" || fail "$1: and it says so: $(cat "$tmp/out")"
  grep -q "timer retired" "$tmp/out" && fail "$1: a timer put back is not called retired"
  true
}
put_back_quiet() { # why — the same, with nothing asked of what it said
  local stp en; stp="$(line 'systemctl --user stop omarchy-pool-rollout.timer')"; en="$(line 'systemctl --user enable --now omarchy-pool-rollout.timer')"
  [[ -n "$stp" && -n "$en" ]] && (( stp < en )) || fail "$1: the timer is enabled again after it was stopped: stop at ${stp:-never}, enable at ${en:-never}"
  grep -q "systemctl --user disable" "$STUB_LOG" && fail "$1: a timer that is put back was never disabled (a reboot would have lost it): $(grep -n 'systemctl --user' "$STUB_LOG")"
  cmp -s "$POOL/compose.yml" "$tmp/compose.before" && cmp -s "$POOL/rollout.sh" "$tmp/rollout.before" || fail "$1: compose.yml and rollout.sh are back as they were"
  [[ -e "$units/omarchy-pool-rollout.timer" && -e "$units/omarchy-pool-rollout.service" ]] || fail "$1: the timer's units stay"
  [[ ! -e "$POOL/etc/review2-aarch64.env" ]] || fail "$1: the env files it wrote are gone again"
  true
}

# 1a. The timer cannot be confirmed stopped (its user's systemd does not answer): said, exit 3, nothing installed, no "retired".
old_host; touch "$STUB_UNITS/nobus"
run_setup
(( rc == 3 )) || fail "a timer not confirmed stopped ends setup.sh with 3, not $rc: $(cat "$tmp/out")"
grep -q "WARNING: omarchy-pool-rollout.timer is not retired: firemanxbr's systemd did not answer: nothing was changed there" "$tmp/out" || fail "and says why: $(cat "$tmp/out")"
grep -q "Not done, and nothing installed" "$tmp/out" && grep -q "systemctl --user stop omarchy-pool-rollout.timer" "$tmp/out" || fail "and what to run: $(cat "$tmp/out")"
grep -q "timer retired" "$tmp/out" && fail "a timer nobody confirmed stopped is not called retired: $(cat "$tmp/out")"
grep -q "^  updater:" "$POOL/compose.yml" && fail "nothing is installed while the timer may still run"
[[ -e "$units/omarchy-pool-rollout.timer" ]] || fail "its units stay, for the next try"
grep -q "up -d" "$STUB_LOG" && fail "no updater is started beside a timer that may still run"
rm -f "$STUB_UNITS/nobus"
# 1b. Its last rollout never ends: waited for four hours at most (a try every 15 s), then the same: exit 3, nothing installed — and the
#     timer, which it disabled first, enabled again: the host goes on rolling out through it.
old_host; echo activating > "$STUB_UNITS/omarchy-pool-rollout.service"
run_setup
(( rc == 3 )) || fail "a rollout still running after 4 h ends setup.sh with 3, not $rc: $(tail -n5 "$tmp/out")"
[[ "$(grep -c '^sleep 15$' "$STUB_LOG")" == 960 ]] || fail "four hours of 15 s waits, no more: $(grep -c '^sleep 15$' "$STUB_LOG")"
grep -q "not retired: its last rollout, omarchy-pool-rollout.service, still runs after 4 h" "$tmp/out" || fail "and says so: $(tail -n5 "$tmp/out")"
grep -q "^  updater:" "$POOL/compose.yml" && fail "nothing is installed while the old rollout runs"
put_back "a rollout still running after 4 h"
grep -q "Run this setup.sh again once its last rollout has ended" "$tmp/out" || fail "and what to do next: $(tail -n5 "$tmp/out")"
# 1c. Interrupted during the wait (a stop: TERM; a dropped session: HUP): the timer enabled again, nothing installed, and the exit
#     the signal's own — never 0.
for sig in TERM:143 HUP:129; do
  old_host; echo activating > "$STUB_UNITS/omarchy-pool-rollout.service"; echo 3 > "$STUB_UNITS/term-at"; echo "${sig%:*}" > "$STUB_UNITS/sig"
  run_setup
  [[ "$rc" == "${sig#*:}" ]] || fail "a $sig during the wait ends setup.sh with ${sig#*:}, not $rc: $(tail -n5 "$tmp/out")"
  [[ "$(grep -c '^sleep 15$' "$STUB_LOG")" == 3 ]] || fail "$sig: it ends at the interrupt: $(grep -c '^sleep 15$' "$STUB_LOG") waits"
  grep -q "^  updater:" "$POOL/compose.yml" && fail "$sig: nothing is installed after an interrupt"
  put_back "a $sig during the wait"
done
rm -f "$STUB_UNITS/term-at" "$STUB_UNITS/sleeps" "$STUB_UNITS/sig"
echo "ok: a timer that is not retired stays the host's rollout"

# 2. Refused before the timer is touched (exit 4, nothing changed): a compose.yml that does not load with the host's .env and etc/;
#    .env's POOL_ROOT another directory; an updater image from before #277; a service compose would run without a worker token.
old_host; touch "$tmp/docker/config.fail"
run_setup
(( rc == 4 )) || fail "a compose.yml that does not load ends setup.sh with 4, not $rc: $(cat "$tmp/out")"
grep -q "Not done, and nothing changed: the new compose.yml does not load with this host's .env and etc/ (services.pool-aarch64 additional properties 'imgae' not allowed" "$tmp/out" || fail "and says why: $(cat "$tmp/out")"
untouched "a compose.yml that does not load"
old_host; sed -i.bak "s#^POOL_ROOT=.*#POOL_ROOT=/elsewhere#" "$POOL/.env"
run_setup
(( rc == 4 )) && grep -q "says POOL_ROOT=/elsewhere, not $POOL" "$tmp/out" || fail "a POOL_ROOT that is another directory is refused: $rc $(cat "$tmp/out")"
untouched "another POOL_ROOT"
old_host; touch "$tmp/docker/nolabel"
run_setup
(( rc == 4 )) && grep -q "is from before #277 (no com.omarchy.updater.follows=1): wait until the release that carries #277 is out" "$tmp/out" || fail "an updater image from before #277 is refused: $rc $(cat "$tmp/out")"
grep -q "Not done, and nothing of the host's files, units or containers changed (the updater image was pulled)" "$tmp/out" || fail "a refusal after the pull says the image was pulled: $(cat "$tmp/out")"
(( $(line 'pull -q updater') < $(line 'image inspect') )) || fail "the updater image is pulled first, then read"
untouched "an updater image from before #277"
old_host; touch "$tmp/docker/pull.fail"
run_setup
(( rc == 4 )) && grep -q "the updater's image did not pull" "$tmp/out" || fail "an updater image that does not pull is refused: $rc $(cat "$tmp/out")"
untouched "an updater image that does not pull"
old_host
echo '{"name":"omarchy-pool","services":{"pool-aarch64":{"image":"x","environment":{"OMARCHY_WORKER_TOKEN":"not-a-token-4711"}},"review2-aarch64":{"image":"x","environment":{"OMARCHY_WORKER_TOKEN":""}},"agent-proxy":{"image":"x","environment":{"GEMINI_API_KEY":"k"}},"updater":{"image":"ghcr.io/firemanxbr/omarchy-worker:latest","environment":{}}}}' > "$tmp/docker/config.json"
run_setup
(( rc == 4 )) && grep -q "no worker token for pool-aarch64 review2-aarch64 — run register.sh" "$tmp/out" || fail "a service without a worker token is refused: $rc $(cat "$tmp/out")"
grep -q "not-a-token-4711" "$tmp/out" && fail "a token's value is never printed"
untouched "a service without a worker token"
echo "ok: refused before the timer is touched"

# 3. The one-time step on a host from before #277, while the timer's last rollout still drains: checked, disabled, waited for, the new
#    files (the old ones kept, the difference shown), the updater started and checked, and only then the timer's units removed.
old_host; printf 'activating\nactivating\ninactive\n' > "$STUB_UNITS/omarchy-pool-rollout.service"
run_setup
(( rc == 0 )) || fail "setup.sh exited $rc: $(cat "$tmp/out")"
[[ "$(grep -c '^sleep 15$' "$STUB_LOG")" == 2 ]] || fail "it waits while the rollout runs, and no longer: $(grep -c '^sleep 15$' "$STUB_LOG")"
grep -q "the timer's last rollout still runs (a drain takes up to 3 h): waiting for it to end before the updater takes over" "$tmp/out" || fail "the wait is said: $(cat "$tmp/out")"
dis="$(line 'systemctl --user stop omarchy-pool-rollout.timer')"; first="$(line '^systemctl --user show -p ActiveState --value omarchy-pool-rollout.service$')"
[[ -n "$dis" && -n "$first" ]] && (( dis < first )) || fail "the timer is stopped before the wait, so it starts no other rollout: disable at ${dis:-never}, wait from ${first:-never}"
grep -q "compose has the updater" "$STUB_LOG" && fail "the new compose.yml is installed only once the old rollout has ended: $(grep compose "$STUB_LOG")"
# Checked first, against the staged copy (the host's .env: emulated), then with every profile — while the host's etc/ had no review2 files.
cfg="$(line 'config -q ok: COMPOSE_PROFILES=emulated, flags: none, in omarchy-pool-setup')"; all="$(line 'config -q ok: COMPOSE_PROFILES=emulated, flags: --profile emulated --profile review2 , in omarchy-pool-setup')"
[[ -n "$cfg" && -n "$all" ]] && (( cfg < dis && all < dis )) || fail "the new compose.yml is checked with the host's profiles and with every profile before the timer is touched: $(grep -n 'config -q' "$STUB_LOG")"
(( $(line 'pull -q updater') < dis && $(line 'image inspect') < dis && $(line 'config --format json') < dis )) || fail "the updater image and the tokens are checked before the timer is touched"
# The updater: started once the files are in, stays up, passes its self-test; then the units go.
up="$(line 'up -d --no-deps --no-recreate updater')"; st="$(line 'exec -T updater /usr/local/lib/omarchy-factory/bin/omarchy-rollout --self-test')"
[[ -n "$up" && -n "$st" ]] && (( dis < up && up < st )) || fail "the updater is started and self-tested after the timer is stopped: up at ${up:-never}, self-test at ${st:-never}"
[[ "$(grep -c "^docker inspect -f {{.State.Status}} {{.RestartCount}} 5d0e1f2a3b4c$" "$STUB_LOG")" == 7 ]] || fail "it stays up, at every look for 30 s: $(grep -c 'State.Status' "$STUB_LOG") looks"
[[ "$(grep -c '^sleep 5$' "$STUB_LOG")" == 6 ]] || fail "a look every 5 s: $(grep -c '^sleep 5$' "$STUB_LOG")"
reload="$(line 'systemctl --user daemon-reload')"
[[ -n "$reload" ]] && (( st < reload )) || fail "the timer's units go only once the updater is confirmed: self-test at $st, daemon-reload at ${reload:-never}"
# Disabled only then too: until the updater is confirmed a reboot must bring the timer back, so nothing disables it before that.
off="$(line 'systemctl --user disable')"
[[ -n "$off" ]] && (( st < off && off < reload )) || fail "the timer is disabled only after the self-test, before the reload: self-test at $st, disable at ${off:-never}, reload at $reload"
[[ "$(grep -c '^systemctl --user disable' "$STUB_LOG")" == 1 ]] || fail "and only once: $(grep -n 'systemctl --user disable' "$STUB_LOG")"
grep -qE "stop updater|rm -f updater|--user enable" "$STUB_LOG" && fail "nothing is put back after a step that worked: $(grep -E 'stop|rm -f|enable' "$STUB_LOG")"
grep -q "the updater runs, stays up and passes its self-test" "$tmp/out" || fail "and says so: $(cat "$tmp/out")"
# The compose file has the updater: the socket, the directory at the same path read-only, the role, no token.
updater="$(awk '/^  updater:$/ { on = 1; print; next } on && /^  [a-z#]/ { exit } on && /^[^ ]/ { exit } on { print }' "$POOL/compose.yml")"
[[ -n "$updater" ]] || fail "the installed compose.yml has an updater service"
for want in "image: ghcr.io/firemanxbr/omarchy-worker:latest" "restart: unless-stopped" "OMARCHY_WORKER_ROLE: updater" 'COMPOSE_DIR: ${POOL_ROOT:-/srv/omarchy-pool}' \
  "- /var/run/docker.sock:/var/run/docker.sock" '- ${POOL_ROOT:-/srv/omarchy-pool}:${POOL_ROOT:-/srv/omarchy-pool}:ro' "security_opt: [label=disable]"; do
  grep -qF -- "$want" <<<"$updater" || fail "the updater service has: $want — it has: $updater"
done
grep -qiE "token|env_file|api_key" <<<"$updater" && fail "the updater holds no token and no key: $updater"
grep -q "stop_grace_period" <<<"$updater" && fail "the updater drains nothing: $updater"
# rollout.sh: the marker on its second line (what a project worker reports), and no rollout of its own.
[[ -x "$POOL/rollout.sh" ]] || fail "rollout.sh is installed, executable"
[[ "$(sed -n 2p "$POOL/rollout.sh")" == "# omarchy-rollout: kick-v1" ]] || fail "rollout.sh's second line is the marker: $(sed -n 2p "$POOL/rollout.sh")"
(( $(wc -l < "$POOL/rollout.sh") <= 15 )) || fail "rollout.sh is a wake-up, not a rollout: $(wc -l < "$POOL/rollout.sh") lines"
grep -qE "pull|image rm|config --hash" "$POOL/rollout.sh" && fail "rollout.sh pulls and replaces nothing itself"
# The timer is retired, as its user, and its units are gone — said once its user's systemd says it is stopped; nothing writes a new one.
grep -q "runuser -u firemanxbr -- env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user stop omarchy-pool-rollout.timer" "$STUB_LOG" || fail "the timer is stopped as its user"
grep -q "runuser -u firemanxbr -- env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user disable --now omarchy-pool-rollout.timer" "$STUB_LOG" || fail "and disabled as its user, once the updater runs"
grep -q "^systemctl --user show -p ActiveState --value omarchy-pool-rollout.timer$" "$STUB_LOG" || fail "and asked whether it is stopped"
[[ ! -e "$units/omarchy-pool-rollout.timer" && ! -e "$units/omarchy-pool-rollout.service" ]] || fail "the timer's units are removed"
grep -q "omarchy-pool-rollout.timer retired (stopped, disabled, removed)" "$tmp/out" || fail "setup.sh says so: $(cat "$tmp/out")"
grep -q "systemctl --user enable" "$STUB_LOG" "$tmp/out" && fail "nothing enables a timer"
grep -q "cd $POOL && ./rollout.sh" "$tmp/out" || fail "setup.sh names what wakes the updater from now on: $(cat "$tmp/out")"
# What it replaced is kept, with the timer's units (the way back), and the difference in compose.yml is shown with where local edits go.
backup="$(ls -d "$POOL"/setup-backup-* | head -n1)"
[[ -d "$backup" ]] || fail "the files it replaces are kept in setup-backup-<time>/"
cmp -s "$backup/compose.yml" "$tmp/compose.before" && cmp -s "$backup/rollout.sh" "$tmp/rollout.before" || fail "the kept compose.yml and rollout.sh are the host's own"
[[ -f "$backup/systemd-user/omarchy-pool-rollout.timer" && -f "$backup/systemd-user/omarchy-pool-rollout.service" ]] || fail "and the timer's units, the way back"
grep -q "the copies it replaces: $backup/" "$tmp/out" && grep -q "^      -# local edit$" "$tmp/out" && grep -q "Local changes belong in $POOL/compose.override.yml" "$tmp/out" || fail "the difference in compose.yml is shown, and where local edits go: $(cat "$tmp/out")"
# Every env file compose.yml names, mode 600, the missing ones written and the ones there left alone; .env kept.
for rel in $(sed -nE 's/^[[:space:]]*env_file:[[:space:]]*\[(.*)\].*/\1/p' "$POOL/compose.yml" | tr ',' ' '); do
  [[ -f "$POOL/$rel" ]] || fail "an env file for every env_file compose.yml names: $rel"
  [[ "$(mode "$POOL/$rel")" == 600 ]] || fail "$rel is mode 600: $(mode "$POOL/$rel")"
done
grep -qx "OMARCHY_WORKER_TOKEN=" "$POOL/etc/review2-aarch64.env" && grep -qx "OMARCHY_WORKER_TOKEN=" "$POOL/etc/review2-x86_64.env" || fail "review2's env files are written, for register.sh to fill in"
grep -qx "OMARCHY_WORKER_TOKEN=omw_pool-aarch640123456789" "$POOL/etc/pool-aarch64.env" || fail "an env file there already is left alone"
grep -q "COMPOSE_PROFILES=emulated" "$POOL/.env" || fail "the host's .env is kept"
echo "ok: a host from before #277 — the updater in, the timer out"

# 4. The updater does not start, does not stay up, or fails its self-test: stopped and removed, the old files back, the timer enabled
#    again (exit 5) — the host goes on rolling out through it.
for why in up.fail restarting selftest.fail; do
  old_host; touch "$tmp/docker/$why"
  run_setup
  (( rc == 5 )) || fail "$why: setup.sh ends with 5, not $rc: $(cat "$tmp/out")"
  grep -q "Not done: the updater" "$tmp/out" || fail "$why: and says why: $(cat "$tmp/out")"
  up="$(line 'up -d --no-deps --no-recreate updater')"; en="$(line 'systemctl --user enable --now omarchy-pool-rollout.timer')"
  (( $(line 'systemctl --user stop omarchy-pool-rollout.timer') < up && up < en )) || fail "$why: stopped, the updater tried, then the timer back"
  if [[ "$why" != up.fail ]]; then
    stop="$(line 'compose --project-directory .* stop updater$')"; rmu="$(line 'compose --project-directory .* rm -f updater$')"
    [[ -n "$stop" && -n "$rmu" ]] && (( up < stop && stop < rmu && rmu < en )) || fail "$why: the updater it started is stopped and removed before the timer comes back: $(grep -nE 'updater|enable' "$STUB_LOG")"
    [[ ! -f "$tmp/docker/running" ]] || fail "$why: no updater is left running beside the timer"
  fi
  put_back "$why"
done
# 4b. The same with the output's reader gone by then (a `| tee` stopped by Ctrl-C, a hung-up terminal): a message the put-back can no
#     longer write stops nothing of it — the updater removed, the files back, the timer enabled again, the exit still 5. The reader
#     leaves at the self-test's failure, and the stub's stop of the updater waits until it is gone, so every message after it fails.
old_host; touch "$tmp/docker/selftest.fail" "$tmp/docker/wait-reader"; rm -f "$tmp/docker/reader.done" "$tmp/docker/reader.timeout" "$tmp/fifo"
mkfifo "$tmp/fifo"
( awk '{ print; fflush() } /fails its self-test/ { exit }' < "$tmp/fifo" > "$tmp/out"; touch "$tmp/docker/reader.done" ) &
reader=$!
set +e; SUDO_USER=firemanxbr bash "$tmp/src/setup.sh" "$POOL" > "$tmp/fifo" 2>&1; rc=$?; set -e
wait "$reader"
[[ ! -f "$tmp/docker/reader.timeout" ]] || fail "the reader of setup.sh's output left at the self-test's failure: $(cat "$tmp/out")"
(( rc == 5 )) || fail "with its reader gone, the put-back still ends setup.sh with 5, not $rc: $(cat "$tmp/out")"
grep -q "Not done: the updater fails its self-test" "$tmp/out" || fail "the reader saw the failure: $(cat "$tmp/out")"
grep -q "enabled again" "$tmp/out" && fail "the put-back's messages came after the reader left (else this case proves nothing): $(cat "$tmp/out")"
rmu="$(line 'compose --project-directory .* rm -f updater$')"; en="$(line 'systemctl --user enable --now omarchy-pool-rollout.timer')"
[[ -n "$rmu" && -n "$en" ]] && (( rmu < en )) || fail "with its reader gone, the updater is removed and the timer enabled again: $(grep -nE 'updater|systemctl' "$STUB_LOG")"
put_back_quiet "the reader gone"
rm -f "$tmp/docker/wait-reader" "$tmp/docker/reader.done" "$tmp/fifo"
echo "ok: an updater that does not work here puts the timer back"

# 5. A fresh host: no timer to retire, and none written; the env files compose.yml names; nothing started.
rm -rf "$units"; : > "$STUB_LOG"
run_setup "$tmp/srv/fresh"
(( rc == 0 )) || fail "setup.sh on a fresh host exited $rc: $(cat "$tmp/out")"
grep -q "runuser" "$STUB_LOG" && fail "a fresh host has no timer to retire: $(grep runuser "$STUB_LOG")"
[[ ! -e "$units/omarchy-pool-rollout.timer" ]] || fail "no timer is written"
grep -qE "up -d|pull -q|--self-test" "$STUB_LOG" && fail "a fresh host starts nothing from setup.sh (register first): $(grep -E 'up -d|pull|self-test' "$STUB_LOG")"
grep -q "config -q ok: no COMPOSE_PROFILES, flags: none, in omarchy-pool-setup" "$STUB_LOG" || fail "a fresh host's compose.yml is checked too: $(grep config "$STUB_LOG")"
ls -d "$tmp/srv/fresh"/setup-backup-* >/dev/null 2>&1 && fail "a fresh host has nothing to back up"
want="$(sed -nE 's/^[[:space:]]*env_file:[[:space:]]*\[(.*)\].*/\1/p' "$root/factory/host/compose.yml" | tr ',' '\n' | tr -d ' ' | sort -u)"
got="$(cd "$tmp/srv/fresh" && ls etc/*.env | sort)"
[[ "$want" == "$got" ]] || fail "an env file for every env_file compose.yml names, no more: want $(tr '\n' ' ' <<<"$want"), got $(tr '\n' ' ' <<<"$got")"
for rel in $got; do [[ "$(mode "$tmp/srv/fresh/$rel")" == 600 ]] || fail "$rel is mode 600"; done
grep -q "^GEMINI_API_KEY=$" "$tmp/srv/fresh/etc/agent.env" || fail "agent.env is the agent's template"
grep -q "^POOL_ROOT=$tmp/srv/fresh$" "$tmp/srv/fresh/.env" || fail ".env names its POOL_ROOT"
# The review2 pair is off unless its own profile is on: no default or emulated profile starts a pair register.sh never registered.
for svc in review2-x86_64 review2-aarch64; do
  block="$(awk -v s="  $svc:" '$0 == s { on = 1; next } on && /^  [a-z]/ { exit } on { print }' "$root/factory/host/compose.yml")"
  grep -qx "    profiles: \[review2\]" <<<"$block" || fail "$svc is behind the review2 profile: $block"
done
echo "ok: a fresh host — no timer, every env file"

# 6. rollout.sh wakes the updater: SIGUSR1 to a running one, never recreated; one that is not running started as it is, never
#    recreated either (it rounds at start); --check asks the updater's own omarchy-rollout.
: > "$STUB_LOG"
STUB_UPDATER=running bash "$tmp/srv/fresh/rollout.sh" || fail "rollout.sh exited $?"
[[ "$(cat "$STUB_LOG")" == "docker compose ps -q --status running updater
docker compose kill -s USR1 updater" ]] || fail "a running updater is woken, and nothing else: $(cat "$STUB_LOG")"
: > "$STUB_LOG"
bash "$tmp/srv/fresh/rollout.sh" || fail "rollout.sh exited $?"
[[ "$(cat "$STUB_LOG")" == "docker compose ps -q --status running updater
docker compose up -d --no-deps --no-recreate updater" ]] || fail "an updater that is not running is started as it is, never recreated: $(cat "$STUB_LOG")"
grep -qE "up -d( --no-deps)? updater$" "$tmp/srv/fresh/rollout.sh" && fail "rollout.sh never runs an up that could recreate the updater"
: > "$STUB_LOG"
bash "$tmp/srv/fresh/rollout.sh" --check || fail "rollout.sh --check exited $?"
[[ "$(cat "$STUB_LOG")" == "docker compose exec -T updater /usr/local/lib/omarchy-factory/bin/omarchy-rollout --check" ]] || fail "--check asks the updater what it would do: $(cat "$STUB_LOG")"
echo "ok: rollout.sh only wakes the updater"

# 7. The runbook's one-time step says what setup.sh does: a drain takes up to 3 h, setup.sh waits up to 4 h (not "up to 3 h").
step="$(awk '/^### Once: the updater/ { on = 1 } on && /^### / && !/Once: the updater/ { exit } on { print }' "$root/worker/src/docs/runbook.md" | tr '\n' ' ' | tr -s ' ')"
grep -q "waits up to 4 h" <<<"$step" || fail "the runbook's one-time step says setup.sh waits up to 4 h"
grep -q "draining (up to 3 h)" <<<"$step" && fail "the runbook's one-time step no longer says setup.sh waits up to 3 h"
# An interrupt exits with its signal's code, not 3; and the way back takes the newest backup that has the timer's units — a later
# setup.sh run whose files differ writes a newer one without them.
grep -q "exits 130, 143, 129 or 141" <<<"$step" || fail "the runbook's one-time step gives an interrupt's exit codes"
grep -qF 'b="$(ls -d setup-backup-*/systemd-user | tail -n1)"; b="${b%/systemd-user}"' <<<"$step" || fail "the way back takes the newest backup with the timer's units"
echo "HOST SETUP OK"
