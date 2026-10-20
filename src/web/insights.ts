import type { Insight } from "../worker/insights/types";
import { addDays, formatShortDate, monthOf } from "./dates";
import { categoryHref, reviewHref } from "./routes";

// Insights (docs/phase-2-insights-spec.md): what each one says, and how the Insights tab shows it.
// The type and the wording are the Worker's (src/worker/insights), shared with the weekly email so
// the two never disagree.

export type { Insight } from "../worker/insights/types";
export { insightWords, type Names, type Words } from "../worker/insights/wording";
export { ordinal } from "../worker/display";

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
  switch (item.type) {
    case "stale_account":
      return { href: "/accounts" };
    case "pace":
      // The whole budget's pace opens Home, not To sort.
      return { href: item.categoryId === null ? "/" : categoryHref(month, item.categoryId) };
    case "unusual_category":
      return { href: categoryHref(month, item.categoryId) };
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
