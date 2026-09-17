/** The class from what the factory recorded: the same rules for every package (docs: What we test → The score). */
import { describe, expect, it } from "vitest";
import { classOf, scoreChain } from "../src/score";

const green = {
  contributor: { attempts: 1, status: "staged" },
  vet: { verdict: "pass", fails: 0, warnings: 0 },
  audit: { status: "done", verdict: "ok", high: 0, findings: 0 },
  request: { license: "MIT", source: "https://x/y.tar.gz" },
  project: { status: "staged", attempts: 1 },
  projectVet: { verdict: "pass", fails: 0, warnings: 0 },
  trial: { status: "done", verdict: "ok" },
  approval: { decision: "approved", note: "fine" },
  category: "system",
};

describe("the score", () => {
  it("a chain green on both halves is 100, class A; the halves are fifty each", () => {
    const s = scoreChain(green);
    expect(s).toMatchObject({ points: 100, max: 100, class: "A", projected: "A", ready: true });
    expect(s.items.filter((i) => i.who === "contributor").reduce((n, i) => n + i.max, 0)).toBe(50);
    expect(s.items.filter((i) => i.who === "maintainer").reduce((n, i) => n + i.max, 0)).toBe(50);
  });
  it("a contributor's complete half is ready and projects the class the maintainer's half would reach", () => {
    const s = scoreChain({ ...green, project: null, projectVet: null, trial: null, approval: null, category: null });
    expect(s).toMatchObject({ points: 50, class: "D", projected: "A", ready: true });
    expect(s.items.filter((i) => i.who === "maintainer").every((i) => i.state === "pending")).toBe(true);
  });
  it("warnings, extra attempts and a high finding cost points; a failed gate or a failed build is not ready", () => {
    const s = scoreChain({ ...green, contributor: { attempts: 3, status: "staged" }, vet: { verdict: "pass", fails: 0, warnings: 2 }, audit: { status: "done", verdict: "warn", high: 1, findings: 3 } });
    expect(s.items.find((i) => i.item === "A build that succeeds")!.points).toBe(9);
    expect(s.items.find((i) => i.item === "The gate passed")!.points).toBe(10);
    expect(s.items.find((i) => i.item === "The audit")!.points).toBe(5);
    expect(s.ready).toBe(true);
    expect(scoreChain({ ...green, vet: { verdict: "fail", fails: 2, warnings: 0 } }).ready).toBe(false);
    expect(scoreChain({ ...green, contributor: { attempts: 3, status: "failed" } }).ready).toBe(false);
    expect(scoreChain({ ...green, audit: { status: "queued" } }).ready).toBe(false);
  });
  it("a request the form would not take today — the checklist never confirmed, the version unknown — earns 2 of 5 and is not ready until renewed", () => {
    const s = scoreChain({ ...green, project: null, projectVet: null, trial: null, approval: null, category: null, request: { license: "MIT", source: "https://x/y.tar.gz", complete: false } });
    expect(s.items.find((i) => i.item === "A request on the record")).toMatchObject({ points: 2, max: 5, state: "done", note: expect.stringMatching(/renew/) });
    expect(s).toMatchObject({ points: 47, ready: false });
    expect(scoreChain({ ...green, request: { license: "MIT", source: "https://x/y.tar.gz", complete: true } }).ready).toBe(true);
    expect(scoreChain({ ...green, request: { license: "MIT", source: "https://x/y.tar.gz", complete: null } }).ready).toBe(true);
    // No request, or one that names no licence or source, is not ready either — the rule is one: a request as the form takes it.
    expect(scoreChain({ ...green, request: null }).ready).toBe(false);
    expect(scoreChain({ ...green, request: { license: null, source: "https://x/y.tar.gz", complete: false } }).ready).toBe(false);
    // A build of another version than the request names is not its evidence; a bump (the pool's own build of a new release) is exempt.
    const v = { ...green, contributor: { attempts: 1, status: "staged", version: "1.2.0" }, request: { license: "MIT", source: "https://x/y.tar.gz", complete: true, version: "v1.2.0" } };
    expect(scoreChain(v).ready).toBe(true);
    expect(scoreChain({ ...v, request: { ...v.request, version: "v1.3.0" } })).toMatchObject({ ready: false });
    expect(scoreChain({ ...v, request: { ...v.request, version: "v1.3.0" } }).items.find((i) => i.item === "A request on the record")!.note).toMatch(/names v1.3.0, this build is 1.2.0/);
    expect(scoreChain({ ...v, contributor: { attempts: 1, status: "staged", version: "1.3.0-1", bump: true } }).ready).toBe(true);
  });
  it("the classes", () => {
    expect([100, 90, 89, 75, 74, 55, 54, 0].map(classOf)).toEqual(["A", "A", "B", "B", "C", "C", "D", "D"]);
  });
});
