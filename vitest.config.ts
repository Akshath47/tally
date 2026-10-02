import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The same SQL files `wrangler d1 migrations apply` runs, so tests see the real schema.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests must never see the real key from .dev.vars or reach Lunch Flow.
      miniflare: { bindings: { LUNCHFLOW_API_KEY: "test-key" } },
    }),
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    // Passed via provide/inject rather than a binding, so the Worker's env stays production-shaped.
    provide: { migrations },
  },
});
