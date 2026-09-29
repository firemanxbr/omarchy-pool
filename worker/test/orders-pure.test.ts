/**
 * The pure core of #277's orders (src/orders.ts), with no database: what
 * an agent's error is, what a claim says of its process, the pool's step
 * machine and its bounds, who may press what, and the pool's sentences.
 * The loop bound is a property: whatever a worker's agent does, over two
 * days of claims every 30 s, the pool restarts it at most twice per spell
 * and three times a day, and re-checks it at most once per spell — the
 * schedules drawn from a seeded generator, so a failure names its seed.
 */
import { describe, expect, it } from "vitest";
import {
  answerCode, autoOf, breakerKey, breakerOfKey, breakerScope, canonicalKinds, claimFacts, cleanText, codeSentence, decideAuto, errorClass, instanceStep, isPool, orderVerdicts, parsePreviousExit, poolFor, probeAge, rulesScale,
  siblingsAnswering, siteKey, sitesByProvider, siteVerdict, siteWords, versionWord,
  CHURN_CLEAR_MIN, CONFLICT_WINDOW_MIN, CRASH_LOOP_AT, GIVE_UP_AFTER_MIN, MAX_POOL_RECHECKS_PER_DAY, MAX_POOL_RESTARTS_PER_DAY, MAX_POOL_RESTARTS_PER_SPELL, MIN_UPTIME_S, POOL_COMMUNITY, POOL_PROJECT, RECHECK_AFTER_MIN, RESTART_AFTER_MIN, RESTART_SPACING_MIN,
  type ClaimFacts, type InstanceStep, type OrderFacts, type OrdersRow, type RuleInput, type SiteRead, type SiteWorker,
} from "../src/orders";

const MIN = 60000;
const T0 = Date.parse("2026-09-29T12:00:00.000Z");
const at = (m: number) => new Date(T0 + m * MIN).toISOString();

/** A worker's row as workerOf reads it, with what a test sets. */
const row = (o: Partial<OrdersRow> = {}): OrdersRow => ({
  id: "studio-review-aarch64", owner: "m1", trust: "project", version: "v1.0.2", kinds: '["audit","build"]', agent: "claude-code/claude-sonnet-5",
  agent_status: null, agent_error: null, agent_checked_at: null, last_seen: at(0), last_task: null, open_orders: null, order_kinds: '["drain","recheck-agent","restart","restart-agent"]',
  instance: null, instance_prev: null, instance_since: null, instance_conflict_at: null, instance_other_at: null, instance_churn: 0, instance_finished: null,
  crash_loop_since: null, watchdog_exits: null, started_at: null, agent_via: "direct", site: null, restarts_left: null, agent_error_since: null, agent_probed_at: null,
  agent_error_class: null, drained_at: null, auto_orders: null, ...o,
});
const hex = (n: number) => n.toString(16).padStart(32, "0");
const claim = (o: Partial<ClaimFacts> = {}): ClaimFacts => ({ takes: ["drain", "recheck-agent", "restart", "restart-agent"], instance: hex(1), started_at: null, agent_via: "direct", site: null, restarts_left: null, previous_exit: null, version: "v1.0.2", probe: undefined, pairRestart: false, ...o });

describe("an agent's error, by class", () => {
  it("names what a restart can help and what it cannot, from the words and where the agent is", () => {
    const table: [string, string | null, string][] = [
      ["HTTPError: HTTP Error 401: Unauthorized", "direct", "auth"],
      ["invalid x-api-key", "direct", "auth"],
      ["HTTPError: HTTP Error 402: Payment Required", "direct", "credit"],
      ["Your credit balance is too low", "direct", "credit"],
      ["claude-code: You've hit your limit · resets 3pm", "sibling", "credit"],
      ["HTTP 429: rate limit exceeded", "direct", "rate"],
      ["HTTPError: HTTP Error 529: Overloaded", "direct", "remote"],
      ["TimeoutError: The read operation timed out", "direct", "remote"],
      ["URLError: <urlopen error [Errno 111] Connection refused>", "direct", "refused"],
      ["URLError: <urlopen error [Errno 111] Connection refused>", "sibling", "refused"],
      ["ConnectionResetError: [Errno 104] Connection reset by peer", "broker", "refused"],
      ["URLError: <urlopen error [Errno -2] Name or service not known>", "sibling", "dns"],
      ["Claude Code did not install", "sibling", "install"],
      ["claude-code: no `claude` binary at /root/.local/bin/claude", "direct", "install"],
      ["HTTPError: HTTP Error 502: Bad Gateway", "sibling", "sibling"],
      ["the broker at http://broker:8790 did not answer", "broker", "sibling"],
      ["HTTPError: HTTP Error 502: Bad Gateway — upstream 529 overloaded", "sibling", "remote"],
      ["HTTPError: HTTP Error 502: Bad Gateway", "direct", "remote"],
      ["KeyError: 'content'", "direct", "unknown"],
      ["", "direct", "unknown"],
    ];
    for (const [error, via, cls] of table) expect(errorClass(error, via), `${error} via ${via}`).toBe(cls);
  });
});

describe("text a person or a worker gave", () => {
  it("is stored stripped of escapes, controls and bidi overrides, on one line, and refused when it looks like a secret", () => {
    expect(cleanText("stuck \x1b[31mred\x1b[0m\r\nsince‮ v1.0.1\x07", 300)).toBe("stuck red since v1.0.1");
    expect(cleanText("a\nb\tc", 300, { lines: true })).toBe("a\nbc");
    expect(cleanText("x".repeat(400), 300)).toHaveLength(300);
    expect(cleanText("the token is omw_" + "a".repeat(48), 300)).toBeNull();
    expect(cleanText(42, 300)).toBe("");
  });
});

describe("what a claim says of its process", () => {
  it("declares its kinds in one form whatever the order or repetition, and none when it has no orders field", () => {
    expect(canonicalKinds(["restart", "drain", "recheck-agent"])).toEqual(["drain", "recheck-agent", "restart"]);
    expect(canonicalKinds(["recheck-agent", "restart", "drain", "restart", "update", "stop-task", 7])).toEqual(["drain", "recheck-agent", "restart"]);
    expect(canonicalKinds(undefined)).toBeNull();
    expect(canonicalKinds("restart")).toBeNull();
  });

  it("takes an instance, a site and a start only in their shape; a deliberate exit only with a known reason", () => {
    const f = claimFacts({ orders: ["restart"], instance: "ABC", site: "zz", started_at: new Date(T0 + 3600e3).toISOString(), restarts_left: -1, agent_via: "nowhere" }, new Headers(), undefined, T0);
    // No valid instance: the process declares nothing, whatever its orders field says — an order is bound to the process that took it.
    expect(f).toMatchObject({ takes: null, instance: null, site: null, started_at: null, restarts_left: null, agent_via: null, pairRestart: false });
    expect(claimFacts({ orders: ["restart"] }, new Headers(), undefined, T0).takes).toBeNull();
    expect(claimFacts({ orders: ["restart"], instance: hex(3) }, new Headers(), undefined, T0).takes).toEqual(["restart"]);
    const g = claimFacts({ instance: hex(7), site: "5d0e4b1a9c7f2e36", agent_via: "broker", started_at: at(-3) }, new Headers({ "x-omarchy-broker-takes": "pair-restart" }), undefined, T0);
    expect(g).toMatchObject({ takes: null, instance: hex(7), site: "5d0e4b1a9c7f2e36", agent_via: "broker", started_at: at(-3), pairRestart: true });
    expect(parsePreviousExit({ why: "watchdog", at: at(0), stuck_in: "task", n: 2 })).toEqual({ why: "watchdog", at: at(0), stuck_in: "task", n: 2 });
    expect(parsePreviousExit({ why: "restart", stuck_in: "task", n: 9 })).toEqual({ why: "restart", at: null, stuck_in: null, n: null });
    expect(parsePreviousExit({ why: "crash" })).toBeNull();
    expect(parsePreviousExit("watchdog")).toBeNull();
  });
});

describe("the instance step", () => {
  it("writes nothing for the same process, and what a new one declares when one starts", () => {
    const r = row({ instance: hex(1), instance_since: at(0), order_kinds: '["drain","recheck-agent","restart","restart-agent"]' });
    const same = instanceStep(r, claim(), T0 + 5 * MIN);
    expect(same.set).toEqual({});
    expect(same.journal).toEqual([]);
    const next = instanceStep(r, claim({ instance: hex(2), agent_via: "sibling", site: "5d0e4b1a9c7f2e36", restarts_left: 4, started_at: at(4) }), T0 + 5 * MIN);
    // The site is kept under the name of who runs the worker: the project's, or the contributor's login.
    expect(next.set).toMatchObject({ instance: hex(2), instance_prev: hex(1), instance_since: at(5), agent_via: "sibling", site: "project/5d0e4b1a9c7f2e36", restarts_left: 4, started_at: at(4) });
    expect(next.guard).toBe(hex(1));
    expect(instanceStep(row({ trust: "community", owner: "alice", instance: hex(1) }), claim({ instance: hex(2), site: "5d0e4b1a9c7f2e36" }), T0).set.site).toBe("alice/5d0e4b1a9c7f2e36");
    // The same kinds in another order are the same words: nothing to write.
    expect(instanceStep(r, claim({ takes: canonicalKinds(["restart-agent", "restart", "drain", "recheck-agent", "restart"]) }), T0 + 6 * MIN).set).toEqual({});
    // An image from before orders after one that took them: a process of its own, which declares nothing.
    expect(instanceStep(r, claim({ instance: null, takes: null }), T0 + 20 * MIN).set).toMatchObject({ instance: null, instance_prev: hex(1), order_kinds: null });
    // And one that goes on, on a row that never knew a process: nothing to write.
    expect(instanceStep(row({ order_kinds: null }), claim({ instance: null, takes: null }), T0).set).toEqual({});
  });

  it("sees two processes on one token once, holds them, and says so again only when one is left", () => {
    let r = row({ instance: hex(2), instance_prev: hex(1), instance_since: at(0) });
    const conflict = instanceStep(r, claim({ instance: hex(1) }), T0 + 1 * MIN);
    expect(conflict.conflict).toBe(true);
    // The process that claims is recorded, and becomes the one the row names.
    expect(conflict.set).toMatchObject({ instance_conflict_at: at(1), instance_other_at: at(1), instance: hex(1), instance_prev: hex(2) });
    expect(conflict.journal.map((l) => l.status)).toEqual(["warn"]);
    expect(conflict.journal[0].summary).toContain("two processes share this worker's token");
    // The public record names a process by its first four digits, never the whole instance: a thief who read it could claim as the real one.
    expect(JSON.stringify(conflict.journal)).not.toContain(hex(1));
    expect(JSON.stringify(conflict.journal)).not.toContain(hex(2));
    r = { ...r, ...conflict.set, last_seen: at(1) } as OrdersRow;
    // Alternating claims write nothing new within TOUCH_MINUTES of the last record.
    for (const m of [1.5, 2, 2.5, 3.5]) {
      expect(instanceStep(r, claim({ instance: hex(1) }), T0 + m * MIN).set).toEqual({});
      expect(instanceStep(r, claim({ instance: hex(2) }), T0 + m * MIN).set).toEqual({});
    }
    // Past it, the other's claim is recorded, whatever the liveness write's rhythm: the row names it now.
    const swap = instanceStep({ ...r, last_seen: at(3.9) }, claim({ instance: hex(2) }), T0 + 4 * MIN);
    expect(swap).toMatchObject({ conflict: true, instance: hex(2), set: { instance: hex(2), instance_prev: hex(1), instance_other_at: at(4) } });
    expect(swap.journal).toEqual([]);
    r = { ...r, ...swap.set } as OrdersRow;
    // The one left claims alone: one process again, once, CONFLICT_WINDOW_MIN after the other's last claim could have been recorded.
    expect(instanceStep(r, claim({ instance: hex(2) }), T0 + (4 + CONFLICT_WINDOW_MIN) * MIN).conflict).toBe(true);
    const alone = instanceStep(r, claim({ instance: hex(2) }), T0 + (4 + CONFLICT_WINDOW_MIN + 3) * MIN);
    expect(alone.conflict).toBe(false);
    expect(alone.set).toMatchObject({ instance_conflict_at: null, instance_other_at: null });
    expect(alone.journal.map((l) => l.summary)).toEqual([expect.stringContaining("one process again")]);
  });

  /**
   * A worker's row under a stream of claims, written as touchWorker writes
   * it: what the step sets, or the liveness write every TOUCH_MINUTES —
   * and the lines, each only when the step wrote what it guards.
   */
  function simulate(claims: { t: number; instance: string | null }[]) {
    let r = row({ instance: hex(1), instance_since: at(-60), last_seen: at(-1) });
    let writes = 0, conflictAt: number | null = null;
    const lines: string[] = [];
    let heldFor = 0, lastT = claims[0].t;
    for (const c of claims) {
      const s: InstanceStep = instanceStep(r, claim({ instance: c.instance, takes: c.instance ? ["drain", "recheck-agent", "restart"] : null }), c.t);
      const liveness = c.t - Date.parse(r.last_seen!) >= 3 * MIN;
      if (Object.keys(s.set).length || liveness) { writes++; r = { ...r, ...s.set, last_seen: new Date(c.t).toISOString() } as OrdersRow; }
      lines.push(...s.journal.map((l) => l.summary));
      if (s.conflict) { heldFor += c.t - lastT; conflictAt ??= c.t; }
      lastT = c.t;
    }
    return { lines, writes, heldFor, conflictAt, row: r };
  }

  it("two processes claiming every 30 s with their network's jitter, a day long: one line, the conflict never lifts, the other recorded at most once per TOUCH_MINUTES", () => {
    for (let seed = 1; seed <= 15; seed++) {
      const rnd = seeded(seed);
      const rtt = [200, 400, 300][seed % 3], jitter = [50, 300, 150][seed % 3];
      const claims: { t: number; instance: string | null }[] = [];
      for (const [who, offset] of [[hex(1), 0], [hex(2), 11000]] as const) {
        let t = T0 + offset;
        while (t < T0 + 24 * 3600e3) { claims.push({ t, instance: who }); t += 30000 + rtt + Math.round((rnd() * 2 - 1) * jitter); }
      }
      claims.sort((a, b) => a.t - b.t);
      const sim = simulate(claims);
      expect(sim.lines.filter((l) => l.includes("two processes share")), `seed ${seed}`).toHaveLength(1);
      expect(sim.lines.filter((l) => l.includes("one process again")), `seed ${seed}`).toEqual([]);
      expect(sim.row.instance_conflict_at, `seed ${seed}`).not.toBeNull();
      // The day's writes: the liveness write every TOUCH_MINUTES, and the other's record at most as often besides — while two share a token.
      expect(sim.writes, `seed ${seed}`).toBeLessThanOrEqual(2 * 24 * 20 + 5);
    }
  });

  it("a second process that draws a new instance at every claim, or names none: the conflict holds while it claims, and lifts once, after it stops", () => {
    for (const other of ["rotating", "none"] as const) {
      const claims: { t: number; instance: string | null }[] = [];
      let k = 100;
      for (let t = T0; t < T0 + 2 * 3600e3; t += 30000) {
        claims.push({ t, instance: hex(1) });
        claims.push({ t: t + 7000, instance: other === "rotating" ? hex(k++) : null });
      }
      // The real one goes on alone for 20 min.
      for (let t = T0 + 2 * 3600e3; t < T0 + 2 * 3600e3 + 20 * MIN; t += 30000) claims.push({ t, instance: hex(1) });
      const sim = simulate(claims);
      expect(sim.lines.filter((l) => l.includes("two processes share")), other).toHaveLength(1);
      expect(sim.lines.filter((l) => l.includes("one process again")), other).toHaveLength(1);
      expect(sim.conflictAt! - T0, other).toBeLessThan(MIN);
      // Two hours of two processes: held all along, at most two writes every TOUCH_MINUTES (the liveness write, the other's record).
      expect(sim.heldFor, other).toBeGreaterThanOrEqual(2 * 3600e3 - 2 * MIN);
      expect(sim.writes, other).toBeLessThanOrEqual(2 * 2 * 20 + 20 / 3 + 5);
      expect(sim.row.instance, other).toBe(hex(1));
    }
  });

  it("the process the row names stops and the other goes on: the conflict lifts on the one left", () => {
    const claims: { t: number; instance: string | null }[] = [];
    for (let t = T0; t < T0 + 30 * MIN; t += 30000) { claims.push({ t, instance: hex(1) }); claims.push({ t: t + 5000, instance: hex(2) }); }
    for (let t = T0 + 30 * MIN; t < T0 + 60 * MIN; t += 30000) claims.push({ t, instance: hex(2) });
    const sim = simulate(claims);
    expect(sim.lines.filter((l) => l.includes("one process again"))).toHaveLength(1);
    expect(sim.row).toMatchObject({ instance: hex(2), instance_conflict_at: null });
  });

  it("counts a crash loop only over processes that finished nothing and whose end nothing explains: a busy builder is none", () => {
    // Three processes that each live 3 min, with nothing to explain them: one crash-loop line, at the third.
    let r = row({ instance: hex(1), instance_since: at(0) });
    const lines: string[] = [];
    for (let i = 2; i <= 5; i++) {
      const s = instanceStep(r, claim({ instance: hex(i) }), T0 + (i - 1) * 3 * MIN);
      lines.push(...s.journal.map((l) => l.summary));
      r = { ...r, ...s.set } as OrdersRow;
    }
    expect(r.instance_churn).toBe(4);
    expect(r.crash_loop_since).toBe(at(9));
    expect(lines).toEqual([expect.stringContaining("a new process every few minutes")]);
    // One that lives CHURN_CLEAR_MIN ends it, with one line.
    const up = instanceStep(r, claim({ instance: hex(5) }), T0 + (12 + CHURN_CLEAR_MIN) * MIN);
    expect(up.set).toMatchObject({ crash_loop_since: null, instance_churn: 0 });
    expect(up.journal.map((l) => l.summary)).toEqual([expect.stringContaining("stays up again")]);

    // A community builder: one task per container, each finished — never counted, however short.
    let b = row({ id: "alice-box-1f2e", trust: "community", instance: hex(100), instance_since: at(0), instance_finished: hex(100) });
    for (let i = 101; i < 121; i++) {
      const s = instanceStep(b, claim({ instance: hex(i) }), T0 + (i - 100) * 3 * MIN);
      expect(s.journal).toEqual([]);
      b = { ...b, ...s.set, instance_finished: i % 4 ? hex(i) : hex(i) } as OrdersRow; // complete or fail, the pool stamps it (workerFinished)
    }
    expect(b.instance_churn).toBe(0);
    expect(b.crash_loop_since).toBeNull();

    // A builder whose containers crash before any report: counted; its next one that finishes a task clears it.
    let c = row({ id: "bob-box-9c07", trust: "community", instance: hex(200), instance_since: at(0) });
    for (let i = 201; i <= 204; i++) c = { ...c, ...instanceStep(c, claim({ instance: hex(i) }), T0 + (i - 200) * 2 * MIN).set } as OrdersRow;
    expect(c.crash_loop_since).not.toBeNull();
    const works = instanceStep({ ...c, instance_finished: c.instance, last_task: JSON.stringify({ id: 812 }) }, claim({ instance: hex(205) }), T0 + 12 * MIN);
    expect(works.set).toMatchObject({ crash_loop_since: null, instance_churn: 0 });
    expect(works.journal.map((l) => l.summary)).toEqual([expect.stringContaining("works again: it finished task #812")]);
  });

  it("never counts a short process whose end is explained", () => {
    const base = row({ instance: hex(1), instance_since: at(0), instance_churn: 2 });
    const explained: [string, Partial<OrdersRow>, Partial<ClaimFacts>][] = [
      ["a restart delivered to it", { open_orders: JSON.stringify([{ id: "wo_x", kind: "restart", state: "delivered", by: "pool", at: at(0) }]) }, {}],
      ["a stop of its task", { open_orders: JSON.stringify([{ id: "wo_y", kind: "stop-task", state: "pending", by: "m1", at: at(0) }]) }, {}],
      ["a new version", {}, { version: "v1.0.3" }],
      ["an idle exit its successor reports", {}, { previous_exit: { why: "idle", at: null, stuck_in: null, n: null } }],
      ["a drain", {}, { previous_exit: { why: "drain", at: null, stuck_in: null, n: null } }],
      ["a restart order", {}, { previous_exit: { why: "restart", at: null, stuck_in: null, n: null } }],
    ];
    for (const [what, r, c] of explained) expect(instanceStep({ ...base, ...r }, claim({ instance: hex(2), ...c }), T0 + 3 * MIN).set.instance_churn, what).toBe(0);
    // Unexplained, it counts.
    expect(instanceStep(base, claim({ instance: hex(2) }), T0 + 3 * MIN).set.instance_churn).toBe(3);
  });

  it("journals the watchdog's first exit of a day and its third, never counts it as churn, and starts again after 24 h", () => {
    let r = row({ instance: hex(1), instance_since: at(0), instance_churn: 2 });
    const wd = (n: number, m: number) => {
      const s = instanceStep(r, claim({ instance: hex(n), previous_exit: { why: "watchdog", at: null, stuck_in: "task", n: 1 } }), T0 + m * MIN);
      r = { ...r, ...s.set } as OrdersRow;
      return s;
    };
    expect(wd(2, 40).journal.map((l) => l.status)).toEqual(["warn"]);
    expect(r.instance_churn).toBe(0);
    expect(JSON.parse(r.watchdog_exits!)).toMatchObject({ n: 1, stuck_in: "task" });
    expect(wd(3, 120).journal).toEqual([]);
    expect(wd(4, 280).journal.map((l) => l.summary)).toEqual([expect.stringContaining("3 watchdog restarts since")]);
    expect(wd(5, 600).journal).toEqual([]);
    expect(wd(6, 25 * 60 + 40).journal.map((l) => l.status)).toEqual(["warn"]);
    expect(JSON.parse(r.watchdog_exits!).n).toBe(1);
  });

  it("holds the loop property over random schedules: churn only for unexplained processes, one crash-loop line per spell, at most two watchdog lines a day", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = seeded(seed);
      let r = row({ instance: hex(0), instance_since: at(0) });
      let t = 0, n = 0, crashLines = 0, looping = false;
      const wdLines: number[] = [];
      for (let k = 0; k < 120; k++) {
        t += 1 + Math.floor(rnd() * 20);
        const roll = rnd();
        if (roll < 0.5) continue; // the same process claims
        n++;
        const finished = rnd() < 0.3;
        const exit = rnd() < 0.2 ? parsePreviousExit({ why: ["idle", "drain", "restart", "watchdog"][Math.floor(rnd() * 4)], stuck_in: "task" }) : null;
        const before = { ...r, instance_finished: finished ? r.instance : r.instance_finished };
        const s = instanceStep(before, claim({ instance: hex(1000 + n), previous_exit: exit }), T0 + t * MIN);
        const lived = T0 + t * MIN - Date.parse(before.instance_since!);
        const unexplained = lived < 10 * MIN && !finished && !exit;
        expect(s.set.instance_churn, `seed ${seed}`).toBe(unexplained && !(before.crash_loop_since && finished) ? (before.instance_churn ?? 0) + 1 : 0);
        for (const l of s.journal) {
          if (l.summary.includes("a new process every few minutes")) { crashLines++; expect(looping, `seed ${seed}: one line per crash-loop spell`).toBe(false); looping = true; }
          if (l.summary.includes("watchdog")) wdLines.push(t);
          if (l.summary.includes("works again") || l.summary.includes("stays up again")) looping = false;
        }
        r = { ...before, ...s.set } as OrdersRow;
        if (!r.crash_loop_since) looping = false;
      }
      for (const w of wdLines) expect(wdLines.filter((x) => x >= w && x < w + 24 * 60).length, `seed ${seed}: watchdog lines per day`).toBeLessThanOrEqual(2);
      expect(crashLines).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the probe's age is the pool's", () => {
  it("is 0 when the claim brings a new probe, however the worker's clock stamps it, and the time since the claim that brought it otherwise", () => {
    const r = row({ agent_checked_at: "2026-09-29T11:50:00Z", agent_probed_at: at(-2) });
    expect(probeAge(r, { status: "error", error: "x", checked_at: "2026-09-29T11:40:00Z" }, T0)).toBe(0); // stamped 10 min in the past
    expect(probeAge(r, { status: "error", error: "x", checked_at: "2026-09-29T12:10:00Z" }, T0)).toBe(0); // and in the future
    expect(probeAge(r, { status: "error", error: "x", checked_at: "2026-09-29T11:50:00Z" }, T0)).toBe(2 * MIN);
    expect(probeAge(r, undefined, T0 + 4 * MIN)).toBe(6 * MIN);
    expect(probeAge(row({ agent_checked_at: "x", agent_probed_at: null }), { status: "error", error: "x", checked_at: "x" }, T0)).toBe(Infinity);
  });
});

/** The rules' input at a claim: a worker in error since `since`, its process up since `up`, the probe as given. */
function input(o: { r?: Partial<OrdersRow>; c?: Partial<ClaimFacts>; error?: string; since?: number; up?: number } = {}): RuleInput {
  const r = row({ agent_status: "error", agent_error: o.error ?? "URLError: <urlopen error [Errno 111] Connection refused>", agent_checked_at: "p0", agent_probed_at: at(0), agent_error_since: at(o.since ?? 0), instance: hex(1), instance_since: at(o.up ?? -10), ...o.r });
  return { row: r, claim: claim({ probe: { status: "error", error: r.agent_error, checked_at: r.agent_checked_at }, ...o.c }), status: "error", error: r.agent_error, spell: r.agent_error_since, instanceSince: r.instance_since, conflict: false, needsAgent: true };
}

describe("the step machine", () => {
  it("re-checks once, only when the worker's own re-check has stalled on the pool's clock", () => {
    // Spell 5 min, probe 2 min old: no re-check.
    expect(decideAuto(input({ r: { agent_probed_at: at(3) } }), T0 + 5 * MIN).kind).toBeNull();
    // Probe 6 min old: one re-check…
    const d = decideAuto(input({ r: { agent_probed_at: at(-1) } }), T0 + 5 * MIN);
    expect(d.kind).toBe("recheck-agent");
    // …and never a second in the spell.
    const again = input({ r: { agent_probed_at: at(-1), auto_orders: JSON.stringify(d.kind === "recheck-agent" ? d.next : null) } });
    expect(decideAuto(again, T0 + 6 * MIN).kind).toBeNull();
    // A probe the pool never saw is stale: one re-check.
    expect(decideAuto(input({ r: { agent_probed_at: null } }), T0 + 5 * MIN).kind).toBe("recheck-agent");
  });

  it("restarts conditionally once RESTART_AFTER_MIN has passed, never a process under MIN_UPTIME_S old, at most twice a spell, then gives up once", () => {
    // 10 min into the spell, the probe fresh: the conditional restart.
    const fresh = { agent_probed_at: at(9.5) };
    const first = decideAuto(input({ r: fresh }), T0 + RESTART_AFTER_MIN * MIN);
    expect(first).toMatchObject({ kind: "restart", unless: true, rule: "restart-1of2" });
    // Its process started 60 s ago on the pool's clock: nothing, nothing counted; 130 s: the restart.
    expect(decideAuto(input({ r: fresh, up: 10 - 1 }), T0 + 10 * MIN).kind).toBeNull();
    expect(decideAuto(input({ r: fresh, up: 10 - (MIN_UPTIME_S + 10) / 60 }), T0 + 10 * MIN).kind).toBe("restart");
    // The second, RESTART_SPACING_MIN after the first; nothing in between.
    const one = JSON.stringify(first.kind === "restart" ? first.next : null);
    expect(decideAuto(input({ r: { ...fresh, auto_orders: one } }), T0 + (10 + RESTART_SPACING_MIN - 1) * MIN).kind).toBeNull();
    const second = decideAuto(input({ r: { ...fresh, auto_orders: one }, up: 30 }), T0 + (10 + RESTART_SPACING_MIN) * MIN);
    expect(second).toMatchObject({ kind: "restart", rule: "restart-2of2" });
    const two = JSON.stringify(second.kind === "restart" ? second.next : null);
    // GIVE_UP_AFTER_MIN after the second, still failing: the pool gives up, once.
    const up = decideAuto(input({ r: { ...fresh, auto_orders: two }, up: 60 }), T0 + (40 + GIVE_UP_AFTER_MIN) * MIN);
    expect(up.kind).toBe("give-up");
    const gone = JSON.stringify(up.kind === "give-up" ? up.next : null);
    expect(decideAuto(input({ r: { ...fresh, auto_orders: gone }, up: 60 }), T0 + 200 * MIN).kind).toBeNull();
  });

  it("orders nothing at all for an error a restart cannot help, and never restarts on an unknown one", () => {
    for (const error of ["HTTPError: HTTP Error 402: Payment Required", "HTTP 401 invalid key", "HTTP 429 rate limit", "HTTPError: HTTP Error 503: Service Unavailable"]) {
      for (const m of [5, 10, 60, 600]) expect(decideAuto(input({ error, r: { agent_probed_at: null } }), T0 + m * MIN).kind, `${error} at ${m} min`).toBeNull();
    }
    const unknown = input({ error: "KeyError: 'content'", r: { agent_probed_at: null } });
    const d = decideAuto(unknown, T0 + 5 * MIN);
    expect(d.kind).toBe("recheck-agent");
    const after = { ...unknown, row: { ...unknown.row, auto_orders: JSON.stringify(d.kind === "recheck-agent" ? d.next : null) } };
    for (const m of [10, 60, 600]) expect(decideAuto(after, T0 + m * MIN).kind).toBeNull();
  });

  it("restarts a broker's builder only through a broker that exits with it, and a shared agent service before the worker itself", () => {
    const broker = { c: { agent_via: "broker" as const }, error: "the broker at http://broker:8790 did not answer", r: { agent_probed_at: at(9.5) } };
    expect(decideAuto(input(broker), T0 + 10 * MIN).kind).toBeNull();
    expect(decideAuto(input({ ...broker, c: { agent_via: "broker", pairRestart: true } }), T0 + 10 * MIN).kind).toBe("restart");
    const sibling = input({ c: { agent_via: "sibling" }, error: "HTTPError: HTTP Error 502: Bad Gateway", r: { agent_probed_at: at(9.5) } });
    const first = decideAuto(sibling, T0 + 10 * MIN);
    expect(first.kind).toBe("restart-agent");
    const next = { ...sibling, row: { ...sibling.row, auto_orders: JSON.stringify(first.kind === "restart-agent" ? first.next : null) }, instanceSince: at(20) };
    expect(decideAuto(next, T0 + 40 * MIN).kind).toBe("restart");
    // The service answers another worker of the host: this worker's own process is what fails, restarted itself.
    expect(decideAuto({ ...sibling, siblingAnswers: true }, T0 + 10 * MIN)).toMatchObject({ kind: "restart", rule: "restart-1of2", unless: true });
  });

  it("does nothing for a claim that takes no orders, two processes, an order open or an agent the worker does not need", () => {
    const base = input({ r: { agent_probed_at: null } });
    expect(decideAuto({ ...base, claim: { ...base.claim, takes: null } }, T0 + 20 * MIN).kind).toBeNull();
    expect(decideAuto({ ...base, conflict: true }, T0 + 20 * MIN).kind).toBeNull();
    expect(decideAuto({ ...base, needsAgent: false }, T0 + 20 * MIN).kind).toBeNull();
    expect(decideAuto({ ...base, row: { ...base.row, open_orders: JSON.stringify([{ id: "wo_1", kind: "restart", state: "pending", by: "m1", at: at(0) }]) } }, T0 + 20 * MIN).kind).toBeNull();
  });

  it("is bounded whatever the agent does: over 48 h of claims every 30 s, at most 2 restarts a spell, 3 a day, 1 re-check a spell, 3 a day", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rnd = seeded(seed);
      // Flapping (random spells), or never answering at all (seed 1).
      const r = row({ agent_status: "error", agent_error: "URLError: <urlopen error [Errno 111] Connection refused>", agent_checked_at: "p0", agent_probed_at: at(0), agent_error_since: at(0), instance: hex(1), instance_since: at(-10) });
      const issued: { k: string; t: number; spell: string }[] = [];
      let probeN = 0;
      for (let s = 0; s < 48 * 120; s++) {
        const now = T0 + s * 30000;
        if (seed > 1 && rnd() < 0.004) {
          // The agent answers for a while: the spell ends; a new one begins later.
          r.agent_status = r.agent_status === "error" ? "ok" : "error";
          r.agent_error_since = r.agent_status === "error" ? new Date(now).toISOString() : null;
        }
        if (r.agent_status !== "error") continue;
        const d = decideAuto({ row: r, claim: claim({ probe: { status: "error", error: r.agent_error, checked_at: r.agent_checked_at } }), status: "error", error: r.agent_error, spell: r.agent_error_since, instanceSince: r.instance_since, conflict: false, needsAgent: true }, now);
        if (d.kind === "recheck-agent" || d.kind === "restart" || d.kind === "restart-agent" || d.kind === "give-up") {
          r.auto_orders = JSON.stringify(d.next);
          if (d.kind === "give-up") continue;
          issued.push({ k: d.kind, t: now, spell: r.agent_error_since! });
          // The worker obeys: a re-check probes (still refused), a restart is a new process.
          r.agent_checked_at = `p${++probeN}`;
          r.agent_probed_at = new Date(now).toISOString();
          if (d.kind === "restart") r.instance_since = new Date(now + 5000).toISOString();
        }
      }
      const restarts = issued.filter((o) => o.k !== "recheck-agent"), rechecks = issued.filter((o) => o.k === "recheck-agent");
      for (const spell of new Set(issued.map((o) => o.spell))) {
        expect(restarts.filter((o) => o.spell === spell).length, `seed ${seed}`).toBeLessThanOrEqual(MAX_POOL_RESTARTS_PER_SPELL);
        expect(rechecks.filter((o) => o.spell === spell).length, `seed ${seed}`).toBeLessThanOrEqual(1);
      }
      for (const o of issued) {
        const day = (k: (x: { k: string }) => boolean) => issued.filter((x) => k(x) && x.t >= o.t && x.t < o.t + 24 * 3600e3).length;
        expect(day((x) => x.k !== "recheck-agent"), `seed ${seed}`).toBeLessThanOrEqual(MAX_POOL_RESTARTS_PER_DAY);
        expect(day((x) => x.k === "recheck-agent"), `seed ${seed}`).toBeLessThanOrEqual(MAX_POOL_RECHECKS_PER_DAY);
        // Restarts of one spell are RESTART_SPACING_MIN apart.
      }
      if (seed === 1) expect(restarts.length).toBe(2);
    }
  });

  it("keeps the per-spell counts to their spell, and the day's to 24 h", () => {
    const a = autoOf(JSON.stringify({ spell: at(0), rechecks: 1, restarts: 2, last_recheck: at(5), last_restart: at(40), gave_up: at(70), day: [{ k: "r", at: at(10) }, { k: "c", at: at(-2000) }] }), at(100), T0 + 101 * MIN);
    expect(a).toMatchObject({ spell: at(100), rechecks: 0, restarts: 0, gave_up: null });
    expect(a.day).toEqual([{ k: "r", at: at(10) }]);
  });
});

describe("a host's workers, and the breaker's scope", () => {
  const sw = (id: string, o: Partial<SiteWorker> = {}): SiteWorker => ({ id, agent_via: "sibling", agent_status: "error", agent_error_class: "sibling", order_kinds: '["drain","recheck-agent","restart","restart-agent"]', instance_since: at(-30), agent_error_since: at(-20), auto_orders: null, ...o });
  const read = (live: SiteWorker[], o: Partial<SiteRead> = {}): SiteRead => ({ live, last: null, open: 0, ...o });
  it("restarts a shared agent service once, through the lowest id that declares it; the others wait and are told through whom", () => {
    const r = read([sw("studio-review-aarch64"), sw("studio-review2-aarch64")]);
    expect(siteVerdict({ id: "studio-review-aarch64" }, "restart-agent", r, T0, 1)).toEqual({ ok: true, others: ["studio-review2-aarch64"] });
    expect(siteVerdict({ id: "studio-review2-aarch64" }, "restart-agent", r, T0, 1)).toEqual({ ok: false, why: "its agent service is shared with studio-review-aarch64; the pool restarts it once, through studio-review-aarch64" });
    // The emulated profile's four: the same, the waiting ones' words name the others from the read.
    const four = read(["studio-review-aarch64", "studio-review2-aarch64", "studio-review-x86_64", "studio-review2-x86_64"].map((id) => sw(id)));
    const v = siteVerdict({ id: "studio-review2-x86_64" }, "restart-agent", four, T0, 1);
    expect(v).toMatchObject({ ok: false, why: "its agent service is shared with studio-review-aarch64, studio-review-x86_64, studio-review2-aarch64; the pool restarts it once, through studio-review-aarch64" });
    // The elected one gave up in its spell: the others stop too — the service was restarted as often as the pool restarts it.
    const gave = read([sw("studio-review-aarch64", { auto_orders: JSON.stringify({ spell: at(-20), rechecks: 1, restarts: 2, last_recheck: at(-15), last_restart: at(-5), gave_up: at(-1), day: [] }) }), sw("studio-review2-aarch64")]);
    expect(siteVerdict({ id: "studio-review2-aarch64" }, "restart-agent", gave, T0, 1)).toMatchObject({ ok: false, giveUp: true, why: expect.stringContaining("was restarted through studio-review-aarch64, which did not bring it back") });
    // A give-up of an earlier spell is not this one's.
    const old = read([sw("studio-review-aarch64", { auto_orders: JSON.stringify({ spell: at(-200), gave_up: at(-150), day: [] }) }), sw("studio-review2-aarch64")]);
    expect(siteVerdict({ id: "studio-review2-aarch64" }, "restart-agent", old, T0, 1)).not.toMatchObject({ giveUp: true });
  });
  it("paces the host: one restart open at a time, anyone's, and SITE_SPACING_MIN between two of the pool's", () => {
    expect(siteVerdict({ id: "a" }, "restart", read([], { open: 1 }), T0, 1)).toMatchObject({ ok: false, why: expect.stringContaining("one at a time") });
    expect(siteVerdict({ id: "a" }, "restart", read([], { last: at(-2) }), T0, 1)).toMatchObject({ ok: false });
    expect(siteVerdict({ id: "a" }, "restart", read([], { last: at(-6) }), T0, 1)).toMatchObject({ ok: true });
  });
  it("tells a worker whose own probe fails while the service answers another that it is its own process the pool restarts, and says so on its page", () => {
    const r = read([sw("studio-review-aarch64", { agent_status: "ok" }), sw("studio-review2-aarch64")]);
    expect(siblingsAnswering({ id: "studio-review2-aarch64" }, r.live)).toEqual(["studio-review-aarch64"]);
    expect(siteWords({ id: "studio-review2-aarch64", order_kinds: '["drain","recheck-agent","restart","restart-agent"]' }, r, T0, 1)).toBe("its agent service answers for studio-review-aarch64: the pool restarts this worker's own process, not the service");
    const both = read([sw("studio-review-aarch64"), sw("studio-review2-aarch64")]);
    expect(siteWords({ id: "studio-review2-aarch64", order_kinds: '["drain","recheck-agent","restart","restart-agent"]' }, both, T0, 1)).toBe("its agent service is shared with studio-review-aarch64; the pool restarts it once, through studio-review-aarch64");
    expect(siteWords({ id: "studio-review-aarch64", order_kinds: '["drain","recheck-agent","restart","restart-agent"]' }, both, T0, 1)).toBe("its agent service is shared with studio-review2-aarch64: the pool restarts it once, through this worker");
  });
  it("keeps a site under the name of who runs it: the project's workers share one namespace, a contributor's their own", () => {
    expect(siteKey({ trust: "project", owner: "m1" }, "5d0e4b1a9c7f2e36")).toBe("project/5d0e4b1a9c7f2e36");
    expect(siteKey({ trust: "project", owner: "m2" }, "5d0e4b1a9c7f2e36")).toBe("project/5d0e4b1a9c7f2e36");
    expect(siteKey({ trust: "community", owner: "mallory" }, "5d0e4b1a9c7f2e36")).toBe("mallory/5d0e4b1a9c7f2e36");
    expect(siteKey({ trust: "community", owner: "mallory" }, null)).toBeNull();
  });
  it("counts a project worker's breaker over the project's own spells, a contributor's over everyone's", () => {
    const rows = [
      { id: "p1", site: "project/aa", agent: "anthropic/x", trust: "project" },
      { id: "p2", site: "project/aa", agent: "anthropic/x", trust: "project" },
      { id: "c1", site: null, agent: "anthropic/x", trust: "community" },
      { id: "c2", site: "mallory/bb", agent: "anthropic/x", trust: "community" },
      { id: "c3", site: "mallory/cc", agent: "anthropic/x", trust: "community" },
      { id: "o1", site: null, agent: "openai/y", trust: "community" },
    ];
    expect(sitesByProvider(rows, "project").get("anthropic")?.size).toBe(1);
    expect(sitesByProvider(rows, "all").get("anthropic")?.size).toBe(4);
    expect(sitesByProvider(rows, "all").get("openai")?.size).toBe(1);
    expect([breakerScope("project"), breakerScope("community"), breakerScope(null)]).toEqual(["project", "all", "all"]);
    expect(breakerKey("anthropic", "project")).toBe("worker-breaker:anthropic:project");
    expect(breakerKey("claude-code", "all")).toBe("worker-breaker:claude-code");
    expect(breakerOfKey("worker-breaker:claude-code:project")).toEqual({ provider: "claude-code", scope: "project" });
    expect(breakerOfKey("worker-breaker:claude-code")).toEqual({ provider: "claude-code", scope: "all" });
  });
  it("names the pool on its own orders with what no GitHub login can be, one per trust", () => {
    expect([poolFor("project"), poolFor("community"), poolFor(null)]).toEqual([POOL_PROJECT, POOL_COMMUNITY, POOL_COMMUNITY]);
    for (const by of [POOL_PROJECT, POOL_COMMUNITY]) {
      expect(isPool(by)).toBe(true);
      // A GitHub login is letters, digits and single hyphens.
      expect(/^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/.test(by)).toBe(false);
    }
    for (const login of ["pool", "pool-project", "m1"]) expect(isPool(login)).toBe(false);
  });
});

describe("the scale of the step timings", () => {
  it("is honoured only where the running Worker is not a release, from 1 to 60", () => {
    expect(rulesScale({ POOL_VERSION: "v1.0.3", WORKER_RULES_SCALE: "60" })).toEqual({ scale: 1, ignored: true });
    expect(rulesScale({ POOL_VERSION: "v1.0.3" })).toEqual({ scale: 1, ignored: false });
    expect(rulesScale({ POOL_VERSION: "dev", WORKER_RULES_SCALE: "60" })).toEqual({ scale: 60, ignored: false });
    for (const bad of ["0", "61", "x", "2.5"]) expect(rulesScale({ POOL_VERSION: "dev", WORKER_RULES_SCALE: bad }).scale).toBe(1);
    // The scale divides the step timings only: the uptime gate holds whatever it is.
    const now = T0 + 10 * MIN, since = 10 - RESTART_AFTER_MIN / 60 - 1 / 60;
    expect(decideAuto(input({ since, r: { agent_probed_at: at(10) }, up: 10 - 1 }), now, 60).kind).toBeNull();
    expect(decideAuto(input({ since, r: { agent_probed_at: at(10) }, up: 10 - 3 }), now, 60).kind).toBe("restart");
    expect(decideAuto(input({ r: { agent_probed_at: at(-1) } }), T0 + (RECHECK_AFTER_MIN / 60) * MIN + 1000, 60).kind).toBe("recheck-agent");
  });
});

describe("who may press what", () => {
  const w = { id: "studio-review-aarch64", owner: "m1", revoked_at: null, version: "v1.0.2", order_kinds: '["drain","recheck-agent","restart","restart-agent"]', open_orders: null, instance_conflict_at: null, restarts_left: null, agent_via: "sibling" };
  const f: OrderFacts = { now: T0, restartsHour: 0, rechecksHour: 0, loginHour: 0, restartsFreeAt: null, rechecksFreeAt: null, loginFreeAt: null };
  it("its owner and any maintainer; anyone else is refused, and nobody signed in is asked to", () => {
    expect(orderVerdicts(null, w, f).restart).toMatchObject({ ok: false, status: 401 });
    expect(orderVerdicts({ login: "bob", role: "contributor" }, w, f).restart).toMatchObject({ ok: false, status: 403, why: "only m1 or a maintainer gives it orders" });
    expect(orderVerdicts({ login: "m1", role: "contributor" }, w, f).restart.ok).toBe(true);
    expect(orderVerdicts({ login: "m2", role: "maintainer" }, w, f).restart_agent.ok).toBe(true);
    expect(orderVerdicts({ login: "m2", role: "maintainer" }, { ...w, revoked_at: at(0) }, f).restart).toMatchObject({ status: 404 });
  });
  it("by the worker's state: an image that takes no orders, a kind it does not declare, one waiting, two processes, a policy running out, the caps; the later parts' kinds not yet", () => {
    const m = { login: "m2", role: "maintainer" };
    expect(orderVerdicts(m, { ...w, order_kinds: null }, f).recheck).toMatchObject({ status: 409, why: expect.stringContaining("takes no orders") });
    expect(orderVerdicts(m, { ...w, order_kinds: '["drain","restart"]' }, f).recheck).toMatchObject({ why: "it runs no agent to re-check" });
    expect(orderVerdicts(m, { ...w, order_kinds: '["drain","restart"]', agent_via: "direct" }, f).restart_agent).toMatchObject({ why: expect.stringContaining("it calls no agent service of its own host") });
    expect(orderVerdicts(m, { ...w, open_orders: JSON.stringify([{ id: "wo_a", kind: "restart", state: "pending", by: "m1", at: at(0) }]) }, f).restart).toMatchObject({ why: expect.stringContaining("a restart is waiting already") });
    expect(orderVerdicts(m, { ...w, instance_conflict_at: at(-5) }, f).restart).toMatchObject({ why: expect.stringContaining("two processes share this token") });
    expect(orderVerdicts(m, { ...w, restarts_left: 2 }, f).restart).toMatchObject({ why: expect.stringContaining("has 2 restarts left") });
    expect(orderVerdicts(m, w, { ...f, restartsHour: 6, restartsFreeAt: at(30) }).restart).toMatchObject({ why: "restarted 6 times in the last hour; the next from 12:30" });
    expect(orderVerdicts(m, w, { ...f, rechecksHour: 6 }).recheck.ok).toBe(false);
    expect(orderVerdicts(m, w, { ...f, loginHour: 20 }).recheck).toMatchObject({ why: expect.stringContaining("reached 20 orders in an hour") });
    for (const r of ["drain", "resume", "stop_task", "update"] as const) expect(orderVerdicts(m, w, f)[r]).toMatchObject({ status: 409, why: expect.stringContaining("not on this pool yet") });
  });
});

describe("the pool's sentences", () => {
  it("keeps the worker's code only in its closed set and outcome, and says only what the pool knows", () => {
    expect(answerCode("restart", "refused", "agent-ok")).toBe("agent-ok");
    expect(answerCode("restart", "done", "agent-ok")).toBe("other");
    expect(answerCode("restart", "refused", "<script>")).toBe("other");
    expect(answerCode("restart-agent", "refused", "unknown-kind")).toBe("unknown-kind");
    expect(codeSentence("restart", "agent-ok", "refused")).toBe("its agent answers now: no restart needed");
    expect(codeSentence("restart-agent", "restarted", "done", { service: "agent-proxy", seconds: 34 })).toBe("restarted agent-proxy; it answers again after 34 s");
    expect(codeSentence("restart-agent", "restarted", "done", { service: "evil; rm -rf", seconds: 1e9 })).toBe("restarted its agent service; it answers again");
    expect(codeSentence("recheck-agent", "unknown-kind", "refused", { version: "v1.0.2" })).toBe("does not know this order (v1.0.2)");
    // A version is the worker's own string: the public sentence carries only a tag the pool parsed.
    const hostile = "v9\u202e\n\x1b[31m" + "X".repeat(5000);
    expect(codeSentence("recheck-agent", "unknown-kind", "refused", { version: hostile })).toBe("does not know this order (its version)");
    expect(versionWord(hostile, "its image")).toBe("its image");
    expect(versionWord("1.0.3")).toBe("v1.0.3");
    // The crash-loop line and a refusal say the same.
    let r = row({ instance: hex(1), instance_since: at(0), version: hostile });
    const lines: string[] = [];
    for (let i = 2; i <= 5; i++) { const st = instanceStep(r, claim({ instance: hex(i), version: hostile }), T0 + (i - 1) * 3 * MIN); lines.push(...st.journal.map((l) => l.summary + JSON.stringify(l.payload))); r = { ...r, ...st.set } as OrdersRow; }
    expect(lines.join()).toContain("a new process every few minutes on its image");
    expect(lines.join()).not.toContain("XXXX");
  });
});

/** A seeded generator (mulberry32): the same schedules every run, a failure names its seed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { seeded, CRASH_LOOP_AT };
