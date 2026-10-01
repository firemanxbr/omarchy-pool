#!/usr/bin/env bash
# factory/bundle/install.sh (#311), rendered as factory/bin/host-bundle renders
# it, run by every POSIX shell here (sh, dash, bash --posix, busybox sh) with a
# stubbed download, uname and id:
#
# - it refuses root and changes nothing;
# - it refuses a token on the command line (OMARCHY_ENROLL rides the
#   environment);
# - it rejects a binary whose SHA-256 is not the embedded one, installs
#   nothing and leaves no download behind;
# - it downloads into a fresh mktemp -d under the agent's data directory,
#   never a predictable /tmp path, and writes nothing to TMPDIR;
# - it installs versions/<agent version>/omarchy-agent, points current at it
#   and runs `omarchy-agent install` with the options given and OMARCHY_ENROLL
#   in the environment, never in argv;
# - it picks the asset of each platform and refuses one with no agent;
# - a truncated download runs nothing (everything is inside main).
#
# shellcheck checks it when installed. By hand: bash tests/install-sh.sh
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
n=0
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# The release's binaries: a stand-in agent per platform that records how it was run.
mkdir -p "$tmp/release" "$tmp/stub"
for asset in omarchy-agent-x86_64-linux-musl omarchy-agent-aarch64-linux-musl omarchy-agent-aarch64-darwin; do
  cat > "$tmp/release/$asset" <<EOF
#!/bin/sh
{ echo "asset=$asset"; echo "argv=\$*"; echo "enroll=\${OMARCHY_ENROLL:-}"; } > "\$RECORD"
EOF
done
printf '#!/bin/sh\necho tampered\n' > "$tmp/release/tampered"
sed -e 's/@RELEASE@/v1.2.3/' -e 's/@AGENT_VERSION@/0.4.0/' \
    -e "s/@SHA256_X86_64_LINUX@/$(sha256 "$tmp/release/omarchy-agent-x86_64-linux-musl")/" \
    -e "s/@SHA256_AARCH64_LINUX@/$(sha256 "$tmp/release/omarchy-agent-aarch64-linux-musl")/" \
    -e "s/@SHA256_AARCH64_DARWIN@/$(sha256 "$tmp/release/omarchy-agent-aarch64-darwin")/" \
    "$root/factory/bundle/install.sh" > "$tmp/install.sh"
! grep -q '@[A-Z][A-Z0-9_]*@' "$tmp/install.sh" || fail "a placeholder left: $(grep '@[A-Z_]*@' "$tmp/install.sh")"

# Stubs: uname and id answer what the case asks; curl serves the release from disk
# (or the tampered binary) and records where it was told to write.
cat > "$tmp/stub/uname" <<'EOF'
#!/bin/sh
case "$1" in -s) echo "${STUB_OS:-Linux}" ;; -m) echo "${STUB_ARCH:-x86_64}" ;; *) echo "${STUB_OS:-Linux}" ;; esac
EOF
cat > "$tmp/stub/id" <<'EOF'
#!/bin/sh
[ "$1" = -u ] && { echo "${STUB_UID:-1000}"; exit 0; }
exit 1
EOF
cat > "$tmp/stub/curl" <<'EOF'
#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
echo "$out $url" >> "$CURL_LOG"
src="$RELEASE_DIR/${STUB_SERVE:-${url##*/}}"
[ -f "$src" ] || exit 22
cp "$src" "$out"
EOF
chmod +x "$tmp/stub/"* "$tmp/release/"*

shells=(sh dash "bash --posix")
# busybox sh, unless it is built to prefer its own applets over PATH (the stubs would not run).
if command -v busybox >/dev/null; then
  if [[ "$(PATH="$tmp/stub:$PATH" busybox sh -c 'uname -s' 2>/dev/null)" == Linux ]] && \
     [[ "$(PATH="$tmp/stub:$PATH" STUB_OS=Stub busybox sh -c 'uname -s' 2>/dev/null)" == Stub ]]; then
    shells+=("busybox sh")
  else
    echo "skip: this busybox sh runs its own applets before PATH"
  fi
fi

case_dir() { rm -rf "$tmp/case"; mkdir -p "$tmp/case/home" "$tmp/case/tmpdir"; : > "$tmp/case/curl.log"; }
run() { # shell, then env assignments and args after --
  local shell="$1"; shift
  local envs=()
  while [[ "$1" != -- ]]; do envs+=("$1"); shift; done; shift
  # shellcheck disable=SC2086
  env -i PATH="$tmp/stub:$PATH" HOME="$tmp/case/home" TMPDIR="$tmp/case/tmpdir" RECORD="$tmp/case/record" \
    CURL_LOG="$tmp/case/curl.log" RELEASE_DIR="$tmp/release" ${envs[@]+"${envs[@]}"} \
    $shell "$tmp/install.sh" "$@" > "$tmp/case/out" 2>&1
}
data="$tmp/case/home/.local/share/omarchy-agent"

for shell in "${shells[@]}"; do
  command -v "${shell%% *}" >/dev/null || { echo "skip: no ${shell%% *}"; continue; }

  case_dir
  if run "$shell" STUB_UID=0 --; then fail "$shell: root was not refused"; fi
  grep -qF "refusing to run as root" "$tmp/case/out" || fail "$shell: the refusal says why: $(cat "$tmp/case/out")"
  [[ ! -e "$tmp/case/home/.local" && ! -s "$tmp/case/curl.log" ]] || fail "$shell: root: nothing downloaded or written"
  n=$((n + 1))

  case_dir
  if run "$shell" -- --token=ome_secret; then fail "$shell: a token in argv was not refused"; fi
  grep -qF "OMARCHY_ENROLL" "$tmp/case/out" || fail "$shell: the refusal points at OMARCHY_ENROLL: $(cat "$tmp/case/out")"
  n=$((n + 1))

  case_dir
  if run "$shell" STUB_SERVE=tampered --; then fail "$shell: a binary with the wrong SHA-256 was installed"; fi
  grep -qF "nothing was installed" "$tmp/case/out" || fail "$shell: the refusal says nothing was installed: $(cat "$tmp/case/out")"
  [[ ! -e "$data/versions" && ! -e "$data/current" ]] || fail "$shell: a rejected binary left versions/ or current"
  [[ -z "$(ls -A "$data")" ]] || fail "$shell: a rejected download left something behind: $(ls -A "$data")"
  [[ ! -e "$tmp/case/record" ]] || fail "$shell: a rejected binary ran"
  n=$((n + 1))

  case_dir
  run "$shell" OMARCHY_ENROLL=ome_secret -- --work-root /srv/omarchy-pool/host || fail "$shell: the install failed: $(cat "$tmp/case/out")"
  read -r out url < "$tmp/case/curl.log"
  [[ "$url" == "https://github.com/firemanxbr/omarchy-pool/releases/download/v1.2.3/omarchy-agent-x86_64-linux-musl" ]] \
    || fail "$shell: the release's own asset URL: $url"
  [[ "$out" =~ ^$data/download\.[A-Za-z0-9]{8}/omarchy-agent$ ]] || fail "$shell: the download goes to a mktemp -d under the data directory: $out"
  [[ -z "$(ls -A "$tmp/case/tmpdir")" ]] || fail "$shell: something was written to TMPDIR: $(ls -A "$tmp/case/tmpdir")"
  [[ "$(ls -A "$data" | tr '\n' ' ')" == "current versions " ]] || fail "$shell: the data directory holds current and versions only: $(ls -A "$data")"
  [[ -x "$data/versions/0.4.0/omarchy-agent" ]] || fail "$shell: versions/0.4.0/omarchy-agent, executable"
  [[ "$(readlink "$data/current")" == versions/0.4.0 ]] || fail "$shell: current points at versions/0.4.0: $(readlink "$data/current")"
  grep -qx "asset=omarchy-agent-x86_64-linux-musl" "$tmp/case/record" || fail "$shell: the installed agent ran"
  grep -qx "argv=install --work-root /srv/omarchy-pool/host" "$tmp/case/record" || fail "$shell: omarchy-agent install with the options given: $(cat "$tmp/case/record")"
  grep -qx "enroll=ome_secret" "$tmp/case/record" || fail "$shell: OMARCHY_ENROLL reaches the agent through the environment"
  ! grep -q "ome_secret" <<<"$(grep '^argv=' "$tmp/case/record")" || fail "$shell: the token is never in argv"
  n=$((n + 1))

  for platform in "Linux aarch64 omarchy-agent-aarch64-linux-musl" "Linux arm64 omarchy-agent-aarch64-linux-musl" \
                  "Darwin arm64 omarchy-agent-aarch64-darwin" "Linux amd64 omarchy-agent-x86_64-linux-musl"; do
    read -r os arch asset <<<"$platform"
    case_dir
    run "$shell" STUB_OS="$os" STUB_ARCH="$arch" -- || fail "$shell: $os $arch: $(cat "$tmp/case/out")"
    grep -qx "asset=$asset" "$tmp/case/record" || fail "$shell: $os $arch installs $asset"
    n=$((n + 1))
  done
  case_dir
  if run "$shell" STUB_OS=Darwin STUB_ARCH=x86_64 --; then fail "$shell: an Intel Mac has no agent"; fi
  grep -qF "no agent for Darwin on x86_64" "$tmp/case/out" || fail "$shell: says which platform has no agent"
  n=$((n + 1))

  # A truncated download: every line but the last (main "$@") runs nothing.
  case_dir
  sed '$d' "$tmp/install.sh" > "$tmp/truncated.sh"
  env -i PATH="$tmp/stub:$PATH" HOME="$tmp/case/home" CURL_LOG="$tmp/case/curl.log" $shell "$tmp/truncated.sh" || fail "$shell: the truncated script failed"
  [[ ! -e "$tmp/case/home/.local" && ! -s "$tmp/case/curl.log" ]] || fail "$shell: a truncated install.sh did something"
  n=$((n + 1))
  echo "ok: $shell"
done

[[ "$(tail -n 1 "$root/factory/bundle/install.sh")" == 'main "$@"' ]] || fail "the last line calls main"
lines="$(grep -cvE '^\s*(#|$)' "$root/factory/bundle/install.sh")"
(( lines <= 90 )) || fail "install.sh stays small (about 80 lines of code): $lines"
if command -v shellcheck >/dev/null; then shellcheck -s sh "$root/factory/bundle/install.sh"; echo "ok: shellcheck"; else echo "skip: no shellcheck here"; fi
echo "INSTALL.SH OK ($n checks, $lines lines of code)"
