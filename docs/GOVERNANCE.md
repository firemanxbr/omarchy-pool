# Governance

Documented where it runs: **https://omarchy-pool.org/docs/governance**
(source: [`worker/src/pages/governance.ts`](../worker/src/pages/governance.ts)).
The rules themselves are one file, [`factory/MAINTAINERS.toml`](../factory/MAINTAINERS.toml),
which the pool reads on `main` every ten minutes.
Its `[cosignature]` table holds the maintainers' FIDO security keys and how
many of them must co-sign every host bundle a maintainer host takes (#330;
the runbook's *Co-signing a release*); the host agent pins it at build time.
Its `[solo]` table, while it is there, is the solo-maintainer exception
(#394): the one maintainer it names builds, reviews and approves their own
packages, each such decision marked self-reviewed in public (its signed
record, its journal line, Review, the build and package pages, Status);
`factory/bin/check-governance` refuses a malformed one, and deleting the
table ends it (the chapter's *The solo-maintainer exception*; the runbook's
*The solo-maintainer exception*).
