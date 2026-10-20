import { isStale, STALE_AFTER_DAYS } from "../worker/budget/stale";
import { ageText } from "./pace";

// Stale-data copy (docs/ui-design.md, Home and Accounts). The Worker decides which accounts are
// stale (docs/phase-2-insights-spec.md); these only word it.

/** The Account fields the copy needs; structural so tests needn't load api.ts (and the mock). */
type StaleAccount = { id: number; name: string; importEnabled: boolean; lastDataChangeAt: string | null; staleDays: number | null };

/**
 * "2h ago", or for a stale account the Worker's London-day count ("4 days ago"), so it never
 * contradicts the warning beside it (elapsed hours can round down a day).
 */
export function freshnessAge(a: StaleAccount, now: Date = new Date()): string {
  if (a.lastDataChangeAt === null) return "never";
  return isStale(a.staleDays) ? `${a.staleDays} days ago` : ageText(a.lastDataChangeAt, now);
}

/** "Bank A 2h ago · Card B 4 days ago": Home's freshness line once an account is stale. */
export const perAccountFreshness = (accounts: StaleAccount[], now: Date = new Date()) =>
  accounts
    .filter((a) => a.importEnabled)
    .map((a) => `${a.name} ${freshnessAge(a, now)}`)
    .join(" · ");

/**
 * Home's banner for the summary's `staleIds`: one stale account by name, several by count. The
 * names and day counts come from the separately cached accounts list, so when it hasn't loaded or
 * no longer agrees, the banner falls back to the threshold rather than show a wrong count.
 */
export function staleBannerText(staleIds: number[], accounts: StaleAccount[]): string {
  const stale = accounts.filter((a) => staleIds.includes(a.id) && isStale(a.staleDays));
  const known = stale.length === staleIds.length;
  if (staleIds.length === 1) {
    return known
      ? `${stale[0]!.name} hasn't updated for ${stale[0]!.staleDays} days, so recent spending may be missing.`
      : `An account hasn't updated for ${STALE_AFTER_DAYS}+ days, so recent spending may be missing.`;
  }
  const shortest = known ? Math.min(...stale.map((a) => a.staleDays!)) : STALE_AFTER_DAYS;
  return `${staleIds.length} accounts haven't updated for ${shortest}+ days, so recent spending may be missing.`;
}
