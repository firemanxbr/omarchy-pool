/**
 * The Pipeline: the same page for users, contributors and maintainers — only
 * the buttons differ. A living picture of what is being verified, promoted
 * and checked right now (the journal, as it happens); how fast maintainers
 * decide and where a contributor's build sits in the queue; and, for the
 * people who run it, the operations: the queue, the charts, the ring
 * heads, the journal, what it costs — and how to help. The workers
 * themselves have a page of their own (/workers), by kind.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { CHARTS } from "./charts";
import { archDiagram, liveDiagram } from "./diagrams";
import type { RunningVersion } from "../meta";
import { ESTIMATE_CADENCE } from "../cost";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">For everyone</p>
    <h1>The pipeline, as it runs right now</h1>
    <p class="lede">What is being verified, promoted and checked for you this very minute; how fast maintainers decide; who is building what, and what it costs. The same page for users, contributors and maintainers — only which buttons are live differs.</p>
  </div>
  <div class="state-row" id="state"><span class="pill none">checking…</span></div>

  <section id="live">
    <div class="h2row"><h2>A living system</h2><a class="more-link" href="/docs/security#feeds">What each security feed contributes →</a></div>
    <p class="sub">Every three hours: packages are verified and promoted, five security feeds are matched against what every ring serves, and a confident fix does not wait for the soak.</p>
    <figure class="diagram live-diagram">${liveDiagram()}<figcaption>Green marks are packages on their way to <code>stable</code>; amber marks are advisories being matched against each ring. The dashed arc is the fast-track. The numbers are the pool's own.</figcaption></figure>
    <div class="live-grid" style="margin-top:16px">
      <div class="ticker"><div class="head"><span class="live"><i></i>live</span><span>the journal, as it happens · every 20 s</span></div><div id="feed"><div class="muted">loading…</div></div></div>
      <div><div class="counters" id="counters"></div><p class="sub" style="margin:14px 0 0;font-size:13px">Nothing here is a promise: every line links to the run that produced it, and every decision carries a name. <a href="/journal">The whole journal →</a></p></div>
    </div>
  </section>

  <section id="throughput">
    <div class="h2row"><h2>Review throughput</h2><a class="more-link" href="/docs/governance">How a decision is made →</a></div>
    <p class="sub">How fast new packages arrive and how fast maintainers decide. A wait is a queue, not a verdict.</p>
    <div class="flow" id="flow"></div>
    <div class="charts" style="margin-top:16px">
      <div class="chart"><h3>Decisions per week <span>8 weeks</span></h3><div class="sub">what maintainers approved and what they sent back</div><div id="c-decisions"></div></div>
      <div class="chart"><h3>Arrivals vs decisions <span>8 weeks</span></h3><div class="sub">packages registered, packages decided — the gap is the queue</div><div id="c-arrivals"></div></div>
      <div class="chart"><h3>Who is deciding <span>on the record</span></h3><div class="sub">decisions per maintainer</div><div class="maint-list" id="deciders" style="margin-top:8px"></div><div id="queue-pos"></div></div>
    </div>
  </section>

  <div class="h2row" id="operations" style="border-top:1px solid var(--line);padding-top:28px;margin-bottom:4px"><h2>Operations</h2><span class="hint" id="ops-who">read-only — approving and rolling back need the maintainer role</span></div>
  <div class="tiles six" id="tiles"></div>

  <section>
    <div class="h2row"><h2>How it runs</h2><a class="more-link" href="/docs/factory">The factory in detail →</a></div>
    <p class="sub">One brain queues, workers claim with a lease, objects land on R2, rings are rendered and signed. Live numbers on the mechanism.</p>
    <figure class="diagram">${archDiagram()}<figcaption>Every job runs on a registered worker. Contributors' builds are evidence; the review worker builds again what a maintainer asks for, and approve publishes that build. A lease that expires puts the task back in the queue. <a href="/workers">Every worker, by kind →</a></figcaption></figure>
  </section>

  <section>
    <div class="h2row"><h2>Review queue</h2><a class="more-link" href="/review">Decisions and the audit →</a></div>
    <p class="sub">Evidence, not packages. Build by the project queues a rebuild on the review worker; approve publishes the project's build; reject sends a note back.</p>
    <div class="table-wrap"><table id="staged"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Built by</th><th>Evidence</th><th>Audit</th><th>Waiting</th><th class="decision">Decision</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>The last two weeks</h2><a class="more-link" href="/status">Every chart on the Status page →</a></div>
    <div class="charts">
      <div class="chart"><h3>Pool jobs <span>7 days</span></h3><div class="sub">sync, promote, health, security, gc: done, failed, waiting</div><div id="c-jobs"></div></div>
      <div class="chart"><h3>Promotions <span>14 days</span></h3><div class="sub">edge → rc and rc → stable: promoted, blocked by a check, rolled back</div><div id="c-promos"></div></div>
      <div class="chart"><h3>Health <span>14 days</span></h3><div class="sub">worst result per day, per ring and architecture</div><div id="c-health"></div></div>
      <div class="chart"><h3>Imports per day <span>14 days</span></h3><div class="sub">packages brought into the pool by the sync runs</div><div id="c-imports"></div></div>
      <div class="chart"><h3>Sync throughput <span>last runs</span></h3><div class="sub">MB/s per sync run, one worker each</div><div id="c-sync"></div></div>
      <div class="chart"><h3>Factory builds <span>14 days</span></h3><div class="sub">staged, published, failed</div><div id="c-builds"></div></div>
    </div>
  </section>

  <section>
    <div class="h2row"><h2>Build tasks</h2><span class="hint">leased first, then queued, then the most recent finished; three attempts, then failed; a pool job's row says what it did</span></div>
    <div class="table-wrap"><table id="tasks"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Status</th><th>Reason</th><th>Worker</th><th>Took</th><th>Result</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Requested packages</h2><a class="more-link" href="/factory">Request one →</a></div>
    <p class="sub">Every package a contributor asked for — each request written once to the record and signed by the pool — and where it stands.</p>
    <div class="table-wrap"><table id="registry"><thead><tr><th>Package</th><th>Project</th><th>Owner</th><th>Arches</th><th>Version · licence</th><th>Stage</th><th>Detail</th><th>Updated</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Rings and the journal</h2><a class="more-link" href="/journal">Ring history, diffs, rollback →</a></div>
    <div class="heads" id="heads"></div>
    <p class="sub" id="rb-state" hidden style="margin-top:10px"></p>
    <div class="table-wrap" style="margin-top:16px"><table id="events"><thead><tr><th>Status</th><th>What</th><th>Ring</th><th>Source / arch</th><th>Summary</th><th class="num">Took</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Cost, in the open</h2><span class="hint">Cloudflare, estimated ${ESTIMATE_CADENCE} from its analytics</span></div>
    <p class="sub">D1 rows read and written are most of the bill. Estimated ${ESTIMATE_CADENCE}; the report warns from US$ <span data-live="cost-warn">…</span>, the guard pauses the jobs that write at US$ <span data-live="cost-guard">…</span>, the cap is US$ <span data-live="cost-cap">…</span>; the daily report says why.</p>
    <div class="budget" id="budget"><div><div class="k">this month</div><b>…</b></div><div><div class="k">projected</div><b>…</b></div><div class="bar"><i style="width:0"></i></div></div>
    <div class="sponsor"><div><p><b>Help keep it running.</b> The pool runs on one pocket: the brain on Cloudflare, one machine building for both architectures, and the agent tokens that draft and audit PKGBUILDs. More hardware means shorter queues; more tokens mean every build gets an audit.</p><div class="needs"><span class="pill lilac">an aarch64 builder</span><span class="pill lilac">an x86_64 builder</span><span class="pill lilac">agent tokens</span><span class="pill lilac">a mirror in another region</span></div></div>
    <div class="side"><a class="mail" href="mailto:sponsor@omarchy-pool.org">sponsor@omarchy-pool.org</a><span class="promise">Every contribution shows up on this page, and the code stays open source — that is the deal.</span></div></div>
  </section>
`;

const SCRIPT = String.raw`
__CHARTS__

  // What a pool job was asked, in words, from the params the brain wrote
  // when it queued the job (src/scheduler.ts syncJobFor, src/jobs.ts): the
  // scheduler's sync is one task per architecture with every source of it
  // as a JSON list in sources; a sync queued by hand for one source
  // names it; promote and rollback name their rings; render, health and
  // verify a ring and an architecture; gc how many releases to keep.
  function paramsLabel(t) {
    var p = t.params || {};
    if (t.kind === "sync" && p.sources) { var n = 0; try { n = JSON.parse(p.sources).length; } catch (e) {} return [p.arch, n + " source" + (n === 1 ? "" : "s")].filter(Boolean).join(" · "); }
    if (t.kind === "sync") return [p.source && p.arch ? p.source + "/" + p.arch : p.source, p.ring ? "→ " + p.ring : null].filter(Boolean).join(" ");
    if (t.kind === "promote") return [p.from && p.to ? p.from + " → " + p.to : null, p.arch, p.force === "yes" ? "forced" : null].filter(Boolean).join(" · ");
    if (t.kind === "rollback") return [p.ring && p.to ? p.ring + " → release " + p.to : p.ring, p.arch].filter(Boolean).join(" · ");
    if (t.kind === "gc") return p.keep ? "keep " + p.keep : "";
    if (t.kind === "verify") return [p.ring && p.arch ? p.ring + "/" + p.arch : p.ring || p.arch, p.repair === "no" ? "report only" : null].filter(Boolean).join(" · ");
    return p.ring && p.arch ? p.ring + "/" + p.arch : "";
  }
  // A pool job's result, in words: what it did rather than its JSON. The
  // shapes are what the Rust jobs post (crates/pkg-repo/src/work.rs, every
  // result: serde_json::json!), and test/pool-jobs.test.ts runs this
  // over one done job of every kind seeded as work.rs writes it — a field
  // renamed there and not here reads as a zero on the Pipeline, which is
  // what every sync row said until 2026-09-18: the scheduler had batched the
  // sync per architecture a week before and this read the one-source shape.
  function jobResult(t) {
    var r = t.result || {};
    var releaseWords = function (list) { return list.length ? " · release " + list.map(function (x) { return x.ring + " #" + x.seq; }).join(", ") : " · unchanged"; };
    if (t.kind === "sync" && r.sources) {
      var sum = { upstream_total: 0, uploaded: 0, removed: 0, failed: 0 }, down = [];
      r.sources.forEach(function (s) { if (s.error) down.push(s.source); Object.keys(sum).forEach(function (k) { sum[k] += Number(s[k] || 0); }); });
      return "upstream " + num(sum.upstream_total) + " · uploaded " + num(sum.uploaded) + " · removed " + num(sum.removed) + (sum.failed ? " · failed " + num(sum.failed) : "") + (down.length ? " · " + down.join(", ") + " down" : "") + releaseWords(r.releases || []);
    }
    if (t.kind === "sync") return "upstream " + num(r.upstream_total) + " · uploaded " + num(r.uploaded) + " · removed " + num(r.removed) + (r.failed ? " · failed " + num(r.failed) : "") + (r.release ? " · release #" + r.release[1] : " · unchanged");
    if (t.kind === "promote") {
      var p = t.params || {};
      return r.verdict === "promoted" ? "promoted → " + (p.to || "") + ", release " + r.release_id
        : r.verdict === "blocked" ? "blocked — " + (r.reasons || []).join("; ")
        : r.verdict === "rolled-back" ? "rolled back to release " + r.to + " — health failed on " + (r.unhealthy || []).join(", ")
        : r.verdict === "skip" ? "nothing to promote" + (r.why ? " — " + r.why : "") : JSON.stringify(r);
    }
    if (t.kind === "rollback") return r.ring + " rolled back to release " + r.to + " as release " + r.release_id;
    if (t.kind === "health") return r.ok ? "healthy" : "unhealthy";
    if (t.kind === "gc") return "kept the last " + r.keep + " releases per ring";
    if (t.kind === "render") return "rendered " + (r.repos || []).join(", ");
    if (t.kind === "security") return num(r.matches_vulnerable) + " vulnerable / " + num(r.matches_fixed) + " fixed matches · " + num(r.kev) + " in KEV" + ((r.fast_tracked || []).length ? " · fast-tracked into " + r.fast_tracked.map(function (f) { return f.ring + " (" + num(f.fixes) + " fix" + (f.fixes === 1 ? "" : "es") + ")"; }).join(", ") : " · nothing to fast-track") + ((r.rolled_back || []).length ? " · rolled back " + r.rolled_back.join(", ") : "");
    if (t.kind === "verify") return num(r.objects) + " objects" + (r.bad_signatures ? " · " + num(r.bad_signatures) + " bad signatures, " + num(r.repaired_signatures) + " repaired" : "") + (r.mismatched ? " · " + num(r.mismatched) + " mismatched, " + num(r.repinned) + " re-pinned" : "") + (r.unfixable ? " · " + num(r.unfixable) + " unfixable" : !r.bad_signatures && !r.mismatched ? " · all verify" : "");
    if (t.kind === "relayout") return num(r.moved) + " moved · " + num(r.ghosts) + " ghosts · " + num(r.missing) + " missing · " + num(r.purged) + " old keys purged" + ((r.errors || []).length ? " · " + num(r.errors.length) + " errors" : "");
    if (t.kind === "enqueue") return "main@" + String(r.commit || "").slice(0, 7) + ": " + num((r.queued || []).length) + " queued, " + num((r.skipped || []).length) + " skipped, " + num(r.up_to_date) + " up to date";
    return JSON.stringify(r).slice(0, 90);
  }
  function loadRegistry() {
    busy(fetch("/api/v1/factory/packages")).then(function (r) { return r.json(); }).then(function (d) {
      pager("#registry", d.packages || [], function (p) {
        var det = p.detected || {};
        var home = p.project || p.url;
        return '<tr><td><b>' + esc(p.name) + '</b>' + (p.request_id ? ' <a class="src" href="' + esc(POOL + "/factory/" + p.name + "/" + p.request_id + "/request.json") + '" title="the request, on the record">#' + p.request_id + '</a>' : '') + '</td><td><a href="' + esc(home) + '">' + esc(home.replace(/^https?:\/\/(www\.)?(github\.com\/)?/, "")) + '</a></td><td>' + esc(p.owner) + '</td><td>' + esc((p.arches || []).join(", ")) + '</td>' +
          '<td>' + esc([p.release || det.latest_tag, p.license || det.license].filter(Boolean).join(" · ")) + '</td><td>' + taskPill(p.status) + (p.staged_builds ? ' <span class="muted">' + p.staged_builds + ' staged</span>' : '') + '</td><td>' + esc(p.detail || "") + '</td><td>' + ago(p.updated_at) + '</td></tr>';
      }, { empty: 'no package requested yet — <a href="/factory">be the first</a>', text: function (p) { return [p.name, p.category, p.owner, p.url, p.status].join(" "); } });
    }).catch(function () { $("#registry tbody").innerHTML = ""; });
  }
  function renderTables(d) {
    loadRegistry();
    // The worker a task ran on is drawn as every table draws one (the shell's wtId, the whole id and its host on hover): the listing's row where it still has one, the bare id whole where the record no longer lists it — no owner guessed.
    var byId = {}; (d.workers || []).forEach(function (w) { byId[w.id] = w; });
    pager("#tasks", d.tasks, function (t) {
      var result = t.status === "staged"
        ? '<span class="mono">' + esc(t.result_filename || "") + '</span> ' + evidenceLink(t)
        : t.status === "done" && t.result_filename && t.result_filename !== "-"
        ? (t.publish === 0 ? '<span class="mono">' + esc(t.result_filename) + '</span>' : '<a href="' + pkgHref(t.name, "edge", t.arch) + '" class="mono">' + esc(t.result_filename) + '</a>')
        : t.status === "done" && t.result ? '<span class="muted">' + esc(jobResult(t)) + '</span>'
        : (t.error ? '<span class="muted" title="' + esc(t.error) + '">' + esc(t.error.slice(0, 90)) + '</span>' : '<span class="muted">—</span>');
      var what = t.kind && t.kind !== "build" ? '<b>' + esc(t.kind) + '</b> <span class="muted">' + esc(paramsLabel(t)) + '</span>' : '<b>' + esc(t.name) + '</b>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '');
      return '<tr><td><a href="/build/' + t.id + '" title="the task, whole: what happened, the worker, the evidence">' + t.id + '</a></td><td>' + what + '</td><td>' + esc(t.arch) + '</td>' +
        '<td>' + taskPill(t.status) + (t.trust === "community" ? ' <span class="pill none" title="a contributor\'s build: goes to staging, a maintainer approves">' + esc(t.owner || "community") + '</span>' : '') + (t.publish === 0 && t.trust !== "community" ? ' <span class="pill none" title="built and measured, never published">dry run</span>' : '') + (t.attempts > 1 ? ' <span class="muted">attempt ' + t.attempts + '/' + t.max_attempts + '</span>' : '') + '</td><td>' + esc(t.reason) + '</td>' +
        '<td>' + (t.lease_owner ? wtId(byId[t.lease_owner] || t.lease_owner) : '<span class="muted">—</span>') + '</td><td>' + (dur(t.duration_ms) || "—") + '</td><td>' + result + '</td></tr>';
    }, { empty: "nothing queued or built yet", text: function (t) { return [t.id, t.kind, t.name, t.arch, t.status, t.reason, t.lease_owner, t.owner, paramsLabel(t)].join(" "); } });
  }
  var API = "/api/v1/factory";
  // REVIEW is the review list's own answer — the staged rows, and at the top waiting (the rows a maintainer's time is asked for now, the rule Review highlights by) and oldest_ms — so the flow, the tile and Review's say one number and one age.
  var FACTORY = null, STATS = null, REVIEW = { staged: [], waiting: 0, oldest_ms: null }, STAGED = [];
  skeletonTiles("#tiles", 6); skeletonRows("#staged", 8, 2); skeletonRows("#events", 7, 6); skeletonRows("#tasks", 8, 4); skeletonRows("#registry", 8, 2); // ---- the state row: the service (measured now) and the pipeline (from the journal)
  function renderState(d) {
    fetch("/api/v1/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (st) { live("api", "API up · index " + (st.index.ok ? st.index.ms + " ms" : "down") + " · pool " + (st.pool.ok ? st.pool.ms + " ms" : "down")); }).catch(function () { live("api", "API not answering"); });
    // A ring's pill is the worse of its two architectures' latest health checks.
    var why = problemsOf(d), heads = ["stable", "rc", "edge"].map(function (n) { var r = d.rings.filter(function (x) { return x.ring === n; })[0]; var hs = ["x86_64", "aarch64"].map(function (a) { return latest(d.latest, "health", n, a); }).filter(Boolean); var w = hs.reduce(function (acc, h) { return worst(acc, h.status); }, null); var bad = hs.filter(function (h) { return h.status !== "ok"; }); return r && r.release ? '<span class="pill ' + (w || "none") + '">' + n + ' #' + r.release.seq + (w ? ' · ' + (w === "ok" ? "healthy" : bad.map(function (h) { return (h.source || "x86_64") + " " + h.status; }).join(", ")) : "") + '</span>' : ""; }).join("");
    $("#state").innerHTML = '<span class="pill ' + (why.length ? "warn" : "ok") + '">' + (why.length ? "pipeline behind: " + esc(why.join(" · ")) : "pipeline keeping up") + '</span>' + heads + '<span class="pill none">running ' + esc(d.version && d.version.version || "") + '</span>';
  }

  // ---- the living system: the diagram's numbers, the feed, the counters — all from the journal
  var seen = {};
  function feedRow(e, fresh) {
    var run = runHref(e.payload && e.payload.ci && e.payload.ci.run_url);
    return '<div class="row"' + (fresh ? "" : ' style="animation:none"') + '><span><span class="dot ' + esc(e.status) + '"></span>' + esc(e.status) + '</span><span class="what">' + esc(e.kind) + '</span><span><span class="where">' + esc([e.ring, e.source].filter(Boolean).join(" · ")) + '</span> ' + (run ? '<a class="run" href="' + esc(run) + '">' + esc(e.summary) + '</a>' : esc(e.summary)) + '</span><span class="when" title="' + esc(e.created_at) + '">' + ago(e.created_at) + '</span></div>';
  }
  function loadFeed() {
    fetch("/api/v1/events?limit=12", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      var rows = (d.events || []).filter(function (e) { return e.kind !== "metrics"; }).slice(0, 9);
      var first = !Object.keys(seen).length;
      $("#feed").innerHTML = rows.map(function (e) { var fresh = !first && !seen[e.id]; seen[e.id] = 1; return feedRow(e, fresh); }).join("") || '<div class="muted">nothing yet</div>';
      if (first) rows.forEach(function (e) { seen[e.id] = 1; });
    }).catch(function () {});
  }
  function renderLive(d) {
    var today = new Date().toISOString().slice(0, 10), S = d.series || {};
    var imp = (S.imports_daily || []).filter(function (r) { return r.day === today; }).reduce(function (n, r) { return n + Number(r.packages || 0); }, 0);
    var lastSync = newest(d.latest, "sync"), fast = (d.events || []).filter(function (e) { return e.kind === "fast-track"; }), rb = (d.events || []).filter(function (e) { return e.kind === "rollback"; });
    var promos = (d.events || []).filter(function (e) { return e.kind === "promote" && e.status === "ok" && e.created_at.slice(0, 10) === today; });
    live("verified-today", "verified today: " + num(imp)); live("stored-once", "stored once: " + num(d.pool.objects));
    live("advisories", "advisories known: " + num((d.security || {}).advisories || 0));
    live("last-sync", "synced " + (lastSync ? ago(lastSync.created_at) : "never") + " · every 3 h");
    live("pool-size", num(d.pool.objects) + " objects · " + bytes(d.pool.bytes));
    ["edge", "rc", "stable"].forEach(function (n) { var r = d.rings.filter(function (x) { return x.ring === n; })[0]; if (r && r.release) live(n + "-head", "release #" + r.release.seq + " · " + ago(r.release.created_at)); });
    live("heads", ["edge", "rc", "stable"].map(function (n) { var r = d.rings.filter(function (x) { return x.ring === n; })[0]; return n + (r && r.release ? " #" + r.release.seq : " —"); }).join(" · "));
    var aud = d.audience || [], y = aud[aud.length - 1];
    var cells = [
      ["packages verified today", num(imp), "ok"], ["advisories known", num((d.security || {}).advisories || 0), ""], ["exploited in stable", "<span data-live=\"kev\">…</span>", "ok"],
      y ? ["machines on the pool, " + y.day, "≈ " + num(y.machines), "ok"] : ["promotions today", num(promos.length), ""], ["fast-tracks, recent journal", num(fast.length), ""], ["rollbacks, recent journal", num(rb.length), rb.length ? "warn" : "ok"]
    ];
    $("#counters").innerHTML = cells.map(function (c) { return '<div><b class="' + c[2] + '">' + c[1] + '</b><span>' + c[0] + '</span></div>'; }).join("");
    // Open in stable as the Security page says it: the shell's one rule at the page's default confidence (advisoriesAt, advisoryCounts), the number the Pool's tile says too.
    fetch("/api/v1/security?ring=stable&arch=x86_64").then(function (r) { return r.json(); }).then(function (s) { var t = advisoryCounts(advisoriesAt(s)); live("open-stable", "open in stable: " + num(t.packages) + " · exploited: " + num(t.kev) + " · " + confWord()); live("kev", num(t.kev)); }).catch(function () { live("open-stable", "open in stable: no scan yet"); live("kev", "—"); });
  }

  // ---- review throughput: arrivals, decisions, who decides, and a contributor's place in the queue
  function weeksBack(n) { var out = [], now = Date.now(); for (var i = n - 1; i >= 0; i--) out.push(new Date(now - i * 7 * 86400000).toISOString().slice(0, 10)); return out; }
  function bucket(weeks, items, at) { var v = weeks.map(function () { return 0; }); items.forEach(function (x) { var t = Date.parse(at(x)); for (var i = weeks.length - 1; i >= 0; i--) { if (t >= Date.parse(weeks[i])) { v[i]++; break; } } }); return v; }
  // An approval counts as approved where it stands (standing, the server's word: approved and not withdrawn); one taken back is sent back like a rejection — the package left the rings and another maintainer decides — so the flow's stage and the chart's series read one rule.
  function renderThroughput(f, pkgs, apps, review, me) {
    var week = Date.now() - 7 * 86400000, weeks = weeksBack(8), staged = review.staged || [];
    var arrived = pkgs.filter(function (p) { return Date.parse(p.created_at || p.updated_at) > week; }).length;
    var building = f.tasks.filter(function (t) { return t.kind === "build" && t.status === "leased" && t.trust === "community"; }).length;
    var approved7 = apps.filter(function (a) { return a.standing && Date.parse(a.created_at) > week; }).length, back7 = apps.filter(function (a) { return !a.standing && Date.parse(a.created_at) > week; }).length;
    $("#flow").innerHTML =
      '<div class="st"><span class="k">arrived this week</span><b>' + num(arrived) + '</b><span class="s">packages registered</span></div><div class="ar">→</div>' +
      '<div class="st"><span class="k">building</span><b>' + num(building) + '</b><span class="s">on contributors\' and shared workers</span></div><div class="ar">→</div>' +
      '<div class="st hum"><span class="k">waiting for review</span><b>' + num(review.waiting) + '</b><span class="s">' + (review.oldest_ms ? "oldest " + span(review.oldest_ms) : "nothing waiting") + '</span></div><div class="ar">→</div>' +
      '<div class="st"><span class="k">approved this week</span><b>' + num(approved7) + '</b><span class="s">' + num(back7) + ' sent back with a note</span></div><div class="ar">→</div>' +
      // In the rings: the registry's own word (landed), the number the Factory's, the Pool's and People's tiles say.
      '<div class="st you"><span class="k">in the rings</span><b>' + num(pkgs.filter(function (p) { return p.landed; }).length) + '</b><span class="s">community packages, total</span></div>';
    var ap = bucket(weeks, apps.filter(function (a) { return a.standing; }), function (a) { return a.created_at; }), rj = bucket(weeks, apps.filter(function (a) { return !a.standing; }), function (a) { return a.created_at; });
    var labels = weeks.map(function (w) { return w.slice(5); });
    $("#c-decisions").innerHTML = stacked(labels, [{ name: "approved", color: C.green, values: ap }, { name: "sent back", color: C.amber, values: rj }], { label: "Decisions per week over eight weeks", full: true, empty: "no decision yet" });
    $("#c-arrivals").innerHTML = lines(labels, [{ name: "arrived", color: C.blue, values: bucket(weeks, pkgs, function (p) { return p.created_at || p.updated_at; }) }, { name: "decided", color: C.green, values: ap.map(function (v, i) { return v + rj[i]; }) }], "packages", "Packages arrived and decided per week over eight weeks");
    // Who is deciding: every decision on the record per person — approvals standing or withdrawn, rejections — as the label says; the person is the shell's, the role from the maintainer set, not this page's guess.
    var by = {}; apps.forEach(function (a) { by[a.by] = (by[a.by] || 0) + 1; });
    var names = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; }), max = names.length ? by[names[0]] : 1;
    $("#deciders").innerHTML = names.map(function (n) { return '<div class="m">' + avatar(n) + '<div>' + personLink(n) + '<div class="bar" style="margin-top:4px"><i style="width:' + (100 * by[n] / max) + '%"></i></div></div><b class="num">' + num(by[n]) + '</b></div>'; }).join("") || '<div class="muted">no decision on the record yet</div>';
    // Where the reader's staged builds sit, oldest first — the same card for everyone: a build of theirs and its place, one line that nothing of theirs waits, or one line saying how to sign in and see.
    var order = staged.slice().sort(function (a, b) { return Date.parse(a.finished_at || 0) - Date.parse(b.finished_at || 0); });
    var mine = me && me.login ? order.map(function (s, i) { return { s: s, pos: i + 1 }; }).filter(function (x) { return x.s.owner === me.login; }) : [];
    var card = function (big, small) { return '<div class="queue-pos" style="margin-top:14px"><span class="dim" style="font-size:11.5px;letter-spacing:.06em;text-transform:uppercase">your build in the queue</span>' + (big ? '<b>' + big + '</b>' : "") + '<span>' + small + '</span></div>'; };
    $("#queue-pos").innerHTML = mine.length
      ? mine.slice(0, 2).map(function (x) { return card(esc(x.s.name) + ' ' + esc(x.s.version || "") + ' · position ' + x.pos + ' of ' + order.length, esc(x.s.arch) + ' · audit ' + esc((x.s.audit && (x.s.audit.verdict || x.s.audit.status)) || "none") + ' · staged ' + ago(x.s.finished_at)); }).join("")
      : card("", me && me.login ? "none of your builds is waiting for a decision right now" : '<a href="/auth/github?next=/pipeline">sign in with GitHub</a> to see where yours sits');
  }

  // ---- the review queue: what is staged, with the audit (the shell's auditPill) and the Decision cell (the shell's decisionCell) — the same buttons for every reader, live where the row's can says so and grey with the server's reason otherwise. The click, the dialogs, the post and the toast that says what happened are the shell's; the page only draws again once a decision landed, as Review does.
  function renderStaged(staged) {
    pager("#staged", staged, function (s) {
      var ev = s.evidence || {};
      return '<tr><td class="dim">' + s.id + '</td><td><b>' + esc(s.name) + '</b> <span class="dim">' + esc(s.version || "") + '</span></td><td>' + esc(s.arch) + '</td><td>' + (s.owner ? avatar(s.owner) + ' ' + personLink(s.owner) : "—") + '</td>' +
        '<td><a class="run" href="' + esc(ev.pkgbuild || "#") + '">PKGBUILD</a> · <a class="run" href="' + esc(ev.log || "#") + '">log</a> · <a class="run" href="' + esc(ev.pkginfo || "#") + '">.PKGINFO</a></td><td>' + auditPill(s.audit) + '</td><td class="when">' + ago(s.finished_at) + '</td>' +
        '<td class="decision">' + decisionCell(s) + '</td></tr>';
    }, { empty: "nothing staged — every contributor build has been decided", n: 10 });
  }
  onDecided(function () { loadAll(); });

  // ---- operations: tiles, the diagram's numbers (the workers themselves are on /workers)
  function renderOps(d) {
    var count = function (st, arch) { return d.counts.filter(function (c) { return c.status === st && (!arch || c.arch === arch); }).reduce(function (n, c) { return n + c.n; }, 0); };
    // The workers as the shell counts them (workerCounts): alive is the listing's word, the project's are the project and review kinds, the rest a contributor's.
    var wc = workerCounts(d.workers);
    var failed24 = d.tasks.filter(function (t) { return t.status === "failed" && Date.now() - Date.parse(t.finished_at || t.created_at) < 86400e3; });
    // Worker minutes: the sum of the series the Status and Workers pages chart (workerMinutes over jobs_daily), not the metrics snapshot beside it.
    var wm = STATS ? workerMinutes(STATS.series, 7) : null;
    setTiles("#tiles", [
      ["Queued", num(count("queued")), num(count("queued", "x86_64")) + " x86_64 · " + num(count("queued", "aarch64")) + " aarch64", count("queued") ? "warn" : ""],
      ["Building", num(count("leased")), "lease " + d.lease_minutes + " min, extended by heartbeats"],
      ["Workers alive", num(wc.alive) + " / " + num(wc.registered), num(wc.byKind.project.alive + wc.byKind.review.alive) + " the project's · " + num(wc.byKind.community.alive) + " contributors'", wc.alive ? "ok" : "warn", "/workers"],
      ["Waiting for review", num(REVIEW.waiting), REVIEW.oldest_ms ? "oldest " + span(REVIEW.oldest_ms) : "nothing waiting", REVIEW.waiting ? "warn" : ""],
      ["Failed · 24 h", num(failed24.length), failed24.length ? esc(failed24[0].name || failed24[0].kind) + " " + esc(failed24[0].arch || "") : "nothing failed"],
      ["Worker minutes · 7 d", wm ? num(wm.total) : "—", wm ? "≈ " + num(Math.round(wm.total / 7)) + " per day, the project's workers" : ""]
    ]);
    live("queue", "queued " + num(count("queued")) + " · leased " + num(count("leased")) + " · per-job tokens · an expired lease goes back in the queue");
    var roles = { pool: [], review: [], shared: [], own: [] };
    // The diagram's three lines: the project's build workers (wtKind "project") are the pool's line, the review worker its own, a contributor's shared and own workers one line together.
    d.workers.forEach(function (w) { var k = wtKind(w); roles[k === "community" ? (w.mode === "shared" ? "shared" : "own") : k === "review" ? "review" : "pool"].push(w); });
    var line = function (ws) { var c = workerCounts(ws); return num(c.alive) + " alive · " + num(c.building) + " building" + (c.registered > c.alive ? " · " + num(c.registered - c.alive) + " gone" : ""); };
    live("w-pool", line(roles.pool)); live("w-review", line(roles.review)); live("w-community", line(roles.shared.concat(roles.own)));
    // The reader's role, in the hint: what the grey buttons below are waiting for is said once here.
    $("#ops-who").textContent = isMaintainer() ? WHO.login + " · you can approve and roll back" : WHO.login ? WHO.login + " · contributor — approving and rolling back are a maintainer's" : "read-only — approving and rolling back need the maintainer role";
  }

  // ---- ring heads and the journal; the roll-back button is on every card with a release before the head, for everyone — live for a maintainer, grey with the reason for anyone else — and the click is the shell's (askRollback asks, posts the job once, writes #rb-state)
  function renderRings(d) {
    var heads = {}; (d.releases || []).forEach(function (r) { if (r.is_head) heads[r.ring] = r; });
    $("#heads").innerHTML = ["stable", "rc", "edge"].map(function (n) {
      var r = d.rings.filter(function (x) { return x.ring === n; })[0] || {}, rel = r.release, h = ["x86_64", "aarch64"].map(function (a) { var e = latest(d.latest, "health", n, a); return a + " " + (e ? e.status : "—"); }).join(" · ");
      var prev = (d.releases || []).filter(function (x) { return x.ring === n && !x.is_head; })[0];
      return '<div class="headc ' + n + '"><div class="n"><b>' + n + '</b><span class="dim">' + (rel ? "#" + rel.seq + " · " + ago(rel.created_at) : "no release") + '</span></div><div class="m">' + num(r.package_count || 0) + ' packages · ' + bytes(r.bytes || 0) + ' · ' + h + '</div><div class="acts">' + (rel && rel.parent_id ? '<a class="small-btn" href="/diff?ring=' + n + '&from=' + rel.parent_id + '&to=' + rel.id + '">diff</a>' : "") + (prev ? gate('<button type="button" class="small-btn" data-rollback="' + prev.id + '" data-ring="' + n + '" title="point ' + n + ' back at release ' + prev.id + '">roll back to #' + prev.seq + '</button>', isMaintainer(), orSignIn("a maintainer rolls back")) : "") + '</div></div>';
    }).join("");
    pager("#events", d.events, eventRow, { empty: "nothing yet", n: 10 });
  }
  // ---- the charts, from /api/v1/stats
  function renderCharts(d) {
    var S = d.series || {}, days14 = lastDays(14), days7 = lastDays(7);
    var jd = S.jobs_daily || [], byD = {};
    jd.forEach(function (r) { var x = byD[r.day] = byD[r.day] || { done: 0, failed: 0, waiting: 0 }; if (r.status === "done") x.done += Number(r.n); else if (r.status === "failed" || r.status === "cancelled") x.failed += Number(r.n); else x.waiting += Number(r.n); });
    $("#c-jobs").innerHTML = stacked(days7, [{ name: "done", color: C.green, values: days7.map(function (x) { return (byD[x] || {}).done || 0; }) }, { name: "waiting", color: C.amber, values: days7.map(function (x) { return (byD[x] || {}).waiting || 0; }) }, { name: "failed", color: C.red, values: days7.map(function (x) { return (byD[x] || {}).failed || 0; }) }], { label: "Pool jobs per day over seven days", empty: "no job yet — the pool queues them on schedule and project workers pull them" });
    $("#c-health").innerHTML = heatGrid(S.health);
    var byDay = {}; (S.imports_daily || []).forEach(function (r) { byDay[r.day] = r; });
    $("#c-imports").innerHTML = stacked(days14, [{ name: "imported", color: C.green, values: days14.map(function (x) { return byDay[x] ? Number(byDay[x].packages) : 0; }) }], { label: "Packages imported per day over fourteen days", empty: "no sync yet" });
    var runs = (S.sync_runs || []).slice().reverse().filter(function (r) { return r.bytes && r.duration_ms; });
    $("#c-sync").innerHTML = bars(runs.map(function (r) { var mbs = Number(r.bytes) / 1048576 / (Number(r.duration_ms) / 1000); return { label: r.source.slice(0, 5) + (r.arch === "aarch64" ? "/arm" : ""), value: Math.round(mbs * 10) / 10, color: r.status === "error" ? C.red : C.blue, title: r.source + " " + r.arch + " " + ago(r.created_at) + ": " + (Math.round(mbs * 10) / 10) + " MB/s, " + bytes(r.bytes) + " in " + dur(r.duration_ms) }; }), function (v) { return v + " MB/s"; });
    var builds = buildsByDay(d.series, 14);
    $("#c-builds").innerHTML = stacked(builds.labels, builds.series, { label: "Factory builds per day over fourteen days", empty: "no build yet" });
  }

  // ---- promotions per day: what the promote, rollback and fast-track jobs recorded
  function renderPromos() {
    Promise.all(["promote", "rollback", "fast-track"].map(function (k) { return fetch("/api/v1/events?kind=" + k + "&limit=200").then(function (r) { return r.json(); }).then(function (d) { return d.events || []; }).catch(function () { return []; }); })).then(function (lists) {
      var days = lastDays(14), by = {}; days.forEach(function (d) { by[d] = { promoted: 0, blocked: 0, rolled: 0 }; });
      lists[0].forEach(function (e) { var d = e.created_at.slice(0, 10); if (!by[d]) return; if (e.status === "ok") by[d].promoted++; else by[d].blocked++; });
      lists[2].forEach(function (e) { var d = e.created_at.slice(0, 10); if (by[d] && e.status === "ok") by[d].promoted++; });
      lists[1].forEach(function (e) { var d = e.created_at.slice(0, 10); if (by[d]) by[d].rolled++; });
      $("#c-promos").innerHTML = stacked(days, [{ name: "promoted", color: C.green, values: days.map(function (d) { return by[d].promoted; }) }, { name: "blocked", color: C.amber, values: days.map(function (d) { return by[d].blocked; }) }, { name: "rolled back", color: C.red, values: days.map(function (d) { return by[d].rolled; }) }], { label: "Promotions per day over fourteen days: promoted, blocked, rolled back", empty: "no promotion yet" });
    });
  }

  // ---- the bill, estimated on cost.ts's cadence (ESTIMATE_CADENCE, spliced into the words above and below) from Cloudflare's analytics. The three lines — warn, guard, cap — are the pool's budget, not the estimate's: /api/v1/cost carries them with the estimate and without one, and the sentence, the cap beside the month, the guard's word and the mark on the bar all read them there, never a number typed here.
  function renderCost() {
    fetch("/api/v1/cost").then(function (r) { return r.json(); }).then(function (c) {
      var usd = c.lines_usd || {};
      live("cost-warn", num(usd.warn)); live("cost-guard", num(usd.guard)); live("cost-cap", num(usd.cap));
      var el = $("#budget"); if (c.error) { el.innerHTML = '<div><div class="k">this month</div><b>—</b> <span class="dim">no estimate yet (${ESTIMATE_CADENCE})</span></div>'; return; }
      var color = c.status === "error" ? "var(--red)" : c.status === "warn" ? "var(--amber)" : "var(--green)";
      el.innerHTML = '<div><div class="k">' + esc(c.month) + ', so far</div><b style="color:' + color + '">US$ ' + Number(c.month_to_date_usd).toFixed(2) + '</b> <span class="dim">of a US$ ' + num(usd.cap) + ' hard cap</span></div><div><div class="k">projected</div><b>US$ ' + Number(c.projected_usd).toFixed(2) + '</b> <span class="dim">' + (c.guard ? "over the guard: jobs that write are paused" : "guard at US$ " + num(usd.guard)) + '</span></div><div class="bar"><i style="width:' + Math.min(100, 100 * Number(c.projected_usd) / usd.cap) + '%;background:' + color + '"></i><em style="left:' + (100 * usd.guard / usd.cap) + '%"></em></div>';
    }).catch(function () {});
  }

  // ---- everything, together: stats every minute, the factory every 30 s, the feed every 20 s
  function loadAll() {
    Promise.all([
      busy(fetch(API + "?limit=100")).then(function (r) { return r.json(); }),
      fetch(API + "/packages").then(function (r) { return r.json(); }).catch(function () { return { packages: [] }; }),
      fetch(API + "/approvals").then(function (r) { return r.json(); }).catch(function () { return { approvals: [] }; }),
      fetch(API + "/review", { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return { staged: [] }; })
    ]).then(function (res) {
      var f = res[0]; REVIEW = res[3]; STAGED = REVIEW.staged || [];
      FACTORY = f; renderOps(f); renderStaged(STAGED); renderThroughput(f, res[1].packages || [], res[2].approvals || [], REVIEW, WHO.me);
      renderTables(f);
      endSkeleton();
    }).catch(function () { endSkeleton(); });
  }
  // The first load waits for /auth/me, so every button is live or grey as the reader's rights say from the first draw; the ring cards come from the stats poll, drawn again here when the poll answered first.
  whoami(function () { loadAll(); if (STATS) renderRings(STATS); });
  setInterval(loadAll, 30000);
  loadFeed(); setInterval(loadFeed, 20000);
  renderCost(); renderPromos(); setInterval(renderPromos, 300000);
  liveStats(function (d) { STATS = d; renderState(d); renderLive(d); renderRings(d); renderCharts(d); if (FACTORY) renderOps(FACTORY); }, 60000);
`;

export function pipelineHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/pipeline",
    title: "Pipeline · omarchy-pool",
    description: "The pipeline as it runs: what is verified, promoted and checked right now, how fast maintainers decide, the charts, the cost.",
    active: "pipeline",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}

/**
 * What /pipeline is made of.
 * Ten sections, one entry per unit that reads or acts: the state row and the
 * living system (the journal, as it happens), the review throughput, the
 * operations, the review queue and its buttons, six charts, the two tables,
 * the ring heads with roll back, the journal, the bill. The stable ring is
 * the third of RINGS (edge, rc, stable, lab) and the one the fixture
 * released, so a release's fields are read at `rings.2`. Everything the page
 * reads is public and every reader gets the same page; a session changes
 * what the queue-position card and the operations hint say, and which of
 * the buttons — the Decision cell's, roll back — are live rather than grey.
 */
export const PIPELINE_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "pipeline.hero",
    page: "/pipeline",
    anchor: ['class="hero compact"', "The pipeline, as it runs right now"],
    visible: EVERYONE,
  },
  {
    id: "pipeline.state-row",
    page: "/pipeline",
    anchor: ['class="state-row"', 'id="state"'],
    script: ['$("#state")', 'fetch("/api/v1/status"', "problemsOf(d)", "d.version && d.version.version"],
    reads: [
      { path: "/api/v1/stats", fields: ["rings", "rings.2.ring", "rings.2.release.seq", "latest", "coverage", "version.version"] },
      { path: "/api/v1/status", fields: ["index.ok", "index.ms", "pool.ok", "pool.ms"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "pipeline.section-links",
    page: "/pipeline",
    anchor: ['id="live"', 'id="throughput"', 'href="/docs/governance"', 'href="/docs/factory"', 'href="/workers"', 'href="/review"', 'href="/status"', 'href="/factory"', 'href="/journal"'],
    visible: EVERYONE,
  },
  {
    id: "pipeline.live-diagram",
    page: "/pipeline",
    anchor: ['class="diagram live-diagram"', 'data-live="verified-today"', 'data-live="stored-once"', 'data-live="edge-head"', 'data-live="rc-head"', 'data-live="stable-head"', 'data-live="advisories"', 'data-live="open-stable"'],
    script: ['live("verified-today"', 'live("stored-once"', 'live("advisories"', 'live("open-stable"', 'n + "-head"', '"/api/v1/security?ring=stable&arch=x86_64"', "advisoryCounts(advisoriesAt(s))", "confWord()"],
    reads: [
      { path: "/api/v1/stats", fields: ["series.imports_daily", "pool.objects", "rings.2.release.seq", "rings.2.release.created_at", "security.advisories"] },
      { path: `/api/v1/security?ring=stable&arch=${F.arch}`, fields: ["vulnerable", "vulnerable.0.advisories.0.match", "vulnerable.0.advisories.0.kev"] },
    ],
    visible: EVERYONE,
    drawn: "live",
  },
  {
    id: "pipeline.live-feed",
    page: "/pipeline",
    anchor: ['class="ticker"', 'id="feed"'],
    script: ['"/api/v1/events?limit=12"', '$("#feed")', 'e.kind !== "metrics"', "runHref(e.payload && e.payload.ci && e.payload.ci.run_url)"],
    reads: [{ path: "/api/v1/events?limit=12", fields: ["events", "events.0.id", "events.0.kind", "events.0.status", "events.0.ring", "events.0.source", "events.0.summary", "events.0.created_at", "events.0.payload"] }],
    visible: EVERYONE,
  },
  {
    id: "pipeline.counters",
    page: "/pipeline",
    anchor: ['id="counters"', 'href="/journal"'],
    script: ['$("#counters")', 'live("kev"', "d.audience", 'e.kind === "fast-track"', 'e.kind === "rollback"', 'e.kind === "promote" && e.status === "ok"'],
    reads: [
      { path: "/api/v1/stats", fields: ["series.imports_daily", "security.advisories", "audience", "events"] },
      { path: `/api/v1/security?ring=stable&arch=${F.arch}`, fields: ["vulnerable"] },
    ],
    visible: EVERYONE,
  },
  {
    // The flow's stages: what waits for review is the list's own `waiting` and `oldest_ms` (Review's tile and the Factory's read the same two); approved is an approval that stands, sent back the rest.
    id: "pipeline.throughput-flow",
    page: "/pipeline",
    anchor: ['id="throughput"', 'id="flow"'],
    script: ['$("#flow")', 'API + "/packages"', 'API + "/approvals"', 'API + "/review"', "a.standing &&", "!a.standing &&", 't.status === "leased" && t.trust === "community"', "review.waiting", "review.oldest_ms", 'class="k">waiting for review</span>', "p.landed", 'class="k">in the rings</span>'],
    reads: [
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.created_at", "packages.0.updated_at", "packages.0.status", "packages.0.landed"] },
      { path: "/api/v1/factory?limit=100", fields: ["tasks", "tasks.0.kind", "tasks.0.status", "tasks.0.trust"] },
      { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.standing", "approvals.0.created_at"] },
      { path: "/api/v1/factory/review", fields: ["staged", "waiting", "oldest_ms"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "pipeline.decisions-chart",
    page: "/pipeline",
    anchor: ['id="c-decisions"'],
    script: ['$("#c-decisions")', 'name: "approved"', 'name: "sent back"', "return a.standing;", "return !a.standing;", "a.created_at"],
    reads: [{ path: "/api/v1/factory/approvals", fields: ["approvals.0.standing", "approvals.0.created_at"] }],
    visible: EVERYONE,
  },
  {
    id: "pipeline.arrivals-chart",
    page: "/pipeline",
    anchor: ['id="c-arrivals"'],
    script: ['$("#c-arrivals")', 'name: "arrived"', 'name: "decided"', "p.created_at || p.updated_at"],
    reads: [
      { path: "/api/v1/factory/packages", fields: ["packages.0.created_at", "packages.0.updated_at"] },
      { path: "/api/v1/factory/approvals", fields: ["approvals.0.standing", "approvals.0.created_at"] },
    ],
    visible: EVERYONE,
  },
  {
    // Every decision on the record per person, as the label says; the person is the shell's avatar and link, the role from the maintainer set rather than a word this page guessed.
    id: "pipeline.deciders",
    page: "/pipeline",
    anchor: ['id="deciders"', "decisions per maintainer"],
    script: ['$("#deciders")', "by[a.by]", "avatar(n)", "personLink(n)"],
    reads: [{ path: "/api/v1/factory/approvals", fields: ["approvals.0.by"] }],
    visible: EVERYONE,
  },
  {
    id: "pipeline.queue-position",
    page: "/pipeline",
    anchor: ['id="queue-pos"'],
    // The same card for everyone: a signed-in person's staged builds and their place in the queue, one line that nothing of theirs waits, or one line saying how to sign in and see.
    script: ['$("#queue-pos")', "me && me.login", "x.s.owner === me.login", "your build in the queue", "x.s.audit.verdict || x.s.audit.status", "none of your builds is waiting for a decision right now", 'href="/auth/github?next=/pipeline">sign in with GitHub</a> to see where yours sits'],
    reads: [
      { path: "/auth/me", as: "owner", fields: ["login"] },
      { path: "/api/v1/factory/review", fields: ["staged.0.owner", "staged.0.name", "staged.0.version", "staged.0.arch", "staged.0.finished_at", "staged.0.audit.status"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "pipeline.operations-hint",
    page: "/pipeline",
    anchor: ['id="operations"', 'id="ops-who"'],
    // One line naming the reader and the role: a maintainer's, a contributor's, a reader's — so the grey buttons below need no second sentence.
    script: ['$("#ops-who")', "isMaintainer() ? WHO.login", "you can approve and roll back", "contributor — approving and rolling back are a maintainer's", "read-only — approving and rolling back need the maintainer role"],
    reads: [
      { path: "/auth/me", as: "maintainer", fields: ["login", "role"] },
      { path: "/auth/me", as: "contributor", fields: ["login", "role"] },
    ],
    visible: EVERYONE,
  },
  {
    // The workers are the shell's count (workerCounts: alive the listing's word, by kind); what waits for review is the list's own `waiting` and `oldest_ms`.
    id: "pipeline.operations-tiles",
    page: "/pipeline",
    anchor: ['class="tiles six"', 'id="tiles"'],
    script: ['setTiles("#tiles"', "workerCounts(d.workers)", "wc.byKind.project.alive + wc.byKind.review.alive", "wc.byKind.community.alive", '"Waiting for review"', "REVIEW.waiting", "REVIEW.oldest_ms", '"Failed · 24 h"', "d.lease_minutes", '"Worker minutes · 7 d", wm ? num(wm.total)', "workerMinutes(STATS.series, 7)"],
    reads: [
      { path: "/api/v1/factory?limit=100", fields: ["counts", "counts.0.status", "counts.0.arch", "counts.0.n", "lease_minutes", "workers", "workers.0.alive", "workers.0.ready", "workers.0.current_task", "workers.0.revoked_at", "workers.0.side", "workers.0.labels", "tasks.0.status", "tasks.0.finished_at", "tasks.0.created_at", "tasks.0.name", "tasks.0.kind", "tasks.0.arch"] },
      { path: "/api/v1/factory/review", fields: ["staged", "waiting", "oldest_ms"] },
      { path: "/api/v1/stats", fields: ["series.jobs_daily"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "pipeline.arch-diagram",
    page: "/pipeline",
    anchor: ['data-live="last-sync"', 'data-live="api"', 'data-live="pool-size"', 'data-live="heads"', 'data-live="queue"', 'data-live="w-pool"', 'data-live="w-review"', 'data-live="w-community"', 'href="/workers"'],
    script: ['live("last-sync"', 'live("api"', 'live("pool-size"', 'live("heads"', 'live("queue"', 'live("w-pool"', 'live("w-review"', 'live("w-community"', "wtKind(w)", "workerCounts(ws)"],
    reads: [
      { path: "/api/v1/stats", fields: ["latest", "pool.objects", "pool.bytes", "rings.2.release.seq"] },
      { path: "/api/v1/status", fields: ["index.ok", "index.ms", "pool.ok", "pool.ms"] },
      { path: "/api/v1/factory?limit=100", fields: ["counts", "workers.0.side", "workers.0.labels", "workers.0.trust", "workers.0.mode", "workers.0.alive", "workers.0.current_task"] },
    ],
    visible: EVERYONE,
    drawn: "arch",
  },
  {
    id: "pipeline.review-queue-table",
    page: "/pipeline",
    anchor: ['id="staged"', '<th class="decision">Decision</th>'],
    script: ['pager("#staged"', "avatar(s.owner) + ' ' + personLink(s.owner)", "s.evidence", "ev.pkgbuild", "auditPill(s.audit)", '<td class="decision">'],
    // The evidence links point at the artifacts of a staged build; the fixture's undecided rows were written without any, so the links are read on the contributor's build.
    reads: [
      { path: "/api/v1/factory/review", fields: ["staged.0.id", "staged.0.name", "staged.0.version", "staged.0.arch", "staged.0.owner", "staged.0.evidence.pkgbuild", "staged.0.evidence.log", "staged.0.evidence.pkginfo", "staged.0.audit.status", "staged.0.finished_at"] },
      { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/PKGBUILD`, json: false },
      { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/build.log`, json: false },
      { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/PKGINFO`, json: false },
    ],
    visible: EVERYONE,
  },
  {
    id: "pipeline.review-decision-buttons",
    page: "/pipeline",
    anchor: ['id="staged"', '<td class="decision">'],
    // The cell is the shell's decisionCell, drawn from the row's `can` for whoever reads: every button for every reader, live where the server would answer 200 and grey with its reason where it would refuse. The click, the four dialogs, the post and the toast are the shell's (shell.decide); the page draws again through onDecided.
    script: ["decisionCell(s)", "onDecided(function () { loadAll(); })"],
    // `can` rides the no-store list, for nobody (all false, "sign in with GitHub") and for a maintainer alike; `already` names the approval a build of an approved version repeats (null on the fixture's rows); `standing` says an approval stands on the chain, so Withdraw is drawn.
    reads: [
      { path: "/api/v1/factory/review", fields: ["staged.0.can.approve", "staged.0.can.reject", "staged.0.can.build", "staged.0.can.withdraw", "staged.0.can.why", "staged.0.already", "staged.0.standing"] },
      { path: "/api/v1/factory/review", as: "maintainer", fields: ["staged.0.can.approve", "staged.0.can.reject", "staged.0.can.build", "staged.0.can.withdraw", "staged.0.can.why"] },
    ],
    // Approve is drawn on every staged row here, but only the project's build can be approved — the fixture's is
    // already approved, so a maintainer meets "already approved". Reject on a row of this page's own: the Review's
    // buttons reject F.disposableTask before these run, and a cancelled row answers 409 to every role.
    acts: [
      { method: "POST", path: `/api/v1/factory/tasks/${F.projectTask}/approve`, body: { note: "reads well" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: [200, 409] } },
      { method: "POST", path: `/api/v1/factory/tasks/${F.spareTask}/reject`, body: { note: "the source is not the upstream's" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 200 } },
    ],
    visible: EVERYONE,
  },
  {
    id: "pipeline.jobs-chart",
    page: "/pipeline",
    anchor: ['id="c-jobs"'],
    script: ['$("#c-jobs")', "S.jobs_daily", 'r.status === "done"'],
    reads: [{ path: "/api/v1/stats", fields: ["series.jobs_daily", "series.jobs_daily.0.day", "series.jobs_daily.0.status", "series.jobs_daily.0.n"] }],
    visible: EVERYONE,
  },
  {
    id: "pipeline.promotions-chart",
    page: "/pipeline",
    anchor: ['id="c-promos"'],
    script: ['$("#c-promos")', '"/api/v1/events?kind="', '["promote", "rollback", "fast-track"]', "e.created_at.slice(0, 10)"],
    reads: [
      { path: "/api/v1/events?kind=promote&limit=200", fields: ["events", "events.0.created_at", "events.0.status"] },
      { path: "/api/v1/events?kind=rollback&limit=200", fields: ["events"] },
      { path: "/api/v1/events?kind=fast-track&limit=200", fields: ["events"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "pipeline.health-heatgrid",
    page: "/pipeline",
    anchor: ['id="c-health"'],
    script: ['$("#c-health")', "heatGrid(S.health)"],
    reads: [{ path: "/api/v1/stats", fields: ["series.health"] }],
    visible: EVERYONE,
  },
  {
    id: "pipeline.imports-chart",
    page: "/pipeline",
    anchor: ['id="c-imports"'],
    script: ['$("#c-imports")', "S.imports_daily", "byDay[x].packages"],
    reads: [{ path: "/api/v1/stats", fields: ["series.imports_daily"] }],
    visible: EVERYONE,
  },
  {
    id: "pipeline.sync-chart",
    page: "/pipeline",
    anchor: ['id="c-sync"'],
    script: ['$("#c-sync")', "S.sync_runs", "r.bytes && r.duration_ms"],
    reads: [{ path: "/api/v1/stats", fields: ["series.sync_runs"] }],
    visible: EVERYONE,
  },
  {
    id: "pipeline.builds-chart",
    page: "/pipeline",
    anchor: ['id="c-builds"'],
    script: ['$("#c-builds")', "buildsByDay(d.series, 14)", '"Factory builds per day over fourteen days"'],
    reads: [{ path: "/api/v1/stats", fields: ["series.builds_daily", "series.builds_daily.0.day", "series.builds_daily.0.status", "series.builds_daily.0.n"] }],
    visible: EVERYONE,
  },
  {
    // The worker a task ran on is the shell's wtId over the listing's row (its id and the task's owner where the record no longer lists it); a published build links its package in edge at the shell's one address.
    // A pool job's row is worded from its params and its result (paramsLabel, jobResult): the fields named per kind are the ones the Rust jobs post (crates/pkg-repo/src/work.rs) and the brain queues (src/scheduler.ts, src/jobs.ts), on the fixture's done job of that kind; pool-jobs.test.ts reads the words.
    id: "pipeline.tasks-table",
    page: "/pipeline",
    anchor: ['id="tasks"'],
    script: ['pager("#tasks"', 'href="/build/', "evidenceLink(t)", 'pkgHref(t.name, "edge", t.arch)', "wtId(byId[t.lease_owner] || t.lease_owner)", "t.result_filename", "jobResult(t)", "paramsLabel(t)", "t.max_attempts", "r.sources", "r.releases", "sum.upstream_total"],
    reads: [
      { path: "/api/v1/factory?limit=100", fields: ["workers.0.id", "workers.0.owner", "tasks.0.id", "tasks.0.kind", "tasks.0.name", "tasks.0.version", "tasks.0.arch", "tasks.0.status", "tasks.0.trust", "tasks.0.owner", "tasks.0.publish", "tasks.0.attempts", "tasks.0.max_attempts", "tasks.0.reason", "tasks.0.lease_owner", "tasks.0.duration_ms", "tasks.0.result_filename", "tasks.0.result", "tasks.0.error", "tasks.0.params",
        "tasks.kind=sync.params.arch", "tasks.kind=sync.params.sources", "tasks.kind=sync.result.arch", "tasks.kind=sync.result.sources.0.source", "tasks.kind=sync.result.sources.0.upstream_total", "tasks.kind=sync.result.sources.0.uploaded", "tasks.kind=sync.result.sources.0.removed", "tasks.kind=sync.result.sources.0.failed", "tasks.kind=sync.result.releases.0.ring", "tasks.kind=sync.result.releases.0.seq", "tasks.kind=sync.result.rendered",
        "tasks.kind=promote.params.from", "tasks.kind=promote.params.to", "tasks.kind=promote.result.verdict", "tasks.kind=promote.result.release_id",
        "tasks.kind=rollback.params.ring", "tasks.kind=rollback.params.to", "tasks.kind=rollback.result.ring", "tasks.kind=rollback.result.to", "tasks.kind=rollback.result.release_id",
        "tasks.kind=render.params.ring", "tasks.kind=render.params.arch", "tasks.kind=render.result.repos",
        "tasks.kind=health.params.ring", "tasks.kind=health.params.arch", "tasks.kind=health.result.ok",
        "tasks.kind=gc.result.keep",
        "tasks.kind=security.result.matches_vulnerable", "tasks.kind=security.result.matches_fixed", "tasks.kind=security.result.kev", "tasks.kind=security.result.fast_tracked.0.ring", "tasks.kind=security.result.fast_tracked.0.fixes", "tasks.kind=security.result.rolled_back",
        "tasks.kind=verify.result.objects", "tasks.kind=verify.result.bad_signatures", "tasks.kind=verify.result.repaired_signatures", "tasks.kind=verify.result.mismatched", "tasks.kind=verify.result.repinned", "tasks.kind=verify.result.unfixable",
        "tasks.kind=relayout.result.moved", "tasks.kind=relayout.result.ghosts", "tasks.kind=relayout.result.missing", "tasks.kind=relayout.result.errors", "tasks.kind=relayout.result.purged",
        "tasks.kind=enqueue.result.commit", "tasks.kind=enqueue.result.queued", "tasks.kind=enqueue.result.skipped", "tasks.kind=enqueue.result.up_to_date"] },
      // A staged row's evidence is its build's page (the shell's evidenceLink), where what the build left is listed; the raw files are linked there.
      { path: `/build/${F.contributorTask}`, json: false },
    ],
    visible: EVERYONE,
  },
  {
    id: "pipeline.registry-table",
    page: "/pipeline",
    anchor: ['id="registry"'],
    script: ['fetch("/api/v1/factory/packages")', 'pager("#registry"', "p.staged_builds", '"/request.json"', "det.latest_tag"],
    reads: [{ path: "/api/v1/factory/packages", fields: ["packages.0.name", "packages.0.request_id", "packages.0.project", "packages.0.url", "packages.0.owner", "packages.0.arches", "packages.0.release", "packages.0.license", "packages.0.status", "packages.0.staged_builds", "packages.0.detail", "packages.0.updated_at", "packages.0.category", "packages.0.detected"] }],
    visible: EVERYONE,
  },
  {
    id: "pipeline.ring-heads",
    page: "/pipeline",
    anchor: ['id="heads"'],
    script: ['$("#heads")', "rel.parent_id", 'href="/diff?ring=', "r.package_count", "x.is_head"],
    reads: [{ path: "/api/v1/stats", fields: ["rings.2.ring", "rings.2.release.id", "rings.2.release.seq", "rings.2.release.created_at", "rings.2.release.parent_id", "rings.2.package_count", "rings.2.bytes", "latest", "releases", "releases.0.ring", "releases.0.id", "releases.0.seq", "releases.0.is_head"] }],
    visible: EVERYONE,
  },
  {
    id: "pipeline.rollback-action",
    page: "/pipeline",
    anchor: ['id="heads"', 'id="rb-state"'],
    // The page draws the button on every ring card with a release before the head, for everyone — live for a maintainer, grey with the reason for anyone else; the click, the dialog and the post are the shell's (shell.rollback).
    script: ['gate(\'<button type="button" class="small-btn" data-rollback="', "roll back to #", 'orSignIn("a maintainer rolls back")'],
    // Queued, never run: no worker claims it in the tests, so what stable serves does not change. `to` is a string, as the button's attribute sends it.
    acts: [{ method: "POST", path: "/api/v1/factory/jobs", body: { kind: "rollback", params: { ring: "stable", to: String(F.previousRelease), note: "the fixture's rollback" } }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 201 } }],
    visible: EVERYONE,
  },
  {
    id: "pipeline.journal-table",
    page: "/pipeline",
    anchor: ['id="events"'],
    script: ['pager("#events", d.events, eventRow', 'empty: "nothing yet", n: 10', "runHref(e.payload && e.payload.ci && e.payload.ci.run_url), rid = e.payload && Number(e.payload.release_id)"],
    reads: [{ path: "/api/v1/stats", fields: ["events", "events.0.status", "events.0.kind", "events.0.ring", "events.0.source", "events.0.summary", "events.0.payload", "events.0.duration_ms", "events.0.created_at"] }],
    visible: EVERYONE,
  },
  {
    // The three lines of the budget — warn, guard, cap — are read from /api/v1/cost, which carries them with and without an estimate: the sentence's three numbers, the cap beside the month, the guard's word and the mark on the bar; no number is typed on the page.
    id: "pipeline.budget",
    page: "/pipeline",
    anchor: ['id="budget"', 'data-live="cost-warn"', 'data-live="cost-guard"', 'data-live="cost-cap"'],
    script: ['fetch("/api/v1/cost")', '$("#budget")', "c.lines_usd", 'live("cost-warn", num(usd.warn))', 'live("cost-guard", num(usd.guard))', 'live("cost-cap", num(usd.cap))', "c.error", "c.month_to_date_usd", "c.projected_usd", "c.guard", "100 * usd.guard / usd.cap"],
    reads: [{ path: "/api/v1/cost", fields: ["month", "month_to_date_usd", "projected_usd", "status", "guard", "lines_usd.warn", "lines_usd.guard", "lines_usd.cap"] }],
    visible: EVERYONE,
  },
  {
    id: "pipeline.sponsor",
    page: "/pipeline",
    anchor: ['class="sponsor"', "Help keep it running.", 'href="mailto:sponsor@omarchy-pool.org"'],
    visible: EVERYONE,
  },
];
