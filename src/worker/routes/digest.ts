import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { readDigest } from "../digest/content";

// The weekly digest (docs/phase-2-insights-spec.md). The preview is the email's content, live.
export const digestRoutes = new Hono<AppEnv>().get("/preview", async (c) => c.json(await readDigest(c.env.DB, new Date())));
