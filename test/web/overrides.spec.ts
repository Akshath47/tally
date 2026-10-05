import { describe, expect, it } from "vitest";
import { buildOverride, draftOf, overrideOf } from "../../src/web/overrides";

const row = {
  amountMinor: -6400,
  txnDate: "2026-10-01",
  categoryId: 2,
  categorySource: "rule" as const,
  excluded: false,
  countedAmountMinor: null,
  countedDate: null,
  note: null,
};

describe("overrideOf", () => {
  it("leaves a rule's category out of the override", () => {
    expect(overrideOf(row).categoryId).toBeNull();
    expect(overrideOf({ ...row, categorySource: "override" }).categoryId).toBe(2);
  });
});

describe("buildOverride", () => {
  const draft = draftOf(row, "64.00");

  it("sends an unchanged draft as an all-default override", () => {
    expect(buildOverride(row, draft)).toEqual({ body: { categoryId: null, excluded: false, countedAmountMinor: null, countedDate: null, note: null } });
  });

  it("keeps the bank's sign on a typed amount", () => {
    expect(buildOverride(row, { ...draft, amountText: "32" })).toMatchObject({ body: { countedAmountMinor: -3200 } });
    expect(buildOverride({ ...row, amountMinor: 1500 }, { ...draft, amountText: "10.5" })).toMatchObject({ body: { countedAmountMinor: 1050 } });
  });

  it("treats the bank's own values as no override", () => {
    expect(buildOverride(row, { ...draft, amountText: "64", date: "2026-10-01", note: "  " })).toMatchObject({
      body: { countedAmountMinor: null, countedDate: null, note: null },
    });
  });

  it("moves the counted date and excludes", () => {
    expect(buildOverride(row, { ...draft, date: "2026-09-30", countInBudget: false })).toMatchObject({ body: { countedDate: "2026-09-30", excluded: true } });
  });

  it("puts a picked category on the merchant's rule when asked", () => {
    expect(buildOverride(row, { ...draft, categoryId: 5, applyToMerchant: true })).toMatchObject({ body: { categoryId: 5, applyToMerchant: true } });
    expect(buildOverride(row, { ...draft, categoryId: null, applyToMerchant: true })).toHaveProperty("error");
    // Untouched, "use for all" takes the category the row shows, here its rule's.
    expect(buildOverride(row, { ...draft, applyToMerchant: true })).toMatchObject({ body: { categoryId: 2, applyToMerchant: true } });
  });

  it("refuses a bad amount instead of guessing", () => {
    expect(buildOverride(row, { ...draft, amountText: "3.999" })).toHaveProperty("error");
    expect(buildOverride(row, { ...draft, amountText: "" })).toHaveProperty("error");
  });
});
