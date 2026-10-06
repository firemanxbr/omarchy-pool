# Governance

Documented where it runs: **https://omarchy-pool.org/docs/governance**
(source: [`worker/src/pages/governance.ts`](../worker/src/pages/governance.ts)).
The rules themselves are one file, [`factory/MAINTAINERS.toml`](../factory/MAINTAINERS.toml),
which the pool reads on `main` every ten minutes.
Its `[cosignature]` table holds the maintainers' FIDO security keys and how
many of them must co-sign every host bundle a maintainer host takes (#330;
the runbook's *Co-signing a release*); the host agent pins it at build time.
