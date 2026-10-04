import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn, type SQLiteColumn } from "drizzle-orm/sqlite-core";

// See docs/schema-and-api.md. Timestamps are ISO-8601 UTC text; calendar dates are
// YYYY-MM-DD text and never pass through Date. Money is integer minor units,
// negative = money out / more owed.
//
// CHECKs repeat the TypeScript types in SQL because the importer's json_each upserts
// bypass Drizzle: SQLite would otherwise keep 12.3 in an INTEGER column or 'true' as text.

export const PROVIDERS = ["lunchflow"] as const;
export const IMPORT_TRIGGERS = ["cron", "manual"] as const;
export const IMPORT_RUN_STATUSES = ["running", "success", "partial", "failed", "skipped_locked"] as const;

// Values are inlined (not bound) because drizzle-kit writes CHECKs into the migration as SQL text.
const isOneOf = (col: SQLiteColumn, values: readonly string[]) =>
  sql`${col} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
const isBool = (col: SQLiteColumn) => sql`${col} IN (0, 1)`;
const isInteger = (col: SQLiteColumn) => sql`typeof(${col}) = 'integer'`;

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
    check("transactions_amount_minor_ck", isInteger(t.amountMinor)),
    // date() normalises or nulls anything that isn't a real YYYY-MM-DD calendar date.
    check("transactions_txn_date_ck", sql`date(${t.txnDate}) IS ${t.txnDate}`),
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
