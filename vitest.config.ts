import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests must never see the real key from .dev.vars or reach Lunch Flow.
      miniflare: { bindings: { LUNCHFLOW_API_KEY: "test-key" } },
    }),
  ],
  test: { include: ["test/**/*.spec.ts"] },
});
