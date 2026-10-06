-- Generated from src/worker/budget/matches.ts; test/budget/matches.spec.ts checks they agree.
-- Fills merchant_matches for the existing transactions, then keeps it current with triggers.
INSERT INTO merchant_matches (account_id, merchant, rule_id)
SELECT m.account_id, m.merchant, COALESCE(
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'exact' AND r.pattern = lower(trim(m.merchant)) AND r.account_scope IN (m.account_id, 0)
     ORDER BY r.account_scope = 0 LIMIT 1),
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'contains' AND r.account_scope IN (m.account_id, 0) AND instr(lower(m.merchant), r.pattern) > 0
     ORDER BY r.account_scope = 0, length(r.pattern) DESC, r.id LIMIT 1))
FROM (SELECT DISTINCT account_id, merchant FROM transactions) AS m WHERE true
ON CONFLICT (account_id, merchant) DO UPDATE SET rule_id = excluded.rule_id;
--> statement-breakpoint
CREATE TRIGGER merchant_matches_transaction_insert AFTER INSERT ON transactions
  WHEN NOT EXISTS (SELECT 1 FROM merchant_matches WHERE account_id = NEW.account_id AND merchant = NEW.merchant)
BEGIN
  INSERT INTO merchant_matches (account_id, merchant, rule_id)
  VALUES (NEW.account_id, NEW.merchant, COALESCE(
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'exact' AND r.pattern = lower(trim(NEW.merchant)) AND r.account_scope IN (NEW.account_id, 0)
     ORDER BY r.account_scope = 0 LIMIT 1),
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'contains' AND r.account_scope IN (NEW.account_id, 0) AND instr(lower(NEW.merchant), r.pattern) > 0
     ORDER BY r.account_scope = 0, length(r.pattern) DESC, r.id LIMIT 1)));
END;
--> statement-breakpoint
CREATE TRIGGER merchant_matches_transaction_update AFTER UPDATE OF account_id, merchant ON transactions
  WHEN NOT EXISTS (SELECT 1 FROM merchant_matches WHERE account_id = NEW.account_id AND merchant = NEW.merchant)
BEGIN
  INSERT INTO merchant_matches (account_id, merchant, rule_id)
  VALUES (NEW.account_id, NEW.merchant, COALESCE(
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'exact' AND r.pattern = lower(trim(NEW.merchant)) AND r.account_scope IN (NEW.account_id, 0)
     ORDER BY r.account_scope = 0 LIMIT 1),
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'contains' AND r.account_scope IN (NEW.account_id, 0) AND instr(lower(NEW.merchant), r.pattern) > 0
     ORDER BY r.account_scope = 0, length(r.pattern) DESC, r.id LIMIT 1)));
END;
--> statement-breakpoint
CREATE TRIGGER merchant_matches_rule_insert AFTER INSERT ON merchant_rules
BEGIN
  UPDATE merchant_matches SET rule_id = COALESCE(
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'exact' AND r.pattern = lower(trim(merchant_matches.merchant)) AND r.account_scope IN (merchant_matches.account_id, 0)
     ORDER BY r.account_scope = 0 LIMIT 1),
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'contains' AND r.account_scope IN (merchant_matches.account_id, 0) AND instr(lower(merchant_matches.merchant), r.pattern) > 0
     ORDER BY r.account_scope = 0, length(r.pattern) DESC, r.id LIMIT 1))
  WHERE NEW.match_type = 'exact' AND merchant_key = NEW.pattern AND (NEW.account_id IS NULL OR account_id = NEW.account_id)
    AND rule_id IS NOT NEW.id;
  UPDATE merchant_matches SET rule_id = COALESCE(
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'exact' AND r.pattern = lower(trim(merchant_matches.merchant)) AND r.account_scope IN (merchant_matches.account_id, 0)
     ORDER BY r.account_scope = 0 LIMIT 1),
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'contains' AND r.account_scope IN (merchant_matches.account_id, 0) AND instr(lower(merchant_matches.merchant), r.pattern) > 0
     ORDER BY r.account_scope = 0, length(r.pattern) DESC, r.id LIMIT 1))
  WHERE NEW.match_type = 'contains' AND instr(lower(merchant), NEW.pattern) > 0 AND (NEW.account_id IS NULL OR account_id = NEW.account_id)
    AND rule_id IS NOT NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER merchant_matches_rule_update AFTER UPDATE OF match_type, pattern, account_id ON merchant_rules
  WHEN OLD.match_type IS NOT NEW.match_type OR OLD.pattern IS NOT NEW.pattern OR OLD.account_id IS NOT NEW.account_id
BEGIN
  UPDATE merchant_matches SET rule_id = COALESCE(
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'exact' AND r.pattern = lower(trim(merchant_matches.merchant)) AND r.account_scope IN (merchant_matches.account_id, 0)
     ORDER BY r.account_scope = 0 LIMIT 1),
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'contains' AND r.account_scope IN (merchant_matches.account_id, 0) AND instr(lower(merchant_matches.merchant), r.pattern) > 0
     ORDER BY r.account_scope = 0, length(r.pattern) DESC, r.id LIMIT 1))
  WHERE rule_id = OLD.id;
  UPDATE merchant_matches SET rule_id = COALESCE(
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'exact' AND r.pattern = lower(trim(merchant_matches.merchant)) AND r.account_scope IN (merchant_matches.account_id, 0)
     ORDER BY r.account_scope = 0 LIMIT 1),
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'contains' AND r.account_scope IN (merchant_matches.account_id, 0) AND instr(lower(merchant_matches.merchant), r.pattern) > 0
     ORDER BY r.account_scope = 0, length(r.pattern) DESC, r.id LIMIT 1))
  WHERE NEW.match_type = 'exact' AND merchant_key = NEW.pattern AND (NEW.account_id IS NULL OR account_id = NEW.account_id)
    AND rule_id IS NOT NEW.id;
  UPDATE merchant_matches SET rule_id = COALESCE(
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'exact' AND r.pattern = lower(trim(merchant_matches.merchant)) AND r.account_scope IN (merchant_matches.account_id, 0)
     ORDER BY r.account_scope = 0 LIMIT 1),
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'contains' AND r.account_scope IN (merchant_matches.account_id, 0) AND instr(lower(merchant_matches.merchant), r.pattern) > 0
     ORDER BY r.account_scope = 0, length(r.pattern) DESC, r.id LIMIT 1))
  WHERE NEW.match_type = 'contains' AND instr(lower(merchant), NEW.pattern) > 0 AND (NEW.account_id IS NULL OR account_id = NEW.account_id)
    AND rule_id IS NOT NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER merchant_matches_rule_delete AFTER DELETE ON merchant_rules
BEGIN
  UPDATE merchant_matches SET rule_id = COALESCE(
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'exact' AND r.pattern = lower(trim(merchant_matches.merchant)) AND r.account_scope IN (merchant_matches.account_id, 0)
     ORDER BY r.account_scope = 0 LIMIT 1),
    (SELECT r.id FROM merchant_rules r
     WHERE r.match_type = 'contains' AND r.account_scope IN (merchant_matches.account_id, 0) AND instr(lower(merchant_matches.merchant), r.pattern) > 0
     ORDER BY r.account_scope = 0, length(r.pattern) DESC, r.id LIMIT 1))
  WHERE rule_id = OLD.id;
END;
