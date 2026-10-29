import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bearerMatches } from "../src/worker/auth";
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

describe("read-only API token", () => {
  const bearer = (value = env.API_TOKEN) => ({ Authorization: `Bearer ${value}` });

  function call(method: string, path: string, headers: Record<string, string>, workerEnv: Env = env) {
    return app.request(`${ORIGIN}${path}`, { method, headers }, workerEnv);
  }

  afterEach(() => vi.restoreAllMocks());

  it("authenticates as the owner, with no Access JWT", async () => {
    const res = await call("GET", "/api/health", bearer());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: env.ALLOWED_EMAIL });
  });

  it("returns a month summary", async () => {
    await resetDb();
    expect((await call("GET", "/api/months/2026-10/summary", bearer())).status).toBe(200);
  });

  it.each([
    "/api/months/2026-10/summary",
    "/api/months/2026-10/transactions",
    "/api/transactions",
    "/api/inbox",
    "/api/inbox/merchants",
    "/api/accounts",
    "/api/budget",
    "/api/categories",
    "/api/rules",
    "/api/health",
  ])("may read %s", async (path) => {
    await resetDb();
    expect((await call("GET", path, bearer())).status).not.toBe(403);
    expect((await call("HEAD", path, bearer())).status).not.toBe(403);
  });

  it.each(["/api/import-runs", "/api/trends", "/api/insights", "/api/merchants", "/api/nope", "/api", "/api/monthsx", "/api/budgets"])(
    "may not read %s (403)",
    async (path) => {
      const res = await call("GET", path, bearer());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    },
  );

  // Same-origin JSON, so the request gets past the Origin check and reaches auth.
  it.each([
    ["POST", "/api/import-runs"],
    ["POST", "/api/rules"],
    ["PATCH", "/api/categories/1"],
    ["PUT", "/api/budget/overall"],
    ["DELETE", "/api/rules/1"],
    ["PUT", "/api/transactions/1/override"],
    ["OPTIONS", "/api/health"],
  ])("may not %s %s (403)", async (method, path) => {
    const headers = { ...bearer(), Origin: ORIGIN, "Content-Type": "application/json" };
    const res = await app.request(`${ORIGIN}${path}`, { method, headers, body: method === "OPTIONS" ? undefined : "{}" }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it.each([
    ["a wrong token", bearer("wrong-token")],
    ["a token that only shares a prefix", bearer(`${env.API_TOKEN}x`)],
    ["a different scheme", { Authorization: `Basic ${env.API_TOKEN}` }],
    ["an empty bearer", { Authorization: "Bearer " }],
  ])("treats %s like no token (401)", async (_, headers) => {
    const res = await call("GET", "/api/health", headers);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("never accepts a token while API_TOKEN is unset or empty", async () => {
    for (const API_TOKEN of [undefined, ""]) {
      const workerEnv = { ...env, API_TOKEN } as Env;
      expect((await call("GET", "/api/health", { Authorization: "Bearer " }, workerEnv)).status).toBe(401);
      expect((await call("GET", "/api/health", bearer("anything"), workerEnv)).status).toBe(401);
    }
  });

  it("leaves a valid Access login unaffected by a wrong token", async () => {
    const res = await call("GET", "/api/health", { ...bearer("wrong-token"), "Cf-Access-Jwt-Assertion": await token() });
    expect(res.status).toBe(200);
  });

  it("restricts a valid token even alongside a valid Access login", async () => {
    const headers = { ...bearer(), "Cf-Access-Jwt-Assertion": await token() };
    expect((await call("GET", "/api/import-runs", headers)).status).toBe(403);
  });

  // Vitest runs with import.meta.env.DEV = true; the token's limits still apply on localhost.
  it("restricts a valid token on localhost too", async () => {
    expect((await app.request("http://localhost/api/import-runs", { headers: bearer() }, env)).status).toBe(403);
  });

  it("compares fixed-length digests with a constant-time compare", async () => {
    const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");
    expect(await bearerMatches(`Bearer ${env.API_TOKEN}`, env.API_TOKEN)).toBe(true);
    expect(await bearerMatches("Bearer short", env.API_TOKEN)).toBe(false);
    expect(compare).toHaveBeenCalledTimes(2);
    for (const [a, b] of compare.mock.calls) {
      expect((a as ArrayBuffer).byteLength).toBe(32);
      expect((b as ArrayBuffer).byteLength).toBe(32);
    }
  });

  it("keeps the token out of logs and response bodies", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const responses = await Promise.all([
      call("GET", "/api/health", bearer()),
      call("GET", "/api/import-runs", bearer()),
      call("GET", "/api/health", bearer(`${env.API_TOKEN}x`)),
    ]);
    for (const res of responses) expect(await res.text()).not.toContain(env.API_TOKEN);
    for (const log of logs) for (const args of log.mock.calls) expect(JSON.stringify(args)).not.toContain(env.API_TOKEN);
  });
});
