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
| Contributor token `omc_…` | one person (GitHub identity read once, never stored) | register packages under their name, queue community builds, revoke their workers and give them orders from the worker's page or the API (re-check the agent, restart, restart the agent service, drain and resume, stop the task in hand, update; #277) — registering one is a maintainer's (#331), and a community registration whose owner is no maintainer claims nothing (#343) —, read their own state | write to the pool, claim jobs, approve | live; replaced from the person's page, revoked by a reset of their passkeys (#284) — then made again on that page only, never with a GitHub token |
| Worker token `omw_…` | one machine, registered by a maintainer (#331) | claim tasks its trust allows (community: contributors' builds, anyone's; project: pool jobs too; a host: every kind its phase enables); heartbeat | write to the pool or staging directly | live |
| Job token `omj.…` | the worker running one task, for the lease | the routes that task needs — e.g. `sync`: upload objects, index, create a release in one ring, store that ring's databases; community `build`: upload to that task's staging folder, and nothing into the journal (the health and abi rows the gate reads are the project's jobs' alone); a dry run (`publish` 0): its task and the journal, no pool and no ring (#284) | anything outside its scopes (403, journaled); anything after the lease (30 min, renewed by heartbeat) — a task stopped from its worker's page is not renewed, and goes back to the queue only once its worker has stopped or the lease has ended, so no second runner overlaps its token; an audit's or a trial's report beside a staged build is taken only while the job's own task is still leased to its worker and not stopped (#277) | live |
| Maintainer role | a contributor listed in `factory/MAINTAINERS.toml` on `main` — one list, no groups (applied by the brain every ten minutes) | withdraw a record from the public bucket (a signed tombstone says why); approve or reject staged builds (recorded; approve, and a block, in the browser with their passkey, #271); queue any pool job by hand (`POST /factory/jobs`; a promotion forced past its evidence in the browser with their passkey, #284); queue a dry run by hand, cancel, remove a registration; give any worker orders (the same list), capped at 20 an hour per login and on the journal — none of them needs the passkey (#277); review governance pull requests | write to the pool with their own token (a job does); publish a build queued by hand (#284: a dry run only); write the gate's evidence (#284: a journal note only); roll a ring back to another ring's release; operate as a worker; grant a role | live |
| Agent token `oma_…` | one agent on one person's machine, granted by that person in their signed-in browser (`omarchy-cli login`: a loopback address and PKCE), kept in `~/.config/omarchy-cli/credentials.toml` (0600) and bound to the origin that granted it | the tools of `omarchy-cli mcp` its scopes hold, as that person: request and follow packages (`contribute`); claim, release, read evidence and draft a verdict (`review`) or a block (`block`) — the two a maintainer's only, read again on every call; twenty calls a minute, five requests, ten claims and thirty drafts a day | decide anything — approve, request changes, reject and block are drafts the person confirms in the browser, approve and block with the person's passkey; every other route (403); give the project's agent a hint; outlive seven days with `review` or `block`, ninety with `contribute` | live; revoked by `omarchy-cli logout`, the person's page, a block of the person, or a reset of their passkeys (#284) |
| Passkey (WebAuthn) | one maintainer's authenticator — a security key, a phone, a laptop's platform authenticator — registered with the browser's session, on their own page or, the first one, in the dialog of the act that needs it (#287); the pool keeps the credential's id, its public key, the algorithm (ES256, EdDSA, RS256), the RP id `omarchy-pool.org`, the counter, a name and two dates (`passkeys`, migration 0040) | decide approve and block — an agent's draft confirmed (#257), and the web's own buttons (#271): an assertion with the user verified — the person's fingerprint, face or PIN, as the authenticator reports it (attestation `none`: the pool takes the authenticator's word on that) — for a challenge bound to that login and that draft or act, checked by the Worker against the stored key (`webauthn.ts`), the counter moving forward; vouch for a second passkey of the same login, and for a removal; confirm another maintainer's reset of a lost one (#271); force a promotion past its evidence, for exactly that promotion (#284) | be registered or used with a token of any kind, from another origin, or for another relying party; stand in for the session (every door takes both); confirm another act than the one its challenge was issued for; be replayed (each challenge is taken once) | live; ten per maintainer; the first registered with the session, every other with one the login holds; removed by its owner with one they hold, or reset by another maintainer with a reason (the login signed out, its token and its agents' grants revoked, #284, a signed record); registration, removal and reset are journal lines (`passkey`) without the key |
| Host enrollment token `ome_…` | the maintainer who pressed *Add a host*, for the one command they paste on the machine (in the environment of `sh`, never an argument) | enroll one host, once, within 15 minutes, as that maintainer — while they are still in `factory/MAINTAINERS.toml` and still the same GitHub user id | claim, confirm the host, or enroll a second one | live (#321); stored as its SHA-256; burnt by the enrollment in the same D1 batch that creates the host |
| Host key (Ed25519) | one maintainer host's agent: `host.ed25519`, mode 0600, made at install, never in a container | sign the host's calls (`Omarchy-Host`: method, path, body hash, time, nonce): read its state, fetch or rotate its worker token, report, post the diagnostics its own order asked for (#325) | claim, change the maintainer list, widen the owner's envelope; be replayed (a nonce table), act from a clock 120 s off; act before its owner confirmed its fingerprint on the site | live (#321); a suspended or retired host's key is refused |
| Owner's pinned passkey (at the host) | one maintainer host's agent, for its owner: the COSE public key, credential id, algorithm and relying party of one of the owner's passkeys, pinned with `omarchy-agent envelope pin-passkey` and kept in `state/owner.json` (0600) | let the host take a `widen-envelope` or `set-agent-keys` document the pool relays (#328, D6 b): only one this passkey signed, for this host, on its pool's origin, user present and verified, within its hour and under a version above the last it took | be used by the pool or another passkey; widen above the release's signed constants or the detected hardware; set any key but the six agent keys; be replayed | live (#328); unpinned at the host, the site widens nothing |
| Seal key (X25519) | one maintainer host's agent: `state/seal.x25519` (0600) on Linux, the login keychain on a Mac; its public half reported, its fingerprint confirmed once by the owner on the host's page | open the agent keys the owner's browser sealed to it (HKDF-SHA256, AES-256-GCM, bound to the host and the key's name) into `OMARCHY_SECRETS_DIR/agent.env` | sign anything; take a sealed key that the pinned passkey did not sign; be read by the pool, the dispatcher or a container | live (#328); a key made again is confirmed again before anything is sealed to it |
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
| Host | the workers: every one is provided by a maintainer — the project's compute is its maintainers' hosts. A maintainer's host is trusted by the same act that makes them a maintainer | enrolled by a maintainer listed in `factory/MAINTAINERS.toml` at the last sync (*Maintainer hosts* below, #321), owned by their GitHub user id, confirmed by fingerprint; a legacy registration (`POST /factory/workers`) keeps claiming until a maintainer revokes it — a community one only while its owner is listed (#343). A removal from the list stops its claims and lets its running tasks finish (*Stopping a host* below, #322) |
| Community worker | none: the tier ended (#307, #343) — contributors run no worker, the command that ran one and a worker's mode are gone (`GET /omarchy-worker`, `POST /factory/workers/self/mode` and `/factory/workers/:id/mode` answer 410 with the pointer to the maintainer-host docs). The community registrations left — the maintainers' own legacy sets, checked on #331 — build any contributor's packages, as a host does, selected as hosts with one lane and one build, until they retire (P3); one whose owner is not a maintainer (a contributor's from before #331, or an owner the list dropped) is refused at the claim (`403`, `owner_not_maintainer`), counts as nobody's capacity and is never pinned, so it never builds a stranger's package on a non-maintainer's machine; a maintainer's set that was dedicated (its owner's builds only) takes anyone's from #343 on, its owner told before that deploy (RUNBOOK, *Once, before the deploy that carries #343*) | no new one |
| Project worker | pool jobs (sync, render, promote, health, security, gc) and the rebuild of approved packages — never a build without evidence and review | the legacy registrations that hold it were given it on two maintainers' word, each step a signed record under `workers/<id>/` that stays as history; no worker is trusted one by one any more (#343: `POST /factory/workers/:id/trust` answers 410) — a host's trust is the pull request that names its owner in `factory/MAINTAINERS.toml` (S2). The Review page names the worker and host behind every build |
| Maintainer | provide the project's hosts, approve the project's staged builds — never their own package, but the one maintainer the file's `[solo]` table names while it is there (#394, *The solo-maintainer exception* below) — settle categories, block with a reason, withdraw a record, review governance | listed in `factory/MAINTAINERS.toml`, merged with another maintainer's review |
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
  holds the host's worker token (a read-only file, never its environment,
  #327) and each lease's job token, and starts every
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
  engine's word, whatever the script said. A task on an emulated lane runs
  its architecture under the host's binfmt handler and is told only
  `WORKER_LABELS={"emulated":true}` (#338); the `needs_native` that gives a
  build its attempt back counts only from a lease the pool itself put on an
  emulated lane, so a recipe on a native lane cannot buy its attempts back
  with it, and one that says it on an emulated lane never runs emulated
  again.
  Its caches are the host's to fence, not the script's (#341, D52; design
  v2 §10.2 invariant 9): a build mounts only its own package's build cache
  on its own side (`cache/build/<trust>/<arch>/<package>` at `/build/cache`,
  cut by the dispatcher from the lease), never the tree, another package's
  or, from a community task, a project cache; an audit and a trial mount
  none. Every task mounts the host's pacman cache of its lane read-only (a
  build's and an audit's pacman's first `CacheDir`; a trial's check, which
  installs the lab above edge, reads none) and downloads into a writable
  cache of its own, so no recipe plants a package another build installs and
  two builds never write one file. What a task downloaded enters the shared
  cache only when its SHA-256 is the one the pool's signed databases list for
  that file name (each database's `.sig` verified with the pool's key the
  dispatcher carries; a name two databases list with different bytes is never
  merged), and with the pool's own copy of its upstream signature beside it
  (the very `.sig` the task downloaded, when it downloaded one) or not at
  all: a task's own `.sig` never enters, since a wrong one — or none — beside
  a package of a repository whose `SigLevel` checks packages fails every
  build that installs it, and pacman cannot delete it from a read-only
  cache. Everything else is discarded, and a file whose name the databases
  later list with other bytes leaves the shared cache at the next pass, its
  signature after it. The caches stay within the envelope's `cache_caps`.
  The dispatcher refuses to start with a package signing key in its
  environment: the pool signs what is published. CI renders every kind's
  container and fails on anything outside that spec (`dispatch/spec.rs`), and
  runs the dispatcher on a real engine (`tests/dispatch-engine.sh`).
- **What a contributor wrote, in a sandbox, where the host has one (#330, D43).**
  A contributor's recipe is the code most likely to try an escape, and on a
  host it runs beside the dispatcher's tokens — as root on a rootful engine
  without remapping (design v2 §10.4, §19.3). When the host's engine has
  gVisor's `runsc` or Kata Containers, the agent finds it: a smoke run of the
  release's build image under it must print a kernel that is not the
  engine's own, so a runtime on the host's kernel — docker's CLI on podman,
  whose API does not pass `--runtime` on — is never taken for one. The
  dispatcher then starts, with `--runtime <it>`, every task that runs what a
  contributor wrote — decided by what runs, not by the trust label: a
  contributor's build; the project's review rebuild, whose recipe the
  project's drafter wrote from the contributor's evidence before anyone
  approved it (§9.5 says it can be subverted); the trial that installs what
  that rebuild built, install scriptlets and all; the audit that reads it;
  and any kind or trust the dispatcher does not know. An escape from them
  lands in gVisor's user-space kernel or in Kata's VM, not on the host. Only
  the project's own recipe — on main, or a maintainer's dry run — runs on the
  engine's own runtime. A sandbox covers the native lane only: an emulated
  lane runs its architecture through the host kernel's binfmt handler, which
  a sandbox's kernel does not have, so the pool hands a host whose
  dispatcher applies a sandbox none of that work for its emulated lanes —
  only the project's own recipes — and the dispatcher hands back one that
  reaches them anyway, before anything runs. The dispatcher never runs such a
  task outside a sandbox the host says it has: a runtime the engine refuses
  fails the start (`lost`) and holds its claims (30 minutes, doubled after
  each further refusal in a row, a day at most; a restart of the dispatcher
  ends it), and a capacity file whose sandbox it cannot read claims
  nothing. Each claim says the sandbox the dispatcher applies; the pool
  selects on that and the host page (*Sandbox*) shows it — not merely what
  the agent found, which a dispatcher from before #330 ignores — with why
  one the engine has is not used and why the claims hold. The envelope's `sandbox` (`"off"`, or one
  runtime's name) is the owner's, set at the host: a signed widening from
  the browser (#328) never sets it. A host without one runs these tasks as
  before, at its isolation level. A package with a signed network exception
  (`direct_network`, #373) changes its network, never its runtime: on a
  granted host its task runs on its bridge in the sandbox all the same. Stated plainly: a sandbox's kernel is a
  smaller surface, not none — a bug in gVisor's, or in the gofer that serves
  the task's mounts, is still an escape — and the task's own mounts (its
  directories, the release's checkout read-only) are the host's files
  either way. Its sidecars run the signed worker image on the engine's own
  runtime, and the sandboxed recipe reaches them over its internal network
  (design v2 §10.1): a recipe that first compromises its egress or agent
  sidecar runs code outside the sandbox, and can try an escape from there
  at the host's isolation level.
- **Pool jobs stay in the dispatcher; their check containers go through the
  spec (#340, D34).** A host's pool jobs — sync, render, promote, rollback,
  security, gc, verify, relayout, enqueue, publish, health — are the
  release's own signed code, trusted like the dispatcher: each runs in a
  child process of it (`pkg-repo pool-job`) with its lease's job token, as a
  legacy pool worker runs them, under a 2 GB memory limit and a time limit,
  killed whole when it overruns; it never holds the host's worker token nor
  the name of its file (#327), and it reaches no task network. The containers its scripts start run package
  code (a health check's pacman, an ABI gate's install of a ring, the
  enqueue's reader, which sources the recipes on `main`), so they go
  through the one spec: the job's only engine is `omarchy-task-run`
  (`RUNTIME`, and `docker` and `podman` first on its `PATH`), which takes the
  one shape the scripts use — `run --rm --platform … [-e KEYRING=…] -v
  <the job's scratch dir>:/repo[:ro] <an image the release pins> bash
  /repo/<script>.sh` — and runs it on the job's own internal network behind
  its egress sidecar, made as a task's are (never a signed exception's
  bridge, whatever the owner's envelope grants: `direct_network` is a
  package build's, #373), with the job's unit, the task container's
  capabilities, that one directory and no token; any other shape, verb or
  flag is refused before the engine is asked. They run on the engine's own
  runtime on a host with a sandboxed runtime too (#330): what they run is the
  project's own — the release's scripts in its pinned images, over what a
  ring serves (signed, after the maintainers' approval) and the recipes on
  `main` — as the project's own recipe does, and on any lane of their
  architecture, an emulated one included, which a sandbox's kernel cannot
  run. A sandbox hold holds a host's pool jobs with its tasks: they share
  its claim. The spec's CI test renders
  every helper the scripts start, and the shim's tests every shape refused.
  Hosts take pool jobs only once the maintainers' `host-pool-jobs` setting
  names them.
- **Each task on its own network, its own egress, its own agent (#336).**
  A task container is on an internal network of its own (a /28 of
  `OMARCHY_TASK_SUBNETS`) that no other task, the host's LAN, the dispatcher
  or the pool is on; the dispatcher joins none. Its one way out is its egress
  sidecar (`pkg-repo egress`), which holds nothing and allows `CONNECT`,
  `GET` and `HEAD` to public addresses only: private, CGNAT, link-local
  (cloud metadata), loopback, multicast and reserved ranges, the task
  subnets and the host's own addresses are refused by the address a name
  resolves to, and the connection goes to the address that was checked, so
  DNS rebinding has no second answer; an IPv4 address is refused in every
  IPv6 form that reaches it too (v4-mapped, NAT64, 6to4). The host's own
  addresses are the agent's word, in `etc/dispatcher.env` (#371): every
  address of its interfaces (an IPv6 one as its /64) and the public address
  its tasks leave from, which install's egress probe saw first — behind a
  router that forwards a port, a task connecting to it would reach the host,
  and the firewall's INPUT drop does not see that traffic, which leaves from
  the egress bridge. The run loop reads the interfaces again every minute and
  asks the pool's edge for the public address every hour (over IPv4, not
  through a proxy: the way the tasks leave), and within five minutes after an
  ask it did not answer; a change recreates the dispatcher, so every task
  started after a new lease has it refused, and every task started after the
  agent saw a new public address — within the hour while the edge answers,
  within minutes of its answering again after a reboot or an outage — has
  that one refused, while a task already running keeps the list its egress was
  started with. A raw socket fails with "Network is
  unreachable"; a package that needs one gets a reviewed exception in
  `factory/sizing` (a bridge network of its own), which a host runs only
  where its owner's envelope grants it (`direct_network`, #373): elsewhere the
  dispatcher hands the task back before anything starts, as a lost lease (the
  attempt given back twice per task, spent after: a package that only
  non-granting hosts claim fails rather than run on an unprobed bridge). A task that needs a model
  gets an agent sidecar of its own, on its network only, with the keys file
  read-only and its caps (calls, tokens, wall time); the dispatcher refuses to
  start with an agent key or a GitHub token in its own environment and keeps the
  host's per-day budget from the usage each sidecar writes where its task
  cannot. So a recipe that subverts its sidecar reaches that task's answers
  and keys only, never another contributor's draft or an audit's verdict,
  and an audit's agent belongs to the audit, whose container runs no recipe.
  The audit quotes the build's output as data, has no tool with side
  effects, and its report is evidence for a maintainer, never a gate. The
  second opinion runs elsewhere (#339, D36): an audit leaves the machine
  that built what it audits to another that can take it, and an audit of the
  project's copy takes another model than the one that built it whenever a
  host with one was alive in the last 24 hours; every audit records how
  independent it was (`model`, `host`, `none`), shown on Review beside its
  verdict, so a maintainer reads whether the same model judged its own work.
  It errs low: `host` only when the two registrations are certainly on
  different machines (different owners, or two hosts' registrations of
  different hosts), so one maintainer's legacy role containers, which share a
  machine, say `none`.
  An internal network's bridge address is otherwise the host itself, so
  the dispatcher asks the engine to leave it off: Docker's isolated gateway
  mode (Docker 28 or newer; an older daemon is refused) or, on podman, a
  network without DNS, which has no gateway — by podman's own CLI, or behind
  docker's CLI (whose podman API forces DNS on and drops docker's option)
  through libpod's own API on the socket that CLI talks to, which must answer
  as podman (#372). The agent's preflight checks this rather than trusting it,
  and it probes the way a task runs (#373): a probe task on a network made as a
  task's, behind an egress sidecar from the release's worker image with the
  dispatcher's deny list (the task subnets and `OMARCHY_HOST_ADDRESSES`), tries
  the cloud metadata address, the default gateway, the host's LAN address, the
  host's own addresses and its network's gateway on 22, 53 and the pool's
  ports, straight and through the sidecar, and must reach GitHub through the
  sidecar: a connection made or refused there fails the install (the sidecar's
  own refusal, a 403, is what it must answer). Stated plainly: a signed
  exception's bridge always has its gateway, the host itself on a rootful
  engine, where the `DOCKER-USER` rules (in `FORWARD`) never see traffic to the
  host (CVE-2024-29018), and on a rootless engine the engine's namespace, with
  the LAN behind the user-mode network stack; so that bridge runs only where the
  envelope grants it, and there a probe task on it must fail to reach the
  metadata address, the default gateway, the LAN address and its gateway. On a
  rootful Linux engine preflight refuses a host whose prep-root.sh firewall
  script (world-readable) does not drop every task subnet in INPUT, or whose
  boot unit for it is not there or not enabled (a reboot would take the drop
  away, and nothing probes again after install), whatever the probe says: the
  second layer under every task network, with the command that puts the INPUT
  drop in place. Whether the rule is in effect, rather than installed, only a
  granted bridge's probe shows (its gateway and the LAN address are the host
  itself; a rule flushed since the unit ran gets the command that puts it
  back): without the grant nothing a probe task tries crosses INPUT, since a
  task's own network has no address of the host's and no route off its subnet,
  and its sidecar refuses the LAN (#373). On a rootless engine what could reach the host is the
  user-mode stack's host loopback (RootlessKit's, slirp4netns's or pasta's),
  off by default: preflight reads the stack's command line in `/proc` while its
  probe tasks run and refuses one that maps it, with the setting that turns it
  off (the runbook's *Rootless engines*). It reads rather than listening for a
  connection: the agent listens on nothing (design v2 §11.2). pasta can also
  forward an address to the host's own (`--map-guest-addr`, `169.254.1.2` by
  rootless podman's default from 5.3 on): on rootless podman behind pasta the
  probe tries it (a task's own network has no route to it, and its sidecar
  refuses link-local addresses; a granted bridge has one), and an answer
  there, or an address pasta maps that the probe did not try, refuses the
  install with containers.conf's `--map-guest-addr none` (#372).
  A signed `factory/sizing` exception is per package:
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
  never starts from a contributor's staged artifact), builds it on a
  maintainer's host (or a project worker, until P3), a second agent audits
  it, a real pacman
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
  holds at the claim for every image, until a Resume: a community
  registration its owner drained goes back to work on its owner's word
  only; a maintainer who must keep it out revokes it. A project worker —
  its trust given on two maintainers' word before #343, and its owner need
  not be a maintainer — goes back to work on a maintainer's word: its owner
  lifts only a drain of their own. Six drains an hour per
  worker at most; a resume is never counted, not in the login's twenty nor
  in the worker's hour, so no run of drains can keep a worker out. Stop its task counts with the restarts (six an hour per
  worker) and in the login's twenty; it never cancels — a stranger's build
  goes back to the queue, where another worker takes it. When every live
  pool or review worker of an architecture is drained, Status says so as an
  error.
- **A community registration can say an outage that is not there, and only
  its own kind listens (#277).** A worker's agent error is its own word.
  So a community registration counts only toward the breaker that holds
  the community's workers, never the project's, and spends only the
  community's share of the pool's own orders (forty of the sixty a day, six
  of the ten restarts an hour); the project's workers keep the rest. A site
  is kept under the name of who runs the worker: a leaked site of another
  person's host joins neither its election nor its pacing. Only a
  maintainer registers a worker (#331) and the community ones left are
  legacy sets until P3 (#343); the worst a hostile owner of one does is
  hold the pool's automatic restarts of the other community sets — whose
  owners restart them on their own host, or from their page — and put a
  warning on Status.
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
(the older Worker does not honour a drain meanwhile). `mode` stays too:
history since #343, which this Worker no longer serves (a row registered
since holds only its default), but never a secret, and a Worker from
before #343 reads it at every claim. A task's
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
   statement is taken only with the maintainers' co-signature over its
   bytes (#330, *The maintainers' co-signature* below): at least one pinned
   maintainer's, or as many as the agent's threshold when that is higher.
   Without it, the way back further is a forward-fix release built from the
   old code.
7. `to`'s own host bundle verifies (`verify --bundle`), and carries the
   maintainers' co-signature the agent requires — or the statement does,
   which then vouches for its target (a release published before the
   threshold rose has none, and an immutable release takes none later).

It then sets `floor = to`, preempts an in-flight rollout and skips soak and
the brake. Going forward again needs nothing special.

**Co-signatures travel with it.** A maintainer co-signs a statement once
`rollback.yml` stored it (`factory/bin/co-sign rollback vX.Y.Z`: the
statement fetched from the relay, its keyless signature checked, signed
offline with their security key in the namespace `rollback@omarchy-pool.org`)
and hands the signature to the pool with their token, at
`PUT /api/v1/factory/rollback/:to/cosignature`. The pool keeps it in R2 under
the statement's SHA-256 and the maintainer's login, journals it, and relays
every one beside the statement as `cosignatures`; a statement signed again
travels with none of the older ones. The pool checks their shape only: each
host verifies them against the keys its own agent pins, so a pool can
withhold a co-signature (the host then stays where it is) and never make one.

**What bounds it.** A statement is only as strong as the run that signed
it: the `pool` environment admits `main` only and waits for a maintainer's
approval (#308), and the daily token probe checks that no token the pool
holds can dispatch `rollback.yml`. One wrongly approved dispatch can send
hosts back at most 14 days, to a release that is neither revoked nor below
`min_release`; further only with a maintainer's security key, offline. A pool that withholds a statement keeps hosts where they are;
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

**Revoked releases, and a host on its last-good** (#342, design v2 §8.6,
§9.1; D55). `revoked` and `min_release` reach the pool the way they reach
the hosts: the Worker reads `factory/bundle/manifest.toml` of the release it
was deployed from, the file `release.yml` signs into that release's bundle,
and it is deployed only once `publish-release` has published that release,
with its maintainers' co-signatures where `factory/MAINTAINERS.toml` asks
for them (#330, below).
A lease records the release it was claimed on (`build_tasks.release`, the
claim's `version`); once the pool's release revokes it, nothing of that
lease is taken — heartbeat, staging upload, pool or ring write, completion —
whichever token sends it, and a claim on it is refused (`426`). Its host's
dispatcher kills its containers on the merged set it keeps (the signed
lists of every dispatcher release it ran, never the pool's word), or on the
pool's `409 {stop, state: "revoked"}` for that lease alone, which gives the
pool no more than a Stop already does and is not kept. The agent's own
union (§5.2, every manifest it verified, applied or not) is not handed to
the dispatcher: a revocation only the agent has seen — its release's
dispatcher never ran on this host — is acted on at the lease's next
heartbeat, by the pool's word. A Worker rolled back
to a release before the revocation forgets it (its manifest did not have
it): the hosts do not, and their dispatchers still kill such tasks, which
that Worker then requeues as `lost`; a dispatcher whose own release is in
its set takes no new task (`want: 0`), so such a Worker does not hand it one
task after another to kill, each a host loss.

The one exception to the update gate rests on the host's own signed
reports: a host whose agent says it reverted the pool's release claims on
the release it applied for six hours from the first such report, never
below the signed `min_release`, never on a revoked release, and Status and
the host's page say so. A host that lies about a revert (a stolen host key,
a modified agent) gains claims on an older release that is neither revoked
nor below the floor — work any release in that range could do anyway, on a
registration whose worker token that key fetches anyway — and in public.

## The maintainers' co-signature

From #330 (design v2 D1 b, P6), what a maintainer's host takes can be held
to two signatures: `release.yml`'s keyless one, and an offline signature by
maintainers' FIDO security keys. A compromised GitHub admin, a malicious
change merged into `release.yml`, or a stolen signing environment can then
publish a bundle that verifies, and no host takes it.

- **Why SSH-FIDO, not minisign** (D1 b left the two open): the private key
  stays on a hardware token and every signature needs a touch, where a
  minisign key is a file; `ssh-keygen` is already on every maintainer's
  machine; and the agent verifies the format with the crypto it already
  carries (aws-lc-rs, sha2), so the co-signature adds no dependency to it.
- **The keys and the threshold** are `factory/MAINTAINERS.toml`'s
  `[cosignature]` table: a key per maintainer under their login, or a list
  of them (a backup security key beside their own; either is that
  maintainer's one co-signature, never two) — an
  `sk-ssh-ed25519@openssh.com` key (`ssh-keygen -t ed25519-sk`) or an
  `sk-ecdsa-sha2-nistp256@openssh.com` one, whose private half never leaves
  the security key — and `threshold`, counted in maintainers: 0 asks
  nothing, 1 is 1-of-N, 2 is 2-of-N. A key in a file (`ssh-ed25519`) is
  refused: it is not offline. Changing the table is a governance pull
  request another maintainer approves, like any change to the file.
- **A lost key never strands the hosts.** Each agent requires its own pinned
  policy of the next release, so the release that drops a key is co-signed
  under the policy that still lists it. With as many maintainers required as
  hold a key and one of them holding a single key, losing it would leave
  that requirement out of reach for good: every host would refuse every later
  release until it is reinstalled. `factory/bin/check-governance` refuses
  such a table (keep the threshold below the number of maintainers with a
  key, or give each a backup key), and a key changes in two releases, one
  change each (the runbook, *Co-signing a release*).
- **Where the requirement lives.** `factory/bin/check-governance --write`
  pins the table into the host agent
  (`crates/omarchy-agent/src/verify/maintainers.toml`), and CI fails when the
  two differ. An agent requires what the release it shipped in pinned:
  nothing the pool says and nothing a manifest says lowers it, and the pool
  cannot turn it off. An agent moves only to an agent its own requirement
  accepted — self-update is upward only and needs the co-signed bundle; a
  rollback's `agent_to` needs a co-signed target or a co-signed statement —
  so a new key, a removed one or a lower threshold is a new agent, taken
  under the old one's requirement. A bundle the agent refuses for want of
  its co-signature does not raise `min_release` or add to `revoked` either,
  so a release signed by `release.yml` alone cannot shut every host out.
- **What is signed.** The host bundle's bytes — the archive `release.yml`
  signs — in the namespace `host-bundle@omarchy-pool.org`, as a release
  asset `omarchy-host-vX.Y.Z.tar.gz.<login>.sshsig` uploaded to the draft
  (`factory/bin/co-sign release vX.Y.Z`); a rollback statement's bytes in
  `rollback@omarchy-pool.org` (above), which the pool keeps beside that
  statement only (`co-sign` names it by SHA-256; another is 409), and which
  vouch for the target's bundle when it was published before the threshold
  rose — on the round that accepts the statement and on its retries, while
  the floor stands at that target. A signature counts only with the
  security key's user-presence flag (a touch): software on the maintainer's
  computer cannot sign without their hand on the key.
- **Checked twice.** `factory/bin/publish-release` publishes a release only
  once its co-signatures meet the threshold of this release's
  `MAINTAINERS.toml`, of the latest published release's however old, and of
  every release of the last 30 days (their agents verify the new bundle
  before they update themselves), with `ssh-keygen -Y verify` and the touch
  flag (which `ssh-keygen` itself does not check); the release stays a draft
  until then. Each
  host's agent verifies them again, in Rust, before it applies a bundle or
  takes its agent, and during install.
- **What it does not cover, stated plainly.** A host installed from nothing
  trusts the agent `install.sh` fetched, which `release.yml`'s signature
  vouches for (the runbook's verifying install); the requirement holds from
  that agent on. A maintainer who co-signs a bundle they did not read
  vouches for it: `co-sign release` shows the manifest and checks the keyless
  signature before it asks for the touch. With a threshold of 1, one
  maintainer's key and `release.yml` together are enough; 2 asks a second
  person.

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
  writes a signed trust record of the shape the per-worker door wrote
  (`workers/<id>/trust-<time>.json`: the host, its fingerprint, who
  confirmed). That door is gone (#343, 410): a host's trust is
  `MAINTAINERS.toml`'s, and the records it wrote stay as history. Confirm asks no passkey
  yet: one stolen browser session of a maintainer could still mint, enroll
  and confirm a machine of its own. A passkey assertion on Confirm, as
  Approve's (#271), is the named seam for a later issue.
- **Signed requests** (D7). Every later call carries `Omarchy-Host: <host>;
  ts; nonce; sig`, the key's signature over the method, the path, the body's
  SHA-256, the time and the nonce. The pool checks the key, `|ts − now| ≤
  120 s` and that the nonce is new (`host_nonces`, pruned by the cron after
  five minutes), so nothing is replayable. A signed request reads the host's
  state, fetches or rotates its worker token, reports, and posts the
  dispatcher's log lines a `diagnostics` order of that host asked for (#325);
  it cannot claim, change the maintainer list or widen anything.
- **The host state and its orders** (#344, design v2 §11, §17.1). From agent
  0.3.0 the release a host rolls out is the one its signed state names —
  still checked against `release.yml`'s signature, the floor, `min_release`,
  `revoked` and the signed `pools` like any target; from a Worker before
  #344, whose state names no release (only a rollback below it deploys one),
  the public `follow` names it, as for the agents before 0.3.0: the pool's
  word either way, which the bundle's signature and the floor bound — and the state carries
  the host orders: a closed set, each with an id and a `not_after`, which the
  agent reads leniently and refuses when the kind is unknown, the order is
  past its `not_after` or its id is one of the last 512 it took. P3 has two.
  *Reconcile now* (its owner or any maintainer) only starts a round. *Retire
  legacy set* — its owner only, while a maintainer, with a passkey
  (`host:retire-legacy:<id>`) — lets the agent do what it otherwise never
  does (design v2 §11.1 M4, M5): stop and then remove the containers and
  networks of the one compose project its own `legacy.json` records (never a
  project it does not record, never a container labelled with an agent host,
  never a volume, an image or a file), and write the `.omarchy-agent` marker
  into that project's directory, through `openat` with `O_NOFOLLOW`, only in
  a directory the agent's user owns and nobody else may write. A pool that
  is compromised can therefore order a round, or the retirement of a set the
  owner recorded and the owner's passkey did not order — the second only
  where a legacy set is recorded at all, and never anything else on the
  host; the switch guard (#313) then keeps the retired set from coming back.
  The marker goes in first, before anything stops, so the set's own updater
  cannot bring back what the order stops; a retirement that does not finish
  within 30 minutes answers `failed` and leaves it, and the set's tools
  refuse there until the order is given again. The agent answers in its
  report, which closes the order (also one the pool expired while the agent
  carried it out); the pool's journal says who gave it and how it ended, in
  the pool's own words.
- **Settings, the rest of the host orders, and the host-side brake** (#325,
  design v2 §11.2, §12, §17.1). The pool may only narrow: `set-units` and
  `set-emulate` (its owner or any maintainer, an agent from 0.4.0) lower the
  units a host gives and turn its emulated lanes off, and the agent
  intersects them with the envelope its owner wrote at the host — units
  above `max_units` or what it detected, a lane its `emulate` excludes, the
  native lane, are refused on the host with nothing changed, whatever the
  pool says; the pool's own claim takes the smaller of the units it computes
  and the units the host declares, and hands an emulated build only to a lane
  the claim names (#337), so a narrowed host is handed no more. The pool's
  record of a host's settings, which only an agent that lost its own takes,
  is narrowed by the envelope the same way, and what of it is above the
  envelope is reported, never applied. No
  order the pool can make widens the envelope, selects a driver or names a
  path, an image or a command (a widening is the owner's passkey's, signed,
  below): the closed set is `retire-legacy`, `reconcile-now`, `set-units`,
  `set-emulate`, `rotate-token` (a new worker token from the same signed
  `POST /hosts/self/token`, written only in the pool's shapes, for the
  registration the host already has), `retry-release` (lifts a quarantine;
  the release is still checked as any target) and `diagnostics` (design v2
  M10: the dispatcher's last 500 log lines, only when the envelope says
  `diagnostics = true`, scrubbed on the host of the worker token's file
  (#327), every value in the set's `etc/*.env` and the secrets directory's
  env files and of anything shaped
  like a pool token (its job tokens `omj.` and agent tokens `oma_` too),
  GitHub or model provider token, then checked again by the
  pool's leak scan, which drops a line that still looks like one; kept a
  week, for its owner and the maintainers only), with `widen-envelope` and
  `set-agent-keys` (#328, below). Because the pool may be
  compromised, **the host brakes it**, in its own code and with counters it
  keeps in `state.json` (a restart loop resets nothing): orders at least 2 s
  apart and at most 20 an hour; at most 6 dispatcher restarts an hour that
  the pool caused — a settings order, `rotate-token`, and every recreation
  a round to another release makes, its replace and its revert's, whether
  the pool's target, an Update or a `retry-release` that lifted a quarantine
  started it (the same release tried again included: such a round needs
  room for two, and an Update or a `retry-release` that would lift a
  quarantine waits or is refused without it; on a Mac, a restart of its VM
  by the agent counts among them, never held by the brake but by the VM's
  own rate limit); at most 4 capacity
  narrowings an hour; at most one release change every 10 minutes, a
  rollback under a signed statement exempt (the pool cannot forge one).
  Beyond that an order is answered `refused: brake`, an Update waits and a
  release change is held. A pool that is compromised can therefore narrow a
  host down to one unit and its native lane, rotate its token, ask for
  scrubbed logs where the owner allowed them, and make it restart its
  dispatcher at most six times an hour — a slowdown, never a widening,
  a foreign command or a secret. Changing the runtime is the owner's alone:
  `omarchy-agent runtime switch` at the host, which the pool cannot ask for —
  the Quadlet driver (#330) among them, which runs the dispatcher as a unit
  of the owner's own systemd on rootless podman: the unit is rendered from
  the same signed set and `agent.toml`'s variables, mounts the worker token's
  own file read-only and names its env file by path, never holding the token
  (#327), and never uses podman's `AutoUpdate=`, which would let podman move
  the host to an image no release signed.
- **Owner control without a visit** (#328, design v2 §14, D6 b). Two more
  orders — `widen-envelope` and `set-agent-keys`, its owner's only, an agent
  from 0.4.0 — carry a document the owner's passkey signed, and the agent
  takes one only when **the passkey its owner pinned at the host** signed it:
  the pool's database and its relay can relay them, never make one (what a
  pool whose code is compromised can do is said at the end of this item). The pin is made on the host's
  page (the owner's passkey signs a ten-minute pin document for that host)
  and pasted at the host (`omarchy-agent envelope pin-passkey`), where the
  agent checks the signature with the public key the pin carries and that
  the relying party is its own pool's before it keeps that key (`localhost`
  only for a pool on the same machine, as wrangler dev's). From then on
  it checks each document itself: the pinned credential and its signature
  (ES256, EdDSA or RS256) over the authenticator data and the client data,
  the client data's type, challenge (the document's SHA-256) and origin, the
  authenticator data's RP id hash, user present and user verified flags and
  counter, the document's host, act, time (issued within five minutes of
  its clock, at most two hours to live) and a version above the last it took
  — recorded before anything changes, so a document is good once and an
  older one never comes back. A forged document (no assertion, another
  passkey, another host or origin, a replay, a lower version, user presence
  or verification missing) is refused on the host with nothing changed and
  answered so. A widening sets only `max_units`, `max_cpus`, `max_mem_gb`,
  `emulate`, `agent_slots`, `agent_budget`, `diagnostics` and `paths` in
  `[envelope]` (agent.toml's other lines kept), each checked by agent.toml's
  own parser and the lint, and the units are counted again under the applied
  release's signed constants and the detected hardware: a widening never
  gives more than the machine has; nor does it ever set the grant of a
  signed exception's bridge (`direct_network`, #373) or the sandboxed
  runtime what a contributor wrote runs in (`sandbox`, #330), which stay
  the host's. Narrowing (`set-units`, `set-emulate`) needs no signature, as
  before. Agent keys are sealed in the owner's
  browser to the host's X25519 seal key, which its owner confirmed once by
  its fingerprint (`omarchy-agent status` prints it at the host): the pool
  stores and relays only `{name, epk, nonce, ct}`, and its tests read every
  table of D1 after a key went through and find no trace of the value. A
  sealed key is taken only inside a document the pinned passkey signed —
  sealing is not signing, anyone may seal to a public key — and only under
  the six names of the agent keys (`ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `XAI_API_KEY`, `GITHUB_TOKEN`), so not even a signed document sets, say,
  a model provider's base URL; a `GITHUB_TOKEN` with any scope is refused.
  The agent writes them to `OMARCHY_SECRETS_DIR/agent.env` (0600, the
  owner's own lines kept), which only agent sidecars mount, read-only: the
  dispatcher never does (the lint), never has them in its environment, and
  the journal, the report and the diagnostics scrub every value the file
  holds. The owner's browser checks what the pool answers before it asks
  the passkey: the challenge is the SHA-256 of the document, and the
  document names this host, the act, the envelope or the keys the page
  showed and sealed, the seal key they were sealed to and a version above
  the last the host took — so the pool's database or its API answering
  another document gets nothing signed. The browser also remembers the seal
  key its owner confirmed in it, and asks for the confirmation again before
  it seals to another; a browser that never confirmed one (a new device or
  profile) has its owner compare the fingerprint with `omarchy-agent
  status` before its first seal, whatever the pool's record says.

  What it does not cover, stated plainly (as design v2 §10.4 does for the
  invariants): **every ceremony trusts the page and the code the pool
  serves at that moment.** The guarantee is against a pool whose data or
  relay is compromised — its D1 rows, the orders it relays, the documents
  its API answers —, not against compromised Worker code serving the host
  page when the owner uses the passkey or types a key. The authenticator
  shows its owner nothing of the challenge it signs, so such code can show
  one envelope and have the pinned passkey sign another widening of its
  choosing — at any later ceremony on the pool's origin, not only on the
  host page (approve, block, retire-legacy, a seal-key confirmation) — and
  it reads an agent key as it is typed, before it is sealed. A widening it
  made that way is still held to the host's own bounds: the eight widenable
  keys, the signed capacity constants and the detected hardware, the six
  agent keys' names. The seal key's confirmation (`hosts.seal_confirmed`)
  is the pool's own record, which no browser seals on alone: one that has
  not compared the key itself asks its owner to before the first seal.
  That is why the agent prints what it
  pinned and `omarchy-agent status` the seal key's fingerprint, to compare,
  and why the journal shows every widening and key set with who signed it.
  On a Mac the Keychain holds the seal key only (the host key stays a 0600
  file there; hardware-bound host keys are P6), and agent.env stays a 0600
  file, which agent sidecars in the VM mount.
- **The host worker token** (`omw_…`) is the dispatcher's only, and reaches
  it as a read-only file, never as a value in its environment (#327, design
  v2 §14, D15): container environment is readable through `docker inspect` by
  anyone who can talk to the engine's socket. The agent writes it to
  `run/host/dispatcher/token` in the set directory (0400, owned by the agent's
  user, in 0700 directories); the host set mounts that file read-only into the
  dispatcher and names it in `OMARCHY_WORKER_TOKEN_FILE`, which the image's
  entrypoint and `pkg-repo` read before `OMARCHY_WORKER_TOKEN` (a file named
  but unreadable stops the container; it never falls back). `lint-set`
  refuses a service mounting anything under the secrets directory, another
  service's secret file (`run/host/<service>/token`), its own writable, or a
  directory that holds them. The agent writes the token, and the
  registration's id (`# worker:` in `etc/dispatcher.env`, 0600), only in the
  shapes the pool mints (`omw_` and 48 hex digits; letters, digits and
  dashes), so a pool cannot add a variable to the dispatcher's environment
  (#371: the secrets directory's path and the agent budget come from
  `agent.toml`, the host's addresses from its interfaces and from the address
  the pool's edge saw the probe task or the agent come from, which is read as
  one IP address, so a pool can at most add one address to the deny list,
  never a variable); strings the pool sends reach the terminal without control
  characters. It is a new one at every fetch; the agent rotates it every 30
  days by rewriting the file. The one it replaces works ten more minutes (kept
  on the host's row, never on the registration that older Workers list), so
  only the dispatcher is recreated — the file is an input of the set — and a
  running task, whose job token does not depend on it, never notices. Stated
  plainly: while a release from before #327 runs or is being rolled out on a
  host, its dispatcher reads only `OMARCHY_WORKER_TOKEN`, so the agent keeps
  the token in `etc/dispatcher.env` too (and the dispatcher's environment
  shows it) until no such release is left; a new token also passes through
  that file for the moment between two of its writes when the file names no
  registration yet, another one, or still holds an older token's line, so a
  writer stopped half-way never leaves an older token that looks newer; and on
  a rootful engine the socket makes the dispatcher root-equivalent anyway —
  the file protects against leaks through `inspect`, logs, crash dumps and
  bugs, not against a compromised dispatcher.
- **The host report** is at most 16 KiB (its `runtime` at most 2 KiB) and
  refused whole when it carries what looks like a secret (`leak.ts`); the pool counts the host's units
  itself from the reported totals and the signed constants, never more than
  the host declared.
- **Who sees what of a host** (#324, design v2 §18.1). Its page gives
  anyone its name, architectures, release and whether its agent reports
  (with whose it is and who stopped it, as the journal says), and the
  Workers page's fleet row its lanes, units busy and free, tasks, release
  and isolation level. The rest — its capacity and disks, its hostname and
  key's fingerprint, its leases and the packages they build, its runtime
  and versions, its "needs a person" box (which may name, by path,
  credentials its agent found within its user's reach), its settings,
  orders and legacy set — is its owner's and the maintainers'. Status's
  lines about it are public, so they carry the pool's words only: a
  round's outcome, a verify failure's check, a held lane's class (binfmt
  missing, its smoke run failed, not checked) — never an agent's own text,
  which may hold an engine's error or a path of the machine. A **Stop** on one of its
  leases is the worker orders' `stop-task` of that task (#334): its owner
  or a maintainer, capped per login (thirty an hour), fencing that task
  only. The pool's **cap** on its units (#337) lowers what the pool hands it
  and is refused above the units the pool counts on it; it is never sent to
  the host and never touches the envelope its owner wrote.
- **The owner's soak and freeze detection** (#326, design v2 D16, §5.5).
  An owner may make a host wait `soak_minutes` (at most 100) before it takes
  a new release, from when its agent first saw the pool name it — its own
  clock, never the pool's word on when it deployed, which would let a
  compromised pool skip the soak; the agent's own update waits with it
  unless the signed manifest sets `agent.urgent` (only a security release
  does). Nothing the pool sends skips it (`reconcile-now`, an Update); a
  rollback statement does, since only `rollback.yml` signs one — under the
  rollback rules above as ever, so one deeper than 14 days still needs the
  maintainers' co-signature (#330) — and the soaking host still learns each
  verified release's `revoked` and `min_release` while it waits. The soak
  only delays: a release without the co-signature the agent requires is
  refused, soaking or not, and moves neither. The pool keeps a soaking host's
  registration out of the 426 gate until the soak its agent reports ends,
  15 minutes more for the round, never more than two hours after the
  deploy and not at all while the host holds the pool's release in
  quarantine (its claim on its last-good is the rule then, #342) nor on a
  revoked release — so an agent that reports a soak it is not in gains at most
  that window of claims on the release it runs, which the 426 gate let any
  worker have for 45 minutes before. The longest soak (100 minutes), the
  poll that starts its clock and the round after it fit inside those two
  hours, so a soak never ends at the gate. The pool reads the soak and
  `pool-behind-github` from a report with its own JSON reader, once, and
  keeps them in columns of the host: no claim nor listing parses a report
  in SQL, whose JSON parser refuses nesting V8's accepts — one maintainer
  host's report cannot fail every claim and listing of the pool. Freeze detection is the host's check
  on a pool that holds it on an old release: every six hours the agent
  reads the tag of GitHub's latest release (`api.github.com`,
  unauthenticated) and nothing else, and when GitHub has shown a newer
  release than the pool names for more than a day — neither in the merged
  `revoked` nor retracted by a rollback statement the pool relays and the
  agent verifies — it reports `pool-behind-github`, which the host's page,
  Status and the journal show. It never acts on GitHub's word alone: no
  round, no fetch, no change on the host; the tag is no signed word, only a
  second opinion on the pool's, and a compromised pool could already idle
  the fleet with 426, so this is a warning, not a guarantee.
- **A Mac** (#320, design v2 §19.2, §19.3) runs its tasks in the agent's own
  `omarchy` Colima VM (isolation `vm`): a container escape lands in the VM,
  which mounts only the work root (writable), the secrets directory and the
  set directory (read-only, so nothing in the VM can plant a link the agent
  would write through), each at its own path and none under the home
  directory — no `~/.ssh`, no Keychain files, no forwarded SSH agent; preflight
  checks from a container that the VM sees those three and not the home
  directory, and the lint refuses a bind outside them. Inside the VM the
  agent is root (Colima's passwordless sudo) and keeps prep-root.sh's task
  firewall there with the same unit, after `docker.service`, so every boot
  of the VM (a login, a resize, a clock restart) applies it as soon as
  dockerd is up, as on a Linux host, not when the agent next looks; it runs
  it again after every start, hourly and after a wake. A task reaches
  neither your LAN nor the Mac through Colima's NAT, nor the VM itself at a
  bridge's gateway (the firewall's INPUT drop, #367), and the egress probe
  checks it before install goes on (behind a task's egress sidecar, and on a
  signed exception's bridge where the envelope grants one, #373); every task's
  egress sidecar also refuses
  the Mac's own addresses (`/sbin/ifconfig -a`'s, a Mac having no `/proc`,
  and the public one it leaves from, #371). Docker Desktop's or OrbStack's VM
  (`vm-shared`) is used only if it is already there, with nothing of the
  home directory shared with it and `--dedicated`; the agent puts nothing in
  it, and its egress probe decides. After a wake the agent holds the VM's
  clock within five seconds of the pool's `Date` (the signed host state's
  answer, a refusal's included), but only while the Mac's
  own clock agrees with it: a pool's answer never moves the VM's clock more
  than six seconds from the Mac's (a lying pool cannot take the VM's TLS
  checks back to a time whose certificates expired), and a Mac that is off
  is said, never set. Its sleep (#329) is two unprivileged macOS tools the
  agent starts and ends — `caffeinate -i -w <the agent's pid>` while a task
  runs, and an `osascript` watcher of AppKit's sleep and wake notifications
  that dies with the agent —, not code of the agent's own: its `unsafe`
  stays forbidden. To know a lease is held with no task container running
  it reads the names and times of the dispatcher's lease files, never what
  they hold (a job token). The `asleep` its report carries can only make the pool
  hand the host less (zero free units), never more, and a stale one (no
  report for 15 minutes) holds nothing.
- **Never the copy of their own package** (#339, design v2 §8.4, D35). The
  project's copy of a package — the review rebuild that is signed and
  published once another maintainer approves it — is never handed to a host
  its requester owns while another maintainer's host has a lane allowed for
  it (native, or emulated unless it needs native), so the bytes that ship
  of a package a maintainer asked for are not their own machine's. When only
  their hosts can build it, it waits, and Review offers another maintainer
  — never the requester — a release to any host with their passkey
  (`any-host:<task>`), on the task, the journal and the record. A claim
  never pins a rebuild to its requester's host. Another maintainer's host
  whose agent says it sleeps (#329) has no lane for it until it wakes, so
  the rebuild may be offered for release meanwhile; the release still takes
  another maintainer's passkey, and a sleeping host is never where it runs.
  The solo-maintainer exception lifts this for the maintainer it names,
  only on their own packages (#394, below): their own host builds the copy,
  with no release.

### The solo-maintainer exception (#394)

The two-person rule — nobody decides on a package they brought, and the
project's copy of it is not built on their host (D35) — **does not hold for
one named maintainer while `factory/MAINTAINERS.toml` carries a `[solo]`
table naming them** (a maintainer decision of 2026-10-06: one active
maintainer and one host, the Studio, until more maintainers are active).
What that changes, and what it does not:

- **For the named maintainer, on a package they brought**: the review's
  doors (claim, approve, request changes, reject, release, cancel) and the
  adoption of their own package let them through where they answer
  `conflict_of_interest` for anyone else, and their own hosts build the
  project's copy with no release to any host. Users then get a package one
  person stood behind — the maintainer who brought it and approved it — built
  by the project's agent on the project's host, through the gate and the
  trial as every package. That is the risk the exception accepts in the open.
- **What still holds**: approve, block and a forced promotion take that
  maintainer's passkey in the browser (#271), never a token or an agent
  alone; no contributor's bytes ship (the project's rebuild is what is
  approved); the second opinion still runs and records its independence
  (D36) — with one host and one model, `independent: none`, which Status
  counts; nobody else decides on anybody's package differently: another
  maintainer's own packages, and their hosts, are under the rule as before,
  and a contributor's package is decided as it always was.
- **On the record, every time**: each decision taken under the exception
  carries `solo_exception` (who, since when, why) in the record the pool
  signs, its journal line says *self-reviewed (solo-maintainer exception)*,
  and Review, the build's page, the package's page and Status mark it;
  `GET /api/v1/factory/self-reviewed` lists them all, and the list outlives
  the exception. An adoption stays marked on the package page and in
  `maintenance.maintainer.solo_exception` for as long as it stands. The
  list and Status's count read journal lines of the kinds only the pool's
  own doors write — `review`, `approve`, `adopt`, `role` — and
  `POST /api/v1/events` refuses those kinds to every job token
  (`reserved_kind`), so no job can add a decision nobody took; a record is
  passed on, and the governance chapter links it, only as the pool's own
  address.
- **The switch is the governance file only**: the brain reads `[solo]` on
  `main` with the list, every ten minutes; no route, setting or database row
  turns it on (the table it writes, `governance_solo`, is the sync's copy of
  the file, as `factory_maintainers` is). `check-governance` refuses a table
  that is not exactly one maintainer of the list, a date and a reason on one
  line, and the brain applies nothing it refuses — a table that does not
  parse is no exception. Turning it on or off is a governance pull request,
  CODEOWNERS-reviewed like any change to the file; deleting the table brings
  the previous rules back unchanged at the next sync.

### Where secrets live on a maintainer host

| Secret | Where it comes from | At rest | Which container gets it |
|---|---|---|---|
| Host key | generated at install | 0600 `state/host.ed25519` in the agent's data directory | none, ever |
| Seal key (X25519, #328) | generated by the agent; its owner confirms its fingerprint once on the host's page | 0600 `state/seal.x25519` beside the host key (on a Mac, the Keychain) | none, ever |
| Host worker token `omw_` | minted by the pool for the confirmed host, fetched with a host-key-signed request, rotated every 30 days | 0400 `run/host/dispatcher/token` in the set directory (and in 0600 `etc/dispatcher.env` only while a release from before #327 is applied or staged, from just before a rollback statement's `agent_to` moves the agent down to run a rollback to one, or for the moment between two writes when the env file names no registration yet, another one, or still holds an older token's line) | the dispatcher only, as a read-only file mount (`OMARCHY_WORKER_TOKEN_FILE`; on the Quadlet driver, #330, the unit's read-only `Volume=`, which podman never creates when the file is missing), never in its environment except while that `etc/dispatcher.env` line is there (the file is the dispatcher's `env_file`; a release from before #327 reads `OMARCHY_WORKER_TOKEN` from it) |
| Job tokens `omj.` | the claim answer, per lease, carrying the lease generation | the dispatcher's memory and `work/state/leases/` (0600) | the dispatcher and its pool-job children only; never a task |
| Agent keys, `GITHUB_TOKEN` (public read only), `CLAUDE_CODE_OAUTH_TOKEN` | typed at install on `/dev/tty`, copied from an existing file with confirmation, or set from the host's page: sealed in the owner's browser to the host's seal key, in a document the passkey pinned at the host signed (#328) | 0600 `OMARCHY_SECRETS_DIR/agent.env`, outside the work root and the set directory | a task's agent sidecar only, as a read-only file mount (`OMARCHY_AGENT_ENV`), never in its environment |

So, whenever `etc/dispatcher.env` holds no token line (no release from
before #327 applied, staged or about to be rolled back to, no token write
half-way), `docker inspect` of the dispatcher, of every sidecar and of every task
container shows no token or key in its environment: the egress sidecar and the
task container hold none at all. `tests/agent-run-loop.sh` checks the
dispatcher's and a task's on a real engine (`tests/agent-quadlet.sh` on the
Quadlet driver, where the unit file holds no token either),
`tests/task-networks.sh` every sidecar's and task's the real dispatcher makes.

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
- **Cap** — its owner or any maintainer, with a reason (#337, design v2
  §7.2): the pool hands the host at most N units (`hosts.pool_cap_units`,
  read by every claim), 0 included, whatever its envelope and its reports
  say; lifted with none. Nothing running ends: a host holding more than its
  new cap claims nothing until its leases fit (§7.6). A maintainer can so
  stop another maintainer's host from taking new work — the same as a
  drain, a delay and never a publish — with their login and reason on the
  `host` line, and the owner can lift it.
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
  (its signed requests — the host state, from agent 0.3.0 its release
  target too — and, for the agents before it, the release `follow` they
  poll, refused for a suspended or retired host's registration and never
  cached): it
  changes nothing, keeps its bundle and every task container running, polls
  hourly with jitter and never exits (§16.4); it recovers by itself at its
  next poll after a Resume. Its open host orders are cancelled with the
  suspension or the retirement. An owner removed from the list sees `403`
  on its claims only.

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
| Approve — Review, a build's page, an agent's draft confirmed | the project's build, into edge (rc and stable too when its trial passed) | the maintainer's passkey, in the browser (#257, #271); never their own package — but the maintainer the solo-maintainer exception names, marked self-reviewed on the record (#394) —, never a contributor's bytes |
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
| a community registration's token (a maintainer's legacy set, until P3) | claims of any contributor's community build — never a project build or a pool job — and uploads to those tasks' staging; nothing once its owner is no maintainer (#343) | its owner or a maintainer revokes the worker |
| a job token | that task's writes, until its lease ends | expires by itself; the task can be cancelled, or stopped from its worker's page (its lease is fenced — nothing it sends is taken, nothing renews it — until the worker has stopped, #277) |
| a project worker's token | claims of pool jobs — each still executed with a scoped job token — until revoked | a maintainer revokes the worker |
| a maintainer's token | rejections and requests for changes (never on their own package — but the maintainer the solo-maintainer exception names, marked self-reviewed, #394), withdrawals, lifts, a pool job by hand — a rollback inside its ring, a promotion the gate still decides —, a dry run by hand and a note on the journal (#284: a build queued by hand never publishes, and the gate's evidence is the jobs' alone), and orders to any worker, 20 an hour (#277: a restart, a drain or a stopped task at worst — a delay, and a drain of everything is an error on Status —, never a publish or a cancel), a package's size and disk budget (`POST /factory/packages/:name/size`, #337: up to size 4 — the units and memory a build of it takes, and a large one makes a host reserve for it two hours at most —, said on the package's story and the journal) and a Retry at size of a build that ran out of memory (`POST /factory/tasks/:id/retry`, #337: queued again at a larger size, up to the largest host alive, with one attempt given back — one more build of the same recipe, never a publish) — not an approval, a block nor a forced promotion: those take the browser's session and the maintainer's passkey (#271, #284) | the person replaces the token (their page's *Token*: the old one stops working), and a reset of their passkeys revokes it (#284); a governance pull request removes the login; decisions and builds are journaled and reversible (rollback); a host's trust takes a reviewed pull request to `factory/MAINTAINERS.toml` (no token trusts a worker since #343) |
| a maintainer's agent token (`oma_`) | drafts; request changes and reject once the person confirms them in the browser — approve and block drafted by the agent also need the maintainer's passkey, which the token cannot answer (user verification) | revoke the grant on the person's page or `omarchy-cli logout` |
| a maintainer's signed-in browser, driven by an agent | what the session decides alone: request changes, reject, withdraw, a lift, a claim, a pool job by hand other than a forced promotion, a dry run by hand, and orders to any worker (20 an hour). Approve, block and a forced promotion need the person's passkey (#257, #271, #284), and so do adding a second passkey and removing one; only a login that holds none yet registers its first with the session | sign out (the session ends on the server); a first passkey registered meanwhile is on the public journal (`passkey`), and another maintainer resets it |
| a maintainer's authenticator, lost or stolen | nothing without its user verification (a PIN or a biometric on the device); with it, what the person decides — approve, block and a forced promotion | another maintainer resets the login's passkeys with a reason (#271), after confirming the request out of band: every one removed, the login signed out, its `omc_` token and its agents' live grants revoked (#284), the journal — a line each — and a signed record say who and why; the person ends the device's GitHub sessions and revokes the GitHub tokens it held (the GitHub CLI's authorization, personal access tokens) — until they make a new token on their page, `POST /factory/register` mints the login none (`token_reset`) —, signs in again, registers a new one, makes a new token and grants their agents again (RUNBOOK, *A lost passkey*) |
| the signing key | signatures on bad content — only through the Worker's own routes, since the key is a secret of the service | rotate: `wrangler secret put SIGNING_KEY`, re-render every ring, users import the new public key (RUNBOOK) |
| `release.yml`'s or `rollback.yml`'s signing identity (a GitHub admin, a malicious merged change, a stolen environment) | before a co-signature threshold: a host bundle or a rollback statement every host takes; from one (#330): a bundle or a statement no host takes without the maintainers' security keys, and a statement at most 14 days deep | `revoked` and `min_release` in a later release, a rollback statement; the co-signature threshold in `factory/MAINTAINERS.toml` (*The maintainers' co-signature*) |
| a maintainer's security key (co-signature), stolen or lost | stolen, with a threshold of 1 and `release.yml`'s identity together, a bundle hosts take; alone, nothing (a bundle also needs `release.yml`'s signature). Lost, nothing: `check-governance` refuses a threshold one lost key would leave out of reach | a governance pull request removes the key: a new agent, under the old requirement, so it is co-signed by another key the agents pin — the maintainer's backup key, or another maintainer's under 1-of-N; a replacement key is added in one release and the old one dropped in the next (the runbook, *Co-signing a release*); 2-of-N needs a second person |

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
   why, and the record is cached a day, not a year.~~ — live, then replaced
   (#343): a host is trusted by the pull request that names its owner in
   `factory/MAINTAINERS.toml`, and `POST /factory/workers/:id/trust`
   answers 410; the signed records of the two words stay under
   `workers/<id>/` as history. (The six workers on the Studio were trusted
   before the rule, on one word; the Workers page says so.)
