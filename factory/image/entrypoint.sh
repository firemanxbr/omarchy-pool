#!/usr/bin/env bash
# omarchy-worker — one image, one command, for contributors and maintainers.
#
# The registration behind OMARCHY_WORKER_TOKEN decides what this container
# does; nothing else differs between a contributor's machine and a
# maintainer's:
#
#   community trust  → the contributor's worker: one task per container,
#                      built right here, the result into the contributor's
#                      staging workspace (WORKER_SHARED=1 builds anyone's,
#                      an agent key — ANTHROPIC_API_KEY, OPENAI_API_KEY,
#                      GEMINI_API_KEY or XAI_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN for
#                      a Claude subscription — brings the owner's agent).
#   project trust    → the project's worker: the pool's jobs and the rebuild
#                      of approved packages, each in a fresh sibling
#                      container through the runtime's socket mounted at
#                      /var/run/docker.sock (docs: /docs/workers); with an
#                      agent key it also audits staged builds for the
#                      maintainers (the second agent).
#
# OMARCHY_WORKER_ROLE names one of the three containers the project runs
# (docs: /docs/workers — *The three roles*), and is optional: without it the
# trust decides everything, as above. With it:
#
#   pool       a project worker for the pool's own jobs only — sync, render,
#              promote, rollback, health, security, enqueue, gc, verify;
#              never a build, never an audit. No agent key needed.
#   review     a project worker for the maintainers' work only — the rebuild
#              of approved packages and the audit of staged builds (the
#              second agent, so it wants an agent key); never a pool job.
#   community  a shared community worker: builds anyone's community
#              packages, drafts PKGBUILDs for package requests with its
#              owner's agent key (WORKER_SHARED=1 is implied).
#   broker     no build here: the one process on this host that holds the
#              credentials (factory/bin/broker, :8790) — the worker's token,
#              the agent's key, GITHUB_TOKEN — and only receives, processes
#              and answers: the pool's calls for the one task it claimed,
#              the agent, GitHub read-only. A community builder runs beside
#              it with OMARCHY_BROKER=http://broker:8790 and nothing else.
#              `agent` is the same role without a worker token: the agent
#              and GitHub served to build containers that cannot run the
#              agent themselves (the project's review builds; the emulated
#              x86_64 worker, where Claude Code's binary dies under qemu).
#              On a maintainer host it is a task's agent sidecar (#336): its
#              keys come from the read-only file OMARCHY_AGENT_ENV names
#              (OMARCHY_SECRETS_DIR/agent.env), never from the environment
#              the engine shows; `agent --probe` answers the probe sidecar's
#              one question and exits.
#   egress     a task's egress sidecar on a maintainer host (#336, design v2
#              §9.4): `pkg-repo egress`, a forward proxy that allows CONNECT,
#              GET and HEAD to public addresses only. No token, no key, no
#              mount; the dispatcher starts one per task.
#   dispatcher a maintainer host's one service (the host set, factory/sets/host;
#              design v2 §9, #335): `pkg-repo dispatch` — it claims as many
#              tasks as the host's capacity allows and runs each in one
#              isolated, credential-less task container through the
#              runtime's socket. Its host's worker token comes from
#              etc/dispatcher.env; it holds no agent key and refuses a
#              package signing key.
#
# OMARCHY_BROKER makes this container a builder: it holds no token and no
# key, asks the broker who it is, builds one task and exits (/docs/security-model,
# *Isolation*; /docs/workers#secrets).
#
# A role reports itself in the worker's labels ("role"), so the Workers page
# shows what each container is for. Extra arguments go to `pkg-repo work`
# in project mode (--idle-exit, --once; --kind and --labels are the role's
# when a role is set); in community mode they are ignored.
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
case "$role" in ""|pool|review|community|agent|broker|updater|dispatcher|egress) ;; *) echo "omarchy-worker: OMARCHY_WORKER_ROLE must be pool, review, community, broker, agent, updater, dispatcher or egress (or unset)" >&2; exit 2 ;; esac
if [[ "$role" == egress ]]; then
  exec pkg-repo egress "$@"
fi
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
# The updater: the compose project (COMPOSE_DIR, mounted at the same path)
# follows the pool's release through the runtime's socket
# (factory/bin/omarchy-rollout) — as a service it asks the pool every two
# minutes and rolls the set out when the release changes or an Update is
# open for one of its workers (#277), once with --once when no updater runs
# (omarchy-worker update), what changed replaced together, itself last. No
# token, no key.
if [[ "$role" == updater ]]; then
  [[ -S /var/run/docker.sock ]] || { echo "omarchy-worker: the updater needs the runtime's socket at /var/run/docker.sock" >&2; exit 2; }
  exec /usr/local/lib/omarchy-factory/bin/omarchy-rollout "${@:---loop}"
fi
if [[ "$role" == dispatcher ]]; then
  sock="${DOCKER_HOST:-unix:///var/run/docker.sock}"; sock="${sock#unix://}"
  [[ "$sock" == *://* || -S "$sock" ]] || { echo "omarchy-worker: the dispatcher starts task containers through the runtime's socket; mount it at $sock" >&2; exit 2; }
  exec pkg-repo dispatch "$@"
fi
if [[ "$role" == agent && -n "${OMARCHY_AGENT_ENV:-}" ]]; then
  # A task's agent sidecar, or the probe's: never the pool's path, whatever the environment says.
  unset OMARCHY_WORKER_TOKEN FACTORY_TOKEN
  load_agent_env "$OMARCHY_AGENT_ENV" || exit 2
fi
if [[ "$role" == agent && "${1:-}" == --probe ]]; then
  ensure_claude || echo "omarchy-worker: Claude Code did not install" >&2
  export PATH="$HOME/.local/bin:$PATH"
  exec python3 /usr/local/lib/omarchy-factory/bin/agent.py --probe
fi
if [[ "$role" == broker || "$role" == agent ]]; then
  # The broker: the credentials stay here. Claude Code is installed the
  # same way a worker installs it when the subscription token is the agent.
  ensure_claude || echo "omarchy-worker: Claude Code did not install; the broker will answer 502 to the agent's calls until it does" >&2
  export PATH="$HOME/.local/bin:$PATH"
  exec python3 /usr/local/lib/omarchy-factory/bin/broker
fi
if [[ -n "${OMARCHY_BROKER:-}" ]]; then
  # A builder behind a broker: no token, no key — ask the broker who this
  # worker is. The broker may still be starting (installing the agent).
  OMARCHY_BROKER="${OMARCHY_BROKER%/}"
  for k in OMARCHY_WORKER_TOKEN FACTORY_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY XAI_API_KEY GITHUB_TOKEN; do
    [[ -n "${!k:-}" ]] && echo "omarchy-worker: $k is set on a builder behind a broker; it belongs on the broker — ignoring it" >&2 && unset "$k"
  done
  self=""; for _ in $(seq 1 40); do
    self="$(curl -sS --fail-with-body --max-time 30 "$OMARCHY_BROKER/pool/factory/workers/self" 2>&1)" && break
    echo "omarchy-worker: waiting for the broker at $OMARCHY_BROKER: $self" >&2; self=""; sleep 15
  done
  [[ -n "$self" ]] || { echo "omarchy-worker: no broker answered at $OMARCHY_BROKER in ten minutes" >&2; exit 2; }
  id="$(jq -r .id <<<"$self")"; trust="$(jq -r .trust <<<"$self")"; arch="$(jq -r .arch <<<"$self")"; owner="$(jq -r '.owner // ""' <<<"$self")"
  host_arch="$(uname -m)"; [[ "$host_arch" == arm64 ]] && host_arch=aarch64
  [[ "$trust" == community ]] || { echo "omarchy-worker: $id is project-trusted; a project worker runs pkg-repo work with the runtime's socket, not behind a broker (docs: /docs/workers#project)" >&2; exit 2; }
  [[ "$arch" == "$host_arch" ]] || { echo "omarchy-worker: $id is registered for $arch but this machine is $host_arch" >&2; exit 2; }
  [[ "$role" == community ]] && export WORKER_SHARED=1
  labels="$(jq -cn --argjson l "${WORKER_LABELS:-"{}"}" --arg r "$role" 'if $r == "" then $l else $l + {role: $r} end')"
  export WORKER_LABELS="$labels" WORKER_ID="$id"
  echo "omarchy-worker: $id — ${owner:-?}'s builder ($arch) behind the broker at $OMARCHY_BROKER; one task per container${WORKER_SHARED:+, shared}" >&2
  exec omarchy-build-worker --container
fi
: "${OMARCHY_WORKER_TOKEN:?OMARCHY_WORKER_TOKEN is required: register a worker on your page, /user/<login> (maintainers only) (or OMARCHY_BROKER, the broker that holds it)}"

self="$(curl -sS --fail-with-body --max-time 30 "$OMARCHY_API/api/v1/factory/workers/self" -H "authorization: Bearer $OMARCHY_WORKER_TOKEN" 2>&1)" \
  || { echo "omarchy-worker: the pool did not accept this token: $self" >&2; exit 2; }
id="$(jq -r .id <<<"$self")"; trust="$(jq -r .trust <<<"$self")"; arch="$(jq -r .arch <<<"$self")"; owner="$(jq -r '.owner // ""' <<<"$self")"
host_arch="$(uname -m)"; [[ "$host_arch" == arm64 ]] && host_arch=aarch64
mode="${OMARCHY_WORKER_MODE:-$([[ "$trust" == project ]] && echo project || echo community)}"
# A role is a promise about what this container does; the registration's
# trust must allow it, or the container says so and stops rather than
# quietly doing something else.
case "$role" in
  pool|review) [[ "$trust" == project ]] || { echo "omarchy-worker: $id is a $trust registration; the $role role needs a project-trusted one (a maintainer trusts it on Review)" >&2; exit 2; }; mode=project ;;
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
    # Its id, where its set's updater reads it through the engine (#277): the updater names this worker to the pool's follow with it, and
    # never sees the token. Root-owned, readable, beside the instance pkg-repo work writes (its own container's proof, §1.14).
    run_dir="${OMARCHY_RUN_DIR:-/run/omarchy}"
    if mkdir -p "$run_dir" 2>/dev/null && printf '%s\n' "$id" > "$run_dir/worker-id" 2>/dev/null; then chmod 0644 "$run_dir/worker-id" 2>/dev/null || true
    else echo "omarchy-worker: could not write $run_dir/worker-id; its set's updater cannot name $id to the pool, and follows the pool's release alone" >&2; fi
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
