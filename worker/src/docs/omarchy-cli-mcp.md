# omarchy-cli as an MCP server

`omarchy-cli mcp` serves the client's answers as tools over the Model Context
Protocol (stdio transport: one JSON-RPC 2.0 message per line on stdin and
stdout), so an assistant running on the machine can reason about the ring
and the system without shelling out and parsing text. Everything is
**read-only** — the tools answer, they never install, upgrade or pin.

## The tools today

| Tool | Arguments | Answers |
|---|---|---|
| `status` | — | the ring, the pinned release, the head the ring serves now, how many installed packages come from it, the pending updates |
| `check` | `targets: string[]` | the plan (install / upgrade per package), the ABI findings against this system's libraries (`safe`, blockers = symbol versions it cannot satisfy), the libalpm hooks pacman would run |
| `info` | `package` | the manifest as the ring publishes it: version, description, dependencies, provides, ABI needs, embedded libraries, size, checksum, mirror URL, the release, and `seal` — where the object came from and the proof (the factory chain with audit, approval and attestation, or the upstream project and keyring) |
| `search` | `query` | packages whose name or description contains it |
| `list` | — | installed packages the ring also serves, each `current`, `update` or `ahead` |
| `security` | — | installed packages with an open advisory (severity, CVEs, exploited in the wild, EPSS) and whether an upgrade from the ring fixes each |

The shapes are exactly what `omarchy-cli <command> --json` prints; every
tool result carries them as `structuredContent` and, pretty-printed, as
text. Errors (a package not in the ring, the pool unreachable) come back as
tool results with `isError`, never as protocol errors, so the session goes on.

## Connect it

Register it the way the assistant expects a stdio server, for example:

```json
{ "mcpServers": { "omarchy": { "command": "omarchy-cli", "args": ["mcp"] } } }
```

`--ring`, `--api`, `--arch` and `--root` before `mcp` apply to every tool of the
session, as they do to any command; the config file
([`omarchy-cli.config.toml`](omarchy-cli.config.toml)) supplies the rest.

## Proposed: write tools (draft, needs sign-off)

> **Draft.** Nothing in this section is built. It is the design for
> [issue #252](https://github.com/firemanxbr/omarchy-pool/issues/252), written
> so a maintainer can sign off on its scope and its auth before any code is
> written. Until then every tool above stays read-only, and no endpoint marked
> *new* below exists.

The v1.0 design gives the other two roles their own tools. A contributor's
agent requests a package and follows it. A maintainer's agent claims a
package that is ready, reads what the factory did, and drafts a verdict.
The person decides. Approve, reject and block are drafted by the agent and
confirmed by the person in a browser, outside the agent.

The design keeps three things from the pool as it is. The server holds every
rule, so an agent that skips the MCP server and calls the API itself gains
nothing. Every write reuses the handler the web already calls, with the same
predicate and the same words when it refuses. And every read a tool makes
is an indexed lookup or a public answer the edge caches. Two reads are
neither today, a person's workers and the text evidence of a build; the
proposal changes both (*Limits and cost*).

### Six tools for two roles

| Tool | Role | Input | Answers |
|---|---|---|---|
| `request_package` | contribute | `url`, `description`, `license`, `checklist` (the four confirmations, each `true`); optional `name`, `arches`, `source`, `version` | the registration, the request's record and signature, the builds it queued |
| `request_status` | contribute | optional `name` | with a name: the package's word, its builds per architecture (queued with a place, building, staged, failed), its review and the rings that serve it; without one: your requests, and your drafts with where each stands |
| `review_claim` | maintain | `task`; optional `worker` (a project review worker, whose agent drafts the rebuild) and `note` (kept for people, never a hint to the project's agent) | the project's build queued from it, and where it runs |
| `review_context` | maintain | `task` | the request as checked, the recipe (`PKGBUILD`), the gate (`vet.json`), the audit, and the build, test and trial logs (the last 64 KB of each), for the contributor's build and the project's rebuild — never a package |
| `submit_review` | maintain | `task`, `verdict` (`approve`, `request_changes` or `reject`), `note` | a draft: its id, the link the person opens to confirm it, when it expires |
| `block` | maintain | `name`, `reason` | a draft, as `submit_review` answers one |

Four of them call a door the web already uses. Two call one new route.

| Tool | Worker route | Today |
|---|---|---|
| `request_package` | `POST /api/v1/factory/packages` | existing: the request form's own door and checks |
| `request_status` | `GET /api/v1/factory/packages/:name/story`, or `GET /api/v1/factory/me` without a name | existing; the story is public and stays 30 s at the edge; `/factory/me` would list your drafts too |
| `review_claim` | `POST /api/v1/factory/tasks/:id/build` | existing: "Build it by the project" on Review; the tool takes the task it is given and never reads the Review list |
| `review_context` | `GET /api/v1/factory/tasks/:id` and `GET /api/v1/factory/tasks/:id/artifacts/<file>` | existing, public, read without the token; the text evidence gains a tail read and the edge cache |
| `submit_review` | `POST /api/v1/factory/drafts` | new |
| `block` | `POST /api/v1/factory/drafts` | new |

Each tool declares an `outputSchema` and carries its answer as
`structuredContent`, as the read-only tools do. The two reads say
`readOnlyHint`. `submit_review` and `block` say `destructiveHint`, for what
their confirmation does, so an agent's host asks the person before the call
even though the call only drafts. `tools/list` shows a write tool only when
the machine's credential holds its scope. A machine that never ran
`omarchy-cli login` keeps the six read-only tools, and the end-to-end check
that lists them ([tests/e2e-client.sh](../tests/e2e-client.sh)) holds as it is.

`submit_review`, as the agent would see it:

```json
{
  "name": "submit_review",
  "description": "Drafts a verdict on a build you may decide. It decides nothing: the answer is a link the person opens in a browser signed in with GitHub, and only their confirmation there decides. Approve takes the project's build (the task review_claim returned).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "task": { "type": "integer", "minimum": 1 },
      "verdict": { "enum": ["approve", "request_changes", "reject"] },
      "note": { "type": "string", "minLength": 4, "maxLength": 500 }
    },
    "required": ["task", "verdict", "note"],
    "additionalProperties": false
  },
  "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": true }
}
```

and what it answers:

```json
{
  "draft": "d_5b1e0c9a4f7d2e8b6a3c1f0e9d8b7a6c",
  "state": "waiting",
  "verdict": "approve",
  "package": "my-app",
  "task": 612,
  "confirm_url": "https://omarchy-pool.org/auth/confirm/d_5b1e0c9a4f7d2e8b6a3c1f0e9d8b7a6c",
  "expires_at": "2026-10-02T14:30:00Z",
  "next": "Open the link in a browser signed in as bob and confirm. Nothing is decided until then."
}
```

`request_changes` is what reject does today: the build is cancelled, the
note goes to the requester, and the name stays theirs. `reject` frees the
name, the v1.0 review's meaning. It comes with #247; until then the tool
offers `approve` and `request_changes` only.

### Who the agent acts as

The agent acts as one GitHub login, through a token that login granted to it.
The grant is made in the person's own browser, signed in with GitHub, and its
code goes from the pool to the person's own command, never the other way.

- **Login.** `omarchy-cli login --agent "Claude Code"` (add `--maintain` for
  the review scopes) listens on `127.0.0.1`, on a port the system picks, and
  opens the browser at `https://omarchy-pool.org/auth/agent` with the agent's
  name, the scopes, the port, a `state` and a PKCE challenge (RFC 7636, S256).
  The person, signed in with GitHub, reads what is asked — the agent's name,
  the scopes, the expiry — and presses Grant, a form posted with the session
  cookie, checked by its `Origin` and a nonce the page wrote into it. The pool
  sends the browser to `http://127.0.0.1:<port>/` with a one-time code; the
  command checks the `state` and swaps the code and its verifier for the
  token at `POST /auth/agent/token`. This is the loopback flow of RFC 8252,
  with the pool's own sign-in as the identity: the login is the one GitHub
  told the pool at sign-in. The page takes a port, not an address, and builds
  the loopback address itself. The code lives a minute, is taken once, and is
  worth nothing without the verifier, which never leaves the command. So a
  Grant link somebody else sends lands its code on the person's own machine,
  where the sender's command is not listening.
- **A machine without a browser** (a server over SSH). `omarchy-cli login
  --agent "Claude Code" --paste` asks for a code instead. The person opens
  `/auth/agent` in any browser signed in with GitHub, names the agent, picks
  the scopes and presses Grant; the page shows a one-time code, 128 random
  bits that live ten minutes and are taken once, to paste into the command.
  The page says what the code is: whoever pastes it first gets the token, so
  it goes into the person's own terminal and nowhere else. The grant keeps
  the city and country the code was taken from, and the person's page shows
  them beside the grant, marked when they differ from where Grant was pressed.
- **The token.** `oma_` and 192 random bits, handed to the command once and
  kept by the pool as a SHA-256 hash, like the contributor and worker tokens.
  New table `agent_grants`: the login, the agent's name, the scopes, the
  one-time code's hash and the challenge until the token is taken, created,
  expires, revoked, last used (moved once per ten minutes, as `last_seen` is),
  where Grant was pressed and where the code was taken. One read by a unique
  index per call — what an `omc_` token costs today.
- **Scopes.** `contribute`: `request_package`, `request_status`. `review`:
  `review_claim`, `submit_review`, and `review_context` (which reads public
  answers without the token; the scope only lists it). `block`: `block`. The
  last two are granted to a maintainer only, and the role is read again on every
  call: a login taken out of `factory/MAINTAINERS.toml` loses them at its
  next call, not at its next login.
- **Expiry.** Thirty days by default, ninety at most. Logging in again with the
  same agent name replaces that grant. A login holds three live grants at
  most; a fourth is refused at Grant until one is revoked or expires. The
  limits below count by the login, so a new grant or another agent name
  starts no new count.
- **Revocation.** `omarchy-cli logout` revokes the grant on the server, then
  deletes the file. The person's page lists their grants, each with Revoke. A
  contributor a maintainer blocks loses their grants with their workers.
- **Where it lives.** `~/.config/omarchy-cli/credentials.toml`, mode 0600, with
  the API origin it was granted by. Never in `/etc/omarchy-cli/config.toml`,
  which is the machine's, and never sent to another origin: an `--api` that
  points elsewhere gets no token.

**Why not the contributor token, `omc_`.** It does everything its person may,
decisions included. It never expires, and there is one per person, which the
command line and worker registration already use. An agent holding it could
approve. The pool's rule is that a credential is worth one job
([security model](../SECURITY.md#principles)); an agent's token is worth the
six tools.

**Why not a device flow.** In a device flow (RFC 8628; GitHub's is one) the
command starts the grant and prints a code, and the person types it into a
page. Anybody can start one on their own machine and send a maintainer the
real address and the code with a pretext; a maintainer who types it grants
the sender's command a token for the maintainer's login (RFC 8628, section
5.4, remote phishing). That the code is typed, never carried in a link, does
not help. Both ways above start in the person's signed-in browser, so there
is no code of somebody else's to type. A device flow also needs an anonymous
door that writes: its start stores a pending code before anyone has proved
who they are, and its polling reads that code every few seconds.

**The server holds the line, not the MCP server.** An agent with a shell can read
the credentials file and call the API itself. So every limit is the Worker's:
an `oma_` token is taken by the routes in the table above and refused
everywhere else, with 403 and "an agent token may not approve" — approve,
reject, withdraw, block, unblock, trust, token, record withdrawal.
`contributorOf` never takes it; a new `agentOf(request, env, scope)` does,
only on the routes that name the scope.

**The agent's name is recorded twice.** The grant's name is the one the person
gave at login or on the grant page, and read there before Grant: what the
person says the agent is.
The client's own name and version from MCP's `initialize` travel on every call
as `x-omarchy-client`: what the agent says it is. Both are recorded; only the
first is the person's word. Both are escaped wherever a page shows them.

### The agent drafts, the person confirms

1. The agent calls `submit_review` or `block`. The server checks the scope and
   the role, then runs the predicate the web runs — `decisions()` in
   [routes/review.ts](../worker/src/routes/review.ts) for a verdict, the rules
   in [routes/blocks.ts](../worker/src/routes/blocks.ts) for a block — and
   refuses the way the web refuses. The requester is told "you brought my-app
   — another maintainer decides" (403), with `code: "conflict_of_interest"` so
   an agent can say it plainly. A build that is not staged is a 409.
2. Nothing is decided. The server stores a draft — new table `drafts`: an
   unguessable id, the grant, the login, the agent, the verdict and the note,
   the task or the name, a digest of the facts it was drafted on, created, and
   expires thirty minutes later — writes a journal line, and answers the link
   `https://omarchy-pool.org/auth/confirm/<id>`.
3. The agent shows the link. The person opens it in a browser signed in with
   GitHub as the same login. The page shows the package, the verdict, the
   note, the pool's own evidence (the gate, the audit, the trial, the logs),
   and who drafted it with which agent. For reject and block, the person types
   the package's name.
4. Confirm posts the form with the session cookie. The server reads the draft
   by its id and checks that it is this person's and still waiting. It runs
   the predicate again on the facts of now: a build decided in the meantime
   is refused, with the reason, and the draft says so. Then it spends the
   draft before anything is decided —
   `UPDATE drafts SET used_at = now WHERE id = ? AND login = ? AND used_at IS NULL AND expires_at > now`
   — and goes on only when that changed one row. A second confirm of the same
   draft, a double click or a retried request, changes none and is answered
   409, "confirmed already". Only then does it call the handler the web calls
   — `handleApprove`, `handleReject` or `handleBlockPackage` — with the draft
   attached. Those handlers read, then insert, with no guard of their own
   against a second call, so the spend comes first: one draft decides once.
5. `request_status` shows each draft: waiting, confirmed (with the decision),
   discarded or expired.

**Why a link, not a code.** A code shown in the browser and typed back into
the agent makes the agent's call the last act, and the code passes through
the agent on its way. With the link, the last act is always a POST that
carries the browser session: an HttpOnly cookie on the dashboard's origin,
which no agent token opens. `/auth/confirm/<id>` reads the cookie and nothing
else, refuses a request with an `Authorization` header, checks the `Origin`,
and takes a nonce the page wrote into its own form. `/auth/` is already closed
to crawlers (robots.txt), and the page says `noindex` as well.

**What it cannot tell apart.** An agent that drives the person's own signed-in
browser. Where that matters, confirm can also ask for a passkey with user
verification (WebAuthn): a touch the agent cannot make. That is a question
below.

**Not MCP elicitation.** The protocol lets a server ask the person a question
through the agent's client (`elicitation/create`). The answer comes back
through the agent's software, so it can show the link, never be the
confirmation.

`review_claim` and `request_package` are not confirmed this way; the issue
names approve, reject and block. A claim decides nothing: the project builds
the package again, and a maintainer still decides on that build. Nor may a
claim through an agent steer that build: its note is kept for people and
never becomes the hint the project's agent drafts with (*What the server
enforces*). A request is the person's own; the four confirmations are passed
by the agent after it asks the person, and the record says they came through
an agent.

### Signed and journaled

- **Named.** Every write through an agent carries `via: { agent, client, grant }`
  into the row it writes, its record and its journal line. New nullable
  columns: `package_requests.agent` and `approvals.agent`. A block carries it
  on its draft, its record and its line; a claim in the project build's
  params, beside `by`.
- **Journaled.** The line names the person and the agent: "my-app 1.2.0
  requested by alice through Claude Code"; "my-app 1.2.0 approved by bob —
  drafted by Claude Code, confirmed in the browser". The kinds stay the
  journal's own: request, review, approve, block. A draft writes a review line
  as well, so a draft nobody confirmed is on the record too.
- **Signed.** The pool signs what it writes, as it does now
  ([record.ts](../worker/src/record.ts)). The request's `request.json`, signed
  already, gains the `via` fields. A confirmed decision writes
  `factory/<name>/<request>/decision-<time>.json`, signed, with the maintainer,
  the agent, the draft, and when it was drafted and confirmed. That includes
  approve and reject, which write no record today.

### Limits and cost

- **Bursts.** Two rate limiting bindings on the Worker (Cloudflare's;
  `wrangler.toml` has none today). One is keyed by the login: twenty calls a
  minute that carry an `oma_` token, reads and writes alike, however many
  grants the login holds. The other is keyed by `cf-connecting-ip` and guards
  the one route open without a credential, `POST /auth/agent/token`: five
  tries a minute per address. Neither writes a D1 row. The address's limit
  is checked before anything is read; the login's once the grant is read,
  the one read every call makes, so a call over it costs that row and
  nothing more.
- **Per day, per person.** Five requests, ten claims, thirty drafts for each
  login, across all its grants and agent names. The counts live in the
  person's `contributors` row (new columns: the day and the three counts),
  not in a grant's, so logging in again or naming another agent starts no
  new count. A conditional update on the primary key moves the count before
  the write; when it changes no row, the write is not made and the answer is
  429 with `retry-after`. A write the handler then refuses has still counted,
  so an agent that loops on a refusal stops at the cap.
- **The route without a credential.** `POST /auth/agent/token` writes only a
  row a signed-in person made: the pending code is stored at Grant, in the
  grant's own row, by a form posted with the session. The swap is one
  conditional update through the unique index on the code's hash — the token
  is set only where the code matches, has not expired, was not taken, and
  (loopback) the verifier hashes to the challenge. A wrong code reads one
  index entry and writes nothing. There is no polling to pace. A code nobody
  took is deleted by the person's next Grant, and by the weekly gc through a
  partial index on its expiry.
- **The cost guard.** Today the guard stops the scheduler's jobs that write
  and sheds the anonymous machine reads of package pages
  ([cost.ts](../worker/src/cost.ts)); no route a person writes through checks
  it. An agent's writes should stop with the pool's: `agentOf` refuses a write
  while `settings.cost_guard` is set, with 503 and an hour's `retry-after` as
  the read guard answers, and reads the guard through the read guard's
  one-minute memo (`guardWord`), so the check costs no row. The contributor's
  quotas (ten builds queued, the staging space) apply to an agent as they do
  to the person.
- **`request_status` with a name** reads the story, public and 30 s at the
  edge: a hit, or the story's own reads once per 30 s per data centre.
- **`request_status` without one** reads `/factory/me`, no-store, with the
  token: four reads by the owner today, and one of them scans. The workers
  query filters `build_workers` on `owner`, which has no index, so it reads
  every worker ever registered, revoked ones too. The proposal's migration
  adds `idx_build_workers_owner ON build_workers (owner, last_seen)`; with the
  drafts by `(login, created_at)` it is then five indexed reads. The command
  answers a repeat within a minute from memory.
- **`review_claim`** reads what the web's button reads: the grant (unique
  index), the task (primary key), the web's predicate (`factsOf`: five
  indexed reads, one of them the package's story) and the package (primary
  key). It writes the project's build, the package's line, the journal line
  and the day's count. It takes the task it is given and never reads
  `GET /factory/review`: that list is the caller's own and no-store, and its
  main query reads up to a hundred staged builds, each with lookups of audit
  and trial tasks that grow with every audit and trial ever run — the
  heaviest read Review has, and an agent that claims in a loop would make it
  every time. An agent finds a build the way a person does: the public
  package list (`staged_builds`, 30 s at the edge), the package's story, or
  the Review page the person has open.
- **`review_context`** reads two tasks, public and 30 s at the edge, and the
  text evidence each lists. That evidence is not cached today:
  `handleStagingGet` answers no-store, and every file costs one D1 read
  through the index on `task_id` and one R2 GET of the whole object, on every
  call. The proposal changes the handler for text evidence only.
  `?tail=<bytes>` (64 KB at most) reads the object's last bytes as a ranged
  R2 get, so a log's tail is not the whole log. And a text answer says
  `public, max-age=30`, so the edge keeps it as it keeps the task. A package
  stays no-store and for maintainers only: the edge keys by the URL alone,
  so it may keep only what anyone may read. A call is then an edge hit per
  file, or one D1 row and a 64 KB read on a miss, and the command answers the
  same task again within a minute from memory.
- **New queries.** A grant by its token's hash (unique index); a pending grant
  by its code's hash (unique index), and expired ones by their expiry
  (partial index, where no token was taken); a login's live grants by
  `(login, created_at)`, three at most; a draft by its id (primary key); a
  person's drafts by `(login, created_at)`, twenty at most; the day's counts
  by the `contributors` primary key; a person's workers by
  `(owner, last_seen)`. Nothing scans, nothing fans out per row.

### What the server enforces

- **No self-review.** The requester cannot claim, draft or confirm a decision
  on their own package: the web's predicate, the web's words.
- **Evidence is not the product.** Approve takes the project's rebuild only; a
  contributor's build is refused, as the web refuses it.
- **Confirmation.** Approve, request changes, reject and block need the person
  in the browser. No route decides on an agent's token. A draft is spent
  before its handler runs, so it decides once.
- **Block.** Any maintainer, with a reason of four characters or more. Lifting
  it is another maintainer's act, on the web.
- **No hint from an agent.** The project's agent drafts its recipe with
  `params.hint` in the prompt, as "a hint from the person who asked for this
  build" (`factory/bin/draft-pkgbuild`); on the web, "Build it by the
  project" makes the maintainer's note that hint. A claim made with an `oma_`
  token keeps its `note` in the project build's params, for people, and
  leaves `hint` null: text that passed through an agent, which may have read
  the requester's instructions, is not the maintainer's word, and it must not
  reach the build the project approves and publishes. A maintainer who wants
  to give the project's agent a hint presses the button on the web.
- **Untrusted text.** `review_context` returns what the requester and their
  build wrote: the description, the recipe, the logs. That text can carry
  instructions aimed at the maintainer's agent. The tool marks it as the
  requester's text, and the confirm page shows the pool's own evidence rather
  than the agent's summary, so a verdict never rests on the agent's reading
  alone. Nor can that text reach the project's rebuild through the agent: a
  claim's note is never the hint (above).

### Where it changes

- `crates/omarchy-cli`: `login` (the loopback listener on `127.0.0.1` with
  its `state` and PKCE verifier, and `--paste`) and `logout`; the credentials
  file, 0600 and bound to its origin; an authenticated client in `api.rs` for
  the writes and `/factory/me`, while public reads stay anonymous; the six
  tools in `mcp.rs`, listed by scope, with a minute's memory of what they
  read. The `instructions` from `initialize` say that reads are open, that
  writes act as the login through the named agent, and that decisions wait
  for the person.
- `worker/`: a migration for `agent_grants` (with the pending code in the
  grant's row), `drafts`, the two `agent` columns, the day's counts on
  `contributors`, and `idx_build_workers_owner`; two rate limiting bindings in
  `wrangler.toml`; the grant flow in `routes/auth.ts` (the page at
  `/auth/agent` and its Grant, posted with the session; `POST /auth/agent/token`,
  the one route open without a credential); `agentOf` in `auth.ts`, with the
  cost guard's check; `POST /api/v1/factory/drafts` and
  `GET /api/v1/factory/drafts/:id`; the drafts in `/factory/me`; no hint on an
  agent's claim in `handleProjectBuild`; the tail read and the edge cache of
  text evidence in `handleStagingGet`; the confirm page at
  `/auth/confirm/<id>`, which spends a draft before it decides; the expired
  codes in the weekly gc; the grants on the person's page; the API page's
  *Write (people)* section.

### Tests

The Rust side, in `mcp.rs` and the credentials module, clean under
`cargo clippy --workspace --all-targets -- -D warnings` (the workspace's
pedantic lints) and `cargo fmt --all --check`:

- `tools/list`: no credential lists the six read-only tools in today's order; a
  contributor's adds `request_package` and `request_status`; a maintainer's
  lists all twelve.
- Bad arguments never reach the network, as today: no URL, a confirmation not
  `true`, a verdict outside the three, a note under four characters, a block
  without a reason.
- Every tool against a one-thread HTTP server on `127.0.0.1`, the pattern of
  the tests in [crates/pkg-repo/src/client.rs](../crates/pkg-repo/src/client.rs):
  the method, path and body sent; the token on writes and on `/factory/me`,
  never on a public read. `review_context` asks for text evidence only — no
  path ending in `.pkg.tar.zst`, even when the task lists one.
  `submit_review` and `block` call `/factory/drafts` only; the test server
  fails the test on `/approve`, `/reject` or `/block`. A 403 with
  `conflict_of_interest`, a 409 and a 429 come back as `isError` results in
  the server's words.
- The credentials file: written 0600; a file others can read is refused; an
  expired grant says "run omarchy-cli login" without a request; the token is
  never sent to another origin.
- Login: the listener binds `127.0.0.1` only and takes one request; a
  callback with another `state` is refused; the verifier goes to the pool's
  origin only, in the swap, never in the browser's address.

The Worker's side, in vitest on the fixture:

- An `oma_` token is refused on every route outside its list — a table over the
  decision routes — and `contributorOf` never takes it.
- `review` and `block` are refused to a contributor, at the grant and on use,
  and to a login removed from `factory/MAINTAINERS.toml`, on its next call.
- Grant takes the session only (a bearer token is refused), with its `Origin`
  and nonce, and sends the code to `127.0.0.1` only, whatever the link
  asked. A code is swapped once, not after it expires, and not without
  the verifier that matches its challenge; a wrong code writes no row. A
  fourth live grant is refused.
- A draft from the requester is refused with the web's reason. Confirm takes
  the session only (a bearer token is refused), the same login only, once
  only, and not after it expires; it runs the predicate again. Two confirms
  of one draft sent at once make one approval, one publish job and one
  journal line; the second is answered 409. The decision's row, record and
  journal line carry the agent.
- A claim with an `oma_` token leaves `params.hint` null and keeps its note
  in `params.note`; the same note through the web's button is still the hint.
- Logout, Revoke on the person's page and a contributor's block each end a
  grant at once.
- The limits answer 429. The address's limit reads no D1 row, the login's
  reads the grant only. The day's counts are the login's: a new grant, or
  another agent name, does not start them again.
- With the cost guard up, an agent's write is answered 503 and a person's
  write on the web is not.
- Text evidence answers `public, max-age=30` and `?tail=` gives its last
  bytes; a package in staging is still no-store and for maintainers only.
- Every new query, and `/factory/me`'s workers, is asked for its plan
  (`EXPLAIN QUERY PLAN`, as [releases.test.ts](../worker/test/releases.test.ts)
  does): a search through an index, never a scan.

### Questions for the maintainers

1. **Scope.** Are these six tools the first set? Should `submit_review` wait for
   #247's `reject` that frees the name, or ship with `approve` and
   `request_changes` first?
2. **Identity.** The pool's own grant, made in the signed-in browser and handed
   to the command through a loopback address with PKCE, or pasted where the
   machine has no browser? The alternative is a device flow, the pool's or
   GitHub's (the GitHub token read once, as `POST /factory/register` reads
   one today). A device flow is started by the command, so a maintainer can
   be sent somebody else's code to type (RFC 8628, section 5.4), and its
   start and polling are a door without a credential that writes to D1. The
   design takes the loopback flow for that. Is the paste fallback needed at
   all, or can a machine without a browser wait?
3. **Expiry.** Thirty days by default, ninety at most. Shorter for `review` and
   `block`?
4. **Confirmation.** The session link, with the name typed for reject and block.
   Should approve and block also ask for a passkey now, or later?
5. **Requests.** Should `request_package` go through the confirm link too? The
   four confirmations are the person's word.
6. **Drafts.** On the public journal as they are made, or on the person's page
   only until they are confirmed?
7. **Limits.** Twenty calls a minute per login; five requests, ten claims and
   thirty drafts a day per person, across all their agents; three live grants
   per login; five token swaps a minute per address. Are these the right
   numbers?
8. **Signatures.** The pool's signature on every record, as today — or the
   person's own as well, with a key they publish on GitHub?
9. **Order.** Once a package is one name across its architectures (#242), the
   tools take `name` where they take `task` now. Build them after #242 and
   #247, so they ship in their final shape?
10. **Releasing a claim.** #247 lets a maintainer release a claim. Add a
    `review_release` tool, or leave that to the web?
