#!/usr/bin/env bash
# The gate's reading of namcap on a built package, and namcap's library map
# on aarch64 (2026-09-18: omarchy-cli 0.0.168 failed x86_64 on
# `dependency-detected-not-included libgcc` — Arch split gcc-libs in
# February 2026 and the gate exempted the old name, a package that owned no
# library — while a draft of the same package, also without depends=,
# passed aarch64, where namcap 3.6.0's `ldconfig -p` parser takes only
# `libc6,x86-64` as 64-bit and so maps no library at all).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
script="$root/factory/worker/omarchy-build-worker.sh"

awk '/^namcap_package_errors\(\)/,/^}/' "$script" > "$tmp/fn.sh"
awk '/^namcap_package_warnings\(\)/,/^}/' "$script" >> "$tmp/fn.sh"
awk '/^namcap_map_blind\(\)/,/^}/' "$script" >> "$tmp/fn.sh"
awk '/^namcap_sees_this_arch\(\)/,/^}/' "$script" >> "$tmp/fn.sh"
# shellcheck source=/dev/null
source "$tmp/fn.sh"

# --- what the gate weighs: glibc is the one dependency a recipe may leave out; the runtime's other names are Arch's, and a recipe lists them.
errors() { namcap_package_errors <<<"$1" | tr '\n' ' '; }
out="$(errors "omarchy-cli E: dependency-detected-not-included glibc (libraries-needed ['usr/lib/libc.so.6', 'usr/lib/ld-linux-aarch64.so.1'] ['usr/bin/omarchy-cli'])
omarchy-cli I: link-level-dependence libgcc in ['usr/lib/libgcc_s.so.1']
omarchy-cli W: library-no-package-associated libc.so.6 ['usr/bin/omarchy-cli']")"
[[ -z "$out" ]] || { echo "glibc cannot be uninstalled — not an error; I and W are not errors: $out"; exit 1; }
out="$(errors "omarchy-cli E: dependency-detected-not-included libgcc (libraries-needed ['usr/lib/libgcc_s.so.1'] ['usr/bin/omarchy-cli'])")"
[[ "$out" == *"not-included libgcc"* ]] || { echo "libgcc is the name Arch gives libgcc_s.so.1 — a recipe lists it (#505): '$out'"; exit 1; }
out="$(errors "a E: dependency-detected-not-included libstdc++ (libraries-needed ['usr/lib/libstdc++.so.6'] ['usr/bin/a'])
a E: dependency-detected-not-included gcc-libs (libraries-needed ['usr/lib/libgomp.so.1'] ['usr/bin/a'])
a E: dependency-detected-not-included libgomp (libraries-needed ['usr/lib/libgomp.so.1'] ['usr/bin/a'])")"
[[ "$out" == *"libstdc++"* && "$out" == *"gcc-libs"* && "$out" == *"libgomp"* ]] || { echo "libstdc++, libgomp, and the old gcc-libs are listed too: '$out'"; exit 1; }
out="$(errors "felix E: dependency-detected-not-included openssl (libraries-needed ['usr/lib/libssl.so.3'] ['usr/bin/felix'])")"
[[ "$out" == *"not-included openssl"* ]] || { echo "a library outside the runtime is a missing dependency: '$out'"; exit 1; }
out="$(errors "x E: dependency-detected-not-included glibc-locales (libraries-needed ['usr/lib/x.so'] ['usr/bin/x'])")"
[[ "$out" == *glibc-locales* ]] || { echo "the exemption is the whole name, not a prefix: '$out'"; exit 1; }
# ELF under /opt: namcap 3.6.0 says it per file as information and once as the error — the error is the one the gate sees.
out="$(errors "app I: elffile-not-in-allowed-dirs opt/app/app
app E: elffile-in-questionable-dirs opt/
app E: elffile-not-in-allowed-dirs usr/local/bin/app
app E: elffile-not-in-allowed-dirs usr/local/opt/app/helper")"
[[ "$out" != *" opt/"* && "$out" == *"usr/local/bin/app"* && "$out" == *"usr/local/opt/app/helper"* ]] || { echo "ELF under /opt passes; /usr/local does not, an opt/ deeper down neither: '$out'"; exit 1; }
out="$(errors "y E: dangling-symlink usr/lib/debug
y W: file-world-writable usr/bin/y")"
[[ "$out" == "y E: dangling-symlink usr/lib/debug " ]] || { echo "an error is an error, a warning is not one: '$out'"; exit 1; }
out="$(errors "clean I: depends-by-namcap-sight depends=()")"
[[ -z "$out" ]] || { echo "nothing to weigh yields nothing (and the function must not fail the caller): '$out'"; exit 1; }

# --- the warnings: the loader's unused-sodepend is the linker's, every other one is the package's.
warnings() { namcap_package_warnings <<<"$1" | tr '\n' ' '; }
out="$(warnings "omarchy-cli W: unused-sodepend /usr/lib64/ld-linux-x86-64.so.2 usr/bin/omarchy-cli
omarchy-cli W: unused-sodepend /usr/lib/ld-linux-aarch64.so.1 usr/bin/omarchy-cli
omarchy-cli I: link-level-dependence glibc in ['usr/lib/libc.so.6']")"
[[ -z "$out" ]] || { echo "ld-linux is NEEDED by every binary and never 'used': not the recipe's warning: '$out'"; exit 1; }
out="$(warnings "x W: unused-sodepend /usr/lib/libfoo.so.1 usr/bin/x
x W: elffile-unstripped usr/lib/x/x")"
[[ "$out" == *"libfoo.so.1"* && "$out" == *"elffile-unstripped"* ]] || { echo "an unused library, and every other warning, is weighed: '$out'"; exit 1; }
out="$(warnings "clean I: depends-by-namcap-sight depends=()")"
[[ -z "$out" ]] || { echo "no warning yields nothing (and the function must not fail the caller): '$out'"; exit 1; }

# --- a libc without a package is the map, not the package (what #506 got on aarch64).
namcap_map_blind <<<"omarchy-cli W: library-no-package-associated libc.so.6 ['usr/bin/omarchy-cli']
omarchy-cli W: library-no-package-associated libgcc_s.so.1 ['usr/bin/omarchy-cli']" || { echo "no package for libc.so.6: the map is blind"; exit 1; }
namcap_map_blind <<<"x W: library-no-package-associated ld-linux-aarch64.so.1 ['usr/bin/x']" || { echo "no package for the loader: the map is blind"; exit 1; }
! namcap_map_blind <<<"x W: library-no-package-associated libfoo.so.1 ['usr/bin/x']
x I: link-level-dependence glibc in ['usr/lib/libc.so.6']" || { echo "one unmapped library with libc mapped is the package's own finding, not a blind map"; exit 1; }
! namcap_map_blind <<<"" || { echo "nothing said, nothing blind"; exit 1; }

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
echo "ok: the gate weighs namcap's errors and warnings, knows a blind map, and namcap's library map sees aarch64"
