/**
 * The people (#251): no owner, a community on the record. The maintainers
 * are the logins factory/MAINTAINERS.toml lists, as the pool applied it (GET
 * /factory/maintainers, since when), each with what the record says of
 * them: the decisions they signed (GET /factory/approvals), the packages
 * whose standing approval is theirs, and the agent a project worker of
 * theirs reports (GET /factory/trust). The contributors are everyone with a
 * request in the registry (GET /factory/packages), ranked by the packages a
 * maintainer approved — the registry's own `landed`. Then the way in:
 * one package approved, an issue on GitHub (the form in
 * .github/ISSUE_TEMPLATE/maintainer.yml), and a pull request the
 * maintainers open; the button is live for a signed-in contributor with
 * an approved package and grey, with the reason, for everyone else. The
 * rules are the governance chapter's, linked, not said again.
 *
 * Drawn with the v1 kit. Four public reads, each cached at the edge, and
 * no poll: nothing here moves by the minute. Three are the Factory's and
 * the shell's too; the fourth, the project's workers, is a few rows where
 * the whole factory listing (every task counted) was read for the same
 * agents. The workers are on their own page, one link away, and the
 * blocks — an answer no cache keeps — are Review's and a person's page's.
 */
import { page, servedGrey } from "./layout";
import { lucide, type LucideName } from "./kit";
import { EVERYONE, type Component, type Fixture } from "./components";
import { REPO_URL, type RunningVersion } from "../meta";
import { APPLY_URL, GOVERNANCE_FILE } from "../governance";
import { SIGN_IN } from "../routes/contributors";

const FILE = `${REPO_URL}/blob/main/${GOVERNANCE_FILE}`;

/** The three steps, as the card says them: the icon, what to do, one line on it. The governance chapter says them in full. */
const STEPS: [LucideName, string, string][] = [
  ["package-check", "Get one package approved", "Request it in the factory. A maintainer approves it."],
  ["github", "Open an issue on GitHub", "Say why, and link your approved package."],
  ["git-pull-request", "Maintainers open a PR", "It adds you to MAINTAINERS.toml. Merged means you are in."],
];

/** The button as it is served: grey, with the sign-in as its reason, until the script knows who is looking (the shell's gate() draws it again). */
const APPLY_BUTTON = `<a class="op-btn" id="apply" href="${APPLY_URL}">Open the issue</a>`;

const BODY = String.raw`
  <div class="pp">
    <section class="pp-hero">
      <div class="pp-lede">
        <p class="op-eyebrow">People</p>
        <h1 class="op-hero">No owner. A community on the record.</h1>
        <p class="pp-facts"><a href="/status#journal">${lucide("scroll-text", 15)}Every decision in the journal</a><a href="${FILE}">${lucide("file-code", 15)}Maintainers listed in code</a></p>
      </div>
      <div class="op-stats pp-stats" id="tiles">
        <div class="op-stat"><span class="k">Maintainers</span><b class="n" id="n-maintainers"><span class="skl"></span></b><span class="s" id="s-maintainers">in MAINTAINERS.toml</span></div>
        <div class="op-stat"><span class="k">Contributors</span><b class="n" id="n-contributors"><span class="skl"></span></b><span class="s" id="s-contributors">with a request</span></div>
        <div class="op-stat"><span class="k">Reviews</span><b class="n" id="n-reviews"><span class="skl"></span></b><span class="s" id="s-reviews">this month</span></div>
      </div>
    </section>

    <section id="maintainers" aria-labelledby="maintainers-h">
      <h2 class="op-label pp-label" id="maintainers-h">Maintainers</h2>
      <div class="pp-maints" id="maintainers-list">${'<div class="op-card pp-mcard skel"><span class="skl"></span><span class="skl"></span><span class="skl"></span></div>'.repeat(3)}</div>
    </section>

    <div class="pp-pair">
      <section class="op-card pp-contrib" id="contributors" aria-labelledby="contributors-h">
        <div class="op-card-h"><h2 class="pp-h" id="contributors-h">${lucide("users", 16)}Contributors</h2><small>by approved packages</small></div>
        <div class="pp-list" id="contributors-list">${'<span class="pp-person skel"><span class="skl"></span></span>'.repeat(4)}</div>
        <div class="op-card-f pp-foot"><button type="button" class="op-btn" id="contributors-all" hidden>Show all</button><a id="workers" href="/workers">Every worker, how busy →</a></div>
      </section>

      <section class="op-card pp-become" id="become" aria-labelledby="become-h">
        <div class="op-card-h"><h2 class="pp-h" id="become-h">${lucide("shield-check", 16)}Become a maintainer</h2><small><a href="/docs/governance#becoming">the rules →</a></small></div>
        <ol class="pp-steps">
          ${STEPS.map(([icon, title, line]) => `<li><span class="op-box ok pp-box">${lucide(icon, 15)}</span><div><b>${title}</b><span>${line}</span></div></li>`).join("\n          ")}
        </ol>
        <div class="pp-apply"><span id="you">Sign in to see if you are eligible</span><span id="apply-slot">${servedGrey(APPLY_BUTTON, SIGN_IN)}</span></div>
      </section>
    </div>
  </div>
`;

const SCRIPT = String.raw`
  // The maintainer application (src/governance.ts APPLY_URL): the issue form on GitHub.
  var APPLY = ${JSON.stringify(APPLY_URL)};
  // What an approved package is, the registry's own landed: the caption on every contributor's count, as on the Pool's and the Factory's tiles.
  var LANDED = "approved by a maintainer, built by the project";
  // The contributors drawn before "Show all": the first rows of the ranking, two to a row on a wide screen.
  // The maps by login and by name have no prototype: a login or a package may be called constructor.
  var FIRST_ROWS = 16, ALL_ROWS = false, RANKED = [], LISTED = Object.create(null);
  // An agent a worker reports is "<provider>/<model>" (the broker's word, factory/bin/agent.py): its provider's mark in the kit, and the name it goes by.
  var AGENT_MARKS = { anthropic: ["claude-color", "Claude"], "claude-code": ["claude-color", "Claude Code"], openai: ["openai", "OpenAI"], gemini: ["gemini-color", "Gemini"], xai: ["grok", "Grok"] };
  // The three reads the page is drawn from, and the one that dresses it: the maintainers' agents come from the project's workers, and a list of workers that did not answer leaves each card an agent that is not known, never a page that is not drawn. Drawn once the session is known too, since the Become card is the viewer's. A read that did not answer (api() rejects on a 5xx and on the network) is said in the two lists, and the tiles read "—": an empty list stood in for a failed one here, and a pool with people read as one with none.
  Promise.all([
    api("GET", "/api/v1/factory/maintainers"),
    api("GET", "/api/v1/factory/packages"),
    api("GET", "/api/v1/factory/approvals"),
    api("GET", "/api/v1/factory/trust").catch(function (e) { return { down: errorText(e) }; })
  ]).then(function (res) { whoami(function () { drawPeople(res); }); }).catch(function (e) {
    var down = noAnswer("people's lists", e);
    ["maintainers", "contributors", "reviews"].forEach(function (k) { unansweredTile(k, down); });
    $("#maintainers-list").innerHTML = $("#contributors-list").innerHTML = '<p class="pp-note">' + esc(down) + '</p>';
    whoami(function () { drawApply(null, LISTED, down); });
  });
  // A tile over a list that did not answer: "—", and "did not answer" under it with the reason on hover — the lists' line says the sentence once.
  function unansweredTile(k, down) { $("#n-" + k).textContent = "—"; $("#s-" + k).innerHTML = '<span title="' + esc(down) + '">did not answer</span>'; }
  function drawPeople(res) {
    var maint = res[0].maintainers || [], pkgs = res[1].packages || [], decisions = res[2].approvals || [], trust = res[3];
    LISTED = Object.create(null); maint.forEach(function (m) { LISTED[m.login] = true; });
    // Contributors: everyone with a request in the registry, per login the requests and the ones that landed (the registry's flag, never its words), ranked by approved packages, then by requests.
    var by = Object.create(null); RANKED = [];
    pkgs.forEach(function (p) {
      if (!p.owner) return;
      var c = by[p.owner]; if (!c) { c = by[p.owner] = { login: p.owner, requests: 0, approved: 0 }; RANKED.push(c); }
      c.requests++; if (p.landed) c.approved++;
    });
    RANKED.sort(function (a, b) { return b.approved - a.approved || b.requests - a.requests || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0); });
    // Reviews this month: the decisions signed since the first of the month, UTC — approvals and rejections, a withdrawn approval too (the decision was made). The decisions are the newest the record serves (GET /factory/approvals answers a hundred, newest first): a month's and each maintainer's today, with room to spare; a summary of its own the day they are not.
    var now = new Date(), month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    countUp($("#n-maintainers"), maint.length);
    countUp($("#n-contributors"), RANKED.length);
    countUp($("#n-reviews"), decisions.filter(function (a) { return Date.parse(a.created_at) >= month; }).length);
    $("#maintainers-list").innerHTML = maint.map(function (m) { return maintainerCard(m, decisions, trust); }).join("") || '<p class="pp-note">nobody applied yet — the pool reads MAINTAINERS.toml on main every ten minutes</p>';
    drawContributors();
    drawApply(by[WHO.login] || null, LISTED, null);
    endSkeleton();
  }
  // A person's square: the initials of the login's parts, as the design draws a person — no photos anywhere on the dashboard. The login beside it says who; the square is decoration.
  function initialsOf(login, cls) {
    var t = String(login).split(/[-_.]+/).map(function (w) { return w.charAt(0); }).join("").slice(0, 2).toUpperCase();
    return '<span class="pp-av' + (cls ? " " + cls : "") + '" aria-hidden="true">' + esc(t) + '</span>';
  }
  // "since Aug 2026", from the day the pool first applied the login (factory_maintainers.since).
  function monthYear(iso) { var d = new Date(iso); return iso && !isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : ""; }
  // The agent a maintainer reviews with: the one a project worker of theirs reports, the most recently seen first (the listing's order); unknown when none reports one or the list did not answer.
  function agentOf(login, trust) {
    if (trust.down) return '<span class="pp-agent none" title="' + esc("the workers' list did not answer: " + trust.down) + '">—</span>';
    var w = (trust.workers || []).filter(function (x) { return x.owner === login && x.trust === "project" && !x.revoked_at && x.agent; })[0];
    if (!w) return '<span class="pp-agent none" title="no project worker of theirs reports an agent">—</span>';
    var i = w.agent.indexOf("/"), prov = i > 0 ? w.agent.slice(0, i) : "", model = i > 0 ? w.agent.slice(i + 1) : w.agent, m = Object.prototype.hasOwnProperty.call(AGENT_MARKS, prov) ? AGENT_MARKS[prov] : null;
    var label = (m ? m[1] : prov || "agent") + " · " + model;
    return '<span class="pp-agent">' + (m ? agentMark(m[0], label, 14) : '<span title="' + esc(label) + '">' + esc((prov || model).slice(0, 2).toUpperCase()) + '</span>') + '</span>';
  }
  // A maintainer's card: who and since when, the agent, the decisions they signed, and the packages whose standing approval is theirs — what they maintain, a blocked package no longer — each at its own address, in the most stable ring that serves it.
  function maintainerCard(m, decisions, trust) {
    var signed = decisions.filter(function (a) { return a.by === m.login; }), kept = [], seen = Object.create(null);
    signed.forEach(function (a) { if (a.standing && !a.blocked_at && !seen[a.name]) { seen[a.name] = true; kept.push(a); } });
    var names = kept.map(function (a) { return '<a href="' + esc(pkgHref(a.name, servedRing(a.rings), a.arch)) + '">' + esc(a.name) + '</a>'; }).join(" · ");
    return '<article class="op-card pp-mcard">' +
      '<div class="pp-mhead">' + initialsOf(m.login, "lg") + '<div class="pp-who"><a href="' + userHref(m.login) + '" title="' + esc(m.login) + ' · maintainer">@' + esc(m.login) + '</a><span>' + (m.since ? "since " + esc(monthYear(m.since)) : "listed") + '</span></div>' + agentOf(m.login, trust) + '</div>' +
      '<div class="pp-mstats"><div><b>' + num(signed.length) + '</b><span>reviews</span></div><div><b>' + num(kept.length) + '</b><span>maintains</span></div></div>' +
      '<p class="pp-pk" title="' + esc(kept.map(function (a) { return a.name; }).join(" · ")) + '">' + (names || '<span class="pp-none">no package approved yet</span>') + '</p>' +
      '</article>';
  }
  // A contributor's row: the square, @login with "maintainer" for one the file lists, and what they brought — approved packages, or the requests still on their way.
  function contributorRow(c) {
    var m = LISTED[c.login], st = c.approved ? num(c.approved) + " approved" : c.requests === 1 ? "first request in" : num(c.requests) + " requests in";
    var tip = num(c.approved) + " " + LANDED + " · " + num(c.requests) + " requested";
    return '<a class="pp-person" href="' + userHref(c.login) + '" title="' + esc(c.login) + " · " + (m ? "maintainer" : "contributor") + '">' + initialsOf(c.login) + '<span class="pp-name">@' + esc(c.login) + (m ? '<em>maintainer</em>' : '') + '</span><span class="pp-st" title="' + esc(tip) + '">' + st + '</span></a>';
  }
  function drawContributors() {
    var shown = ALL_ROWS ? RANKED : RANKED.slice(0, FIRST_ROWS), more = $("#contributors-all");
    $("#contributors-list").innerHTML = shown.map(contributorRow).join("") || '<p class="pp-note">nobody yet — <a href="/factory">bring the first package</a></p>';
    if (more) { more.hidden = ALL_ROWS || RANKED.length <= FIRST_ROWS; more.textContent = "Show all " + num(RANKED.length); }
  }
  var allBtn = $("#contributors-all"); if (allBtn) allBtn.addEventListener("click", function () { ALL_ROWS = true; drawContributors(); });
  // The way in, for whoever is looking: live for a signed-in contributor with a package a maintainer approved, grey with the reason for everyone else — nobody signed in reads the sign-in first, a maintainer is one already, a contributor with nothing approved yet is told the first step. Over lists that did not answer, a signed-in viewer is told the check could not be made.
  function drawApply(me, listed, down) {
    var ok = false, why = "", line;
    if (!WHO.me) line = "Sign in to see if you are eligible";
    else if (down) { line = "@" + WHO.login + " · could not check"; why = "could not check: " + down; }
    else if (listed[WHO.login]) { line = "You are a maintainer."; why = "you are a maintainer already"; }
    else if (me && me.approved) { ok = true; line = "@" + WHO.login + " · " + num(me.approved) + " approved · eligible"; }
    else { line = "@" + WHO.login + " · no package approved yet"; why = "get one package approved first"; }
    $("#you").textContent = line;
    $("#apply-slot").innerHTML = gate('<a class="op-btn' + (ok ? " primary" : "") + '" id="apply" href="' + esc(APPLY) + '"' + (ok ? ' title="opens the maintainer application on GitHub"' : '') + '>Open the issue</a>', ok, orSignIn(why));
  }
`;

export function peopleHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/people",
    title: "People · omarchy-pool",
    description: "The maintainers and contributors of the Omarchy pool, on the record, and how to become a maintainer.",
    active: "none",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
    kit: true,
  });
}

/**
 * What /people is made of (#251): four public reads, no act of its own
 * (the button opens an issue on GitHub), and one control that changes with
 * the viewer — Open the issue, live for a signed-in contributor with an
 * approved package and grey with the reason for everyone else, never
 * hidden. The section ids are the targets the Pool's tiles link to
 * (#maintainers, #contributors, #workers — the link to the Workers page).
 */
export const PEOPLE_COMPONENTS = (_F: Fixture): Component[] => [
  {
    // The two facts under the title are where the record is: the journal (Status's section since #240) and the file itself.
    id: "people.hero",
    page: "/people",
    anchor: ['<p class="op-eyebrow">People</p>', '<h1 class="op-hero">No owner. A community on the record.</h1>', 'href="/status#journal">', "Every decision in the journal</a>", `href="${FILE}">`, "Maintainers listed in code</a>"],
    visible: EVERYONE,
  },
  {
    // Three tiles, each over the read that feeds it; over reads that did not answer the three read "—" with "did not answer" and the reason on hover.
    id: "people.tiles",
    page: "/people",
    anchor: ['<div class="op-stats pp-stats" id="tiles">', 'id="n-maintainers"', ">in MAINTAINERS.toml</span>", 'id="n-contributors"', ">with a request</span>", 'id="n-reviews"', ">this month</span>"],
    script: ['countUp($("#n-maintainers"), maint.length)', 'countUp($("#n-contributors"), RANKED.length)', 'countUp($("#n-reviews"), decisions.filter(', "Date.parse(a.created_at) >= month", "Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)", "function unansweredTile(k, down)", "did not answer</span>"],
    reads: [
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.owner"] },
      { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.created_at"] },
    ],
    visible: EVERYONE,
  },
  {
    // A card per login the file lists, in its order: since when, the agent a project worker of theirs reports (the kit's mark), the decisions they signed, the packages whose standing approval is theirs, a blocked one not.
    id: "people.maintainers",
    page: "/people",
    anchor: ['<section id="maintainers" aria-labelledby="maintainers-h">', '<h2 class="op-label pp-label" id="maintainers-h">Maintainers</h2>', 'id="maintainers-list"'],
    script: ['api("GET", "/api/v1/factory/maintainers")', 'api("GET", "/api/v1/factory/approvals")', 'api("GET", "/api/v1/factory/trust")', '"#maintainers-list"', "maintainerCard(m, decisions, trust)", "a.by === m.login", "a.standing && !a.blocked_at", "pkgHref(a.name, servedRing(a.rings), a.arch)", "monthYear(m.since)", 'x.trust === "project" && !x.revoked_at && x.agent', "agentMark(m[0], label, 14)", '"no project worker of theirs reports an agent"', "userHref(m.login)"],
    reads: [
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login", "maintainers.0.since"] },
      { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.by", "approvals.0.name", "approvals.0.arch", "approvals.0.standing", "approvals.0.rings", "approvals.0.blocked_at"] },
      { path: "/api/v1/factory/trust", fields: ["workers", "workers.0.owner", "workers.0.trust", "workers.0.agent", "workers.0.revoked_at"] },
    ],
    visible: EVERYONE,
  },
  {
    // Everyone with a request, ranked by the packages that landed (the registry's flag, captioned as what it counts), the file's logins tagged; the first rows, then Show all.
    id: "people.contributors",
    page: "/people",
    anchor: ['<section class="op-card pp-contrib" id="contributors" aria-labelledby="contributors-h">', "Contributors</h2><small>by approved packages</small>", 'id="contributors-list"', '<button type="button" class="op-btn" id="contributors-all" hidden>Show all</button>'],
    script: ['api("GET", "/api/v1/factory/packages")', "p.landed", "if (p.landed) c.approved++", '"approved by a maintainer, built by the project"', "b.approved - a.approved || b.requests - a.requests", '"#contributors-list"', "contributorRow", "userHref(c.login)", "<em>maintainer</em>", '"first request in"', "Show all ", 'noAnswer("people\'s lists", e)', '$("#maintainers-list").innerHTML = $("#contributors-list").innerHTML', 'href="/factory">bring the first package</a>'],
    reads: [
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.owner", "packages.0.status", "packages.0.landed"] },
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
    ],
    visible: EVERYONE,
  },
  {
    // The workers are on their own page: the one link to it from the frame's pages, and the anchor the Pool's workers tile lands on.
    id: "people.workers-link",
    page: "/people",
    anchor: ['<a id="workers" href="/workers">Every worker, how busy →</a>'],
    reads: [{ path: "/workers", json: false }],
    visible: EVERYONE,
  },
  {
    // The three steps, and the rules one link away in the governance chapter.
    id: "people.become",
    page: "/people",
    anchor: ['<section class="op-card pp-become" id="become" aria-labelledby="become-h">', "Become a maintainer</h2>", 'href="/docs/governance#becoming">the rules →</a>', ...STEPS.map(([, title]) => `<b>${title}</b>`)],
    visible: EVERYONE,
  },
  {
    // Open the issue: served grey with the sign-in as its reason (servedGrey), drawn again through the shell's gate() once the session and the lists answered — live only for a signed-in contributor with an approved package. The session is the shell's read; eligibility is the registry's, the same read the list is drawn from.
    id: "people.apply",
    page: "/people",
    anchor: ['<span id="you">Sign in to see if you are eligible</span>', 'id="apply-slot"', `id="apply" data-href="${APPLY_URL}" tabindex="-1" aria-disabled="true" title="${SIGN_IN}">Open the issue</a>`],
    script: ["function drawApply(me, listed, down)", 'whoami(function () { drawPeople(res); })', "drawApply(by[WHO.login] || null, LISTED, null)", '"#apply-slot"', "gate('<a class=\"op-btn'", "orSignIn(why)", '"you are a maintainer already"', '"get one package approved first"', '" approved · eligible"', `var APPLY = ${JSON.stringify(APPLY_URL)}`],
    reads: [
      { path: "/auth/me", status: 401 },
      { path: "/auth/me", as: "owner", fields: ["login", "role"] },
      { path: "/auth/me", as: "maintainer", fields: ["login", "role"] },
    ],
    visible: EVERYONE,
  },
];
