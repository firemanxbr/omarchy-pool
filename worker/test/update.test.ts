// Every worker follows the latest image (src/update.ts): what the pool
// makes of the release a worker reports, and when it stops handing it work.
import { describe, expect, it } from "vitest";
import { isRevoked, lastGoodMessage, lastGoodUntil, parseTag, revertAfter, updateState, updateMessage, LAST_GOOD_HOURS, UPDATE_GRACE_MINUTES, type ReleasePolicy } from "../src/update";

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
      expect(updateState("v1.20.1", POOL, at(h), REVERTED, POLICY), `${h} h`).toMatchObject({ outdated: true, behind: 1, required: false, last_good_until: end });
    }
    // Two releases behind, refused at once without it, is the same: the exception is the revert's, not the grace's.
    const two = { version: "v1.20.3", deployed_at: POOL.deployed_at };
    expect(updateState("v1.20.1", two, at(2), { ...REVERTED, from: "v1.20.3" }, POLICY)).toMatchObject({ behind: 2, required: false, last_good_until: end });
    expect(updateState("v1.20.1", two, at(2), null, POLICY)).toMatchObject({ behind: 2, required: true });
    expect(lastGoodMessage(updateState("v1.20.1", POOL, at(2), REVERTED, POLICY))).toBe(`its agent reverted v1.20.2: claiming on last-good v1.20.1 until ${end}, then refused like any registration behind the pool's release`);
    // Within the grace it needs none.
    const early = updateState("v1.20.1", POOL, T0 + 10 * 60000, { ...REVERTED, at: POOL.deployed_at }, POLICY);
    expect(early).toMatchObject({ required: false });
    expect(early.last_good_until).toBeUndefined();
    expect(lastGoodMessage(early)).toBeNull();
  });

  it("is refused with 426 once the six hours are over", () => {
    expect(updateState("v1.20.1", POOL, at(1 + LAST_GOOD_HOURS), REVERTED, POLICY)).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(1 + LAST_GOOD_HOURS) - 1, REVERTED, POLICY)).toMatchObject({ required: false });
    expect(updateState("v1.20.1", POOL, at(30), REVERTED, POLICY).last_good_until).toBeUndefined();
  });

  it("never below the signed min_release, never on a revoked release, never on another release than the one its agent applied", () => {
    expect(updateState("v1.20.1", POOL, at(2), REVERTED, { ...POLICY, min_release: "v1.20.2" })).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(2), REVERTED, { ...POLICY, min_release: "v1.20.1" })).toMatchObject({ required: false });
    expect(updateState("v1.20.1", POOL, at(2), REVERTED, { ...POLICY, revoked: ["v1.20.1"] })).toMatchObject({ required: true, revoked: true });
    // Its dispatcher claims on what its agent did not apply (an older image left behind): no exception for it.
    expect(updateState("v1.20.0", POOL, at(2), REVERTED, POLICY)).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(2), { ...REVERTED, applied: null }, POLICY)).toMatchObject({ required: true });
  });

  it("only for the pool's own release: a revert of another release, a registration without one, or a time the pool cannot read give none", () => {
    expect(updateState("v1.20.1", POOL, at(2), { ...REVERTED, from: "v1.20.9" }, POLICY)).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(2), null, POLICY)).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(2), { ...REVERTED, at: null }, POLICY)).toMatchObject({ required: true });
    expect(updateState("v1.20.1", POOL, at(2), { ...REVERTED, at: "yesterday" }, POLICY)).toMatchObject({ required: true });
    expect(lastGoodUntil(REVERTED, "v1.20.2", "v1.20.2", at(2), POLICY)).toBeNull();
  });

  it("a revoked release is handed nothing at once, whatever the grace and whatever the pool runs; a release it does not name is not", () => {
    expect(isRevoked("v1.19.5", POLICY)).toBe(true);
    expect(isRevoked("1.19.5", POLICY)).toBe(true);
    for (const v of ["v1.19.4", "dev", "container", null, undefined]) expect(isRevoked(v, POLICY)).toBe(false);
    const revoking = { ...POLICY, revoked: ["v1.20.1"] };
    expect(updateState("v1.20.1", POOL, T0 + 60000, null, revoking)).toMatchObject({ outdated: true, behind: 1, required: true, revoked: true });
    expect(updateState("v1.20.1", { version: "dev", deployed_at: null }, T0, null, revoking)).toMatchObject({ outdated: false, required: true, revoked: true });
    expect(updateState("v1.20.1", POOL, T0 + 60000, null, POLICY)).toMatchObject({ required: false });
    expect(updateState("v1.20.1", POOL, T0 + 60000, null, POLICY).revoked).toBeUndefined();
    expect(updateMessage(updateState("v1.20.1", POOL, T0, null, revoking))).toMatch(/^this worker runs v1\.20\.1, a release the pool's release \(v1\.20\.2\) revokes — it is handed nothing/);
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
