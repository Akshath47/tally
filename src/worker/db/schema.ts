import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
  type SQLiteColumn,
} from "drizzle-orm/sqlite-core";

// See docs/schema-and-api.md. Timestamps are ISO-8601 UTC text; calendar dates are
// YYYY-MM-DD text and never pass through Date. Money is integer minor units,
// negative = money out / more owed.
//
// CHECKs repeat the TypeScript types in SQL because the importer's json_each upserts
// bypass Drizzle: SQLite would otherwise keep 12.3 in an INTEGER column or 'true' as text.

export const PROVIDERS = ["lunchflow"] as const;
export const IMPORT_TRIGGERS = ["cron", "manual"] as const;
export const IMPORT_RUN_STATUSES = ["running", "success", "partial", "failed", "skipped_locked"] as const;
export const CATEGORY_KINDS = ["budgeted", "tracked", "excluded"] as const;
export const MATCH_TYPES = ["exact", "contains"] as const;
export const NOTE_MAX_LENGTH = 500;

// Values are inlined (not bound) because drizzle-kit writes CHECKs into the migration as SQL text.
const isOneOf = (col: SQLiteColumn, values: readonly string[]) =>
  sql`${col} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
const isBool = (col: SQLiteColumn) => sql`${col} IN (0, 1)`;
const isInteger = (col: SQLiteColumn) => sql`typeof(${col}) = 'integer'`;
// date() normalises or nulls anything that isn't a real YYYY-MM-DD calendar date; NULL passes.
const isDate = (col: SQLiteColumn) => sql`date(${col}) IS ${col}`;
const isMonth = (col: SQLiteColumn) => sql`date(${col} || '-01') IS ${col} || '-01'`;
const isTrimmedNonEmpty = (col: SQLiteColumn) => sql`${col} = trim(${col}) AND ${col} <> ''`;

// Drizzle's sqlite text() has no collation option. NOCASE folds ASCII only.
const nocaseText = customType<{ data: string }>({ dataType: () => "text COLLATE NOCASE" });

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey(),
    provider: text("provider", { enum: PROVIDERS }).notNull(),
    // Lunch Flow ids are numbers; stored as text so a provider change can't break them.
    providerAccountId: text("provider_account_id").notNull(),
    providerConnectionId: text("provider_connection_id"),
    // A display label, never the raw IBAN Lunch Flow returns as Revolut's name.
    name: text("name").notNull(),
    institutionName: text("institution_name"),
    // From the balance endpoint (the accounts endpoint omits it), so null until a balance
    // call succeeds; that call failing mustn't stop the account being recorded.
    currency: text("currency"),
    providerStatus: text("provider_status").notNull(),
    balanceMinor: integer("balance_minor"),
    balanceFetchedAt: text("balance_fetched_at"),
    // No default: the importer decides (off for non-GBP accounts).
    importEnabled: integer("import_enabled", { mode: "boolean" }).notNull(),
    lastSeenInProviderAt: text("last_seen_in_provider_at"),
    lastImportAttemptAt: text("last_import_attempt_at"),
    lastImportSuccessAt: text("last_import_success_at"),
    // Sanitised and truncated; never a raw provider response.
    lastImportError: text("last_import_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    // Last import that inserted or changed a transaction.
    lastDataChangeAt: text("last_data_change_at"),
    newestTxnDate: text("newest_txn_date"),
    backfillCursorDate: text("backfill_cursor_date"),
    backfillComplete: integer("backfill_complete", { mode: "boolean" }).notNull().default(false),
    // Set when an account reconnected under a new provider id is linked: a catch-up backfill
    // stops here instead of re-reading the full history (docs/phase-2-spec.md, Reconnection).
    backfillFloorDate: text("backfill_floor_date"),
    // A provider account first seen once Tally already had accounts. It isn't imported until
    // the owner enables it or links it to an existing account, so a reconnect can't double history.
    needsReview: integer("needs_review", { mode: "boolean" }).notNull().default(false),
    // On a review row that was linked: the account its provider id now belongs to. The row keeps
    // the target's old provider id, disabled, so that id is never seen as new again.
    mergedIntoAccountId: integer("merged_into_account_id").references((): AnySQLiteColumn => accounts.id),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("accounts_provider_account_uq").on(t.provider, t.providerAccountId),
    check("accounts_provider_ck", isOneOf(t.provider, PROVIDERS)),
    check("accounts_balance_minor_ck", sql`${t.balanceMinor} IS NULL OR ${isInteger(t.balanceMinor)}`),
    check("accounts_import_enabled_ck", isBool(t.importEnabled)),
    check("accounts_backfill_complete_ck", isBool(t.backfillComplete)),
  ],
);

export const importRuns = sqliteTable(
  "import_runs",
  {
    id: integer("id").primaryKey(),
    trigger: text("trigger", { enum: IMPORT_TRIGGERS }).notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    status: text("status", { enum: IMPORT_RUN_STATUSES }).notNull(),
    errorSummary: text("error_summary"),
  },
  (t) => [
    check("import_runs_trigger_ck", isOneOf(t.trigger, IMPORT_TRIGGERS)),
    check("import_runs_status_ck", isOneOf(t.status, IMPORT_RUN_STATUSES)),
  ],
);

// Bank-sourced fields only; the importer is the only writer. User edits (Phase 2)
// go in a separate table keyed by transactions.id. Rows are never deleted.
export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    providerTxnId: text("provider_txn_id").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    // The provider's original decimal, as text.
    providerAmount: text("provider_amount").notNull(),
    currency: text("currency").notNull(),
    txnDate: text("txn_date").notNull(),
    // Untrusted bank text.
    merchant: text("merchant").notNull(),
    description: text("description").notNull(),
    isPending: integer("is_pending", { mode: "boolean" }).notNull(),
    // account|date|amount|normalised description; diagnostic only, not unique.
    fingerprint: text("fingerprint").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    // Set on insert and whenever the importer changes the row; an unchanged re-import never touches it.
    lastSeenAt: text("last_seen_at").notNull(),
    // Set when a row stops counting: a pending row superseded by its posted version, or one
    // that expired (src/worker/importer/pending.ts). Cleared if an unsuperseded row reappears.
    vanishedAt: text("vanished_at"),
    // The posted row that replaced this pending one.
    supersededBy: integer("superseded_by").references((): AnySQLiteColumn => transactions.id),
    updatedAt: text("updated_at").notNull(),
    firstImportRunId: integer("first_import_run_id")
      .notNull()
      .references(() => importRuns.id),
  },
  (t) => [
    uniqueIndex("transactions_account_provider_txn_uq").on(t.accountId, t.providerTxnId),
    index("transactions_account_date_idx").on(t.accountId, t.txnDate),
    index("transactions_fingerprint_idx").on(t.fingerprint),
    index("transactions_superseded_by_idx").on(t.supersededBy),
    // From a merchant's match to its transactions (the inbox), and a month or page by date.
    index("transactions_account_merchant_idx").on(t.accountId, t.merchant),
    index("transactions_txn_date_idx").on(t.txnDate),
    check("transactions_amount_minor_ck", isInteger(t.amountMinor)),
    check("transactions_txn_date_ck", isDate(t.txnDate)),
    check("transactions_is_pending_ck", isBool(t.isPending)),
  ],
);

export const importRunAccounts = sqliteTable(
  "import_run_accounts",
  {
    runId: integer("run_id")
      .notNull()
      .references(() => importRuns.id),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    windowFrom: text("window_from"),
    windowTo: text("window_to"),
    fetched: integer("fetched").notNull().default(0),
    inserted: integer("inserted").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    vanishedMarked: integer("vanished_marked").notNull().default(0),
    error: text("error"),
    durationMs: integer("duration_ms"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.accountId] })],
);

// Single-row lease, claimed with a conditional write.
export const importLock = sqliteTable(
  "import_lock",
  {
    id: integer("id").primaryKey(),
    holderRunId: integer("holder_run_id").references(() => importRuns.id),
    expiresAt: text("expires_at"),
  },
  (t) => [check("import_lock_single_row_ck", sql`${t.id} = 1`)],
);

// Phase 2 (docs/phase-2-spec.md, Data model). The owner's edits live here, apart from the
// bank-sourced transactions, so a re-sync never touches them.

// Archived categories stay referenced by rules and overrides; they're only hidden from pickers.
export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey(),
    // The column collation makes both the UNIQUE index and plain `name = ?` lookups case-insensitive.
    name: nocaseText("name").notNull(),
    kind: text("kind", { enum: CATEGORY_KINDS }).notNull(),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("categories_name_uq").on(t.name),
    check("categories_name_ck", isTrimmedNonEmpty(t.name)),
    check("categories_kind_ck", isOneOf(t.kind, CATEGORY_KINDS)),
  ],
);

// A pattern is matched against lower(trim(merchant)), so it's stored in that form. SQLite's lower()
// and trim() are ASCII- and space-only, unlike JS's, so writers normalise in SQL: lower(trim(?)).
export const merchantRules = sqliteTable(
  "merchant_rules",
  {
    id: integer("id").primaryKey(),
    matchType: text("match_type", { enum: MATCH_TYPES }).notNull(),
    pattern: text("pattern").notNull(),
    // Null = any account.
    accountId: integer("account_id").references(() => accounts.id),
    // "Any account" as 0 (ids start at 1), since NULLs are distinct in a UNIQUE. A column, not an
    // index expression, so an upsert can name it: ON CONFLICT (match_type, pattern, account_scope).
    accountScope: integer("account_scope")
      .notNull()
      .generatedAlwaysAs(sql`coalesce("account_id", 0)`, { mode: "virtual" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("merchant_rules_scope_uq").on(t.matchType, t.pattern, t.accountScope),
    // An empty contains pattern would match every merchant.
    check("merchant_rules_pattern_ck", sql`${isTrimmedNonEmpty(t.pattern)} AND ${t.pattern} = lower(${t.pattern})`),
    check("merchant_rules_match_type_ck", isOneOf(t.matchType, MATCH_TYPES)),
  ],
);

// Every null field follows the bank values and the rules. The importer never writes here.
export const transactionOverrides = sqliteTable(
  "transaction_overrides",
  {
    transactionId: integer("transaction_id")
      .primaryKey()
      .references(() => transactions.id),
    categoryId: integer("category_id").references(() => categories.id),
    excluded: integer("excluded", { mode: "boolean" }).notNull().default(false),
    // Same sign convention as transactions.amount_minor.
    countedAmountMinor: integer("counted_amount_minor"),
    countedDate: text("counted_date"),
    // Untrusted text.
    note: text("note"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    // Rows a counted date moves into a month (src/worker/budget/resolve.ts, inMonth).
    index("transaction_overrides_counted_date_idx").on(t.countedDate).where(sql`${t.countedDate} IS NOT NULL`),
    check("transaction_overrides_excluded_ck", isBool(t.excluded)),
    check(
      "transaction_overrides_counted_amount_minor_ck",
      sql`${t.countedAmountMinor} IS NULL OR ${isInteger(t.countedAmountMinor)}`,
    ),
    check("transaction_overrides_counted_date_ck", isDate(t.countedDate)),
    // length() counts characters only for text; a BLOB would be measured in bytes.
    check(
      "transaction_overrides_note_ck",
      sql`${t.note} IS NULL OR (typeof(${t.note}) = 'text' AND length(${t.note}) <= ${sql.raw(String(NOTE_MAX_LENGTH))})`,
    ),
  ],
);

// Derived: which rule each (account, merchant) matches, so reads needn't match every merchant
// against every rule each time (docs/stored-matches-plan.md). Every transaction has a row. Only
// the triggers in migrations/0007_merchant_match_triggers.sql and REBUILD_MATCHES_SQL write
// here (src/worker/budget/matches.ts); rows are never deleted.
export const merchantMatches = sqliteTable(
  "merchant_matches",
  {
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    // Exactly as transactions.merchant.
    merchant: text("merchant").notNull(),
    // What exact rules compare against, so an exact rule's trigger can seek its merchants.
    merchantKey: text("merchant_key")
      .notNull()
      .generatedAlwaysAs(sql`lower(trim("merchant"))`, { mode: "virtual" }),
    // Null = no rule matches.
    ruleId: integer("rule_id").references(() => merchantRules.id),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.merchant] }),
    index("merchant_matches_rule_idx").on(t.ruleId),
    index("merchant_matches_key_idx").on(t.merchantKey),
  ],
);

// Budgets are positive = spend. A month's figure is the row with the greatest
// effective_month <= that month; writes only ever go to the current London month.
export const monthlyBudgets = sqliteTable(
  "monthly_budgets",
  {
    effectiveMonth: text("effective_month").primaryKey(),
    amountMinor: integer("amount_minor").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("monthly_budgets_effective_month_ck", isMonth(t.effectiveMonth)),
    check("monthly_budgets_amount_minor_ck", sql`${isInteger(t.amountMinor)} AND ${t.amountMinor} > 0`),
  ],
);

// 0 removes a category's allocation from that month on.
export const categoryBudgets = sqliteTable(
  "category_budgets",
  {
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id),
    effectiveMonth: text("effective_month").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.categoryId, t.effectiveMonth] }),
    check("category_budgets_effective_month_ck", isMonth(t.effectiveMonth)),
    check("category_budgets_amount_minor_ck", sql`${isInteger(t.amountMinor)} AND ${t.amountMinor} >= 0`),
  ],
);
