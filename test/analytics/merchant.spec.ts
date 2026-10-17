import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEEDED, insertOverride, insertRule, ledger } from "../budget/helpers";
import { resetDb } from "../db";
import { get } from "../http";

// All data is synthetic.

type Merchant = {
  merchantKey: string;
  name: string;
  categoryId: number | null;
  categorySource: "rule" | null;
  accountIds: number[];
  firstSeenDate: string | null;
  months: { month: string; spentMinor: number; visits: number }[];
  windowSpentMinor: number;
  windowVisits: number;
  averageChargeMinor: number | null;
  recent: { id: number; excluded: boolean }[];
};
const merchant = (key: string) => get(`/api/merchants?key=${encodeURIComponent(key)}`);

let accounts: readonly [number, number];
let txn: Awaited<ReturnType<typeof ledger>>["txn"];

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  ({ accounts, txn } = await ledger());
});
afterEach(() => vi.useRealTimers());

describe("GET /api/merchants", () => {
  it("is 404 for an unknown key and 400 for an empty or overlong one", async () => {
    expect((await merchant("nobody")).status).toBe(404);
    expect((await get("/api/merchants?key=")).status).toBe(400);
    expect((await get("/api/merchants")).status).toBe(400);
    expect((await merchant("x".repeat(201))).status).toBe(400);
  });

  it("matches keys with URL-special characters literally", async () => {
    await txn(accounts[0], { merchant: "50% & Co/UK", amountMinor: -1_000, txnDate: "2026-10-02" });
    await txn(accounts[0], { merchant: "50X & Co/UK", amountMinor: -1_000, txnDate: "2026-10-02" });
    const res = await merchant("50% & co/uk");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Merchant).windowVisits).toBe(1);
  });

  it("joins both accounts under one key, aligned with trends, with a floored average", async () => {
    await insertRule("exact", "grocer", SEEDED.groceries);
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-02-14" }); // before the window
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-09-03" });
    await txn(accounts[1], { merchant: "GROCER ", amountMinor: -1_001, txnDate: "2026-10-04" });
    const m = (await (await merchant("grocer")).json()) as Merchant;
    expect(m).toMatchObject({
      merchantKey: "grocer",
      name: "GROCER ",
      categoryId: SEEDED.groceries,
      categorySource: "rule",
      accountIds: [accounts[0], accounts[1]],
      firstSeenDate: "2026-02-14",
      windowSpentMinor: 2_001,
      windowVisits: 2,
      averageChargeMinor: 1_000,
    });
    expect(m.months.map((x) => x.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(m.months.slice(4)).toEqual([
      { month: "2026-09", spentMinor: 1_000, visits: 1 },
      { month: "2026-10", spentMinor: 1_001, visits: 1 },
    ]);
  });

  it("takes the category from the rule, not from an override, and null without a rule", async () => {
    await insertRule("exact", "grocer", SEEDED.groceries);
    const id = await txn(accounts[0], { merchant: "Grocer", txnDate: "2026-10-02" });
    await insertOverride(id, { category_id: SEEDED.eatingOut });
    expect((await (await merchant("grocer")).json()) as Merchant).toMatchObject({ categoryId: SEEDED.groceries, categorySource: "rule" });
    await txn(accounts[0], { merchant: "Corner shop", txnDate: "2026-10-02" });
    expect((await (await merchant("corner shop")).json()) as Merchant).toMatchObject({ categoryId: null, categorySource: null });
  });

  it("lists the 20 most recent rows newest first, excluded ones included, vanished ones not", async () => {
    const ids: number[] = [];
    for (let d = 1; d <= 22; d++) ids.push(await txn(accounts[0], { merchant: "Cafe", txnDate: `2026-09-${String(d).padStart(2, "0")}` }));
    await insertOverride(ids[21]!, { excluded: 1 });
    await txn(accounts[0], { merchant: "Cafe", txnDate: "2026-09-30", vanished: true });
    const m = (await (await merchant("cafe")).json()) as Merchant;
    expect(m.recent).toHaveLength(20);
    expect(m.recent[0]).toMatchObject({ id: ids[21], excluded: true });
    expect(m.recent[19]!.id).toBe(ids[2]);
  });
});
