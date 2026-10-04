# Phase 1 assessment (P1.9)

This is the end-of-Phase-1 read on whether Lunch Flow → Tally is good enough to budget on, and what Phase 2 has to allow for. Like [lunchflow-findings.md](lunchflow-findings.md), it holds aggregate facts only: no merchants or real amounts.

**Evidence:** the production D1 (`import_runs`, `import_run_accounts`, `transactions`) from the first import on 2026-10-02 17:42 UTC to 2026-10-04 18:00 UTC, which is 49 hourly cron runs and 3 manual runs. CPU and D1 figures come from the P1.8 result in [phase-1-plan.md](phase-1-plan.md).

**Verdict:** go for Phase 2. There are no blockers. Posted data is about a day behind the bank, pending data is same-day, and pending transactions don't map cleanly onto their posted versions. Phase 2 has to be designed around those three facts.

## Spot check against the bank apps

> **Open (owner):** compare about 20 transactions per account in Tally's list with the Revolut and Amex apps: amount, sign, date, merchant and pending state. Record the result here as counts, e.g. "Revolut 20/20 match; Amex 19/20, 1 dated a day later (booking date)".

P1.1 already compared the raw API with the bank apps (Gate 1). This check covers what Tally added on top of the API: conversion to minor units, sign, date storage and the pending/vanished handling.

## Connection quality

- **No failures.** Both enabled accounts returned HTTP 200 on all 52 runs. Every run ended `success`, `consecutive_failures` is 0 and no account has an error recorded.
- `provider_status` stayed `ACTIVE` on all three accounts throughout.
- Both backfills are complete: about 2 years for Revolut, and the full card history for Amex.
- No rate limiting was seen, at about 5 Lunch Flow calls per run.
- The Revolut USD pocket stays disabled, as decided in P1.1.

## Staleness: bank → Lunch Flow → Tally

**Lunch Flow → Tally.** New transactions turned up in only **3 of the 49 hourly runs**: 10:00 and 19:00 UTC on 3 Oct, and 04:00 UTC on 4 Oct. Every other run re-read the same data unchanged. So Lunch Flow refreshes its stored data a few times a day, and an hourly poll adds at most an hour on top. The trigger times don't look regular, but two days is too short to call it a schedule.

**Bank → Tally**, measured from the start of the transaction's calendar date (UTC). The real purchase time is still open, below.

| Account | Kind | n | First seen in Tally |
|---|---|---|---|
| Revolut | pending | 1 | same day, about 10 h into it |
| Revolut | posted | 1 | the day after its booking date, about 28 h after its start |
| Amex | pending | 1 | same day, about 19 h into it |
| Amex | posted | 2 | the day after their booking date, about 34 h after its start |

- **Pending** transactions reach Tally the **same day** as the purchase.
- **Posted** transactions reach Tally about **a day after** their booking date. The booking date can itself be a day after the purchase ([lunchflow-findings.md](lunchflow-findings.md)).
- The sample is 5 transactions. It shows the shape, not reliable numbers.

> **Open (owner):** for a few of your purchases on 2–4 Oct, give the time you made them (from the bank app). Comparing those with `first_seen_at` turns "same day" and "a day later" into real hour counts.

**Effect of the 6-hour cron.** At 00/06/12/18 UTC, the three Lunch Flow refreshes above would have been picked up 2, 2 and 5 hours later than they were. The manual **Import from Lunch Flow** button still gets anything Lunch Flow already has.

## Missing fields

These are unchanged since P1.1:

- The accounts response has no `currency`. Tally takes it from the balance endpoint.
- Revolut's `description` is always empty, so `merchant` is the only text.
- `date` is the booking date, not the purchase date, for posted transactions.
- There's no freshness timestamp anywhere: no "last synced" on an account or connection. Tally can only infer freshness from when new data appears (`last_data_change_at`).

## Pending behaviour and ID stability

- **Posted ids are stable.** There are 0 duplicates by `(account_id, provider_txn_id)`. The 15 same-fingerprint pairs are explained in P1.7.
- **Pending ids are now always null.** All 3 pending transactions that production has seen, 2 on Amex and 1 on Revolut, came with `id: null`. In P1.1 Revolut's pending transaction had a 4-character id. So the importer's `nullid:` fingerprint key is the normal path for pending rows, not an edge case.
- **A pending transaction can disappear without a matching posted one.** An Amex pending row dated 2 Oct was marked vanished after about 25 h. No posted Amex transaction within 5 days has the same amount or the same merchant text. Either the charge was reversed, or it posted with a different amount and text.
  > **Open (owner):** check this charge in the Amex app and record which case it was.
- The Revolut pending row dated 3 Oct was still pending after about 32 h. P1.1's single Revolut example posted within about 29 h, under a new id, dated a day later.
- **Effect:** totals that skip `vanished_at` rows count each pending purchase once while it's pending. They can't rely on a posted twin turning up with the same amount.

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
- The 6-hour cron cuts cron invocations from 24 to 4 a day. That also means 6× fewer over-limit runs for Cloudflare to count against the Worker.

## Blockers

None. Open risks:

1. The CPU exception, accepted on 2026-10-04 and monitored.
2. Duplicate history if a reconnection creates new account ids (above).
3. The Lunch Flow trial ending. A subscription (£4.99/month or £29.99/year) is needed to keep importing.

## What Phase 2 should allow for

1. **Show how fresh the data is.** Put "updated <time>" (last data change) next to the totals, and flag an account when `newest_txn_date` stops moving. The data is up to about a day old and the API can't say why.
2. **Count pending transactions, and show them separately.** They are the only same-day signal, and they're excluded automatically once they vanish.
3. **Don't allow edits on pending transactions.** With null ids, and pending rows that can vanish without a same-amount posted twin, "move the override to the posted version" can't be automated safely. The [phase-2-outline.md](phase-2-outline.md) rule for this should become "pending transactions aren't editable".
4. **Month boundaries use the booking date.** Keep the per-transaction counted-date override from the findings for purchases at the end of a month.
5. **Make reconnection safe.** Before Phase 2 relies on its totals, either link a new Lunch Flow account id to the existing account, or stop importing the old account and hide its rows, so history isn't counted twice.
