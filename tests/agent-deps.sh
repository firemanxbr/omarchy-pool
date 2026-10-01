#!/usr/bin/env bash
# The agent's trusted core keeps few dependencies (design v2 §11.3, #309): no
# async runtime, no HTTP stack beyond `ureq` (blocking, rustls on ring: the run
# loop's client, #315), no Docker API client (the run loop runs the pinned
# docker CLI and compose plugin) and no OpenSSL anywhere in omarchy-agent's
# tree, on any platform. CI runs it (ci.yml); by hand: `bash tests/agent-deps.sh`.
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

tree="$(cargo tree --locked -p omarchy-agent -e normal,build --target all --prefix none --format '{p}')"
banned='^(tokio|async-std|smol|futures-executor|reqwest|hyper|hyper-util|bollard|openssl|openssl-sys|native-tls) '
if found="$(grep -E "$banned" <<<"$tree" | sort -u)" && [[ -n "$found" ]]; then
  echo "omarchy-agent pulls in what its core must not carry:"
  sed 's/^/  /' <<<"$found"
  exit 1
fi
echo "omarchy-agent: $(sort -u <<<"$tree" | wc -l | tr -d ' ') crates, no async runtime, HTTP stack but ureq, Docker client or OpenSSL"
