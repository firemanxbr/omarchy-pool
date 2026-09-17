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
  <section id="share" hidden>
    <div class="h2row"><h2>Share it</h2><span class="hint">this page is public — everything on it is on the record anyway</span></div>
    <div class="share"><p><b style="color:var(--text)">You are part of open source.</b> Copy the link and post it wherever you like — your GitHub profile, LinkedIn, a blog. What it shows is what the pool recorded: packages, builds, decisions.</p><pre><span class="copy" id="copy-link">copy</span><span id="share-url"></span></pre><div class="row"><a class="btn ghost" href="/request">Request a package</a><a class="btn ghost" href="/auth/logout">Sign out</a></div>
      <p class="sub" style="margin:12px 0 0;font-size:12.5px">Scripts and CI use a contributor token (<code>Authorization: Bearer omc_…</code>): <button type="button" class="small-btn" id="cli-token">Generate a token</button> <span class="dim">shown once; replaces the previous one, your workers keep theirs</span></p>
      <pre id="cli-token-out" hidden></pre></div>
  </section>

  <section id="record-section" hidden>
    <h2>Track record</h2>
    <p class="sub">From the record the pool keeps anyway — what this person brought that a maintainer let in, what they built, what they decided. One number, with a formula anyone can check (<a href="/docs/governance">Governance</a>): it says where the work was done, not who someone is.</p>
    <div class="table-wrap"><table id="record"><thead><tr><th>Contributed</th><th>Maintained</th><th>Score</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Packages</h2><a class="more-link" id="pk-request" href="/request" hidden>+ request one →</a></div>
    <p class="sub">Registered by this contributor: the name is theirs, their worker builds it as evidence, the project builds it again, <b>another</b> maintainer decides — a maintainer who brings a package is its contributor. Open a row for the story and the next step.</p>
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
      <p class="sub" style="margin:0 0 10px;font-size:12.5px">Optional — the shared workers build for you otherwise. Register one and run the signed image with the token it gives you, shown once: your packages only, your agent. <a href="/docs/workers">Run a worker →</a></p>
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
  // A package's story (routes/story.ts), in its open row: the chains, the class, and the one line that says what comes next — for whoever is looking.
  function story(name) {
    var el = $("#story-" + name.replace(/[^a-z0-9]/gi, "-")); if (!el) return;
    fetch("/api/v1/factory/packages/" + encodeURIComponent(name) + "/story" + (own ? "?t=" + Date.now() : "")).then(function (r) { return r.ok ? r.json() : null; }).then(function (st) {
      if (!st) { el.innerHTML = '<div class="muted">no story yet</div>'; return; }
      STORIES[name] = st;
      var chains = st.chains.slice(0, 4), latest = chains[0];
      var next = nextStep(st, latest);
      var busyNow = latest && ((latest.contributor && (latest.contributor.status === "queued" || latest.contributor.status === "leased")) || (latest.project && (latest.project.status === "queued" || latest.project.status === "leased")));
      el.innerHTML = '<div class="pknext">' + next + (own ? '<span class="acts-inline">' + (busyNow ? '<button type="button" disabled title="a build is in flight">Build</button>' : '<button type="button" data-build="' + esc(name) + '">Build</button>') + ' <button type="button" class="ghost" data-remove="' + esc(name) + '" title="remove the registration">Remove</button></span>' : '') + '</div>' + (chains.length ? chains.map(function (c) { return chainRow(c); }).join("") : '<p class="sub" style="margin:0">Requested; no build yet.</p>') + '<p class="sub" style="margin:10px 0 0"><a href="/package/' + encodeURIComponent(name) + '?ring=lab">The package\'s page →</a>' + (latest && latest.contributor ? ' · <a href="/build/' + latest.contributor.id + '">the latest build, whole →</a>' : '') + '</p>';
    }).catch(function () { el.innerHTML = '<div class="muted">could not load the story</div>'; });
  }
  // What comes next, in one line, from the latest chain: whose turn it is and what for.
  function nextStep(st, c) {
    var pkg = st.package || {}, rings = (st.rings || []).map(function (r) { return r.ring; });
    if (pkg.blocked_at) return pillHtml("error", "blocked") + ' ' + ago(pkg.blocked_at) + ' by ' + personLink(pkg.blocked_by) + ': ' + esc(pkg.blocked_reason || '') + ' — another maintainer lifts it.';
    if (!c) return pillHtml("none", "requested") + ' No build yet — ' + (own ? 'press <b>Build</b>: your worker (or a shared one) builds it as evidence.' : 'the contributor\'s worker builds it first.');
    var cc = c.contributor, pb = c.project, a = c.approval, sc = c.score;
    if (a && a.decision === "approved") return pillHtml("ok", "approved") + ' by ' + personLink(a.by) + ' ' + ago(a.created_at) + (rings.length ? ' — in <b>' + esc(rings.join(" · ")) + '</b>, signed by the pool; it earns rc and stable like every synced package.' : ' — the publish job carries it into edge.') + ' Class ' + esc(sc.class) + '.';
    if (c.withdrawn) return pillHtml("warn", "approval withdrawn") + ' by ' + personLink(c.withdrawn.withdrawn_by) + ': ' + esc(c.withdrawn.withdrawn_reason || '') + ' — another maintainer decides; ' + (own ? 'nothing to do on your side.' : 'nothing to do on the contributor\'s side.');
    if (a && a.decision === "rejected") return pillHtml("error", "rejected") + ' by ' + personLink(a.by) + ': ' + esc(a.note || '') + ' — ' + (own ? 'fix the recipe and press <b>Build</b> again.' : 'the contributor fixes it and builds again.');
    if (pb && (pb.status === "queued" || pb.status === "leased")) return pillHtml("blue", "the project is building it") + ' <a href="/build/' + pb.id + '">#' + pb.id + '</a> on a trusted worker, with the project\'s agent — then the trial, then a maintainer decides.';
    if (pb && pb.status === "staged") return pillHtml("ok", "built again by the project") + ' <a href="/build/' + pb.id + '">#' + pb.id + '</a> waits for ' + (own ? '<b>another</b> maintainer\'s approval (you brought it)' : 'a maintainer\'s approval — never the one who brought it') + '. Class today ' + esc(sc.class) + ', ' + esc(sc.projected) + ' with the maintainer\'s half green.';
    if (pb && pb.status === "failed") return pillHtml("error", "the project\'s build failed") + ' <a href="/build/' + pb.id + '">#' + pb.id + '</a>' + (pb.error ? ' — ' + esc(String(pb.error).slice(0, 140)) : '') + ' — a maintainer reads it and decides.';
    if (cc && (cc.status === "queued" || cc.status === "leased")) return pillHtml("blue", cc.status === "leased" ? "building" : "queued") + ' <a href="/build/' + cc.id + '">#' + cc.id + '</a>' + (own ? ' on your worker (or a shared one) — this page follows it.' : ' on the contributor\'s worker.');
    if (cc && cc.status === "failed") return pillHtml("error", "the build failed") + ' <a href="/build/' + cc.id + '">#' + cc.id + '</a>' + (cc.error ? ' — ' + esc(String(cc.error).slice(0, 140)) : '') + ' — ' + (own ? 'read the log, fix the recipe, press <b>Build</b> again.' : 'the contributor fixes it.');
    if (cc && cc.status === "cancelled") return pillHtml("none", "superseded") + ' <a href="/build/' + cc.id + '">#' + cc.id + '</a>' + (cc.error ? ' — ' + esc(String(cc.error).slice(0, 140)) : '') + '.';
    if (cc && cc.status === "staged") return (sc.ready ? pillHtml("ok", "ready for a maintainer") + ' <a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate' + (c.audit && c.audit.status === "done" ? ', audited' : '') + ' — ' + (own ? '<b>another</b> maintainer (you brought it)' : 'a maintainer who did not bring it') + ' has the project build it again. Class ' + esc(sc.class) + ' → ' + esc(sc.projected) + '.' : pillHtml("warn", "not ready yet") + ' <a href="/build/' + cc.id + '">#' + cc.id + '</a> is staged; ' + (c.audit && c.audit.status !== "done" ? 'the audit is ' + esc(c.audit.status) : 'the gate did not pass') + ' — nothing for a maintainer yet.');
    return pillHtml("none", cc ? cc.status : "—");
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
      var per = arches.map(function (a) { var b = byPkg[p.name + "/" + a]; return '<span class="arch-st" title="' + esc(a + ": " + (b ? b.status + (b.status === "leased" ? " (building)" : "") + " · #" + b.id : "no build yet")) + '">' + esc(a) + ' ' + (b ? pill(b.status) : '<span class="pill none">—</span>') + '</span>'; }).join(" ");
      var open = OPEN[p.name];
      return '<tr class="pkrow" data-pkg="' + esc(p.name) + '"><td><button type="button" class="expand" data-expand="' + esc(p.name) + '" title="' + (open ? "close" : "the story, and what comes next") + '">' + (open ? "▾" : "▸") + '</button></td><td><a href="/package/' + encodeURIComponent(p.name) + '?ring=lab"><b>' + esc(p.name) + '</b></a></td><td>' + (p.category ? '<span class="pill none">' + esc(p.category) + '</span>' : '<span class="dim">—</span>') + '</td><td>' + (p.url ? '<a href="' + esc(p.url) + '">' + esc(p.url.replace(/^https?:\/\/(www\.)?(github\.com\/)?/, "")) + '</a>' : '<span class="dim">—</span>') + '</td><td>' + per + '</td><td>' + pill(p.status) + '</td><td class="muted">' + esc(p.detail || "") + '</td></tr>'
        + (open ? '<tr class="pkopen" data-pkg="' + esc(p.name) + '"><td colspan="7"><div class="pkstory" id="story-' + esc(p.name.replace(/[^a-z0-9]/gi, "-")) + '"><div class="muted">loading the story…</div></div></td></tr>' : '');
    }, { empty: "no package registered", after: function () { Object.keys(OPEN).forEach(function (n) { if (OPEN[n]) story(n); }); }, text: function (p) { return [p.name, p.category, p.status, p.detail].join(" "); } });
    // ---- builds: the number is the build's page; the worker that held it
    pager("#builds", d.builds, function (t) {
      return '<tr><td><a href="/build/' + t.id + '" title="the build, whole">' + t.id + '</a></td><td><a href="/package/' + encodeURIComponent(t.name) + '?ring=lab&arch=' + esc(t.arch) + '"><b>' + esc(t.name) + '</b></a>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '') + '</td><td>' + esc(t.arch) + '</td><td>' + pill(t.status) + '</td><td>' + esc(t.reason || "") + (t.trust === "project" ? ' <span class="pill ok" title="the project\'s own build, from a contributor\'s evidence">the project</span>' : '') + '</td><td>' + (t.lease_owner ? wtId({ id: t.lease_owner, owner: t.lease_owner.indexOf(login + "-") === 0 ? login : (t.lease_owner.split("-")[0] || null) }) : '<span class="muted">—</span>') + '</td><td>' + took(t.duration_ms) + '</td><td class="when">' + ago(t.created_at) + '</td>' + (own ? '<td>' + evidence(t) + '</td>' : '') + '</tr>';
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
      $("#share").hidden = false; $("#share-url").textContent = url; $("#share-btn").innerHTML = '<a class="btn" href="#share">Share your profile</a>';
      $("#copy-link").onclick = function () { navigator.clipboard.writeText(url).then(function () { $("#copy-link").textContent = "copied"; setTimeout(function () { $("#copy-link").textContent = "copy"; }, 1500); }); };
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
      var name = b.getAttribute("data-build");
      ask({ title: "Build " + name + "?", text: "Your worker — or a shared one — builds it from the recipe, runs the gate and stages the result as evidence; the second agent audits it. Every architecture the registration names.", confirm: "Build" }).then(function (go) {
        if (go === null) return; b.disabled = true;
        call("POST", "/packages/" + encodeURIComponent(name) + "/build", {}).then(function (r) { if (r.error) toast(esc(r.error), "error"); else toast("Queued " + (r.tasks || []).length + " build(s): " + esc((r.arches || []).join(", ")) + " — this page follows them."); OPEN[name] = true; load(); });
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
  $("#cli-token").onclick = function () {
    $("#cli-token").disabled = true;
    call("POST", "/token", {}).then(function (d) { $("#cli-token").disabled = false; if (d.error) { toast(esc(d.error), "error"); return; } $("#cli-token-out").hidden = false; $("#cli-token-out").textContent = "export OMARCHY_CONTRIBUTOR_TOKEN=" + d.token + "\n# " + d.note; })
      .catch(function (e) { $("#cli-token").disabled = false; toast("failed: " + esc(String(e)), "error"); });
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
