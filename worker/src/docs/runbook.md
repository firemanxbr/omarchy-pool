# Runbook

Operating the staging environment. Nothing here is done by hand on the servers:
every write goes through the Worker with a per-job token a worker got at claim
time; there is no shared secret. Humans operate the pipeline by queueing jobs
(`pkg-repo job`, or the API with a maintainer's token) that project workers run.

| | |
|---|---|
| Dashboard | https://omarchy-pool.org |
| Index API | https://pkgs.omarchy-pool.org/api/v1/stats |
| Pool (static, what pacman reads) | https://pool.omarchy-pool.org/`<source>`/x86_64/ · `/aarch64/` — `core/`, `extra/`, `packages/` (the OPR), `asahi/`, `factory/`, … |
| Signing key | `docs/omarchy-staging.pub.asc` · https://pool.omarchy-pool.org/omarchy-staging.pub.asc · https://pkgs.omarchy-pool.org/api/v1/signing-key (expires 2027-09-12); the private key is the Worker secret `SIGNING_KEY` — nowhere else |
| Jobs (pulled by project workers) | Sync (every 3 h, one task per architecture) · Promote (by evidence: edge→rc right after the sync that changed edge, rc→stable on the second green check in a row, attempted every 3 h; auto-rollback) · Fast lane (a factory build the trial installed, and security fixes, straight to stable) · Health (daily, both arches) · Security (every 3 h, with fast-track) · GC (Sundays) · Metrics snapshot (every 30 min, by the brain itself) · Release (GitHub, when a maintainer decides: `gh workflow run release.yml`) |
| Running version | https://pkgs.omarchy-pool.org/api/v1/version · the chip in the dashboard header |

**The address moved (2026-09-18).** The product has its own domain. Six
names reach the Worker: `omarchy-pool.org` is the dashboard;
`www.omarchy-pool.org`, `omarchy-pool.firemanxbr.org` and
`dashboard-omarchy.firemanxbr.org` redirect a page to it (`/api/v1/*` on them
is answered, not redirected); `pkgs.omarchy-pool.org` is the API and
`pkgs.firemanxbr.org` serves beside it, never redirected — a worker's `curl`
does not follow, and a 3xx would be a silent success. The bucket has two:
`pool.omarchy-pool.org` is the pool, `pool.firemanxbr.org` keeps serving it.
http becomes https at the edge (*Always Use HTTPS*, on both zones), not in
the Worker. A machine set up before the move keeps the old pool host until it
runs `/setup` again; nothing it reads went away. The key's user id,
`staging@firemanxbr.org`, is a name inside the key and stays.

## Trust model

* **Packages are never re-signed.** The sync imports a package only if its
  upstream `.sig` verifies against the upstream project's keyring
  (`archlinux.gpg`, `archlinuxarm.gpg`, `omarchy.gpg` — built by
  `tests/fetch-keyrings.sh`). A machine using the pool verifies packages with the
  keys it already trusts (`archlinux-keyring`, `archlinuxarm-keyring`, Omarchy's).
* **The pool signs with its own key, inside the Worker.** Databases are signed
  as they are stored (`PUT /releases/:id/artifacts/db|files`); a package the
  factory built is signed on request (`POST /pool/:sha256/sign`) against the
  bytes actually stored. Trusting the pool means trusting one key for
  `omarchy-*-<ring>.db` and `factory` packages; nothing else. No worker,
  runner or repository holds the key (SECURITY.md).
* **The pool is append-only.** The worker refuses to overwrite an existing object;
  the only deletions are retention (`gc`), which never touches anything the last
  three releases of any ring reference, nor anything younger than seven days.
* **Releases are append-only.** Rollback creates a new release pointing at an old
  selection; history is never rewritten. Every action posts an event.
* **Nobody holds R2 credentials, and nobody holds a pool credential.** Reads
  are public objects; writes go through the Worker with the per-job token of
  a task a project worker claimed; the R2 bucket has no API tokens.

## Everyday operations

Everything the scheduler does can be queued by hand by a maintainer
(`OMARCHY_API` and `OMARCHY_TOKEN=omc_…` set — the token from your own
page); a project worker runs it with a per-job token, and Status counts it
with the pool's other jobs (*The numbers*, at the foot of the page):

```bash
pkg-repo job sync --param arch=x86_64                                  # every source of the architecture, one release per ring
pkg-repo job sync --param source=packages --param arch=x86_64 --param ring=rc   # one source
pkg-repo job promote --param from=edge --param to=rc --param note="…"
pkg-repo job promote --param from=rc --param to=stable --param note="…"        # evidence-gated: two green checks of rc in a row (--param soak_checks=1 for one)
pkg-repo job promote --param from=rc --param to=stable --param arch=aarch64    # one architecture only: its evidence, its gate, its rows; x86_64 keeps what stable serves
pkg-repo job rollback --param ring=stable --param to=<release id>              # then renders both architectures
pkg-repo job rollback --param ring=stable --param to=<release id> --param arch=x86_64   # that architecture only
pkg-repo job render --param ring=stable --param arch=x86_64                     # any ring, the lab included
pkg-repo job health --param ring=stable --param arch=aarch64
pkg-repo job security
pkg-repo job enqueue                                                   # the PKGBUILDs on main → the queue, now
pkg-repo job verify                                                    # every served OPR object verified and repaired (--param ring= --param arch= --param repair=no to only report)
pkg-repo job trial --param task=<staged build>                         # the project's build into the lab and a real pacman on it, again
pkg-repo job gc --param keep=3
pkg-repo job relayout                                                  # one-time: every object into its source's directory (below)
```

An emergency promotion forced past the gate is not on this list: it ships
what no check passed, so it takes your passkey, in the browser (#284). On
Status, *Force into rc* on edge's card or *Force into stable* on rc's asks
why and which architectures — both, or one alone — then your passkey, and
queues the same job with `force=yes` (and `arch` for one). One architecture
is its own act: the passkey answers for exactly that one. The target's
health check still rolls it back. `pkg-repo job promote --param force=yes`
and any other token are refused (`session_only`).

Promotions are gated by evidence (see *Promotion by evidence* in
[ARCHITECTURE.md](ARCHITECTURE.md)): the job first records fresh `health` and
`abi` events for the source ring on both architectures, then the gate
decides — promote, nothing to promote, or blocked with the reasons in a `gate`
event on the dashboard. After a promotion the target ring is health-checked on
both architectures and rolled back automatically if that fails (`rollback` event
naming the failed and the restored release). There is no human in the daily
path: the evidence is the reviewer, and a maintainer who disagrees rolls back.

```bash
# the same decisions by hand
pkg-repo fast-track --ring stable --from edge --dry-run        # security fixes edge has and stable lacks (exit 3: none)
pkg-repo gate --from rc --to stable --soak-checks 2 --dry-run   # exit 0 promote, 3 nothing new, 1 blocked
pkg-repo head --ring stable                                    # current release id (rollback target)
pkg-repo diff --ring stable                                    # what the head changed against its parent (+ − ↑)
pkg-repo diff --ring rc --from 41 --to 45 --arch aarch64 --json  # any two releases inside retention
pkg-repo releases --all --json                                 # every ring's history, for scripts and agents
tests/abi-gate.sh rc x86_64                                    # ABI check of rc's upgrades, exit 2 on blockers
```

The reads run directly from anywhere (`pkg-repo releases --ring stable`,
`pkg-repo diff`, `pkg-repo head`, `pkg-repo gc --keep 3` without `--delete`
is a report); the writes above are jobs. A manual rollback is the
`rollback` job above, from the CLI or `POST /api/v1/factory/jobs` — or, for a
maintainer signed in, the *Roll back* button on Status's Releases: on a ring's
card (to the release before its head) and in its ring history (to any release
of the last 20), each asking why before it queues the same job. A diff opens at
`/diff?ring=&from=&to=` — added, removed and upgraded packages, per
architecture (`GET /api/v1/releases/:ring/diff`); `/diff` alone is stable's
head against its parent. Both releases must still be inside retention: GC
prunes the membership of older ones (410).

## Releasing the pool itself

`main` is protected: no direct pushes, every change is a pull request that CI and
E2E must pass, squash-merged with the pull request title as the commit message.
A release is `main` at the moment a maintainer dispatches one
(`gh workflow run release.yml`; a merge alone releases nothing):

1. `release.yml` runs CI and E2E again on that commit.
2. The next version is the last tag plus one **patch** (`v0.0.1 → v0.0.2`). Label
   the pull request `release:minor` for a significant change (`v0.1.0`) or
   `release:major` for an incompatible one; `workflow_dispatch` with `bump=` does
   the same by hand. Crate and `package.json` versions stay at `0.0.0` — the tag is
   the source of truth and is compiled into the binaries as `POOL_VERSION`.
3. Binaries (`pkg-repo`, `omarchy-cli`, `pkg-extract`) are built on x86_64 and
   aarch64 runners and attached to a GitHub release, created as a **draft**, with
   notes generated from the merged pull requests; the `omarchy-agent` binaries are
   built for x86_64 and aarch64 Linux (musl) and Apple silicon macOS
   (`factory/bin/build-agent`, reproducible). The worker image is built from them on each
   architecture and pushed as `:<arch>-vX.Y.Z` only. Every role is then
   started from it on the runner (`tests/image-smoke.sh`: the project worker
   through its entrypoint, `pkg-repo work --self-test`, then to its first
   claim of a stub pool; the broker answering on `:8790`; the builder's and
   the updater's `--self-test`; the updater's `follows` label). Only once
   both architectures' images have started does the version's own
   `:vX.Y.Z` move (the index the host bundle signs). An image whose roles do
   not start, on either architecture, stops the release before any tag
   moves.
4. The host bundle (#311, *The host bundle* below) is written, signed and
   verified with the new agent and every agent released in the last 30 days,
   then added to the draft with the agent binaries and `install.sh`; only then
   is the release published, which makes it immutable
   (`factory/bin/publish-release` checks every asset is there, with the bytes
   the run made, first). A release that stops before then stays a draft, the
   pool stays on the previous release, and so does every host.
5. **This is when hosts move** (#359): once the release is published, one
   job (`worker-image-tags`) moves `:x86_64` and `:aarch64` to the version's
   images, then `:latest`, each signed; it runs in the `release`
   environment, so it waits for a maintainer's approval like the jobs that
   signed before it. Every set's updater pulls those tags at its next
   round, whatever release the pool runs, so from here on a host may run
   the new images before the pool is deployed (step 6); never before the
   release is published. A run that stops here leaves the release published
   and the pool on the previous release: **Re-run failed jobs**.
6. The worker is migrated (`wrangler d1 migrations apply`) and deployed with
   `POOL_VERSION`, `POOL_COMMIT` and `POOL_DEPLOYED_AT`; the run verifies
   `/api/v1/version` reports the new tag and records a `deploy` event through
   `wrangler d1 execute` (the release holds no credential of the pool's API).
7. Every set follows: its updater sees the new release within two minutes
   (the Studio's too, since its one-time step, *The Studio host*).

A run that stopped resumes with **Re-run failed jobs** on that run. Once its
release is published, that is the only way: a published release is immutable,
so a version is never cut twice, and a new dispatch on a commit whose release
is published stops at the publish job's first step. So does a dispatch where a
`v*` tag of that version already points at another commit (#351). A draft
release left by a run that stopped before publishing has no tag yet and needs
no cleanup: the next run deletes it and makes it again with its own assets.
The agent carries its own version (`crates/omarchy-agent/Cargo.toml`, design
v2 D17): CI fails a pull request that changes what goes into the agent's
binary since the previous release without raising it
(`factory/bin/agent-version-check`), and a release with no agent change ships
the very binaries the previous one did.

The deploy step needs the `CLOUDFLARE_API_TOKEN` repository secret (Account →
Workers Scripts: Edit, D1: Edit, Workers R2 Storage: Edit (the rollback
statements, below), Account Settings: Read; Zone → Workers Routes:
Edit, Zone: Read, on **both** zones, `omarchy-pool.org` and `firemanxbr.org` —
the routes span them). It is an account-owned token: Cloudflare dashboard →
*Manage account → Account API tokens → omarchy-pool github-actions deploy →
Edit*, not *My Profile*. Without it the release is still published and the run
ends with a warning instead of a deployment.

Rolling back is `gh workflow run rollback.yml -f to=vX.Y.Z`. It re-points
`:latest`, `:x86_64` and `:aarch64` at that release's images and deploys that
release's Worker (both go back: a pool left at the newer release would refuse
the older images as outdated), and records a `deploy` event, "rolled back to
vX.Y.Z (from …)". It goes back only to a release whose images passed both
smoke starts (its `:vX.Y.Z` exists: a release that stopped at its smoke start
still has a tag, and is refused), and it installs and builds that release's
Worker before any tag moves; a deploy that fails puts the tags back where
they were, and running the rollback again is safe. It also signs a rollback
statement (#314) before anything moves and stores it in R2 once that Worker
is deployed (`rollback/<to>.json` and its `.sigstore.json` in
`omarchy-packages`, relayed at `GET /api/v1/factory/rollback/<to>`): a host
under the host agent goes below its floor only on one, within 14 days of the
target's release (security-model, *Rollback statements*). A statement that
did not reach R2 fails the run after the rest is done; running it again
stores a freshly signed one. The updaters follow the
pool's release down as they follow it up, within two minutes. Back past
#277's last part, the updater that comes back is the older one: it follows
at its own fifteen-minute round and takes no Update, until a release brings
one that follows again. That older Worker lists a worker's whole row, so the
rollback clears every column the newer one keeps to itself — a worker's
site, its process, the rules' state, its rollout report — before its deploy,
after it and once more once it runs; a task's stop fence goes too. A
worker's drain stays, but the older Worker does not honour it: drained
workers take work until the roll-forward, which declares everything else
again at each worker's first claim (security model, *A Worker rolled back
past #277*; #295). Migrations are forward-only; keep them additive. The
fallback, by hand, for the Worker alone: re-run the Deploy job of that
release's run, or `git checkout vX.Y.Z && cd worker && npx wrangler deploy
--var POOL_VERSION:vX.Y.Z`.

## The GitHub settings the signature relies on

Hosts will trust one thing: a keyless Sigstore signature made by
`release.yml` (or `rollback.yml`) on `main` of this repository, checked
against that exact identity
(`https://github.com/firemanxbr/omarchy-pool/.github/workflows/release.yml@refs/heads/main`,
issuer `https://token.actions.githubusercontent.com`). That signature is only
as strong as the settings around it (#308, design v2 §20). Part of them is in
the repository and CI holds it (`tests/trust-pins.sh`): one exact cosign
(v2.6.5, through `sigstore/cosign-installer` pinned by commit) in both
workflows, the Fulcio and Rekor named on every `cosign sign`, the
release jobs that sign (`worker-image-manifest`, `host-bundle` and
`worker-image-tags`) in the `release` environment and the rollback in
`pool`, `release.yml`'s `version` job (the gate every other job waits behind) in `release` too, so nothing is built,
tagged, published or pushed before the environment admits the run, and no
write permission by default, the base images by digest and the
docker CLI by SHA-256, and CODEOWNERS giving every maintainer
`.github/workflows/`, `crates/omarchy-agent/`, `crates/pkg-repo/src/dispatch*`
and `factory/sets/`. The rest lives on GitHub, and only the repository's
admin can set it:

| Setting | What it gives | Checked by |
|---|---|---|
| `release` and `pool` environments: `main` only, a required reviewer (either maintainer, self-approval allowed until both approve dispatches in practice; then `prevent_self_review`, D18), no admin bypass | a dispatch from any other branch is refused before its job starts; one from `main` waits for a maintainer, so a holder of `actions: write` cannot sign or send every host back alone | `gh api …/environments`, `…/deployment-branch-policies` |
| `CLOUDFLARE_API_TOKEN` an environment secret of `pool`, not a repository secret | only a run the `pool` environment admitted can deploy | `gh secret list` (repository and `--env pool`) |
| A tag ruleset on `v*`: update and deletion refused to everyone (`.github/rulesets/tags-locked.json`, no bypass; no workflow moves or deletes a git tag). Creation is not restricted: GitHub accepts GitHub Actions as a ruleset bypass actor only in an organization, and a creation rule without that bypass would refuse `release.yml`'s own tag (#351) | a `v*` tag is never moved or deleted, not even by a workflow or the admin. Creating one (and a release with it) stays open to every collaborator with write access (see *Check*), so `release.yml` refuses a release it did not make and builds the images from this run's binaries only; what hosts verify (`omarchy-agent verify`, `cosign verify`) is signed by `release.yml@refs/heads/main`, whatever tags exist. The CLI tarball on a GitHub release is not verified on download | `gh api …/rulesets` |
| Immutable releases | a published release's assets and tag cannot change | `gh api …/immutable-releases` |
| The main ruleset (`.github/rulesets/main.json`, already applied) requires a pull request review and a code owner's | a change to what signs, or to what a host runs, is a decision another maintainer approves — except that the admin keeps a pull-request bypass (repository role 5), accepted under D18 like self-approval, and removed when D18 moves to two-person approval | `gh api …/rulesets/<id>` |
| No stored or automated token with `actions`, `contents: write` or `workflows` on this repository outside GitHub Actions — not the Worker's, a host's, a worker's, a deploy key or CI tooling's; a maintainer dispatches and approves as a person, in their own interactive session (`gh auth login`) or the web UI | no process can dispatch `release.yml` or `rollback.yml`, or push a workflow, on its own; what a maintainer dispatches still waits for the environment's reviewer | the daily token probe on Status (*The pool's own scheduler*; it detects `actions: write` only, `contents` and `workflows` are the manual review's); `gh api …/keys`; each maintainer's token pages |

Until the admin applies them, the repository alone meets none of these,
whatever it holds. Applied today: the environments, immutable releases and
`tags-locked.json`; `CLOUDFLARE_API_TOKEN` is still a repository secret
(step 2 pending), and the token rule stays a manual review. Only `release.yml`
should create a `v*` tag: a hand-made one can never be removed, and
`release.yml` takes the highest as the base of the next version. #308's "a `v*` tag
is not created by hand" is replaced by #351 (moves and deletions locked, the
signature what hosts trust). On a new repository, apply the environments
(step 1) before the first release dispatch: a workflow that names an
environment that does not exist makes GitHub create it, with no reviewer and
no branch policy.

**Apply** (the repository's admin, once; user ids: firemanxbr 2116404,
maralcbr 116872):

```bash
R=repos/firemanxbr/omarchy-pool
# 1. The signing environments: main only, a required reviewer, no admin bypass.
for env in release pool; do
  gh api -X PUT "$R/environments/$env" --input - <<'JSON'
{
  "reviewers": [{ "type": "User", "id": 2116404 }, { "type": "User", "id": 116872 }],
  "prevent_self_review": false,
  "can_admins_bypass": false,
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON
  gh api -X POST "$R/environments/$env/deployment-branch-policies" -f name=main -f type=branch
done
# 2. The deploy token only where the pool environment admits the run.
gh secret set CLOUDFLARE_API_TOKEN --env pool -R firemanxbr/omarchy-pool < cloudflare-token
gh secret delete CLOUDFLARE_API_TOKEN -R firemanxbr/omarchy-pool
# 3. The v* tag ruleset: update and deletion, no bypass at all. No creation
#    rule: on a user-owned repository GitHub refuses GitHub Actions as a bypass
#    actor (HTTP 422), so one would refuse release.yml's tag too (#351).
gh api -X POST "$R/rulesets" --input .github/rulesets/tags-locked.json
# 4. Immutable releases.
gh api -X PUT "$R/immutable-releases"
# 5. Tokens: delete or narrow any personal access token (fine-grained or
#    classic) or deploy key that can write to this repository — see Check.
```

**Check** (the commands marked *admin* need the repository's admin; the rest
work with read access):

```bash
R=repos/firemanxbr/omarchy-pool
gh api "$R/environments" --jq '.environments[] | select(.name == "release" or .name == "pool")
  | { name, can_admins_bypass, branch_policy: .deployment_branch_policy,
      reviewers: [.protection_rules[] | select(.type == "required_reviewers") | .reviewers[].reviewer.login] }'
# release and pool: can_admins_bypass false, custom_branch_policies true, reviewers [firemanxbr, maralcbr]
for env in release pool; do gh api "$R/environments/$env/deployment-branch-policies" --jq '[.branch_policies[] | .name]'; done
# ["main"] twice
gh secret list -R firemanxbr/omarchy-pool; gh secret list -R firemanxbr/omarchy-pool --env pool   # admin
# CLOUDFLARE_API_TOKEN under pool, not in the repository's list
gh api "$R/rulesets" --jq '.[] | { id, name, target, enforcement }'
for id in $(gh api "$R/rulesets" --jq '.[] | select(.target == "tag") | .id'); do
  gh api "$R/rulesets/$id" --jq '{ name, include: .conditions.ref_name.include, rules: [.rules[].type], bypass: .bypass_actors }'
done
# one tag ruleset: include ["refs/tags/v*"], rules [update, deletion], bypass []
gh api "$R/collaborators" --jq '[.[] | select(.permissions.push) | .login]'
# who can create a v* tag: compare with GOVERNANCE.md's maintainers
gh api "$R/rulesets/$(gh api "$R/rulesets" --jq '.[] | select(.target == "branch") | .id')" \
  --jq '.rules[] | select(.type == "pull_request") | .parameters | { required_approving_review_count, require_code_owner_review }'
# 1 and true
gh api "$R/immutable-releases"   # admin
# {"enabled": true, ...}
gh api "$R/keys" --jq '[.[] | select(.read_only == false) | .title]'   # admin
# [] — no deploy key that writes
```

Personal access tokens are not listed by the API on a user's repository:
each maintainer reviews their own (*Settings → Developer settings → Personal
access tokens*, fine-grained and classic) and stores none with `actions`,
`contents: write` or `workflows` on this repository (a classic `repo` or
`workflow` scope counts) in a script, a CI system, a host or any other
automation. Their own interactive session — the `gh auth login` token, the
web UI — is how they dispatch, apply and approve (the commands on this page),
and it is not left anywhere a process could use it unattended. The Worker's
own tokens are probed every day; a host's agent sidecar token is probed by
the host agent's preflight (#317).

**A dry run of the refusal**, once the checks above pass: dispatch the
rollback from a throwaway branch, to the release that runs now, so even a
misconfigured environment would change nothing:

```bash
git push origin HEAD:refs/heads/env-refusal-check
gh workflow run rollback.yml --ref env-refusal-check -R firemanxbr/omarchy-pool \
  -f to="$(curl -s https://pkgs.omarchy-pool.org/api/v1/version | jq -r .version)"
gh run list -R firemanxbr/omarchy-pool --workflow rollback.yml --limit 1   # failure: the branch may not deploy to pool
git push origin --delete env-refusal-check
```

The next release from `main` shows *Next version* *Waiting for review*
(`release`) once CI and E2E pass, before anything is built, then its signing
job (`release`), then the deploy (`pool`); approve each on the run's page.
A dispatch of `release.yml` from another branch stops at *Next version*:
nothing is built, tagged, published or pushed.

What is not covered yet: the gate lives in `release.yml` itself, and a
dispatch runs the dispatched branch's copy of the file, so a writer could
dispatch a copy without it from their own branch and publish a release and
its `v*` tag from that branch (GitHub Actions may create `v*` tags; the
ruleset that would refuse their creation cannot be applied on a repository a
user owns). Nothing it made is signed or attested with the `main` identity,
so an installed agent would not take its host bundle: since #311 an agent
takes a release only through a host bundle signed by `release.yml` on main.
What stays open: such a release can be marked *latest*, and then
`releases/latest/download/install.sh` serves that branch's `install.sh` and
agent to anyone who runs the plain `curl … | sh`. `install.sh` checks the
agent against the SHA-256 written inside itself, which proves nothing about
`install.sh`. The verifying install (*The host bundle*) closes that for
whoever uses it: it refuses an `install.sh` whose provenance is not
`release.yml` on `refs/heads/main`.

## Security data

The `security` job (every 3 h, pulled by a project worker; `pkg-repo job
security` queues one by hand) fetches the Arch and Debian trackers, KEV and EPSS,
matches them (`pkg-repo security`) and then fast-tracks fixes into `rc` and
`stable` (`pkg-repo fast-track`, `--min-severity medium`, exploited-in-the-wild
always), renders, checks health on both architectures and rolls back a ring
that fails. Both commands are safe to run by hand with `--dry-run`. A wrong match is a
tracker's mistake or a name collision: open an issue with the package and the
advisory id shown on the package page; the `same_project` heuristic in
`crates/pkg-repo/src/security.rs` is where collisions are rejected.

## Response headers

Every answer the Worker gives — a page, the API, a redirect, a script, an
icon, a 404 — leaves through one function (`secured()` in
`worker/src/headers.ts`, #300), which adds what the answer does not already
set:

| header | value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (no preload) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Content-Security-Policy` | `frame-ancestors 'none'` (enforced) |
| `Content-Security-Policy-Report-Only` | the policy below |
| `Permissions-Policy` | camera, microphone, geolocation, payment and usb off; `publickey-credentials-get=(self)`, `publickey-credentials-create=(self)` for passkeys |

The agent-grant and confirm pages (`personal()` in `routes/agents.ts`) keep
their own, stricter `Referrer-Policy: same-origin` and `no-store`. API
answers also carry `access-control-allow-origin: *` and `x-robots-tag`. The
pool's objects on `pool.omarchy-pool.org` are R2's, not the Worker's: none of
these is sent with them, though a browser that has seen `omarchy-pool.org`
keeps to https there too (`includeSubDomains`).

`includeSubDomains` holds because every name under both zones is served over
https only: the six Worker names (`wrangler.toml` routes), the bucket's two,
*Always Use HTTPS* on both zones, and no `http://` address to any of them in
the code, the docs or the setup script. A new name under `omarchy-pool.org`
must be https from its first day. On the `firemanxbr.org` names the header
covers only their own subdomains, never `firemanxbr.org` itself.

**The CSP, report-only until 2026-10-31.** The policy is `default-src 'self';
script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'
https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;
img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'`
— what the pages already meet (on the seeded preview of #300, every main
page as a visitor, a contributor and a maintainer: no violation). There is
no report endpoint (Cloudflare's `cf-nel` group is Cloudflare's, not ours):
a browser shows a violation in DevTools (Issues), and a page's script sees
it as a `securitypolicyviolation` event. The plan:

1. Now: Report-Only. The production check after each release loads the
   main pages with a `securitypolicyviolation` listener (or DevTools open)
   and notes any violation.
2. 2026-10-31: with no violation seen, the same policy moves to
   `Content-Security-Policy` — one header name in `headers.ts`, its test
   with it. A violation found before then is fixed in the page, or the policy
   names the source, first.
3. After that, a separate issue: nonces on the inline scripts, so
   `script-src` drops `'unsafe-inline'`. If `ANALYTICS` is ever set, its
   script's origin joins `script-src` and `connect-src` in the same change.

## The pool's own scheduler

GitHub's cron is best-effort (on 2026-09-12 it delayed the hourly sync by an
hour and never started the half-hourly metrics), so the pool has its own
clock: a Cloudflare cron trigger on the Worker (`src/scheduler.ts`, every
ten minutes). Intervals for sync (3 h) and security (3 h); promote by evidence (edge→rc queued by the
sync, rc→stable every 3 h), daily slots for health (08:30) and the Sunday GC — each queued as a
pulled job (below) when due and never doubled while one is queued or
running. The metrics snapshot (30 min), the governance sync (10 min), the
update check (05:45) and the cost estimate (<!-- estimate-cadence -->) it does itself. Nothing starts on GitHub by
dispatch, and the code that could is gone (#308): since 2026-09-17 the pool's operation — requests,
builds, bumps, promotion — does not go through GitHub Actions, issues or
pull requests, so a GitHub outage stops the code from changing and nothing
else (sign-in, the governance file and the worker image stay on GitHub, by
choice). The worker secret `GITHUB_TOKEN` (fine-grained, this repository,
read-only) only raises the rate limit of the reads the pool still makes —
the governance file, upstream releases for the bumps, provenance:

```bash
cd worker && npx wrangler secret put GITHUB_TOKEN < ~/.cache/omarchy-cli-poc/github-token
```

Without the secret everything still runs, at GitHub's anonymous rate limit.
The one thing the brain writes on GitHub — the daily comment on the *Cost
report* issue (*Costs*, below) — uses a second, separate secret,
`GITHUB_REPORT_TOKEN`: a fine-grained token on this repository with
*Issues: Read and write* and nothing else, so no token in the Worker can
start a workflow (`release.yml` is dispatch-only and deploys production).
`GITHUB_TOKEN` is never widened for it.

```bash
cd worker && npx wrangler secret put GITHUB_REPORT_TOKEN     # paste the token
```

Once a day the cron checks that neither token can start a workflow
(`src/tokenprobe.ts`, #308): a dispatch of `rollback.yml` to a ref that
cannot exist, per token. GitHub answers 403 to a token without
`actions: write` (a `token` line, ok) and 422 to one with it; no run starts
either way. A 422 is an error: the Status hero says *A pool token can start
workflows* until a later probe of that token gets 403, or the token is
removed (`wrangler secret delete`; the next day's tick writes an ok line
saying so). Replace the token with one that has only its listed permission
(`wrangler secret put` as above); the next day's probe clears it. A 401
(expired or revoked) or any other answer is a `warn` line, and it does not
clear an earlier error: the line stays an error that says the answer could
not tell. The probe detects `actions: write` only; `contents: write` and
`workflows` are the maintainers' manual review of the tokens. The rule is
the security model's: no stored or automated token with `actions`,
`contents: write` or `workflows` on this repository exists outside GitHub
Actions (*The GitHub settings the signature relies on*, below).

## Pulled jobs (the pool without GitHub)

The pool's own work — sync, promote, rollback, render, health, security,
enqueue, gc — runs as tasks in the factory's queue when `JOB_KINDS` (a
Worker var, comma-separated kinds) lists the kind: the cron creates them
on schedule, a maintainer queues one by hand, and a **project worker**
pulls and runs them:

```bash
# on any machine with podman/docker, python3, curl, git (the health and ABI
# scripts) — a droplet, a laptop, a Hetzner box
pkg-repo work --worker-token omw_… --labels '{"where":"droplet-1"}'
```

The worker is registered like any other (`POST /factory/workers`) and a
maintainer promotes it: `POST /factory/workers/<id>/trust {"trust":"project"}`
with a maintainer's contributor token; maintainers are named by
`factory/MAINTAINERS.toml` (docs/GOVERNANCE.md), nowhere else. Every task
runs with a per-job token the pool issues at claim time (SECURITY.md);
the worker's own token only claims. No pipeline step runs on GitHub any
more: the workflows that did are gone, and a run by hand is a job. GitHub
Actions runs CI and the release only — there is no hosted worker: when
pool jobs wait and no project worker is alive, they wait, the scheduler
log and the Workers page say so, and *The Studio host* (below) is where
to look. Worker secret: `JOB_TOKEN_SECRET` (any random string) signs the
job tokens.

## A new maintainer host

A new host for the host agent (design v2, epic #307) runs one set,
`factory/sets/host`: one service, the dispatcher, which starts one isolated,
credential-less container per task, as many as the host's capacity allows.
What it needs from root, once, is
[`factory/host/prep-root.sh`](../factory/host/prep-root.sh); the agent
never runs it and never asks for root, and reports what is still missing
("needs a person"). On Arch Linux (or Arch Linux ARM) or Ubuntu LTS, from a
checkout, for the Unix user the agent will run as:

```bash
sudo factory/host/prep-root.sh --user omarchy --work-root /srv/omarchy-pool/host --dry-run   # what it would change
sudo factory/host/prep-root.sh --user omarchy --work-root /srv/omarchy-pool/host             # rootful docker on a dedicated machine
sudo factory/host/prep-root.sh --user omarchy --work-root /srv/omarchy-pool/host --runtime rootless   # podman, a shared machine
```

It installs the runtime, qemu's binfmt handlers (with the `F` flag, for the
emulated lane), btrfs-progs and jq; puts the user in the docker group
(rootful); sets docker's default address pools and, on a daemon with no
container or image yet, `userns-remap`; makes the work root (a btrfs
subvolume where it can); turns on linger; delegates cgroup v2 controllers to
the user's systemd (rootless); and installs `DOCKER-USER` drop rules from
the task subnets (`--task-subnets`, default `10.231.0.0/16`) to RFC 1918,
CGNAT, link-local and the host (IPv4; task networks stay IPv4 only), kept across reboots by
`omarchy-task-firewall.service` (rootful). A second run changes nothing;
exit 1 lists what needs a person. The task subnets and the work root must be
the ones the agent's install is given. The Studio does not run it: it keeps
its legacy set (below) until the switch of design v2 §21.

### The host bundle

Every release carries what a maintainer host takes from it (#311, design v2
§4.4), all of it on the release before it is published:

| Asset | What it is |
|---|---|
| `omarchy-host-vX.Y.Z.tar.gz` | `manifest.json` and every set under `sets/<name>/`: `factory/sets/host` with the worker image and the task build images rendered to digests |
| `omarchy-host-vX.Y.Z.tar.gz.sigstore.json` | its keyless signature (a Sigstore bundle) by `release.yml` on main |
| `omarchy-agent-x86_64-linux-musl`, `omarchy-agent-aarch64-linux-musl`, `omarchy-agent-aarch64-darwin` | the agent, the same bytes as long as the agent does not change; their provenance is attested |
| `install.sh` | the one command, with that release's agent version and the three binaries' SHA-256 embedded; its provenance is attested |
| `build-images.json` | the task build images by digest (#312), attached when the draft is created: the same two the bundle's `inner.images.build` names and its host set's dispatcher is given |

The manifest's outer layer names the release, the agent and each binary's
SHA-256; its `inner` carries the floor (`min_release`, `revoked`), the pool
origins, the images by digest, the container tools by URL and SHA-256 and
the **capacity constants** that bound how many tasks a host may run. They
come from [`factory/bundle/manifest.toml`](../factory/bundle/manifest.toml):
changing one changes every host at the next release, without an agent
release, and needs another maintainer's review (CODEOWNERS).

`install.sh` is always at its canonical URL, the latest release's:

```bash
curl -fsSL https://github.com/firemanxbr/omarchy-pool/releases/latest/download/install.sh | sh
# options for `omarchy-agent install` after `sh -s --`; an enrollment token only in the environment:
curl -fsSL https://github.com/firemanxbr/omarchy-pool/releases/latest/download/install.sh | OMARCHY_ENROLL=... sh -s -- --help
```

It refuses root, checks the binary against the embedded SHA-256, installs
it under `~/.local/share/omarchy-agent/versions/<agent version>/` and runs
`omarchy-agent install --release <that release>` (*Installing a host*,
below).

`install.sh` itself is not signed, and *latest* is whatever release was
published last, so the plain command trusts that release (*What is not
covered yet*, above). The verifying install checks the script's provenance
first, which a copy of `release.yml` dispatched from another branch cannot
give (its attestation names `@refs/heads/<branch>`):

```bash
curl -fsSLO https://github.com/firemanxbr/omarchy-pool/releases/latest/download/install.sh
gh attestation verify install.sh -R firemanxbr/omarchy-pool \
  --signer-workflow firemanxbr/omarchy-pool/.github/workflows/release.yml --source-ref refs/heads/main \
  && sh install.sh
```

Anyone can check a bundle by hand with cosign:

```bash
v=vX.Y.Z
gh release download "$v" -R firemanxbr/omarchy-pool -p "omarchy-host-$v.tar.gz*"
cosign verify-blob "omarchy-host-$v.tar.gz" --bundle "omarchy-host-$v.tar.gz.sigstore.json" \
  --certificate-identity https://github.com/firemanxbr/omarchy-pool/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-trigger workflow_dispatch \
  --certificate-github-workflow-repository firemanxbr/omarchy-pool
```

The agent does the same check offline, with the identity pinned in its code
(`omarchy-agent verify --bundle omarchy-host-$v.tar.gz --sig omarchy-host-$v.tar.gz.sigstore.json`),
and the release runs it with the new agent and every agent of the last 30
days before it publishes anything. An earlier agent runs only once
`gh attestation verify` proved it came from `release.yml` on `refs/heads/main`
(a release that ships any other one stops, for a person to look), and in a
job of its own that holds no signing identity and no token that writes.

### Installing a host

`omarchy-agent install` (#317; design v2 §13) is what install.sh runs, on
Linux (macOS is P3). Run as the user the agent will run as — a dedicated
machine or VM, or a dedicated `omarchy` user on a shared machine, never your
daily login — after `factory/host/prep-root.sh` did the root-only steps:

```bash
curl -fsSL https://github.com/firemanxbr/omarchy-pool/releases/latest/download/install.sh \
  | OMARCHY_ENROLL=ome_... sh -s -- --dedicated --work-root /srv/omarchy-pool/host
```

| Option | What it does |
|---|---|
| `--dedicated` | this machine or VM is used only as a pool host (design v2 §19.1); without it the host must be a dedicated user at the `subuid` level holding no credentials |
| `--work-root <dir>`, `--secrets-dir <dir>` | where tasks work (default `<data>/work`) and where `agent.env` goes (default `<data>/secrets`); the secrets directory must be outside the work root and the set directory |
| `--socket <path>` | the engine's socket; otherwise the first that answers of rootless podman's API socket, rootless docker, `/var/run/docker.sock` |
| `--task-subnets <cidr>[,<cidr>]` | the task networks' range (default `10.231.0.0/16`, as prep-root.sh's) |
| `--legacy <compose project>` | a set already running beside the new bundle (the Studio): recorded in `legacy.json`, nothing in it changed; its rootful daemon without userns-remap is the recorded exception until P6, meant for the Studio's set only; a re-run without the flag uses the recorded project |
| `--agent-env-from <file>` | copies the agent keys from an existing file (the Studio's `etc/agent.env`) after showing which keys it holds; without it they are asked for on `/dev/tty`, not shown |
| `--max-units`, `--max-cpus`, `--max-mem-gb` | the owner's caps, lower than detected only |
| `--yes` | confirms the envelope (and the keys' copy) without a terminal |
| `--pool <origin>`, `--data-dir <dir>`, `--wait-minutes <n>` | a pool the release signs; the data directory (it must be the one install.sh put the agent in, `omarchy-agent` under `XDG_DATA_HOME` or `~/.local/share`: the unit starts `<data>/current/omarchy-agent`); how long to wait for your Confirm |

It verifies the release bundle and that it is the agent that release ships,
fetches the release's pinned docker CLI and compose plugin into `tools/`,
then runs **preflight** — `omarchy-agent preflight` with the same options
runs it alone — and stops with one screen listing everything to fix when
anything blocks, having written nothing else: the engine and the hosting
requirement (`root` or `user` isolation without `--dedicated` is a daily
login and refused; a rootful daemon on a new host needs userns-remap), the
release's minimum and whether `--cpus`, `--memory` and `--pids-limit` hold,
credentials within the user's reach (SSH keys, a `gh` login, stored git
credentials, browser profiles: a warning on a dedicated host, a blocker
otherwise), the user manager (`XDG_RUNTIME_DIR` and its D-Bus), the task
subnets against the host's routes and other projects' networks, the owner
files' owners and modes, the legacy project, a `GITHUB_TOKEN` to copy or in
the `agent.env` a re-run keeps (public read only: a classic token with no scope; any scope, or a token
GitHub names no scopes for, is refused), and the **egress probe**: a task
on its own network in the task subnets must fail to reach `169.254.169.254`,
the default gateway and the host's LAN address and must reach GitHub, which
on a rootful host is what prep-root.sh's `DOCKER-USER` rules give. Until the
egress sidecar lands, a rootless host is expected to fail it: rootless
podman's network carries the host's own address into the task's namespace,
and the `DOCKER-USER` rules are rootful only. The probe's answers decide;
there is no separate check for a rootless engine. Leftovers of an interrupted
probe (labelled `org.omarchy-pool.probe=egress`) are removed before it
runs. A work root that does not exist under a directory the user cannot
write is a blocker naming prep-root.sh. A socket
that refuses the user (`EACCES`) is "needs a person: log out and back in,
or reboot", not a crash loop.

Then it prints the envelope (`agent.toml`) to confirm, writes
`run/capacity.json`, enrolls ([Maintainer hosts](/docs/worker-host#maintainer-hosts):
the fingerprint, your Confirm on the site, the host worker token) and only then writes `agent.toml` with
the `host_id` and `worker_id` the enrollment gave — before your Confirm
there is no run loop, no dispatcher and nothing that claims. It writes the
agent keys to `OMARCHY_SECRETS_DIR/agent.env` (0600), `legacy.json` with
`--legacy`, and the unit `~/.config/systemd/user/omarchy-agent.service`
(`Type=notify`, `Restart=always`, `WatchdogSec=300`,
`RestartPreventExitStatus=78`, `UMask=0077`, `NoNewPrivileges=yes`), enables
linger (`loginctl enable-linger` where polkit allows it, otherwise it prints
`sudo loginctl enable-linger <user>` and exits 1 as "needs a person") and
starts the service, whose first round renders, pulls and starts the bundle.
Every owner file is written through `openat` with `O_NOFOLLOW` in a
directory the agent owns; a symbolic link, another user's file or one others
may write is refused. Running it again repairs the install and keeps the
identity, the agent keys and your edits to `agent.toml`.

`omarchy-agent uninstall` stops the agent, removes the unit, the bundle's
containers and networks, task containers and sidecars (labelled
`org.omarchy-pool.agent.host=<host>`) and the bundle's files; it never
touches the legacy project, and keeps the identity, `agent.toml`, the
secrets directory and the trust floor in `state.json` (it clears the applied
release, so installing again starts a round). Run it in a login session of the agent's user: without
a reachable `systemctl --user` (`sudo -iu`, no `XDG_RUNTIME_DIR`) it stops
as "needs a person" before removing anything, since the agent would keep
running under linger.

`tests/agent-install.sh` runs the egress probe and the legacy project against
a real engine in CI. What needs a VM, by hand on Ubuntu LTS, Fedora and
Arch (Asahi on the Studio's hardware) before P1 is called done: install
from nothing with the pasted command and confirm on the site, then
`sudo reboot` and check `systemctl --user status omarchy-agent` and
`omarchy-agent status` come back without a login; and on a host with a
stand-in legacy compose project, `--legacy` leaves its container ids the
same before and after.

### The run loop

`omarchy-agent run` (#315; design v2 §16) keeps the host on the pool's
release. It ticks every few seconds and never blocks longer than one engine
or HTTP call with a timeout; a watchdog thread ends a loop that made no
progress for 15 minutes so the service manager starts it again. Everything
lives under the data directory (`~/.local/share/omarchy-agent`, or `--data-dir`):
`agent.toml` (the owner's envelope, refused when others may write it),
`state.json`, `journal.ndjson` (rotated at 10 MiB), the verified bundles it
fetched, the pinned docker CLI and compose plugin (`tools/`, by the SHA-256
the manifest names; no other docker or compose binary is ever run),
`staging/host/` and `last-good/host/`.

Each round goes `render → lint → plan → pull → replace → guard → commit`,
or `revert`, each step written to `state.json` before it acts, so a restart
anywhere resumes it (a ready wait or a guard in flight starts its clock again:
after a reboot the dispatcher is still re-adopting its leases). The pool's `follow` names the target (until P3's host
state); the bundle must verify against `release.yml` on main, the pool's
origin must be in its `pools`, and the target must be at or above the floor
(the highest release applied), `min_release` and outside `revoked` (both
merged from every verified manifest and never lowered) — or covered by a
rollback statement (*Rollback statements* in the security model), which
preempts a round in flight, as a newer release does, at any step before
`commit` (an older release waits for the round to end). The dispatcher alone is replaced: stopped (it saves its leases
and exits within 60 s), created from the new files and waited for on
`/ready`; task containers are never part of a plan and keep running. The
guard then samples it for `guard_s`: a restart streak, two restarts that
were not ordered, an exit other than 0 and 75 (#277's ordered restart) or a
lost `/ready` revert to `last-good/` and quarantine the release for an hour
(one retry, then until a newer release); an Update order on the host's
worker lifts every quarantine and starts a round. A changed
`compose.override.yml`, `etc/` file or `run/capacity.json` starts a round
too, and the running set is compared with `last-good/` every 15 minutes.
Two known gaps: a round preempted during its replace leaves the dispatcher
stopped (its leases saved) until the new round's replace, and a release's
pinned docker and compose roll forward only — tools that cannot talk to the
engine leave the round at `engine-unreachable` until a newer release.

| The last round says | What it means |
|---|---|
| `ok`, `no-change` | the set runs the target |
| `held` | the dispatcher waits for a file: `etc/dispatcher.env` until the owner confirms the host (#321), `run/capacity.json` until capacity detection writes it (#333); or the target is quarantined |
| `rolled-back` | the guard (or the ready wait) failed; `from` names the release left, `detail` the step and why |
| `refused` | with its reason: `below-floor`, `below-min-release`, `revoked`, `statement-seq`, `statement-range`, `statement-too-deep`, `pool-not-listed`, a `verify` reason (`signature`, `workflow`, ...), or `lint: ...` |
| `pool-unreachable`, `unauthorized` | nothing changes and everything keeps running; polls back off to 10 minutes (no answer, 5xx, malformed) or go hourly (401/403), and the next answer recovers by itself |
| `engine-unreachable`, `pull-failed` | nothing changes; the step or the next poll tries again |
| `needs-newer-agent` | the release needs an agent this one is not and the update to it did not happen (why is in `detail`; *Self-update*, below) |
| `agent-rollback` | a self-update's new agent did not pass its health gate: the agent named in `detail` is back, and the one it left is skipped until a higher one |

On the host: `omarchy-agent status` (from `state.json` and
`run/capacity.json`, with the pool and the engine down), `omarchy-agent
round` (a round now: SIGUSR1 to the running agent) and `omarchy-agent logs
[-n N]`. Exit 78 means a local configuration error at start — `agent.toml`,
a data directory others may write, an unreadable `state.json`, another agent
running on the same data directory — that stops the agent until a person
fixes it; no network answer ever does, and a write that fails while it runs
(a full disk) is retried every tick, each step being safe to run again. `tests/agent-run-loop.sh` runs the
loop against a real engine in CI (rootful docker and rootless podman).

### Self-update

The agent updates itself from the releases it verifies (#316; design v2
§16.3), with no one at the host: a release whose manifest ships a **higher**
agent than the running one updates it before the round touches anything; a
release with the same or a lower agent (a rollback, or a release that did not
change the agent) never restarts it, and any agent at or above a release's
`min_agent` applies that release. Only a rollback statement's `agent_to` moves
the agent down, and only to the agent the statement's release ships.

The update downloads the binary the manifest lists for the host from the
release, checks its SHA-256, installs it as `versions/<version>/omarchy-agent`
and runs its `self-test` (agent.toml and state.json read, the release's bundle
verified, the host set linted in memory; `ok` within 30 s). Then it writes
`pending` (`from`, `to`, the starts counted, a 10-minute deadline), points
`previous` at itself and `current` at the new agent, and exits; the service
manager starts `current`. The dispatcher and the task containers keep running
throughout. A download, a hash or a self-test that fails changes nothing: the
running agent applies the release itself when its `min_agent` admits it, and
the update is tried again an hour later (at once after a restart), while the
pool still names that release too.

The new agent counts its start in `pending` before it reads anything else, and
touches no container until its health gate passed: a cached bundle verifies,
the engine answers, the pool answers (or is plainly unreachable). Its third
start without passing it, a start after the deadline, a configuration it
refuses, or a gate still shut at the deadline points `current` back at the
previous agent, which reports `agent-rollback` and skips that version until a
higher one. Under systemd the unit is `Type=notify`: a start that hangs before
the agent says it is ready fails after `TimeoutStartSec=120`, and a loop that
stops making progress is killed after `WatchdogSec=300`; on both systems the
agent's own watchdog ends a loop stuck for 15 minutes. Three versions stay
under `versions/`. `omarchy-agent status` shows an update in flight and a
skipped version; `state.json` is read leniently, so the agent rolled back to
reads what the newer one wrote. `tests/agent-self-update.sh` runs deliberately
broken builds (a panic at start, a hang before ready, a hang after it) under a
real `systemd --user` in CI.

### How the pool hands a host work

Every claim of a host — and of a legacy registration, selected as a host
with one lane and one build until it retires — goes through the pool's
selection (#337, design v2 §8.3; `worker/src/selection.ts`). A host is
handed as many tasks as its units hold: a build 2 units per size, a trial 2,
an audit 1, one unit kept for pool jobs, model work within its agent slots,
each lease its own container; what does not fit waits in the pool's queue
and starts as units free up. Its units are min(what it declares, what the
pool recomputes from its totals with the signed constants, the pool's cap).
Before each claim its dispatcher checks `MemAvailable` against the largest
task it could receive and offers only what still fits (a shared machine, a
laptop in use, the Studio's legacy set during the canary): its log says
`… GB available in memory: this claim offers N of M free unit(s)`. The
shares of the leases it started in the last five minutes count as used
(`… (K GB of it promised to leases just started)`): their containers have
not grown yet, so a burst of claims never offers the same memory twice.
The offer bounds that claim only — the host is still counted by its units,
so a size-4 build waits for memory rather than run smaller.

- **Native first, emulated after T.** A build of an arch the host runs
  emulated waits its threshold T — twice the last native build of that
  package and arch, 3 to 60 minutes, 3 with no history — while a native host
  that would take it now is alive (claimed in the last 2 minutes, not
  drained, not below the minimum, units and disk free); a drained or busy
  native host never makes it wait. A `needs_native` build never runs
  emulated. While no host runs an arch natively, every host with an emulated
  lane of it keeps one of its builds running, however long the native
  backlog (the guaranteed share). Emulated lanes hold at most half a host's
  builds while native work for it waits, all but one otherwise; nothing
  running is ended for that.
- **Emulated lanes are detected (#338).** At install and at each
  `omarchy-agent capacity … --write` (below) the agent looks at the other
  architecture: the envelope's `emulate` (absent: allowed; `emulate = []`:
  off), then the binfmt handler (`/proc/sys/fs/binfmt_misc/qemu-<arch>`,
  enabled with the `F` flag — `factory/host/prep-root.sh` installs
  `qemu-user-static-binfmt`), then a smoke run of the release's build image
  of that architecture (`/usr/bin/true`, then `pacman --version`). Passing,
  the lane goes into `run/capacity.json`'s `lanes` with `via` and
  `page16k`; otherwise into `held_lanes` with the reason, and the native lane
  runs on. Check it on the host with
  `jq '.lanes, .held_lanes' <set dir>/run/capacity.json` (or
  `omarchy-agent capacity --work-root <dir> --emulate-image <image by digest>`
  without a release); a lane held with *needs a person* wants prep-root.sh
  run once as root, then detection again with the owner's envelope and the
  release the host applied (`omarchy-agent status`, *release: applied*),
  whose bundle the agent keeps under its data directory:

  ```bash
  d=~/.local/share/omarchy-agent r=vX.Y.Z   # the data directory, the applied release
  "$d/current/omarchy-agent" capacity --envelope "$d/agent.toml" \
    --bundle "$d/bundles/omarchy-host-$r.tar.gz" \
    --sig "$d/bundles/omarchy-host-$r.tar.gz.sigstore.json" --write "$d/sets/host"
  ```

  Leave out `--envelope` and the owner's `emulate` and caps are not
  applied: the file could turn on a lane the envelope keeps off. The run
  loop sees `run/capacity.json` change and starts a round (re-running
  install does the same). Install writes `emulate` into the envelope with
  the architecture it found, for the owner to confirm; `emulate = []` there
  keeps it off. On 16K pages the x86_64 lane stays on (D33): a build whose
  toolchain cannot start under qemu fails at once with `needs_native` (the
  build script's probe; only a
  container on an emulated lane is told it is one,
  `WORKER_LABELS={"emulated":true}`), goes back to the queue with its attempt
  given back and never runs emulated again — it waits for a native host,
  which its package page says. The pool takes `needs_native` only from a
  lease on an emulated lane; from a native lane it is a failure like any
  other, journaled *its needs_native refused*. Jobs with helper containers
  need a lane of each ring architecture they check, native or emulated, with
  no wait: a health check its own, a promotion (its ABI gates and health
  checks) each it promotes, a security job's fast-track both.
- **The project's copy is not built on its requester's host (#339, D35).**
  A review rebuild of a package a maintainer asked for (the rebuild's owner,
  and the owner of the contributor's build it answers) is handed to none of
  that maintainer's hosts while another maintainer's host has a lane
  allowed for it — native, or emulated unless it is `needs_native`; it
  waits for that host however busy it is, and their other work goes on.
  When only the requester's hosts have one (a single maintainer's hosts, or
  a `needs_native` rebuild with the other host's lane emulated), Review's
  rebuild pane says at once *waits for a host — only @m1's can build it*,
  with **Release to any host** for another maintainer: confirmed with their
  passkey, written on the task (`params.any_host`), the journal (a `review`
  line, *released to any host by …*) and the record; any host takes it at
  its next claim, the requester's included. Bringing another maintainer's
  host with that lane online (or resuming a drained one) builds it without
  a release. A claim never pins a rebuild to the requester's host: naming
  one is refused (`requester_host`), and another architecture's same-agent
  pick goes unpinned instead.
- **The second opinion (#339, D36).** An audit runs in a fresh container
  with its own agent sidecar. It leaves the host that built what it audits
  to another that can take it now, for 3 minutes. An audit of the project's
  copy takes another model (the claim's `agent`: provider and model) than
  the one that built it whenever a registration that takes audits with
  another model was seen in the last 24 hours — however long that host is
  busy, and for a day after it went quiet; otherwise it runs on the same
  model. Each audit says how independent it was beside its verdict on
  Review (`independent: model`, `host` or `none`). Audits held for a host
  that is gone for good: retire it, or drain its registration, and the next
  claim hands them to the model alive. What counts, and how the last week
  went:

  ```bash
  npx wrangler d1 execute omarchy-repo --remote --command "SELECT id, agent, last_seen, drained_at FROM build_workers WHERE last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') AND revoked_at IS NULL AND agent IS NOT NULL"
  npx wrangler d1 execute omarchy-repo --remote --command "SELECT independent, COUNT(*) AS n FROM build_tasks WHERE kind = 'audit' AND started_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days') GROUP BY independent"
  ```
- **Contributors take turns.** Community builds are handed round-robin by
  owner (fewest leased first), and a contributor holds at most
  ceil(the alive fleet's builds / 4) at once. The divisor is a setting: 0
  lifts the cap (round-robin stays); with the legacy fleet alone (a few
  registrations, one build each) the cap is 1 or 2 — lift it if that leaves
  builds idle while one contributor's queue waits:

  ```bash
  npx wrangler d1 execute omarchy-repo --remote --command "INSERT INTO settings (key, value) VALUES ('owner-cap-divisor', '0') ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  npx wrangler d1 execute omarchy-repo --remote --command "DELETE FROM settings WHERE key = 'owner-cap-divisor'"   # back to 4
  ```
- **Sizes.** A build asks size 1 unless a maintainer set more: in
  `factory/sizing/tasks.toml` (`size`, `disk_gb`, in a pull request another
  maintainer approves) or on the package's page (*size · Set*, journaled;
  the page's word wins until it is cleared). A contributor's build runs at
  size 2 at most, every build at the largest size a host alive runs — a
  clamped one says so in the journal (`… asked size 4; the largest host
  alive runs size 3`). The oldest build of size 2 or more that has waited
  30 minutes, that some host alive could run and its owner's cap does not
  hold back, and that fits no host's free units makes the host with the
  most free units **reserve** for it: that host takes nothing else but pool
  jobs while its free units are below the build's (a `host` line says so),
  two hours at most; the host page shows it. Once its units fit, the build
  goes first; when it still cannot be leased there (its owner reached their
  cap meanwhile, the host's memory is short this round), the host takes
  other work rather than sit idle — as it does, whatever its free units,
  while its claim cannot take the build at all (a draft while its agent's
  probe fails, any build while it holds builds back for disk). An older
  build waiting for another reason (a `needs_native` one with no native
  host, a capped contributor's) does not stop it. Two hours spent, the
  mark clears and the host goes back to normal selection for 30 minutes
  (`build_tasks.reserved_at`); then the build waits its turn again and is
  reserved for anew, so a host never holds back work for one task more
  than two hours at a time, and a build whose host ran something longer
  than the window still starts. A maintainer who wants it built sooner
  lowers its size on the package's page. A build that ran out of memory
  says *out of memory at 4 GB (size 1)* on its package's page — as soon as
  it is queued again, not only once its attempts are spent, with the size
  it waits at — and on Review, where a maintainer's **Retry at size N**
  queues it again at the size chosen (up to the largest a host alive
  runs), for one more try.
- **The pool's cap** (`hosts.pool_cap_units`): its owner or any maintainer
  sets it on the host's page, with a reason — the Studio canary runs at 3
  units, one build (§21.1). Lowered below what the host runs, nothing ends;
  it claims nothing until its leases fit. Lifted, the host's count decides.

## The Studio host

The project's workers run on one machine — `omarchy-studio`, a Mac Studio
on Arch Linux ARM (Asahi), 12 cores, 32 GB, on around the clock — as eight
worker containers of the image: two pool, four review (two pairs, since
2026-09-17: an audit waited 23 minutes on average behind builds and the
pool's jobs), two community, one per architecture each (four of them run
by default: the x86_64 review and community services are behind the
`emulated` profile, and the second review pair behind its own `review2`
profile, off until `register.sh` has registered it)
([factory/host/](../factory/host/README.md); the roles:
[factory/README.md](../factory/README.md) *Three roles*):

| Service | Registration | Takes |
|---|---|---|
| `pool-x86_64`, `pool-aarch64` | project trust | the pool's jobs: sync, render, promote, rollback, health, security, enqueue, gc, verify, relayout, trial |
| `review-x86_64`, `review-aarch64`, `review2-x86_64`, `review2-aarch64` | project trust, an agent key | the project's builds from staged evidence, the audit of staged builds — two pairs, so an audit does not wait for a build |
| `community-x86_64`, `community-aarch64` | community, shared, an agent key | contributors' requested packages, with the project's agent |
| `broker-community-{x86_64,aarch64}` | `etc/agent.env` + the builder's token | the broker (`factory/bin/broker`): the worker token, the agent key and `GITHUB_TOKEN` for the builder beside it, which holds nothing; the pool's calls for the one task it claimed, the agent, GitHub read-only |
| `agent-proxy` | `etc/agent.env` — no worker token | the agent and GitHub, natively, over HTTP for the review workers' audits and their build containers (the `review` network): Claude Code's binary dies under qemu, so the emulated worker asks this one (`FACTORY_PROVIDER=anthropic`, `ANTHROPIC_BASE_URL=http://agent-proxy:8790`; `factory/bin/agent-proxy`) |

The host is aarch64: pool and review workers run natively (an x86_64 pool
job is a label). x86_64 *builds* would run under user-mode emulation,
and on this host's 16K-page kernel (Asahi) qemu cannot map every x86_64
library — `rustc` and `sudo` fail with *failed to map segment* — so the
two x86_64 build services sit behind the compose `emulated` profile, off
by default: x86_64 build tasks wait for an x86_64 worker, and any x86_64
machine with docker becomes one in minutes (factory/host/README.md,
*x86_64 builds*) — the pool does not care where a worker runs.
`COMPOSE_PROFILES=emulated` in `.env` turns them on here anyway
(`community-x86_64`, `review-x86_64`, labeled `"emulated":true`), for
C-only packages. The second review pair has a profile of its own,
`review2` (#295): until it is registered, a worker with no token would
exit at start and restart, and the updater holds back a set where one
restarts. To turn it on, run `./register.sh` (it registers only the
services whose env file has no token yet), then set
`COMPOSE_PROFILES=emulated,review2` in `.env`, then run `./rollout.sh`.
`review2-x86_64` is labeled `"emulated":true` too. A build that dies of emulation
there goes back to the queue for a native x86_64 worker, not retried and
not failed: a toolchain that cannot start, or a library qemu cannot map.
No emulated worker takes it again (#281). To see it: the Workers page says
how many builds wait for a native worker, each linked. The build page and
the Review workbench say *waiting for a native x86_64 worker*. The events
log a `build` warning with `needs_native`. It waits until a native x86_64
worker is online.
Everything lives under `/srv/omarchy-pool`
(a btrfs subvolume on the internal disk; the 4 TB drive joins when it has a
USB enclosure — the Asahi kernel has no Thunderbolt tunnelling, so the NVMe
slot of a Thunderbolt dock is invisible to it): `work/<service>` (the same
path inside the project workers), `cache/pacman/<arch>` (one package cache
per architecture, mounted into every build container: `OMARCHY_PKG_CACHE`),
`cache/build/project/<arch>` and `cache/build/community/<arch>` (cargo, Go
and ccache caches the build containers mount at `/build/cache`:
`OMARCHY_BUILD_CACHE` for the project's, the compose file's volume for the
community's — a stranger's build never writes what the project's build
reads; inside, one directory per package),
`etc/` (the eight worker tokens and `agent.env`, mode 600, never in the
repository). **On the host: setup, hardware, and a look when the pool cannot see**:

```bash
cd /srv/omarchy-pool
docker compose ps                                # seven up by default (four workers, one broker, the agent proxy, the updater); ten with COMPOSE_PROFILES=emulated, twelve with emulated,review2
docker compose logs -f --tail 50 pool-aarch64    # one of them
./rollout.sh                                     # wakes the updater now, or starts it (--check: what it would do)
docker compose restart pool-aarch64              # a worker stuck in a task: a drain, it finishes the task first (up to 3 h)
docker kill <container>                          # one that must end now, or whose engine is stuck
```

**On a host the agent manages, nothing needs to be run** (#313). Once
`omarchy-agent` has retired this set (its `retire-legacy` order, after the
switch and the 14 days the set stays as the way back), it leaves a marker,
`/srv/omarchy-pool/.omarchy-agent`, with its version, the host id and the
time. From then on `./rollout.sh` and `setup.sh` refuse there (exit 4),
`omarchy-worker start|update|remove` refuse in a directory that holds it,
each before it changes a file or a container, and the updater stands down:
its rounds change nothing, and its `--self-test` says `stands-down`. What to
look at instead: `omarchy-agent status`. Without the marker, all of them
work as before, the legacy set's updater included.

The updater learns the marker with the release, as it runs the pool's
image. The host's own copies do not: `setup.sh` installs
`/srv/omarchy-pool/rollout.sh` only when it runs, and `omarchy-worker` never
updates itself. So, once, before the first `retire-legacy` on a host set up
before this release, paste the block in *Once: the updater* again: it takes
the release's `setup.sh`, which on a host whose updater already runs only
installs the new host files (keeping the ones it replaces) and wakes the
updater. `grep -q omarchy-agent /srv/omarchy-pool/rollout.sh` then says the
copy has the guard. Fetch an `omarchy-worker` downloaded before this release
again (the `curl` line at its top). An old `rollout.sh` that is missed
brings back only the updater, which stands down.

A worker's page, `/worker/<id>`, takes the rest: Re-check agent, Restart
(between tasks), Restart agent service, Stop its task, Drain and Resume,
Update. A task that hangs is stopped there: Stop its task gives it back to
the queue once its worker has stopped it, with no restart and no three-hour
wait.

Upgrades are **rolling**: a pool release publishes a new image, the
`updater` service sees the pool's new release within two minutes and
replaces what changed in one `up` — every stop is a drain (SIGTERM: the worker finishes the task it
holds, reports it, claims nothing new and exits; the compose file allows
three hours), each container on its own clock, the new ones starting as
the old ones end while the unchanged keep working. No task is killed,
none is handed to another worker by an expired lease (what `docker
compose up -d` on a busy worker did), and none idles on the old image
while another drains (what one-at-a-time did: pool-aarch64 waited three
hours for pool-x86_64's drain on 2026-09-15 — and the pool now refuses an
outdated worker).

**What the workers call goes first** (#273). After the v1.0.0 and v1.0.1
releases (2026-09-29), `rollout.sh` replaced `agent-proxy` in the same `up`
as the review workers; they checked their agent before the proxy listened
on `:8790` (`URLError: [Errno 111] Connection refused`), reported
`agent_status: error`, and stayed not ready — while the Factory and Status
pages drew them *idle, waiting for work* — for half an hour, until a
`docker compose restart` by hand. Three things now keep that from
happening:

- The rollout replaces `agent-proxy` and the community brokers first and
  waits until each answers on `:8790` from inside its container (a `curl`
  of `GET /`, never `/health`, which spends a completion of the agent),
  at most `ROLLOUT_BROKER_WAIT` seconds (300) for all of them together;
  one that never answers is a `WARNING` line in its log and
  the rollout goes on — it never hangs on a broker — and brokers compose
  could not start (`FAILED to replace`) are not waited for at all. Only
  then are the workers that changed replaced, in one `up` as before.
  `rollout.sh` did it on this host until its one-time step (#277); the
  updater (`factory/bin/omarchy-rollout`) does it here since, as it does
  in every contributor's set.
- A worker whose agent does not answer checks it again after 15 s, then
  30 s, 60 s… doubling back to the thirty minutes a healthy agent is
  probed at, until it answers, and reports each result with its next claim
  (`pkg-repo work` for the pool and review workers,
  `omarchy-build-worker.sh` for the community containers). An agent that
  is starting answers within the first few re-checks; one that fails for
  good (no credit, a revoked key) is asked every half hour again after
  about thirty minutes, since each probe is a real completion. The failure
  is logged once, not at every re-check; a healthy agent is logged at each
  of its thirty-minute probes, as before.
- The Factory's workers card and Status's workers list draw a live worker
  that is not ready as **not ready**, with the agent's error, as the
  Workers page's *failed* pill does. Every page gives a worker one state, in one
  order: revoked, offline, building, drained, outdated, not ready, idle.

**Every worker follows the latest image** (2026-09-17, after a
contributor's worker sat ten releases behind for a day, drafting the
wrong version and linking the wrong objects while looking alive): the
pool compares the release a worker reports at each claim with its own
and, past the rollout's grace (`UPDATE_GRACE_MINUTES` = 45 after the
deploy), hands it nothing — `426`, *outdated* on the Workers page, one
journal line per release — until it updates. Every set carries an
**updater** container of the same image (`OMARCHY_WORKER_ROLE=updater`,
`factory/bin/omarchy-rollout`: the same rolling replacement, itself
last) — contributors' sets since `omarchy-worker start` writes one, this
host since its one-time step below. It asks the pool every two minutes
(`GET /api/v1/factory/follow`) and follows its release, and an Update
pressed on any of its workers' pages; it replaces itself last, and only
with an image under which what it replaced stays up. A set without one
idles until its owner pulls by hand.

The Workers page lists them by role; the laptop runs nothing any more,
and GitHub Actions runs CI and the release only — there is no hosted
fallback worker: when the host is down, pool jobs wait, and the dashboard
says so.

### Once: the updater (#277)

The Studio runs the same `updater` as every contributor's set, and a host
timer no longer rolls it out. Do this once the release that carries #277's
last part is out. Any later release will do: the step takes the release
the pool runs.

**First, look** (as the user who owns `/srv/omarchy-pool`; nothing here
changes anything):

```bash
cd /srv/omarchy-pool
docker ps -a --filter label=com.docker.compose.project=omarchy-pool   # what runs now: a container that restarts is fixed or removed first
pgrep -af rollout.sh                              # nothing, or the timer's own rollout (setup.sh waits for that one); setup.sh refuses while one started by hand runs
ls -l etc/                                        # the env files there; review2-*.env may be missing (setup.sh writes them)
grep COMPOSE_PROFILES .env                        # emulated on the Studio; review2 stays off until it is registered
grep -l '^OMARCHY_WORKER_TOKEN=omw_' etc/review2-*.env   # a review2 registered already: add review2 to COMPOSE_PROFILES first
tag="$(curl -fsS https://pkgs.omarchy-pool.org/api/v1/version | sed -En 's/.*"version": *"(v[0-9.]+)".*/\1/p')"
curl -fsS "https://raw.githubusercontent.com/firemanxbr/omarchy-pool/$tag/factory/host/compose.yml" | diff -u compose.yml -
```

The first look uses `docker ps`, not `docker compose ps`: while an env file
that this host's `compose.yml` names is missing (a review2 one, say), every
`docker compose` command fails, and `setup.sh` is what writes it.

A line the diff removes is either an upstream change since the release
this host's copy came from (the review2 pair with no profile, a comment
rewritten) or a local edit. To tell them apart, diff the host's copy
against the release it came from, for example the one before:
`curl -fsS https://raw.githubusercontent.com/firemanxbr/omarchy-pool/<that tag>/factory/host/compose.yml | diff -u - compose.yml`.
The lines that diff adds are the local edits. Put those, and only those,
in `compose.override.yml` beside `compose.yml`: compose and the updater
read that file, and `setup.sh` never touches it.
`setup.sh` keeps the old `compose.yml` anyway (see below) and prints the
lines it replaces.

**Then paste this** (it stops at the first step that fails):

```bash
(
  set -euo pipefail
  cd /srv/omarchy-pool
  # The release the pool runs, and its host files, which must have the updater.
  tag="$(curl -fsS https://pkgs.omarchy-pool.org/api/v1/version | sed -En 's/.*"version": *"(v[0-9.]+)".*/\1/p')"
  src="$(mktemp -d)"; trap 'rm -rf "$src"' EXIT
  git clone --quiet --depth 1 --branch "$tag" https://github.com/firemanxbr/omarchy-pool.git "$src"
  grep -qx '# omarchy-rollout: kick-v1' "$src/factory/host/rollout.sh"
  # Checked, the timer stopped (its last rollout waited for), the files, the updater started and checked, the timer removed.
  sudo "$src/factory/host/setup.sh" /srv/omarchy-pool
  ./rollout.sh   # wakes the updater: a round now
)
```

What `setup.sh` does, in order, and what a failure leaves:

1. **It checks before it touches anything.** The release's `compose.yml`
   is loaded against a staged copy of this host's `.env` and `etc/`, with
   the env files it would write for any that are missing. It loads under
   this host's profiles and under every profile the file names. It also
   checks that `.env`'s `POOL_ROOT` is this directory, that the updater
   image here (pulled first) is from #277 on, and that every service
   compose would run holds a worker token. It also refuses when another
   `setup.sh` runs on this directory, when a `rollout.sh` started by hand
   still runs, when `.env`'s `COMPOSE_FILE` names a file by an absolute or
   `../` path (name the files relative to `/srv/omarchy-pool` instead), and,
   before anything else, when the new files are in already (a killed step:
   see below). Any of these fails with exit 4
   and changes none of the host's files, units or containers (only the
   updater image may have been pulled): the timer runs on. Fix what it names (for a
   missing token: `register.sh`, or leave that service's profile out of
   `COMPOSE_PROFILES`), then paste again. It also warns about a container
   of this project whose service the new `compose.yml` does not run under
   this host's profiles (a registered review2, now behind a profile of its
   own): no rollout reaches it until its profile is in `COMPOSE_PROFILES`.
2. **It stops the timer**, as its user, then waits while a rollout the
   timer started is still draining. The timer is stopped, not disabled,
   until step 5: a reboot or a power cut before then brings it back (after
   step 3 has begun, see below what else it leaves). A
   drain takes up to 3 h; `setup.sh` waits up to 4 h (the old rollout also
   pulls and waits for its brokers). If the rollout still runs after 4 h,
   it enables the timer again, installs nothing, and exits 3. Paste again
   later. If its user's systemd does not answer, it exits 3 and tries to
   enable the timer again (its stop may have taken all the same), and says
   whether it could. The
   wait can last 4 h: run the paste in `tmux` (or `screen`).
3. **It installs the files.** `compose.yml`, `rollout.sh` and
   `register.sh` go in, with an env file (mode 600) for every `env_file`
   `compose.yml` names. The copies it replaces go to
   `/srv/omarchy-pool/setup-backup-<time>/`, with the timer's two units
   under `systemd-user/` and, in `created-env-files`, the env files it
   wrote.
4. **It starts the updater** (`up -d --no-deps --no-recreate updater`)
   and checks that it stays running, with no restart, for 30 s, and that
   its `--self-test` says `follows 1`. If any of that fails, it stops and
   removes the updater, puts the old files back, enables the timer again
   and exits 5. The host rolls out through its timer as before. Read
   `docker compose logs updater` from the output, fix the cause, paste
   again. If it cannot confirm the updater stopped (docker does not
   answer, or the updater still runs), or an old file does not copy back,
   it keeps all the new files instead, never one old file beside a new
   one, and still enables the timer, which then runs the new `rollout.sh`:
   it only wakes or starts the updater. It says so; take the way back
   below once that is fixed (docker answers, or the copy can succeed),
   then paste again. Each docker and systemctl call of
   this put-back ends within 60 s. The updater's first round starts at once: if it was draining a
   worker when it was stopped, that worker finishes its drain (up to 3 h),
   and the timer's next rollout then starts it: up to about 3 h 20 min.
5. **Only then does it disable the timer and remove its units**, and say
   it is retired.

An interrupt at any point before step 5 (Ctrl-C, a stop, a dropped
session, or its output gone, such as a `| tee` stopped by Ctrl-C) puts
back whatever was done so far: the updater it started stopped and
removed, the old files back, the timer enabled again (or, as in step 4,
the new files kept when that is not safe). It then exits 130,
143, 129 or 141 (the signal's), never 0. Paste again.

A `setup.sh` killed outright (`kill -9`, the OOM killer), or cut off by a
reboot or a power cut, puts nothing back. After a kill, the timer stays
stopped until the next reboot; after a reboot, it is back. What else it
left depends on when it stopped. If
`~/.config/systemd/user/omarchy-pool-rollout.timer` is gone, the step had
finished (it removes the timer's units last): the updater rolls the host
out (`docker compose ps updater`). Otherwise, as the user, run this (two
spaces before `updater:`):

```bash
cd /srv/omarchy-pool && grep -c '^  updater:' compose.yml
```

- **It prints 0**: nothing was installed. After a kill, bring the timer
  back, `systemctl --user start omarchy-pool-rollout.timer`, then paste
  again. After a reboot the timer is back already: paste again.
- **It prints 1**: the new files are in, or some of them. Do not start the
  timer: it would run the old `rollout.sh` beside the updater, or the new
  one, which starts an updater that passed none of the checks. After a
  reboot it runs already, which the way back fixes. Take the way back
  below (it picks the backup from before the updater, stops any updater
  and enables the timer), then paste again. Until then, `setup.sh`
  refuses (exit 4) and says so.

Right after a kill, a paste again may say that another `setup.sh` runs:
a child of the killed one (a `docker` call waiting on the engine) still
holds `.setup.lock`. `fuser -v /srv/omarchy-pool/.setup.lock` names it;
end it, or wait until docker answers, then paste again.

The `./rollout.sh` at the end then only wakes the updater. If it fails
after `setup.sh` succeeded, the updater still runs and rolls the host out:
`docker compose ps updater` says so, and `docker compose logs -f updater`
shows its rounds. If the updater is not running, `./rollout.sh` starts
it as it is. When that fails too, run
`docker compose up -d --no-deps --no-recreate updater` and read its error.
If the updater cannot run here, take the way back below.

The updater's first round may drain and recreate every service once
(its compose computes configuration hashes its own way). Within ten
minutes, each Studio worker's page says "rolled out by its updater", and
Status's line about this step goes away.

From then on, do not run a bare `docker compose up -d` on this host. It
re-stamps every service's configuration hash with the host's compose, and
the updater's next round drains and recreates every service once more. To
start everything, run `./rollout.sh`: it wakes the updater, or starts it as
it is when it is not running (never recreated: which image it runs is its
guard's call), and a round starts whatever is not running. For one service,
run `docker compose up -d --no-deps <service>`, which costs that one
service a second replacement.

Until this is done, releases still arrive through the timer, and every
order but Update works. The pool knows whether it was done, because the
workers report it with their claims.

To undo it (an updater that misbehaves here), use the copies `setup.sh`
kept. The updater is stopped first, by its compose labels, before anything
is copied: compose leaves a running one alone once `compose.yml` no longer
names it, and it would go on rolling the host out beside the timer. A
worker the updater was draining finishes its drain (up to 3 h), and the
timer's next rollout then starts it: up to about 3 h 20 min.

```bash
(
  set -euo pipefail
  cd /srv/omarchy-pool
  # The newest backup with the timer's units whose compose.yml and rollout.sh are there and are not the updater's: a step
  # that was killed and pasted again wrote a newer one, holding the new files.
  b=""
  for d in $(ls -d setup-backup-*/systemd-user | sort -r); do
    d="$(dirname "$d")"
    if [ -s "$d/compose.yml" ] && [ -s "$d/rollout.sh" ] && ! grep -q '^  updater:' "$d/compose.yml" && ! grep -qx '# omarchy-rollout: kick-v1' "$d/rollout.sh"; then b="$d"; break; fi
  done
  test -n "$b"
  # The updater, by its labels: whichever compose.yml is in place, and while compose cannot load the project. None may still run.
  ids="$(docker ps -q --filter label=com.docker.compose.project=omarchy-pool --filter label=com.docker.compose.service=updater)"
  if [ -n "$ids" ]; then docker stop $ids; docker rm $ids || true; fi
  ids="$(docker ps -q --filter label=com.docker.compose.project=omarchy-pool --filter label=com.docker.compose.service=updater)"
  test -z "$ids"
  cp -p "$b/compose.yml" "$b/rollout.sh" .
  if [ -f "$b/register.sh" ]; then cp -p "$b/register.sh" .; fi
  # The env files the step wrote that are still its untouched placeholder go: the old compose.yml starts no pair nobody registered.
  if [ -f "$b/created-env-files" ]; then
    while read -r f; do if grep -qx 'OMARCHY_WORKER_TOKEN=' "$f"; then rm -f "$f"; fi; done < "$b/created-env-files"
  fi
  mkdir -p ~/.config/systemd/user && cp -p "$b"/systemd-user/omarchy-pool-rollout.* ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now omarchy-pool-rollout.timer
  docker compose config -q
)
```

If it stops part way, paste it again: it stops only an updater that still
runs, and the rest is idempotent. If it stops before its `cp` (at
`docker ps`, `docker stop` or the check after them), nothing was copied:
paste it again once docker answers. If its `docker rm` failed (it prints
the error and goes on), the stopped updater container is left: remove it
with `docker rm` before you run `setup.sh` again, whose
`--no-recreate` would otherwise start that container as it is.

Its last line, `docker compose config -q`, prints nothing. If it names a
missing `etc/review2-*.env`, the old `compose.yml` names the review2 pair
with no profile, and it did not load before the step either. Take the
pair out of that file, or register it. Do not write an empty env file:
that starts the pair unregistered.

Do not run an older release's `setup.sh` for this. Its `compose.yml` has
the review2 pair with no profile, which would start it unregistered.

### After a release

Nothing to do on any host, and on a host the agent manages, nothing needs
to be run either. The pool is deployed once the images exist. Within two
minutes, every updater sees the pool's new release and rolls its set out:
every contributor's set, and the Studio's since its one-time step above.
`agent-proxy` and the brokers go first, each answering before the workers
that call them (#278), then the workers, each stop a drain.

A worker whose agent does not answer re-checks it by itself (#278). The
pool re-checks it too, and, only if that is not enough, restarts it or
restarts `agent-proxy` through one of its workers (#277). The pool does so
within bounds, and on the record: `order` lines in the journal.

Where to look: Status (workers not ready, outdated, silent since the
deploy), the Factory's workers card, and a worker's page, `/worker/<id>`,
with its last orders and its log. What a maintainer, or the worker's owner,
presses there: Re-check agent, Restart, Restart agent service, Stop its
task, Drain, Resume, Update. None of them needs the passkey that approve and
block need (#283); each is on the journal with who pressed it. A worker
whose task hangs through the release is replaced when its drain's three
hours end — or sooner, once Stop its task has given that task back.

If the release's image does not start (Status: "N workers alive before the
deploy … have not claimed for 15 min"), roll it back from anywhere:
`gh workflow run rollback.yml -f to=<the release before it>`. The images and
the Worker go back, and the updaters follow within two minutes (*Releasing
the pool itself*).

## Maintainers: reviewing contributed builds

The **Review** page lists staged builds (a contributor's package built on
their worker or a shared one, with PKGBUILD, log, the gate's verdict and
the audit — and the worker and host behind it). A maintainer — a login
listed in `factory/MAINTAINERS.toml`, signed in with GitHub — never
decides on their own package, and never on a contributor's bytes:

- **Claim** (Review's queue; *Build by the project* on a build's page)
  queues a project build (`pkgbuild_ref = review:<task>`, trust `project`),
  pinned to the review worker whose agent you chose: a review worker (`pkg-repo work`)
  starts a fresh container that holds nothing, where the project's agent
  writes its own recipe with the request's facts and the contributor's
  evidence as the lesson, builds it through the same gate and stages it
  under `staging/@project/`; a second agent audits it, and the trial
  installs it with a real pacman from the lab.
- **Approve** the project's build (a contributor's cannot be approved), in
  the browser with your passkey — your first is added on your own page
  (`/user/<login>#passkeys`), or in the Approve dialog itself, which
  registers it and then approves with it (#287); a lost one is reset by
  another maintainer (*A lost passkey*, below) — records the decision (`approvals`, with your
  login, note and passkey) and queues a
  `publish` job that carries it into `edge` as source `factory` — and, when
  the trial passed, into rc and stable with it (the fast lane). The pool
  signs; from there the package follows the rings like any other.
- **Reject** needs a note; a request rejected frees its name (a package in
  the pool keeps it: the new version is what was rejected), the staged
  objects expire with the rest.
- **Request changes** needs a note too: the builds in review stop, the
  package returns to *registered* with the note in its detail, and the name
  stays the requester's.
- **Release claim** (`POST /api/v1/factory/tasks/<id>/release {reason}`): the
  maintainer who claimed it, or another, lets a claim go while a rebuild of it
  is queued or running — the whole claim, a rebuild already staged too; a
  claim whose rebuilds all staged is decided, not released. A claim's rebuild
  is not stopped with `POST /tasks/<id>/cancel` by hand (it answers 409 and
  names the release), nor is an approval's publish job (a block is what takes
  an approval back).
- **Adopt** (`POST /api/v1/factory/packages/<name>/adopt`), one door for the
  package page's *Adopt* and Review's *No maintainer* tab: on a package a ring
  serves you become its maintainer in the pool, and its page names you. A
  package its owner left *unmaintained* becomes yours as well, its bumps with
  it — once nothing of it is still in review (a build of the former owner's is
  decided first). One `adopt` line in the journal says which of the two it
  did; taking a registration is also a record the pool signs. A package no
  ring serves answers 404, one with a maintainer 409 (who adopted it, or the
  maintainer whose approval stands on one that is not unmaintained).
- Each decision above is a record the pool signs beside the request, and a
  journal line with who, the door and the agent that rebuilt the package. The
  one who asked for the package — the registration's owner, or the
  requester of the build in review — is refused a claim, an approval,
  request changes, a rejection and a release with `code:
  "conflict_of_interest"` when they are a maintainer (`maintainer_only`, as
  anyone who is not, otherwise); an adoption of your own package is refused
  the same way (`conflict_of_interest`).
- **Withdraw a record** (`POST /api/v1/factory/record/withdraw {key,
  reason}`) when a log or a report must leave the public bucket: a signed
  tombstone takes its place, the staging copy goes with it.

**Passkeys (#271).** Approve and block are decided in the browser with the
maintainer's passkey; no token approves or blocks. From the release that
carries #271, a maintainer who holds no passkey is refused both
(`no_passkey`, with the link to their page): each maintainer registers one
on `/user/<login>#passkeys` before that release deploys (v1.0.1 offers it
already). Since #287 a maintainer who holds none is told so — on Review, on
their page, and once at their first page as a maintainer — and the Approve,
Block and Force dialogs, and the page of an agent's draft, register the
first one, then confirm the act with it, without leaving the page. A new maintainer named in
`factory/MAINTAINERS.toml` needs nothing from an operator. Register two — a phone and a security key, say: the second is
added with an answer from the first, and a lost one is then removed with
the other, with no reset.

**What ships, and what guards it (#284).** Every door that puts bytes in
a ring, and the one thing that must hold for it to open:

| Door | What it ships | What guards it |
|---|---|---|
| **Approve** (Review, a build's page, an agent's draft confirmed) | the project's build, into edge — rc and stable too when its trial passed | the maintainer's passkey, in the browser; never their own package |
| **The enqueue job** (`POST /factory/enqueue` with its job token) | a recipe on `main`, built by a project worker and published into edge | the job's token, issued only to a project worker at claim; the recipe is a reviewed commit on `main` |
| **A build queued by hand** (`POST /factory/enqueue`, a maintainer's session or `omc_` token) | nothing: a dry run, built, measured and kept on the worker (`publish: false`) | anything else is refused (`dry_run_only`); the dry run's job token has no pool and no ring scope |
| **A sync** (the scheduler's, or `pkg-repo job sync`) | upstream's packages, into edge — the OPR's channels into their rings | every package verified against its upstream's keyring |
| **A promotion** (the scheduler's, or `pkg-repo job promote`) | a ring's head, into the ring above | the gate: fresh health and ABI checks, the soak, no security regression — rows the jobs write: your token writes a `note` to the journal, nothing else (`note_only`) |
| **A forced promotion** (Status's *Force into …*, `force=yes`) | a ring's head, into the ring above, past the gate — both architectures, or one | the maintainer's passkey, in the browser; no token forces one. The target's health check still rolls it back |
| **A rollback** (Status's *Roll back*, `pkg-repo job rollback`) | an earlier release of the ring, again | a maintainer's session or token; another ring's release is refused (`another_ring`); the journal keeps why |
| **A trial** (after the project's review build, or `pkg-repo job trial`) | the project's staged build, into the lab — never a promised ring, never promoted | a staged build of the project's own; the lab promises nothing, and a machine takes it only with `--ring lab` |

Taking out ships nothing: a block takes the maintainer's passkey (#271), a
withdrawal the session or the token. No door ships what no check and no
approval passed without your passkey.

**A lost passkey.** A maintainer who lost their only passkey — or every one
— cannot approve, block, add or remove one. The way back is another
maintainer's reset, and it hands the passkey back to a sign-in with GitHub,
so it is done in this order:

1. The person asks another maintainer, and that maintainer confirms the
   request out of band — a call, or a channel the two already share —
   before anything else. A request that came only through GitHub, or
   through the pool, may come from whoever holds the lost device.
2. The person, on a device they trust, ends the lost device's GitHub
   sessions (github.com → *Settings* → *Sessions*: revoke the others). A
   sign-in with GitHub that is still live there would register the next
   passkey for whoever holds it. They also revoke the GitHub tokens the
   device held — *Settings* → *Applications* → *Authorized OAuth Apps*
   (the GitHub CLI, any other) and *Developer settings* → *Personal access
   tokens*: any of them registers the login (`POST /factory/register`) and
   mints a new `omc_` token once the person has made theirs.
3. The other maintainer opens the person's page, *A lost passkey*
   (`/user/<login>#pk-reset`, drawn for a maintainer on another
   maintainer's page), writes why — it goes on the public journal and a
   record the pool signs — and confirms with their own passkey. Every
   passkey of the login goes, the login is signed out of the browser, and
   what the lost device may hold beside them goes too (#284): the
   command-line token and every live agent grant are revoked, a journal
   line each, and the agents' waiting drafts are discarded.
4. The person signs in with GitHub at once and adds a new passkey on their
   page — the first again, with the session alone. On the same page they
   make a new command-line token (*Token*) and grant their agents again
   (`omarchy-cli login`). Until they do, a GitHub token registers the
   login no new one (`token_reset`): the lost device cannot mint one back.
5. Both read the journal (`/journal?kind=passkey`): after the reset's lines
   (the reset, the token, a grant each), the next *registered a passkey*
   line for the login is the person's own (its id is on their page). One
   they did not add is another reset, and these steps again.

**Sign in with GitHub** (the header's *Sign in*) is the GitHub OAuth App
`omarchy-pool` (registered under the GitHub account that runs the staging
deployment, *Settings → Developer settings → OAuth Apps*; it moves with the
project, MIGRATION F2;
callback `https://omarchy-pool.org/auth/github/callback` — the App holds
several redirect URIs, and a sign-in pressed on any other production name
starts over on the dashboard, so this is the one used — homepage the
dashboard, no device flow, expiring user tokens on — the token is used
once, to read the login). Its client id is
`GITHUB_OAUTH_CLIENT_ID` in `wrangler.toml`; the secret is set with
`npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET` and rotated from the
app's page (*Generate a new client secret*, set, then delete the old one).
The logo is `docs/omarchy-pool-logo.png`.
The session is an HttpOnly cookie on the dashboard's origin; the pages call
the API same-origin. Without the app, `POST /api/v1/factory/register`
still accepts a GitHub token used once — except for a login whose token a
reset of its passkeys revoked, until the person makes one on their page
(`token_reset`, #284).

Roles come from the repository, not from an API: `factory/MAINTAINERS.toml`
lists the maintainers (one list, no areas), the brain reads `main` every
ten minutes (`worker/src/governance.ts`) and sets each contributor's role
from it — every change a `role` line in the journal. Changing the file
is a pull request another maintainer approves (`.github/CODEOWNERS` is
generated from it by `factory/bin/check-governance --write`; CI checks they
agree). See [Governance](GOVERNANCE.md). `GET /api/v1/factory/maintainers`
and `/factory/approvals` are the public record. What a package is about is
its *category*, proposed by the project's agent at audit and settled by a
maintainer (`POST /factory/packages/<name>/category`).

## Adding a repository

The pool mirrors a fixed table of upstream repositories; a new one from the
same project (an `omarchy-t2` beside `omarchy`, say) is a new **source**:

1. `worker/src/scheduler.ts`, `SYNC_SOURCES`: one entry per architecture and
   ring it serves — `source`, `arch`, `ring`, `base_url` (the upstream
   directory with the `.db`), `db_name` (the upstream database's name),
   `keyring` (which of `tests/fetch-keyrings.sh`'s keyrings verifies it).
2. `worker/src/routes/packages.ts`, `SOURCES`: the name, so the index accepts
   manifests with that provenance.
3. A keyring, if the packages are signed by a key none of the existing
   keyrings holds: `tests/fetch-keyrings.sh`.

The rest follows the source name: the rendered repository is
`omarchy-<source>-<ring>` (`render`), its objects and databases live in
`<source>/<arch>/` on the pool, the health check reads the rendered
databases from the release's artifacts, the coverage table and the pipeline
status list every source they see. The next sync imports it; the next
promotion carries it. Its place in the include is `REPO_ORDER`
(`worker/src/meta.ts`): a ring keeps every source's build of a name, and
that order is what decides between them on a machine.

## The relayout (one directory per source)

Until 2026-09-15 the pool was flat: `<arch>/<filename>`, one object per
filename whichever source built it — so Arch's `asusctl-6.5.0-1` stood in for
the OPR's, Arch Linux ARM's `libkrunfw` for Asahi's, and a ring could hold
one build of a name. Now every source has its directory
(`<source>/<arch>/<filename>`, `worker/src/r2.ts`) and a ring holds one
row per source, name and architecture (routes/releases.ts). The move is
the `relayout` job, run once:

```
pkg-repo job relayout
```

It copies every object into its source's directory (R2 checks the row's
sha256 on the way; the signature and attestation travel with it; nothing
is deleted), renders every ring so the databases sit in the same
directories, then purges what is left under the flat `x86_64/` and
`aarch64/`. 34 k objects, 311 GB, an hour or three; ~US$ 0.40 of R2
operations. While it runs, the include names both directories for every
section — pacman tries the servers in order, so a package not yet moved is
still found — and drops the flat one when the last object has moved. A row
whose bytes the pool never held (a rebuild indexed behind an earlier build
of the filename, before 2026-09-12) is marked `ghost/…` and left to
retention. The `relayout` event in the journal says what moved, what was
a ghost, what could not be copied.

Every machine set up before it needs the new include once — the one
command, again:

```
curl -fsSL https://pkgs.omarchy-pool.org/setup | sudo bash -s -- --ring stable
```

Its old include keeps working until the purge; after, its `Server =
…/$arch` lines name a directory that is gone.

One consumer of the pool does not read the include: the build worker's
own `add_pool_repos` (`factory/worker/omarchy-build-worker.sh`), which
probes the edge databases and writes its own two sections — the OPR and
the factory's earlier builds, with the worker's `SigLevel`. The relayout
(#138) did not touch it, and a failed probe says nothing, so from the
purge (2026-09-16 08:31 UTC) to v0.0.171 (2026-09-17 12:01 UTC) every
build container ran without those two repositories: a dependency on
either failed at `install_deps` as the recipe's fault. #175 (maralcbr)
pointed it at the source directories. The lesson: what the pool serves
has one description, the include; anything that writes `Server =` lines
by hand is a copy that drifts.

## When what the pool serves does not verify

The pool holds one object per `<source>/<arch>/<filename>` and never
overwrites it; the OPR rebuilds the same version per channel with different
bytes. Before
the pool refused a signature for bytes it does not serve (2026-09-12), two
things went wrong and pacman then refused the package as *corrupted*: a
later channel's `.sig` beside an earlier channel's object (69 of stable's 229
OPR objects on 2026-09-13), and a second index row for the same filename
pinned by a ring while the object stayed the first build's (5 more). The
`verify` job (weekly, Saturday 03:00 UTC; `pkg-repo job verify` by hand)
downloads every OPR object a ring serves, checks the bytes against the
index and the signature against Omarchy's key, and repairs: the right
`.sig` from the upstream channel that still serves those bytes; the ring
re-pinned to the object the pool holds (indexed from the bytes when the
index never saw them), then rendered. What no channel serves any more is
listed in the `verify` event for a replacement. The health check downloads
a sample per repository (eight from the OPR) so a wrong signature is
evidence the day it appears; the sync pins the stored object whenever a
filename collides, known sha or not; GC never deletes an object another
index row still names.

The first run (task 98, 2026-09-14) repaired the 69 signatures and then
failed on its own re-pin: `packages not indexed`. An `any` package is one
object per architecture directory with different bytes (Arch Linux ARM
rebuilds them), and the job remembered what the pool stores by filename
alone — so a ring's x86_64 re-pin carried the aarch64 bytes. It now keeps
one entry per `<arch>/<filename>` of the OPR's directory, and a re-pin happens exactly when the
ring's pin differs from what that directory stores, whatever the
signature's story was. The index holds one row per sha256 (0001_init.sql):
the same bytes stored under both directories can be indexed for one of
them, and the other directory's pin is reported rather than forced
(`POST /packages` answers 409, not a database error). The second attempt
re-pinned the 5 objects (rc#18, stable#8) and every OPR object verified.

## The factory

What no upstream ships is built by workers that pull tasks from the pool
([factory/README.md](../factory/README.md)). Every package comes in the
same door — a request on the dashboard; the repository holds no recipes
but the sizing ones (`factory/sizing/`, benchmarks). Day to day:

- **Add a package**: sign in and request it on `/factory` (the project's
  URL, a description, the licence, the checklist — written once to the
  public record); the build starts by itself in the shared queue — the
  best idle shared worker of the architecture, or a worker of your own at
  once — and a maintainer reviews the staged build (docs/GOVERNANCE.md).
  The person's page says where the build stands.
- **Rebuild**: press *Build* on the person's page (the queue, or a worker
  of yours), or `POST $API/factory/packages/<name>/build`; a maintainer's
  `POST $API/factory/enqueue` (`{"name","pkgbuild_ref":"<commit>","version","arches","publish":false}`)
  queues a sizing recipe as a dry run: by hand a build never publishes
  (#284, `dry_run_only`).
- **A failed task**: the person's page says what stopped it and how to fix
  it (the build's page has the whole log); *Build* again starts from that
  build's PKGBUILD and log.
- **Workers**: contributors' builds run on their own and on the shared
  workers; project builds (the rebuild of what a maintainer reviews) on
  project-trusted workers — today the
  Mac (`pkg-repo work`, one process per architecture). No GitHub runner
  builds packages; a queued build waits for a project worker. Workers
  hold no key: the pool signs what they publish.
- **The Omarchy reference for the ABI gate**: `tests/omarchy-rootfs.sh
  x86_64 stable` installs the ISO's package set from `stable` into a
  container and keeps pacman's database and the libraries under the
  worker's work directory (`omarchy-rootfs/x86_64`, ~1.5 GB) for seven
  days; the gate rebuilds it when older. The packages are installed as
  bytes (`SigLevel = DatabaseRequired PackageNever`): what a reference
  needs is their libraries; whether their signatures verify is the health
  check's and the verify job's question. A missing or failed reference
  never blocks the gate — the `abi` event says *omarchy: unavailable* and the
  base image alone decides.
- **OPR provenance**: once a day (05:15 UTC) the brain reads
  `omacom/omarchy-pkgs` — one tree request, then one request per package
  whose PKGBUILD changed — and records whether each OPR recipe is Omarchy's
  own or synced from the AUR (`.omarchy/package.json`), the AUR commit it
  tracks and the last commit that touched it. The package page says which;
  the Status page's coverage section counts the AUR-synced recipes `stable`
  still serves — the number to drive to zero. `provenance` lines in the
  journal record each scan that changed something.
- **OSV**: the security job also asks OSV about what the served packages
  embed (Go modules, cargo-auditable crates — `GET /api/v1/security/components`;
  only packages indexed since the extractor learned to read build information
  carry them). Records are cached under the worker's `osv/` directory;
  `pkg-repo security --osv-cache DIR` by hand, omit the flag to skip OSV.
- **The audit** (the second agent, GOVERNANCE.md): every staged community
  build queues an `audit` task. A project worker takes it only when it
  was started with an agent key in its environment — `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY` or `XAI_API_KEY`, or a Claude
  subscription as `CLAUDE_CODE_OAUTH_TOKEN` (Claude Code in print mode, no
  tools; the worker installs it at start) (`pkg-repo work` adds
  the `audit` kind by itself then; `FACTORY_PROVIDER` picks among several
  keys, `FACTORY_MODEL` the model — defaults `claude-sonnet-5`, `gpt-5`,
  `gemini-3.6-flash`, `grok-4`; `FACTORY_REASONING=low` keeps a reasoning
  model's answers inside the budget — the Studio sets it, and a reply cut
  short is retried once with four times the budget). The Workers page
  shows the agent each worker reported. The report lands next to the evidence
  (`/api/v1/factory/tasks/<id>/artifacts/audit.md`) and the Review page
  shows the verdict; *waiting* in that column means no such worker is
  running. It is advice for the maintainer; nothing acts on it. A build
  approved or rejected before the audit ran cancels it.
- **New upstream versions** — two paths, one rule (evidence before review):
  - a package a contributor registered: once a day (05:45 UTC) the brain
    asks GitHub for each approved package's latest release and queues a
    community build from the approved PKGBUILD with `pkgver` moved to the
    tag (`bump:<task>@<tag>`, `updpkgsums` in the worker). The owner's
    worker has **14 days**; then any shared worker (`WORKER_SHARED=1`,
    anyone's) may build it. (A contributor's request is different: it lands in the
    shared queue at once — any shared worker, the best idle one first for
    three minutes, the owner's own native worker at any time — and a build asked for one
    worker — `worker` in `POST /factory/packages/<name>/build`, `pinned_to`
    on the task — waits for that worker only; revoking the worker frees it;
    the owner takes a queued build out with
    `DELETE /factory/packages/<name>/builds/<id>`.) A
    maintainer reviews the staged build like the first one. **30 days**
    without a build and the package is *unmaintained* (the pill on its
    owner's page, `bump` journal line): no more bumps until its owner builds again, or
    someone else requests the name and takes it over (the registration
    becomes theirs; the package stays served until their build is decided).
    A maintainer's `DELETE /factory/packages/<name>` is not that: it takes
    the package out of every ring with the registration, on the record;
  - there is no second path: the project's own recipes left the repository
    on 2026-09-17 (hey-cli and vi became registered packages); the daily
    bump above is the only one, and it never opens a pull request.
- **Contributors' builds** land in the `omarchy-factory-staging` bucket
  (`staging/<login>/<package>/<task>/`, lifecycle rule: 30 days), listed on
  the Review page with their PKGBUILD and log; the packages themselves are
  readable by maintainers (`GET /api/v1/factory/tasks/:id/artifacts/<file>`).
  Quotas per contributor: 10 tasks queued or building, 5 GB staged; a
  single PUT and a multipart upload honour the same cap. A package above
  90 MB goes up in 64 MB parts — from the community worker and from the
  project's review build alike (`pkg-repo`'s `stage_file`); a single body
  above 100 MB never reaches the pool, the edge answers 413 first
  (bitwarden's 144 MB review build failed three times that way on
  2026-09-17). The pool gives
  the space back on its own (`worker/src/staging.ts`): the packages of a
  build it is done with — superseded, rejected, failed for good, published,
  cancelled — go at that moment, their PKGBUILD, log, gate and audit stay
  (and are on the record); the weekly `gc` job drops everything past 30
  days, rows and objects together, so the quota never counts what the
  bucket's lifecycle rule already deleted. A contributor drops a build
  early with `DELETE /factory/tasks/<id>/artifacts` (refused while queued
  or leased, or while the project builds from it; a staged build is
  cancelled). A worker whose owner is at the quota fails the task at claim
  time, with the reason, instead of building into a 413; an upload the pool
  refuses is reported as the build's failure, the pool's answer as the
  reason. A contributor token (`omc_…`) or worker token (`omw_…`) is a random secret
  hashed in D1; revoke a worker with `DELETE /factory/workers/<id>` as its
  owner or as a maintainer (the Revoke button on the owner's page is the same
  door).
- **Tokens**: there is no shared worker secret. Every worker — each of the
  Studio's six, a droplet's, a contributor's — is a registration with its
  own `omw_` token; project trust is a maintainer's decision on that
  registration. The Studio's tokens live in `/srv/omarchy-pool/etc/*.env`
  on the host (`factory/host/register.sh` writes them); to rotate one,
  revoke the worker, blank its env file, run `register.sh` again,
  `docker compose up -d`.

## Costs

The month's cap is **US$ 50**, agreed with the sponsor on 2026-09-16 and
never to be raised (`src/cost.ts` `BUDGET_CAP_USD`); the guard pauses the
jobs that write at a projected US$ 40 and the report warns at US$ 25 — the
three lines every answer of `GET /api/v1/cost` carries as `lines_usd`, so
no page or workflow types them. What costs money on
Workers Paid is usage over the included quotas — above all D1 rows read
(25 B/month included, then US$ 0.001 per million) and rows written
(50 M/month included, then **US$ 1.00 per million**), then R2 storage
(US$ 0.015/GB after 10 GB; egress is free). The review of 2026-09-13 found
the overview re-scanning `release_packages` on every call (US$ 14 a day)
and every release copying its whole selection three times (index included).
What keeps the bill down:

- a release's summary is computed once and stored (`releases.package_count`,
  `bytes`, `sources`); the pool-wide aggregates that need the join are
  computed by the metrics snapshot every 30 minutes, not per request;
- a release is a **delta** (migration 0017): what a ring serves lives in
  `ring_packages`, a release writes only what it added and removed, and the
  full membership is written out only for a checkpoint — the first release
  of a ring, then every 24th, and any older release read by id. A sync that
  moves a hundred packages writes a hundred rows, not thirty thousand; GC
  drops the checkpoints and deltas nothing inside retention starts from.
  A diff (`/diff`, `pkg-repo diff`) is folded from the
  deltas between its two releases and writes nothing: until 2026-09-20 it
  compared full lists, and every release's parent was written out (65 k
  rows, deleted again by the next GC) the first time its diff was viewed
  — 1.45 M rows on 2026-09-19, a crawler following the dashboard's links.
  Neither membership table has a foreign key to `packages` (migration
  0035: the check scanned both tables, 259k rows, for every one of GC's
  deletes); what it guaranteed is kept by the code instead — GC asks the
  rings once more about each victim right before its object goes and
  every one of its deletes is conditional on the answer (a package a ring
  took back in between is left alone and counted, `taken_back_by_a_ring`),
  and a reconstruction refuses a release whose packages GC took rather
  than writing it short (`cannot be reconstructed: N of its packages were
  garbage-collected`; the diff answers 410 as for a pruned release).
  The delta is computed in SQL with the request's lists materialised once
  (CTEs): evaluated per row over a 32k-row ring, the first version took
  D1 past its CPU limit and every sync failed for three hours on
  2026-09-13 (the release row and its delta are one transaction since, so
  a failed attempt leaves nothing behind); a release on a 32k-row ring
  takes about 50 ms of D1 time now;
- the sync runs **every three hours, one task per architecture, one release
  per ring** — not one release per source per hour. With releases this
  cheap the interval could go back to hourly (`scheduler.ts` RULES); what
  an hourly sync still costs is the rows it reads to diff against upstream;
- a worker's heartbeat (its claim, every 30 s) is written only when it says
  something new — the task, a log chunk, the version, the agent and its
  probe, the kinds, the mode, the labels — or every three minutes, so the
  row stays younger than the ten the alive rule asks: an idle worker writes
  20 rows an hour, not 120 (eight workers wrote 20 k rows a day before
  2026-09-20). A contributor's `last_seen` moves once per ten minutes, not
  once per authenticated request;
- the security job posts its whole set every three hours (4.6 k advisories,
  8 k CVEs, 7.4 k matches), and the index writes only the rows that changed:
  every upsert's `DO UPDATE` carries a `WHERE` over the row's values, an
  EPSS score is kept to three decimals, and the prune that closes a run
  deletes by the run's own key set (the advisory ids and the `(sha256,
  advisory)` matches it posts), not by `updated_at` — a run that changed
  nothing writes nothing, where it wrote 290 k rows a day (2026-09-19). A
  prune without the keys (an older `pkg-repo`) is refused with a `security`
  warn line and deletes nothing: a contributor's worker on an old image
  leaves a stale match in place until a current worker runs the job.

**Watching it.** The brain estimates the month's bill <!-- estimate-cadence -->
from Cloudflare's own analytics — what was used so far, priced, plus the
*current* rate (the last day, scaled) for the days left, so a fix shows in
the next estimate instead of being averaged with the expensive days before
it (`src/cost.ts`; secret `CLOUDFLARE_ANALYTICS_TOKEN`, an API token with
*Account Analytics: Read* and *D1: Read*). The latest estimate is
`settings.cost_latest` — `GET /api/v1/cost` has the breakdown and Status's
*Estimated bill* tile shows the projection — and one `cost` journal line
a day (the first estimate at or after 06:00 UTC) keeps the history. That
line is also the day's report: the brain posts it as a comment on the *Cost report*
issue (#68) the moment it is written (`src/cost.ts` `postCostReport`, the
secret `GITHUB_REPORT_TOKEN` above) — GitHub e-mails it to whoever watches
the issue. `cost-report.yml` is the late fallback: GitHub's 06:45 UTC cron
starts it five or six hours late, it stays quiet when the day's number is
already on the issue (any comment since midnight whose first line is the
report's header — the same rule the brain skips by, whoever posted), and
otherwise reads the estimate from three hosts with backoff for about forty
minutes — on 2026-09-18 an edge rule answered the runner 403 on every try
and the issue went a day without its line — and posts it; a day no host
answers still gets a comment saying so, and a later dispatch fills the
number in. The run's colour: green means the comment is on the issue — a
projection at the warning line marks the comment ⚠️ and annotates the run,
nothing is broken; red means no estimate, or the comment failed. A post the
brain could not make is one `cost` journal line with status `warn`, and the
workflow still posts. Cloudflare's own budget notifications e-mail at
actual charges (*Notifications → Billing → Usage based billing*; the API
token cannot create or read them): the ones made on 2026-09-13 were US$ 10,
20 and 28, against the US$ 30 cap of the day — against the US$ 50 cap they
belong at 25, 40 and 48, the three lines less the day's margin.

**What the rows cost.** `wrangler d1 insights omarchy-repo --time-period 1d
--sort-by reads --limit 40` lists the queries by rows read — the one
measurement that matters, since D1 bills rows read (25 billion a month
included, then US$ 0.001 per million). On 2026-09-16 the pool read 414
million rows a day; the three biggest were the service status sorting every
rendered artifact to find the newest (an index now), the stats page
grouping every event ever recorded to find the latest per kind (a table
kept by a trigger now, `latest_events`), and the half-hourly snapshot
recounting the whole pool when nothing had changed (it reuses the previous
one now). The jobs' own reads were the next two, and they scale with how often the
gates run — promotion is attempted after every sync and every three hours
now: the ABI gate's dependency closure (`/api/v1/graph`) read the ring's
providers for every edge, 20–45 million rows a call, because the planner
probed `package_provides` through an automatic index on `declared`; the
plan is pinned (`CROSS JOIN … INDEXED BY`) and a call reads the ring once
plus the edges. A page of a release's manifests (what a render and a
health check page through, 500 at a time) started from the release's
members — all of them, sorted, per page, 73k rows for 500; it walks the
`(name, repo_arch, source)` index from the cursor now and asks per row
whether the package is in the release. And the ABI verdict of an
unchanged release stands for a day: an attempt three hours later does not
repeat it (`gate::abi_evidence_stands`); the health check, which is the
soak, runs every time. `test/graph.test.ts` measures both queries' rows
read, so a planner regression fails CI. The same trap in a smaller query
was the largest reader of all once the pages had readers: on 2026-09-19,
the morning after the domain moved, Google's crawler followed every
package link and fetched `/api/v1/package/<name>` 25 thousand times a day
(the pages are skeletons; the script fetches the rows), and the package
page's one lookup of its providers in the ring — a list of names `IN`
the ring's members — walked the whole ring per call: 64.8 k rows for
ffmpeg's 94 providers, 1.6 billion rows a day, 84 % of the day's reads,
US$ 1.6 a day past the included 25 billion. The Security page's *fixed
elsewhere* lookup had the same shape (65 k rows a call, 35 million a day).
Both are driven from the names now (`CROSS JOIN` through the name index,
then a point lookup on the ring's key: 377 and 1.4 k rows), the package
answer stays at the edge ten minutes instead of one, and
`test/package-page.test.ts` bounds both by the names asked for.

**Who uses it.** Once a day (00:30 UTC) the brain counts yesterday's
audience from the same analytics: the distinct client addresses that
fetched a ring database (`/<source>/<arch>/omarchy-*-<ring>.db`) on the pool's
hosts — both names, one query, so a machine that used both in a day is
one address — per ring and per architecture, as one `audience` journal line
(`src/audience.ts`); `/api/v1/stats` carries the last 30 days (no page
draws them since the Pool's redesign, #243). Nothing is kept
per request — one number per day. An address is a machine most of the
time (a NAT hides several, a laptop on the move counts twice), so the
dashboard says *about*. The query is scoped to the account
(`CLOUDFLARE_ACCOUNT_ID`), so the analytics token must carry *Account ·
Analytics · Read*; without it the day is skipped and the scheduler log says
so once a day.

**Crawlers.** A package page is a database read (its API answer), so a
crawler that walks every package name is a bill: on 2026-09-19 one AI
crawler (GoogleOther) fetched ~6,000 pages an hour across the zone's
names — about a fifth of it on `pkgs.omarchy-pool.org` — and read the
rings' membership 25,000 times a day. Three layers keep that off the
bill. The Worker serves `/robots.txt` on every name (`src/pages/robots.ts`):
the dashboard's keeps the landing, the docs and `/package/<name>` open to
search engines, closes `/api/`, `/auth/`, `/diff`, `/build/`, `/user/`,
`/worker/`, `/workers` and the rest to everyone, and closes the whole site to the AI and research
crawlers by name (`AI_CRAWLERS`, `src/meta.ts` — the read guard below
sheds the same list); the API names deny
everything; `/sitemap.xml` lists the fixed pages. Every `/api/v1` answer
and the sign-in carry `x-robots-tag: noindex, nofollow`, a worker's page
and `/workers` (each names a worker's owner and its host's label)
`x-robots-tag: noindex`, and the header's
Sign in link says `rel="nofollow"` (19,800 crawler fetches of `/auth/github`
in two days came from that one link). The bucket runs no code: its
`robots.txt` is an object at the root of `omarchy-packages`
(`User-agent: *` / `Disallow: /`, `npx wrangler r2 object put
omarchy-packages/robots.txt --file robots-pool.txt --content-type
text/plain`). robots.txt is a request; the wall is a WAF custom rule on the
zone (*Security → WAF → Custom rules*, free plan): "AI crawlers off the
package pages", a Block for a request whose `cf.verified_bot_category` is
"AI Crawler" or whose user agent names one of the crawlers, on `/package/`,
`/api/v1/package/` and `/auth/`. Bot Fight Mode and AI Labyrinth stay
**off** on this zone: on 2026-09-18 they injected challenges into pacman,
omarchy-cli and broker responses and answered the cost report with 403.
Cloudflare prepends its own content-signals comment to any origin
robots.txt while its managed robots.txt is on (*Security → Bots → Manage
AI bots*); the rules below it still hold.

**The guard.** Three lines (`src/cost.ts`): the report warns at a
projected US$ 25; at a projected or actual **US$ 40** the brain sets
`settings.cost_guard` and the scheduler stops creating the jobs that write
(sync, promote, render, security, enqueue) until an estimate — the next is
at most three hours away — is back under the line; **US$ 50** is the
month's cap, agreed with the sponsor, never to be raised. Health, gc and
metrics keep running, the pool keeps serving. The same setting closes the
read side (`readGuard`, the same file): while it is up, an anonymous machine
— no `omc` session, no bearer token, and a user-agent that is empty, an AI
crawler's (`AI_CRAWLERS`) or not a browser's, or a Cloudflare-verified bot
that is not a search engine's crawler — asking `GET /package/<name>` or
`GET /api/v1/package/<name>` gets a 503 with `retry-after: 3600`, no
database read and nothing stored at the edge; people, signed-in readers,
search engines, `omarchy-cli/`, `pkg-repo/`, `omarchy-broker/` and
`pacman/` read on, and the file list, the graph, the search and every other
address stay open. The crawl of 2026-09-19–20 (GoogleOther, 1.6 B rows a
day) was reads, which the write pause did not touch. The Worker reads the
setting once a minute per isolate, so lifting it takes up to a minute to
show. The header of every page says so. To lift it by hand:
`npx wrangler d1 execute omarchy-repo --remote --command "DELETE FROM settings WHERE key = 'cost_guard'"`.

## Known limits

* **D1 under a bulk import.** Importing a whole repository (thousands of
  manifests with file lists) makes the index the bottleneck: reads can hit
  D1's per-query CPU limit ("exceeded its CPU time limit and was reset") and
  `wrangler d1 migrations apply` in a release can fail on it — re-run the job.
  pacman is never affected (packages and databases are static objects on R2);
  the dashboard shows the index as *degraded* on its status pill. GET responses
  of the API are cached at the edge for their `max-age` (a minute for stats
  and search, ten minutes for a package page, half an hour for security), so
  viewers do not multiply the load; the pages poll every 60–120 s and retry
  transient errors.
* **The Studio's own `compose.yml` is the host's.** A release that adds a
  service needs the one-time kind of step again (*Once: the updater*).
  Releases keep behaviour in the image, and only topology in that file.
* **A set whose updater is older than #277** follows at its own 15-minute
  round and cannot take Update. Its first round after #277 replaces it.
* **An updater that adopted a bad image before the guard existed** needs its
  owner: `omarchy-worker update` after a rollback.
* **A rollback past #277's last part takes the updaters back too.** Each one
  follows the pool's release down within two minutes, as it does a rollback
  to any release, and adopts the older updater without a self-test (that one
  has none). From then on its set follows at the fifteen-minute round and
  takes no Update, until a release brings an updater that follows again.

## Kill switch

```bash
cd worker && npx wrangler secret put JOB_TOKEN_SECRET   # a new value: every job token in flight stops working
# then set JOB_KINDS = "" in wrangler.toml and deploy: the scheduler queues nothing
```

Reads keep working (static objects); workers find no work and their tokens
buy nothing. Revoke a single worker with `DELETE /factory/workers/<id>`.

The pool's own orders to its workers (#277) have a switch of their own:
`WORKER_RULES = "off"` in `wrangler.toml` (and deploy). The pool then issues
no automatic re-check or restart; people's orders from a worker's page still
work.

## Reset (ephemeral by design)

Everything is reproducible from `main` plus the secrets; a full rebuild from the
mirrors takes a few hours.

```bash
cd worker
npx wrangler d1 execute omarchy-repo --remote --command "DELETE FROM release_artifacts; DELETE FROM ring_heads; DELETE FROM release_packages; DELETE FROM releases; DELETE FROM package_files; DELETE FROM package_requires; DELETE FROM package_provides; DELETE FROM package_file_lists; DELETE FROM packages; DELETE FROM events; DELETE FROM sqlite_sequence;"
# optionally empty the bucket (objects are re-uploaded by the next sync, or kept and re-indexed)
pkg-repo job sync --param arch=x86_64 && pkg-repo job sync --param arch=aarch64
```

## Rotate the signing key

The private key lives only in the Worker secret `SIGNING_KEY` (armored
OpenPGP; `SIGNING_KEY_PASSPHRASE` when it has one). Generate it on a
trusted machine, pipe it straight into the secret and keep no copy:

```bash
export GNUPGHOME=~/.cache/omarchy-cli-poc/gnupg
gpg --batch --quiet --passphrase '' --quick-generate-key "Omarchy Staging Signing <staging@firemanxbr.org>" ed25519 sign 1y
KEY=$(gpg --list-keys --with-colons staging@firemanxbr.org | awk -F: '/^fpr/{print $10; exit}')   # newest
gpg --armor --export "$KEY" > docs/omarchy-staging.pub.asc
cd worker
gpg --batch --armor --export-secret-keys "$KEY" | npx wrangler secret put SIGNING_KEY
npx wrangler r2 object put omarchy-packages/omarchy-staging.pub.asc --file ../docs/omarchy-staging.pub.asc --remote
cd .. && gpg --batch --yes --delete-secret-keys "$KEY"   # the Worker is the only holder
curl -s https://pkgs.omarchy-pool.org/api/v1/signing-key | jq .fingerprint   # the new key
for ring in edge rc stable; do for arch in x86_64 aarch64; do pkg-repo render --ring $ring --arch $arch; done; done
```

Clients must import the new public key (`pacman-key --add … && --lsign-key`).
Packages the factory built under the old key keep their signatures — those
verify against the old public key until each package is rebuilt (a
`POST /pool/:sha256/sign` per stored object re-signs them with the new one).

## Add a source or an architecture

A source is one row of `SYNC_SOURCES` in `worker/src/scheduler.ts`: source
name, arch, **ring** (`edge` — every source enters there and promotion
carries it forward; no source is synced straight into `rc` or `stable`), the directory
holding the `.db`, the db name, the keyring `tests/fetch-keyrings.sh`
produces, and the sources it defers to (`chaotic` defers to
`core,extra,multilib,packages,factory`: a name one of them serves is never
imported from chaotic-aur). Add the same source to `EXPECTED_SOURCES` in
`worker/src/meta.ts` (with `optional: true` for a repo users opt into on
*Get started*) and to the sources table on *How it works*. If it is a new
upstream project, add its keyring to `tests/fetch-keyrings.sh`. A new
architecture also needs an image in `tests/images.env`, a worker of that
architecture and the arch lists in `scheduler.ts` (`jobsOf`) and
`jobs.ts`.
