/**
 * The rollback statement relay (#314, design v2 §5.3):
 *
 *   GET /factory/rollback/:to    the latest statement rollback.yml signed for going back to `to`, and its Sigstore bundle
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
 */
import { json, type Env } from "../index";

/** A release name as the agent reads one (crates/omarchy-agent version.rs): vX.Y.Z, no leading zero. */
const RELEASE_RE = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/**
 * Where release-rollback stores a statement in the PACKAGES bucket (omarchy-packages):
 * its statement_key and bundle_key, which worker/test/rollback-relay.test.ts holds to
 * this. `rollback/` is no source directory (r2.ts): a source holds `<arch>/`.
 */
export const rollbackKeys = (to: string) => ({ statement: `rollback/${to}.json`, bundle: `rollback/${to}.sigstore.json` });

const CACHE = { "cache-control": "public, max-age=60" };

export async function handleRollbackStatement(to: string, env: Env): Promise<Response> {
  if (!RELEASE_RE.test(to)) return json({ error: "a release name like v1.2.3 is required" }, 400);
  const keys = rollbackKeys(to);
  const [statement, bundle] = await Promise.all([env.PACKAGES.get(keys.statement), env.PACKAGES.get(keys.bundle)]);
  // Both or nothing: a statement is worthless to a host without its bundle, and a bundle without its statement verifies nothing.
  if (!statement || !bundle) return json({ error: `no rollback statement to ${to}` }, 404, CACHE);
  return json({ to, statement: await statement.text(), bundle: await bundle.text() }, 200, CACHE);
}
