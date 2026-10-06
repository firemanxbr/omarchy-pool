#!/bin/sh
# prep-mac.sh: what a Mac needs once before `omarchy-agent install` (#320,
# design v2 §19.2, decision D11). No sudo, ever: run it as the user the agent
# will run as.
#
#   sh factory/host/prep-mac.sh [--root <dir>] [--dry-run]
#
# - Colima and Lima from Homebrew, and nothing else from it: the docker CLI
#   and the compose plugin are the release's pinned Darwin binaries, which the
#   agent fetches itself (D21). Homebrew itself is the person's to install.
# - The three directories the agent's `omarchy` VM mounts at their own paths
#   — the work root (writable), the secrets and the set directories (read-only)
#   — under <root> (default /Users/Shared/omarchy-pool), each 0700: outside the
#   home directory, which the VM never mounts (a root under it is refused).
# - It says whether Rosetta 2 is installed (an x86_64 lane through Rosetta;
#   installing it is an administrator's `softwareupdate --install-rosetta`),
#   and whether Docker Desktop or OrbStack is here: used only if you choose
#   it, never installed (their licence terms: the runbook's Installing a Mac).
#
# The agent creates, starts, stops and sizes the VM itself (M7); this script
# never starts it. OMARCHY_PREP_FS (tests only) prefixes the system paths it
# reads and the default root.
set -eu

FS="${OMARCHY_PREP_FS:-}"
ROSETTA="$FS/Library/Apple/usr/libexec/oah/libRosettaRuntime"

say() { printf 'prep-mac: %s\n' "$*"; }
die() { printf 'prep-mac: %s\n' "$*" >&2; exit 2; }

main() {
  root="$FS/Users/Shared/omarchy-pool"
  dry=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --root) [ $# -ge 2 ] || die "--root needs a directory"; root="$2"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
      *) die "unknown option $1 (--root <dir>, --dry-run)" ;;
    esac
  done

  [ "$(id -u)" != 0 ] || die "refusing to run as root: no sudo; run this as the user the agent will run as"
  [ "$(uname -s)" = Darwin ] || die "this is $(uname -s): prep-mac.sh is for a Mac (Linux hosts have factory/host/prep-root.sh)"
  case "$(uname -m)" in
    arm64 | aarch64) ;;
    *) die "this Mac is $(uname -m): the agent runs on Apple silicon (arm64) only" ;;
  esac
  major="$(sw_vers -productVersion | cut -d. -f1)"
  [ "${major:-0}" -ge 13 ] 2>/dev/null || die "macOS $(sw_vers -productVersion): the omarchy VM (vz, virtiofs, Rosetta) needs macOS 13 or later"
  [ -n "${HOME:-}" ] || die "HOME is not set"
  case "$root" in
    /*) ;;
    *) die "--root $root is not an absolute path" ;;
  esac
  case "$root" in
    *:* | *,*) die "--root $root holds ':' or ',', which Colima's --mount cannot carry" ;;
  esac
  case "$(printf '%s' "$root/" | tr '[:upper:]' '[:lower:]')" in
    "$(printf '%s' "$HOME/" | tr '[:upper:]' '[:lower:]')"*)
      die "--root $root is under your home directory: the omarchy VM mounts no part of it" ;;
  esac
  case "$(printf '%s' "$HOME/" | tr '[:upper:]' '[:lower:]')" in
    "$(printf '%s' "$root/" | tr '[:upper:]' '[:lower:]')"*)
      die "--root $root holds your home directory: the omarchy VM mounts no part of it" ;;
  esac

  # The directories already there: the user's own, never a link (checked before anything
  # is installed or made).
  for d in "$root" "$root/work" "$root/secrets" "$root/set"; do
    if [ -L "$d" ]; then
      die "$d is a symbolic link: refused (the VM would mount what it points at)"
    elif [ -d "$d" ]; then
      owner="$(stat -f %Su "$d")"
      [ "$owner" = "$(id -un)" ] || die "$d belongs to $owner, not $(id -un): use another --root"
    fi
  done

  # Colima and Lima, from Homebrew.
  brew="$(command -v brew || true)"
  [ -n "$brew" ] || { [ -x "$FS/opt/homebrew/bin/brew" ] && brew="$FS/opt/homebrew/bin/brew"; }
  [ -n "$brew" ] || die "Homebrew is not installed: install it (https://brew.sh), then run this again; it installs Colima and Lima only"
  missing=""
  for f in colima lima; do
    "$brew" list --formula "$f" >/dev/null 2>&1 || missing="$missing $f"
  done
  if [ -z "$missing" ]; then
    say "Colima and Lima are installed ($brew)"
  elif [ -n "$dry" ]; then
    say "would run: $brew install$missing"
  else
    say "installing$missing with Homebrew"
    # shellcheck disable=SC2086 # the formula names, one word each
    "$brew" install $missing
  fi

  # The three directories, 0700, the user's own.
  umask 077
  for d in "$root" "$root/work" "$root/secrets" "$root/set"; do
    if [ -d "$d" ]; then
      [ -n "$dry" ] || chmod 700 "$d"
    elif [ -n "$dry" ]; then
      say "would make $d (0700)"
    else
      # Under umask 077 a missing parent of --root is 0700 too.
      mkdir -p "$d"
      chmod 700 "$d"
    fi
  done
  say "work root $root/work, secrets $root/secrets, set directory $root/set: the only directories the omarchy VM mounts"

  if [ -e "$ROSETTA" ]; then
    say "Rosetta 2 is installed: the VM gets an x86_64 lane through it (install --no-rosetta leaves it off)"
  else
    say "Rosetta 2 is not installed: no x86_64 lane; an administrator adds it with 'softwareupdate --install-rosetta --agree-to-license'"
  fi
  for app in Docker OrbStack; do
    if [ -d "$FS/Applications/$app.app" ]; then
      say "$app is here: the agent uses the omarchy Colima VM, never installs $app, and takes it (vm-shared) only with --socket <its socket> --dedicated and its home mount removed; its licence terms are yours (the runbook's Installing a Mac)"
    fi
  done

  flags=""
  [ "$root" = "$FS/Users/Shared/omarchy-pool" ] || flags=" --work-root $root/work --secrets-dir $root/secrets --set-dir $root/set"
  if [ -n "$dry" ]; then
    say "done (dry run: nothing was changed)"
  else
    say "done. Next, from Terminal on this Mac (a LaunchAgent is login-scoped): the command your page prints, with '| OMARCHY_ENROLL=ome_… sh -s --$flags'"
  fi
}

main "$@"
