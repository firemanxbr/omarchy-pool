/**
 * The rollback statement relay (#314, design v2 §5.3): GET
 * /api/v1/factory/rollback/:to hands out, from R2, the statement and the
 * Sigstore bundle factory/bin/release-rollback stored for going back to
 * `to` — the statement's exact bytes, which the bundle signs — public and
 * cached briefly; 404 while there is none (or only half of one), 400 for a
 * name that is no release. The keys are the script's own (read from it
 * here), so what rollback.yml stores is what the pool relays. The pool
 * cannot forge a statement: that is the agent's verify, in
 * crates/omarchy-agent, and the acceptance rules security-model.md writes.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { rollbackKeys } from "../src/routes/rollback";
// The repository's own files, as text (Vite's ?raw): the tests run inside workerd, which has no filesystem.
import rollbackScript from "../../factory/bin/release-rollback?raw";
import securityModel from "../src/docs/security-model.md?raw";
import wranglerToml from "../wrangler.toml?raw";

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://pool.test/api/v1${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// The last statement stored, whatever its target, where release-rollback reads the next `seq` from: the route never serves it.
const LAST_STATEMENT_KEY = "rollback/latest.json";

// As release-rollback writes them: jq -c, one line, the newline included in the bytes signed.
const STATEMENT = '{"schema":1,"seq":4,"to":"v1.13.4","retracts_through":"v1.14.2","issued":"2026-10-20T14:00:00Z","agent_to":null,"run":"https://github.com/firemanxbr/omarchy-pool/actions/runs/123"}\n';
const BUNDLE = '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json","verificationMaterial":{},"messageSignature":{}}\n';

describe("GET /factory/rollback/:to (#314)", () => {
  it("relays the statement and its bundle as stored, public and cached briefly, with no credential", async () => {
    const keys = rollbackKeys("v1.13.4");
    await env.PACKAGES.put(keys.statement, STATEMENT);
    await env.PACKAGES.put(keys.bundle, BUNDLE);
    const res = await get("/factory/rollback/v1.13.4");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = (await res.json()) as { to: string; statement: string; bundle: string };
    expect(body).toEqual({ to: "v1.13.4", statement: STATEMENT, bundle: BUNDLE });
    // Byte for byte: the signature is over these bytes, newline and all.
    expect(new TextEncoder().encode(body.statement)).toEqual(new TextEncoder().encode(STATEMENT));
    // A token changes nothing: the answer is the same for everyone.
    const withToken = await get("/factory/rollback/v1.13.4", { headers: { authorization: "Bearer omw_nobody" } });
    expect(withToken.status).toBe(200);
  });

  it("answers 404 while there is no statement for that release, or only half of one", async () => {
    const none = await get("/factory/rollback/v9.9.9");
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: "no rollback statement to v9.9.9" });
    await env.PACKAGES.put(rollbackKeys("v2.0.0").statement, STATEMENT);
    expect((await get("/factory/rollback/v2.0.0")).status).toBe(404);
    await env.PACKAGES.put(rollbackKeys("v2.0.1").bundle, BUNDLE);
    expect((await get("/factory/rollback/v2.0.1")).status).toBe(404);
  });

  it("refuses a name that is no release, and serves no other key of the bucket", async () => {
    await env.PACKAGES.put(LAST_STATEMENT_KEY, STATEMENT);
    for (const bad of ["latest", "1.2.3", "v1.2", "v01.2.3", "v1.2.3-rc1", "v1.2.3.json", "..%2Fsecret"]) {
      const res = await get(`/factory/rollback/${bad}`);
      expect(res.status, bad).toBe(400);
    }
    expect((await get("/factory/rollback/v1.2.3/extra")).status).toBe(404);
    expect((await get("/factory/rollback/v1.2.3", { method: "POST" })).status).not.toBe(200);
  });

  it("reads the keys factory/bin/release-rollback writes, in the bucket the Worker binds as PACKAGES", () => {
    const k = rollbackKeys("$to");
    expect(rollbackScript).toContain(`statement_key="${k.statement}"; bundle_key="${k.bundle}"; last_key="${LAST_STATEMENT_KEY}"`);
    const bucket = /^R2_BUCKET=(\S+)$/m.exec(rollbackScript)?.[1];
    expect(bucket).toBeTruthy();
    expect(wranglerToml).toMatch(new RegExp(`binding = "PACKAGES"\\nbucket_name = "${bucket}"`));
  });

  it("is written down: the statement's format and the agent's acceptance rules in the security model", () => {
    expect(securityModel).toContain("## Rollback statements");
    for (const fact of ["`seq`", "`to < floor ≤ retracts_through`", "`min_release`", "14 days", "rollback.yml@refs/heads/main", "GET /api/v1/factory/rollback/:to"]) {
      expect(securityModel, fact).toContain(fact);
    }
  });
});
