// Every worker follows the latest image (src/update.ts): what the pool
// makes of the release a worker reports, and when it stops handing it work.
import { describe, expect, it } from "vitest";
import { gateWords, parseTag, soakGraceUntil, updateState, updateMessage, SOAK_GRACE_MAX_MINUTES, SOAK_ROUND_MINUTES, UPDATE_GRACE_MINUTES } from "../src/update";

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

// An owner's soak (#326, design v2 D16): on a fake clock, a host whose owner set a 30-minute soak, its registration on v1.0.2 while
// the pool deploys v1.0.3 and, ten minutes later, v1.0.4 — two releases land during the soak. Its agent reports when the soak of the
// release the pool names ends; the pool's grace follows it, the round's 15 minutes after, at most two hours after the deploy.
describe("a soaking host's grace", () => {
  const T0 = Date.parse("2027-01-15T08:00:00.000Z");
  const MIN = 60000;
  const at = (m: number) => T0 + m * MIN;
  const iso = (m: number) => new Date(at(m)).toISOString();
  const deployed = (version: string, m: number) => ({ version, deployed_at: iso(m) });
  const soak = (untilMin: number | null, quarantined: string[] = []) => ({ until: untilMin === null ? null : iso(untilMin), quarantined });

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
    // A soak that ended before the grace would have — still the plain 45 minutes for one behind.
    expect(updateState("v1.0.3", pool, at(UPDATE_GRACE_MINUTES - 1), soak(5))).toMatchObject({ required: false });
    expect(updateState("v1.0.3", pool, at(UPDATE_GRACE_MINUTES + 1), soak(5))).toMatchObject({ required: true });
  });

  it("gives none to a host that holds the pool's release, or a later one, in quarantine; an older one quarantined does not count", () => {
    const pool = deployed("v1.0.4", 0);
    expect(updateState("v1.0.2", pool, at(10), soak(30, ["v1.0.4"]))).toMatchObject({ required: true });
    expect(updateState("v1.0.2", pool, at(10), soak(30, ["v1.0.5"]))).toMatchObject({ required: true });
    expect(updateState("v1.0.2", pool, at(10), soak(30, ["v1.0.3"]))).toMatchObject({ required: false });
    // A report's soak that is no time, or none, is no soak.
    expect(updateState("v1.0.2", pool, at(10), { until: "soon", quarantined: [] })).toMatchObject({ required: true });
    expect(updateState("v1.0.2", pool, at(10), null)).toMatchObject({ required: true });
    // A pool with no deploy time refuses nobody, soak or not.
    expect(updateState("v1.0.2", { version: "v1.0.4", deployed_at: null }, at(10), soak(30))).toMatchObject({ required: false });
  });

  it("the host page explains its 426: the soak's grace, the plain grace, and what ended them", () => {
    const pool = deployed("v1.0.4", 0);
    const words = (m: number, s: ReturnType<typeof soak> | null) => gateWords(updateState("v1.0.2", pool, at(m), s), s, pool.deployed_at);
    expect(gateWords(updateState("v1.0.4", pool, at(5)), null, pool.deployed_at)).toBeNull();
    expect(words(10, soak(30))).toBe(`its registration runs v1.0.2, the pool v1.0.4 (2 releases behind): it claims through its owner's soak, until ${iso(45)} — the pool's grace follows the soak its agent reports, 15 minutes past its end for the round, at most 2 hours after the deploy`);
    expect(gateWords(updateState("v1.0.3", pool, at(10)), null, pool.deployed_at)).toBe("its registration runs v1.0.3, the pool v1.0.4 (1 release behind): within the rollout's grace (45 minutes after the deploy, one release behind at most); its agent rolls the release out");
    expect(words(10, null)).toBe("refused with 426 — its registration runs v1.0.2, the pool v1.0.4 (2 releases behind): past the rollout's grace (45 minutes after the deploy, one release behind at most), and its agent reports no soak");
    expect(words(10, soak(30, ["v1.0.4"]))).toContain("it holds v1.0.4 in quarantine — its guard reverted it — so its soak gives no grace");
    expect(words(60, soak(30))).toContain(`its soak ended at ${iso(30)} and its round has not brought the release yet`);
    expect(words(121, soak(200))).toContain(`past the pool's grace for a soak, which ends 2 hours after the deploy (${iso(120)})`);
  });
});
