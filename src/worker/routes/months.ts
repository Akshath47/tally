import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { effectiveAllocationSql } from "../budget/effective";
import { NAMED_LINES, type NamedLine } from "../budget/lines";
import { cursorParam, listTransactions } from "../budget/listing";
import { COUNTS, COUNTS_UNLESS_EXCLUDED, IN_MONTH, inMonthBinds } from "../budget/resolve";
import { readMonthSummary } from "../budget/summary";
import { isYm, londonMonth } from "../importer/dates";
import { limitParam, parseQuery } from "./query";

/** The `:month` path parameter, or null unless it's a YYYY-MM no later than `current`. */
function monthParam(c: Context, current: string): string | null {
  const month = c.req.param("month");
  // YYYY-MM strings compare in calendar order.
  return month !== undefined && isYm(month) && month <= current ? month : null;
}

// Home's named lines (src/web/lines.ts) beyond a single category, each `[sql, ...binds]` on
// `resolved r` joined to `categories c`, among the rows COUNTS keeps. Budget spend is budgeted
// or uncategorised (tracked isn't). The Posted and Pending pills split it. Uncategorised pending
// charges can't be filed until they post, so they're a line of their own. Misc is the
// unallocated pot: posted uncategorised money out, plus budgeted categories with no allocation in
// the month (archived ones have none: readBudget leaves them out).
const BUDGET_SPEND = "(r.category_id IS NULL OR c.kind = 'budgeted')";
const LINES = {
  posted: () => [`(${BUDGET_SPEND} AND r.is_pending = 0)`],
  pending: () => [`(${BUDGET_SPEND} AND r.is_pending = 1)`],
  "uncategorised-pending": () => ["(r.category_id IS NULL AND r.is_pending = 1)"],
  misc: (month: string) => [
    `((r.category_id IS NULL AND r.is_pending = 0) OR (c.kind = 'budgeted'
      AND (c.archived_at IS NOT NULL OR COALESCE(${effectiveAllocationSql("r.category_id", "?")}, 0) = 0)))`,
    month,
  ],
} satisfies Record<NamedLine, (month: string) => [string, ...unknown[]]>;

// A category's own line lists its excluded rows too.
const CATEGORY_LINE = `${COUNTS_UNLESS_EXCLUDED} AND r.category_id = ?`;

const lineQuery = z.object({
  category: z.union([z.enum(NAMED_LINES), z.coerce.number().int().positive()]),
  limit: limitParam(200, 100),
  cursor: cursorParam.optional(),
});

export const monthRoutes = new Hono<AppEnv>().get("/:month/summary", async (c) => {
  const now = new Date();
  const month = monthParam(c, londonMonth(now));
  if (month === null) return c.json({ error: "bad_request" }, 400);
  return c.json(await readMonthSummary(c.env.DB, month, now));
})
  /**
   * The rows behind one Home line: those that count in the month (by counted date) in a
   * category or in one of the named lines (LINES). A budgeted or tracked category also lists its
   * excluded rows, which don't count but would otherwise only be findable in Transactions.
   * Newest first by bank date, keyset-paged like /api/transactions.
   */
  .get("/:month/transactions", async (c) => {
    const month = monthParam(c, londonMonth(new Date()));
    const q = parseQuery(c, lineQuery);
    if (month === null || !q.ok) return c.json({ error: "bad_request" }, 400);
    const { category, limit, cursor } = q.data;

    const line: [string, ...unknown[]][] = typeof category === "number" ? [[CATEGORY_LINE, category]] : [[COUNTS], LINES[category](month)];
    const { transactions, nextCursor } = await listTransactions(c.env.DB, {
      where: [[IN_MONTH, ...inMonthBinds(month)], ["r.vanished_at IS NULL"], ...line],
      limit,
      cursor,
      withCategory: true,
    });
    return c.json({ transactions, nextCursor });
  });
