// Display rules for budget progress, derived from the month summary's figures.

export type BarState = "ok" | "near" | "over";

/** Over once spend passes the allocation; near limit from 90% of it. */
export function barState(spentMinor: number, allocatedMinor: number): BarState {
  if (spentMinor > allocatedMinor) return "over";
  return allocatedMinor > 0 && spentMinor * 10 >= allocatedMinor * 9 ? "near" : "ok";
}

/** "2.3 weeks" from days remaining (today included), to one decimal; "5 days" under a week. */
export function remainingText(daysRemaining: number): string {
  if (daysRemaining < 7) return daysRemaining === 1 ? "today" : `${daysRemaining} days`;
  const tenths = Math.round((daysRemaining * 10) / 7);
  return `${Math.floor(tenths / 10)}.${tenths % 10} weeks`;
}

/** A part of a whole as a 0–1 fraction for drawing, clamped. */
export const fraction = (part: number, whole: number) => (whole <= 0 ? (part > 0 ? 1 : 0) : Math.min(1, Math.max(0, part / whole)));

/** "just now", "12 min ago", "3h ago", "4 days ago". */
export function ageText(iso: string, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
