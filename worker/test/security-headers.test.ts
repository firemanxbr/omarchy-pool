/**
 * #300: every answer carries the security headers (src/headers.ts) — a
 * page, the API, a redirect, a script, an icon, a 404.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { CSP_REPORT_ONLY, SECURITY_HEADERS } from "../src/headers";
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
};

function headersOf(res: Response): Record<string, string | null> {
  return Object.fromEntries(Object.keys(SECURITY_HEADERS).map((k) => [k, res.headers.get(k)]));
}

beforeAll(async () => {
  await seedDashboard(env);
});

describe("the security headers", () => {
  // A sample of every kind of route: pages, a page with a parameter, the API (a read, a write refused, a 404), redirects, the scripts, an icon, the kit's sheet, robots, a preflight, and the 404 page.
  const SAMPLE: [string, RequestInit?, string?][] = [
    ["/"], ["/packages"], ["/docs"], ["/status"], ["/review"], ["/package/zlib"], ["/user/alice"], ["/build/9"], ["/worker/w1"],
    ["/api/v1/version"], ["/api/v1/stats"], ["/api/v1/packages?q=zlib"], ["/api/v1/releases", { method: "POST" }], ["/api/v1/nope"],
    ["/api/v1/version", { method: "OPTIONS" }], ["/journal"], ["/index.html"], ["/me"], ["/setup"], ["/omarchy-worker"], ["/robots.txt"], ["/favicon.svg"],
    ["/nope"], ["/", {}, `https://${LEGACY_DASHBOARD_HOSTS[0]}`],
  ];

  it("are on every answer of the sample", async () => {
    for (const [path, init, origin] of SAMPLE) {
      const res = await call(path, init, origin);
      const got = headersOf(res);
      const name = `${init?.method ?? "GET"} ${origin ?? ""}${path} (${res.status})`;
      expect.soft(got, name).toMatchObject(EXPECTED);
      expect.soft(got["content-security-policy-report-only"], name).toBe(CSP_REPORT_ONLY);
      expect.soft(got["permissions-policy"], name).toBe(SECURITY_HEADERS["permissions-policy"]);
    }
  });

  it("keep passkeys allowed on the site's own origin and turn off what the site never uses", () => {
    const policy = SECURITY_HEADERS["permissions-policy"].split(", ");
    expect(policy).toContain("publickey-credentials-get=(self)");
    expect(policy).toContain("publickey-credentials-create=(self)");
    for (const off of ["camera=()", "microphone=()", "geolocation=()"]) expect(policy).toContain(off);
  });

  it("name the site's own origin and Google Fonts in the Report-Only CSP, and never frame-ancestors (ignored there)", () => {
    expect(CSP_REPORT_ONLY).toContain("default-src 'self'");
    expect(CSP_REPORT_ONLY).toContain("object-src 'none'");
    expect(CSP_REPORT_ONLY).toContain("https://fonts.googleapis.com");
    expect(CSP_REPORT_ONLY).toContain("https://fonts.gstatic.com");
    expect(CSP_REPORT_ONLY).not.toContain("frame-ancestors");
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
