import { projectedMinor } from "../analytics/math";
import { budgetSpend, pendingBudgetSpend, spendByMonth } from "../analytics/spend";
import { readMonthSummary, type MonthSummary } from "../budget/summary";
import { daysInMonth, londonToday, mondayOf } from "../importer/dates";
import { readInsightInput } from "../insights/read";
import { buildInsights } from "../insights/rules";
import { PACE_FROM_DAY } from "../insights/thresholds";

// The weekly digest's content (docs/phase-2-insights-spec.md, Weekly digest): the preview route
// returns it, and the email renders it.

export type CategoryStatus = "ok" | "near" | "over" | "projected_over";

/** Home's flags (over; near from 90%), plus the pace projection from PACE_FROM_DAY. */
export function lineStatus(spentMinor: number, allocatedMinor: number, today: string): CategoryStatus {
  if (spentMinor > allocatedMinor) return "over";
  const dom = Number(today.slice(8, 10));
  if (allocatedMinor > 0 && dom >= PACE_FROM_DAY && projectedMinor(spentMinor, dom, daysInMonth(today.slice(0, 7))) > allocatedMinor) return "projected_over";
  return allocatedMinor > 0 && spentMinor * 10 >= allocatedMinor * 9 ? "near" : "ok";
}

/**
 * Each allocated budgeted category, then Misc as Home draws it: posted uncategorised spend plus
 * budgeted categories without an allocation (archived ones included). None without a budget.
 */
function digestLines(s: MonthSummary, today: string) {
  if (s.miscMinor === null) return [];
  const allocated = s.categories.filter((l) => l.kind === "budgeted" && l.allocatedMinor > 0);
  const miscSpent = s.categories.reduce(
    (sum, l) => (l.categoryId === null ? sum + l.spentMinor - l.pendingSpentMinor : l.kind === "budgeted" && l.allocatedMinor === 0 ? sum + l.spentMinor : sum),
    0,
  );
  const lines = allocated.map((l) => ({ categoryId: l.categoryId, spentMinor: l.spentMinor, allocatedMinor: l.allocatedMinor, status: lineStatus(l.spentMinor, l.allocatedMinor, today) }));
  // Like Home (src/web/lines.ts): Misc shows when something's left unallocated or spent there.
  if (s.miscMinor > 0 || miscSpent !== 0) lines.push({ categoryId: null, spentMinor: miscSpent, allocatedMinor: s.miscMinor, status: lineStatus(miscSpent, s.miscMinor, today) });
  return lines;
}

// A claim still 'sending' after this long belongs to a run that died before recording its result
// (a Worker cut off mid-send never updates the row), so it reads as failed and offers Send now.
const STUCK_SENDING_MS = 15 * 60_000;
const LAST_SEND_SQL = `SELECT week_start AS weekStart, CASE WHEN status = 'sending' AND attempted_at < ?1 THEN 'failed' ELSE status END AS status,
  sent_at AS sentAt FROM digest_sends ORDER BY week_start DESC LIMIT 1`;

/** This week's digest, Monday to today in London. */
export async function readDigest(db: D1Database, now: Date) {
  const today = londonToday(now);
  const weekStart = mondayOf(today);
  const [summary, week, insightInput, lastSend] = await Promise.all([
    readMonthSummary(db, today.slice(0, 7), now),
    spendByMonth(db, weekStart, today),
    readInsightInput(db, now),
    db.prepare(LAST_SEND_SQL).bind(new Date(now.getTime() - STUCK_SENDING_MS).toISOString()).first<{ weekStart: string; status: string; sentAt: string | null }>(),
  ]);
  return {
    weekStart,
    weekEnd: today,
    spansMonths: weekStart.slice(0, 7) !== today.slice(0, 7),
    weekSpentMinor: budgetSpend(week),
    weekPendingSpentMinor: pendingBudgetSpend(week),
    month: {
      month: summary.month,
      spentMinor: summary.spentMinor,
      pendingSpentMinor: summary.pendingSpentMinor,
      overallMinor: summary.overallMinor,
      leftMinor: summary.leftMinor,
      perWeekMinor: summary.perWeekMinor,
      daysRemaining: summary.daysRemaining,
    },
    categories: digestLines(summary, today),
    insights: buildInsights(insightInput),
    inboxCount: summary.inboxCount,
    staleAccountIds: summary.staleAccountIds,
    lastDataChangeAt: summary.lastDataChangeAt,
    lastSend: lastSend ?? null,
  };
}

export type Digest = Awaited<ReturnType<typeof readDigest>>;
