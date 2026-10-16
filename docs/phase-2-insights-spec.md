# Phase 2 spec: insights, analytics and the weekly digest

This covers the later Phase 2 slices that [phase-2-spec.md](phase-2-spec.md) listed as Insights, Stale-data warnings and the Weekly email digest. It follows the owner's answers from 2026-10-14 to 2026-10-16. Where this spec and phase-2-spec.md differ on these features, this spec wins. The budgeting rules (what counts, months, pending, categories) stay in phase-2-spec.md and aren't repeated here.

**The UI is out of scope**, as before. The owner designs the screens from [insights-ui-brief.md](insights-ui-brief.md), which lists what each screen shows. This spec fixes the data, rules and API behind them.

## What it's for

Three jobs, weighted equally:

1. **Catch overspending early**: a warning while there's still time in the month to change course.
2. **Understand patterns**: how months compare and where the money trends.
3. **Find money to cut**: categories and charges that are out of line with normal.

Not wanted: recurring-charge or subscription detection, transaction search and filters, bills, forecasting beyond the current month, alert emails other than the weekly digest, and AI. Insights are fixed rules with fixed thresholds. Financial data is never sent to an AI service ([CLAUDE.md](../.claude/CLAUDE.md)).

## Decisions

| Topic | Decision |
|---|---|
| How figures are computed | Worked out when read, in SQL, from the same month-seeking queries the month summary uses. Nothing is precomputed or cached. Categories are resolved at read time, so a rule change re-sorts history straight away, and a stored rollup would go stale. A month costs a few hundred rows read. |
| Insights | Fixed rules over those figures, in plain TypeScript. Thresholds are named constants in one module. No stored insight rows and no dismissing in v1. |
| Analytics range | Trends and the merchant history cover **6 months**: the current month and the 5 before it. |
| Monthly review | Completed months only. The current month's progress is covered by insights. |
| Week | Monday to Sunday in `Europe/London`, by counted date. |
| Digest delivery | Email, **Sunday 18:00 London**, covering Monday to Sunday so far. Sent only to `ALLOWED_EMAIL` with Cloudflare Email Service's `send_email` binding, from an address on the owner's own domain. The owner already agreed in phase-2-spec.md that these figures may leave Cloudflare by email. |
| Digest cost | Free. Cloudflare's pricing page (updated 2026-06-09): "Sending to verified destination addresses in your account is free on all plans." `ALLOWED_EMAIL` is verified as a destination, so no paid plan is enabled. Sending to any other address would need Workers Paid, and Tally never does. |
| Stale data | An enabled account is stale when its `last_data_change_at` is 4 or more days old. This settles the open question in [ui-design.md](ui-design.md). |
| Navigation | A fourth tab, **Insights** (owner decision). |

## Definitions shared by every slice

- **Spend, budget spend, tracked spend, counted month, counted date, pending**: as in phase-2-spec.md, "What a transaction counts as". Every figure here includes pending charges, and gives the pending part separately wherever a figure is shown on its own, so the UI can say "at least".
- **Merchant key**: `lower(trim(merchant))`, the same `merchant_key` that exact rules match on. One merchant key covers both accounts.
- **Merchant name**: the raw `merchant` text of the merchant's most recent transaction. It's untrusted text, as everywhere else.
- **Day of month** (`dom`): today's London day, 1–31. **Days in month** (`dim`): the current London month's length.
- **Completed month**: any month before the current London month.
- **Spending categories**: budgeted categories, tracked categories, and uncategorised spend (`categoryId: null`). Excluded categories and excluded rows never appear.
- All arithmetic is integer. Divisions are floored. Ratios are compared by cross-multiplying, never as floats.

## Stale data

- `GET /api/accounts` gains `stale` (bool) and `staleDays` (whole London days since `last_data_change_at`, null when it's never been set) on each enabled account.
- `GET /api/months/:month/summary` gains `staleAccountIds[]`, so Home can show its stale state without a second request. It's empty for a past month.
- `STALE_AFTER_DAYS = 4`.
- **Known limitation:** an account that's simply unused for 4 days, with nothing pending and nothing posted, looks stale too. The wording is "hasn't updated", which is still true, so that's accepted.

## Analytics API

New routes sit under `/api` behind the existing Access JWT, Origin and content-type checks. Money is integer minor units, and **positive = spend**. Months are `YYYY-MM`.

### `GET /api/months/:month/review`

The Monthly review for a completed month against the month before it. Returns `400` for the current month, a future month, or a bad parameter.

- `month`, `previousMonth`
- `totals` and `previousTotals`, each with:
  - `spentMinor` (budget spend)
  - `overallMinor` (null if that month had no budget)
  - `trackedMinor`
- `categories[]`: one per spending category with spend in either month, or an allocation in `month`:
  - `categoryId` (null = uncategorised), `kind`
  - `spentMinor`, `previousSpentMinor`
  - `changeMinor` = spent − previous
  - `allocatedMinor` (null when there's no allocation)
  - `over`: whether `spentMinor > allocatedMinor`
- `topMerchants[]`: the 5 merchants with the most budget plus tracked spend in `month`:
  - `merchantKey`, `name`, `spentMinor`, `visits` (how many counted transactions with spend > 0)
- `hasPrevious`: false when `previousMonth` has no counted transactions, e.g. the first month of history. The `previous*` figures are then 0, and the UI shouldn't show changes.

### `GET /api/trends`

The current month and the 5 before it, oldest first.

- `months[]`, one per month:
  - `month`, `partial` (true for the current month)
  - `spentMinor`, `pendingSpentMinor`, `overallMinor` (null if no budget), `trackedMinor`
  - `hasData`: false for months before the first counted transaction, so the UI can show "no history" rather than a zero
- `categories[]`, one per spending category with spend in the window:
  - `categoryId`, `kind`
  - `series[]`: 6 `spentMinor` values, aligned with `months`
  - `averageMinor`: the mean over completed months in the window that have data, floored. Null when no completed month has data.

### `GET /api/merchants?key=<merchantKey>`

One merchant's history. Returns `404` when no transaction has that key, and `400` for an empty key or one longer than 200 characters.

- `merchantKey`, `name`
- `categoryId` and `categorySource` for a new transaction from this merchant: the matching rule's category and `rule`, or null and null when no rule matches. Per-transaction overrides don't change this.
- `accountIds[]`: the accounts it has appeared on
- `firstSeenDate`: the earliest counted date, or null if none of its rows count
- `months[]`: 6 entries aligned with `/api/trends`, each with `month`, `spentMinor`, `visits`
- `windowSpentMinor`, `windowVisits`, and `averageChargeMinor` = window spend ÷ window visits, floored (null with no visits)
- `recent[]`: the 20 most recent transactions, newest first, in the same row shape as `GET /api/transactions`

## Insights

### `GET /api/insights`

Returns today's insights for the current London month, ranked, as structured data. The UI and the digest word them. Wording lives in **one module that both the web app and the digest import**, so the app and the email say the same thing.

Every item has:

- `id`: a stable string, e.g. `pace:category:12:2026-10`, for React keys and for telling the same insight apart from week to week
- `type`, `severity` (`over` | `warn` | `info`), and the type's fields below

The response is `{ asOf: 'YYYY-MM-DD', items: [...] }`. An empty list is a normal answer ("Nothing stands out").

### Types

| Type | Fires when | Fields | Severity |
|---|---|---|---|
| `stale_account` | An enabled account is stale (above). | `accountId`, `staleDays` | warn |
| `pace` (state `over`) | A budgeted category's spend is above its allocation (> 0) this month, or overall spend is above the overall budget. Any day of the month. | `categoryId` (null = the whole budget), `spentMinor`, `allocatedMinor`, `projectedMinor` | over |
| `pace` (state `projected_over`) | From day 8 of the month: not over yet, but `projected = floor(spent × dim ÷ dom)` is greater than the allocation. Checked for each allocated budgeted category and for the overall budget. | as above | warn |
| `unusual_category` | From day 8: a spending category's month-to-date spend is at least 1.5× its **baseline**, and at least £30 above it. Baseline = the mean of that category's spend over days 1 to `dom` (capped at each month's length) in the previous 3 months, counting only months that have data. It needs at least 2 such months. Categories that already have a `pace` item are skipped. | `categoryId`, `spentMinor`, `baselineMinor` | warn |
| `large_charge` | A transaction counted in the last 7 days (today and the 6 days before) with budget or tracked spend of at least £100, and either: **new**, with no earlier charges from that merchant key in the previous 6 months; or **out of line**, with at least 3 earlier charges in those 6 months and an amount at least 3× their average. With 1 or 2 earlier charges it doesn't fire. Pending rows qualify. | `transactionId`, `merchantKey`, `name`, `spentMinor`, `merchantAverageMinor` (null when new), `countedDate`, `isPending` | info |
| `month_change` | Days 1–7 of a month only: compares the last completed month with the one before. Up to the 3 spending categories with the biggest absolute change, where the change is at least £25 and at least 25% of the earlier month (a category with £0 the month before qualifies on the £25 alone). | `categoryId`, `month`, `spentMinor`, `previousSpentMinor`, `changeMinor` | info |

**Ranking:** `stale_account`, then `pace` over, `pace` projected_over, `unusual_category`, `large_charge`, `month_change`. Within a type, the larger amount comes first (spend over, projected over, excess above baseline, charge, absolute change). Everything is returned. The UI and digest decide how many to show.

**Thresholds** (one constants module, so tuning is a one-line change):

| Constant | Value |
|---|---|
| `STALE_AFTER_DAYS` | 4 |
| `PACE_FROM_DAY` / `UNUSUAL_FROM_DAY` | 8 |
| `UNUSUAL_RATIO` | 3/2 |
| `UNUSUAL_MIN_EXCESS_MINOR` | 3000 |
| `UNUSUAL_BASELINE_MONTHS` / `UNUSUAL_MIN_BASELINE_MONTHS` | 3 / 2 |
| `LARGE_CHARGE_MIN_MINOR` | 10000 |
| `LARGE_CHARGE_RATIO` / `LARGE_CHARGE_MIN_HISTORY` | 3 / 3 |
| `LARGE_CHARGE_LOOKBACK_DAYS` | 7 |
| `LARGE_CHARGE_HISTORY_DAYS` ("the previous 6 months") | 182 |
| `LARGE_CHARGE_MAX_CANDIDATES` (caps the reads per request) | 10 |
| `MONTH_CHANGE_MIN_MINOR` / `MONTH_CHANGE_MIN_PCT` | 2500 / 25 |
| `MONTH_CHANGE_SHOW_DAYS` / `MONTH_CHANGE_MAX` | 7 / 3 |

## Weekly digest

### Content

`GET /api/digest/preview` returns the digest for the week so far, as JSON. The Insights tab's "This week" card uses it, and it's how the digest is tested without sending anything.

- `weekStart` (Monday), `weekEnd` (today)
- `weekSpentMinor`, `weekPendingSpentMinor`: budget spend counted Monday to today. A week that spans two months includes both, and `spansMonths` is true.
- `month`: the current month's `spentMinor`, `pendingSpentMinor`, `overallMinor`, `leftMinor`, `perWeekMinor` and `daysRemaining`, exactly as in the month summary
- `categories[]`: each allocated budgeted category, plus Misc, with `categoryId` (null = Misc), `spentMinor`, `allocatedMinor` and `status`:
  - `over`: spend above the allocation
  - `projected_over`: the `pace` rule above
  - `near`: at least 90% of the allocation, the same rule as Home's amber flag
  - `ok`: otherwise
- `insights[]`: the same items as `GET /api/insights`
- `inboxCount`, `staleAccountIds[]`, `lastDataChangeAt`
- `lastSend`: `{ weekStart, status, sentAt }` for the latest scheduled send, or null. The UI can show "Last digest sent Sun 18:00" or that the last one failed.

### Sending

- **Schedule:** a second cron trigger, `0 17,18 * * SUN` (cron is UTC). The handler sends only when it's 18:00 in London, so the email arrives at 18:00 under both BST and GMT. `scheduled()` routes on `event.cron`, so the import cron (`0 */3 * * *`, which also fires at 18:00 UTC) and the digest never run each other's work. That makes 2 of the free tier's 5 cron triggers per account.
- **At most once a week:** `digest_sends` is keyed by `week_start`. The handler claims the week with a conditional insert before sending, and records `sent` or `failed`. A failed send isn't retried automatically, because the next cron hour isn't 18:00 London. The owner can send by hand.
- **By hand:** `POST /api/digest/send` sends the current week's digest straight away, behind the same Access, Origin and CSRF checks as the other `POST` routes. It doesn't touch the weekly claim. It's for the acceptance check and for re-sending a failed week.
- **The email:**
  - **From** `DIGEST_FROM` (a secret, so the domain stays out of the public repo). **To** `ALLOWED_EMAIL` only.
  - **Subject** has no figures, so lock-screen previews don't show amounts: "Your week in Tally · 12–18 Oct".
  - **Body:** a plain-text part plus a simple HTML part with inline styles, no images, no remote content and no tracking. Every interpolated string is HTML-escaped. Merchant names, which appear only in `large_charge` items, are untrusted.
  - **Order:** week spend, month spent against budget with left and per-week pace, category status, insights, then "N to sort", stale accounts, how fresh the data is, and a link to the app.
- **Configuration:**
  - a `send_email` binding
  - `DIGEST_FROM` and `APP_URL` as required secrets, so `wrangler deploy` refuses to deploy without them
  - a `DIGEST_ENABLED` var, so the cron can be paused without a code change
  - The binding doesn't list allowed destinations in `wrangler.jsonc`, because that would publish the address. The code only ever sends to `ALLOWED_EMAIL`, and the free tier only delivers to verified destinations anyway.
- **Logging:** status, duration and counts (items, categories). Never the body, subject figures or the address.
- **CPU:** the digest is the preview's queries plus string building, well inside 10 ms. P2.11 measures it like P1.8 did.

### Owner setup

Done by the owner. It can start any time, since nothing else depends on it:

1. On Cloudflare, add the domain as a zone. Recreate the website's existing DNS records there (copy them from Namecheap first), then switch the nameservers at Namecheap.
2. Enable Email Routing on the zone and verify `ALLOWED_EMAIL` as a destination address.
3. Onboard the domain to Email Sending if the verified-destination path needs it. P2.11 checks this, since the docs don't say clearly.
4. `wrangler secret put DIGEST_FROM` and `wrangler secret put APP_URL`, in the owner's own terminal.

## Rows read and limits

- Each new endpoint gets a ceiling in `test/rows-read.spec.ts`, on the existing synthetic ledger of 4,000 transactions over 2 years (about 170 a month): review 2k, trends 5k, merchant 1k, insights 6k, digest preview 8k. A few opens a day stay far below the free tier's 5M rows read a day. A ceiling that fails means a read isn't seeking; it's reported to the owner rather than raised.
- No endpoint scans the whole history. Merchant history seeks by merchant key. Baselines and trends read only their months.
- Every statement stays within D1's 50-statements and 100-parameters limits.

## Slices

Built in this order. Each gets steps with **Accept when** checks in [phase-2-plan.md](phase-2-plan.md).

1. **P2.8 Stale data.** The `stale` fields on accounts and the summary. It's the smallest slice and unblocks Home and Accounts states that are already designed.
2. **P2.9 Analytics API.** Review, trends and merchant history.
3. **P2.10 Insights.** The rules, ranking, thresholds module, the shared wording module, and `GET /api/insights`.
4. **P2.11 Weekly digest.** `digest_sends`, the preview and send routes, the cron routing, email rendering, and the owner's setup. Accept when a real digest arrives at 18:00 London on a Sunday.
5. **P2.12 Insights UI.** Built from the owner's designs once they exist. Until then, the backend slices go ahead on their own, as in Phase 2.

## Testing

Vitest in the workers pool, synthetic fixtures only. On top of the usual route and auth tests:

- **Stale:** 3 days isn't stale and 4 days is; a disabled account is never stale; null `last_data_change_at` gives null `staleDays`.
- **Review:** `400` for the current and future months; `hasPrevious` false in the first month; the top 5 merchants merge both accounts under one key; tracked spend counts towards merchants but not totals.
- **Trends:** 6 months aligned in every series; `hasData` false before history starts; the average skips the partial month and empty months.
- **Merchant:** `404` for an unknown key; the category comes from the rule, not from overrides; average charge is floored.
- **Insights, each rule tested at its edges:**
  - `pace` doesn't project on day 7 and does on day 8
  - `over` fires on day 1
  - projection uses integer maths, e.g. spent 1001 on day 3 of a 31-day month gives 10343
  - `unusual_category` at exactly 1.5× and £30 fires; just under either doesn't; it's silent with one baseline month
  - a baseline day past a short month's end caps at its last day
  - `large_charge`: new merchant at £100 fires and at £99.99 doesn't; 2 earlier charges never fires; exactly 3× fires
  - `month_change` shows on day 7 and not on day 8; £0 the month before qualifies on £25
  - the ranking order holds
- **Digest:**
  - the handler sends at 18:00 London and not at 17:00 or 19:00, on both sides of the BST change (`17:00Z` in summer, `18:00Z` in winter)
  - a second claim the same week sends nothing
  - a failed send records `failed` and logs no body
  - a week crossing a month boundary sets `spansMonths` and sums both months
  - HTML escaping of merchant names
  - manual send leaves the weekly claim alone

Every slice touches `/api/*`, so each runs `security-review` before it's committed.
