# Platform constraints (verified 2026-09-29)

Recheck these against the linked sources before implementing, because they can change.

## Lunch Flow Personal API

Sources: [overview](https://www.lunchflow.app/docs/api/personal-api-overview) · [list accounts](https://www.lunchflow.app/docs/api/personal-api/listAccounts) · [get transactions](https://www.lunchflow.app/docs/api/personal-api/getAccountTransactions) · [get balance](https://lunchflow.app/docs/api/personal-api/getAccountBalance) · [API destination guide](https://lunchflow.app/docs/guides/destinations/api) · [bank coverage](https://lunchflow.app/docs/guides/connections/bank-coverage) · [pricing](https://lunchflow.app/docs/guides/account/pricing)

Use the **Personal API**, not the Platform API (`/docs/api/platform-api-*`), which is the OAuth/multi-user product.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/accounts` | No query params documented |
| GET | `/api/v1/accounts/{accountId}/transactions` | `from`, `to` (`YYYY-MM-DD`, inclusive), `include_pending` (`"true"`/`"false"`, default `false`) |
| GET | `/api/v1/accounts/{accountId}/balance` | Amount + currency; no timestamp documented |
| GET | `/api/v1/accounts/{accountId}/holdings` | Not needed |

- **Base URL:** `https://lunchflow.app/api/v1`
- **Auth:** the `x-api-key` header. The 401 message also mentions `Authorization: Bearer`.

### Documented response schemas

```jsonc
// GET /accounts
{ "accounts": [{ "id": number, "connection_id": number, "name": string,
    "institution_name": string, "institution_logo": string,
    "provider": "gocardless", "currency": string, "status": "ACTIVE" }],
  "total": number }

// GET /accounts/{id}/transactions
{ "transactions": [{ "id": string, "accountId": number, "amount": number,
    "currency": string, "date": "YYYY-MM-DD", "merchant": string,
    "description": string, "isPending": boolean }],
  "total": number }
```

Errors: 400/401/403/404/500/503, with `{ error, message }`.

### Confirmed facts

- **API key scope:** each API destination has an **Account Access** tab that turns accounts on or off for its key.
- **UK/EU provider:** GoCardless.
- **Sync frequency:** the guides say data "updates automatically every day".
- **Refresh:** the Personal API has **no refresh endpoint**. Reads return Lunch Flow's stored data.
- **Pricing after trial:** £4.99/month for 4 connections, or £29.99/year for 2 connections. This is the app's only recurring cost.

### Not documented, so the P1.1 probe must establish these

| Question | How the probe answers it |
|---|---|
| Amount sign convention (especially Amex) | Compare with bank apps |
| Pagination / truncation | Compare `total` with array length over wide ranges |
| History depth for each account | Step `from` backwards |
| Rate limits | Record response header *names* (`retry-after`, `x-ratelimit-*`); keep calls sparse |
| Pending availability for each account | `include_pending=true` counts |
| ID stability from pending to posted | Re-run 1–2 days later and diff |
| Cache vs fresh bank data | Time for a new purchase to appear; compare runs |
| Account `status` values and reconnection signal | Observe over time; record any non-`ACTIVE` values or error codes |
| `merchant` empty or null | Count empties |
| Error body shapes | Deliberately invalid key; nonexistent account id |

## Cloudflare free tier

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) · [Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) · [Worker-level Access changelog](https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/) · [Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/)

### Workers (Free)

| Limit | Value |
|---|---|
| Requests | 100,000/day |
| CPU time per invocation | **10 ms** (HTTP *and* Cron Triggers) |
| Subrequests per invocation | 50 |
| Cron Triggers per account | 5 |
| Cron wall duration | 15 min |
| `ctx.waitUntil` after an HTTP response or client disconnect | 30 s ([context API](https://developers.cloudflare.com/workers/runtime-apis/context/), checked 2026-10-02) |
| Memory | 128 MB |
| Static assets | 20,000 files/version, 25 MiB/file |

CPU time and network wait are separate. Time spent waiting on Lunch Flow or D1 does not count as CPU, but JSON parsing, validation and transformation do. `performance.now()` does not measure CPU inside Workers, so CPU is measured through the Cloudflare analytics API (P1.8).

### D1 (Free)

| Limit | Value |
|---|---|
| Rows read | 5,000,000/day (counts *scanned* rows) |
| Rows written | 100,000/day (+1 per index touched by the write) |
| Storage | 5 GB account, 500 MB/database, 10 databases |
| Queries per Worker invocation | **50**; each statement inside `batch()` counts separately |
| Bound parameters per query | 100 |
| Max SQL statement | 100 KB |
| Max query/batch duration | 30 s |
| Time Travel | 7 days |

Daily limits reset at 00:00 UTC. When they're exceeded, queries fail until the reset.

### Workers Logs (Free)

200,000 events/day, 3-day retention. Enable with `observability.enabled = true`.

### Cloudflare Access

- The Zero Trust Free plan covers up to 50 users.
- Access can be attached **to the Worker itself**, which covers its routes, custom domains, `workers.dev` and previews.
- `ctx.access` is **not passed** to Workers that use Static Assets, so the Worker must validate `Cf-Access-Jwt-Assertion` itself.
- Local dev can simulate an identity with `access.dev` in `wrangler.jsonc`.
- Not verified: whether Zero Trust onboarding asks for a payment method on the $0 plan.
