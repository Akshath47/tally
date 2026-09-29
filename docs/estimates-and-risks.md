# Estimates and risks

## Phase 1 effort

| Step | Hours |
|---|---|
| P1.0 Owner setup | 1–2 |
| P1.1 Probe + findings | 2–3 |
| P1.2 Scaffold | 2–3 |
| P1.3 Access + middleware | 2 |
| P1.4 Schema + migrations | 1–2 |
| P1.5 Importer + tests | 6–9 |
| P1.6 API + minimal UI | 3–4 |
| P1.7 Cron | 1 |
| P1.8 Usage report | 2 |
| P1.9 Verification + assessment | 2 |
| **Total** | **~20–30 focused hours** |

**Calendar time:** 1–2 weeks. P1.1 needs a second probe run 1–2 days after the first, and P1.7 needs at least 48 hours of cron runs. Finish Phase 1 well inside the Lunch Flow trial.

## Main uncertainties

1. **Amex through GoCardless:** whether it connects, how deep the history is, the sign convention, and how statement credits look.
2. **Pending transactions:** whether they're available for each account, and whether IDs stay the same when a transaction posts. This decides the Phase 2 override-migration rule.
3. **Freshness:**
   - Lunch Flow says it updates daily, and the API has no refresh endpoint.
   - If new transactions take more than a day to appear, the in-week tracking experience gets worse, and Tally can't fix that.
4. **Reconnection:**
   - It isn't documented how an expired UK consent shows up through the API.
   - Detect it with a per-account staleness signal plus `status` and error codes.
5. **Rate limits and pagination:**
   - Both are undocumented.
   - Stay conservative: cron every 6 hours after Phase 1, and manual imports with a 60 s cooldown.
6. **Free-tier limits:**
   - 10 ms CPU per invocation.
   - 50 D1 statements per invocation, with each `batch()` statement counted separately; this is why bulk upserts use `json_each`.
   - `ctx.access` is unavailable with Static Assets, so the Worker validates the JWT itself.
7. **Access inside an iOS standalone PWA:** the login flow can be awkward. It's tested early, in P1.3.
8. **Cost:**
   - Cloudflare should be £0.
   - Lunch Flow after the trial is £4.99/month or £29.99/year (the annual plan covers exactly 2 connections).
