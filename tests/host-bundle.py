#!/usr/bin/env python3
"""factory/bin/host-bundle, the writer of the signed host bundle (#311):

- the worker image as the manifest lists it: the index, each platform's
  manifest and config digest, each checked against the image the release
  pushed for that architecture (a stubbed registry);
- the manifest: the frozen outer layer with the three agent binaries, inner
  schema 3 with the build images by digest, every capacity constant of design
  v2 §4.4, the tools the worker image pins, and a hash per host-set file;
- the host set rendered: no placeholder left, the images by digest;
- the archive reproducible (the same inputs, the same bytes), install.sh
  rendered with the release, the agent version and the three SHA-256;
- every refusal: a min_release or min_agent above what is cut, a release that
  revokes itself, a build image by tag, an unknown placeholder, a misspelt
  policy key, a missing agent binary, a tool whose download does not match;
- and the agent's own parser (cargo test --ignored a_bundle_the_release_writes)
  reads the bundle whole, and the probe with one more outer field.

Needs python3 3.11+ and, for the last step, cargo (skipped without it).
Run: python3 tests/host-bundle.py"""
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import gzip
import tomllib
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
hb = SourceFileLoader("host_bundle", str(ROOT / "factory/bin/host-bundle")).load_module()

checks = 0


def ok(cond, what):
    global checks
    if not cond:
        sys.exit(f"FAIL: {what}")
    checks += 1


def refused(fn, needle, what):
    global checks
    try:
        fn()
    except hb.BundleError as e:
        if needle not in str(e):
            sys.exit(f"FAIL: {what}: refused, but for {e!r} (wanted {needle!r})")
        checks += 1
        return
    sys.exit(f"FAIL: {what}: not refused")


def d(c):
    return "sha256:" + c * 64


REPO = "ghcr.io/firemanxbr/omarchy-worker"
INDEX, ARM_M, ARM_C, X86_M, X86_C = d("1"), d("2"), d("3"), d("4"), d("5")
ARM_BUILD = "docker.io/menci/archlinuxarm@" + d("a")
X86_BUILD = "docker.io/library/archlinux@" + d("b")


# --- the worker image, against a stubbed registry ------------------------------------
def registry(**over):
    digests = {f"{REPO}:v1.2.3": INDEX}
    digests.update(over.pop("digests", {}))
    manifests = over.pop("manifests", [
        {"digest": ARM_M, "platform": {"os": "linux", "architecture": "arm64"}},
        {"digest": X86_M, "platform": {"os": "linux", "architecture": "amd64"}},
        {"digest": d("9"), "platform": {"os": "unknown", "architecture": "unknown"}},
    ])
    raw = {f"{REPO}@{INDEX}": {"manifests": manifests},
           f"{REPO}@{ARM_M}": {"config": {"digest": ARM_C}},
           f"{REPO}@{X86_M}": {"config": {"digest": X86_C}}}

    def inspect(ref, raw_=False, **kw):
        raw_ = raw_ or kw.get("raw", False)
        table = raw if raw_ else digests
        if ref not in table:
            raise hb.BundleError(f"{ref}: the registry did not answer")
        return table[ref]
    return lambda ref, raw=False: inspect(ref, raw)


PUSHED = {"aarch64": ARM_M, "x86_64": X86_M}


def worker_image(image=REPO, tag="v1.2.3", index=INDEX, pushed=PUSHED, **reg):
    return hb.worker_image(image, tag, index, pushed, inspect=registry(**reg))


worker = worker_image()
ok(worker == {"repo": REPO, "index": INDEX, "platforms": {"aarch64": {"manifest": ARM_M, "config": ARM_C},
                                                         "x86_64": {"manifest": X86_M, "config": X86_C}}},
   f"the worker image: index, then each platform's manifest and config ({worker})")
refused(lambda: worker_image(pushed={"aarch64": d("7"), "x86_64": X86_M}),
        "is not the image the release pushed for aarch64", "a platform manifest that is not the digest the leg pushed")
refused(lambda: worker_image(digests={f"{REPO}:v1.2.3": d("8")}), "it moved",
        "a version tag moved off the index worker-image-manifest signed (while host-bundle waited for review)")
refused(lambda: worker_image(index="latest"), "not a digest", "an index that is not a digest")
refused(lambda: worker_image(manifests=[{"digest": X86_M, "platform": {"os": "linux", "architecture": "amd64"}}]),
        "must carry linux/arm64 and linux/amd64", "an index without one architecture")
refused(lambda: worker_image(image=REPO + ":latest"), "without a tag", "a repository with a tag")
refused(lambda: worker_image(tag="latest"), "is not vX.Y.Z", "a tag that is not a release")
print("ok: the worker image by the digests the release made: index, platform manifest and config, a moved tag refused")

# --- a bundle ------------------------------------------------------------------------
tmp = Path(tempfile.mkdtemp())
try:
    agents = tmp / "agents"
    agents.mkdir()
    for platform, asset in hb.AGENTS.items():
        (agents / asset).write_bytes(f"agent for {platform}\n".encode())
    sums = {p: hashlib.sha256(f"agent for {p}\n".encode()).hexdigest() for p in hb.AGENTS}
    (tmp / "worker.json").write_text(json.dumps(worker))
    (tmp / "build-images.json").write_text(json.dumps({"aarch64": ARM_BUILD, "x86_64": X86_BUILD}))

    def args(out, **over):
        a = dict(release="v1.2.3", worker=tmp / "worker.json", build_images=tmp / "build-images.json",
                 agents=agents, out=tmp / out, created="2026-10-01T12:00:00Z", agent_version=None,
                 policy=hb.POLICY, sets=hb.SETS, probe=True)
        a.update(over)
        return SimpleNamespace(**a)

    hb.build(args("one"))
    hb.build(args("two"))
    name = "omarchy-host-v1.2.3.tar.gz"
    one = (tmp / "one" / name).read_bytes()
    ok(one == (tmp / "two" / name).read_bytes(), "two builds of the same inputs give the same bundle, byte for byte")
    ok((tmp / "one/probe" / name).exists(), "--probe writes the probe bundle")

    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(one))) as tar:
        members = tar.getmembers()
        files = {m.name: tar.extractfile(m).read() for m in members}
        ok(all(m.isreg() and m.mode == 0o644 and m.uid == 0 and m.gid == 0 and m.uname == "" for m in members),
           "plain files, one mode, owned by root")
    ok(sorted(files) == ["manifest.json", "sets/host/compose.yml", "sets/host/set.toml"],
       f"the archive holds the manifest and the host set's files, nothing else (README, .gitkeep stay out): {sorted(files)}")
    m = json.loads(files["manifest.json"])
    ok(m == json.loads((tmp / "one/manifest.json").read_text()), "manifest.json beside the bundle is the bundle's")

    # The outer layer, frozen.
    ok(list(m) == ["schema", "release", "created", "min_agent", "agent", "inner"], f"the outer keys: {list(m)}")
    ok((m["schema"], m["release"], m["created"]) == (2, "v1.2.3", "2026-10-01T12:00:00Z"), "schema 2, the release, created")
    agent_version = tomllib.loads((ROOT / "crates/omarchy-agent/Cargo.toml").read_text())["package"]["version"]
    ok(m["agent"]["version"] == agent_version and m["agent"]["urgent"] is False, "the agent's version, from its Cargo.toml")
    for platform, asset in hb.AGENTS.items():
        ok(m["agent"][platform] == {"sha256": sums[platform], "asset": asset}, f"agent.{platform}: its binary's SHA-256 and asset")
    print("ok: the outer layer: schema 2, release, created, min_agent, the three agent binaries by SHA-256")

    inner = m["inner"]
    policy = tomllib.loads(hb.POLICY.read_text())
    ok(list(inner) == ["schema", "min_release", "revoked", "pools", "images", "capacity", "tools", "runtimes", "sets"],
       f"the inner keys: {list(inner)}")
    ok(inner["schema"] == 3 and inner["runtimes"] == {}, "inner schema 3, no runtime yet")
    ok(inner["images"] == {"worker": worker, "build": {"aarch64": ARM_BUILD, "x86_64": X86_BUILD}},
       "the images: the worker by platform, the build images by digest")
    ok(all(re.fullmatch(r"https://[a-z0-9.-]+", p) for p in inner["pools"]) and inner["pools"], "pools: https origins")

    # Every capacity constant of design v2 §4.4.
    ok(inner["capacity"] == {
        "max_size": 4, "community_max_size": 2,
        "min": {"cpus": 4, "mem_gb": 8, "work_disk_gb": 60, "engine_disk_gb": 40},
        "reserve": {"cpus": 1, "mem_gb": 2},
        "unit": {"cpus": 1, "mem_gb": 2},
        "units": {"build_per_size": 2, "trial": 2, "audit": 1, "job": 1, "job_reserved": 1},
        "disk": {"build_gb_per_size": 20, "floor_gb": 10},
        "sidecars": {"egress": {"cpus": 0.1, "mem_mb": 64}, "agent": {"cpus": 0.25, "mem_mb": 256}},
        "emulated": {"share_when_native_waits": 0.5},
    }, f"inner.capacity carries every constant of design v2 §4.4: {inner['capacity']}")
    print("ok: inner: the images, every capacity constant, no runtime")

    # The tools: the versions and sums the worker image pins.
    cf = (ROOT / "factory/image/Containerfile").read_text()
    docker_v = re.search(r"^ARG DOCKER_CLI=(\S+)$", cf, re.M).group(1)
    # podman 4's "<nil>" gateway of a task network made through libpod (#372): docker's CLI
    # from 29 on cannot list or inspect it (the Containerfile's note at DOCKER_CLI).
    ok(int(docker_v.split(".")[0]) < 29,
       f"the docker CLI {docker_v} is below 29: from 29 on it cannot read podman 4's \"<nil>\" gateway of a task network (#372)")
    compose_v = re.search(r"^ARG COMPOSE=(\S+)$", cf, re.M).group(1)
    runs = [r for r in re.split(r"\n(?=RUN |ARG |COPY |ENV |LABEL )", cf) if r.startswith("RUN ")]
    def sums_in(marker):
        run = next(r for r in runs if marker in r)
        return dict(re.findall(r"(x86_64|aarch64)\) sum=([0-9a-f]{64})", run))
    docker_sums, compose_sums = sums_in("download.docker.com"), sums_in("docker/compose/releases")
    for arch in ("x86_64", "aarch64"):
        t = inner["tools"][f"{arch}-linux"]
        ok(t["docker"] == {"url": f"https://download.docker.com/linux/static/stable/{arch}/docker-{docker_v}.tgz",
                           "sha256": docker_sums[arch]}, f"{arch}-linux docker: the Containerfile's version and sum")
        ok(t["docker-compose"] == {"url": f"https://github.com/docker/compose/releases/download/{compose_v}/docker-compose-linux-{arch}",
                                   "sha256": compose_sums[arch]}, f"{arch}-linux compose: the Containerfile's version and sum")
    # A Mac's (#320): the same versions, built for Darwin (their sums are pinned in the
    # manifest alone; `host-bundle check-tools` downloads and checks every one).
    t = inner["tools"]["aarch64-darwin"]
    ok(t["docker"]["url"] == f"https://download.docker.com/mac/static/stable/aarch64/docker-{docker_v}.tgz"
       and re.fullmatch(r"[0-9a-f]{64}", t["docker"]["sha256"]), "aarch64-darwin docker: the Containerfile's version")
    ok(t["docker-compose"]["url"] == f"https://github.com/docker/compose/releases/download/{compose_v}/docker-compose-darwin-aarch64"
       and re.fullmatch(r"[0-9a-f]{64}", t["docker-compose"]["sha256"]), "aarch64-darwin compose: the Containerfile's version")
    ok(sorted(inner["tools"]) == ["aarch64-darwin", "aarch64-linux", "x86_64-linux"], f"tools for every platform an agent ships for: {sorted(inner['tools'])}")
    ok(inner["tools"] == policy["tools"], "the tools as factory/bundle/manifest.toml pins them")
    print(f"ok: the tools: docker {docker_v} and compose {compose_v}, the worker image's pins, and the same versions for a Mac")

    # The host set, rendered, each file by hash.
    compose = files["sets/host/compose.yml"].decode()
    ok(not re.search(r"@[A-Z][A-Z0-9_]*@", compose), "no placeholder left in compose.yml")
    ok(f"image: {REPO}@{INDEX}" in compose, "the dispatcher's image by the index digest")
    ok(f'OMARCHY_WORKER_IMAGE: "{REPO}@{INDEX}"' in compose, "the sidecars' image by the index digest")
    ok(f'OMARCHY_BUILD_IMAGE_AARCH64: "{ARM_BUILD}"' in compose and f'OMARCHY_BUILD_IMAGE_X86_64: "{X86_BUILD}"' in compose,
       "the build images by digest")
    template = (ROOT / "factory/sets/host/compose.yml").read_text()
    ok(compose == hb.render(template, worker, {"aarch64": ARM_BUILD, "x86_64": X86_BUILD}), "only the placeholders change")
    ok(files["sets/host/set.toml"] == (ROOT / "factory/sets/host/set.toml").read_bytes(), "set.toml as written")
    ok(inner["sets"] == {"host": {"files": {p.removeprefix("sets/host/"): "sha256:" + hashlib.sha256(b).hexdigest()
                                            for p, b in files.items() if p.startswith("sets/host/")}}},
       "sets.host: a hash per file, of the file the archive holds")
    print("ok: the host set rendered to digests, a hash per file")

    # install.sh.
    install = (tmp / "one/install.sh").read_text()
    ok(not re.search(r"@[A-Z][A-Z0-9_]*@", install), "no placeholder left in install.sh")
    ok(f"RELEASE='v1.2.3'" in install and f"AGENT_VERSION='{agent_version}'" in install, "install.sh: the release and the agent version")
    for var, platform in (("SHA256_X86_64_LINUX", "x86_64-linux"), ("SHA256_AARCH64_LINUX", "aarch64-linux"),
                          ("SHA256_AARCH64_DARWIN", "aarch64-darwin")):
        ok(f"{var}='{sums[platform]}'" in install, f"install.sh embeds {platform}'s SHA-256")
    print("ok: install.sh carries the release, the agent version and the three SHA-256")

    # The probe: one more outer field, nothing else.
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress((tmp / "one/probe" / name).read_bytes()))) as tar:
        pm = json.loads(tar.extractfile("manifest.json").read())
    extra = set(pm) - set(m)
    ok(len(extra) == 1 and {k: v for k, v in pm.items() if k not in extra} == m, "the probe adds one outer field and changes nothing else")
    print("ok: the probe bundle carries one more outer field")

    # --- refusals --------------------------------------------------------------------
    def policy_with(**over):
        text = hb.POLICY.read_text()
        for k, v in over.items():
            text, n = re.subn(rf"^{k} = .*$", f"{k} = {json.dumps(v)}", text, count=1, flags=re.M)
            ok(n == 1, f"the policy has {k}")
        path = tmp / "policy.toml"
        path.write_text(text)
        return path

    refused(lambda: hb.build(args("x", policy=policy_with(min_release="v1.2.4"))), "above the release being cut", "a min_release above the release")
    refused(lambda: hb.build(args("x", policy=policy_with(revoked=["v1.2.3"]))), "revokes itself", "a release that revokes itself")
    refused(lambda: hb.build(args("x", policy=policy_with(min_agent="99.0.0"))), "above the agent this release ships", "a min_agent above the agent")
    # agent.urgent (#326): set only for the agent version the policy marks — a security
    # release's —, lapsed for any other, refused above the agent shipped.
    refused(lambda: hb.build(args("x", policy=policy_with(urgent_agent="99.0.0"))), "urgent_agent 99.0.0 is above the agent", "an urgent_agent above the agent")
    hb.build(args("urgent", policy=policy_with(urgent_agent=agent_version)))
    ok(json.loads((tmp / "urgent/manifest.json").read_text())["agent"]["urgent"] is True, "agent.urgent for the agent version the policy marks")
    hb.build(args("lapsed", policy=policy_with(urgent_agent="0.0.1")))
    ok(json.loads((tmp / "lapsed/manifest.json").read_text())["agent"]["urgent"] is False, "agent.urgent lapsed with a later agent")
    bad = tmp / "policy-typo.toml"
    bad.write_text(hb.POLICY.read_text().replace("min_agent =", "min_agents ="))
    refused(lambda: hb.build(args("x", policy=bad)), "keys must be exactly", "a misspelt policy key")
    (tmp / "tag.json").write_text(json.dumps({"aarch64": "docker.io/menci/archlinuxarm:base-devel", "x86_64": X86_BUILD}))
    refused(lambda: hb.build(args("x", build_images=tmp / "tag.json")), "is not <repo>@sha256", "a build image by tag")
    refused(lambda: hb.build(args("x", release="1.2.3")), "is not vX.Y.Z", "a release that is not vX.Y.Z")
    sets = tmp / "sets"
    shutil.copytree(hb.SETS, sets)
    (sets / "host/compose.yml").write_text(template + "# @SOMETHING_ELSE@\n")
    refused(lambda: hb.build(args("x", sets=sets)), "unknown placeholder @SOMETHING_ELSE@", "an unknown placeholder")
    (sets / "host/compose.yml").write_text(template.replace("omarchy-worker@RELEASE@", "omarchy-worker:latest"))
    refused(lambda: hb.build(args("x", sets=sets)), "does not name the worker image as @RELEASE@", "a host set off the release image")
    (agents / hb.AGENTS["aarch64-darwin"]).unlink()
    refused(lambda: hb.build(args("x")), "the agent for aarch64-darwin is missing", "a missing agent binary")
    print("ok: refused: min_release, min_agent or urgent_agent above, self-revoked, a misspelt key, a build image by tag, a stray placeholder, a missing agent; agent.urgent only for the agent marked")

    # --- the tools' downloads ----------------------------------------------------------
    blobs = {"https://x/a": b"a", "https://x/b": b"b"}
    tools = {"x86_64-linux": {"docker": {"url": "https://x/a", "sha256": hashlib.sha256(b"a").hexdigest()},
                              "docker-compose": {"url": "https://x/b", "sha256": hashlib.sha256(b"b").hexdigest()}}}
    hb.check_tools(tools, fetch=blobs.__getitem__)
    checks += 1
    tools["x86_64-linux"]["docker-compose"]["sha256"] = "0" * 64
    refused(lambda: hb.check_tools(tools, fetch=blobs.__getitem__), "not the pinned", "a tool whose download does not match")
    print("ok: check-tools: every download against its pinned SHA-256")

    # --- the agent reads it whole ------------------------------------------------------
    # This runs the current tree's parser. Earlier agents' parsers run on the
    # probe in release.yml (factory/bin/verify-with-agents, every agent of the
    # last 30 days; tests/release-workflow.sh covers that script with stubs).
    # Until the first release ships an agent, the current parser is the only
    # one there is.
    if shutil.which("cargo"):
        env = dict(os.environ, OMARCHY_HOST_BUNDLE=str(tmp / "one" / name), OMARCHY_HOST_BUNDLE_PROBE=str(tmp / "one/probe" / name))
        r = subprocess.run(["cargo", "test", "-q", "--locked", "-p", "omarchy-agent", "--lib", "--", "--ignored",
                            "--nocapture", "a_bundle_the_release_writes_reads_whole"], cwd=ROOT, env=env, capture_output=True, text=True)
        out = r.stdout + r.stderr
        ok(r.returncode == 0 and "1 passed" in out, f"the agent's parser reads the bundle and the probe whole:\n{out}")
        print("ok: omarchy-agent's verify, after the signature, reads the bundle whole, and the probe with its extra outer field")
    else:
        print("skip: no cargo here: the agent's parser was not run on the bundle")
finally:
    shutil.rmtree(tmp)

print(f"HOST BUNDLE OK ({checks} checks)")
