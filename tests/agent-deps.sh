#!/usr/bin/env bash
# The agent's trusted core keeps few dependencies (design v2 §11.3, #309): no
# async runtime, no HTTP stack, no Docker API client and no OpenSSL anywhere
# in omarchy-agent's tree, on any platform. `ureq` with rustls arrives with the
# run loop (P1) and belongs on this list's other side. CI runs it (ci.yml);
# by hand: `bash tests/agent-deps.sh`.
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

tree="$(cargo tree --locked -p omarchy-agent -e normal,build --target all --prefix none --format '{p}')"
banned='^(tokio|async-std|smol|futures-executor|reqwest|hyper|hyper-util|bollard|openssl|openssl-sys|native-tls) '
if found="$(grep -E "$banned" <<<"$tree" | sort -u)" && [[ -n "$found" ]]; then
  echo "omarchy-agent pulls in what its core must not carry:"
  sed 's/^/  /' <<<"$found"
  exit 1
fi
echo "omarchy-agent: $(sort -u <<<"$tree" | wc -l | tr -d ' ') crates, no async runtime, HTTP stack, Docker client or OpenSSL"
