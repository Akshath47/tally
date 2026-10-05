import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./db";
import { get, send } from "./http";
import { SEEDED, insertOverride, insertRule, ledger } from "./budget/helpers";

// GET /api/inbox and /api/inbox/merchants. All data is synthetic.

type Txn = { id: number; amountMinor: number; editable: boolean };
type Page = { transactions: Txn[]; nextCursor: string | null; total: number };
type Group = { pattern: string; merchant: string; count: number; totalMinor: number; latestDate: string; rulable: boolean };

const inbox = async (query = "") => (await (await get(`/api/inbox${query}`)).json()) as Page;
const groups = async () => ((await (await get("/api/inbox/merchants")).json()) as { merchants: Group[] }).merchants;

let L: Awaited<ReturnType<typeof ledger>>;
let a1: number;
let a2: number;

beforeEach(async () => {
  await resetDb();
  L = await ledger();
  [a1, a2] = L.accounts;
});

describe("GET /api/inbox", () => {
  it("lists uncategorised money out and money in, newest first, with a total", async () => {
    const out = await L.txn(a1, { amountMinor: -1200, txnDate: "2026-09-29" });
    const refund = await L.txn(a2, { amountMinor: 800, txnDate: "2026-09-30" });
    const body = await inbox();
    expect(body.transactions.map((t) => t.id)).toEqual([refund, out]);
    expect(body.total).toBe(2);
    expect(body.nextCursor).toBeNull();
  });

  it("leaves out rows a rule or override categorises, excluded rows and vanished ones", async () => {
    await insertRule("contains", "grocer", SEEDED.groceries);
    await L.txn(a1, { merchant: "Synthetic Grocer" });
    const overridden = await L.txn(a1, { merchant: "Unknown A" });
    await insertOverride(overridden, { category_id: SEEDED.shopping });
    const excluded = await L.txn(a1, { merchant: "Unknown B" });
    await insertOverride(excluded, { excluded: 1 });
    await L.txn(a1, { merchant: "Unknown C", isPending: true, vanished: true });
    const waiting = await L.txn(a1, { merchant: "Unknown D" });
    const body = await inbox();
    expect(body.transactions.map((t) => t.id)).toEqual([waiting]);
    expect(body.total).toBe(1);
  });

  it("includes a pending row, marked not editable", async () => {
    const pending = await L.txn(a1, { isPending: true });
    expect((await inbox()).transactions).toEqual([expect.objectContaining({ id: pending, editable: false })]);
  });

  it("pages without skipping or repeating rows, with the same total on every page", async () => {
    const ids: number[] = [];
    for (const day of ["2026-09-27", "2026-09-28", "2026-09-28", "2026-09-29", "2026-09-30"]) ids.push(await L.txn(a1, { txnDate: day }));
    const seen: number[] = [];
    let query = "?limit=2";
    for (;;) {
      const page = await inbox(query);
      expect(page.total).toBe(5);
      seen.push(...page.transactions.map((t) => t.id));
      if (!page.nextCursor) break;
      query = `?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`;
    }
    expect(seen).toEqual([ids[4], ids[3], ids[2], ids[1], ids[0]]);
  });

  it("keeps the total on a later page that emptied since the previous one", async () => {
    await L.txn(a1, { txnDate: "2026-09-30" });
    const older = await L.txn(a1, { txnDate: "2026-09-29" });
    const first = await inbox("?limit=1");
    await insertOverride(older, { category_id: SEEDED.shopping });
    const second = await inbox(`?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second).toEqual({ transactions: [], nextCursor: null, total: 1 });
  });

  it("returns an empty page and a zero total when everything is sorted", async () => {
    expect(await inbox()).toEqual({ transactions: [], nextCursor: null, total: 0 });
  });

  it.each(["limit=0", "limit=201", "cursor=garbage"])("rejects %s (400)", async (query) => {
    expect((await get(`/api/inbox?${query}`)).status).toBe(400);
  });
});

describe("GET /api/inbox/merchants", () => {
  it("groups by normalised merchant, with counted totals and the latest text and date", async () => {
    await L.txn(a1, { merchant: "SYNTHETIC CAFE", amountMinor: -300, txnDate: "2026-09-28" });
    await L.txn(a2, { merchant: " Synthetic Cafe ", amountMinor: -450, txnDate: "2026-09-30" });
    const halved = await L.txn(a1, { merchant: "synthetic cafe", amountMinor: -1000, txnDate: "2026-09-29" });
    await insertOverride(halved, { counted_amount_minor: -500 });
    await L.txn(a1, { merchant: "Synthetic Kiosk", amountMinor: -200, txnDate: "2026-10-01" });
    expect(await groups()).toEqual([
      { pattern: "synthetic cafe", merchant: " Synthetic Cafe ", count: 3, totalMinor: -1250, latestDate: "2026-09-30", rulable: true },
      { pattern: "synthetic kiosk", merchant: "Synthetic Kiosk", count: 1, totalMinor: -200, latestDate: "2026-10-01", rulable: true },
    ]);
  });

  it("flags a group no rule can be made from", async () => {
    await L.txn(a1, { merchant: "  " });
    await L.txn(a1, { merchant: "x".repeat(101) });
    expect((await groups()).map((g) => g.rulable)).toEqual([false, false]);
  });

  it("only groups what the inbox lists", async () => {
    const excluded = await L.txn(a1, { merchant: "Synthetic Cafe" });
    await insertOverride(excluded, { excluded: 1 });
    await L.txn(a1, { merchant: "Synthetic Cafe", isPending: true, vanished: true });
    expect(await groups()).toEqual([]);
  });

  it("is emptied by one rule created from a group's pattern", async () => {
    await L.txn(a1, { merchant: "SYNTHETIC CAFE" });
    await L.txn(a2, { merchant: "Synthetic Cafe " });
    const [group] = await groups();
    const res = await send("POST", "/api/rules", { matchType: "exact", pattern: group!.pattern, categoryId: SEEDED.eatingOut });
    expect(res.status).toBe(201);
    expect(await groups()).toEqual([]);
    expect((await inbox()).total).toBe(0);
  });
});
