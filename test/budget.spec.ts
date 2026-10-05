import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBudget } from "../src/worker/budget/effective";
import { resetDb } from "./db";
import { send } from "./http";
import { SEEDED_BUDGETED as BUDGETED, budgetRows, getBudget, insertAllocation, insertOverall, type Budget } from "./budget/budget-rows";
import { SEEDED } from "./budget/helpers";

// All data is synthetic.

const putOverall = (body: unknown) => send("PUT", "/api/budget/overall", body);
const putAllocation = (id: number | string, body: unknown) => send("PUT", `/api/budget/categories/${id}`, body);
const categoryRow = (b: Budget, id: number) => b.categories.find((c) => c.categoryId === id)!;
const at = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-15T12:00:00Z");
});
afterEach(() => vi.useRealTimers());

describe("GET /api/budget", () => {
  it("has null figures before an overall budget, with every budgeted category at 0", async () => {
    expect(await getBudget()).toEqual({
      month: "2026-10",
      overallMinor: null,
      allocatedMinor: 0,
      miscMinor: null,
      categories: BUDGETED.map((categoryId) => ({ categoryId, allocatedMinor: 0, maxAllocatableMinor: null })),
    });
  });

  it("adds up allocated, misc and each category's limit", async () => {
    await insertOverall("2026-09", 200_000);
    await insertAllocation(SEEDED.groceries, "2026-09", 40_000);
    await insertAllocation(SEEDED.bills, "2026-10", 100_000);
    const b = await getBudget();
    expect(b).toMatchObject({ month: "2026-10", overallMinor: 200_000, allocatedMinor: 140_000, miscMinor: 60_000 });
    expect(categoryRow(b, SEEDED.groceries)).toEqual({ categoryId: SEEDED.groceries, allocatedMinor: 40_000, maxAllocatableMinor: 100_000 });
    expect(categoryRow(b, SEEDED.bills)).toEqual({ categoryId: SEEDED.bills, allocatedMinor: 100_000, maxAllocatableMinor: 160_000 });
    expect(categoryRow(b, SEEDED.transport).maxAllocatableMinor).toBe(60_000);
  });
});

describe("PUT /api/budget/overall", () => {
  it("sets the figure for the current month and answers with the new budget", async () => {
    const res = await putOverall({ amountMinor: 150_000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await getBudget());
    expect((await getBudget()).overallMinor).toBe(150_000);
    expect((await budgetRows()).overall).toEqual([{ month: "2026-10", amount: 150_000 }]);
  });

  it("refuses a figure below the allocations with the lowest allowed figure", async () => {
    await insertOverall("2026-10", 100_000);
    await insertAllocation(SEEDED.groceries, "2026-10", 30_000);
    await insertAllocation(SEEDED.bills, "2026-10", 50_000);
    const res = await putOverall({ amountMinor: 79_999 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "below_allocated", minOverallMinor: 80_000 });
    expect((await getBudget()).overallMinor).toBe(100_000);
    expect((await putOverall({ amountMinor: 80_000 })).status).toBe(200);
    expect(await getBudget()).toMatchObject({ overallMinor: 80_000, miscMinor: 0 });
  });

  it("ignores allocations on categories that no longer count", async () => {
    await insertOverall("2026-10", 100_000);
    await insertAllocation(SEEDED.clothes, "2026-10", 90_000);
    expect((await putOverall({ amountMinor: 10_000 })).status).toBe(200);
  });
});

describe("PUT /api/budget/categories/:categoryId", () => {
  beforeEach(() => insertOverall("2026-10", 50_000));

  it("allocates for the current month and answers with the new budget", async () => {
    const res = await putAllocation(SEEDED.groceries, { amountMinor: 30_000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Budget;
    expect(body).toEqual(await getBudget());
    expect(body).toMatchObject({ allocatedMinor: 30_000, miscMinor: 20_000 });
    expect((await budgetRows()).allocations).toEqual([{ categoryId: SEEDED.groceries, month: "2026-10", amount: 30_000 }]);
  });

  it("refuses more than overall minus the other allocations, and says how much is allowed", async () => {
    await insertAllocation(SEEDED.bills, "2026-10", 15_000);
    await insertAllocation(SEEDED.groceries, "2026-10", 30_000);
    const res = await putAllocation(SEEDED.transport, { amountMinor: 5_001 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "over_allocated", maxAllocatableMinor: 5_000 });
    // A category's own allocation doesn't count against it.
    const over = await putAllocation(SEEDED.groceries, { amountMinor: 35_001 });
    expect(await over.json()).toEqual({ error: "over_allocated", maxAllocatableMinor: 35_000 });
    expect((await putAllocation(SEEDED.groceries, { amountMinor: 35_000 })).status).toBe(200);
    expect(await getBudget()).toMatchObject({ allocatedMinor: 50_000, miscMinor: 0 });
  });

  it("always accepts a cut, so an over-allocated budget can be brought back under", async () => {
    await insertAllocation(SEEDED.groceries, "2026-10", 40_000);
    await insertAllocation(SEEDED.bills, "2026-10", 30_000); // written outside the API
    const over = await putAllocation(SEEDED.groceries, { amountMinor: 40_001 });
    expect(await over.json()).toEqual({ error: "over_allocated", maxAllocatableMinor: 20_000 });
    expect((await putAllocation(SEEDED.groceries, { amountMinor: 25_000 })).status).toBe(200);
    expect(await getBudget()).toMatchObject({ allocatedMinor: 55_000, miscMinor: -5_000 });
    expect((await putAllocation(SEEDED.groceries, { amountMinor: 20_000 })).status).toBe(200);
    expect(await getBudget()).toMatchObject({ allocatedMinor: 50_000, miscMinor: 0 });
  });

  it("accepts 0, which removes the allocation from this month on", async () => {
    await insertAllocation(SEEDED.groceries, "2026-09", 30_000);
    expect((await putAllocation(SEEDED.groceries, { amountMinor: 0 })).status).toBe(200);
    expect(categoryRow(await getBudget(), SEEDED.groceries).allocatedMinor).toBe(0);
  });

  it("refuses an allocation before an overall figure is set", async () => {
    await env.DB.prepare("DELETE FROM monthly_budgets").run();
    const res = await putAllocation(SEEDED.groceries, { amountMinor: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "overall_budget_not_set" });
  });

  it("refuses a category that isn't budgeted, or is archived, and an unknown one", async () => {
    let res = await putAllocation(SEEDED.clothes, { amountMinor: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "category_not_budgeted" });
    await env.DB.prepare("UPDATE categories SET archived_at = ?2 WHERE id = ?1").bind(SEEDED.other, "2026-10-01T00:00:00.000Z").run();
    res = await putAllocation(SEEDED.other, { amountMinor: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "category_archived" });
    res = await putAllocation(999, { amountMinor: 1 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect((await budgetRows()).allocations).toEqual([]);
  });
});

describe("budget edits over time", () => {
  it("leave past months' figures alone", async () => {
    at("2026-09-10T12:00:00Z");
    await putOverall({ amountMinor: 100_000 });
    await putAllocation(SEEDED.groceries, { amountMinor: 40_000 });
    at("2026-10-02T12:00:00Z");
    await putOverall({ amountMinor: 120_000 });
    await putAllocation(SEEDED.groceries, { amountMinor: 60_000 });
    expect(await budgetRows()).toEqual({
      overall: [{ month: "2026-09", amount: 100_000 }, { month: "2026-10", amount: 120_000 }],
      allocations: [
        { categoryId: SEEDED.groceries, month: "2026-09", amount: 40_000 },
        { categoryId: SEEDED.groceries, month: "2026-10", amount: 60_000 },
      ],
    });
    const september = await readBudget(env.DB, "2026-09");
    expect(september.overallMinor).toBe(100_000);
    expect(september.allocations.find((a) => a.categoryId === SEEDED.groceries)!.allocatedMinor).toBe(40_000);
  });

  it("update the current month's row when made twice in one month", async () => {
    await putOverall({ amountMinor: 100_000 });
    await putOverall({ amountMinor: 90_000 });
    await putAllocation(SEEDED.groceries, { amountMinor: 1_000 });
    await putAllocation(SEEDED.groceries, { amountMinor: 2_000 });
    expect(await budgetRows()).toEqual({
      overall: [{ month: "2026-10", amount: 90_000 }],
      allocations: [{ categoryId: SEEDED.groceries, month: "2026-10", amount: 2_000 }],
    });
  });

  it.each([
    ["2026-03-31T23:30:00Z", "2026-04"], // BST: already April in London
    ["2026-10-31T23:30:00Z", "2026-10"], // GMT: still October
  ])("at %s land in %s", async (iso, month) => {
    at(iso);
    await putOverall({ amountMinor: 10_000 });
    await putAllocation(SEEDED.groceries, { amountMinor: 1_000 });
    expect((await getBudget()).month).toBe(month);
    expect(await budgetRows()).toEqual({
      overall: [{ month, amount: 10_000 }],
      allocations: [{ categoryId: SEEDED.groceries, month, amount: 1_000 }],
    });
  });
});

describe("budget input validation", () => {
  it.each([{ amountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 12.5 }, { amountMinor: "1000" }, { amountMinor: 2 ** 53 }, {}, null])(
    "refuses the overall figure %j",
    async (body) => {
      expect((await putOverall(body)).status).toBe(400);
      expect((await budgetRows()).overall).toEqual([]);
    },
  );

  it.each([{ amountMinor: -1 }, { amountMinor: 12.5 }, { amountMinor: "1000" }, { amountMinor: 2 ** 53 }, {}])(
    "refuses the allocation %j",
    async (body) => {
      await insertOverall("2026-10", 50_000);
      expect((await putAllocation(SEEDED.groceries, body)).status).toBe(400);
      expect((await budgetRows()).allocations).toEqual([]);
    },
  );

  it.each(["x", "0", "-1", "1.5"])("refuses the category id %s", async (id) => {
    await insertOverall("2026-10", 50_000);
    expect((await putAllocation(id, { amountMinor: 1 })).status).toBe(400);
  });

  it("refuses a cross-site request and a non-JSON body", async () => {
    expect((await send("PUT", "/api/budget/overall", { amountMinor: 1 }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await send("PUT", "/api/budget/overall", { amountMinor: 1 }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await budgetRows()).overall).toEqual([]);
  });
});
