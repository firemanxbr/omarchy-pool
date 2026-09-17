/**
 * A build, whole, on one page — /build/<task>: the package and its state,
 * what happened to it and when (the timeline), the machine that built it
 * and what the build cost (resources.json), and every piece of evidence
 * read in place: the gate's checks, the audit's findings, the trial's
 * transcript, the recipe, the log, the manifest — with the raw file one
 * click away and the same thing as JSON for a tool
 * (GET /api/v1/factory/tasks/<id>). A maintainer decides here as on
 * Review. A pool job (sync, health, …) gets the same page, shorter.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <p class="crumbs"><a href="/review">Review</a> / <span id="crumb">build</span></p>
  <div class="h2row" style="align-items:center;gap:12px;flex-wrap:wrap"><h1 id="title" style="max-width:none">…</h1><div id="badges" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"></div></div>
  <p class="lede" id="lede"></p>
  <div class="tiles five" id="tiles"></div>
  <div id="acts" class="acts" hidden></div>
  <p class="sub" id="state" hidden></p>

  <div class="two" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:16px">
    <section style="margin:0">
      <div class="h2row"><h2>What happened</h2><span class="hint">every step, on the record</span></div>
      <ol class="tl" id="timeline"><li class="skel"><span class="skl"></span></li></ol>
    </section>
    <section style="margin:0">
      <div class="h2row"><h2>The build</h2><span class="hint">the machine, what it cost</span></div>
      <div class="panel"><dl class="kv" id="build-kv"></dl></div>
      <div class="panel" style="margin-top:12px" id="res-panel" hidden><h3>Resources <span class="dim" style="font-size:12px;font-weight:400">what this build took, measured by the worker in its own container</span></h3><div class="mini four" id="res"></div></div>
    </section>
  </div>

  <section id="evidence-section">
    <div class="h2row"><h2>Evidence</h2><span class="hint" id="ev-note">read here; the raw file is a click away</span></div>
    <div id="evidence"></div>
  </section>

  <p class="sub" style="margin-top:28px">This page as JSON, for a tool or an agent: <a class="mono" id="json-link" href="#">/api/v1/factory/tasks/…</a></p>
`;

const SCRIPT = String.raw`
  var API = "/api/v1/factory", ID = Number(location.pathname.split("/").pop()), T = null, WHO = null, token = null, login = null, signedIn = false;
  try { token = localStorage.getItem("omc_token"); login = localStorage.getItem("omc_login"); } catch (e) {}
  function headers() { var h = { "content-type": "application/json" }; if (token && !signedIn) h["authorization"] = "Bearer " + token; return h; }
  function maint() { return !!(WHO && WHO.role === "maintainer"); }
  function person(l) { return l ? '<a href="/user/' + encodeURIComponent(l) + '">' + esc(l) + '</a>' : '<span class="muted">—</span>'; }
  function when(iso) { return iso ? '<span class="when" title="' + esc(iso) + '">' + ago(iso) + '</span>' : ''; }
  function secs(ms) { if (ms == null) return "—"; var s = Math.round(ms / 1000); return s < 90 ? s + " s" : s < 5400 ? Math.round(s / 60) + " min" : (s / 3600).toFixed(1) + " h"; }
  function pill(cls, text, title) { return '<span class="pill ' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>'; }
  function statusPill(st) { return pill({ queued: "none", leased: "blue", staged: "warn", done: "ok", failed: "error", cancelled: "none" }[st] || "none", st === "leased" ? "building" : st); }
  $("#json-link").href = API + "/tasks/" + ID; $("#json-link").textContent = API + "/tasks/" + ID;
  skeletonTiles("#tiles", 5);

  whoami(function (me) {
    if (me) { WHO = me; login = me.login; signedIn = true; }
    else if (token) fetch(API + "/me", { headers: headers() }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d && d.contributor) { WHO = d.contributor; login = WHO.login; } if (T) render(); }).catch(function () {});
    if (T) render();
  });

  function load() {
    busy(fetch(API + "/tasks/" + ID)).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { $("#title").textContent = "No such task"; $("#lede").textContent = d.error; endSkeleton(); return; }
      T = d; render(); loadEvidence();
    }).catch(function () { endSkeleton(); });
  }

  // ---- the head: what it is, in a line and five tiles
  function render() {
    var t = T.task, isBuild = t.kind === "build", project = isBuild && t.trust === "project", p = t.params || {};
    document.title = (isBuild ? t.name + " " + (t.version || "") + " · build #" + t.id : t.kind + " #" + t.id) + " · omarchy-pool";
    $("#crumb").textContent = (isBuild ? t.name + " " : t.kind + " ") + "#" + t.id;
    $("#title").innerHTML = isBuild ? esc(t.name) + ' <span class="mono muted" style="font-size:.7em">' + esc(t.version || "") + '</span>' : esc(t.kind) + ' <span class="mono muted" style="font-size:.7em">#' + t.id + '</span>';
    $("#badges").innerHTML = pill("none", t.arch) + statusPill(t.status) + (isBuild ? pill(project ? "ok" : "lilac", project ? "the project" : "evidence", project ? "built by the project on a trusted worker, from a contributor's evidence" : "a contributor's build: evidence for a maintainer, never what users get") : "") + (t.publish === 0 && !isBuild ? "" : "");
    var built = T.worker ? (T.worker.owner ? T.worker.owner + "'s worker " : "worker ") + T.worker.id : (t.lease_owner || (t.finished_at ? "a worker the record no longer names" : "no worker yet"));
    $("#lede").innerHTML = (isBuild
      ? (project ? 'The project built <b>' + esc(t.name) + '</b> ' + esc(t.version || '') + ' for ' + esc(t.arch) + (T.from ? ' from the evidence in <a href="/build/' + T.from.id + '">#' + T.from.id + '</a> (' + person(T.from.owner) + '\'s build)' : '') : person(t.owner) + ' built <b>' + esc(t.name) + '</b> ' + esc(t.version || '') + ' for ' + esc(t.arch) + ' on ' + esc(built))
      : 'A pool job: <b>' + esc(t.kind) + '</b>' + (p && p.from ? ' ' + esc(p.from) + ' → ' + esc(p.to) : '') + ', on ' + esc(built))
      + ' · ' + (t.status === "staged" ? (T.approval ? 'decided' : 'waiting for a maintainer') : t.status === "leased" ? 'building now' : t.status === "queued" ? 'queued' : t.status) + (t.finished_at ? ', ' + ago(t.finished_at) : '') + '.';
    var vet = t.result && t.result.vet, audit = T.audit[0], trial = T.trial[0], a = T.approval;
    if (isBuild) setTiles("#tiles", [
      ["Gate", vet ? (vet.verdict === "pass" ? "pass" : "fail") : "—", vet ? (vet.fails ? vet.fails + " failing" : (vet.warnings ? vet.warnings + " warning" + (vet.warnings === 1 ? "" : "s") : "clean")) : "built before the gate", vet ? (vet.verdict === "pass" ? "ok" : "bad") : ""],
      ["Audit", audit && audit.status === "done" && audit.result ? String(audit.result.verdict || "done") : audit ? audit.status : "—", audit && audit.result ? num((audit.result.findings || []).length) + " finding(s)" + (audit.result.model ? " · " + audit.result.model : "") : audit ? "the second agent" : project ? "audited on the contributor's build" : "no audit yet", audit && audit.result ? ({ ok: "ok", warn: "warn", block: "bad" }[audit.result.verdict] || "") : ""],
      ["Trial", trial && trial.status === "done" && trial.result ? (trial.result.verdict === "ok" ? "installs" : String(trial.result.verdict)) : trial ? trial.status : "—", trial ? "a real pacman, from the lab" : project ? "not tried yet" : "only the project's build is tried", trial && trial.result ? (trial.result.verdict === "ok" ? "ok" : "bad") : ""],
      ["Decision", a ? a.decision : (t.status === "staged" ? "waiting" : "—"), a ? "by " + a.by + " · " + ago(a.created_at) : t.status === "staged" ? "a maintainer, never the owner" : "nothing to decide", a ? (a.decision === "approved" ? "ok" : "bad") : (t.status === "staged" ? "warn" : "")],
      ["In the rings", T.rings.length ? T.rings.join(" · ") : "—", T.rings.length ? "what users get" : "not in the pool", T.rings.length ? "ok" : ""]
    ]); else setTiles("#tiles", [
      ["Status", t.status, t.error ? "failed: see the log" : t.finished_at ? "finished " + ago(t.finished_at) : "", t.status === "done" ? "ok" : t.status === "failed" ? "bad" : ""],
      ["Duration", secs(t.duration_ms), "wall time on the worker"],
      ["Attempts", num(t.attempts) + " / " + num(t.max_attempts), "leases taken"],
      ["Priority", num(t.priority), "lower runs first"],
      ["Created", ago(t.created_at), t.reason || ""]
    ]);
    renderActions(); renderTimeline(); renderBuild();
    endSkeleton();
  }

  // ---- a maintainer decides here as on Review; the owner never on their own package
  function renderActions() {
    var t = T.task, el = $("#acts"); el.hidden = true; el.innerHTML = "";
    if (!maint() || t.kind !== "build" || t.status !== "staged" || T.approval) return;
    if (t.owner === login) { el.hidden = false; el.innerHTML = '<span class="muted">Yours — another maintainer decides (nobody decides on their own package).</span>'; return; }
    var pb = T.project_builds[0], project = t.trust === "project";
    var b = project ? '<button type="button" data-do="approve">Approve</button> <button type="button" data-do="reject">Reject</button>'
      : pb && (pb.status === "queued" || pb.status === "leased") ? '<span class="muted">the project is building it (<a href="/build/' + pb.id + '">#' + pb.id + '</a>)</span> <button type="button" data-do="reject">Reject</button>'
      : pb && pb.status === "staged" ? '<span class="muted">the project\'s build <a href="/build/' + pb.id + '">#' + pb.id + '</a> is what gets approved</span> <button type="button" data-do="reject">Reject</button>'
      : (pb && pb.status === "failed" ? pill("error", "project build #" + pb.id + " failed", pb.error || "") + " " : "") + '<button type="button" data-do="build">Build by the project</button> <button type="button" data-do="reject">Reject</button>';
    el.hidden = false; el.innerHTML = b;
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-do]") : null; if (!b) return;
    var what = b.getAttribute("data-do"), note = what === "reject" ? prompt("Why? The contributor sees this.") : (prompt("Note for the record (optional)") || "");
    if (what === "reject" && !note) return;
    busy(fetch(API + "/tasks/" + ID + "/" + what, { method: "POST", headers: headers(), body: JSON.stringify({ note: note }) })).then(function (r) { return r.json(); }).then(function (d) {
      var s = $("#state"); s.hidden = false;
      s.innerHTML = d.error ? pill("error", "refused") + " " + esc(d.error) : pill("ok", what === "approve" ? "approved" : what === "build" ? "queued" : "rejected") + " " + (what === "approve" ? "the project's build goes into edge (publish job #" + d.publish + ")" : what === "build" ? "the project is building it: task <a href=\"/build/" + d.task + "\">#" + d.task + "</a>" : "the contributor sees the note");
      load();
    });
  });

  // ---- the timeline: every step with its time, in order
  function renderTimeline() {
    var t = T.task, p = t.params || {}, steps = [], isBuild = t.kind === "build";
    var add = function (cls, title, detail, at) { steps.push({ cls: cls, title: title, detail: detail, at: at }); };
    if (isBuild && T.package && T.package.request_id) add("ok", "Requested", person(T.package.owner) + ' asked for <b>' + esc(t.name) + '</b> — request #' + T.package.request_id + (T.package.project ? ' from <a href="' + esc(T.package.project) + '">' + esc(T.package.project.replace(/^https?:\/\/(www\.)?/, "")) + '</a>' : ''), T.package.created_at);
    if (T.from && p.review !== undefined) add("ok", "Evidence", person(T.from.owner) + '\'s build <a href="/build/' + T.from.id + '">#' + T.from.id + '</a> was staged; a maintainer asked the project to build it again', T.from.finished_at);
    if (T.from && p.task !== undefined) add("ok", "Of build", 'this ' + esc(t.kind) + ' is of build <a href="/build/' + T.from.id + '">#' + T.from.id + '</a> (' + esc(T.from.name || t.name) + ' ' + esc(T.from.version || '') + ')', T.from.finished_at);
    add("ok", "Queued", esc(t.reason || "") + (isBuild ? ' · recipe <span class="mono">' + esc(String(t.pkgbuild_ref || "")) + '</span>' : ''), t.created_at);
    if (t.started_at) add(t.status === "leased" ? "blue" : "ok", t.status === "leased" ? "Building" : "Started", (t.lease_owner ? 'on <span class="mono">' + esc(t.lease_owner) + '</span>' : 'on a worker the record no longer names') + ' · attempt ' + num(t.attempts) + ' of ' + num(t.max_attempts), t.started_at);
    if (t.finished_at) add(t.status === "failed" ? "error" : "ok", t.status === "failed" ? "Failed" : t.status === "staged" ? "Staged" : t.status === "cancelled" ? "Cancelled" : "Finished", (t.duration_ms ? 'after ' + secs(t.duration_ms) : '') + (t.error ? ' — ' + esc(t.error.slice(0, 200)) : '') + (t.status === "staged" ? ' · ' + esc(t.result_filename || "") + ' in the staging workspace' : ''), t.finished_at);
    var vet = t.result && t.result.vet;
    if (vet) add(vet.verdict === "pass" ? "ok" : "error", "The gate", vet.verdict === "pass" ? (vet.warnings ? vet.warnings + " warning(s): " + esc((vet.warned || []).join(", ")) : "every check passed") : "failed: " + esc((vet.failed || []).join(", ")), t.finished_at);
    T.audit.slice().reverse().forEach(function (a) { add(a.status === "done" ? ({ ok: "ok", warn: "warn", block: "error" }[a.result && a.result.verdict] || "ok") : a.status === "failed" ? "error" : "dim", "Audit " + (a.status === "done" ? (a.result && a.result.verdict || "done") : a.status), '<a href="/build/' + a.id + '">#' + a.id + '</a>' + (a.result && a.result.summary ? ' — ' + esc(a.result.summary) : a.error ? ' — ' + esc(a.error) : '') + (a.result && a.result.model ? ' · ' + esc(a.result.model) : ''), a.finished_at || a.started_at); });
    T.trial.slice().reverse().forEach(function (a) { add(a.status === "done" ? (a.result && a.result.verdict === "ok" ? "ok" : "error") : a.status === "failed" ? "error" : "dim", "Trial " + (a.status === "done" ? (a.result && a.result.verdict === "ok" ? "installs" : (a.result && a.result.verdict) || "done") : a.status), '<a href="/build/' + a.id + '">#' + a.id + '</a> — a real pacman, from the lab' + (a.error ? ' — ' + esc(a.error) : ''), a.finished_at || a.started_at); });
    T.project_builds.slice().reverse().forEach(function (b) { add(b.status === "staged" || b.status === "done" ? "ok" : b.status === "failed" ? "error" : "blue", "The project's build " + (b.status === "leased" ? "running" : b.status), '<a href="/build/' + b.id + '">#' + b.id + '</a>' + (b.error ? ' — ' + esc(b.error.slice(0, 160)) : ''), b.finished_at || b.started_at); });
    var a = T.approval;
    if (a) add(a.decision === "approved" ? "ok" : "error", a.decision === "approved" ? "Approved" : "Rejected", 'by ' + person(a.by) + (a.note ? ' — ' + esc(a.note) : '') + (a.rebuild_task && a.rebuild_task !== t.id ? ' · the project\'s build <a href="/build/' + a.rebuild_task + '">#' + a.rebuild_task + '</a> ' + esc(a.rebuild_status || '') : ''), a.created_at);
    T.publish.slice().reverse().forEach(function (b) { add(b.status === "done" ? "ok" : b.status === "failed" ? "error" : "blue", "Published " + (b.status === "done" ? "" : b.status), '<a href="/build/' + b.id + '">#' + b.id + '</a> — into the pool, signed' + (b.error ? ' — ' + esc(b.error) : ''), b.finished_at || b.started_at); });
    if (T.rings.length) add("ok", "In the rings", T.rings.join(" · ") + ' — <a href="/package/' + encodeURIComponent(t.name) + '?ring=' + T.rings[T.rings.length - 1] + '&arch=' + t.arch + '">the package →</a>', null);
    $("#timeline").innerHTML = steps.map(function (s) { return '<li><i class="dot ' + s.cls + '"></i><div><b>' + s.title + '</b> <span class="d">' + s.detail + '</span></div>' + (s.at ? when(s.at) : '<span class="when">now</span>') + '</li>'; }).join("");
  }

  // ---- the build: the worker, the recipe, the package, what it cost
  function renderBuild() {
    var t = T.task, w = T.worker, kv = [];
    var row = function (k, v) { if (v) kv.push('<dt>' + k + '</dt><dd>' + v + '</dd>'); };
    row("Worker", w ? '<span class="mono">' + esc(w.id) + '</span>' + (w.owner ? ' · ' + person(w.owner) : '') + (w.labels && w.labels.where ? ' · on ' + esc(w.labels.where) : '') + (w.trust === "project" ? ' · ' + pill("ok", "project trust", w.trusted_by ? "trusted on the word of " + w.trusted_by : "") : ' · ' + pill("lilac", "community")) + (w.version && w.version !== "container" ? ' · ' + pill("none", w.version, "the release the worker's image is") : '') : (t.lease_owner ? '<span class="mono">' + esc(t.lease_owner) + '</span> <span class="muted">(gone)</span>' : '<span class="muted">none yet</span>'));
    if (w && w.agent) row("Agent", '<span class="mono">' + esc(w.agent) + '</span>');
    row("Recipe", t.kind === "build" ? '<span class="mono">' + esc(String(t.pkgbuild_ref || "")) + '</span>' : null);
    row("Attempts", num(t.attempts) + ' of ' + num(t.max_attempts) + (t.lease_expires_at ? ' · lease until ' + esc(t.lease_expires_at.slice(11, 16)) + ' UTC' : ''));
    row("Duration", t.duration_ms ? secs(t.duration_ms) : null);
    if (t.result_filename) row("Package", '<span class="mono">' + esc(t.result_filename) + '</span>' + (t.result_sha256 ? '<br><span class="mono dim" style="font-size:11.5px">' + esc(t.result_sha256) + '</span>' : ''));
    if (t.kind !== "build" && t.result) row("Result", '<pre style="white-space:pre-wrap;max-height:240px">' + esc(JSON.stringify(t.result, null, 1)) + '</pre>');
    if (t.kind === "build") row("Publish", t.publish === 0 ? 'no — evidence only' : t.trust === "project" ? 'on approval, by the pool' : '—');
    $("#build-kv").innerHTML = kv.join("");
  }
  function renderResources(r) {
    if (!r) return;
    $("#res-panel").hidden = false;
    $("#res").innerHTML = '<div><b>' + secs((r.wall_s || 0) * 1000) + '</b>wall</div><div><b>' + num(r.cpu_s || 0) + ' s</b>cpu' + (r.cores ? ' · ' + num(r.cores) + ' cores' : '') + '</div><div><b>' + num(r.ram_peak_mb || 0) + ' MB</b>ram peak</div><div><b>' + num(r.disk_mb || 0) + ' MB</b>disk</div>';
  }

  // ---- the evidence, read in place
  var TEXT = { "vet.json": "The gate", "audit.json": "The audit", "trial.log": "The trial", PKGBUILD: "The recipe", "build.log": "The build log", "tests.log": "The gate's transcript", PKGINFO: "The manifest", "audit.md": "The audit, as written", "resources.json": null };
  function loadEvidence() {
    var ev = T.evidence || [], text = ev.filter(function (e) { return e.public; }), bins = ev.filter(function (e) { return !e.public; });
    if (!ev.length) { $("#evidence").innerHTML = '<p class="sub" style="margin:0">' + (T.task.kind === "build" ? 'Nothing staged for this build' + (T.task.log_tail ? ' — the log\'s tail the worker reported:</p><pre style="white-space:pre-wrap;margin-top:10px">' + esc(T.task.log_tail) + '</pre>' : '.</p>') : (T.task.log_tail ? 'The log\'s tail the worker reported:</p><pre style="white-space:pre-wrap;margin-top:10px">' + esc(T.task.log_tail) + '</pre>' : 'A pool job leaves its result on the task, not files.</p>')); return; }
    var order = ["vet.json", "audit.json", "trial.log", "PKGBUILD", "build.log", "tests.log", "PKGINFO", "audit.md"];
    text.sort(function (a, b) { return (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99); });
    var html = text.filter(function (e) { return e.name !== "resources.json" && e.name !== "audit.md"; }).map(function (e) {
      return '<details class="ev" id="ev-' + esc(e.name.replace(/[^a-z0-9]/gi, "-")) + '"' + (e.name === "vet.json" || e.name === "audit.json" ? " open" : "") + '><summary><b>' + esc(TEXT[e.name] || e.name) + '</b> <span class="mono dim">' + esc(e.name) + '</span> <span class="dim">' + bytes(e.size) + '</span> <a class="run" href="' + esc(e.url) + '" onclick="event.stopPropagation()">raw ↗</a></summary><div class="body"><div class="muted">loading…</div></div></details>';
    }).join("");
    if (bins.length) html += '<p class="sub" style="margin-top:12px">Packages in staging (for maintainers and the publish job): ' + bins.map(function (b) { return '<span class="mono">' + esc(b.name) + '</span> <span class="dim">' + bytes(b.size) + '</span>'; }).join(" · ") + '</p>';
    $("#evidence").innerHTML = html;
    text.forEach(function (e) {
      if (e.name === "audit.md") return;
      fetch(e.url).then(function (r) { return r.text(); }).then(function (body) {
        if (e.name === "resources.json") { try { renderResources(JSON.parse(body)); } catch (x) {} return; }
        // A failed build keeps no verdict on its row; the file says what the gate found — the tile and the timeline read it.
        if (e.name === "vet.json" && !(T.task.result && T.task.result.vet)) {
          try { var v = JSON.parse(body), cs = v.checks || []; T.task.result = Object.assign({}, T.task.result || {}, { vet: { verdict: v.verdict, fails: cs.filter(function (c) { return c.status === "fail"; }).length, warnings: cs.filter(function (c) { return c.status === "warn"; }).length, failed: cs.filter(function (c) { return c.status === "fail"; }).map(function (c) { return c.name; }), warned: cs.filter(function (c) { return c.status === "warn"; }).map(function (c) { return c.name; }) } }); render(); } catch (x) {}
        }
        var el = document.querySelector('#ev-' + e.name.replace(/[^a-z0-9]/gi, "-") + ' .body'); if (!el) return;
        el.innerHTML = renderEvidence(e.name, body);
      }).catch(function () {});
    });
  }
  function bytes(n) { n = Number(n || 0); return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
  function renderEvidence(name, body) {
    if (name === "vet.json") {
      try {
        var v = JSON.parse(body);
        return '<table class="ev-table"><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>' + (v.checks || []).map(function (c) { return '<tr><td class="mono">' + esc(c.name) + '</td><td>' + pill(c.status === "pass" ? "ok" : c.status === "warn" ? "warn" : "error", c.status) + '</td><td class="muted">' + esc(c.detail || "") + '</td></tr>'; }).join("") + '</tbody></table><p class="sub" style="margin:8px 0 0">Verdict: ' + pill(v.verdict === "pass" ? "ok" : "error", v.verdict || "?") + ' · ' + num(v.fails || 0) + ' failing, ' + num(v.warnings || 0) + ' warning(s) · <a href="/docs/what-we-test">what each check means →</a></p>';
      } catch (x) { return '<pre style="white-space:pre-wrap">' + esc(body) + '</pre>'; }
    }
    if (name === "audit.json") {
      try {
        var a = JSON.parse(body), f = a.findings || [];
        return '<p style="margin:0 0 10px">' + pill({ ok: "ok", warn: "warn", block: "error" }[a.verdict] || "none", a.verdict || "?") + ' ' + esc(a.summary || "") + (a.model ? ' <span class="dim">· ' + esc(a.model) + '</span>' : '') + (a.category ? ' <span class="dim">· category ' + esc(a.category) + '</span>' : '') + '</p>' +
          (f.length ? '<table class="ev-table"><thead><tr><th>Severity</th><th>Area</th><th>Where</th><th>What</th><th>Fix</th></tr></thead><tbody>' + f.map(function (x) { return '<tr><td>' + pill(x.severity === "high" ? "error" : x.severity === "medium" ? "warn" : "none", x.severity || "") + '</td><td>' + esc(x.area || "") + '</td><td class="mono" style="font-size:11.5px">' + esc(x.where || "") + '</td><td>' + esc(x.what || "") + '</td><td class="muted">' + esc(x.fix || "") + '</td></tr>'; }).join("") + '</tbody></table>' : '<p class="sub" style="margin:0">No finding.</p>');
      } catch (x) { return '<pre style="white-space:pre-wrap">' + esc(body) + '</pre>'; }
    }
    if (name === "PKGINFO") return '<dl class="kv">' + body.split("\n").filter(function (l) { return l.indexOf(" = ") > 0 && l.charAt(0) !== "#"; }).map(function (l) { var i = l.indexOf(" = "); return '<dt class="mono">' + esc(l.slice(0, i)) + '</dt><dd>' + esc(l.slice(i + 3)) + '</dd>'; }).join("") + '</dl>';
    if (name === "PKGBUILD") return '<pre class="code">' + body.split("\n").map(function (l, i) { return '<span class="ln">' + (i + 1) + '</span>' + esc(l); }).join("\n") + '</pre>';
    // A log: the last two hundred lines, the rest on request.
    var lines = body.split("\n"), tail = lines.length > 200;
    return (tail ? '<p class="sub" style="margin:0 0 8px">' + num(lines.length) + ' lines; the last 200 — <a href="#" data-all="1">show all</a></p>' : '') + '<pre class="log" style="white-space:pre-wrap;max-height:480px;overflow:auto">' + esc((tail ? lines.slice(-200) : lines).join("\n")) + '</pre>' + (tail ? '<pre class="log full" hidden style="white-space:pre-wrap;max-height:640px;overflow:auto">' + esc(body) + '</pre>' : '');
  }
  document.addEventListener("click", function (ev) {
    var a = ev.target.closest ? ev.target.closest("a[data-all]") : null; if (!a) return;
    ev.preventDefault(); var box = a.closest(".body"); box.querySelector("pre.log").hidden = true; box.querySelector("pre.full").hidden = false; a.parentElement.hidden = true;
  });
  load();
`;

export function buildHtml(id: number, poolUrl: string, version: RunningVersion): string {
  return page({
    title: `Build #${id} · omarchy-pool`,
    description: "One build, whole: what happened and when, the machine that built it and what it cost, every piece of evidence read in place.",
    active: "review",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
