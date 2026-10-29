import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** `machine` marks a request authenticated by the read-only API_TOKEN instead of an Access login. */
export type AppEnv = { Bindings: Env; Variables: { email: string; machine?: boolean } };
/** Tests pass a local key set; production fetches the Access team's keys. */
export type AuthOptions = { keySet?: JWTVerifyGetKey };

// One key set per isolate: jose caches Access's public keys and refetches on rotation.
let remoteKeySet: JWTVerifyGetKey | undefined;

// The Worker can't see the real client address under `vite dev`, so this alone isn't a
// security boundary; vite.config.ts refuses to expose the dev server beyond localhost.
function isLocalhost(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

// What the API_TOKEN may reach: reads only, and only these route groups (under /api). Anything
// not listed here, including routes added later, is forbidden to the token.
const MACHINE_METHODS = new Set(["GET", "HEAD"]);
const MACHINE_ROUTES = ["/months", "/transactions", "/inbox", "/accounts", "/budget", "/categories", "/rules", "/health"];

function machineMayAccess(method: string, path: string): boolean {
  if (!MACHINE_METHODS.has(method)) return false;
  return MACHINE_ROUTES.some((route) => path === `/api${route}` || path.startsWith(`/api${route}/`));
}

/**
 * Whether the request's `Authorization: Bearer` token equals API_TOKEN. Both sides are hashed first,
 * so the comparison sees two equal-length digests and takes the same time whatever the token is.
 * An unset or empty secret matches nothing.
 */
export async function bearerMatches(authorization: string | undefined, secret: string | undefined): Promise<boolean> {
  const presented = authorization?.match(/^Bearer +(\S+) *$/i)?.[1];
  if (!presented || !secret) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Second auth layer behind Cloudflare Access: verifies the Access JWT
 * (signature, issuer, audience, expiry) and that it belongs to ALLOWED_EMAIL.
 * 401 = not authenticated, 403 = authenticated as someone else.
 *
 * A scripted caller may instead send `Authorization: Bearer <API_TOKEN>` (it gets past the Access edge
 * with a service token). That grants only the reads in MACHINE_ROUTES; a token that doesn't match is
 * ignored, so the request is judged by its Access JWT exactly as if it carried no token.
 */
export function accessAuth(options: AuthOptions = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (await bearerMatches(c.req.header("Authorization"), c.env.API_TOKEN)) {
      if (!machineMayAccess(c.req.method, c.req.path)) return c.json({ error: "forbidden" }, 403);
      c.set("email", c.env.ALLOWED_EMAIL);
      c.set("machine", true);
      return next();
    }

    // Local `vite dev` has no Access in front of it. `import.meta.env.DEV` is
    // statically false in production builds, so this branch is compiled out.
    if (import.meta.env.DEV && isLocalhost(c.req.url)) {
      c.set("email", c.env.ALLOWED_EMAIL);
      return next();
    }

    const jwt = c.req.header("Cf-Access-Jwt-Assertion");
    if (!jwt) return c.json({ error: "unauthenticated" }, 401);

    const keySet =
      options.keySet ?? (remoteKeySet ??= createRemoteJWKSet(new URL("/cdn-cgi/access/certs", c.env.ACCESS_TEAM_DOMAIN)));

    let email: unknown;
    try {
      const { payload } = await jwtVerify(jwt, keySet, {
        issuer: c.env.ACCESS_TEAM_DOMAIN,
        audience: c.env.ACCESS_AUD,
        algorithms: ["RS256"],
      });
      email = payload.email;
    } catch {
      return c.json({ error: "unauthenticated" }, 401);
    }

    if (typeof email !== "string" || email.toLowerCase() !== c.env.ALLOWED_EMAIL.toLowerCase()) {
      return c.json({ error: "forbidden" }, 403);
    }

    c.set("email", email);
    await next();
  });
}
