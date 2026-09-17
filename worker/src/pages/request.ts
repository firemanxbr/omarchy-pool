/**
 * /request — the package request, on a page of its own: nothing to look at
 * but the four fields and the four confirmations. Linked from the Factory
 * page, never from the header or the footer; a contributor lands here to
 * ask for one thing. Signed in with GitHub (the session cookie); the
 * request goes to POST /api/v1/factory/packages and comes back with its
 * record, then the build is one press away.
 */
import { page, GITHUB_ICON } from "./layout";
import type { Component, Fixture } from "./components";
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
  var API = "/api/v1/factory";
  function call(method, path, body) {
    return busy(fetch(API + path, { method: method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).then(function (r) { return r.json().then(function (d) { d.__status = r.status; return d; }); });
  }
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
    call("POST", "/packages", body).then(function (d) {
      $("#pkg-btn").disabled = false;
      if (d.error) { $("#pkg-state").textContent = d.error; return; }
      $("#pkg-state").textContent = "";
      var det = {}; try { det = JSON.parse(d.package.detected || "{}"); } catch (e) {}
      $("#done").hidden = false;
      $("#done").innerHTML = '<b>' + esc(d.package.name) + ' ' + esc(d.package.release || "") + '</b> is on the record: <a href="' + esc(d.request.record) + '">request #' + d.request.id + '</a>' + (d.request.signature ? ' (<a href="' + esc(d.request.signature) + '">signature</a>)' : '') + (det.build_system ? ' · ' + esc(det.build_system) : '') +
        (d.skipped && d.skipped.length ? '<br><span class="dim">' + esc(d.skipped.map(function (s) { return s.arch + " skipped: " + s.source + " ships " + s.version; }).join(" · ")) + '</span>' : '') +
        (d.build && d.build.tasks && d.build.tasks.length ? '<br>' + pillHtml("blue", "queued") + ' build ' + d.build.tasks.map(function (t) { return '<a href="/build/' + t + '">#' + t + '</a>'; }).join(", ") + ' for ' + esc((d.build.arches || []).join(", ")) + (d.build.queue ? ' — ' + esc(Object.keys(d.build.queue).map(function (a) { return a + ": " + d.build.queue[a].position + " of " + d.build.queue[a].total + " in the shared queue"; }).join(" · ")) : '') + '. The best idle shared worker takes it, a worker of yours at once; your page follows it.' : d.build && d.build.error ? '<br>' + pillHtml("warn", "not queued") + ' ' + esc(d.build.error) : '') +
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

/** What /request is made of, for test/components.test.ts — see components.ts. */
export const REQUEST_COMPONENTS = (_F: Fixture): Component[] => [];
