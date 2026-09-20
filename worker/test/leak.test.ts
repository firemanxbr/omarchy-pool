/** What looks like a secret in a public log (leak.ts): the shapes, the line, and what is not one. */
import { describe, expect, it } from "vitest";
import { findLeak, leakMessage } from "../src/leak";

describe("findLeak", () => {
  it("names the kind and the line of the first hit", () => {
    const text = "==> Starting build()\n  running cargo\ntoken: sk-proj-" + "x".repeat(60) + "\nAKIA" + "A".repeat(16) + "\n";
    expect(findLeak(text)).toEqual({ kind: "an API key (sk-…)", line: 3 });
    expect(leakMessage("build.log", { kind: "an API key (sk-…)", line: 3 })).toMatch(/^build\.log carries what looks like an API key \(sk-…\) \(line 3\)/);
  });

  it("knows the pool's own tokens, the agents' keys, GitHub's, a private key, a URL credential, a bearer, an environment dump", () => {
    const cases: [string, string][] = [
      ["omc_" + "a".repeat(32), "a pool token (omw_ / omc_ / oms_)"],
      ["omj." + "a".repeat(32), "a pool job token (omj.)"],
      ["sk-ant-api03-" + "a".repeat(40), "an Anthropic key"],
      ["github_pat_" + "a".repeat(40), "a GitHub token"],
      ["gho_" + "a".repeat(36), "a GitHub token"],
      ["AIza" + "a".repeat(35), "a Google API key"],
      ["xai-" + "a".repeat(48), "an xAI key"],
      ["-----BEGIN RSA PRIVATE KEY-----", "a private key block"],
      ["-----BEGIN PGP PRIVATE KEY BLOCK-----", "a private key block"],
      ["Bearer " + "a".repeat(32), "a bearer token"],
      ["https://alice:" + "p".repeat(12) + "@git.example/r", "a credential in a URL"],
      ["GITHUB_TOKEN=" + "a".repeat(20), "the worker's environment"],
      ["GITHUB_REPORT_TOKEN=" + "a".repeat(20), "the worker's environment"],
    ];
    for (const [text, kind] of cases) expect(findLeak("line one\n" + text + "\n"), text).toEqual({ kind, line: 2 });
  });

  it("lets a log say the ordinary things", () => {
    for (const text of [
      "GITHUB_TOKEN=\n",
      "GITHUB_TOKEN=***\n",
      "the omw_ prefix marks a worker token\n",
      "https://github.com/o/r/archive/v1.tar.gz\n",
      "git+https://github.com/o/r.git\n",
      "https://user@github.com/o/r\n",
      "Authorization: Bearer <your token here>\n",
      "sk-ant is where Anthropic keys start\n",
      "SKIP\n",
      "",
    ]) expect(findLeak(text), JSON.stringify(text)).toBeNull();
  });
});
