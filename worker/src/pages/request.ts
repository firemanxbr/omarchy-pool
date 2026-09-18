/**
 * /request — the package request, on a page of its own: nothing to look at
 * but the four fields and the four confirmations. Linked from the footer
 * and from the Factory page's first way; a contributor lands here to ask
 * for one thing. The page is the same for whoever opens it: the form is
 * served for everyone, its fields grey with the sign-in as the reason
 * until whoami answers with a person, live then — signed in with GitHub
 * (the session cookie), the request goes to POST /api/v1/factory/packages
 * and comes back with its record, and the build is one press away. The
 * workspace line is /me: the reader's own page, or the sign-in that comes
 * back to it — one link for everyone.
 */
import { page, servedGrey, GITHUB_ICON } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";

/**
 * The form's fields are one template drawn twice: served grey for everyone
 * (servedGrey — what the shell's gate() writes, the sign-in as the reason
 * in every title) and drawn again through gate() once whoami answers, so a
 * session is what makes them live. The gate above the form is the same
 * shape the other way: served with the sign-in live, its button grey for a
 * person already in, whose login the banner then names. The reason is the
 * shell's word for nobody (orSignIn), the same on every grey control of
 * every page and in the server's 401.
 */
const ASK_WHY = "sign in with GitHub";
const SIGN_IN_BTN = `<a class="btn" id="gate-btn" href="/auth/github?next=/request">${GITHUB_ICON} Sign in with GitHub</a>`;
const FIELDS = String.raw`
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
`;

const BODY = String.raw`
  <div class="hero compact">
    <p class="eyebrow" id="eyebrow">Package request</p>
    <h1 id="h1">Ask for a package, on the record</h1>
    <p class="lede" id="lede">Four fields, four confirmations. The pool checks it, writes it once with its signature, and the build starts by itself — in the shared queue, the best idle worker first. <a href="/docs/governance">What happens after →</a></p>
  </div>

  <div id="gate" class="gate"><div><div class="lock">GitHub sign-in</div><h3 style="margin-top:6px">Who is asking</h3><p id="gate-who">A request carries your GitHub login — it is on the record, next to the package. Nothing else is asked, no permission is needed.</p></div><div class="cta" id="gate-cta">${SIGN_IN_BTN}</div></div>

  <section id="ask">
    <div class="panel request-panel">
      <form id="pkg-form" class="form" onsubmit="return false">${servedGrey(FIELDS, ASK_WHY)}</form>
      <p class="sub" id="pkg-state"></p>
      <div id="done" class="done" hidden></div>
    </div>
    <p class="sub" style="margin-top:14px">Requested before? <a id="ws" href="/me">Your workspace</a> has every package, its stage and its evidence.</p>
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
  // The same page for whoever is looking; what whoami's answer changes is the state, never what is there. The gate's sign-in is live for nobody — coming back to this address, a renewal's name included — and grey for a person in, whom the banner then names; the fields are served grey with the sign-in as the reason and drawn again live for a person.
  whoami(function (me) {
    $("#gate-cta").innerHTML = gate(${JSON.stringify(SIGN_IN_BTN)}, !me, "signed in as " + WHO.login);
    if (!me) $("#gate-btn").href = signInHref();
    if (me) $("#gate-who").innerHTML = "Asking as <b>" + esc(WHO.login) + "</b> — on the record, next to the package.";
    $("#pkg-form").innerHTML = gate(${JSON.stringify(FIELDS)}, !!me, ${JSON.stringify(ASK_WHY)});
    if (!me) return;
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
        '<div class="cta-row" style="margin-top:12px"><a class="btn" href="' + (WHO.login ? userHref(WHO.login) : '/me') + '">Your page →</a></div>';
      $("#pkg-form").reset();
    }).catch(function (e) { $("#pkg-btn").disabled = false; $("#pkg-state").textContent = "failed: " + e; });
    return false;
  };
`;

export function requestHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/request",
    title: "Request a package · omarchy-pool",
    description: "Ask the Omarchy Pool for a package: the project's URL, a name, a description, the licence — checked, written once to the record, signed.",
    active: "none",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What /request is made of: the gate, the form with its optional fields,
 * the licence list and the checklist, what follows a submit, the workspace
 * line. Every piece is served for everyone; who is looking changes only
 * its state — the fields grey with the sign-in as the reason for nobody,
 * the gate's button grey for a person in — so every component is
 * EVERYONE's, and the acts say who the server takes a request from.
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
  // What every grey field and the button carry until a person answers: the reason, as the shell writes it.
  const grey = `disabled aria-disabled="true" title="${ASK_WHY}"`;
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
      // The banner is there for everyone: the sign-in live for nobody, `next=/request` kept for the callback; grey for a person in, whom the banner names.
      anchor: ['<div id="gate" class="gate">', '<div class="lock">GitHub sign-in</div>', "Who is asking", '<p id="gate-who">', '<div class="cta" id="gate-cta">', 'id="gate-btn" href="/auth/github?next=/request"', "Sign in with GitHub"],
      script: ['"/auth/me"', "whoami(function (me)", '$("#gate-cta").innerHTML = gate(', 'if (!me) $("#gate-btn").href = signInHref();', '"signed in as " + WHO.login', '"Asking as <b>" + esc(WHO.login) + "</b>'],
      reads: [
        // Signed out, the button starts the sign-in (the redirect to GitHub, `next=/request` kept for the callback); signed in, /auth/me names who is asking.
        { path: "/auth/github?next=/request", status: 302, json: false },
        { path: "/auth/me", status: 401 },
        { path: "/auth/me", as: "contributor", fields: ["login", "role"] },
        { path: "/auth/me", as: "owner", fields: ["login", "role"] },
        { path: "/auth/me", as: "maintainer", fields: ["login", "role"] },
      ],
      visible: EVERYONE,
    },
    {
      id: "request.form",
      page: "/request",
      // Served grey for everyone — every field disabled with the sign-in as its reason — and drawn again live once a person answers.
      anchor: ['<section id="ask">', '<form id="pkg-form" class="form" onsubmit="return false">', `id="pkg-url" placeholder="https://github.com/owner/project — or …/archive/refs/tags/v1.2.3.tar.gz" required autofocus ${grey}>`, 'id="pkg-name"', 'pattern="[a-z0-9@._+-]+"', 'id="pkg-desc"', 'minlength="8" maxlength="120"', 'id="pkg-license"', 'id="pkg-x86" checked', 'id="pkg-arm" checked'],
      script: ['$("#pkg-form").innerHTML = gate(', `"${ASK_WHY}"`, 'api("POST", "/api/v1/factory/packages", body)', '$("#pkg-form").onsubmit', 'arches.push("x86_64")', 'arches.push("aarch64")', "checklist: checklist", 'if ($("#pkg-name").value.trim()) body.name'],
      // Anyone signed in asks; the name is then the asker's: the same request by anyone else is refused.
      acts: [{ method: "POST", path: "/api/v1/factory/packages", body: theirs, expect: { anonymous: 401, contributor: 201, owner: 409, maintainer: 409 } }],
      visible: EVERYONE,
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
      visible: EVERYONE,
    },
    {
      id: "request.licence-datalist",
      page: "/request",
      anchor: ['list="spdx"', '<datalist id="spdx">', "<option>MIT</option>", "<option>GPL-3.0-or-later</option>", "<option>custom:proprietary</option>"],
      visible: EVERYONE,
    },
    {
      id: "request.checklist",
      page: "/request",
      anchor: ['<div class="checklist" id="pkg-checklist">', `data-check="official" ${grey}>`, 'data-check="license"', 'data-check="unshipped"', 'data-check="evidence"'],
      script: ['querySelectorAll("input[data-check]")', 'checklist[i.getAttribute("data-check")] = i.checked'],
      // One box left unticked and the request is refused, whoever asks, before the name or the project is looked at.
      acts: [{ method: "POST", path: "/api/v1/factory/packages", body: { ...theirs, checklist: { ...confirmed, evidence: false } }, expect: { anonymous: 401, contributor: 400, owner: 400, maintainer: 400 } }],
      visible: EVERYONE,
    },
    {
      id: "request.submit-state",
      page: "/request",
      // The button is served grey with the sign-in as its reason; pressed, it is disabled again while the POST is in flight — state, both times.
      anchor: [`<button type="submit" id="pkg-btn" ${grey}>Request</button>`, '<p class="sub" id="pkg-state"></p>'],
      script: ['$("#pkg-btn").disabled = true', '"Checking the pool, the project and the source…"', '$("#pkg-state").textContent = d.error', '"failed: " + e'],
      visible: EVERYONE,
    },
    {
      id: "request.done",
      page: "/request",
      anchor: ['<div id="done" class="done" hidden></div>'],
      script: [
        '$("#done").innerHTML', "esc(d.package.name)", "esc(d.request.record)", "d.request.signature", "det.build_system", "d.skipped", "d.build.tasks", 'taskPill("queued")',
        '\'<a href="/build/\' + t + \'">#\' + t + \'</a>\'', 'd.build.queue[a].position + " of " + d.build.queue[a].total', "d.build.error",
        "userHref(WHO.login)", "Your page →", '$("#pkg-form").reset()',
      ],
      visible: EVERYONE,
    },
    {
      id: "request.workspace-link",
      page: "/request",
      // One href for everyone: /me is the person's own page with a session, the sign-in that comes back to it without one — no rewrite, nothing that depends on who is looking.
      anchor: ["Requested before?", 'id="ws" href="/me">Your workspace</a>'],
      reads: [{ path: "/me", status: 302, json: false }],
      visible: EVERYONE,
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
      visible: EVERYONE,
    },
  ];
};
