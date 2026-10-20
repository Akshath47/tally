import { floorDiv, projectedMinor } from "../analytics/math";
import { budgetSpend, type SpendRow } from "../analytics/spend";
import type { BudgetRows } from "../budget/effective";
import { isStale, staleDays, type AccountFreshness } from "../budget/stale";
import { daysInMonth } from "../importer/dates";
import * as T from "./thresholds";
import type { Insight } from "./types";

// Insights (docs/phase-2-insights-spec.md): fixed rules over figures read elsewhere (./read.ts).
// Pure, so every rule is tested at its edges without D1. Words live in ./wording.ts.

// The type lives in ./types.ts, with no imports, so the web app can share it with the wording.
export type { Insight } from "./types";

type Of<K extends Insight["type"]> = Extract<Insight, { type: K }>;

/** A candidate large charge and the merchant's earlier charges in the history window. */
export type Charge = {
  transactionId: number;
  merchantKey: string;
  name: string;
  spentMinor: number;
  countedDate: string;
  isPending: boolean;
  earlierCount: number;
  earlierSpentMinor: number;
};

/** One month's spend rows, and whether the month is within the ledger's history. */
export type MonthSpend = { month: string; hasData: boolean; rows: SpendRow[] };

export type InsightInput = {
  now: Date;
  /** London, YYYY-MM-DD. */
  today: string;
  /** The current month's. */
  budget: BudgetRows;
  /** The current month's. */
  monthSpend: SpendRow[];
  /** The previous UNUSUAL_BASELINE_MONTHS months, each from day 1 to today's day of month. */
  baseline: MonthSpend[];
  /** The last two completed months, whole (only read while month changes show). */
  lastMonth: MonthSpend;
  previousMonth: MonthSpend;
  charges: Charge[];
  accounts: AccountFreshness[];
};

const spentIn = (rows: SpendRow[], categoryId: number | null) => rows.find((r) => r.categoryId === categoryId)?.spentMinor ?? 0;
const keyOf = (categoryId: number | null) => categoryId ?? "uncategorised";
const dayOf = (today: string) => Number(today.slice(8, 10));

function staleItems({ accounts, now }: InsightInput): Of<"stale_account">[] {
  return accounts
    .flatMap((a) => {
      const days = staleDays(a.lastDataChangeAt, now);
      return days !== null && isStale(days) ? [{ id: `stale:${a.id}`, type: "stale_account" as const, severity: "warn" as const, accountId: a.id, staleDays: days }] : [];
    })
    .sort((x, y) => y.staleDays - x.staleDays);
}

function paceItems({ budget, monthSpend, today }: InsightInput): Of<"pace">[] {
  const month = today.slice(0, 7);
  const dom = dayOf(today);
  const dim = daysInMonth(month);
  const targets: [number | null, number, number][] = budget.allocations.map((a) => [a.categoryId, spentIn(monthSpend, a.categoryId), a.allocatedMinor]);
  if (budget.overallMinor !== null) targets.unshift([null, budgetSpend(monthSpend), budget.overallMinor]);
  return targets.flatMap(([categoryId, spentMinor, allocatedMinor]): Of<"pace">[] => {
    if (allocatedMinor <= 0) return [];
    const projected = projectedMinor(spentMinor, dom, dim);
    const base = { id: `pace:${categoryId === null ? "overall" : `category:${categoryId}`}:${month}`, type: "pace" as const, categoryId, spentMinor, allocatedMinor, projectedMinor: projected };
    if (spentMinor > allocatedMinor) return [{ ...base, severity: "over", state: "over" }];
    if (dom >= T.PACE_FROM_DAY && projected > allocatedMinor) return [{ ...base, severity: "warn", state: "projected_over" }];
    return [];
  });
}

function unusualItems({ monthSpend, baseline, today }: InsightInput, paced: Set<number>): Of<"unusual_category">[] {
  const months = baseline.filter((b) => b.hasData);
  if (dayOf(today) < T.UNUSUAL_FROM_DAY || months.length < T.UNUSUAL_MIN_BASELINE_MONTHS) return [];
  const [num, den] = T.UNUSUAL_RATIO;
  return monthSpend
    .flatMap((r): Of<"unusual_category">[] => {
      if (r.categoryId !== null && paced.has(r.categoryId)) return [];
      // Refunds can net a month below zero; the usual level is never taken as less than nothing.
      const baselineMinor = Math.max(0, floorDiv(months.reduce((sum, m) => sum + spentIn(m.rows, r.categoryId), 0), months.length));
      const fires = r.spentMinor * den >= baselineMinor * num && r.spentMinor - baselineMinor >= T.UNUSUAL_MIN_EXCESS_MINOR;
      return fires
        ? [{ id: `unusual:${keyOf(r.categoryId)}:${today.slice(0, 7)}`, type: "unusual_category", severity: "warn", categoryId: r.categoryId, spentMinor: r.spentMinor, baselineMinor }]
        : [];
    })
    .sort((x, y) => y.spentMinor - y.baselineMinor - (x.spentMinor - x.baselineMinor));
}

function largeChargeItems({ charges }: InsightInput): Of<"large_charge">[] {
  return charges
    .flatMap((ch): Of<"large_charge">[] => {
      const isNew = ch.earlierCount === 0;
      // spent ≥ 3 × (earlier ÷ count), cross-multiplied.
      const outOfLine = ch.earlierCount >= T.LARGE_CHARGE_MIN_HISTORY && ch.spentMinor * ch.earlierCount >= T.LARGE_CHARGE_RATIO * ch.earlierSpentMinor;
      if (ch.spentMinor < T.LARGE_CHARGE_MIN_MINOR || !(isNew || outOfLine)) return [];
      return [{
        id: `large:${ch.transactionId}`, type: "large_charge", severity: "info", transactionId: ch.transactionId, merchantKey: ch.merchantKey, name: ch.name,
        spentMinor: ch.spentMinor, merchantAverageMinor: isNew ? null : floorDiv(ch.earlierSpentMinor, ch.earlierCount), countedDate: ch.countedDate, isPending: ch.isPending,
      }];
    })
    .sort((x, y) => y.spentMinor - x.spentMinor);
}

function monthChangeItems({ lastMonth, previousMonth, today }: InsightInput): Of<"month_change">[] {
  if (dayOf(today) > T.MONTH_CHANGE_SHOW_DAYS || !lastMonth.hasData || !previousMonth.hasData) return [];
  const ids = new Set([...lastMonth.rows, ...previousMonth.rows].map((r) => r.categoryId));
  return [...ids]
    .flatMap((categoryId): Of<"month_change">[] => {
      const spentMinor = spentIn(lastMonth.rows, categoryId);
      const previousSpentMinor = spentIn(previousMonth.rows, categoryId);
      const changeMinor = spentMinor - previousSpentMinor;
      const big = Math.abs(changeMinor) >= T.MONTH_CHANGE_MIN_MINOR && Math.abs(changeMinor) * 100 >= T.MONTH_CHANGE_MIN_PCT * Math.abs(previousSpentMinor);
      return big
        ? [{ id: `month_change:${keyOf(categoryId)}:${lastMonth.month}`, type: "month_change", severity: "info", categoryId, month: lastMonth.month, spentMinor, previousSpentMinor, changeMinor }]
        : [];
    })
    .sort((x, y) => Math.abs(y.changeMinor) - Math.abs(x.changeMinor))
    .slice(0, T.MONTH_CHANGE_MAX);
}

/** Today's insights, ranked (docs/phase-2-insights-spec.md, Ranking). */
export function buildInsights(input: InsightInput): Insight[] {
  const pace = paceItems(input);
  const paced = new Set(pace.flatMap((p) => (p.categoryId === null ? [] : [p.categoryId])));
  return [
    ...staleItems(input),
    ...pace.filter((p) => p.state === "over").sort((x, y) => y.spentMinor - y.allocatedMinor - (x.spentMinor - x.allocatedMinor)),
    ...pace.filter((p) => p.state === "projected_over").sort((x, y) => y.projectedMinor - y.allocatedMinor - (x.projectedMinor - x.allocatedMinor)),
    ...unusualItems(input, paced),
    ...largeChargeItems(input),
    ...monthChangeItems(input),
  ];
}
