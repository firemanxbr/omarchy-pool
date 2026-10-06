import { describe, expect, it } from "vitest";
import { APPLY_URL, parseGovernance } from "../src/governance";
import { REPO_ARCHES } from "../src/meta";
// The repository's own files, as text (Vite's ?raw): the tests run inside workerd, which has no filesystem.
import repositoryFile from "../../factory/MAINTAINERS.toml?raw";
import applicationForm from "../../.github/ISSUE_TEMPLATE/maintainer.yml?raw";

describe("governance file", () => {
  it("parses the list of maintainers, sorted, without duplicates", () => {
    expect(parseGovernance(`maintainers = ["firemanxbr", "adamb", "firemanxbr"]`)).toEqual(["adamb", "firemanxbr"]);
  });

  it("still reads the older grouped form as the union of its lists", () => {
    expect(parseGovernance(`[groups.omarchy]\nmaintainers = ["firemanxbr", "adamb"]\n\n[groups.community]\nmaintainers = ["firemanxbr"]`)).toEqual(["adamb", "firemanxbr"]);
  });

  it("refuses an empty list, a bad login, or no list at all", () => {
    expect(() => parseGovernance(`maintainers = []`)).toThrow(/no maintainer/);
    expect(() => parseGovernance(`maintainers = ["not a login!"]`)).toThrow(/logins/);
    expect(() => parseGovernance(`title = "x"`)).toThrow(/maintainers/);
  });

  it("accepts the repository's own file", () => {
    expect(parseGovernance(repositoryFile).length).toBeGreaterThan(0);
  });

  it("reads the logins alone beside the maintainers' co-signature keys (#330), which are the host agent's", () => {
    expect(repositoryFile).toMatch(/^\[cosignature\]\nthreshold = \d+$/m);
    const withKeys = `maintainers = ["maralcbr", "firemanxbr"]\n\n[cosignature]\nthreshold = 1\n\n[cosignature.keys]\nfiremanxbr = "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIIqI4910CfGV/VLbLTy6XXLKZwm/HZQSG/N0iAG0D29cAAAABHNzaDo= firemanxbr@security-key"\n`;
    expect(parseGovernance(withKeys)).toEqual(["firemanxbr", "maralcbr"]);
  });
});

// The way in (#251): the People page's Open the issue and the governance chapter open this form, and what it asks is what the maintainers decide on — the approved package, the agent, the architectures, the rules agreed to. Who applies is the issue's author: a login typed into the form could name another account than the one that applied, one with no record of its own.
describe("maintainer application", () => {
  it("is the issue form the pages link, and asks what the maintainers decide on", () => {
    expect(APPLY_URL).toMatch(/\/issues\/new\?template=maintainer\.yml$/);
    expect(applicationForm).toMatch(/^name: Maintainer application$/m);
    expect(applicationForm).toMatch(/^description: .+$/m);
    expect(applicationForm).toMatch(/^labels: \["maintainer-application"\]$/m);
    expect(applicationForm).toMatch(/^body:$/m);
    const ids = [...applicationForm.matchAll(/^ {4}id: ([a-z-]+)$/gm)].map((m) => m[1]);
    expect(ids).toEqual(["packages", "agent", "arches", "why", "rules"]);
    expect(applicationForm).toMatch(/^title: "Maintainer application"$/m);
    expect(applicationForm, "the form asks for no login: the author is the applicant").not.toMatch(/^ {6}label: GitHub login$/m);
    expect(applicationForm).toContain("Open it from the GitHub account you sign in to the pool with.");
    // The architectures are the pool's, every one of them.
    const arches = /id: arches[\s\S]*?options:\n((?: {8}- label: .+\n)+)/.exec(applicationForm)?.[1] ?? "";
    expect([...arches.matchAll(/- label: (.+)/g)].map((m) => m[1])).toEqual([...REPO_ARCHES]);
    // Every rule is a box that must be ticked.
    const rules = /id: rules[\s\S]*$/.exec(applicationForm)?.[0] ?? "";
    const boxes = [...rules.matchAll(/- label: (.+)\n( {10}required: true)?/g)];
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    for (const b of boxes) expect(b[2], b[1]).toBeTruthy();
    expect(applicationForm).toContain("https://omarchy-pool.org/docs/governance#becoming");
  });
});
