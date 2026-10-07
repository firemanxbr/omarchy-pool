/**
 * The dashboard's diagrams, drawn on the server as inline SVG: the rings and
 * where every package comes from (the living system and the architecture
 * went with the Pipeline, #248; the Factory's assembly line went with its old
 * page — the v1 Factory draws the line as a board, #246). Boxes are
 * sized from their text so nothing overflows; arrows are orthogonal and
 * labels sit beside a segment, never across one. A text with `live` carries
 * data-live="key": the page script fills it from the API. The helpers are
 * shared with the documentation's figures (doc-diagrams.ts), so every
 * picture on the dashboard is drawn the same way.
 */
import { escapeHtml } from "../html";
import { EXPECTED_SOURCES, UPSTREAMS, type ExpectedSource, type Upstream } from "../meta";

export const CW = 6.6; // px per character at 11 px mono

export interface Line { text: string; cls?: "live" | "amber"; live?: string }
export interface Box { x: number; y: number; w: number; h: number; title: string; lines?: (string | Line)[]; cls?: string; tcls?: string; big?: boolean }

function lineOf(l: string | Line): Line {
  return typeof l === "string" ? { text: l } : l;
}
function fits(w: number, texts: string[]): number {
  return Math.max(w, ...texts.map((t) => Math.ceil(t.length * CW + 24)));
}
export function dbox(o: Box): string {
  const lines = (o.lines ?? []).map(lineOf);
  const w = fits(o.w, lines.map((l) => l.text).concat([o.title]));
  const block = 13 + (lines.length ? 18 + 14 * (lines.length - 1) : 0);
  let top = o.y + (o.h - block) / 2 + 11;
  const cx = o.x + w / 2;
  let s = `<rect class="d-box ${o.cls ?? ""}" x="${o.x}" y="${o.y}" width="${w}" height="${o.h}"/>`;
  s += `<text class="d-t ${o.tcls ?? ""}" x="${cx}" y="${top}" text-anchor="middle"${o.big ? ' font-size="15"' : ""}>${escapeHtml(o.title)}</text>`;
  lines.forEach((l, i) => {
    top += i === 0 ? 18 : 14;
    s += `<text class="d-s${l.cls ? " " + l.cls : ""}" x="${cx}" y="${top}" text-anchor="middle"${l.live ? ` data-live="${l.live}"` : ""}>${escapeHtml(l.text)}</text>`;
  });
  return s;
}
function marker(cls?: string): string {
  return cls && cls.includes("hi") ? "arw-g" : cls && cls.includes("warn") ? "arw-a" : "arw";
}
export function darrow(x1: number, y1: number, x2: number, y2: number, cls = "", both = false): string {
  return `<line class="d-l ${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${marker(cls)})"${both ? ` marker-start="url(#${marker(cls)})"` : ""}/>`;
}
export function dline(pts: number[], cls = ""): string {
  return `<polyline class="d-l ${cls}" points="${pts.join(" ")}"/>`;
}
export function dpath(d: string, cls = "", arrow = false): string {
  return `<path class="d-l ${cls}" d="${d}"${arrow ? ` marker-end="url(#${marker(cls)})"` : ""}/>`;
}
export function dlab(x: number, y: number, lines: string[], anchor = "middle", cls = ""): string {
  return lines.map((l, i) => `<text class="d-lab ${cls}" x="${x}" y="${y + i * 13}" text-anchor="${anchor}">${escapeHtml(l)}</text>`).join("");
}
/** A mark that rides a path (SMIL; the page pauses it under prefers-reduced-motion). The colour is a palette name, var(--green): every colour in a diagram is one, so a figure follows the theme. */
export function dot(path: string, color: string, dur: number, begin: number): string {
  return `<circle r="4" fill="${color}" stroke="var(--bg)" stroke-width="1.5"><animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${path}"/></circle>`;
}
const DEFS =
  '<defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--dim)"/></marker>' +
  '<marker id="arw-g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--green)"/></marker>' +
  '<marker id="arw-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--amber)"/></marker></defs>';
export function svgo(w: number, h: number, label: string, cls = ""): string {
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(label)}"${cls ? ` class="${cls}"` : ""}>${DEFS}`;
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
    dots += dot("M200 41 L240 41" + tail, "var(--green)", 10, 0) + dot("M200 133 L240 133" + tail, "var(--green)", 10, 3.3) + dot("M200 225 L240 225" + tail, "var(--green)", 10, 6.6);
    dots += dot("M450 152 L475 152 L475 215 L500 215 L620 215 L620 162", "var(--amber)", 6, 1.5);
  }
  return svgo(1280, 262, "Five sources feed the pool — Arch Linux, Arch Linux ARM, the OPR's edge channel, the Asahi projects and the pool's own factory — verified and stored once, then promoted through the edge, rc and stable rings on evidence; a ring rolls back by itself when a health check fails. Beside them the lab, where the factory's builds are installed by a real pacman before a maintainer approves them into edge.") + dots + s + "</svg>";
}

/**
 * Where every package comes from, and what happens to it before it reaches a
 * machine: the sources on the left (each with its keyring), verified and
 * stored once, the three rings and the evidence between them, the rollback
 * loop, and below, the factory's own road — the lab, the trial, a
 * maintainer's approval, and the fast lane a trial earns. The live lines are
 * filled by the page from /api/v1/stats.
 */
/**
 * The sources figure's boxes: one per upstream of EXPECTED_SOURCES (the
 * factory has its own road at the foot of the picture) — the title and the
 * live id are the picture's, the sources in the box and its keyring are the
 * code's (meta.ts), so a source added there lands in its upstream's box and
 * an upstream added there does not typecheck without a box.
 */
const UPSTREAM_BOX: Record<Exclude<Upstream, "the factory">, { id: string; title: string; note?: string }> = {
  "mirror.omarchy.org": { id: "src-arch", title: "Arch Linux · x86_64" },
  "os.archlinuxarm.org": { id: "src-alarm", title: "Arch Linux ARM · aarch64" },
  "pkgs.omarchy.org": { id: "src-opr", title: "Omarchy (OPR) · both", note: "the edge channel" },
  "github.com/maralcbr/omarchy-pkgs": { id: "src-asahi", title: "Omarchy for Apple Silicon", note: "aarch64 · the fork" },
  "github.com/asahi-alarm/asahi-alarm": { id: "src-asahi-alarm", title: "Asahi Linux · aarch64" },
  "builds.garudalinux.org": { id: "src-chaotic", title: "chaotic-aur · optional" },
};
export interface SourceBox { id: string; title: string; sources: string; keyring: string; entries: ExpectedSource[] }
/** The boxes in the order their upstreams first appear in EXPECTED_SOURCES; `sources` is the line in the box (each source once, the box's note after), `keyring` the upstream's. */
export function sourceBoxes(): SourceBox[] {
  const boxes: SourceBox[] = [];
  for (const e of EXPECTED_SOURCES) {
    if (e.upstream === "the factory") continue;
    const box = UPSTREAM_BOX[e.upstream];
    let b = boxes.find((x) => x.id === box.id);
    if (!b) boxes.push((b = { id: box.id, title: box.title, sources: "", keyring: UPSTREAMS[e.upstream].keyring, entries: [] }));
    b.entries.push(e);
    b.sources = [...new Set(b.entries.map((x) => x.source))].concat(box.note ? [box.note] : []).join(" · ");
  }
  return boxes;
}

export function sourcesDiagram(): string {
  let s = "";
  const HEAD = svgo(1330, 560, "Arch Linux, Arch Linux ARM, the OPR's edge channel, Omarchy for Apple Silicon, Asahi Linux and, optionally, the prebuilt AUR selections feed the pool; every package is verified against its project's keyring and stored once, then moves from edge to rc on a real pacman, an ABI check and the security layer, and from rc to stable after two green health checks in a row; a failed check rolls a ring back. The factory's builds go to the lab, where a real pacman installs them before a maintainer approves them into edge — and, when the trial installed them, into stable with it.");
  sourceBoxes().forEach((b, i) => {
    const y = 14 + i * 68;
    s += dbox({ x: 20, y, w: 220, h: 64, title: b.title, tcls: "small", lines: [b.sources, b.keyring, { text: "…", cls: "live", live: b.id }] }) + dline([240, y + 32, 270, y + 32]);
  });
  s += dline([270, 46, 270, 386]) + darrow(270, 198, 300, 198);
  s += dbox({ x: 300, y: 168, w: 176, h: 60, title: "Verify", cls: "amber", tcls: "amber", lines: ["the project's signature", "against its keyring"] });
  s += darrow(476, 198, 500, 198);
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
  s += dbox({ x: 630, y: 470, w: 250, h: 60, title: "A maintainer approves", tcls: "amber", cls: "amber", lines: ["never their own but under [solo]", "what installed, not what compiled"] });
  s += darrow(785, 470, 785, 240) + dlab(775, 366, ["approved", "→ edge"], "end");
  s += dpath("M880 510 L1290 510 L1290 240", "hi dash", true) + dlab(1085, 502, ["the fast lane: the trial installed it → stable with edge"], "middle", "hi");
  // The marks ride under the boxes: visible on the arrows, covered inside a box, never across its text.
  const tail = " L270 198 L300 198 L460 198 L500 198 L710 198 L760 198 L910 198 L960 198 L1110 198 L1160 198 L1235 198";
  const dots = dot("M240 46 L270 46" + tail, "var(--green)", 10, 0) + dot("M240 250 L270 250" + tail, "var(--green)", 10, 4) + dot("M280 500 L320 500 L590 500 L630 500 L785 500 L785 240", "var(--amber)", 8, 2);
  return HEAD + dots + s + "</svg>";
}
