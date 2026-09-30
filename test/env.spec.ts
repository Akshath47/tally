import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("tests run with a dummy Lunch Flow key, never the real one", () => {
  expect(env.LUNCHFLOW_API_KEY).toBe("test-key");
});
