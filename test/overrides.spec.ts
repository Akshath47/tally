import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./db";
import { send } from "./http";
import { SEEDED, insertOverride, insertRule, ledger } from "./budget/helpers";

// PUT and DELETE /api/transactions/:id/override. All data is synthetic.

type Txn = {
  id: number;
  categoryId: number | null;
  categorySource: "override" | "rule" | null;
  excluded: boolean;
  countedAmountMinor: number | null;
  countedDate: string | null;
  note: string | null;
};

const put = (id: number, body: unknown) => send("PUT", `/api/transactions/${id}/override`, body);
const del = (id: number) => send("DELETE", `/api/transactions/${id}/override`);
const txnOf = async (res: Response) => ((await res.json()) as { transaction: Txn }).transaction;

const overrideRow = (id: number) => env.DB.prepare("SELECT * FROM transaction_overrides WHERE transaction_id = ?1").bind(id).first();
const rules = async () =>
  (await env.DB.prepare("SELECT match_type, pattern, account_id, category_id FROM merchant_rules ORDER BY id").all()).results;

let L: Awaited<ReturnType<typeof ledger>>;
let a1: number;
let a2: number;

beforeEach(async () => {
  await resetDb();
  L = await ledger();
  [a1, a2] = L.accounts;
});

describe("PUT /api/transactions/:id/override", () => {
  it("stores every field and returns the transaction as listed", async () => {
    const id = await L.txn(a1);
    const res = await put(id, {
      categoryId: SEEDED.shopping,
      excluded: true,
      countedAmountMinor: -250,
      countedDate: "2026-09-30",
      note: "  half was a gift  ",
    });
    expect(res.status).toBe(200);
    expect(await txnOf(res)).toMatchObject({
      id,
      categoryId: SEEDED.shopping,
      categorySource: "override",
      excluded: true,
      countedAmountMinor: -250,
      countedDate: "2026-09-30",
      note: "  half was a gift  ",
    });
  });

  it("moves a rule-decided row to the override's category", async () => {
    await insertRule("exact", "synthetic cafe", SEEDED.eatingOut);
    const id = await L.txn(a1, { merchant: "Synthetic Cafe" });
    expect(await txnOf(await put(id, { categoryId: SEEDED.groceries }))).toMatchObject({
      categoryId: SEEDED.groceries,
      categorySource: "override",
    });
  });

  it("replaces the whole override: a field left out goes back to its default", async () => {
    const id = await L.txn(a1);
    await put(id, { categoryId: SEEDED.shopping, note: "first" });
    expect(await txnOf(await put(id, { excluded: true }))).toMatchObject({ categoryId: null, excluded: true, note: null });
  });

  it.each([
    ["an empty body", {}],
    ["every field at its default", { categoryId: null, excluded: false, countedAmountMinor: null, countedDate: null, note: null }],
    ["an empty note", { note: "" }],
  ])("removes the override for %s", async (_, body) => {
    const id = await L.txn(a1);
    await insertOverride(id, { category_id: SEEDED.shopping, note: "x" });
    const res = await put(id, body);
    expect(res.status).toBe(200);
    expect(await txnOf(res)).toMatchObject({ categoryId: null, categorySource: null, note: null });
    expect(await overrideRow(id)).toBeNull();
  });

  it.each([
    ["pending", { isPending: true }],
    ["vanished", { isPending: true, vanished: true }],
  ])("refuses a %s row and writes nothing", async (_, fields) => {
    const id = await L.txn(a1, fields);
    const res = await put(id, { categoryId: SEEDED.shopping });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_editable" });
    expect(await overrideRow(id)).toBeNull();
  });

  it("returns 404 for an unknown transaction or category", async () => {
    const id = await L.txn(a1);
    expect((await put(9999, { excluded: true })).status).toBe(404);
    const res = await put(id, { categoryId: 9999 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(await overrideRow(id)).toBeNull();
  });

  it("refuses an archived category, unless the override already has it", async () => {
    const archive = () =>
      env.DB.prepare("UPDATE categories SET archived_at = '2026-10-01T00:00:00.000Z' WHERE id = ?1").bind(SEEDED.other).run();
    const fresh = await L.txn(a1);
    const kept = await L.txn(a1);
    await put(kept, { categoryId: SEEDED.other });
    await archive();

    const res = await put(fresh, { categoryId: SEEDED.other });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "category_archived" });
    // The editor resends its full form when only the note changes.
    const resent = await put(kept, { categoryId: SEEDED.other, note: "still here" });
    expect(resent.status).toBe(200);
    expect(await txnOf(resent)).toMatchObject({ categoryId: SEEDED.other, note: "still here" });
  });

  it.each([
    ["a fractional amount", { countedAmountMinor: 12.5 }],
    ["an amount as text", { countedAmountMinor: "100" }],
    ["an unsafe integer", { countedAmountMinor: 2 ** 53 }],
    ["an impossible date", { countedDate: "2026-02-30" }],
    ["a timestamp for a date", { countedDate: "2026-09-30T00:00:00Z" }],
    ["a 501-character note", { note: "a".repeat(501) }],
    ["excluded as text", { excluded: "true" }],
    ["a category id as text", { categoryId: "1" }],
    ["applyToMerchant without a category", { applyToMerchant: true }],
  ])("rejects %s with 400 and writes nothing", async (_, body) => {
    const id = await L.txn(a1);
    const res = await put(id, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
    expect(await overrideRow(id)).toBeNull();
  });

  it("returns 400 for a non-numeric id", async () => {
    expect((await put(Number.NaN, {})).status).toBe(400);
  });

  it("requires the app's Origin", async () => {
    const id = await L.txn(a1);
    const res = await send("PUT", `/api/transactions/${id}/override`, { excluded: true }, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await overrideRow(id)).toBeNull();
  });
});

describe("PUT /api/transactions/:id/override with applyToMerchant", () => {
  it("writes an any-account exact rule for the merchant and no category override", async () => {
    const id = await L.txn(a1, { merchant: "  Synthetic GROCER " });
    const other = await L.txn(a2, { merchant: "synthetic grocer" });
    const res = await put(id, { categoryId: SEEDED.groceries, applyToMerchant: true, note: "weekly shop" });
    expect(res.status).toBe(200);
    expect(await txnOf(res)).toMatchObject({ categoryId: SEEDED.groceries, categorySource: "rule", note: "weekly shop" });
    expect(await rules()).toEqual([{ match_type: "exact", pattern: "synthetic grocer", account_id: null, category_id: SEEDED.groceries }]);
    expect(await overrideRow(id)).toMatchObject({ category_id: null, note: "weekly shop" });
    // Every row from that merchant follows the rule.
    expect(await txnOf(await put(other, {}))).toMatchObject({ categoryId: SEEDED.groceries, categorySource: "rule" });
  });

  it("updates the existing rule rather than adding one", async () => {
    const id = await L.txn(a1, { merchant: "Synthetic Grocer" });
    await put(id, { categoryId: SEEDED.groceries, applyToMerchant: true });
    await put(id, { categoryId: SEEDED.shopping, applyToMerchant: true });
    expect(await rules()).toEqual([{ match_type: "exact", pattern: "synthetic grocer", account_id: null, category_id: SEEDED.shopping }]);
  });

  it("also updates this account's own exact rule, which outranks the any-account one", async () => {
    await insertRule("exact", "synthetic grocer", SEEDED.other, a1);
    await insertRule("exact", "synthetic grocer", SEEDED.shopping, a2);
    const id = await L.txn(a1, { merchant: "Synthetic Grocer" });
    const res = await put(id, { categoryId: SEEDED.groceries, applyToMerchant: true });
    expect(await txnOf(res)).toMatchObject({ categoryId: SEEDED.groceries, categorySource: "rule" });
    // Another account's own rule is the owner's separate choice, and stays.
    expect(await rules()).toEqual([
      { match_type: "exact", pattern: "synthetic grocer", account_id: a1, category_id: SEEDED.groceries },
      { match_type: "exact", pattern: "synthetic grocer", account_id: a2, category_id: SEEDED.shopping },
      { match_type: "exact", pattern: "synthetic grocer", account_id: null, category_id: SEEDED.groceries },
    ]);
  });

  it("clears an existing category override so the row follows the rule", async () => {
    const id = await L.txn(a1, { merchant: "Synthetic Grocer" });
    await insertOverride(id, { category_id: SEEDED.shopping, excluded: 1 });
    const res = await put(id, { categoryId: SEEDED.groceries, excluded: true, applyToMerchant: true });
    expect(await txnOf(res)).toMatchObject({ categoryId: SEEDED.groceries, categorySource: "rule", excluded: true });
  });

  // The same patterns POST and PATCH /api/rules refuse, so the rules editor can always save the rule.
  it.each([
    ["blank", "   "],
    ["longer than 100 characters", "x".repeat(101)],
    ["edged with a newline", "Synthetic Grocer\n"],
  ])("refuses a merchant that's %s, which can't be a rule's pattern", async (_, merchant) => {
    const id = await L.txn(a1, { merchant });
    const res = await put(id, { categoryId: SEEDED.groceries, applyToMerchant: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "merchant_not_rulable" });
    expect(await rules()).toEqual([]);
    expect(await overrideRow(id)).toBeNull();
  });

  it("refuses a pending row without writing a rule", async () => {
    const id = await L.txn(a1, { merchant: "Synthetic Grocer", isPending: true });
    expect((await put(id, { categoryId: SEEDED.groceries, applyToMerchant: true })).status).toBe(409);
    expect(await rules()).toEqual([]);
  });
});

describe("DELETE /api/transactions/:id/override", () => {
  it("restores the bank values and the rule's category", async () => {
    await insertRule("exact", "synthetic cafe", SEEDED.eatingOut);
    const id = await L.txn(a1, { merchant: "Synthetic Cafe" });
    await put(id, { categoryId: SEEDED.groceries, countedAmountMinor: -1, note: "x" });
    const res = await del(id);
    expect(res.status).toBe(200);
    expect(await txnOf(res)).toMatchObject({
      categoryId: SEEDED.eatingOut,
      categorySource: "rule",
      countedAmountMinor: null,
      note: null,
    });
    expect(await overrideRow(id)).toBeNull();
  });

  it("succeeds when there is no override", async () => {
    expect((await del(await L.txn(a1))).status).toBe(200);
  });

  it("returns 404 for an unknown transaction and 409 for a pending one", async () => {
    expect((await del(9999)).status).toBe(404);
    const res = await del(await L.txn(a1, { isPending: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_editable" });
  });
});
