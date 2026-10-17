import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertOverall } from "../budget/budget-rows";
import { SEEDED, insertRule, ledger } from "../budget/helpers";
import { resetDb } from "../db";
import { get } from "../http";

// All data is synthetic.

type Trends = {
  months: { month: string; partial: boolean; hasData: boolean; spentMinor: number; pendingSpentMinor: number; overallMinor: number | null; trackedMinor: number }[];
  categories: { categoryId: number | null; kind: string | null; series: number[]; averageMinor: number | null }[];
};
const trends = async () => (await (await get("/api/trends")).json()) as Trends;

let a: number;
let txn: Awaited<ReturnType<typeof ledger>>["txn"];

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  const l = await ledger();
  a = l.accounts[0];
  txn = l.txn;
  await insertRule("exact", "grocer", SEEDED.groceries);
  await insertRule("exact", "outfitter", SEEDED.clothes);
});
afterEach(() => vi.useRealTimers());

describe("GET /api/trends", () => {
  it("covers the current month and the 5 before, oldest first", async () => {
    await insertOverall("2026-09", 150_000);
    await txn(a, { merchant: "Grocer", amountMinor: -1_001, txnDate: "2026-08-03" });
    await txn(a, { merchant: "Grocer", amountMinor: -5_000, txnDate: "2026-10-02", isPending: true });
    await txn(a, { merchant: "Outfitter", amountMinor: -2_000, txnDate: "2026-09-09" });
    const t = await trends();
    expect(t.months.map((m) => m.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(t.months.map((m) => [m.hasData, m.partial])).toEqual([[false, false], [false, false], [false, false], [true, false], [true, false], [true, true]]);
    expect(t.months[5]).toEqual({ month: "2026-10", partial: true, hasData: true, spentMinor: 5_000, pendingSpentMinor: 5_000, overallMinor: 150_000, trackedMinor: 0 });
    expect(t.months[3]!.overallMinor).toBeNull();
    expect(t.months[4]).toMatchObject({ spentMinor: 0, trackedMinor: 2_000, overallMinor: 150_000 });
  });

  it("aligns every series and averages completed months with data, floored", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -1_001, txnDate: "2026-08-03" });
    await txn(a, { merchant: "Grocer", amountMinor: -5_000, txnDate: "2026-10-02" });
    await txn(a, { merchant: "Unknown shop", amountMinor: -300, txnDate: "2026-09-04" });
    const { categories } = await trends();
    expect(categories).toEqual([
      // Aug and Sep have data; Oct is partial and left out: (1001 + 0) ÷ 2.
      { categoryId: SEEDED.groceries, kind: "budgeted", series: [0, 0, 0, 1_001, 0, 5_000], averageMinor: 500 },
      { categoryId: null, kind: null, series: [0, 0, 0, 0, 300, 0], averageMinor: 150 },
    ]);
  });

  it("has a null average when only the current month has data", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -500, txnDate: "2026-10-02" });
    expect((await trends()).categories[0]!.averageMinor).toBeNull();
  });
});
