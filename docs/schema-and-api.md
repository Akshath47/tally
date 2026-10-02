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
  holder_run_id · expires_at
```

SQL `CHECK`s back up the types the bulk `json_each` upsert would otherwise bypass: `amount_minor` must be an integer, `txn_date` a real calendar date, booleans 0/1, and statuses from their documented lists.

There is no per-account sign column: P1.1 found both institutions already use negative = money out ([lunchflow-findings.md](lunchflow-findings.md)).

### Deliberately not in Phase 1

- **`transaction_overrides`** (category, excluded, counted amount, note) is a Phase 2 table keyed by `transactions.id`.
- If P1.1 shows that IDs change between pending and posted, Phase 2 also needs a rule for moving an override from the pending transaction to its posted version.
- Categories, budgets and buckets.
- Stored raw provider payloads. Only the fields above are kept.

## API endpoints

All endpoints are under `/api`, and every one sits behind Cloudflare Access **and** the Worker's JWT middleware.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | `{ ok, email }`, used for auth smoke tests; returns no financial data |
| GET | `/api/accounts` | Accounts plus import status fields |
| GET | `/api/transactions?account_id&from&to&limit&cursor` | Paged list, newest first (`txn_date`, then `id`); `limit ≤ 200`, default 50; `from`/`to` are inclusive `YYYY-MM-DD`; pass the response's opaque `nextCursor` back as `cursor` |
| POST | `/api/import-runs` | Start a manual import (creates an import run); returns `{run}`; `409 {error:"import_running", run}` if locked, `429 {error:"rate_limited", retryAfterSeconds}` plus `Retry-After` if any run (cron included) started under 60 s ago |
| GET | `/api/import-runs?limit=20` | Recent runs with per-account results; `limit ≤ 50` |

Responses use camelCase fields. Provider account and connection ids are not exposed.

`POST` requests must send `Content-Type: application/json` (otherwise `415`). Cross-site form-style POSTs are rejected (Hono `csrf()`), and cross-origin JSON POSTs fail CORS preflight.

Errors are JSON: `400 {error:"bad_request"}` (invalid query parameter), `401 {error:"unauthenticated"}` (no or invalid Access JWT), `403 {error:"forbidden"}` (valid JWT, wrong email), `404 {error:"not_found"}`, `500 {error:"internal"}` (no details leaked).
