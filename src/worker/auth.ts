import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type AppEnv = { Bindings: Env; Variables: { email: string } };
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

/**
 * Second auth layer behind Cloudflare Access: verifies the Access JWT
 * (signature, issuer, audience, expiry) and that it belongs to ALLOWED_EMAIL.
 * 401 = not authenticated, 403 = authenticated as someone else.
 */
export function accessAuth(options: AuthOptions = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
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
