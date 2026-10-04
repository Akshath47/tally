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
 * `resolved AS (...)`: one row per transaction, vanished ones included (consumers filter).
 * Rule precedence: exact before contains, then account-scoped before any-account, then the
 * longer pattern, then the older rule. `instr()` matches a contains pattern literally, so a
 * `%` or `_` in it is never a wildcard. Use as `WITH ${RESOLVED_CTE} SELECT ... FROM resolved`.
 */
export const RESOLVED_CTE = `resolved AS (
  SELECT x.*,
    COALESCE(x.override_category_id, (SELECT category_id FROM merchant_rules WHERE id = x.rule_id)) AS category_id,
    CASE WHEN x.override_category_id IS NOT NULL THEN 'override' WHEN x.rule_id IS NOT NULL THEN 'rule' END AS category_source
  FROM (
    SELECT t.id, t.account_id, t.amount_minor, t.txn_date, t.merchant, t.is_pending, t.vanished_at,
      o.category_id AS override_category_id, COALESCE(o.excluded, 0) AS excluded,
      o.counted_amount_minor, o.counted_date, o.note,
      CASE WHEN o.category_id IS NULL THEN (
        SELECT r.id FROM merchant_rules r
        WHERE (r.account_id IS NULL OR r.account_id = t.account_id)
          AND ((r.match_type = 'exact' AND r.pattern = lower(trim(t.merchant)))
            OR (r.match_type = 'contains' AND instr(lower(t.merchant), r.pattern) > 0))
        ORDER BY r.match_type = 'contains', r.account_id IS NULL, length(r.pattern) DESC, r.id
        LIMIT 1
      ) END AS rule_id
    FROM transactions t
    LEFT JOIN transaction_overrides o ON o.transaction_id = t.id
  ) AS x
)`;
