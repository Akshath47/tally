import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { accessAuth, type AppEnv, type AuthOptions } from "./auth";
import { runImport } from "./importer";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApp(options: AuthOptions = {}) {
  const app = new Hono<AppEnv>().basePath("/api");

  app.use("*", secureHeaders());
  // Rejects cross-site form/simple POSTs; JSON POSTs from other origins already fail CORS preflight.
  app.use("*", csrf());
  // csrf() only looks at form-style content types, so every other state-changing
  // request must also carry this app's own Origin.
  app.use("*", async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && c.req.header("Origin") !== new URL(c.req.url).origin) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
  // Every /api route (including unknown ones) requires the owner's Access identity.
  app.use("*", accessAuth(options));

  app.get("/health", (c) => c.json({ ok: true, email: c.get("email") }));

  // Unknown /api paths must not fall through to the SPA's index.html.
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // Never leak stack traces or provider responses to the client.
  app.onError((err, c) => {
    // Deliberate HTTP errors (e.g. csrf's 403) keep their status.
    if (err instanceof HTTPException) return c.json({ error: "request_rejected" }, err.status);
    console.error(JSON.stringify({ event: "unhandled_error", name: err.name }));
    return c.json({ error: "internal" }, 500);
  });

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    // runImport records its own failures; it never throws for a provider or per-account error.
    ctx.waitUntil(runImport(env, "cron"));
  },
} satisfies ExportedHandler<Env>;
