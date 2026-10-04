import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { cursorParam, listTransactions } from "../budget/listing";
import { limitParam, parseQuery } from "./query";

const querySchema = z.object({
  account_id: z.coerce.number().int().positive().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: limitParam(200, 50),
  cursor: cursorParam.optional(),
});

/** Newest first. An account filter can use the (account_id, txn_date) index. */
export const transactionRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const q = parseQuery(c, querySchema);
  if (!q.ok) return q.res;
  const { account_id, from, to, limit, cursor } = q.data;

  const where: string[] = [];
  const binds: unknown[] = [];
  const filter = (condition: string, value: unknown) => {
    where.push(condition);
    binds.push(value);
  };
  if (account_id !== undefined) filter("t.account_id = ?", account_id);
  if (from) filter("t.txn_date >= ?", from);
  if (to) filter("t.txn_date <= ?", to);

  const { transactions, nextCursor } = await listTransactions(c.env.DB, { where, binds, limit, cursor });
  return c.json({ transactions, nextCursor });
});
