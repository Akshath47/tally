import { addDays } from "./dates";

export type Window = { from: string; to: string };

const INCREMENTAL_DAYS = 14;
const CHUNK_DAYS = 31;
const MAX_CHUNKS_PER_RUN = 2;

/** The last 14 days including today, re-read every run for late postings and pending → posted changes. */
export function incrementalWindow(today: string): Window {
  return { from: addDays(today, -(INCREMENTAL_DAYS - 1)), to: today };
}

/**
 * Next backfill chunks, working backwards from `cursor` (the oldest date already imported;
 * null means only the incremental window so far) down to `today - backfillDays`.
 */
export function backfillChunks(
  cursor: string | null,
  today: string,
  backfillDays: number,
  max = MAX_CHUNKS_PER_RUN,
): { chunks: Window[]; nextCursor: string; complete: boolean } {
  const floor = addDays(today, -backfillDays);
  let oldest = cursor ?? incrementalWindow(today).from;
  const chunks: Window[] = [];

  // ISO dates compare correctly as strings.
  while (chunks.length < max && oldest > floor) {
    const to = addDays(oldest, -1);
    const from = addDays(to, -(CHUNK_DAYS - 1));
    chunks.push({ from: from < floor ? floor : from, to });
    oldest = chunks[chunks.length - 1]!.from;
  }
  return { chunks, nextCursor: oldest, complete: oldest <= floor };
}
