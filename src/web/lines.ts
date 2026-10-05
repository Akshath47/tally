// Home's category lines (docs/ui-design.md, Home). Shared with the line screen and with the
// Worker's tests, which check that each line's transactions add up to it, so no React or
// browser imports here.

/** A Home line: a category id, or Misc (the unallocated pot). */
export type LineCategory = number | "misc";

export type Line = { category: LineCategory; name: string; note?: string; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number };

type SummaryLine = { categoryId: number | null; kind: string | null; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number };

/**
 * Budgeted categories with an allocation, biggest first, then Misc: the unallocated pot, which
 * takes uncategorised spend and budgeted categories without an allocation. Tracked spend isn't
 * budget spend, so it's on no line.
 */
export function budgetLines(s: { miscMinor: number | null; categories: SummaryLine[] }, byId: Map<number, { name: string }>): Line[] {
  const lines: Line[] = [];
  const misc: Line = { category: "misc", name: "Misc", note: "unallocated", spentMinor: 0, pendingSpentMinor: 0, allocatedMinor: s.miscMinor ?? 0 };
  for (const c of s.categories) {
    if (c.kind === "tracked") continue;
    if (c.categoryId !== null && c.allocatedMinor > 0) {
      const { spentMinor, pendingSpentMinor, allocatedMinor } = c;
      lines.push({ category: c.categoryId, name: byId.get(c.categoryId)?.name ?? "Category", spentMinor, pendingSpentMinor, allocatedMinor });
    } else {
      misc.spentMinor += c.spentMinor;
      misc.pendingSpentMinor += c.pendingSpentMinor;
    }
  }
  lines.sort((a, b) => b.allocatedMinor - a.allocatedMinor);
  if (misc.allocatedMinor > 0 || misc.spentMinor !== 0) lines.push(misc);
  return lines;
}
