import { daysBetween, londonToday } from "../importer/dates";

// Stale data (docs/phase-2-insights-spec.md): an enabled account whose data hasn't changed for
// STALE_AFTER_DAYS London days or more. An account that's only quiet looks stale too; accepted,
// since "hasn't updated" is still true.

export const STALE_AFTER_DAYS = 4;

export type AccountFreshness = { id: number; lastDataChangeAt: string | null };

/** The enabled accounts' last data change: the one statement stale checks need. */
export const ENABLED_FRESHNESS_SQL =
  "SELECT id, last_data_change_at AS lastDataChangeAt FROM accounts WHERE import_enabled = 1 ORDER BY id";

/** Whole London days since `lastDataChangeAt` (an ISO timestamp), or null when it's never been set. */
export function staleDays(lastDataChangeAt: string | null, now: Date): number | null {
  return lastDataChangeAt === null ? null : daysBetween(londonToday(new Date(lastDataChangeAt)), londonToday(now));
}

export const isStale = (days: number | null) => days !== null && days >= STALE_AFTER_DAYS;

/** `account` with its stale flags. Only enabled accounts can be stale: a disabled one isn't expected to change. */
export function withStale<T extends { importEnabled: boolean; lastDataChangeAt: string | null }>(account: T, now: Date) {
  const days = account.importEnabled ? staleDays(account.lastDataChangeAt, now) : null;
  return { ...account, stale: isStale(days), staleDays: days };
}

/** Ids of the stale accounts among `rows`. */
export const staleIds = (rows: AccountFreshness[], now: Date) => rows.filter((r) => isStale(staleDays(r.lastDataChangeAt, now))).map((r) => r.id);

/** The latest last data change among `rows` (ISO timestamps sort as text), or null. */
export const latestChange = (rows: AccountFreshness[]) =>
  rows.reduce<string | null>((max, r) => (r.lastDataChangeAt !== null && (max === null || r.lastDataChangeAt > max) ? r.lastDataChangeAt : max), null);
