import type { Context } from "hono";
import { z } from "zod";

export const limitParam = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);

/** Parses the query string, or returns the 400 response to send instead. */
export function parseQuery<T extends z.ZodType>(c: Context, schema: T): { ok: true; data: z.infer<T> } | { ok: false; res: Response } {
  const parsed = schema.safeParse(c.req.query());
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, res: c.json({ error: "bad_request" }, 400) };
}
