import { effectiveOverallSql } from "../budget/effective";
import { londonMonth, monthsEnding } from "../importer/dates";
import { floorDiv } from "./math";
import { budgetSpend, firstDataMonth, pendingBudgetSpend, spendByMonth, trackedSpend, type SpendRow } from "./spend";

// Trends (docs/phase-2-insights-spec.md): the current month and the 5 before, three statements.

export const TREND_MONTHS = 6;

// The overall budget in effect in each month of a JSON array of YYYY-MM strings.
const OVERALL_BY_MONTH_SQL = `SELECT m.value AS month, ${effectiveOverallSql("m.value")} AS overallMinor FROM json_each(?1) m`;

export async function readTrends(db: D1Database, now: Date) {
  const current = londonMonth(now);
  const months = monthsEnding(current, TREND_MONTHS);
  const [spend, overall, first] = await Promise.all([
    spendByMonth(db, `${months[0]}-01`, `${current}-31`),
    db.prepare(OVERALL_BY_MONTH_SQL).bind(JSON.stringify(months)).all<{ month: string; overallMinor: number | null }>(),
    firstDataMonth(db),
  ]);
  const overallOf = new Map(overall.results.map((r) => [r.month, r.overallMinor]));
  const hasData = (m: string) => first !== null && m >= first;
  const rowsOf = (m: string) => spend.filter((r) => r.month === m);
  // The average skips the partial month and months before the history starts.
  const averaged = months.filter((m) => m !== current && hasData(m));

  const kinds = new Map<number | null, SpendRow["kind"]>();
  for (const r of spend) kinds.set(r.categoryId, r.kind);

  return {
    months: months.map((m) => ({
      month: m,
      partial: m === current,
      hasData: hasData(m),
      spentMinor: budgetSpend(rowsOf(m)),
      pendingSpentMinor: pendingBudgetSpend(rowsOf(m)),
      overallMinor: overallOf.get(m) ?? null,
      trackedMinor: trackedSpend(rowsOf(m)),
    })),
    categories: [...kinds]
      .sort(([x], [y]) => (x ?? Infinity) - (y ?? Infinity))
      .map(([categoryId, kind]) => {
        const series = months.map((m) => spend.find((r) => r.month === m && r.categoryId === categoryId)?.spentMinor ?? 0);
        const total = averaged.reduce((sum, m) => sum + series[months.indexOf(m)]!, 0);
        return { categoryId, kind, series, averageMinor: averaged.length === 0 ? null : floorDiv(total, averaged.length) };
      }),
  };
}

export type Trends = Awaited<ReturnType<typeof readTrends>>;
