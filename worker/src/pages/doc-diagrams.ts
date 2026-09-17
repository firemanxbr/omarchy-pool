/**
 * The documentation's figures, drawn on the server in the dashboard's own
 * style — the boxes, arrows and labels of diagrams.ts, the same palette, no
 * image files. A chapter embeds one as `![caption](diagram:<name>)`; the
 * name is a key of DOC_DIAGRAMS and the caption becomes the figure's.
 */
import { dbox, darrow, dline, dpath, dlab, dot, svgo, esc } from "./diagrams";

/**
 * The publishing layer: every source feeds pkg-extract; the archive is stored
 * once in the pool, its manifest and every release in the index; the publisher
 * renders a release into databases the Worker signs and stores beside the
 * packages. pacman reads the bucket's domain directly, and omarchy-cli drives it.
 */
export function publishingLayerDiagram(): string {
  let s = "";
  const HEAD = svgo(1340, 365, "Six sources — Arch Linux, Arch Linux ARM, the OPR's edge channel, the Asahi projects, the optional prebuilt AUR selections and the factory's reviewed builds — feed pkg-extract, which reads .PKGINFO and the ELF sonames into a manifest; the archive is stored once in the pool and the manifest in the index, where releases are pinned selections per source, name and architecture for edge, rc, stable and the lab. From a release the publisher (pkg-repo) renders one pacman database per source, ring and architecture — the .db and its .files — and the Worker signs them with its own key and stores them beside the packages; pacman reads the bucket's domain directly, one section per source in order, with no worker on the read path, and omarchy-cli asks the index for the ring's release and the dependency graph and drives pacman.");
  // Every box is at least as wide as its longest line (dbox widens to the
  // text), so the widths here are the real ones and the gaps are real.
  const src: [string, string, string][] = [
    ["Arch Linux", "core · extra · multilib", ""],
    ["Arch Linux ARM", "core · extra · alarm", ""],
    ["Omarchy", "the OPR's edge channel", ""],
    ["Asahi", "the fork · asahi-alarm", ""],
    ["Prebuilt AUR", "optional · chaotic · aur", ""],
    ["The factory", "from reviewed PKGBUILDs", "amber"],
  ];
  src.forEach((r, i) => {
    const y = 23 + i * 46;
    s += dbox({ x: 20, y, w: 183, h: 38, title: r[0], lines: [r[1]], cls: r[2], tcls: r[2] }) + dline([203, y + 19, 228, y + 19]);
  });
  s += dline([228, 42, 228, 272]) + darrow(228, 157, 258, 157);
  // The extractor, sized to its text; two forks leave it: the archive to the pool, the manifest to the index.
  s += dbox({ x: 258, y: 118, w: 170, h: 78, title: "pkg-extract", lines: [".PKGINFO + ELF sonames", "→ the manifest", "the archive untouched"] });
  s += dpath("M428 143 L448 143 L448 96 L468 96", "", true) + dpath("M428 171 L448 171 L448 214 L468 214", "", true);
  s += dbox({ x: 468, y: 57, w: 170, h: 78, title: "Pool", big: true, cls: "hi", lines: ["Cloudflare R2", "<source>/<arch>/<file>", "stored once, immutable"] });
  s += dbox({ x: 468, y: 175, w: 170, h: 78, title: "Index", big: true, cls: "hi", lines: ["Cloudflare D1", "packages + manifests", "every release"] });
  // The lower row is the index's road: releases, then the databases the publisher renders from them.
  s += darrow(638, 214, 678, 214);
  s += dbox({ x: 678, y: 175, w: 183, h: 78, title: "Releases", lines: ["pinned selections", "edge · rc · stable · lab", "per source · name · arch"] });
  s += darrow(861, 214, 901, 214);
  s += dbox({ x: 901, y: 175, w: 196, h: 78, title: "pacman databases", lines: ["omarchy-<source>-<ring>.db", "and .files · by pkg-repo", "signed by the Worker's key"] });
  // The upper row is the bucket: the packages, and the databases stored beside them, read by pacman directly.
  // The URL is the include's own `Server =` line (setup.ts): `$arch` is pacman's variable, not a placeholder.
  s += darrow(638, 96, 1071, 96) + dlab(854, 58, ["https://pool…/<source>/$arch", "the bucket, read directly", "no worker on the read path"]);
  s += dline([999, 175, 999, 96]) + dlab(991, 138, ["stored beside the packages"], "end");
  s += dbox({ x: 1071, y: 57, w: 249, h: 78, title: "pacman", lines: ["[omarchy-<source>-<ring>]", "one section per source, in order", "only the repo name differs by ring"] });
  s += dbox({ x: 1137, y: 175, w: 183, h: 78, title: "omarchy-cli", lines: ["knows the release", "runs the safety check", "previews the hooks · MCP"] });
  s += darrow(1190, 175, 1190, 135, "dash") + dlab(1198, 159, ["drives pacman"], "start");
  // The client's road runs under the row, towards the index: what it asks there, not of the bucket.
  s += dpath("M1228 253 L1228 293 L553 293 L553 253", "dash", true);
  s += dlab(565, 315, ["asks the index: the ring's", "release, and the graph", "for the safety check"], "start");
  // The marks ride under the boxes: visible on the arrows, covered inside a box, never across its text.
  // Upstream packages ride green; the factory's, tried before anyone promises them, amber.
  const tail = " L228 157 L258 157 L343 157 L343 143 L428 143 L448 143 L448 96 L468 96 L638 96 L1071 96 L1190 96";
  const dots = dot("M203 42 L228 42" + tail, "#9ece6a", 10, 0) + dot("M203 134 L228 134" + tail, "#9ece6a", 10, 3.3) + dot("M203 272 L228 272" + tail, "#e0af68", 10, 6.6);
  // JetBrains Mono ligates "-<" into a hook arrow, which would eat the opening
  // bracket of omarchy-<source>-<ring>; the group turns the font's ligatures off
  // for this figure (the same property a site-wide rule on figure.diagram svg would set).
  return HEAD + dots + s + "</svg>";
}

/**
 * What a release is: a package lands in the pool once and edge gets a new
 * release whose selection gains it — by the sync, or from the lab by a
 * maintainer's approval; rc and stable later point at the same selection on
 * evidence, the fast lane gives them a release at once, a rollback is the
 * same write pointing back. Every release is a delta in the index and signed
 * databases beside the packages, rendered for the architectures it moved.
 */
export function releasePromotionDiagram(): string {
  let s = svgo(1300, 438, "A package published to the pool — one object, one row in the index — reaches edge, by the sync or from the lab by a maintainer's approval, as a new release whose selection gains it; rc and stable later get releases that point at the same selection, on evidence, not by calendar (the OPR's own channel for the ring is synced in right after), and a rollback is the same write pointing back at an earlier selection. A build the trial installed, or a security fix, reaches rc and stable directly as a fast-track. Every release is recorded in the index as a delta against its parent and rendered into signed pacman databases per source, for each architecture the release moved, stored beside the packages in the bucket, which pacman reads directly.");
  // Four boxes of one width across the row (each is at least as wide as its
  // longest line, so 250 is the real width); the gate labels sit just above
  // the row, where a wider font cannot push them into a box.
  const Y = 136, H = 76, MID = Y + H / 2;
  s += dbox({ x: 20, y: Y, w: 250, h: H, title: "Package published", big: true, cls: "hi", lines: ["an object in the pool, stored once", "a row in the index"] });
  s += darrow(270, MID, 330, MID) + dlab(300, 122, ["the sync or the publish job"]);
  s += dbox({ x: 330, y: Y, w: 250, h: H, title: "edge", big: true, tcls: "edge", cls: "edge", lines: ["a new release", "the selection gains the package"] });
  s += darrow(580, MID, 670, MID) + dlab(625, 122, ["one green check"]);
  s += dbox({ x: 670, y: Y, w: 250, h: H, title: "rc", big: true, tcls: "rc", cls: "rc", lines: ["a new release · the same selection", "on evidence, not by calendar"] });
  s += darrow(920, MID, 1030, MID) + dlab(975, 109, ["two green checks", "in a row · ≈ 6 h"]);
  s += dbox({ x: 1030, y: Y, w: 250, h: H, title: "stable", big: true, tcls: "stable", cls: "stable", lines: ["a new release · the same selection", "on evidence, without a human"] });
  // The fast lane, over the gates: a build the trial installed, or a security
  // fix edge already serves, gets its rc and stable releases at once — a
  // fast-track, not a promotion.
  s += dpath(`M540 ${Y} L540 68 L1060 68 L1060 ${Y}`, "hi dash", true) + dpath(`M880 68 L880 ${Y}`, "hi dash", true);
  s += dlab(750, 30, ["fast lane → rc and stable", "a build the trial installed,", "or a security fix in edge"], "middle", "hi");
  // The rollback: a ring points back at one of its own earlier selections — the loop stays over the ring.
  s += dpath(`M1265 ${Y} C1265 ${Y - 56}, 1130 ${Y - 56}, 1130 ${Y}`, "warn dash", true) + dlab(1188, 44, ["rollback: the same write,", "back to an earlier selection", "history stays append-only"]);
  // Every release, whichever ring, does two things: the bus below the rings
  // gathers the three and feeds the index record and the rendered databases.
  const B = Y + H + 40, R2 = B + 70;
  s += dline([455, Y + H, 455, B, 155, B]) + dline([455, B, 1155, B, 1155, Y + H]) + dline([795, Y + H, 795, B]);
  s += darrow(155, B, 155, R2) + dlab(163, B + 40, ["an index write"], "start");
  s += darrow(660, B, 660, R2) + dlab(668, B + 33, ["rendered and signed again", "for the arches that moved"], "start");
  s += dbox({ x: 20, y: R2, w: 270, h: 96, title: "In the index", lines: ["a pinned selection of package ids", "release_deltas against the parent", "a checkpoint every 24th release", "hundreds of rows, not the whole ring"] });
  s += dbox({ x: 525, y: R2, w: 270, h: 96, title: "In the bucket", lines: ["omarchy-<source>-<ring>.db · .files", "signed by the Worker's key · .sig", "per source and architecture", "stored beside the packages"] });
  s += darrow(795, R2 + 48, 1030, R2 + 48) + dlab(912, R2 + 36, ["Server = …/<source>/$arch"]);
  s += dbox({ x: 1030, y: R2, w: 250, h: 96, title: "pacman", cls: "dim", lines: ["reads the bucket directly", "no worker, no redirect", "only the repository name", "differs between rings"] });
  return s + "</svg>";
}

/**
 * The promote job: the source ring's evidence feeds the gate, whose verdict
 * has three ways out — nothing to promote, blocked, or promote; then the
 * index write, the render, the target's own health — confirmed, or pointed
 * back at the previous release by itself.
 */
export function promotionGatesDiagram(): string {
  let s = svgo(1340, 398, "The promote job: the evidence of the source ring — a real pacman with signed downloads and the ELF-level ABI check on two reference systems, on both architectures — goes through the gate, whose verdict is a gate event: nothing to promote when the target already serves the source's head, blocked with its reasons, or promote. A promotion is an index write with zero bytes copied; the databases are rendered and signed per architecture, the target ring gets the same health check, and a failure points the ring back at the previous release while a success confirms it with a promote event. Stable moves without a human.");
  // Every box is as wide as its longest line (dbox widens to the text), so
  // the gaps below are the real ones. The main line sits at y = 210; the
  // evidence above the gate, the rollback above the target's health, the
  // gate's two other ways out below it.
  const Y = 210, TOP = 20, TH = 76, MH = 76;
  // The evidence, above the gate: health + abi events of the source ring.
  s += dbox({ x: 20, y: TOP, w: 262, h: TH, title: "The evidence", big: true, cls: "amber", tcls: "amber", lines: ["the source ring, on both arches", "a real pacman -Sy + signed downloads", "ELF-level ABI check · two references"] });
  s += darrow(151, TOP + TH, 151, 162) + dlab(159, 118, ["health + abi events", "soak: 1 green check → rc,", "2 in a row → stable · ≈ 6 h"], "start");
  // The gate: its conditions; a verdict either way is a gate event.
  s += dbox({ x: 20, y: 162, w: 262, h: 96, title: "The gate", big: true, cls: "amber", tcls: "amber", lines: ["latest health recent, not an error", "not three errors in a day · soak met", "a recent ABI check with no blocker", "no security regression"] });
  s += darrow(282, Y, 386, Y) + dlab(334, Y - 12, ["ok · exit 0"]);
  s += dbox({ x: 386, y: Y - MH / 2, w: 170, h: MH, title: "Promote", big: true, lines: ["an index write", "zero bytes copied", "previous head recorded"] });
  s += darrow(556, Y, 614, Y);
  s += dbox({ x: 614, y: Y - MH / 2, w: 196, h: MH, title: "Render + sign", big: true, lines: ["omarchy-<source>-<ring>.db", ".files · signed · per arch"] });
  s += darrow(810, Y, 868, Y);
  s += dbox({ x: 868, y: Y - MH / 2, w: 196, h: MH, title: "Health of the target", big: true, cls: "amber", tcls: "amber", lines: ["the same real pacman check", "on the target ring", "x86_64 and aarch64"] });
  s += darrow(1064, Y, 1122, Y, "hi") + dlab(1093, Y - 12, ["ok"], "middle", "hi");
  s += dbox({ x: 1122, y: Y - MH / 2, w: 196, h: MH, title: "Confirmed", big: true, cls: "hi", lines: ["a promote event", "the ring keeps the release"] });
  // The split after the target's health: a failure points the ring back, by itself.
  s += darrow(966, Y - MH / 2, 966, TOP + TH, "warn dash") + dlab(974, 129, ["health failed", "on either arch"], "start");
  s += dbox({ x: 835, y: TOP, w: 262, h: TH, title: "Automatic rollback", cls: "amber", tcls: "amber", lines: ["pointed back at the previous release", "another index write · re-rendered", "a rollback event"] });
  // The gate's two other ways out, below it: one bus, two drops.
  s += dline([151, 258, 151, 280], "dash") + dline([118, 280, 364, 280], "dash") + darrow(118, 280, 118, 318, "dash") + darrow(364, 280, 364, 318, "dash");
  s += dbox({ x: 20, y: 318, w: 196, h: 60, title: "Nothing to promote", cls: "dim", lines: ["the target already serves", "the source's head · exit 3"] });
  s += dbox({ x: 256, y: 318, w: 216, h: 60, title: "Blocked", cls: "dim", lines: ["the reasons in the gate event", "force=yes skips it · exit 1"] });
  s += dlab(1318, 335, ["stable moves without a human", "the evidence is the reviewer", "a maintainer can roll back"], "end");
  return s + "</svg>";
}

/**
 * How the pool itself is released (release.yml): a pull request that CI and
 * E2E passed is squash-merged into main, the checks run again, the next
 * version comes from the last tag, binaries are built for both architectures,
 * a GitHub release carries them with the pool's public key, and the worker is
 * deployed with POOL_VERSION — the dashboard shows what runs. Below the road,
 * the by-hand bump and the worker image built from the same release.
 */
export function releasePipelineDiagram(): string {
  let s = svgo(1280, 228, "A pull request that ci.yml and e2e.yml passed is squash-merged into main; release.yml runs both again on the merged commit, takes the next version from the last tag — one patch step, or minor and major by the pull request's label, or a bump chosen by hand through workflow_dispatch — builds pkg-repo, omarchy-cli and pkg-extract on x86_64 and aarch64 runners, publishes a GitHub release with notes from the merged pull requests, the tarballs and omarchy-staging.pub.asc, then migrates and deploys the worker with POOL_VERSION and checks that /api/v1/version answers it. The dashboard shows what runs; the worker image on ghcr.io is built from the same release, for both architectures, signed with cosign.");
  // Every box is at least as wide as its longest line (dbox widens to the
  // text), so the x positions below are the real ones: five stations across
  // the width, 50 px between them, 120 px for the first arrow and its label.
  const Y = 20, H = 94, MID = Y + H / 2;
  s += dbox({ x: 20, y: Y, w: 196, h: H, title: "Pull request", big: true, cls: "amber", tcls: "amber", lines: ["ci.yml · e2e.yml must pass", "x86_64 · aarch64", "fmt · clippy · tests · tsc", "real pacman, end to end"] });
  s += darrow(216, MID, 336, MID) + dlab(276, MID - 25, ["squash merge", "into main"]);
  s += dbox({ x: 336, y: Y, w: 216, h: H, title: "Next version", big: true, lines: ["ci · e2e again on main", "last v* tag + one patch", "release:minor · release:major"] });
  s += darrow(552, MID, 602, MID);
  s += dbox({ x: 602, y: Y, w: 183, h: H, title: "Build", big: true, lines: ["x86_64 · aarch64 runners", "pkg-repo · omarchy-cli", "pkg-extract", "a tarball + sha256 each"] });
  s += darrow(785, MID, 835, MID);
  s += dbox({ x: 835, y: Y, w: 189, h: H, title: "GitHub release", big: true, lines: ["tag vX.Y.Z on the commit", "notes from the merged PRs", "tarballs + .sha256", "omarchy-staging.pub.asc"] });
  s += darrow(1024, MID, 1074, MID);
  s += dbox({ x: 1074, y: Y, w: 186, h: H, title: "Deploy", big: true, cls: "hi", lines: ["d1 migrations apply", "wrangler deploy --var", "POOL_VERSION:vX.Y.Z", "checks /api/v1/version"] });
  // Below the road: the by-hand entry into the version step, and what the
  // release leaves behind — the worker image built from it, and the running
  // version the dashboard shows.
  const Y2 = Y + H + 50;
  s += darrow(444, Y2, 444, Y + H, "dash") + dlab(436, Y + H + 29, ["overrides the label"], "end");
  s += dbox({ x: 350, y: Y2, w: 189, h: 44, title: "By hand", cls: "dim", lines: ["workflow_dispatch · bump="] });
  s += darrow(929, Y + H, 929, Y2, "dash") + dlab(937, Y + H + 29, ["cosign-signed"], "start");
  s += dbox({ x: 835, y: Y2, w: 196, h: 44, title: "Worker image", lines: ["ghcr.io · x86_64 · aarch64"] });
  s += darrow(1167, Y + H, 1167, Y2) + dlab(1159, Y + H + 23, ["deploy event", "on the record"], "end");
  s += dbox({ x: 1074, y: Y2, w: 186, h: 44, title: "Dashboard", lines: ["shows what runs · vX.Y.Z"] });
  return s + "</svg>";
}

/**
 * The thin client's install, left to right: the request asks the index for
 * the closure and keeps one build per name, the machine is read without a
 * write, every requirement is classified, the hooks are listed either way;
 * satisfied, pacman -U gets the objects' own addresses — a blocker leaves
 * below, refused with the reason, and pacman is never invoked.
 */
export function thinClientInstallDiagram(): string {
  let s = svgo(1340, 266, "A request — omarchy-cli install, or check — asks the index for the dependency closure and keeps one build per name in the pool's source_order; the client reads the machine, /var/lib/pacman/local and the shared libraries on disk, read-only, and classifies every requirement — depends, DT_NEEDED and symbol versions. It lists the hooks pacman would run; satisfied, it hands pacman -U the objects' own addresses on the pool; a blocker — a library on disk without the symbol version — refuses with the reason and exit 2, and pacman is never invoked.");
  // Every box is as wide as its longest line (dbox widens to the text), so
  // the gaps are real; the one label of the row sits 12 px above its arrow,
  // inside the widest gap.
  const cy = 70;
  s += dbox({ x: 20, y: 40, w: 176, h: 60, title: "The request", lines: ["omarchy-cli install foo", "or check foo, no pacman"] });
  s += darrow(196, cy, 250, cy);
  s += dbox({ x: 250, y: 30, w: 203, h: 80, title: "The closure", lines: ["GET /api/v1/graph", "?ring=…&arch=…&targets=foo", "one per name · source_order"] });
  s += darrow(453, cy, 507, cy);
  s += dbox({ x: 507, y: 20, w: 262, h: 100, title: "The safety check", cls: "amber", tcls: "amber", lines: ["depends · DT_NEEDED · symbol version", "ok · in the plan or installed", "warning · pacman resolves it", "blocker · the library is too old"] });
  s += darrow(769, cy, 823, cy);
  s += dbox({ x: 823, y: 30, w: 203, h: 80, title: "The hook preview", lines: ["the system's .hook files", "matched by name and by file", "listed · pacman runs them"] });
  s += darrow(1026, cy, 1104, cy, "hi") + dlab(1065, cy - 12, ["satisfied"], "middle", "hi");
  s += dbox({ x: 1104, y: 30, w: 216, h: 80, title: "pacman -U", big: true, cls: "hi", lines: ["<pool>/<source>/<arch>/<file>", "one address per package", "signature · install · hooks"] });
  // The machine, read below the check and compared there; the blocker's way
  // out leaves after the hooks are listed — where the verdict is acted on.
  s += dbox({ x: 507, y: 176, w: 209, h: 70, title: "The machine", lines: ["/var/lib/pacman/local", "the shared libraries on disk", "and their symbol versions"] });
  s += darrow(612, 176, 612, 120) + dlab(620, 152, ["read-only"], "start");
  s += dpath("M870 110 L870 211 L1111 211", "warn dash", true) + dlab(990, 199, ["pacman is never invoked"]);
  s += dbox({ x: 1111, y: 176, w: 209, h: 70, title: "Blocked · exit 2", cls: "dim", lines: ["the reason, per requirement", "libc.so.6 without GLIBC_2.34", "a release upgrade first"] });
  return s + "</svg>";
}

/**
 * The benchmark as a bar chart on a log scale: what a release promotion costs
 * at 275 GB with today's mechanics — copy the tree, upload a second bucket,
 * repo-add over every archive — against one index write and a database
 * rendered from the index. Minutes on one side, milliseconds on the other;
 * the notes stand in one column right of the plot.
 */
export function benchmarkPromotionDiagram(): string {
  let s = svgo(1310, 250, "A bar chart on a log scale from 10 ms to 1 h: promoting a 275 GB release with today's mechanics takes minutes — about 7.5 to copy the tree with rsync, 30 to 60 to upload and prune a second bucket, about 55 for repo-add to read every archive — while the pool + index writes the index in 22 ms with pkg-repo promote, needs no second bucket, and renders the database in 0.18 s with pkg-repo render, without reading an archive.");
  // The axis: log10 from 10 ms to 1 h, the bars anchored at its left end. The
  // row labels end at 272; the values stand 8 px right of their bar; the notes
  // share one column at 1046, clear of the plot and of the widest value.
  const X0 = 288, X1 = 944, TOP = 52, AXIS = 212, LAB = 272, NOTE = 1046, BAR = 18;
  const X = (ms: number) => Math.round((X0 + ((Math.log10(ms) - 1) / (Math.log10(3600000) - 1)) * (X1 - X0)) * 10) / 10;
  const ticks: [number, string][] = [[10, "10 ms"], [100, "100 ms"], [1000, "1 s"], [10000, "10 s"], [60000, "1 min"], [600000, "10 min"], [3600000, "1 h"]];
  const grid = ticks.map((t) => X(t[0]));
  // The rows: the chapter's table, a bar per cell. Within a row the bars are
  // 2 px apart, rows 14 px apart. The upload's bar is the reported range —
  // solid to 30 min, an outline to 60; the index has no bar for it: not needed.
  type Row = { y: number; label: string; ms?: number; to?: number; fill: "dim" | "green"; value: string; note: string };
  const rows: Row[] = [
    { y: 58, label: "promotion · copy the tree (rsync)", ms: 450000, fill: "dim", value: "~7.5 min", note: "local copy · from 8.0 s / 4.9 GB" },
    { y: 78, label: "promotion · write the index, 0 bytes", ms: 22, fill: "green", value: "22 ms", note: "1k pkgs · 37 ms at 10k · ~0.4 s live" },
    { y: 110, label: "promotion · 2nd bucket, upload+prune", ms: 1800000, to: 3600000, fill: "dim", value: "30–60 min", note: "reported by the team (rclone)" },
    { y: 130, label: "promotion · no 2nd bucket", fill: "green", value: "not needed", note: "the rings share one pool" },
    { y: 162, label: "database · repo-add, every archive", ms: 3300000, fill: "dim", value: "~55 min", note: "extrapolated from 58.9 s / 4.9 GB" },
    { y: 182, label: "database · render, 0 archives read", ms: 180, fill: "green", value: "0.18 s", note: "measured · 1k pkgs · 0.51 s at 10k" },
  ];
  // Where each bar ends and where its value stands: always 8 px right of the bar, in 11 px mono.
  const geo = rows.map((r) => { const end = r.to ? X(r.to) : r.ms ? X(r.ms) : X0; return { end, vx: end + 8, vw: r.value.length * 6.6 }; });
  // The legend: two swatches, the text in the text tokens — only the swatches wear the data colour.
  s += '<rect x="20" y="24" width="8" height="8" fill="var(--dim)" fill-opacity=".55"/>' + dlab(34, 32, ["today: omarchy-mirror + omarchy-pkgs"], "start");
  s += '<rect x="290" y="24" width="8" height="8" fill="var(--green)"/>' + dlab(304, 32, ["the pool + index"], "start");
  // Recessive gridlines behind the bars, one per decade and per minute mark. A
  // gridline is not drawn across a row whose value stands on it, so the digits
  // stay whole and nothing is painted over. The axes solid.
  ticks.forEach(([, t], i) => {
    if (i) {
      const g = grid[i];
      let y = TOP;
      rows.forEach((r, k) => { if (g > geo[k].vx - 4 && g < geo[k].vx + geo[k].vw + 4) { if (r.y > y) s += `<line class="d-l dash dimmed" x1="${g}" y1="${y}" x2="${g}" y2="${r.y}"/>`; y = r.y + BAR; } });
      s += `<line class="d-l dash dimmed" x1="${g}" y1="${y}" x2="${g}" y2="${AXIS}"/>`;
    }
    s += dlab(grid[i], AXIS + 16, [t]);
  });
  s += `<line class="d-l" x1="${X0}" y1="${TOP}" x2="${X0}" y2="${AXIS}"/><line class="d-l" x1="${X0}" y1="${AXIS}" x2="${X1}" y2="${AXIS}"/>`;
  rows.forEach((r, k) => {
    const base = r.y + 13, { end, vx } = geo[k];
    s += dlab(LAB, base, [r.label], "end");
    if (r.ms) {
      const solid = X(r.ms), w = (solid - X0).toFixed(1);
      // A slate bar is the dim token at .55 over the panel — an opaque backing so the gridlines do not show through.
      if (r.fill === "dim") s += `<rect x="${X0}" y="${r.y}" width="${w}" height="${BAR}" fill="var(--panel)"/>`;
      s += `<rect x="${X0}" y="${r.y}" width="${w}" height="${BAR}" fill="var(--${r.fill})"${r.fill === "dim" ? ' fill-opacity=".55"' : ""}/>`;
      // The reported range beyond the solid bar: an outline, so it reads as "up to".
      if (r.to) s += `<rect class="d-l dash" x="${solid}" y="${r.y}" width="${(end - solid).toFixed(1)}" height="${BAR}" fill="none"/>`;
    }
    s += dlab(vx, base, [r.value], "start", r.fill === "green" ? "hi" : "");
    s += dlab(NOTE, base, [r.note], "start");
  });
  return s + "</svg>";
}

/**
 * pkg-store's transaction, the proof's native install engine that was never
 * wired in: six stages left to right with Commit lit as the point of no return;
 * above, a failure or a crash before it replays the journal in reverse; below,
 * after it, only the cleanup is left and the next start finishes it.
 */
export function transactionLifecycleDiagram(): string {
  let s = svgo(1280, 260, "pkg-store's transaction in six stages: Stage unpacks the archives into a staging directory, Plan diffs them against the tracked files and finds collisions and .pacnew files, Journal persists every operation in one redb commit, Apply renames each file into place and parks the old content as .omarchy-old, Commit writes the new package state in one redb transaction, Cleanup deletes the backups, prunes empty directories and removes the staging. A failure or a crash before Commit replays the journal in reverse and leaves the system as it was; after Commit, the cleanup finishes on the next start.");
  // Six stages of one width — every line fits 165 px, so the widths are real — 50 px apart across the full width.
  const W = 165, G = 50, Y = 108, H = 60, MID = Y + H / 2;
  const stages: [string, string, string, string?][] = [
    ["Stage", "archives unpacked in", "staging/<tx>/<pkg>/"],
    ["Plan", "diff vs tracked_files", "collisions · .pacnew"],
    ["Journal", "every op persisted", "in one redb commit"],
    ["Apply", "per-file rename(2)", "old → .omarchy-old"],
    ["Commit", "new package state", "one redb transaction", "hi"],
    ["Cleanup", "backups, empty dirs", "and staging removed"],
  ];
  stages.forEach((st, i) => {
    const x = 20 + i * (W + G);
    s += dbox({ x, y: Y, w: W, h: H, title: st[0], big: true, lines: [st[1], st[2]], cls: st[3] ?? "" });
    if (i < stages.length - 1) s += darrow(x + W, MID, x + W + G, MID);
  });
  // Before Commit: the journal was written before any file moved, so a failure replays it in reverse at once and a crash on the next start — the arc leaves Apply and lands back on Stage.
  s += dpath("M747 108 C747 56, 102 56, 102 108", "warn dash", true) + dlab(424, 30, ["a failure or a crash before", "Commit: the journal replays", "in reverse · as it was"]);
  // After Commit: the state is in the database; only .omarchy-old backups and the staging remain, and the next start finishes them.
  s += dpath("M962 168 L962 208 L1177 208 L1177 168", "hi dash", true) + dlab(1070, 225, ["after Commit: the cleanup", "finishes on the next start"], "middle", "hi");
  // How the next start knows what to finish: the record's state, in the same redb file as the packages.
  s += dlab(20, 225, ["one record in state.redb:", "staging, applying, committed"], "start");
  return s + "</svg>";
}

/**
 * The factory's loop and the evidence's road. Above: what starts a build,
 * the pool's queue (the brain) and a worker anywhere that claims with a
 * lease and builds in a fresh container through the gate; an expired lease
 * goes back in the queue. Two doors out of the container: a merged recipe's
 * build goes straight into edge, signed by the pool; a contributor's build is
 * evidence, never a package — below, the audit, the project's own build, the
 * lab and the trial, a maintainer's approval, and the publish job into edge,
 * with the fast lane a trial earns.
 */
export function factoryLoopDiagram(): string {
  let s = svgo(1330, 470, "What starts a build — a request on the record and its owner's Build, a recipe merged, a new upstream release — is queued in the pool's build_tasks; a worker anywhere claims it with a thirty-minute lease, heartbeats, and builds it in a fresh container through the gate, the owner's agent drafting the PKGBUILD when none is given; an expired lease goes back in the queue on the scheduler's next tick. A merged recipe's build goes straight into edge, signed by the pool; a contributor's build is staged as evidence, never published: a second agent audits it, the project builds it again on a review worker, a real pacman installs the project's build in the lab, and a maintainer who does not own it approves — a project worker publishes the project's build into edge, the pool signs it, and rc and stable follow when the trial installed it.");
  // The loop, above. Every box is at least as wide as its longest line
  // (dbox widens to the text), so the widths here are the real ones.
  const T = 84, H = 96, Y = T + H / 2;
  s += dbox({ x: 20, y: T, w: 240, h: H, title: "What starts a build", lines: ["a request, then Build · signed", "a recipe merged · hourly enqueue", "a new upstream release · daily"] });
  s += darrow(260, Y, 310, Y);
  // The pool holds the queue: a container box with the queue strip inside it.
  s += `<rect class="d-box hi" x="310" y="${T}" width="260" height="${H}"/>`;
  s += `<text class="d-t" x="440" y="${T + 24}" text-anchor="middle" font-size="15">${esc("The pool")}</text>`;
  s += `<text class="d-s" x="440" y="${T + 42}" text-anchor="middle">${esc("the brain · a Cloudflare Worker")}</text>`;
  s += `<text class="d-s" x="440" y="${T + 56}" text-anchor="middle">${esc("queues and signs · never builds")}</text>`;
  s += `<rect class="d-queue" x="320" y="${T + 64}" width="240" height="24"/><text class="d-t small" x="440" y="${T + 81}" text-anchor="middle">${esc("build_tasks in D1 · ≤ 3 attempts")}</text>`;
  s += darrow(570, Y, 670, Y, "", true) + dlab(620, Y - 12, ["claim"]) + dlab(620, Y + 16, ["report"]);
  s += dbox({ x: 670, y: T, w: 240, h: H, title: "A worker, anywhere", lines: ["registered · ephemeral · pulls", "claims a task · a 30 min lease", "a heartbeat every 5 min"] });
  // An expired lease: the loop over the top, back into the queue.
  s += dpath(`M730 ${T} C730 ${T - 40}, 500 ${T - 40}, 500 ${T}`, "warn dash", true) + dlab(615, 29, ["an expired lease is requeued", "the scheduler, every 10 min"]);
  s += darrow(910, Y, 950, Y);
  // The recipe comes from the door that opened: drafted by the owner's agent
  // (a request, the project's review build), bumped from the approved
  // PKGBUILD (a new release), or fetched at its commit (a recipe merged).
  s += dbox({ x: 950, y: T, w: 262, h: H, title: "In a fresh container", lines: ["the recipe: drafted, bumped, fetched", "makepkg → the gate", "checksums · shellcheck · namcap ×2", "files · metadata · check() · smoke"] });
  // Two doors out. A merged recipe's build goes straight on into edge — the
  // project's own recipes take the enqueue door without a staged build.
  const R = 306, RH = 74, RY = R + RH / 2;
  s += dpath(`M1212 ${Y} L1240 ${Y} L1240 ${R}`, "", true) + dlab(1232, 276, ["merged recipe → edge, signed"], "end");
  // A contributor's build goes down to the road: staged, never published.
  s += dpath(`M980 ${T + H} L980 262 L115 262 L115 ${R}`, "", true) + dlab(988, 206, ["contributor's build: staged", "packages → owner's workspace", "signed evidence → the record"], "start");
  // The road, below: from the evidence to edge.
  s += dbox({ x: 20, y: R, w: 190, h: RH, title: "The evidence", cls: "amber", tcls: "amber", lines: ["PKGBUILD · log · .PKGINFO", "tests.log · vet.json", "never what users install"] });
  s += darrow(210, RY, 250, RY);
  s += dbox({ x: 250, y: R, w: 180, h: RH, title: "The audit", cls: "amber", tcls: "amber", lines: ["a second agent reads it", "ok · warn · block", "the maintainer decides"] });
  s += darrow(430, RY, 470, RY);
  // The pool's own build wears the pool's green: this is what can reach the rings.
  s += dbox({ x: 470, y: R, w: 200, h: RH, title: "The project builds it", cls: "hi", lines: ["on a review worker", "its own recipe · the gate", "queued like any build"] });
  s += darrow(670, RY, 710, RY);
  s += dbox({ x: 710, y: R, w: 190, h: RH, title: "The lab · the trial", cls: "amber", tcls: "amber", lines: ["pinned, never promised", "a real pacman installs it", "the transcript: trial.log"] });
  s += darrow(900, RY, 940, RY);
  s += dbox({ x: 940, y: R, w: 190, h: RH, title: "A maintainer approves", cls: "amber", tcls: "amber", lines: ["never their own package", "decided on the record", "a publish job follows"] });
  s += darrow(1130, RY, 1170, RY);
  s += dbox({ x: 1170, y: R, w: 140, h: RH, title: "edge", big: true, tcls: "edge", cls: "edge", lines: ["source factory", "the pool signs it"] });
  // The fast lane: the same publish reaches rc and stable when the trial installed the build.
  s += dpath(`M1035 ${R + RH} L1035 410 L1240 410 L1240 ${R + RH}`, "hi dash", true) + dlab(1137, 427, ["the fast lane:", "the trial installed it", "→ rc and stable with edge"], "middle", "hi");
  return s + "</svg>";
}

export const DOC_DIAGRAMS: Record<string, () => string> = {
  "publishing-layer": publishingLayerDiagram,
  "release-promotion": releasePromotionDiagram,
  "promotion-gates": promotionGatesDiagram,
  "release-pipeline": releasePipelineDiagram,
  "thin-client-install": thinClientInstallDiagram,
  "benchmark-promotion": benchmarkPromotionDiagram,
  "transaction-lifecycle": transactionLifecycleDiagram,
  "factory-loop": factoryLoopDiagram,
};
