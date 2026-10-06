# Stored merchant matches: plan

> **For agentic workers:** use superpowers:executing-plans to work through this task by task, and superpowers:test-driven-development for every code step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make what a screen costs in D1 rows read depend on what it shows (one month, one
transaction, the merchants still to sort), not on the whole transaction history. Today every
screen re-resolves every transaction ever imported, at about 9 rows read each
([research/d1-rows-read.md](research/d1-rows-read.md)).

**Status:** approved by the owner on 2026-10-06, with triggers and S4 included, and built on one
branch, `feat/stored-merchant-matches`, at the owner's request, as P2.7. Steps below record
what was done and where it differs from the plan.

## Why categories weren't stored, and what changes

`docs/phase-2-spec.md` (2026-10-04) says: "A new or changed rule also re-sorts past transactions
that have no category override, because categories are resolved when data is read, not stored."
The reasons, from the spec and `docs/phase-2-plan.md`:

1. **Re-sorting for free.** If nothing is stored, a new or changed rule can't leave a stale
   category behind. There's nothing to keep in sync, nothing to backfill and nothing to drift.
2. **The importer stays Phase 1's.** `transactions` is bank-sourced and the importer is its only
   writer, so a category column couldn't go on it. A separate stored table would need the
   importer to keep it current, coupling Phase 1 code to Phase 2 rules.
3. **CPU.** Resolution runs in SQL, so D1 does the work, not the Worker's 10 ms CPU budget.
4. **The cost looked small.** P2.3 measured about 13k rows read for one resolution of 600
   transactions, against 5M a day.

Reason 4 was wrong in two ways nobody multiplied out: the real history is a two-year backfill
(thousands of transactions), and the UI built later refetches several resolving queries on every
tap. Reasons 1 to 3 still hold, and this plan keeps them:

- **Re-sorting is unchanged.** What's stored is only *which rule matches each merchant*, never a
  category. Overrides and a rule's category are still joined when read, so changing a rule's
  category, overriding a transaction or changing a category's kind needs no stored update at all.
- **The importer's code doesn't change.** SQLite triggers keep the stored matches current. The
  importer still writes only `transactions`; the database adds the match row in the same
  statement. Its 40-statement budget is unaffected, because a trigger isn't a statement.
- **No Worker CPU.** Triggers and reads are SQL.

## Design

### What is stored

Today's `RESOLVED_CTE` already works out the best rule once per distinct (account, merchant),
in a `MATERIALIZED` CTE called `merchant_rule`, rebuilt on every request. This plan makes that
CTE a table:

```
merchant_matches                 derived; only triggers and the rebuild statement write it
  account_id FK → accounts.id
  merchant                       exactly as transactions.merchant
  merchant_key                   GENERATED lower(trim(merchant)), what rules compare against
  rule_id FK → merchant_rules.id null = no rule matches
  PRIMARY KEY (account_id, merchant)
  INDEX (rule_id)
  INDEX (merchant_key)
```

Plus two indexes on `transactions`: `(account_id, merchant)`, to go from a match to its
transactions, and `(txn_date)`, so a month or a newest-first page can seek. Today only
`(account_id, txn_date)` exists, which a date-only filter can't use.

Why per merchant and not per transaction: the match is a pure function of (account, merchant,
rules), so it has a fraction of the rows (about 900 for 4,000 transactions), a rule change
rewrites a few merchants rather than all their transactions, and the rebuild statement is
today's CTE word for word.

### What keeps it current

All in one hand-written migration, next to the table:

| Trigger | Fires on | Does |
| --- | --- | --- |
| `transactions_match_ai` | `AFTER INSERT ON transactions`, when the (account, merchant) has no match row | inserts the match row, with the best rule |
| `transactions_match_au` | `AFTER UPDATE OF merchant ON transactions`, same condition | same; the importer's upsert can change a row's merchant text when a pending row posts |
| `merchant_rules_match_ai` | `AFTER INSERT ON merchant_rules` | re-matches the merchants the new pattern matches (exact: `merchant_key = pattern`, a seek; contains: `instr()`, a scan of `merchant_matches`) |
| `merchant_rules_match_au` | `AFTER UPDATE OF match_type, pattern, account_id ON merchant_rules` | re-matches the merchants that pointed at the rule, and the ones the new pattern matches |
| `merchant_rules_match_ad` | `AFTER DELETE ON merchant_rules` | re-matches the merchants that pointed at the rule |

Each re-match uses one SQL fragment for "the best rule for this account and merchant", the same
precedence as today (account-scoped exact, any-account exact, account-scoped contains,
any-account contains, longer pattern, older rule). It lives in TypeScript (`resolve.ts`) and is
interpolated into the migration's triggers and the rebuild statement by a small generator, so
the precedence is written once. `transactions.account_id` never changes (`linkAccounts` swaps
provider ids on `accounts`), so no trigger is needed for it. Nothing ever deletes a match row; a
merchant that no transaction uses any more is harmless.

**Rebuild statement:** `INSERT OR REPLACE INTO merchant_matches SELECT ... FROM (SELECT DISTINCT
account_id, merchant FROM transactions)`. The migration runs it once to fill the table. It stays
exported, for tests and as a repair tool. **Consistency check:** a query counting match rows
whose stored `rule_id` differs from a live resolution. It must return 0, and costs about 3.6k
rows at 4,000 transactions.

### How reads change

`RESOLVED_CTE` keeps its name and columns, so consumers' conditions still read the same, but it
becomes a plain join: `transactions t`, `LEFT JOIN transaction_overrides o`, `LEFT JOIN
merchant_matches mm` on (account, merchant), `LEFT JOIN merchant_rules r` on `mm.rule_id`. It's
no longer materialized, so SQLite pushes each consumer's conditions down into it, and those
conditions decide the cost:

- **One transaction** (`PUT`/`DELETE` override responses): a seek per table.
- **A month** (summary, `/api/transactions?from&to`, Home's line listings): seeks on
  `transactions(txn_date)`, plus the overrides whose `counted_date` moves a row into the month.
- **The inbox, its merchant groups and the inbox badge:** driven from `merchant_matches WHERE
  rule_id IS NULL`, then that merchant's transactions, so they read the transactions still to
  sort, not the history.
- **Rule counts** (`GET /api/rules`): every matched merchant's transactions, so about the history
  once, without resolving it. Only the Categories screen asks for it.

The summary's single aggregate splits in two: the month's lines (month-scoped) and the inbox
count (inbox-scoped). Responses don't change.

### Measured on a spike

Synthetic ledger, 4,000 transactions, 500 merchants, 160 rules, the triggers above, local D1:

| Read | Today | Stored matches |
| --- | ---: | ---: |
| Month summary aggregate | 37,306 | about 1,050 |
| One transaction (override response) | 14,684 | 4 |
| Inbox merchants, 5 merchants left to sort | 34,928 | 33 |
| Inbox merchants, 964 rows left to sort | 34,928 | 4,054 |
| Inbox merchants, nothing sorted yet (3,800 rows) | 34,928 | 14,100 |
| Inbox badge count, 5 merchants left | part of the summary | 23 |
| Rule counts | 61,371 | 5,599 |

| Write | Cost |
| --- | --- |
| File a merchant group (exact rule insert, trigger) | 917 rows read, 6 written |
| Undo it (rule delete, trigger) | 203 read, 5 written |
| A contains rule (trigger) | 4,148 read, 412 written |
| Importer, 200 new rows (trigger + 2 new indexes) | 1.1k to 2.5k read, about 2 extra written per row |
| One-off migration fill | about 15k read, 1.8k written, plus index builds |

The new merchant-key index makes the exact-rule trigger a seek; the spike didn't have it, so
917 is an upper bound.

What it means: once the backlog is sorted, a tap costs hundreds of rows, not 76k, and a screen
switch costs a month's worth of rows. Switching tabs stops mattering. While a large backlog is
still unsorted, To sort costs about 3 to 4 rows per transaction left to sort per refresh,
falling as you sort. Task 4 below stops every tap from refreshing the whole backlog.

### Drawbacks

- **Stored state can be wrong.** If a trigger has a bug, or a future write path bypasses the
  triggers (raw SQL in a console), categories are silently wrong until a rebuild. Mitigations:
  triggers fire for every writer, so no route can forget them; a property test compares stored
  matches with live resolution after random rule and transaction changes; and the consistency
  check can run in production (counts only).
- **Logic in triggers is less visible.** It lives in a migration, not in a route. Changing the
  precedence later means a migration that drops and recreates five triggers and reruns the
  rebuild. A comment in `resolve.ts` and the schema doc point to it.
- **The importer's inserts do a little more.** About 2 extra index writes per new transaction and
  a match lookup per new merchant. A trigger error would fail that import chunk, which the
  existing importer specs would catch.
- **Rule writes cost more.** Previously 3 rows. Still small, and rule writes are rare compared
  with reads.
- **Rule counts still read about the history** once per Categories visit (5.6k at 4,000
  transactions). Fine at this scale. A later change could store counts if it ever isn't.
- **Spec and invariant changes.** `docs/phase-2-spec.md`'s decision row, the schema doc and the
  invariants in `.claude/CLAUDE.md` change: `merchant_matches` is derived, written only by
  triggers and the rebuild statement.

Rejected alternatives: a per-transaction category table (rule and override writes must rewrite
transaction rows, and it duplicates override state, so more ways to drift); maintaining matches
in route and importer code (every write path has to remember, and the importer couples to
rules); caching the CTE's result in KV (another service, and it's still a full resolve on every
change).

## Global constraints

The ones in [phase-2-plan.md](phase-2-plan.md) still apply. Additionally:

- Behaviour must not change: every existing API spec passes unchanged, apart from tests that
  pin internals.
- Fixtures stay synthetic. The probe and spike data generators are synthetic.
- No remote migration or deploy from the agent; the owner applies `db:migrate:remote` and
  deploys (`docs/setup-responsibilities.md`).

## Steps

Built on one branch rather than one per step, as the owner asked. Before the PR: `code-review`,
`simplify` and `security-review` (S2 to S4 touch `/api/*` and the routes behind it).

### [x] S1 Table, indexes, triggers and fill

**Accept when** (all passed):
- the migrations apply with `wrangler d1 migrations apply DB --local` on an empty database, and
  `npm run db:check` passes
- a property test (`test/budget/matches.spec.ts`): 300 random rule inserts, pattern, type and
  scope edits, deletes, transaction inserts and merchant changes, with the stored matches equal
  to matching from scratch after every step. Breaking any one of the rule triggers' branches by
  hand makes it fail.
- the importer specs pass unchanged; a trigger is not a statement, so a run's count is unchanged,
  and an import with a pending row posting under new merchant text leaves no drift
- deleting a rule a match points at succeeds

Done:
- `bestRuleSql`, `MATCH_TRIGGERS_SQL`, `REBUILD_MATCHES_SQL` and `MATCHES_DRIFT_SQL` live in
  `src/worker/budget/matches.ts` (not `resolve.ts`). `0007_merchant_match_triggers.sql` is the
  fill and the triggers from it, and a test fails if they differ, or if a trigger is missing
  after all migrations.
- The drift query is the oracle: it matches every merchant from scratch with the old CTE's
  precedence, and also counts transactions with no match row.
- Found on the way: D1's `meta.changes` counts rows changed by triggers, so `DELETE
  /api/rules/:id` now confirms the delete with `RETURNING` instead.

### [x] S2 Reads use the stored matches

**Accept when** (all passed): every existing API spec passes unchanged, apart from the
summary's statement count (3 → 4: the inbox count is its own statement), and
`test/rows-read.spec.ts` (the former probe) holds the budgets. At 4,000 synthetic transactions:

| Read | Before | After | Budget |
| --- | ---: | ---: | ---: |
| Override response (`PUT`/`DELETE`) | 14,684 | 6 to 9 | 50 |
| Month summary, 1,330 rows to sort | 37,306 | 4,882 | 3,000 + 4 per row to sort |
| Month summary, 5 merchants to sort | 37,306 | 156 | 3,000 |
| A month's listing | 19,565 | 367 | 3,000 |
| Home line listing | 23,305 | 634 to 944 | 3,000 |
| Newest 100 transactions | | 366 | 1,000 |
| Inbox page / merchant groups, 1,330 rows to sort | 41,257 / 34,928 | 8,000 / 5,671 | 7 per row to sort |
| Inbox page / merchant groups, 5 merchants to sort | 41,257 / 34,928 | 62 / 43 | 500 |
| Rule counts | 61,371 | 8,918 | 10,000 |
| Steady-state cron import | 12,473 | 12,473 | 5 per stored transaction |

Done:
- `RESOLVED_CTE` is a plain join, with an **inner** join to `merchant_matches`, so SQLite can
  start from the matches for the inbox. That relies on every transaction having a match row:
  the triggers guarantee it, the drift query counts any that don't, and `.claude/CLAUDE.md`
  records the invariant.
- `INBOX` spells out "no override category and no matched rule", so SQLite seeks
  `merchant_matches_rule_idx` (the same rows as `category_id IS NULL`, since a rule always has
  a category).
- `IN_MONTH` narrows a month with the date index and the overrides' counted dates, then applies
  the exact counted-month rule. The summary and `GET /api/months/:month/transactions` use it.
- The listing no longer joins `transactions` a second time; `EDITABLE` became `editable(alias)`.
- Every plan was checked with `EXPLAIN QUERY PLAN`: index seeks only, no full scans.

### [x] S3 Docs and spec

- [x] `phase-2-spec.md` (the "Rule changes" row and the Rules section), `schema-and-api.md`
  (the table, triggers and new indexes) and `.claude/CLAUDE.md` (the derived-table and
  rows-read invariants).
- [x] `research/d1-rows-read.md`: the after numbers. The README links both docs.

### [x] S4 Fewer refetches (web)

- [x] Filing a group or a row in To sort removes it from the loaded inbox and groups
  (`src/web/inbox.ts`) instead of refetching the backlog. Checked in the browser on the mock
  API: each tap is one request; Undo refetches and restores the list.
- [x] `refetchOnWindowFocus: false`.
- Changed from the plan: instead of a per-mutation invalidation map, a mutation can set
  `meta: { refetch: "none" }`, which still marks every query stale but refetches nothing until
  it's next shown. After S2 the other queries a write refetches cost tens of rows, so a map
  wasn't worth its risk of a stale screen.

### Rollout

The owner runs both steps from their own terminal, back to back:

1. `npm run db:migrate:remote` applies 0006 and 0007: the table and indexes, the fill (about
   15k rows read and 2k written, once, plus the index builds) and the triggers.
2. `npm run deploy`.

Don't leave a gap between them. The code deployed now confirms a rule delete with
`meta.changes === 1`, and with the triggers in place a delete that re-matches merchants changes
more rows, so `DELETE /api/rules/:id` would delete the rule but answer 404 until the deploy.
The same applies to rolling back: redeploying an older version keeps working otherwise (the
table and triggers are additive and the importer is unaffected), with that one caveat.

Then check, counts only:
- `npx wrangler d1 execute tally-prod --remote --command "SELECT count(*) AS n FROM merchant_matches"`
  is about the number of distinct merchants, and the drift query (`MATCHES_DRIFT_SQL` in
  `src/worker/budget/matches.ts`) returns 0.
- The next day, `node scripts/usage-report.ts` shows rows read per day back near the cron-only
  baseline.

The owner answered the open questions on 2026-10-06: change the spec row, use triggers, and
include S4.
