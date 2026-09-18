#!/usr/bin/env bash
# What the tree may not carry: a tracked file an ignore rule covers, or a file
# a tool writes for one machine or one person — Wrangler's caches and local
# secrets, the desktop's launchers, a token saved beside the checkout. #107 put
# Wrangler's account cache in the tree and no check noticed until #211; this
# is the gate for that lesson. CI runs it on every pull request (ci.yml); by
# hand: `bash tests/tracked-tree.sh`.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

fail=0
hidden="$(git ls-files -i -c --exclude-standard)"
if [[ -n "$hidden" ]]; then
  echo "tracked, although an ignore rule covers it:"; sed 's/^/  /' <<<"$hidden"; fail=1
fi

# One machine's or one person's: Wrangler's state and caches, its local secrets
# (.dev.vars, .env and their per-environment variants; the .example files are
# for everyone), macOS folder metadata, a GitHub token saved as a file, the
# desktop app's launchers, an installed node_modules.
one_machine='(^|/)(\.wrangler/|\.dev\.vars|\.env($|\.)|\.DS_Store$|github-token$|launch\.json$|node_modules/)'
stray="$(git ls-files | grep -E "$one_machine" | grep -v -E '\.example$' || true)"
if [[ -n "$stray" ]]; then
  echo "tracked, although it belongs to one machine or holds a secret:"; sed 's/^/  /' <<<"$stray"; fail=1
fi

(( fail == 0 )) && echo "tracked tree: clean ($(git ls-files | wc -l | tr -d ' ') files)"
exit "$fail"
