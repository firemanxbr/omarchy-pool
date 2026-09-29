/**
 * A worker's own page, /worker/:id (#277): what it is and where it stands,
 * what the pool does about it, and the controls a maintainer — or its
 * owner — would otherwise reach its host for. There was no per-worker page
 * before: after the v1.0.0 and v1.0.1 releases a maintainer had to SSH
 * into the Studio and restart two review workers by hand (#273), while the
 * pool knew both were not ready.
 *
 * - The head and the numbers: its state in one word (the shell's wtState),
 *   its kind, its version, its agent and whether it answers, since when its
 *   process runs on the pool's clock, what it did.
 * - What the pool does: not ready since when, the pool's own words when it
 *   does nothing (an error a restart cannot help, an unknown one, a
 *   provider's outage the breaker holds), two processes on its token, a
 *   crash loop, its watchdog's restarts, the pool that gave up.
 * - Its set: what rolls its set out, in the pool's words (#277, part 3) —
 *   its updater and the release it runs, a host timer from before #277, both
 *   at once, an updater that is not running, nothing; for a builder, which
 *   has no socket, its set's updater, not visible from the pool.
 * - Operate: Re-check agent, Restart (only if its agent is down, if asked),
 *   Restart agent service and Update — drawn for every viewer and grey with
 *   the door's own reason where the viewer may not press them (GET …/can,
 *   the predicate the door refuses with). Each asks in the dashboard's
 *   dialog with a reason for the journal, then posts the order; it reaches
 *   the worker with its next claim — an Update its set's updater, which
 *   replaces what runs an older image there within two minutes; the dialog
 *   names the project workers of its host the updater replaces too.
 * - Orders: its last ten, with who and why, the state, the pool's words for
 *   the answer, and — for its owner and the maintainers — what the worker
 *   itself said, as text; Cancel on one still waiting.
 * - Its log, for its owner and the maintainers, as on the Workers page.
 *
 * A static shell, the same for every id; the script reads the worker from
 * the address. Four reads: the worker's view and last orders (public,
 * cached ten seconds), what the viewer may press (no-store), the worker's
 * words and its log (its owner's and the maintainers'). Drawn with the v1
 * kit; its own rules are served with it alone.
 */
import { page } from "./layout";
import { lucide } from "./kit";
import { EVERYONE, type Component, type Fixture } from "./components";
import type { RunningVersion } from "../meta";

const CSS = String.raw`
  .wk { max-width: 1056px; margin: 0 auto; padding-top: 12px; display: grid; gap: 24px; }
  .wk a { text-decoration: none; } .wk a:hover { color: var(--green); }
  .wk a:focus-visible, .wk button:focus-visible, .wk summary:focus-visible { outline: 1px solid var(--green); outline-offset: 2px; }
  .wk-head { display: grid; gap: 10px; }
  .wk-title { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
  .wk-title .op-hero { overflow-wrap: anywhere; }
  .wk-id { font: 12.5px var(--font-mono); color: var(--dim); overflow-wrap: anywhere; }
  .wk-lede { margin: 0; color: var(--muted); max-width: 760px; }
  .wk-set { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; font-size: 13px; color: var(--muted); max-width: 760px; }
  .wk-set .op-label { margin: 0; }
  .wk-lines { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .wk-lines li { display: flex; gap: 10px; align-items: baseline; padding: 8px 12px; border: 1px solid var(--line); border-left-width: 3px; background: var(--panel); font-size: 13px; }
  .wk-lines li.warn { border-left-color: var(--amber); } .wk-lines li.fail { border-left-color: var(--red); } .wk-lines li.ok { border-left-color: var(--green); } .wk-lines li.info { border-left-color: var(--blue); }
  .wk-ops { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .wk-ops label { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); }
  .wk-ops label:has(input:disabled) { color: var(--dim); }
  .wk-note { margin: 12px 0 0; font-size: 12.5px; color: var(--dim); }
  .wk-rules { color: var(--dim); } .wk-rules a { color: var(--dim); }
  .wk-table { overflow-x: auto; }
  .wk-table td { font-size: 12.5px; } .wk-table td.why { min-width: 180px; max-width: 360px; overflow-wrap: anywhere; }
  .wk-said summary { cursor: pointer; color: var(--dim); font-size: 12px; } .wk-said pre { margin: 6px 0 0; padding: 8px; max-width: 420px; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg-deep); border: 1px solid var(--line); font: 11.5px/1.5 var(--font-mono); }
  .wk-log pre { margin: 0; max-height: 320px; overflow: auto; padding: 12px 16px; background: var(--bg-deep); font: 12px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .wk-empty { margin: 0; padding: 14px 16px; color: var(--dim); font-size: 13px; }
  @media (max-width: 520px) { .wk-ops .op-btn { flex: 1 1 100%; justify-content: center; } }
  /* On a phone an order is a card, its state beside its name: the table's seven columns do not fit, and the state and the answer are what the reader came for. */
  @media (max-width: 640px) {
    .wk-table thead { display: none; }
    .wk-table table, .wk-table tbody { display: block; }
    .wk-table tr { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "kind state" "at by" "why why" "answer answer" "cancel cancel"; gap: 4px 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
    .wk-table td { display: block; padding: 0; border: 0; }
    .wk-table td.why { min-width: 0; max-width: none; }
    .wk-table td.o-kind { grid-area: kind; } .wk-table td.o-state { grid-area: state; } .wk-table td.o-at { grid-area: at; color: var(--dim); } .wk-table td.o-by { grid-area: by; }
    .wk-table td.o-why { grid-area: why; } .wk-table td.o-answer { grid-area: answer; } .wk-table td.o-cancel { grid-area: cancel; }
    .wk-table td.o-cancel:empty { display: none; }
  }
`;

const BODY = String.raw`
  <div class="wk">
    <section class="wk-head" aria-labelledby="wk-name">
      <p class="op-eyebrow">Worker</p>
      <div class="wk-title"><h1 class="op-hero" id="wk-name"><span class="skl"></span></h1><span id="wk-state"></span><span id="wk-kind"></span></div>
      <p class="wk-id" id="wk-id"></p>
      <p class="wk-lede" id="wk-lede"></p>
      <p class="wk-set"><span class="op-label">Its set</span><span id="wk-set"></span></p>
    </section>

    <div class="op-stats" id="wk-stats"></div>

    <ul class="wk-lines" id="wk-lines" aria-label="What the pool sees and does"></ul>

    <section class="op-card" id="wk-operate" aria-labelledby="wk-operate-h">
      <div class="op-card-h"><b id="wk-operate-h">Operate</b><small>an order rides the answer to its own claim — nothing reaches into its host</small></div>
      <div class="op-card-b">
        <div class="wk-ops" id="wk-ops">
          <button type="button" class="op-btn" data-order="recheck-agent" disabled>${lucide("activity", 14)}Re-check agent</button>
          <button type="button" class="op-btn danger" data-order="restart" disabled>${lucide("refresh-cw", 14)}Restart</button>
          <label><input type="checkbox" id="wk-unless" disabled> only if its agent is down</label>
          <button type="button" class="op-btn danger" data-order="restart-agent" disabled>${lucide("plug", 14)}Restart agent service</button>
          <button type="button" class="op-btn" data-order="update" disabled>${lucide("download", 14)}Update</button>
        </div>
        <p class="wk-note" id="wk-note"></p>
      </div>
      <div class="op-card-f"><span class="wk-rules" id="wk-rules"></span><a href="/docs/workers#orders">How orders work →</a></div>
    </section>

    <section class="op-card" id="wk-orders" aria-labelledby="wk-orders-h">
      <div class="op-card-h"><b id="wk-orders-h">Orders</b><small>the last ten, newest first — each on the journal with who and why</small></div>
      <div class="wk-table"><table class="op-table"><thead><tr><th>When</th><th>Order</th><th>By</th><th>Why</th><th>State</th><th>The answer</th><th></th></tr></thead><tbody id="wk-orders-rows"></tbody></table></div>
      <div class="op-card-f"><a href="/status#journal">The journal →</a></div>
    </section>

    <section class="op-card wk-log" id="wk-log" aria-labelledby="wk-log-h">
      <div class="op-card-h"><b id="wk-log-h">Its log</b><small id="wk-log-at">the lines between tasks, as it sent them with its claims</small></div>
      <div id="wk-log-body"><p class="wk-empty">its owner's and the maintainers' to read</p></div>
    </section>
  </div>
`;

const SCRIPT = String.raw`
  // The worker this page is about: the address's last segment (the router serves the same shell for every id).
  var ID = decodeURIComponent(location.pathname.replace(/^\/worker\//, ""));
  var BASE = "/api/v1/factory/workers/" + encodeURIComponent(ID);
  var W = null, ORDERS = [], RULES = null, BREAKER = null, SITE_WORD = null, CAN = null, SAID = {}, TIMER = null;
  // "Only if its agent is down", as the viewer left it: the page's refresh redraws the buttons every 10 or 30 s, and must not untick it.
  // While a dialog asks, the buttons are not redrawn at all: what the dialog says is what is posted.
  var UNLESS = false, ASKING = false;
  // The pool's own orders name it pool:project or pool:community (no login can): the page says "the pool".
  function byPool(by) { return /^pool:/.test(String(by || "")); }
  // The kinds as the page and its dialogs name them.
  var LABEL = { "recheck-agent": "Re-check agent", restart: "Restart", "restart-agent": "Restart agent service", drain: "Drain", resume: "Resume", update: "Update", "stop-task": "Stop its task" };
  var RIGHT = { "recheck-agent": "recheck", restart: "restart", "restart-agent": "restart_agent", update: "update" };
  var STATE_PILL = { pending: ["wait", "waiting"], delivered: ["run", "delivered"], done: ["ok", "done"], refused: ["warn", "refused"], failed: ["fail", "failed"], expired: ["na", "expired"], cancelled: ["na", "cancelled"] };
  // A worker's state (the shell's wtState) as the kit's pill.
  var PILL = { idle: "ok", building: "run", "not ready": "fail", outdated: "warn", drained: "warn", offline: "na", revoked: "na" };
  function when(iso) { return iso ? '<span title="' + esc(iso) + '">' + esc(ago(iso)) + '</span>' : '<span class="muted">—</span>'; }
  function stat(k, n, s, title) { return '<div class="op-stat"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="k">' + esc(k) + '</span><span class="n">' + n + '</span><span class="s">' + (s || "") + '</span></div>'; }

  function load() {
    api("GET", BASE).then(function (d) {
      if (d.__status === 404) { $("#wk-name").textContent = ID; $("#wk-lede").textContent = "no such worker: it was never registered, or its registration is gone"; endSkeleton(); return; }
      W = d.worker; ORDERS = d.orders || []; RULES = d.rules; BREAKER = d.breaker; SITE_WORD = d.site_word || null;
      draw(); schedule();
    }).catch(function (e) { noAnswer("worker", e, "#wk-lede"); schedule(); });
    loadCan();
  }
  // What this viewer may press: the door's own verdicts; the worker's words and its log only where can.details says the viewer reads them.
  function loadCan() {
    api("GET", BASE + "/can").then(function (c) {
      CAN = c; drawOperate();
      if (c.details) {
        api("GET", BASE + "/orders").then(function (p) { SAID = {}; (p.orders || []).forEach(function (o) { SAID[o.id] = o.worker_detail; }); drawOrders(); }).catch(function () {});
        loadLog();
      } else drawLog(null, "the worker's log is its owner's and the maintainers' to read");
    }).catch(function (e) { $("#wk-note").textContent = "what you may press did not answer: " + errorText(e); });
  }
  // Every ten seconds while an order is open, every thirty otherwise, and nothing while the tab is hidden.
  function schedule() { clearTimeout(TIMER); TIMER = setTimeout(function () { if (!document.hidden) load(); else schedule(); }, W && W.open_orders && W.open_orders.length ? 10000 : 30000); }

  function draw() {
    var w = W, st = wtState(w), kind = wtKind(w);
    document.title = String(w.id) + " · Worker · omarchy-pool";
    $("#wk-name").innerHTML = workerName(w);
    $("#wk-state").innerHTML = '<span class="op-pill ' + (PILL[st] || "na") + '">' + esc(st) + '</span>';
    $("#wk-kind").innerHTML = '<span class="op-chip">' + esc(kind === "community" ? (w.mode === "shared" ? "contributor's · shared" : "contributor's · own packages") : kind) + '</span>';
    $("#wk-id").textContent = w.id;
    // What rolls its set out, in the pool's words (#277): its updater, a host timer from before #277, both, one that is not running, nothing.
    $("#wk-set").textContent = w.set_line || "—";
    var emu = w.labels && w.labels.emulated ? "emulated" : "native";
    $("#wk-lede").innerHTML = (kind === "community" ? "A contributor's builder" : kind === "review" ? "The project's review worker" : "The project's pool worker") + " (" + esc(w.arch) + ", " + emu + ")" + (w.owner ? ", kept by " + personLink(w.owner) : "") + (w.labels && w.labels.where ? ", on " + esc(w.labels.where) : "") + ".";
    var agent = w.agent ? (w.agent_status === "ok" ? "answers" : w.agent_status === "error" ? "does not answer" : "not probed yet") : "no agent";
    var up = w.up_since ? ago(w.up_since).replace(" ago", "") : "—";
    // A builder runs one task per container: its uptime is its container's, with its last task — a new process per task is not a restart.
    var builder = kind === "community" && w.agent_via === "broker";
    $("#wk-stats").innerHTML = [
      stat("Status", esc(st), w.last_seen ? "seen " + esc(ago(w.last_seen)) : ""),
      stat("Version", w.version ? esc(w.version) : "—", w.update && w.update.outdated ? "the pool is at " + esc(w.update.latest) : w.version ? "the latest" : ""),
      stat("Agent", w.agent ? esc(String(w.agent).split("/").slice(1).join("/") || w.agent) : "—", esc(agent), w.agent_error ? w.agent_error : ""),
      stat(builder ? "This container since" : "Up since", esc(up), builder && w.last_task ? "its last task #" + esc(w.last_task.id) : w.restarts_left !== null && w.restarts_left !== undefined ? "restart policy on-failure: " + esc(w.restarts_left) + " left" : w.started_at ? "started " + esc(ago(w.started_at)) + " by its own clock" : "", w.started_at ? "its own clock says it started at " + w.started_at : ""),
      stat("Done / failed", num(w.builds_done || 0) + " / " + num(w.builds_failed || 0), w.last_task ? "last: " + esc(w.last_task.name) + " " + esc(ago(w.last_task.at)) : "")
    ].join("");
    drawLines(); drawOperate(); drawOrders(); endSkeleton();
  }
  // What the pool sees and does about it, a line each (#277): only what is true now.
  function drawLines() {
    var w = W, L = [];
    if (w.revoked_at) L.push(["na", "Revoked " + ago(w.revoked_at) + ": it can never claim again."]);
    else if (!w.alive) L.push(["warn", "Offline: not seen in " + WORKER_ALIVE_MINUTES + " minutes. An order waits up to " + (RULES ? Math.round(RULES.ttl_person_min / 60) : 6) + " h for it."]);
    if (w.drained) L.push(["warn", "Drained by " + (w.drained.by || "?") + " " + ago(w.drained.at) + (w.drained.reason ? ": " + w.drained.reason : "") + " — handed nothing until it is resumed."]);
    if (w.alive && w.agent_status === "error") L.push(["fail", "Not ready" + (w.not_ready_since ? " since " + ago(w.not_ready_since).replace(" ago", "") + " ago" : "") + ": " + wtNotReady(w) + "."]);
    if (BREAKER) L.push(["warn", "Provider outage suspected since " + ago(BREAKER.since) + " (up to " + BREAKER.peak + " " + BREAKER.provider + " sites " + (BREAKER.scope === "project" ? "of the project's own " : "") + "with an open agent error at once): the pool restarts none of this provider's " + (BREAKER.scope === "project" ? "project workers" : "contributors' workers") + " until fewer than 2 sites have had one for 15 min."]);
    if (SITE_WORD) L.push(["info", SITE_WORD.charAt(0).toUpperCase() + SITE_WORD.slice(1) + "."]);
    if (w.pool_waits) L.push(["info", w.pool_waits.charAt(0).toUpperCase() + w.pool_waits.slice(1) + "."]);
    if (w.pool_gave_up) L.push(["warn", "The pool gave up " + ago(w.pool_gave_up) + " after its restarts in this spell: a person looks — its log below has why."]);
    if (w.two_processes_since) L.push(["warn", "Two processes share this token since " + ago(w.two_processes_since) + " — orders are held; revoke it if you did not start two."]);
    if (w.crash_loop_since) L.push(["warn", "A new process every few minutes since " + ago(w.crash_loop_since) + " (none finished a task, none explained) — it may be crash-looping; its log has why."]);
    if (w.watchdog && w.watchdog.n) L.push(["warn", "Restarted by its watchdog " + w.watchdog.n + " time" + (w.watchdog.n === 1 ? "" : "s") + " since " + ago(w.watchdog.since) + (w.watchdog.stuck_in ? " (stuck in " + (w.watchdog.stuck_in === "task" ? "a task" : "its " + w.watchdog.stuck_in) + ")" : "") + " — its log has why."]);
    // An Update is never the worker's to take (#277): its set's updater carries it out, and the worker's claim on the pool's release closes it.
    (w.open_orders || []).forEach(function (o) { L.push(["info", LABEL[o.kind] + " " + (o.kind === "update" ? "waiting for its set's updater — it replaces what runs an older image there within 2 min, and the order closes when this worker claims on the pool's release" : o.state === "delivered" ? "on its way: the worker has it" : "waiting for its next claim") + " — ordered by " + (byPool(o.by) ? "the pool" : o.by) + " " + ago(o.at) + "."]); });
    if (w.takes_orders === null && !w.revoked_at) L.push(["info", "Its image (" + (w.version || "unknown") + ") takes no orders: its host's updater replaces it with one that does."]);
    $("#wk-lines").innerHTML = L.map(function (x) { return '<li class="' + x[0] + '">' + esc(x[1]) + '</li>'; }).join("");
  }
  // The three buttons, drawn for everyone, each grey with the door's own reason where this viewer may not press it (the shell's gate()).
  function drawOperate() {
    if (RULES) $("#wk-rules").textContent = RULES.on ? "The pool re-checks a worker whose own re-check has stalled, then restarts it only if its agent still does not answer — at most " + RULES.max_pool_restarts_per_spell + " times a spell, " + RULES.max_pool_restarts_per_day + " a day, never a process under " + Math.round(RULES.min_uptime_s / 60) + " min old." : "The pool's own orders are off (WORKER_RULES); people's still work.";
    if (!CAN || ASKING) return;
    var html = [
      gate('<button type="button" class="op-btn" data-order="recheck-agent">' + lucide("activity", 14) + 'Re-check agent</button>', CAN.can.recheck, CAN.why.recheck),
      gate('<button type="button" class="op-btn danger" data-order="restart">' + lucide("refresh-cw", 14) + 'Restart</button>', CAN.can.restart, CAN.why.restart),
      gate('<label><input type="checkbox" id="wk-unless"' + (UNLESS ? " checked" : "") + '> only if its agent is down</label>', CAN.can.restart, CAN.why.restart),
      gate('<button type="button" class="op-btn danger" data-order="restart-agent">' + lucide("plug", 14) + 'Restart agent service</button>', CAN.can.restart_agent, CAN.why.restart_agent),
      gate('<button type="button" class="op-btn" data-order="update">' + lucide("download", 14) + 'Update</button>', CAN.can.update, CAN.why.update)
    ];
    $("#wk-ops").innerHTML = html.join("");
    $("#wk-note").textContent = CAN.note || "";
  }
  // A list as a sentence says it: "a", "a and b", "a, b and c".
  function andList(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
  // The dialog's words: what happens, whom it touches — the other workers of its host that call the same agent service, or that its set's updater replaces too, by name (the site's own read), never a number typed.
  // "Only if its agent is down" is read once, when the button is pressed: the dialog says it, and the order carries it.
  function askOrder(kind) {
    var name = W ? W.id : ID, shared = (CAN && CAN.shared_agent_with) || [], sameSet = (CAN && CAN.update_with) || [];
    var unless = kind === "restart" && UNLESS;
    var text = kind === "recheck-agent" ? "It asks its agent now instead of at its next scheduled check. The answer is on its row with its next claim."
      : kind === "restart" ? "It finishes the task in hand, then exits; its restart policy starts it again, and the pool checks that it came back." + (unless ? " Only if its agent is down: it probes first, and stays up if the agent answers." : "")
      // Update (#277): what the pool can see of the set, and the rest without a number — the pool does not know a set's builders, brokers or agent service, nor a host's profiles.
      // A builder's set is not visible from the pool: its note says what else may replace it, and when the order gives up.
      : kind === "update" ? (sameSet.length
          ? "Within 2 min, its set's updater replaces every service there that runs an older image: the project workers " + andList([name].concat(sameSet).sort()) + " (as the pool sees them on this host), and the set's builders, brokers and agent service."
          : "Within 2 min, its set's updater replaces " + name + " and whatever else its set runs, when it runs an older image.") + " A worker that is building finishes first (up to 3 h)." + (W && wtKind(W) === "community" && CAN && CAN.update_note ? " " + CAN.update_note.charAt(0).toUpperCase() + CAN.update_note.slice(1) + "." : "")
      : "It restarts the agent service it calls on its own host, waits for it to answer, and says how it went." + (shared.length ? " " + shared.join(", ") + (shared.length === 1 ? " also calls it" : " also call it") + "; a completion in flight fails and is retried." : "");
    ASKING = true;
    var done = function () { ASKING = false; drawOperate(); };
    return ask({ title: LABEL[kind] + " " + name + "?", text: esc(text), input: "optional", placeholder: "why — it goes on the journal (optional)", confirm: LABEL[kind], danger: kind !== "recheck-agent" && kind !== "update" }).then(function (reason) {
      done();
      if (reason === null) return;
      var body = { kind: kind }; if (reason) body.reason = reason;
      if (unless) body.unless_agent_ok = true;
      return api("POST", BASE + "/orders", body).then(function (d) {
        if (d.error) { toast(esc(d.error), "error"); return; }
        toast(esc(LABEL[kind] + " ordered — " + d.note)); load();
      });
    }, function (e) { done(); throw e; }).catch(function (e) { toast("the order did not go: " + esc(errorText(e)), "error"); });
  }
  document.addEventListener("change", function (ev) { if (ev.target && ev.target.id === "wk-unless") UNLESS = !!ev.target.checked; });
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-order]") : null;
    if (b && !b.disabled) { askOrder(b.getAttribute("data-order")); return; }
    var c = ev.target.closest ? ev.target.closest("button[data-cancel]") : null;
    if (c && !c.disabled) {
      c.disabled = true;
      api("DELETE", BASE + "/orders/" + encodeURIComponent(c.getAttribute("data-cancel"))).then(function (d) { if (d.error) { toast(esc(d.error), "error"); c.disabled = false; } else { toast("cancelled"); load(); } }, function (e) { c.disabled = false; toast(esc(errorText(e)), "error"); });
    }
  });
  // The last orders: who (the pool, with its rule on hover), why, the state, the pool's sentence for the answer, and — for its owner and the maintainers — the worker's own words, as text; Cancel on one still waiting.
  function drawOrders() {
    var rows = ORDERS.map(function (o) {
      var p = STATE_PILL[o.state] || ["na", o.state], said = SAID[o.id];
      var by = byPool(o.issued_by) ? '<span title="' + esc("the pool's rule: " + (o.rule || "?")) + '">the pool</span>' : personLink(o.issued_by);
      var state = '<span class="op-pill ' + p[0] + '">' + esc(o.state === "delivered" && o.accepted_at ? "on its way" : p[1]) + '</span>';
      var answer = (o.detail ? esc(o.detail) : '<span class="muted">—</span>') + (said ? '<details class="wk-said"><summary>what the worker said</summary><pre></pre></details>' : '');
      var cancel = o.state === "pending" ? gate('<button type="button" class="op-chip" data-cancel="' + esc(o.id) + '">Cancel</button>', CAN ? CAN.can.cancel : false, CAN ? CAN.why.cancel || "" : "sign in with GitHub") : "";
      return '<tr data-id="' + esc(o.id) + '"><td class="o-at">' + when(o.issued_at) + '</td><td class="o-kind">' + esc(LABEL[o.kind] || o.kind) + (o.unless_agent_ok ? ' <span class="muted" title="only if its agent is down">· if down</span>' : '') + '</td><td class="o-by">' + by + '</td><td class="why o-why">' + esc(o.reason) + '</td><td class="o-state">' + state + '</td><td class="why o-answer">' + answer + '</td><td class="o-cancel">' + cancel + '</td></tr>';
    });
    $("#wk-orders-rows").innerHTML = rows.join("") || '<tr><td colspan="7" class="muted">no order yet — the pool orders a worker whose agent does not answer; its owner and the maintainers do, from here</td></tr>';
    // The worker's words as text, never as markup.
    ORDERS.forEach(function (o) { if (!SAID[o.id]) return; var pre = document.querySelector('tr[data-id="' + o.id + '"] .wk-said pre'); if (pre) pre.textContent = SAID[o.id]; });
  }
  function loadLog() { fetch(BASE + "/log", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) { drawLog(d, d.error); }).catch(function () { drawLog(null, "the log did not answer"); }); }
  function drawLog(d, why) {
    if (!d || why) { $("#wk-log-body").innerHTML = '<p class="wk-empty">' + esc(why || "nothing sent yet") + '</p>'; return; }
    $("#wk-log-at").textContent = d.at ? "last line " + ago(d.at) : "nothing sent yet — the log arrives with each claim";
    $("#wk-log-body").innerHTML = '<pre></pre>';
    var pre = $("#wk-log-body pre"); pre.textContent = d.log || ""; pre.scrollTop = pre.scrollHeight;
  }
  whoami(function () { load(); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
`;

export function workerHtml(id: string, poolUrl: string, version: RunningVersion): string {
  return page({
    path: `/worker/${id}`,
    title: "Worker · omarchy-pool",
    description: "One worker of the pool: its state, what rolls its set out, what the pool does about it, its orders and its log — and, for its owner and the maintainers, Re-check agent, Restart, Restart agent service and Update.",
    active: "factory",
    body: BODY,
    script: SCRIPT,
    poolUrl,
    version,
    kit: true,
    css: CSS,
  });
}

/**
 * What /worker/:id is made of (#277): the worker's public read, what the
 * viewer may press, the worker's own words and its log for its owner and
 * the maintainers, and two acts — an order, and the cancel of one still
 * waiting. The fixture's community worker (alice's) and project worker
 * (m1's) are the ids; alice's declares the orders it takes. A session's
 * write needs the page's own Origin, which the test's request does not
 * carry: every role but nobody's is refused before anything is written.
 */
export const WORKER_COMPONENTS = (F: Fixture): Component[] => [
  {
    id: "worker.head-stats",
    page: `/worker/${F.communityWorker}`,
    anchor: ['<p class="op-eyebrow">Worker</p>', 'id="wk-name"', 'id="wk-state"', 'id="wk-kind"', 'id="wk-lede"', 'id="wk-stats"', '<p class="wk-set"><span class="op-label">Its set</span><span id="wk-set"></span></p>'],
    script: ['var BASE = "/api/v1/factory/workers/" + encodeURIComponent(ID)', 'api("GET", BASE)', "wtState(w)", "wtKind(w)", "workerName(w)", '"This container since"', '"Up since"', "w.restarts_left", "w.up_since", "w.started_at", '"Done / failed"', '$("#wk-set").textContent = w.set_line || "—";'],
    reads: [
      { path: `/api/v1/factory/workers/${F.communityWorker}`, fields: ["worker.id", "worker.owner", "worker.arch", "worker.alive", "worker.ready", "worker.agent", "worker.agent_status", "worker.version", "worker.update", "worker.up_since", "worker.started_at", "worker.takes_orders", "worker.open_orders", "worker.builds_done", "worker.builds_failed", "worker.last_task", "worker.set_rollout", "worker.set_line", "orders", "rules.on", "rules.max_pool_restarts_per_spell", "rules.min_uptime_s", "breaker"] },
      { path: "/api/v1/factory/workers/nobody-here", status: 404 },
    ],
    visible: EVERYONE,
  },
  {
    id: "worker.lines",
    page: `/worker/${F.worker}`,
    anchor: ['<ul class="wk-lines" id="wk-lines" aria-label="What the pool sees and does"></ul>'],
    script: ["function drawLines()", '"waiting for its set\'s updater — it replaces what runs an older image there within 2 min, and the order closes when this worker claims on the pool\'s release"', "w.not_ready_since", "w.pool_waits", "w.pool_gave_up", "w.two_processes_since", "w.crash_loop_since", "w.watchdog.n", '"Provider outage suspected since "', "BREAKER.scope", "if (SITE_WORD)", "w.takes_orders === null", "byPool(o.by)"],
    reads: [{ path: `/api/v1/factory/workers/${F.worker}`, fields: ["worker.not_ready_since", "worker.pool_waits", "worker.pool_gave_up", "worker.two_processes_since", "worker.crash_loop_since", "worker.watchdog", "worker.drained", "breaker", "site_word"] }],
    visible: EVERYONE,
  },
  {
    id: "worker.operate",
    page: `/worker/${F.communityWorker}`,
    anchor: ['id="wk-operate"', "<b id=\"wk-operate-h\">Operate</b>", 'data-order="recheck-agent"', 'data-order="restart"', 'data-order="restart-agent"', 'data-order="update"', 'id="wk-unless"', 'href="/docs/workers#orders"'],
    script: ['api("GET", BASE + "/can")', "CAN.can.recheck", "CAN.can.restart", "CAN.can.restart_agent", "CAN.can.update", "gate('<button", "function askOrder(kind)", 'api("POST", BASE + "/orders", body)', "body.unless_agent_ok = true", "CAN.shared_agent_with",
      // Update's dialog names what the pool sees of the set — this worker and the project workers of its host — and the rest without a number (#277, P10).
      "CAN.update_with", "andList([name].concat(sameSet).sort())", "(as the pool sees them on this host), and the set's builders, brokers and agent service.", '" and whatever else its set runs, when it runs an older image."', 'wtKind(W) === "community" && CAN && CAN.update_note',
      // The checkbox survives the page's refresh, and a dialog that asks is never redrawn under the person: what it says is what is posted.
      "var UNLESS = false, ASKING = false", "(UNLESS ? \" checked\" : \"\")", "if (!CAN || ASKING) return;", 'var unless = kind === "restart" && UNLESS;', "if (unless) body.unless_agent_ok = true;"],
    reads: [
      { path: `/api/v1/factory/workers/${F.communityWorker}/can`, fields: ["can.recheck", "can.restart", "can.restart_agent", "can.update", "can.cancel", "why", "why.update", "details", "shared_agent_with", "update_with", "update_note", "note"] },
      { path: `/api/v1/factory/workers/${F.communityWorker}/can`, as: "owner", fields: ["can.recheck", "details"] },
      { path: `/api/v1/factory/workers/${F.communityWorker}/can`, as: "maintainer", fields: ["can.restart", "details"] },
    ],
    acts: [
      { method: "POST", path: `/api/v1/factory/workers/${F.communityWorker}/orders`, body: { kind: "recheck-agent" }, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
    ],
    visible: EVERYONE,
  },
  {
    id: "worker.orders",
    page: `/worker/${F.communityWorker}`,
    anchor: ['id="wk-orders"', 'id="wk-orders-rows"', 'href="/status#journal">The journal →</a>'],
    script: ["function drawOrders()", 'api("GET", BASE + "/orders")', "SAID[o.id]", "pre.textContent = SAID[o.id]", 'data-cancel="', 'api("DELETE", BASE + "/orders/" + encodeURIComponent(', "o.accepted_at", "o.detail"],
    reads: [
      { path: `/api/v1/factory/workers/${F.communityWorker}/orders`, status: 401 },
      { path: `/api/v1/factory/workers/${F.communityWorker}/orders`, as: "contributor", status: 403 },
      { path: `/api/v1/factory/workers/${F.communityWorker}/orders`, as: "owner", fields: ["id", "orders", "orders.0.worker_detail", "orders.0.detail", "orders.0.state"] },
      { path: `/api/v1/factory/workers/${F.communityWorker}/orders`, as: "maintainer", fields: ["orders.0.worker_detail"] },
    ],
    acts: [
      { method: "DELETE", path: `/api/v1/factory/workers/${F.communityWorker}/orders/wo_${"0".repeat(32)}`, expect: { anonymous: 401, contributor: 403, owner: 403, maintainer: 403 } },
    ],
    visible: EVERYONE,
  },
  {
    // The worker's own log, as on the Workers page: its owner's and the maintainers', grey for the rest with the pool's own refusal.
    id: "worker.log",
    page: `/worker/${F.communityWorker}`,
    anchor: ['id="wk-log"', 'id="wk-log-body"'],
    script: ['fetch(BASE + "/log", { cache: "no-store" })', "function drawLog(d, why)", "pre.textContent = d.log"],
    reads: [
      { path: `/api/v1/factory/workers/${F.communityWorker}/log`, as: "owner", fields: ["id", "log", "at"] },
      { path: `/api/v1/factory/workers/${F.communityWorker}/log`, as: "contributor", status: 403 },
    ],
    visible: EVERYONE,
  },
];
