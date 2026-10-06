import { describe, expect, it } from "vitest";
import { APPLY_URL, parseGovernance, parseSolo, SOLO_REASON_MAX } from "../src/governance";
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
    // A maintainer's backup key beside their own: a list (#330).
    const key = withKeys.split('"')[5];
    expect(parseGovernance(`${withKeys}maralcbr = ["${key.replace("AAAAII", "AAAAIJ")}", "${key}"]\n`)).toEqual(["firemanxbr", "maralcbr"]);
  });
});

// The solo-maintainer exception's switch (#394): the [solo] table, read by the brain as check-governance holds it (tests/governance-solo.sh).
describe("the [solo] table", () => {
  const LIST = ["alice", "bob"];
  const file = (solo: string) => `maintainers = ["alice", "bob"]\n\n${solo}\n[cosignature]\nthreshold = 0\n`;
  const table = (o: Record<string, string>) => `[solo]\n${Object.entries(o).map(([k, v]) => `${k} = ${v}`).join("\n")}\n`;
  const ok = { maintainer: '"alice"', since: '"2026-10-06"', reason: '"bob has no time or machines for the pool"' };

  it("is no exception without the table: the rules as they are", () => {
    expect(parseSolo(file(""), LIST)).toBeNull();
    expect(parseSolo(`maintainers = ["alice"]`, ["alice"])).toBeNull();
  });

  it("names one maintainer of the list, since a date, with a reason on one line", () => {
    expect(parseSolo(file(table(ok)), LIST)).toEqual({ maintainer: "alice", since: "2026-10-06", reason: "bob has no time or machines for the pool" });
    expect(parseSolo(file(table({ ...ok, maintainer: '"bob"', since: '"2028-02-29"', reason: '"  spaces around it  "' })), LIST)).toEqual({ maintainer: "bob", since: "2028-02-29", reason: "spaces around it" });
    // Counted in characters as check-governance counts them, code points: 200 outside the BMP are 200 (400 UTF-16 units), and taken.
    const emoji = "\u{1F600}".repeat(200);
    expect(parseSolo(file(table({ ...ok, reason: `"${emoji}"` })), LIST)).toEqual({ maintainer: "alice", since: "2026-10-06", reason: emoji });
    // The list beside it still parses as it did (D39: a list that parses is applied).
    expect(parseGovernance(file(table(ok)))).toEqual(LIST);
  });

  it("refuses an unknown or unlisted login, more than one maintainer, no reason, a date that does not parse, a field it does not know", () => {
    const refused: [Record<string, string | undefined>, RegExp][] = [
      [{ maintainer: '"carol"' }, /carol is not in `maintainers`/],
      [{ maintainer: '"not a login!"' }, /must be a GitHub login/],
      [{ maintainer: undefined }, /must be a GitHub login/],
      [{ maintainer: '["alice", "bob"]' }, /one maintainer, never a list/],
      [{ maintainer: '["alice"]' }, /one maintainer, never a list/],
      [{ reason: undefined }, /reason is required/],
      [{ reason: '"   "' }, /reason is required/],
      [{ reason: '"""\ntwo\nlines"""' }, /one line of 300 characters at most/],
      [{ reason: `"${"x".repeat(SOLO_REASON_MAX + 1)}"` }, /one line of 300 characters at most/],
      // As check-governance counts and trims (tests/governance-solo.sh holds the same cases): 301 characters outside the BMP are 301, and a
      // control or format character anywhere — a tab, a byte-order mark JavaScript's trim() would take away and Python's strip() keeps — is
      // never one line.
      [{ reason: `"${"\u{1F600}".repeat(SOLO_REASON_MAX + 1)}"` }, /one line of 300 characters at most/],
      [{ reason: '"a\\ttab inside"' }, /one line of 300 characters at most/],
      [{ reason: '"\\uFEFFa byte-order mark first"' }, /one line of 300 characters at most/],
      [{ since: '"2026-02-30"' }, /since must be a date/],
      [{ since: '"06/10/2026"' }, /since must be a date/],
      [{ since: '"soon"' }, /since must be a date/],
      [{ since: undefined }, /since must be a date/],
      [{ since: "2026-10-06" }, /since must be a date/],
      [{ maintainers: '["bob"]' }, /unknown field\(s\) maintainers/],
    ];
    for (const [change, why] of refused) {
      const o = Object.fromEntries(Object.entries({ ...ok, ...change }).filter(([, v]) => v !== undefined)) as Record<string, string>;
      expect(() => parseSolo(file(table(o)), LIST), JSON.stringify(change)).toThrow(why);
    }
    expect(() => parseSolo(`maintainers = ["alice"]\nsolo = "alice"\n`, ["alice"])).toThrow(/must be a table/);
  });

  it("reads the repository's own file: a table there names a maintainer of its list", () => {
    const list = parseGovernance(repositoryFile);
    const solo = parseSolo(repositoryFile, list);
    if (solo) {
      expect(list).toContain(solo.maintainer);
      expect(solo.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(solo.reason.length).toBeGreaterThan(0);
    }
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
