import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "./db";
import { get, send } from "./http";
import { budgetRows, insertAllocation, insertOverall } from "./budget/budget-rows";
import { SEEDED } from "./budget/helpers";

// All data is synthetic.

type Category = { id: number; name: string; kind: string; archived: boolean };

const list = async () => ((await (await get("/api/categories")).json()) as { categories: Category[] }).categories;
const create = (body: unknown) => send("POST", "/api/categories", body);
const patch = (id: number | string, body: unknown) => send("PATCH", `/api/categories/${id}`, body);

beforeEach(resetDb);

describe("GET /api/categories", () => {
  it("lists the seeded categories in order, with their kinds", async () => {
    const all = await list();
    expect(all).toHaveLength(14);
    expect(all[0]).toEqual({ id: SEEDED.groceries, name: "Groceries", kind: "budgeted", archived: false });
    expect(all.find((c) => c.name === "Clothes")!.kind).toBe("tracked");
    expect(all.find((c) => c.name === "Income")!.kind).toBe("excluded");
  });
});

describe("POST /api/categories", () => {
  it("creates a category with a trimmed name", async () => {
    const res = await create({ name: "  Pets ", kind: "budgeted" });
    expect(res.status).toBe(201);
    const { category } = (await res.json()) as { category: Category };
    expect(category).toEqual({ id: 15, name: "Pets", kind: "budgeted", archived: false });
    expect((await list()).at(-1)).toEqual(category);
  });

  it("refuses a name another category has, in any case", async () => {
    const res = await create({ name: "groceries", kind: "tracked" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "name_taken" });
  });

  it.each([
    { name: "Pets", kind: "monthly" },
    { name: "   ", kind: "budgeted" },
    { name: "x".repeat(51), kind: "budgeted" },
    { kind: "budgeted" },
    { name: 7, kind: "budgeted" },
  ])("rejects %j", async (body) => {
    expect((await create(body)).status).toBe(400);
  });

  it("rejects a cross-site request and a non-JSON body", async () => {
    expect((await send("POST", "/api/categories", { name: "Pets", kind: "budgeted" }, { Origin: "https://evil.example" })).status).toBe(403);
    const plain = await send("POST", "/api/categories", { name: "Pets", kind: "budgeted" }, { "Content-Type": "text/plain" });
    expect(plain.status).toBe(415);
  });
});

describe("PATCH /api/categories/:id", () => {
  it("renames a category, including to a different case of its own name", async () => {
    let res = await patch(SEEDED.groceries, { name: "Food shop" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { category: Category }).category.name).toBe("Food shop");
    res = await patch(SEEDED.groceries, { name: "FOOD SHOP" });
    expect(res.status).toBe(200);
  });

  it("refuses another category's name in any case", async () => {
    const res = await patch(SEEDED.groceries, { name: "eating OUT" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "name_taken" });
  });

  it("changes the kind", async () => {
    const res = await patch(SEEDED.shopping, { kind: "tracked" });
    expect(((await res.json()) as { category: Category }).category).toMatchObject({ kind: "tracked" });
  });

  it("archives and unarchives, keeping archived categories in the list", async () => {
    await patch(SEEDED.other, { archived: true });
    expect((await list()).find((c) => c.id === SEEDED.other)!.archived).toBe(true);
    await patch(SEEDED.other, { archived: false });
    expect((await list()).find((c) => c.id === SEEDED.other)!.archived).toBe(false);
  });

  it("keeps the archive time when archiving twice", async () => {
    await patch(SEEDED.other, { archived: true });
    const first = await env.DB.prepare("SELECT archived_at FROM categories WHERE id = ?1").bind(SEEDED.other).first();
    await patch(SEEDED.other, { archived: true, name: "Misc things" });
    expect(await env.DB.prepare("SELECT archived_at FROM categories WHERE id = ?1").bind(SEEDED.other).first()).toEqual(first);
  });

  it("returns 404 for an unknown category, and 400 for a bad id or body", async () => {
    expect((await patch(999, { name: "X" })).status).toBe(404);
    expect((await patch("abc", { name: "X" })).status).toBe(400);
    expect((await patch(SEEDED.groceries, {})).status).toBe(400);
    expect((await patch(SEEDED.groceries, { kind: "weekly" })).status).toBe(400);
    expect((await patch(SEEDED.groceries, { archived: "yes" })).status).toBe(400);
  });
});

describe("PATCH /api/categories/:id and budget allocations", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    await insertOverall("2026-09", 100_000);
    await insertAllocation(SEEDED.shopping, "2026-09", 20_000);
  });
  afterEach(() => vi.useRealTimers());

  const SEPTEMBER = { categoryId: SEEDED.shopping, month: "2026-09", amount: 20_000 };

  it.each([{ kind: "tracked" }, { kind: "excluded" }, { archived: true }])(
    "%j zeroes the allocation from the current month and keeps past months",
    async (body) => {
      expect((await patch(SEEDED.shopping, body)).status).toBe(200);
      expect((await budgetRows()).allocations).toEqual([SEPTEMBER, { categoryId: SEEDED.shopping, month: "2026-10", amount: 0 }]);
    },
  );

  it("zeroes it at the London month, which can be ahead of UTC", async () => {
    vi.setSystemTime(new Date("2026-09-30T23:30:00Z")); // BST: already October in London
    await patch(SEEDED.shopping, { archived: true });
    expect((await budgetRows()).allocations.at(-1)).toEqual({ categoryId: SEEDED.shopping, month: "2026-10", amount: 0 });
  });

  it("writes no budget row for a rename, or for a category with no allocation", async () => {
    await patch(SEEDED.shopping, { name: "Stuff" });
    await patch(SEEDED.groceries, { kind: "tracked" });
    await patch(SEEDED.transport, { archived: true });
    expect((await budgetRows()).allocations).toEqual([SEPTEMBER]);
  });

  it("zeroes nothing when the patch fails", async () => {
    const res = await patch(SEEDED.shopping, { name: "Groceries", kind: "tracked" });
    expect(res.status).toBe(409);
    expect((await list()).find((c) => c.id === SEEDED.shopping)!.kind).toBe("budgeted");
    expect((await budgetRows()).allocations).toEqual([SEPTEMBER]);
  });

  it("lists an unarchived category in the budget again, at 0", async () => {
    await patch(SEEDED.shopping, { archived: true });
    await patch(SEEDED.shopping, { archived: false });
    const budget = (await (await get("/api/budget")).json()) as { categories: { categoryId: number; allocatedMinor: number }[] };
    expect(budget.categories.find((c) => c.categoryId === SEEDED.shopping)).toMatchObject({ allocatedMinor: 0 });
  });
});
