import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("tests run with a dummy Lunch Flow key, never the real one", () => {
  expect(env.LUNCHFLOW_API_KEY).toBe("test-key");
});

// The Vitest integration always loads .dev.vars and has no switch to skip it, so a secret
// added there later would silently reach test code. Compares names only, never values.
it("exposes only known bindings, so new .dev.vars entries can't leak into tests", () => {
  const names = Object.keys(env).filter((name) => !name.startsWith("__VITEST_POOL_WORKERS_"));
  expect(names.sort()).toEqual(["DB", "LUNCHFLOW_API_KEY"]);
});
