/**
 * The rollback statement relay (#314, design v2 §5.3):
 *
 *   GET /factory/rollback/:to              the latest statement rollback.yml signed for going back to `to`, its Sigstore bundle, and the maintainers' co-signatures over it
 *   PUT /factory/rollback/:to/cosignature  a maintainer's co-signature of that statement (#330), relayed beside it
 *
 * factory/bin/release-rollback (run by rollback.yml, in the reviewed `pool`
 * environment) signs the statement keyless with `cosign sign-blob` and
 * stores both files in R2 once the Worker of `to` is deployed; this route
 * hands them out as stored. The pool relays a statement and cannot forge
 * one: a host's agent verifies the bundle against
 * rollback.yml@refs/heads/main (`omarchy-agent verify --statement`) and
 * applies its own acceptance rules (docs/security-model, *Rollback
 * statements*). `statement` is the exact signed bytes, as text, so the
 * agent writes it to a file unchanged; `bundle` is the bundle cosign wrote.
 * Public — a statement is a public Sigstore record already — and cached
 * briefly, the 404 too: a host asks again at its next round.
 *
 * The maintainers' co-signature (#330, design v2 D1 b, D25): a statement
 * that goes back more than 14 days is taken by a host only with the
 * signature of a maintainer's FIDO security key over its bytes (more, where
 * the agent pins a higher threshold), which `factory/bin/co-sign rollback`
 * makes offline once rollback.yml stored the statement, and hands here with
 * the maintainer's token. The pool keeps it under the statement's own
 * SHA-256, so a statement signed again (a re-run) never travels with
 * co-signatures over other bytes — and co-sign names the statement it signed
 * (`x-omarchy-statement-sha256`), so one that rollback.yml signed again
 * between the maintainer's fetch and the PUT is refused (409) rather than
 * kept beside bytes it is not over —, and relays every one as `cosignatures`
 * (login → the armored text). It verifies nothing: the agent checks each
 * against the keys its own build pins from factory/MAINTAINERS.toml, so a
 * pool can withhold a co-signature and never make one.
 */
import { json, type Env } from "../index";
import type { Contributor } from "./contributors";

/** A release name as the agent reads one (crates/omarchy-agent version.rs): vX.Y.Z, no leading zero. */
const RELEASE_RE = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/**
 * Where release-rollback stores a statement in the PACKAGES bucket (omarchy-packages):
 * its statement_key and bundle_key, which worker/test/rollback-relay.test.ts holds to
 * this. `rollback/` is no source directory (r2.ts): a source holds `<arch>/`.
 */
export const rollbackKeys = (to: string) => ({ statement: `rollback/${to}.json`, bundle: `rollback/${to}.sigstore.json` });

/** Where the maintainers' co-signatures of one statement are kept: under its SHA-256 (#330). */
export const cosignaturePrefix = (to: string, statementSha256: string) => `rollback/${to}.cosignatures/${statementSha256}/`;

/** `ssh-keygen -Y sign`'s output, and no more than the agent reads (crates/omarchy-agent sshsig.rs, MAX_ARMORED). */
const ARMORED = /^-----BEGIN SSH SIGNATURE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END SSH SIGNATURE-----\r?\n?$/;
export const MAX_COSIGNATURE = 8 * 1024;
/** No governance file lists more maintainers; the agent reads at most as many. */
const MAX_COSIGNATURES = 16;

const CACHE = { "cache-control": "public, max-age=60" };

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleRollbackStatement(to: string, env: Env): Promise<Response> {
  if (!RELEASE_RE.test(to)) return json({ error: "a release name like v1.2.3 is required" }, 400);
  const keys = rollbackKeys(to);
  const [statement, bundle] = await Promise.all([env.PACKAGES.get(keys.statement), env.PACKAGES.get(keys.bundle)]);
  // Both or nothing: a statement is worthless to a host without its bundle, and a bundle without its statement verifies nothing.
  if (!statement || !bundle) return json({ error: `no rollback statement to ${to}` }, 404, CACHE);
  const text = await statement.text();
  const prefix = cosignaturePrefix(to, await sha256Hex(text));
  const listed = await env.PACKAGES.list({ prefix, limit: MAX_COSIGNATURES });
  const cosignatures: Record<string, string> = {};
  for (const o of listed.objects) {
    const kept = await env.PACKAGES.get(o.key);
    if (kept) cosignatures[o.key.slice(prefix.length).replace(/\.sshsig$/, "")] = await kept.text();
  }
  return json({ to, statement: text, bundle: await bundle.text(), cosignatures }, 200, CACHE);
}

/** The header naming the statement a co-signature is over: its SHA-256, lowercase hex. */
export const STATEMENT_SHA256_HEADER = "x-omarchy-statement-sha256";

/**
 * A maintainer's co-signature of the statement stored for `to` (#330): the body is the
 * armored text `ssh-keygen -Y sign -n rollback@omarchy-pool.org` wrote, kept under the
 * caller's login (a second one replaces the first) and journaled. The statement it is over
 * is named by its SHA-256 (STATEMENT_SHA256_HEADER): another than the one stored now (a
 * re-run of rollback.yml since the maintainer fetched it) is 409, so a co-signature is never
 * relayed beside bytes it does not sign. A maintainer's token or session only; the
 * signature is checked by the hosts, not here.
 */
export async function handleRollbackCosignature(c: Contributor, to: string, request: Request, env: Env): Promise<Response> {
  if (!RELEASE_RE.test(to)) return json({ error: "a release name like v1.2.3 is required" }, 400);
  const named = request.headers.get(STATEMENT_SHA256_HEADER) ?? "";
  if (!/^[0-9a-f]{64}$/.test(named)) {
    return json({ error: `${STATEMENT_SHA256_HEADER}: the SHA-256 (hex) of the statement you co-signed is required (factory/bin/co-sign rollback sends it)` }, 400);
  }
  const statement = await env.PACKAGES.get(rollbackKeys(to).statement);
  if (!statement) return json({ error: `no rollback statement to ${to} to co-sign` }, 404);
  const body = await request.text();
  if (body.length > MAX_COSIGNATURE || !ARMORED.test(body)) {
    return json({ error: "the body is one armored SSH signature (ssh-keygen -Y sign's output), at most 8 KiB" }, 400);
  }
  const sha = await sha256Hex(await statement.text());
  if (sha !== named) {
    return json({ error: `the rollback statement to ${to} was signed again since you fetched it (sha256 ${sha}, not ${named}): run factory/bin/co-sign rollback ${to} again`, statement_sha256: sha }, 409);
  }
  await env.PACKAGES.put(`${cosignaturePrefix(to, sha)}${c.login}.sshsig`, body, { httpMetadata: { contentType: "text/plain" } });
  const summary = `the rollback statement to ${to} is co-signed by ${c.login}: relayed beside it, each host's agent checks it against the keys it pins (#330)`;
  await env.DB.prepare("INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('host', NULL, 'factory', 'ok', ?, ?)")
    .bind(summary, JSON.stringify({ action: "cosignature", to, login: c.login, statement_sha256: sha }))
    .run();
  return json({ to, login: c.login, statement_sha256: sha, relayed: `GET /api/v1/factory/rollback/${to}` });
}
