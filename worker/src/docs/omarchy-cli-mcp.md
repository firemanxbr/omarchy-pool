# omarchy-cli as an MCP server

`omarchy-cli mcp` serves the client's answers as tools over the Model Context
Protocol (stdio transport: one JSON-RPC 2.0 message per line on stdin and
stdout), so an assistant running on the machine can reason about the ring
and the system without shelling out and parsing text. The six tools below
are **read-only** — they answer, they never install, upgrade or pin. After
`omarchy-cli login`, the person's agent also gets the write tools its grant
holds (*Write tools*, below): it requests and follows packages for a
contributor, and claims, reads and drafts verdicts for a maintainer, who
confirms every decision in the browser.

## The read-only tools

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
{ "mcpServers": { "omarchy-pool": { "command": "omarchy-cli", "args": ["mcp"] } } }
```

`--ring`, `--api`, `--arch` and `--root` before `mcp` apply to every tool of the
session, as they do to any command; the config file
([`omarchy-cli.config.toml`](omarchy-cli.config.toml)) supplies the rest.

## Write tools

The v1.0 design gives the other two roles their own tools
([issue #252](https://github.com/firemanxbr/omarchy-pool/issues/252); a
maintainer signed off on the scope and the auth on 2026-09-29, *Signed off*,
below). A contributor's agent requests a package and follows it. A
maintainer's agent claims a package that is ready, reads what the factory
did, drafts a verdict, and lets go of a claim it will not finish. The person
decides: approve, request changes, reject and block are drafted by the agent
and confirmed by the person in a browser, outside the agent — approve and
block with a passkey
([#257](https://github.com/firemanxbr/omarchy-pool/issues/257), *A passkey
for approve and block*, below), as the web's own Approve and Block are
([#271](https://github.com/firemanxbr/omarchy-pool/issues/271)).

The design keeps three things from the pool as it is. The server holds every
rule, so an agent that skips the MCP server and calls the API itself gains
nothing. Every write reuses the handler the web already calls, with the same
predicate and the same words when it refuses. And every read a tool makes
is an indexed lookup or a public answer the edge caches (*Limits and cost*).

### Seven tools for two roles

| Tool | Role | Input | Answers |
|---|---|---|---|
| `request_package` | contribute | `url`, `description`, `license`, `checklist` (the four confirmations, each `true`); optional `name`, `arches`, `source`, `version` | the registration, the request's record and signature, the builds it queued |
| `request_status` | contribute | optional `name` | with a name: the package's word, its builds per architecture (queued with a place, building, staged, failed), its review and the rings that serve it; without one: your requests, your builds, and your agents' drafts with where each stands |
| `review_claim` | maintain | `name`; optional `worker` (a project review worker, whose agent drafts the rebuild) and `note` (kept for people, never a hint to the project's agent) | the project's rebuild queued from it, and where it runs |
| `review_release` | maintain | `name`, `reason` (four characters or more, on the record) | the claim let go: the project's rebuild cancelled, who had claimed it, and the package ready to be claimed again |
| `review_context` | maintain | `name` | the request as checked, the recipe (`PKGBUILD`), the gate (`vet.json` and its summary), the audit, and the build, test and trial logs (the last 64 KB of each), for the contributor's build and the project's rebuild — never a package |
| `submit_review` | maintain | `name`, `verdict` (`approve`, `request_changes` or `reject`), `note` | a draft: its id, the link the person opens to confirm it, when it expires |
| `block` | maintain | `name`, `reason` | a draft, as `submit_review` answers one |

Four of them call a door the web already uses; `submit_review` and `block`
call the drafts' route; `review_context` and a named `request_status` read
public answers without the token.

| Tool | Worker route | Scope |
|---|---|---|
| `request_package` | `POST /api/v1/factory/packages`: the request form's own door and checks | `contribute` |
| `request_status` | `GET /api/v1/factory/packages/:name/story` (public, 30 s at the edge), or `GET /api/v1/factory/me` without a name (the caller's own, no-store) | `contribute` for `/factory/me` |
| `review_claim` | `POST /api/v1/factory/tasks/:id/build`: "Build it by the project" on Review | `review` |
| `review_release` | `POST /api/v1/factory/tasks/:id/release` (#247): the `release` verdict of `decisions()` | `review` |
| `review_context` | `GET /api/v1/factory/tasks/:id` and `GET /api/v1/factory/tasks/:id/artifacts/<file>?tail=65536`: public, text evidence only | none (read without the token) |
| `submit_review` | `POST /api/v1/factory/drafts` `{name, task, verdict, note}` | `review` |
| `block` | `POST /api/v1/factory/drafts` `{name, verdict: "block", note}` | `block` |

**By name.** #242 made a package one name across its architectures, with one
review for all of them. The routes #247 gives a claim and a release still take
a task — one of the package's builds — and decide the package it is a build
of. So every tool takes the package's `name`, and the command finds the
build the way a person does, in the package's public story (edge-cached):
the contributor's staged build a claim is on, the claim's rebuild a release
lets go, the project's rebuild an approval is on, and the project's staged
rebuild — else the contributor's build — that changes or a rejection are on.
The story only picks the build; it never stops a call. The edge keeps it up
to 30 seconds, so a story that shows no build ready for a claim still sends
the newest contributor's build, and an approval while the story shows the
rebuild running goes to the rebuild: the pool, which holds the rule on the
facts of now, takes it or says why not in its own words. After a write, the
command reads the story past the edge cache for a minute and a half
(`?t=`), as the web's pages do after the person's own act, so the next tool
picks its build on facts from after the write. Only a story with no build at
all is answered by the command, and it says the story is the edge's. A
draft carries both the name and the build; the Worker checks that the build
is one of that name's and runs the predicate on it.

Each write tool declares an `outputSchema` and carries its answer as
`structuredContent`, as the read-only tools do. The two reads say
`readOnlyHint`. `submit_review` and `block` say `destructiveHint`, for what
their confirmation does, so an agent's host asks the person before the call
even though the call only drafts. `review_release` says it too: it stops a
rebuild that may be running. `tools/list` shows a write tool only when the
machine's credential holds its scope, for this API's origin. A machine that
never ran `omarchy-cli login` keeps the six read-only tools, and the
end-to-end check that lists them ([tests/e2e-client.sh](../tests/e2e-client.sh))
holds as it is.

`submit_review`, as the agent sees it:

```json
{
  "name": "submit_review",
  "description": "Drafts a verdict on a package you may decide. It decides nothing: the answer is a link the person opens in a browser signed in with GitHub, and only their confirmation there decides (approve asks for their passkey, reject for the package's name typed). Approve takes the project's rebuild (the one review_claim queued); request_changes stops the round and keeps the name the requester's; reject frees the name.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "pattern": "^[a-z0-9@._+-]+$" },
      "verdict": { "enum": ["approve", "request_changes", "reject"] },
      "note": { "type": "string", "minLength": 4, "maxLength": 500 }
    },
    "required": ["name", "verdict", "note"],
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
  "name": "my-app",
  "task": 1234,
  "confirm_url": "https://omarchy-pool.org/auth/confirm/d_5b1e0c9a4f7d2e8b6a3c1f0e9d8b7a6c",
  "expires_at": "2026-10-02T14:30:00.000Z",
  "next": "Open the link in a browser signed in as bob and confirm with your passkey: your device asks for your fingerprint, face or PIN. Nothing is decided until then."
}
```

`next` is what the agent tells its person. For approve and block it names
the passkey the confirmation asks for (*A passkey for approve and block*,
below); a login that holds none yet is told so, with the address of the
Passkeys section of their page, before they open the link. Request changes
and reject say "Open the link … and confirm".

`submit_review` has the three verdicts of #247. `request_changes` stops the
round: the builds in review are cancelled, the note goes to the requester,
and the name stays theirs. `reject` stops it and frees the name.

**Releasing a claim.** A claim is the project's rebuild that "Build it by the
project" queued, and `review_release` lets it go, so another maintainer can
take the package. Its route is #247's, `POST /api/v1/factory/tasks/:id/release`,
and its rule is the `release` verdict in the web's predicate, `decisions()`,
so Review's Release button calls the same handler and reads the same words.
The maintainer who claimed it, or another maintainer, may release it; the
role is read again on the call. The requester may not, as they may not claim
it, and neither may a contributor. The release cancels every rebuild of the
claim with one conditional update, only while one of them is still queued or
leased, and goes on only when it changed a row: a claim whose rebuilds all
staged in the meantime, or a second release, is answered 409. A leased
worker's lease is void and what it staged goes. The package's line and the
journal line say whose claim was released, by whom, through which agent, and
why: "my-app 1.0 (x86_64): bob's claim released by alice through Claude Code —
away until Monday". A release is not confirmed through the link: it decides
nothing, and the package waits for a claim again. It counts toward the day's
ten claims (*Limits and cost*). The cancel door no longer stops a claim's
rebuild (#247), and an agent's token is refused there anyway.

### Who the agent acts as

The agent acts as one GitHub login, through a token that login granted to it.
The grant is made in the person's own browser, signed in with GitHub, and its
code goes from the pool to the person's own command, never the other way.

- **Login.** `omarchy-cli login --agent "Claude Code"` (add `--maintain` for
  the review scopes; `--no-browser` prints the address instead of opening
  it, for a browser on the same machine) listens on `127.0.0.1`, on a port
  the system picks, and opens the browser at `<api>/auth/agent` — the dashboard's
  `https://omarchy-pool.org/auth/agent` in production — with the agent's name,
  the scopes, the port, a `state` and a PKCE challenge (RFC 7636, S256). The
  person, signed in with GitHub, reads what is asked — the agent's name, the
  scopes, the expiry, the loopback address — and presses Grant, a form posted
  with the session cookie, checked by its `Origin` and a nonce the page wrote
  into it (an HMAC over the session and every field of the form, good for ten
  minutes, so showing the page writes no row). The pool sends the browser to
  `http://127.0.0.1:<port>/` with a one-time code and the `state`; the command
  checks the `state` and swaps the code and its verifier for the token at
  `POST /auth/agent/token`. This is the loopback flow of RFC 8252, with the
  pool's own sign-in as the identity: the login is the one GitHub told the
  pool at sign-in. The page takes a port, not an address, and builds the
  loopback address itself, whatever else the link carries. The code lives a
  minute, is taken once, and is worth nothing without the verifier, which
  never leaves the command but for the swap. So a Grant link somebody else
  sends lands its code on the person's own machine, where the sender's
  command is not listening. It is the only way in (*Signed off*, 2): the
  command needs a browser on the same machine. Deny sends the command an
  `access_denied` and writes nothing. The command waits ten minutes, as long
  as the form is good for, and takes one callback: the one that carries its
  own `state`. Anything else on the port is answered and the command waits
  on — a favicon or a connection that says nothing with 404, a callback with
  another `state` (a local process, a page probing `127.0.0.1`'s ports) with
  400 — so a stray request neither grants anything nor ends the login.
  Grant is counted per login at the edge, twenty a minute (the agents' rate
  limiting binding, a key of its own), so a page that loops Grant stops
  there.
- **The token.** `oma_` and 192 random bits, handed to the command once and
  kept by the pool as a SHA-256 hash, like the contributor and worker tokens.
  Table `agent_grants` (migration 0039): the login, the agent's name, the
  scopes, the one-time code's hash and the challenge until the token is taken,
  created, expires, revoked (and by what: a login, `logout`, `replaced`,
  `blocked`), and last used (moved once per ten minutes, as `last_seen` is).
  One read by a unique index per call, joined to the login's row by its
  primary key — what an `omc_` token costs.
- **Scopes.** `contribute`: `request_package`, `request_status`. `review`:
  `review_claim`, `review_release`, `submit_review`, and `review_context`
  (which reads public answers without the token; the scope only lists it).
  `block`: `block`. The last two are granted to a maintainer only, and the
  role is read again on every call: a login taken out of
  `factory/MAINTAINERS.toml` loses them at its next call (`maintainer_only`),
  not at its next login.
- **Expiry.** A `contribute` grant lives thirty days by default (`--days`),
  ninety at most. A grant that holds `review` or `block` lives seven days,
  whatever else it holds or the link asked: the scopes that reach a decision
  are granted again every week (*Signed off*, 3). Logging in again with the
  same agent name replaces that grant, at the swap: the new token is set and
  the old grant ends in one batch, so a login that never comes back (a
  closed command, a browser that cannot reach the loopback) leaves the old
  grant working. A login holds three live grants at most; a fourth is
  refused at Grant until one is revoked or expires. The limits below count by
  the login, so a new grant or another agent name starts no new count.
- **Agent names.** One line of 1 to 60 characters, printable: a control
  character, a format character (the bidirectional overrides that would turn
  the rest of a public journal line around, the zero-width ones that make two
  names look alike), a private-use character or half a surrogate pair is
  refused at the grant page. The name is escaped wherever a page shows it.
- **Revocation.** `omarchy-cli logout` revokes the grant on the server
  (`POST /auth/agent/revoke` with the token, always allowed), then deletes the
  file — only once the pool revoked it, or said it was no longer live
  (`grant_invalid`: revoked, replaced or expired). When the pool cannot be
  reached or refuses otherwise, the file stays, the command exits 1, and it
  says how to end the grant: run logout again, or Revoke on the page. The
  machine keeps one grant: `omarchy-cli login` refuses, before the browser
  opens, while the file holds a live grant the pool would not replace (one
  of another agent name, or from another pool), so no token is left live
  with nobody holding it; `logout` first. The person's page lists their
  grants, each with Revoke (`POST /api/v1/factory/grants/:id/revoke`, their
  own grants only): every live one first, read apart from the history, then
  the ten newest. A contributor a maintainer blocks loses their grants with
  their workers. However a grant ends — logout, Revoke, a replacement, a
  block — its waiting drafts are discarded in the same batch (*The agent
  drafts, the person confirms*).
- **Where it lives.** `~/.config/omarchy-cli/credentials.toml`
  (`$XDG_CONFIG_HOME` when set), mode 0600 from its first byte in a 0700
  directory, with the API origin it was granted by. A file others can read is
  refused, not used. Never `/etc/omarchy-cli/config.toml`, which is the
  machine's, and never sent to another origin: an `--api` that points
  elsewhere lists no write tool and sends no token.

**Why not the contributor token, `omc_`.** It does everything its person may,
decisions included. It never expires, and there is one per person, which the
command line and worker registration already use. An agent holding it could
approve. The pool's rule is that a credential is worth one job
([security model](../SECURITY.md#principles)); an agent's token is worth the
seven tools.

**Why not a device flow.** In a device flow (RFC 8628; GitHub's is one) the
command starts the grant and prints a code, and the person types it into a
page. Anybody can start one on their own machine and send a maintainer the
real address and the code with a pretext; a maintainer who types it grants
the sender's command a token for the maintainer's login (RFC 8628, section
5.4, remote phishing). That the code is typed, never carried in a link, does
not help. The login above starts in the person's signed-in browser, so there
is no code of somebody else's to type. A device flow also needs an anonymous
door that writes: its start stores a pending code before anyone has proved
who they are, and its polling reads that code every few seconds.

**The server holds the line, not the MCP server.** An agent with a shell can
read the credentials file and call the API itself. So every limit is the
Worker's: an `oma_` token is taken by the routes in the table above and
refused everywhere else, before anything is read — before the edge cache
is asked too, so the answer never depends on whether someone else read the
URL first — with 403,
`code: "agent_token"` and the act in its words — "an agent token may not
approve" — approve, reject, changes, withdraw, cancel, block, unblock, trust,
token, record withdrawal, adopt, and every read that is not the tools'.
`contributorOf` never takes it, whatever cookie comes with it; `agentOf(request,
env, scope)` does, only on the routes that name the scope.

**The agent's name is recorded twice.** The grant's name is the one the person
gave at login, read on the grant page before Grant: what the person says the
agent is. The client's own name and version from MCP's `initialize` travel on
every call as `x-omarchy-client`: what the agent says it is. Both are
recorded; only the first is the person's word. Both are escaped wherever a
page shows them.

### The agent drafts, the person confirms

1. The agent calls `submit_review` or `block`. The server checks the scope and
   the role, then runs the predicate the web runs — `decisions()` in
   [routes/review.ts](../worker/src/routes/review.ts) for a verdict, the rules
   in [routes/blocks.ts](../worker/src/routes/blocks.ts) for a block
   (`blockRefusal`, which the block's own door reads) — and refuses the way the
   web refuses. The requester is told "you brought my-app — another maintainer
   decides" (403), with `code: "conflict_of_interest"` so an agent can say it
   plainly. A build that is not staged is a 409.
2. Nothing is decided. The server stores a draft — table `drafts`: an
   unguessable id, the grant, the login, the agent and the client, the
   verdict and the note, the package's name and build, a digest of the facts
   it was drafted on, created, and expires thirty minutes later — and answers
   the link `https://omarchy-pool.org/auth/confirm/<id>`. It writes no journal
   line: until it is confirmed, a draft is shown on the person's own page only
   (*Signed off*, 6).
3. The agent shows the link. The person opens it in a browser signed in with
   GitHub as the same login; anyone else is told it is not theirs, and sees
   none of it. The page shows the package, the verdict, the note, the pool's
   own evidence of every architecture the decision covers — one review
   decides them all, so each architecture still in review: the contributor's
   build and the project's rebuild with their gates, the audit, the trial,
   the logs, and the Review workspace — and who drafted it with which agent.
   For reject and block, the person types the package's name. For approve
   and block, Confirm asks for the person's passkey (*A passkey for approve
   and block*, below); a person without one is told to register one, and is
   offered no Confirm.
4. Confirm posts the form with the session cookie. The server reads the draft
   by its id and checks that it is this person's and still waiting. For
   approve and block it verifies the passkey's answer before anything else
   about the draft, and refuses without one; nothing about the draft changes
   when the passkey is refused. It reads
   the draft's grant again, by its primary key: a draft whose agent was
   revoked since decides nothing. It runs the predicate again on the facts of
   now: a build decided in the meantime is refused, with the reason, and the
   draft says so (`refused`). And it compares the facts with the ones the
   draft was made on — the digest the draft keeps: the build, who brought
   it, the decisions and the claim on it, what is building or rebuilding,
   and where each architecture stands — so a package that moved in the
   meantime (an architecture rebuilt, staged or failed) is refused and asked
   for again, never confirmed on facts the agent never saw. Then it spends
   the draft before anything is decided —
   `UPDATE drafts SET used_at = now, state = 'confirmed' WHERE id = ? AND login = ? AND used_at IS NULL AND expires_at > now`
   — and goes on only when that changed one row. A second confirm of the same
   draft, a double click or a retried request, changes none and is answered
   409, "confirmed already". Only then does it call the handler the web calls
   — `handleApprove`, `handleChanges`, `handleReject` or `handleBlockPackage` —
   with the draft attached. Those handlers read, then insert, so the spend
   comes first: one draft decides once. Should the handler fail on the pool's
   side, the draft says what became of it: `refused` when nothing was
   decided, `confirmed` with what failed when the decision was taken first
   (its rows carry the draft) — never `confirmed` with nothing decided.
   Discard spends it the same way and decides nothing.
5. `request_status` and the person's own page show each draft: waiting,
   confirmed (with the decision), refused (with why), discarded (by the
   person, or with its grant) or expired. They read them from `/factory/me`,
   which is the person's own and no-store, so nobody else sees a draft;
   every waiting draft comes first, read apart from the history, so twenty
   newer ones never push it off the page.
6. A grant revoked — logout, Revoke on the page, a new login under the same
   name, a contributor's block — discards its waiting drafts in the batch
   that revokes it, with why: revoking an agent ends what it left behind.

**Why a link, not a code.** A code shown in the browser and typed back into
the agent makes the agent's call the last act, and the code passes through
the agent on its way. With the link, the last act is always a POST that
carries the browser session: an HttpOnly cookie on the dashboard's origin,
which no agent token opens. `/auth/confirm/<id>` reads the cookie and nothing
else, refuses a request with an `Authorization` header, checks the `Origin`,
and takes a nonce the page wrote into its own form (an HMAC over the session
and the draft). `/auth/` is closed to crawlers (robots.txt), and the page
says `noindex` and is never cached.

**What the session cannot tell apart.** An agent that drives the person's own
signed-in browser presses Confirm as well as the person does. What the
passkey closes, since #271 end to end, is the two decisions on a package
someone asked for: approve and block. An agent that holds its `oma_` token
cannot turn its own draft of approve or block into a decision; a session
driven by someone else cannot press the web's own Approve or Block, cannot
enrol a passkey of its own once the person holds one, and cannot remove the
person's; and no token of any kind — the agent's, a maintainer's `omc_` —
approves or blocks at all. Each of those needs an assertion with the user
verified on the person's authenticator (*A passkey for approve and block*,
below). Request changes and reject confirm with the session and, for
reject, the package's name typed (*Signed off*, 4): neither ships anything,
and both issues keep them as they were. Since #284 no door ships bytes
that no check and no approval passed without it: a build queued by hand is
a dry run, and a promotion forced past its evidence takes the maintainer's
passkey. A rollback keeps the session and the token: it points a ring at
an earlier release of its own (*The doors that ship*, below).

**Not MCP elicitation.** The protocol lets a server ask the person a question
through the agent's client (`elicitation/create`). The answer comes back
through the agent's software, so it can show the link, never be the
confirmation.

### A passkey for approve and block

[#257](https://github.com/firemanxbr/omarchy-pool/issues/257) and
[#271](https://github.com/firemanxbr/omarchy-pool/issues/271). Approve and
block — confirming an agent's draft of either, and the web's own buttons on
Review, a build's page and a package's page — need a WebAuthn assertion with
`userVerification: "required"`, verified by the Worker against the public
key the person registered. Without it nothing is decided, and a draft keeps
waiting. Adding a second passkey and removing one need an assertion from a
passkey the person holds; a person who lost their only one is reset by
another maintainer.

- **Registering one.** A maintainer adds a passkey in the *Passkeys* section
  of their own page (`/user/<login>#passkeys`, shown to them only; a link
  to that address lands on the section once it is drawn, and a contributor
  who holds no passkey is shown no section): a name for it, then the
  browser's own request. Their first passkey is added with the session
  alone — here, or from the notice or the dialog of the act that needs it
  (*None yet*, below); any other asks first for an assertion from one they
  hold (*Adding and removing*, below). The page asks the pool for the
  options (`POST /auth/passkeys/challenge`: this relying party, a user
  handle that is a hash, not the login, ES256, EdDSA and RS256, user
  verification required, attestation `none`, the passkeys they hold
  excluded), hands them to `navigator.credentials.create()`, and posts the
  answer (`POST /auth/passkeys`). The pool verifies it: `webauthn.create`,
  the challenge it issued to this login for a registration, the origin, the
  RP id's hash, the user present and verified, the credential's id, a key it
  takes. It stores the credential's id, the COSE public key as the
  authenticator wrote it, the algorithm, the RP id, the counter, the name and
  two dates — no attestation, no device name. Ten a login; a credential is
  registered once. Remove is the owner's, on the same page
  (`POST /auth/passkeys/<id>/remove`, with an assertion); another maintainer
  is told it is not theirs. The person's `/factory/me` lists their passkeys — the name, the
  algorithm, the dates, never the key — and the same answer to their agent
  (`request_status`) leaves them out.
- **Journaled.** A registration, a removal and a reset are journal lines of
  kind `passkey`: "m1 registered a passkey (ES256, pk_…)", "m1 removed a
  passkey (ES256, pk_…, registered 2026-09-29)", "m2 reset m1's passkeys (2
  removed; m1 signed out): lost the phone", with who, when, which passkey —
  and, since #271, which passkey vouched for it (`confirmed_with`) — never
  the key, the credential's id or the name the person gave it.
- **Confirming with it.** On a draft of approve or block, Confirm asks the pool
  for a challenge (`POST /auth/confirm/<id>/challenge`, with the session, the
  page's Origin and its nonce), hands it to `navigator.credentials.get()` with
  the person's passkeys and user verification required, and posts the answer
  with the form. Confirm is the form's first submit button, so Enter in the
  typed name confirms as a click does; Discard is never the default. A new
  challenge for the draft replaces the login's earlier one, so a prompt the
  person cancelled holds none of the five a login may have live. The page
  says each step in a status line a screen reader hears, and a failure in the
  person's words. The server takes the challenge first — issued to this login
  for this draft, five minutes old at most, deleted by the statement that
  reads it, so an answer is good for one request whatever that request
  decides — then the passkey by its credential, the login's own and for this
  relying party; then the assertion: `webauthn.get`, the challenge, the
  origin, not in a frame of another site, the RP id's hash, the user present
  and verified, a user handle that is the login's when one is returned, the
  signature over `authenticatorData ‖ SHA-256(clientDataJSON)` with the
  stored key, and the counter. A counter that did not move forward is a
  copy of the key and is refused, unless the authenticator keeps none (zero
  both times, as many synced passkeys); it moves in one conditional update.
  Then the typed name, the predicate and the spend, as before. The decision's
  `through` names the passkey (`through.passkey`), and its journal line says
  "confirmed in the browser with a passkey".
- **Without a passkey.** The draft's page says so — "Register a passkey
  first" — links to the registration, and offers Discard only. A POST without
  an answer is refused in the same words, with the same link, and the
  challenge route answers `code: "no_passkey"` with the link: there is no
  fallback to the session alone.
- **The web's own Approve and Block (#271).** Approve on Review and on a
  build's page (the shell's Decision cell), and Block on Review's brake — a
  contributor or a package — and on a package's page, go through one helper
  of the shell (`passkeyed`): it asks the pool for a challenge bound to this
  login and exactly this act (`POST /auth/passkeys/assert`,
  `{for: "approve:<task>"}`, `"block:package:<name>"` or
  `"block:contributor:<login>"`), hands it to `navigator.credentials.get()`
  with user verification required, and posts the act with the answer in its
  body (`assertion`: the confirm form's five fields). The handler runs its
  own predicate first — a contributor, the requester, a build decided
  already are refused in the words `can` gives, whatever the answer — then
  the passkey's half (`webGate`, routes/passkeys.ts): the browser's session
  only, its page's Origin, an address the relying party list names, and the
  assertion checked exactly as a draft's is (the challenge taken once, the
  passkey the login's own, the signature, the user verified, the counter).
  Each refusal is a 403 with a code — `passkey_required`, `no_passkey` (with
  the link to register one), `session_only`, `origin`, `rp_unavailable`,
  `challenge`, `not_yours`, or the verifier's own (`user_verified`,
  `signature`, `counter`, …) — ending "nothing was decided". The decision's
  record, its journal line and its answer name the passkey (`passkey`, where
  a draft's carry `through.passkey`). A handler called by a door that
  forgot the gate refuses (`decidedWith` fails closed).
- **None yet: guided, not stopped (#287).** A maintainer who holds no
  passkey is told before it matters: `/auth/me` says so to their pages
  (`passkey: false`, a maintainer's answer only), and a notice — what needs
  a passkey, that nothing else does, *Register a passkey now* — is drawn on
  Review and on their own page while they hold none, and once on the first
  page they see as a maintainer (the browser keeps that it was shown). The
  dialogs of approve, block and a forced promotion (and a reset's) offer
  *Register a passkey and approve* (… and block, … and force): the first
  press registers the passkey through the page's own two routes, with the
  session alone, and the dialog stays open; the next press asks for the
  challenge of exactly that act (`passkeyed`) and posts the act with the
  answer. One passkey request per press, as Safari wants it. A cancelled
  registration decides nothing, and the dialog says so. The decision's
  journal line says "… with a passkey registered just now" (and
  `registered_just_now: true`) when it is the passkey's first use within ten
  minutes of its registration. Nothing else a maintainer does asks for a
  passkey; `passkey-guided.test.ts` pins the list.
- **No token approves or blocks (#271).** A request that carries an
  `Authorization` header — a contributor's `omc_` token, a maintainer's
  included, or a script's — is refused on approve and block with
  `session_only`, after the act's own predicate: a passkey's assertion is a
  browser's ceremony, and the one door where it is made is the one that
  decides. The command line never had an approve or a block (the MCP tools
  draft); what changed is `curl` with a maintainer's token. Request changes,
  reject, withdraw, a lift and every other maintainer's act keep their
  doors as they were — a pool job by hand among them, a promotion forced
  past its evidence excepted (*The doors that ship*, below). Whether a non-browser
  path may ever approve again — a token with an assertion made by a local
  authenticator, say — is left open (*open-work.md*).
- **Adding and removing (#271).** A login that holds a passkey adds another
  only with an assertion from one it holds, for `passkey:add`, sent with the
  registration (`assertion`); the page asks for it first, then for the new
  authenticator — two prompts. The first passkey stays the session's alone,
  and the insert itself holds the rule: two first registrations sent at once
  store one. A removal needs an assertion for `passkey:remove:<id>` from a
  passkey the person holds — the one going, or another. Each refusal
  (`passkey_required`, `challenge`, `not_yours`, …) stores or removes
  nothing, and the journal names the passkey that vouched (`confirmed_with`).
- **A lost passkey (#271).** A maintainer who lost their only authenticator
  cannot remove it or add another. Another maintainer resets them from that
  person's page (*A lost passkey*, drawn for a maintainer on another
  maintainer's page): a reason (4 to 300 characters), then their own passkey,
  for `passkey:reset:<login>` (`POST /auth/passkeys/reset`,
  `{login, reason, assertion}`). Nobody resets their own — so a session that
  left with the lost device cannot open its own way back — and a login that
  holds none has nothing to reset, said before the resetting maintainer's
  device is asked. One batch writes the journal line (who, whose, why, which
  passkeys, the passkey that confirmed it), removes every passkey of the
  login and its challenges, and ends its browser session: a registration
  already under way on that session stores nothing, since the insert asks
  for the session and for the passkey that vouched, both still the login's.
  The same batch revokes what the lost device may hold beside them (#284):
  the login's `omc_` token (replaced by the hash of no token) and its
  agents' live grants (`revoked_by` `reset`), a journal line each, their
  waiting drafts discarded and a code nobody swapped yet deleted — all only
  while the login still holds a passkey, so two resets at once revoke once.
  The person makes a new token on their page after signing in, and grants
  their agents again. The pool then signs the record at
  `contributors/<login>/passkeys-reset-<time>.json` (who, why, which
  passkeys, when, the token and the grants revoked — nothing of the keys),
  whose address the lines name; a
  record the bucket refused is said in the answer and on a line of its own,
  the reset standing. The person signs in with GitHub again and adds a first
  passkey with the session alone. Two resets at once are one. It is never an
  operator's write to D1. The reset hands the passkey back to a sign-in with
  GitHub, so the resetting maintainer confirms the request out of band first,
  and the person ends the lost device's GitHub sessions before signing in
  (the runbook's *A lost passkey*).
- **The relying party.** One list, never the request's word: every production
  name is `omarchy-pool.org` (origin `https://omarchy-pool.org`, where the
  pages and the session live), and `localhost` on any port is itself, for
  `wrangler dev` and the tests. WebAuthn needs a secure context and takes no
  IP address, so a local preview is opened at `http://localhost:<port>`,
  with `wrangler dev --local-upstream localhost:<port> --upstream-protocol
  http` (wrangler otherwise hands the Worker the first route's name, and the
  browser's origin is not that). On any other address the page says passkeys
  work on `omarchy-pool.org` only, and nothing is confirmed there.
- **The verifier is the pool's own.** [webauthn.ts](../worker/src/webauthn.ts)
  checks what the Worker needs with WebCrypto: the CBOR authenticators write
  (definite lengths; no tags, floats or duplicate keys), COSE keys (ES256 on
  P-256, RS256 of 2048 bits or more for Windows Hello, EdDSA on Ed25519), the
  authenticator data, and the DER-to-raw conversion of an ECDSA signature.
  `@simplewebauthn/server` was weighed and left out: it imports
  `reflect-metadata`, a polyfill of the global `Reflect`, and an X.509 and
  ASN.1 stack for attestation chains the pool does not trust, some 300 KB
  minified in 25 packages beside the Worker's two.
- **The doors that ship (#284).** #271 left two doors that put bytes no
  check and no approval passed in a ring with the session or the `omc_`
  token alone, and #284 closes both. A
  build queued by hand (`POST /factory/enqueue`, a maintainer's session or
  token) is a dry run: `publish: false` is queued, built and measured, and
  its job token has no pool and no ring scope, so the worker keeps what it
  built; `publish` true or left out is refused with `dry_run_only`, and
  nothing is queued. A dry run is never the build of its version: the
  enqueue job's build of the same recipe is a task of its own. A build that publishes comes from the factory's enqueue job — its
  job token, issued to a project worker for a recipe on `main` — or from an
  approval, which takes a passkey. A promotion forced past its evidence and
  the gate (`POST /factory/jobs`, `promote` with `force: "yes"`) is
  confirmed the way approve is, through `webGate`: the browser's session,
  its page's Origin, an address the relying party list names, and an
  assertion for exactly that promotion
  (`promote:force:<from>:<to>[:<arch>]`) — a token of any kind is refused
  with `session_only`, each wrong answer with its code, ending "nothing was
  queued". The answer and the journal's `dispatch` line name the passkey.
  Status draws the button — *Force into rc* on edge's card, *Force into
  stable* on rc's — for a maintainer, and asks which architectures: both,
  or one. A promotion by evidence, a rollback and every other pool job keep
  the session and the token; around them the review of #284 closed three
  side doors. A rollback points a ring at an earlier release of its own —
  another ring's is refused (`another_ring`), since stable pointed at an
  edge release would be a forced promotion. The evidence the gate reads —
  health and ABI rows — is the jobs' alone: a maintainer's session or
  token writes a `note` to the journal and nothing else (`note_only`). And
  after a reset, `POST /factory/register` mints the login no token with a
  GitHub token (`token_reset`) until the person makes one on their page.
- **What it still cannot tell apart.** #257 left three gaps open — the web's
  own Approve and Block, adding a passkey and removing one took the session
  alone — and #271 closes the three together: a session driven by someone
  else decides nothing, enrols nothing and removes nothing once the person
  holds a passkey. What is left is the first passkey. It is the session's
  alone, so a session driven by someone else before the person registered
  one — or after a reset — can register one of its own, even one made in
  software: the pool asks for attestation `none`, so user verification is a
  flag the authenticator reports about itself. A reset narrows that window:
  it ends the person's browser session, so the first passkey after it is
  registered on a fresh sign-in with GitHub. Every registration, removal and
  reset is a line on the public journal, and the person's page lists their
  passkeys with their last use, so a key the person did not add is seen, and
  another maintainer resets it. A withdrawal takes an approved package out
  of every ring with the session or the `omc_` token alone, as before
  #271: it ships nothing, and it is on the journal.

`review_claim`, `review_release` and `request_package` are not confirmed this
way; the issue names approve, reject and block (*Signed off*, 5). A claim
decides nothing: the project builds the package again, and a maintainer
still decides on that build. Nor may a claim through an agent steer that
build: its note is kept for people and never becomes the hint the project's
agent drafts with (*What the server enforces*). A release decides nothing
either: the rebuild stops, and the package waits for a claim again. A
request is the person's own; the four confirmations are passed by the agent
after it asks the person, the record says they came through an agent, and
the day's five requests still hold.

### Signed and journaled

- **Named.** Every write through an agent carries who it came through into
  the row it writes, its record and its journal line. #247 already names the
  door (`via`: `web` or `token`) and the agent a rebuild ran (`agent`), so the
  agent a write came through is `through: { agent, client, grant }` beside
  them, and the door of a write the token made is `via: "agent"`. Columns
  `package_requests.agent` and `approvals.agent` (migration 0039) hold it as
  JSON; a decision's rows get it in the decision's own batch, and
  `GET /factory/approvals` and a person's decisions serve it parsed, as
  `through`, so `agent` there stays #247's word for the rebuild's agent. A
  block carries it on its draft, its record and its line; a claim in
  the project build's params, beside `by`; a release on the cancelled build's
  row (its `error` says who let it go through which agent) and its line.
- **Journaled.** The line names the person and the agent: "my-app 1.2.0
  requested by alice through Claude Code"; "my-app 1.2.0 (x86_64) approved by
  bob — drafted by Claude Code, confirmed in the browser". The kinds stay the
  journal's own: request, review, approve, block; a claim and a release are
  review lines. A draft writes no line: the public journal records decisions,
  not drafts (*Signed off*, 6). A confirmed draft's decision says
  `via: "web"` — the browser decided — and its `through` names the draft, and
  when it was drafted and confirmed; one nobody confirmed stays on the
  person's own page, as expired.
- **Signed.** The pool signs what it writes, as it does now
  ([record.ts](../worker/src/record.ts)). The request's `request.json` gains
  `via` and `through` when an agent made it. A confirmed decision is #247's
  record — `factory/<name>/<request>/decision-<time>-<word>-<id>.json`, signed,
  with the maintainer — and gains `through`: the agent, the grant, the draft,
  and when it was drafted and confirmed. The pool's signature is the one
  every record carries; a person's own, with a key they publish on GitHub,
  can come later (*Signed off*, 8). Approve and block confirmed with a
  passkey carry its id too, `through.passkey`, and the line says "confirmed
  in the browser with a passkey".

### Limits and cost

- **Bursts.** Two rate limiting bindings on the Worker (Cloudflare's, in
  `wrangler.toml`: `AGENT_CALLS` and `AGENT_SWAPS`). One is keyed by the
  login: twenty calls a minute that carry an `oma_` token, reads and writes
  alike, however many grants the login holds. The other is keyed by
  `cf-connecting-ip` and guards the one route open without a credential,
  `POST /auth/agent/token`: five tries a minute per address. Neither writes a
  D1 row. The address's limit is checked before anything is read; the
  login's once the grant is read, the one read every call makes, so a call
  over it costs that row and nothing more. Both answer 429 with
  `retry-after`.
- **Per day, per person.** Five requests, ten claims, thirty drafts for each
  login, across all its grants and agent names. A release counts as a claim:
  claiming and letting go share the ten, so an agent that claims and releases
  in a loop stops at the cap. The counts live in the person's `contributors`
  row (`agent_day` and the three counts), not in a grant's, so logging in
  again or naming another agent starts no new count. A conditional update on
  the primary key moves the count before the write; when it changes no row,
  the write is not made and the answer is 429 with `retry-after` (the seconds
  to the next UTC day) and `code: "day_limit"`. A write the handler then
  refuses has still counted, so an agent that loops on a refusal stops at the
  cap. A person's own writes on the web or with `omc_` are not counted.
- **The route without a credential.** `POST /auth/agent/token` writes only a
  row a signed-in person made: the pending code is stored at Grant, in the
  grant's own row, by a form posted with the session. The swap is one
  conditional update through the unique index on the code's hash — the token
  is set only where the code matches, has not expired, was not taken, and
  the verifier hashes to the challenge. A wrong code reads one index entry
  and writes nothing. There is no polling to pace. A code nobody took is
  deleted by the person's next Grant, and by the weekly gc through a partial
  index on its expiry.
- **The cost guard.** The guard stops the scheduler's jobs that write and
  sheds the anonymous machine reads of package pages
  ([cost.ts](../worker/src/cost.ts)). An agent's writes stop with the pool's:
  `agentOf` refuses a write while `settings.cost_guard` is set, with 503,
  `code: "cost_guard"` and an hour's `retry-after` as the read guard answers,
  and reads the guard through the read guard's one-minute memo, so the check
  costs no row. A person's writes on the web are not stopped by it. The
  contributor's quotas (ten builds queued, the staging space) apply to an
  agent as they do to the person.
- **`request_status` with a name** reads the story, public and 30 s at the
  edge: a hit, or the story's own reads once per 30 s per data centre.
- **`request_status` without one** reads `/factory/me`, no-store, with the
  token: the person's registrations, workers, builds and staging, their
  grants and their drafts. The workers are read through
  `idx_build_workers_owner ON build_workers (owner, last_seen)` (migration
  0039; before it the query read every worker ever registered, revoked ones
  too); the live grants through the partial index of live grants, three at
  most, and the ten newest by `(login, created_at)`; the waiting drafts by
  the range of `(login, created_at)` over the last half hour, and the twenty
  newest. The command answers a repeat within a minute from memory, and
  keeps a read no longer than its minute.
- **`review_claim`** reads the story (public, at the edge) to find the build,
  then what the web's button reads: the grant (unique index), the task
  (primary key), the web's predicate (`factsOf`: indexed reads, one of them
  the package's story) and the package (primary key). It writes the
  project's build, the package's line, the journal line, the record and the
  day's count. It never reads `GET /factory/review`: that list is the
  caller's own and no-store, and its main query reads up to a hundred staged
  builds, each with lookups of audit and trial tasks — the heaviest read
  Review has, and an agent that claims in a loop would make it every time.
- **`review_release`** reads what a claim reads, then the claim's own rows by
  their primary keys, for who made it. It writes the cancel (one conditional
  update), the package's line, the journal line, the record and the day's
  count; for a leased rebuild, it also removes what the worker staged, found
  through the index on `task_id`.
- **`review_context`** reads two tasks, public and 30 s at the edge, and the
  text evidence each lists. Text evidence answers `public, max-age=30`, so
  the edge keeps it as it keeps the task, and `?tail=<bytes>` (64 KB at most)
  reads the object's last bytes as a ranged R2 get, so a log's tail is not the
  whole log. A package stays no-store and for maintainers only: the edge keys
  by the URL alone, so it may keep only what anyone may read. A call is then
  an edge hit per file, or one D1 row and a 64 KB read on a miss, and the
  command answers the same task again within a minute from memory.
- **New queries.** A grant by its token's hash (unique index); a pending grant
  by its code's hash (unique index), expired ones by their expiry and a
  login's own by the login (partial indexes, where no token was taken); a
  login's live grants — the three-grant count at Grant, the same-name
  replacement at the swap, the person's page — through a partial index on
  `(login, expires_at)` that holds only swapped, unrevoked grants, three rows
  at most however long the history of revoked and replaced ones grows; a
  grant by its id (primary key) for Revoke and the confirm; a contributor's
  block by `(login, created_at)`; a draft by its id (primary key); a
  person's drafts by `(login, created_at)`, twenty at most, and the waiting
  ones — the ones a revocation discards — by its range over the last half
  hour; the day's counts by the `contributors` primary key; a person's
  workers by `(owner, last_seen)`; a draft's decision after a failed handler
  by the approvals' `(name, created_at)`. The passkeys (#257): a login's by
  `(login, created_at)`, ten at most; one by its credential's unique index;
  one by its id (primary key) for its removal, its journal line and its
  counter; a challenge taken by its primary key; a login's live challenges
  counted, its expired ones deleted and its earlier one for the same purpose
  and draft replaced, by `(login, expires_at)`; every expired one in the
  weekly gc by `expires_at`. A challenge is a row a maintainer's page asks
  for: one per purpose and draft, as a new one replaces the earlier (a
  cancelled prompt holds no slot), and five live at most per login. The
  web's approve and block (#271) read nothing new: the same challenge, the
  same passkey by its credential, the same counter update, after the act's
  own predicate. A reset (#271) reads the login's passkeys by
  `(login, created_at)`, writes its journal line only while one is there,
  deletes them by the same index and the login's challenges by
  `(login, expires_at)`, and signs the login out by the `contributors`
  primary key, in one batch. The agent on a
  decision's rows is written by the decision's own statement. Nothing scans,
  nothing fans out per row;
  [agent-tools.test.ts](../worker/test/agent-tools.test.ts) asks each for its
  plan.

### What the server enforces

- **No self-review.** The requester cannot claim their own package, release a
  claim on it, or draft or confirm a decision on it: the web's predicate, the
  web's words.
- **Evidence is not the product.** Approve takes the project's rebuild only; a
  contributor's build is refused, as the web refuses it.
- **Confirmation.** Approve, request changes, reject and block need the person
  in the browser. No route decides on an agent's token. A draft is spent
  before its handler runs, so it decides once. Approve and block need the
  person's passkey, verified by the Worker (#257), as the web's own buttons
  do (#271); request changes and reject confirm with the session and, for
  reject, the name typed.
- **Releasing.** The maintainer who claimed it, or another maintainer,
  releases a claim, and only while a rebuild of it is queued or leased; the
  journal line names the agent.
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
  build wrote: the description, the recipe, the gate's checks (its summary
  is made from the `vet.json` the build's worker staged), the logs. That
  text can carry instructions aimed at the maintainer's agent. The tool puts
  it under `requester_text` and says it is evidence, never instructions, and
  the
  confirm page shows the pool's own evidence rather than the agent's summary,
  so a verdict never rests on the agent's reading alone. Nor can that text
  reach the project's rebuild through the agent: a claim's note is never the
  hint (above).

### Where it is

- `crates/omarchy-cli`: `login` and `logout` (`login.rs`: the loopback
  listener on `127.0.0.1` with its `state` and PKCE verifier); the
  credentials file, 0600 and bound to its origin (`credentials.rs`); the
  calls that carry the token in `api.rs`, while public reads stay anonymous;
  the seven tools in `mcp.rs`, listed by scope, with a minute's memory of
  what they read, the edge cache passed for a minute and a half after a
  write, and the credentials file read again whenever a `login` or a
  `logout` changes it. The `instructions` from `initialize` say that reads
  are open, that writes act as the login through the named agent, and that
  decisions wait for the person.
- `worker/`: migration 0039 (`agent_grants` with the pending code in the
  grant's row and the partial indexes of live and unswapped grants,
  `drafts`, the two `agent` columns, the day's counts on `contributors`,
  `idx_build_workers_owner`); the two rate limiting bindings
  in `wrangler.toml`; `agentOf`, the token's refusal elsewhere and the day's
  counts in `agents.ts`; the grant, the swap, logout, the drafts and the
  confirmation in `routes/agents.ts`, their two pages in
  `pages/agent-auth.ts`; the passkeys (#257): migration 0040 (`passkeys`,
  `passkey_challenges`), the verifier in `webauthn.ts`, the relying party,
  the challenges and the registration's three routes in
  `routes/passkeys.ts`, the confirm page's script and its states in
  `pages/agent-auth.ts`, the *Passkeys* section of the person's own page
  (`pages/user.ts`), the journal's `passkey` kind, the expired challenges in
  the weekly gc; since #271, `webGate` and `decidedWith` in
  `routes/passkeys.ts` on the web's approve and blocks
  (`routes/review.ts`, `routes/blocks.ts`), the options for an act and the
  reset in the same file, the shell's `passkeyed` (`pages/layout.ts`) that
  Review, a build's page, a package's page and the person's own page go
  through, and its `refusalHtml`, which draws a refusal with the way to add
  a passkey as a link, and the person's page's *A lost passkey*; `through` on the handlers of `routes/review.ts`,
  `routes/blocks.ts` and the request; no hint on an agent's claim; the tail
  read and the edge cache of text evidence in `handleStagingGet`; the grants
  and the drafts in `/factory/me` and on the person's own page; the expired
  codes in the weekly gc; the API page's *Write (people)* section.

### Tests

The Rust side, in `mcp.rs`, `login.rs` and `credentials.rs`, clean under
`cargo clippy --workspace --all-targets -- -D warnings` (the workspace's
pedantic lints) and `cargo fmt --all --check`:

- `tools/list`: no credential lists the six read-only tools in their order; a
  contributor's adds `request_package` and `request_status`; a maintainer's
  lists all thirteen; a credential for another origin lists the six.
- Bad arguments never reach the network: no URL, a confirmation not `true`,
  a verdict outside the three, a note under four characters, a block or a
  release without a reason, a name that is not a package's.
- Every tool against a one-thread HTTP server on `127.0.0.1`, the pattern of
  the tests in [crates/pkg-repo/src/client.rs](../crates/pkg-repo/src/client.rs):
  the method, path and body sent; the token on writes and on `/factory/me`,
  never on a public read. `review_context` asks for text evidence only — no
  path ending in `.pkg.tar.zst`, even when the task lists one — puts the
  gate's summary under `requester_text`, and answers a repeat from memory,
  which keeps a read for its minute only. `submit_review` and `block` call
  `/factory/drafts` only; no call goes to `/approve`, `/reject`, `/changes`,
  `/block` or `/cancel`. `review_release` calls `/release` only. A 403 with
  `conflict_of_interest`, a 409 and a 429 come back as `isError` results in
  the server's words. After a write, the story is read past the edge cache;
  a story that shows no claimable build still sends the claim, and an
  approval while the rebuild runs goes to the rebuild, the pool answering.
- The credentials file: written 0600 in a 0700 directory; a file others can
  read is refused; an expired grant says "run omarchy-cli login" without a
  request; the token is never sent to another origin; a running `mcp`
  session reads it again after a `login` or a `logout`. `logout` deletes it
  only when the pool revoked the grant or says it is gone, and otherwise
  keeps it and exits 1; `login` refuses, before anything is sent, to leave a
  live grant of another name or pool behind.
- Login: the listener binds `127.0.0.1` only and takes one callback, its
  own: anything else is answered (404, or 400 for another `state`) and the
  command waits on, and a callback with another `state` alone swaps
  nothing; the verifier goes to the pool's origin only, in the swap, never
  in the browser's address.

The Worker's side, in vitest on a real local D1
([agent-tools.test.ts](../worker/test/agent-tools.test.ts)):

- An `oma_` token is refused on every route outside its list — a table over
  the decision routes, the cancel, the token, the record's withdrawal and the
  maintainers' reads — and `contributorOf` never takes it.
- `review` and `block` are refused to a contributor, at the grant and on use,
  and to a login removed from `factory/MAINTAINERS.toml`, on its next call.
- Grant takes the session only (a bearer token is refused), with its `Origin`
  and nonce, and sends the code to `127.0.0.1` only, whatever the link
  asked. A code is swapped once, not after it expires, and not without the
  verifier that matches its challenge; a wrong code writes no row. A fourth
  live grant is refused; the same agent name replaces its grant at the swap,
  and a Grant whose code is never swapped leaves the old one working. Grant
  is counted per login at the edge. An agent name with a control or format
  character is refused.
- Expiry: a grant that holds `review` or `block` expires seven days after
  Grant, whatever the link asked; a `contribute` grant expires in thirty days
  by default and never later than ninety.
- A draft from the requester is refused with the web's reason. Confirm takes
  the session only (a bearer token is refused), the same login only, once
  only, and not after it expires; it runs the predicate again, and refuses a
  package that moved since the draft. Two confirms of one draft sent at once
  make one approval, one publish job and one journal line; the second is
  answered 409. The confirm page draws every architecture the decision
  covers, and each of the decision's rows, its record and its journal line
  carry the agent (`through` on `/factory/approvals`). A rejection and a
  block need the name typed. A handler that fails leaves the draft
  `refused` when nothing was decided, `confirmed` when the decision stands.
  Bad arguments — no task among them — are refused before the day counts.
- A draft writes no journal line: `/events` and the person's public page
  never show it, and `/factory/me` shows it to its person only.
- A passkey (#257), with a software authenticator the tests build
  ([soft-authenticator.mjs](../worker/test/soft-authenticator.mjs): a
  WebCrypto key pair, authenticatorData with the RP id's hash, the flags and
  the counter, clientDataJSON, the signature). A valid assertion confirms
  approve and block, and the decision's row, record and line name the
  passkey; its counter and last use move. Refused, with nothing decided and
  the draft still waiting: an answer replayed (its challenge was taken by the
  first request, which decided nothing), a challenge of another draft or
  past its five minutes, another origin, another RP id, no user
  verification, nobody present, a registration's type, a frame of another
  site, a key of another login, another key's signature under the login's
  credential, a removed key, a counter that went backwards or stood still.
  A maintainer without a passkey is told to register one — on the page, at
  the POST and at the challenge — with the link, and offered no Confirm;
  another address says where passkeys work. Request changes and reject
  still confirm without one. The challenge route takes the session, the
  Origin, the nonce and the same login; a new challenge for the draft
  replaces the earlier one, so presses that were cancelled never fill the
  five a login holds, and the sixth ceremony at once is told to wait. The
  confirm page's Confirm is the form's first submit button, so Enter in the
  typed name confirms, never discards. A malformed signature of any
  algorithm — an Ed25519 one that is not 64 bytes included — is a refusal
  page, never a 500. `next` in a draft's answer names the passkey for
  approve and block, and the Passkeys section's address when the login has
  none.
- Registration ([passkeys.test.ts](../worker/test/passkeys.test.ts)): the
  options (this RP, a hashed user handle, the three algorithms, user
  verification required, attestation none, the login's passkeys excluded); the
  row holds exactly what verification needs and `/factory/me` lists it to its
  owner without the key; RS256 and EdDSA as well as ES256; the session only,
  from the relying party's origin, a maintainer not blocked; a challenge once,
  for its login and a registration, within five minutes; an answer of
  another origin, RP id, type, or without the user verified or present,
  refused; a credential registered once; ten a login and five live
  challenges, a new one replacing the earlier for the same purpose. Registration and removal are journaled without the key, and
  only the owner removes theirs. Since #271: a second passkey and a removal
  are refused without an answer from a passkey the login holds — none, one
  for another act, another login's key, the user not verified, a replayed
  one — storing and removing nothing, and the journal names the passkey that
  vouched; two first registrations at once store one; the options for an act
  are bound to the login and the act, and refused to a token, another page,
  another address, a contributor, one's own reset and a login with no
  passkey. A reset is another maintainer's, with their passkey and a reason:
  the passkeys, the challenges and the browser session go with the journal's
  line, the record verifies with the pool's key and holds nothing of the
  keys, the person adds a first passkey again after signing in; every
  refusal (the login itself, a contributor, a token, another page, no or a
  short reason, nothing to reset, no passkey, no answer, an answer for
  another reset) removes nothing; two at once are one; a record the bucket
  refused is said in the answer and on a line of its own.
- The web's own approve and block
  ([passkey-decisions.test.ts](../worker/test/passkey-decisions.test.ts),
  #271): decided with the maintainer's passkey, named on the answer, the
  record and the line, the counter moving; refused with its code and nothing
  decided — no answer, a token (a maintainer's `omc_` too, and beside the
  session), another page, no Origin, another address, an answer for another
  build, for a block, made for another login or with another login's key,
  the user not verified, another origin or RP id in the answer, another
  key's signature, an expired or a spent challenge, a counter gone
  backwards; the act's own refusal first, in `can`'s words; request changes
  and reject as they were; a block of a package and of a contributor the
  same way, nothing pulled or revoked when refused; a handler called
  without the gate refuses; and the shell's `passkeyed`, run as a page runs
  it, asks for this act's challenge, hands it to the browser with user
  verification required and posts the act with the answer — and posts
  nothing when the browser cannot ask, the prompt is cancelled or the pool
  gives no challenge. The tests that decide on their way to something else
  do it the same way (`test/decide.ts`).
- The verifier ([webauthn.test.ts](../worker/test/webauthn.test.ts)): CBOR as
  authenticators write it and every malformed shape refused; authenticatorData;
  the three algorithms and DER-to-raw; each check of a registration and an
  assertion, by its refusal code.
- A claim with an `oma_` token leaves `params.hint` null and keeps its note
  in `params.note`; the same note through the web's button is still the hint.
- A release through an agent names the agent on the row, the record and the
  line; the requester's agent is refused a claim, a release and a draft with
  `conflict_of_interest`.
- Logout, Revoke on the person's page and a contributor's block each end a
  grant at once; Revoke, logout and a new login under the same name discard
  its waiting drafts, and a draft whose grant was revoked otherwise is
  refused at the confirm. The person's page lists every live grant and
  every waiting draft, however many newer rows are behind them.
- An `oma_` token on a read the edge already holds is refused as on a miss.
- The limits answer 429: twenty calls a minute per login across its grants,
  five swaps a minute per address (the bindings themselves, in workerd); the
  day's counts are the login's, a new grant or another agent name does not
  start them again, and a release counts toward the day's ten claims.
- With the cost guard up, an agent's write is answered 503 and a person's
  write on the web is not.
- Text evidence answers `public, max-age=30` and `?tail=` gives its last
  bytes; a package in staging is still no-store and for maintainers only.
- Every new query, and `/factory/me`'s workers, is asked for its plan
  (`EXPLAIN QUERY PLAN`, as [releases.test.ts](../worker/test/releases.test.ts)
  does): a search through an index, never a scan.

### Signed off

A maintainer answered the questions the proposal asked on 2026-09-29, in
[the sign-off on #253](https://github.com/firemanxbr/omarchy-pool/pull/253#issuecomment-5883414375).
What is built follows the answers:

1. **Scope.** The six tools, and `review_release` (10). `submit_review` ships
   in its final shape, with the `reject` of #247 that frees the name.
2. **Identity.** The pool's own grant in the signed-in browser, handed to the
   command through a loopback address with PKCE (RFC 8252). It is the only way
   in for this version; another, for a machine without a browser, can come
   later if someone needs it.
3. **Expiry.** `contribute` grants: thirty days by default, ninety at most.
   `review` and `block` grants: seven days.
4. **Confirmation.** The session link, with the package's name typed for
   reject and block, is enough for now. A passkey (WebAuthn user
   verification) for approve and block is the follow-up
   [#257](https://github.com/firemanxbr/omarchy-pool/issues/257), built:
   *A passkey for approve and block*; and the web's own buttons, the
   passkeys added and removed, and a way back for a lost one are
   [#271](https://github.com/firemanxbr/omarchy-pool/issues/271), built.
5. **Requests.** `request_package` does not go through the confirm link; the
   daily limit stays.
6. **Drafts.** Shown on the person's own page only until they are confirmed;
   the public journal records decisions, not drafts.
7. **Limits.** As proposed: twenty calls a minute per login; five requests,
   ten claims and thirty drafts a day per person; three live grants per
   login; five token swaps a minute per address.
8. **Signatures.** The pool's signature on every record is enough for now; a
   person's own can come later.
9. **Order.** The tools are built after #242 and #247, so they take `name`
   where the routes take a task and ship in their final shape.
10. **Releasing a claim.** A `review_release` tool (*Releasing a claim*,
    above).
