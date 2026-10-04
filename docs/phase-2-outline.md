# Phase 2 outline: make the data useful for budgeting

This is an outline, not a spec. Screens and features will be decided while building. It starts only after the Phase 1 assessment gives a "go".

## Data additions

- `categories`
- `budgets`: amount in minor units with an effective-from month. No hard-coded amounts.
- `budget_buckets`: each maps a set of categories to its own budget.
- **Per-category budgets** (owner request, 2026-10-02): the owner sets aside a budget for each category ("topic"), e.g. groceries or eating out. A bucket holding a single category covers this, and multi-category buckets stay possible. Unbudgeted categories still count towards the overall total.
- **Re-categorising a transaction** (owner request, 2026-10-02): the owner can change which category a transaction belongs to. The choice is stored in `transaction_overrides.category_id`, so it survives re-sync and moves the spend to the new category's budget.
- `transaction_overrides`, keyed by `transactions.id`:
  - `category_id`
  - `excluded`
  - `counted_amount_minor`
  - `counted_date`
  - `note`
  - `updated_at`
  
  The importer never touches this table, so edits survive future syncs.
- **Editing a transaction's date or amount** (owner request, 2026-10-02): the editor lets the owner change either one. Edits go in `counted_date` / `counted_amount_minor` and never overwrite the bank values in `transactions`, which stay visible as the original.
- **Pending transactions aren't editable** (owner decision, 2026-10-04). Their ids are null and the importer matches each to its posted version only heuristically (same amount, 0–7 days, `superseded_by`), so an override moved along that link could land on the wrong charge. Edits apply to posted transactions only ([phase1-assessment.md](phase1-assessment.md)).

## Budgeting rules

- A transaction belongs to the month of its calendar date (`counted_date` if set, otherwise `txn_date`). Month boundaries and "today" are in `Europe/London`.
- Counted spend = `counted_amount_minor` if set, otherwise the normalised amount. Excluded transactions count as 0.
- Refunds count as negative spend in the original category.
- **Amex repayments from Revolut** are auto-detected as a pair (matching amounts within a few days) and excluded by default. The pairing can be edited.
- Other transfers go into an "excluded by default" category.

## Core screens (subject to iteration)

- A monthly combined feed covering both accounts.
- A header showing total counted spend and remaining budget, overall and per bucket.
- Spending by category.
- A mobile-first transaction editor in a bottom sheet, with category, include/exclude, date and amount.
- Budget and bucket settings.

## PWA

- Web app manifest, icons, `apple-mobile-web-app-*` meta tags and standalone display.
- A service worker that caches only the app shell. API calls always go to the network.
- No offline editing.

## Deferred

Native iOS packaging, AI features, complex forecasting, investments, net worth and offline editing.
