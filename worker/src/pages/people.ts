/**
 * The people and the machines: every maintainer named in
 * factory/MAINTAINERS.toml, every contributor with a registered package or a
 * worker, every worker registration that is not revoked — the workers in
 * the shell's rows, by whose they are (the project's, the review ones, the
 * contributors'), so a worker reads here as it reads on the Workers page
 * and on its owner's. Linked from the footer and from the Pool's "Made in
 * the open" numbers; each name leads to its profile.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="h2row"><h1>People</h1><a class="more-link" href="/docs/governance">How one becomes a maintainer →</a></div>
  <p class="sub">Everyone on the pool's record — and the machines that build. No accounts beyond a GitHub login, nothing kept that the pool does not need.</p>
  <div class="tiles" id="tiles"></div>

  <section id="maintainers">
    <div class="h2row"><h2>Maintainers</h2><span class="hint">named in <code>factory/MAINTAINERS.toml</code></span></div>
    <p class="sub">They have the project build what contributors stage, approve its builds, trust workers, settle categories and review the project's recipes. The green icon is theirs everywhere on the dashboard.</p>
    <div class="people" id="maintainers-list"><span class="muted">loading…</span></div>
  </section>

  <section id="contributors">
    <div class="h2row"><h2>Contributors</h2><a class="more-link" href="/request">Bring a package →</a></div>
    <p class="sub">Anyone who registered a package or a worker. Their builds are evidence; a maintainer decides.</p>
    <div class="people" id="contributors-list"><span class="muted">loading…</span></div>
  </section>

  <section id="workers">
    <div class="h2row"><h2>Workers</h2><a class="more-link" href="/docs/workers">Run one →</a></div>
    <p class="sub">The machines that build, by whose they are: the project's on the host a maintainer keeps, the review ones trusted on two maintainers' word, the contributors' own. Every registration, seen lately or not, its state in one word.</p>
    <div class="panel"><h3>Project <span class="dim" style="font-size:12px;font-weight:400">the pool's own jobs, on the host a maintainer keeps</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-project" class="wtable"><thead><tr></tr></thead><tbody></tbody></table></div></div>
    <div class="panel" style="margin-top:16px"><h3>Review <span class="dim" style="font-size:12px;font-weight:400">the maintainers' side: builds again, publishes, audits</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-review" class="wtable"><thead><tr></tr></thead><tbody></tbody></table></div></div>
    <div class="panel" style="margin-top:16px"><h3>Contributors <span class="dim" style="font-size:12px;font-weight:400">their own machines: their packages, or whatever is queued when shared</span></h3>
      <div class="table-wrap" style="border:0"><table id="w-community" class="wtable"><thead><tr></tr></thead><tbody></tbody></table></div></div>
    <div id="wt-legend"></div>
  </section>
`;

const SCRIPT = String.raw`
  skeletonTiles("#tiles", 4); skeletonRows("#w-project", 8, 2); skeletonRows("#w-review", 9, 2); skeletonRows("#w-community", 10, 2);
  $("#w-project thead tr").innerHTML = WT_HEAD.project; $("#w-review thead tr").innerHTML = WT_HEAD.review; $("#w-community thead tr").innerHTML = WT_HEAD.community; $("#wt-legend").innerHTML = WT_LEGEND;
  // The four reads and the session start together; the page draws once both have answered, since the one thing on a worker's row that depends on who is looking — the log icon, live for its owner and the maintainers, grey for everyone else — is drawn from the session.
  Promise.all([
    busy(fetch("/api/v1/factory/maintainers")).then(function (r) { return r.json(); }).catch(function () { return { maintainers: [] }; }),
    busy(fetch("/api/v1/factory/packages")).then(function (r) { return r.json(); }).catch(function () { return { packages: [] }; }),
    busy(fetch("/api/v1/factory?limit=10")).then(function (r) { return r.json(); }).catch(function () { return { workers: [] }; }),
    busy(fetch("/api/v1/factory/blocks")).then(function (r) { return r.json(); }).catch(function () { return { contributors: [] }; })
  ]).then(function (res) { whoami(function () { draw(res); }); });
  function draw(res) {
    var listed = res[0].maintainers || [], pkgs = res[1].packages || [], workers = res[2].workers || [], blocked = {};
    (res[3].contributors || []).forEach(function (b) { blocked[b.login] = b.blocked_reason || ""; });
    // Maintainers: per login, since when.
    var maint = {};
    listed.forEach(function (m) { maint[m.login] = m.since; });
    // Contributors: per login, packages registered and workers run — a maintainer is listed once, above.
    var contrib = {};
    pkgs.forEach(function (p) { if (p.owner && !maint[p.owner]) { var c = contrib[p.owner] = contrib[p.owner] || { packages: 0, landed: 0, workers: 0 }; c.packages++; if (p.status === "approved" || p.status === "published") c.landed++; } });
    workers.forEach(function (w) { if (w.owner && !maint[w.owner]) { var c = contrib[w.owner] = contrib[w.owner] || { packages: 0, landed: 0, workers: 0 }; c.workers++; } });
    // Alive is a heartbeat in the last ten minutes; ready is alive and, where the work needs one, an agent that answered — the listing's own words.
    var alive = workers.filter(function (w) { return w.alive; }), ready = workers.filter(function (w) { return w.ready; });
    setTiles("#tiles", [
      ["Maintainers", num(Object.keys(maint).length), "every one reviews everything"],
      ["Contributors", num(Object.keys(contrib).length), num(pkgs.length) + " packages requested"],
      ["Workers ready", num(ready.length), num(alive.length) + " alive · " + num(workers.length) + " registered · " + num(ready.filter(function (w) { return w.side === "omarchy"; }).length) + " the project's", ready.length < alive.length ? "warn" : ""],
      ["Community packages", num(pkgs.filter(function (p) { return p.status === "approved" || p.status === "published"; }).length), "approved by a maintainer, built by the project"]
    ]);
    $("#maintainers-list").innerHTML = Object.keys(maint).sort().map(function (m) { return personChip(m, "maintainer", "since " + esc(ago(maint[m]))); }).join("") || '<span class="muted">none yet</span>';
    $("#contributors-list").innerHTML = Object.keys(contrib).sort().map(function (c) {
      var x = contrib[c], bits = [];
      if (x.packages) bits.push(x.packages + " package" + (x.packages === 1 ? "" : "s") + (x.landed ? " · " + x.landed + " landed" : ""));
      if (x.workers) bits.push(x.workers + " worker" + (x.workers === 1 ? "" : "s"));
      var extra = esc(bits.join(" · "));
      if (c in blocked) extra += (extra ? " " : "") + '<span class="pill error" title="' + esc(blocked[c]) + '">blocked</span>';
      return personChip(c, "contributor", extra);
    }).join("") || '<span class="muted">be the first — <a href="/request">bring a package</a></span>';
    // The workers, by whose they are, in the shell's rows: every registration the listing has, alive or not.
    var kinds = { project: [], review: [], community: [] };
    workers.forEach(function (w) { kinds[wtKind(w)].push(w); });
    var text = function (w) { return [w.id, w.owner, w.arch, w.version, w.mode, w.agent, w.trusted_by, w.last_task && w.last_task.name, JSON.stringify(w.labels || {})].join(" "); };
    pager("#w-project", kinds.project, function (w) { return workerRow(w, "project"); }, { empty: "no project worker registered", text: text });
    pager("#w-review", kinds.review, function (w) { return workerRow(w, "review"); }, { empty: "no review worker registered", text: text });
    pager("#w-community", kinds.community, function (w) { return workerRow(w, "community"); }, { empty: "no contributor's worker registered yet", text: text });
    endSkeleton();
  }
`;

export function peopleHtml(poolUrl: string, version: RunningVersion, path = "/people"): string {
  return page({
    title: "People · omarchy-pool",
    description: "The maintainers, contributors and workers of the Omarchy pool — everyone on the record.",
    active: "pool",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
    path,
  });
}

/**
 * What /people is made of.
 * Four public reads, no act, and the same tiles, chips and tables for
 * everyone. The worker tables are the shell's rows by kind, as on the
 * Workers page and a person's; the log icon on a row is the one thing here
 * that changes with the viewer — live for the worker's owner and the
 * maintainers, grey for everyone else, never dropped. The section ids are
 * the targets the Pool's "Made in the open" tiles link to, so each section
 * head keeps its anchor.
 */
export const PEOPLE_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "people.hero",
    page: "/people",
    anchor: ["<h1>People</h1>", 'href="/docs/governance">How one becomes a maintainer →</a>'],
    visible: EVERYONE,
  },
  {
    id: "people.tiles",
    page: "/people",
    anchor: ['id="tiles"'],
    script: ['skeletonTiles("#tiles", 4)', 'setTiles("#tiles"', '"Workers ready"', '" alive · "', '" registered · "', '"Community packages"', 'w.side === "omarchy"'],
    reads: [
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.owner", "packages.0.status"] },
      { path: "/api/v1/factory?limit=10", fields: ["workers", "workers.0.owner", "workers.0.alive", "workers.0.ready", "workers.0.side"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "people.maintainers-head",
    page: "/people",
    anchor: ['<section id="maintainers">', "factory/MAINTAINERS.toml"],
    visible: EVERYONE,
  },
  {
    id: "people.maintainers-list",
    page: "/people",
    anchor: ['id="maintainers-list"'],
    script: ['"/api/v1/factory/maintainers"', '"#maintainers-list"', "m.since", 'personChip(m, "maintainer"'],
    reads: [{ path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login", "maintainers.0.since"] }],
    visible: EVERYONE,
  },
  {
    id: "people.contributors-head",
    page: "/people",
    anchor: ['<section id="contributors">', 'href="/request">Bring a package →</a>'],
    visible: EVERYONE,
  },
  {
    id: "people.contributors-list",
    page: "/people",
    anchor: ['id="contributors-list"'],
    script: ['"/api/v1/factory/packages"', '"/api/v1/factory?limit=10"', '"#contributors-list"', 'p.status === "approved" || p.status === "published"', 'personChip(c, "contributor"', 'href="/request">bring a package</a>'],
    reads: [
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.owner", "packages.0.status"] },
      { path: "/api/v1/factory?limit=10", fields: ["workers", "workers.0.owner"] },
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      { path: "/api/v1/factory/blocks", fields: ["contributors"] },
    ],
    visible: EVERYONE,
  },
  {
    // The pill sits inside a contributor's chip; its row is the block, from the one read the list does not draw itself.
    id: "people.contributor-blocked-pill",
    page: "/people",
    anchor: ['id="contributors-list"'],
    script: ['"/api/v1/factory/blocks"', "blocked[b.login] = b.blocked_reason", '>blocked</span>'],
    reads: [{ path: "/api/v1/factory/blocks", fields: ["contributors", "contributors.0.login", "contributors.0.blocked_reason"] }],
    visible: EVERYONE,
  },
  {
    id: "people.workers-head",
    page: "/people",
    anchor: ['<section id="workers">', 'href="/docs/workers">Run one →</a>', "The machines that build, by whose they are"],
    visible: EVERYONE,
  },
  {
    // The three tables are one component — the same read, the shell's head and row per kind — as on the Workers page.
    id: "people.workers-table",
    page: "/people",
    anchor: ['id="w-project"', 'id="w-review"', 'id="w-community"'],
    script: ['"/api/v1/factory?limit=10"', '"#w-project"', '"#w-review"', '"#w-community"', "WT_HEAD.project", "kinds[wtKind(w)]", 'workerRow(w, "project")', 'workerRow(w, "review")', 'workerRow(w, "community")'],
    reads: [
      {
        path: "/api/v1/factory?limit=10",
        fields: [
          "workers", "workers.0.id", "workers.0.owner", "workers.0.side", "workers.0.trust", "workers.0.labels", "workers.0.hostname", "workers.0.kinds", "workers.0.trusted_by", "workers.0.trust_proposed_by",
          "workers.0.alive", "workers.0.last_seen", "workers.0.current_task", "workers.0.ready", "workers.0.update.required", "workers.0.update.latest",
          "workers.0.arch", "workers.0.version", "workers.0.mode", "workers.0.packages",
          "workers.0.agent", "workers.0.agent_status", "workers.0.agent_checked_at", "workers.0.agent_error",
          "workers.0.usage", "workers.0.usage_at", "workers.0.builds_done", "workers.0.builds_failed",
          "workers.0.last_task", "workers.0.last_task.id", "workers.0.last_task.kind", "workers.0.last_task.name", "workers.0.last_task.status", "workers.0.last_task.at",
        ],
      },
    ],
    visible: EVERYONE,
  },
  {
    // The shell's log icon on every row: live for the worker's owner and the maintainers, grey with the pool's refusal for everyone else — so the rows are drawn once the session is known.
    id: "people.log",
    page: "/people",
    anchor: ['id="w-project"', 'id="w-community"'],
    script: ["workerRow(w", "whoami(function () { draw(res); })"],
    reads: [
      { path: `/api/v1/factory/workers/${F.worker}/log`, status: 401 },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "contributor", status: 403 },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "owner", status: 403 },
      { path: `/api/v1/factory/workers/${F.communityWorker}/log`, as: "owner", fields: ["id", "log", "at"] },
      { path: `/api/v1/factory/workers/${F.worker}/log`, as: "maintainer", fields: ["id", "log", "at"] },
      { path: `/api/v1/factory/workers/${F.communityWorker}/log`, as: "maintainer", fields: ["id", "log", "at"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "people.legend",
    page: "/people",
    anchor: ['id="wt-legend"'],
    script: ['"#wt-legend"', "WT_LEGEND"],
    visible: EVERYONE,
  },
];
