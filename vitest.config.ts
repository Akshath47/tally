import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The same SQL files `wrangler d1 migrations apply` runs, so tests see the real schema.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests must never see the real values from .dev.vars or reach Lunch Flow.
      miniflare: {
        bindings: {
          LUNCHFLOW_API_KEY: "test-key",
          ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-aud",
          ALLOWED_EMAIL: "owner@example.com",
          DIGEST_FROM: "tally@example.com",
          APP_URL: "https://tally.example.workers.dev",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    // Passed via provide/inject rather than a binding, so the Worker's env stays production-shaped.
    provide: { migrations },
  },
});
