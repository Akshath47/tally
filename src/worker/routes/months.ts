import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { effectiveAllocationSql, readBudget, sumAllocated } from "../budget/effective";
import { NAMED_LINES, type NamedLine } from "../budget/lines";
import { cursorParam, listTransactions } from "../budget/listing";
import { COUNTS, COUNTS_UNLESS_EXCLUDED, INBOX, IN_MONTH, RESOLVED_CTE, inMonthBinds } from "../budget/resolve";
import { daysInMonth, isYm, londonMonth, londonToday } from "../importer/dates";
import { limitParam, parseQuery } from "./query";

// Everything the home screen needs for one month (docs/phase-2-spec.md, "What a transaction
// counts as" and "Budget figures for a month"). Spend is positive = money out, so a refund is
// negative spend. Aggregation is in SQL: four statements, each reading only the month's rows,
// the transactions still to sort, or a handful of budget and account rows.

// One row per category_id among the counted rows (vanished_at IS NULL) that count in the month
// (of counted_date ?? txn_date). Binds: inMonthBinds(month).
const MONTH_SQL = `WITH ${RESOLVED_CTE}
SELECT r.category_id, c.kind,
  sum(-COALESCE(r.counted_amount_minor, r.amount_minor)) AS spent,
  COALESCE(sum(CASE WHEN r.is_pending = 1 THEN -COALESCE(r.counted_amount_minor, r.amount_minor) END), 0) AS pending
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE r.vanished_at IS NULL AND ${IN_MONTH} AND ${COUNTS}
GROUP BY r.category_id`;

// The inbox spans every month.
const INBOX_COUNT_SQL = `WITH ${RESOLVED_CTE} SELECT count(*) AS n FROM resolved r WHERE ${INBOX}`;

type Group = { category_id: number | null; kind: string | null; spent: number; pending: number };
type Line = { categoryId: number | null; kind: string | null; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number };

/** Integer division, so the per-week figure is floored exactly. */
const perWeek = (leftMinor: number, daysRemaining: number) =>
  leftMinor > 0 ? Number((BigInt(leftMinor) * 7n) / BigInt(daysRemaining)) : 0;

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
  const current = londonMonth(now);
  const month = monthParam(c, current);
  if (month === null) return c.json({ error: "bad_request" }, 400);

  const db = c.env.DB;
  const [budget, groups, inbox, freshness] = await Promise.all([
    readBudget(db, month),
    db.prepare(MONTH_SQL).bind(...inMonthBinds(month)).all<Group>(),
    db.prepare(INBOX_COUNT_SQL).first<{ n: number }>(),
    db.prepare("SELECT max(last_data_change_at) AS at FROM accounts WHERE import_enabled = 1").first<{ at: string | null }>(),
  ]);

  // Every category with a counting row this month, or an allocation above 0.
  const lines = new Map<number | null, Line>();
  for (const g of groups.results) {
    lines.set(g.category_id, { categoryId: g.category_id, kind: g.kind, spentMinor: g.spent, pendingSpentMinor: g.pending, allocatedMinor: 0 });
  }
  for (const a of budget.allocations) {
    if (a.allocatedMinor === 0) continue;
    const existing = lines.get(a.categoryId);
    if (existing) existing.allocatedMinor = a.allocatedMinor;
    else lines.set(a.categoryId, { categoryId: a.categoryId, kind: "budgeted", spentMinor: 0, pendingSpentMinor: 0, allocatedMinor: a.allocatedMinor });
  }
  const categories = [...lines.values()].sort((x, y) => (x.categoryId ?? Infinity) - (y.categoryId ?? Infinity));

  // Lines are budgeted, tracked or Uncategorised (COUNTS drops the rest); all but tracked are budget spend.
  let spentMinor = 0;
  let pendingSpentMinor = 0;
  let trackedMinor = 0;
  for (const l of categories) {
    if (l.kind === "tracked") trackedMinor += l.spentMinor;
    else {
      spentMinor += l.spentMinor;
      pendingSpentMinor += l.pendingSpentMinor;
    }
  }

  const { overallMinor } = budget;
  const allocatedMinor = sumAllocated(budget);
  const leftMinor = overallMinor === null ? null : overallMinor - spentMinor;
  // Pacing is for the current month only; today counts as a day remaining.
  const daysRemaining = month === current ? daysInMonth(month) - Number(londonToday(now).slice(8)) + 1 : null;

  return c.json({
    month,
    overallMinor,
    allocatedMinor,
    miscMinor: overallMinor === null ? null : overallMinor - allocatedMinor,
    spentMinor,
    pendingSpentMinor,
    leftMinor,
    daysRemaining,
    perWeekMinor: daysRemaining === null || leftMinor === null ? null : perWeek(leftMinor, daysRemaining),
    categories,
    trackedMinor,
    inboxCount: inbox?.n ?? 0,
    lastDataChangeAt: freshness?.at ?? null,
  });
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
