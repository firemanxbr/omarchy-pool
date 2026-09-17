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
import type { Component, Fixture } from "./components";
import { CHARTS } from "./charts";
import type { RunningVersion } from "../meta";

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
      <div class="table-wrap" style="border:0"><table id="w-project" class="wtable"><thead><tr></tr></thead><tbody></tbody></table></div></div>
    <div class="panel" style="margin-top:16px"><h3>Review <span class="dim" style="font-size:12px;font-weight:400">the maintainers' side: builds again, publishes, audits — the agent through a proxy that holds the key</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-review" class="wtable"><thead><tr></tr></thead><tbody></tbody></table></div></div>
    <div class="panel" style="margin-top:16px"><h3>Contributors <span class="dim" style="font-size:12px;font-weight:400">their own machines: their packages, or whatever is queued when shared</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-community" class="wtable"><thead><tr></tr></thead><tbody></tbody></table></div></div>
    <div id="wt-legend"></div>
  </section>

  <div class="gate"><div><h3>Run one of your own</h3><p>The signed image, Docker Desktop or Podman, a token from your <a href="/factory">workspace</a>: it builds only your packages, with your agent, and your builds skip the queue. Share it, and it takes whatever is queued.</p></div><a class="btn ghost" href="/docs/workers">Run a worker →</a></div>
`;

const SCRIPT = String.raw`
__CHARTS__
  var FACTORY = null, STATS = null;
  skeletonTiles("#tiles", 4); skeletonRows("#w-project", 8, 2); skeletonRows("#w-review", 9, 2); skeletonRows("#w-community", 10, 2);
  $("#w-project thead tr").innerHTML = WT_HEAD.project; $("#w-review thead tr").innerHTML = WT_HEAD.review; $("#w-community thead tr").innerHTML = WT_HEAD.community; $("#wt-legend").innerHTML = WT_LEGEND;
  function kindOf(w) { return wtKind(w); }
  var COLOR = { project: "var(--green)", review: "var(--blue)", community: "var(--lilac)" };
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
    var text = function (w) { return [w.id, w.owner, w.arch, w.version, w.mode, w.agent, w.trusted_by, w.last_task && w.last_task.name, JSON.stringify(w.labels || {})].join(" "); };
    pager("#w-project", seen(kinds.project), function (w) { return workerRow(w, "project"); }, { empty: showAll ? "no project worker registered" : "no project worker alive — the host is off; pool jobs wait", text: text });
    pager("#w-review", seen(kinds.review), function (w) { return workerRow(w, "review"); }, { empty: showAll ? "no review worker registered" : "no review worker alive — the project's builds and the audits wait", text: text });
    pager("#w-community", seen(kinds.community), function (w) { return workerRow(w, "community"); }, { empty: showAll ? "no contributor's worker registered yet" : "no contributor's worker alive right now", text: text });
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
  // Who is looking decides what the rows show (the log icon is the owner's and the maintainers'): the session first, then the rows.
  whoami(function () { load(); }); setInterval(load, 20000);
  liveStats(function (d) { STATS = d; renderMinutes(d); render(); }, 60000);
`;

export function workersHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Workers · omarchy-pool",
    description: "Every worker building for the pool, by kind — the project's, the review ones two maintainers vouched for, the contributors' — alive or gone, how busy, what it built.",
    active: "none",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}

/**
 * What /workers is made of. Two reads feed the whole page: the factory
 * listing (every worker, its row) and the stats (the week's series behind
 * the tiles, the cards and the two charts). The three tables are one
 * component — the same read, three anchors — and the checkbox above them
 * is their filter, not a read of its own. The log icon in a row is the one
 * thing here that changes with the viewer: its read answers the owner and
 * the maintainers, and refuses everyone else by name.
 */
export const WORKERS_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "workers.hero",
    page: "/workers",
    anchor: ["<h1>Three kinds of worker, and whose they are</h1>", '<a href="/docs/workers">Run one →</a>'],
    visible: ["anonymous", "contributor", "owner", "maintainer"],
  },
  {
    id: "workers.tiles",
    page: "/workers",
    anchor: ['id="tiles"'],
    script: ['"#tiles"', '"Alive"', '"Building now"', '"Load · 24 h"', '"Worker minutes · 7 d"', "m.jobs || m.actions"],
    reads: [
      { path: "/api/v1/factory?limit=10", fields: ["workers", "workers.0.alive", "workers.0.current_task", "workers.0.side"] },
      { path: "/api/v1/stats", fields: ["series.workers_daily", "metrics.jobs.minutes"] },
    ],
    visible: ["anonymous", "contributor", "owner", "maintainer"],
  },
  {
    id: "workers.kind-cards",
    page: "/workers",
    anchor: ['id="kinds"'],
    script: ['"#kinds"', "POOL_KINDS", 'class="kchart"', 'class="mini four"', "builds_daily"],
    reads: [
      { path: "/api/v1/factory?limit=10", fields: ["workers.0.side", "workers.0.labels", "workers.0.alive", "workers.0.current_task"] },
      {
        path: "/api/v1/stats",
        fields: [
          "series.jobs_daily.0.day", "series.jobs_daily.0.kind", "series.jobs_daily.0.status", "series.jobs_daily.0.n",
          "series.builds_daily.0.day", "series.builds_daily.0.trust", "series.builds_daily.0.status", "series.builds_daily.0.n",
          "series.workers_daily.0.worker", "series.workers_daily.0.ms",
        ],
      },
    ],
    visible: ["anonymous", "contributor", "owner", "maintainer"],
  },
  {
    id: "workers.load-per-worker",
    page: "/workers",
    anchor: ['id="c-perworker"'],
    script: ['"#c-perworker"', "workers_daily", "running_ms", 'class="hrows"', "builds_failed"],
    reads: [
      { path: "/api/v1/stats", fields: ["series.workers_daily.0.worker", "series.workers_daily.0.ms", "series.workers_daily.0.running_ms", "series.workers_daily.0.done"] },
      { path: "/api/v1/factory?limit=10", fields: ["workers.0.id", "workers.0.arch", "workers.0.mode", "workers.0.alive", "workers.0.current_task", "workers.0.builds_done", "workers.0.builds_failed"] },
    ],
    visible: ["anonymous", "contributor", "owner", "maintainer"],
  },
  {
    id: "workers.minutes-chart",
    page: "/workers",
    anchor: ['id="c-minutes"'],
    script: ['"#c-minutes"', "renderMinutes", "jobs_daily", "r.ms"],
    reads: [{ path: "/api/v1/stats", fields: ["series.jobs_daily.0.day", "series.jobs_daily.0.ms"] }],
    visible: ["anonymous", "contributor", "owner", "maintainer"],
  },
  {
    id: "workers.table",
    page: "/workers",
    anchor: ['id="w-project"', 'id="w-review"', 'id="w-community"', 'id="all-workers"'],
    script: ['"/api/v1/factory?limit=10"', '"#w-project"', '"#w-review"', '"#w-community"', '"#all-workers"', "showAll", "WT_HEAD.project", "workerRow(w"],
    reads: [
      {
        path: "/api/v1/factory?limit=10",
        fields: [
          "workers", "workers.0.id", "workers.0.owner", "workers.0.side", "workers.0.trust", "workers.0.labels", "workers.0.hostname", "workers.0.kinds", "workers.0.trusted_by", "workers.0.trust_proposed_by",
          "workers.0.alive", "workers.0.last_seen", "workers.0.current_task", "workers.0.ready", "workers.0.update.required", "workers.0.update.latest",
          "workers.0.arch", "workers.0.version", "workers.0.mode", "workers.0.packages",
          "workers.0.agent", "workers.0.agent_status", "workers.0.agent_checked_at", "workers.0.agent_error",
          "workers.0.usage", "workers.0.usage_at", "workers.0.builds_done", "workers.0.builds_failed",
          "workers.0.last_task", "workers.0.last_task.id", "workers.0.last_task.kind", "workers.0.last_task.name", "workers.0.last_task.status", "workers.0.last_task.at",
        ],
      },
    ],
    visible: ["anonymous", "contributor", "owner", "maintainer"],
  },
  {
    id: "workers.log",
    page: "/workers",
    anchor: ['id="w-project"', 'id="w-community"'],
    script: ["data-wlog", '"/api/v1/factory/workers/"', '"/log"', "ME.login === w.owner", "whoami(function () { load(); })"],
    reads: [
      { path: `/api/v1/factory/workers/${F.worker}/log`, status: 401 },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "contributor", status: 403 },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "owner", status: 403 },
      { path: `/api/v1/factory/workers/${F.communityWorker}/log`, as: "owner", fields: ["id", "log", "at"] },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "maintainer", fields: ["id", "log", "at"] },
      { path: `/api/v1/factory/workers/${F.communityWorker}/log`, as: "maintainer", fields: ["id", "log", "at"] },
    ],
    visible: ["owner", "maintainer"],
  },
  {
    id: "workers.legend",
    page: "/workers",
    anchor: ['id="wt-legend"'],
    script: ['"#wt-legend"', "WT_LEGEND"],
    visible: ["anonymous", "contributor", "owner", "maintainer"],
  },
  {
    id: "workers.run-one-gate",
    page: "/workers",
    anchor: ["<h3>Run one of your own</h3>", '<a href="/factory">workspace</a>', '<a class="btn ghost" href="/docs/workers">Run a worker →</a>'],
    visible: ["anonymous", "contributor", "owner", "maintainer"],
  },
];
