/**
 * The tokens, the light theme and the v1 kit (#239): every colour a page
 * module paints is a palette name — the palette in layout.ts is the only
 * place a colour is written, and the served CSS declares it once per theme —;
 * the light palette the handoff's, four hues darker in lightness only, so
 * every text colour reaches 4.5:1 on every surface of both themes, measured
 * here; the frame square, with no shadow and no gradient; a focused control
 * and the shell's own buttons visible in both themes, and every weight the
 * CSS draws with loaded; the theme chosen before the first paint
 * (THEME_BOOT, run over a document of its own) and window.opTheme doing
 * what the ⌘K menu will ask of it; the kit on the pages that ask for it and
 * nowhere else; its one stylesheet, immutable under its hash, carrying the
 * primitives and every icon and mark with their licences, no coloured mark
 * painting in white or black; a tone or a ring's hue never inherited by a
 * primitive nested in one; the shell's lucide() and agentMark() writing
 * what the server's do; countUp() landing its number in 1.1 s, or at once
 * for a reader who asked for less motion; and a code well's copy button
 * saying "copied" for 1.5 s, or "could not copy" — with no clipboard at all
 * too.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { version } from "../src/meta";
import { PALETTE, THEME_BOOT, THEME_KEY, page as frame, type Theme, type Token } from "../src/pages/layout";
import { AGENT_MARKS, KIT_CSS, KIT_HELPERS, KIT_SHEET, KIT_SHEET_PATH, LUCIDE, agentMark, lucide, svgUri, type AgentMark, type LucideName } from "../src/pages/kit";
import licences from "../src/assets/icons/LICENSES.md";
import { ownScriptOf, runScript, scriptOf } from "./fixture";

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
/** A page drawn with the kit, as a page that adopts it will be served: page({ kit: true }). No page has adopted it yet. */
const kitPage = () => frame({ title: "kit", description: "a page drawn with the v1 kit", active: "none", body: "<p>kit</p>", script: "var own = 1;", poolUrl: "http://pool.test/pool", version: version(env), path: "/kit", kit: true });

// WCAG 2's relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** A colour's hue (degrees), saturation and lightness (0 to 1). */
function hsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, l > 0.5 ? d / (2 - max - min) : d / (max + min), l];
}
/** #abc as #aabbcc. */
const long = (hex: string) => (hex.length === 4 ? "#" + [...hex.slice(1)].map((c) => c + c).join("") : hex).toLowerCase();
/** A CSS selector list split at its own commas, not the ones inside :is(…). */
function parts(sel: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  return [...out, cur.trim()];
}
/** A stylesheet's rules, flat — an @media's rules are rules too; a keyframe's steps are dropped with their @keyframes, comments with themselves. */
const rulesOf = (css: string) =>
  [...css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2], at: m.index! }));

/**
 * The handoff's "Design tokens" table (README.md), dark and light, as it was
 * given: what the palette is held to. Four light values are ours, darker
 * (layout.ts says why); the test below holds them to these hues.
 */
const HANDOFF: Record<Token, Record<Theme, string>> = {
  bg: { dark: "#1a1b26", light: "#e6e7ed" },
  "bg-deep": { dark: "#0e0e14", light: "#d8dae3" },
  panel: { dark: "#1f2230", light: "#eff0f4" },
  "panel-2": { dark: "#13141c", light: "#f6f7fa" },
  line: { dark: "#2a2e3f", light: "#c3c7d8" },
  text: { dark: "#c0caf5", light: "#2b3150" },
  muted: { dark: "#a9b1d6", light: "#474e70" },
  dim: { dark: "#8b93b8", light: "#5d6488" },
  green: { dark: "#9ece6a", light: "#466a20" },
  "green-ink": { dark: "#0c0e10", light: "#f6f7fa" },
  amber: { dark: "#e0af68", light: "#875a0c" },
  red: { dark: "#f7768e", light: "#b3244a" },
  blue: { dark: "#7aa2f7", light: "#2d5bc0" },
  lilac: { dark: "#bb9af7", light: "#7446c9" },
};
const DARKER_IN_LIGHT: Token[] = ["dim", "amber", "blue", "lilac"];
const TEXT: Token[] = ["text", "muted", "dim", "green", "amber", "red", "blue", "lilac"], SURFACES: Token[] = ["bg", "panel", "panel-2", "bg-deep"];

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
    // The veil behind a dialog: one, the handoff's in both themes, and declared on ::backdrop itself, which an older browser gives none of the page's custom properties.
    expect(style).toContain(`:root, ::backdrop { --scrim: color-mix(in srgb, ${PALETTE["bg-deep"].dark} 60%, transparent); }`);
    expect(style.match(/--scrim:/g)?.length).toBe(1);
    expect(style).toContain("dialog.ask::backdrop { background: var(--scrim); }");
    // The ring hues and the semantic names follow the theme, declared wherever a theme is.
    expect(style).toContain(":root, [data-theme] {");
    expect(style).toContain("--edge: var(--lilac); --rc: var(--blue); --stable: var(--green); --lab: var(--amber);");
    for (const alias of ["--surface-page: var(--bg)", "--surface-chrome: var(--bg-deep)", "--accent: var(--green)", "--on-accent: var(--green-ink)", "--status-error: var(--red)", "--font-display: Geist", "--fs-label: 11.5px", "--tracking-label: .08em", "--radius: 0"]) expect(style).toContain(alias);
    // After the palette's blocks the CSS names tokens: no colour of its own — the frame's and the kit's.
    const named = style.slice(style.indexOf(":root, [data-theme] {"));
    for (const css of [named, KIT_CSS]) expect(css.match(/#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([]);
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
    const style = styleOf(await page("/")) + KIT_CSS;
    for (const m of style.matchAll(/border-radius:\s*([^;}]+)/g)) expect(m[1].trim()).toBe("0");
    // A box-shadow with no blur and no offset is a bar on an edge (a row's 3px mark), the one kind left.
    for (const m of style.matchAll(/box-shadow:\s*([^;}]+)/g)) expect(m[1].trim()).toMatch(/^inset \d+px 0 0 var\(--[a-z0-9-]+\)$/);
    expect(style).not.toMatch(/(?:linear|radial|conic)-gradient\(/);
    expect(style).not.toMatch(/drop-shadow|text-shadow/);
    // The drawings too: no rounded box in a page's SVG. The favicon (icons.ts) is the brand's mark, a file with corners of its own.
    for (const [file, src] of Object.entries(SOURCES)) if (!file.endsWith("/icons.ts")) expect(src, file).not.toMatch(/\srx="/);
  });

  it("give text the contrast it needs in both themes: 4.5:1 for every text colour on every surface — body text's, so headline size's 3:1 too", () => {
    const short: string[] = [];
    for (const theme of ["dark", "light"] as const)
      for (const fg of TEXT)
        for (const bg of SURFACES) {
          const r = contrast(PALETTE[fg][theme], PALETTE[bg][theme]);
          if (r < 4.5) short.push(`${theme}: ${fg} on ${bg} ${r.toFixed(2)}`);
        }
    // The chrome's surface (--bg-deep: the header, the footer, a code well, a table's head) holds small text in --dim and the status colours; it was the light theme's shortfall.
    expect(short, short.join("\n")).toEqual([]);
    for (const theme of ["dark", "light"] as const) expect(contrast(PALETTE["green-ink"][theme], PALETTE.green[theme]), `${theme}: the ink on green`).toBeGreaterThanOrEqual(4.5);
  });

  it("are the handoff's table: dark as given, light as given but four hues darker in lightness only — just enough for 4.5:1 on the chrome", () => {
    for (const name of Object.keys(HANDOFF) as Token[]) {
      expect(PALETTE[name].dark, `dark ${name}`).toBe(HANDOFF[name].dark);
      const given = HANDOFF[name].light, ours = PALETTE[name].light;
      if (!DARKER_IN_LIGHT.includes(name)) {
        expect(ours, `light ${name}`).toBe(given);
        continue;
      }
      // The same hue and saturation, a little less light: under 6% of it.
      const [h0, s0, l0] = hsl(given), [h1, s1, l1] = hsl(ours);
      expect(Math.abs(h1 - h0), `light ${name}: hue`).toBeLessThanOrEqual(1);
      expect(Math.abs(s1 - s0), `light ${name}: saturation`).toBeLessThanOrEqual(0.01);
      expect(l1, `light ${name}: lightness`).toBeLessThan(l0);
      expect(l1 / l0, `light ${name}: lightness`).toBeGreaterThan(0.94);
      // Why: the handoff's value was under 4.5:1 on the chrome's surface, ours is not.
      expect(contrast(given, HANDOFF["bg-deep"].light), `light ${name} as given`).toBeLessThan(4.5);
      expect(contrast(ours, PALETTE["bg-deep"].light), `light ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(Object.keys(PALETTE).sort()).toEqual(Object.keys(HANDOFF).sort());
  });
});

describe("both themes", () => {
  it("keep a focused control visible: a rule that takes the outline away puts a green line in its place", async () => {
    const rules = rulesOf(styleOf(await page("/")) + KIT_CSS);
    const greenLine = (body: string) => /outline:\s*1px solid var\(--green\)/.test(body);
    let checked = 0;
    for (const r of rules) {
      if (!/outline:\s*(?:none|0)\s*(?:;|$)/.test(r.body)) continue;
      for (const part of parts(r.sel).filter((p) => /:focus(?![-\w])/.test(p))) {
        checked++;
        if (/border-color:\s*var\(--green\)/.test(r.body)) continue;
        // The background alone is no line: a search suggestion's --panel to --panel-2 is 1.06:1 in light.
        const visible = part.replace(/:focus(?![-\w])/, ":focus-visible");
        expect(rules.some((o) => parts(o.sel).includes(visible) && greenLine(o.body)), `${part}: its outline is taken away and nothing replaces it`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
    expect(rules.some((r) => r.sel === ".suggest a:focus-visible" && greenLine(r.body))).toBe(true);
  });

  it("draw the shell's own buttons in the palette's names, never the browser's: the decision dialog's and the Decision cell's", async () => {
    const style = styleOf(await page("/review"));
    expect(style).toContain(":where(dialog.ask, .decide) button { background: var(--panel-2); border: 1px solid var(--line); color: var(--text); padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer; }");
    expect(style).toContain(":where(dialog.ask, .decide) button:hover { border-color: var(--green); }");
    // The dialog's confirm is its primary, in green; a dangerous one is red, a way out muted — those rules outweigh :where().
    expect(style).toContain('dialog.ask button[type="submit"]:not(.danger) { background: var(--green); border-color: var(--green); color: var(--green-ink); }');
    for (const rule of ["dialog.ask button.danger { border-color: var(--red); color: var(--red); }", "dialog.ask button.ghost { color: var(--muted); }", "table button { padding: 3px 9px; font-size: 12.5px; }"]) expect(style).toContain(rule);
    // What they style is what the shell draws: the dialog's buttons and the cell's.
    const script = scriptOf(await page("/review"));
    for (const drawn of ['d.className = "ask"', '<button type="button" class="ghost cancel">', '<button type="submit" class="', "return '<span class=\"decide\"", "gate('<button type=\"button\" data-' + what"]) expect(script, drawn).toContain(drawn);
  });

  it("load every weight the CSS draws with: JetBrains Mono carries the body, so it has them all", async () => {
    const html = await page("/"), css = styleOf(html) + KIT_CSS;
    const url = /<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)">/.exec(html)![1];
    const loaded = (family: string) => new Set(new RegExp(`family=${family}:wght@([0-9;]+)`).exec(url)![1].split(";").map(Number));
    const used = new Set([...css.matchAll(/font-weight:\s*(\d{3})|font:\s*(\d{3})\s/g)].map((m) => Number(m[1] ?? m[2])));
    for (const src of Object.values(SOURCES)) for (const m of src.matchAll(/font-weight="(\d{3})"/g)) used.add(Number(m[1]));
    expect([...used].sort()).toEqual([400, 500, 600, 700]);
    for (const w of used) expect(loaded("JetBrains\\+Mono").has(w), `JetBrains Mono ${w}`).toBe(true);
    // Geist draws the titles and the numbers, at 500 and up.
    for (const w of used) if (w >= 500) expect(loaded("Geist").has(w), `Geist ${w}`).toBe(true);
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
      for (const part of [dark, light, script, "<style>"]) expect(head, `${path}: ${part.slice(0, 40)}`).toContain(part);
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
  it("is on the pages that ask for it, and costs the others nothing: its sheet after the frame's CSS, its helpers after the shell's", async () => {
    // A page that has not adopted it links no sheet and carries no primitive or kit helper of its own. The one mention of the sheet is the ⌘K menu's (#241): its icons are the kit's, and it links the sheet the first time it opens — nothing is asked for before that (test/go-menu.test.ts opens it).
    for (const path of ["/", "/factory", "/review", "/docs", "/package/zlib"]) {
      const html = await page(path);
      expect(/<head>([\s\S]*?)<\/head>/.exec(html)![1], path).not.toContain("/assets/kit.");
      expect(html.split("/assets/kit.").length - 1, `${path}: the menu's mention only`).toBe(1);
      expect(scriptOf(html), path).toContain(`SHEET = ${JSON.stringify(KIT_SHEET_PATH)}`);
      expect(styleOf(html), path).not.toContain(".op-");
      expect(scriptOf(html), path).not.toContain(KIT_HELPERS.trim().slice(0, 80));
    }
    // A page that asks: the sheet once, linked after the frame's <style> — its primitives are declared after the frame's rules —, and the helpers the shell's, not the page's own.
    const html = kitPage(), head = /<head>([\s\S]*?)<\/head>/.exec(html)![1], link = `<link rel="stylesheet" href="${KIT_SHEET_PATH}">`;
    expect(head.match(/\/assets\/kit\./g)?.length).toBe(1);
    expect(head.indexOf(link)).toBeGreaterThan(head.indexOf("</style>"));
    expect(styleOf(html)).not.toContain(".op-");
    expect(scriptOf(html)).toContain(KIT_HELPERS);
    expect(ownScriptOf(html)!.trim().startsWith("var own = 1;")).toBe(true);
    // Status is drawn with it (#248): the sheet in its head after the frame's CSS, the helpers after the shell's, and its own script after them.
    const status = await page("/status"), statusHead = /<head>([\s\S]*?)<\/head>/.exec(status)![1];
    expect(statusHead.match(/\/assets\/kit\./g)?.length).toBe(1);
    expect(statusHead.indexOf(link)).toBeGreaterThan(statusHead.indexOf("</style>"));
    expect(scriptOf(status)).toContain(KIT_HELPERS);
    expect(ownScriptOf(status)).not.toContain(KIT_HELPERS.trim().slice(0, 80));
  });

  it("serves its sheet, immutable under its hash, and nothing else under /assets/", async () => {
    expect(KIT_SHEET_PATH).toMatch(/^\/assets\/kit\.[0-9a-f]{8}\.css$/);
    let res = await get(KIT_SHEET_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe(KIT_SHEET);
    // A page served before a deploy asks for the old name: today's sheet, for five minutes.
    const stale = KIT_SHEET_PATH.replace(/kit\.[0-9a-f]{8}/, KIT_SHEET_PATH.includes("kit.00000000") ? "kit.11111111" : "kit.00000000");
    res = await get(stale);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.text()).toBe(KIT_SHEET);
    res = await get(KIT_SHEET_PATH, "HEAD");
    expect(res.status).toBe(200);
    for (const [path, method] of [["/assets/kit.css", "GET"], ["/assets/kit.abc.css", "GET"], [KIT_SHEET_PATH.replace("/kit.", "/icons."), "GET"], ["/assets/lucide/shield.svg", "GET"], [KIT_SHEET_PATH, "POST"]]) {
      res = await get(path, method);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("carries the primitives, then every icon and mark as a data: URI, with their licences, from the pinned packages", () => {
    // The licences first, then the primitives, then the shapes.
    expect(KIT_SHEET.startsWith("/*")).toBe(true);
    expect(KIT_SHEET.indexOf(KIT_CSS.trim())).toBe(KIT_SHEET.indexOf("*/") + 3);
    expect(KIT_SHEET.indexOf(KIT_CSS.trim())).toBeLessThan(KIT_SHEET.indexOf(".op-i-"));
    // The icons the handoff's prototype draws, the one it names that 0.400.0 lacks (git-commit) as that release names it.
    expect(Object.keys(LUCIDE).length).toBe(62);
    expect(LUCIDE).toHaveProperty("git-commit-horizontal");
    for (const [name, svg] of Object.entries(LUCIDE)) {
      expect(svg.startsWith("<!-- @license lucide-static v0.400.0 - ISC -->"), name).toBe(true);
      expect(KIT_SHEET).toContain(`.op-i-${name}{--op-i:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'`);
    }
    for (const [name, m] of Object.entries(AGENT_MARKS)) {
      expect(m.svg, name).toContain("<svg");
      expect(KIT_SHEET).toContain(m.color ? `.op-b-${name}{--op-bc:url("data:image/svg+xml,` : `.op-b-${name}{--op-bm:url("data:image/svg+xml,`);
      expect(m.color, name).toBe(name.endsWith("-color"));
    }
    // What a URI inside a CSS string cannot hold raw is encoded; the file's comment, title and size are gone.
    for (const m of KIT_SHEET.matchAll(/url\("([^"]*)"\)/g)) expect(m[1]).not.toMatch(/[#<>"{}\\]|%(?![0-9A-F]{2})|[^\x20-\x7e]/);
    const shield = decodeURIComponent(svgUri(LUCIDE.shield).slice("data:image/svg+xml,".length));
    expect(shield).not.toMatch(/<!--|class=|\swidth=|\sheight=|\n|\s\/?>/);
    expect(decodeURIComponent(svgUri(AGENT_MARKS.openai.svg))).not.toMatch(/<title>|style=|1em/);
    // The licences travel with the sheet and lie beside the files.
    for (const words of ["lucide-static 0.400.0", "ISC License", "Lucide Contributors", "@lobehub/icons-static-svg 1.95.1", "MIT License", "Copyright (c) 2023 LobeHub", "trademarks of their owners"]) expect(KIT_SHEET).toContain(words);
    for (const words of ["`lucide-static` 0.400.0", "ISC License", "`@lobehub/icons-static-svg` 1.95.1", "MIT License", "trademarks of their owners"]) expect(licences).toContain(words);
  });

  it("draws a coloured mark on both themes: no part in white or black, which one of them would swallow, and its strongest part clear of every surface", () => {
    let coloured = 0;
    for (const [name, m] of Object.entries(AGENT_MARKS)) {
      if (!m.color) continue;
      coloured++;
      const paints = [...m.svg.matchAll(/(?:fill|stop-color)="(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})"/g)].map((x) => long(x[1]));
      expect(paints.length, name).toBeGreaterThan(0);
      expect(m.svg, name).not.toMatch(/(?:fill|stop-color)="(?:white|black|currentColor)"/i);
      for (const c of paints) {
        const l = hsl(c)[2];
        expect(l, `${name}: ${c}`).toBeGreaterThan(0.05);
        expect(l, `${name}: ${c}`).toBeLessThan(0.95);
      }
      for (const theme of ["dark", "light"] as const) for (const s of SURFACES) expect(Math.max(...paints.map((c) => contrast(c, PALETTE[s][theme]))), `${name} on ${theme} ${s}`).toBeGreaterThanOrEqual(2);
    }
    expect(coloured).toBe(4);
    // Kimi's coloured file draws its K in white (a lone blue dot on a light page): Kimi is its one-colour file, in the text's colour.
    expect(AGENT_MARKS).toHaveProperty("kimi");
    expect(AGENT_MARKS).not.toHaveProperty("kimi-color");
    expect(AGENT_MARKS.kimi.color).toBe(false);
    expect(AGENT_MARKS.kimi.svg).toContain('fill="currentColor"');
  });

  it("writes an icon and a mark the same on both sides: the shell's lucide() and agentMark() are the server's", () => {
    const shell = runScript(scriptOf(kitPage()), { pathname: "/kit", functions: ["lucide", "agentMark"] });
    for (const name of Object.keys(LUCIDE) as LucideName[])
      for (const size of [undefined, 13, 14, 16, 26])
        for (const label of [undefined, 'the "search" box']) expect(shell.lucide(name, size, label), `${name} ${size} ${label}`).toBe(lucide(name, size, label));
    for (const mark of Object.keys(AGENT_MARKS) as AgentMark[])
      for (const size of [undefined, 16, 22]) expect(shell.agentMark(mark, "Claude <Code>", size)).toBe(agentMark(mark, "Claude <Code>", size));
    expect(lucide("shield")).toBe('<i class="op-i op-i-shield" aria-hidden="true"></i>');
    expect(lucide("search", 18, "search")).toBe('<i class="op-i op-i-search" style="--op-i-s:18px" role="img" aria-label="search"></i>');
    expect(agentMark("openai", "Codex", 22)).toBe('<i class="op-b op-b-openai" style="--op-i-s:22px" role="img" aria-label="Codex" title="Codex"></i>');
  });

  it("names every class it declares op-…, so none meets a class of today's pages, and draws a chosen control by its class or its ARIA state alike", () => {
    const selectors = rulesOf(KIT_CSS).map((r) => r.sel);
    expect(selectors.length).toBeGreaterThan(40);
    // An :is() is either kit classes (it stands for one) or the modifiers, elements and ARIA states of the kit class before it (.edge, button, [aria-pressed="true"]): nothing else may hide in one.
    for (const sel of selectors) {
      const flat = sel.replace(/:is\(([^)]*)\)/g, (_, inner: string) => {
        const ps = inner.split(",").map((s) => s.trim());
        for (const p of ps) expect(p, sel).toMatch(/^\.op-|^\.[a-z]+$|^[a-z]+$|^\[aria-[a-z]+="[a-z]+"\]$/);
        return ps.every((p) => p.startsWith(".op-")) ? ".op-is" : "";
      });
      for (const part of flat.split(",")) expect(part.trim(), sel).toMatch(/^[a-z]*\.op-/);
    }
    // Chosen is .on or what a screen reader hears, drawn by one rule each: a page that sets aria-pressed or aria-selected needs no class, and the two cannot disagree.
    expect(KIT_CSS).toContain('.op-seg > :is(.on, [aria-pressed="true"], [aria-current="page"], [aria-current="true"]) {');
    expect(KIT_CSS).toContain('.op-tabs > :is(.on, [aria-selected="true"], [aria-current="page"], [aria-current="true"]) {');
    expect(KIT_CSS).not.toMatch(/> \.on\s*\{/);
  });

  it("keeps a tone and a ring's hue on the element that carries it: a ring card tints no arch square, chip or segment inside it", () => {
    // --op-tone and --op-hue are custom properties, which inherit: each is reset where it is read, before any class sets it, so a nested primitive takes its own fallback.
    const rules = rulesOf(KIT_CSS);
    for (const prop of ["--op-tone", "--op-hue"]) {
      const resets = rules.filter((r) => new RegExp(`${prop}:\\s*initial`).test(r.body));
      expect(resets.length, prop).toBe(1);
      const covered = parts(resets[0].sel);
      // Each reset element is one class, or a kit class's children: a class's weight, which a setter (two classes) outweighs.
      for (const c of covered) expect(c, prop).toMatch(/^\.op-[a-z-]+(?: > \*)?$/);
      const setters = rules.filter((r) => new RegExp(`${prop}:\\s*var\\(`).test(r.body));
      expect(setters.length, prop).toBeGreaterThanOrEqual(4);
      for (const r of setters) {
        expect(r.at, r.sel).toBeGreaterThan(resets[0].at);
        expect(parts(/^:is\(([^)]*)\)/.exec(r.sel)![1]).sort(), r.sel).toEqual([...covered].sort());
      }
      // Every rule that reads it reads it on an element the reset covers.
      const readers = rules.filter((r) => r.body.includes(`var(${prop}`));
      expect(readers.length, prop).toBeGreaterThanOrEqual(3);
      for (const r of readers)
        for (const part of parts(r.sel)) {
          const on = covered.some((c) => (c.endsWith(" > *") ? part.startsWith(c.slice(0, -1)) : new RegExp(`^${c.replace(/[.-]/g, "\\$&")}(?![\\w-])`).test(part)));
          expect(on, `${part} reads ${prop} on an element that may inherit it`).toBe(true);
        }
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

  it("copies a code well's command without its prompt, says copied for 1.5 s, and says so when the browser refuses or has no clipboard", async () => {
    const timers: [() => void, number][] = [], written: string[] = [];
    let refuse = false;
    const clipboard = { writeText: (t: string) => (refuse ? Promise.reject(new Error("denied")) : (written.push(t), Promise.resolve())) };
    // The helpers over a document of their own, with the navigator given: the click listener they add is returned.
    const install = (navigator: object) => {
      let click: ((ev: { target: unknown }) => void) | null = null;
      new Function("document", "navigator", "setTimeout", "window", "matchMedia", "num", "esc", KIT_HELPERS)(
        { addEventListener: (t: string, f: (ev: { target: unknown }) => void) => { if (t === "click") click = f; } },
        navigator, (f: () => void, ms: number) => timers.push([f, ms]), {}, null, String, String,
      );
      expect(click).not.toBeNull();
      return click!;
    };
    const click = install({ clipboard });
    const well = (attr: string) => {
      const classes = new Set<string>(), attrs: Record<string, string> = { "data-op-copy": attr };
      const code = { cloneNode: () => { const ps = ["$ ", "curl -fsSL https://omarchy-pool.org/setup | sudo bash"]; return { querySelectorAll: () => [{ remove: () => ps.shift() }], get textContent() { return ps.join(""); } }; } };
      const div = { querySelector: (s: string) => (s === "code" ? code : null) };
      const button = { disabled: false, textContent: "copy", classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) }, getAttribute: (n: string) => attrs[n] ?? null, setAttribute: (n: string, v: string) => { attrs[n] = v; }, closest: (s: string) => (s === "[data-op-copy]" ? button : s === ".op-code" ? div : null) };
      return { button, classes };
    };
    const settle = () => new Promise((r) => setTimeout(r, 0));
    let w = well("");
    click({ target: w.button });
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
    click({ target: w.button });
    await settle();
    expect(written[1]).toBe("› what ring is this machine on?");
    timers.length = 0;
    // Refused: said, then back to the button's word.
    refuse = true;
    w = well("");
    click({ target: w.button });
    await settle();
    expect(w.button.textContent).toBe("could not copy");
    timers.shift()![0]();
    expect(w.button.textContent).toBe("copy");
    // A click anywhere else does nothing.
    click({ target: { closest: () => null } });
    expect(written.length).toBe(2);
    // No clipboard at all (plain http, an older browser: navigator.clipboard is undefined): said the same, and nothing thrown.
    const bare = install({});
    w = well("");
    expect(() => bare({ target: w.button })).not.toThrow();
    expect(w.button.textContent).toBe("could not copy");
    expect(timers.map((t) => t[1])).toEqual([1500]);
    timers.shift()![0]();
    expect(w.button.textContent).toBe("copy");
  });
});
