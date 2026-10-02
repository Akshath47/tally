import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/worker";
import { resetDb } from "./db";
import { world } from "./fixtures/lunchflow";

const ORIGIN = "https://tally.test";
let trustedKey: CryptoKey;
let untrustedKey: CryptoKey;
let localKeySet: JWTVerifyGetKey;
let app: ReturnType<typeof createApp>;

async function token(overrides: { aud?: string; iss?: string; email?: string | null; exp?: number; key?: CryptoKey } = {}) {
  const claims: Record<string, unknown> = { type: "app" };
  if (overrides.email !== null) claims.email = overrides.email ?? env.ALLOWED_EMAIL;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(overrides.iss ?? env.ACCESS_TEAM_DOMAIN)
    .setAudience(overrides.aud ?? env.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? Math.floor(Date.now() / 1000) + 600)
    .sign(overrides.key ?? trustedKey);
}

function get(path: string, jwt?: string, host = ORIGIN) {
  const headers: Record<string, string> = jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {};
  return app.request(`${host}${path}`, { headers }, env);
}

async function postJson(path: string, origin?: string) {
  const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await token(), "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return app.request(`${ORIGIN}${path}`, { method: "POST", headers, body: "{}" }, env);
}

beforeAll(async () => {
  const trusted = await generateKeyPair("RS256");
  const untrusted = await generateKeyPair("RS256");
  trustedKey = trusted.privateKey;
  untrustedKey = untrusted.privateKey;
  const jwk: JWK = { ...(await exportJWK(trusted.publicKey)), kid: "test", alg: "RS256" };

  localKeySet = createLocalJWKSet({ keys: [jwk] });
  app = createApp({ keySet: localKeySet });
});

describe("accessAuth", () => {
  it("accepts a valid Access token for the allowed email", async () => {
    const res = await get("/api/health", await token());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: env.ALLOWED_EMAIL });
  });

  it("rejects a request with no token (401)", async () => {
    expect((await get("/api/health")).status).toBe(401);
  });

  it("rejects a token signed by an untrusted key (401)", async () => {
    expect((await get("/api/health", await token({ key: untrustedKey }))).status).toBe(401);
  });

  it("rejects a token for a different Access application (401)", async () => {
    expect((await get("/api/health", await token({ aud: "another-app" }))).status).toBe(401);
  });

  it("rejects a token from a different Access team (401)", async () => {
    expect((await get("/api/health", await token({ iss: "https://evil.cloudflareaccess.com" }))).status).toBe(401);
  });

  it("rejects an expired token (401)", async () => {
    expect((await get("/api/health", await token({ exp: Math.floor(Date.now() / 1000) - 60 }))).status).toBe(401);
  });

  it("rejects a malformed token (401)", async () => {
    expect((await get("/api/health", "not.a.jwt")).status).toBe(401);
  });

  it("rejects a valid token for someone else (403)", async () => {
    expect((await get("/api/health", await token({ email: "someone@example.com" }))).status).toBe(403);
  });

  it("rejects a valid token without an email, e.g. a service token (403)", async () => {
    expect((await get("/api/health", await token({ email: null }))).status).toBe(403);
  });

  it("matches the allowed email case-insensitively", async () => {
    const res = await get("/api/health", await token({ email: env.ALLOWED_EMAIL.toUpperCase() }));
    expect(res.status).toBe(200);
  });

  // Vitest runs with import.meta.env.DEV = true, like `vite dev`.
  it.each(["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"])(
    "applies the local-dev bypass on %s",
    async (host) => {
      const res = await get("/api/health", undefined, host);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, email: env.ALLOWED_EMAIL });
    },
  );

  it("does not apply the local-dev bypass outside localhost", async () => {
    expect((await get("/api/health", undefined, "http://tally.test")).status).toBe(401);
  });
});

describe("API routes when authenticated", () => {
  it.each(["/api", "/api/nope"])("unknown path %s returns JSON 404", async (path) => {
    const res = await get(path, await token());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("rejects a JSON POST from another origin (403)", async () => {
    expect((await postJson("/api/import-runs", "https://evil.example")).status).toBe(403);
  });

  it("rejects a JSON POST without an Origin header (403)", async () => {
    expect((await postJson("/api/import-runs")).status).toBe(403);
  });

  it("lets a same-origin JSON POST through to routing", async () => {
    // An unknown path, so passing every check ends in the JSON 404 without starting a real import.
    expect((await postJson("/api/nope", ORIGIN)).status).toBe(404);
  });

  it("lets an authenticated same-origin JSON POST start an import", async () => {
    await resetDb();
    // A fake Lunch Flow with no accounts, so nothing leaves the test.
    const importApp = createApp({ keySet: localKeySet, importDeps: { fetch: world([]).fetch, sleep: async () => {} } });
    const headers = { "Cf-Access-Jwt-Assertion": await token(), "Content-Type": "application/json", Origin: ORIGIN };
    const ctx = createExecutionContext();
    const res = await importApp.request(`${ORIGIN}/api/import-runs`, { method: "POST", headers, body: "{}" }, env, ctx);
    expect(res.status).toBe(202);
    await waitOnExecutionContext(ctx);
  });
});
