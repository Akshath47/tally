import type { CountingDb } from "./db";
import type { TransactionRow } from "./normalize";

// Every bulk write sends its rows as ONE json parameter read with json_each, so a chunk is
// one D1 statement instead of one per row (free tier: 50 statements per invocation).
// Chunks are capped by characters, well under D1's limits, to keep each statement small.
const MAX_CHUNK_CHARS = 60_000;

export function chunkJson<T>(items: T[], maxChars = MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 2;
  for (const item of items) {
    const json = JSON.stringify(item);
    if (current.length > 0 && size + json.length + 1 > maxChars) {
      chunks.push(`[${current.join(",")}]`);
      current = [];
      size = 2;
    }
    current.push(json);
    size += json.length + 1;
  }
  if (current.length > 0) chunks.push(`[${current.join(",")}]`);
  return chunks;
}

export type AccountPayload = {
  id: number;
  connection_id: number | null;
  /** Already a display label, never a raw IBAN. */
  name: string;
  institution_name: string;
  status: string;
};

export type AccountRow = {
  id: number;
  provider_account_id: string;
  currency: string | null;
  import_enabled: number;
  backfill_cursor_date: string | null;
  backfill_complete: number;
  backfill_floor_date: string | null;
  needs_review: number;
};

/**
 * Records every provider account. New accounts start disabled until their currency is known,
 * and with `needsReview` (Tally already had accounts) they stay disabled until the owner decides.
 */
export function upsertAccounts(db: CountingDb, now: string, accounts: AccountPayload[], needsReview: boolean) {
  return db
    .prepare(
      `INSERT INTO accounts (provider, provider_account_id, provider_connection_id, name, institution_name,
         provider_status, import_enabled, needs_review, last_seen_in_provider_at, created_at, updated_at)
       SELECT 'lunchflow', CAST(json_extract(j.value, '$.id') AS TEXT), CAST(json_extract(j.value, '$.connection_id') AS TEXT),
         json_extract(j.value, '$.name'), json_extract(j.value, '$.institution_name'), json_extract(j.value, '$.status'),
         0, ?3, ?1, ?1, ?1
       FROM json_each(?2) AS j WHERE true
       ON CONFLICT(provider, provider_account_id) DO UPDATE SET
         provider_connection_id = excluded.provider_connection_id, name = excluded.name,
         institution_name = excluded.institution_name, provider_status = excluded.provider_status,
         last_seen_in_provider_at = excluded.last_seen_in_provider_at, updated_at = excluded.updated_at
       RETURNING id, provider_account_id, currency, import_enabled, backfill_cursor_date, backfill_complete,
         backfill_floor_date, needs_review`,
    )
    .bind(now, JSON.stringify(accounts), needsReview ? 1 : 0);
}

/**
 * Inserts new transactions and updates only those whose bank fields changed (or that were
 * retired), so an identical re-import writes nothing. A returned row always counts again: a
 * superseded pending row the provider returns hasn't posted, so its link is cleared too. RETURNING yields one row per
 * insert or update; `inserted` tells them apart. Needs `WHERE true` on the SELECT so SQLite
 * doesn't read ON CONFLICT as part of a join.
 */
export function upsertTransactions(db: CountingDb, accountId: number, runId: number, now: string, rows: TransactionRow[]) {
  return chunkJson(rows).map((chunk) =>
    db
      .prepare(
        `INSERT INTO transactions (account_id, provider_txn_id, amount_minor, provider_amount, currency, txn_date,
           merchant, description, is_pending, fingerprint, first_seen_at, last_seen_at, vanished_at, updated_at, first_import_run_id)
         SELECT ?1, json_extract(j.value, '$.provider_txn_id'), json_extract(j.value, '$.amount_minor'),
           json_extract(j.value, '$.provider_amount'), json_extract(j.value, '$.currency'), json_extract(j.value, '$.txn_date'),
           json_extract(j.value, '$.merchant'), json_extract(j.value, '$.description'), json_extract(j.value, '$.is_pending'),
           json_extract(j.value, '$.fingerprint'), ?2, ?2, NULL, ?2, ?3
         FROM json_each(?4) AS j WHERE true
         ON CONFLICT(account_id, provider_txn_id) DO UPDATE SET
           amount_minor = excluded.amount_minor, provider_amount = excluded.provider_amount, currency = excluded.currency,
           txn_date = excluded.txn_date, merchant = excluded.merchant, description = excluded.description,
           is_pending = excluded.is_pending, fingerprint = excluded.fingerprint,
           last_seen_at = excluded.last_seen_at, vanished_at = NULL, superseded_by = NULL, updated_at = excluded.updated_at
         WHERE transactions.amount_minor IS NOT excluded.amount_minor
            OR transactions.provider_amount IS NOT excluded.provider_amount
            OR transactions.currency IS NOT excluded.currency
            OR transactions.txn_date IS NOT excluded.txn_date
            OR transactions.merchant IS NOT excluded.merchant
            OR transactions.description IS NOT excluded.description
            OR transactions.is_pending IS NOT excluded.is_pending
            OR transactions.vanished_at IS NOT NULL
         RETURNING first_import_run_id = ?3 AS inserted`,
      )
      .bind(accountId, now, runId, chunk),
  );
}

/**
 * Live pending rows, plus every posted row dated where one of them could match (0–7 days on),
 * with `linked` set when a pending row already points at it. Read before the run's writes.
 */
export function selectPendingCandidates(db: CountingDb, accountId: number, ttlDays: number) {
  return db
    .prepare(
      `WITH live AS (SELECT * FROM transactions WHERE account_id = ?1 AND is_pending = 1 AND vanished_at IS NULL)
       SELECT provider_txn_id, is_pending, amount_minor, txn_date, first_seen_at, 0 AS linked FROM live
       UNION ALL
       SELECT t.provider_txn_id, t.is_pending, t.amount_minor, t.txn_date, t.first_seen_at,
         EXISTS (SELECT 1 FROM transactions p WHERE p.superseded_by = t.id) AS linked
       FROM transactions t
       WHERE t.account_id = ?1 AND t.is_pending = 0
         AND t.txn_date BETWEEN (SELECT min(txn_date) FROM live) AND (SELECT date(max(txn_date), '+' || ?2 || ' days') FROM live)`,
    )
    .bind(accountId, ttlDays);
}

/**
 * Retires (never deletes) each matched pending row and links it to its posted version. Runs
 * after the upserts in the same batch, so posted rows inserted this run can be linked.
 */
export function supersedePending(db: CountingDb, accountId: number, now: string, matchesJson: string) {
  return db
    .prepare(
      `UPDATE transactions SET superseded_by = p.id, vanished_at = ?2, updated_at = ?2
       FROM (SELECT json_extract(value, '$.pending_txn_id') AS pending_txn_id, json_extract(value, '$.posted_txn_id') AS posted_txn_id
             FROM json_each(?3)) AS m
       JOIN transactions AS p ON p.account_id = ?1 AND p.provider_txn_id = m.posted_txn_id
       WHERE transactions.account_id = ?1 AND transactions.provider_txn_id = m.pending_txn_id AND transactions.vanished_at IS NULL`,
    )
    .bind(accountId, now, matchesJson);
}

/** Retires (never deletes) expired pending rows: reversed, or posted at a different amount. */
export function expirePending(db: CountingDb, accountId: number, now: string, idsJson: string) {
  return db
    .prepare(
      `UPDATE transactions SET vanished_at = ?2, updated_at = ?2
       WHERE account_id = ?1 AND vanished_at IS NULL AND provider_txn_id IN (SELECT value FROM json_each(?3))`,
    )
    .bind(accountId, now, idsJson);
}

/** Posted rows the provider stopped returning: counted for the run stats, never acted on. */
export function countMissingPosted(db: CountingDb, accountId: number, range: { from: string; to: string }, idsJson: string) {
  return db
    .prepare(
      `SELECT count(*) AS n FROM transactions
       WHERE account_id = ?1 AND is_pending = 0 AND txn_date BETWEEN ?2 AND ?3
         AND provider_txn_id NOT IN (SELECT value FROM json_each(?4))`,
    )
    .bind(accountId, range.from, range.to, idsJson);
}

export type AccountOutcome = {
  accountId: number;
  now: string;
  ok: boolean;
  /** Sanitised error text; null on success. */
  error: string | null;
  /** Learned this run; only applied while the account has no currency yet. */
  currency: string | null;
  enabled: boolean;
  label: string;
  balanceMinor: number | null;
  /** Only on success. */
  backfillCursor: string | null;
  backfillComplete: boolean | null;
};

/**
 * One status write per account per run. Every right-hand side reads the pre-update row, so
 * the currency-learning CASEs see `currency IS NULL` even though the same statement sets it.
 * `last_data_change_at` and `newest_txn_date` are derived from the rows this run just wrote.
 */
export function updateAccountStatus(db: CountingDb, o: AccountOutcome) {
  return db
    .prepare(
      `UPDATE accounts SET
         currency = COALESCE(currency, ?2),
         import_enabled = CASE WHEN currency IS NULL AND ?2 IS NOT NULL THEN ?3 ELSE import_enabled END,
         name = CASE WHEN currency IS NULL AND ?2 IS NOT NULL THEN ?4 ELSE name END,
         balance_minor = COALESCE(?5, balance_minor),
         balance_fetched_at = CASE WHEN ?5 IS NULL THEN balance_fetched_at ELSE ?1 END,
         last_import_attempt_at = ?1,
         last_import_success_at = CASE WHEN ?6 = 1 THEN ?1 ELSE last_import_success_at END,
         last_import_error = ?7,
         consecutive_failures = CASE WHEN ?6 = 1 THEN 0 ELSE consecutive_failures + 1 END,
         last_data_change_at = CASE WHEN ?6 = 1 AND EXISTS (
             SELECT 1 FROM transactions t WHERE t.account_id = accounts.id AND t.updated_at = ?1
           ) THEN ?1 ELSE last_data_change_at END,
         newest_txn_date = CASE WHEN ?6 = 1 THEN (
             SELECT MAX(t.txn_date) FROM transactions t WHERE t.account_id = accounts.id AND t.vanished_at IS NULL
           ) ELSE newest_txn_date END,
         backfill_cursor_date = COALESCE(?8, backfill_cursor_date),
         backfill_complete = COALESCE(?9, backfill_complete),
         updated_at = ?1
       WHERE id = ?10`,
    )
    .bind(
      o.now,
      o.currency,
      o.enabled ? 1 : 0,
      o.label,
      o.balanceMinor,
      o.ok ? 1 : 0,
      o.error,
      o.backfillCursor,
      o.backfillComplete === null ? null : o.backfillComplete ? 1 : 0,
      o.accountId,
    );
}

/**
 * A newly seen account that isn't imported: one in a currency we don't budget in
 * (`needsReview` false, nothing to decide), or one held for the owner's review.
 */
export function recordWithoutImport(
  db: CountingDb,
  o: { accountId: number; now: string; currency: string; label: string; balanceMinor: number | null; needsReview: boolean },
) {
  return db
    .prepare(
      `UPDATE accounts SET currency = ?2, import_enabled = 0, needs_review = ?6, name = ?3, balance_minor = ?4,
         balance_fetched_at = CASE WHEN ?4 IS NULL THEN NULL ELSE ?1 END, updated_at = ?1
       WHERE id = ?5 AND currency IS NULL`,
    )
    .bind(o.now, o.currency, o.label, o.balanceMinor, o.accountId, o.needsReview ? 1 : 0);
}

/** One account's result for a run, as logged, returned to callers and stored. */
export type AccountSummary = {
  accountId: number;
  status: "success" | "failed";
  fetched: number;
  inserted: number;
  updated: number;
  vanishedMarked: number;
  /** Logged only; import_run_accounts has no column for it. */
  missingPosted: number;
  httpStatus: number | null;
  /** Sanitised, e.g. "server 503"; never provider text. */
  error: string | null;
  durationMs: number;
};

export type RunAccountRow = AccountSummary & { runId: number; window: { from: string; to: string } | null };

export function insertRunAccount(db: CountingDb, r: RunAccountRow) {
  return db
    .prepare(
      `INSERT INTO import_run_accounts (run_id, account_id, status, http_status, window_from, window_to,
         fetched, inserted, updated, vanished_marked, error, duration_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      r.runId, r.accountId, r.status, r.httpStatus, r.window?.from ?? null, r.window?.to ?? null,
      r.fetched, r.inserted, r.updated, r.vanishedMarked, r.error, r.durationMs,
    );
}
