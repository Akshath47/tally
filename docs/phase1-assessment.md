# Phase 1 assessment (P1.9)

This is the end-of-Phase-1 read on whether Lunch Flow → Tally is good enough to budget on, and what Phase 2 has to allow for. Like [lunchflow-findings.md](lunchflow-findings.md), it holds aggregate facts only: no merchants or real amounts.

**Evidence:** the production D1 (`import_runs`, `import_run_accounts`, `transactions`) from the first import on 2026-10-02 17:42 UTC to 2026-10-04 18:00 UTC, which is 49 hourly cron runs and 3 manual runs. CPU and D1 figures come from the P1.8 result in [phase-1-plan.md](phase-1-plan.md).

**Verdict:** go for Phase 2. There are no blockers. Posted data is about a day behind the bank. **Lunch Flow exposes at most one pending transaction per account**, so Tally sees only some pending charges, and keeps each one counting until it posts (below). Phase 2 has to be designed around both facts.

## Spot check against the bank apps

**Done (owner, 2026-10-04):** about 20 transactions per account in Tally's list were checked against the Revolut and Amex apps (amount, sign, date, merchant and pending state). No discrepancies.

P1.1 already compared the raw API with the bank apps (Gate 1). This check covers what Tally added on top of the API: conversion to minor units, sign, date storage and the pending/vanished handling.

## Connection quality

- **No failures.** Both enabled accounts returned HTTP 200 on all 52 runs. Every run ended `success`, `consecutive_failures` is 0 and no account has an error recorded.
- `provider_status` stayed `ACTIVE` on all three accounts throughout.
- Both backfills are complete: about 2 years for Revolut, and the full card history for Amex.
- No rate limiting was seen, at about 5 Lunch Flow calls per run.
- The Revolut USD pocket stays disabled, as decided in P1.1.

## Staleness: bank → Lunch Flow → Tally

**Lunch Flow → Tally.** New transactions turned up in only **3 of the 49 hourly runs**: 10:00 and 19:00 UTC on 3 Oct, and 04:00 UTC on 4 Oct. Every other run re-read the same data unchanged. So Lunch Flow refreshes its stored data a few times a day, and an hourly poll adds at most an hour on top. The trigger times don't look regular, but two days is too short to call it a schedule.

**Bank → Tally**, measured from the start of the transaction's calendar date (UTC), since the API carries no purchase time.

| Account | Kind | n | First seen in Tally |
|---|---|---|---|
| Revolut | pending | 1 | same day, about 10 h into it |
| Revolut | posted | 1 | the day after its booking date, about 28 h after its start |
| Amex | pending | 1 | same day, about 19 h into it |
| Amex | posted | 2 | the day after their booking date, about 34 h after its start |

- **Pending** transactions reach Tally the **same day** as the purchase.
- **Posted** transactions reach Tally about **a day after** their booking date. The booking date can itself be a day after the purchase ([lunchflow-findings.md](lunchflow-findings.md)).
- The sample is 5 transactions. It shows the shape, not reliable numbers.

Exact purchase times weren't collected. They would sharpen these hours but change no Phase 2 decision (owner, 2026-10-04).

**Effect of the 3-hour cron** (owner's choice, 2026-10-04, instead of the planned 6 hours). Runs at 00, 03, 06 … 21 UTC would have picked up each of the three Lunch Flow refreshes above 2 hours later than the hourly cron did. The manual **Import from Lunch Flow** button still gets anything Lunch Flow already has.

## Missing fields

These are unchanged since P1.1:

- The accounts response has no `currency`. Tally takes it from the balance endpoint.
- Revolut's `description` is always empty, so `merchant` is the only text.
- `date` is the booking date, not the purchase date, for posted transactions.
- There's no freshness timestamp anywhere: no "last synced" on an account or connection. Tally can only infer freshness from when new data appears (`last_data_change_at`).

## Pending behaviour and ID stability

- **Posted ids are stable.** There are 0 duplicates by `(account_id, provider_txn_id)`. The 15 same-fingerprint pairs are explained in P1.7.
- **Pending ids are now always null.** All 3 pending transactions that production has seen, 2 on Amex and 1 on Revolut, came with `id: null`. In P1.1 Revolut's pending transaction had a 4-character id. So the importer's `nullid:` fingerprint key is the normal path for pending rows, not an edge case.
- **Lunch Flow returns at most one pending transaction per account.** The owner's Amex app shows many pending charges. Across all 52 runs, no account ever held more than one live pending row at a time, and both P1.1 probe runs saw at most one per account. The importer stores exactly what it receives: each run's `fetched` count equals the account's live rows in the window (Amex 19 = 18 posted + 1 pending; Revolut 21 = 20 + 1). So the gap is upstream of Tally.
- **A charge that's still pending at the bank can vanish from Tally.** At 19:00 UTC on 3 Oct, Lunch Flow's Amex response still had 19 rows, but its single pending charge was swapped for a newer one. The importer marked the old one vanished, yet the owner's Amex app still showed it as pending (checked 2026-10-04).
- **Likely cause (unconfirmed, Lunch Flow's side):** pending transactions arrive with no id, so if Lunch Flow keys stored transactions by id, all of an account's pending charges would collapse into one. Worth reporting to Lunch Flow.
- The Revolut pending row dated 3 Oct was still pending after about 32 h. P1.1's single Revolut example posted within about 29 h, under a new id, dated a day later.
- **Fixed in the importer (PR #17, 2026-10-04).** A pending row no longer stops counting just because Lunch Flow stopped returning it. It counts until a posted row of the same amount, booked 0–7 days later, supersedes it (`superseded_by`), or until it expires 7 days after first seen ([architecture.md](architecture.md) import policy). The migration made the Amazon charge above count again.
- **Remaining effect:** a pending charge Lunch Flow never showed, because a newer one replaced it between refreshes, is missing until it posts. A charge that posts at a different amount, or is reversed, counts twice or stays counted for up to 7 days. Both settle within days; the owner accepted this.

## How reconnection shows up

**Not observed yet.** Every connection stayed `ACTIVE` and returned 200. What Tally would see is inferred from the API's behaviour and the importer's error handling, not observed:

| Signal | Tally records it as |
|---|---|
| 401/403 on our key | `config` error and `consecutive_failures` rising; the owner has to act |
| 404 on an account | `not_found`: the account is gone, or was reconnected under a new id |
| `status` other than `ACTIVE` | `provider_status`, shown on the account card |
| Runs succeed, but no new data for days | `last_data_change_at` and `newest_txn_date` stop moving. This is the likely silent case: a lapsed bank consent can leave Lunch Flow serving its old data with a 200. |

If reconnecting a bank gives the account a **new Lunch Flow id**, the importer creates a second `accounts` row and backfills the same history into it. Every transaction would then be counted twice. Nothing prevents that today.

## Free-tier headroom

From P1.8 (hourly cron, 2026-10-02 to 2026-10-03):

- **CPU is over the limit, as an accepted exception.** Cron runs take about 42 ms against 10 ms, almost all of it fixed cold-start overhead. Every run succeeded. `scripts/check-terminations.ts` watches for kills.
- **D1 writes:** 3.2% of the daily allowance on the busiest day, which included the backfill. Steady state is far lower, because unchanged re-imports write nothing.
- **Requests and subrequests** are negligible: about 5 Lunch Flow calls per run.
- The 3-hour cron cuts cron invocations from 24 to 8 a day. That also means 3× fewer over-limit runs for Cloudflare to count against the Worker.

## Blockers

None. Open risks:

1. The CPU exception, accepted on 2026-10-04 and monitored.
2. Duplicate history if a reconnection creates new account ids (above).
3. The Lunch Flow trial ending. A subscription (£4.99/month or £29.99/year) is needed to keep importing.

## What Phase 2 should allow for

1. **Show how fresh the data is.** Put "updated <time>" (last data change) next to the totals, and flag an account when `newest_txn_date` stops moving. The data is up to about a day old and the API can't say why.
2. **Show pending and posted spend separately in the budget** (owner plan, 2026-10-04). Count rows with `vanished_at IS NULL`, so pending charges count until they're superseded or expire. Note that the bank may hold pending charges Tally hasn't seen.
3. **Don't allow edits on pending transactions.** Pending ids are null and the supersede match is a heuristic (same amount, 0–7 days), so moving an override along `superseded_by` could land it on the wrong charge. The [phase-2-outline.md](phase-2-outline.md) rule for this should become "pending transactions aren't editable".
4. **Month boundaries use the booking date.** Keep the per-transaction counted-date override from the findings for purchases at the end of a month.
5. **Make reconnection safe.** Before Phase 2 relies on its totals, either link a new Lunch Flow account id to the existing account, or stop importing the old account and hide its rows, so history isn't counted twice.
