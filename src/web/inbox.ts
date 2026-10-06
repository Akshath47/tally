import { normalizePattern } from "../worker/budget/resolve";

// To sort files rows out of the inbox one tap at a time. Refetching the inbox after every tap
// would read the whole backlog again, so the screen removes what it filed from the loaded pages
// and merchant groups instead, and both refetch on the next visit (docs/research/d1-rows-read.md).

type Row = { id: number; merchant: string; amountMinor: number; countedAmountMinor: number | null };
type Page<T> = { transactions: T[]; total: number };
type Group = { pattern: string; count: number; totalMinor: number };

/** A row's merchant group: the pattern of the exact rule that would file it. */
export const patternOf = (t: { merchant: string }) => normalizePattern(t.merchant);

/** The rows a group's exact rule files: every inbox row with its pattern, pending ones too. */
export const inGroup =
  (pattern: string) =>
  (t: Row): boolean =>
    patternOf(t) === pattern;

/**
 * The loaded pages without the rows `drop` picks. `removed` is how many inbox rows were filed in
 * all, loaded or not, so every page's `total` stays the inbox's. Cursors stay valid: they're
 * keyed on rows the server still has.
 */
export function withoutRows<T extends Row, P extends Page<T>, D extends { pages: P[] }>(data: D, drop: (t: T) => boolean, removed: number): D {
  return {
    ...data,
    pages: data.pages.map((p) => ({ ...p, transactions: p.transactions.filter((t) => !drop(t)), total: Math.max(p.total - removed, 0) })),
  };
}

/** The groups without the one whose pattern was filed. */
export const withoutGroup = <G extends Group>(groups: G[], pattern: string): G[] => groups.filter((g) => g.pattern !== pattern);

/**
 * The groups once `row` alone is filed: its group loses one row and that row's counted amount,
 * and goes once empty. Its latest date and text may be stale until the next refetch.
 */
export function withoutRow<G extends Group>(groups: G[], row: Row): G[] {
  const pattern = patternOf(row);
  return groups.flatMap((g) =>
    g.pattern !== pattern ? [g] : g.count <= 1 ? [] : [{ ...g, count: g.count - 1, totalMinor: g.totalMinor - (row.countedAmountMinor ?? row.amountMinor) }],
  );
}
