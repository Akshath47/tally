// Home's category lines (docs/ui-design.md, Home). Shared with the line screen and with the
// Worker's tests, which check that each line's transactions add up to it, so no React or
// browser imports here.

/**
 * A Home line: a category id, Misc (the unallocated pot), uncategorised pending charges, or the
 * Posted and Pending pills, which split the month's budget spend.
 */
export type LineCategory = number | "misc" | "uncategorised-pending" | "posted" | "pending";
type NamedLine = Exclude<LineCategory, number>;

export const LINE_NAMES: Record<NamedLine, string> = { misc: "Misc", "uncategorised-pending": "Uncategorised pending", posted: "Posted", pending: "Pending" };

/** Pending figures are lower bounds: Lunch Flow doesn't send every pending charge. */
export const isLowerBound = (category: LineCategory) => category === "pending" || category === "uncategorised-pending";

/** `allocatedMinor` is null for a line that isn't a pot of its own. */
export type Line = { category: LineCategory; name: string; note?: string; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number | null };
type Pot = Line & { allocatedMinor: number };

type SummaryLine = { categoryId: number | null; kind: string | null; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number };

/**
 * Budgeted categories with an allocation, biggest first, then Misc: the unallocated pot, which
 * takes posted uncategorised spend and budgeted categories without an allocation. Then Pending:
 * uncategorised pending charges, which can't be filed until they post, so they'd otherwise
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
export function findLine(s: { spentMinor: number; pendingSpentMinor: number } & Parameters<typeof budgetLines>[0], byId: Map<number, { name: string }>, category: LineCategory): Line | undefined {
  if (category === "posted") return { category, name: LINE_NAMES.posted, spentMinor: s.spentMinor - s.pendingSpentMinor, pendingSpentMinor: 0, allocatedMinor: null };
  if (category === "pending") return { category, name: LINE_NAMES.pending, spentMinor: s.pendingSpentMinor, pendingSpentMinor: s.pendingSpentMinor, allocatedMinor: null };
  return budgetLines(s, byId).find((l) => l.category === category);
}
