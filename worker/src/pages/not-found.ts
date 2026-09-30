/**
 * The page a person meets at an address nothing answers (#300): an unknown
 * path, or a malformed /worker/<id>, /build/<id> or /user/<login>. It is the
 * site's frame (dark unless the reader chose light), says which address was
 * asked, and offers the way back: the home page, the packages, and the ⌘K
 * menu. Served with status 404; an address under /api/ keeps the JSON
 * answer (index.ts). Not for an index.
 */
import { page } from "./layout";
import { lucide } from "./kit";
import { escapeHtml } from "../html";
import type { RunningVersion } from "../meta";

const CSS = String.raw`
  .nf { max-width: 720px; min-height: calc(100vh - 224px); margin: 0 auto; padding: 48px 0 64px; display: grid; gap: 16px; align-content: center; }
  .nf .lead { margin: 0; color: var(--muted); font-size: 15px; }
  .nf .lead code { color: var(--text); overflow-wrap: anywhere; }
  .nf .acts { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
  .nf .acts kbd { padding: 0 5px; border: 1px solid var(--line); font: 11px/1.5 var(--font-mono); color: var(--dim); }
  @media (hover: none) and (pointer: coarse) { .nf .acts kbd { display: none; } }
  @media (max-width: 520px) { .nf { min-height: calc(100vh - 320px); padding: 24px 0 40px; } .nf .op-hero { font-size: 28px; } }
`;

/** ⌘K is the frame's menu (GO_MENU, which every page carries): the link opens it where the browser has it, and stays a link to the packages where not. Its key is named for the platform, as the header's Go… names it. */
const SCRIPT = String.raw`
  (function () {
    var go = document.getElementById("nf-go"); if (!go) return;
    var key = go.querySelector("kbd"); if (key && !/Mac|iPhone|iPad/.test(navigator.platform || "")) key.textContent = "Ctrl K";
    if (window.opPalette) go.addEventListener("click", function (e) { e.preventDefault(); window.opPalette.open(); });
  })();
`;

export function notFoundHtml(path: string, poolUrl: string, version: RunningVersion): string {
  return page({
    path,
    title: "Not found · omarchy-pool",
    description: "Nothing is served at this address.",
    active: "none",
    body: `<section class="nf">
  <p class="op-eyebrow">404 · not found</p>
  <h1 class="op-hero">Nothing lives at this address</h1>
  <p class="lead">No page answers <code>${escapeHtml(path)}</code>. The link may be old or mistyped.</p>
  <div class="acts">
    <a class="op-btn primary" href="/">Home</a>
    <a class="op-btn" href="/packages">${lucide("package")} Packages</a>
    <a class="op-btn" href="/packages" id="nf-go">${lucide("search")} Find a package or a page <kbd>⌘K</kbd></a>
  </div>
</section>`,
    script: SCRIPT,
    poolUrl,
    version,
    kit: true,
    css: CSS,
    noindex: true,
  });
}
