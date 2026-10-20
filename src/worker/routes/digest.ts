import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { readDigest } from "../digest/content";
import { deliverDigest } from "../digest/send";

// The weekly digest (docs/phase-2-insights-spec.md). The preview is the email's content, live.
export const digestRoutes = new Hono<AppEnv>().get("/preview", async (c) => c.json(await readDigest(c.env.DB, new Date())))
  // By hand: for the acceptance check and re-sending a failed week. Doesn't touch the weekly claim.
  .post("/send", async (c) => {
    const result = await deliverDigest(c.env, new Date(), "manual");
    return result.ok ? c.json({ ok: true }) : c.json({ error: "send_failed" }, 502);
  });
