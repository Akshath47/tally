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
  name · institution_name · currency · provider_status
  amount_sign              +1 / -1, set from P1.1 findings
  import_enabled           bool
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
  provider_txn_id
  amount_minor             normalised sign
  provider_amount          original decimal as text
  currency
  txn_date                 YYYY-MM-DD
  merchant · description   untrusted text
  is_pending
  fingerprint              account|date|amount|normalised description (diagnostic only)
  first_seen_at · last_seen_at · vanished_at · updated_at
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

import_lock               -- single row, id = 1
  holder_run_id · expires_at
```

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
| GET | `/api/transactions?account_id&from&to&limit&cursor` | Paged list, newest first; `limit ≤ 200` |
| POST | `/api/import-runs` | Start a manual import (creates an import run); returns the run summary; `409` if locked, `429` if last run was under 60 s ago |
| GET | `/api/import-runs?limit=20` | Recent runs with per-account results |

`POST` requests must send `Content-Type: application/json`. Cross-site form-style POSTs are rejected (Hono `csrf()`), and cross-origin JSON POSTs fail CORS preflight.

Errors are JSON: `401 {error:"unauthenticated"}` (no or invalid Access JWT), `403 {error:"forbidden"}` (valid JWT, wrong email), `404 {error:"not_found"}`, `500 {error:"internal"}` (no details leaked).
