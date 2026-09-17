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
    <div class="h2row"><h2>Landed lately</h2><a class="more-link" href="/review">Every decision →</a></div>
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
  whoami(function (me) { if (!me) return; var b = $("#gate-btn"); b.href = "/user/" + encodeURIComponent(me.login); b.textContent = "Your page →"; });
  skeletonTiles("#tiles", 5);
  function publicLoad() {
    Promise.all([
      busy(fetch("/api/v1/factory")).then(function (r) { return r.json(); }),
      fetch("/api/v1/factory/packages").then(function (r) { return r.json(); }).catch(function () { return { packages: [] }; }),
      fetch("/api/v1/factory/approvals").then(function (r) { return r.json(); }).catch(function () { return { approvals: [] }; }),
      fetch("/api/v1/factory/review").then(function (r) { return r.json(); }).catch(function () { return { staged: [] }; })
    ]).then(function (res) {
      var f = res[0], pkgs = res[1].packages || [], apps = res[2].approvals || [], staged = res[3].staged || [];
      var shared = f.workers.filter(function (w) { return w.alive && !(w.update && w.update.required) && (w.side === "omarchy" || w.mode === "shared"); });
      var owners = {}; pkgs.forEach(function (p) { owners[p.name] = p.owner; });
      var week = Date.now() - 7 * 86400000;
      var builds7 = f.tasks.filter(function (t) { return t.kind === "build" && Date.parse(t.created_at) > week; });
      var approved = apps.filter(function (a) { return a.decision === "approved"; });
      var waits = staged.map(function (s) { return Date.now() - Date.parse(s.finished_at || s.created_at || 0); }).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
      setTiles("#tiles", [
        ["Community packages", num(pkgs.filter(function (p) { return p.status === "approved" || p.status === "published"; }).length), "in the rings, from " + num(Object.keys(pkgs.reduce(function (o, p) { o[p.owner] = 1; return o; }, {})).length) + " contributors", "", "/packages?q=factory"],
        ["Waiting for review", num(staged.length), waits.length ? "oldest " + ago(new Date(Date.now() - waits[waits.length - 1]).toISOString()).replace(" ago", "") : "nothing staged right now", staged.length ? "warn" : "", "/review"],
        ["Shared workers online", num(shared.length), num(shared.filter(function (w) { return w.side === "community"; }).length) + " community · " + num(shared.filter(function (w) { return w.side === "omarchy"; }).length) + " project", shared.length ? "ok" : "", "/workers"],
        ["Builds this week", num(builds7.length), num(builds7.filter(function (t) { return t.status === "staged"; }).length) + " staged · " + num(builds7.filter(function (t) { return t.status === "done"; }).length) + " published · " + num(builds7.filter(function (t) { return t.status === "failed"; }).length) + " failed", "", "/journal?kind=build"],
        ["Requested, not built yet", num(pkgs.filter(function (p) { return p.status === "registered"; }).length), "on the record, waiting for a Build", "", "/review"]
      ]);
      live("shared-online", num(shared.length) + " online now");
      // Where each one is today: the four rings as badges, lit as the package reaches them.
      var RING_ICON = { lab: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>', edge: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', rc: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>', stable: '<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>' };
      var ringBadges = function (rings) { return '<span class="rings">' + ["lab", "edge", "rc", "stable"].map(function (r) { var on = rings.indexOf(r) >= 0; return '<i class="rb ' + r + (on ? " on" : "") + '" title="' + (on ? "in " + r : "not in " + r + " yet") + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + RING_ICON[r] + '</svg>' + r + '</i>'; }).join("") + '</span>'; };
      $("#landed").innerHTML = approved.slice(0, 6).map(function (a) {
        var owner = owners[a.name], rings = a.rings || [];
        var state = rings.length ? "" : pillHtml("blue", a.rebuild_status === "done" ? "publishing" : a.rebuild_task ? "building" : "recipe pending");
        return '<div class="land">' + (owner ? avatar(owner, "contributor") : '<span class="avatar">?</span>') + '<div class="n"><span><a href="/package/' + encodeURIComponent(a.name) + '">' + esc(a.name) + '</a> <span class="v">' + esc(a.version || "") + '</span></span>' + state + '</div><div class="b">by ' + personLink(owner) + ' · approved by ' + personLink(a.by) + ' · ' + ago(a.created_at) + ' · ' + esc(a.arch) + '</div>' + ringBadges(rings) + '</div>';
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
    }).catch(function () { endSkeleton(); });
  }
  publicLoad();
  liveStats(function (d) {
    var b = buildsByDay(d.series, 14);
    $("#c-builds").innerHTML = stacked(b.labels, b.series, { label: "Factory builds per day over fourteen days", empty: "no build yet" });
  }, 120000);
`;

export function factoryHtml(poolUrl: string, version: RunningVersion, path = "/factory"): string {
  return page({
    title: "Factory · omarchy-pool",
    description: "Bring a package: request it, build it on your worker or the community's, follow it to a maintainer's approval and into the rings.",
    active: "factory",
    body: BODY,
    script: SCRIPT.replace("__CHARTS__", CHARTS),
    poolUrl,
    version,
    path,
  });
}

/**
 * What /factory is made of.
 * The page is public and the same for everyone: the tiles, the assembly
 * line's one live number, Landed lately and the funnel share one
 * Promise.all over four factory reads; the builds chart polls /stats; only
 * the gate asks who is signed in, and changes its button's words and
 * target — the gate and its hint are served to everyone. Nothing here
 * posts — every action is a link to another page.
 */
export const FACTORY_COMPONENTS = (_F: Fixture): Component[] => [
  {
    id: "factory.hero",
    page: "/factory",
    anchor: ['<p class="eyebrow">For contributors</p>', "Package what you love. The factory builds it, a maintainer checks it."],
    visible: EVERYONE,
  },
  {
    id: "factory.tiles",
    page: "/factory",
    anchor: ['class="tiles five"', 'id="tiles"'],
    script: ['"/api/v1/factory"', '"/api/v1/factory/packages"', '"/api/v1/factory/review"', '"#tiles"', '"Community packages"', '"Waiting for review"', '"Shared workers online"', '"Builds this week"', '"Requested, not built yet"', '"/packages?q=factory"', '"/journal?kind=build"'],
    reads: [
      { path: "/api/v1/factory", fields: ["workers", "workers.0.id", "workers.0.alive", "workers.0.side", "workers.0.mode", "workers.0.update", "tasks", "tasks.0.kind", "tasks.0.status", "tasks.0.created_at"] },
      { path: "/api/v1/factory/packages", fields: ["packages", "packages.0.name", "packages.0.owner", "packages.0.status"] },
      { path: "/api/v1/factory/review", fields: ["staged", "staged.0.finished_at"] },
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
    script: ['live("shared-online"', '" online now"', 'w.side === "omarchy" || w.mode === "shared"'],
    reads: [{ path: "/api/v1/factory", fields: ["workers", "workers.0.alive", "workers.0.side", "workers.0.mode", "workers.0.update"] }],
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
    id: "factory.landed",
    page: "/factory",
    anchor: ["<h2>Landed lately</h2>", 'href="/review"', 'id="landed"'],
    script: ['"/api/v1/factory/approvals"', '"#landed"', 'a.decision === "approved"', "a.rebuild_status", "a.rebuild_task", 'class="rb ', "/package/' + encodeURIComponent(a.name)"],
    reads: [
      { path: "/api/v1/factory/approvals", fields: ["approvals", "approvals.0.decision", "approvals.0.name", "approvals.0.version", "approvals.0.arch", "approvals.0.by", "approvals.0.created_at", "approvals.0.rings", "approvals.0.rebuild_status", "approvals.0.rebuild_task"] },
      { path: "/api/v1/factory/packages", fields: ["packages.0.name", "packages.0.owner"] },
    ],
    visible: EVERYONE,
  },
  {
    id: "factory.builds-chart",
    page: "/factory",
    anchor: ["Factory builds <span>14 days</span>", 'id="c-builds"'],
    script: ['"/api/v1/stats"', "liveStats(", '"#c-builds"', "buildsByDay(d.series, 14)", '"Factory builds per day over fourteen days"'],
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
    script: ['"/auth/me"', '"#gate-btn"', '"/user/" + encodeURIComponent(me.login)', '"Your page →"'],
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
