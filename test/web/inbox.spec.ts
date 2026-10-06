import { describe, expect, it } from "vitest";
import { inGroup, withoutGroup, withoutRow, withoutRows } from "../../src/web/inbox";

// All merchants and amounts are synthetic.

const row = (id: number, merchant: string, amountMinor: number, countedAmountMinor: number | null = null) => ({ id, merchant, amountMinor, countedAmountMinor });
const group = (pattern: string, count: number, totalMinor: number) => ({ pattern, merchant: pattern, count, totalMinor, latestDate: "2026-09-30", rulable: true });

const pages = {
  pageParams: [null, "2026-09-20_5"],
  pages: [
    { transactions: [row(9, "Synthetic Cafe", -300), row(8, "Other Shop", -100)], nextCursor: "2026-09-20_5", total: 5 },
    { transactions: [row(4, " SYNTHETIC cafe", -200), row(3, "Other Shop", -50)], nextCursor: null, total: 5 },
  ],
};

describe("inGroup", () => {
  it("matches rows by the group's pattern, as SQLite's lower(trim()) computes it", () => {
    expect(pages.pages.flatMap((p) => p.transactions).filter(inGroup("synthetic cafe")).map((t) => t.id)).toEqual([9, 4]);
  });
});

describe("withoutRows", () => {
  it("drops the filed rows from every loaded page and takes the filed count off every total", () => {
    const next = withoutRows(pages, inGroup("synthetic cafe"), 3);
    expect(next.pages.map((p) => p.transactions.map((t) => t.id))).toEqual([[8], [3]]);
    expect(next.pages.map((p) => [p.total, p.nextCursor])).toEqual([
      [2, "2026-09-20_5"],
      [2, null],
    ]);
    expect(next.pageParams).toBe(pages.pageParams);
  });

  it("never takes a total below 0", () => {
    expect(withoutRows(pages, () => true, 9).pages.map((p) => p.total)).toEqual([0, 0]);
  });
});

describe("withoutGroup", () => {
  it("drops the filed group only", () => {
    expect(withoutGroup([group("a", 2, -100), group("b", 1, -50)], "a").map((g) => g.pattern)).toEqual(["b"]);
  });
});

describe("withoutRow", () => {
  it("takes one row and its counted amount off its group", () => {
    const groups = [group("synthetic cafe", 3, -900), group("other shop", 2, -150)];
    expect(withoutRow(groups, row(9, "Synthetic Cafe", -300, -250))).toEqual([group("synthetic cafe", 2, -650), group("other shop", 2, -150)]);
  });

  it("drops a group whose last row is filed", () => {
    expect(withoutRow([group("synthetic cafe", 1, -300)], row(9, "Synthetic Cafe", -300))).toEqual([]);
  });
});
