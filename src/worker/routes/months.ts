import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { effectiveAllocationSql, readBudget, sumAllocated } from "../budget/effective";
import { cursorParam, listTransactions } from "../budget/listing";
import { COUNTS, INBOX, RESOLVED_CTE } from "../budget/resolve";
import { daysInMonth, isYm, londonMonth, londonToday } from "../importer/dates";
import { limitParam, parseQuery } from "./query";

// Everything the home screen needs for one month (docs/phase-2-spec.md, "What a transaction
// counts as" and "Budget figures for a month"). Spend is positive = money out, so a refund is
// negative spend. Aggregation is in SQL: three statements, and one evaluation of RESOLVED_CTE.

// One row per category_id among the counted rows (vanished_at IS NULL) that count in month ?1
// (of counted_date ?? txn_date) or are in the inbox. The inbox spans every month.
const SUMMARY_SQL = `WITH ${RESOLVED_CTE},
counted AS (
  SELECT r.category_id, c.kind, r.is_pending, (${INBOX}) AS in_inbox,
    -COALESCE(r.counted_amount_minor, r.amount_minor) AS spend,
    (substr(COALESCE(r.counted_date, r.txn_date), 1, 7) = ?1 AND ${COUNTS}) AS counts
  FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
  WHERE r.vanished_at IS NULL
)
SELECT category_id, kind, sum(counts) AS counting,
  COALESCE(sum(CASE WHEN counts THEN spend END), 0) AS spent,
  COALESCE(sum(CASE WHEN counts AND is_pending = 1 THEN spend END), 0) AS pending,
  sum(in_inbox) AS inbox
FROM counted WHERE counts OR in_inbox
GROUP BY category_id`;

type Group = { category_id: number | null; kind: string | null; counting: number; spent: number; pending: number; inbox: number };
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

// Misc on Home is the unallocated pot: uncategorised money out, plus budgeted categories with no
// allocation in the month. Archived ones have none (readBudget leaves them out). Tracked ones aren't
// budget spend. On `resolved r` joined to `categories c`, with one bind: the month.
const MISC = `(r.category_id IS NULL OR (c.kind = 'budgeted'
  AND (c.archived_at IS NOT NULL OR COALESCE(${effectiveAllocationSql("r.category_id", "?")}, 0) = 0)))`;

const lineQuery = z.object({
  category: z.union([z.literal("misc"), z.coerce.number().int().positive()]),
  limit: limitParam(200, 100),
  cursor: cursorParam.optional(),
});

export const monthRoutes = new Hono<AppEnv>()
  /**
   * The rows behind one Home line: those that count in the month (by counted date) in a
   * category, or in Misc. Newest first by bank date, keyset-paged like /api/transactions.
   */
  .get("/:month/transactions", async (c) => {
    const month = monthParam(c, londonMonth(new Date()));
    const q = parseQuery(c, lineQuery);
    if (month === null || !q.ok) return c.json({ error: "bad_request" }, 400);
    const { category, limit, cursor } = q.data;

    const { transactions, nextCursor } = await listTransactions(c.env.DB, {
      where: [
        ["substr(COALESCE(r.counted_date, r.txn_date), 1, 7) = ?", month],
        ["r.vanished_at IS NULL"],
        [COUNTS],
        category === "misc" ? [MISC, month] : ["r.category_id = ?", category],
      ],
      limit,
      cursor,
      withCategory: true,
    });
    return c.json({ transactions, nextCursor });
  })
  .get("/:month/summary", async (c) => {
    const now = new Date();
    const current = londonMonth(now);
    const month = monthParam(c, current);
    if (month === null) return c.json({ error: "bad_request" }, 400);

    const db = c.env.DB;
    const [budget, groups, freshness] = await Promise.all([
      readBudget(db, month),
      db.prepare(SUMMARY_SQL).bind(month).all<Group>(),
      db.prepare("SELECT max(last_data_change_at) AS at FROM accounts WHERE import_enabled = 1").first<{ at: string | null }>(),
    ]);

    // Every category with a counting row this month, or an allocation above 0.
    const lines = new Map<number | null, Line>();
    for (const g of groups.results) {
      if (g.counting === 0) continue;
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
      inboxCount: groups.results.reduce((n, g) => n + g.inbox, 0),
      lastDataChangeAt: freshness?.at ?? null,
    });
  });
