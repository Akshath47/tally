import { describe, expect, it } from "vitest";
import { matchPending, type PendingCandidate } from "../../src/worker/importer/pending";

// Synthetic rows only.

const SEEN = "2026-10-02T10:00:00.000Z";
const LATER = "2026-10-03T10:00:00.000Z";

function pending(id: number, overrides: Partial<PendingCandidate> = {}): PendingCandidate {
  return { id, is_pending: 1, amount_minor: -4170, txn_date: "2026-10-02", first_seen_at: SEEN, ...overrides };
}

function posted(id: number, overrides: Partial<PendingCandidate> = {}): PendingCandidate {
  return { id, is_pending: 0, amount_minor: -4170, txn_date: "2026-10-03", first_seen_at: LATER, ...overrides };
}

describe("matchPending", () => {
  it("pairs a pending transaction with a same-amount posted one booked on or after its date", () => {
    expect(matchPending([pending(1), posted(2)])).toEqual([{ pending_id: 1, posted_id: 2 }]);
    expect(matchPending([pending(1), posted(2, { txn_date: "2026-10-02" })])).toEqual([{ pending_id: 1, posted_id: 2 }]);
  });

  it("allows the posted date up to 7 days after the pending date, not more", () => {
    expect(matchPending([pending(1), posted(2, { txn_date: "2026-10-09" })])).toEqual([{ pending_id: 1, posted_id: 2 }]);
    expect(matchPending([pending(1), posted(2, { txn_date: "2026-10-10" })])).toEqual([]);
  });

  it("ignores posted transactions with a different amount or booked before the pending date", () => {
    expect(matchPending([pending(1), posted(2, { amount_minor: -4171 })])).toEqual([]);
    expect(matchPending([pending(1), posted(2, { txn_date: "2026-10-01" })])).toEqual([]);
  });

  it("ignores a posted transaction first seen before the pending one, since it was already a separate charge", () => {
    expect(matchPending([pending(1, { first_seen_at: LATER }), posted(2, { first_seen_at: SEEN })])).toEqual([]);
  });

  it("uses each posted transaction once, oldest pending first", () => {
    const twoPending = [pending(5, { txn_date: "2026-10-03" }), pending(4), posted(9)];
    expect(matchPending(twoPending)).toEqual([{ pending_id: 4, posted_id: 9 }]);

    const twoEach = [pending(1), pending(2), posted(3), posted(4, { txn_date: "2026-10-04" })];
    expect(matchPending(twoEach)).toEqual([
      { pending_id: 1, posted_id: 3 },
      { pending_id: 2, posted_id: 4 },
    ]);
  });
});
