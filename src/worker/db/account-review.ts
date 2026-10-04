// Reads and writes for accounts awaiting review (docs/phase-2-spec.md, Reconnection).
// Every write re-checks the state its route validated, so a request that raced another
// changes nothing and reports false instead of acting on a stale snapshot.

export type ReviewRow = {
  id: number;
  provider_account_id: string;
  provider_connection_id: string | null;
  provider_status: string;
  currency: string | null;
  needs_review: number;
  merged_into_account_id: number | null;
};

export const loadAccount = (db: D1Database, id: number) =>
  db
    .prepare(
      `SELECT id, provider_account_id, provider_connection_id, provider_status, currency, needs_review, merged_into_account_id
       FROM accounts WHERE id = ?1`,
    )
    .bind(id)
    .first<ReviewRow>();

export const isAwaitingReview = (a: ReviewRow) => a.needs_review === 1 && a.merged_into_account_id === null;

/** Imports an account awaiting review as a new account from the next run. */
export async function enableAccount(db: D1Database, id: number, now: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE accounts SET needs_review = 0, import_enabled = 1, updated_at = ?2
       WHERE id = ?1 AND needs_review = 1 AND merged_into_account_id IS NULL AND currency = 'GBP'`,
    )
    .bind(id, now)
    .run();
  return res.meta.changes === 1;
}

/**
 * Swaps the two rows' provider ids so `target` imports from `held`'s new id and `held` keeps the
 * target's old id, disabled. The first statement re-checks both snapshots and each later one
 * only runs if the one before it did, so the batch is all or nothing. The target catches up from
 * 7 days before its newest transaction; one still backfilling (or with no data) starts over.
 */
export async function linkAccounts(db: D1Database, held: ReviewRow, target: ReviewRow, now: string): Promise<boolean> {
  const moving = `'linking:' || ${held.id}`;
  const [first] = await db.batch([
    // Frees the new provider id; UNIQUE(provider, provider_account_id) holds after each statement.
    db
      .prepare(
        `UPDATE accounts SET provider_account_id = 'linking:' || id, updated_at = ?2
         WHERE id = ?1 AND provider_account_id = ?3 AND needs_review = 1 AND merged_into_account_id IS NULL AND currency = ?4
           AND EXISTS (SELECT 1 FROM accounts t WHERE t.id = ?5 AND t.provider_account_id = ?6
                         AND t.needs_review = 0 AND t.merged_into_account_id IS NULL AND t.currency = ?4)`,
      )
      .bind(held.id, now, held.provider_account_id, held.currency, target.id, target.provider_account_id),
    db
      .prepare(
        `UPDATE accounts SET provider_account_id = ?3, provider_connection_id = ?4, provider_status = ?5,
           import_enabled = 1, last_import_error = NULL, consecutive_failures = 0,
           backfill_floor_date = CASE WHEN backfill_complete = 1 AND newest_txn_date IS NOT NULL
             THEN date(newest_txn_date, '-7 days') ELSE NULL END,
           backfill_complete = 0, backfill_cursor_date = NULL, updated_at = ?2
         WHERE id = ?1 AND EXISTS (SELECT 1 FROM accounts h WHERE h.id = ?6 AND h.provider_account_id = ${moving})`,
      )
      .bind(target.id, now, held.provider_account_id, held.provider_connection_id, held.provider_status, held.id),
    db
      .prepare(
        `UPDATE accounts SET provider_account_id = ?3, merged_into_account_id = ?4, needs_review = 0, import_enabled = 0, updated_at = ?2
         WHERE id = ?1 AND provider_account_id = ${moving}`,
      )
      .bind(held.id, now, target.provider_account_id, target.id),
  ]);
  return first!.meta.changes === 1;
}
