#!/usr/bin/env bash
# The agent's trusted core keeps few dependencies (design v2 §11.3, #309): no
# async runtime, no HTTP stack, no Docker API client (the run loop runs the
# pinned docker CLI and compose plugin, #315) and no OpenSSL anywhere in
# omarchy-agent's tree, on any platform. Its HTTPS to the pool and GitHub
# (#321, #315) is blocking `ureq` on rustls with the aws-lc-rs provider the
# verifier already carries, so `ring` is not in it either. CI runs it
# (ci.yml); by hand: `bash tests/agent-deps.sh`.
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

tree="$(cargo tree --locked -p omarchy-agent -e normal,build --target all --prefix none --format '{p}')"
banned='^(tokio|async-std|smol|futures-executor|reqwest|hyper|hyper-util|bollard|openssl|openssl-sys|native-tls|ring) '
if found="$(grep -E "$banned" <<<"$tree" | sort -u)" && [[ -n "$found" ]]; then
  echo "omarchy-agent pulls in what its core must not carry:"
  sed 's/^/  /' <<<"$found"
  exit 1
fi
echo "omarchy-agent: $(sort -u <<<"$tree" | wc -l | tr -d ' ') crates, no async runtime, async HTTP stack, Docker client, OpenSSL or ring"
