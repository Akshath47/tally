import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineStatus } from "../../src/worker/digest/content";
import { insertAllocation, insertOverall } from "../budget/budget-rows";
import { SEEDED, insertOverride, insertRule, ledger } from "../budget/helpers";
import { NOW, resetDb } from "../db";
import { get } from "../http";

// All data is synthetic. "Today" is Thu 15 Oct 2026 unless a test moves it; its week began Mon 12 Oct.

type Digest = {
  weekStart: string; weekEnd: string; spansMonths: boolean; weekSpentMinor: number; weekPendingSpentMinor: number;
  month: { month: string; spentMinor: number; overallMinor: number | null; leftMinor: number | null; perWeekMinor: number | null; daysRemaining: number | null };
  categories: { categoryId: number | null; spentMinor: number; allocatedMinor: number; status: string }[];
  insights: { type: string }[]; inboxCount: number; staleAccountIds: number[]; lastDataChangeAt: string | null;
  lastSend: { weekStart: string; status: string; sentAt: string | null } | null;
};
const preview = async () => (await (await get("/api/digest/preview")).json()) as Digest;
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
  await insertRule("exact", "outfitter", SEEDED.clothes);
});
afterEach(() => vi.useRealTimers());

describe("lineStatus", () => {
  it.each([
    [10_001, 10_000, "2026-10-02", "over"],
    [9_000, 10_000, "2026-10-15", "projected_over"], // 9000 × 31 ÷ 15 = 18600
    [9_000, 10_000, "2026-10-03", "near"], // too early to project
    [3_000, 10_000, "2026-10-15", "ok"], // projects 6200
    [0, 0, "2026-10-15", "ok"],
    [100, 0, "2026-10-15", "over"],
  ])("%i of %i on %s → %s", (spent, allocated, today, status) => expect(lineStatus(spent, allocated, today)).toBe(status));
});

describe("GET /api/digest/preview", () => {
  it("sums budget spend counted Monday to today, by counted date", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-10-11" }); // Sunday before: out
    await txn(a, { merchant: "Grocer", amountMinor: -2_000, txnDate: "2026-10-12" });
    await txn(a, { merchant: "Grocer", amountMinor: -300, txnDate: "2026-10-15", isPending: true });
    await txn(a, { merchant: "Outfitter", amountMinor: -9_000, txnDate: "2026-10-13" }); // tracked: out
    const moved = await txn(a, { merchant: "Grocer", amountMinor: -400, txnDate: "2026-10-09" });
    await insertOverride(moved, { counted_date: "2026-10-13" }); // counted in the week
    const d = await preview();
    expect(d).toMatchObject({ weekStart: "2026-10-12", weekEnd: "2026-10-15", spansMonths: false, weekSpentMinor: 2_700, weekPendingSpentMinor: 300 });
  });

  it("spans two months at the start of October and keeps the month figures to October", async () => {
    at("2026-10-01T12:00:00Z");
    await txn(a, { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-09-29" });
    await txn(a, { merchant: "Grocer", amountMinor: -500, txnDate: "2026-10-01" });
    const d = await preview();
    expect(d).toMatchObject({ weekStart: "2026-09-28", spansMonths: true, weekSpentMinor: 1_500, month: { month: "2026-10", spentMinor: 500 } });
  });

  it("lists each allocated category, then Misc of posted uncategorised and unallocated spend", async () => {
    await insertOverall("2026-10", 100_000);
    await insertAllocation(SEEDED.groceries, "2026-10", 10_000);
    await txn(a, { merchant: "Grocer", amountMinor: -9_000, txnDate: "2026-10-05" });
    await txn(a, { merchant: "Unknown shop", amountMinor: -700, txnDate: "2026-10-05" });
    await txn(a, { merchant: "Unknown shop", amountMinor: -200, txnDate: "2026-10-14", isPending: true }); // pending: not in Misc
    await insertRule("exact", "cab", SEEDED.transport); // budgeted, no allocation: Misc
    await txn(a, { merchant: "Cab", amountMinor: -1_100, txnDate: "2026-10-06" });
    expect((await preview()).categories).toEqual([
      { categoryId: SEEDED.groceries, spentMinor: 9_000, allocatedMinor: 10_000, status: "projected_over" },
      { categoryId: null, spentMinor: 1_800, allocatedMinor: 90_000, status: "ok" },
    ]);
  });

  it("leaves Misc out when Home would: nothing unallocated and nothing spent there", async () => {
    await insertOverall("2026-10", 100_000);
    await insertAllocation(SEEDED.groceries, "2026-10", 105_000); // over-allocated: Misc is −£50
    await txn(a, { merchant: "Grocer", amountMinor: -9_000, txnDate: "2026-10-05" });
    expect((await preview()).categories.map((l) => l.categoryId)).toEqual([SEEDED.groceries]);
  });

  it("reports a send stuck in 'sending' for over 15 minutes as failed", async () => {
    await env.DB.prepare("INSERT INTO digest_sends (week_start, status, attempted_at) VALUES ('2026-10-05', 'sending', '2026-10-11T17:00:00Z')").run();
    expect((await preview()).lastSend).toEqual({ weekStart: "2026-10-05", status: "failed", sentAt: null });
  });

  it("works with no budget set: no left, no pace, no category lines", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -9_000, txnDate: "2026-10-05" });
    const d = await preview();
    expect(d.month).toMatchObject({ overallMinor: null, leftMinor: null, perWeekMinor: null, spentMinor: 9_000 });
    expect(d.categories).toEqual([]);
  });

  it("includes the insights, the to-sort count and the latest send", async () => {
    await insertOverall("2026-10", 1_000);
    await txn(a, { merchant: "Unknown shop", amountMinor: -5_000, txnDate: "2026-10-05" });
    expect(await preview()).toMatchObject({ inboxCount: 1, lastSend: null, insights: [{ type: "pace" }] });
    await env.DB.prepare("INSERT INTO digest_sends (week_start, status, attempted_at, sent_at) VALUES ('2026-10-05', 'sent', ?1, ?1)").bind(NOW).run();
    expect((await preview()).lastSend).toEqual({ weekStart: "2026-10-05", status: "sent", sentAt: NOW });
  });
});
