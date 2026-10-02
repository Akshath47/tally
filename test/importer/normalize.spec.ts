import { describe, expect, it } from "vitest";
import { accountLabel, normalizeTransaction } from "../../src/worker/importer/normalize";
import { txn } from "../fixtures/lunchflow";

describe("accountLabel", () => {
  it("never exposes an IBAN: keeps only the last 4 characters", () => {
    const label = accountLabel({ name: "GB29NWBK60161331926819", institution_name: "Revolut" }, "GBP");
    expect(label).toBe("Revolut · GBP · ••6819");
    expect(label).not.toContain("GB29");
  });

  it("recognises an IBAN written with spaces", () => {
    expect(accountLabel({ name: "GB29 NWBK 6016 1331 9268 19", institution_name: "Revolut" }, "GBP")).toBe(
      "Revolut · GBP · ••6819",
    );
  });

  it("omits the currency until it is known", () => {
    expect(accountLabel({ name: "GB29NWBK60161331926819", institution_name: "Revolut" }, null)).toBe("Revolut · ••6819");
  });

  it("uses the product name for a card", () => {
    expect(accountLabel({ name: "Synthetic Rewards Card", institution_name: "Test Amex" }, "GBP")).toBe(
      "Test Amex · Synthetic Rewards Card",
    );
  });
});

describe("normalizeTransaction", () => {
  it("normalises amount, keeps the original decimal and the date string", () => {
    const row = normalizeTransaction(txn(1, "abc", { amount: -12.3, date: "2026-10-25" }), 1, "GBP");
    expect(row).toMatchObject({
      provider_txn_id: "abc",
      amount_minor: -1230,
      provider_amount: "-12.3",
      currency: "GBP",
      txn_date: "2026-10-25",
      is_pending: 0,
    });
  });

  it("keeps the sign the provider gives (negative = money out)", () => {
    expect(normalizeTransaction(txn(1, "r", { amount: 50 }), 1, "GBP").amount_minor).toBe(5000);
  });

  it("stores pending as 1", () => {
    expect(normalizeTransaction(txn(1, "p", { isPending: true }), 1, "GBP").is_pending).toBe(1);
  });

  it("builds a case- and whitespace-insensitive fingerprint", () => {
    const a = normalizeTransaction(txn(1, "a", { merchant: "  Synthetic   CAFE ", description: "Card  1" }), 1, "GBP");
    const b = normalizeTransaction(txn(1, "b", { merchant: "synthetic cafe", description: "card 1" }), 1, "GBP");
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toBe("1|2026-10-01|-1230|synthetic cafe card 1");
  });

  it("flags a transaction whose currency differs from the account's", () => {
    expect(() => normalizeTransaction(txn(1, "x", { currency: "USD" }), 1, "GBP")).toThrowError(
      expect.objectContaining({ kind: "invalid_response" }),
    );
  });

  it("flags a 3-decimal amount as precision", () => {
    expect(() => normalizeTransaction(txn(1, "x", { amount: 1.234 }), 1, "GBP")).toThrowError(
      expect.objectContaining({ kind: "precision" }),
    );
  });

  describe("a pending transaction with no provider id", () => {
    const pending = (overrides = {}) => txn(1, null, { isPending: true, amount: -9.99, date: "2026-10-01", merchant: "Synthetic Shop", ...overrides });

    it("gets a synthetic id built from its fingerprint", () => {
      const row = normalizeTransaction(pending(), 1, "GBP");
      expect(row.provider_txn_id).toBe("nullid:1|2026-10-01|-999|synthetic shop");
    });

    it("gets the same id every time, so re-imports are idempotent", () => {
      expect(normalizeTransaction(pending(), 1, "GBP").provider_txn_id).toBe(normalizeTransaction(pending(), 1, "GBP").provider_txn_id);
    });

    it("gets a different id when the date or amount differs", () => {
      const base = normalizeTransaction(pending(), 1, "GBP").provider_txn_id;
      expect(normalizeTransaction(pending({ amount: -10 }), 1, "GBP").provider_txn_id).not.toBe(base);
      expect(normalizeTransaction(pending({ date: "2026-10-02" }), 1, "GBP").provider_txn_id).not.toBe(base);
    });

    it("is rejected when the transaction is posted, since only pending ids are unstable", () => {
      expect(() => normalizeTransaction(pending({ isPending: false }), 1, "GBP")).toThrowError(
        expect.objectContaining({ kind: "invalid_response" }),
      );
    });
  });
});
