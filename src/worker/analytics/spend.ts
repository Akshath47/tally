import { COUNTS, IN_DATES, RESOLVED_CTE, inDatesBinds } from "../budget/resolve";

// Spend by counted month and category: the figure every analytics view and insight is built
// from. The same rows the month summary counts (COUNTS), so the views always agree with Home.

const SPEND_SQL = `WITH ${RESOLVED_CTE}
SELECT substr(COALESCE(r.counted_date, r.txn_date), 1, 7) AS month, r.category_id AS categoryId, c.kind,
  sum(-COALESCE(r.counted_amount_minor, r.amount_minor)) AS spentMinor,
  COALESCE(sum(CASE WHEN r.is_pending = 1 THEN -COALESCE(r.counted_amount_minor, r.amount_minor) END), 0) AS pendingSpentMinor
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE r.vanished_at IS NULL AND ${IN_DATES} AND ${COUNTS}
GROUP BY month, r.category_id
ORDER BY month, r.category_id`;

export type SpendRow = { month: string; categoryId: number | null; kind: "budgeted" | "tracked" | null; spentMinor: number; pendingSpentMinor: number };

/** Spend counted from `from` to `to` (YYYY-MM-DD, inclusive), one row per month and category. One statement. */
export async function spendByMonth(db: D1Database, from: string, to: string): Promise<SpendRow[]> {
  const { results } = await db.prepare(SPEND_SQL).bind(...inDatesBinds(from, to)).all<SpendRow>();
  return results;
}

/** Budget spend (budgeted and uncategorised; tracked never counts) among `rows`. */
export const budgetSpend = (rows: SpendRow[]) => rows.reduce((sum, r) => (r.kind === "tracked" ? sum : sum + r.spentMinor), 0);

/** The pending part of budgetSpend. */
export const pendingBudgetSpend = (rows: SpendRow[]) => rows.reduce((sum, r) => (r.kind === "tracked" ? sum : sum + r.pendingSpentMinor), 0);

/** Tracked spend among `rows`. */
export const trackedSpend = (rows: SpendRow[]) => rows.reduce((sum, r) => (r.kind === "tracked" ? sum + r.spentMinor : sum), 0);

/** The month of the earliest transaction (one seek on transactions_txn_date_idx), or null with none. */
export async function firstDataMonth(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT substr(min(txn_date), 1, 7) AS month FROM transactions").first<{ month: string | null }>();
  return row?.month ?? null;
}
