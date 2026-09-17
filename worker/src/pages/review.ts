/**
 * Review: the maintainers' door. What is waiting for a decision and what was
 * decided — for anyone; signed in, what is yours comes first: a contributor's
 * packages in the flow (waiting, then decided), a maintainer's queue. The
 * evidence (PKGBUILD, log, PKGINFO, the gate, the audit) is public; deciding
 * needs the maintainer role, never on one's own package, and copies nothing:
 * the project builds the recipe again from the evidence (docs/GOVERNANCE.md).
 */
import { page } from "./layout";
import { EVERYONE, SIGNED_IN, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { CATEGORIES } from "../categories";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Review</p>
    <h1>What is waiting for a maintainer, and what was decided</h1>
    <p class="lede">A contributor's build is evidence. The project builds it again on a worker it trusts, and a maintainer approves <em>that</em> build — never their own package. <a href="/docs/governance">The rules →</a></p>
    <p class="hint" id="who"></p>
  </div>

  <div class="tiles four" id="tiles"></div>

  <div id="mine" hidden>
    <div class="private-head"><span class="lock">private</span><h2>Yours</h2><span class="muted" id="mine-who"></span><span class="right"><a class="more-link" id="mine-ws" href="/factory">Your workspace →</a></span></div>
    <p class="notice warn" id="mine-blocked" hidden></p>
    <p class="sub" id="mine-queue" hidden></p>
    <div class="rgroups">
      <div class="rgroup" id="g-waiting"><h3>Waiting for a maintainer <span class="dim">nothing to do on your side</span></h3><div class="rrows" id="mine-waiting"></div></div>
      <div class="rgroup" id="g-decided"><h3>Decided <span class="dim">what a maintainer said</span></h3><div class="rrows" id="mine-decided"></div></div>
    </div>
  </div>

  <section id="queue">
    <div class="h2row"><h2>In review</h2><span class="dim" id="queue-note" style="font-size:13px"></span></div>
    <div class="table-wrap"><table id="staged" class="reader"><thead><tr><th>Package</th><th>Arch</th><th>Brought by</th><th>Build</th><th>Gate</th><th>Audit</th><th>Trial</th><th title="the chain's score today → with the maintainer's half green (What we test → The score)">Class</th><th>Since</th><th class="decision">Decision</th></tr></thead><tbody></tbody></table></div>
    <p class="sub" id="legend" hidden>Gate: the worker's own checks. Audit: the project's second agent — <span class="pill ok">ok</span> nothing to change · <span class="pill warn">warn</span> approve with the findings in mind · <span class="pill error">block</span> not as is. Evidence, never a decision; the category under the name is settled here.</p>
  </section>

  <section id="brake" hidden>
    <details class="tool"><summary>The brake <span class="dim">block a contributor or a package, with the reason on the record — another maintainer lifts it</span></summary>
      <form id="block-form" class="searchbar"><input id="block-what" placeholder="contributor login, or package name" required> <input id="block-why" placeholder="why — the record and the contributor see this" required minlength="4"> <button type="submit">Block</button></form>
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
  var STAGED = [], APPROVALS = [], BLOCKS = { contributors: [], packages: [] }, MINE = null;
  function pkg(name, version, arch) { return '<a href="/package/' + encodeURIComponent(name) + '?ring=lab' + (arch && arch !== "all" ? '&arch=' + esc(arch) : '') + '" title="the package as Packages shows it — where it is, and the factory\'s story of it"><b>' + esc(name) + '</b></a>' + (version ? ' <span class="mono muted">' + esc(version) + '</span>' : ''); }
  skeletonTiles("#tiles", 4); skeletonRows("#staged", 8, 3); skeletonRows("#decisions", 7, 3);

  // ---- who: the shell's WHO (the omc cookie, one fetch of /auth/me per page) — signed in, the private block; nobody, the hint to sign in
  whoami(function (me) {
    if (me) return signed();
    $("#who").innerHTML = 'Contributors and maintainers: <a href="/auth/github?next=/review">sign in with GitHub</a> to see yours first.';
  });
  function signed() {
    $("#who").textContent = "";
    $("#mine").hidden = false; $("#mine-who").textContent = WHO.login + " · " + (WHO.role || "contributor");
    if (isMaintainer()) { $("#brake").hidden = false; $("#legend").hidden = false; $("#staged").classList.remove("reader"); $("#mine-queue").hidden = false; }
    renderStaged(); renderMine(); privateLoad();
  }
  // What only a signed-in person sees: their packages (/me) and the brake (blocks) — the latter is public, but only matters here.
  function privateLoad() {
    api("GET", API + "/me").then(function (d) { if (!d.error) { MINE = d; renderMine(); } }).catch(function () {});
    api("GET", API + "/blocks").then(function (d) { BLOCKS = d; renderMine(); if (isMaintainer()) renderBlocks(); }).catch(function () {});
  }

  // ---- the tiles: what is in review, and how much was decided this week
  function renderTiles() {
    var rows = shown(), contrib = rows.filter(function (t) { return t.kind !== "project"; }), proj = rows.filter(function (t) { return t.kind === "project"; });
    var week = APPROVALS.filter(function (a) { return Date.now() - Date.parse(a.created_at) < 7 * 86400e3; });
    var oldest = rows.slice().sort(function (x, y) { return Date.parse(x.finished_at || 0) - Date.parse(y.finished_at || 0); })[0];
    setTiles("#tiles", [
      ["In review", num(rows.length), oldest ? "oldest " + ago(oldest.finished_at).replace(" ago", "") : "nothing waiting", rows.length ? "warn" : "ok"],
      ["Contributors' builds", num(contrib.length), "evidence: a maintainer has the project build it again"],
      ["The project's builds", num(proj.length), "waiting for a maintainer's approval into edge"],
      ["Decided · 7 d", num(week.length), num(week.filter(function (a) { return a.decision === "approved"; }).length) + " approved · " + num(week.filter(function (a) { return a.decision === "rejected"; }).length) + " rejected"]
    ]);
  }

  // ---- yours: one line per package of yours in the flow — waiting first, then decided
  function row(cls, name, version, arch, state, line, link) {
    return '<div class="rrow ' + cls + '"><div class="n">' + pkg(name, version, arch) + '</div><span class="pill none">' + esc(arch) + '</span><div class="s">' + state + ' ' + line + '</div>' + (link ? '<a class="go" href="' + esc(link[0]) + '">' + link[1] + '</a>' : '<span></span>') + '</div>';
  }
  function short(t, n) { t = String(t || ""); return t.length > n ? '<span title="' + esc(t) + '">' + esc(t.slice(0, n - 1)) + '…</span>' : esc(t); }
  function renderMine() {
    if (!WHO.me) return;
    var waiting = [], decided = [];
    // Blocked: the brake on you, or on a package of yours — the first thing to see.
    var meBlocked = (BLOCKS.contributors || []).filter(function (b) { return isOwner(b.login); })[0];
    $("#mine-blocked").hidden = !meBlocked;
    if (meBlocked) $("#mine-blocked").innerHTML = '<b>You are blocked</b> since ' + ago(meBlocked.blocked_at) + ' by ' + personLink(meBlocked.blocked_by) + ': ' + esc(meBlocked.blocked_reason || "") + ' — nothing of yours gets in until another maintainer lifts it.';
    (BLOCKS.packages || []).filter(function (b) { return isOwner(b.owner); }).forEach(function (b) {
      decided.push(row("act", b.name, null, "all", '<span class="pill error">blocked</span>', ago(b.blocked_at) + ' by ' + personLink(b.blocked_by) + ': ' + short(b.blocked_reason, 90), ["/docs/governance", "What a block means →"]));
    });
    // Staged builds of yours, one card per package and architecture: the project's build when there is one, your own otherwise.
    var seen = {};
    STAGED.filter(function (t) { return isOwner(t.owner); }).sort(function (a, b) { return (b.kind === "project") - (a.kind === "project"); }).forEach(function (t) {
      var key = t.name + "/" + t.arch; if (seen[key]) return; seen[key] = true;
      var pb = t.project_build;
      if (t.kind === "project") waiting.push(row("", t.name, t.version, t.arch, '<span class="pill ok">built again</span>', 'the project\'s ' + taskLink(t.id) + ' (from your ' + taskLink(t.from) + ') waits for approval', ["/build/" + t.id, "The build →"]));
      else if (pb && (pb.status === "queued" || pb.status === "leased")) waiting.push(row("", t.name, t.version, t.arch, '<span class="pill blue">building again</span>', 'the project is building it again (' + taskLink(pb.id) + '), from your ' + taskLink(t.id), ["/build/" + t.id, "Your build →"]));
      else if (pb && pb.status === "failed") waiting.push(row("", t.name, t.version, t.arch, taskPill("failed", pb.error), 'the project\'s ' + taskLink(pb.id) + ' (from your ' + taskLink(t.id) + ') failed — a maintainer decides', ["/build/" + pb.id, "The project's build →"]));
      else if (t.already) waiting.push(row("", t.name, t.version, t.arch, '<span class="pill none">already approved</span>', 'your build ' + taskLink(t.id) + ' is of a version approved ' + ago(t.already.at) + ' as ' + taskLink(t.already.task) + ' — nothing to decide', ["/build/" + t.id, "The build →"]));
      else waiting.push(row("", t.name, t.version, t.arch, taskPill("staged"), 'your build ' + taskLink(t.id) + ' waits for a maintainer' + (t.audit && t.audit.status === "done" && t.audit.verdict ? ' · audit <span class="pill ' + (t.audit.verdict === "ok" ? "ok" : t.audit.verdict === "warn" ? "warn" : "error") + '">' + esc(t.audit.verdict) + '</span>' : t.audit && t.audit.status === "queued" ? ' · audit waiting' : ''), ["/build/" + t.id, "Your build →"]));
    });
    // Decided: the record's latest word on each package of yours (a rejection carries the note; an approval, the ring).
    var mine = {}; ((MINE && MINE.packages) || []).forEach(function (p) { mine[p.name] = p; });
    var last = {};
    APPROVALS.forEach(function (a) { if (mine[a.name] && !last[a.name + "/" + a.arch]) last[a.name + "/" + a.arch] = a; });
    Object.keys(last).forEach(function (k) {
      var a = last[k], p = mine[a.name];
      if (a.withdrawn_at) decided.push(row("act", a.name, a.version, a.arch, taskPill("withdrawn"), 'the approval by ' + personLink(a.by) + ' was withdrawn ' + ago(a.withdrawn_at) + ' by ' + personLink(a.withdrawn_by) + ': ' + short(a.withdrawn_reason, 100) + ' — another maintainer decides', ["/build/" + a.task_id, "The build →"]));
      else if (a.decision === "rejected") decided.push(row("act", a.name, a.version, a.arch, taskPill("rejected"), ago(a.created_at) + ' by ' + personLink(a.by) + ': ' + short(a.note, 110), ["/factory", "Fix it, build again →"]));
      else { var inRings = a.rings && a.rings.length ? a.rings : (p && p.status === "published" ? ["edge"] : []); decided.push(row("ok", a.name, a.version, a.arch, taskPill("approved"), ago(a.created_at) + ' by ' + personLink(a.by) + (inRings.length ? ' — in ' + inRings.join(" · ") + ', signed by the pool' : ' — the project\'s build is on its way into edge') + (a.note ? ' · ' + short(a.note, 80) : ''), inRings.length ? ["/package/" + encodeURIComponent(a.name) + "?ring=" + inRings[inRings.length - 1] + "&arch=" + a.arch, "The package →"] : ["/build/" + a.task_id, "The build →"])); }
    });
    $("#mine-waiting").innerHTML = waiting.join("") || '<p class="sub" style="margin:0">Nothing of yours waiting. <a href="/request">Request a package →</a></p>';
    $("#mine-decided").innerHTML = decided.join("") || '<p class="sub" style="margin:0">No decision on a package of yours yet.</p>';
    $("#g-waiting").hidden = isMaintainer() && !waiting.length; $("#g-decided").hidden = isMaintainer() && !decided.length;
    // A maintainer's own line: what waits for them, what the project is building, what is theirs (another maintainer decides).
    if (isMaintainer()) {
      var forMe = shown().filter(function (t) { return !isOwner(t.owner) && decidable(t); }), inFlight = STAGED.filter(function (t) { return t.kind !== "project" && t.project_build && (t.project_build.status === "queued" || t.project_build.status === "leased"); }), own = shown().filter(function (t) { return isOwner(t.owner) && !t.already; });
      $("#mine-queue").innerHTML = '<b>' + num(forMe.length) + '</b> waiting for your decision <a href="#queue">↓</a> · <b>' + num(inFlight.length) + '</b> the project is building · <b>' + num(own.length) + '</b> yours — another maintainer decides';
    }
  }
  // One row per package and architecture: a contributor's build the project
  // has built again and staged is represented by the project's row, which
  // says "from #<theirs>" — two rows of the same name, version and
  // architecture read as two packages (bitwarden, 2026-09-17). The evidence
  // stays reachable from the project's row and on the build's own page.
  function folded(t) { var pb = t.project_build; return t.kind !== "project" && !!pb && pb.status === "staged" && STAGED.some(function (p) { return p.id === pb.id; }); }
  function shown() { return STAGED.filter(function (t) { return !folded(t); }); }
  // A staged build a maintainer can act on now: the project's (approve), or a contributor's the project is not already building — and not a build of a version already approved (nothing to decide: drop it).
  // Ready or nothing to decide — the project's build included: its chain's contributor half (the request, the gate, the audit) must be complete before a maintainer's time is asked.
  function decidable(t) { var pb = t.project_build; return !t.already && (!t.score || t.score.ready) && (t.kind === "project" || !pb || pb.status === "failed"); }
  function taskLink(id, text) { return '<a href="/build/' + id + '">' + (text || "#" + id) + '</a>'; }

  // ---- in review: the same table for everyone; the decision column for maintainers
  function category(t) {
    if (!isMaintainer()) return t.category ? '<span class="pill none">' + esc(t.category) + '</span>' : '';
    return '<select class="cat" data-category="' + esc(t.name) + '" title="the category a person finds it under">' + (t.category ? '' : '<option value="" selected>category…</option>') + CATEGORIES.map(function (c) { return '<option' + (c === t.category ? ' selected' : '') + '>' + c + '</option>'; }).join("") + '</select>';
  }
  // Where the bytes came from: the worker that held the lease, whose it is, the host it names, who vouched for it (the project's builds) — the approval sees the machine, not only the evidence.
  function builtOn(t) {
    var b = t.built_by; if (!b) return "";
    var who = b.owner ? b.owner + "'s " : "", word = b.trusted_by ? "trusted on the word of " + b.trusted_by : (t.kind === "project" ? "trusted before trust took two words" : "a community worker");
    return ' <span class="dim" title="' + esc(who + "worker " + b.worker + (b.where ? " on " + b.where : "") + " — " + word) + '">on ' + esc(b.where || b.worker) + '</span>';
  }
  // The gate's verdict: the worker's own checks on the build, with what warned or failed beside the pill (the shell's gate() is a control gated).
  function gateVerdict(t) {
    var v = t.vet;
    if (!v) return '<span class="dim" title="built before the gate existed">—</span>';
    if (v.verdict === "pass") return '<span class="pill ok">pass</span> <a class="run" href="' + t.evidence.tests + '" title="' + esc((v.warned || []).join(", ")) + '">' + (v.warnings ? v.warnings + ' warning' + (v.warnings === 1 ? '' : 's') : 'clean') + '</a>';
    return '<span class="pill error">' + esc(v.verdict) + '</span> <a class="run" href="' + t.evidence.tests + '">' + esc((v.failed || []).join(", ")) + '</a>';
  }
  function audit(t) {
    var a = t.audit || { status: "none" };
    if (a.status === "done" && a.verdict) {
      var cls = a.verdict === "ok" ? "ok" : a.verdict === "warn" ? "warn" : "error";
      return '<span class="pill ' + cls + '">' + esc(a.verdict) + '</span> <a class="run" href="' + t.evidence.audit + '" title="' + esc(a.summary || "") + '">' + (a.findings ? a.findings + ' finding' + (a.findings === 1 ? '' : 's') + (a.high ? ', ' + a.high + ' high' : '') : 'report') + '</a>';
    }
    if (a.status === "queued") return '<span class="muted">waiting</span>';
    if (a.status === "leased") return '<span class="muted">running</span>';
    if (a.status === "failed") return '<span class="pill none" title="' + esc(a.error || "") + '">failed</span>';
    if (a.status === "done") return '<span class="pill none">unreadable</span>';
    return '<span class="muted">—</span>';
  }
  // The trial: a real pacman installed the project's build from the lab above edge in a clean container — or what stopped it; the transcript is beside the evidence.
  function trial(t) {
    var a = t.trial || { status: "none" };
    if (a.status === "done" && a.verdict) {
      var ok = a.verdict === "ok";
      return '<span class="pill ' + (ok ? "ok" : "error") + '">' + (ok ? "installs" : esc(a.verdict)) + '</span> <a class="run" href="' + t.evidence.trial + '" title="the lab above edge: pacman -S, hooks, files">transcript</a>';
    }
    if (a.status === "queued") return '<span class="muted">waiting</span>';
    if (a.status === "leased") return '<span class="muted">installing</span>';
    if (a.status === "failed") return '<span class="pill none" title="' + esc(a.error || "") + '">did not run</span>';
    if (a.status === "done") return '<span class="pill none">unreadable</span>';
    return '<span class="muted" title="only the project\'s build is tried">—</span>';
  }
  // The class today, the projection on hover; a chain whose contributor's half is not complete says so — a maintainer's time is not asked yet.
  function klass(t) {
    var sc = t.score; if (!sc) return '<span class="muted">—</span>';
    return classPill(sc, sc.class, sc.points + "/100 today · with the maintainer's half green: " + sc.projected) + (sc.class !== sc.projected ? ' <span class="dim" title="with the maintainer\'s half green">→ ' + esc(sc.projected) + '</span>' : '') + (!sc.ready ? ' <span class="pill none" title="a request as the form asks today, a build that passed the gate, audited — then a maintainer">not ready</span>' : '');
  }
  function decision(t) {
    if (!isMaintainer()) return '';
    if (t.already) return '<span class="muted" title="the same name, version and architecture were approved as build #' + t.already.task + '">already approved</span> <button type="button" data-reject="' + t.id + '" data-note="a build of a version already approved (#' + t.already.task + ')">Drop</button>';
    if (t.score && !t.score.ready) return '<span class="muted" title="the contributor\'s half is not complete: a request as the form asks, a build through the gate, an audit">not ready — the contributor\'s turn</span>';
    if (isOwner(t.owner)) return '<span class="muted" title="conflict of interest: nobody decides on their own package">yours — another maintainer</span>';
    var pb = t.project_build;
    if (t.kind === "project") return '<button type="button" data-approve="' + t.id + '">Approve</button> <button type="button" data-reject="' + t.id + '">Reject</button>';
    if (pb && (pb.status === "queued" || pb.status === "leased")) return '<span class="muted">the project is building it (#' + pb.id + ')</span> <button type="button" data-reject="' + t.id + '">Reject</button>';
    if (pb && pb.status === "staged") return '<span class="muted">the project\'s build #' + pb.id + ' is in this list</span> <button type="button" data-reject="' + t.id + '">Reject</button>';
    return (pb && pb.status === "failed" ? '<span class="pill error" title="' + esc(pb.error || "") + '">project build #' + pb.id + ' failed</span> ' : '') + '<button type="button" data-build="' + t.id + '">Build by the project</button> <button type="button" data-reject="' + t.id + '">Reject</button>';
  }
  function renderStaged() {
    var rows = shown();
    var forMe = isMaintainer() ? rows.filter(function (t) { return !isOwner(t.owner) && decidable(t); }).length : 0, redundant = rows.filter(function (t) { return t.already; }).length;
    $("#queue-note").textContent = rows.length ? (isMaintainer() ? num(forMe) + " waiting for your decision · " : "") + num(rows.length) + " staged" + (redundant ? " · " + num(redundant) + " of a version already approved" : "") : "";
    pager("#staged", rows, function (t) {
      var det = t.detected || {}, project = t.kind === "project", pb = t.project_build;
      var build = project ? '<span class="pill ok" title="the project\'s own build, from a contributor\'s evidence">the project</span> <span class="muted">' + taskLink(t.id) + ' from ' + taskLink(t.from) + '</span>' + builtOn(t)
        : '<span class="muted">evidence · ' + taskLink(t.id) + (t.duration_ms ? ' · ' + Math.round(t.duration_ms / 1000) + ' s' : '') + '</span>' + builtOn(t) + (pb && (pb.status === "queued" || pb.status === "leased") ? ' <span class="pill blue">building again</span>' : pb && pb.status === "staged" ? ' <span class="pill ok">built again</span>' : '')
        + (t.already ? ' <span class="pill none" title="approved ' + esc(ago(t.already.at)) + ' by ' + esc(t.already.by) + ' as build #' + t.already.task + (t.already.rebuild_task ? '; the project\'s build #' + t.already.rebuild_task + ' ' + esc(t.already.rebuild_status || '') : '') + ' — nothing to decide">already approved</span>' : '');
      var mine = isOwner(t.owner), forYou = isMaintainer() && !mine && decidable(t);
      return '<tr id="t-' + t.id + '"' + (project ? ' class="project-row"' : '') + (forYou ? ' class="for-you"' : mine ? ' class="mine-row"' : '') + '><td>' + pkg(t.name, t.version, t.arch) + (det.license ? ' <span class="dim">' + esc(det.license) + '</span>' : '') + (t.url ? ' <a class="run dim" href="' + esc(t.url) + '" title="' + esc(t.url) + '">source</a>' : '') + '<br>' + category(t) + '</td><td>' + esc(t.arch) + '</td>' +
        '<td>' + personLink(t.owner) + (mine ? ' <span class="pill none">you</span>' : '') + '</td><td>' + build + '</td><td>' + gateVerdict(t) + '</td><td>' + audit(t) + '</td><td>' + trial(t) + '</td>' +
        '<td>' + klass(t) + '</td>' +
        '<td class="when">' + ago(t.finished_at) + '</td><td class="decision">' + decision(t) + '</td></tr>';
    }, { empty: "nothing waiting for review", text: function (t) { return [t.id, t.name, t.version, t.arch, t.owner, t.kind, t.category, t.score && t.score.class].join(" "); } });
    endSkeleton();
  }
  function renderDecisions() {
    pager("#decisions", APPROVALS, function (a) {
      return '<tr><td class="when">' + ago(a.created_at) + '</td><td>' + pkg(a.name, a.version, a.arch) + ' <span class="dim">' + taskLink(a.task_id) + '</span></td><td>' + esc(a.arch) + '</td><td>' + (a.withdrawn_at ? taskPill("withdrawn", "approved by " + a.by + ", withdrawn " + ago(a.withdrawn_at) + " by " + a.withdrawn_by + ": " + (a.withdrawn_reason || "")) : taskPill(a.decision)) + '</td><td>' + personLink(a.by) + (a.withdrawn_at ? ' <span class="dim">· withdrawn by ' + personLink(a.withdrawn_by) + '</span>' : '') + '</td><td class="muted">' + esc(a.withdrawn_at ? (a.withdrawn_reason || "") : (a.note || "")) + '</td><td>' + (a.rebuild_task ? taskLink(a.rebuild_task) + ' ' + esc(a.rebuild_status || "") + (a.rebuild_result ? ' <span class="mono">' + esc(a.rebuild_result) + '</span>' : '') : (a.decision === "approved" ? '<span class="dim">waiting for the recipe on main</span>' : '—')) + '</td></tr>';
    }, { empty: "no decision yet", text: function (a) { return [a.name, a.version, a.arch, a.decision, a.by, a.note].join(" "); } });
    endSkeleton();
  }

  // ---- the maintainer's tools: three decisions, the brake, the category
  // The project's workers, for the choice of where the project builds (the native one, not the emulated one): read when the dialog opens.
  function projectWorkers() { return fetch("/api/v1/factory?limit=10").then(function (r) { return r.json(); }).then(function (d) { return d.workers || []; }).catch(function () { return []; }); }
  function decide(id, what, given) {
    var row = STAGED.filter(function (t) { return t.id === Number(id); })[0];
    var asked = given ? Promise.resolve(given) : what === "reject"
      ? ask({ title: "Reject build #" + id, text: "The contributor reads the note and builds again. The rejection is on the record.", input: "required", placeholder: "what is wrong, in a line or two", confirm: "Reject", danger: true })
      : what === "approve" ? ask({ title: "Approve build #" + id, text: "The project's build goes into edge, signed by the pool; the approval is on the record with your name.", input: "optional", confirm: "Approve" })
      : projectWorkers().then(function (ws) { return ask({ title: "Have the project build #" + id + " again", text: "A trusted review worker builds the recipe again with the project's agent — the contributor's bytes are never used. The result shows here when it is staged.", select: whereOptions(ws, row ? row.arch : "x86_64", WHO.login, true), input: "optional", placeholder: "a hint for the project's agent (optional)", confirm: "Build by the project" }); });
    asked.then(function (got) {
      if (got === null) return;
      var body = { note: got && typeof got === "object" ? got.note : got };
      if (got && typeof got === "object" && got.pick) body.worker = got.pick;
      api("POST", API + "/tasks/" + id + "/" + what, body).then(function (d) {
        if (d.error) toast(esc(d.error), "error");
        else toast(what === "approve" ? "Approved — the project's build goes into edge (publish job <a href=\"/build/" + d.publish + "\">#" + d.publish + "</a>)." : what === "build" ? "The project is building it: task <a href=\"/build/" + d.task + "\">#" + d.task + "</a>, on " + (d.pinned_to ? esc(wtShort(d.pinned_to)) : "a review worker") + " with the project's agent." : given ? "Dropped." : "Rejected — the contributor sees the note.");
        load();
      });
    });
  }
  function block(kind, what, lift) {
    ask(lift ? { title: "Lift the block on " + what, text: "The record keeps why.", input: "required", confirm: "Lift it" } : { title: "Block " + what, text: "The record and the contributor see this.", input: "required", confirm: "Block", danger: true }).then(function (why) {
      if (why === null) return;
      api("POST", API + "/" + kind + "/" + encodeURIComponent(what) + "/" + (lift ? "unblock" : "block"), { reason: why }).then(function (d) { if (d.error) toast(esc(d.error), "error"); else toast(lift ? "Lifted." : "Blocked."); load(); });
    });
  }
  function renderBlocks() {
    pager("#blocked-people", (BLOCKS.contributors || []), function (b) {
      return '<tr><td><b>' + personLink(b.login) + '</b></td><td class="when">' + ago(b.blocked_at) + '</td><td>' + personLink(b.blocked_by) + '</td><td>' + esc(b.blocked_reason || "") + '</td><td>' + (!isOwner(b.blocked_by) ? '<button type="button" data-unblock="contributors" data-what="' + esc(b.login) + '">Lift</button>' : '') + '</td></tr>';
    }, { empty: "no contributor blocked" });
    pager("#blocked-packages", (BLOCKS.packages || []), function (b) {
      return '<tr><td><b>' + esc(b.name) + '</b></td><td>' + personLink(b.owner) + '</td><td class="when">' + ago(b.blocked_at) + '</td><td>' + personLink(b.blocked_by) + '</td><td>' + esc(b.blocked_reason || "") + '</td><td>' + (!isOwner(b.blocked_by) ? '<button type="button" data-unblock="packages" data-what="' + esc(b.name) + '">Lift</button>' : '') + '</td></tr>';
    }, { empty: "no package blocked" });
  }
  document.addEventListener("change", function (ev) {
    var s = ev.target.closest ? ev.target.closest("select[data-category]") : null; if (!s || !s.value) return;
    api("POST", API + "/packages/" + encodeURIComponent(s.getAttribute("data-category")) + "/category", { category: s.value }).then(function (d) { if (d.error) { toast(esc(d.error), "error"); load(); } });
  });
  document.addEventListener("click", function (ev) {
    var u = ev.target.closest ? ev.target.closest("button[data-unblock]") : null;
    if (u) return block(u.getAttribute("data-unblock"), u.getAttribute("data-what"), true);
    var b = ev.target.closest ? ev.target.closest("button[data-approve],button[data-reject],button[data-build]") : null; if (!b) return;
    decide(b.getAttribute("data-approve") || b.getAttribute("data-reject") || b.getAttribute("data-build"), b.hasAttribute("data-approve") ? "approve" : b.hasAttribute("data-build") ? "build" : "reject", b.getAttribute("data-note"));
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

  // ---- the public lists, then whatever is private
  function load() {
    Promise.all([api("GET", API + "/review"), api("GET", API + "/approvals")]).then(function (rs) {
      STAGED = rs[0].staged || []; APPROVALS = rs[1].approvals || [];
      renderTiles(); renderStaged(); renderDecisions(); renderMine();
    }).catch(function () { endSkeleton(); });
  }
  load();
  setInterval(function () { load(); if (WHO.me) privateLoad(); }, 60000);
`;

export function reviewHtml(poolUrl: string, version: RunningVersion): string {
  return page({
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
 * What /review is made of, top to bottom: the hero with its sign-in hint,
 * the four tiles, the Yours block a signed-in person gets (the head, the
 * blocked notice, a maintainer's queue line, the waiting and decided
 * lists), the In review table with the category and the decision cell, the
 * audit legend, the brake (the form and the two blocked tables), the
 * Decided lately table, and the dialogs the decisions ask through. Every
 * read is one of the page's four public lists (/factory/review,
 * /factory/approvals, /factory/blocks, /factory?limit=10) or what a session
 * unlocks (/auth/me, /factory/me); every act is a maintainer's — the
 * decisions on the fixture's staged builds, the category, the brake. The
 * brake's form lands on rows the handler refuses (a maintainer, a pool
 * package), so nothing is blocked by the tests; the two blocked tables lift
 * what the fixture seeded — carol and her package, blocked by m1 — as m2,
 * the other maintainer, once the reads that draw those rows have run.
 */
export const REVIEW_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "review.hero",
    page: "/review",
    anchor: ['<p class="eyebrow">Review</p>', 'id="who"', 'href="/auth/github?next=/review"'],
    script: ['$("#who")', "/auth/github?next=/review", "sign in with GitHub"],
    reads: [
      { path: "/auth/me", status: 401 },
      { path: "/auth/me", as: "owner", fields: ["login", "role"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "review.tiles",
    page: "/review",
    anchor: ['id="tiles"'],
    script: ['skeletonTiles("#tiles", 4)', 'setTiles("#tiles"', '"In review"', '"Decided · 7 d"', "x.finished_at", 'a.decision === "approved"'],
    reads: [
      { path: "/api/v1/factory/review", fields: ["staged", "staged.0.kind", "staged.0.finished_at"] },
      { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.created_at", "approvals.0.decision"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "review.yours-head",
    page: "/review",
    anchor: ['id="mine"', 'id="mine-who"', 'id="mine-ws"'],
    script: ['$("#mine")', '$("#mine-who")', "WHO.role"],
    reads: [
      { path: "/auth/me", as: "owner", fields: ["login", "role"] },
      { path: "/auth/me", as: "maintainer", fields: ["login", "role"] },
    ],
    visible: SIGNED_IN,
  },
  {
    id: "review.yours-blocked",
    page: "/review",
    anchor: ['id="mine-blocked"'],
    script: ['$("#mine-blocked")', "<b>You are blocked</b>", "BLOCKS.contributors", "meBlocked.blocked_reason"],
    reads: [{ path: "/api/v1/factory/blocks", fields: ["contributors", "contributors.0.login", "contributors.0.blocked_at", "contributors.0.blocked_by", "contributors.0.blocked_reason"] }],
    visible: ["contributor", "owner"],
  },
  {
    id: "review.yours-queue-line",
    page: "/review",
    anchor: ['id="mine-queue"'],
    script: ['$("#mine-queue")', "waiting for your decision", "function decidable(t)"],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged.0.owner", "staged.0.kind", "staged.0.already", "staged.0.score.ready", "staged.0.project_build"] }],
    visible: ["maintainer"],
  },
  {
    id: "review.yours-waiting",
    page: "/review",
    anchor: ['id="g-waiting"', 'id="mine-waiting"'],
    script: ['$("#mine-waiting")', '$("#g-waiting")', "t.project_build", "t.already.task", ">built again<", "t.audit.verdict"],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged.0.id", "staged.0.owner", "staged.0.name", "staged.0.version", "staged.0.arch", "staged.0.kind", "staged.0.from", "staged.0.project_build", "staged.0.already", "staged.0.audit.status"] }],
    visible: SIGNED_IN,
  },
  {
    id: "review.yours-decided",
    page: "/review",
    anchor: ['id="g-decided"', 'id="mine-decided"'],
    script: ['$("#mine-decided")', '$("#g-decided")', "MINE.packages", "a.withdrawn_at", "a.rings", "BLOCKS.packages"],
    reads: [
      { path: "/api/v1/factory/approvals", fields: ["approvals.0.name", "approvals.0.arch", "approvals.0.version", "approvals.0.decision", "approvals.0.by", "approvals.0.note", "approvals.0.created_at", "approvals.0.withdrawn_at", "approvals.0.withdrawn_by", "approvals.0.withdrawn_reason", "approvals.0.rings", "approvals.0.task_id"] },
      { path: "/api/v1/factory/me", as: "owner", fields: ["contributor.login", "packages", "packages.0.name", "packages.0.status"] },
      { path: "/api/v1/factory/me", as: "contributor", fields: ["contributor.login", "packages"] },
      { path: "/api/v1/factory/blocks", fields: ["packages", "packages.0.owner", "packages.0.name", "packages.0.blocked_at", "packages.0.blocked_by", "packages.0.blocked_reason"] },
    ],
    visible: SIGNED_IN,
  },
  {
    id: "review.queue-head",
    page: "/review",
    anchor: ['<section id="queue">', 'id="queue-note"'],
    script: ['$("#queue-note")', '" staged"', "of a version already approved"],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged", "staged.0.already", "staged.0.owner", "staged.0.score.ready"] }],
    visible: EVERYONE,
  },
  {
    id: "review.staged-table",
    page: "/review",
    anchor: ['id="staged"', 'class="reader"', "<th>Gate</th><th>Audit</th><th>Trial</th>"],
    script: ['pager("#staged"', "t.evidence.tests", "t.evidence.audit", "t.evidence.trial", "t.built_by", "sc.projected", '"project-row"', '"mine-row"'],
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
    id: "review.category-select",
    page: "/review",
    anchor: ['id="staged"'],
    script: ["select[data-category]", 'data-category="', '"/packages/"', '"/category"', "CATEGORIES.map("],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged.0.category", "staged.0.name"] }],
    acts: [{ method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/category`, body: { category: CATEGORIES[0] }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } }],
    visible: EVERYONE,
  },
  {
    id: "review.decision-buttons",
    page: "/review",
    anchor: ['id="staged"', 'class="decision"'],
    script: ["data-approve", "data-reject", "data-build", '"/tasks/" + id + "/" + what'],
    reads: [{ path: "/api/v1/factory/review", fields: ["staged", "staged.0.id", "staged.0.kind", "staged.0.owner", "staged.0.trust", "staged.0.audit", "staged.0.project_build"] }],
    acts: [
      { method: "POST", path: `/api/v1/factory/tasks/${F.projectTask}/approve`, body: { note: "reads well" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
      { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/build`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
      { method: "POST", path: `/api/v1/factory/tasks/${F.disposableTask}/reject`, body: { note: "the source is not the upstream's" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } },
    ],
    visible: ["maintainer"],
  },
  {
    id: "review.legend",
    page: "/review",
    anchor: ['id="legend"'],
    script: ['$("#legend")'],
    visible: ["maintainer"],
  },
  {
    id: "review.brake",
    page: "/review",
    anchor: ['<section id="brake" hidden>', '<details class="tool">'],
    script: ['$("#brake")', "function renderBlocks()", '"/blocks"'],
    reads: [{ path: "/api/v1/factory/blocks", fields: ["contributors", "packages"] }],
    visible: ["maintainer"],
  },
  {
    id: "review.brake-form",
    page: "/review",
    anchor: ['id="block-form"', 'id="block-what"', 'id="block-why"', 'minlength="4"'],
    script: ['$("#block-form")', '"/api/v1/users/"', 'r.status === 200 ? "contributors" : "packages"', '"/block"'],
    reads: [
      { path: `/api/v1/users/${F.owner}`, fields: ["login"] },
      { path: `/api/v1/users/${F.factoryPkg}`, status: 404 },
    ],
    acts: [
      { method: "POST", path: `/api/v1/factory/contributors/${F.m1}/block`, body: { reason: "typed into the brake by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 409 } },
      { method: "POST", path: `/api/v1/factory/packages/${F.pkg}/block`, body: { reason: "typed into the brake by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 404 } },
    ],
    visible: ["maintainer"],
  },
  {
    id: "review.blocked-people-table",
    page: "/review",
    anchor: ['id="blocked-people"'],
    script: ['pager("#blocked-people"', 'data-unblock="contributors"', "!isOwner(b.blocked_by)"],
    reads: [{ path: "/api/v1/factory/blocks", fields: ["contributors", "contributors.0.login", "contributors.0.blocked_at", "contributors.0.blocked_by", "contributors.0.blocked_reason"] }],
    // m2 lifts what m1 set; m1's own lift would be 403, and a login nobody blocked 409.
    acts: [{ method: "POST", path: `/api/v1/factory/contributors/${F.blockedContributor}/unblock`, body: { reason: "lifted by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } }],
    visible: ["maintainer"],
  },
  {
    id: "review.blocked-packages-table",
    page: "/review",
    anchor: ['id="blocked-packages"'],
    script: ['pager("#blocked-packages"', 'data-unblock="packages"', '"unblock"'],
    reads: [{ path: "/api/v1/factory/blocks", fields: ["packages", "packages.0.name", "packages.0.owner", "packages.0.blocked_at", "packages.0.blocked_by", "packages.0.blocked_reason"] }],
    acts: [{ method: "POST", path: `/api/v1/factory/packages/${F.blockedPkg}/unblock`, body: { reason: "lifted by the tests" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } }],
    visible: ["maintainer"],
  },
  {
    id: "review.decisions-table",
    page: "/review",
    anchor: ['id="decisions"', "<h2>Decided lately</h2>", 'href="/journal"'],
    script: ['pager("#decisions"', "a.rebuild_task", "a.rebuild_status", "a.rebuild_result", "a.withdrawn_reason"],
    reads: [{ path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.created_at", "approvals.0.name", "approvals.0.version", "approvals.0.arch", "approvals.0.task_id", "approvals.0.decision", "approvals.0.by", "approvals.0.note", "approvals.0.withdrawn_at", "approvals.0.withdrawn_by", "approvals.0.withdrawn_reason", "approvals.0.rebuild_task", "approvals.0.rebuild_status", "approvals.0.rebuild_result"] }],
    visible: EVERYONE,
  },
  {
    id: "review.decide-dialogs",
    page: "/review",
    anchor: ["dialog.ask {", "#toasts {"],
    script: ['"/api/v1/factory?limit=10"', '"Approve build #"', '"Reject build #"', '"Have the project build #"', "whereOptions(ws", "d.publish", "d.pinned_to"],
    reads: [{ path: "/api/v1/factory?limit=10", fields: ["workers", "workers.0.id", "workers.0.arch", "workers.0.owner", "workers.0.mode", "workers.0.side", "workers.0.kinds", "workers.0.alive", "workers.0.agent", "workers.0.agent_status", "workers.0.current_task", "workers.0.labels", "workers.0.update", "workers.0.revoked_at"] }],
    visible: ["maintainer"],
  },
];
