import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { readBudget } from "../../src/worker/budget/effective";
import { resetDb } from "../db";
import { SEEDED_BUDGETED as BUDGETED, insertAllocation, insertOverall } from "./budget-rows";
import { SEEDED } from "./helpers";

// All data is synthetic.

beforeEach(resetDb);

const allocationOf = async (month: string, categoryId: number) =>
  (await readBudget(env.DB, month)).allocations.find((a) => a.categoryId === categoryId)?.allocatedMinor;

describe("readBudget", () => {
  it("takes the overall figure from the latest row on or before the month", async () => {
    await insertOverall("2026-08", 100_000);
    await insertOverall("2026-10", 120_000);
    const overall = async (m: string) => (await readBudget(env.DB, m)).overallMinor;
    expect(await overall("2026-07")).toBeNull();
    expect(await overall("2026-08")).toBe(100_000);
    expect(await overall("2026-09")).toBe(100_000);
    expect(await overall("2026-10")).toBe(120_000);
    expect(await overall("2026-12")).toBe(120_000);
  });

  it("takes each category's allocation from its own latest row, and a later 0 removes it", async () => {
    await insertAllocation(SEEDED.groceries, "2026-08", 30_000);
    await insertAllocation(SEEDED.groceries, "2026-10", 0);
    await insertAllocation(SEEDED.transport, "2026-09", 5_000);
    expect(await allocationOf("2026-07", SEEDED.groceries)).toBe(0);
    expect(await allocationOf("2026-09", SEEDED.groceries)).toBe(30_000);
    expect(await allocationOf("2026-10", SEEDED.groceries)).toBe(0);
    expect(await allocationOf("2026-08", SEEDED.transport)).toBe(0);
    expect(await allocationOf("2026-11", SEEDED.transport)).toBe(5_000);
  });

  it("lists every budgeted, unarchived category by id, with 0 when it has no allocation", async () => {
    const { overallMinor, allocations } = await readBudget(env.DB, "2026-10");
    expect(overallMinor).toBeNull();
    expect(allocations).toEqual(BUDGETED.map((categoryId) => ({ categoryId, allocatedMinor: 0 })));
  });

  it("leaves out tracked, excluded and archived categories, even with an allocation", async () => {
    await insertAllocation(SEEDED.clothes, "2026-10", 1_000);
    await insertAllocation(SEEDED.income, "2026-10", 1_000);
    await insertAllocation(SEEDED.other, "2026-10", 1_000);
    await env.DB.prepare("UPDATE categories SET archived_at = '2026-10-01T00:00:00.000Z' WHERE id = ?1").bind(SEEDED.other).run();
    const ids = (await readBudget(env.DB, "2026-10")).allocations.map((a) => a.categoryId);
    expect(ids).toEqual(BUDGETED.filter((id) => id !== SEEDED.other));
  });

  it("still returns the overall figure when no category is budgeted", async () => {
    await insertOverall("2026-10", 50_000);
    await env.DB.prepare("UPDATE categories SET kind = 'tracked' WHERE kind = 'budgeted'").run();
    expect(await readBudget(env.DB, "2026-10")).toEqual({ overallMinor: 50_000, allocations: [] });
  });
});
