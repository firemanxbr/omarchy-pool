# docs/

The documentation lives on the dashboard — https://omarchy-pool.org/docs
— with its source under [`worker/src/docs/`](../worker/src/docs/), rendered
by the Worker. This directory holds what the code and the releases ship,
not prose:

| | |
|---|---|
| `omarchy-staging.pub.asc` | the public part of the key that signs the databases and the factory's packages (`pacman-key --add`) |
| `omarchy-pool.hook` | the pacman hook that says, after every install, where a package came from (`omarchy-cli provenance`) |
| `omarchy-cli.config.toml` | the thin client's settings, every key explained (`/etc/omarchy-cli/config.toml`) |
| `omarchy-pool-logo.svg`, `.png` | the logo |
| `built-for-omarchy.svg` | the footer's badge, as the README shows it |
| `GOVERNANCE.md` | a pointer: governance is a chapter of the dashboard |
