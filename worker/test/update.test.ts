// Every worker follows the latest image (src/update.ts): what the pool
// makes of the release a worker reports, and when it stops handing it work.
import { describe, expect, it } from "vitest";
import { parseTag, updateState, updateMessage, UPDATE_GRACE_MINUTES } from "../src/update";

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
    expect(updateMessage(updateState("v0.0.167", pool("v0.0.177", 600)))).toBe("this worker runs v0.0.167; the pool is at v0.0.177 (10 releases behind) — every worker follows the latest image: update it (/docs/workers#update) and it works again");
    expect(updateMessage(updateState("v0.0.176", pool("v0.0.177", 600)))).toContain("(1 release behind)");
    expect(updateMessage(updateState("v0.0.177", pool("v0.1.0", 600)))).not.toContain("behind)");
  });
});
