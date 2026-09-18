#!/usr/bin/env bash
# The gate's reading of namcap on a built package, and namcap's library map
# on aarch64 (2026-09-18: omarchy-cli 0.0.168 failed x86_64 on
# `dependency-detected-not-included libgcc` — Arch split gcc-libs and the
# gate's exemption named the old package — while the same recipe passed
# aarch64, where namcap's `ldconfig -p` parser takes only `libc6,x86-64` as
# 64-bit and so maps no library at all).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
script="$root/factory/worker/omarchy-build-worker.sh"

awk '/^namcap_package_errors\(\)/,/^}/' "$script" > "$tmp/fn.sh"
awk '/^namcap_sees_this_arch\(\)/,/^}/' "$script" >> "$tmp/fn.sh"
# shellcheck source=/dev/null
source "$tmp/fn.sh"

# --- what the gate weighs: the C and C++ runtime is not a missing dependency; everything else namcap calls an error is one.
errors() { namcap_package_errors <<<"$1" | tr '\n' ' '; }
out="$(errors "omarchy-cli E: dependency-detected-not-included libgcc (libraries-needed ['usr/lib/libgcc_s.so.1'] ['usr/bin/omarchy-cli'])
omarchy-cli E: dependency-detected-not-included glibc (libraries-needed ['usr/lib/libc.so.6', 'usr/lib/ld-linux-aarch64.so.1'] ['usr/bin/omarchy-cli'])
omarchy-cli E: dependency-detected-not-included gcc-libs (libraries-needed ['usr/lib/libstdc++.so.6'] ['usr/bin/a'])
omarchy-cli E: dependency-detected-not-included libstdc++ (libraries-needed ['usr/lib/libstdc++.so.6'] ['usr/bin/a'])
omarchy-cli I: link-level-dependence libgcc in ['usr/lib/libgcc_s.so.1']
omarchy-cli W: library-no-package-associated libc.so.6 ['usr/bin/omarchy-cli']")"
[[ -z "$out" ]] || { echo "glibc, gcc-libs, libgcc and libstdc++ come with base — not errors: $out"; exit 1; }
out="$(errors "felix E: dependency-detected-not-included openssl (libraries-needed ['usr/lib/libssl.so.3'] ['usr/bin/felix'])")"
[[ "$out" == *"not-included openssl"* ]] || { echo "a library outside the runtime is a missing dependency: '$out'"; exit 1; }
out="$(errors "x E: dependency-detected-not-included libgccjit (libraries-needed ['usr/lib/libgccjit.so.0'] ['usr/bin/x'])
x E: dependency-detected-not-included glibc-locales (libraries-needed ['usr/lib/x.so'] ['usr/bin/x'])")"
[[ "$out" == *libgccjit* && "$out" == *glibc-locales* ]] || { echo "the exemption is the whole name, not a prefix: '$out'"; exit 1; }
out="$(errors "app E: elffile-not-in-allowed-dirs opt/app/app
app E: elffile-not-in-allowed-dirs usr/local/bin/app")"
[[ "$out" != *"opt/app"* && "$out" == *"usr/local/bin/app"* ]] || { echo "ELF under /opt passes, /usr/local does not: '$out'"; exit 1; }
out="$(errors "y E: dangling-symlink usr/lib/debug
y W: file-world-writable usr/bin/y")"
[[ "$out" == "y E: dangling-symlink usr/lib/debug " ]] || { echo "an error is an error, a warning is not one: '$out'"; exit 1; }
out="$(errors "clean I: depends-by-namcap-sight depends=()")"
[[ -z "$out" ]] || { echo "nothing to weigh yields nothing (and the function must not fail the caller): '$out'"; exit 1; }

# --- namcap's library map: the aarch64 tag is 64-bit too (the parser as namcap 3.6.0 ships it).
if ! sed --version >/dev/null 2>&1; then # a developer's BSD sed: the function runs in the Arch container, GNU
  mkdir -p "$tmp/bin"; printf '#!/usr/bin/env bash\nif [[ "$1" == -i ]]; then shift; exec /usr/bin/sed -i "" "$@"; fi\nexec /usr/bin/sed "$@"\n' > "$tmp/bin/sed"; chmod +x "$tmp/bin/sed"; PATH="$tmp/bin:$PATH"
fi
cat > "$tmp/sodepends.py" <<'PY'
        g = libline.match(j)
        if g is not None:
            if g.group(2).startswith("libc6,x86-64"):
                libcache["x86-64"][g.group(1)] = g.group(3)
            else:
                # TODO: This is bogus; what do non x86-architectures print?
                libcache["i686"][g.group(1)] = g.group(3)
PY
namcap_sees_this_arch "$tmp/sodepends.py" || { echo "namcap 3.6.0's parser is the one the fix knows"; exit 1; }
grep -q 'startswith(("libc6,x86-64", "libc6,AArch64"))' "$tmp/sodepends.py" || { echo "the one line: $(grep startswith "$tmp/sodepends.py")"; exit 1; }
python3 -c "import ast,sys; ast.parse('if True:\n' + open(sys.argv[1]).read())" "$tmp/sodepends.py" 2>/dev/null || { echo "what the fix writes must still be Python"; exit 1; }
before="$(cat "$tmp/sodepends.py")"
namcap_sees_this_arch "$tmp/sodepends.py" || { echo "already patched: fine, once"; exit 1; }
[[ "$(cat "$tmp/sodepends.py")" == "$before" ]] || { echo "a second run changes nothing"; exit 1; }
printf 'if g.group(2).endswith(",x86-64"):\n' > "$tmp/other.py"
! namcap_sees_this_arch "$tmp/other.py" || { echo "a parser the fix does not know is reported, not patched blind"; exit 1; }
[[ "$(cat "$tmp/other.py")" == 'if g.group(2).endswith(",x86-64"):' ]] || { echo "an unknown parser is left as it is"; exit 1; }
! namcap_sees_this_arch "$tmp/missing.py" || { echo "no file, no map: reported"; exit 1; }
echo "ok: the gate weighs namcap's errors and namcap's library map sees aarch64"
