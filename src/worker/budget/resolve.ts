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
