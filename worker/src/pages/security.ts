/**
 * Security: what a ring serves that has an open advisory, how sure we are,
 * whether a fixed version already sits in another ring, and how much of the
 * ring depends on it.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { CHARTS } from "./charts";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Security</p>
    <h1>What a ring serves that has an open advisory — and how sure we are</h1>
    <p class="lede">Five feeds — the Arch and Debian security trackers, OSV, CISA KEV, EPSS — matched every three hours against what each ring serves. A package with an open advisory also <em>exposes</em> what depends on it; a confident fix already in <code>edge</code> is fast-tracked. <a href="/docs#security">The feeds and the confidences, explained →</a></p>
  </div>
  <form class="searchbar" onsubmit="return false">
    <div class="choice" id="pick-ring"></div>
    <div class="choice" id="pick-arch"></div>
    <div class="choice" id="pick-conf"></div>
  </form>
  <p class="sub" id="updated"></p>

  <div class="tiles" id="tiles"></div>
  <div class="charts" style="margin-bottom:32px">
    <div class="chart"><h3>Open advisories per ring <span id="sc-arch"></span></h3><div class="sub">by severity — edge catches fixes first, stable last</div><div id="sc-chart"><div class="empty">reading the three rings' reports — a few seconds…</div></div></div>
    <div class="chart"><h3>The feeds <span id="sc-feeds-when"></span></h3><div class="sub">what each one contributes to this ring's report</div><div class="feeds" id="sc-feeds"></div></div>
  </div>

  <section>
    <h2>Packages with open advisories</h2>
    <p class="sub"><b>exact</b>: the tracker knows this distribution's version, or the build information names the embedded module's version. <b>name-version</b>: Debian fixed it in a version newer than ours. <b>name-only</b>: still open upstream, no version to compare — possibly affected. <b>Fixed in</b> lists rings already serving a version with no open advisory (the fast-track candidate).</p>
    <div class="table-wrap"><table id="vuln"><thead><tr><th>Severity</th><th>Package</th><th>Version</th><th>Advisories</th><th>Confidence</th><th>Exposes</th><th>Fixed in</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
__CHARTS__
  var RINGS = ["stable", "rc", "edge"], ARCHES = ["x86_64", "aarch64"], CONF = ["all", "exact + name-version", "exact"];
  var q = new URLSearchParams(location.search);
  var ring = RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : "stable";
  var arch = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : "x86_64";
  var conf = CONF.indexOf(q.get("conf")) >= 0 ? q.get("conf") : "exact + name-version";
  function pick(id, values, current, onpick) {
    $("#" + id).innerHTML = values.map(function (v) { return '<button type="button" class="' + (v === current ? "on" : "") + '" data-v="' + v + '">' + v + '</button>'; }).join("");
    $("#" + id).querySelectorAll("button").forEach(function (b) { b.onclick = function () { onpick(b.getAttribute("data-v")); }; });
  }
  function sev(s) { var c = { critical: "var(--red)", high: "var(--red)", medium: "var(--amber)", low: "var(--blue)", unknown: "var(--dim)" }[s] || "var(--dim)"; return '<span class="pill" style="color:' + c + ';border-color:' + c + '">' + s + '</span>'; }
  function confOk(m) { return conf === "all" || m === "exact" || (conf === "exact + name-version" && m === "name-version"); }
  function draw() {
    pick("pick-ring", RINGS, ring, function (v) { ring = v; sync(); load(); });
    pick("pick-arch", ARCHES, arch, function (v) { arch = v; sync(); load(); });
    pick("pick-conf", CONF, conf, function (v) { conf = v; sync(); load(); });
  }
  function sync() { history.replaceState(null, "", "?ring=" + ring + "&arch=" + arch + "&conf=" + encodeURIComponent(conf)); }
  // The feeds: what each tracker contributed to this ring's report — matches, exploited, and the last refresh.
  var FEEDS = [["arch", "Arch Security Tracker", "exact matches on Arch's own versions"], ["debian", "Debian Security Tracker", "the same upstream, Debian's fixed version compared to ours"], ["osv", "OSV", "Go modules and crates inside static binaries"], ["kev", "CISA KEV", "exploited in the wild — always fast-tracked"], ["epss", "EPSS", "likelihood of exploitation, orders the list"]];
  function renderFeeds(d) {
    var v = d.vulnerable || [], count = {}, kev = 0, epss = 0;
    v.forEach(function (x) { (x.advisories || []).forEach(function (a) { count[a.tracker] = (count[a.tracker] || 0) + 1; if (a.kev) kev++; if (a.epss != null) epss++; }); });
    $("#sc-feeds-when").textContent = d.updated_at ? "refreshed " + ago(d.updated_at) : "no run yet";
    $("#sc-feeds").innerHTML = FEEDS.map(function (f) { var n = f[0] === "kev" ? kev : f[0] === "epss" ? epss : (count[f[0]] || 0); return '<div class="feed"><b>' + f[1] + '</b><span>' + f[2] + '</span><span class="dim"><b class="num">' + num(n) + '</b> ' + (f[0] === "kev" ? "exploited" : f[0] === "epss" ? "scored" : "matched") + ' in ' + ring + '</span></div>'; }).join("");
  }
  // Open advisories per ring, by severity: one report per ring, the one on screen reused.
  function renderPerRing() {
    $("#sc-arch").textContent = arch;
    Promise.all(RINGS.map(function (r) { return fetch("/api/v1/security?ring=" + r + "&arch=" + arch).then(function (x) { return x.json(); }).then(function (x) { return x.totals || {}; }).catch(function () { return {}; }); })).then(function (tot) {
      $("#sc-chart").innerHTML = stacked(["edge", "rc", "stable"], [{ name: "exploited", color: C.red, values: [2, 1, 0].map(function (i) { return tot[i].kev || 0; }) }, { name: "critical + high", color: C.amber, values: [2, 1, 0].map(function (i) { return (tot[i].critical || 0) + (tot[i].high || 0); }) }, { name: "medium", color: C.blue, values: [2, 1, 0].map(function (i) { return tot[i].medium || 0; }) }, { name: "low / unknown", color: C.dim, values: [2, 1, 0].map(function (i) { return (tot[i].low || 0) + (tot[i].unknown || 0); }) }], { label: "Open advisories per ring by severity", full: true, empty: "no open advisory in any ring" });
    });
  }
  function load() {
    draw();
    $("#updated").textContent = "Loading " + ring + " · " + arch + " — the report covers every package the ring serves, this takes a few seconds…";
    skeletonTiles("#tiles", 5); skeletonRows("#vuln", 7, 6);
    busy(fetch("/api/v1/security?ring=" + ring + "&arch=" + arch)).then(function (r) { return r.json(); }).then(function (d) {
      var rows = (d.vulnerable || []).map(function (v) {
        var advs = v.advisories.filter(function (a) { return confOk(a.match); });
        if (!advs.length) return null;
        var worst = advs.reduce(function (w, a) { var order = ["critical", "high", "medium", "low", "unknown"]; return order.indexOf(a.severity) < order.indexOf(w) ? a.severity : w; }, "unknown");
        return { v: v, advs: advs, worst: worst, kev: advs.some(function (a) { return a.kev; }), epss: advs.reduce(function (m, a) { return a.epss != null && a.epss > m ? a.epss : m; }, 0) };
      }).filter(Boolean);
      var count = function (s) { return rows.filter(function (r) { return r.worst === s; }).length; };
      var tiles = [
        ["Packages with open advisories", num(rows.length), "of what " + ring + " serves for " + arch],
        ["Critical / high", num(count("critical")) + " / " + num(count("high")), num(count("medium")) + " medium · " + num(count("low")) + " low · " + num(count("unknown")) + " unknown"],
        ["Exploited in the wild", num(rows.filter(function (r) { return r.kev; }).length), "CISA KEV"],
        ["Fix available in another ring", num(rows.filter(function (r) { return r.v.fixed_in.length; }).length), "fast-track candidates"],
        ["Packages exposed", num(d.totals && d.totals.exposed || 0), "depend on, or load a library of, a package with a confident advisory"]
      ];
      tiles.forEach(function (t, i) { var el = $("#tiles"), cell = el.children[i]; if (!cell) { cell = document.createElement("div"); cell.className = "tile"; el.appendChild(cell); } setTile(cell, '<div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div>'); });
      $("#updated").textContent = (d.updated_at ? "Advisories refreshed " + ago(d.updated_at) + " · " : "No security run recorded yet · ") + num(d.advisories_total) + " advisories in the index";
      renderFeeds(d); renderPerRing();
      pager("#vuln", rows, function (r) {
        var v = r.v;
        return '<tr><td>' + sev(r.worst) + (r.kev ? ' <span class="pill error" title="in CISA KEV">exploited</span>' : '') + (r.epss >= 0.1 ? ' <span class="pill warn" title="EPSS ' + (r.epss * 100).toFixed(0) + '%">epss ' + (r.epss * 100).toFixed(0) + '%</span>' : '') + '</td>' +
          '<td><a href="/package/' + encodeURIComponent(v.name) + '?ring=' + ring + '&arch=' + arch + '"><b>' + esc(v.name) + '</b></a> <span class="src">' + esc(v.source) + '</span></td><td class="mono">' + esc(v.version) + '</td>' +
          '<td>' + r.advs.map(function (a) { return '<a class="run" href="' + esc(a.url) + '">' + esc(a.id.replace(/^(arch|debian|osv):/, "").replace(/:[^:]*$/, "")) + '</a>' + (a.fixed ? ' <span class="muted">fixed in ' + esc(a.fixed) + '</span>' : ''); }).join("<br>") + '</td>' +
          '<td>' + [...new Set(r.advs.map(function (a) { return a.match; }))].join(", ") + '</td>' +
          '<td>' + (v.exposure.declared || v.exposure.loads ? num(v.exposure.declared) + ' declared · ' + num(v.exposure.loads) + ' load it' : '<span class="muted">nothing</span>') + '</td>' +
          '<td>' + (v.fixed_in.length ? v.fixed_in.map(function (f) { return '<a href="/package/' + encodeURIComponent(v.name) + '?ring=' + f.ring + '&arch=' + arch + '">' + f.ring + ' ' + esc(f.version) + '</a>'; }).join(", ") : '<span class="muted">—</span>') + '</td></tr>';
      }, { empty: 'nothing with an open advisory at this confidence level' });
      endSkeleton();
    }).catch(function (e) { $("#updated").textContent = "failed: " + e; endSkeleton(); });
  }
  load();
  liveStats(function () {}, 120000);
`;

export function securityHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Security · omarchy-pool",
    description: "Open advisories on what each ring serves, with confidence levels, exploitation data and what they expose through dependencies.",
    active: "none",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}

/**
 * What /security is made of.
 * One report, `GET /api/v1/security?ring=&arch=`, feeds the status line, the
 * tiles, the feeds card and the table; the per-ring chart reads the same
 * endpoint once per ring, and the arch picker asks it for the other
 * architecture. Nothing here changes with the role and nothing writes: the
 * endpoints that write advisories take the pipeline's job token.
 */
export const SECURITY_COMPONENTS = (F: Fixture): Component[] => {
  const report = `/api/v1/security?ring=stable&arch=${F.arch}`;
  return [
    {
      id: "security.hero",
      page: "/security",
      anchor: ['<p class="eyebrow">Security</p>', "<h1>What a ring serves that has an open advisory — and how sure we are</h1>", "The feeds and the confidences, explained →</a>"],
      visible: EVERYONE,
    },
    {
      id: "security.pickers",
      page: "/security",
      anchor: ['id="pick-ring"', 'id="pick-arch"', 'id="pick-conf"'],
      script: ['"pick-ring"', '"pick-arch"', '"pick-conf"', 'RINGS = ["stable", "rc", "edge"]', 'ARCHES = ["x86_64", "aarch64"]', 'CONF = ["all", "exact + name-version", "exact"]', "history.replaceState"],
      reads: [{ path: "/api/v1/security?ring=stable&arch=aarch64", fields: ["ring", "arch", "vulnerable", "totals.packages"] }],
      visible: EVERYONE,
    },
    {
      id: "security.updated-line",
      page: "/security",
      anchor: ['id="updated"'],
      script: ['"#updated"', '"Advisories refreshed "', '"No security run recorded yet · "', "d.advisories_total", '" advisories in the index"'],
      reads: [{ path: report, fields: ["updated_at", "advisories_total"] }],
      visible: EVERYONE,
    },
    {
      id: "security.tiles",
      page: "/security",
      anchor: ['id="tiles"'],
      script: [
        'fetch("/api/v1/security?ring=" + ring + "&arch=" + arch)', 'skeletonTiles("#tiles", 5)', "confOk(a.match)",
        '"Packages with open advisories"', '"Critical / high"', '"Exploited in the wild"', '"Fix available in another ring"', '"Packages exposed"',
        "r.v.fixed_in.length", "d.totals.exposed",
      ],
      reads: [{ path: report, fields: ["vulnerable", "vulnerable.0.advisories.0.match", "vulnerable.0.advisories.0.severity", "vulnerable.0.advisories.0.kev", "vulnerable.0.advisories.0.epss", "vulnerable.0.fixed_in", "totals.exposed"] }],
      visible: EVERYONE,
    },
    {
      id: "security.per-ring-chart",
      page: "/security",
      anchor: ['<h3>Open advisories per ring <span id="sc-arch"></span></h3>', 'id="sc-chart"'],
      script: [
        'fetch("/api/v1/security?ring=" + r + "&arch=" + arch)', '"#sc-chart"', '"#sc-arch"', 'stacked(["edge", "rc", "stable"]',
        "tot[i].kev", "tot[i].critical", "tot[i].high", "tot[i].medium", "tot[i].low", "tot[i].unknown",
        '"Open advisories per ring by severity"', '"no open advisory in any ring"',
      ],
      reads: [
        { path: report, fields: ["totals.kev", "totals.critical", "totals.high", "totals.medium", "totals.low", "totals.unknown"] },
        // A ring without a release answers the empty envelope; the chart draws it as zero.
        { path: `/api/v1/security?ring=rc&arch=${F.arch}`, fields: ["ring", "arch", "vulnerable", "totals"] },
        { path: `/api/v1/security?ring=edge&arch=${F.arch}`, fields: ["ring", "arch", "vulnerable", "totals"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "security.feeds-card",
      page: "/security",
      anchor: ['<h3>The feeds <span id="sc-feeds-when"></span></h3>', 'id="sc-feeds"'],
      script: ['"#sc-feeds"', '"#sc-feeds-when"', '"Arch Security Tracker"', '"Debian Security Tracker"', '"OSV"', '"CISA KEV"', '"EPSS"', "count[a.tracker]", "a.epss != null", '"refreshed "'],
      reads: [{ path: report, fields: ["updated_at", "vulnerable.0.advisories.0.tracker", "vulnerable.0.advisories.0.kev", "vulnerable.0.advisories.0.epss"] }],
      visible: EVERYONE,
    },
    {
      id: "security.vuln-section-intro",
      page: "/security",
      anchor: ["<h2>Packages with open advisories</h2>", "<b>exact</b>", "<b>name-version</b>", "<b>name-only</b>", "<b>Fixed in</b>"],
      visible: EVERYONE,
    },
    {
      id: "security.vuln-table",
      page: "/security",
      anchor: ['id="vuln"', "<th>Severity</th><th>Package</th><th>Version</th><th>Advisories</th><th>Confidence</th><th>Exposes</th><th>Fixed in</th>"],
      script: [
        'skeletonRows("#vuln", 7, 6)', 'pager("#vuln", rows', "sev(r.worst)", '"in CISA KEV"', "r.epss >= 0.1", "encodeURIComponent(v.name)",
        "a.id.replace(/^(arch|debian|osv):/", "a.fixed", "a.match", "v.exposure.declared", "v.exposure.loads", "v.fixed_in.map", "f.ring", "f.version",
        "nothing with an open advisory at this confidence level",
      ],
      reads: [
        {
          path: report,
          fields: [
            "vulnerable.0.name", "vulnerable.0.version", "vulnerable.0.source",
            "vulnerable.0.advisories.0.id", "vulnerable.0.advisories.0.url", "vulnerable.0.advisories.0.fixed", "vulnerable.0.advisories.0.match",
            "vulnerable.0.advisories.0.severity", "vulnerable.0.advisories.0.kev", "vulnerable.0.advisories.0.epss",
            "vulnerable.0.exposure.declared", "vulnerable.0.exposure.loads",
            "vulnerable.0.fixed_in", "vulnerable.0.fixed_in.0.ring", "vulnerable.0.fixed_in.0.version",
          ],
        },
      ],
      visible: EVERYONE,
    },
  ];
};
