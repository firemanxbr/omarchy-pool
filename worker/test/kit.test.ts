/**
 * The tokens, the light theme and the v1 kit (#239): every colour a page
 * module paints is a palette name — the palette in layout.ts is the only
 * place a colour is written, and the served CSS declares it once per theme —;
 * the light palette's contrast, measured here and its shortfalls named; the
 * frame square, with no shadow and no gradient; the theme chosen before the
 * first paint (THEME_BOOT, run over a document of its own) and window.opTheme
 * doing what the ⌘K menu will ask of it; the icons' one stylesheet, immutable
 * under its hash, carrying every icon and mark with their licences; the
 * shell's lucide() and agentMark() writing what the server's do; countUp()
 * landing its number in 1.1 s, or at once for a reader who asked for less
 * motion; and a code well's copy button saying "copied" for 1.5 s.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { PALETTE, THEME_BOOT, THEME_KEY, type Token } from "../src/pages/layout";
import { AGENT_MARKS, ICON_SHEET, ICON_SHEET_PATH, KIT_CSS, KIT_HELPERS, LUCIDE, agentMark, lucide, svgUri, type AgentMark, type LucideName } from "../src/pages/kit";
import licences from "../src/assets/icons/LICENSES.md";
import { runScript, scriptOf } from "./fixture";

// Every page module's source, as text: what the scan below reads.
const SOURCES = import.meta.glob("../src/pages/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

async function get(path: string, method = "GET"): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test${path}`, { method }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const page = async (path: string) => (await get(path)).text();
const styleOf = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)![1];

// WCAG 2's relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the tokens", () => {
  it("are the palette, typed once: the served CSS declares each name in both themes, and no page module writes a colour", async () => {
    const style = styleOf(await page("/"));
    for (const [name, v] of Object.entries(PALETTE)) {
      expect(style, name).toContain(`--${name}: ${v.dark};`);
      expect(style, name).toContain(`--${name}: ${v.light};`);
    }
    // Dark on the root and on anything pinned dark; light for a system that prefers it and nobody chose dark, and for a choice of light.
    expect(style).toContain(`:root, [data-theme="dark"] { color-scheme: dark; --bg: ${PALETTE.bg.dark};`);
    expect(style).toContain(`@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { color-scheme: light; --bg: ${PALETTE.bg.light};`);
    expect(style).toContain(`[data-theme="light"] { color-scheme: light; --bg: ${PALETTE.bg.light};`);
    // The ring hues and the semantic names follow the theme, declared wherever a theme is.
    expect(style).toContain(":root, [data-theme] {");
    expect(style).toContain("--edge: var(--lilac); --rc: var(--blue); --stable: var(--green); --lab: var(--amber);");
    for (const alias of ["--surface-page: var(--bg)", "--surface-chrome: var(--bg-deep)", "--accent: var(--green)", "--on-accent: var(--green-ink)", "--status-error: var(--red)", "--font-display: Geist", "--fs-label: 11.5px", "--tracking-label: .08em", "--radius: 0"]) expect(style).toContain(alias);
    // After the three theme blocks the CSS names tokens: no colour of its own.
    const named = style.slice(style.indexOf(":root, [data-theme] {"));
    expect(named.match(/#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([]);
    // The sources: a literal colour in a page module is one the theme cannot change. The palette is the one place (layout.ts); the favicon and the manifest read it.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(25);
    const found: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      const code = file.endsWith("/layout.ts") ? src.replace(/export const PALETTE = \{[\s\S]*?\} as const;/, "") : src;
      for (const m of code.matchAll(/#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?)\(|(?:color|background|fill|stroke)\s*[:=]\s*["']?#[0-9a-fA-F]{3,4}\b/g)) found.push(`${file}: ${m[0]}`);
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  it("keep the frame square, with no shadow and no gradient", async () => {
    const style = styleOf(await page("/"));
    for (const m of style.matchAll(/border-radius:\s*([^;}]+)/g)) expect(m[1].trim()).toBe("0");
    // A box-shadow with no blur and no offset is a bar on an edge (a row's 3px mark), the one kind left.
    for (const m of style.matchAll(/box-shadow:\s*([^;}]+)/g)) expect(m[1].trim()).toMatch(/^inset \d+px 0 0 var\(--[a-z0-9-]+\)$/);
    expect(style).not.toMatch(/(?:linear|radial|conic)-gradient\(/);
    expect(style).not.toMatch(/drop-shadow|text-shadow/);
    // The drawings too: no rounded box in a page's SVG. The favicon (icons.ts) is the brand's mark, a file with corners of its own.
    for (const [file, src] of Object.entries(SOURCES)) if (!file.endsWith("/icons.ts")) expect(src, file).not.toMatch(/\srx="/);
  });

  it("give the light theme the contrast text needs: 4.5:1 for body text and 3:1 at headline size, measured — and name where the handoff's palette falls short", () => {
    const TEXT: Token[] = ["text", "muted", "dim", "green", "amber", "red", "blue", "lilac"], SURFACES: Token[] = ["bg", "panel", "panel-2", "bg-deep"];
    const short: Record<"dark" | "light", string[]> = { dark: [], light: [] };
    for (const theme of ["dark", "light"] as const)
      for (const fg of TEXT)
        for (const bg of SURFACES) {
          const r = contrast(PALETTE[fg][theme], PALETTE[bg][theme]);
          expect(r, `${theme}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
          if (r < 4.5) short[theme].push(`${fg} on ${bg} ${r.toFixed(2)}`);
        }
    for (const theme of ["dark", "light"] as const) expect(contrast(PALETTE["green-ink"][theme], PALETTE.green[theme]), `${theme}: the ink on green`).toBeGreaterThanOrEqual(4.5);
    // Dark passes everywhere. Light is the handoff's palette as given (#239 reports it rather than re-tuning it silently): on the chrome's surface (--bg-deep: the header, the footer, code wells) four of the hues are under 4.5:1 for small text — every one above 3:1 — and every pair on the page's and the cards' surfaces passes.
    expect(short.dark).toEqual([]);
    expect(short.light).toEqual(["dim on bg-deep 4.13", "amber on bg-deep 4.30", "blue on bg-deep 4.47", "lilac on bg-deep 4.35"]);
  });
});

/** THEME_BOOT over a document of its own: the root's attributes, the two theme-color metas, a localStorage that can refuse, the system's preference. */
function boot(o: { stored?: string; prefersLight?: boolean; storageThrows?: boolean } = {}) {
  const attrs: Record<string, string> = {};
  const root = { getAttribute: (n: string) => attrs[n] ?? null, setAttribute: (n: string, v: string) => { attrs[n] = v; }, removeAttribute: (n: string) => { delete attrs[n]; } };
  const metas = (["dark", "light"] as const).map((t) => {
    const m = { media: `(prefers-color-scheme: ${t})`, content: PALETTE.bg[t], getAttribute: (n: string) => (n === "media" ? m.media : n === "content" ? m.content : null), setAttribute: (n: string, v: string) => { if (n === "content") m.content = v; } };
    return m;
  });
  const store: Record<string, string> = o.stored ? { [THEME_KEY]: o.stored } : {};
  const refuse = () => { if (o.storageThrows) throw new Error("SecurityError"); };
  const localStorage = { getItem: (k: string) => { refuse(); return store[k] ?? null; }, setItem: (k: string, v: string) => { refuse(); store[k] = v; }, removeItem: (k: string) => { refuse(); delete store[k]; } };
  const matchMedia = (q: string) => ({ matches: q === "(prefers-color-scheme: light)" && !!o.prefersLight });
  const on: Record<string, (e: { key: string }) => void> = {};
  const window: Record<string, any> = { matchMedia, addEventListener: (t: string, f: (e: { key: string }) => void) => { on[t] = f; } };
  const document = { documentElement: root, querySelectorAll: (sel: string) => (sel === 'meta[name="theme-color"]' ? metas : []) };
  new Function("document", "window", "localStorage", "matchMedia", THEME_BOOT)(document, window, localStorage, matchMedia);
  return { attrs, metas: () => metas.map((m) => m.content), store, opTheme: window.opTheme as { get(): string; set(t: unknown): string; toggle(): string }, on };
}

describe("the theme", () => {
  it("is decided in the head, before the body is drawn: the metas the browser's chrome reads, then the boot, then the styles", async () => {
    for (const path of ["/", "/factory", "/docs", "/status", "/package/zlib"]) {
      const html = await page(path), head = /<head>([\s\S]*?)<\/head>/.exec(html)![1];
      const dark = `<meta name="theme-color" content="${PALETTE.bg.dark}" media="(prefers-color-scheme: dark)">`, light = `<meta name="theme-color" content="${PALETTE.bg.light}" media="(prefers-color-scheme: light)">`, script = `<script>${THEME_BOOT}</script>`;
      for (const part of [dark, light, script, `<link rel="stylesheet" href="${ICON_SHEET_PATH}">`, "<style>"]) expect(head, `${path}: ${part.slice(0, 40)}`).toContain(part);
      expect(head.indexOf(light), path).toBeLessThan(head.indexOf(script));
      expect(head.indexOf(script), path).toBeLessThan(head.indexOf("<style>"));
      expect(head.match(/<meta name="theme-color"/g)?.length, path).toBe(2);
      // The page's own script is still one function after the boot: the tests read it with scriptOf, which sets the boot aside.
      expect(scriptOf(html).trim().startsWith("(function () {"), path).toBe(true);
    }
    // The footer's badge is the brand's: pinned dark, drawn in the palette's names.
    const home = await page("/");
    expect(home).toContain('<svg data-theme="dark" viewBox="0 0 156 20"');
    expect(/<footer>[\s\S]*<\/footer>/.exec(home)![0]).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  it("follows the system until the reader chooses, keeps the choice, and gives the ⌘K menu get, set and toggle", () => {
    // Nothing chosen: the CSS's media query decides, the boot sets nothing, the chrome keeps each meta's own colour.
    let b = boot();
    expect(b.attrs["data-theme"]).toBeUndefined();
    expect(b.metas()).toEqual([PALETTE.bg.dark, PALETTE.bg.light]);
    expect(b.opTheme.get()).toBe("dark");
    expect(boot({ prefersLight: true }).opTheme.get()).toBe("light");
    // A choice kept from an earlier visit is applied before the first paint, the chrome following it.
    b = boot({ stored: "light" });
    expect(b.attrs["data-theme"]).toBe("light");
    expect(b.metas()).toEqual([PALETTE.bg.light, PALETTE.bg.light]);
    expect(b.opTheme.get()).toBe("light");
    // Something else under the key is no choice.
    expect(boot({ stored: "sepia" }).attrs["data-theme"]).toBeUndefined();
    // set, toggle, and back to the system.
    b = boot({ prefersLight: true });
    expect(b.opTheme.set("dark")).toBe("dark");
    expect(b.store[THEME_KEY]).toBe("dark");
    expect(b.attrs["data-theme"]).toBe("dark");
    expect(b.metas()).toEqual([PALETTE.bg.dark, PALETTE.bg.dark]);
    expect(b.opTheme.toggle()).toBe("light");
    expect(b.store[THEME_KEY]).toBe("light");
    expect(b.opTheme.set("system")).toBe("light");
    expect(b.store[THEME_KEY]).toBeUndefined();
    expect(b.attrs["data-theme"]).toBeUndefined();
    expect(b.metas()).toEqual([PALETTE.bg.dark, PALETTE.bg.light]);
    expect(b.opTheme.set(null)).toBe("light");
    // A choice made in another tab of the pool is followed; another key is not.
    b = boot();
    b.store[THEME_KEY] = "light";
    b.on.storage({ key: "something-else" });
    expect(b.attrs["data-theme"]).toBeUndefined();
    b.on.storage({ key: THEME_KEY });
    expect(b.attrs["data-theme"]).toBe("light");
    // Storage refused (a private window, blocked site data): the page still switches, for as long as it is open.
    b = boot({ storageThrows: true });
    expect(b.opTheme.get()).toBe("dark");
    expect(b.opTheme.toggle()).toBe("light");
    expect(b.attrs["data-theme"]).toBe("light");
  });
});

describe("the v1 kit", () => {
  it("serves the icons in one stylesheet, immutable under its hash, and nothing else under /assets/", async () => {
    expect(ICON_SHEET_PATH).toMatch(/^\/assets\/icons\.[0-9a-f]{8}\.css$/);
    let res = await get(ICON_SHEET_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe(ICON_SHEET);
    // A page served before a deploy asks for the old name: today's sheet, for five minutes.
    const stale = ICON_SHEET_PATH.replace(/icons\.[0-9a-f]{8}/, ICON_SHEET_PATH.includes("icons.00000000") ? "icons.11111111" : "icons.00000000");
    res = await get(stale);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.text()).toBe(ICON_SHEET);
    res = await get(ICON_SHEET_PATH, "HEAD");
    expect(res.status).toBe(200);
    for (const [path, method] of [["/assets/icons.css", "GET"], ["/assets/icons.abc.css", "GET"], ["/assets/lucide/shield.svg", "GET"], [ICON_SHEET_PATH, "POST"]]) {
      res = await get(path, method);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("carries every icon and mark as a data: URI a stylesheet holds, with their licences, from the pinned packages", () => {
    // The icons the handoff's prototype draws, the one it names that 0.400.0 lacks (git-commit) as that release names it.
    expect(Object.keys(LUCIDE).length).toBe(62);
    expect(LUCIDE).toHaveProperty("git-commit-horizontal");
    for (const [name, svg] of Object.entries(LUCIDE)) {
      expect(svg.startsWith("<!-- @license lucide-static v0.400.0 - ISC -->"), name).toBe(true);
      expect(ICON_SHEET).toContain(`.op-i-${name}{--op-i:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'`);
    }
    for (const [name, m] of Object.entries(AGENT_MARKS)) {
      expect(m.svg, name).toContain("<svg");
      expect(ICON_SHEET).toContain(m.color ? `.op-b-${name}{--op-bc:url("data:image/svg+xml,` : `.op-b-${name}{--op-bm:url("data:image/svg+xml,`);
      expect(m.color, name).toBe(name.endsWith("-color"));
    }
    // What a URI inside a CSS string cannot hold raw is encoded; the file's comment, title and size are gone.
    for (const m of ICON_SHEET.matchAll(/url\("([^"]*)"\)/g)) expect(m[1]).not.toMatch(/[#<>"{}\\]|%(?![0-9A-F]{2})|[^\x20-\x7e]/);
    const shield = decodeURIComponent(svgUri(LUCIDE.shield).slice("data:image/svg+xml,".length));
    expect(shield).not.toMatch(/<!--|class=|\swidth=|\sheight=|\n|\s\/?>/);
    expect(decodeURIComponent(svgUri(AGENT_MARKS.openai.svg))).not.toMatch(/<title>|style=|1em/);
    // The licences travel with the sheet and lie beside the files.
    expect(ICON_SHEET.startsWith("/*")).toBe(true);
    for (const words of ["lucide-static 0.400.0", "ISC License", "Lucide Contributors", "@lobehub/icons-static-svg 1.95.1", "MIT License", "Copyright (c) 2023 LobeHub", "trademarks of their owners"]) expect(ICON_SHEET).toContain(words);
    for (const words of ["`lucide-static` 0.400.0", "ISC License", "`@lobehub/icons-static-svg` 1.95.1", "MIT License", "trademarks of their owners"]) expect(licences).toContain(words);
  });

  it("writes an icon and a mark the same on both sides: the shell's lucide() and agentMark() are the server's", async () => {
    const shell = runScript(scriptOf(await page("/")), { pathname: "/", functions: ["lucide", "agentMark"] });
    for (const name of Object.keys(LUCIDE) as LucideName[])
      for (const size of [undefined, 13, 14, 16, 26])
        for (const label of [undefined, 'the "search" box']) expect(shell.lucide(name, size, label), `${name} ${size} ${label}`).toBe(lucide(name, size, label));
    for (const mark of Object.keys(AGENT_MARKS) as AgentMark[])
      for (const size of [undefined, 16, 22]) expect(shell.agentMark(mark, "Claude <Code>", size)).toBe(agentMark(mark, "Claude <Code>", size));
    expect(lucide("shield")).toBe('<i class="op-i op-i-shield" aria-hidden="true"></i>');
    expect(lucide("search", 18, "search")).toBe('<i class="op-i op-i-search" style="--op-i-s:18px" role="img" aria-label="search"></i>');
    expect(agentMark("openai", "Codex", 22)).toBe('<i class="op-b op-b-openai" style="--op-i-s:22px" role="img" aria-label="Codex" title="Codex"></i>');
  });

  it("names every class it declares op-…, so none meets a class of today's pages, and declares them after the frame's", async () => {
    const style = styleOf(await page("/"));
    expect(style.endsWith(KIT_CSS)).toBe(true);
    expect(style.slice(0, style.length - KIT_CSS.length)).not.toMatch(/\.op-/);
    const rules = KIT_CSS.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...rules.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1].trim());
    expect(selectors.length).toBeGreaterThan(40);
    // An :is() is either kit classes (it stands for one) or the modifiers and elements of the kit class before it (.edge, .wait, button): nothing else may hide in one.
    for (const sel of selectors) {
      const flat = sel.replace(/:is\(([^)]*)\)/g, (_, inner: string) => {
        const parts = inner.split(",").map((s) => s.trim());
        for (const p of parts) expect(p, sel).toMatch(/^\.op-|^\.[a-z]+$|^[a-z]+$/);
        return parts.every((p) => p.startsWith(".op-")) ? ".op-is" : "";
      });
      for (const part of flat.split(",")) expect(part.trim(), sel).toMatch(/^[a-z]*\.op-/);
    }
  });

  it("lands a number with countUp(): 1.1 s easing out, at once for less motion, the last call winning", () => {
    const frames: ((t: number) => void)[] = [];
    let still = false;
    const make = () => new Function("requestAnimationFrame", "window", "matchMedia", "num", "document", `${KIT_HELPERS}\nreturn countUp;`)(
      (f: (t: number) => void) => frames.push(f),
      { matchMedia: () => ({ matches: still }) },
      (q: string) => ({ matches: still && q === "(prefers-reduced-motion: reduce)" }),
      (n: number) => Number(n).toLocaleString("en-US"),
      { addEventListener() {} },
    ) as (el: { textContent: string }, to: number, fmt?: (n: number) => string, ms?: number) => void;
    const countUp = make(), el = { textContent: "1,000" };
    countUp(el, 1000);
    expect(el.textContent).toBe("0");
    frames.shift()!(5000);
    expect(el.textContent).toBe("0");
    frames.shift()!(5550);
    expect(el.textContent).toBe("875");
    frames.shift()!(6100);
    expect(el.textContent).toBe("1,000");
    expect(frames.length).toBe(0);
    // A second call takes over: the first one's frame does nothing more.
    countUp(el, 10, (n) => "#" + n);
    countUp(el, 20, (n) => "+" + n);
    frames.shift()!(0);
    expect(el.textContent).toBe("+0");
    frames.shift()!(0);
    frames.shift()!(1100);
    expect(el.textContent).toBe("+20");
    frames.length = 0;
    // Less motion, or nothing to count: the number lands at once.
    still = true;
    countUp(el, 289, (n) => "+" + n);
    expect(el.textContent).toBe("+289");
    still = false;
    countUp(el, 0);
    expect(el.textContent).toBe("0");
    expect(frames.length).toBe(0);
  });

  it("copies a code well's command without its prompt, says copied for 1.5 s, and says so when the browser refuses", async () => {
    let click: ((ev: { target: unknown }) => void) | null = null;
    const timers: [() => void, number][] = [], written: string[] = [];
    let refuse = false;
    const clipboard = { writeText: (t: string) => (refuse ? Promise.reject(new Error("denied")) : (written.push(t), Promise.resolve())) };
    new Function("document", "navigator", "setTimeout", "window", "matchMedia", "num", "esc", KIT_HELPERS)(
      { addEventListener: (t: string, f: (ev: { target: unknown }) => void) => { if (t === "click") click = f; } },
      { clipboard }, (f: () => void, ms: number) => timers.push([f, ms]), {}, null, String, String,
    );
    const well = (attr: string) => {
      const classes = new Set<string>(), attrs: Record<string, string> = { "data-op-copy": attr };
      const code = { cloneNode: () => { const parts = ["$ ", "curl -fsSL https://omarchy-pool.org/setup | sudo bash"]; return { querySelectorAll: () => [{ remove: () => parts.shift() }], get textContent() { return parts.join(""); } }; } };
      const div = { querySelector: (s: string) => (s === "code" ? code : null) };
      const button = { disabled: false, textContent: "copy", classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) }, getAttribute: (n: string) => attrs[n] ?? null, setAttribute: (n: string, v: string) => { attrs[n] = v; }, closest: (s: string) => (s === "[data-op-copy]" ? button : s === ".op-code" ? div : null) };
      return { button, classes };
    };
    const settle = () => new Promise((r) => setTimeout(r, 0));
    expect(click).not.toBeNull();
    let w = well("");
    click!({ target: w.button });
    await settle();
    expect(written).toEqual(["curl -fsSL https://omarchy-pool.org/setup | sudo bash"]);
    expect(w.button.textContent).toBe("copied");
    expect(w.classes.has("copied")).toBe(true);
    expect(timers.map((t) => t[1])).toEqual([1500]);
    timers.shift()![0]();
    expect(w.button.textContent).toBe("copy");
    expect(w.classes.has("copied")).toBe(false);
    // The attribute's own text, when it has one, is what is copied.
    w = well("› what ring is this machine on?");
    click!({ target: w.button });
    await settle();
    expect(written[1]).toBe("› what ring is this machine on?");
    timers.length = 0;
    // Refused: said, then back to the button's word.
    refuse = true;
    w = well("");
    click!({ target: w.button });
    await settle();
    expect(w.button.textContent).toBe("could not copy");
    timers.shift()![0]();
    expect(w.button.textContent).toBe("copy");
    // A click anywhere else does nothing.
    click!({ target: { closest: () => null } });
    expect(written.length).toBe(2);
  });
});
