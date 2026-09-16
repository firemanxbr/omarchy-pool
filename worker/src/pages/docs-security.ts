/**
 * Security, the chapter: the five feeds, how sure a match is, exposure
 * through the dependency graph, the fast-track. The live view — every
 * advisory per ring — is the Security page (/security).
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const FEEDS: [string, string, string][] = [
  ["Arch Security Tracker", "Exact matches on Arch's own versions: the tracker knows this distribution's package and version.", "exact"],
  ["Debian Security Tracker", "The same upstream projects where Arch has no advisory yet; Debian's fixed version compared to ours.", "name-version"],
  ["OSV", "The Go modules and crates.io crates a statically linked binary embeds — no soname reveals those; the build information does.", "exact"],
  ["CISA KEV", "What is exploited in the wild right now. A KEV match is fast-tracked whatever its score.", "priority"],
  ["EPSS", "How likely exploitation is in the next 30 days, per CVE. Orders the list; never hides a match.", "priority"],
];

const BODY = String.raw`
  <h1>Security</h1>
  <p class="lede">Public advisories matched against what each ring serves, every three hours, on both architectures. A package with an open advisory also <em>exposes</em> what depends on it; a promotion that would replace a clean package with a vulnerable one is blocked; a confident fix is pulled forward. <a href="/security">Every advisory, per ring →</a></p>

  <section id="feeds">
    <h2>The five feeds</h2>
    <div class="srcs" id="feeds"></div>
    <p class="sub" id="feed-text"></p>
  </section>

  <section id="confidence">
    <h2>How sure we are</h2>
    <div class="table-wrap"><table><thead><tr><th>Confidence</th><th>Means</th></tr></thead><tbody>
      <tr><td><span class="pill error">exact</span></td><td>the tracker knows this distribution's version, or the build information names the embedded module's version</td></tr>
      <tr><td><span class="pill warn">name-version</span></td><td>Debian fixed it in a version newer than ours</td></tr>
      <tr><td><span class="pill none">name-only</span></td><td>still open upstream, no version to compare — possibly affected</td></tr>
    </tbody></table></div>
    <p class="sub" style="margin-top:12px">Clean must mean examined: a package whose vulnerable object embeds components (Go modules, crates) is only clean elsewhere when that object was scanned for them too; one indexed before the scan existed knows nothing.</p>
  </section>

  <section id="exposure">
    <h2>Exposure through the graph</h2>
    <p class="sub">Because the index knows what every binary loads, an advisory on a library also marks what <em>uses</em> it: the <a href="/security">Security</a> page shows the ring, the package page shows the chain, and <code>omarchy-cli security</code> shows what applies to one machine.</p>
  </section>

  <section id="fast-track">
    <h2>The fast-track</h2>
    <p class="sub">Fixes do not wait for the soak. When <code>edge</code> serves a clean newer version of a package with a confident advisory — medium or worse, or exploited in the wild — the fast-track pulls it into <code>rc</code> and <code>stable</code> with the usual health check and rollback; a factory build the trial installed takes the same lane. Each one is a <code>fast-track</code> line in the <a href="/journal?kind=fast-track">journal</a>, with the reason.</p>
  </section>
`;

const SCRIPT = String.raw`
  var FEEDS = ${JSON.stringify(FEEDS)}, feed = 0;
  function drawFeeds() {
    $("#feeds").innerHTML = FEEDS.map(function (x, i) { return '<button type="button" data-feed="' + i + '" class="' + (feed === i ? "on" : "") + '">' + esc(x[0]) + '</button>'; }).join("");
    $("#feeds").querySelectorAll("button").forEach(function (b) { b.onclick = function () { feed = Number(b.getAttribute("data-feed")); drawFeeds(); }; });
    var f = FEEDS[feed];
    $("#feed-text").innerHTML = '<b style="color:var(--text)">' + esc(f[0]) + '.</b> ' + esc(f[1]) + ' <span class="pill none">' + esc(f[2]) + '</span>';
  }
  drawFeeds();
`;

export function docsSecurityHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Security · Documentation · omarchy-pool",
    description: "The five security feeds, how sure a match is, exposure through the dependency graph, and the fast-track.",
    active: "docs",
    doc: "security",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
