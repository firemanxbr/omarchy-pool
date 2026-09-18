/**
 * Packages: search within a ring, and one package's page — where it is in
 * every ring, what it declares, what its binaries actually load, who depends
 * on it, drawn as a graph — with the file list on demand.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { CHARTS } from "./charts";
import type { RunningVersion } from "../meta";

const SEARCH_BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Packages</p>
    <h1>Every package the pool serves, in every ring</h1>
    <p class="lede">Search by name or by words from the description. Open a package for its versions per ring, who made it, the dependency graph, the files and the seal.</p>
  </div>
  <form id="search" class="searchbar" onsubmit="return false">
    <input id="q" type="search" placeholder="package name or words from its description" autofocus autocomplete="off">
    <div class="choice" id="pick-ring"></div>
    <div class="choice" id="pick-arch"></div>
  </form>
  <p class="sub" id="hint">Type at least two characters.</p>
  <div class="two pk-grid">
    <div class="pk-results"><div class="table-wrap"><table id="results"><thead><tr><th>Package</th><th>Version</th><th>Source</th><th>By</th><th>Description</th><th class="num">Size</th></tr></thead><tbody></tbody></table></div></div>
    <div class="panel" id="pk-detail"><h3>Pick a package</h3><p class="sub" style="margin:0">Click a row for its versions per ring, what it depends on, what depends on it, who made it and whether an advisory is open — or open the full page.</p></div>
  </div>
  <div class="tiles five" id="pk-tiles"></div>
  <section><div class="charts">
    <div class="chart"><h3>Packages per source <span id="pk-src-ring">stable</span></h3><div class="sub">what each upstream contributes to the ring, per architecture</div><div id="pk-sources"></div></div>
    <div class="chart"><h3>What the last stable changed <span id="pk-diff-when"></span></h3><div class="sub">against its parent — the diff every release carries</div><div id="pk-diff"></div></div>
  </div></section>
`;

const SEARCH_SCRIPT = String.raw`
__CHARTS__
  var RINGS = ["stable", "rc", "edge"], ARCHES = ["x86_64", "aarch64"];
  var q = new URLSearchParams(location.search);
  var ring = RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : "stable";
  var arch = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : "x86_64";
  var timer = null, seq = 0, OWNERS = {}, APPROVERS = {};
  // Who made the factory's packages: the contributor who registered it, the maintainer who approved it.
  fetch("/api/v1/factory/packages").then(function (r) { return r.json(); }).then(function (d) { (d.packages || []).forEach(function (p) { OWNERS[p.name] = p.owner; }); }).catch(function () {});
  fetch("/api/v1/factory/approvals").then(function (r) { return r.json(); }).then(function (d) { (d.approvals || []).forEach(function (a) { if (a.decision === "approved" && !APPROVERS[a.name]) APPROVERS[a.name] = a.by; }); }).catch(function () {});
  function byCell(p) {
    if (p.source === "factory") { var o = OWNERS[p.name], a = APPROVERS[p.name]; return '<span class="by">' + (o ? avatar(o, "contributor") : "") + (a ? avatar(a, "maintainer") : "") + '</span>' + (!o && !a ? '<span class="dim">the pool</span>' : ""); }
    return '<span class="dim" style="font-size:12px">' + (p.source === "alarm" ? "Arch Linux ARM" : p.source === "packages" ? "Omarchy" : p.source === "chaotic" ? "Chaotic-AUR" : "Arch Linux") + '</span>';
  }
  function sync() {
    pick("#pick-ring", RINGS, ring, function (v) { ring = v; sync(); run(); });
    pick("#pick-arch", ARCHES, arch, function (v) { arch = v; sync(); run(); });
    var term = $("#q").value.trim();
    history.replaceState(null, "", "?q=" + encodeURIComponent(term) + "&ring=" + ring + "&arch=" + arch);
  }
  function run() {
    var term = $("#q").value.trim(), my = ++seq;
    if (term.length < 2) { $("#hint").textContent = "Type at least two characters."; pager("#results", [], function () { return ""; }, { empty: "type at least two characters" }); return; }
    $("#hint").textContent = "Searching " + ring + " · " + arch + "…";
    skeletonRows("#results", 5, 5);
    busy(fetch("/api/v1/search?q=" + encodeURIComponent(term) + "&ring=" + ring + "&arch=" + arch + "&limit=100")).then(function (r) { return r.json(); }).then(function (d) {
      if (my !== seq) return;
      var rows = d.packages || [];
      $("#hint").textContent = rows.length ? rows.length + (rows.length === 100 ? "+" : "") + " package(s) in " + ring + " · " + arch : "Nothing in " + ring + " · " + arch + " matches “" + term + "”.";
      pager("#results", rows, function (p) {
        return '<tr data-name="' + esc(p.name) + '" style="cursor:pointer"><td><a class="pkname" href="/package/' + encodeURIComponent(p.name) + '?ring=' + ring + '&arch=' + arch + '" title="open the package page">' + esc(p.name) + ' <span class="go">→</span></a></td><td class="mono">' + esc(p.version) + '</td><td><span class="src">' + esc(p.source) + '</span></td><td>' + byCell(p) + '</td><td class="muted"><span class="clamp">' + esc(p.description || "") + '</span></td><td class="num">' + bytes(p.size_download) + '</td></tr>';
      }, { empty: "nothing matches", n: 25, text: function (p) { return p.name + " " + (p.description || "") + " " + p.source; } });
    }).catch(function (e) { $("#hint").textContent = "search failed: " + e; endSkeleton(); });
  }
  $("#q").value = q.get("q") || "";
  $("#q").addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { sync(); run(); }, 250); });
  sync(); run();
  // A row opens the panel: the package's page data, summarised.
  document.addEventListener("click", function (ev) {
    var tr = ev.target.closest ? ev.target.closest("#results tbody tr") : null; if (!tr || !tr.getAttribute("data-name") || (ev.target.closest && ev.target.closest("a"))) return;
    document.querySelectorAll("#results tr.sel").forEach(function (x) { x.classList.remove("sel"); }); tr.classList.add("sel");
    detail(tr.getAttribute("data-name"));
  });
  function detail(name) {
    var el = $("#pk-detail"); el.innerHTML = '<h3>' + esc(name) + '</h3><div class="empty loading">Loading</div>';
    busy(fetch("/api/v1/package/" + encodeURIComponent(name) + "?ring=" + ring + "&arch=" + arch)).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { el.innerHTML = '<h3>' + esc(name) + '</h3><p class="sub" style="margin:0">' + esc(d.error) + '</p>'; return; }
      var p = d.package, m = d.manifest || {}, pi = m.pkginfo || {}, mt = d.maintenance || {}, f = mt.factory, own = (d.security && d.security.advisories || []).filter(function (a) { return a.status === "vulnerable"; }), exp = (d.security && d.security.exposed) || [];
      var who = f ? '<div class="whorow">' + (f.owner ? avatar(f.owner, "contributor") + '<span>brought by <a class="run" href="/user/' + encodeURIComponent(f.owner) + '">' + esc(f.owner) + '</a></span>' : '') + (f.approved_by ? avatar(f.approved_by, "maintainer") + '<span>approved by <a class="run" href="/user/' + encodeURIComponent(f.approved_by) + '">' + esc(f.approved_by) + '</a></span>' : '<span class="dim">waiting for a maintainer</span>') + '</div>' : '<div class="whorow dim">packaged upstream' + (mt.packager ? ' by ' + esc(mt.packager.replace(/<.*>/, "").trim()) : '') + ' · mirrored, signature kept</div>';
      var rows = ["edge", "rc", "stable"].map(function (r) { var x = (d.rings || []).filter(function (y) { return y.ring === r; })[0]; return '<dt>' + r + '</dt><dd>' + (x ? esc(x.version) : '<span class="dim">not served</span>') + '</dd>'; }).join("");
      el.innerHTML = '<h3>' + esc(name) + ' <span class="dim" style="font-size:12px;font-weight:400">' + esc(p.source) + '</span></h3>' + who + '<p class="sub" style="margin:0 0 12px">' + esc(pi.desc || m.description || "") + '</p>' +
        '<dl class="kv">' + rows + '<dt>size</dt><dd>' + bytes(p.size_download) + ' · ' + bytes(p.size_installed) + ' installed</dd><dt>depends on</dt><dd>' + num((d.depends || []).length) + ' declared · loads ' + num((d.links || []).length) + ' libraries</dd><dt>required by</dt><dd>' + num((d.required_by || []).length) + ' in ' + esc(d.shown_ring) + (d.required_by && d.required_by.length > 100 ? ' <span class="pill warn">exposes many</span>' : '') + '</dd><dt>security</dt><dd>' + (own.length ? '<span class="pill warn">' + num(own.length) + ' open</span> ' + esc(own[0].cves.join(", ")) : '<span class="pill ok">no open advisory</span>') + (exp.length ? ' · exposed through ' + num(exp.length) : '') + '</dd></dl>' +
        '<pre style="margin-top:12px"><span class="c"># from the ring you configured</span>\nsudo pacman -S ' + esc(name) + '</pre><div class="cta-row" style="margin-top:14px"><a class="btn" href="/package/' + encodeURIComponent(name) + '?ring=' + esc(d.shown_ring) + '&arch=' + arch + '">Open ' + esc(name) + ' →</a><span class="hint">who made it · provenance · graph · files</span></div>';
    }).catch(function (e) { el.innerHTML = '<h3>' + esc(name) + '</h3><p class="sub" style="margin:0">could not load: ' + esc(String(e)) + '</p>'; });
  }
  // The tiles and the two charts: what the rings serve, per source, and what the last stable changed.
  skeletonTiles("#pk-tiles", 5);
  liveStats(function (d) {
    var stable = d.rings.filter(function (r) { return r.ring === "stable"; })[0] || { sources: [] }, srcs = stable.sources || [];
    var by = function (pred) { return srcs.filter(pred).reduce(function (n, x) { return n + x.packages; }, 0); };
    var arches = function (pred) { return num(by(function (x) { return pred(x) && x.arch === "x86_64"; })) + " x86_64 · " + num(by(function (x) { return pred(x) && x.arch === "aarch64"; })); };
    setTiles("#pk-tiles", [
      ["Packages in stable", num(stable.package_count || 0), arches(function () { return true; }) + " aarch64"],
      ["From Arch", num(by(function (x) { return x.source === "core" || x.source === "extra" || x.source === "multilib"; })), "core · extra · multilib"],
      ["From Arch Linux ARM", num(by(function (x) { return x.source === "alarm"; })), "alarm — aarch64 only"],
      ["From Omarchy", num(by(function (x) { return x.source === "packages"; })), "OPR"],
      ["Built here", num(by(function (x) { return x.source === "factory"; })), "the factory, from contributors' recipes", "ok"]
    ]);
    var ring0 = ["stable", "rc", "edge"].indexOf(ring) >= 0 ? ring : "stable", r0 = d.rings.filter(function (r) { return r.ring === ring0; })[0] || { sources: [] };
    $("#pk-src-ring").textContent = ring0 + " · " + arch;
    var rows = (r0.sources || []).filter(function (x) { return x.arch === arch; }).sort(function (a, b) { return b.packages - a.packages; }), tot = rows.reduce(function (n, x) { return n + x.packages; }, 0) || 1;
    $("#pk-sources").innerHTML = hrows(rows.map(function (x) { return [x.source, "", Math.round(1000 * x.packages / tot) / 10, x.source === "factory" ? "var(--lilac)" : x.source === "packages" ? "var(--blue)" : "var(--green)", num(x.packages)]; }), 120);
    var head = (d.releases || []).filter(function (r) { return r.ring === "stable" && r.is_head; })[0];
    if (head && head.parent_id) {
      $("#pk-diff-when").textContent = "#" + head.seq + " · " + ago(head.created_at);
      fetch("/api/v1/releases/stable/diff?from=" + head.parent_id + "&to=" + head.id).then(function (r) { return r.json(); }).then(function (df) {
        var name = function (x) { return '<a class="run" href="/package/' + encodeURIComponent(x.name) + '?ring=stable">' + esc(x.name) + '</a>'; };
        var up = df.upgraded || [], ad = df.added || [], rm = df.removed || [];
        $("#pk-diff").innerHTML = '<div class="flow" style="margin-top:6px"><div class="st"><span class="k">upgraded</span><b>' + num(up.length) + '</b><span class="s">' + up.slice(0, 3).map(name).join(", ") + (up.length > 3 ? "…" : "") + '</span></div><div class="ar">·</div><div class="st"><span class="k">added</span><b>' + num(ad.length) + '</b><span class="s">' + ad.slice(0, 3).map(name).join(", ") + (ad.length > 3 ? "…" : "") + '</span></div><div class="ar">·</div><div class="st"><span class="k">removed</span><b>' + num(rm.length) + '</b><span class="s">' + (rm.length ? rm.slice(0, 3).map(name).join(", ") : "nothing left the ring") + '</span></div></div><p class="sub" style="margin:12px 0 0;font-size:12.5px"><a href="/diff?ring=stable&from=' + head.parent_id + '&to=' + head.id + '">The whole diff →</a> · <a href="/journal">Ring history →</a></p>';
      }).catch(function () { $("#pk-diff").innerHTML = '<div class="empty">no diff available</div>'; });
    } else $("#pk-diff").innerHTML = '<div class="empty">' + (head ? "the first stable release has no parent" : "no stable release yet") + '</div>';
    endSkeleton();
  }, 120000);
`;

const PACKAGE_BODY = String.raw`
  <p class="crumbs"><a href="/packages">Packages</a> / <span id="crumb"></span></p>
  <div class="h2row" style="align-items:center"><h1 id="title" style="max-width:none">…</h1><div class="choice" id="pg-ring" style="margin:0"></div><div class="choice" id="pg-arch" style="margin:0"></div></div>
  <p class="lede" id="desc"></p>
  <div class="tiles" id="pg-tiles"></div>
  <div class="meta" id="meta"></div>
  <p class="sub" id="maint" style="margin-top:6px" hidden></p>

  <section id="factory-section" hidden>
    <div class="h2row"><h2>From the factory <span id="factory-badge"></span></h2><span class="hint">not synced from a source: built here, twice, and decided</span></div>
    <p class="sub" id="factory-lede"></p>
    <div class="fchain" id="factory-chain"></div>
  </section>

  <section id="who-section">
    <div class="h2row"><h2>Who made it</h2><span class="hint">the work on the record</span></div>
    <div class="who" id="who"><div class="muted">…</div></div>
  </section>

  <section id="seal-section">
    <h2>Provenance <span id="seal-pill"></span></h2>
    <p class="sub">Where this exact object came from, and the proof. A synced package names its upstream project and the keyring its signature was checked against when it entered the pool; a package the factory built carries the whole chain — the contributor's build that was the evidence, the second agent's audit, the maintainer's approval, the project's rebuild — and an <b>attestation</b> next to the object in the pool, signed by the pool's key, that anyone can verify without this page.</p>
    <ul class="plain" id="seal"></ul>
  </section>

  <section id="sec-section">
    <h2>Security <span id="sec-badge"></span></h2>
    <p class="sub">Advisories on this version, and open advisories on what it depends on or loads (direct exposure). Confidence: <b>exact</b> = the tracker knows this distribution's version; <b>name-version</b> = Debian fixed it in a newer version than ours; <b>name-only</b> = still open upstream, possibly affected.</p>
    <div class="charts">
      <div class="chart"><h3>On this package</h3><div id="sec-own"></div></div>
      <div class="chart"><h3>Exposed through</h3><div id="sec-exposed"></div></div>
    </div>
  </section>

  <section>
    <h2>In the rings</h2>
    <p class="sub">The version each ring serves for <span id="arch-label"></span>. Same sha256 means the very same file.</p>
    <div class="table-wrap"><table id="rings"><thead><tr><th>Ring</th><th>Version</th><th>Release</th><th>Source</th><th>sha256</th><th class="num">Size</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Graph</h2>
    <p class="sub">Left: what depends on this package in <span class="ring-name"></span> — <span style="color:var(--blue)">declared</span> in its metadata, or a binary that <span style="color:var(--green)">actually loads</span> one of its libraries. Right: what this package declares and which libraries its own binaries load, each resolved to the package that provides it. Click a node to open it.</p>
    <div class="chart" id="graph-card"><div id="graph"></div><div class="legend"><span><i style="background:var(--blue)"></i>declared dependency</span><span><i style="background:var(--green)"></i>loads a library (soname)</span><span><i style="background:var(--dim)"></i>not provided in this ring (pacman resolves it elsewhere)</span></div></div>
  </section>

  <div class="charts">
    <div class="chart"><h3>Depends on</h3><div id="deps"></div></div>
    <div class="chart"><h3>Libraries it loads</h3><div id="links"></div></div>
    <div class="chart"><h3>Required by <span id="rb-count"></span></h3><div id="rb"></div></div>
    <div class="chart"><h3>Provides</h3><div id="provides"></div></div>
  </div>

  <section id="components-section" hidden>
    <h2>Embedded libraries <span id="components-count" class="muted"></span></h2>
    <p class="sub">What the package's statically linked binaries were built with — Go modules from the binary's build information, crates.io crates when the packager used <code>cargo-auditable</code>. No soname reveals these; the security layer matches advisories against them.</p>
    <div class="table-wrap"><table id="components"><thead><tr><th>Ecosystem</th><th>Name</th><th>Version</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <h2>Files <button class="choice-btn" id="load-files">show</button></h2>
    <pre id="files" class="muted">not loaded</pre>
  </section>
`;

const PACKAGE_SCRIPT = String.raw`
  var name = decodeURIComponent(location.pathname.split("/").pop());
  var q = new URLSearchParams(location.search);
  var ring = ["stable", "rc", "edge"].indexOf(q.get("ring")) >= 0 ? q.get("ring") : "stable";
  var arch = ["x86_64", "aarch64"].indexOf(q.get("arch")) >= 0 ? q.get("arch") : "x86_64";
  var data = null;
  $("#crumb").textContent = name; $("#title").textContent = name; $("#arch-label").textContent = arch;
  function link(n) { return '<a href="/package/' + encodeURIComponent(n) + '?ring=' + ring + '&arch=' + arch + '">' + esc(n) + '</a>'; }

  function graph(d) {
    var vulnProviders = {};
    ((d.security && d.security.exposed) || []).forEach(function (e) { vulnProviders[e.via] = vulnProviders[e.via] || []; vulnProviders[e.via].push(e.advisory); });
    var left = d.required_by.slice(0, 22), moreLeft = d.required_by.length - left.length;
    var right = {};
    d.depends.forEach(function (x) { var k = x.provider ? x.provider.name : x.name; right[k] = right[k] || { name: k, provided: !!x.provider, declared: false, sonames: [] }; right[k].declared = true; });
    d.links.forEach(function (x) { var k = x.provider ? x.provider.name : x.soname; right[k] = right[k] || { name: k, provided: !!x.provider, declared: false, sonames: [] }; right[k].sonames.push(x.soname); });
    var rightList = Object.keys(right).map(function (k) { return right[k]; }).sort(function (a, b) { return a.name < b.name ? -1 : 1; }).slice(0, 22), moreRight = Object.keys(right).length - rightList.length;
    var rows = Math.max(left.length + (moreLeft ? 1 : 0), rightList.length + (moreRight ? 1 : 0), 1), rh = 26, W = 1100, H = Math.max(rows * rh + 20, 120), colW = 300, cx = W / 2;
    var body = '<defs><marker id="m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#8b93b8"/></marker></defs>';
    function node(x, y, w, n, color, title, sub) {
      var href = '/package/' + encodeURIComponent(n) + '?ring=' + ring + '&arch=' + arch;
      var vuln = vulnProviders[n];
      var badge = vuln ? '<circle cx="' + (x + w - 4) + '" cy="' + (y - 8) + '" r="6" fill="#f7768e"><title>' + esc(vuln.length + " open advisor" + (vuln.length > 1 ? "ies" : "y") + ": " + vuln.map(function (a) { return a.cves.join(","); }).join("; ")) + '</title></circle><text x="' + (x + w - 4) + '" y="' + (y - 5) + '" fill="#0c0e10" font-size="9" text-anchor="middle" font-weight="700">!</text>' : '';
      return '<a href="' + href + '"><rect x="' + x + '" y="' + (y - 10) + '" width="' + w + '" height="21" rx="3" fill="#13141c" stroke="' + (vuln ? "#f7768e" : color) + '"/><text x="' + (x + 8) + '" y="' + (y + 4) + '" fill="#c0caf5" font-size="12">' + esc(n.length > 34 ? n.slice(0, 33) + "…" : n) + '</text>' + (sub ? '<text x="' + (x + w - 8) + '" y="' + (y + 4) + '" fill="#8b93b8" font-size="10" text-anchor="end">' + esc(sub) + '</text>' : '') + '<title>' + esc(title) + '</title></a>' + badge;
    }
    // centre: red when this version itself has an open advisory
    var cy = H / 2, ownOpen = ((d.security && d.security.advisories) || []).filter(function (a) { return a.status === "vulnerable"; }).length;
    body += '<rect x="' + (cx - 90) + '" y="' + (cy - 14) + '" width="180" height="29" rx="3" fill="' + (ownOpen ? "#f7768e" : "#9ece6a") + '"/><text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" fill="#0c0e10" font-size="13" font-weight="600">' + esc(d.name) + '</text>';
    left.forEach(function (n, i) {
      var y = 20 + i * rh, color = n.declared ? "#7aa2f7" : "#9ece6a";
      body += '<path d="M' + (20 + colW) + ' ' + y + ' C ' + (cx - 160) + ' ' + y + ', ' + (cx - 160) + ' ' + cy + ', ' + (cx - 92) + ' ' + cy + '" fill="none" stroke="' + color + '" stroke-opacity="0.45" marker-end="url(#m)"/>';
      body += node(20, y, colW, n.name, color, n.name + " " + n.version + (n.declared ? " declares " + d.name : "") + (n.sonames.length ? " · loads " + n.sonames.join(", ") : ""), n.sonames.length ? n.sonames[0] : "depends");
    });
    if (moreLeft > 0) body += '<text x="20" y="' + (20 + left.length * rh + 4) + '" fill="#8b93b8" font-size="11">+ ' + moreLeft + ' more (listed below)</text>';
    rightList.forEach(function (n, i) {
      var y = 20 + i * rh, color = !n.provided ? "#414868" : n.sonames.length ? "#9ece6a" : "#7aa2f7", x = W - 20 - colW;
      body += '<path d="M' + (cx + 92) + ' ' + cy + ' C ' + (cx + 160) + ' ' + cy + ', ' + (cx + 160) + ' ' + y + ', ' + x + ' ' + y + '" fill="none" stroke="' + color + '" stroke-opacity="0.45" marker-end="url(#m)"/>';
      body += node(x, y, colW, n.name, color, (n.provided ? n.name : n.name + " — not in this ring") + (n.declared ? " · declared" : "") + (n.sonames.length ? " · loads " + n.sonames.join(", ") : ""), n.sonames.length ? n.sonames[0] : "declared");
    });
    if (moreRight > 0) body += '<text x="' + (W - 20 - colW) + '" y="' + (20 + rightList.length * rh + 4) + '" fill="#8b93b8" font-size="11">+ ' + moreRight + ' more (listed below)</text>';
    $("#graph").innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" font-family="JetBrains Mono, ui-monospace, monospace" style="min-height:' + Math.min(H, 700) + 'px">' + body + '</svg>';
  }

  function render(d) {
    data = d; ring = d.shown_ring;
    document.querySelectorAll(".ring-name").forEach(function (e) { e.textContent = ring; });
    var m = d.manifest || {}, p = d.package;
    $("#desc").className = "lede"; $("#desc").textContent = m.description || "";
    var own0 = ((d.security && d.security.advisories) || []).filter(function (a) { return a.status === "vulnerable"; });
    setTiles("#pg-tiles", [
      ["In " + esc(d.shown_ring), esc(p.version), "release #" + esc(String((d.rings.filter(function (r) { return r.ring === d.shown_ring; })[0] || {}).release_seq || "—")) + " · " + esc(arch)],
      ["Size", bytes(p.size_download), bytes(p.size_installed) + " installed"],
      ["Depends on", num((d.depends || []).length), "declared · loads " + num((d.links || []).length) + " libraries"],
      ["Required by", num((d.required_by || []).length), (d.required_by || []).length > 100 ? "an advisory here exposes many" : "in " + esc(d.shown_ring)],
      ["Security", own0.length ? num(own0.length) + " open" : "clean", own0.length ? esc(own0.map(function (a) { return a.severity; }).join(", ")) : "no open advisory on this version", own0.length ? "warn" : "ok"]
    ]);
    $("#pg-ring").innerHTML = ["stable", "rc", "edge"].concat(d.rings.some(function (r) { return r.ring === "lab"; }) || d.shown_ring === "lab" ? ["lab"] : []).map(function (r) { return '<a class="' + (r === d.shown_ring ? "on" : "") + '" href="/package/' + encodeURIComponent(d.name) + '?ring=' + r + '&arch=' + arch + '" style="display:inline-block;background:' + (r === d.shown_ring ? "var(--green)" : "var(--panel-2)") + ';color:' + (r === d.shown_ring ? "var(--green-ink)" : "var(--muted)") + ';border:1px solid ' + (r === d.shown_ring ? "var(--green)" : "var(--line)") + ';padding:5px 12px;font-size:13px;text-decoration:none">' + r + '</a>'; }).join("");
    $("#pg-arch").innerHTML = ["x86_64", "aarch64"].map(function (a) { return '<a href="/package/' + encodeURIComponent(d.name) + '?ring=' + d.shown_ring + '&arch=' + a + '" style="display:inline-block;background:' + (a === arch ? "var(--green)" : "var(--panel-2)") + ';color:' + (a === arch ? "var(--green-ink)" : "var(--muted)") + ';border:1px solid ' + (a === arch ? "var(--green)" : "var(--line)") + ';padding:5px 12px;font-size:13px;text-decoration:none">' + a + '</a>'; }).join("");
    $("#meta").innerHTML = [
      m.url ? '<a href="' + esc(m.url) + '">' + esc(m.url.replace(/^https?:\/\//, "")) + '</a>' : "",
      (m.licenses || []).length ? "license " + esc((m.licenses || []).join(", ")) : "",
      m.pkginfo && m.pkginfo.base && m.pkginfo.base !== d.name ? "base " + link(m.pkginfo.base) : "",
      "source <span class=\"src\">" + esc(p.source) + "</span>",
      p.has_signature ? "upstream signature ✓" : "no upstream signature",
      '<a href="' + esc(d.pool_url) + '">download</a> · <a href="' + esc(d.pool_url) + '.sig">.sig</a>',
      bytes(p.size_download) + " download · " + bytes(p.size_installed) + " installed",
      m.pkginfo && m.pkginfo.builddate ? "built " + new Date(m.pkginfo.builddate * 1000).toISOString().slice(0, 10) : "",
      m.pkginfo && m.pkginfo.packager && p.source !== "factory" ? "packaged by " + esc(m.pkginfo.packager.replace(/<.*>/, "").trim()) : ""
    ].filter(Boolean).map(function (x) { return "<span>" + x + "</span>"; }).join('<span class="sep">·</span>');
    // Who stands behind it: upstream's packager, or — for what the factory
    // built — the contributor who brought it, its category, the maintainers and
    // the maintainer who approved it, each with a public page.
    var mt = d.maintenance || {}, f = mt.factory;
    if (f) {
      var parts = [];
      if (f.owner) parts.push("brought by " + personLink(f.owner));
      if (f.category) parts.push('<span class="pill none">' + esc(f.category) + '</span>');
      if (f.maintainers && f.maintainers.length) parts.push("maintained by " + f.maintainers.map(personLink).join(", "));
      if (f.approved_by) parts.push("approved by " + personLink(f.approved_by) + (f.approved_version ? " at " + esc(f.approved_version) : "") + " " + ago(f.approved_at));
      $("#maint").innerHTML = parts.join(" · ") + ' · <span class="muted">built and signed by the project; the contributor\'s build was the evidence</span>';
    } else if (mt.packager) {
      $("#maint").innerHTML = 'Packaged upstream by ' + esc(mt.packager.replace(/<.*>/, "").trim()) + ' (' + esc(p.source) + '); the pool serves the file as built and signed there.';
    }
    renderWho(d, p);
    renderSeal(d.seal, p);
    // An OPR package: where its recipe comes from — Omarchy's own, or synced from the AUR.
    var pv = d.provenance;
    if (pv) {
      var origin = pv.source === "aur" ? '<span class="pill warn">AUR-synced</span> recipe' + (pv.upstream_commit ? ' tracking <a class="mono" href="' + esc(pv.aur) + '">' + esc(pv.upstream_commit.slice(0, 7)) + '</a>' : '') : pv.source === "local" ? "<span class=\"pill ok\">Omarchy's own</span> recipe" : '<span class="pill none">recipe of unknown origin</span>';
      $("#maint").innerHTML += (($("#maint").innerHTML) ? ' · ' : '') + origin + ' in <a href="' + esc(pv.pkgbuild) + '">omarchy-pkgs</a>' + (pv.pkgbuild_commit ? ', last changed <span class="mono">' + esc(pv.pkgbuild_commit.slice(0, 7)) + '</span> ' + ago(pv.pkgbuild_committed_at) : '') + (pv.release_ring === "fast" ? ' · <span class="muted">built natively for every channel</span>' : '') + (pv.pinned ? ' · <span class="muted">version pinned per release</span>' : '');
    }
    $("#rings tbody").innerHTML = ["stable", "rc", "edge"].map(function (r) {
      var row = (d.rings || []).filter(function (x) { return x.ring === r; })[0];
      if (!row) return '<tr><td>' + r + '</td><td colspan="5" class="muted">not in ' + r + ' for ' + arch + '</td></tr>';
      return '<tr' + (r === ring ? ' style="background:var(--panel-2)"' : '') + '><td>' + r + (r === ring ? ' <span class="pill ok">shown</span>' : ' <a class="run" href="?ring=' + r + '&arch=' + arch + '">show</a>') + '</td><td class="mono">' + esc(row.version) + '</td><td>#' + row.release_seq + '</td><td><span class="src">' + esc(row.source) + '</span></td><td class="mono" title="' + esc(row.sha256) + '">' + esc(row.sha256.slice(0, 16)) + '…</td><td class="num">' + bytes(row.size_download) + '</td></tr>';
    }).join("");
    graph(d);
    renderSecurity(d);
    renderComponents(d);
    $("#deps").innerHTML = d.depends.length ? '<ul class="plain">' + d.depends.map(function (x) { return '<li>' + (x.provider ? link(x.provider.name) + ' <span class="muted">' + esc(x.provider.version) + '</span>' + (x.provider.name !== x.name ? ' <span class="muted">provides ' + esc(x.name) + '</span>' : '') : esc(x.name) + ' <span class="muted">not in this ring</span>') + '</li>'; }).join("") + '</ul>' : '<div class="empty">no declared dependencies</div>';
    $("#links").innerHTML = d.links.length ? '<ul class="plain">' + d.links.map(function (x) { return '<li><span class="mono">' + esc(x.soname) + '</span> <span class="muted">← ' + (x.provider ? link(x.provider.name) : "not in this ring") + '</span></li>'; }).join("") + '</ul>' : '<div class="empty">no ELF binaries, or nothing dynamically linked</div>';
    $("#rb-count").textContent = d.required_by.length + (d.required_by.length >= 400 ? "+" : "");
    $("#rb").innerHTML = d.required_by.length ? '<ul class="plain cols">' + d.required_by.map(function (x) { return '<li>' + link(x.name) + ' <span class="muted" title="' + esc(x.sonames.join(", ")) + '">' + (x.declared ? "declared" : "") + (x.declared && x.sonames.length ? " + " : "") + (x.sonames.length ? "loads " + x.sonames.length + " lib" + (x.sonames.length > 1 ? "s" : "") : "") + '</span></li>'; }).join("") + '</ul>' : '<div class="empty">nothing in ' + ring + ' depends on it</div>';
    var prov = (m.provides || []).filter(function (x) { return x.split(/[<>=]/)[0] !== d.name; });
    $("#provides").innerHTML = prov.length ? '<ul class="plain cols">' + prov.map(function (x) { return '<li class="mono">' + esc(x) + '</li>'; }).join("") + '</ul>' : '<div class="empty">only itself</div>';
  }

  // Who made it — the people, always: the contributor who brought the recipe, the
  // maintainer who rebuilt and approved it, the agents that drafted and audited;
  // for an upstream package, who packaged it there and that the pool mirrors it as is.
  function renderWho(d, p) {
    var mt = d.maintenance || {}, f = mt.factory, c = (d.seal && d.seal.chain) || {}, cards = [];
    var card = function (av, k, b, s, href) { return (href ? '<a class="whoc" href="' + href + '">' : '<div class="whoc">') + av + '<div><div class="k">' + k + '</div><b>' + b + '</b><span>' + s + '</span></div>' + (href ? '</a>' : '</div>'); };
    if (f) {
      var sb = c.source_build || {};
      cards.push(f.owner ? card(avatar(f.owner, "contributor", "lg"), "contributor", esc(f.owner), "brought the recipe" + (sb.worker ? " · built it on " + esc(sb.worker) : ""), "/user/" + encodeURIComponent(f.owner)) : card('<span class="avatar lg">?</span>', "contributor", "unknown", "registered before the record kept owners"));
      cards.push(f.approved_by ? card(avatar(f.approved_by, "maintainer", "lg"), "maintainer", esc(f.approved_by), "rebuilt it from the recipe on a trusted worker, approved it " + ago(f.approved_at), "/user/" + encodeURIComponent(f.approved_by)) : '<div class="whoc wait"><span class="avatar lg" style="border-color:var(--amber);color:var(--amber)">?</span><div><div class="k">maintainer</div><b>waiting for review</b><span>a maintainer decides' + (f.maintainers && f.maintainers.length ? ": " + f.maintainers.map(esc).join(", ") : "") + '</span></div></div>');
      var au = c.audit;
      cards.push(card('<span class="avatar lg" style="border-color:var(--lilac);color:var(--lilac)">ai</span>', "agents", (sb.agent ? "drafted" : "no draft") + " · " + (au && au.verdict ? "audit " + esc(au.verdict) : au && au.status ? "audit " + esc(au.status) : "no audit"), (sb.agent ? "PKGBUILD drafted on the contributor\'s worker with " + esc(sb.agent) + "; " : "") + (au && au.agent ? "audit written on the review worker with " + esc(au.agent) + " — " : "") + "evidence, never a decision"));
    } else {
      var origin = p.source === "alarm" ? "Arch Linux ARM" : p.source === "packages" ? "Omarchy" : p.source === "chaotic" ? "Chaotic-AUR" : "Arch Linux";
      var who = mt.packager ? esc(mt.packager.replace(/<.*>/, "").trim()) : origin;
      cards.push(card('<span class="avatar lg">' + esc(origin.slice(0, 2)) + '</span>', "packaged by", who, "at " + origin + " — the packager field of .PKGINFO; upstream\'s own signature kept"));
      cards.push(card('<span class="avatar lg" style="border-color:var(--green)">▣</span>', "mirrored by", "the pool", "verified against " + origin + "\'s key, stored once, promoted on evidence — never rebuilt"));
      cards.push(card('<span class="avatar lg" style="border-color:var(--lilac);color:var(--lilac)">ai</span>', "agents", "none", "upstream packages are mirrored as they are; agents only touch the factory"));
    }
    $("#who").innerHTML = cards.join("");
  }
  // The seal: one pill, then the facts — each a link to the evidence it names.
  function renderSeal(seal, p) {
    if (!seal) { $("#seal-pill").innerHTML = ""; $("#seal").innerHTML = '<li class="muted">no seal for this object</li>'; return; }
    var items = [];
    if (seal.origin === "factory") {
      $("#seal-pill").innerHTML = '<span class="pill rec">built by the Omarchy Pool</span>';
      var c = seal.chain || {};
      if (c.build) items.push('Rebuilt by the project on <span class="mono">' + esc((c.builder && c.builder.worker) || "a trusted worker") + '</span>' + (c.build.finished_at ? ' ' + ago(c.build.finished_at) : '') + (c.build.duration_ms ? ' in ' + Math.round(c.build.duration_ms / 60000) + ' min' : '') + ' — task #' + c.build.task + (c.build.attempts > 1 ? ' (attempt ' + c.build.attempts + ')' : ''));
      if (c.recipe) items.push('Recipe: ' + (c.recipe.commit ? '<a class="mono" href="' + esc(c.recipe.pkgbuild) + '">' + esc(c.recipe.path) + '</a> at <span class="mono">' + esc(c.recipe.commit.slice(0, 7)) + '</span>' : '<a href="' + esc(c.recipe.pkgbuild || '#') + '">the PKGBUILD</a> the contributor\'s build staged' + (c.recipe.from ? ' (<span class="mono">' + esc(c.recipe.from) + '</span>)' : '')));
      if (c.source_build) items.push('Evidence: build #' + c.source_build.task + (c.source_build.owner ? ' by ' + personLink(c.source_build.owner) : '') + ' on <span class="mono">' + esc(c.source_build.worker || '?') + '</span>' + (c.source_build.agent ? ' with <span class="mono">' + esc(c.source_build.agent) + '</span>' : '') + ' — <a href="' + esc(c.source_build.evidence.log) + '">log</a>, <a href="' + esc(c.source_build.evidence.pkginfo) + '">.PKGINFO</a>');
      if (c.audit) items.push('Audit: ' + (c.audit.verdict ? '<span class="pill ' + (c.audit.verdict === "pass" ? "ok" : c.audit.verdict === "fail" ? "error" : "warn") + '">' + esc(c.audit.verdict) + '</span> ' + esc(c.audit.summary || '') + (c.audit.agent ? ' <span class="muted">(' + esc(c.audit.agent) + ')</span>' : '') + (c.audit.report ? ' — <a href="' + esc(c.audit.report) + '">report</a>' : '') : '<span class="muted">' + esc(c.audit.status || c.audit.error || 'none') + '</span>'));
      if (c.approval) items.push('Approved by ' + personLink(c.approval.by) + ' ' + ago(c.approval.at) + (c.approval.note ? ' — “' + esc(c.approval.note) + '”' : ''));
      if (seal.signature) items.push('Signed by the pool, key <span class="mono">' + esc(seal.signature.fingerprint.slice(-16)) + '</span> — <a href="' + esc(seal.signature.object) + '">signature</a>');
      if (seal.attestation) items.push('<b>Attestation</b>: <a href="' + esc(seal.attestation.statement) + '">provenance.json</a>' + (seal.attestation.signature ? ' + <a href="' + esc(seal.attestation.signature) + '">.sig</a> — an in-toto statement about this exact object (sha256 ' + esc(seal.sha256.slice(0, 12)) + '…), the pool\'s detached signature beside it' : ''));
      else items.push('<span class="muted">No attestation yet: written when the project\'s build completes (builds before the seal existed have none).</span>');
    } else {
      $("#seal-pill").innerHTML = '<span class="pill ok">' + esc(seal.seal) + '</span>';
      var u = seal.upstream || {};
      items.push('Imported from <b>' + esc(u.project || seal.origin) + '</b> (repository <span class="mono">' + esc(seal.source) + '</span>) ' + ago(seal.indexed_at) + ', served as built and signed there — the pool never rebuilds upstream packages.');
      items.push(u.verified ? 'Upstream signature verified against the <span class="mono">' + esc(u.keyring) + '</span> keyring when it entered the pool, and served beside the object — <a href="' + esc(u.signature) + '">signature</a>' : '<span class="muted">No upstream signature stored for this object.</span>');
    }
    items.push('Object: <a class="mono" href="' + esc(seal.object) + '">' + esc(seal.filename) + '</a> · sha256 <span class="mono">' + esc(seal.sha256) + '</span> · <a href="/api/v1/packages/' + esc(seal.sha256) + '/provenance">this seal as JSON</a>');
    $("#seal").innerHTML = items.map(function (x) { return '<li>' + x + '</li>'; }).join('');
  }

  function advLine(a) {
    return '<li>' + sevPill(a.severity) + ' <a class="run" href="' + esc(a.url) + '">' + esc(a.cves.join(", ") || a.id) + '</a> <span class="muted">' + esc(a.match) + (a.fixed ? ' · fixed in ' + esc(a.fixed) : '') + (a.kev ? ' · <span style="color:var(--red)">exploited in the wild</span>' : '') + (a.epss != null && a.epss >= 0.1 ? ' · EPSS ' + (a.epss * 100).toFixed(0) + '%' : '') + '</span>' + (a.summary ? '<div class="muted" style="font-size:12.5px">' + esc(a.summary.length > 160 ? a.summary.slice(0, 159) + "…" : a.summary) + '</div>' : '') + '</li>';
  }
  function renderSecurity(d) {
    var s = d.security || { advisories: [], exposed: [] };
    var open = s.advisories.filter(function (a) { return a.status === "vulnerable"; }), fixed = s.advisories.filter(function (a) { return a.status !== "vulnerable"; });
    $("#sec-badge").innerHTML = open.length ? '<span class="pill error">' + open.length + ' open</span>' : (s.exposed.length ? '<span class="pill warn">exposed via ' + s.exposed.length + '</span>' : '<span class="pill ok">no open advisory</span>');
    $("#sec-own").innerHTML = (open.length ? '<ul class="plain">' + open.map(advLine).join("") + '</ul>' : '<div class="empty">no open advisory on ' + esc(d.package.version) + '</div>') +
      (fixed.length ? '<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:12.5px">' + fixed.length + ' advisor' + (fixed.length > 1 ? "ies" : "y") + ' fixed in this version</summary><ul class="plain">' + fixed.map(advLine).join("") + '</ul></details>' : '');
    $("#sec-exposed").innerHTML = s.exposed.length ? '<ul class="plain">' + s.exposed.map(function (e) {
      return '<li>' + sevPill(e.advisory.severity) + ' ' + link(e.via) + ' <span class="muted">' + (e.declared ? "declared" : "") + (e.declared && e.sonames.length ? " + " : "") + (e.sonames.length ? "loads " + esc(e.sonames.join(", ")) : "") + ' · <a class="run" href="' + esc(e.advisory.url) + '">' + esc(e.advisory.cves.join(", ")) + '</a> · ' + esc(e.advisory.match) + '</span></li>';
    }).join("") + '</ul>' : '<div class="empty">nothing it depends on or loads has an open advisory</div>';
  }

  function renderComponents(d) {
    var c = (d.manifest && d.manifest.components) || []; if (!c.length) return;
    $("#components-section").hidden = false;
    $("#components-count").textContent = "(" + c.length + ")";
    pager("#components", c, function (x) {
      var href = x.ecosystem === "Go" ? "https://pkg.go.dev/" + x.name + "@" + x.version : x.ecosystem === "crates.io" ? "https://crates.io/crates/" + x.name + "/" + x.version : "";
      return '<tr><td>' + esc(x.ecosystem) + '</td><td>' + (href ? '<a href="' + esc(href) + '">' + esc(x.name) + '</a>' : esc(x.name)) + '</td><td class="mono">' + esc(x.version) + '</td></tr>';
    }, { n: 25 });
  }
  $("#load-files").onclick = function () {
    $("#files").textContent = "loading…";
    busy(fetch("/api/v1/package/" + encodeURIComponent(name) + "/files?ring=" + ring + "&arch=" + arch)).then(function (r) { return r.json(); }).then(function (d) {
      var files = (d.files || []).filter(function (f) { return !/\/$/.test(f); });
      $("#files").className = ""; $("#files").textContent = files.length + " files\n" + files.join("\n");
      $("#load-files").style.display = "none";
    }).catch(function (e) { $("#files").textContent = "failed: " + e; });
  };

  // The index can be busy during a bulk import; a transient 5xx gets retried.
  function loadPackage(attempt) {
    if (attempt === 1) { skeletonRows("#rings", 6, 3); skeletonTiles("#pg-tiles", 5); skeletonText("#desc"); ["#graph", "#sec-own", "#sec-exposed"].forEach(function (id) { var el = $(id); if (el && !el.innerHTML.trim()) el.innerHTML = '<div class="empty loading skel">Resolving dependencies and advisories</div>'; }); }
    busy(fetch("/api/v1/package/" + encodeURIComponent(name) + "?ring=" + ring + "&arch=" + arch)).then(function (r) {
      if (r.status >= 500) throw new Error("index busy (HTTP " + r.status + ")");
      return r.json();
    }).then(function (d) {
      if (d.error) { endSkeleton(); if ($("#factory-section").hidden) $("#desc").textContent = d.error; $("#graph").innerHTML = ""; $("#who-section").hidden = true; $("#pg-tiles").innerHTML = ""; ["#sec-section", "#seal-section"].forEach(function (id) { var el = $(id); if (el) el.hidden = true; }); return; }
      render(d); endSkeleton();
    }).catch(function (e) {
      if (attempt < 4) { $("#desc").textContent = "The index is busy (" + e.message + "); retrying…"; setTimeout(function () { loadPackage(attempt + 1); }, 4000 * attempt); }
      else { endSkeleton(); $("#desc").textContent = "Could not load this package right now: " + e.message + ". Reload to try again."; }
    });
  }
  loadPackage(1);
  // The factory's story of this package, when it has one: a package that came from a source has none and the section stays hidden.
  // A factory package not in any ring yet (a contributor's build is evidence, never in the pool) still gets its story: the page is the package's, wherever it is.
  fetch("/api/v1/factory/packages/" + encodeURIComponent(name) + "/story").then(function (r) { return r.ok ? r.json() : null; }).then(function (st) {
    if (!st || !st.chains) return;
    var sec = $("#factory-section"); sec.hidden = false;
    var pkg = st.package || {}, rings = (st.rings || []).filter(function (r) { return r.arch === arch; }).map(function (r) { return r.ring; });
    var onlyLab = rings.length === 1 && rings[0] === "lab", none = !rings.length;
    $("#factory-badge").innerHTML = (none ? pillHtml("lilac", "not in the pool yet", "a contributor's build is evidence; the project's build enters the lab") : onlyLab ? pillHtml("lab", "in the lab", "the fourth ring: the project's build, tried by a real pacman, waiting for a maintainer — not promised, not promoted") : pillHtml("ok", "in " + rings.join(" · "))) + (st.class ? ' ' + classPill(st.score, "class " + st.class, st.score.points + "/100 — What we test → The score") : '');
    if (none) {
      $("#desc").className = "lede"; $("#desc").innerHTML = esc(pkg.description || "") + (pkg.description ? ' — ' : '') + 'not in any ring for ' + esc(arch) + ' yet: a contributor\'s build is evidence, never in the pool; the project\'s build enters the lab.';
      $("#pg-tiles").innerHTML = ""; $("#who-section").hidden = true;
    }
    $("#factory-lede").innerHTML = (pkg.owner ? 'Requested by ' + personLink(pkg.owner) + (pkg.created_at ? ' ' + ago(pkg.created_at) : '') + (pkg.project ? ' from <a href="' + esc(pkg.project) + '">' + esc(String(pkg.project).replace(/^https?:\/\/(www\.)?/, "")) + '</a>' : '') + (pkg.license ? ' · ' + esc(pkg.license) : '') + (pkg.category ? ' · ' + esc(pkg.category) : '') + '. ' : '')
      + (pkg.blocked_at ? pillHtml("error", "blocked") + ' ' + ago(pkg.blocked_at) + ' by ' + personLink(pkg.blocked_by) + ': ' + esc(pkg.blocked_reason || '') + '. ' : '')
      + 'A package from the factory is built by its contributor as evidence, built again by the project on a trusted worker, tried by a real pacman in the lab and decided by a maintainer — never the contributor, never the person who brought it. Only then does it enter edge and earn rc and stable like every synced package. <a href="/docs/what-we-test#who-does-what">Who does what →</a>';
    var chains = st.chains.slice(0, 6);
    $("#factory-chain").innerHTML = chains.length ? chains.map(function (c) { return chainRow(c); }).join("") : '<p class="sub" style="margin:0">Requested; no build yet.</p>';
  }).catch(function () {});
`;

export function packagesHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/packages",
    title: "Packages · omarchy-pool",
    description: "Search the packages a ring serves; versions per ring, dependencies, what loads them, files.",
    active: "none",
    body: SEARCH_BODY,
    script: SEARCH_SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}

export function packageHtml(name: string, poolUrl: string, version: RunningVersion): string {
  return page({
    path: `/package/${name}`,
    title: `${name} · omarchy-pool`,
    description: `${name}: versions per ring, dependencies, what loads it, files.`,
    active: "none",
    body: PACKAGE_BODY,
    script: PACKAGE_SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What /packages is made of: the search box and the table it fills, the
 * panel a row opens, the stable tiles and the two cards under them. Every
 * read is a public GET and nothing on the page changes with the role — the
 * header's account chip is the shell's. The stable ring is the third of
 * RINGS (index.ts: edge, rc, stable, lab), so its slice of /api/v1/stats is
 * `rings.2`; the fixture's stable head is its second release, so the diff
 * against its parent has an upgrade (xz), an addition (zstd) and a removal
 * (bzip2) — the three kinds of row the panel draws.
 */
export const PACKAGES_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "packages.hero",
    page: "/packages",
    anchor: ['<p class="eyebrow">Packages</p>', "Every package the pool serves, in every ring"],
    visible: EVERYONE,
  },
  {
    id: "packages.search-box",
    page: "/packages",
    anchor: ['id="search"', 'id="q"', 'type="search"', 'id="hint"'],
    script: ['"/api/v1/search?q="', '"&limit=100"', '"#q"', '"#hint"', "d.packages"],
    reads: [{ path: `/api/v1/search?q=${F.pkg}&ring=stable&arch=${F.arch}&limit=100`, fields: ["ring", "arch", "query", "packages"] }],
    visible: EVERYONE,
  },
  {
    id: "packages.ring-arch-pickers",
    page: "/packages",
    anchor: ['id="pick-ring"', 'id="pick-arch"'],
    script: ['RINGS = ["stable", "rc", "edge"]', 'ARCHES = ["x86_64", "aarch64"]', 'pick("#pick-ring"', 'pick("#pick-arch"'],
    visible: EVERYONE,
  },
  {
    id: "packages.results-table",
    page: "/packages",
    anchor: ['id="results"', "<th>By</th>", 'class="pk-results"'],
    script: ['"#results"', 'data-name="', 'class="pkname"', "size_download", '"/api/v1/factory/packages"', "OWNERS[p.name]", '"/api/v1/factory/approvals"', "APPROVERS[a.name]"],
    reads: [
      { path: `/api/v1/search?q=${F.pkg}&ring=stable&arch=${F.arch}&limit=100`, fields: ["packages.0.name", "packages.0.version", "packages.0.source", "packages.0.description", "packages.0.size_download"] },
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.name", "packages.0.owner"] },
      { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.name", "approvals.0.decision", "approvals.0.by"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "packages.detail-panel",
    page: "/packages",
    anchor: ['id="pk-detail"', "Pick a package"],
    script: ['"#pk-detail"', '"/api/v1/package/"', "d.shown_ring", "size_installed", "d.depends", "d.links", "d.required_by", "security.advisories", "security.exposed", "sudo pacman -S ", "Open "],
    reads: [
      {
        path: `/api/v1/package/${F.pkg}?ring=stable&arch=${F.arch}`,
        fields: ["name", "shown_ring", "package.source", "package.size_download", "package.size_installed", "manifest.description", "rings.0.ring", "rings.0.version", "depends", "links", "required_by", "required_by.0.name", "security.advisories.0.status", "security.advisories.0.cves.0", "security.exposed"],
      },
    ],
    visible: EVERYONE,
  },
  {
    id: "packages.detail-who-row",
    page: "/packages",
    anchor: ['id="pk-detail"'],
    script: ['class="whorow', "mt.factory", "f.owner", "f.approved_by", "mt.packager", "brought by", "approved by", "waiting for a maintainer", "packaged upstream"],
    reads: [{ path: `/api/v1/package/${F.pkg}?ring=stable&arch=${F.arch}`, fields: ["maintenance", "maintenance.packager"] }],
    visible: EVERYONE,
  },
  {
    id: "packages.stat-tiles",
    page: "/packages",
    anchor: ['id="pk-tiles"', 'class="tiles five"'],
    script: ['"#pk-tiles"', "package_count", '"Packages in stable"', '"From Arch"', '"From Arch Linux ARM"', '"From Omarchy"', '"Built here"', 'x.source === "factory"'],
    reads: [{ path: "/api/v1/stats", fields: ["rings", "rings.2.ring", "rings.2.package_count", "rings.2.sources", "rings.2.sources.0.source", "rings.2.sources.0.arch", "rings.2.sources.0.packages"] }],
    visible: EVERYONE,
  },
  {
    id: "packages.sources-chart",
    page: "/packages",
    anchor: ['id="pk-src-ring"', 'id="pk-sources"', "Packages per source"],
    script: ['"#pk-src-ring"', '"#pk-sources"', "hrows(", "r0.sources", "x.packages"],
    reads: [{ path: "/api/v1/stats", fields: ["rings.2.sources.0.source", "rings.2.sources.0.arch", "rings.2.sources.0.packages"] }],
    visible: EVERYONE,
  },
  {
    id: "packages.last-stable-diff",
    page: "/packages",
    anchor: ['id="pk-diff-when"', 'id="pk-diff"', "What the last stable changed"],
    script: ['"/api/v1/releases/stable/diff?from="', '"#pk-diff"', '"#pk-diff-when"', "d.releases", "r.is_head", "head.parent_id", "df.upgraded", "df.added", "df.removed", 'href="/diff?ring=stable&from=', 'href="/journal"'],
    reads: [
      { path: "/api/v1/stats", fields: ["releases", "releases.0.ring", "releases.0.is_head", "releases.0.parent_id", "releases.0.id", "releases.0.seq", "releases.0.created_at"] },
      { path: `/api/v1/releases/stable/diff?to=${F.release}`, fields: ["to.id", "from", "upgraded", "added", "added.0.name", "removed"] },
    ],
    visible: EVERYONE,
  },
];

/**
 * What /package/<name> is made of. The page is role-blind and never writes:
 * everything is drawn from three GETs — the package in its ring and
 * architecture, the factory's story of it, and the file list on demand.
 * The fixture's zlib is the page (xz requires it, the advisory is on it);
 * xz is the other end of the same edges — it declares zlib and loads its
 * library, so it is exposed through it; `ours` in edge is what a factory
 * package's page reads (the Who cards' factory branch, the seal's chain),
 * and `mine`'s story — decided, not yet in the pool — is the factory
 * section.
 */
export const PACKAGE_COMPONENTS = (F: Fixture): Component[] => {
  const page = `/package/${F.pkg}`;
  const pkg = `/api/v1/package/${F.pkg}?ring=stable&arch=${F.arch}`;
  const pkg2 = `/api/v1/package/${F.pkg2}?ring=stable&arch=${F.arch}`;
  const built = `/api/v1/package/${F.publishedPkg}?ring=edge&arch=${F.arch}`;
  const story = `/api/v1/factory/packages/${F.factoryPkg}/story`;
  const shipped = `/api/v1/factory/packages/${F.publishedPkg}/story`;
  return [
    {
      id: "package.crumbs",
      page,
      anchor: ['class="crumbs"', 'href="/packages"', 'id="crumb"'],
      script: ['"#crumb"', "location.pathname"],
      visible: EVERYONE,
    },
    {
      id: "package.title",
      page,
      anchor: ['id="title"'],
      script: ['"#title"'],
      visible: EVERYONE,
    },
    {
      id: "package.ring-arch-pickers",
      page,
      anchor: ['id="pg-ring"', 'id="pg-arch"'],
      script: ['"#pg-ring"', '"#pg-arch"', "d.shown_ring", '"lab"'],
      reads: [{ path: pkg, fields: ["name", "shown_ring", "arch", "rings.0.ring"] }],
      visible: EVERYONE,
    },
    {
      id: "package.lede",
      page,
      anchor: ['id="desc"'],
      script: ['"#desc"', "m.description", "pkg.description", "d.error"],
      reads: [
        { path: pkg, fields: ["manifest.description"] },
        { path: story, fields: ["package.description", "rings"] },
        // A name in no ring: the page writes the answer's error where the description goes.
        { path: `/api/v1/package/not-a-package?ring=stable&arch=${F.arch}`, status: 404, fields: ["error"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "package.tiles",
      page,
      anchor: ['id="pg-tiles"'],
      script: ['"#pg-tiles"', "p.size_download", "p.size_installed", "release_seq", "own0.length"],
      reads: [{ path: pkg, fields: ["package.version", "package.size_download", "package.size_installed", "rings.0.release_seq", "shown_ring", "arch", "depends", "links", "required_by", "security.advisories.0.severity", "security.advisories.0.status"] }],
      visible: EVERYONE,
    },
    {
      id: "package.meta-row",
      page,
      anchor: ['id="meta"'],
      script: ['"#meta"', "m.url", "m.licenses", "m.pkginfo.base", "m.pkginfo.builddate", "m.pkginfo.packager", "p.has_signature", "d.pool_url"],
      reads: [{ path: pkg, fields: ["name", "manifest.url", "manifest.licenses", "manifest.pkginfo.base", "manifest.pkginfo.builddate", "manifest.pkginfo.packager", "package.source", "package.has_signature", "package.size_download", "package.size_installed", "pool_url"] }],
      visible: EVERYONE,
    },
    {
      // Hidden in the template and never un-hidden: the script writes it on every render, nobody sees it.
      id: "package.maint-line",
      page,
      anchor: ['id="maint" style="margin-top:6px" hidden'],
      script: ['"#maint"', "mt.factory", "mt.packager", "d.provenance"],
      reads: [
        { path: pkg, fields: ["maintenance.packager", "provenance", "package.source"] },
        { path: built, fields: ["maintenance.factory.owner", "maintenance.factory.category", "maintenance.factory.maintainers", "maintenance.factory.approved_by", "maintenance.factory.approved_version", "maintenance.factory.approved_at"] },
      ],
      visible: [],
    },
    {
      id: "package.factory-badge",
      page,
      anchor: ['id="factory-section"', 'id="factory-badge"'],
      script: ['"/api/v1/factory/packages/"', '"/story"', '"#factory-section"', '"#factory-badge"', "st.chains", "st.class", "classPill(st.score", "st.score.points", "not in the pool yet"],
      reads: [
        { path: story, fields: ["name", "chains", "rings", "class", "score.points"] },
        // The badge names the rings once the package is in the pool.
        { path: shipped, fields: ["rings.0.ring", "rings.0.arch"] },
        // A package from a source has no story: the section stays hidden on the 404.
        { path: `/api/v1/factory/packages/${F.pkg}/story`, status: 404, fields: ["error"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "package.factory-lede",
      page,
      anchor: ['id="factory-lede"'],
      script: ['"#factory-lede"', "pkg.owner", "pkg.created_at", "pkg.project", "pkg.blocked_at", 'href="/docs/what-we-test#who-does-what"'],
      reads: [{ path: story, fields: ["package.owner", "package.created_at", "package.project", "package.license", "package.category", "package.blocked_at", "package.blocked_by", "package.blocked_reason"] }],
      visible: EVERYONE,
    },
    {
      // The chains are newest first: mine's first is one of the undecided rows the acts use, so the decided chain —
      // project build, audit, trial, approval — is read on ours, whose one chain went the whole way.
      id: "package.factory-chains",
      page,
      anchor: ['id="factory-chain"'],
      script: ['"#factory-chain"', "chainRow(c)", "st.chains.slice(0, 6)", "Requested; no build yet."],
      reads: [
        {
          path: story,
          fields: [
            "chains.0.contributor.id", "chains.0.contributor.owner", "chains.0.contributor.version", "chains.0.contributor.arch", "chains.0.contributor.status", "chains.0.contributor.finished_at", "chains.0.contributor.attempts",
            "chains.0.contributor.result.vet.verdict", "chains.0.contributor.result.vet.warnings", "chains.0.contributor.result.vet.fails",
            "chains.0.project", "chains.0.audit", "chains.0.trial", "chains.0.approval", "chains.0.withdrawn",
            "chains.0.score.class", "chains.0.score.points", "chains.0.score.projected", "chains.0.score.ready",
          ],
        },
        {
          path: shipped,
          fields: [
            "chains.0.project.id", "chains.0.project.status", "chains.0.project.version", "chains.0.project.arch", "chains.0.project.result.vet.verdict",
            "chains.0.audit.status", "chains.0.audit.result.verdict", "chains.0.audit.result.model",
            "chains.0.trial.status", "chains.0.trial.result.verdict",
            "chains.0.approval.decision", "chains.0.approval.by", "chains.0.approval.created_at", "chains.0.approval.note",
            "chains.0.publish.status",
          ],
        },
      ],
      visible: EVERYONE,
    },
    {
      id: "package.who-cards",
      page,
      anchor: ['id="who-section"', 'id="who"'],
      script: ['"#who"', "renderWho", "mt.factory", "f.approved_by", "c.source_build", "sb.agent", "au.verdict", "p.source"],
      reads: [
        { path: pkg, fields: ["maintenance.packager", "package.source", "seal.chain"] },
        { path: built, fields: ["maintenance.factory.owner", "maintenance.factory.approved_by", "maintenance.factory.approved_at", "maintenance.factory.maintainers", "seal.chain.source_build.worker", "seal.chain.source_build.agent", "seal.chain.audit.verdict", "seal.chain.audit.agent"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "package.seal-pill",
      page,
      anchor: ['id="seal-section"', 'id="seal-pill"'],
      script: ['"#seal-pill"', "seal.origin", "seal.seal", "built by the Omarchy Pool"],
      reads: [
        { path: pkg, fields: ["seal.origin", "seal.seal"] },
        { path: built, fields: ["seal.origin", "seal.seal"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "package.seal-facts",
      page,
      anchor: ['id="seal"'],
      script: ['"#seal"', "renderSeal", "seal.upstream", "seal.attestation", "c.source_build.evidence.log", "c.audit.report", 'href="/api/v1/packages/', "this seal as JSON"],
      reads: [
        { path: pkg, fields: ["seal.origin", "seal.source", "seal.indexed_at", "seal.upstream.project", "seal.upstream.keyring", "seal.upstream.signature", "seal.upstream.verified", "seal.signature", "seal.chain", "seal.attestation", "seal.object", "seal.filename", "seal.sha256"] },
        {
          path: built,
          fields: [
            "seal.chain.build.task", "seal.chain.build.finished_at", "seal.chain.build.duration_ms", "seal.chain.build.attempts", "seal.chain.builder.worker",
            "seal.chain.recipe.pkgbuild",
            "seal.chain.source_build.task", "seal.chain.source_build.owner", "seal.chain.source_build.worker", "seal.chain.source_build.agent", "seal.chain.source_build.evidence.log", "seal.chain.source_build.evidence.pkginfo",
            "seal.chain.audit.verdict", "seal.chain.audit.summary", "seal.chain.audit.agent", "seal.chain.audit.report",
            "seal.chain.approval.by", "seal.chain.approval.at", "seal.chain.approval.note",
            "seal.signature", "seal.attestation.statement", "seal.attestation.signature", "seal.object", "seal.filename", "seal.sha256",
          ],
        },
        // The links the facts carry: the seal as JSON, and the evidence the chain names — public text in the staging space.
        { path: `/api/v1/packages/${F.sha}/provenance`, fields: ["origin", "seal", "summary", "upstream.project", "object", "filename", "sha256"] },
        { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/PKGBUILD`, json: false },
        { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/build.log`, json: false },
        { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/PKGINFO`, json: false },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/audit.md`, json: false },
      ],
      visible: EVERYONE,
    },
    {
      id: "package.security-badge",
      page,
      anchor: ['id="sec-section"', 'id="sec-badge"'],
      script: ['"#sec-badge"', "open.length", "exposed via ", "no open advisory"],
      reads: [{ path: pkg, fields: ["security.advisories", "security.advisories.0.status", "security.exposed"] }],
      visible: EVERYONE,
    },
    {
      id: "package.security-own",
      page,
      anchor: ['id="sec-own"'],
      script: ['"#sec-own"', "advLine", "a.cves.join", "a.match", "a.fixed", "a.kev", "a.epss", "a.summary", "fixed in this version"],
      reads: [{ path: pkg, fields: ["package.version", "security.advisories.0.id", "security.advisories.0.severity", "security.advisories.0.status", "security.advisories.0.cves", "security.advisories.0.match", "security.advisories.0.fixed", "security.advisories.0.kev", "security.advisories.0.epss", "security.advisories.0.summary", "security.advisories.0.url"] }],
      visible: EVERYONE,
    },
    {
      id: "package.security-exposed",
      page,
      anchor: ['id="sec-exposed"'],
      script: ['"#sec-exposed"', "e.via", "e.declared", "e.sonames", "e.advisory.severity", "e.advisory.cves", "e.advisory.match"],
      reads: [{ path: pkg2, fields: ["security.exposed.0.via", "security.exposed.0.declared", "security.exposed.0.sonames", "security.exposed.0.advisory.severity", "security.exposed.0.advisory.url", "security.exposed.0.advisory.cves", "security.exposed.0.advisory.match"] }],
      visible: EVERYONE,
    },
    {
      id: "package.rings-table",
      page,
      anchor: ['id="rings"', 'id="arch-label"'],
      script: ['"#rings tbody"', '"#arch-label"', "row.version", "row.release_seq", "row.source", "row.sha256", "row.size_download"],
      reads: [{ path: pkg, fields: ["shown_ring", "arch", "rings.0.ring", "rings.0.version", "rings.0.release_seq", "rings.0.source", "rings.0.sha256", "rings.0.size_download"] }],
      visible: EVERYONE,
    },
    {
      // Left: what requires the page's package (zlib's side); right: what it declares and loads (xz's side), with the providers that carry an advisory.
      id: "package.graph",
      page,
      anchor: ['id="graph-card"', 'id="graph"'],
      script: ['"/api/v1/package/"', '"#graph"', "required_by", "depends", "links", "vulnProviders", "x.provider.name"],
      reads: [
        { path: pkg, fields: ["name", "shown_ring", "required_by", "required_by.0.name", "required_by.0.version", "required_by.0.declared", "required_by.0.sonames", "depends", "links", "security.exposed", "security.advisories.0.status", "rings"] },
        { path: pkg2, fields: ["name", "depends.0.name", "depends.0.provider.name", "links.0.soname", "links.0.provider.name", "security.exposed.0.via", "security.exposed.0.advisory.cves"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "package.depends-list",
      page,
      anchor: ['id="deps"'],
      script: ['"#deps"', "x.provider.version", "no declared dependencies"],
      reads: [{ path: pkg2, fields: ["depends.0.name", "depends.0.provider.name", "depends.0.provider.version"] }],
      visible: EVERYONE,
    },
    {
      id: "package.links-list",
      page,
      anchor: ['id="links"'],
      script: ['"#links"', "x.soname", "not in this ring"],
      reads: [{ path: pkg2, fields: ["links.0.soname", "links.0.provider.name"] }],
      visible: EVERYONE,
    },
    {
      id: "package.required-by-list",
      page,
      anchor: ['id="rb"', 'id="rb-count"'],
      script: ['"#rb"', '"#rb-count"', "x.declared", "x.sonames", ">= 400"],
      reads: [{ path: pkg, fields: ["required_by", "required_by.0.name", "required_by.0.declared", "required_by.0.sonames"] }],
      visible: EVERYONE,
    },
    {
      id: "package.provides-list",
      page,
      anchor: ['id="provides"'],
      script: ['"#provides"', "m.provides", "only itself"],
      reads: [{ path: pkg, fields: ["name", "manifest.provides"] }],
      visible: EVERYONE,
    },
    {
      id: "package.components-table",
      page,
      anchor: ['id="components-section"', 'id="components-count"', 'id="components"'],
      script: ['"#components-section"', '"#components-count"', 'pager("#components"', "x.ecosystem", "x.name", "x.version"],
      reads: [{ path: pkg, fields: ["manifest.components", "manifest.components.0.ecosystem", "manifest.components.0.name", "manifest.components.0.version"] }],
      visible: EVERYONE,
    },
    {
      id: "package.files",
      page,
      anchor: ['id="load-files"', 'id="files"'],
      script: ['"#load-files"', '"#files"', '"/files?ring="', "d.files"],
      reads: [{ path: `/api/v1/package/${F.pkg}/files?ring=stable&arch=${F.arch}`, fields: ["name", "ring", "arch", "files"] }],
      visible: EVERYONE,
    },
  ];
};

