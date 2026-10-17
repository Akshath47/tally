import { daysInMonth, londonMonth, londonToday } from "../importer/dates";
import { readBudget, sumAllocated } from "./effective";
import { COUNTS, INBOX, IN_MONTH, RESOLVED_CTE, inMonthBinds } from "./resolve";
import { ENABLED_FRESHNESS_SQL, latestChange, staleIds, type AccountFreshness } from "./stale";

// Everything the home screen needs for one month (docs/phase-2-spec.md, "What a transaction
// counts as" and "Budget figures for a month"). Spend is positive = money out, so a refund is
// negative spend. Aggregation is in SQL: four statements, each reading only the month's rows,
// the transactions still to sort, or a handful of budget and account rows. The summary route and
// the weekly digest share it.

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
export type SummaryLine = { categoryId: number | null; kind: string | null; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number };

/** Integer division, so the per-week figure is floored exactly. */
const perWeek = (leftMinor: number, daysRemaining: number) =>
  leftMinor > 0 ? Number((BigInt(leftMinor) * 7n) / BigInt(daysRemaining)) : 0;

/** The month summary for `month` (no later than the current London month at `now`). */
export async function readMonthSummary(db: D1Database, month: string, now: Date) {
  const current = londonMonth(now);
  const [budget, groups, inbox, freshness] = await Promise.all([
    readBudget(db, month),
    db.prepare(MONTH_SQL).bind(...inMonthBinds(month)).all<Group>(),
    db.prepare(INBOX_COUNT_SQL).first<{ n: number }>(),
    db.prepare(ENABLED_FRESHNESS_SQL).all<AccountFreshness>(),
  ]);

  // Every category with a counting row this month, or an allocation above 0.
  const lines = new Map<number | null, SummaryLine>();
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

  return {
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
    lastDataChangeAt: latestChange(freshness.results),
    // Stale warnings are about now, so only the current month carries them.
    staleAccountIds: month === current ? staleIds(freshness.results, now) : [],
  };
}

export type MonthSummary = Awaited<ReturnType<typeof readMonthSummary>>;
