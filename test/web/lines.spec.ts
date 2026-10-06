import { describe, expect, it } from "vitest";
import { budgetLines, findLine, spendingLines } from "../../src/web/lines";

// All figures are synthetic.

const names = new Map([
  [1, { name: "Groceries" }],
  [2, { name: "Transport" }],
  [9, { name: "Shopping" }],
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
      { category: "uncategorised-pending", name: "Uncategorised pending", spentMinor: 2_000, pendingSpentMinor: 2_000, allocatedMinor: null },
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

describe("spendingLines", () => {
  // A month before any budget: no pots, so each category shows what it spent.
  it("lists budget spend by category, biggest first, with Uncategorised last and tracked apart", () => {
    const { lines, tracked } = spendingLines(
      [summaryLine(1, "budgeted", 3_000, 0), summaryLine(null, null, 9_000, 0), summaryLine(2, "budgeted", 4_500, 500), summaryLine(9, "tracked", 7_000, 0)],
      names,
    );
    expect(lines).toEqual([
      { category: 2, name: "Transport", spentMinor: 4_500, pendingSpentMinor: 500, allocatedMinor: null },
      { category: 1, name: "Groceries", spentMinor: 3_000, pendingSpentMinor: 0, allocatedMinor: null },
      { category: null, name: "Uncategorised", spentMinor: 9_000, pendingSpentMinor: 0, allocatedMinor: null },
    ]);
    expect(tracked).toEqual([{ category: 9, name: "Shopping", spentMinor: 7_000, pendingSpentMinor: 0, allocatedMinor: null }]);
  });

  it("leaves out categories with nothing spent", () => {
    // A refund can net a category to zero; an allocation alone lists it in the summary too.
    const { lines, tracked } = spendingLines([summaryLine(1, "budgeted", 0, 0, 10_000), summaryLine(9, "tracked", 0, 0)], names);
    expect(lines).toEqual([]);
    expect(tracked).toEqual([]);
  });
});

describe("findLine", () => {
  it("gives a category off the budget lines its plain spend, for a month without a budget or a tracked category", () => {
    const s = { spentMinor: 3_000, pendingSpentMinor: 0, miscMinor: null, categories: [summaryLine(1, "budgeted", 3_000, 0), summaryLine(9, "tracked", 7_000, 0)] };
    expect(findLine(s, names, 1)).toEqual({ category: 1, name: "Groceries", spentMinor: 3_000, pendingSpentMinor: 0, allocatedMinor: null });
    expect(findLine(s, names, 9)).toEqual({ category: 9, name: "Shopping", spentMinor: 7_000, pendingSpentMinor: 0, allocatedMinor: null });
    expect(findLine(s, names, 2)).toBeUndefined();
  });
});
