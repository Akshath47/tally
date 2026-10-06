import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "./db";
import { get } from "./http";
import { budgetLines } from "../src/web/lines";
import { insertAllocation, insertOverall } from "./budget/budget-rows";
import { SEEDED, insertCategory, insertOverride, insertRule, ledger } from "./budget/helpers";

// All data is synthetic.

type Txn = { id: number; amountMinor: number; countedAmountMinor: number | null; categoryId: number | null };
type Page = { transactions: Txn[]; nextCursor: string | null };
type Summary = Parameters<typeof budgetLines>[0] & { spentMinor: number; pendingSpentMinor: number };

const list = async (category: string | number, month = "2026-10", extra = "") => {
  const res = await get(`/api/months/${month}/transactions?category=${category}${extra}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
};
const ids = (p: Page) => p.transactions.map((t) => t.id).sort((a, b) => a - b);
const spend = (p: Page) => p.transactions.reduce((sum, t) => sum - (t.countedAmountMinor ?? t.amountMinor), 0);

let accounts: readonly [number, number];
let txn: Awaited<ReturnType<typeof ledger>>["txn"];

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  ({ accounts, txn } = await ledger());
  await insertRule("exact", "grocer", SEEDED.groceries);
  await insertRule("exact", "cafe", SEEDED.eatingOut);
  await insertRule("exact", "outfitter", SEEDED.clothes);
  await insertRule("exact", "salary", SEEDED.income);
});
afterEach(() => vi.useRealTimers());

const grocer = (amountMinor: number, extra: Parameters<typeof txn>[1] = {}) => txn(accounts[0], { merchant: "Grocer", amountMinor, ...extra });

describe("GET /api/months/:month/transactions?category=<id>", () => {
  it("lists the category's rows that count in the month, refunds and pending included", async () => {
    const spent = await grocer(-1_000);
    const refund = await grocer(300);
    const pending = await grocer(-200, { isPending: true });
    await grocer(-900, { txnDate: "2026-09-30" });
    await grocer(-400, { isPending: true, vanished: true });
    await insertOverride(await grocer(-500), { excluded: 1 });
    await txn(accounts[1], { merchant: "Cafe", amountMinor: -700 });
    expect(ids(await list(SEEDED.groceries))).toEqual([spent, refund, pending]);
  });

  it("files a row by its counted date and its override category", async () => {
    const movedIn = await grocer(-1_000, { txnDate: "2026-09-29" });
    await insertOverride(movedIn, { counted_date: "2026-10-01" });
    await insertOverride(await grocer(-500), { counted_date: "2026-09-30" });
    const recategorised = await txn(accounts[0], { merchant: "Cafe", amountMinor: -250 });
    await insertOverride(recategorised, { category_id: SEEDED.groceries });
    expect(ids(await list(SEEDED.groceries))).toEqual([movedIn, recategorised]);
  });

  it("lists nothing for a category that doesn't count", async () => {
    await txn(accounts[0], { merchant: "Salary", amountMinor: -100 });
    expect((await list(SEEDED.income)).transactions).toEqual([]);
  });

  it("pages newest first with a cursor", async () => {
    const older = await grocer(-100, { txnDate: "2026-10-01" });
    const newer = await grocer(-200, { txnDate: "2026-10-02" });
    const first = await list(SEEDED.groceries, "2026-10", "&limit=1");
    expect(first.transactions.map((t) => t.id)).toEqual([newer]);
    const second = await list(SEEDED.groceries, "2026-10", `&limit=1&cursor=${first.nextCursor}`);
    expect(second).toEqual({ transactions: [expect.objectContaining({ id: older })], nextCursor: null });
  });
});

describe("GET /api/months/:month/transactions?category=misc", () => {
  it("lists uncategorised money out and budgeted categories with no allocation", async () => {
    await insertOverall("2026-10", 100_000);
    await insertAllocation(SEEDED.groceries, "2026-10", 20_000);
    await grocer(-1_000);
    const unallocated = await txn(accounts[0], { merchant: "Cafe", amountMinor: -700 });
    const uncategorised = await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -300 });
    await txn(accounts[0], { merchant: "Unknown sender", amountMinor: 2_000 });
    await txn(accounts[0], { merchant: "Outfitter", amountMinor: -5_000 });
    expect(ids(await list("misc"))).toEqual([unallocated, uncategorised]);
  });

  it("includes an archived budgeted category, which has no allocation any more", async () => {
    const gifts = await insertCategory("Gifts");
    await insertAllocation(gifts, "2026-10", 5_000);
    await env.DB.prepare("UPDATE categories SET archived_at = '2026-10-10T00:00:00Z' WHERE id = ?1").bind(gifts).run();
    const id = await txn(accounts[0], { merchant: "Shop", amountMinor: -400 });
    await insertOverride(id, { category_id: gifts });
    expect(ids(await list("misc"))).toEqual([id]);
  });

  it("pages with a cursor", async () => {
    const older = await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -100, txnDate: "2026-10-01" });
    const newer = await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -200, txnDate: "2026-10-02" });
    const first = await list("misc", "2026-10", "&limit=1");
    expect(first.transactions.map((t) => t.id)).toEqual([newer]);
    const second = await list("misc", "2026-10", `&limit=1&cursor=${first.nextCursor}`);
    expect(second).toEqual({ transactions: [expect.objectContaining({ id: older })], nextCursor: null });
  });
});

describe("GET /api/months/:month/transactions?category=uncategorised-pending", () => {
  it("lists uncategorised pending money out, which Misc leaves out", async () => {
    const pending = await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -300, isPending: true });
    const posted = await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -200 });
    await txn(accounts[0], { merchant: "Unknown sender", amountMinor: 900, isPending: true });
    // Categorised, so it stays with its category: Misc here, as Groceries has no allocation.
    const categorised = await grocer(-400, { isPending: true });
    await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -100, isPending: true, vanished: true });
    expect(ids(await list("uncategorised-pending"))).toEqual([pending]);
    expect(ids(await list("misc"))).toEqual([posted, categorised]);
  });
});

describe("GET /api/months/:month/transactions?category=posted|pending", () => {
  it("splits the month's budget spend into posted and pending, categorised or not, tracked left out", async () => {
    const posted = await grocer(-1_000);
    const pending = await grocer(-300, { isPending: true });
    const uncategorisedPosted = await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -200 });
    const uncategorisedPending = await txn(accounts[1], { merchant: "Unknown shop", amountMinor: -450, isPending: true });
    await txn(accounts[0], { merchant: "Outfitter", amountMinor: -5_000 });
    await txn(accounts[0], { merchant: "Outfitter", amountMinor: -900, isPending: true });
    await grocer(-400, { isPending: true, vanished: true });
    expect(ids(await list("posted"))).toEqual([posted, uncategorisedPosted]);
    expect(ids(await list("pending"))).toEqual([pending, uncategorisedPending]);
  });
});

describe("GET /api/months/:month/transactions: agrees with Home", () => {
  it("adds up to each line Home draws from the summary", async () => {
    await insertOverall("2026-10", 100_000);
    await insertAllocation(SEEDED.groceries, "2026-10", 20_000);
    await insertAllocation(SEEDED.transport, "2026-10", 0);
    const archived = await insertCategory("Gifts");
    await insertAllocation(archived, "2026-10", 5_000);
    await env.DB.prepare("UPDATE categories SET archived_at = '2026-10-10T00:00:00Z' WHERE id = ?1").bind(archived).run();
    await grocer(-1_000);
    await grocer(250);
    await grocer(-300, { isPending: true });
    await insertOverride(await grocer(-800, { txnDate: "2026-09-28" }), { counted_date: "2026-10-02", counted_amount_minor: -600 });
    await txn(accounts[0], { merchant: "Cafe", amountMinor: -700 });
    await txn(accounts[1], { merchant: "Unknown shop", amountMinor: -300 });
    await txn(accounts[1], { merchant: "Unknown shop", amountMinor: -450, isPending: true });
    await txn(accounts[0], { merchant: "Outfitter", amountMinor: -5_000 });
    await insertOverride(await txn(accounts[0], { merchant: "Shop", amountMinor: -400 }), { category_id: archived });

    const s = (await (await get("/api/months/2026-10/summary")).json()) as Summary;
    const lines = budgetLines(s, new Map());
    expect(lines.map((l) => l.category)).toEqual([SEEDED.groceries, "misc", "uncategorised-pending"]);
    for (const l of lines) expect(spend(await list(l.category)), String(l.category)).toBe(l.spentMinor);
    // The Posted and Pending pills.
    expect(spend(await list("posted"))).toBe(s.spentMinor - s.pendingSpentMinor);
    expect(spend(await list("pending"))).toBe(s.pendingSpentMinor);
  });
});

describe("GET /api/months/:month/transactions: bad requests", () => {
  it.each([
    ["/api/months/2026-13/transactions?category=1"],
    ["/api/months/2026-11/transactions?category=1"], // a future month
    ["/api/months/2026-10/transactions"],
    ["/api/months/2026-10/transactions?category=0"],
    ["/api/months/2026-10/transactions?category=food"],
    ["/api/months/2026-10/transactions?category=constructor"],
  ])("%s → 400", async (path) => {
    expect((await get(path)).status).toBe(400);
  });
});
