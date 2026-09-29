/**
 * Approve and block as the web decides them since #271, for the tests —
 * and the fixture — that need one decided on their way to what they test:
 * the maintainer's browser session on the relying party's address
 * (localhost: pool.test, the other tests' address, is not one), a passkey of
 * theirs made by the software authenticator (soft-authenticator.mjs) and
 * registered the first time as their page registers it — the first
 * passkey is the session's alone — and its answer to the pool's challenge
 * for exactly this act, in the body as the page's script puts it. The
 * refusals themselves, and what a decision says about its passkey, are
 * passkey-decisions.test.ts's.
 *
 * A login the pool will not give a challenge (not a maintainer, say) posts
 * without an answer, so the act's own refusal is what the test reads — the
 * predicate refuses before the passkey is asked for.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/index";
import worker from "../src/index";
import { assert, createAuthenticator, register } from "./soft-authenticator.mjs";

/** The address a passkey works on in the tests (routes/passkeys.ts relyingParty): localhost, as wrangler dev's. */
export const WEB = "http://localhost:8787";

type Authenticator = Awaited<ReturnType<typeof createAuthenticator>>;

/** The act a path decides, as the door binds its challenge: approve:<task>, block:package:<name>, block:contributor:<login>. */
export function subjectOf(path: string): string {
  const p = path.replace(/^\/api\/v1/, "");
  const approve = /^\/factory\/tasks\/(\d+)\/approve$/.exec(p);
  if (approve) return `approve:${Number(approve[1])}`;
  const block = /^\/factory\/(packages|contributors)\/([^/]+)\/block$/.exec(p);
  if (block) return `block:${block[1] === "packages" ? "package" : "contributor"}:${block[2]}`;
  throw new Error(`decide: ${path} is neither an approval nor a block`);
}

/**
 * The passkeys made here, by database and login: the fixture's decider and
 * a test's own, on the same database, answer with the same key — a login's
 * second passkey would need its first to vouch for it (#271).
 */
const KEYS = new WeakMap<object, Map<string, { a: Authenticator; id: string }>>();

/**
 * A decider for one database: `decide(login, path, body)` posts the act as
 * the login's page does, and answers what the door answered — through `on`
 * when a test watches the statements (an env whose D1 it traces). Each
 * login's passkey is made and registered at its first decision, and answers
 * every later one while the database still holds it (`passkeyOf` hands it
 * to a test that reads its id).
 */
export function decider(env: Env) {
  if (!KEYS.has(env.DB)) KEYS.set(env.DB, new Map());
  const keys = KEYS.get(env.DB)!;
  const post = async (login: string, path: string, body: unknown, on: Env = env) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(WEB + path, { method: "POST", headers: { cookie: `omc=oms_${login}`, origin: WEB, "content-type": "application/json" }, body: JSON.stringify(body) }), on, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  async function passkeyOf(login: string): Promise<{ a: Authenticator; id: string } | null> {
    const known = keys.get(login);
    if (known && (await env.DB.prepare("SELECT 1 AS one FROM passkeys WHERE id = ?").bind(known.id).first())) return known;
    const a = await createAuthenticator();
    const opts = await post(login, "/auth/passkeys/challenge", {});
    if (opts.status !== 200) return null;
    const reg = await post(login, "/auth/passkeys", { label: "laptop", ...(await register(a, { challenge: opts.json.publicKey.challenge, origin: WEB, rpId: "localhost" })) });
    if (reg.status !== 201) throw new Error(`decide: ${login}'s passkey was not registered: ${reg.status} ${JSON.stringify(reg.json)}`);
    const k = { a, id: reg.json.passkey.id as string };
    keys.set(login, k);
    return k;
  }
  async function decide(login: string, path: string, body: Record<string, unknown> = {}, on: Env = env): Promise<{ status: number; json: any }> {
    const api = path.startsWith("/api/v1/") ? path : `/api/v1${path}`;
    const key = await passkeyOf(login);
    const opts = key ? await post(login, "/auth/passkeys/assert", { for: subjectOf(path) }) : null;
    const assertion = opts?.status === 200 ? await assert(key!.a, { challenge: opts.json.publicKey.challenge, origin: WEB, rpId: "localhost" }) : undefined;
    return post(login, api, { ...body, ...(assertion ? { assertion } : {}) }, on);
  }
  return { decide, passkeyOf };
}
