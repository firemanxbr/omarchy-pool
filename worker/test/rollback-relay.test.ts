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
 * With it go the maintainers' co-signatures over the statement (#330): a
 * maintainer's token hands one in (PUT .../cosignature, what
 * factory/bin/co-sign rollback sends), kept under the statement's SHA-256
 * and the maintainer's login, so a statement signed again never travels
 * with co-signatures over other bytes; the agent verifies each.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/routes/contributors";
import { cosignaturePrefix, MAX_COSIGNATURE, rollbackKeys } from "../src/routes/rollback";
import coSign from "../../factory/bin/co-sign?raw";
// The agent's fixture: Alice's security-key signature over a statement (crates/omarchy-agent/tests/fixtures/cosignature/).
import aliceStatementSignature from "../../crates/omarchy-agent/tests/fixtures/cosignature/statement.json.alice.sshsig?raw";
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
    expect(body).toEqual({ to: "v1.13.4", statement: STATEMENT, bundle: BUNDLE, cosignatures: {} });
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
    expect(securityModel).toContain("PUT /api/v1/factory/rollback/:to/cosignature");
    expect(securityModel).toContain("## Rollback statements");
    for (const fact of ["`seq`", "`to < floor ≤ retracts_through`", "`min_release`", "14 days", "rollback.yml@refs/heads/main", "GET /api/v1/factory/rollback/:to"]) {
      expect(securityModel, fact).toContain(fact);
    }
  });
});

describe("PUT /factory/rollback/:to/cosignature (#330)", () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO factory_maintainers (login) VALUES ('alice'), ('bob')"),
      env.DB.prepare("INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES ('alice', ?, ?, 'maintainer', 3001), ('bob', ?, ?, 'maintainer', 3002), ('carol', ?, ?, 'contributor', 3003)")
        .bind(await sha256Hex("omc_alice"), await sha256Hex("oms_alice"), await sha256Hex("omc_bob"), await sha256Hex("oms_bob"), await sha256Hex("omc_carol"), await sha256Hex("oms_carol")),
    ]);
  });
  const put = (to: string, token: string | null, body: string) =>
    get(`/factory/rollback/${to}/cosignature`, { method: "PUT", body, headers: { "content-type": "text/plain", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const SIG = aliceStatementSignature;

  it("takes a maintainer's co-signature of the stored statement and relays it beside it, under their login", async () => {
    const keys = rollbackKeys("v1.20.1");
    await env.PACKAGES.put(keys.statement, STATEMENT);
    await env.PACKAGES.put(keys.bundle, BUNDLE);
    expect((await put("v1.20.1", null, SIG)).status).toBe(401);
    expect((await put("v1.20.1", "omc_carol", SIG)).status).toBe(403);
    const res = await put("v1.20.1", "omc_alice", SIG);
    expect(res.status).toBe(200);
    const sha = await sha256Hex(STATEMENT);
    expect(await res.json()).toEqual({ to: "v1.20.1", login: "alice", statement_sha256: sha, relayed: "GET /api/v1/factory/rollback/v1.20.1" });
    expect(await (await env.PACKAGES.get(`${cosignaturePrefix("v1.20.1", sha)}alice.sshsig`))!.text()).toBe(SIG);
    // Bob's too; a second of Alice's replaces her first.
    expect((await put("v1.20.1", "omc_bob", SIG)).status).toBe(200);
    expect((await put("v1.20.1", "omc_alice", SIG)).status).toBe(200);
    const relayed = (await (await get("/factory/rollback/v1.20.1")).json()) as { statement: string; cosignatures: Record<string, string> };
    expect(relayed.statement).toBe(STATEMENT);
    expect(relayed.cosignatures).toEqual({ alice: SIG, bob: SIG });
    // On the record, by whom.
    const ev = await env.DB.prepare("SELECT kind, summary, payload FROM events WHERE kind = 'host' AND summary LIKE 'the rollback statement to v1.20.1%' ORDER BY id DESC LIMIT 1").first<{ summary: string; payload: string }>();
    expect(ev!.summary).toContain("co-signed by alice");
    expect(JSON.parse(ev!.payload)).toMatchObject({ action: "cosignature", to: "v1.20.1", login: "alice", statement_sha256: sha });
  });

  it("never relays a co-signature beside a statement signed again: it was over other bytes", async () => {
    const keys = rollbackKeys("v1.20.2");
    await env.PACKAGES.put(keys.statement, STATEMENT);
    await env.PACKAGES.put(keys.bundle, BUNDLE);
    expect((await put("v1.20.2", "omc_alice", SIG)).status).toBe(200);
    // rollback.yml runs again: a new seq, new bytes.
    await env.PACKAGES.put(keys.statement, STATEMENT.replace('"seq":4', '"seq":5'));
    const relayed = (await (await get("/factory/rollback/v1.20.2")).json()) as { cosignatures: Record<string, string> };
    expect(relayed.cosignatures).toEqual({});
  });

  it("refuses what is no armored SSH signature, an oversized one, a name that is no release, and a statement that is not there", async () => {
    const keys = rollbackKeys("v1.20.3");
    await env.PACKAGES.put(keys.statement, STATEMENT);
    await env.PACKAGES.put(keys.bundle, BUNDLE);
    for (const bad of ["", "not a signature", SIG.replace("-----END SSH SIGNATURE-----", ""), `-----BEGIN SSH SIGNATURE-----\n${"A".repeat(MAX_COSIGNATURE)}\n-----END SSH SIGNATURE-----\n`, `${SIG}<script>`]) {
      const res = await put("v1.20.3", "omc_alice", bad);
      expect(res.status, bad.slice(0, 40)).toBe(400);
    }
    expect((await put("latest", "omc_alice", SIG)).status).toBe(400);
    expect((await put("v9.9.8", "omc_alice", SIG)).status).toBe(404);
    expect((await (await get("/factory/rollback/v1.20.3")).json()) as unknown).toMatchObject({ cosignatures: {} });
  });

  it("is what factory/bin/co-sign rollback sends: the route, the token, the armored text", () => {
    expect(coSign).toContain('f"{api}/api/v1/factory/rollback/{v}/cosignature"');
    expect(coSign).toContain('method="PUT"');
    expect(coSign).toContain('"authorization": f"Bearer {token}"');
    expect(coSign).toContain('ROLLBACK_NAMESPACE = "rollback@omarchy-pool.org"');
  });
});
