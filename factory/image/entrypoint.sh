#!/usr/bin/env bash
# omarchy-worker — one image, one command: what a maintainer host's dispatcher
# starts (design v2 §9, #335, #336), and, until the last of them is retired
# (#346), what a legacy registration from before hosts still runs.
#
# OMARCHY_WORKER_ROLE names what this container is:
#
#   dispatcher a maintainer host's one service (the host set, factory/sets/host;
#              design v2 §9, #335): `pkg-repo dispatch` — it claims as many
#              tasks as the host's capacity allows and runs each in one
#              isolated, credential-less task container through the
#              runtime's socket. Its host's worker token is a read-only
#              file the host set mounts (OMARCHY_WORKER_TOKEN_FILE, the
#              agent's run/host/dispatcher/token, #327), never a value in
#              its environment; it holds no agent key and refuses a package
#              signing key.
#   egress     a task's egress sidecar (#336, design v2 §9.4): `pkg-repo
#              egress`, a forward proxy that allows CONNECT, GET and HEAD to
#              public addresses only. No token, no key, no mount; the
#              dispatcher starts one per task.
#   agent      a task's agent sidecar (#336, design v2 §9.5): factory/bin/broker
#              serving the agent in the Anthropic Messages shape and GitHub
#              read-only, to its own task only, within the caps the
#              dispatcher set. Its keys come from the read-only file
#              OMARCHY_AGENT_ENV names (OMARCHY_SECRETS_DIR/agent.env), never
#              from the environment the engine shows; a worker token is never
#              its. `agent --probe` answers the probe sidecar's one question
#              and exits.
#
# A legacy registration's token, with no role or with pool, review or
# community, still starts what it started before hosts — `pkg-repo work` for a
# project-trusted one, the build script's container mode for a community one —
# for whatever is left of those sets until its registration is retired (design
# v2 §21.4: `:latest` stays published and signed for anything left). Nothing
# new starts them: no legacy registration is made any more (POST
# /factory/workers answers 410), the sets' compose files, their updater
# (omarchy-rollout) and the broker that relayed a builder's pool calls are gone
# (#346), and a maintainer's machine joins as a host (/docs/worker-host).
#
# OMARCHY_WORKER_TOKEN_FILE names a file holding the worker token, and wins
# over OMARCHY_WORKER_TOKEN, whose value anyone who can talk to the runtime's
# socket reads with `docker inspect` (design v2 §14, D15). The plain variable
# keeps working: a container started from an older release carries it there.
#
# A role reports itself in the worker's labels ("role"). Extra arguments go to
# `pkg-repo dispatch` and `pkg-repo egress`, and to `pkg-repo work` for a
# legacy project registration.
set -euo pipefail
: "${OMARCHY_API:=https://pkgs.omarchy-pool.org}"
# Claude Code, for a Claude subscription as the agent (CLAUDE_CODE_OAUTH_TOKEN):
# the image does not ship it (it is Anthropic's, under their terms); the
# official installer fetches the release for this architecture, checksum
# verified, into this container's home at first start. A binary that is
# there but does not answer `claude --version` within 10 s — an install cut
# short by a network error, which `docker restart` keeps, since it keeps the
# container's filesystem — is removed and installed again (#277): a restart
# of the agent service, by an order or by hand, then fixes that too.
claude_answers() {
  local bin; bin="$(command -v claude 2>/dev/null || true)"; [[ -n "$bin" ]] || bin="$HOME/.local/bin/claude"
  [[ -x "$bin" ]] && timeout 10 "$bin" --version >/dev/null 2>&1
}
ensure_claude() { # returns non-zero when Claude Code is not there after it
  [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${CLAUDE_CODE_BIN:-}" ]] || return 0
  if command -v claude >/dev/null 2>&1 || [[ -e "$HOME/.local/bin/claude" ]]; then
    claude_answers && return 0
    echo "omarchy-worker: Claude Code is here but does not answer --version (an install cut short?); installing it again" >&2
    rm -f "$HOME/.local/bin/claude"
  else
    echo "omarchy-worker: CLAUDE_CODE_OAUTH_TOKEN is set; installing Claude Code (claude.ai/install.sh)" >&2
  fi
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 && PATH="$HOME/.local/bin:$PATH" claude_answers
}

role="${OMARCHY_WORKER_ROLE:-}"
case "$role" in
  ""|pool|review|community|agent|dispatcher|egress) ;;
  # The legacy sets' updater and broker are gone (#346): a container that still asks for one says what replaced it.
  updater|broker) echo "omarchy-worker: the $role role is gone (#346): legacy sets retired with the move to the host agent, and a maintainer's machine joins as a host (https://omarchy-pool.org/docs/worker-host)" >&2; exit 2 ;;
  *) echo "omarchy-worker: OMARCHY_WORKER_ROLE must be dispatcher, egress or agent (or, for a legacy registration not yet retired, pool, review, community or unset)" >&2; exit 2 ;;
esac
if [[ "$role" == egress ]]; then
  exec pkg-repo egress "$@"
fi
# The worker token's file (#327): one token on one line, as the agent writes it. A file
# that is named but gives no token stops the container — never a silent fall back to a
# plain variable that may be stale.
token_from_file() {
  local f="$OMARCHY_WORKER_TOKEN_FILE" t
  [[ -f "$f" && -r "$f" ]] || { echo "omarchy-worker: OMARCHY_WORKER_TOKEN_FILE=$f is not a file this container can read (the host set mounts the agent's run/host/dispatcher/token there, read-only)" >&2; return 1; }
  t="$(head -c 4097 "$f" | tr -d '\r')"
  [[ -n "$t" && ${#t} -le 4096 && "$t" != *[![:graph:]]* ]] || { echo "omarchy-worker: OMARCHY_WORKER_TOKEN_FILE=$f holds no worker token (one token on one line)" >&2; return 1; }
  printf '%s' "$t"
}
# An agent sidecar's keys (#336): KEY=VALUE lines of a file mounted read-only, the agent's keys and settings only — a worker
# token or anything else in it is ignored, and named. A value may be quoted; nothing in the file is run.
load_agent_env() {
  local file="$1" line k v
  [[ -r "$file" && -f "$file" ]] || { echo "omarchy-worker: no agent keys at $file (OMARCHY_SECRETS_DIR/agent.env)" >&2; return 1; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" == \#* ]] && continue
    line="${line#export }"
    k="${line%%=*}"; v="${line#*=}"
    [[ "$line" == *=* ]] || { echo "omarchy-worker: $file: a line that is not KEY=VALUE; ignored" >&2; continue; }
    if [[ "$v" == \"*\" || "$v" == \'*\' ]]; then v="${v:1:${#v}-2}"; fi
    case "$k" in
      ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|GEMINI_API_KEY|XAI_API_KEY|GITHUB_TOKEN|FACTORY_PROVIDER|FACTORY_MODEL|FACTORY_REASONING) export "$k=$v" ;;
      *) echo "omarchy-worker: $file: $k is not an agent setting; ignored" >&2 ;;
    esac
  done < "$file"
}
if [[ "$role" == dispatcher ]]; then
  sock="${DOCKER_HOST:-unix:///var/run/docker.sock}"; sock="${sock#unix://}"
  [[ "$sock" == *://* || -S "$sock" ]] || { echo "omarchy-worker: the dispatcher starts task containers through the runtime's socket; mount it at $sock" >&2; exit 2; }
  # pkg-repo reads the file itself (and prefers it); checked here so a missing mount says so
  # before anything starts. The token never enters this shell's environment.
  if [[ -n "${OMARCHY_WORKER_TOKEN_FILE:-}" ]]; then
    token_from_file > /dev/null || exit 2
  elif [[ -z "${OMARCHY_WORKER_TOKEN:-}" ]]; then
    echo "omarchy-worker: the dispatcher has no worker token: OMARCHY_WORKER_TOKEN_FILE (the host set mounts the agent's run/host/dispatcher/token) or, from an older release, OMARCHY_WORKER_TOKEN" >&2; exit 2
  fi
  exec pkg-repo dispatch "$@"
fi
if [[ "$role" == agent ]]; then
  # A task's agent sidecar, or the probe's: no worker token, whatever the environment says; its keys from the read-only file
  # OMARCHY_AGENT_ENV names. Claude Code is installed at first start when the subscription token is the agent.
  unset OMARCHY_WORKER_TOKEN OMARCHY_WORKER_TOKEN_FILE FACTORY_TOKEN
  if [[ -n "${OMARCHY_AGENT_ENV:-}" ]]; then load_agent_env "$OMARCHY_AGENT_ENV" || exit 2; fi
  ensure_claude || echo "omarchy-worker: Claude Code did not install; the agent answers 502 until it does" >&2
  export PATH="$HOME/.local/bin:$PATH"
  if [[ "${1:-}" == --probe ]]; then exec python3 /usr/local/lib/omarchy-factory/bin/agent.py --probe; fi
  exec python3 /usr/local/lib/omarchy-factory/bin/broker
fi
# A legacy registration's token, read from the environment by the pool's answer below,
# pkg-repo work and the build worker: the file's value goes there, into this container's
# processes only, never into its configuration.
if [[ -n "${OMARCHY_WORKER_TOKEN_FILE:-}" ]]; then
  OMARCHY_WORKER_TOKEN="$(token_from_file)" || exit 2
  export OMARCHY_WORKER_TOKEN
  unset OMARCHY_WORKER_TOKEN_FILE
fi
: "${OMARCHY_WORKER_TOKEN:?OMARCHY_WORKER_ROLE is required: dispatcher, egress or agent, as a maintainer host starts them (or OMARCHY_WORKER_TOKEN, for a legacy registration not yet retired)}"

self="$(curl -sS --fail-with-body --max-time 30 "$OMARCHY_API/api/v1/factory/workers/self" -H "authorization: Bearer $OMARCHY_WORKER_TOKEN" 2>&1)" \
  || { echo "omarchy-worker: the pool did not accept this token: $self" >&2; exit 2; }
id="$(jq -r .id <<<"$self")"; trust="$(jq -r .trust <<<"$self")"; arch="$(jq -r .arch <<<"$self")"; owner="$(jq -r '.owner // ""' <<<"$self")"
host_arch="$(uname -m)"; [[ "$host_arch" == arm64 ]] && host_arch=aarch64
mode="${OMARCHY_WORKER_MODE:-$([[ "$trust" == project ]] && echo project || echo community)}"
# A role is a promise about what this container does; the registration's
# trust must allow it, or the container says so and stops rather than
# quietly doing something else.
case "$role" in
  pool|review) [[ "$trust" == project ]] || { echo "omarchy-worker: $id is a $trust registration; the $role role needs a project-trusted one, given before #343 (per-worker trust is gone: a host takes this work, /docs/worker-host#maintainer-hosts)" >&2; exit 2; }; mode=project ;;
  community) [[ "$trust" == community ]] || { echo "omarchy-worker: $id is project-trusted; the community role wants a community registration (never mix the project's work with contributors' builds)" >&2; exit 2; }; mode=community; export WORKER_SHARED=1 ;;
esac
# A community worker builds inside this container, so it must be the
# registered architecture; a project worker starts a container per task
# with the task's platform, so its registration is a label (an x86_64 pool
# or review worker runs natively on an aarch64 host).
if [[ "$arch" != "$host_arch" && "$mode" != project ]]; then
  echo "omarchy-worker: $id is registered for $arch but this machine is $host_arch" >&2; exit 2
fi
agent=""; for k in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY XAI_API_KEY; do [[ -n "${!k:-}" ]] && agent=1; done
# A Claude subscription as the agent (CLAUDE_CODE_OAUTH_TOKEN, from `claude
# setup-token` on the owner's machine): factory/bin/agent.py runs Claude
# Code in print mode, so the binary must be here (ensure_claude, above:
# ~200 MB, once per container, again when what is there does not answer).
if [[ "${FACTORY_PROVIDER:-claude-code}" == claude-code ]]; then
  if ensure_claude; then
    [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${CLAUDE_CODE_BIN:-}" ]] && echo "omarchy-worker: Claude Code $(PATH="$HOME/.local/bin:$PATH" claude --version 2>/dev/null | head -n1) is here for the audits and drafts" >&2
  else
    echo "omarchy-worker: Claude Code did not install; audits and drafts will fail until it does (CLAUDE_CODE_BIN can point at a mounted binary)" >&2
  fi
fi
export PATH="$HOME/.local/bin:$PATH"
labels="$(jq -cn --argjson l "${WORKER_LABELS:-"{}"}" --arg r "$role" 'if $r == "" then $l else $l + {role: $r} end')"
export WORKER_LABELS="$labels"

case "$mode" in
  project)
    # The runtime's socket (DOCKER_HOST, unix:///var/run/docker.sock in the image).
    sock="${DOCKER_HOST:-unix:///var/run/docker.sock}"; sock="${sock#unix://}"
    if [[ "$sock" != *://* && ! -S "$sock" ]]; then
      echo "omarchy-worker: $id is a project worker; its builds and checks run in fresh containers through your runtime — mount its socket at $sock (docs: /docs/workers)" >&2
      exit 2
    fi
    [[ -n "${OMARCHY_WORK_DIR:-}" ]] || echo "omarchy-worker: OMARCHY_WORK_DIR not set; using /var/lib/omarchy-worker — mount the same host path there" >&2
    case "$role" in
      pool)
        echo "omarchy-worker: $id — pool worker ($arch): the pool's jobs, no builds, no audits" >&2
        exec pkg-repo work --arch "$arch" --labels "$labels" --kind sync --kind render --kind promote --kind rollback --kind health --kind security --kind enqueue --kind gc --kind verify --kind relayout --kind trial "$@"
        ;;
      review)
        [[ -n "$agent" ]] || echo "omarchy-worker: $id has no agent key — approved rebuilds run, audits wait for a review worker with one (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY, GEMINI_API_KEY or XAI_API_KEY)" >&2
        echo "omarchy-worker: $id — review worker ($arch): approved rebuilds${agent:+ and audits of staged builds}, no pool jobs" >&2
        exec pkg-repo work --arch "$arch" --labels "$labels" --kind build --kind publish ${agent:+--kind audit} "$@"
        ;;
      *)
        echo "omarchy-worker: $id — project worker ($arch, ${owner:-project}); pool jobs and approved rebuilds${agent:+, audits of staged builds}" >&2
        exec pkg-repo work --arch "$arch" "$@"
        ;;
    esac
    ;;
  community)
    [[ "$role" != community || -n "$agent" ]] || echo "omarchy-worker: $id has no agent key — registered packages build, package requests (drafts) wait for a community worker with one" >&2
    # The worker reads GitHub's API for every package it builds (the release,
    # the files); without a token GitHub allows 60 requests an hour from this
    # address, and ten builds in a row were ten "rate limit reached" failures.
    [[ -n "${GITHUB_TOKEN:-}" ]] || echo "omarchy-worker: no GITHUB_TOKEN — GitHub allows 60 API requests an hour from this address; a fine-grained token with no permissions, made for this worker, gives 5000" >&2
    whose="${owner}'s"; [[ -n "$role" ]] && whose="$role"
    echo "omarchy-worker: $id — $whose worker ($arch); one task per container${WORKER_SHARED:+, shared}${agent:+, with an agent}" >&2
    export WORKER_ID="$id"
    exec omarchy-build-worker --container
    ;;
  *) echo "omarchy-worker: OMARCHY_WORKER_MODE must be community or project" >&2; exit 2 ;;
esac
