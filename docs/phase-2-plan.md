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

## [x] P2.1 Reconnection guard and link

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

**Done (2026-10-05):**
- On `main` after the merge of #20 and #21: `npm run check` passed with 293 tests.
- Earlier, on the branch: `0003` applied locally and `db:check` passed.
- `0003` was applied to production, and version `7881eb0a` was deployed.
- **Smoke run:** a manual import (run 55) used instead of waiting for the cron, since it runs the same code path. It ended `success`, with both imported accounts returning HTTP 200, and no account was flagged `needs_review` or merged.
- Logged-out `/api/health` still redirects to the Access login.

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

## [x] P2.2 Schema and seed

**Deliverable:**
- The tables `categories`, `merchant_rules`, `transaction_overrides`, `monthly_budgets` and `category_budgets`, with CHECKs (in `drizzle-kit`'s table-level form, since these are new tables): `kind` and `match_type` must be one of their listed values, `excluded` must be a bool, amounts must be integers, `effective_month` must match `YYYY-MM`, `counted_date` must be a real date, and `note` length ≤ 500.
- Unique indexes:
  - categories: name with `COLLATE NOCASE`
  - rules: `(match_type, pattern, account_scope)`, where `account_scope` is a generated column, `coalesce(account_id, 0)` (see Decisions)
  - category budgets: `(category_id, effective_month)`
- A seed migration with the 14 spec categories.

**Accept when:**
- the schema tests reject each bad value
- the migrations apply locally and `db:check` passes
- the seeded categories are listed with the correct kinds

This step adds tables only. Nothing reads or writes them until P2.3, so it changes no route and no importer behaviour. The remote migration waits for the owner's approval of the PR, like every other migration.

**Done (2026-10-05), on the branch:**
- `npm run check` passed with 350 tests. The 57 in `test/budget-schema.spec.ts` reject every bad value listed in Task 1.
  - Before the review fixes, a mutation run that dropped the NOCASE collation, the rule scope and the month, note and amount CHECKs failed exactly the 9 tests that pin them.
  - The 11 tests added for the review fixes each failed before their fix.
- `0004` and `0005` applied to a freshly reset local D1, `db:check` passed, and a second `db:generate` reported no changes.
- `wrangler d1 execute DB --local` listed the 14 seeded categories with their kinds: 8 budgeted, 2 tracked and 4 excluded.
- Still to do after the owner merges: `npm run db:migrate:remote` applies `0004` and `0005`. No Worker deploy is needed for this step, because no code reads the new tables yet.

**Decisions:**
- **The rule scope is a generated column**, `account_scope GENERATED ALWAYS AS (coalesce(account_id, 0)) VIRTUAL`, with a plain unique index on `(match_type, pattern, account_scope)`. An upsert can name it, `ON CONFLICT (match_type, pattern, account_scope)`, where an index expression would have to repeat the exact SQL text. drizzle-kit also splits index expressions at commas, so `coalesce(...)` can't go in an index directly. Account ids start at 1, so 0 is never a real account.
- **`categories.name` is `COLLATE NOCASE` on the column**, not just in the index. A plain `WHERE name = ?` then matches case-insensitively, which P2.3 needs to return `409 name_taken` before the insert fails. NOCASE folds ASCII only.
- **Rule patterns and category names are checked for normal form.**
  - A pattern must equal `lower(trim(pattern))` and be non-empty, because an empty `contains` pattern would match every merchant.
  - A name must be trimmed and non-empty.
  - SQLite's `lower()` and `trim()` are ASCII-only and spaces-only, so writers normalise patterns in SQL (`lower(trim(?))`), the same way merchants are matched, and not with JS `toLowerCase()`.
- **No extra indexes on the foreign-key columns yet.** Nothing queries `merchant_rules.category_id` or `transaction_overrides.category_id` until P2.3–P2.6. Adding an index later is a plain `CREATE INDEX`, without a table rebuild, so it waits for a query that needs it.
- **`category_budgets` gets a composite primary key** on `(category_id, effective_month)`, as the spec's data model shows, instead of a separate unique index. SQLite enforces it with a unique index anyway.
- **These are new tables, so their CHECKs are table-level `check()`s in `schema.ts`.** That's safe here, unlike the `ALTER TABLE accounts` in `0003`, because nothing references these tables yet and there's no existing data.
- **The seed is a separate custom migration** (`drizzle-kit generate --custom`), like `0001_seed_import_lock.sql`, so the schema migration stays purely generated.

### Review focus for P2.2

1. **Two any-account rules with the same pattern.** A plain `UNIQUE(match_type, pattern, account_id)` lets both in, because SQLite treats NULLs as distinct. The `account_scope` index must reject the second one (Task 1).
2. **A category name that differs only by case** (for example `groceries` next to the seeded `Groceries`). It must be rejected (Task 1, Task 2).
3. **A month that's almost `YYYY-MM`**: `2026-13`, `2026-1`, a full date `2026-10-01`, or the integer `202610`. All of them are rejected (Task 1).
4. **A non-integer amount**, such as `12.5` or the text `'-12.30'`, in any of the three amount columns. SQLite would keep it as REAL or TEXT without the CHECK (Task 1).
5. **A note of exactly 500 characters** is accepted, and 501 is rejected. SQLite's `length()` counts characters, so a non-ASCII note is limited by characters, not bytes (Task 1).

### Task 1: Phase 2 tables and CHECKs

**Files:**
- Modify: `src/worker/db/schema.ts` (add the five tables and the constants)
- Create: `migrations/0004_*.sql` and its snapshot (generated by `npm run db:generate`, not hand-edited)
- Test: `test/budget-schema.spec.ts` (new). It mirrors `test/schema.spec.ts`: raw SQL against the migrated D1, with synthetic values only.

**Interfaces:**
- Consumes: `accounts` and `transactions` from `schema.ts`, and `insertAccount`, `insertRun`, `insertTransaction`, `resetDb` and `NOW` from `test/db.ts`.
- Produces (`schema.ts` exports, which P2.3–P2.6 use):
  - `CATEGORY_KINDS = ["budgeted", "tracked", "excluded"] as const`
  - `MATCH_TYPES = ["exact", "contains"] as const`
  - `NOTE_MAX_LENGTH = 500`
  - tables `categories`, `merchantRules`, `transactionOverrides`, `monthlyBudgets`, `categoryBudgets`
- Produces (DB contract):

  ```
  categories            id PK · name text COLLATE NOCASE NOT NULL · kind NOT NULL · archived_at · created_at · updated_at
                        UNIQUE INDEX categories_name_uq (name)
  merchant_rules        id PK · match_type NOT NULL · pattern NOT NULL · account_id FK → accounts.id (null = any)
                        · account_scope GENERATED ALWAYS AS (coalesce(account_id, 0)) VIRTUAL
                        · category_id NOT NULL FK → categories.id · created_at · updated_at
                        UNIQUE INDEX merchant_rules_scope_uq (match_type, pattern, account_scope)
  transaction_overrides transaction_id PK FK → transactions.id · category_id FK → categories.id
                        · excluded NOT NULL DEFAULT 0 · counted_amount_minor · counted_date · note · updated_at NOT NULL
  monthly_budgets       effective_month PK · amount_minor NOT NULL · updated_at NOT NULL
  category_budgets      category_id FK → categories.id · effective_month · amount_minor NOT NULL · updated_at NOT NULL
                        PRIMARY KEY (category_id, effective_month)
  ```

  The CHECKs:
  - `kind` is in `CATEGORY_KINDS`, and `match_type` is in `MATCH_TYPES`
  - `name` is trimmed and non-empty
  - `pattern` equals `lower(trim(pattern))` and is non-empty
  - `excluded` is in `(0, 1)`
  - `counted_amount_minor` is NULL or an integer
  - `counted_date` is NULL or a real date (`date(x) IS x`)
  - `note` is NULL, or text with `length(note) <= 500`
  - in both budget tables, `effective_month` is a real month (`date(m || '-01') IS m || '-01'`)
  - `monthly_budgets.amount_minor` is an integer > 0
  - `category_budgets.amount_minor` is an integer ≥ 0

- [ ] **Step 1: write the failing tests** in `test/budget-schema.spec.ts`. Its `beforeEach` runs `resetDb()`, `insertAccount()`, `insertRun()` and `insertTransaction(accountId, runId, "t1")`, then inserts one category named `Synthetic category` of kind `budgeted`. Local helpers wrap one parameterised INSERT per table. Cases:
  - categories:
    - `kind` values `'Budgeted'`, `'income'` and `''` are rejected (CHECK)
    - `synthetic CATEGORY` is rejected as a duplicate (UNIQUE)
    - `WHERE name = 'SYNTHETIC category'` finds the row
    - the names `''`, `' Padded'` and `'Padded '` are rejected (CHECK)
    - every value in `CATEGORY_KINDS` is accepted
  - merchant_rules:
    - `match_type` values `'regex'` and `'Exact'` are rejected (CHECK)
    - the patterns `''`, `'Abc'`, `' abc'` and `'abc '` are rejected (CHECK)
    - the same `(exact, 'abc', NULL)` twice is rejected (UNIQUE)
    - the same `(exact, 'abc', accountId)` twice is rejected
    - `(exact, 'abc')` is accepted once as any-account and once account-scoped
    - `(contains, 'abc', NULL)` is accepted next to `(exact, 'abc', NULL)`
    - `ON CONFLICT (match_type, pattern, account_scope) DO UPDATE` updates the existing rule, for both any-account and account-scoped rules
    - an unknown `category_id` or `account_id` is rejected (FOREIGN KEY)
  - transaction_overrides:
    - a row with only `transaction_id` and `updated_at` stores `excluded = 0` and nulls elsewhere
    - `excluded` values `2` and `'true'` are rejected
    - `counted_amount_minor` values `12.5` and `'-12.30'` are rejected
    - `counted_date` values `'2026-02-30'`, `'2026-9-1'` and `'2026-10-01T00:00:00Z'` are rejected
    - a 500-character note is accepted, and a 501-character one is rejected
    - a 500-character note of a non-ASCII letter (`'é'.repeat(500)`) is accepted
    - a BLOB note is rejected
    - a second override for the same transaction is rejected (PRIMARY KEY)
    - an unknown `transaction_id` or `category_id` is rejected
  - monthly_budgets:
    - `effective_month` values `'2026-13'`, `'2026-1'`, `'2026-10-01'`, `202610` and `'2026-00'` are rejected
    - `'2026-10'` is accepted
    - `amount_minor` values `0`, `-100`, `12.5` and `'-12.30'` are rejected
    - a second row for the same month is rejected
  - category_budgets:
    - `amount_minor = 0` is accepted
    - `-1` and `1.5` are rejected
    - a bad `effective_month` is rejected
    - the same category and month twice is rejected
    - an unknown `category_id` is rejected
- [ ] **Step 2:** run `npx vitest run test/budget-schema.spec.ts`. The expected failure is "no such table".
- [ ] **Step 3:** add the tables to `schema.ts`, using the existing `isOneOf`, `isBool` and `isInteger` helpers plus these new ones:

  ```ts
  const isDate = (col: SQLiteColumn) => sql`date(${col}) IS ${col}`;
  const isMonth = (col: SQLiteColumn) => sql`date(${col} || '-01') IS ${col} || '-01'`;
  const isTrimmedNonEmpty = (col: SQLiteColumn) => sql`${col} = trim(${col}) AND ${col} <> ''`;
  const nocaseText = customType<{ data: string }>({ dataType: () => "text COLLATE NOCASE" });
  ```

  The rule scope:

  ```ts
  accountScope: integer("account_scope")
    .notNull()
    .generatedAlwaysAs(sql`coalesce("account_id", 0)`, { mode: "virtual" }),
  // …
  uniqueIndex("merchant_rules_scope_uq").on(t.matchType, t.pattern, t.accountScope),
  ```

  Then run `npm run db:generate`. Check that the generated SQL has `name text COLLATE NOCASE` and the `account_scope` generated column.
- [ ] **Step 4:** run the new tests, then `npm run check`, `npm run db:check` and `npm run db:migrate:local`. They should all pass. A second `npm run db:generate` should report no changes.
- [ ] **Step 5:** commit: `feat(db): add category, rule, override and budget tables`, with the trailer `Phase: P2.2`.

### Task 2: Category seed

**Files:**
- Create: `migrations/0005_seed_categories.sql` (from `npm run db:generate -- --custom --name seed_categories`)
- Test: `test/budget-schema.spec.ts`

**Interfaces:**
- Consumes: the `categories` table from Task 1.
- Produces: 14 unarchived categories in this id order. Later steps must look categories up by id or name, never by a hard-coded id.
  - budgeted: Groceries, Eating out, Transport, Bills, Shopping, Entertainment, Health, Other
  - tracked: Clothes, Travel
  - excluded: Savings, Investments, Card repayment, Income

- [ ] **Step 1: write the failing test.** After `resetDb()`, `SELECT name, kind, archived_at FROM categories ORDER BY id` equals the 14 rows above with `archived_at` null, and `created_at` matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`. A second test checks that inserting `groceries` is rejected as a duplicate of the seeded `Groceries`.
- [ ] **Step 2:** run it. The expected failure is that the list is empty.
- [ ] **Step 3:** generate the custom migration and fill it:

  ```sql
  -- The spec's starting categories (docs/phase-2-spec.md, Data model). The owner can rename or
  -- archive any of them. No merchant rules are seeded: a pattern is real merchant text.
  INSERT INTO `categories` (`name`, `kind`, `created_at`, `updated_at`)
  SELECT `column1`, `column2`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (VALUES
    ('Groceries', 'budgeted'), ('Eating out', 'budgeted'), ('Transport', 'budgeted'), ('Bills', 'budgeted'),
    ('Shopping', 'budgeted'), ('Entertainment', 'budgeted'), ('Health', 'budgeted'), ('Other', 'budgeted'),
    ('Clothes', 'tracked'), ('Travel', 'tracked'),
    ('Savings', 'excluded'), ('Investments', 'excluded'), ('Card repayment', 'excluded'), ('Income', 'excluded')
  );
  ```

  `INSERT … SELECT … FROM (VALUES …)` keeps the insert order, so the ids follow the listed order.
- [ ] **Step 4:** run `npm run check`, `npm run db:check` and `npm run db:migrate:local`. Then list the seed with `npx wrangler d1 execute DB --local --command "SELECT id, name, kind FROM categories ORDER BY id"`. That's the local D1 only. Never use `--remote` in this step.
- [ ] **Step 5:** commit: `feat(db): seed the starting categories`, with the trailer `Phase: P2.2`.

### Task 3: Docs

- [ ] Add the five tables to [schema-and-api.md](schema-and-api.md), marked (P2.2), and extend its CHECKs paragraph.
- [ ] Mark P2.2's checkbox only once its **Accept when** has run, then commit: `docs: record the phase 2 tables and category seed`.

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

This step is stacked on P2.2's branch (`feat/p2-2-schema-seed`) until P2.2 merges. Allocation zeroing on a kind change or archive belongs to P2.5, which hooks into this step's `PATCH /api/categories/:id`.

**Decisions:**
- **Merchant text is normalised the way SQLite does it.** Matching runs in SQL against `lower(trim(merchant))`, and SQLite's `lower()` only folds ASCII and its `trim()` only strips spaces. So patterns are normalised by `normalizePattern()`, which does exactly the same: spaces only, A–Z only. A pattern normalised by JavaScript's own `toLowerCase()` or `trim()` would never match a merchant like `CAFÉ` exactly.
- **`contains` uses `instr()`, not `LIKE`.** A `%` or `_` in a pattern is matched literally.
- **The resolution is exported as SQL text, `RESOLVED_CTE`.** It defines `merchant_rule` and `resolved`, covering every transaction, vanished ones included, and each consumer filters.
  - Each distinct (account, merchant) pair is matched once, in a `MATERIALIZED` CTE. Exact rules are an index lookup on `(match_type, pattern, account_scope)`, and only `contains` rules are scanned.
  - Transactions then join that list through an automatic index.
  - D1 bills rows read, so a test pins the cost. On 600 transactions, 120 merchants and 161 rules it's about 13k rows. Matching every transaction against every rule cost about 84k.
- **Body references:** an unknown or merged `accountId`, or an unknown `categoryId`, returns `404 not_found`, like an unknown path id. A rule can't point at an archived category (`409 category_archived`), since pickers hide them.
- **`DELETE` requests also need `Content-Type: application/json`.** The Phase 1 middleware requires it on every state-changing method.

### Review focus for P2.3

1. **Merchant text with non-ASCII letters or stray whitespace** (`CAFÉ`, a tab, a leading space). A rule made from it must match the same transactions SQLite would match (Task 1).
2. **A `contains` pattern holding `%` or `_`.** It matches literally, never as a wildcard (Task 1).
3. **A pending transaction.** Rules categorise it like any other. Overrides can't exist on it, but the resolution mustn't assume that (Task 1).
4. **Renaming a category to a different case of its own name** (`groceries` → `Groceries`). This is allowed, while taking another category's name in any case is `409 name_taken` (Task 2).
5. **A rule for a merged account, or for an archived category.** Both are refused, and a rule's transaction count leaves out vanished rows and overridden rows (Task 3).

### Task 1: Category resolution

**Files:**
- Create: `src/worker/budget/resolve.ts`
- Test: `test/budget/resolve.spec.ts`

**Interfaces:**
- Consumes: the `merchant_rules` and `transaction_overrides` tables (P2.2).
- Produces:
  - `normalizePattern(text: string): string`, which mirrors SQLite's `lower(trim(x))`.
  - `RESOLVED_CTE: string`, SQL text for `resolved AS (...)`, one row per transaction, with these columns:
    - `id`, `account_id`, `amount_minor`, `txn_date`, `merchant`, `is_pending`, `vanished_at`
    - `override_category_id`, `excluded`, `counted_amount_minor`, `counted_date`, `note`
    - `rule_id`
    - `category_id`
    - `category_source` (`'override'` / `'rule'` / NULL)

    Consumers write `WITH ${RESOLVED_CTE} SELECT ... FROM resolved`.

- [ ] **Step 1: write the failing tests**, with synthetic merchants and rows inserted with SQL. Each test inserts rules, then reads `category_id`, `category_source` and `rule_id` from `resolved`:
  - an override beats every rule
  - account-scoped exact > any-account exact > account-scoped contains > any-account contains
  - within contains, the longer pattern wins, then the lower id
  - a rule for another account doesn't apply
  - no match gives NULL category and source
  - `contains` with `%` matches literally
  - an exact rule made with `normalizePattern('  CAFÉ Nero ')` matches the merchant `CAFÉ NERO`, and `normalizePattern` equals SQLite's `lower(trim(x))` for a set of tricky strings
  - a rule added later re-sorts existing rows and leaves overridden ones alone
  - pending rows get rule categories
- [ ] **Step 2:** run `npx vitest run test/budget/resolve.spec.ts`. It should fail because the module is missing.
- [ ] **Step 3:** implement it.
- [ ] **Step 4:** run the tests. They should pass.
- [ ] **Step 5:** commit: `feat(worker): resolve each transaction's category from overrides and rules`, with the trailer `Phase: P2.3`.

### Task 2: Category routes

**Files:**
- Create: `src/worker/routes/categories.ts`
- Modify: `src/worker/index.ts` (mount it at `/categories`)
- Test: `test/categories.spec.ts`

**Interfaces:**
- `GET /api/categories` → `{categories: {id, name, kind, archived}[]}`, ordered by id, archived ones included.
- `POST /api/categories` with body `{name, kind}`. The name is trimmed and must be 1–50 characters. Returns `201 {category}`, `409 name_taken` or `400 bad_request`.
- `PATCH /api/categories/:id` with body `{name?, kind?, archived?}`, which must contain at least one key. Returns `200 {category}`, `404`, `409 name_taken` or `400`.

- [ ] **Step 1: write the failing tests:**
  - the 14 seeded categories are listed
  - create, then list
  - a duplicate name in a different case gets `409`
  - a bad kind, an empty or 51-character name, and an empty patch body get `400`
  - rename, a case-only rename of itself, a kind change, archive and unarchive
  - an unknown id gets `404`
  - requests with no `Origin` or a non-JSON `Content-Type` are rejected, as for the other routes
- [ ] **Step 2:** run the tests. They should fail.
- [ ] **Step 3:** implement it.
- [ ] **Step 4:** run `npm run check`.
- [ ] **Step 5:** commit: `feat(worker): add category routes`, with the trailer `Phase: P2.3`.

### Task 3: Rule routes

**Files:**
- Create: `src/worker/routes/rules.ts`
- Modify: `src/worker/index.ts` (mount it at `/rules`)
- Test: `test/rules.spec.ts`

**Interfaces:**
- Consumes: `normalizePattern` and `RESOLVED_CTE` from Task 1.
- `GET /api/rules` → `{rules: {id, matchType, pattern, accountId, categoryId, transactionCount}[]}`. `transactionCount` counts the rows where the rule is the deciding source and `vanished_at IS NULL`.
- `POST /api/rules` with body `{matchType, pattern, accountId?, categoryId}`. The pattern must be 1–100 characters after normalisation. Returns `201 {rule}`, `409 rule_exists`, `409 category_archived`, `404` (unknown or merged account, unknown category) or `400`.
- `PATCH /api/rules/:id` takes the same fields, all optional, with the same errors.
- `DELETE /api/rules/:id` → `200 {ok: true}` or `404`.

- [ ] **Step 1: write the failing tests:**
  - create normalises the pattern
  - the counts reflect resolution and leave out vanished and overridden rows
  - a duplicate (including two any-account rules) gets `409`
  - an archived category gets `409`
  - a merged or unknown account, or an unknown category, gets `404`
  - an empty pattern after trimming, or a bad `matchType`, gets `400`
  - patch moves the rule's transactions to the new category
  - delete returns its transactions to uncategorised
- [ ] **Step 2:** run the tests. They should fail.
- [ ] **Step 3:** implement it.
- [ ] **Step 4:** run `npm run check`.
- [ ] **Step 5:** run `security-review`, then commit: `feat(worker): add merchant rule routes`, with the trailer `Phase: P2.3`.

### Task 4: Docs

- [ ] Add the category and rule endpoints to [schema-and-api.md](schema-and-api.md), then commit: `docs: record the category and rule endpoints`.

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

**Done (2026-10-05), on the branch:**
- `npm run check` passed with 450 tests.
- The Accept when tests: `over_allocated` returns overall − the other allocations (and a category's own allocation doesn't count against it), `below_allocated` returns the current `allocated`, September's rows and figures survive October's edits, and writes at `2026-03-31T23:30Z` and `2026-10-31T23:30Z` land in `2026-04` and `2026-10`.
- `code-review`, `simplify` and `security-review` ran on the branch. `security-review` found nothing.
- No migration, so nothing to apply remotely. The Worker deploy waits for the owner's merge.

This step needs no migration: `monthly_budgets` and `category_budgets` exist since P2.2. It runs in parallel with P2.4 and doesn't touch P2.4's files (`routes/transactions.ts`, the inbox routes, `transaction_overrides` writes).

**Decisions:**
- **"Now" is the system clock.** The routes call `new Date()` like the other routes do, and tests move the clock with `vi.useFakeTimers({ toFake: ["Date"] })` and `vi.setSystemTime`. D1 calls still work under it, so `createApp` needs no clock option.
- **`londonMonth(now)` lives next to `londonToday` in `importer/dates.ts`**, as `londonToday(now).slice(0, 7)`. P2.6 reuses it.
- **The effective-month lookup is SQL text**, like `RESOLVED_CTE`. `effectiveOverallSql(month)` and `effectiveAllocationSql(categoryId, month)` take the placeholder or column to use and return a scalar subquery: the row with the greatest `effective_month` ≤ the month, by `ORDER BY effective_month DESC LIMIT 1`. For allocations that's a seek on the `(category_id, effective_month)` primary key, one per category. P2.6 composes the same fragments into its summary query.
- **`maxAllocatableMinor` is given per category** in `GET /api/budget`: overall − every other allocation, so it's the most that category can be set to. For a category with no allocation it equals `miscMinor`. The spec lists one `maxAllocatableMinor` without saying what it's for; per category is the figure the `422 over_allocated` response carries, so the UI can show the same limit before and after a refused write.
- **Both `PUT`s answer with the new budget**, the same body as `GET /api/budget`, so the UI doesn't need a second request.
- **Only budgeted, unarchived categories count towards `allocated`**, using their current kind (the spec: kinds aren't dated). Their rows in `GET /api/budget` are listed by id, with `allocatedMinor: 0` when they have no allocation.
- **Allocating to a category that isn't budgeted, or is archived, is `409 category_not_budgeted` or `409 category_archived`.** The spec requires both checks but names no codes; `category_archived` matches the rules route. The order is: `400` (bad id or body), `404` (unknown category), `409 category_archived`, `409 category_not_budgeted`, `409 overall_budget_not_set`, then `422 over_allocated`.
- **Zeroing follows the category's state, not the patch.** In the same `D1.batch` as the `UPDATE`, one upsert writes a 0 row for the current month when the category is now not budgeted or archived **and** its current effective allocation is above 0. A failed `UPDATE` (`name_taken`) rolls the batch back, so nothing is zeroed. A category with no allocation gets no row.
- **There is no lock between the validation read and the write** (the spec: one user). The write is a plain upsert on the current month's row.
- **Lowering a category's allocation is always allowed**, even when the budget is over-allocated (which the API never causes, but SQL written by hand could). Otherwise the owner couldn't get back under through the API.
- **Past months keep their rows, not their kinds.** Zeroing never touches an earlier month's row, but kinds aren't dated, so `readBudget` for a past month counts categories by their current kind, as the spec accepts.
- **A `0` allocation is accepted and stored**, since it's how an allocation is removed from a month on. The overall figure must be > 0, as its CHECK requires. Both must be safe integers.

### Review focus for P2.5

1. **Late evening in London around month ends.** At `2026-03-31T23:30Z` (BST) it's already April, so a write goes to `2026-04`. At `2026-10-31T23:30Z` (GMT) it's still October (Task 1, Task 3).
2. **An edit in a later month than the last row.** It inserts a new row for the current month and leaves the older row alone, so past months keep their figures. A second edit in the same month updates that month's row (Task 3).
3. **Raising a category's own allocation.** The limit leaves out the category's current allocation, so with overall 500 and Groceries at 300, setting Groceries to 500 is allowed. `maxAllocatableMinor` in the `422` is overall − the others (Task 3).
4. **A stale allocation on a category that's now tracked, excluded or archived.** It isn't part of `allocated`, so it doesn't block lowering the overall figure, and zeroing it leaves past months' rows alone (Task 2, Task 4).
5. **A `PATCH` that fails** (for example `409 name_taken`) together with a kind change. Nothing is zeroed (Task 4).
6. **Amounts that aren't safe integers**: `12.5`, `"1000"`, `2 ** 53`, and an overall figure of `0`. All are `400`, and nothing is written (Task 3).

### Task 1: The current London month

**Files:**
- Modify: `src/worker/importer/dates.ts`
- Test: `test/importer/dates.spec.ts`

**Interfaces:**
- Produces: `londonMonth(now: Date): string`, `YYYY-MM`.

- [ ] **Step 1: write the failing tests:**
  - `2026-03-31T23:30Z` is `2026-04` (BST)
  - `2026-10-31T23:30Z` is `2026-10` (GMT)
  - `2026-12-31T23:59Z` is `2026-12`, and `2027-01-01T00:00Z` is `2027-01`
- [ ] **Step 2:** run `npx vitest run test/importer/dates.spec.ts`. The new tests should fail.
- [ ] **Step 3:** implement it.
- [ ] **Step 4:** run the tests. They should pass.
- [ ] **Step 5:** commit: `feat(worker): add the current london month helper`, with the trailer `Phase: P2.5`.

### Task 2: Effective-month lookup

**Files:**
- Create: `src/worker/budget/effective.ts`
- Test: `test/budget/effective.spec.ts`

**Interfaces:**
- Consumes: `monthly_budgets`, `category_budgets` and `categories` (P2.2).
- Produces:
  - `effectiveOverallSql(month: string): string` and `effectiveAllocationSql(categoryId: string, month: string): string`, scalar subqueries. The arguments are SQL placeholders or column names, never values.
  - `readBudget(db: D1Database, month: string): Promise<BudgetRows>`, one statement, where `BudgetRows = { overallMinor: number | null; allocations: { categoryId: number; allocatedMinor: number }[] }` lists every budgeted, unarchived category by id.

- [ ] **Step 1: write the failing tests**, inserting budget rows with SQL:
  - with rows for `2026-08` and `2026-10`, the overall figure for `2026-07` is null, `2026-08` and `2026-09` give the August figure, and `2026-10` and `2026-12` give October's
  - each category's allocation comes from its own latest row ≤ the month, and a later `0` row gives `0`
  - tracked, excluded and archived categories aren't listed, even with an allocation
  - a budgeted category with no rows is listed with `0`
  - with no budgeted categories at all, the overall figure is still returned
- [ ] **Step 2:** run `npx vitest run test/budget/effective.spec.ts`. It should fail because the module is missing.
- [ ] **Step 3:** implement it.
- [ ] **Step 4:** run the tests. They should pass.
- [ ] **Step 5:** commit: `feat(worker): look up a month's effective budget figures`, with the trailer `Phase: P2.5`.

### Task 3: Budget routes

**Files:**
- Create: `src/worker/routes/budget.ts`
- Modify: `src/worker/index.ts` (mount it at `/budget`)
- Test: `test/budget.spec.ts`

**Interfaces:**
- Consumes: `londonMonth` (Task 1) and `readBudget` (Task 2).
- `GET /api/budget` → `{month, overallMinor, allocatedMinor, miscMinor, categories: {categoryId, allocatedMinor, maxAllocatableMinor}[]}`. Before the first overall figure, `overallMinor`, `miscMinor` and every `maxAllocatableMinor` are null.
- `PUT /api/budget/overall` with body `{amountMinor}`, a safe integer > 0. Returns `200` with the `GET` body, `422 {error:"below_allocated", minOverallMinor}` or `400`.
- `PUT /api/budget/categories/:categoryId` with body `{amountMinor}`, a safe integer ≥ 0. Returns `200` with the `GET` body, `404`, `409 category_archived`, `409 category_not_budgeted`, `409 overall_budget_not_set`, `422 {error:"over_allocated", maxAllocatableMinor}` or `400`.
- Both writes upsert the current London month's row.

- [ ] **Step 1: write the failing tests**, with the clock set by `vi.setSystemTime`:
  - `GET` before any budget: null figures, every budgeted category listed with `0`
  - set the overall figure, then allocate: `allocated`, `misc` and each `maxAllocatableMinor` add up
  - `over_allocated` returns overall − the other allocations, and raising a category's own allocation up to that limit works
  - `below_allocated` returns the current `allocated`, and lowering the overall figure exactly to `allocated` works
  - allocating before an overall figure is `409 overall_budget_not_set`
  - allocating to a tracked or archived category is `409`, and to an unknown one `404`
  - with the clock in September, set figures; move it to October and edit them: the September rows are unchanged, and `readBudget(db, "2026-09")` still gives the old figures
  - two edits in the same month leave one row for that month
  - at `2026-03-31T23:30Z` the write lands in `2026-04`, and at `2026-10-31T23:30Z` in `2026-10`
  - the bad bodies from Review focus 6 and a bad id are `400`, and nothing is written
  - a cross-site request and a non-JSON body are refused, as for the other routes
- [ ] **Step 2:** run `npx vitest run test/budget.spec.ts`. The tests should fail.
- [ ] **Step 3:** implement it.
- [ ] **Step 4:** run `npm run check`.
- [ ] **Step 5:** commit: `feat(worker): add the budget routes`, with the trailer `Phase: P2.5`.

### Task 4: Zero an allocation when its category stops counting

**Files:**
- Modify: `src/worker/routes/categories.ts` (the `PATCH` becomes a two-statement batch)
- Test: `test/categories.spec.ts`

**Interfaces:**
- Consumes: `londonMonth` and `effectiveAllocationSql`.
- Produces (DB contract): after a `PATCH` that leaves a category not budgeted or archived, its effective allocation for the current month is 0, and earlier months' rows are unchanged.

- [ ] **Step 1: write the failing tests:**
  - a category allocated in September; in October, changing it to tracked writes an October `0` row, and the September row is unchanged
  - the same for excluded, and for archiving
  - a rename, or a patch of a category with no allocation, writes no budget row
  - a kind change that fails with `409 name_taken` writes nothing
  - after unarchiving, the category is listed in `GET /api/budget` with `0`
- [ ] **Step 2:** run `npx vitest run test/categories.spec.ts`. The new tests should fail.
- [ ] **Step 3:** implement it.
- [ ] **Step 4:** run `npm run check`.
- [ ] **Step 5:** run `security-review`, then commit: `feat(worker): zero a category's allocation when it stops counting`, with the trailer `Phase: P2.5`.

### Task 5: Docs

- [ ] Add the three budget endpoints to [schema-and-api.md](schema-and-api.md), and the zeroing to the `PATCH /api/categories/:id` row, then commit: `docs: record the budget endpoints`.

## [ ] P2.6 Month summary

**Deliverable:** `GET /api/months/:month/summary`, as in the spec.

**Accept when:**
- the spec's counting tests pass, along with pacing on the last day of the month and integer per-week figures
- a future month returns `400`
- one summary call stays under 10 D1 statements
- after deploy, one real summary from the owner's account matches a hand tally of a few categories (the owner checks this; nothing is committed)

**The first usable cut is done when P2.1–P2.6 are merged and deployed.** Bills, insights, stale-data warnings and the digest each get a short design before they're added here.
