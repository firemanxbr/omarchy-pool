/**
 * Workers: every machine that builds for the pool, by kind — the project's
 * (the pool's own jobs: sync, render, promote, health, security, gc), the
 * review ones (the maintainers' side: trusted by a maintainer, they build
 * again what a maintainer asked for, publish what is approved and write
 * the audit) and the contributors' (their own packages, or whatever is
 * queued when shared). Each table says, per worker: the id whole (two
 * workers of one host share a name, never an id), its state in one word,
 * the release it runs, who keeps it, what its machine uses and what it
 * last did. Public, from /api/v1/factory and /api/v1/stats. Running one is
 * a chapter of the docs.
 */
import { page } from "./layout";
import { CHARTS } from "./charts";
import type { RunningVersion } from "../meta";

/** The icons the tables use instead of a word: a chip for the architecture (dashed when emulated), arrows for a shared worker, one person for an owner's own. */
const ICON = {
  native: '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="native"><rect x="4" y="4" width="8" height="8"/><path d="M6 1v3M10 1v3M6 12v3M10 12v3M1 6h3M1 10h3M12 6h3M12 10h3"/></svg>',
  emu: '<svg class="ic emu" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="emulated"><rect x="4" y="4" width="8" height="8" stroke-dasharray="2 1.5"/><path d="M6 1v3M10 1v3M6 12v3M10 12v3M1 6h3M1 10h3M12 6h3M12 10h3"/></svg>',
  shared: '<svg class="ic shared" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="shared"><path d="M2 5h10M9 2l3 3-3 3M14 11H4M7 8l-3 3 3 3"/></svg>',
  own: '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="own"><circle cx="8" cy="5" r="3"/><path d="M2 15c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>',
};

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Workers</p>
    <h1>Three kinds of worker, and whose they are</h1>
    <p class="lede">The project's take the pool's jobs. The review ones — trusted on two maintainers' word, never the owner's — build again what a maintainer asked for, and write the audit. A contributor's build their own packages, or whatever is queued when shared. Every worker by its id, its state in one word, and what its machine uses. <a href="/docs/workers">Run one →</a></p>
  </div>

  <div class="tiles four" id="tiles"></div>

  <div class="roles-grid" id="kinds"></div>

  <div class="charts" style="margin-top:16px">
    <div class="chart"><h3>Load per worker <span>24 h</span></h3><div class="sub">share of the last day each worker spent holding a lease — the tooltip has what it did</div><div id="c-perworker"></div></div>
    <div class="chart"><h3>Worker minutes <span>per day</span></h3><div class="sub">time the project's workers spent on pool jobs</div><div id="c-minutes"></div></div>
  </div>

  <section style="margin-top:44px">
    <div class="h2row"><h2>Every worker</h2><label class="dim" style="font-size:13px"><input type="checkbox" id="all-workers"> show workers not seen recently</label></div>
    <div class="panel" style="margin-top:12px"><h3>Project <span class="dim" style="font-size:12px;font-weight:400">the pool's own jobs — sync, render, promote, health, security, gc — on the host a maintainer keeps</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-project" class="wtable"><thead><tr><th>Worker</th><th>Status</th><th>Arch</th><th>Version</th><th>Maintainer</th><th title="what the machine uses: an average the worker keeps and reports with its claims">CPU · RAM · Disk</th><th>Done / failed</th><th>Last job</th></tr></thead><tbody></tbody></table></div></div>
    <div class="panel" style="margin-top:16px"><h3>Review <span class="dim" style="font-size:12px;font-weight:400">the maintainers' side: builds again, publishes, audits — the agent through a proxy that holds the key</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-review" class="wtable"><thead><tr><th>Worker</th><th>Status</th><th>Arch</th><th>Version</th><th>Maintainer</th><th>Agent</th><th title="what the machine uses: an average the worker keeps and reports with its claims">CPU · RAM · Disk</th><th>Done / failed</th><th>Last reviewed</th></tr></thead><tbody></tbody></table></div></div>
    <div class="panel" style="margin-top:16px"><h3>Contributors <span class="dim" style="font-size:12px;font-weight:400">their own machines: their packages, or whatever is queued when shared</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-community" class="wtable"><thead><tr><th>Worker</th><th>Status</th><th>Owner</th><th>Arch</th><th>Version</th><th title="shared: builds whatever is queued · own: the owner's packages only">Mode</th><th>Agent</th><th title="what the machine uses: an average the worker keeps and reports with its claims">CPU · RAM · Disk</th><th>Done / failed</th><th>Last build</th></tr></thead><tbody></tbody></table></div></div>
    <p class="dim" style="font-size:12px;margin:10px 0 0;display:flex;gap:6px 18px;flex-wrap:wrap;align-items:center"><span>${ICON.native} native</span><span>${ICON.emu} emulated</span><span>${ICON.shared} shared</span><span>${ICON.own} own packages</span><span><span class="pill ok">idle</span> waiting</span><span><span class="pill blue">building</span> a task in hand</span><span><span class="pill error">failed</span> its agent does not answer</span><span><span class="pill none">offline</span> not seen in ten minutes</span></p>
  </section>

  <div class="gate"><div><h3>Run one of your own</h3><p>The signed image, Docker Desktop or Podman, a token from your <a href="/factory">workspace</a>: it builds only your packages, with your agent, and your builds skip the queue. Share it, and it takes whatever is queued.</p></div><a class="btn ghost" href="/docs/workers">Run a worker →</a></div>
`;

const SCRIPT = String.raw`
__CHARTS__
  var FACTORY = null, STATS = null;
  skeletonTiles("#tiles", 4); skeletonRows("#w-project", 8, 2); skeletonRows("#w-review", 9, 2); skeletonRows("#w-community", 10, 2);
  var ICON = __ICON__;
  // The kind: project (pool jobs) and review are the project's, told apart by the role the worker reported (OMARCHY_WORKER_ROLE); everything else is a contributor's.
  function kindOf(w) { if (w.side !== "omarchy") return "community"; var r = w.labels && w.labels.role; return r === "review" ? "review" : "project"; }
  var COLOR = { project: "var(--green)", review: "var(--blue)", community: "var(--lilac)" };
  // The person who keeps the worker, as the dashboard draws people: two letters, the login on hover, the profile behind it.
  function person(l) { return l ? avatar(l) : '<span class="muted" title="a registration from before owners: the project\'s">—</span>'; }
  // The id, whole: two workers of one host share a name, never an id. Where it runs, what it declares and who vouched stay on hover.
  function wid(w) {
    var names = (w.trusted_by || "").split(",").map(function (n) { return n.trim(); }).filter(Boolean);
    var tip = [w.labels && w.labels.where ? "on " + w.labels.where : "", w.hostname && w.hostname !== "?" ? "host " + w.hostname : "", w.kinds && w.kinds.length ? "takes: " + w.kinds.join(", ") : "", names.length ? "trusted by " + names.join(", ") : w.trust_proposed_by ? "proposed for project trust by " + w.trust_proposed_by + ", awaiting a second maintainer's word" : ""].filter(Boolean).join(" · ");
    // Shown without the owner's prefix (the owner has a column) and never past 32 characters: whole segments go
    // from after the first, so the tail — role, arch, the random suffix that tells two apart — stays; the whole id is on hover and in the filter.
    var id = String(w.id || ""), shown = w.owner && id.indexOf(w.owner + "-") === 0 ? id.slice(w.owner.length + 1) : id, parts = shown.split("-");
    while (shown.length > 32 && parts.length > 3) { parts.splice(1, 1); shown = parts[0] + "-…-" + parts.slice(1).join("-"); }
    if (shown.length > 32) shown = shown.slice(0, 18) + "…" + shown.slice(-13);
    return '<span class="mono wid" title="' + esc([id, tip].filter(Boolean).join(" · ")) + '">' + esc(shown) + '</span>';
  }
  // The state, one word in its own column: building (a task in hand), failed (alive, but not ready for what it declares — its agent did not answer), idle, or offline (not seen in ten minutes, with how long; only with the box ticked). When it was last seen is on hover.
  function status(w) {
    var seen = "seen " + ago(w.last_seen);
    if (!w.alive) return '<span class="pill none" title="not seen in the last ten minutes">offline · ' + esc(ago(w.last_seen).replace(" ago", "")) + '</span>';
    if (w.current_task) return '<a class="pill blue" href="/build/' + w.current_task + '" title="task #' + w.current_task + ' · ' + esc(seen) + '">building</a>';
    if (!w.ready) return '<span class="pill error" title="' + esc((w.agent_error ? "its agent did not answer: " + w.agent_error : !w.agent ? "no agent: a contributor's builds and the audits need one that answers" : "not ready for the work it declares") + " · " + seen) + '">failed</span>';
    return '<span class="pill ok" title="' + esc("alive, nothing in hand · " + seen) + '">idle</span>';
  }
  // The release the worker runs (the image's tag); an older image says only "container".
  function version(w) { return w.version && w.version !== "container" ? '<span class="mono" title="the release this worker\'s image was built from">' + esc(w.version) + '</span>' : '<span class="muted" title="an image from before the version was reported">—</span>'; }
  function arch(w, icon) { return esc(w.arch) + (icon ? ' ' + (w.labels && w.labels.emulated ? ICON.emu.replace('aria-label', 'title="emulated: the other architecture, under qemu on this host" aria-label') : ICON.native.replace('aria-label', 'title="native" aria-label')) : ''); }
  function mode(w) { return w.mode === "shared" ? ICON.shared.replace('aria-label', 'title="shared: builds whatever is queued, anyone\'s" aria-label') : ICON.own.replace('aria-label', 'title="' + esc(w.packages && w.packages.length ? "own packages: " + w.packages.join(", ") : "the owner\'s packages only") + '" aria-label'); }
  // The agent, and whether it answers: the dot is the last probe (green answered, red did not, grey never asked), the chip the provider, then the model — the label says who really answers, through a proxy too.
  var PROV = { anthropic: "A", "claude-code": "CC", openai: "OA", gemini: "G", xai: "X" };
  function agent(w) {
    if (!w.agent) return '<span class="muted">—</span>';
    var i = w.agent.indexOf("/"), prov = i > 0 ? w.agent.slice(0, i) : "", model = i > 0 ? w.agent.slice(i + 1) : w.agent;
    var st = w.agent_status === "ok" ? "ok" : w.agent_status === "error" ? "error" : "";
    var tip = w.agent + (st === "ok" ? " · answered " + ago(w.agent_checked_at) : st === "error" ? " · no answer " + ago(w.agent_checked_at) + (w.agent_error ? ": " + w.agent_error : "") : " · not probed yet");
    return '<span class="agent" title="' + esc(tip) + '"><i class="dot ' + st + '"></i><span class="prov">' + esc(PROV[prov] || prov.slice(0, 2).toUpperCase() || "?") + '</span><span class="mono">' + esc(model.replace(/^claude-/, "")) + '</span></span>';
  }
  // What the machine uses: three meters, the worker's own average (with the claim), amber past 70, red past 90.
  function usage(w) {
    var u = w.usage; if (!u) return '<span class="muted" title="not reported yet: an image from before usage was reported, or its first minute">—</span>';
    var tip = "average of the last " + (u.minutes || "?") + " min, reported " + ago(w.usage_at) + " · cpu " + u.cpu + "%" + (u.cores ? " of " + u.cores + " cores" : "") + " · ram " + u.ram + "%" + (u.ram_gb ? " of " + u.ram_gb + " GB" : "") + " · disk " + u.disk + "%" + (u.disk_gb ? " of " + u.disk_gb + " GB" : "");
    return '<span class="usage" title="' + esc(tip) + '">' + [u.cpu, u.ram, u.disk].map(function (v) { v = Math.round(Number(v) || 0); return '<span class="u1' + (v >= 90 ? " hot" : v >= 70 ? " warn" : "") + '" style="--v:' + v + '%"><b class="num">' + v + '</b><i></i></span>'; }).join("") + '</span>';
  }
  // The last task the worker finished — a package (linked, with its version) or a pool job by name — and how it ended.
  function last(w) {
    var l = w.last_task; if (!l) return '<span class="muted" title="nothing finished since the pool started keeping this">—</span>';
    var tip = "task #" + l.id + " · " + l.kind + " " + (l.status === "failed" ? "failed" : l.status) + " " + ago(l.at);
    var pkg = l.kind === "build" || l.kind === "audit" || l.kind === "publish" || l.kind === "trial";
    return '<span class="last" title="' + esc(tip) + '"><i class="dot ' + (l.status === "failed" ? "error" : "ok") + '"></i>' + (pkg ? '<a href="/build/' + l.id + '">' + esc(l.name) + '</a>' + (l.version ? ' <span class="v mono">' + esc(l.version) + '</span>' : '') : '<a class="mono" href="/build/' + l.id + '">' + esc(l.name) + '</a> <span class="v">' + ago(l.at) + '</span>') + '</span>';
  }
  // What each kind finished per day over the last week, from the stats series: the pool's jobs are the
  // project's (jobs_daily, by kind), the project's builds with the publishes and audits are the review side's,
  // a contributor's builds are theirs (builds_daily, by trust). Only finished tasks count: done or staged, and failed.
  var POOL_KINDS = { sync: 1, render: 1, promote: 1, rollback: 1, health: 1, security: 1, enqueue: 1, gc: 1, verify: 1, relayout: 1, metrics: 1, trial: 1 };
  function perDay() {
    var days = lastDays(7), zero = function () { var o = {}; days.forEach(function (d) { o[d] = { done: 0, failed: 0 }; }); return o; };
    var P = { project: zero(), review: zero(), community: zero() }, S = (STATS && STATS.series) || {};
    var add = function (k, day, status, n) { var o = P[k][day]; if (!o) return; if (status === "failed") o.failed += n; else if (status === "done" || status === "staged") o.done += n; };
    (S.jobs_daily || []).forEach(function (r) { add(POOL_KINDS[r.kind] ? "project" : "review", r.day, r.status, Number(r.n || 0)); });
    (S.builds_daily || []).forEach(function (r) { add(r.trust === "community" ? "community" : "review", r.day, r.status, Number(r.n || 0)); });
    return { days: days, P: P };
  }
  // The load: what each worker did in the last day, from the stats series (finished tasks by duration, a running one by its start).
  function loadOf() { var L = {}; ((STATS && STATS.series && STATS.series.workers_daily) || []).forEach(function (r) { L[r.worker] = { ms: Number(r.ms || 0) + Number(r.running_ms || 0), done: Number(r.done || 0) }; }); return L; }
  function render() {
    var d = FACTORY; if (!d) return;
    var showAll = $("#all-workers").checked, LOAD = loadOf();
    var busyOf = function (w) { var l = LOAD[w.id]; return l ? Math.min(100, Math.round(100 * l.ms / 86400000)) : 0; };
    var kinds = { project: [], review: [], community: [] };
    d.workers.forEach(function (w) { kinds[kindOf(w)].push(w); });
    var al = d.workers.filter(function (w) { return w.alive; }), bz = al.filter(function (w) { return w.current_task; });
    var m = STATS && STATS.metrics, a = m && (m.jobs || m.actions);
    var load = al.length ? Math.round(al.reduce(function (n, w) { return n + busyOf(w); }, 0) / al.length) : 0;
    setTiles("#tiles", [
      ["Alive", num(al.length) + " / " + num(d.workers.length), num(kinds.project.filter(function (w) { return w.alive; }).length) + " project · " + num(kinds.review.filter(function (w) { return w.alive; }).length) + " review · " + num(kinds.community.filter(function (w) { return w.alive; }).length) + " contributors", al.length ? "ok" : "warn"],
      ["Building now", num(bz.length), bz.length ? bz.map(function (w) { return "#" + w.current_task; }).join(" · ") : "every worker idle"],
      ["Load · 24 h", load + "%", "of the last day with a lease, across the alive ones"],
      ["Worker minutes · 7 d", a ? num(a.minutes) : "—", a ? "≈ " + num(Math.round(a.minutes / 7)) + " per day, the project's workers" : "no metrics snapshot yet"]
    ]);
    // One card per kind: one line on what it is for, the tasks it finished per day over a week (the Pool page's growth line, in the kind's colour), four numbers.
    var PD = perDay(), CH = { project: C.green, review: C.blue, community: C.lilac };
    var card = function (cls, name, ws, blurb) {
      var alv = ws.filter(function (w) { return w.alive; }), busyW = alv.filter(function (w) { return w.current_task; });
      var busy = alv.length ? Math.round(alv.reduce(function (n, w) { return n + busyOf(w); }, 0) / alv.length) : 0;
      var pd = PD.P[cls], pts = PD.days.map(function (d) { return { t: Date.parse(d), v: pd[d].done + pd[d].failed }; });
      var done7 = PD.days.reduce(function (n, d) { return n + pd[d].done; }, 0), failed7 = PD.days.reduce(function (n, d) { return n + pd[d].failed; }, 0);
      return '<div class="role k-' + (cls === "community" ? "contrib" : cls) + '"><h3>' + name + '<span>' + num(ws.length) + (ws.length === 1 ? " worker" : " workers") + '</span></h3><p>' + blurb + '</p>' +
        '<div class="kchart" data-tip="' + esc(name + ": tasks finished per day, the last seven days · " + num(done7) + " done, " + num(failed7) + " failed") + '">' + (STATS ? area(pts, num, 96, CH[cls]) : '<div class="empty loading">Loading</div>') + '</div>' +
        '<div class="mini four"><div><b>' + num(alv.length) + ' of ' + num(ws.length) + '</b>alive</div><div data-tip="' + esc(busy + "% of the last day with a lease, across " + alv.length + " alive worker(s) · " + busyW.length + " building now") + '"><b>' + busy + '%</b>busy 24h</div><div><b>' + num(done7) + '</b>done 7d</div><div><b>' + num(failed7) + '</b>failed 7d</div></div></div>';
    };
    $("#kinds").innerHTML =
      card("project", "Project", kinds.project, "The pool's own jobs, on the host a maintainer keeps.") +
      card("review", "Review", kinds.review, "Rebuilds, publishes and audits, on two maintainers' word.") +
      card("community", "Contributors", kinds.community, "Their machines: their packages, or whatever is queued when shared.");
    // The load per worker, the busiest first.
    var ranked = d.workers.filter(function (w) { return w.alive || LOAD[w.id]; }).sort(function (a, b) { return busyOf(b) - busyOf(a); }).slice(0, 10);
    $("#c-perworker").innerHTML = ranked.length ? '<div class="hrows">' + ranked.map(function (w) { var k = kindOf(w), l = LOAD[w.id] || { ms: 0, done: 0 }; return '<div class="hrow" style="grid-template-columns:150px 1fr 56px"><div class="l">' + workerName(w) + ' <small>' + (k === "community" ? (w.mode === "shared" ? "shared" : "own") : k) + ' · ' + esc(w.arch) + '</small></div><div class="bar" data-tip="' + esc(w.id + ": " + busyOf(w) + "% of the last day with a lease · " + num(l.done) + " task(s) finished, " + Math.round(l.ms / 60000) + " min" + (w.current_task ? " · building #" + w.current_task + " now" : "") + " · " + num(w.builds_done) + " done / " + num(w.builds_failed) + " failed all time") + '"><i style="width:' + busyOf(w) + '%;background:' + COLOR[k] + '"></i></div><div class="p num">' + busyOf(w) + '%</div></div>'; }).join("") + '</div><div class="legend"><span><i style="background:var(--green)"></i>project</span><span><i style="background:var(--blue)"></i>review</span><span><i style="background:var(--lilac)"></i>contributors</span></div>' : '<div class="empty">no worker alive, nothing leased in the last day</div>';
    // The three tables.
    var seen = function (ws) { return ws.filter(function (w) { return showAll || w.alive; }); };
    var counts = function (w) { return num(w.builds_done) + ' / ' + num(w.builds_failed); };
    var text = function (w) { return [w.id, w.owner, w.arch, w.version, w.mode, w.agent, w.trusted_by, w.last_task && w.last_task.name, JSON.stringify(w.labels || {})].join(" "); };
    pager("#w-project", seen(kinds.project), function (w) {
      return '<tr><td>' + wid(w) + '</td><td>' + status(w) + '</td><td>' + arch(w, false) + '</td><td>' + version(w) + '</td><td>' + person(w.owner) + '</td><td>' + usage(w) + '</td><td>' + counts(w) + '</td><td>' + last(w) + '</td></tr>';
    }, { empty: showAll ? "no project worker registered" : "no project worker alive — the host is off; pool jobs wait", text: text });
    pager("#w-review", seen(kinds.review), function (w) {
      return '<tr><td>' + wid(w) + '</td><td>' + status(w) + '</td><td>' + arch(w, true) + '</td><td>' + version(w) + '</td><td>' + person(w.owner) + '</td><td>' + agent(w) + '</td><td>' + usage(w) + '</td><td>' + counts(w) + '</td><td>' + last(w) + '</td></tr>';
    }, { empty: showAll ? "no review worker registered" : "no review worker alive — the project's builds and the audits wait", text: text });
    pager("#w-community", seen(kinds.community), function (w) {
      return '<tr><td>' + wid(w) + '</td><td>' + status(w) + '</td><td>' + person(w.owner) + '</td><td>' + arch(w, true) + '</td><td>' + version(w) + '</td><td>' + mode(w) + '</td><td>' + agent(w) + '</td><td>' + usage(w) + '</td><td>' + counts(w) + '</td><td>' + last(w) + '</td></tr>';
    }, { empty: showAll ? "no contributor's worker registered yet" : "no contributor's worker alive right now", text: text });
    endSkeleton();
  }
  // Worker minutes per day, from the jobs series.
  function renderMinutes(d) {
    var days7 = lastDays(7), minutes = {};
    ((d.series || {}).jobs_daily || []).forEach(function (r) { minutes[r.day] = (minutes[r.day] || 0) + Number(r.ms || 0) / 60000; });
    $("#c-minutes").innerHTML = stacked(days7, [{ name: "minutes", color: C.blue, values: days7.map(function (x) { return Math.round(minutes[x] || 0); }) }], { label: "Worker minutes per day over seven days", empty: "no job yet" });
  }
  function load() { busy(fetch("/api/v1/factory?limit=10")).then(function (r) { return r.json(); }).then(function (d) { FACTORY = d; render(); }).catch(function () { endSkeleton(); }); }
  $("#all-workers").onchange = render;
  load(); setInterval(load, 20000);
  liveStats(function (d) { STATS = d; renderMinutes(d); render(); }, 60000);
`;

export function workersHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Workers · omarchy-pool",
    description: "Every worker building for the pool, by kind — the project's, the review ones two maintainers vouched for, the contributors' — alive or gone, how busy, what it built.",
    active: "none",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS).replace("__ICON__", JSON.stringify(ICON)),
    poolUrl,
    version,
  });
}
