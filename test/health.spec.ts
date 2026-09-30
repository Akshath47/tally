import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("API skeleton", () => {
  it("GET /api/health returns ok", async () => {
    const res = await exports.default.fetch("http://tally.test/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("unknown /api paths return JSON 404, not the SPA", async () => {
    const res = await exports.default.fetch("http://tally.test/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
