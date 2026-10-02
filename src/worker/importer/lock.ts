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

/** Only the holder can release, so a late finisher can't free someone else's lease. */
export async function releaseLock(db: CountingDb, runId: number): Promise<void> {
  await db.run(
    db.prepare("UPDATE import_lock SET holder_run_id = NULL, expires_at = NULL WHERE id = 1 AND holder_run_id = ?1").bind(runId),
  );
}
