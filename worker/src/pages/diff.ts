/**
 * What changed between two releases of a ring: added, removed, upgraded —
 * the page the Journal opens, from its ring history's heading and from the
 * "diff" on every row with a parent, and what a promotion or rollback line
 * in the journal points at; the Journal is the crumb above it, the footer
 * page it is one hop from. Reads GET /releases/:ring/diff.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <p class="crumbs"><a href="/journal">Journal</a> / <span id="crumb">diff</span></p>
  <h1 id="title">Release diff</h1>
  <p class="lede" id="line">Loading…</p>
  <div class="tiles" id="tiles"></div>

  <section>
    <h2>Upgraded</h2>
    <p class="sub">Same name and architecture, another object — a downgrade shows here too, the versions tell.</p>
    <div class="table-wrap"><table id="upgraded"><thead><tr><th>Package</th><th>Arch</th><th>From</th><th>To</th><th>Source</th></tr></thead><tbody></tbody></table></div>
  </section>
  <section>
    <h2>Added</h2>
    <div class="table-wrap"><table id="added"><thead><tr><th>Package</th><th>Arch</th><th>Version</th><th>Source</th></tr></thead><tbody></tbody></table></div>
  </section>
  <section>
    <h2>Removed</h2>
    <div class="table-wrap"><table id="removed"><thead><tr><th>Package</th><th>Arch</th><th>Version</th><th>Source</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var q = new URLSearchParams(location.search);
  var ring = q.get("ring") || "stable", from = q.get("from"), to = q.get("to"), arch = q.get("arch");
  skeletonTiles("#tiles", 4); skeletonRows("#upgraded", 5, 4); skeletonRows("#added", 4, 2); skeletonRows("#removed", 4, 2);
  var url = "/api/v1/releases/" + encodeURIComponent(ring) + "/diff?" + (from ? "from=" + encodeURIComponent(from) + "&" : "") + (to ? "to=" + encodeURIComponent(to) + "&" : "") + (arch ? "arch=" + encodeURIComponent(arch) : "");
  // A row's package opens in the ring this diff is of and the row's own architecture — the shell's one address, so an edge or aarch64 row no longer lands on stable x86_64.
  var pkg = function (p) { return '<a href="' + pkgHref(p.name, ring, p.arch) + '"><b>' + esc(p.name) + '</b></a>'; };
  api("GET", url).then(function (d) {
    if (d.__status !== 200) { $("#line").textContent = d.error || "not found"; endSkeleton(); return; }
    var f = d.from ? "release " + d.from.id + " (#" + d.from.seq + ")" : "nothing";
    document.title = ring + " " + (d.from ? d.from.id : "") + " → " + d.to.id + " · omarchy-pool";
    $("#crumb").textContent = (d.from ? d.from.id : "∅") + " → " + d.to.id;
    $("#title").textContent = ring + ": " + f + " → release " + d.to.id + " (#" + d.to.seq + ")" + (arch ? " · " + arch : "");
    $("#line").innerHTML = 'Created ' + ago(d.to.created_at) + (d.to.note ? ' — <em>' + esc(d.to.note) + '</em>' : '') + (d.from ? '; the older one ' + ago(d.from.created_at) + (d.from.note ? ' — <em>' + esc(d.from.note) + '</em>' : '') : '') + '. <a class="run" href="' + esc(url) + '">JSON</a>';
    var c = d.counts;
    setTiles("#tiles", [["Upgraded", num(c.upgraded), "same name, another object"], ["Added", num(c.added), "new (name, arch) pairs"], ["Removed", num(c.removed), "gone from the selection"], ["Packages", num(c.after), "was " + num(c.before)]]);
    pager("#upgraded", d.upgraded, function (p) { return '<tr><td>' + pkg(p) + '</td><td>' + esc(p.arch) + '</td><td class="mono">' + esc(p.from) + '</td><td class="mono">' + esc(p.to) + '</td><td><span class="src">' + esc(p.source || "") + '</span></td></tr>'; }, { empty: "nothing upgraded" });
    pager("#added", d.added, function (p) { return '<tr><td>' + pkg(p) + '</td><td>' + esc(p.arch) + '</td><td class="mono">' + esc(p.version) + '</td><td><span class="src">' + esc(p.source || "") + '</span></td></tr>'; }, { empty: "nothing added" });
    pager("#removed", d.removed, function (p) { return '<tr><td>' + pkg(p) + '</td><td>' + esc(p.arch) + '</td><td class="mono">' + esc(p.version) + '</td><td><span class="src">' + esc(p.source || "") + '</span></td></tr>'; }, { empty: "nothing removed" });
    endSkeleton();
  }).catch(function (e) { $("#line").textContent = noAnswer("diff", e); });
`;

export function diffHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/diff",
    title: "Release diff · omarchy-pool",
    description: "What changed between two releases of a ring: added, removed, upgraded packages.",
    active: "none",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What /diff is made of.
 * One read feeds the whole page: the ring's head against its parent, as
 * /diff with no ids opens it (the overview's ring cards); each component
 * names the fields it draws from that answer. The lede also carries the
 * API's errors, so it declares the two the URL can provoke — a ring and
 * an architecture the pool does not have.
 */
export const DIFF_COMPONENTS = (F: Fixture): Component[] => {
  const page = "/diff";
  const head = "/api/v1/releases/stable/diff";
  return [
    {
      // The crumb's parent is the Journal, the footer page this one is a hop from; the crumb itself is the two releases, the ring being the title's first word.
      id: "diff.crumbs",
      page,
      anchor: ['class="crumbs"', '<a href="/journal">Journal</a>', 'id="crumb"'],
      script: ['$("#crumb")', 'd.from.id : "∅"', "d.to.id"],
      reads: [{ path: head, fields: ["from.id", "to.id"] }],
      visible: EVERYONE,
    },
    {
      id: "diff.title",
      page,
      anchor: ['<h1 id="title">Release diff</h1>'],
      script: ['$("#title")', "document.title", "d.from.seq", "d.to.seq", '(arch ? " · " + arch : "")'],
      reads: [
        { path: head, fields: ["from.id", "from.seq", "to.id", "to.seq"] },
        { path: `${head}?to=${F.release}&arch=${F.arch}`, fields: ["to.id", "arch"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "diff.lede",
      page,
      anchor: ['<p class="lede" id="line">'],
      script: ['$("#line")', "ago(d.to.created_at)", "d.to.note", "ago(d.from.created_at)", "d.from.note", 'd.error || "not found"', 'noAnswer("diff", e)'],
      reads: [
        { path: head, fields: ["to.created_at", "to.note", "from.created_at", "from.note"] },
        { path: "/api/v1/releases/nope/diff", status: 404, fields: ["error"] },
        { path: `${head}?arch=mips`, status: 400, fields: ["error"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "diff.json-link",
      page,
      anchor: ['id="line"'],
      script: ["esc(url)", '">JSON</a>'],
      reads: [{ path: head }],
      visible: EVERYONE,
    },
    {
      id: "diff.stat-tiles",
      page,
      anchor: ['<div class="tiles" id="tiles">'],
      script: ['skeletonTiles("#tiles", 4)', 'setTiles("#tiles"', '["Upgraded", num(c.upgraded)', '["Added", num(c.added)', '["Removed", num(c.removed)', '["Packages", num(c.after), "was " + num(c.before)]'],
      reads: [{ path: head, fields: ["counts.upgraded", "counts.added", "counts.removed", "counts.after", "counts.before"] }],
      visible: EVERYONE,
    },
    {
      id: "diff.upgraded-section",
      page,
      anchor: ["<h2>Upgraded</h2>", "a downgrade shows here too, the versions tell", 'id="upgraded"', "<th>From</th><th>To</th>"],
      script: ['skeletonRows("#upgraded", 5, 4)', 'pager("#upgraded", d.upgraded', "pkgHref(p.name, ring, p.arch)", "esc(p.from)", "esc(p.to)", '"nothing upgraded"'],
      reads: [{ path: head, fields: ["upgraded", "upgraded.0.name", "upgraded.0.arch", "upgraded.0.from", "upgraded.0.to", "upgraded.0.source"] }],
      visible: EVERYONE,
    },
    {
      id: "diff.added-section",
      page,
      anchor: ["<h2>Added</h2>", 'id="added"', "<th>Version</th>"],
      script: ['skeletonRows("#added", 4, 2)', 'pager("#added", d.added', "esc(p.version)", '"nothing added"'],
      reads: [{ path: head, fields: ["added", "added.0.name", "added.0.arch", "added.0.version", "added.0.source"] }],
      visible: EVERYONE,
    },
    {
      id: "diff.removed-section",
      page,
      anchor: ["<h2>Removed</h2>", 'id="removed"'],
      script: ['skeletonRows("#removed", 4, 2)', 'pager("#removed", d.removed', 'class="src"', '"nothing removed"'],
      reads: [{ path: head, fields: ["removed", "removed.0.name", "removed.0.arch", "removed.0.version", "removed.0.source"] }],
      visible: EVERYONE,
    },
  ];
};
