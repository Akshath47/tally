import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAllocation, insertOverall } from "../budget/budget-rows";
import { SEEDED, insertRule, ledger } from "../budget/helpers";
import { NOW, resetDb } from "../db";
import { get } from "../http";

// All data is synthetic.

type Review = {
  month: string;
  previousMonth: string;
  totals: { spentMinor: number; overallMinor: number | null; trackedMinor: number };
  previousTotals: { spentMinor: number; overallMinor: number | null; trackedMinor: number };
  categories: { categoryId: number | null; kind: string | null; spentMinor: number; previousSpentMinor: number; changeMinor: number; allocatedMinor: number | null; over: boolean }[];
  topMerchants: { merchantKey: string; name: string; spentMinor: number; visits: number }[];
  hasPrevious: boolean;
};

let accounts: readonly [number, number];
let txn: Awaited<ReturnType<typeof ledger>>["txn"];
const review = async (month: string) => (await (await get(`/api/months/${month}/review`)).json()) as Review;

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  ({ accounts, txn } = await ledger());
  await insertRule("exact", "grocer", SEEDED.groceries);
  await insertRule("exact", "outfitter", SEEDED.clothes);
});
afterEach(() => vi.useRealTimers());

describe("GET /api/months/:month/review", () => {
  it.each(["2026-10", "2026-11", "2026-13", "2026-9"])("is 400 for %s (current, future or malformed)", async (month) => {
    expect((await get(`/api/months/${month}/review`)).status).toBe(400);
  });

  it("compares a completed month with the one before", async () => {
    await insertOverall("2026-08", 100_000);
    await insertOverall("2026-09", 120_000);
    await insertAllocation(SEEDED.groceries, "2026-09", 1_000);
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -800, txnDate: "2026-08-10" });
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_500, txnDate: "2026-09-10" });
    await txn(accounts[0], { merchant: "Outfitter", amountMinor: -4_000, txnDate: "2026-09-12" });
    await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -300, txnDate: "2026-08-20" });
    const r = await review("2026-09");
    expect(r).toMatchObject({
      month: "2026-09",
      previousMonth: "2026-08",
      totals: { spentMinor: 1_500, overallMinor: 120_000, trackedMinor: 4_000 },
      previousTotals: { spentMinor: 1_100, overallMinor: 100_000, trackedMinor: 0 },
      hasPrevious: true,
    });
    expect(r.categories).toEqual([
      { categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 1_500, previousSpentMinor: 800, changeMinor: 700, allocatedMinor: 1_000, over: true },
      { categoryId: SEEDED.clothes, kind: "tracked", spentMinor: 4_000, previousSpentMinor: 0, changeMinor: 4_000, allocatedMinor: null, over: false },
      { categoryId: null, kind: null, spentMinor: 0, previousSpentMinor: 300, changeMinor: -300, allocatedMinor: null, over: false },
    ]);
  });

  it("ranks the top 5 merchants by spend, one key across both accounts, named by the latest text", async () => {
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-09-02" });
    await txn(accounts[1], { merchant: "GROCER ", amountMinor: -500, txnDate: "2026-09-20" });
    await txn(accounts[0], { merchant: "Grocer", amountMinor: 200, txnDate: "2026-09-10" }); // a refund: less spend, not a visit
    for (const [i, amount] of [900, 800, 700, 600, 100].entries()) {
      await txn(accounts[0], { merchant: `Shop ${i}`, amountMinor: -amount, txnDate: "2026-09-05" });
    }
    const r = await review("2026-09");
    expect(r.topMerchants).toEqual([
      { merchantKey: "grocer", name: "GROCER ", spentMinor: 1_300, visits: 2 },
      { merchantKey: "shop 0", name: "Shop 0", spentMinor: 900, visits: 1 },
      { merchantKey: "shop 1", name: "Shop 1", spentMinor: 800, visits: 1 },
      { merchantKey: "shop 2", name: "Shop 2", spentMinor: 700, visits: 1 },
      { merchantKey: "shop 3", name: "Shop 3", spentMinor: 600, visits: 1 },
    ]);
  });

  it("says there's nothing to compare in the first month of history", async () => {
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-09-02" });
    expect(await review("2026-09")).toMatchObject({ hasPrevious: false, previousTotals: { spentMinor: 0, overallMinor: null, trackedMinor: 0 } });
  });

  it("lists an archived category's spend without an allocation", async () => {
    await insertOverall("2026-09", 100_000);
    await insertAllocation(SEEDED.groceries, "2026-09", 1_000);
    await env.DB.prepare("UPDATE categories SET archived_at = ?1 WHERE id = ?2").bind(NOW, SEEDED.groceries).run();
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_500, txnDate: "2026-09-10" });
    expect((await review("2026-09")).categories).toEqual([
      { categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 1_500, previousSpentMinor: 0, changeMinor: 1_500, allocatedMinor: null, over: false },
    ]);
  });
});
