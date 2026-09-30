import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { accessAuth, type AuthVariables } from "./auth";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>().basePath("/api");

app.use("*", secureHeaders());
// Rejects cross-site form/simple POSTs; JSON POSTs from other origins already fail CORS preflight.
app.use("*", csrf());
// Every /api route (including unknown ones) requires the owner's Access identity.
app.use("*", accessAuth());

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

export default {
  fetch: app.fetch,
  async scheduled(controller) {
    // The importer is wired in during P1.5/P1.7.
    console.log(JSON.stringify({ event: "cron", cron: controller.cron, action: "noop" }));
  },
} satisfies ExportedHandler<Env>;
