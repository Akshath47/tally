import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("tests run with a dummy Lunch Flow key, never the real one", () => {
  expect(env.LUNCHFLOW_API_KEY).toBe("test-key");
});

it("tests run with synthetic Access settings, never the real ones", () => {
  expect(env.ACCESS_TEAM_DOMAIN).toBe("https://test-team.cloudflareaccess.com");
  expect(env.ACCESS_AUD).toBe("test-aud");
  expect(env.ALLOWED_EMAIL).toBe("owner@example.com");
});

// The Vitest integration always loads .dev.vars and has no switch to skip it, so a secret
// added there later would silently reach test code. Compares names only, never values.
it("exposes only known bindings, so new .dev.vars entries can't leak into tests", () => {
  const names = Object.keys(env).filter((name) => !name.startsWith("__VITEST_POOL_WORKERS_"));
  expect(names.sort()).toEqual(["ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "ALLOWED_EMAIL", "BACKFILL_DAYS", "DB", "LUNCHFLOW_API_KEY"]);
});
