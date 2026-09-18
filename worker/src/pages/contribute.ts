/**
 * The Factory: the door for contributors. How a package gets in (drawn as the
 * assembly line it is), the three steps, what landed lately and how far it
 * got, the factory's numbers. Nothing here needs an account: the workspace —
 * packages, workers, builds — is the person's own page, where "Sign in with
 * GitHub" lands.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { GITHUB_ICON } from "./layout";
import { CHARTS } from "./charts";
import { factoryDiagram } from "./diagrams";

const BODY = String.raw`
  <div class="hero">
    <p class="eyebrow">For contributors</p>
    <h1>Package what you love. The factory builds it, a maintainer checks it.</h1>
    <p class="lede">Request a package and build it — on the shared workers or on your own. Your build is the evidence; the pool makes the one users get, and a maintainer approves it. A GitHub account is all that is asked.</p>
  </div>

  <div class="tiles five" id="tiles"></div>

  <section id="how">
    <div class="h2row"><h2>How a package gets in</h2><a class="more-link" href="/docs/how-it-works#people">What the pool does for you →</a></div>
    <p class="sub">Nobody knows better than you how your software should be built. The pool learns from your build — how you made it, the numbers it produced, the failures you got past — and the community makes better packages with it.</p>
    <figure class="diagram">${factoryDiagram()}<figcaption>Your build is evidence, never what users install. Every step is written once to the record and signed by the pool.</figcaption></figure>
  </section>

  <section id="ways">
    <h2>Three steps, two of them yours</h2>
    <p class="sub">Every package takes the same road; you choose where your build runs.</p>
    <div class="ways">
      <div class="way"><div class="tag"><span>1 · Request</span><span>GitHub sign-in</span></div><h3>Ask for it, on the record</h3><p>The project's URL, a name, the licence — checked, written once to the record, signed.</p><div class="go"><a class="btn ghost" href="/request">Request a package</a></div></div>
      <div class="way"><div class="tag"><span>2 · Build</span><span>evidence</span></div><h3>Build it — here or at home</h3><p>Press <b>Build</b> for a shared worker, or run the signed image on your machine: your packages only, your agent.</p><div class="go"><a class="btn ghost" href="/docs/workers">Run a worker of my own →</a></div></div>
      <div class="way"><div class="tag"><span>3 · Review</span><span>a maintainer</span></div><h3>The pool makes its own</h3><p>A trusted worker builds it again from your evidence, a real pacman installs it, a maintainer approves — never their own.</p><div class="go"><a class="btn ghost" href="/docs/governance">The rules →</a></div></div>
    </div>
  </section>

  <section>
    <div class="h2row"><h2>Landed lately</h2><span class="hint" id="lists-note"></span><a class="more-link" href="/review">Every decision →</a></div>
    <p class="sub">Brought by contributors, built again by the pool, approved by a maintainer — and where each one is today.</p>
    <div class="landed" id="landed"><div class="muted">loading…</div></div>
  </section>

  <section>
    <div class="charts">
      <div class="chart"><h3>Factory builds <span>14 days</span></h3><div class="sub">per day: staged, published, failed</div><div id="c-builds"></div></div>
      <div class="chart"><h3>From request to the rings <span>median</span></h3><div class="sub">time at each stage, from the record</div><div id="c-funnel"></div></div>
    </div>
  </section>

  <div class="gate" id="gate"><div><div class="lock">private area · contributors</div><h3 style="margin-top:6px">Your workspace</h3><p>Sign in to request packages, run a worker and follow your builds — on a page of your own.</p><ul><li>your packages and their stage</li><li>your workers, live</li><li>every build with its evidence</li></ul></div><div class="cta"><a class="btn" id="gate-btn" href="/auth/github?next=/me">${GITHUB_ICON} Sign in with GitHub</a><span class="hint" id="gate-hint">No permission needed. A worker of your own is optional.</span></div></div>
`;

const SCRIPT = String.raw`
__CHARTS__
  // Signed in, the gate leads to the person's own page — the workspace. The gate is the same for everyone: only the button's words and where it goes change, the hint stays.
  whoami(function (me) { if (!me) return; var b = $("#gate-btn"); b.href = userHref(me.login); b.textContent = "Your page →"; });
  skeletonTiles("#tiles", 5);
  // The tiles read two answers: the factory's lists (FACTS, once publicLoad answered, the maintainer set with them) and the stats series the builds chart draws (STATS, once the poll answered) — the builds of the week are the chart's own numbers summed, not a second count over the task window. DOWN is the reason the lists did not answer: the tiles then read "—" and why (the shell's tilesUnanswered), never a 0 — a list that failed is not a list with nothing in it.
  var FACTS = null, STATS = null, DOWN = null;
  function renderTiles() {
    if (!FACTS && !DOWN) return;
    var facts = FACTS || { pkgs: [], review: {}, shared: workerCounts([]), maintainers: {} };
    var pkgs = facts.pkgs, review = facts.review, sw = facts.shared, maint = facts.maintainers || {};
    var week = STATS ? buildsByDay(STATS.series, 7).days.reduce(function (n, d) { n.staged += d.staged; n.published += d.published; n.failed += d.failed; return n; }, { staged: 0, published: 0, failed: 0 }) : null;
    // Landed is the registry's own word (the Pool, the Pipeline and People count the same flag); the contributors under it are the owners of those packages who are not in the maintainer set — the People page's and the Pool's word for a contributor.
    var landed = pkgs.filter(function (p) { return p.landed; }), from = {}; landed.forEach(function (p) { if (p.owner && !Object.prototype.hasOwnProperty.call(maint, p.owner)) from[p.owner] = 1; });
    var tiles = [
      ["Community packages", num(landed.length), "in the rings, from " + num(Object.keys(from).length) + " contributors", "", "/packages?q=factory"],
      ["Waiting for review", num(review.waiting), review.oldest_ms ? "oldest " + span(review.oldest_ms) : "nothing waiting", review.waiting ? "warn" : "", "/review"],
      ["Shared workers alive", num(sw.alive), num(sw.byKind.community.alive) + " community · " + num(sw.byKind.project.alive + sw.byKind.review.alive) + " project", sw.alive ? "ok" : "", "/workers"],
      ["Builds this week", week ? num(week.staged + week.published + week.failed) : "…", week ? num(week.staged) + " staged · " + num(week.published) + " published · " + num(week.failed) + " failed" : "", "", "/journal?kind=build"],
      ["Requested, not built yet", num(pkgs.filter(function (p) { return p.status === "registered"; }).length), "on the record, waiting for a Build", "", "/review"]
    ];
    setTiles("#tiles", FACTS ? tiles : tilesUnanswered(tiles, DOWN));
  }
  // The four lists are one load (api() rejects on a 5xx and on the network): one that did not answer is said in the note beside Landed lately and nothing is drawn in its place — an empty list stood in for a failed one here, and the tile read "Waiting for review 0 · nothing waiting" over a query that threw. The first load's tiles read "—"; what a later load drew stays.
  function publicLoad() {
    Promise.all([
      api("GET", "/api/v1/factory"),
      api("GET", "/api/v1/factory/packages"),
      api("GET", "/api/v1/factory/approvals"),
      api("GET", "/api/v1/factory/review"),
      new Promise(function (ok) { maintainerSet(ok); })
    ]).then(function (res) {
      var f = res[0], pkgs = res[1].packages || [], apps = res[2].approvals || [];
      // The workers the shared queue may hand a build to — the project's and a contributor's shared ones, an outdated one handed nothing — counted as the shell counts every tile's workers (workerCounts); what waits for review is the list's own waiting and oldest_ms, the number Review's and the Pipeline's tiles say.
      var shared = workerCounts(f.workers.filter(function (w) { return !(w.update && w.update.required) && (w.side === "omarchy" || w.mode === "shared"); }));
      FACTS = { pkgs: pkgs, review: res[3], shared: shared, maintainers: res[4] }; DOWN = null; $("#lists-note").textContent = ""; renderTiles();
      var owners = {}; pkgs.forEach(function (p) { owners[p.name] = p.owner; });
      // Landed: the approvals that stand (standing, the server's word — approved and not withdrawn), so what this page calls landed Review never calls withdrawn.
      var approved = apps.filter(function (a) { return a.standing; });
      live("shared-online", num(shared.alive) + " alive now");
      // Where each one is today: the four rings as badges, lit as the package reaches them.
      var RING_ICON = { lab: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>', edge: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', rc: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>', stable: '<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>' };
      var ringBadges = function (rings) { return '<span class="rings">' + ["lab", "edge", "rc", "stable"].map(function (r) { var on = rings.indexOf(r) >= 0; return '<i class="rb ' + r + (on ? " on" : "") + '" title="' + (on ? "in " + r : "not in " + r + " yet") + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + RING_ICON[r] + '</svg>' + r + '</i>'; }).join("") + '</span>'; };
      $("#landed").innerHTML = approved.slice(0, 6).map(function (a) {
        var owner = owners[a.name], rings = a.rings || [];
        // An approval that stands and no ring serving it yet: where it is by the shell's one rule (approvalWhere — blocked, publish failed or cancelled, publishing — the word Review's Decided line says of the same row); the badges below say the rings, so a served one wears no pill.
        var where = approvalWhere(a), state = rings.length ? "" : pillHtml(where.cls, where.word, where.title);
        // The person is the shell's, the role from the maintainer set; the package links the shell's one address, with the most stable ring that serves it (servedRing, the reader's order) and its architecture.
        return '<div class="land">' + (owner ? avatar(owner) : '<span class="avatar">?</span>') + '<div class="n"><span><a href="' + pkgHref(a.name, servedRing(rings), a.arch) + '">' + esc(a.name) + '</a> <span class="v">' + esc(a.version || "") + '</span></span>' + state + '</div><div class="b">by ' + personLink(owner) + ' · approved by ' + personLink(a.by) + ' · ' + ago(a.created_at) + ' · ' + esc(a.arch) + '</div>' + ringBadges(rings) + '</div>';
      }).join("") || '<div class="muted">nothing approved yet — <a href="/request">be the first</a></div>';
      // The funnel: medians from what the record holds (a package's request, its first staged build, the decision), then the gates every package passes.
      var median = function (xs) { if (!xs.length) return null; xs = xs.slice().sort(function (a, b) { return a - b; }); return xs[Math.floor(xs.length / 2)]; };
      var firstStaged = {}; f.tasks.forEach(function (t) { if (t.kind === "build" && t.trust === "community" && (t.status === "staged" || t.status === "done") && t.finished_at) { var k = t.name; if (!firstStaged[k] || t.finished_at < firstStaged[k]) firstStaged[k] = t.finished_at; } });
      var byTask = {}; f.tasks.forEach(function (t) { byTask[t.id] = t; });
      var regToStaged = pkgs.filter(function (p) { return firstStaged[p.name] && p.created_at; }).map(function (p) { return (Date.parse(firstStaged[p.name]) - Date.parse(p.created_at)) / 3600e3; }).filter(function (h) { return h >= 0; });
      var stagedToDecided = apps.filter(function (a) { return byTask[a.task_id] && byTask[a.task_id].finished_at; }).map(function (a) { return (Date.parse(a.created_at) - Date.parse(byTask[a.task_id].finished_at)) / 3600e3; }).filter(function (h) { return h >= 0; });
      var fmtH = function (h) { return h == null ? "—" : h < 1 ? Math.round(h * 60) + " min" : h < 48 ? (Math.round(h * 10) / 10) + " h" : Math.round(h / 24) + " d"; };
      var stagesF = [["requested → staged", median(regToStaged), "your build, on a worker"], ["staged → decided", median(stagedToDecided), "a maintainer reads the evidence"], ["edge → rc", 0.5, "minutes, after the checks on both architectures"], ["rc → stable", 6, "two green health checks in a row — or at once, when the trial installed it"]];
      var maxH = Math.max(6, median(regToStaged) || 0, median(stagedToDecided) || 0);
      // A row per stage: the label carries what the stage is as its title, the bar is the stage's share of the longest one, the value its median; the stage a human decides is amber.
      $("#c-funnel").innerHTML = hrows(stagesF.map(function (st) { var human = st[0] === "staged → decided"; return ['<span title="' + esc(st[2]) + '">' + esc(st[0]) + '</span>', "", st[1] == null ? 0 : Math.min(100, 100 * st[1] / maxH), human ? "var(--amber)" : "var(--green)", fmtH(st[1]), st[0] + ": " + (st[1] == null ? "no measurement yet" : "median " + fmtH(st[1])) + " — " + st[2]]; }), { w: 160, html: true }) + '<div class="legend"><span><i style="background:var(--green)"></i>the machines</span><span><i style="background:var(--amber)"></i>a human decides</span></div>';
      endSkeleton();
    }).catch(function (e) { DOWN = noAnswer("factory's lists", e, "#lists-note"); if (!FACTS) { renderTiles(); $("#landed").innerHTML = '<div class="muted">' + esc(DOWN) + '</div>'; } });
  }
  publicLoad();
  // The chart and the Builds tile read one series (builds_daily): fourteen days drawn, the last seven summed.
  liveStats(function (d) {
    STATS = d; renderTiles();
    var b = buildsByDay(d.series, 14);
    $("#c-builds").innerHTML = stacked(b.labels, b.series, { label: "Factory builds per day over fourteen days", empty: "no build yet" });
  }, 120000);
`;

export function factoryHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/factory",
    title: "Factory · omarchy-pool",
    description: "Bring a package: request it, build it on your worker or the community's, follow it to a maintainer's approval and into the rings.",
    active: "factory",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
  });
}

/**
 * What /factory is made of.
 * The page is public and the same for everyone: the tiles, the assembly
 * line's one live number, Landed lately and the funnel share one
 * Promise.all over four factory reads — one that did not answer is said
 * in the note beside Landed lately and the tiles read "—"; the builds
 * chart and the Builds tile share the /stats poll; only the gate asks who
 * is signed in, and changes its button's words and target — the gate and
 * its hint are served to everyone. Nothing here posts — every action is a
 * link to another page.
 */
export const FACTORY_COMPONENTS = (_F: Fixture): Component[] => [
  {
    id: "factory.hero",
    page: "/factory",
    anchor: ['<p class="eyebrow">For contributors</p>', "Package what you love. The factory builds it, a maintainer checks it."],
    visible: EVERYONE,
  },
  {
    // Five tiles from two answers: what waits for review is the list's own `waiting` and `oldest_ms` (Review's tile and the Pipeline's say the same), the shared workers are the shell's count over the listing (workerCounts), and the builds of the week are the chart's series (stats builds_daily) summed over seven days — not a count over the factory's task window. Over lists that did not answer, the five read "—" with the reason (the shell's tilesUnanswered), never a 0.
    id: "factory.tiles",
    page: "/factory",
    anchor: ['class="tiles five"', 'id="tiles"'],
    script: ['api("GET", "/api/v1/factory")', 'api("GET", "/api/v1/factory/packages")', 'api("GET", "/api/v1/factory/review")', '"#tiles"', "function renderTiles()", 'setTiles("#tiles", FACTS ? tiles : tilesUnanswered(tiles, DOWN))', '"Community packages"', "p.landed", "maintainerSet(ok)", '" contributors"', '"Waiting for review"', "review.waiting", "review.oldest_ms", '"Shared workers alive"', "workerCounts(f.workers.filter(", "sw.byKind.community.alive", '"Builds this week"', "buildsByDay(STATS.series, 7).days", '"Requested, not built yet"', '"/packages?q=factory"', '"/journal?kind=build"'],
    reads: [
      { path: "/api/v1/factory", fields: ["workers", "workers.0.id", "workers.0.alive", "workers.0.ready", "workers.0.current_task", "workers.0.revoked_at", "workers.0.side", "workers.0.mode", "workers.0.labels", "workers.0.update"] },
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.name", "packages.0.owner", "packages.0.status", "packages.0.landed"] },
      { path: "/api/v1/factory/review", fields: ["staged", "waiting", "oldest_ms"] },
      { path: "/api/v1/factory/maintainers", fields: ["maintainers", "maintainers.0.login"] },
      { path: "/api/v1/stats", fields: ["series.builds_daily", "series.builds_daily.0.day", "series.builds_daily.0.status", "series.builds_daily.0.n"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "factory.how-header",
    page: "/factory",
    anchor: ['id="how"', "<h2>How a package gets in</h2>", 'href="/docs/how-it-works#people"'],
    visible: EVERYONE,
  },
  {
    id: "factory.assembly-line",
    page: "/factory",
    anchor: ['<figure class="diagram">', 'viewBox="0 0 1340 330"', 'aria-label="An assembly line:', 'data-live="shared-online"'],
    script: ['live("shared-online"', "num(shared.alive)", '" alive now"', 'w.side === "omarchy" || w.mode === "shared"'],
    reads: [{ path: "/api/v1/factory", fields: ["workers", "workers.0.alive", "workers.0.revoked_at", "workers.0.side", "workers.0.mode", "workers.0.update"] }],
    visible: EVERYONE,
    drawn: "factory",
  },
  {
    id: "factory.ways",
    page: "/factory",
    anchor: ['id="ways"', "<h2>Three steps, two of them yours</h2>", 'href="/request"', 'href="/docs/workers"', 'href="/docs/governance"'],
    visible: EVERYONE,
  },
  {
    // Landed is an approval that stands (`standing`: approved and not withdrawn) — the rule Review reads, so the two pages never disagree on one approval; the owner's icon takes its role from the maintainer set, the package links the shell's one address with the most stable ring that serves it.
    id: "factory.landed",
    page: "/factory",
    anchor: ["<h2>Landed lately</h2>", 'id="lists-note"', 'href="/review"', 'id="landed"'],
    script: ['api("GET", "/api/v1/factory/approvals")', '"#landed"', 'noAnswer("factory\'s lists", e, "#lists-note")', '$("#lists-note").textContent = ""', "return a.standing;", "avatar(owner)", "approvalWhere(a)", "pillHtml(where.cls, where.word, where.title)", 'class="rb ', "pkgHref(a.name, servedRing(rings), a.arch)"],
    reads: [
      { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.standing", "approvals.0.name", "approvals.0.version", "approvals.0.arch", "approvals.0.by", "approvals.0.created_at", "approvals.0.rings", "approvals.0.publish_status", "approvals.0.blocked_at"] },
      { path: "/api/v1/factory/packages", fields: ["packages.0.name", "packages.0.owner"] },
    ],
    visible: EVERYONE,
  },
  {
    // One series for the chart and the Builds tile: the poll keeps it (STATS) and draws both.
    id: "factory.builds-chart",
    page: "/factory",
    anchor: ["Factory builds <span>14 days</span>", 'id="c-builds"'],
    script: ['"/api/v1/stats"', "liveStats(", "STATS = d; renderTiles();", '"#c-builds"', "buildsByDay(d.series, 14)", '"Factory builds per day over fourteen days"'],
    reads: [{ path: "/api/v1/stats", fields: ["series.builds_daily", "series.builds_daily.0.day", "series.builds_daily.0.status", "series.builds_daily.0.n"] }],
    visible: EVERYONE,
  },
  {
    id: "factory.funnel-chart",
    page: "/factory",
    anchor: ["From request to the rings <span>median</span>", 'id="c-funnel"'],
    script: ['"#c-funnel"', '"requested → staged"', '"staged → decided"', "firstStaged", "byTask[a.task_id]", "p.created_at"],
    reads: [
      { path: "/api/v1/factory", fields: ["tasks", "tasks.0.id", "tasks.0.kind", "tasks.0.trust", "tasks.0.status", "tasks.0.name", "tasks.0.finished_at"] },
      { path: "/api/v1/factory/packages", fields: ["packages.0.name", "packages.0.created_at"] },
      { path: "/api/v1/factory/approvals", fields: ["approvals.0.task_id", "approvals.0.created_at"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "factory.gate",
    page: "/factory",
    anchor: ['id="gate"', "private area · contributors", 'id="gate-btn"', 'href="/auth/github?next=/me"', "Sign in with GitHub", 'id="gate-hint"'],
    script: ['"/auth/me"', '"#gate-btn"', "userHref(me.login)", '"Your page →"'],
    reads: [
      // Signed out, the button starts the sign-in (the redirect to GitHub, `next=/me` kept for the callback); signed in, it leads to the person's page.
      { path: "/auth/github?next=/me", status: 302, json: false },
      { path: "/auth/me", status: 401 },
      { path: "/auth/me", as: "contributor", fields: ["login"] },
      { path: "/auth/me", as: "owner", fields: ["login"] },
      { path: "/auth/me", as: "maintainer", fields: ["login"] },
    ],
    visible: EVERYONE,
  },
];
