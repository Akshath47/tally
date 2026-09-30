import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type AuthVariables = { email: string };

// One key set per isolate: jose caches Access's public keys and refetches on rotation.
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function accessKeySet(teamDomain: string): JWTVerifyGetKey {
  let keySet = remoteKeySets.get(teamDomain);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
    remoteKeySets.set(teamDomain, keySet);
  }
  return keySet;
}

function isLocalhost(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * Second auth layer behind Cloudflare Access: verifies the Access JWT
 * (signature, issuer, audience, expiry) and that it belongs to ALLOWED_EMAIL.
 * 401 = not authenticated, 403 = authenticated as someone else.
 */
export function accessAuth(options: { keySet?: JWTVerifyGetKey } = {}) {
  return createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
    // Local `vite dev` has no Access in front of it. `import.meta.env.DEV` is
    // statically false in production builds, so this branch is compiled out.
    if (import.meta.env.DEV && isLocalhost(c.req.url)) {
      c.set("email", c.env.ALLOWED_EMAIL);
      return next();
    }

    const jwt = c.req.header("Cf-Access-Jwt-Assertion");
    if (!jwt) return c.json({ error: "unauthenticated" }, 401);

    let email: unknown;
    try {
      const { payload } = await jwtVerify(jwt, options.keySet ?? accessKeySet(c.env.ACCESS_TEAM_DOMAIN), {
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
