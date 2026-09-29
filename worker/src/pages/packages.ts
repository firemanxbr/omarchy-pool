/**
 * Packages: search within a ring, and one package's page — where it is in
 * every ring, what it declares, what its binaries actually load, who depends
 * on it, drawn as a graph — with the file list on demand.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { CHARTS } from "./charts";
import { EXPECTED_SOURCES, type RunningVersion } from "../meta";
import { lucide } from "./kit";
import { escapeHtml } from "../html";

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
  // The rings are the server's list in its order (RINGS_TEXT: stable, rc, edge, lab — the lab included, as the search takes it), the architectures the shell's (ARCHES); the first of each is the default.
  var RINGS = Object.keys(RINGS_TEXT);
  var q = new URLSearchParams(location.search);
  var ring = RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : RINGS[0];
  var arch = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : ARCHES[0];
  var timer = null, seq = 0, OWNERS = {}, APPROVERS = {};
  // Who made the factory's packages: the contributor who registered it, the maintainer whose approval stands — the row's own standing, the server's word, so a withdrawn one names nobody.
  fetch("/api/v1/factory/packages").then(function (r) { return r.json(); }).then(function (d) { (d.packages || []).forEach(function (p) { OWNERS[p.name] = p.owner; }); }).catch(function () {});
  fetch("/api/v1/factory/approvals").then(function (r) { return r.json(); }).then(function (d) { (d.approvals || []).forEach(function (a) { if (a.standing && !APPROVERS[a.name]) APPROVERS[a.name] = a.by; }); }).catch(function () {});
  // The two icons take their role from the maintainer set the shell reads once per page — a maintainer who brought a package is green here as everywhere, not a guessed "contributor".
  function byCell(p) {
    if (p.source === "factory") { var o = OWNERS[p.name], a = APPROVERS[p.name]; return '<span class="by">' + (o ? avatar(o) : "") + (a ? avatar(a) : "") + '</span>' + (!o && !a ? '<span class="dim">the pool</span>' : ""); }
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
        return '<tr data-name="' + esc(p.name) + '" style="cursor:pointer"><td><a class="pkname" href="' + pkgHref(p.name, ring, arch) + '" title="open the package page">' + esc(p.name) + ' <span class="go">→</span></a></td><td class="mono">' + esc(p.version) + '</td><td><span class="src">' + esc(p.source) + '</span></td><td>' + byCell(p) + '</td><td class="muted"><span class="clamp">' + esc(p.description || "") + '</span></td><td class="num">' + bytes(p.size_download) + '</td></tr>';
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
      // The people are the shell's — icon and link — with the role from the maintainer set; approved_by is the approval that stands, the server's word.
      var who = f ? '<div class="whorow">' + (f.owner ? avatar(f.owner) + '<span>brought by ' + personLink(f.owner) + '</span>' : '') + (f.approved_by ? avatar(f.approved_by) + '<span>approved by ' + personLink(f.approved_by) + '</span>' : '<span class="dim">waiting for a maintainer</span>') + '</div>' : '<div class="whorow dim">packaged upstream' + (mt.packager ? ' by ' + esc(mt.packager.replace(/<.*>/, "").trim()) : '') + ' · mirrored, signature kept</div>';
      var rows = RINGS.map(function (r) { var x = (d.rings || []).filter(function (y) { return y.ring === r; })[0]; return '<dt>' + r + '</dt><dd>' + (x ? esc(x.version) : '<span class="dim">not served</span>') + '</dd>'; }).join("");
      el.innerHTML = '<h3>' + esc(name) + ' <span class="dim" style="font-size:12px;font-weight:400">' + esc(p.source) + '</span></h3>' + who + '<p class="sub" style="margin:0 0 12px">' + esc(pi.desc || m.description || "") + '</p>' +
        '<dl class="kv">' + rows + '<dt>size</dt><dd>' + bytes(p.size_download) + ' · ' + bytes(p.size_installed) + ' installed</dd><dt>depends on</dt><dd>' + num((d.depends || []).length) + ' declared · loads ' + num((d.links || []).length) + ' libraries</dd><dt>required by</dt><dd>' + num((d.required_by || []).length) + ' in ' + esc(d.shown_ring) + (d.required_by && d.required_by.length > 100 ? ' <span class="pill warn">exposes many</span>' : '') + '</dd><dt>security</dt><dd>' + (own.length ? '<span class="pill warn">' + num(own.length) + ' open</span> ' + esc(own[0].cves.join(", ")) : '<span class="pill ok">no open advisory</span>') + (exp.length ? ' · exposed through ' + num(exp.length) : '') + '</dd></dl>' +
        '<pre style="margin-top:12px"><span class="c"># from the ring you configured</span>\nsudo pacman -S ' + esc(name) + '</pre><div class="cta-row" style="margin-top:14px"><a class="btn" href="' + pkgHref(name, d.shown_ring, arch) + '">Open ' + esc(name) + ' →</a><span class="hint">who made it · provenance · graph · files</span></div>';
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
    // The picked ring is one of RINGS already; /stats lists every ring, the lab too.
    var r0 = d.rings.filter(function (r) { return r.ring === ring; })[0] || { sources: [] };
    $("#pk-src-ring").textContent = ring + " · " + arch;
    var rows = (r0.sources || []).filter(function (x) { return x.arch === arch; }).sort(function (a, b) { return b.packages - a.packages; }), tot = rows.reduce(function (n, x) { return n + x.packages; }, 0) || 1;
    $("#pk-sources").innerHTML = hrows(rows.map(function (x) { return [x.source, "", Math.round(1000 * x.packages / tot) / 10, x.source === "factory" ? "var(--lilac)" : x.source === "packages" ? "var(--blue)" : "var(--green)", num(x.packages)]; }), 120);
    var head = (d.releases || []).filter(function (r) { return r.ring === "stable" && r.is_head; })[0];
    if (head && head.parent_id) {
      $("#pk-diff-when").textContent = "#" + head.seq + " · " + ago(head.created_at);
      fetch("/api/v1/releases/stable/diff?from=" + head.parent_id + "&to=" + head.id).then(function (r) { return r.json(); }).then(function (df) {
        var name = function (x) { return '<a class="run" href="' + pkgHref(x.name, "stable", x.arch) + '">' + esc(x.name) + '</a>'; };
        var up = df.upgraded || [], ad = df.added || [], rm = df.removed || [];
        $("#pk-diff").innerHTML = '<div class="flow" style="margin-top:6px"><div class="st"><span class="k">upgraded</span><b>' + num(up.length) + '</b><span class="s">' + up.slice(0, 3).map(name).join(", ") + (up.length > 3 ? "…" : "") + '</span></div><div class="ar">·</div><div class="st"><span class="k">added</span><b>' + num(ad.length) + '</b><span class="s">' + ad.slice(0, 3).map(name).join(", ") + (ad.length > 3 ? "…" : "") + '</span></div><div class="ar">·</div><div class="st"><span class="k">removed</span><b>' + num(rm.length) + '</b><span class="s">' + (rm.length ? rm.slice(0, 3).map(name).join(", ") : "nothing left the ring") + '</span></div></div><p class="sub" style="margin:12px 0 0;font-size:12.5px"><a href="/diff?ring=stable&from=' + head.parent_id + '&to=' + head.id + '">The whole diff →</a> · <a href="/journal">Ring history →</a></p>';
      }).catch(function () { $("#pk-diff").innerHTML = '<div class="empty">no diff available</div>'; });
    } else $("#pk-diff").innerHTML = '<div class="empty">' + (head ? "the first stable release has no parent" : "no stable release yet") + '</div>';
    endSkeleton();
  }, 120000);
`;

/**
 * A package's page (#244): one layout for every package, synced or built by
 * the factory, and the same information for everyone — only the actions in
 * the You card change with the viewer. The header (name, version, state,
 * where it comes from, each architecture), five tiles that jump to their
 * section, how it got here in four stages (the request or the upstream, the
 * build, the review, the rings), each with its panel, the security of the
 * object and of what it loads, the dependency graph and the files; beside
 * them the install, the seal, the people and agents, the facts and You.
 * Below 1120px the install and the seal come first, then the main column,
 * then the rest of the side.
 *
 * Its rules are its own (page() serves them after the kit's sheet), under
 * .pkg: what the kit has no piece for — the header, the stages and their
 * panel, the matrices, the graph, the side's cards — in the kit's tokens.
 */
const PACKAGE_CSS = String.raw`
  .pkg { max-width: calc(var(--content-wide) - 2 * var(--gutter)); margin: 0 auto; display: grid; gap: 20px; }
  .pkg .crumbs { margin: 0; }
  .pkg section { margin: 0; }
  .pkg a { text-decoration: none; }
  .pkg-head { display: flex; flex-wrap: wrap; gap: 16px 32px; justify-content: space-between; align-items: flex-start; }
  .pkg-id { flex: 1 1 420px; min-width: 0; display: flex; gap: 16px; align-items: flex-start; }
  .pkg-id > .op-box { color: var(--muted); } .pkg-id > .op-box.ok { color: var(--green); }
  .pkg-idt { display: grid; gap: 6px; min-width: 0; }
  .pkg-title { display: flex; align-items: baseline; gap: 6px 12px; flex-wrap: wrap; min-width: 0; }
  .pkg-title h1 { margin: 0; font: 600 30px/1.15 var(--font-display); letter-spacing: var(--tracking-display); overflow-wrap: anywhere; }
  .pkg-ver { font: 500 16px var(--font-display); color: var(--dim); overflow-wrap: anywhere; }
  .pkg-desc { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
  .pkg-desc a { color: var(--green); }
  .pkg-chips { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 12.5px; }
  .pkg-chips .op-chip { padding: 1px 8px; } .pkg-chips .op-chip.factory { color: var(--green); }
  .pkg-chips .pill.tgt { font-size: 12.5px; padding: 1px 8px; }
  .pkg-pick { display: grid; gap: 8px; justify-items: end; }
  .pkg-blocked { border: 1px solid var(--red); background: var(--panel-2); padding: 12px 16px; display: flex; gap: 12px; align-items: flex-start; font-size: 13.5px; }
  .pkg-blocked > i { color: var(--red); margin-top: 3px; } .pkg-blocked > div { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; } .pkg-blocked b { color: var(--red); font-weight: 600; } .pkg-blocked .dim { color: var(--dim); }
  .pkg-tiles .op-stat { padding: 14px 16px; }
  .pkg-tiles .op-stat .k { display: flex; align-items: center; gap: 8px; }
  .pkg-tiles .op-stat .n { font-size: 22px; line-height: 1.15; }
  .pkg .ok-t { color: var(--green); } .pkg .run-t { color: var(--blue); } .pkg .warn-t { color: var(--amber); } .pkg .fail-t { color: var(--red); } .pkg .dim-t { color: var(--dim); }
  .pkg-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 35%); grid-template-rows: auto 1fr; grid-template-areas: "main a" "main b"; gap: 20px; align-items: start; }
  .pkg-main { grid-area: main; display: grid; gap: 20px; min-width: 0; }
  .pkg-side-a { grid-area: a; } .pkg-side-b { grid-area: b; }
  .pkg-side-a, .pkg-side-b { display: grid; gap: 12px; align-content: start; min-width: 0; }
  /* Narrower than the frame: one column — the install and the seal first, what it takes to have the package, then the main column, then the rest of the side. */
  @media (max-width: 1119px) { .pkg-cols { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; grid-template-areas: "a" "main" "b"; } }
  @media (max-width: 719px) { .pkg-pick { justify-items: start; } .pkg-title h1 { font-size: 26px; } }
  .pkg-h { display: flex; align-items: center; gap: 10px; min-width: 0; color: var(--dim); }
  .pkg-h b { font: 600 15px var(--font-display); color: var(--text); }
  .pkg .op-card-h small a { color: var(--green); }
  /* How it got here: four stages as tabs, the chosen one open into its panel below. */
  .pkg-chain-h { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  .pkg-chain-h small { font-size: 12px; color: var(--dim); }
  .pkg-stages { display: flex; flex-wrap: wrap; padding-left: 1px; }
  .pkg-stage { --st: var(--dim); flex: 1 1 150px; min-width: 0; margin: 0 0 0 -1px; border: 1px solid var(--line); border-top: 2px solid var(--st); background: var(--panel-2); padding: 12px 14px; display: grid; gap: 8px; align-content: start; position: relative; font: inherit; color: var(--text); text-align: left; cursor: pointer; }
  .pkg-stage:hover { background: var(--panel); }
  .pkg-stage[aria-selected="true"] { background: var(--panel); border-bottom-color: var(--panel); z-index: 2; }
  .pkg-stage.ok { --st: var(--green); } .pkg-stage.run { --st: var(--blue); } .pkg-stage.warn { --st: var(--amber); } .pkg-stage.fail { --st: var(--red); }
  .pkg-stage-t { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; }
  .pkg-stage-t > span { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .pkg-stage-t b { font: 600 15px var(--font-display); letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pkg-stage-t .op-box { width: 26px; height: 26px; }
  .pkg-stage-t .op-box { color: var(--st); border-color: var(--st); }
  .pkg-stage-s { font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkg-stage-a { display: flex; gap: 4px; align-items: center; min-height: 16px; font-size: 11.5px; color: var(--dim); }
  .pkg-stage-a > span { margin-left: 4px; }
  .pkg-panel { border: 1px solid var(--line); border-top: 0; background: var(--panel); padding: 18px; display: grid; gap: 16px; min-width: 0; }
  .pkg-ph { display: flex; justify-content: space-between; align-items: center; gap: 10px 16px; flex-wrap: wrap; }
  .pkg-ph > span { display: flex; align-items: center; gap: 10px; } .pkg-ph b { font: 600 17px var(--font-display); }
  .pkg-who { display: flex; gap: 6px; flex-wrap: wrap; }
  .pkg-whoc { display: inline-flex; align-items: center; gap: 7px; min-width: 0; border: 1px solid var(--line); background: var(--bg-deep); padding: 2px 9px 2px 3px; font-size: 12.5px; color: var(--text); }
  .pkg-whoc .r { color: var(--dim); } .pkg-whoc .avatar { width: 20px; height: 20px; font-size: 8.5px; }
  .pkg-glyph { display: inline-grid; place-items: center; flex: none; width: 20px; height: 20px; background: var(--panel-2); color: var(--muted); font-size: 8.5px; font-weight: 700; }
  .pkg-glyph.pool { background: var(--green); color: var(--green-ink); } .pkg-glyph.agent { background: var(--bg-deep); color: var(--text); }
  .pkg-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)); gap: 12px 20px; }
  .pkg-field { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
  .pkg-field > i { color: var(--dim); margin-top: 3px; } .pkg-field > div { display: grid; min-width: 0; }
  .pkg-field .op-label { font-size: 11px; } .pkg-field .v { font-size: 13.5px; overflow-wrap: anywhere; } .pkg-field .v a { color: var(--green); }
  .pkg-sub { display: grid; gap: 6px; min-width: 0; }
  .pkg-rows { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 6px 20px; }
  .pkg-row { display: flex; gap: 10px; align-items: baseline; font-size: 13.5px; min-width: 0; overflow-wrap: anywhere; }
  .pkg-row .op-mark { flex: none; } .pkg-row .dim { color: var(--dim); } .pkg-row a { color: var(--green); }
  .pkg-mx { border: 1px solid var(--line); min-width: 0; }
  .pkg-mx > div { display: grid; grid-template-columns: minmax(0, 1fr) repeat(2, minmax(76px, 140px)); border-top: 1px solid var(--line); font-size: 13px; }
  .pkg-mx > div:first-child { border-top: 0; background: var(--bg-deep); font-size: 12px; color: var(--dim); }
  .pkg-mx > div > span { padding: 6px 12px; min-width: 0; overflow-wrap: anywhere; }
  .pkg-mx > div > span + span { border-left: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; }
  .pkg-mx small { font-size: 11.5px; color: var(--dim); }
  .pkg-mx > .foot { background: var(--panel-2); font-size: 12px; color: var(--dim); } .pkg-mx > .foot > span + span { color: var(--muted); }
  .pkg-diff { background: var(--bg-deep); border: 1px solid var(--line); padding: 10px 12px; font: 12.5px/1.75 var(--font-mono); overflow-x: auto; }
  .pkg-diff div { white-space: pre; } .pkg-diff .add { color: var(--green); } .pkg-diff .del { color: var(--red); } .pkg-diff .ctx, .pkg-diff .gap { color: var(--dim); }
  .pkg-rings { display: flex; flex-wrap: wrap; gap: 16px 24px; }
  .pkg-rt { flex: 3 1 360px; min-width: 0; border: 1px solid var(--line); overflow-x: auto; }
  .pkg-rt td { white-space: nowrap; } .pkg-rt tr.on td { background: var(--panel-2); } .pkg-rt .dim { color: var(--dim); }
  .pkg-tl { flex: 2 1 220px; min-width: 0; display: grid; gap: 2px; align-content: start; }
  .pkg-tl > div { display: grid; grid-template-columns: 40px 10px minmax(0, 1fr); gap: 10px; align-items: center; font-size: 13px; padding: 3px 0; }
  .pkg-tl .w { font-size: 12px; color: var(--dim); } .pkg-tl .sq { width: 10px; height: 10px; background: currentColor; }
  .pkg-tl .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pkg-tl .t b { font-weight: 600; } .pkg-tl .t span { color: var(--dim); margin-left: 8px; }
  .pkg-note { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 12px; overflow-wrap: anywhere; }
  .pkg-note > i { color: var(--dim); margin-top: 3px; } .pkg-note a { color: var(--green); }
  .pkg-links { display: flex; gap: 8px 18px; flex-wrap: wrap; font-size: 12.5px; }
  .pkg-links a { display: inline-flex; align-items: center; gap: 6px; color: var(--green); } .pkg-links a:hover { text-decoration: underline; }
  /* Security: the version on the left, what it loads on the right — one square per advisory, grouped by the dependency it comes through. */
  .pkg-sec { display: flex; flex-wrap: wrap; }
  .pkg-sec-own { flex: 1 1 200px; padding: 16px; display: grid; gap: 4px; align-content: start; border-right: 1px solid var(--line); }
  .pkg-sec-own .big { font: 600 24px/1.2 var(--font-display); } .pkg-sec-own > span:not(.op-label) { font-size: 12.5px; color: var(--dim); }
  .pkg-sec-dep { flex: 3 1 380px; min-width: 0; padding: 12px 16px 14px; display: grid; gap: 8px; align-content: start; }
  .pkg-sech { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; } .pkg-adv + .pkg-sech { margin-top: 6px; }
  .pkg-sec-dep > p { margin: 0; font-size: 13px; color: var(--muted); }
  .pkg-sevs { display: flex; gap: 8px; flex-wrap: wrap; } .pkg-sevs span { display: flex; align-items: center; gap: 5px; font-size: 11.5px; }
  .pkg-sq { display: inline-block; flex: none; width: 9px; height: 9px; background: currentColor; }
  .pkg-adv { border-top: 1px solid var(--line); min-width: 0; }
  .pkg-adv > summary { list-style: none; display: grid; grid-template-columns: 12px minmax(64px, 130px) minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 7px 0; cursor: pointer; font-size: 13px; }
  .pkg-adv > summary::-webkit-details-marker { display: none; }
  .pkg-adv > summary::before { content: "›"; color: var(--green); transition: transform 120ms; } .pkg-adv[open] > summary::before { transform: rotate(90deg); }
  .pkg-adv > summary b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkg-adv .via { font-size: 12px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkg-adv .dots { display: flex; gap: 3px; flex-wrap: wrap; justify-content: flex-end; max-width: 120px; } .pkg-adv .dots i { width: 10px; height: 10px; background: currentColor; }
  .pkg-adv ul { list-style: none; margin: 0; padding: 0 0 8px 22px; display: grid; gap: 3px; }
  .pkg-adv li { display: flex; gap: 4px 12px; font-size: 12.5px; flex-wrap: wrap; align-items: baseline; }
  .pkg-adv .sev { width: 62px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; } .pkg-adv li a { color: var(--green); } .pkg-adv li .dim { color: var(--dim); }
  @media (max-width: 719px) { .pkg-sec-own { border-right: 0; border-bottom: 1px solid var(--line); } .pkg-adv > summary { grid-template-columns: 12px minmax(0, 1fr) auto; } .pkg-adv .via { display: none; } }
  /* Dependencies: required-by on the left, depends-on on the right, the package between, drawn by the SVG connectors; one column on a phone. */
  .pkg-legend { display: flex; gap: 6px 14px; flex-wrap: wrap; font-size: 12px; color: var(--dim); }
  .pkg-legend span { display: flex; align-items: center; gap: 6px; } .pkg-legend .ln { width: 14px; height: 2px; }
  .pkg-graph { display: grid; grid-template-columns: minmax(0, 1fr) 64px auto 64px minmax(0, 1.2fr); align-items: start; }
  .pkg-graph > .op-label { margin-bottom: 6px; } .pkg-graph > .gl { grid-area: 1 / 1; } .pkg-graph > .gr { grid-area: 1 / 5; }
  .pkg-graph > .pkg-gcol.l { grid-area: 2 / 1; } .pkg-graph > svg.l { grid-area: 2 / 2; } .pkg-graph > .pkg-center { grid-area: 2 / 3; } .pkg-graph > svg.r { grid-area: 2 / 4; } .pkg-graph > .pkg-gcol.r { grid-area: 2 / 5; }
  .pkg-gcol { display: grid; gap: 2px; min-width: 0; }
  .pkg-node { height: 24px; border: 1px solid var(--line); background: var(--bg-deep); display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 8px; font: 12px var(--font-mono); color: var(--text); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  a.pkg-node:hover { border-color: var(--green); }
  .pkg-node > span { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .pkg-node .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pkg-node .v { font-size: 11px; color: var(--dim); white-space: nowrap; }
  .pkg-node .t { font-size: 11px; white-space: nowrap; flex: none; } .pkg-node .t.decl { color: var(--blue); } .pkg-node .t.so { color: var(--green); } .pkg-node .t.none { color: var(--dim); }
  .pkg-node.adv { border-color: color-mix(in oklab, var(--red) 55%, var(--line)); } .pkg-node .dot { width: 7px; height: 7px; flex: none; background: var(--red); }
  .pkg-node.gone { color: var(--dim); } button.pkg-node { width: 100%; color: var(--green); cursor: pointer; text-align: left; } button.pkg-node:hover { border-color: var(--green); }
  .pkg-center { height: 36px; display: grid; place-items: center; padding: 0 18px; background: var(--green); color: var(--green-ink); font: 600 14px var(--font-display); white-space: nowrap; } .pkg-center.fail { background: var(--red); }
  .pkg-graph svg { display: block; overflow: visible; }
  .pkg-gfoot { display: flex; gap: 8px 24px; flex-wrap: wrap; font-size: 12.5px; color: var(--dim); margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
  .pkg-gfoot b { font-weight: 400; color: var(--text); overflow-wrap: anywhere; }
  .pkg-more { margin-top: 12px; } .pkg-more > summary { cursor: pointer; font-size: 12.5px; color: var(--green); }
  .pkg-more ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr)); gap: 3px 20px; font-size: 12.5px; }
  .pkg-more li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pkg-more li a { color: var(--text); } .pkg-more li a:hover { color: var(--green); } .pkg-more li span { color: var(--dim); }
  .pkg-more table { margin-top: 8px; }
  @media (max-width: 719px) { .pkg-graph { grid-template-columns: minmax(0, 1fr); } .pkg-graph > * { grid-area: auto !important; } .pkg-graph > svg { display: none; } .pkg-graph > .pkg-gcol { padding-top: 0 !important; } .pkg-graph > .pkg-center { justify-self: start; margin: 12px 0 !important; } .pkg-graph > .gr { margin-top: 4px; } }
  .pkg-files-h { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; text-align: left; }
  .pkg-files-h:hover { background: var(--panel-2); } .pkg-files-h .pkg-h small { font-size: 12.5px; } .pkg-files-h > span:last-child { font-size: 12.5px; color: var(--green); }
  .pkg-files-h[disabled] { cursor: default; } .pkg-files-h[disabled]:hover { background: none; } .pkg-files-h[disabled] > span:last-child { color: var(--dim); }
  .pkg-files { border-top: 1px solid var(--line); padding: 12px 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr)); gap: 3px 20px; font-size: 12.5px; color: var(--muted); }
  .pkg-files span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The side: the install, the seal, the people and agents, the facts, You. */
  .pkg-side-a .op-card-h, .pkg-side-b .op-card-h { padding: 10px 14px; }
  .pkg-inst { padding: 12px 14px; display: grid; gap: 10px; }
  .pkg-inst .op-code { padding: 10px 12px; } .pkg-inst .op-code code { font-size: 13px; }
  .pkg-noinst { display: flex; gap: 10px; align-items: center; font-size: 13px; color: var(--muted); border: 1px dashed var(--line); padding: 10px 12px; } .pkg-noinst > i { color: var(--dim); }
  .pkg-agents { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--dim); } .pkg-agents > span { margin-right: 4px; }
  .pkg-agents > i { box-sizing: content-box; padding: 4px; border: 1px solid var(--line); background: var(--bg-deep); }
  .pkg-small { font-size: 12px; color: var(--dim); } .pkg-small a { color: var(--green); }
  .pkg-seal { padding: 6px 14px 10px; display: grid; }
  .pkg-seal > div { display: grid; grid-template-columns: minmax(0, 1fr) 44px 44px; align-items: center; font-size: 13px; padding: 5px 0; border-top: 1px solid var(--line); }
  .pkg-seal > div:first-child { border-top: 0; padding: 4px 0; font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); } .pkg-seal > div:first-child span { text-align: center; }
  .pkg-seal .g { display: flex; align-items: center; gap: 9px; min-width: 0; color: var(--dim); } .pkg-seal .g span { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkg-seal .op-mark { justify-self: center; }
  .pkg-sealf { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 10px; padding: 9px 14px; border-top: 1px solid var(--line); font-size: 12px; color: var(--dim); }
  .pkg-sealf > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; } .pkg-sealf a { color: var(--green); white-space: nowrap; }
  .pkg-people { padding: 6px 14px 10px; display: grid; }
  .pkg-person { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line); }
  .pkg-person:first-child { border-top: 0; }
  .pkg-person .avatar, .pkg-person .pkg-glyph { width: 26px; height: 26px; font-size: 11px; }
  .pkg-person > div { display: grid; min-width: 0; line-height: 1.35; }
  .pkg-person .r { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  .pkg-person .l { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pkg-person .l a { color: var(--text); } .pkg-person .l a:hover { color: var(--green); } .pkg-person .l span { color: var(--dim); }
  .pkg-facts { padding: 6px 14px 10px; display: grid; }
  .pkg-facts > div { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .pkg-facts > div:last-child { border-bottom: 0; } .pkg-facts > div > i { color: var(--dim); }
  .pkg-facts span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .pkg-facts a { color: var(--green); } .pkg-facts a:hover { text-decoration: underline; }
  .pkg-you { padding: 12px 14px; display: grid; gap: 10px; }
  .pkg-you > p { margin: 0; font-size: 13px; color: var(--muted); }
  .pkg-btns { display: flex; gap: 8px; flex-wrap: wrap; }
  .pkg-lock { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--dim); }
  .pkg-ask { display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
  .pkg-ask input { min-width: 0; background: var(--bg-deep); border: 1px solid var(--line); border-radius: 0; color: var(--text); font: 13px var(--font-mono); padding: 7px 10px; }
  .pkg-ask .op-btn.danger { background: var(--red); color: var(--green-ink); }
  .pkg-ask input:focus-visible { outline: 1px solid var(--green); outline-offset: -1px; }
  .pkg-ask .err { margin: 0; font-size: 12px; color: var(--red); }
`;

/** Where a synced package comes from, in words (meta.ts's EXPECTED_SOURCES, as the ⌘K menu says it): "core/x86_64" → "Arch core". */
const SOURCE_WORDS: Record<string, string> = Object.fromEntries(EXPECTED_SOURCES.map((e) => [`${e.source}/${e.arch}`, e.origin]));

/** The page as served: the frame of every section, its headings and icons, filled by the script from the package's answers; the name is the address's, escaped. */
function packageBody(name: string): string {
  const n = escapeHtml(name);
  return String.raw`
<div class="pkg" id="pkg">
  <p class="crumbs"><a href="/packages">Packages</a> / <span id="crumb">${n}</span></p>
  <section class="pkg-head">
    <div class="pkg-id">
      <span class="op-box lg" id="pkg-mark">${lucide("package", 26)}</span>
      <div class="pkg-idt">
        <div class="pkg-title"><h1 id="title">${n}</h1><span class="pkg-ver" id="pkg-ver"></span><span id="pkg-state"></span></div>
        <p class="pkg-desc" id="desc"></p>
        <div class="pkg-chips" id="pkg-chips"></div>
      </div>
    </div>
    <div class="pkg-pick">
      <nav class="op-seg" id="pg-ring" aria-label="Ring"></nav>
      <nav class="op-seg" id="pg-arch" aria-label="Architecture"></nav>
    </div>
  </section>
  <div class="pkg-blocked" id="pkg-blocked" hidden></div>
  <section class="op-stats pkg-tiles" id="pg-tiles" aria-label="The package in five numbers"></section>
  <div class="pkg-cols">
    <div class="pkg-main">
      <section id="op-chain">
        <div class="pkg-chain-h"><span class="op-label">How it got here</span><small id="chain-note"></small></div>
        <div class="pkg-stages" role="tablist" aria-label="How it got here" id="stages"></div>
        <div class="pkg-panel" role="tabpanel" id="stage-panel"><p class="pkg-small">Loading</p></div>
      </section>
      <section class="op-card" id="sec-section">
        <div class="op-card-h"><span class="pkg-h" id="sec-icon">${lucide("shield", 16)}<b>Security</b></span><small>matched every 3 hours · <a href="/docs/security#confidence">what the confidence means</a></small></div>
        <div class="pkg-sec">
          <div class="pkg-sec-own" id="sec-own"><span class="op-label">On this version</span></div>
          <div class="pkg-sec-dep" id="sec-exposed"></div>
        </div>
      </section>
      <section class="op-card" id="deps-section">
        <div class="op-card-h"><span class="pkg-h">${lucide("git-fork", 16)}<b>Dependencies</b></span><span class="pkg-legend"><span><i class="ln" style="background:var(--blue)"></i>declared</span><span><i class="ln" style="background:var(--green)"></i>loads a library</span><span><i class="pkg-sq" style="color:var(--red)"></i>advisory</span></span></div>
        <div class="op-card-b" id="deps"></div>
      </section>
      <section class="op-card" id="files-section">
        <button type="button" class="pkg-files-h" id="load-files" aria-expanded="false" aria-controls="files"><span class="pkg-h">${lucide("folder-tree", 16)}<b>Files</b><small id="files-count"></small></span><span id="files-label">show</span></button>
        <div class="pkg-files" id="files" hidden></div>
      </section>
    </div>
    <aside class="pkg-side-a" aria-label="Install and seal">
      <section class="op-card" id="install">
        <div class="op-card-h"><span class="pkg-h ok-t">${lucide("download", 15)}<b>Install</b></span><div class="op-tabs" role="tablist" aria-label="Install with"><button type="button" role="tab" aria-selected="true" data-mode="cmd">Command</button><button type="button" role="tab" aria-selected="false" data-mode="agent">Agent</button></div></div>
        <div class="pkg-inst" id="install-b"></div>
      </section>
      <section class="op-card" id="seal-section">
        <div class="op-card-h"><span class="pkg-h" id="seal-icon">${lucide("badge-check", 15)}<b>Seal</b></span><small id="seal-ctx"></small></div>
        <div class="pkg-seal" id="seal"></div>
        <div class="pkg-sealf" id="seal-foot"></div>
      </section>
    </aside>
    <aside class="pkg-side-b" aria-label="Who and what">
      <section class="op-card" id="who-section">
        <div class="op-card-h"><span class="pkg-h">${lucide("users", 15)}<b>People &amp; agents</b></span></div>
        <div class="pkg-people" id="who"></div>
      </section>
      <section class="op-card" id="facts-section"><div class="pkg-facts" id="facts"></div></section>
      <section class="op-card" id="you-section">
        <div class="op-card-h"><span class="pkg-h" id="you-icon">${lucide("eye", 15)}<b>You</b></span><small id="you-who"></small></div>
        <div class="pkg-you" id="you"></div>
      </section>
    </aside>
  </div>
</div>
`;
}

const PACKAGE_SCRIPT = String.raw`
  var name = decodeURIComponent(location.pathname.split("/").pop());
  var q = new URLSearchParams(location.search);
  // The rings are the server's list in its order (RINGS_TEXT: stable, rc, edge, lab), the first the default: the page asks the API for any of them, the lab included, and draws the ring the API says it shows (shown_ring) — the most stable one that serves the package when the asked one does not.
  var RINGS = Object.keys(RINGS_TEXT);
  var ring = RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : RINGS[0];
  var arch = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : ARCHES[0];
  // Where a synced package comes from, in words: meta.ts's list, spliced.
  var SOURCE_WORDS = __SOURCE_WORDS__;
  // The two answers the page is drawn from: the package in its ring and architecture (D; D404 when this architecture has none, which still says where the others are served) and the factory's story of it (ST; none for a synced package). The chosen stage, the install's mode, the recipes a review compares, the file list once asked, the open form of You.
  var D = null, D404 = null, ST = null, STAGE = null, MODE = "cmd", RECIPES = {}, FILES = null, ASK = null;
  var GLYPH = { ok: "✓", run: "⟳", warn: "✓", fail: "✗", wait: "○", na: "—" };
  // A status mark, an architecture's square, a date, a span without "ago".
  function mark(tone, title) { return '<b class="op-mark ' + tone + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + GLYPH[tone] + '</b>'; }
  function square(tone, title) { return '<i class="op-arch ' + tone + '" title="' + esc(title) + '"></i>'; }
  function onDay(iso) { if (!iso) return "—"; var t = new Date(iso); return isNaN(t) ? "—" : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
  function since(iso) { return iso ? ago(iso).replace(" ago", "") : ""; }
  function hue(r) { return "var(--" + (RINGS_TEXT[r] ? r : "dim") + ")"; }
  // Every package named on this page links its page in the ring shown and the architecture read — the shell's one address.
  function pkgLink(n) { return '<a href="' + pkgHref(n, ring, arch) + '">' + esc(n) + '</a>'; }
  function isFactory() { return !!ST || !!(D && D.package.source === "factory"); }
  function blockedBy() { var p = ST && ST.package; return p && p.blocked_at ? p : null; }
  function targetsOf() { var t = ST && (ST.targets || (ST.package || {}).targets); return t && Object.keys(t).length ? t : null; }
  // Where an architecture is served: the rings, most stable first, from the package's answer (every architecture rides it), else the story's rings for a factory package no ring serves on this architecture.
  function servedOn(a) {
    var x = (D && D.arches) || (D404 && D404.arches);
    if (x && x[a]) return x[a].rings || [];
    return ((ST && ST.rings) || []).filter(function (r) { return r.arch === a; });
  }
  // The rings that promise something (the shell's PROMISED_RINGS, most stable first): the lab promises nothing. Above edge (PROMISED_UPWARD's first) a package went through a promotion's checks; the most stable ring took two green health checks in a row.
  function promised(rs) { return rs.filter(function (r) { return PROMISED_RINGS.indexOf(r.ring) >= 0; }); }
  function promoted(r) { return PROMISED_UPWARD.indexOf(r) > 0; }
  function inRing(a, r) { return servedOn(a).filter(function (x) { return x.ring === r; })[0] || null; }
  // Where the upstream is: the seal's project, or the source in words.
  function upstreamName() { var u = D && D.seal && D.seal.upstream; return (u && u.project) || "its upstream"; }
  function sourceWords(src, a) { return SOURCE_WORDS[src + "/" + a] || src || ""; }
  // The chain an architecture stands on: the one its target names, else its newest.
  function chainFor(a) {
    var cs = (ST && ST.chains) || [], t = (targetsOf() || {})[a], id = t && t.task;
    var mine = cs.filter(function (c) { return ((c.contributor || c.project || {}).arch) === a; });
    return (id && mine.filter(function (c) { return (c.contributor && c.contributor.id === id) || (c.project && c.project.id === id); })[0]) || mine[0] || null;
  }
  function archList() { var t = targetsOf(); return ARCHES.filter(function (a) { return !isFactory() || !t || t[a] || servedOn(a).length; }); }
  // The package's state, one word for the chip: blocked, in rings (a promised ring serves it), else where its targets stand.
  var STATE = { "in-rings": ["ok", "in rings"], building: ["run", "building"], "in-review": ["warn", "in review"], approved: ["ok", "approved"], blocked: ["fail", "blocked"], rejected: ["fail", "rejected"], requested: ["wait", "requested"], none: ["wait", "not in the pool"] };
  function stateOf() {
    if (blockedBy()) return "blocked";
    if (ARCHES.some(function (a) { return promised(servedOn(a)).length; })) return "in-rings";
    if (!ST) return D ? "in-rings" : "none";
    var ts = targetsOf() || {}, has = function (list) { return Object.keys(ts).some(function (a) { return list.indexOf(ts[a].status) >= 0; }); };
    if (has(["building"])) return "building";
    if (has(["built", "reviewing", "reviewed"])) return "in-review";
    if (has(["approved", "published"])) return "approved";
    return (ST.package || {}).status === "rejected" ? "rejected" : "requested";
  }
  function versionOf() {
    if (D) return D.package.version;
    var c = ((ST && ST.chains) || [])[0], b = c && (c.project || c.contributor);
    return (b && b.version) || (ST && ST.request && ST.request.version) || "";
  }

  // ---- the header: the mark, the version and the state, where it comes from, each architecture; the two pickers.
  function renderHead() {
    var fac = isFactory(), st = STATE[stateOf()], m = D ? D.manifest || {} : {}, pk = (ST && ST.package) || {};
    $("#pkg-mark").className = "op-box lg" + (fac ? " ok" : "");
    $("#pkg-mark").innerHTML = lucide(fac ? "hammer" : "package", 26);
    $("#pkg-ver").textContent = versionOf();
    $("#pkg-state").innerHTML = '<span class="op-pill ' + st[0] + '">' + esc(st[1]) + '</span>';
    var desc = m.description || pk.description || "";
    if (!D && !ST) desc = (D404 && D404.error) || "";
    $("#desc").innerHTML = esc(desc) + (!D && D404 ? otherArch() : "");
    var origin = fac ? '<span class="op-chip factory" title="built here from a contributor\'s request, built again by the project, decided by a maintainer">' + lucide("factory", 13) + 'factory · only in the pool</span>'
      : D ? '<span class="op-chip" title="synced from ' + esc(upstreamName()) + ', served as built and signed there">' + lucide("refresh-cw", 13) + 'synced · ' + esc(sourceWords(D.package.source, arch)) + '</span>' : "";
    $("#pkg-chips").innerHTML = origin + (targetsOf() ? targetChips(targetsOf()) : servedChips());
    // The two pickers: the rings (ringChips) and the architectures, each chip the package's one address; the ring shown and the architecture read lit.
    var shown = D ? D.shown_ring : null;
    $("#pg-ring").innerHTML = ringChips({ name: name, shown_ring: shown }, function (r) { return !!inRing(arch, r); });
    $("#pg-arch").innerHTML = ARCHES.map(function (a) { var on = a === arch, has = servedOn(a).length > 0 || !!(targetsOf() || {})[a]; return '<a class="' + (on ? "on" : "") + (has || on ? "" : " na") + '"' + (on ? ' aria-current="true"' : '') + ' href="' + pkgHref(name, shown || ring, a) + '">' + a + '</a>'; }).join("");
    var b = blockedBy(), box = $("#pkg-blocked");
    box.hidden = !b;
    if (b) box.innerHTML = lucide("octagon-x", 18) + '<div><b>Blocked by ' + esc(b.blocked_by || "a maintainer") + ' · ' + esc(ago(b.blocked_at)) + '</b><span>“' + esc(b.blocked_reason || "") + '”</span><span class="dim">Out of every ring and back in the factory. Another maintainer can lift the block.</span></div>';
  }
  // The ring chips: every ring, the lab included, the one the API shows lit, one that does not serve it on this architecture dashed; each is the package's one address in that ring.
  function ringChips(d, has) { return RINGS.map(function (r) { var on = r === d.shown_ring; return '<a class="' + r + (on ? " on" : "") + (has(r) || on ? "" : " na") + '" href="' + pkgHref(d.name, r, arch) + '"' + (on ? ' aria-current="true"' : '') + ' title="' + esc(has(r) ? r + " serves it on " + arch : "not in " + r + " on " + arch) + '">' + r + '</a>'; }).join(""); }
  // A synced package's architectures, as the targets' chips draw them: served, or not served on it.
  function servedChips() {
    if (!D && !D404) return "";
    return '<span class="tgts">' + ARCHES.map(function (a) { var rs = servedOn(a); return rs.length ? '<span class="pill tgt ok" title="' + esc(a + ": in " + rs.map(function (r) { return r.ring; }).join(", ")) + '">' + esc(a) + ' ✓</span>' : '<span class="pill tgt none dashed" title="' + esc(a + ": no ring serves it") + '">' + esc(a) + ' · not served</span>'; }).join("") + '</span>';
  }
  // Asked on an architecture that does not serve it: where it is, as links; a name nothing serves, the factory's request.
  function otherArch() {
    var elsewhere = ARCHES.filter(function (a) { return a !== arch && servedOn(a).length; });
    if (elsewhere.length) return (ST ? ' — not served on ' + esc(arch) + '. ' : ' ') + elsewhere.map(function (a) { return '<a href="' + pkgHref(name, servedOn(a)[0].ring, a) + '">Open it on ' + esc(a) + ' →</a>'; }).join(" ");
    return ST ? "" : ' <a href="/factory?name=' + encodeURIComponent(name) + '">Request ' + esc(name) + ' →</a>';
  }

  // ---- the five tiles, each a link to its section.
  function renderTiles() {
    var b = blockedBy(), row = D ? inRing(arch, D.shown_ring) : null, p = D ? D.package : null;
    var own = D ? ((D.security && D.security.advisories) || []).filter(function (a) { return a.status === "vulnerable"; }) : [], exp = D ? ((D.security && D.security.exposed) || []) : [];
    var rb = D ? (D.required_by || []).length : 0;
    var tiles = [
      ["tag", "Version", D ? p.version : "—", D ? D.shown_ring + (row ? " #" + row.release_seq : "") + " · " + arch : b ? "out of every ring" : "not in a ring yet", "", "#op-chain", "rings"],
      ["hard-drive", "Size", D ? bytes(p.size_download) : "—", D ? bytes(p.size_installed) + " installed" : "no object in a ring yet", "", "#files-section"],
      ["arrow-down-to-line", "Depends on", D ? num((D.depends || []).length) : "—", D ? "loads " + num((D.links || []).length) + " libraries" : "read from the object", "", "#deps-section"],
      ["arrow-up-from-line", "Required by", D ? num(rb) + (rb >= 400 ? "+" : "") : "—", D ? "in " + D.shown_ring : "in the ring that serves it", "", "#deps-section"],
      ["shield", "Security", b ? "blocked" : !D ? "—" : own.length ? num(own.length) + " open" : "clean", b ? "revoked from every ring" : !D ? "checked once a ring serves it" : exp.length + " via dependencies", b || own.length ? "fail-t" : D ? "ok-t" : "", "#sec-section"]
    ];
    $("#pg-tiles").innerHTML = tiles.map(function (t) { return '<a class="op-stat" href="' + t[5] + '"' + (t[6] ? ' data-stage="' + t[6] + '"' : '') + '><span class="k">' + lucide(t[0], 14) + esc(t[1]) + '</span><span class="n ' + t[4] + '" title="' + esc(t[2]) + '">' + esc(t[2]) + '</span><span class="s">' + esc(t[3]) + '</span></a>'; }).join("");
    // The two counts land (the kit's countUp: at once for a reader who asked for less motion).
    if (D) { var n = document.querySelectorAll("#pg-tiles .n"); countUp(n[2], (D.depends || []).length); countUp(n[3], rb, function (v) { return num(v) + (rb >= 400 ? "+" : ""); }); }
  }
  // The Version tile opens the Rings stage before it scrolls there.
  $("#pg-tiles").addEventListener("click", function (ev) { var a = ev.target.closest ? ev.target.closest("[data-stage]") : null; if (a) { STAGE = a.getAttribute("data-stage"); renderChain(); } });

  // ---- how it got here: four stages, each with its status per architecture, and the chosen one's panel.
  function stagesOf() {
    var fac = isFactory(), b = blockedBy(), ts = targetsOf() || {}, arches = archList();
    var sq = function (fn) { return ARCHES.map(function (a) { var r = fn(a); return square(r[0], a + ": " + r[1]); }).join(""); };
    var rs = ARCHES.map(function (a) { return promised(servedOn(a))[0]; }).filter(Boolean), top = rs[0];
    var ringsStage = b ? ["fail", "blocked · out of every ring", since(b.blocked_at)] : top ? ["ok", top.ring + " #" + top.release_seq, ""] : stateOf() === "approved" ? ["run", "publishing into edge", ""] : ["wait", "after approval", ""];
    if (!fac) {
      var u = upstreamName(), src = D ? sourceWords(D.package.source, arch) : "", built = D && D.manifest && D.manifest.pkginfo && D.manifest.pkginfo.builddate;
      return [
        { id: "source", icon: "download", label: "Upstream", tone: "ok", sum: src || u, when: built ? onDay(new Date(built * 1000).toISOString()).replace(/ \d{4}$/, "") : "" },
        { id: "build", icon: "hammer", label: "Build", tone: "ok", sum: "by " + u + " · verified here", archs: sq(function (a) { return servedOn(a).length ? ["ok", "served"] : ["na", "not served"]; }) },
        { id: "review", icon: "user-check", label: "Review", tone: "na", sum: "not needed · mirrored", dashed: true },
        { id: "rings", icon: "layers", label: "Rings", tone: ringsStage[0], sum: ringsStage[1], when: ringsStage[2] }
      ];
    }
    var req = (ST && ST.request) || {}, checks = req.checks || [], okN = checks.filter(function (c) { return c.ok; }).length, owner = (ST && ST.package && ST.package.owner) || "";
    var status = function (a) { return (ts[a] || {}).status || ""; };
    var anyT = function (list) { return arches.some(function (a) { return list.indexOf(status(a)) >= 0; }); };
    var buildTone = anyT(["building"]) ? "run" : anyT(["built", "reviewing", "reviewed", "approved", "published"]) ? "ok" : arches.length && arches.every(function (a) { return status(a) === "not_supported"; }) ? "fail" : "wait";
    var building = arches.filter(function (a) { return status(a) === "building"; })[0], ns = arches.filter(function (a) { return status(a) === "not_supported"; }), okA = arches.filter(function (a) { return ["built", "reviewing", "reviewed", "approved", "published"].indexOf(status(a)) >= 0; });
    var bc = building ? chainFor(building) : null;
    var buildSum = b && buildTone === "wait" ? "stopped by the block" : building ? building + " · try " + Math.max(1, ((bc && bc.contributor) || {}).attempts || 1) : okA.length && okA.length === ARCHES.length ? "both architectures" : okA.length ? okA.join(" · ") + " only" : ns.length ? "not supported" : "waiting for a worker";
    var decided = arches.map(chainFor).filter(function (c) { return c && c.approval; })[0], approval = decided ? decided.approval : null;
    var reviewTone = approval ? (approval.decision === "approved" ? "ok" : "fail") : anyT(["reviewing"]) ? "run" : anyT(["reviewed"]) ? "warn" : "wait";
    var reviewSum = b && !approval ? "withdrawn by the block" : approval ? "@" + approval.by + (approval.decision === "approved" ? " · rebuilt · approved" : " · " + approval.decision) : anyT(["reviewing"]) ? "the project builds it again" : anyT(["reviewed"]) ? "ready for a maintainer" : buildTone === "run" ? "waiting for builds" : "waiting for a maintainer";
    return [
      { id: "source", icon: "file-text", label: "Request", tone: req.complete ? "ok" : checks.length ? "fail" : "wait", sum: (owner ? "@" + owner + " · " : "") + okN + "/" + checks.length + " checks", when: onDay(req.created_at || ((ST && ST.package) || {}).created_at).replace(/ \d{4}$/, "") },
      { id: "build", icon: "hammer", label: "Factory build", tone: buildTone, sum: buildSum, archs: sq(function (a) { var s = status(a); return s === "building" ? ["run", "building"] : s === "not_supported" ? ["na", "not supported"] : ["built", "reviewing", "reviewed", "approved", "published"].indexOf(s) >= 0 ? ["ok", "built"] : s ? ["wait", s] : ["na", "not requested"]; }), when: since(((bc || chainFor(arches[0]) || {}).contributor || {}).finished_at) },
      { id: "review", icon: "user-check", label: "Review", tone: reviewTone, sum: reviewSum, archs: sq(function (a) { var s = status(a), c = chainFor(a); return s === "not_supported" ? ["na", "not supported"] : s === "reviewing" ? ["run", "the project builds it again"] : s === "reviewed" ? ["warn", "built again; the review decides"] : ["approved", "published"].indexOf(s) >= 0 ? ["ok", "approved"] : c && c.approval && c.approval.decision === "rejected" ? ["fail", "rejected"] : s ? ["wait", "not yet"] : ["na", "not requested"]; }), when: approval ? since(approval.created_at) : "" },
      { id: "rings", icon: "layers", label: "Rings", tone: ringsStage[0], sum: ringsStage[1], when: ringsStage[2] }
    ];
  }
  function defaultStage() { var s = stateOf(); return s === "building" ? "build" : s === "in-review" || s === "approved" ? "review" : s === "blocked" ? "rings" : "source"; }
  function renderChain() {
    var list = stagesOf(), fac = isFactory();
    if (!STAGE || !list.some(function (s) { return s.id === STAGE; })) STAGE = defaultStage();
    $("#chain-note").textContent = fac ? peopleCount() : "mirrored from " + upstreamName() + " · verified here";
    $("#stages").innerHTML = list.map(function (s) {
      var on = s.id === STAGE;
      return '<button type="button" role="tab" class="pkg-stage ' + s.tone + '" id="stage-' + s.id + '" aria-controls="stage-panel" aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '" data-stage="' + s.id + '"><span class="pkg-stage-t"><span><span class="op-box ' + (s.dashed ? "na" : "") + '">' + lucide(s.icon, 15) + '</span><b>' + esc(s.label) + '</b></span>' + (s.tone === "warn" ? '<b class="op-mark warn" title="waiting for a decision">⟳</b>' : mark(s.tone)) + '</span><span class="pkg-stage-s" title="' + esc(s.sum) + '">' + esc(s.sum) + '</span><span class="pkg-stage-a">' + (s.archs || "") + (s.when ? '<span>' + esc(s.when) + '</span>' : '') + '</span></button>';
    }).join("");
    $("#stage-panel").setAttribute("aria-labelledby", "stage-" + STAGE);
    $("#stage-panel").innerHTML = panelOf(STAGE);
    if (STAGE === "review") loadRecipes();
  }
  $("#stages").addEventListener("click", function (ev) { var b = ev.target.closest ? ev.target.closest("[data-stage]") : null; if (b) { STAGE = b.getAttribute("data-stage"); renderChain(); $("#stage-" + STAGE).focus(); } });
  // The arrow keys move along the stages, as a tab list does.
  $("#stages").addEventListener("keydown", function (ev) {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    var ids = stagesOf().map(function (s) { return s.id; }), i = ids.indexOf(STAGE);
    STAGE = ids[(i + (ev.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length]; renderChain(); $("#stage-" + STAGE).focus(); ev.preventDefault();
  });
  function peopleCount() {
    var logins = {}, agents = {};
    var pk = (ST && ST.package) || {}; if (pk.owner) logins[pk.owner] = 1;
    ((ST && ST.chains) || []).forEach(function (c) { if (c.approval) logins[c.approval.by] = 1; var au = c.audit && c.audit.result && c.audit.result.model; if (au) agents[au] = 1; });
    var sb = D && D.seal && D.seal.chain && D.seal.chain.source_build; if (sb && sb.agent) agents[sb.agent] = 1;
    var np = Object.keys(logins).length, na = Object.keys(agents).length;
    return np + (np === 1 ? " person" : " people") + (na ? " · " + na + (na === 1 ? " agent" : " agents") : "") + " · every step on the record";
  }

  // ---- a stage's panel: a title and its tag, who, fields, a checklist, a matrix per architecture, the recipe diff, the rings and what happened, a note, links.
  function panel(o) {
    var h = '<div class="pkg-ph"><span><b>' + esc(o.title) + '</b><span class="op-pill ' + o.tone + '">' + esc(o.tag) + '</span></span>' + (o.who && o.who.length ? '<span class="pkg-who">' + o.who.join("") + '</span>' : '') + '</div>';
    if (o.fields && o.fields.length) h += '<div class="pkg-fields">' + o.fields.map(function (f) { return '<div class="pkg-field">' + lucide(f[0], 15) + '<div><span class="op-label">' + esc(f[1]) + '</span><span class="v">' + f[2] + '</span></div></div>'; }).join("") + '</div>';
    if (o.rows && o.rows.length) h += '<div class="pkg-sub"><span class="op-label">' + esc(o.rowsTitle) + '</span><div class="pkg-rows">' + o.rows.map(function (r) { return '<div class="pkg-row">' + mark(r[0], r[2]) + '<span>' + r[1] + '</span></div>'; }).join("") + '</div></div>';
    if (o.mx) h += '<div class="pkg-sub"><span class="op-label">' + esc(o.mx.title) + '</span><div class="pkg-mx"><div><span>check</span>' + o.mx.cols.map(function (c) { return '<span class="' + c[1] + '">' + esc(c[0]) + '</span>'; }).join("") + '</div>' + o.mx.rows.map(function (r) { return '<div><span>' + esc(r[0]) + '</span>' + r[1].map(function (c) { return '<span>' + mark(c[0], c[2] || c[1]) + (c[1] ? '<small>' + esc(c[1]) + '</small>' : '') + '</span>'; }).join("") + '</div>'; }).join("") + (o.mx.foot || []).map(function (r) { return '<div class="foot"><span>' + esc(r[0]) + '</span>' + r[1].map(function (c) { return '<span>' + esc(c) + '</span>'; }).join("") + '</div>'; }).join("") + '</div></div>';
    if (o.diff) h += '<div class="pkg-sub" id="recipe-diff">' + o.diff + '</div>';
    if (o.rings) h += o.rings;
    if (o.note) h += '<div class="pkg-note">' + lucide("info", 14) + '<span>' + o.note + '</span></div>';
    if (o.links && o.links.length) h += '<div class="pkg-links">' + o.links.map(function (l) { return '<a href="' + esc(l[2]) + '">' + lucide(l[0], 13) + esc(l[1]) + '</a>'; }).join("") + '</div>';
    return h;
  }
  function whoChip(role, login) { return '<span class="pkg-whoc">' + avatar(login) + '<span class="r">' + esc(role) + '</span>' + esc(login) + '</span>'; }
  function glyphChip(role, label, kind, ini) { return '<span class="pkg-whoc">' + glyph(label, kind, ini) + '<span class="r">' + esc(role) + '</span>' + esc(label) + '</span>'; }
  // An agent's mark from its name (claude-code, gpt-5, gemini …), or its initials; the pool's square; anyone else's initials.
  function markOf(agent) { var s = String(agent || "").toLowerCase(); return /claude|anthropic/.test(s) ? "claude-color" : /gpt|openai|codex/.test(s) ? "openai" : /gemini/.test(s) ? "gemini-color" : /grok|xai/.test(s) ? "grok" : /qwen/.test(s) ? "qwen-color" : /kimi/.test(s) ? "kimi" : /cursor/.test(s) ? "cursor" : /copilot/.test(s) ? "githubcopilot" : /opencode/.test(s) ? "opencode" : /llama|meta/.test(s) ? "meta-color" : null; }
  function glyph(label, kind, ini) {
    if (kind === "agent" && markOf(label)) return '<span class="pkg-glyph agent">' + agentMark(markOf(label), label, 14) + '</span>';
    return '<span class="pkg-glyph ' + (kind || "") + '" title="' + esc(label) + '">' + esc(ini || String(label || "?").slice(0, 2).toUpperCase()) + '</span>';
  }
  function panelOf(id) {
    var fac = isFactory();
    if (id === "source") return fac ? requestPanel() : upstreamPanel();
    if (id === "build") return fac ? buildPanel() : syncedBuildPanel();
    if (id === "review") return fac ? reviewPanel() : panel({ title: "Review", tag: "not needed", tone: "na", who: [glyphChip("agents", "none", "", "—")], note: "Mirrored as " + esc(upstreamName()) + " publishes it, its signature checked on the way in. Agents only work in the factory: a synced package is never rebuilt, so there is no build to review." });
    return ringsPanel();
  }
  function requestPanel() {
    var req = (ST && ST.request) || {}, pk = (ST && ST.package) || {}, checks = req.checks || [];
    var proj = pk.project || pk.url || "";
    return panel({
      title: "The request", tag: req.complete ? "checked" : "incomplete", tone: req.complete ? "ok" : "warn",
      who: pk.owner ? [whoChip("by", pk.owner)] : [],
      fields: [
        ["package", "name", esc(name) + (pk.status === "rejected" && !blockedBy() ? "" : " · reserved")],
        [/github\.com/.test(proj) ? "github" : "globe", "source", proj ? '<a href="' + esc(proj) + '">' + esc(proj.replace(/^https?:\/\/(www\.)?/, "")) + '</a>' : "—"],
        ["scale", "licence", esc(pk.license || "—")],
        ["cpu", "architectures", esc((req.arches && req.arches.length ? req.arches : pk.arches || []).join(" · ") || "—")],
        ["tag", "release", esc(req.version || "—")],
        ["calendar", "sent", esc(onDay(req.created_at || pk.created_at))]
      ],
      rowsTitle: "Checked when it was sent" + (req.id ? " · request #" + req.id : ""),
      rows: checks.map(function (c) { return [c.ok ? "ok" : "fail", esc(c.item) + (c.note ? ' <span class="dim">· ' + esc(c.note) + '</span>' : ''), c.ok ? "done" : "to put right"]; }),
      // A request that came back — rejected, or no architecture built — says why, in the server's words.
      note: pk.detail && !blockedBy() && ["registered", "rejected", "unmaintained"].indexOf(pk.status) >= 0 ? "Back with its requester: " + esc(pk.detail) : "",
      links: [req.record ? ["file-json", "request.json", req.record] : null, req.signature ? ["key-round", "its signature", req.signature] : null, pk.owner ? ["user", pk.owner + "'s page", userHref(pk.owner)] : null].filter(Boolean)
    });
  }
  function upstreamPanel() {
    if (!D) return panel({ title: "Upstream", tag: "not served", tone: "wait", note: "No ring serves " + esc(name) + " on " + esc(arch) + "." });
    var m = D.manifest || {}, pi = m.pkginfo || {}, seal = D.seal || {}, up = seal.upstream || {}, pv = D.provenance;
    var rows = [
      [up.verified ? "ok" : "fail", up.verified ? "Signature checked against the " + esc(up.keyring) + " keyring" : "No upstream signature stored for this object", ""],
      ["ok", "Stored once, served as built — never rebuilt", ""],
      ["ok", "Entered the pool " + esc(onDay(seal.indexed_at)), ""]
    ];
    if (pv) rows.push([pv.source === "local" ? "ok" : pv.source === "aur" ? "warn" : "wait", (pv.source === "aur" ? "AUR-synced recipe" + (pv.upstream_commit ? ' tracking <a href="' + esc(pv.aur) + '">' + esc(pv.upstream_commit.slice(0, 7)) + '</a>' : '') : pv.source === "local" ? "Omarchy's own recipe" : "Recipe of unknown origin") + ' in <a href="' + esc(pv.pkgbuild) + '">omarchy-pkgs</a>' + (pv.pkgbuild_commit ? ', last changed ' + esc(pv.pkgbuild_commit.slice(0, 7)) + ' ' + esc(ago(pv.pkgbuild_committed_at)) : '') + (pv.release_ring === "fast" ? ' · built natively for every channel' : '') + (pv.pinned ? ' · version pinned per release' : ''), ""]);
    return panel({
      title: "Upstream", tag: "imported", tone: "ok",
      who: [pi.packager ? glyphChip("packaged by", pi.packager.replace(/<.*>/, "").trim()) : glyphChip("packaged by", upstreamName()), glyphChip("mirrored by", "the pool", "pool", "▣")],
      fields: [
        ["database", "repository", esc(upstreamName()) + " · " + esc(D.package.source)],
        ["globe", "project", m.url ? '<a href="' + esc(m.url) + '">' + esc(m.url.replace(/^https?:\/\//, "")) + '</a>' : "—"],
        ["scale", "licence", esc((m.licenses || []).join(", ") || "—")],
        ["calendar", "built", pi.builddate ? esc(new Date(pi.builddate * 1000).toISOString().slice(0, 10)) : "—"]
      ].concat(pi.base && pi.base !== D.name ? [["package", "base", pkgLink(pi.base)]] : []),
      rowsTitle: "Verified when it entered the pool", rows: rows,
      links: [["file-archive", D.package.filename, D.pool_url]].concat(up.signature ? [["key-round", ".sig", up.signature]] : [])
    });
  }
  // The gate's checks a row stands for, by the names vet_package writes (the build worker's gate): failed, warned, passed, or not run.
  function gateMark(b, keys) {
    var v = b && b.result && b.result.vet;
    if (!b) return ["na", "", "no build"];
    if (!v) return b.status === "failed" ? ["na", "", "the build did not get that far"] : ["wait", "", "not run yet"];
    var hit = function (list) { return (list || []).filter(function (n) { return keys.some(function (k) { return n === k || n.indexOf(k + ":") === 0; }); }); };
    var f = hit(v.failed), w = hit(v.warned);
    return f.length ? ["fail", "failed", f.join(", ")] : w.length ? ["warn", "warning", w.join(", ")] : ["ok", "", "passed"];
  }
  function buildMark(b) {
    if (!b) return ["na", "", "no build"];
    if (b.status === "queued") return ["wait", "queued", "waiting for a worker"];
    if (b.status === "leased" || b.status === "building") return ["run", "try " + Math.max(1, b.attempts || 1), "building"];
    if (b.status === "staged" || b.status === "done") return ["ok", "", "built"];
    if (b.status === "failed") return ["fail", (b.attempts || 1) + (b.attempts === 1 ? " try" : " tries"), b.error || "failed"];
    return ["na", b.status, b.status];
  }
  function colsOf() { var ts = targetsOf() || {}; return ARCHES.map(function (a) { var s = (ts[a] || {}).status; return s === "not_supported" ? [a + " · not supported", "dim-t"] : !isFactory() || ts[a] || servedOn(a).length ? [a, "ok-t"] : [a + " · not requested", "dim-t"]; }); }
  function buildPanel() {
    var cs = ARCHES.map(chainFor), bs = cs.map(function (c) { return c && c.contributor; });
    var ts = targetsOf() || {}, anyRun = bs.some(function (b) { return b && (b.status === "leased" || b.status === "queued"); }), anyOk = bs.some(function (b) { return b && (b.status === "staged" || b.status === "done"); });
    var agent = D && D.seal && D.seal.chain && D.seal.chain.source_build && D.seal.chain.source_build.agent;
    var au = cs.map(function (c) { return c && c.audit; });
    var rows = [
      ["Built in a clean container", bs.map(buildMark)],
      ["Sources pinned by checksum", bs.map(function (b) { return gateMark(b, ["checksums"]); })],
      ["The recipe lints clean", bs.map(function (b) { return gateMark(b, ["shellcheck", "namcap-pkgbuild"]); })],
      ["namcap clean on the package", bs.map(function (b) { return gateMark(b, ["namcap-package", "namcap-libmap"]); })],
      ["Files and metadata in order", bs.map(function (b) { return gateMark(b, ["files", "metadata", "prebuilt-debug"]); })],
      ["The upstream tests run", bs.map(function (b) { return gateMark(b, ["check"]); })],
      ["Installs and starts with a real pacman", bs.map(function (b) { return gateMark(b, ["smoke"]); })],
      ["Audited by a second agent", au.map(function (a, i) { if (!bs[i]) return ["na", "", "no build"]; if (!a) return ["wait", "", "not queued yet"]; var v = a.result && a.result.verdict; return a.status !== "done" ? ["run", a.status, "the audit is " + a.status] : v === "ok" || v === "pass" ? ["ok", "", (a.result && a.result.summary) || "ok"] : v === "fail" || v === "block" ? ["fail", v, (a.result && a.result.summary) || v] : ["warn", v || "done", (a.result && a.result.summary) || ""]; })]
    ];
    var notes = ARCHES.filter(function (a, i) { return (ts[a] || {}).status === "not_supported" || (bs[i] && bs[i].status === "failed"); }).map(function (a) { var b = bs[ARCHES.indexOf(a)]; return esc(a) + (ts[a] && ts[a].status === "not_supported" ? " did not build after the tries it had, so it is not supported; the other architectures go on to the review" : " failed") + (b && b.error ? ': “' + esc(b.error.slice(0, 240)) + '”' : '') + '.'; });
    return panel({
      title: "Factory build", tag: anyRun ? "running" : anyOk ? "ready" : bs.some(Boolean) ? "not built" : "waiting", tone: anyRun ? "run" : anyOk ? "ok" : bs.some(Boolean) ? "fail" : "wait",
      who: (agent ? [glyphChip("built by", agent, "agent")] : []).concat(bs.filter(Boolean).map(function (b) { return glyphChip("on", wtShort(b.lease_owner || "a worker"), "", "W"); })),
      mx: { title: "The same checks on every architecture", cols: colsOf(), rows: rows, foot: [["tries", bs.map(function (b) { return b ? String(b.attempts || 0) : "—"; })], ["time", bs.map(function (b) { return b ? (b.status === "leased" ? "running" : dur(b.duration_ms) || "—") : "—"; })], ["worker", bs.map(function (b) { return b && b.lease_owner ? wtShort(b.lease_owner) : "—"; })]] },
      note: notes.length ? notes.join(" ") : !bs.some(Boolean) ? "Nothing built yet: the request waits for a worker of its architecture." : "",
      links: ARCHES.map(function (a, i) { return bs[i] ? ["scroll-text", a + " · build #" + bs[i].id, evidenceHref(bs[i].id)] : null; }).filter(Boolean)
    });
  }
  function syncedBuildPanel() {
    if (!D) return panel({ title: "Build", tag: "not served", tone: "wait", note: "No ring serves " + esc(name) + " on " + esc(arch) + "." });
    var u = upstreamName();
    var per = function (fn) { return ARCHES.map(function (a) { var rs = servedOn(a); return rs.length ? fn(a, rs) : ["na", "", "not served on " + a]; }); };
    return panel({
      title: "Build", tag: "verified", tone: "ok",
      who: [glyphChip("built by", u), glyphChip("verified by", "the pool", "pool", "▣")],
      mx: { title: "What the pool checks on every architecture", cols: ARCHES.map(function (a) { return [servedOn(a).length ? a : a + " · not served", servedOn(a).length ? "ok-t" : "dim-t"]; }), rows: [
        ["Built and signed upstream", per(function () { return ["na", "upstream", "built by " + u + ", not here"]; })],
        ["Upstream signature verified", per(function (a, rs) { return rs[0].has_signature === false ? ["fail", "none", "no upstream signature"] : ["ok", "", "checked against the keyring on import"]; })],
        ["Stored once, served as built", per(function () { return ["ok", "", "one object, the same bytes in every ring"]; })],
        ["Health and ABI checks on promotion", per(function (a, rs) { var p = rs.filter(function (r) { return promoted(r.ring); })[0]; return p ? ["ok", "", "passed on its way into " + p.ring] : ["wait", rs[0].ring, "checked when it is promoted out of " + PROMISED_UPWARD[0]]; })],
        ["Two green health checks in " + PROMISED_RINGS[0], per(function (a, rs) { return rs.some(function (r) { return r.ring === PROMISED_RINGS[0]; }) ? ["ok", "", "in " + PROMISED_RINGS[0]] : ["wait", "", "not in " + PROMISED_RINGS[0] + " yet"]; })]
      ] },
      note: "Built and signed by " + esc(u) + ". The pool never rebuilds a synced package: it checks the signature, stores the file once and promotes it on evidence. <a href=\"/docs/how-it-works\">How a package gets in ›</a>"
    });
  }
  function reviewPanel() {
    var cs = ARCHES.map(chainFor), ps = cs.map(function (c) { return c && c.project; }), owner = (ST && ST.package && ST.package.owner) || "";
    var decided = cs.filter(function (c) { return c && (c.approval || c.withdrawn); })[0], ap = decided && (decided.approval || decided.withdrawn);
    if (!ps.some(Boolean) && !ap) return panel({ title: "Review", tag: "waiting", tone: "wait", note: "Starts once every architecture is built or not supported. A maintainer who did not request the package has the project build it again on a trusted worker, then decides; " + (owner ? esc(owner) + " can never review their own request." : "nobody reviews their own request.") });
    var trials = cs.map(function (c) { return c && c.trial; }), pubs = cs.map(function (c) { return c && c.publish; }), audit = cs.map(function (c) { return c && c.audit; }).filter(Boolean)[0];
    var tone = ap ? (ap.withdrawn_at ? "na" : ap.decision === "approved" ? "ok" : "fail") : ps.some(function (p) { return p && (p.status === "leased" || p.status === "queued"); }) ? "run" : "warn";
    var tag = ap ? (ap.withdrawn_at ? "withdrawn" : ap.decision) : tone === "run" ? "rebuilding" : "in progress";
    var trialMark = function (t, i) { if (!ps[i]) return ["na", "", "no project build"]; if (!t) return ["wait", "", "not tried yet"]; var v = t.result && t.result.verdict; return t.status !== "done" ? ["run", t.status, "the trial is " + t.status] : v === "ok" ? ["ok", "", "a real pacman installed it in the lab"] : ["fail", v || "failed", "the trial did not install it"]; };
    var decideMark = function (c) { var a = c && (c.approval || c.withdrawn); if (!a) return c && c.project ? ["wait", "", "waiting for a maintainer"] : ["na", "", "no project build"]; return a.withdrawn_at ? ["na", "withdrawn", a.withdrawn_reason || "withdrawn"] : a.decision === "approved" ? ["ok", "", "approved by " + a.by] : ["fail", a.decision, a.note || a.decision]; };
    var rows = [
      [ap ? "ok" : "wait", ap ? esc(ap.by) + " did not request it" : "A maintainer other than " + esc(owner || "the requester") + " decides", ""],
      [ps.some(function (p) { return p && (p.status === "staged" || p.status === "done"); }) ? "ok" : ps.some(Boolean) ? "run" : "wait", "Built again from the recipe on a trusted worker; the contributor's bytes never ship", ""],
      audit ? [audit.status !== "done" ? "run" : ["ok", "pass"].indexOf((audit.result || {}).verdict) >= 0 ? "ok" : "warn", "Audit: " + esc(((audit.result || {}).verdict || audit.status)) + ((audit.result || {}).summary ? ' <span class="dim">· ' + esc(audit.result.summary) + '</span>' : ''), ""] : ["wait", "Audit by a second agent", ""],
      [trials.some(function (t) { return t && t.result && t.result.verdict === "ok"; }) ? "ok" : trials.some(Boolean) ? "run" : "wait", "Tried in the lab by a real pacman", ""],
      [ap ? (ap.withdrawn_at ? "na" : ap.decision === "approved" ? "ok" : "fail") : "wait", "Verdict: " + (ap ? esc(ap.withdrawn_at ? "withdrawn" : ap.decision) + (ap.note ? ' <span class="dim">· “' + esc(ap.note) + '”</span>' : '') : "pending"), ""]
    ];
    var diff = RECIPES.html || (cs.some(function (c) { return c && c.recipes && c.recipes.contributor && c.recipes.project; }) ? '<span class="op-label">Recipe vs the factory</span><p class="pkg-small">Reading the two recipes…</p>' : "");
    var agentOf = audit && audit.result && audit.result.model;
    return panel({
      title: "Independent review", tag: tag, tone: tone,
      who: (ap ? [whoChip("by", ap.by)] : []).concat(agentOf ? [glyphChip("audited with", agentOf, "agent")] : []),
      rowsTitle: "Reviewer checklist", rows: rows,
      mx: { title: "Built again on a project worker", cols: colsOf(), rows: [
        ["Built again by the project", ps.map(buildMark)],
        ["The project's gate", ps.map(function (p) { var v = p && p.result && p.result.vet; return !p ? ["na", "", "no project build"] : !v ? ["wait", "", "not run yet"] : v.verdict === "fail" ? ["fail", "failed", (v.failed || []).join(", ")] : v.warnings ? ["warn", v.warnings + " warning" + (v.warnings > 1 ? "s" : ""), (v.warned || []).join(", ")] : ["ok", "", "clean"]; })],
        ["Installed in the lab by a real pacman", trials.map(trialMark)],
        ["Decided", cs.map(decideMark)]
      ], foot: [["time", ps.map(function (p) { return p ? (p.status === "leased" ? "running" : dur(p.duration_ms) || "—") : "—"; })], ["worker", ps.map(function (p) { return p && p.lease_owner ? wtShort(p.lease_owner) : "—"; })], ["result", pubs.map(function (p, i) { return p ? (p.status === "done" ? "published" : p.status) : ps[i] && ps[i].status === "staged" ? "in the lab" : "—"; })]] },
      diff: diff,
      note: ap && ap.decision === "approved" && !ap.withdrawn_at ? "Approved" + (ap.note ? ": “" + esc(ap.note) + "”" : "") + ". The project's build, not the contributor's, is the one that ships." : ap && ap.withdrawn_at ? "Withdrawn by " + esc(ap.withdrawn_by || "a maintainer") + (ap.withdrawn_reason ? ": “" + esc(ap.withdrawn_reason) + "”" : "") + ". It is void from then on; another review decides." : "The project's build, not the contributor's, is the one that ships.",
      links: ARCHES.map(function (a, i) { return ps[i] ? ["scroll-text", a + " · review build #" + ps[i].id, evidenceHref(ps[i].id)] : null; }).filter(Boolean)
    });
  }
  // The two recipes of a review, read once when the Review stage opens: the contributor's and the project's, by the addresses the story gives, and the lines between them.
  function loadRecipes() {
    if (RECIPES.asked) return;
    var c = ARCHES.map(chainFor).filter(function (x) { return x && x.recipes && x.recipes.contributor && x.recipes.project; })[0];
    if (!c) return;
    RECIPES.asked = true;
    var text = function (u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); }); };
    Promise.all([text(c.recipes.contributor), text(c.recipes.project)]).then(function (two) { RECIPES.html = diffHtml(two[0], two[1]); }, function () { RECIPES.html = '<span class="op-label">Recipe vs the factory</span><p class="pkg-small">The two recipes are no longer in staging; the build pages keep what is on the record.</p>'; }).then(function () { var el = $("#recipe-diff"); if (el) el.innerHTML = RECIPES.html; });
  }
  // A line diff (the longest common subsequence of two short files): the changed lines, one line of context around each change.
  function diffHtml(a, b) {
    var x = a.replace(/\n$/, "").split("\n"), y = b.replace(/\n$/, "").split("\n");
    if (x.length * y.length > 250000) return '<span class="op-label">Recipe vs the factory</span><p class="pkg-small">Too long to compare here; the build pages show both.</p>';
    var n = x.length, m = y.length, L = [], i, j;
    for (i = 0; i <= n; i++) { L.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    var out = [];
    for (i = 0, j = 0; i < n || j < m;) {
      if (i < n && j < m && x[i] === y[j]) { out.push([" ", x[i]]); i++; j++; }
      else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { out.push(["+", y[j]]); j++; }
      else { out.push(["-", x[i]]); i++; }
    }
    var changed = out.filter(function (l) { return l[0] !== " "; }).length;
    if (!changed) return '<span class="op-label">' + lucide("git-compare", 14) + ' Recipe vs the factory · the same</span><p class="pkg-small">The project\'s agent wrote the recipe again and it came out line for line the same.</p>';
    var keep = out.map(function (l, k) { return l[0] !== " " || (out[k - 1] && out[k - 1][0] !== " ") || (out[k + 1] && out[k + 1][0] !== " "); }), lines = [], gap = false;
    out.forEach(function (l, k) { if (keep[k]) { lines.push('<div class="' + (l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx") + '">' + esc(l[0] + " " + l[1]) + '</div>'); gap = false; } else if (!gap) { lines.push('<div class="gap">  …</div>'); gap = true; } });
    return '<span class="op-label">' + lucide("git-compare", 14) + ' Recipe vs the factory · ' + changed + ' line' + (changed > 1 ? "s" : "") + '</span><div class="pkg-diff">' + lines.join("") + '</div>';
  }
  function ringsPanel() {
    var b = blockedBy(), served = ARCHES.some(function (a) { return servedOn(a).length; });
    var head = '<thead><tr><th>ring</th>' + ARCHES.map(function (a) { return '<th>' + esc(a) + '</th>'; }).join("") + '<th class="num">#</th></tr></thead>';
    var body = RINGS.map(function (r) {
      var cells = ARCHES.map(function (a) { var x = inRing(a, r); return b ? '<td class="dim">' + (x ? "removed" : "—") + '</td>' : x && x.version ? '<td title="' + esc((x.source || "") + (x.sha256 ? " · sha256 " + x.sha256 : "") + (x.size_download ? " · " + bytes(x.size_download) : "")) + '">' + esc(x.version) + '</td>' : x ? '<td>✓</td>' : '<td class="dim">—</td>'; }).join("");
      var mine = inRing(arch, r);
      return '<tr' + (D && r === D.shown_ring ? ' class="on"' : '') + '><td><a href="' + pkgHref(name, r, arch) + '" style="color:' + hue(r) + '">' + r + '</a></td>' + cells + '<td class="num dim">' + (mine && mine.release_seq ? "#" + mine.release_seq : "") + '</td></tr>';
    }).join("");
    var tl = timeline();
    var rings = '<div class="pkg-rings"><div class="pkg-rt"><table class="op-table">' + head + '<tbody>' + body + '</tbody></table></div><div class="pkg-tl"><span class="op-label">On the record</span>' + (tl.length ? tl.map(function (e) { return '<div><span class="w">' + esc(e[0]) + '</span><span class="sq" style="color:' + e[1] + '"></span><span class="t" title="' + esc(e[2] + " " + e[3]) + '"><b style="color:' + e[1] + '">' + esc(e[2]) + '</b><span>' + esc(e[3]) + '</span></span></div>'; }).join("") : '<p class="pkg-small">Nothing yet.</p>') + '</div></div>';
    return panel({
      title: "In the rings", tag: b ? "blocked" : served ? "live" : "not yet", tone: b ? "fail" : served ? "ok" : "wait", rings: rings,
      note: b ? "A block withdraws the approval and takes the package out of every ring, on every architecture; it goes back to the factory. Another maintainer lifts it." : served ? "A ring moves up only on evidence: health and ABI checks on both architectures. The same sha256 in two rings is the very same file. <a href=\"/docs/how-it-works\">How it works ›</a>" : "Not in any ring yet. It enters edge once a maintainer approves it."
    });
  }
  // What happened to the package, as the record has it: the request, the decision, the publish, the rings that serve it now, the block.
  function timeline() {
    var out = [], pk = (ST && ST.package) || {}, req = (ST && ST.request) || {};
    if (isFactory()) {
      if (req.created_at || pk.created_at) out.push([since(req.created_at || pk.created_at), "var(--dim)", "requested", pk.owner ? "by " + pk.owner : ""]);
      ARCHES.map(chainFor).filter(function (c, i, all) { return c && all.indexOf(c) === i; }).forEach(function (c) {
        var a = c.approval || c.withdrawn; if (a) out.push([since(a.created_at), a.decision === "approved" ? "var(--green)" : "var(--red)", a.decision, "by " + a.by + " · " + (c.project || c.contributor || {}).arch]);
        if (c.publish && c.publish.status === "done") out.push([since(c.publish.finished_at), "var(--edge)", "entered edge", "publish job #" + c.publish.id + " · " + c.publish.arch]);
      });
    } else if (D && D.seal) out.push([since(D.seal.indexed_at), "var(--dim)", "entered the pool", "synced from " + sourceWords(D.package.source, arch)]);
    var b = blockedBy();
    if (!b) PROMISED_UPWARD.forEach(function (r) { var x = inRing(arch, r); if (x) out.push(["now", hue(r), "in " + r, x.release_seq ? "release #" + x.release_seq : arch]); });
    else out.push([since(b.blocked_at), "var(--red)", "blocked", "out of every ring"]);
    return out;
  }

  // ---- security: the version itself, then what it loads — grouped by the dependency it comes through, one square per advisory in its severity's colour.
  function advItem(a, match) { return '<li><span class="sev" style="color:' + (SEV_COLOR[a.severity] || "var(--dim)") + '">' + esc(a.severity) + '</span><a href="' + esc(a.url) + '">' + esc((a.cves || []).join(", ") || a.id) + '</a><span class="dim" title="how sure the match is — Security explains the three words">' + esc(match || a.match) + (a.fixed ? ' · fixed in ' + esc(a.fixed) : '') + (a.kev ? ' · <span style="color:' + SEV_COLOR.exploited + '">exploited in the wild</span>' : '') + (a.epss != null && a.epss >= 0.1 ? ' · EPSS ' + (a.epss * 100).toFixed(0) + '%' : '') + '</span></li>'; }
  function renderSecurity() {
    var b = blockedBy(), own = $("#sec-own"), exp = $("#sec-exposed");
    if (!D) {
      $("#sec-icon").className = "pkg-h" + (b ? " fail-t" : "");
      own.innerHTML = '<span class="op-label">On this version</span><b class="big ' + (b ? "fail-t" : "dim-t") + '">' + (b ? "blocked" : "—") + '</b><span>' + (b ? "revoked from every ring" : "matched once a ring serves it") + '</span>';
      exp.innerHTML = '<p>Advisories are matched against what the rings serve; no ring serves ' + esc(name) + ' on ' + esc(arch) + ' yet.</p>';
      return;
    }
    var s = D.security || { advisories: [], exposed: [] }, open = s.advisories.filter(function (a) { return a.status === "vulnerable"; }), fixed = s.advisories.length - open.length;
    var tone = b || open.length ? "fail-t" : "ok-t";
    $("#sec-icon").className = "pkg-h " + tone;
    own.innerHTML = '<span class="op-label">On this version</span><b class="big ' + tone + '">' + (open.length ? num(open.length) + " open" : "clean") + '</b><span>' + (fixed ? num(fixed) + " advisor" + (fixed > 1 ? "ies" : "y") + " fixed in this version" : open.length ? "on " + esc(D.package.version) : "no advisory open on this version") + '</span>';
    // The version's own open advisories lead the list, open: the same row a dependency's has.
    var mine = open.length ? '<details class="pkg-adv" open><summary><b>' + esc(D.name) + '</b><span class="via">this version · ' + esc(D.package.version) + '</span><span class="dots">' + open.map(function (a) { return '<i style="color:' + (SEV_COLOR[a.severity] || "var(--dim)") + '" title="' + esc(a.severity) + '"></i>'; }).join("") + '</span></summary><ul>' + open.map(function (a) { return advItem(a); }).join("") + '</ul></details>' : '';
    var groups = {}, order = [];
    s.exposed.forEach(function (e) { if (!groups[e.via]) { groups[e.via] = { via: e.via, how: (e.declared ? "declared" : "") + (e.declared && e.sonames.length ? " + " : "") + (e.sonames.length ? "loads " + e.sonames.join(", ") : ""), items: [] }; order.push(e.via); } groups[e.via].items.push(e.advisory); });
    var sevs = {}; s.exposed.forEach(function (e) { sevs[e.advisory.severity] = (sevs[e.advisory.severity] || 0) + 1; });
    exp.innerHTML = mine + '<div class="pkg-sech"><span class="op-label">Through its dependencies · ' + num(s.exposed.length) + '</span><span class="pkg-sevs">' + SEVERITIES.filter(function (k) { return sevs[k]; }).map(function (k) { return '<span style="color:' + (SEV_COLOR[k] || "var(--dim)") + '"><i class="pkg-sq"></i>' + sevs[k] + ' ' + esc(k) + '</span>'; }).join("") + '</span></div>' +
      (order.length ? order.map(function (v) { var g = groups[v]; return '<details class="pkg-adv"><summary><b>' + esc(v) + '</b><span class="via">' + esc(g.how) + '</span><span class="dots">' + g.items.map(function (a) { return '<i style="color:' + (SEV_COLOR[a.severity] || "var(--dim)") + '" title="' + esc(a.severity + " · " + (a.cves || []).join(", ")) + '"></i>'; }).join("") + '</span></summary><ul>' + g.items.map(function (a) { return advItem(a); }).join("") + '<li><a href="' + pkgHref(v, ring, arch) + '">' + esc(v) + '’s page →</a></li></ul></details>'; }).join("") : '<p>Nothing open on anything it depends on or loads.</p>');
  }

  // ---- the dependencies: what requires it on the left, what it declares and loads on the right, connected; the rest in full below.
  function renderDeps() {
    var el = $("#deps");
    if (!D) { el.innerHTML = '<p class="pkg-small" style="margin:0">The graph is drawn from the object a ring serves; no ring serves ' + esc(name) + ' on ' + esc(arch) + ' yet.</p>'; return; }
    var vuln = {}; ((D.security && D.security.exposed) || []).forEach(function (e) { vuln[e.via] = (vuln[e.via] || 0) + 1; });
    var right = {}, order = [];
    (D.depends || []).forEach(function (x) { var k = x.provider ? x.provider.name : x.name; if (!right[k]) { right[k] = { name: k, version: x.provider ? x.provider.version : "", provided: !!x.provider, declared: false, sonames: [] }; order.push(k); } right[k].declared = true; });
    (D.links || []).forEach(function (x) { var k = x.provider ? x.provider.name : x.soname; if (!right[k]) { right[k] = { name: k, version: x.provider ? x.provider.version : "", provided: !!x.provider, declared: false, sonames: [] }; order.push(k); } right[k].sonames.push(x.soname); });
    var MAX = 12, req = D.required_by || [], deps = order.map(function (k) { return right[k]; });
    var left = req.slice(0, req.length > MAX ? MAX - 1 : MAX), rightShown = deps.slice(0, deps.length > MAX * 2 ? MAX * 2 - 1 : MAX * 2);
    var node = function (x, side) {
      var tag = side === "left" ? (x.sonames.length ? ['so', x.sonames[0]] : ['decl', "depends"]) : (!x.provided ? ['none', "not in " + D.shown_ring] : x.sonames.length ? ['so', x.sonames[0]] : ['decl', "declared"]);
      return '<a class="pkg-node' + (side === "right" && vuln[x.name] ? " adv" : "") + (side === "right" && !x.provided ? " gone" : "") + '" href="' + pkgHref(x.name, ring, arch) + '" title="' + esc(x.name + (x.version ? " " + x.version : "") + (x.sonames.length ? " · loads " + x.sonames.join(", ") : "") + (vuln[x.name] ? " · " + vuln[x.name] + " open advisory" + (vuln[x.name] > 1 ? "ies" : "") : "")) + '"><span>' + (side === "right" && vuln[x.name] ? '<i class="dot"></i>' : '') + '<span class="nm">' + esc(x.name) + '</span>' + (side === "right" && x.version ? '<span class="v">' + esc(x.version) + '</span>' : '') + '</span><span class="t ' + tag[0] + '">' + esc(tag[1]) + '</span></a>';
    };
    var lNodes = left.map(function (x) { return node(x, "left"); }), rNodes = rightShown.map(function (x) { return node(x, "right"); });
    if (req.length > left.length) lNodes.push('<button type="button" class="pkg-node" data-more="rb">+' + num(req.length - left.length) + ' more</button>');
    if (deps.length > rightShown.length) rNodes.push('<button type="button" class="pkg-node" data-more="dep">+' + num(deps.length - rightShown.length) + ' more</button>');
    if (!lNodes.length) lNodes.push('<span class="pkg-node gone" title="nothing in ' + esc(D.shown_ring) + ' requires it">nothing requires it</span>');
    if (!rNodes.length) rNodes.push('<span class="pkg-node gone">no dependencies</span>');
    var nl = lNodes.length, nr = rNodes.length, H = Math.max(nl, nr, 2) * 26 - 2, lPad = (H - (nl * 26 - 2)) / 2, rPad = (H - (nr * 26 - 2)) / 2, cy = H / 2;
    var colour = function (x, side) { return side === "right" && !x.provided ? "var(--line)" : x.sonames.length ? "var(--green)" : "var(--blue)"; };
    var paths = function (list, pad, side) { return list.map(function (x, i) { var y = pad + i * 26 + 12; return '<path d="' + (side === "left" ? "M0 " + y + " C32 " + y + " 32 " + cy + " 64 " + cy : "M0 " + cy + " C32 " + cy + " 32 " + y + " 64 " + y) + '" fill="none" stroke="' + colour(x, side) + '" stroke-width="1" opacity="0.8"/>'; }).join(""); };
    var ownOpen = ((D.security && D.security.advisories) || []).some(function (a) { return a.status === "vulnerable"; });
    var provides = ((D.manifest || {}).provides || []).filter(function (x) { return x.split(/[<>=]/)[0] !== D.name; });
    var full = function (id, title, items) { return '<details class="pkg-more" id="' + id + '"><summary>' + esc(title) + '</summary><ul>' + items.join("") + '</ul></details>'; };
    var comps = (D.manifest && D.manifest.components) || [];
    el.innerHTML = '<div class="pkg-graph"><span class="op-label gl">Required by · ' + num(req.length) + (req.length >= 400 ? "+" : "") + '</span>' +
      '<div class="pkg-gcol l" style="padding-top:' + lPad + 'px">' + lNodes.join("") + '</div>' +
      '<svg class="l" width="64" height="' + H + '" aria-hidden="true">' + paths(left, lPad, "left") + '</svg>' +
      '<div class="pkg-center' + (ownOpen ? " fail" : "") + '" style="margin-top:' + (cy - 18) + 'px" title="' + esc(ownOpen ? "an advisory is open on this version" : D.name) + '">' + esc(D.name) + '</div>' +
      '<svg class="r" width="64" height="' + H + '" aria-hidden="true">' + paths(rightShown, rPad, "right") + '</svg>' +
      '<span class="op-label gr">Depends on · ' + num(deps.length) + '</span><div class="pkg-gcol r" style="padding-top:' + rPad + 'px">' + rNodes.join("") + '</div></div>' +
      '<div class="pkg-gfoot"><span>provides <b>' + (provides.length ? esc(provides.join(" · ")) : "only itself") + '</b></span><span>loads <b>' + ((D.links || []).length ? (D.links || []).map(function (l) { return esc(l.soname); }).join(" · ") : "nothing dynamically") + '</b></span></div>' +
      (req.length > left.length ? full("rb-all", "Everything in " + D.shown_ring + " that requires it · " + num(req.length) + (req.length >= 400 ? "+" : ""), req.map(function (x) { return '<li>' + pkgLink(x.name) + ' <span title="' + esc(x.sonames.join(", ")) + '">' + (x.declared ? "declared" : "") + (x.declared && x.sonames.length ? " + " : "") + (x.sonames.length ? "loads " + x.sonames.length + " lib" + (x.sonames.length > 1 ? "s" : "") : "") + '</span></li>'; })) : "") +
      (deps.length > rightShown.length ? full("dep-all", "Everything it depends on · " + num(deps.length), deps.map(function (x) { return '<li>' + (x.provided ? pkgLink(x.name) + ' <span>' + esc(x.version) + '</span>' : esc(x.name) + ' <span>not in ' + esc(D.shown_ring) + '</span>') + '</li>'; })) : "") +
      (comps.length ? '<details class="pkg-more" id="components-section"><summary>Libraries built into its binaries · ' + num(comps.length) + '</summary><p class="pkg-small">Go modules and crates.io crates a statically linked binary was built with: no soname shows them, the security layer matches advisories against them.</p><div class="table-wrap"><table class="op-table" id="components"><thead><tr><th>Ecosystem</th><th>Name</th><th>Version</th></tr></thead><tbody></tbody></table></div></details>' : "");
    if (comps.length) pager("#components", comps, function (x) {
      var href = x.ecosystem === "Go" ? "https://pkg.go.dev/" + x.name + "@" + x.version : x.ecosystem === "crates.io" ? "https://crates.io/crates/" + x.name + "/" + x.version : "";
      return '<tr><td>' + esc(x.ecosystem) + '</td><td>' + (href ? '<a href="' + esc(href) + '">' + esc(x.name) + '</a>' : esc(x.name)) + '</td><td class="mono">' + esc(x.version) + '</td></tr>';
    }, { n: 25 });
  }
  // "+N more" opens the whole list under the graph.
  $("#deps").addEventListener("click", function (ev) { var b = ev.target.closest ? ev.target.closest("[data-more]") : null; if (!b) return; var d = $(b.getAttribute("data-more") === "rb" ? "#rb-all" : "#dep-all"); if (d) { d.open = true; d.scrollIntoView({ block: "nearest" }); } });

  // ---- the files: collapsed, read once when opened.
  function renderFilesHead() {
    var btn = $("#load-files");
    $("#files-count").textContent = D && D.files != null ? num(D.files) + (D.files === 1 ? " file" : " files") : "";
    btn.disabled = !D;
    if (!D) { btn.title = "the files are read from the object a ring serves; no ring serves " + name + " on " + arch + " yet"; $("#files-label").textContent = "once a ring serves it"; $("#files").hidden = true; btn.setAttribute("aria-expanded", "false"); }
  }
  $("#load-files").onclick = function () {
    var box = $("#files"), btn = $("#load-files"), open = box.hidden;
    box.hidden = !open; btn.setAttribute("aria-expanded", String(open)); $("#files-label").textContent = open ? "hide" : "show";
    if (!open || FILES) return;
    box.innerHTML = '<span>loading…</span>';
    busy(fetch("/api/v1/package/" + encodeURIComponent(name) + "/files?ring=" + ((D && D.shown_ring) || ring) + "&arch=" + arch)).then(function (r) { return r.json(); }).then(function (d) {
      FILES = (d.files || []).filter(function (f) { return !/\/$/.test(f); });
      $("#files-count").textContent = num(FILES.length) + (FILES.length === 1 ? " file" : " files");
      box.innerHTML = FILES.length ? FILES.map(function (f) { return '<span title="' + esc(f) + '">' + esc(f) + '</span>'; }).join("") : '<span>' + esc(d.error || "no files") + '</span>';
    }).catch(function (e) { box.innerHTML = '<span>failed: ' + esc(errorText(e)) + '</span>'; });
  };

  // ---- install: the command, or the words to give an agent; nothing to install before a ring serves it.
  var AGENTS = [["Claude Code", "claude-color"], ["Codex", "openai"], ["Cursor", "cursor"], ["Gemini CLI", "gemini-color"], ["GitHub Copilot", "githubcopilot"], ["Grok", "grok"], ["OpenCode", "opencode"], ["Qwen Code", "qwen-color"], ["Kimi", "kimi"], ["Meta", "meta-color"]];
  function renderInstall() {
    var b = blockedBy(), servedHere = D && promised(servedOn(arch)).length, agent = MODE === "agent";
    document.querySelectorAll("#install [data-mode]").forEach(function (t) { t.setAttribute("aria-selected", String(t.getAttribute("data-mode") === MODE)); });
    var text = agent ? "Install " + name + " from omarchy-pool on my ring, and check the seal first." : "sudo pacman -S " + name;
    $("#install-b").innerHTML = (servedHere && !b ? '<div class="op-code"><code><span class="op-prompt">' + (agent ? "› " : "$ ") + '</span>' + esc(text) + '</code><button type="button" class="op-copy" data-op-copy="' + esc(text) + '">copy</button></div>'
      : '<div class="pkg-noinst">' + lucide("circle-slash", 15) + '<span>' + (b ? "Blocked. Not installable from any ring." : D && PROMISED_RINGS.indexOf(D.shown_ring) < 0 ? "In the lab only: tried, not promised. Installable after approval." : isFactory() ? "Not in a ring yet. Installable after approval." : "Not served on " + esc(arch) + ".") + '</span></div>') +
      (agent ? '<div class="pkg-agents"><span>Works with</span>' + AGENTS.map(function (a) { return agentMark(a[1], a[0], 18); }).join("") + '</div><span class="pkg-small">Your agent speaks to the pool through omarchy-cli. <a href="/agents">Connect it ›</a></span>' : '<span class="pkg-small">Pool not set up yet? <a href="/docs/get-started">Set it up once ›</a></span>');
  }
  document.querySelectorAll("#install [data-mode]").forEach(function (t) { t.onclick = function () { MODE = t.getAttribute("data-mode"); renderInstall(); }; });

  // ---- the seal: six gates on each architecture, the object's sha256 and the seal as JSON.
  function gateCells(a) {
    var fac = isFactory(), b = blockedBy(), rs = servedOn(a), ts = targetsOf() || {}, c = chainFor(a);
    var all = function (tone, why) { return [0, 1, 2, 3, 4, 5].map(function () { return [tone, why]; }); };
    if (!rs.length && ts[a] && ts[a].status === "not_supported") return all("na", a + " is not supported");
    if (!rs.length && fac && !ts[a]) return all("na", "not requested for " + a);
    if (b) return all("fail", "revoked: blocked by " + (b.blocked_by || "a maintainer"));
    if (!rs.length) return all(fac ? "wait" : "na", fac ? "not sealed yet: no ring serves it" : "not served on " + a);
    var top = rs[0], open = D && D.arches && D.arches[a] ? D.arches[a].open : null;
    var inR = function (test) { return rs.some(function (r) { return test(r.ring); }); };
    var signed = fac ? (D && D.seal && D.seal.signature ? ["ok", "signed by the pool's key"] : ["wait", "the pool signs it when it publishes"]) : (top.has_signature === false ? ["fail", "no upstream signature"] : ["ok", "upstream signature verified on import"]);
    var tr = c && c.trial, installs = fac ? (tr && tr.result && tr.result.verdict === "ok" ? ["ok", "a real pacman installed it in the lab"] : tr ? ["fail", "the lab's trial did not install it"] : ["wait", "not tried in the lab"]) : ["na", "not installed one by one: the ring's health check resolves the whole ring with a real pacman"];
    var abi = inR(promoted) ? ["ok", "passed the ABI check on its way out of edge"] : ["wait", "checked when it is promoted out of edge"];
    var adv = open === null || open === undefined ? ["wait", "not matched yet"] : open ? ["fail", open + " open advisor" + (open > 1 ? "ies" : "y")] : ["ok", "no advisory open on it"];
    var healthy = inR(function (r) { return r === PROMISED_RINGS[0]; }) ? ["ok", "two green health checks in a row before stable"] : ["wait", "stable takes two green health checks in a row"];
    var ap = c && c.approval, last = fac ? (ap && ap.decision === "approved" ? ["ok", "brought by " + ((ST && ST.package && ST.package.owner) || "its contributor") + ", rebuilt and approved by " + ap.by] : ["wait", "no standing approval on " + a]) : ["ok", "served as " + upstreamName() + " built and signed it"];
    return [signed, installs, abi, adv, healthy, last];
  }
  function renderSeal() {
    var fac = isFactory(), b = blockedBy(), sealed = D && promised(servedOn(arch)).length;
    var gates = [["key-round", "Signed"], ["package-check", "Installs"], ["binary", "ABI"], ["shield-check", "No open advisory"], ["heart-pulse", "Healthy"], fac ? ["users", "Two people"] : ["copy", "Mirrored as-is"]];
    var cells = ARCHES.map(gateCells), row = D ? inRing(arch, D.shown_ring) : null;
    $("#seal-icon").className = "pkg-h " + (b ? "fail-t" : sealed ? "ok-t" : "dim-t");
    $("#seal-ctx").textContent = b ? "revoked" : D ? D.shown_ring + (row ? " #" + row.release_seq : "") + " · " + arch : "not sealed yet";
    $("#seal").innerHTML = '<div><span></span>' + ARCHES.map(function (a) { return '<span title="' + esc(a) + '">' + esc(a.replace("_64", "").replace("aarch64", "arm")) + '</span>'; }).join("") + '</div>' +
      gates.map(function (g, i) { return '<div><span class="g">' + lucide(g[0], 14) + '<span>' + esc(g[1]) + '</span></span>' + cells.map(function (cs, k) { return mark(cs[i][0], ARCHES[k] + ": " + cs[i][1]); }).join("") + '</div>'; }).join("");
    var seal = D && D.seal, links = [];
    if (seal && seal.signature) links.push('<a href="' + esc(seal.signature.object) + '">signature</a>');
    if (seal && seal.upstream && seal.upstream.signature) links.push('<a href="' + esc(seal.upstream.signature) + '">signature</a>');
    if (seal && seal.attestation) links.push('<a href="' + esc(seal.attestation.statement) + '">attestation</a>' + (seal.attestation.signature ? ' <a href="' + esc(seal.attestation.signature) + '">.sig</a>' : ''));
    $("#seal-foot").innerHTML = '<span title="' + esc(D ? D.package.sha256 : "") + '">sha256 ' + (D ? esc(D.package.sha256.slice(0, 12)) + "…" : "—") + '</span><span>' + links.join(" · ") + (D ? (links.length ? ' · ' : '') + '<a href="/api/v1/packages/' + esc(D.package.sha256) + '/provenance">seal JSON ›</a>' : '') + '</span>';
  }

  // ---- people and agents, and the facts.
  function maintainerOf() { var m = D && D.maintenance && D.maintenance.maintainer; return m && m.login ? m : null; }
  function person(role, label, note, av) { return '<div class="pkg-person">' + av + '<div><span class="r">' + esc(role) + '</span><span class="l">' + label + (note ? '<span> · ' + esc(note) + '</span>' : '') + '</span></div></div>'; }
  function renderPeople() {
    var fac = isFactory(), rows = [], mt = maintainerOf();
    if (fac) {
      var pk = (ST && ST.package) || {}, chain = D && D.seal && D.seal.chain, sb = chain && chain.source_build;
      var cs = ARCHES.map(chainFor).filter(Boolean), ap = cs.map(function (c) { return c.approval; }).filter(Boolean)[0], au = cs.map(function (c) { return c.audit && c.audit.result && c.audit.result.model; }).filter(Boolean)[0];
      var built = cs.map(function (c) { return c.contributor && c.contributor.lease_owner; }).filter(Boolean)[0], rebuilt = cs.map(function (c) { return c.project && c.project.lease_owner; }).filter(Boolean)[0];
      var reviewing = cs.some(function (c) { return c.project && !c.approval; });
      if (pk.owner) rows.push(person("requested by", personLink(pk.owner), "", avatar(pk.owner)));
      if (sb && sb.agent) rows.push(person("drafted & built by", esc(sb.agent), built ? wtShort(built) : "", glyph(sb.agent, "agent")));
      else if (built || !rebuilt) rows.push(person("built on", built ? esc(wtShort(built)) : "not yet", built ? "its contributor's worker" : "", glyph("W", "", "W")));
      rows.push(ap ? person("reviewed by", personLink(ap.by), ap.decision === "approved" ? "rebuilt from scratch" : ap.decision, avatar(ap.by)) : person("reviewed by", reviewing ? "in progress" : "not yet", "", glyph("—", "", "—")));
      if (au) rows.push(person("audit agent", esc(au), "second opinion", glyph(au, "agent")));
      if (rebuilt) rows.push(person("rebuilt on", esc(wtShort(rebuilt)), "a project worker", glyph("▣", "pool", "▣")));
      rows.push(mt ? person("maintainer", personLink(mt.login), mt.adopted ? "adopted " + since(mt.since) + " ago" : "", avatar(mt.login)) : person("maintainer", "none yet", "", glyph("—", "", "—")));
    } else {
      var pi = (D && D.manifest && D.manifest.pkginfo) || {}, packager = pi.packager ? pi.packager.replace(/<.*>/, "").trim() : "";
      rows.push(person("packaged by", esc(packager || upstreamName()), packager ? upstreamName() : "", glyph(packager || upstreamName())));
      rows.push(person("mirrored by", "the pool", "not rebuilt", glyph("▣", "pool", "▣")));
      rows.push(person("agents", "none", "the factory's alone", glyph("—", "", "—")));
      rows.push(mt ? person("pool maintainer", personLink(mt.login), "adopted " + since(mt.since) + " ago", avatar(mt.login)) : person("pool maintainer", "none yet", "", glyph("—", "", "—")));
    }
    $("#who").innerHTML = rows.join("");
  }
  function fact(icon, k, v, cls) { return '<div>' + lucide(icon, 15, k) + '<span' + (cls ? ' class="' + cls + '"' : '') + ' title="' + esc(k) + '">' + v + '</span></div>'; }
  function renderFacts() {
    var rows = [], m = D ? D.manifest || {} : {}, pi = m.pkginfo || {}, pk = (ST && ST.package) || {};
    if (isFactory()) {
      var proj = pk.project || pk.url || m.url || "";
      rows.push(fact(/github\.com/.test(proj) ? "github" : "globe", "source", proj ? '<a href="' + esc(proj) + '">' + esc(proj.replace(/^https?:\/\/(www\.)?/, "")) + '</a>' : "—"));
      rows.push(fact("scale", "licence", esc(pk.license || (m.licenses || []).join(", ") || "—")));
      rows.push(fact("factory", "origin", "factory · only in the pool"));
      if (pk.category) rows.push(fact("tag", "category", esc(pk.category)));
      rows.push(fact("calendar", "requested", esc(onDay((ST && ST.request && ST.request.created_at) || pk.created_at))));
    } else if (D) {
      rows.push(fact("globe", "project", m.url ? '<a href="' + esc(m.url) + '">' + esc(m.url.replace(/^https?:\/\//, "")) + '</a>' : "—"));
      rows.push(fact("scale", "licence", esc((m.licenses || []).join(", ") || "—")));
      rows.push(fact("database", "origin", esc(sourceWords(D.package.source, arch))));
      rows.push(fact("calendar", "built", pi.builddate ? esc(new Date(pi.builddate * 1000).toISOString().slice(0, 10)) : "—"));
    }
    if (D) rows.push(fact("file-archive", "download", '<a href="' + esc(D.pool_url) + '">' + bytes(D.package.size_download) + ' · .pkg.tar.zst</a>' + (D.package.has_signature || (D.seal && D.seal.signature) ? ' · <a href="' + esc(D.pool_url) + '.sig">.sig</a>' : '')));
    else rows.push(fact("file-archive", "download", "no file in a ring", "dim-t"));
    $("#facts").innerHTML = rows.join("");
  }

  // ---- You: the same page for everyone; what you can do on it is yours. A visitor signs in, the contributor who requested it asks for an update and never reviews it, a maintainer blocks it (the reason on the record), adopts it when nobody looks after it, lifts a block another maintainer made, opens its review.
  function btn(label, attrs, cls) { return '<' + (attrs.indexOf("href=") === 0 ? 'a ' + attrs : 'button type="button" ' + attrs) + ' class="op-btn' + (cls ? " " + cls : "") + '">' + esc(label) + '</' + (attrs.indexOf("href=") === 0 ? "a" : "button") + '>'; }
  function reviewBuild() { var cs = ARCHES.map(chainFor).filter(Boolean), c = cs.filter(function (x) { return x.project && x.project.status === "staged"; })[0] || cs.filter(function (x) { return x.contributor && x.contributor.status === "staged"; })[0]; return c ? (c.project && c.project.status === "staged" ? c.project : c.contributor).id : null; }
  function renderYou() {
    var me = WHO.me, login = WHO.login, fac = isFactory(), b = blockedBy(), st = stateOf(), pk = (ST && ST.package) || {}, mt = maintainerOf();
    var icon = "eye", who = "not signed in", text = "", btns = [], lock = "";
    var blockBtn = gate(btn("Block", 'data-act="block"', "danger"), fac && !b, !fac ? "a synced package is served as its source publishes it; the brake blocks what the factory built" : "blocked already");
    if (!me) { text = "Everything on this page is public. Sign in to request changes or review."; btns.push(btn("Sign in with GitHub", 'href="' + esc(signInHref()) + '" rel="nofollow"', "primary")); }
    else if (pk.owner && pk.owner === login) {
      icon = "user"; who = "@" + login + " · requester";
      var req = (ST && ST.request) || {}, why = req.busy ? "a build of it is running (#" + req.busy + "); ask again when it ends" : ["approved", "published"].indexOf(pk.status) >= 0 ? "approved: a new upstream release is built as a bump, by itself" : b ? "blocked: another maintainer lifts the block first" : "not while it is " + (pk.status || "in the factory");
      text = "You requested this package.";
      btns.push(gate(btn("Request an update", 'href="/request?renew=' + encodeURIComponent(name) + '"', "primary"), !!req.renewable, why));
      btns.push(btn("Your requests", 'href="' + userHref(login) + '"'));
      if (isMaintainer()) btns.push(blockBtn);
      lock = "You can't review your own request.";
    } else if (isMaintainer()) {
      icon = "shield"; who = "@" + login + " · maintainer";
      if (b) { text = b.blocked_by === login ? "You blocked it. Another maintainer lifts the block." : "Blocked by " + b.blocked_by + ". You can lift the block; the reason goes on the record."; btns.push(gate(btn("Lift the block", 'data-act="unblock"', "primary"), b.blocked_by !== login, login + " blocked " + name + "; another maintainer lifts it")); }
      else if (st === "building") { text = "Builds are still running. Nothing to review yet."; btns.push(btn("Open the review queue", 'href="/review"')); btns.push(blockBtn); }
      else if (st === "in-review") { var tst = targetsOf() || {}, at = function (w) { return Object.keys(tst).some(function (a) { return tst[a].status === w; }); }; text = at("reviewed") ? "The project built it again: the decision is a maintainer's." : at("reviewing") ? "The project builds it again; the decision follows." : "Ready for a maintainer: have the project build it again, then decide."; var rb = reviewBuild(); btns.push(btn("Open review", 'href="' + (rb ? "/build/" + rb : "/review") + '"', "primary")); btns.push(blockBtn); }
      else if (!mt && D && promised(servedOn(arch)).length) { text = "No pool maintainer yet. Any maintainer can look after it."; btns.push(btn("Adopt", 'data-act="adopt"', "primary")); btns.push(blockBtn); }
      else { text = mt ? (mt.login === login ? "You maintain this package." : "Maintained by " + mt.login + ".") : st === "approved" ? "Approved; its publish job carries it into edge." : "Not in any ring."; btns.push(blockBtn); }
    } else { icon = "user"; who = "@" + login + " · contributor"; text = "Something wrong with it?"; btns.push(btn("Report a problem", 'href="https://github.com/firemanxbr/omarchy-pool/issues/new?title=' + encodeURIComponent(name + ": ") + '"')); }
    $("#you-icon").innerHTML = lucide(icon, 15) + '<b>You</b>';
    $("#you-who").textContent = who;
    $("#you").innerHTML = '<p>' + esc(text) + '</p>' + (btns.length ? '<div class="pkg-btns">' + btns.join("") + '</div>' : '') + (lock ? '<span class="pkg-lock">' + lucide("lock", 13) + esc(lock) + '</span>' : '') +
      (ASK ? '<form class="pkg-ask" id="you-ask"><input id="you-why" placeholder="Why? This goes on the record." aria-label="the reason, on the record" autocomplete="off"><p class="err" id="you-err" hidden></p><div class="pkg-btns"><button type="submit" class="op-btn ' + (ASK === "block" ? "danger" : "primary") + '">' + esc(ASK === "block" ? "Block " + name : "Lift the block") + '</button><button type="button" class="op-btn" data-act="cancel">Cancel</button></div></form>' : '');
    var f = $("#you-ask"); if (f) { f.onsubmit = function (ev) { ev.preventDefault(); act(ASK, $("#you-why").value.trim()); }; $("#you-why").focus(); }
  }
  // What a press does: the brake asks its reason in place, then posts once; Adopt posts at once. The answer is drawn at once — the page's data is cached for minutes, the decision is not.
  $("#you").addEventListener("click", function (ev) {
    var t = ev.target.closest ? ev.target.closest("[data-act]") : null; if (!t || t.disabled) return;
    var what = t.getAttribute("data-act");
    if (what === "cancel") { ASK = null; renderYou(); return; }
    if (what === "adopt") { act("adopt", ""); return; }
    ASK = what; renderYou();
  });
  function act(what, why) {
    if (what !== "adopt" && why.length < 4) { var e = $("#you-err"); e.hidden = false; e.textContent = "Say why, in a few words — the record keeps it."; return; }
    document.querySelectorAll("#you button").forEach(function (b) { b.disabled = true; });
    var path = "/api/v1/factory/packages/" + encodeURIComponent(name) + "/" + what;
    api("POST", path, what === "adopt" ? {} : { reason: why }).then(function (d) {
      if (d.error) { toast(esc(d.error), "error"); renderYou(); return; }
      ASK = null; ST = ST || { package: {}, chains: [], rings: [] };
      if (what === "adopt") { D.maintenance = D.maintenance || {}; D.maintenance.maintainer = { login: WHO.login, since: d.since || new Date().toISOString(), adopted: true }; toast("You now look after " + esc(name) + " in the pool."); }
      // A block takes the package out of every ring: the page draws it as the next read will, not from the answers it came with.
      else if (what === "block") { ST.package.blocked_at = d.at; ST.package.blocked_by = WHO.login; ST.package.blocked_reason = why; ST.package.status = "rejected"; ST.rings = []; D404 = { error: name + " is in no ring: blocked", arches: {} }; D = null; toast("Blocked — out of every ring, back in the factory. Another maintainer lifts it."); }
      else { ST.package.blocked_at = null; ST.package.blocked_by = null; ST.package.blocked_reason = null; ST.package.status = "registered"; toast("The block is lifted: back in the factory, a new build and a new review start it over."); }
      renderAll();
    }, function (e) { toast("failed: " + esc(errorText(e)), "error"); renderYou(); });
  }

  function renderAll() { renderHead(); renderTiles(); renderChain(); renderSecurity(); renderDeps(); renderFilesHead(); renderInstall(); renderSeal(); renderPeople(); renderFacts(); renderYou(); }

  // The package in its ring and architecture first; the story after it, and only for what the factory built or no ring serves here — a synced package has none, and asking would cost a request for a 404. The index can be busy during a bulk import: a transient 5xx gets retried.
  function loadPackage(attempt) {
    busy(fetch("/api/v1/package/" + encodeURIComponent(name) + "?ring=" + ring + "&arch=" + arch)).then(function (r) {
      if (r.status >= 500) throw new Error("index busy (HTTP " + r.status + ")");
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (a) {
      if (a.ok) D = a.d; else D404 = a.d;
      if (D && D.package.source !== "factory") return null;
      return fetch("/api/v1/factory/packages/" + encodeURIComponent(name) + "/story").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    }).then(function (st) {
      if (st && st.package) ST = st;
      renderAll();
    }).catch(function (e) {
      if (attempt < 4) { $("#desc").textContent = "The index is busy (" + e.message + "); retrying…"; setTimeout(function () { loadPackage(attempt + 1); }, 4000 * attempt); }
      else $("#desc").textContent = "Could not load this package right now: " + e.message + ". Reload to try again.";
    });
  }
  renderTiles();
  loadPackage(1);
  // Who is looking decides the You card alone; the rest is everyone's.
  whoami(function () { if (D || ST || D404) renderYou(); });
`;

export function packagesHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/packages",
    title: "Packages · omarchy-pool",
    description: "Search the packages a ring serves; versions per ring, dependencies, what loads them, files.",
    // The packages list and a package's page are the Pool's: what a user comes to the pool for (#240).
    active: "pool",
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
    description: `${name}: where it comes from, how it got into the pool, its seal, its dependencies and files.`,
    active: "pool",
    body: packageBody(name),
    script: PACKAGE_SCRIPT.replace("__SOURCE_WORDS__", JSON.stringify(SOURCE_WORDS)),
    poolUrl,
    version,
    kit: true,
    css: PACKAGE_CSS,
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
    // The rings are the server's list (RINGS_TEXT, the lab included), never a copy on the page.
    id: "packages.ring-arch-pickers",
    page: "/packages",
    anchor: ['id="pick-ring"', 'id="pick-arch"'],
    script: ["RINGS = Object.keys(RINGS_TEXT)", 'ARCHES.indexOf(q.get("arch"))', 'pick("#pick-ring"', 'pick("#pick-arch"'],
    visible: EVERYONE,
  },
  {
    // The name is the package's one address in the ring and architecture picked; the two icons of a factory package are the shell's, the approver the approval that stands (the row's `standing`), their colour the maintainer set's word.
    id: "packages.results-table",
    page: "/packages",
    anchor: ['id="results"', "<th>By</th>", 'class="pk-results"'],
    script: ['"#results"', 'data-name="', 'class="pkname"', "pkgHref(p.name, ring, arch)", "size_download", '"/api/v1/factory/packages"', "OWNERS[p.name]", '"/api/v1/factory/approvals"', "a.standing && !APPROVERS[a.name]", "avatar(o)", "avatar(a)"],
    reads: [
      { path: `/api/v1/search?q=${F.pkg}&ring=stable&arch=${F.arch}&limit=100`, fields: ["packages.0.name", "packages.0.version", "packages.0.source", "packages.0.description", "packages.0.size_download"] },
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.name", "packages.0.owner"] },
      { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.name", "approvals.0.decision", "approvals.0.standing", "approvals.0.by"] },
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "packages.detail-panel",
    page: "/packages",
    anchor: ['id="pk-detail"', "Pick a package"],
    script: ['"#pk-detail"', '"/api/v1/package/"', "d.shown_ring", "size_installed", "d.depends", "d.links", "d.required_by", "security.advisories", "security.exposed", "sudo pacman -S ", "pkgHref(name, d.shown_ring, arch)", "Open "],
    reads: [
      {
        path: `/api/v1/package/${F.pkg}?ring=stable&arch=${F.arch}`,
        fields: ["name", "shown_ring", "package.source", "package.size_download", "package.size_installed", "manifest.description", "rings.0.ring", "rings.0.version", "depends", "links", "required_by", "required_by.0.name", "security.advisories.0.status", "security.advisories.0.cves.0", "security.exposed"],
      },
    ],
    visible: EVERYONE,
  },
  {
    // The two people are the shell's icon and link, their role the maintainer set's.
    id: "packages.detail-who-row",
    page: "/packages",
    anchor: ['id="pk-detail"'],
    script: ['class="whorow', "mt.factory", "avatar(f.owner)", "personLink(f.owner)", "avatar(f.approved_by)", "personLink(f.approved_by)", "mt.packager", "brought by", "approved by", "waiting for a maintainer", "packaged upstream"],
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
    script: ['"/api/v1/releases/stable/diff?from="', '"#pk-diff"', '"#pk-diff-when"', "d.releases", "r.is_head", "head.parent_id", "df.upgraded", "df.added", "df.removed", 'pkgHref(x.name, "stable", x.arch)', 'href="/diff?ring=stable&from=', 'href="/journal"'],
    reads: [
      { path: "/api/v1/stats", fields: ["releases", "releases.0.ring", "releases.0.is_head", "releases.0.parent_id", "releases.0.id", "releases.0.seq", "releases.0.created_at"] },
      { path: `/api/v1/releases/stable/diff?to=${F.release}`, fields: ["to.id", "from", "upgraded", "added", "added.0.name", "removed"] },
    ],
    visible: EVERYONE,
  },
];

/**
 * What /package/<name> is made of (#244). Everyone reads the same page:
 * two GETs draw it — the package in its ring and architecture, then the
 * factory's story of it for what the factory built or no ring serves here
 * (a synced package has no story and is not asked for one) — and the file
 * list and the two recipes of a review on demand. Only You changes with the
 * viewer, and its three acts are the brake, lifting it and Adopt, each the
 * maintainers' and refused by the server to anyone else. The fixture's zlib
 * is the page (xz requires it, the advisory is on it); xz is the other end
 * of the same edges — it declares zlib and loads its library, so it is
 * exposed through it; `ours` in edge is what a factory package's page reads
 * (its seal's chain, its approval, its publish), `mine`'s story — decided,
 * not yet in the pool — is a factory package no ring serves, and `hers` is
 * blocked.
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
      anchor: ['class="crumbs"', 'href="/packages"', `id="crumb">${F.pkg}<`],
      script: ["location.pathname"],
      visible: EVERYONE,
    },
    {
      // The name (served), the version and the state, where it comes from — the factory, or the source in meta.ts's words — and each architecture: the targets' chips (the shell's targetChips, the server's word), or where a synced package is served.
      id: "package.header",
      page,
      anchor: [`<h1 id="title">${F.pkg}</h1>`, 'id="pkg-ver"', 'id="pkg-state"', 'id="pkg-mark"', 'id="desc"', 'id="pkg-chips"'],
      script: ['"#pkg-state"', "STATE[stateOf()]", "factory · only in the pool", "'synced · '", "sourceWords(D.package.source, arch)", "SOURCE_WORDS = {", "targetChips(targetsOf())", "servedChips()", "m.description", "pk.description", "versionOf()"],
      reads: [
        { path: pkg, fields: ["name", "package.version", "package.source", "manifest.description", "seal.upstream.project", "arches.x86_64.rings.0.ring", "arches.aarch64.rings"] },
        { path: story, fields: ["package.description", "package.status", "targets", "targets.x86_64.status", "request.version"] },
        // A name no ring serves on this architecture: the answer says where the others serve it, and the page links there or to the factory.
        { path: `/api/v1/package/not-a-package?ring=stable&arch=${F.arch}`, status: 404, fields: ["error", "arches.x86_64.rings", "arches.aarch64.rings"] },
      ],
      visible: EVERYONE,
    },
    {
      // Every ring the server lists (RINGS_TEXT, the lab included), the API's shown_ring lit, a ring that does not serve it on this architecture dashed; a chip is the package's one address in that ring or architecture.
      id: "package.ring-arch-pickers",
      page,
      anchor: ['<nav class="op-seg" id="pg-ring"', '<nav class="op-seg" id="pg-arch"'],
      script: ['"#pg-ring"', '"#pg-arch"', "RINGS = Object.keys(RINGS_TEXT)", "function ringChips(d, has)", "pkgHref(d.name, r, arch)", "pkgHref(name, shown || ring, a)", "d.shown_ring"],
      reads: [
        { path: pkg, fields: ["name", "ring", "shown_ring", "arch", "arches.x86_64.rings.0.ring"] },
        { path: `/api/v1/package/${F.pkg}?ring=lab&arch=${F.arch}`, fields: ["ring", "shown_ring"] },
      ],
      visible: EVERYONE,
    },
    {
      // A block is said first, above the tiles: who, when, the reason on the record.
      id: "package.blocked",
      page,
      anchor: ['id="pkg-blocked" hidden'],
      script: ['"#pkg-blocked"', "blockedBy()", "b.blocked_reason", "Another maintainer can lift the block."],
      reads: [{ path: `/api/v1/factory/packages/${F.blockedPkg}/story`, fields: ["package.blocked_at", "package.blocked_by", "package.blocked_reason"] }],
      visible: EVERYONE,
    },
    {
      // Five tiles, each a link to its section; Version opens the Rings stage.
      id: "package.tiles",
      page,
      anchor: ['id="pg-tiles"', 'class="op-stats pkg-tiles"'],
      script: ['"#pg-tiles"', '"Version"', '"Size"', '"Depends on"', '"Required by"', '"Security"', "p.size_download", "p.size_installed", "row.release_seq", 'data-stage="', '"#op-chain", "rings"'],
      reads: [{ path: pkg, fields: ["package.version", "package.size_download", "package.size_installed", "shown_ring", "arch", "depends", "links", "required_by", "security.advisories.0.status", "security.exposed", "arches.x86_64.rings.0.release_seq"] }],
      visible: EVERYONE,
    },
    {
      // How it got here: four stages, a tab each, with its state per architecture — the targets' word for a factory package, where it is served for a synced one — and the chosen one's panel below.
      id: "package.stages",
      page,
      anchor: ['id="op-chain"', 'id="stages"', 'role="tablist"', 'id="stage-panel"', 'role="tabpanel"', 'id="chain-note"'],
      script: ['"#stages"', "stagesOf()", "defaultStage()", '"Upstream"', '"Request"', '"Factory build"', '"Review"', '"Rings"', "not needed · mirrored", 'role="tab"', "aria-selected", "ArrowRight", "peopleCount()"],
      reads: [
        { path: story, fields: ["targets", "chains.0.contributor.status", "chains.0.contributor.attempts", "chains.0.contributor.finished_at", "chains.0.approval", "request.checks", "request.complete", "request.created_at", "package.owner"] },
        { path: pkg, fields: ["seal.upstream.project", "manifest.pkginfo.builddate", "arches.x86_64.rings"] },
      ],
      visible: EVERYONE,
    },
    {
      // The request as it was checked when it was sent: its fields, its six lines, its signed record.
      id: "package.request-panel",
      page,
      anchor: ['id="stage-panel"'],
      script: ["requestPanel()", "req.checks", "c.item", "c.note", "req.record", "req.signature", '"request.json"', "Back with its requester: "],
      reads: [{ path: story, fields: ["request.checks.0.item", "request.checks.0.ok", "request.checks.0.note", "request.version", "request.arches", "request.record", "request.signature", "request.id", "package.project", "package.license", "package.detail"] }],
      visible: EVERYONE,
    },
    {
      // A synced package's upstream: where it was imported from, its signature checked on the way in, and for an OPR package where its recipe comes from.
      id: "package.upstream-panel",
      page,
      anchor: ['id="stage-panel"'],
      script: ["upstreamPanel()", "up.verified", "up.keyring", "D.provenance", "pv.source", "pv.pkgbuild", "D.pool_url", "pi.base"],
      reads: [{ path: pkg, fields: ["seal.upstream.verified", "seal.upstream.keyring", "seal.upstream.signature", "seal.indexed_at", "manifest.url", "manifest.licenses", "manifest.pkginfo.builddate", "manifest.pkginfo.packager", "package.filename", "pool_url", "provenance"] }],
      visible: EVERYONE,
    },
    {
      // The contributor's build per architecture as the gate says it (vet_package's checks by name) and the second agent's audit; for a synced package, what the pool checks of a build it never makes.
      id: "package.build-panels",
      page,
      anchor: ['id="stage-panel"'],
      script: ["buildPanel()", "syncedBuildPanel()", 'gateMark(b, ["checksums"])', 'gateMark(b, ["smoke"])', "v.failed", "v.warned", "evidenceHref(bs[i].id)", "wtShort(b.lease_owner", "rs[0].has_signature"],
      reads: [
        { path: story, fields: ["chains.0.contributor.result.vet.verdict", "chains.0.contributor.result.vet.failed", "chains.0.contributor.result.vet.warned", "chains.0.contributor.lease_owner", "chains.0.contributor.duration_ms", "chains.0.contributor.error", "chains.0.audit"] },
        { path: shipped, fields: ["chains.0.audit.status", "chains.0.audit.result.verdict", "chains.0.audit.result.summary"] },
        { path: pkg, fields: ["arches.x86_64.rings.0.has_signature"] },
      ],
      visible: EVERYONE,
    },
    {
      // The review: the project's build per architecture, its gate, the lab's trial, the decision and the reviewer's checklist — and the two recipes compared, read by the addresses the story gives when the stage opens.
      id: "package.review-panel",
      page,
      anchor: ['id="stage-panel"'],
      script: ["reviewPanel()", "c.project", "c.trial", "c.publish", "ap.withdrawn_at", "evidenceHref(ps[i].id)", "loadRecipes()", "c.recipes.contributor", "c.recipes.project", "diffHtml(two[0], two[1])", "Recipe vs the factory"],
      reads: [
        { path: shipped, fields: ["chains.0.project.status", "chains.0.project.result.vet.verdict", "chains.0.project.lease_owner", "chains.0.trial.status", "chains.0.trial.result.verdict", "chains.0.publish.status", "chains.0.approval.by", "chains.0.approval.note", "chains.0.approval.decision", "chains.0.audit.result.model", "chains.0.recipes.contributor", "chains.0.recipes.project"] },
        { path: story, fields: ["chains.0.recipes.contributor", "chains.0.recipes.project"] },
        { path: `/api/v1/factory/tasks/${F.contributorTask}/artifacts/PKGBUILD`, json: false },
        { path: `/api/v1/factory/tasks/${F.projectTask}/artifacts/PKGBUILD`, json: false },
      ],
      visible: EVERYONE,
    },
    {
      // Every ring on both architectures, and what the record says happened: the request, the decision, the publish, the rings now, the block.
      id: "package.rings-panel",
      page,
      anchor: ['id="stage-panel"'],
      script: ["ringsPanel()", "timeline()", "On the record</span>", "x.release_seq", "x.sha256", "hue(r)", "pkgHref(name, r, arch)"],
      reads: [
        { path: pkg, fields: ["arches.x86_64.rings.0.version", "arches.x86_64.rings.0.release_seq", "arches.x86_64.rings.0.sha256", "arches.x86_64.rings.0.source", "arches.x86_64.rings.0.size_download", "seal.indexed_at"] },
        { path: shipped, fields: ["chains.0.publish.finished_at", "chains.0.publish.id", "chains.0.approval.created_at", "request.created_at", "rings.0.ring", "rings.0.arch"] },
      ],
      visible: EVERYONE,
    },
    {
      // The version's own advisories, then what it loads: grouped by the dependency they come through, a square per advisory in the shell's colour for its severity.
      id: "package.security",
      page,
      anchor: ['id="sec-section"', 'id="sec-own"', 'id="sec-exposed"', 'href="/docs/security#confidence"'],
      script: ['"#sec-own"', '"#sec-exposed"', "advItem", "SEV_COLOR[a.severity]", "SEV_COLOR.exploited", "a.epss", "a.fixed", "e.via", "e.sonames", "e.advisory", "SEVERITIES.filter"],
      reads: [
        { path: pkg, fields: ["package.version", "security.advisories.0.id", "security.advisories.0.severity", "security.advisories.0.status", "security.advisories.0.cves", "security.advisories.0.match", "security.advisories.0.fixed", "security.advisories.0.kev", "security.advisories.0.epss", "security.advisories.0.url"] },
        { path: pkg2, fields: ["security.exposed.0.via", "security.exposed.0.declared", "security.exposed.0.sonames", "security.exposed.0.advisory.severity", "security.exposed.0.advisory.url", "security.exposed.0.advisory.cves", "security.exposed.0.advisory.match"] },
      ],
      visible: EVERYONE,
    },
    {
      // Left: what requires the page's package (zlib's side); right: what it declares and loads (xz's side), with the providers that carry an advisory; the SVG connectors between; the whole lists and the embedded libraries under it.
      id: "package.graph",
      page,
      anchor: ['id="deps-section"', 'id="deps"'],
      script: ['"#deps"', "renderDeps", "D.required_by", "x.provider.name", "pkgHref(x.name, ring, arch)", "vuln[x.name]", 'data-more="rb"', 'data-more="dep"', '<svg class="l" width="64"', '<svg class="r" width="64"'],
      reads: [
        { path: pkg, fields: ["name", "shown_ring", "required_by", "required_by.0.name", "required_by.0.declared", "required_by.0.sonames", "manifest.provides", "security.advisories.0.status"] },
        { path: pkg2, fields: ["depends.0.name", "depends.0.provider.name", "depends.0.provider.version", "links.0.soname", "links.0.provider.name", "security.exposed.0.via"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "package.components-table",
      page,
      anchor: ['id="deps"'],
      script: ['id="components-section"', 'pager("#components"', "x.ecosystem", "x.name", "x.version"],
      reads: [{ path: pkg, fields: ["manifest.components", "manifest.components.0.ecosystem", "manifest.components.0.name", "manifest.components.0.version"] }],
      visible: EVERYONE,
    },
    {
      // Collapsed: the count from the package's answer, the list read once when opened.
      id: "package.files",
      page,
      anchor: ['id="files-section"', 'id="load-files"', 'aria-controls="files"', 'id="files" hidden', 'id="files-count"'],
      script: ['"#load-files"', '"#files"', '"/files?ring="', "d.files", "D.files"],
      reads: [
        { path: `/api/v1/package/${F.pkg}/files?ring=stable&arch=${F.arch}`, fields: ["name", "ring", "arch", "files"] },
        { path: pkg, fields: ["files"] },
      ],
      visible: EVERYONE,
    },
    {
      // Install: the command, or the words to give an agent (the kit's marks of the agents it works with); nothing to install before a promised ring serves it here.
      id: "package.install",
      page,
      anchor: ['id="install"', 'id="install-b"', 'data-mode="cmd"', 'data-mode="agent"'],
      script: ["renderInstall", '"sudo pacman -S "', "check the seal first", 'class="op-copy" data-op-copy="', "agentMark(a[1], a[0], 18)", 'href="/docs/get-started"', 'href="/agents"', "Installable after approval."],
      reads: [{ path: pkg, fields: ["shown_ring", "arches.x86_64.rings.0.ring"] }],
      visible: EVERYONE,
    },
    {
      // The seal: six gates on each architecture, what each mark means on hover, the object's sha256, its signatures and attestation, the seal as JSON.
      id: "package.seal",
      page,
      anchor: ['id="seal-section"', 'id="seal"', 'id="seal-foot"', 'id="seal-ctx"'],
      script: ["gateCells", '"Signed"', '"Installs"', '"ABI"', '"No open advisory"', '"Healthy"', '"Two people"', '"Mirrored as-is"', "/provenance\">seal JSON ›", "seal.attestation.statement", "D.arches[a].open"],
      reads: [
        { path: pkg, fields: ["seal.signature", "seal.upstream.signature", "package.sha256", "arches.x86_64.open", "arches.aarch64.open", "arches.x86_64.rings.0.has_signature"] },
        { path: built, fields: ["seal.signature.object", "seal.attestation", "maintenance.maintainer"] },
        { path: `/api/v1/packages/${F.sha}/provenance`, fields: ["origin", "seal", "object", "sha256"] },
      ],
      visible: EVERYONE,
    },
    {
      // The people are the shell's icon and link, their role the maintainer set's; the agents their kit marks; a package's maintainer in the pool is the server's word (maintenance.maintainer: who adopted it, or whose approval stands).
      id: "package.people",
      page,
      anchor: ['id="who-section"', 'id="who"'],
      script: ["renderPeople", "D.maintenance.maintainer", "sb.agent", "avatar(pk.owner)", "personLink(ap.by)", '"pool maintainer"'],
      reads: [
        { path: pkg, fields: ["maintenance.maintainer", "manifest.pkginfo.packager"] },
        { path: built, fields: ["maintenance.maintainer.login", "maintenance.maintainer.adopted", "seal.chain.source_build.agent"] },
        { path: shipped, fields: ["package.owner", "chains.0.approval.by", "chains.0.audit.result.model", "chains.0.contributor.lease_owner", "chains.0.project.lease_owner"] },
        { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "package.facts",
      page,
      anchor: ['id="facts-section"', 'id="facts"'],
      script: ["renderFacts", '"licence"', '"origin"', "D.pool_url", "D.package.has_signature", "pk.category"],
      reads: [
        { path: pkg, fields: ["manifest.url", "manifest.licenses", "manifest.pkginfo.builddate", "pool_url", "package.has_signature", "package.size_download"] },
        { path: shipped, fields: ["package.project", "package.license", "package.category", "package.created_at"] },
      ],
      visible: EVERYONE,
    },
    {
      // You: the one card that changes with the viewer. A visitor signs in; the contributor who requested it asks for an update (the renewal, grey with the story's reason when it is not taken) and never reviews it; a maintainer blocks it with a reason on the record (a factory package: a synced one is grey with why), lifts a block another maintainer made, adopts a package the pool serves that nobody looks after, opens its review. The server refuses every act to anyone else.
      id: "package.you",
      page,
      anchor: ['id="you-section"', 'id="you"', 'id="you-who"'],
      script: ["renderYou", "signInHref()", '"Sign in with GitHub"', '"Request an update"', "You can't review your own request.", '"Adopt"', '"Block"', '"Lift the block"', '"Open review"', "req.renewable", "isMaintainer()", "Why? This goes on the record."],
      reads: [{ path: story, fields: ["request.renewable", "request.busy", "package.owner", "package.status"] }],
      acts: [
        // No reason, no block: the probes change nothing.
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/block`, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 400 } },
        { method: "POST", path: `/api/v1/factory/packages/${F.blockedPkg}/unblock`, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 400 } },
        // ours is served under m2's approval: it has its maintainer, and the probe adopts nothing.
        { method: "POST", path: `/api/v1/factory/packages/${F.publishedPkg}/adopt`, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 409 } },
      ],
      visible: EVERYONE,
    },
  ];
};
