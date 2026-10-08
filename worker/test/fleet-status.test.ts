/**
 * The fleet's Status lines and the Workers page by host (#324, design v2
 * §18.2, §18.3; fleet.ts, routes/hosts.ts handleFleet):
 *
 * - each line on its own, on a fixed clock (fleet.ts): a host silent for ten
 *   minutes (one whose last report said it sleeps, only a day on); behind 45
 *   minutes after a deploy; rolled back; a task lost on it (readopt-failed);
 *   its disk under the floor; a lane held for binfmt in the pool's words,
 *   never the agent's (nor the envelope's own choice); a task clamped to the
 *   largest host; a host reserving for over an hour; a verify failure as an
 *   error naming the check (a floor's refusal is none); a new host and an
 *   agent's self-rollback as info; errors first;
 * - the scaling signal: an x86_64 backlog whose oldest waited 60 minutes with
 *   no free build of it (a build's units and disk free, as a claim's room
 *   test judges them) says how many wait and the free units native and
 *   emulated — beside a free build, an info line that says so —, the
 *   needs_native waits counted; the week's busy ratio per lane;
 * - the second opinion: the fleet's model mix and the share of last week's
 *   publish-bound audits that were `independent: none`;
 * - through the Worker with a real D1: GET /api/v1/hosts/fleet says them
 *   from the rows the claims, the reports and the journal leave, public and a
 *   minute at the edge; Status draws them, the hosts linked, the error marked;
 *   the Workers page lists the hosts with their units and lanes, and the
 *   legacy registrations as such — a host's own registration never among them.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { capacityLines, capacityOf, fleetHostOf, heldWords, hostLines, secondOpinionOf, span, verifyFailureOf, ASLEEP_QUIET_H, type FleetHostRow, type FleetLease } from "../src/fleet";
import { selectionRules } from "../src/routes/factory";
import { AUDITS_7D_SQL, BUSY_7D_SQL, FLEET_EVENTS_SQL, FLEET_LEASES_SQL, HOST_LEASES_SQL, MODEL_MIX_SQL, QUEUE_BY_ARCH_SQL } from "../src/routes/hosts";
import { DISK_FLOOR_GB } from "../src/hosts";
import { declared, runScript, scriptOf } from "./fixture";
import { toB64url } from "../src/webauthn";

const ORIGIN = "http://pool.test";
const MIN = 60000;
const NOW = Date.parse("2026-10-06T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (m: number, now = NOW) => iso(now - m * MIN);
const RULES = selectionRules();

const STUDIO_LANES = [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated", via: "qemu", page16k: true }];
const capOf = (o: Record<string, unknown> = {}) => JSON.stringify({ cpus: 12, mem_gb: 32, disk_free_gb: { work: 410, engine: 220 }, lanes: STUDIO_LANES, held_lanes: [], agent_slots: 2, units: 11, below_minimum: null, ...o });
/** A host as the fleet's read gives it: the Studio, active, reporting and claiming a moment ago. */
const row = (o: Partial<FleetHostRow> = {}): FleetHostRow => ({
  id: "h_studio0001", name: "studio", owner_login: "m1", status: "active", os: "linux", arch: "aarch64", lanes: JSON.stringify(STUDIO_LANES), capacity: capOf(),
  units: 11, pool_cap_units: null, agent_slots: 2, isolation: "root", dedicated: 1, release_applied: "v1.20.0", rolled_back_from: null, rolled_back_at: null,
  reported_at: ago(1), last_seen: ago(1), asleep_at: null, confirmed_at: ago(30 * 24 * 60), reserving_task: null, reserving_since: null, soaking_until: null,
  owner_removed_at: null, report: null, worker_id: "m1-studio-ab12", reg_last_seen: ago(0.5), drained_at: null, agent: "claude-code/claude-sonnet-5", ...o,
});
const POOL = { version: "v1.20.0", deployed_at: ago(3 * 60) };
const NONE = { lost: [], clamped: [] };
const kinds = (ls: { kind: string }[]) => ls.map((l) => l.kind);

describe("each host's Status lines (fleet.ts hostLines)", () => {
  it("a host is silent once nothing of it reached the pool for ten minutes — one whose last report said it sleeps only a day on", () => {
    expect(hostLines([row({ reported_at: ago(9.9), last_seen: ago(9.9) })], NONE, POOL, NOW)).toEqual([]);
    // Its state poll counts as much as its report: the later of the two.
    expect(hostLines([row({ reported_at: ago(30), last_seen: ago(2) })], NONE, POOL, NOW)).toEqual([]);
    const silent = hostLines([row({ reported_at: ago(10), last_seen: ago(10) })], NONE, POOL, NOW);
    expect(silent).toEqual([{ level: "warn", kind: "silent", host: { id: "h_studio0001", name: "studio", owner: "m1" }, text: "silent for 10 min: nothing of it reached the pool since 2026-10-06 11:50 UTC — check the machine, its agent and its network" }]);
    // Asleep (a Mac, #329): its last report said so — not silent, and its fleet row says asleep and not alive.
    const asleep = row({ reported_at: ago(60), last_seen: ago(60), asleep_at: ago(61) });
    expect(hostLines([asleep], NONE, POOL, NOW)).toEqual([]);
    expect(fleetHostOf(asleep, [], NOW, RULES)).toMatchObject({ state: "asleep", asleep: true, alive: false });
    // A day on, it is silent like any host (it lost power, or its agent died asleep), on Status and on the Workers page alike.
    const gone = row({ reported_at: ago(ASLEEP_QUIET_H * 60 + 1), last_seen: ago(ASLEEP_QUIET_H * 60 + 1), asleep_at: ago(ASLEEP_QUIET_H * 60 + 2) });
    expect(hostLines([gone], NONE, POOL, NOW)).toEqual([expect.objectContaining({ kind: "silent", text: "silent for 24 h 1 min: nothing of it reached the pool since 2026-10-05 11:59 UTC, when its last report said it was going to sleep — check the machine, its agent and its network" })]);
    expect(fleetHostOf(gone, [], NOW, RULES)).toMatchObject({ state: "silent", asleep: false, alive: false });
    // A suspended, a waiting or a retired host says it elsewhere.
    for (const status of ["suspended", "pending-owner", "retired"]) expect(hostLines([row({ status, reported_at: ago(90), last_seen: ago(90) })], NONE, POOL, NOW)).toEqual([]);
  });

  it("a host still on an older release 45 minutes after the deploy is behind — not while it soaks, not while silent, and a revert says rolled-back instead", () => {
    const pool = (m: number) => ({ version: "v1.21.0", deployed_at: ago(m) });
    expect(hostLines([row()], NONE, pool(44), NOW)).toEqual([]);
    const behind = hostLines([row({ report: JSON.stringify({ round: { outcome: "held", detail: "v1.21.0 waits: its brake" } }) })], NONE, pool(46), NOW);
    expect(behind).toHaveLength(1);
    expect(behind[0]).toMatchObject({ level: "warn", kind: "behind", text: "behind: it runs v1.20.0, 46 min after the deploy of v1.21.0 — its last round: held (its page has why)" });
    expect(hostLines([row({ soaking_until: ago(-30) })], NONE, pool(46), NOW)).toEqual([]);
    expect(kinds(hostLines([row({ reported_at: ago(20), last_seen: ago(20) })], NONE, pool(46), NOW))).toEqual(["silent"]);
    const back = hostLines([row({ rolled_back_from: "v1.21.0", rolled_back_at: ago(20) })], NONE, pool(46), NOW);
    expect(back).toEqual([expect.objectContaining({ kind: "rolled-back", text: "rolled-back: its agent's guard reverted v1.21.0 (2026-10-06 11:40 UTC) and runs v1.20.0; v1.21.0 stays in its quarantine" })]);
  });

  it("says a task lost on it (readopt-failed), its disk under the floor, a lane held for binfmt in the pool's words — not one its envelope turns off — and a reservation over an hour", () => {
    const lost = hostLines([row()], { lost: [{ worker: "m1-studio-ab12", task: 812, at: ago(5) }, { worker: "someone-else", task: 9, at: ago(5) }], clamped: [] }, POOL, NOW);
    expect(lost).toEqual([expect.objectContaining({ kind: "readopt-failed", text: "readopt-failed: 1 task lost in the last hour (#812) — a container gone when its dispatcher came back (a reboot, an engine restart, the disk watcher); each back in the queue, its attempt given back" })]);
    const low = hostLines([row({ capacity: capOf({ disk_free_gb: { work: DISK_FLOOR_GB - 1, engine: 220 } }) })], NONE, POOL, NOW);
    expect(low).toEqual([expect.objectContaining({ kind: "disk-low", text: `disk-low: ${DISK_FLOOR_GB - 1} GB free on the work root and 220 on the engine's data root, below the ${DISK_FLOOR_GB} GB floor — it claims no build until there is room` })]);
    const binfmt = "needs a person: prep-root.sh installs qemu-user-static-binfmt (no qemu-x86_64 handler in /proc/sys/fs/binfmt_misc)";
    const held = hostLines([row({ capacity: capOf({ lanes: [STUDIO_LANES[0]], held_lanes: [{ arch: "x86_64", reason: binfmt }] }) })], NONE, POOL, NOW);
    expect(held).toEqual([{ level: "warn", kind: "lane-held", arch: "x86_64", host: expect.any(Object), text: "its x86_64 lane is held: binfmt missing (prep-root.sh installs it) — its page has why" }]);
    // Public, as Status is: the class of the agent's reason, never its words (a path of the machine, an engine's error).
    expect(held[0].text).not.toContain("/proc/sys");
    const smoke = "the smoke run failed: Error: crun: open `/home/omarchy/.local/share/omarchy-agent/work/emul-probe`: Permission denied";
    const failed = hostLines([row({ capacity: capOf({ lanes: [STUDIO_LANES[0]], held_lanes: [{ arch: "x86_64", reason: smoke }] }) })], NONE, POOL, NOW);
    expect(failed.map((l) => l.text)).toEqual(["its x86_64 lane is held: its smoke run failed — its page has why"]);
    expect(heldWords("not checked: no x86_64 build image to run (a release names one)")).toBe("not checked: no build image to run");
    expect(heldWords("something its agent says one day")).toBe("its agent holds it");
    expect(hostLines([row({ capacity: capOf({ held_lanes: [{ arch: "x86_64", reason: "off: the envelope's emulate does not list it" }] }) })], NONE, POOL, NOW)).toEqual([]);
    expect(hostLines([row({ reserving_task: 4242, reserving_since: ago(59) })], NONE, POOL, NOW)).toEqual([]);
    expect(hostLines([row({ reserving_task: 4242, reserving_since: ago(75) })], NONE, POOL, NOW)).toEqual([expect.objectContaining({ kind: "reserving", task: 4242, text: "reserving for task #4242 for 1 h 15 min: it takes nothing else but pool jobs until its units fit it" })]);
  });

  it("a verify failure is an error naming the failed check; a floor's refusal is the agent keeping its rules", () => {
    const refused = (detail: string) => JSON.stringify({ round: { at: "2026-10-06T11:58:00Z", outcome: "refused", from: null, step: "verify", detail } });
    const sig = "refused (signature): verify refused (signature): signature: the transparency log's entry does not hold up";
    const err = hostLines([row({ report: refused(sig) })], NONE, POOL, NOW);
    expect(err).toEqual([{ level: "error", kind: "refused", host: expect.any(Object), text: "refused: its agent's verify failed the signature check (2026-10-06 11:58 UTC) — possible tampering: it applied nothing and runs what it ran; its page has the round's words" }]);
    // Public, as Status is: the check, never the agent's own words.
    expect(err[0].text).not.toContain("transparency log");
    expect(verifyFailureOf({ at: null, outcome: "refused", from: null, step: null, detail: "refused (repository): verify refused (repository): signed by another repository" })).toBe("repository");
    expect(hostLines([row({ report: refused("refused (below-floor): v1.10.0 is below the floor v1.18.0") })], NONE, POOL, NOW)).toEqual([]);
    expect(verifyFailureOf({ at: null, outcome: "pull-failed", from: null, step: null, detail: "verify refused (signature): …" })).toBeNull();
  });

  it("info: a new host this week, an agent's self-rollback; a task clamped to the largest host; errors first, then warnings, then info", () => {
    const fresh = row({ id: "h_new0000001", name: "vps-1", owner_login: "m2", confirmed_at: ago(2 * 24 * 60), worker_id: "m2-vps-1-cd34" });
    const lines = hostLines([
      row({ report: JSON.stringify({ agent: { version: "0.4.0", skip: "0.5.0" }, round: { outcome: "agent-rollback", detail: "agent 0.5.0 was rolled back to 0.4.0 after its health gate failed; 0.5.0 is skipped until a higher agent" } }) }),
      fresh,
      row({ id: "h_bad0000001", name: "bad", report: JSON.stringify({ round: { outcome: "refused", detail: "verify refused (bundle): bundle: not a bundle" } }) }),
    ], { lost: [], clamped: [{ task: 77, summary: "chromium for aarch64 (task 77) asked size 4; the largest host alive runs size 3: it runs clamped on m1-studio-ab12", at: ago(60) }] }, POOL, NOW);
    expect(lines.map((l) => [l.level, l.kind])).toEqual([["error", "refused"], ["warn", "clamped"], ["info", "agent-rollback"], ["info", "new-host"]]);
    expect(lines[1].text).toBe("clamped: chromium for aarch64 (task 77) asked size 4; the largest host alive runs size 3: it runs clamped on m1-studio-ab12");
    expect(lines[2].text).toBe("an agent self-rollback: agent 0.5.0 did not pass its health gate and is skipped here until a higher one");
    expect(lines[3]).toMatchObject({ host: { name: "vps-1", owner: "m2" }, text: "a new host, confirmed 2 d ago: 12 cores, 32 GB, aarch64 native, x86_64 emulated, isolation root (dedicated)" });
    // A month-old host is no new one.
    expect(kinds(hostLines([row()], NONE, POOL, NOW))).toEqual([]);
  });
});

describe("the scaling signal (fleet.ts capacityOf, capacityLines)", () => {
  // The Studio with five builds leased (ten of its eleven units: none free for a task) and a native x86_64 host, idle or silent.
  const studioLeases: FleetLease[] = [1, 2, 3, 4, 5].map((id) => ({ id, lease_owner: "m1-studio-ab12", kind: "build", arch: "aarch64", lane: "native", units: 2, size: 1 }));
  const vps = (o: Partial<FleetHostRow> = {}) => row({ id: "h_vps0000001", name: "vps-x86", arch: "x86_64", lanes: JSON.stringify([{ arch: "x86_64", mode: "native" }]), capacity: capOf({ cpus: 8, mem_gb: 16, units: 7, lanes: [{ arch: "x86_64", mode: "native" }] }), units: 7, worker_id: "m2-vps-x86", owner_login: "m2", ...o });

  it("an x86_64 backlog whose oldest waited 60 minutes with no free build of it warns with the free units native and emulated, and counts the native waits", () => {
    const rows = [row(), vps({ reported_at: ago(15), last_seen: ago(15), reg_last_seen: ago(15) })];
    const hosts = rows.map((h) => fleetHostOf(h, studioLeases, NOW, RULES));
    expect(hosts.map((h) => [h.name, h.state, h.units_busy, h.units_free])).toEqual([["studio", "full", 10, 0], ["vps-x86", "silent", 0, 0]]);
    const queue = [{ arch: "x86_64", n: 3, oldest: ago(61), needs_native: 2 }, { arch: "aarch64", n: 40, oldest: ago(20), needs_native: 0 }];
    const caps = capacityOf(queue, hosts, rows, [], NOW);
    expect(caps.map((c) => [c.arch, c.queued, c.oldest_wait_min, c.free_native, c.free_emulated, c.needs_native, c.hosts_native, c.hosts_emulated])).toEqual([["x86_64", 3, 61, 0, 0, 2, 1, 1], ["aarch64", 40, 20, 0, 0, 0, 1, 0]]);
    expect(capacityLines(caps)).toEqual([
      { level: "warn", kind: "capacity", arch: "x86_64", text: "x86_64: 3 tasks queued, the oldest waited 1 h 1 min; free native units: 0, free emulated units: 0" },
      { level: "warn", kind: "needs-native", arch: "x86_64", text: "tasks waiting for a native x86_64 host: 2" },
    ]);
    // 59 minutes: no warning yet; the native waits are counted whatever their age.
    expect(kinds(capacityLines(capacityOf([{ arch: "x86_64", n: 3, oldest: ago(59), needs_native: 2 }], hosts, rows, [], NOW)))).toEqual(["needs-native"]);
    // The Studio with room (three builds): the emulated lane's free units say so, and no native host runs x86_64 now the VPS is gone.
    const room = [row()].map((h) => fleetHostOf(h, studioLeases.slice(0, 3), NOW, RULES));
    expect(room[0]).toMatchObject({ state: "claiming", units_busy: 6, units_free: 4 });
    // Its one queued task an emulated lane sent back: the emulated lane's free build (16K pages) does not take it, the warning stands —
    // and says a lane on 4K pages would (#413); one a lane on 4K pages sent back too, a native host only.
    expect(capacityLines(capacityOf([{ arch: "x86_64", n: 1, oldest: ago(90), needs_native: 1 }], room, [row()], [], NOW))).toEqual([
      { level: "warn", kind: "capacity", arch: "x86_64", text: "x86_64: 1 task queued, the oldest waited 1 h 30 min; free native units: 0, free emulated units: 4 — no host runs x86_64 natively" },
      expect.objectContaining({ text: "tasks waiting for a native x86_64 host: 1 — none runs it natively: a native host takes them, and a lane on 4K pages the 1 a lane on 16K pages sent back" }),
    ]);
    expect(capacityLines(capacityOf([{ arch: "x86_64", n: 1, oldest: ago(90), needs_native: 1, refused_4k: 1 }], room, [row()], [], NOW))[1])
      .toMatchObject({ text: "tasks waiting for a native x86_64 host: 1 — none runs it natively: only a native host takes them" });
  });

  it("a lane on 4K pages (#413) takes what a lane on 16K pages sent back: only what it sent back too waits for a native host, and a free build there is room for the rest", () => {
    // The Studio full (16K pages) and its x86_64 VM beside it, idle: aarch64 native, x86_64 emulated on 4K pages, five units.
    const vmLanes = [{ arch: "aarch64", mode: "native" }, { arch: "x86_64", mode: "emulated", via: "qemu", page16k: false }];
    const vmRow = row({ id: "h_vm00000001", name: "studio-vm", lanes: JSON.stringify(vmLanes), capacity: capOf({ cpus: 6, mem_gb: 12, units: 5, lanes: vmLanes }), units: 5, worker_id: "m1-studio-vm-ef56" });
    const rows = [row(), vmRow];
    const hosts = rows.map((h) => fleetHostOf(h, studioLeases, NOW, RULES));
    // Three x86_64 builds waited 90 minutes, all sent back by the Studio's lane, one of them by the VM's too.
    const caps = capacityOf([{ arch: "x86_64", n: 3, oldest: ago(90), needs_native: 3, refused_4k: 1 }], hosts, rows, [], NOW);
    expect(caps[0]).toMatchObject({ needs_native: 3, refused_4k: 1, hosts_native: 0, hosts_emulated: 2, hosts_4k: 1, build_fits: { native: false, emulated: true, emulated_4k: true } });
    expect(capacityLines(caps)).toEqual([
      expect.objectContaining({ level: "info", kind: "capacity" }),
      { level: "warn", kind: "needs-native", arch: "x86_64", text: "tasks waiting for a native x86_64 host: 1 — none runs it natively: only a native host takes them" },
    ]);
    // Every one of them sent back by the VM too: no lane takes them, the prompt to add a native host.
    const refused = capacityOf([{ arch: "x86_64", n: 3, oldest: ago(90), needs_native: 3, refused_4k: 3 }], hosts, rows, [], NOW);
    expect(capacityLines(refused).map((l) => [l.level, l.kind])).toEqual([["warn", "capacity"], ["warn", "needs-native"]]);
    // Without the VM: all three wait for a native host, the line says a lane on 4K pages takes the two the Studio alone sent back.
    const studioOnly = capacityOf([{ arch: "x86_64", n: 3, oldest: ago(90), needs_native: 3, refused_4k: 1 }], [hosts[0]], [row()], [], NOW);
    expect(capacityLines(studioOnly).find((l) => l.kind === "needs-native")!.text).toBe("tasks waiting for a native x86_64 host: 3 — none runs it natively: a native host takes them, and a lane on 4K pages the 2 a lane on 16K pages sent back");
  });

  it("a backlog that waits beside a free build of its arch is no prompt to add a host: an info line says what holds it", () => {
    // The Studio with room for two builds on its emulated x86_64 lane, and an x86_64 build held 90 minutes (a project copy's
    // placement, a pin): a new host would not take it sooner.
    const room = [row()].map((h) => fleetHostOf(h, studioLeases.slice(0, 3), NOW, RULES));
    const emulated = capacityOf([{ arch: "x86_64", n: 1, oldest: ago(90), needs_native: 0 }], room, [row()], [], NOW);
    expect(emulated[0].build_fits).toEqual({ native: false, emulated: true, emulated_4k: false });
    expect(capacityLines(emulated)).toEqual([{ level: "info", kind: "capacity", arch: "x86_64", text: "x86_64: 1 task queued, the oldest waited 1 h 30 min, while a host that claims has a build's units and disk free for it (free native units: 0, free emulated units: 4) — what holds them is their placement, a pin or their size, not the fleet's room" }]);
    // A native x86_64 host that claims with seven units free: the same, whatever the native waits.
    const vpsRow = vps();
    const native = capacityOf([{ arch: "x86_64", n: 2, oldest: ago(61), needs_native: 2 }], [fleetHostOf(vpsRow, [], NOW, RULES)], [vpsRow], [], NOW);
    expect(native[0]).toMatchObject({ free_native: 6, build_fits: { native: true, emulated: false } });
    expect(capacityLines(native).map((l) => [l.level, l.kind])).toEqual([["info", "capacity"], ["warn", "needs-native"]]);
    // One unit free on the native host (a build takes two): no free build, the warning.
    const tight: FleetLease[] = [1, 2, 3].map((id) => ({ id, lease_owner: "m2-vps-x86", kind: "build", arch: "x86_64", lane: "native", units: 2, size: 1 }));
    const full = capacityOf([{ arch: "x86_64", n: 1, oldest: ago(61), needs_native: 0 }], [fleetHostOf(vpsRow, tight, NOW, RULES)], [vpsRow], [], NOW);
    expect(full[0]).toMatchObject({ free_native: 0, build_fits: { native: false, emulated: false } });
    expect(capacityLines(full)).toEqual([expect.objectContaining({ level: "warn", kind: "capacity", text: "x86_64: 1 task queued, the oldest waited 1 h 1 min; free native units: 0, free emulated units: 0" })]);
  });

  it("units free on a host whose disk holds no further build are no free build: the warning stands, as a claim's room test would refuse it", () => {
    // A VPS with 80 GB free on its engine's data root running three builds (60 GB of budgets): one unit-pair still free, but a
    // fourth build's 20 GB and the 10 GB floor do not fit what is left — no build would lease there.
    const signed = { gb: RULES.gb_per_size, floor: RULES.floor_gb };
    expect(signed).toEqual({ gb: 20, floor: DISK_FLOOR_GB });
    const disky = vps({ units: 9, capacity: capOf({ cpus: 10, mem_gb: 20, units: 9, disk_free_gb: { work: 300, engine: 80 }, lanes: [{ arch: "x86_64", mode: "native" }] }) });
    const three: FleetLease[] = [1, 2, 3].map((id) => ({ id, lease_owner: "m2-vps-x86", kind: "build", arch: "x86_64", lane: "native", units: 2, size: 1, disk_gb: signed.gb }));
    const host = fleetHostOf(disky, three, NOW, RULES);
    expect(host).toMatchObject({ state: "claiming", units_busy: 6, units_free: 2, build_fits: false });
    const caps = capacityOf([{ arch: "x86_64", n: 2, oldest: ago(61), needs_native: 0 }], [host], [disky], [], NOW);
    expect(caps[0]).toMatchObject({ free_native: 2, build_fits: { native: false, emulated: false } });
    expect(capacityLines(caps)).toEqual([{ level: "warn", kind: "capacity", arch: "x86_64", text: "x86_64: 2 tasks queued, the oldest waited 1 h 1 min; free native units: 2, free emulated units: 0" }]);
    // Two builds held (40 GB): a third's 20 GB and the floor fit the 40 left — a free build, the info line.
    const two = fleetHostOf(disky, three.slice(0, 2), NOW, RULES);
    expect(two).toMatchObject({ units_free: 4, build_fits: true });
    expect(capacityLines(capacityOf([{ arch: "x86_64", n: 2, oldest: ago(61), needs_native: 0 }], [two], [disky], [], NOW)).map((l) => l.level)).toEqual(["info"]);
    // A lease that wrote no budget counts none, as selection's own read of the leases does (routes/factory.ts LEASES_HELD_SQL).
    expect(fleetHostOf(disky, three.map((l) => ({ ...l, disk_gb: null })), NOW, RULES).build_fits).toBe(true);
    // A host that does not claim fits nothing, whatever its room.
    expect(fleetHostOf(vps({ reg_last_seen: ago(15) }), [], NOW, RULES)).toMatchObject({ state: "not-claiming", build_fits: false });
  });

  it("the week's busy ratio per architecture and lane, against the units the hosts that run it have since they were confirmed", () => {
    const rows = [row({ confirmed_at: ago(3.5 * 24 * 60) }), vps({ confirmed_at: ago(30 * 24 * 60) })];
    const hosts = rows.map((h) => fleetHostOf(h, [], NOW, RULES));
    // The Studio: 11 units × 84 h; the VPS: 7 units × 168 h.
    const busy = [{ arch: "aarch64", lane: "native", unit_hours: 11 * 84 / 2 }, { arch: "x86_64", lane: "emulated", unit_hours: 11 * 84 / 4 }, { arch: "x86_64", lane: "native", unit_hours: 7 * 168 / 10 }];
    const caps = capacityOf([], hosts, rows, busy, NOW);
    expect(caps.find((c) => c.arch === "aarch64")!.busy_7d).toEqual({ all: 0.5, native: 0.5, emulated: null });
    const x = caps.find((c) => c.arch === "x86_64")!.busy_7d;
    expect(x.native).toBe(0.1);
    expect(x.emulated).toBe(0.25);
    expect(x.all).toBeCloseTo((11 * 84 / 4 + 7 * 168 / 10) / (11 * 84 + 7 * 168), 3);
    expect(capacityLines(caps)).toEqual([]);
  });
});

describe("the second opinion (fleet.ts secondOpinionOf)", () => {
  it("says the fleet's model mix and the share of last week's publish-bound audits that were independent: none, asking for another model on one host", () => {
    const mix = [{ agent: "claude-code/claude-sonnet-5", n: 3, hosts: 2 }];
    const s = secondOpinionOf(mix, [{ independent: "none", n: 3 }, { independent: "model", n: 1 }]);
    expect(s).toMatchObject({ audits: 4, none: 3, share_none: 0.75, mix: [{ provider: "claude-code", model: "claude-sonnet-5", registrations: 3, hosts: 2 }] });
    expect(s.line).toEqual({ level: "warn", kind: "second-opinion", text: "the fleet runs claude-code claude-sonnet-5 (3); 3 of last week's 4 publish-bound audits (75%) were independent: none — the same model judged the recipe it wrote: configure a different model on one host" });
    const two = secondOpinionOf([...mix, { agent: "openai/gpt-5", n: 1, hosts: 1 }], [{ independent: "model", n: 5 }]);
    expect(two.line).toEqual({ level: "info", kind: "second-opinion", text: "the fleet runs claude-code claude-sonnet-5 (3), openai gpt-5 (1); every one of last week's 5 publish-bound audits was by another model" });
    expect(secondOpinionOf([], []).line.text).toBe("no registration alive says which model it runs; no publish-bound audit last week");
    expect(span(61 * MIN)).toBe("1 h 1 min");
  });
});

// ---------- through the Worker ----------

interface Res { status: number; json: any; headers: Headers }
async function call(path: string, cookie?: string): Promise<Res> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : undefined), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: await res.clone().json().catch(() => null), headers: res.headers };
}
async function page(path: string): Promise<string> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res.text();
}
/** A page's script run over the Worker's real answers, as nobody signed in. */
function drawn(path: string) {
  const fetch = (p: string, init?: RequestInit) => {
    const ctx = createExecutionContext();
    return worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx).then(async (r) => { await waitOnExecutionContext(ctx); return r; });
  };
  return page(path).then((html) => runScript(scriptOf(html), { pathname: path, functions: [], fetch }));
}

let seq = 0;
/** A host and its registration as their rows stand after its claims and reports. */
async function seedHost(o: { id: string; name: string; owner: string; arch: string; lanes: unknown[]; units: number; report?: unknown; reportedAgo?: number; claimedAgo?: number; isolation?: string }) {
  const worker = `${o.owner}-${o.name}-${(++seq).toString(36).padStart(4, "0")}`;
  const now = Date.now();
  const cap = { cpus: o.units + 1, mem_gb: 2 * o.units + 2, disk_free_gb: { work: 410, engine: 220 }, lanes: o.lanes, held_lanes: [], agent_slots: 2, units: o.units, below_minimum: null };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO hosts (id, owner_login, owner_github_id, name, pubkey, status, os, arch, isolation, dedicated, capacity, lanes, units, agent_slots, disk_free, worker_id, confirmed_at, release_applied, report, reported_at, last_seen, agent_version)
                    VALUES (?, ?, 1001, ?, ?, 'active', 'linux', ?, ?, 1, ?, ?, ?, 2, '{"work":410,"engine":220}', ?, ?, 'v1.20.0', ?, ?, ?, '0.4.0')`)
      .bind(o.id, o.owner, o.name, toB64url(crypto.getRandomValues(new Uint8Array(32))), o.arch, o.isolation ?? "root", JSON.stringify(cap), JSON.stringify(o.lanes), o.units, worker, iso(now - 20 * 24 * 60 * MIN), o.report === undefined ? null : JSON.stringify(o.report), iso(now - (o.reportedAgo ?? 1) * MIN), iso(now - (o.reportedAgo ?? 1) * MIN)),
    env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, trust, trusted_by, last_seen, kind, host_id, kinds, agent, agent_status, version) VALUES (?, ?, ?, ?, 'project', ?, ?, 'host', ?, '[\"build\",\"trial\",\"audit\"]', 'claude-code/claude-sonnet-5', 'ok', 'v1.20.0')")
      .bind(worker, o.arch, o.owner, await sha256Hex(`omw_${worker}`), o.owner, iso(now - (o.claimedAgo ?? 0.5) * MIN), o.id),
  ]);
  return worker;
}
async function task(t: { arch: string; status?: string; owner?: string | null; ago?: number; params?: unknown; kind?: string; trust?: string; lane?: string; units?: number; lease?: string }): Promise<number> {
  const name = `pkg${++seq}`;
  return (await env.DB.prepare(
    `INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, status, publish, trust, owner, kind, params, created_at, lease_owner, lane, units, size, lease_gen, started_at, lease_expires_at)
     VALUES (?, ?, '1.0-1', ?, 'test', 100, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?) RETURNING id`,
  ).bind(name, t.arch, `https://github.com/x/${name}@v1:PKGBUILD`, t.status ?? "queued", t.trust ?? "project", t.owner ?? null, t.kind ?? "build", t.params === undefined ? null : JSON.stringify(t.params), iso(Date.now() - (t.ago ?? 0) * MIN),
    t.lease ?? null, t.lane ?? null, t.units ?? null, t.lease ? "g".repeat(32) : null, t.lease ? iso(Date.now() - 20 * MIN) : null, t.lease ? iso(Date.now() + 30 * MIN) : null).first<{ id: number }>())!.id;
}

let studioReg = "", legacyReg = "";
beforeAll(async () => {
  await env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES ('m1', ?, ?, 'maintainer', 1001), ('m2', ?, ?, 'maintainer', 1002)")
    .bind(await sha256Hex("omc_m1"), await sha256Hex("oms_m1"), await sha256Hex("omc_m2"), await sha256Hex("oms_m2")).run();
  // The Studio, full: five builds on its native lane (ten of its eleven units).
  studioReg = await seedHost({ id: "h_studio0001", name: "studio", owner: "m1", arch: "aarch64", lanes: STUDIO_LANES, units: 11 });
  for (let i = 0; i < 5; i++) await task({ arch: "aarch64", status: "leased", lease: studioReg, lane: "native", units: 2 });
  // A native x86_64 VPS gone silent twelve minutes ago, its last round a verify failure.
  await seedHost({ id: "h_vpsx860001", name: "vps-x86", owner: "m2", arch: "x86_64", lanes: [{ arch: "x86_64", mode: "native" }], units: 7, reportedAgo: 12, claimedAgo: 12, isolation: "subuid",
    report: { round: { at: iso(Date.now() - 12 * MIN), outcome: "refused", from: null, step: "verify", detail: "refused (signature): verify refused (signature): signature: the certificate chain does not hold up" } } });
  // The x86_64 backlog: three builds, the oldest 75 minutes, two of them sent back by an emulated lane.
  await task({ arch: "x86_64", ago: 75, params: { needs_native: 1 } });
  await task({ arch: "x86_64", ago: 40, params: { needs_native: 1 } });
  await task({ arch: "x86_64", ago: 10 });
  // A task lost on the Studio a few minutes ago, and one clamped to it.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('build', NULL, 'factory', 'warn', 'zstd for aarch64 lost', ?)").bind(JSON.stringify({ task: 4001, arch: "aarch64", worker: studioReg, attempts: 0, exhausted: false, final: false, needs_native: false, lost: true, oom: false })),
    env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('build', NULL, 'factory', 'warn', ?, ?)").bind(`chromium for aarch64 (task 4002) asked size 4; the largest host alive runs size 3: it runs clamped on ${studioReg}`, JSON.stringify({ task: 4002, name: "chromium", arch: "aarch64", asked: 4, size: 3, worker: studioReg, clamped: true })),
  ]);
  // Last week's audit of the project's copy of a package, by the model that built it.
  const copy = await task({ arch: "aarch64", status: "done", trust: "project", params: { review: 1 } });
  const audit = await task({ arch: "aarch64", status: "done", kind: "audit", params: { task: copy } });
  await env.DB.prepare("UPDATE build_tasks SET independent = 'none', finished_at = ? WHERE id = ?").bind(iso(Date.now() - 2 * 24 * 60 * MIN), audit).run();
  // A legacy registration: the Studio's review role container, until P3.
  legacyReg = "m1-studio-review-arm-0001";
  await env.DB.prepare("INSERT INTO build_workers (id, arch, owner, token_hash, trust, trusted_by, last_seen, labels, kinds, agent, agent_status) VALUES (?, 'aarch64', 'm1', ?, 'project', 'm1', ?, '{\"role\":\"review\",\"where\":\"omarchy-studio\"}', '[\"build\",\"audit\"]', 'openai/gpt-5', 'ok')")
    .bind(legacyReg, await sha256Hex(`omw_${legacyReg}`), iso(Date.now() - MIN)).run();
});

describe("GET /api/v1/hosts/fleet (#324)", () => {
  it("says the lines from what the claims, the reports and the journal left: public, a minute at the edge", async () => {
    const r = await call("/api/v1/hosts/fleet");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
    const f = r.json;
    expect(f.hosts.map((h: any) => [h.name, h.owner, h.state, h.units, h.units_busy, h.units_free, h.tasks, h.release, h.isolation, h.alive])).toEqual([
      ["studio", "m1", "full", 11, 10, 0, 5, "v1.20.0", "root", true],
      // Silent: not alive, whatever its last report's age (never "silent" beside "yes").
      ["vps-x86", "m2", "silent", 7, 0, 0, 0, "v1.20.0", "subuid", false],
    ]);
    const said = f.lines.map((l: any) => `${l.level} ${l.kind}${l.host ? ` ${l.host.name}` : ""}${l.arch ? ` ${l.arch}` : ""}`);
    expect(said).toEqual([
      "error refused vps-x86",
      "warn readopt-failed studio",
      "warn silent vps-x86",
      "warn clamped",
      "warn capacity x86_64",
      "warn needs-native x86_64",
      "warn second-opinion",
    ]);
    const line = (kind: string) => f.lines.find((l: any) => l.kind === kind).text;
    // A host that stops reporting shows within ten minutes; a verify failure is an error with the failed check.
    expect(line("silent")).toMatch(/^silent for 12 min: nothing of it reached the pool since/);
    expect(line("refused")).toContain("its agent's verify failed the signature check");
    // The x86_64 backlog, no free x86_64 build for over an hour: the free units native and emulated, the native waits counted.
    expect(line("capacity")).toBe("x86_64: 3 tasks queued, the oldest waited 1 h 15 min; free native units: 0, free emulated units: 0");
    expect(line("needs-native")).toBe("tasks waiting for a native x86_64 host: 2");
    expect(line("readopt-failed")).toContain("(#4001)");
    expect(line("clamped")).toContain("chromium for aarch64 (task 4002) asked size 4");
    // The second opinion: the mix of the registrations alive, and last week's publish-bound audit that was independent: none.
    expect(f.second_opinion).toMatchObject({ audits: 1, none: 1, share_none: 1 });
    expect(f.second_opinion.mix.map((m: any) => m.agent).sort()).toEqual(["claude-code/claude-sonnet-5", "openai/gpt-5"]);
    expect(line("second-opinion")).toContain("1 of last week's 1 publish-bound audits (100%) were independent: none");
    const x86 = f.capacity.find((c: any) => c.arch === "x86_64");
    expect(x86).toMatchObject({ queued: 3, oldest_wait_min: 75, free_native: 0, free_emulated: 0, needs_native: 2, hosts_native: 1, hosts_emulated: 1 });
    // The Studio's leases this week: twenty minutes each, two units, against eleven units since it was confirmed (a week of it).
    expect(f.capacity.find((c: any) => c.arch === "aarch64").busy_7d.native).toBeCloseTo((5 * 2 * 20 / 60) / (11 * 7 * 24), 3);
  });
});

describe("Status draws the fleet's lines (#324)", () => {
  it("each line with its host linked, the error marked, the capacity per architecture, the second opinion", async () => {
    const d = await drawn("/status");
    for (let i = 0; i < 100 && !/st-fl/.test(d.nodes["#fleet-lines"]?.innerHTML ?? ""); i++) await new Promise((r) => setTimeout(r, 30));
    const lines = d.nodes["#fleet-lines"].innerHTML as string;
    expect(lines).toContain('<p class="st-fl fail"><span class="st-dot fail" aria-hidden="true"></span><span><b>error</b> · <a href="/hosts/h_vpsx860001">vps-x86</a> of m2: refused: its agent\'s verify failed the signature check');
    expect(lines).toContain('<a href="/hosts/h_vpsx860001">vps-x86</a> of m2: silent for 12 min');
    expect(lines).toContain("x86_64: 3 tasks queued, the oldest waited 1 h 15 min; free native units: 0, free emulated units: 0");
    expect(lines).toContain("tasks waiting for a native x86_64 host: 2");
    expect(lines).not.toContain("second-opinion");
    expect(d.nodes["#fleet-capacity"].innerHTML).toContain("<tr><td>x86_64</td><td class=\"num\">3</td>");
    expect(d.nodes["#fleet-second"].innerHTML).toContain("Second opinion: the fleet runs");
    expect(d.nodes["#fleet-note"].textContent).toBe("2 hosts · 1 error · 5 warnings · which architecture needs a host next");
  });

  it("at 1280 a line wraps, never cut, and the table per architecture scrolls in its card; its colours are the themes' tokens", async () => {
    const html = await page("/status");
    expect(declared(html, ".st-fl")).toMatchObject({ "overflow-wrap": "anywhere", "grid-template-columns": "8px minmax(0, 1fr)" });
    expect(declared(html, ".st-scroll")).toMatchObject({ "overflow-x": "auto" });
    expect(declared(html, ".st-cap-t")).toMatchObject({ "min-width": "640px" });
    const rules = [...html.matchAll(/^\s*\.st-(fl|cap-t)\b[^\n]*$/gm)].map((m) => m[0]).join("\n");
    expect(rules).toContain("var(--");
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    // The section is served to everyone, not hidden; its heading names it.
    expect(html).toMatch(/<section class="op-card st-fleet" id="fleet" aria-labelledby="fleet-h">/);
  });
});

describe("the Workers page by host (#324, design v2 §18.2)", () => {
  it("lists the hosts with their units and lanes; the legacy registrations as such, a host's own registration never among them", async () => {
    const html = await page("/workers");
    expect(html).toContain("<h2>Hosts</h2>");
    expect(html).toContain("<h2>Legacy registrations</h2>");
    const d = await drawn("/workers");
    for (let i = 0; i < 100 && !/hosts\/h_/.test(d.nodes["#hosts-table tbody"]?.innerHTML ?? ""); i++) await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 100 && !(d.nodes["#w-review tbody"]?.innerHTML ?? "").includes(legacyReg); i++) await new Promise((r) => setTimeout(r, 30));
    const hosts = d.nodes["#hosts-table tbody"].innerHTML as string;
    expect(hosts).toContain('<a href="/hosts/h_studio0001">studio</a> <span class="pill blue">full</span>');
    expect(hosts).toContain('aarch64 <span class="muted">native</span><br>x86_64 <span class="muted">emulated (qemu, 16K pages)</span>');
    expect(hosts).toContain('<td class="num">10 / 0</td><td class="num">5</td><td><span class="mono">v1.20.0</span></td><td><span class="mono">root</span> <span class="muted">dedicated</span></td><td>yes</td>');
    expect(hosts).toContain('<a href="/hosts/h_vpsx860001">vps-x86</a> <span class="pill warn">silent</span>');
    expect(hosts).toContain('<td><span class="muted" title="silent: nothing of it reached the pool in the last 10 minutes">no</span></td>');
    expect(d.nodes["#hosts-note"].textContent).toBe("2 hosts · 1 alive · 10 of 18 units busy · 5 tasks");
    // The legacy tables: the role container, not the hosts' own registrations.
    const legacy = ["#w-project tbody", "#w-review tbody", "#w-community tbody"].map((t) => d.nodes[t]?.innerHTML ?? "").join("");
    expect(legacy).toContain(legacyReg);
    expect(legacy).not.toContain(studioReg);
  });
});

describe("the fleet's statements (#324)", () => {
  it("read through the indexes, the week's sums a pass over the tasks as the stats' weekly series", async () => {
    const plan = async (sql: string, args: unknown[] = []) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map((r) => r.detail).join("; ");
    const now = new Date().toISOString();
    // The queue per architecture: the queued rows of the queue index, no other.
    expect(await plan(QUEUE_BY_ARCH_SQL)).toMatch(/USING (COVERING )?INDEX idx_build_tasks_queue \(status=\?\)/);
    // A host's leases, and the fleet's: the leased rows by the status-led indexes, never the whole table.
    for (const [sql, args] of [[HOST_LEASES_SQL, ["m1-studio-0001"]], [FLEET_LEASES_SQL, []]] as const) expect(await plan(sql, [...args]), sql).toMatch(/build_tasks USING INDEX idx_build_tasks_(lease|queue) \(status=\?/);
    // The journal's last day of build lines: the kind index, from the time on.
    expect(await plan(FLEET_EVENTS_SQL, [now])).toMatch(/USING INDEX idx_events_kind \(kind=\? AND created_at>\?\)/);
    // Last week's audits: the kind index, each audited build by its primary key.
    const audits = await plan(AUDITS_7D_SQL, [now]);
    expect(audits).toMatch(/a USING INDEX idx_build_tasks_kind \(kind=\? AND status=\?\)/);
    expect(audits).toMatch(/b EXISTS USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    // The registrations alive: their table, a few dozen rows.
    expect(await plan(MODEL_MIX_SQL, [now])).toMatch(/build_workers/);
    // The week's busy hours: one pass over the tasks — the fleet's read is a minute at the edge, as the stats' are.
    expect(await plan(BUSY_7D_SQL, [now, now])).toMatch(/build_tasks/);
  });
});
