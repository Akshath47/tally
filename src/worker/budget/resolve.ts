// Which category each transaction is in (docs/phase-2-spec.md, Rules): its override, otherwise
// the best-matching merchant rule, otherwise none. Worked out in SQL when read, from the stored
// merchant matches (./matches.ts), so a rule change re-sorts every transaction without an
// override, and D1 does the work rather than the Worker.

/**
 * Mirrors SQLite's `lower(trim(x))`, which rules are matched against: `trim()` strips spaces
 * only and `lower()` folds A–Z only. JavaScript's own trim()/toLowerCase() do more, and a
 * pattern they produced could never equal what SQLite computes from the merchant.
 */
export function normalizePattern(text: string): string {
  return text.replace(/^ +| +$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Whether a normalised pattern can be a rule's. SQLite's trim() leaves tabs and newlines, so a
 * pattern still edged with whitespace is refused: an exact one typed by the owner could never
 * match, and a lone tab would catch every merchant containing one.
 */
export const isRulablePattern = (pattern: string) => pattern.length >= 1 && pattern.length <= 100 && !/^\s|\s$/.test(pattern);

/**
 * `resolved AS (...)`: one row per transaction, vanished ones included (consumers filter). Use
 * as `WITH ${RESOLVED_CTE} SELECT ... FROM resolved r`.
 *
 * A plain join, not materialised, so SQLite pushes each consumer's conditions into it, and they
 * decide the cost: D1 bills rows read, so a consumer must give it something to seek (an id, a
 * month with IN_MONTH, or INBOX's match_rule_id), never filter the whole history. The rule's
 * category and the override are read here, so neither needs anything stored. The triggers give
 * every transaction a match row; the join is still LEFT so that a row missing one counts as
 * uncategorised rather than vanishing from the totals (MATCHES_DRIFT_SQL finds it).
 */
export const RESOLVED_CTE = `resolved AS (
  SELECT t.id, t.account_id, t.amount_minor, t.currency, t.txn_date, t.merchant, t.description,
    t.is_pending, t.vanished_at, t.first_seen_at,
    o.category_id AS override_category_id, COALESCE(o.excluded, 0) AS excluded,
    o.counted_amount_minor, o.counted_date, o.note,
    m.account_id AS match_account_id, m.rule_id AS match_rule_id,
    CASE WHEN o.category_id IS NULL THEN m.rule_id END AS rule_id,
    COALESCE(o.category_id, r.category_id) AS category_id,
    CASE WHEN o.category_id IS NOT NULL THEN 'override' WHEN m.rule_id IS NOT NULL THEN 'rule' END AS category_source
  FROM transactions t
  LEFT JOIN merchant_matches m ON m.account_id = t.account_id AND m.merchant = t.merchant
  LEFT JOIN transaction_overrides o ON o.transaction_id = t.id
  LEFT JOIN merchant_rules r ON r.id = m.rule_id
)`;

/**
 * On `resolved r`: the rows counted in a month, by `counted_date ?? txn_date`; bind
 * inMonthBinds(month). The first condition only narrows: it lets SQLite seek the month's bank
 * dates and the overrides that count a row in it. The second is the exact rule.
 */
export const IN_MONTH = `(r.txn_date BETWEEN ? AND ? OR r.id IN (SELECT transaction_id FROM transaction_overrides WHERE counted_date BETWEEN ? AND ?))
  AND substr(COALESCE(r.counted_date, r.txn_date), 1, 7) = ?`;

/** IN_MONTH's binds. Every date in a month sorts between its -01 and -31. */
export function inMonthBinds(month: string): string[] {
  const [from, to] = [`${month}-01`, `${month}-31`];
  return [from, to, from, to, month];
}

/**
 * On `resolved r`: what still needs sorting. Counted transactions that no override or rule
 * categorises and that haven't been excluded. Money in and out both wait here; pending rows too,
 * though not editable. The inbox and the summary's `inboxCount` share it, so they always agree.
 *
 * "No override category and no matched rule" is `category_id IS NULL` (a rule always has a
 * category), spelled out so SQLite seeks merchant_matches_rule_idx and reads only the
 * transactions still to sort. `match_account_id = account_id` is false for a row with no match,
 * which lets SQLite treat the match join as an inner one here and start from the matches (it
 * doesn't for `IS NOT NULL`). A row with no match row (drift) is left out of the inbox, though it
 * still counts as uncategorised spend.
 */
export const INBOX = `r.vanished_at IS NULL AND r.match_account_id = r.account_id AND r.match_rule_id IS NULL
  AND r.override_category_id IS NULL AND r.excluded = 0`;

/**
 * On `resolved r` joined to `categories c`: a counted row that isn't excluded counts when it's
 * budgeted or tracked, or uncategorised money out. Uncategorised money in waits in the inbox.
 * Always 0 or 1: a bare `c.kind IN (...)` is NULL for an uncategorised row. The month summary
 * and the rows behind each of its lines share it, so they always agree.
 */
export const COUNTS = `(r.excluded = 0 AND (COALESCE(c.kind IN ('budgeted', 'tracked'), 0)
  OR (r.category_id IS NULL AND COALESCE(r.counted_amount_minor, r.amount_minor) < 0)))`;
