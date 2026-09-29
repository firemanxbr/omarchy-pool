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
| `pkg-repo` | `desc`/`files` rendering identical to `repo-add`, database determinism; the work loop's agent re-check (#273): 15 s, doubled back to the half hour while the agent does not answer, the half-hour probe once it does, a failure logged once per change of state, and a stub `factory/bin/agent.py` in a checkout refused, then answering — ok with the next claim, no restart — and a slow one stamped when it answered, not when it was asked | unit + `tests/database.rs` |
| `omarchy-cli` | the MCP server's protocol handling: initialize, notifications, ping, tools/list, unknown methods, tool errors as results (`isError`) not protocol errors, bad arguments refused before any request; the write tools (#252): listed by the credential's scopes and never for another origin, each against a one-thread pool on 127.0.0.1 — the method, path and body, the token on writes and the caller's own reads only, text evidence only and never a package, the drafts' route and never a decision's, the pool's refusals in its words, a minute's memory that keeps a read for its minute only, the edge cache passed after a write, a build picked from the story but never a call stopped by it, the gate's summary under `requester_text`; login's loopback (127.0.0.1 only, its own callback only — anything else answered while it waits, another `state` swapping nothing — the verifier only in the swap) and PKCE (RFC 7636's own example); the credentials file (0600, refused when others can read it, bound to its origin, an expired grant said without a request, read again by a running session after a login or a logout); `logout` deleting it only once the grant is revoked or gone, and `login` refusing to leave a live grant of another name or pool behind | unit tests |
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
| `releases.test.ts` | the release logic through the Worker's own `fetch`: manifests indexed into the pool, `POST /releases` — first release, adds on top of the head, replace-by-name within a source and architecture (another source's build of the name stays; `remove_from` drops one source's, `remove` every source's), `remove` / `remove_arch`, promote `edge → rc → stable` by copying the source head, rollback to an earlier release (lineage, history, `is_head`), the scopes each ring needs; the diff between releases; `unchanged_arches`; `GET /releases/:ring` paged in `(name, arch, source)` order (keyset cursor with the source, the older two-part cursor still accepted) with `release_id` pinning, `arch=`, `include=files`; `GET /graph?arch=` (declared dependencies and provides, per architecture); `GET /stats` before any metrics snapshot; the delta model — a release writes only its delta, checkpoints every 24th, an old release read by id is reconstructed, retention keeps the checkpoint a rollback inside it needs and prunes the rest (410 beyond); the membership tables without a foreign key to `packages` (migration 0035) — a package delete reads no membership row, GC leaves a victim a ring took back after the listing (row, lists and object) or after its own probe (row and lists: every DELETE of the batch is conditional), a reconstruction refuses a release whose packages are gone; the lab — any object pinned into it, never promoted from or into (400), its include the lab's sections above edge's |
| `relayout.test.ts` | the one-time move to one directory per source (`routes/relayout.ts`): objects copied with their signature and attestation and R2 checking the row's sha256, rows pointed at `<source>/<arch>/<filename>`, a null key backfilled, a row whose bytes the pool never held marked `ghost/…`, purge refused while anything is left to move and then emptying the flat directories; the upload, index, signature and `/packages/known` routes speaking the new layout — a filename is one object per source, another source's build of it another object |
| `gc.test.ts` | retention's reads (`routes/gc.ts`, `db.ts`, the metrics snapshot) over a pool shaped like the real one: the list of what is outside retention is the one the plain `NOT IN` form produced and is read through the membership tables' primary keys, not every row of them (`rows_read` bounded on the vitest D1); the reclaimable tile counts by the rule GC deletes by and agrees with the old count once the checkpoints outside retention are pruned; a victim's row goes and its object only when no other row names the key, found through the filename index; every writer of `r2_key` ends the key with the filename |
| `factory.test.ts` | the factory's brain (the trial included: queued for the project's build only, on its architecture, a community worker never takes it, its token reads the staged package and writes the lab and nothing promised, `trial.log` beside the evidence, the verdict on the Review row); claims with worker tokens (own architecture only, project vs community), leases and per-job tokens, heartbeat, fail → requeue, complete after the package is indexed, the agent a worker reports; a community build staging its evidence (the builder cannot write `audit.*`, the package is for maintainers, the rest is public), the audit queued and taken only by a project worker declaring the kind, the report attached and its verdict on `/factory/review`; approvals — a contributor cannot, a maintainer cannot approve their own package while another maintainer exists, the rebuild queued at project trust, the record and the profile's track record; what a public log must not carry (a token, a key or the worker's environment in text evidence is a 422 with the kind and the line, never the match; the record never receives it; the log's tail and the error line withheld at complete/fail; multipart closed for text evidence); who trusts whom (a proposal, the second word, never the owner's, the signed record, back at one word); the worker behind every staged build on Review; a record withdrawn with its signature and staging copy, the tombstone's fields |
| `review.test.ts` | Review's decisions through their doors (#247): the requester refused a claim, changes, a rejection, a release and the cancel door on the claim's rebuild with the reason and the code `conflict_of_interest` (`sign_in` for nobody); who asked for a build in review still refused once the registration moved, and no adoption while a build of it is open; a claim pinned to the review worker whose agent the maintainer chose, signed and in the journal with it, two at once one claim; the rebuild's inputs carrying no staged object of the factory's build and its job's token unable to read one; a release by the maintainer who claimed it or another — a queued rebuild cancelled once, a running one's lease voided and what it staged taken, a claim on two architectures half staged let go whole and ready again, one all staged or a second release refused, two at once one release; request changes (the round stopped, the name kept, said as changes on the story, the build and the maintainer's record), reject (the name freed), approve (its publish job not the cancel door's); a note that is not text refused before any write; two approvals, or changes and a rejection, at once one decision; the agent on the record the one the rebuild ran; every decision — an adoption that takes a registration, block and lift too — a record whose signature verifies with the pool's key, written once even by two writers at once, and a journal line with who, the door and the agent; none taken back but by a block; Adopt, one door for the package page and the No maintainer tab (`routes/adopt.ts`): a synced package's maintainer of record alone, an unmaintained registration taken with its maintainer of record — signed, one `adopt` line that says which, taken once by two maintainers at once — and refused to a contributor, to the registration's owner (`conflict_of_interest`), to a package with its maintainer and to one in no ring; the queue's row writing a version whole beside its name, wrapping under it rather than cut, and a maintainer's line wrapping between its parts (#282, the stylesheet through `declared`); the handlers' own statements asked for their plans |
| `package-view.test.ts` | a package's page (#244), the served script run over the Worker's answers for every viewer: one layout for every package, only You changing with who reads it; where each architecture is served, the files, a review's two recipes, the package's maintainer in the pool (`maintenance.maintainer`); Adopt from the page — a synced package named its maintainer and left what it was, a registration its owner left unmaintained taken with it (the one door Review's No maintainer tab posts to; the evidence an approved rebuild answered does not hold it up), refused to a contributor, the requester, a package in no ring and one with its maintainer, once when two press at once; the reads bounded by the name; a dependency's name kept whole in the graph and its version cut instead, however long (#274: the page's stylesheet, read through the fixture's `declared`, and the node the page writes); the state chip's *ready for review* and *in review* in the Factory's and Review's meaning (#274); two long names that share a prefix told apart in the graph — the side columns first, the package between wrapping its name, and a name wider than its node cut in the middle with the word that parts it from the others kept (#282: the served `nameCut`, the node's head and tail, what a reader sees at each width, the stylesheet) —; the Depends on tile's *1 library* and *N libraries* (#282) |
| `soname-provider.test.ts` | which package a loaded library comes from (#275), over a ring of its own where glibc, lib32-glibc and a cross toolchain's `any` sysroot all ship a `libc.so.6`, and gcc-libs and two x86_64 cross compilers (one from a source read before core) a `libstdc++.so.6`, the cross ones in their sysroot: zlib's resolves to glibc, a lib32 package that names no lib32-glibc (Arch's lib32-curl) to lib32-glibc, lib32-openssl and lib32-zlib, a declared `libcrypto.so=3-32` to that provide, cmake's and a package that declares the cross compiler's libstdc++ to gcc-libs; the reverse edges by the same rules (the sysroot and the cross compilers required by what declares them, glibc by nothing 32-bit, lib32-glibc by nothing 64-bit) and the Security page's exposure; the ELF class written at indexing equal to what migration 0041 computes; zlib's page saying Depends on the same number in its header and its graph; the lookup's plan, a file list read by its primary key, and each view's rows no more than main read |
| `leak.test.ts` | the shapes a public log must not carry (`src/leak.ts`): each kind, the first hit's line, and the ordinary things a log says that are not one |
| `pages.test.ts` | the dashboard's pages through the Worker's fetch handler, over the fixture: every door and detail page served with the shared frame (the door a page lights marked for a screen reader too, Go… naming a key only once the ⌘K menu is there to answer it, the theme switch beside it, #272), no page script using a name it does not declare (parsed with acorn, not grepped), no template placeholder left behind, no id served twice (a script draws into the first element of that name), the docs shell with every chapter's sections on every chapter, a link into the docs landing on a chapter's section, a glossary term or one of the index's seven, the old chapter addresses still redirecting and the pages that became sections of another redirecting there with their query (`MOVED` in `src/index.ts`), every routed page one hop from the header or the footer, the diagrams drawing no two boxes over each other, and the MCP write tools of #252 said as served on every page that names them (#268) |
| `status-page.test.ts` | Status (#248), the page the Pipeline, the Journal and Security became: every section the design names served, and the section each old address lands on (`#journal`, `#advisories`); the stats carrying each ring's last releases with where each selection came from (`source_ring`), so a rollback is drawn red, and what each source's syncs brought today (`coverage.today`) from the rows the day's imports already read — each ring's window read on its index, a few rows per ring however many releases the table holds (the plan and `rows_read`); a Sources row for every source in `EXPECTED_SOURCES`, late said in a word; the hero saying all rings are healthy only when a check said so, naming the ring that is not, the part the service check's 503 names, and the pool's numbers that did not answer where each section drawn from them would be; a tile counting up once per number; a project worker alive whose agent did not answer drawn *not ready* with the agent's error on hover (the shell's `wtNotReady`) and counted beside the busy, never *idle, waiting for work* (#273); the journal saying who did a line — the maintainer who proposed a worker's trust, not its owner — and with which agent, keeping Show more while a read came back full (its metrics lines counted), drawing the chip picked last over a slower answer, and refreshing a chip with twenty lines a kind; and a maintainer's roll back drawn for a maintainer only — none on a card whose head is a rollback — and refused by the server to everyone else, run as each role over the Worker's real answers |
| `go-menu.test.ts` | the ⌘K menu (#241, `GO_MENU` in `layout.ts`): on every page a closed dialog after the footer — nothing of it drawn with script off, Go… still the link to the packages — and its script once, after the shell's, the whole script parsing; the handoff's ten actions, each landing on a page (a fragment on the page it names, Home's `#get-started`); and the menu run over a document of its own: ⌘K and Ctrl+K open and close it, `/` focuses the page's own search where one is marked (`aria-keyshortcuts="/"`) and opens the menu elsewhere, Esc, the cancel event and a press beside it close it and the focus goes back, Tab stays on the line; the line filters actions and packages, ↑ ↓ move round the list with the row named by `aria-activedescendant`, ↵ opens; the packages from the search Home's box asks, at its very address, once per pause in the typing and once per term, a term inside a whole answer narrowed without asking, a package whose name holds the line above an action found by a hidden word; a name that search did not find looked up — the factory's names, then the name on each architecture — and drawn first where it is (an aarch64 package, one only in edge or the lab, one a request reserved), Request "<name>" only for a name found nowhere, the name by the request's own rule (`PKGNAME`, spliced in), landing on the Factory's request card (`/factory?name=…#request`) with the name filled in, ↵ before the answer waiting for it; the hint a package's origin in words; a search or a lookup that did not answer said, to a screen reader too, with no Request over it; one letter asking for one more, not saying nothing matches; on a Mac, Ctrl+K left to a text field; the theme through `window.opTheme`; the kit's sheet linked the first time the menu opens, once; what it writes escaped; a browser without `<dialog>` left as served |
| `factory-page.test.ts` | the Factory (#246, `pages/contribute.ts`): a name taken by one rule — `PKGNAME` in `request.ts`, which the request refuses by in its words, which the card's script, the ⌘K menu and Home's box splice in, which the packages list offers Request by (`BROWSE_NAME`), and which no page module types a copy of; the card's live check (`GET /factory/names/:name`) saying what the request would answer, word for word, for a free name, one a request reserved, one in the pool, one a source ships and a blocked one, and the holder's own name theirs; two requests for one new name at the same moment, one of them has it; the check's reads through the name's indexes, never every package edge serves; what runs now — the listing's live read, the tasks in flight through the queue's index and no counts, never every task; what the pool reads of a repository (`routes/sources.ts`): the forge and the path from the address, the request's project the same repository whichever view was pasted (one project, one registration), GitHub through the request's own `detect()` short of the tree, GitLab and Codeberg through their APIs with the release named for the request, nothing where `SOURCE_CHECK` is off, a read kept by the repository and not the address as typed (a missing one a minute), never asked of a forge for a visitor or a blocked account, and at most `READS_PER_HOUR` an hour per person; the page run over the Worker's answers — "Sign in to send" for nobody and the card kept across the sign-in, the prompt built from the form, the agent's tab naming the two tools an agent requests with (`request_package`, `request_status`) as served, with the login that grants them (`omarchy-cli login --agent`, the agent's name) and the Agents page and the MCP chapter linked (#268), a check said in a few words and the reason under the field, every package on the line where its targets put it (a request whose every build failed off it), each column counting its own cards, the tiles (building now what a worker holds, Shipped a floor — "12+" — when the registry says it was cut), the workers with their agents — one alive whose agent did not answer drawn *not ready* with the agent's error (the shell's `wtNotReady`), counted apart and listed before the idle, idle again once it answers (#273) —, a worker's name and its agent each whole, the agent wrapping under the name (#282), the line read again when a build starts and not for a pool job, a card on the line and its name the sender's the moment it is sent, a person's own requests, a renewal filled from the record and the card a request's again once it is sent |
| `browse.test.ts` | the packages list (#245, `routes/browse.ts`, `pages/browse.ts`) over the fixture: a name once over every ring with the newest version they serve, the ring's version under a ring filter, the architecture and origin filters, recency, a search that puts the names holding it first, the pager both ways by cursor and a search's by number (past the end, back to the last page), what the API refuses and why (a page's number without its cursor, a cursor without its number), a search of any length (no LIKE pattern for D1 to refuse) cut by characters, never in half of one, where the pool has a name the rings do not serve (the factory's, the lab's), the counts kept under the heads they were counted at and counted again once a head moves; the page drawn with the list in it — the rows as links whose cells say what they are to a screen reader, the filters as labelled groups of links that keep each other and the search, the form, Request "<name>" only for a name found nowhere, a name the factory has as its page, a filter that leaves nothing offered to be cleared, one letter not a search yet, a number or a cursor alone the first page, a step back not followed by a crawler, a list that threw said without the database's words —, linked from Home, the footer and the ⌘K menu, drawn from the edge's copy of the address its script asks, and the script's renderers writing the server's characters; then, over a pool of its own, what a view reads: D1's rows_read bounded by the page, never the pool, and every statement's plan through an index or the table's own order, the counts one walk of the name index, a search the table once and its matches ranked, a name's other places two point reads |
| `home.test.ts` | the Pool (#243, `pages/overview.ts`), its served script run over the fixture with the Worker's answers: the four numbers are the stats' (the pool's names, today's arrivals into edge, the stable release, the sources in sync), the chain lists every project the pool reads with what edge serves from it, New in the pool is each ring's head against its parent at the Packages page's address — a release is asked about only while retention keeps it and its parent whole, and only this week — one card per name, and the box's placeholder offers only a name it drew; Requested is the factory's newest names a maintainer let through (`landed`), none blocked, never a name only asked for; Live is packages moving (a sync that brought something, a promotion said once, a security fix, a rollback, the factory's publish) from the journal's newest lines and its latest of each kind, newest first, the day's syncs counted by the daily series, lighting only a line that arrived since the last poll; the search box asks the ⌘K menu's search, stable on the other architecture when the first finds nothing, looks a pacman name no row is named for up at the package page's address and then among the factory's names and draws it first where it is (a request no ring serves "not in a ring yet", never "in the pool"), offers Request only for a name found nowhere, beside the whole search, and says what it shows to a screen reader; the setup card writes the command or the words for an agent for the picked ring, and only when the ring or the mode changes, never on a poll; and the page's own CSS keeps the kit's rules: focus in green on the kit's controls too, a gate's word inside its segment, the chain's squares moving by transform and standing still for a reader who asked for less motion |
| `docs-index.test.ts` | the docs index (#250): one page of seven short sections in the order its map lists them, with no chapter shell around them; `/docs/api` a 301 to `/docs#api` that lands on the API section; every chapter of the map linked — the reader's from the section each deepens, the code's from the line under the cards; the rings' own words (`RING_TEXT`) and the API's short list (`API_BRIEF`) as the page draws them, a path breaking only after a slash or before its query; the setup command's copy button copying the command alone; the search over every chapter, section and glossary term still on the page, run, and what came of it said to a screen reader; the kit's sheet, helpers and primitives, none of it in the frame's CSS; what the CSS holds at every width — grids of facts with no empty cell, the command in the design's type; the map lighting the section the reader is in, run over a document of its own — a third of the way down the window, the first card at the page's top and the last at its end, a section chosen in the map or named by the address kept lit while the page moves to it and given back on a wheel, a scroll that moves it once it rests, an address that names no section, or a card the browser did not bring into the window |
| `components.test.ts` | what each page is made of, against the served dashboard: every component's anchor in its page's HTML and its literals in the page's script, every read routed and answering JSON with the fields the page draws, every act routed with its method — and with no other — and answering per role what the manifest says, and the other way round: no fetch in a page script that nobody declares |
| `kit.test.ts` | the tokens and the v1 kit (#239): every colour a page module paints is a palette name — `PALETTE` in `layout.ts` is the one place a colour is written — and the served CSS declares each name in both themes; the palette the handoff's table, dark as given and light with four hues darker in lightness only, so every text colour reaches 4.5:1 on every surface of both themes, measured; the frame square, with no shadow and no gradient; a focused control never left without a green line, the shell's own buttons (the decision dialog's, the Decision cell's) drawn in tokens, every font weight the CSS uses loaded; the theme decided in the head before the first paint (`THEME_BOOT`, run over a document of its own: dark on a first visit whatever the system prefers, light only as the reader's choice, the choice kept and followed across tabs, `window.opTheme`'s get, set and toggle, storage that refuses) and the header's theme switch (`THEME_SWITCH`, #272) run after it: named for the theme it switches to, the one that is on as its description, a press toggling and keeping the choice, answered by the boot so the switch is drawn and works from the first paint, the ⌘K menu and another tab moving it too, nothing drawn with script off, and on a phone the switch at the end of the doors' row; the kit on the pages that pass `kit: true` and nowhere else — the ⌘K menu's script names its sheet, to link the first time it opens —, its one stylesheet immutable under its hash with the primitives, every icon and agent mark and their licences, no coloured mark painting in white or black; a tone or a ring's hue reset where it is read, so a ring card tints nothing nested in it; the shell's `lucide()` and `agentMark()` writing what the server's write; `countUp()` landing its number in 1.1 s, or at once for less motion; a code well's copy button, and "could not copy" when the browser refuses or has no clipboard |
| `agents.test.ts` | the Agents page (#249, `pages/agents.ts`): a page of its own at the footer's `/agents`, drawn with the kit, its own CSS after the kit's sheet and held to the frame's rules (tokens only, square, no shadow or gradient), and reading nothing; the tools it lists are the ones `omarchy-cli mcp` serves, read from `crates/omarchy-cli/src/mcp.rs` in its order — the six reads, then the seven write tools of #252 — none of them marked proposed, every role card with its prompt to copy and the login its tools need, and step 4 the login with the chosen agent's name, which the script follows; every agent offered has a mark from the kit, the documentation its snippet was checked against and the day, and a snippet that names the server `omarchy-pool` and starts `omarchy-cli mcp` (a file's JSON parses), as the MCP chapter's own example does; the agent shown is the address's `?agent=` (the first for none or an unknown one, nothing of the query echoed), and the page's script, run over a document of its own, switches it in place on a plain click, moves the focus to the picker after a mark under the title, and leaves a modified click to the browser; step 1 installs the client the way Get started says, and says the release binary is the way until a ring serves it; no well of the steps breaks a word, and a file's content keeps its lines |
| `agent-tools.test.ts` | the MCP write tools' server side (#252, `routes/agents.ts`, `agents.ts`): the grant made in the signed-in browser only (the session, its Origin and the page's nonce; a bearer refused), its code sent to 127.0.0.1 on the port whatever the link asked, swapped once, not after its minute and not without the verifier, a wrong code writing nothing; review and block a maintainer's, for seven days whatever was asked, contribute thirty by default and ninety at most, three live grants per login and the same agent name replacing its grant at the swap, Grant counted per login at the edge, an agent name with a control or format character refused; the `oma_` token refused with `agent_token` on every route outside the tools' — every decision route, and a read the edge holds — and never taken by `contributorOf`; the role read again on every call; a request through an agent not confirmed and said so on its row, signed record and line; a claim through one with no hint for the project's agent; a release naming the agent; the requester's agent refused with `conflict_of_interest`; a draft deciding nothing and writing no journal line, on its person's `/factory/me` only; confirmed by the same login in the browser — the session, the Origin, the nonce — once, two at once one approval, one publish job and one line, the name typed for reject and block, the predicate run again, a package that moved since refused, expired after thirty minutes, discarded, a failed handler said as refused or confirmed by what was decided; every architecture on the confirm page, and each of the decision's rows, its record and its line carrying the agent and the draft (`through` on `/factory/approvals`); logout, the page's Revoke and a contributor's block ending a grant, and a revoked grant's waiting drafts discarded or refused at the confirm; the person's page listing every live grant and waiting draft first; the bursts (the rate limiting bindings in workerd), the day's counts by login, the cost guard (503 for an agent's write, not a person's); text evidence edge-cached and read by its tail, a package never; every new query's plan; approve and block confirmed with a passkey (#257) — a software authenticator built in the test (`test/soft-authenticator.mjs`: a WebCrypto key pair, authenticatorData with the RP id's hash, the flags and the counter, clientDataJSON, the signature) — the decision's row, record and line naming the passkey and its counter moving; refused with nothing decided and the draft still waiting: a replayed answer, a challenge of another draft or past its five minutes, another origin, another RP id, no user verification, nobody present, a registration's type, a frame of another site, a key of another login, another key's signature, a removed key, a counter that went backwards or stood still; a maintainer without a passkey told to register one on the page, at the POST and at the challenge, with the link; another address saying where passkeys work; request changes and reject confirmed without one; a malformed signature of each algorithm a refusal page, never a 500; Confirm the form's first submit button, so Enter never discards; `next` naming the passkey, and where to register one for a login without; the web's own Approve guarded as well since #271, the session alone approving nothing on Review; the challenge route's session, Origin, nonce and login, one live challenge a draft — the newest — and the cap |
| `passkeys.test.ts` | a passkey registered and removed (#257, `routes/passkeys.ts`): the relying party from one list (every production name is `omarchy-pool.org`, `localhost` any port, nothing else — no IP address); the options (this RP, a hashed user handle, ES256, EdDSA and RS256, user verification required, attestation none, the login's passkeys excluded); the row holding exactly what verification needs, and the owner's `/factory/me` listing it without the key; RS256 and EdDSA as well as ES256; the session only, the page's Origin, a maintainer not blocked, nothing written otherwise; a challenge taken once, for its login and a registration, within five minutes; an answer of another origin, RP id, type, or without the user verified or present, refused with its code; a credential registered once, whoever registers it again; a label of one printable line; ten passkeys and five live challenges a login, a new challenge replacing the earlier one for the same purpose and draft, so retries never lock a person out, and a sixth ceremony at once told in a person's words to wait; registration and removal journaled (kind `passkey`: who, when, which passkey — never the key, the credential or the label); removal the owner's only; since #271 the first passkey the session's alone and a second one, like a removal, refused without an answer from a passkey the login holds — none, one for another act, another login's key, the user not verified, a replayed one — storing and removing nothing, the journal naming the passkey that vouched, two first registrations at once storing one; a registration stored only while the session that asked is still the login's and the passkey that vouched is still held — a reset landing between its challenge and its insert, interleaved through the database, leaves no key and says so (`sign_in`), and the person adds their own after a fresh sign-in; the options for an act (`POST /auth/passkeys/assert`) bound to the login and the act and refused to a token, another page, another address, a contributor, one's own reset, a reset of a login that holds none (before the device is asked) and a login without a passkey; a reset another maintainer's, with their passkey and a reason — the passkeys, challenges and browser session gone with the journal's line, the record signed and without the keys, the person's first passkey again after a new sign-in — each refusal of it removing nothing, two at once one, a record the bucket refused said in the answer and on a line; every new query's plan; the gc's delete of expired challenges |
| `passkey-decisions.test.ts` | the web's own approve and block with the maintainer's passkey (#271, `routes/passkeys.ts` `webGate`, `decidedWith`): decided with one, named on the answer, the record and the line, its counter moving; refused with its code and nothing decided — no answer, a token (a maintainer's `omc_` too), another page, no Origin, another address, an answer for another build or a block or made for another login, another login's key, the user not verified, another origin or RP id in the answer, another key's signature, an expired or a spent challenge, a counter gone backwards; the act's own refusal first, in `can`'s words; request changes and reject unchanged; a package's and a contributor's block the same way, nothing pulled or revoked when refused; a handler called without the gate refusing; the shell's `passkeyed` run as a page runs it — the act's challenge asked, the browser handed it with user verification required, the act posted with the answer, and nothing posted when the browser cannot ask, the prompt is cancelled or no challenge is given; the shell's `refusalHtml` drawing a refusal with the way to add a passkey as a link, in place of the address the words carry, and no link for anything but the person's own section. The other tests that approve or block on their way decide the same way, with `test/decide.ts` |
| `webauthn.test.ts` | the Worker's own WebAuthn verifier (`src/webauthn.ts`), against the software authenticator: CBOR as authenticators write it, and a tag, a float, undefined, an indefinite length, a duplicate or non-scalar key, bad UTF-8, an integer past 2^53, too deep a nesting, a truncated item and a byte after it refused; unpadded base64url only; an ECDSA signature's DER to r‖s, and what is not DER refused; authenticatorData's hash, flags, counter, attested credential and extensions, and a short or trailing one refused; COSE keys for ES256, RS256 and EdDSA, and another algorithm, curve, a short coordinate, a point off the curve, RSA 1024 refused; a registration and an assertion that verify for each algorithm, and each check that refuses one by its code — the type, the challenge, the origin, a frame of another site, the RP id, the user present and verified, the attested credential and its id, a none statement that says something, the key, the signature (another key's, over other data, cut short, raw instead of DER, the wrong length for each algorithm — an Ed25519 one that is not 64 bytes a refusal, never the runtime's error), the user handle, the algorithm, and the counter (zero both times taken) |
| `one-truth.test.ts` | one truth per fact, over the fixture: the review list's `waiting` and `oldest_ms` counted once, each of its rows saying `waits` by the same rule, one meaning of *in review* (#274) — the Factory's line, its served `stageOf` over the registry, files a package In review exactly when Review's list says `in_review` (claimed, let go, claimed again, its rebuild staged, a new version building beside the claim) and Ready for review exactly when it says `ready` (a staged build of a version already approved in neither), and the Factory's Ready for review tile and a maintainer's Review queue link say the list's `ready` and `in_review`; at each step every package the list names has the list's state in its story (`review`, the list's own rule over the story's rows), and the package's own page says the list's word too — its chip, its How it got here Review stage first, and its review panel's tag (#282), neither word for a staged build of a version already approved, and the Factory card's words in its order while a claim on two architectures stages one rebuild at a time —, and the Review page filing each package in a tab by the list's `state` through the served `tabOf` and its tiles reading the list's `ready` and `in_review` — the page keeps no copy of the rule, so stripped of the field it files nothing —, a package's address written by the shell's `pkgHref` alone, one ring for one build, an approval's `standing` carried by the server and where a standing one is today said once — the shell's `approvalWhere` over the row's `rings`, `blocked_at` and `publish_status` (in its rings, blocked, publish failed or cancelled, publishing), run over the served Factory (its Shipped cards and a person's own rows, `lost` settled to the targets the rule gives it) and Review pages as the fixture's people see them — row by row, so the test holds whatever an earlier test did to the database, and by class and word, since the pill's title carries a clock —, so an approval whose publish failed reads "publish failed" on both and nothing promises edge, both lead to its build and never to a package address as if a ring served it, and no page guesses a ring from the registry's status —, the community packages captioned as what `landed` counts (approved by a maintainer, never "in the rings"), the budget's lines and the late hour never typed by a page — and a build's evidence at one address: the shell's `evidenceHref` (its page's Evidence section), linked by a person's builds, Status's jobs table and the checklist's build items through `evidenceLink`; a build that died before uploading anything has a page that says "Nothing staged for this build" and a raw `build.log` that is a 404, so no page writes `/artifacts/build.log` by hand; the server's one answer to what waits for review, whether an approval stands, the rings' order, the late mark, the budget lines — and the pages reading it instead of counting their own; the worker minutes and the jobs of the week as one reduce over `jobs_daily` (the shell's `workerMinutes` and `jobsSummary`, run here as served over the server's rows) on the Status tiles, table and charts, a cancelled job a failed one on every one of them — and on the Workers page's cards, through the shell's `jobBucket` — while a fresh snapshot says otherwise, a job queued longer than the week still waiting, the reduce's window the days asked for, and the bucket one word on the Status page; the worst of a package's advisories picked by the server's `SEVERITIES` over a report built in the test; an advisory's severity in one colour — the shell's `SEV_COLOR`, the pill's class as the CSS paints it — on the pill, the bars and Status's severity counts (the served map and charts run here), no page colouring a severity or naming a bucket of its own; the 14-day health grid drawn once — the shell's `heatGrid` over `PROMISED_RINGS`, run as served over the server's rows on Status — and a health check's result in one word, the shell's `HEALTH_WORD`, on the grid, the Pool's stable tile, Status's ring cards, checks and job results; a person's workers served through the listing's own view (`workerView`: alive by the one threshold, ready, side), so their page's tile counts what its tables draw; the bill in one colour and one figure — the shell's `costColor` and `usd()` — on the Status tile |
| `no-answer.test.ts` | a list that did not answer is said, not drawn: the shell's `api()` rejects a 5xx with the body's error (`{ error: "internal error" }` is what the Worker answers when a route throws) and resolves a 4xx with its body and `__status`; the served pages' own scripts — Review, the Factory, Workers, People, Status (its service line, its workers, its rollbacks, its advisories and its journal among them), the Pool (its lists down with the stats up, and the stats down too: every number "—", Live and New in the pool saying the stats did not answer) — run over a fetch that answers every read with that 500 — and, for Review, as a signed-in owner, whose Yours block then says the lists did not answer instead of "nothing of yours waiting" —, and each page's line names the list and the reason once (the brake's record on Review, the Factory's line and the Status page's workers' clause among them), every tile reads "—" with "did not answer" under it and the reason on hover, none reads 0, no empty state ("nothing waiting", "no promotion yet", "no worker alive") stands in for a list that failed, a tile the stats poll feeds keeps its number when only the lists failed (the Workers page's minutes, beside the chart that draws the same series), and a refresh that fails leaves the last answer's rows on screen — three pages drew "Waiting for review 0 · nothing waiting" in green over a query that threw |
| `pool-jobs.test.ts` | Status's jobs table (the Pipeline's before #248) words a pool job from the shapes the jobs post: the served page's `jobResult` and `paramsLabel` run over the fixture's done job of every kind (params as the scheduler queues them, results as `work.rs` writes them) — a sync's totals summed over its sources with the releases it pinned, a promotion's verdict, a rollback, a render, a health check, the retention, the security run, the verify, the relayout, the enqueue, and the three jobs on a build — the audit's report, the trial's verdict, the file the publish put in the pool — that the fixture ran for real — and the one-source sync and the gate's other verdicts over the shapes as written; a release is named one way in the column, its id first and the ring's head after it where the result carries the sequence; the manifest pins the same fields, so a rename in `work.rs` fails by the field's name and here by the sentence |
| `lists.test.ts` | lists rendered from the code that owns them, never copied: the request's four confirmations, the categories, the sources table, the pacman.conf sample, the cost cadence and the budget's lines, the journal's kinds and the job kinds on the API page, the API page's rows against the routes the router serves, and the docs index's short API table against those rows and the router; the rings, the architectures and the severities (`meta.ts`) spliced into the shell once — `PROMISED_RINGS`, `RINGS_UPWARD`, `ARCHES`, `SEVERITIES` — and every page script reading them, none typing a list of its own, the manifests pinning the read; the Workers page's pool kinds as `JOB_KINDS`; a worker alive by one number, `WORKER_ALIVE_MINUTES`, in the listing, a person's page, the snapshot, the scheduler and the shell's titles |
| `audience.test.ts` | one day of the account's request analytics, both pool hosts in one query, becomes one number per ring and per architecture; recorded once as an `audience` event; a token without *Account · Analytics · Read* is reported once for the day, then quiet |
| `hosts.test.ts` | the pool's names (`src/meta.ts`): a page on an old dashboard name or www moves to omarchy-pool.org with its path and query (301 for a read, 308 otherwise) and its `/api/v1/*` is answered in place; the API's two names and the tests' pool.test serve without a redirect; a sign-in pressed on the API host starts over on the dashboard before any cookie; the setup script, the worker CLI and the include's comment name the API host on every production name, the request's own elsewhere; one edge key serves every name |
| `read-guard.test.ts` | the read guard (`src/cost.ts` `readGuard`): with the cost guard up, an anonymous machine — curl, an empty user-agent, an AI crawler by name, a verified bot of any category but a search engine's — asking `/api/v1/package/<name>` or `/package/<name>` gets a 503 with `retry-after: 3600`, `no-store` and `noindex`, and the next request, a browser's, is a real 200 (nothing was stored at the edge); a browser, an `omc` session, a bearer token, `omarchy-cli/`, `pkg-repo/` and a search engine's verified crawler read on; the file list, the graph, the search, the include and every page stay open to a machine; with the guard down nothing changes; and the guard word is read once a minute, not once a request |
| `provenance.test.ts` | the OPR provenance scan against a stubbed GitHub: origin per package from the tree and `.omarchy/package.json`, only changed packages fetched again, packages gone from the repository dropped, the per-ring counts |
| `jobtoken`, `scheduler`, `governance`, `updates`, `metrics`, `cost`, `signing` | the pure functions: tokens and scopes, the scheduler's rules, the governance file, bump detection, the metrics snapshot shape, the bill estimate — and its daily report on GitHub: the comment's markdown (the twin of the workflow's jq), posted once with the day's line after the issue is checked for today's comment, never twice, nothing without `GITHUB_REPORT_TOKEN`, a refused post one `warn` line —, OpenPGP signing |

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
draft finds no passkey and one is registered again — and
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
with the token, and the pool path off without a worker token.
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
`bash tests/worker-needs-native.sh` (CI, the Rust job) runs `pkg-repo work
--once` against a stub pool that hands it the project's x86_64 review
build and a stub `podman` that plays the build container (#281): on an
emulated worker, the build script's exit 96 and a library the loader could
not map (`failed to map segment from shared object`) are reported
`needs_native: true, final: false`, the log staged; the same loader line on
a native worker is a plain failure; the gate's stays final. The labels the
worker claims with (`--labels`, or `WORKER_LABELS` alone) are the ones its
build container gets.
`bash tests/omarchy-rollout.sh` (CI) runs the updater and the Studio's
`factory/host/rollout.sh` against a stubbed docker: the brokers
(`agent-proxy`, `broker-*`, a service with the broker or agent role) in
an `up` of their own, each asked from inside its container until it
answers — the tries between the two `up`s, a pause between them — before
the workers are replaced together; a broker that never answers said as a
warning within `ROLLOUT_BROKER_WAIT` — one bound for all the brokers, not
one each: the wait spent, the next broker is asked once — and the workers
replaced anyway; brokers compose could not start said, not waited for.

What the build sees is checked by hand in the worker image (SECURITY.md,
*Isolation*): `hold_secrets` leaves a child with no secret, `as_builder`
gives the build user seven variables and no read of `/proc/1/environ`,
`with_secrets` lends the agent its keys with nothing in an argv; a builder
started with `OMARCHY_BROKER` drops a token set on it by mistake and starts
the build with zero secrets. `factory/worker/omarchy-build-worker.sh` is
sourced up to its dispatch line for that (`sed '/^hold_secrets$/,$d'`), in
`docker run --rm ghcr.io/firemanxbr/omarchy-worker:aarch64` with fake values.

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
