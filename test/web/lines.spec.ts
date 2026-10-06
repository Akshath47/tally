import { describe, expect, it } from "vitest";
import { budgetLines } from "../../src/web/lines";

// All figures are synthetic.

const names = new Map([
  [1, { name: "Groceries" }],
  [2, { name: "Transport" }],
]);
const summaryLine = (categoryId: number | null, kind: string | null, spentMinor: number, pendingSpentMinor: number, allocatedMinor = 0) => ({
  categoryId,
  kind,
  spentMinor,
  pendingSpentMinor,
  allocatedMinor,
});

describe("budgetLines", () => {
  it("gives uncategorised pending charges their own line after Misc", () => {
    const lines = budgetLines(
      {
        miscMinor: 5_000,
        categories: [summaryLine(1, "budgeted", 3_000, 500, 10_000), summaryLine(2, "budgeted", 400, 100), summaryLine(null, null, 2_600, 2_000)],
      },
      names,
    );
    expect(lines).toEqual([
      { category: 1, name: "Groceries", spentMinor: 3_000, pendingSpentMinor: 500, allocatedMinor: 10_000 },
      // Transport has no allocation, so it's in Misc, its pending charge included: it's categorised.
      { category: "misc", name: "Misc", note: "unallocated", spentMinor: 1_000, pendingSpentMinor: 100, allocatedMinor: 5_000 },
      { category: "pending", name: "Uncategorised pending", spentMinor: 2_000, pendingSpentMinor: 2_000, allocatedMinor: null },
    ]);
  });

  it("lists no Pending line when every pending charge is categorised", () => {
    const lines = budgetLines({ miscMinor: 0, categories: [summaryLine(1, "budgeted", 3_000, 500, 10_000), summaryLine(null, null, 700, 0)] }, names);
    expect(lines.map((l) => l.category)).toEqual([1, "misc"]);
  });

  it("leaves tracked spend off every line", () => {
    expect(budgetLines({ miscMinor: 0, categories: [summaryLine(9, "tracked", 5_000, 5_000)] }, names)).toEqual([]);
  });
});
