import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// End-to-end through the real Worker: without an Access token nothing is served.
describe("API without Access token", () => {
  it.each(["/api", "/api/health", "/api/nope"])("GET %s returns 401", async (path) => {
    const res = await exports.default.fetch(`https://tally.test${path}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("rejects cross-site form POSTs before auth (CSRF)", async () => {
    const res = await exports.default.fetch("https://tally.test/api/import-runs", {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(res.status).toBe(403);
  });
});
