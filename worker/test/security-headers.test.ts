/**
 * #300: every answer carries the security headers (src/headers.ts) — a
 * page, the API, a redirect, a script, an icon, a 404 — and a person at an
 * address nothing answers gets the site's own 404 page, while a machine
 * under /api/ keeps the JSON 404.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { SECURITY_HEADERS } from "../src/headers";
import { KIT_SHEET_PATH } from "../src/pages/kit";
import { DASHBOARD_HOST, LEGACY_DASHBOARD_HOSTS } from "../src/meta";
import { seedDashboard } from "./fixture";

async function call(path: string, init: RequestInit = {}, origin = `https://${DASHBOARD_HOST}`): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${origin}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const EXPECTED = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  // Passkeys stay allowed on the site's own origin; what the site never uses is off.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
  // The site's own origin and Google Fonts, never frame-ancestors (ignored in a Report-Only policy).
  "content-security-policy-report-only":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'",
};

function headersOf(res: Response): Record<string, string | null> {
  return Object.fromEntries(Object.keys(SECURITY_HEADERS).map((k) => [k, res.headers.get(k)]));
}

beforeAll(async () => {
  await seedDashboard(env);
});

describe("the security headers", () => {
  // A sample of every kind of route: pages, a page with a parameter, the API (a read, a write refused, a 404), redirects (the sign-in's among them), the scripts, an icon, the kit's sheet, robots, the sitemap, a preflight, the pool's fallback, and the 404 page.
  const SAMPLE: [string, RequestInit?, string?][] = [
    ["/"], ["/packages"], ["/docs"], ["/status"], ["/review"], ["/package/zlib"], ["/user/alice"], ["/build/9"], ["/worker/w1"],
    ["/api/v1/version"], ["/api/v1/stats"], ["/api/v1/packages?q=zlib"], ["/api/v1/releases", { method: "POST" }], ["/api/v1/nope"],
    ["/api/v1/version", { method: "OPTIONS" }], ["/journal"], ["/index.html"], ["/me"], ["/setup"], ["/omarchy-worker"], ["/robots.txt"], ["/favicon.svg"],
    ["/auth/github?next=/"], ["/sitemap.xml"], [KIT_SHEET_PATH], ["/pool/core.db"], ["/nope"], ["/", {}, `https://${LEGACY_DASHBOARD_HOSTS[0]}`],
  ];

  it("are on every answer of the sample", async () => {
    for (const [path, init, origin] of SAMPLE) {
      const res = await call(path, init, origin);
      const got = headersOf(res);
      const name = `${init?.method ?? "GET"} ${origin ?? ""}${path} (${res.status})`;
      expect.soft(got, name).toEqual(EXPECTED);
    }
  });

  it("leave the agent pages' stricter referrer policy as they set it", async () => {
    // A signed-in person's grant link that asks for too little: personal()'s refusal page, with its own headers.
    const res = await call("/auth/agent?agent=x", { headers: { cookie: "omc=oms_alice" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(headersOf(res)).toMatchObject({ ...EXPECTED, "referrer-policy": "same-origin" });
  });
});

describe("an address nothing answers", () => {
  it("is the themed 404 page for a person: the frame, dark by default, and the way back", async () => {
    for (const path of ["/nope", "/build/abc", "/user/not_a_login", `/worker/${"x".repeat(121)}`, "/docs/nope"]) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
      const text = await res.text();
      expect(text, path).toContain("<title>Not found · omarchy-pool</title>");
      expect(text, path).toContain('<a class="brand" href="/">');
      expect(text, path).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(text, path).toContain(`<code>${path}</code>`);
      // Dark unless the reader chose light: the page is served with no theme of its own on <html>.
      expect(text, path).toMatch(/^<!doctype html>\n<html lang="en">\n/);
      for (const href of ['<a class="op-btn primary" href="/">Home</a>', '<a class="op-btn" href="/packages">', "Or use Go… at the top of the page", '<a class="go" id="go" href="/packages"']) expect(text, path).toContain(href);
      // Signing in from here leads home, not back to the dead address.
      expect(text, path).toContain('href="/auth/github?next=/"');
    }
  });

  it("escapes the address it names", async () => {
    // The URL percent-encodes " < and > in a path; & reaches the page raw, so it is the character that shows the escaping.
    const text = await (await call("/a&b")).text();
    expect(text).toContain("<code>/a&amp;b</code>");
  });

  it("stays the JSON 404 under /api/, for a machine", async () => {
    for (const path of ["/api/v1/nope", "/api/v2/anything", "/api/v1/packages/zzz/nope"]) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toBe("application/json; charset=utf-8");
      expect(await res.json(), path).toEqual({ error: "not found" });
    }
  });
});
