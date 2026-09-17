#!/usr/bin/env bash
# omarchy-worker — run a worker for the omarchy pool with one command.
#
#   curl -fsSLo omarchy-worker __API__/omarchy-worker && chmod +x omarchy-worker
#   ./omarchy-worker start --token omw_…            # your packages, on this machine
#   ./omarchy-worker start --token omw_… --shared   # and everyone's queue
#
# It finds the container runtime you have (docker or podman, with compose),
# writes the compose file and a .env beside itself (~/.config/omarchy-worker
# by default, --dir elsewhere), pulls the signed image and starts the set:
# the broker that holds your token and keys, the builder born with nothing,
# and the updater that keeps both on the pool's latest image — every worker
# follows it, the pool hands nothing to one that is behind. A maintainer's
# project worker: --project (with --role pool|review), the same way; back
# to a contributor's set with --community. Options are remembered.
#
#   start     write the files, pull, start (or apply changed options)
#   status    what runs here, and what the pool thinks of it
#   logs      follow the builder's log (logs broker|updater|project for another)
#   update    pull now and replace what changed, one service at a time
#   share     on|off — build everyone's queue, or yours only (the pool keeps it; the page has the same switch)
#   stop      drain and stop (a build in hand finishes first, up to three hours)
#   remove    stop and delete the files here (the registration stays; revoke it on your page)
#
# Nothing here needs root; the runtime's socket is the one your user reaches.
set -euo pipefail
API="__API__"
IMAGE="ghcr.io/firemanxbr/omarchy-worker:latest"
DIR="${OMARCHY_WORKER_DIR:-$HOME/.config/omarchy-worker}"
say() { printf '%s\n' "$*"; }
die() { printf 'omarchy-worker: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^[^#]/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0; }

# ---------------------------------------------------------------- runtime --
# docker with the compose plugin, or podman with `podman compose`; the
# socket the updater and a project worker mount is the runtime's.
RUNTIME=""; COMPOSE=(); SOCKET=""
find_runtime() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    RUNTIME=docker; COMPOSE=(docker compose)
    # The socket the updater mounts is read by the daemon, on its side: for
    # Docker Desktop (a VM, on macOS and Windows) that is /var/run/docker.sock
    # whatever the host-side path the context names; a native Linux daemon's
    # socket is the context's (rootless: /run/user/<uid>/docker.sock).
    SOCKET=/var/run/docker.sock
    if [[ "$(uname -s)" == Linux ]] && ! docker info -f '{{.OperatingSystem}}' 2>/dev/null | grep -qi "docker desktop"; then
      local ctx; ctx="$(docker context inspect -f '{{(index .Endpoints "docker").Host}}' 2>/dev/null | sed 's|^unix://||')"
      [[ -n "$ctx" && -S "$ctx" ]] && SOCKET="$ctx"
    fi
  elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    RUNTIME=podman; COMPOSE=(podman compose)
    # podman says where its API socket is — on macOS inside the machine, a path this
    # Mac's filesystem cannot check; on Linux the user's, which must be enabled.
    SOCKET="$(podman info --format '{{.Host.RemoteSocket.Path}}' 2>/dev/null || true)"
    if [[ "$(uname -s)" != Darwin && ( -z "$SOCKET" || ! -S "$SOCKET" ) ]]; then
      die "podman's API socket is not running — enable it once (systemctl --user enable --now podman.socket) and run this again"
    fi
    [[ -n "$SOCKET" ]] || SOCKET=/run/podman/podman.sock
  else
    die "no container runtime found: install Docker (with compose) or podman (with podman compose), start it, and run this again"
  fi
}
compose() { (cd "$DIR" && "${COMPOSE[@]}" "$@"); }

# -------------------------------------------------------------------- .env --
# .env, compose's way: KEY='value', single-quoted so #, ", $ and spaces mean
# nothing — a quote in a value is closed, escaped and reopened; a newline
# has no place in one.
env_get() { [[ -f "$DIR/.env" ]] && sed -n "s/^$1=//p" "$DIR/.env" | head -1 | sed "s/^'//; s/'\$//; s/'\\\\''/'/g" || true; }
env_set() { # key value — replace or append, the file stays 600
  local k="$1" v="$2"
  [[ "$v" != *$'\n'* ]] || die "a value with a line break in it ($k)"
  local q; q="'$(printf %s "$v" | sed "s/'/'\\\\''/g")'"
  touch "$DIR/.env"; chmod 600 "$DIR/.env"
  if grep -q "^$k=" "$DIR/.env"; then
    local tmp; tmp="$(mktemp)"; grep -v "^$k=" "$DIR/.env" > "$tmp" || true; printf '%s=%s\n' "$k" "$q" >> "$tmp"; cat "$tmp" > "$DIR/.env"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$k" "$q" >> "$DIR/.env"
  fi
}

fetch_compose() {
  mkdir -p "$DIR"
  curl -fsSL --max-time 60 "$API/omarchy-worker/compose.yml" -o "$DIR/compose.yml.new" || die "could not fetch the compose file from $API/omarchy-worker/compose.yml"
  mv "$DIR/compose.yml.new" "$DIR/compose.yml"
}

# ------------------------------------------------------------------- start --
cmd_start() {
  local token="" shared="" where="" gh="" anthropic="" openai="" gemini="" xai="" claude="" model="" provider="" project=0 community=0 role="" workdir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --token) token="$2"; shift 2 ;;
      --shared) shared=1; shift ;;
      --own|--not-shared) shared=0; shift ;;
      --where) where="$2"; shift 2 ;;
      --github-token) gh="$2"; shift 2 ;;
      --anthropic-key) anthropic="$2"; shift 2 ;;
      --openai-key) openai="$2"; shift 2 ;;
      --gemini-key) gemini="$2"; shift 2 ;;
      --xai-key) xai="$2"; shift 2 ;;
      --claude-token) claude="$2"; shift 2 ;;
      --model) model="$2"; shift 2 ;;
      --provider) provider="$2"; shift 2 ;;
      --project) project=1; shift ;;
      --community) community=1; shift ;;
      --role) role="$2"; shift 2 ;;
      --work-dir) workdir="$2"; shift 2 ;;
      -h|--help) usage ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
  done
  find_runtime
  fetch_compose
  local had; had="$(env_get OMARCHY_WORKER_TOKEN)"
  [[ -n "$token" || -n "$had" ]] || die "--token omw_… is required the first time: register a worker on your page, the token is shown once"
  [[ -n "$token" ]] && env_set OMARCHY_WORKER_TOKEN "$token"
  env_set OMARCHY_WORKER_DIR "$DIR"
  env_set OMARCHY_SOCKET "$SOCKET"
  # The compose project's name: the default directory's is plain; another
  # directory's carries a mark of its full path, so two sets whose
  # directories share a basename never share (and replace) containers.
  local default_dir; default_dir="$(cd "$HOME/.config/omarchy-worker" 2>/dev/null && pwd -P || echo "$HOME/.config/omarchy-worker")"
  [[ -n "$(env_get COMPOSE_PROJECT_NAME)" ]] || env_set COMPOSE_PROJECT_NAME "$( [[ "$DIR" == "$default_dir" ]] && echo omarchy-worker || echo "omarchy-worker-$(printf %s "$DIR" | (sha256sum 2>/dev/null || shasum -a 256) | cut -c1-8)" )"
  # The profile is remembered: a second `start` without --project keeps a
  # project set a project set. Switching drains the other profile's set first.
  local was_profile want_profile; was_profile="$(env_get COMPOSE_PROFILES)"
  if (( project )); then want_profile=project; elif (( community )) || [[ -z "$was_profile" ]]; then want_profile=community; else want_profile="$was_profile"; fi
  if [[ -n "$was_profile" && "$was_profile" != "$want_profile" ]]; then
    say "switching from $was_profile to $want_profile: the $was_profile set drains and stops first"
    compose --profile "$was_profile" down >/dev/null 2>&1 || true
  fi
  env_set COMPOSE_PROFILES "$want_profile"
  [[ -n "$role" ]] && env_set OMARCHY_WORKER_ROLE "$role"
  [[ -n "$workdir" ]] && { mkdir -p "$workdir"; env_set OMARCHY_WORK_DIR "$(cd "$workdir" && pwd -P)"; }
  if [[ "$want_profile" == project ]]; then
    local wd; wd="$(env_get OMARCHY_WORK_DIR)"; [[ -n "$wd" ]] || wd="$DIR/work"
    mkdir -p "$wd"
  fi
  [[ -n "$shared" ]] && env_set WORKER_SHARED "$shared"
  [[ -n "$where" ]] && env_set WHERE "$where"
  [[ -n "$gh" ]] && env_set GITHUB_TOKEN "$gh"
  [[ -n "$anthropic" ]] && env_set ANTHROPIC_API_KEY "$anthropic"
  [[ -n "$openai" ]] && env_set OPENAI_API_KEY "$openai"
  [[ -n "$gemini" ]] && env_set GEMINI_API_KEY "$gemini"
  [[ -n "$xai" ]] && env_set XAI_API_KEY "$xai"
  [[ -n "$claude" ]] && env_set CLAUDE_CODE_OAUTH_TOKEN "$claude"
  [[ -n "$model" ]] && env_set FACTORY_MODEL "$model"
  [[ -n "$provider" ]] && env_set FACTORY_PROVIDER "$provider"
  # The registration's architecture is the machine's: the pool refuses a claim from the other.
  local arch; arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64
  local self code; self="$(curl -sS --max-time 30 -w '\n%{http_code}' "$API/api/v1/factory/workers/self" -H "authorization: Bearer $(env_get OMARCHY_WORKER_TOKEN)" 2>/dev/null || true)"
  code="${self##*$'\n'}"; self="${self%$'\n'*}"
  if [[ "$code" == 200 ]]; then
    local reg_arch reg_id; reg_arch="$(jq -r .arch <<<"$self" 2>/dev/null || true)"; reg_id="$(jq -r .id <<<"$self" 2>/dev/null || true)"
    [[ -z "$reg_arch" || "$reg_arch" == "$arch" ]] || die "the token is for a $reg_arch worker; this machine is $arch — register one for $arch on your page"
    say "worker ${reg_id:-?} ($arch) — $RUNTIME, $DIR"
  elif [[ "$code" == 401 || "$code" == 403 ]]; then
    die "the pool refuses this token ($code: $(jq -r '.error // empty' <<<"$self" 2>/dev/null || echo "revoked, or mistyped")) — register a worker on your page and start with the new one"
  else
    say "the pool did not answer (${code:-no connection}) — starting anyway; 'omarchy-worker status' says more once it does"
  fi
  say "pulling $IMAGE"
  compose pull --quiet 2>&1 | grep -viE "pulled|pulling|^\s*$" || true
  compose up -d --remove-orphans >/dev/null
  say "running: $(compose ps --format '{{.Service}} {{.Status}}' 2>/dev/null | tr '\n' ';' | sed 's/;$//; s/;/ · /g')"
  say "the updater keeps it on the latest image; 'omarchy-worker status' and 'omarchy-worker logs' follow it"
}

cmd_status() {
  find_runtime
  [[ -f "$DIR/.env" ]] || die "nothing here ($DIR): omarchy-worker start --token omw_… first"
  say "$DIR ($RUNTIME, profile $(env_get COMPOSE_PROFILES))"
  compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Image}}' 2>/dev/null || true
  local self; self="$(curl -fsS --max-time 30 "$API/api/v1/factory/workers/self" -H "authorization: Bearer $(env_get OMARCHY_WORKER_TOKEN)" 2>/dev/null || true)"
  if [[ -n "$self" ]]; then
    jq -r '"the pool: \(.id) · \(.trust) · \(.arch)" + (if .mode then " · " + (if .mode == "shared" then "shared (everyone\u0027s queue)" else "own packages only" end) + (if .mode_by then " — set from the brain" else "" end) else "" end)' <<<"$self" 2>/dev/null || say "the pool: $self"
  else
    say "the pool did not answer for this token"
  fi
  local latest; latest="$(curl -fsS --max-time 30 "$API/api/v1/version" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)"
  local running; running="$(compose ps -q 2>/dev/null | head -1)"
  if [[ -n "$running" ]]; then
    local ver; ver="$("$RUNTIME" inspect -f '{{index .Config.Env}}' "$running" 2>/dev/null | grep -oE 'OMARCHY_IMAGE=v[0-9.]+' | head -1 | cut -d= -f2 || true)"
    say "image: ${ver:-?}${latest:+ · the pool: $latest}$( [[ -n "$ver" && -n "$latest" && "$ver" != "$latest" ]] && echo " — the updater brings it within the hour, or: omarchy-worker update")"
  fi
}

cmd_logs() { find_runtime; local svc="${1:-}"; if [[ -z "$svc" ]]; then svc=worker; [[ "$(env_get COMPOSE_PROFILES)" == project ]] && svc=project; fi; compose logs -f --tail 100 "$svc"; }
cmd_update() { find_runtime; fetch_compose; say "pulling and replacing what changed (a build in hand finishes first)"; compose run --rm --no-deps updater --once; }
# The mode is the brain's: set through the worker's token, it holds from the
# next claim (within the minute), nothing restarts — the page shows the same
# switch. The .env keeps it too, for a set started again from scratch.
cmd_share() {
  local mode
  case "${1:-}" in on) mode=shared ;; off) mode=dedicated ;; *) die "share on|off" ;; esac
  [[ -f "$DIR/.env" ]] || die "nothing here ($DIR): omarchy-worker start --token omw_… first"
  local r; r="$(curl -fsS --max-time 30 -X POST "$API/api/v1/factory/workers/self/mode" -H "authorization: Bearer $(env_get OMARCHY_WORKER_TOKEN)" -H "content-type: application/json" -d "{\"mode\":\"$mode\"}" 2>&1)" \
    || die "the pool did not take it: ${r:0:300}"
  env_set WORKER_SHARED "$( [[ "$mode" == shared ]] && echo 1 || echo 0 )"
  say "$(jq -r '.note // ("mode: " + .mode)' <<<"$r" 2>/dev/null || echo "mode: $mode")"
}
# down with every profile: what a switch may have left behind goes too.
cmd_stop() { find_runtime; say "draining: a build in hand finishes first (up to three hours)"; compose --profile '*' down; }
cmd_remove() { find_runtime; compose --profile '*' down 2>/dev/null || true; rm -f "$DIR/.env" "$DIR/compose.yml"; say "removed $DIR — the registration stays; revoke it on your page if the machine is gone"; }

# --dir anywhere on the line, for every command; the directory is made and its real path kept.
args=(); while [[ $# -gt 0 ]]; do if [[ "$1" == --dir ]]; then [[ -n "${2:-}" ]] || die "--dir needs a path"; DIR="$2"; shift 2; else args+=("$1"); shift; fi; done
set -- "${args[@]+"${args[@]}"}"
cmd="${1:-}"; shift || true
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
mkdir -p "$DIR" 2>/dev/null || true; DIR="$(cd "$DIR" 2>/dev/null && pwd -P || echo "$DIR")"
none() { [[ $# -eq 0 ]] || die "$cmd takes no options (see --help)"; }
case "$cmd" in
  start) cmd_start "$@" ;;
  status) none "$@"; cmd_status ;;
  logs) cmd_logs "$@" ;;
  update) none "$@"; cmd_update ;;
  share) cmd_share "$@" ;;
  stop) none "$@"; cmd_stop ;;
  remove) none "$@"; cmd_remove ;;
  ""|-h|--help|help) usage ;;
  *) die "unknown command $cmd (see --help)" ;;
esac
