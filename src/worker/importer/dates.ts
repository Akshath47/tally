// Calendar dates are plain YYYY-MM-DD strings. Provider dates are never parsed into a Date;
// Date.UTC is used only for pure day arithmetic on window bounds, so no timezone shift can occur.

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

const londonDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar date in Europe/London (en-CA formats as YYYY-MM-DD). */
export function londonToday(now: Date): string {
  return londonDate.format(now);
}

/** The current calendar month in Europe/London, as YYYY-MM. */
export function londonMonth(now: Date): string {
  return londonToday(now).slice(0, 7);
}

function parts(ymd: string): [number, number, number] | null {
  const m = YMD.exec(ymd);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True only for a real calendar date in YYYY-MM-DD form. */
export function isYmd(value: string): boolean {
  const p = parts(value);
  if (!p) return false;
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}

export function addDays(ymd: string, days: number): string {
  const p = parts(ymd);
  if (!p || !isYmd(ymd)) throw new Error("addDays: not a YYYY-MM-DD date");
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
}

const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** True only for a real month in YYYY-MM form. */
export const isYm = (value: string) => YM.test(value);

/** How many days a YYYY-MM month has. */
export function daysInMonth(month: string): number {
  const m = YM.exec(month);
  if (!m) throw new Error("daysInMonth: not a YYYY-MM month");
  // Day 0 of the next month is this month's last day.
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
}
