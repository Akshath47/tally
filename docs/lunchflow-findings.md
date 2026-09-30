# Lunch Flow findings (P1.1)

This records the observed behaviour of the Lunch Flow Personal API for the owner's connections. It holds aggregate facts only: no IBANs, merchants or real amounts. Produced by `scripts/probe-lunchflow.ts`.

| Run | Date | Notes |
|---|---|---|
| 1 | 2026-09-30 | First probe, right after connecting (extended history on) |
| 2 | _pending_ | Re-run 1–2 days later for the pending → posted diff |

## Accounts

- `GET /accounts` returned **3 accounts across 2 connections**:
  - **Revolut** (one connection) exposes **two accounts**: the main GBP account, and a **USD currency pocket** with only 2 transactions (a one-off exchange in Jan 2025).
  - **BA Amex** (one connection) exposes one GBP account.
- **`currency` is missing from the accounts response**, although the docs list it. Get the currency from the balance endpoint (`balance.currency`) or from transactions instead.
- **Revolut's `name` is the account IBAN.** The Amex `name` is the card product name, cut off at 35 characters.
- `status` was `ACTIVE` for all; `provider` was `gocardless`.
- `id` and `connection_id` are numbers.

## Transactions

- **The schema matches the docs:** `id` (string), `accountId` (number), `amount` (number), `currency`, `date` (`YYYY-MM-DD`), `merchant`, `description`, `isPending`. There were no nulls and no missing fields.
- **Revolut `description` is always an empty string**, so `merchant` is the only useful text. Amex fills in both.
- **Posted IDs** are 32-character hex strings, with no duplicates within a response.
- **Sign convention:** negative = money out / more owed, on **both** institutions.
  - Amex purchases are negative; Amex repayments ("PAYMENT RECEIVED") are positive.
  - So no per-account sign flip is needed.
- **Amounts** have at most 2 decimals for GBP and 1 decimal for USD (e.g. `21.6`). Revolut has 27 zero-amount transactions.
- Only one `currency` per account.
- **`date` appears to be the booking (settlement) date, not the purchase date.** In the owner's check, one Revolut card purchase was dated one day later than the Revolut app shows. Every other sampled date matched. Consequence: a purchase made late on the last day of a month can land in the next month. Run 2 records whether a pending transaction's date moves when it posts.

## Filters, history, pagination

- **With no params, the endpoint returns the account's entire history.** For Revolut that was 1,098 rows in one response. `total` always equalled the array length; there is **no pagination and no truncation** at this size.
- `from`/`to` work, including on a 14-day window.
- **History depth:**
  - **Revolut:** about **2 years** (earliest 2024-10-05). Extended history worked.
  - **Amex:** from **2026-09-11**, which is the new card's first purchase (confirmed by the owner). So this is the full card history, not a limit.

## Pending

- `include_pending` defaults to `false`.
- With `true`, **Revolut returned 1 pending transaction with a 4-character, non-hex id**. Posted ids are 32-character hex. This strongly suggests pending ids are **not** stable, and that a posted transaction will arrive with a new id.
- **Amex returned 0 pending.** It's unclear whether it has none right now or doesn't support pending.
- Run 2 checks this using the `.probe/` snapshot. The script reports `sameIdNowPosted`, `vanished` and `vanishedButPostedLookalike`.

## Freshness and latency

- **Revolut had posted and pending transactions dated today**, and Amex's newest was yesterday. The data is at least near-daily, possibly better for Revolut.
- **Latency:**
  - The first transactions call per account took 2–5 s; repeat calls took about 0.3 s. That suggests a short-lived server-side cache.
  - The balance endpoint took about 1.9 s on every call.
- There is no freshness metadata anywhere: no timestamps on accounts or balance.
- Response headers show hosting on Vercel, with `cache-control: public, max-age=0, must-revalidate`, `age: 0` and `x-vercel-cache: MISS`. There is no HTTP-level caching of API responses.

## Errors and rate limits

| Case | Status | Body |
|---|---|---|
| Invalid API key | **403** (not 401) | `{ error: "Forbidden", message: "Invalid credentials." }` |
| Unknown account id | 404 | `{ error: "Not Found", message: "Account not found." }` |
| Invalid `from` date | 400 | `{ success: false, error: { name: "ZodError", issues: [...] } }`: `error` is an **object** here |

- **No rate-limit headers** (`x-ratelimit-*`, `retry-after`) were seen across about 20 calls.

## Transfers seen in the data (input for Phase 2)

- Every Amex repayment in the sample appears as a Revolut debit to the Amex card and an Amex credit ("PAYMENT RECEIVED"), for the **same amount on the same date**. Matching on amount plus date (± a couple of days) will reliably pair them.
- Revolut also shows many paired moves to and from a savings pocket, labelled as a merchant name rather than as a separate account. Internal transfers from other own accounts also appear. These need "transfer" handling in Phase 2.

## What this changes in the plan

1. **Always pass `from`/`to`.** Leaving them out returns the entire history (about 1,100 rows, a few hundred KB), which costs CPU for nothing.
2. **Get account currency from the balance endpoint.** This adds one subrequest per account per run (about 7 in total, well under 50). It also gives a balance to display.
3. **Drop `accounts.amount_sign`.** Both institutions already use negative = money out. The normaliser can simply assert the currency and decimal places.
4. **Don't store raw IBANs as account names.** Store a display label such as "Revolut · GBP · ••7668".
5. **The Revolut USD pocket stays off** (owner decision, 2026-09-30). `accounts.import_enabled` defaults to off for non-GBP accounts, since budgets are GBP.
6. **Pending ids look unstable.** Keep the `vanished_at` design. In Phase 2, either don't allow edits on pending transactions, or move an edit to the posted transaction when it's matched by amount and date.
7. **The error parser must handle `error` being either a string or an object.** Treat 403 as "bad/revoked key" (configuration problem, no retry).
8. **Backfill:** Revolut supports about 730 days. A 31-day chunk holds roughly 50 rows, so raising `BACKFILL_DAYS` to 730 is cheap: about 1,100 row writes, once.
9. **Booking-date lag (Phase 2):** month totals use Lunch Flow's `date`. If purchases near month-end land in the wrong month too often, add a per-transaction "count in month" override. It belongs in `transaction_overrides`, not in bank data.

## Gate 1 status

- [x] Both institutions return transactions through the API.
- [x] Sign convention recorded.
- [x] Owner compared the sample transactions with the Revolut and Amex apps (2026-09-30). Amounts, signs and pending all match. One card purchase is dated one day later (booking date, see above).
- [x] Amex history is complete: the card is new, and its first purchase was on 2026-09-11.
- [ ] Run 2 (1–2 days later): pending → posted behaviour.
