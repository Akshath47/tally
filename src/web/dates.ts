// Dates stay YYYY-MM-DD and months YYYY-MM text. "Today" and month edges are London's, and a
// date string is never parsed into a Date, which is how UTC shift bugs happen.

const londonParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Today's date in London, as YYYY-MM-DD. */
export function londonToday(now: Date = new Date()): string {
  const parts = Object.fromEntries(londonParts.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export const monthOf = (date: string) => date.slice(0, 7);

function splitMonth(month: string) {
  return { y: Number(month.slice(0, 4)), m: Number(month.slice(5, 7)) };
}

export function daysInMonth(month: string): number {
  const { y, m } = splitMonth(month);
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
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

/** "15 Oct". */
export const formatDayMonth = (date: string) => `${Number(date.slice(8, 10))} ${monthName(monthOf(date)).slice(0, 3)}`;

/** "Thu 15 Oct". */
export const formatShortDate = (date: string) => `${WEEKDAYS[weekday(date)]} ${formatDayMonth(date)}`;

/** `date` moved by `n` days. UTC on both sides, so no time zone can shift the result. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
