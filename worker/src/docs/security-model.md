# Security

How omarchy-pool decides who may do what, where the keys live, and what a
compromised piece can and cannot do. Decisions are recorded here as they
are made; the *Status* column says what is running today.

Report a vulnerability privately to the maintainers listed on the People
page (or open a GitHub security advisory on this repository);
please do not file a public issue for it.

## Principles

1. **Users trust the pool, nothing else.** A machine installs from the
   pool's signed databases; every package it serves was either verified
   against its upstream project's key at import or built by a worker the
   project trusts and signed by the pool. No contributor's bytes reach a
   user, ever: a maintainer approves the *recipe* on the evidence of the
   contributor's build, and the project rebuilds it. Zero trust between
   people, shared knowledge between them — we do not use what a contributor
   built, we learn from it (docs/GOVERNANCE.md).
2. **The signing key never travels.** It signs inside the pool's own
   service; builders produce bytes and evidence, never signatures.
3. **A credential is worth exactly one job.** Nothing holds a token that
   "does everything". A worker's token can only ask for work; each job gets
   a credential scoped to the routes it needs, valid for its lease.
4. **Trust is granted per machine and per person, recorded and revocable.**
   Project workers are promoted by a maintainer; maintainers are named by
   `factory/MAINTAINERS.toml` — a pull request another maintainer approves,
   never a database write (docs/GOVERNANCE.md); every grant and every
   approval is a journal line with a name.
5. **GitHub hosts code and cuts releases.** It runs none of the pool's
   operations and holds none of its keys.

## Credentials

| Credential | Held by | Can do | Cannot do | Status |
|---|---|---|---|---|
| Contributor token `omc_…` | one person (GitHub identity read once, never stored) | register packages under their name, queue community builds, register and revoke their workers, read their own state | write to the pool, claim jobs, approve | live |
| Worker token `omw_…` | one machine, registered by a contributor | claim tasks its trust allows (community: its owner's or shared builds; project: pool jobs too); heartbeat | write to the pool or staging directly | live |
| Job token `omj.…` | the worker running one task, for the lease | the routes that task needs — e.g. `sync`: upload objects, index, create a release in one ring, store that ring's databases; community `build`: upload to that task's staging folder | anything outside its scopes (403, journaled); anything after the lease (30 min, renewed by heartbeat) | live |
| Maintainer role | a contributor listed in `factory/MAINTAINERS.toml` on `main` — one list, no groups (applied by the brain every ten minutes) | propose or confirm a worker's project trust (two of them), take it back alone; withdraw a record from the public bucket (a signed tombstone says why); approve or reject staged builds (recorded); queue any pool job by hand (`POST /factory/jobs`); enqueue, cancel, remove a registration; review the group's PKGBUILDs and governance pull requests | write to the pool with their own token (a job does); operate as a worker; grant a role | live |
| Session cookie `oms_…` | one person's browser, after Sign in with GitHub | what that person's contributor token can, from the dashboard's pages | — | live; separate from the CLI token, so signing in never invalidates a worker; *sign out* (in the header of every page) invalidates it on the server, not only in that browser |
| Signing key (OpenPGP) | the pool's Worker only (`SIGNING_KEY` secret, `worker/src/signing.ts`) | sign the databases it stores and the packages the factory builds (`POST /pool/:sha256/sign`) | — | live; no worker, runner or repository holds it |
| `CLOUDFLARE_API_TOKEN` | the release workflow on GitHub | deploy the Worker, apply migrations, record the deploy | — | live; all GitHub holds (no hosted worker: Actions runs CI and the release only) |
| `CLOUDFLARE_ANALYTICS_TOKEN` on the Worker | the daily cost estimate and the daily audience count | read the account's analytics, the zone's request analytics and the D1 file size | write anything | live |
| `GITHUB_TOKEN` on the Worker | the scheduler, the update check, the provenance reads | read run history; a higher rate limit reading GitHub for releases and provenance (nothing is dispatched since 2026-09-17) | write to the repository | live |
| The broker's environment (`OMARCHY_WORKER_TOKEN`, an agent key, `GITHUB_TOKEN`) | one container per worker host that runs no build (`factory/bin/broker`); on the project's host also `agent-proxy`, without a worker token | the pool's calls for the one task it claimed, the agent, GitHub read-only | be read by a build: the builder beside it holds nothing | live |

Tokens are 192-bit random values shown once and stored as SHA-256 hashes;
job tokens are HMAC-SHA256-signed claims (`JOB_TOKEN_SECRET`, a Worker
secret). Everything travels in the `Authorization` header over TLS only.

## Trust levels

| Who | Gets | How |
|---|---|---|
| Contributor | register packages, run community workers | GitHub account |
| Community worker | community builds of its owner's packages; anyone's only when started with `--shared` / `WORKER_SHARED=1`; results go to a separate staging bucket in the owner's workspace | registered by its owner |
| Project worker | pool jobs (sync, render, promote, health, security, gc) and the rebuild of approved packages — never a build without evidence and review | two maintainers' word (`POST /factory/workers/:id/trust`): one proposes, another confirms, never the worker's owner; the trust is a signed record under `workers/<id>/`; one maintainer takes it back. The Review page names the worker and host behind every build |
| Maintainer | approve the project's staged builds — never their own package — settle categories, block with a reason, vouch for a worker with a second maintainer, withdraw a record, review governance | listed in `factory/MAINTAINERS.toml`, merged with another maintainer's review |
| Agent key | drafts and corrects PKGBUILDs on a community worker; audits staged builds on a project worker | the worker owner's own key — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `XAI_API_KEY` — set in the container's environment; the pool and GitHub hold none. The worker reports only the provider and model name (`anthropic/claude-sonnet-5`) for the Workers page. An audit's report is evidence a maintainer reads, never something the pool acts on |

## Isolation

- **The build sees nothing the log cannot show.** A build is somebody
  else's code — the recipe and the upstream's build system — and its log is
  public. On every host one process holds the credentials and runs no build:
  the **broker** (`factory/bin/broker`) — the worker's token, the agent's
  key, `GITHUB_TOKEN` — which only receives, processes and answers: the
  pool's calls for the one task it claimed (the job token the pool hands out
  stays with it), the agent in the Anthropic Messages shape over whichever
  provider it has, GitHub read-only. A community **builder** is born with
  nothing but the broker's address, builds one task and dies; a project
  worker (`pkg-repo work`) is its own broker and starts a fresh container per
  task that holds nothing, on a network where the agent proxy is all there
  is. A worker started the old way, with the token on it, still takes it,
  the agent's key and `GITHUB_TOKEN` out of the environment at start, lends
  the keys to the agent and the drafter alone, and starts the build user
  from an empty environment (`factory/worker/omarchy-build-worker.sh`,
  *hold_secrets*, *as_builder*). Build caches are kept per trust on the host
  and per package inside: a build reads only what an earlier build of the
  same package, on the same side, wrote.
- **A log that carries a secret is refused.** Text evidence uploaded to
  staging is read whole and checked for the shapes of the pool's tokens,
  agents' keys, GitHub's and the clouds' tokens, private keys, credentials
  in URLs and a dump of the worker's variables (`worker/src/leak.ts`); a hit
  is a 422 with the kind and the line, never the match, a `leak` event, and
  a failed build. The record runs the same check before it copies anything.
  This is the pool's check on the worker it does not run.
- **A record is written once, and can be withdrawn.** A maintainer takes a
  log or a report off the public bucket with a reason (`POST
  /factory/record/withdraw`); its signature and its staging copy go with it,
  and a signed `<key>.tombstone.json` says who, why and what was there (its
  hash and size, not its bytes). The edge caches a record a day, not a year,
  so a withdrawal is honoured everywhere within the day.
- **Contributor results never touch the pool.** They land in
  `omarchy-factory-staging` under `staging/<login>/<package>/<task>/`,
  through the pool (the key is derived from the task, never given),
  with quotas (5 GB, 10 tasks) and a 30-day lifecycle the pool enforces
  itself (packages of decided builds are reclaimed at once). Logs and PKGBUILDs
  are public; packages are readable by maintainers.
- **Approved packages are the project's own build.** A contributor's build
  is evidence, not the product: the project's agent writes its own recipe
  with that evidence as the lesson (`pkgbuild_ref = review:<task>`; a build
  never starts from a contributor's staged artifact), builds it on a worker
  two maintainers vouched for, a second agent audits it, a real pacman
  installs it from the lab, and a maintainer who is not the owner approves
  *that* build before it is signed and enters `edge`.
- **The pool serves immutable objects.** An object under a filename is
  never rewritten; a signature must match the stored object or it is
  refused; superseded versions stay until retention runs.
- **The Omarchy Packaging image is signed** (cosign, keyless, GitHub OIDC)
  so a contributor can verify the worker they run is the project's.

## After approval, the gates still hold

A carelessly approved package still faces what every package faces: a real
pacman on both architectures after every promotion, the ABI check, a day in
`rc` and a day in `stable`'s soak, automatic rollback on a failed health
check, and the security layer's advisories.

## What a compromise costs

| Compromised | Blast radius | Recovery |
|---|---|---|
| a contributor's token | their registrations and their staging folder | they register again (the old token dies) |
| a community worker's token | claims of that owner's tasks; uploads to those tasks' staging | its owner or a maintainer revokes the worker |
| a job token | that task's writes, until its lease ends | expires by itself; the task can be cancelled |
| a project worker's token | claims of pool jobs — each still executed with a scoped job token — until revoked | a maintainer revokes the worker |
| a maintainer's token | approvals (never of their own package), one word on a worker's trust, blocks, withdrawals | a governance pull request removes the login; approvals are journaled and reversible (rollback); trust takes a second maintainer; a block is lifted by another |
| the signing key | signatures on bad content — only through the Worker's own routes, since the key is a secret of the service | rotate: `wrangler secret put SIGNING_KEY`, re-render every ring, users import the new public key (RUNBOOK) |

## Roadmap

1. ~~Per-job scoped tokens; project workers registered and trusted by a maintainer; pool jobs pulled by workers~~ — live (v0.0.40).
2. ~~Signing inside the pool's Worker: the key becomes a Worker secret; `publish` and `render` stop signing on workers; the GitHub secret is deleted~~ — live (v0.0.49). A client's `.sig` for a database is superseded; a package signature must match the stored bytes.
3. ~~Retire `FACTORY_TOKEN`~~ — gone (v0.0.50). ~~The pipeline's last workflows become jobs~~ — done (v0.0.51). ~~Retire the publish token~~ — gone (v0.0.56): writes need a per-job token; maintainers act by queueing jobs (`POST /factory/jobs`) and on the factory's own routes with their contributor token; the PKGBUILD reconcile (`enqueue`) and package requests (issues, read by the brain) left GitHub with it. GitHub keeps only the release (`CLOUDFLARE_API_TOKEN`) and the scheduler's dispatch token for the two workflows it still starts.
4. ~~Phase 2: maintainers by area, approval as a recorded action, rebuild at approval on project workers~~ — live (v0.0.42). A promotion gate for the `factory` source is unnecessary: nothing unapproved enters `edge`.
5. ~~**The broker.** One process per host holds the credentials — the worker's
   token, the agent's key, GitHub's — and only receives, processes and
   answers: the pool's calls for the one task it claimed, the agent, GitHub
   in read-only. The builder beside it is born with nothing and dies after a
   task.~~ — live (`factory/bin/broker`; the contributor image runs as a
   pair, the Studio's community workers too; the review builds reach the
   agent and GitHub through the proxy and get no token).
6. ~~**Who trusts whom.** A worker becomes `project` on two maintainers' word,
   never its owner's alone; the Review page names the worker and host behind
   every build. A record can be withdrawn: a signed tombstone says who and
   why, and the record is cached a day, not a year.~~ — live. (The six
   workers on the Studio were trusted before the rule, on one word; the
   Workers page says so, and a maintainer can set one back and have it
   proposed again.)
