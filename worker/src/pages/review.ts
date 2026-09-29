/**
 * Review: the maintainers' door. What is waiting for a decision and what was
 * decided — for anyone; signed in, what is yours comes first: a contributor's
 * packages in the flow (waiting, then decided), a maintainer's queue. The
 * evidence (PKGBUILD, log, PKGINFO, the gate, the audit) is public; deciding
 * needs the maintainer role, never on one's own package, and copies nothing:
 * the project builds the recipe again from the evidence (/docs/governance).
 *
 * The page is the same for every role: the Yours block, the queue line, the
 * legend, the brake with its two tables and the Decision column are drawn for
 * everyone. What a role may not do — decide, set a category, block, lift — is
 * the same control grey with the reason in its title (the shell's gate()),
 * never hidden and never a sentence in its place; the reason for a decision is
 * the server's own (`can` on every row of GET /factory/review).
 */
import { page, servedGrey } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { CATEGORIES } from "../categories";

/**
 * The brake's form is one template drawn twice: served grey for everyone
 * (servedGrey — what the shell's gate() writes, the reason in the title)
 * and drawn again through gate() once whoami answers, so a maintainer's
 * session is what makes it live. The hero's sign-in hint is the same
 * shape: served live, gated for a signed-in person.
 */
const BLOCK_WHY = "a maintainer blocks; another maintainer lifts";
const BLOCK_FORM = `<input id="block-what" placeholder="contributor login, or package name" required> <input id="block-why" placeholder="why — the record and the contributor see this" required minlength="4"> <button type="submit">Block</button>`;
const WHO_HINT = `Contributors and maintainers: <a href="/auth/github?next=/review">sign in with GitHub</a> to see yours first.`;

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Review</p>
    <h1>What is waiting for a maintainer, and what was decided</h1>
    <p class="lede">A contributor's build is evidence. The project builds it again on a worker it trusts, and a maintainer approves <em>that</em> build — never their own package. <a href="/docs/governance">The rules →</a></p>
    <p class="hint" id="who">${WHO_HINT}</p>
  </div>

  <div class="tiles four" id="tiles"></div>

  <div id="mine">
    <div class="private-head"><h2>Yours</h2><span class="muted" id="mine-who"></span><span class="right"><a class="more-link" id="mine-ws" href="/me">Your workspace →</a></span></div>
    <p class="notice warn" id="mine-blocked" hidden></p>
    <p class="sub" id="mine-queue"></p>
    <div class="rgroups">
      <div class="rgroup" id="g-waiting"><h3>Waiting for a maintainer <span class="dim">nothing to do on your side</span></h3><div class="rrows" id="mine-waiting"></div></div>
      <div class="rgroup" id="g-decided"><h3>Decided <span class="dim">what a maintainer said</span></h3><div class="rrows" id="mine-decided"></div></div>
    </div>
  </div>

  <section id="queue">
    <div class="h2row"><h2>In review</h2><span class="dim" id="queue-note" style="font-size:13px"></span></div>
    <div class="table-wrap"><table id="staged"><thead><tr><th>Package</th><th>Arch</th><th>Brought by</th><th>Build</th><th>Gate</th><th>Audit</th><th>Trial</th><th title="the chain's score today → with the maintainer's half green (What we test → The score)">Class</th><th>Since</th><th class="decision">Decision</th></tr></thead><tbody></tbody></table></div>
    <p class="sub" id="legend">Gate: the worker's own checks. Audit: the project's second agent — <span class="pill ok">ok</span> nothing to change · <span class="pill warn">warn</span> approve with the findings in mind · <span class="pill error">block</span> not as is. Evidence, never a decision; the category under the name is settled here.</p>
  </section>

  <section id="brake">
    <details class="tool"><summary>The brake <span class="dim">block a contributor or a package, with the reason on the record — another maintainer lifts it</span> <span class="hint" id="blocks-note"></span></summary>
      <form id="block-form" class="searchbar">${servedGrey(BLOCK_FORM, BLOCK_WHY)}</form>
      <div class="two"><div><div class="table-wrap"><table id="blocked-people"><thead><tr><th>Contributor</th><th>Since</th><th>By</th><th>Reason</th><th></th></tr></thead><tbody></tbody></table></div></div>
      <div><div class="table-wrap"><table id="blocked-packages"><thead><tr><th>Package</th><th>Owner</th><th>Since</th><th>By</th><th>Reason</th><th></th></tr></thead><tbody></tbody></table></div></div></div>
    </details>
  </section>

  <section>
    <div class="h2row"><h2>Decided lately</h2><a class="more-link" href="/journal">Every line, in the journal →</a></div>
    <div class="table-wrap"><table id="decisions"><thead><tr><th>When</th><th>Package</th><th>Arch</th><th>Decision</th><th>By</th><th>Note</th><th>The project's build</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var API = "/api/v1/factory", CATEGORIES = ${JSON.stringify(CATEGORIES)};
  // REVIEW is the list's own answer: its rows (STAGED), each saying whether it waits for a maintainer, and at the top waiting — the rows a maintainer's time is asked for now, counted by the server over the rows' own waits, the field decidable() highlights with — and oldest_ms, the age of the oldest of them. The tiles, the queue line and the note read those two, never a count of their own, so this page, the Pipeline and the Factory say one number. BLOCKS is null until the brake's record answers, DRAWN true once the lists were drawn: what whoami's answer draws again is only what is there — and until then no number is said: a 0 before the list answered, or over a list that did not (a 5xx, the network — api() rejects, load() says so in the note), reads as nothing waiting.
  // DOWN is the reason the lists did not answer, the note's sentence, kept for the Yours block: its two lists say it instead of "nothing of yours waiting" — good news over a query that threw — and "—" before the lists answered. MINE_DOWN the same for a signed-in reader's own packages (/me), which the Decided list needs.
  var REVIEW = { staged: [], waiting: 0, oldest_ms: null }, STAGED = [], APPROVALS = [], BLOCKS = null, MINE = null, DRAWN = false, DOWN = null, MINE_DOWN = null;
  // The package's name is its page, at the one address (the shell's pkgHref, the ring before the architecture as there): with the ring the row is about — the lab for a build nobody decided yet, the most stable ring that serves an approved one (the shell's servedRing), the page's default where it is in none — and the architecture.
  function pkg(name, version, ring, arch) { return '<a href="' + pkgHref(name, ring, arch) + '" title="the package as Packages shows it — where it is, and the factory\'s story of it"><b>' + esc(name) + '</b></a>' + (version ? ' <span class="mono muted">' + esc(version) + '</span>' : ''); }
  skeletonTiles("#tiles", 4); skeletonRows("#staged", 8, 3); skeletonRows("#decisions", 7, 3);

  // ---- who: the shell's WHO (the omc cookie, one fetch of /auth/me per page). The page is the same for whoever answers; what changes is the name on the Yours block, where its link goes, the gates on the controls — and a signed-in person's own packages, read from /me.
  whoami(function (me) {
    if (me) { $("#mine-who").textContent = WHO.login + " · " + (WHO.role || "contributor"); privateLoad(); }
    // The two controls served in the HTML, drawn again for whoever is looking: the sign-in hint stays, its link grey for a person already in; the brake's form is a maintainer's.
    $("#who").innerHTML = gate(${JSON.stringify(WHO_HINT)}, !WHO.me, "signed in as " + WHO.login);
    $("#block-form").innerHTML = gate(${JSON.stringify(BLOCK_FORM)}, isMaintainer(), orSignIn(${JSON.stringify(BLOCK_WHY)}));
    if (DRAWN) renderStaged();
    renderMine(); renderBlocks();
  });
  // What a session unlocks: the reader's own packages, for the Decided list.
  function privateLoad() { api("GET", API + "/me").then(function (d) { if (!d.error) { MINE = d; MINE_DOWN = null; renderMine(); } }).catch(function (e) { MINE_DOWN = noAnswer("list of your packages", e); renderMine(); }); }

  // ---- the tiles: what waits for a maintainer (the list's own number and age, the same tile on the Pipeline and the Factory), the rows by kind, and how much was decided this week — every decision counted, an approval that stands told from one taken back. Given the reason the lists did not answer (down), the same tiles say "—" (the shell's tilesUnanswered; the note beside In review says why), never a 0.
  function renderTiles(down) {
    var rows = shown(), contrib = rows.filter(function (t) { return t.kind !== "project"; }), proj = rows.filter(function (t) { return t.kind === "project"; });
    var week = APPROVALS.filter(function (a) { return Date.now() - Date.parse(a.created_at) < 7 * 86400e3; });
    var withdrawn = week.filter(function (a) { return a.withdrawn_at; }).length;
    var tiles = [
      ["Waiting for review", num(REVIEW.waiting), REVIEW.oldest_ms ? "oldest " + span(REVIEW.oldest_ms) : "nothing waiting", REVIEW.waiting ? "warn" : "ok"],
      ["Contributors' builds", num(contrib.length), "evidence: a maintainer has the project build it again"],
      ["The project's builds", num(proj.length), "waiting for a maintainer's approval into edge"],
      ["Decided · 7 d", num(week.length), num(week.filter(function (a) { return a.standing; }).length) + " approved · " + num(week.filter(function (a) { return a.decision === "rejected"; }).length) + " rejected" + (withdrawn ? " · " + num(withdrawn) + " withdrawn" : "")]
    ];
    setTiles("#tiles", down ? tilesUnanswered(tiles, down) : tiles);
  }

  // ---- yours: one line per package of yours in the flow — waiting first, then decided; the ring is the one the line is about (the lab for a build waiting, the ring an approval landed in), the architecture the one the package's link opens on. Where the package's architectures stand is the chips (targetChips); a line without them names the architectures it is about (label, the architecture itself when none is given).
  function row(cls, name, version, ring, arch, state, line, link, targets, label) {
    var where = targetChips(targets) || '<span class="pill none">' + esc(label || arch) + '</span>';
    return '<div class="rrow ' + cls + '"><div class="n">' + pkg(name, version, ring, arch) + '</div>' + where + '<div class="s">' + state + ' ' + line + '</div>' + (link ? '<a class="go" href="' + esc(link[0]) + '">' + link[1] + '</a>' : '<span></span>') + '</div>';
  }
  function short(t, n) { t = String(t || ""); return t.length > n ? '<span title="' + esc(t) + '">' + esc(t.slice(0, n - 1)) + '…</span>' : esc(t); }
  function renderMine() {
    queueLine();
    // Nobody signed in: the block is there, with one line in each list for where their packages would be — and the way to request one, as for everyone.
    if (!WHO.me) {
      $("#mine-waiting").innerHTML = '<p class="sub" style="margin:0">Nothing of yours here — <a href="/auth/github?next=/review">sign in with GitHub</a> to see your packages. <a href="/request">Request a package →</a></p>';
      $("#mine-decided").innerHTML = '<p class="sub" style="margin:0">What a maintainer said about them, once you are signed in.</p>';
      return;
    }
    // The lists have not answered — not yet, or not at all: the two groups say so, or "—", as the queue line does; neither empty sentence is a claim the page can make yet (alice read "Nothing of yours waiting" over three staged builds while the note beside In review said the list did not answer, 2026-09-18).
    if (!DRAWN) { $("#mine-waiting").innerHTML = unanswered(DOWN); $("#mine-decided").innerHTML = unanswered(DOWN); return; }
    var waiting = [], decided = [], blocks = BLOCKS || {};
    // Blocked: the brake on you, or on a package of yours — the first thing to see.
    var meBlocked = (blocks.contributors || []).filter(function (b) { return isOwner(b.login); })[0];
    $("#mine-blocked").hidden = !meBlocked;
    if (meBlocked) $("#mine-blocked").innerHTML = '<b>You are blocked</b> since ' + ago(meBlocked.blocked_at) + ' by ' + personLink(meBlocked.blocked_by) + ': ' + esc(meBlocked.blocked_reason || "") + ' — nothing of yours gets in until another maintainer lifts it.';
    (blocks.packages || []).filter(function (b) { return isOwner(b.owner); }).forEach(function (b) {
      decided.push(row("act", b.name, null, null, "all", '<span class="pill error">blocked</span>', ago(b.blocked_at) + ' by ' + personLink(b.blocked_by) + ': ' + short(b.blocked_reason, 90), ["/docs/governance", "What a block means →"]));
    });
    // Packages of yours in review, one card each (one name, one package): the build that speaks for it — the project's when there is one, your own otherwise — and where each architecture stands.
    var seen = {};
    STAGED.filter(function (t) { return isOwner(t.owner); }).sort(function (a, b) { return (b.lead === true) - (a.lead === true) || (b.kind === "project") - (a.kind === "project"); }).forEach(function (t) {
      if (seen[t.name]) return; seen[t.name] = true;
      var pb = t.project_build, tg = t.targets;
      if (t.kind === "project") waiting.push(row("", t.name, t.version, "lab", t.arch, '<span class="pill ok">built again</span>', 'the project\'s ' + taskLink(t.id) + ' (from your ' + taskLink(t.from) + ') waits for approval', ["/build/" + t.id, "The build →"], tg));
      else if (pb && (pb.status === "queued" || pb.status === "leased")) waiting.push(row("", t.name, t.version, "lab", t.arch, '<span class="pill blue">building again</span>', 'the project is building it again (' + taskLink(pb.id) + '), from your ' + taskLink(t.id), ["/build/" + t.id, "Your build →"], tg));
      else if (pb && pb.status === "failed") waiting.push(row("", t.name, t.version, "lab", t.arch, taskPill("failed", pb.error), 'the project\'s ' + taskLink(pb.id) + ' (from your ' + taskLink(t.id) + ') failed — a maintainer decides', ["/build/" + pb.id, "The project's build →"], tg));
      else if (t.already) waiting.push(row("", t.name, t.version, "lab", t.arch, '<span class="pill none">already approved</span>', 'your build ' + taskLink(t.id) + ' is of a version approved ' + ago(t.already.at) + ' as ' + taskLink(t.already.task) + ' — nothing to decide', ["/build/" + t.id, "The build →"], tg));
      else waiting.push(row("", t.name, t.version, "lab", t.arch, taskPill("staged"), 'your build ' + taskLink(t.id) + ' waits for a maintainer' + (t.audit && t.audit.status === "done" && t.audit.verdict ? ' · audit <span class="pill ' + (t.audit.verdict === "ok" ? "ok" : t.audit.verdict === "warn" ? "warn" : "error") + '">' + esc(t.audit.verdict) + '</span>' : t.audit && t.audit.status === "queued" ? ' · audit waiting' : ''), ["/build/" + t.id, "Your build →"], tg));
    });
    // Decided: the record's latest word on each package of yours (a rejection carries the note; an approval, where the package is today — the shell's approvalWhere over the row's rings, blocked_at and publish_status, the word the Factory's Landed lately says of the same row; the registry's status is not read, it stays "approved" after a failed publish).
    var mine = {}; ((MINE && MINE.packages) || []).forEach(function (p) { mine[p.name] = p; });
    // The record's latest word on each package of yours: one review covers the package, so one line per name, with the architectures it decided.
    var last = {};
    APPROVALS.forEach(function (a) { if (mine[a.name] && !last[a.name]) last[a.name] = a; });
    Object.keys(last).forEach(function (k) {
      var a = last[k], tg = mine[a.name] && mine[a.name].targets;
      if (a.withdrawn_at) decided.push(row("act", a.name, a.version, servedRing(a.rings), a.arch, taskPill("withdrawn"), 'the approval by ' + personLink(a.by) + ' was withdrawn ' + ago(a.withdrawn_at) + ' by ' + personLink(a.withdrawn_by) + ': ' + short(a.withdrawn_reason, 100) + ' — another maintainer decides', ["/build/" + a.task_id, "The build →"], tg, archesOf(a)));
      // A rejected request freed its name: request it again. A rejected new version of a package in the pool did not — the name and the approved version stay, the next version is built again.
      else if (a.decision === "rejected") decided.push(row("act", a.name, a.version, servedRing(a.rings), a.arch, taskPill("rejected"), ago(a.created_at) + ' by ' + personLink(a.by) + ': ' + short(a.note, 110) + (a.released ? ' — the name is free again' : ''), a.released ? ["/request", "Request it again →"] : ["/factory", "Fix it, build again →"], tg, archesOf(a)));
      else { var where = approvalWhere(a), served = !!(a.rings && a.rings.length); decided.push(row(where.cls === "error" ? "act" : "ok", a.name, a.version, servedRing(a.rings), a.arch, taskPill("approved"), ago(a.created_at) + ' by ' + personLink(a.by) + ' — ' + pillHtml(where.cls, where.word, where.title) + (a.note ? ' · ' + short(a.note, 80) : ''), served ? [pkgHref(a.name, servedRing(a.rings), a.arch), "The package →"] : ["/build/" + a.task_id, "The build →"], tg, archesOf(a))); }
    });
    $("#mine-waiting").innerHTML = waiting.join("") || '<p class="sub" style="margin:0">Nothing of yours waiting. <a href="/request">Request a package →</a></p>';
    // Both groups stay for a maintainer with nothing of their own too: the block reads the same for every role, the empty line included — once the reader's own packages answered; before, or when they did not, the line says that.
    $("#mine-decided").innerHTML = decided.join("") || (MINE ? '<p class="sub" style="margin:0">No decision on a package of yours yet.</p>' : unanswered(MINE_DOWN));
  }
  // The line a list of the reader's own stands on until it answered: the reason it did not, or "—".
  function unanswered(why) { return '<p class="sub" style="margin:0">' + (why ? esc(why) : "—") + '</p>'; }
  // One line for everyone: what waits for a maintainer — for you, as one — what the project is building, what is yours (the reader's own wait for another maintainer). Before the list answered, or when it did not, the three numbers are "—": whoami draws this line first, and a 0 there is a claim.
  function queueLine() {
    var inFlight = STAGED.filter(function (t) { return t.kind !== "project" && t.project_build && (t.project_build.status === "queued" || t.project_build.status === "leased"); }), own = shown().filter(function (t) { return isOwner(t.owner) && !t.already; });
    var n = function (x) { return DRAWN ? num(x) : "—"; };
    $("#mine-queue").innerHTML = '<b>' + n(forMe()) + '</b> waiting for ' + (isMaintainer() ? "your decision" : "a maintainer") + ' <a href="#queue">↓</a> · <b>' + n(inFlight.length) + '</b> the project is building · <b>' + n(own.length) + '</b> yours — ' + (isMaintainer() ? "another" : "a") + ' maintainer decides';
  }
  // One row per package and architecture: a contributor's build the project
  // has built again and staged is represented by the project's row, which
  // says "from #<theirs>" — two rows of the same name, version and
  // architecture read as two packages (bitwarden, 2026-09-17). The evidence
  // stays reachable from the project's row and on the build's own page.
  function folded(t) { var pb = t.project_build; return t.kind !== "project" && !!pb && pb.status === "staged" && STAGED.some(function (p) { return p.id === pb.id; }); }
  function shown() { return STAGED.filter(function (t) { return !folded(t); }); }
  // Highlighted, never gated: a row a maintainer's time is asked for now — the row's own waits, said by the server (waitsForMaintainer, routes/review.ts) by the rule it counts waiting with, so the rows marked, the rows subtracted and the number said agree for every viewer; the page keeps no copy of the rule (its copy drifted once). The buttons read the row's can, which is the viewer's; waits is not: a chain whose contributor's half is not complete says so in its Class cell, and is still a maintainer's to decide.
  function decidable(t) { return t.waits === true; }
  // What waits for this reader: the list's own count, less a maintainer's own rows — those are another maintainer's; a contributor's own rows wait like the rest.
  function forMe() { return REVIEW.waiting - (isMaintainer() ? shown().filter(function (t) { return isOwner(t.owner) && decidable(t); }).length : 0); }
  function taskLink(id, text) { return '<a href="/build/' + id + '">' + (text || "#" + id) + '</a>'; }

  // ---- in review: the same table for everyone, the Decision column included — a control the reader may not use is grey, with why
  // The category under the name: the same select for everyone, a maintainer's to change.
  function category(t) {
    return gate('<select class="cat" data-category="' + esc(t.name) + '" title="the category a person finds it under">' + (t.category ? '' : '<option value="" selected>category…</option>') + CATEGORIES.map(function (c) { return '<option' + (c === t.category ? ' selected' : '') + '>' + c + '</option>'; }).join("") + '</select>', isMaintainer(), orSignIn("a maintainer sets the category"));
  }
  // Where the bytes came from: the worker that held the lease, whose it is, the host it names, who vouched for it (the project's builds) — the approval sees the machine, not only the evidence.
  function builtOn(t) {
    var b = t.built_by; if (!b) return "";
    var who = b.owner ? b.owner + "'s " : "", word = b.trusted_by ? "trusted on the word of " + b.trusted_by : (t.kind === "project" ? "trusted before trust took two words" : "a community worker");
    return ' <span class="dim" title="' + esc(who + "worker " + b.worker + (b.where ? " on " + b.where : "") + " — " + word) + '">on ' + esc(b.where || b.worker) + '</span>';
  }
  // The class today, the projection on hover; a chain whose contributor's half is not complete says so — a maintainer's time is not asked yet.
  function klass(t) {
    var sc = t.score; if (!sc) return '<span class="muted">—</span>';
    return classPill(sc, sc.class, sc.points + "/100 today · with the maintainer's half green: " + sc.projected) + (sc.class !== sc.projected ? ' <span class="dim" title="with the maintainer\'s half green">→ ' + esc(sc.projected) + '</span>' : '') + (!sc.ready ? ' <span class="pill none" title="a request as the form asks today, a build that passed the gate, audited — then a maintainer">not ready</span>' : '');
  }
  // The Decision cell is the shell's, drawn from the row's can: the same buttons for every viewer — Approve, Reject or Drop, Build by the project — each grey with the server's reason where this viewer may not press it. Beside it, what no other column says: the project's build of it failed.
  function decision(t) {
    var pb = t.project_build;
    return (pb && pb.status === "failed" ? '<span class="pill error" title="' + esc(pb.error || "") + '">project build #' + pb.id + ' failed</span> ' : '') + decisionCell(t);
  }
  // One row per package (#242): a package is its name, and one review covers every architecture it was built for. The row is drawn from the build that speaks for the package — the server's lead, else its newest — with where each of its architectures stands under the name (targetChips); the Arch, Build, Gate, Audit and Trial cells list each build of it the table shows, one line per build.
  function byPackage(rows) {
    var out = [], at = {};
    rows.forEach(function (t) { var p = at[t.name]; if (!p) { p = at[t.name] = { name: t.name, rows: [] }; out.push(p); } p.rows.push(t); });
    out.forEach(function (p) { p.t = p.rows.filter(function (t) { return t.lead; })[0] || p.rows[0]; });
    return out;
  }
  function buildCell(t) {
    var project = t.kind === "project", pb = t.project_build;
    return project ? '<span class="pill ok" title="the project\'s own build, from a contributor\'s evidence">the project</span> <span class="muted">' + taskLink(t.id) + ' from ' + taskLink(t.from) + '</span>' + builtOn(t)
      : '<span class="muted">evidence · ' + taskLink(t.id) + (t.duration_ms ? ' · ' + Math.round(t.duration_ms / 1000) + ' s' : '') + '</span>' + builtOn(t) + (pb && (pb.status === "queued" || pb.status === "leased") ? ' <span class="pill blue">building again</span>' : pb && pb.status === "staged" ? ' <span class="pill ok">built again</span>' : '')
      + (t.already ? ' <span class="pill none" title="approved ' + esc(ago(t.already.at)) + ' by ' + esc(t.already.by) + ' as build #' + t.already.task + (t.already.rebuild_task ? '; the project\'s build #' + t.already.rebuild_task + ' ' + esc(t.already.rebuild_status || '') : '') + ' — nothing to decide">already approved</span>' : '');
  }
  function renderStaged() {
    var rows = shown(), pkgs = byPackage(rows);
    // The note beside the heading reads the same for everyone, as the queue line does: what waits for a maintainer — for you, as one — and how many packages are in review, the builds of a version already approved named.
    var redundant = rows.filter(function (t) { return t.already; }).length;
    $("#queue-note").textContent = rows.length ? num(forMe()) + " waiting for " + (isMaintainer() ? "your decision" : "a maintainer") + " · " + num(pkgs.length) + " in review" + (redundant ? " · " + num(redundant) + " of a version already approved" : "") : "";
    pager("#staged", pkgs, function (p) {
      var t = p.t, det = t.detected || {};
      var mine = isOwner(t.owner), forYou = isMaintainer() && !mine && p.rows.some(decidable);
      // One class per row: the lead's kind first, then whose it is — what a browser kept when the row carried two class attributes.
      var cls = t.kind === "project" ? "project-row" : forYou ? "for-you" : mine ? "mine-row" : "";
      // Each build of the package is a row of its own, so a long Build cell wraps and the Arch, Gate, Audit and Trial beside it stay on its line; the package's cells — its name and targets, who brought it, its class, since when, the decision — span them all.
      var across = p.rows.length > 1 ? ' rowspan="' + p.rows.length + '"' : '';
      var arch = function (r) { return '<td>' + esc(r.arch) + '</td>'; };
      var build = function (r) { return '<td>' + buildCell(r) + '</td><td>' + gatePill(r.vet, r.evidence.tests) + '</td><td>' + auditPill(r.audit, r.evidence.audit) + '</td><td>' + trialPill(r.trial, r.evidence.trial) + '</td>'; };
      return p.rows.map(function (r, i) {
        if (i) return '<tr id="t-' + r.id + '" class="' + (cls ? cls + ' ' : '') + 'more">' + arch(r) + build(r) + '</tr>';
        return '<tr id="t-' + r.id + '"' + (cls ? ' class="' + cls + '"' : '') + '><td' + across + '>' + pkg(t.name, t.version, "lab", t.arch) + (det.license ? ' <span class="dim">' + esc(det.license) + '</span>' : '') + (t.url ? ' <a class="run dim" href="' + esc(t.url) + '" title="' + esc(t.url) + '">source</a>' : '') + '<br>' + targetChips(t.targets) + ' ' + category(t) + '</td>' + arch(r) +
          '<td' + across + '>' + personLink(t.owner) + (mine ? ' <span class="pill none">you</span>' : '') + '</td>' + build(r) +
          '<td' + across + '>' + klass(t) + '</td>' +
          '<td class="when"' + across + '>' + ago(t.finished_at) + '</td><td class="decision"' + across + '>' + decision(t) + '</td></tr>';
      }).join("");
    }, { empty: "nothing waiting for review", text: function (p) { return p.rows.map(function (t) { return [t.id, t.name, t.version, t.arch, t.owner, t.kind, t.category, t.score && t.score.class].join(" "); }).join(" "); } });
    endSkeleton();
  }
  // Every decision on the record, newest first: an approval taken back reads withdrawn; the last cell is the project's build the approval carries (rebuild_task, set by the approval itself) with its status and the file it left.
  function renderDecisions() {
    pager("#decisions", APPROVALS, function (a) {
      // One row per review of a package: the architectures it decided, the ones never built beside them, the project's build of each.
      var ns = Object.keys(a.not_supported || {}), built = (a.targets && a.targets.length ? a.targets : [a]).filter(function (x) { return x.rebuild_task; });
      return '<tr><td class="when">' + ago(a.created_at) + '</td><td>' + pkg(a.name, a.version, servedRing(a.rings), a.arch) + ' <span class="dim">' + taskLink(a.task_id) + '</span></td><td>' + esc(archesOf(a)) + (ns.length ? ' <span class="dim" title="requested, never built — outside the decision">· ' + esc(ns.join(", ")) + ' not supported</span>' : '') + '</td><td>' + (a.withdrawn_at ? taskPill("withdrawn", "approved by " + a.by + ", withdrawn " + ago(a.withdrawn_at) + " by " + a.withdrawn_by + ": " + (a.withdrawn_reason || "")) : taskPill(a.decision)) + '</td><td>' + personLink(a.by) + (a.withdrawn_at ? ' <span class="dim">· withdrawn by ' + personLink(a.withdrawn_by) + '</span>' : '') + '</td><td class="muted">' + esc(a.withdrawn_at ? (a.withdrawn_reason || "") : (a.note || "")) + '</td><td>' + (built.length ? built.map(function (x) { return '<div class="bl">' + taskLink(x.rebuild_task) + ' ' + esc(x.rebuild_status || "") + (x.rebuild_result ? ' <span class="mono">' + esc(x.rebuild_result) + '</span>' : '') + '</div>'; }).join("") : '—') + '</td></tr>';
    }, { empty: "no decision yet", text: function (a) { return [a.name, a.version, archesOf(a), a.decision, a.by, a.note].join(" "); } });
    endSkeleton();
  }

  // ---- the maintainer's tools: the three decisions (the shell asks, posts and tells the page), the brake, the category
  onDecided(function () { load(); });
  function block(kind, what, lift) {
    ask(lift ? { title: "Lift the block on " + what, text: "The record keeps why.", input: "required", confirm: "Lift it" } : { title: "Block " + what, text: "The record and the contributor see this.", input: "required", confirm: "Block", danger: true }).then(function (why) {
      if (why === null) return;
      api("POST", API + "/" + kind + "/" + encodeURIComponent(what) + "/" + (lift ? "unblock" : "block"), { reason: why }).then(function (d) { if (d.error) toast(esc(d.error), "error"); else toast(lift ? "Lifted." : "Blocked."); load(); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    });
  }
  // The brake's record, for everyone: the two tables, a Lift on every row — another maintainer's than the one who blocked.
  function lift(kind, what, b) { return gate('<button type="button" data-unblock="' + kind + '" data-what="' + esc(what) + '">Lift</button>', isMaintainer() && !isOwner(b.blocked_by), isMaintainer() ? "another maintainer lifts it" : orSignIn("a maintainer lifts it")); }
  function renderBlocks() {
    if (!BLOCKS) return;
    $("#blocks-note").textContent = "";
    pager("#blocked-people", (BLOCKS.contributors || []), function (b) {
      return '<tr><td><b>' + personLink(b.login) + '</b></td><td class="when">' + ago(b.blocked_at) + '</td><td>' + personLink(b.blocked_by) + '</td><td>' + esc(b.blocked_reason || "") + '</td><td>' + lift("contributors", b.login, b) + '</td></tr>';
    }, { empty: "no contributor blocked" });
    pager("#blocked-packages", (BLOCKS.packages || []), function (b) {
      return '<tr><td><b>' + esc(b.name) + '</b></td><td>' + personLink(b.owner) + '</td><td class="when">' + ago(b.blocked_at) + '</td><td>' + personLink(b.blocked_by) + '</td><td>' + esc(b.blocked_reason || "") + '</td><td>' + lift("packages", b.name, b) + '</td></tr>';
    }, { empty: "no package blocked" });
  }
  document.addEventListener("change", function (ev) {
    var s = ev.target.closest ? ev.target.closest("select[data-category]") : null; if (!s || !s.value) return;
    api("POST", API + "/packages/" + encodeURIComponent(s.getAttribute("data-category")) + "/category", { category: s.value }).then(function (d) { if (d.error) { toast(esc(d.error), "error"); load(); } }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); load(); });
  });
  document.addEventListener("click", function (ev) {
    var u = ev.target.closest ? ev.target.closest("button[data-unblock]") : null;
    if (u) block(u.getAttribute("data-unblock"), u.getAttribute("data-what"), true);
  });
  // One field takes either: a login that exists is a contributor, anything else is a package name.
  $("#block-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var what = $("#block-what").value.trim(), why = $("#block-why").value.trim();
    if (!what || why.length < 4) return;
    busy(fetch("/api/v1/users/" + encodeURIComponent(what))).then(function (r) { return r.status === 200 ? "contributors" : "packages"; }).then(function (kind) {
      ask({ title: "Block " + (kind === "contributors" ? "contributor " : "package ") + what + "?", text: (kind === "contributors" ? "Their builds stop and their packages leave the rings" : "Its builds stop and it leaves the rings") + "; another maintainer lifts it. The reason: <i>" + esc(why) + "</i>", confirm: "Block", danger: true }).then(function (go) {
        if (go === null) return;
        api("POST", API + "/" + kind + "/" + encodeURIComponent(what) + "/block", { reason: why }).then(function (d) {
          if (d.error) toast(esc(d.error), "error"); else { toast("Blocked."); $("#block-what").value = ""; $("#block-why").value = ""; }
          load();
        }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    });
  });

  // ---- the public lists: the review (its rows carry can for whoever asks), the decisions, the brake's record. A list that did not answer (api() rejects on a 5xx and on the network) is said in the note beside its heading — the review's and the decisions' beside In review, the brake's on its summary — not drawn: the first load's tiles read "—" and the Yours block the reason, a refresh that failed leaves the last rows on screen.
  function load() {
    Promise.all([api("GET", API + "/review"), api("GET", API + "/approvals")]).then(function (rs) {
      REVIEW = rs[0]; STAGED = REVIEW.staged || []; APPROVALS = rs[1].approvals || []; DRAWN = true;
      renderTiles(); renderStaged(); renderDecisions(); renderMine();
    }).catch(function (e) { DOWN = noAnswer("review list", e, "#queue-note"); if (!DRAWN) { renderTiles(DOWN); renderMine(); } });
    // The brake's record: a maintainer looking for a block to lift must tell "nobody is blocked" from "the list did not answer" — the note on the brake's summary says the second; the two tables stay as they were (bare before the first answer, the last answer's rows after).
    api("GET", API + "/blocks").then(function (d) { if (!d.error) { BLOCKS = d; renderMine(); renderBlocks(); } }).catch(function (e) { noAnswer("brake's record", e, "#blocks-note"); });
  }
  load();
  setInterval(function () { load(); if (WHO.me) privateLoad(); }, 60000);
`;

export function reviewHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/review",
    title: "Review · omarchy-pool",
    description: "What is waiting for a maintainer and what was decided; signed in, your packages first.",
    active: "review",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What /review is made of, top to bottom, the same for every role: the hero
 * with its sign-in hint, the four tiles, the Yours block (the head, the
 * blocked notice, the queue line, the waiting and decided lists — a
 * signed-in person's packages, one line to sign in for nobody), the In
 * review table with the category and the Decision cell, the audit legend,
 * the brake (the form and the two blocked tables), the Decided lately table.
 * Every read is one of the page's three public lists (/factory/review,
 * /factory/approvals, /factory/blocks) or what a session unlocks (/auth/me,
 * /factory/me); every act is a maintainer's — the decisions on the fixture's
 * staged builds, the category, the brake — and every role sees its control,
 * grey with the reason where the act would be refused. The brake's form
 * lands on rows the handler refuses (a maintainer, a pool package), so
 * nothing is blocked by the tests; the two blocked tables lift what the
 * fixture seeded — carol and her package, blocked by m1 — as m2, the other
 * maintainer, once the reads that draw those rows have run. The decisions'
 * dialogs and their POST are the shell's (shell.decide).
 */
export const REVIEW_COMPONENTS = (F: Fixture): Component[] => [
  {
    // The hint is served live and drawn again for whoever answers: the same sentence, its link grey for a person already signed in.
    id: "review.hero",
    page: "/review",
    anchor: ['<p class="eyebrow">Review</p>', 'id="who"', 'href="/auth/github?next=/review"', "sign in with GitHub</a> to see yours first"],
    script: ['$("#who").innerHTML = gate(', '"signed in as " + WHO.login'],
    reads: [
      { path: "/auth/me", status: 401 },
      { path: "/auth/me", as: "owner", fields: ["login", "role"] },
    ],
    visible: EVERYONE,
  },
  {
    // What waits is the list's own number and age (`waiting`, `oldest_ms`) — the tile the Pipeline and the Factory draw too; the decisions of the week count every row, an approval that stands told from one withdrawn. Over a list that did not answer, the same tiles read "—" (the shell's tilesUnanswered, the reason on hover and once in the note), never a 0.
    id: "review.tiles",
    page: "/review",
    anchor: ['id="tiles"'],
    script: ['skeletonTiles("#tiles", 4)', 'setTiles("#tiles", down ? tilesUnanswered(tiles, down) : tiles)', '"Waiting for review"', "REVIEW.waiting", "REVIEW.oldest_ms", '"Decided · 7 d"', "a.standing", "a.withdrawn_at", "if (!DRAWN) { renderTiles(DOWN); renderMine(); }"],
    reads: [
      { path: "/api/v1/factory/review", fields: ["staged", "waiting", "oldest_ms", "staged.0.kind"] },
      { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.created_at", "approvals.0.decision", "approvals.0.standing", "approvals.0.withdrawn_at"] },
    ],
    visible: EVERYONE,
  },
  {
    // The head for everyone; a session puts its login and role on it. The workspace link is /me for all: the person's own page with a session, the sign-in that comes back to it without one.
    id: "review.yours-head",
    page: "/review",
    anchor: ['<div id="mine">', 'id="mine-who"', 'id="mine-ws"', 'href="/me"'],
    script: ['$("#mine-who")', "WHO.role"],
    reads: [
      { path: "/me", status: 302, json: false },
      { path: "/auth/me", status: 401 },
      { path: "/auth/me", as: "owner", fields: ["login", "role"] },
      { path: "/auth/me", as: "maintainer", fields: ["login", "role"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "review.yours-blocked",
    page: "/review",
    anchor: ['id="mine-blocked"'],
    script: ['$("#mine-blocked")', "<b>You are blocked</b>", "blocks.contributors", "meBlocked.blocked_reason"],
    reads: [{ path: "/api/v1/factory/blocks", fields: ["contributors", "contributors.0.login", "contributors.0.blocked_at", "contributors.0.blocked_by", "contributors.0.blocked_reason"] }],
    visible: ["contributor", "owner"],
  },
  {
    // One line for everyone: what waits for a maintainer — the list's own `waiting`, less a maintainer's own rows that wait (for you, as one), each row's `waits` the server's — what the project is building, what is yours; "—" for each until the list answered.
    id: "review.yours-queue-line",
    page: "/review",
    anchor: ['<p class="sub" id="mine-queue">'],
    script: ['$("#mine-queue")', "function queueLine()", '"your decision" : "a maintainer"', "function decidable(t) { return t.waits === true; }", "function forMe()", "REVIEW.waiting -", 'return DRAWN ? num(x) : "—"'],
    reads: [{ path: "/api/v1/factory/review", fields: ["waiting", "staged.0.owner", "staged.0.kind", "staged.0.already", "staged.0.project_build", "staged.0.waits"] }],
    visible: EVERYONE,
  },
  {
    // A signed-in person's packages waiting; for nobody, the one line to sign in; until the review list answered — or when it did not — the reason, or "—", never "nothing of yours waiting".
    id: "review.yours-waiting",
    page: "/review",
    anchor: ['id="g-waiting"', 'id="mine-waiting"'],
    // One card per package of the reader's (one name, one package), with where each of its architectures stands.
    script: ['$("#mine-waiting")', "Nothing of yours waiting", "Nothing of yours here", 'href="/request"', "t.project_build", "t.already.task", ">built again<", "t.audit.verdict", 't.version, "lab", t.arch', 'if (!DRAWN) { $("#mine-waiting").innerHTML = unanswered(DOWN)', "function unanswered(why)", "if (seen[t.name]) return;", "tg = t.targets", "targetChips(targets)"],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged.0.id", "staged.0.owner", "staged.0.name", "staged.0.version", "staged.0.arch", "staged.0.kind", "staged.0.from", "staged.0.project_build", "staged.0.already", "staged.0.audit.status", "staged.0.lead", "staged.0.targets"] }],
    visible: EVERYONE,
  },
  {
    id: "review.yours-decided",
    page: "/review",
    anchor: ['id="g-decided"', 'id="mine-decided"'],
    script: ['$("#mine-decided")', "No decision on a package of yours yet", "once you are signed in", "MINE.packages", "a.withdrawn_at", "a.rings", "servedRing(a.rings)", "approvalWhere(a)", "pillHtml(where.cls, where.word, where.title)", "pkgHref(a.name, servedRing(a.rings), a.arch)", "blocks.packages", '$("#mine-decided").innerHTML = unanswered(DOWN)', 'noAnswer("list of your packages", e)', "unanswered(MINE_DOWN)", "if (mine[a.name] && !last[a.name])", "archesOf(a)", "a.released", 'a.released ? ["/request", "Request it again →"] : ["/factory", "Fix it, build again →"]', "tg, archesOf(a)", "esc(label || arch)"],
    reads: [
      { path: "/api/v1/factory/approvals", fields: ["approvals.0.name", "approvals.0.arch", "approvals.0.arches", "approvals.0.version", "approvals.0.decision", "approvals.0.by", "approvals.0.note", "approvals.0.created_at", "approvals.0.withdrawn_at", "approvals.0.withdrawn_by", "approvals.0.withdrawn_reason", "approvals.0.rings", "approvals.0.publish_status", "approvals.0.blocked_at", "approvals.0.task_id", "approvals.0.released"] },
      { path: "/api/v1/factory/me", as: "owner", fields: ["contributor.login", "packages", "packages.0.name", "packages.0.targets"] },
      { path: "/api/v1/factory/me", as: "contributor", fields: ["contributor.login", "packages"] },
      { path: "/api/v1/factory/blocks", fields: ["packages", "packages.0.owner", "packages.0.name", "packages.0.blocked_at", "packages.0.blocked_by", "packages.0.blocked_reason"] },
    ],
    visible: EVERYONE,
  },
  {
    // The note says the same number the queue line does — the list's `waiting`, less a maintainer's own rows — and how many packages are in review; when the lists did not answer, it says so and why (the shell's noAnswer), and the table draws no "nothing waiting" in their place.
    id: "review.queue-head",
    page: "/review",
    anchor: ['<section id="queue">', 'id="queue-note"'],
    script: ['$("#queue-note")', "num(forMe())", '" waiting for "', '" in review"', "of a version already approved", 'noAnswer("review list", e, "#queue-note")'],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged", "waiting", "staged.0.already", "staged.0.owner", "staged.0.waits"] }],
    visible: EVERYONE,
  },
  {
    id: "review.staged-table",
    page: "/review",
    anchor: ['<table id="staged">', "<th>Gate</th><th>Audit</th><th>Trial</th>", '<th class="decision">Decision</th>'],
    // One group of rows per package (#242): the build that speaks for it (the server's `lead`) draws the package's cells, which span the group, its targets say where each architecture stands under the name, and every build of it shown is a row of its own Arch, Build, Gate, Audit and Trial cells. The package's name is its page at the shell's one address (pkgHref), with the lab — the ring a build nobody decided yet is about — and the row's architecture. A package for a maintainer to decide is highlighted (for-you) by its rows' own `waits`, the server's word, never a rule of the page's.
    script: ['pager("#staged", pkgs', "function byPackage(rows)", "p.rows.filter(function (t) { return t.lead; })[0] || p.rows[0]", "targetChips(t.targets)", 'pkg(t.name, t.version, "lab", t.arch)', "function pkg(name, version, ring, arch)", "pkgHref(name, ring, arch)", "gatePill(r.vet, r.evidence.tests)", "auditPill(r.audit, r.evidence.audit)", "trialPill(r.trial, r.evidence.trial)", "t.built_by", "sc.projected", '"project-row"', '"mine-row"', '"for-you"', "!mine && p.rows.some(decidable)", "' rowspan=\"' + p.rows.length", "'more\">' + arch(r) + build(r)"],
    reads: [
      {
        path: "/api/v1/factory/review",
        fields: [
          "staged", "staged.0.id", "staged.0.name", "staged.0.version", "staged.0.arch", "staged.0.owner", "staged.0.kind", "staged.0.from", "staged.0.url", "staged.0.detected", "staged.0.category", "staged.0.duration_ms", "staged.0.finished_at",
          "staged.0.project_build", "staged.0.built_by", "staged.0.built_by.worker", "staged.0.built_by.owner", "staged.0.built_by.where", "staged.0.built_by.trusted_by", "staged.0.already", "staged.0.waits", "staged.0.lead", "staged.0.targets",
          "staged.0.vet.verdict", "staged.0.vet.warnings", "staged.0.vet.warned", "staged.0.vet.failed", "staged.0.audit.status", "staged.0.trial.status",
          "staged.0.score.points", "staged.0.score.class", "staged.0.score.projected", "staged.0.score.ready", "staged.0.evidence.tests", "staged.0.evidence.audit", "staged.0.evidence.trial",
        ],
      },
      { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/tests.log`, json: false },
      { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/audit.md`, json: false },
      { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/trial.log`, json: false },
    ],
    visible: EVERYONE,
  },
  {
    // The same select for everyone, grey for whoever is not a maintainer.
    id: "review.category-select",
    page: "/review",
    anchor: ['id="staged"'],
    script: ["select[data-category]", 'data-category="', 'orSignIn("a maintainer sets the category")', '"/packages/"', '"/category"', "CATEGORIES.map("],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged.0.category", "staged.0.name"] }],
    acts: [{ method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/category`, body: { category: CATEGORIES[0] }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } }],
    visible: EVERYONE,
  },
  {
    // The shell's Decision cell on every row, from the row's can: the buttons every role sees, enabled where the server would say yes — Withdraw where the row says an approval stands; the page draws again once a decision landed.
    id: "review.decision-buttons",
    page: "/review",
    anchor: ['id="staged"', 'class="decision"'],
    script: ["decisionCell(t)", "onDecided(function () { load(); })", "project build #", "pb.status === \"failed\""],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged", "staged.0.id", "staged.0.name", "staged.0.version", "staged.0.arch", "staged.0.kind", "staged.0.owner", "staged.0.already", "staged.0.standing", "staged.0.project_build", "staged.0.can.approve", "staged.0.can.reject", "staged.0.can.build", "staged.0.can.withdraw", "staged.0.can.why"] }],
    acts: [
      { method: "POST", path: `/api/v1/factory/tasks/${F.projectTask}/approve`, body: { note: "reads well" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
      { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/build`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
      { method: "POST", path: `/api/v1/factory/tasks/${F.disposableTask}/reject`, body: { note: "the source is not the upstream's" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } },
    ],
    visible: EVERYONE,
  },
  {
    id: "review.legend",
    page: "/review",
    anchor: ['<p class="sub" id="legend">', "Evidence, never a decision"],
    visible: EVERYONE,
  },
  {
    // The brake's record is public: the section and its two tables are for everyone. When the record did not answer, the note on the summary says so (the shell's noAnswer) and the tables draw no "no contributor blocked" in its place.
    id: "review.brake",
    page: "/review",
    anchor: ['<section id="brake">', '<details class="tool">', 'id="blocks-note"'],
    script: ["function renderBlocks()", '"/blocks"', 'noAnswer("brake\'s record", e, "#blocks-note")', '$("#blocks-note").textContent = ""'],
    reads: [{ path: "/api/v1/factory/blocks", fields: ["contributors", "packages"] }],
    visible: EVERYONE,
  },
  {
    // Served grey with the reason for everyone, drawn again through the shell's gate once whoami answers: live for a maintainer, the sign-in for nobody.
    id: "review.brake-form",
    page: "/review",
    anchor: ['id="block-form"', 'id="block-what"', 'id="block-why"', 'minlength="4"', `title="${BLOCK_WHY}"`],
    script: ['$("#block-form").innerHTML = gate(', `orSignIn(${JSON.stringify(BLOCK_WHY)})`, '"/api/v1/users/"', 'r.status === 200 ? "contributors" : "packages"', '"/block"'],
    reads: [
      { path: `/api/v1/users/${F.owner}`, fields: ["login"] },
      { path: `/api/v1/users/${F.factoryPkg}`, status: 404 },
    ],
    acts: [
      { method: "POST", path: `/api/v1/factory/contributors/${F.m1}/block`, body: { reason: "typed into the brake by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 409 } },
      { method: "POST", path: `/api/v1/factory/packages/${F.pkg}/block`, body: { reason: "typed into the brake by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 404 } },
    ],
    visible: EVERYONE,
  },
  {
    // Lift on every row, grey for whoever may not: a non-maintainer, and the maintainer who blocked.
    id: "review.blocked-people-table",
    page: "/review",
    anchor: ['id="blocked-people"', 'id="blocks-note"'],
    script: ['pager("#blocked-people"', 'noAnswer("brake\'s record", e, "#blocks-note")', 'lift("contributors"', "function lift(kind, what, b)", "isMaintainer() && !isOwner(b.blocked_by)", '"another maintainer lifts it"', 'orSignIn("a maintainer lifts it")'],
    reads: [{ path: "/api/v1/factory/blocks", fields: ["contributors", "contributors.0.login", "contributors.0.blocked_at", "contributors.0.blocked_by", "contributors.0.blocked_reason"] }],
    // m2 lifts what m1 set; m1's own lift would be 403, and a login nobody blocked 409.
    acts: [{ method: "POST", path: `/api/v1/factory/contributors/${F.blockedContributor}/unblock`, body: { reason: "lifted by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } }],
    visible: EVERYONE,
  },
  {
    id: "review.blocked-packages-table",
    page: "/review",
    anchor: ['id="blocked-packages"', 'id="blocks-note"'],
    script: ['pager("#blocked-packages"', 'noAnswer("brake\'s record", e, "#blocks-note")', 'lift("packages"', '"unblock"'],
    reads: [{ path: "/api/v1/factory/blocks", fields: ["packages", "packages.0.name", "packages.0.owner", "packages.0.blocked_at", "packages.0.blocked_by", "packages.0.blocked_reason"] }],
    acts: [{ method: "POST", path: `/api/v1/factory/packages/${F.blockedPkg}/unblock`, body: { reason: "lifted by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } }],
    visible: EVERYONE,
  },
  {
    // Every decision — a review of a package, the architectures it covered and the ones never built beside them — an approval taken back read as withdrawn; the project's build of each architecture (`rebuild_task`) with its status; the package links the most stable ring that serves it (`rings`).
    id: "review.decisions-table",
    page: "/review",
    anchor: ['id="decisions"', "<h2>Decided lately</h2>", 'href="/journal"'],
    script: ['pager("#decisions"', "pkg(a.name, a.version, servedRing(a.rings), a.arch)", "archesOf(a)", "a.not_supported", " not supported</span>", "x.rebuild_task", "x.rebuild_status", "x.rebuild_result", "a.withdrawn_reason"],
    reads: [{ path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.created_at", "approvals.0.name", "approvals.0.version", "approvals.0.arch", "approvals.0.arches", "approvals.0.not_supported", "approvals.0.task_id", "approvals.0.decision", "approvals.0.rings", "approvals.0.by", "approvals.0.note", "approvals.0.withdrawn_at", "approvals.0.withdrawn_by", "approvals.0.withdrawn_reason", "approvals.0.targets", "approvals.0.targets.0.rebuild_task", "approvals.0.targets.0.rebuild_status", "approvals.0.targets.0.rebuild_result"] }],
    visible: EVERYONE,
  },
];
