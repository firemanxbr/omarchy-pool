/**
 * Workers: every machine that builds for the pool and whose it is — the
 * project's (pool jobs and review builds on its host) and the contributors'
 * (their own packages, or shared). Public, from /api/v1/factory; the page
 * to open when a queue looks slow. Running one is a chapter of the docs.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Workers</p>
    <h1>The machines that build, and whose they are</h1>
    <p class="lede">One image, two sides: the project's workers take the pool's jobs and its review builds; a contributor's build their own packages, or whatever is queued when they share it. <em>Alive</em> is seen in the last ten minutes. <a href="/docs/workers">Run one →</a></p>
  </div>

  <div class="tiles four" id="tiles"></div>

  <section>
    <div class="h2row"><h2>Omarchy workers</h2><span class="dim" style="font-size:13px">the project's host · trusted by a maintainer</span></div>
    <div class="table-wrap"><table id="workers"><thead><tr><th>Worker</th><th>Role</th><th>Arch</th><th>Where</th><th>Trusted by</th><th>Agent</th><th>Building</th><th>Done / failed</th><th>Last seen</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Community workers</h2><label class="dim" style="font-size:13px"><input type="checkbox" id="all-workers"> show workers not seen recently</label></div>
    <div class="table-wrap"><table id="cworkers"><thead><tr><th>Worker</th><th>Owner</th><th>Arch</th><th>Builds</th><th>Agent</th><th>Building</th><th>Done / failed</th><th>Last seen</th></tr></thead><tbody></tbody></table></div>
  </section>

  <div class="gate"><div><h3>Run one of your own</h3><p>The signed image, Docker Desktop or Podman, a token from your <a href="/factory">workspace</a>: it builds only your packages, with your agent, and your builds skip the queue.</p></div><a class="btn ghost" href="/docs/workers">Run a worker →</a></div>
`;

const SCRIPT = String.raw`
  var FACTORY = null;
  skeletonTiles("#tiles", 4); skeletonRows("#workers", 9, 2); skeletonRows("#cworkers", 8, 2);
  // The role a worker reported in its labels (OMARCHY_WORKER_ROLE), or what its trust implies.
  function roleCell(w) {
    var r = w.labels && w.labels.role;
    if (r === "pool" || r === "review" || r === "community") return '<span class="pill">' + esc(r) + '</span>';
    return '<span class="muted">' + (w.trust === "project" ? "pool + review" : "own packages") + '</span>';
  }
  function person(l) { return l ? '<a href="/user/' + encodeURIComponent(l) + '">' + esc(l) + '</a>' : '<span class="muted">—</span>'; }
  function building(w) { return w.current_task ? '<a class="run" href="/pipeline">#' + w.current_task + '</a>' : '<span class="muted">idle</span>'; }
  function render(d) {
    FACTORY = d;
    var showAll = $("#all-workers").checked;
    var alive = d.workers.filter(function (w) { return w.alive; }), busyW = alive.filter(function (w) { return w.current_task; });
    var omarchy = d.workers.filter(function (w) { return w.side === "omarchy"; }), community = d.workers.filter(function (w) { return w.side === "community"; });
    setTiles("#tiles", [
      ["Alive", num(alive.length) + " / " + num(d.workers.length), "seen in the last ten minutes", alive.length ? "ok" : "warn"],
      ["Building now", num(busyW.length), busyW.length ? busyW.map(function (w) { return "#" + w.current_task; }).join(" · ") : "every worker idle"],
      ["Omarchy", num(omarchy.filter(function (w) { return w.alive; }).length) + " / " + num(omarchy.length), "the project's: pool jobs, review builds"],
      ["Community", num(community.filter(function (w) { return w.alive; }).length) + " / " + num(community.length), "contributors' own machines"]
    ]);
    pager("#workers", omarchy.filter(function (w) { return showAll || w.alive; }), function (w) {
      var where = w.labels && w.labels.where ? w.labels.where : (w.hostname || "—");
      return '<tr><td>' + workerName(w) + (w.alive ? ' <span class="pill ok">alive</span>' : '') + '</td><td>' + roleCell(w) + '</td><td>' + esc(w.arch) + '</td><td>' + esc(where) + (w.version ? ' <span class="muted">pkg-repo ' + esc(w.version) + '</span>' : '') + '</td>' +
        '<td>' + (w.trusted_by ? person(w.trusted_by) : '<span class="muted">—</span>') + '</td><td>' + agentCell(w) + '</td><td>' + building(w) + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td><td>' + ago(w.last_seen) + '</td></tr>';
    }, { empty: showAll ? "no Omarchy worker registered" : "no Omarchy worker alive — the project's host is off; pool jobs wait", text: function (w) { return w.id + " " + w.arch + " " + (w.trusted_by || "") + " " + JSON.stringify(w.labels || {}); } });
    pager("#cworkers", community.filter(function (w) { return showAll || w.alive; }), function (w) {
      var what = w.mode === "shared" ? '<span class="pill blue">shared</span> <span class="muted">whatever is queued</span>' : (w.packages && w.packages.length ? '<span class="muted">' + esc(w.packages.join(", ")) + '</span>' : '<span class="muted">own packages</span>');
      return '<tr><td>' + workerName(w) + (w.alive ? ' <span class="pill ok">alive</span>' : '') + '</td><td>' + person(w.owner) + '</td><td>' + esc(w.arch) + '</td><td>' + what + '</td><td>' + agentCell(w) + '</td>' +
        '<td>' + building(w) + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td><td>' + ago(w.last_seen) + '</td></tr>';
    }, { empty: showAll ? "no community worker registered yet" : "no community worker alive right now", text: function (w) { return w.id + " " + (w.owner || "") + " " + w.arch + " " + w.mode; } });
    endSkeleton();
  }
  function load() { busy(fetch("/api/v1/factory?limit=10")).then(function (r) { return r.json(); }).then(render).catch(function () { endSkeleton(); }); }
  $("#all-workers").onchange = function () { if (FACTORY) render(FACTORY); };
  load();
  setInterval(load, 20000);
`;

export function workersHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Workers · omarchy-pool",
    description: "Every worker building for the pool — the project's and the contributors' — alive or gone, what it is building, what it has built.",
    active: "none",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
