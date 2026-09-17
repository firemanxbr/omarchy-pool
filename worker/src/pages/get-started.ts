/**
 * Get started: the exact pacman configuration for a ring and an architecture,
 * generated from what the ring serves right now, plus the database key and
 * the optional thin client. `?ring=stable&arch=x86_64` preselects. The
 * sections by hand are the API's own words: the page is served with the
 * include GET /api/v1/pacman.conf answers for the picked ring and
 * architecture (getStartedSample, rendered by the same function), and the
 * script asks the same route again whenever the pick or the optional
 * sources change — nothing on the page derives the include itself.
 */
import { page } from "./layout";
import { EVERYONE, type Component, type Fixture } from "./components";
import { escapeHtml } from "../html";
import { pacmanInclude } from "../routes/setup";
import type { Env } from "../index";
import type { RunningVersion } from "../meta";

/** The ring and the architecture the page opens on: the address's, else stable on x86_64 — the script's own rule. */
const picked = (url: URL) => ({ ring: url.searchParams.get("ring") ?? "stable", arch: url.searchParams.get("arch") ?? "x86_64" });

/** The include the page is served with, for the pick the address makes: what the API answers, at request time; null when the ring has no release for the architecture (or the pick is not one). */
export function getStartedSample(env: Env, url: URL): Promise<string | null> {
  const { ring, arch } = picked(url);
  return pacmanInclude(env, ring, arch, new Set(), `${url.origin}/setup`);
}

/** The include as the page shows it: the API's text, each section's name in bold; without one, the script's own words for a ring that serves nothing yet. */
const confHtml = (sample: string | null) => (sample ? escapeHtml(sample).replace(/^\[(.+)\]$/gm, "[<b>$1</b>]") : '<span class="c"># loading what the ring serves…</span>');

const body = (sample: string | null) => String.raw`
  <h1>Get started</h1>
  <p class="lede">One command — or three steps by hand: trust the key that signs the databases, point pacman at a ring, upgrade. Packages keep the signatures of the project that built them (Arch, Arch Linux ARM, Omarchy, the Asahi projects) — the only new key you trust signs the databases and what the pool builds itself.</p>

  <div class="steps">
    <div class="step" id="which-ring">
      <h3>Which ring is for me?</h3>
      <div class="quiz" id="quiz"></div>
      <p id="quiz-answer" style="margin-top:10px"></p>
    </div>

    <div class="step" id="ring">
      <h3>1. Choose a ring and your architecture</h3>
      <p>Not sure? <b>stable</b> is the one to use on a machine you rely on.</p>
      <div class="choice" id="pick-ring"></div>
      <div class="choice" id="pick-arch"></div>
      <div id="ring-desc" class="muted" style="font-size:13.5px"></div>
    </div>

    <div class="step" id="command">
      <h3>The one command</h3>
      <p>Everything below, done for you — once per machine, on x86_64 or aarch64 (it finds out):</p>
      <pre><span class="copy" data-copy="setup">copy</span><span id="setup-cmd"></span></pre>
      <p>What it does, and nothing else: trusts the key that signs the pool's databases (step 2); writes <code>/etc/pacman.d/omarchy-pool.conf</code> with the repositories the ring serves right now (step 3 — asked to the pool at run time, so it is never stale); adds one line to <code>/etc/pacman.conf</code>, above <code>[core]</code>, once: <code>Include = /etc/pacman.d/omarchy-pool.conf</code>; runs <code>pacman -Sy</code> and tells you to run the upgrade — <code>omarchy update</code> on an Omarchy install (its pacman hook refuses a bare <code>pacman -Syu</code>), <code>sudo pacman -Syu</code> elsewhere. It keeps a backup (<code>pacman.conf.bak-omarchy-pool</code>), it never upgrades on its own, and it never touches your other repositories.</p>
      <p><b>Why an <code>Include</code>, above <code>[core]</code>.</b> pacman takes a package from the first repository that has it, in file order. What you keep above the line — an Asahi <code>[omarchy]</code> or <code>[asahi-alarm]</code> on a Mac, a repository of your own — keeps priority; the pool serves core, extra, multilib, alarm, the OPR and the factory's builds from the ring; Arch's own mirrors below the line stay as the fallback for the rare package the pool does not have yet, and for repositories it does not mirror (<code>[aur]</code> on Arch Linux ARM). Switching rings rewrites the include file only: <code>--ring rc</code>, <code>--ring edge</code>; <code>--remove</code> deletes it and takes the line out. <a href="/setup">The script, in full →</a></p>
      <p><b>The first upgrade.</b> Usually "nothing to do": <em>stable</em> is hours behind upstream, and pacman never downgrades what a mirror already gave you. From then on the upgrades come through the ring when it promotes them.</p>
    </div>

    <div class="step" id="key">
      <h3>2. Trust the database key</h3>
      <p>Once per machine. The key signs the pacman databases and the packages the pool builds itself (source <em>factory</em>); every other package still carries its upstream signature.</p>
      <pre><span class="copy" data-copy="key">copy</span><span id="key-cmd"></span></pre>
    </div>

    <div class="step" id="conf">
      <h3>3. Configure pacman, by hand</h3>
      <p>Save the sections below as <code>/etc/pacman.d/omarchy-pool.conf</code> (<code>sudo nvim</code>, or <code>curl -o</code> from <code>/api/v1/pacman.conf?ring=…&amp;arch=…</code> — the same text), then add <code>Include = /etc/pacman.d/omarchy-pool.conf</code> to <code>/etc/pacman.conf</code> above <code>[core]</code>. The list is what the ring serves right now.</p>
      <div class="choice" id="optional"></div>
      <pre><span class="copy" data-copy="conf">copy</span><span id="conf-text">${confHtml(sample)}</span></pre>
      <p>Then:</p>
      <pre><span class="copy" data-copy="up">copy</span><span id="up-cmd">omarchy update</span>   <span class="c"># off Omarchy: sudo pacman -Syu</span></pre>
    </div>

    <div class="step" id="cli">
      <h3>Optional: omarchy-cli</h3>
      <p>A thin client that knows about rings and releases: <code>status</code> shows what the ring would change on this machine, <code>check</code> runs the ABI safety check before an out-of-band install, <code>upgrade</code> drives pacman and pins the release you are on, <code>security</code> lists the advisories that apply here. A package of the factory, in every ring; not on your ring yet? Binaries for both architectures ship with every <a href="https://github.com/firemanxbr/omarchy-pool/releases">release</a>.</p>
      <pre><span class="copy" data-copy="cli">copy</span><span id="cli-cmd"></span></pre>
    </div>

    <div class="step" id="switching">
      <h3>Switching rings, going back</h3>
      <p>Only the repository names change between rings (<code>omarchy-core-stable</code> → <code>omarchy-core-rc</code>); the packages are the same objects. A ring itself rolls back automatically when a promotion fails its health check — you do not have to do anything, the next <code>pacman -Syu</code> sees the restored release.</p>
    </div>
  </div>
`;

const SCRIPT = String.raw`
  var RINGS = ["stable", "rc", "edge", "lab"], ARCHES = ["x86_64", "aarch64"];
  // Three questions, one recommendation — the ring the command below uses.
  var QUIZ = [["rely", "This machine matters to me — I cannot afford a broken morning."], ["early", "I want to see problems before everyone else does."], ["ci", "This is a CI runner or a throwaway VM."], ["build", "I am trying a build of the factory before it is approved."]], quiz = {};
  function drawQuiz() {
    $("#quiz").innerHTML = QUIZ.map(function (r) { return '<div class="q"><span>' + r[1] + '</span><span class="yn" id="q-' + r[0] + '"></span></div>'; }).join("");
    QUIZ.forEach(function (r) { pick("#q-" + r[0], ["yes", "no"], quiz[r[0]] === true ? "yes" : quiz[r[0]] === false ? "no" : null, function (v) { quiz[r[0]] = v === "yes"; drawQuiz(); }); });
    var rec = quiz.build ? "lab" : quiz.ci ? "edge" : quiz.early ? "rc" : "stable", answered = Object.keys(quiz).length > 0;
    $("#quiz-answer").innerHTML = answered ? '<b style="color:var(--' + rec + ')">' + rec + '</b> — ' + esc(DESC[rec]) + ' <a href="#ring" data-rec="' + rec + '" style="color:var(--green);text-decoration:none">Use ' + rec + ' below →</a>' : '<span class="dim">answer what applies; stable is the answer when nothing does.</span>';
    var a = $("#quiz-answer a"); if (a) a.onclick = function () { ring = a.getAttribute("data-rec"); draw(); };
  }
  var DESC = {}; Object.keys(RINGS_TEXT).forEach(function (r) { DESC[r] = RINGS_TEXT[r].desc; });
  var q = new URLSearchParams(location.search);
  var ring = RINGS.indexOf(q.get("ring")) >= 0 ? q.get("ring") : "stable";
  var arch = ARCHES.indexOf(q.get("arch")) >= 0 ? q.get("arch") : "x86_64";
  var data = null, optional = {};

  // The sections are the API's: /api/v1/pacman.conf for the pick and the optional sources switched on, asked again only when one of them changes (the served page already carries the answer for the address's pick); a late answer to an earlier pick is dropped.
  var confKey = "", confSeq = 0;
  function drawConf() {
    var withOptional = Object.keys(optional).filter(function (k) { return optional[k]; }).sort();
    var key = ring + "|" + arch + "|" + withOptional.join(",");
    if (key === confKey) return;
    confKey = key;
    var seq = ++confSeq;
    fetch("/api/v1/pacman.conf?ring=" + ring + "&arch=" + arch + "&with=" + withOptional.join(",")).then(function (r) { return r.ok ? r.text() : null; }).then(function (t) {
      if (seq !== confSeq) return;
      $("#conf-text").innerHTML = t ? esc(t).replace(/^\[(.+)\]$/gm, "[<b>$1</b>]") : '<span class="c"># ' + ring + ' has no databases for ' + arch + ' yet — check the overview</span>';
    }).catch(function () {});
  }

  function draw() {
    pick("#pick-ring", RINGS, ring, function (v) { ring = v; draw(); }, { url: "ring" });
    pick("#pick-arch", ARCHES, arch, function (v) { arch = v; draw(); }, { url: "arch" });
    $("#ring-desc").textContent = DESC[ring];
    $("#key-cmd").innerHTML = 'curl -O ' + POOL + '/omarchy-staging.pub.asc\nsudo pacman-key --add omarchy-staging.pub.asc &amp;&amp; sudo pacman-key --lsign-key staging@firemanxbr.org';
    $("#setup-cmd").innerHTML = 'curl -fsSL ' + location.origin + '/setup | sudo bash -s -- --ring ' + ring;
    var cov = data ? data.coverage || [] : [];
    var optionalSources = cov.filter(function (c) { return c.optional && c.arch === arch; });
    $("#optional").innerHTML = optionalSources.map(function (c) {
      return '<button type="button" class="' + (optional[c.source] ? "on" : "") + '" data-v="' + esc(c.source) + '" title="' + esc(c.title || "") + '">' + (optional[c.source] ? "✓ " : "+ ") + esc(c.source) + '</button>';
    }).join("") + (optionalSources.length ? '<span class="muted" style="font-size:12.5px;align-self:center">optional repositories — off unless you switch them on</span>' : '');
    $("#optional").querySelectorAll("button").forEach(function (b) { b.onclick = function () { var v = b.getAttribute("data-v"); optional[v] = !optional[v]; draw(); }; });
    drawConf();
    $("#cli-cmd").innerHTML = 'curl -sL https://github.com/firemanxbr/omarchy-pool/releases/latest/download/omarchy-pool-' + (data && data.version && data.version.version !== "dev" ? data.version.version : "vX.Y.Z") + '-' + arch + '-linux.tar.gz | tar xz\n' +
      'sudo install -m 755 omarchy-pool-*/omarchy-cli /usr/local/bin/\n' +
      'omarchy-cli --ring ' + ring + ' status';
  }
  copyChips({ setup: "#setup-cmd", key: "#key-cmd", conf: "#conf-text", up: "#up-cmd", cli: "#cli-cmd" });
  draw();
  drawQuiz();
  liveStats(function (d) { data = d; draw(); }, 120000);
`;

export function getStartedHtml(poolUrl: string, version: RunningVersion, sample: string | null): string {
  return page({
    path: "/docs/get-started",
    title: "Get started · omarchy-pool",
    description: "Point pacman at the omarchy-pool: the database key, the repository sections for a ring, and the optional omarchy-cli.",
    active: "docs",
    doc: "get-started",
    body: body(sample),
    script: SCRIPT,
    poolUrl,
    version,
  });
}

/**
 * What /docs/get-started is made of. Nothing here changes with the role
 * and nothing writes: the page reads the stats, every 120 s, for the
 * optional sources and the running version, and the include from
 * /api/v1/pacman.conf when the pick changes; the rest is drawn from the
 * query string and the helpers the shell inlines.
 */
export const GET_STARTED_COMPONENTS = (F: Fixture): Component[] => {
  const page = "/docs/get-started";
  const stats = "/api/v1/stats";
  return [
    {
      // The docs shell every chapter carries, with this one open and its summary link lit.
      id: "docs-get-started.docs-shell",
      page,
      anchor: ['class="docs-home"', 'id="docs-q"', 'id="docs-hits"', 'id="docs-nav"', '<details open><summary><a href="/docs/get-started" class="on">Get started</a>', 'class="docs-hint"'],
      script: ['$("#docs-q")', '$("#docs-hits")', '$("#docs-nav")', '"/docs/glossary#"'],
      visible: EVERYONE,
    },
    {
      // The chapter's old address still lands here.
      id: "docs-get-started.hero",
      page,
      anchor: ["<h1>Get started</h1>", '<p class="lede">One command — or three steps by hand'],
      reads: [{ path: "/get-started", status: 301, json: false }],
      visible: EVERYONE,
    },
    {
      // Each question's yes/no is the shell's pick(), drawn into the row's own span.
      id: "docs-get-started.quiz",
      page,
      anchor: ['id="which-ring"', 'id="quiz"', 'id="quiz-answer"'],
      script: ["var QUIZ = ", '$("#quiz")', '$("#quiz-answer")', 'pick("#q-" + r[0], ["yes", "no"]', 'data-rec="', 'quiz.build ? "lab"', "RINGS_TEXT[r].desc"],
      visible: EVERYONE,
    },
    {
      // Two rows of the shell's pick(); the choice goes to the address as ?ring= and ?arch=, which the page reads back on load.
      id: "docs-get-started.ring-picker",
      page,
      anchor: ['id="ring"', 'id="pick-ring"', 'id="pick-arch"', 'id="ring-desc"'],
      script: ['RINGS = ["stable", "rc", "edge", "lab"]', 'ARCHES = ["x86_64", "aarch64"]', 'pick("#pick-ring"', 'pick("#pick-arch"', '{ url: "ring" }', '{ url: "arch" }', '$("#ring-desc")', 'q.get("ring")', 'q.get("arch")'],
      visible: EVERYONE,
    },
    {
      // The command pipes /setup into sudo, and the paragraph links the script to read first: the script is the read.
      id: "docs-get-started.one-command",
      page,
      anchor: ['id="command"', 'data-copy="setup"', 'id="setup-cmd"', '<a href="/setup">The script, in full →</a>'],
      script: ['$("#setup-cmd")', "/setup | sudo bash -s -- --ring "],
      reads: [{ path: "/setup", json: false }],
      visible: EVERYONE,
    },
    {
      // The key file is on the pool's host, not a route of the Worker: the command's text is what the test can hold.
      id: "docs-get-started.key",
      page,
      anchor: ['id="key"', 'data-copy="key"', 'id="key-cmd"'],
      script: ['$("#key-cmd")', "/omarchy-staging.pub.asc", "pacman-key --lsign-key staging@firemanxbr.org"],
      visible: EVERYONE,
    },
    {
      // One toggle per optional source of the architecture, from the coverage; empty until the stats arrive.
      id: "docs-get-started.optional-toggles",
      page,
      anchor: ['id="optional"'],
      script: ['$("#optional")', "data.coverage", "c.optional && c.arch === arch", "c.title", "optional[v] = !optional[v]"],
      reads: [{ path: stats, fields: ["coverage", "coverage.0.source", "coverage.0.arch", "coverage.0.optional", "coverage.0.title"] }],
      visible: EVERYONE,
    },
    {
      // The sections are the API's include: served with the page for the address's pick (stable, x86_64 here — the
      // fixture's stable release has a database) and fetched again by the script when the pick or the optional
      // sources change; the paragraph names the same route as the curl -o alternative.
      id: "docs-get-started.conf-by-hand",
      page,
      anchor: ['id="conf"', 'data-copy="conf"', `id="conf-text"># omarchy-pool — ring stable, ${F.arch}.`, "[<b>omarchy-core-stable</b>]\nSigLevel = Required DatabaseRequired", 'data-copy="up"', 'id="up-cmd"', "/api/v1/pacman.conf?ring=…&amp;arch=…"],
      script: ['$("#conf-text")', 'fetch("/api/v1/pacman.conf?ring=" + ring + "&arch=" + arch + "&with=" + withOptional.join(","))', "has no databases for", "liveStats(function (d) { data = d; draw(); }, 120000)"],
      reads: [{ path: `/api/v1/pacman.conf?ring=stable&arch=${F.arch}`, json: false }],
      visible: EVERYONE,
    },
    {
      id: "docs-get-started.cli",
      page,
      anchor: ['id="cli"', 'data-copy="cli"', 'id="cli-cmd"', 'href="https://github.com/firemanxbr/omarchy-pool/releases"'],
      script: ['$("#cli-cmd")', "releases/latest/download/omarchy-pool-", 'data.version.version !== "dev"', '"vX.Y.Z"', "omarchy-cli --ring "],
      reads: [{ path: stats, fields: ["version", "version.version"] }],
      visible: EVERYONE,
    },
    {
      id: "docs-get-started.switching",
      page,
      anchor: ['id="switching"', "<h3>Switching rings, going back</h3>"],
      visible: EVERYONE,
    },
    {
      // The five chips are the shell's copyChips(), bound once at load; the page's part is the map from a chip to the text it copies.
      id: "docs-get-started.copy-chips",
      page,
      anchor: ['data-copy="setup"', 'data-copy="key"', 'data-copy="conf"', 'data-copy="up"', 'data-copy="cli"'],
      script: ['copyChips({ setup: "#setup-cmd", key: "#key-cmd", conf: "#conf-text", up: "#up-cmd", cli: "#cli-cmd" })'],
      visible: EVERYONE,
    },
  ];
};
