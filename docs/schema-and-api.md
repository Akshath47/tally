# Phase 1 schema and API

## Conventions

- Money is stored as integer minor units (`amount_minor`). The sign is normalised to **negative = money out / more owed**.
- Transaction dates are `YYYY-MM-DD` text, stored exactly as the provider gives them.
- Timestamps are ISO-8601 UTC text.
- Bank-sourced data and future user edits are kept in **separate tables**. The importer is the only thing that writes to `transactions`.

## Tables

```
accounts
  id PK
  provider                 'lunchflow'
  provider_account_id      Lunch Flow account id (stored as text)
  provider_connection_id
  name                     display label (e.g. "Revolut · GBP · ••1234"), never the raw IBAN
  institution_name · provider_status
  currency                 from the balance endpoint (the accounts endpoint omits it); null until known
  balance_minor · balance_fetched_at   latest balance from the balance endpoint, for display
  import_enabled           bool; the importer sets it (off for non-GBP accounts)
  last_seen_in_provider_at
  last_import_attempt_at · last_import_success_at
  last_import_error        sanitised, truncated
  consecutive_failures
  last_data_change_at      last import that inserted or changed a transaction
  newest_txn_date
  backfill_cursor_date · backfill_complete
  backfill_floor_date      a linked account's catch-up stops here (P2.1); null = BACKFILL_DAYS
  needs_review             bool; set on accounts first seen once Tally already had accounts (P2.1)
  merged_into_account_id FK → accounts.id   on a linked review row: it now only holds the target's old provider id
  created_at · updated_at
  UNIQUE(provider, provider_account_id)

transactions              -- bank-sourced fields only
  id PK
  account_id FK → accounts.id
  provider_txn_id          Lunch Flow's id; a pending row with a null id gets 'nullid:' + its fingerprint
  amount_minor             normalised sign
  provider_amount          original decimal as text
  currency
  txn_date                 YYYY-MM-DD
  merchant · description   untrusted text
  is_pending
  fingerprint              account|date|amount|normalised description (diagnostic only)
  first_seen_at · last_seen_at · vanished_at · updated_at
                           last_seen_at is set on insert and on each real change, never bumped by an unchanged re-import
                           vanished_at: the row no longer counts (a pending row superseded or expired)
  superseded_by FK → transactions.id   the posted row that replaced this pending one
  first_import_run_id
  UNIQUE(account_id, provider_txn_id)
  INDEX(account_id, txn_date)
  INDEX(fingerprint)
  INDEX(account_id, merchant) · INDEX(txn_date)   P2.7; a merchant's rows, and a month or page by date

import_runs
  id PK
  trigger                  'cron' | 'manual'
  started_at · finished_at
  status                   'running' | 'success' | 'partial' | 'failed' | 'skipped_locked'
  error_summary

import_run_accounts
  run_id FK · account_id FK
  status · http_status
  window_from · window_to
  fetched · inserted · updated · vanished_marked
  error · duration_ms

import_lock               -- single row, id = 1, seeded by a migration
  holder_run_id · expires_at   lease: 10 min for cron, budget + 30 s for a manual run

categories                -- P2.2; seeded with the spec's 14 starting categories
  id PK
  name                     COLLATE NOCASE (ASCII), UNIQUE; trimmed, non-empty
  kind                     'budgeted' | 'tracked' | 'excluded'
  archived_at              hidden from pickers; rules and overrides keep pointing at it
  created_at · updated_at

merchant_rules            -- P2.2; none seeded (a pattern is real merchant text)
  id PK
  match_type               'exact' | 'contains'
  pattern                  = lower(trim(pattern)), non-empty; SQLite's ASCII lower(), so normalise in SQL
  account_id FK → accounts.id     null = any account
  account_scope            generated: coalesce(account_id, 0)
  category_id FK → categories.id
  created_at · updated_at
  UNIQUE(match_type, pattern, account_scope)   the upsert conflict target

transaction_overrides     -- P2.2; the owner's edits, keyed by transactions.id; the importer never touches it
  transaction_id PK FK → transactions.id
  category_id FK → categories.id  null = follow the rules
  excluded                 bool, default 0
  counted_amount_minor     null = bank amount; same sign as amount_minor
  counted_date             null = txn_date
  note                     ≤ 500 characters, untrusted text
  updated_at
  INDEX(counted_date) WHERE counted_date IS NOT NULL   P2.7; rows a counted date moves into a month

merchant_matches          -- P2.7; derived: which rule each (account, merchant) matches
  account_id FK → accounts.id · merchant   PK; merchant exactly as transactions.merchant
  merchant_key             generated: lower(trim(merchant)), what exact rules compare against
  rule_id FK → merchant_rules.id  null = no rule matches
  INDEX(rule_id) · INDEX(merchant_key)
  Written only by triggers (on transactions insert and merchant update; on merchant_rules
  insert, pattern/type/scope update and delete) and REBUILD_MATCHES_SQL, all generated from
  src/worker/budget/matches.ts. Every transaction has a row; none is ever deleted.
  MATCHES_DRIFT_SQL counts pairs that disagree with matching from scratch (always 0).

digest_sends              -- P2.11; one row per weekly digest, claimed before sending
  week_start PK            YYYY-MM-DD, the week's Monday (London)
  status                   'sending' | 'sent' | 'failed'
  attempted_at · sent_at
  error                    an Email Service code (E_…), never a message; never the email's content

monthly_budgets           -- P2.2; positive = spend
  effective_month PK       YYYY-MM
  amount_minor             > 0
  updated_at

category_budgets          -- P2.2
  category_id FK · effective_month   PK
  amount_minor             ≥ 0; 0 removes the allocation from that month on
  updated_at
```

SQL `CHECK`s back up the types the bulk `json_each` upsert would otherwise bypass: `amount_minor` must be an integer, `txn_date` a real calendar date, booleans 0/1, and statuses from their documented lists. The Phase 2 tables follow the same rule:
- `kind` and `match_type` come from their lists
- `counted_amount_minor` is an integer
- `counted_date` is a real date
- `note` is text of at most 500 characters
- category names are trimmed and non-empty
- rule patterns are non-empty and already in `lower(trim())` form
- `effective_month` is a real `YYYY-MM` month
- budget amounts are integers, > 0 for the overall figure and ≥ 0 for an allocation

A month's budget figures come from the row with the greatest `effective_month` ≤ that month ([phase-2-spec.md](phase-2-spec.md)).

There is no per-account sign column: P1.1 found both institutions already use negative = money out ([lunchflow-findings.md](lunchflow-findings.md)).

### Deliberately not in Phase 1

- **`transaction_overrides`** (category, excluded, counted amount, counted date, note) is a Phase 2 table keyed by `transactions.id`.
- If P1.1 shows that IDs change between pending and posted, Phase 2 also needs a rule for moving an override from the pending transaction to its posted version.
- Categories, budgets and buckets.
- Stored raw provider payloads. Only the fields above are kept.

## API endpoints

All endpoints are under `/api`, and every one sits behind Cloudflare Access **and** the Worker's JWT middleware.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | `{ ok, email }`, used for auth smoke tests; returns no financial data |
| GET | `/api/accounts` | Accounts plus import status fields and `needsReview`; merged rows are left out. Each row also has `staleDays` (whole London days since `lastDataChangeAt`; null if it's never been set, or for a disabled account) and `stale` (an enabled account with `staleDays` ≥ 4), per [phase-2-insights-spec.md](phase-2-insights-spec.md) (P2.8) |
| POST | `/api/accounts/:id/enable` | An account awaiting review is genuinely new: import it from the next run. `409 not_awaiting_review` / `409 not_importable` (currency isn't GBP, or not known yet because its balance call keeps failing) / `409 conflict` (the row changed since it was read) |
| POST | `/api/accounts/:id/link` | `{intoAccountId}`: an account awaiting review is a reconnect of that account. The two rows swap provider ids in one batch, and the target catches up from 7 days before its newest transaction (a full backfill if it hadn't finished backfilling). `409 not_awaiting_review` / `409 invalid_link_target` / `409 import_running` (an in-flight run would overwrite the link) / `409 conflict` (either row changed since it was read) |
| GET | `/api/transactions?account_id&from&to&limit&cursor` | Paged list, newest first (`txn_date`, then `id`); `limit ≤ 200`, default 50; `from`/`to` are inclusive `YYYY-MM-DD`; pass the response's opaque `nextCursor` back as `cursor`. Each row also has `categoryId`, `categorySource` (`override` / `rule` / `null`), `excluded`, `countedAmountMinor`, `countedDate`, `note` and `editable` (false for pending or vanished rows) (P2.4) |
| PUT | `/api/transactions/:id/override` | `{categoryId?, excluded?, countedAmountMinor?, countedDate?, note?, applyToMerchant?}` **replaces** the override: a field left out goes back to its default, and all defaults (`{}` included) remove it. `categoryId` is the override's own category, so a row that should keep following the rules sends `null`. `applyToMerchant: true` (needs `categoryId`) puts the category on this merchant's exact rules instead: it creates or updates the any-account rule, and also updates this account's own exact rule if it has one (it would outrank the any-account rule). The override then stores no category. → `{transaction}`. `409 not_editable` / `409 category_archived` (unless already this override's category) / `409 merchant_not_rulable` (the merchant is blank, longer than 100 characters or edged with whitespace, so it can't be a rule's pattern) / `404` (unknown transaction or category) (P2.4) |
| DELETE | `/api/transactions/:id/override` | Back to the bank values and the rules → `{transaction}`, whether or not there was an override. `409 not_editable` / `404` (P2.4) |
| GET | `/api/inbox?limit&cursor` | `{transactions, nextCursor, total}`: counted, uncategorised, not-excluded transactions, money in and out, pending ones included (`editable: false`). Paged as `/api/transactions`; `total` counts every page (P2.4) |
| GET | `/api/inbox/merchants` | `{merchants: {pattern, merchant, count, totalMinor, latestDate, rulable}[]}`: the inbox grouped by `lower(trim(merchant))`, the pattern of the exact rule that would clear the group. `merchant` is the latest row's text, and `totalMinor` sums counted amounts in the bank's sign. `rulable: false` means no rule can have that pattern, so the group's rows are sorted one by one. Biggest groups first (P2.4) |
| POST | `/api/import-runs` | Start a manual import: creates the run and claims the lock, answers `202 {status:"started", runId}`, and imports in the background (poll `GET /api/import-runs`); `409 {error:"import_running"}` if the lock is held (the attempt is recorded as `skipped_locked`); `429 {error:"rate_limited", retryAfterSeconds}` plus `Retry-After` if any run (cron included) started under 60 s ago |
| GET | `/api/import-runs?limit=20` | `{runs, importing}`: recent runs with per-account results (`limit ≤ 50`), and whether a run currently holds the import lease |
| GET | `/api/categories` | `{categories: {id, name, kind, archived}[]}`, archived ones included, ordered by id (P2.3) |
| POST | `/api/categories` | `{name, kind}`, with the name trimmed to 1–50 characters → `201 {category}`. `409 name_taken` if the name exists ignoring ASCII case (`COLLATE NOCASE` doesn't fold accented letters, so `Café` and `CAFÉ` can coexist) |
| PATCH | `/api/categories/:id` | `{name?, kind?, archived?}` (at least one) → `{category}`. `404` / `409 name_taken`. Categories are archived, never deleted. A category left not budgeted or archived has its allocation set to 0 from the current month, in the same batch (P2.5) |
| GET | `/api/rules` | `{rules: {id, matchType, pattern, accountId, categoryId, transactionCount}[]}`. `transactionCount` = counted rows the rule decides, with no category override (P2.3) |
| POST | `/api/rules` | `{matchType, pattern, accountId?, categoryId}` → `201 {rule}`. The pattern is stored as SQLite's `lower(trim())` would compute it (ASCII and spaces only), 1–100 characters. `409 rule_exists` / `409 category_archived` / `404` (unknown or merged account, unknown category) |
| PATCH | `/api/rules/:id` | Any of the create fields. `accountId: null` makes the rule apply to any account. Same errors as create |
| DELETE | `/api/rules/:id` | `{ok: true}` or `404`. Its transactions fall back to the next matching rule, or to uncategorised |
| GET | `/api/budget` | The current London month's `{month, overallMinor, allocatedMinor, miscMinor, categories: {categoryId, allocatedMinor, maxAllocatableMinor}[]}`, listing every budgeted, unarchived category by id. `allocatedMinor` sums those categories' allocations, `miscMinor` = overall − allocated, and `maxAllocatableMinor` = overall − every other allocation. Before the first overall figure, `overallMinor`, `miscMinor` and every `maxAllocatableMinor` are null (P2.5) |
| PUT | `/api/budget/overall` | `{amountMinor}`, a safe integer > 0, effective from the current London month → the `GET` body. `422 {error:"below_allocated", minOverallMinor}` |
| PUT | `/api/budget/categories/:categoryId` | `{amountMinor}`, a safe integer ≥ 0 (0 removes the allocation from this month on), effective from the current London month → the `GET` body. `404` / `409 category_archived` / `409 category_not_budgeted` / `409 overall_budget_not_set` / `422 {error:"over_allocated", maxAllocatableMinor}` |
| GET | `/api/months/:month/summary` | The home screen for a `YYYY-MM` month: `{month, overallMinor, allocatedMinor, miscMinor, spentMinor, pendingSpentMinor, leftMinor, daysRemaining, perWeekMinor, categories: {categoryId, kind, spentMinor, pendingSpentMinor, allocatedMinor}[], trackedMinor, inboxCount, lastDataChangeAt, staleAccountIds}`. Figures are positive = spend. `spentMinor` is budget spend (budgeted categories and uncategorised money out, pending included), `leftMinor` = overall − spent, and `trackedMinor` is tracked categories' spend. `categories` lists each category with a counting row this month or an allocation above 0, by id, with Uncategorised (`categoryId: null`) last. `daysRemaining` (today included) and `perWeekMinor` (floored; 0 once nothing is left) are null for a past month. Budget figures are null before the first overall figure. `inboxCount` is the whole inbox, every month. `lastDataChangeAt` is the latest across enabled accounts. `staleAccountIds` lists the enabled accounts that are stale (as on `/api/accounts`), and is always empty for a past month (P2.8, [phase-2-insights-spec.md](phase-2-insights-spec.md)). `400` for a malformed or future month (P2.6) |
| GET | `/api/months/:month/transactions?category=<id>\|misc\|uncategorised-pending\|posted\|pending&limit=&cursor=` | The rows behind one Home line: those counting in the month (by `counted_date ?? txn_date`, same rule as the summary) in category `<id>`, in Misc (posted uncategorised money out, plus budgeted categories with no allocation that month, archived ones included), in Uncategorised pending (uncategorised pending money out), or in the Posted or Pending pill (the month's budget spend, budgeted or uncategorised, split by `is_pending`; tracked left out). `{transactions, nextCursor}`, shaped and paged like `GET /api/transactions`; `limit` defaults to 100, max 200. Category `<id>` (budgeted or tracked) also lists its excluded rows that month, by the same month rule, so they can be found from Home; they carry `excluded: true` and don't count. A line's counting rows always add up to its `spentMinor`. `400` for a malformed or future month or a bad `category` |
| GET | `/api/months/:month/review` | A completed month against the month before: totals, per-category spend and change, and the top 5 merchants. `400` for the current month, a future month or a malformed one. Response in [phase-2-insights-spec.md](phase-2-insights-spec.md) (P2.9) |
| GET | `/api/trends` | The current month and the 5 before: budget and tracked spend per month, each month's overall budget, and each category's 6-month series and average over completed months with data. Response in [phase-2-insights-spec.md](phase-2-insights-spec.md) (P2.9) |
| GET | `/api/merchants?key=` | One merchant across both accounts by `merchantKey` (`lower(trim(merchant))`): its rule's category, accounts, first counted date, the 6 trend months' spend and visits, and the 20 most recent rows. `400` for an empty or overlong key, `404` when nothing has it. Response in [phase-2-insights-spec.md](phase-2-insights-spec.md) (P2.9) |
| GET | `/api/insights` | `{asOf, items}`: today's insights for the current London month, ranked (stale accounts, over and on-course-to-go-over pace, categories running high, large charges in the last 7 days, and last month's changes in the first week). Structured data; `src/worker/insights/wording.ts` words them for the app and the digest. Items and thresholds in [phase-2-insights-spec.md](phase-2-insights-spec.md) (P2.10) |
| GET | `/api/digest/preview` | This week's digest as JSON (week and month-to-date spend, category status, insights, to-sort count, freshness, last send): what the Sunday email contains, live. Shape in [phase-2-insights-spec.md](phase-2-insights-spec.md) (P2.11) |
| POST | `/api/digest/send` | Sends this week's digest to `ALLOWED_EMAIL` now, outside the weekly claim: for the acceptance check and re-sending a failed week. `{ok: true}`, or `502 {error: "send_failed"}` (the `digest_send` log line has the Email Service code) (P2.11) |

Responses use camelCase fields. Provider account and connection ids are not exposed.

`POST`, `PUT`, `PATCH` and `DELETE` requests must send `Content-Type: application/json` (otherwise `415`). Cross-site form-style POSTs are rejected (Hono `csrf()`), and cross-origin JSON POSTs fail CORS preflight.

Errors are JSON: `400 {error:"bad_request"}` (invalid query parameter), `401 {error:"unauthenticated"}` (no or invalid Access JWT), `403 {error:"forbidden"}` (valid JWT, wrong email), `404 {error:"not_found"}`, `500 {error:"internal"}` (no details leaked).
