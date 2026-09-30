import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { accessAuth, type AuthVariables } from "../src/worker/auth";

const ORIGIN = "https://tally.test";
let trustedKey: CryptoKey;
let untrustedKey: CryptoKey;
let app: Hono<{ Bindings: Env; Variables: AuthVariables }>;

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

beforeAll(async () => {
  const trusted = await generateKeyPair("RS256");
  const untrusted = await generateKeyPair("RS256");
  trustedKey = trusted.privateKey;
  untrustedKey = untrusted.privateKey;
  const jwk: JWK = { ...(await exportJWK(trusted.publicKey)), kid: "test", alg: "RS256" };

  app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use("*", accessAuth({ keySet: createLocalJWKSet({ keys: [jwk] }) }));
  app.get("/whoami", (c) => c.json({ email: c.get("email") }));
});

describe("accessAuth", () => {
  it("accepts a valid Access token for the allowed email", async () => {
    const res = await get("/whoami", await token());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: env.ALLOWED_EMAIL });
  });

  it("rejects a request with no token (401)", async () => {
    expect((await get("/whoami")).status).toBe(401);
  });

  it("rejects a token signed by an untrusted key (401)", async () => {
    expect((await get("/whoami", await token({ key: untrustedKey }))).status).toBe(401);
  });

  it("rejects a token for a different Access application (401)", async () => {
    expect((await get("/whoami", await token({ aud: "another-app" }))).status).toBe(401);
  });

  it("rejects a token from a different Access team (401)", async () => {
    expect((await get("/whoami", await token({ iss: "https://evil.cloudflareaccess.com" }))).status).toBe(401);
  });

  it("rejects an expired token (401)", async () => {
    expect((await get("/whoami", await token({ exp: Math.floor(Date.now() / 1000) - 60 }))).status).toBe(401);
  });

  it("rejects a malformed token (401)", async () => {
    expect((await get("/whoami", "not.a.jwt")).status).toBe(401);
  });

  it("rejects a valid token for someone else (403)", async () => {
    expect((await get("/whoami", await token({ email: "someone@example.com" }))).status).toBe(403);
  });

  it("rejects a valid token without an email, e.g. a service token (403)", async () => {
    expect((await get("/whoami", await token({ email: null }))).status).toBe(403);
  });

  it("matches the allowed email case-insensitively", async () => {
    const res = await get("/whoami", await token({ email: env.ALLOWED_EMAIL.toUpperCase() }));
    expect(res.status).toBe(200);
  });

  it("does not apply the local-dev bypass outside localhost", async () => {
    expect((await get("/whoami", undefined, "http://tally.test")).status).toBe(401);
  });
});
