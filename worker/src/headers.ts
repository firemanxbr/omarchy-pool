/**
 * The security headers every answer of the Worker carries (#300): pages,
 * the API, redirects, scripts, icons and the pool's fallback alike. index.ts
 * puts them on at the one exit of fetch(), so no route can forget them.
 *
 * A header a route already set is kept: personal() in routes/agents.ts sends
 * `referrer-policy: same-origin` on the agent-grant and confirm pages, which
 * is stricter than the default here, and it stays.
 *
 * - HSTS: a year, subdomains included. Every name the Worker, the docs and
 *   the wrangler routes use is https (the zones' Always Use HTTPS, runbook
 *   "Response headers"); no preload.
 * - Framing: X-Frame-Options and an enforced CSP of `frame-ancestors 'none'`
 *   alone — frame-ancestors is ignored in a Report-Only policy.
 * - Permissions-Policy: off what the site never asks for; passkeys
 *   (publickey-credentials-get/-create) stay allowed on the site's own origin.
 * - CSP_REPORT_ONLY: the policy the site already meets, reported and not
 *   enforced; the runbook's "Response headers" has the plan and the date to
 *   enforce it.
 */
export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "content-security-policy-report-only": CSP_REPORT_ONLY,
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
};

/** The answer with the security headers added where it has none of its own. A copy: a redirect's or a fetched answer's headers cannot be changed in place. */
export function secured(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(name)) out.headers.set(name, value);
  return out;
}
