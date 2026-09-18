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
    <p class="lede">Five feeds — the Arch and Debian security trackers, OSV, CISA KEV, EPSS — matched every three hours against what each ring serves. A package with an open advisory also <em>exposes</em> what depends on it; a confident fix already in <code>edge</code> is fast-tracked. <a href="/docs/security">The feeds and the confidences, explained →</a></p>
  </div>
  <form class="searchbar" onsubmit="return false">
    <div class="choice" id="pick-ring"></div>
    <div class="choice" id="pick-arch"></div>
    <div class="choice" id="pick-conf"></div>
  </form>
  <p class="sub" id="updated"></p>

  <div class="tiles" id="tiles"></div>
  <div class="charts" style="margin-bottom:32px">
    <div class="chart"><h3>Open advisories per ring <span id="sc-arch"></span></h3><div class="sub">by severity, a package once — edge catches fixes first, stable last</div><div id="sc-chart"><div class="empty">reading the three rings' reports — a few seconds…</div></div></div>
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
  // The rings a security run covers are the promised ones (the shell's PROMISED_RINGS, stable first — the lab is promised nothing and scanned for nothing), the architectures the shell's (ARCHES); the first of each is the default.
  var RINGS = PROMISED_RINGS;
  var q = new URLSearchParams(location.search);
  var ring = RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : RINGS[0];
  var arch = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : ARCHES[0];
  // The confidence picked, the shell's default (SEC_CONF) unless the query says: the tiles, the table and the per-ring chart count by the shell's one rule at it (advisoriesAt, advisoryCounts) — the rule the Pool's and the Pipeline's numbers count by too — and each says at which confidence.
  var conf = SEC_CONFS.indexOf(q.get("conf")) >= 0 ? q.get("conf") : SEC_CONF;
  function draw() {
    pick("#pick-ring", RINGS, ring, function (v) { ring = v; load(); }, { url: "ring" });
    pick("#pick-arch", ARCHES, arch, function (v) { arch = v; load(); }, { url: "arch" });
    pick("#pick-conf", SEC_CONFS, conf, function (v) { conf = v; load(); }, { url: "conf" });
  }
  // The feeds: what each tracker contributed to this ring's report — matches, exploited, and the last refresh.
  var FEEDS = [["arch", "Arch Security Tracker", "exact matches on Arch's own versions"], ["debian", "Debian Security Tracker", "the same upstream, Debian's fixed version compared to ours"], ["osv", "OSV", "Go modules and crates inside static binaries"], ["kev", "CISA KEV", "exploited in the wild — always fast-tracked"], ["epss", "EPSS", "likelihood of exploitation, orders the list"]];
  function renderFeeds(d) {
    var v = d.vulnerable || [], count = {}, kev = 0, epss = 0;
    v.forEach(function (x) { (x.advisories || []).forEach(function (a) { count[a.tracker] = (count[a.tracker] || 0) + 1; if (a.kev) kev++; if (a.epss != null) epss++; }); });
    $("#sc-feeds-when").textContent = d.updated_at ? "refreshed " + ago(d.updated_at) : "no run yet";
    $("#sc-feeds").innerHTML = FEEDS.map(function (f) { var n = f[0] === "kev" ? kev : f[0] === "epss" ? epss : (count[f[0]] || 0); return '<div class="feed"><b>' + f[1] + '</b><span>' + f[2] + '</span><span class="dim"><b class="num">' + num(n) + '</b> ' + (f[0] === "kev" ? "exploited" : f[0] === "epss" ? "scored" : "matched") + ' in ' + ring + '</span></div>'; }).join("");
  }
  // Open advisories per ring, counted as the tiles count (the shell's advisoriesAt, advisoryCounts) at the confidence picked: the report on screen reused for its ring, the other two read once each.
  function renderPerRing(d) {
    $("#sc-arch").textContent = arch + " · " + confWord(conf);
    Promise.all(RINGS.map(function (r) { return r === ring ? Promise.resolve(d) : fetch("/api/v1/security?ring=" + r + "&arch=" + arch).then(function (x) { return x.json(); }).catch(function () { return {}; }); })).then(function (reports) {
      var tot = reports.map(function (x) { return advisoryCounts(advisoriesAt(x, conf)); });
      // The stack's series are the shell's severity buckets in the shell's colours — the words and colours the Pool's bars and the pills in the table below wear — one value per ring, the way a package climbs (PROMISED_UPWARD: edge first).
      var series = PROMISED_UPWARD.map(function (r) { return sevSeries(tot[RINGS.indexOf(r)]); });
      $("#sc-chart").innerHTML = stacked(PROMISED_UPWARD, series[0].map(function (b, k) { return { name: b.name, color: b.color, values: series.map(function (s) { return s[k].value; }) }; }), { label: "Open advisories per ring by severity", full: true, empty: "no open advisory in any ring" });
    });
  }
  function load() {
    draw();
    $("#updated").textContent = "Loading " + ring + " · " + arch + " — the report covers every package the ring serves, this takes a few seconds…";
    skeletonTiles("#tiles", 5); skeletonRows("#vuln", 7, 6);
    busy(fetch("/api/v1/security?ring=" + ring + "&arch=" + arch)).then(function (r) { return r.json(); }).then(function (d) {
      var rows = advisoriesAt(d, conf), c = advisoryCounts(rows);
      setTiles("#tiles", [
        ["Packages with open advisories", num(c.packages), "of what " + ring + " serves for " + arch + " · " + confWord(conf)],
        ["Critical / high", num(c.critical) + " / " + num(c.high), num(c.medium) + " medium · " + num(c.low) + " low · " + num(c.unknown) + " unknown"],
        ["Exploited in the wild", num(c.kev), "CISA KEV"],
        ["Fix available in another ring", num(rows.filter(function (r) { return r.v.fixed_in.length; }).length), "fast-track candidates"],
        // The report's own number, whatever the picker: exposure follows the confident advisories (exact, name-version), never a name-only one.
        ["Packages exposed", num(d.totals && d.totals.exposed || 0), "depend on, or load a library of, a package with a confident advisory"]
      ]);
      $("#updated").textContent = (d.updated_at ? "Advisories refreshed " + ago(d.updated_at) + " · " : "No security run recorded yet · ") + num(d.advisories_total) + " advisories in the index";
      renderFeeds(d); renderPerRing(d);
      pager("#vuln", rows, function (r) {
        var v = r.v;
        return '<tr><td>' + sevPill(r.worst) + (r.kev ? ' ' + pillHtml(SEV_PILL.exploited, "exploited", "in CISA KEV") : '') + (r.epss >= 0.1 ? ' ' + pillHtml("warn", "epss " + (r.epss * 100).toFixed(0) + "%", "EPSS " + (r.epss * 100).toFixed(0) + "%") : '') + '</td>' +
          '<td><a href="' + pkgHref(v.name, ring, arch) + '"><b>' + esc(v.name) + '</b></a> <span class="src">' + esc(v.source) + '</span></td><td class="mono">' + esc(v.version) + '</td>' +
          '<td>' + r.advs.map(function (a) { return '<a class="run" href="' + esc(a.url) + '">' + esc(a.id.replace(/^(arch|debian|osv):/, "").replace(/:[^:]*$/, "")) + '</a>' + (a.fixed ? ' <span class="muted">fixed in ' + esc(a.fixed) + '</span>' : ''); }).join("<br>") + '</td>' +
          '<td>' + [...new Set(r.advs.map(function (a) { return a.match; }))].join(", ") + '</td>' +
          '<td>' + (v.exposure.declared || v.exposure.loads ? num(v.exposure.declared) + ' declared · ' + num(v.exposure.loads) + ' load it' : '<span class="muted">nothing</span>') + '</td>' +
          '<td>' + (v.fixed_in.length ? v.fixed_in.map(function (f) { return '<a href="' + pkgHref(v.name, f.ring, arch) + '">' + f.ring + ' ' + esc(f.version) + '</a>'; }).join(", ") : '<span class="muted">—</span>') + '</td></tr>';
      }, { empty: 'nothing with an open advisory at this confidence level' });
      endSkeleton();
    }).catch(function (e) { $("#updated").textContent = "failed: " + e; endSkeleton(); });
  }
  load();
`;

export function securityHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/security",
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
 * tiles, the feeds card and the table; the per-ring chart reuses it for the
 * ring on screen and reads the same endpoint once for each other ring, and
 * the arch picker asks it for the other architecture. The tiles, the table
 * and the chart count by the shell's one rule (advisoriesAt) at the
 * confidence picked, and say so. Nothing here changes with the role and nothing writes: the
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
      script: ['pick("#pick-ring"', 'pick("#pick-arch"', 'pick("#pick-conf"', 'RINGS = PROMISED_RINGS', 'ARCHES.indexOf(q.get("arch"))', 'SEC_CONFS.indexOf(q.get("conf")) >= 0 ? q.get("conf") : SEC_CONF', 'pick("#pick-conf", SEC_CONFS', '{ url: "ring" }', '{ url: "arch" }', '{ url: "conf" }'],
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
      // The tiles count what the shell's advisoriesAt() keeps at the confidence picked — the one rule the table, the per-ring chart, the Pool and the Pipeline count by — and name the confidence; exposed is the report's own.
      script: [
        'fetch("/api/v1/security?ring=" + ring + "&arch=" + arch)', 'skeletonTiles("#tiles", 5)', 'setTiles("#tiles"', "advisoriesAt(d, conf), c = advisoryCounts(rows)", "confWord(conf)",
        '"Packages with open advisories"', '"Critical / high"', '"Exploited in the wild"', '"Fix available in another ring"', '"Packages exposed"',
        "r.v.fixed_in.length", "d.totals.exposed", "with a confident advisory",
      ],
      reads: [{ path: report, fields: ["vulnerable", "vulnerable.0.advisories.0.match", "vulnerable.0.advisories.0.severity", "vulnerable.0.advisories.0.kev", "vulnerable.0.advisories.0.epss", "vulnerable.0.fixed_in", "totals.exposed"] }],
      visible: EVERYONE,
    },
    {
      id: "security.per-ring-chart",
      page: "/security",
      // The chart counts each ring's report as the tiles count the one on screen (the shell's advisoryCounts over advisoriesAt, at the confidence picked, the report on screen reused), a package once: exploited first, the rest by worst severity — the shell's buckets (sevSeries) in the shell's colours (SEV_COLOR), the ones the Pool's bars and the pills below wear.
      anchor: ['<h3>Open advisories per ring <span id="sc-arch"></span></h3>', 'id="sc-chart"', "by severity, a package once — edge catches fixes first, stable last"],
      script: [
        'fetch("/api/v1/security?ring=" + r + "&arch=" + arch)', "r === ring ? Promise.resolve(d)", '"#sc-chart"', '"#sc-arch"', 'stacked(PROMISED_UPWARD', 'PROMISED_UPWARD.map(function (r) { return sevSeries(tot[RINGS.indexOf(r)]); })', "advisoryCounts(advisoriesAt(x, conf))",
        "sevSeries(tot[RINGS.indexOf(r)])", "b.color", "s[k].value",
        '"Open advisories per ring by severity"', '"no open advisory in any ring"',
      ],
      reads: [
        { path: report, fields: ["vulnerable", "vulnerable.0.advisories.0.match", "vulnerable.0.advisories.0.severity", "vulnerable.0.advisories.0.kev"] },
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
        'skeletonRows("#vuln", 7, 6)', 'pager("#vuln", rows', "sevPill(r.worst)", 'pillHtml(SEV_PILL.exploited, "exploited", "in CISA KEV")', "r.epss >= 0.1", "pkgHref(v.name, ring, arch)",
        "a.id.replace(/^(arch|debian|osv):/", "a.fixed", "a.match", "v.exposure.declared", "v.exposure.loads", "v.fixed_in.map", "pkgHref(v.name, f.ring, arch)", "f.version",
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
