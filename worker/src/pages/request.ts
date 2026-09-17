/**
 * /request — the package request, on a page of its own: nothing to look at
 * but the four fields and the four confirmations. Linked from the Factory
 * page, never from the header or the footer; a contributor lands here to
 * ask for one thing. Signed in with GitHub (the session cookie); the
 * request goes to POST /api/v1/factory/packages and comes back with its
 * record, then the build is one press away.
 */
import { page, GITHUB_ICON } from "./layout";
import { EVERYONE, SIGNED_IN, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow" id="eyebrow">Package request</p>
    <h1 id="h1">Ask for a package, on the record</h1>
    <p class="lede" id="lede">Four fields, four confirmations. The pool checks it, writes it once with its signature, and the build starts by itself — in the shared queue, the best idle worker first. <a href="/docs/governance">What happens after →</a></p>
  </div>

  <div id="gate" class="gate"><div><div class="lock">GitHub sign-in</div><h3 style="margin-top:6px">Who is asking</h3><p>A request carries your GitHub login — it is on the record, next to the package. Nothing else is asked, no permission is needed.</p></div><a class="btn" href="/auth/github?next=/request">${GITHUB_ICON} Sign in with GitHub</a></div>

  <section id="ask" hidden>
    <div class="panel request-panel">
      <form id="pkg-form" class="form" onsubmit="return false">
        <label>Project URL <input type="url" id="pkg-url" placeholder="https://github.com/owner/project — or …/archive/refs/tags/v1.2.3.tar.gz" required autofocus></label>
        <label>Package name <input type="text" id="pkg-name" placeholder="(the repository's name)" pattern="[a-z0-9@._+-]+"></label>
        <label>Description <input type="text" id="pkg-desc" placeholder="one line, what pacman shows" minlength="8" maxlength="120" required></label>
        <label>Licence (SPDX) <input type="text" id="pkg-license" placeholder="MIT · GPL-3.0-or-later · Apache-2.0" list="spdx" required><datalist id="spdx"><option>MIT</option><option>Apache-2.0</option><option>GPL-2.0-only</option><option>GPL-2.0-or-later</option><option>GPL-3.0-only</option><option>GPL-3.0-or-later</option><option>LGPL-2.1-or-later</option><option>LGPL-3.0-or-later</option><option>AGPL-3.0-or-later</option><option>BSD-2-Clause</option><option>BSD-3-Clause</option><option>MPL-2.0</option><option>ISC</option><option>Unlicense</option><option>0BSD</option><option>Zlib</option><option>EUPL-1.2</option><option>custom:proprietary</option></datalist></label>
        <label>Architectures <span class="choice"><label><input type="checkbox" id="pkg-x86" checked> x86_64</label> <label><input type="checkbox" id="pkg-arm" checked> aarch64</label></span></label>
        <details class="form-more"><summary>Not on GitHub? The release itself</summary>
          <label>Source URL <input type="url" id="pkg-source" placeholder="https://…/project-1.2.3.tar.gz (or the vendor's release artifact)"></label>
          <label>Version <input type="text" id="pkg-version" placeholder="1.2.3"></label>
        </details>
        <div class="checklist" id="pkg-checklist">
          <label><input type="checkbox" data-check="official"> The URL is the project's own repository or its official release — not a fork, not a mirror.</label>
          <label><input type="checkbox" data-check="license"> The licence is the one the project declares (an SPDX identifier).</label>
          <label><input type="checkbox" data-check="unshipped"> No upstream the pool mirrors ships this package already, and nobody else requested it.</label>
          <label><input type="checkbox" data-check="evidence"> My build is evidence a maintainer learns from, never what users get; the pool may reject or block it.</label>
        </div>
        <button type="submit" id="pkg-btn">Request</button>
      </form>
      <p class="sub" id="pkg-state"></p>
      <div id="done" class="done" hidden></div>
    </div>
    <p class="sub" style="margin-top:14px">Requested before? <a href="/factory#gate">Your workspace</a> has every package, its stage and its evidence.</p>
  </section>
`;

const SCRIPT = String.raw`
  // A renewal (?renew=<name>, from the package's row on your page): the same form, filled from the record — the confirmations are yours to tick again.
  var RENEW = new URLSearchParams(location.search).get("renew");
  function prefill(name) {
    fetch("/api/v1/factory/packages/" + encodeURIComponent(name) + "/story?t=" + Date.now()).then(function (r) { return r.ok ? r.json() : null; }).then(function (st) {
      if (!st || !st.package) return;
      var p = st.package, q = st.request || {};
      $("#eyebrow").textContent = "Renew the request"; $("#h1").textContent = "Renew the request for " + name; $("#pkg-btn").textContent = "Renew the request";
      $("#lede").innerHTML = "The fields as the record has them; put right what the checks marked, confirm the four lines, and the pool writes a new request — the old one stays on the record. " + (q.checks ? q.checks.filter(function (c) { return !c.ok; }).map(function (c) { return '<span class="pill warn">' + esc(c.item) + '</span> ' + esc(c.note); }).join(" · ") : "");
      // The project as its home; the version and the source as the record names them (a GitHub project too: otherwise the form would take the latest tag, and the staged build would be of another version).
      $("#pkg-url").value = p.project || p.url || "";
      $("#pkg-name").value = name; $("#pkg-desc").value = p.description || ""; $("#pkg-license").value = p.license || "";
      var arches = q.arches && q.arches.length ? q.arches : (p.arches || []);
      $("#pkg-x86").checked = arches.indexOf("x86_64") >= 0; $("#pkg-arm").checked = arches.indexOf("aarch64") >= 0;
      var known = q.version && q.version !== "unknown";
      $("#pkg-version").value = known ? q.version : "";
      $("#pkg-source").value = known && p.source && p.source !== p.project ? p.source : "";
      if ($("#pkg-version").value || $("#pkg-source").value || (p.project && !/github\.com/.test(p.project))) document.querySelector(".form-more").open = true;
    }).catch(function () {});
  }
  whoami(function (me) {
    if (!me) return;
    $("#gate").hidden = true; $("#ask").hidden = false;
    if (RENEW) prefill(RENEW);
    var u = $("#pkg-url"); if (u && u.focus) u.focus();
  });
  $("#pkg-form").onsubmit = function () {
    var arches = []; if ($("#pkg-x86").checked) arches.push("x86_64"); if ($("#pkg-arm").checked) arches.push("aarch64");
    var checklist = {}; $("#pkg-checklist").querySelectorAll("input[data-check]").forEach(function (i) { checklist[i.getAttribute("data-check")] = i.checked; });
    var body = { url: $("#pkg-url").value.trim(), description: $("#pkg-desc").value.trim(), license: $("#pkg-license").value.trim(), arches: arches, checklist: checklist };
    if ($("#pkg-name").value.trim()) body.name = $("#pkg-name").value.trim();
    if ($("#pkg-source").value.trim()) body.source = $("#pkg-source").value.trim();
    if ($("#pkg-version").value.trim()) body.version = $("#pkg-version").value.trim();
    $("#pkg-btn").disabled = true; $("#pkg-state").textContent = "Checking the pool, the project and the source…"; $("#done").hidden = true;
    api("POST", "/api/v1/factory/packages", body).then(function (d) {
      $("#pkg-btn").disabled = false;
      if (d.error) { $("#pkg-state").textContent = d.error; return; }
      $("#pkg-state").textContent = "";
      var det = {}; try { det = JSON.parse(d.package.detected || "{}"); } catch (e) {}
      $("#done").hidden = false;
      $("#done").innerHTML = '<b>' + esc(d.package.name) + ' ' + esc(d.package.release || "") + '</b> is on the record: <a href="' + esc(d.request.record) + '">request #' + d.request.id + '</a>' + (d.request.signature ? ' (<a href="' + esc(d.request.signature) + '">signature</a>)' : '') + (det.build_system ? ' · ' + esc(det.build_system) : '') +
        (d.skipped && d.skipped.length ? '<br><span class="dim">' + esc(d.skipped.map(function (s) { return s.arch + " skipped: " + s.source + " ships " + s.version; }).join(" · ")) + '</span>' : '') +
        (d.build && d.build.tasks && d.build.tasks.length ? '<br>' + taskPill("queued") + ' build ' + d.build.tasks.map(function (t) { return '<a href="/build/' + t + '">#' + t + '</a>'; }).join(", ") + ' for ' + esc((d.build.arches || []).join(", ")) + (d.build.queue ? ' — ' + esc(Object.keys(d.build.queue).map(function (a) { return a + ": " + d.build.queue[a].position + " of " + d.build.queue[a].total + " in the shared queue"; }).join(" · ")) : '') + '. The best idle shared worker takes it, a worker of yours at once; your page follows it.' : d.build && d.build.error ? '<br>' + pillHtml("warn", "not queued") + ' ' + esc(d.build.error) : '') +
        '<div class="cta-row" style="margin-top:12px"><a class="btn" href="' + (ME && ME.login ? '/user/' + encodeURIComponent(ME.login) : '/factory#gate') + '">Your page →</a></div>';
      $("#pkg-form").reset();
    }).catch(function (e) { $("#pkg-btn").disabled = false; $("#pkg-state").textContent = "failed: " + e; });
    return false;
  };
`;

export function requestHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "Request a package · omarchy-pool",
    description: "Ask the Omarchy Pool for a package: the project's URL, a name, a description, the licence — checked, written once to the record, signed.",
    active: "factory",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What /request is made of: the sign-in gate, the form with its optional
 * fields, the licence list and the checklist, and what follows a submit.
 * Every act is the same POST to /factory/packages, sent as the form would
 * send it — whole, short of a field, short of a confirmation — so the
 * handler is proved to check what the form asks; the renew mode sends the
 * fixture's package request again as its owner.
 */
export const REQUEST_COMPONENTS = (F: Fixture): Component[] => {
  // The four confirmations as the template's boxes name them (data-check), not the server's CHECKLIST: a fifth
  // sentence added on one side alone makes the request answer 400 here.
  const confirmed = { official: true, license: true, unshipped: true, evidence: true };
  // bob's request, as the form sends it: a project that is not on GitHub (the tests run without the network),
  // so the release is named by hand — the "Not on GitHub?" fields.
  const theirs = {
    url: "https://theirs.example", name: "theirs", source: "https://theirs.example/theirs-1.0.tar.gz", version: "1.0",
    description: "Theirs, the package the form asks for in the tests", license: "MIT", arches: [F.arch], checklist: confirmed,
  };
  // alice's request, renewed from the record: the story's fields, sent back.
  const renewal = {
    url: "https://mine.example", name: F.factoryPkg, source: "https://mine.example/mine-1.0.tar.gz", version: "1.0",
    description: "Mine, a small tool for the tests", license: "MIT", arches: [F.arch], checklist: confirmed,
  };
  return [
    {
      id: "request.hero",
      page: "/request",
      anchor: ['<p class="eyebrow" id="eyebrow">Package request</p>', '<h1 id="h1">Ask for a package, on the record</h1>', '<p class="lede" id="lede">', 'href="/docs/governance">What happens after →</a>'],
      visible: EVERYONE,
    },
    {
      id: "request.signin-gate",
      page: "/request",
      anchor: ['<div id="gate" class="gate">', '<div class="lock">GitHub sign-in</div>', "Who is asking", 'href="/auth/github?next=/request"', "Sign in with GitHub"],
      script: ['"/auth/me"', "whoami(function (me)", "if (!me) return;", '$("#gate").hidden = true; $("#ask").hidden = false;'],
      reads: [
        // Signed out, the button starts the sign-in (the redirect to GitHub, `next=/request` kept for the callback); signed in, the gate hides and the form shows.
        { path: "/auth/github?next=/request", status: 302, json: false },
        { path: "/auth/me", status: 401 },
        { path: "/auth/me", as: "contributor", fields: ["login", "role"] },
        { path: "/auth/me", as: "owner", fields: ["login", "role"] },
        { path: "/auth/me", as: "maintainer", fields: ["login", "role"] },
      ],
      visible: ["anonymous"],
    },
    {
      id: "request.form",
      page: "/request",
      anchor: ['<section id="ask" hidden>', '<form id="pkg-form" class="form" onsubmit="return false">', 'id="pkg-url"', 'id="pkg-name"', 'pattern="[a-z0-9@._+-]+"', 'id="pkg-desc"', 'minlength="8" maxlength="120"', 'id="pkg-license"', 'id="pkg-x86" checked', 'id="pkg-arm" checked'],
      script: ['api("POST", "/api/v1/factory/packages", body)', '$("#pkg-form").onsubmit', 'arches.push("x86_64")', 'arches.push("aarch64")', "checklist: checklist", 'if ($("#pkg-name").value.trim()) body.name'],
      // Anyone signed in asks; the name is then the asker's: the same request by anyone else is refused.
      acts: [{ method: "POST", path: "/api/v1/factory/packages", body: theirs, expect: { anonymous: 401, contributor: 201, owner: 409, maintainer: 409 } }],
      visible: SIGNED_IN,
    },
    {
      id: "request.form-more",
      page: "/request",
      anchor: ['<details class="form-more"><summary>Not on GitHub? The release itself</summary>', 'id="pkg-source"', 'id="pkg-version"'],
      script: ['body.source = $("#pkg-source").value.trim()', 'body.version = $("#pkg-version").value.trim()', 'document.querySelector(".form-more").open = true'],
      // A project that is not on GitHub has no tag to read: without these two fields the request is refused before anything is written.
      acts: [
        {
          method: "POST",
          path: "/api/v1/factory/packages",
          body: { url: "https://elsewhere.example", name: "elsewhere", description: "Elsewhere, a release the form must be told about", license: "MIT", arches: [F.arch], checklist: confirmed },
          expect: { anonymous: 401, contributor: 400, owner: 400, maintainer: 400 },
        },
      ],
      visible: SIGNED_IN,
    },
    {
      id: "request.licence-datalist",
      page: "/request",
      anchor: ['list="spdx"', '<datalist id="spdx">', "<option>MIT</option>", "<option>GPL-3.0-or-later</option>", "<option>custom:proprietary</option>"],
      visible: SIGNED_IN,
    },
    {
      id: "request.checklist",
      page: "/request",
      anchor: ['<div class="checklist" id="pkg-checklist">', 'data-check="official"', 'data-check="license"', 'data-check="unshipped"', 'data-check="evidence"'],
      script: ['querySelectorAll("input[data-check]")', 'checklist[i.getAttribute("data-check")] = i.checked'],
      // One box left unticked and the request is refused, whoever asks, before the name or the project is looked at.
      acts: [{ method: "POST", path: "/api/v1/factory/packages", body: { ...theirs, checklist: { ...confirmed, evidence: false } }, expect: { anonymous: 401, contributor: 400, owner: 400, maintainer: 400 } }],
      visible: SIGNED_IN,
    },
    {
      id: "request.submit-state",
      page: "/request",
      anchor: ['<button type="submit" id="pkg-btn">Request</button>', '<p class="sub" id="pkg-state"></p>'],
      script: ['$("#pkg-btn").disabled = true', '"Checking the pool, the project and the source…"', '$("#pkg-state").textContent = d.error', '"failed: " + e'],
      visible: SIGNED_IN,
    },
    {
      id: "request.done",
      page: "/request",
      anchor: ['<div id="done" class="done" hidden></div>'],
      script: [
        '$("#done").innerHTML', "esc(d.package.name)", "esc(d.request.record)", "d.request.signature", "det.build_system", "d.skipped", "d.build.tasks", 'taskPill("queued")',
        '\'<a href="/build/\' + t + \'">#\' + t + \'</a>\'', 'd.build.queue[a].position + " of " + d.build.queue[a].total', "d.build.error",
        "'/user/' + encodeURIComponent(ME.login)", "Your page →", '$("#pkg-form").reset()',
      ],
      visible: SIGNED_IN,
    },
    {
      id: "request.workspace-link",
      page: "/request",
      anchor: ["Requested before?", 'href="/factory#gate">Your workspace</a>'],
      visible: SIGNED_IN,
    },
    {
      id: "request.renew-mode",
      page: `/request?renew=${F.factoryPkg}`,
      anchor: ['id="eyebrow"', 'id="h1"', 'id="lede"', 'id="pkg-btn"'],
      script: [
        'new URLSearchParams(location.search).get("renew")', "if (RENEW) prefill(RENEW)", '"/api/v1/factory/packages/" + encodeURIComponent(name) + "/story?t=" + Date.now()', "if (!st || !st.package) return;",
        '"Renew the request for " + name', "q.checks.filter(function (c) { return !c.ok; })", "esc(c.item)", "esc(c.note)", "p.project || p.url", "p.description", "p.license",
        "q.arches && q.arches.length ? q.arches : (p.arches || [])", 'q.version && q.version !== "unknown"', "p.source && p.source !== p.project",
      ],
      reads: [
        {
          path: `/api/v1/factory/packages/${F.factoryPkg}/story?t=0`,
          fields: ["package", "package.project", "package.url", "package.description", "package.license", "package.source", "package.arches", "request", "request.checks", "request.checks.0.ok", "request.checks.0.item", "request.checks.0.note", "request.arches", "request.version"],
        },
      ],
      // The record is public and the form asks nothing about ownership: the server refuses the name to anyone but alice. Her own renewal is
      // refused while the approval stands (the package is in the pool) and taken once an act before this one withdrew it — the last act
      // here, as it cancels the queued builds of the name and queues its own.
      acts: [{ method: "POST", path: "/api/v1/factory/packages", body: renewal, expect: { anonymous: 401, contributor: 409, maintainer: 409, owner: [200, 409] } }],
      visible: SIGNED_IN,
    },
  ];
};
