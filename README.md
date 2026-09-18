<p align="center">
  <img src="docs/omarchy-pool-logo.svg" alt="omarchy-pool" width="96">
</p>

<h1 align="center">omarchy-pool</h1>

<p align="center">
  <a href="https://omarchy.org/"><img src="docs/built-for-omarchy.svg" alt="built for Omarchy" height="20"></a><br>
  <sub>a community pool — not official Omarchy</sub>
</p>

<p align="center">
  One package repository for <a href="https://omarchy.org/">Omarchy</a>: every Arch Linux, Arch Linux ARM, Omarchy (OPR) and Asahi package — and the ones its own factory builds — verified against its project's key, stored once, and served in rings that only move forward on evidence.
</p>

<p align="center">
  <a href="https://omarchy-pool.org"><b>Dashboard</b></a> ·
  <a href="https://omarchy-pool.org/docs"><b>Documentation</b></a> ·
  <a href="https://omarchy-pool.org/docs/get-started">Get started</a> ·
  <a href="https://omarchy-pool.org/factory">Bring a package</a> ·
  <a href="https://omarchy-pool.org/docs/contributing">Contribute to the code</a>
</p>

---

## Use it

One command, once per machine, on x86_64 or aarch64 — no account:

```bash
curl -fsSL https://omarchy-pool.org/setup | sudo bash -s -- --ring stable
```

Then `omarchy update`. `stable` is what passed a real pacman, an ABI check and the security layer on both architectures and stayed healthy through two checks in a row; `rc` and `edge` are closer to upstream; the `lab` is where the factory's builds are tried. [Which ring is for me? →](https://omarchy-pool.org/docs/get-started#which-ring)

## Bring a package

Anyone who signs in with GitHub can ask for a package nobody ships yet and build it at home with the same tools maintainers use. Your build is evidence — the project builds it again, a real pacman installs it in the lab, and a maintainer who is not you approves it. [The factory →](https://omarchy-pool.org/factory) · [Run a worker →](https://omarchy-pool.org/docs/workers)

## Contribute to the code

This repository is where the code lives and is released: a release is `main` at the moment a maintainer dispatches one (`gh workflow run release.yml`), deployed to the dashboard and shipped as binaries for both architectures. The documentation lives on the dashboard — [every chapter, one map, one search](https://omarchy-pool.org/docs) — and its source is under [`worker/src/docs/`](worker/src/docs/), so a change to the code and a change to what it says are the same pull request.

```bash
cargo build --workspace && cargo test --workspace && cargo clippy --workspace --all-targets
cd worker && npm install && npm run typecheck && npm test
tests/e2e-worker.sh          # real pacman through a local worker (docker or podman)
```

Start with [Contributing](https://omarchy-pool.org/docs/contributing), then [Architecture](https://omarchy-pool.org/docs/architecture), the [Runbook](https://omarchy-pool.org/docs/runbook), [Testing](https://omarchy-pool.org/docs/testing) and [Open work](https://omarchy-pool.org/docs/open-work). Who decides what is in [Governance](https://omarchy-pool.org/docs/governance); the [security model](https://omarchy-pool.org/docs/security-model) says where the keys live. To report a vulnerability privately, see [SECURITY.md](SECURITY.md).

```
crates/
  pkg-manifest/   shared types, dependency rules, Arch-compatible vercmp, the build version
  pkg-extract/    .pkg.tar.{zst,xz} inspection → PackageManifest (lib + binary)
  pkg-repo/       the publisher: sync, publish, promote, gate, trial, render, security, gc
  pkg-check/      the ABI safety check (ELF symbol versions against a system)
  omarchy-cli/    the thin client
worker/           the Cloudflare Worker: the API, the dashboard and its documentation (src/docs), the scheduler; D1 migrations
tests/            end-to-end scripts (real pacman), health check, ABI gate, the trial, keyring fetcher, pinned images
factory/          the factory: the governance file, the worker script and image, the broker, the project's own recipes
docs/             what the code and the releases ship: the signing key's public part, the pacman hook, the config example, the logo
poc/              the proof of concept's benchmarks and parked crates
.github/          CI, E2E, Release (dispatched by a maintainer), the cost report
```

## License

MIT
