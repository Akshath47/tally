// Which category each transaction is in (docs/phase-2-spec.md, Rules): its override, otherwise
// the best-matching merchant rule, otherwise none. Worked out in SQL when read, so a rule
// change re-sorts every transaction without one, and D1 does the work rather than the Worker.

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
 * `merchant_rule AS (...), resolved AS (...)`. `resolved` has one row per transaction,
 * vanished ones included (consumers filter). Use as `WITH ${RESOLVED_CTE} SELECT ... FROM resolved`.
 *
 * Rule precedence: exact before contains, then account-scoped before any-account, then the
 * longer pattern, then the older rule. `instr()` matches a contains pattern literally, so a
 * `%` or `_` in it is never a wildcard.
 *
 * D1 bills rows read, so each distinct (account, merchant) is matched once rather than every
 * transaction against every rule: exact rules are an index lookup on (match_type, pattern,
 * account_scope), and only contains rules are scanned.
 */
export const RESOLVED_CTE = `merchant_rule AS MATERIALIZED (
  SELECT m.account_id, m.merchant, COALESCE(
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'exact' AND r.pattern = lower(trim(m.merchant)) AND r.account_scope IN (m.account_id, 0)
     ORDER BY r.account_scope = 0 LIMIT 1),
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'contains' AND r.account_scope IN (m.account_id, 0) AND instr(lower(m.merchant), r.pattern) > 0
     ORDER BY r.account_scope = 0, length(r.pattern) DESC, r.id LIMIT 1)
  ) AS rule_id
  FROM (SELECT DISTINCT account_id, merchant FROM transactions) AS m
),
resolved AS (
  SELECT t.id, t.account_id, t.amount_minor, t.txn_date, t.merchant, t.is_pending, t.vanished_at,
    o.category_id AS override_category_id, COALESCE(o.excluded, 0) AS excluded,
    o.counted_amount_minor, o.counted_date, o.note,
    CASE WHEN o.category_id IS NULL THEN mr.rule_id END AS rule_id,
    COALESCE(o.category_id, r.category_id) AS category_id,
    CASE WHEN o.category_id IS NOT NULL THEN 'override' WHEN mr.rule_id IS NOT NULL THEN 'rule' END AS category_source
  FROM transactions t
  LEFT JOIN transaction_overrides o ON o.transaction_id = t.id
  LEFT JOIN merchant_rule mr ON mr.account_id = t.account_id AND mr.merchant = t.merchant
  LEFT JOIN merchant_rules r ON r.id = mr.rule_id
)`;

/**
 * On `resolved r`: what still needs sorting. Counted transactions that no override or rule
 * categorises and that haven't been excluded. Money in and out both wait here; pending rows too,
 * though not editable. The inbox and the summary's `inboxCount` share it, so they always agree.
 */
export const INBOX = "r.vanished_at IS NULL AND r.category_id IS NULL AND r.excluded = 0";

/**
 * On `resolved r` joined to `categories c`: a counted row that isn't excluded counts when it's
 * budgeted or tracked, or uncategorised money out. Uncategorised money in waits in the inbox.
 * Always 0 or 1: a bare `c.kind IN (...)` is NULL for an uncategorised row. The month summary
 * and the rows behind each of its lines share it, so they always agree.
 */
export const COUNTS = `(r.excluded = 0 AND (COALESCE(c.kind IN ('budgeted', 'tracked'), 0)
  OR (r.category_id IS NULL AND COALESCE(r.counted_amount_minor, r.amount_minor) < 0)))`;
