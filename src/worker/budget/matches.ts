// Stored merchant matches (docs/stored-matches-plan.md): which merchant rule each
// (account, merchant) matches. A rule change or a new merchant updates them in SQLite triggers,
// so the importer's code and statement count don't change, and reads join the stored match
// instead of matching every merchant against every rule on every request.
//
// The triggers live in migrations/0007_merchant_match_triggers.sql. They are this file's
// MATCH_TRIGGERS_SQL verbatim, and test/budget/matches.spec.ts fails if the two differ, so the
// precedence below is written once. Changing it means a migration that drops and recreates the
// triggers and runs REBUILD_MATCHES_SQL. So does any migration that rebuilds `transactions` or
// `merchant_rules` (dropping a table drops its triggers).

/**
 * Scalar subquery: the id of the best rule for this account and merchant, or NULL. The arguments
 * are SQL expressions (`NEW.account_id`, `m.merchant`), never values.
 *
 * Precedence (docs/phase-2-spec.md, Rules): exact before contains, then account-scoped before
 * any-account, then the longer pattern, then the older rule. Exact rules compare against
 * `lower(trim(merchant))` with an index seek; `instr()` matches a contains pattern literally, so
 * a `%` or `_` in it is never a wildcard.
 */
export const bestRuleSql = (accountId: string, merchant: string) => `COALESCE(
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'exact' AND r.pattern = lower(trim(${merchant})) AND r.account_scope IN (${accountId}, 0)
     ORDER BY r.account_scope = 0 LIMIT 1),
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'contains' AND r.account_scope IN (${accountId}, 0) AND instr(lower(${merchant}), r.pattern) > 0
     ORDER BY r.account_scope = 0, length(r.pattern) DESC, r.id LIMIT 1))`;

const REMATCH = `UPDATE merchant_matches SET rule_id = ${bestRuleSql("merchant_matches.account_id", "merchant_matches.merchant")}`;

/**
 * Re-matches the merchants the rule (NEW) now matches: only they can gain it as their best rule.
 * One already pointing at it was re-matched by the update trigger's first statement. The exact
 * branch seeks merchant_matches_key_idx; the contains branch scans the (small) table.
 */
const rematchMatchedBy = `
  ${REMATCH}
  WHERE NEW.match_type = 'exact' AND merchant_key = NEW.pattern AND (NEW.account_id IS NULL OR account_id = NEW.account_id)
    AND rule_id IS NOT NEW.id;
  ${REMATCH}
  WHERE NEW.match_type = 'contains' AND instr(lower(merchant), NEW.pattern) > 0 AND (NEW.account_id IS NULL OR account_id = NEW.account_id)
    AND rule_id IS NOT NEW.id;`;

/** A new (account, merchant) gets its match. Skipped when it has one, which is a single seek. */
const addMatch = (head: string) => `${head}
  WHEN NOT EXISTS (SELECT 1 FROM merchant_matches WHERE account_id = NEW.account_id AND merchant = NEW.merchant)
BEGIN
  INSERT INTO merchant_matches (account_id, merchant, rule_id)
  VALUES (NEW.account_id, NEW.merchant, ${bestRuleSql("NEW.account_id", "NEW.merchant")});
END`;

/**
 * The triggers, one statement each. A merchant's best rule can only change when a rule that
 * now matches it appears, or the rule it points at changes or goes. A category-only rule edit
 * changes nothing stored: the rule's category is read when the data is.
 */
export const MATCH_TRIGGERS_SQL = [
  // The importer's upsert: a new row, or a changed merchant text (a pending row posting).
  addMatch("CREATE TRIGGER merchant_matches_transaction_insert AFTER INSERT ON transactions"),
  addMatch("CREATE TRIGGER merchant_matches_transaction_update AFTER UPDATE OF account_id, merchant ON transactions"),
  `CREATE TRIGGER merchant_matches_rule_insert AFTER INSERT ON merchant_rules
BEGIN${rematchMatchedBy}
END`,
  `CREATE TRIGGER merchant_matches_rule_update AFTER UPDATE OF match_type, pattern, account_id ON merchant_rules
  WHEN OLD.match_type IS NOT NEW.match_type OR OLD.pattern IS NOT NEW.pattern OR OLD.account_id IS NOT NEW.account_id
BEGIN
  ${REMATCH}
  WHERE rule_id = OLD.id;${rematchMatchedBy}
END`,
  `CREATE TRIGGER merchant_matches_rule_delete AFTER DELETE ON merchant_rules
BEGIN
  ${REMATCH}
  WHERE rule_id = OLD.id;
END`,
];

/** Matches every (account, merchant) from scratch: the migration's fill, and a repair tool. */
export const REBUILD_MATCHES_SQL = `INSERT INTO merchant_matches (account_id, merchant, rule_id)
SELECT m.account_id, m.merchant, ${bestRuleSql("m.account_id", "m.merchant")}
FROM (SELECT DISTINCT account_id, merchant FROM transactions) AS m WHERE true
ON CONFLICT (account_id, merchant) DO UPDATE SET rule_id = excluded.rule_id`;

/**
 * `n`: how many (account, merchant) pairs in transactions have no stored match, or a stored match
 * that differs from matching them now. Always 0 unless something bypassed the triggers. Counts
 * only, so it's safe to run against production.
 */
export const MATCHES_DRIFT_SQL = `SELECT count(*) AS n
FROM (SELECT DISTINCT account_id, merchant FROM transactions) AS m
LEFT JOIN merchant_matches mm ON mm.account_id = m.account_id AND mm.merchant = m.merchant
WHERE mm.account_id IS NULL OR mm.rule_id IS NOT ${bestRuleSql("m.account_id", "m.merchant")}`;
