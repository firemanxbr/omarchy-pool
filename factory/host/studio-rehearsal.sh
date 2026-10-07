#!/usr/bin/env bash
# studio-rehearsal.sh — the Studio's canary visit, rehearsed and checked
# beforehand (#319, #345; design v2 §21.1 steps 1-6; the runbook's *The
# Studio canary* and *The Studio switch*). As the login the agent will run
# as, from a checkout of the release the pool runs:
#
#   factory/host/studio-rehearsal.sh stand-in [--dir /srv/omarchy-pool] [--project omarchy-pool] [--profiles emulated]
#   factory/host/studio-rehearsal.sh ids [--project omarchy-pool] > ~/legacy-ids-before
#   factory/host/studio-rehearsal.sh compare ~/legacy-ids-before [--project omarchy-pool]
#   factory/host/studio-rehearsal.sh check --work-root /srv/omarchy-host --task-subnets 10.232.0.0/16 \
#     [--secrets-dir <dir>] [--agent-env-from /srv/omarchy-pool/etc/agent.env] [--project omarchy-pool]
#   factory/host/studio-rehearsal.sh remove [--dir /srv/omarchy-pool]
#
#   stand-in  on a VM only (an aarch64 Linux VM built like the Studio: docker,
#             the docker group, qemu's binfmt handlers): lays out a copy of the
#             Studio's legacy compose project in --dir from this checkout's
#             factory/host/compose.yml — the same services, profiles,
#             networks, bind mounts (the directory itself and the engine's
#             socket) and env files — with a placeholder worker token in every
#             etc/<service>.env and placeholder agent keys in etc/agent.env
#             (no GITHUB_TOKEN: install would ask GitHub its scopes), and a
#             compose.override.yml that runs every service as a sleeper from
#             the pinned busybox (tests/images.env), so nothing there calls the
#             pool. Then starts it, as the Studio runs it (COMPOSE_PROFILES).
#             It refuses a directory holding a compose file it did not lay
#             out: never the Studio's own set.
#   ids       the project's containers and networks by full id, sorted: before
#             and after the install, a reboot, a release.
#   compare   the project's ids now against a list `ids` saved: exit 1 naming
#             each one gone or new.
#   check     read-only, on the VM and on the Studio itself: what the visit
#             needs before install.sh runs — the agent's preflight says the
#             rest — each line `ok`, `person` (a command fixes it, said) or
#             `refused` (install's preflight would refuse these options):
#             - the work root and the secrets directory outside every path a
#               container of the legacy project bind-mounts, and apart: the
#               Studio's compose mounts /srv/omarchy-pool whole into its
#               project workers and its updater, so a work root under it is
#               refused by preflight (and a secrets directory under it would
#               go with the legacy set's files);
#             - the task subnets outside the legacy project's networks;
#             - the legacy directory (its compose working directory) owned by
#               this login and writable by it alone: retire-legacy writes its
#               .omarchy-agent marker there (#344, #374);
#             - this login reaches the engine (the docker group);
#             - qemu's binfmt handler for the other architecture, with the F
#               flag (the emulated lane), and linger for this login;
#             - prep-root.sh's task firewall: its script drops each task
#               subnet to the host, its unit enabled for the next boot;
#             - --agent-env-from's GITHUB_TOKEN, when it holds one: a classic
#               token with no scope, as install takes it (asked of GitHub with
#               the header from a file, never in a process's arguments).
#   remove    stops and removes a stand-in this script laid out — its
#             containers, networks and files —, never another project.
#
# Exit status: 0 done (check: all ok); 1 check: something needs a person,
# compare: an id changed; 2 refused, or usage.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MARK=".studio-rehearsal"
# The filesystem's root for check's host files (/proc, /var/lib/systemd, the firewall's), for tests/studio-rehearsal.sh only.
fs="${OMARCHY_REHEARSAL_FS:-}"
GITHUB_API="${OMARCHY_REHEARSAL_GITHUB:-https://api.github.com}"

die() { local code="$1"; shift; printf 'studio-rehearsal.sh: %s\n' "$*" >&2; exit "$code"; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2; exit 2; }

cmd="${1:-}"
[[ -n "$cmd" ]] || usage
shift
dir=/srv/omarchy-pool
project=""
profiles=emulated
work_root=""
secrets_dir=""
task_subnets=""
agent_env=""
saved=""
while (($#)); do
  case "$1" in
    --dir) dir="${2:?}"; shift 2 ;;
    --project) project="${2:?}"; shift 2 ;;
    --profiles) profiles="${2?}"; shift 2 ;;
    --work-root) work_root="${2:?}"; shift 2 ;;
    --secrets-dir) secrets_dir="${2:?}"; shift 2 ;;
    --task-subnets) task_subnets="${2:?}"; shift 2 ;;
    --agent-env-from) agent_env="${2:?}"; shift 2 ;;
    -h | --help) usage ;;
    -*) printf 'unknown option: %s\n' "$1" >&2; usage ;;
    *) [[ "$cmd" == compare && -z "$saved" ]] || { printf 'unexpected argument: %s\n' "$1" >&2; usage; }; saved="$1"; shift ;;
  esac
done
dir="${dir%/}"
[[ -n "$project" ]] || project="$(basename "$dir")"
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || die 2 "--project: a compose project name (lowercase letters, digits, - and _)"

label="label=com.docker.compose.project=$project"
containers() { docker ps -aq --no-trunc --filter "$label"; }
networks() { docker network ls -q --no-trunc --filter "$label"; }
ids() {
  {
    containers | sed 's/^/container /'
    networks | sed 's/^/network /'
  } | LC_ALL=C sort
}

# --------------------------------------------------------------- stand-in --
stand_in() {
  local src="$ROOT/factory/host/compose.yml" images="$ROOT/tests/images.env" busybox="" f svc p
  [[ -f "$src" && -f "$images" ]] || die 2 "run it from a checkout: $src and $images"
  busybox="$(sed -n 's/^BUSYBOX="\(.*\)"$/\1/p' "$images")"
  [[ -n "$busybox" ]] || die 2 "$images names no BUSYBOX"
  command -v jq >/dev/null || die 2 "jq is needed (prep-root.sh installs it)"
  [[ -d "$dir" && -w "$dir" ]] || die 2 "$dir: make it first, yours (sudo install -d -o \"\$USER\" -m 0755 $dir)"
  if [[ -e "$dir/compose.yml" && ! -e "$dir/$MARK" ]]; then die 2 "$dir holds a compose.yml this script did not lay out: never over a real set"; fi
  if [[ -n "$(containers)" && ! -e "$dir/$MARK" ]]; then die 2 "the compose project $project runs already, from elsewhere: give another --project"; fi
  printf 'a stand-in of the Studio legacy set, laid out by factory/host/studio-rehearsal.sh (project %s)\n' "$project" >"$dir/$MARK"
  install -m 0644 "$src" "$dir/compose.yml"
  install -d -m 0700 "$dir/etc"
  # Every env file the compose file names, the review2 pair's too (compose loads them all): placeholders only.
  while read -r f; do
    if [[ "$f" == etc/agent.env ]]; then
      printf 'ANTHROPIC_API_KEY=placeholder-not-a-key\n' >"$dir/$f"
    else
      printf 'OMARCHY_WORKER_TOKEN=omw_placeholder_%s\n' "$(basename "$f" .env | tr -c 'a-z0-9_\n' _)" >"$dir/$f"
    fi
    chmod 0600 "$dir/$f"
  done < <(grep -o 'etc/[A-Za-z0-9_.-]*\.env' "$src" | LC_ALL=C sort -u)
  printf 'POOL_ROOT=%s\nCOMPOSE_PROJECT_NAME=%s\nCOMPOSE_PROFILES=%s\nWHERE=studio-rehearsal\n' "$dir" "$project" "$profiles" >"$dir/.env"
  rm -f "$dir/compose.override.yml"
  # Every service of every profile, a sleeper: the same names, networks, mounts and env files, no worker and no token sent anywhere.
  local all=() services
  while read -r p; do [[ -n "$p" ]] && all+=(--profile "$p"); done < <(cd "$dir" && docker compose config --profiles)
  # Read before the override is written: compose reads it as soon as it is there.
  services="$(cd "$dir" && docker compose "${all[@]}" config --services)"
  [[ -n "$services" ]] || die 2 "compose names no service in $dir/compose.yml"
  {
    printf '# studio-rehearsal.sh: every service a sleeper from busybox, so nothing here calls the pool with a placeholder token.\n'
    printf 'services:\n'
    while read -r svc; do
      [[ -n "$svc" ]] || continue
      printf '  %s:\n    image: %s\n' "$svc" "$busybox"
      # shellcheck disable=SC2016 # compose's own escape: $$ is a literal $ for the container's shell
      printf '    command: ["sh", "-c", "trap '"'"'exit 0'"'"' TERM; while :; do sleep 1 & wait $$!; done"]\n'
    done <<<"$services"
  } >"$dir/compose.override.yml.tmp"
  mv "$dir/compose.override.yml.tmp" "$dir/compose.override.yml"
  # The bind mounts' sources under the directory, made as this login first: the engine would make them root's.
  (cd "$dir" && docker compose "${all[@]}" config --format json) \
    | jq -r '.services[].volumes[]? | select(.type == "bind") | .source' | LC_ALL=C sort -u | while read -r p; do
      if [[ "$p" == "$dir"/* && ! -e "$p" ]]; then mkdir -p "$p"; fi
    done
  (cd "$dir" && docker compose up -d --quiet-pull)
  printf 'the stand-in runs in %s as the compose project %s (COMPOSE_PROFILES=%s): %s container(s)\n' "$dir" "$project" "$profiles" "$(containers | wc -l | tr -d ' ')"
}

# ---------------------------------------------------------------- compare --
compare() {
  [[ -n "$saved" && -f "$saved" ]] || die 2 "compare: the list ids saved, as a file"
  local now gone new
  now="$(ids)"
  gone="$(LC_ALL=C comm -23 <(LC_ALL=C sort "$saved") <(printf '%s\n' "$now" | sed '/^$/d'))"
  new="$(LC_ALL=C comm -13 <(LC_ALL=C sort "$saved") <(printf '%s\n' "$now" | sed '/^$/d'))"
  if [[ -z "$gone" && -z "$new" ]]; then
    printf 'the same: %s id(s) of %s\n' "$(printf '%s\n' "$now" | sed '/^$/d' | wc -l | tr -d ' ')" "$project"
    return 0
  fi
  # shellcheck disable=SC2086 # one id a line: "container <id>", "network <id>"
  [[ -z "$gone" ]] || printf 'gone: %s %s\n' $gone
  # shellcheck disable=SC2086
  [[ -z "$new" ]] || printf 'new:  %s %s\n' $new
  return 1
}

# ------------------------------------------------------------------ check --
worst=0
say() { # say ok|person|refused <line>
  local level="$1"; shift
  printf '  %-8s %s\n' "$level" "$*"
  case "$level" in person) ((worst < 1)) && worst=1 ;; refused) worst=2 ;; esac
  return 0
}
# A path inside another, or the same: what install's preflight refuses for a work root (crates/omarchy-agent install/legacy.rs).
overlaps_path() { [[ "$1" == "$2" || "$1" == "$2"/* || "$2" == "$1"/* ]]; }
ip2int() { local IFS=.; local -a o; read -r -a o <<<"$1"; echo $(((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3])); }
overlaps_net() { # two IPv4 CIDRs share an address
  local a="${1%/*}" b="${2%/*}" m="${1#*/}"
  ((${2#*/} < m)) && m="${2#*/}"
  (($(ip2int "$a") >> (32 - m) == $(ip2int "$b") >> (32 - m)))
}

check() {
  local cidr='^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' s ids_ p d n
  [[ "$work_root" == /* ]] || die 2 "check: --work-root, the absolute path install.sh will be given"
  [[ -n "$task_subnets" ]] || die 2 "check: --task-subnets, as install.sh will be given them"
  [[ -n "$secrets_dir" ]] || secrets_dir="${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-agent/secrets"
  [[ "$secrets_dir" == /* ]] || die 2 "check: --secrets-dir, an absolute path"
  work_root="${work_root%/}" secrets_dir="${secrets_dir%/}"
  local -a subnets
  IFS=, read -r -a subnets <<<"$task_subnets"
  for s in "${subnets[@]}"; do [[ "$s" =~ $cidr ]] || die 2 "--task-subnets: $s is not an IPv4 CIDR"; done
  printf '%s, for install with --legacy %s --work-root %s --secrets-dir %s --task-subnets %s:\n' "$(id -un)" "$project" "$work_root" "$secrets_dir" "$task_subnets"

  if ! docker info >/dev/null 2>&1; then
    say person "the engine: $(id -un) does not reach it — log out and back in once it is in the docker group (prep-root.sh puts it there), or start docker"
    return 0
  fi
  say ok "the engine answers $(id -un)"
  ids_="$(containers)"
  if [[ -z "$ids_" ]]; then
    say refused "legacy: no container of the compose project $project on this engine (docker ps -a --filter $label)"
    return 0
  fi
  say ok "legacy: $project, $(printf '%s\n' "$ids_" | wc -l | tr -d ' ') container(s)"
  local mounts
  # shellcheck disable=SC2086 # one id an argument
  mounts="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' $ids_ | sed '/^$/d' | LC_ALL=C sort -u)"
  for d in "work root:$work_root" "secrets directory:$secrets_dir"; do
    local what="${d%%:*}" path="${d#*:}" hit=""
    while read -r p; do [[ -n "$p" ]] && overlaps_path "$path" "${p%/}" && hit="$p" && break; done <<<"$mounts"
    if [[ -n "$hit" ]]; then
      say refused "the $what $path overlaps $hit, which the legacy project bind-mounts: give one beside it (install's preflight refuses a work root there, and a secrets directory there goes with the legacy set's files)"
    else
      say ok "the $what $path is outside every path the legacy project mounts"
    fi
  done
  if overlaps_path "$secrets_dir" "$work_root"; then say refused "the secrets directory $secrets_dir and the work root $work_root overlap: install keeps them apart"; fi
  local nets; nets="$(networks)"
  local subs=""
  # shellcheck disable=SC2086 # one id an argument
  [[ -z "$nets" ]] || subs="$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}' $nets | grep -E "$cidr" || true)"
  local clash=0
  for s in "${subnets[@]}"; do
    while read -r n; do
      [[ -n "$n" ]] || continue
      if overlaps_net "$s" "$n"; then say refused "the task subnets $s overlap the legacy project's network $n: give other --task-subnets"; clash=1; fi
    done <<<"$subs"
  done
  ((clash)) || say ok "the task subnets $task_subnets are outside the legacy project's networks${subs:+ ($(printf '%s' "$subs" | tr '\n' ' ' | sed 's/ $//'))}"
  # The legacy directory: compose's working directory, one for all its containers; retire-legacy's marker goes there.
  local dirs
  # shellcheck disable=SC2086 # one id an argument
  dirs="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' $ids_ | sed '/^$/d' | LC_ALL=C sort -u)"
  if [[ "$(printf '%s\n' "$dirs" | sed '/^$/d' | wc -l)" -ne 1 ]]; then
    say person "legacy directory: its containers name $(printf '%s' "$dirs" | tr '\n' ' ')— retire-legacy needs one (install --legacy records it)"
  else
    local owner mode
    owner="$(stat -c '%u' "$dirs")" mode="$(stat -c '%a' "$dirs")"
    if [[ "$owner" != "$(id -u)" || $((8#$mode & 8#022)) -ne 0 ]]; then
      say person "legacy directory $dirs: owned by uid $owner, mode $mode — retire-legacy writes its .omarchy-agent marker there only when $(id -un) owns it and nobody else may write it: sudo chown $(id -un) $dirs && sudo chmod go-w $dirs (the directory alone, not its contents)"
    else
      say ok "legacy directory $dirs: $(id -un)'s, mode $mode (retire-legacy can leave its marker)"
    fi
  fi
  # The emulated lane: qemu's binfmt handler for the other architecture, with the F flag containers need.
  local foreign=x86_64
  [[ "$(uname -m)" == x86_64 ]] && foreign=aarch64
  local h="$fs/proc/sys/fs/binfmt_misc/qemu-$foreign"
  if [[ -f "$h" ]] && grep -q '^enabled' "$h" && grep -q '^flags:.*F' "$h"; then
    say ok "binfmt: qemu-$foreign enabled, with the F flag (the emulated lane)"
  else
    say person "binfmt: qemu-$foreign is not enabled with the F flag — prep-root.sh installs qemu-user-static-binfmt (the $foreign lane stays held otherwise)"
  fi
  if [[ -e "$fs/var/lib/systemd/linger/$(id -un)" ]]; then say ok "linger: on for $(id -un)"; else say person "linger: off for $(id -un) — prep-root.sh turns it on (sudo loginctl enable-linger $(id -un))"; fi
  # prep-root.sh's firewall: the INPUT drop of each task subnet, and its unit enabled for the next boot (install's preflight refuses either missing on a rootful engine).
  local script="$fs/usr/local/libexec/omarchy-task-firewall" missing=()
  for s in "${subnets[@]}"; do grep -qx "iptables -A OMARCHY-TASKS-HOST -s $s -j DROP" "$script" 2>/dev/null || missing+=("$s"); done
  if ((${#missing[@]})) || [[ ! -e "$fs/etc/systemd/system/multi-user.target.wants/omarchy-task-firewall.service" ]]; then
    say person "task firewall: $( ((${#missing[@]})) && printf 'no drop for %s' "${missing[*]}" || printf 'its unit is not enabled') — sudo factory/host/prep-root.sh --user $(id -un) --work-root $work_root --task-subnets $task_subnets"
  else
    say ok "task firewall: each task subnet dropped to the host, its unit enabled"
  fi
  if [[ -n "$agent_env" ]]; then github_token; fi
}

# --agent-env-from's GITHUB_TOKEN, as install's preflight takes it: GitHub names a classic token's scopes, and none may be named.
github_token() {
  [[ -r "$agent_env" ]] || { say person "$agent_env: $(id -un) cannot read it (install copies the agent keys from it)"; return 0; }
  local t
  t="$(sed -n 's/^GITHUB_TOKEN=//p' "$agent_env" | tail -n 1)"
  t="${t%\"}" t="${t#\"}"
  if [[ -z "$t" ]]; then say ok "$agent_env: no GITHUB_TOKEN (the agent sidecars read GitHub anonymously, at its lower rate)"; return 0; fi
  local tmp; tmp="$(mktemp -d)"
  # The header from a file, never on curl's command line: a process's arguments are anyone's to read (ps).
  (umask 077 && printf 'authorization: token %s\n' "$t" >"$tmp/h")
  unset t
  local head
  if ! head="$(curl -sS -m 20 -o /dev/null -D - -H @"$tmp/h" "$GITHUB_API/" 2>&1)"; then
    rm -rf "$tmp"
    say person "$agent_env: GitHub did not answer about its GITHUB_TOKEN ($(printf '%s' "$head" | head -n 1)) — check again"
    return 0
  fi
  rm -rf "$tmp"
  local status scopes
  status="$(printf '%s\n' "$head" | sed -n '1s/^HTTP\/[0-9.]* \([0-9]*\).*/\1/p')"
  scopes="$(printf '%s\n' "$head" | tr -d '\r' | sed -n 's/^[Xx]-[Oo][Aa]uth-[Ss]copes:[[:space:]]*//p')"
  if [[ "$status" != 200 ]]; then
    say refused "$agent_env: GitHub answers $status for its GITHUB_TOKEN — a revoked or mistyped token; install refuses it"
  elif ! printf '%s\n' "$head" | grep -qi '^x-oauth-scopes:'; then
    say refused "$agent_env: GitHub names no scopes for its GITHUB_TOKEN (a fine-grained or app token), which install refuses — make a classic token with no scope (public read only) and give install a copy of the file with it"
  elif [[ -n "$(printf '%s' "$scopes" | tr -d ' ,')" ]]; then
    say refused "$agent_env: its GITHUB_TOKEN carries the scopes $scopes, which install refuses — a classic token with no scope (public read only)"
  else
    say ok "$agent_env: its GITHUB_TOKEN is a classic token with no scope"
  fi
}

# ----------------------------------------------------------------- remove --
remove() {
  [[ -e "$dir/$MARK" ]] || die 2 "$dir is no stand-in this script laid out (no $MARK): nothing removed"
  (cd "$dir" && docker compose down --remove-orphans --timeout 5)
  local p
  # The bind mounts' sources stand-in made, then its files.
  for p in work cache; do
    if [[ -d "$dir/$p" ]] && ! rm -rf "${dir:?}/$p" 2>/dev/null; then printf 'left %s: something in it is not %s'"'"'s to remove (sudo rm -r it)\n' "$dir/$p" "$(id -un)"; fi
  done
  rm -f "$dir/compose.yml" "$dir/compose.override.yml" "$dir/.env" "$dir"/etc/*.env "$dir/$MARK"
  rmdir "$dir/etc" 2>/dev/null || true
  printf 'the stand-in of %s is gone from %s\n' "$project" "$dir"
}

case "$cmd" in
  stand-in) stand_in ;;
  ids) ids ;;
  compare) compare ;;
  check)
    check
    case "$worst" in 0) printf 'all ok\n' ;; 1) printf 'something needs a person: the command is on its line\n' ;; *) printf 'refused: install'"'"'s preflight would refuse these options\n' ;; esac
    exit "$worst"
    ;;
  remove) remove ;;
  *) printf 'unknown command: %s\n' "$cmd" >&2; usage ;;
esac
