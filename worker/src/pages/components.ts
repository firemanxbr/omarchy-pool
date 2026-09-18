/**
 * What each page is made of, for the tests — and for anyone asking what a
 * page reads. A component is a piece of a page a person can point at: its
 * anchor in the served HTML, what its script names, what it reads, what it
 * can do, and who sees it. Each page module exports its own list next to
 * its template (`PACKAGE_COMPONENTS` below `packageHtml()`), as a function
 * of the fixture so the ids are bound once; `allComponents(F)` is the whole
 * dashboard. test/components.test.ts walks it: every anchor is in the
 * served page, every script literal is in the page's inline script, every
 * read is routed and answers JSON with the fields the page draws, every act
 * is routed with its method and gated by role. The acorn walk in
 * test/pages.test.ts still proves the script's names; this proves the
 * other three name spaces — DOM ids, server paths, JSON keys.
 *
 * The concrete-path rule: the test must be able to hit the endpoint, so an
 * entry says `/api/v1/factory/tasks/${F.projectTask}/approve`, never
 * `/tasks/:id`. The fixture (test/fixture.ts) is what the paths are bound
 * to, and a manifest may only use what it seeds.
 *
 * Sizing: a component is a visible unit with a read or an action of its own
 * — a table with its endpoint, a card with its chart, a row of buttons with
 * what they post. Not a helper: the shell's functions (`whoami`, `pager`,
 * `wtId`) belong to the acorn walk, and a component that uses them names
 * only what it draws. Static prose — a hero, a docs chapter's text — gets an
 * anchor and nothing else, so a template edit that drops it still fails.
 *
 * Adding a page: export its list below its `<name>Html()` and spread it
 * into `allComponents` — an entry that is not in the whole is never
 * checked. The test also reads the page the other way: a `fetch()` in its
 * script whose path no entry on that page (or the shell) claims fails by
 * the page's name, so a new read or act is declared the day it is written.
 */
import { MORE } from "./layout";
import { OVERVIEW_COMPONENTS } from "./overview";
import { FACTORY_COMPONENTS } from "./contribute";
import { REVIEW_COMPONENTS } from "./review";
import { PIPELINE_COMPONENTS } from "./pipeline";
import { PACKAGES_COMPONENTS, PACKAGE_COMPONENTS } from "./packages";
import { BUILD_COMPONENTS } from "./build";
import { USER_COMPONENTS } from "./user";
import { PEOPLE_COMPONENTS } from "./people";
import { WORKERS_COMPONENTS } from "./workers";
import { SECURITY_COMPONENTS } from "./security";
import { STATUS_COMPONENTS } from "./status";
import { JOURNAL_COMPONENTS } from "./journal";
import { REQUEST_COMPONENTS } from "./request";
import { DIFF_COMPONENTS } from "./diff";
import { API_DOCS_COMPONENTS } from "./api-docs";
import { DOCS_COMPONENTS } from "./docs";
import { GET_STARTED_COMPONENTS } from "./get-started";
import { DOCS_WORKERS_COMPONENTS } from "./docs-workers";
import { HOW_IT_WORKS_COMPONENTS } from "./how-it-works";
import { DOCS_SECURITY_COMPONENTS } from "./docs-security";
import { GOVERNANCE_COMPONENTS } from "./governance";
import { GLOSSARY_COMPONENTS } from "./glossary";

/** Who is looking: nobody signed in, a contributor who owns nothing here, the contributor who owns the fixture's package and worker, a maintainer. */
export type Role = "anonymous" | "contributor" | "owner" | "maintainer";
/** What renders for anyone who opens the page. */
export const EVERYONE: Role[] = ["anonymous", "contributor", "owner", "maintainer"];
/** What a session unlocks, whoever holds it. */
export const SIGNED_IN: Role[] = ["contributor", "owner", "maintainer"];

export interface Read {
  /** Concrete path on the fixture (`/api/v1/package/${F.pkg}?ring=stable&arch=x86_64`): the test GETs exactly this. */
  path: string;
  /** Top-level or dotted keys that must be on the JSON answer ("package.version", "events.0.kind"); a step `key=value` picks the first row of a list by that field ("tasks.kind=sync.result.sources"); a key that is there and null passes. */
  fields?: string[];
  /** Who the request is made as; anonymous unless the component reads something a session unlocks. */
  as?: Role;
  /** Expected status when not 200 (a 401 probe the page relies on, a 404 the page renders). */
  status?: number;
  /** False for a read that is not JSON — an icon, a manifest, a log: the test checks the status only. */
  json?: false;
}

export interface Act {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  /**
   * Status per role; the test sends the fixture's session cookie for each
   * role listed and sends nothing for a role left out. A list where the
   * second call may answer differently (an approve, then "already approved").
   */
  expect: Partial<Record<Role, number | number[]>>;
  body?: unknown;
}

export interface Component {
  /** "<page>.<name>", as the catalogs name them: "package.graph", "review.decision-buttons". */
  id: string;
  /** The page the test GETs, concrete: "/package/zlib", `/build/${F.projectTask}`. */
  page: string;
  /** Literal(s) the served HTML must contain: 'id="graph"'. Empty for a piece of the shell's script that draws into no element of its own. */
  anchor: string | string[];
  /** Literal(s) the page's inline script must contain: '"/api/v1/package/"', "#graph", "required_by". */
  script?: string[];
  reads?: Read[];
  acts?: Act[];
  /** Who the component renders for. */
  visible: Role[];
  /** A server-drawn diagram's key ("factory", "docs/factory-loop"): the overlap test in test/pages.test.ts draws exactly the keys the manifests claim. */
  drawn?: string;
  /**
   * A component the shell draws the same on every page that has it: the
   * worker tables (workerPanels() served, wtTables() and workerRow() live)
   * and their legend. A page that claims it is proved to draw it with the
   * shell's head and row and no hand-written cell (test/pages.test.ts), and
   * a page that serves a worker table without claiming it fails there.
   */
  shared?: "worker-table" | "worker-legend";
}

/**
 * What test/fixture.ts seeds and hands back: the ids every manifest binds
 * its paths to. One architecture (x86_64) throughout.
 */
export interface Fixture {
  /** The architecture everything is for: the pool's packages, the workers, the builds. */
  arch: string;
  /** "zlib", indexed from core into the stable release; xz requires it, so `/api/v1/package/zlib` has `required_by`. */
  pkg: string;
  /** "xz", indexed beside it; it declares zlib and loads libz.so.1, so `/api/v1/package/xz` has `depends` and `links`. */
  pkg2: string;
  /** The stable head's id: the second stable release, whose diff against F.previousRelease has an upgrade, an addition and a removal. */
  release: number;
  /** The first stable release, the head's parent: what a rollback goes back to. */
  previousRelease: number;
  /** The sha256 of the pool's zlib object: `/api/v1/packages/<sha>` and its provenance, the security match. */
  sha: string;
  /** "bob": a contributor with nothing of his own — what a signed-in stranger sees. */
  contributor: string;
  /** "alice": the contributor who requested the factory package and runs the community worker. */
  owner: string;
  /** "m1" and "m2", the maintainers; m2 asked for the project's build and approved it. */
  m1: string;
  m2: string;
  /** "mine", alice's package: requested, built by her worker, built again by the project, approved — its publish job waits. */
  factoryPkg: string;
  /** "ours", alice's other package, the whole way: published by the project into edge, so `/api/v1/package/ours?ring=edge` has the factory branch and the seal's chain. */
  publishedPkg: string;
  /** "w1", the project's worker (m1's): built the project's build, wrote the audit. */
  worker: string;
  /** "w3", alice's community worker: built her evidence. */
  communityWorker: string;
  /** alice's staged build of `mine` with its evidence (PKGBUILD, log, PKGINFO, tests, vet.json) and a finished audit; the project built it again. */
  contributorTask: number;
  /** The project's build of it, staged with its evidence and gate, its trial done, approved by m2 — the one `/build/<id>` and `/factory/tasks/<id>?whole=1` show whole. */
  projectTask: number;
  /** A later staged community build of `mine`, undecided: probe "build by the project" and "approve" (409: a contributor's build) on it. */
  stagedTask: number;
  /** Another one, to reject: an act that changes the fixture runs on this row. */
  disposableTask: number;
  /** A third, for a second page whose act rejects a row of its own. */
  spareTask: number;
  /** "carol", blocked by m1: the brake's table has a row, and m2 is the other maintainer who could lift it. */
  blockedContributor: string;
  /** "hers", carol's package, blocked by m1 before she was. */
  blockedPkg: string;
  /** "dave": the contributor whose two packages m1 approved and no ring serves. */
  outsider: string;
  /** "lost", dave's package: approved by m1, its publish job failed on w1 — the registry still says approved; the row of GET /factory/approvals says `publish_status: "failed"`. */
  failedPkg: string;
  /** "pulled", dave's other package: approved by m1, then blocked by m2 with the approval standing — the row says `blocked_at`, its publish job is cancelled. */
  pulledPkg: string;
  /** The id of the one done pool job of each kind — sync, promote, rollback, render, health, gc, security, verify, relayout, enqueue, and the three on a build: audit, trial, publish (ours', run through the API) — its params as the brain queues them and its result as work.rs posts it: what the Pipeline's table words. */
  jobs: Record<string, number>;
  /** The browser's cookie value (`omc=<value>`) per role; the CLI token of a login is `omc_<login>`, its session `oms_<login>`. */
  sessions: Record<Exclude<Role, "anonymous">, string>;
}

/**
 * The frame every page carries: the account, the footer's links, the mark —
 * and the two fetches the shell's script makes on every page, the stats
 * poll and the worker's log, so a page's own entries need not claim them.
 */
export const SHELL_COMPONENTS = (F: Fixture): Component[] => [
  {
    // The header's Sign in carries the page it is pressed on as `next`, so the sign-in comes back to it; /me is the reader's own page, a redirect that needs the session to know where.
    id: "shell.account",
    page: "/",
    anchor: ['id="account"', 'href="/auth/github?next=/"', 'id="signout"', 'href="/auth/logout"'],
    script: ['"/auth/me"', "#account", "#signout", "me.role", "function signInHref()", "location.search"],
    reads: [
      { path: "/auth/github?next=/", status: 302, json: false },
      { path: "/me", status: 302, json: false },
      { path: "/auth/me", status: 401 },
      { path: "/auth/me", as: "contributor", fields: ["login", "role"] },
      { path: "/auth/me", as: "maintainer", fields: ["login", "role"] },
    ],
    visible: EVERYONE,
  },
  {
    // Every page with a route of its own that is not a door: the footer is where a reader finds People and the Request, not only a page's content.
    id: "shell.footer-more",
    page: "/",
    anchor: MORE.map((m) => `href="${m.href}"`),
    script: ['footer .more a', 'href === "/packages" && here.indexOf("/package/") === 0', 'href === "/journal" && here === "/diff"'],
    visible: EVERYONE,
  },
  {
    // The maintainer set, read once per page from the one list the pool keeps (maintainerSet, as whoami reads the session): the role a person is drawn with when the caller passes none — avatar, avatarIcon, personChip, personLink — and the mark that colours a person drawn before the answer landed. Every page fetches it lazily, from the first person drawn, so the shell claims the read for all of them.
    id: "shell.maintainers",
    page: "/",
    anchor: [],
    script: ["function maintainerSet(", '"/api/v1/factory/maintainers"', "function roleOf(", "function markRoles(", "data-who", "function personLink(", "function avatar("],
    reads: [{ path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login", "maintainers.0.since"] }],
    visible: EVERYONE,
  },
  {
    // A package's one address (pkgHref: the ring the row is about and the architecture, always both) and the ring a row carries: the most stable ring that serves it (servedRing, by the reader's order) or, for a build, the lab while nobody decided (ringOfBuild).
    id: "shell.package-address",
    page: "/",
    anchor: [],
    script: ["function pkgHref(", "Object.keys(RINGS_TEXT)[0]", "function ringName(", "function servedRing(", "function ringOfBuild(", 'status === "staged" ? "lab" : null'],
    visible: EVERYONE,
  },
  {
    // Where a standing approval is today (approvalWhere): one rule over the row's rings, blocked_at and publish_status — "in <rings>", "blocked", "publish failed" or "publish cancelled", "publishing" — drawn by the Factory's Landed lately and Review's Decided line, so the two pages say one word of one approval; no page guesses a ring from the registry's status. The read is the list both pages draw it from, with the three fields the rule reads.
    id: "shell.approval-where",
    page: "/",
    anchor: [],
    script: ["function approvalWhere(", 'a.publish_status === "failed" || a.publish_status === "cancelled"', 'word: "publishing"'],
    reads: [{ path: "/api/v1/factory/approvals", fields: ["approvals.0.rings", "approvals.0.blocked_at", "approvals.0.publish_status"] }],
    visible: EVERYONE,
  },
  {
    // A person's one address (userHref), written by the avatars, the chips, the links and the account chip — no page writes it by hand.
    id: "shell.person-address",
    page: "/",
    anchor: [],
    script: ["function userHref(", 'return "/user/" + encodeURIComponent(login)'],
    visible: EVERYONE,
  },
  {
    // A build's evidence has one address (evidenceHref): its page's Evidence section, which lists what the build left and says when it left nothing. The rows that offer a build's log — a person's builds, the Pipeline's tasks, the checklist's build items — link there through evidenceLink and never a raw file by name, so a build that died before uploading links a page, not a 404. The read is the page the fragment lands on; build.evidence-list anchors the section.
    id: "shell.evidence-address",
    page: "/",
    anchor: [],
    script: ["function evidenceHref(", 'return "/build/" + id + "#evidence"', "function evidenceLink(", 'href="\' + evidenceHref(t.id) + \'"'],
    reads: [{ path: `/build/${F.contributorTask}`, json: false }],
    visible: EVERYONE,
  },
  {
    // A source late by one constant: LATE_MS is the server's LATE_AFTER_HOURS spliced in (meta.ts), read through lateSync — the server's mark first — and named by problemsOf.
    id: "shell.late-sync",
    page: "/",
    anchor: [],
    script: ["var LATE_MS = ", "function lateSync(c)", "Math.round(LATE_MS / 3600e3)"],
    visible: EVERYONE,
  },
  {
    // The workers counted once (workerCounts: registered, alive, ready, building, and the same per kind), on every tile that counts them.
    id: "shell.worker-counts",
    page: "/",
    anchor: [],
    script: ["function workerCounts(", "byKind"],
    visible: EVERYONE,
  },
  {
    // Open advisories counted one way: advisoriesAt(d, conf) keeps the rows of a security report that count at a confidence — the Security page's default, SEC_CONF, unless a page says — and advisoryCounts(rows) is the numbers a tile or a chart draws; the Pool, the Pipeline and the Security page say one number for stable.
    id: "shell.advisory-counts",
    page: "/",
    anchor: [],
    script: ["var SEC_CONFS = ", "function confOk(conf, m)", "function advisoriesAt(d, conf)", "function advisoryCounts(rows)", "function confWord(conf)"],
    visible: EVERYONE,
  },
  {
    // One call to the API (api): a 4xx resolves with its body and __status, a 5xx rejects with the body's error — never the list a page asked for. A list that did not answer is said, not drawn: noAnswer writes "the <list> did not answer: <reason>" into the page's line and ends the skeleton, tilesUnanswered draws "—" for every number with the reason under it. A 0 over a query that threw read as "nothing waiting" in green on three pages (2026-09-18); test/no-answer.test.ts runs the pages over a 500.
    id: "shell.no-answer",
    page: "/",
    anchor: [],
    script: ["function api(", "if (r.status >= 500) throw new Error(", "d.__status = r.status", "function errorText(", "function noAnswer(", '" did not answer: "', "function tilesUnanswered(", '"—"'],
    visible: EVERYONE,
  },
  {
    // The oldest waiting row's age and every other span said the same way: span(ms), "3h" with no "ago".
    id: "shell.span",
    page: "/",
    anchor: [],
    script: ["function span(ms)"],
    visible: EVERYONE,
  },
  {
    // liveStats(): the poll behind every page's tiles and charts, and the service check it runs first — which fetches only when the header has a pill, which no page has today.
    id: "shell.live-stats",
    page: "/",
    anchor: [],
    script: ["function liveStats(", '"/api/v1/stats"', "function serviceStatus(", '"/api/v1/status"', "pipelineFrom(d)"],
    reads: [
      { path: "/api/v1/stats", fields: ["generated_at", "version", "rings", "pool", "series", "metrics", "latest"] },
      { path: "/api/v1/status", fields: ["ok", "state", "index.ok", "pool.ok"] },
    ],
    visible: EVERYONE,
  },
  {
    // The icon on every worker's row that opens its own log: live for its owner and the maintainers, grey with the pool's refusal for everyone else.
    id: "shell.worker-log",
    page: "/",
    anchor: [],
    script: ["data-wlog", '"/log"', "d.log", "function wtLog(w) { return ' ' + gate("],
    reads: [
      { path: `/api/v1/factory/workers/${F.worker}/log`, status: 401 },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "contributor", status: 403 },
      { path: `/api/v1/factory/workers/${F.communityWorker}/log`, as: "owner", fields: ["id", "log", "at"] },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "maintainer", fields: ["id", "log", "at"] },
    ],
    visible: EVERYONE,
  },
  {
    // The rollback button a maintainer sees on a release (the Journal, the Pipeline) is the shell's: it asks, posts the job once and leaves the button disabled.
    id: "shell.rollback",
    page: "/",
    anchor: [],
    script: ["function askRollback(", 'button[data-rollback]', '"/api/v1/factory/jobs"', 'kind: "rollback", params: { ring: ring, to: to, note: note }', "#rb-state"],
    acts: [{ method: "POST", path: "/api/v1/factory/jobs", body: { kind: "rollback", params: { ring: "stable", to: String(F.previousRelease), note: "the shell's rollback, from the fixture" } }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 201 } }],
    visible: ["maintainer"],
  },
  {
    // A control gated by role (gate): the same control for everyone, disabled with why in its title for the role that may not use it; the CSS that greys it and the click that stops a gated link are the shell's.
    id: "shell.gate",
    page: "/",
    anchor: ["button[disabled], select[disabled], input[disabled], textarea[disabled], a.disabled {", ".decide {"],
    script: ["function gate(", 'aria-disabled="true"', 'closest("a.disabled")', "function gatePill(", "function auditPill(", "function trialPill("],
    visible: EVERYONE,
  },
  {
    // The Decision cell (decisionCell) and its click: the four decisions on a staged build post through the shell, and the dialog for the project's build reads the project's workers first. The act is claimed by the roles that change nothing; the maintainer's are the pages' (Review's decision buttons, a build's page).
    id: "shell.decide",
    page: "/",
    anchor: [],
    script: ["function decisionCell(", "function decideDialog(", "function onDecided(", ".decide button[data-approve]", '"/api/v1/factory/tasks/" + id + "/" + what', '"/api/v1/factory?limit=10"', "whereOptions(ws"],
    reads: [{ path: "/api/v1/factory?limit=10", fields: ["workers", "workers.0.id", "workers.0.arch", "workers.0.side", "workers.0.kinds", "workers.0.alive", "workers.0.agent_status", "workers.0.labels"] }],
    acts: [{ method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/withdraw`, body: { note: "the shell's withdraw, from the fixture" }, expect: { anonymous: 401, contributor: 403, owner: 403 } }],
    visible: EVERYONE,
  },
  {
    // The mark, as the head names it and as browsers ask for it by name (icons.ts).
    id: "icons.favicons",
    page: "/",
    anchor: ['<link rel="icon" href="/favicon.ico"', '<link rel="icon" href="/favicon.svg"', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">', '<link rel="manifest" href="/site.webmanifest">'],
    reads: [
      { path: "/favicon.ico", json: false },
      { path: "/favicon.png", json: false },
      { path: "/favicon.svg", json: false },
      { path: "/apple-touch-icon.png", json: false },
      { path: "/apple-touch-icon-precomposed.png", json: false },
      { path: "/icon-192.png", json: false },
      { path: "/icon-512.png", json: false },
      { path: "/site.webmanifest", json: false },
    ],
    visible: EVERYONE,
  },
];

export function allComponents(F: Fixture): Component[] {
  return [
    ...SHELL_COMPONENTS(F),
    ...OVERVIEW_COMPONENTS(F),
    ...FACTORY_COMPONENTS(F),
    ...REVIEW_COMPONENTS(F),
    ...PIPELINE_COMPONENTS(F),
    ...PACKAGES_COMPONENTS(F),
    ...PACKAGE_COMPONENTS(F),
    ...BUILD_COMPONENTS(F),
    ...USER_COMPONENTS(F),
    ...PEOPLE_COMPONENTS(F),
    ...WORKERS_COMPONENTS(F),
    ...SECURITY_COMPONENTS(F),
    ...STATUS_COMPONENTS(F),
    ...JOURNAL_COMPONENTS(F),
    ...REQUEST_COMPONENTS(F),
    ...DIFF_COMPONENTS(F),
    ...API_DOCS_COMPONENTS(F),
    ...DOCS_COMPONENTS(F),
    ...GET_STARTED_COMPONENTS(F),
    ...DOCS_WORKERS_COMPONENTS(F),
    ...HOW_IT_WORKS_COMPONENTS(F),
    ...DOCS_SECURITY_COMPONENTS(F),
    ...GOVERNANCE_COMPONENTS(F),
    ...GLOSSARY_COMPONENTS(F),
  ];
}
