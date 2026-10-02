import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { limitParam, parseQuery } from "./query";

// Opaque to the client: the (txn_date, id) of the last row served, for keyset paging.
const cursorParam = z
  .string()
  .regex(/^[^_]+_[1-9]\d*$/)
  .transform((s) => {
    const [date, id] = s.split("_");
    return { date: date!, id: Number(id) };
  })
  .pipe(z.object({ date: z.iso.date(), id: z.number().int() }));

const querySchema = z.object({
  account_id: z.coerce.number().int().positive().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: limitParam(200, 50),
  cursor: cursorParam.optional(),
});

type TxnRow = { id: number; txnDate: string; isPending: number } & Record<string, unknown>;

/** Newest first. The WHERE clause is built from present filters only, so the (account_id, txn_date) index stays usable. */
export const transactionRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const q = parseQuery(c, querySchema);
  if (!q.ok) return q.res;
  const { account_id, from, to, limit, cursor } = q.data;

  const where: string[] = [];
  const binds: unknown[] = [];
  /** Binds a value and returns its numbered placeholder. */
  const param = (value: unknown) => `?${binds.push(value)}`;
  if (account_id !== undefined) where.push(`account_id = ${param(account_id)}`);
  if (from) where.push(`txn_date >= ${param(from)}`);
  if (to) where.push(`txn_date <= ${param(to)}`);
  if (cursor) {
    const date = param(cursor.date);
    where.push(`(txn_date < ${date} OR (txn_date = ${date} AND id < ${param(cursor.id)}))`);
  }

  // One extra row tells us whether there is a next page.
  const { results } = await c.env.DB.prepare(
    `SELECT id, account_id AS accountId, amount_minor AS amountMinor, currency, txn_date AS txnDate,
       merchant, description, is_pending AS isPending, vanished_at AS vanishedAt, first_seen_at AS firstSeenAt
     FROM transactions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY txn_date DESC, id DESC LIMIT ${param(limit + 1)}`,
  )
    .bind(...binds)
    .all<TxnRow>();

  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({
    transactions: page.map((t) => ({ ...t, isPending: t.isPending === 1 })),
    nextCursor: results.length > limit && last ? `${last.txnDate}_${last.id}` : null,
  });
});
