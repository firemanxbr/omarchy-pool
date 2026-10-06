/**
 * A maintainer host's page, /hosts/:id (#321, #324, design v2 §18.1).
 *
 * - The head: its name, its status (waiting for its owner's Confirm, active,
 *   suspended) and whose it is.
 * - What needs a person (#324): its owner's Confirm, a suspension, below the
 *   minimum, the disk under the floor, an emulated lane held for binfmt,
 *   limits its runtime does not enforce (cgroup delegation), the hosting
 *   requirement its isolation level does not meet, the engine refusing the
 *   agent's user (the docker group), and what its agent says of itself
 *   (linger, credentials within its user's reach: its report's needs_person,
 *   crates/omarchy-agent run/needs.rs) — fleet.ts needsPersonOf.
 * - The numbers: CPUs and memory, the units the pool counts from them — busy,
 *   free for a task, the one kept for pool jobs —, free disk on the work root
 *   and the engine's data root, and the agent slots, as its agent last
 *   reported them; its lanes (native, emulated with how and 16K pages, held
 *   with why); its isolation level and whether it is dedicated; its runtime
 *   (its driver: compose, or Quadlet, #330) and the agent's and compose's
 *   versions; its sandboxed runtime (#330, design v2 §10.4; D43: gVisor or
 *   Kata, as its dispatcher's claims say it applies it — what a contributor
 *   wrote runs in it on the native lane, and its emulated lanes take the
 *   project's own recipes only — or none, with why one its engine has is
 *   not used or why its claims hold); the limits its runtime enforces; its
 *   owner's caps; the release it applied against the pool's, its target and
 *   its floor, the rollout's state and the last round's outcome.
 * - Its leases: what its registration holds now, each with its kind,
 *   package, arch, lane, units and since when (#337), and a Stop that fences
 *   that task only (#334's per-lease stop-task, capped per login).
 * - The pool's cap on its units (#337, design v2 §7.2): its owner or any
 *   maintainer sets or lifts it, with a reason; and the large task it
 *   reserves for, when it does.
 * - Stop it (#322): Suspend, Resume and Retire, each greyed with the door's
 *   own reason (GET /api/v1/hosts/:id answers `can`), and its registration's
 *   Drain and Resume, with the owner rule — a drain by its owner is lifted by
 *   its owner only (#324: the worker orders' door, its verdicts in the read).
 * - Its host orders (#344, design v2 §17.1): Reconcile now (a round now, its
 *   owner or any maintainer; an Update of its registration while its agent
 *   takes no host order) and the last orders with their agent's answers.
 * - Whether it sleeps (#329, design v2 §19.2): a Mac's agent reports
 *   `asleep` before the Mac sleeps and after it woke; a sleeping host has
 *   zero free units — the pool hands it nothing until it wakes, and a task
 *   the sleep caught (the lid closed under it) goes back to the queue when
 *   its lease expires. Its head says so, for anyone.
 * - Its legacy set (#344, design v2 §21.1 step 6): the compose project its
 *   install recorded beside the bundle, its state and directory as its agent
 *   reports them, and Retire legacy set — its owner's, with a passkey: the
 *   agent stops and removes that project and leaves the .omarchy-agent
 *   marker in its directory.
 * - Its settings (#325, design v2 §12, §17.1, §18.1): the units it gives and
 *   its emulated lanes, narrowed from the site inside the envelope its owner
 *   wrote at the host — the envelope shown, every value above it greyed (the
 *   agent refuses one anyway, and the answer shows) —, whether the envelope
 *   allows diagnostics, and the brake's last hour; P4's orders beside
 *   Reconcile now — Retry release, Rotate token, Diagnostics — and each
 *   order's value and answer on the journal, a diagnostics order's lines
 *   read in place.
 * - Its soak and the gate (#326, design v2 D16, §5.5, §18.1): the soak its
 *   owner set and until when the release the pool names waits on it; where
 *   its registration stands at the pool's 426 gate and why — claiming through
 *   its soak, within the rollout's grace, or refused, with what ended the
 *   grace (the soak over, the two hours after the deploy, a quarantine) —;
 *   and, for anyone, a warning when its agent reports the pool behind GitHub
 *   (freeze detection): GitHub has shown a newer release for over a day.
 *
 * - Owner control (#328, design v2 §12, §14, D6 b): the passkey pinned at
 *   the host, its seal key with its fingerprint, the envelope's keys a
 *   widening may set and the names of its agent keys; Make a pin (pasted at
 *   the host once, `omarchy-agent envelope pin-passkey`), Confirm the seal key
 *   (compared with `omarchy-agent status`), Widen the envelope — the proposed
 *   values shown, then signed with the pinned passkey — and Set agent keys:
 *   each value sealed to the host's seal key in this browser
 *   (sealAgentKey, whose own source is inlined here), so the pool relays
 *   only ciphertext. Its owner's; the host checks every signature again.
 *
 * Anyone sees the name, the architectures, the release and whether its agent
 * reports (with whose it is and who stopped it, as the journal says); the
 * rest — the capacity, the leases, the box, the hostname and the host key's
 * fingerprint — is its owner's and the maintainers' (GET /api/v1/hosts/:id
 * says which; the Workers page's fleet row says the units and lanes to
 * anyone). A static shell, the same for every id; the script reads the host
 * from the address.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";
import { AGENT_KEY_NAMES, HOST_ORDER_TTL_MIN, HOST_OWNER_AGENT, HOST_REPORT_FRESH_MIN, HOST_SETTINGS_AGENT, OWNER_NOT_MAINTAINER, WIDENABLE } from "../hosts";
import { sealAgentKey } from "../seal";
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
  .hp-freeze { margin: 0; padding: 10px 12px; border: 1px solid var(--status-warn); font-size: 13px; max-width: 760px; overflow-wrap: anywhere; }
  .hp-freeze:empty { display: none; }
  .hp-blocked { color: var(--red); }
  .hp .mono { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
  .hp-cap { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
  .hp-cap:empty { display: none; }
  .hp-field { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  .hp-field select { padding: 5px 8px; border: 1px solid var(--line); border-radius: 0; background: var(--bg-deep); color: var(--text); font: 13px var(--font-mono); }
  .hp-lanes { display: inline-flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; }
  .hp-lanes label { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); }
  .hp-diag { margin: 0; padding: 12px 16px; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 11.5px/1.5 var(--font-mono); border-top: 1px solid var(--line); }
  .hp-diag:empty { display: none; }
  /* What needs a person (#324): the warning's edge, one line per thing, its word first. */
  .hp-needs { border-color: var(--status-warn); }
  .hp-needs-list { margin: 0; padding: 12px 16px 14px 34px; display: grid; gap: 6px; font-size: 13px; overflow-wrap: anywhere; }
  .hp-needs-list b { font: 12px var(--font-mono); color: var(--status-warn); margin-right: 6px; }
  /* A lease's Stop sits at the row's end, never wrapped; a package's name wraps rather than push it off at 1280. */
  #hp-lease-rows td:nth-child(3) { overflow-wrap: anywhere; }
  #hp-lease-rows td:last-child { white-space: nowrap; text-align: right; }
  .hp-held { color: var(--status-warn); }
  .hp-pin { margin: 12px 0 0; padding: 10px 12px; max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 11.5px/1.5 var(--font-mono); border: 1px solid var(--line); }
  .hp-form { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px 16px; margin: 12px 0 0; }
  .hp-form:empty { display: none; }
  .hp-form label { display: grid; gap: 4px; font-size: 12.5px; color: var(--muted); }
  .hp-form input, .hp-form select, .hp-form textarea { padding: 5px 8px; border: 1px solid var(--line); border-radius: 0; background: var(--bg-deep); color: var(--text); font: 13px var(--font-mono); }
  .hp-form .wide { grid-column: 1 / -1; }
  @media (max-width: 520px) { .hp-ops .op-btn { flex: 1 1 100%; justify-content: center; } .hp-field { flex: 1 1 100%; } }
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
      <p class="hp-freeze" id="hp-freeze" role="status"></p>
    </section>

    <section class="op-card hp-needs" id="hp-needs" aria-labelledby="hp-needs-h" hidden>
      <div class="op-card-h"><b id="hp-needs-h">Needs a person</b><small>what only someone at the machine, or its owner on the site, can fix</small></div>
      <ul class="hp-needs-list" id="hp-needs-list"></ul>
      <div class="op-card-f"><a href="/docs/runbook#a-new-maintainer-host">What each one asks →</a></div>
    </section>

    <div class="op-stats" id="hp-stats"></div>

    <section class="op-card" id="hp-facts" aria-labelledby="hp-facts-h">
      <div class="op-card-h"><b id="hp-facts-h">What it runs</b><small>as its agent last reported it — the units are the pool's own count</small></div>
      <dl class="hp-kv" id="hp-kv"></dl>
      <div class="op-card-f hp-cap" id="hp-cap"></div>
    </section>

    <section class="op-card" id="hp-operate" aria-labelledby="hp-operate-h">
      <div class="op-card-h"><b id="hp-operate-h">Stop it</b><small>each on the journal with who and why</small></div>
      <div class="op-card-b">
        <div class="hp-ops" id="hp-ops">
          <button type="button" class="op-btn" data-host-act="suspend" disabled>${lucide("ban", 14)}Suspend</button>
          <button type="button" class="op-btn" data-host-act="resume" disabled>${lucide("circle-check", 14)}Resume</button>
          <button type="button" class="op-btn danger" data-host-act="retire" disabled>${lucide("octagon-x", 14)}Retire</button>
          <button type="button" class="op-btn" data-host-act="drain" disabled>${lucide("circle-slash", 14)}Drain</button>
          <button type="button" class="op-btn" data-host-act="undrain" disabled>${lucide("circle-check", 14)}Resume claims</button>
        </div>
        <p class="hp-note">Suspend stops its claims and fences its running tasks; only its owner resumes it, with a passkey. Retire burns its key and its worker token: a new install enrolls a new host. Drain stops its claims and lets its tasks finish; a drain by its owner is lifted by its owner only, one by another maintainer by either of them.</p>
      </div>
      <div class="op-card-f"><a href="/docs/security-model#stopping-a-host">Suspend, retire, drain →</a></div>
    </section>

    <section class="op-card" id="hp-settings" aria-labelledby="hp-settings-h" hidden>
      <div class="op-card-h"><b id="hp-settings-h">Settings</b><small>narrowed from the site, inside the envelope its owner wrote at the host</small></div>
      <dl class="hp-kv" id="hp-settings-kv"></dl>
      <div class="op-card-b">
        <div class="hp-ops" id="hp-settings-ops"></div>
        <p class="hp-note">The pool only narrows: fewer units, an emulated lane off. Its agent takes the setting at its next poll and the dispatcher claims by it from its next claim; a task already running above it finishes. Anything above the envelope — greyed here — its agent refuses: only its owner widens the envelope, at the host. The host brakes how fast it changes: four narrowings, six dispatcher restarts and twenty orders an hour, one release change every ten minutes.</p>
      </div>
      <div class="op-card-f"><a href="/docs/worker-host#settings-and-host-orders">Settings, host orders and the brake →</a></div>
    </section>

    <section class="op-card" id="hp-owner" aria-labelledby="hp-owner-h" hidden>
      <div class="op-card-h"><b id="hp-owner-h">Owner control</b><small>its envelope widened and its agent keys set from here, signed with the passkey pinned at the host</small></div>
      <dl class="hp-kv" id="hp-owner-kv"></dl>
      <div class="op-card-b">
        <div class="hp-ops" id="hp-owner-ops"></div>
        <div class="hp-form" id="hp-owner-form"></div>
        <pre class="hp-pin" id="hp-pin" hidden></pre>
        <p class="hp-note">Its owner pins a passkey at the host once: Make a pin, then paste the command at the host as the agent's user. From then on the host takes a widening of its envelope, and its agent keys, only when that passkey signed them: the page shows the proposed values, your passkey signs them, the pool relays them, and the host checks the passkey, the page's origin, your presence and verification, and that nothing was taken twice. Agent keys are sealed to the host's seal key in this browser — confirm its fingerprint against <code>omarchy-agent status</code> once — so the pool holds only ciphertext, and the host writes them to its agent.env alone. Narrowing needs none of this: Settings, above.</p>
      </div>
      <div class="op-card-f"><a href="/docs/worker-host#owner-control-without-a-visit">Owner control without a visit →</a></div>
    </section>

    <section class="op-card" id="hp-orders" aria-labelledby="hp-orders-h">
      <div class="op-card-h"><b id="hp-orders-h">Host orders</b><small>what only its agent can do, each with its answer</small></div>
      <div class="op-card-b">
        <div class="hp-ops" id="hp-order-ops">
          <button type="button" class="op-btn" data-host-act="reconcile" disabled>${lucide("refresh-cw", 14)}Reconcile now</button>
          <button type="button" class="op-btn" data-host-act="retry-release" disabled>${lucide("package-check", 14)}Retry release</button>
          <button type="button" class="op-btn" data-host-act="rotate-token" disabled>${lucide("key-round", 14)}Rotate token</button>
          <button type="button" class="op-btn" data-host-act="diagnostics" disabled>${lucide("scroll-text", 14)}Diagnostics</button>
        </div>
        <p class="hp-note">Reconcile now: its agent runs a round at its next poll — the release the pool names, checked and rolled out as any round — and answers. Retry release lifts the quarantine of a release its guard reverted and tries it again. Rotate token: a new worker token for its dispatcher, recreated with it; the old one works ten more minutes. Diagnostics: the dispatcher's last 500 log lines, scrubbed of its secrets, when its envelope allows them. An order its agent has not taken within ${HOST_ORDER_TTL_MIN} minutes expires.</p>
      </div>
      <div class="hp-table"><table class="op-table"><thead><tr><th>Order</th><th>By</th><th>Given</th><th>State</th><th>Its agent's answer</th></tr></thead><tbody id="hp-order-rows"></tbody></table></div>
      <pre class="hp-diag" id="hp-diag" aria-live="polite"></pre>
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
      <div class="hp-table"><table class="op-table"><thead><tr><th>Task</th><th>Kind</th><th>Package</th><th>Arch</th><th>Lane</th><th>Units</th><th>Since</th><th aria-label="Stop"></th></tr></thead><tbody id="hp-lease-rows"></tbody></table></div>
      <p class="hp-note" style="margin:0;padding:10px 16px">Stop fences that task only: its lease is refused from then on, its dispatcher stops it, and it goes back to the queue; the host's other tasks run on.</p>
      <div class="op-card-f"><a href="/docs/worker-host#maintainer-hosts">How a host joins →</a></div>
    </section>
  </div>
`;

const SCRIPT = String.raw`
  // The host this page is about: the address's last segment (the router serves the same shell for every id).
  var ID = decodeURIComponent(location.pathname.replace(/^\/hosts\//, ""));
  var BASE = "/api/v1/hosts/" + encodeURIComponent(ID);
  // Its registration's worker orders (#324): Drain, Resume, Stop on a lease, and Update as Reconcile now for an agent that takes no host order.
  var REG_API = "/api/v1/factory/workers/";
  var FRESH_MIN = ${HOST_REPORT_FRESH_MIN};
  var PILL = { active: ["ok", "active"], "pending-owner": ["warn", "waits for its owner's Confirm"], suspended: ["fail", "suspended"], retired: ["na", "retired"] };
  var ICON = ${JSON.stringify({ suspend: lucide("ban", 14), resume: lucide("circle-check", 14), retire: lucide("octagon-x", 14), drain: lucide("circle-slash", 14), cap: lucide("cpu", 14), reconcile: lucide("refresh-cw", 14), legacy: lucide("file-archive", 14), units: lucide("hard-drive", 14), lanes: lucide("git-fork", 14), retry: lucide("package-check", 14), token: lucide("key-round", 14), diag: lucide("scroll-text", 14), stop: lucide("ban", 14), pin: lucide("shield-check", 14), seal: lucide("lock", 14), widen: lucide("arrow-up-right", 14) })};
  // What the "needs a person" box names (#324, fleet.ts needsPersonOf), one word each.
  var NEED_WORD = { "pending-owner": "Confirm", suspended: "suspended", stopped: "claims stopped", "below-minimum": "below the minimum", "disk-low": "disk low", binfmt: "binfmt", cgroups: "cgroup delegation", hosting: "hosting", "docker-group": "docker group", linger: "linger", credentials: "credentials", round: "its last round" };
  var SETTINGS_AGENT = ${JSON.stringify(HOST_SETTINGS_AGENT)};
  var OWNER_AGENT = ${JSON.stringify(HOST_OWNER_AGENT)};
  var WIDENABLE = ${JSON.stringify(WIDENABLE)};
  var AGENT_KEYS = ${JSON.stringify(AGENT_KEY_NAMES)};
  // The owner's agent keys are sealed in this browser to the host's seal key (#328): this is worker/src/seal.ts's own function, its source
  // inlined, so the page seals with exactly the code the tests run.
  ${sealAgentKey.toString()}
  var ORDER_PILL = { open: ["warn", "waits for its agent"], done: ["ok", "done"], refused: ["fail", "refused"], failed: ["fail", "failed"], expired: ["na", "expired"], cancelled: ["na", "cancelled"] };
  var LEGACY_PILL = { running: ["warn", "running"], stopped: ["na", "stopped"], gone: ["na", "no container left"], retiring: ["warn", "being retired"], retired: ["ok", "retired"], unknown: ["na", "not seen"] };
  var NOT_LISTED = ${JSON.stringify(OWNER_NOT_MAINTAINER)};
  var SANDBOX_KINDS = { gvisor: "gVisor", kata: "Kata Containers" };
  // A sleeping host (#329): what its sleep means for the pool, in the head's words.
  var SLEEPS = "the pool hands it nothing until it wakes, and a task the sleep caught goes back to the queue when its lease expires.";
  var H = null, PK = {}, TIMER = 0, REG = null, VIA = null;
  function stat(k, n, s) { return '<div class="op-stat"><span class="k">' + esc(k) + '</span><span class="n">' + n + '</span><span class="s">' + (s || "") + '</span></div>'; }
  function kv(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>'; }
  function when(iso) { return iso ? '<span title="' + esc(iso) + '">' + esc(ago(iso)) + '</span>' : '<span class="muted">—</span>'; }
  function load() {
    clearTimeout(TIMER);
    api("GET", BASE).then(function (d) {
      if (d.__status === 404) { $("#hp-name").textContent = ID; $("#hp-lede").textContent = "no such host: it was never enrolled"; endSkeleton(); return; }
      H = d.host; PK = d.passkey || {}; REG = d.registration || null; VIA = (d.can || {}).reconcile_via || null;
      draw(d.host, d.leases, d.pool || {}, d.update || null);
      drawNeeds(d.host);
      drawOps(d.host, d.can || { why: {} }, REG);
      drawSettings(d.host, d.can || { why: {} });
      drawOrders(d.host, d.orders, d.can || { why: {} });
      drawOwner(d.host, d.can || { why: {} });
      drawLegacy(d.host, d.can || { why: {} });
      TIMER = setTimeout(function () { if (!document.hidden) load(); }, 30000);
    }).catch(function (e) { noAnswer("host", e, "#hp-lede"); });
  }
  // Its soak (#326): the minutes its owner set at the host, and until when the release the pool names waits on it.
  function soakWords(h) {
    var k = h.soak;
    if (!k || !k.minutes) return '<span class="muted">none — a new release goes at its next poll</span>';
    return esc(String(k.minutes)) + " minutes" + (k.until ? (Date.parse(k.until) > Date.now() ? " — " + esc(h.release_target || "the pool's release") + " waits until " + when(k.until) : " — over " + when(k.until) + ": its round brings " + esc(h.release_target || "the release")) : "") + '; a rollback statement skips it, Reconcile now does not';
  }
  // Where its registration stands at the 426 gate (#326): claiming through its soak, on its last-good after a revert (#342), within the
  // grace, or refused — on a revoked release too, whatever it runs against the pool's — and why.
  function gateLine(u) {
    if (!u) return '<span class="muted">its registration has not claimed with a release yet</span>';
    if (!u.outdated && !u.revoked) return '<span class="muted">it runs the pool\'s release</span>';
    return u.required ? '<span class="hp-blocked">' + esc(u.words || "refused with 426") + "</span>" : esc(u.words || "");
  }
  function draw(h, leases, pool, update) {
    document.title = h.name + " · Host · omarchy-pool";
    $("#hp-name").textContent = h.name;
    var p = PILL[h.status] || ["na", h.status];
    $("#hp-status").innerHTML = '<span class="op-pill ' + p[0] + '">' + esc(p[1]) + '</span>' + (h.asleep ? ' <span class="op-pill na" title="' + esc(SLEEPS) + '">asleep</span>' : "");
    $("#hp-id").textContent = h.id + (h.worker ? " · registration " + h.worker : "");
    $("#hp-lede").innerHTML = "A maintainer host of " + personLink(h.owner) + (h.where ? ", " + esc(h.where) : "") + " — " + esc((h.arches || []).join(", ") || "no lane reported") + ". " + (h.status === "pending-owner" ? 'It waits for its owner to compare its fingerprint and press Confirm, on <a href="/user/' + encodeURIComponent(h.owner) + '#hosts">their page</a>; nothing claims before that.' : h.asleep ? "It sleeps (its agent said so " + when(h.asleep_since) + "): " + esc(SLEEPS) : h.alive ? "Its agent reports." : '<span class="muted">Its agent has not reported in the last ' + esc(String(FRESH_MIN)) + ' minutes' + (h.asleep_since ? "; its last report said it was going to sleep, " + when(h.asleep_since) : "") + '.</span>');
    // Who stopped it and why, for anyone (the journal's words): a suspension or a retirement, and the maintainer list's stop.
    var stopped = [];
    if ((h.status === "suspended" || h.status === "retired") && h.status_by) stopped.push(esc(h.status === "suspended" ? "Suspended" : "Retired") + " by " + personLink(h.status_by) + (h.status_at ? " " + when(h.status_at) : "") + (h.status_reason ? ": " + esc(h.status_reason) : "") + (h.status === "suspended" ? ". It claims nothing until " + personLink(h.owner) + " resumes it." : ". A new install enrolls a new host."));
    if (h.claims_stopped_at && h.status !== "retired") stopped.push("Its claims stopped " + when(h.claims_stopped_at) + ": " + esc(NOT_LISTED) + ' (<a href="/docs/governance">factory/MAINTAINERS.toml</a>). Its running tasks finish; listed again, ' + personLink(h.owner) + ' resumes their hosts on <a href="/user/' + encodeURIComponent(h.owner) + '#hosts">their page</a>.');
    $("#hp-stopped").innerHTML = stopped.join("<br>");
    // Freeze detection (#326): its agent says GitHub has shown a newer release than the pool names for over a day; it acts on nothing.
    var fz = h.pool_behind_github;
    $("#hp-freeze").innerHTML = fz ? "Pool behind GitHub: GitHub's latest release has been " + esc(fz.github) + " since " + when(fz.since) + " while the pool names " + esc(fz.pool) + ' — a pool held on an old release (freeze detection). Its agent changes nothing for it: check the pool\'s deploys (the runbook\'s <a href="/docs/runbook#a-new-maintainer-host">A new maintainer host</a>, Freeze detection).' : "";
    var c = h.capacity;
    $("#hp-stats").innerHTML = c ? [
      stat("CPUs", num(c.cpus), "memory " + num(c.mem_gb) + " GB"),
      // Its units (#324): busy and free for a task now, and the one kept for pool jobs — what the pool counts, under its cap.
      stat("Units", h.units === null || h.units === undefined ? "—" : num(h.units_busy || 0) + " / " + num(h.units_effective === null || h.units_effective === undefined ? h.units : h.units_effective), h.asleep ? "asleep: none free until it wakes" : "busy · " + num(h.units_free || 0) + " free for a task, " + num(h.job_reserved || 0) + " kept for pool jobs" + (h.pool_cap_units !== null && h.pool_cap_units !== undefined ? " · capped at " + num(h.pool_cap_units) + " by the pool" : "")),
      stat("Disk free", num(c.disk_free_gb.work) + " GB", "work root · engine " + num(c.disk_free_gb.engine) + " GB"),
      stat("Agent slots", c.agent_slots === null || c.agent_slots === undefined ? "—" : num(c.agent_slots), "model tasks at once"),
      stat("Release", esc(h.release_applied || "—"), pool.version ? "the pool runs " + esc(pool.version) : ""),
    ].join("") : "";
    // Its lanes (#338, #324): native, emulated with how and whether the kernel's pages are 16K, and the ones its agent holds, with why.
    var lanes = (h.lanes || []).map(function (l) { return esc(l.arch + " " + l.mode + (l.via ? " (" + l.via + (l.page16k ? ", 16K pages" : "") + ")" : "")); }).join(", ")
      + (h.held_lanes || []).map(function (l) { return '<br><span class="hp-held">' + esc(l.arch) + " held</span> — " + esc(l.reason); }).join("");
    var round = h.round ? esc(String(h.round.outcome || "?")) + (h.round.from ? " from " + esc(h.round.from) : "") + (h.round.step ? " at " + esc(h.round.step) : "") + (h.round.at ? " " + when(h.round.at) : "") + (h.round.detail ? '<br><span class="muted">' + esc(h.round.detail) + "</span>" : "") : "—";
    var tools = h.tools || {}, caps = h.owner_caps, lim = h.limits;
    $("#hp-kv").innerHTML = h.fingerprint === undefined
      ? kv("Status", esc(p[1])) + kv("Release", esc(h.release_applied || "—")) + kv("Alive", h.alive ? "its agent reports" : '<span class="muted">its agent has not reported in the last ' + esc(String(FRESH_MIN)) + " minutes</span>") + kv("Details", '<span class="muted">its owner\'s and the maintainers\'</span>')
      : [
        kv("Status", esc(p[1]) + (h.status_at && (h.status === "suspended" || h.status === "retired") ? " since " + when(h.status_at) : h.confirmed_at ? " since " + when(h.confirmed_at) : " — enrolled " + when(h.enrolled_at))),
        kv("Host key", '<span class="mono">' + esc(h.fingerprint) + '</span>'),
        kv("Machine", esc((h.hostname || "?") + " · " + (h.os || "?") + " " + (h.arch || "?") + (h.page_kb ? ", " + h.page_kb + "K pages" : ""))),
        kv("Isolation", esc(h.isolation || "?") + (h.dedicated ? " (dedicated)" : h.dedicated === false ? " (a dedicated user on a shared machine)" : "")),
        kv("Runtime", runtimeWords(h)),
        // The versions (#324, design v2 §18.1): its agent's, and the compose plugin and docker CLI — its report's word, or the ones its release pins.
        kv("Versions", "agent " + esc(h.agent_version || "?") + " · compose " + esc(tools.compose || "?") + " · docker CLI " + esc(tools.docker || "?") + (tools.engine ? " · engine " + esc(tools.engine) : "") + (tools.pinned ? ' <span class="muted">(the ones ' + esc(h.release_applied || "its release") + " pins)</span>" : "")),
        kv("Sandbox", sandboxWords(h)),
        kv("Lanes", lanes || "—"),
        kv("Capacity", h.below_minimum ? esc(h.below_minimum) : c ? "meets the minimum to join" : "—"),
        kv("Units", unitWords(h)),
        kv("Owner's caps", caps ? (caps.max_units === null || caps.max_units === undefined ? "no cap on units" : esc(String(caps.max_units)) + " unit" + (caps.max_units === 1 ? "" : "s")) + (caps.detected_units !== null && caps.detected_units !== undefined ? " of the " + esc(String(caps.detected_units)) + " detected" : "") + (c && c.agent_slots !== null && c.agent_slots !== undefined ? " · " + esc(String(c.agent_slots)) + " agent slot" + (c.agent_slots === 1 ? "" : "s") : "") + (caps.emulate ? " · emulated lanes " + esc(caps.emulate.join(", ") || "none") : "") + ' <span class="muted">— its envelope, at the host</span>' : '<span class="muted">its agent reports none yet</span>'),
        kv("Limits", lim ? (lim.cpus_hard && lim.memory_hard && lim.pids ? "--cpus, --memory and --pids-limit enforced" : '<span class="hp-blocked">not enforced: ' + esc([lim.cpus_hard ? "" : "--cpus", lim.memory_hard ? "" : "--memory", lim.pids ? "" : "--pids-limit"].filter(Boolean).join(", ")) + "</span>") : '<span class="muted">not reported</span>'),
        kv("Pool cap", capWords(h)),
        kv("Reserving", h.reserving_task ? 'for <a href="/build/' + esc(h.reserving_task) + '">#' + esc(h.reserving_task) + '</a> since ' + when(h.reserving_since) + ': it takes nothing else but pool jobs until its units fit it' : '<span class="muted">no</span>'),
        kv("Release", esc(h.release_applied || "—") + (h.release_target ? " → " + esc(h.release_target) : "") + (h.release_floor ? ' <span class="muted">floor ' + esc(h.release_floor) + "</span>" : "") + (h.rolled_back_from ? " (rolled back from " + esc(h.rolled_back_from) + (h.rolled_back_at ? " " + when(h.rolled_back_at) : "") + ")" : "") + (h.last_good ? "<br>" + pillHtml("warn", "last-good", "its registration claims on its last-good; past this the pool hands it nothing until it runs the pool's release") + " " + esc(h.last_good) : "")),
        kv("Rollout", h.rollout && h.rollout.state ? esc(h.rollout.state) + (h.rollout.target ? " → " + esc(h.rollout.target) : "") + (h.rollout.since ? " since " + when(h.rollout.since) : "") : '<span class="muted">—</span>'),
        kv("Soak", soakWords(h)),
        kv("Claims", gateLine(update)),
        kv("GitHub", h.soak && h.soak.github_latest ? "its latest release is " + esc(h.soak.github_latest) + ", as its agent read it" : '<span class="muted">not read yet</span>'),
        kv("Last round", round),
        kv("Agent", esc(h.agent_version || "?") + (h.provider ? " · " + esc(h.provider) + (h.model ? " " + esc(h.model) : "") : "")),
        kv("Reported", when(h.reported_at)),
      ].join("");
    // Its leases (#324): its owner's and the maintainers' — each with a Stop that fences that task only, greyed with the door's words.
    $("#hp-lease-rows").innerHTML = leases === undefined ? '<tr><td colspan="8" class="muted">its owner\'s and the maintainers\' — the Workers page says how many tasks it runs</td></tr>' : leases.map(function (t) {
      var st = t.stop || {};
      var stop = t.fenced ? pillHtml("warn", "fenced", "stopped by the pool: back to the queue when its lease ends") : gate('<button type="button" class="op-btn sm" data-stop="' + esc(t.id) + '" data-name="' + esc(t.name) + '">' + ICON.stop + "Stop</button>", st.ok === true, st.why || "");
      return '<tr><td><a href="/build/' + esc(t.id) + '">#' + esc(t.id) + '</a></td><td>' + esc(t.kind || "build") + (t.size > 1 ? " · size " + esc(t.size) : "") + '</td><td>' + esc(t.name) + '</td><td>' + esc(t.arch) + '</td><td>' + esc(t.lane || "—") + '</td><td>' + esc(t.units === null || t.units === undefined ? "—" : t.units) + '</td><td>' + when(t.started_at) + '</td><td>' + stop + '</td></tr>';
    }).join("") || '<tr><td colspan="8" class="muted">no lease — nothing runs on it now</td></tr>';
    endSkeleton();
  }
  // Its units in words (#324): what the pool counts, what its leases hold, what is free for a task, the one kept for pool jobs.
  function unitWords(h) {
    if (h.units === null || h.units === undefined) return "—";
    var eff = h.units_effective === null || h.units_effective === undefined ? h.units : h.units_effective;
    return num(eff) + " the pool counts — " + num(h.units_busy || 0) + " busy on " + num(h.tasks || 0) + " task" + (h.tasks === 1 ? "" : "s") + ", " + num(h.units_free || 0) + " free for a task, " + num(h.job_reserved || 0) + " kept for pool jobs" + (h.state && h.state !== "claiming" && h.state !== "full" ? ' <span class="muted">(' + esc(h.state) + ": none handed out)</span>" : "");
  }
  // What needs a person (#324): its owner's and the maintainers', one line each with its word; hidden when nothing does.
  function drawNeeds(h) {
    var n = h.needs_person || [];
    $("#hp-needs").hidden = h.fingerprint === undefined || !n.length;
    $("#hp-needs-list").innerHTML = n.map(function (x) { return "<li><b>" + esc(NEED_WORD[x.what] || x.what) + "</b>" + esc(x.text) + "</li>"; }).join("");
  }
  // Its runtime (#325, #330): the driver its agent reports — compose on docker or on podman, or Quadlet, a unit of its owner's own
  // systemd on rootless podman — and the owner's switch in flight, which only the owner starts, at the host.
  function runtimeWords(h) {
    var r = h.runtime || {}, words = { "compose/docker": "compose on docker", "compose/podman": "compose on podman", quadlet: "Quadlet: a unit of its owner's systemd, on rootless podman" };
    if (!r.driver) return '<span class="muted">not said yet by its agent</span>';
    var name = function (d) { return esc(words[d] || d); };
    return name(r.driver) + (r.switch && r.switch.to ? " — switching to " + name(r.switch.to) + (r.switch.step ? " (" + esc(r.switch.step) + ")" : "") : "");
  }
  // Its sandboxed runtime (#330, D43): the one its dispatcher applies, as its last claim said — what a contributor wrote (their builds,
  // the project's review rebuilds of them, trials, audits) runs in it on the native lane, so a container escape lands in the sandbox's
  // kernel, not on the host, and its emulated lanes take the project's own recipes only — beside what its agent found and why one is
  // not used. Only what the dispatcher says is claimed: one before #330 ignores what its agent found.
  function sandboxWords(h) {
    var c = h.capacity || {}, found = c.sandbox, a = h.sandbox_applied;
    var named = function (s) { return esc((SANDBOX_KINDS[s.kind] || s.kind) + " (" + s.runtime + ")"); };
    var held = c.sandbox_held ? '<br><span class="muted">' + esc(c.sandbox_held) + '</span>' : "";
    var none = "none — what its contributors wrote runs on the engine's own runtime, at its isolation level";
    if (!a) {
      if (found) return '<span class="muted">its agent found ' + named(found) + ", but its dispatcher does not say it applies it (one before #330): what its contributors wrote may run on the engine's own runtime</span>" + held;
      if (found === null) return none + held;
      return '<span class="muted">its agent does not say (one before the sandbox, #330)</span>' + held;
    }
    var stop = a.held ? '<br><span class="muted">its claims hold: ' + esc(a.held) + '</span>' : "";
    if (!a.sandbox) return none + stop + held;
    var lanes = h.lanes || [], native = lanes.filter(function (l) { return l.mode === "native"; }).map(function (l) { return l.arch; });
    var emulated = lanes.filter(function (l) { return l.mode === "emulated"; }).map(function (l) { return l.arch; });
    return named(a.sandbox) + " — what its contributors wrote (their builds, the project's review rebuilds, trials, audits) runs in it on the " + esc(native.join(", ") || "native") + " lane: a container escape lands in its kernel, not on the host"
      + (emulated.length ? "; its emulated " + esc(emulated.join(", ")) + " lane takes the project's own recipes only" : "") + stop + held;
  }
  // The pool's cap (#337): what the pool hands it at most, whatever its envelope says; none lets its count decide.
  // The cap dialog's choices: none, or 0 up to the units the pool counts on it — the door refuses a cap above them (#324) —, or
  // sixteen while it counts none.
  function capOptions(h) {
    var top = h.units === null || h.units === undefined ? 16 : h.units, opts = [{ value: "", text: "No cap — its count decides", selected: h.pool_cap_units === null || h.pool_cap_units === undefined }];
    for (var u = 0; u <= top; u++) opts.push({ value: String(u), text: u + " unit" + (u === 1 ? "" : "s") + (u === 0 ? " — it claims nothing" : u === 3 ? " — one build and the pool jobs' unit" : ""), selected: h.pool_cap_units === u });
    return opts;
  }
  function capWords(h) { return h.pool_cap_units === null || h.pool_cap_units === undefined ? '<span class="muted">none — its count decides</span>' : esc(String(h.pool_cap_units)) + " unit" + (h.pool_cap_units === 1 ? "" : "s") + (h.units !== null && h.units !== undefined ? " of its " + esc(String(h.units)) : ""); }
  // Stop it (#322): the three buttons as the door answers them for this reader, greyed with its reason; its registration's Drain and
  // Resume as the worker orders' door answers them (#324): the owner rule's words where it says no.
  function drawOps(h, can, reg) {
    var why = can.why || {};
    // The pool's cap (#337): its owner or any maintainer, greyed with the door's reason for everyone else.
    $("#hp-cap").innerHTML = h.status === "retired" ? "" : '<span>Pool cap: ' + capWords(h) + '</span>' + gate('<button type="button" class="op-btn" data-host-act="cap">' + ICON.cap + 'Set the pool cap</button>', can.cap === true, why.cap || "");
    $("#hp-ops").innerHTML = [
      gate('<button type="button" class="op-btn" data-host-act="suspend">' + ICON.suspend + 'Suspend</button>', can.suspend === true, why.suspend || ""),
      gate('<button type="button" class="op-btn" data-host-act="resume">' + ICON.resume + 'Resume</button>', can.resume === true, why.resume || ""),
      gate('<button type="button" class="op-btn danger" data-host-act="retire">' + ICON.retire + 'Retire</button>', can.retire === true, why.retire || ""),
    ].concat(regOps(h, reg)).join("");
  }
  function regOps(h, reg) {
    var no = !h.worker ? "it has no registration yet: its owner's Confirm makes it" : h.fingerprint === undefined ? orSignIn("only " + h.owner + " or a maintainer drains it") : "";
    var r = reg || { can: {}, why: {} }, d = r.drained;
    return [
      gate('<button type="button" class="op-btn" data-host-act="drain">' + ICON.drain + "Drain</button>", !no && r.can.drain === true, no || r.why.drain || ""),
      gate('<button type="button" class="op-btn" data-host-act="undrain" title="' + esc(d ? "drained by " + (d.by || "?") + (d.reason ? ": " + d.reason : "") : "") + '">' + ICON.resume + "Resume claims</button>", !no && r.can.resume === true, no || r.why.resume || ""),
    ];
  }
  function lanesText(a) { return a && a.length ? a.map(esc).join(", ") : "none"; }
  // Its settings (#325): what its agent reports — the units it gives and its emulated lanes, the envelope they narrow inside, what of
  // them the envelope leaves out — and the controls: the units up to what it detected, greyed above its envelope; a lane per detected
  // or allowed architecture, greyed where its envelope excludes it; the brake's last hour.
  function drawSettings(h, can) {
    var why = can.why || {}, s = h.settings;
    $("#hp-settings").hidden = h.fingerprint === undefined;
    if (h.fingerprint === undefined) return;
    if (!s) {
      $("#hp-settings-kv").innerHTML = kv("Settings", '<span class="muted">its agent reports none yet: agent ' + esc(SETTINGS_AGENT) + ' or later does</span>');
      $("#hp-settings-ops").innerHTML = "";
      return;
    }
    var env = s.envelope || {}, eff = s.effective || {}, max = env.max_units, det = env.detected_units, b = h.brake;
    $("#hp-settings-kv").innerHTML = [
      kv("Units", (eff.units === null || eff.units === undefined ? "—" : num(eff.units)) + (s.units === null || s.units === undefined ? " — its envelope's" : " — narrowed from the site") + (max === null || max === undefined ? "" : "; its envelope gives " + num(max) + (det !== null && det !== undefined && det !== max ? " of the " + num(det) + " detected" : ""))),
      kv("Emulated lanes", lanesText(eff.emulated) + (s.emulate === null || s.emulate === undefined ? " — its envelope's" : " — set from the site") + "; detected " + lanesText(env.detected_lanes) + (env.emulate === null || env.emulate === undefined ? "" : "; its envelope allows " + lanesText(env.emulate))),
      kv("Diagnostics", env.diagnostics === true ? "its envelope allows them" : env.diagnostics === false ? '<span class="muted">its envelope does not allow them: diagnostics = true in agent.toml, at the host</span>' : "—"),
    ].concat((s.above || []).length ? [kv("Above its envelope", '<span class="hp-blocked">' + s.above.map(esc).join("; ") + "</span>")] : [])
      .concat(b ? [kv("Brake", num(b.orders_hour) + " of 20 orders, " + num(b.restarts_hour) + " of 6 dispatcher restarts, " + num(b.narrowings_hour) + " of 4 narrowings in the last hour" + (b.release_change_at ? "; a release change " + when(b.release_change_at) : ""))] : [])
      .join("");
    var ok = can.settings === true, w = why.settings || "";
    var top = det !== null && det !== undefined ? det : max !== null && max !== undefined ? max : 0;
    var opts = '<option value="">its envelope\'s' + (max === null || max === undefined ? "" : " (" + max + ")") + "</option>";
    for (var i = 1; i <= top; i++) {
      var over = max !== null && max !== undefined && i > max;
      opts += '<option value="' + i + '"' + (over ? ' disabled title="above its envelope (' + max + '): only its owner widens that, at the host"' : "") + (s.units === i ? " selected" : "") + ">" + i + (over ? " — above its envelope" : "") + "</option>";
    }
    var lanes = [];
    (env.detected_lanes || []).concat(env.emulate || [], s.emulate || []).forEach(function (a) { if (lanes.indexOf(a) < 0) lanes.push(a); });
    var boxes = lanes.map(function (a) {
      var excluded = env.emulate !== null && env.emulate !== undefined && env.emulate.indexOf(a) < 0;
      var on = (eff.emulated || []).indexOf(a) >= 0;
      return "<label" + (excluded ? ' class="muted" title="its envelope excludes it: only its owner widens that, at the host"' : "") + '><input type="checkbox" data-lane="' + esc(a) + '"' + (on ? " checked" : "") + (excluded ? " disabled" : "") + "> " + esc(a) + "</label>";
    }).join("");
    $("#hp-settings-ops").innerHTML = gate('<label class="hp-field">Units <select id="hp-units">' + opts + "</select></label>", ok, w)
      + gate('<button type="button" class="op-btn" data-host-act="set-units">' + ICON.units + "Narrow units</button>", ok, w)
      + (lanes.length ? gate('<span class="hp-lanes">' + boxes + "</span>", ok, w) + gate('<button type="button" class="op-btn" data-host-act="set-emulate">' + ICON.lanes + "Set emulated lanes</button>", ok, w) : '<span class="muted">no emulated lane detected</span>');
  }
  // Owner control (#328): the passkey pinned at the host, its seal key, the envelope a widening starts from and the agent keys' names, as
  // its agent reports them; Make a pin, Confirm the seal key, Widen the envelope and Set agent keys — its owner's, greyed with the door's reason.
  function envText(v) { return v === null || v === undefined ? "—" : typeof v === "object" && !Array.isArray(v) ? Object.keys(v).map(function (k) { return k + "=" + v[k]; }).join(" ") : Array.isArray(v) ? (v.length ? v.join(", ") : "none") : String(v); }
  // The seal key its owner confirmed in this browser, kept here (#328): the pool's record of the confirmation is the pool's, so a key the
  // pool's database says is confirmed but this browser confirmed another is confirmed again before anything is sealed to it, and one
  // this browser never confirmed is compared with omarchy-agent status before the first seal to it (sealCompared): the pool's record
  // never decides on its own which key a value is sealed to.
  function sealHere(id) { try { return localStorage.getItem("op-seal:" + id) || ""; } catch (e) { return ""; } }
  function keepSeal(id, key) { try { localStorage.setItem("op-seal:" + id, key); } catch (e) {} }
  // Whether a value may be sealed to the key its agent reports (true), its owner having compared it in this browser — now, or before.
  function sealCompared(key, fp) {
    var here = sealHere(ID);
    if (here === key) return Promise.resolve(true);
    if (here) { toast("Its seal key is not the one you confirmed in this browser: compare it with <code>omarchy-agent status</code> at the host and confirm it again. Nothing was sealed.", "error"); return Promise.resolve(false); }
    return ask({ title: "Compare the seal key of " + H.name, text: "This browser has not confirmed it yet. At the host, <code>omarchy-agent status</code> prints its seal key: it must be <code>" + esc(fp || "?") + "</code>. Your agent keys are sealed to this key in your browser, and only the host opens them.", confirm: "It is the same: seal to it", nothing: "Nothing was sealed." }).then(function (go) {
      if (go === null) return false;
      keepSeal(ID, key);
      return true;
    });
  }
  function drawOwner(h, can) {
    $("#hp-owner").hidden = h.fingerprint === undefined;
    if (h.fingerprint === undefined) return;
    var o = h.owner_control, s = h.seal, why = can.why || {}, ok = can.owner === true, w = why.owner || "";
    var pk = o && o.passkey, env = (o && o.envelope) || {};
    var here = sealHere(h.id), other = !!(s && s.key && here && here !== s.key);
    var sealed = !!(s && s.key && s.confirmed && s.confirmed.current) && !other;
    $("#hp-owner-kv").innerHTML = !o ? kv("Owner control", '<span class="muted">its agent reports none yet: agent ' + esc(OWNER_AGENT) + ' or later does</span>') : [
      kv("Passkey at the host", pk ? esc(pk.by) + "'s " + esc(pk.alg) + ' passkey <span class="mono">' + esc(pk.credential.slice(0, 12)) + "…</span> for " + esc(pk.rp_id) + ", pinned " + when(pk.pinned_at) + (o.version ? "; it took signed version " + num(o.version) + " last" : "") : '<span class="muted">none pinned yet: Make a pin, then paste it at the host</span>'),
      kv("Seal key", s && s.fingerprint ? '<span class="mono">' + esc(s.fingerprint) + "</span> " + (sealed ? pillHtml("ok", "confirmed", "by " + s.confirmed.by + ", " + s.confirmed.at + (here ? "" : "; this browser has you compare it with omarchy-agent status before it seals anything to it")) : other ? pillHtml("warn", "not the key you confirmed in this browser", "compare it with omarchy-agent status at the host and confirm it again") : s.confirmed ? pillHtml("warn", "changed since it was confirmed", "a key made again: compare and confirm it again") : pillHtml("warn", "not confirmed yet", "compare it with omarchy-agent status at the host")) : '<span class="muted">its agent reports none yet</span>'),
      kv("Envelope", WIDENABLE.map(function (k) { return '<span class="mono">' + esc(k) + " " + esc(envText(env[k])) + "</span>"; }).join(", ")),
      kv("Agent keys", o.agent_keys.length ? o.agent_keys.map(esc).join(", ") : '<span class="muted">none</span>'),
    ].join("");
    $("#hp-owner-ops").innerHTML = [
      gate('<button type="button" class="op-btn" data-host-act="pin">' + ICON.pin + "Make a pin</button>", ok, w),
      gate('<button type="button" class="op-btn" data-host-act="seal-key">' + ICON.seal + "Confirm the seal key</button>", ok && !!(s && s.key) && !sealed, !ok ? w : sealed ? "confirmed already" : "its agent reports no seal key yet"),
      gate('<button type="button" class="op-btn" data-host-act="widen">' + ICON.widen + "Widen the envelope</button>", ok && !!pk, !ok ? w : "no passkey is pinned at the host yet: Make a pin first"),
      gate('<button type="button" class="op-btn" data-host-act="agent-keys">' + ICON.token + "Set agent keys</button>", ok && !!pk && sealed, !ok ? w : !pk ? "no passkey is pinned at the host yet: Make a pin first" : "confirm its seal key first"),
    ].join("");
  }
  // Whether the document the pool answered says what this page asked for and showed (#328), or why not: its challenge is the document's
  // SHA-256, and it names this host, the act, the envelope or the keys as sealed here, the seal key they were sealed to, a version above
  // the last its agent took — and for a pin, this page's origin. Checked before the passkey is asked: a pool database or API that
  // answered another document gets nothing signed. (The page itself is the pool's: security-model.md says what that leaves.)
  function docSaysWhy(body, o) {
    var d;
    try { d = JSON.parse(o.doc); } catch (e) { return "it does not read"; }
    var same = function (a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); };
    if (!d || d.schema !== "omarchy-agent/owner/1" || d.act !== body.act || d.host !== ID) return "it is not for " + body.act + " on this host";
    if (body.act === "pin-passkey") return d.origin === location.origin && d.rp_id === o.publicKey.rpId ? "" : "it names another page than this one";
    if (!Number.isSafeInteger(d.version) || d.version <= (((H || {}).owner_control || {}).version || 0)) return "its version is not above the last its agent took";
    if (body.act === "widen-envelope") return same(d.envelope, body.envelope) ? "" : "its envelope is not the one shown here";
    return same(d.keys, body.keys) && d.seal_key === ((H || {}).seal || {}).key ? "" : "its keys are not the ones sealed here";
  }
  // A document the pool writes for this host, signed with the owner's passkey (#328): the pool's document and challenge (its SHA-256),
  // both checked here (docSaysWhy), navigator.credentials.get() with user verification, then post(doc, assertion). Refused before it — a
  // prompt cancelled, a browser without passkeys, a document that is not the one asked for — with an answer of its own, { error, code },
  // as api() gives one.
  function signDoc(body, post) {
    var no = function (text) { return { error: text + " Nothing changed.", code: "no_answer" }; };
    if (!window.PublicKeyCredential || !navigator.credentials || !window.isSecureContext) return Promise.resolve(no("This browser cannot use a passkey on this page: it needs a secure address (https, or localhost) and passkey support."));
    return api("POST", BASE + "/owner/challenge", body).then(function (o) {
      if (o.error) return o;
      var k = o.publicKey;
      return crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(o.doc))).then(function (h) {
        var why = webB64(h) !== k.challenge ? "its challenge is not the document's SHA-256" : docSaysWhy(body, o);
        return why ? no("The pool answered a document other than the one this page asked for (" + why + "): your passkey was not asked.") : null;
      }).then(function (refused) {
        if (refused) return refused;
        return navigator.credentials.get({ publicKey: { challenge: webBytes(k.challenge), rpId: k.rpId, timeout: k.timeout, userVerification: k.userVerification, allowCredentials: k.allowCredentials.map(function (c) { return { type: c.type, id: webBytes(c.id) }; }) } }).then(function (cred) {
          if (!cred) return no("No passkey answered.");
          var r = cred.response;
          return post(o.doc, { credential: webB64(cred.rawId), client_data: webB64(r.clientDataJSON), authenticator_data: webB64(r.authenticatorData), signature: webB64(r.signature), user_handle: r.userHandle ? webB64(r.userHandle) : "" });
        }, function (e) {
          var n = e && e.name;
          return no(n === "NotAllowedError" || n === "AbortError" ? "No passkey answered: the request was cancelled or timed out — or this is not the passkey pinned at the host." : "Your passkey could not be asked: " + errorText(e).replace(/[.\s]+$/, "") + ".");
        });
      });
    });
  }
  // The widening's form: the envelope's keys as its agent reports them, each changed one sent; empty is none (no cap, the default budget).
  function widenForm() {
    var env = ((H.owner_control || {}).envelope) || {}, b = env.agent_budget || {};
    var n = function (k, label, v) { return '<label>' + esc(label) + '<input type="number" min="0" data-env="' + k + '" value="' + (v === null || v === undefined ? "" : esc(v)) + '" placeholder="none"></label>'; };
    // The emulated lanes: none set (detection's), none, each architecture the pool builds (the shell's ARCHES), or all of them.
    var em = env.emulate === null || env.emulate === undefined ? "" : env.emulate.length ? env.emulate.slice().sort().join(",") : "none";
    var all = ARCHES.slice().sort();
    var opts = [["", "detection's (no key)"], ["none", "none"]].concat(ARCHES.map(function (a) { return [a, a]; }), [[all.join(","), all.join(", ")]]).map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === em ? " selected" : "") + ">" + x[1] + "</option>"; }).join("");
    $("#hp-owner-form").innerHTML = n("max_units", "max_units", env.max_units) + n("max_cpus", "max_cpus", env.max_cpus) + n("max_mem_gb", "max_mem_gb", env.max_mem_gb) + n("agent_slots", "agent_slots", env.agent_slots)
      + '<label>emulate<select data-env="emulate">' + opts + "</select></label>"
      + '<label>diagnostics<select data-env="diagnostics"><option value="false"' + (env.diagnostics ? "" : " selected") + '>false</option><option value="true"' + (env.diagnostics ? " selected" : "") + ">true</option></select></label>"
      + ["calls_per_task", "tokens_per_task", "minutes_per_task", "calls_per_day"].map(function (k) { return '<label>agent_budget.' + k + '<input type="number" min="1" data-budget="' + k + '" value="' + (b[k] ? esc(b[k]) : "") + '" placeholder="default"></label>'; }).join("")
      + '<label class="wide">paths, one a line<textarea rows="2" data-env="paths">' + esc((env.paths || []).join("\n")) + "</textarea></label>"
      + '<div class="hp-ops wide"><button type="button" class="op-btn" data-host-act="widen-send">' + ICON.widen + "Review and sign</button></div>";
  }
  // The value a key of the envelope takes where agent.toml does not set it, which its agent reports as null: agent_slots 2 and
  // diagnostics false (install writes neither), so a form left as it was asks for neither.
  var ENV_DEFAULT = { agent_slots: 2, diagnostics: false };
  function envWas(env, k) { return env[k] === null || env[k] === undefined ? (k in ENV_DEFAULT ? ENV_DEFAULT[k] : null) : env[k]; }
  // What the form asks for that the envelope does not say: {key: value}, each as a widening sets it.
  function widenAsked() {
    var env = ((H.owner_control || {}).envelope) || {}, out = {};
    document.querySelectorAll("#hp-owner-form [data-env]").forEach(function (el) {
      var k = el.getAttribute("data-env"), v, was = envWas(env, k);
      if (k === "emulate") v = el.value === "" ? null : el.value === "none" ? [] : el.value.split(",");
      else if (k === "diagnostics") v = el.value === "true";
      else if (k === "paths") v = el.value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
      else v = el.value === "" ? (k in ENV_DEFAULT ? ENV_DEFAULT[k] : null) : Number(el.value);
      if (k === "paths" && !v.length && was === null) return;
      if (JSON.stringify(v) !== JSON.stringify(was)) out[k] = v;
    });
    var budget = {}, any = false;
    document.querySelectorAll("#hp-owner-form [data-budget]").forEach(function (el) { if (el.value !== "") { budget[el.getAttribute("data-budget")] = Number(el.value); any = true; } });
    var was = env.agent_budget === undefined ? null : env.agent_budget;
    if (JSON.stringify(any ? budget : null) !== JSON.stringify(was)) out.agent_budget = any ? budget : null;
    return out;
  }
  // The agent keys' form: a key's name and its value, sealed here; or the key taken out.
  function keysForm() {
    $("#hp-owner-form").innerHTML = '<label>Key<select data-key-name>' + AGENT_KEYS.map(function (k) { return '<option value="' + k + '">' + k + "</option>"; }).join("") + "</select></label>"
      + '<label>Value (sealed in this browser; never sent as it is)<input type="password" autocomplete="off" spellcheck="false" data-key-value></label>'
      + '<label>Or<select data-key-remove><option value="">set it</option><option value="remove">take it out of agent.env</option></select></label>'
      + '<div class="hp-ops wide"><button type="button" class="op-btn" data-host-act="keys-send">' + ICON.token + "Seal and sign</button></div>";
  }
  // An order's value, as the journal row says it: "set-units 4", "set-emulate none", "widen-envelope version 3: max_units".
  function argText(o) {
    var a = o.arg;
    if (!a) return "";
    if ("envelope" in a) return " version " + a.version + ": " + Object.keys(a.envelope).join(", ");
    if ("keys" in a) return " version " + a.version + ": " + a.keys.join(", ");
    if ("units" in a) return " " + (a.units === null ? "(its envelope's)" : a.units);
    if ("emulate" in a) return " " + (a.emulate === null ? "(its envelope's)" : lanesText(a.emulate));
    return "";
  }
  // Host orders (#344, #325): Reconcile now and P4's orders as the door answers them for this reader — Retry release greyed while its
  // agent reports nothing quarantined, Diagnostics while its envelope does not allow them — and the last orders with their answers.
  function drawOrders(h, orders, can) {
    var why = can.why || {}, q = h.quarantine || [], env = (h.settings || {}).envelope || {};
    $("#hp-order-ops").innerHTML = [
      // Reconcile now (#344, #324): a host order; while its agent takes none, an Update of its registration (reconcile_via).
      gate('<button type="button" class="op-btn" data-host-act="reconcile">' + ICON.reconcile + "Reconcile now</button>", can.reconcile === true || can.reconcile_via === "update", why.reconcile || ""),
      gate('<button type="button" class="op-btn" data-host-act="retry-release">' + ICON.retry + "Retry release</button>", can.retry_release === true && q.length > 0, why.retry_release || "its agent reports no release in quarantine: there is nothing to lift"),
      gate('<button type="button" class="op-btn" data-host-act="rotate-token">' + ICON.token + "Rotate token</button>", can.rotate_token === true, why.rotate_token || ""),
      gate('<button type="button" class="op-btn" data-host-act="diagnostics">' + ICON.diag + "Diagnostics</button>", can.diagnostics === true && env.diagnostics !== false, why.diagnostics || "its envelope does not allow diagnostics: diagnostics = true in agent.toml, at the host"),
    ].join("");
    if (orders === undefined) { $("#hp-order-rows").innerHTML = '<tr><td colspan="5" class="muted">its owner\'s and the maintainers\'</td></tr>'; return; }
    $("#hp-order-rows").innerHTML = orders.map(function (o) {
      var p = ORDER_PILL[o.state] || ["na", o.state];
      var lines = o.lines ? ' <button type="button" class="op-btn sm" data-diag="' + esc(o.id) + '">' + ICON.diag + "Its lines</button>" : "";
      return '<tr><td><span class="mono">' + esc(o.kind) + esc(argText(o)) + "</span></td><td>" + personLink(o.issued_by) + "</td><td>" + when(o.issued_at) + "</td><td>" + pillHtml(p[0], p[1], o.state === "open" ? "until " + o.not_after : o.answered_at || "") + "</td><td>" + (o.detail ? esc(o.detail) : '<span class="muted">—</span>') + lines + "</td></tr>";
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
  // Its registration's orders (#324): the worker orders' door, the same as its registration's page.
  function orderDone(d) {
    if (d.error) { toast(esc(d.error), "error"); return; }
    toast(esc(d.note || "done")); load();
  }
  // A Stop on one lease (#324, #334): that task fenced, and only it — the dispatcher stops it and it goes back to the queue.
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-stop]") : null;
    if (!b || b.disabled || !H) return;
    var task = Number(b.getAttribute("data-stop"));
    ask({ title: "Stop task #" + task + " on " + H.name, text: "Only this task is fenced: its lease is refused from now on, the dispatcher stops it, and it goes back to the queue. The host's other tasks run on.", input: "optional", confirm: "Stop it", danger: true }).then(function (r) {
      if (r === null) return;
      api("POST", REG_API + encodeURIComponent(H.worker || "") + "/orders", { kind: "stop-task", task: task, reason: r || undefined }).then(orderDone).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    });
  });
  // A diagnostics order's lines (#325), read in place: its owner's and the maintainers'.
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-diag]") : null;
    if (!b || b.disabled) return;
    api("GET", BASE + "/diagnostics/" + encodeURIComponent(b.getAttribute("data-diag"))).then(function (d) {
      if (d.error) { toast(esc(d.error), "error"); return; }
      $("#hp-diag").textContent = "# " + d.order + ", " + d.at + (d.dropped ? " — " + d.dropped + " line(s) left out: they looked like a secret" : "") + "\n" + (d.lines || []).join("\n");
    }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
  });
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
    } else if (act === "cap") {
      // Lowered below what it holds, nothing running ends: it claims nothing until its leases fit.
      var opts = capOptions(H);
      ask({ title: "The pool's cap on " + H.name, text: "The pool hands it at most this many units, whatever its envelope says. Lowered below what it runs, nothing running ends: it claims nothing until its tasks fit.", select: { label: "Units", options: opts }, input: "required", confirm: "Set the cap" }).then(function (r) {
        if (r === null) return;
        api("POST", BASE + "/cap", { units: r.pick === "" ? null : Number(r.pick), reason: r.note }).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    } else if (act === "retire") {
      ask({ title: "Retire " + H.name, text: "Its key and its worker token are burnt for good; its running tasks end with their lease. A new install on the machine enrolls a new host.", held: PK.retire ? "Your passkey confirms it." : "", input: "required", confirm: "Retire", first: PK.retire ? "Register a passkey and retire" : "", nothing: "Nothing was retired.", danger: true }).then(function (r) {
        if (r === null) return;
        var post = function (a) { return api("POST", BASE + "/retire", a ? { reason: r, assertion: a } : { reason: r }); };
        (PK.retire ? passkeyed("host:retire:" + ID, post) : post(null)).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    } else if (act === "reconcile" && VIA === "update") {
      // An agent that takes no host order (#324): an Update of its registration reconciles it, its agent taking it at its next poll.
      api("POST", REG_API + encodeURIComponent(H.worker || "") + "/orders", { kind: "update", reason: "Reconcile now, from the host page" }).then(orderDone).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    } else if (act === "reconcile") {
      api("POST", BASE + "/orders", { kind: "reconcile-now" }).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    } else if (act === "drain") {
      ask({ title: "Drain " + H.name, text: "Its registration is handed nothing from its next claim; its running tasks finish. " + (isOwner(H.owner) ? "Drained by you, its owner, only you resume it." : "Its owner, or you, resume it."), input: "required", confirm: "Drain" }).then(function (r) {
        if (r === null) return;
        api("POST", REG_API + encodeURIComponent(H.worker || "") + "/orders", { kind: "drain", reason: r }).then(orderDone).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    } else if (act === "undrain") {
      api("POST", REG_API + encodeURIComponent(H.worker || "") + "/orders", { kind: "resume" }).then(orderDone).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    } else if (act === "set-units") {
      var u = $("#hp-units") ? $("#hp-units").value : "";
      api("POST", BASE + "/orders", { kind: "set-units", units: u === "" ? null : Number(u) }).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    } else if (act === "set-emulate") {
      var on = [].slice.call(document.querySelectorAll("#hp-settings-ops input[data-lane]")).filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute("data-lane"); });
      api("POST", BASE + "/orders", { kind: "set-emulate", emulate: on }).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    } else if (act === "retry-release") {
      api("POST", BASE + "/orders", { kind: "retry-release" }).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    } else if (act === "rotate-token") {
      ask({ title: "Rotate the worker token of " + H.name, text: "Its agent fetches a new worker token and recreates its dispatcher with it; the one it replaces works ten more minutes. Its running tasks never notice.", confirm: "Rotate token" }).then(function (go) {
        if (go === null) return;
        api("POST", BASE + "/orders", { kind: "rotate-token" }).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    } else if (act === "diagnostics") {
      api("POST", BASE + "/orders", { kind: "diagnostics" }).then(done).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    } else if (act === "pin") {
      // Make a pin (#328): any of your passkeys signs a document naming this host and this page; the host checks it when you paste it there.
      signDoc({ act: "pin-passkey" }, function (doc, a) { return api("POST", BASE + "/owner/pin", { doc: doc, assertion: a }); }).then(function (d) {
        if (d.error) { toast(esc(d.error), "error"); return; }
        var p = $("#hp-pin"); p.hidden = false; p.textContent = d.command;
        ask({ title: "Paste this at " + H.name, text: "As the agent's user at the host, before " + esc(d.not_after) + ". The agent checks it there and keeps this passkey's public key: from then on it takes a widening of its envelope and its agent keys only when this passkey signed them.", value: d.command, copy: "Copy the command", confirm: "Done", sticky: true });
      }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
    } else if (act === "seal-key") {
      var sk = H.seal || {};
      ask({ title: "Confirm the seal key of " + H.name, text: "At the host, <code>omarchy-agent status</code> prints its seal key: it must be <code>" + esc(sk.fingerprint || "?") + "</code>. Your agent keys are sealed to this key in your browser, and only the host opens them.", held: "Your passkey confirms it.", confirm: "It is the same: confirm", nothing: "Nothing was confirmed." }).then(function (go) {
        if (go === null) return;
        passkeyed("host:seal-key:" + ID, function (a) { return api("POST", BASE + "/seal-key", { key: sk.key, assertion: a }); }).then(function (d) { if (!d.error) keepSeal(ID, sk.key); done(d); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    } else if (act === "widen") {
      widenForm();
    } else if (act === "widen-send") {
      var asked = widenAsked(), env0 = ((H.owner_control || {}).envelope) || {}, keys0 = Object.keys(asked);
      if (!keys0.length) { toast("Nothing to change: the form says what its envelope says."); return; }
      ask({ title: "Widen the envelope of " + H.name, text: "Its agent sets, in agent.toml at the host: " + keys0.map(function (k) { return "<code>" + esc(k) + "</code> " + esc(envText(envWas(env0, k))) + " → " + esc(envText(asked[k])); }).join(", ") + ". Units never rise above what the release's signed constants and its detected hardware give." + ("emulate" in asked ? " An emulated lane its detection never smoke-tested comes on at its next count, which the loop does not run on its own on Linux: there it takes <code>omarchy-agent capacity --write</code> at the host (on a Mac, the next start of its VM counts it)." : ""), held: "The passkey pinned at the host signs it.", confirm: "Sign with your passkey" }).then(function (go) {
        if (go === null) return;
        signDoc({ act: "widen-envelope", envelope: asked }, function (doc, a) { return api("POST", BASE + "/orders", { kind: "widen-envelope", doc: doc, assertion: a }); }).then(function (d) { if (!d.error) $("#hp-owner-form").innerHTML = ""; done(d); }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
      });
    } else if (act === "agent-keys") {
      keysForm();
    } else if (act === "keys-send") {
      var name = $("#hp-owner-form [data-key-name]").value, input = $("#hp-owner-form [data-key-value]"), remove = $("#hp-owner-form [data-key-remove]").value === "remove";
      var to = (H.seal || {}).key, fp = (H.seal || {}).fingerprint;
      // Sealed only to the key this browser confirmed, or its owner compares it here first: never to the pool's record's alone.
      sealCompared(to, fp).then(function (same) {
        if (!same) return null;
        return remove ? { name: name, remove: true } : sealAgentKey(to, ID, name, input.value);
      }).then(function (k) {
        if (!k) return;
        // The value is gone from the page once it is sealed: only its ciphertext is left to send.
        input.value = "";
        return ask({ title: (remove ? "Take " : "Set ") + name + (remove ? " out of " : " on ") + H.name, text: remove ? "Its agent takes it out of agent.env at the host." : "Sealed in this browser to its seal key " + esc((H.seal || {}).fingerprint || "") + ": the pool relays only ciphertext, and its agent writes it to agent.env alone, which only agent sidecars read.", held: "The passkey pinned at the host signs it.", confirm: "Sign with your passkey" }).then(function (go) {
          if (go === null) return;
          return signDoc({ act: "set-agent-keys", keys: [k] }, function (doc, a) { return api("POST", BASE + "/orders", { kind: "set-agent-keys", doc: doc, assertion: a }); }).then(function (d) { if (!d.error) $("#hp-owner-form").innerHTML = ""; done(d); });
        });
      }).catch(function (e) { toast("failed: " + esc(errorText(e)), "error"); });
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
    description: "One maintainer host of the pool: its status and whether it sleeps, its capacity and units, its lanes, isolation level and sandbox, the release it applied, its settings inside its envelope, its host orders, its legacy set and its leases.",
    active: "factory",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
    kit: true,
    css: CSS,
  });
}

/** What /hosts/:id is made of (#321, #324): one read, which answers the details — the leases among them — to the owner and the maintainers only. */
export const HOST_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "host.head-facts",
    page: `/hosts/${F.host}`,
    anchor: ['<p class="op-eyebrow">Host</p>', 'id="hp-name"', 'id="hp-status"', 'id="hp-lede"', 'id="hp-stats"', 'id="hp-kv"'],
    script: ['var BASE = "/api/v1/hosts/" + encodeURIComponent(ID)', 'api("GET", BASE)', "h.fingerprint === undefined", '"Host key"', '"Isolation"', '"Sandbox"', "function sandboxWords(h)", "c.sandbox_held", "h.sandbox_applied", '"Lanes"', '"Last round"', "h.below_minimum", '"Units"', "personLink(h.owner)", "h.asleep", "h.asleep_since", "SLEEPS", '"Alive"',
      // #324: the runtime and its versions, the units busy and free, the held lanes, the owner's caps, the limits, the floor and the rollout.
      '"Runtime"', "function runtimeWords(h)", '"Versions"', "tools.compose", "tools.docker", "function unitWords(h)", "h.units_busy", "h.units_free", "h.job_reserved", "h.held_lanes", '"Owner\'s caps"', '"Limits"', "h.release_floor", '"Rollout"', "h.rollout.state"],
    reads: [
      { path: `/api/v1/hosts/${F.host}`, fields: ["host.id", "host.name", "host.owner", "host.status", "host.arches", "host.release_applied", "host.alive", "host.asleep", "host.asleep_since", "pool.version"] },
      {
        path: `/api/v1/hosts/${F.host}`, as: "maintainer",
        fields: ["host.fingerprint", "host.capacity", "host.capacity.sandbox", "host.sandbox_applied", "host.units", "host.lanes", "host.isolation", "host.dedicated", "host.hostname", "host.round", "host.below_minimum", "host.agent_version",
          "host.units_busy", "host.units_free", "host.units_effective", "host.job_reserved", "host.tasks", "host.state", "host.held_lanes", "host.limits", "host.owner_caps", "host.runtime", "host.tools.compose", "host.tools.docker", "host.release_floor", "host.rollout", "leases"],
      },
      { path: "/api/v1/hosts/h_nobody0000", status: 404 },
    ],
    visible: EVERYONE,
  },
  {
    // Its soak and the gate (#326): the soak its owner set and until when, where its registration stands at the 426 gate and why, and —
    // for anyone — the warning when its agent reports the pool behind GitHub (freeze detection).
    id: "host.soak",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-freeze"'],
    script: ["function soakWords(h)", "function gateLine(u)", '"Soak"', '"Claims"', '"GitHub"', "h.pool_behind_github", "Pool behind GitHub", 'href="/docs/runbook#a-new-maintainer-host">A new maintainer host</a>, Freeze detection', "u.required", "u.words"],
    reads: [
      { path: `/api/v1/hosts/${F.host}`, fields: ["host.pool_behind_github", "pool.deployed_at"] },
      { path: `/api/v1/hosts/${F.host}`, as: "maintainer", fields: ["host.soak", "update"] },
    ],
    visible: EVERYONE,
  },
  {
    // Stop it (#322): Suspend, Resume and Retire as GET /hosts/:id answers them for the reader — every role sees them, greyed with the door's
    // reason —; the doors refuse everyone else server-side, and a session's write without the page's own Origin for every role.
    id: "host.stop",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-operate"', 'id="hp-ops"', 'data-host-act="suspend"', 'data-host-act="resume"', 'data-host-act="retire"', 'data-host-act="drain"', 'data-host-act="undrain"', 'id="hp-stopped"', 'href="/docs/security-model#stopping-a-host"'],
    script: ["function drawOps(h, can, reg)", "can.suspend === true", "can.resume === true", "can.retire === true", 'BASE + "/suspend"', 'BASE + "/resume"', 'BASE + "/retire"', 'passkeyed("host:resume:" + ID', 'passkeyed("host:retire:" + ID', "PK.retire", "h.status_by", "h.status_reason", "h.claims_stopped_at", "NOT_LISTED",
      // #324: its registration's Drain and Resume, the worker orders' door's verdicts in the read — the owner rule's words where it says no.
      "function regOps(h, reg)", "r.can.drain === true", "r.can.resume === true", 'kind: "drain"', 'kind: "resume"', 'REG_API + encodeURIComponent(H.worker || "") + "/orders"'],
    reads: [
      { path: `/api/v1/hosts/${F.host}`, fields: ["can.suspend", "can.resume", "can.retire", "can.why", "passkey.retire", "host.status_by", "host.status_at", "host.status_reason", "host.claims_stopped_at", "registration"] },
      { path: `/api/v1/hosts/${F.host}`, as: "maintainer", fields: ["registration", "host.drained"] },
    ],
    acts: [
      { method: "POST", path: `/api/v1/hosts/${F.host}/suspend`, body: { reason: "a reason enough" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/hosts/${F.host}/resume`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/hosts/${F.host}/retire`, body: { reason: "a reason enough" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      // Drain and Resume of its registration: the worker orders' door, refused without the page's own Origin for every role.
      { method: "POST", path: `/api/v1/factory/workers/${F.worker}/orders`, body: { kind: "drain", reason: "a reason enough" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/factory/workers/${F.worker}/orders`, body: { kind: "resume" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
    ],
    visible: EVERYONE,
  },
  {
    // Host orders (#344): Reconcile now, greyed with the door's reason, and the last orders with their answers (its owner's and the
    // maintainers'). The door refuses everyone else server-side, and a session's write without the page's own Origin for every role.
    id: "host.orders",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-orders"', 'id="hp-order-ops"', 'data-host-act="reconcile"', 'id="hp-order-rows"'],
    script: ["function drawOrders(h, orders, can)", "can.reconcile === true", 'kind: "reconcile-now"', 'BASE + "/orders"', "ORDER_PILL", "o.detail", "no host order yet", "can.retry_release === true", "can.rotate_token === true", "can.diagnostics === true", 'kind: "retry-release"', 'kind: "rotate-token"', 'kind: "diagnostics"', "argText(o)", 'BASE + "/diagnostics/"', "data-diag",
      // #324: Reconcile now is an Update of its registration while its agent takes no host order.
      'can.reconcile_via === "update"', 'VIA === "update"', 'kind: "update"'],
    reads: [
      { path: `/api/v1/hosts/${F.host}`, fields: ["can.reconcile", "can.reconcile_via", "can.retry_release", "can.rotate_token", "can.diagnostics", "can.why"] },
      { path: `/api/v1/hosts/${F.host}`, as: "maintainer", fields: ["orders", "can.reconcile"] },
      // A diagnostics order's lines (#325): none for this order — its owner's and the maintainers' to read.
      { path: `/api/v1/hosts/${F.host}/diagnostics/ho_00000000000000000000000000000000`, as: "maintainer", status: 404 },
    ],
    acts: [
      { method: "POST", path: `/api/v1/hosts/${F.host}/orders`, body: { kind: "reconcile-now" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/factory/workers/${F.worker}/orders`, body: { kind: "update", reason: "a reason enough" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/hosts/${F.host}/orders`, body: { kind: "rotate-token" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/hosts/${F.host}/orders`, body: { kind: "retry-release" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/hosts/${F.host}/orders`, body: { kind: "diagnostics" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
    ],
    visible: EVERYONE,
  },
  {
    // Its settings (#325): the units and emulated lanes its agent reports, inside its envelope, greyed above it; the narrowing orders.
    // Its owner's and the maintainers' (the details); the door refuses everyone else server-side, and a session's write without the
    // page's own Origin for every role.
    id: "host.settings",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-settings"', 'id="hp-settings-kv"', 'id="hp-settings-ops"', 'href="/docs/worker-host#settings-and-host-orders"'],
    script: ["function drawSettings(h, can)", "can.settings === true", '"Units"', '"Emulated lanes"', '"Diagnostics"', '"Above its envelope"', '"Brake"', 'kind: "set-units"', 'kind: "set-emulate"', "above its envelope", "its envelope excludes it", "SETTINGS_AGENT"],
    reads: [{ path: `/api/v1/hosts/${F.host}`, as: "maintainer", fields: ["host.settings", "host.pool_settings", "host.brake", "host.quarantine", "can.settings", "can.why"] }],
    acts: [
      { method: "POST", path: `/api/v1/hosts/${F.host}/orders`, body: { kind: "set-units", units: 2 }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/hosts/${F.host}/orders`, body: { kind: "set-emulate", emulate: [] }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
    ],
    visible: ["maintainer"],
  },
  {
    // Owner control (#328): the passkey pinned at the host, its seal key, the envelope a widening starts from and the agent keys' names; Make
    // a pin, Confirm the seal key, Widen the envelope and Set agent keys — its owner's, each signed with a passkey; the keys sealed in the
    // browser by sealAgentKey, inlined. The doors refuse everyone else server-side, and a session's write without the page's own Origin.
    id: "host.owner",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-owner"', 'id="hp-owner-kv"', 'id="hp-owner-ops"', 'id="hp-owner-form"', 'id="hp-pin"', 'href="/docs/worker-host#owner-control-without-a-visit"'],
    script: ["function drawOwner(h, can)", "can.owner === true", "function signDoc(body, post)", "function docSaysWhy(body, o)", "its challenge is not the document's SHA-256", 'keepSeal(ID, sk.key)', "function sealCompared(key, fp)", "function widenAsked()", 'BASE + "/owner/challenge"', 'BASE + "/owner/pin"', 'BASE + "/seal-key"', 'kind: "widen-envelope"', 'kind: "set-agent-keys"', 'passkeyed("host:seal-key:" + ID', "async function sealAgentKey(", '"Passkey at the host"', '"Seal key"', '"Agent keys"', "OWNER_AGENT", "WIDENABLE", "AGENT_KEYS"],
    reads: [{ path: `/api/v1/hosts/${F.host}`, as: "maintainer", fields: ["host.owner", "host.owner_control", "host.seal", "can.owner", "can.why"] }],
    acts: [
      { method: "POST", path: `/api/v1/hosts/${F.host}/owner/challenge`, body: { act: "pin-passkey" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/hosts/${F.host}/owner/pin`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/hosts/${F.host}/seal-key`, body: {}, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
      { method: "POST", path: `/api/v1/hosts/${F.host}/orders`, body: { kind: "widen-envelope" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
    ],
    visible: ["maintainer"],
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
    // Its leases (#337, #324): its owner's and the maintainers' — a visitor's row says whose —, each with a Stop that fences that task
    // only, as the worker orders' door answers it for the reader (`stop`); the door refuses everyone else server-side, and a session's
    // write without the page's own Origin for every role.
    id: "host.leases",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-leases"', 'id="hp-lease-rows"', 'href="/docs/worker-host#maintainer-hosts"', "<th>Lane</th>", "<th>Units</th>", '<th aria-label="Stop"></th>', "Stop fences that task only"],
    script: ['$("#hp-lease-rows")', "no lease — nothing runs on it now", 'href="/build/', "t.lane", "t.units", "leases === undefined", "data-stop=", "st.ok === true", 'kind: "stop-task", task: task', "button[data-stop]"],
    reads: [{ path: `/api/v1/hosts/${F.host}`, as: "maintainer", fields: ["leases"] }],
    acts: [{ method: "POST", path: `/api/v1/factory/workers/${F.worker}/orders`, body: { kind: "stop-task", task: 1 }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } }],
    visible: EVERYONE,
  },
  {
    // What needs a person (#324, design v2 §18.1): its owner's and the maintainers', from its status and its last report — served
    // hidden, drawn when something does.
    id: "host.needs",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-needs"', 'id="hp-needs-list"', 'href="/docs/runbook#a-new-maintainer-host">What each one asks →</a>'],
    script: ["function drawNeeds(h)", "NEED_WORD", "h.needs_person"],
    reads: [{ path: `/api/v1/hosts/${F.host}`, as: "maintainer", fields: ["host.needs_person", "host.needs_person.0.what", "host.needs_person.0.text"] }],
    visible: ["maintainer"],
  },
  {
    // The pool's cap (#337, design v2 §7.2): what the pool hands the host at most; its owner or any maintainer sets or lifts it on the
    // site, with a reason — greyed for everyone else with the door's reason; and the large task it reserves for.
    id: "host.cap",
    page: `/hosts/${F.host}`,
    anchor: ['id="hp-cap"'],
    script: ["function capWords(h)", 'data-host-act="cap"', "can.cap === true", 'BASE + "/cap"', '"Pool cap"', '"Reserving"', "h.reserving_task"],
    reads: [
      { path: `/api/v1/hosts/${F.host}`, fields: ["can.cap"] },
      { path: `/api/v1/hosts/${F.host}`, as: "maintainer", fields: ["host.pool_cap_units", "host.reserving_task", "host.reserving_since"] },
    ],
    acts: [{ method: "POST", path: `/api/v1/hosts/${F.host}/cap`, body: { units: 3, reason: "a reason enough" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } }],
    visible: EVERYONE,
  },
];
