/**
 * The runbook's *The Studio host* (#346, design v2 §21.1, §19.3): the Studio
 * is a maintainer host like any other — one bundle, its capacity, lanes and
 * isolation level said, nothing to run on the machine for a release — its
 * legacy set retired, with the queries that show no legacy registration is
 * left and that the pool's jobs go to the hosts; its *The Studio at subuid*
 * (#407), the move to subuid in one root session, in the words of the code
 * it runs; and AC4 of #277: its *After a release* asks nobody to touch a
 * host.
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

  it("is a real section with four subsections, the Studio's x86_64 VM (#413), its move to subuid (#407), its retired legacy set and After a release, which the reviewing section follows", () => {
    const heads = outline(runbook);
    const at = heads.findIndex((h) => h.id === "the-studio-host");
    expect(heads[at].level).toBe(2);
    expect(heads.slice(at + 1, at + 6).map((h) => [h.level, h.id])).toEqual([
      [3, "the-studio-s-x86-64-vm"],
      [3, "the-studio-at-subuid"],
      [3, "its-legacy-set-retired"],
      [3, "after-a-release"],
      [2, "maintainers-reviewing-contributed-builds"],
    ]);
    // The canary, the switch and the legacy set's one-time step were procedures for the switch, done: none is a heading any more.
    for (const gone of ["the-studio-canary", "the-studio-switch", "once-the-updater-277"]) expect(heads.map((h) => h.id), gone).not.toContain(gone);
  });

  it("says the Studio is a host like any other: one bundle, 11 units on two lanes, isolation subuid since its move of 2026-10-13", () => {
    expect(studio).toContain("is a maintainer host like any other");
    expect(studio).toContain("11 units");
    expect(studio).toContain("aarch64 native, and x86_64 emulated under\nqemu (`page16k`)");
    expect(studio).toContain("**Isolation `subuid`, since 2026-10-13**");
    expect(studio).not.toContain("**Isolation `root`");
    expect(studio).toContain("`/srv/omarchy-host`, a btrfs subvolume of its own");
    expect(studio).toContain("`10.232.0.0/16`");
    // Where its key and its token live, as the canary set them up: a file key, the Studio having no TPM (#330); the token's own
    // file in the set directory (#327), on the compose driver.
    expect(studio).toContain("`host.ed25519` in the agent's `state/`, a file: the Studio has no TPM");
    // Its keys since the move: 0640, readable by the remapped sidecars' uid through the file's ACL alone (#405).
    expect(studio).toContain("`/srv/omarchy-host-secrets` (`--secrets-dir`, the login's, 0700; `agent.env`, 0640, its owner's and readable by the agent sidecars' remapped uid 231069 through its ACL alone, #405)");
    expect(studio).toContain("`run/host/dispatcher/token` (0400), mounted read-only into the dispatcher (#327)");
    // A build that dies of emulation goes back for a native host, its attempt given back.
    expect(studio).toContain("`needs_native`, #338");
  });

  it("names the hosts as installed: the canary studio-m2 and, on the same machine, the 4K VM studio-vm4k, which builds only", () => {
    // The canary as installed (#409): its name, id and registration, its secrets outside the work root.
    expect(studio).toContain("the host `studio-m2`, id `h_2t7pul95fs`, its registration\n`firemanxbr-studio-m2-mnmw`");
    expect(cut(runbook, "its-legacy-set-retired")).toContain("its secrets (`/srv/omarchy-host-secrets`) were put beside it");
    // The VM (#413): a host of its own, a systemd --user unit, rootless podman on the Quadlet driver, no agent keys.
    expect(studio).toContain("**The 4K VM, `studio-vm4k`** (#413), is a host of its own");
    expect(studio).toContain("`systemd --user` unit `omarchy-vm4k.service`");
    expect(studio).toContain("rootless podman with the Quadlet driver and holds no agent\nkeys");
    // Its pool jobs fetch the keyrings before a check, and a red says whose it is (#414, #417).
    expect(studio).toContain("Every job that checks a\nring now fetches the keyrings first");
    expect(studio).toContain("`payload.posted_by`");
  });

  it("asks nothing of the legacy tools, and names the queries that show no legacy registration is left and the pool's jobs on the hosts", () => {
    for (const tool of LEGACY_TOOLS) expect(studio, tool).not.toContain(tool);
    const retired = cut(runbook, "its-legacy-set-retired");
    expect(retired).toContain("`POST /factory/workers` answers 410");
    expect(retired).toContain("WHERE kind = 'legacy' AND revoked_at IS NULL");
    expect(retired).toContain("SELECT value FROM settings WHERE key = 'host-pool-jobs'");
    // Nothing of the host is in the retired set's directory; the marker stays while its files do: an old copy of the set's tools refuses there.
    expect(retired).toContain("Nothing of the host is in that directory");
    expect(retired).toContain("keep the marker, which tells any old copy of the set's tools to\nrefuse there");
    // The pool refuses no claim of a legacy row left unrevoked: the check is a hard precondition of the deploy.
    expect(retired).toContain("a hard precondition of that deploy");
    expect(retired).toContain("So do not deploy while the first two queries list anything.");
  });

  it("gives readopt-failed as a query that counts a task container's loss only, never a pool job's (#319)", () => {
    expect(studio).toContain("**Whether it lost a task container**");
    expect(studio).toContain("json_extract(e.payload, '$.lost') = 1");
    // A task container's loss only (dispatch/mod.rs KINDS): a pool job lost with its dispatcher at a release is by design (#319).
    expect(studio).toContain("JOIN build_tasks t ON t.id = json_extract(e.payload, '$.task')");
    expect(studio).toContain("AND t.kind IN ('build', 'trial', 'audit')");
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

// The Studio's move to subuid (#407): the root session's words are prep-root.sh's, the agent's and the dispatcher's own.
import installSource from "../../crates/omarchy-agent/src/install/mod.rs?raw";
import checksSource from "../../crates/omarchy-agent/src/install/checks.rs?raw";
import prepRoot from "../../factory/host/prep-root.sh?raw";
import rolloutSource from "../../crates/omarchy-agent/src/run/rollout.rs?raw";
import enrollSource from "../../crates/omarchy-agent/src/enroll.rs?raw";
import dispatcherEnvSource from "../../crates/omarchy-agent/src/dispatcher_env/mod.rs?raw";
import dispatchSource from "../../crates/pkg-repo/src/dispatch/mod.rs?raw";
import remapSource from "../../crates/omarchy-agent/src/dispatcher_env/remap.rs?raw";
import factorySource from "../src/routes/factory.ts?raw";

describe("the runbook's Studio at subuid (#407)", () => {
  const sec = cut(runbook, "the-studio-at-subuid");
  /** As a reader reads it: a command's continuations, line breaks and indentation folded. */
  const text = sec.replace(/\\\n/g, " ").replace(/\s+/g, " ");
  const at = (s: string) => {
    const i = text.indexOf(s);
    expect(i, s).toBeGreaterThan(0);
    return i;
  };
  const install = "sh ~/install.sh --work-root /srv/omarchy-host --secrets-dir /srv/omarchy-host-secrets --task-subnets 10.232.0.0/16 --dedicated --agent-env-from /srv/omarchy-host-secrets/agent.env";
  const prep = 'sudo bash "$src/factory/host/prep-root.sh" --user "$USER" --work-root /srv/omarchy-host --task-subnets 10.232.0.0/16 --remap-existing-daemon';

  it("is a subsection of The Studio host, after its x86_64 VM and before its retired legacy set", () => {
    const heads = outline(runbook);
    const i = (id: string) => heads.findIndex((h) => h.id === id);
    expect(heads[i("the-studio-at-subuid")]?.level).toBe(3);
    expect(heads.slice(0, i("the-studio-at-subuid")).reverse().find((h) => h.level <= 2)?.id).toBe("the-studio-host");
    expect(i("the-studio-s-x86-64-vm")).toBeGreaterThan(0);
    expect(i("the-studio-s-x86-64-vm")).toBeLessThan(i("the-studio-at-subuid"));
    expect(i("the-studio-at-subuid")).toBeLessThan(i("its-legacy-set-retired"));
  });

  it("says the move was done on 2026-10-13 and what was observed, before the procedure, which stays the way to move another rootful host", () => {
    expect(text).toContain("The Studio moved to `subuid` on 2026-10-13, in the root session below.");
    expect(text).toContain("Until then its rootful docker ran without userns-remap, so a task container's root was the host's root");
    expect(text).toContain("stays the way to move another host whose rootful daemon already holds images or containers");
    // What was observed, in order, and all of it before the procedure's first step.
    const observed = [
      "**What was observed** on 2026-10-13 (UTC):",
      "15:01:12, studio-m2 (host `h_2t7pul95fs`) drained, the root session ran `prep-root.sh --remap-existing-daemon` from v1.1.6's tree",
      "docker 29.9.0 remaps users (`docker info` lists `name=userns`), its data root `/var/lib/docker/165536.165536`, storage driver overlay2",
      "`dockremap`'s subordinate ids 165536–231071",
      "`/etc/docker/daemon.json.pre-remap` with it: the way back of one day",
      "The agent's install again (v1.1.6, agent 0.5.3, `--agent-env-from`, `--yes`) wrote the envelope's `userns_remap = true`",
      "with the ACL `user::rw- user:231069:r-- group::--- mask::r-- other::---`",
      "`etc/dispatcher.env` with `OMARCHY_AGENT_REMAPPED_USER=65533:65533` alone; `run/capacity.json` says `subuid`",
      "15:08, the registration resumed; the pool's `hosts` row and `/api/v1/hosts/fleet` say isolation `subuid` (#431)",
      "build 1639 (omarchy-cli, aarch64 native) staged from 15:12 to 15:16, and audit 1640 ran on studio-m2 from 15:16 to 15:17",
      // What the section's own checks have not yet seen, and until when the way back stays open.
      "**Still to be seen**, as of 2026-10-13: two items of *Check from the site* (below), the pool jobs (health, promote, security) on the remapped daemon — the #433 risk: if they fail there, the gate holds the rings — and a release reaching the host with no visit.",
      "The way back stays open until 2026-10-14 ~15:00 UTC, one day after the 15:01 drain.",
      "**What the remapping changes.**",
      "**Before it**, from the site.",
    ].map(at);
    expect([...observed].sort((a, b) => a - b)).toEqual(observed);
    // The ACL observed is the one step 6 checks for.
    expect(text).toContain("getfacl -c /srv/omarchy-host-secrets/agent.env # user::rw- user:231069:r-- group::--- mask::r-- other::---");
    // Nothing says the move is still to come.
    for (const stale of ["Until this move the Studio's rootful docker runs", "the move to `subuid` is the Studio's next step", "the recorded exception until P6"]) expect(text, stale).not.toContain(stale);
  });

  it("drains the host, stops its agent and dispatcher, runs prep-root.sh's opt-in after its dry run, sets the build caches aside, then installs again, and resumes", () => {
    const steps = [
      "**Drain** studio-m2's registration",
      `grep -c -- '--remap-existing-daemon) remap_existing' "$src/factory/host/prep-root.sh"`,
      "systemctl --user stop omarchy-agent",
      "docker stop omarchy-host-dispatcher-1",
      `${prep} --dry-run`,
      `${prep} \`\`\``,
      "mv \"$d\" \"$d.pre-remap\"",
      install,
      "**Resume** studio-m2's registration",
    ].map(at);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    // The opt-in is prep-root.sh's own, refused while the agent or a container runs.
    expect(prepRoot).toContain("--remap-existing-daemon) remap_existing=1; shift ;;");
    expect(prepRoot).toContain('refuse "$(grep -c . <<<"$names") container(s) run (');
    expect(text).toContain("`container(s) run (…)`");
    expect(prepRoot).toContain('agent_pids="$(pgrep -u "$user" -x omarchy-agent)"');
    expect(prepRoot).toContain('refuse "the agent runs as $user (omarchy-agent, pid ');
    expect(text).toContain("`the agent runs as firemanxbr (omarchy-agent, pid …)`");
    // Why the agent goes first: a dispatcher its round starts on the remapped daemon holds the model kinds.
    expect(text).toContain("`OMARCHY_AGENT_USER` (agent.env's owner) is no container user of a remapped daemon");
    expect(dispatchSource).toContain("names agent.env's owner, and no container user of this remapped daemon is it");
  });

  it("checks that the pool's release carries the opt-in before the host is drained, and again before anything stops", () => {
    // The check's pattern is the opt-in's own case line, once in prep-root.sh.
    expect(prepRoot.split("--remap-existing-daemon) remap_existing").length - 1).toBe(1);
    const site = `curl -fsS "https://raw.githubusercontent.com/firemanxbr/omarchy-pool/$tag/factory/host/prep-root.sh" | grep -c -- '--remap-existing-daemon) remap_existing'`;
    expect(at(site)).toBeLessThan(at("**Drain** studio-m2's registration"));
    expect(at(`grep -c -- '--remap-existing-daemon) remap_existing' "$src/factory/host/prep-root.sh"`)).toBeLessThan(at("systemctl --user stop omarchy-agent"));
  });

  it("says what prep-root.sh prints when it is right, in its own words", () => {
    const said: [string, string][] = [
      ["`the daemon holds N container(s) and M image(s), none of them running`", "the daemon holds ${counts% *} container(s) and ${counts#* } image(s), none of them running"],
      ["`dockremap's subordinate ids: 165536-231071, its own`", "dockremap's subordinate ids: $start-$((start + 65535)), its own"],
      ["`turned on: a container escape lands in an unprivileged subuid`", "turned on: a container escape lands in an unprivileged subuid"],
      ["`the old data root, /var/lib/docker (storage driver overlayfs, containerd namespace moby), stays as it is`", "the old data root, ${old_root:-?} (storage driver ${old_driver:-?}"],
      ["`the way back: install -m 0644 /etc/docker/daemon.json.pre-remap /etc/docker/daemon.json && systemctl restart docker.service`", "the way back: install -m 0644 $daemon_json.pre-remap $daemon_json && systemctl restart docker.service"],
      ["`docker remaps users (docker info lists name=userns): its data root /var/lib/docker/165536.165536, storage driver overlay2, containerd namespace moby-165536.165536`", "docker remaps users (docker info lists name=userns): its data root ${new_root:-?}, storage driver ${new_driver:-?}"],
      ["`in place, applied again after docker's restart`", "in place, applied again after docker's restart"],
      ["`userns-remap: docker info does not list name=userns after the restart`", "userns-remap: docker info does not list name=userns after the restart"],
      ["`userns-remap: docker did not start with it, and is down`", "userns-remap: docker did not start with it, and is down (journalctl -u docker says why); the way back: $back"],
    ];
    for (const [doc, code] of said) {
      expect(text, doc).toContain(doc);
      expect(prepRoot, code).toContain(code);
    }
    expect(prepRoot).toContain(", containerd namespace $old_ns");
    expect(prepRoot).toContain("), stays as it is: the remapped daemon starts empty");
    // dockremap's range after firemanxbr:100000:65536, and the sidecars' uid in it.
    expect(text).toContain("host uid 231069 (65533 inside)");
    expect(remapSource).toContain("pub const SIDECAR_ID: u32 = 65_533;");
  });

  it("installs again with the keys' own file and neither an enrollment token nor --legacy, and says what it prints in the agent's words", () => {
    // The session's install and the way back's are the same command.
    expect(text.split(install).length - 1).toBe(2);
    expect(sec).not.toContain("OMARCHY_ENROLL=");
    expect(sec).not.toMatch(/install\.sh[^\n`]*--legacy/);
    // legacy.json is written only with --legacy, and the retired record's exception is what the way back's install needs.
    expect(installSource).toContain("if let (Some(project), Some(seen)) = (&o.legacy, &ready.legacy) {");
    expect(installSource).toContain("legacy_project.is_some() || retired.is_some_and(|l| l.rootful_exception)");
    // A re-run keeps the identity and the worker token.
    expect(text).toContain("`this machine is host h_2t7pul95fs on …`");
    expect(enrollSource).toContain('"this machine is host {} on {}"');
    expect(text).toContain("`host h_2t7pul95fs keeps its worker token …`");
    expect(enrollSource).toContain('"host {} keeps its worker token ({}); `omarchy-agent token` rotates it"');
    // What preflight shows on the remapped daemon.
    expect(text).toContain("`isolation: subuid (a dedicated machine or VM)`, and no `! hosting:` line");
    expect(checksSource).toContain('Isolation::Subuid => "subuid"');
    expect(checksSource).toContain('"a dedicated machine or VM"');
    expect(text).toContain("`emulation x86_64: on, through qemu, on pages larger than the guest's: …`");
    expect(text).toContain("`legacy: omarchy-pool was retired at … ; its rootful exception stays until P6`");
    expect(installSource).toContain('"legacy: {} was retired at {} ({}); {}"');
    expect(installSource).toContain('"its rootful exception stays until P6"');
    // The keys written again with their ACL, the sidecars named by their remapped uid.
    expect(text).toContain("`wrote /srv/omarchy-host-secrets/agent.env (0640: its owner's, and readable by the agent sidecars' remapped uid 231069 through its ACL alone, #405; outside the work root)`");
    expect(installSource).toContain("(0640: its owner's, and readable by the agent sidecars' remapped uid {uid} through its ACL alone, #405; outside the work root)");
    expect(text).toContain("`OMARCHY_AGENT_REMAPPED_USER=65533:65533`");
    expect(dispatcherEnvSource).toContain('pub const AGENT_REMAPPED_USER: &str = "OMARCHY_AGENT_REMAPPED_USER";');
    // The dispatcher's two lines at start.
    expect(text).toContain("`this daemon remaps users (userns-remap): a task's root is host uid 165536, gid 165536, …`");
    expect(dispatchSource).toContain("this daemon remaps users (userns-remap): a task's root is host uid {}, gid {}, and what a task writes");
    expect(text).toContain("`agent sidecars and the probe run as 65533:65533 in this remapped daemon, host uid 231069, gid 231069, which agent.env's ACL lets read it (#405)`");
    expect(dispatchSource).toContain("agent sidecars and the probe run as {}:{} in this remapped daemon, host uid {}, gid {}, which agent.env's ACL lets read it (#405)");
  });

  it("checks from the site: the isolation, builds, an audit, the helpers, a hand-back to the VM, and a release with no visit", () => {
    expect(text).toContain('select(.name == "studio-m2").fleet | {isolation, state, release, units}');
    expect(text).toContain("SELECT isolation, agent_version, release_applied FROM hosts WHERE id = 'h_2t7pul95fs'");
    // Bounded by the ids noted before: a primary-key range, not the whole table.
    expect(text).toContain("SELECT (SELECT MAX(id) FROM build_tasks) AS n, (SELECT MAX(id) FROM events) AS e");
    expect(text).toContain("WHERE id > <N> AND lease_owner = 'firemanxbr-studio-m2-mnmw'");
    expect(text).toContain("WHERE id > <E> AND kind = 'build' AND json_extract(payload, '$.worker') = 'firemanxbr-studio-m2-mnmw'");
    expect(text).toContain("health, promote and security, which prove the helpers");
    expect(text).toContain("it needs a native x86_64 worker");
    expect(factorySource).toContain("needs a native ${task.arch} worker — back in the queue for one");
    expect(factorySource).toContain("worker: who,");
    expect(text).toContain("(`host runs vX.Y.Z`)");
    expect(rolloutSource).toContain('format!("{} runs {target}", ctx.cfg.set_name)');
    // The pool jobs go to studio-vm4k meanwhile.
    expect(text).toContain("SELECT value FROM settings WHERE key = 'host-pool-jobs'");
    expect(text).toContain("lease_owner = 'firemanxbr-studio-vm4k-z0q4'");
  });

  it("has a way back of one day that deletes nothing, and reclaims the old data root afterwards through the old daemon itself", () => {
    const back = text.slice(at("**The way back, within the day.**"));
    // Its install.sh fetched and checked in its own block (the session's step 6 removed it), then removed.
    const order = [
      'tag="$(curl -fsS https://pkgs.omarchy-pool.org/api/v1/version',
      'curl -fsSLo ~/install.sh "https://github.com/firemanxbr/omarchy-pool/releases/download/$tag/install.sh"',
      "gh attestation verify ~/install.sh -R firemanxbr/omarchy-pool",
      "systemctl --user stop omarchy-agent",
      "sudo install -m 0644 /etc/docker/daemon.json.pre-remap /etc/docker/daemon.json",
      "sudo systemctl restart docker",
      install,
      "rm -f ~/install.sh",
      "*Resume*",
    ].map((s) => back.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // One block that pastes as it stands in a new shell: it sets $tag and fetches install.sh before running it,
    // and gives back only the caches step 4 set aside (after a failed start there are none).
    const block = /```bash\n([\s\S]*?)```/.exec(sec.slice(sec.indexOf("**The way back, within the day.**")))?.[1] ?? "";
    expect(block.indexOf('tag="$(curl')).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("curl -fsSLo ~/install.sh")).toBeGreaterThan(block.indexOf('tag="$(curl'));
    expect(block.indexOf("sh ~/install.sh --work-root")).toBeGreaterThan(block.indexOf("gh attestation verify ~/install.sh"));
    expect(block).toContain('if [ -e "$d.pre-remap" ]; then');
    expect(back).toContain("`! hosting: a rootful daemon without userns-remap, beside the legacy set: recorded as an exception until P6`");
    expect(checksSource).toContain('"hosting: a rootful daemon without userns-remap, beside the legacy set: recorded as an exception until P6"');
    const reclaim = text.slice(at("**Afterwards, the move kept: the old data root reclaimed.**"));
    const steps = ["sudo install -m 0644 /etc/docker/daemon.json.pre-remap /etc/docker/daemon.json", "docker system prune --all --volumes --force", `${prep} `, "systemctl --user start omarchy-agent"].map((s) => reclaim.indexOf(s));
    expect(steps.every((i) => i >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(reclaim).toContain("sudo snapper -c root list");
  });

  it("The Studio host, prep-root.sh's paragraph and the known limits say the move was done on 2026-10-13, the recorded exception lasting until then", () => {
    const flat = (s: string) => s.replace(/\s+/g, " ");
    const host = flat(cut(runbook, "the-studio-host").split("\n### ")[0]);
    expect(host).toContain("**Isolation `subuid`, since 2026-10-13** (design v2 §19.1, §19.3, #407): rootful docker 29.9.0 with `userns-remap`");
    expect(host).toContain("A task container's root is host uid 165536, the first of `dockremap`'s subordinate ids (165536–231071)");
    expect(host).toContain("its page shows the level, `subuid (dedicated)`, and no *hosting* item");
    expect(host).toContain("`/var/lib/docker/165536.165536`");
    expect(host).toContain("Until that day it ran without remapping, isolation `root`: the recorded exception (D13)");
    expect(host).toContain("P6's one root session moved it, *The Studio at subuid* (below)");
    expect(host).toContain("Its agent sidecars run as 65533 inside, host uid 231069");
    // Nothing says the Studio still runs at root, or that the move is still to come.
    for (const stale of ["the move to `subuid` is the Studio's next step", "P6 moves it to `subuid`", "Until then its agent sidecars run as the agent's uid", "`root (dedicated)`"]) expect(host, stale).not.toContain(stale);
    expect(flat(runbook)).toContain("until the root session of *The Studio at subuid* (below) turned it on with that flag on 2026-10-13");
    expect(runbook).not.toContain("`subuid` isolation is P6's");
    expect(runbook).not.toContain("recorded exception until P6");
    expect(runbook).not.toContain("(`root` is the Studio's");
    expect(flat(runbook)).toContain("(`root` never meets it: refused for a new host, it is a recorded exception beside a legacy set only, as the Studio's was until its move to `subuid` on 2026-10-13;");
    // The agent sidecars' table names the Studio on the row it is on now.
    expect(runbook).toContain("| rootful docker without remapping (the Studio until 2026-10-13) |");
    expect(runbook).toContain("| rootful docker with userns-remap (the Studio since 2026-10-13) |");
    // The known limit is what holds now: subuid on a daemon still rootful, and the way back the retired record still allows.
    const limits = flat(cut(runbook, "known-limits"));
    expect(limits).not.toContain("The Studio's isolation is `root`");
    expect(limits).toContain("**The Studio is `subuid` on a rootful daemon.** Since 2026-10-13 its docker remaps users (*The Studio at subuid*, #407)");
    expect(limits).toContain("Its retired legacy record still carries the rootful exception (D13)");
    // The canary's and the switch's sections left with #404 (#346): nothing here points at them.
    expect(sec).not.toMatch(/\*The Studio (canary|switch)\*/);
  });

  it("asks only what is still to hold before the drain: the release carrying the opt-in, and studio-vm4k taking the pool jobs", () => {
    // The legacy set's retirement and #404 are done: said, not asked for.
    expect(text).toContain("its `retire-legacy` order done on 2026-10-13 at 12:36 UTC and its six registrations revoked");
    expect(text).toContain("With the legacy set retired and #404 merged, two preconditions remain");
    const order = [
      "two preconditions remain",
      "carries this section's own change, `prep-root.sh`'s `--remap-existing-daemon` (#434)",
      "studio-vm4k takes the pool jobs while studio-m2 is drained: `host-pool-jobs` says `*`",
      "SELECT value FROM settings WHERE key = 'host-pool-jobs'",
      "SELECT (SELECT MAX(id) FROM build_tasks) AS n, (SELECT MAX(id) FROM events) AS e",
      "**Drain** studio-m2's registration",
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The rings' cadence to compare with is the section's own query now that the switch's is gone.
    expect(text).toContain("julianday(finished_at) - julianday(LAG(finished_at) OVER (PARTITION BY kind ORDER BY finished_at))");
    expect(text).toContain("(*Before it*, step 3's second query)");
  });
});
