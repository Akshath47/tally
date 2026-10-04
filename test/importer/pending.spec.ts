import { describe, expect, it } from "vitest";
import { matchPending, type PendingCandidate } from "../../src/worker/importer/pending";

// Synthetic rows only.

const SEEN = "2026-10-02T10:00:00.000Z";
const LATER = "2026-10-03T10:00:00.000Z";

function pending(id: string, overrides: Partial<PendingCandidate> = {}): PendingCandidate {
  return { provider_txn_id: id, amount_minor: -4170, txn_date: "2026-10-02", first_seen_at: SEEN, ...overrides };
}

function posted(id: string, overrides: Partial<PendingCandidate> = {}): PendingCandidate {
  return { provider_txn_id: id, amount_minor: -4170, txn_date: "2026-10-03", first_seen_at: LATER, ...overrides };
}

describe("matchPending", () => {
  it("pairs a pending transaction with a same-amount posted one booked on or after its date", () => {
    expect(matchPending([pending("p1")], [posted("t2")])).toEqual([{ pending_txn_id: "p1", posted_txn_id: "t2" }]);
    expect(matchPending([pending("p1")], [posted("t2", { txn_date: "2026-10-02" })])).toEqual([{ pending_txn_id: "p1", posted_txn_id: "t2" }]);
  });

  it("allows the posted date up to 7 days after the pending date, not more", () => {
    expect(matchPending([pending("p1")], [posted("t2", { txn_date: "2026-10-09" })])).toEqual([{ pending_txn_id: "p1", posted_txn_id: "t2" }]);
    expect(matchPending([pending("p1")], [posted("t2", { txn_date: "2026-10-10" })])).toEqual([]);
  });

  it("ignores posted transactions with a different amount or booked before the pending date", () => {
    expect(matchPending([pending("p1")], [posted("t2", { amount_minor: -4171 })])).toEqual([]);
    expect(matchPending([pending("p1")], [posted("t2", { txn_date: "2026-10-01" })])).toEqual([]);
  });

  it("ignores a posted transaction first seen before the pending one, since it was already a separate charge", () => {
    expect(matchPending([pending("p1", { first_seen_at: LATER })], [posted("t2", { first_seen_at: SEEN })])).toEqual([]);
  });

  it("uses each posted transaction once, oldest pending first", () => {
    expect(matchPending([pending("p5", { txn_date: "2026-10-03" }), pending("p4")], [posted("t9")])).toEqual([{ pending_txn_id: "p4", posted_txn_id: "t9" }]);

    expect(matchPending([pending("p1"), pending("p2")], [posted("t3"), posted("t4", { txn_date: "2026-10-04" })])).toEqual([
      { pending_txn_id: "p1", posted_txn_id: "t3" },
      { pending_txn_id: "p2", posted_txn_id: "t4" },
    ]);
  });
});
