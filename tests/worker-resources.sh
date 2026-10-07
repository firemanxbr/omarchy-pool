#!/usr/bin/env bash
# What a build's resources.json says of its memory (factory/worker/omarchy-build-worker.sh
# resources_begin, resources_end, #330, D31): run here, the script's own functions, in a
# container at a 384 MB memory limit, around a "build" that reads 1 GB of files — page cache
# the container keeps up to its limit — and holds about 64 MB of shared memory (a tmpfs file)
# and 50 MB of its own for three seconds, all of it given back before resources_end.
# ram_anon_peak_mb, the peak the pool's size learning reads, says what was held (the sampler
# saw it: nothing is held at the end) and not the files; ram_peak_mb, the cgroup's high-water
# mark the build's page shows, counted the page cache up to the limit wherever the kernel keeps
# one (cgroup v2's memory.peak from 5.19, v1's max_usage_in_bytes).
#
# The files are one sparse file, read: page cache that is clean, which reclaim frees the moment
# the container needs the room, on any kernel. Not 1 GB written through the container: that
# page cache is dirty until the disk takes it — 371 MB of the 384 at once on a cgroup v1 host —
# and only v1's reclaim waits for writeback; v2's does not (mm/vmscan.c, "legacy memcg"), so
# where the disk is slower than the writer the container is OOM-killed before anything is
# measured (GitHub's ubuntu-24.04, cgroup v2: exit 137).
#
# Requires: docker or podman, jq, a TMPDIR on a disk (tmpfs keeps no page cache of a sparse
# file). STUB_IMAGE: an image with bash and coreutils (default debian:stable-slim).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="${RUNTIME:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
STUB_IMAGE="${STUB_IMAGE:-docker.io/library/debian:stable-slim}"
script="$root/factory/worker/omarchy-build-worker.sh"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
name="worker-resources-$$"
# What the container wrote is root's: removed through the image when the runner's user cannot.
trap '"$RT" rm -f "$name" >/dev/null 2>&1; rm -rf "$tmp" 2>/dev/null || "$RT" run --rm -v "$tmp:$tmp" "$STUB_IMAGE" sh -c "rm -rf $tmp/build" >/dev/null 2>&1; rm -rf "$tmp" 2>/dev/null || true' EXIT
fail() { echo "worker-resources: FAIL — $*" >&2; exit 1; }
"$RT" image inspect "$STUB_IMAGE" >/dev/null 2>&1 || "$RT" pull -q "$STUB_IMAGE" >/dev/null

# The script's own lines: its variables and the three functions, each to its closing brace at column 0.
grep '^RES_JSON=' "$script" > "$tmp/fn.sh"
for f in ram_anon resources_begin resources_end; do
  awk -v f="$f" 'index($0, f "() {") == 1 { on = 1 } on { print } on && /^}/ { exit }' "$script" >> "$tmp/fn.sh"
  grep -q "^$f() {" "$tmp/fn.sh" || fail "no $f in the worker script"
done
mkdir -p "$tmp/build"

# The build, as the container's own shell reads it (its $ are its own). Each step names itself in
# /build/step, so a container that dies says where, and the engine says whether its memory limit killed it.
rc=0
# shellcheck disable=SC2016
"$RT" run --name "$name" --memory 384m --memory-swap 384m --tmpfs /scratch:size=128m -v "$tmp/fn.sh:/fn.sh:ro" -v "$tmp/build:/build" "$STUB_IMAGE" bash -c '
  set -euo pipefail
  source /fn.sh
  mkdir -p /build/pkg /build/out /build/cache
  echo resources_begin > /build/step; resources_begin
  # The files: 1 GB read through a 384 MB container, from a sparse file, so no page of it is ever dirty.
  echo "the files" > /build/step
  truncate -s 1G /build/pkg/sources
  cat /build/pkg/sources > /dev/null
  rm -f /build/pkg/sources
  # What it holds for three seconds, then gives back: 64 MB of shared memory and 50 MB of its own.
  echo "what it holds" > /build/step
  dd if=/dev/zero of=/scratch/held bs=1M count=64 status=none
  ( held=$(head -c 50000000 /dev/zero | tr "\0" a); sleep 3; : "${#held}" )
  rm -f /scratch/held
  echo resources_end > /build/step; resources_end
' || rc=$?
(( rc == 0 )) || fail "the container exited $rc in its step \"$(cat "$tmp/build/step" 2>/dev/null || echo none)\" (killed by its memory limit: $("$RT" inspect --format '{{.State.OOMKilled}}' "$name" 2>/dev/null || echo unknown))"
"$RT" rm "$name" >/dev/null

res="$tmp/build/resources.json"
[[ -f "$res" ]] || fail "no resources.json"
jq -e '.schema == "omarchy-pool/resources/1" and ([.wall_s, .cpu_s, .ram_peak_mb, .ram_anon_peak_mb, .disk_mb, .cores] | all(type == "number" and . >= 0 and . == floor))' "$res" >/dev/null \
  || fail "resources.json does not read: $(cat "$res")"
anon="$(jq -r .ram_anon_peak_mb "$res")"; peak="$(jq -r .ram_peak_mb "$res")"
(( anon >= 100 )) || fail "ram_anon_peak_mb $anon: the sampler missed the 114 MB held for three seconds ($(cat "$res"))"
(( anon <= 260 )) || fail "ram_anon_peak_mb $anon counts the page cache of 1 GB of files ($(cat "$res"))"
if (( peak > 0 )); then
  (( peak >= 320 )) || fail "ram_peak_mb $peak: 1 GB of files through a 384 MB container did not fill its page cache, so this test proves nothing — is TMPDIR on tmpfs? ($(cat "$res"))"
  echo "ok: the high-water mark counted the page cache ($peak MB of 384), the size learning's peak did not ($anon MB)"
else
  echo "ok: the size learning's peak says what was held ($anon MB), not the page cache (this kernel keeps no high-water mark)"
fi
