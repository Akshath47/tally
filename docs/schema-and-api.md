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
| GET | `/api/accounts` | Accounts plus import status fields and `needsReview`; merged rows are left out |
| POST | `/api/accounts/:id/enable` | An account awaiting review is genuinely new: import it from the next run. `409 not_awaiting_review` / `409 not_importable` (currency isn't GBP, or not known yet because its balance call keeps failing) / `409 conflict` (the row changed since it was read) |
| POST | `/api/accounts/:id/link` | `{intoAccountId}`: an account awaiting review is a reconnect of that account. The two rows swap provider ids in one batch, and the target catches up from 7 days before its newest transaction (a full backfill if it hadn't finished backfilling). `409 not_awaiting_review` / `409 invalid_link_target` / `409 import_running` (an in-flight run would overwrite the link) / `409 conflict` (either row changed since it was read) |
| GET | `/api/transactions?account_id&from&to&limit&cursor` | Paged list, newest first (`txn_date`, then `id`); `limit ≤ 200`, default 50; `from`/`to` are inclusive `YYYY-MM-DD`; pass the response's opaque `nextCursor` back as `cursor` |
| POST | `/api/import-runs` | Start a manual import: creates the run and claims the lock, answers `202 {status:"started", runId}`, and imports in the background (poll `GET /api/import-runs`); `409 {error:"import_running"}` if the lock is held (the attempt is recorded as `skipped_locked`); `429 {error:"rate_limited", retryAfterSeconds}` plus `Retry-After` if any run (cron included) started under 60 s ago |
| GET | `/api/import-runs?limit=20` | `{runs, importing}`: recent runs with per-account results (`limit ≤ 50`), and whether a run currently holds the import lease |
| GET | `/api/categories` | `{categories: {id, name, kind, archived}[]}`, archived ones included, ordered by id (P2.3) |
| POST | `/api/categories` | `{name, kind}`, with the name trimmed to 1–50 characters → `201 {category}`. `409 name_taken` if the name exists in any case |
| PATCH | `/api/categories/:id` | `{name?, kind?, archived?}` (at least one) → `{category}`. `404` / `409 name_taken`. Categories are archived, never deleted |
| GET | `/api/rules` | `{rules: {id, matchType, pattern, accountId, categoryId, transactionCount}[]}`. `transactionCount` = counted rows the rule decides, with no category override (P2.3) |
| POST | `/api/rules` | `{matchType, pattern, accountId?, categoryId}` → `201 {rule}`. The pattern is stored as SQLite's `lower(trim())` would compute it (ASCII and spaces only), 1–100 characters. `409 rule_exists` / `409 category_archived` / `404` (unknown or merged account, unknown category) |
| PATCH | `/api/rules/:id` | Any of the create fields. `accountId: null` makes the rule apply to any account. Same errors as create |
| DELETE | `/api/rules/:id` | `{ok: true}` or `404`. Its transactions fall back to the next matching rule, or to uncategorised |

Responses use camelCase fields. Provider account and connection ids are not exposed.

`POST`, `PATCH` and `DELETE` requests must send `Content-Type: application/json` (otherwise `415`). Cross-site form-style POSTs are rejected (Hono `csrf()`), and cross-origin JSON POSTs fail CORS preflight.

Errors are JSON: `400 {error:"bad_request"}` (invalid query parameter), `401 {error:"unauthenticated"}` (no or invalid Access JWT), `403 {error:"forbidden"}` (valid JWT, wrong email), `404 {error:"not_found"}`, `500 {error:"internal"}` (no details leaked).
