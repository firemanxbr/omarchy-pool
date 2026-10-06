# Testing

Everything runs on a developer machine without root and without touching
production. Real Arch packages are used as fixtures wherever the behaviour depends
on the archive format.

## Quick check

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

CI (`.github/workflows/ci.yml`) runs exactly these on x86_64 **and** arm64 runners,
plus the worker typecheck and its tests, on every pull request — and
`tests/tracked-tree.sh`: no tracked file that an ignore rule covers, none that
belongs to one machine or holds a secret (Wrangler's caches and `.dev.vars`,
`.DS_Store`, a saved token), the lesson of the account cache that sat in the
tree from #107 to #211. The three end-to-end scripts
below also run in GitHub Actions (`.github/workflows/e2e.yml`) on native x86_64
runners, where the Arch container needs no emulation. Both are required checks on
`main`, and `release.yml` — run when a maintainer decides, not by the merge — runs
them once more on main's head before it tags a version and deploys the worker, so
what is running is always a commit that passed them twice.

## Rust crates

| Crate | What is covered | How |
|---|---|---|
| `pkg-manifest` | dependency rule parsing, `vercmp` against pacman's own test table, manifest JSON round-trip | unit tests |
| `pkg-extract` | `.PKGINFO` parsing, ELF magic detection, soname → Arch provide conversion, symbol version collapsing, Go build information (the `modinfo` string, replacements, the inline version header) | unit tests |
| `pkg-extract` | end-to-end manifests from **real** `zlib` and `xz` packages (`tests/fixtures/`) | `tests/fixtures.rs` |
| `pkg-repo` | `desc`/`files` rendering identical to `repo-add`, database determinism; the work loop's agent re-check (#273): 15 s, doubled back to the half hour while the agent does not answer, the half-hour probe once it does, a failure logged once per change of state, and a stub `factory/bin/agent.py` in a checkout refused, then answering — ok with the next claim, no restart — and a slow one stamped when it answered, not when it was asked; the pool's orders (#277): the claim's answer read tolerantly (a task, orders, an answer it cannot read — logged, never an exit), an order id and a line taken only in their shape, the brake after a burst, an order seen once, a container found and its restart policy read from the engine's own inspect (`on-failure` with three or more left, `unless-stopped`, none), the site, the exit note that says why the last process ended (said until the pool answers a claim; beside the work directory for a bare binary), `AGENT_RETRY_FIRST_SECONDS` only ever slower, and an ordered probe stamped for the pool; each order obeyed with hands that record (`Hands`): a restart refused by a process under two minutes old, refused `agent-ok` when asked only if the agent is down and it answers, accepted with its note and exit 75 otherwise; a person's re-check reusing a probe under a minute old and the pool's always asking; a kind it does not take refused by name, an id executed once; the agent service found only in its own project and only with the role `agent` or `broker`, read with the one-variable template; a container it cannot verify giving no site and no `restart-agent`; the service restarted, waited for (three minutes at most) and its own agent asked again, or the engine's refusal; and, against a pool on a local port, a report the pool refuses (409) or does not take (503) never ending the loop, and an order riding a 426 obeyed; a task the pool took back (#277, part 2, `stop.rs`): the heartbeat's answer read — a 404 or a 409 with `stop` stops the task, a 409 without it (a pool from before), a 503 or a network error does not; the task's process group killed (a `sleep 600` its script left behind dies with it) and every container labelled with the task removed through a stub engine, a created one's id among them, never with `kill`; a child the task would start after the stop never started; the task's scripts told their task (`OMARCHY_TASK_ID`) and a script outside a task not; the task's client sending nothing once stopped — not the next call, not a retry whose backoff the stop landed in (`RepoError::Stopped`, never retried) — while a client outside a task goes on; and the watchdog on a fake clock: only a heartbeat the pool accepted is progress in a task, exits at 20, 60, 140, 300, 620 and 1260 minutes of a process that wedges every time (35 first in a task), never more than six in any day over random wedge times, a day of work putting the count back to 0, a missing or unreadable count read as 0, a warning at each wait when nothing restarts it, and an exit in a task stopping it first, counting itself and leaving its note — and exiting even where it cannot write; the heartbeat's thread against a pool on a local port answering `409` with `stop`: the task's child killed at once, its labelled containers listed and removed, no second heartbeat, and the task's work returning the stop; claims that fail for an hour — at once, or hanging to the claim client's timeout — never firing the watchdog, a claim bounded well within its first wait (`CLAIM_TIMEOUT`, `client::longest_call`), and a call to a pool that takes the connection and never answers ending within that bound, every attempt tried; a process declaring `stop-task`, the pool's and its broker's one proof it stops on their word | unit + `tests/database.rs` |
| `pkg-repo` (`dispatch`) | the dispatcher's loop against a fake engine and a fake pool (#335, #336, `src/dispatch/tests.rs`), and its capacity (#337): a fake pool handing out N tasks — the host takes as many as its 11 units hold, five builds each in its own container started at once (no queue on the host), the sixth handed to a claim that offered nothing given back `lost`, then one `want: 0` claim in 30 s listing all five, and `want: 1` again once one ends; a memory check that refuses — `MemAvailable` below one unit's 2 GB claims nothing, 9 GB offers four of ten free units (the claim's `offer`, its `capacity.units` still the host's 11), a task above the offer given back, one within it run, and the memory back offers every unit again (`Constants::offer`: the largest task it could receive, a size-4 build, decides); claims that follow each other at once at a constant 9 GB never offer the same memory twice (4 units, then 2, then `want: 0`: the shares of the leases just started count until `MEM_RAMP` after their start), and past the ramp what is left is offered; the claim's work root as measured now when it holds less than the agent's probe, never more; fewer units than leases (a cap lowered) claims `want: 0` and kills nothing — that and the first are regression coverage of #335's re-claim at once and `want: 0` when full | unit tests; and its lanes (#338): only a container on an emulated lane carries `WORKER_LABELS={"emulated":true}`, an x86_64 build on the emulated lane runs `--platform linux/amd64`, an aarch64 one on the native lane `linux/arm64`, an audit of an x86_64 build the host's own, each lane kept in its lease file (one from before lanes runs its task natively), an emulated lane's `needs_native` verdict reported as the script said it; a lease on a lane the host does not run now (no emulated lane in `run/capacity.json`, a native lease of another arch, an unknown word) or whose build image is not a digest given back `lost` before docker runs — and a lease prepared again after a restart once the agent has turned its emulated lane off, while one whose lane is still on starts on it — and an emulated lane without its image by digest not offered in the claim; `dispatch::capacity` reads the agent's own `run/capacity.json` fixtures (`crates/omarchy-agent/tests/fixtures/capacity/`: an emulated lane on, a held one) whole, its lanes and held lanes going with the claim as written |
| `omarchy-agent` (`capacity`) | capacity detection (#333, `src/capacity/tests.rs`) and emulated lanes (#338, design v2 §7.5): with a stubbed binfmt tree and a fake smoke run, an aarch64 host with qemu's x86_64 handler (the F flag) reports the x86_64 lane after the smoke run of the release's x86_64 build image (`via: qemu`), sharing its units; without the handler, disabled or without the F flag it holds the lane with "needs a person: prep-root.sh installs qemu-user-static-binfmt", runs no smoke run and keeps its native lane, and a held lane is no preflight blocker; `emulate = []` holds every emulated lane off and runs nothing for it, and holds one a probe found anyway; on 16K pages the lane is on with `page16k: true`; Rosetta's handler reads `via: rosetta`; a failed smoke run or no image holds the lane with its reason; the smoke run itself through a fake docker CLI (`run --rm --network none --platform linux/<arch> --entrypoint /usr/bin/true`, then `pacman --version`, a pacman that does not answer failing it, an image or arch outside the grammar refused before docker runs); install's preflight reports the lane (held, on, off in the envelope) and never stops on it, its smoke run starting the release's build image of the engine's foreign architecture (the engine's, not the agent binary's), and the envelope it writes carries `emulate` with that architecture unless the owner's file already says (`emulate = []` kept); `[envelope] emulate` refused for an arch the pool does not build; the `run/capacity.json` this agent writes for the Studio (x86_64 on through qemu, 16K pages) and for an x86_64 host whose aarch64 lane is held is, field for field, the fixture the dispatcher's tests read (`tests/fixtures/capacity/`) | unit tests; `tests/agent-capacity.sh` and `tests/emulated-lane.sh` on real engines |
| `omarchy-cli` | the MCP server's protocol handling: initialize, notifications, ping, tools/list, unknown methods, tool errors as results (`isError`) not protocol errors, bad arguments refused before any request; the write tools (#252): listed by the credential's scopes and never for another origin, each against a one-thread pool on 127.0.0.1 — the method, path and body, the token on writes and the caller's own reads only, text evidence only and never a package, the drafts' route and never a decision's, the pool's refusals in its words, a minute's memory that keeps a read for its minute only, the edge cache passed after a write, a build picked from the story but never a call stopped by it, the gate's summary under `requester_text`; login's loopback (127.0.0.1 only, its own callback only — anything else answered while it waits, another `state` swapping nothing — the verifier only in the swap) and PKCE (RFC 7636's own example); the credentials file (0600, refused when others can read it, bound to its origin, an expired grant said without a request, read again by a running session after a login or a logout); `logout` deleting it only once the grant is revoked or gone, and `login` refusing to leave a live grant of another name or pool behind | unit tests |
| `omarchy-agent` (host orders, #344) | the run loop's target from the signed host state, never `follow` — but from a pool from before #344, whose state names no release (a rollback below it), its `follow`'s target and Update, said once, and a `follow` that does not answer backed off as a pool that does not; `reconcile-now` starting a round, waiting while a revert finishes, lifting no quarantine and saying why no round started; an unknown kind, an order past its `not_after` or with none, and a repeated id refused (the ring of 512, said once on the journal, as no answer); `retire-legacy` against a stand-in legacy project on the fake engine — the marker written first, listed again by a poll while it stops and passed over without a word, then exactly the recorded project's containers stopped and removed and its networks removed (a container with the agent's host label, another project, the task and the dispatcher untouched), `legacy.json` updated, answered and reported; refused with nothing changed for no record, the bundle's own project, a directory others may write (said in the report first), one with no compose file, contradicting or ambiguous directories and a `legacy.json` others may write; resumed after a restart, waiting for an engine that does not answer, failing after 30 minutes with the marker left, a network in use said, `legacy.json` marked retired only while it still names the project retired, and carried on (with the report) while a rollout step cannot write; the report on change, every five minutes and retried a minute after a failure — hourly on 401/403, at once when a poll gets through again — with no secret; the contract with the pool written once in `tests/fixtures/host-api/` (the host state `parse_state` reads; the reports' keys and value types before and after a retire-legacy), which `host-orders.test.ts` holds the Worker to; the host calls signed over the paths the pool reads; install again after a retire-legacy keeping the rootful exception and looking at nothing of the retired set; `rollout.sh`, `setup.sh`, `omarchy-worker update` and the updater's `--self-test` refusing (or standing down) in the directory once the agent's marker is there, not before | unit tests (`run::orders`) against the fake engine and pool; `tests/agent-host-orders.sh docker` and `… podman` (CI; by hand under the engine lock) on a real engine with the pinned docker and compose: `reconcile-now` and `retire-legacy` beside a stand-in legacy compose project and an unrecorded one |
| `pkg-check` | pacman `desc` parsing, satisfiers, ABI check verdicts against a real `liblzma.so.5` | unit + `tests/check.rs` |
| `pkg-store` (`poc/crates`) | install / upgrade / remove, collisions, `.pacnew`, I/O failure rollback, crash recovery before and after commit | `tests/transactions.rs` against a temp root |

Useful invocations:

```bash
cargo test -p pkg-extract                 # one crate
cargo test -p pkg-store -- --nocapture    # see tracing output
RUST_LOG=debug cargo test -p pkg-store    # more detail
```

### Fixtures

`crates/pkg-extract/tests/fixtures/` holds unmodified packages downloaded from the
Arch `core` mirror. To refresh one:

```bash
curl -sSLO "https://geo.mirror.pkgbuild.com/core/os/x86_64/<file>.pkg.tar.zst"
```

Keep fixtures small (< 1 MB). Behavioural tests that need specific file layouts
build **synthetic** archives at runtime with `poc/crates/pkg-store/tests/common/mod.rs`
(`make_pkg`), so no new fixture is needed for a new scenario.

### Manual inspection

```bash
cargo run -p pkg-extract -- inspect crates/pkg-extract/tests/fixtures/xz-5.8.4-1-x86_64.pkg.tar.zst
cargo run -p pkg-extract -- index crates/pkg-extract/tests/fixtures -o /tmp/index.json
```

## Worker

```bash
cd worker && npm install
npm run typecheck
npm test                   # vitest inside workerd: unit and integration tests, about a second
npm run db:migrate:local   # applies migrations to a local D1
npm run dev                # http://localhost:8787 with local D1 + R2
```

A passkey (#257) needs the Worker to see the address the browser opened:
`npx wrangler dev --local-upstream localhost:8787 --upstream-protocol http`,
then `http://localhost:8787`. WebAuthn takes no IP address and wants a secure
context, which localhost is; without the two flags wrangler hands the Worker
the first route's name, `omarchy-pool.org`, and the browser's origin is not
that one. Chrome's DevTools (*WebAuthn*: a virtual authenticator with user
verification) stand in for a security key.

`npm test` runs every file in `worker/test/` **inside the Workers runtime**
(`@cloudflare/vitest-pool-workers`, `vitest.config.ts`): a local D1 with every
migration applied before each file (`test/setup.ts`), a local R2, the
bindings of `wrangler.toml` plus a test `JOB_TOKEN_SECRET`. Nothing reaches
the network. Two kinds of tests live there:

| File | What is covered |
|---|---|
| `releases.test.ts` | the release logic through the Worker's own `fetch`: manifests indexed into the pool, `POST /releases` — first release, adds on top of the head, replace-by-name within a source and architecture (another source's build of the name stays; `remove_from` drops one source's, `remove` every source's), `remove` / `remove_arch`, promote `edge → rc → stable` by copying the source head, rollback to an earlier release of the ring — another ring's refused (#284) — (lineage, history, `is_head`), the scopes each ring needs; the diff between releases; `unchanged_arches`; `GET /releases/:ring` paged in `(name, arch, source)` order (keyset cursor with the source, the older two-part cursor still accepted) with `release_id` pinning, `arch=`, `include=files`; `GET /graph?arch=` (declared dependencies and provides, per architecture); `GET /stats` before any metrics snapshot; the delta model — a release writes only its delta, checkpoints every 24th, an old release read by id is reconstructed, retention keeps the checkpoint a rollback inside it needs and prunes the rest (410 beyond); the membership tables without a foreign key to `packages` (migration 0035) — a package delete reads no membership row, GC leaves a victim a ring took back after the listing (row, lists and object) or after its own probe (row and lists: every DELETE of the batch is conditional), a reconstruction refuses a release whose packages are gone; the lab — any object pinned into it, never promoted from or into (400), its include the lab's sections above edge's |
| `relayout.test.ts` | the one-time move to one directory per source (`routes/relayout.ts`): objects copied with their signature and attestation and R2 checking the row's sha256, rows pointed at `<source>/<arch>/<filename>`, a null key backfilled, a row whose bytes the pool never held marked `ghost/…`, purge refused while anything is left to move and then emptying the flat directories; the upload, index, signature and `/packages/known` routes speaking the new layout — a filename is one object per source, another source's build of it another object |
| `gc.test.ts` | retention's reads (`routes/gc.ts`, `db.ts`, the metrics snapshot) over a pool shaped like the real one: the list of what is outside retention is the one the plain `NOT IN` form produced and is read through the membership tables' primary keys, not every row of them (`rows_read` bounded on the vitest D1); the reclaimable tile counts by the rule GC deletes by and agrees with the old count once the checkpoints outside retention are pruned; a victim's row goes and its object only when no other row names the key, found through the filename index; every writer of `r2_key` ends the key with the filename |
| `factory.test.ts` | the factory's brain (the trial included: queued for the project's build only, on its architecture, a community worker never takes it, its token reads the staged package and writes the lab and nothing promised, `trial.log` beside the evidence, the verdict on the Review row); claims with worker tokens (own architecture only, project vs community), leases and per-job tokens, heartbeat, fail → requeue, complete after the package is indexed, the agent a worker reports; a community build staging its evidence (the builder cannot write `audit.*`, the package is for maintainers, the rest is public), the audit queued and taken only by a project worker declaring the kind, the report attached and its verdict on `/factory/review`; approvals — a contributor cannot, a maintainer cannot approve their own package while another maintainer exists, the rebuild queued at project trust (held off its requester's only project worker until another maintainer releases it to any host with their passkey, #339), the record and the profile's track record; what a public log must not carry (a token, a key or the worker's environment in text evidence is a 422 with the kind and the line, never the match; the record never receives it; the log's tail and the error line withheld at complete/fail; multipart closed for text evidence); who trusts whom (a proposal, the second word, never the owner's, the signed record, back at one word); the worker behind every staged build on Review; a record withdrawn with its signature and staging copy, the tombstone's fields; the claim's new fields (#277) — its orders, instance, start, previous exit, where its agent is, its site — written only when they change; a heartbeat for a task that is no longer the caller's saying `stop` with the task's state, on every call |
| `host-enroll.test.ts` | maintainer hosts (#321, `routes/hosts.ts`, `src/hosts.ts`, migration 0043), with real Ed25519 keys: "Add a host" for a maintainer only (nobody 401, a contributor 403 with the page's words, a session from another origin 403, a login the last sync removed 403, a maintainer the pool has no GitHub user id for 409), the token stored as its hash and carried in the environment of `sh`; enroll refused after the token's use, after 15 minutes, for a token never issued, for a login that left the list or became another GitHub account, for a key the machine cannot prove it holds and for a capacity below the release's signed minimum (with its numbers, the token kept); a host in `pending-owner` with no registration and nothing to claim; Confirm by its owner only, once, while a maintainer: one registration of kind `host` with project trust, the journal's line in D40's words and the other maintainers' notice; the details (fingerprint, capacity) for the owner and the maintainers only; a signed request refused when replayed, with a changed body or path, under another key, or with a clock 121 s off, and a suspended host's key refused; the worker token fetched, rotated with the old one valid ten minutes while a running task's job token never notices, then refused; a tokenless host registration never pruned; the report kept with the pool's own unit count, refused over 16 KiB or with a secret; Update taken for a host registration while its agent reports, refused with why when it does not; the cron's prune of nonces and unused tokens; the units of the four example hosts from the signed manifest |
| `host-leases.test.ts` | host registrations' claims and leases (#334, `routes/factory.ts`, `orders.ts`, migration 0045): a host's claim read whole (claim_id, want, leases, capacity) or refused 400; a lease with a generation, the native lane, its units, size, disk budget, release and claim, the generation in the job token (`g`), no `current_task` on the row, and the worker token refused on it; **a task stopped and re-claimed by the same host before the kill lands**: the fence holds while the claims list it, ends when one does not, the same host wins the task under a new generation, and the old token's upload, multipart, heartbeat, completion and failure are refused; a claim retried with the same claim_id gets the same lease with a fresh token and no second lease; `want: 0` delivers an order and leases nothing; on a fake clock, an unfenced lease missed by two claims goes back once 2 minutes old with its attempt, one listed again is kept, and a fenced lease listed for ten minutes ends only when a claim stops listing it; two Stops for two leases open at once, a stop that names no task or one the host does not hold refused, the restart group not counting stops, and 30 stops by a login in an hour capping the next (at the door and in the INSERT); `lost` gives the attempt back twice then spends it, `oom` spends it with its reason; units recomputed whatever the host declares, the reserved job unit, the pool's cap, a host's full unit count at once (four builds and a trial in the Studio's ten, the audit kept out by the job unit; two audits of three within two agent slots, #337), no audit without an agent slot; `oom` saying the memory its lease had and its size (*out of memory at 4 GB (size 1)*); a legacy registration's lease has no generation and its `lost` is an ordinary failure; the new statements' plans |
| `selection.test.ts` | capacity-aware selection with no database (#337, `src/selection.ts`, `src/sizing.ts`; design v2 §8.3, D30, D31, D50, D51): the rules are the release's signed constants; T is twice the last native duration clamped to 3..60 minutes, 3 with no history; the shipped `factory/sizing/tasks.toml` reads and a broken one does not; then simulated fleets on a fake clock, minute by minute, each registration claiming again at once while it is handed a task, and handed the first choice over the candidates the claim's bounded reads bring (the Sim mirrors `selectAndLease`: each lane's head, the arch-neutral head, each contributor's first build of each arch, the first native task, the reserved one, each filtered by what the claimer can take now) — **native only**: a 7-unit host runs three builds at once, the rest wait and start as units free up, the reserved job unit never a build's or an audit's (a pool job's it is), agent slots bound model work, a pool cap or a smaller count holds the rest, a lowered cap ends nothing, a build's disk budget fits both free values less the floor and the budgets held; **emulated only, then native work**: an aarch64 host fills four of its five builds with x86_64 ones, native work takes the build kept at once and holds at least two as emulated builds end, the emulated lanes never above three while native work waits; behind an x86_64 backlog longer than the bound a claim reads, native work arriving still takes the build kept; a size-4 emulated build starts while the emulated lanes hold none (idle, or first by the share with native work queued), never a second one above the cap; **mixed**: an x86_64 task goes to the eligible native host, to the emulated lane at once when that host is full, after 3 minutes when it is alive but does not claim, after 20 with a 10-minute native history, effective age putting a fresh native task ahead, `needs_native` never emulated however long it waits; **a continuous aarch64 backlog with x86_64 arrivals on an aarch64-only fleet**: every hour both hosts start x86_64 builds, the share is used, and no x86_64 task waits longer than the backlog's longest wait and one build; the oldest x86_64 build goes first however far the aarch64 backlog runs past the bound; **one contributor flooding the queue**: with the cap lifted another's single package starts at the first build that ends, ahead of 142 older ones, and under the cap (ceil(8 / 4) = 2) the flood holds two while the project's builds take the rest and another's starts at once; a capped flood longer than the bound hides no project build nor a requeued one; **a head the claimer cannot take now**: fifty-five audits ahead while its agent slots are full, or fifty-five size-4 builds ahead of its two free units, hide none it can run; **a size-4 task on busy hosts**: reserved after 30 minutes, the host taking no other build until it starts, within the window; a mark clearing when its task leaves the queue, its host leaves, or after 2 hours — and that task not marked again for 30 minutes, the host back to selection, then marked anew and started the minute the builds longer than its windows end —, one at a time, never for a size-1 build or a host that could not lease it (a `needs_native` build on an emulated lane); two hosts each running a 4-hour build under a steady flow of 17-to-45-minute builds, the first mark lapsing and the second, 30 minutes on, starting it; a reserving host whose free units reach the task taking the project's builds while its owner's cap holds it back, or what fits its claim's memory offer, and the task first (ahead of a more urgent build) when it can lease it, a mark set at the very claim holding (the claim hands selection its task) and one whose task the claim cannot take — its probe failing, builds held for disk — holding nothing, whatever its free units; an older build that waits for another reason (`needs_native` with no native host, size 1, its owner's cap) turning nothing off, in the reservation and over four simulated hours; a claim's memory offer bounding that claim only (a size-4 build waits rather than run smaller, the largest size and the builds unchanged); a task larger than every host alive clamped (a contributor's to 2); **a drained, below-minimum, suspended, behind, busy, reserving or disk-short native host** never making an emulated lane wait; and a legacy registration as a host with one lane and one build (an emulated one waits T for an idle native one, takes no size above 1 while a host runs it, its own lease does not hold it, its scope kept); and **per lane** (#338): a host with both lanes takes a `needs_native` task of its native arch natively and none of its emulated arch; a health check of the x86_64 ring goes to an aarch64 host's emulated lane at once — no wait, no preference for an idle native x86_64 host, on the reserved job unit while builds hold the rest — and to no host without an x86_64 lane; a promotion needs a lane of every architecture whose ABI gate and health check it runs (`params.arch`, or both), a security job both, with no lane of its own; a legacy registration keeps today's rule for them; and **placement** (#339, design v2 §8.4, D35, D36) on fleets of maintainers' hosts with the models their claims say: the project's copy of m1's package never on m1's host while m2's has a lane allowed for it, however busy, m1's host taking its other work meanwhile; another maintainer's emulated lane counting at once (the requester's native host never makes it wait) and `needs_native` leaving only the requester's host — held; a single maintainer's hosts holding their own package's copy from the first minute and taking it at the next claim once released, anyone else's at once; a drained, suspended, behind, silent or probe-failing host of another maintainer's no reason to wait; pins to a host registration (to another maintainer's, it waits for that host; to the requester's, held); the rule the copy's alone (a contributor's build of the package, its trial and its audit go anywhere); each audit's independence as its lease records it (`model`, `host` for an audit that does not ship, `none`); with one provider the builder leaving an audit to another host that can take it now, taking it at once when none can and after `ELSEWHERE_MS` when the other does not claim; with two a publish-bound audit never on the builder's model while the other is alive, however long its host is busy; a host with another model last seen 23 hours ago still holding it until the day is up, a drained one or one that takes no audits never; and a review rebuild and its audit placed across two maintainers' hosts, each on the other model |
| `capacity-claims.test.ts` | capacity-aware claiming through the Worker (#337, `routes/factory.ts` `selectAndLease`, migration 0046), on a fake clock: the migration's columns (a host's reservation time, a task's reservation window) and partial index by owner and arch; a host's row written at least every minute between claims that say nothing new (its liveness for selection, `HOST_TOUCH_MINUTES`); the P1 host's full unit count, each lease with its generation, lane, units and size, the rest started as units free; an x86_64 task to the eligible native host, to an aarch64 host's emulated lane after 3 minutes (the native host alive but stalled), after 20 with a 10-minute native history, at once when the native host is drained or full; `needs_native` never emulated; four emulated builds of five with only x86_64 queued and native work taking the fifth — behind sixty x86_64 builds too, more than the bound a claim reads; the oldest x86_64 build first on an aarch64-only fleet, behind sixty older aarch64 ones; a native host below the minimum by its agent's last report claiming nothing and holding no emulated lane, and a claim whose work root its own builds filled below the minimum still taking work; a flood of 150 holding one build under the cap while another contributor's package starts, and with the cap lifted (the `owner-cap-divisor` setting) another's package taking the next build through the owners' heads; a package's place in the queue counted as selection hands builds out (another's one package behind 150 is second, a more urgent build ahead of every one); a capped flood of sixty hiding no project build nor a requeued one; model work (fifty-five audits and fifty-five drafts) ahead while the claim says no agent slot, and fifty-five size-4 builds ahead of two free units, hiding the build the claimer can run; a size-4 build reserved for (the mark and its `host` line), no small build taken, leased at size 4 once 8 units free, the mark cleared; a `needs_native` x86_64 build queued five hours on an aarch64-only fleet turning nothing off, and two hours on the mark cleared, the task not marked again for 30 minutes, the free units taking a small build, then marked anew with its window and the host keeping its units again; a reserving host whose claim cannot take its task (its agent's probe failing for a size-4 draft, builds held for disk) taking a build and a trial, the mark standing and holding again once the claim reads its task; the claim's `offer` bounding that claim only — a size-4 build waits rather than be leased smaller (no Status line), a size-1 build fits the offer, the size-4 one leased at 4 once the memory is back, a malformed offer refused; a size-4 package clamped to 3 with its Status line, a contributor's to 2; `oom` saying *out of memory at 4 GB (size 1)*, Retry at size by a maintainer only, within the contributor's 2, the task queued again with its params kept, the package back to waiting, one line, and leased at that size; the package page's build panel saying it and offering Retry at size (to a maintainer, not to the owner) for a build queued again after running out of memory — at the size a maintainer's retry queued it at, offering only a larger one —, and nothing of memory for a build queued as any other; a size no host alive runs refused with the largest, the story's `largest_size` read only when a build ran out of memory, and the Retry at size button's options stopping at it; a package's size and budget set on its page, in the story, used by the claim and cleared; the pool's cap set on the site by a maintainer (a token refused `web_only`, a contributor 403), held by the claims, lowered below what runs ending nothing, lifted; a legacy emulated registration waiting T for an idle native one and its lease recording its lane; the new statements' plans (whether anything of the claimer's kinds is queued, one probe of the kind index, before anything else is read; each contributor's head through the partial index, each lane's head through the queue index, the oldest builds a window of the kind index) |
| `emulated-lanes.test.ts` | `needs_native` per lane through the Worker (#338, `routes/factory.ts` `handleFail`, `src/hosts.ts`; design v2 §8.6, D33): from a lease on the Studio's emulated x86_64 lane it requeues the task with its attempt given back and the mark kept beside its params, the journal saying it waits for a native worker, and no emulated lane takes it again — the same host's, ninety minutes on, another host's — while a native x86_64 host takes it at once; from a native lane it is refused — a failure like any other, its attempt spent, no mark, journaled with *its needs_native refused*, `needs_native_refused` in the payload — on a host that also runs an emulated lane and whose registration's labels say `emulated` (a host's labels are never read), and on the last attempt it fails; a legacy registration's lease keeps its word (the emulated lane its claim wrote from its labels, a lease from before lanes by its labels, a native one refused); the capacity a host reports keeps each emulated lane's `via` and `page16k` and up to four held lanes with their reasons (cut at 300 characters, one that does not read left out); a claim whose emulated lane says how it runs is taken; the claim's own statements (`LANE_HEAD_SQL`, `NEUTRAL_HEAD_SQL`) bring an x86_64 health check to the x86_64 lane's head only and promotions beside the arch-neutral kinds with the arch they name (`job_arch`), and selection over those rows gives the Studio the health check on its emulated lane at once while an idle native x86_64 host is alive, and a host with no x86_64 lane neither it nor a promotion that checks x86_64; a host's claim listing `health` and `promote` takes neither yet (`HOST_KINDS`, until #340) |
| `placement.test.ts` | placement through the Worker (#339, `routes/factory.ts` `selectAndLease`, `placements`, `modelsAlive`; `routes/review.ts` `anyHostVerdict`, `handleAnyHost`; migration 0047; design v2 §8.4, §9.5, D35, D36), maintainers' hosts claiming with their owner on the registration and their model in the claim's `agent`, real passkeys: the migration's `independent` (model, host, none, nothing else); a review rebuild of m1's package handed to no host of m1's while m2's host has a lane for it — m2's full for hours — and to m2's once free, Review's row saying it waits for that host with no release; one whose requesters are not known (no owner, its contributor's build gone) any host's, the claim's filter hiding nothing else; m2's emulated x86_64 lane taking m1's x86_64 copy at once, and one marked `needs_native` held on m1's native host alone; with only m1's hosts held at once, Review offering m2 the release (m1 `conflict_of_interest`, a contributor `maintainer_only`, nobody the sign-in), the door refusing nobody, a contributor, the requester, a maintainer without an answer, a token and an answer made for another act, then m2's release with their passkey — `params.any_host`, the `review` line with the passkey and the record, a second release refused, the list saying who released it — and m1's host taking it at its next claim; a claim refusing a worker of the requester's (`requester_host`) and leaving another architecture's same-agent pick unpinned when it is the requester's; with one provider the builder handed neither audit while another host can take them, the copy's recording `none` and a contributor build's `host`; with two a publish-bound audit handed only to the other model (`model`), a host with it last seen 23 hours ago still holding it, 25 hours ago no longer (`none`), and one alive whose agent has failed for an hour holding it while one failing for a day does not; Review's script drawing the held line with Release to any host live for another maintainer and grey with the server's words for the requester, the released line, nothing when another maintainer's host can build it, the step's *a release* and the log's words, and the audit's independence beside its verdict for each value (nothing for an audit not leased yet); `any-host:<task>` an act of its own; the placement reads, the release and the models' read by their indexes |
| `host-suspend.test.ts` | stopping a maintainer host (#322, `routes/hosts.ts`, `src/hosts.ts`, `governance.ts`, migration 0044), with real host keys and passkeys: the migration's columns and the four statuses; Suspend by a maintainer stopping the claims at once (`host_suspended`, in its words), the key refused with its status, the agent's `follow` refused, an open order cancelled, the running lease fenced by one closed order row of its own — every heartbeat refused — and back in the queue at its lease's end with the person and the reason; Resume refused to another maintainer, a token and an answer with no passkey, then the owner's: the same token claims the task again with nothing done on the host; the doors refusing nobody signed in, a contributor, a token, another origin and a reason too short, too long or with a secret, and `GET /hosts/:id` carrying the same verdicts; Retire by a maintainer with a passkey (the key refused, the token revoked, the old key never enrolled again, a new key a new host) and by its owner without one; a host's drain (D57): the owner's lifted by the owner only, another maintainer's by either of the two and not by a third; the maintainer list (D39): a removal holding at the next claim before the sync, the sync's mark and one line per host, nothing fenced, the running task heartbeating and uploading to the pool, listed again still stopped until the owner's one Resume with a passkey; a login renamed to one that resolves to the same GitHub user id changing nothing; removed for cause by another maintainer with a passkey and a reason — every host suspended and both leases fenced, the owner, a contributor and an answer with no passkey refused; the pure rules and the passkey's subjects; and every new statement by its index |
| `host-orders.test.ts` | the minimal host state and its host orders (#344, `routes/hosts.ts`, `src/hosts.ts`, migration 0046), with real host keys and passkeys: the migration's closed kinds and states and one open order per kind; the signed state naming the pool's release (none from a Worker that runs none), the registration's open Updates and the host's open orders with their id and `not_after` — never one past it, never another host's — and refused to a suspended host, whose open orders the suspension cancelled; Reconcile now by its owner or another maintainer and refused to nobody, a contributor, a token, another origin, an unknown kind, a host waiting for Confirm, an agent before 0.3.0 (taken once it reports 0.3.0) and a second open order; Retire legacy set by its owner only, with a passkey for that act, while its agent reports a legacy set, refused to another maintainer with a passkey, to a token and without one, and with why for no legacy set, one being retired and one retired; `GET /hosts/:id` carrying the verdicts, the legacy set and the last orders to the owner and the maintainers only; the report's answers closing that host's open orders once — never another host's, never a malformed one, one the pool expired meanwhile too, never a cancelled one — with a journal line in the pool's words only; a refusal's words kept; Retire legacy set greyed, and refused at the door, with the agent's words while its report says it would refuse; the contract with the agent in `crates/omarchy-agent/tests/fixtures/host-api/` — the state's keys and value types the fixture's, the agent's reports posted as the fixtures are, closing its orders and read back field by field; expiry by the door and the cron, cancellation by a retirement; the pure rules and every new statement by its index |
| `orders-pure.test.ts` | the orders' pure core (#277, `src/orders.ts`): an agent's error by class (what a restart can help, what it cannot), text a person or a worker gave cleaned and refused when it looks like a secret, a claim's kinds in one canonical form, a claim that names no process declaring nothing, the instance step (two processes on one token — a day of two processes claiming with their network's jitter, a second one that draws a new instance at every claim or names none, the one the row names stopping first: one line, no lift while two claim, at most a write per three minutes besides the liveness write; a crash loop only over unexplained short processes, the watchdog's lines — each over random schedules from a seeded generator), the journal naming a process by four hex digits and a version only by a tag the pool parsed, the probe's age on the pool's clock, a host's shared agent service (the election, the others' give-up with it, a worker restarted itself once the service answers another, the pacing), a site under the name of who runs it, the breaker's two scopes, the pool's names no login can be, the step machine (one re-check when the worker's own stalled, a conditional restart after ten minutes, never a process under two, two a spell and three a day, then a give-up line, nothing for an error a restart cannot help — over 48 h of claims every 30 s), the scale honoured only on a Worker that is not a release, who may press what — Drain on every image, Resume by §1.10's table, Stop its task only for its owner and any maintainer and only for the task in hand, once, in the restart group; Update allowed on an outdated worker whose set follows the pool and on an outdated builder whatever its image takes, refused on the latest release, a newer one, one that reports none, a pool that runs none, and a project worker's set that does not follow, each with its reason — how soon a stopped task stops by what runs it (`stopWay`), what rolls a set out — every pair of updater and host script, and a report that is not there, mapped to exactly one `set_rollout`, read tolerantly and in one form, said in the page's and the door's words —, what closes an Update, and the pool's sentences |
| `worker-orders.test.ts` | orders through the Worker (#277, `routes/orders.ts`, the claim in `routes/factory.ts`): the doors (its owner and every maintainer, anyone else refused server-side in the words `/can` greys the button with; a session's write only as JSON from the pool's own origin; one open order per kind), the claim that carries the order to one process once and the answer from that process only, observation and staleness, nothing delivered while two processes share the token, a claim that says the same writing nothing; the rules on a fake clock (a late agent re-checked then restarted only if needed, a restart refused by a worker whose agent answers, the uptime gate, a broker's builder only through a broker that exits with it, a host's agent service restarted once through its elected worker, the fleet breaker tripped by three sites and cleared once, after fifteen minutes); the caps inside the `INSERT` (a worker's seventh in an hour, a login's twenty-first, the pool's sixty-first a day and eleventh restart an hour, each journaled once); the sweep and revoke; exactly one issue line and one final line per order; fail open; Update through the set's updater (#277's third part: on an outdated builder its owner's and a maintainer's, listed by `follow`, never in a claim answer, closed done by a claim on the pool's release with one final line; on a project worker only where an updater from #277 on rolls its set out, every other `set_rollout` refused with its reason and `/can` greyed in the same words; the claim's `rollout` written only when it changes; an Update nothing carries out expired after six hours with one line; the dialog's names from the site's read — the default Studio's four, the emulated profile's six, a builder alone, a stranger none; `follow`'s 1 to 16 well-formed ids, unknown and revoked ones left out, the release `/version` says, its edge copy kept thirty seconds per release so a deploy or a rollback is never answered from before it); and every statement of the orders path by its index (`EXPLAIN QUERY PLAN`), the updaters' `follow` by the primary key |
| `worker-orders-bounds.test.ts` | orders at their edges (#277), on a database of their own: a person's Cancel between a claim's read and its close (one final line, the claim's close writes none); a delivered order keeping its half hour past its TTL; the breaker's matrix — which rows count (not seen for 11 minutes, revoked, a class it does not count, another provider, a spell ended, two workers of one site), a contributor's three registrations holding contributors' workers and never the project's, hysteresis (a count back at two starts the wait again, no flap), a dead site, a development pool's scale leaving it alone, two claims tripping it at once, a key the weekly gc keeps; a host's agent service restarted through its elected worker, then the other restarted itself once the service answers the first, and the page's words at each step; the emulated profile's four review workers — one service restart, the others' give-up with it, and nothing read after; a person's restart of the service holding the rules' without an issue that fails; a person whose login is `pool` a person; the community's share of the day and of the hour; a claim that names no process; a failing worker's liveness write costing what a ready one's does (the breaker's index unwritten); the kill switch; the breaker's key, the open spells or the site's workers throwing; an order riding a 426; and the caps, a rule beside a person, and two claims deciding at once |
| `orders-budget.test.ts` | what orders cost D1 (#277), rows counted through a proxy over the real statements: an order about twenty rows written, indexes included; fifty workers without credit for a day, no order and nothing written the claims would not write anyway; an outage across twelve hosts, the breaker tripped once before any restart and a held claim writing nothing; two hosts failing a day, three restarts and three re-checks per worker at most; the pool's orders under sixty a day whatever the fleet does |
| `worker-drain-stop.test.ts` | Drain, Resume and Stop its task (#277, part 2), on a database of their own: the owner of a contributor's worker stopping a stranger's build it runs — still leased, fenced, `lease_expires_at` unchanged, one issue line, nothing cancelled, nobody else's claim taking it; while fenced, every heartbeat `409 stopping` renewing nothing, a staging `PUT`, a multipart, `complete` and `fail` refused, and the stop not taken back; the worker's next claim giving it back (queued, `priority + 10`, the fence gone, its hand emptied, the package waiting again, one `build` line, the order done with one final line); a maintainer's stop of a project worker's job, a stale page's task refused, two stops at once fencing once; a last attempt failed at the requeue and its staged packages reclaimed; a claim's rebuild back in the queue still pinned, with its params, and an approved publish job still a publish; the ring race of rc#34 (a stopped promote holding its ring for 29 minutes, its token valid until its end, then the lease's end giving it back — the token dead, the order failed —, and only then another worker taking it); a two-process conflict requeuing nothing, a revoked worker's stop cancelled and its lease still ending, a stop counted in the restart group's six; an audit's and a trial's report taken before the stop, refused once the job's own task is fenced (the staged object unchanged) and after, to the stopped token, once another run holds it; `/can`'s `stops` per kind; the heartbeat's `stop` with `queued`, `leased` and `cancelled`; a drain held at the claim for every image — its notice once, then `204` while a task waits —, resumed, a resume before the notice closing the drain too; who resumes, the five cells of the table and nobody else, a project worker whose owner is not a maintainer lifting only a drain of their own (a maintainer's refused at the door and greyed on `/can` in the same words), and a login at its twenty still resuming; a seventh drain of a worker in an hour refused in words `/can` greys Drain with first, and six resumes in an hour never keeping a worker drained; the Build and project-build doors refusing a drained worker, the other architecture not pinned to one; a build pinned to a worker drained three minutes unpinned at the sweep with one line, and not before; the stop's `201` carrying the latest its task goes back (`until`, the page's toast on its reader's clock) and the door's note saying that time in UTC, `/can`'s note while a stop is under way, and the task view's `stop_order` gone once the task is back in the queue; an image of #277's first part (orders, but no `stop-task`) given back at its lease's end; a stop that lands between a heartbeat's, a `complete`'s or a `fail`'s read and its write (through a proxy over the DB) — nothing renewed, no token, no report taken; a heartbeat that renews an expired lease between the cron's read and its requeue keeping the lease; a fence a Worker from before it left on a queued task gone with the next lease; a stop whose lease ends on the task's last attempt saying the task failed, not that it went back; exactly one issue line and one final line for every order; and every new statement by its index, a resume's close of its drain through the open orders' index |
| `rollback-clear.test.ts` | a rollback past #277 (#295): the UPDATE `factory/bin/release-rollback` runs around an older Worker's deploy clears every column `workerView` withholds, keeps `drained_at`, `drained_by` and `drain_reason` (a person's standing drain) and touches nothing the view serves; a column the view withholds that the clear neither clears nor keeps fails it. On a real D1: what the older Worker's `SELECT *` serves afterwards (a revoked worker's too, which `/users/:login` lists) holds none of them and no process id, `instance_churn` is 0, a task's `stop_order` is gone, and a second run changes nothing. The security model's UPDATE is the script's |
| `worker-page.test.ts` | a worker's page (#277, `pages/worker.ts`) and its one state everywhere (`wtState` in `layout.ts`): the first of revoked, offline, building, drained, outdated, not ready, idle over every combination, a drained or outdated worker never counted idle, the pool's marks beside the state and never instead of it, every worker's name a link to its page; the page served for any id, the worker's own words never shown to the public, every button greyed with the door's own reason, and the Factory's and Status's headers; a task being stopped and a drain a building worker takes after its task drawn as marks, the error when every live pool or review worker of an architecture is drained (and not once one is resumed), and a drained worker greyed in the Build and project-build dialogs with the door's words; and (#299) an unknown id's page, its script run over the Worker's own answers, saying "no such worker" with no script error when `/can` answers 404, a visitor told in words under the buttons why they are grey and where to sign in, five tiles in five columns or in two with the fifth across both, the agent's whole name, and `/worker/` and `/workers` closed in robots.txt and sent with `x-robots-tag: noindex` |
| `review.test.ts` | Review's decisions through their doors (#247): the requester refused a claim, changes, a rejection, a release and the cancel door on the claim's rebuild with the reason and the code `conflict_of_interest` (`sign_in` for nobody); who asked for a build in review still refused once the registration moved, and no adoption while a build of it is open; a claim pinned to the review worker whose agent the maintainer chose, signed and in the journal with it, two at once one claim; the rebuild's inputs carrying no staged object of the factory's build and its job's token unable to read one; a release by the maintainer who claimed it or another — a queued rebuild cancelled once, a running one's lease voided and what it staged taken, a claim on two architectures half staged let go whole and ready again, one all staged or a second release refused, two at once one release; request changes (the round stopped, the name kept, said as changes on the story, the build and the maintainer's record), reject (the name freed), approve (its publish job not the cancel door's); a note that is not text refused before any write; two approvals, or changes and a rejection, at once one decision; the agent on the record the one the rebuild ran; every decision — an adoption that takes a registration, block and lift too — a record whose signature verifies with the pool's key, written once even by two writers at once, and a journal line with who, the door and the agent; none taken back but by a block; Adopt, one door for the package page and the No maintainer tab (`routes/adopt.ts`): a synced package's maintainer of record alone, an unmaintained registration taken with its maintainer of record — signed, one `adopt` line that says which, taken once by two maintainers at once — and refused to a contributor, to the registration's owner (`conflict_of_interest`), to a package with its maintainer and to one in no ring; the queue's row writing a version whole beside its name, wrapping under it rather than cut, and a maintainer's line wrapping between its parts (#282, the stylesheet through `declared`); the handlers' own statements asked for their plans |
| `package-view.test.ts` | a package's page (#244), the served script run over the Worker's answers for every viewer: one layout for every package, only You changing with who reads it; where each architecture is served, the files, a review's two recipes, the package's maintainer in the pool (`maintenance.maintainer`); Adopt from the page — a synced package named its maintainer and left what it was, a registration its owner left unmaintained taken with it (the one door Review's No maintainer tab posts to; the evidence an approved rebuild answered does not hold it up), refused to a contributor, the requester, a package in no ring and one with its maintainer, once when two press at once; the reads bounded by the name; a dependency's name kept whole in the graph and its version cut instead, however long (#274: the page's stylesheet, read through the fixture's `declared`, and the node the page writes); the state chip's *ready for review* and *in review* in the Factory's and Review's meaning (#274); two long names that share a prefix told apart in the graph — the side columns first, the package between wrapping its name, and a name wider than its node cut in the middle with the word that parts it from the others kept (#282: the served `nameCut`, the node's head and tail, what a reader sees at each width, the stylesheet) —; the Depends on tile's *1 library* and *N libraries* (#282) |
| `soname-provider.test.ts` | which package a loaded library comes from (#275), over a ring of its own where glibc, lib32-glibc and a cross toolchain's `any` sysroot all ship a `libc.so.6`, and gcc-libs and two x86_64 cross compilers (one from a source read before core) a `libstdc++.so.6`, the cross ones in their sysroot: zlib's resolves to glibc, a lib32 package that names no lib32-glibc (Arch's lib32-curl) to lib32-glibc, lib32-openssl and lib32-zlib, a declared `libcrypto.so=3-32` to that provide, cmake's and a package that declares the cross compiler's libstdc++ to gcc-libs; the reverse edges by the same rules (the sysroot and the cross compilers required by what declares them, glibc by nothing 32-bit, lib32-glibc by nothing 64-bit) and the Security page's exposure; the ELF class written at indexing equal to what migration 0041 computes; zlib's page saying Depends on the same number in its header and its graph; the lookup's plan, a file list read by its primary key, and each view's rows no more than main read |
| `leak.test.ts` | the shapes a public log must not carry (`src/leak.ts`): each kind, the first hit's line, and the ordinary things a log says that are not one |
| `pages.test.ts` | the dashboard's pages through the Worker's fetch handler, over the fixture: every door and detail page served with the shared frame (the door a page lights marked for a screen reader too, Go… naming a key only once the ⌘K menu is there to answer it, the theme switch beside it, #272), no page script using a name it does not declare (parsed with acorn, not grepped), no template placeholder left behind, no id served twice (a script draws into the first element of that name), the docs shell with every chapter's sections on every chapter, a link into the docs landing on a chapter's section, a glossary term or one of the index's seven, the old chapter addresses still redirecting and the pages that became sections of another redirecting there with their query (`MOVED` in `src/index.ts`), every routed page one hop from the header or the footer, the diagrams drawing no two boxes over each other, and the MCP write tools of #252 said as served on every page that names them (#268) |
| `status-page.test.ts` | Status (#248), the page the Pipeline, the Journal and Security became: every section the design names served, and the section each old address lands on (`#journal`, `#advisories`); the stats carrying each ring's last releases with where each selection came from (`source_ring`), so a rollback is drawn red, and what each source's syncs brought today (`coverage.today`) from the rows the day's imports already read — each ring's window read on its index, a few rows per ring however many releases the table holds (the plan and `rows_read`); a Sources row for every source in `EXPECTED_SOURCES`, late said in a word; the hero saying all rings are healthy only when a check said so, naming the ring that is not, the part the service check's 503 names, and the pool's numbers that did not answer where each section drawn from them would be; a tile counting up once per number; a project worker alive whose agent did not answer drawn *not ready* with the agent's error on hover (the shell's `wtNotReady`) and counted beside the busy, never *idle, waiting for work* (#273); the journal saying who did a line — the maintainer who proposed a worker's trust, not its owner — and with which agent, keeping Show more while a read came back full (its metrics lines counted), drawing the chip picked last over a slower answer, and refreshing a chip with twenty lines a kind; and a maintainer's roll back drawn for a maintainer only — none on a card whose head is a rollback — and refused by the server to everyone else, run as each role over the Worker's real answers; what rolls each host out, said once per host (#277: a timer from before #277, two rollouts, an updater that is not running), and workers alive before the latest deploy gone silent during its rollout (the error that points at the rollback), never one that went quiet after the rollout was over |
| `go-menu.test.ts` | the ⌘K menu (#241, `GO_MENU` in `layout.ts`): on every page a closed dialog after the footer — nothing of it drawn with script off, Go… still the link to the packages — and its script once, after the shell's, the whole script parsing; the handoff's ten actions, each landing on a page (a fragment on the page it names, Home's `#get-started`); and the menu run over a document of its own: ⌘K and Ctrl+K open and close it, `/` focuses the page's own search where one is marked (`aria-keyshortcuts="/"`) and opens the menu elsewhere, Esc, the cancel event and a press beside it close it and the focus goes back, Tab stays on the line; the line filters actions and packages, ↑ ↓ move round the list with the row named by `aria-activedescendant`, ↵ opens; the packages from the search Home's box asks, at its very address, once per pause in the typing and once per term, a term inside a whole answer narrowed without asking, a package whose name holds the line above an action found by a hidden word; a name that search did not find looked up — the factory's names, then the name on each architecture — and drawn first where it is (an aarch64 package, one only in edge or the lab, one a request reserved), Request "<name>" only for a name found nowhere, the name by the request's own rule (`PKGNAME`, spliced in), landing on the Factory's request card (`/factory?name=…#request`) with the name filled in, ↵ before the answer waiting for it; the hint a package's origin in words; a search or a lookup that did not answer said, to a screen reader too, with no Request over it; one letter asking for one more, not saying nothing matches; on a Mac, Ctrl+K left to a text field; the theme through `window.opTheme`; the kit's sheet linked the first time the menu opens, once; what it writes escaped; a browser without `<dialog>` left as served |
| `factory-page.test.ts` | the Factory (#246, `pages/contribute.ts`): a name taken by one rule — `PKGNAME` in `request.ts`, which the request refuses by in its words, which the card's script, the ⌘K menu and Home's box splice in, which the packages list offers Request by (`BROWSE_NAME`), and which no page module types a copy of; the card's live check (`GET /factory/names/:name`) saying what the request would answer, word for word, for a free name, one a request reserved, one in the pool, one a source ships and a blocked one, and the holder's own name theirs; two requests for one new name at the same moment, one of them has it; the check's reads through the name's indexes, never every package edge serves; what runs now — the listing's live read, the tasks in flight through the queue's index and no counts, never every task; what the pool reads of a repository (`routes/sources.ts`): the forge and the path from the address, the request's project the same repository whichever view was pasted (one project, one registration), GitHub through the request's own `detect()` short of the tree, GitLab and Codeberg through their APIs with the release named for the request, nothing where `SOURCE_CHECK` is off, a read kept by the repository and not the address as typed (a missing one a minute), never asked of a forge for a visitor or a blocked account, and at most `READS_PER_HOUR` an hour per person; the page run over the Worker's answers — "Sign in to send" for nobody and the card kept across the sign-in, the prompt built from the form, the agent's tab naming the two tools an agent requests with (`request_package`, `request_status`) as served, with the login that grants them (`omarchy-cli login --agent`, the agent's name) and the Agents page and the MCP chapter linked (#268), a check said in a few words and the reason under the field, every package on the line where its targets put it (a request whose every build failed off it), each column counting its own cards, the tiles (building now what a worker holds, Shipped a floor — "12+" — when the registry says it was cut), the workers with their agents — one alive whose agent did not answer drawn *not ready* with the agent's error (the shell's `wtNotReady`), counted apart and listed before the idle, idle again once it answers (#273) —, a worker's name and its agent each whole, the agent wrapping under the name (#282), the line read again when a build starts and not for a pool job, a card on the line and its name the sender's the moment it is sent, a person's own requests, a renewal filled from the record and the card a request's again once it is sent |
| `browse.test.ts` | the packages list (#245, `routes/browse.ts`, `pages/browse.ts`) over the fixture: a name once over every ring with the newest version they serve, the ring's version under a ring filter, the architecture and origin filters, recency, a search that puts the names holding it first, the pager both ways by cursor and a search's by number (past the end, back to the last page), what the API refuses and why (a page's number without its cursor, a cursor without its number), a search of any length (no LIKE pattern for D1 to refuse) cut by characters, never in half of one, where the pool has a name the rings do not serve (the factory's, the lab's), the counts kept under the heads they were counted at and counted again once a head moves; the page drawn with the list in it — the rows as links whose cells say what they are to a screen reader, the filters as labelled groups of links that keep each other and the search, the form, Request "<name>" only for a name found nowhere, a name the factory has as its page, a filter that leaves nothing offered to be cleared, one letter not a search yet, a number or a cursor alone the first page, a step back not followed by a crawler, a list that threw said without the database's words —, linked from Home, the footer and the ⌘K menu, drawn from the edge's copy of the address its script asks, and the script's renderers writing the server's characters; then, over a pool of its own, what a view reads: D1's rows_read bounded by the page, never the pool, and every statement's plan through an index or the table's own order, the counts one walk of the name index, a search the table once and its matches ranked, a name's other places two point reads |
| `home.test.ts` | the Pool (#243, `pages/overview.ts`), its served script run over the fixture with the Worker's answers: the four numbers are the stats' (the pool's names, today's arrivals into edge, the stable release, the sources in sync), the chain lists every project the pool reads with what edge serves from it, New in the pool is each ring's head against its parent at the Packages page's address — a release is asked about only while retention keeps it and its parent whole, and only this week — one card per name, and the box's placeholder offers only a name it drew; Requested is the factory's newest names a maintainer let through (`landed`), none blocked, never a name only asked for; Live is packages moving (a sync that brought something, a promotion said once, a security fix, a rollback, the factory's publish) from the journal's newest lines and its latest of each kind, newest first, the day's syncs counted by the daily series, lighting only a line that arrived since the last poll; the search box asks the ⌘K menu's search, stable on the other architecture when the first finds nothing, looks a pacman name no row is named for up at the package page's address and then among the factory's names and draws it first where it is (a request no ring serves "not in a ring yet", never "in the pool"), offers Request only for a name found nowhere, beside the whole search, and says what it shows to a screen reader; the setup card writes the command or the words for an agent for the picked ring, and only when the ring or the mode changes, never on a poll; and the page's own CSS keeps the kit's rules: focus in green on the kit's controls too, a gate's word inside its segment, the chain's squares moving by transform and standing still for a reader who asked for less motion |
| `runbook.test.ts` | the runbook's *After a release* asks nobody to touch a host (AC4 of #277): a real `### After a release`, the last subsection of *The Studio host* after the one-time step, its raw text — code blocks, tables and quotes kept, nothing cut for length — carrying no `docker`, `podman`, `ssh`, `install -m`, `systemctl`, `sudo`, `setup.sh` or `./rollout.sh`, and #278's paragraph gone; the cut itself, on fixtures (a command in a fence under the heading is in it, one under the next heading is not) |
| `docs-index.test.ts` | the docs index (#250): one page of seven short sections in the order its map lists them, with no chapter shell around them; `/docs/api` a 301 to `/docs#api` that lands on the API section; every chapter of the map linked — the reader's from the section each deepens, the code's from the line under the cards; the rings' own words (`RING_TEXT`) and the API's short list (`API_BRIEF`) as the page draws them, a path breaking only after a slash or before its query; the setup command's copy button copying the command alone; the search over every chapter, section and glossary term still on the page, run, and what came of it said to a screen reader; the kit's sheet, helpers and primitives, none of it in the frame's CSS; what the CSS holds at every width — grids of facts with no empty cell, the command in the design's type; the map lighting the section the reader is in, run over a document of its own — a third of the way down the window, the first card at the page's top and the last at its end, a section chosen in the map or named by the address kept lit while the page moves to it and given back on a wheel, a scroll that moves it once it rests, an address that names no section, or a card the browser did not bring into the window; and every link from a page of the docs to the code on GitHub naming a file or directory the repository has (#299) |
| `components.test.ts` | what each page is made of, against the served dashboard: every component's anchor in its page's HTML and its literals in the page's script, every read routed and answering JSON with the fields the page draws, every act routed with its method — and with no other — and answering per role what the manifest says, and the other way round: no fetch in a page script that nobody declares |
| `kit.test.ts` | the tokens and the v1 kit (#239): every colour a page module paints is a palette name — `PALETTE` in `layout.ts` is the one place a colour is written — and the served CSS declares each name in both themes; the palette the handoff's table, dark as given and light with four hues darker in lightness only, so every text colour reaches 4.5:1 on every surface of both themes, measured; the frame square, with no shadow and no gradient; a focused control never left without a green line, the shell's own buttons (the decision dialog's, the Decision cell's) drawn in tokens, every font weight the CSS uses loaded; the theme decided in the head before the first paint (`THEME_BOOT`, run over a document of its own: dark on a first visit whatever the system prefers, light only as the reader's choice, the choice kept and followed across tabs, `window.opTheme`'s get, set and toggle, storage that refuses) and the header's theme switch (`THEME_SWITCH`, #272) run after it: named for the theme it switches to, the one that is on as its description, a press toggling and keeping the choice, answered by the boot so the switch is drawn and works from the first paint, the ⌘K menu and another tab moving it too, nothing drawn with script off, and on a phone the switch at the end of the doors' row; the kit on the pages that pass `kit: true` and nowhere else — the ⌘K menu's script names its sheet, to link the first time it opens —, its one stylesheet immutable under its hash with the primitives, every icon and agent mark and their licences, no coloured mark painting in white or black; a tone or a ring's hue reset where it is read, so a ring card tints nothing nested in it; the shell's `lucide()` and `agentMark()` writing what the server's write; `countUp()` landing its number in 1.1 s, or at once for less motion; a code well's copy button, and "could not copy" when the browser refuses or has no clipboard |
| `agents.test.ts` | the Agents page (#249, `pages/agents.ts`): a page of its own at the footer's `/agents`, drawn with the kit, its own CSS after the kit's sheet and held to the frame's rules (tokens only, square, no shadow or gradient), and reading nothing; the tools it lists are the ones `omarchy-cli mcp` serves, read from `crates/omarchy-cli/src/mcp.rs` in its order — the six reads, then the seven write tools of #252 — none of them marked proposed, every role card with its prompt to copy and the login its tools need, and step 4 the login with the chosen agent's name, which the script follows; every agent offered has a mark from the kit, the documentation its snippet was checked against and the day, and a snippet that names the server `omarchy-pool` and starts `omarchy-cli mcp` (a file's JSON parses), as the MCP chapter's own example does; the agent shown is the address's `?agent=` (the first for none or an unknown one, nothing of the query echoed), and the page's script, run over a document of its own, switches it in place on a plain click, moves the focus to the picker after a mark under the title, and leaves a modified click to the browser; step 1 installs the client the way Get started says, and says the release binary is the way until a ring serves it; no well of the steps breaks a word, and a file's content keeps its lines |
| `agent-tools.test.ts` | the MCP write tools' server side (#252, `routes/agents.ts`, `agents.ts`): the grant made in the signed-in browser only (the session, its Origin and the page's nonce; a bearer refused), its code sent to 127.0.0.1 on the port whatever the link asked, swapped once, not after its minute and not without the verifier, a wrong code writing nothing; review and block a maintainer's, for seven days whatever was asked, contribute thirty by default and ninety at most, three live grants per login and the same agent name replacing its grant at the swap, Grant counted per login at the edge, an agent name with a control or format character refused; the `oma_` token refused with `agent_token` on every route outside the tools' — every decision route, and a read the edge holds — and never taken by `contributorOf`; the role read again on every call; a request through an agent not confirmed and said so on its row, signed record and line; a claim through one with no hint for the project's agent; a release naming the agent; the requester's agent refused with `conflict_of_interest`; a draft deciding nothing and writing no journal line, on its person's `/factory/me` only; confirmed by the same login in the browser — the session, the Origin, the nonce — once, two at once one approval, one publish job and one line, the name typed for reject and block, the predicate run again, a package that moved since refused, expired after thirty minutes, discarded, a failed handler said as refused or confirmed by what was decided; every architecture on the confirm page, and each of the decision's rows, its record and its line carrying the agent and the draft (`through` on `/factory/approvals`); logout, the page's Revoke and a contributor's block ending a grant, and a revoked grant's waiting drafts discarded or refused at the confirm; the person's page listing every live grant and waiting draft first; the bursts (the rate limiting bindings in workerd), the day's counts by login, the cost guard (503 for an agent's write, not a person's); text evidence edge-cached and read by its tail, a package never; every new query's plan; approve and block confirmed with a passkey (#257) — a software authenticator built in the test (`test/soft-authenticator.mjs`: a WebCrypto key pair, authenticatorData with the RP id's hash, the flags and the counter, clientDataJSON, the signature) — the decision's row, record and line naming the passkey and its counter moving; refused with nothing decided and the draft still waiting: a replayed answer, a challenge of another draft or past its five minutes, another origin, another RP id, no user verification, nobody present, a registration's type, a frame of another site, a key of another login, another key's signature, a removed key, a counter that went backwards or stood still; a maintainer without a passkey offered the registration on the page (#287) and refused at the POST and at the challenge without an answer, with the link; another address saying where passkeys work; request changes and reject confirmed without one; a malformed signature of each algorithm a refusal page, never a 500; Confirm the form's first submit button, so Enter never discards; `next` naming the passkey, and for a login without one that the draft's page registers it first (#287); the web's own Approve guarded as well since #271, the session alone approving nothing on Review; the challenge route's session, Origin, nonce and login, one live challenge a draft — the newest — and the cap |
| `passkeys.test.ts` | a passkey registered and removed (#257, `routes/passkeys.ts`): the relying party from one list (every production name is `omarchy-pool.org`, `localhost` any port, nothing else — no IP address); the options (this RP, a hashed user handle, ES256, EdDSA and RS256, user verification required, attestation none, the login's passkeys excluded); the row holding exactly what verification needs, and the owner's `/factory/me` listing it without the key; RS256 and EdDSA as well as ES256; the session only, the page's Origin, a maintainer not blocked, nothing written otherwise; a challenge taken once, for its login and a registration, within five minutes; an answer of another origin, RP id, type, or without the user verified or present, refused with its code; a credential registered once, whoever registers it again; a label of one printable line; ten passkeys and five live challenges a login, a new challenge replacing the earlier one for the same purpose and draft, so retries never lock a person out, and a sixth ceremony at once told in a person's words to wait; registration and removal journaled (kind `passkey`: who, when, which passkey — never the key, the credential or the label); removal the owner's only; since #271 the first passkey the session's alone and a second one, like a removal, refused without an answer from a passkey the login holds — none, one for another act, another login's key, the user not verified, a replayed one — storing and removing nothing, the journal naming the passkey that vouched, two first registrations at once storing one; a registration stored only while the session that asked is still the login's and the passkey that vouched is still held — a reset landing between its challenge and its insert, interleaved through the database, leaves no key and says so (`sign_in`), and the person adds their own after a fresh sign-in; the options for an act (`POST /auth/passkeys/assert`) bound to the login and the act and refused to a token, another page, another address, a contributor, one's own reset, a reset of a login that holds none (before the device is asked) and a login without a passkey; a reset another maintainer's, with their passkey and a reason — the passkeys, challenges and browser session gone with the journal's line, the record signed and without the keys, the person's first passkey again after a new sign-in — each refusal of it removing nothing, two at once one, a record the bucket refused said in the answer and on a line; every new query's plan; the gc's delete of expired challenges |
| `passkey-decisions.test.ts` | the web's own approve and block with the maintainer's passkey (#271, `routes/passkeys.ts` `webGate`, `decidedWith`): decided with one, named on the answer, the record and the line, its counter moving; refused with its code and nothing decided — no answer, a token (a maintainer's `omc_` too), another page, no Origin, another address, an answer for another build or a block or made for another login, another login's key, the user not verified, another origin or RP id in the answer, another key's signature, an expired or a spent challenge, a counter gone backwards; the act's own refusal first, in `can`'s words; request changes and reject unchanged; a package's and a contributor's block the same way, nothing pulled or revoked when refused; a handler called without the gate refusing; the shell's `passkeyed` run as a page runs it — the act's challenge asked, the browser handed it with user verification required, the act posted with the answer, and nothing posted when the browser cannot ask, the prompt is cancelled or no challenge is given; the shell's `refusalHtml` drawing a refusal with the way to add a passkey as a link, in place of the address the words carry, and no link for anything but the person's own section. The other tests that approve or block on their way decide the same way, with `test/decide.ts` |
| `passkey-doors.test.ts` | the last doors without a passkey (#284): a build queued by hand (`POST /factory/enqueue`, a maintainer's session or `omc_` token) refused with `dry_run_only` when `publish` is true, left out or not a boolean, nothing queued and no line, and queued as a dry run with `publish: false` (the row's `publish` 0, the line saying who); the enqueue job's token still queuing a build that publishes, a job without `factory:write` refused; an approval with the maintainer's passkey still queuing its publish job; a forced promotion's challenge bound to its rings and its architecture from meta's lists, a maintainer's act; queued with the passkey for exactly that promotion — the answer and an amber `dispatch` line naming it, one architecture its own act — and refused with its code, ending "nothing was queued", nothing queued: a token, a token beside the session, no answer, another page, no Origin, another address, an answer for another promotion, an act or a login, another login's key, the user not verified, a maintainer with no passkey; a promotion by evidence, a rollback and a health job keeping the session and the token; `handleQueueJob` without its gate refusing; a reset revoking the login's `omc_` token and its live agent grants — not an expired one, one revoked already or another login's — with a journal line each after the reset's, the waiting draft discarded with why, the unswapped code deleted, the record saying so; the person's new token after a fresh sign-in; two resets at once revoking once; every new statement's plan. And the side doors the review of #284 found: a dry run claimed by a project worker with a job token of its task and the journal only — the claim's and the heartbeat's refused by `POST /packages` and `POST /releases`, the task completing as a dry run with nothing indexed and edge where it was —, left out of `/factory/built`, and never the same task as the enqueue job's build of the same recipe, either way round; a rollback to another ring's release (or none) refused with `another_ring`, by the token and the session, nothing queued, and `POST /releases` refusing another ring's `from_release_id`; a maintainer's session or token writing a `note` and refused any health, abi, promote or gate row (`note_only`), a job's token still posting its evidence; `POST /factory/register` refused (`token_reset`) for a login a reset revoked — its mark standing — until the person makes a token on their page, and taking a GitHub token again after that |
| `passkey-guided.test.ts` | a maintainer with no passkey guided, not stopped (#287): `/auth/me` saying whether a maintainer holds one (`passkey`, one entry of the passkeys' index, a maintainer's answer only); the shell's notice — what needs a passkey and that nothing else does, *Register a passkey now* — drawn on Review and on the maintainer's own page every time, once anywhere else as the browser keeps it (`localStorage`, nothing written to the pool; none where storage is blocked), for nobody else, and gone once they hold one; the dialogs of approve, block and a forced promotion run as a page runs them, with the software authenticator as `navigator.credentials`: the first press registers the passkey with the session alone and the dialog stays open, its next press answers the challenge for exactly that act and login and the act is done, the journal line saying "with a passkey registered just now" on the passkey's first use within ten minutes (not on its second, not after the ten minutes); the registration deciding nothing and an answer made for one act deciding no other; a cancelled registration deciding nothing, the dialog saying so and staying; a passkey registered meanwhile — in another tab on the same device (the harness's `create()` refusing a credential the options exclude, as a browser does), or by anyone with the session — asking the device for nothing, the dialog saying where it is listed and who resets one they did not make, and confirming with it; two first registrations racing (one refused as a second, one whose challenge a newer request replaced) going on with the passkey held; the browser keeping that the login holds one (`?held=`: the pool reads nothing for it) until a refusal saying none or a sign-out; the notice's own button saying the outcome in its place and taking the keyboard, Not now handing it to the page's heading; Review's own confirmation (its status line while the device asks, Confirm never disabled) and a package's own Block form doing the same; an agent's draft's page registering the first passkey at its first press and confirming the draft with it at the next, the line saying "with a passkey registered just now"; every page's dialog offering it; and the pinned list — claim, the review workspace, release, request changes, reject, adopt, lifting a block, a category, a withdrawal, a worker vouched for and revoked, a dry run, a rollback, a promotion by evidence, a note and a cancel done by a maintainer with no passkey, and only approve, both blocks, a forced promotion and a reset refused with `no_passkey` and the way to register one |
| `webauthn.test.ts` | the Worker's own WebAuthn verifier (`src/webauthn.ts`), against the software authenticator: CBOR as authenticators write it, and a tag, a float, undefined, an indefinite length, a duplicate or non-scalar key, bad UTF-8, an integer past 2^53, too deep a nesting, a truncated item and a byte after it refused; unpadded base64url only; an ECDSA signature's DER to r‖s, and what is not DER refused; authenticatorData's hash, flags, counter, attested credential and extensions, and a short or trailing one refused; COSE keys for ES256, RS256 and EdDSA, and another algorithm, curve, a short coordinate, a point off the curve, RSA 1024 refused; a registration and an assertion that verify for each algorithm, and each check that refuses one by its code — the type, the challenge, the origin, a frame of another site, the RP id, the user present and verified, the attested credential and its id, a none statement that says something, the key, the signature (another key's, over other data, cut short, raw instead of DER, the wrong length for each algorithm — an Ed25519 one that is not 64 bytes a refusal, never the runtime's error), the user handle, the algorithm, and the counter (zero both times taken) |
| `one-truth.test.ts` | one truth per fact, over the fixture: the review list's `waiting` and `oldest_ms` counted once, each of its rows saying `waits` by the same rule, one meaning of *in review* (#274) — the Factory's line, its served `stageOf` over the registry, files a package In review exactly when Review's list says `in_review` (claimed, let go, claimed again, its rebuild staged, a new version building beside the claim) and Ready for review exactly when it says `ready` (a staged build of a version already approved in neither), and the Factory's Ready for review tile and a maintainer's Review queue link say the list's `ready` and `in_review`; at each step every package the list names has the list's state in its story (`review`, the list's own rule over the story's rows), and the package's own page says the list's word too — its chip, its How it got here Review stage first, and its review panel's tag (#282), neither word for a staged build of a version already approved, and the Factory card's words in its order while a claim on two architectures stages one rebuild at a time —, and the Review page filing each package in a tab by the list's `state` through the served `tabOf` and its tiles reading the list's `ready` and `in_review` — the page keeps no copy of the rule, so stripped of the field it files nothing —, a package's address written by the shell's `pkgHref` alone, one ring for one build, an approval's `standing` carried by the server and where a standing one is today said once — the shell's `approvalWhere` over the row's `rings`, `blocked_at` and `publish_status` (in its rings, blocked, publish failed or cancelled, publishing), run over the served Factory (its Shipped cards and a person's own rows, `lost` settled to the targets the rule gives it) and Review pages as the fixture's people see them — row by row, so the test holds whatever an earlier test did to the database, and by class and word, since the pill's title carries a clock —, so an approval whose publish failed reads "publish failed" on both and nothing promises edge, both lead to its build and never to a package address as if a ring served it, and no page guesses a ring from the registry's status —, the community packages captioned as what `landed` counts (approved by a maintainer, never "in the rings"), the budget's lines and the late hour never typed by a page — and a build's evidence at one address: the shell's `evidenceHref` (its page's Evidence section), linked by a person's builds, Status's jobs table and the checklist's build items through `evidenceLink`; a build that died before uploading anything has a page that says "Nothing staged for this build" and a raw `build.log` that is a 404, so no page writes `/artifacts/build.log` by hand; the server's one answer to what waits for review, whether an approval stands, the rings' order, the late mark, the budget lines — and the pages reading it instead of counting their own; the worker minutes and the jobs of the week as one reduce over `jobs_daily` (the shell's `workerMinutes` and `jobsSummary`, run here as served over the server's rows) on the Status tiles, table and charts, a cancelled job a failed one on every one of them — and on the Workers page's cards, through the shell's `jobBucket` — while a fresh snapshot says otherwise, a job queued longer than the week still waiting, the reduce's window the days asked for, and the bucket one word on the Status page; the worst of a package's advisories picked by the server's `SEVERITIES` over a report built in the test; an advisory's severity in one colour — the shell's `SEV_COLOR`, the pill's class as the CSS paints it — on the pill, the bars and Status's severity counts (the served map and charts run here), no page colouring a severity or naming a bucket of its own; the 14-day health grid drawn once — the shell's `heatGrid` over `PROMISED_RINGS`, run as served over the server's rows on Status — and a health check's result in one word, the shell's `HEALTH_WORD`, on the grid, the Pool's stable tile, Status's ring cards, checks and job results; a person's workers served through the listing's own view (`workerView`: alive by the one threshold, ready, side), so their page's tile counts what its tables draw; the bill in one colour and one figure — the shell's `costColor` and `usd()` — on the Status tile |
| `no-answer.test.ts` | a list that did not answer is said, not drawn: the shell's `api()` rejects a 5xx with the body's error (`{ error: "internal error" }` is what the Worker answers when a route throws) and resolves a 4xx with its body and `__status`; the served pages' own scripts — Review, the Factory, Workers, People, Status (its service line, its workers, its rollbacks, its advisories and its journal among them), the Pool (its lists down with the stats up, and the stats down too: every number "—", Live and New in the pool saying the stats did not answer) — run over a fetch that answers every read with that 500 — and, for Review, as a signed-in owner, whose Yours block then says the lists did not answer instead of "nothing of yours waiting" —, and each page's line names the list and the reason once (the brake's record on Review, the Factory's line and the Status page's workers' clause among them), every tile reads "—" with "did not answer" under it and the reason on hover, none reads 0, no empty state ("nothing waiting", "no promotion yet", "no worker alive") stands in for a list that failed, a tile the stats poll feeds keeps its number when only the lists failed (the Workers page's minutes, beside the chart that draws the same series), and a refresh that fails leaves the last answer's rows on screen — three pages drew "Waiting for review 0 · nothing waiting" in green over a query that threw |
| `pool-jobs.test.ts` | Status's jobs table (the Pipeline's before #248) words a pool job from the shapes the jobs post: the served page's `jobResult` and `paramsLabel` run over the fixture's done job of every kind (params as the scheduler queues them, results as `work.rs` writes them) — a sync's totals summed over its sources with the releases it pinned, a promotion's verdict, a rollback, a render, a health check, the retention, the security run, the verify, the relayout, the enqueue, and the three jobs on a build — the audit's report, the trial's verdict, the file the publish put in the pool — that the fixture ran for real — and the one-source sync and the gate's other verdicts over the shapes as written; a release is named one way in the column, its id first and the ring's head after it where the result carries the sequence; the manifest pins the same fields, so a rename in `work.rs` fails by the field's name and here by the sentence |
| `lists.test.ts` | lists rendered from the code that owns them, never copied: the request's four confirmations, the categories, the sources table, the pacman.conf sample, the cost cadence and the budget's lines, the journal's kinds and the job kinds on the API page, the API page's rows against the routes the router serves, and the docs index's short API table against those rows and the router; the rings, the architectures and the severities (`meta.ts`) spliced into the shell once — `PROMISED_RINGS`, `RINGS_UPWARD`, `ARCHES`, `SEVERITIES` — and every page script reading them, none typing a list of its own, the manifests pinning the read; the Workers page's pool kinds as `JOB_KINDS`; a worker alive by one number, `WORKER_ALIVE_MINUTES`, in the listing, a person's page, the snapshot, the scheduler and the shell's titles |
| `audience.test.ts` | one day of the account's request analytics, both pool hosts in one query, becomes one number per ring and per architecture; recorded once as an `audience` event; a token without *Account · Analytics · Read* is reported once for the day, then quiet |
| `hosts.test.ts` | the pool's names (`src/meta.ts`): a page on an old dashboard name or www moves to omarchy-pool.org with its path and query (301 for a read, 308 otherwise) and its `/api/v1/*` is answered in place; the API's two names and the tests' pool.test serve without a redirect; a sign-in pressed on the API host starts over on the dashboard before any cookie; the setup script, the worker CLI and the include's comment name the API host on every production name, the request's own elsewhere; one edge key serves every name |
| `read-guard.test.ts` | the read guard (`src/cost.ts` `readGuard`): with the cost guard up, an anonymous machine — curl, an empty user-agent, an AI crawler by name, a verified bot of any category but a search engine's — asking `/api/v1/package/<name>` or `/package/<name>` gets a 503 with `retry-after: 3600`, `no-store` and `noindex`, and the next request, a browser's, is a real 200 (nothing was stored at the edge); a browser, an `omc` session, a bearer token, `omarchy-cli/`, `pkg-repo/` and a search engine's verified crawler read on; the file list, the graph, the search, the include and every page stay open to a machine; with the guard down nothing changes; and the guard word is read once a minute, not once a request |
| `provenance.test.ts` | the OPR provenance scan against a stubbed GitHub: origin per package from the tree and `.omarchy/package.json`, only changed packages fetched again, packages gone from the repository dropped, the per-ring counts |
| `token-probe.test.ts` | the daily probe of the pool's own GitHub tokens (#308), against stubbed GitHub answers: run by the cron once a day per token, a 422 an `error` line the Status hero reads (`status-page.test.ts` draws it), a 403 an `ok` line that clears it, a 401 or a 5xx a `warn` (an `error` still, after an error: it clears nothing), the token removed after an error an `ok` line, once, no answer nothing written; the probe itself a dispatch of `rollback.yml` to a ref that cannot exist |
| `jobtoken`, `scheduler`, `governance`, `updates`, `metrics`, `cost`, `signing` | the pure functions: tokens and scopes, the scheduler's rules and that it has no dispatch path (#308), the governance file, bump detection, the metrics snapshot shape, the bill estimate — and its daily report on GitHub: the comment's markdown (the twin of the workflow's jq), posted once with the day's line after the issue is checked for today's comment, never twice, nothing without `GITHUB_REPORT_TOKEN`, a refused post one `warn` line —, OpenPGP signing |

Both page tests run over one fixture (`test/fixture.ts`): a dashboard's
worth of data seeded through the Worker's own endpoints — two packages in
stable and a fix in edge, an advisory, a contributor's package built, audited,
rebuilt by the project, tried and approved, another one published, two more
approved that no ring serves (a publish job that failed, a package blocked
with its approval standing), a blocked contributor — the approvals and the
blocks decided in the browser with the maintainer's passkey, as the web
decides them since #271 (`test/decide.ts`) — one done pool job of
every kind with its params and result as
the brain and the Rust jobs write them, one journal line of every kind, the
metrics snapshot — so the pages are served over something and every path a
test hits is concrete. The Pipeline, the Journal and Security are sections of
Status since #248: their addresses redirect there (`pages.test.ts` asserts
the redirects), and the tests read what they drew on Status.

What a page is made of is declared next to its template: each module in
`src/pages/` exports its components (`PACKAGE_COMPONENTS` below
`packageHtml()`; the shape is in `src/pages/components.ts`), and
`components.test.ts` walks all of them. The rule is simple and it is the
test: **a visible thing on a page is a manifest entry, or it is not on the
page** — an element without an entry has nothing proving it is still there;
and **a new `fetch` in a page script must be declared** by a component on
that page — whether the path is a literal or built from `API`, an id and a
name — or the reverse check names the page and the path. Delete
the route, the element or the field a component lives on and the test fails
by the component's name. A manifest binds its paths to the fixture's ids —
the package, the person, the project's build — never to a pattern like
`/tasks/:id`, so the test can hit every one of them.

The end-to-end script below covers the same paths with real containers and
real pacman; the unit tests are what a pull request runs in seconds.

Keep `worker/src/manifest.schema.json` in sync with the Rust types:

```bash
cd worker && npm run schema:sync && git diff --exit-code src/manifest.schema.json
```

## End-to-end: pacman against a generated database

Requires a container runtime (Podman or Docker) and `gpg`. The script indexes the
fixture packages, renders and signs the `omarchy` database with a throwaway key
(created on first run in `~/.cache/omarchy-cli-poc/gnupg`), signs the packages the
way a mirror or build would, and runs a real pacman (`archlinux:base`, x86_64) inside
a container with `SigLevel = Required DatabaseRequired` against a `file://` mirror:

```bash
tests/e2e-pacman.sh
```

It exercises `-Sy` (signed database accepted), `-Sl`, `-Si`, `-Sp`, the files
database (`-Fy`/`-Fl`), `-Sw` (download with signature verification) and a real
`-U` install. On Apple Silicon the x86_64 image runs under emulation; the first run
pulls the image.

| Symptom | Cause |
|---|---|
| `podman: command not found` | install Podman Desktop (or Docker) and `podman machine start` |
| `agent_genkey failed: No agent running` | `GNUPGHOME` path too long for a Unix socket; keep the default cache location |

## End-to-end: the whole pipeline through the worker

Same requirements plus the worker's npm dependencies. Starts a throwaway local
worker (`wrangler dev` with local D1 and R2 under `target/e2e-worker/`), publishes
the fixtures to `edge`, promotes `edge → rc → stable`, renders and signs the
`stable` databases, checks the mirror routes (databases, signatures, blobs, Range),
walks the factory (a request, a claim and its release, one review for a
package's architectures, the publish into edge), runs an agent's login as a
person does — `omarchy-cli login` on its loopback address, the grant page
posted with the session, a request through the agent's MCP tool, a block the
agent drafts and the person confirms once with the name typed and a passkey
(#257: the confirm page asks for one to be registered first and a POST without
it decides nothing; the person registers one with a software authenticator,
`tests/passkey.mjs`, the registration journaled; then the page's challenge,
the passkey's answer, the form), logout — and, since #271, approves and
blocks on the web the same way: the maintainer's token refused on both
(`session_only`), a first passkey registered with the session, a second
refused without it, the approval and the block posted with the passkey's
answer for exactly that act, and a second maintainer's reset — journaled,
the record verified with gpg, the person signed out — before the agent's
draft's page offers to register one (#287) and one is registered again. Since #284 a build
queued with the maintainer's token is refused unless it is a dry run (the
job token's still publishes), a promotion forced with the token is refused
and one forced with the passkey is queued and journaled with it, and the
reset also revokes the person's token and their agent's grant — a line
each, the draft discarded — before they make a new token and log the agent
in again; the dry run is claimed by a project worker whose job token edge
and the pool refuse, and completes with edge where it was; a rollback to
another ring's release is refused, as is a maintainer's abi row — and
finally runs pacman in a container against
`http://host.containers.internal:<port>/stable/os/$arch`:

```bash
tests/e2e-worker.sh
```

This is the local proof for POC questions 1 and 2: pool objects are uploaded once
(re-publishing is a no-op), promotion is an index write measured in milliseconds,
and pacman consumes the generated database exactly as it would a `repo-add` one.

The run also verifies what the local pool serves: `pkg-repo verify` finds
the fixtures clean, then a signature of other bytes planted beside zlib —
found, and without an upstream channel serving those bytes, reported for a
replacement rather than kept.

The same run exercises the factory against seeded workers and contributors:
claims with worker and job tokens, a community build staged through the
job token and its evidence served, the audit it queues (a community worker
never gets it; the builder cannot write `audit.*`; a project worker declaring
the `audit` kind attaches the report with the audit's own token, and only
that; Review shows the verdict; the agent the worker reported at claim time
is listed on the Factory API), a shared worker waiting for `shared_after`,
the governance table and maintainers API, the profile page and API (with
the track record), the browser session (`/auth/me` with the
cookie, sign-out invalidating it on the server while the CLI token keeps
working), `workers/self`, and the approval rules (nobody approves their own
package; the bootstrap exception with a single maintainer).

Then the pool's orders to its workers (#277, `tests/e2e-worker-orders.sh`,
sourced by the run): real `pkg-repo work` processes, a fresh worker per
scenario, side by side — D's provider is its own among the scenarios that
fail in a class the breaker counts, so it counts exactly its three sites —, each under a supervisor
that starts it again after an exit 75 as `restart: unless-stopped` would
(`OMARCHY_SUPERVISED=1`), against a stub agent that comes up late
(`tests/agent-late.py`: refused, then answering, or out of credit). The
local pool runs with `WORKER_RULES_SCALE=60` — the step timings only,
honoured because it is no release; the two minutes a process must have run
before a restart, and the breaker, are never scaled. **A**: the agent comes
back after the pool's re-check — re-checked once, no restart. **A′**: a
restart refused by the worker's own probe once the agent answers.
**B**: restarted once by the pool, and back, with the worker's clock ten
minutes ahead (libfaketime): on its own clock its probe would never look
stale and its process would look ten minutes old, so the re-check that comes
and the restart that waits two minutes of the pool's uptime show the ages are
the pool's. **C**: an agent that
never comes back — restarted twice, 30 (scaled) minutes apart, then one
give-up line. **D**: two other sites with spells an hour old on the same
provider — the breaker holds the restart, with one line. **E**: credit out
— no order, and the page says why. **F** (part 2): a worker drained by a
maintainer hears the notice with its next claim, once, and is resumed — it
never exits. **G** (part 2): a project worker runs a health check from a
stub checkout that hangs — it creates a container labelled with its task and
leaves a child that never ends —; its claim declares `stop-task`, so `/can`
words the stop as a child's, and the door's `until` is the fenced lease's
end; a maintainer stops the task, which stays
the worker's until its next heartbeat brings the stop: the child dies, the
container is removed, and the worker's next claim gives the task back to
the queue, where it runs again and is done. **H** (part 3): the set's
updater — the real `factory/bin/omarchy-rollout --loop`, against a stubbed
engine — asks the local pool's `follow` with its builder's id, which it
learns from the broker, runs one round for the Update a maintainer gave that
builder and no second one, and the Update closes when the builder claims on
the pool's release. Every order of the run has exactly one issue line and
one final line in the journal.

Publisher commands used by the script, for manual runs against any worker:

```bash
export OMARCHY_API=http://127.0.0.1:8787 OMARCHY_TOKEN=<a job token>   # tests/e2e-worker.sh shows how one is minted from JOB_TOKEN_SECRET
pkg-repo publish --ring edge foo-1.0-1-x86_64.pkg.tar.zst   # pool + index + new edge release
pkg-repo promote --from edge --to rc                        # --arch aarch64: that architecture only
pkg-repo render --ring rc                                   # databases for the ring head (the pool signs them)
pkg-repo releases --ring rc                                 # history, newest first (--json, --all)
pkg-repo diff --ring rc                                     # what the head changed: added, removed, upgraded
pkg-repo rollback --ring rc --to <release id>               # then render again (--arch x86_64: that architecture only)
```

## End-to-end: the thin client

Runs `omarchy-cli` against the staging index and two real Arch systems exported
from containers (only `var/lib/pacman/local` and `usr/lib/lib*.so*` are extracted):

```bash
tests/e2e-client.sh
```

* current `archlinux:base` → `check xz` is safe, `install --dry-run` prints the
  `pacman -U` command; three `.hook` files dropped into the rootfs show the
  hook preview: one triggered by the package's name, one by a file it ships
  (`usr/bin/xz`, fetched from the ring), one not (a `Remove` trigger); a typo
  in `--ring` is refused before any request;
* `archlinux:base-20210131` (glibc 2.32) → `check xz` is **BLOCKED** on
  `libc.so.6(GLIBC_2.34)` with exit code 2 and pacman is never invoked;
* with `cargo-zigbuild` installed (`brew install zig && cargo install cargo-zigbuild`)
  the client is cross-compiled for `x86_64-unknown-linux-musl` and `omarchy-cli upgrade`
  runs inside the container: safety check, `pacman -U` from the pool with signature
  verification, hooks, and the release pin.

The container needs `DisableSandboxSyscalls` in `/etc/pacman.conf` because pacman
7's seccomp download sandbox cannot run under x86_64 emulation; the script sets it.

You can also point the client at any rootfs by hand:

```bash
OMARCHY_API=https://pkgs.omarchy-pool.org omarchy-cli --root target/rootfs-2021 check xz
```

## Benchmark (historical)

The proof-of-concept benchmarks — the index model at scale and today's rsync +
repo-add mechanics at the same package count — live in `poc/bench/`
(`bench-promotion.sh`, `bench-current.sh`, `seed.py`) with their results in
[`poc/RESULTS.md`](../poc/RESULTS.md); the `Benchmark` workflow runs them by hand.

## The images the checks run in

`tests/images.env` pins `archlinux:base` and `menci/archlinuxarm:base` by
digest; every script that starts a container sources it, so a run today and
a run next month see the same image. `tests/pin-images.sh` moves the pins
to the current digests (commit the diff).

## Health check

```bash
OMARCHY_API=… OMARCHY_POOL=… OMARCHY_TOKEN=… tests/health-check.sh stable
```

The include the check writes is the pool's own (`/api/v1/pacman.conf`), so
each section's `Server` is the directory its database is in; every project's
keyring the caller fetched (`OMARCHY_KEYRINGS`) is imported and trusted, the
way `pacman-key --populate` would.

## The trial

```bash
OMARCHY_API=… OMARCHY_POOL=… OMARCHY_TOKEN=… OMARCHY_KEYRINGS=… tests/trial.sh aarch64 <staged build> <package>…
```

What the `trial` job runs once the project's review build sits in the lab: a
clean container of the architecture with the include of `--ring lab` — the
lab's sections above `edge`'s — checks each named package would come from a
lab section, installs them for real (`pacman -S`, dependencies from `edge`,
hooks run), verifies their files (`pacman -Qkk`), and ends with a `TRIAL=`
line (`ok`, `sync-failed`, `not-from-lab`, `install-failed`, `files-differ`).
Posts a `trial` event either way and writes the transcript to
`$OMARCHY_WORK_DIR/tmp/trial-<build>.log`, which the job attaches to the build's
evidence as `trial.log`.

Second argument selects the architecture (`x86_64` default, `aarch64` uses the Arch
Linux ARM image on an ARM host). Reads the ring's rendered repos from
`/api/v1/stats`, writes a `pacman.conf` with
`SigLevel = Required DatabaseRequired`, runs `pacman -Sy`, lists every repo and
downloads the first package with signature verification inside an Arch container,
then posts a `health` event (ok / error — a ring with nothing rendered fails its
check, since #47). The
`health` job runs it daily for every ring and architecture; the `promote` job
runs it for the source ring before the gate and for the target ring after the
promotion — on the project worker, with the job's token (`OMARCHY_TOKEN`).

## ABI gate

`tests/abi-gate.sh <ring> [arch]` checks two references: the distribution's
base image and, on x86_64, the Omarchy installation `tests/omarchy-rootfs.sh`
builds from `stable` (cached a week under `OMARCHY_WORK_DIR`); the `abi`
event carries one entry per reference (`references`), blockers in either
block. Run by hand:

```bash
OMARCHY_API=… OMARCHY_POOL=… OMARCHY_TOKEN=… OMARCHY_KEYRINGS=… OMARCHY_WORK_DIR=… tests/abi-gate.sh rc x86_64
```

### The check itself

```bash
OMARCHY_API=… OMARCHY_POOL=… OMARCHY_TOKEN=… tests/abi-gate.sh rc x86_64
```

Exports the pacman database and shared libraries of the official base image
(`archlinux:base`, `menci/archlinuxarm:base` for aarch64), asks
`omarchy-cli status --json` which installed packages the ring would upgrade, and
runs `omarchy-cli check` on them in batches of 40 (each batch resolves its
dependency closure through `/api/v1/graph?arch=`). Posts an `abi` event with the
counts and the first blockers; exits 2 on any blocker, 1 if a batch could not be
checked. Runs in a few seconds; the `promote` job runs it for both architectures.

## Security matching

OSV: `cargo test -p pkg-repo osv` covers the matcher (a hit becomes an exact
advisory against every Arch package that embeds the component, one per
package; severities from the database's word, else a coarse reading of the
CVSS v3/v4 vector; Go versions lose their `v`); `cargo test -p pkg-repo osv --
--ignored` asks the real API about an old `golang.org/x/crypto` and caches
the record. The worker test indexes a manifest with components and checks
`GET /security/components` lists them once a ring serves the package.

### Trackers

```bash
curl -sfL https://security.archlinux.org/issues/all.json -o arch.json
curl -sfL https://security-tracker.debian.org/tracker/data/json -o debian.json
curl -sfL https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json -o kev.json
curl -sfL https://epss.cyentia.com/epss_scores-current.csv.gz | gunzip -c > epss.csv
pkg-repo security --arch-tracker arch.json --debian debian.json --kev kev.json --epss epss.csv --dry-run
```

The dry run prints the vulnerable matches by source and confidence and samples of
the Debian `name-version` matches (ours vs Debian's fixed version) to eyeball the
heuristics; without `--dry-run` it writes to the index and posts a `security`
event. The decisions are unit-tested in `crates/pkg-repo/src/security.rs`
(`cargo test -p pkg-repo security`): version comparison against Arch advisories,
Debian filling only what Arch does not cover, the upstream-version extraction
and the name-collision rejection. `tests/e2e-worker.sh` puts an advisory on the
zlib fixture and checks the ring report and the KEV flag.

```bash
pkg-repo fast-track --ring stable --from edge --dry-run     # candidates only; exit 3 when none
omarchy-cli --ring stable --root <rootfs> security          # installed packages with open advisories
omarchy-cli --ring stable --root <rootfs> upgrade --security-only --dry-run
```

The candidate rule (confident match, medium or worse or exploited in the wild,
a clean newer version in the source ring) is unit-tested with the rest of the
security module.

## The broker, and the worker script's secrets

`python3 tests/broker.py` (CI) runs `factory/bin/broker` against a fake
pool and a fake agent: the worker's token added to the pool's calls and a
user agent of its own (Cloudflare answers urllib's default with 403), the
job token stripped from claim and heartbeat, one task at a time (a second
claim 409, another task's id 403), a restarted broker adopting the task the
pool says is leased to its worker, `complete` releasing the hold, the agent
cap per task, who really answered (`agent`) for the probe, GitHub read-only
with the token, and the pool path off without a worker token; and the
pool's orders to its builder (#277): an answer passed only for an order the
broker saw delivered on a claim it relayed, between two tasks and once
(`DELIVERED`, 409 for a second, 403 for one it never saw), its claims
saying it restarts with its builder (`x-omarchy-broker-takes:
pair-restart`), and the broker's own exit after an accepted restart — not
when the pool refuses the answer —, and the orders a 426 carries seen
delivered like a claim's; and a stop (#277, part 2): the pool's `409` with
`stop` on the held task's heartbeat forwarded unchanged and the hold let
go, for a builder whose claim declared `stop-task` — then, for the fence
(`STOP_FENCE_SECONDS`), a claim refused and an order's answer too, and
for as long as an upload of the stopped task is still in flight through
the broker, past the fence, then the fence's length from its return; the
stopped task's heartbeat, upload and fail refused without asking the pool
(`STOPPED`), until its lease's end or until a claim hands it out again; a
`409` without `stop` and a `503` leaving the hold; a builder from before
#277, and one of its first part (orders, but no `stop-task`), keeping its
hold; and a broker started fresh never adopting a task
whose view, read past the edge cache, carries `stop_order`.
`python3 tests/agent-claude-code.py` runs the claude-code provider against
a fake `claude`.

`bash tests/worker-agent-recheck.sh` (CI) drives the claim loop of
`omarchy-build-worker.sh --container` on a fake clock — the script sourced
up to its dispatch line, the pool a stub that answers every claim with 204,
`sleep` moving the clock — against a stub `agent.py` refused at start and
answering 100 s later (#273): the first claim says `error` with the
refusal, a claim within a minute of the agent coming up says `ok`, no
restart; four probes, then the half-hour one; a failure logged once; an
agent that never answers probed at gaps that double back to the half hour
and stay there (two probes in its second hour); and the same through a
broker's `/health`.
`bash tests/worker-orders.sh` (CI) drives the same loop with a stub pool
that hands it orders (#277): the claim says the kinds it takes, its
instance, start, where its agent is and how its last process ended (once);
a re-check probes now, answers what the agent said, and leaves the worker's
own backoff where it was; a restart is refused by a process under two
minutes old, and by one whose agent answers when it was ordered only if the
agent is down, and is otherwise answered and followed by exit 0 and a note
of why; a drain is a notice; a kind it does not know is refused by name, an
order seen twice answered once, a reason printed stripped and never run; an
answer it cannot read is logged and slept on, never an exit; three answers
with orders in a row slow it to the idle poll; a refused `complete` is
logged, not fatal, and a task it cannot read is failed at once; an order
riding a 426 is obeyed; the note of the last process's end is said until
the pool answers a claim; a person named `pool` gets a person's re-check;
an ordered probe that fails just after the agent answered leaves the
worker's own first wait, not a probe at the next turn; and `--self-test`
reads the answers a pool may send and asks no pool. A stop (#277, part
2): the build runs as a job of its own process group, the keys the shell
holds unexported still its own; a heartbeat's `409` with `stop` (or a
`404`) writes the state and interrupts the main shell's wait at once — not
when the build ends —, the build's group is killed, no `fail` posted, no
note left, and the builder exits 0; a `409` without `stop` and a `503` stop
nothing; a `SIGTERM` during the build waits for it, as before.
`bash tests/task-containers.sh` (CI) holds that every container a task
starts or creates carries the task's label (#277, part 2): the scripts
`pkg-repo work` runs through `script()`, read from `work.rs`, and the ones
they run, checked line by line for `"$RUNTIME" run` and `create` without
`com.omarchy.task` (a script of the list running another one it does not
name fails too); then `tests/health-check.sh` and `tests/abi-gate.sh`
against a stub docker and a stub pool, their `run` and `create` named and
labelled with `OMARCHY_TASK_ID`, and as they always were without it; and
the containers the Rust worker starts itself — a `Command::new(<runtime>)`
in `crates/pkg-repo/src` that runs or creates one (the build's, the enqueue
job's PKGBUILD reader) carries `stop::TASK_LABEL` —, the check itself shown
to catch one that does not.
`bash tests/entrypoint-agent.sh` (CI) runs the image's entrypoint in the
agent role with a Claude subscription and a stubbed installer: none
installed, one that answers `claude --version` left alone, one that does
not (an install cut short) removed and installed again — so a restart of
the agent service fixes it; and a project worker's start writes the id the
pool answered for its token to `/run/omarchy/worker-id`, mode 0644, where
its set's updater reads it (#277), never the token.
`bash tests/restart-policy.sh` (CI, docker) pins the engine's restart
policy a worker counts on: under `on-failure:2` an exit 75 is started
again twice in the container's whole life and then left down, a healthy
run between the two giving none back — why a worker takes a restart under
`on-failure` only with three or more left.
`bash tests/worker-needs-native.sh` (CI, the Rust job) runs `pkg-repo work
--once` against a stub pool that hands it the project's x86_64 review
build and a stub `podman` that plays the build container (#281): on an
emulated worker, the build script's exit 96 and a library the loader could
not map (`failed to map segment from shared object`) are reported
`needs_native: true, final: false`, the log staged; the same loader line on
a native worker is a plain failure; the gate's stays final. The labels the
worker claims with (`--labels`, or `WORKER_LABELS` alone) are the ones its
build container gets, and the container carries its task's name and label
(#277), which a stop removes it by.
`bash tests/omarchy-rollout.sh` (CI) runs the updater against a stubbed
docker and a stubbed pool, a contributor's set and the Studio's services
alike: the brokers (`agent-proxy`, `broker-*`, a service with the broker or
agent role) in an `up` of their own, each asked from inside its container
until it answers — the tries between the two `up`s, a pause between them —
before the workers are replaced together; a broker that never answers said
as a warning within `ROLLOUT_BROKER_WAIT` — one bound for all the brokers,
not one each: the wait spent, the next broker is asked once — and the
workers replaced anyway; brokers compose could not start said, not waited
for. And #277's: the poll (a round for a new release, an Update not acted on
yet, a rollback, a kick during the sleep and during a round; none for the
same release or the same Update again, nor for a pool that answers 404,
garbage or nothing, until `ROLLOUT_EVERY`; the pool's `/api/v1/version` asked
when follow is gone, and a lower release there — a rollback past #277 — a
round within one poll); the ids (a builder's through its broker, a project
worker's from its file, each once per container, a malformed one left out,
nothing read of a builder's container); the lock (skipped while a live round
holds it, broken when its holder is gone, not running or started again, or
stuck past its expiry, kept until then when it names no holder — broken by
the id it was judged by, so a round that lost the race to break it skips
and leaves the other's lock; released at each round's end and before the
self-replacing one-off, never when another round holds it, and by an EXIT
mid-round — and by a TERM that lands as the engine creates it or as the
release reads it back, in `--once` and the loop, sent at that point by a
stub hook with no sleep, while a TERM during a failed create leaves
another round's live lock alone: #295; a release whose read or removal the
engine did not answer keeps it held, removed by `--once`'s EXIT trap and
by the loop's next round, which runs rather than taking its own lock for
another round's; every run that must end on its own, and every stop of
the loop, bounded at 60 s, so a TERM no longer honoured fails the test
instead of hanging it); the guard (restarting at two samples in a row, restarts that
grow on a service this round did not replace, one that ran and stays down,
one not replaced, a new updater that fails its self-test — each keeping the
old images and the updater's own; one restart, a busy builder and a service
stopped before the round passing; an updater image from before #277, which
has no self-test, adopted on the set's guard alone, and held back by it
like any other); and `--self-test`.
`bash tests/host-setup.sh` (CI) runs the Studio's `factory/host/setup.sh`
with stubs, as the one-time step: the installed `compose.yml`'s `updater`
has the socket and `POOL_ROOT` at the same path, read-only, and no token;
`rollout.sh` carries `# omarchy-rollout: kick-v1` on its second line; an
env file, mode 600, for every `env_file` `compose.yml` names, and the
review2 pair behind its own profile (#295); before the timer is touched,
the new `compose.yml` checked against a staged copy of the host's `.env`
and `etc/` under its profiles and under every profile (an override's own
env file staged with the rest of `etc/`), a container of a service it
leaves out under the host's profiles warned about, and a compose that
does not load, another `POOL_ROOT`, an updater image from before #277 or
one that does not pull, or a service without a worker token (its value
never printed) refused with 4 and nothing changed (after the pull, said
to have pulled the image); the user timer of a host from before #277
stopped as its user before anything is installed, and disabled only after
the updater's self-test (a reboot before then brings it back), a rollout
it started waited for (a try every 15 s, four hours at most),
the files installed with the old ones kept in `setup-backup-<time>/`, the
env files it wrote listed there, and the lines of `compose.yml` they replace shown, the updater started, seen
running at every look for 30 s and passing its `--self-test`, and only
then the timer's units removed and the timer said retired once its user's
systemd says it is stopped; a systemd that does not answer ends
`setup.sh` with 3 and nothing installed (one that stops answering after
the stop says so, and the timer is tried again); a rollout still running after
four hours, an interrupt during the wait (TERM: 143, HUP: 129), or an
updater that does not start, restarts or fails its self-test (3, or 5)
putting everything back — the updater it started stopped and removed, the
old files and no new env file, the timer enabled again and never disabled
— the last also with the reader of its output gone before the put-back
writes a word; a fresh host gets no timer and starts
nothing; `rollout.sh` wakes a running updater and starts one that is not
running as it is (`--no-recreate`), never both, and `--check` asks it,
nothing more; the runbook's way back run as written (see below);
and the runbook's one-time step says `setup.sh` waits up to 4 h, how to
bring the timer back after a SIGKILL, and looks first with no `docker
compose` command.
The way back picks the backup from before the updater, even beside a
newer one, one with no `compose.yml` or one with the updater's `rollout.sh`,
and with no such backup it stops before anything. It stops the updater by
its compose labels before any copy, even while compose cannot load the
project; a `docker ps` or `docker stop` that fails, or an updater still
running after a `docker stop` that succeeded, ends it non-zero with
nothing copied. A `docker rm` that fails, and a paste again after it
stopped before `enable --now`, both reach its last line,
`docker compose config -q`, after the timer is enabled. It removes only
the env files the step wrote that still hold the untouched placeholder:
a created `etc/agent.env` with a key and a quoted token stay, and after a
`setup.sh` killed as it wrote its first placeholder, which the backup
lists already, no review2 placeholder is left.
The one-time step never leaves the host with both rollouts or neither
(#298). A TERM during the timer's stop, and a stop that exits 1 while the
timer ends inactive, both end with the timer enabled again. A put-back
whose `docker compose stop`/`rm` of the updater fails while it still
runs, or whose `docker ps` check gets no answer, or whose copy of an old
file fails, keeps every new file (never one old file beside a new one),
enables the timer and names the way back, and a paste again is then
refused; one whose docker hangs on the updater's stop ends through its
timeout (shortened by `SETUP_PUT_BACK_TIMEOUT`). A `setup.sh` killed by
its recorded PID after the install, or between the `compose.yml` and
`rollout.sh` installs, then pasted again (or a host with only the
kick-v1 `rollout.sh`) exits 4 before any pull or `systemctl`, and after the way back a paste again finishes with a Done
line that names a backup without the updater. A second `setup.sh` while
one holds `.setup.lock`, a `rollout.sh` started by hand (a stub `pgrep`)
while the timer's service is inactive, and a `COMPOSE_FILE` with an
absolute or `../` path are refused with 4 before the timer is touched.
The runbook's kill paragraph checks `grep -c '^  updater:' compose.yml`
and, when it prints 1, sends the operator to the way back and never to
the timer.
`bash tests/rollback-workflow.sh` (CI) runs `factory/bin/release-rollback`,
what `rollback.yml` runs, against stubbed buildx, cosign and wrangler in a
repository with release tags: the release's `:vX.Y.Z` asked for and its
Worker installed and built before any tag moves; `:x86_64` and `:aarch64`
re-pointed at the release's own images and `:latest` at its `:vX.Y.Z`, each
signed, then its Worker deployed from the tag with its version and no
migration, a `deploy` event and the running version checked; a deploy that
fails putting each tag back on the digest it named, recording nothing; back
past #277, the columns its listing would serve cleared just before the
deploy, again after it and once more once `/version` says the older
release, the UPDATE run against a database built from every migration
(every column the newer Worker withholds empty but a person's drain,
`instance_churn` 0, a task's stop fence gone, the rest of the row
unchanged, a second run changing nothing: #295); a `to` that is no release tag, a release whose
smoke start failed (its `:<arch>-vX.Y.Z` pushed, no `:vX.Y.Z`), an image
never pushed, a Worker that does not install or no deploy token moving
nothing.
`bash tests/release-workflow.sh` (CI) reads `release.yml` itself: each
architecture's leg pushes its `:<arch>-vX.Y.Z` and starts every role from it,
and moves, tags or signs nothing else; the job that needs both legs moves
`:vX.Y.Z` only, signed; `worker-image-tags`, which needs `publish-release`,
moves every tag a host follows — `:x86_64` and `:aarch64`, then `:latest`,
each signed, the three `release-rollback` moves back — and no other job
does; with the jobs' needs run as GitHub runs them, a failure in
`host-bundle`, `verify-agents`, `host-bundle-upload` or `publish-release`
moves no tag a host follows (#359); the deploy needs `worker-image-tags`; and
`publish` fails on a published release or on a `v*` tag of the version at
another commit (#351), and makes a draft an earlier run left again (#311),
never reusing assets this run did not build.
`bash tests/trust-pins.sh` (CI) reads what the hosts' trust relies on in the
repository (#308): `release.yml` and `rollback.yml` install one exact cosign
through the installer pinned by commit, every `cosign sign` (there and in
`release-rollback`) names its Fulcio and Rekor, every job that can mint an
OIDC token runs in a reviewed environment (`release`, or `pool` for the
rollback), `release.yml` writes nothing by default and every job that
publishes waits behind `version`, which runs in `release`, the docs show the
exact identity and no regexp, the base images are pinned by digest and the
docker CLI by SHA-256, CODEOWNERS gives every maintainer the workflows, the
host agent, the dispatcher and the host sets, the one `v*` tag ruleset
lets nobody move or delete a tag (no ruleset file restricts creation, which a
user-owned repository cannot apply, #351); the host agent's pin on
`release.yml@refs/heads/main`, never a tag, is its own cargo tests'.
`bash tests/image-smoke.sh <image>` (the release, on each architecture's
`:<arch>-vX.Y.Z` before any tag moves; CI, on a local build of the commit)
starts every role from the image: the updater's `follows` label, the project
worker's entrypoint against a stub pool (its id written, `pkg-repo work
--self-test`, then `pkg-repo work` itself up to its first claim — which
process it is, what it takes, what rolls its set out — and out on the empty
answer), the broker answering on `:8790`, the builder's and the updater's
`--self-test`, and the egress sidecar's role refusing cloud metadata and a
POST. `bash tests/task-networks.sh` (CI, on that local build; #336) runs the
dispatcher with the real egress and agent sidecars and two probe tasks at
once, its environment being the `etc/dispatcher.env` that `omarchy-agent
dispatcher-env --write` rendered (#371: the token and an owner's line kept,
0600, the machine's own addresses with a stand-in public one, the secrets
directory, a budget): a public mirror answers through the egress only; cloud metadata, a
public name resolving to loopback, a raw socket ("Network is unreachable"),
the host's LAN address and gateway, and the other task's container, egress
and agent are out of reach; through the egress the host's LAN address is
refused and so is the stand-in public one, as "an address of this host" and
as an IPv4-mapped IPv6 literal, which every egress sidecar was given
(`--deny`; the LAN address is checked among the agent's where iproute2 and
`/proc/net` found it; a deny entry written v4-mapped is the IPv4 address,
unit-tested in `pkg-repo`); the agent sidecar's caps are the
budget's; the probe sidecar's word reaches the claim; a
signed exception's task gets a bridge network; a stop removes only that
task's container, sidecars and network. The agent's side of that file is
unit-tested on interface lists (`crates/omarchy-agent/tests/fixtures/addresses/`:
a home LAN host with docker's bridges and IPv6, a VPS with a public /32, and
a Mac's `ifconfig -a` listing with its vmnet bridge and a VPN tunnel, read
through a played `ifconfig` beside no `/proc/net`; a bridge on a global range
kept, an address on `lo` but loopback's kept), on
`/cdn-cgi/trace` answers (an IPv4 address in its v4-mapped form kept as
IPv4), on two writers (a refresh waits for a rotation's lock and keeps its
token), and in the run loop against the fake engine and pool (a new DHCP
lease, a new public address asked hourly and again within minutes after no
answer, agent.toml read again and refused when others may write it or it is
a link), and `tests/host-enroll-e2e.sh` (the E2E
workflow) checks its keys after the Confirm and a rotation.
`bash tests/emulated-lane.sh` (CI's `emulated-lane` job, on an x86_64 and an
aarch64 runner with `qemu-user-static`; #338) runs an emulated lane on a real
engine, each runner emulating the other architecture: the agent's smoke run
of the pinned foreign Arch image (`tests/images.env`) turns that lane on
(`via: qemu`), `emulate = []` holds it off and runs nothing, and the binfmt
handler switched off holds it for a person with the native lane kept; then a
stubbed pool hands the dispatcher one build of that architecture on the
emulated lane, whose task container runs it under qemu (`uname -m`), is told
`WORKER_LABELS={"emulated":true}` and no variable outside the allowlist, and
builds a real package with the image's own `bsdtar` and `zstd`, which the
dispatcher uploads and completes with every call carrying its job token. By
hand it needs the handler (`factory/host/prep-root.sh`, or
`docker run --privileged --rm tonistiigi/binfmt --install arm64` for a run,
`echo -1 > /proc/sys/fs/binfmt_misc/qemu-aarch64` after) and runs under the
engine lock like the other real-engine tests
(`flock /tmp/omarchy-engine.lock bash tests/emulated-lane.sh`). The
switched-off case runs only in CI (each job its own VM) or with
`EMULATED_LANE_TOGGLE_BINFMT=1` and root or passwordless sudo: the handler is
the kernel's, so for those few seconds every emulated container on the
machine fails to start, other users' and other runs' included — not on a
shared machine.

What the build sees is checked by hand in the worker image (SECURITY.md,
*Isolation*): `hold_secrets` leaves a child with no secret, `as_builder`
gives the build user seven variables and no read of `/proc/1/environ`,
`with_secrets` lends the agent its keys with nothing in an argv; a builder
started with `OMARCHY_BROKER` drops a token set on it by mistake and starts
the build with zero secrets. `factory/worker/omarchy-build-worker.sh` is
sourced up to its dispatch line for that (`sed '/^hold_secrets$/,$d'`), in
`docker run --rm ghcr.io/firemanxbr/omarchy-worker:aarch64` with fake values.

## A Mac host

What #320 adds is tested on Linux, where a Mac is played, and on a macOS
runner, where the agent's tests run whole (the `agent` job's macOS entry:
`cargo test -p omarchy-agent`):

- `crates/omarchy-agent/src/vm/` — the VM's size (half of a 16-core, 64 GB
  Mac is 8 CPUs and 32 GB; the envelope's caps; never the whole Mac; half of
  a 6-core Mac refused below the minimum, with what the caps could give), its
  three mounts (under the home directory in any case, holding it, linked into
  it, overlapping, a `:` or `,` all refused; below `/Users/Shared`, a root
  another account owns said once for the three, a directory swapped for a
  link refused, the root itself a link, one not there yet left to install,
  a mount elsewhere not looked at), the `colima start` argv, the
  saved `colima.yaml` read back (a size, a mount or Rosetta is a restart; the
  home mount, Colima's default with no mounts, a mount point elsewhere and a
  forwarded SSH agent are exposures; another VM type or architecture is the
  person's to delete), the task firewall's rules (prep-root.sh's step 9 for
  the task subnets, DNS to the VM's resolvers before the drops, hooked in
  once) and its script run under `sh` with iptables and systemctl played
  (the rules kept in the VM, 0755; under systemd the unit after
  `docker.service` enabled for every boot and reloaded only when it
  changed; the rules applied each run), Colima's environment (the pinned
  docker CLI first on its `PATH`, the agent's own `DOCKER_CONFIG`), the
  clock after a wake (the VM held within five seconds of the pool's `Date`
  through the Mac's own — 5 s behind a Mac 5 s behind the pool is 10 s and
  set; a Mac off the pool's said, the VM then held to the Mac's, a sleep's
  drift on top of it removed, a `Date` years off moving nothing), an HTTP
  `Date`, and M7's rate limit.
- `run/vm/` — the run loop's keeper on a played Colima: a stopped VM started
  as a child the loop polls (only once the pinned docker CLI is known, which
  Colima needs), the rate limit holding a second start and said once, the
  task firewall run after every start, hourly and after a wake (one that
  does not apply said and tried again), a size change waiting for running
  tasks (an engine that does not answer counts as a task), a size below the
  release's signed minimum neither started nor resized and one above the Mac
  held to it, an exposure restarted at once, only a start while a
  self-update's gate is shut, a wake asking the pool now, the clock set to
  the pool's and the profile restarted when that does not hold, the clock
  checked while a resize waits for tasks and beside an unreadable
  `colima.yaml`, a work root swapped for a link into the home directory
  keeping a stopped VM stopped and a set directory swapped for a link
  keeping a running one from being stopped for a resize ("needs a person");
  and the count after a start (a docker stub for the engine in the VM):
  `run/capacity.json` rewritten with the VM's totals and the Rosetta lane,
  unchanged when nothing changed, the lane left out under `emulate = []`; a
  release's x86_64 image the VM's store lacks: no smoke run, the lane kept as
  the file had it (none added to a file without it) and a resize's new CPUs
  written; the native build image it lacks: no pull, no run, the file as it
  was. `run/agent_tests.rs` (`on_a_mac`) — the agent with its
  keeper: a wake polls the pool at once (no poll due) and the VM's clock is
  set to the `Date` of that answer on the same tick; a Mac whose clock the
  pool refuses (a 401 for the signed host state) hearing the pool's time
  from the refusal, said to need a person and its VM held to the Mac's; a
  wake asking the pool's edge for the public address at once, which reaches
  `etc/dispatcher.env` on that tick; a start that ended
  counts the capacity again, and a count that did not happen is tried again
  an hour later, not every tick; the applied release's minimum holds the
  size.
  `capacity/tests.rs` — a Mac's facts, one function for install, `capacity`
  and the count: the VM's level and `MemAvailable`, the Rosetta lane after
  its smoke run (the emulated lane's own, #338: one lane like a binfmt one,
  `page16k: false`, nothing in `held_lanes`), none under `emulate = []` or
  when it fails, and Docker Desktop's VM at `vm-shared` only. `run/compose.rs` — a running task is any
  container labelled `com.omarchy.task` (a task with the `direct` exception
  has no sidecar). `run/pool.rs` — the answer's `Date` header read (the host
  state's, whatever its status);
  `enroll.rs` — `token` and `enroll` find a Mac's set directory from
  agent.toml.
- `install/tests.rs` — preflight and install on a played Mac (`os` macos;
  launchctl, sysctl, route and a Colima that saves its profile played; a
  docker stub for the engine in the VM whose egress probe answers as Colima's
  NAT until the task firewall went in): the VM sized and started with only
  its three mounts, Colima given the pinned docker CLI on its `PATH` (a
  played Colima refuses to start without it, as on a Mac with only Colima
  and Lima from Homebrew) and the agent's `DOCKER_CONFIG`, the task firewall
  put in after the start and before the probe (one that does not apply:
  blocked, and the probe shows a task reaching the Mac's router and the Mac
  at `192.168.5.2`), `MemAvailable` read inside it, isolation `vm`, the
  envelope's `[vm]` and two sockets read back by the run loop and the lint;
  a Mac below the minimum or a directory under `~` starting no VM; the three
  directories missing (Colima installed by hand): preflight says install
  makes them and starts nothing, install makes them 0700 and starts the VM,
  one whose parent this user cannot write refused; prep-mac.sh's root made
  first by another account as a link (preflight and install refuse it,
  make nothing in it and start no VM) or owned by another uid (played with
  `chown` when the tests run as root); preflight never
  restarting a running VM that differs, install refusing to while a task
  runs in it and counting the action before the stop; `--rosetta`,
  `--no-rosetta` and agent.toml's `[vm] rosetta` carried over a repair; over
  SSH with no GUI login, the Terminal instruction and nothing written; a
  saved profile that mounts `~` or forwards the SSH agent restarted, one of
  another VM type refused; the home directory visible in the VM refused;
  Rosetta's lane after its smoke run, off when it fails; Docker Desktop
  taken as `vm-shared` only with `--dedicated`, no firewall put in it (its
  probe decides), a shared `~/.ssh` refused though `~` is not, and a given
  socket that does not answer told to start Docker Desktop or OrbStack or
  drop `--socket`; install making the set directory it was given, never the
  default (Linux and a Mac); the LaunchAgent written and bootstrapped in
  `gui/<uid>` (its plist checked by `plutil -lint` on the macOS runner), a
  failed bootstrap's Terminal line, and uninstall; `etc/dispatcher.env` in
  the Mac's set directory with the token, the Mac's addresses (a played
  `ifconfig`, no `/proc/net`) and the public one the probe task in the VM
  saw, and the secrets directory the VM mounts.
- `lint/tests.rs` — on a Mac every bind source lies under a directory the VM
  mounts (`vm_mount`); `run/selfupdate_tests.rs` — the watchdog ends a new
  agent still behind its shut gate 30 s past its deadline, and the next start
  rolls it back (launchd restarts only on exit); its first look after a
  sleep (a wall-clock gap between two looks) starts the count again instead
  of ending a loop whose first tick after the wake is a slow one; under
  launchd (`XPC_SERVICE_NAME`) a refused agent.toml is waited on until it
  changes, not said every 10 s.
- `run/exec.rs` — a start that meets `ETXTBSY` ("Text file busy": a binary
  just written — a self-update's new agent, a pinned tool, a test's stub —
  still open in a child that another thread forked and that has not exec'd
  yet) tried again for about 2 s, 2 ms apart and doubling, and any other
  error returned at once; on Linux, a script still open for writing starts
  once it is closed. Its callers: `exec::run` and `Background`,
  `capacity::probe::run`, install's commands and `ifconfig`; the stubs a shell
  starts (the task firewall's iptables and systemctl, the guards' docker,
  curl and jq) are written from a child process (`exec::write_stub`), where
  no fork of the multithreaded test process can hold them.
- `bash tests/prep-mac.sh` (CI) — `factory/host/prep-mac.sh` against stubs
  (uname, id, sw_vers, brew, stat), under dash: Colima and Lima only, the
  three directories 0700, nothing changed on a second run, `--dry-run`, and
  refusals (root, Linux, Intel, macOS 12, no Homebrew, a root under or
  holding `~`, relative, with `:`, another user's, a link); shellcheck.
- `python3 tests/host-bundle.py` — the release pins the Darwin docker CLI and
  compose plugin at the worker image's versions; `worker/test/host-enroll.test.ts`
  — a Mac enrolls at `vm` with its Rosetta lane, which the host's page shows,
  and reports `vm-shared`.

What only the laptop shows — a reboot, a sleep of at least 30 minutes, a
release, a broken agent's release, an x86_64 build through Rosetta, an SSH
session with nobody logged in — is the runbook's *Installing a Mac*
([A new maintainer host](/docs/runbook#a-new-maintainer-host)), followed by hand.

## The agent without a key

`factory/bin/agent.py` honours `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
`GEMINI_BASE_URL` and `XAI_BASE_URL`, so a stub that answers
`POST /v1/messages` (Anthropic) and `POST …/chat/completions` (the
OpenAI-compatible path Gemini and xAI share) with a fixed report exercises
every provider path of `audit-pkgbuild` — parsing, the verdict check, the
Markdown rendering — without a key; `pkg-repo work
--kind audit --once` against a local pool with the same variables runs the
whole executor (fetch the staged evidence, attach `audit.json` / `audit.md`,
complete with the verdict).

## Promotion gate

`pkg-repo gate --from <ring> --to <ring> [--soak-days N] [--dry-run]` reads the
`health` and `abi` events and decides (exit 0 promote, 3 nothing to promote, 1
blocked, reasons printed and recorded as a `gate` event unless `--dry-run`). The
decision is a pure function with unit tests in `crates/pkg-repo/src/gate.rs`:
fresh green evidence promotes; a failed latest health, a failure inside the soak
window, stale or missing evidence, recent ABI blockers, or a security
regression (a package the target serves clean that the source would replace
with a version under an open exact advisory of medium severity or worse, or
in KEV — `security::security_regressions`, from `GET /security?ring=<from>`)
block; a `warn` health row is ignored (the check posts none since #47 — nothing
rendered is an error; the word is kept for a row posted by hand); a target that
already serves the source's head is a skip. `cargo test -p pkg-repo gate` and
`cargo test -p pkg-repo regression` run them.

## Cloudflare (staging)

The staging worker runs at `https://pkgs.omarchy-pool.org` (index API + dashboard at
`https://omarchy-pool.org`) with a real D1 database and an R2 bucket
whose custom domain `https://pool.omarchy-pool.org` serves packages and databases
statically. Deploying is what a release does (`release.yml`, cut by a maintainer with
`gh workflow run release.yml` once the merges it should carry are in; see
[RUNBOOK.md](RUNBOOK.md#releasing-the-pool-itself)); by hand, for a hotfix or a
rollback to an earlier tag:

```bash
cd worker
npx wrangler d1 migrations apply omarchy-repo --remote
npx wrangler deploy --var POOL_VERSION:vX.Y.Z --var POOL_COMMIT:$(git rev-parse HEAD) --var POOL_DEPLOYED_AT:$(date -u +%FT%TZ)
```

To try dashboard or API changes against the real data without deploying,
`npx wrangler dev --remote --port 8799` runs the local code with the remote D1
and R2 bindings (reads only, unless you publish to it).

Writing to the production pool is what jobs do, with the per-job token a
worker gets at claim time; there is no shared secret to export. A maintainer
runs any of them by hand by queueing the job (`pkg-repo job`, or
`POST /api/v1/factory/jobs` with their contributor token):

```bash
export OMARCHY_API=https://pkgs.omarchy-pool.org OMARCHY_TOKEN=omc_…   # a maintainer's token
pkg-repo job sync --param source=core --param arch=x86_64             # import from mirror.omarchy.org → edge
pkg-repo job promote --param from=edge --param to=rc
pkg-repo job render --param ring=stable --param arch=x86_64           # one omarchy-<source>-stable db per source
pkg-repo job gc --param keep=3
```

The same commands run directly (`pkg-repo sync|publish|promote|render|gc`)
against a local pool with a job token (`tests/e2e-worker.sh` mints one).

With `--keyring <file>` the sync rejects any package whose upstream `.sig` does
not verify against that keyring; `tests/fetch-keyrings.sh <dir>` builds
`archlinux.gpg`, `archlinuxarm.gpg` and `omarchy.gpg`. Arch Linux ARM and the OPR
have their own layouts: `--base-url http://os.archlinuxarm.org/aarch64/core --arch aarch64`,
`--base-url https://pkgs.omarchy.org/edge/x86_64 --db-name omarchy --source packages`.

The scheduler queues exactly these as jobs (sync every 3 h, promote daily,
health daily, security every 3 h, gc weekly, verify weekly); project workers
run them. No GitHub workflow writes to the pool, and none is dispatched.

To validate with pacman, use the same container recipe as the local scripts with

```
[omarchy-core-stable]
Server = https://pool.omarchy-pool.org/core/$arch
```

and the POC public key imported into `pacman-key`. This has been exercised end to end:
`-Sy` accepts the signed database, `-Sw` downloads the package and its signature from
the pool through the worker, and `-U` installs it.
