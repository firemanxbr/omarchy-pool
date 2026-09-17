/**
 * A contributor's or maintainer's public page: who they are on GitHub,
 * what they registered and built, what they approved, the workers they run.
 * Their own page is also their workspace — "Sign in with GitHub" lands here:
 * Build and remove on the packages, register and revoke on the workers, the
 * evidence of every build, the staging quota, a token for scripts. Everything
 * is the public API (`/api/v1/factory/*`) with the browser session.
 *
 * The page is the same for every role: Share and Token, the way to request
 * and to register, Build, Remove and Renew on a package, Revoke and the
 * mode on a worker, Withdraw on an approval, the evidence of every build —
 * drawn for everyone. What this viewer may not do is the same control grey
 * with the reason in its title (the shell's gate()), never hidden and never
 * a sentence in its place; the reason is the server's own word
 * (GET /users/<login>/can, no-store: the profile is cached for everyone,
 * the rights are the caller's), so a grey button is one the door would
 * refuse in the same words. A maintainer keeps what is theirs on anyone's
 * page — revoke, own only, remove, withdraw.
 */
import { page, servedGrey, workerPanels } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";

/**
 * The controls served grey for everyone, whose they are in their title —
 * the shell's servedGrey, what gate() writes — and drawn again through
 * gate() once the server said what this viewer may do: live for the owner,
 * the sign-in for nobody. One template each, in the HTML and in the script.
 * Share and the register toggle are served live: the page is public and
 * its link is anyone's, and the toggle only shows the form, whose fields
 * are the gated ones.
 */
const SHARE_BTN = `<button type="button" class="btn" id="share-open" title="the link to this page, to post anywhere">Share</button>`;
const TOKEN_BTN = `<button type="button" class="btn ghost" id="token-open" title="a token for scripts and CI">Token</button>`;
const REQUEST_LINK = `<a class="more-link" id="pk-request" href="/request">+ request one →</a>`;
const REGISTER_TOGGLE = `<button type="button" class="more-link" id="w-toggle" title="the form: a name, an architecture, one command to run it">+ register one</button>`;
const WORKER_FORM = `<label>Name <input type="text" id="w-name" placeholder="laptop" required></label> <label>Architecture <select id="w-arch"><option>x86_64</option><option>aarch64</option></select></label> <button type="submit" id="w-btn">Register worker</button>`;

const body = (login: string) => String.raw`
  <div class="profile-head">
    <span class="avatar lg" id="avatar">…</span>
    <div><p class="crumbs"><a href="/factory">Factory</a> / <span id="crumb"></span></p><h1 id="title">…</h1><p class="line" id="line"></p></div>
    <span id="share-btn">${SHARE_BTN} ${servedGrey(TOKEN_BTN, `only ${login} mints their token`)}</span>
  </div>
  <div class="tiles" id="tiles"></div>
  <div class="two" style="margin-bottom:44px">
    <div class="panel"><h3>Activity <span class="dim" style="font-size:12px;font-weight:400">16 weeks · builds, decisions, packages</span></h3><div class="activity" id="activity"></div><p class="sub" id="activity-note" style="margin:8px 0 0;font-size:12.5px"></p></div>
    <div class="panel"><h3>Track record <a href="/docs/governance">the formula →</a></h3><div class="score"><b id="score">…</b><div class="f" id="score-f"></div></div></div>
  </div>

  <section id="record-section" hidden>
    <h2>Track record</h2>
    <p class="sub">From the record the pool keeps anyway — what this person brought that a maintainer let in, what they built, what they decided. One number, with a formula anyone can check (<a href="/docs/governance">Governance</a>): it says where the work was done, not who someone is.</p>
    <div class="table-wrap"><table id="record"><thead><tr><th>Contributed</th><th>Maintained</th><th>Score</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Packages</h2>${servedGrey(REQUEST_LINK, `only ${login} requests here`)}</div>
    <p class="sub">Registered by this contributor: the name is theirs, their worker builds it as evidence, the project builds it again, <b>another</b> maintainer decides — a maintainer who brings a package is its contributor. Open a row: the request as the form checks it, then each architecture on its own — its build, the gate, the audit, the score, whether it is ready for a maintainer.</p>
    <div class="table-wrap"><table id="packages" class="pk"><thead><tr><th></th><th>Package</th><th>Category</th><th>Project</th><th>Arches</th><th>Stage</th><th>Where it stands</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Builds</h2><span class="dim" id="quota" style="font-size:12px"></span></div>
    <p class="sub">On this contributor's workers — evidence for a maintainer, never what users get directly. The number opens the build, whole; the log and the PKGBUILD are public.</p>
    <div class="table-wrap"><table id="builds"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Status</th><th>Why</th><th>Worker</th><th>Took</th><th>When</th><th>Evidence</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Workers</h2>${REGISTER_TOGGLE}</div>
    <p class="sub">The machines under this name, as the <a href="/workers">Workers</a> page shows them — their own (a contributor's), the review ones and the pool's, when this person keeps them.</p>
    <div id="w-own">
      <p class="sub" style="margin:0 0 10px;font-size:12.5px">Optional — the shared queue builds for you otherwise. Register one and run the signed image with the token it gives you, shown once: your packages at once, with your agent; with <code>WORKER_SHARED=1</code>, everyone's queue too. <a href="/docs/workers">Run a worker →</a></p>
      <form id="worker-form" class="form" onsubmit="return false" hidden>${servedGrey(WORKER_FORM, `only ${login} registers a worker here`)}</form>
      <div id="w-new" hidden><p class="sub">Your worker token, shown once. One command wherever the worker lives (docker or podman):</p><pre id="w-cmd"></pre></div>
    </div>
    ${workerPanels([
      { kind: "community", blurb: "their own machines: their packages, or whatever is queued when shared", hidden: true },
      { kind: "review", blurb: "the maintainers' side: builds again, publishes, audits", hidden: true },
      { kind: "project", blurb: "the pool's own jobs, on the host this maintainer keeps", hidden: true },
    ])}
    <p class="sub" id="w-none" hidden style="margin:0">No worker registered under this name.</p>
  </section>

  <section id="approvals-section" hidden>
    <h2>Approvals</h2>
    <p class="sub">Decisions this maintainer signed: what they let into the pool — and where it stands today, ring by ring — what they sent back, what they took back. A standing approval is taken back from here by a maintainer: the package leaves every ring, another maintainer decides.</p>
    <div class="table-wrap"><table id="approvals"><thead><tr><th>When</th><th>Package</th><th>Arch</th><th>Decision</th><th>Where it stands</th><th>Note</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var login = decodeURIComponent(location.pathname.split("/")[2] || "");
  $("#crumb").textContent = login;
  skeletonTiles("#tiles", 4); skeletonRows("#packages", 7, 2); skeletonRows("#builds", 9, 3);
  var API = "/api/v1/factory";
  // ---- what this viewer may do here, from the server: GET /users/<login>/can (no-store — the profile is cached for everyone, the rights are the caller's) says for each control whether it is live and, where not, why, in the words the door would refuse with. Every control below is drawn for everyone and reads CAN; nobody's answer — nothing, the sign-in as the reason — until it lands.
  var CAN = { why: {}, packages: {}, workers: {} };
  function may(right) { return CAN[right] === true; }
  function reason(right) { return CAN.why[right] || "sign in with GitHub"; }
  // Remove is answered per registration (an approved one is a maintainer's to remove, one in a ring nobody's): the row's answer where the server gave one, the page's otherwise.
  function removeOf(name) { var p = CAN.packages[name]; return p ? { ok: p.remove === true, why: p.why || "" } : { ok: may("remove"), why: reason("remove") }; }
  // Revoke and the mode are answered per worker (a revoked one is gone, a project's has no mode: the state's word first, the door's own): the row's answer where the server gave one, the role's otherwise.
  function workerCan(w, right) { var x = CAN.workers[w.id]; return x ? { ok: x[right] === true, why: (x.why && x.why[right]) || "" } : { ok: may(right), why: reason(right) }; }
  var SHARE_BTN = ${JSON.stringify(SHARE_BTN)}, TOKEN_BTN = ${JSON.stringify(TOKEN_BTN)}, REQUEST_LINK = ${JSON.stringify(REQUEST_LINK)}, WORKER_FORM = ${JSON.stringify(WORKER_FORM)};
  var DRAWN = false;
  function loadCan() {
    return api("GET", "/api/v1/users/" + encodeURIComponent(login) + "/can").then(function (d) {
      if (d.__status !== 200 || !d.can) return;
      // The controls outside the tables are drawn again only when their gate changed: what the owner typed in the register form stays through a refresh.
      var was = topState(); CAN = d.can;
      if (DRAWN && topState() !== was) { renderTop(); renderRegister(); }
    }).catch(function () {});
  }
  function topState() { return ["request", "register", "token"].map(function (r) { return may(r) + ":" + reason(r); }).join("|"); }
  // Past the edge cache for whoever may change what the page shows, so a Build, a Revoke, a Withdraw shows at once: the owner always, a maintainer for a minute and a half after their own act (past the edge's max-age, so the cached answer cannot draw the old state back); a reader gets the cached answer, which is the bill kept down. sep is the query's first character on the URL it goes on.
  var FRESH_UNTIL = 0;
  function fresh(sep) { return isOwner(login) || (isMaintainer() && Date.now() < FRESH_UNTIL) ? sep + "t=" + Date.now() : ""; }
  // After the viewer's own act: their rights may have changed with it (a registration gone, a worker revoked), and the next reads pass the cache.
  function acted() { FRESH_UNTIL = Date.now() + 90000; loadCan(); }
  function evidence(t) {
    var log = '<a class="run" href="' + API + '/tasks/' + t.id + '/artifacts/build.log">log</a>';
    return t.status === "staged" ? log + ' <a class="run" href="' + API + '/tasks/' + t.id + '/artifacts/PKGBUILD">PKGBUILD</a>' : t.status === "failed" ? log : "";
  }
  var OPEN = {}, LATEST = {}, FACTORY = null, STORIES = {};
  // Share and Token at the top, for everyone: the link to this page is anyone's to post (it is public, everything on it is on the record anyway — no door, so no gate), the token the owner's to mint — POST /factory/token mints the caller's own, whoever's page the button is on, which is why nobody else's is live.
  function renderTop() {
    var url = location.origin + "/user/" + encodeURIComponent(login);
    $("#share-btn").innerHTML = SHARE_BTN + ' ' + gate(TOKEN_BTN, may("token"), reason("token"));
    $("#share-open").onclick = function () { ask({ title: "Share " + (isOwner(login) ? "your" : "this") + " profile", text: "This page is public — what it shows is what the pool recorded: packages, builds, decisions. Post the link wherever you like: a GitHub profile, LinkedIn, a blog.", value: url, copy: "Copy the link", confirm: null, cancel: "Close" }); };
    $("#token-open").onclick = function () {
      ask({ title: "A token for scripts and CI", text: "Sent as <code>Authorization: Bearer omc_…</code>. Shown once; it replaces the previous one — your workers keep theirs.", confirm: "Generate a token" }).then(function (go) {
        if (go === null) return;
        api("POST", API + "/token", {}).then(function (d) {
          if (d.error) { toast(esc(d.error), "error"); return; }
          ask({ title: "Your token", text: "Copy it now: the pool keeps only its hash, and this box closes by its button only. " + esc(d.note || ""), value: "export OMARCHY_CONTRIBUTOR_TOKEN=" + d.token, copy: "Copy", confirm: null, cancel: "Close", sticky: true });
        }).catch(function (e) { toast("failed: " + esc(String(e)), "error"); });
      });
    };
  }
  // The way to request a package and the way in for a worker — the form behind the toggle — for everyone, the owner's to press: served grey with whose they are, drawn again from the server's word. The toggle itself only shows the form and stays live for everyone: what a reader may not do is the form's fields, grey with why.
  function renderRegister() {
    $("#pk-request").outerHTML = gate(REQUEST_LINK, may("request"), reason("request"));
    $("#w-toggle").onclick = function () { $("#worker-form").hidden = !$("#worker-form").hidden; };
    $("#worker-form").innerHTML = gate(WORKER_FORM, may("register"), reason("register"));
  }
  // The workers under this name, from the same listing the Workers page reads — the same rows, by kind, in the order that reads for a person: theirs, the review ones, the pool's.
  function renderWorkers() {
    if (!FACTORY) return;
    var mine = FACTORY.workers.filter(function (w) { return w.owner === login; });
    var kinds = { community: [], review: [], project: [] };
    mine.forEach(function (w) { kinds[wtKind(w)].push(w); });
    var any = false;
    // The shell's head with one more cell, the buttons'; a panel with no row of this person's stays hidden, as does the legend when there is none.
    wtTables(true);
    ["community", "review", "project"].forEach(function (k) {
      var panel = $("#wp-" + k), rows = kinds[k];
      panel.hidden = !rows.length; if (!rows.length) return; any = true;
      pager("#w-" + k, rows, function (w) { return workerRow(w, k, workerActs(w)); }, { empty: "", text: wtText });
    });
    $("#w-none").hidden = any; $("#wt-legend").hidden = !any;
  }
  // A worker's buttons, on every row for whoever looks — a revoked worker's and a project's too, grey with the state's word: the mode is the brain's to set — shared (everyone's queue) or its owner's packages only — from the worker's next claim, nothing restarts; and Revoke stops its token. Own only and Revoke are the owner's or a maintainer's, sharing the owner's word alone: the server says which, and why not, per row.
  function workerActs(w) {
    var toShared = w.mode !== "shared", mode = workerCan(w, toShared ? "share_worker" : "own_only"), revoke = workerCan(w, "revoke");
    return gate('<button type="button" class="small-btn" data-mode="' + esc(w.id) + '" data-to="' + (toShared ? "shared" : "dedicated") + '" title="' + (toShared ? "build everyone\'s queue too, from its next claim" : "build its owner\'s packages only, from its next claim") + '">' + (toShared ? "Share" : "Own only") + '</button>', mode.ok, mode.why)
      + ' ' + gate('<button type="button" class="small-btn" data-revoke="' + esc(w.id) + '" title="revoke this worker\'s token">Revoke</button>', revoke.ok, revoke.why);
  }
  function loadWorkers() { return fetch("/api/v1/factory?limit=10" + fresh("&")).then(function (r) { return r.json(); }).then(function (d) { FACTORY = d; renderWorkers(); }).catch(function () {}); }
  // A package's story (routes/story.ts), in its open row: the request as the form checks it today, then one panel per architecture — each is built on a worker of its own and can be ready while the other failed — with its latest chain, the two halves of the score with their evidence, and the one line that says whose turn it is.
  function story(name) {
    var el = storyEl(name); if (!el) return;
    if (STORIES[name]) el.innerHTML = storyHtml(name, STORIES[name]); // what was drawn stays while the fresh one loads: no flicker on the refresh
    fetch("/api/v1/factory/packages/" + encodeURIComponent(name) + "/story" + fresh("?")).then(function (r) { return r.ok ? r.json() : null; }).then(function (st) {
      if (!st) { if (!STORIES[name]) el.innerHTML = '<div class="muted">no story yet</div>'; return; }
      STORIES[name] = st;
      el.innerHTML = storyHtml(name, st);
    }).catch(function () { if (!STORIES[name]) el.innerHTML = '<div class="muted">could not load the story</div>'; });
  }
  // The open row's story element, by the package's name (pacman names carry @ . _ + -; an id made of them would collide).
  function storyEl(name) { var els = document.querySelectorAll(".pkstory[data-story]"); for (var i = 0; i < els.length; i++) if (els[i].getAttribute("data-story") === name) return els[i]; return null; }
  // Build, on every story for whoever looks: grey by state first — a build in flight, the package blocked, the same for all — and by role otherwise (the owner builds, nobody else: the server's word); the title says which. arch null is Build all.
  function buildBtn(name, arch, stopped, title) {
    var btn = '<button type="button"' + (arch ? ' class="small-btn"' : '') + ' data-build="' + esc(name) + '"' + (arch ? ' data-arch="' + esc(arch) + '"' : '') + ' title="' + esc(title) + '">Build ' + (arch ? esc(arch) : "all") + '</button>';
    return gate(btn, !stopped && may("build"), stopped || reason("build"));
  }
  function removeBtn(name) { var r = removeOf(name); return gate('<button type="button" class="ghost" data-remove="' + esc(name) + '" title="remove the registration">Remove</button>', r.ok, r.why); }
  // Withdraw, on every approval row for whoever looks: live for a maintainer where the approval stands (standing: approved, not withdrawn — the row's own fact), grey with why not otherwise — nothing standing on the row for a maintainer, the role's reason (the server's word) for anyone else.
  function withdrawBtn(a, standing) { return gate('<button type="button" class="small-btn" data-withdraw="' + a.task_id + '" data-name="' + esc(a.name + " " + (a.version || "")) + '" title="take the approval back: the package leaves every ring, another maintainer decides — the reason goes on the record">Withdraw</button>', may("withdraw") && standing, may("withdraw") ? "nothing standing to withdraw" : reason("withdraw")); }
  // A blocked package builds for nobody: the door's words (POST /factory/packages/:name/build).
  function blockedWhy(name, pkg) { return name + " is blocked by a maintainer" + (pkg.blocked_reason ? ": " + pkg.blocked_reason : ""); }
  function storyHtml(name, st) {
      var pkg = st.package || {}, registered = (pkg.arches && pkg.arches.length ? pkg.arches : (st.request && st.request.arches) || []).slice(), arches = registered.slice();
      var archOf = function (c) { return (c.contributor || c.project || {}).arch; };
      st.chains.forEach(function (c) { var a = archOf(c); if (a && arches.indexOf(a) < 0) arches.push(a); }); // an architecture the request dropped keeps its story, without a Build
      var inFlight = function (c) { return c && ((c.contributor && (c.contributor.status === "queued" || c.contributor.status === "leased")) || (c.project && (c.project.status === "queued" || c.project.status === "leased"))); };
      var anyBusy = st.chains.some(inFlight);
      // A renewal is taken while the package is registered, staged, rejected or unmaintained and nothing of it is being built — the story says (request.renewable, request.busy).
      var renewable = !!(st.request && st.request.renewable);
      var whyNot = st.request && st.request.busy ? "renew it once build #" + st.request.busy + " is done" : pkg.status === "approved" || pkg.status === "published" ? "in the pool as it was; new releases come as bumps, built from the approved recipe" : "renew it once nothing of it is being built";
      var head = '<div class="pknext">' + (pkg.blocked_at ? pillHtml("error", "blocked") + ' ' + ago(pkg.blocked_at) + ' by ' + personLink(pkg.blocked_by) + ': ' + esc(pkg.blocked_reason || '') + ' — another maintainer lifts it.' : summary(st, arches))
        + '<span class="acts-inline">' + buildBtn(name, null, anyBusy ? "a build is in flight" : pkg.blocked_at ? blockedWhy(name, pkg) : null, "every architecture the request names") + ' ' + removeBtn(name) + '</span></div>';
      var panels = arches.map(function (a) {
        var mine = st.chains.filter(function (c) { return archOf(c) === a; });
        var running = mine[0] && ((mine[0].contributor && mine[0].contributor.status === "leased") || (mine[0].project && (mine[0].project.status === "queued" || mine[0].project.status === "leased")));
        var queued = mine[0] && mine[0].contributor && mine[0].contributor.status === "queued";
        var acts = registered.indexOf(a) >= 0 ? buildBtn(name, a, running ? "a build is running" : pkg.blocked_at ? blockedWhy(name, pkg) : null, queued ? "name a worker, or take it out of the queue" : "this architecture only") : '';
        return archPanel(a, mine, nextStep(st, mine[0]), acts);
      }).join("");
      return head + requestBlock(st.request, may("request"), name, renewable, whyNot, reason("request")) + panels
        + '<p class="sub" style="margin:4px 0 0"><a href="/package/' + encodeURIComponent(name) + '?ring=lab">The package\'s page →</a>' + (st.rings && st.rings.length ? ' · in <b>' + esc(st.rings.map(function (r) { return r.ring + " (" + r.arch + ")"; }).join(", ")) + '</b>' : '') + '</p>';
  }
  // The package in one line: what each architecture waits for, and the request when it is not what the form asks today.
  function summary(st, arches) {
    var parts = arches.map(function (a) {
      var c = st.chains.filter(function (x) { return (x.contributor || x.project || {}).arch === a; })[0], s2 = chainState(c);
      return '<b class="mono">' + esc(a) + '</b> ' + pillHtml(s2.cls, s2.text);
    });
    var req = st.request && !st.request.complete ? ' <span class="dim">·</span> ' + pillHtml("warn", "request incomplete", "the form would not take it today — a maintainer's time is not asked yet") + (st.request.renewable ? ' <span class="dim">' + (isOwner(login) ? "renew it below" : "renewed below by " + esc(login)) + '</span>' : '') : '';
    return parts.join(' <span class="dim">·</span> ') + req;
  }
  // What comes next for one architecture, from its latest chain: whose turn it is, what for — and, when it is the reader's own package, how: the evidence to read, the button to press, where the build can run, what to write for the agent.
  function nextStep(st, c) {
    var own = isOwner(login), pkg = st.package || {}, rings = (st.rings || []).filter(function (r) { return !c || r.arch === (c.contributor || c.project || {}).arch; }).map(function (r) { return r.ring; });
    var incomplete = st.request && !st.request.complete;
    var art = function (t, f, text) { return '<a class="run" href="/api/v1/factory/tasks/' + t.id + '/artifacts/' + f + '">' + text + '</a>'; };
    var steps = function (items) { return '<ol class="howto">' + items.map(function (x) { return '<li>' + x + '</li>'; }).join("") + '</ol>'; };
    var drafted = function (t) { return !t || !t.pkgbuild_ref || t.pkgbuild_ref.indexOf("draft:") === 0; };
    if (!c) return 'No build yet — ' + (own ? 'press <b>Build</b>: it goes to the shared queue (the best idle shared worker takes it; a worker of yours at once), the gate checks it, the second agent audits it.' : 'the contributor\'s build comes first.');
    var cc = c.contributor, pb = c.project, a = c.approval, sc = c.score, arch = (cc || pb).arch;
    var worker = cc && cc.lease_owner && FACTORY ? FACTORY.workers.filter(function (w) { return w.id === cc.lease_owner; })[0] : null;
    var emulated = worker && worker.labels && worker.labels.emulated;
    var where = FACTORY ? whereOptions(FACTORY.workers, arch, login, false) : null;
    // The three tools a contributor has, in the order to try them.
    var again = function (why) {
      if (cc && !drafted(cc)) return steps([
        'Read what stopped it: ' + art(cc, "build.log", "the log") + (cc.status === "failed" ? '' : ', ' + art(cc, "tests.log", "the gate\'s log")) + (why ? ' — ' + why : '') + '.',
        'The recipe is the project\'s own PKGBUILD (<span class="mono">' + esc(String(cc.pkgbuild_ref).split(":").pop()) + '</span>), built as it is — no agent drafts it: fix it there, tag a release, <b>renew the request</b> with that tag, then press <b>Build ' + esc(arch) + '</b>.',
        'Choose <b>where</b> in the Build dialog' + (emulated ? ': this one ran <b>emulated</b> — a native worker may be all it needs' : '') + '.',
      ]);
      return steps([
        'Read what stopped it: ' + art(cc, "build.log", "the log") + (cc.status === "failed" ? '' : ', ' + art(cc, "tests.log", "the gate's log")) + ' and ' + art(cc, "PKGBUILD", "the PKGBUILD") + ' the agent wrote' + (why ? ' — ' + why : '') + '.',
        'Press <b>Build ' + esc(arch) + '</b>: the next build starts from that PKGBUILD and that log (the lesson), not from nothing — and from a <b>hint</b> you write in the dialog: the binary\'s name, a build flag, a dependency, what the recipe should do differently.',
        'Choose <b>where</b> in the same dialog' + (emulated ? ': this one ran <b>emulated</b> (' + esc(arch) + ' under qemu on ' + esc(wtShort(worker.id)) + ') — a native worker may be all it needs' : '') + (where && where.native ? ' — ' + where.native + ' native ' + esc(arch) + ' worker(s) online' : where && where.count ? ' — ' + where.count + ' worker(s) can take it' : ' — the project\'s shared workers take it') + '.',
        'Or build it yourself first: <a href="/docs/workers">run the same image at home</a> with your own agent key; what passes there is what you queue here.',
      ]);
    };
    if (a && a.decision === "approved") return 'Approved by ' + personLink(a.by) + ' ' + ago(a.created_at) + (rings.length ? ' — in <b>' + esc(rings.join(" · ")) + '</b>, signed by the pool; it earns rc and stable like every synced package.' : ' — the publish job carries it into edge.');
    if (c.withdrawn) return 'The approval by ' + personLink(c.withdrawn.by) + ' was withdrawn by ' + personLink(c.withdrawn.withdrawn_by) + ': ' + esc(c.withdrawn.withdrawn_reason || '') + ' — another maintainer decides; ' + (own ? 'nothing to do on your side.' : 'nothing to do on the contributor\'s side.');
    if (a && a.decision === "rejected") return 'Rejected by ' + personLink(a.by) + ': <b>' + esc(a.note || '') + '</b>' + (own && cc ? again('the note above says what to change') : ' — the contributor fixes it and builds again.');
    if (pb && (pb.status === "queued" || pb.status === "leased")) return 'The project is building it again (<a href="/build/' + pb.id + '">#' + pb.id + '</a>) on a trusted worker, with the project\'s agent — then the trial, then a maintainer decides.' + (own ? ' Nothing on your side.' : '');
    if (pb && pb.status === "staged") return 'Built again by the project (<a href="/build/' + pb.id + '">#' + pb.id + '</a>): it waits for ' + (own ? '<b>another</b> maintainer\'s approval (you brought it)' : 'a maintainer\'s approval — never the one who brought it') + '. Class today ' + esc(sc.class) + ', ' + esc(sc.projected) + ' with the maintainer\'s half green.';
    if (pb && pb.status === "failed") return 'The project\'s build failed (<a href="/build/' + pb.id + '">#' + pb.id + '</a>)' + (pb.error ? ' — ' + esc(String(pb.error).slice(0, 140)) : '') + ' — a maintainer reads it and decides; your evidence stands.' + (own ? ' If the recipe is the cause, a new build of yours with the fix is the best help.' : '');
    if (cc && cc.status === "queued") {
      if (cc.pinned_to) return 'Queued (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) for <b>' + esc(wtShort(cc.pinned_to)) + '</b> only' + (FACTORY && !FACTORY.workers.some(function (w) { return w.id === cc.pinned_to && w.alive; }) ? ' — <b>offline</b>: it claims when it is back' : '') + (own ? '. Press <b>Build ' + esc(arch) + '</b> to send it to the queue instead, or to take it out.' : '.');
      if (cc.shared_after && cc.shared_after > new Date().toISOString()) return 'Queued (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) for ' + (own ? 'your' : 'the owner\'s') + ' own worker — a new release, built from the approved recipe; the shared workers take it from ' + esc(cc.shared_after.slice(0, 10)) + '.' + (own ? ' Press <b>Build ' + esc(arch) + '</b> to name a worker or to take it out.' : '');
      var q = cc.queue ? '<b>' + cc.queue.position + ' of ' + cc.queue.total + '</b> in the shared queue for ' + esc(arch) : 'in the shared queue for ' + esc(arch);
      return 'Queued (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) — ' + q + ': the best idle shared worker takes it' + (where ? ' — ' + esc(where.state) : '') + (own ? '; a worker of yours takes it at once. Press <b>Build ' + esc(arch) + '</b> to name a worker or to take it out of the queue.' : '.') + ' This page follows it.';
    }
    if (cc && cc.status === "leased") return 'Building (<a href="/build/' + cc.id + '">#' + cc.id + '</a>) on ' + (cc.lease_owner ? wtId({ id: cc.lease_owner, owner: cc.owner }) : 'a worker') + (emulated ? ' — emulated' : '') + ' — this page follows it.';
    if (cc && cc.status === "failed") return 'The build failed (<a href="/build/' + cc.id + '">#' + cc.id + '</a>)' + (cc.error ? ' — <b>' + esc(String(cc.error).slice(0, 160)) + '</b>' : '') + (own ? again(cc.attempts > 1 ? 'the agent tried ' + cc.attempts + ' times inside this build' : '') : ' — the contributor fixes it.');
    if (cc && cc.status === "cancelled") return 'Superseded (<a href="/build/' + cc.id + '">#' + cc.id + '</a>)' + (cc.error ? ' — ' + esc(String(cc.error).slice(0, 140)) : '') + '.';
    if (cc && cc.status === "staged") {
      if (sc.ready) return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate' + (c.audit && c.audit.status === "done" ? ', audited' : '') + ' — ' + (own ? 'nothing on your side: <b>another</b> maintainer (you brought it)' : 'a maintainer who did not bring it') + ' has the project build it again. Class ' + esc(sc.class) + ' → ' + esc(sc.projected) + '.';
      var vet = cc.result && cc.result.vet, audit = c.audit;
      if (incomplete) return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> is staged, but the request is not what the form asks today — ' + (own ? '<b>Renew the request</b> above: the same form, filled from the record; the build stays and is ready the moment the record is — of this version.' : 'the contributor renews the request; the build stays.');
      if (vet && vet.verdict !== "pass") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> built, but <b>the gate failed</b>: ' + esc((vet.failed || []).join(", ")) + (own ? again('each failed check is named there and explained in <a href="/docs/what-we-test">What we test</a>') : ' — the contributor fixes the recipe and builds again.');
      if (audit && audit.status === "done" && audit.result && audit.result.verdict === "block") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate, but <b>the audit blocked it</b>: ' + esc(audit.result.summary || '') + (own ? again('the ' + art(cc, "audit.md", "report") + ' lists the findings and the fix for each') : ' — the contributor answers the findings and builds again.');
      if (audit && audit.status !== "done") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate; the audit is ' + esc(audit.status) + ' on the project\'s review worker — nothing to do until it answers.';
      if (audit && audit.status === "failed") return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> passed the gate, but the audit did not run (' + esc(audit.error || '') + ') — ' + (own ? 'press <b>Build ' + esc(arch) + '</b> again: a new build gets a new audit.' : 'the contributor builds again.');
      var reqItem = (sc.items || []).filter(function (i) { return i.item === "A request on the record"; })[0];
      if (reqItem && reqItem.points < reqItem.max && st.request && st.request.version) return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> is staged, but the request now names <b>' + esc(st.request.version) + '</b> and this build is ' + esc(cc.version || '?') + ' — ' + (own ? 'press <b>Build ' + esc(arch) + '</b>: the build of that version is the evidence.' : 'the contributor builds that version.');
      return '<a href="/build/' + cc.id + '">#' + cc.id + '</a> is staged, but not ready: ' + (!vet ? 'no gate verdict on the record (built before the gate)' : 'the audit has not answered') + ' — ' + (own ? 'press <b>Build ' + esc(arch) + '</b> again; the gate and the audit run on the new build.' : 'the contributor builds again.');
    }
    return esc(cc ? cc.status : "—");
  }
  function load() {
  return api("GET", "/api/v1/users/" + encodeURIComponent(login) + fresh("?")).then(function (d) {
    if (d.__status !== 200) { $("#title").textContent = login; $("#line").textContent = d.error || "not found"; endSkeleton(); return; }
    document.title = login + " · omarchy-pool";
    $("#title").innerHTML = esc(d.name || d.login) + ' <span class="dim" style="font-weight:500">@' + esc(d.login) + '</span>';
    // An icon, never a photo: two letters, green for a maintainer.
    $("#avatar").textContent = d.login.slice(0, 2); if (d.role === "maintainer") $("#avatar").classList.add("m");
    $("#line").innerHTML = pillHtml(d.role === "maintainer" ? "rec" : "ok", d.role) +
      (d.blocked ? pillHtml("error", "blocked: " + (d.blocked.reason || ""), "by " + (d.blocked.by || "") + ", " + (d.blocked.at || "")) : '') +
      (d.maintainer_since ? pillHtml("none", "since " + ago(d.maintainer_since), "listed in factory/MAINTAINERS.toml") : '') +
      '<span>since ' + esc(String(d.since).slice(0, 10)) + '</span><span class="dim">·</span><span>last seen ' + ago(d.last_seen) + '</span><span class="dim">·</span><a href="' + esc(d.github) + '" style="color:var(--muted);text-decoration:none">github.com/' + esc(d.login) + ' ↗</a>';
    var c = d.build_counts;
    setTiles("#tiles", [
      ["Packages", num(d.packages.length), "registered under this name"],
      ["Builds", num(c.total), num(c.staged) + " staged · " + num(c.published) + " published · " + num(c.failed) + " failed"],
      ["Approvals", num(d.approvals.length), d.role === "maintainer" ? num(d.approved_packages.length) + " package(s) let into the pool" : "not a maintainer"],
      ["Workers", num(d.workers.filter(function (w) { return !w.revoked_at; }).length), num(d.workers.filter(function (w) { return w.alive; }).length) + " alive now"]
    ]);
    // Sixteen weeks of what the record holds under this name: builds, decisions, packages touched.
    var weeks = []; for (var i = 15; i >= 0; i--) weeks.push(Date.now() - i * 7 * 86400000);
    var counts = weeks.map(function () { return 0; }), total = 0;
    var mark = function (iso) { var t = Date.parse(iso); if (!t) return; for (var i = weeks.length - 1; i >= 0; i--) { if (t >= weeks[i]) { counts[i]++; total++; break; } } };
    d.builds.forEach(function (b) { mark(b.created_at); }); d.approvals.forEach(function (a) { mark(a.created_at); }); d.packages.forEach(function (p) { mark(p.updated_at); });
    var mx = Math.max.apply(null, counts) || 1;
    $("#activity").innerHTML = counts.map(function (v, i) { return '<i style="height:' + Math.max(4, 100 * v / mx) + '%" data-tip="' + new Date(weeks[i]).toISOString().slice(0, 10) + ' · ' + v + (v === 1 ? " contribution" : " contributions") + '"></i>'; }).join("");
    $("#activity-note").textContent = total ? num(total) + " in the last 16 weeks — every one is a row below" : "nothing on the record in the last 16 weeks yet";
    var rec = d.record || { contributed: {}, maintained: {}, score: 0 }, has = Object.keys(rec.contributed).some(function (k) { return rec.contributed[k]; }) || Object.keys(rec.maintained).some(function (k) { return rec.maintained[k]; });
    $("#score").textContent = num(rec.score || 0);
    $("#score-f").innerHTML = "from what the pool recorded: what you brought that a maintainer let in, what you built, what you decided — it says where the work was done, not who someone is";
    if (has) {
      $("#record-section").hidden = false;
      pager("#record", [rec], function (r) {
        var c = r.contributed, m = r.maintained;
        var contributed = [c.approved ? num(c.approved) + " let in" : "", c.staged ? num(c.staged) + " staged" : "", c.bumps ? num(c.bumps) + " bump" + (c.bumps === 1 ? "" : "s") : "", c.donated ? num(c.donated) + " for others" : "", c.rejected ? num(c.rejected) + " rejected" : ""].filter(Boolean).join(" · ") || "—";
        var maintained = [m.approvals ? num(m.approvals) + " approval" + (m.approvals === 1 ? "" : "s") : "", m.rejections ? num(m.rejections) + " rejection" + (m.rejections === 1 ? "" : "s") : "", m.rebuilds_failed ? num(m.rebuilds_failed) + " rebuild" + (m.rebuilds_failed === 1 ? "" : "s") + " failed" : ""].filter(Boolean).join(" · ") || "—";
        return '<tr><td>' + contributed + '</td><td>' + maintained + '</td><td class="num">' + num(r.score) + '</td></tr>';
      });
    }
    // ---- packages: one row each, the stage from the latest builds per architecture, a row that opens into the story and the next step
    var byPkg = {}; d.builds.forEach(function (b) { var k = b.name + "/" + b.arch; if (!byPkg[k]) byPkg[k] = b; });
    LATEST = byPkg;
    pager("#packages", d.packages, function (p) {
      var arches = []; try { arches = JSON.parse(p.arches || "[]"); } catch (e) {}
      var per = arches.map(function (a) { var b = byPkg[p.name + "/" + a]; return '<span class="arch-st" title="' + esc(a + ": " + (b ? b.status + (b.status === "leased" ? " (building)" : "") + " · #" + b.id : "no build yet")) + '">' + esc(a) + ' ' + (b ? taskPill(b.status) : pillHtml("none", "—")) + '</span>'; }).join("");
      var open = OPEN[p.name];
      return '<tr class="pkrow" data-pkg="' + esc(p.name) + '"><td><button type="button" class="expand" data-expand="' + esc(p.name) + '" title="' + (open ? "close" : "the story, and what comes next") + '">' + (open ? "▾" : "▸") + '</button></td><td><a href="/package/' + encodeURIComponent(p.name) + '?ring=lab"><b>' + esc(p.name) + '</b></a></td><td>' + (p.category ? pillHtml("none", p.category) : '<span class="dim">—</span>') + '</td><td>' + (p.url ? '<a href="' + esc(p.url) + '">' + esc(p.url.replace(/^https?:\/\/(www\.)?(github\.com\/)?/, "")) + '</a>' : '<span class="dim">—</span>') + '</td><td class="arches">' + per + '</td><td>' + taskPill(p.status) + '</td><td class="muted stands" title="' + esc(p.detail || "") + '">' + esc(p.detail || "") + '</td></tr>'
        + (open ? '<tr class="pkopen" data-pkg="' + esc(p.name) + '"><td colspan="7"><div class="pkstory" data-story="' + esc(p.name) + '">' + (STORIES[p.name] ? storyHtml(p.name, STORIES[p.name]) : '<div class="muted">loading the story…</div>') + '</div></td></tr>' : '');
    }, { empty: "no package registered", after: function () { Object.keys(OPEN).forEach(function (n) { if (OPEN[n]) story(n); }); }, text: function (p) { return [p.name, p.category, p.status, p.detail].join(" "); } });
    // ---- builds: the number is the build's page; the worker that held it; the evidence, public, for whoever reads
    pager("#builds", d.builds, function (t) {
      return '<tr><td><a href="/build/' + t.id + '" title="the build, whole">' + t.id + '</a></td><td><a href="/package/' + encodeURIComponent(t.name) + '?ring=lab&arch=' + esc(t.arch) + '"><b>' + esc(t.name) + '</b></a>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '') + '</td><td>' + esc(t.arch) + '</td><td>' + taskPill(t.status) + (t.queue ? ' <span class="dim" title="in the shared queue for ' + esc(t.arch) + '">' + t.queue.position + ' of ' + t.queue.total + '</span>' : '') + '</td><td>' + esc(t.reason || "") + (t.trust === "project" ? ' ' + pillHtml("ok", "the project", "the project's own build, from a contributor's evidence") : '') + '</td><td>' + (t.lease_owner ? wtId({ id: t.lease_owner, owner: t.lease_owner.indexOf(login + "-") === 0 ? login : (t.lease_owner.split("-")[0] || null) }) : t.pinned_to && t.status === "queued" ? '<span class="muted" title="asked for this worker only">waiting for ' + esc(wtShort(t.pinned_to)) + '</span>' : '<span class="muted">—</span>') + '</td><td>' + (dur(t.duration_ms) || "—") + '</td><td class="when">' + ago(t.created_at) + '</td><td>' + evidence(t) + '</td></tr>';
    }, { empty: "nothing built yet", text: function (t) { return [t.id, t.name, t.version, t.arch, t.status, t.reason, t.lease_owner].join(" "); } });
    // ---- approvals: last, with the build behind each
    if (d.approvals.length || d.role === "maintainer") {
      $("#approvals-section").hidden = false;
      // A standing approval is a package in the pool — its rings say where. Withdraw is on every row for whoever looks: live for a maintainer where an approval stands (it leaves every ring, another maintainer decides), grey with why not — nothing standing on the row, or the role, the server's word.
      pager("#approvals", d.approvals, function (a) {
        var standing = a.decision === "approved" && !a.withdrawn_at;
        var where = standing ? (a.rings && a.rings.length ? a.rings.map(function (r) { return pillHtml(r === "stable" ? "ok" : r === "rc" ? "blue" : r === "edge" ? "lilac" : "warn", r); }).join(" ") : '<span class="muted" title="approved, not served: the publish job did not run, or a later release dropped it">not served</span>') : '<span class="muted">—</span>';
        var act = ' ' + withdrawBtn(a, standing);
        return '<tr><td class="when">' + ago(a.created_at) + '</td><td><a href="/package/' + encodeURIComponent(a.name) + '?ring=lab&arch=' + esc(a.arch) + '">' + esc(a.name) + '</a> <span class="mono muted">' + esc(a.version || "") + '</span> <a class="dim" href="/build/' + a.task_id + '">#' + a.task_id + '</a></td><td>' + esc(a.arch) + '</td><td>' + (a.withdrawn_at ? taskPill("withdrawn", "withdrawn " + ago(a.withdrawn_at) + " by " + a.withdrawn_by + ": " + (a.withdrawn_reason || "")) : taskPill(a.decision)) + '</td><td>' + where + act + '</td><td class="muted">' + esc(a.withdrawn_at ? (a.withdrawn_reason || "") : (a.note || "")) + '</td></tr>';
      }, { empty: "no decision yet" });
    }
    renderWorkers();
    endSkeleton();
  }).catch(function (e) { $("#line").textContent = "could not load: " + e; endSkeleton(); });
  }
  // The staging quota is the owner's own (GET /factory/me answers for the caller): the figure on their page, a dash on it for everyone else.
  function quota() {
    if (!isOwner(login)) { $("#quota").textContent = "—"; $("#quota").title = "only " + login + " sees their staging"; return; }
    api("GET", API + "/me").then(function (d) { var st = d.staging; if (!st) return; $("#quota").textContent = "staging " + (st.bytes / 1048576).toFixed(1) + " MB of " + (st.quota_bytes / 1073741824).toFixed(0) + " GB · evidence expires after 30 days"; }).catch(function () {});
  }
  // Who is looking (the shell's whoami: one fetch of /auth/me per page) and what they may do, before the first draw — so the tables come with their buttons in the right state, drawn once.
  Promise.all([new Promise(function (r) { whoami(r); }), loadCan()]).then(function () {
    DRAWN = true;
    renderTop(); renderRegister(); quota();
    load(); loadWorkers();
    // The page follows the work for whoever looks — a build queued, then building, then staged — no reload. A signed-in person's rights ride along once a minute (a block, an approval, a registration gone change what they may press — rarely, and each read is a D1 bill) and right after their own act; nobody's cannot change until they sign in, which is a new page.
    var tick = 0;
    setInterval(function () { tick++; if (WHO.me && tick % 4 === 0) loadCan(); load(); loadWorkers(); }, 15000);
  });
  // Buttons inside paged tables: one delegated handler survives re-renders. A grey button (gate) never gets here: disabled, it takes no click.
  document.addEventListener("click", function (ev) {
    var x = ev.target.closest ? ev.target.closest("button[data-expand]") : null;
    if (x) { var n = x.getAttribute("data-expand"); OPEN[n] = !OPEN[n]; load(); return; }
    var w = ev.target.closest ? ev.target.closest("button[data-withdraw]") : null;
    if (w) {
      var wid = w.getAttribute("data-withdraw"), wname = w.getAttribute("data-name");
      ask({ title: "Withdraw the approval of " + wname, text: "The approval stays on the record and is void from now on; the package leaves every ring it reached — a release without it, the databases rendered again by the project's workers; another maintainer decides on the build.", input: "required", placeholder: "why take it back", confirm: "Withdraw", danger: true }).then(function (note) {
        if (note === null) return; w.disabled = true;
        api("POST", API + "/tasks/" + wid + "/withdraw", { note: note }).then(function (r) { if (r.error) { toast(esc(r.error), "error"); w.disabled = false; } else toast("Withdrawn — " + esc(wname) + " leaves " + esc((r.rings || []).map(function (x) { return x.ring; }).join(", ") || "no ring") + "; another maintainer decides."); acted(); load(); });
      });
      return;
    }
    var b = ev.target.closest ? ev.target.closest("button[data-build],button[data-remove],button[data-revoke],button[data-mode]") : null; if (!b) return;
    if (b.hasAttribute("data-build")) {
      var name = b.getAttribute("data-build"), arch = b.getAttribute("data-arch");
      // Where it runs is the asker's call (one architecture: any of their workers or the project's shared ones; all: the rule, or the shared ones at once); a hint goes to the agent that drafts the recipe.
      var st2 = STORIES[name], det = {}; try { det = JSON.parse((st2 && st2.package && st2.package.detected) || "{}"); } catch (e) {}
      var drafts = !det.has_pkgbuild; // the project's own PKGBUILD is built as it is: no agent, no hint
      var waiting = st2 ? st2.chains.filter(function (c) { return c.contributor && c.contributor.status === "queued" && (!arch || c.contributor.arch === arch); }).map(function (c) { return c.contributor; }) : [];
      var pinnedNow = waiting.length === 1 ? waiting[0].pinned_to : null;
      var where = FACTORY ? whereOptions(FACTORY.workers, arch || "x86_64", login, false, drafts, waiting.length === 1 ? waiting[0].queue : null, pinnedNow) : null;
      if (where && !arch) where.options = where.options.filter(function (o) { return o.value === ""; });
      var queuedNow = waiting.length > 0;
      ask({ title: (queuedNow ? (pinnedNow ? "Waiting for " + wtShort(pinnedNow) + ": " : "In the queue: ") : "Build ") + name + (arch ? " for " + arch : "") + (queuedNow ? "" : "?"), text: (queuedNow ? "Build <b>#" + waiting.map(function (t) { return t.id; }).join(", #") + "</b> " + (pinnedNow ? "waits for <b>" + esc(wtShort(pinnedNow)) + "</b> only. Keep that, send it to the shared queue instead, or take it out" : "waits in the shared queue. Leave it there, name a worker of yours to take it at once, or take it out") + " — nothing puts it back by itself; this button does. " : "") + (drafts ? "The worker drafts the recipe with its agent — from the last build's PKGBUILD and what stopped it, when there is one — builds it, runs the gate and stages the result as evidence; the second agent audits it. " : "The worker builds the project's own PKGBUILD as it is, runs the gate and stages the result as evidence; the second agent audits it. ") + (arch ? "This architecture only." : "Every architecture the request names."), select: where, input: drafts ? "optional" : false, placeholder: "a hint for the agent (optional): the binary's name, a build flag, a dependency, what to do differently", confirm: queuedNow ? (pinnedNow ? "Keep it so" : "Keep it queued") : "Build", alt: queuedNow ? { text: "Take it out of the queue", danger: true } : null }).then(function (go) {
        if (go === null) return; b.disabled = true;
        if (go && typeof go === "object" && go.alt) {
          // Out of the queue: each waiting build of the architecture(s) asked, one call each.
          Promise.all(waiting.map(function (t) { return api("DELETE", API + "/packages/" + encodeURIComponent(name) + "/builds/" + t.id); })).then(function (rs) {
            var bad = rs.filter(function (r) { return r.error; });
            if (bad.length) toast(esc(bad[0].error), "error"); else toast("Out of the queue: build #" + waiting.map(function (t) { return t.id; }).join(", #") + ". Press Build to queue it again, on the queue or on a worker of yours.", "warn");
            OPEN[name] = true; acted(); load();
          });
          return;
        }
        var body = arch ? { arches: [arch] } : {};
        if (go && typeof go === "object") { if (go.pick) body.worker = go.pick; if (go.note) body.hint = go.note; } else if (go) body.hint = go;
        api("POST", API + "/packages/" + encodeURIComponent(name) + "/build", body).then(function (r) { if (r.error) toast(esc(r.error), "error"); else if (!(r.tasks || []).length) toast(esc(r.note || "nothing queued"), "warn"); else toast((queuedNow ? "Still queued: " : "Queued ") + (r.tasks || []).length + " build(s): " + esc((r.arches || []).join(", ")) + (r.pinned_to ? " — for " + esc(wtShort(r.pinned_to)) : r.queue && Object.keys(r.queue).length ? " — " + Object.keys(r.queue).map(function (a) { return a + " " + r.queue[a].position + " of " + r.queue[a].total; }).join(", ") : "") + (r.lessons && Object.keys(r.lessons).length ? " — from the last build's PKGBUILD and log" : "") + " — this page follows them."); OPEN[name] = true; acted(); load(); });
      });
    }
    else if (b.hasAttribute("data-remove")) {
      var rm = b.getAttribute("data-remove");
      ask({ title: "Remove the registration of " + rm + "?", text: "Its builds stop; the evidence on the record stays. Anyone can register the name again.", confirm: "Remove", danger: true }).then(function (go) {
        if (go === null) return;
        api("DELETE", API + "/packages/" + encodeURIComponent(rm)).then(function (r) { if (r.error) toast(esc(r.error), "error"); else toast("Removed " + esc(rm) + "."); delete OPEN[rm]; acted(); load(); });
      });
    }
    else if (b.hasAttribute("data-mode")) {
      var mid = b.getAttribute("data-mode"), to = b.getAttribute("data-to");
      api("POST", API + "/workers/" + encodeURIComponent(mid) + "/mode", { mode: to }).then(function (r) { if (r.error) toast(esc(r.error), "error"); else toast(esc(r.note || ("mode: " + to))); acted(); loadWorkers(); });
    }
    else if (b.hasAttribute("data-revoke")) {
      var wid = b.getAttribute("data-revoke");
      ask({ title: "Revoke " + wid + "?", text: "Its token stops working at once; a build it holds finishes on its own. Register a new one for a new token.", confirm: "Revoke", danger: true }).then(function (go) {
        if (go === null) return;
        api("DELETE", API + "/workers/" + encodeURIComponent(wid)).then(function (r) { if (r.error) toast(esc(r.error), "error"); else toast("Revoked."); acted(); load(); loadWorkers(); });
      });
    }
  });
  $("#worker-form").onsubmit = function () {
    var body = { name: $("#w-name").value.trim(), arch: $("#w-arch").value };
    $("#w-btn").disabled = true;
    api("POST", API + "/workers", body).then(function (d) {
      $("#w-btn").disabled = false;
      if (d.error) { toast(esc(d.error), "error"); return; }
      $("#w-new").hidden = false;
      $("#w-cmd").textContent =
        "# one command, wherever the worker lives (docker or podman, with compose): it writes the compose file and a .env,\n" +
        "# pulls the signed image and starts the set — the broker that holds this token, the builder born with nothing,\n" +
        "# and the updater that keeps both on the pool's latest image (every worker follows it; one behind is handed nothing).\n" +
        "curl -fsSLo omarchy-worker " + location.origin + "/omarchy-worker && chmod +x omarchy-worker\n" +
        "./omarchy-worker start --token " + d.token + "\n\n" +
        "# everyone's queue too, a name for the machine, GitHub's API through the broker (a fine-grained token with no permissions):\n" +
        "./omarchy-worker start --token " + d.token + " --shared --where laptop --github-token github_pat_…\n" +
        "# your agent, on the broker, one of: --anthropic-key sk-… · --openai-key … · --gemini-key … · --xai-key … · --claude-token <claude setup-token>\n" +
        "# then: ./omarchy-worker status · logs · share on|off · update · stop\n" +
        "# the compose file it writes, for a hand-run set: " + location.origin + "/omarchy-worker/compose.yml\n" +
        "#   (.env beside it: OMARCHY_WORKER_TOKEN, COMPOSE_PROFILES=community, OMARCHY_WORKER_DIR=<this directory's absolute path>; the updater included)";
      $("#worker-form").reset(); $("#worker-form").hidden = true; acted(); load(); loadWorkers();
    }).catch(function (e) { $("#w-btn").disabled = false; toast("failed: " + esc(String(e)), "error"); });
    return false;
  };
`;

export function userHtml(login: string, poolUrl: string, version: RunningVersion): string {
  return page({
    path: `/user/${login}`,
    title: `${login} · omarchy-pool`,
    description: `What ${login} contributes to and maintains in the pool.`,
    active: "factory",
    body: body(login),
    script: SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What /user/<login> is made of: everything draws from the person's profile
 * (`/api/v1/users/<login>`), the workers from the same listing the Workers
 * page reads, an open package row from its story, and what this viewer may
 * do from `/api/v1/users/<login>/can`. The page is public and reads the
 * same for every role: every control is drawn for everyone, and the
 * server's answer says which are live — the owner's workspace, a
 * maintainer's revoke, own-only, remove and withdraw — and why the others
 * are grey. The dialogs a button opens are folded into the entry that
 * renders the button. The entries are on alice's page (the contributor who
 * owns the package and the worker) except the Approvals section, which a
 * maintainer's page shows.
 *
 * The acts in order: the token; Remove, which refuses the owner of an
 * approved package; Build, which queues a build and sets the package
 * waiting; the worker registered, w3 shared and back to its owner's
 * packages, then revoked; the approval withdrawn last — the fixture has
 * one, and the build's page may have taken it back before this manifest.
 */
export const USER_COMPONENTS = (F: Fixture): Component[] => {
  const page = `/user/${F.owner}`;
  const profile = `/api/v1/users/${F.owner}`;
  const story = `/api/v1/factory/packages/${F.factoryPkg}/story`;
  const factory = "/api/v1/factory?limit=10";
  const evidence = (task: number, file: string) => `/api/v1/factory/tasks/${task}/artifacts/${file}`;
  return [
    {
      id: "user.crumbs",
      page,
      anchor: ['class="crumbs"', 'href="/factory">Factory', 'id="crumb"'],
      script: ['"#crumb"', 'location.pathname.split("/")[2]'],
      visible: EVERYONE,
    },
    {
      // What this viewer may do here, read before the first draw and again once a minute and after their own act: every control below reads CAN and is grey with the server's reason where it says no — nobody's answer, all false with the sign-in, until it lands; Remove per registration, Revoke and the mode per worker.
      id: "user.rights",
      page,
      anchor: [],
      script: ['"/can"', "function may(", "function reason(", "function removeOf(", "CAN.packages[name]", "function workerCan(", "CAN.workers[w.id]", '"sign in with GitHub"', "function loadCan(", "function acted(", "tick % 4 === 0) loadCan()"],
      reads: [
        { path: `${profile}/can`, fields: ["login", "can.request", "can.register", "can.token", "can.build", "can.dequeue", "can.remove", "can.revoke", "can.withdraw", "can.own_only", "can.share_worker", "can.why.request", "can.why.register", "can.why.token", "can.why.build", "can.why.remove", "can.why.revoke", "can.why.withdraw", "can.why.own_only", "can.why.share_worker", `can.packages.${F.factoryPkg}.remove`, `can.packages.${F.factoryPkg}.why`, `can.workers.${F.communityWorker}.revoke`, `can.workers.${F.communityWorker}.why.revoke`] },
        { path: `${profile}/can`, as: "contributor", fields: ["login", "can.why.request", "can.why.register", "can.why.token", "can.why.build", "can.why.remove", "can.why.revoke", "can.why.withdraw", "can.why.own_only", "can.why.share_worker", `can.packages.${F.factoryPkg}.why`, `can.workers.${F.communityWorker}.why.own_only`, `can.workers.${F.communityWorker}.why.share_worker`] },
        { path: `${profile}/can`, as: "owner", fields: ["login", "can.request", "can.register", "can.token", "can.build", "can.revoke", "can.own_only", "can.share_worker", "can.why.withdraw", `can.packages.${F.factoryPkg}.remove`, `can.packages.${F.factoryPkg}.why`, `can.workers.${F.communityWorker}.revoke`, `can.workers.${F.communityWorker}.own_only`, `can.workers.${F.communityWorker}.share_worker`] },
        { path: `${profile}/can`, as: "maintainer", fields: ["login", "can.remove", "can.revoke", "can.withdraw", "can.own_only", "can.why.request", "can.why.build", "can.why.share_worker", `can.packages.${F.factoryPkg}.remove`, `can.workers.${F.communityWorker}.revoke`, `can.workers.${F.communityWorker}.why.share_worker`] },
        // A maintainer's own page lists the project's worker: its mode is nobody's to set, the state's word for every role.
        { path: `/api/v1/users/${F.m1}/can`, as: "maintainer", fields: [`can.workers.${F.worker}.revoke`, `can.workers.${F.worker}.why.own_only`, `can.workers.${F.worker}.why.share_worker`] },
      ],
      visible: EVERYONE,
    },
    {
      id: "user.profile-head",
      page,
      anchor: ['id="avatar"', 'id="title"'],
      script: ['"#avatar"', '"#title"', 'd.login.slice(0, 2)', 'd.role === "maintainer"'],
      reads: [{ path: profile, fields: ["login", "name", "role"] }],
      visible: EVERYONE,
    },
    {
      id: "user.identity-line",
      page,
      anchor: ['id="line"'],
      script: ['"#line"', "d.blocked", "d.maintainer_since", "ago(d.last_seen)", "d.github"],
      reads: [
        { path: profile, fields: ["role", "blocked", "maintainer_since", "since", "last_seen", "github", "login"] },
        { path: `/api/v1/users/${F.m2}`, fields: ["role", "maintainer_since"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "user.tiles",
      page,
      anchor: ['id="tiles"'],
      script: ['"#tiles"', "d.build_counts", "d.approved_packages.length", "w.revoked_at", "w.alive"],
      reads: [{ path: profile, fields: ["packages", "build_counts.total", "build_counts.staged", "build_counts.published", "build_counts.failed", "approvals", "approved_packages", "workers", "workers.0.revoked_at", "workers.0.alive"] }],
      visible: EVERYONE,
    },
    {
      id: "user.activity-chart",
      page,
      anchor: ['id="activity"', 'id="activity-note"'],
      script: ['"#activity"', '"#activity-note"', "mark(b.created_at)", "mark(a.created_at)", "mark(p.updated_at)"],
      reads: [
        { path: profile, fields: ["builds.0.created_at", "packages.0.updated_at"] },
        { path: `/api/v1/users/${F.m2}`, fields: ["approvals.0.created_at"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "user.score-panel",
      page,
      anchor: ['href="/docs/governance">the formula', 'id="score"', 'id="score-f"'],
      script: ['"#score"', '"#score-f"', "rec.score"],
      reads: [{ path: profile, fields: ["record.score"] }],
      visible: EVERYONE,
    },
    {
      id: "user.record-section",
      page,
      anchor: ['id="record-section"', 'id="record"'],
      script: ['"#record-section"', 'pager("#record"', "rec.contributed", "rec.maintained", "m.rebuilds_failed"],
      reads: [{ path: profile, fields: ["record.contributed.approved", "record.contributed.staged", "record.contributed.bumps", "record.contributed.donated", "record.contributed.rejected", "record.maintained.approvals", "record.maintained.rejections", "record.maintained.rebuilds_failed", "record.score"] }],
      visible: EVERYONE,
    },
    {
      // The table, and the way to request a package: served grey with whose it is, drawn again from the server's word (the owner's).
      id: "user.packages-table",
      page,
      anchor: ['id="pk-request"', 'data-href="/request"', `title="only ${F.owner} requests here"`, 'id="packages"'],
      script: ['pager("#packages"', '"#pk-request"', 'href=\\"/request\\"', 'gate(REQUEST_LINK, may("request"), reason("request"))', "data-expand", 'JSON.parse(p.arches', "p.detail", 'byPkg[p.name + "/" + a]', "data-story"],
      reads: [{ path: profile, fields: ["packages.0.name", "packages.0.category", "packages.0.url", "packages.0.arches", "packages.0.status", "packages.0.detail", "builds.0.name", "builds.0.arch", "builds.0.status", "builds.0.id"] }],
      visible: EVERYONE,
    },
    {
      // The open row's first line, with Build all and Remove for everyone — Build the owner's, grey by state first (a build in flight, the package blocked); Remove answered per registration (a maintainer's on an approved one); the cue that the request is renewed below, for everyone, naming whose it is; the Remove dialog is this entry's.
      id: "user.story-head",
      page,
      anchor: ['id="packages"'],
      script: ['"/api/v1/factory/packages/"', '"/story"', "pkg.blocked_at", '"request incomplete"', '"renewed below by "', "acts-inline", "function buildBtn(", "function removeBtn(", "removeOf(name)", '"a build is in flight"', "function blockedWhy(", "data-build", "data-remove", '"Remove the registration of "', 'api("DELETE", API + "/packages/" + encodeURIComponent(rm))'],
      reads: [{ path: story, fields: ["package.arches", "package.status", "package.blocked_at", "request.arches", "request.complete", "request.renewable", "chains", "chains.0.contributor.arch", "chains.0.contributor.status", "chains.0.project", "chains.0.approval", "chains.0.score.ready"] }],
      // The owner is refused: by now a manifest before this one rejected one of the community's builds, which put the registration back to `registered`, and the project's build of it is still staged for a decision — the owner waits for the maintainers (409). A maintainer's removal would take the package with it, so none is sent.
      acts: [{ method: "DELETE", path: `/api/v1/factory/packages/${F.factoryPkg}`, expect: { anonymous: 401, contributor: 403, owner: 409 } }],
      visible: EVERYONE,
    },
    {
      // The request as the form checks it, with Renew the request for everyone: live for the owner while a renewal is taken, grey with the state's reason for the owner and the server's (can.why.request, the same word the build's page reads) for anyone else.
      id: "user.story-request-block",
      page,
      anchor: ['id="packages"'],
      script: ['requestBlock(st.request, may("request"), name, renewable, whyNot, reason("request"))', "st.request.renewable", "st.request.busy", '"renew it once build #"'],
      reads: [{ path: story, fields: ["request.id", "request.record", "request.signature", "request.version", "request.created_at", "request.complete", "request.checks", "request.checks.0.item", "request.checks.0.ok", "request.checks.0.note", "request.renewable", "request.busy", "request.arches"] }],
      visible: EVERYONE,
    },
    {
      // One panel per architecture, its Build for everyone: grey while a build runs or the package is blocked, by role otherwise.
      id: "user.story-arch-panel",
      page,
      anchor: ['id="packages"'],
      script: ["archPanel(a, mine, nextStep(st, mine[0]), acts)", "registered.indexOf(a) >= 0", "buildBtn(name, a,", '"a build is running"', "data-arch", 'href="/api/v1/factory/tasks/'],
      reads: [
        { path: story, fields: ["chains.0.contributor.id", "chains.0.contributor.status", "chains.0.contributor.arch", "chains.0.contributor.version", "chains.0.contributor.owner", "chains.0.contributor.lease_owner", "chains.0.contributor.finished_at", "chains.0.contributor.duration_ms", "chains.0.contributor.result.vet", "chains.0.project", "chains.0.audit", "chains.0.trial", "chains.0.approval", "chains.0.withdrawn", "chains.0.score.class", "chains.0.score.points", "chains.0.score.projected", "chains.0.score.ready", "chains.0.score.items.0.who", "chains.0.score.items.0.item", "chains.0.score.items.0.points", "package.blocked_at", "package.arches"] },
        { path: evidence(F.contributorTask, "tests.log"), json: false },
        { path: evidence(F.contributorTask, "vet.json"), json: false },
        { path: evidence(F.contributorTask, "audit.md"), json: false },
        { path: evidence(F.projectTask, "build.log"), json: false },
        { path: evidence(F.projectTask, "trial.log"), json: false },
      ],
      visible: EVERYONE,
    },
    {
      id: "user.story-next-step",
      page,
      anchor: ['id="packages"'],
      script: ["function nextStep(", "cc.pinned_to", "cc.shared_after", "cc.queue", "audit.result.verdict", '"A request on the record"', "whereOptions(FACTORY.workers, arch, login, false)"],
      reads: [
        { path: story, fields: ["chains.0.contributor.status", "chains.0.contributor.pinned_to", "chains.0.contributor.shared_after", "chains.0.contributor.attempts", "chains.0.contributor.pkgbuild_ref", "chains.0.contributor.version", "chains.0.contributor.error", "chains.0.contributor.result.vet.verdict", "chains.0.audit", "chains.0.score.items", "request.complete", "request.version", "rings"] },
        { path: factory, fields: ["workers.0.id", "workers.0.alive", "workers.0.labels"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "user.story-footer",
      page,
      anchor: ['id="packages"'],
      script: ['?ring=lab">The package', "st.rings.map"],
      reads: [{ path: story, fields: ["rings"] }],
      visible: EVERYONE,
    },
    {
      // Build <arch> and Build all open it — the owner's buttons, live for them alone: it chooses where the build runs, posts it, or takes the waiting one out of the queue (the owner's too: can.dequeue).
      id: "user.build-dialog",
      page,
      anchor: ['id="packages"'],
      script: ["st2.package.detected", "det.has_pkgbuild", 'whereOptions(FACTORY.workers, arch || "x86_64"', "go.alt", '"/builds/" + t.id', '"/build", body', "body.worker = go.pick", "body.hint"],
      reads: [
        { path: factory, fields: ["workers.0.arch", "workers.0.owner", "workers.0.mode", "workers.0.side", "workers.0.alive", "workers.0.agent_status", "workers.0.update"] },
        { path: story, fields: ["package.detected", "chains.0.contributor.status", "chains.0.contributor.arch", "chains.0.contributor.pinned_to"] },
      ],
      acts: [
        { method: "POST", path: `/api/v1/factory/packages/${F.factoryPkg}/build`, body: { arches: [F.arch] }, expect: { anonymous: 401, contributor: 404, owner: 201, maintainer: 404 } },
        { method: "DELETE", path: `/api/v1/factory/packages/${F.factoryPkg}/builds/${F.stagedTask}`, expect: { anonymous: 401, contributor: 403, owner: 409, maintainer: 403 } },
      ],
      visible: ["owner"],
    },
    {
      // The evidence column for everyone: the log and the PKGBUILD are public.
      id: "user.builds-table",
      page,
      anchor: ['id="builds"', "<th>Evidence</th>"],
      script: ['pager("#builds"', "t.lease_owner", "t.pinned_to", "dur(t.duration_ms)", "t.queue", '/artifacts/build.log">log', '/artifacts/PKGBUILD">PKGBUILD', "evidence(t)"],
      reads: [
        { path: profile, fields: ["builds.0.id", "builds.0.name", "builds.0.version", "builds.0.arch", "builds.0.status", "builds.0.reason", "builds.0.trust", "builds.0.lease_owner", "builds.0.pinned_to", "builds.0.duration_ms", "builds.0.created_at"] },
        { path: evidence(F.contributorTask, "build.log"), json: false },
        { path: evidence(F.contributorTask, "PKGBUILD"), json: false },
      ],
      visible: EVERYONE,
    },
    {
      // The cell is everyone's: the owner's own figure (GET /factory/me answers for the caller), a dash on their page for anyone else.
      id: "user.staging-quota",
      page,
      anchor: ['id="quota"'],
      script: ['"#quota"', 'api("GET", API + "/me")', "st.bytes", "st.quota_bytes", '$("#quota").textContent = "—"'],
      reads: [
        { path: "/api/v1/factory/me", status: 401 },
        { path: "/api/v1/factory/me", as: "owner", fields: ["staging.bytes", "staging.quota_bytes"] },
      ],
      visible: EVERYONE,
    },
    {
      // Share and Token for everyone: Share live for all (the page is public, its link anyone's — no door), Token served grey with whose it is and drawn again from the server's word; the token dialogs are this entry's, the share dialog only copies the page's address.
      id: "user.share-token-buttons",
      page,
      anchor: ['id="share-btn"', 'id="share-open" title="the link to this page, to post anywhere"', 'id="token-open"', `title="only ${F.owner} mints their token"`],
      script: ['"#share-btn"', "SHARE_BTN + ' ' + gate(TOKEN_BTN, may(\"token\"), reason(\"token\"))", '"Share " + (isOwner(login) ? "your" : "this") + " profile"', '"#share-open"', '"#token-open"', 'api("POST", API + "/token", {})', "OMARCHY_CONTRIBUTOR_TOKEN", "sticky: true"],
      reads: [{ path: "/auth/me", as: "owner", fields: ["login"] }],
      acts: [{ method: "POST", path: "/api/v1/factory/token", expect: { anonymous: 401, contributor: 201, owner: 201 } }],
      visible: EVERYONE,
    },
    {
      // The way in for a worker, for everyone: the toggle live for all (it only shows the form), the form's fields served grey with whose they are and drawn again from the server's word (the owner's, unless blocked).
      id: "user.workers-register",
      page,
      anchor: ['id="w-toggle" title="the form: a name, an architecture, one command to run it"', `title="only ${F.owner} registers a worker here"`, 'id="w-own"', 'href="/docs/workers"', 'id="worker-form"', 'id="w-name"', 'id="w-arch"', 'id="w-btn"'],
      script: ['"#w-toggle"', 'gate(WORKER_FORM, may("register"), reason("register"))', '"#worker-form"', '"#w-name"', '"#w-arch"', '"#w-btn"', 'api("POST", API + "/workers", body)'],
      acts: [{ method: "POST", path: "/api/v1/factory/workers", body: { name: "laptop", arch: F.arch }, expect: { anonymous: 401, owner: 201 } }],
      visible: EVERYONE,
    },
    {
      id: "user.worker-token-block",
      page,
      anchor: ['id="w-new"', 'id="w-cmd"'],
      script: ['"#w-new"', '"#w-cmd"', "--token \" + d.token"],
      visible: ["owner"],
    },
    {
      // The three panels by kind from one listing; every row — a revoked worker's and a project's too — carries Share / Own only and Revoke for whoever looks, grey with the state's word first (revoked already; a project worker has no mode) and the role's after (the owner's, and a maintainer's but for sharing, the owner's word alone), the shell's log icon beside the id the same way; the Revoke dialog is this entry's.
      id: "user.workers-tables",
      page,
      shared: "worker-table",
      anchor: ['id="wp-community"', 'id="w-community"', 'id="wp-review"', 'id="w-review"', 'id="wp-project"', 'id="w-project"', 'id="w-none"'],
      script: ['"/api/v1/factory?limit=10"', "w.owner === login", "wtKind(w)", "wtTables(true)", "workerRow(w, k, workerActs(w))", "text: wtText", "function workerActs(", 'workerCan(w, toShared ? "share_worker" : "own_only")', 'workerCan(w, "revoke")', "data-mode", "data-revoke", '"/mode"', 'api("DELETE", API + "/workers/" + encodeURIComponent(wid))', 'title="its own log — the lines between tasks, as it sent them"'],
      reads: [{ path: factory, fields: ["workers", "workers.0.id", "workers.0.owner", "workers.0.side", "workers.0.mode", "workers.0.arch", "workers.0.alive", "workers.0.revoked_at", "workers.0.labels", "workers.0.agent_status", "workers.0.update"] }],
      acts: [
        { method: "POST", path: `/api/v1/factory/workers/${F.communityWorker}/mode`, body: { mode: "shared" }, expect: { anonymous: 401, contributor: 403, owner: 200, maintainer: 403 } },
        { method: "POST", path: `/api/v1/factory/workers/${F.communityWorker}/mode`, body: { mode: "dedicated" }, expect: { anonymous: 401, contributor: 403, maintainer: 200, owner: 200 } },
        { method: "DELETE", path: `/api/v1/factory/workers/${F.communityWorker}`, expect: { anonymous: 401, contributor: 404, owner: 200 } },
      ],
      visible: EVERYONE,
    },
    {
      id: "user.workers-legend",
      page,
      shared: "worker-legend",
      anchor: ['id="wt-legend"'],
      script: ["wtTables(true)", '$("#wt-legend").hidden = !any'],
      visible: EVERYONE,
    },
    {
      // Shown on a maintainer's page; Withdraw is on every row for whoever looks — live for a maintainer where an approval stands, grey with why not otherwise — with its dialog.
      id: "user.approvals-table",
      page: `/user/${F.m2}`,
      anchor: ['id="approvals-section"', 'id="approvals"'],
      script: ['"#approvals-section"', 'pager("#approvals"', 'a.decision === "approved"', "a.withdrawn_at", "a.rings", "withdrawBtn(a, standing)", 'may("withdraw") && standing', '"nothing standing to withdraw"', "data-withdraw", '"/tasks/" + wid + "/withdraw"'],
      reads: [{ path: `/api/v1/users/${F.m2}`, fields: ["role", "approvals.0.task_id", "approvals.0.name", "approvals.0.arch", "approvals.0.version", "approvals.0.decision", "approvals.0.note", "approvals.0.created_at", "approvals.0.withdrawn_at", "approvals.0.rings", "approved_packages.0"] }],
      // The fixture's one approval was taken back by the build page's manifest, which walks before this one: nothing stands to withdraw.
      acts: [{ method: "POST", path: `/api/v1/factory/tasks/${F.projectTask}/withdraw`, body: { note: "the source is not the upstream's" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 404 } }],
      visible: EVERYONE,
    },
    {
      id: "user.not-found-state",
      page,
      anchor: ['id="line"'],
      script: ["d.__status !== 200", 'd.error || "not found"', '"could not load: "'],
      reads: [{ path: "/api/v1/users/nobody", status: 404, fields: ["error"] }],
      visible: EVERYONE,
    },
  ];
};
