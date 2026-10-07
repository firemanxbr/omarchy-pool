/**
 * The runbook's *The Studio host* (#346, design v2 §21.1, §19.3): the Studio
 * is a maintainer host like any other — one bundle, its capacity, lanes and
 * isolation level said, nothing to run on the machine for a release — its
 * legacy set retired, with the queries that show no legacy registration is
 * left and that the pool's jobs go to the hosts; and AC4 of #277: its *After
 * a release* asks nobody to touch a host.
 *
 * The runbook is the text the docs pages serve (bundled as text by
 * wrangler.toml's rules, as pages/docs-tree.ts imports it). Its sections are
 * real headings: outline() finds them, and the cut below takes the raw text
 * from a heading's line to the next line, outside a code fence, that is a
 * heading of its level or higher — sectionText()'s boundary rule, but with
 * fenced code, tables and quotes kept and nothing cut for length.
 * sectionText() itself cannot serve: it skips code, tables and quotes and
 * stops at 220 characters, which is where a host command would be.
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

/** What a host command looks like in the runbook: a runtime, a login, an install, a service, root. */
const HOST_COMMANDS = ["docker ", "podman ", "ssh", "install -m", "systemctl", "sudo"];

/** What the legacy sets ran with, which left the repository with them (#346): no section of the Studio's names one as a thing to run. */
const LEGACY_TOOLS = ["./rollout.sh", "setup.sh", "register.sh", "omarchy-worker start", "omarchy-worker update", "COMPOSE_PROFILES", "docker compose up", "Once: the updater", "agent-proxy", "broker-community"];

describe("the runbook's The Studio host (#346, design v2 §21.1)", () => {
  const studio = cut(runbook, "the-studio-host");

  it("is a real section with two subsections, its retired legacy set and After a release, which the reviewing section follows", () => {
    const heads = outline(runbook);
    const at = heads.findIndex((h) => h.id === "the-studio-host");
    expect(heads[at].level).toBe(2);
    expect(heads.slice(at + 1, at + 4).map((h) => [h.level, h.id])).toEqual([[3, "its-legacy-set-retired"], [3, "after-a-release"], [2, "maintainers-reviewing-contributed-builds"]]);
    // The canary, the switch and the legacy set's one-time step were procedures for the switch, done: none is a heading any more.
    for (const gone of ["the-studio-canary", "the-studio-switch", "once-the-updater-277"]) expect(heads.map((h) => h.id), gone).not.toContain(gone);
  });

  it("says the Studio is a host like any other: one bundle, 11 units on two lanes, isolation root as the recorded exception until P6", () => {
    expect(studio).toContain("is a maintainer host like any other");
    expect(studio).toContain("11 units");
    expect(studio).toContain("aarch64 native, and x86_64 emulated under\nqemu (`page16k`)");
    expect(studio).toContain("**Isolation `root`, a recorded exception until P6**");
    expect(studio).toContain("`/srv/omarchy-pool/host`");
    expect(studio).toContain("`10.232.0.0/16`");
    // A build that dies of emulation goes back for a native host, its attempt given back.
    expect(studio).toContain("`needs_native`, #338");
  });

  it("asks nothing of the legacy tools, and names the queries that show no legacy registration is left and the pool's jobs on the hosts", () => {
    for (const tool of LEGACY_TOOLS) expect(studio, tool).not.toContain(tool);
    const retired = cut(runbook, "its-legacy-set-retired");
    expect(retired).toContain("`POST /factory/workers` answers 410");
    expect(retired).toContain("WHERE kind = 'legacy' AND revoked_at IS NULL");
    expect(retired).toContain("SELECT value FROM settings WHERE key = 'host-pool-jobs'");
    // The marker stays: an old copy of the set's tools refuses where it is.
    expect(retired).toContain("Keep `host/` and `host-secrets/`");
  });
});

describe("the runbook's After a release (AC4 of #277)", () => {
  it("asks nobody to touch a host: no host command anywhere in its text, code blocks included, and the rollback is from anywhere", () => {
    const text = cut(runbook, "after-a-release");
    expect(text.startsWith("### After a release")).toBe(true);
    expect(text).toContain("Nothing to do on any host");
    expect(text).toContain("gh workflow run rollback.yml -f to=");
    for (const c of [...HOST_COMMANDS, ...LEGACY_TOOLS]) expect(text, c).not.toContain(c);
  });

  it("carries none of #278's paragraph, which asked for an install and restarts on the host", () => {
    expect(runbook).not.toContain("until this host has the new `rollout.sh`");
    expect(runbook).not.toContain("rollout.sh");
  });

  it("the cut keeps code and tables under the heading, and stops at the next heading of its level", () => {
    const fixture = [
      "## The Studio host", "", "### After a release", "", "Nothing to do on any host.", "", "| a | b |", "|---|---|", "| x | y |", "",
      "```bash", "# a comment, not a heading", "docker ps", "```", "", "#### A deeper heading stays in", "text", "",
      "### Next", "", "```bash", "sudo prep-root.sh", "```",
    ].join("\n");
    const text = cut(fixture, "after-a-release");
    expect(text).toContain("docker ps");
    expect(text).toContain("| x | y |");
    expect(text).toContain("#### A deeper heading stays in");
    expect(HOST_COMMANDS.some((c) => text.includes(c))).toBe(true);
    expect(text).not.toContain("sudo prep-root.sh");
    expect(text).not.toContain("### Next");
    // The same command under the next heading is not in the cut.
    const next = fixture.replace("docker ps", "echo fine");
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
    // Only the tag ruleset this user-owned repository can apply (#351): moves and deletions refused, creation open, release.yml refusing a release it did not make, and only what is verified claimed.
    expect(section).toContain("Creation is not restricted");
    expect(section).toContain("`release.yml` refuses a release it did not make");
    expect(section).toContain("signed by `release.yml@refs/heads/main`, whatever tags exist");
    expect(section).toContain("The CLI tarball on a GitHub release is not verified on download");
    // Honest about what the repository cannot do alone.
    expect(section).toContain("Until the admin applies them");
    expect(section).toContain("is replaced by #351");
  });
});

