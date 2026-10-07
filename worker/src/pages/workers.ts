/**
 * Workers: the maintainers' hosts (#324, #346, design v2 §18.2) — each with
 * its owner, its architectures and lanes, its units busy and free, the tasks
 * it runs, its release, its isolation level and whether its agent reports,
 * from /api/v1/hosts/fleet. The project's compute is its maintainers' hosts:
 * the legacy registrations from before hosts retired with P3 (#346), so the
 * page lists hosts only — a registration not retired yet keeps its own page,
 * /worker/<id>, and none is listed here. Above the charts, the hosts'
 * registrations as the factory listing counts them, the tasks running, the
 * load and the week's worker minutes, and how many builds wait for a native
 * host (an emulated lane sent them back). Public, from /api/v1/factory (its
 * live read), /api/v1/hosts/fleet and /api/v1/stats. Running a host is a
 * chapter of the docs.
 */
import { page } from "./layout";
import { HOST_REPORT_FRESH_MIN } from "../hosts";
import { SILENT_MIN } from "../fleet";
import { EVERYONE, type Component, type Fixture } from "./components";
import { CHARTS } from "./charts";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Workers</p>
    <h1>The pool's hosts</h1>
    <p class="lede">The project's compute is its maintainers' hosts — contributors run none. Each host runs one signed bundle and as many isolated, credential-less task containers at once as its units allow, on its native lane and on an emulated one; what no host has room for waits in the pool's queue, and adding hosts is how the pool grows. <a href="/docs/workers">Run one (maintainers only) →</a></p>
  </div>

  <section id="hosts" style="margin-top:28px">
    <div class="h2row"><h2>Hosts</h2><span class="hint" id="hosts-note"></span></div>
    <div class="table-wrap"><table id="hosts-table"><thead><tr><th>Host</th><th>Owner</th><th>Arches and lanes</th><th class="num" title="the units its leases hold, and the units free for a task now: none while it does not claim">Units busy / free</th><th class="num">Tasks</th><th>Release</th><th title="where a task-container escape lands: root, user, subuid, vm, vm-shared">Isolation</th><th>Alive</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section style="margin-top:28px">
    <div class="h2row"><h2>Load</h2><span class="hint" id="lists-note"></span></div>
    <div class="tiles four" id="tiles"></div>
    <p class="notice warn" id="native-wait" hidden></p>
    <div class="charts" style="margin-top:16px">
      <div class="chart"><h3>Load per host <span>24 h</span></h3><div class="sub">share of the last day each host's registration spent holding leases — the tooltip has what it did</div><div id="c-perworker"></div></div>
      <div class="chart"><h3>Worker minutes <span>per day</span></h3><div class="sub">time the hosts spent on pool jobs</div><div id="c-minutes"></div></div>
    </div>
  </section>

  <div class="gate"><div><h3>Your packages build on the pool's hosts</h3><p>Contributors do not run workers: the project provides them for everyone, and its maintainers are their only providers. Request a package and it builds here. A maintainer adds a host with the signed host bundle (<a href="/docs/workers">Run a host</a>, maintainers only).</p></div><a class="btn ghost" href="/docs/factory#contribute-a-package">How packaging works →</a></div>
`;

const SCRIPT = String.raw`
__CHARTS__
  // FACTORY is the listing once it answered; DOWN the reason it did not — the tiles the listing feeds then read "—" (the shell's tilesUnanswered; the note by Load says why), never "0 / 0" alive; the minutes tile is the stats poll's and keeps its number.
  var FACTORY = null, STATS = null, DOWN = null, FLEET = null;
  skeletonTiles("#tiles", 4); skeletonRows("#hosts-table", 8, 2);
  // The hosts (#324, design v2 §18.2): the fleet's read — owner, arches and lanes, units busy and free, tasks, release, isolation, alive.
  var FRESH_MIN = ${HOST_REPORT_FRESH_MIN};
  // A host's row says Alive "no" once it is silent too (#324, fleet.ts fleetHostOf): never "silent" beside "yes".
  var SILENT_MIN = ${SILENT_MIN};
  function laneWords(h) { return (h.lanes || []).map(function (l) { return esc(l.arch) + ' <span class="muted">' + esc(l.mode + (l.via ? " (" + l.via + (l.page16k ? ", 16K pages" : "") + ")" : "")) + "</span>"; }).join("<br>") || '<span class="muted">—</span>'; }
  var HOST_STATE = { claiming: ["ok", "claiming"], full: ["blue", "full"], asleep: ["none", "asleep"], silent: ["warn", "silent"], drained: ["warn", "drained"], suspended: ["error", "suspended"], "pending-owner": ["warn", "waits for Confirm"], "below-minimum": ["warn", "below the minimum"], "not-claiming": ["warn", "not claiming"], stopped: ["error", "claims stopped"] };
  function drawHosts(f) {
    var hs = f.hosts || [], alive = hs.filter(function (h) { return h.alive; }).length;
    var used = hs.reduce(function (n, h) { return n + (h.units_busy || 0); }, 0), units = hs.reduce(function (n, h) { return n + (h.units || 0); }, 0), tasks = hs.reduce(function (n, h) { return n + (h.tasks || 0); }, 0);
    $("#hosts-note").textContent = hs.length ? num(hs.length) + (hs.length === 1 ? " host · " : " hosts · ") + num(alive) + " alive · " + num(used) + " of " + num(units) + " units busy · " + num(tasks) + (tasks === 1 ? " task" : " tasks") : "";
    $("#hosts-table tbody").innerHTML = hs.map(function (h) {
      var st = HOST_STATE[h.state] || ["none", h.state];
      return '<tr><td><a href="/hosts/' + esc(h.id) + '">' + esc(h.name) + "</a> " + pillHtml(st[0], st[1]) + "</td><td>" + personLink(h.owner) + "</td><td>" + laneWords(h) + '</td><td class="num">' + (h.units === null || h.units === undefined ? "—" : num(h.units_busy) + " / " + num(h.units_free)) + '</td><td class="num">' + num(h.tasks) + '</td><td><span class="mono">' + esc(h.release || "—") + '</span></td><td><span class="mono">' + esc(h.isolation || "?") + "</span>" + (h.dedicated ? ' <span class="muted">dedicated</span>' : "") + "</td><td>" + (h.alive ? "yes" : '<span class="muted" title="' + (h.state === "silent" ? "silent: nothing of it reached the pool in the last " + SILENT_MIN + " minutes" : "its agent has not reported in the last " + FRESH_MIN + " minutes") + '">no</span>') + "</td></tr>";
    }).join("") || '<tr><td colspan="8" class="muted">no host yet — a maintainer adds one on their page</td></tr>';
    render();
  }
  function loadFleet() { api("GET", "/api/v1/hosts/fleet").then(function (f) { FLEET = f; drawHosts(f); }).catch(function (e) { noAnswer("host listing", e, "#hosts-note"); if (!FLEET) $("#hosts-table tbody").innerHTML = ""; }); }
  // The hosts' registrations in the listing: a legacy registration not retired yet (#346) is on its own page only, never counted here.
  function hostRegs(d) { return (d.workers || []).filter(function (w) { return w.kind === "host"; }); }
  // The four tiles, from the shell's counts (workerCounts) over the hosts' registrations, the tasks the live read has leased, the load and the week's minutes — one list, so the tiles over a listing that did not answer carry the same labels.
  function tilesOf(wc, running, load, wm) {
    return [
      // The hosts whose dispatcher claims, of the hosts registered (#324).
      ["Alive", num(wc.alive) + " / " + num(wc.registered), "hosts whose dispatcher claims", wc.alive ? "ok" : "warn"],
      ["Running now", num(running.length), running.length ? running.slice(0, 8).map(function (t) { return "#" + t.id; }).join(" · ") + (running.length > 8 ? " …" : "") : "every host idle"],
      ["Load · 24 h", load + "%", "of the last day with a lease, across the hosts alive"],
      // The stats poll's, not the listing's: marked so, it keeps its number when the listing did not answer — the chart below draws the same series.
      ["Worker minutes · 7 d", wm ? num(wm.total) : "—", wm ? "≈ " + num(Math.round(wm.total / 7)) + " per day, on the hosts" : "", "", null, "stats"]
    ];
  }
  // The load: what each registration did in the last day, from the stats series (finished tasks by duration, a running one by its start).
  function loadOf() { var L = {}; ((STATS && STATS.series && STATS.series.workers_daily) || []).forEach(function (r) { L[r.worker] = { ms: Number(r.ms || 0) + Number(r.running_ms || 0), done: Number(r.done || 0) }; }); return L; }
  function render() {
    var d = FACTORY; if (!d) { if (DOWN) setTiles("#tiles", tilesUnanswered(tilesOf(workerCounts([]), [], null, STATS ? workerMinutes(STATS.series, 7) : null), DOWN)); return; }
    var LOAD = loadOf(), regs = hostRegs(d);
    var busyOf = function (w) { var l = LOAD[w.id]; return l ? Math.min(100, Math.round(100 * l.ms / 86400000)) : 0; };
    // The numbers are the shell's (workerCounts: registered, alive, ready, the same per state); a host's leases are its tasks, which the live read lists.
    var wc = workerCounts(regs), al = regs.filter(function (w) { return w.alive; }), running = (d.tasks || []).filter(function (t) { return t.status === "leased"; });
    // Worker minutes: the sum of the series the chart below draws (workerMinutes over jobs_daily), the number the Status page and the Pipeline say — not the metrics snapshot.
    var wm = STATS ? workerMinutes(STATS.series, 7) : null;
    var load = al.length ? Math.round(al.reduce(function (n, w) { return n + busyOf(w); }, 0) / al.length) : 0;
    setTiles("#tiles", tilesOf(wc, running, load, wm));
    drawNativeWait(d);
    // The load per host, the busiest first: the host's name (its registration's, linked to the host page once the fleet answered), the bar, and what it did in the tooltip.
    var names = {}; ((FLEET && FLEET.hosts) || []).forEach(function (h) { if (h.worker) names[h.worker] = h; });
    var ranked = regs.filter(function (w) { return w.alive || LOAD[w.id]; }).sort(function (a, b) { return busyOf(b) - busyOf(a); }).slice(0, 10);
    $("#c-perworker").innerHTML = ranked.length ? hrows(ranked.map(function (w) {
      var h = names[w.id], l = LOAD[w.id] || { ms: 0, done: 0 };
      return [h ? '<a href="/hosts/' + esc(h.id) + '">' + esc(h.name) + "</a>" : workerName(w), esc(w.arch), busyOf(w), C.blue, null,
        (h ? h.name : w.id) + ": " + busyOf(w) + "% of the last day with a lease · " + num(l.done) + " task(s) finished, " + Math.round(l.ms / 60000) + " min · " + num(w.builds_done) + " done / " + num(w.builds_failed) + " failed all time"];
    }), { w: 150, html: true }) : '<div class="empty">no host alive, nothing leased in the last day</div>';
    endSkeleton();
  }
  // The builds an emulated lane sent back (params.needs_native, #281): how many wait for a native host, per architecture, each linked. The live read lists every task in flight up to its limit; a full page says "at least".
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
  // The listing did not answer (api() rejects on a 5xx and on the network): the note by Load says so; the first load's tiles read "—", and the numbers of the last load that answered stay.
  // The live read: the registrations and the tasks in flight through the queue's index, no counts.
  var LISTED = 200;
  function load() { api("GET", "/api/v1/factory?live=1&limit=" + LISTED).then(function (d) { FACTORY = d; DOWN = null; $("#lists-note").textContent = ""; render(); }).catch(function (e) { DOWN = noAnswer("worker listing", e, "#lists-note"); render(); }); }
  whoami(function () { load(); loadFleet(); }); setInterval(load, 20000); setInterval(loadFleet, 60000);
  liveStats(function (d) { STATS = d; renderMinutes(d); render(); }, 60000);
`;

export function workersHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/workers",
    title: "Workers · omarchy-pool",
    description: "The pool's hosts — the maintainers' machines: their lanes, units busy and free, tasks, release and isolation level — and the load they carry.",
    // The machines are the Factory's: they build what contributors ask for, and the footer no longer names them (#240).
    active: "factory",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}

/**
 * What /workers is made of. Three reads feed the whole page: the fleet (the
 * hosts' rows), the factory listing (the hosts' registrations and the tasks
 * in flight, behind the tiles and the load) and the stats (the day's load
 * and the week's minutes). Nothing on it changes with the viewer.
 */
export const WORKERS_COMPONENTS = (_F: Fixture): Component[] => [
  {
    id: "workers.hero",
    page: "/workers",
    anchor: ["<h1>The pool's hosts</h1>", "contributors run none", "adding hosts is how the pool grows", '<a href="/docs/workers">Run one (maintainers only) →</a>'],
    visible: EVERYONE,
  },
  {
    // The hosts (#324, design v2 §18.2): owner, arches and lanes, units busy and free, tasks running, release, isolation level and whether its
    // agent reports — public, from the fleet's read. Hosts only (#346): no legacy registration is listed.
    id: "workers.hosts",
    page: "/workers",
    anchor: ['id="hosts"', 'id="hosts-table"', 'id="hosts-note"', "<th>Arches and lanes</th>"],
    script: ['api("GET", "/api/v1/hosts/fleet")', "function drawHosts(f)", "function laneWords(h)", "HOST_STATE", "h.units_busy", "h.units_free", "num(h.tasks)", "h.isolation", "h.alive", 'href="/hosts/', 'noAnswer("host listing", e, "#hosts-note")', "setInterval(loadFleet, 60000)"],
    reads: [{ path: "/api/v1/hosts/fleet", fields: ["hosts", "hosts.0.id", "hosts.0.name", "hosts.0.owner", "hosts.0.worker", "hosts.0.lanes", "hosts.0.units", "hosts.0.units_busy", "hosts.0.units_free", "hosts.0.tasks", "hosts.0.release", "hosts.0.isolation", "hosts.0.dedicated", "hosts.0.alive", "hosts.0.state"] }],
    visible: EVERYONE,
  },
  {
    id: "workers.tiles",
    page: "/workers",
    anchor: ['id="tiles"', 'id="lists-note"'],
    // The counts are the shell's (workerCounts over the hosts' registrations); over a listing that did not answer the three it feeds read "—" (the shell's tilesUnanswered) and the minutes tile, the stats poll's, keeps its number.
    script: ['"#tiles"', "workerCounts(regs)", 'w.kind === "host"', "function tilesOf(wc, running, load, wm)", 'setTiles("#tiles", tilesUnanswered(tilesOf(workerCounts([]), [], null, STATS ? workerMinutes(STATS.series, 7) : null), DOWN))', '"", null, "stats"]', '"Alive"', "wc.alive", "wc.registered", '"Running now"', 't.status === "leased"', '"Load · 24 h"', '"Worker minutes · 7 d", wm ? num(wm.total)', "workerMinutes(STATS.series, 7)", 'api("GET", "/api/v1/factory?live=1&limit=" + LISTED)', "LISTED = 200", 'noAnswer("worker listing", e, "#lists-note")'],
    reads: [
      { path: "/api/v1/factory?live=1&limit=200", fields: ["workers", "workers.0.kind", "workers.0.alive", "workers.0.ready", "workers.0.revoked_at", "tasks", "tasks.0.id", "tasks.0.status"] },
      { path: "/api/v1/stats", fields: ["series.workers_daily", "series.jobs_daily"] },
    ],
    visible: EVERYONE,
  },
  {
    // How many builds wait for a native host, per architecture, each linked (#281): the live read's queued tasks an emulated lane sent back (params.needs_native, the shell's waitsForNative). Hidden while none waits.
    id: "workers.native-wait",
    page: "/workers",
    anchor: ['<p class="notice warn" id="native-wait" hidden></p>'],
    script: ["function drawNativeWait(d)", "waitsForNative(t)", '" builds wait"', "' for a native '", "' could not run emulated: '", '"At least "', "drawNativeWait(d);"],
    reads: [{ path: "/api/v1/factory?live=1&limit=200", fields: ["tasks", "tasks.0.id", "tasks.0.arch", "tasks.0.status", "tasks.0.params"] }],
    visible: EVERYONE,
  },
  {
    id: "workers.load-per-host",
    page: "/workers",
    anchor: ['id="c-perworker"'],
    script: ['"#c-perworker"', "workers_daily", "running_ms", "hrows(ranked", "builds_failed", "names[h.worker] = h"],
    reads: [
      { path: "/api/v1/stats", fields: ["series.workers_daily.0.worker", "series.workers_daily.0.ms", "series.workers_daily.0.running_ms", "series.workers_daily.0.done"] },
      { path: "/api/v1/factory?live=1&limit=200", fields: ["workers.0.id", "workers.0.arch", "workers.0.alive", "workers.0.builds_done", "workers.0.builds_failed"] },
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
    // The workers are the maintainers' hosts (#331): the gate invites no one to run one, it says where a contributor's packages build and links the packaging docs; "Run a host" is marked maintainers only.
    id: "workers.run-one-gate",
    page: "/workers",
    anchor: ["<h3>Your packages build on the pool's hosts</h3>", "Contributors do not run workers", '(<a href="/docs/workers">Run a host</a>, maintainers only)', '<a class="btn ghost" href="/docs/factory#contribute-a-package">How packaging works →</a>'],
    visible: EVERYONE,
  },
];
