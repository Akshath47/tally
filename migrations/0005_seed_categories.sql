-- The spec's starting categories (docs/phase-2-spec.md, Data model). The owner can rename or
-- archive any of them. No merchant rules are seeded: a pattern is real merchant text.
INSERT INTO `categories` (`name`, `kind`, `created_at`, `updated_at`)
SELECT `column1`, `column2`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (VALUES
  ('Groceries', 'budgeted'), ('Eating out', 'budgeted'), ('Transport', 'budgeted'), ('Bills', 'budgeted'),
  ('Shopping', 'budgeted'), ('Entertainment', 'budgeted'), ('Health', 'budgeted'), ('Other', 'budgeted'),
  ('Clothes', 'tracked'), ('Travel', 'tracked'),
  ('Savings', 'excluded'), ('Investments', 'excluded'), ('Card repayment', 'excluded'), ('Income', 'excluded')
);
