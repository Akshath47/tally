import { and, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { transactions } from "../db/schema";
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

/**
 * Newest first. Only present filters go into the WHERE clause, so an account filter can use
 * the (account_id, txn_date) index. Unfiltered pages scan and sort the table, which is fine
 * at a few thousand rows.
 */
export const transactionRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const q = parseQuery(c, querySchema);
  if (!q.ok) return q.res;
  const { account_id, from, to, limit, cursor } = q.data;

  // One extra row tells us whether there is a next page.
  const rows = await drizzle(c.env.DB)
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      txnDate: transactions.txnDate,
      merchant: transactions.merchant,
      description: transactions.description,
      isPending: transactions.isPending,
      vanishedAt: transactions.vanishedAt,
      firstSeenAt: transactions.firstSeenAt,
    })
    .from(transactions)
    .where(
      and(
        account_id === undefined ? undefined : eq(transactions.accountId, account_id),
        from ? gte(transactions.txnDate, from) : undefined,
        to ? lte(transactions.txnDate, to) : undefined,
        cursor
          ? or(lt(transactions.txnDate, cursor.date), and(eq(transactions.txnDate, cursor.date), lt(transactions.id, cursor.id)))
          : undefined,
      ),
    )
    .orderBy(desc(transactions.txnDate), desc(transactions.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({
    transactions: page,
    nextCursor: rows.length > limit && last ? `${last.txnDate}_${last.id}` : null,
  });
});
