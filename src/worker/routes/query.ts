import type { Context } from "hono";
import { z } from "zod";

export const limitParam = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);

/** Parses the query string, or returns the 400 response to send instead. */
export function parseQuery<T extends z.ZodType>(c: Context, schema: T): { ok: true; data: z.infer<T> } | { ok: false; res: Response } {
  const parsed = schema.safeParse(c.req.query());
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, res: c.json({ error: "bad_request" }, 400) };
}

/** Parses a JSON body, or returns the 400 response to send instead (malformed JSON included). */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  const json: unknown = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, res: c.json({ error: "bad_request" }, 400) };
}

/** A positive integer path parameter, or null when it isn't one. */
export function idParam(c: Context, name = "id"): number | null {
  const parsed = z.coerce.number().int().positive().safeParse(c.req.param(name));
  return parsed.success ? parsed.data : null;
}
