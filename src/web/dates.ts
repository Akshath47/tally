// Dates stay YYYY-MM-DD and months YYYY-MM text. "Today" and month edges are London's, and a
// date string is never parsed into a Date, which is how UTC shift bugs happen.

import { addDays, daysInMonth, isYmd, londonToday as londonTodayAt } from "../worker/importer/dates";

export { addDays, daysInMonth, isYmd };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Today's date in London, as YYYY-MM-DD. */
export const londonToday = (now: Date = new Date()) => londonTodayAt(now);

export const monthOf = (date: string) => date.slice(0, 7);

function splitMonth(month: string) {
  return { y: Number(month.slice(0, 4)), m: Number(month.slice(5, 7)) };
}

/** Days left in `today`'s month, counting today (docs/phase-2-spec.md, pacing). */
export const daysRemaining = (today: string) => daysInMonth(monthOf(today)) - Number(today.slice(8, 10)) + 1;

export function addMonths(month: string, n: number): string {
  const { y, m } = splitMonth(month);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** "October". */
export const monthName = (month: string) => MONTHS[splitMonth(month).m - 1]!;

/** Sakamoto's day-of-week, 0 = Sunday, straight from the date's digits. */
function weekday(date: string): number {
  const d = Number(date.slice(8, 10));
  const m = Number(date.slice(5, 7));
  let y = Number(date.slice(0, 4));
  if (m < 3) y -= 1;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4][m - 1]! + d) % 7;
}

/**
 * " 2024" for a date or month outside `today`'s year, "" within it: history goes back about two
 * years, so a bare "15 Oct" or "October" is ambiguous. `today` may be a date or a month.
 */
export function yearSuffix(dateOrMonth: string, today: string = londonToday()): string {
  const year = dateOrMonth.slice(0, 4);
  return today.startsWith(year) ? "" : ` ${year}`;
}

/** "October", or "October 2024" outside this year. */
export const monthTitle = (month: string, today?: string) => `${monthName(month)}${yearSuffix(month, today)}`;

/** "15 Oct", or "15 Oct 2024" outside this year. */
export const formatDayMonth = (date: string, today?: string) =>
  `${Number(date.slice(8, 10))} ${monthName(monthOf(date)).slice(0, 3)}${yearSuffix(date, today)}`;

/** "Thu 15 Oct", or "Tue 15 Oct 2024" outside this year. */
export const formatShortDate = (date: string, today?: string) => `${WEEKDAYS[weekday(date)]} ${formatDayMonth(date, today)}`;
