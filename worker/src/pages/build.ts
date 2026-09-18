/**
 * A build, whole, on one page — /build/<task>: the package and its state,
 * what happened to it and when (the timeline), the machine that built it
 * and what the build cost (resources.json), and every piece of evidence
 * read in place: the gate's checks, the audit's findings, the trial's
 * transcript, the recipe, the log, the manifest — with the raw file one
 * click away and the same thing as JSON for a tool
 * (GET /api/v1/factory/tasks/<id>). A maintainer decides here as on
 * Review, and everyone sees the same four buttons — grey, with the reason,
 * for whoever may not press them. A pool job (sync, health, …) gets the
 * same page, shorter.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <p class="crumbs"><a href="/review">Review</a> / <span id="crumb">build</span></p>
  <div class="h2row" style="align-items:center;gap:12px;flex-wrap:wrap"><h1 id="title" style="max-width:none">…</h1><div id="badges" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"></div></div>
  <p class="lede" id="lede"></p>
  <div class="tiles six" id="tiles"></div>
  <div id="acts" class="acts"></div>

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
  var API = "/api/v1/factory", ID = Number(location.pathname.split("/").pop()), T = null;
  function when(iso) { return iso ? '<span class="when" title="' + esc(iso) + '">' + ago(iso) + '</span>' : ''; }
  $("#json-link").href = API + "/tasks/" + ID; $("#json-link").textContent = API + "/tasks/" + ID;
  skeletonTiles("#tiles", 6);

  // Who is looking is the shell's WHO (the omc cookie, one fetch of /auth/me per page); the page draws again once it is known, since the staging packages' links are grey for whoever is not a maintainer and the request's renew link falls back on it until the owner's rights land. The decisions do not wait for it: their rights come from the server (CAN, below).
  whoami(function () { if (T) { render(); renderStaging(); loadOwnerCan(); } });

  // The task and what this reader may decide on it, read together and drawn once: the first paint carries the buttons in the right state, no grey "not now" before the rights land — the same first draw as a person's page.
  function load() {
    return Promise.all([api("GET", API + "/tasks/" + ID), loadCan()]).then(function (r) {
      var d = r[0];
      if (d.error) { $("#title").textContent = "No such task"; $("#lede").textContent = d.error; endSkeleton(); return; }
      T = d; render(); loadEvidence(); loadOwnerCan();
    }).catch(function () { endSkeleton(); });
  }
  // What this reader may decide on this build, and why not, as the server would answer the POST — read for everyone (nobody signed in gets four noes and "sign in with GitHub"), never cached: GET /factory/tasks/:id/can is the caller's own answer, while the task itself is public and cached for all. Until it lands the four buttons say so, and when it cannot be read they say that — a grey with no reason is the one thing this page never draws.
  function noes(why) { return { approve: false, reject: false, build: false, withdraw: false, why: { approve: why, reject: why, build: why, withdraw: why } }; }
  var CAN = noes("reading what you may do here…");
  function loadCan() {
    return api("GET", API + "/tasks/" + ID + "/can").then(function (d) { CAN = d.can || noes(d.error || "could not read what you may do here — reload"); }).catch(function () { CAN = noes("could not read what you may do here — reload"); });
  }
  // Whether this reader may renew the request, and why not, is the registration's owner's rights on their own page (GET /users/<owner>/can, no-store: the block rides there, the same word the person's page greys Renew with); the owner as the shell knows them stands in until it lands. Read once, and only where Renew is drawn (a request not complete) for somebody signed in — nobody's answer is the sign-in, which the shell says by itself, and every read is a D1 bill.
  var OCAN = null;
  function loadOwnerCan() {
    var owner = ownerOf(); if (!T.request || T.request.complete || !owner || !WHO.me || OCAN) return;
    api("GET", "/api/v1/users/" + encodeURIComponent(owner) + "/can").then(function (d) { if (d.__status === 200 && d.can) { OCAN = d.can; renderChecklist(); } }).catch(function () {});
  }
  function ownerOf() { return (T.package || {}).owner || T.task.owner; }

  // ---- the head: what it is, in a line and five tiles
  function render() {
    var t = T.task, isBuild = t.kind === "build", project = isBuild && t.trust === "project", p = t.params || {};
    document.title = (isBuild ? t.name + " " + (t.version || "") + " · build #" + t.id : t.kind + " #" + t.id) + " · omarchy-pool";
    $("#crumb").textContent = (isBuild ? t.name + " " : t.kind + " ") + "#" + t.id;
    var sc = T.score;
    // The package's one address (the shell's pkgHref) with the ring this build is about (the shell's ringOfBuild): the most stable ring that serves the package — T.rings is the server's list — the lab for a staged build nobody decided yet, as Review and a person's builds link it, the shell's default for a build in no ring; the timeline's "the package →" is the same link.
    $("#title").innerHTML = isBuild ? '<a href="' + pkgHref(t.name, ringOfBuild(t.status, T.rings), t.arch) + '" title="the package, as Packages shows it — with where it came from">' + esc(t.name) + '</a> <span class="mono muted" style="font-size:.7em">' + esc(t.version || "") + '</span>' : esc(t.kind) + ' <span class="mono muted" style="font-size:.7em">#' + t.id + '</span>';
    $("#badges").innerHTML = pillHtml("none", t.arch) + taskPill(t.status) + (isBuild ? pillHtml(project ? "ok" : "lilac", project ? "the project" : "evidence", project ? "built by the project on a trusted worker, from a contributor's evidence" : "a contributor's build: evidence for a maintainer, never what users get") : "")
      + (isBuild && sc ? (sc.ready ? pillHtml("ok", "ready for a maintainer", "the contributor's half is complete: a build that passed the gate, audited") : t.status === "staged" || t.status === "leased" || t.status === "queued" ? pillHtml("warn", "not ready", "the contributor's half is not complete yet") : "") : "");
    // The worker as every table names it — the shell's wtId, its owner the shell's person — so the lede and the kv below read the same machine; a lease the record no longer lists is the bare id, whole, as the Pipeline and a person's builds draw it.
    var built = T.worker ? (T.worker.owner ? personLink(T.worker.owner) + "'s worker " : "worker ") + wtId(T.worker) : t.lease_owner ? "worker " + wtId(t.lease_owner) : esc(t.finished_at ? "a worker the record no longer names" : "no worker yet");
    // The approval as the server says it: standing (approved, not withdrawn) or taken back — the word rides the answer, the page derives nothing.
    var vet = t.result && t.result.vet, audit = T.audit[0], trial = T.trial[0], a = T.approval && T.approval.standing ? T.approval : null, wd = T.approval && T.approval.withdrawn_at ? T.approval : null;
    $("#lede").innerHTML = (isBuild
      ? (project ? 'The project built <b>' + esc(t.name) + '</b> ' + esc(t.version || '') + ' for ' + esc(t.arch) + (T.from ? ' from the evidence in <a href="/build/' + T.from.id + '">#' + T.from.id + '</a> (' + personLink(T.from.owner) + '\'s build)' : '') : personLink(t.owner) + ' built <b>' + esc(t.name) + '</b> ' + esc(t.version || '') + ' for ' + esc(t.arch) + ' on ' + built)
      : 'A pool job: <b>' + esc(t.kind) + '</b>' + (p && p.from ? ' ' + esc(p.from) + ' → ' + esc(p.to) : '') + ', on ' + built)
      + ' · ' + (t.status === "staged" ? (a ? 'decided' : wd ? 'the approval was withdrawn — waiting for another maintainer' : 'waiting for a maintainer') : t.status === "leased" ? 'building now' : t.status === "queued" ? 'queued' : t.status) + (t.finished_at ? ', ' + ago(t.finished_at) : '') + '.';
    if (isBuild) setTiles("#tiles", [
      ["Gate", vet ? (vet.verdict === "pass" ? "pass" : "fail") : "—", vet ? (vet.fails ? vet.fails + " failing" : (vet.warnings ? vet.warnings + " warning" + (vet.warnings === 1 ? "" : "s") : "clean")) : "built before the gate", vet ? (vet.verdict === "pass" ? "ok" : "bad") : ""],
      ["Audit", audit && audit.status === "done" && audit.result ? String(audit.result.verdict || "done") : audit ? audit.status : "—", audit && audit.result ? num((audit.result.findings || []).length) + " finding(s)" + (audit.result.model ? " · " + audit.result.model : "") : audit ? "the second agent" : project ? "audited on the contributor's build" : "no audit yet", audit && audit.result ? ({ ok: "ok", warn: "warn", block: "bad" }[audit.result.verdict] || "") : ""],
      ["Trial", trial && trial.status === "done" && trial.result ? (trial.result.verdict === "ok" ? "installs" : String(trial.result.verdict)) : trial ? trial.status : "—", trial ? "a real pacman, from the lab" : project ? "not tried yet" : "only the project's build is tried", trial && trial.result ? (trial.result.verdict === "ok" ? "ok" : "bad") : ""],
      ["Decision", a ? a.decision : wd ? "withdrawn" : (t.status === "staged" ? "waiting" : "—"), a ? "by " + a.by + " · " + ago(a.created_at) : wd ? "the approval by " + wd.by + " taken back by " + wd.withdrawn_by : t.status === "staged" ? "a maintainer, never the owner" : "nothing to decide", a ? (a.decision === "approved" ? "ok" : "bad") : wd ? "warn" : (t.status === "staged" ? "warn" : "")],
      ["Class", sc ? sc.class + ' <span class="dim" style="font-size:.5em">' + sc.points + '/' + sc.max + '</span>' : "—", sc ? (sc.class === sc.projected ? "with the maintainer's half green: the same" : "with the maintainer's half green: " + sc.projected) : "no chain", sc ? CLASS_CLS[sc.class] : ""],
      ["In the rings", T.rings.length ? T.rings.join(" · ") : "—", T.rings.length ? (T.rings.length === 1 && T.rings[0] === "lab" ? "the lab: not promised, not promoted" : "what users get") : "not in the pool", T.rings.length ? (T.rings.length === 1 && T.rings[0] === "lab" ? "warn" : "ok") : ""]
    ]); else setTiles("#tiles", [
      ["Status", t.status, t.error ? "failed: see the log" : t.finished_at ? "finished " + ago(t.finished_at) : "", t.status === "done" ? "ok" : t.status === "failed" ? "bad" : ""],
      ["Duration", dur(t.duration_ms) || "—", "wall time on the worker"],
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
    // The request the chain rests on, checked as the form checks it today; "Renew the request" is on it for everyone when a line is not green — live for the registration's owner (the package's, as the server names it; the task's owner is the same person on a contributor's build and nobody's on the project's) while a renewal is taken, grey with why otherwise: the state's word for the owner, the server's (can.request on the owner's page — a block included) for the role, the shell's guess at it until that lands.
    var pkgSt = (T.package || {}).status, owner = ownerOf();
    var own = OCAN ? OCAN.request === true : isOwner(owner), why = OCAN ? (OCAN.why.request || "") : orSignIn("only " + owner + " requests here");
    $("#ckreq").innerHTML = T.request ? requestBlock(T.request, own, T.task.name, !!T.request.renewable, T.request.busy ? "renew it once build #" + T.request.busy + " is done" : pkgSt === "approved" || pkgSt === "published" ? "in the pool as it was; new releases come as bumps, built from the approved recipe" : "renew it once nothing of it is being built", why) : "";
    $("#cklist").innerHTML = ckColumn(sc, "contributor", "The contributor's half", c.contributor ? personLink(c.contributor.owner) + (c.contributor.id !== T.task.id ? ' · build <a href="/build/' + c.contributor.id + '">#' + c.contributor.id + '</a>' : '') : 'nobody yet')
      + ckColumn(sc, "maintainer", "The maintainer's half", c.project ? 'the project\'s build <a href="/build/' + c.project.id + '">#' + c.project.id + '</a>' + (c.approval ? ' · decided by ' + personLink(c.approval.by) : c.withdrawn ? ' · the approval by ' + personLink(c.withdrawn.by) + ' was withdrawn' : ' · not decided') : 'not started' + (sc.ready ? ' — ready to begin' : ''));
  }

  // ---- the decision on this build, for everyone: the shell's Decision cell — Approve, Reject, Build by the project, Withdraw the approval where one stands — the same four buttons for every reader, live where the server's can says so and grey with its reason in the title otherwise (the dashboard's rule: never hidden, never a sentence in its place). The owner rule, the state of the chain and what is already done are the predicate's on the server, read through CAN, not a copy on the page; the click, the dialogs, the post and the toast are the shell's, and the page draws again once a decision landed. Beside the cell, what no button says: who approved and when; the project's build in flight, staged or failed; a chain whose contributor's half is not complete — a pill and a sentence, not a gate, since a rejection is the server's to allow on it. A pool job (sync, health, …) is nobody's to decide, so its row is empty for everyone.
  function renderActions() {
    var t = T.task, el = $("#acts"), a = T.approval;
    if (t.kind !== "build") { el.innerHTML = ""; return; }
    var standing = !!(a && a.standing), pb = T.project_builds[0], sc = T.score, beside = [];
    if (standing) beside.push('<span class="muted">Approved by ' + personLink(a.by) + ' ' + ago(a.created_at) + '.</span>');
    else if (t.status === "staged") {
      if (pb && (pb.status === "queued" || pb.status === "leased")) beside.push('<span class="muted">the project is building it (<a href="/build/' + pb.id + '">#' + pb.id + '</a>)</span>');
      else if (pb && pb.status === "staged") beside.push('<span class="muted">the project\'s build <a href="/build/' + pb.id + '">#' + pb.id + '</a> is what gets approved</span>');
      else if (pb && pb.status === "failed") beside.push(pillHtml("error", "project build #" + pb.id + " failed", pb.error || ""));
      if (sc && !sc.ready) beside.push(pillHtml("warn", "not ready") + ' <span class="muted">the contributor\'s half is not complete — nothing for a maintainer yet.</span>');
    }
    el.innerHTML = decisionCell({ id: t.id, name: t.name, version: t.version, arch: t.arch, can: CAN, approval: a }) + (beside.length ? " " + beside.join(" ") : "");
  }
  onDecided(function () { load(); });

  // ---- the timeline: every step with its time, in order
  function renderTimeline() {
    var t = T.task, p = t.params || {}, steps = [], isBuild = t.kind === "build";
    var add = function (cls, title, detail, at) { steps.push({ cls: cls, title: title, detail: detail, at: at }); };
    if (isBuild && T.package && T.package.request_id) add("ok", "Requested", personLink(T.package.owner) + ' asked for <b>' + esc(t.name) + '</b> — request #' + T.package.request_id + (T.package.project ? ' from <a href="' + esc(T.package.project) + '">' + esc(T.package.project.replace(/^https?:\/\/(www\.)?/, "")) + '</a>' : ''), T.package.created_at);
    if (T.from && p.review !== undefined) add("ok", "Evidence", personLink(T.from.owner) + '\'s build <a href="/build/' + T.from.id + '">#' + T.from.id + '</a> was staged; a maintainer asked the project to build it again', T.from.finished_at);
    if (T.from && p.task !== undefined) add("ok", "Of build", 'this ' + esc(t.kind) + ' is of build <a href="/build/' + T.from.id + '">#' + T.from.id + '</a> (' + esc(T.from.name || t.name) + ' ' + esc(T.from.version || '') + ')', T.from.finished_at);
    add("ok", "Queued", esc(t.reason || "") + (isBuild ? ' · recipe <span class="mono">' + esc(String(t.pkgbuild_ref || "")) + '</span>' : ''), t.created_at);
    if (t.started_at) add(t.status === "leased" ? "blue" : "ok", t.status === "leased" ? "Building" : "Started", (t.lease_owner ? 'on <span class="mono">' + esc(t.lease_owner) + '</span>' : 'on a worker the record no longer names') + ' · attempt ' + num(t.attempts) + ' of ' + num(t.max_attempts), t.started_at);
    if (t.finished_at) add(t.status === "failed" ? "error" : "ok", t.status === "failed" ? "Failed" : t.status === "staged" ? "Staged" : t.status === "cancelled" ? "Cancelled" : "Finished", (t.duration_ms ? 'after ' + dur(t.duration_ms) : '') + (t.error ? ' — ' + esc(t.error.slice(0, 200)) : '') + (t.status === "staged" ? ' · ' + esc(t.result_filename || "") + ' in the staging workspace' : ''), t.finished_at);
    var vet = t.result && t.result.vet;
    if (vet) add(vet.verdict === "pass" ? "ok" : "error", "The gate", vet.verdict === "pass" ? (vet.warnings ? vet.warnings + " warning(s): " + esc((vet.warned || []).join(", ")) : "every check passed") : "failed: " + esc((vet.failed || []).join(", ")), t.finished_at);
    T.audit.slice().reverse().forEach(function (a) { add(a.status === "done" ? ({ ok: "ok", warn: "warn", block: "error" }[a.result && a.result.verdict] || "ok") : a.status === "failed" ? "error" : "dim", "Audit " + (a.status === "done" ? (a.result && a.result.verdict || "done") : a.status), '<a href="/build/' + a.id + '">#' + a.id + '</a>' + (a.result && a.result.summary ? ' — ' + esc(a.result.summary) : a.error ? ' — ' + esc(a.error) : '') + (a.result && a.result.model ? ' · ' + esc(a.result.model) : ''), a.finished_at || a.started_at); });
    T.trial.slice().reverse().forEach(function (a) { add(a.status === "done" ? (a.result && a.result.verdict === "ok" ? "ok" : "error") : a.status === "failed" ? "error" : "dim", "Trial " + (a.status === "done" ? (a.result && a.result.verdict === "ok" ? "installs" : (a.result && a.result.verdict) || "done") : a.status), '<a href="/build/' + a.id + '">#' + a.id + '</a> — a real pacman, from the lab' + (a.error ? ' — ' + esc(a.error) : ''), a.finished_at || a.started_at); });
    T.project_builds.slice().reverse().forEach(function (b) { add(b.status === "staged" || b.status === "done" ? "ok" : b.status === "failed" ? "error" : "blue", "The project's build " + (b.status === "leased" ? "running" : b.status), '<a href="/build/' + b.id + '">#' + b.id + '</a>' + (b.error ? ' — ' + esc(b.error.slice(0, 160)) : ''), b.finished_at || b.started_at); });
    var a = T.approval;
    if (a) add(a.withdrawn_at ? "dim" : a.decision === "approved" ? "ok" : "error", a.decision === "approved" ? "Approved" : "Rejected", 'by ' + personLink(a.by) + (a.note ? ' — ' + esc(a.note) : '') + (a.rebuild_task && a.rebuild_task !== t.id ? ' · the project\'s build <a href="/build/' + a.rebuild_task + '">#' + a.rebuild_task + '</a> ' + esc(a.rebuild_status || '') : ''), a.created_at);
    if (a && a.withdrawn_at) add("warn", "Approval withdrawn", 'by ' + personLink(a.withdrawn_by) + ' — ' + esc(a.withdrawn_reason || '') + ' · the package left the rings; another maintainer decides', a.withdrawn_at);
    T.publish.slice().reverse().forEach(function (b) { add(b.status === "done" ? "ok" : b.status === "failed" ? "error" : "blue", "Published " + (b.status === "done" ? "" : b.status), '<a href="/build/' + b.id + '">#' + b.id + '</a> — into the pool, signed' + (b.error ? ' — ' + esc(b.error) : ''), b.finished_at || b.started_at); });
    if (T.rings.length) add("ok", "In the rings", T.rings.join(" · ") + ' — <a href="' + pkgHref(t.name, ringOfBuild(t.status, T.rings), t.arch) + '">the package →</a>', null);
    $("#timeline").innerHTML = steps.map(function (s) { return '<li><i class="dot ' + s.cls + '"></i><div><b>' + s.title + '</b> <span class="d">' + s.detail + '</span></div>' + (s.at ? when(s.at) : '<span class="when">now</span>') + '</li>'; }).join("");
  }

  // ---- the build: the worker, the recipe, the package, what it cost
  function renderBuild() {
    var t = T.task, w = T.worker, kv = [];
    var row = function (k, v) { if (v) kv.push('<dt>' + k + '</dt><dd>' + v + '</dd>'); };
    // The worker as every table names it — the shell's wtId (the id without the owner's prefix, the whole of it on hover) and wtVersion (the release its image is, and whether it is behind) — so a worker reads the same here as on the Workers page and a person's.
    row("Worker", w ? wtId(w) + (w.owner ? ' · ' + personLink(w.owner) : '') + (w.labels && w.labels.where ? ' · on ' + esc(w.labels.where) : '') + (w.trust === "project" ? ' · ' + pillHtml("ok", "project trust", w.trusted_by ? "trusted on the word of " + w.trusted_by : "") : ' · ' + pillHtml("lilac", "community")) + ' · ' + wtVersion(w) : (t.lease_owner ? '<span class="mono">' + esc(t.lease_owner) + '</span> <span class="muted">(gone)</span>' : '<span class="muted">none yet</span>'));
    if (w && w.agent) row("Agent", '<span class="mono">' + esc(w.agent) + '</span>');
    row("Recipe", t.kind === "build" ? '<span class="mono">' + esc(String(t.pkgbuild_ref || "")) + '</span>' : null);
    row("Attempts", num(t.attempts) + ' of ' + num(t.max_attempts) + (t.lease_expires_at ? ' · lease until ' + esc(t.lease_expires_at.slice(11, 16)) + ' UTC' : ''));
    row("Duration", t.duration_ms ? dur(t.duration_ms) : null);
    if (t.result_filename) row("Package", '<span class="mono">' + esc(t.result_filename) + '</span>' + (t.result_sha256 ? '<br><span class="mono dim" style="font-size:11.5px">' + esc(t.result_sha256) + '</span>' : ''));
    if (t.kind !== "build" && t.result) row("Result", '<pre style="white-space:pre-wrap;max-height:240px">' + esc(JSON.stringify(t.result, null, 1)) + '</pre>');
    if (t.kind === "build") row("Publish", t.publish === 0 ? 'no — evidence only' : t.trust === "project" ? 'on approval, by the pool' : '—');
    $("#build-kv").innerHTML = kv.join("");
  }
  function renderResources(r) {
    if (!r) return;
    $("#res-panel").hidden = false;
    $("#res").innerHTML = '<div><b>' + dur((r.wall_s || 0) * 1000) + '</b>wall</div><div><b>' + num(r.cpu_s || 0) + ' s</b>cpu' + (r.cores ? ' · ' + num(r.cores) + ' cores' : '') + '</div><div><b>' + num(r.ram_peak_mb || 0) + ' MB</b>ram peak</div><div><b>' + num(r.disk_mb || 0) + ' MB</b>disk</div>';
  }

  // ---- the evidence, read in place
  var TEXT = { "vet.json": "The gate", "audit.json": "The audit", "trial.log": "The trial", PKGBUILD: "The recipe", "build.log": "The build log", "tests.log": "The gate's transcript", PKGINFO: "The manifest", "audit.md": "The audit, as written", "resources.json": null };
  // The packages in staging: the evidence that is not public (the binaries the worker uploaded).
  function bins() { return (T.evidence || []).filter(function (e) { return !e.public; }); }
  function loadEvidence() {
    var ev = T.evidence || [], text = ev.filter(function (e) { return e.public; });
    if (!ev.length) { $("#evidence").innerHTML = '<p class="sub" style="margin:0">' + (T.task.kind === "build" ? 'Nothing staged for this build' + (T.task.log_tail ? ' — the log\'s tail the worker reported:</p><pre style="white-space:pre-wrap;margin-top:10px">' + esc(T.task.log_tail) + '</pre>' : '.</p>') : (T.task.log_tail ? 'The log\'s tail the worker reported:</p><pre style="white-space:pre-wrap;margin-top:10px">' + esc(T.task.log_tail) + '</pre>' : 'A pool job leaves its result on the task, not files.</p>')); return; }
    var order = ["vet.json", "audit.json", "trial.log", "PKGBUILD", "build.log", "tests.log", "PKGINFO", "audit.md"];
    text.sort(function (a, b) { return (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99); });
    var html = text.filter(function (e) { return e.name !== "resources.json" && e.name !== "audit.md"; }).map(function (e) {
      return '<details class="ev" id="ev-' + esc(e.name.replace(/[^a-z0-9]/gi, "-")) + '"' + (e.name === "vet.json" || e.name === "audit.json" ? " open" : "") + '><summary><b>' + esc(TEXT[e.name] || e.name) + '</b> <span class="mono dim">' + esc(e.name) + '</span> <span class="dim">' + bytes(e.size) + '</span> <a class="run" href="' + esc(e.url) + '" onclick="event.stopPropagation()">raw ↗</a></summary><div class="body"><div class="muted">loading…</div></div></details>';
    }).join("");
    if (bins().length) html += '<p class="sub" id="staging" style="margin-top:12px"></p>';
    $("#evidence").innerHTML = html; renderStaging();
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
  // The packages in staging (the binaries the worker uploaded), named for everyone and served to a maintainer's session alone — the publish job reads them with a token of its own. So the name is a link for a maintainer and the same link grey, with why, for anyone else (the dashboard's rule); drawn again once whoami says who is looking.
  function renderStaging() {
    var el = $("#staging"); if (!el) return;
    el.innerHTML = 'Packages in staging (for maintainers and the publish job): ' + bins().map(function (b) { return gate('<a class="mono" href="' + esc(b.url) + '">' + esc(b.name) + '</a>', isMaintainer(), orSignIn("packages in staging are for maintainers")) + ' <span class="dim">' + bytes(b.size) + '</span>'; }).join(" · ");
  }
  function renderEvidence(name, body) {
    if (name === "vet.json") {
      try {
        var v = JSON.parse(body);
        return '<table class="ev-table"><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>' + (v.checks || []).map(function (c) { return '<tr><td class="mono">' + esc(c.name) + '</td><td>' + pillHtml(c.status === "pass" ? "ok" : c.status === "warn" ? "warn" : "error", c.status) + '</td><td class="muted">' + esc(c.detail || "") + '</td></tr>'; }).join("") + '</tbody></table><p class="sub" style="margin:8px 0 0">Verdict: ' + pillHtml(v.verdict === "pass" ? "ok" : "error", v.verdict || "?") + ' · ' + num(v.fails || 0) + ' failing, ' + num(v.warnings || 0) + ' warning(s) · <a href="/docs/what-we-test">what each check means →</a></p>';
      } catch (x) { return '<pre style="white-space:pre-wrap">' + esc(body) + '</pre>'; }
    }
    if (name === "audit.json") {
      try {
        var a = JSON.parse(body), f = a.findings || [];
        return '<p style="margin:0 0 10px">' + pillHtml({ ok: "ok", warn: "warn", block: "error" }[a.verdict] || "none", a.verdict || "?") + ' ' + esc(a.summary || "") + (a.model ? ' <span class="dim">· ' + esc(a.model) + '</span>' : '') + (a.category ? ' <span class="dim">· category ' + esc(a.category) + '</span>' : '') + '</p>' +
          (f.length ? '<table class="ev-table"><thead><tr><th>Severity</th><th>Area</th><th>Where</th><th>What</th><th>Fix</th></tr></thead><tbody>' + f.map(function (x) { return '<tr><td>' + pillHtml(x.severity === "high" ? "error" : x.severity === "medium" ? "warn" : "none", x.severity || "") + '</td><td>' + esc(x.area || "") + '</td><td class="mono" style="font-size:11.5px">' + esc(x.where || "") + '</td><td>' + esc(x.what || "") + '</td><td class="muted">' + esc(x.fix || "") + '</td></tr>'; }).join("") + '</tbody></table>' : '<p class="sub" style="margin:0">No finding.</p>');
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
    path: `/build/${id}`,
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
 * What /build/<id> is made of. One read feeds nearly the whole page, GET
 * /api/v1/factory/tasks/<id>, so each part names the fields of it that it
 * draws; the evidence panels read one file each. The page is the project's
 * build (F.projectTask) — staged, audited, tried, approved — so the head,
 * the timeline, the chain and every evidence file have something to show;
 * the branches a contributor's build draws are read on F.contributorTask.
 * The decision block is drawn for every role from the task and the caller's
 * own GET /factory/tasks/<id>/can, so its reads ask that answer as nobody,
 * a contributor, the owner and a maintainer; its acts go where its buttons
 * post: the role gates on this build, where nobody but a maintainer gets
 * through and nothing changes; the decisions on the rows the fixture made
 * for deciding; the withdrawal last, because it is the one act that changes
 * what every manifest after this one finds — the approval is void from
 * there on.
 */
export const BUILD_COMPONENTS = (F: Fixture): Component[] => {
  const page = `/build/${F.projectTask}`;
  const task = `/api/v1/factory/tasks/${F.projectTask}`;
  const pkg = `${task}/artifacts/${F.factoryPkg}-1.0-1-${F.arch}.pkg.tar.zst`;
  return [
    {
      id: "build.crumbs",
      page,
      anchor: ['<a href="/review">Review</a>', 'id="crumb"'],
      script: ['"#crumb"', '"#" + t.id'],
      reads: [{ path: task, fields: ["task.kind", "task.name", "task.id"] }],
      visible: EVERYONE,
    },
    {
      // The package's link is the shell's one address, on the most stable ring the server lists for it.
      id: "build.title",
      page,
      anchor: ['id="title"'],
      script: ['"#title"', "document.title", "pkgHref(t.name, ringOfBuild(t.status, T.rings), t.arch)"],
      reads: [{ path: task, fields: ["task.kind", "task.name", "task.version", "task.id", "task.arch", "rings"] }],
      visible: EVERYONE,
    },
    {
      id: "build.badges",
      page,
      anchor: ['id="badges"'],
      script: ['"#badges"', "taskPill(t.status)", "sc.ready", '"ready for a maintainer"', '"not ready"'],
      reads: [{ path: task, fields: ["task.arch", "task.status", "task.kind", "task.trust", "score.ready"] }],
      visible: EVERYONE,
    },
    {
      // The worker is the shell's wtId, the people the shell's personLink — the role from the maintainer set the shell reads once per page.
      id: "build.lede",
      page,
      anchor: ['id="lede"'],
      script: ['"#lede"', "personLink(T.worker.owner)", "wtId(T.worker)", "wtId(t.lease_owner)", "T.from.owner", "T.approval.standing", "T.approval.withdrawn_at"],
      reads: [
        {
          path: task,
          fields: ["task.kind", "task.trust", "task.name", "task.version", "task.arch", "task.owner", "task.status", "task.finished_at", "task.lease_owner", "task.params", "worker.id", "worker.owner", "from.id", "from.owner", "approval.standing", "approval.withdrawn_at"],
        },
        { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      ],
      visible: EVERYONE,
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
      visible: EVERYONE,
    },
    {
      // The shell's Decision cell, for everyone: the four buttons drawn from the task and the caller's own `can`, live where the server would say yes and grey with its reason otherwise; the page draws again once a decision landed.
      id: "build.actions",
      page,
      anchor: ['id="acts"'],
      script: [
        '"#acts"', "decisionCell({ id: t.id, name: t.name, version: t.version, arch: t.arch, can: CAN, approval: a })", 'API + "/tasks/" + ID + "/can"', "onDecided(function () { load(); })", 'Promise.all([api("GET", API + "/tasks/" + ID), loadCan()])', 'noes("reading what you may do here…")', '"could not read what you may do here — reload"',
        'if (t.kind !== "build") { el.innerHTML = ""; return; }', "var standing = !!(a && a.standing)", "T.project_builds[0]", '"not ready"', "Approved by ",
      ],
      reads: [
        // The project's build: a standing approval draws "Withdraw the approval"; the project's build of a contributor's is what the note beside the cell names.
        { path: task, fields: ["task.id", "task.kind", "task.name", "task.version", "task.arch", "task.status", "task.trust", "approval.standing", "approval.by", "approval.created_at", "approval.withdrawn_at", "score.ready", "project_builds"] },
        { path: `/api/v1/factory/tasks/${F.contributorTask}`, fields: ["task.trust", "task.status", "score.ready", "project_builds.0.id", "project_builds.0.status", "project_builds.0.error"] },
        // What each reader may do on it, and why not — the caller's own answer, never cached: nobody gets four noes and the sign-in, a contributor and the owner "a maintainer decides", a maintainer the state of the chain (here: already approved, so Withdraw alone).
        { path: `${task}/can`, fields: ["task", "can.approve", "can.reject", "can.build", "can.withdraw", "can.why.approve", "can.why.reject", "can.why.build", "can.why.withdraw"] },
        { path: `${task}/can`, as: "contributor", fields: ["task", "can.approve", "can.reject", "can.build", "can.withdraw", "can.why.approve", "can.why.withdraw"] },
        { path: `${task}/can`, as: "owner", fields: ["task", "can.approve", "can.reject", "can.build", "can.withdraw", "can.why.approve", "can.why.withdraw"] },
        { path: `${task}/can`, as: "maintainer", fields: ["task", "can.approve", "can.reject", "can.build", "can.withdraw", "can.why.approve"] },
        { path: `/api/v1/factory/tasks/${F.stagedTask}/can`, as: "maintainer", fields: ["task", "can.approve", "can.reject", "can.build", "can.withdraw", "can.why"] },
        // The workers the "Build by the project" dialog offers are the shell's read (shell.decide), as the dialog is.
      ],
      acts: [
        { method: "POST", path: `${task}/approve`, body: { note: "reads well" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
        // The gates of a rejection on this build: nobody but a maintainer is let through, so it stays as it is.
        { method: "POST", path: `${task}/reject`, body: { note: "the source is not the upstream's" }, expect: { anonymous: 401, contributor: 403, owner: 403 } },
        // The rejection itself, on the row made for it; 409 once another page's manifest rejected it first.
        { method: "POST", path: `/api/v1/factory/tasks/${F.disposableTask}/reject`, body: { note: "the source is not the upstream's" }, expect: { maintainer: [200, 409] } },
        { method: "POST", path: `/api/v1/factory/tasks/${F.stagedTask}/build`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
        // The first withdraw in the walk takes the fixture's one approval back; the person's page asks again and gets 404.
        { method: "POST", path: `${task}/withdraw`, body: { note: "approved before the trial was read" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } },
      ],
      visible: EVERYONE,
    },
    {
      id: "build.who-section",
      page,
      anchor: ['id="who-section"', "two people behind every package the factory ships", 'href="/docs/what-we-test#the-score"'],
      script: ['$("#who-section")', "if (!sc) { el.hidden = true; return; }"],
      reads: [{ path: task, fields: ["score"] }],
      visible: EVERYONE,
    },
    {
      // Renew the request for everyone: live for the registration's owner while a renewal is taken, grey with the state's word for them and the server's for anyone else — the owner's rights on their own page, the same answer the person's page greys it with.
      id: "build.request-block",
      page,
      anchor: ['id="ckreq"'],
      script: ['"#ckreq"', "requestBlock(T.request", "function loadOwnerCan(", "T.request.complete || !owner || !WHO.me || OCAN", "OCAN.request === true", "OCAN.why.request", 'orSignIn("only " + owner + " requests here")', "T.request.renewable", "T.request.busy", 'pkgSt === "approved" || pkgSt === "published"'],
      reads: [
        {
          path: task,
          fields: ["request.id", "request.record", "request.signature", "request.version", "request.created_at", "request.complete", "request.checks", "request.checks.0.item", "request.checks.0.note", "request.checks.0.ok", "request.renewable", "request.busy", "package.status", "package.owner", "task.owner", "task.name"],
        },
        { path: `/api/v1/users/${F.owner}/can`, fields: ["login", "can.request", "can.why.request"] },
        { path: `/api/v1/users/${F.owner}/can`, as: "contributor", fields: ["login", "can.request", "can.why.request"] },
        { path: `/api/v1/users/${F.owner}/can`, as: "owner", fields: ["login", "can.request"] },
      ],
      visible: EVERYONE,
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
      visible: EVERYONE,
    },
    {
      id: "build.timeline",
      page,
      anchor: ['id="timeline"', 'class="tl"'],
      script: [
        '"#timeline"', "T.package.request_id", "p.review !== undefined", "p.task !== undefined", "t.pkgbuild_ref",
        "T.audit.slice().reverse()", "T.trial.slice().reverse()", "T.project_builds.slice().reverse()", "T.publish.slice().reverse()",
        "a.rebuild_task", "a.withdrawn_reason", "vet.warned", "vet.failed", "pkgHref(t.name, ringOfBuild(t.status, T.rings), t.arch)",
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
      visible: EVERYONE,
    },
    {
      id: "build.build-kv",
      page,
      anchor: ['id="build-kv"', 'class="kv"'],
      script: ['"#build-kv"', 'row("Worker"', "wtId(w)", "wtVersion(w)", 'row("Recipe"', 'row("Package"', 'row("Publish"', "w.trusted_by", "w.labels.where", "t.lease_expires_at", "t.result_sha256"],
      reads: [
        {
          path: task,
          fields: ["worker.id", "worker.owner", "worker.labels", "worker.trust", "worker.trusted_by", "worker.version", "worker.hostname", "worker.agent", "task.lease_owner", "task.kind", "task.pkgbuild_ref", "task.attempts", "task.max_attempts", "task.lease_expires_at", "task.duration_ms", "task.result_filename", "task.result_sha256", "task.result", "task.publish", "task.trust"],
        },
      ],
      visible: EVERYONE,
    },
    {
      id: "build.resources",
      page,
      anchor: ['id="res-panel"', 'id="res"', 'class="mini four"'],
      script: ['"#res-panel"', '"#res"', '"resources.json"', "r.wall_s", "r.cpu_s", "r.ram_peak_mb", "r.disk_mb"],
      reads: [{ path: `${task}/artifacts/resources.json`, json: false }],
      visible: EVERYONE,
    },
    {
      id: "build.evidence-list",
      page,
      anchor: ['id="evidence-section"', 'id="ev-note"', 'id="evidence"'],
      script: ['"#evidence"', "e.public", 'class="ev"', "raw ↗", "fetch(e.url)", '"audit.md"', "Nothing staged for this build", "T.task.log_tail"],
      reads: [{ path: task, fields: ["evidence", "evidence.0.name", "evidence.0.size", "evidence.0.uploaded_at", "evidence.0.url", "evidence.0.public", "task.kind", "task.log_tail"] }],
      visible: EVERYONE,
    },
    {
      // The packages the worker uploaded: named for everyone, a link for a maintainer and the same link grey with why for anyone else.
      id: "build.staging-packages",
      page,
      anchor: ['id="evidence"'],
      script: ["Packages in staging (for maintainers and the publish job)", 'id="staging"', "function renderStaging()", "!e.public", 'orSignIn("packages in staging are for maintainers")'],
      reads: [
        { path: task, fields: ["evidence.0.public", "evidence.0.name", "evidence.0.size", "evidence.0.url"] },
        // The package itself is named for everyone and served to a maintainer only.
        { path: pkg, status: 403, fields: ["error"] },
        { path: pkg, as: "owner", status: 403, fields: ["error"] },
        { path: pkg, as: "maintainer", json: false },
      ],
      visible: EVERYONE,
    },
    {
      id: "build.gate-table",
      page,
      anchor: ['id="evidence"'],
      script: ['name === "vet.json"', 'class="ev-table"', "v.checks", "c.status", "c.detail", "v.verdict", 'href="/docs/what-we-test"'],
      reads: [{ path: `${task}/artifacts/vet.json`, json: false }],
      visible: EVERYONE,
    },
    {
      id: "build.audit-table",
      page,
      anchor: ['id="evidence"'],
      script: ['name === "audit.json"', "a.findings", "a.summary", "a.model", "a.category", "x.severity", "x.where", "x.fix", "No finding."],
      reads: [{ path: `${task}/artifacts/audit.json`, json: false }],
      visible: EVERYONE,
    },
    {
      id: "build.recipe-code",
      page,
      anchor: ['id="evidence"'],
      script: ['name === "PKGBUILD"', 'class="code"', 'class="ln"'],
      reads: [{ path: `${task}/artifacts/PKGBUILD`, json: false }],
      visible: EVERYONE,
    },
    {
      id: "build.manifest-kv",
      page,
      anchor: ['id="evidence"'],
      script: ['name === "PKGINFO"', 'indexOf(" = ")', 'class="kv"'],
      reads: [{ path: `${task}/artifacts/PKGINFO`, json: false }],
      visible: EVERYONE,
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
      visible: EVERYONE,
    },
    {
      id: "build.json-link",
      page,
      anchor: ['id="json-link"', ">/api/v1/factory/tasks/…</a>"],
      script: ['"#json-link"', 'API + "/tasks/" + ID'],
      reads: [{ path: task, fields: ["task.id"] }],
      visible: EVERYONE,
    },
    {
      id: "build.not-found",
      page,
      anchor: ['id="title"', 'id="lede"'],
      script: ['"No such task"', "d.error", "endSkeleton()"],
      reads: [{ path: "/api/v1/factory/tasks/0", status: 404, fields: ["error"] }],
      visible: EVERYONE,
    },
  ];
};
