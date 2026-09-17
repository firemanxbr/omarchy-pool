/**
 * Status: is the pool serving, is it being fed, did anything go wrong
 * recently — and every number behind the Pool page: coverage per source,
 * the jobs, the charts. The page to open when something looks off.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { CHARTS } from "./charts";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Status</p>
    <h1>Is it up, is it keeping up, is every ring healthy</h1>
    <p class="lede" id="headline">Checking…</p>
  </div>

  <section>
    <h2>Service</h2>
    <p class="sub">Measured right now by the API: can it reach the index and the pool.</p>
    <div class="svc" id="service"></div>
  </section>

  <section>
    <h2>Pipeline <span id="pipeline-state" class="pill none" style="vertical-align:middle;margin-left:8px">checking</span></h2>
    <p class="sub">Whether the pool is being kept up to date: the syncs, the checks, the promotions.</p>
    <div class="tiles" id="tiles"></div>
  </section>

  <section>
    <h2>Rings</h2>
    <p class="sub">Latest real-pacman check per ring and architecture, and when the ring last moved.</p>
    <div class="table-wrap"><table id="rings"><thead><tr><th>Ring</th><th>Arch</th><th>Health</th><th>Checked</th><th>Release</th><th>Moved</th><th>Databases</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Sources</h2>
    <p class="sub">Last sync of every upstream repository. A source is late when its last sync is older than six hours (a long import of one source makes the others wait their turn).</p>
    <div class="table-wrap"><table id="sources"><thead><tr><th>Source</th><th>Arch</th><th>Last sync</th><th>Result</th><th class="num">Upstream</th><th class="num">In edge</th><th class="num">Missing</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Coverage</h2><span class="hint">every source, every number</span></div>
    <p class="sub">What upstream serves, what <code>edge</code> already pins, what <code>stable</code> pins. Superseded versions stay in the pool until retention runs, so the size can exceed the upstream's.</p>
    <div class="table-wrap"><table id="coverage"><thead><tr><th>Source</th><th>Arch</th><th class="num">Upstream</th><th class="num">In edge</th><th class="num">Missing</th><th class="num">In stable</th><th>Progress</th><th class="num">Size</th><th>Last sync</th></tr></thead><tbody></tbody></table></div>
    <p class="sub" id="provenance" hidden></p>
    <p class="sub" id="any" hidden></p>
  </section>

  <section>
    <div class="h2row"><h2>The pipeline, in numbers</h2><a class="more-link" href="/pipeline">Watch it run →</a></div>
    <p class="sub">The pool's own jobs, pulled by workers with a per-job credential; a snapshot every 30 minutes records what ran, what is running now and the worker minutes.</p>
    <div class="tiles" id="systiles"></div>
    <div class="charts">
      <div class="chart"><h3>Pool growth <span>7 days</span></h3><div class="sub">bytes stored once, from the metrics snapshots</div><div id="c-pool"></div></div>
      <div class="chart"><h3>Imports per day <span>14 days</span></h3><div class="sub">packages brought into the pool by the sync runs</div><div id="c-imports"></div></div>
      <div class="chart"><h3>Health <span>14 days</span></h3><div class="sub">worst result per day, per ring and architecture</div><div id="c-health"></div></div>
      <div class="chart"><h3>Sync throughput <span>last runs</span></h3><div class="sub">MB/s per sync run, one worker each</div><div id="c-sync"></div></div>
      <div class="chart"><h3>Worker minutes <span>per day</span></h3><div class="sub">time the project's workers spent on pool jobs</div><div id="c-minutes"></div></div>
      <div class="chart"><h3>Pool jobs <span>7 days</span></h3><div class="sub">sync, promote, health, gc pulled by workers: done, failed, waiting</div><div id="c-jobs"></div></div>
      <div class="chart"><h3>Factory builds <span>14 days</span></h3><div class="sub">per day: contributors' builds staged, the project's published, failed</div><div id="c-builds"></div></div>
    </div>
    <div class="table-wrap"><table id="workflows"><thead><tr><th>Job</th><th>Last</th><th class="num">Runs 7d</th><th class="num">Failed</th><th class="num">Running</th><th class="num">Minutes 7d</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Incidents</h2>
    <p class="sub">Rollbacks, blocked gates and failed checks in the journal, newest first. An empty list is the goal.</p>
    <div class="table-wrap"><table id="incidents"><thead><tr><th>Status</th><th>What</th><th>Ring</th><th>Summary</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  skeletonRows("#coverage", 9, 5); skeletonRows("#workflows", 7, 4); skeletonTiles("#systiles", 8);
__CHARTS__
  function renderSystem(d) {
    // Snapshots before v0.0.51 measured GitHub Actions ("actions"); now the pool's own jobs.
    var m = d.metrics, a = m && (m.jobs || m.actions), w = m && m.workers;
    var pool = d.pool, refAny = pool.referenced_by_any_release || {}, rec = pool.reclaimable || { objects: 0, bytes: 0 };
    var ringBytes = d.rings.reduce(function (x, r) { return x + (r.bytes || 0); }, 0);
    var pending = Math.max(0, (pool.objects || 0) - (refAny.objects || 0));
    var lastSyncEv = newest(d.latest, "sync"), synced = (d.coverage || []).filter(function (c) { return c.upstream_total != null; }).length, expected = (d.coverage || []).length;
    var sec = d.security || {}, secEv = latest(d.latest, "security");
    var now = new Date(), utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
    // Promotion is by evidence: the gate's last word per step, not a clock.
    var gateRc = latest(d.latest, "gate", "rc", "edge"), gateStable = latest(d.latest, "gate", "stable", "rc");
    var gateWord = function (g) { if (!g) return "no attempt yet"; var v = (g.payload && g.payload.verdict) || (g.status === "ok" ? "promote" : g.status === "warn" ? "skip" : "block"); return (v === "promote" ? "promoted" : v === "skip" ? "nothing new" : "blocked") + " " + ago(g.created_at); };
    var tiles = [
      ["Jobs running now", a ? num(a.running) : "—", a ? "pool jobs leased or queued" + (w ? " · " + num(w.alive) + " worker(s) alive, " + num(w.busy) + " busy" : "") : "no metrics snapshot yet"],
      ["Jobs, 7 days", a ? num(a.runs) : "—", a ? num(a.failures) + " failed · " + num(a.runs - a.failures - a.running) + " succeeded" : ""],
      ["Worker minutes, 7 days", a ? num(a.minutes) : "—", "on the project's workers, both architectures"],
      ["Sources", synced + " / " + expected, lastSyncEv ? "last sync " + ago(lastSyncEv.created_at) + " · every 3 hours" : "no sync yet"],
      ["Promotion, by evidence", "edge → rc: " + gateWord(gateRc), "rc → stable: " + gateWord(gateStable) + " · after every sync, then every 3 h; two green checks make stable"],
      ["Security data", sec.updated_at ? ago(sec.updated_at) : "never", num(sec.advisories) + " advisories · Arch + Debian trackers, KEV, EPSS · every 3 h" + (secEv && secEv.status !== "ok" ? " · last run " + secEv.status : "")],
      ["Stored once", bytes(pool.bytes), num(pool.objects) + " objects, one per sha256"],
      ["Served by the rings", bytes(ringBytes), "what three copied trees would hold"],
      ["Reclaimable", bytes(rec.bytes), num(rec.objects) + " objects past retention" + (pending ? " · " + num(pending) + " awaiting a release" : "")],
      ["Snapshot", m ? ago(m.recorded_at) : "never", m ? "the pool measures itself every 30 minutes" : "no snapshot yet"],
      ["Estimated bill", "…", "Cloudflare, this month"]
    ];
    setTiles("#systiles", tiles);
    // The bill, estimated once a day from Cloudflare's analytics (cost.ts); the guard pauses writing jobs over budget.
    fetch("/api/v1/cost").then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
      var cell = $("#systiles").children[tiles.length - 1]; if (!cell) return;
      if (!c) { setTile(cell, '<div class="k">Estimated bill</div><div class="v num">—</div><div class="s">no estimate yet (every three hours)</div>'); return; }
      var color = c.status === "error" ? "var(--red)" : c.status === "warn" ? "var(--amber)" : "inherit";
      setTile(cell, '<div class="k">Estimated bill</div><div class="v num" style="color:' + color + '">US$ ' + Number(c.projected_usd).toFixed(2) + '</div><div class="s">projected for ' + esc(c.month) + ' · US$ ' + Number(c.month_to_date_usd).toFixed(2) + ' so far · ' + ago(c.estimated_at) + (c.guard ? ' · <b>over budget: writing jobs paused</b>' : '') + '</div>');
    }).catch(function () {});

    var S = d.series || {};
    $("#c-pool").innerHTML = area((S.metrics || []).map(function (r) { return { t: Date.parse(r.created_at), v: Number(r.bytes || 0) }; }), bytes) +
      (S.metrics && S.metrics.length ? '<div class="legend"><span><i style="background:' + C.green + '"></i>' + num(S.metrics[S.metrics.length - 1].objects) + ' objects now</span></div>' : '');

    var days14 = lastDays(14), byDay = {};
    (S.imports_daily || []).forEach(function (r) { byDay[r.day] = r; });
    $("#c-imports").innerHTML = bars(days14.map(function (dd) { var r = byDay[dd]; return { label: dd.slice(5), value: r ? Number(r.packages) : 0, title: dd + ": " + (r ? num(r.packages) + " packages, " + bytes(r.bytes) + " in " + r.runs + " run(s)" : "no sync") }; }), num);

    var RINGS = ["edge", "rc", "stable"], ARCHES = ["x86_64", "aarch64"], cells = {};
    (S.health || []).forEach(function (h) { var k = h.ring + "/" + h.arch + "/" + day(h.created_at); cells[k] = worst(cells[k], h.status); });
    var rows = []; RINGS.forEach(function (r) { ARCHES.forEach(function (ar) { rows.push({ key: r + "/" + ar, label: r + " " + ar }); }); });
    $("#c-health").innerHTML = heat(rows, days14, function (k, dd) { return cells[k + "/" + dd] || null; }) +
      '<div class="legend"><span><i style="background:' + C.green + '"></i>ok</span><span><i style="background:' + C.amber + '"></i>warn (nothing rendered)</span><span><i style="background:' + C.red + '"></i>error</span><span><i style="background:' + C.dim + ';opacity:.5"></i>no check</span></div>';

    var runs = (S.sync_runs || []).slice().reverse().filter(function (r) { return r.bytes && r.duration_ms; });
    $("#c-sync").innerHTML = bars(runs.map(function (r) { var mbs = Number(r.bytes) / 1048576 / (Number(r.duration_ms) / 1000); return { label: r.source.slice(0, 5) + (r.arch === "aarch64" ? "/arm" : ""), value: Math.round(mbs * 10) / 10, color: r.status === "ok" ? C.green : C.amber, title: r.source + " " + r.arch + " " + ago(r.created_at) + ": " + num(r.uploaded) + " packages, " + bytes(r.bytes) + " in " + dur(r.duration_ms) + " → " + (Math.round(mbs * 10) / 10) + " MB/s" + (r.concurrency ? " with " + r.concurrency + " workers" : "") }; }), function (v) { return v + " MB/s"; });

    var jd = S.jobs_daily || [], byKind = {}, byD = {};
    jd.forEach(function (r) { var k = byKind[r.kind] = byKind[r.kind] || { done: 0, failed: 0, waiting: 0, ms: 0 }; if (r.status === "done") k.done += Number(r.n); else if (r.status === "failed" || r.status === "cancelled") k.failed += Number(r.n); else k.waiting += Number(r.n); k.ms += Number(r.ms || 0);
      var dd = byD[r.day] = byD[r.day] || { runs: 0, failures: 0, ms: 0 }; dd.runs += Number(r.n); if (r.status === "failed") dd.failures += Number(r.n); dd.ms += Number(r.ms || 0); });
    $("#c-jobs").innerHTML = hbars(Object.keys(byKind).sort(function (a, b) { return (byKind[b].done + byKind[b].failed) - (byKind[a].done + byKind[a].failed); }).map(function (k) { var v = byKind[k]; return { label: k, note: num(v.done + v.failed + v.waiting) + " · " + Math.round(v.ms / 60000) + " min", parts: [{ v: v.done, color: C.green, name: "done" }, { v: v.failed, color: C.red, name: "failed" }, { v: v.waiting, color: C.blue, name: "waiting" }] }; })) +
      '<div class="legend"><span><i style="background:' + C.green + '"></i>done</span><span><i style="background:' + C.red + '"></i>failed</span><span><i style="background:' + C.blue + '"></i>queued / running</span></div>';
    // The shell's builds per day (staged, published, failed), as one bar a day here: red on a day more builds failed than got through.
    var builds = buildsByDay(S, 14);
    $("#c-builds").innerHTML = bars(builds.labels.map(function (dd, i) { var staged = builds.days[i].staged, published = builds.days[i].published, failed = builds.days[i].failed; return { label: dd.slice(5), value: staged + published + failed, color: failed > published + staged ? C.red : C.green, title: dd + ": " + staged + " staged, " + published + " published, " + failed + " failed" }; }), function (v) { return v + " build(s)"; });
    $("#c-minutes").innerHTML = bars(lastDays(7).map(function (dd) { var r = byD[dd]; return { label: dd.slice(5), value: r ? Math.round(r.ms / 60000) : 0, color: C.blue, title: dd + ": " + (r ? Math.round(r.ms / 60000) + " min in " + r.runs + " jobs, " + r.failures + " failed" : "no jobs") }; }), function (v) { return v + " min"; });

    // One row per job kind: what the journal's latest entry says, and the week's totals.
    var kinds = Object.keys(byKind).sort().map(function (k) { var v = byKind[k], l = (d.latest || []).filter(function (e) { return e.kind === k; }).sort(function (x, y) { return Date.parse(y.created_at) - Date.parse(x.created_at); })[0]; return { kind: k, last: l, runs: v.done + v.failed + v.waiting, failed: v.failed, running: v.waiting, minutes: Math.round(v.ms / 60000) }; });
    pager("#workflows", kinds, function (w) {
      var l = w.last, st = l ? l.status : "—", cls = st === "ok" ? "ok" : st === "error" ? "error" : st === "warn" ? "warn" : "";
      return '<tr><td>' + esc(w.kind) + '</td><td><span class="dot ' + cls + '"></span>' + esc(st) + (l ? ' <span class="when">' + ago(l.created_at) + '</span>' : '') + '</td><td class="num">' + num(w.runs) + '</td><td class="num">' + (w.failed ? '<span style="color:var(--red)">' + num(w.failed) + '</span>' : '0') + '</td><td class="num">' + (w.running ? '<span style="color:var(--blue)">' + num(w.running) + '</span>' : '0') + '</td><td class="num">' + num(w.minutes) + '</td></tr>';
    }, { empty: 'no jobs yet — the pool queues them on schedule and project workers pull them', n: 25 });
  }

  // OPR recipes by origin: the AUR-synced count in stable is the number to drive to zero.
  function renderProvenance(d) {
    var pv = d.provenance && d.provenance.stable; var el = $("#provenance"); if (!pv || !el || !pv.packages) return;
    el.hidden = false;
    el.innerHTML = '<b>OPR recipes in stable:</b> ' + num(pv.packages) + ' packages — ' + num(pv.local) + " Omarchy's own, <b>" + num(pv.aur) + ' still synced from the AUR</b>' + (pv.unknown ? ', ' + num(pv.unknown) + ' of unknown origin' : '') + ' (<a href="https://github.com/omacom/omarchy-pkgs/tree/master/pkgbuilds">omarchy-pkgs</a>, read daily; each package page says which). The AUR number is the one to drive to zero.';
  }
  // Architecture-independent packages stored once per architecture: Arch Linux ARM rebuilds and re-signs them.
  function renderAny(d) {
    var a = d.any && d.any.stable; var el = $("#any"); if (!a || !el || !a.names) return;
    el.hidden = false;
    el.innerHTML = '<b>Architecture-independent packages in stable:</b> ' + num(a.names) + ' (' + num(a.objects) + ' objects, ' + bytes(a.bytes) + ') — ' + num(a.twice) + ' of them stored twice, once per architecture, because Arch Linux ARM rebuilds and re-signs <code>any</code> packages: ' + bytes(a.extra_bytes) + ' the pool would not need if one signed object served both.';
  }
  function renderCoverage(d) {
    renderProvenance(d);
    renderAny(d);
    var cov = (d.coverage || []).slice().sort(function (a, b) { return a.arch === b.arch ? (a.source < b.source ? -1 : 1) : (a.arch === "x86_64" ? -1 : 1); });
    var tot = cov.reduce(function (t, c) { t.up += c.upstream_total || 0; t.have += c.indexed; t.miss += c.missing || 0; t.bytes += c.bytes; t.pending += c.upstream_total == null ? 1 : 0; return t; }, { up: 0, have: 0, miss: 0, bytes: 0, pending: 0 });
    function pctOf(have, up) { if (!up) return 0; var p = 100 * have / up; return p >= 100 ? 100 : Math.floor(p); }
    pager("#coverage", cov, function (c) {
      var pending = c.upstream_total == null, pct = pctOf(c.indexed, c.upstream_total);
      return '<tr><td title="' + esc(c.upstream || "") + '">' + esc(c.source) + '</td><td>' + esc(c.arch) + '</td><td class="num">' + (pending ? '—' : num(c.upstream_total)) + '</td><td class="num">' + num(c.indexed) + '</td><td class="num">' + (pending ? '—' : c.missing ? '<span style="color:var(--amber)">' + num(c.missing) + '</span>' : '0') + '</td><td class="num">' + num(c.pinned_stable) + '</td>' +
        '<td>' + (pending ? pillHtml("none", "not synced yet") : '<span class="bar"><i class="' + (pct < 100 ? 'partial' : '') + '" style="width:' + pct + '%"></i></span><span class="pct">' + pct + '%</span>') + '</td><td class="num">' + bytes(c.bytes) + '</td><td class="when" title="' + esc(c.last_sync || "") + '">' + (pending ? '—' : ago(c.last_sync) + (c.last_status !== "ok" ? ' ' + pillHtml(c.last_status, c.last_status) : '')) + '</td></tr>';
    }, { n: 25 });
  }


  function render(d) {
    var RINGS = ["stable", "rc", "edge"], ARCHES = ["x86_64", "aarch64"];
    var problems = problemsOf(d);
    var lastSync = newest(d.latest, "sync");
    var healthRows = [];
    RINGS.forEach(function (ring) {
      var r = d.rings.filter(function (x) { return x.ring === ring; })[0] || {};
      ARCHES.forEach(function (arch) {
        var h = latest(d.latest, "health", ring, arch);
        var dbs = (r.artifacts || []).filter(function (a) { return a.kind === "db" && a.arch === arch; });
        if (!dbs.length && !(r.sources || []).some(function (s) { return s.arch === arch; })) return;
        healthRows.push('<tr><td>' + ring + '</td><td>' + arch + '</td><td>' + (h ? pillHtml(h.status, h.status) : pillHtml("none", "none")) + '</td><td class="when">' + (h ? ago(h.created_at) : "—") + '</td><td>' + (r.release ? "#" + r.release.seq : "—") + '</td><td class="when">' + (r.release ? ago(r.release.created_at) : "—") + '</td><td>' + (dbs.length ? dbs.map(function (a) { return '<code>' + esc(a.repo) + '</code>'; }).join(" ") : '<span class="muted">not rendered</span>') + '</td></tr>');
      });
    });
    $("#rings tbody").innerHTML = healthRows.join("") || '<tr><td colspan="7" class="muted">no rings yet</td></tr>';

    $("#sources tbody").innerHTML = (d.coverage || []).map(function (c) {
      var isLate = c.last_sync && Date.now() - Date.parse(c.last_sync) > 6 * 3600e3;
      return '<tr><td>' + esc(c.source) + '</td><td>' + esc(c.arch) + '</td><td class="when">' + (c.last_sync ? ago(c.last_sync) + (isLate ? ' ' + pillHtml("warn", "late") : '') : pillHtml("none", "never")) + '</td><td>' + (c.last_status ? pillHtml(c.last_status, c.last_status) : '—') + '</td><td class="num">' + (c.upstream_total == null ? "—" : num(c.upstream_total)) + '</td><td class="num">' + num(c.indexed) + '</td><td class="num">' + (c.missing == null ? "—" : num(c.missing)) + '</td></tr>';
    }).join("");

    var incidents = d.events.filter(function (e) { return e.kind === "rollback" || e.status === "error" || (e.kind === "gate" && e.payload && e.payload.verdict === "block"); });
    $("#incidents tbody").innerHTML = incidents.map(function (e) {
      var run = e.payload && e.payload.ci && e.payload.ci.run_url;
      return '<tr><td><span class="dot ' + e.status + '"></span>' + e.status + '</td><td><span class="kind">' + esc(e.kind) + '</span></td><td>' + esc(e.ring || "") + '</td><td>' + (run ? '<a class="run" href="' + esc(run) + '">' + esc(e.summary) + '</a>' : esc(e.summary)) + '</td><td class="when">' + ago(e.created_at) + '</td></tr>';
    }).join("") || '<tr><td colspan="5" class="muted">none in the last 40 journal entries</td></tr>';

    $("#headline").innerHTML = problems.length
      ? '<span style="color:var(--amber)">Pipeline behind:</span> ' + esc(problems.join("; ")) + '. The rings keep serving what they have; the journal below shows what the pipeline is doing about it.'
      : '<span style="color:var(--green)">Pipeline keeping up.</span> Every source synced recently, every ring passed its latest health check.';
    var stable = d.rings.filter(function (r) { return r.ring === "stable"; })[0] || {};
    renderCoverage(d); renderSystem(d); endSkeleton();
    setTiles("#tiles", [
      ["Stable", stable.release ? "#" + stable.release.seq : "—", stable.release ? "moved " + ago(stable.release.created_at) : "no release"],
      ["Last sync", lastSync ? ago(lastSync.created_at) : "never", lastSync ? esc(lastSync.summary) : ""],
      ["Incidents", num(incidents.length), "in the last 40 journal entries"]
    ]);
  }
  function renderService() {
    fetch("/api/v1/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      var items = [
        ["ok", "API", "answering · " + esc(s.checked_at.replace("T", " ").slice(0, 19)) + " UTC"],
        [s.index.ok ? "ok" : "error", "index · D1", s.index.ok ? s.index.ms + " ms" : esc(s.index.error || "failed")],
        [s.pool.ok ? "ok" : "error", "pool · R2", s.pool.ok ? s.pool.ms + " ms" : esc(s.pool.error || "failed")],
        [s.signing ? "ok" : "warn", "signing", s.signing ? "the pool's key is loaded" : "no signing key"]
      ];
      $("#service").innerHTML = items.map(function (t) { return '<div><i class="led ' + t[0] + '"></i><b>' + t[1] + '</b><span>' + t[2] + '</span></div>'; }).join("");
    }).catch(function (e) {
      $("#service").innerHTML = '<div><i class="led error"></i><b>API</b><span>down · ' + esc(String(e)) + '</span></div>';
    });
  }
  renderService(); setInterval(renderService, 60000);
  liveStats(render, 60000);
`;

export function statusHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Status · omarchy-pool",
    description: "Is the pool serving, is it being fed, and did anything go wrong recently.",
    active: "none",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}

/**
 * What /status is made of.
 * Everything here reads /api/v1/stats but the service check (/api/v1/status)
 * and the bill (/api/v1/cost); nothing changes with the role, and the page
 * has no action of its own — the pagers' filter and page size are the
 * shell's.
 */
export const STATUS_COMPONENTS = (_F: Fixture): Component[] => [
  {
    id: "status.hero",
    page: "/status",
    anchor: ["<h1>Is it up, is it keeping up, is every ring healthy</h1>", 'id="headline"'],
    script: ['"#headline"', "problemsOf(d)", "Pipeline keeping up.", "liveStats(render, 60000)"],
    reads: [{ path: "/api/v1/stats", fields: ["latest", "latest.0.kind", "latest.0.status", "latest.0.created_at", "latest.0.ring", "latest.0.source", "coverage.0.last_sync"] }],
    visible: EVERYONE,
  },
  {
    id: "status.service",
    page: "/status",
    anchor: ["<h2>Service</h2>", 'id="service"'],
    script: ['"/api/v1/status"', '"#service"', "s.index.ok", "s.pool.ok", "s.signing", "setInterval(renderService, 60000)"],
    reads: [{ path: "/api/v1/status", fields: ["checked_at", "index.ok", "index.ms", "pool.ok", "pool.ms", "signing"] }],
    visible: EVERYONE,
  },
  {
    id: "status.pipeline-pill",
    page: "/status",
    anchor: ['id="pipeline-state"'],
    script: ['"#pipeline-state"', "pipelineFrom(d)"],
    reads: [{ path: "/api/v1/stats", fields: ["latest.0.kind", "latest.0.status", "latest.0.created_at", "coverage.0.last_sync"] }],
    visible: EVERYONE,
  },
  {
    id: "status.pipeline-tiles",
    page: "/status",
    anchor: ['id="tiles"'],
    script: ['setTiles("#tiles"', '"Stable"', '"Last sync"', '"Incidents"', "stable.release.seq"],
    reads: [{ path: "/api/v1/stats", fields: ["rings.2.ring", "rings.2.release.seq", "rings.2.release.created_at", "latest.0.kind", "latest.0.created_at", "latest.0.summary", "events", "events.0.kind", "events.0.status"] }],
    visible: EVERYONE,
  },
  {
    id: "status.rings-table",
    page: "/status",
    anchor: ['id="rings"', "<th>Health</th>", "<th>Databases</th>"],
    script: ['"#rings tbody"', 'latest(d.latest, "health", ring, arch)', 'a.kind === "db"', "r.sources", "no rings yet"],
    reads: [
      {
        path: "/api/v1/stats",
        fields: [
          "rings.2.ring", "rings.2.release.seq", "rings.2.release.created_at", "rings.2.sources.0.arch",
          "rings.2.artifacts.0.kind", "rings.2.artifacts.0.arch", "rings.2.artifacts.0.repo",
          "latest.0.kind", "latest.0.status", "latest.0.created_at", "latest.0.ring", "latest.0.source",
        ],
      },
    ],
    visible: EVERYONE,
  },
  {
    id: "status.sources-table",
    page: "/status",
    anchor: ['id="sources"', "<th>Last sync</th>", "<th>Result</th>"],
    script: ['"#sources tbody"', "c.last_sync", "isLate", 'pillHtml("warn", "late")'],
    reads: [{ path: "/api/v1/stats", fields: ["coverage", "coverage.0.source", "coverage.0.arch", "coverage.0.last_sync", "coverage.0.last_status", "coverage.0.upstream_total", "coverage.0.indexed", "coverage.0.missing"] }],
    visible: EVERYONE,
  },
  {
    id: "status.coverage-table",
    page: "/status",
    anchor: ['id="coverage"', '<th class="num">In stable</th>', "<th>Progress</th>"],
    script: ['pager("#coverage"', "c.pinned_stable", "c.upstream_total", "not synced yet"],
    reads: [
      {
        path: "/api/v1/stats",
        fields: ["coverage.0.source", "coverage.0.arch", "coverage.0.upstream", "coverage.0.upstream_total", "coverage.0.indexed", "coverage.0.missing", "coverage.0.pinned_stable", "coverage.0.bytes", "coverage.0.last_sync", "coverage.0.last_status"],
      },
    ],
    visible: EVERYONE,
  },
  {
    id: "status.provenance-note",
    page: "/status",
    anchor: ['id="provenance" hidden'],
    script: ['"#provenance"', "d.provenance && d.provenance.stable", "pv.aur", "pv.unknown"],
    reads: [{ path: "/api/v1/stats", fields: ["provenance.stable.packages", "provenance.stable.local", "provenance.stable.aur", "provenance.stable.unknown"] }],
    visible: EVERYONE,
  },
  {
    id: "status.any-note",
    page: "/status",
    anchor: ['id="any" hidden'],
    script: ['"#any"', "d.any && d.any.stable", "a.twice", "a.extra_bytes"],
    reads: [{ path: "/api/v1/stats", fields: ["any.stable.names", "any.stable.objects", "any.stable.bytes", "any.stable.twice", "any.stable.extra_bytes"] }],
    visible: EVERYONE,
  },
  {
    id: "status.numbers-heading",
    page: "/status",
    anchor: ["<h2>The pipeline, in numbers</h2>", '<a class="more-link" href="/pipeline">Watch it run →</a>'],
    visible: EVERYONE,
  },
  {
    id: "status.system-tiles",
    page: "/status",
    anchor: ['id="systiles"'],
    script: ['setTiles("#systiles"', "m.jobs || m.actions", '"Jobs running now"', '"Promotion, by evidence"', 'latest(d.latest, "gate", "rc", "edge")', "pool.referenced_by_any_release", "pool.reclaimable", "sec.updated_at"],
    reads: [
      {
        path: "/api/v1/stats",
        fields: [
          "metrics.recorded_at", "metrics.jobs.running", "metrics.jobs.runs", "metrics.jobs.failures", "metrics.jobs.minutes", "metrics.workers.alive", "metrics.workers.busy",
          "pool.objects", "pool.bytes", "pool.referenced_by_any_release.objects", "pool.reclaimable.objects", "pool.reclaimable.bytes",
          "rings.0.bytes", "coverage.0.upstream_total", "latest.0.kind", "latest.0.status", "latest.0.created_at",
          "security.updated_at", "security.advisories",
        ],
      },
    ],
    visible: EVERYONE,
  },
  {
    id: "status.bill-tile",
    page: "/status",
    anchor: ['id="systiles"'],
    script: ['"/api/v1/cost"', '"Estimated bill"', "c.projected_usd", "c.month_to_date_usd", "c.estimated_at", "c.guard", "over budget: writing jobs paused"],
    reads: [{ path: "/api/v1/cost", fields: ["status", "projected_usd", "month", "month_to_date_usd", "estimated_at", "guard"] }],
    visible: EVERYONE,
  },
  {
    id: "status.chart-pool",
    page: "/status",
    anchor: ['id="c-pool"', "<h3>Pool growth <span>7 days</span></h3>"],
    script: ['"#c-pool"', "S.metrics", "r.bytes", "objects now"],
    reads: [{ path: "/api/v1/stats", fields: ["series.metrics", "series.metrics.0.created_at", "series.metrics.0.bytes", "series.metrics.0.objects"] }],
    visible: EVERYONE,
  },
  {
    id: "status.chart-imports",
    page: "/status",
    anchor: ['id="c-imports"', "<h3>Imports per day <span>14 days</span></h3>"],
    script: ['"#c-imports"', "S.imports_daily", "r.packages", "r.runs"],
    reads: [{ path: "/api/v1/stats", fields: ["series.imports_daily", "series.imports_daily.0.day", "series.imports_daily.0.packages", "series.imports_daily.0.bytes", "series.imports_daily.0.runs"] }],
    visible: EVERYONE,
  },
  {
    id: "status.chart-health",
    page: "/status",
    anchor: ['id="c-health"', "<h3>Health <span>14 days</span></h3>"],
    script: ['"#c-health"', "S.health", "h.ring", "h.arch", "worst(cells[k], h.status)"],
    reads: [{ path: "/api/v1/stats", fields: ["series.health", "series.health.0.ring", "series.health.0.arch", "series.health.0.created_at", "series.health.0.status"] }],
    visible: EVERYONE,
  },
  {
    id: "status.chart-sync",
    page: "/status",
    anchor: ['id="c-sync"', "<h3>Sync throughput <span>last runs</span></h3>"],
    script: ['"#c-sync"', "S.sync_runs", "r.duration_ms", "r.uploaded", "r.concurrency"],
    reads: [
      {
        path: "/api/v1/stats",
        fields: ["series.sync_runs", "series.sync_runs.0.source", "series.sync_runs.0.arch", "series.sync_runs.0.status", "series.sync_runs.0.bytes", "series.sync_runs.0.duration_ms", "series.sync_runs.0.uploaded", "series.sync_runs.0.concurrency", "series.sync_runs.0.created_at"],
      },
    ],
    visible: EVERYONE,
  },
  {
    id: "status.chart-minutes",
    page: "/status",
    anchor: ['id="c-minutes"', "<h3>Worker minutes <span>per day</span></h3>"],
    script: ['"#c-minutes"', "S.jobs_daily", "byD[r.day]", "r.ms / 60000", '" min"'],
    reads: [{ path: "/api/v1/stats", fields: ["series.jobs_daily", "series.jobs_daily.0.day", "series.jobs_daily.0.status", "series.jobs_daily.0.n", "series.jobs_daily.0.ms"] }],
    visible: EVERYONE,
  },
  {
    id: "status.chart-jobs",
    page: "/status",
    anchor: ['id="c-jobs"', "<h3>Pool jobs <span>7 days</span></h3>"],
    script: ['"#c-jobs"', "hbars(", "byKind[r.kind]", 'r.status === "done"', "queued / running"],
    reads: [{ path: "/api/v1/stats", fields: ["series.jobs_daily.0.kind", "series.jobs_daily.0.status", "series.jobs_daily.0.n", "series.jobs_daily.0.ms"] }],
    visible: EVERYONE,
  },
  {
    id: "status.chart-builds",
    page: "/status",
    anchor: ['id="c-builds"', "<h3>Factory builds <span>14 days</span></h3>"],
    script: ['"#c-builds"', "buildsByDay(S, 14)", "failed > published + staged", '" build(s)"'],
    reads: [{ path: "/api/v1/stats", fields: ["series.builds_daily", "series.builds_daily.0.day", "series.builds_daily.0.status", "series.builds_daily.0.n"] }],
    visible: EVERYONE,
  },
  {
    id: "status.workflows-table",
    page: "/status",
    anchor: ['id="workflows"', "<th>Job</th>", '<th class="num">Runs 7d</th>'],
    script: ['pager("#workflows"', "e.kind === k", "w.running", "w.minutes", "no jobs yet"],
    reads: [{ path: "/api/v1/stats", fields: ["series.jobs_daily.0.kind", "series.jobs_daily.0.status", "series.jobs_daily.0.n", "series.jobs_daily.0.ms", "latest.0.kind", "latest.0.status", "latest.0.created_at"] }],
    visible: EVERYONE,
  },
  {
    id: "status.incidents-table",
    page: "/status",
    anchor: ["<h2>Incidents</h2>", 'id="incidents"'],
    script: ['"#incidents tbody"', 'e.kind === "rollback"', 'e.payload.verdict === "block"', "e.summary", "none in the last 40 journal entries"],
    reads: [{ path: "/api/v1/stats", fields: ["events", "events.0.kind", "events.0.status", "events.0.ring", "events.0.summary", "events.0.created_at", "events.0.payload"] }],
    visible: EVERYONE,
  },
];
