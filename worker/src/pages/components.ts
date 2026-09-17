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

export interface Read {
  /** Concrete path on the fixture (`/api/v1/package/${F.pkg}?ring=stable&arch=x86_64`): the test GETs exactly this. */
  path: string;
  /** Top-level or dotted keys that must be on the JSON answer ("package.version", "events.0.kind"); a key that is there and null passes. */
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
  /** Literal(s) the served HTML must contain: 'id="graph"'. */
  anchor: string | string[];
  /** Literal(s) the page's inline script must contain: '"/api/v1/package/"', "#graph", "required_by". */
  script?: string[];
  reads?: Read[];
  acts?: Act[];
  /** Who the component renders for — documentation now, the headless smoke's checklist later. */
  visible: Role[];
  /** A server-drawn diagram's key, for the overlap test ("factory"). */
  drawn?: string;
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
  /** The stable release's id. */
  release: number;
  /** The sha256 of the pool's zlib object: `/api/v1/packages/<sha>` and its provenance, the security match. */
  sha: string;
  /** "bob": a contributor with nothing of his own — what a signed-in stranger sees. */
  contributor: string;
  /** "alice": the contributor who requested the factory package and runs the community worker. */
  owner: string;
  /** "m1" and "m2", the maintainers; m2 asked for the project's build and approved it. */
  m1: string;
  m2: string;
  /** "mine", alice's package: requested, built by her worker, built again by the project, approved. */
  factoryPkg: string;
  /** The package request's id (`package_requests`), the record's number. */
  request: number;
  /** "w1", the project's worker (m1's): built the project's build, wrote the audit. */
  worker: string;
  /** "w3", alice's community worker: built her evidence. */
  communityWorker: string;
  /** alice's staged build of `mine` with its evidence (PKGBUILD, log, PKGINFO, tests, vet.json) and a finished audit; the project built it again. */
  contributorTask: number;
  /** The project's build of it, staged with its evidence and gate, its trial done, approved by m2 — the one `/build/<id>` and `/factory/tasks/<id>?whole=1` show whole. */
  projectTask: number;
  /** The approval's row id. */
  approval: number;
  /** A later staged community build of `mine`, undecided: probe "build by the project" and "approve" (409: a contributor's build) on it. */
  stagedTask: number;
  /** Another one, to reject: an act that changes the fixture runs on this row. */
  disposableTask: number;
  /** One journal event's id. */
  event: number;
  /** The advisory on zlib ("arch:AVG-9999:zlib"), matched on the pool's object: `/api/v1/security` has a row. */
  advisory: string;
  /** The browser's cookie value (`omc=<value>`) per role; the CLI token of a login is `omc_<login>`, its session `oms_<login>`. */
  sessions: Record<Exclude<Role, "anonymous">, string>;
}

/** The frame every page carries: the account, the footer's links, the mark. */
export const SHELL_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "shell.account",
    page: "/",
    anchor: ['id="account"', 'id="signout"', 'href="/auth/logout"'],
    script: ['"/auth/me"', "#account", "#signout", "me.role"],
    reads: [
      { path: "/auth/me", status: 401 },
      { path: "/auth/me", as: "contributor", fields: ["login", "role"] },
      { path: "/auth/me", as: "maintainer", fields: ["login", "role"] },
    ],
    visible: ["anonymous", "contributor", "owner", "maintainer"],
  },
  {
    id: "shell.footer-more",
    page: "/",
    anchor: MORE.map((m) => `href="${m.href}"`),
    script: ['footer .more a'],
    visible: ["anonymous", "contributor", "owner", "maintainer"],
  },
  {
    id: "shell.icons",
    page: "/",
    anchor: ['<link rel="icon" href="/favicon.ico"', '<link rel="icon" href="/favicon.svg"', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">', '<link rel="manifest" href="/site.webmanifest">'],
    reads: [
      { path: "/favicon.ico", json: false },
      { path: "/favicon.svg", json: false },
      { path: "/apple-touch-icon.png", json: false },
      { path: "/icon-192.png", json: false },
      { path: "/icon-512.png", json: false },
      { path: "/site.webmanifest", json: false },
    ],
    visible: ["anonymous", "contributor", "owner", "maintainer"],
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
