/**
 * AC4 of #277: the runbook's "After a release" asks nobody to touch a host.
 *
 * The runbook is the text the docs pages serve (bundled as text by
 * wrangler.toml's rules, as pages/docs-tree.ts imports it). Its section is
 * a real heading, `### After a release`, the last subsection of
 * `## The Studio host`: outline() finds it, and the cut below takes the
 * raw text from that heading's line to the next line, outside a code
 * fence, that is a heading of its level or higher — sectionText()'s
 * boundary rule, but with fenced code, tables and quotes kept and nothing
 * cut for length. sectionText() itself cannot serve: it skips code, tables
 * and quotes and stops at 220 characters, which is where a host command
 * would be. #278's section was a bold paragraph, which no heading check
 * can see; its words must be gone.
 */
import { describe, expect, it } from "vitest";
import runbook from "../src/docs/runbook.md";
import { outline } from "../src/markdown";

/** The raw text under the heading whose anchor is `id`, to the next heading of its level or higher outside a code fence; everything in between kept. */
function cut(md: string, id: string): string {
  const heads = outline(md);
  const at = heads.findIndex((h) => h.id === id);
  if (at < 0) return "";
  const level = heads[at].level;
  const out: string[] = [];
  let seen = -1;
  let fence = false;
  for (const line of md.split("\n")) {
    if (!fence) {
      const m = /^(#{1,4})\s/.exec(line);
      if (m) {
        seen++;
        if (seen > at && m[1].length <= level) break;
      }
    }
    if (/^```/.test(line)) fence = !fence;
    if (seen >= at) out.push(line);
  }
  return out.join("\n");
}

/** What a host command looks like in the runbook: a runtime, a login, an install, a service, root, the host's own scripts. */
const HOST_COMMANDS = ["docker ", "podman ", "ssh", "install -m", "systemctl", "sudo", "setup.sh", "./rollout.sh"];

describe("the runbook's After a release (AC4 of #277)", () => {
  it("is a real heading, the last subsection of The Studio host, after the one-time step", () => {
    const heads = outline(runbook);
    const mine = heads.filter((h) => h.id === "after-a-release");
    expect(mine).toHaveLength(1);
    expect(mine[0].level).toBe(3);
    const at = heads.indexOf(mine[0]);
    const parent = heads.slice(0, at).reverse().find((h) => h.level <= 2);
    expect(parent?.id).toBe("the-studio-host");
    // The one-time step holds host commands, so it comes before, under a heading of its own; the next heading closes the section at level 2.
    expect(heads[at - 1].title).toBe("Once: the updater (#277)");
    expect(heads[at + 1].level).toBe(2);
    expect(heads[at + 1].id).toBe("maintainers-reviewing-contributed-builds");
  });

  it("asks nobody to touch a host: no host command anywhere in its text, code blocks included", () => {
    const text = cut(runbook, "after-a-release");
    expect(text.startsWith("### After a release")).toBe(true);
    expect(text).toContain("Nothing to do on any host");
    expect(text).toContain("gh workflow run rollback.yml -f to=");
    for (const c of HOST_COMMANDS) expect(text, c).not.toContain(c);
  });

  it("says that on a host the agent manages nothing needs to be run, and names the marker, the refusals and the stand-down (#313)", () => {
    const text = cut(runbook, "the-studio-host");
    expect(text).toContain("On a host the agent manages, nothing needs to be run");
    expect(text).toContain("`/srv/omarchy-pool/.omarchy-agent`");
    expect(text).toContain("`omarchy-worker start|update|remove`");
    expect(text).toContain("`stands-down`");
    expect(text).toContain("`omarchy-agent status`");
    // The host's installed copies learn the marker only from a new setup.sh run or a new download.
    expect(text).toContain("`grep -q omarchy-agent /srv/omarchy-pool/rollout.sh`");
    expect(text).toContain("Fetch an `omarchy-worker` downloaded before this release");
    expect(cut(runbook, "after-a-release")).toContain("on a host the agent manages, nothing needs\nto be run");
  });

  it("carries none of #278's paragraph, which asked for an install and restarts on the host", () => {
    expect(runbook).not.toContain("until this host has the new `rollout.sh`");
    expect(runbook).not.toContain("install -m 755 factory/host/rollout.sh");
  });

  it("the cut keeps code and tables under the heading, and stops at the next heading of its level", () => {
    const fixture = [
      "## The Studio host", "", "### After a release", "", "Nothing to do on any host.", "", "| a | b |", "|---|---|", "| x | y |", "",
      "```bash", "# a comment, not a heading", "docker compose restart review-aarch64", "```", "", "#### A deeper heading stays in", "text", "",
      "### Next", "", "```bash", "sudo setup.sh", "```",
    ].join("\n");
    const text = cut(fixture, "after-a-release");
    expect(text).toContain("docker compose restart review-aarch64");
    expect(text).toContain("| x | y |");
    expect(text).toContain("#### A deeper heading stays in");
    expect(HOST_COMMANDS.some((c) => text.includes(c))).toBe(true);
    expect(text).not.toContain("sudo setup.sh");
    expect(text).not.toContain("### Next");
    // The same command under the next heading is not in the cut.
    const next = fixture.replace("docker compose restart review-aarch64", "echo fine");
    const clean = cut(next, "after-a-release");
    expect(HOST_COMMANDS.some((c) => clean.includes(c))).toBe(false);
  });
});

describe("the runbook's GitHub settings the signature relies on (#308)", () => {
  const section = cut(runbook, "the-github-settings-the-signature-relies-on");

  it("is a real section, and names the exact identity hosts check", () => {
    expect(outline(runbook).filter((h) => h.id === "the-github-settings-the-signature-relies-on").map((h) => h.level)).toEqual([2]);
    expect(section).toContain("https://github.com/firemanxbr/omarchy-pool/.github/workflows/release.yml@refs/heads/main");
    expect(section).toContain("https://token.actions.githubusercontent.com");
  });

  it("lists every setting, how to apply it and a gh api command that checks it", () => {
    // The settings: the reviewed environments, the tag ruleset, immutable releases, the main ruleset's code owners, the token rule.
    for (const setting of ["`release` and `pool` environments", "A tag ruleset on `v*`", "Immutable releases", "code owner", "No stored or automated token with `actions`, `contents: write` or `workflows`"]) expect(section, setting).toContain(setting);
    // Applied with these…
    for (const apply of ['gh api -X PUT "$R/environments/$env"', '"$R/environments/$env/deployment-branch-policies" -f name=main -f type=branch', 'gh api -X POST "$R/rulesets" --input .github/rulesets/tags-locked.json', 'gh api -X PUT "$R/immutable-releases"', "gh secret set CLOUDFLARE_API_TOKEN --env pool"]) expect(section, apply).toContain(apply);
    // …and checked with these.
    for (const check of ['gh api "$R/environments"', '/deployment-branch-policies" --jq', 'gh api "$R/rulesets"', 'gh api "$R/immutable-releases"', 'gh api "$R/keys"']) expect(section, check).toContain(check);
    // Only the tag ruleset this user-owned repository can apply (#351): moves and deletions refused, creation open, the signature what hosts trust.
    expect(section).not.toContain(".github/rulesets/tags.json");
    expect(section).toContain("Creation is not restricted");
    expect(section).toContain("hosts trust the signature, whatever tags exist");
    // Honest about what the repository cannot do alone.
    expect(section).toContain("Until the admin applies them");
  });
});
