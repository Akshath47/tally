import { addDays } from "./dates";

// Lunch Flow returns at most one pending transaction per account (docs/phase1-assessment.md),
// so a pending row missing from a response is usually still pending at the bank. It keeps
// counting until a posted row of the same amount supersedes it, or until it expires.
export const PENDING_TTL_DAYS = 7;

// Keyed by provider id, not row id, so posted rows this run is about to insert can match too.
export type PendingCandidate = { provider_txn_id: string; amount_minor: number; txn_date: string; first_seen_at: string };
export type PendingMatch = { pending_txn_id: string; posted_txn_id: string };

const oldestFirst = (a: PendingCandidate, b: PendingCandidate) =>
  a.txn_date.localeCompare(b.txn_date) || a.first_seen_at.localeCompare(b.first_seen_at) || a.provider_txn_id.localeCompare(b.provider_txn_id);

/**
 * Pairs each pending row with the earliest unused posted row of the same amount, booked 0–7
 * days after the pending date and first seen no earlier than it. Oldest pending first; each
 * posted row is used once. A wrong pairing between equal amounts leaves totals unchanged.
 */
export function matchPending(pendingRows: PendingCandidate[], postedRows: PendingCandidate[]): PendingMatch[] {
  const pending = [...pendingRows].sort(oldestFirst);
  const posted = [...postedRows].sort(oldestFirst);
  const used = new Set<string>();
  const matches: PendingMatch[] = [];

  for (const p of pending) {
    const last = addDays(p.txn_date, PENDING_TTL_DAYS);
    const hit = posted.find(
      (t) =>
        !used.has(t.provider_txn_id) &&
        t.amount_minor === p.amount_minor &&
        t.txn_date >= p.txn_date &&
        t.txn_date <= last &&
        t.first_seen_at >= p.first_seen_at,
    );
    if (hit) {
      used.add(hit.provider_txn_id);
      matches.push({ pending_txn_id: p.provider_txn_id, posted_txn_id: hit.provider_txn_id });
    }
  }
  return matches;
}
