/**
 * Workers: every machine that builds for the pool, by kind — the project's
 * (the pool's own jobs: sync, render, promote, health, security, gc), the
 * review ones (the maintainers' side: trusted by a maintainer, they build
 * again what a maintainer asked for, publish what is approved and write
 * the audit) and the contributors' (their own packages, or whatever is
 * queued when shared). Public, from /api/v1/factory and /api/v1/stats.
 * Running one is a chapter of the docs.
 */
import { page } from "./layout";
import { CHARTS } from "./charts";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Workers</p>
    <h1>Three kinds of worker, and whose they are</h1>
    <p class="lede">The project's take the pool's jobs. The review ones — trusted on two maintainers' word, never the owner's — build again what a maintainer asked for, and write the audit. A contributor's build their own packages, or whatever is queued when shared. <em>Alive</em> is seen in the last ten minutes. <a href="/docs/workers">Run one →</a></p>
  </div>

  <div class="tiles four" id="tiles"></div>

  <div class="roles-grid" id="kinds"></div>

  <div class="charts" style="margin-top:16px">
    <div class="chart"><h3>Load per worker <span>24 h</span></h3><div class="sub">share of the last day each worker spent holding a lease — the tooltip has what it did</div><div id="c-perworker"></div></div>
    <div class="chart"><h3>Worker minutes <span>per day</span></h3><div class="sub">time the project's workers spent on pool jobs</div><div id="c-minutes"></div></div>
  </div>

  <section style="margin-top:44px">
    <div class="h2row"><h2>Every worker</h2><label class="dim" style="font-size:13px"><input type="checkbox" id="all-workers"> show workers not seen recently</label></div>
    <div class="panel" style="margin-top:12px"><h3>Project <span class="dim" style="font-size:12px;font-weight:400">the pool's own jobs, on the host the community keeps</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-project"><thead><tr><th>Worker</th><th>Arch</th><th>Where</th><th>Jobs</th><th>Trusted by</th><th>Running</th><th>Done / failed</th><th>Last seen</th></tr></thead><tbody></tbody></table></div></div>
    <div class="panel" style="margin-top:16px"><h3>Review <span class="dim" style="font-size:12px;font-weight:400">the maintainers' side: builds again, publishes, audits — with the agent key</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-review"><thead><tr><th>Worker</th><th>Arch</th><th>Where</th><th>Agent</th><th>Trusted by</th><th>Building</th><th>Done / failed</th><th>Last seen</th></tr></thead><tbody></tbody></table></div></div>
    <div class="panel" style="margin-top:16px"><h3>Contributors' <span class="dim" style="font-size:12px;font-weight:400">their own machines: their packages, or whatever is queued when shared</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-community"><thead><tr><th>Worker</th><th>Owner</th><th>Arch</th><th>Builds</th><th>Agent</th><th>Building</th><th>Done / failed</th><th>Last seen</th></tr></thead><tbody></tbody></table></div></div>
  </section>

  <div class="gate"><div><h3>Run one of your own</h3><p>The signed image, Docker Desktop or Podman, a token from your <a href="/factory">workspace</a>: it builds only your packages, with your agent, and your builds skip the queue. Share it, and it takes whatever is queued.</p></div><a class="btn ghost" href="/docs/workers">Run a worker →</a></div>
`;

const SCRIPT = String.raw`
__CHARTS__
  var FACTORY = null, STATS = null;
  skeletonTiles("#tiles", 4); skeletonRows("#w-project", 8, 2); skeletonRows("#w-review", 8, 2); skeletonRows("#w-community", 8, 2);
  // The kind: project (pool jobs) and review are the project's, told apart by the role the worker reported (OMARCHY_WORKER_ROLE); everything else is a contributor's.
  function kindOf(w) { if (w.side !== "omarchy") return "community"; var r = w.labels && w.labels.role; return r === "review" ? "review" : "project"; }
  var COLOR = { project: "var(--green)", review: "var(--blue)", community: "var(--lilac)" };
  function person(l) { return l ? '<a href="/user/' + encodeURIComponent(l) + '">' + esc(l) + '</a>' : '<span class="muted">—</span>'; }
  // Who vouched: two maintainers since the two-word rule ("m1, m2"), one before it; a proposal awaiting its second word.
  function trustedBy(w) {
    if (w.trust !== "project") return w.trust_proposed_by ? person(w.trust_proposed_by) + ' <span class="pill none" title="proposed for project trust; a second maintainer — not the owner — confirms">awaits a second word</span>' : '<span class="muted">—</span>';
    var names = (w.trusted_by || "").split(",").map(function (n) { return n.trim(); }).filter(Boolean);
    if (!names.length) return '<span class="muted">—</span>';
    return names.map(person).join(", ") + (names.length < 2 ? ' <span class="pill none" title="trusted by one maintainer, before trust took two words">one word</span>' : "");
  }
  function running(w) { return w.current_task ? '<a class="run" href="/pipeline">#' + w.current_task + '</a>' : '<span class="muted">idle</span>'; }
  function where(w) { return esc(w.labels && w.labels.where ? w.labels.where : (w.hostname || "—")) + (w.version ? ' <span class="muted">pkg-repo ' + esc(w.version) + '</span>' : '') + (w.labels && w.labels.emulated ? ' <span class="pill none" title="the other architecture, emulated on this host">emulated</span>' : ''); }
  function alive(w) { return workerName(w) + (w.alive ? ' <span class="pill ok">alive</span>' : ''); }
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
      ["Alive", num(al.length) + " / " + num(d.workers.length), num(kinds.project.filter(function (w) { return w.alive; }).length) + " project · " + num(kinds.review.filter(function (w) { return w.alive; }).length) + " review · " + num(kinds.community.filter(function (w) { return w.alive; }).length) + " contributors'", al.length ? "ok" : "warn"],
      ["Building now", num(bz.length), bz.length ? bz.map(function (w) { return "#" + w.current_task; }).join(" · ") : "every worker idle"],
      ["Load · 24 h", load + "%", "of the last day with a lease, across the alive ones"],
      ["Worker minutes · 7 d", a ? num(a.minutes) : "—", a ? "≈ " + num(Math.round(a.minutes / 7)) + " per day, the project's workers" : "no metrics snapshot yet"]
    ]);
    // One card per kind: what it is for, how busy, how many.
    var sum = function (ws, k) { return ws.reduce(function (n, w) { return n + Number(w[k] || 0); }, 0); };
    var card = function (cls, name, ws, blurb, extra) {
      var alv = ws.filter(function (w) { return w.alive; }), busyW = alv.filter(function (w) { return w.current_task; });
      var busy = alv.length ? Math.round(alv.reduce(function (n, w) { return n + busyOf(w); }, 0) / alv.length) : 0;
      return '<div class="role k-' + (cls === "community" ? "contrib" : cls) + '"><h3>' + name + '<span>' + num(ws.length) + (ws.length === 1 ? " worker" : " workers") + '</span></h3><p>' + blurb + '</p><div class="u"><span class="dim">busy · 24 h</span><div class="bar" style="height:10px;background:var(--panel-2);border:1px solid var(--line);position:relative;display:block" data-tip="' + esc(name + ": " + busy + "% of the last day with a lease, across " + alv.length + " alive worker(s) · " + busyW.length + " building now") + '"><i style="position:absolute;left:0;top:0;bottom:0;width:' + busy + '%;background:' + COLOR[cls] + '"></i></div><b class="num">' + busy + '%</b></div>' +
        '<dl class="kv"><dt>alive</dt><dd>' + num(alv.length) + ' of ' + num(ws.length) + '</dd><dt>done · failed</dt><dd>' + num(sum(ws, "builds_done")) + ' · ' + num(sum(ws, "builds_failed")) + '</dd><dt>x86_64 · aarch64</dt><dd>' + num(alv.filter(function (w) { return w.arch === "x86_64"; }).length) + ' · ' + num(alv.filter(function (w) { return w.arch === "aarch64"; }).length) + '</dd>' + extra(ws) + '</dl></div>';
    };
    $("#kinds").innerHTML =
      card("project", "Project", kinds.project, "The pool's own jobs — sync, render, promote, health, security, gc — on the host the community keeps. No package of anyone's is built here.", function (ws) { return '<dt>with an agent</dt><dd>' + num(ws.filter(function (w) { return w.agent; }).length) + '</dd>'; }) +
      card("review", "Review", kinds.review, "The maintainers' side. Trusted on two maintainers' word: builds again what a maintainer asked for, publishes what is approved, writes the audit. Holds the agent key.", function (ws) { return '<dt>with an agent</dt><dd>' + num(ws.filter(function (w) { return w.agent; }).length) + '</dd>'; }) +
      card("community", "Contributors'", kinds.community, "Their own machines, their own agent: their packages only — or, shared, whatever is queued. Evidence for a maintainer, never what users get.", function (ws) { return '<dt>shared · own</dt><dd>' + num(ws.filter(function (w) { return w.mode === "shared"; }).length) + ' · ' + num(ws.filter(function (w) { return w.mode !== "shared"; }).length) + '</dd>'; });
    // The load per worker, the busiest first.
    var ranked = d.workers.filter(function (w) { return w.alive || LOAD[w.id]; }).sort(function (a, b) { return busyOf(b) - busyOf(a); }).slice(0, 10);
    $("#c-perworker").innerHTML = ranked.length ? '<div class="hrows">' + ranked.map(function (w) { var k = kindOf(w), l = LOAD[w.id] || { ms: 0, done: 0 }; return '<div class="hrow" style="grid-template-columns:150px 1fr 56px"><div class="l">' + workerName(w) + ' <small>' + (k === "community" ? (w.mode === "shared" ? "shared" : "own") : k) + ' · ' + esc(w.arch) + '</small></div><div class="bar" data-tip="' + esc(w.id + ": " + busyOf(w) + "% of the last day with a lease · " + num(l.done) + " task(s) finished, " + Math.round(l.ms / 60000) + " min" + (w.current_task ? " · building #" + w.current_task + " now" : "") + " · " + num(w.builds_done) + " done / " + num(w.builds_failed) + " failed all time") + '"><i style="width:' + busyOf(w) + '%;background:' + COLOR[k] + '"></i></div><div class="p num">' + busyOf(w) + '%</div></div>'; }).join("") + '</div><div class="legend"><span><i style="background:var(--green)"></i>project</span><span><i style="background:var(--blue)"></i>review</span><span><i style="background:var(--lilac)"></i>contributors\'</span></div>' : '<div class="empty">no worker alive, nothing leased in the last day</div>';
    // The three tables.
    var seen = function (ws) { return ws.filter(function (w) { return showAll || w.alive; }); };
    pager("#w-project", seen(kinds.project), function (w) {
      return '<tr><td>' + alive(w) + '</td><td>' + esc(w.arch) + '</td><td>' + where(w) + '</td><td class="muted">' + esc((w.kinds || []).join(", ") || "—") + '</td><td>' + trustedBy(w) + '</td><td>' + running(w) + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td><td class="when">' + ago(w.last_seen) + '</td></tr>';
    }, { empty: showAll ? "no project worker registered" : "no project worker alive — the host is off; pool jobs wait", text: function (w) { return w.id + " " + w.arch + " " + (w.trusted_by || "") + " " + JSON.stringify(w.labels || {}); } });
    pager("#w-review", seen(kinds.review), function (w) {
      return '<tr><td>' + alive(w) + '</td><td>' + esc(w.arch) + '</td><td>' + where(w) + '</td><td>' + agentCell(w) + '</td><td>' + trustedBy(w) + '</td><td>' + running(w) + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td><td class="when">' + ago(w.last_seen) + '</td></tr>';
    }, { empty: showAll ? "no review worker registered" : "no review worker alive — the project's builds and the audits wait", text: function (w) { return w.id + " " + w.arch + " " + (w.trusted_by || "") + " " + (w.agent || ""); } });
    pager("#w-community", seen(kinds.community), function (w) {
      var what = w.mode === "shared" ? '<span class="pill lilac">shared</span> <span class="muted">whatever is queued</span>' : (w.packages && w.packages.length ? '<span class="muted">' + esc(w.packages.join(", ")) + '</span>' : '<span class="muted">own packages</span>');
      return '<tr><td>' + alive(w) + '</td><td>' + person(w.owner) + '</td><td>' + esc(w.arch) + '</td><td>' + what + '</td><td>' + agentCell(w) + '</td><td>' + running(w) + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td><td class="when">' + ago(w.last_seen) + '</td></tr>';
    }, { empty: showAll ? "no contributor's worker registered yet" : "no contributor's worker alive right now", text: function (w) { return w.id + " " + (w.owner || "") + " " + w.arch + " " + w.mode; } });
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
    description: "Every worker building for the pool, by kind — the project's, the review ones a maintainer trusts, the contributors' — alive or gone, how busy, what it built.",
    active: "none",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}
