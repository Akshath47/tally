// Display formatting shared by the web app and the weekly digest (docs/phase-2-insights-spec.md). Pure, Intl-only, no DOM: Worker code can import it, and src/web re-exports it.

import { londonToday } from "./importer/dates";

// Built once and reused: constructing Intl formatters is the expensive part.
const timestampFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" });
const moneyFormats = new Map<string, { fmt: Intl.NumberFormat; exponent: number }>();

function moneyFormat(currency: string) {
  let entry = moneyFormats.get(currency);
  if (!entry) {
    const fmt = new Intl.NumberFormat("en-GB", { style: "currency", currency });
    entry = { fmt, exponent: fmt.resolvedOptions().maximumFractionDigits ?? 2 };
    moneyFormats.set(currency, entry);
  }
  return entry;
}

/**
 * Formats integer minor units without dividing as a float: the decimal string is built
 * from the integer's digits and handed to Intl, which formats decimal strings exactly.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const { fmt, exponent } = moneyFormat(currency);
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, "0");
  const decimal = exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  return fmt.format(`${amountMinor < 0 ? "-" : ""}${decimal}` as `${number}`);
}

/** ISO-8601 UTC timestamp → London wall-clock time. Never used for txn_date. */
export function formatTimestamp(iso: string | null): string {
  return iso ? timestampFormat.format(new Date(iso)) : "never";
}

export const MINUS = "−";

const poundsFormat = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0, minimumFractionDigits: 0 });

/** Budget figures in whole pounds, rounded half away from zero: 100_340 → "£1,003", −1_250 → "−£13". */
export function formatPounds(minor: number): string {
  const abs = Math.abs(minor);
  const pounds = (abs - (abs % 100)) / 100 + (abs % 100 >= 50 ? 1 : 0);
  return `${minor < 0 && pounds > 0 ? MINUS : ""}${poundsFormat.format(pounds)}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const monthOf = (date: string) => date.slice(0, 7);

function splitMonth(month: string) {
  return { y: Number(month.slice(0, 4)), m: Number(month.slice(5, 7)) };
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
export function yearSuffix(dateOrMonth: string, today: string = londonToday(new Date())): string {
  const year = dateOrMonth.slice(0, 4);
  return today.startsWith(year) ? "" : ` ${year}`;
}

/** "15 Oct", or "15 Oct 2024" outside this year. */
export const formatDayMonth = (date: string, today?: string) =>
  `${Number(date.slice(8, 10))} ${monthName(monthOf(date)).slice(0, 3)}${yearSuffix(date, today)}`;

/** "Thu 15 Oct", or "Tue 15 Oct 2024" outside this year. */
export const formatShortDate = (date: string, today?: string) => `${WEEKDAYS[weekday(date)]} ${formatDayMonth(date, today)}`;

/** 1 → "1st", 12 → "12th", 22 → "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th");
  return `${n}${suffix}`;
}
