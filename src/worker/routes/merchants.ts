import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { readMerchant } from "../analytics/merchant";
import { parseQuery } from "./query";

// Keys come from the API's own responses (merchantKey); one that matches nothing is a 404.
const merchantQuery = z.object({ key: z.string().min(1).max(200) });

export const merchantRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const q = parseQuery(c, merchantQuery);
  if (!q.ok) return q.res;
  const merchant = await readMerchant(c.env.DB, q.data.key, new Date());
  return merchant ? c.json(merchant) : c.json({ error: "not_found" }, 404);
});
