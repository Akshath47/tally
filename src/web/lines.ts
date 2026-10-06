// Home's category lines (docs/ui-design.md, Home). Shared with the line screen and with the
// Worker's tests, which check that each line's transactions add up to it, so no React or
// browser imports here.

/** A Home line: a category id, Misc (the unallocated pot) or uncategorised pending charges. */
export type LineCategory = number | "misc" | "pending";

/** `allocatedMinor` is null for the Pending line, which isn't a pot of its own. */
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
  const misc: Pot = { category: "misc", name: "Misc", note: "unallocated", spentMinor: 0, pendingSpentMinor: 0, allocatedMinor: s.miscMinor ?? 0 };
  const pending: Line = { category: "pending", name: "Uncategorised pending", spentMinor: 0, pendingSpentMinor: 0, allocatedMinor: null };
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
