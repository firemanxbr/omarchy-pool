/**
 * Workers: the maintainers' hosts first (#324, design v2 §18.2) — each with
 * its owner, its architectures and lanes, its units busy and free, the tasks
 * it runs, its release, its isolation level and whether its agent reports,
 * from /api/v1/hosts/fleet — then the legacy registrations, as such, until
 * P3 retires them: the role containers of the sets from before hosts, by
 * kind — the project's (the pool's own jobs: sync, render, promote, health,
 * security, gc), the review ones (the maintainers' side: trusted by a
 * maintainer, they build again what a maintainer asked for, publish what is
 * approved and write the audit) and the legacy community sets (any
 * contributor's packages, as a host builds them, #343). A host's own
 * registration is its row among the hosts, never a legacy one. Each legacy
 * table says, per worker: the id whole (two workers of one host share a
 * name, never an id), its state in one word, the release it runs, who keeps
 * it, what its machine uses and what it last did; above them, how many
 * builds wait for a native worker (an emulated one sent them back). Public,
 * from /api/v1/factory (its live read), /api/v1/hosts/fleet and
 * /api/v1/stats. Running a host is a chapter of the docs.
 */
import { page, workerPanels } from "./layout";
import { HOST_REPORT_FRESH_MIN } from "../hosts";
import { EVERYONE, type Component, type Fixture } from "./components";
import { CHARTS } from "./charts";
import type { RunningVersion } from "../meta";
import { JOB_KINDS } from "../jobs";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Workers</p>
    <h1>The pool's hosts, and the legacy registrations until they retire</h1>
    <p class="lede">The project's compute is its maintainers' hosts — contributors run none: each runs as many tasks at once as its units allow, on its native lane and on an emulated one. Below them, the legacy registrations — the role containers of the sets from before hosts — until they retire: the project's take the pool's jobs; the review ones, the project's trust given on two maintainers' word, build again what a maintainer asked for and write the audit; the community ones build any contributor's packages, as a host does. <a href="/docs/workers">Run one (maintainers only) →</a></p>
  </div>

  <section id="hosts" style="margin-top:28px">
    <div class="h2row"><h2>Hosts</h2><span class="hint" id="hosts-note"></span></div>
    <div class="table-wrap"><table id="hosts-table"><thead><tr><th>Host</th><th>Owner</th><th>Arches and lanes</th><th class="num" title="the units its leases hold, and the units free for a task now: none while it does not claim">Units busy / free</th><th class="num">Tasks</th><th>Release</th><th title="where a task-container escape lands: root, user, subuid, vm, vm-shared">Isolation</th><th>Alive</th></tr></thead><tbody></tbody></table></div>
  </section>

  <div class="tiles four" id="tiles"></div>
  <p class="notice warn" id="native-wait" hidden></p>

  <div class="roles-grid" id="kinds"></div>

  <div class="charts" style="margin-top:16px">
    <div class="chart"><h3>Load per worker <span>24 h</span></h3><div class="sub">share of the last day each worker spent holding a lease — the tooltip has what it did</div><div id="c-perworker"></div></div>
    <div class="chart"><h3>Worker minutes <span>per day</span></h3><div class="sub">time the project's workers spent on pool jobs</div><div id="c-minutes"></div></div>
  </div>

  <section style="margin-top:44px">
    <div class="h2row"><h2>Legacy registrations</h2><span class="hint" id="lists-note"></span><label class="dim" style="font-size:13px"><input type="checkbox" id="all-workers"> show workers not seen recently</label></div>
    <p class="sub" style="margin:0 0 12px;font-size:12.5px">The role containers of the sets from before hosts — the Studio's — until P3 retires them; a host's own registration is its row among the hosts.</p>
    ${workerPanels([
      { kind: "project", blurb: "the pool's own jobs — sync, render, promote, health, security, gc — on the host a maintainer keeps" },
      { kind: "review", blurb: "the maintainers' side: builds again, publishes, audits — the agent through a proxy that holds the key" },
      { kind: "community", blurb: "legacy community sets, until they retire: any contributor's packages, as a host builds them" },
    ])}
  </section>

  <div class="gate"><div><h3>Your packages build on the pool's hosts</h3><p>Contributors do not run workers: the project provides them for everyone, and its maintainers are their only providers. Request a package and it builds here. A maintainer adds a host with the signed host bundle (<a href="/docs/workers">Run a worker</a>, maintainers only).</p></div><a class="btn ghost" href="/docs/factory#contribute-a-package">How packaging works →</a></div>
`;

const SCRIPT = String.raw`
__CHARTS__
  // FACTORY is the listing once it answered; DOWN the reason it did not — the tiles the listing feeds then read "—" (the shell's tilesUnanswered; the note by Every worker says why), never "0 / 0" alive; the minutes tile is the stats poll's and keeps its number.
  var FACTORY = null, STATS = null, DOWN = null, FLEET = null;
  skeletonTiles("#tiles", 4); wtTables(); skeletonRows("#hosts-table", 8, 2);
  // The hosts (#324, design v2 §18.2): the fleet's read — owner, arches and lanes, units busy and free, tasks, release, isolation, alive.
  var FRESH_MIN = ${HOST_REPORT_FRESH_MIN};
  function laneWords(h) { return (h.lanes || []).map(function (l) { return esc(l.arch) + ' <span class="muted">' + esc(l.mode + (l.via ? " (" + l.via + (l.page16k ? ", 16K pages" : "") + ")" : "")) + "</span>"; }).join("<br>") || '<span class="muted">—</span>'; }
  var HOST_STATE = { claiming: ["ok", "claiming"], full: ["blue", "full"], asleep: ["none", "asleep"], silent: ["warn", "silent"], drained: ["warn", "drained"], suspended: ["error", "suspended"], "pending-owner": ["warn", "waits for Confirm"], "below-minimum": ["warn", "below the minimum"], "not-claiming": ["warn", "not claiming"], stopped: ["error", "claims stopped"] };
  function drawHosts(f) {
    var hs = f.hosts || [], alive = hs.filter(function (h) { return h.alive; }).length;
    var used = hs.reduce(function (n, h) { return n + (h.units_busy || 0); }, 0), units = hs.reduce(function (n, h) { return n + (h.units || 0); }, 0), tasks = hs.reduce(function (n, h) { return n + (h.tasks || 0); }, 0);
    $("#hosts-note").textContent = hs.length ? num(hs.length) + (hs.length === 1 ? " host · " : " hosts · ") + num(alive) + " alive · " + num(used) + " of " + num(units) + " units busy · " + num(tasks) + (tasks === 1 ? " task" : " tasks") : "";
    $("#hosts-table tbody").innerHTML = hs.map(function (h) {
      var st = HOST_STATE[h.state] || ["none", h.state];
      return '<tr><td><a href="/hosts/' + esc(h.id) + '">' + esc(h.name) + "</a> " + pillHtml(st[0], st[1]) + "</td><td>" + personLink(h.owner) + "</td><td>" + laneWords(h) + '</td><td class="num">' + (h.units === null || h.units === undefined ? "—" : num(h.units_busy) + " / " + num(h.units_free)) + '</td><td class="num">' + num(h.tasks) + '</td><td><span class="mono">' + esc(h.release || "—") + '</span></td><td><span class="mono">' + esc(h.isolation || "?") + "</span>" + (h.dedicated ? ' <span class="muted">dedicated</span>' : "") + "</td><td>" + (h.alive ? "yes" : '<span class="muted" title="its agent has not reported in the last ' + FRESH_MIN + ' minutes">no</span>') + "</td></tr>";
    }).join("") || '<tr><td colspan="8" class="muted">no host yet — a maintainer adds one on their page</td></tr>';
  }
  function loadFleet() { api("GET", "/api/v1/hosts/fleet").then(function (f) { FLEET = f; drawHosts(f); }).catch(function (e) { noAnswer("host listing", e, "#hosts-note"); if (!FLEET) $("#hosts-table tbody").innerHTML = ""; }); }
  // The kind's colour on every chart of the page: the card's line, the bar per worker, the legend.
  var COLOR = { project: C.green, review: C.blue, community: C.lilac };
  // What each kind finished per day over the last week, from the stats series: the pool's jobs are the
  // project's (jobs_daily, by kind), the project's builds with the publishes and audits are the review side's,
  // a contributor's builds are theirs (builds_daily, by trust). Only finished tasks count: done or staged, and failed.
  // Not the shell's buildsByDay: that splits one series by status, this splits two series by kind — but a pool job's
  // bucket is the shell's jobBucket, the rule jobsSummary applies, so a cancelled job is failed here as it is on the
  // Status page's table and the Pipeline's chart (a rule of this page's own counted it nowhere).
  // The pool's kinds are jobs.ts's JOB_KINDS, spliced in: a kind added there lands on the project's card the day it is written (a hand copy here put a new kind on the review side without a word).
  var POOL_KINDS = ${JSON.stringify(JOB_KINDS)};
  function perDay() {
    var days = lastDays(7), zero = function () { var o = {}; days.forEach(function (d) { o[d] = { done: 0, failed: 0 }; }); return o; };
    var P = { project: zero(), review: zero(), community: zero() }, S = (STATS && STATS.series) || {};
    var add = function (k, d, bucket, n) { var o = P[k][d]; if (o && (bucket === "done" || bucket === "failed")) o[bucket] += n; };
    (S.jobs_daily || []).forEach(function (r) { add(POOL_KINDS.indexOf(r.kind) >= 0 ? "project" : "review", r.day, jobBucket(r.status), Number(r.n || 0)); });
    (S.builds_daily || []).forEach(function (r) { add(r.trust === "community" ? "community" : "review", r.day, r.status === "staged" ? "done" : r.status, Number(r.n || 0)); });
    return { days: days, P: P };
  }
  // The four tiles, from the shell's counts (workerCounts), the workers building now, the load and the week's minutes — one list, so the tiles over a listing that did not answer carry the same labels.
  function tilesOf(wc, wcl, bz, load, wm) {
    return [
      // The registrations alive: the hosts' (their dispatchers) and the legacy ones by kind (#324).
      ["Alive", num(wc.alive) + " / " + num(wc.registered), num(wc.alive - wcl.alive) + " host · " + num(wcl.byKind.project.alive) + " project · " + num(wcl.byKind.review.alive) + " review · " + num(wcl.byKind.community.alive) + " community", wc.alive ? "ok" : "warn"],
      ["Building now", num(wc.building), wc.building ? bz.map(function (w) { return "#" + w.current_task; }).join(" · ") : "every worker idle"],
      ["Load · 24 h", load + "%", "of the last day with a lease, across the alive ones"],
      // The stats poll's, not the listing's: marked so, it keeps its number when the listing did not answer — the chart below draws the same series.
      ["Worker minutes · 7 d", wm ? num(wm.total) : "—", wm ? "≈ " + num(Math.round(wm.total / 7)) + " per day, the project's workers" : "", "", null, "stats"]
    ];
  }
  // The load: what each worker did in the last day, from the stats series (finished tasks by duration, a running one by its start).
  function loadOf() { var L = {}; ((STATS && STATS.series && STATS.series.workers_daily) || []).forEach(function (r) { L[r.worker] = { ms: Number(r.ms || 0) + Number(r.running_ms || 0), done: Number(r.done || 0) }; }); return L; }
  function render() {
    var d = FACTORY; if (!d) { if (DOWN) setTiles("#tiles", tilesUnanswered(tilesOf(workerCounts([]), workerCounts([]), [], null, STATS ? workerMinutes(STATS.series, 7) : null), DOWN)); return; }
    var showAll = $("#all-workers").checked, LOAD = loadOf();
    var busyOf = function (w) { var l = LOAD[w.id]; return l ? Math.min(100, Math.round(100 * l.ms / 86400000)) : 0; };
    var kinds = { project: [], review: [], community: [] };
    // A host's own registration is its row among the hosts (#324): the cards and the tables below are the legacy registrations'.
    var legacy = d.workers.filter(function (w) { return w.kind !== "host"; });
    legacy.forEach(function (w) { kinds[wtKind(w)].push(w); });
    // The numbers are the shell's (workerCounts: registered, alive, building, and the same per kind); the rows behind them stay here for the load and the task ids.
    var wc = workerCounts(d.workers), wcl = workerCounts(legacy), al = d.workers.filter(function (w) { return w.alive; }), bz = al.filter(function (w) { return w.current_task; });
    // Worker minutes: the sum of the series the chart below draws (workerMinutes over jobs_daily), the number the Status page and the Pipeline say — not the metrics snapshot.
    var wm = STATS ? workerMinutes(STATS.series, 7) : null;
    var load = al.length ? Math.round(al.reduce(function (n, w) { return n + busyOf(w); }, 0) / al.length) : 0;
    setTiles("#tiles", tilesOf(wc, wcl, bz, load, wm));
    drawNativeWait(d);
    // One card per kind: one line on what it is for, the tasks it finished per day over a week (the Pool page's growth line, in the kind's colour), four numbers.
    var PD = perDay();
    var card = function (cls, name, ws, blurb) {
      var k = wcl.byKind[cls], alv = ws.filter(function (w) { return w.alive; });
      var busyPct = alv.length ? Math.round(alv.reduce(function (n, w) { return n + busyOf(w); }, 0) / alv.length) : 0;
      var pd = PD.P[cls], pts = PD.days.map(function (d) { return { t: Date.parse(d), v: pd[d].done + pd[d].failed }; });
      var done7 = PD.days.reduce(function (n, d) { return n + pd[d].done; }, 0), failed7 = PD.days.reduce(function (n, d) { return n + pd[d].failed; }, 0);
      return '<div class="role k-' + (cls === "community" ? "contrib" : cls) + '"><h3>' + name + '<span>' + num(k.registered) + (k.registered === 1 ? " worker" : " workers") + '</span></h3><p>' + blurb + '</p>' +
        '<div class="kchart" data-tip="' + esc(name + ": tasks finished per day, the last seven days · " + num(done7) + " done, " + num(failed7) + " failed") + '">' + (STATS ? area(pts, num, 96, COLOR[cls]) : '<div class="empty loading">Loading</div>') + '</div>' +
        '<div class="mini four"><div><b>' + num(k.alive) + ' of ' + num(k.registered) + '</b>alive</div><div data-tip="' + esc(busyPct + "% of the last day with a lease, across " + k.alive + " alive worker(s) · " + k.building + " building now") + '"><b>' + busyPct + '%</b>busy 24h</div><div><b>' + num(done7) + '</b>done 7d</div><div><b>' + num(failed7) + '</b>failed 7d</div></div></div>';
    };
    $("#kinds").innerHTML =
      card("project", "Project", kinds.project, "The pool's own jobs, on the host a maintainer keeps.") +
      card("review", "Review", kinds.review, "Rebuilds, publishes and audits, on the project's trust.") +
      card("community", "Community", kinds.community, "Legacy community sets, until they retire: any contributor's packages, as a host builds them.");
    // The load per worker, the busiest first: the name with the kind and the architecture, the bar in the kind's colour, and what it did in the tooltip.
    var ranked = d.workers.filter(function (w) { return w.alive || LOAD[w.id]; }).sort(function (a, b) { return busyOf(b) - busyOf(a); }).slice(0, 10);
    $("#c-perworker").innerHTML = ranked.length ? hrows(ranked.map(function (w) {
      var k = wtKind(w), l = LOAD[w.id] || { ms: 0, done: 0 };
      return [workerName(w), k + " · " + esc(w.arch), busyOf(w), COLOR[k], null,
        w.id + ": " + busyOf(w) + "% of the last day with a lease · " + num(l.done) + " task(s) finished, " + Math.round(l.ms / 60000) + " min" + (w.current_task ? " · building #" + w.current_task + " now" : "") + " · " + num(w.builds_done) + " done / " + num(w.builds_failed) + " failed all time"];
    }), { w: 150, html: true }) + '<div class="legend"><span><i style="background:' + COLOR.project + '"></i>project</span><span><i style="background:' + COLOR.review + '"></i>review</span><span><i style="background:' + COLOR.community + '"></i>community</span></div>' : '<div class="empty">no worker alive, nothing leased in the last day</div>';
    // The three tables.
    var seen = function (ws) { return ws.filter(function (w) { return showAll || w.alive; }); };
    pager("#w-project", seen(kinds.project), function (w) { return workerRow(w, "project"); }, { empty: showAll ? "no project worker registered" : "no project worker alive — the host is off; pool jobs wait", text: wtText });
    pager("#w-review", seen(kinds.review), function (w) { return workerRow(w, "review"); }, { empty: showAll ? "no review worker registered" : "no review worker alive — the project's builds and the audits wait", text: wtText });
    pager("#w-community", seen(kinds.community), function (w) { return workerRow(w, "community"); }, { empty: showAll ? "no community worker registered" : "no community worker alive right now", text: wtText });
    endSkeleton();
  }
  // The builds an emulated worker sent back (params.needs_native, #281): how many wait for a native worker, per architecture, each linked. The live read lists every task in flight up to its limit; a full page says "at least".
  function drawNativeWait(d) {
    var by = {}, ts = d.tasks || [];
    ts.forEach(function (t) { if (waitsForNative(t)) (by[t.arch] = by[t.arch] || []).push(t.id); });
    var arches = Object.keys(by).sort(), el = $("#native-wait");
    el.hidden = !arches.length;
    el.innerHTML = arches.map(function (a) {
      var n = by[a].length;
      return '<b>' + (ts.length >= LISTED ? "At least " : "") + num(n) + (n === 1 ? " build waits" : " builds wait") + ' for a native ' + esc(a) + ' worker.</b> ' + (n === 1 ? "It" : "They") + ' could not run emulated: ' + by[a].map(function (id) { return '<a href="/build/' + id + '">#' + id + '</a>'; }).join(", ") + '.';
    }).join("<br>") + (arches.length ? ' <a href="/docs/workers">Run one (maintainers only) →</a>' : "");
  }
  // Worker minutes per day, the shell's one sum over the jobs series (workerMinutes) — the tile above is its total.
  function renderMinutes(d) {
    var wm = workerMinutes(d.series, 7);
    $("#c-minutes").innerHTML = stacked(wm.labels, [{ name: "minutes", color: C.blue, values: wm.values }], { label: "Worker minutes per day over seven days", empty: "no job yet" });
  }
  // The listing did not answer (api() rejects on a 5xx and on the network): the note by Every worker says so; the first load's tiles read "—", the tables draw no "no worker alive" in its place, and the rows of the last load that answered stay.
  // The live read: the workers and the tasks in flight through the queue's index, no counts — the full listing read every task twice for a page that shows none of them.
  var LISTED = 200;
  function load() { api("GET", "/api/v1/factory?live=1&limit=" + LISTED).then(function (d) { FACTORY = d; DOWN = null; $("#lists-note").textContent = ""; render(); }).catch(function (e) { DOWN = noAnswer("worker listing", e, "#lists-note"); render(); }); }
  $("#all-workers").onchange = render;
  // Who is looking decides what the rows show (the log icon is the owner's and the maintainers'): the session first, then the rows.
  whoami(function () { load(); loadFleet(); }); setInterval(load, 20000); setInterval(loadFleet, 60000);
  liveStats(function (d) { STATS = d; renderMinutes(d); render(); }, 60000);
`;

export function workersHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/workers",
    title: "Workers · omarchy-pool",
    description: "The pool's hosts — their lanes, units busy and free, tasks, release and isolation level — and the legacy registrations by kind until they retire: the project's, the review ones, the community sets.",
    // The machines are the Factory's: they build what contributors ask for, and the footer no longer names them (#240).
    active: "factory",
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
    anchor: ["<h1>The pool's hosts, and the legacy registrations until they retire</h1>", "contributors run none", '<a href="/docs/workers">Run one (maintainers only) →</a>'],
    visible: EVERYONE,
  },
  {
    // The hosts (#324, design v2 §18.2): owner, arches and lanes, units busy and free, tasks running, release, isolation level and whether its
    // agent reports — public, from the fleet's read; a host's own registration is its row here, never a legacy one.
    id: "workers.hosts",
    page: "/workers",
    anchor: ['id="hosts"', 'id="hosts-table"', 'id="hosts-note"', "<th>Arches and lanes</th>", "<h2>Legacy registrations</h2>"],
    script: ['api("GET", "/api/v1/hosts/fleet")', "function drawHosts(f)", "function laneWords(h)", "HOST_STATE", "h.units_busy", "h.units_free", "num(h.tasks)", "h.isolation", "h.alive", 'href="/hosts/', 'noAnswer("host listing", e, "#hosts-note")', "setInterval(loadFleet, 60000)"],
    reads: [{ path: "/api/v1/hosts/fleet", fields: ["hosts", "hosts.0.id", "hosts.0.name", "hosts.0.owner", "hosts.0.lanes", "hosts.0.units", "hosts.0.units_busy", "hosts.0.units_free", "hosts.0.tasks", "hosts.0.release", "hosts.0.isolation", "hosts.0.dedicated", "hosts.0.alive", "hosts.0.state"] }],
    visible: EVERYONE,
  },
  {
    id: "workers.tiles",
    page: "/workers",
    anchor: ['id="tiles"'],
    // The counts are the shell's (workerCounts over the listing), the same the Pool's tiles say; over a listing that did not answer the three it feeds read "—" (the shell's tilesUnanswered) and the minutes tile, the stats poll's, keeps its number.
    script: ['"#tiles"', "workerCounts(d.workers)", "function tilesOf(wc, wcl, bz, load, wm)", 'setTiles("#tiles", tilesUnanswered(tilesOf(workerCounts([]), workerCounts([]), [], null, STATS ? workerMinutes(STATS.series, 7) : null), DOWN))', '"", null, "stats"]', '"Alive"', "wc.alive", "wc.registered", "wc.alive - wcl.alive", "wcl.byKind.project.alive", '"Building now"', "wc.building", '"Load · 24 h"', '"Worker minutes · 7 d", wm ? num(wm.total)', "workerMinutes(STATS.series, 7)"],
    reads: [
      { path: "/api/v1/factory?live=1&limit=200", fields: ["workers", "workers.0.alive", "workers.0.ready", "workers.0.current_task", "workers.0.revoked_at", "workers.0.side", "workers.0.labels"] },
      { path: "/api/v1/stats", fields: ["series.workers_daily", "series.jobs_daily"] },
    ],
    visible: EVERYONE,
  },
  {
    // How many builds wait for a native worker, per architecture, each linked (#281): the live read's queued tasks an emulated worker sent back (params.needs_native, the shell's waitsForNative). Hidden while none waits.
    id: "workers.native-wait",
    page: "/workers",
    anchor: ['<p class="notice warn" id="native-wait" hidden></p>'],
    script: ["function drawNativeWait(d)", "waitsForNative(t)", '" builds wait"', "' for a native '", "' could not run emulated: '", '"At least "', "drawNativeWait(d);"],
    reads: [{ path: "/api/v1/factory?live=1&limit=200", fields: ["tasks", "tasks.0.id", "tasks.0.arch", "tasks.0.status", "tasks.0.params"] }],
    visible: EVERYONE,
  },
  {
    id: "workers.kind-cards",
    page: "/workers",
    anchor: ['id="kinds"'],
    script: ['"#kinds"', `POOL_KINDS = ${JSON.stringify(JOB_KINDS)}`, "POOL_KINDS.indexOf(r.kind)", "jobBucket(r.status)", 'class="kchart"', 'class="mini four"', "builds_daily", "wcl.byKind[cls]", "k.registered", "k.alive", "k.building", 'w.kind !== "host"'],
    reads: [
      { path: "/api/v1/factory?live=1&limit=200", fields: ["workers.0.side", "workers.0.labels", "workers.0.alive", "workers.0.ready", "workers.0.current_task", "workers.0.revoked_at", "workers.0.kind"] },
      {
        path: "/api/v1/stats",
        fields: [
          "series.jobs_daily.0.day", "series.jobs_daily.0.kind", "series.jobs_daily.0.status", "series.jobs_daily.0.n",
          "series.builds_daily.0.day", "series.builds_daily.0.trust", "series.builds_daily.0.status", "series.builds_daily.0.n",
          "series.workers_daily.0.worker", "series.workers_daily.0.ms",
        ],
      },
    ],
    visible: EVERYONE,
  },
  {
    id: "workers.load-per-worker",
    page: "/workers",
    anchor: ['id="c-perworker"'],
    script: ['"#c-perworker"', "workers_daily", "running_ms", "hrows(ranked", "builds_failed"],
    reads: [
      { path: "/api/v1/stats", fields: ["series.workers_daily.0.worker", "series.workers_daily.0.ms", "series.workers_daily.0.running_ms", "series.workers_daily.0.done"] },
      { path: "/api/v1/factory?live=1&limit=200", fields: ["workers.0.id", "workers.0.arch", "workers.0.alive", "workers.0.current_task", "workers.0.builds_done", "workers.0.builds_failed"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "workers.minutes-chart",
    page: "/workers",
    anchor: ['id="c-minutes"'],
    script: ['"#c-minutes"', "renderMinutes", "workerMinutes(d.series, 7)", "wm.values"],
    reads: [{ path: "/api/v1/stats", fields: ["series.jobs_daily.0.day", "series.jobs_daily.0.ms"] }],
    visible: EVERYONE,
  },
  {
    id: "workers.table",
    page: "/workers",
    shared: "worker-table",
    anchor: ['id="w-project"', 'id="w-review"', 'id="w-community"', 'id="all-workers"', 'id="lists-note"'],
    script: ['api("GET", "/api/v1/factory?live=1&limit=" + LISTED)', "LISTED = 200", 'noAnswer("worker listing", e, "#lists-note")', '$("#lists-note").textContent = ""', 'wtTables()', '"#w-project"', '"#w-review"', '"#w-community"', '"#all-workers"', "showAll", "workerRow(w", "text: wtText"],
    reads: [
      {
        path: "/api/v1/factory?live=1&limit=200",
        fields: [
          "workers", "workers.0.id", "workers.0.owner", "workers.0.side", "workers.0.trust", "workers.0.labels", "workers.0.hostname", "workers.0.kinds", "workers.0.trusted_by", "workers.0.trust_proposed_by",
          "workers.0.alive", "workers.0.last_seen", "workers.0.current_task", "workers.0.ready", "workers.0.update.required", "workers.0.update.latest",
          "workers.0.arch", "workers.0.version", "workers.0.packages",
          "workers.0.agent", "workers.0.agent_status", "workers.0.agent_checked_at", "workers.0.agent_error",
          "workers.0.usage", "workers.0.usage_at", "workers.0.builds_done", "workers.0.builds_failed",
          "workers.0.last_task", "workers.0.last_task.id", "workers.0.last_task.kind", "workers.0.last_task.name", "workers.0.last_task.status", "workers.0.last_task.at",
        ],
      },
    ],
    visible: EVERYONE,
  },
  {
    // The shell's log icon on every row: live for the worker's owner and the maintainers, grey with the pool's refusal for everyone else.
    id: "workers.log",
    page: "/workers",
    anchor: ['id="w-project"', 'id="w-community"'],
    script: ["workerRow(w", "whoami(function () { load(); loadFleet(); })"],
    reads: [
      { path: `/api/v1/factory/workers/${F.worker}/log`, status: 401 },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "contributor", status: 403 },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "owner", status: 403 },
      { path: `/api/v1/factory/workers/${F.ownerWorker}/log`, as: "owner", fields: ["id", "log", "at"] },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "maintainer", fields: ["id", "log", "at"] },
      { path: `/api/v1/factory/workers/${F.communityWorker}/log`, as: "maintainer", fields: ["id", "log", "at"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "workers.legend",
    page: "/workers",
    shared: "worker-legend",
    anchor: ['id="wt-legend"'],
    script: ["wtTables()"],
    visible: EVERYONE,
  },
  {
    // The workers are the maintainers' hosts (#331): the gate invites no one to run one, it says where a contributor's packages build and links the packaging docs; "Run a worker" is marked maintainers only.
    id: "workers.run-one-gate",
    page: "/workers",
    anchor: ["<h3>Your packages build on the pool's hosts</h3>", "Contributors do not run workers", '(<a href="/docs/workers">Run a worker</a>, maintainers only)', '<a class="btn ghost" href="/docs/factory#contribute-a-package">How packaging works →</a>'],
    visible: EVERYONE,
  },
];
