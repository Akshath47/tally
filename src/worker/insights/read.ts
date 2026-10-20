import { OF_MERCHANT } from "../analytics/merchant";
import { firstDataMonth, spendByMonth, type SpendRow } from "../analytics/spend";
import { readBudget } from "../budget/effective";
import { COUNTS, IN_DATES, RESOLVED_CTE, inDatesBinds } from "../budget/resolve";
import { ENABLED_FRESHNESS_SQL, type AccountFreshness } from "../budget/stale";
import { addDays, addMonths, daysInMonth, londonToday } from "../importer/dates";
import type { Charge, InsightInput } from "./rules";
import * as T from "./thresholds";

// Reads what buildInsights needs: each figure seeks its own months or merchant.

const SPEND = "-COALESCE(r.counted_amount_minor, r.amount_minor)";
const COUNTED_DATE = "COALESCE(r.counted_date, r.txn_date)";

// Counting charges in the lookback window big enough to be a large_charge, biggest first.
// Binds: inDatesBinds(from, to), then the minimum.
const CANDIDATES_SQL = `WITH ${RESOLVED_CTE}
SELECT r.id AS transactionId, lower(trim(r.merchant)) AS merchantKey, r.merchant AS name, ${SPEND} AS spentMinor,
  ${COUNTED_DATE} AS countedDate, r.is_pending AS isPending
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE r.vanished_at IS NULL AND ${IN_DATES} AND ${COUNTS} AND ${SPEND} >= ?
ORDER BY spentMinor DESC, r.id
LIMIT ${T.LARGE_CHARGE_MAX_CANDIDATES}`;

// The merchant's counting charges before this one, back to the history window's start.
// Binds: merchant key, window start, the charge's date (twice), the charge's id.
const HISTORY_SQL = `WITH ${RESOLVED_CTE}
SELECT count(*) AS n, COALESCE(sum(${SPEND}), 0) AS spent
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE ${OF_MERCHANT} AND r.vanished_at IS NULL AND ${COUNTS} AND ${SPEND} > 0
  AND ${COUNTED_DATE} >= ? AND (${COUNTED_DATE} < ? OR (${COUNTED_DATE} = ? AND r.id < ?))`;

/** Day `day` of `month`, capped at the month's last day. */
const dayIn = (month: string, day: number) => `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;

export async function readInsightInput(db: D1Database, now: Date): Promise<InsightInput> {
  const today = londonToday(now);
  const month = today.slice(0, 7);
  const dom = Number(today.slice(8, 10));
  const previous = Array.from({ length: T.UNUSUAL_BASELINE_MONTHS }, (_, i) => addMonths(month, -(i + 1)));
  const [lastMonth, monthBefore] = [addMonths(month, -1), addMonths(month, -2)];

  const [budget, monthSpend, baselineRows, changeRows, candidates, accounts, first] = await Promise.all([
    readBudget(db, month),
    spendByMonth(db, `${month}-01`, `${month}-31`),
    Promise.all(previous.map((m) => spendByMonth(db, `${m}-01`, dayIn(m, dom)))),
    // Month changes only show in the first week, so the whole months are only read then.
    dom <= T.MONTH_CHANGE_SHOW_DAYS ? spendByMonth(db, `${monthBefore}-01`, `${lastMonth}-31`) : Promise.resolve([] as SpendRow[]),
    db
      .prepare(CANDIDATES_SQL)
      .bind(...inDatesBinds(addDays(today, 1 - T.LARGE_CHARGE_LOOKBACK_DAYS), today), T.LARGE_CHARGE_MIN_MINOR)
      .all<Omit<Charge, "isPending" | "earlierCount" | "earlierSpentMinor"> & { isPending: number }>(),
    db.prepare(ENABLED_FRESHNESS_SQL).all<AccountFreshness>(),
    firstDataMonth(db),
  ]);

  const charges = await Promise.all(
    candidates.results.map(async (c): Promise<Charge> => {
      const h = await db
        .prepare(HISTORY_SQL)
        .bind(c.merchantKey, addDays(c.countedDate, -T.LARGE_CHARGE_HISTORY_DAYS), c.countedDate, c.countedDate, c.transactionId)
        .first<{ n: number; spent: number }>();
      return { ...c, isPending: c.isPending === 1, earlierCount: h?.n ?? 0, earlierSpentMinor: h?.spent ?? 0 };
    }),
  );

  const hasData = (m: string) => first !== null && m >= first;
  const spendOf = (m: string, rows: SpendRow[]) => ({ month: m, hasData: hasData(m), rows: rows.filter((r) => r.month === m) });
  return {
    now,
    today,
    budget,
    monthSpend,
    baseline: previous.map((m, i) => spendOf(m, baselineRows[i]!)),
    lastMonth: spendOf(lastMonth, changeRows),
    previousMonth: spendOf(monthBefore, changeRows),
    charges,
    accounts: accounts.results,
  };
}
