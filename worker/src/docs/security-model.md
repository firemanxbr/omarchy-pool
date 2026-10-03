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
| Contributor token `omc_…` | one person (GitHub identity read once, never stored) | register packages under their name, queue community builds, register and revoke their workers and give them orders from the worker's page or the API (re-check the agent, restart, restart the agent service, drain and resume, stop the task in hand, update; #277), read their own state | write to the pool, claim jobs, approve | live; replaced from the person's page, revoked by a reset of their passkeys (#284) — then made again on that page only, never with a GitHub token |
| Worker token `omw_…` | one machine, registered by a contributor | claim tasks its trust allows (community: its owner's or shared builds; project: pool jobs too); heartbeat | write to the pool or staging directly | live |
| Job token `omj.…` | the worker running one task, for the lease | the routes that task needs — e.g. `sync`: upload objects, index, create a release in one ring, store that ring's databases; community `build`: upload to that task's staging folder, and nothing into the journal (the health and abi rows the gate reads are the project's jobs' alone); a dry run (`publish` 0): its task and the journal, no pool and no ring (#284) | anything outside its scopes (403, journaled); anything after the lease (30 min, renewed by heartbeat) — a task stopped from its worker's page is not renewed, and goes back to the queue only once its worker has stopped or the lease has ended, so no second runner overlaps its token; an audit's or a trial's report beside a staged build is taken only while the job's own task is still leased to its worker and not stopped (#277) | live |
| Maintainer role | a contributor listed in `factory/MAINTAINERS.toml` on `main` — one list, no groups (applied by the brain every ten minutes) | propose or confirm a worker's project trust (two of them), take it back alone; withdraw a record from the public bucket (a signed tombstone says why); approve or reject staged builds (recorded; approve, and a block, in the browser with their passkey, #271); queue any pool job by hand (`POST /factory/jobs`; a promotion forced past its evidence in the browser with their passkey, #284); queue a dry run by hand, cancel, remove a registration; give any worker orders (the same list), capped at 20 an hour per login and on the journal — none of them needs the passkey (#277); review governance pull requests | write to the pool with their own token (a job does); publish a build queued by hand (#284: a dry run only); write the gate's evidence (#284: a journal note only); roll a ring back to another ring's release; operate as a worker; grant a role | live |
| Agent token `oma_…` | one agent on one person's machine, granted by that person in their signed-in browser (`omarchy-cli login`: a loopback address and PKCE), kept in `~/.config/omarchy-cli/credentials.toml` (0600) and bound to the origin that granted it | the tools of `omarchy-cli mcp` its scopes hold, as that person: request and follow packages (`contribute`); claim, release, read evidence and draft a verdict (`review`) or a block (`block`) — the two a maintainer's only, read again on every call; twenty calls a minute, five requests, ten claims and thirty drafts a day | decide anything — approve, request changes, reject and block are drafts the person confirms in the browser, approve and block with the person's passkey; every other route (403); give the project's agent a hint; outlive seven days with `review` or `block`, ninety with `contribute` | live; revoked by `omarchy-cli logout`, the person's page, a block of the person, or a reset of their passkeys (#284) |
| Passkey (WebAuthn) | one maintainer's authenticator — a security key, a phone, a laptop's platform authenticator — registered with the browser's session, on their own page or, the first one, in the dialog of the act that needs it (#287); the pool keeps the credential's id, its public key, the algorithm (ES256, EdDSA, RS256), the RP id `omarchy-pool.org`, the counter, a name and two dates (`passkeys`, migration 0040) | decide approve and block — an agent's draft confirmed (#257), and the web's own buttons (#271): an assertion with the user verified — the person's fingerprint, face or PIN, as the authenticator reports it (attestation `none`: the pool takes the authenticator's word on that) — for a challenge bound to that login and that draft or act, checked by the Worker against the stored key (`webauthn.ts`), the counter moving forward; vouch for a second passkey of the same login, and for a removal; confirm another maintainer's reset of a lost one (#271); force a promotion past its evidence, for exactly that promotion (#284) | be registered or used with a token of any kind, from another origin, or for another relying party; stand in for the session (every door takes both); confirm another act than the one its challenge was issued for; be replayed (each challenge is taken once) | live; ten per maintainer; the first registered with the session, every other with one the login holds; removed by its owner with one they hold, or reset by another maintainer with a reason (the login signed out, its token and its agents' grants revoked, #284, a signed record); registration, removal and reset are journal lines (`passkey`) without the key |
| Host enrollment token `ome_…` | the maintainer who pressed *Add a host*, for the one command they paste on the machine (in the environment of `sh`, never an argument) | enroll one host, once, within 15 minutes, as that maintainer — while they are still in `factory/MAINTAINERS.toml` and still the same GitHub user id | claim, confirm the host, or enroll a second one | live (#321); stored as its SHA-256; burnt by the enrollment in the same D1 batch that creates the host |
| Host key (Ed25519) | one maintainer host's agent: `host.ed25519`, mode 0600, made at install, never in a container | sign the host's calls (`Omarchy-Host`: method, path, body hash, time, nonce): read its state, fetch or rotate its worker token, report | claim, change the maintainer list, widen the owner's envelope; be replayed (a nonce table), act from a clock 120 s off; act before its owner confirmed its fingerprint on the site | live (#321); a suspended or retired host's key is refused |
| Session cookie `oms_…` | one person's browser, after Sign in with GitHub | what that person's contributor token can, from the dashboard's pages | — | live; separate from the CLI token, so signing in never invalidates a worker; *sign out* (in the header of every page) invalidates it on the server, not only in that browser |
| Signing key (OpenPGP) | the pool's Worker only (`SIGNING_KEY` secret, `worker/src/signing.ts`) | sign the databases it stores and the packages the factory builds (`POST /pool/:sha256/sign`) | — | live; no worker, runner or repository holds it |
| `CLOUDFLARE_API_TOKEN` | the release workflow on GitHub | deploy the Worker, apply migrations, record the deploy | — | live; all GitHub holds (no hosted worker: Actions runs CI and the release only) |
| `CLOUDFLARE_ANALYTICS_TOKEN` on the Worker | the daily cost estimate and the daily audience count | read the account's analytics (Account · Analytics · Read: the bill and the pool hosts' requests, in one scope) and the D1 file size | write anything | live |
| `GITHUB_TOKEN` on the Worker | the governance sync, the update check, the provenance reads | a higher rate limit reading GitHub for the governance file, releases and provenance (the scheduler's dispatch path is gone, #308) | write to the repository; start a workflow (probed every day, below) | live |
| `GITHUB_REPORT_TOKEN` on the Worker | the daily cost report (`cost.ts` `postCostReport`) | read and comment on this repository's issues — the one comment a day on the *Cost report* issue | anything else: start a workflow, read code, touch a release (Issues is its only permission; `GITHUB_TOKEN` is never widened for this) | live once the secret is set; until then `cost-report.yml` posts from GitHub's cron, late |
| The broker's environment (`OMARCHY_WORKER_TOKEN`, an agent key, `GITHUB_TOKEN`) | one container per worker host that runs no build (`factory/bin/broker`); on the project's host also `agent-proxy`, without a worker token | the pool's calls for the one task it claimed, the agent, GitHub read-only; a builder's answer to an order the broker saw handed to it (#277) | be read by a build: the builder beside it holds nothing | live |

**No stored or automated token with a write scope on this repository exists
outside GitHub Actions** (#308): no token with `actions`, `contents: write`
or `workflows` on `firemanxbr/omarchy-pool` is held by the Worker, a host, a
worker, a deploy key or CI tooling; only the workflows' own `GITHUB_TOKEN`
inside a run has one. A maintainer dispatches and approves as a person, in
their own interactive session or the web UI, and what they dispatch still
waits for the signing environment's reviewer. Hosts trust what
`release.yml` and `rollback.yml` sign on `main`, and a token that could
dispatch `rollback.yml` could send every host back. The pool checks its own: once a day the cron probes each GitHub token it holds
(`GITHUB_TOKEN`, `GITHUB_REPORT_TOKEN`; `src/tokenprobe.ts`) with a dispatch
of `rollback.yml` to a ref that cannot exist. GitHub answers 403 to a token
without `actions: write` and 422 to one with it; no run starts either way. A
422 is an error on Status (the hero, and a `token` line in the journal) until
the token is replaced or removed. The probe detects `actions: write` only;
`contents: write` and `workflows` are the maintainers' manual token review.
The `GITHUB_TOKEN` a host gives its agent sidecars is probed by the host
agent's preflight (#317).

Tokens are 192-bit random values shown once and stored as SHA-256 hashes;
job tokens are HMAC-SHA256-signed claims (`JOB_TOKEN_SECRET`, a Worker
secret). Everything travels in the `Authorization` header over TLS only.

## Trust levels

| Who | Gets | How |
|---|---|---|
| Contributor | submit packages only: request them, build them and follow them — on the pool's hosts. A contributor runs no worker: `POST /factory/workers` refuses them (403, *your packages build on the pool's hosts*) | GitHub account |
| Host | the workers: every one is provided by a maintainer — the project's compute is its maintainers' hosts. A maintainer's host is trusted by the same act that makes them a maintainer | enrolled by a maintainer listed in `factory/MAINTAINERS.toml` at the last sync (*Maintainer hosts* below, #321), owned by their GitHub user id, confirmed by fingerprint; a legacy registration (`POST /factory/workers`) keeps claiming until a maintainer revokes it. A removal from the list stops its claims and lets its running tasks finish (*Stopping a host* below, #322) |
| Community worker | none: the tier ends (#307). The registrations made before #331 — expected to be the maintainers' own, which a one-time query of the last 90 days checks (recorded on #331) — keep their claims (their owner's packages; anyone's when shared) until they retire | no new one |
| Project worker | pool jobs (sync, render, promote, health, security, gc) and the rebuild of approved packages — never a build without evidence and review | two maintainers' word (`POST /factory/workers/:id/trust`): one proposes, another confirms, never the worker's owner; the trust is a signed record under `workers/<id>/`; one maintainer takes it back. The Review page names the worker and host behind every build |
| Maintainer | provide the project's hosts, approve the project's staged builds — never their own package — settle categories, block with a reason, vouch for a worker with a second maintainer, withdraw a record, review governance | listed in `factory/MAINTAINERS.toml`, merged with another maintainer's review |
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
- **On a maintainer host, one container per task, born with nothing
  (#335).** The host's one service, the dispatcher (`pkg-repo dispatch`),
  holds the host's worker token and each lease's job token, and starts every
  task — a build, an audit, a trial's helper — in a container made by one
  function: no socket, no token of any kind, no agent key, not the work root
  nor another task's directory, `--cap-drop ALL` with the few capabilities
  pacman and makepkg need, `no-new-privileges`, its share of CPUs, memory and
  pids, the build image by digest, never `--rm`, no engine-side log; its
  directories are the dispatcher's alone (0700). No task container calls the
  pool: the dispatcher stages its inputs (`/task/in`, read-only) and, after
  it exits, uploads only the files its kind may upload, under a size cap, and
  walks a package it wrote for an extension member the archive reader would
  buffer whole before it reads one; the engine's out-of-memory kill is the
  engine's word, whatever the script said.
  The dispatcher refuses to start with a package signing key in its
  environment: the pool signs what is published. CI renders every kind's
  container and fails on anything outside that spec (`dispatch/spec.rs`), and
  runs the dispatcher on a real engine (`tests/dispatch-engine.sh`).
- **Each task on its own network, its own egress, its own agent (#336).**
  A task container is on an internal network of its own (a /28 of
  `OMARCHY_TASK_SUBNETS`) that no other task, the host's LAN, the dispatcher
  or the pool is on; the dispatcher joins none. Its one way out is its egress
  sidecar (`pkg-repo egress`), which holds nothing and allows `CONNECT`,
  `GET` and `HEAD` to public addresses only: private, CGNAT, link-local
  (cloud metadata), loopback, multicast and reserved ranges, the task
  subnets and the host's own addresses are refused by the address a name
  resolves to, and the connection goes to the address that was checked, so
  DNS rebinding has no second answer. A raw socket fails with "Network is
  unreachable"; a package that needs one gets a reviewed exception in
  `factory/sizing` (a bridge network of its own). A task that needs a model
  gets an agent sidecar of its own, on its network only, with the keys file
  read-only and its caps (calls, tokens, wall time); the dispatcher refuses to
  start with an agent key or a GitHub token in its own environment and keeps the
  host's per-day budget from the usage each sidecar writes where its task
  cannot. So a recipe that subverts its sidecar reaches that task's answers
  and keys only, never another contributor's draft or an audit's verdict,
  and an audit's agent belongs to the audit, whose container runs no recipe.
  The audit quotes the build's output as data, has no tool with side
  effects, and its report is evidence for a maintainer, never a gate.
  An internal network's bridge address is otherwise the host itself, so
  the dispatcher asks the engine to leave it off: Docker's isolated gateway
  mode (Docker 28 or newer; an older daemon is refused) or, on podman's own
  CLI, a network without DNS. Stated plainly: podman behind docker's API
  cannot be asked (it forces DNS on and drops docker's option), so there a
  service of the host listening on all addresses is reachable from a task
  unless the host's firewall (`prep-root.sh`'s INPUT drop for the task
  subnets) closes it. A signed `factory/sizing` exception is per package:
  it also covers a contributor's recipe of that package, so its reviewer
  approves exactly that.
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
- **A stopped task never has two runners (#277, part 2).** A job token is
  stateless and checked for its scopes only, so a process that was stopped
  keeps what its token allows until the token's end. Stop its task therefore
  never gives the task back at once: it fences the lease — still the
  stopped worker's, so no other worker takes it and the ring lock still
  holds its ring —, and every heartbeat, report and staging upload of it is
  refused with the pool's `stop`, and renews nothing. The task goes back to
  the queue at the worker's next claim, which proves its processes are gone,
  or when the lease ends, when every token of it has expired. An audit's or
  a trial's report names the staged build, not the job, so it is taken only
  while the job's own task (the token's) is still its worker's and not
  stopped. On the worker, the stop kills the task's process groups and
  removes every container labelled with the task (`com.omarchy.task`,
  created ones too); in a builder's broker, a stopped task's hold is let go
  only for a builder whose claim declared `stop-task` — one that stops on
  the word; declaring orders alone is not that, since #277's first part
  takes orders and builds a stopped task on —, then no claim and no order's
  answer passes while a call of that task is still in flight through the
  broker (an upload the stopped builder's shell is inside: bash runs the
  stop's trap only once that `curl` returns) and for thirty seconds after
  the stop or that call's return, whichever is later, and the broker never
  takes that task up again (its pinned calls refused until the lease's end,
  and a view that carries `stop_order` never adopted). A builder from before
  #277, or from its first part, builds on: its broker keeps the hold, so its
  recipe claims nothing, and the lease's end gives the task back. What stays
  open: the worker's next claim is taken as the proof that the stopped
  task's processes are gone, which holds for the one process a token is
  meant to have. A copied token whose second process starts claiming while
  the first is inside a task is not seen as two processes — only the second
  claims —, and its claim after a stop gives the task back while the first
  may still run it, until its next heartbeat (within 5 minutes) or its
  token's end. Two processes on one token is a token to revoke, as the pages
  say whenever they see one.
- **Drains and stops are the pool's, and bounded (#277, part 2).** A drain
  holds at the claim for every image, until a Resume: a contributor's
  machine its owner drained goes back to work on its owner's word only; a
  maintainer who must keep it out revokes it, or sets it to its owner's
  packages only. A project worker — trusted on two maintainers' word, and
  it may be a contributor's machine — goes back to work on a maintainer's
  word: its owner lifts only a drain of their own. Six drains an hour per
  worker at most; a resume is never counted, not in the login's twenty nor
  in the worker's hour, so no run of drains can keep a worker out. Stop its task counts with the restarts (six an hour per
  worker) and in the login's twenty; it never cancels — a stranger's build
  goes back to the queue, where another worker takes it. When every live
  pool or review worker of an architecture is drained, Status says so as an
  error.
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
  Workers listing of a Worker from before #277 spreads the whole row, in
  `GET /factory` and in `GET /users/:login` (revoked workers too). It would
  serve every column this Worker's listing withholds: a worker's `site`,
  its process's `instance` (which `instance_finished` copies at every
  finished task), the rules' state and the rollout report. None of them
  gives a power by itself. A site is kept under its owner's name, and an
  instance binds an order only for its own token. They are cleared anyway
  when a Worker from before #277 is deployed again (#295):

```sql
UPDATE build_workers SET instance = NULL, instance_prev = NULL,
  instance_since = NULL, instance_conflict_at = NULL, instance_other_at = NULL,
  instance_churn = 0, instance_finished = NULL, site = NULL, auto_orders = NULL,
  agent_error_since = NULL, agent_error_class = NULL, agent_probed_at = NULL,
  rollout = NULL, order_kinds = NULL, watchdog_exits = NULL
WHERE instance IS NOT NULL OR instance_prev IS NOT NULL OR instance_since IS NOT NULL
  OR instance_conflict_at IS NOT NULL OR instance_other_at IS NOT NULL
  OR instance_churn != 0 OR instance_finished IS NOT NULL OR site IS NOT NULL
  OR auto_orders IS NOT NULL OR agent_error_since IS NOT NULL
  OR agent_error_class IS NOT NULL OR agent_probed_at IS NOT NULL
  OR rollout IS NOT NULL OR order_kinds IS NOT NULL OR watchdog_exits IS NOT NULL;
UPDATE build_tasks SET stop_order = NULL WHERE stop_order IS NOT NULL;
```

`instance_churn` goes back to its default 0: it is NOT NULL, and a NULL
would fail the whole UPDATE. `drained_at`, `drained_by` and
`drain_reason` stay. They are a person's standing drain, this Worker
serves them as `drained`, and it needs them back after a roll-forward
(the older Worker does not honour a drain meanwhile). A task's
`stop_order` goes, because the older Worker never clears it, and a stale
fence would refuse a later lease after the roll-forward. The first claim
after a roll-forward declares everything again: a new process, its site,
its orders and its rollout. A worker test keeps this list in step with
what the listing withholds.

The rollback workflow (`rollback.yml`, `factory/bin/release-rollback`)
takes this step itself when the release it goes back to is from before
#277. It runs just before that release's Worker is deployed, once more
right after it, and a third time once `/version` reports the older
release. Until the older Worker serves, the one from #277 writes these
columns back at every claim; the older one never writes them.

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
  so a maintainer can verify the worker their host runs is the project's: by
  one exact cosign, only from `release.yml` (or `rollback.yml`) on `main`, and
  checked against that exact identity, never a pattern (#308).
- **The task build images are pinned by digest** (#312). Every task's build
  container starts from `docker.io/library/archlinux:base-devel` (x86_64) or
  `docker.io/menci/archlinuxarm:base-devel` (aarch64, a third-party
  account): tags, which whoever controls them can move. `release.yml`
  resolves each tag to the digest it names at release time
  (`factory/bin/build-images`) and fails when either does not resolve; the
  release carries both (`build-images.json`, the host bundle's
  `inner.images.build`), the host set hands them to the dispatcher as
  `OMARCHY_BUILD_IMAGE_AARCH64` and `OMARCHY_BUILD_IMAGE_X86_64`, and
  `omarchy-agent lint-set` refuses a dispatcher without them. A moved tag
  changes nothing that builds until the next release resolves it again. No
  one reviews that resolution: the release is approved before the digests
  are taken, so the job summary shows them, to compare with the previous
  release's `build-images.json`. Only a worker that was not given them (a
  legacy role container, until it retires) still builds from the tag, and
  says so once per process for each architecture.

## Rollback statements

A maintainer's host under the host agent never goes below its floor (the
highest release it applied) on the pool's word: only on a rollback
statement that `rollback.yml` signs on `main` (#314, design v2 §5.3). The
pool relays statements and cannot forge one.

**Written and stored.** `factory/bin/release-rollback`, which `rollback.yml`
runs in the reviewed `pool` environment, writes the statement before
anything moves and signs it keyless with the pinned cosign (`cosign
sign-blob --bundle`, a Sigstore bundle v0.3). Once the Worker of the target
release is deployed it stores the statement and its bundle in R2
(`omarchy-packages`: `rollback/latest.json`, the last one stored, for the
next `seq`, then `rollback/<to>.sigstore.json` and `rollback/<to>.json`).
`GET /api/v1/factory/rollback/:to` relays the latest one for that target,
public and cached for a minute, `404` while there is none. The relay exists
only in releases from #314 on: a rollback to an older release stores its
statement, but the Worker it deploys cannot hand it out (a host gets a
`404` and stays where it is) until a newer release ships, which
`min_release` covers once hosts run the agent.

```json
{"schema":1,"seq":7,"to":"v1.13.4","retracts_through":"v1.14.2","issued":"2026-10-20T14:00:00Z",
 "agent_to":null,"run":"https://github.com/firemanxbr/omarchy-pool/actions/runs/…"}
```

- `seq` is one above the last statement stored (the first is 1).
- `to` is the release to go back to.
- `retracts_through` is the release rolled back from, or the last
  statement's when that is higher, so the statement retracts every release
  above `to` that an earlier rollback retracted too: a host that missed that
  rollback is still covered. When the pool's release is not a release tag
  above `to` (it cannot be read, or a re-run finds the pool already at
  `to`), it is the highest release tag. Both inputs come from what the pool
  can write (its `/version`, `rollback/latest.json`), so each is taken only
  when it is a release tag of this repository, and a last statement that
  names none moves nothing: `retracts_through` never names more than the
  highest `v*` tag at signing, which the tag rulesets protect (#308). A run
  to the highest release (nothing above it) writes no statement.
- `issued` is the run's own time, for people; the agent goes by the log's.
- `agent_to` is null: a rollback keeps the agent (D8). A later statement
  that names an agent version is the only thing that moves the agent down.
- `run` is the `rollback.yml` run that signed it.

**What the agent accepts** (the run loop, #315, implements this contract;
`omarchy-agent verify --statement` does the first two by hand). A statement is
taken when all of these hold, and otherwise ignored, the host staying where
it is:

1. Its bundle verifies offline against the embedded Sigstore root, and the
   certificate is exactly
   `https://github.com/firemanxbr/omarchy-pool/.github/workflows/rollback.yml@refs/heads/main`,
   issuer `https://token.actions.githubusercontent.com`, event
   `workflow_dispatch`, and the pinned repository and owner ids — a
   `release.yml` signing, another ref, a fork or another repository is
   refused.
2. It parses strictly as schema 1 (an unknown field is refused; a newer
   schema means "update the agent first"), with `to` below
   `retracts_through`.
3. `seq` is above the last statement the host accepted.
4. `to < floor ≤ retracts_through`: the host is inside the retracted range.
5. `to` is at or above the merged `min_release` and not in the merged
   `revoked` list.
6. **Depth bound (D25):** the signed `created` of `to`'s manifest is at most
   14 days before the statement's Rekor integrated time — both signed
   times, never the host's clock and never a count of releases. A deeper
   rollback is a forward-fix release built from the old code (or, from P5, a
   maintainer co-signature).
7. `to`'s own host bundle verifies (`verify --bundle`).

It then sets `floor = to`, preempts an in-flight rollout and skips soak and
the brake. Going forward again needs nothing special.

**What bounds it.** A statement is only as strong as the run that signed
it: the `pool` environment admits `main` only and waits for a maintainer's
approval (#308), and the daily token probe checks that no token the pool
holds can dispatch `rollback.yml`. One wrongly approved dispatch can send
hosts back at most 14 days, to a release that is neither revoked nor below
`min_release`. A pool that withholds a statement keeps hosts where they are;
one that serves an older one gains nothing a genuine statement did not
already allow (its `retracts_through` was at most the highest release then,
below a host's floor since), and a host that took a newer one refuses it
(`seq` must rise). `seq` is read from `rollback/latest.json`, which the pool
can write: a pool that rewinds it makes the next genuine statement repeat a
`seq` hosts have passed, so they refuse it, which only withholds a rollback,
as not relaying does. A run that signs and then fails before the store (the
images or the deploy fail, and everything is put back) leaves a valid
signature in Rekor over bytes anyone can rebuild; a pool could serve that
statement although that rollback never took effect, but a maintainer
approved that dispatch and every rule above still applies to it.

## Maintainer hosts

Only a maintainer provides a host, and the host is trusted by the act that
made them one: a pull request to `factory/MAINTAINERS.toml` another
maintainer approved (decision S2). There is no per-host trust grant. The
enrollment (#321, design v2 §6.1) binds a machine to that person:

- **The token** (`ome_…`) is minted on the maintainer's own page — the
  browser session's only, as Confirm, so a stolen CLI token cannot leave
  hosts waiting there for a careless Confirm — after the pool reads the
  synced list again; it is bound to their login **and their
  GitHub user id** (recorded at every sign-in), lives 15 minutes and works
  once. A login renamed or taken by someone else is not its owner.
- **Enrollment** carries the machine's new public key and a signature of
  the token and the key with it (proof of possession), what the machine is,
  and its capacity report. In one D1 batch the pool checks the token is live
  and unused, its login is still listed and still the same GitHub user, burns
  it and creates the host in `pending-owner`. A host below the release's
  signed minimum (`factory/bundle/manifest.toml`, the file `release.yml`
  signs into every host bundle) is refused before anything is written.
- **Confirm.** The machine prints its key's fingerprint; the owner's page
  shows the same, and only the owner's Confirm — while still a maintainer —
  gives the host its worker registration. Confirm is the browser session's
  only, from the pool's own page: a bearer token (an `omc_` CLI token, or a
  GitHub token turned into one) is refused, so one stolen token does not
  make a project-trusted host. A token stolen before use enrolls nothing the
  owner does not see and confirm. The journal and Status say it, and the
  other maintainers see a notice; no approval is asked (D40), and the pool
  writes the signed trust record the per-worker door writes
  (`workers/<id>/trust-<time>.json`: the host, its fingerprint, who
  confirmed). The per-worker trust door does not move a host's
  registration: its trust is `MAINTAINERS.toml`'s. Confirm asks no passkey
  yet: one stolen browser session of a maintainer could still mint, enroll
  and confirm a machine of its own. A passkey assertion on Confirm, as
  Approve's (#271), is the named seam for a later issue.
- **Signed requests** (D7). Every later call carries `Omarchy-Host: <host>;
  ts; nonce; sig`, the key's signature over the method, the path, the body's
  SHA-256, the time and the nonce. The pool checks the key, `|ts − now| ≤
  120 s` and that the nonce is new (`host_nonces`, pruned by the cron after
  five minutes), so nothing is replayable. A signed request reads the host's
  state, fetches or rotates its worker token and reports; it cannot claim,
  change the maintainer list or widen anything.
- **The host worker token** (`omw_…`) is the dispatcher's only, written
  0600 to `etc/dispatcher.env`. The agent writes it, and the registration's
  id, only in the shapes the pool mints (`omw_` and 48 hex digits; letters,
  digits and dashes), so a pool cannot add a variable to the dispatcher's
  environment; strings the pool sends reach the terminal without control
  characters. It is a new one at every fetch; the agent
  rotates it every 30 days. The one it replaces works ten more minutes (kept
  on the host's row, never on the registration that older Workers list), so
  only the dispatcher is recreated, and a running task — whose job token does
  not depend on it — never notices.
- **The host report** is at most 16 KiB (its `runtime` at most 2 KiB) and
  refused whole when it carries what looks like a secret (`leak.ts`); the pool counts the host's units
  itself from the reported totals and the signed constants, never more than
  the host declared.
- **A Mac** (#320, design v2 §19.2, §19.3) runs its tasks in the agent's own
  `omarchy` Colima VM (isolation `vm`): a container escape lands in the VM,
  which mounts only the work root (writable), the secrets directory and the
  set directory (read-only, so nothing in the VM can plant a link the agent
  would write through), each at its own path and none under the home
  directory — no `~/.ssh`, no Keychain files, no forwarded SSH agent; preflight
  checks from a container that the VM sees those three and not the home
  directory, and the lint refuses a bind outside them. Docker Desktop's or
  OrbStack's VM (`vm-shared`) is used only if it is already there, with its
  home mount removed and `--dedicated`. The agent sets the VM's clock from the
  Mac's own after a wake, never from the pool's answer.

## Stopping a host

Nothing irreplaceable is bound to a host (#322, design v2 §6.2, §6.4, D20,
D39): its trust is `MAINTAINERS.toml`'s, and a new install enrolls a new
host. What remains is to stop one cleanly. Every act below is the browser
session's only, from the pool's own page (a bearer token of any kind is
refused), is refused server-side to anyone without the right, and writes a
`host` line in the journal with who and why.

- **Suspend** — its owner or any maintainer, with a reason. In one D1 batch:
  the host's key is refused on every signed request, its registration's
  claims are refused (`403`, `host_suspended`), its open orders are
  cancelled with a line each, and its running leases are **fenced** in one
  statement (`UPDATE build_tasks SET stop_order = … WHERE lease_owner = …
  AND status = 'leased'`), one `stop-task` order row per task, written
  closed so a host holding several leases is fenced whole. A fenced lease's
  heartbeats, reports and uploads are refused from then on; it goes back to
  the queue when its lease ends, with the person and the reason on its
  line. A claim already in flight when the suspension commits leases
  nothing: the claim's lease `UPDATE` checks the host in the same statement
  (D1 serialises writes), the earlier read only gives the refusal its words.
  **Resume** is the owner's only, with a passkey (`host:resume:<id>`):
  the same registration claims again, nothing is done on the machine.
- **Retire** — its owner, or any maintainer with a passkey
  (`host:retire:<id>`), with a reason. The host key is refused for good —
  the pool keeps it, so it never enrolls again — and the registration is
  revoked with its worker token; its open orders are cancelled and builds
  asked for it go back to the rule. Running leases end with their lease, as
  a revoked worker's: they are not fenced, so the job token each one holds
  (that task's routes only, until its lease ends) may still heartbeat,
  upload and complete it. To stop them at once, suspend first. A new install on the machine enrolls a new host with a
  new key (the agent sees `retired` on its signed request and enrolls again
  with the new token).
- **Drain** — a worker order on the host's registration (stop claiming, let
  the tasks finish). A drain by the owner is resumed by the owner only (they
  may need the machine); a drain by another maintainer by either of the two
  (D57).
- **Removal from the list** (D39). Hosts are owned by GitHub user ids, and
  the file lists logins: the pool resolves each listed login to its id
  through the contributors' sign-in records, so a login renamed in the file
  is not a removal. Every claim of a host's registration joins its owner's
  id with the list, so a removal holds from the next claim, between syncs
  too; the sync (every ten minutes) marks every host whose owner no longer
  resolves (`owner_removed_at`, one journal line each). Claims answer *the
  host's owner is no longer a maintainer*; **nothing is fenced**: running
  leases heartbeat, finish and upload, so a mistaken pull request or a parse
  slip costs new claims for ten minutes, not builds in flight. Listed again,
  the owner resumes claiming on all their hosts with one action and a
  passkey (`host:resume-all:<login>`); a suspended host stays suspended.
- **Removed for cause** — a separate, explicit act on the owner's page by
  another maintainer (never the owner), with a passkey (`host:cause:<login>`)
  and a reason: every host of that owner that runs or is suspended is
  suspended for cause and their running leases are fenced in one statement,
  journaled. Taking the person off `MAINTAINERS.toml` stays a pull request;
  this stops their machines meanwhile. A host suspended for cause is still
  resumed by its owner only — who needs a passkey, which only a listed
  maintainer is asked for — so once the pull request lands, nobody resumes
  it. Until then the owner, with their own passkey, can resume it (design
  v2 §6.4: Resume by the owner), and their hosts still waiting for Confirm
  are not touched: the pull request is what closes both.
- **The agent on a suspended or retired host** sees `403` on its calls
  (its signed requests, and in P1 the release `follow` it polls, refused
  for a suspended or retired host's registration and never cached): it
  changes nothing, keeps its bundle and every task container running, polls
  hourly with jitter and never exits (§16.4); it recovers by itself at its
  next poll after a Resume. An owner removed from the list sees `403` on its
  claims only.

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

## A maintainer's first passkey

Maintainers come from one place: the logins `factory/MAINTAINERS.toml`
lists on `main`, changed only by a reviewed pull request (the repository
admin's bypass stays visible on the pull request and is against the
project's rules: see the Governance chapter's *Bootstrap, and the one door
left*), and applied by the brain every ten minutes (a `role` line in the
journal). Nothing on the site names one. A maintainer the file just named
holds no passkey, and approve, block, a forced promotion and a reset of
another maintainer's passkeys need one. The passkey stays required (#287,
option A, decided on 2026-09-29): the site guides the maintainer to it
instead of stopping them.

- **Told before it matters.** `/auth/me` tells a maintainer's pages whether
  they hold one (`passkey`: one entry of the passkeys' index, and no other
  role's answer carries it). Once the browser knows the login holds one, it
  says so (`?held=<login>`, kept in `localStorage` until a sign-out or a
  refusal that says none) and the pool reads nothing for it: a maintainer
  who holds a passkey costs the pool what a page view cost before #287. The
  flag only draws the page; every act still checks the passkey itself. A
  notice says what needs a passkey and that nothing else does, with
  *Register a passkey now*: always on Review and on their own page while
  they hold none, and once on the first page they see as a maintainer. The
  browser keeps that it was shown (`localStorage`): a page view writes
  nothing to the pool.
- **Registered at the moment of need.** The Approve, Block and Force dialogs
  (and a reset's), and the page of an agent's approve or block draft, offer
  *Register a passkey and approve* (… and block, … and force). The first
  press registers the passkey through the same two routes as the person's
  page (`POST /auth/passkeys/challenge`, `POST /auth/passkeys`): the session
  alone, and the first passkey only — the insert still refuses a second
  without an answer from one the login holds. The dialog stays open. Its
  next press asks for the assertion for exactly that act and login (`POST
  /auth/passkeys/assert`, or the draft's own challenge), and the act is
  posted with it: the challenge is bound to the act, as for any passkey. A
  cancelled registration registers nothing and decides nothing, and the
  dialog says so.
- **One registered elsewhere meanwhile.** The pool's options list the
  passkeys the login holds (`excludeCredentials`). When they list one, it
  was registered since the page loaded: in another tab, on another device,
  or by whoever else holds the session. The dialog then asks the device for
  nothing (a browser holding that passkey would refuse to make another) and
  goes on with the one held. It says where that passkey is listed (the
  person's page) and that one they did not register is another maintainer's
  to reset: the one moment a planted key could be noticed is not spent
  calling it theirs.
- **No new door.** The flow adds no route and takes nothing the routes did
  not take before. A stolen session could register a first passkey on the
  person's page before #287, and it still can: the registration is a
  `passkey` line on the public journal, and another maintainer resets it.
- **On the record.** A decision confirmed with a passkey's first use, within
  ten minutes of its registration, says so on its journal line ("… with a
  passkey registered just now", `registered_just_now` in the payload), read
  from the row the assertion reads anyway.
- **Everything else stays free.** Claiming, the review workspace, request
  changes, reject, adopt, lifting a block, a category, withdrawing an
  approval, a worker's trust and its revocation, an order to a worker of
  any kind and taking one back (#277), a dry run, a rollback, a promotion
  the gate decides, a cancel and a note take the session or the token and
  no passkey. `worker/test/passkey-guided.test.ts` pins the list, every
  order kind included.

## What a compromise costs

| Compromised | Blast radius | Recovery |
|---|---|---|
| a contributor's token | their registrations and their staging folder | they register again (the old token dies) |
| a community worker's token | claims of that owner's tasks; uploads to those tasks' staging | its owner or a maintainer revokes the worker |
| a job token | that task's writes, until its lease ends | expires by itself; the task can be cancelled, or stopped from its worker's page (its lease is fenced — nothing it sends is taken, nothing renews it — until the worker has stopped, #277) |
| a project worker's token | claims of pool jobs — each still executed with a scoped job token — until revoked | a maintainer revokes the worker |
| a maintainer's token | rejections and requests for changes (never on their own package), one word on a worker's trust, withdrawals, lifts, a pool job by hand — a rollback inside its ring, a promotion the gate still decides —, a dry run by hand and a note on the journal (#284: a build queued by hand never publishes, and the gate's evidence is the jobs' alone), and orders to any worker, 20 an hour (#277: a restart, a drain or a stopped task at worst — a delay, and a drain of everything is an error on Status —, never a publish or a cancel) — not an approval, a block nor a forced promotion: those take the browser's session and the maintainer's passkey (#271, #284) | the person replaces the token (their page's *Token*: the old one stops working), and a reset of their passkeys revokes it (#284); a governance pull request removes the login; decisions and builds are journaled and reversible (rollback); trust takes a second maintainer |
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
