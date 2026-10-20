import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { londonToday } from "../importer/dates";
import { readInsightInput } from "../insights/read";
import { buildInsights } from "../insights/rules";

export const insightRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const now = new Date();
  return c.json({ asOf: londonToday(now), items: buildInsights(await readInsightInput(c.env.DB, now)) });
});
