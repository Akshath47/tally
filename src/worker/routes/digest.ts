import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { readDigest } from "../digest/content";
import { deliverDigest, settleLatestSend } from "../digest/send";

// The weekly digest (docs/phase-2-insights-spec.md). The preview is the email's content, live.
export const digestRoutes = new Hono<AppEnv>().get("/preview", async (c) => c.json(await readDigest(c.env.DB, new Date())))
  // By hand: for the acceptance check and re-sending a failed week. Never claims a week.
  .post("/send", async (c) => {
    const now = new Date();
    const result = await deliverDigest(c.env, now, "manual");
    if (!result.ok) return c.json({ error: "send_failed" }, 502);
    await settleLatestSend(c.env.DB, now);
    return c.json({ ok: true });
  });
