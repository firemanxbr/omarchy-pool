/**
 * The people and the machines: every maintainer named in
 * factory/MAINTAINERS.toml, every contributor with a registered package or a
 * worker, every worker registration that is not revoked — the workers in
 * the shell's rows, by whose they are (the project's, the review ones, the
 * contributors'), so a worker reads here as it reads on the Workers page
 * and on its owner's. Linked from the footer and from the Pool's "Made in
 * the open" numbers; each name leads to its profile.
 */
import { page, workerPanels } from "./layout";
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
    <div class="h2row"><h2>Workers</h2><a class="more-link" href="/workers">Every worker, how busy →</a></div>
    <p class="sub">Every registration, seen lately or not, its state in one word.</p>
    ${workerPanels([
      { kind: "project", blurb: "the pool's own jobs, on the host a maintainer keeps" },
      { kind: "review", blurb: "the maintainers' side: builds again, publishes, audits — trusted on two maintainers' word" },
      { kind: "community", blurb: "their own machines: their packages, or whatever is queued when shared" },
    ])}
  </section>
`;

const SCRIPT = String.raw`
  skeletonTiles("#tiles", 4); wtTables();
  // The maintainer set (the shell's one read: maintainerSet, login → since), three reads and the session start together; the page draws once all have answered, since the one thing on a worker's row that depends on who is looking — the log icon, live for its owner and the maintainers, grey for everyone else — is drawn from the session.
  Promise.all([
    busy(new Promise(function (ok) { maintainerSet(ok); })),
    busy(fetch("/api/v1/factory/packages")).then(function (r) { return r.json(); }).catch(function () { return { packages: [] }; }),
    busy(fetch("/api/v1/factory?limit=10")).then(function (r) { return r.json(); }).catch(function () { return { workers: [] }; }),
    busy(fetch("/api/v1/factory/blocks")).then(function (r) { return r.json(); }).catch(function () { return { contributors: [] }; })
  ]).then(function (res) { whoami(function () { draw(res); }); });
  function draw(res) {
    // Maintainers: per login, since when — the set as the shell holds it.
    var maint = res[0] || {}, pkgs = res[1].packages || [], workers = res[2].workers || [], blocked = {};
    (res[3].contributors || []).forEach(function (b) { blocked[b.login] = b.blocked_reason || ""; });
    // Contributors: per login, packages registered and workers run — a maintainer is listed once, above; landed is the registry's own word (the flag the Pool's, the Factory's and the Pipeline's numbers count).
    var contrib = {}, isM = function (l) { return Object.prototype.hasOwnProperty.call(maint, l); };
    pkgs.forEach(function (p) { if (p.owner && !isM(p.owner)) { var c = contrib[p.owner] = contrib[p.owner] || { packages: 0, landed: 0, workers: 0 }; c.packages++; if (p.landed) c.landed++; } });
    workers.forEach(function (w) { if (w.owner && !isM(w.owner)) { var c = contrib[w.owner] = contrib[w.owner] || { packages: 0, landed: 0, workers: 0 }; c.workers++; } });
    // The counts are the shell's (workerCounts), the listing's words: alive is a heartbeat in the last ten minutes — the word and the number the Pool's tile sends a reader here with, and the Workers page's first tile; ready is alive and, where the work needs one, an agent that answered; the project's are the project and review kinds.
    var wc = workerCounts(workers);
    setTiles("#tiles", [
      ["Maintainers", num(Object.keys(maint).length), "every one reviews everything"],
      ["Contributors", num(Object.keys(contrib).length), num(pkgs.length) + " packages requested"],
      ["Workers alive", num(wc.alive) + " / " + num(wc.registered), num(wc.ready) + " ready · " + num(wc.byKind.project.ready + wc.byKind.review.ready) + " the project's", wc.ready < wc.alive ? "warn" : ""],
      ["Community packages", num(pkgs.filter(function (p) { return p.landed; }).length), "approved by a maintainer, built by the project"]
    ]);
    $("#maintainers-list").innerHTML = Object.keys(maint).sort().map(function (m) { return personChip(m, "maintainer", maint[m] ? "since " + esc(ago(maint[m])) : ""); }).join("") || '<span class="muted">none yet</span>';
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
    pager("#w-project", kinds.project, function (w) { return workerRow(w, "project"); }, { empty: "no project worker registered", text: wtText });
    pager("#w-review", kinds.review, function (w) { return workerRow(w, "review"); }, { empty: "no review worker registered", text: wtText });
    pager("#w-community", kinds.community, function (w) { return workerRow(w, "community"); }, { empty: "no contributor's worker registered yet", text: wtText });
    endSkeleton();
  }
`;

export function peopleHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/people",
    title: "People · omarchy-pool",
    description: "The maintainers, contributors and workers of the Omarchy pool — everyone on the record.",
    active: "none",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What /people is made of.
 * The shell's maintainer set and three public reads, no act, and the same
 * tiles, chips and tables for everyone; the worker counts on the tiles are
 * the shell's, as on the Pool and the Workers page. The worker tables are
 * the shell's rows by kind, as on the Workers page and a person's; the log
 * icon on a row is the one thing here that changes with the viewer — live
 * for the worker's owner and the maintainers, grey for everyone else, never
 * dropped. The section ids are the targets the Pool's "Made in the open"
 * tiles link to, so each section head keeps its anchor.
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
    // The worker counts are the shell's (workerCounts over the listing), the same the Pool's and the Workers page's tiles say; the maintainer set the shell's one read.
    script: ['skeletonTiles("#tiles", 4)', 'setTiles("#tiles"', "workerCounts(workers)", '"Workers alive"', "wc.alive", "wc.registered", '" ready · "', "wc.byKind.project.ready + wc.byKind.review.ready", '" the project\'s"', '"Community packages"', "p.landed"],
    reads: [
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.owner", "packages.0.status", "packages.0.landed"] },
      { path: "/api/v1/factory?limit=10", fields: ["workers", "workers.0.owner", "workers.0.alive", "workers.0.ready", "workers.0.revoked_at", "workers.0.side", "workers.0.labels"] },
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
    // The list is the shell's maintainer set (maintainerSet: one read of GET /api/v1/factory/maintainers per page, login → since).
    script: ["maintainerSet(ok)", '"#maintainers-list"', '"since "', "maint[m]", 'personChip(m, "maintainer"'],
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
    script: ['"/api/v1/factory/packages"', '"/api/v1/factory?limit=10"', '"#contributors-list"', "if (p.landed) c.landed++", 'personChip(c, "contributor"', 'href="/request">bring a package</a>'],
    reads: [
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.owner", "packages.0.status", "packages.0.landed"] },
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
    // The section's one link is the page whose tables these are: the Workers page has the load, the minutes and the ones not seen recently.
    id: "people.workers-head",
    page: "/people",
    anchor: ['<section id="workers">', 'href="/workers">Every worker, how busy →</a>', "Every registration, seen lately or not, its state in one word."],
    visible: EVERYONE,
  },
  {
    // The three tables are one component — the same read, the shell's panels, head and row per kind — as on the Workers page and a person's.
    id: "people.workers-table",
    page: "/people",
    shared: "worker-table",
    anchor: ['id="w-project"', 'id="w-review"', 'id="w-community"'],
    script: ['"/api/v1/factory?limit=10"', 'wtTables()', '"#w-project"', '"#w-review"', '"#w-community"', "kinds[wtKind(w)]", 'workerRow(w, "project")', 'workerRow(w, "review")', 'workerRow(w, "community")', "text: wtText"],
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
    shared: "worker-legend",
    anchor: ['id="wt-legend"'],
    script: ["wtTables()"],
    visible: EVERYONE,
  },
];
