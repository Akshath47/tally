import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { readBudget, sumAllocated } from "../budget/effective";
import { INBOX, RESOLVED_CTE } from "../budget/resolve";
import { daysInMonth, isYm, londonMonth, londonToday } from "../importer/dates";

// Everything the home screen needs for one month (docs/phase-2-spec.md, "What a transaction
// counts as" and "Budget figures for a month"). Spend is positive = money out, so a refund is
// negative spend. Aggregation is in SQL: three statements, and one evaluation of RESOLVED_CTE.

// On `resolved r` joined to `categories c`: a counted row that isn't excluded counts when it's
// budgeted or tracked, or uncategorised money out. Uncategorised money in waits in the inbox.
// Always 0 or 1: a bare `c.kind IN (...)` is NULL for an uncategorised row.
const COUNTS = `(r.excluded = 0 AND (COALESCE(c.kind IN ('budgeted', 'tracked'), 0)
  OR (r.category_id IS NULL AND COALESCE(r.counted_amount_minor, r.amount_minor) < 0)))`;

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

export const monthRoutes = new Hono<AppEnv>().get("/:month/summary", async (c) => {
  const now = new Date();
  const current = londonMonth(now);
  const month = c.req.param("month");
  // YYYY-MM strings compare in calendar order.
  if (!isYm(month) || month > current) return c.json({ error: "bad_request" }, 400);

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
