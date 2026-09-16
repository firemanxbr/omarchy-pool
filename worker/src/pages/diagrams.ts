/**
 * The dashboard's diagrams, drawn on the server as inline SVG: the rings, the
 * factory's assembly line, the living system (packages and advisories moving
 * through the pipeline), and the architecture maintainers operate. Boxes are
 * sized from their text so nothing overflows; arrows are orthogonal and
 * labels sit beside a segment, never across one. A text with `live` carries
 * data-live="key": the page script fills it from the API.
 */

const CW = 6.6; // px per character at 11 px mono

interface Line { text: string; cls?: "live" | "amber"; live?: string }
interface Box { x: number; y: number; w: number; h: number; title: string; lines?: (string | Line)[]; cls?: string; tcls?: string; big?: boolean }

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
function lineOf(l: string | Line): Line {
  return typeof l === "string" ? { text: l } : l;
}
function fits(w: number, texts: string[]): number {
  return Math.max(w, ...texts.map((t) => Math.ceil(t.length * CW + 24)));
}
function dbox(o: Box): string {
  const lines = (o.lines ?? []).map(lineOf);
  const w = fits(o.w, lines.map((l) => l.text).concat([o.title]));
  const block = 13 + (lines.length ? 18 + 14 * (lines.length - 1) : 0);
  let top = o.y + (o.h - block) / 2 + 11;
  const cx = o.x + w / 2;
  let s = `<rect class="d-box ${o.cls ?? ""}" x="${o.x}" y="${o.y}" width="${w}" height="${o.h}"/>`;
  s += `<text class="d-t ${o.tcls ?? ""}" x="${cx}" y="${top}" text-anchor="middle"${o.big ? ' font-size="15"' : ""}>${esc(o.title)}</text>`;
  lines.forEach((l, i) => {
    top += i === 0 ? 18 : 14;
    s += `<text class="d-s${l.cls ? " " + l.cls : ""}" x="${cx}" y="${top}" text-anchor="middle"${l.live ? ` data-live="${l.live}"` : ""}>${esc(l.text)}</text>`;
  });
  return s;
}
function marker(cls?: string): string {
  return cls && cls.includes("hi") ? "arw-g" : cls && cls.includes("warn") ? "arw-a" : "arw";
}
function darrow(x1: number, y1: number, x2: number, y2: number, cls = "", both = false): string {
  return `<line class="d-l ${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${marker(cls)})"${both ? ` marker-start="url(#${marker(cls)})"` : ""}/>`;
}
function dline(pts: number[], cls = ""): string {
  return `<polyline class="d-l ${cls}" points="${pts.join(" ")}"/>`;
}
function dpath(d: string, cls = "", arrow = false): string {
  return `<path class="d-l ${cls}" d="${d}"${arrow ? ` marker-end="url(#${marker(cls)})"` : ""}/>`;
}
function dlab(x: number, y: number, lines: string[], anchor = "middle", cls = ""): string {
  return lines.map((l, i) => `<text class="d-lab ${cls}" x="${x}" y="${y + i * 13}" text-anchor="${anchor}">${esc(l)}</text>`).join("");
}
/** A mark that rides a path (SMIL; the page pauses it under prefers-reduced-motion). */
function dot(path: string, color: string, dur: number, begin: number): string {
  return `<circle r="4" fill="${color}" stroke="#1a1b26" stroke-width="1.5"><animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${path}"/></circle>`;
}
const DEFS =
  '<defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8b93b8"/></marker>' +
  '<marker id="arw-g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#9ece6a"/></marker>' +
  '<marker id="arw-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#e0af68"/></marker></defs>';
function svgo(w: number, h: number, label: string, cls = ""): string {
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"${cls ? ` class="${cls}"` : ""}>${DEFS}`;
}

export type Stage = "sync" | "pin" | "promote" | "render" | "serve";

/**
 * Sources → pool → rings, with the rollback loop. `hi` lights one stage (the
 * docs' stepper shows the five variants); without it the packages move.
 */
export function ringsDiagram(hi?: Stage): string {
  const H = (k: Stage) => (hi ? (hi === k ? " hi" : " dimmed") : "");
  let s = "";
  const src: [string, string][] = [["Arch Linux", "core · extra · multilib"], ["Arch Linux ARM", "core · extra · alarm"], ["Omarchy", "the OPR's edge channel"], ["Asahi", "the fork · asahi-alarm"], ["Factory", "built here, by the pool"]];
  src.forEach((r, i) => {
    const y = 22 + i * 46;
    s += dbox({ x: 20, y, w: 180, h: 38, title: r[0], lines: [r[1]], cls: (i === 4 ? "hi" : "") + H("sync") });
    s += dline([200, y + 19, 240, y + 19], H("sync"));
  });
  s += dline([240, 41, 240, 225], H("sync")) + darrow(240, 132, 290, 132, H("sync"));
  // Box widths are at least what their longest line needs (dbox widens a box
  // to its text), so the gaps below are real; the gate labels sit above the
  // row of boxes, where a wider font cannot push them into a box.
  s += dbox({ x: 290, y: 92, w: 160, h: 80, title: "Pool", big: true, lines: ["signature-verified", "stored once on R2"], cls: "hi" + (hi && hi !== "sync" && hi !== "pin" ? " dimmed" : "") });
  s += darrow(450, 132, 500, 132, H("pin")) + dlab(475, 120, ["≤ 3 h"], "middle", hi === "pin" ? "hi" : "");
  s += dbox({ x: 500, y: 102, w: 165, h: 60, title: "edge", big: true, tcls: "edge", lines: ["follows upstream", "for CI and developers"], cls: "edge" + (hi && hi !== "pin" && hi !== "promote" && hi !== "render" ? " dimmed" : "") });
  s += darrow(665, 132, 815, 132, H("promote")) + dlab(740, 62, ["real pacman", "+ ABI + security", "on both arches"], "middle", hi === "promote" ? "hi" : "");
  s += dbox({ x: 815, y: 102, w: 150, h: 60, title: "rc", big: true, tcls: "rc", lines: ["both architectures", "for testers"], cls: "rc" + (hi && hi !== "promote" && hi !== "render" ? " dimmed" : "") });
  s += darrow(965, 132, 1115, 132, H("promote")) + dlab(1040, 75, ["two green checks", "in a row · ≈ 6 h"], "middle", hi === "promote" ? "hi" : "");
  s += dbox({ x: 1115, y: 102, w: 150, h: 60, title: "stable", big: true, tcls: "stable", lines: ["what you run", "recommended"], cls: "stable" + (hi && hi !== "promote" && hi !== "render" && hi !== "serve" ? " dimmed" : "") });
  s += dpath("M1155 102 C1155 48, 1225 48, 1225 102", "warn" + (hi && hi !== "promote" ? " dimmed" : ""), true) + dlab(1190, 24, ["rolls back by itself", "if a health check fails"]);
  // The lab, beside the rings: the factory's builds are pinned there first and
  // installed by a real pacman (the trial); a maintainer's approval sends them to edge.
  const L = hi && hi !== "pin" ? " dimmed" : "";
  s += dpath("M450 152 L475 152 L475 215 L500 215", "dash" + L, true);
  s += dbox({ x: 500, y: 192, w: 165, h: 46, title: "lab", tcls: "amber", cls: "amber" + L, lines: ["tried, never promised"] });
  s += dpath("M620 192 L620 162", "dash" + L, true) + dlab(628, 182, ["approved"], "start");
  s += dlab(690, 220, ["the factory's builds, installed by a real pacman before anyone decides"], "start");
  if (hi === "render") s += dlab(640, 254, ["render: one signed database per ring and architecture, checked by a real pacman before it is served"], "middle", "hi");
  // The marks ride under the boxes: visible on the arrows, covered inside a box, never across its text.
  let dots = "";
  if (!hi) {
    const tail = " L240 132 L290 132 L450 132 L500 132 L665 132 L815 132 L965 132 L1115 132 L1190 132";
    dots += dot("M200 41 L240 41" + tail, "#9ece6a", 10, 0) + dot("M200 133 L240 133" + tail, "#9ece6a", 10, 3.3) + dot("M200 225 L240 225" + tail, "#9ece6a", 10, 6.6);
    dots += dot("M450 152 L475 152 L475 215 L500 215 L620 215 L620 162", "#e0af68", 6, 1.5);
  }
  return svgo(1280, 262, "Five sources feed the pool — Arch Linux, Arch Linux ARM, the OPR's edge channel, the Asahi projects and the pool's own factory — verified and stored once, then promoted through the edge, rc and stable rings on evidence; a ring rolls back by itself when a health check fails. Beside them the lab, where the factory's builds are installed by a real pacman before a maintainer approves them into edge.") + dots + s + "</svg>";
}

/**
 * The factory as an assembly line: stations above, the belt below. Packages
 * ride the belt and change colour at each station — grey requested, blue
 * built, amber staged for review, green approved — and the stations wear the
 * same colours, so the line reads as progress. One package in five is
 * stopped at the maintainer: not everything passes. The people on the
 * floor, and the agents beside them.
 */
export function factoryDiagram(): string {
  let s = svgo(1340, 330, "An assembly line: a contributor requests a package on the record, it is built on the workers the project shares or on their own, the evidence is staged and audited, the pool's agent makes the package again on a trusted worker, a real pacman installs it in the lab and a maintainer approves it into the rings — or stops it. Packages ride a conveyor belt below the stations.");
  // Every box is at least as wide as its longest line (dbox widens to the
  // text), so the widths here are the real ones; the arrows are long enough
  // for their label to stand clear of both boxes.
  s += dbox({ x: 20, y: 40, w: 160, h: 70, title: "Contributor", big: true, lines: ["a GitHub account", "nothing else asked"] });
  s += darrow(180, 75, 245, 75) + dlab(212, 63, ["request"]);
  s += dbox({ x: 245, y: 40, w: 185, h: 70, title: "The request", cls: "dim", lines: ["URL · name · licence", "on the record, signed"] });
  s += darrow(430, 75, 495, 75) + dlab(462, 63, ["build"]);
  s += '<rect class="d-box rc" x="495" y="20" width="322" height="110"/><text class="d-t" x="656" y="40" text-anchor="middle">Build — your choice</text>';
  s += dbox({ x: 503, y: 50, w: 150, h: 70, title: "Shared workers", cls: "rc", lines: ["the project's agent", { text: "online now", cls: "live", live: "shared-online" }], tcls: "small" });
  s += dbox({ x: 659, y: 50, w: 150, h: 70, title: "Your worker", cls: "rc", lines: ["at home, your agent", "your packages only"], tcls: "small" });
  s += darrow(817, 75, 882, 75) + dlab(849, 63, ["staged"]);
  s += dbox({ x: 882, y: 40, w: 180, h: 70, title: "Evidence", cls: "amber", lines: ["PKGBUILD · log · audit", "never what users get"] });
  s += darrow(1062, 75, 1127, 75) + dlab(1094, 63, ["review"]);
  s += dbox({ x: 1127, y: 40, w: 190, h: 70, title: "Pool", big: true, cls: "hi", lines: ["its agent makes it again", "a real pacman installs it"] });
  // The drops: where a package on the belt changes colour. Labels and figures stand clear of the lines.
  const drops: [number, string, string][] = [[337, "requested", "#8b93b8"], [656, "built", "#7aa2f7"], [895, "staged", "#e0af68"], [1222, "approved", "#9ece6a"]];
  for (const d of drops) s += dline([d[0], d[1] === "built" ? 130 : 110, d[0], 214], "dash") + `<text class="d-lab" x="${d[0] + 8}" y="176" style="fill:${d[2]}">${d[1]}</text>`;
  const person = (x: number, color: number | string, values: string, dur: number, extra = "") =>
    `<g transform="translate(${x} 142)"><circle cx="0" cy="0" r="8" fill="none" stroke="${color}" stroke-width="1.5"/><path d="M-14 30 Q0 12 14 30" fill="none" stroke="${color}" stroke-width="1.5"/>${extra}<animateTransform attributeName="transform" type="translate" values="${values}" dur="${dur}s" repeatCount="indefinite"/></g>`;
  const agent = (x: number, begin: number) =>
    `<g transform="translate(${x} 142)"><rect x="-9" y="-7" width="18" height="15" rx="3" fill="none" stroke="#bb9af7" stroke-width="1.5"/><circle cx="-4" cy="0" r="1.7" fill="#bb9af7"/><circle cx="4" cy="0" r="1.7" fill="#bb9af7"/><line x1="0" y1="-7" x2="0" y2="-12" stroke="#bb9af7" stroke-width="1.5"/><circle cx="0" cy="-14" r="2" fill="#bb9af7"><animate attributeName="opacity" values="1;0.2;1" dur="1.2s" begin="${begin}s" repeatCount="indefinite"/></circle><path d="M-13 30 L-13 16 Q-13 12 -9 12 L9 12 Q13 12 13 16 L13 30" fill="none" stroke="#bb9af7" stroke-width="1.5"/></g>`;
  s += person(540, "#7aa2f7", "540 142;540 139;540 142", 1.4) + dlab(540, 190, ["contributor", "asks, on the record"]);
  s += agent(780, 0) + dlab(780, 190, ["agent", "writes and builds"]);
  s += agent(1008, 0.6) + dlab(1008, 190, ["second agent", "audits the evidence"]);
  s += person(1148, "#9ece6a", "1148 142;1145 142;1148 142;1151 142;1148 142", 2.4, '<circle cx="18" cy="6" r="5" fill="none" stroke="#9ece6a" stroke-width="1.5"/><line x1="22" y1="10" x2="28" y2="16" stroke="#9ece6a" stroke-width="1.5"/>') + dlab(1148, 190, ["maintainer", "reads, then decides"]);
  s += '<rect x="20" y="222" width="1300" height="32" fill="#13141c" stroke="#2a2e3f"/><line x1="20" y1="222" x2="1320" y2="222" stroke="#8b93b8" stroke-width="1.5" stroke-dasharray="10 8"><animate attributeName="stroke-dashoffset" from="36" to="0" dur="1s" repeatCount="indefinite"/></line>';
  for (let x = 55; x < 1320; x += 70) s += `<g transform="translate(${x} 238)"><circle r="8" fill="#1f2230" stroke="#2a2e3f"/><line x1="-8" y1="0" x2="8" y2="0" stroke="#8b93b8"/><line x1="0" y1="-8" x2="0" y2="8" stroke="#8b93b8"/><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="4s" repeatCount="indefinite" additive="sum"/></g>`;
  // Five packages, one every 3.2 s, at the belt's speed: the colour changes
  // under the drops. The third is stopped at the maintainer — it turns red,
  // gets its mark and leaves the belt; the others ride off the end, approved.
  const T = 16;
  for (let i = 0; i < 5; i++) {
    const begin = `begin="${(i * 3.2).toFixed(1)}s" repeatCount="indefinite"`, stopped = i === 2;
    const fill = stopped ? "#8b93b8;#8b93b8;#7aa2f7;#7aa2f7;#e0af68;#e0af68;#f7768e;#f7768e" : "#8b93b8;#8b93b8;#7aa2f7;#7aa2f7;#e0af68;#e0af68;#9ece6a;#9ece6a";
    s += `<g><rect x="-7" y="-14" width="14" height="14" fill="#8b93b8" stroke="#1a1b26" stroke-width="1.2"><animate attributeName="fill" values="${fill}" keyTimes="0;0.42;0.43;0.58;0.59;0.80;0.81;1" dur="${T}s" ${begin}/></rect><rect x="-3" y="-10" width="6" height="6" fill="#1a1b26"/>` +
      (stopped
        ? `<text x="0" y="-19" text-anchor="middle" font-size="13" font-weight="700" fill="#f7768e" opacity="0">✕<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.81;0.83;0.95;1" dur="${T}s" ${begin}/></text><animate attributeName="opacity" values="1;1;1;0" keyTimes="0;0.81;0.95;1" dur="${T}s" ${begin}/><animateMotion dur="${T}s" ${begin} calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.81;1" path="M30 222 L1222 222"/>`
        : `<animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.87;0.875;1" dur="${T}s" ${begin}/><animateMotion dur="${T}s" ${begin} calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.87;1" path="M30 222 L1310 222"/>`) + "</g>";
  }
  s += dlab(20, 296, ["the factory floor"], "start") + '<text x="1320" y="296" text-anchor="end" font-size="13" font-weight="600" font-family="Geist, sans-serif"><tspan fill="#8b93b8">off the belt → </tspan><tspan fill="#bb9af7">edge</tspan><tspan fill="#8b93b8"> → </tspan><tspan fill="#7aa2f7">rc</tspan><tspan fill="#8b93b8"> → </tspan><tspan fill="#9ece6a">stable</tspan><tspan fill="#8b93b8">, signed by the pool</tspan></text>';
  return s + "</svg>";
}

/**
 * The living system: packages flow from the sources through the rings, five
 * security feeds are matched against every ring, a confident fix skips the soak.
 */
export function liveDiagram(): string {
  let s = "";
  const HEAD = svgo(1300, 420, "Packages move from five sources — Arch Linux, Arch Linux ARM, the OPR's edge channel, the Asahi projects and the factory — through the pool into the edge, rc and stable rings, while five security feeds are matched against every ring every three hours and confident fixes are fast-tracked from edge to stable.", "live");
  ["Arch Linux", "Arch Linux ARM", "Omarchy OPR · edge", "Asahi", "Factory"].forEach((t, i) => {
    const y = 40 + i * 37;
    s += dbox({ x: 20, y, w: 190, h: 30, title: t }) + dline([210, y + 15, 250, y + 15]);
  });
  s += dline([250, 55, 250, 203]) + darrow(250, 127, 300, 127);
  s += dbox({ x: 300, y: 70, w: 200, h: 115, title: "Pool", big: true, lines: [{ text: "verified today: …", cls: "live", live: "verified-today" }, { text: "stored once: …", cls: "live", live: "stored-once" }, "every 3 h"] });
  s += darrow(500, 127, 600, 127) + dlab(550, 115, ["≤ 3 h"]);
  s += dbox({ x: 600, y: 97, w: 140, h: 60, title: "edge", big: true, tcls: "edge", cls: "edge", lines: [{ text: "follows upstream", live: "edge-head" }] });
  s += darrow(740, 127, 860, 127) + dlab(800, 103, ["pacman + ABI", "+ security"]);
  s += dbox({ x: 860, y: 97, w: 150, h: 60, title: "rc", big: true, tcls: "rc", cls: "rc", lines: [{ text: "tested, both arches", live: "rc-head" }] });
  s += darrow(1010, 127, 1120, 127) + dlab(1065, 103, ["two green checks", "≈ 6 h"]);
  s += dbox({ x: 1120, y: 97, w: 160, h: 60, title: "stable", big: true, tcls: "stable", cls: "stable", lines: [{ text: "what you run", live: "stable-head" }] });
  s += dpath("M670 97 C670 40, 1200 40, 1200 97", "hi dash", true) + dlab(935, 34, ["fast-track: a confident fix in edge skips the soak"], "middle", "hi");
  ["Arch Security Tracker", "Debian Security Tracker", "OSV · Go modules, crates", "CISA KEV · exploited", "EPSS · likelihood"].forEach((t, i) => {
    const y = 262 + i * 32;
    s += `<rect class="d-chip" x="20" y="${y}" width="190" height="26"/><text class="d-s" x="115" y="${y + 17}" text-anchor="middle" style="fill:#a9b1d6">${esc(t)}</text>` + dline([210, y + 13, 250, y + 13]);
  });
  s += dline([250, 275, 250, 403]) + darrow(250, 339, 300, 339);
  s += dbox({ x: 300, y: 289, w: 200, h: 100, title: "Security scan", big: true, lines: [{ text: "advisories known: …", cls: "live", live: "advisories" }, { text: "open in stable: …", cls: "amber", live: "open-stable" }, "every 3 h, every ring"] });
  s += dline([500, 339, 560, 339, 560, 230, 1200, 230]) + darrow(670, 230, 670, 157) + darrow(935, 230, 935, 157) + darrow(1200, 230, 1200, 157);
  s += dlab(580, 248, ["matches open advisories against what each ring serves"], "start");
  // The marks ride under the boxes: visible on the arrows, covered inside a box, never across its text.
  const pkg = "M230 55 L250 55 L250 127 L300 127 L500 127 L600 127 L740 127 L860 127 L1010 127 L1120 127 L1200 127";
  let dots = dot(pkg, "#9ece6a", 9, 0) + dot(pkg, "#9ece6a", 9, 3) + dot(pkg, "#9ece6a", 9, 6);
  dots += dot("M230 275 L250 275 L250 339 L300 339", "#e0af68", 3, 0.5) + dot("M230 371 L250 371 L250 339 L300 339", "#e0af68", 3, 2);
  dots += dot("M500 339 L560 339 L560 230 L670 230 L670 157", "#e0af68", 4, 1) + dot("M500 339 L560 339 L560 230 L935 230 L935 157", "#e0af68", 5, 2.3) + dot("M500 339 L560 339 L560 230 L1200 230 L1200 157", "#e0af68", 6, 0.2);
  dots += dot("M670 97 C670 40, 1200 40, 1200 97", "#9ece6a", 5, 4);
  return HEAD + dots + s + "</svg>";
}

/** What maintainers operate: the brain, the queue, the three worker roles, R2, the rings, GitHub. */
export function archDiagram(): string {
  let s = svgo(1280, 390, "Upstream mirrors and GitHub feed the brain, a Cloudflare Worker with the index in D1; it queues jobs that pool, review and community workers claim with a lease and report back; objects are stored on R2 and rendered into signed ring databases served to pacman.");
  s += dbox({ x: 20, y: 50, w: 200, h: 86, title: "Upstream", big: true, lines: ["Arch · ARM · OPR · Asahi", { text: "synced …", cls: "live", live: "last-sync" }] });
  s += darrow(220, 93, 300, 93) + dlab(260, 81, ["sync jobs"]);
  s += dbox({ x: 300, y: 30, w: 330, h: 150, title: "Brain", big: true, cls: "hi", lines: ["Cloudflare Worker · index in D1", "schedules sync · promote · health", "security · trial · gc · builds", "signs databases and factory packages", { text: "API …", cls: "live", live: "api" }] });
  s += darrow(630, 93, 730, 93) + dlab(680, 81, ["index ↔ objects"]);
  s += dbox({ x: 730, y: 50, w: 185, h: 86, title: "Pool · R2", big: true, lines: ["each package stored once", { text: "…", cls: "live", live: "pool-size" }] });
  s += darrow(915, 93, 1025, 93) + dlab(970, 81, ["rendered, signed"]);
  s += dbox({ x: 1025, y: 50, w: 240, h: 86, title: "Rings", big: true, lines: ["pacman DBs, both arches", { text: "edge · rc · stable", cls: "live", live: "heads" }] });
  s += darrow(1145, 136, 1145, 170) + dlab(1145, 186, ["served to every pacman -Syu"]);
  s += darrow(465, 180, 465, 215);
  s += '<rect class="d-queue" x="300" y="215" width="700" height="30"/><text class="d-t small" x="314" y="234">job queue</text><text class="d-s live" x="400" y="234" data-live="queue">…</text>';
  // Each box is as wide as its longest line (dbox widens to the text), so the three stand apart.
  for (const x of [410, 680, 960]) s += darrow(x, 300, x, 245, "", true) + dlab(x + 10, 276, ["claim · report"], "start");
  s += dbox({ x: 300, y: 300, w: 220, h: 70, title: "Pool workers", lines: ["the project's host · trusted", { text: "…", cls: "live", live: "w-pool" }] });
  s += dbox({ x: 545, y: 300, w: 270, h: 70, title: "Review workers", lines: ["rebuilds + audits · agent via a proxy", { text: "…", cls: "live", live: "w-review" }] });
  s += dbox({ x: 840, y: 300, w: 240, h: 70, title: "Community workers", lines: ["a broker + a builder, anyone's", { text: "…", cls: "live", live: "w-community" }] });
  s += dbox({ x: 20, y: 300, w: 200, h: 70, title: "GitHub", lines: ["OAuth · MAINTAINERS.toml", "releases · worker image"] });
  s += dline([220, 320, 260, 320, 260, 150], "dash") + darrow(260, 150, 300, 150, "dash") + dlab(266, 270, ["who may approve"], "start");
  return s + "</svg>";
}

/**
 * Where every package comes from, and what happens to it before it reaches a
 * machine: the sources on the left (each with its keyring), verified and
 * stored once, the three rings and the evidence between them, the rollback
 * loop, and below, the factory's own road — the lab, the trial, a
 * maintainer's approval, and the fast lane a trial earns. The live lines are
 * filled by the page from /api/v1/stats.
 */
export function sourcesDiagram(): string {
  let s = "";
  const HEAD = svgo(1330, 560, "Arch Linux, Arch Linux ARM, the OPR's edge channel, Omarchy for Apple Silicon, Asahi Linux and, optionally, the prebuilt AUR selections feed the pool; every package is verified against its project's keyring and stored once, then moves from edge to rc on a real pacman, an ABI check and the security layer, and from rc to stable after two green health checks in a row; a failed check rolls a ring back. The factory's builds go to the lab, where a real pacman installs them before a maintainer approves them into edge — and, when the trial installed them, into stable with it.");
  const src: [string, string, string, string][] = [
    ["Arch Linux · x86_64", "core · extra · multilib", "archlinux-keyring", "src-arch"],
    ["Arch Linux ARM · aarch64", "core · extra · alarm", "archlinuxarm-keyring", "src-alarm"],
    ["Omarchy (OPR) · both", "packages · the edge channel", "Omarchy's key", "src-opr"],
    ["Omarchy for Apple Silicon", "asahi · aarch64 · the fork", "the fork's key", "src-asahi"],
    ["Asahi Linux · aarch64", "asahi-alarm", "asahi-alarm-keyring", "src-asahi-alarm"],
    ["Prebuilt AUR · optional", "chaotic x86_64 · aur aarch64", "unclaimed names only", "src-optional"],
  ];
  src.forEach((r, i) => {
    const y = 14 + i * 68;
    s += dbox({ x: 20, y, w: 220, h: 64, title: r[0], tcls: "small", lines: [r[1], r[2], { text: "…", cls: "live", live: r[3] }] }) + dline([240, y + 32, 270, y + 32]);
  });
  s += dline([270, 46, 270, 386]) + darrow(270, 198, 300, 198);
  s += dbox({ x: 300, y: 168, w: 160, h: 60, title: "Verify", cls: "amber", tcls: "amber", lines: ["the project's signature", "against its keyring"] });
  s += darrow(460, 198, 500, 198);
  s += dbox({ x: 500, y: 158, w: 210, h: 80, title: "Pool", big: true, cls: "hi", lines: ["stored once, immutable", "<source>/<arch>/<file>", { text: "…", cls: "live", live: "stored-once" }] });
  s += darrow(710, 198, 760, 198) + dlab(735, 186, ["≤ 3 h"]);
  s += dbox({ x: 760, y: 160, w: 150, h: 76, title: "edge", big: true, tcls: "edge", cls: "edge", lines: ["for CI, developers", { text: "…", cls: "live", live: "edge-head" }] });
  s += darrow(910, 198, 960, 198);
  s += dbox({ x: 960, y: 160, w: 150, h: 76, title: "rc", big: true, tcls: "rc", cls: "rc", lines: ["for testers", { text: "…", cls: "live", live: "rc-head" }] });
  s += darrow(1110, 198, 1160, 198);
  s += dbox({ x: 1160, y: 160, w: 150, h: 76, title: "stable", big: true, tcls: "stable", cls: "stable", lines: ["what you run", { text: "…", cls: "live", live: "stable-head" }] });
  // The rollback loop: a failed check after a promotion points the ring back.
  s += dpath("M1235 160 C1235 100, 1085 100, 1085 160", "warn dash", true) + dlab(1160, 92, ["a failed health check after a promotion", "points the ring back — automatic"]);
  // The evidence, and the two gates it feeds.
  s += dbox({ x: 800, y: 290, w: 350, h: 100, title: "The evidence", big: true, lines: ["after the sync that changed edge · every 3 h", "a real pacman -Sy + signed downloads, both arches", "the ELF-level ABI check · no security regression", "green on both architectures, or nothing moves"] });
  s += darrow(935, 290, 935, 240) + dlab(945, 262, ["minutes after", "the checks pass"], "start");
  s += dpath("M1060 290 L1060 262 L1135 262 L1135 240", "", true) + dlab(1145, 262, ["two green checks", "in a row · ≈ 6 h"], "start");
  // The factory's road: the lab, the trial, a maintainer, edge — and the fast lane.
  s += dbox({ x: 20, y: 470, w: 260, h: 60, title: "Factory", big: true, tcls: "amber", cls: "amber", lines: ["a contributor asks and builds", "audit · the project builds it again"] });
  s += darrow(280, 500, 320, 500);
  s += dbox({ x: 320, y: 470, w: 270, h: 60, title: "The lab", tcls: "amber", cls: "amber", lines: ["a real pacman installs it — the trial", "nothing promised, nothing promoted"] });
  s += darrow(590, 500, 630, 500);
  s += dbox({ x: 630, y: 470, w: 250, h: 60, title: "A maintainer approves", tcls: "amber", cls: "amber", lines: ["never their own package", "what installed, not what compiled"] });
  s += darrow(785, 470, 785, 240) + dlab(775, 366, ["approved", "→ edge"], "end");
  s += dpath("M880 510 L1290 510 L1290 240", "hi dash", true) + dlab(1085, 502, ["the fast lane: the trial installed it → stable with edge"], "middle", "hi");
  // The marks ride under the boxes: visible on the arrows, covered inside a box, never across its text.
  const tail = " L270 198 L300 198 L460 198 L500 198 L710 198 L760 198 L910 198 L960 198 L1110 198 L1160 198 L1235 198";
  const dots = dot("M240 46 L270 46" + tail, "#9ece6a", 10, 0) + dot("M240 250 L270 250" + tail, "#9ece6a", 10, 4) + dot("M280 500 L320 500 L590 500 L630 500 L785 500 L785 240", "#e0af68", 8, 2);
  return HEAD + dots + s + "</svg>";
}
