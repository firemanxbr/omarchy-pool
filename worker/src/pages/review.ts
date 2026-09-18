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
    <details class="tool"><summary>The brake <span class="dim">block a contributor or a package, with the reason on the record — another maintainer lifts it</span></summary>
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
  // REVIEW is the list's own answer: its rows (STAGED), and at the top waiting — the rows a maintainer's time is asked for now, counted by the server by the rule decidable() highlights with — and oldest_ms, the age of the oldest of them. The tiles, the queue line and the note read those two, never a count of their own, so this page, the Pipeline and the Factory say one number. BLOCKS is null until the brake's record answers, DRAWN true once the lists were drawn: what whoami's answer draws again is only what is there.
  var REVIEW = { staged: [], waiting: 0, oldest_ms: null }, STAGED = [], APPROVALS = [], BLOCKS = null, MINE = null, DRAWN = false;
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
  function privateLoad() { api("GET", API + "/me").then(function (d) { if (!d.error) { MINE = d; renderMine(); } }).catch(function () {}); }

  // ---- the tiles: what waits for a maintainer (the list's own number and age, the same tile on the Pipeline and the Factory), the rows by kind, and how much was decided this week — every decision counted, an approval that stands told from one taken back.
  function renderTiles() {
    var rows = shown(), contrib = rows.filter(function (t) { return t.kind !== "project"; }), proj = rows.filter(function (t) { return t.kind === "project"; });
    var week = APPROVALS.filter(function (a) { return Date.now() - Date.parse(a.created_at) < 7 * 86400e3; });
    var withdrawn = week.filter(function (a) { return a.withdrawn_at; }).length;
    setTiles("#tiles", [
      ["Waiting for review", num(REVIEW.waiting), REVIEW.oldest_ms ? "oldest " + span(REVIEW.oldest_ms) : "nothing waiting", REVIEW.waiting ? "warn" : "ok"],
      ["Contributors' builds", num(contrib.length), "evidence: a maintainer has the project build it again"],
      ["The project's builds", num(proj.length), "waiting for a maintainer's approval into edge"],
      ["Decided · 7 d", num(week.length), num(week.filter(function (a) { return a.standing; }).length) + " approved · " + num(week.filter(function (a) { return a.decision === "rejected"; }).length) + " rejected" + (withdrawn ? " · " + num(withdrawn) + " withdrawn" : "")]
    ]);
  }

  // ---- yours: one line per package of yours in the flow — waiting first, then decided; the ring is the one the line is about (the lab for a build waiting, the ring an approval landed in).
  function row(cls, name, version, ring, arch, state, line, link) {
    return '<div class="rrow ' + cls + '"><div class="n">' + pkg(name, version, ring, arch) + '</div><span class="pill none">' + esc(arch) + '</span><div class="s">' + state + ' ' + line + '</div>' + (link ? '<a class="go" href="' + esc(link[0]) + '">' + link[1] + '</a>' : '<span></span>') + '</div>';
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
    var waiting = [], decided = [], blocks = BLOCKS || {};
    // Blocked: the brake on you, or on a package of yours — the first thing to see.
    var meBlocked = (blocks.contributors || []).filter(function (b) { return isOwner(b.login); })[0];
    $("#mine-blocked").hidden = !meBlocked;
    if (meBlocked) $("#mine-blocked").innerHTML = '<b>You are blocked</b> since ' + ago(meBlocked.blocked_at) + ' by ' + personLink(meBlocked.blocked_by) + ': ' + esc(meBlocked.blocked_reason || "") + ' — nothing of yours gets in until another maintainer lifts it.';
    (blocks.packages || []).filter(function (b) { return isOwner(b.owner); }).forEach(function (b) {
      decided.push(row("act", b.name, null, null, "all", '<span class="pill error">blocked</span>', ago(b.blocked_at) + ' by ' + personLink(b.blocked_by) + ': ' + short(b.blocked_reason, 90), ["/docs/governance", "What a block means →"]));
    });
    // Staged builds of yours, one card per package and architecture: the project's build when there is one, your own otherwise.
    var seen = {};
    STAGED.filter(function (t) { return isOwner(t.owner); }).sort(function (a, b) { return (b.kind === "project") - (a.kind === "project"); }).forEach(function (t) {
      var key = t.name + "/" + t.arch; if (seen[key]) return; seen[key] = true;
      var pb = t.project_build;
      if (t.kind === "project") waiting.push(row("", t.name, t.version, "lab", t.arch, '<span class="pill ok">built again</span>', 'the project\'s ' + taskLink(t.id) + ' (from your ' + taskLink(t.from) + ') waits for approval', ["/build/" + t.id, "The build →"]));
      else if (pb && (pb.status === "queued" || pb.status === "leased")) waiting.push(row("", t.name, t.version, "lab", t.arch, '<span class="pill blue">building again</span>', 'the project is building it again (' + taskLink(pb.id) + '), from your ' + taskLink(t.id), ["/build/" + t.id, "Your build →"]));
      else if (pb && pb.status === "failed") waiting.push(row("", t.name, t.version, "lab", t.arch, taskPill("failed", pb.error), 'the project\'s ' + taskLink(pb.id) + ' (from your ' + taskLink(t.id) + ') failed — a maintainer decides', ["/build/" + pb.id, "The project's build →"]));
      else if (t.already) waiting.push(row("", t.name, t.version, "lab", t.arch, '<span class="pill none">already approved</span>', 'your build ' + taskLink(t.id) + ' is of a version approved ' + ago(t.already.at) + ' as ' + taskLink(t.already.task) + ' — nothing to decide', ["/build/" + t.id, "The build →"]));
      else waiting.push(row("", t.name, t.version, "lab", t.arch, taskPill("staged"), 'your build ' + taskLink(t.id) + ' waits for a maintainer' + (t.audit && t.audit.status === "done" && t.audit.verdict ? ' · audit <span class="pill ' + (t.audit.verdict === "ok" ? "ok" : t.audit.verdict === "warn" ? "warn" : "error") + '">' + esc(t.audit.verdict) + '</span>' : t.audit && t.audit.status === "queued" ? ' · audit waiting' : ''), ["/build/" + t.id, "Your build →"]));
    });
    // Decided: the record's latest word on each package of yours (a rejection carries the note; an approval, the ring).
    var mine = {}; ((MINE && MINE.packages) || []).forEach(function (p) { mine[p.name] = p; });
    var last = {};
    APPROVALS.forEach(function (a) { if (mine[a.name] && !last[a.name + "/" + a.arch]) last[a.name + "/" + a.arch] = a; });
    Object.keys(last).forEach(function (k) {
      var a = last[k], p = mine[a.name];
      if (a.withdrawn_at) decided.push(row("act", a.name, a.version, servedRing(a.rings), a.arch, taskPill("withdrawn"), 'the approval by ' + personLink(a.by) + ' was withdrawn ' + ago(a.withdrawn_at) + ' by ' + personLink(a.withdrawn_by) + ': ' + short(a.withdrawn_reason, 100) + ' — another maintainer decides', ["/build/" + a.task_id, "The build →"]));
      else if (a.decision === "rejected") decided.push(row("act", a.name, a.version, servedRing(a.rings), a.arch, taskPill("rejected"), ago(a.created_at) + ' by ' + personLink(a.by) + ': ' + short(a.note, 110), ["/factory", "Fix it, build again →"]));
      else { var inRings = a.rings && a.rings.length ? a.rings : (p && p.status === "published" ? ["edge"] : []); decided.push(row("ok", a.name, a.version, servedRing(inRings), a.arch, taskPill("approved"), ago(a.created_at) + ' by ' + personLink(a.by) + (inRings.length ? ' — in ' + inRings.join(" · ") + ', signed by the pool' : ' — the project\'s build is on its way into edge') + (a.note ? ' · ' + short(a.note, 80) : ''), inRings.length ? [pkgHref(a.name, servedRing(inRings), a.arch), "The package →"] : ["/build/" + a.task_id, "The build →"])); }
    });
    $("#mine-waiting").innerHTML = waiting.join("") || '<p class="sub" style="margin:0">Nothing of yours waiting. <a href="/request">Request a package →</a></p>';
    // Both groups stay for a maintainer with nothing of their own too: the block reads the same for every role, the empty line included.
    $("#mine-decided").innerHTML = decided.join("") || '<p class="sub" style="margin:0">No decision on a package of yours yet.</p>';
  }
  // One line for everyone: what waits for a maintainer — for you, as one — what the project is building, what is yours (the reader's own wait for another maintainer).
  function queueLine() {
    var inFlight = STAGED.filter(function (t) { return t.kind !== "project" && t.project_build && (t.project_build.status === "queued" || t.project_build.status === "leased"); }), own = shown().filter(function (t) { return isOwner(t.owner) && !t.already; });
    $("#mine-queue").innerHTML = '<b>' + num(forMe()) + '</b> waiting for ' + (isMaintainer() ? "your decision" : "a maintainer") + ' <a href="#queue">↓</a> · <b>' + num(inFlight.length) + '</b> the project is building · <b>' + num(own.length) + '</b> yours — ' + (isMaintainer() ? "another" : "a") + ' maintainer decides';
  }
  // One row per package and architecture: a contributor's build the project
  // has built again and staged is represented by the project's row, which
  // says "from #<theirs>" — two rows of the same name, version and
  // architecture read as two packages (bitwarden, 2026-09-17). The evidence
  // stays reachable from the project's row and on the build's own page.
  function folded(t) { var pb = t.project_build; return t.kind !== "project" && !!pb && pb.status === "staged" && STAGED.some(function (p) { return p.id === pb.id; }); }
  function shown() { return STAGED.filter(function (t) { return !folded(t); }); }
  // Highlighted, never gated: a row a maintainer's time is asked for now — nothing already decided, the project not already building it. The same rule the server counts waiting by (waitsForMaintainer, routes/review.ts), so the rows marked and the number said agree; the buttons read the row's can, and this reads the same as they do: a chain whose contributor's half is not complete says so in its Class cell, and is still a maintainer's to decide.
  function decidable(t) { var pb = t.project_build; return !t.already && (t.kind === "project" || !pb || pb.status === "failed"); }
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
  function renderStaged() {
    var rows = shown();
    // The note beside the heading reads the same for everyone, as the queue line does: what waits for a maintainer — for you, as one — and how many rows are staged, the ones of a version already approved named.
    var redundant = rows.filter(function (t) { return t.already; }).length;
    $("#queue-note").textContent = rows.length ? num(forMe()) + " waiting for " + (isMaintainer() ? "your decision" : "a maintainer") + " · " + num(rows.length) + " staged" + (redundant ? " · " + num(redundant) + " of a version already approved" : "") : "";
    pager("#staged", rows, function (t) {
      var det = t.detected || {}, project = t.kind === "project", pb = t.project_build;
      var build = project ? '<span class="pill ok" title="the project\'s own build, from a contributor\'s evidence">the project</span> <span class="muted">' + taskLink(t.id) + ' from ' + taskLink(t.from) + '</span>' + builtOn(t)
        : '<span class="muted">evidence · ' + taskLink(t.id) + (t.duration_ms ? ' · ' + Math.round(t.duration_ms / 1000) + ' s' : '') + '</span>' + builtOn(t) + (pb && (pb.status === "queued" || pb.status === "leased") ? ' <span class="pill blue">building again</span>' : pb && pb.status === "staged" ? ' <span class="pill ok">built again</span>' : '')
        + (t.already ? ' <span class="pill none" title="approved ' + esc(ago(t.already.at)) + ' by ' + esc(t.already.by) + ' as build #' + t.already.task + (t.already.rebuild_task ? '; the project\'s build #' + t.already.rebuild_task + ' ' + esc(t.already.rebuild_status || '') : '') + ' — nothing to decide">already approved</span>' : '');
      var mine = isOwner(t.owner), forYou = isMaintainer() && !mine && decidable(t);
      return '<tr id="t-' + t.id + '"' + (project ? ' class="project-row"' : '') + (forYou ? ' class="for-you"' : mine ? ' class="mine-row"' : '') + '><td>' + pkg(t.name, t.version, "lab", t.arch) + (det.license ? ' <span class="dim">' + esc(det.license) + '</span>' : '') + (t.url ? ' <a class="run dim" href="' + esc(t.url) + '" title="' + esc(t.url) + '">source</a>' : '') + '<br>' + category(t) + '</td><td>' + esc(t.arch) + '</td>' +
        '<td>' + personLink(t.owner) + (mine ? ' <span class="pill none">you</span>' : '') + '</td><td>' + build + '</td><td>' + gatePill(t.vet, t.evidence.tests) + '</td><td>' + auditPill(t.audit, t.evidence.audit) + '</td><td>' + trialPill(t.trial, t.evidence.trial) + '</td>' +
        '<td>' + klass(t) + '</td>' +
        '<td class="when">' + ago(t.finished_at) + '</td><td class="decision">' + decision(t) + '</td></tr>';
    }, { empty: "nothing waiting for review", text: function (t) { return [t.id, t.name, t.version, t.arch, t.owner, t.kind, t.category, t.score && t.score.class].join(" "); } });
    endSkeleton();
  }
  // Every decision on the record, newest first: an approval taken back reads withdrawn, and only one that stands (standing, the server's word) is waiting for the recipe on main.
  function renderDecisions() {
    pager("#decisions", APPROVALS, function (a) {
      return '<tr><td class="when">' + ago(a.created_at) + '</td><td>' + pkg(a.name, a.version, servedRing(a.rings), a.arch) + ' <span class="dim">' + taskLink(a.task_id) + '</span></td><td>' + esc(a.arch) + '</td><td>' + (a.withdrawn_at ? taskPill("withdrawn", "approved by " + a.by + ", withdrawn " + ago(a.withdrawn_at) + " by " + a.withdrawn_by + ": " + (a.withdrawn_reason || "")) : taskPill(a.decision)) + '</td><td>' + personLink(a.by) + (a.withdrawn_at ? ' <span class="dim">· withdrawn by ' + personLink(a.withdrawn_by) + '</span>' : '') + '</td><td class="muted">' + esc(a.withdrawn_at ? (a.withdrawn_reason || "") : (a.note || "")) + '</td><td>' + (a.rebuild_task ? taskLink(a.rebuild_task) + ' ' + esc(a.rebuild_status || "") + (a.rebuild_result ? ' <span class="mono">' + esc(a.rebuild_result) + '</span>' : '') : (a.standing ? '<span class="dim">waiting for the recipe on main</span>' : '—')) + '</td></tr>';
    }, { empty: "no decision yet", text: function (a) { return [a.name, a.version, a.arch, a.decision, a.by, a.note].join(" "); } });
    endSkeleton();
  }

  // ---- the maintainer's tools: the three decisions (the shell asks, posts and tells the page), the brake, the category
  onDecided(function () { load(); });
  function block(kind, what, lift) {
    ask(lift ? { title: "Lift the block on " + what, text: "The record keeps why.", input: "required", confirm: "Lift it" } : { title: "Block " + what, text: "The record and the contributor see this.", input: "required", confirm: "Block", danger: true }).then(function (why) {
      if (why === null) return;
      api("POST", API + "/" + kind + "/" + encodeURIComponent(what) + "/" + (lift ? "unblock" : "block"), { reason: why }).then(function (d) { if (d.error) toast(esc(d.error), "error"); else toast(lift ? "Lifted." : "Blocked."); load(); });
    });
  }
  // The brake's record, for everyone: the two tables, a Lift on every row — another maintainer's than the one who blocked.
  function lift(kind, what, b) { return gate('<button type="button" data-unblock="' + kind + '" data-what="' + esc(what) + '">Lift</button>', isMaintainer() && !isOwner(b.blocked_by), isMaintainer() ? "another maintainer lifts it" : orSignIn("a maintainer lifts it")); }
  function renderBlocks() {
    if (!BLOCKS) return;
    pager("#blocked-people", (BLOCKS.contributors || []), function (b) {
      return '<tr><td><b>' + personLink(b.login) + '</b></td><td class="when">' + ago(b.blocked_at) + '</td><td>' + personLink(b.blocked_by) + '</td><td>' + esc(b.blocked_reason || "") + '</td><td>' + lift("contributors", b.login, b) + '</td></tr>';
    }, { empty: "no contributor blocked" });
    pager("#blocked-packages", (BLOCKS.packages || []), function (b) {
      return '<tr><td><b>' + esc(b.name) + '</b></td><td>' + personLink(b.owner) + '</td><td class="when">' + ago(b.blocked_at) + '</td><td>' + personLink(b.blocked_by) + '</td><td>' + esc(b.blocked_reason || "") + '</td><td>' + lift("packages", b.name, b) + '</td></tr>';
    }, { empty: "no package blocked" });
  }
  document.addEventListener("change", function (ev) {
    var s = ev.target.closest ? ev.target.closest("select[data-category]") : null; if (!s || !s.value) return;
    api("POST", API + "/packages/" + encodeURIComponent(s.getAttribute("data-category")) + "/category", { category: s.value }).then(function (d) { if (d.error) { toast(esc(d.error), "error"); load(); } });
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
        });
      });
    });
  });

  // ---- the public lists: the review (its rows carry can for whoever asks), the decisions, the brake's record
  function load() {
    Promise.all([api("GET", API + "/review"), api("GET", API + "/approvals")]).then(function (rs) {
      REVIEW = rs[0]; STAGED = REVIEW.staged || []; APPROVALS = rs[1].approvals || []; DRAWN = true;
      renderTiles(); renderStaged(); renderDecisions(); renderMine();
    }).catch(function () { endSkeleton(); });
    api("GET", API + "/blocks").then(function (d) { if (!d.error) { BLOCKS = d; renderMine(); renderBlocks(); } }).catch(function () {});
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
    // What waits is the list's own number and age (`waiting`, `oldest_ms`) — the tile the Pipeline and the Factory draw too; the decisions of the week count every row, an approval that stands told from one withdrawn.
    id: "review.tiles",
    page: "/review",
    anchor: ['id="tiles"'],
    script: ['skeletonTiles("#tiles", 4)', 'setTiles("#tiles"', '"Waiting for review"', "REVIEW.waiting", "REVIEW.oldest_ms", '"Decided · 7 d"', "a.standing", "a.withdrawn_at"],
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
    // One line for everyone: what waits for a maintainer — the list's own `waiting`, less a maintainer's own rows (for you, as one) — what the project is building, what is yours.
    id: "review.yours-queue-line",
    page: "/review",
    anchor: ['<p class="sub" id="mine-queue">'],
    script: ['$("#mine-queue")', "function queueLine()", '"your decision" : "a maintainer"', "function decidable(t)", "function forMe()", "REVIEW.waiting -"],
    reads: [{ path: "/api/v1/factory/review", fields: ["waiting", "staged.0.owner", "staged.0.kind", "staged.0.already", "staged.0.project_build"] }],
    visible: EVERYONE,
  },
  {
    // A signed-in person's packages waiting; for nobody, the one line to sign in.
    id: "review.yours-waiting",
    page: "/review",
    anchor: ['id="g-waiting"', 'id="mine-waiting"'],
    script: ['$("#mine-waiting")', "Nothing of yours waiting", "Nothing of yours here", 'href="/request"', "t.project_build", "t.already.task", ">built again<", "t.audit.verdict", 't.version, "lab", t.arch'],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged.0.id", "staged.0.owner", "staged.0.name", "staged.0.version", "staged.0.arch", "staged.0.kind", "staged.0.from", "staged.0.project_build", "staged.0.already", "staged.0.audit.status"] }],
    visible: EVERYONE,
  },
  {
    id: "review.yours-decided",
    page: "/review",
    anchor: ['id="g-decided"', 'id="mine-decided"'],
    script: ['$("#mine-decided")', "No decision on a package of yours yet", "once you are signed in", "MINE.packages", "a.withdrawn_at", "a.rings", "servedRing(a.rings)", "pkgHref(a.name, servedRing(inRings), a.arch)", "blocks.packages"],
    reads: [
      { path: "/api/v1/factory/approvals", fields: ["approvals.0.name", "approvals.0.arch", "approvals.0.version", "approvals.0.decision", "approvals.0.by", "approvals.0.note", "approvals.0.created_at", "approvals.0.withdrawn_at", "approvals.0.withdrawn_by", "approvals.0.withdrawn_reason", "approvals.0.rings", "approvals.0.task_id"] },
      { path: "/api/v1/factory/me", as: "owner", fields: ["contributor.login", "packages", "packages.0.name", "packages.0.status"] },
      { path: "/api/v1/factory/me", as: "contributor", fields: ["contributor.login", "packages"] },
      { path: "/api/v1/factory/blocks", fields: ["packages", "packages.0.owner", "packages.0.name", "packages.0.blocked_at", "packages.0.blocked_by", "packages.0.blocked_reason"] },
    ],
    visible: EVERYONE,
  },
  {
    // The note says the same number the queue line does — the list's `waiting`, less a maintainer's own rows — and how many rows are staged.
    id: "review.queue-head",
    page: "/review",
    anchor: ['<section id="queue">', 'id="queue-note"'],
    script: ['$("#queue-note")', "num(forMe())", '" waiting for "', '" staged"', "of a version already approved"],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged", "waiting", "staged.0.already", "staged.0.owner"] }],
    visible: EVERYONE,
  },
  {
    id: "review.staged-table",
    page: "/review",
    anchor: ['<table id="staged">', "<th>Gate</th><th>Audit</th><th>Trial</th>", '<th class="decision">Decision</th>'],
    // The package's name is its page at the shell's one address (pkgHref), with the lab — the ring a build nobody decided yet is about — and the row's architecture.
    script: ['pager("#staged"', 'pkg(t.name, t.version, "lab", t.arch)', "function pkg(name, version, ring, arch)", "pkgHref(name, ring, arch)", "gatePill(t.vet, t.evidence.tests)", "auditPill(t.audit, t.evidence.audit)", "trialPill(t.trial, t.evidence.trial)", "t.built_by", "sc.projected", '"project-row"', '"mine-row"'],
    reads: [
      {
        path: "/api/v1/factory/review",
        fields: [
          "staged", "staged.0.id", "staged.0.name", "staged.0.version", "staged.0.arch", "staged.0.owner", "staged.0.kind", "staged.0.from", "staged.0.url", "staged.0.detected", "staged.0.category", "staged.0.duration_ms", "staged.0.finished_at",
          "staged.0.project_build", "staged.0.built_by", "staged.0.built_by.worker", "staged.0.built_by.owner", "staged.0.built_by.where", "staged.0.built_by.trusted_by", "staged.0.already",
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
    // The brake's record is public: the section and its two tables are for everyone.
    id: "review.brake",
    page: "/review",
    anchor: ['<section id="brake">', '<details class="tool">'],
    script: ["function renderBlocks()", '"/blocks"'],
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
    anchor: ['id="blocked-people"'],
    script: ['pager("#blocked-people"', 'lift("contributors"', "function lift(kind, what, b)", "isMaintainer() && !isOwner(b.blocked_by)", '"another maintainer lifts it"', 'orSignIn("a maintainer lifts it")'],
    reads: [{ path: "/api/v1/factory/blocks", fields: ["contributors", "contributors.0.login", "contributors.0.blocked_at", "contributors.0.blocked_by", "contributors.0.blocked_reason"] }],
    // m2 lifts what m1 set; m1's own lift would be 403, and a login nobody blocked 409.
    acts: [{ method: "POST", path: `/api/v1/factory/contributors/${F.blockedContributor}/unblock`, body: { reason: "lifted by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } }],
    visible: EVERYONE,
  },
  {
    id: "review.blocked-packages-table",
    page: "/review",
    anchor: ['id="blocked-packages"'],
    script: ['pager("#blocked-packages"', 'lift("packages"', '"unblock"'],
    reads: [{ path: "/api/v1/factory/blocks", fields: ["packages", "packages.0.name", "packages.0.owner", "packages.0.blocked_at", "packages.0.blocked_by", "packages.0.blocked_reason"] }],
    acts: [{ method: "POST", path: `/api/v1/factory/packages/${F.blockedPkg}/unblock`, body: { reason: "lifted by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } }],
    visible: EVERYONE,
  },
  {
    // Every decision, an approval taken back read as withdrawn; the recipe is waited for only where the approval stands (`standing`); the package links the most stable ring that serves it (`rings`).
    id: "review.decisions-table",
    page: "/review",
    anchor: ['id="decisions"', "<h2>Decided lately</h2>", 'href="/journal"'],
    script: ['pager("#decisions"', "pkg(a.name, a.version, servedRing(a.rings), a.arch)", "a.standing", "a.rebuild_task", "a.rebuild_status", "a.rebuild_result", "a.withdrawn_reason"],
    reads: [{ path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.created_at", "approvals.0.name", "approvals.0.version", "approvals.0.arch", "approvals.0.task_id", "approvals.0.decision", "approvals.0.standing", "approvals.0.rings", "approvals.0.by", "approvals.0.note", "approvals.0.withdrawn_at", "approvals.0.withdrawn_by", "approvals.0.withdrawn_reason", "approvals.0.rebuild_task", "approvals.0.rebuild_status", "approvals.0.rebuild_result"] }],
    visible: EVERYONE,
  },
];
