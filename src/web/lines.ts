// Home's category lines (docs/ui-design.md, Home). Shared with the line screen and with the
// Worker's tests, which check that each line's transactions add up to it, so no React or
// browser imports here.

import type { NamedLine } from "../worker/budget/lines";

/**
 * A Home line: a category id, Misc (the unallocated pot), uncategorised pending charges, or the
 * Posted and Pending pills, which split the month's budget spend.
 */
export type LineCategory = number | NamedLine;

export const LINE_NAMES: Record<NamedLine, string> = { misc: "Misc", "uncategorised-pending": "Uncategorised pending", posted: "Posted", pending: "Pending" };

/**
 * Pending figures are lower bounds: Lunch Flow doesn't send every pending charge. A plain amount
 * with any pending in it says so; a pot's bar hatches its pending part instead.
 */
export const isLowerBound = (l: Pick<Line, "pendingSpentMinor" | "allocatedMinor">) => l.allocatedMinor === null && l.pendingSpentMinor > 0;

/** `allocatedMinor` is null for a line that isn't a pot of its own. */
export type Line = { category: LineCategory; name: string; note?: string; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number | null };
type Pot = Line & { allocatedMinor: number };

type SummaryLine = { categoryId: number | null; kind: string | null; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number };

/**
 * Budgeted categories with an allocation, biggest first, then Misc: the unallocated pot, which
 * takes posted uncategorised spend and budgeted categories without an allocation. Then
 * Uncategorised pending: pending charges no rule categorises yet, which can't be filed until they post, so they'd otherwise
 * swell Misc. Tracked spend isn't budget spend, so it's on no line.
 */
export function budgetLines(s: { miscMinor: number | null; categories: SummaryLine[] }, byId: Map<number, { name: string }>): Line[] {
  const lines: Pot[] = [];
  const misc: Pot = { category: "misc", name: LINE_NAMES.misc, note: "unallocated", spentMinor: 0, pendingSpentMinor: 0, allocatedMinor: s.miscMinor ?? 0 };
  const pending: Line = { category: "uncategorised-pending", name: LINE_NAMES["uncategorised-pending"], spentMinor: 0, pendingSpentMinor: 0, allocatedMinor: null };
  for (const c of s.categories) {
    if (c.kind === "tracked") continue;
    if (c.categoryId !== null && c.allocatedMinor > 0) {
      const { spentMinor, pendingSpentMinor, allocatedMinor } = c;
      lines.push({ category: c.categoryId, name: byId.get(c.categoryId)?.name ?? "Category", spentMinor, pendingSpentMinor, allocatedMinor });
    } else if (c.categoryId === null) {
      // The summary's Uncategorised line: only its pending part is pending.
      misc.spentMinor += c.spentMinor - c.pendingSpentMinor;
      pending.spentMinor += c.pendingSpentMinor;
      pending.pendingSpentMinor += c.pendingSpentMinor;
    } else {
      misc.spentMinor += c.spentMinor;
      misc.pendingSpentMinor += c.pendingSpentMinor;
    }
  }
  lines.sort((a, b) => b.allocatedMinor - a.allocatedMinor);
  if (misc.allocatedMinor > 0 || misc.spentMinor !== 0) lines.push(misc);
  return pending.spentMinor !== 0 ? [...lines, pending] : lines;
}

/** Any line Home links to, figures included: a category or Misc row, or a pill. */
export function findLine(
  s: { spentMinor: number; pendingSpentMinor: number; overallMinor: number | null } & Parameters<typeof budgetLines>[0],
  byId: Map<number, { name: string }>,
  category: LineCategory,
): Line | undefined {
  if (category === "posted") return { category, name: LINE_NAMES.posted, spentMinor: s.spentMinor - s.pendingSpentMinor, pendingSpentMinor: 0, allocatedMinor: null };
  if (category === "pending") return { category, name: LINE_NAMES.pending, spentMinor: s.pendingSpentMinor, pendingSpentMinor: s.pendingSpentMinor, allocatedMinor: null };
  // The same lines Home shows for the month: spending only before a budget, the pots after.
  // Tracked categories show their plain spend either way.
  const isIt = (l: SpendLine): l is SpendLine & { category: number } => l.category === category;
  if (s.overallMinor !== null) return budgetLines(s, byId).find((l) => l.category === category) ?? spendingLines(s.categories, byId).tracked.find(isIt);
  const { lines, tracked } = spendingLines(s.categories, byId);
  return [...lines, ...tracked].find(isIt);
}

/** A past month's line before any budget: a category, or Uncategorised (`null`); no pots. */
export type SpendLine = Omit<Line, "category"> & { category: number | null; allocatedMinor: null };

const spendLine = (c: SummaryLine, byId: Map<number, { name: string }>): SpendLine => ({
  category: c.categoryId,
  name: c.categoryId === null ? "Uncategorised" : (byId.get(c.categoryId)?.name ?? "Category"),
  spentMinor: c.spentMinor,
  pendingSpentMinor: c.pendingSpentMinor,
  allocatedMinor: null,
});

/**
 * A month with no budget to measure against: what each category spent, biggest first, with
 * Uncategorised last. Tracked categories come back apart, since they're not in the month's spend.
 * Categories that spent nothing (an allocation only, or refunds that net to zero) are left out.
 */
export function spendingLines(categories: SummaryLine[], byId: Map<number, { name: string }>): { lines: SpendLine[]; tracked: SpendLine[] } {
  const lines: SpendLine[] = [];
  const tracked: SpendLine[] = [];
  let uncategorised: SpendLine | undefined;
  for (const c of [...categories].sort((a, b) => b.spentMinor - a.spentMinor)) {
    if (c.spentMinor === 0) continue;
    if (c.categoryId === null) uncategorised = spendLine(c, byId);
    else (c.kind === "tracked" ? tracked : lines).push(spendLine(c, byId));
  }
  return { lines: uncategorised ? [...lines, uncategorised] : lines, tracked };
}
