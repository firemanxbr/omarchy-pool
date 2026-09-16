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
    test: { setupFiles: ["./test/setup.ts"], testTimeout: 30_000 },
  };
});
