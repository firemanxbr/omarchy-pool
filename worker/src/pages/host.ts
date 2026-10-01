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
 *
 * Anyone sees the name, the owner, the status, the architectures and the
 * release; the capacity, the hostname and the host key's fingerprint are its
 * owner's and the maintainers' (GET /api/v1/hosts/:id says which). A static
 * shell, the same for every id; the script reads the host from the address.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { HOST_REPORT_FRESH_MIN } from "../hosts";

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
  @media (max-width: 520px) { .hp-kv { grid-template-columns: 1fr; gap: 2px 0; } .hp-kv dd { margin-bottom: 8px; } }
`;

const BODY = String.raw`
  <div class="hp">
    <section class="hp-head" aria-labelledby="hp-name">
      <p class="op-eyebrow">Host</p>
      <div class="hp-title"><h1 class="op-hero" id="hp-name"><span class="skl"></span></h1><span id="hp-status"></span></div>
      <p class="hp-id" id="hp-id"></p>
      <p class="hp-lede" id="hp-lede"></p>
    </section>

    <div class="op-stats" id="hp-stats"></div>

    <section class="op-card" id="hp-facts" aria-labelledby="hp-facts-h">
      <div class="op-card-h"><b id="hp-facts-h">What it runs</b><small>as its agent last reported it — the units are the pool's own count</small></div>
      <dl class="hp-kv" id="hp-kv"></dl>
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
  function stat(k, n, s) { return '<div class="op-stat"><span class="k">' + esc(k) + '</span><span class="n">' + n + '</span><span class="s">' + (s || "") + '</span></div>'; }
  function kv(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>'; }
  function when(iso) { return iso ? '<span title="' + esc(iso) + '">' + esc(ago(iso)) + '</span>' : '<span class="muted">—</span>'; }
  function load() {
    api("GET", BASE).then(function (d) {
      if (d.__status === 404) { $("#hp-name").textContent = ID; $("#hp-lede").textContent = "no such host: it was never enrolled"; endSkeleton(); return; }
      draw(d.host, d.leases || [], d.pool || {});
      setTimeout(function () { if (!document.hidden) load(); }, 30000);
    }).catch(function (e) { noAnswer("host", e, "#hp-lede"); });
  }
  function draw(h, leases, pool) {
    document.title = h.name + " · Host · omarchy-pool";
    $("#hp-name").textContent = h.name;
    var p = PILL[h.status] || ["na", h.status];
    $("#hp-status").innerHTML = '<span class="op-pill ' + p[0] + '">' + esc(p[1]) + '</span>';
    $("#hp-id").textContent = h.id + (h.worker ? " · registration " + h.worker : "");
    $("#hp-lede").innerHTML = "A maintainer host of " + personLink(h.owner) + (h.where ? ", " + esc(h.where) : "") + " — " + esc((h.arches || []).join(", ") || "no lane reported") + ". " + (h.status === "pending-owner" ? 'It waits for its owner to compare its fingerprint and press Confirm, on <a href="/user/' + encodeURIComponent(h.owner) + '#hosts">their page</a>; nothing claims before that.' : h.alive ? "Its agent reports." : '<span class="muted">Its agent has not reported in the last ' + esc(String(FRESH_MIN)) + ' minutes.</span>');
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
        kv("Status", esc(p[1]) + (h.confirmed_at ? " since " + when(h.confirmed_at) : " — enrolled " + when(h.enrolled_at))),
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
    $("#hp-lease-rows").innerHTML = leases.map(function (t) { return '<tr><td><a href="/build/' + esc(t.id) + '">#' + esc(t.id) + '</a></td><td>' + esc(t.kind || "build") + '</td><td>' + esc(t.name) + '</td><td>' + esc(t.arch) + '</td><td>' + when(t.started_at) + '</td></tr>'; }).join("") || '<tr><td colspan="5" class="muted">no lease — nothing runs on it now</td></tr>';
    endSkeleton();
  }
  whoami(function () { load(); });
`;

export function hostHtml(id: string, poolUrl: string, version: RunningVersion): string {
  return page({
    path: `/hosts/${id}`,
    title: "Host · omarchy-pool",
    description: "One maintainer host of the pool: its status, its capacity and units, its lanes and isolation level, the release it applied and its leases.",
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
    id: "host.leases",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-leases"', 'id="hp-lease-rows"', 'href="/docs/worker-host#maintainer-hosts"'],
    script: ['$("#hp-lease-rows")', "no lease — nothing runs on it now", 'href="/build/'],
    visible: EVERYONE,
  },
];
