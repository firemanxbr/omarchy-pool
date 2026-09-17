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
import type { Component, Fixture, Role } from "./components";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <p class="crumbs"><a href="/review">Review</a> / <span id="crumb">build</span></p>
  <div class="h2row" style="align-items:center;gap:12px;flex-wrap:wrap"><h1 id="title" style="max-width:none">…</h1><div id="badges" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"></div></div>
  <p class="lede" id="lede"></p>
  <div class="tiles six" id="tiles"></div>
  <div id="acts" class="acts" hidden></div>
  <p class="sub" id="state" hidden></p>

  <section id="who-section" hidden>
    <div class="h2row"><h2>Who does what</h2><span class="hint">two people behind every package the factory ships</span></div>
    <p class="sub">The contributor brings the request and a build that passes the gate; only then is a maintainer's time well spent. The maintainer has the project build it again, reads the evidence, tries it and decides — never on their own package. Each half is fifty points; the class is the score today, the projection is with the maintainer's half green. <a href="/docs/what-we-test#the-score">The rules →</a></p>
    <div id="ckreq"></div>
    <div class="cklist" id="cklist"></div>
  </section>

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
  skeletonTiles("#tiles", 6);

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
    var sc = T.score;
    $("#title").innerHTML = isBuild ? '<a href="/package/' + encodeURIComponent(t.name) + '?ring=' + (T.rings[0] || "lab") + '&arch=' + esc(t.arch) + '" title="the package, as Packages shows it — with where it came from">' + esc(t.name) + '</a> <span class="mono muted" style="font-size:.7em">' + esc(t.version || "") + '</span>' : esc(t.kind) + ' <span class="mono muted" style="font-size:.7em">#' + t.id + '</span>';
    $("#badges").innerHTML = pill("none", t.arch) + statusPill(t.status) + (isBuild ? pill(project ? "ok" : "lilac", project ? "the project" : "evidence", project ? "built by the project on a trusted worker, from a contributor's evidence" : "a contributor's build: evidence for a maintainer, never what users get") : "")
      + (isBuild && sc ? (sc.ready ? pill("ok", "ready for a maintainer", "the contributor's half is complete: a build that passed the gate, audited") : t.status === "staged" || t.status === "leased" || t.status === "queued" ? pill("warn", "not ready", "the contributor's half is not complete yet") : "") : "");
    var built = T.worker ? (T.worker.owner ? T.worker.owner + "'s worker " : "worker ") + T.worker.id : (t.lease_owner || (t.finished_at ? "a worker the record no longer names" : "no worker yet"));
    var vet = t.result && t.result.vet, audit = T.audit[0], trial = T.trial[0], a = T.approval && !T.approval.withdrawn_at ? T.approval : null, wd = T.approval && T.approval.withdrawn_at ? T.approval : null;
    $("#lede").innerHTML = (isBuild
      ? (project ? 'The project built <b>' + esc(t.name) + '</b> ' + esc(t.version || '') + ' for ' + esc(t.arch) + (T.from ? ' from the evidence in <a href="/build/' + T.from.id + '">#' + T.from.id + '</a> (' + person(T.from.owner) + '\'s build)' : '') : person(t.owner) + ' built <b>' + esc(t.name) + '</b> ' + esc(t.version || '') + ' for ' + esc(t.arch) + ' on ' + esc(built))
      : 'A pool job: <b>' + esc(t.kind) + '</b>' + (p && p.from ? ' ' + esc(p.from) + ' → ' + esc(p.to) : '') + ', on ' + esc(built))
      + ' · ' + (t.status === "staged" ? (a ? 'decided' : wd ? 'the approval was withdrawn — waiting for another maintainer' : 'waiting for a maintainer') : t.status === "leased" ? 'building now' : t.status === "queued" ? 'queued' : t.status) + (t.finished_at ? ', ' + ago(t.finished_at) : '') + '.';
    if (isBuild) setTiles("#tiles", [
      ["Gate", vet ? (vet.verdict === "pass" ? "pass" : "fail") : "—", vet ? (vet.fails ? vet.fails + " failing" : (vet.warnings ? vet.warnings + " warning" + (vet.warnings === 1 ? "" : "s") : "clean")) : "built before the gate", vet ? (vet.verdict === "pass" ? "ok" : "bad") : ""],
      ["Audit", audit && audit.status === "done" && audit.result ? String(audit.result.verdict || "done") : audit ? audit.status : "—", audit && audit.result ? num((audit.result.findings || []).length) + " finding(s)" + (audit.result.model ? " · " + audit.result.model : "") : audit ? "the second agent" : project ? "audited on the contributor's build" : "no audit yet", audit && audit.result ? ({ ok: "ok", warn: "warn", block: "bad" }[audit.result.verdict] || "") : ""],
      ["Trial", trial && trial.status === "done" && trial.result ? (trial.result.verdict === "ok" ? "installs" : String(trial.result.verdict)) : trial ? trial.status : "—", trial ? "a real pacman, from the lab" : project ? "not tried yet" : "only the project's build is tried", trial && trial.result ? (trial.result.verdict === "ok" ? "ok" : "bad") : ""],
      ["Decision", a ? a.decision : wd ? "withdrawn" : (t.status === "staged" ? "waiting" : "—"), a ? "by " + a.by + " · " + ago(a.created_at) : wd ? "the approval by " + wd.by + " taken back by " + wd.withdrawn_by : t.status === "staged" ? "a maintainer, never the owner" : "nothing to decide", a ? (a.decision === "approved" ? "ok" : "bad") : wd ? "warn" : (t.status === "staged" ? "warn" : "")],
      ["Class", sc ? sc.class + ' <span class="dim" style="font-size:.5em">' + sc.points + '/' + sc.max + '</span>' : "—", sc ? (sc.class === sc.projected ? "with the maintainer's half green: the same" : "with the maintainer's half green: " + sc.projected) : "no chain", sc ? { A: "ok", B: "ok", C: "warn", D: "bad" }[sc.class] : ""],
      ["In the rings", T.rings.length ? T.rings.join(" · ") : "—", T.rings.length ? (T.rings.length === 1 && T.rings[0] === "lab" ? "the lab: not promised, not promoted" : "what users get") : "not in the pool", T.rings.length ? (T.rings.length === 1 && T.rings[0] === "lab" ? "warn" : "ok") : ""]
    ]); else setTiles("#tiles", [
      ["Status", t.status, t.error ? "failed: see the log" : t.finished_at ? "finished " + ago(t.finished_at) : "", t.status === "done" ? "ok" : t.status === "failed" ? "bad" : ""],
      ["Duration", secs(t.duration_ms), "wall time on the worker"],
      ["Attempts", num(t.attempts) + " / " + num(t.max_attempts), "leases taken"],
      ["Priority", num(t.priority), "lower runs first"],
      ["Created", ago(t.created_at), t.reason || ""]
    ]);
    renderActions(); renderTimeline(); renderBuild(); renderChecklist();
    endSkeleton();
  }
  // ---- who does what: the two halves, item by item, with the points each earned
  function renderChecklist() {
    var sc = T.score, el = $("#who-section"); if (!sc) { el.hidden = true; return; }
    el.hidden = false;
    var c = T.chain || {};
    // The request the chain rests on, checked as the form checks it today; the contributor renews it from here when a line is not green.
    var pkgSt = (T.package || {}).status;
    $("#ckreq").innerHTML = T.request ? requestBlock(T.request, !!(login && T.task.owner === login), T.task.name, !!T.request.renewable, T.request.busy ? "renew it once build #" + T.request.busy + " is done" : pkgSt === "approved" || pkgSt === "published" ? "in the pool as it was; new releases come as bumps, built from the approved recipe" : "renew it once nothing of it is being built") : "";
    $("#cklist").innerHTML = ckColumn(sc, "contributor", "The contributor's half", c.contributor ? person(c.contributor.owner) + (c.contributor.id !== T.task.id ? ' · build <a href="/build/' + c.contributor.id + '">#' + c.contributor.id + '</a>' : '') : 'nobody yet')
      + ckColumn(sc, "maintainer", "The maintainer's half", c.project ? 'the project\'s build <a href="/build/' + c.project.id + '">#' + c.project.id + '</a>' + (c.approval ? ' · decided by ' + person(c.approval.by) : c.withdrawn ? ' · the approval by ' + person(c.withdrawn.by) + ' was withdrawn' : ' · not decided') : 'not started' + (sc.ready ? ' — ready to begin' : ''));
  }

  // ---- a maintainer decides here as on Review; the owner never on their own package
  function renderActions() {
    var t = T.task, el = $("#acts"); el.hidden = true; el.innerHTML = "";
    var standing = T.approval && !T.approval.withdrawn_at && T.approval.decision === "approved";
    if (maint() && t.kind === "build" && standing) { el.hidden = false; el.innerHTML = '<span class="muted">Approved by ' + person(T.approval.by) + ' ' + ago(T.approval.created_at) + '.</span> <button type="button" data-do="withdraw" title="take the approval back: the package leaves every ring, another maintainer decides — the reason goes on the record">Withdraw the approval</button>'; return; }
    if (!maint() || t.kind !== "build" || t.status !== "staged" || standing) return;
    if (t.owner === login) { el.hidden = false; el.innerHTML = '<span class="muted">Yours — another maintainer decides (nobody decides on their own package; a maintainer who brings a package is a contributor here).</span>'; return; }
    if (T.score && !T.score.ready) { el.hidden = false; el.innerHTML = pill("warn", "not ready") + ' <span class="muted">the contributor\'s half is not complete — nothing for a maintainer yet.</span>'; return; }
    var pb = T.project_builds[0], project = t.trust === "project";
    var b = project ? '<button type="button" data-do="approve">Approve</button> <button type="button" data-do="reject">Reject</button>'
      : pb && (pb.status === "queued" || pb.status === "leased") ? '<span class="muted">the project is building it (<a href="/build/' + pb.id + '">#' + pb.id + '</a>)</span> <button type="button" data-do="reject">Reject</button>'
      : pb && pb.status === "staged" ? '<span class="muted">the project\'s build <a href="/build/' + pb.id + '">#' + pb.id + '</a> is what gets approved</span> <button type="button" data-do="reject">Reject</button>'
      : (pb && pb.status === "failed" ? pill("error", "project build #" + pb.id + " failed", pb.error || "") + " " : "") + '<button type="button" data-do="build">Build by the project</button> <button type="button" data-do="reject">Reject</button>';
    el.hidden = false; el.innerHTML = b;
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-do]") : null; if (!b) return;
    var what = b.getAttribute("data-do"), t = T.task, name = t.name + " " + (t.version || "");
    // Where the project builds is the maintainer's call: the project's workers for this architecture (the native one, not the emulated one), read when the dialog opens.
    var asked = what === "build"
      ? fetch("/api/v1/factory?limit=10").then(function (r) { return r.json(); }).then(function (d) { return d.workers || []; }).catch(function () { return []; }).then(function (ws) { return ask({ title: "Have the project build " + name + " again", text: "A trusted review worker builds the recipe again with the project's agent — the contributor's bytes are never used.", select: whereOptions(ws, t.arch, login, true), input: "optional", placeholder: "a hint for the project's agent (optional)", confirm: "Build by the project" }); })
      : ask(what === "reject" ? { title: "Reject " + name, text: "The contributor reads the note and builds again. The rejection is on the record.", input: "required", placeholder: "what is wrong, in a line or two", confirm: "Reject", danger: true }
      : what === "withdraw" ? { title: "Withdraw the approval of " + name, text: "The approval stays on the record and is void from now on; the package leaves every ring it reached; another maintainer decides.", input: "required", placeholder: "why take it back", confirm: "Withdraw", danger: true }
      : { title: "Approve " + name, text: "The project's build goes into edge, signed by the pool; the approval is on the record with your name.", input: "optional", confirm: "Approve" });
    asked.then(function (got) {
      if (got === null) return;
      var note = got && typeof got === "object" ? got.note : got, body = { note: note };
      if (got && typeof got === "object" && got.pick) body.worker = got.pick;
      busy(fetch(API + "/tasks/" + ID + "/" + what, { method: "POST", headers: headers(), body: JSON.stringify(body) })).then(function (r) { return r.json(); }).then(function (d) {
        var s = $("#state"); s.hidden = false;
        s.innerHTML = d.error ? pill("error", "refused") + " " + esc(d.error) : pill(what === "withdraw" ? "warn" : "ok", what === "approve" ? "approved" : what === "build" ? "queued" : what === "withdraw" ? "withdrawn" : "rejected") + " " + (what === "approve" ? "the project's build goes into edge (publish job #" + d.publish + ")" : what === "build" ? "the project is building it: task <a href=\"/build/" + d.task + "\">#" + d.task + "</a>" : what === "withdraw" ? "the approval is void; the package leaves " + esc((d.rings || []).map(function (r) { return r.ring; }).join(", ") || "no ring") + " — another maintainer decides" : "the contributor sees the note");
        toast(d.error ? esc(d.error) : s.textContent, d.error ? "error" : what === "withdraw" ? "warn" : "ok");
        load();
      });
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
    if (a) add(a.withdrawn_at ? "dim" : a.decision === "approved" ? "ok" : "error", a.decision === "approved" ? "Approved" : "Rejected", 'by ' + person(a.by) + (a.note ? ' — ' + esc(a.note) : '') + (a.rebuild_task && a.rebuild_task !== t.id ? ' · the project\'s build <a href="/build/' + a.rebuild_task + '">#' + a.rebuild_task + '</a> ' + esc(a.rebuild_status || '') : ''), a.created_at);
    if (a && a.withdrawn_at) add("warn", "Approval withdrawn", 'by ' + person(a.withdrawn_by) + ' — ' + esc(a.withdrawn_reason || '') + ' · the package left the rings; another maintainer decides', a.withdrawn_at);
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

/**
 * What /build/<id> is made of, for test/components.test.ts — see
 * components.ts. One read feeds nearly the whole page, GET
 * /api/v1/factory/tasks/<id>, so each part names the fields of it that it
 * draws; the evidence panels read one file each. The page is the project's
 * build (F.projectTask) — staged, audited, tried, approved — so the head,
 * the timeline, the chain and every evidence file have something to show;
 * the branches a contributor's build draws are read on F.contributorTask.
 * The decision block's acts go where its buttons post: the role gates on
 * this build, where nobody but a maintainer gets through and nothing
 * changes; the decisions on the rows the fixture made for deciding; the
 * withdrawal last, because it is the one act that changes what every
 * manifest after this one finds — the approval is void from there on.
 */
export const BUILD_COMPONENTS = (F: Fixture): Component[] => {
  const page = `/build/${F.projectTask}`;
  const task = `/api/v1/factory/tasks/${F.projectTask}`;
  const pkg = `${task}/artifacts/${F.factoryPkg}-1.0-1-${F.arch}.pkg.tar.zst`;
  const everyone: Role[] = ["anonymous", "contributor", "owner", "maintainer"];
  return [
    {
      id: "build.crumbs",
      page,
      anchor: ['<a href="/review">Review</a>', 'id="crumb"'],
      script: ['"#crumb"', '"#" + t.id'],
      reads: [{ path: task, fields: ["task.kind", "task.name", "task.id"] }],
      visible: everyone,
    },
    {
      id: "build.title",
      page,
      anchor: ['id="title"'],
      script: ['"#title"', "document.title", '<a href="/package/', "T.rings[0]"],
      reads: [{ path: task, fields: ["task.kind", "task.name", "task.version", "task.id", "task.arch", "rings"] }],
      visible: everyone,
    },
    {
      id: "build.badges",
      page,
      anchor: ['id="badges"'],
      script: ['"#badges"', "statusPill(t.status)", "sc.ready", '"ready for a maintainer"', '"not ready"'],
      reads: [{ path: task, fields: ["task.arch", "task.status", "task.kind", "task.trust", "score.ready"] }],
      visible: everyone,
    },
    {
      id: "build.lede",
      page,
      anchor: ['id="lede"'],
      script: ['"#lede"', "T.worker.owner", "T.from.owner", "T.approval.withdrawn_at", "t.lease_owner"],
      reads: [
        {
          path: task,
          fields: ["task.kind", "task.trust", "task.name", "task.version", "task.arch", "task.owner", "task.status", "task.finished_at", "task.lease_owner", "task.params", "worker.id", "worker.owner", "from.id", "from.owner", "approval.decision", "approval.withdrawn_at"],
        },
      ],
      visible: everyone,
    },
    {
      id: "build.tiles",
      page,
      anchor: ['id="tiles"', 'class="tiles six"'],
      script: ['skeletonTiles("#tiles", 6)', 'setTiles("#tiles"', '"Gate"', '"Audit"', '"Trial"', '"Decision"', '"Class"', '"In the rings"', "vet.verdict", "sc.projected", "T.task.result.vet"],
      reads: [
        {
          path: task,
          fields: [
            "task.result.vet.verdict", "task.result.vet.fails", "task.result.vet.warnings",
            "audit.0.status", "audit.0.result.verdict", "audit.0.result.findings", "audit.0.result.model",
            "trial.0.status", "trial.0.result.verdict",
            "approval.decision", "approval.by", "approval.created_at", "approval.withdrawn_at", "approval.withdrawn_by",
            "score.class", "score.points", "score.max", "score.projected", "rings",
            "task.status", "task.error", "task.finished_at", "task.duration_ms", "task.attempts", "task.max_attempts", "task.priority", "task.created_at", "task.reason",
          ],
        },
        // A failed build keeps no verdict on its row: the tile reads the file the worker staged.
        { path: `${task}/artifacts/vet.json`, json: false },
      ],
      visible: everyone,
    },
    {
      id: "build.actions",
      page,
      anchor: ['id="acts"', 'id="state"'],
      script: [
        '"#acts"', '"#state"', 'WHO.role === "maintainer"', 'API + "/me"',
        'data-do="approve"', 'data-do="reject"', 'data-do="build"', 'data-do="withdraw"',
        '"/api/v1/factory?limit=10"', "whereOptions(ws, t.arch, login, true)", 'API + "/tasks/" + ID + "/" + what',
        "T.project_builds[0]", "d.publish", "d.task", "d.rings",
      ],
      reads: [
        // Who is reading: the cookie's session, or a CLI token when the cookie says nobody.
        { path: "/auth/me", as: "maintainer", fields: ["login", "role"] },
        { path: "/api/v1/factory/me", as: "owner", fields: ["contributor.login", "contributor.role"] },
        // The project's build: a standing approval draws "Withdraw the approval".
        { path: task, fields: ["task.kind", "task.status", "task.owner", "task.trust", "approval.decision", "approval.by", "approval.created_at", "approval.withdrawn_at", "score.ready", "project_builds"] },
        // A contributor's build: the project's build of it is what gets approved.
        { path: `/api/v1/factory/tasks/${F.contributorTask}`, fields: ["task.trust", "task.status", "task.owner", "score.ready", "project_builds.0.id", "project_builds.0.status", "project_builds.0.error"] },
        // The workers the "Build by the project" dialog offers.
        {
          path: "/api/v1/factory?limit=10",
          fields: ["workers", "workers.0.id", "workers.0.arch", "workers.0.revoked_at", "workers.0.side", "workers.0.kinds", "workers.0.owner", "workers.0.mode", "workers.0.alive", "workers.0.agent", "workers.0.agent_status", "workers.0.current_task", "workers.0.labels", "workers.0.update"],
        },
      ],
      acts: [
        { method: "POST", path: `${task}/approve`, body: { note: "reads well" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
        // The gates of a rejection on this build: nobody but a maintainer is let through, so it stays as it is.
        { method: "POST", path: `${task}/reject`, body: { note: "the source is not the upstream's" }, expect: { anonymous: 401, contributor: 403, owner: 403 } },
        // The rejection itself, on the row made for it; 409 once another page's manifest rejected it first.
        { method: "POST", path: `/api/v1/factory/tasks/${F.disposableTask}/reject`, body: { note: "the source is not the upstream's" }, expect: { maintainer: [200, 409] } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/build`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
        // Void from here on: 404 once a manifest before this one took it back.
        { method: "POST", path: `${task}/withdraw`, body: { note: "approved before the trial was read" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 404] } },
      ],
      visible: ["maintainer"],
    },
    {
      id: "build.who-section",
      page,
      anchor: ['id="who-section"', "two people behind every package the factory ships", 'href="/docs/what-we-test#the-score"'],
      script: ['$("#who-section")', "if (!sc) { el.hidden = true; return; }"],
      reads: [{ path: task, fields: ["score"] }],
      visible: everyone,
    },
    {
      id: "build.request-block",
      page,
      anchor: ['id="ckreq"'],
      script: ['"#ckreq"', "requestBlock(T.request", "T.task.owner === login", "T.request.renewable", "T.request.busy", 'pkgSt === "approved" || pkgSt === "published"'],
      reads: [
        {
          path: task,
          fields: ["request.id", "request.record", "request.signature", "request.version", "request.created_at", "request.complete", "request.checks", "request.checks.0.item", "request.checks.0.note", "request.checks.0.ok", "request.renewable", "request.busy", "package.status", "task.owner", "task.name"],
        },
      ],
      visible: everyone,
    },
    {
      id: "build.score-columns",
      page,
      anchor: ['id="cklist"', 'class="cklist"'],
      script: ['"#cklist"', 'ckColumn(sc, "contributor"', 'ckColumn(sc, "maintainer"', "c.contributor.owner", "c.project.id", "c.approval.by", "c.withdrawn.by"],
      reads: [
        {
          path: task,
          fields: ["score.items", "score.items.0.who", "score.items.0.item", "score.items.0.points", "score.items.0.max", "score.items.0.state", "score.items.0.note", "score.ready", "chain.contributor.id", "chain.contributor.owner", "chain.project.id", "chain.approval.by", "chain.withdrawn", "task.id"],
        },
      ],
      visible: everyone,
    },
    {
      id: "build.timeline",
      page,
      anchor: ['id="timeline"', 'class="tl"'],
      script: [
        '"#timeline"', "T.package.request_id", "p.review !== undefined", "p.task !== undefined", "t.pkgbuild_ref",
        "T.audit.slice().reverse()", "T.trial.slice().reverse()", "T.project_builds.slice().reverse()", "T.publish.slice().reverse()",
        "a.rebuild_task", "a.withdrawn_reason", "vet.warned", "vet.failed",
      ],
      reads: [
        {
          path: task,
          fields: [
            "package.request_id", "package.owner", "package.project", "package.created_at",
            "from.id", "from.owner", "from.version", "from.finished_at",
            "task.params.review", "task.reason", "task.pkgbuild_ref", "task.created_at", "task.started_at", "task.status", "task.lease_owner", "task.attempts", "task.max_attempts",
            "task.finished_at", "task.duration_ms", "task.error", "task.result_filename",
            "task.result.vet.verdict", "task.result.vet.warnings", "task.result.vet.warned", "task.result.vet.failed",
            "audit.0.id", "audit.0.status", "audit.0.result.verdict", "audit.0.result.summary", "audit.0.result.model", "audit.0.error", "audit.0.finished_at", "audit.0.started_at",
            "trial.0.id", "trial.0.status", "trial.0.result.verdict", "trial.0.error", "trial.0.finished_at", "trial.0.started_at",
            "project_builds",
            "approval.decision", "approval.by", "approval.note", "approval.withdrawn_at", "approval.withdrawn_by", "approval.withdrawn_reason", "approval.rebuild_task", "approval.rebuild_status", "approval.created_at",
            "publish.0.id", "publish.0.status", "publish.0.error", "publish.0.finished_at", "publish.0.started_at",
            "rings", "task.name", "task.arch",
          ],
        },
      ],
      visible: everyone,
    },
    {
      id: "build.build-kv",
      page,
      anchor: ['id="build-kv"', 'class="kv"'],
      script: ['"#build-kv"', 'row("Worker"', 'row("Recipe"', 'row("Package"', 'row("Publish"', "w.trusted_by", "w.labels.where", "t.lease_expires_at", "t.result_sha256"],
      reads: [
        {
          path: task,
          fields: ["worker.id", "worker.owner", "worker.labels", "worker.trust", "worker.trusted_by", "worker.version", "worker.agent", "task.lease_owner", "task.kind", "task.pkgbuild_ref", "task.attempts", "task.max_attempts", "task.lease_expires_at", "task.duration_ms", "task.result_filename", "task.result_sha256", "task.result", "task.publish", "task.trust"],
        },
      ],
      visible: everyone,
    },
    {
      id: "build.resources",
      page,
      anchor: ['id="res-panel"', 'id="res"', 'class="mini four"'],
      script: ['"#res-panel"', '"#res"', '"resources.json"', "r.wall_s", "r.cpu_s", "r.ram_peak_mb", "r.disk_mb"],
      reads: [{ path: `${task}/artifacts/resources.json`, json: false }],
      visible: everyone,
    },
    {
      id: "build.evidence-list",
      page,
      anchor: ['id="evidence-section"', 'id="ev-note"', 'id="evidence"'],
      script: ['"#evidence"', "e.public", 'class="ev"', "raw ↗", "fetch(e.url)", '"audit.md"', "Nothing staged for this build", "T.task.log_tail"],
      reads: [{ path: task, fields: ["evidence", "evidence.0.name", "evidence.0.size", "evidence.0.uploaded_at", "evidence.0.url", "evidence.0.public", "task.kind", "task.log_tail"] }],
      visible: everyone,
    },
    {
      id: "build.staging-packages",
      page,
      anchor: ['id="evidence"'],
      script: ["Packages in staging (for maintainers and the publish job)", "!e.public"],
      reads: [
        { path: task, fields: ["evidence.0.public"] },
        // The package itself is named for everyone and served to a maintainer only.
        { path: pkg, status: 403, fields: ["error"] },
        { path: pkg, as: "owner", status: 403, fields: ["error"] },
        { path: pkg, as: "maintainer", json: false },
      ],
      visible: everyone,
    },
    {
      id: "build.gate-table",
      page,
      anchor: ['id="evidence"'],
      script: ['name === "vet.json"', 'class="ev-table"', "v.checks", "c.status", "c.detail", "v.verdict", 'href="/docs/what-we-test"'],
      reads: [{ path: `${task}/artifacts/vet.json`, json: false }],
      visible: everyone,
    },
    {
      id: "build.audit-table",
      page,
      anchor: ['id="evidence"'],
      script: ['name === "audit.json"', "a.findings", "a.summary", "a.model", "a.category", "x.severity", "x.where", "x.fix", "No finding."],
      reads: [{ path: `${task}/artifacts/audit.json`, json: false }],
      visible: everyone,
    },
    {
      id: "build.recipe-code",
      page,
      anchor: ['id="evidence"'],
      script: ['name === "PKGBUILD"', 'class="code"', 'class="ln"'],
      reads: [{ path: `${task}/artifacts/PKGBUILD`, json: false }],
      visible: everyone,
    },
    {
      id: "build.manifest-kv",
      page,
      anchor: ['id="evidence"'],
      script: ['name === "PKGINFO"', 'indexOf(" = ")', 'class="kv"'],
      reads: [{ path: `${task}/artifacts/PKGINFO`, json: false }],
      visible: everyone,
    },
    {
      id: "build.log-view",
      page,
      anchor: ['id="evidence"'],
      script: ['"build.log"', '"tests.log"', '"trial.log"', "lines.slice(-200)", 'data-all="1"', 'class="log full"', "a[data-all]"],
      reads: [
        { path: `${task}/artifacts/build.log`, json: false },
        { path: `${task}/artifacts/tests.log`, json: false },
        { path: `${task}/artifacts/trial.log`, json: false },
      ],
      visible: everyone,
    },
    {
      id: "build.json-link",
      page,
      anchor: ['id="json-link"', ">/api/v1/factory/tasks/…</a>"],
      script: ['"#json-link"', 'API + "/tasks/" + ID'],
      reads: [{ path: task, fields: ["task.id"] }],
      visible: everyone,
    },
    {
      id: "build.not-found",
      page,
      anchor: ['id="title"', 'id="lede"'],
      script: ['"No such task"', "d.error", "endSkeleton()"],
      reads: [{ path: "/api/v1/factory/tasks/0", status: 404, fields: ["error"] }],
      visible: everyone,
    },
  ];
};
