# Phase 2: budgeting backend

> **For agentic workers:** use superpowers:executing-plans to work through this task by task, and superpowers:test-driven-development for every code step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the backend for the first usable Phase 2 cut: reconnection safety, categories, merchant rules, overrides, the inbox, budgets and the month summary.

**Architecture:** new D1 tables next to the importer-owned `transactions`. Categories are resolved in SQL when data is read (override, then rule, then none). Budgets are effective-month rows. Every new route sits on the existing Hono `/api` with the same auth, CSRF and Origin checks.

**Tech stack:** Cloudflare Workers, Hono, D1 with Drizzle (`drizzle-kit generate`), zod, and Vitest with `@cloudflare/vitest-plugin`.

**Spec:** [phase-2-spec.md](phase-2-spec.md). This plan argues from it, so read both.

Status: `[ ]` = not started. Each step has its own branch, `feat/<step>`, and PR. Before a PR: `code-review`, then `simplify`, then `security-review` for any step that touches `/api/*`, and the step's **Accept when**.

Only P2.1 is broken into detailed tasks here. P2.2–P2.6 each build on the code from the step before, so their tasks are written into this file at the start of that step, using the same structure.

## Global constraints

- Money is integer minor units. Transactions keep the bank sign (negative = money out). Budget and spend figures are positive = spend. Never use float arithmetic on money.
- Dates are `YYYY-MM-DD` text and months are `YYYY-MM`. They never pass through `Date`, except for day arithmetic in `importer/dates.ts`. "Today" is `londonToday(now)`.
- The importer is the only writer of `transactions`, and transaction rows are never deleted.
- D1 free tier: 50 statements per invocation and 100 bound params per statement. Bulk writes use one `json_each` statement per chunk.
- 10 ms of CPU per invocation: aggregation goes in SQL, not in the Worker.
- Test fixtures are synthetic only. No real merchant text in tests, migrations or seeds.
- Logs record counts, statuses and durations only.
- Errors are JSON `{error: "<code>"}` with the status codes in the spec, and nothing internal is leaked.
- Commits follow `<type>(<scope>): <summary>` with a `Phase: P2.x` trailer, and no attribution lines.

## Review focus

These are the inputs the spec implies most likely to break P2.1 for the owner. Each has a test in its task.

1. **Lunch Flow still lists the old account id after a reconnect.** It must not come back as a "new" account, and it must not be polled (Task 3, Task 4).
2. **A new account's balance call fails on a non-empty database.** It must not import, and it should retry the balance call on the next run while staying in review (Task 3).
3. **The first-ever run fails to learn one account's currency.** On the next run that account must auto-enable, not land in review, because review is decided when the row is created (Task 3).
4. **Linking into an account that has no transactions** (`newest_txn_date` null). It gets a normal full backfill instead of a 7-day catch-up (Task 2, Task 4).
5. **Linking an account into itself, into another review row, into a merged row, or linking twice.** These return `409`, and nothing is written (Task 4).

---

## [ ] P2.1 Reconnection guard and link

**Deliverable:**
- Once Tally has accounts, a new Lunch Flow account is recorded **awaiting review** and isn't imported.
- `POST /api/accounts/:id/enable` treats it as a genuinely new account.
- `POST /api/accounts/:id/link {intoAccountId}` moves the new provider id onto the existing Tally account, with a catch-up backfill that starts 7 days before that account's newest transaction. The old provider id stays recorded on the disabled review row, so it's never treated as new again.
- `GET /api/accounts` gains `needsReview` and hides merged rows.

**How the link works.** Every `accounts` row keeps exactly one provider id. Linking **swaps** the provider ids of the two rows in one D1 batch, which is atomic:

1. The review row P moves to a temporary id.
2. The target T takes P's new provider id.
3. P takes T's old provider id and becomes a disabled marker with `merged_into_account_id = T.id`.

Nothing is deleted, T keeps all its history, freshness fields and overrides, and the importer needs no special case for linked accounts. This settles the spec's "column or mapping table" question.

**Accept when:**
- `npm run check` passes (typecheck, lint and every test, including the new ones).
- `npm run db:migrate:local` applies the new migration, and `npm run db:check` passes.
- After the owner approves the merge: the migration is applied remotely and the Worker is deployed. The next scheduled run is `success` for both accounts, and `GET /api/accounts` shows both with `needsReview: false`.

A real reconnect can't be triggered on demand. The link path is accepted on its tests, and the open question in the spec (whether transaction ids survive a reconnect) stays open until it first happens.

### Task 1: Account columns and migration

**Files:**
- Modify: `src/worker/db/schema.ts` (the `accounts` table)
- Create: `migrations/0003_*.sql` (generated, then hand-edited for the inline CHECKs)
- Test: `test/schema.spec.ts`

**Interfaces:**
- Produces three columns:
  - `accounts.needs_review` integer bool, NOT NULL, default 0
  - `accounts.merged_into_account_id` integer, FK → `accounts.id`, nullable
  - `accounts.backfill_floor_date` text, nullable, a real date
- Drizzle fields: `needsReview`, `mergedIntoAccountId`, `backfillFloorDate`.

Adding a table-level `check()` to `accounts` would make drizzle-kit **rebuild the table**, which also touches the `transactions` foreign keys on production data. So the CHECKs go inline on the `ADD COLUMN`s. SQLite allows that, and it tests them against existing rows. They're hand-added to the generated SQL with a comment, the same way `0002` carries a hand-added `UPDATE`.

- [ ] **Step 1: write the failing tests** in `test/schema.spec.ts`:
  - `needs_review = 2` is rejected
  - `backfill_floor_date = '2026-02-30'` is rejected
  - a new account defaults to `needs_review = 0` with the other two columns null
  - `merged_into_account_id` pointing at a missing account is rejected (FK)
- [ ] **Step 2:** run `npx vitest run test/schema.spec.ts`. The expected failure is "no such column".
- [ ] **Step 3:** add the three fields to `accounts` in `schema.ts`, then run `npm run db:generate`. Edit the generated SQL to:

  ```sql
  ALTER TABLE `accounts` ADD `needs_review` integer DEFAULT 0 NOT NULL CHECK (`needs_review` IN (0, 1));--> statement-breakpoint
  ALTER TABLE `accounts` ADD `merged_into_account_id` integer REFERENCES accounts(id);--> statement-breakpoint
  ALTER TABLE `accounts` ADD `backfill_floor_date` text CHECK (`backfill_floor_date` IS NULL OR date(`backfill_floor_date`) IS `backfill_floor_date`);
  ```

- [ ] **Step 4:** run the schema tests, `npm run db:check` and `npm run db:migrate:local`. They should all pass.
- [ ] **Step 5:** commit: `feat(db): add account review, merge and backfill floor columns`, with the trailer `Phase: P2.1`.

### Task 2: Backfill floor in `backfillChunks`

**Files:**
- Modify: `src/worker/importer/windows.ts`
- Test: `test/importer/windows.spec.ts`

**Interfaces:**
- Produces: `backfillChunks(cursor: string | null, today: string, backfillDays: number, max = MAX_CHUNKS_PER_RUN, floorDate: string | null = null)`. The effective floor is the later of `today − backfillDays` and `floorDate`.

- [ ] **Step 1: write the failing tests:**
  - `backfillChunks(null, "2026-10-02", 730, 2, "2026-09-10")`: the floor is later than the incremental start (`2026-09-19`), so there are no chunks and `complete: true`.
  - `backfillChunks(null, "2026-10-02", 730, 2, "2026-08-01")`: chunks `2026-08-19..2026-09-18` and `2026-08-01..2026-08-18`, and `complete: true`.
  - A null `floorDate` behaves as it does today.
- [ ] **Step 2:** run `npx vitest run test/importer/windows.spec.ts`. The new tests should fail.
- [ ] **Step 3:** implement it. Compute `const floor = floorDate && floorDate > base ? floorDate : base`, where `base = addDays(today, -backfillDays)`.
- [ ] **Step 4:** run the windows tests. They should pass.
- [ ] **Step 5:** commit: `feat(importer): let an account's backfill stop at a floor date`, with the trailer `Phase: P2.1`.

### Task 3: Importer review guard

**Files:**
- Modify: `src/worker/importer/writes.ts`:
  - `upsertAccounts` takes `needsReview: boolean`
  - `AccountRow` gains `needs_review` and `backfill_floor_date`
  - `disableForeignAccount` becomes `recordWithoutImport`, which also sets `needs_review`
- Modify: `src/worker/importer/run.ts`:
  - `importAll` passes `known.results.length > 0`
  - `importAccount` holds review rows and passes the floor to `backfillChunks`
- Test: `test/importer/run.spec.ts` (a new `describe("runImport: new accounts after the first import")`)

**Interfaces:**
- Consumes: `backfillChunks(..., floorDate)` from Task 2.
- Produces (DB contract):
  - A row inserted while other accounts exist has `needs_review = 1`. Once its currency is known it has `import_enabled = 0`, it's never fetched, and it gets no `import_run_accounts` row.
  - A non-GBP new row has `needs_review = 0` (there's nothing for the owner to decide).

**Behaviour in `importAccount`:**
- Once the balance call has given a currency, a row with `needs_review = 1` and a GBP currency is written with `recordWithoutImport(..., needsReview: true)`, and the function returns `null`.
- A failed balance call keeps today's error path, so the next run retries it. `statusUpdate` passes `enabled: currency === BUDGET_CURRENCY && row.needs_review === 0`.

- [ ] **Step 1: write the failing tests.** Each first runs `basicWorld()` once so Tally has accounts, then adds account `{ id: 4, … GBP }` to the world:
  1. The new account is stored with its GBP currency, `needs_review = 1` and `import_enabled = 0`. It has no transactions, `/accounts/4/transactions` is never called, and the run is still `success` with 2 account summaries.
  2. A second run still doesn't fetch it.
  3. If its balance call returns 503, it has no currency and no transactions, and the next run (balance OK) holds it for review without importing.
  4. A new **USD** account is disabled with `needs_review = 0`.
  5. **Empty database:** the first run's balance fails for account 2. On the next run account 2 is enabled and imported (`needs_review = 0`).
  6. An account with `backfill_complete = 0` and `backfill_floor_date` set fetches no window older than the floor.
- [ ] **Step 2:** run `npx vitest run test/importer/run.spec.ts`. The new tests should fail, and the existing ones should still pass.
- [ ] **Step 3:** implement the writes and run changes described above.
- [ ] **Step 4:** run the whole suite: `npm test`.
- [ ] **Step 5:** commit: `feat(importer): hold new accounts for review once tally has accounts`, with the trailer `Phase: P2.1`.

### Task 4: Review endpoints

**Files:**
- Modify: `src/worker/routes/accounts.ts` (`needsReview` in the list, hide merged rows, `POST /:id/enable`, `POST /:id/link`)
- Test: `test/account-review.spec.ts`

**Interfaces:**
- Consumes: the columns from Task 1, and review rows created by the importer (Task 3). Tests can make one directly with SQL.
- Produces:
  - `POST /api/accounts/:id/enable` → `200 {ok: true}`. Errors: `404 not_found`, `409 not_awaiting_review`, `409 not_importable` (currency isn't GBP).
  - `POST /api/accounts/:id/link` with body `{intoAccountId}` → `200 {ok: true}`. Errors: `400 bad_request`, `404 not_found`, `409 not_awaiting_review`, `409 invalid_link_target`.
  - `GET /api/accounts` adds `needsReview` and leaves out rows where `merged_into_account_id IS NOT NULL`.

**Link batch.** P is the review row and T the target. Both are read first, and T must not be P, must have `needs_review = 0`, must not be merged, and must have the same currency as P. Then, in one batch:

```sql
UPDATE accounts SET provider_account_id = 'linking:' || id, updated_at = ?2 WHERE id = ?1;                 -- P
UPDATE accounts SET provider_account_id = ?3, provider_connection_id = ?4, provider_status = ?5,
  import_enabled = 1, last_import_error = NULL, consecutive_failures = 0,
  backfill_complete = 0, backfill_cursor_date = NULL,
  backfill_floor_date = CASE WHEN newest_txn_date IS NULL THEN NULL ELSE date(newest_txn_date, '-7 days') END,
  updated_at = ?2 WHERE id = ?1;                                                                             -- T, takes P's ids
UPDATE accounts SET provider_account_id = ?3, merged_into_account_id = ?4, needs_review = 0,
  import_enabled = 0, updated_at = ?2 WHERE id = ?1;                                                         -- P, takes T's old id
```

- [ ] **Step 1: write the failing tests**, using `app.request` with `Origin` and JSON headers as in `api.spec.ts`. They can run the importer through the fake world:
  1. `GET /api/accounts` shows `needsReview: true` for a review row.
  2. `enable` turns it into a normal account, and the next import backfills it.
  3. `link` swaps the ids, and the next import writes the new provider's transactions under the **old** account id.
  4. If the world returns the same transaction ids, the link adds no duplicate rows.
  5. The merged row is hidden from `GET /api/accounts`.
  6. If the world **still lists the old provider id**, no new account row appears and it isn't fetched.
  7. A target with no transactions gets `backfill_floor_date = NULL` (a full backfill).
  8. `409` (with rows unchanged) for: self-link, a target that is a review row, a target that is merged, linking a row twice, a currency mismatch, and `enable` on a normal account.
  9. `404` for unknown ids and `400` for `intoAccountId: "x"`.
- [ ] **Step 2:** run `npx vitest run test/account-review.spec.ts`. The tests should fail.
- [ ] **Step 3:** implement the routes. Use zod to parse the `:id` param and the body.
- [ ] **Step 4:** run `npm run check`.
- [ ] **Step 5:** run `security-review` on the branch, then commit: `feat(worker): add account review, enable and link endpoints`, with the trailer `Phase: P2.1`.

### Task 5: Docs

- [ ] Update [schema-and-api.md](schema-and-api.md) with the three columns and the two endpoints, and the import policy in [architecture.md](architecture.md) with the review rule.
- [ ] Mark P2.1's checkbox only after its **Accept when** has run, and commit: `docs: record the account review and link flow`.

---

## [ ] P2.2 Schema and seed

**Deliverable:**
- The tables `categories`, `merchant_rules`, `transaction_overrides`, `monthly_budgets` and `category_budgets`, with CHECKs (in `drizzle-kit`'s table-level form, since these are new tables): `kind` and `match_type` must be one of their listed values, `excluded` must be a bool, amounts must be integers, `effective_month` must match `YYYY-MM`, `counted_date` must be a real date, and `note` length ≤ 500.
- Unique indexes:
  - categories: name with `COLLATE NOCASE`
  - rules: `(match_type, pattern, coalesce(account_id, 0))`
  - category budgets: `(category_id, effective_month)`
- A seed migration with the 14 spec categories.

**Accept when:**
- the schema tests reject each bad value
- the migrations apply locally and `db:check` passes
- the seeded categories are listed with the correct kinds

## [ ] P2.3 Categories and rules

**Deliverable:**
- A `src/worker/budget/resolve.ts` SQL fragment that gives each counted transaction its `category_id` and `category_source`, following the spec's precedence.
- Category and rule routes (list, create, patch, archive/unarchive; rule delete).
- Rule counts in `GET /api/rules`.

**Accept when:**
- the resolution precedence tests pass (override > account-scoped exact > any-account exact > account-scoped contains > any-account contains; longer pattern wins; older rule breaks ties)
- a new rule re-sorts old rows and leaves overridden ones alone
- `security-review` is clean
- `npm run check` passes

## [ ] P2.4 Overrides, inbox and transaction fields

**Deliverable:**
- `PUT` and `DELETE /api/transactions/:id/override`, including `applyToMerchant`.
- `GET /api/transactions` gains the category and override fields and `editable`.
- `GET /api/inbox` and `GET /api/inbox/merchants`.

**Accept when:**
- tests cover:
  - `409 not_editable` on pending and vanished rows
  - an override with all default values removes its row
  - `applyToMerchant` writes a rule and no category override
  - uncategorised money in shows in the inbox and money out counts
  - merchant groups add up
- `security-review` is clean
- `npm run check` passes

## [ ] P2.5 Budgets

**Deliverable:**
- The effective-month lookup.
- `GET /api/budget`, `PUT /api/budget/overall` and `PUT /api/budget/categories/:categoryId`, with the spec's `409` and `422` responses.
- The allocation is zeroed when a kind changes or a category is archived. That hooks into the P2.3 patch route.

**Accept when:**
- `over_allocated` returns the correct `maxAllocatableMinor`
- `below_allocated` returns `minOverallMinor`
- past months keep their figures after an edit
- the BST/GMT "current month" tests pass
- `security-review` is clean
- `npm run check` passes

## [ ] P2.6 Month summary

**Deliverable:** `GET /api/months/:month/summary`, as in the spec.

**Accept when:**
- the spec's counting tests pass, along with pacing on the last day of the month and integer per-week figures
- a future month returns `400`
- one summary call stays under 10 D1 statements
- after deploy, one real summary from the owner's account matches a hand tally of a few categories (the owner checks this; nothing is committed)

**The first usable cut is done when P2.1–P2.6 are merged and deployed.** Bills, insights, stale-data warnings and the digest each get a short design before they're added here.
