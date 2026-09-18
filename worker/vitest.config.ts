// The Worker's tests run inside workerd (Miniflare) with a real local D1
// and R2: the same code path production runs, with the migrations applied
// to an empty database before each test file (test/setup.ts). Nothing here
// reaches the network.
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            JOB_TOKEN_SECRET: "test-secret",
            POOL_URL: "http://pool.test",
            POOL_VERSION: "test",
            SOURCE_CHECK: "off",
          },
        },
      }),
    ],
    // A release test writes a few releases through a real D1 and took 5.8 s on
    // a slow hosted runner (2026-09-16, release v0.0.160's CI): the 5 s default
    // is a hosted runner's bad minute away from failing a release for nothing.
    // The same for the hooks: every file's beforeAll seeds the dashboard's
    // fixture — a package in every ring, the builds, the approvals, one pool job
    // of every kind — through the same D1, thirty-two files at once on a
    // two-core runner, and the 10 s default failed release v0.0.187's CI in
    // four files at 11:49 UTC (2026-09-18) after the run's own PRs had passed.
    test: { setupFiles: ["./test/setup.ts"], testTimeout: 30_000, hookTimeout: 60_000 },
  };
});
