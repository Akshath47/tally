import { listTransactions } from "../budget/listing";
import { COUNTS, RESOLVED_CTE } from "../budget/resolve";
import { londonMonth, monthsEnding } from "../importer/dates";
import { floorDiv } from "./math";
import { TREND_MONTHS } from "./trends";

// One merchant's history across both accounts (docs/phase-2-insights-spec.md, Merchant). A
// merchant is its key, lower(trim(merchant)), the text exact rules match. Every read seeks the
// key's (account, merchant) pairs through merchant_matches_key_idx, never the whole history.

/** On `resolved r`: the rows whose merchant has the key bound here (one `?`). */
export const OF_MERCHANT = "r.merchant_key = ?";

const RECENT = 20;

/** The longest key the route takes; the review only links to keys within it. */
export const MAX_MERCHANT_KEY = 200;

// The key's (account, merchant) pairs, each with the category its match's rule gives a new
// transaction. A handful of rows.
const PAIRS_SQL = `SELECT m.account_id AS accountId, m.merchant, mr.category_id AS categoryId
FROM merchant_matches m LEFT JOIN merchant_rules mr ON mr.id = m.rule_id
WHERE m.merchant_key = ?1 ORDER BY m.account_id`;

// The newest unvanished rows by id, from transactions alone, so only these few are resolved
// (sorting every resolved row first costs a join per row). One `?` for the key.
const RECENT_IDS = `r.id IN (SELECT id FROM transactions
  WHERE (account_id, merchant) IN (SELECT account_id, merchant FROM merchant_matches WHERE merchant_key = ?) AND vanished_at IS NULL
  ORDER BY txn_date DESC, id DESC LIMIT ${RECENT})`;

// Counted spend and visits per month over the merchant's whole history (one merchant is small).
const MONTHS_SQL = `WITH ${RESOLVED_CTE}
SELECT substr(COALESCE(r.counted_date, r.txn_date), 1, 7) AS month,
  min(COALESCE(r.counted_date, r.txn_date)) AS first,
  sum(-COALESCE(r.counted_amount_minor, r.amount_minor)) AS spentMinor,
  sum(COALESCE(r.counted_amount_minor, r.amount_minor) < 0) AS visits,
  COALESCE(sum(CASE WHEN COALESCE(r.counted_amount_minor, r.amount_minor) < 0 THEN -COALESCE(r.counted_amount_minor, r.amount_minor) END), 0) AS chargedMinor
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE ${OF_MERCHANT} AND r.vanished_at IS NULL AND ${COUNTS}
GROUP BY month`;

/** The merchant with this key, or null when no (unvanished) transaction has it. Three statements. */
export async function readMerchant(db: D1Database, key: string, now: Date) {
  const window = monthsEnding(londonMonth(now), TREND_MONTHS);
  const [pairs, monthRows, recent] = await Promise.all([
    db.prepare(PAIRS_SQL).bind(key).all<{ accountId: number; merchant: string; categoryId: number | null }>(),
    db.prepare(MONTHS_SQL).bind(key).all<{ month: string; first: string; spentMinor: number; visits: number; chargedMinor: number }>(),
    listTransactions(db, { where: [[RECENT_IDS, key]], limit: RECENT }),
  ]);
  // Named by the latest row's text; its pair's rule gives the category.
  const latest = recent.transactions[0];
  if (!latest) return null;
  const categoryId = pairs.results.find((p) => p.accountId === latest.accountId && p.merchant === latest.merchant)?.categoryId ?? null;

  const byMonth = new Map(monthRows.results.map((r) => [r.month, r]));
  const months = window.map((month) => ({ month, spentMinor: byMonth.get(month)?.spentMinor ?? 0, visits: byMonth.get(month)?.visits ?? 0 }));
  const windowSpentMinor = months.reduce((sum, m) => sum + m.spentMinor, 0);
  const windowVisits = months.reduce((sum, m) => sum + m.visits, 0);
  // Charges only: refunds net off the spend, but an average charge is an average of charges.
  const windowChargedMinor = window.reduce((sum, m) => sum + (byMonth.get(m)?.chargedMinor ?? 0), 0);
  return {
    merchantKey: key,
    name: latest.merchant,
    categoryId,
    categorySource: categoryId === null ? null : ("rule" as const),
    accountIds: [...new Set(pairs.results.map((p) => p.accountId))],
    // Null when every row is excluded: nothing of theirs has counted.
    firstSeenDate: monthRows.results.reduce<string | null>((min, r) => (min === null || r.first < min ? r.first : min), null),
    months,
    windowSpentMinor,
    windowVisits,
    averageChargeMinor: windowVisits === 0 ? null : floorDiv(windowChargedMinor, windowVisits),
    recent: recent.transactions,
  };
}
