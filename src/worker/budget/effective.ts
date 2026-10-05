// A month's budget figures come from the row with the greatest effective_month ≤ that month
// (docs/phase-2-spec.md, Data model). Writes only ever go to the current month, so past months
// keep their rows. Kinds aren't dated, though: which categories count is decided by their
// current kind and archive state, for past months too.

// The arguments are SQL placeholders or column names (`?1`, `c.id`), never values.

/** Scalar subquery: the overall figure in effect in `month`, or NULL before the first one. */
export const effectiveOverallSql = (month: string) =>
  `(SELECT amount_minor FROM monthly_budgets WHERE effective_month <= ${month} ORDER BY effective_month DESC LIMIT 1)`;

/** Scalar subquery: a category's allocation in effect in `month`, or NULL if it never had one. A primary-key seek. */
export const effectiveAllocationSql = (categoryId: string, month: string) =>
  `(SELECT amount_minor FROM category_budgets WHERE category_id = ${categoryId} AND effective_month <= ${month}
    ORDER BY effective_month DESC LIMIT 1)`;

export type BudgetRows = { overallMinor: number | null; allocations: { categoryId: number; allocatedMinor: number }[] };

/** The month's `allocated`: the sum of the listed categories' allocations. */
export const sumAllocated = ({ allocations }: BudgetRows) => allocations.reduce((sum, a) => sum + a.allocatedMinor, 0);

/**
 * The overall figure and every budgeted, unarchived category's allocation (0 if none) in
 * `month`, ordered by category id. Kinds aren't dated, so the current kind decides. One statement.
 */
export async function readBudget(db: D1Database, month: string): Promise<BudgetRows> {
  // The one-row base keeps the overall figure when no category is budgeted.
  const { results } = await db
    .prepare(
      `SELECT o.overall, c.id AS category_id, COALESCE(${effectiveAllocationSql("c.id", "?1")}, 0) AS allocated
       FROM (SELECT ${effectiveOverallSql("?1")} AS overall) o
       LEFT JOIN categories c ON c.kind = 'budgeted' AND c.archived_at IS NULL
       ORDER BY c.id`,
    )
    .bind(month)
    .all<{ overall: number | null; category_id: number | null; allocated: number }>();
  return {
    overallMinor: results[0]!.overall,
    allocations: results.flatMap((r) => (r.category_id === null ? [] : [{ categoryId: r.category_id, allocatedMinor: r.allocated }])),
  };
}
