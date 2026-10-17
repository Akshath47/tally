import { addDays, addMonths, formatShortDate, monthName, monthOf } from "./dates";
import { formatMoney } from "./format";
import { formatPounds } from "./money";
import { lineHref, reviewHref } from "./routes";

// Insights (docs/phase-2-insights-spec.md): what each one says, and how the Insights tab shows it.
//
// STAND-IN until P2.10 merges. `Insight` and `insightWords` belong to the Worker
// (src/worker/insights/rules.ts and wording.ts), shared with the weekly email so the two never
// disagree. They're copied here from docs/insights-plan.md (P2.10 Tasks 2 and 4) so the UI can be
// built first. Once P2.10 lands, replace both with re-exports of the Worker's and delete the copies.

export type Insight =
  | { id: string; type: "stale_account"; severity: "warn"; accountId: number; staleDays: number }
  | {
      id: string;
      type: "pace";
      severity: "over" | "warn";
      state: "over" | "projected_over";
      /** null = the whole budget. */
      categoryId: number | null;
      spentMinor: number;
      allocatedMinor: number;
      projectedMinor: number;
    }
  | { id: string; type: "unusual_category"; severity: "warn"; categoryId: number | null; spentMinor: number; baselineMinor: number }
  | {
      id: string;
      type: "large_charge";
      severity: "info";
      transactionId: number;
      merchantKey: string;
      name: string;
      spentMinor: number;
      /** null = a new merchant. */
      merchantAverageMinor: number | null;
      countedDate: string;
      isPending: boolean;
    }
  | { id: string; type: "month_change"; severity: "info"; categoryId: number | null; month: string; spentMinor: number; previousSpentMinor: number; changeMinor: number };

export type Names = { category: (id: number | null) => string; account: (id: number) => string };
export type Words = { headline: string; detail: string };

/** "1st", "2nd", "16th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

const gbp = (minor: number) => formatMoney(minor, "GBP");
const floorDiv = (a: number, b: number) => Math.floor(a / b);

export function insightWords(item: Insight, names: Names, today: string): Words {
  const byToday = `by the ${ordinal(Number(today.slice(8, 10)))}`;
  switch (item.type) {
    case "stale_account":
      return { headline: `${names.account(item.accountId)} hasn't updated for ${item.staleDays} days`, detail: "Recent spending may be missing." };
    case "pace": {
      const spent = formatPounds(item.spentMinor);
      const limit = formatPounds(item.allocatedMinor);
      if (item.state === "over") {
        const over = formatPounds(item.spentMinor - item.allocatedMinor);
        return item.categoryId === null
          ? { headline: `${over} over this month's budget`, detail: `${spent} of ${limit}` }
          : { headline: `${names.category(item.categoryId)} is ${over} over`, detail: `${spent} of ${limit} this month` };
      }
      const over = formatPounds(item.projectedMinor - item.allocatedMinor);
      return item.categoryId === null
        ? { headline: `On course to end the month ${over} over`, detail: `${spent} ${byToday}, ${limit} budget` }
        : { headline: `${names.category(item.categoryId)} is on course to end ${over} over`, detail: `${spent} ${byToday}, ${limit} allocated` };
    }
    case "unusual_category":
      return {
        headline: `${names.category(item.categoryId)} is running high`,
        detail: `${formatPounds(item.spentMinor)} so far, usually about ${formatPounds(item.baselineMinor)} ${byToday}`,
      };
    case "large_charge": {
      const pending = item.isPending ? "Pending · " : "";
      const headline = `${gbp(item.spentMinor)} at ${item.name}`;
      if (item.merchantAverageMinor === null) return { headline, detail: `${pending}New merchant · ${formatShortDate(item.countedDate, today)}` };
      // Rounded to the nearest whole multiple: floor((2 × spent + average) ÷ (2 × average)).
      const times = floorDiv(2 * item.spentMinor + item.merchantAverageMinor, 2 * item.merchantAverageMinor);
      return { headline, detail: `${pending}About ${times}× your usual ${gbp(item.merchantAverageMinor)} there` };
    }
    case "month_change":
      return {
        headline: `${names.category(item.categoryId)} ${item.changeMinor > 0 ? "up" : "down"} ${formatPounds(Math.abs(item.changeMinor))} in ${monthName(item.month)}`,
        detail: `${formatPounds(item.spentMinor)}, from ${formatPounds(item.previousSpentMinor)} in ${monthName(addMonths(item.month, -1))}`,
      };
  }
}

// --- How the Insights tab shows them (docs/insights-ui-brief.md) -------------------------------

export type Tone = "over" | "warn" | "neutral";

/** Brick for over, amber for warnings, neutral for information. */
export const toneOf = (item: Insight): Tone => (item.severity === "over" ? "over" : item.severity === "warn" ? "warn" : "neutral");

/** Which icon an insight shows: the brief's types, with month changes split by direction. */
export type InsightIcon = "over" | "projected" | "high" | "stale" | "charge" | "up" | "down";

export function iconOf(item: Insight): InsightIcon {
  switch (item.type) {
    case "stale_account":
      return "stale";
    case "pace":
      return item.state === "over" ? "over" : "projected";
    case "unusual_category":
      return "high";
    case "large_charge":
      return "charge";
    case "month_change":
      return item.changeMinor > 0 ? "up" : "down";
  }
}

/** Where tapping an insight goes: a screen, or the charge's own transaction sheet. */
export type InsightTarget = { href: string } | { transactionId: number; merchantKey: string };

/**
 * The brief's tap targets. `today` is the London date: pace and running-high insights are about
 * the current month. Uncategorised spend has no category line, so it opens To sort.
 */
export function targetOf(item: Insight, today: string): InsightTarget {
  const month = monthOf(today);
  const category = (id: number | null) => (id === null ? "/to-sort" : lineHref(month, id));
  switch (item.type) {
    case "stale_account":
      return { href: "/accounts" };
    case "pace":
      return { href: item.categoryId === null ? "/" : category(item.categoryId) };
    case "unusual_category":
      return { href: category(item.categoryId) };
    case "large_charge":
      return { transactionId: item.transactionId, merchantKey: item.merchantKey };
    case "month_change":
      return { href: reviewHref(item.month) };
  }
}

/** The insights only shown in a month's first week, so the list can say they're month changes. */
export const isMonthChangeOnly = (items: Insight[]) => items.length > 0 && items.every((i) => i.type === "month_change");

/** "Mon 12 – Sun 18 Oct" for the Monday-to-Sunday week, naming the first month only when it spans two. */
export function weekRange(weekStart: string, today: string): string {
  const sunday = addDays(weekStart, 6);
  const start = formatShortDate(weekStart, today);
  const end = formatShortDate(sunday, today);
  return monthOf(weekStart) === monthOf(sunday) ? `${start.replace(/ \w{3}( \d{4})?$/, "")} – ${end}` : `${start} – ${end}`;
}

const londonClock = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** An ISO timestamp as London's "Sun 11 Oct, 18:00". */
export function londonDayTime(iso: string, today: string): string {
  const p = Object.fromEntries(londonClock.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${formatShortDate(`${p.year}-${p.month}-${p.day}`, today)}, ${p.hour}:${p.minute}`;
}

/** The days of the week before `today`'s month began: "Includes 3 days of September". */
export function daysOfPreviousMonth(weekStart: string, today: string): number {
  let n = 0;
  for (let d = weekStart; d <= today && monthOf(d) !== monthOf(today); d = addDays(d, 1)) n += 1;
  return n;
}
