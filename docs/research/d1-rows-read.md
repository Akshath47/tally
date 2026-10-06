# D1 rows read: why one day of UI use hit 80% of the free tier

Investigated 2026-10-05, after Cloudflare warned that the account had used 4M of the 5M
`rows_read` a day allowed on the free tier. Nothing new ran that day apart from the first real
use of the UI: creating categories, setting budgets and sorting merchants in To sort.

All numbers below come from `test/rows-read.probe.spec.ts`, which seeds a synthetic ledger and
records D1's own `meta.rows_read` for every statement each API call runs. Run it with:

```
npx vitest run test/rows-read.probe.spec.ts --silent=false --reporter=verbose
```

Local D1 (workerd's SQLite) reports `rows_read` the same way the hosted D1 bills it. The real
ledger's size isn't known here; the probe assumes about two years of two accounts.

## Result

The cron importer is not the cause. One steady-state run reads about 12.5k rows at 4,000
transactions (8 runs a day is about 100k, 2% of the cap).

The cause is that **every read that shows a category re-resolves the category of every
transaction ever imported, at about 9 to 10 rows read per transaction**, and **every write in the
UI refetches several of those reads at once**.

Synthetic ledger: 4,000 transactions, 909 distinct merchants, 150 exact and 10 contains rules,
200 overrides.

| API call | rows read |
| --- | ---: |
| `GET /api/categories`, `/accounts`, `/budget`, `/import-runs` | 2 to 31 each |
| `GET /api/months/:month/summary` | 37,306 |
| `GET /api/rules` | 61,371 |
| `GET /api/inbox?limit=100` | 41,257 |
| `GET /api/inbox/merchants` | 34,928 |
| `GET /api/transactions` (one month, 100 rows) | 19,565 |
| `GET /api/months/:month/transactions` (one Home line, added in #39) | 23,305 |
| `PUT /api/transactions/:id/override` | 14,684 |
| `POST /api/rules` | 3 |

What one tap costs once the UI refetches the open screen:

| Action | rows read |
| --- | ---: |
| To sort: file a merchant group | 76,208 |
| To sort: file one transaction | 90,879 |
| Open Home (this month and the two before) | 112,115 |
| Open Categories | 99,193 |
| Open Transactions (one month) | 56,062 |

It scales linearly with history. At 1,500 transactions filing a group costs 24k; at 8,000 it
costs 161k and opening Home costs 228k.

So 4M rows is about 50 merchant groups filed in To sort, or fewer with screen changes, Undo taps
and app switches in between. That matches a first afternoon of sorting.

## Where the rows go

### 1. `RESOLVED_CTE` resolves the whole history on every request

`src/worker/budget/resolve.ts` works out each transaction's category when data is read
(override, then best rule, then none), as `docs/phase-2-spec.md` decided. Every listing,
summary, inbox and rules call evaluates it over **all** transactions. From `EXPLAIN QUERY PLAN`
and `rows_read` on 4,000 transactions:

| Part of the CTE | rows read |
| --- | ---: |
| `SELECT DISTINCT account_id, merchant FROM transactions` (full scan) | 4,000 |
| Each distinct merchant: one exact-rule seek, plus a scan of every contains rule | about 12,000 (909 × (1 + 10 + 2)) |
| `resolved`: scan `transactions`, then per row an override seek, a seek into an automatic index on `merchant_rule`, a rule seek | about 17,000 |
| **Whole CTE** | **33,145** |

D1 counts primary-key and index seeks as rows read, even when they find nothing, so each join
adds about one row per transaction. Consumers then add their own work on top: the listing joins
`transactions` again and sorts with a window `count(*)`, and `GET /api/rules` grouped over
`resolved` reads about 60k.

`merchant_rule` is `MATERIALIZED`, so it's built in full even when the query only wants one
row. That's why `PUT /api/transactions/:id/override` costs 14.7k: the write itself is a few
rows, and returning the one updated transaction (`getTransaction`) resolves all 909 merchants.
The same row, resolved on its own with per-row subqueries, reads 5.

P2.3 pinned this CTE under 20k rows at 600 transactions (`test/budget/resolve.spec.ts`), and
`docs/phase-2-plan.md` noted it as a cost to watch after the first big sort. The budget was
right for 600 transactions and one call; the real history is a few thousand transactions and
each tap makes several calls.

### 2. Every write refetches every open query

`src/web/main.tsx` invalidates every query (except import runs) after any successful mutation.
TanStack refetches the active ones straight away and marks the rest stale, so they refetch on
the next screen visit. In To sort, one tap means:

- the write (3 rows for a rule, about 15k for an override, above);
- `GET /api/inbox/merchants` and every loaded page of `GET /api/inbox` (about 35k + 41k per page);
- `categories`, `accounts` and `budget` (cheap).

Undo and "Always" in the toast are mutations too, so they cost the same again. Every other
screen's queries are now stale, so the next visit to Home refetches three month summaries
(112k), and Categories refetches rules and the summary (99k).

TanStack also refetches stale active queries when the window regains focus (`staleTime` is
30 s and `refetchOnWindowFocus` is on by default), so switching back to the app on the phone
after 30 s refetches the open screen.

## Options

### A. Fewer refetches (web only, no spec change)

- In To sort, update the cached merchant groups and inbox rows from the write's own response
  (remove the filed group or row) and mark the other queries stale without refetching them.
  Filing a group then costs the write alone (3 rows); the screens catch up on their next visit.
- Invalidate per mutation instead of everything: a budget edit doesn't need the inbox, a
  category rename doesn't need transactions.
- Turn off `refetchOnWindowFocus`; the import watcher already refreshes after imports.
- Fetch the previous months' summaries only when Home shows them, or longer-lived (they change
  only when an old transaction is re-sorted).

### B. Cheaper reads (worker only, no spec change)

- Resolve only the rows a query needs: `getTransaction` (every `PUT`/`DELETE` override
  response) drops from about 15k to under 10 by resolving its one row. A month's listing can
  resolve only that month's merchants, with an index on `txn_date` (`transactions` has only
  `(account_id, txn_date)` today, which a date-only filter can't use).
- Combine the three Home summaries into one call, so the inbox count and the CTE are evaluated
  once rather than three times.

The inbox, the merchant groups, the rules' counts and the inbox badge still need every
transaction resolved, so with A and B each of those stays at 35k to 60k at today's size and
grows about 9 rows per new transaction. A and B together take a sorting session from about
76k per tap to a few rows per tap, plus one or two full refreshes when leaving the screen.

### C. Store the resolved category (spec change)

Keep a table of each transaction's resolved category, updated when a rule, override or
category changes and when the importer adds rows. Reads then cost about the rows they return:
the inbox reads only uncategorised rows, a month's summary only that month. A rule change
costs one statement over the transactions it could match (cheap for exact rules with an
expression index on `lower(trim(merchant))`, a full scan for contains rules).

This reverses `docs/phase-2-spec.md`'s "categories are resolved when data is read, not
stored", and the importer would write a second table, so it's the owner's call.

## Checks the owner can run

Both show counts only, no transaction contents.

- Daily rows read for the last few days, to compare cron-only days with today (needs the
  analytics token from `docs/setup-responsibilities.md`):
  `node scripts/usage-report.ts --since 2026-09-30T00:00:00Z`
- The real ledger's size, to scale the tables above:
  `npx wrangler d1 execute tally-prod --remote --command "SELECT (SELECT count(*) FROM transactions) AS txns, (SELECT count(*) FROM (SELECT DISTINCT account_id, merchant FROM transactions)) AS merchants, (SELECT count(*) FROM merchant_rules WHERE match_type = 'contains') AS contains_rules"`
