import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { readTrends } from "../analytics/trends";

export const trendRoutes = new Hono<AppEnv>().get("/", async (c) => c.json(await readTrends(c.env.DB, new Date())));
