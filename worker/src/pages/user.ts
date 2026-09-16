/**
 * A contributor's or maintainer's public page: who they are on GitHub,
 * what they registered and built, what they approved, the workers they run.
 * Their own page is also their workspace — "Sign in with GitHub" lands here:
 * Build and remove on the packages, register and revoke on the workers, the
 * evidence of every build, the staging quota, a token for scripts. Everything
 * is the public API (`/api/v1/factory/*`) with the browser session.
 */
import { page } from "./layout";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

const BODY = String.raw`
  <div class="profile-head">
    <span class="avatar lg" id="avatar">…</span>
    <div><p class="crumbs"><a href="/factory">Factory</a> / <span id="crumb"></span></p><h1 id="title">…</h1><p class="line" id="line"></p></div>
    <span id="share-btn"></span>
  </div>
  <div class="tiles" id="tiles"></div>
  <div class="two" style="margin-bottom:44px">
    <div class="panel"><h3>Activity <span class="dim" style="font-size:12px;font-weight:400">16 weeks · builds, decisions, packages</span></h3><div class="activity" id="activity"></div><p class="sub" id="activity-note" style="margin:8px 0 0;font-size:12.5px"></p></div>
    <div class="panel"><h3>Track record <a href="/docs/governance">the formula →</a></h3><div class="score"><b id="score">…</b><div class="f" id="score-f"></div></div></div>
  </div>
  <section id="share" hidden>
    <div class="h2row"><h2>Share it</h2><span class="hint">this page is public — everything on it is on the record anyway</span></div>
    <div class="share"><p><b style="color:var(--text)">You are part of open source.</b> Copy the link and post it wherever you like — your GitHub profile, LinkedIn, a blog. What it shows is what the pool recorded: packages, builds, decisions.</p><pre><span class="copy" id="copy-link">copy</span><span id="share-url"></span></pre><div class="row"><a class="btn ghost" href="/request">Request a package</a><a class="btn ghost" href="/auth/logout">Sign out</a></div>
      <p class="sub" style="margin:12px 0 0;font-size:12.5px">Scripts and CI use a contributor token (<code>Authorization: Bearer omc_…</code>): <button type="button" class="small-btn" id="cli-token">Generate a token</button> <span class="dim">shown once; replaces the previous one, your workers keep theirs</span></p>
      <pre id="cli-token-out" hidden></pre></div>
  </section>

  <section id="record-section" hidden>
    <h2>Track record</h2>
    <p class="sub">From the record the pool keeps anyway — what this person brought that a maintainer let in, what they built, what they decided. One number, with a formula anyone can check (<a href="/docs/governance">Governance</a>): it says where the work was done, not who someone is.</p>
    <div class="table-wrap"><table id="record"><thead><tr><th>Contributed</th><th>Maintained</th><th>Score</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Packages</h2><a class="more-link" id="pk-request" href="/request" hidden>+ request one →</a></div>
    <p class="sub">Registered by this contributor: the name is theirs, their worker builds it, a maintainer reviews it.</p>
    <p class="notice" id="pkg-state" hidden></p>
    <div class="table-wrap"><table id="packages"><thead><tr><th>Package</th><th>Category</th><th>Project</th><th>Arches</th><th>Stage</th><th>Detail</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section id="approvals-section" hidden>
    <h2>Approvals</h2>
    <p class="sub">Decisions this maintainer signed: what they let into the pool, and what they sent back.</p>
    <div class="table-wrap"><table id="approvals"><thead><tr><th>When</th><th>Package</th><th>Arch</th><th>Decision</th><th>Note</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Builds</h2><span class="dim" id="quota" style="font-size:12px"></span></div>
    <p class="sub">On this contributor's workers — evidence for a maintainer, never what users get directly.</p>
    <div class="table-wrap"><table id="builds"><thead><tr><th>#</th><th>Package</th><th>Arch</th><th>Status</th><th>Why</th><th>Took</th><th>When</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section>
    <div class="h2row"><h2>Workers</h2><button type="button" class="more-link" id="w-toggle" hidden>+ register one</button></div>
    <div id="w-own" hidden>
      <p class="sub" style="margin:0 0 10px;font-size:12.5px">Optional — the shared workers build for you otherwise. Register one and run the signed image with the token it gives you, shown once: your packages only, your agent. <a href="/docs/workers">Run a worker →</a></p>
      <form id="worker-form" class="form" onsubmit="return false" hidden>
        <label>Name <input type="text" id="w-name" placeholder="laptop" required></label>
        <label>Architecture <select id="w-arch"><option>x86_64</option><option>aarch64</option></select></label>
        <button type="submit" id="w-btn">Register worker</button>
      </form>
      <div id="w-new" hidden><p class="sub">Your worker token, shown once. Run one of these wherever the worker lives (podman or docker):</p><pre id="w-cmd"></pre></div>
    </div>
    <div class="table-wrap"><table id="workers"><thead><tr><th>Worker</th><th>Arch</th><th>Trust</th><th>Mode</th><th>Agent</th><th>Last seen</th><th>Done / failed</th></tr></thead><tbody></tbody></table></div>
  </section>
`;

const SCRIPT = String.raw`
  var login = decodeURIComponent(location.pathname.split("/")[2] || "");
  $("#crumb").textContent = login;
  skeletonTiles("#tiles", 4); skeletonRows("#packages", 6, 2); skeletonRows("#builds", 7, 3); skeletonRows("#workers", 7, 1);
  function pill(s) {
    var c = { leased: "var(--blue)", queued: "var(--amber)", done: "var(--green)", staged: "var(--green)", failed: "var(--red)", cancelled: "var(--dim)", registered: "var(--dim)", waiting: "var(--amber)", building: "var(--blue)", approved: "var(--green)", rejected: "var(--red)", unmaintained: "var(--red)" }[s] || "var(--dim)";
    return '<span class="pill" style="color:' + c + ';border-color:' + c + '">' + esc(s === "leased" ? "building" : s) + '</span>';
  }
  function took(ms) { if (ms == null) return "—"; var s = Math.round(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + " min"; }
  // Your own page is the workspace: the same tables, with the buttons.
  var own = false, API = "/api/v1/factory", REPO = "${REPO_URL}";
  function call(method, path, body) {
    return busy(fetch(API + path, { method: method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).then(function (r) { return r.json().then(function (d) { d.__status = r.status; return d; }); });
  }
  function note(t) { var el = $("#pkg-state"); el.hidden = !t; el.textContent = t || ""; }
  function evidence(t) {
    var log = '<a class="run" href="' + API + '/tasks/' + t.id + '/artifacts/build.log">log</a>';
    return t.status === "staged" ? log + ' <a class="run" href="' + API + '/tasks/' + t.id + '/artifacts/PKGBUILD">PKGBUILD</a>' : t.status === "failed" ? log : "";
  }
  function load() {
  // Past the edge cache when it is yours: a Build or a Revoke shows at once.
  return busy(fetch("/api/v1/users/" + encodeURIComponent(login) + (own ? "?t=" + Date.now() : ""))).then(function (r) { return r.json().then(function (d) { d.__status = r.status; return d; }); }).then(function (d) {
    if (d.__status !== 200) { $("#title").textContent = login; $("#line").textContent = d.error || "not found"; endSkeleton(); return; }
    document.title = login + " · omarchy-pool";
    $("#title").innerHTML = esc(d.name || d.login) + ' <span class="dim" style="font-weight:500">@' + esc(d.login) + '</span>';
    // An icon, never a photo: two letters, green for a maintainer.
    $("#avatar").textContent = d.login.slice(0, 2); if (d.role === "maintainer") $("#avatar").classList.add("m");
    $("#line").innerHTML = '<span class="pill ' + (d.role === "maintainer" ? "rec" : "ok") + '">' + esc(d.role) + '</span>' +
      (d.blocked ? '<span class="pill error" title="by ' + esc(d.blocked.by || "") + ', ' + esc(d.blocked.at || "") + '">blocked: ' + esc(d.blocked.reason || "") + '</span>' : '') +
      (d.maintainer_since ? '<span class="pill none" title="listed in factory/MAINTAINERS.toml">since ' + esc(ago(d.maintainer_since)) + '</span>' : '') +
      '<span>since ' + esc(String(d.since).slice(0, 10)) + '</span><span class="dim">·</span><span>last seen ' + ago(d.last_seen) + '</span><span class="dim">·</span><a href="' + esc(d.github) + '" style="color:var(--muted);text-decoration:none">github.com/' + esc(d.login) + ' ↗</a>';
    var c = d.build_counts;
    var tiles = [
      ["Packages", num(d.packages.length), "registered under this name"],
      ["Builds", num(c.total), num(c.staged) + " staged · " + num(c.published) + " published · " + num(c.failed) + " failed"],
      ["Approvals", num(d.approvals.length), d.role === "maintainer" ? num(d.approved_packages.length) + " package(s) let into the pool" : "not a maintainer"],
      ["Workers", num(d.workers.filter(function (w) { return !w.revoked_at; }).length), num(d.workers.filter(function (w) { return w.alive; }).length) + " alive now"]
    ];
    $("#tiles").innerHTML = tiles.map(function (t) { return '<div class="tile"><div class="k">' + t[0] + '</div><div class="v num">' + t[1] + '</div><div class="s">' + t[2] + '</div></div>'; }).join("");
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
    pager("#packages", d.packages, function (p) {
      var arches = []; try { arches = JSON.parse(p.arches || "[]"); } catch (e) {}
      var act = own ? '<td style="white-space:nowrap"><button type="button" data-build="' + esc(p.name) + '">Build</button> <button type="button" data-remove="' + esc(p.name) + '" title="remove the registration">✕</button></td>' : '';
      return '<tr><td><a href="/package/' + encodeURIComponent(p.name) + '"><b>' + esc(p.name) + '</b></a></td><td>' + (p.category ? '<span class="pill none">' + esc(p.category) + '</span>' : '<span class="dim">—</span>') + '</td><td>' + (p.url ? '<a href="' + esc(p.url) + '">' + esc(p.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")) + '</a>' : '') + '</td><td>' + esc(arches.join(", ")) + '</td><td>' + pill(p.status) + '</td><td>' + esc(p.detail || "") + '</td>' + act + '</tr>';
    }, { empty: "no package registered" });
    if (d.approvals.length || d.role === "maintainer") {
      $("#approvals-section").hidden = false;
      pager("#approvals", d.approvals, function (a) {
        return '<tr><td class="when">' + ago(a.created_at) + '</td><td><a href="/package/' + encodeURIComponent(a.name) + '">' + esc(a.name) + '</a> <span class="mono muted">' + esc(a.version || "") + '</span></td><td>' + esc(a.arch) + '</td><td>' + pill(a.decision) + '</td><td>' + esc(a.note || "") + '</td></tr>';
      }, { empty: "no decision yet" });
    }
    pager("#builds", d.builds, function (t) {
      return '<tr><td>' + t.id + '</td><td><b>' + esc(t.name) + '</b>' + (t.version ? ' <span class="mono muted">' + esc(t.version) + '</span>' : '') + '</td><td>' + esc(t.arch) + '</td><td>' + pill(t.status) + '</td><td>' + esc(t.reason || "") + '</td><td>' + took(t.duration_ms) + '</td><td class="when">' + ago(t.finished_at || t.created_at) + '</td>' + (own ? '<td>' + evidence(t) + '</td>' : '') + '</tr>';
    }, { empty: "nothing built yet" });
    pager("#workers", d.workers, function (w) {
      return '<tr><td>' + workerName(w) + (w.revoked_at ? ' <span class="pill none">revoked</span>' : w.alive ? ' <span class="pill ok">alive</span>' : '') + '</td><td>' + esc(w.arch) + '</td><td>' + esc(w.trust) + '</td><td>' + esc(w.mode) + '</td><td>' + agentCell(w) + '</td><td class="when">' + ago(w.last_seen) + '</td><td>' + num(w.builds_done) + ' / ' + num(w.builds_failed) + '</td>' + (own ? '<td>' + (w.revoked_at ? '' : '<button type="button" data-revoke="' + esc(w.id) + '">Revoke</button>') + '</td>' : '') + '</tr>';
    }, { empty: "no worker registered" });
    endSkeleton();
  }).catch(function (e) { $("#line").textContent = "could not load: " + e; endSkeleton(); });
  }
  load().then(function () {
    // Your own page: the workspace — the buttons on the tables, a worker to register, the quota, a token for scripts, the place to sign out.
    whoami(function (me) {
      if (!me || me.login !== login) return;
      own = true;
      var url = location.origin + "/user/" + encodeURIComponent(login);
      $("#share").hidden = false; $("#share-url").textContent = url; $("#share-btn").innerHTML = '<a class="btn" href="#share">Share your profile</a>';
      $("#copy-link").onclick = function () { navigator.clipboard.writeText(url).then(function () { $("#copy-link").textContent = "copied"; setTimeout(function () { $("#copy-link").textContent = "copy"; }, 1500); }); };
      $("#pk-request").hidden = false; $("#w-toggle").hidden = false; $("#w-own").hidden = false;
      $("#packages thead tr").insertAdjacentHTML("beforeend", "<th></th>"); $("#workers thead tr").insertAdjacentHTML("beforeend", "<th></th>"); $("#builds thead tr").insertAdjacentHTML("beforeend", "<th>Evidence</th>");
      load(); quota();
    });
  });
  function quota() {
    call("GET", "/me").then(function (d) { var st = d.staging; if (!st) return; $("#quota").textContent = "staging " + (st.bytes / 1048576).toFixed(1) + " MB of " + (st.quota_bytes / 1073741824).toFixed(0) + " GB · evidence expires after 30 days"; }).catch(function () {});
  }
  // Buttons inside paged tables: one delegated handler survives re-renders.
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-build],button[data-remove],button[data-revoke]") : null; if (!b) return;
    if (b.hasAttribute("data-build")) { b.disabled = true; call("POST", "/packages/" + encodeURIComponent(b.getAttribute("data-build")) + "/build", {}).then(function (r) { note(r.error || ("queued " + (r.tasks || []).length + " build(s): " + (r.arches || []).join(", ") + " — start your worker if it is not running")); load(); }); }
    else if (b.hasAttribute("data-remove")) { if (!confirm("Remove the registration of " + b.getAttribute("data-remove") + "?")) return; call("DELETE", "/packages/" + encodeURIComponent(b.getAttribute("data-remove"))).then(function (r) { note(r.error || ("removed " + r.deleted)); load(); }); }
    else if (b.hasAttribute("data-revoke")) { call("DELETE", "/workers/" + encodeURIComponent(b.getAttribute("data-revoke"))).then(load); }
  });
  $("#w-toggle").onclick = function () { $("#worker-form").hidden = !$("#worker-form").hidden; };
  $("#worker-form").onsubmit = function () {
    var body = { name: $("#w-name").value.trim(), arch: $("#w-arch").value };
    $("#w-btn").disabled = true;
    call("POST", "/workers", body).then(function (d) {
      $("#w-btn").disabled = false;
      if (d.error) { note(d.error); return; }
      $("#w-new").hidden = false;
      $("#w-cmd").textContent =
        "# two containers: the broker holds the token (and your agent's key, and a GITHUB_TOKEN — a fine-grained one with no permissions),\n" +
        "# the builder beside it is born with nothing, builds one task and exits; the restart brings the next. With compose\n" +
        "# (" + REPO + "/blob/main/factory/image/compose.yml; docker works the same):\n" +
        "OMARCHY_WORKER_TOKEN=" + d.token + " GITHUB_TOKEN=<github_pat_…, no permissions> podman compose -f compose.yml up -d\n\n" +
        "# or by hand\n" +
        "podman network create omarchy-worker\n" +
        "podman run -d --name omarchy-broker --restart unless-stopped --network omarchy-worker \\\n  -e OMARCHY_WORKER_ROLE=broker -e OMARCHY_WORKER_TOKEN=" + d.token + " -e GITHUB_TOKEN=<github_pat_…, no permissions> \\\n  ghcr.io/firemanxbr/omarchy-worker:latest\n" +
        "podman run -d --name omarchy-worker --restart unless-stopped --stop-timeout 10800 --network omarchy-worker \\\n  -e OMARCHY_BROKER=http://omarchy-broker:8790 \\\n  ghcr.io/firemanxbr/omarchy-worker:latest\n\n" +
        "# on the broker: -e ANTHROPIC_API_KEY=… (or OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: your key) — the agent that writes the PKGBUILD; without one that answers, the worker is not ready";
      $("#worker-form").reset(); $("#worker-form").hidden = true; load();
    }).catch(function (e) { $("#w-btn").disabled = false; note("failed: " + e); });
    return false;
  };
  $("#cli-token").onclick = function () {
    $("#cli-token").disabled = true;
    call("POST", "/token", {}).then(function (d) { $("#cli-token").disabled = false; if (d.error) { note(d.error); return; } $("#cli-token-out").hidden = false; $("#cli-token-out").textContent = "export OMARCHY_CONTRIBUTOR_TOKEN=" + d.token + "\n# " + d.note; })
      .catch(function (e) { $("#cli-token").disabled = false; note("failed: " + e); });
  };
  liveStats(function () {}, 120000);
`;

export function userHtml(login: string, poolUrl: string, version: RunningVersion): string {
  return page({
    title: `${login} · omarchy-pool`,
    description: `What ${login} contributes to and maintains in the pool.`,
    active: "factory",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}
