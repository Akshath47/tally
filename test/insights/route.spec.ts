import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAllocation, insertOverall } from "../budget/budget-rows";
import { SEEDED, insertRule, ledger } from "../budget/helpers";
import { resetDb } from "../db";
import { get } from "../http";

// All data is synthetic. "Today" is Thu 15 Oct 2026 unless a test moves it.

type Body = { asOf: string; items: Record<string, unknown>[] };
const insights = async () => (await (await get("/api/insights")).json()) as Body;
const at = (iso: string) => vi.setSystemTime(new Date(iso));

let a: number;
let txn: Awaited<ReturnType<typeof ledger>>["txn"];

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-15T12:00:00Z");
  const l = await ledger();
  a = l.accounts[0];
  txn = l.txn;
  await insertRule("exact", "grocer", SEEDED.groceries);
  await env.DB.prepare("UPDATE accounts SET last_data_change_at = ?1").bind("2026-10-15T09:00:00Z").run();
});
afterEach(() => vi.useRealTimers());

describe("GET /api/insights", () => {
  it("is an empty list on an empty ledger", async () => {
    expect(await insights()).toEqual({ asOf: "2026-10-15", items: [] });
  });

  it("reports a category over its allocation", async () => {
    await insertOverall("2026-10", 1_000_000);
    await insertAllocation(SEEDED.groceries, "2026-10", 1_000);
    await txn(a, { merchant: "Grocer", amountMinor: -1_500, txnDate: "2026-10-03" });
    expect((await insights()).items).toContainEqual(expect.objectContaining({ type: "pace", state: "over", categoryId: SEEDED.groceries, spentMinor: 1_500 }));
  });

  it("averages the baseline over days 1 to today's day only", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -100, txnDate: "2026-06-20" }); // history starts in June
    for (const m of ["07", "08", "09"]) await txn(a, { merchant: "Grocer", amountMinor: -4_000, txnDate: `2026-${m}-10` });
    await txn(a, { merchant: "Grocer", amountMinor: -9_000, txnDate: "2026-09-20" }); // after day 15: not in the baseline
    await txn(a, { merchant: "Grocer", amountMinor: -7_000, txnDate: "2026-10-04" });
    expect((await insights()).items).toContainEqual(expect.objectContaining({ type: "unusual_category", categoryId: SEEDED.groceries, spentMinor: 7_000, baselineMinor: 4_000 }));
  });

  it("flags a new merchant's large charge in the last 7 days, not one 8 days ago", async () => {
    const recent = await txn(a, { merchant: "Big shop", amountMinor: -15_000, txnDate: "2026-10-09" });
    await txn(a, { merchant: "Old shop", amountMinor: -15_000, txnDate: "2026-10-08" });
    const items = (await insights()).items.filter((i) => i.type === "large_charge");
    expect(items).toEqual([expect.objectContaining({ transactionId: recent, merchantKey: "big shop", name: "Big shop", merchantAverageMinor: null, isPending: false })]);
  });

  it("counts a merchant's earlier charges within 182 days only", async () => {
    // 3 earlier charges of £20 would make £60+ out of line, but one is 183 days back, so only 2 count.
    for (const d of ["2026-04-11", "2026-08-01", "2026-09-01"]) await txn(a, { merchant: "Cafe", amountMinor: -2_000, txnDate: d });
    await txn(a, { merchant: "Cafe", amountMinor: -20_000, txnDate: "2026-10-11" });
    expect((await insights()).items.filter((i) => i.type === "large_charge")).toEqual([]);
    await txn(a, { merchant: "Cafe", amountMinor: -2_000, txnDate: "2026-04-12" }); // exactly 182 days before
    expect((await insights()).items.filter((i) => i.type === "large_charge")).toEqual([
      expect.objectContaining({ spentMinor: 20_000, merchantAverageMinor: 2_000 }),
    ]);
  });

  it("finds a new merchant's charge behind more than 10 bigger, regular ones", async () => {
    // Three earlier £200 charges make each recent £200 one ordinary for its merchant.
    for (const d of ["2026-07-01", "2026-08-01", "2026-09-01"]) await txn(a, { merchant: "Regular", amountMinor: -20_000, txnDate: d });
    for (let i = 0; i < 11; i++) await txn(a, { merchant: "Regular", amountMinor: -20_000, txnDate: "2026-10-14" });
    await txn(a, { merchant: "New shop", amountMinor: -12_000, txnDate: "2026-10-13" });
    const items = (await insights()).items.filter((i) => i.type === "large_charge");
    expect(items).toEqual([expect.objectContaining({ merchantKey: "new shop", spentMinor: 12_000, merchantAverageMinor: null })]);
  });

  it("skips a large charge with no merchant page to link to", async () => {
    await txn(a, { merchant: "   ", amountMinor: -15_000, txnDate: "2026-10-13" });
    await txn(a, { merchant: "x".repeat(201), amountMinor: -15_000, txnDate: "2026-10-13" });
    expect((await insights()).items.filter((i) => i.type === "large_charge")).toEqual([]);
  });

  it("drops a pending large charge once it's vanished, and keeps a live one marked pending", async () => {
    await txn(a, { merchant: "Big shop", amountMinor: -20_000, txnDate: "2026-10-12", isPending: true, vanished: true });
    expect((await insights()).items.filter((i) => i.type === "large_charge")).toEqual([]);
    await txn(a, { merchant: "Big shop", amountMinor: -20_000, txnDate: "2026-10-13", isPending: true });
    expect((await insights()).items.filter((i) => i.type === "large_charge")).toEqual([expect.objectContaining({ isPending: true })]);
  });

  it("reports a stale account first", async () => {
    await env.DB.prepare("UPDATE accounts SET last_data_change_at = ?1 WHERE id = ?2").bind("2026-10-10T09:00:00Z", a).run();
    await txn(a, { merchant: "Big shop", amountMinor: -20_000, txnDate: "2026-10-12" });
    const { items } = await insights();
    expect(items[0]).toMatchObject({ type: "stale_account", accountId: a, staleDays: 5 });
  });

  it("compares the last two whole months in the first week", async () => {
    at("2026-10-03T12:00:00Z");
    await txn(a, { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-08-10" });
    await txn(a, { merchant: "Grocer", amountMinor: -6_000, txnDate: "2026-09-28" });
    expect((await insights()).items).toContainEqual(expect.objectContaining({ type: "month_change", month: "2026-09", spentMinor: 6_000, previousSpentMinor: 1_000 }));
  });
});
