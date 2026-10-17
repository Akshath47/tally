import { listTransactions } from "../budget/listing";
import { COUNTS, RESOLVED_CTE } from "../budget/resolve";
import { londonMonth, monthsEnding } from "../importer/dates";
import { floorDiv } from "./math";
import { TREND_MONTHS } from "./trends";

// One merchant's history across both accounts (docs/phase-2-insights-spec.md, Merchant). A
// merchant is its key, lower(trim(merchant)), the text exact rules match. Every read seeks the
// key's (account, merchant) pairs through merchant_matches_key_idx, never the whole history.

/** On `resolved r`: the rows whose merchant has the key bound here (one `?`). */
export const OF_MERCHANT = "(r.account_id, r.merchant) IN (SELECT account_id, merchant FROM merchant_matches WHERE merchant_key = ?)";

const RECENT = 20;

// The latest row's text, and the category its match's rule gives a new transaction.
const IDENTITY_SQL = `SELECT t.merchant AS name, mr.category_id AS categoryId
FROM merchant_matches m
JOIN transactions t ON t.account_id = m.account_id AND t.merchant = m.merchant
LEFT JOIN merchant_rules mr ON mr.id = m.rule_id
WHERE m.merchant_key = ?1 AND t.vanished_at IS NULL
ORDER BY t.txn_date DESC, t.id DESC LIMIT 1`;

const ACCOUNTS_SQL = "SELECT DISTINCT account_id AS id FROM merchant_matches WHERE merchant_key = ?1 ORDER BY account_id";

// Counted spend and visits per month over the merchant's whole history (one merchant is small).
const MONTHS_SQL = `WITH ${RESOLVED_CTE}
SELECT substr(COALESCE(r.counted_date, r.txn_date), 1, 7) AS month,
  min(COALESCE(r.counted_date, r.txn_date)) AS first,
  sum(-COALESCE(r.counted_amount_minor, r.amount_minor)) AS spentMinor,
  sum(COALESCE(r.counted_amount_minor, r.amount_minor) < 0) AS visits
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE ${OF_MERCHANT} AND r.vanished_at IS NULL AND ${COUNTS}
GROUP BY month`;

/** The merchant with this key, or null when no (unvanished) transaction has it. Four statements. */
export async function readMerchant(db: D1Database, key: string, now: Date) {
  const window = monthsEnding(londonMonth(now), TREND_MONTHS);
  const [identity, accountRows, monthRows, recent] = await Promise.all([
    db.prepare(IDENTITY_SQL).bind(key).first<{ name: string; categoryId: number | null }>(),
    db.prepare(ACCOUNTS_SQL).bind(key).all<{ id: number }>(),
    db.prepare(MONTHS_SQL).bind(key).all<{ month: string; first: string; spentMinor: number; visits: number }>(),
    listTransactions(db, { where: [[OF_MERCHANT, key], ["r.vanished_at IS NULL"]], limit: RECENT, withCategory: true }),
  ]);
  if (!identity) return null;

  const byMonth = new Map(monthRows.results.map((r) => [r.month, r]));
  const months = window.map((month) => ({ month, spentMinor: byMonth.get(month)?.spentMinor ?? 0, visits: byMonth.get(month)?.visits ?? 0 }));
  const windowSpentMinor = months.reduce((sum, m) => sum + m.spentMinor, 0);
  const windowVisits = months.reduce((sum, m) => sum + m.visits, 0);
  return {
    merchantKey: key,
    name: identity.name,
    categoryId: identity.categoryId,
    categorySource: identity.categoryId === null ? null : ("rule" as const),
    accountIds: accountRows.results.map((r) => r.id),
    // Null when every row is excluded: nothing of theirs has counted.
    firstSeenDate: monthRows.results.reduce<string | null>((min, r) => (min === null || r.first < min ? r.first : min), null),
    months,
    windowSpentMinor,
    windowVisits,
    averageChargeMinor: windowVisits === 0 ? null : floorDiv(windowSpentMinor, windowVisits),
    recent: recent.transactions,
  };
}
