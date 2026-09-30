/**
 * The page a person meets at an address nothing answers (#300): an unknown
 * path, or a malformed /worker/<id>, /build/<id> or /user/<login>. It is the
 * site's frame (dark unless the reader chose light), says which address was
 * asked, and offers the way back: the home page, the packages, and the
 * header's Go… (the ⌘K menu, which every page carries). Sign in leads home,
 * not back to the dead address. Served with status 404; an address under
 * /api/ keeps the JSON answer (index.ts). Not for an index.
 */
import { page } from "./layout";
import { lucide } from "./kit";
import { escapeHtml } from "../html";
import type { RunningVersion } from "../meta";

const CSS = String.raw`
  .nf { max-width: 720px; min-height: calc(100vh - 224px); margin: 0 auto; padding: 48px 0 64px; display: grid; gap: 16px; align-content: center; }
  .nf .lead { margin: 0; color: var(--muted); font-size: 15px; }
  .nf .lead code { color: var(--text); overflow-wrap: anywhere; }
  .nf .acts { display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 0 0; }
  @media (max-width: 520px) { .nf { min-height: calc(100vh - 320px); padding: 24px 0 40px; } .nf .op-hero { font-size: 28px; } }
`;

export function notFoundHtml(path: string, poolUrl: string, version: RunningVersion): string {
  return page({
    path: "/",
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
  </div>
  <p class="lead">Or use Go… at the top of the page to find a package or a page.</p>
</section>`,
    poolUrl,
    version,
    kit: true,
    css: CSS,
    noindex: true,
  });
}
