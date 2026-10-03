/**
 * A maintainer host's page, /hosts/:id (#321, design v2 §18.1) — the minimal
 * one P1 needs; the full page, with the leases' Stop buttons, the "needs a
 * person" box and the host's controls, is P2's (#324).
 *
 * - The head: its name, its status (waiting for its owner's Confirm, active,
 *   suspended) and whose it is.
 * - The numbers: CPUs and memory, the units the pool counts from them, free
 *   disk on the work root and the engine's data root, and the agent slots —
 *   as its agent last reported them; its lanes (native, emulated); its
 *   isolation level; the release it applied against the pool's, and the last
 *   round's outcome.
 * - Its leases: what its registration holds now.
 * - Stop it (#322): Suspend, Resume and Retire, each greyed with the door's
 *   own reason (GET /api/v1/hosts/:id answers `can`), and the way to its
 *   registration's page, where Drain and Resume are.
 * - Its host orders (#344, design v2 §17.1): Reconcile now (a round now, its
 *   owner or any maintainer) and the last orders with their agent's answers.
 * - Its legacy set (#344, design v2 §21.1 step 6): the compose project its
 *   install recorded beside the bundle, its state and directory as its agent
 *   reports them, and Retire legacy set — its owner's, with a passkey: the
 *   agent stops and removes that project and leaves the .omarchy-agent
 *   marker in its directory.
 *
 * Anyone sees the name, the owner, the status, the architectures and the
 * release; the capacity, the hostname and the host key's fingerprint are its
 * owner's and the maintainers' (GET /api/v1/hosts/:id says which). A static
 * shell, the same for every id; the script reads the host from the address.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { HOST_ORDER_TTL_MIN, HOST_REPORT_FRESH_MIN, OWNER_NOT_MAINTAINER } from "../hosts";
import { lucide } from "./kit";

const CSS = String.raw`
  .hp { max-width: 1056px; margin: 0 auto; padding-top: 12px; display: grid; gap: 24px; }
  .hp a { text-decoration: none; } .hp a:hover { color: var(--green); }
  .hp a:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  .hp-head { display: grid; gap: 10px; }
  .hp-title { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
  .hp-title .op-hero { overflow-wrap: anywhere; }
  .hp-id { font: 12.5px var(--font-mono); color: var(--dim); overflow-wrap: anywhere; }
  .hp-lede { margin: 0; color: var(--muted); max-width: 760px; }
  #hp-stats { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  #hp-stats:empty { display: none; }
  @media (max-width: 899px) { #hp-stats { grid-template-columns: 1fr 1fr; } #hp-stats > .op-stat:last-child:nth-child(odd) { grid-column: 1 / -1; } }
  #hp-stats .op-stat .n { white-space: normal; overflow-wrap: anywhere; }
  .hp-kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; padding: 14px 16px; font-size: 13px; }
  .hp-kv dt { color: var(--dim); } .hp-kv dd { margin: 0; overflow-wrap: anywhere; }
  .hp-kv .mono { font-family: var(--font-mono); font-size: 12px; }
  .hp-table { overflow-x: auto; }
  .hp-empty { margin: 0; padding: 14px 16px; color: var(--dim); font-size: 13px; }
  .hp-ops { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .hp-note { margin: 12px 0 0; font-size: 12.5px; color: var(--dim); max-width: 760px; }
  .hp-stopped { margin: 0; padding: 10px 12px; border: 1px solid var(--red); font-size: 13px; max-width: 760px; overflow-wrap: anywhere; }
  .hp-stopped:empty { display: none; }
  .hp-blocked { color: var(--red); }
  .hp .mono { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
  @media (max-width: 520px) { .hp-ops .op-btn { flex: 1 1 100%; justify-content: center; } }
  @media (max-width: 520px) { .hp-kv { grid-template-columns: 1fr; gap: 2px 0; } .hp-kv dd { margin-bottom: 8px; } }
`;

const BODY = String.raw`
  <div class="hp">
    <section class="hp-head" aria-labelledby="hp-name">
      <p class="op-eyebrow">Host</p>
      <div class="hp-title"><h1 class="op-hero" id="hp-name"><span class="skl"></span></h1><span id="hp-status"></span></div>
      <p class="hp-id" id="hp-id"></p>
      <p class="hp-lede" id="hp-lede"></p>
      <p class="hp-stopped" id="hp-stopped" role="status"></p>
    </section>

    <div class="op-stats" id="hp-stats"></div>

    <section class="op-card" id="hp-facts" aria-labelledby="hp-facts-h">
      <div class="op-card-h"><b id="hp-facts-h">What it runs</b><small>as its agent last reported it — the units are the pool's own count</small></div>
      <dl class="hp-kv" id="hp-kv"></dl>
    </section>

    <section class="op-card" id="hp-operate" aria-labelledby="hp-operate-h">
      <div class="op-card-h"><b id="hp-operate-h">Stop it</b><small>each on the journal with who and why</small></div>
      <div class="op-card-b">
        <div class="hp-ops" id="hp-ops">
          <button type="button" class="op-btn" data-host-act="suspend" disabled>${lucide("ban", 14)}Suspend</button>
          <button type="button" class="op-btn" data-host-act="resume" disabled>${lucide("circle-check", 14)}Resume</button>
          <button type="button" class="op-btn danger" data-host-act="retire" disabled>${lucide("octagon-x", 14)}Retire</button>
        </div>
        <p class="hp-note">Suspend stops its claims and fences its running tasks; only its owner resumes it, with a passkey. Retire burns its key and its worker token: a new install enrolls a new host. To stop its claims and let its tasks finish, drain its registration.</p>
      </div>
      <div class="op-card-f"><a href="/docs/security-model#stopping-a-host">Suspend, retire, drain →</a></div>
    </section>

    <section class="op-card" id="hp-orders" aria-labelledby="hp-orders-h">
      <div class="op-card-h"><b id="hp-orders-h">Host orders</b><small>what only its agent can do, each with its answer</small></div>
      <div class="op-card-b">
        <div class="hp-ops" id="hp-order-ops">
          <button type="button" class="op-btn" data-host-act="reconcile" disabled>${lucide("refresh-cw", 14)}Reconcile now</button>
        </div>
        <p class="hp-note">Reconcile now: its agent runs a round at its next poll — the release the pool names, checked and rolled out as any round — and answers. An order its agent has not taken within ${HOST_ORDER_TTL_MIN} minutes expires.</p>
      </div>
      <div class="hp-table"><table class="op-table"><thead><tr><th>Order</th><th>By</th><th>Given</th><th>State</th><th>Its agent's answer</th></tr></thead><tbody id="hp-order-rows"></tbody></table></div>
    </section>

    <section class="op-card" id="hp-legacy" aria-labelledby="hp-legacy-h" hidden>
      <div class="op-card-h"><b id="hp-legacy-h">Legacy set</b><small>the compose project its install recorded beside the bundle</small></div>
      <dl class="hp-kv" id="hp-legacy-kv"></dl>
      <div class="op-card-b">
        <div class="hp-ops" id="hp-legacy-ops">
          <button type="button" class="op-btn danger" data-host-act="retire-legacy" disabled>${lucide("file-archive", 14)}Retire legacy set</button>
        </div>
        <p class="hp-note">Retire legacy set: its agent writes the <code>.omarchy-agent</code> marker into the legacy set's directory, then stops and removes that compose project — its containers and networks, nothing else — so <code>rollout.sh</code>, <code>setup.sh</code>, <code>omarchy-worker</code> and the updater refuse there from then on. Its owner's, with a passkey, once the set has been drained as the way back for 14 days.</p>
      </div>
      <div class="op-card-f"><a href="/docs/runbook#the-studio-host">The legacy set and its marker →</a></div>
    </section>

    <section class="op-card" id="hp-leases" aria-labelledby="hp-leases-h">
      <div class="op-card-h"><b id="hp-leases-h">Leases</b><small>the tasks its registration holds now</small></div>
      <div class="hp-table"><table class="op-table"><thead><tr><th>Task</th><th>Kind</th><th>Package</th><th>Arch</th><th>Since</th></tr></thead><tbody id="hp-lease-rows"></tbody></table></div>
      <div class="op-card-f"><a href="/docs/worker-host#maintainer-hosts">How a host joins →</a></div>
    </section>
  </div>
`;

const SCRIPT = String.raw`
  // The host this page is about: the address's last segment (the router serves the same shell for every id).
  var ID = decodeURIComponent(location.pathname.replace(/^\/hosts\//, ""));
  var BASE = "/api/v1/hosts/" + encodeURIComponent(ID);
  var FRESH_MIN = ${HOST_REPORT_FRESH_MIN};
  var PILL = { active: ["ok", "active"], "pending-owner": ["warn", "waits for its owner's Confirm"], suspended: ["fail", "suspended"], retired: ["na", "retired"] };
  var ICON = ${JSON.stringify({ suspend: lucide("ban", 14), resume: lucide("circle-check", 14), retire: lucide("octagon-x", 14), drain: lucide("circle-slash", 14), reconcile: lucide("refresh-cw", 14), legacy: lucide("file-archive", 14) })};
  var ORDER_PILL = { open: ["warn", "waits for its agent"], done: ["ok", "done"], refused: ["fail", "refused"], failed: ["fail", "failed"], expired: ["na", "expired"], cancelled: ["na", "cancelled"] };
  var LEGACY_PILL = { running: ["warn", "running"], stopped: ["na", "stopped"], gone: ["na", "no container left"], retiring: ["warn", "being retired"], retired: ["ok", "retired"], unknown: ["na", "not seen"] };
  var NOT_LISTED = ${JSON.stringify(OWNER_NOT_MAINTAINER)};
  var H = null, PK = {}, TIMER = 0;
  function stat(k, n, s) { return '<div class="op-stat"><span class="k">' + esc(k) + '</span><span class="n">' + n + '</span><span class="s">' + (s || "") + '</span></div>'; }
  function kv(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>'; }
  function when(iso) { return iso ? '<span title="' + esc(iso) + '">' + esc(ago(iso)) + '</span>' : '<span class="muted">—</span>'; }
  function load() {
    clearTimeout(TIMER);
    api("GET", BASE).then(function (d) {
      if (d.__status === 404) { $("#hp-name").textContent = ID; $("#hp-lede").textContent = "no such host: it was never enrolled"; endSkeleton(); return; }
      H = d.host; PK = d.passkey || {};
      draw(d.host, d.leases || [], d.pool || {});
      drawOps(d.host, d.can || { why: {} });
      drawOrders(d.host, d.orders, d.can || { why: {} });
      drawLegacy(d.host, d.can || { why: {} });
      TIMER = setTimeout(function () { if (!document.hidden) load(); }, 30000);
    }).catch(function (e) { noAnswer("host", e, "#hp-lede"); });
  }
  function draw(h, leases, pool) {
    document.title = h.name + " · Host · omarchy-pool";
    $("#hp-name").textContent = h.name;
    var p = PILL[h.status] || ["na", h.status];
    $("#hp-status").innerHTML = '<span class="op-pill ' + p[0] + '">' + esc(p[1]) + '</span>';
    $("#hp-id").textContent = h.id + (h.worker ? " · registration " + h.worker : "");
    $("#hp-lede").innerHTML = "A maintainer host of " + personLink(h.owner) + (h.where ? ", " + esc(h.where) : "") + " — " + esc((h.arches || []).join(", ") || "no lane reported") + ". " + (h.status === "pending-owner" ? 'It waits for its owner to compare its fingerprint and press Confirm, on <a href="/user/' + encodeURIComponent(h.owner) + '#hosts">their page</a>; nothing claims before that.' : h.alive ? "Its agent reports." : '<span class="muted">Its agent has not reported in the last ' + esc(String(FRESH_MIN)) + ' minutes.</span>');
    // Who stopped it and why, for anyone (the journal's words): a suspension or a retirement, and the maintainer list's stop.
    var stopped = [];
    if ((h.status === "suspended" || h.status === "retired") && h.status_by) stopped.push(esc(h.status === "suspended" ? "Suspended" : "Retired") + " by " + personLink(h.status_by) + (h.status_at ? " " + when(h.status_at) : "") + (h.status_reason ? ": " + esc(h.status_reason) : "") + (h.status === "suspended" ? ". It claims nothing until " + personLink(h.owner) + " resumes it." : ". A new install enrolls a new host."));
    if (h.claims_stopped_at && h.status !== "retired") stopped.push("Its claims stopped " + when(h.claims_stopped_at) + ": " + esc(NOT_LISTED) + ' (<a href="/docs/governance">factory/MAINTAINERS.toml</a>). Its running tasks finish; listed again, ' + personLink(h.owner) + ' resumes their hosts on <a href="/user/' + encodeURIComponent(h.owner) + '#hosts">their page</a>.');
    $("#hp-stopped").innerHTML = stopped.join("<br>");
    var c = h.capacity;
    $("#hp-stats").innerHTML = c ? [
      stat("CPUs", num(c.cpus), "memory " + num(c.mem_gb) + " GB"),
      stat("Units", h.units === null || h.units === undefined ? "—" : num(h.units), "1 CPU and 2 GB each, one kept for pool jobs"),
      stat("Disk free", num(c.disk_free_gb.work) + " GB", "work root · engine " + num(c.disk_free_gb.engine) + " GB"),
      stat("Agent slots", c.agent_slots === null || c.agent_slots === undefined ? "—" : num(c.agent_slots), "model tasks at once"),
      stat("Release", esc(h.release_applied || "—"), pool.version ? "the pool runs " + esc(pool.version) : ""),
    ].join("") : "";
    var lanes = (h.lanes || []).map(function (l) { return esc(l.arch + " " + l.mode + (l.via ? " (" + l.via + (l.page16k ? ", 16K pages" : "") + ")" : "")); }).join(", ");
    var round = h.round ? esc(String(h.round.outcome || "?")) + (h.round.from ? " from " + esc(h.round.from) : "") + (h.round.step ? " at " + esc(h.round.step) : "") : "—";
    $("#hp-kv").innerHTML = h.fingerprint === undefined
      ? kv("Status", esc(p[1])) + kv("Release", esc(h.release_applied || "—")) + kv("Details", '<span class="muted">its owner\'s and the maintainers\'</span>')
      : [
        kv("Status", esc(p[1]) + (h.status_at && (h.status === "suspended" || h.status === "retired") ? " since " + when(h.status_at) : h.confirmed_at ? " since " + when(h.confirmed_at) : " — enrolled " + when(h.enrolled_at))),
        kv("Host key", '<span class="mono">' + esc(h.fingerprint) + '</span>'),
        kv("Machine", esc((h.hostname || "?") + " · " + (h.os || "?") + " " + (h.arch || "?") + (h.page_kb ? ", " + h.page_kb + "K pages" : ""))),
        kv("Isolation", esc(h.isolation || "?") + (h.dedicated ? " (dedicated)" : "")),
        kv("Lanes", lanes || "—"),
        kv("Capacity", h.below_minimum ? esc(h.below_minimum) : c ? "meets the minimum to join" : "—"),
        kv("Release", esc(h.release_applied || "—") + (h.release_target ? " → " + esc(h.release_target) : "") + (h.rolled_back_from ? " (rolled back from " + esc(h.rolled_back_from) + ")" : "")),
        kv("Last round", round),
        kv("Agent", esc(h.agent_version || "?") + (h.provider ? " · " + esc(h.provider) + (h.model ? " " + esc(h.model) : "") : "")),
        kv("Reported", when(h.reported_at)),
      ].join("");
    $("#hp-lease-rows").innerHTML = leases.map(function (t) { return '<tr><td><a href="/build/' + esc(t.id) + '">#' + esc(t.id) + '</a></td><td>' + esc(t.kind || "build") + '</td><td>' + esc(t.name) + (t.fenced ? ' ' + pillHtml("warn", "fenced", "stopped by the pool: back to the queue when its lease ends") : '') + '</td><td>' + esc(t.arch) + '</td><td>' + when(t.started_at) + '</td></tr>'; }).join("") || '<tr><td colspan="5" class="muted">no lease — nothing runs on it now</td></tr>';
    endSkeleton();
  }
  // Stop it (#322): the three buttons as the door answers them for this reader, greyed with its reason; Drain is its registration's page's.
  function drawOps(h, can) {
    var why = can.why || {};
    $("#hp-ops").innerHTML = [
      gate('<button type="button" class="op-btn" data-host-act="suspend">' + ICON.suspend + 'Suspend</button>', can.suspend === true, why.suspend || ""),
      gate('<button type="button" class="op-btn" data-host-act="resume">' + ICON.resume + 'Resume</button>', can.resume === true, why.resume || ""),
      gate('<button type="button" class="op-btn danger" data-host-act="retire">' + ICON.retire + 'Retire</button>', can.retire === true, why.retire || ""),
    ].join("") + (h.worker && h.status !== "retired" ? '<a class="op-btn" href="/worker/' + encodeURIComponent(h.worker) + '#wk-operate">' + ICON.drain + 'Drain or resume its claims</a>' : "");
  }
  // Host orders (#344): Reconcile now as the door answers it for this reader, and the last orders with their agent's answers.
  function drawOrders(h, orders, can) {
    var why = can.why || {};
    $("#hp-order-ops").innerHTML = gate('<button type="button" class="op-btn" data-host-act="reconcile">' + ICON.reconcile + 'Reconcile now</button>', can.reconcile === true, why.reconcile || "");
    if (orders === undefined) { $("#hp-order-rows").innerHTML = '<tr><td colspan="5" class="muted">its owner\'s and the maintainers\'</td></tr>'; return; }
    $("#hp-order-rows").innerHTML = orders.map(function (o) {
      var p = ORDER_PILL[o.state] || ["na", o.state];
      return '<tr><td><span class="mono">' + esc(o.kind) + '</span></td><td>' + personLink(o.issued_by) + '</td><td>' + when(o.issued_at) + '</td><td>' + pillHtml(p[0], p[1], o.state === "open" ? "until " + o.not_after : o.answered_at || "") + '</td><td>' + (o.detail ? esc(o.detail) : '<span class="muted">—</span>') + '</td></tr>';
    }).join("") || '<tr><td colspan="5" class="muted">no host order yet</td></tr>';
  }
  // The legacy set (#344): what its agent reports of it, and Retire legacy set — the owner's, with a passkey.
  function drawLegacy(h, can) {
    var why = can.why || {}, l = h.legacy;
    $("#hp-legacy").hidden = h.fingerprint === undefined || !l;
    if (!l) return;
    var p = LEGACY_PILL[l.state] || ["na", l.state];
    $("#hp-legacy-kv").innerHTML = [
      kv("Project", '<span class="mono">' + esc(l.project) + '</span> ' + pillHtml(p[0], p[1])),
      kv("Containers", l.containers === null || l.containers === undefined ? "—" : num(l.containers) + (l.running === null || l.running === undefined ? "" : ", " + num(l.running) + " running")),
      kv("Directory", l.dir ? '<span class="mono">' + esc(l.dir) + '</span>' : "—"),
      kv(l.state === "retired" ? "Retired" : "Recorded", when(l.since) + (l.order ? ' <span class="mono">' + esc(l.order) + '</span>' : "")),
    ].concat(l.blocked ? [kv("Retiring now", '<span class="hp-blocked">' + esc(l.blocked) + '</span>')] : []).join("");
    $("#hp-legacy-ops").innerHTML = gate('<button type="button" class="op-btn danger" data-host-act="retire-legacy">' + ICON.legacy + 'Retire legacy set</button>', can.retire_legacy === true, why.retire_legacy || "");
  }
  function done(d) {
    if (d.error) { toast(esc(d.error), "error"); return; }
    toast(esc(d.line || "done")); load();
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-host-act]") : null;
    if (!b || b.disabled || !H) return;
    var act = b.getAttribute("data-host-act");
    if (act === "suspend") {
      ask({ title: "Suspend " + H.name, text: "Its claims stop at once, its key is refused, its waiting orders are cancelled and its running tasks are fenced: they go back to the queue when their lease ends. Only " + esc(H.owner) + " resumes it, with a passkey.", input: "required", confirm: "Suspend", danger: true }).then(function (r) {
        if (r === null) return;
        api("POST", BASE + "/suspend", { reason: r }).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    } else if (act === "resume") {
      ask({ title: "Resume " + H.name, text: "It claims again from its next claim and its agent recovers at its next poll; nothing is done on the machine.", held: "Your passkey confirms it.", confirm: "Resume", first: "Register a passkey and resume", nothing: "Nothing was resumed." }).then(function (go) {
        if (go === null) return;
        passkeyed("host:resume:" + ID, function (a) { return api("POST", BASE + "/resume", { assertion: a }); }).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    } else if (act === "retire") {
      ask({ title: "Retire " + H.name, text: "Its key and its worker token are burnt for good; its running tasks end with their lease. A new install on the machine enrolls a new host.", held: PK.retire ? "Your passkey confirms it." : "", input: "required", confirm: "Retire", first: PK.retire ? "Register a passkey and retire" : "", nothing: "Nothing was retired.", danger: true }).then(function (r) {
        if (r === null) return;
        var post = function (a) { return api("POST", BASE + "/retire", a ? { reason: r, assertion: a } : { reason: r }); };
        (PK.retire ? passkeyed("host:retire:" + ID, post) : post(null)).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    } else if (act === "reconcile") {
      api("POST", BASE + "/orders", { kind: "reconcile-now" }).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    } else if (act === "retire-legacy") {
      var l = H.legacy || {};
      ask({ title: "Retire the legacy set of " + H.name, text: "Its agent writes the .omarchy-agent marker into " + esc(l.dir || "the legacy set's directory") + ", then stops and removes the compose project " + esc(l.project || "") + " — its containers and networks, nothing else. From then on rollout.sh, setup.sh, omarchy-worker and the updater refuse there: the way back through the legacy set is over.", held: "Your passkey confirms it.", confirm: "Retire legacy set", first: "Register a passkey and retire the legacy set", nothing: "Nothing was retired.", danger: true }).then(function (go) {
        if (go === null) return;
        passkeyed("host:retire-legacy:" + ID, function (a) { return api("POST", BASE + "/orders", { kind: "retire-legacy", assertion: a }); }).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    }
  });
  whoami(function () { load(); });
`;

export function hostHtml(id: string, poolUrl: string, version: RunningVersion): string {
  return page({
    path: `/hosts/${id}`,
    title: "Host · omarchy-pool",
    description: "One maintainer host of the pool: its status, its capacity and units, its lanes and isolation level, the release it applied, its host orders, its legacy set and its leases.",
    active: "factory",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
    kit: true,
    css: CSS,
  });
}

/** What /hosts/:id is made of (#321): one read, which answers the details to the owner and the maintainers only. */
export const HOST_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "host.head-facts",
    page: `/hosts/${F.host}`,
    anchor: ['<p class="op-eyebrow">Host</p>', 'id="hp-name"', 'id="hp-status"', 'id="hp-lede"', 'id="hp-stats"', 'id="hp-kv"'],
    script: ['var BASE = "/api/v1/hosts/" + encodeURIComponent(ID)', 'api("GET", BASE)', "h.fingerprint === undefined", '"Host key"', '"Isolation"', '"Lanes"', '"Last round"', "h.below_minimum", '"Units"', "personLink(h.owner)"],
    reads: [
      { path: `/api/v1/hosts/${F.host}`, fields: ["host.id", "host.name", "host.owner", "host.status", "host.arches", "host.release_applied", "host.alive", "leases", "pool.version"] },
      { path: `/api/v1/hosts/${F.host}`, as: "maintainer", fields: ["host.fingerprint", "host.capacity", "host.units", "host.lanes", "host.isolation", "host.dedicated", "host.hostname", "host.round", "host.below_minimum", "host.agent_version"] },
      { path: "/api/v1/hosts/h_nobody0000", status: 404 },
    ],
    visible: EVERYONE,
  },
  {
    // Stop it (#322): Suspend, Resume and Retire as GET /hosts/:id answers them for the reader — every role sees them, greyed with the door's
    // reason —; the doors refuse everyone else server-side, and a session's write without the page's own Origin for every role.
    id: "host.stop",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-operate"', 'id="hp-ops"', 'data-host-act="suspend"', 'data-host-act="resume"', 'data-host-act="retire"', 'id="hp-stopped"', 'href="/docs/security-model#stopping-a-host"'],
    script: ["function drawOps(h, can)", "can.suspend === true", "can.resume === true", "can.retire === true", 'BASE + "/suspend"', 'BASE + "/resume"', 'BASE + "/retire"', 'passkeyed("host:resume:" + ID', 'passkeyed("host:retire:" + ID', "PK.retire", "h.status_by", "h.status_reason", "h.claims_stopped_at", "NOT_LISTED"],
    reads: [{ path: `/api/v1/hosts/${F.host}`, fields: ["can.suspend", "can.resume", "can.retire", "can.why", "passkey.retire", "host.status_by", "host.status_at", "host.status_reason", "host.claims_stopped_at"] }],
    acts: [
      { method: "POST", path: `/api/v1/hosts/${F.host}/suspend`, body: { reason: "a reason enough" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/hosts/${F.host}/resume`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/hosts/${F.host}/retire`, body: { reason: "a reason enough" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
    ],
    visible: EVERYONE,
  },
  {
    // Host orders (#344): Reconcile now, greyed with the door's reason, and the last orders with their answers (its owner's and the
    // maintainers'). The door refuses everyone else server-side, and a session's write without the page's own Origin for every role.
    id: "host.orders",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-orders"', 'id="hp-order-ops"', 'data-host-act="reconcile"', 'id="hp-order-rows"'],
    script: ["function drawOrders(h, orders, can)", "can.reconcile === true", 'kind: "reconcile-now"', 'BASE + "/orders"', "ORDER_PILL", "o.detail", "no host order yet"],
    reads: [
      { path: `/api/v1/hosts/${F.host}`, fields: ["can.reconcile", "can.why"] },
      { path: `/api/v1/hosts/${F.host}`, as: "maintainer", fields: ["orders", "can.reconcile"] },
    ],
    acts: [
      { method: "POST", path: `/api/v1/hosts/${F.host}/orders`, body: { kind: "reconcile-now" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
    ],
    visible: EVERYONE,
  },
  {
    // The legacy set (#344): what the agent reports of it, and Retire legacy set — its owner's, with a passkey.
    id: "host.legacy",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-legacy"', 'id="hp-legacy-kv"', 'id="hp-legacy-ops"', 'data-host-act="retire-legacy"', 'href="/docs/runbook#the-studio-host"'],
    script: ["function drawLegacy(h, can)", "can.retire_legacy === true", 'kind: "retire-legacy"', 'passkeyed("host:retire-legacy:" + ID', "LEGACY_PILL", "l.blocked", "l.dir"],
    reads: [{ path: `/api/v1/hosts/${F.host}`, as: "maintainer", fields: ["host.legacy", "can.retire_legacy", "passkey.retire_legacy"] }],
    acts: [
      { method: "POST", path: `/api/v1/hosts/${F.host}/orders`, body: { kind: "retire-legacy" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
    ],
    visible: ["maintainer"],
  },
  {
    id: "host.leases",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-leases"', 'id="hp-lease-rows"', 'href="/docs/worker-host#maintainer-hosts"'],
    script: ['$("#hp-lease-rows")', "no lease — nothing runs on it now", 'href="/build/'],
    visible: EVERYONE,
  },
];
