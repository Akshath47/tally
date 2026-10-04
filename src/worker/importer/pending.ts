import { addDays } from "./dates";

// Lunch Flow returns at most one pending transaction per account (docs/phase1-assessment.md),
// so a pending row missing from a response is usually still pending at the bank. It keeps
// counting until a posted row of the same amount supersedes it, or until it expires.
export const PENDING_TTL_DAYS = 7;

export type PendingCandidate = { id: number; is_pending: number; amount_minor: number; txn_date: string; first_seen_at: string };
export type PendingMatch = { pending_id: number; posted_id: number };

const byDateThenId = (a: PendingCandidate, b: PendingCandidate) =>
  a.txn_date.localeCompare(b.txn_date) || a.first_seen_at.localeCompare(b.first_seen_at) || a.id - b.id;

/**
 * Pairs each pending row with the earliest unused posted row of the same amount, booked 0–7
 * days after the pending date and first seen no earlier than it. Oldest pending first; each
 * posted row is used once. A wrong pairing between equal amounts leaves totals unchanged.
 */
export function matchPending(rows: PendingCandidate[]): PendingMatch[] {
  const pending = rows.filter((r) => r.is_pending === 1).sort(byDateThenId);
  const posted = rows.filter((r) => r.is_pending === 0).sort(byDateThenId);
  const used = new Set<number>();
  const matches: PendingMatch[] = [];

  for (const p of pending) {
    const last = addDays(p.txn_date, PENDING_TTL_DAYS);
    const hit = posted.find(
      (t) =>
        !used.has(t.id) &&
        t.amount_minor === p.amount_minor &&
        t.txn_date >= p.txn_date &&
        t.txn_date <= last &&
        t.first_seen_at >= p.first_seen_at,
    );
    if (hit) {
      used.add(hit.id);
      matches.push({ pending_id: p.id, posted_id: hit.id });
    }
  }
  return matches;
}
