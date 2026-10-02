import type { CountingDb } from "./db";

/** Default lease, for runs with no time budget (cron). */
export const LEASE_MS = 10 * 60_000;

// A live run that doesn't hold the lease is one that just lost the claim and is closing,
// which takes milliseconds. Anything older still marked running was cut off.
const ABANDONED_AFTER_MS = 60_000;

/**
 * Claims the single-row lease with a conditional UPDATE, so exactly one overlapping run wins.
 * An expired lease is claimable, so a crashed run can't block imports forever; a run with a
 * time budget passes a lease sized to it, so it can't block others for longer than it can live.
 * ISO-8601 UTC text from toISOString() compares correctly as a string.
 */
export async function claimLock(db: CountingDb, runId: number, now: Date, leaseMs = LEASE_MS): Promise<boolean> {
  const res = await db.run(
    db
      .prepare(
        "UPDATE import_lock SET holder_run_id = ?1, expires_at = ?2 WHERE id = 1 AND (holder_run_id IS NULL OR expires_at < ?3)",
      )
      .bind(runId, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString()),
  );
  return res.meta.changes === 1;
}

/**
 * Marks runs left 'running' by a cut-off run (e.g. a manual import killed past the 30 s
 * waitUntil limit) as failed/abandoned. Whoever holds the lease is alive by definition, even
 * if it took over from a caller that overran its own lease.
 */
export function closeAbandonedRuns(db: CountingDb, runId: number, now: Date) {
  return db
    .prepare(
      `UPDATE import_runs SET status = 'failed', error_summary = 'abandoned', finished_at = ?2
       WHERE status = 'running' AND id != ?1 AND started_at <= ?3
         AND id IS NOT (SELECT holder_run_id FROM import_lock WHERE id = 1)`,
    )
    .bind(runId, now.toISOString(), new Date(now.getTime() - ABANDONED_AFTER_MS).toISOString());
}

/** The inverse of claimLock's condition: true while some run holds an unexpired lease. */
export async function isLockHeld(db: Pick<D1Database, "prepare">, now: Date): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS held FROM import_lock WHERE id = 1 AND holder_run_id IS NOT NULL AND expires_at >= ?1")
    .bind(now.toISOString())
    .first();
  return row !== null;
}

/** Only the holder can release, so a late finisher can't free someone else's lease. */
export function releaseLock(db: CountingDb, runId: number) {
  return db.prepare("UPDATE import_lock SET holder_run_id = NULL, expires_at = NULL WHERE id = 1 AND holder_run_id = ?1").bind(runId);
}
