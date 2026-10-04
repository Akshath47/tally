import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./db";
import { get } from "./http";
import { SEEDED, insertOverride, insertRule, ledger } from "./budget/helpers";

// The Phase 2 fields on GET /api/transactions. Phase 1's listing, filters and paging are in
// api.spec.ts. All data is synthetic.

type Txn = {
  id: number;
  isPending: boolean;
  categoryId: number | null;
  categorySource: "override" | "rule" | null;
  excluded: boolean;
  countedAmountMinor: number | null;
  countedDate: string | null;
  note: string | null;
  editable: boolean;
};

const list = async () => ((await (await get("/api/transactions")).json()) as { transactions: Txn[] }).transactions;
const byId = async (id: number) => (await list()).find((t) => t.id === id)!;

let L: Awaited<ReturnType<typeof ledger>>;
let a1: number;

beforeEach(async () => {
  await resetDb();
  L = await ledger();
  [a1] = L.accounts;
});

describe("GET /api/transactions: categories and overrides", () => {
  it("gives a rule-decided row its rule's category", async () => {
    await insertRule("exact", "synthetic grocer", SEEDED.groceries);
    const id = await L.txn(a1, { merchant: "Synthetic Grocer" });
    expect(await byId(id)).toMatchObject({ categoryId: SEEDED.groceries, categorySource: "rule" });
  });

  it("gives an overridden row its override's category and fields", async () => {
    await insertRule("exact", "synthetic grocer", SEEDED.groceries);
    const id = await L.txn(a1, { merchant: "Synthetic Grocer" });
    await insertOverride(id, {
      category_id: SEEDED.shopping,
      excluded: 1,
      counted_amount_minor: -500,
      counted_date: "2026-09-30",
      note: "split with a friend",
    });
    expect(await byId(id)).toMatchObject({
      categoryId: SEEDED.shopping,
      categorySource: "override",
      excluded: true,
      countedAmountMinor: -500,
      countedDate: "2026-09-30",
      note: "split with a friend",
    });
  });

  it("leaves an unmatched row uncategorised, with no override fields", async () => {
    const id = await L.txn(a1, { merchant: "Nobody Knows" });
    expect(await byId(id)).toMatchObject({
      categoryId: null,
      categorySource: null,
      excluded: false,
      countedAmountMinor: null,
      countedDate: null,
      note: null,
    });
  });

  it("marks only posted, counted rows editable", async () => {
    const posted = await L.txn(a1);
    const pending = await L.txn(a1, { isPending: true });
    const vanished = await L.txn(a1, { isPending: true, vanished: true });
    expect(await byId(posted)).toMatchObject({ editable: true, isPending: false });
    expect(await byId(pending)).toMatchObject({ editable: false, isPending: true });
    expect((await byId(vanished)).editable).toBe(false);
  });
});
