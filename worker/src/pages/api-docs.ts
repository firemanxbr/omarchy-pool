/**
 * API: the endpoints a script, an agent or omarchy-cli uses, with examples.
 * The reference is rows of routes (READ, FACTORY_READ, WRITE_JOBS and
 * WRITE_PEOPLE below), each route written whole —
 * method and path under /api/v1, the query hints beside it — and rendered
 * into the tables; test/lists.test.ts reads the same rows against the
 * router's own source, so a route the Worker serves without a row here, or
 * a row about a route that is gone, fails by name.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { escapeHtml } from "../html";
import { API_HOST, JOURNAL_KINDS, LATE_AFTER_HOURS, type RunningVersion } from "../meta";
import { RING_HISTORY } from "../routes/stats";
import { BUDGET_CAP_USD, BUDGET_GUARD_USD, BUDGET_WARN_USD, ESTIMATE_CADENCE } from "../cost";
import { JOB_KINDS } from "../jobs";

/** A row of the reference: the routes it documents, who may call them (the people table), what they do. */
interface Row {
  routes: string[];
  who?: string;
  text: string;
  /** A route of the Worker's root, not of /api/v1 (the sign-in's own): left out of the comparison with the router. */
  root?: true;
}

const READ: Row[] = [
  { routes: ["GET /version"], text: "The running release, its commit and when it was deployed." },
  { routes: ["GET /signing-key"], text: "The pool's public signing key (fingerprint, user id, armored) — what <code>pacman-key --add</code> imports." },
  { routes: ["GET /status"], text: "Service check, measured now: index (D1) and pool (R2) reachable, with timings. 503 when one is not. What <em>online</em> in the header means." },
  { routes: ["GET /stats"], text: `Everything the overview shows in one response: rings, coverage (a source's row says <code>late</code> when its last sync is older than the pool's one threshold, ${LATE_AFTER_HOURS} hours) with what its syncs brought today (<code>today</code>), each ring's last ${RING_HISTORY} releases (<code>releases</code>, <code>source_ring</code> the ring a release's selection came from: another ring's for a promotion, its own for a rollback), pool totals, chart series, the latest metrics snapshot, recent journal entries, OPR recipes by origin per ring (<code>provenance</code>), <code>any</code> packages stored once per architecture and what that costs (<code>any</code>). Cached 60 s.` },
  { routes: ["GET /pacman.conf?ring=&arch=&with="], text: "The pacman.d include for a ring and an architecture — one section per database the ring serves right now, in the include's order; <code>with=</code> names the optional sources to keep. What <a href=\"/setup\">the setup script</a> writes, and what Get started shows." },
  { routes: ["GET /releases/:ring?fields=summary&arch="], text: "The ring's current release and a light row per package (name, version, arch, filename, sha256, sizes, description). This is what <code>omarchy-cli status</code> reads." },
  { routes: ["GET /releases/:ring?arch=&limit=&after=&release_id="], text: "Full manifests, paged (≤ 1000 per request; above 2000 packages paging is required): <code>page.next</code> names the row the next page starts after — pass it as <code>after=</code> (keyset; <code>offset=</code> still works). Add <code>include=files</code> for file lists. <code>release_id</code> pins a release across pages." },
  { routes: ["GET /releases/:ring/history"], text: "The ring's releases, newest first, with lineage (parent, from) and which one is the head." },
  { routes: ["GET /releases/:ring/diff?from=&to=&arch="], text: "What changed between two releases of the ring: packages added, removed and upgraded (same source, name and architecture, another object; another source taking a name over is its add and the other's removal). <code>to</code> defaults to the head, <code>from</code> to its parent; 410 once GC pruned a side's package list. The dashboard's <code>/diff</code> page and <code>pkg-repo diff</code> read this." },
  { routes: ["GET /packages/:sha256", "GET /packages/:sha256/provenance"], text: "One package object's manifest; its seal — where the object came from and the proof: the upstream and its keyring for an imported one, the chain (builder, audit, approval) and the signed attestation for one the pool built." },
  { routes: ["GET /search?q=&ring=&arch=&limit="], text: "Packages in the ring whose name or description matches (exact and prefix matches first)." },
  { routes: ["GET /packages?q=&ring=&arch=&origin=&sort=&after=&before=&page=&limit="], text: "The packages list the <a href=\"/packages\">Packages</a> page draws: one row per name — its description, the version the ring serves (with every ring, the newest), where it comes from, the architectures it is served on, when it last changed — filtered by ring (<code>all</code>, <code>stable</code>, <code>rc</code>, <code>edge</code>), architecture and origin (<code>synced</code> or <code>factory</code>), sorted a–z or by <code>recent</code>, 25 a page (<code>limit=</code> up to 100). <code>next</code> and <code>prev</code> are the parameters of the pages beside it (a cursor, and the page's number — outside a search the two go together); <code>total</code> counts every package the rings serve, <code>count</code> what the filters match. <code>q=</code>, two characters or more, searches names and descriptions, the names that hold it first; when a search with no filter matches nothing, <code>held</code> says where the pool has that name outside the rings — the factory's registration (<code>where</code> is its status) or the lab — and is null otherwise." },
  { routes: ["GET /package/:name?ring=&arch=", "GET /package/:name/files?ring=&arch="], text: "Everything the package page shows: the version in every ring (<code>ring</code> is the one asked, the lab included; <code>shown_ring</code> the one the object comes from — the same, else the most stable that serves it), the manifest, declared dependencies and loaded sonames resolved to their providers (a soname to one package built for the architecture read and of the binary's ELF class — lib32 to lib32 — never an <code>any</code> package or a library a package ships only in a cross toolchain's sysroot; of those, the include's order), what depends on it (declared, or by loading one of its libraries, by the same rules); <code>arches</code>, where each architecture of the package is served — the rings, most stable first, with the object each serves, and the advisories open on the object that architecture's page shows — and <code>files</code>, how many files it installs; the file list separately. Asked on an architecture that does not serve it, a <code>404</code> that still carries <code>arches</code> and — when another architecture serves it — <code>maintenance</code>: where it is, what is open there, whose it is. For an OPR package, <code>provenance</code>: whether its recipe is Omarchy's own or AUR-synced, the AUR commit tracked, the last commit that touched it (<code>omacom/omarchy-pkgs</code>, read daily). While the cost guard is up, <code>GET /package/:name</code> answers an anonymous machine — no session, no bearer token, a user-agent that is empty, an AI crawler's or not a browser's — with a 503 and <code>retry-after: 3600</code>; a signed-in reader, a bearer token, a browser, a search engine's verified crawler and the pool's own clients (<code>omarchy-cli/</code>, <code>pkg-repo/</code>, <code>omarchy-broker/</code>, <code>pacman/</code>) read on, and <code>/files</code> is never closed." },
  { routes: ["GET /graph?ring=&arch=&targets=a,b"], text: "Dependency closure of the targets within the ring's release: the manifests <code>omarchy-cli check</code> evaluates." },
  { routes: ["GET /security/components"], text: "What the rings' packages embed — Go modules and crates.io crates from the binaries' build information — with the sha256 of every served object that embeds each; what the security job asks OSV about." },
  { routes: ["GET /security?ring=&arch="], text: "Packages in the ring with an open advisory: severity, confidence (exact / name-version / name-only), CVEs, exploited-in-the-wild and EPSS, rings already serving a clean version, how many packages it exposes. <code>GET /package/:name</code> carries the same per package plus what it is exposed through." },
  { routes: ["GET /events?kind=&limit="], text: `The journal, one line per ${JOURNAL_KINDS.filter((k) => k !== "all").join(", ")}; <code>kind=</code> filters to one. The <code>metrics</code> snapshot rides the same table and is a number, not a line.` },
  { routes: ["GET /pool/unreferenced?keep=3"], text: "What retention would delete now." },
  { routes: ["GET /cost"], text: `The month's estimated bill, line by line (D1, R2, Workers), the projection and the guard's state. Estimated ${ESTIMATE_CADENCE}; the lines: warn at US$ ${BUDGET_WARN_USD}, pause at US$ ${BUDGET_GUARD_USD}, cap US$ ${BUDGET_CAP_USD}. <code>guard</code> is the word while it is up: the jobs that write are paused and anonymous machines are shed from <code>GET /package/:name</code> and the package page (503, an hour's <code>retry-after</code>).` },
  { routes: ["GET /robots.txt", "GET /sitemap.xml"], root: true, text: `What a crawler may read, at the root of every name: on the dashboard the landing, the docs and the package pages are open to search engines, the API, the sign-in and the pages that are a reader's own are closed to all, and the AI and research crawlers are closed out by name; on <code>${API_HOST}</code> everything is. Every <code>/api/v1</code> answer and the sign-in carry <code>x-robots-tag: noindex, nofollow</code> as well. The sitemap lists the fixed pages, no package pages, nothing read from the database.` },
];

const FACTORY_READ: Row[] = [
  { routes: ["GET /factory?limit=", "GET /factory?live=1"], text: "Workers the pool has heard from (owner, trust, mode, the agent each reported, current task), the queue (every kind: builds, pool jobs, audits — a task's <code>params</code> and <code>result</code> as JSON, the shapes the brain queues and the jobs post), package requests, counts. <code>live=1</code> is what a live page polls: the tasks in flight only (queued or leased), and no counts." },
  { routes: ["GET /factory/packages", "GET /factory/built", "GET /factory/tasks/:id"], text: "The registry of packages people brought, one per name, the most recently updated first (<code>truncated</code> when the answer stops before the last; a row says <code>landed</code> once a maintainer approved it or the project published it, and <code>targets</code> where each architecture stands); what the factory built; one task with its log tail, its approval carrying <code>standing</code>." },
  { routes: ["GET /factory/packages/:name/story"], text: "The factory's view of one package: its registration and the request as the form checks it, <code>targets</code> — each architecture's <code>status</code> (<em>waiting</em>, <em>building</em>, <em>built</em>, <em>not_supported</em>, <em>reviewing</em>, <em>reviewed</em>, <em>approved</em>, <em>published</em>) and the build that says so — every chain with its score, the class it has today, the rings it is in. What the package page and a person's rows draw." },
  { routes: ["GET /factory/names/:name?arches=", "GET /factory/source?url="], text: "The request card's live checks (the Factory, #246). A name: would a request for it be taken now, by the request's own rule — <code>state</code> <em>available</em>, <em>invalid</em>, <em>reserved</em> (a request on its way holds it), <em>taken</em> (in the pool, or shipped by a source on every architecture asked), <em>blocked</em> or <em>busy</em> (being built), <code>why</code> the request's refusal word for word, the holder (<code>owner</code>, <code>status</code>), what a renewal of theirs would meet (<code>renew</code>), what a source ships of it (<code>provided</code>, skipped by a request) and the architectures edge serves it on (<code>in_edge</code>); 30 s at the edge — sending is what reserves the name. A repository's address: the project (the repository, whichever view of it was pasted), the forge and the name the request would take from it, and what the pool reads of it on GitHub, GitLab or Codeberg — description, licence, latest release — and <code>send</code>, the release the request needs named off GitHub. A read is kept at the edge by the repository, 10 min (1 min when it found nothing), for whoever asks; signing in is what makes the pool ask the forge, 60 times an hour at most, and never for a blocked account; nothing is read where <code>SOURCE_CHECK</code> is off." },
  { routes: ["GET /factory/review"], text: "Staged community builds waiting for a maintainer, each with links to its evidence (PKGBUILD, log, .PKGINFO, the audit), the second agent's verdict (<code>ok</code> / <code>warn</code> / <code>block</code>, or <em>queued</em> / <em>failed</em>), its package's <code>targets</code> and <code>can</code>: what you may do on the row — approve, reject, build (claim), withdraw, changes, release, each deciding the whole package — and, where not, why; <code>claim</code> says who claimed it, with which agent, since when; <code>standing</code> says an approval stands on the row's chain; <code>lead</code> marks the one row that speaks for its package, and <code>waits</code> says that row asks for a maintainer's time now — the same for every caller, the rule the Review page highlights by; <code>waiting</code> and <code>oldest_ms</code> count those packages and the age of the oldest; <code>packages</code> lists one entry per package with its rows and <code>state</code> — <em>ready</em> for a claim, <em>in_review</em> once claimed — counted in <code>ready</code> and <code>in_review</code>, the numbers Review's tiles and the Factory's read: one meaning of <em>ready for review</em> and <em>in review</em> on every page. Not cached: the answer is yours." },
  { routes: ["GET /factory/tasks/:id/can"], text: "The same <code>can</code> for one task: <code>{approve, reject, build, withdraw, changes, release, why}</code> for whoever asks — every page draws every button and greys the ones you may not press with this reason. Not cached." },
  { routes: ["GET /factory/tasks/:id/artifacts", "GET /factory/tasks/:id/artifacts/<file>"], text: "What a task has in staging (key, size, when), then a staged build's evidence: <code>PKGBUILD</code>, <code>build.log</code>, <code>PKGINFO</code>, <code>audit.md</code>, <code>audit.json</code> are public; the package itself is for maintainers." },
  { routes: ["GET /factory/approvals", "GET /factory/maintainers", "GET /factory/trust", "GET /factory/blocks"], text: "The record: the newest decisions (<code>truncated</code> when older ones exist) — each one review of a package (<code>review</code>; <code>id</code> stays its first target's approval id, the one the journal names), the architectures it covered in <code>arches</code> and <code>targets</code>, the ones never built in <code>not_supported</code> — with who signed it, whether it stands (<code>standing</code>: approved, not withdrawn) and, for one that stands, where the package is (<code>rings</code>, or none with <code>publish_status</code> and <code>blocked_at</code> — what the pages word as publishing, publish failed or blocked), and for a decision an agent drafted and its maintainer confirmed in the browser, <code>through</code> (the agent, its client, the grant, the draft; null for the web and the command line); the maintainers (from <code>factory/MAINTAINERS.toml</code>, with since when); project-trusted workers, those proposed for it, and each maintainer's own with the agent it reports; what is blocked now and why." },
  { routes: ["GET /users/:login"], text: "A contributor's or maintainer's public profile: packages (each with <code>landed</code>), builds, approvals, workers, and the <em>track record</em> (<a href=\"/docs/governance\">Governance</a>)." },
  { routes: ["GET /users/:login/can"], text: "What you may do on that page: <code>{request, register, token, build, dequeue, remove, revoke, withdraw, own_only, share_worker, why, packages, workers}</code> — the page draws every control for everyone and greys the ones you may not press with the reason in <code>why</code>; <code>packages</code> answers Remove per registration, <code>workers</code> Revoke and the mode per worker (a revoked one, a project's). Not cached: the answer is yours." },
  { routes: ["GET /factory/workers/self"], text: "With a worker token: what that registration is (id, arch, trust, owner, mode) — how the image decides its mode." },
  { routes: ["GET /factory/workers/:id/log"], text: "The worker's own log — the lines between tasks, as it sent them with its claims — for its owner and the maintainers." },
  { routes: ["GET /factory/workers/:id?orders="], text: "One worker as its page shows it: its row as the listing serves it — with when its process started on the pool's clock (<code>up_since</code>), the orders it takes (<code>takes_orders</code>, null for an image from before orders), the ones waiting, what the pool does about an agent that does not answer — its last orders (10, up to 50) without the worker's own words, the rules the page quotes, and the provider's breaker while it holds. Public, cached 10 s." },
  { routes: ["GET /factory/workers/:id/orders?orders="], text: "The same orders with the worker's own words and what its agent said (<code>worker_detail</code>): its owner's and the maintainers', like its log." },
  { routes: ["GET /factory/workers/:id/can"], text: "What the caller may press on the worker's page — re-check its agent, restart it, restart its agent service, drain or resume it, stop its task, update it — each <code>false</code> with the door's own reason in <code>why</code>; <code>details</code> whether the caller reads the worker's words, <code>shared_agent_with</code> the other workers of its host that call the same agent service, <code>update_with</code> the other project workers its set's updater replaces too, as the pool sees them on its host (both only for a caller who may press the button; the host itself is never served), <code>update_note</code> when an Update is carried out, <code>stop</code> the task it holds (its attempt, the latest it goes back to the queue, and how it stops: <code>child</code>, <code>child-or-call</code>, <code>next-call</code> or <code>lease-end</code>)." },
  { routes: ["GET /factory/follow?ids=a,b"], text: "What each set's updater asks every two minutes (#277): the pool's release (<code>latest</code>, <code>deployed_at</code>) and, for each worker named (1 to 16; unknown and revoked ones left out), its release, whether it is <code>outdated</code>, and the id of an open Update (<code>update</code>, or null). The updater runs its round when the release changes — a release, or a rollback — or when an Update it has not run one for appears; it holds no token, and the Update closes when the worker claims on the pool's release. Public — ids, versions and open orders are on <code>/workers</code> already — and cached 30 s." },
  { routes: ["GET /factory/rollback/:to"], text: "The latest rollback statement for going back to release <code>:to</code> (<code>vX.Y.Z</code>), as <code>rollback.yml</code> signed it keyless on <code>main</code> and stored it in R2 (#314): <code>{to, statement, bundle}</code> — <code>statement</code> the exact signed bytes (<code>{schema, seq, to, retracts_through, issued, agent_to, run}</code>), <code>bundle</code> its Sigstore bundle. The pool relays it and cannot forge it: a host's agent checks it with <code>omarchy-agent verify --statement</code> and the rules of <a href=\"/docs/security-model#rollback-statements\">Rollback statements</a>. <code>404</code> when there is none. Public, cached 60 s." },
  { routes: ["GET /factory/me"], text: "With a contributor token, the browser session or an agent token that holds <code>contribute</code>: who you are, your packages, tasks, workers and staging quota — and your agents' grants and their drafts (waiting, confirmed, refused, discarded or expired), and — not to an agent token — your passkeys (a name, the algorithm, when added and last used — never the key), which nobody else sees. Not cached." },
];

const WRITE_JOBS: Row[] = [
  { routes: ["POST /factory/claim", "POST /factory/tasks/:id/heartbeat", "POST /factory/tasks/:id/complete", "POST /factory/tasks/:id/fail"], text: "The worker's protocol: claim the next task of its role and architecture (a lease and the per-job token come back), keep the lease alive, hand the result in, or say why not. A claim that declares the orders its process takes (<code>orders</code>, with its <code>instance</code>) may be answered <code>{\"task\": null, \"orders\": [...]}</code> instead: an order waiting for it, delivered once to that process (#277); a drained worker's claim is a <code>204</code>. A heartbeat, report or upload for a task that is no longer the caller's is <code>409 {\"stop\": true, \"state\"}</code> — <code>stopping</code> while a Stop its task fences it, then what became of it — on every call: the worker stops the task's processes on it, and says it does by declaring <code>stop-task</code> among its <code>orders</code>." },
  { routes: ["POST /factory/workers/self/orders/:id"], text: "The worker's answer to an order it was handed, with its own token (a job token is refused): <code>{instance, outcome: accepted | done | refused | failed, code, detail?, agent?}</code> — only the process the order went to answers, an acceptance once, a final answer once. The code is one of the kind's; the journal and the page say the pool's sentence for it, and the worker's words stay its owner's and the maintainers'." },
  { routes: ["PUT /pool/:sha256?filename=&arch=", "PUT /pool/:sha256/sig?filename=&arch=", "POST /pool/:sha256/multipart?filename=&arch=", "PUT /pool/multipart/:upload/part/:n?key=", "POST /pool/multipart/:upload/complete?key="], text: "Store a package object (integrity-checked, never overwritten) and its upstream signature; a large archive in parts." },
  { routes: ["POST /pool/:sha256/sign?filename=&arch="], text: "The pool signs a package it built (source <em>factory</em>) with its own key; the key never leaves the service." },
  { routes: ["POST /packages?source=&arch=", "POST /packages/known"], text: "Index a manifest; ask which sha256s are already indexed." },
  { routes: ["POST /releases"], text: "Create, promote or roll back a release (an index write). An added package replaces its own source's build of that name; another source's stays (the include's order decides between them). <code>remove</code> drops a name from every source, <code>remove_from</code> (<code>{source, name}</code>) from one; <code>arch</code> moves one architecture only while the other keeps what the ring serves. The lab (<code>ring=lab</code>) takes any object and is never promoted from or into." },
  { routes: ["PUT /releases/:id/artifacts/:kind?repo=&arch="], text: "Publish a rendered database beside the packages (<code>db</code>, <code>db.sig</code>, <code>files</code>, <code>files.sig</code>); the pool signs it as it stores it." },
  { routes: ["PUT /security/advisories", "PUT /security/matches", "POST /security/prune"], text: "The security job's writes: the advisories it read from the feeds, what they match in the rings (a row that did not change is not written), and the prune of what the run did not post — its body is the run's advisory ids and (sha256, advisory) matches; without them it is refused." },
  { routes: ["POST /events", "POST /pool/gc", "POST /pool/relayout"], text: "Record a journal entry — the project's jobs and maintainers only, a community build's token carries no <code>events</code> scope, a maintainer's session or token writes a <code>note</code> and nothing else (the health and abi rows the gate reads are the jobs', #284: <code>code: \"note_only\"</code>), and a run link must be https, a release an id; run retention; one step of the one-time move to one directory per source (the <code>relayout</code> job)." },
  { routes: ["POST /factory/enqueue", "POST /factory/tasks/:id/cancel"], text: "The enqueue job's writes (a maintainer by hand too): queue the project's build of a package for its architectures, cancel a task — by hand, never a claim's rebuild (its release is the door) nor the publish job of an approval that stands (a block is). By hand — a maintainer's session or token — a build is a dry run only (#284): <code>publish: false</code>, built and measured, never published — its job token writes no pool and no ring, and <code>/factory/built</code> leaves it out; <code>publish</code> true or left out is refused with <code>code: \"dry_run_only\"</code>. A build that publishes comes from the enqueue job (a recipe on main) or from an approval." },
  { routes: ["PUT /factory/tasks/:id/artifacts/<file>", "POST /factory/tasks/:id/artifacts/<file>/multipart"], text: "A community build's token uploads its evidence to its own staging workspace, a large file in parts; an audit's token adds <code>audit.json</code> / <code>audit.md</code> to a staged build, and nothing else." },
];

const WRITE_PEOPLE: Row[] = [
  { routes: ["POST /factory/register", "POST /factory/token"], who: "contributor", text: "A GitHub token, used once to read your login and never stored, answers a contributor token (<code>omc_…</code>); signed in on the dashboard, mint or replace the same token from your page. After a reset of your passkeys revoked it, only your page makes the next one: the first is refused with <code>code: \"token_reset\"</code> (#284)." },
  { routes: ["POST /factory/packages", "POST /factory/packages/:name/build", "DELETE /factory/packages/:name/builds/:id", "DELETE /factory/packages/:name", "DELETE /factory/tasks/:id/artifacts"], who: "contributor", text: "Request a package (the project's URL, a description, the licence, the checklist — written once to the record), ask for a build, take a queued build out, remove the request, or drop a finished task's staging objects (the 5 GB quota; the pool reclaims superseded, rejected and published builds itself)." },
  { routes: ["POST /factory/workers"], who: "maintainer", text: "Register a worker (the token is shown once). Maintainers only: the project's compute is its maintainers' hosts, and anyone else is refused with <code>403</code>, <em>your packages build on the pool's hosts</em> (#331)." },
  { routes: ["DELETE /factory/workers/:id", "POST /factory/workers/:id/mode", "POST /factory/workers/self/mode"], who: "contributor", text: "Revoke a worker registered before (its owner or a maintainer), set whether it builds everyone's queue or its owner's packages only — from the page, or the worker itself through its token (<code>omarchy-worker share on|off</code>)." },
  { routes: ["POST /factory/tasks/:id/build", "POST /factory/tasks/:id/approve", "POST /factory/tasks/:id/reject", "POST /factory/tasks/:id/changes", "POST /factory/tasks/:id/release", "POST /factory/tasks/:id/withdraw"], who: "maintainer", text: "Each decides the package the task is a build of — every architecture of it. Claim it: have the project build a contributor's staged package again (<code>{worker, note}</code>: a review worker, whose agent drafts the recipe, and a hint for it) for every architecture its contributor built, once each is built or not supported; approve the project's builds into edge — one review on the record, a publish job per architecture, one that never built not supported — in the browser, with the session and your passkey's answer for this build (<code>{note, assertion}</code>, #271: a request with an Authorization header is refused with <code>code: \"session_only\"</code>, one without the answer with <code>passkey_required</code>); reject with a note — the builds in review stop and a request's name is free again; request changes with a note — the builds in review stop, the name stays the requester's; release a claim (<code>{reason}</code>) — the maintainer who claimed it or another, while a rebuild of it is queued or running, the whole claim with it; or take a standing review back, the reason on the record. Never your own package, nor one whose build in review you asked for — a withdrawal excepted: undoing is not deciding; a maintainer who asked for it is refused with <code>code: \"conflict_of_interest\"</code>, anyone who is not a maintainer with <code>maintainer_only</code>, nobody signed in with <code>sign_in</code>. A refusal answers the reason <code>can</code> gives, and a decision someone else took a moment before answers 409. Every decision — the claim too — is a record signed by the pool and a journal line with who, the door (<code>via</code>) and the agent the review rests on." },
  { routes: ["POST /factory/packages/:name/adopt"], who: "maintainer", text: "<code>{reason?}</code> — the one Adopt, the package page's and Review's <em>No maintainer</em> tab's: you become the package's maintainer in the pool (<code>GET /package/:name</code> says whose it is under <code>maintenance.maintainer</code>). A registration its owner left unmaintained is taken with it: it becomes yours, its bumps come to your workers and another maintainer reviews them — signed on the record, and the answer's <code>registration</code> says whom it was taken from and where it stands. <code>403</code> to anyone who is not a maintainer and to the package's own requester (<code>conflict_of_interest</code>), <code>404</code> when no ring serves it and it is no registration left unmaintained, <code>409</code> when it has a maintainer already — who adopted it, or, for a registration that is not unmaintained, the maintainer whose approval stands — or while a build of an unmaintained registration is still open. One <code>adopt</code> line in the journal says which of the two it did, and who." },
  { routes: ["POST /factory/packages/:name/category"], who: "maintainer", text: "Settle the package's category (<a href=\"/docs/governance#categories\">one of the list</a>) — at review or any time after; a <code>category</code> line in the journal says who and from what." },
  { routes: ["POST /factory/jobs"], who: "maintainer", text: `Queue a pool job by hand (${JOB_KINDS.join(", ")}) — what <code>pkg-repo job</code> calls. A promotion forced past its evidence (<code>promote</code> with <code>force: "yes"</code>) is confirmed in the browser with your passkey, as approve is (#284): <code>{kind, params, assertion}</code>, the answer for <code>promote:force:&lt;from&gt;:&lt;to&gt;[:&lt;arch&gt;]</code>; a request with an Authorization header is refused with <code>code: "session_only"</code>, one without the answer with <code>passkey_required</code>. The answer and the journal's line name the passkey. A rollback's <code>to</code> is a release of its own ring: another ring's is refused with <code>code: "another_ring"</code>.` },
  { routes: ["POST /factory/workers/:id/orders", "DELETE /factory/workers/:id/orders/:oid"], who: "contributor", text: "An order to a worker — <code>{\"kind\": \"recheck-agent\" | \"restart\" | \"restart-agent\" | \"drain\" | \"resume\" | \"stop-task\" | \"update\", \"reason\"?, \"unless_agent_ok\"?, \"task\"?}</code> — from its owner or any maintainer (<code>201</code>, and when it reaches the worker: with its next claim), or one still waiting taken back. A drain holds at once, until a resume (a contributor's worker its owner drained is resumed by its owner only; a project worker a maintainer drained, by a maintainer only); <code>stop-task</code> fences the task the worker holds — <code>task</code>, when given, must be it — which goes back to the queue once the worker has stopped it, by the <code>until</code> its <code>201</code> carries at the latest, and cannot be taken back; neither can a drain. <code>\"update\"</code> is never delivered to the worker: its set's updater reads it from <code>GET /factory/follow</code> and replaces the set within two minutes, and the order closes when the worker claims on the pool's release; it is refused for a worker on the latest release and, for a project worker, unless an updater from #277 on rolls its set out. Every order is capped — 6 restart-type (a stop and an update among them), 6 re-checks and 6 drains per worker an hour, 20 per login an hour, a resume never counted — and on the journal with who and why. The times its words give are the pool's, in UTC. A write with the session is JSON from the pool's own page (<code>415</code>, <code>403 {code: \"origin\"}</code> otherwise); a token's needs the JSON header only with a body." },
  { routes: ["POST /factory/workers/:id/trust"], who: "maintainer", text: "Project trust on two maintainers' word: the first call proposes (<code>202</code>), a second maintainer's — never the same person's; the owner's counts as the second word, never the first — confirms; <code>{\"trust\":\"community\"}</code> takes it back at one word. Each step an event; the trust a signed record under <code>workers/&lt;id&gt;/</code>." },
  { routes: ["POST /factory/record/withdraw"], who: "maintainer", text: "<code>{key, reason}</code> — a record taken off the public bucket (a log that carried what it should not have); its signature and staging copy go with it, and a signed <code>&lt;key&gt;.tombstone.json</code> says who, why and what was there." },
  { routes: ["POST /factory/contributors/:login/block", "POST /factory/contributors/:login/unblock", "POST /factory/packages/:name/block", "POST /factory/packages/:name/unblock"], who: "maintainer", text: "The brake, with a reason on the record: a blocked contributor gets nothing more in (workers revoked, tasks cancelled, packages out of the rings, their projects closed to new accounts); a blocked package leaves every ring. A block is decided in the browser with your passkey (<code>{reason, assertion}</code>, #271), as approve is: no token blocks. Lifting is by another maintainer." },
  { routes: ["POST /factory/drafts", "GET /factory/drafts/:id"], who: "agent", text: "An agent token (<code>oma_…</code>, <code>omarchy-cli login --maintain</code>) drafts a decision and decides nothing: <code>{name, verdict, note, task}</code> — <code>approve</code>, <code>request_changes</code> or <code>reject</code> on the build <code>task</code> of <code>name</code> (<code>review</code>), or <code>{name, verdict: \"block\", note}</code> (<code>block</code>) — runs the web's own rule first and refuses in its words (the requester with <code>code: \"conflict_of_interest\"</code>), then answers the draft with the link its person opens to confirm it (<code>/auth/confirm/&lt;id&gt;</code>) within thirty minutes. A draft writes no journal line. The same token is taken by <code>POST /factory/packages</code> (<code>contribute</code>), <code>GET /factory/me</code> (<code>contribute</code>), <code>POST /factory/tasks/:id/build</code> and <code>/release</code> (<code>review</code>) — a claim through an agent keeps its note for people and gives the project's agent no hint — and refused with 403 and <code>code: \"agent_token\"</code> everywhere else, every decision route among them. Twenty calls a minute per login; five requests, ten claims (a release counts as one) and thirty drafts a day; an agent's write waits while the cost guard is up (503)." },
  { routes: ["POST /factory/grants/:id/revoke"], who: "contributor", text: "Revoke one of your agents' grants (your page's Agents section): its token stops working at once, and the drafts it made that wait for you are discarded." },
  { routes: ["GET /auth/github", "GET /auth/me", "GET /auth/logout"], who: "anyone", root: true, text: "Sign in with GitHub (a session cookie for the dashboard); who is signed in — for a maintainer, whether they hold a passkey (<code>passkey</code>, #287: the pages offer to register the first where an act needs it; left out when the page names the login as one its browser knows holds one, <code>?held=&lt;login&gt;</code>); sign out — the session stops working on the server, the CLI token is untouched." },
  { routes: ["GET /auth/agent?agent=&scopes=&port=&state=&challenge=&method=S256&days=", "POST /auth/agent", "POST /auth/agent/token", "POST /auth/agent/revoke"], who: "anyone", root: true, text: "An agent's grant (<code>omarchy-cli login</code>, RFC 8252 with PKCE S256): the page, for the person signed in, shows the agent's name, the scopes and the expiry — seven days for <code>review</code> or <code>block</code>, a maintainer's only; thirty for <code>contribute</code> by default, ninety at most — and Grant, posted with the session, sends a one-time code to <code>http://127.0.0.1:&lt;port&gt;/</code>. The command swaps it with its verifier (<code>{code, code_verifier}</code>, five tries a minute per address) for the token, shown once; the swap ends a live grant of the same agent name (<code>replaced</code>); three live grants per login, and Grant counted per login at the edge. <code>/auth/agent/revoke</code> with the token is <code>omarchy-cli logout</code>. A grant revoked, however, discards its waiting drafts." },
  { routes: ["GET /auth/confirm/:id", "POST /auth/confirm/:id"], who: "anyone", root: true, text: "A draft, for its own login in the browser: the package, the verdict, the note, who drafted it with which agent and the pool's own evidence; Confirm (the session only — a request with an Authorization header is refused — its Origin and the page's nonce; for approve and block the person's passkey, below; the package's name typed for reject and block) runs the rule again, spends the draft once, and decides through the web's own handler: the decision's row, its signed record and its journal line say it was drafted by the agent and confirmed in the browser — with a passkey, for approve and block. A maintainer without a passkey is told to register one, and nothing is decided." },
  { routes: ["POST /auth/confirm/:id/challenge"], who: "maintainer", root: true, text: "For a draft of approve or block that waits: the options <code>navigator.credentials.get()</code> takes — <code>{publicKey: {challenge, rpId, allowCredentials, userVerification: \"required\", timeout}}</code>, base64url — with the session, the page's Origin and its nonce (form-encoded, <code>nonce=</code>). The challenge is bound to the draft and the login, lives five minutes and is taken once; a new one for the draft replaces the earlier, and five ceremonies wait at most per login (429). Confirm posts the answer with the form (<code>credential</code>, <code>client_data</code>, <code>authenticator_data</code>, <code>signature</code>, <code>user_handle</code>), and the Worker verifies it against the stored key: this challenge, origin and RP id, the user present and verified, the signature, and a counter that moved forward. <code>code: \"no_passkey\"</code> with <code>register</code>, the person's page, when they have none." },
  { routes: ["POST /auth/passkeys/challenge", "POST /auth/passkeys", "POST /auth/passkeys/:id/remove"], who: "maintainer", root: true, text: "Passkeys, on the person's own page (#257), with the browser's session only — any Authorization header is refused — from <code>https://omarchy-pool.org</code> (<code>localhost</code> in development; nowhere else). The first answers the options <code>navigator.credentials.create()</code> takes (this relying party, a user handle, ES256, EdDSA and RS256, user verification required, attestation <code>none</code>, the passkeys held excluded); the second takes <code>{label, id, clientDataJSON, attestationObject}</code> (base64url), verifies it and stores the credential's id and its public key — ten per maintainer; your first with the session alone, any other with <code>assertion</code> from a passkey you hold (#271); the third removes one of your own, with <code>{assertion}</code> from one you hold. Registration and removal are journal lines (<code>passkey</code>): who, when, which passkey and which vouched for it, never the key." },
  { routes: ["POST /auth/passkeys/assert", "POST /auth/passkeys/reset"], who: "maintainer", root: true, text: "#271, with the browser's session only, from the relying party's origin. The first takes <code>{for}</code> — <code>approve:&lt;task&gt;</code>, <code>block:package:&lt;name&gt;</code>, <code>block:contributor:&lt;login&gt;</code>, <code>passkey:add</code>, <code>passkey:remove:&lt;id&gt;</code>, <code>passkey:reset:&lt;login&gt;</code> or <code>promote:force:&lt;from&gt;:&lt;to&gt;[:&lt;arch&gt;]</code> — and answers the options <code>navigator.credentials.get()</code> takes, a challenge bound to your login and that act, five minutes, once; the act posts the answer as <code>assertion</code> (<code>credential</code>, <code>client_data</code>, <code>authenticator_data</code>, <code>signature</code>, <code>user_handle</code>). <code>code: \"no_passkey\"</code> with <code>register</code> when you hold none. The second is a lost passkey's way back, another maintainer's: <code>{login, reason, assertion}</code> — never your own — removes every passkey of the login and signs it out of the browser, one journal line (who, whose, why); its <code>omc_</code> token and its agents' live grants are revoked with them, a line each (#284); a record signed by the pool at <code>contributors/&lt;login&gt;/passkeys-reset-&lt;time&gt;.json</code>." },
];

/** Every route the reference documents under /api/v1, as "METHOD /path" with the query hint dropped — what the test holds against the router. */
export const DOCUMENTED_ROUTES: string[] = [...READ, ...FACTORY_READ, ...WRITE_JOBS, ...WRITE_PEOPLE].filter((r) => !r.root).flatMap((r) => r.routes.map((x) => x.replace(/\?.*$/, "")));

/**
 * The reads the docs index's API section lists (#250, pages/docs.ts): a
 * route as a row above writes it — method, path, query hint — and what it
 * answers in a few words. A reader starts from these; the rest is here.
 * test/lists.test.ts holds each to a read row of this page and to a GET
 * the router serves, so the short table cannot name a route that is gone
 * or one that writes.
 */
export const API_BRIEF: [route: string, returns: string][] = [
  ["GET /package/:name?ring=&arch=", "a package: its version in every ring, what it depends on, its advisories"],
  ["GET /search?q=&ring=&arch=&limit=", "packages in a ring, by name or description"],
  ["GET /releases/:ring?fields=summary&arch=", "the ring's current release, a line per package"],
  ["GET /packages/:sha256/provenance", "the seal of one package file: where it came from, and the proof"],
  ["GET /security?ring=&arch=", "open advisories in a ring, by package"],
  ["GET /events?kind=&limit=", "the journal, newest first"],
  ["GET /factory/packages", "every request, and where it stands"],
  ["GET /factory/review", "what waits for a maintainer"],
];

/** The read rows' routes as they are written, for the test that holds API_BRIEF to them. */
export const READ_ROUTES: string[] = [...READ, ...FACTORY_READ].flatMap((r) => r.routes);

/** A route's cell: every route whole, in a code each. */
const cell = (routes: string[]) => routes.map((r) => `<code>${escapeHtml(r)}</code>`).join(" · ");
const rows = (list: Row[]) => list.map((r) => `      <tr><td>${cell(r.routes)}</td>${r.who ? `<td>${r.who}</td>` : ""}<td>${r.text}</td></tr>`).join("\n");

/** The page's HTML. The API's address is meta's one name for it; the pool's is the deployment's (POOL_URL), so the examples name what this deployment serves. */
const body = (pool: string) => String.raw`
  <h1>API</h1>
  <p class="lede">Everything this site shows comes from a small JSON API at <code>https://${API_HOST}/api/v1</code>. Reads need no authentication and allow cross-origin requests; writes need the per-job token a worker gets when it claims a task — there is no shared secret — or, on the factory's own routes, a maintainer's token.</p>

  <section id="read">
    <h2>Read</h2>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it returns</th></tr></thead><tbody>
${rows(READ)}
    </tbody></table></div>
  </section>

  <section id="factory">
    <h2>The factory (read)</h2>
    <p class="sub">What the factory's pages — Factory, Status, Workers, People, Review, a person's — show. Public, cached briefly.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it returns</th></tr></thead><tbody>
${rows(FACTORY_READ)}
    </tbody></table></div>
  </section>
  <section id="examples">
    <h2>Examples</h2>
    <div class="steps">
      <div class="step"><h3>Which version of a package does each ring serve?</h3>
<pre>for ring in edge rc stable; do
  curl -s "https://${API_HOST}/api/v1/releases/$ring?fields=summary&amp;arch=x86_64" \
    | jq -r --arg r "$ring" '.packages[] | select(.name == "openssl") | "\($r)\t\(.version)"'
done</pre></div>
      <div class="step"><h3>What changed in stable today?</h3>
<pre>curl -s https://${API_HOST}/api/v1/events?kind=promote | jq '.events[0]'
curl -s https://${API_HOST}/api/v1/releases/stable/history | jq '.releases[0:3]'</pre></div>
      <div class="step"><h3>Is the pool healthy right now?</h3>
<pre>curl -s https://${API_HOST}/api/v1/stats \
  | jq '[.latest[] | select(.kind == "health") | {ring, arch: .source, status, at: .created_at}]'</pre></div>
      <div class="step"><h3>The static side (what pacman reads)</h3>
<pre>curl -sI ${pool}/core/x86_64/omarchy-core-stable.db | head -3
curl -s  ${pool}/core/x86_64/omarchy-core-stable.db | tar -tz | head</pre></div>
    </div>
  </section>

  <section id="write-jobs">
    <h2>Write (jobs only)</h2>
    <p class="sub">Bearer <code>omj.…</code>: the per-job token issued at <code>POST /factory/claim</code>, scoped to what that task needs (<code>pool:write</code>, <code>release:&lt;ring&gt;</code>, <code>artifacts:*:&lt;ring&gt;</code>, <code>security:write</code>, <code>gc</code>, <code>events</code>) and valid for its lease. Used by <code>pkg-repo work</code>; documented in <a href="/docs/security-model">the security model</a>. A maintainer queues one of these jobs by hand with <code>POST /factory/jobs</code>.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>What it does</th></tr></thead><tbody>
${rows(WRITE_JOBS)}
    </tbody></table></div>
  </section>

  <section id="write-people">
    <h2>Write (people)</h2>
    <p class="sub">Bearer <code>omc_…</code> (a contributor token from your profile) or the browser session after <em>Sign in with GitHub</em> — and, on the routes of <a href="/docs/omarchy-cli-mcp">omarchy-cli's tools</a> only, an agent's <code>oma_…</code>, which decides nothing: what it drafts, the person confirms in the browser. Approve and block take the browser session and the maintainer's passkey only: no token approves or blocks (#271), nor forces a promotion (#284). Nothing here touches the pool directly: maintainers queue jobs and approve builds; workers do the work with per-job tokens.</p>
    <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Who</th><th>What it does</th></tr></thead><tbody>
${rows(WRITE_PEOPLE)}
    </tbody></table></div>
    <h3 id="doors">What ships, and what guards it</h3>
    <p class="sub">Every door that puts bytes in a ring (#284). None ships what no check and no approval passed without the maintainer's passkey. Taking out ships nothing: a block takes the passkey, a withdrawal the session or the token.</p>
    <div class="table-wrap"><table><thead><tr><th>Door</th><th>What it ships</th><th>What guards it</th></tr></thead><tbody>
      <tr><td>Approve (<code>POST /factory/tasks/:id/approve</code>, an agent's draft confirmed)</td><td>the project's build, into edge — rc and stable too when its trial passed</td><td>the maintainer's passkey, in the browser</td></tr>
      <tr><td>The enqueue job (<code>POST /factory/enqueue</code>, its job token)</td><td>a recipe on main, built and published into edge</td><td>a job token only a project worker is issued</td></tr>
      <tr><td>A build queued by hand (<code>POST /factory/enqueue</code>, a maintainer)</td><td>nothing: a dry run (<code>publish: false</code>), kept on the worker</td><td>anything else is refused (<code>dry_run_only</code>); its job token has no pool and no ring scope</td></tr>
      <tr><td>A sync or a promotion (a job)</td><td>upstream's packages into edge; a ring's head into the ring above</td><td>the upstream's keyring; the gate's evidence, which only the jobs write (a maintainer writes a note)</td></tr>
      <tr><td>A forced promotion (<code>POST /factory/jobs</code>, <code>force: "yes"</code>)</td><td>a ring's head into the ring above, past the gate — both architectures, or one</td><td>the maintainer's passkey, in the browser</td></tr>
      <tr><td>A rollback (<code>POST /factory/jobs</code>, <code>rollback</code>)</td><td>an earlier release of the same ring (another ring's is refused)</td><td>a maintainer's session or token</td></tr>
      <tr><td>A trial (a job, after the project's review build)</td><td>the project's staged build, into the lab: never a promised ring, never promoted</td><td>a staged build of the project's own; a machine takes the lab only with <code>--ring lab</code></td></tr>
    </tbody></table></div>
  </section>
`;

export function apiDocsHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/api",
    title: "API · omarchy-pool",
    description: "The omarchy-pool JSON API: rings, releases, packages, dependency graph, journal.",
    active: "docs",
    doc: "api",
    body: body(poolUrl.replace(/\/$/, "")),
    poolUrl,
    version,
  });
}

/**
 * What /api is made of.
 * The page is a reference: its tables are rows of claims about routes, so
 * each table's entry reads or acts through every endpoint its rows name,
 * on the fixture — a row about a route that is gone, or that answers
 * another shape, fails here by the table's name. A row's anchor is its
 * endpoint's code, not the hint text beside it. The write tables act with
 * the roles the rows refuse, with a body the handler stops at the door, or
 * on a row the fixture has already decided, so the fixture leaves this page
 * as it came; what a decision does is the Review page's and the person's
 * page's to prove.
 */
export const API_DOCS_COMPONENTS = (F: Fixture): Component[] => {
  const stable = `ring=stable&arch=${F.arch}`;
  const noSession = { anonymous: 401, contributor: 401, maintainer: 401 } as const;
  const stagedPackage = `${F.factoryPkg}-1.0-1-${F.arch}.pkg.tar.zst`;
  return [
    {
      id: "api.hero",
      page: "/api",
      anchor: ["<h1>API</h1>", '<p class="lede">Everything this site shows comes from a small JSON API'],
      visible: EVERYONE,
    },
    {
      id: "api.docs-search",
      page: "/api",
      anchor: ['id="docs-q"', 'id="docs-hits"'],
      script: ['$("#docs-q")', '$("#docs-hits")', '$("#docs-nav")', 'class="hit"'],
      visible: EVERYONE,
    },
    {
      id: "api.docs-chapters",
      page: "/api",
      anchor: [
        'id="docs-nav"',
        '<details open><summary><a href="/api" class="on">API</a><small>5</small></summary>',
        'href="/api#read"', 'href="/api#factory"', 'href="/api#examples"', 'href="/api#write-jobs"', 'href="/api#write-people"',
      ],
      visible: EVERYONE,
    },
    {
      id: "api.read-table",
      page: "/api",
      // Every row's cell, as rendered from READ: a row dropped from the served table fails by its routes.
      anchor: ['id="read"', ...READ.map((r) => cell(r.routes))],
      reads: [
        { path: "/api/v1/version", fields: ["version", "commit", "deployed_at", "release_url", "commit_url"] },
        { path: `/api/v1/pacman.conf?ring=stable&arch=${F.arch}`, json: false },
        { path: "/api/v1/signing-key", fields: ["fingerprint", "user", "armored"] },
        { path: "/api/v1/status", fields: ["ok", "state", "api.ok", "index.ok", "index.ms", "pool.ok", "pool.ms", "signing", "checked_at"] },
        {
          path: "/api/v1/stats",
          fields: ["rings", "rings.0.ring", "rings.0.release", "coverage", "coverage.0.late", "pool.objects", "pool.bytes", "series.imports_daily", "series.health", "metrics", "events", "latest", "provenance", "any"],
        },
        {
          path: `/api/v1/releases/stable?fields=summary&arch=${F.arch}`,
          fields: ["release.id", "release.ring", "packages", "packages.0.name", "packages.0.version", "packages.0.arch", "packages.0.filename", "packages.0.sha256", "packages.0.size_download", "packages.0.size_installed", "packages.0.description"],
        },
        { path: `/api/v1/releases/stable?arch=${F.arch}&limit=1&release_id=${F.release}`, fields: ["release.id", "page.limit", "page.returned", "page.total", "page.next", "packages", "packages.0.name"] },
        { path: `/api/v1/releases/stable?arch=${F.arch}&limit=1&after=${F.pkg2}/${F.arch}/core`, fields: ["page.after", "packages", "packages.0.name"] },
        { path: "/api/v1/releases/stable/history", fields: ["ring", "releases", "releases.0.id", "releases.0.seq", "releases.0.parent_id", "releases.0.source_id", "releases.0.is_head"] },
        { path: `/api/v1/releases/stable/diff?arch=${F.arch}`, fields: ["ring", "from", "to.id", "counts.added", "counts.removed", "counts.upgraded", "added", "removed", "upgraded"] },
        { path: `/api/v1/packages/${F.sha}`, fields: ["name", "version", "arch", "sha256", "filename", "size_download", "size_installed", "provides", "requires"] },
        { path: `/api/v1/packages/${F.sha}/provenance`, fields: ["sha256", "name", "source", "object", "origin", "seal", "summary", "upstream.project", "upstream.keyring", "signature", "chain", "attestation"] },
        { path: `/api/v1/search?q=${F.pkg}&${stable}&limit=10`, fields: ["ring", "arch", "release_id", "query", "packages", "packages.0.name", "packages.0.version", "packages.0.description"] },
        { path: `/api/v1/packages?q=${F.pkg}&ring=stable&arch=${F.arch}&limit=10`, fields: ["q", "ring", "arch", "origin", "sort", "page", "limit", "total", "count", "pages", "packages", "packages.0.name", "packages.0.version", "packages.0.arches", "next", "prev", "held"] },
        {
          path: `/api/v1/package/${F.pkg}?${stable}`,
          fields: ["name", "ring", "shown_ring", "rings", "package.version", "package.sha256", "manifest", "depends", "links", "required_by", "security.advisories", "security.exposed", "provenance", "pool_url"],
        },
        { path: `/api/v1/package/${F.pkg}/files?${stable}`, fields: ["name", "ring", "arch", "files"] },
        { path: `/api/v1/graph?${stable}&targets=${F.pkg2}`, fields: ["ring", "arch", "release_id", "source_order", "packages", "packages.0.name", "missing_targets", "truncated"] },
        { path: "/api/v1/security/components", fields: ["components"] },
        {
          path: `/api/v1/security?${stable}`,
          fields: [
            "ring", "arch", "totals.packages", "totals.exposed", "totals.kev", "vulnerable", "vulnerable.0.name", "vulnerable.0.worst", "vulnerable.0.kev", "vulnerable.0.epss",
            "vulnerable.0.fixed_in", "vulnerable.0.exposure", "vulnerable.0.advisories.0.cves", "vulnerable.0.advisories.0.match",
          ],
        },
        { path: "/api/v1/events?kind=promote&limit=12", fields: ["events", "events.0.id", "events.0.kind", "events.0.ring", "events.0.source", "events.0.status", "events.0.summary", "events.0.payload", "events.0.created_at"] },
        { path: "/api/v1/pool/unreferenced?keep=3", fields: ["keep", "grace_days", "protected_releases", "kept_checkpoints", "count", "bytes", "packages"] },
        { path: "/api/v1/cost", fields: ["estimated_at", "status", "month", "month_to_date_usd", "projected_usd", "guard", "lines_usd.warn", "lines_usd.guard", "lines_usd.cap"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "api.factory-read-table",
      page: "/api",
      anchor: ['id="factory"', ...FACTORY_READ.map((r) => cell(r.routes))],
      reads: [
        {
          path: "/api/v1/factory?limit=10",
          fields: ["generated_at", "lease_minutes", "limit", "counts", "workers", "workers.0.id", "workers.0.owner", "workers.0.trust", "workers.0.mode", "workers.0.agent", "workers.0.current_task", "tasks", "tasks.0.id", "tasks.0.kind", "tasks.0.status"],
        },
        { path: "/api/v1/factory/packages", fields: ["truncated", "packages", "packages.0.name", "packages.0.owner", "packages.0.status", "packages.0.arches", "packages.0.staged_builds"] },
        { path: "/api/v1/factory/built", fields: ["built", "built.0.name", "built.0.arch", "built.0.version", "built.0.status", "built.0.id"] },
        {
          path: `/api/v1/factory/tasks/${F.projectTask}`,
          fields: ["task.id", "task.kind", "task.status", "task.name", "task.log_tail", "worker", "from", "audit", "trial", "publish", "approval", "chain", "score", "package", "evidence", "evidence.0.name", "evidence.0.url", "evidence.0.public"],
        },
        {
          path: "/api/v1/factory/review",
          fields: ["staged", "waiting", "oldest_ms", "packages", "packages.0.name", "packages.0.targets", "packages.0.lead", "packages.0.rows", "staged.0.id", "staged.0.kind", "staged.0.owner", "staged.0.waits", "staged.0.lead", "staged.0.targets", "staged.0.evidence.pkgbuild", "staged.0.evidence.log", "staged.0.evidence.pkginfo", "staged.0.evidence.audit", "staged.0.vet", "staged.0.audit.status", "staged.0.trial", "staged.0.can.approve", "staged.0.can.reject", "staged.0.can.build", "staged.0.can.withdraw", "staged.0.can.why"],
        },
        { path: `/api/v1/factory/tasks/${F.stagedTask}/can`, fields: ["task", "can.approve", "can.reject", "can.build", "can.withdraw", "can.changes", "can.release", "can.why.approve"] },
        { path: `/api/v1/factory/tasks/${F.stagedTask}/can`, as: "maintainer", fields: ["task", "can.approve", "can.reject", "can.build", "can.withdraw", "can.changes", "can.release", "can.why.approve"] },
        { path: `/api/v1/factory/packages/${F.factoryPkg}/story`, fields: ["package", "package.name", "package.targets", "targets", "request", "chains", "rings"] },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts`, fields: ["task", "objects", "objects.0.key", "objects.0.size", "objects.0.uploaded_at"] },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/PKGBUILD`, json: false },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/${stagedPackage}`, status: 403 },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/${stagedPackage}`, as: "maintainer", json: false },
        { path: "/api/v1/factory/approvals", fields: ["truncated", "approvals", "approvals.0.id", "approvals.0.review", "approvals.0.task_id", "approvals.0.name", "approvals.0.decision", "approvals.0.by", "approvals.0.standing", "approvals.0.arches", "approvals.0.not_supported", "approvals.0.targets", "approvals.0.targets.0.arch", "approvals.0.rings", "approvals.0.publish_status", "approvals.0.blocked_at", "approvals.0.through"] },
        { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login", "maintainers.0.since", "source", "synced_at"] },
        { path: "/api/v1/factory/trust", fields: ["workers", "workers.0.id", "workers.0.trust", "workers.0.trusted_by", "maintainers", "listed", "source"] },
        { path: "/api/v1/factory/blocks", fields: ["contributors", "packages"] },
        {
          path: `/api/v1/users/${F.owner}`,
          fields: ["login", "role", "github", "packages", "packages.0.name", "packages.0.landed", "builds", "builds.0.id", "build_counts.total", "approvals", "approved_packages", "record", "workers", "workers.0.id"],
        },
        { path: `/api/v1/users/${F.owner}/can`, fields: ["login", "can.request", "can.register", "can.token", "can.build", "can.dequeue", "can.remove", "can.revoke", "can.withdraw", "can.own_only", "can.share_worker", "can.why.request", `can.packages.${F.factoryPkg}.remove`, `can.workers.${F.communityWorker}.revoke`] },
        { path: `/api/v1/users/${F.owner}/can`, as: "owner", fields: ["login", "can.build", "can.remove", "can.why.withdraw", `can.packages.${F.factoryPkg}.remove`, `can.packages.${F.factoryPkg}.why`] },
        { path: `/api/v1/users/${F.owner}/can`, as: "maintainer", fields: ["login", "can.revoke", "can.withdraw", "can.why.build", `can.packages.${F.factoryPkg}.remove`] },
        { path: "/api/v1/factory/workers/self", status: 401 },
        { path: "/api/v1/factory/workers/self", as: "maintainer", status: 401 },
        { path: `/api/v1/factory/workers/${F.worker}/log`, status: 401 },
        { path: `/api/v1/factory/workers/${F.worker}/log`, as: "contributor", status: 403 },
        { path: `/api/v1/factory/workers/${F.worker}/log`, as: "maintainer", fields: ["id", "log", "at"] },
        { path: `/api/v1/factory/follow?ids=${F.worker},${F.communityWorker}`, fields: ["latest", "deployed_at", "poll_s", "workers", "workers.0.id", "workers.0.version", "workers.0.outdated", "workers.0.update"] },
        { path: "/api/v1/factory/follow", status: 400 },
        { path: "/api/v1/factory/me", status: 401 },
        { path: "/api/v1/factory/me", as: "owner", fields: ["contributor.login", "packages", "packages.0.name", "workers", "workers.0.id", "tasks", "tasks.0.id", "staging.bytes", "staging.quota_bytes"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "api.examples",
      page: "/api",
      anchor: [
        'id="examples"',
        "<h3>Which version of a package does each ring serve?</h3>", "<h3>What changed in stable today?</h3>", "<h3>Is the pool healthy right now?</h3>", "<h3>The static side (what pacman reads)</h3>",
      ],
      reads: [
        { path: `/api/v1/releases/stable?fields=summary&arch=${F.arch}`, fields: ["packages.0.name", "packages.0.version"] },
        { path: "/api/v1/events?kind=promote", fields: ["events.0"] },
        { path: "/api/v1/releases/stable/history", fields: ["releases.0"] },
        { path: "/api/v1/stats", fields: ["latest", "latest.0.kind", "latest.0.ring", "latest.0.source", "latest.0.status", "latest.0.created_at"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "api.write-jobs-table",
      page: "/api",
      anchor: ['id="write-jobs"', "<code>POST /factory/claim</code>", ...WRITE_JOBS.map((r) => cell(r.routes))],
      acts: [
        { method: "POST", path: "/api/v1/factory/claim", expect: noSession },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/heartbeat`, expect: noSession },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/complete`, expect: noSession },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/fail`, expect: noSession },
        { method: "PUT", path: "/api/v1/pool/multipart/upload/part/1?key=x", expect: noSession },
        { method: "POST", path: "/api/v1/pool/multipart/upload/complete?key=x", expect: noSession },
        { method: "PUT", path: "/api/v1/security/advisories", expect: noSession },
        { method: "PUT", path: "/api/v1/security/matches", expect: noSession },
        { method: "POST", path: "/api/v1/security/prune", expect: noSession },
        { method: "POST", path: "/api/v1/factory/enqueue", expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/cancel`, expect: { anonymous: 401, contributor: 403 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/artifacts/build.log/multipart`, expect: noSession },
        { method: "PUT", path: `/api/v1/pool/${F.sha}`, expect: noSession },
        { method: "PUT", path: `/api/v1/pool/${F.sha}/sig`, expect: noSession },
        { method: "POST", path: `/api/v1/pool/${F.sha}/multipart`, expect: noSession },
        { method: "POST", path: `/api/v1/pool/${F.sha}/sign`, expect: noSession },
        { method: "POST", path: "/api/v1/packages", expect: noSession },
        { method: "POST", path: "/api/v1/releases", body: { ring: "stable" }, expect: noSession },
        { method: "PUT", path: `/api/v1/releases/${F.release}/artifacts/db`, expect: noSession },
        { method: "POST", path: "/api/v1/events", expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: "/api/v1/pool/gc", expect: noSession },
        { method: "POST", path: "/api/v1/pool/relayout", expect: noSession },
        { method: "PUT", path: `/api/v1/factory/tasks/${F.stagedTask}/artifacts/build.log`, expect: noSession },
      ],
      visible: EVERYONE,
    },
    {
      id: "api.write-people-table",
      page: "/api",
      // …and which doors ship, and what guards each (#284).
      anchor: ['id="write-people"', ...WRITE_PEOPLE.map((r) => cell(r.routes)), '<h3 id="doors">What ships, and what guards it</h3>', "<th>Door</th><th>What it ships</th><th>What guards it</th>"],
      reads: [
        { path: "/auth/github?next=/api", status: 302, json: false },
        { path: "/auth/me", status: 401 },
        { path: "/auth/me", as: "contributor", fields: ["login", "name", "avatar_url", "role"] },
        { path: "/auth/logout", status: 302, json: false },
      ],
      acts: [
        { method: "POST", path: "/api/v1/factory/register", expect: { anonymous: 400, contributor: 400 } },
        { method: "POST", path: "/api/v1/factory/packages", expect: { anonymous: 401, contributor: 400 } },
        { method: "DELETE", path: `/api/v1/factory/packages/${F.factoryPkg}/builds/${F.stagedTask}`, expect: { anonymous: 401, contributor: 403 } },
        // A stranger is refused either way: not his while the worker stands (403), the row's own word once the person's page's manifest, run before this one, has revoked it (404).
        { method: "POST", path: `/api/v1/factory/workers/${F.communityWorker}/mode`, body: { mode: "shared" }, expect: { anonymous: 401, contributor: [403, 404] } },
        { method: "POST", path: "/api/v1/factory/workers/self/mode", body: { mode: "shared" }, expect: { anonymous: 401, contributor: 401 } },
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/category`, body: { category: "other" }, expect: { anonymous: 401, contributor: 403 } },
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/build`, expect: { anonymous: 401, contributor: 404 } },
        { method: "DELETE", path: `/api/v1/factory/packages/${F.factoryPkg}`, expect: { anonymous: 401, contributor: 403 } },
        { method: "DELETE", path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts`, expect: { anonymous: 401, contributor: 403 } },
        { method: "POST", path: "/api/v1/factory/workers", expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "DELETE", path: `/api/v1/factory/workers/${F.communityWorker}`, expect: { anonymous: 401, contributor: 404 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/build`, expect: { anonymous: 401, contributor: 403, owner: 403 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.projectTask}/approve`, body: { note: "reads well" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [403, 409] } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/reject`, body: { note: "the source is not the upstream's" }, expect: { anonymous: 401, contributor: 403, owner: 403 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/withdraw`, body: { note: "nothing stands on this one" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 404 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/changes`, body: { note: "the source is not the upstream's" }, expect: { anonymous: 401, contributor: 403, owner: 403 } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/release`, body: { reason: "a release nobody may make" }, expect: { anonymous: 401, contributor: 403, owner: 403 } },
        // mine is in review, in no ring and no registration left unmaintained: nothing to adopt.
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/adopt`, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 404 } },
        { method: "POST", path: "/api/v1/factory/jobs", expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/workers/${F.worker}/trust`, body: { trust: "project" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } },
        { method: "POST", path: "/api/v1/factory/record/withdraw", expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/contributors/${F.contributor}/block`, expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/contributors/${F.contributor}/unblock`, expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/block`, expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/unblock`, expect: { anonymous: 401, contributor: 403, maintainer: 400 } },
        // ours is served under m2's approval: it has its maintainer, and the probe adopts nothing.
        { method: "POST", path: `/api/v1/factory/packages/${F.publishedPkg}/adopt`, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 409 } },
      ],
      visible: EVERYONE,
    },
  ];
};
