import type { CountingDb } from "./db";

const LEASE_MS = 10 * 60_000;

/**
 * Claims the single-row lease with a conditional UPDATE, so exactly one overlapping run wins.
 * An expired lease is claimable, so a crashed run can't block imports forever.
 * ISO-8601 UTC text from toISOString() compares correctly as a string.
 */
export async function claimLock(db: CountingDb, runId: number, now: Date): Promise<boolean> {
  const res = await db.run(
    db
      .prepare(
        "UPDATE import_lock SET holder_run_id = ?1, expires_at = ?2 WHERE id = 1 AND (holder_run_id IS NULL OR expires_at < ?3)",
      )
      .bind(runId, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString()),
  );
  return res.meta.changes === 1;
}

/**
 * Called by the lease holder. A run still marked running after a whole lease was cut off
 * before its finally (e.g. a manual import killed past the 30 s waitUntil limit). Younger
 * rows are left alone: they may belong to a run that is just about to try for the lease.
 */
export async function closeAbandonedRuns(db: CountingDb, runId: number, now: Date): Promise<void> {
  await db.run(
    db
      .prepare(
        "UPDATE import_runs SET status = 'failed', error_summary = 'abandoned', finished_at = ?2 WHERE status = 'running' AND id != ?1 AND started_at <= ?3",
      )
      .bind(runId, now.toISOString(), new Date(now.getTime() - LEASE_MS).toISOString()),
  );
}

/** Only the holder can release, so a late finisher can't free someone else's lease. */
export async function releaseLock(db: CountingDb, runId: number): Promise<void> {
  await db.run(
    db.prepare("UPDATE import_lock SET holder_run_id = NULL, expires_at = NULL WHERE id = 1 AND holder_run_id = ?1").bind(runId),
  );
}
