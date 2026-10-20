import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { budgetSpend, firstDataMonth, spendByMonth, trackedSpend } from "../../src/worker/analytics/spend";
import { SEEDED, insertOverride, insertRule, ledger } from "../budget/helpers";
import { resetDb } from "../db";

// All data is synthetic.

let a: number;
let txn: Awaited<ReturnType<typeof ledger>>["txn"];

beforeEach(async () => {
  await resetDb();
  const l = await ledger();
  a = l.accounts[0];
  txn = l.txn;
  await insertRule("exact", "grocer", SEEDED.groceries);
  await insertRule("exact", "outfitter", SEEDED.clothes);
  await insertRule("exact", "salary", SEEDED.income);
});

describe("spendByMonth", () => {
  it("groups counted spend by month and category, with pending apart", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-09-30" });
    await txn(a, { merchant: "Grocer", amountMinor: -500, txnDate: "2026-10-01", isPending: true });
    await txn(a, { merchant: "Outfitter", amountMinor: -2_000, txnDate: "2026-10-02" });
    await txn(a, { merchant: "Salary", amountMinor: 300_000, txnDate: "2026-10-02" });
    await txn(a, { merchant: "Unknown shop", amountMinor: -700, txnDate: "2026-10-03" });
    await txn(a, { merchant: "Unknown sender", amountMinor: 900, txnDate: "2026-10-03" });
    const rows = await spendByMonth(env.DB, "2026-09-01", "2026-10-31");
    expect(rows).toEqual([
      { month: "2026-09", categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 1_000, pendingSpentMinor: 0 },
      { month: "2026-10", categoryId: null, kind: null, spentMinor: 700, pendingSpentMinor: 0 },
      { month: "2026-10", categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 500, pendingSpentMinor: 500 },
      { month: "2026-10", categoryId: SEEDED.clothes, kind: "tracked", spentMinor: 2_000, pendingSpentMinor: 0 },
    ]);
    const october = rows.filter((r) => r.month === "2026-10");
    expect(budgetSpend(october)).toBe(1_200);
    expect(trackedSpend(october)).toBe(2_000);
  });

  it("follows the counted date, not the bank date, at both ends of the range", async () => {
    const movedIn = await txn(a, { merchant: "Grocer", amountMinor: -100, txnDate: "2026-09-30" });
    const movedOut = await txn(a, { merchant: "Grocer", amountMinor: -200, txnDate: "2026-10-31" });
    await insertOverride(movedIn, { counted_date: "2026-10-01" });
    await insertOverride(movedOut, { counted_date: "2026-11-01" });
    expect(await spendByMonth(env.DB, "2026-10-01", "2026-10-31")).toEqual([
      { month: "2026-10", categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 100, pendingSpentMinor: 0 },
    ]);
    // A week-sized range follows the counted date too (the digest's week spend uses it).
    expect(await spendByMonth(env.DB, "2026-10-26", "2026-11-01")).toEqual([
      { month: "2026-11", categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 200, pendingSpentMinor: 0 },
    ]);
  });

  it("ignores vanished rows and excluded overrides", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -100, txnDate: "2026-10-05", vanished: true });
    const excluded = await txn(a, { merchant: "Grocer", amountMinor: -200, txnDate: "2026-10-05" });
    await insertOverride(excluded, { excluded: 1 });
    expect(await spendByMonth(env.DB, "2026-10-01", "2026-10-31")).toEqual([]);
  });
});

describe("firstDataMonth", () => {
  it("is null on an empty ledger and the earliest month otherwise", async () => {
    expect(await firstDataMonth(env.DB)).toBeNull();
    await txn(a, { txnDate: "2025-03-14" });
    await txn(a, { txnDate: "2026-01-02" });
    expect(await firstDataMonth(env.DB)).toBe("2025-03");
  });
});
