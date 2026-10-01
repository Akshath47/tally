import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("API skeleton", () => {
  it("GET /api/health returns ok", async () => {
    const res = await exports.default.fetch("http://tally.test/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // Calls the Worker directly, so this covers Hono only. That /api and /api/* reach the
  // Worker instead of the SPA fallback is run_worker_first in wrangler.jsonc.
  it.each(["/api", "/api/nope"])("unknown path %s returns JSON 404", async (path) => {
    const res = await exports.default.fetch(`http://tally.test${path}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
