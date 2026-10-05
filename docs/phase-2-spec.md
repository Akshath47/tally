# Phase 2 spec: budgeting backend

This turns [phase-2-outline.md](phase-2-outline.md) into decisions for the backend: data, rules and API. Where the two differ, this spec wins. It follows the owner's answers from 2026-10-04 and the constraints in [phase1-assessment.md](phase1-assessment.md).

**The UI is out of scope.** The owner is designing it separately. This spec only fixes what the API returns, so the screens can be built against it.

## What Tally is for

The owner opens Tally for a quick daily check, a weekly tidy-up and a monthly review. It has to answer three questions:

1. How much is left to spend this month?
2. Am I within each category's limit?
3. Where did the money go?

Not wanted: income tracking, savings goals, splitting costs with other people, manual (cash) transactions, budget rollover, or spreading one purchase over several months.

## Decisions

| Topic | Decision |
|---|---|
| Period | Calendar month in `Europe/London`, with a "per week left" pacing figure. Every month starts fresh, with no rollover. |
| Budget shape | The owner sets **one overall monthly figure** first, then allocates parts of it to categories. The unallocated rest is **Misc**. Allocations may never exceed the overall figure. Bills sit inside it. |
| Category kinds | **budgeted** (counts against the budget), **tracked** (visible in spending views, never counts, e.g. clothes and one-offs), **excluded** (not spending, e.g. savings, investments, card repayments, income). |
| Categorising | Merchant rules set a default. A per-transaction override always wins over a rule. Anything no rule matches lands in the inbox. |
| Rule changes | A new or changed rule also re-sorts past transactions that have no category override, because categories are resolved when data is read, not stored. |
| One-off purchases | Handled by overriding that one transaction (its category, or excluding it). Changing one transaction never changes the merchant's rule unless the owner opts in. |
| Money sent to people | Counts as spending by default (it's usually dinners). The owner excludes individual transfers by hand. |
| Card repayments | Rules put both halves, Revolut's payment out and the Amex's payment received, in the excluded **Card repayment** category. This replaces the outline's amount-pairing heuristic. |
| Pending | Counts towards spend and is reported separately from posted. It can't be edited ([phase1-assessment.md](phase1-assessment.md)). Rules still categorise it. |
| Income | Hidden. Uncategorised money coming in doesn't count. Salary should be given a rule to the excluded **Income** category. |
| Reconnection | A new Lunch Flow account id is **linked to the existing Tally account**, never imported as a second copy. This lands before budgets go live. |
| Buckets | **Dropped.** The outline's `budget_buckets` add a layer that per-category budgets don't need. |
| Alerts | In-app only, derived by the UI from the summary's figures. The weekly email digest and stale-data warnings are later slices. |

## Data model

These are new tables. `transactions` and `accounts` stay as they are, apart from the reconnection link (below), and the importer remains the only writer of `transactions`. Every table follows the existing conventions: integer minor units, `YYYY-MM-DD` text for dates, ISO-8601 UTC timestamps, and SQL `CHECK`s that repeat the TypeScript types.

```
categories
  id PK
  name                  unique, case-insensitive
  kind                  'budgeted' | 'tracked' | 'excluded'
  archived_at           hidden from pickers; existing rules and overrides keep pointing at it
  created_at · updated_at

merchant_rules
  id PK
  match_type            'exact' | 'contains'
  pattern               stored lower-cased and trimmed
  account_id FK → accounts.id   null = any account
  category_id FK → categories.id
  created_at · updated_at
  UNIQUE(match_type, pattern, account scope)

transaction_overrides         keyed by transactions.id; the importer never touches it
  transaction_id PK FK → transactions.id
  category_id FK → categories.id   null = follow the rules
  excluded              bool, default 0
  counted_amount_minor  null = bank amount; same sign convention as amount_minor
  counted_date          null = txn_date; a real YYYY-MM-DD
  note                  ≤ 500 chars, untrusted text
  updated_at

monthly_budgets
  effective_month PK    'YYYY-MM'
  amount_minor          > 0, an amount of spend (positive)
  updated_at

category_budgets
  category_id FK · effective_month   PK
  amount_minor          ≥ 0; 0 removes the allocation from that month on
  updated_at
```

- **Effective values.** A month's overall figure, and each category's allocation, come from the row with the greatest `effective_month` ≤ that month. A month before the first `monthly_budgets` row has no budget, and its summary still shows spend.
- **Edits only change the current month onwards.** Every budget write goes to the current London month. Past months keep the figures they had, and there are no future-dated rows.
- **Category kinds aren't dated.** Changing a kind re-shapes past months too. That's accepted for simplicity.
- **Removing an override** (`DELETE`, or a `PUT` that sets every field back to its default) deletes the row. "Never delete" applies to `transactions`, not to the owner's edits.
- **Seeded categories** (a migration, like `0001_seed_import_lock.sql`). The owner can rename or archive any of them:
  - budgeted: Groceries, Eating out, Transport, Bills, Shopping, Entertainment, Health, Other
  - tracked: Clothes, Travel
  - excluded: Savings, Investments, Card repayment, Income
- **No merchant rules are seeded.** A rule's pattern comes from real merchant text, which must not be committed. The owner creates rules from the inbox.

## Rules

### Which category a transaction is in

The first match wins:

1. `transaction_overrides.category_id`, if set.
2. The best-matching merchant rule, compared against `lower(trim(merchant))`, in this order:
   1. account-scoped `exact`
   2. any-account `exact`
   3. account-scoped `contains`
   4. any-account `contains`

   Within a `contains` tier the longer pattern wins, and then the older rule (lower `id`).
3. None: the transaction is **uncategorised**.

This is worked out in SQL when the data is read, so D1 does the work rather than the Worker's 10 ms CPU budget. The same query logic serves the summary, the inbox and the transaction list.

### What a transaction counts as

A transaction **counts** when `vanished_at IS NULL`. Its counted month is that of `counted_date ?? txn_date`, and its counted amount is `counted_amount_minor ?? amount_minor`. In this spec **spend = −counted amount**, so money out is positive spend and a refund is negative spend.

| Transaction | Effect |
|---|---|
| override `excluded = 1` | ignored |
| category kind `excluded` | ignored |
| category kind `tracked` | tracked spend; never touches the budget |
| category kind `budgeted` | budget spend in that category |
| uncategorised, amount < 0 | budget spend, reported as **Uncategorised** |
| uncategorised, amount > 0 | ignored; it waits in the inbox |

A refund categorised to Groceries reduces Groceries' spend, and a category's net spend can go below zero.

### Budget figures for a month

- **overall**: the effective `monthly_budgets` amount.
- **allocated**: the sum of effective allocations, over budgeted categories that aren't archived.
- **misc** = overall − allocated. This is the pot drawn on by spend in budgeted categories without an allocation, and by uncategorised spend.
- **spent**: total budget spend, pending plus posted, with the pending part also given on its own.
- **left** = overall − spent. Overspending in one category reduces the overall left.
- **Pacing** (current month only): `daysRemaining` counts today. `perWeekMinor = left > 0 ? floor(left × 7 / daysRemaining) : 0`, all in integer arithmetic.
- **Until the bills slice lands**, "left" doesn't hold back bills that haven't been paid yet. Bills are just the Bills category's allocation.

### Allocation checks

- Allocating to a category requires an overall figure to have been set (`409 {error:"overall_budget_not_set"}`). The category must be `budgeted` and not archived.
- Setting a category's allocation must keep `allocated ≤ overall`. Otherwise the API returns `422 {error:"over_allocated", maxAllocatableMinor}`, where the maximum is overall − the other allocations. This is the value the UI shows in its error.
- Lowering the overall figure below `allocated` returns `422 {error:"below_allocated", minOverallMinor}`.
- When a budgeted category becomes `tracked` or `excluded`, or is archived, its allocation is set to 0 from the current month, in the same batch.
- Tally has one user, so there is no locking between the validation read and the write.

## API

The new routes sit under `/api` behind the same Access JWT middleware, CSRF, Origin and JSON content-type checks as Phase 1. Responses use camelCase. Money is integer minor units. Budget and spend figures are **positive = spend**, and transaction amounts keep the bank sign. Months are `YYYY-MM`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/categories` | All categories, archived ones included, each flagged with its status. |
| POST | `/api/categories` | Create `{name, kind}`. `409 {error:"name_taken"}` if the name already exists. |
| PATCH | `/api/categories/:id` | Rename it, change its kind, or archive or unarchive it. Changing the kind away from budgeted, or archiving it, sets its allocation to 0 (above). |
| GET | `/api/rules` | Rules, each with its category and the number of transactions it currently decides (not counting overridden ones). |
| POST | `/api/rules` | Create `{matchType, pattern, accountId?, categoryId}`. `409` if a rule with the same match type, pattern and account scope exists. |
| PATCH / DELETE | `/api/rules/:id` | Change or remove a rule. Both apply to past transactions straight away (above). |
| GET | `/api/transactions` | As in Phase 1, plus `categoryId`, `categorySource` (`override` / `rule` / `null`), the override fields, and `editable` (false for pending or vanished rows). |
| PUT | `/api/transactions/:id/override` | Set `{categoryId?, excluded?, countedAmountMinor?, countedDate?, note?, applyToMerchant?}`. Returns `409 {error:"not_editable"}` for a pending or vanished row. With `applyToMerchant: true`, Tally creates or updates an any-account `exact` rule for this merchant and stores no category override, so the row follows the rule. |
| DELETE | `/api/transactions/:id/override` | Revert to the bank values and the rules. |
| GET | `/api/inbox?limit&cursor` | Counted, uncategorised transactions, newest first, paged like `/api/transactions`, plus a total count. Pending rows are included with `editable: false`. |
| GET | `/api/inbox/merchants` | Uncategorised transactions grouped by normalised merchant: count, total, latest date. One rule clears a whole group, which matters for the first sort of about 2 years of backfilled history. |
| GET | `/api/budget` | The current month's overall figure, each budgeted category's allocation, allocated, misc and `maxAllocatableMinor`. |
| PUT | `/api/budget/overall` | `{amountMinor}`. Effective from the current month. |
| PUT | `/api/budget/categories/:categoryId` | `{amountMinor}`. Effective from the current month. |
| GET | `/api/months/:month/summary` | Everything the home screen needs (below). |
| GET | `/api/months/:month/transactions?category=<id>\|misc` | The rows that count towards one summary line in the month; Misc is uncategorised spend plus unallocated budgeted categories. |

**Summary response:**

- `month`
- `overallMinor` (null if no budget)
- `allocatedMinor`, `miscMinor`
- `spentMinor`, `pendingSpentMinor`, `leftMinor`
- `daysRemaining`, `perWeekMinor` (null for a past month)
- `categories[]`, for every category with spend or an allocation:
  - `categoryId`, `kind`
  - `spentMinor`, `pendingSpentMinor`, `allocatedMinor`
  - uncategorised spend appears as `categoryId: null`
- `trackedMinor`
- `inboxCount`
- `lastDataChangeAt`: the latest across the enabled accounts

A month in the future returns `400`.

Validation follows Phase 1: zod for every input, and `400 {error:"bad_request"}` for a bad parameter. `amountMinor` and `countedAmountMinor` must be safe integers, so the client converts the decimal text a user types into minor units with string arithmetic and never sends a float. Unknown ids return `404`.

## Reconnection

How it works today: when a new Lunch Flow account id appears, `upsertAccounts` creates a row with `import_enabled = 0`. The run then enables it as soon as its currency turns out to be GBP and backfills it. After a bank reconnect under a new id, that means every transaction is counted twice.

Phase 2 behaviour:

1. **A new account isn't imported automatically while Tally already has accounts.** Its row is recorded as awaiting review (it has a currency but isn't enabled). `GET /api/accounts` shows it so the UI can ask the owner. On a database with no accounts yet, the first import works as it does today.
2. **The owner decides:**
   - `POST /api/accounts/:id/link {intoAccountId}` points the new provider id at the existing Tally account. From then on the importer fetches with the new id and writes rows under the old `account_id`. Its first window starts 7 days before the old account's `newest_txn_date` rather than doing a full backfill.
   - `POST /api/accounts/:id/enable` treats it as a genuinely new account.
3. The old provider id is no longer polled once it's linked, so it doesn't keep failing with `not_found`.

**Open question, to settle at the first real reconnect:** does Lunch Flow keep transaction ids across a reconnect? If it does, `UNIQUE(account_id, provider_txn_id)` removes the overlap's duplicates and overrides stay attached. If it doesn't, duplicates are limited to those 7 overlapping days, and the owner excludes them by hand. Matching on fingerprint instead was rejected, because identical same-day purchases are real (P1.7 found 15 such pairs). How the link is stored (a column or a small mapping table) is left to the implementation plan.

## Slices

These are built in this order. Each one gets steps with **Accept when** checks in the implementation plan.

1. **P2.1 Reconnection guard and link.** The importer change and the two account endpoints. It comes first because the assessment requires it before budgets rely on totals, and it doesn't depend on anything else here.
2. **P2.2 Schema and seed.** The new tables and CHECKs, plus the category seed migration.
3. **P2.3 Categories and rules.** The category-resolution query and the CRUD routes for categories and rules.
4. **P2.4 Overrides, inbox and transaction fields.**
5. **P2.5 Budgets.** The effective-month lookup, allocation checks and the budget routes.
6. **P2.6 Month summary.**

**The first usable cut is P2.1–P2.6.** After that, each later slice gets its own short design before any code:

- **Bills.** A manual list of name, expected amount, roughly which day it's due, and a match (merchant pattern and amount tolerance). Bills count towards `allocated`. Bills not yet paid this month are taken off "left". It needs a decision on how it fits with the Bills category's allocation.
- **Insights.** This month vs last per category, top merchants, and search and filters on `/api/transactions` (merchant text, category, amount range).
- **Stale-data warnings.** Flag an account whose `newest_txn_date` or `last_data_change_at` hasn't moved for N days.
- **Weekly email digest.** Totals plus the week's top merchants, sent to `ALLOWED_EMAIL` from a weekly cron. The owner has agreed that this data can leave Cloudflare by email. **The cost of Cloudflare's email sending must be checked and discussed before it's enabled.**
- **PWA** (manifest, app-shell service worker). This belongs to the UI track.

## Testing

Vitest with the workers pool and synthetic fixtures only, as in Phase 1. On top of the usual route and auth tests:

- **Resolution:** override beats every rule; exact beats contains; account-scoped beats any-account; the longer contains pattern wins; a new rule re-sorts old uncategorised rows and leaves overridden rows alone; `applyToMerchant` writes a rule and no category override.
- **Counting:**
  - excluded overrides and excluded categories count 0
  - tracked spend stays out of `spentMinor`
  - uncategorised money out counts, uncategorised money in doesn't
  - a refund reduces its category's spend
  - `counted_amount_minor` replaces the bank amount
  - a vanished row doesn't count
  - a superseded pending row and its posted row count once between them
- **Months and dates:**
  - `counted_date` moves a transaction to another month
  - month edges and "today" in London across BST and GMT, e.g. `2026-03-31T23:30Z` is 1 April in London
  - pacing on the last day of the month (`daysRemaining = 1`)
  - per-week figures use integer division, never floats
- **Budgets:**
  - the effective-month lookup picks the latest row ≤ the month
  - past months keep their old figures after an edit
  - `over_allocated` returns the correct `maxAllocatableMinor`
  - `below_allocated` returns `minOverallMinor`
  - allocating without an overall figure returns `409`
  - changing a kind or archiving zeroes the allocation
- **Edits:** a pending or vanished row returns `409 not_editable`; a non-integer amount or an impossible date returns `400`; deleting an override restores the bank values.
- **Reconnection:**
  - a new provider account isn't imported while other accounts exist
  - a linked account's rows land under the old `account_id`
  - re-importing the overlap with the same ids adds no rows
  - an empty database still auto-enables its first accounts

Every new route touches `/api/*`, so each slice runs `security-review` before it's committed ([CLAUDE.md](../.claude/CLAUDE.md)).
