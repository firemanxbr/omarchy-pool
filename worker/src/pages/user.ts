/**
 * A contributor's or maintainer's public page: who they are on GitHub,
 * what they registered and built, what they approved, the workers they run.
 * Their own page is also their workspace — "Sign in with GitHub" lands here:
 * Build and remove on the packages, register and revoke on the workers, the
 * evidence of every build, the staging quota, a token for scripts. Everything
 * is the public API (`/api/v1/factory/*`) with the browser session.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const BODY = String.raw`
  <div class="profile-head">
    <span class="avatar lg" id="avatar">…</span>
    <div><p class="crumbs"><a href="/factory">Factory</a> / <span id="crumb"></span></p><h1 id="title">…</h1><p class="line" id="line"></p></div>
    <span id="share-btn"></span>
  </div>
  <div class="tiles" id="tiles"></div>
  <div class="two" style="margin-bottom:44px">
    <div class="panel"><h3>Activity <span class="dim" style="font-size:12px;font-weight:400">16 weeks · builds, decisions, packages</span></h3><div class="activity" id="activity"></div><p class="sub" id="activity-note" style="margin:8px 0 0;font-size:12.5px"></p></div>
    <div class="panel"><h3>Track record <a href="/docs/governance">the formula →</a></h3><div class="score"><b id="score">…</b><div class="f" id="score-f"></div></div></div>
  </div>

  <section id="record-section" hidden>
    <h2>Track record</h2>
    <p class="sub">From the record the pool keeps anyway — what this person brought that a maintainer let in, what they built, what they decided. One number, with a formula anyone can check (<a href="/docs/governance">Governance</a>): it says where the work was done, not who someone is.</p>
    <div class="table-wrap"><table id="record"><thead><tr><th>Contributed</th><th>Maintained</th><th>Score</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Packages</h2><a class="more-link" id="pk-request" href="/request" hidden>+ request one →</a></div>
    <p class="sub">Registered by this contributor: the name is theirs, their worker builds it as evidence, the project builds it again, <b>another</b> maintainer decides — a maintainer who brings a package is its contributor. Open a row: the request as the form checks it, then each architecture on its own — its build, the gate, the audit, the score, whether it is ready for a maintainer.</p>
    <div class="table-wrap"><table id="packages" class="pk"><thead><tr><th></th><th>Package</th><th>Category</th><th>Project</th><th>Arches</th><th>Stage</th><th>Where it stands</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Builds</h2><span class="dim" id="quota" style="font-size:12px"></span></div>
    <p class="sub">On this contributor's workers — evidence for a maintainer, never what users get directly. The number opens the build, whole.</p>
    <div class="table-wrap"><table id="builds"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Status</th><th>Why</th><th>Worker</th><th>Took</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Workers</h2><button type="button" class="more-link" id="w-toggle" hidden>+ register one</button></div>
    <p class="sub">The machines under this name, as the <a href="/workers">Workers</a> page shows them — their own (a contributor's), the review ones and the pool's, when this person keeps them.</p>
    <div id="w-own" hidden>
      <p class="sub" style="margin:0 0 10px;font-size:12.5px">Optional — the shared queue builds for you otherwise. Register one and run the signed image with the token it gives you, shown once: your packages at once, with your agent; with <code>WORKER_SHARED=1</code>, everyone's queue too. <a href="/docs/workers">Run a worker →</a></p>
      <form id="worker-form" class="form" onsubmit="return false" hidden>
        <label>Name <input type="text" id="w-name" placeholder="laptop" required></label>
        <label>Architecture <select id="w-arch"><option>x86_64</option><option>aarch64</option></select></label>
        <button type="submit" id="w-btn">Register worker</button>
      </form>
      <div id="w-new" hidden><p class="sub">Your worker token, shown once. Run one of these wherever the worker lives (podman or docker):</p><pre id="w-cmd"></pre></div>
    </div>
    <div class="panel" id="wp-community" hidden><h3>Contributor's <span class="dim" style="font-size:12px;font-weight:400">their own machines: their packages, or whatever is queued when shared</span></h3><div class="table-wrap" style="border:0"><table id="w-community" class="wtable"><thead><tr></tr></thead><tbody></tbody></table></div></div>
    <div class="panel" id="wp-review" style="margin-top:16px" hidden><h3>Review <span class="dim" style="font-size:12px;font-weight:400">the maintainers' side: builds again, publishes, audits</span></h3><div class="table-wrap" style="border:0"><table id="w-review" class="wtable"><thead><tr></tr></thead><tbody></tbody></table></div></div>
    <div class="panel" id="wp-project" style="margin-top:16px" hidden><h3>Project <span class="dim" style="font-size:12px;font-weight:400">the pool's own jobs, on the host this maintainer keeps</span></h3><div class="table-wrap" style="border:0"><table id="w-project" class="wtable"><thead><tr></tr></thead><tbody></tbody></table></div></div>
    <p class="sub" id="w-none" hidden style="margin:0">No worker registered under this name.</p>
    <div id="wt-legend"></div>
  </section>

  <section id="approvals-section" hidden>
    <h2>Approvals</h2>
    <p class="sub">Decisions this maintainer signed: what they let into the pool, what they sent back, what they took back.</p>
    <div class="table-wrap"><table id="approvals"><thead><tr><th>When</th><th>Package</th><th>Arch</th><th>Decision</th><th>Note</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var login = decodeURIComponent(location.pathname.split("/")[2] || "");
  $("#crumb").textContent = login;
  skeletonTiles("#tiles", 4); skeletonRows("#packages", 7, 2); skeletonRows("#builds", 8, 3);
  function pill(s) {
    var c = { leased: "var(--blue)", queued: "var(--amber)", done: "var(--green)", staged: "var(--green)", failed: "var(--red)", cancelled: "var(--dim)", registered: "var(--dim)", waiting: "var(--amber)", building: "var(--blue)", withdrawn: "var(--dim)", approved: "var(--green)", rejected: "var(--red)", unmaintained: "var(--red)" }[s] || "var(--dim)";
    return '<span class="pill" style="color:' + c + ';border-color:' + c + '">' + esc(s === "leased" ? "building" : s) + '</span>';
  }
  function took(ms) { if (ms == null) return "—"; var s = Math.round(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + " min"; }
  // Your own page is the workspace: the same tables, with the buttons.
  var own = false, API = "/api/v1/factory", REPO = "${REPO_URL}";
  function call(method, path, body) {
    return busy(fetch(API + path, { method: method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).then(function (r) { return r.json().then(function (d) { d.__status = r.status; return d; }); });
  }
  function evidence(t) {
    var log = '<a class="run" href="' + API + '/tasks/' + t.id + '/artifacts/build.log">log</a>';
    return t.status === "staged" ? log + ' <a class="run" href="' + API + '/tasks/' + t.id + '/artifacts/PKGBUILD">PKGBUILD</a>' : t.status === "failed" ? log : "";
  }
  var OPEN = {}, LATEST = {}, FACTORY = null, STORIES = {};
  // The workers under this name, from the same listing the Workers page reads — the same rows, by kind, in the order that reads for a person: theirs, the review ones, the pool's.
  function renderWorkers() {
    if (!FACTORY) return;
    var mine = FACTORY.workers.filter(function (w) { return w.owner === login; });
    var kinds = { community: [], review: [], project: [] };
    mine.forEach(function (w) { kinds[wtKind(w)].push(w); });
    var any = false;
    ["community", "review", "project"].forEach(function (k) {
      var panel = $("#wp-" + k), rows = kinds[k];
      panel.hidden = !rows.length; if (!rows.length) return; any = true;
      $("#w-" + k + " thead tr").innerHTML = WT_HEAD[k] + (own ? "<th></th>" : "");
      pager("#w-" + k, rows, function (w) { return workerRow(w, k, own ? (w.revoked_at ? '' : '<button type="button" class="small-btn" data-revoke="' + esc(w.id) + '" title="revoke this worker\'s token">Revoke</button>') : null); }, { empty: "", text: function (w) { return [w.id, w.arch, w.version, w.agent].join(" "); } });
    });
    $("#w-none").hidden = any; $("#wt-legend").innerHTML = any ? WT_LEGEND : "";
  }
  function loadWorkers() { return fetch("/api/v1/factory?limit=10" + (own ? "&t=" + Date.now() : "")).then(function (r) { return r.json(); }).then(function (d) { FACTORY = d; renderWorkers(); }).catch(function () {}); }
  // A package's story (routes/story.ts), in its open row: the request as the form checks it today, then one panel per architecture — each is built on a worker of its own and can be ready while the other failed — with its latest chain, the two halves of the score with their evidence, and the one line that says whose turn it is.
  function story(name) {
    var el = storyEl(name); if (!el) return;
    if (STORIES[name]) el.innerHTML = storyHtml(name, STORIES[name]); // what was drawn stays while the fresh one loads: no flicker on the refresh
    fetch("/api/v1/factory/packages/" + encodeURIComponent(name) + "/story" + (own ? "?t=" + Date.now() : "")).then(function (r) { return r.ok ? r.json() : null; }).then(function (st) {
      if (!st) { if (!STORIES[name]) el.innerHTML = '<div class="muted">no story yet</div>'; return; }
      STORIES[name] = st;
      el.innerHTML = storyHtml(name, st);
    }).catch(function () { if (!STORIES[name]) el.innerHTML = '<div class="muted">could not load the story</div>'; });
  }
  // The open row's story element, by the package's name (pacman names carry @ . _ + -; an id made of them would collide).
  function storyEl(name) { var els = document.querySelectorAll(".pkstory[data-story]"); for (var i = 0; i < els.length; i++) if (els[i].getAttribute("data-story") === name) return els[i]; return null; }
  function storyHtml(name, st) {
      var pkg = st.package || {}, registered = (pkg.arches && pkg.arches.length ? pkg.arches : (st.request && st.request.arches) || []).slice(), arches = registered.slice();
      var archOf = function (c) { return (c.contributor || c.project || {}).arch; };
      st.chains.forEach(function (c) { var a = archOf(c); if (a && arches.indexOf(a) < 0) arches.push(a); }); // an architecture the request dropped keeps its story, without a Build
      var inFlight = function (c) { return c && ((c.contributor && (c.contributor.status === "queued" || c.contributor.status === "leased")) || (c.project && (c.project.status === "queued" || c.project.status === "leased"))); };
      var anyBusy = st.chains.some(inFlight);
      // A renewal is taken while the package is registered, staged, rejected or unmaintained and nothing of it is being built — the story says (request.renewable, request.busy).
      var renewable = !!(st.request && st.request.renewable);
      var whyNot = st.request && st.request.busy ? "renew it once build #" + st.request.busy + " is done" : pkg.status === "approved" || pkg.status === "published" ? "in the pool as it was; new releases come as bumps, built from the approved recipe" : "renew it once nothing of it is being built";
      var head = '<div class="pknext">' + (pkg.blocked_at ? pillHtml("error", "blocked") + ' ' + ago(pkg.blocked_at) + ' by ' + personLink(pkg.blocked_by) + ': ' + esc(pkg.blocked_reason || '') + ' — another maintainer lifts it.' : summary(st, arches))
        + (own ? '<span class="acts-inline">' + (anyBusy ? '<button type="button" disabled title="a build is in flight">Build all</button>' : '<button type="button" data-build="' + esc(name) + '" title="every architecture the request names">Build all</button>') + ' <button type="button" class="ghost" data-remove="' + esc(name) + '" title="remove the registration">Remove</button></span>' : '') + '</div>';
      var panels = arches.map(function (a) {
        var mine = st.chains.filter(function (c) { return archOf(c) === a; });
        var running = mine[0] && ((mine[0].contributor && mine[0].contributor.status === "leased") || (mine[0].project && (mine[0].project.status === "queued" || mine[0].project.status === "leased")));
        var queued = mine[0] && mine[0].contributor && mine[0].contributor.status === "queued";
        var acts = own && !pkg.blocked_at && registered.indexOf(a) >= 0 ? (running ? '<button type="button" class="small-btn" disabled title="a build is running">Build ' + esc(a) + '</button>' : '<button type="button" class="small-btn" data-build="' + esc(name) + '" data-arch="' + esc(a) + '" title="' + (queued ? "name a worker, or take it out of the queue" : "this architecture only") + '">Build ' + esc(a) + '</button>') : '';
        return archPanel(a, mine, nextStep(st, mine[0]), acts);
      }).join("");
      return head + requestBlock(st.request, own, name, renewable, whyNot) + panels
        + '<p class="sub" style="margin:4px 0 0"><a href="/package/' + encodeURIComponent(name) + '?ring=lab">The package\'s page →</a>' + (st.rings && st.rings.length ? ' · in <b>' + esc(st.rings.map(function (r) { return r.ring + " (" + r.arch + ")"; }).join(", ")) + '</b>' : '') + '</p>';
  }
  // The package in one line: what each architecture waits for, and the request when it is not what the form asks today.
  function summary(st, arches) {
    var parts = arches.map(function (a) {
      var c = st.chains.filter(function (x) { return (x.contributor || x.project || {}).arch === a; })[0], s2 = chainState(c);
      return '<b class="mono">' + esc(a) + '</b> ' + pillHtml(s2.cls, s2.text);
    });
    var req = st.request && !st.request.complete ? ' <span class="dim">·</span> ' + pillHtml("warn", "request incomplete", "the form would not take it today — a maintainer's time is not asked yet") + (own && st.request.renewable ? ' <span class="dim">renew it below</span>' : '') : '';
    return parts.join(' <span class="dim">·</span> ') + req;
  }
  // What comes next for one architecture, from its latest chain: whose turn it is, what for — and, when it is the reader's own package, how: the evidence to read, the button to press, where the build can run, what to write for the agent.
  function nextStep(st, c) {
    var pkg = st.package || {}, rings = (st.rings || []).filter(function (r) { return !c || r.arch === (c.contributor || c.project || {}).arch; }).map(function (r) { return r.ring; });
    var incomplete = st.request && !st.request.complete;
    var art = function (t, f, text) { return '<a class="run" href="/api/v1/factory/tasks/' + t.id + '/artifacts/' + f + '">' + text + '</a>'; };
    var steps = function (items) { return '<ol class="howto">' + items.map(function (x) { return '<li>' + x + '</li>'; }).join("") + '</ol>'; };
    var drafted = function (t) { return !t || !t.pkgbuild_ref || t.pkgbuild_ref.indexOf("draft:") === 0; };
    if (!c) return 'No build yet — ' + (own ? 'press <b>Build</b>: it goes to the shared queue (the best idle shared worker takes it; a worker of yours at once), the gate checks it, the second agent audits it.' : 'the contributor\'s build comes first.');
    var cc = c.contributor, pb = c.project, a = c.approval, sc = c.score, arch = (cc || pb).arch;
    var worker = cc && cc.lease_owner && FACTORY ? FACTORY.workers.filter(function (w) { return w.id === cc.lease_owner; })[0] : null;
    var emulated = worker && worker.labels && worker.labels.emulated;
    var where = FACTORY ? whereOptions(FACTORY.workers, arch, login, false) : null;
    // The three tools a contributor has, in the order to try them.
    var again = function (why) {
      if (cc && !drafted(cc)) return steps([
        'Read what stopped it: ' + art(cc, "build.log", "the log") + (cc.status === "failed" ? '' : ', ' + art(cc, "tests.log", "the gate\'s log")) + (why ? ' — ' + why : '') + '.',
        'The recipe is the project\'s own PKGBUILD (<span class="mono">' + esc(String(cc.pkgbuild_ref).split(":").pop()) + '</span>), built as it is — no agent drafts it: fix it there, tag a release, <b>renew the request</b> with that tag, then press <b>Build ' + esc(arch) + '</b>.',
        'Choose <b>where</b> in the Build dialog' + (emulated ? ': this one ran <b>emulated</b> — a native worker may be all it needs' : '') + '.',
      ]);
      return steps([
        'Read what stopped it: ' + art(cc, "build.log", "the log") + (cc.status === "failed" ? '' : ', ' + art(cc, "tests.log", "the gate's log")) + ' and ' + art(cc, "PKGBUILD", "the PKGBUILD") + ' the agent wrote' + (why ? ' — ' + why : '') + '.',
        'Press <b>Build ' + esc(arch) + '</b>: the next build starts from that PKGBUILD and that log (the lesson), not from nothing — and from a <b>hint</b> you write in the dialog: the binary\'s name, a build flag, a dependency, what the recipe should do differently.',
        'Choose <b>where</b> in the same dialog' + (emulated ? ': this one ran <b>emulated</b> (' + esc(arch) + ' under qemu on ' + esc(wtShort(worker.id)) + ') — a native worker may be all it needs' : '') + (where && where.native ? ' — ' + where.native + ' native ' + esc(arch) + ' worker(s) online' : where && where.count ? ' — ' + where.count + ' worker(s) can take it' : ' — the project\'s shared workers take it') + '.',
        'Or build it yourself first: <a href="/docs/workers">run the same image at home</a> with your own agent key; what passes there is what you queue here.',
      ]);
    };
    if (a && a.decision === "approved") return 'Approved by ' + personLink(a.by) + ' ' + ago(a.created_at) + (rings.length ? ' — in <b>' + esc(rings.join(" · ")) + '</b>, signed by the pool; it earns rc and stable like every synced package.' : ' — the publish job carries it into edge.');
    if (c.withdrawn) return 'The approval by ' + personLink(c.withdrawn.by) + ' was withdrawn by ' + personLink(c.withdrawn.withdrawn_by) + ': ' + esc(c.withdrawn.withdrawn_reason || '') + ' — another maintainer decides; ' + (own ? 'nothing to do on your side.' : 'nothing to do on the contributor\'s side.');
    if (a && a.decision === "rejected") return 'Rejected by ' + personLink(a.by) + ': <b>' + esc(a.note || '') + '</b>' + (own && cc ? again('the note above says what to change') : ' — the contributor fixes it and builds again.');
    if (pb && (pb.status === "queued" || pb.status === "leased")) return 'The project is building it again (<a href="/build/' + pb.id + '">#' + pb.id + '</a>) on a trusted worker, with the project\'s agent — then the trial, then a maintainer decides.' + (own ? ' Nothing on your side.' : '');
    if (pb && pb.status === "staged") return 'Built again by the project (<a href="/build/' + pb.id + '">#' + pb.id + '</a>): it waits for ' + (own ? '<b>another</b> maintainer\'s approval (you brought it)' : 'a maintainer\'s approval — never the one who brought it') + '. Class today ' + esc(sc.class) + ', ' + esc(sc.projected) + ' with the maintainer\'s half green.';
    if (pb && pb.status === "failed") return 'The project\'s build failed (<a href="/build/' + pb.id + '">#' + pb.id + '</a>)' + (pb.error ? ' — ' + esc(String(pb.error).slice(0, 140)) : '') + ' — a maintainer reads it and decides; your evidence stands.' + (own ? ' If the recipe is the cause, a new build of yours with the fix is the best help.' : '');
    if (cc && cc.status === "queued") {
      if (cc.pinned_to) return 'Queued (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) for <b>' + esc(wtShort(cc.pinned_to)) + '</b> only' + (FACTORY && !FACTORY.workers.some(function (w) { return w.id === cc.pinned_to && w.alive; }) ? ' — <b>offline</b>: it claims when it is back' : '') + (own ? '. Press <b>Build ' + esc(arch) + '</b> to send it to the queue instead, or to take it out.' : '.');
      var q = cc.queue ? '<b>' + cc.queue.position + ' of ' + cc.queue.total + '</b> in the shared queue for ' + esc(arch) : 'in the shared queue for ' + esc(arch);
      var idleNow = where ? where.idle : 0;
      return 'Queued (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) — ' + q + ': the best idle shared worker takes it' + (where ? (idleNow ? ' — ' + idleNow + ' idle now, ' + where.native + ' native' : where.shared ? ' — all ' + where.shared + ' busy; it waits its turn' : ' — no shared worker for ' + esc(arch) + ' is registered') : '') + (own ? '; a worker of yours takes it at once. Press <b>Build ' + esc(arch) + '</b> to name a worker or to take it out of the queue.' : '.') + (own ? ' This page follows it.' : '');
    }
    if (cc && cc.status === "leased") return 'Building (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) on ' + (cc.lease_owner ? wtId({ id: cc.lease_owner, owner: cc.owner }) : 'a worker') + (emulated ? ' — emulated' : '') + (own ? ' — this page follows it.' : '.');
    if (cc && cc.status === "failed") return 'The build failed (<a href="/build/' + cc.id + '">#' + cc.id + '</a>)' + (cc.error ? ' — <b>' + esc(String(cc.error).slice(0, 160)) + '</b>' : '') + (own ? again(cc.attempts > 1 ? 'the agent tried ' + cc.attempts + ' times inside this build' : '') : ' — the contributor fixes it.');
    if (cc && cc.status === "cancelled") return 'Superseded (<a href="/build/' + cc.id + '">#' + cc.id + '</a>)' + (cc.error ? ' — ' + esc(String(cc.error).slice(0, 140)) : '') + '.';
    if (cc && cc.status === "staged") {
      if (sc.ready) return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate' + (c.audit && c.audit.status === "done" ? ', audited' : '') + ' — ' + (own ? 'nothing on your side: <b>another</b> maintainer (you brought it)' : 'a maintainer who did not bring it') + ' has the project build it again. Class ' + esc(sc.class) + ' → ' + esc(sc.projected) + '.';
      var vet = cc.result && cc.result.vet, audit = c.audit;
      if (incomplete) return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> is staged, but the request is not what the form asks today — ' + (own ? '<b>Renew the request</b> above: the same form, filled from the record; the build stays and is ready the moment the record is — of this version.' : 'the contributor renews the request; the build stays.');
      if (vet && vet.verdict !== "pass") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> built, but <b>the gate failed</b>: ' + esc((vet.failed || []).join(", ")) + (own ? again('each failed check is named there and explained in <a href="/docs/what-we-test">What we test</a>') : ' — the contributor fixes the recipe and builds again.');
      if (audit && audit.status === "done" && audit.result && audit.result.verdict === "block") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate, but <b>the audit blocked it</b>: ' + esc(audit.result.summary || '') + (own ? again('the ' + art(cc, "audit.md", "report") + ' lists the findings and the fix for each') : ' — the contributor answers the findings and builds again.');
      if (audit && audit.status !== "done") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate; the audit is ' + esc(audit.status) + ' on the project\'s review worker — nothing to do until it answers.';
      if (audit && audit.status === "failed") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate, but the audit did not run (' + esc(audit.error || '') + ') — ' + (own ? 'press <b>Build ' + esc(arch) + '</b> again: a new build gets a new audit.' : 'the contributor builds again.');
      var reqItem = (sc.items || []).filter(function (i) { return i.item === "A request on the record"; })[0];
      if (reqItem && reqItem.points < reqItem.max && st.request && st.request.version) return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> is staged, but the request now names <b>' + esc(st.request.version) + '</b> and this build is ' + esc(cc.version || '?') + ' — ' + (own ? 'press <b>Build ' + esc(arch) + '</b>: the build of that version is the evidence.' : 'the contributor builds that version.');
      return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> is staged, but not ready: ' + (!vet ? 'no gate verdict on the record (built before the gate)' : 'the audit has not answered') + ' — ' + (own ? 'press <b>Build ' + esc(arch) + '</b> again; the gate and the audit run on the new build.' : 'the contributor builds again.');
    }
    return esc(cc ? cc.status : "—");
  }
  function load() {
  // Past the edge cache when it is yours: a Build or a Revoke shows at once.
  return busy(fetch("/api/v1/users/" + encodeURIComponent(login) + (own ? "?t=" + Date.now() : ""))).then(function (r) { return r.json().then(function (d) { d.__status = r.status; return d; }); }).then(function (d) {
    if (d.__status !== 200) { $("#title").textContent = login; $("#line").textContent = d.error || "not found"; endSkeleton(); return; }
    document.title = login + " · omarchy-pool";
    $("#title").innerHTML = esc(d.name || d.login) + ' <span class="dim" style="font-weight:500">@' + esc(d.login) + '</span>';
    // An icon, never a photo: two letters, green for a maintainer.
    $("#avatar").textContent = d.login.slice(0, 2); if (d.role === "maintainer") $("#avatar").classList.add("m");
    $("#line").innerHTML = '<span class="pill ' + (d.role === "maintainer" ? "rec" : "ok") + '">' + esc(d.role) + '</span>' +
      (d.blocked ? '<span class="pill error" title="by ' + esc(d.blocked.by || "") + ', ' + esc(d.blocked.at || "") + '">blocked: ' + esc(d.blocked.reason || "") + '</span>' : '') +
      (d.maintainer_since ? '<span class="pill none" title="listed in factory/MAINTAINERS.toml">since ' + esc(ago(d.maintainer_since)) + '</span>' : '') +
      '<span>since ' + esc(String(d.since).slice(0, 10)) + '</span><span class="dim">·</span><span>last seen ' + ago(d.last_seen) + '</span><span class="dim">·</span><a href="' + esc(d.github) + '" style="color:var(--muted);text-decoration:none">github.com/' + esc(d.login) + ' ↗</a>';
    var c = d.build_counts;
    var tiles = [
      ["Packages", num(d.packages.length), "registered under this name"],
      ["Builds", num(c.total), num(c.staged) + " staged · " + num(c.published) + " published · " + num(c.failed) + " failed"],
      ["Approvals", num(d.approvals.length), d.role === "maintainer" ? num(d.approved_packages.length) + " package(s) let into the pool" : "not a maintainer"],
      ["Workers", num(d.workers.filter(function (w) { return !w.revoked_at; }).length), num(d.workers.filter(function (w) { return w.alive; }).length) + " alive now"]
    ];
    $("#tiles").innerHTML = tiles.map(function (t) { return '<div class="tile"><div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div></div>'; }).join("");
    // Sixteen weeks of what the record holds under this name: builds, decisions, packages touched.
    var weeks = []; for (var i = 15; i >= 0; i--) weeks.push(Date.now() - i * 7 * 86400000);
    var counts = weeks.map(function () { return 0; }), total = 0;
    var mark = function (iso) { var t = Date.parse(iso); if (!t) return; for (var i = weeks.length - 1; i >= 0; i--) { if (t >= weeks[i]) { counts[i]++; total++; break; } } };
    d.builds.forEach(function (b) { mark(b.created_at); }); d.approvals.forEach(function (a) { mark(a.created_at); }); d.packages.forEach(function (p) { mark(p.updated_at); });
    var mx = Math.max.apply(null, counts) || 1;
    $("#activity").innerHTML = counts.map(function (v, i) { return '<i style="height:' + Math.max(4, 100 * v / mx) + '%" data-tip="' + new Date(weeks[i]).toISOString().slice(0, 10) + ' · ' + v + (v === 1 ? " contribution" : " contributions") + '"></i>'; }).join("");
    $("#activity-note").textContent = total ? num(total) + " in the last 16 weeks — every one is a row below" : "nothing on the record in the last 16 weeks yet";
    var rec = d.record || { contributed: {}, maintained: {}, score: 0 }, has = Object.keys(rec.contributed).some(function (k) { return rec.contributed[k]; }) || Object.keys(rec.maintained).some(function (k) { return rec.maintained[k]; });
    $("#score").textContent = num(rec.score || 0);
    $("#score-f").innerHTML = "from what the pool recorded: what you brought that a maintainer let in, what you built, what you decided — it says where the work was done, not who someone is";
    if (has) {
      $("#record-section").hidden = false;
      pager("#record", [rec], function (r) {
        var c = r.contributed, m = r.maintained;
        var contributed = [c.approved ? num(c.approved) + " let in" : "", c.staged ? num(c.staged) + " staged" : "", c.bumps ? num(c.bumps) + " bump" + (c.bumps === 1 ? "" : "s") : "", c.donated ? num(c.donated) + " for others" : "", c.rejected ? num(c.rejected) + " rejected" : ""].filter(Boolean).join(" · ") || "—";
        var maintained = [m.approvals ? num(m.approvals) + " approval" + (m.approvals === 1 ? "" : "s") : "", m.rejections ? num(m.rejections) + " rejection" + (m.rejections === 1 ? "" : "s") : "", m.rebuilds_failed ? num(m.rebuilds_failed) + " rebuild" + (m.rebuilds_failed === 1 ? "" : "s") + " failed" : ""].filter(Boolean).join(" · ") || "—";
        return '<tr><td>' + contributed + '</td><td>' + maintained + '</td><td class="num">' + num(r.score) + '</td></tr>';
      });
    }
    // ---- packages: one row each, the stage from the latest builds per architecture, a row that opens into the story and the next step
    var byPkg = {}; d.builds.forEach(function (b) { var k = b.name + "/" + b.arch; if (!byPkg[k]) byPkg[k] = b; });
    LATEST = byPkg;
    pager("#packages", d.packages, function (p) {
      var arches = []; try { arches = JSON.parse(p.arches || "[]"); } catch (e) {}
      var per = arches.map(function (a) { var b = byPkg[p.name + "/" + a]; return '<span class="arch-st" title="' + esc(a + ": " + (b ? b.status + (b.status === "leased" ? " (building)" : "") + " · #" + b.id : "no build yet")) + '">' + esc(a) + ' ' + (b ? pill(b.status) : '<span class="pill none">—</span>') + '</span>'; }).join("");
      var open = OPEN[p.name];
      return '<tr class="pkrow" data-pkg="' + esc(p.name) + '"><td><button type="button" class="expand" data-expand="' + esc(p.name) + '" title="' + (open ? "close" : "the story, and what comes next") + '">' + (open ? "▾" : "▸") + '</button></td><td><a href="/package/' + encodeURIComponent(p.name) + '?ring=lab"><b>' + esc(p.name) + '</b></a></td><td>' + (p.category ? '<span class="pill none">' + esc(p.category) + '</span>' : '<span class="dim">—</span>') + '</td><td>' + (p.url ? '<a href="' + esc(p.url) + '">' + esc(p.url.replace(/^https?:\/\/(www\.)?(github\.com\/)?/, "")) + '</a>' : '<span class="dim">—</span>') + '</td><td class="arches">' + per + '</td><td>' + pill(p.status) + '</td><td class="muted stands" title="' + esc(p.detail || "") + '">' + esc(p.detail || "") + '</td></tr>'
        + (open ? '<tr class="pkopen" data-pkg="' + esc(p.name) + '"><td colspan="7"><div class="pkstory" data-story="' + esc(p.name) + '">' + (STORIES[p.name] ? storyHtml(p.name, STORIES[p.name]) : '<div class="muted">loading the story…</div>') + '</div></td></tr>' : '');
    }, { empty: "no package registered", after: function () { Object.keys(OPEN).forEach(function (n) { if (OPEN[n]) story(n); }); }, text: function (p) { return [p.name, p.category, p.status, p.detail].join(" "); } });
    // ---- builds: the number is the build's page; the worker that held it
    pager("#builds", d.builds, function (t) {
      return '<tr><td><a href="/build/' + t.id + '" title="the build, whole">' + t.id + '</a></td><td><a href="/package/' + encodeURIComponent(t.name) + '?ring=lab&arch=' + esc(t.arch) + '"><b>' + esc(t.name) + '</b></a>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '') + '</td><td>' + esc(t.arch) + '</td><td>' + pill(t.status) + (t.queue ? ' <span class="dim" title="in the shared queue for ' + esc(t.arch) + '">' + t.queue.position + ' of ' + t.queue.total + '</span>' : '') + '</td><td>' + esc(t.reason || "") + (t.trust === "project" ? ' <span class="pill ok" title="the project\'s own build, from a contributor\'s evidence">the project</span>' : '') + '</td><td>' + (t.lease_owner ? wtId({ id: t.lease_owner, owner: t.lease_owner.indexOf(login + "-") === 0 ? login : (t.lease_owner.split("-")[0] || null) }) : t.pinned_to && t.status === "queued" ? '<span class="muted" title="asked for this worker only">waiting for ' + esc(wtShort(t.pinned_to)) + '</span>' : '<span class="muted">—</span>') + '</td><td>' + took(t.duration_ms) + '</td><td class="when">' + ago(t.created_at) + '</td>' + (own ? '<td>' + evidence(t) + '</td>' : '') + '</tr>';
    }, { empty: "nothing built yet", text: function (t) { return [t.id, t.name, t.version, t.arch, t.status, t.reason, t.lease_owner].join(" "); } });
    // ---- approvals: last, with the build behind each
    if (d.approvals.length || d.role === "maintainer") {
      $("#approvals-section").hidden = false;
      pager("#approvals", d.approvals, function (a) {
        return '<tr><td class="when">' + ago(a.created_at) + '</td><td><a href="/package/' + encodeURIComponent(a.name) + '?ring=lab&arch=' + esc(a.arch) + '">' + esc(a.name) + '</a> <span class="mono muted">' + esc(a.version || "") + '</span> <a class="dim" href="/build/' + a.task_id + '">#' + a.task_id + '</a></td><td>' + esc(a.arch) + '</td><td>' + (a.withdrawn_at ? '<span class="pill none" title="' + esc("withdrawn " + ago(a.withdrawn_at) + " by " + a.withdrawn_by + ": " + (a.withdrawn_reason || "")) + '">withdrawn</span>' : pill(a.decision)) + '</td><td class="muted">' + esc(a.withdrawn_at ? (a.withdrawn_reason || "") : (a.note || "")) + '</td></tr>';
      }, { empty: "no decision yet" });
    }
    renderWorkers();
    endSkeleton();
  }).catch(function (e) { $("#line").textContent = "could not load: " + e; endSkeleton(); });
  }
  loadWorkers();
  load().then(function () {
    // Your own page: the workspace — the buttons on the tables, a worker to register, the quota, a token for scripts, the place to sign out.
    whoami(function (me) {
      if (!me || me.login !== login) return;
      own = true;
      var url = location.origin + "/user/" + encodeURIComponent(login);
      // Two buttons at the top: the link to this page (it is public, everything on it is on the record anyway) and a token for scripts and CI.
      $("#share-btn").innerHTML = '<button type="button" class="btn" id="share-open" title="Share your profile">Share</button> <button type="button" class="btn ghost" id="token-open" title="Generate a token">Token</button>';
      $("#share-open").onclick = function () { ask({ title: "Share your profile", text: "This page is public — what it shows is what the pool recorded: packages, builds, decisions. Post the link wherever you like: your GitHub profile, LinkedIn, a blog.", value: url, copy: "Copy the link", confirm: null, cancel: "Close" }); };
      $("#token-open").onclick = function () {
        ask({ title: "A token for scripts and CI", text: "Sent as <code>Authorization: Bearer omc_…</code>. Shown once; it replaces the previous one — your workers keep theirs.", confirm: "Generate a token" }).then(function (go) {
          if (go === null) return;
          call("POST", "/token", {}).then(function (d) {
            if (d.error) { toast(esc(d.error), "error"); return; }
            ask({ title: "Your token", text: "Copy it now: the pool keeps only its hash. " + esc(d.note || ""), value: "export OMARCHY_CONTRIBUTOR_TOKEN=" + d.token, copy: "Copy", confirm: null, cancel: "Close" });
          }).catch(function (e) { toast("failed: " + esc(String(e)), "error"); });
        });
      };
      $("#pk-request").hidden = false; $("#w-toggle").hidden = false; $("#w-own").hidden = false;
      $("#builds thead tr").insertAdjacentHTML("beforeend", "<th>Evidence</th>");
      load(); loadWorkers(); quota();
      // Your own page follows the work: a build you queued shows as queued, then building, then staged — no reload.
      setInterval(function () { load(); loadWorkers(); }, 15000);
    });
  });
  function quota() {
    call("GET", "/me").then(function (d) { var st = d.staging; if (!st) return; $("#quota").textContent = "staging " + (st.bytes / 1048576).toFixed(1) + " MB of " + (st.quota_bytes / 1073741824).toFixed(0) + " GB · evidence expires after 30 days"; }).catch(function () {});
  }
  // Buttons inside paged tables: one delegated handler survives re-renders.
  document.addEventListener("click", function (ev) {
    var x = ev.target.closest ? ev.target.closest("button[data-expand]") : null;
    if (x) { var n = x.getAttribute("data-expand"); OPEN[n] = !OPEN[n]; load(); return; }
    var b = ev.target.closest ? ev.target.closest("button[data-build],button[data-remove],button[data-revoke]") : null; if (!b) return;
    if (b.hasAttribute("data-build")) {
      var name = b.getAttribute("data-build"), arch = b.getAttribute("data-arch");
      // Where it runs is the asker's call (one architecture: any of their workers or the project's shared ones; all: the rule, or the shared ones at once); a hint goes to the agent that drafts the recipe.
      var st2 = STORIES[name], det = {}; try { det = JSON.parse((st2 && st2.package && st2.package.detected) || "{}"); } catch (e) {}
      var drafts = !det.has_pkgbuild; // the project's own PKGBUILD is built as it is: no agent, no hint
      var waiting = st2 ? st2.chains.filter(function (c) { return c.contributor && c.contributor.status === "queued" && (!arch || c.contributor.arch === arch); }).map(function (c) { return c.contributor; }) : [];
      var where = FACTORY ? whereOptions(FACTORY.workers, arch || "x86_64", login, false, drafts, waiting.length === 1 ? waiting[0].queue : null) : null;
      if (where && !arch) where.options = where.options.filter(function (o) { return o.value === ""; });
      var queuedNow = waiting.length > 0;
      ask({ title: (queuedNow ? "In the queue: " : "Build ") + name + (arch ? " for " + arch : "") + (queuedNow ? "" : "?"), text: (queuedNow ? "Build <b>#" + waiting.map(function (t) { return t.id; }).join(", #") + "</b> waits in the shared queue. Leave it there, name a worker of yours to take it at once, or take it out — nothing puts it back by itself; this button does. " : "") + (drafts ? "The worker drafts the recipe with its agent — from the last build's PKGBUILD and what stopped it, when there is one — builds it, runs the gate and stages the result as evidence; the second agent audits it. " : "The worker builds the project's own PKGBUILD as it is, runs the gate and stages the result as evidence; the second agent audits it. ") + (arch ? "This architecture only." : "Every architecture the request names."), select: where, input: drafts ? "optional" : false, placeholder: "a hint for the agent (optional): the binary's name, a build flag, a dependency, what to do differently", confirm: queuedNow ? "Keep it queued" : "Build", alt: queuedNow ? { text: "Take it out of the queue", danger: true } : null }).then(function (go) {
        if (go === null) return; b.disabled = true;
        if (go && typeof go === "object" && go.alt) {
          // Out of the queue: each waiting build of the architecture(s) asked, one call each.
          Promise.all(waiting.map(function (t) { return call("DELETE", "/packages/" + encodeURIComponent(name) + "/builds/" + t.id); })).then(function (rs) {
            var bad = rs.filter(function (r) { return r.error; });
            if (bad.length) toast(esc(bad[0].error), "error"); else toast("Out of the queue: build #" + waiting.map(function (t) { return t.id; }).join(", #") + ". Press Build to queue it again, on the queue or on a worker of yours.", "warn");
            OPEN[name] = true; load();
          });
          return;
        }
        var body = arch ? { arches: [arch] } : {};
        if (go && typeof go === "object") { if (go.pick) body.worker = go.pick; if (go.note) body.hint = go.note; } else if (go) body.hint = go;
        call("POST", "/packages/" + encodeURIComponent(name) + "/build", body).then(function (r) { if (r.error) toast(esc(r.error), "error"); else if (!(r.tasks || []).length) toast(esc(r.note || "nothing queued"), "warn"); else toast((queuedNow ? "Still queued: " : "Queued ") + (r.tasks || []).length + " build(s): " + esc((r.arches || []).join(", ")) + (r.pinned_to ? " — for " + esc(wtShort(r.pinned_to)) : r.queue && Object.keys(r.queue).length ? " — " + Object.keys(r.queue).map(function (a) { return a + " " + r.queue[a].position + " of " + r.queue[a].total; }).join(", ") : "") + (r.lessons && Object.keys(r.lessons).length ? " — from the last build's PKGBUILD and log" : "") + " — this page follows them."); OPEN[name] = true; load(); });
      });
    }
    else if (b.hasAttribute("data-remove")) {
      var rm = b.getAttribute("data-remove");
      ask({ title: "Remove the registration of " + rm + "?", text: "Its builds stop; the evidence on the record stays. Anyone can register the name again.", confirm: "Remove", danger: true }).then(function (go) {
        if (go === null) return;
        call("DELETE", "/packages/" + encodeURIComponent(rm)).then(function (r) { if (r.error) toast(esc(r.error), "error"); else toast("Removed " + esc(rm) + "."); delete OPEN[rm]; load(); });
      });
    }
    else if (b.hasAttribute("data-revoke")) {
      var wid = b.getAttribute("data-revoke");
      ask({ title: "Revoke " + wid + "?", text: "Its token stops working at once; a build it holds finishes on its own. Register a new one for a new token.", confirm: "Revoke", danger: true }).then(function (go) {
        if (go === null) return;
        call("DELETE", "/workers/" + encodeURIComponent(wid)).then(function (r) { if (r.error) toast(esc(r.error), "error"); else toast("Revoked."); load(); loadWorkers(); });
      });
    }
  });
  $("#w-toggle").onclick = function () { $("#worker-form").hidden = !$("#worker-form").hidden; };
  $("#worker-form").onsubmit = function () {
    var body = { name: $("#w-name").value.trim(), arch: $("#w-arch").value };
    $("#w-btn").disabled = true;
    call("POST", "/workers", body).then(function (d) {
      $("#w-btn").disabled = false;
      if (d.error) { toast(esc(d.error), "error"); return; }
      $("#w-new").hidden = false;
      $("#w-cmd").textContent =
        "# two containers: the broker holds the token (and your agent's key, and a GITHUB_TOKEN — a fine-grained one with no permissions),\n" +
        "# the builder beside it is born with nothing, builds one task and exits; the restart brings the next. With compose\n" +
        "# (" + REPO + "/blob/main/factory/image/compose.yml; docker works the same):\n" +
        "OMARCHY_WORKER_TOKEN=" + d.token + " GITHUB_TOKEN=<github_pat_…, no permissions> podman compose -f compose.yml up -d\n\n" +
        "# or by hand\n" +
        "podman network create omarchy-worker\n" +
        "podman run -d --name omarchy-broker --restart unless-stopped --network omarchy-worker \\\n  -e OMARCHY_WORKER_ROLE=broker -e OMARCHY_WORKER_TOKEN=" + d.token + " -e GITHUB_TOKEN=<github_pat_…, no permissions> \\\n  ghcr.io/firemanxbr/omarchy-worker:latest\n" +
        "podman run -d --name omarchy-worker --restart unless-stopped --stop-timeout 10800 --network omarchy-worker \\\n  -e OMARCHY_BROKER=http://omarchy-broker:8790 \\\n  ghcr.io/firemanxbr/omarchy-worker:latest\n\n" +
        "# on the broker: -e ANTHROPIC_API_KEY=… (or OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: your key) — the agent that writes the PKGBUILD; without one that answers, the worker is not ready";
      $("#worker-form").reset(); $("#worker-form").hidden = true; load(); loadWorkers();
    }).catch(function (e) { $("#w-btn").disabled = false; toast("failed: " + esc(String(e)), "error"); });
    return false;
  };
  liveStats(function () {}, 120000);
`;

export function userHtml(login: string, poolUrl: string, version: RunningVersion): string {
  return page({
    title: `${login} · omarchy-pool`,
    description: `What ${login} contributes to and maintains in the pool.`,
    active: "factory",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
