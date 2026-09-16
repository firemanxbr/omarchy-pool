/**
 * How it works — the pool's process, documented where it runs: where every
 * package comes from (each source, its architectures, its keyring, where it
 * enters), what happens to it before it reaches a machine, what that
 * protects a user from, and what the pool does for the people who bring
 * packages in and the people who decide. The diagram is drawn on the server
 * (diagrams.ts) and its live lines are filled from /api/v1/stats.
 */
import { page } from "./layout";
import { sourcesDiagram } from "./diagrams";
import type { RunningVersion } from "../meta";
import { REPO_URL } from "../meta";

function body(pool: string): string {
  return String.raw`
  <h1>How it works</h1>
  <p class="lede">Packages come from the projects that build them, are verified against those projects' keys, stored once, and served in rings that only move forward on evidence. Nothing is rebuilt or re-signed; what changes is <em>when</em> a package reaches you and <em>what was checked</em> before it did. The pool verifies and validates — it does not choose whom to believe: no source, not Arch, not Omarchy, not the pool's own factory, reaches <code>rc</code> or <code>stable</code> on its name.</p>

  <div class="chart" style="padding:18px">${sourcesDiagram()}</div>

  <section id="sources">
    <h2>Where every package comes from</h2>
    <p class="sub">Every three hours a sync reads each source's database, downloads what is new and verifies its signature against that project's keyring — a package that does not verify never enters. It is stored once, in the source's own directory (<code>&lt;source&gt;/&lt;architecture&gt;/&lt;file&gt;</code>): two projects' builds of the same file name are two objects in two directories, and the order of the sections in your <code>pacman.conf</code> decides which one you get, exactly as with any set of mirrors.</p>
    <div class="table-wrap"><table><thead><tr><th>Source</th><th>Project</th><th>Architecture</th><th>Signed with</th><th>Enters</th><th>Note</th></tr></thead><tbody>
      <tr><td><code>core</code> <code>extra</code> <code>multilib</code></td><td>Arch Linux, from <code>mirror.omarchy.org</code></td><td>x86_64</td><td><code>archlinux-keyring</code></td><td><code>edge</code></td><td>Arch's released repositories; <code>[testing]</code> is not an input</td></tr>
      <tr><td><code>core</code> <code>extra</code> <code>alarm</code></td><td>Arch Linux ARM</td><td>aarch64</td><td><code>archlinuxarm-keyring</code></td><td><code>edge</code></td><td></td></tr>
      <tr><td><code>packages</code></td><td>Omarchy — the OPR, <code>pkgs.omarchy.org</code></td><td>x86_64 · aarch64</td><td>Omarchy's key</td><td><code>edge</code></td><td>the OPR's <code>edge</code> channel only; its <code>rc</code> and <code>stable</code> channels are not an input — the OPR earns <code>rc</code> and <code>stable</code> here like every other source</td></tr>
      <tr><td><code>asahi</code></td><td>Omarchy for Apple Silicon — maralcbr's fork, one GitHub release per snapshot</td><td>aarch64</td><td>the fork's key</td><td><code>edge</code></td><td>above the OPR in the include: on a Mac, its builds win</td></tr>
      <tr><td><code>asahi-alarm</code></td><td>Asahi Linux for Arch Linux ARM — kernel, graphics, firmware</td><td>aarch64</td><td><code>asahi-alarm-keyring</code></td><td><code>edge</code></td><td>above everything else, on a Mac</td></tr>
      <tr><td><code>chaotic</code> <span class="muted">optional</span></td><td>chaotic-aur, prebuilt AUR packages</td><td>x86_64</td><td><code>chaotic-keyring</code></td><td><code>edge</code></td><td>only names no other source provides; on a machine only with <code>--with chaotic</code></td></tr>
      <tr><td><code>aur</code> <span class="muted">optional</span></td><td>Arch Linux ARM's prebuilt AUR selection</td><td>aarch64</td><td><code>archlinuxarm-keyring</code></td><td><code>edge</code></td><td>the same rule</td></tr>
      <tr><td><code>factory</code></td><td>the pool's own builds, from contributors' recipes (<a href="/factory">Factory</a>)</td><td>x86_64 · aarch64</td><td>the pool's key</td><td>the <code>lab</code>, then <code>edge</code> on a maintainer's approval</td><td>packages nobody ships yet</td></tr>
    </tbody></table></div>
  </section>

  <section id="stages">
    <h2>What happens to a package</h2>
    <div class="steps">
      <div class="step"><h3>1. Sync — every three hours</h3><p>The upstream database is read and compared with the index by sha256; only what is missing is downloaded. Each file is checked against the upstream checksum and signature, its <code>.PKGINFO</code>, dependencies, <code>provides</code>, file list and the sonames its binaries load are extracted, and the archive plus its <code>.sig</code> are stored in the pool under <code>&lt;source&gt;/&lt;arch&gt;/&lt;file&gt;</code>. A file is never stored twice and never modified.</p></div>
      <div class="step"><h3>2. Pin — <code>edge</code></h3><p>A sync that changed something makes a new <b>edge</b> release: an immutable list of exactly which objects the ring serves, one row per source, name and architecture. Releases are append-only; every ring has a history it can be pointed back to. Edge is what the sources published in the last three hours, signature-verified and nothing else — for CI and developers.</p></div>
      <div class="step"><h3>3. Promote — on evidence, never on a calendar</h3><p>The sync that changed edge queues the evidence: a real <code>pacman -Sy</code> of the ring in a clean container on x86_64 and on aarch64, a signed download of a sample of every repository, the ELF-level ABI check of every upgrade the ring would apply to a reference system (on x86_64, an Omarchy installation), and the security layer's look for a regression. Green on both architectures, and edge is <b>rc</b> within minutes. rc is checked again every three hours; the second green check in a row makes it <b>stable</b> — about six hours after rc. Both architectures move together (one alone only by a maintainer's hand, when the other is red).</p></div>
      <div class="step"><h3>4. Render, verify, and roll back on your own</h3><p>The ring's pacman databases (<code>omarchy-&lt;source&gt;-&lt;ring&gt;.db</code> and <code>.files</code>) are generated from the index, signed with the pool's database key and placed beside the packages. A promotion is followed by the same health check on the target ring; if it fails, the ring is pointed back at its previous release and re-rendered before you notice. A ring is a pinned selection: going back is an index write, no bytes move.</p></div>
      <div class="step"><h3>The lab and the trial</h3><p>Beside the three rings there is a fourth, the <b>lab</b>, where nothing is promised: no sync targets it, no promotion comes from it or goes into it. It is where the factory's builds are tried before anyone decides — a real pacman installs them in a clean container from the lab above edge, and the transcript sits beside the audit — and where any package of the pool can be pinned to be tried in a combination. <code>--ring lab</code> on a machine puts the lab's sections above edge's.</p></div>
      <div class="step"><h3>The fast lane</h3><p>A fix should not wait for a soak. A factory build the trial installed, and a security fix the security layer has confidence in, go to rc and stable with edge in the same step — recorded as a <code>fast-track</code> in the <a href="/journal?kind=fast-track">journal</a>, with the reason. The fast lane is the evidence's, not anyone's to grant.</p></div>
    </div>
  </section>

  <section id="protects">
    <h2>What protects you</h2>
    <div class="steps">
      <div class="step"><h3>Signatures, twice</h3><p>Every package keeps its project's signature, and the pool verified it against that project's keyring when it entered. The pool signs the databases it renders with a key that never leaves the Worker; your <code>pacman.conf</code> trusts that key for the databases and the projects' keys for the packages. The pool cannot alter a package without breaking its signature.</p></div>
      <div class="step"><h3>A real pacman, before you</h3><p>Every promotion is preceded by an actual <code>pacman -Sy</code> and signed downloads on both architectures in a clean container. The most common breakage — a database that does not sync, a package that does not verify — never reaches rc.</p></div>
      <div class="step"><h3>The ABI check</h3><p>Every upgrade a ring would apply is checked at the ELF level against a reference system: a library that would leave a binary without the symbol version it needs blocks the promotion. <code>omarchy-cli check</code> runs the same check on your machine before an out-of-band install.</p></div>
      <div class="step"><h3>The security layer</h3><p>The Arch and Debian security trackers, OSV, CISA KEV and EPSS, matched every three hours against what each ring serves; because the index knows what every binary loads, an advisory on a library also marks what <em>uses</em> it. A promotion that would replace a clean package with a vulnerable one is blocked; a confident fix is pulled forward. The <a href="/security">Security</a> page shows the ring, the package page the chain.</p></div>
      <div class="step"><h3>Immutable releases, automatic rollback</h3><p>A ring never edits a release; it points at one. A failed health check after a promotion points it back — and the next <code>pacman -Syu</code> sees the restored release.</p></div>
      <div class="step"><h3>One rule between sources</h3><p>Two projects' builds of one name both stay in the pool; the include's order — Asahi's above the OPR's above Arch's — is the only thing that decides, and it is written in your <code>pacman.conf</code> where you can read it.</p></div>
      <div class="step"><h3>Nothing skips the gates</h3><p>Not the OPR, not the factory, not a maintainer's own package. The evidence is on the <a href="/pipeline">Pipeline</a> page and in the <a href="/journal">journal</a>, for anyone.</p></div>
    </div>
  </section>

  <section id="never">
    <h2>What a build can never touch</h2>
    <p class="sub">A build is somebody else's code — the recipe and the upstream's build system — and its log is public, on the API while it is in staging and on the record once it is staged. The rule, kept the same way on the project's host, a contributor's and a maintainer's: <b>the build sees nothing the log cannot show</b> — the public log is the proof, not the risk.</p>
    <div class="steps">
      <div class="step"><h3>The broker</h3><p>One process per host holds the credentials — the worker's token, the agent's key, a GitHub token — and only receives, processes and answers: the pool's calls for the one task it claimed, the agent, GitHub read-only. It runs no build. The project's review builds reach the agent the same way, through a proxy. <a href="/docs/workers#secrets">What the broker holds →</a></p></div>
      <div class="step"><h3>The builder</h3><p>Born with nothing but the broker's address, builds one task and dies. Inside it the build user starts from an empty environment; a variable set on it by mistake is dropped at start and said so. <code>env</code> in a PKGBUILD prints <code>PATH</code> and <code>HOME</code>. <a href="/docs/workers">Run a worker →</a></p></div>
      <div class="step"><h3>The pool's check</h3><p>For the worker the pool does not run: every log, recipe and report uploaded is read for what looks like a secret — the pool's tokens, agents' keys, GitHub's, a private key, a credential in a URL — and refused at the door with the kind and the line, never the match. The record never receives one. <a href="${REPO_URL}/blob/main/SECURITY.md">SECURITY.md →</a></p></div>
      <div class="step"><h3>Two words on a worker, a tombstone on a record</h3><p>A worker becomes the project's on two maintainers' word, never its owner's alone; the Review page names the worker and host behind every build. A record is written once and can be withdrawn by a maintainer with a reason — a signed tombstone takes its place. The signing key itself lives inside the pool's Worker; no worker, runner or repository holds it. <a href="/workers">Workers →</a></p></div>
    </div>
  </section>

  <section id="people">
    <h2>What the pool does for the people who bring packages in, and the people who decide</h2>
    <div class="cando">
      <div><h4>for contributors</h4><ul class="yes">
        <li><b>Ask for a package, on the record.</b> A request is a signed record; the project's agent drafts a recipe from the project's sources.</li>
        <li><b>Build it at home with the same tools.</b> The same signed worker image, the same conventions, <code>namcap</code>, the same build — on your machine, with your compute. Your build is <em>evidence</em>, never the product: nothing you built is served to anyone.</li>
        <li><b>A second pair of eyes before a human's.</b> When your build is staged, the pool's agent audits the recipe, the log and the metadata and attaches a report beside it.</li>
        <li><b>Watch it happen.</b> Your workspace, your packages, your workers and every step of every build on the <a href="/factory">Factory</a> and <a href="/review">Review</a> pages; the journal keeps the record.</li>
      </ul></div>
      <div><h4>for maintainers</h4><ul class="yes">
        <li><b>The evidence in front of you.</b> The contributor's build, the gate's verdict, the audit, the log and the recipe on one row — and <em>Build by the project</em> one press away.</li>
        <li><b>The project builds it again.</b> A trusted worker with the project's own agent writes the project's recipe from the project's sources, learning from the contributor's evidence; the same gate runs; its own audit is queued.</li>
        <li><b>The trial installs it before you decide.</b> A real pacman installs the project's build from the lab in a clean container; the transcript sits beside the audit. You approve what installed, not what compiled.</li>
        <li><b>Nobody decides on their own package</b> — not even the only maintainer. A build the trial installed goes to stable with edge; one it did not waits for the gates like everything else.</li>
        <li><b>A rollback is one job away</b>, and so is every pipeline step by hand (<code>pkg-repo job …</code>), with a per-job token that can do that and nothing else.</li>
      </ul></div>
    </div>
  </section>

  <section id="behind">
    <h2>How far behind upstream</h2>
    <div class="table-wrap"><table><thead><tr><th>Ring</th><th>Behind the source</th><th>Because</th></tr></thead><tbody>
      <tr><td><code>edge</code></td><td>≤ 3 hours</td><td>the sync's interval</td></tr>
      <tr><td><code>rc</code></td><td>minutes after edge's checks pass</td><td>the health and ABI checks on both architectures, and the security layer</td></tr>
      <tr><td><code>stable</code></td><td>≈ 6 hours after rc</td><td>two green health checks in a row, three hours apart</td></tr>
      <tr><td>a fast-tracked fix</td><td>none</td><td>it goes to stable with edge</td></tr>
    </tbody></table></div>
  </section>

  <section id="server">
    <h2>Why one host is enough</h2>
    <p class="sub">Today an Omarchy machine talks to several repositories, each with its own mirror, cadence and failure modes. Here they are one set of databases per ring, generated from the same index, on both architectures — one section per source, in the order that decides.</p>
    <div class="howto">
      <div class="arch"><div class="archhead"><span class="archname">before</span></div><pre>[omarchy]
Server = https://pkgs.omarchy.org/$repo/$arch

[core]
Include = /etc/pacman.d/mirrorlist
[extra]
Include = /etc/pacman.d/mirrorlist
[multilib]
Include = /etc/pacman.d/mirrorlist</pre></div>
      <div class="arch"><div class="archhead"><span class="archname">with the pool</span></div><pre>[omarchy-packages-stable]
Server = ${pool}/packages/$arch
[omarchy-core-stable]
Server = ${pool}/core/$arch
[omarchy-extra-stable]
Server = ${pool}/extra/$arch
[omarchy-multilib-stable]
Server = ${pool}/multilib/$arch
<span class="c"># one host, a directory per source, both architectures;
# change "stable" to "rc" or "edge" to change rings;
# a section appears when the ring serves that source —
# the exact list for your ring and architecture is on Get started</span></pre></div>
    </div>
  </section>

  <section id="trust">
    <h2>What you trust</h2>
    <p class="sub">Two things, and only two.</p>
    <div class="steps">
      <div class="step"><h3>The projects' own keys — unchanged</h3><p>Packages are the exact files Arch, Arch Linux ARM, Omarchy and the Asahi projects built and signed. pacman verifies each package with the keyring you already have (<code>archlinux-keyring</code>, <code>archlinuxarm-keyring</code>, Omarchy's key, the Asahi keyrings on a Mac).</p></div>
      <div class="step"><h3>The pool's database key — one import</h3><p>The pacman databases are generated here, so they are signed here — inside the pool's own service, by a key that never leaves it: no build worker, runner or repository holds it. That key signs the databases and the packages the factory builds, nothing else; its public part is in the repository, at the pool root and at <code>/api/v1/signing-key</code>, and with <code>SigLevel = Required DatabaseRequired</code> pacman refuses a database it did not sign.</p></div>
    </div>
  </section>

  <section id="seal">
    <h2>The seal: where every package came from, with proof</h2>
    <p class="sub">A package from the AUR is a recipe someone maintains; a package from a distribution is a file its build farm signed. A package from the pool carries its <b>provenance</b> with it, and every package page shows it.</p>
    <div class="steps">
      <div class="step"><h3>Imported</h3><p>A synced package names its upstream project and repository, and the keyring its signature was verified against the moment it entered the pool — served as built and signed there, never rebuilt.</p></div>
      <div class="step"><h3>Built by the Omarchy Pool</h3><p>A factory package carries the whole chain: the contributor's build that was the evidence (its worker, its agent, its log), the second agent's audit and verdict, the trial's transcript, the maintainer who approved it, the recipe the project built on a trusted worker. The chain is also written <b>next to the object in the pool</b> as an attestation — an in-toto statement about that exact file — with the pool's detached signature beside it, so anyone can verify it with the pool's public key and never trust this page.</p></div>
      <div class="step"><h3>On your machine</h3><p><code>omarchy-cli info &lt;package&gt;</code> prints the seal; <code>omarchy-cli provenance</code> prints one line per package, and as a pacman hook it says, after every install, where what you just installed came from. <code>pacman -Qi</code> shows it too: <code>Packager: omarchy-pool factory</code>, repository <code>omarchy-factory-&lt;ring&gt;</code>.</p></div>
    </div>
  </section>

  <section id="pieces">
    <h2>The pieces</h2>
    <p class="sub">All of it is open source (MIT), released on every merge, and shows its version in the header. The code's own documentation — architecture, runbook, testing — is in the repository, for people working on the pool itself.</p>
    <div class="table-wrap"><table><thead><tr><th>Piece</th><th>What it is</th></tr></thead><tbody>
      <tr><td>Pool</td><td>A Cloudflare R2 bucket with a custom domain. pacman reads packages and databases from it as plain static files; nothing runs in front of them.</td></tr>
      <tr><td>Index</td><td>A D1 (SQLite) database: one row per package object with its manifest, dependency edges, sonames; releases and ring heads; every event the pipeline records.</td></tr>
      <tr><td>API + this site</td><td>One Cloudflare Worker serving <code>/api/v1</code> and these pages.</td></tr>
      <tr><td>Pipeline</td><td>Jobs the pool queues on its own clock and project workers pull: sync (every 3 h, one release per ring), the evidence and the promotion it earns (after every sync that changed edge; rc checked every 3 h), health, security (every 3 h), the trial of every review build, GC (weekly); a metrics snapshot every 30 min and the daily cost estimate by the pool itself. GitHub only releases the code (every merge).</td></tr>
      <tr><td>Factory</td><td>The build queue lives in the index (requests, tasks, leases); workers are containers anywhere — a contributor's laptop for their own packages, machines the project trusts for what maintainers approved — that claim a task, build it in a fresh Arch container and report; the pool signs what a project worker publishes. A lease that expires goes back to the queue.</td></tr>
      <tr><td>Tools</td><td><code>pkg-repo</code> (the publisher: sync, promote, gate, trial, render, security, gc), <code>pkg-extract</code> (manifests), <code>pkg-check</code> (the ABI check), <code>omarchy-cli</code> (the thin client) — Rust, built for both architectures on every release.</td></tr>
    </tbody></table></div>
  </section>
`;
}

/** Fills the diagram's live lines: when each source was last synced and how much of it the pool holds, the pool's size, the rings' heads. */
const SCRIPT = String.raw`
  var GROUPS = { "src-arch": [["core", "x86_64"], ["extra", "x86_64"], ["multilib", "x86_64"]], "src-alarm": [["core", "aarch64"], ["extra", "aarch64"], ["alarm", "aarch64"]], "src-opr": [["packages", "x86_64"], ["packages", "aarch64"]], "src-asahi": [["asahi", "aarch64"]], "src-asahi-alarm": [["asahi-alarm", "aarch64"]], "src-optional": [["chaotic", "x86_64"], ["aur", "aarch64"]] };
  function live(key, text) { document.querySelectorAll('[data-live="' + key + '"]').forEach(function (el) { el.textContent = text; }); }
  liveStats(function (d) {
    var cov = d.coverage || [];
    Object.keys(GROUPS).forEach(function (k) {
      var rows = cov.filter(function (c) { return GROUPS[k].some(function (g) { return g[0] === c.source && g[1] === c.arch; }); });
      var n = rows.reduce(function (s, c) { return s + Number(c.indexed || 0); }, 0);
      var last = rows.map(function (c) { return c.last_sync; }).filter(Boolean).sort().pop();
      live(k, last ? ago(last) + " · " + num(n) + " packages" : n ? num(n) + " packages" : "not synced yet");
    });
    live("stored-once", num(d.pool.objects) + " objects · " + bytes(d.pool.bytes));
    ["edge", "rc", "stable"].forEach(function (n) { var r = d.rings.filter(function (x) { return x.ring === n; })[0]; live(n + "-head", r && r.release ? "#" + r.release.seq + " · " + ago(r.release.created_at) : "no release yet"); });
  }, 120000);
`;

export function howItWorksHtml(poolUrl: string, version: RunningVersion): string {
  return page({
    title: "How it works · omarchy-pool",
    description: "Where every package comes from, what is checked before it reaches you, what protects you, and what the pool does for contributors and maintainers.",
    active: "docs",
    doc: "how-it-works",
    body: body(poolUrl.replace(/\/$/, "")),
    script: SCRIPT,
    poolUrl,
    version,
  });
}
