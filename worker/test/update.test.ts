// Every worker follows the latest image (src/update.ts): what the pool
// makes of the release a worker reports, and when it stops handing it work.
import { describe, expect, it } from "vitest";
import { gateWords, isRevoked, lastGoodMessage, lastGoodUntil, parseTag, quarantinedNow, revertAfter, soakGraceUntil, updateState, updateMessage, LAST_GOOD_HOURS, SOAK_GRACE_MAX_MINUTES, SOAK_ROUND_MINUTES, UPDATE_GRACE_MINUTES, type ReleasePolicy } from "../src/update";

const pool = (version: string, deployedMinutesAgo: number | null) => ({
  version, commit: null, release_url: null, commit_url: null, analytics: "",
  deployed_at: deployedMinutesAgo === null ? null : new Date(Date.now() - deployedMinutesAgo * 60000).toISOString(),
});

describe("the latest image", () => {
  it("reads a release tag and nothing else", () => {
    expect(parseTag("v0.0.177")).toEqual([0, 0, 177]);
    expect(parseTag("1.2.3")).toEqual([1, 2, 3]);
    for (const v of ["dev", "container", "test", "", null, undefined, "v1.2", "v1.2.3-rc1"]) expect(parseTag(v as string)).toBeNull();
  });
  it("a worker on the pool's release, or ahead of it, is current", () => {
    expect(updateState("v0.0.177", pool("v0.0.177", 120))).toMatchObject({ outdated: false, behind: 0, required: false });
    expect(updateState("v0.0.178", pool("v0.0.177", 120))).toMatchObject({ outdated: false, behind: 0, required: false });
  });
  it("one behind within the rollout's grace works on; past it, it is handed nothing", () => {
    expect(updateState("v0.0.176", pool("v0.0.177", UPDATE_GRACE_MINUTES - 5))).toMatchObject({ outdated: true, behind: 1, required: false });
    expect(updateState("v0.0.176", pool("v0.0.177", UPDATE_GRACE_MINUTES + 5))).toMatchObject({ outdated: true, behind: 1, required: true });
    expect(updateState("v0.0.167", pool("v0.0.177", 600))).toMatchObject({ outdated: true, behind: 10, required: true, yours: "v0.0.167", latest: "v0.0.177" });
  });
  it("the grace covers one release only: two behind, or behind across a minor, is refused at once", () => {
    expect(updateState("v0.0.175", pool("v0.0.177", 5))).toMatchObject({ outdated: true, behind: 2, required: true });
    expect(updateState("v0.0.177", pool("v0.1.0", 5))).toMatchObject({ outdated: true, behind: null, required: true });
    expect(updateState("v0.0.177", pool("v0.1.0", 600))).toMatchObject({ outdated: true, behind: null, required: true });
  });
  it("a version the pool cannot read — a dev build, a container that reports none, a pool without a deploy time — never refuses", () => {
    expect(updateState("container", pool("v0.0.177", 600))).toMatchObject({ outdated: false, behind: null, required: false, yours: null });
    expect(updateState(undefined, pool("v0.0.177", 600))).toMatchObject({ required: false });
    expect(updateState("v0.0.1", pool("dev", 600))).toMatchObject({ required: false, latest: "dev" });
    expect(updateState("v0.0.1", pool("v0.0.177", null))).toMatchObject({ outdated: true, behind: 176, required: false });
    expect(updateState("v0.0.170", pool("v0.0.177", null))).toMatchObject({ required: false });
  });
  it("says it in one line, with the count when it has one", () => {
    expect(updateMessage(updateState("v0.0.167", pool("v0.0.177", 600)))).toBe("this worker runs v0.0.167; the pool is at v0.0.177 (10 releases behind) — every worker follows the latest image: update it (/docs/workers#update) and it works again; on a host the agent manages, nothing needs to be run");
    expect(updateMessage(updateState("v0.0.176", pool("v0.0.177", 600)))).toContain("(1 release behind)");
    expect(updateMessage(updateState("v0.0.177", pool("v0.1.0", 600)))).not.toContain("behind)");
  });
});

// A host that reverted the pool's release claims on its last-good for six hours (#342, design v2 §8.6, D55), and a revoked
// release is handed nothing: the gate on a fake clock, with a policy of its own (the signed manifest's is the default).
describe("a host that reverted the pool's release, and revoked releases", () => {
  const HOUR = 3600e3;
  const T0 = Date.parse("2026-11-10T12:00:00Z");
  const POLICY: ReleasePolicy = { min_release: "v1.18.0", revoked: ["v1.19.5"] };
  /** `hours` after the pool's deploy (T0). */
  const at = (hours: number) => T0 + hours * HOUR;
  const POOL = { version: "v1.20.2", deployed_at: new Date(T0).toISOString() };
  /** Its agent reverted v1.20.2 an hour after the deploy and runs its last-good, v1.20.1. */
  const REVERTED = { from: "v1.20.2", at: new Date(at(1)).toISOString(), applied: "v1.20.1" };

  it("claims on its last-good past the grace for six hours after the pool heard of the revert, with the time it ends", () => {
    const end = new Date(at(1 + LAST_GOOD_HOURS)).toISOString();
    for (const h of [1, 2, 6.5]) {
      expect(updateState("v1.20.1", POOL, at(h), null, REVERTED, POLICY), `${h} h`).toMatchObject({ outdated: true, behind: 1, required: false, last_good_until: end });
    }
    // Two releases behind, refused at once without it, is the same: the exception is the revert's, not the grace's.
    const two = { version: "v1.20.3", deployed_at: POOL.deployed_at };
    expect(updateState("v1.20.1", two, at(2), null, { ...REVERTED, from: "v1.20.3" }, POLICY)).toMatchObject({ behind: 2, required: false, last_good_until: end });
    expect(updateState("v1.20.1", two, at(2), null, null, POLICY)).toMatchObject({ behind: 2, required: true });
    expect(lastGoodMessage(updateState("v1.20.1", POOL, at(2), null, REVERTED, POLICY))).toBe(`its agent reverted v1.20.2: claiming on last-good v1.20.1 until ${end}, then refused like any registration behind the pool's release`);
    // Within the grace it needs none.
    const early = updateState("v1.20.1", POOL, T0 + 10 * 60000, null, { ...REVERTED, at: POOL.deployed_at }, POLICY);
    expect(early).toMatchObject({ required: false });
    expect(early.last_good_until).toBeUndefined();
    expect(lastGoodMessage(early)).toBeNull();
  });

  it("is refused with 426 once the six hours are over", () => {
    expect(updateState("v1.20.1", POOL, at(1 + LAST_GOOD_HOURS), null, REVERTED, POLICY)).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(1 + LAST_GOOD_HOURS) - 1, null, REVERTED, POLICY)).toMatchObject({ required: false });
    expect(updateState("v1.20.1", POOL, at(30), null, REVERTED, POLICY).last_good_until).toBeUndefined();
  });

  it("never below the signed min_release, never on a revoked release, never on another release than the one its agent applied", () => {
    expect(updateState("v1.20.1", POOL, at(2), null, REVERTED, { ...POLICY, min_release: "v1.20.2" })).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(2), null, REVERTED, { ...POLICY, min_release: "v1.20.1" })).toMatchObject({ required: false });
    expect(updateState("v1.20.1", POOL, at(2), null, REVERTED, { ...POLICY, revoked: ["v1.20.1"] })).toMatchObject({ required: true, revoked: true });
    // Its dispatcher claims on what its agent did not apply (an older image left behind): no exception for it.
    expect(updateState("v1.20.0", POOL, at(2), null, REVERTED, POLICY)).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(2), null, { ...REVERTED, applied: null }, POLICY)).toMatchObject({ required: true });
  });

  it("only for the pool's own release: a revert of another release, a registration without one, or a time the pool cannot read give none", () => {
    expect(updateState("v1.20.1", POOL, at(2), null, { ...REVERTED, from: "v1.20.9" }, POLICY)).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(2), null, null, POLICY)).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(2), null, { ...REVERTED, at: null }, POLICY)).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(2), null, { ...REVERTED, at: "yesterday" }, POLICY)).toMatchObject({ required: true });
    expect(lastGoodUntil(REVERTED, "v1.20.2", "v1.20.2", at(2), POLICY)).toBeNull();
  });

  it("a revoked release is handed nothing at once, whatever the grace and whatever the pool runs; a release it does not name is not", () => {
    expect(isRevoked("v1.19.5", POLICY)).toBe(true);
    expect(isRevoked("1.19.5", POLICY)).toBe(true);
    for (const v of ["v1.19.4", "dev", "container", null, undefined]) expect(isRevoked(v, POLICY)).toBe(false);
    const revoking = { ...POLICY, revoked: ["v1.20.1"] };
    expect(updateState("v1.20.1", POOL, T0 + 60000, null, null, revoking)).toMatchObject({ outdated: true, behind: 1, required: true, revoked: true });
    expect(updateState("v1.20.1", { version: "dev", deployed_at: null }, T0, null, null, revoking)).toMatchObject({ outdated: false, required: true, revoked: true });
    expect(updateState("v1.20.1", POOL, T0 + 60000, null, null, POLICY)).toMatchObject({ required: false });
    expect(updateState("v1.20.1", POOL, T0 + 60000, null, null, POLICY).revoked).toBeUndefined();
    expect(updateMessage(updateState("v1.20.1", POOL, T0, null, null, revoking))).toMatch(/^this worker runs v1\.20\.1, a release the pool's release \(v1\.20\.2\) revokes — it is handed nothing/);
  });

  it("the pool keeps the release a host reverted while its reports hold it back, and the time it first heard of it", () => {
    const none = { from: null, at: null };
    const t = (h: number) => new Date(at(h)).toISOString();
    // The round after the revert says it, with the release it left.
    const reverted = revertAfter(none, { round: { outcome: "rolled-back", from: "v1.20.2" }, release: { applied: "v1.20.1" }, quarantine: [{ release: "v1.20.2", until: t(2) }] }, t(1));
    expect(reverted).toEqual({ from: "v1.20.2", at: t(1) });
    // The next rounds say `held` while it waits in quarantine: kept, its time with it.
    const held = { round: { outcome: "held", from: null }, release: { applied: "v1.20.1" }, quarantine: [{ release: "v1.20.2", until: null }] };
    expect(revertAfter(reverted, held, t(3))).toEqual(reverted);
    // Its one retry reverts again: still the first time, so a retry does not start the six hours again.
    expect(revertAfter(reverted, { round: { outcome: "rolled-back", from: "v1.20.2" } }, t(2))).toEqual(reverted);
    // An Update lifted the quarantine and the round runs toward it again: kept.
    expect(revertAfter(reverted, { round: { outcome: "held" }, rollout: { state: "pull", target: "v1.20.2" }, release: { applied: "v1.20.1" }, quarantine: [] }, t(4))).toEqual(reverted);
    // It applied the release, or a later one: forgotten.
    expect(revertAfter(reverted, { round: { outcome: "ok" }, release: { applied: "v1.20.2" }, quarantine: [{ release: "v1.20.2", until: null }] }, t(5))).toEqual(none);
    expect(revertAfter(reverted, { round: { outcome: "ok" }, release: { applied: "v1.20.3" }, quarantine: [] }, t(5))).toEqual(none);
    // A report that neither holds it nor rolls toward it: forgotten.
    expect(revertAfter(reverted, { round: { outcome: "no-change" }, release: { applied: "v1.20.1" }, quarantine: [] }, t(5))).toEqual(none);
    // A revert of another release starts its own time.
    expect(revertAfter(reverted, { round: { outcome: "rolled-back", from: "v1.20.3" } }, t(6))).toEqual({ from: "v1.20.3", at: t(6) });
    // What is not a release is no revert.
    expect(revertAfter(none, { round: { outcome: "rolled-back", from: "latest" } }, t(1))).toEqual(none);
    expect(revertAfter(none, { round: "rolled-back", quarantine: "all" }, t(1))).toEqual(none);
  });
});

// An owner's soak (#326, design v2 D16): on a fake clock, a host whose owner set a 30-minute soak, its registration on v1.0.2 while
// the pool deploys v1.0.3 and, ten minutes later, v1.0.4 — two releases land during the soak. Its agent reports when the soak of the
// release the pool names ends; the pool's grace follows it, the round's 15 minutes after, at most two hours after the deploy.
describe("a soaking host's grace", () => {
  const T0 = Date.parse("2027-01-15T08:00:00.000Z");
  const MIN = 60000;
  const at = (m: number) => T0 + m * MIN;
  const iso = (m: number) => new Date(at(m)).toISOString();
  const deployed = (version: string, m: number) => ({ version, deployed_at: iso(m) });
  // Each quarantined release until a newer one, as the agent says it (`until` null), unless given with the minute it ends.
  const soak = (untilMin: number | null, quarantined: (string | [string, number])[] = []) => ({
    until: untilMin === null ? null : iso(untilMin),
    quarantined: quarantined.map((q) => (typeof q === "string" ? { release: q, until: null } : { release: q[0], until: iso(q[1]) })),
  });

  it("is not refused during the soak, even when two releases land in it, and is once it and its round's margin end", () => {
    // v1.0.3 at T0: the agent soaks it until T0+30.
    const first = deployed("v1.0.3", 0);
    expect(updateState("v1.0.2", first, at(10), soak(30))).toMatchObject({ behind: 1, required: false });
    // v1.0.4 lands at T0+10: two behind — refused at once without a soak —, the agent soaks v1.0.4 until T0+40.
    const second = deployed("v1.0.4", 10);
    expect(updateState("v1.0.2", second, at(11))).toMatchObject({ behind: 2, required: true });
    for (const m of [11, 20, 30, 39]) {
      const u = updateState("v1.0.2", second, at(m), soak(40));
      expect(u, `T0+${m}`).toMatchObject({ outdated: true, behind: 2, required: false, soaking_until: iso(40 + SOAK_ROUND_MINUTES) });
    }
    // The soak over, its round runs: the agent still reports when it ended, and the grace covers the round's margin...
    expect(updateState("v1.0.2", second, at(40 + SOAK_ROUND_MINUTES - 1), soak(40))).toMatchObject({ required: false });
    // ... and not one minute more.
    const late = updateState("v1.0.2", second, at(40 + SOAK_ROUND_MINUTES), soak(40));
    expect(late).toMatchObject({ required: true });
    expect(late.soaking_until).toBeUndefined();
    // Once it runs v1.0.4, nothing to grace: current.
    expect(updateState("v1.0.4", second, at(45), soak(null))).toMatchObject({ outdated: false, required: false });
  });

  it("never exceeds two hours after the deploy, whatever the soak says", () => {
    const pool = deployed("v1.0.4", 0);
    expect(SOAK_GRACE_MAX_MINUTES).toBe(120);
    const long = soak(600);
    expect(updateState("v1.0.2", pool, at(SOAK_GRACE_MAX_MINUTES - 1), long)).toMatchObject({ required: false, soaking_until: iso(SOAK_GRACE_MAX_MINUTES) });
    expect(updateState("v1.0.2", pool, at(SOAK_GRACE_MAX_MINUTES), long)).toMatchObject({ required: true });
    expect(soakGraceUntil(long, [1, 0, 4], at(0), at(SOAK_GRACE_MAX_MINUTES + 1))).toBeNull();
    // The longest soak an owner may set (100 minutes: crates/omarchy-agent run/config.rs MAX_SOAK_MINUTES), its clock started by a
    // first poll two minutes after the deploy: the soak and the round's margin after it fit inside the two hours, never refused.
    const AGENT_MAX_SOAK = 100, firstPoll = 2;
    const longest = soak(firstPoll + AGENT_MAX_SOAK);
    expect(firstPoll + AGENT_MAX_SOAK + SOAK_ROUND_MINUTES).toBeLessThan(SOAK_GRACE_MAX_MINUTES);
    for (const m of [firstPoll, 60, firstPoll + AGENT_MAX_SOAK, firstPoll + AGENT_MAX_SOAK + SOAK_ROUND_MINUTES - 1]) {
      expect(updateState("v1.0.2", pool, at(m), longest), `T0+${m}`).toMatchObject({ required: false, soaking_until: iso(firstPoll + AGENT_MAX_SOAK + SOAK_ROUND_MINUTES) });
    }
    // A soak that ended before the grace would have — still the plain 45 minutes for one behind.
    expect(updateState("v1.0.3", pool, at(UPDATE_GRACE_MINUTES - 1), soak(5))).toMatchObject({ required: false });
    expect(updateState("v1.0.3", pool, at(UPDATE_GRACE_MINUTES + 1), soak(5))).toMatchObject({ required: true });
  });

  it("gives none to a host that holds the pool's release in quarantine now; another release quarantined, or a quarantine that ended, does not count", () => {
    const pool = deployed("v1.0.4", 0);
    expect(updateState("v1.0.2", pool, at(10), soak(30, ["v1.0.4"]))).toMatchObject({ required: true });
    expect(updateState("v1.0.2", pool, at(10), soak(30, [["v1.0.4", 20]]))).toMatchObject({ required: true });
    expect(updateState("v1.0.2", pool, at(10), soak(30, ["v1.0.3"]))).toMatchObject({ required: false });
    // Its quarantine of the pool's release ended: it waits for that release again, and soaks it.
    expect(updateState("v1.0.2", pool, at(10), soak(30, [["v1.0.4", 5]]))).toMatchObject({ required: false });
    // It reverted v1.0.5, then the pool rolled back to v1.0.4 (rollback.yml): it waits for v1.0.4 and soaks it, as its agent says.
    expect(updateState("v1.0.2", pool, at(10), soak(30, ["v1.0.5"]))).toMatchObject({ required: false, soaking_until: iso(45) });
    expect(quarantinedNow(soak(30, ["v1.0.5", ["v1.0.4", 20]]), [1, 0, 4], at(10))).toEqual({ release: "v1.0.4", until: iso(20) });
    expect(quarantinedNow(soak(30, ["v1.0.5", ["v1.0.4", 20]]), [1, 0, 4], at(20))).toBeNull();
    // An end the pool cannot read holds, as "until a newer release" does.
    expect(quarantinedNow({ until: iso(30), quarantined: [{ release: "v1.0.4", until: "soon" }] }, [1, 0, 4], at(10))).not.toBeNull();
    // A report's soak that is no time, or none, is no soak.
    expect(updateState("v1.0.2", pool, at(10), { until: "soon", quarantined: [] })).toMatchObject({ required: true });
    expect(updateState("v1.0.2", pool, at(10), null)).toMatchObject({ required: true });
    // A pool with no deploy time refuses nobody, soak or not.
    expect(updateState("v1.0.2", { version: "v1.0.4", deployed_at: null }, at(10), soak(30))).toMatchObject({ required: false });
  });

  it("the host page explains its 426: the soak's grace, the plain grace, and what ended them", () => {
    const pool = deployed("v1.0.4", 0);
    const words = (m: number, s: ReturnType<typeof soak> | null) => gateWords(updateState("v1.0.2", pool, at(m), s), s, pool.deployed_at, at(m));
    expect(gateWords(updateState("v1.0.4", pool, at(5)), null, pool.deployed_at)).toBeNull();
    expect(words(10, soak(30))).toBe(`its registration runs v1.0.2, the pool v1.0.4 (2 releases behind): it claims through its owner's soak, until ${iso(45)} — the pool's grace follows the soak its agent reports, 15 minutes past its end for the round, at most 2 hours after the deploy`);
    expect(gateWords(updateState("v1.0.3", pool, at(10)), null, pool.deployed_at)).toBe("its registration runs v1.0.3, the pool v1.0.4 (1 release behind): within the rollout's grace (45 minutes after the deploy, one release behind at most); its agent rolls the release out");
    expect(words(10, null)).toBe("refused with 426 — its registration runs v1.0.2, the pool v1.0.4 (2 releases behind): past the rollout's grace (45 minutes after the deploy, one release behind at most), and its agent reports no soak");
    expect(words(10, soak(30, ["v1.0.4"]))).toContain("it holds v1.0.4 in quarantine — its guard reverted it — so its soak gives no grace");
    expect(words(10, soak(30, [["v1.0.4", 15]]))).toContain("it holds v1.0.4 in quarantine");
    expect(words(60, soak(30))).toContain(`its soak ended at ${iso(30)} and its round has not brought the release yet`);
    expect(words(121, soak(200))).toContain(`past the pool's grace for a soak, which ends 2 hours after the deploy (${iso(120)})`);
  });
});

// The soak (#326) and the last-good (#342) at one gate, on a fake clock: a revoked release is never held by a soak, a host on its
// last-good is never judged behind for a soak that gives none, and the host page says which rule it claims by, or what ended it.
describe("a soaking host, a host on its last-good, and a revoked release at one gate", () => {
  const T0 = Date.parse("2027-02-01T08:00:00.000Z");
  const MIN = 60000;
  const at = (m: number) => T0 + m * MIN;
  const iso = (m: number) => new Date(at(m)).toISOString();
  const POOL = { version: "v1.0.4", deployed_at: iso(0) };
  const POLICY: ReleasePolicy = { min_release: "v1.0.0", revoked: [] };
  const soak = (untilMin: number, quarantined: string[] = []) => ({ until: iso(untilMin), quarantined: quarantined.map((release) => ({ release, until: null })) });
  // Its agent reverted v1.0.4 at T0+30 and runs its last-good, v1.0.3.
  const REVERTED = { from: "v1.0.4", at: iso(30), applied: "v1.0.3" };

  it("a revoked release is refused whatever its host's soak says, and the page says why", () => {
    const revoking = { ...POLICY, revoked: ["v1.0.2"] };
    const u = updateState("v1.0.2", POOL, at(10), soak(30), null, revoking);
    expect(u).toMatchObject({ required: true, revoked: true });
    expect(u.soaking_until).toBeUndefined();
    // Not revoked, the same soak holds it.
    expect(updateState("v1.0.2", POOL, at(10), soak(30), null, POLICY)).toMatchObject({ required: false, soaking_until: iso(45) });
    expect(gateWords(u, soak(30), POOL.deployed_at, at(10))).toBe("refused with 426 — its registration runs v1.0.2, a release the pool's release (v1.0.4) revokes: it is handed nothing whatever the grace, its soak or its last-good, and nothing its tasks send on that release is taken");
    // Nor does a revert of the pool's release hold a revoked last-good.
    expect(updateState("v1.0.3", POOL, at(60), soak(90), REVERTED, { ...POLICY, revoked: ["v1.0.3"] })).toMatchObject({ required: true, revoked: true });
  });

  it("a host on its last-good claims though its soak gives no grace (it holds the pool's release in quarantine), until the six hours end", () => {
    const held = soak(90, ["v1.0.4"]);
    const u = updateState("v1.0.3", POOL, at(60), held, REVERTED, POLICY);
    expect(u).toMatchObject({ outdated: true, behind: 1, required: false, last_good_until: iso(30 + LAST_GOOD_HOURS * 60) });
    expect(u.soaking_until).toBeUndefined();
    expect(gateWords(u, held, POOL.deployed_at, at(60), REVERTED)).toBe(`its registration runs v1.0.3, the pool v1.0.4 (1 release behind): its agent reverted v1.0.4, so it claims on its last-good until ${iso(30 + LAST_GOOD_HOURS * 60)} (6 hours after the pool heard of the revert), then it is refused like any registration behind the pool's release`);
    // Past the six hours: refused, and the page says the last-good ended rather than the quarantine's soak.
    const late = at(30 + LAST_GOOD_HOURS * 60);
    const over = updateState("v1.0.3", POOL, late, held, REVERTED, POLICY);
    expect(over).toMatchObject({ required: true });
    expect(gateWords(over, held, POOL.deployed_at, late, REVERTED)).toBe(`refused with 426 — its registration runs v1.0.3, the pool v1.0.4 (1 release behind): its agent reverted v1.0.4, and its 6 hours on its last-good ended at ${iso(30 + LAST_GOOD_HOURS * 60)}: Retry release, or the release after it`);
    // On another release than the one its agent applied, inside the six hours: refused, and the page says what the gate takes.
    const other = updateState("v1.0.2", POOL, at(60), held, REVERTED, POLICY);
    expect(other).toMatchObject({ required: true });
    expect(gateWords(other, held, POOL.deployed_at, at(60), REVERTED)).toContain("its agent reverted v1.0.4, but the gate takes a claim on its last-good only on the release its agent applied (v1.0.3)");
  });

  it("where both would hold, the last-good is the rule it claims by: the soak's grace never shortens its six hours", () => {
    // An Update lifted the quarantine and its agent reports a soak again, while the pool still keeps the revert.
    const u = updateState("v1.0.3", POOL, at(60), soak(90), REVERTED, POLICY);
    expect(u).toMatchObject({ required: false, last_good_until: iso(30 + LAST_GOOD_HOURS * 60) });
    expect(u.soaking_until).toBeUndefined();
    // Past the soak's two hours after the deploy, the last-good still holds.
    expect(updateState("v1.0.3", POOL, at(SOAK_GRACE_MAX_MINUTES + 60), soak(90), REVERTED, POLICY)).toMatchObject({ required: false, last_good_until: iso(30 + LAST_GOOD_HOURS * 60) });
    // A soaking host that reverted nothing keeps the soak's grace alone.
    expect(updateState("v1.0.3", POOL, at(60), soak(90), null, POLICY)).toMatchObject({ required: false, soaking_until: iso(90 + SOAK_ROUND_MINUTES) });
  });
});
