import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { readBudget, type BudgetRows } from "../budget/effective";
import { londonMonth } from "../importer/dates";
import { idParam, parseBody } from "./query";

// One overall monthly figure, parts of it allocated to budgeted categories, and the rest is
// Misc (docs/phase-2-spec.md, Budget figures). Every write goes to the current London month, so
// past months keep their figures and there are no future-dated rows. One user, so no lock
// between the check and the write.

// zod's int() also refuses unsafe integers.
const amountBody = (min: number) => z.object({ amountMinor: z.number().int().min(min) });

const sumAllocated = ({ allocations }: BudgetRows) => allocations.reduce((sum, a) => sum + a.allocatedMinor, 0);

function toBudget(month: string, rows: BudgetRows) {
  const { overallMinor, allocations } = rows;
  const allocatedMinor = sumAllocated(rows);
  return {
    month,
    overallMinor,
    allocatedMinor,
    miscMinor: overallMinor === null ? null : overallMinor - allocatedMinor,
    // The most this category could be set to: overall minus every other allocation.
    categories: allocations.map((a) => ({
      ...a,
      maxAllocatableMinor: overallMinor === null ? null : overallMinor - allocatedMinor + a.allocatedMinor,
    })),
  };
}

export const budgetRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const month = londonMonth(new Date());
    return c.json(toBudget(month, await readBudget(c.env.DB, month)));
  })
  .put("/overall", async (c) => {
    const body = await parseBody(c, amountBody(1));
    if (!body.ok) return body.res;
    const amountMinor = body.data.amountMinor;
    const now = new Date();
    const month = londonMonth(now);
    const rows = await readBudget(c.env.DB, month);
    const allocatedMinor = sumAllocated(rows);
    if (amountMinor < allocatedMinor) return c.json({ error: "below_allocated", minOverallMinor: allocatedMinor }, 422);
    await c.env.DB.prepare(
      `INSERT INTO monthly_budgets (effective_month, amount_minor, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (effective_month) DO UPDATE SET amount_minor = excluded.amount_minor, updated_at = excluded.updated_at`,
    )
      .bind(month, amountMinor, now.toISOString())
      .run();
    return c.json(toBudget(month, { ...rows, overallMinor: amountMinor }));
  })
  .put("/categories/:categoryId", async (c) => {
    const categoryId = idParam(c, "categoryId");
    if (categoryId === null) return c.json({ error: "bad_request" }, 400);
    const body = await parseBody(c, amountBody(0));
    if (!body.ok) return body.res;
    const amountMinor = body.data.amountMinor;
    const now = new Date();
    const month = londonMonth(now);
    const rows = await readBudget(c.env.DB, month);
    const current = rows.allocations.find((a) => a.categoryId === categoryId);
    // Only budgeted, unarchived categories are listed; anything else says why it can't be allocated.
    if (!current) {
      const category = await c.env.DB.prepare("SELECT kind, archived_at FROM categories WHERE id = ?1")
        .bind(categoryId)
        .first<{ kind: string; archived_at: string | null }>();
      if (!category) return c.json({ error: "not_found" }, 404);
      return c.json({ error: category.archived_at !== null ? "category_archived" : "category_not_budgeted" }, 409);
    }
    const { overallMinor } = rows;
    if (overallMinor === null) return c.json({ error: "overall_budget_not_set" }, 409);
    // A cut is always allowed, so an over-allocated budget can be brought back under.
    const maxAllocatableMinor = overallMinor - sumAllocated(rows) + current.allocatedMinor;
    if (amountMinor > current.allocatedMinor && amountMinor > maxAllocatableMinor) {
      return c.json({ error: "over_allocated", maxAllocatableMinor }, 422);
    }
    await c.env.DB.prepare(
      `INSERT INTO category_budgets (category_id, effective_month, amount_minor, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (category_id, effective_month) DO UPDATE SET amount_minor = excluded.amount_minor, updated_at = excluded.updated_at`,
    )
      .bind(categoryId, month, amountMinor, now.toISOString())
      .run();
    const allocations = rows.allocations.map((a) => (a.categoryId === categoryId ? { ...a, allocatedMinor: amountMinor } : a));
    return c.json(toBudget(month, { overallMinor, allocations }));
  });
