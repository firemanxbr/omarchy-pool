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
| Contributor token `omc_…` | one person (GitHub identity read once, never stored) | register packages under their name, queue community builds, register and revoke their workers and give them orders from the worker's page or the API (re-check the agent, restart, restart the agent service, update; #277), read their own state | write to the pool, claim jobs, approve | live; replaced from the person's page, revoked by a reset of their passkeys (#284) — then made again on that page only, never with a GitHub token |
| Worker token `omw_…` | one machine, registered by a contributor | claim tasks its trust allows (community: its owner's or shared builds; project: pool jobs too); heartbeat | write to the pool or staging directly | live |
| Job token `omj.…` | the worker running one task, for the lease | the routes that task needs — e.g. `sync`: upload objects, index, create a release in one ring, store that ring's databases; community `build`: upload to that task's staging folder, and nothing into the journal (the health and abi rows the gate reads are the project's jobs' alone); a dry run (`publish` 0): its task and the journal, no pool and no ring (#284) | anything outside its scopes (403, journaled); anything after the lease (30 min, renewed by heartbeat) | live |
| Maintainer role | a contributor listed in `factory/MAINTAINERS.toml` on `main` — one list, no groups (applied by the brain every ten minutes) | propose or confirm a worker's project trust (two of them), take it back alone; withdraw a record from the public bucket (a signed tombstone says why); approve or reject staged builds (recorded; approve, and a block, in the browser with their passkey, #271); queue any pool job by hand (`POST /factory/jobs`; a promotion forced past its evidence in the browser with their passkey, #284); queue a dry run by hand, cancel, remove a registration; give any worker orders (the same list), capped at 20 an hour per login and on the journal — none of them needs the passkey (#277); review governance pull requests | write to the pool with their own token (a job does); publish a build queued by hand (#284: a dry run only); write the gate's evidence (#284: a journal note only); roll a ring back to another ring's release; operate as a worker; grant a role | live |
| Agent token `oma_…` | one agent on one person's machine, granted by that person in their signed-in browser (`omarchy-cli login`: a loopback address and PKCE), kept in `~/.config/omarchy-cli/credentials.toml` (0600) and bound to the origin that granted it | the tools of `omarchy-cli mcp` its scopes hold, as that person: request and follow packages (`contribute`); claim, release, read evidence and draft a verdict (`review`) or a block (`block`) — the two a maintainer's only, read again on every call; twenty calls a minute, five requests, ten claims and thirty drafts a day | decide anything — approve, request changes, reject and block are drafts the person confirms in the browser, approve and block with the person's passkey; every other route (403); give the project's agent a hint; outlive seven days with `review` or `block`, ninety with `contribute` | live; revoked by `omarchy-cli logout`, the person's page, a block of the person, or a reset of their passkeys (#284) |
| Passkey (WebAuthn) | one maintainer's authenticator — a security key, a phone, a laptop's platform authenticator — registered on their own page with the browser's session; the pool keeps the credential's id, its public key, the algorithm (ES256, EdDSA, RS256), the RP id `omarchy-pool.org`, the counter, a name and two dates (`passkeys`, migration 0040) | decide approve and block — an agent's draft confirmed (#257), and the web's own buttons (#271): an assertion with the user verified — the person's fingerprint, face or PIN, as the authenticator reports it (attestation `none`: the pool takes the authenticator's word on that) — for a challenge bound to that login and that draft or act, checked by the Worker against the stored key (`webauthn.ts`), the counter moving forward; vouch for a second passkey of the same login, and for a removal; confirm another maintainer's reset of a lost one (#271); force a promotion past its evidence, for exactly that promotion (#284) | be registered or used with a token of any kind, from another origin, or for another relying party; stand in for the session (every door takes both); confirm another act than the one its challenge was issued for; be replayed (each challenge is taken once) | live; ten per maintainer; the first registered with the session, every other with one the login holds; removed by its owner with one they hold, or reset by another maintainer with a reason (the login signed out, its token and its agents' grants revoked, #284, a signed record); registration, removal and reset are journal lines (`passkey`) without the key |
| Session cookie `oms_…` | one person's browser, after Sign in with GitHub | what that person's contributor token can, from the dashboard's pages | — | live; separate from the CLI token, so signing in never invalidates a worker; *sign out* (in the header of every page) invalidates it on the server, not only in that browser |
| Signing key (OpenPGP) | the pool's Worker only (`SIGNING_KEY` secret, `worker/src/signing.ts`) | sign the databases it stores and the packages the factory builds (`POST /pool/:sha256/sign`) | — | live; no worker, runner or repository holds it |
| `CLOUDFLARE_API_TOKEN` | the release workflow on GitHub | deploy the Worker, apply migrations, record the deploy | — | live; all GitHub holds (no hosted worker: Actions runs CI and the release only) |
| `CLOUDFLARE_ANALYTICS_TOKEN` on the Worker | the daily cost estimate and the daily audience count | read the account's analytics (Account · Analytics · Read: the bill and the pool hosts' requests, in one scope) and the D1 file size | write anything | live |
| `GITHUB_TOKEN` on the Worker | the scheduler, the update check, the provenance reads | read run history; a higher rate limit reading GitHub for releases and provenance (nothing is dispatched since 2026-09-17) | write to the repository | live |
| `GITHUB_REPORT_TOKEN` on the Worker | the daily cost report (`cost.ts` `postCostReport`) | read and comment on this repository's issues — the one comment a day on the *Cost report* issue | anything else: start a workflow, read code, touch a release (Issues is its only permission; `GITHUB_TOKEN` is never widened for this) | live once the secret is set; until then `cost-report.yml` posts from GitHub's cron, late |
| The broker's environment (`OMARCHY_WORKER_TOKEN`, an agent key, `GITHUB_TOKEN`) | one container per worker host that runs no build (`factory/bin/broker`); on the project's host also `agent-proxy`, without a worker token | the pool's calls for the one task it claimed, the agent, GitHub read-only; a builder's answer to an order the broker saw handed to it (#277) | be read by a build: the builder beside it holds nothing | live |

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
- **An order reaches a worker only through its own claim (#277).** The
  pool tells a worker to re-check its agent, restart, or restart its agent
  service on the answer to the claim the worker made with its own token,
  and only the kinds that claim says its process carries out; nothing
  listens on the worker, and no host is reached. The worker checks the
  order again before it acts (a restart "only if the agent is down" asks
  the agent first). A builder answers through its broker, which passes an
  answer only for an order it saw handed to that builder on a claim it
  relayed, between two tasks, and once. What a worker says in its answer
  is cleaned (no escape or control characters, nothing that looks like a
  secret) and shown only to its owner and the maintainers; the public page
  gets one sentence the pool wrote — and never the worker's own version
  string, only a release tag the pool parsed. Orders are capped inside the
  statement that issues them — per worker, per login (20 an hour), and for
  the pool's own (ten restarts an hour, sixty orders a day, a breaker while a
  provider is down) — and each has one line on the journal when it is given
  and one when it ends. The pool signs its own orders `pool:project` or
  `pool:community`: no GitHub login has a colon, so nobody who signs in as
  `pool` spends the pool's budget or escapes a person's cap. A second process
  on the same token (a copied token, an old container that did not stop, or
  one that names no process at all) shows on the worker's page as two
  processes, and the pool gives such a worker no order until one has
  claimed alone for ten minutes; the journal names a process by its first
  four hex digits only, so it never tells a thief which process to pretend
  to be.
- **A contributor's workers can say an outage that is not there, and only
  their own kind listens (#277).** A worker's agent error is its own word.
  So a contributor's registrations count only toward the breaker that holds
  contributors' workers, never the project's, and spend only the
  community's share of the pool's own orders (forty of the sixty a day, six
  of the ten restarts an hour); the project's workers keep the rest. A site
  is kept under the name of who runs the worker: a leaked site of another
  person's host joins neither its election nor its pacing. The worst a
  hostile contributor does with free registrations is hold the pool's
  automatic restarts of other contributors' workers — whose owners restart
  them on their own host, or from their page — and put a warning on Status.
- **A Worker rolled back past #277 lists what #277 keeps to itself.** The
  Workers listing of a Worker from before #277 spreads the whole row, so it
  would serve a worker's `site`, its process's `instance` and the rules'
  state. Neither gives a power by itself — a site is kept under its owner's
  name, and an instance binds an order only for its own token — but they
  are cleared when a Worker from before #277 is deployed again
  (`UPDATE build_workers SET site = NULL, instance = NULL, instance_prev =
  NULL, auto_orders = NULL`). The rollback workflow (`rollback.yml`,
  `factory/bin/release-rollback`) takes this step itself when the release it
  goes back to is from before #277: just before that release's Worker is
  deployed, and once more right after it — until the older Worker serves,
  the one from #277 writes them back at every claim, and the older one
  never writes them, so the second clear is final.
- **An updater acts on a public answer, and holds no token (#277).** Every
  set's updater asks `GET /factory/follow` with the ids of its set's workers:
  the pool's release, and the id of an open Update. The answer carries no
  image, service, path or command — the updater pulls what its own compose
  file names — so the worst any answer can do is start a round the updater
  would run within fifteen minutes anyway, and it tells nothing `/workers`
  does not show (nothing says which workers share a host). The updater
  learns its workers' ids from inside the set: a project worker's from the
  file its entrypoint writes, a builder's from its broker, which adds the
  token itself; nothing is ever read of a builder's container, where
  strangers' recipes run, and the updater, on the set's default network,
  serves nothing a builder could reach. It never adopts an image under which
  what it replaced keeps restarting, and keeps the old images, so a rollback
  reaches its set with no download. A stolen worker token can report a
  `rollout` that enables Update for itself; the worst outcome is an Update
  nothing executes, which expires.
- **The Omarchy Packaging image is signed** (cosign, keyless, GitHub OIDC)
  so a contributor can verify the worker they run is the project's.

## After approval, the gates still hold

A carelessly approved package still faces what every package faces: a real
pacman on both architectures after every promotion, the ABI check, a day in
`rc` and a day in `stable`'s soak, automatic rollback on a failed health
check, and the security layer's advisories.

## The doors that ship

Every door that puts bytes in a ring, and what guards it (#284). Taking out
ships nothing: a block takes the maintainer's passkey (#271), a withdrawal
the session or the token. No door ships bytes that no check and no approval
passed without the maintainer's passkey.

| Door | What it ships | What guards it |
|---|---|---|
| Approve — Review, a build's page, an agent's draft confirmed | the project's build, into edge (rc and stable too when its trial passed) | the maintainer's passkey, in the browser (#257, #271); never their own package, never a contributor's bytes |
| The enqueue job — `POST /factory/enqueue` with its job token | a recipe on `main`, built by a project worker and published into edge | a job token, issued only to a project worker at claim (`factory:write`); the recipe is a reviewed commit on `main` |
| A build queued by hand — `POST /factory/enqueue`, a maintainer's session or `omc_` token | nothing: a dry run, built, measured and kept on the worker (`publish: false`) | anything else is refused (`dry_run_only`, #284); the dry run's job token has no pool and no ring scope, whatever recipe it names |
| A sync — the scheduler's, or a job by hand | upstream's packages, into edge (the OPR's channels into their rings) | every package verified against its upstream's keyring |
| A promotion — the scheduler's, or a job by hand | a ring's head, into the ring above | the gate: fresh health and ABI checks, the soak, no security regression — rows only the project's jobs write: a maintainer's session or token writes a `note` to the journal and nothing else (`note_only`, #284) |
| A forced promotion — Status's *Force into …*, `promote` with `force: "yes"` | a ring's head, into the ring above, past the gate — both architectures, or one | the maintainer's passkey, in the browser, for exactly that promotion (#284); no token forces one; the target's health check still rolls it back |
| A rollback — Status's *Roll back*, a job by hand | an earlier release of the ring, again | a maintainer's session or token; a release of another ring is refused (`another_ring`, #284: stable pointed at edge's would be a promotion past the gate); the journal keeps why |
| A trial — after the project's review build, or a job by hand | the project's staged build, into the lab — never a promised ring, never promoted | a staged build of the project's own, never a contributor's bytes; the lab promises nothing, and a machine takes it only with `--ring lab` |

## What a compromise costs

| Compromised | Blast radius | Recovery |
|---|---|---|
| a contributor's token | their registrations and their staging folder | they register again (the old token dies) |
| a community worker's token | claims of that owner's tasks; uploads to those tasks' staging | its owner or a maintainer revokes the worker |
| a job token | that task's writes, until its lease ends | expires by itself; the task can be cancelled |
| a project worker's token | claims of pool jobs — each still executed with a scoped job token — until revoked | a maintainer revokes the worker |
| a maintainer's token | rejections and requests for changes (never on their own package), one word on a worker's trust, withdrawals, lifts, a pool job by hand — a rollback inside its ring, a promotion the gate still decides —, a dry run by hand and a note on the journal (#284: a build queued by hand never publishes, and the gate's evidence is the jobs' alone), and orders to any worker, 20 an hour (#277: a restart or a re-check at worst, never a publish or a cancel) — not an approval, a block nor a forced promotion: those take the browser's session and the maintainer's passkey (#271, #284) | the person replaces the token (their page's *Token*: the old one stops working), and a reset of their passkeys revokes it (#284); a governance pull request removes the login; decisions and builds are journaled and reversible (rollback); trust takes a second maintainer |
| a maintainer's agent token (`oma_`) | drafts; request changes and reject once the person confirms them in the browser — approve and block drafted by the agent also need the maintainer's passkey, which the token cannot answer (user verification) | revoke the grant on the person's page or `omarchy-cli logout` |
| a maintainer's signed-in browser, driven by an agent | what the session decides alone: request changes, reject, withdraw, a lift, a claim, a pool job by hand other than a forced promotion, a dry run by hand, and orders to any worker (20 an hour). Approve, block and a forced promotion need the person's passkey (#257, #271, #284), and so do adding a second passkey and removing one; only a login that holds none yet registers its first with the session | sign out (the session ends on the server); a first passkey registered meanwhile is on the public journal (`passkey`), and another maintainer resets it |
| a maintainer's authenticator, lost or stolen | nothing without its user verification (a PIN or a biometric on the device); with it, what the person decides — approve, block and a forced promotion | another maintainer resets the login's passkeys with a reason (#271), after confirming the request out of band: every one removed, the login signed out, its `omc_` token and its agents' live grants revoked (#284), the journal — a line each — and a signed record say who and why; the person ends the device's GitHub sessions and revokes the GitHub tokens it held (the GitHub CLI's authorization, personal access tokens) — until they make a new token on their page, `POST /factory/register` mints the login none (`token_reset`) —, signs in again, registers a new one, makes a new token and grants their agents again (RUNBOOK, *A lost passkey*) |
| the signing key | signatures on bad content — only through the Worker's own routes, since the key is a secret of the service | rotate: `wrangler secret put SIGNING_KEY`, re-render every ring, users import the new public key (RUNBOOK) |

## Roadmap

1. ~~Per-job scoped tokens; project workers registered and trusted by a maintainer; pool jobs pulled by workers~~ — live (v0.0.40).
2. ~~Signing inside the pool's Worker: the key becomes a Worker secret; `publish` and `render` stop signing on workers; the GitHub secret is deleted~~ — live (v0.0.49). A client's `.sig` for a database is superseded; a package signature must match the stored bytes.
3. ~~Retire `FACTORY_TOKEN`~~ — gone (v0.0.50). ~~The pipeline's last workflows become jobs~~ — done (v0.0.51). ~~Retire the publish token~~ — gone (v0.0.56): writes need a per-job token; maintainers act by queueing jobs (`POST /factory/jobs`) and on the factory's own routes with their contributor token; the PKGBUILD reconcile (`enqueue`) and package requests (issues, read by the brain) left GitHub with it. GitHub keeps only the release (`CLOUDFLARE_API_TOKEN`); the Worker's `GITHUB_TOKEN` has been read-only since 2026-09-18 (nothing is dispatched), and the one thing the brain writes on GitHub — the daily comment on the *Cost report* issue — has its own token, `GITHUB_REPORT_TOKEN`, Issues: Read and write and nothing else (the table above).
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
