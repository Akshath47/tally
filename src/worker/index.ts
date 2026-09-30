import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.use("*", secureHeaders());

app.get("/health", (c) => c.json({ ok: true }));

// Unknown /api paths must not fall through to the SPA's index.html.
app.notFound((c) => c.json({ error: "not_found" }, 404));

// Never leak stack traces or provider responses to the client.
app.onError((err, c) => {
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
