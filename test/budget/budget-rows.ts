import { env } from "cloudflare:workers";
import { NOW } from "../db";
import { get } from "../http";

// Raw-SQL budget rows for the P2.5 specs. All values are synthetic.

export const insertOverall = (month: string, amountMinor: number) =>
  env.DB.prepare("INSERT INTO monthly_budgets (effective_month, amount_minor, updated_at) VALUES (?1, ?2, ?3)").bind(month, amountMinor, NOW).run();

export const insertAllocation = (categoryId: number, month: string, amountMinor: number) =>
  env.DB.prepare("INSERT INTO category_budgets (category_id, effective_month, amount_minor, updated_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(categoryId, month, amountMinor, NOW)
    .run();

/** Every budget row, oldest month first, for checking what a write left behind. */
export async function budgetRows() {
  const [overall, allocations] = await Promise.all([
    env.DB.prepare("SELECT effective_month AS month, amount_minor AS amount FROM monthly_budgets ORDER BY effective_month").all(),
    env.DB.prepare(
      "SELECT category_id AS categoryId, effective_month AS month, amount_minor AS amount FROM category_budgets ORDER BY category_id, effective_month",
    ).all(),
  ]);
  return { overall: overall.results, allocations: allocations.results };
}

/** The seeded budgeted categories (0005_seed_categories.sql), in id order. */
export const SEEDED_BUDGETED = [1, 2, 3, 4, 5, 6, 7, 8];

export type Budget = {
  month: string;
  overallMinor: number | null;
  allocatedMinor: number;
  miscMinor: number | null;
  categories: { categoryId: number; allocatedMinor: number; maxAllocatableMinor: number | null }[];
};

export const getBudget = async () => (await (await get("/api/budget")).json()) as Budget;
