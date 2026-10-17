import { readBudget } from "../budget/effective";
import { COUNTS, IN_MONTH, RESOLVED_CTE, inMonthBinds } from "../budget/resolve";
import { addMonths } from "../importer/dates";
import { budgetSpend, spendByMonth, trackedSpend, type SpendRow } from "./spend";

// The Monthly review (docs/phase-2-insights-spec.md): a completed month against the one before.

const TOP_MERCHANTS = 5;

// Budget and tracked spend by merchant key in one month. A bare column beside max() takes its
// value from the row holding the max, so `name` is the text of the key's latest transaction.
const TOP_MERCHANTS_SQL = `WITH ${RESOLVED_CTE}
SELECT lower(trim(r.merchant)) AS merchantKey, r.merchant AS name, max(r.txn_date) AS latest,
  sum(-COALESCE(r.counted_amount_minor, r.amount_minor)) AS spentMinor,
  sum(COALESCE(r.counted_amount_minor, r.amount_minor) < 0) AS visits
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE r.vanished_at IS NULL AND ${IN_MONTH} AND ${COUNTS}
GROUP BY merchantKey
HAVING spentMinor > 0
ORDER BY spentMinor DESC, merchantKey
LIMIT ${TOP_MERCHANTS}`;

type Totals = { spentMinor: number; overallMinor: number | null; trackedMinor: number };
export type ReviewCategory = {
  categoryId: number | null;
  kind: SpendRow["kind"];
  spentMinor: number;
  previousSpentMinor: number;
  changeMinor: number;
  allocatedMinor: number | null;
  over: boolean;
};

const totals = (rows: SpendRow[], overallMinor: number | null): Totals => ({ spentMinor: budgetSpend(rows), overallMinor, trackedMinor: trackedSpend(rows) });

/** `month` must be a completed month. Five statements. */
export async function readReview(db: D1Database, month: string) {
  const previousMonth = addMonths(month, -1);
  const [spend, budget, previousBudget, merchants] = await Promise.all([
    spendByMonth(db, `${previousMonth}-01`, `${month}-31`),
    readBudget(db, month),
    readBudget(db, previousMonth),
    db.prepare(TOP_MERCHANTS_SQL).bind(...inMonthBinds(month)).all<{ merchantKey: string; name: string; spentMinor: number; visits: number }>(),
  ]);
  const thisRows = spend.filter((r) => r.month === month);
  const previousRows = spend.filter((r) => r.month === previousMonth);

  // readBudget lists unarchived budgeted categories, so an archived one has no allocation here.
  const allocations = new Map<number | null, number>(budget.allocations.filter((a) => a.allocatedMinor > 0).map((a) => [a.categoryId, a.allocatedMinor]));
  const lines = new Map<number | null, ReviewCategory>();
  const line = (categoryId: number | null, kind: SpendRow["kind"]) => {
    let l = lines.get(categoryId);
    if (!l) {
      l = { categoryId, kind, spentMinor: 0, previousSpentMinor: 0, changeMinor: 0, allocatedMinor: allocations.get(categoryId) ?? null, over: false };
      lines.set(categoryId, l);
    }
    return l;
  };
  for (const r of thisRows) line(r.categoryId, r.kind).spentMinor = r.spentMinor;
  for (const r of previousRows) line(r.categoryId, r.kind).previousSpentMinor = r.spentMinor;
  for (const id of allocations.keys()) line(id, "budgeted");

  return {
    month,
    previousMonth,
    totals: totals(thisRows, budget.overallMinor),
    previousTotals: totals(previousRows, previousBudget.overallMinor),
    categories: [...lines.values()]
      .map((l) => ({ ...l, changeMinor: l.spentMinor - l.previousSpentMinor, over: l.allocatedMinor !== null && l.spentMinor > l.allocatedMinor }))
      .sort((x, y) => (x.categoryId ?? Infinity) - (y.categoryId ?? Infinity)),
    topMerchants: merchants.results.map(({ merchantKey, name, spentMinor, visits }) => ({ merchantKey, name, spentMinor, visits })),
    hasPrevious: previousRows.length > 0,
  };
}

export type Review = Awaited<ReturnType<typeof readReview>>;
