#!/usr/bin/env bash
# omarchy-build-worker — the build half of the factory's workers.
#
# Two modes, both inside a container, never on a host by hand:
#
#   --container  the Omarchy Packaging image (a contributor's worker): claims
#                one community task, builds it right here, uploads the result
#                to the contributor's staging workspace and exits; a wrapper
#                (compose restart) starts the next container. No key, no
#                publish credential: community results never touch the pool.
#                With OMARCHY_BROKER it holds no token either: the broker
#                beside it (factory/bin/broker) holds the worker's token, the
#                agent's key and GitHub's, and passes the pool's calls for
#                the one task it claimed — this container is born with nothing.
#   --inside     called by `pkg-repo work` (a project worker) in a FRESH Arch
#                container per task (x86_64: archlinux:base-devel, aarch64:
#                menci/archlinuxarm:base-devel): fetch the PKGBUILD at the
#                task's commit (or from staging, after an approval), makepkg
#                as a plain user, leave the packages for the host, which
#                publishes them with the task's per-job token; the pool signs.
#
# Environment (secrets come from the operator, never from the task — and
# never reach the build: hold_secrets, below):
#   OMARCHY_API            https://pkgs.firemanxbr.org
#   OMARCHY_POOL           https://pool.firemanxbr.org (builds can depend on earlier factory builds)
#   OMARCHY_BROKER         http://broker:8790 — the broker that holds the credentials; then none of the next three is needed here
#   OMARCHY_WORKER_TOKEN   this worker's token (POST /factory/workers, shown once); FACTORY_TOKEN is an accepted alias
#   WORKER_ID              the registered worker id (shown with the token; the image reads it from the broker)
#   WORKER_LABELS          JSON shown on the Factory page, e.g. {"where":"laptop"}
#   WORKER_SHARED          1 = build anyone's community packages (donated compute); default: the owner's only
#   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
#                          the worker owner's agent key, if any (one is enough): drafts and corrects PKGBUILDs
#                          here, on this machine (factory/bin/agent.py; FACTORY_PROVIDER / FACTORY_MODEL choose);
#                          the last one is a Claude subscription, through Claude Code in print mode
#   IDLE_EXIT              exit after this many seconds without work (0 = never; default 0)
#   MAX_TASKS              exit after this many tasks (0 = unlimited; default 0)
set -euo pipefail

REPO_URL="https://github.com/firemanxbr/omarchy-pool"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# What this worker holds — its token, the agent's key, GitHub's — stays out
# of the environment every child inherits. `export -n` keeps them as shell
# variables for api() and agent_label(); with_secrets lends the agent's
# key and GitHub's — never the worker's token — to the one process that
# needs them (the agent, the drafter), exported inside a subshell so they
# never show in an argv either. Nothing else sees them: not makepkg, not
# the PKGBUILD it sources for --printsrcinfo, updpkgsums and namcap, not
# the upstream's build system — a build is somebody else's code, and its
# log is public (worker/src/leak.ts checks it anyway).
AGENT_VARS=(ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY XAI_API_KEY CLAUDE_CODE_OAUTH_TOKEN GITHUB_TOKEN)
SECRET_VARS=(OMARCHY_WORKER_TOKEN FACTORY_TOKEN "${AGENT_VARS[@]}")
hold_secrets() { local v; for v in "${SECRET_VARS[@]}"; do [[ -n "${!v+x}" ]] && export -n "$v"; done; return 0; }
with_secrets() { # command... — run with the agent's keys in its environment
  local v
  ( for v in "${AGENT_VARS[@]}"; do [[ -n "${!v:-}" ]] && export "$v"; done; exec "$@" )
}

# The agent this worker runs, as "<provider>/<model>" (the same choice
# factory/bin/agent.py makes), or "" without a key — reported at claim time
# so the Factory page can show it; the key itself never leaves this machine.
BROKER_AGENT=""  # what the broker's /health says its agent is (provider/model), in broker mode
agent_label() {
  if [[ -n "${OMARCHY_BROKER:-}" ]]; then echo "$BROKER_AGENT"; return; fi
  local p k m
  for p in anthropic:ANTHROPIC_API_KEY:claude-sonnet-5 claude-code:CLAUDE_CODE_OAUTH_TOKEN:claude-sonnet-5 openai:OPENAI_API_KEY:gpt-5 gemini:GEMINI_API_KEY:gemini-3.6-flash xai:XAI_API_KEY:grok-4; do
    k="${p#*:}"; k="${k%%:*}"; m="${p##*:}"
    [[ -n "${FACTORY_PROVIDER:-}" && "${FACTORY_PROVIDER}" != "${p%%:*}" ]] && continue
    [[ -n "${!k:-}" ]] && { echo "${p%%:*}/${FACTORY_MODEL:-$m}"; return; }
  done
  echo ""
}

# Does the agent answer? A key set is not an agent that works: the probe
# (factory/bin/agent.py --probe, one tiny completion) runs at start, every
# AGENT_PROBE_MINUTES (30) and after a build the agent failed in; its answer
# goes with every claim, and the brain hands agent work — a draft, an audit
# — only to a worker whose agent is ok (docs/GOVERNANCE.md, *Workers*).
AGENT_STATUS=""; AGENT_ERROR=""; AGENT_CHECKED=0
agent_probe() {
  local out
  if [[ -n "${OMARCHY_BROKER:-}" ]]; then
    # The broker probes its own agent and says who it is; a broker without
    # an agent is a worker without one. It may still be starting (installing
    # the agent): a while, not a verdict.
    local tries=0
    while :; do
      out="$(curl -sS --max-time 180 "$OMARCHY_BROKER/health" 2>/dev/null || true)"
      [[ -n "$out" ]] && break
      tries=$((tries + 1)); (( tries < 20 )) || break
      sleep 15
    done
    BROKER_AGENT="$(jq -r '.agent // ""' <<<"$out" 2>/dev/null || true)"
    if [[ -z "$BROKER_AGENT" ]]; then AGENT_STATUS=""; AGENT_ERROR=""
    elif [[ "$(jq -r '.ok' <<<"$out" 2>/dev/null)" == true ]]; then
      AGENT_STATUS=ok; AGENT_ERROR=""; log "agent $BROKER_AGENT, through the broker: ok ($(jq -r '.ms // "?"' <<<"$out") ms)"
    else
      AGENT_STATUS=error; AGENT_ERROR="$(jq -r '.error // "no answer"' <<<"$out" 2>/dev/null || echo "no answer")"
      log "agent $BROKER_AGENT, through the broker: NOT ready — ${AGENT_ERROR:0:200}"
    fi
    AGENT_CHECKED=$(date +%s)
    return
  fi
  [[ -n "$(agent_label)" ]] || { AGENT_STATUS=""; AGENT_ERROR=""; return; }
  if out="$(with_secrets timeout 120 python3 /build/pool/factory/bin/agent.py --probe 2>/dev/null)"; then
    AGENT_STATUS=ok; AGENT_ERROR=""
    log "agent $(agent_label): ok ($(jq -r '.ms' <<<"$out" 2>/dev/null || echo ?) ms)"
  else
    AGENT_STATUS=error; AGENT_ERROR="$(jq -r '.error // "no answer"' <<<"$out" 2>/dev/null || echo "no answer")"
    log "agent $(agent_label): NOT ready — ${AGENT_ERROR:0:200}"
  fi
  AGENT_CHECKED=$(date +%s)
}
agent_probe_if_due() {
  local every=$(( ${AGENT_PROBE_MINUTES:-30} * 60 ))
  (( $(date +%s) - AGENT_CHECKED >= every )) && agent_probe
  return 0
}

# ---------------------------------------------------------------- inside ---
# Runs as root in a fresh Arch container with /task mounted: /task/meta.sh
# (name, ref, arch, pool), /task/out for the result. Logs to stdout.
#
# `ref` says where the PKGBUILD comes from:
#   <commit>                   factory/pkgbuilds/<name> (or factory/sizing/<name>) in omarchy-pool at that commit
#   <url>@<tag>:<path>         the contributor's own repository at a tag (path is the PKGBUILD or its directory)
#   draft:<url>@<tag|latest>   drafted here by factory/bin/draft-pkgbuild (the contributor's agent key, if any)
#   bump:<task>@<tag>          the PKGBUILD approved in <task>, pkgver moved to <tag>, checksums refreshed (a community build: evidence)
#   review:<task>              the project's own build of what a contributor staged in <task>: the request's
#                              facts and the contributor's evidence go to the project's agent as the lesson,
#                              the PKGBUILD it writes is its own; needs an agent (meta.sh carries the request)
#   staging:<task>             refused since 2026-09-15: a build never starts from a contributor's staged
#                              artifact — the project writes its own (review:<task>, docs/GOVERNANCE.md)
prepare_container() {
  # pacman's download sandbox (seccomp + landlock) has no place in an
  # already-isolated, sometimes emulated container.
  sed -i -e 's/^#\?DisableSandboxSyscalls/DisableSandboxSyscalls/' -e 's/^#\?DisableSandboxFilesystem/DisableSandboxFilesystem/' /etc/pacman.conf
  for opt in DisableSandboxSyscalls DisableSandboxFilesystem; do
    grep -q "^$opt" /etc/pacman.conf || sed -i "0,/^\[options\]/s//[options]\n$opt/" /etc/pacman.conf
  done
  pacman-key --init >/dev/null 2>&1 || true
  pacman -Syu --noconfirm --needed base-devel git namcap jq python pacman-contrib ccache >/dev/null
  install_shellcheck
  # makepkg refuses root; `builder` builds, root installs the dependencies
  # (install_deps) — no sudo anywhere: a setuid sudo does not start under
  # user-mode emulation (an x86_64 build on an aarch64 host).
  id builder >/dev/null 2>&1 || useradd -m -s /bin/bash builder
  # Every core the container sees, for make, ninja and cargo alike — the
  # image's makepkg.conf leaves MAKEFLAGS unset, which is one job; ccache
  # on, so a rebuild of the same sources compiles only what changed.
  mkdir -p /etc/makepkg.conf.d
  printf 'MAKEFLAGS="-j%s"\nNINJAFLAGS="-j%s"\nBUILDENV=(!distcc color ccache check !sign)\n' "$(nproc)" "$(nproc)" > /etc/makepkg.conf.d/omarchy-pool.conf
  # Caches that outlive the container when the operator mounts /build/cache
  # (one directory per trust and architecture on the host; a fresh directory
  # otherwise). Inside it, one directory per package (run_makepkg): what a
  # build writes to cargo's registry, Go's module and build caches or
  # ccache's objects is read by a later build of the same package only.
  install -d -o builder -g builder /build/cache
  # The pool's tooling and key, at main.
  rm -rf /build/pool && git clone -q --depth 1 "$REPO_URL" /build/pool
}

add_pool_repos() { # arch pool
  # Dependencies resolve against what the pool's edge serves for this
  # architecture — the OPR (omarchy, quickshell…) and earlier factory builds
  # — on top of the image's own mirrors. The pool's key verifies the
  # databases; the packages are then checked against the sha256 those signed
  # databases carry, so their upstream signatures need no keyring here.
  local arch="$1" pool="$2" added=0 repo
  for repo in omarchy-packages-edge omarchy-factory-edge; do
    if ! grep -q "^\[$repo\]" /etc/pacman.conf && curl -sfI --max-time 20 "$pool/$arch/$repo.db" >/dev/null; then
      printf '\n[%s]\nSigLevel = DatabaseRequired DatabaseTrustedOnly PackageNever\nServer = %s/$arch\n' "$repo" "$pool" >> /etc/pacman.conf
      added=1
    fi
  done
  if [[ $added == 1 ]]; then
    pacman-key --add /build/pool/docs/omarchy-staging.pub.asc >/dev/null 2>&1
    local poolkey; poolkey="$(gpg --homedir /etc/pacman.d/gnupg --with-colons --show-keys /build/pool/docs/omarchy-staging.pub.asc 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}')"
    pacman-key --lsign-key "$poolkey" >/dev/null 2>&1
    pacman -Sy >/dev/null
  fi
}

fetch_pkgbuild() { # name ref → /build/pkg holds the PKGBUILD directory
  local name="$1" ref="$2"
  rm -rf /build/pkg /build/src
  if [[ "$ref" == staging:* ]]; then
    echo "==> refused: a build never starts from a contributor's staged artifact (task ${ref#staging:}); the project writes its own (review:<task>, docs/GOVERNANCE.md)" >&2
    return 1
  elif [[ "$ref" == review:* ]]; then
    # The project's review build: the evidence of the contributor's staged
    # build — PKGBUILD, log, the gate, the audit — is fetched as the lesson;
    # the agent writes the project's own recipe from the project's sources
    # and the request's facts (meta.sh: review_url, review_source, …).
    local from="${ref#review:}"
    [[ -n "$(agent_label)" ]] || { echo "==> refused: the project's review build needs an agent that answers; this worker has none" >&2; return 1; }
    echo "==> The project's build: learning from staged task $from ($(agent_label))"
    rm -rf /build/evidence && mkdir -p /build/evidence /build/pkg
    local f
    for f in PKGBUILD build.log tests.log audit.md; do
      curl -sSf --max-time 60 "${OMARCHY_API:-https://pkgs.firemanxbr.org}/api/v1/factory/tasks/$from/artifacts/$f" -o "/build/evidence/$f" 2>/dev/null || rm -f "/build/evidence/$f"
    done
    ls -la /build/evidence
    with_secrets python3 /build/pool/factory/bin/draft-pkgbuild --url "${review_url:-$OMARCHY_REVIEW_URL}" --name "$name" --out /build/pkg --evidence /build/evidence \
      ${review_source:+--source "$review_source"} ${review_version:+--version "$review_version"} ${review_desc:+--description "$review_desc"} ${review_license:+--license "$review_license"}
  elif [[ "$ref" == bump:* ]]; then
    # A new upstream release of an approved package: the PKGBUILD a
    # maintainer approved, with pkgver moved to the tag and pkgrel reset;
    # the checksums are refreshed before the build (updpkgsums).
    local spec from tag ver
    spec="${ref#bump:}"; from="${spec%@*}"; tag="${spec#*@}"; ver="${tag#v}"; ver="${ver#V}"
    echo "==> PKGBUILD from approved task $from, bumped to $tag"
    mkdir -p /build/pkg
    curl -sSf "${OMARCHY_API:-https://pkgs.firemanxbr.org}/api/v1/factory/tasks/$from/artifacts/PKGBUILD" -o /build/pkg/PKGBUILD
    sed -i -e "s/^pkgver=.*/pkgver=${ver//\//\\/}/" -e "s/^pkgrel=.*/pkgrel=1/" /build/pkg/PKGBUILD
    chown -R builder:builder /build/pkg && (cd /build/pkg && as_builder updpkgsums) || echo "updpkgsums failed; the build will tell"
  elif [[ "$ref" == draft:* ]]; then
    local spec url
    spec="${ref#draft:}"; url="${spec%@*}"
    echo "==> Drafting a PKGBUILD for $url ($( [[ -n "$(agent_label)" ]] && echo "with the contributor's agent, $(agent_label)" || echo "template; set an agent key on the worker for an agent-written draft"))"
    mkdir -p /build/pkg
    with_secrets python3 /build/pool/factory/bin/draft-pkgbuild --url "$url" --name "$name" --out /build/pkg
  elif [[ "$ref" == *@*:* ]]; then
    local url rest tag path
    url="${ref%%@*}"; rest="${ref#*@}"; tag="${rest%%:*}"; path="${rest#*:}"
    echo "==> PKGBUILD from $url at $tag ($path)"
    if [[ "$tag" == HEAD ]]; then git clone -q --depth 1 "$url" /build/src; else git clone -q --depth 1 --branch "$tag" "$url" /build/src; fi
    [[ -e "/build/src/$path" ]] || { echo "no $path in $url at $tag"; exit 3; }
    if [[ -d "/build/src/$path" ]]; then cp -a "/build/src/$path" /build/pkg; else mkdir -p /build/pkg && cp -a "$(dirname "/build/src/$path")"/. /build/pkg/; fi
  else
    # Everything happens on the container's own filesystem (a bind mount from
    # macOS breaks fakeroot); only the result is copied out.
    git init -q /build/src
    git -C /build/src remote add origin "$REPO_URL"
    git -C /build/src fetch -q --depth 1 origin "$ref"
    git -C /build/src checkout -q FETCH_HEAD
    # The project's recipes, or a sizing recipe (measured by hand, never queued by reconcile).
    local from="/build/src/factory/pkgbuilds/$name"
    [[ -f "$from/PKGBUILD" ]] || from="/build/src/factory/sizing/$name"
    [[ -f "$from/PKGBUILD" ]] || { echo "no PKGBUILD at factory/pkgbuilds/$name (or factory/sizing/$name) in $ref"; exit 3; }
    # Build outside the checkout: build tools walk up the tree (cargo finds the
    # pool's own workspace Cargo.toml above factory/).
    cp -a "$from" /build/pkg
  fi
  [[ -f /build/pkg/PKGBUILD ]] || { echo "no PKGBUILD found for $ref"; exit 3; }
}

# The build user starts from an empty environment — an allowlist, not what
# root happens to have (runuser alone hands over everything but HOME, SHELL,
# USER and LOGNAME). The caches and makepkg's own variables are set by the
# caller on the command line.
as_builder() { runuser -u builder -- env -i PATH="$PATH" HOME=/home/builder USER=builder LOGNAME=builder SHELL=/bin/bash TERM="${TERM:-dumb}" LANG="${LANG:-C.UTF-8}" "$@"; }

# Extends the task's lease while the build runs (every five minutes; the
# lease is thirty): a build longer than the lease is not handed to another
# worker. Killed when the task ends.
heartbeat_loop() { # task-id
  while :; do
    sleep 300
    api POST "/factory/tasks/$1/heartbeat" '{}' >/dev/null 2>&1 || true
  done
}

# What `makepkg --syncdeps` would install, installed by root instead: the
# PKGBUILD's depends, makedepends and checkdepends (this architecture's
# too), from .SRCINFO. Nothing to escalate from the build user.
# Only the pkgbase section — what the build needs. The per-package sections
# that follow (a split package's `package_x()` depends) can name siblings
# this very build produces: ghostty-nautilus depends on ghostty, and asking
# pacman for it before it exists is "target not found: ghostty" (2026-09-15).
install_deps() {
  local deps a; a="$(uname -m)"; [[ "$a" == arm64 ]] && a=aarch64
  deps="$(cd /build/pkg && as_builder makepkg --printsrcinfo 2>/dev/null \
    | awk -F' = ' -v a="$a" '/^pkgname = /{exit} $1 ~ "^[[:space:]]*(make|check)?depends(_" a ")?$" {print $2}' | sort -u)"
  [[ -n "$deps" ]] || return 0
  # shellcheck disable=SC2086
  pacman -S --needed --noconfirm --asdeps -- $deps
}

run_makepkg() { # name → /build/out/*.pkg.tar.zst
  local name="$1" cache
  rm -rf /build/out; mkdir -p /build/out && chown -R builder:builder /build/pkg /build/out
  # This package's own caches (see prepare_container); the name is a path component.
  [[ "$name" =~ ^[A-Za-z0-9@._+-]+$ && "$name" != .* ]] || { echo "refusing package name '$name'" >&2; return 3; }
  cache="/build/cache/$name"
  install -d -o builder -g builder "$cache" "$cache/cargo" "$cache/go" "$cache/go/mod" "$cache/go/build" "$cache/ccache"
  # A drafted PKGBUILD carries SKIP checksums; fill them in — every SKIP
  # that is not a VCS source's, local files included (the gate refuses a
  # SKIP left behind).
  if grep -qE "^(sha256sums|sha512sums|b2sums|md5sums)=.*SKIP" /build/pkg/PKGBUILD; then (cd /build/pkg && as_builder updpkgsums); fi
  # Source signatures verify against keys shipped beside the PKGBUILD
  # (keys/pgp/<fingerprint>.asc, the AUR convention), never a keyserver.
  if compgen -G "/build/pkg/keys/pgp/*.asc" >/dev/null; then
    as_builder gpg --batch --import /build/pkg/keys/pgp/*.asc 2>&1 | grep -E "imported|unchanged" || true
  fi
  # namcap flags the obvious (missing deps, bad permissions) before the build.
  as_builder namcap /build/pkg/PKGBUILD || true
  install_deps
  # zst whatever the image's makepkg.conf says (Arch Linux ARM defaults to xz).
  (cd /build/pkg && as_builder env PKGDEST=/build/out PKGEXT=.pkg.tar.zst PACKAGER="omarchy-pool factory <https://github.com/firemanxbr/omarchy-pool>" \
    CARGO_HOME="$cache/cargo" CARGO_BUILD_JOBS="$(nproc)" GOMODCACHE="$cache/go/mod" GOCACHE="$cache/go/build" GOFLAGS=-modcacherw CCACHE_DIR="$cache/ccache" \
    makepkg --noconfirm --clean --cleanbuild --nosign)
}

# shellcheck for the gate: Arch ships it, Arch Linux ARM does not (a
# Haskell build), so the static release is fetched, pinned by checksum,
# when pacman has none. Without it the gate says so and goes on.
SHELLCHECK_VERSION=v0.11.0
install_shellcheck() {
  command -v shellcheck >/dev/null 2>&1 && return 0
  pacman -S --noconfirm --needed shellcheck >/dev/null 2>&1 && return 0
  local arch sum; arch="$(uname -m)"
  case "$arch" in
    x86_64) sum=8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198 ;;
    aarch64) sum=12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588 ;;
    *) return 1 ;;
  esac
  local tmp=/build/shellcheck.tar.xz
  curl -fsSL --max-time 120 "https://github.com/koalaman/shellcheck/releases/download/$SHELLCHECK_VERSION/shellcheck-$SHELLCHECK_VERSION.linux.$arch.tar.xz" -o "$tmp" || return 1
  [[ "$(sha256 "$tmp")" == "$sum" ]] || { echo "shellcheck: checksum mismatch, not installed" >&2; rm -f "$tmp"; return 1; }
  tar -xJf "$tmp" -C /build && install -m755 "/build/shellcheck-$SHELLCHECK_VERSION/shellcheck" /usr/local/bin/shellcheck && rm -rf "$tmp" "/build/shellcheck-$SHELLCHECK_VERSION"
}

# ------------------------------------------------------------------ gate ---
# What every package must pass before it is evidence, on both sides of the
# review (/docs/governance, /docs/factory *The gate*): real checksums,
# a PKGBUILD shellcheck and namcap accept, a built package namcap accepts,
# a sane file list, metadata that says what it is, a licence file where
# Arch wants one, and a smoke test — installed in this fresh container,
# every binary it puts in /usr/bin started once. The transcript is
# tests.log, the verdict vet.json; a `fail` fails the build (final), a
# `warn` is for the audit and the maintainer to weigh. The checks follow
# the ones the omarchy-aur-factory (Adam Jacob) runs; none is skipped.
VET_JSON=/build/vet.json; VET_LOG=/build/tests.log
vet_add() { # name status detail
  local name="$1" status="$2" detail="$3"
  printf '[%s] %-4s %s — %s\n' "$(date -u +%H:%M:%S)" "$status" "$name" "${detail:0:800}" >>"$VET_LOG"
  jq -c --arg n "$name" --arg s "$status" --arg d "${detail:0:2000}" '.checks += [{name:$n,status:$s,detail:$d}]' "$VET_JSON" >"$VET_JSON.tmp" && mv "$VET_JSON.tmp" "$VET_JSON"
}
vet_package() { # name → 0 pass (maybe warnings), 5 fail; writes vet.json and tests.log
  local name="$1" pkgs=(/build/out/*.pkg.tar.zst) out fails
  echo '{"schema":"omarchy-pool/vet/1","verdict":"pending","checks":[]}' >"$VET_JSON"; : >"$VET_LOG"
  echo "==> The gate: lint, audit, smoke test"
  # 1. checksums: real ones, SKIP only for a VCS source.
  if grep -qE "^(sha256sums|sha512sums|b2sums|md5sums)=.*SKIP" /build/pkg/PKGBUILD && ! grep -qE "^source=.*(git\+|hg\+|svn\+|bzr\+|::git)" /build/pkg/PKGBUILD; then
    vet_add checksums fail "a checksum is SKIP and the source is not a VCS: every download must be pinned"
  else vet_add checksums pass "every source pinned by checksum (SKIP only for a VCS source)"; fi
  # 2. shellcheck on the PKGBUILD (the three codes makepkg makes false: vars it consumes, $pkgdir it defines, cd under -e).
  if ! command -v shellcheck >/dev/null 2>&1; then vet_add shellcheck warn "shellcheck is not available on this worker; the PKGBUILD was not linted for shell errors"; out=""
  else out="$(shellcheck --shell=bash --exclude=SC2034,SC2154,SC2164 --format=gcc /build/pkg/PKGBUILD 2>&1 || true)"; fi
  if ! command -v shellcheck >/dev/null 2>&1; then :
  elif grep -q ": error:" <<<"$out"; then vet_add shellcheck fail "$(grep -c ': error:' <<<"$out") error(s): $(grep ': error:' <<<"$out" | head -3 | tr '\n' ' ')"
  elif grep -q ": warning:" <<<"$out"; then vet_add shellcheck warn "$(grep -c ': warning:' <<<"$out") warning(s): $(grep ': warning:' <<<"$out" | head -3 | tr '\n' ' ')"
  else vet_add shellcheck pass "clean"; fi
  # 3. namcap on the PKGBUILD: E fails, W is weighed.
  out="$(as_builder namcap /build/pkg/PKGBUILD 2>&1 || true)"
  if grep -qE "^PKGBUILD.* E: " <<<"$out"; then vet_add namcap-pkgbuild fail "$(grep -E ' E: ' <<<"$out" | head -4 | tr '\n' ' ')"
  elif grep -qE "^PKGBUILD.* W: " <<<"$out"; then vet_add namcap-pkgbuild warn "$(grep -E ' W: ' <<<"$out" | head -4 | tr '\n' ' ')"
  else vet_add namcap-pkgbuild pass "clean"; fi
  # 4. namcap on every built package: dependencies the ELF scan finds, permissions, paths, srcdir leaks, the licence.
  local p e w
  for p in "${pkgs[@]}"; do
    out="$(as_builder namcap -i "$p" 2>&1 || true)"
    e="$(grep -E ' E: ' <<<"$out" | grep -vE 'E: (dependency-detected-not-included (glibc|gcc-libs)|elffile-not-in-allowed-dirs.*/opt/)' | head -6 | tr '\n' ' ')"
    w="$(grep -E ' W: ' <<<"$out" | head -6 | tr '\n' ' ')"
    if [[ -n "$e" ]]; then vet_add "namcap-package:$(basename "$p")" fail "$e"
    elif [[ -n "$w" ]]; then vet_add "namcap-package:$(basename "$p")" warn "$w"
    else vet_add "namcap-package:$(basename "$p")" pass "clean"; fi
  done
  # 5. the file list: standard paths only, no libtool archives, not empty.
  for p in "${pkgs[@]}"; do
    out="$(pacman -Qlp "$p" 2>/dev/null | awk '{print $2}')"
    local bad; bad="$(grep -E '^/(usr/local|bin|sbin|lib|lib64|home|tmp|root|opt/[^/]+/tmp)/' <<<"$out" | head -3 | tr '\n' ' ' || true)"
    if [[ -z "$(grep -vE '/$' <<<"$out")" ]]; then vet_add "files:$(basename "$p")" fail "the package installs no file"
    elif [[ -n "$bad" ]]; then vet_add "files:$(basename "$p")" fail "files outside the standard tree: $bad"
    elif grep -qE '\.la$' <<<"$out"; then vet_add "files:$(basename "$p")" fail "libtool .la archives are not shipped: $(grep -E '\.la$' <<<"$out" | head -2 | tr '\n' ' ')"
    else vet_add "files:$(basename "$p")" pass "$(grep -cvE '/$' <<<"$out") file(s) under /usr, /etc, /opt"; fi
  done
  # 6. metadata: what pacman shows must say what it is.
  for p in "${pkgs[@]}"; do
    out="$(pacman -Qip "$p" 2>/dev/null)"
    local desc lic url
    desc="$(awk -F' *: ' '/^Description/{print $2}' <<<"$out")"; lic="$(awk -F' *: ' '/^Licenses/{print $2}' <<<"$out")"; url="$(awk -F' *: ' '/^URL/{print $2}' <<<"$out")"
    if [[ -z "$desc" || "$desc" == None || -z "$lic" || "$lic" == None || "$lic" == unknown ]]; then vet_add "metadata:$(basename "$p")" fail "pkgdesc or license missing (desc='${desc}', license='${lic}')"
    elif [[ -z "$url" || "$url" == None ]]; then vet_add "metadata:$(basename "$p")" warn "no url= in the PKGBUILD"
    else vet_add "metadata:$(basename "$p")" pass "$lic · $desc"; fi
  done
  # 7. check(): the upstream test suite, or a reason in the PKGBUILD.
  if grep -qE '^check\(\)' /build/pkg/PKGBUILD; then vet_add check pass "check() runs the upstream tests"
  elif grep -qiE '^#.*(no test|check\(\)|tests? (need|require|are)|upstream has no)' /build/pkg/PKGBUILD; then vet_add check warn "no check(): $(grep -iE '^#.*(no test|check\(\)|tests?|upstream has no)' /build/pkg/PKGBUILD | head -1)"
  else vet_add check warn "no check() and no comment saying why"; fi
  # 8. the smoke test: install here, start every binary the package puts in /usr/bin.
  if pacman -U --noconfirm "${pkgs[@]}" >>"$VET_LOG" 2>&1; then
    local bins started=0 broken=""
    bins="$(for p in "${pkgs[@]}"; do pacman -Qlp "$p" 2>/dev/null | awk '$2 ~ /^\/usr\/bin\/[^\/]+$/ {print $2}'; done | sort -u)"
    for b in $bins; do
      [[ -x "$b" ]] || continue
      local code
      timeout 10 "$b" --version >/build/smoke.out 2>&1; code=$?
      if (( code == 126 || code == 127 || code >= 129 )) || grep -qE 'error while loading shared libraries|cannot open shared object|No such file or directory' /build/smoke.out; then
        timeout 10 "$b" --help >/build/smoke.out 2>&1; code=$?
        if (( code == 126 || code == 127 || code >= 129 )) || grep -qE 'error while loading shared libraries|cannot open shared object' /build/smoke.out; then
          broken+="$b (exit $code: $(head -c 160 /build/smoke.out | tr '\n' ' ')) "; continue
        fi
      fi
      started=$((started + 1)); printf '    %s --version → exit %s\n' "$b" "$code" >>"$VET_LOG"
    done
    if [[ -n "$broken" ]]; then vet_add smoke fail "installed, but a binary does not start: $broken"
    elif [[ -z "$bins" ]]; then vet_add smoke pass "installed; nothing in /usr/bin to start (a library, data, or a desktop app elsewhere)"
    else vet_add smoke pass "installed; $started binary(ies) in /usr/bin started"; fi
  else vet_add smoke fail "pacman -U refused the package: $(tail -n 3 "$VET_LOG" | tr '\n' ' ')"; fi
  fails="$(jq -r '[.checks[] | select(.status == "fail")] | length' "$VET_JSON")"
  local warns; warns="$(jq -r '[.checks[] | select(.status == "warn")] | length' "$VET_JSON")"
  jq -c --arg v "$( (( fails > 0 )) && echo fail || echo pass)" '.verdict = $v | .fails = ([.checks[] | select(.status == "fail")] | length) | .warnings = ([.checks[] | select(.status == "warn")] | length)' "$VET_JSON" >"$VET_JSON.tmp" && mv "$VET_JSON.tmp" "$VET_JSON"
  echo "==> The gate: $( (( fails > 0 )) && echo "FAIL ($fails failing check(s), $warns warning(s))" || echo "pass ($warns warning(s))")"
  cat "$VET_LOG"
  (( fails == 0 )) || return 5
}

# Build with the drafter correcting itself from the log — the contributor's
# agent doing the heavy lifting, on the contributor's machine.
build_with_retries() { # name ref
  local name="$1" ref="$2" attempt=1 max=1
  [[ ( "$ref" == draft:* || "$ref" == review:* ) && -n "$(agent_label)" ]] && max=3
  fetch_pkgbuild "$name" "$ref"
  while :; do
    if run_makepkg "$name" > /build/attempt.log 2>&1; then
      cat /build/attempt.log
      vet_package "$name" && return 0
      # The gate failed: one more turn of the drafter, with the verdict as the log, when there is an agent.
      if (( attempt >= max )); then return 5; fi
      cp "$VET_LOG" /build/attempt.log
    else
      cat /build/attempt.log
      if (( attempt >= max )); then return 4; fi
    fi
    attempt=$((attempt + 1))
    echo "==> Attempt $attempt: correcting the PKGBUILD from the log"
    cp /build/pkg/PKGBUILD /build/PKGBUILD.prev
    if [[ "$ref" == review:* ]]; then
      with_secrets python3 /build/pool/factory/bin/draft-pkgbuild --url "${review_url:-$OMARCHY_REVIEW_URL}" --name "$name" --out /build/pkg --evidence /build/evidence --previous /build/PKGBUILD.prev --log /build/attempt.log \
        ${review_source:+--source "$review_source"} ${review_version:+--version "$review_version"} ${review_desc:+--description "$review_desc"} ${review_license:+--license "$review_license"} || return 4
    else
      local url; url="${ref#draft:}"; url="${url%@*}"
      with_secrets python3 /build/pool/factory/bin/draft-pkgbuild --url "$url" --name "$name" --out /build/pkg --previous /build/PKGBUILD.prev --log /build/attempt.log || return 4
    fi
  done
}

inside() {
  local name ref arch pool review_url review_source review_version review_desc review_license
  # shellcheck source=/dev/null
  source /task/meta.sh
  prepare_container
  add_pool_repos "$arch" "$pool"
  local status=0
  build_with_retries "$name" "$ref" || status=$?
  # The gate's verdict travels with the result, pass or fail.
  mkdir -p /task/out; [[ -f "$VET_JSON" ]] && cp "$VET_JSON" "$VET_LOG" /task/out/ 2>/dev/null
  (( status == 0 )) || exit "$status"
  cp /build/out/*.pkg.tar.zst /task/out/ && cp /build/pkg/PKGBUILD /task/out/PKGBUILD && ls /task/out
}

# ------------------------------------------------------------- container ---
# The Omarchy Packaging image runs this: one container, one task. It claims
# a task for its registered worker, builds it right here (the container is
# the fresh environment — a wrapper restarts a new one per task), uploads
# the result to the contributor's staging workspace and exits. No signing
# key, no publish token: community results never touch the pool directly.
container_worker() {
  if [[ -z "${OMARCHY_BROKER:-}" ]]; then
    OMARCHY_WORKER_TOKEN="${OMARCHY_WORKER_TOKEN:-${FACTORY_TOKEN:-}}"
    : "${OMARCHY_WORKER_TOKEN:?OMARCHY_WORKER_TOKEN (a worker token from POST /factory/workers) is required, or OMARCHY_BROKER (the broker that holds it)}"
  fi
  : "${WORKER_ID:?WORKER_ID (from POST /factory/workers) is required}"
  ARCH="$(uname -m)"; [[ "$ARCH" == arm64 ]] && ARCH=aarch64
  log "container worker $WORKER_ID ($ARCH) preparing"
  # SIGTERM (docker stop, a rolling upgrade) drains: a build in progress runs
  # to its end and is reported — bash runs the trap once the foreground
  # command returns — and nothing new is claimed. Exit 0 either way.
  DRAIN=0; trap 'DRAIN=1' TERM INT
  prepare_container
  add_pool_repos "$ARCH" "$OMARCHY_POOL"
  agent_probe
  local idle=0 out code body task id name ref version
  while :; do
    if [[ "$DRAIN" == 1 ]]; then log "draining: nothing claimed since the stop signal; exiting"; exit 0; fi
    agent_probe_if_due
    out="$(api POST /factory/claim "$(jq -n --arg a "$ARCH" --arg h "$(hostname -s 2>/dev/null || echo ?)" --arg v "container" --arg g "$(agent_label)" --arg as "$AGENT_STATUS" --arg ae "$AGENT_ERROR" --arg ac "$( (( AGENT_CHECKED > 0 )) && date -u -d "@$AGENT_CHECKED" +%Y-%m-%dT%H:%M:%SZ || echo "")" --argjson l "${WORKER_LABELS:-"{}"}" --argjson s "$( [[ "${WORKER_SHARED:-0}" == 1 ]] && echo true || echo false)" '{arch:$a,hostname:$h,version:$v,labels:$l,shared:$s,agent:$g,agent_status:$as,agent_error:$ae,agent_checked_at:$ac}')")" \
      || { log "claim failed: ${out##*$'\n'}"; sleep 60; continue; }
    code="${out##*$'\n'}"; body="${out%$'\n'*}"
    if [[ "$code" == "204" ]]; then
      idle=$((idle + 30))
      if [[ "${IDLE_EXIT:-0}" -gt 0 && "$idle" -ge "${IDLE_EXIT:-0}" ]]; then log "no work for ${idle}s; exiting"; exit 0; fi
      for _ in $(seq 1 30); do [[ "$DRAIN" == 1 ]] && break; sleep 1; done
      continue
    fi
    break
  done
  task="$body"
  id="$(jq -r .task.id <<<"$task")"; name="$(jq -r .task.name <<<"$task")"; ref="$(jq -r .task.pkgbuild_ref <<<"$task")"
  log "task $id: $name for $ARCH ($ref)"
  # The owner's workspace is full: nothing this build produces can land.
  # Say so now — the task fails with the reason on the dashboard — instead
  # of building for an hour into a 413 (2026-09-16, four tasks did).
  if [[ "$(jq -r 'if .staging == null then "ok" elif .staging.bytes >= .staging.quota_bytes then "full" else "ok" end' <<<"$task")" == full ]]; then
    local used quota; used="$(jq -r .staging.bytes <<<"$task")"; quota="$(jq -r .staging.quota_bytes <<<"$task")"
    log "task $id: the owner's staging is full ($used of $quota bytes); not building"
    api POST "/factory/tasks/$id/fail" "$(jq -n --arg e "staging quota reached ($used of $quota bytes): drop a build with DELETE /api/v1/factory/tasks/<id>/artifacts, or wait — superseded, rejected and published builds are reclaimed by the pool" '{error:$e,final:true}')" >/dev/null || true
    exit 1
  fi
  # The heartbeat keeps the lease while the build runs. It dies with this
  # shell, whichever way the shell goes: an upload that failed under
  # `set -e` used to leave it running, and the lease with it, for hours.
  heartbeat_loop "$id" & BEAT=$!; disown "$BEAT"
  trap 'kill "${BEAT:-}" 2>/dev/null || true' EXIT
  local started=$SECONDS status=0
  set +e
  ( set -e; build_with_retries "$name" "$ref" ) > /build/build.log 2>&1
  status=$?
  set -e
  local took=$(( (SECONDS - started) * 1000 )) tail; tail="$(tail -n 80 /build/build.log | jq -Rs .)"
  if [[ $status -ne 0 ]]; then
    kill "$BEAT" 2>/dev/null || true
    local err
    if (( status == 5 )); then err="the gate: $(jq -r '[.checks[] | select(.status == "fail") | .name + ": " + .detail] | join("; ")' "$VET_JSON" 2>/dev/null | head -c 400)"
    else err="$(grep -m1 -E '^(==> ERROR|error|Error|fatal)' /build/build.log || tail -n1 /build/build.log)"; fi
    # The pool retries a task for the infrastructure's sake — a download
    # that broke, a mirror, a container killed under it. A recipe that
    # fails, fails the same way in the next fresh container: the report
    # says so (`final`) and the task fails now; the contributor fixes the
    # PKGBUILD (or sets GITHUB_TOKEN) and queues a new build.
    local final=true
    if grep -qE 'Failure while downloading|curl: \([0-9]+\)|failed retrieving file|failed to synchronize|Could not resolve host|Connection (timed out|refused|reset)|Temporary failure in name resolution' /build/build.log; then final=false; fi
    log "task $id: failed (exit $status$( [[ "$final" == true ]] && echo ", the recipe's — not retried" )) — ${err:0:200}"
    # Upload what there is for the record, then report.
    upload_staging "$id" /build/build.log build.log || true
    [[ -f /build/pkg/PKGBUILD ]] && upload_staging "$id" /build/pkg/PKGBUILD PKGBUILD || true
    [[ -f "$VET_JSON" ]] && upload_staging "$id" "$VET_JSON" vet.json && upload_staging "$id" "$VET_LOG" tests.log || true
    api POST "/factory/tasks/$id/fail" "$(jq -n --arg e "exit $status: ${err:0:500}" --argjson d "$took" --argjson t "$tail" --argjson f "$final" '{error:$e,duration_ms:$d,log_tail:$t,final:$f}')" >/dev/null || true
    exit 1
  fi
  shopt -s nullglob
  local pkgs=(/build/out/*.pkg.tar.zst) main sha filename version
  main="$(ls /build/out/"$name"-[0-9]*.pkg.tar.zst 2>/dev/null | head -n1 || true)"; [[ -n "$main" ]] || main="${pkgs[0]}"
  sha="$(sha256 "$main")"; filename="$(basename "$main")"
  version="$(tar -xOf "$main" .PKGINFO 2>/dev/null | awk -F' = ' '$1=="pkgver"{print $2}')"
  log "task $id: built $filename in $((took / 1000)) s; uploading to staging"
  # An upload that fails — the quota, most likely — is reported as the
  # build's failure, with the pool's answer as the reason, and is final: a
  # fresh container would build the same bytes into the same 413. Before,
  # `set -e` ended the script here with nothing reported and the lease
  # alive under the orphaned heartbeat.
  set +e
  stage_result "$id" "$main" "${pkgs[@]}" 2>/build/upload.err
  status=$?
  set -e
  if (( status != 0 )); then
    local why; why="$(tr -d '\n' </build/upload.err | tail -c 400)"
    log "task $id: staging failed — $why"
    api POST "/factory/tasks/$id/fail" "$(jq -n --arg e "staging: ${why:0:500}" --argjson d "$took" --argjson t "$tail" '{error:$e,duration_ms:$d,log_tail:$t,final:true}')" >/dev/null || true
    exit 1
  fi
  kill "$BEAT" 2>/dev/null || true
  api POST "/factory/tasks/$id/complete" "$(jq -n --arg s "$sha" --arg f "$filename" --arg v "$version" --argjson d "$took" --argjson t "$tail" '{sha256:$s,filename:$f,version:$v,duration_ms:$d,log_tail:$t}')" >/dev/null
  log "task $id: staged — a maintainer takes it from here"
}

# The result into the task's staging workspace: the evidence first — the
# recipe, the log, the gate, the metadata — and the packages last. A
# workspace at its quota then stops the upload where the bytes are, and what
# stays behind is a log and a recipe, not a package no task will complete.
stage_result() { # task-id main-package packages...
  local id="$1" main="$2"; shift 2
  upload_staging "$id" /build/pkg/PKGBUILD PKGBUILD || return 1
  upload_staging "$id" /build/build.log build.log || return 1
  if [[ -f "$VET_JSON" ]]; then
    upload_staging "$id" "$VET_JSON" vet.json || return 1
    [[ -f "$VET_LOG" ]] && { upload_staging "$id" "$VET_LOG" tests.log || return 1; }
  fi
  if tar -xOf "$main" .PKGINFO > /build/PKGINFO 2>/dev/null; then upload_staging "$id" /build/PKGINFO PKGINFO || return 1; fi
  local p
  for p in "$@"; do upload_staging "$id" "$p" "$(basename "$p")" || return 1; done
}

# Upload one file to the task's staging workspace: one PUT up to 90 MB,
# multipart above. On a refusal the pool's answer goes to stderr — the
# quota message says what to do — and the function fails.
upload_staging() { # task-id file name
  local id="$1" file="$2" name="$3" size body=/build/upload.body; size="$(wc -c <"$file" | tr -d ' ')"
  local -a auth; pool_auth
  if (( size <= 90 * 1024 * 1024 )); then
    curl -sS --fail-with-body --max-time 900 -X PUT "$(pool_url "/factory/tasks/$id/artifacts/$name")" "${auth[@]}" \
      -H "content-type: application/octet-stream" --data-binary "@$file" -o "$body" || { echo "PUT $name: $(head -c 400 "$body")" >&2; return 1; }
    return 0
  fi
  local base up parts=() n=0 etag; base="$(pool_url "/factory/tasks/$id/artifacts/$name/multipart")"
  curl -sS --fail-with-body -X POST "$base?action=create" "${auth[@]}" -o "$body" || { echo "multipart create $name: $(head -c 400 "$body")" >&2; return 1; }
  up="$(jq -r .upload_id "$body")"
  rm -rf /build/parts && mkdir -p /build/parts && split -b 64m -d -a 4 "$file" /build/parts/p
  for part in /build/parts/p*; do
    n=$((n + 1))
    curl -sS --fail-with-body -X POST "$base?action=part&part=$n&upload_id=$up" "${auth[@]}" --data-binary "@$part" -o "$body" \
      || { echo "multipart part $n of $name: $(head -c 400 "$body")" >&2; curl -sS -X POST "$base?action=abort&upload_id=$up" "${auth[@]}" -o /dev/null || true; rm -rf /build/parts; return 1; }
    etag="$(jq -r .etag "$body")"
    parts+=("{\"partNumber\":$n,\"etag\":\"$etag\"}")
  done
  curl -sS --fail-with-body -X POST "$base?action=complete&upload_id=$up" "${auth[@]}" -H "content-type: application/json" \
    --data "{\"parts\":[$(IFS=,; echo "${parts[*]}")]}" -o "$body" || { echo "multipart complete $name: $(head -c 400 "$body")" >&2; rm -rf /build/parts; return 1; }
  rm -rf /build/parts
}

# ------------------------------------------------------------------ api ----
: "${OMARCHY_API:=https://pkgs.firemanxbr.org}"
: "${OMARCHY_POOL:=https://pool.firemanxbr.org}"
: "${IDLE_EXIT:=0}"
: "${MAX_TASKS:=0}"
# The pool's calls go to the broker when there is one (it adds the worker's
# token and passes only what a build needs), straight to the pool with the
# token otherwise. pool_auth fills the caller's `auth` array.
pool_url() { if [[ -n "${OMARCHY_BROKER:-}" ]]; then echo "${OMARCHY_BROKER%/}/pool$1"; else echo "$OMARCHY_API/api/v1$1"; fi; }
pool_auth() { auth=(); [[ -n "${OMARCHY_BROKER:-}" ]] || auth=(-H "authorization: Bearer $OMARCHY_WORKER_TOKEN"); }
api() { # method path [json]
  local method="$1" path="$2" body="${3:-}"
  local -a auth; pool_auth
  curl -sS --fail-with-body --max-time 60 -X "$method" "$(pool_url "$path")" \
    "${auth[@]}" -H "content-type: application/json" \
    ${body:+--data "$body"} -w '\n%{http_code}'
}
# With a broker, the agent is spoken to in the Anthropic shape at the
# broker's address (any key; it never reads it) and GitHub through it.
if [[ -n "${OMARCHY_BROKER:-}" ]]; then
  export FACTORY_PROVIDER=anthropic ANTHROPIC_BASE_URL="${OMARCHY_BROKER%/}" ANTHROPIC_API_KEY=via-broker GITHUB_API="${OMARCHY_BROKER%/}/github"
fi
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

hold_secrets
case "${1:-}" in
  --inside) inside ;;
  --container) container_worker ;;
  *) echo "usage: $0 --inside | --container (project workers run 'pkg-repo work', which calls --inside)" >&2; exit 2 ;;
esac
