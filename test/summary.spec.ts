import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "./db";
import { ORIGIN, app, get } from "./http";
import { insertAllocation, insertOverall } from "./budget/budget-rows";
import { SEEDED, insertCategory, insertOverride, insertRule, ledger } from "./budget/helpers";

// All data is synthetic.

type CategoryLine = { categoryId: number | null; kind: string | null; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number };
type Summary = {
  month: string;
  overallMinor: number | null;
  allocatedMinor: number;
  miscMinor: number | null;
  spentMinor: number;
  pendingSpentMinor: number;
  leftMinor: number | null;
  daysRemaining: number | null;
  perWeekMinor: number | null;
  categories: CategoryLine[];
  trackedMinor: number;
  inboxCount: number;
  lastDataChangeAt: string | null;
};

const summary = async (month = "2026-10") => {
  const res = await get(`/api/months/${month}/summary`);
  expect(res.status).toBe(200);
  return (await res.json()) as Summary;
};
const line = (s: Summary, categoryId: number | null) => s.categories.find((c) => c.categoryId === categoryId);
const at = (iso: string) => vi.setSystemTime(new Date(iso));

let accounts: readonly [number, number];
let txn: Awaited<ReturnType<typeof ledger>>["txn"];

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-15T12:00:00Z");
  ({ accounts, txn } = await ledger());
  // Synthetic merchants with rules, one per kind.
  await insertRule("exact", "grocer", SEEDED.groceries);
  await insertRule("exact", "outfitter", SEEDED.clothes);
  await insertRule("exact", "salary", SEEDED.income);
});
afterEach(() => vi.useRealTimers());

const grocer = (amountMinor: number, extra: Parameters<typeof txn>[1] = {}) => txn(accounts[0], { merchant: "Grocer", amountMinor, ...extra });

describe("GET /api/months/:month/summary: what counts", () => {
  it("counts budgeted spend, keeps tracked spend apart and ignores excluded categories", async () => {
    await grocer(-1_000);
    await txn(accounts[0], { merchant: "Outfitter", amountMinor: -5_000 });
    await txn(accounts[0], { merchant: "Salary", amountMinor: 300_000 });
    await txn(accounts[0], { merchant: "Salary", amountMinor: -100 }); // a payment out to an excluded category
    const s = await summary();
    expect(s).toMatchObject({ spentMinor: 1_000, pendingSpentMinor: 0, trackedMinor: 5_000 });
    expect(line(s, SEEDED.groceries)).toEqual({ categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 1_000, pendingSpentMinor: 0, allocatedMinor: 0 });
    expect(line(s, SEEDED.clothes)).toEqual({ categoryId: SEEDED.clothes, kind: "tracked", spentMinor: 5_000, pendingSpentMinor: 0, allocatedMinor: 0 });
    expect(line(s, SEEDED.income)).toBeUndefined();
  });

  it("ignores a transaction excluded by its override", async () => {
    const id = await grocer(-1_000);
    await insertOverride(id, { excluded: 1 });
    expect(await summary()).toMatchObject({ spentMinor: 0, categories: [] });
  });

  it("counts uncategorised money out, not money in, and puts both in the inbox", async () => {
    await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -700 });
    await txn(accounts[0], { merchant: "Unknown sender", amountMinor: 2_000 });
    const s = await summary();
    expect(s).toMatchObject({ spentMinor: 700, inboxCount: 2 });
    expect(s.categories).toEqual([{ categoryId: null, kind: null, spentMinor: 700, pendingSpentMinor: 0, allocatedMinor: 0 }]);
  });

  it("lists no Uncategorised line when the month's only uncategorised rows are money in", async () => {
    await txn(accounts[0], { merchant: "Unknown sender", amountMinor: 2_000 });
    await txn(accounts[0], { merchant: "Unknown sender", amountMinor: 0 });
    expect(await summary()).toMatchObject({ spentMinor: 0, inboxCount: 2, categories: [] });
  });

  it("lets a refund reduce its category's spend", async () => {
    await grocer(-3_000);
    await grocer(1_000);
    expect(line(await summary(), SEEDED.groceries)!.spentMinor).toBe(2_000);
  });

  it("lists a category whose refunds cancel its spend, at 0", async () => {
    await grocer(-1_000);
    await grocer(1_000);
    expect(line(await summary(), SEEDED.groceries)).toMatchObject({ spentMinor: 0 });
  });

  it("uses the counted amount instead of the bank amount", async () => {
    const id = await grocer(-4_000);
    await insertOverride(id, { counted_amount_minor: -1_500 });
    expect((await summary()).spentMinor).toBe(1_500);
  });

  it("uses an override's category over the rule", async () => {
    const id = await grocer(-1_000);
    await insertOverride(id, { category_id: SEEDED.transport });
    const s = await summary();
    expect(line(s, SEEDED.groceries)).toBeUndefined();
    expect(line(s, SEEDED.transport)!.spentMinor).toBe(1_000);
  });

  it("ignores a vanished row, so a superseded pending row and its posted row count once", async () => {
    await grocer(-1_000, { isPending: true, vanished: true });
    await grocer(-1_000);
    expect((await summary()).spentMinor).toBe(1_000);
  });

  it("reports pending spend on its own and inside the totals", async () => {
    await grocer(-1_000);
    await grocer(-250, { isPending: true });
    await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -100, isPending: true });
    const s = await summary();
    expect(s).toMatchObject({ spentMinor: 1_350, pendingSpentMinor: 350 });
    expect(line(s, SEEDED.groceries)).toMatchObject({ spentMinor: 1_250, pendingSpentMinor: 250 });
    expect(line(s, null)).toMatchObject({ spentMinor: 100, pendingSpentMinor: 100 });
  });

  it("counts an archived budgeted category's spend against the budget", async () => {
    const pets = await insertCategory("Pets");
    await insertRule("exact", "pet shop", pets);
    await env.DB.prepare("UPDATE categories SET archived_at = ?2 WHERE id = ?1").bind(pets, "2026-10-01T00:00:00.000Z").run();
    await txn(accounts[0], { merchant: "Pet shop", amountMinor: -900 });
    const s = await summary();
    expect(s.spentMinor).toBe(900);
    expect(line(s, pets)).toMatchObject({ kind: "budgeted", spentMinor: 900, allocatedMinor: 0 });
  });
});

describe("GET /api/months/:month/summary: months", () => {
  it("counts a transaction in the month of its counted date", async () => {
    const moved = await grocer(-1_000, { txnDate: "2026-09-30" });
    await insertOverride(moved, { counted_date: "2026-10-01" });
    const out = await grocer(-500, { txnDate: "2026-10-02" });
    await insertOverride(out, { counted_date: "2026-11-01" });
    await grocer(-200, { txnDate: "2026-09-15" });
    expect((await summary("2026-10")).spentMinor).toBe(1_000);
    expect((await summary("2026-09")).spentMinor).toBe(200);
  });

  it("refuses a malformed or future month", async () => {
    for (const month of ["2026-13", "2026-00", "2026-1", "202610", "2026-10-01", "2026-11", "2027-01"]) {
      const res = await get(`/api/months/${month}/summary`);
      expect(res.status, month).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
  });
});

describe("GET /api/months/:month/summary: budget figures", () => {
  it("has null figures before any budget, and still shows spend", async () => {
    await grocer(-1_000);
    expect(await summary()).toMatchObject({
      overallMinor: null, allocatedMinor: 0, miscMinor: null, spentMinor: 1_000, leftMinor: null, daysRemaining: 17, perWeekMinor: null,
    });
  });

  it("takes allocated, misc and left from the effective rows", async () => {
    await insertOverall("2026-09", 100_000);
    await insertAllocation(SEEDED.groceries, "2026-09", 30_000);
    await insertAllocation(SEEDED.bills, "2026-10", 20_000);
    await grocer(-10_000);
    const s = await summary();
    expect(s).toMatchObject({ overallMinor: 100_000, allocatedMinor: 50_000, miscMinor: 50_000, spentMinor: 10_000, leftMinor: 90_000 });
    expect(line(s, SEEDED.groceries)).toEqual({ categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 10_000, pendingSpentMinor: 0, allocatedMinor: 30_000 });
    // An allocation with no spend is still listed; a budgeted category with neither isn't.
    expect(line(s, SEEDED.bills)).toEqual({ categoryId: SEEDED.bills, kind: "budgeted", spentMinor: 0, pendingSpentMinor: 0, allocatedMinor: 20_000 });
    expect(line(s, SEEDED.transport)).toBeUndefined();
    // September has its own figures.
    expect(await summary("2026-09")).toMatchObject({ overallMinor: 100_000, allocatedMinor: 30_000, spentMinor: 0 });
  });

  it("orders categories by id with Uncategorised last", async () => {
    await insertOverall("2026-10", 100_000);
    await insertAllocation(SEEDED.bills, "2026-10", 1_000);
    await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -1 });
    await txn(accounts[0], { merchant: "Outfitter", amountMinor: -1 });
    await grocer(-1);
    expect((await summary()).categories.map((c) => c.categoryId)).toEqual([SEEDED.groceries, SEEDED.bills, SEEDED.clothes, null]);
  });
});

describe("GET /api/months/:month/summary: pacing", () => {
  beforeEach(() => insertOverall("2026-01", 100_000));

  it("gives the whole of what's left on the last day of the month", async () => {
    at("2026-10-31T12:00:00Z");
    await grocer(-40_000);
    expect(await summary()).toMatchObject({ leftMinor: 60_000, daysRemaining: 1, perWeekMinor: 420_000 });
  });

  it("floors the per-week figure", async () => {
    at("2026-10-29T12:00:00Z"); // 29, 30 and 31 left
    await grocer(-99_000);
    expect(await summary()).toMatchObject({ leftMinor: 1_000, daysRemaining: 3, perWeekMinor: 2_333 });
  });

  it("is 0 a week once nothing is left", async () => {
    await grocer(-100_000);
    expect(await summary()).toMatchObject({ leftMinor: 0, perWeekMinor: 0 });
    await grocer(-1);
    expect(await summary()).toMatchObject({ leftMinor: -1, perWeekMinor: 0 });
  });

  it("is null for a past month", async () => {
    expect(await summary("2026-09")).toMatchObject({ leftMinor: 100_000, daysRemaining: null, perWeekMinor: null });
  });

  it("follows the London date at the end of March", async () => {
    at("2026-03-31T22:30:00Z"); // 23:30 BST, still 31 March
    expect(await summary("2026-03")).toMatchObject({ daysRemaining: 1 });
    at("2026-03-31T23:30:00Z"); // 00:30 BST, 1 April
    expect(await summary("2026-03")).toMatchObject({ daysRemaining: null, perWeekMinor: null });
    expect(await summary("2026-04")).toMatchObject({ daysRemaining: 30 });
  });
});

describe("GET /api/months/:month/summary: freshness and cost", () => {
  it("gives the latest data change across enabled accounts, or null", async () => {
    expect((await summary()).lastDataChangeAt).toBeNull();
    const set = (id: number, at: string, enabled = 1) =>
      env.DB.prepare("UPDATE accounts SET last_data_change_at = ?2, import_enabled = ?3 WHERE id = ?1").bind(id, at, enabled).run();
    await set(accounts[0], "2026-10-14T08:00:00.000Z");
    await set(accounts[1], "2026-10-15T08:00:00.000Z", 0);
    expect((await summary()).lastDataChangeAt).toBe("2026-10-14T08:00:00.000Z");
  });

  // The budget, the month's lines, the inbox count and the freshness: each reads only its own rows.
  it("runs 4 D1 statements", async () => {
    await grocer(-1_000);
    let statements = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => (statements++, target.prepare(sql));
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await app.request(`${ORIGIN}/api/months/2026-10/summary`, {}, { ...env, DB: db });
    expect(res.status).toBe(200);
    expect(statements).toBe(4);
  });
});
