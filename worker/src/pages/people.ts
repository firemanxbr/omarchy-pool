/**
 * The people (#251): no owner, a community on the record. The maintainers
 * are the logins factory/MAINTAINERS.toml lists, as the pool applied it (GET
 * /factory/maintainers, since when), each with what the record says of
 * them: the decisions they signed (GET /factory/approvals), the packages
 * whose standing approval is theirs — the newest that stands on each
 * architecture, so a package another maintainer approved again is the
 * other's — and the agent their workers report, a project worker's first
 * (GET /factory/trust, which lists every maintainer's workers). The
 * contributors are everyone with a request in the registry (GET
 * /factory/packages), ranked by the packages a maintainer approved — the
 * registry's own `landed`. Both reads are windows of the record, the newest
 * rows; a number over a window the server says it cut (`truncated`) is
 * drawn as a floor, "12+", never as the whole. Then the way in: one package
 * approved, an issue on GitHub (the form in
 * .github/ISSUE_TEMPLATE/maintainer.yml), and a pull request the
 * maintainers open; the button is live for a signed-in contributor with an
 * approved package — their own record says so (GET /users/<login>), not a
 * window — and grey, with the reason, for everyone else. The rules are the
 * governance chapter's, linked, not said again.
 *
 * Drawn with the v1 kit, and its own rules (CSS) are served with it alone.
 * Four public reads, each cached at the edge, a fifth for a signed-in
 * viewer (their profile, cached too), and no poll: nothing here moves by
 * the minute. Three are the Factory's and the shell's too; the fourth, the
 * project's and the maintainers' workers, is a few rows where the whole
 * factory listing (every task counted) was read for the same agents. The
 * workers are on their own page, one link away, and the blocks — an answer
 * no cache keeps — are Review's and a person's page's.
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

/**
 * What the kit has no piece for — the page's 1120px frame, a person's
 * square, a maintainer's card, a contributor's row, the steps to join —
 * served with this page only (page({ css })), after the frame's CSS and the
 * kit's sheet. Every rule sits under a pp- class, and .pp in front where it
 * sets what a kit rule sets.
 */
const CSS = String.raw`
  .pp { max-width: 1056px; margin: 0 auto; padding-top: 12px; display: grid; gap: 36px; }
  .pp section { margin: 0; } .pp a { text-decoration: none; }
  /* Keyboard focus is the design system's in the page as in the frame: a 1px green line, square — not the browser's rounded ring. A contributor's row draws it inside its own edge, where the rows around it cannot cover it. */
  .pp a:focus-visible, .pp button:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  .pp a.pp-person:focus-visible { outline-offset: -1px; }
  .pp-hero { display: flex; flex-wrap: wrap; gap: 32px 40px; align-items: flex-end; }
  .pp-lede { flex: 1 1 480px; min-width: 0; display: grid; gap: 14px; }
  .pp-facts { margin: 0; display: flex; flex-wrap: wrap; gap: 10px 22px; font-size: 13.5px; color: var(--muted); }
  .pp-facts a { display: inline-flex; align-items: center; gap: 8px; color: inherit; } .pp-facts a:hover { color: var(--green); } .pp-facts i { color: var(--green); }
  /* The tiles take the width their words need (the kit lets a tile shrink to nothing): "MAINTAINERS.toml" is one word, and it ran into the next tile at 1024px. */
  .pp .pp-stats { flex: 1 1 360px; grid-template-columns: repeat(3, 1fr); } .pp .pp-stats > * { min-width: auto; } .pp .pp-stats .skl { width: 40px; height: 26px; }
  .pp .pp-label { margin: 0 0 12px; font-family: var(--font-mono); }
  .pp-maints { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 12px; }
  .pp .pp-mcard { padding: 14px 16px; display: grid; gap: 12px; align-content: start; }
  .pp-mhead { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .pp-who { display: grid; min-width: 0; line-height: 1.35; } .pp-who span { font-size: 12px; color: var(--dim); }
  .pp-who a { font: 600 15px var(--font-display); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pp-who a:hover { color: var(--green); }
  .pp-av { display: grid; place-items: center; flex: none; width: 24px; height: 24px; background: var(--panel-2); color: var(--muted); font-size: 10px; font-weight: 700; }
  .pp-av.lg { width: 36px; height: 36px; font-size: 15px; }
  .pp-agent { margin-left: auto; flex: none; display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--line); background: var(--bg-deep); color: var(--muted); font-size: 10px; font-weight: 700; }
  .pp-agent.none { border-style: dashed; background: transparent; color: var(--dim); font-weight: 400; }
  .pp-mstats { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line); border: 1px solid var(--line); }
  .pp-mstats > div { background: var(--panel-2); padding: 8px 10px; display: grid; } .pp-mstats b { font: 600 17px var(--font-display); }
  .pp-mstats span { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  /* The first few names and "+K" for the rest, as the design shortens a long list: the line wraps rather than cutting a name the keyboard could still reach out of sight. */
  .pp-pk { margin: 0; font-size: 12px; line-height: 1.6; color: var(--muted); overflow-wrap: anywhere; } .pp-pk a { color: inherit; } .pp-pk a:hover { color: var(--green); } .pp-pk .pp-more { color: var(--dim); }
  .pp-none, .pp-note { color: var(--dim); } .pp-maints > .pp-note, .pp-list > .pp-note { grid-column: 1 / -1; margin: 0; font-size: 13px; } .pp-list > .pp-note { padding: 12px 16px; }
  .pp-pair { display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch; }
  .pp .pp-contrib { flex: 1 1 560px; display: flex; flex-direction: column; }
  .pp .pp-become { flex: 1 1 360px; display: grid; grid-template-rows: auto 1fr auto; }
  .pp-h { margin: 0; display: flex; align-items: center; gap: 10px; font: 600 15px var(--font-display); letter-spacing: 0; } .pp-h i { color: var(--dim); }
  .pp-h + small a { color: var(--dim); } .pp-h + small a:hover { color: var(--green); }
  .pp-list { flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(250px, 100%), 1fr)); align-content: start; }
  .pp-person { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 16px; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--text); min-width: 0; }
  a.pp-person:hover { background: var(--panel-2); } .pp-person.skel .skl { grid-column: 1 / -1; width: 60%; }
  .pp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pp-name em { margin-left: 6px; font-style: normal; font-size: 11px; color: var(--green); }
  .pp-st { font-size: 12px; color: var(--dim); white-space: nowrap; }
  .pp .pp-foot { justify-content: space-between; margin-top: auto; border-top: 0; } .pp-foot a { margin-left: auto; color: var(--dim); } .pp-foot a:hover { color: var(--green); }
  .pp-steps { list-style: none; margin: 0; padding: 0; display: grid; align-content: start; }
  .pp-steps li { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; align-items: start; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .pp-steps li > div { display: grid; gap: 2px; } .pp-steps b { font: 600 14px var(--font-display); } .pp-steps li > div > span { font-size: 12.5px; color: var(--dim); }
  .pp .pp-box { width: 30px; height: 30px; }
  .pp-apply { padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12.5px; color: var(--dim); }
  /* A phone: the three tiles as two and one, so "MAINTAINERS.toml" keeps its line; the cards and the rows are one column already. */
  @media (max-width: 520px) { .pp .pp-stats { grid-template-columns: 1fr 1fr; } .pp .pp-stats > :last-child { grid-column: 1 / -1; } }
`;

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
        <div class="op-card-h"><h2 class="pp-h" id="contributors-h">${lucide("users", 16)}Contributors</h2><small id="contributors-by">by approved packages</small></div>
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
  // The packages a maintainer's card names before "+K", as the design shortens a long list ("omarchy-cli · mise · walker · +3"): the rest are on their page, one link away.
  var CARD_PACKAGES = 3;
  // An agent a worker reports is "<provider>/<model>" (the broker's word, factory/bin/agent.py): its provider's mark in the kit, and the name it goes by. The openai provider is any endpoint that speaks OpenAI's format (OPENAI_BASE_URL): OpenAI's mark stands for OpenAI's own models only, and another model there is "OpenAI-compatible" under a neutral mark.
  var AGENT_MARKS = { anthropic: ["claude-color", "Claude"], "claude-code": ["claude-color", "Claude Code"], openai: ["openai", "OpenAI"], gemini: ["gemini-color", "Gemini"], xai: ["grok", "Grok"] };
  var OPENAI_MODEL = /^(gpt-|o\d|chatgpt-|codex)/i;
  // A number counted over a window the server says it cut (truncated): at least that many, drawn "12+", the reason on hover.
  var AT_LEAST = "at least: the record read here is its newest rows — every person's page has all of theirs";
  function atLeast(n) { return num(n) + "+"; }

  // Who is looking, first: a signed-in viewer is named at once, while the lists are on their way, and their own record is read beside them — GET /users/<login>, the profile their page reads, cached at the edge and found by its owner. Whether they may apply is that record's: every package of theirs, never the registry's newest rows the ranking is drawn from.
  whoami(function () {
    if (!WHO.me) { drawApply(null); return; }
    $("#you").textContent = "@" + WHO.login + " · checking…";
    $("#apply-slot").innerHTML = applyButton(false, "checking whether a package of yours is approved");
    api("GET", "/api/v1/users/" + encodeURIComponent(WHO.login)).then(drawApply, function (e) { drawApply({ down: "your record did not answer: " + errorText(e) }); });
  });
  // The four reads the page is drawn from: the maintainers' agents come from the workers' list, and a list of workers that did not answer leaves each card an agent that is not known, never a page that is not drawn. A read that did not answer (api() rejects on a 5xx and on the network) is said in the two lists, and the tiles read "—": an empty list stood in for a failed one here, and a pool with people read as one with none.
  Promise.all([
    api("GET", "/api/v1/factory/maintainers"),
    api("GET", "/api/v1/factory/packages"),
    api("GET", "/api/v1/factory/approvals"),
    api("GET", "/api/v1/factory/trust").catch(function (e) { return { down: errorText(e) }; })
  ]).then(function (res) { drawPeople(res); }, function (e) {
    var down = noAnswer("people's lists", e);
    ["maintainers", "contributors", "reviews"].forEach(function (k) { unansweredTile(k, down); });
    $("#maintainers-list").innerHTML = $("#contributors-list").innerHTML = '<p class="pp-note">' + esc(down) + '</p>';
  });
  // A tile over a list that did not answer: "—", and "did not answer" under it with the reason on hover — the lists' line says the sentence once.
  function unansweredTile(k, down) { $("#n-" + k).textContent = "—"; $("#s-" + k).innerHTML = '<span title="' + esc(down) + '">did not answer</span>'; }
  function drawPeople(res) {
    var maint = res[0].maintainers || [], pkgs = res[1].packages || [], decisions = res[2].approvals || [], trust = res[3];
    // The windows: the registry's most recently updated requests and the record's newest decisions, each saying when it stopped before the end.
    var pkgsCut = !!res[1].truncated, cut = !!res[2].truncated;
    LISTED = Object.create(null); maint.forEach(function (m) { LISTED[m.login] = true; });
    // Contributors: everyone with a request in the registry, per login the requests and the ones that landed (the registry's flag, never its words), ranked by approved packages, then by requests.
    var by = Object.create(null); RANKED = [];
    pkgs.forEach(function (p) {
      if (!p.owner) return;
      var c = by[p.owner]; if (!c) { c = by[p.owner] = { login: p.owner, requests: 0, approved: 0 }; RANKED.push(c); }
      c.requests++; if (p.landed) c.approved++;
    });
    RANKED.sort(function (a, b) { return b.approved - a.approved || b.requests - a.requests || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0); });
    // Reviews this month: the decisions signed since the first of the month, UTC — approvals and rejections, a withdrawn approval too (the decision was made). The month is whole in the answer unless the window was cut after its first day: then the count is a floor.
    var now = new Date(), month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), oldest = decisions.length ? Date.parse(decisions[decisions.length - 1].created_at) : 0, monthCut = cut && oldest >= month;
    countUp($("#n-maintainers"), maint.length);
    countUp($("#n-contributors"), RANKED.length, pkgsCut ? atLeast : null);
    countUp($("#n-reviews"), decisions.filter(function (a) { return Date.parse(a.created_at) >= month; }).length, monthCut ? atLeast : null);
    if (pkgsCut) { $("#n-contributors").title = AT_LEAST; $("#contributors-by").textContent = "by approved packages, in the newest " + num(pkgs.length) + " requests"; }
    if (monthCut) $("#n-reviews").title = AT_LEAST;
    var held = maintainedBy(decisions);
    $("#maintainers-list").innerHTML = maint.map(function (m) { return maintainerCard(m, decisions, held[m.login] || [], trust, cut); }).join("") || '<p class="pp-note">no maintainer listed yet — the pool reads MAINTAINERS.toml on main every ten minutes</p>';
    drawContributors();
    endSkeleton();
  }
  // What each maintainer maintains: a package, on each architecture, is the maintainer's whose approval of it is the newest that stands — another maintainer's approval of a later version takes it over, and a rejection takes nothing (the approval before it still stands). The decisions come newest first; a blocked package is nobody's. By login, each package once, in the order of its newest approval.
  function maintainedBy(decisions) {
    var held = Object.create(null), mine = Object.create(null);
    decisions.forEach(function (a) {
      if (!a.standing || a.blocked_at) return;
      var arches = a.targets && a.targets.length ? a.targets.map(function (t) { return t.arch; }) : [a.arch];
      arches.forEach(function (arch) {
        var k = a.name + "\t" + arch; if (held[k]) return; held[k] = true;
        var list = mine[a.by] || (mine[a.by] = []);
        if (!list.some(function (x) { return x.name === a.name; })) list.push(a);
      });
    });
    return mine;
  }
  // A person's square: the initials of the login's parts, as the design draws a person — no photos anywhere on the dashboard. The login beside it says who; the square is decoration.
  function initialsOf(login, cls) {
    var t = String(login).split(/[-_.]+/).map(function (w) { return w.charAt(0); }).join("").slice(0, 2).toUpperCase();
    return '<span class="pp-av' + (cls ? " " + cls : "") + '" aria-hidden="true">' + esc(t) + '</span>';
  }
  // "since Aug 2026", from the day the pool first applied the login (factory_maintainers.since).
  function monthYear(iso) { var d = new Date(iso); return iso && !isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : ""; }
  // The agent a maintainer's workers report: a project worker's first — the one they review with — then any other of theirs, the most recently seen first (the list's own order); unknown when none reports one or the list did not answer. Every mark has a name, for the eye on hover and for a screen reader: the provider's mark, a neutral one for a provider or a model the kit has no mark for, and the dash of an agent not known.
  function agentOf(login, trust) {
    if (trust.down) return agentNone("the workers' list did not answer: " + trust.down);
    var w = (trust.workers || []).filter(function (x) { return x.owner === login && !x.revoked_at && x.agent; })[0];
    if (!w) return agentNone("no worker of theirs reports an agent");
    var i = w.agent.indexOf("/"), prov = i > 0 ? w.agent.slice(0, i) : "", model = i > 0 ? w.agent.slice(i + 1) : w.agent;
    var m = Object.prototype.hasOwnProperty.call(AGENT_MARKS, prov) && !(prov === "openai" && !OPENAI_MODEL.test(model)) ? AGENT_MARKS[prov] : null;
    var label = (m ? m[1] : prov === "openai" ? "OpenAI-compatible" : prov || "agent") + " · " + model;
    return m ? '<span class="pp-agent">' + agentMark(m[0], label, 14) + '</span>' : '<span class="pp-agent" title="' + esc(label) + '">' + lucide("bot", 14, label) + '</span>';
  }
  function agentNone(why) { return '<span class="pp-agent none" role="img" aria-label="' + esc(why) + '" title="' + esc(why) + '">—</span>'; }
  // A maintainer's card: who and since when, the agent, the decisions they signed, and what they maintain (maintainedBy) — the first few by name, each at its own address in the most stable ring that serves it, and "+K" to their page for the rest. Over a cut window both numbers are floors.
  function maintainerCard(m, decisions, kept, trust, cut) {
    var signed = decisions.filter(function (a) { return a.by === m.login; }), more = kept.length - CARD_PACKAGES;
    var names = kept.slice(0, CARD_PACKAGES).map(function (a) { return '<a href="' + esc(pkgHref(a.name, servedRing(a.rings), a.arch)) + '">' + esc(a.name) + '</a>'; });
    if (more > 0) names.push('<a class="pp-more" href="' + userHref(m.login) + '" title="' + esc(num(more) + " more: every package @" + m.login + " approved is on their page") + '">+' + num(more) + '</a>');
    var count = function (n) { return cut ? '<b title="' + esc(AT_LEAST) + '">' + atLeast(n) + '</b>' : '<b>' + num(n) + '</b>'; };
    return '<article class="op-card pp-mcard">' +
      '<div class="pp-mhead">' + initialsOf(m.login, "lg") + '<div class="pp-who"><a href="' + userHref(m.login) + '" title="' + esc(m.login) + ' · maintainer">@' + esc(m.login) + '</a><span>' + (m.since ? "since " + esc(monthYear(m.since)) : "listed") + '</span></div>' + agentOf(m.login, trust) + '</div>' +
      '<div class="pp-mstats"><div>' + count(signed.length) + '<span>reviews</span></div><div>' + count(kept.length) + '<span>maintains</span></div></div>' +
      '<p class="pp-pk">' + (names.join(" · ") || '<span class="pp-none">maintains nothing yet</span>') + '</p>' +
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
  // Show all: every row, and the keyboard goes on from the first row it added — the button it was on is gone, and focus left on nothing would start again from the top of the page.
  function showAll() {
    ALL_ROWS = true; drawContributors();
    var next = $("#contributors-list > .pp-person:nth-child(" + (FIRST_ROWS + 1) + ")");
    if (next) next.focus();
  }
  var allBtn = $("#contributors-all"); if (allBtn) allBtn.addEventListener("click", showAll);
  // The way in, for whoever is looking: live for a signed-in contributor with a package a maintainer approved — their record's landed, the registry's flag — grey with the reason for everyone else: nobody signed in reads the sign-in first, a maintainer is one already (the record's role, the file as the pool applied it), a contributor with nothing approved yet is told the first step, and a record that did not answer is said.
  function drawApply(p) {
    var ok = false, why = "", line, n = 0;
    if (!WHO.me) line = "Sign in to see if you are eligible";
    else if (!p || p.down || p.__status !== 200) { line = "@" + WHO.login + " · could not check"; why = "could not check: " + ((p && (p.down || p.error)) || "no answer"); }
    else if (p.role === "maintainer") { line = "You are a maintainer."; why = "you are a maintainer already"; }
    else if ((n = (p.packages || []).filter(function (x) { return x.landed; }).length)) { ok = true; line = "@" + WHO.login + " · " + num(n) + " approved · eligible"; }
    else { line = "@" + WHO.login + " · no package approved yet"; why = "get one package approved first"; }
    $("#you").textContent = line;
    $("#apply-slot").innerHTML = applyButton(ok, orSignIn(why));
  }
  function applyButton(ok, why) { return gate('<a class="op-btn' + (ok ? " primary" : "") + '" id="apply" href="' + esc(APPLY) + '"' + (ok ? ' title="opens the maintainer application on GitHub"' : '') + '>Open the issue</a>', ok, why); }
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
    css: CSS,
  });
}

/**
 * What /people is made of (#251): four public reads and the viewer's own
 * profile, no act of its own (the button opens an issue on GitHub), and one
 * control that changes with the viewer — Open the issue, live for a
 * signed-in contributor with an approved package and grey with the reason
 * for everyone else, never hidden. The section ids are the targets the
 * Pool's tiles link to (#maintainers, #contributors); #workers, the link to
 * the Workers page, is where an older /people#workers still lands.
 */
export const PEOPLE_COMPONENTS = (F: Fixture): Component[] => [
  {
    // The two facts under the title are where the record is: the journal (Status's section since #240) and the file itself.
    id: "people.hero",
    page: "/people",
    anchor: ['<p class="op-eyebrow">People</p>', '<h1 class="op-hero">No owner. A community on the record.</h1>', 'href="/status#journal">', "Every decision in the journal</a>", `href="${FILE}">`, "Maintainers listed in code</a>"],
    visible: EVERYONE,
  },
  {
    // Three tiles, each over the read that feeds it; over reads that did not answer the three read "—" with "did not answer" and the reason on hover; over a window the server cut, a count is a floor ("12+").
    id: "people.tiles",
    page: "/people",
    anchor: ['<div class="op-stats pp-stats" id="tiles">', 'id="n-maintainers"', ">in MAINTAINERS.toml</span>", 'id="n-contributors"', ">with a request</span>", 'id="n-reviews"', ">this month</span>"],
    script: ['countUp($("#n-maintainers"), maint.length)', 'countUp($("#n-contributors"), RANKED.length, pkgsCut ? atLeast : null)', 'countUp($("#n-reviews"), decisions.filter(', "Date.parse(a.created_at) >= month", "Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)", "monthCut = cut && oldest >= month", "!!res[1].truncated", "!!res[2].truncated", "function unansweredTile(k, down)", "did not answer</span>"],
    reads: [
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      { path: "/api/v1/factory/packages", fields: ["truncated", "packages", "packages.0.owner"] },
      { path: "/api/v1/factory/approvals", fields: ["truncated", "approvals", "approvals.0.created_at"] },
    ],
    visible: EVERYONE,
  },
  {
    // A card per login the file lists, in its order: since when, the agent their workers report (the kit's mark, a neutral one where the kit has none, every one named), the decisions they signed, what they maintain — the newest standing approval on each architecture, a blocked package not — its first names and "+K".
    id: "people.maintainers",
    page: "/people",
    anchor: ['<section id="maintainers" aria-labelledby="maintainers-h">', '<h2 class="op-label pp-label" id="maintainers-h">Maintainers</h2>', 'id="maintainers-list"'],
    script: ['api("GET", "/api/v1/factory/maintainers")', 'api("GET", "/api/v1/factory/approvals")', 'api("GET", "/api/v1/factory/trust")', '"#maintainers-list"', "maintainerCard(m, decisions, held[m.login] || [], trust, cut)", "function maintainedBy(decisions)", "a.by === m.login", "!a.standing || a.blocked_at", 'a.name + "\\t" + arch', "pkgHref(a.name, servedRing(a.rings), a.arch)", "kept.slice(0, CARD_PACKAGES)", "monthYear(m.since)", "x.owner === login && !x.revoked_at && x.agent", "agentMark(m[0], label, 14)", 'lucide("bot", 14, label)', '"OpenAI-compatible"', '"no worker of theirs reports an agent"', 'role="img" aria-label="', "userHref(m.login)", "maintains nothing yet", "no maintainer listed yet"],
    reads: [
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login", "maintainers.0.since"] },
      { path: "/api/v1/factory/approvals", fields: ["truncated", "approvals", "approvals.0.by", "approvals.0.name", "approvals.0.arch", "approvals.0.standing", "approvals.0.targets", "approvals.0.targets.0.arch", "approvals.0.rings", "approvals.0.blocked_at"] },
      { path: "/api/v1/factory/trust", fields: ["workers", "workers.0.owner", "workers.0.trust", "workers.0.agent", "workers.0.revoked_at"] },
    ],
    visible: EVERYONE,
  },
  {
    // Everyone with a request, ranked by the packages that landed (the registry's flag, captioned as what it counts), the file's logins tagged; the first rows, then Show all, which hands the keyboard to the first row it added.
    id: "people.contributors",
    page: "/people",
    anchor: ['<section class="op-card pp-contrib" id="contributors" aria-labelledby="contributors-h">', 'Contributors</h2><small id="contributors-by">by approved packages</small>', 'id="contributors-list"', '<button type="button" class="op-btn" id="contributors-all" hidden>Show all</button>'],
    script: ['api("GET", "/api/v1/factory/packages")', "p.landed", "if (p.landed) c.approved++", '"approved by a maintainer, built by the project"', "b.approved - a.approved || b.requests - a.requests", '"#contributors-list"', "contributorRow", "userHref(c.login)", "<em>maintainer</em>", '"first request in"', "Show all ", "function showAll()", "next.focus()", 'noAnswer("people\'s lists", e)', '$("#maintainers-list").innerHTML = $("#contributors-list").innerHTML', 'href="/factory">bring the first package</a>'],
    reads: [
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.owner", "packages.0.status", "packages.0.landed"] },
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
    ],
    visible: EVERYONE,
  },
  {
    // The workers are on their own page: the one link to it from the frame's pages, where an older /people#workers still lands.
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
    // Open the issue: served grey with the sign-in as its reason (servedGrey), drawn again through the shell's gate() once the session answered — grey while a signed-in viewer's record is read, then live only for a contributor with an approved package. The session is the shell's read; eligibility is the viewer's own record (GET /users/<login>: its role, and its packages' landed), whole, not the registry's window the ranking is drawn from.
    id: "people.apply",
    page: "/people",
    anchor: ['<span id="you">Sign in to see if you are eligible</span>', 'id="apply-slot"', `id="apply" data-href="${APPLY_URL}" tabindex="-1" aria-disabled="true" title="${SIGN_IN}">Open the issue</a>`],
    script: ["function drawApply(p)", 'api("GET", "/api/v1/users/" + encodeURIComponent(WHO.login))', '" · checking…"', '"checking whether a package of yours is approved"', '"#apply-slot"', "function applyButton(ok, why)", "gate('<a class=\"op-btn'", "orSignIn(why)", 'p.role === "maintainer"', "x.landed", '"you are a maintainer already"', '"get one package approved first"', '" approved · eligible"', '"your record did not answer: "', `var APPLY = ${JSON.stringify(APPLY_URL)}`],
    reads: [
      { path: "/auth/me", status: 401 },
      { path: "/auth/me", as: "owner", fields: ["login", "role"] },
      { path: "/auth/me", as: "maintainer", fields: ["login", "role"] },
      { path: `/api/v1/users/${F.owner}`, as: "owner", fields: ["login", "role", "packages", "packages.0.landed"] },
      { path: `/api/v1/users/${F.m2}`, as: "maintainer", fields: ["login", "role"] },
    ],
    visible: EVERYONE,
  },
];
