/**
 * The people and the machines: every maintainer named in
 * factory/MAINTAINERS.toml, every contributor with a registered package or a
 * worker, every worker registration that is not revoked. Linked from the
 * Pool's "Made in the open" numbers; each name leads to its profile.
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
    <div class="h2row"><h2>Contributors</h2><a class="more-link" href="/factory">Bring a package →</a></div>
    <p class="sub">Anyone who registered a package or a worker. Their builds are evidence; a maintainer decides.</p>
    <div class="people" id="contributors-list"><span class="muted">loading…</span></div>
  </section>

  <section id="workers">
    <div class="h2row"><h2>Workers</h2><a class="more-link" href="/docs/workers">Run one →</a></div>
    <p class="sub">The machines that build: the project's (trusted by a maintainer) and contributors' own. <em>Ready</em> means a heartbeat in the last ten minutes and, for a worker that builds or audits, an agent that answered its last probe — a key set is not an agent that works.</p>
    <div class="table-wrap"><table id="workers-table"><thead><tr><th>Worker</th><th>Arch</th><th>Side</th><th>Owner</th><th>Agent</th><th>Ready</th><th>Now</th><th>Last seen</th><th>Done / failed</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  skeletonTiles("#tiles", 4);
  Promise.all([
    busy(fetch("/api/v1/factory/maintainers")).then(function (r) { return r.json(); }).catch(function () { return { maintainers: [] }; }),
    busy(fetch("/api/v1/factory/packages")).then(function (r) { return r.json(); }).catch(function () { return { packages: [] }; }),
    busy(fetch("/api/v1/factory")).then(function (r) { return r.json(); }).catch(function () { return { workers: [] }; }),
    busy(fetch("/api/v1/factory/blocks")).then(function (r) { return r.json(); }).catch(function () { return { contributors: [] }; })
  ]).then(function (res) {
    var listed = res[0].maintainers || [], pkgs = res[1].packages || [], workers = res[2].workers || [], blocked = {};
    (res[3].contributors || []).forEach(function (b) { blocked[b.login] = b.blocked_reason || ""; });
    // Maintainers: per login, since when.
    var maint = {};
    listed.forEach(function (m) { maint[m.login] = m.since; });
    // Contributors: per login, packages registered and workers run — a maintainer is listed once, above.
    var contrib = {};
    pkgs.forEach(function (p) { if (p.owner && !maint[p.owner]) { var c = contrib[p.owner] = contrib[p.owner] || { packages: 0, landed: 0, workers: 0 }; c.packages++; if (p.status === "approved" || p.status === "published") c.landed++; } });
    workers.forEach(function (w) { if (w.owner && !maint[w.owner]) { var c = contrib[w.owner] = contrib[w.owner] || { packages: 0, landed: 0, workers: 0 }; c.workers++; } });
    var online = workers.filter(function (w) { return w.alive; }), ready = workers.filter(function (w) { return w.ready; });
    setTiles("#tiles", [
      ["Maintainers", num(Object.keys(maint).length), "every one reviews everything"],
      ["Contributors", num(Object.keys(contrib).length), num(pkgs.length) + " packages requested"],
      ["Workers ready", num(ready.length), num(online.length) + " online · " + num(workers.length) + " registered · " + num(ready.filter(function (w) { return w.side === "omarchy"; }).length) + " the project's", ready.length < online.length ? "warn" : ""],
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
    }).join("") || '<span class="muted">be the first — <a href="/factory">bring a package</a></span>';
    // Ready means: alive, and — for a worker that builds or audits — an
    // agent that answered the last probe. A key set is not an agent that
    // works; a worker whose agent is down is shown, and gets no agent work.
    var tb = $("#workers-table tbody");
    tb.innerHTML = workers.map(function (w) {
      var where = w.labels && w.labels.where ? ' <span class="dim">· ' + esc(String(w.labels.where)) + '</span>' : '';
      var kinds = w.kinds || [], needsAgent = kinds.indexOf("audit") >= 0 || (kinds.indexOf("build") >= 0 && w.side !== "omarchy");
      var agent = !w.agent ? '<span class="dim">none</span>' : '<span class="mono" style="font-size:12px">' + esc(w.agent) + '</span>' +
        (w.agent_status === "ok" ? ' <span class="pill ok" title="answered the probe ' + esc(w.agent_checked_at ? ago(w.agent_checked_at) : "") + '">answers</span>' :
         w.agent_status === "error" ? ' <span class="pill error" title="' + esc(w.agent_error || "") + '">not answering</span>' : ' <span class="pill none">not probed</span>');
      var readyCell = !w.alive ? '<span class="pill none">offline</span>' : w.ready ? '<span class="pill ok">ready</span>' : '<span class="pill error" title="' + esc(w.agent_error || (needsAgent ? "builds and audits need an agent that answers" : "")) + '">not ready</span>';
      var now = !w.alive ? '<span class="dim">—</span>' : w.current_task ? '<span class="pill warn">building #' + esc(String(w.current_task)) + '</span>' : '<span class="dim">idle · ' + esc(kinds.length ? kinds.join(", ") : (w.side === "omarchy" ? "jobs" : "builds")) + '</span>';
      return '<tr><td>' + workerName(w) + where + '</td><td>' + esc(w.arch) + '</td><td>' + (w.side === "omarchy" ? '<span class="pill ok">project</span>' : '<span class="pill none">community</span>') + '</td>' +
        '<td>' + (w.owner ? '<a href="/user/' + encodeURIComponent(w.owner) + '">' + esc(w.owner) + '</a>' : '<span class="dim">—</span>') + '</td>' +
        '<td>' + agent + '</td><td>' + readyCell + '</td><td>' + now + '</td>' +
        '<td class="dim">' + ago(w.last_seen) + '</td><td class="num">' + num(w.builds_done || 0) + ' / ' + num(w.builds_failed || 0) + '</td></tr>';
    }).join("") || '<tr><td colspan="9" class="muted">no worker registered yet</td></tr>';
  });
`;

export function peopleHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "People · omarchy-pool",
    description: "The maintainers, contributors and workers of the Omarchy pool — everyone on the record.",
    active: "pool",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What /people is made of.
 * The page is role-blind: four public reads, no act, and the same tiles,
 * chips and table for everyone. The section ids are the targets the Pool's
 * "Made in the open" tiles link to, so each section head keeps its anchor.
 */
export const PEOPLE_COMPONENTS = (_F: Fixture): Component[] => [
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
    script: ['skeletonTiles("#tiles", 4)', 'setTiles("#tiles"', '"Workers ready"', '"Community packages"', 'w.side === "omarchy"'],
    reads: [
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.owner", "packages.0.status"] },
      { path: "/api/v1/factory", fields: ["workers", "workers.0.owner", "workers.0.alive", "workers.0.ready", "workers.0.side"] },
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
    anchor: ['<section id="contributors">', 'href="/factory">Bring a package →</a>'],
    visible: EVERYONE,
  },
  {
    id: "people.contributors-list",
    page: "/people",
    anchor: ['id="contributors-list"'],
    script: ['"/api/v1/factory/packages"', '"/api/v1/factory"', '"#contributors-list"', 'p.status === "approved" || p.status === "published"', 'personChip(c, "contributor"'],
    reads: [
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.owner", "packages.0.status"] },
      { path: "/api/v1/factory", fields: ["workers", "workers.0.owner"] },
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
    anchor: ['<section id="workers">', 'href="/docs/workers">Run one →</a>', "<em>Ready</em> means a heartbeat in the last ten minutes"],
    visible: EVERYONE,
  },
  {
    id: "people.workers-table",
    page: "/people",
    anchor: ['id="workers-table"', "<th>Ready</th><th>Now</th><th>Last seen</th><th>Done / failed</th>"],
    script: ['"/api/v1/factory"', '"#workers-table tbody"', "w.agent_status", "w.current_task", "w.builds_failed", 'colspan="9"'],
    reads: [
      {
        path: "/api/v1/factory",
        fields: [
          "workers", "workers.0.id", "workers.0.owner", "workers.0.arch", "workers.0.labels", "workers.0.side", "workers.0.kinds",
          "workers.0.agent", "workers.0.agent_status", "workers.0.agent_checked_at", "workers.0.agent_error",
          "workers.0.alive", "workers.0.ready", "workers.0.current_task", "workers.0.last_seen", "workers.0.builds_done", "workers.0.builds_failed",
        ],
      },
    ],
    visible: EVERYONE,
  },
];
