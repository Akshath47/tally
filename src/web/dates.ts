// Dates stay YYYY-MM-DD and months YYYY-MM text. "Today" and month edges are London's, and a
// date string is never parsed into a Date, which is how UTC shift bugs happen.

import { monthName, yearSuffix } from "../worker/display";
import { addDays, addMonths, daysInMonth, isYmd, londonToday as londonTodayAt } from "../worker/importer/dates";

export { addDays, addMonths, daysInMonth, isYmd };
export { formatDayMonth, formatShortDate, monthName, yearSuffix } from "../worker/display";

/** Today's date in London, as YYYY-MM-DD. */
export const londonToday = (now: Date = new Date()) => londonTodayAt(now);

export const monthOf = (date: string) => date.slice(0, 7);

/** Days left in `today`'s month, counting today (docs/phase-2-spec.md, pacing). */
export const daysRemaining = (today: string) => daysInMonth(monthOf(today)) - Number(today.slice(8, 10)) + 1;

/** "October", or "October 2024" outside this year. */
export const monthTitle = (month: string, today?: string) => `${monthName(month)}${yearSuffix(month, today)}`;
