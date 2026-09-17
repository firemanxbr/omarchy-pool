/**
 * The Journal: everything the pipeline did, newest first, and every ring's
 * history — append-only, each row an immutable release. Filters by kind
 * and status; a signed-in maintainer rolls a ring back from here.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow">Journal</p>
    <h1>Everything the pipeline did, newest first</h1>
    <p class="lede">Syncs, gates, promotions, renders, health and ABI checks, rollbacks, deploys. Each line links to the run that produced it; a ring's history is append-only.</p>
  </div>
  <form class="searchbar" onsubmit="return false"><input type="search" id="q" placeholder="filter — a package, a source, a word…" aria-label="filter the journal"><div class="choice" id="pick-kind"></div><div class="choice" id="pick-status"></div></form>
  <section>
    <div class="table-wrap"><table id="events"><thead><tr><th>Status</th><th>What</th><th>Ring</th><th>Source / arch</th><th>Summary</th><th class="num">Took</th><th>When</th></tr></thead><tbody></tbody></table></div>
    <p class="sub" id="count" style="margin-top:8px;font-size:12.5px"></p>
  </section>
  <section>
    <div class="h2row"><h2>Ring history</h2><span class="hint">head is what is served · parent the previous head · from what a promotion or rollback copied</span></div>
    <p class="sub">Pointing a ring at an earlier row is how a rollback works: a job a project worker runs — the index write, both architectures re-rendered, health-checked. A signed-in maintainer can roll back to any row still inside retention.</p>
    <p class="sub" id="rb-state" hidden></p>
    <div class="table-wrap"><table id="releases"><thead><tr><th>Release</th><th>Ring</th><th>Seq</th><th class="num">Packages</th><th>Parent</th><th>From</th><th>Note</th><th>Created</th><th></th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  skeletonRows("#events", 7, 8); skeletonRows("#releases", 9, 4);
  var KINDS = ["all", "sync", "promote", "health", "security", "fast-track", "build", "render", "rollback", "gc", "deploy", "cost"], STATUSES = ["all", "ok", "warn", "error"];
  var qs = new URLSearchParams(location.search);
  var kind = KINDS.indexOf(qs.get("kind")) >= 0 ? qs.get("kind") : "all", status = "all", q = "", EVENTS = [], LAST = null;
  function drawEvents() {
    pick("#pick-kind", KINDS, kind, function (v) { kind = v; drawEvents(); });
    pick("#pick-status", STATUSES, status, function (v) { status = v; drawEvents(); });
    var ql = q.toLowerCase(), rows = EVENTS.filter(function (e) { return (kind === "all" || e.kind === kind) && (status === "all" || e.status === status) && (!ql || [e.kind, e.ring, e.source, e.summary].join(" ").toLowerCase().indexOf(ql) >= 0); });
    pager("#events", rows, eventRow, { empty: "nothing matches", n: 25 });
    $("#count").textContent = rows.length + " of " + EVENTS.length + " events on this page · the API keeps more: /api/v1/events?limit=200&kind=…";
  }
  $("#q").oninput = function () { q = this.value; drawEvents(); };
  function loadEvents() {
    busy(fetch("/api/v1/events?limit=200", { cache: "no-store" })).then(function (r) { return r.json(); }).then(function (d) { EVENTS = (d.events || []).filter(function (e) { return e.kind !== "metrics"; }); drawEvents(); endSkeleton(); }).catch(function () { endSkeleton(); });
  }
  function drawReleases(d) {
    pager("#releases", d.releases, function (r) {
      var diff = r.parent_id ? '<a class="run" href="/diff?ring=' + r.ring + '&from=' + r.parent_id + '&to=' + r.id + '">diff</a>' : '';
      // The last cell reads the same for every viewer: every row but the head carries the button, and who may not press it sees it grey with the reason — the server's own rule, a maintainer's (POST /factory/jobs checks the role and the ring, nothing about the head). The head row says so by its pill — there is nothing to roll it back to.
      var rb = r.is_head ? '' : gate(' <button type="button" class="small-btn" data-rollback="' + r.id + '" data-ring="' + r.ring + '" title="point ' + r.ring + ' back at release ' + r.id + '" style="margin-left:8px">roll back</button>', isMaintainer(), orSignIn("a maintainer rolls back"));
      return '<tr><td>' + r.id + (r.is_head ? ' <span class="pill ok" title="what ' + esc(r.ring) + ' serves now — nothing to roll back to">head</span>' : '') + '</td><td><span style="color:var(--' + r.ring + ')">' + r.ring + '</span></td><td>#' + r.seq + '</td><td class="num">' + num(r.package_count) + '</td><td class="dim">' + (r.parent_id || '—') + '</td><td class="dim">' + (r.source_id || '—') + '</td><td class="muted">' + esc(r.note || '') + '</td><td class="when" title="' + esc(r.created_at) + '">' + ago(r.created_at) + '</td><td style="white-space:nowrap">' + diff + rb + '</td></tr>';
    }, { empty: 'no releases yet', n: 25 });
  }
  // The releases are drawn again once the viewer is known: the rollback button is grey until then, and stays grey for everyone but a maintainer. Its press is the shell's (askRollback), which asks, posts the job once and writes #rb-state.
  whoami(function (me) { if (me && LAST) drawReleases(LAST); });
  loadEvents(); setInterval(loadEvents, 60000);
  liveStats(function (d) { LAST = d; drawReleases(d); }, 60000);
`;

export function journalHtml(poolUrl: string, version: RunningVersion, path = "/journal"): string {
  return page({
    title: "Journal · omarchy-pool",
    description: "Everything the pipeline did, newest first, and every ring's append-only history.",
    active: "none",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
    path,
  });
}

/**
 * What /journal is made of: the events table and its search and chips over
 * one read of the journal, the ring history over the stats, and the
 * rollback button, drawn for everyone — the page's one act, a maintainer's.
 */
export const JOURNAL_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "journal.hero",
    page: "/journal",
    anchor: ['<p class="eyebrow">Journal</p>', "<h1>Everything the pipeline did, newest first</h1>"],
    visible: EVERYONE,
  },
  {
    id: "journal.search",
    page: "/journal",
    anchor: ['id="q"', 'aria-label="filter the journal"'],
    script: ['$("#q").oninput', '[e.kind, e.ring, e.source, e.summary].join(" ")'],
    visible: EVERYONE,
  },
  {
    id: "journal.filter-chips",
    page: "/journal",
    anchor: ['id="pick-kind"', 'id="pick-status"'],
    script: ['pick("#pick-kind", KINDS, kind', 'pick("#pick-status", STATUSES, status', 'qs.get("kind")'],
    visible: EVERYONE,
  },
  {
    id: "journal.events-table",
    page: "/journal",
    anchor: ['id="events"', 'id="count"'],
    script: ['"/api/v1/events?limit=200"', 'pager("#events", rows, eventRow', 'e.kind !== "metrics"', '"#count"'],
    reads: [
      {
        path: "/api/v1/events?limit=200",
        fields: ["events", "events.0.kind", "events.0.status", "events.0.ring", "events.0.source", "events.0.summary", "events.0.duration_ms", "events.0.created_at", "events.0.payload"],
      },
      // A promotion is the row the diff link is drawn on: it needs the release's id in its payload.
      { path: "/api/v1/events?kind=promote&limit=200", fields: ["events.0.kind", "events.0.payload.release_id"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "journal.ring-history-lede",
    page: "/journal",
    anchor: ["<h2>Ring history</h2>", "head is what is served · parent the previous head · from what a promotion or rollback copied", "A signed-in maintainer can roll back to any row still inside retention."],
    visible: EVERYONE,
  },
  {
    id: "journal.releases-table",
    page: "/journal",
    anchor: ['id="releases"'],
    script: ['pager("#releases"', "liveStats(function (d) { LAST = d; drawReleases(d); }", "r.is_head", "r.package_count", "'&from=' + r.parent_id + '&to=' + r.id", "r.source_id"],
    reads: [{ path: "/api/v1/stats", fields: ["releases", "releases.0.id", "releases.0.ring", "releases.0.seq", "releases.0.package_count", "releases.0.parent_id", "releases.0.source_id", "releases.0.note", "releases.0.created_at", "releases.0.is_head"] }],
    visible: EVERYONE,
  },
  {
    // The button is the page's, drawn on every release that is not the head for every viewer — grey with the reason in its title for anyone but a maintainer (gate); the head row says head. What a press does is the shell's (shell.rollback asks, posts once, writes #rb-state). The act is claimed here too: from this page it is a maintainer's, and the fixture proves who may.
    id: "journal.rollback-button",
    page: "/journal",
    anchor: ['id="releases"', 'id="rb-state"'],
    script: ['data-rollback="', 'data-ring="', 'isMaintainer(), orSignIn("a maintainer rolls back")', '>head</span>', 'whoami(function (me) { if (me && LAST) drawReleases(LAST); })'],
    reads: [{ path: "/auth/me", as: "maintainer", fields: ["role"] }],
    acts: [
      {
        // Queued, never run: no worker claims it in the tests, so what stable serves does not change. `to` is a string, as the button's attribute sends it and the shell posts it.
        method: "POST",
        path: "/api/v1/factory/jobs",
        body: { kind: "rollback", params: { ring: "stable", to: String(F.previousRelease), note: "the fixture's ring, back where it was" } },
        expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 201 },
      },
    ],
    visible: EVERYONE,
  },
];
