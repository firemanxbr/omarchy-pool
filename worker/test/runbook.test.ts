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
    // The host's installed copies learn the marker only from a new setup.sh run or a new copy — the CLI's from the repository since
    // the pool no longer serves it (#343). Every CLI set takes it, a copy served after #313 too: each one the pool served fetches
    // the compose file at start and update, which answers 410 from that deploy on.
    expect(text).toContain("`grep -q omarchy-agent /srv/omarchy-pool/rollout.sh`");
    expect(text).toContain("**Every CLI set replaces its `omarchy-worker`, once, at the deploy that\ncarries #343**");
    expect(text).toContain("every copy the pool\nserved (one from after #313 too) fetches the compose file at `start` and\n`update`");
    expect(text).toContain("`factory/host/omarchy-worker`");
    expect(text).toContain("https://raw.githubusercontent.com/firemanxbr/omarchy-pool/main/factory/host/omarchy-worker && chmod +x omarchy-worker");
    expect(cut(runbook, "after-a-release")).toContain("on a host the agent manages, nothing needs\nto be run");
  });

  it("lists, once before the deploy that carries #343, the registrations the owner test turns away and the maintainers' sets that were dedicated", () => {
    const text = cut(runbook, "how-the-pool-hands-a-host-work");
    const step = text.slice(text.indexOf("**Once, before the deploy that carries #343.**"));
    expect(step.startsWith("**Once, before the deploy that carries #343.**")).toBe(true);
    // The rows the claim refuses from then on: no owner, or one the maintainer list does not spell so.
    expect(step).toContain("AND (owner IS NULL OR owner NOT IN (SELECT login FROM factory_maintainers))");
    // A maintainer's set that took its owner's builds only takes anyone's from then on: its owner is told first.
    expect(step).toContain("AND owner IN (SELECT login FROM factory_maintainers) AND mode IS NOT 'shared'");
    expect(step).toContain("and tell each owner before the deploy");
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

// The words the Studio's sections quote are the code's own (#319, #345): the agent's preflight, prep-root.sh and the rehearsal tool.
import installSource from "../../crates/omarchy-agent/src/install/mod.rs?raw";
import checksSource from "../../crates/omarchy-agent/src/install/checks.rs?raw";
import legacySource from "../../crates/omarchy-agent/src/install/legacy.rs?raw";
import prepRoot from "../../factory/host/prep-root.sh?raw";
import rehearsal from "../../factory/host/studio-rehearsal.sh?raw";
import studioCompose from "../../factory/host/compose.yml?raw";
import rolloutSource from "../../crates/omarchy-agent/src/run/rollout.rs?raw";
import hostRollout from "../../factory/host/rollout.sh?raw";
import hostKeySource from "../../crates/omarchy-agent/src/host.rs?raw";
import tpmSource from "../../crates/omarchy-agent/src/host/tpm.rs?raw";
import enrollSource from "../../crates/omarchy-agent/src/enroll.rs?raw";
import dispatcherEnvSource from "../../crates/omarchy-agent/src/dispatcher_env/mod.rs?raw";

describe("the runbook's Studio canary and switch (#319, #345, design v2 §21.1)", () => {
  const canary = cut(runbook, "the-studio-canary");
  const sw = cut(runbook, "the-studio-switch");
  /** The text with its line breaks, a command's continuations and indentation folded, as a reader reads it. */
  const flat = (s: string) => s.replace(/\\\n/g, " ").replace(/\s+/g, " ");

  it("are subsections of The Studio host, before its one-time step, which After a release still follows", () => {
    const heads = outline(runbook);
    const at = (id: string) => heads.findIndex((h) => h.id === id);
    for (const id of ["the-studio-canary", "the-studio-switch"]) {
      expect(heads[at(id)].level, id).toBe(3);
      expect(heads.slice(0, at(id)).reverse().find((h) => h.level <= 2)?.id, id).toBe("the-studio-host");
    }
    expect(at("the-studio-canary")).toBeLessThan(at("the-studio-switch"));
    expect(at("the-studio-switch")).toBeLessThan(at("once-the-updater-277"));
  });

  it("the visit's exact command keeps every new path out of what the legacy compose project mounts, and the check says why", () => {
    const command = "--legacy omarchy-pool --work-root /srv/omarchy-host --secrets-dir /srv/omarchy-host-secrets \\\n     --task-subnets 10.232.0.0/16 --dedicated --agent-env-from <file>";
    expect(canary).toContain(`   OMARCHY_ENROLL=ome_… sh ~/install.sh \\\n     ${command}`);
    expect(canary).not.toMatch(/--work-root \/srv\/omarchy-pool|--secrets-dir \/srv\/omarchy-pool/);
    // Why: the Studio's compose file mounts POOL_ROOT whole into its workers, and preflight refuses a work root under it, in its own words.
    expect(studioCompose).toContain("- ${POOL_ROOT:-/srv/omarchy-pool}:${POOL_ROOT:-/srv/omarchy-pool}");
    expect(flat(canary)).toContain("legacy: the work root … overlaps the legacy project's /srv/omarchy-pool; give a new --work-root beside it");
    expect(legacySource).toContain("overlaps the legacy project's {}; give a new --work-root beside it");
    expect(flat(canary)).toContain('studio-rehearsal.sh" check --project omarchy-pool --work-root /srv/omarchy-host --secrets-dir /srv/omarchy-host-secrets --task-subnets 10.232.0.0/16 --agent-env-from /srv/omarchy-pool/etc/agent.env');
  });

  it("installs the pool's release, $tag, through the attested install — never GitHub's latest, piped", () => {
    const text = flat(canary);
    expect(text).toContain('curl -fsSLo ~/install.sh "https://github.com/firemanxbr/omarchy-pool/releases/download/$tag/install.sh"');
    expect(text).toContain("gh attestation verify ~/install.sh -R firemanxbr/omarchy-pool --signer-workflow firemanxbr/omarchy-pool/.github/workflows/release.yml --source-ref refs/heads/main");
    // The same check The host bundle gives for the verifying install.
    expect(flat(cut(runbook, "the-host-bundle"))).toContain("--signer-workflow firemanxbr/omarchy-pool/.github/workflows/release.yml --source-ref refs/heads/main");
    // Steps 4 and 6 run that file, the tag the checkout and preflight's --release name too.
    expect(canary).toContain("   sh ~/install.sh \\\n     --legacy omarchy-pool");
    expect(canary).toContain("   OMARCHY_ENROLL=ome_… sh ~/install.sh \\\n     --legacy omarchy-pool");
    expect(canary).not.toContain("releases/latest/download/install.sh");
    expect(canary).not.toMatch(/\| (OMARCHY_ENROLL=\S+ )?sh -s --/);
    expect(text).toContain('git clone --quiet --depth 1 --branch "$tag"');
    expect(text).toContain('omarchy-agent preflight --release "$tag"');
  });

  it("refreshes the Studio's rollout.sh before the ids are taken, as the one-time step says, and the check says it too", () => {
    const text = flat(canary);
    const grep = text.indexOf("grep -q omarchy-agent /srv/omarchy-pool/rollout.sh");
    expect(grep).toBeGreaterThan(0);
    expect(grep).toBeLessThan(text.indexOf('ids --project omarchy-pool > ~/legacy-ids-before'));
    expect(text).toContain("paste the block in *Once: the updater* (below) now, before the ids are taken");
    // The guard the grep looks for is the host copy's own (#313), and *On a host the agent manages* asks for it before the first retire-legacy.
    expect(hostRollout).toMatch(/omarchy-agent/);
    expect(flat(cut(runbook, "the-studio-host"))).toContain("`grep -q omarchy-agent /srv/omarchy-pool/rollout.sh` then says the copy has the guard");
    expect(rehearsal).toContain("its rollout.sh has no guard for retire-legacy's .omarchy-agent marker — paste the runbook's *Once: the updater* block now");
    expect(text).toContain("Its `rollout.sh` line says `ok` after step 1");
  });

  it("names what preflight must show in the agent's own words: 11 units, both lanes, the recorded exception, the legacy project", () => {
    const text = flat(canary);
    expect(text).toContain("`capacity: 12 CPUs, … 11 units on the aarch64 lane, the x86_64 lane through qemu`");
    expect(installSource).toContain('"capacity: {} CPUs, {} GB, disks {} GB (work root) and {} GB (engine), {} units on the {} lane{}"');
    expect(installSource).toContain('", the {} lane through {}"');
    expect(text).toContain("`emulation x86_64: on, through qemu, on pages larger than the guest's: …`");
    expect(checksSource).toContain('"emulation {}: on, through {}{pages}"');
    expect(checksSource).toContain('", on pages larger than the guest\'s: a toolchain');
    expect(text).toContain("`! hosting: a rootful daemon without userns-remap, beside the legacy set: recorded as an exception until P6`");
    expect(checksSource).toContain('"hosting: a rootful daemon without userns-remap, beside the legacy set: recorded as an exception until P6"');
    expect(text).toContain("`isolation: root (a dedicated machine or VM)`");
    expect(checksSource).toContain('"isolation: {} ({})"');
    expect(text).toContain("`legacy: omarchy-pool, N container(s), recorded only and left running`");
    expect(installSource).toContain('"legacy: {l}, {} container(s), recorded only and left running"');
    expect(text).toContain("*enrollment: … OMARCHY_ENROLL is not set*");
    expect(installSource).toContain("enrollment: this machine has not enrolled yet, and OMARCHY_ENROLL is not set");
  });

  it("says where the Studio's host key and worker token live, in the agent's own words and paths: a file key with no TPM (#330), the token's own file (#327)", () => {
    const text = flat(canary);
    // Preflight's note and the enrollment's line on a Linux machine with no TPM device (the default, OMARCHY_HOST_KEY unset).
    expect(text).toContain("`host key: a file (no TPM: /dev/tpmrm0 is not there)`");
    expect(checksSource).toContain('r.notes.push(format!("host key: a file ({why})"))');
    expect(tpmSource).toContain('return Err(format!("no TPM: {dev} is not there"));');
    expect(text).toContain("`host key: a file (Ed25519, host.ed25519, mode 0600); not in the TPM: no TPM: /dev/tpmrm0 is not there`");
    expect(enrollSource).toContain('"host key: {}{}"');
    expect(enrollSource).toContain('format!("; not in the TPM: {why}")');
    expect(hostKeySource).toContain('Inner::File(_) => format!("a file (Ed25519, {KEY_FILE}, mode 0600)")');
    expect(hostKeySource).toContain('pub const KEY_FILE: &str = "host.ed25519";');
    // The host worker token: its own file in the set directory, which install puts under the data directory on Linux.
    expect(text).toContain("~/.local/share/omarchy-agent/sets/host/run/host/dispatcher/token");
    expect(dispatcherEnvSource).toContain('pub const TOKEN_FILE: &str = "run/host/dispatcher/token";');
    expect(installSource).toContain('self.data.join("sets").join("host")');
    // The compose driver on the Studio's rootful docker: Quadlet is rootless podman's.
    expect(text).toContain("on the compose driver (Quadlet is rootless podman's, #330)");
  });

  it("sets the pool cap before Confirm, pins the owner's passkey at the visit, and checks a reboot with nobody logged in", () => {
    const text = flat(canary);
    expect(text).toContain("**the pool cap first, then Confirm**");
    expect(text).toContain("*Set the pool cap*, **3 units** (one build plus the job unit)");
    expect(text).toContain("envelope pin-passkey <pin>");
    expect(text).toContain("`sudo reboot`, and do not log in");
    expect(text).toContain("studio-rehearsal.sh\" compare ~/legacy-ids-before --project omarchy-pool");
    // How to stop it from the site: the cap at 0.
    expect(text).toContain("*Set the pool cap* to **0** on its page");
  });

  it("says prep-root.sh's two expected lines on the Studio in its own words, and that docker is not restarted", () => {
    const text = flat(canary);
    expect(text).toContain("*userns-remap: left off, the daemon already holds containers*");
    expect(prepRoot).toContain("userns-remap: left off, the daemon already holds containers or images");
    expect(text).toContain("*docker: daemon.json changed while N container(s) run; restart docker.service when none does* — do not restart docker");
    expect(prepRoot).toContain("docker: daemon.json changed while $running container(s) run; restart docker.service when none does");
  });

  it("has retire-legacy's marker directory and the GITHUB_TOKEN fixed at the visit, as the rehearsal tool says them", () => {
    const text = flat(canary);
    expect(text).toContain('`sudo chown "$USER" /srv/omarchy-pool && sudo chmod go-w /srv/omarchy-pool` — the directory alone, never `-R`');
    expect(rehearsal).toContain("retire-legacy writes its .omarchy-agent marker there only when $(id -un) owns it and nobody else may write it");
    expect(text).toContain("install copies only a classic token with no scope");
    expect(rehearsal).toContain("GitHub names no scopes for its GITHUB_TOKEN (a fine-grained or app token)");
  });

  it("gives the exit criteria as queries: no readopt-failed, a release across a task, both lanes staged, a ring moved", () => {
    expect(canary).toContain("json_extract(payload, '$.lost') = 1");
    expect(canary).toContain("t.started_at < json_extract(h.report, '$.round.at') AND t.finished_at > json_extract(h.report, '$.round.at')");
    // Only the round that applied a release: the host's release changed from the one noted before, and the round's detail names it in
    // the agent's words — a round forced to the release it runs (Reconcile now, a widening) does not count.
    expect(canary).toContain(`SELECT release_applied FROM hosts WHERE id = '<host>'`);
    expect(canary).toContain("h.release_applied IS NOT '<before>' AND json_extract(h.report, '$.round.detail') LIKE '% runs ' || h.release_applied");
    expect(rolloutSource).toContain('format!("{} runs {target}", ctx.cfg.set_name)');
    expect(canary).toContain("GROUP BY arch, lane");
    expect(canary).toContain("kind IN ('sync', 'promote') AND status = 'done'");
  });

  it("the switch raises the cap, moves pins, drains the six; the way back drains the host and resumes them; the retirement's order", () => {
    const text = flat(sw);
    const steps = ["**Raise the cap**", "**Move pins here**", "**Drain the six legacy registrations**"].map((s) => text.indexOf(s));
    expect(steps.every((i) => i > 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(text).toContain('"kind":"drain","reason":"the Studio switch (#345)"');
    expect(text).toContain("*Drain* its registration, reason *the way back*");
    expect(text).toContain("but what was moved onto it would wait for it");
    expect(text).toContain("**Rehearse the way back**");
    // Retired after the 14 days: Retire legacy set first, then Revoke the six.
    expect(text.indexOf("*Retire legacy set* on the host's page")).toBeLessThan(text.indexOf("*Revoke* on each one's page"));
    expect(text).toContain("`host-pool-jobs` set to `*`");
    // Move pins here names the Studio's set, never another machine's of the same owner.
    expect(text).toContain("the press names those registrations alone, so another machine's pins never move with them");
    // The requester-host rule as main holds it: lifted for the maintainer [solo] names (#394).
    expect(text).toContain("never the project's copy onto its requester's host (D35) — but for the maintainer `[solo]` names, whose own copies their hosts take");
  });

  it("the dress rehearsal's VM has qemu's binfmt before stand-in, and says how a long build lands on it", () => {
    const text = flat(canary);
    const vm = text.indexOf("qemu-user-static qemu-user-static-binfmt");
    expect(vm).toBeGreaterThan(0);
    expect(vm).toBeLessThan(text.indexOf('studio-rehearsal.sh" stand-in --dir /srv/omarchy-pool'));
    // Why: the stand-in keeps the compose file's platform for the x86_64 community worker.
    expect(studioCompose).toMatch(/community-x86_64:\n(?:.*\n){0,3}\s+platform: linux\/amd64/);
    expect(text).toContain("No door aims a dry run at one host (`POST /factory/enqueue` pins none)");
    expect(text).toContain("until its page's *Leases* shows one of them");
  });
});
