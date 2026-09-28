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
predicate and the same words when it refuses. And every new read is one
indexed lookup, or a public answer the edge already caches.

### Six tools for two roles

| Tool | Role | Input | Answers |
|---|---|---|---|
| `request_package` | contribute | `url`, `description`, `license`, `checklist` (the four confirmations, each `true`); optional `name`, `arches`, `source`, `version` | the registration, the request's record and signature, the builds it queued |
| `request_status` | contribute | optional `name` | with a name: the package's word, its builds per architecture (queued with a place, building, staged, failed), its review and the rings that serve it; without one: your requests, and your drafts with where each stands |
| `review_claim` | maintain | optional `task` (else the oldest build that waits and that you may take); optional `worker` (a project review worker, whose agent drafts the rebuild) and `note` | the project's build queued from it, and where it runs |
| `review_context` | maintain | `task` | the request as checked, the recipe (`PKGBUILD`), the gate (`vet.json`), the audit, and the build, test and trial logs (the last 64 KB of each), for the contributor's build and the project's rebuild — never a package |
| `submit_review` | maintain | `task`, `verdict` (`approve`, `request_changes` or `reject`), `note` | a draft: its id, the link the person opens to confirm it, when it expires |
| `block` | maintain | `name`, `reason` | a draft, as `submit_review` answers one |

Four of them call a door the web already uses. Two call one new route.

| Tool | Worker route | Today |
|---|---|---|
| `request_package` | `POST /api/v1/factory/packages` | existing: the request form's own door and checks |
| `request_status` | `GET /api/v1/factory/packages/:name/story`, or `GET /api/v1/factory/me` without a name | existing; the story is public and stays 30 s at the edge; `/factory/me` would list your drafts too |
| `review_claim` | `GET /api/v1/factory/review` to pick one, then `POST /api/v1/factory/tasks/:id/build` | existing: "Build it by the project" on Review |
| `review_context` | `GET /api/v1/factory/tasks/:id` and `GET /api/v1/factory/tasks/:id/artifacts/<file>` | existing, public, read without the token |
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

- **Login.** `omarchy-cli login --agent "Claude Code"` (add `--maintain` for
  the review scopes) asks the pool for a grant and prints a short code and an
  address, `https://omarchy-pool.org/auth/agent`. The person opens it in a
  browser signed in with GitHub, types the code, reads what is asked — the
  agent's name, the scopes, the expiry, and the city and country the request
  came from — and presses Grant. The command, polling, receives the token.
  This is the device flow people know from GitHub, with the pool's own
  sign-in as the identity: the login is the one GitHub told the pool at
  sign-in. The code is typed, never carried in the link, and lives ten
  minutes, so a link sent by somebody else grants nothing.
- **The token.** `oma_` and 192 random bits, handed to the command once and
  kept by the pool as a SHA-256 hash, like the contributor and worker tokens.
  New table `agent_grants`: the login, the agent's name, the scopes, created,
  expires, revoked, last used (moved once per ten minutes, as `last_seen` is).
  One read by a unique index per call — what an `omc_` token costs today.
- **Scopes.** `contribute`: `request_package`, `request_status`. `review`:
  `review_claim`, `submit_review`, and `review_context` (which reads public
  answers without the token; the scope only lists it). `block`: `block`. The
  last two are granted to a maintainer only, and the role is read again on every
  call: a login taken out of `factory/MAINTAINERS.toml` loses them at its
  next call, not at its next login.
- **Expiry.** Thirty days by default, ninety at most. Logging in again with the
  same agent name replaces that grant.
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

**The server holds the line, not the MCP server.** An agent with a shell can read
the credentials file and call the API itself. So every limit is the Worker's:
an `oma_` token is taken by the routes in the table above and refused
everywhere else, with 403 and "an agent token may not approve" — approve,
reject, withdraw, block, unblock, trust, token, record withdrawal.
`contributorOf` never takes it; a new `agentOf(request, env, scope)` does,
only on the routes that name the scope.

**The agent's name is recorded twice.** The grant's name is the one the person
typed at login and read on the grant page: what the person says the agent is.
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
4. Confirm posts the form with the session cookie. The server checks that the
   draft is this person's, unused and not expired. It runs the predicate again
   on the facts of now: a build decided in the meantime is refused, with the
   reason. Then it calls the handler the web calls — `handleApprove`,
   `handleReject` or `handleBlockPackage` — with the draft attached. A
   conditional update uses the draft once.
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
the package again, and a maintainer still decides on that build. A request is
the person's own; the four confirmations are passed by the agent after it
asks the person, and the record says they came through an agent.

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

- **Bursts.** Cloudflare's rate limiting binding on the Worker, keyed by the
  grant: ten writes a minute. It reads and writes no D1 row.
- **Per day, per grant.** Five requests, ten claims, thirty drafts. The count is
  kept in the grant's own row and moved by a conditional update in the same
  batch as the write: one primary-key write per agent write. Past it, 429 with
  `retry-after`.
- **What stays.** The contributor's quotas (ten builds queued, the staging
  space) and the cost guard's pause on writes apply to an agent as they do to
  the person.
- **Reads.** `review_context` and `request_status` with a name read public
  answers without the token, so the edge serves them (a task and a story stay
  30 s there): an agent that polls costs what a page view costs. Without the
  token a maintainer's read cannot fetch a package either — the server keeps
  packages in staging for maintainers. `request_status` without a name reads
  `/factory/me`, four indexed reads and no-store; the command answers a
  repeat within a minute from memory.
- **New queries.** A grant by its token's hash (unique index), a draft by its id
  (primary key), a person's drafts by `(login, created_at)` with a limit of
  twenty. Nothing scans, nothing fans out per row.

### What the server enforces

- **No self-review.** The requester cannot claim, draft or confirm a decision
  on their own package: the web's predicate, the web's words.
- **Evidence is not the product.** Approve takes the project's rebuild only; a
  contributor's build is refused, as the web refuses it.
- **Confirmation.** Approve, request changes, reject and block need the person
  in the browser. No route decides on an agent's token.
- **Block.** Any maintainer, with a reason of four characters or more. Lifting
  it is another maintainer's act, on the web.
- **Untrusted text.** `review_context` returns what the requester and their
  build wrote: the description, the recipe, the logs. That text can carry
  instructions aimed at the maintainer's agent. The tool marks it as the
  requester's text, and the confirm page shows the pool's own evidence rather
  than the agent's summary, so a verdict never rests on the agent's reading
  alone.

### Where it changes

- `crates/omarchy-cli`: `login` and `logout`; the credentials file, 0600 and
  bound to its origin; an authenticated client in `api.rs` for the writes and
  `/factory/me`, while public reads stay anonymous; the six tools in `mcp.rs`,
  listed by scope. The `instructions` from `initialize` say that reads are
  open, that writes act as the login through the named agent, and that
  decisions wait for the person.
- `worker/`: a migration for `agent_grants`, `drafts` and the two `agent`
  columns; the grant flow in `routes/auth.ts` (`POST /auth/agent`,
  `POST /auth/agent/token`, the page at `/auth/agent`); `agentOf` in
  `auth.ts`; `POST /api/v1/factory/drafts` and `GET /api/v1/factory/drafts/:id`;
  the drafts in `/factory/me`; the confirm page at `/auth/confirm/<id>`; the
  grants on the person's page; the API page's *Write (people)* section.

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

The Worker's side, in vitest on the fixture:

- An `oma_` token is refused on every route outside its list — a table over the
  decision routes — and `contributorOf` never takes it.
- `review` and `block` are refused to a contributor, at the grant and on use,
  and to a login removed from `factory/MAINTAINERS.toml`, on its next call.
- A draft from the requester is refused with the web's reason. Confirm takes
  the session only (a bearer token is refused), the same login only, once
  only, and not after it expires; it runs the predicate again. The decision's
  row, record and journal line carry the agent.
- Logout, Revoke on the person's page and a contributor's block each end a
  grant at once.
- The limits answer 429, and the burst limit reads no D1 row.

### Questions for the maintainers

1. **Scope.** Are these six tools the first set? Should `submit_review` wait for
   #247's `reject` that frees the name, or ship with `approve` and
   `request_changes` first?
2. **Identity.** The pool's own grant, confirmed in the signed-in browser — or
   GitHub's device flow, with the GitHub token read once, as
   `POST /factory/register` reads one today?
3. **Expiry.** Thirty days by default, ninety at most. Shorter for `review` and
   `block`?
4. **Confirmation.** The session link, with the name typed for reject and block.
   Should approve and block also ask for a passkey now, or later?
5. **Requests.** Should `request_package` go through the confirm link too? The
   four confirmations are the person's word.
6. **Drafts.** On the public journal as they are made, or on the person's page
   only until they are confirmed?
7. **Limits.** Ten writes a minute; five requests, ten claims and thirty drafts
   a day per grant. Are these the right numbers?
8. **Signatures.** The pool's signature on every record, as today — or the
   person's own as well, with a key they publish on GitHub?
9. **Order.** Once a package is one name across its architectures (#242), the
   tools take `name` where they take `task` now. Build them after #242 and
   #247, so they ship in their final shape?
10. **Releasing a claim.** #247 lets a maintainer release a claim. Add a
    `review_release` tool, or leave that to the web?
