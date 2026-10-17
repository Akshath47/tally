import { ageText } from "./pace";

// Stale-data copy (docs/ui-design.md, Home and Accounts). The Worker decides which accounts are
// stale (docs/phase-2-insights-spec.md); these only word it.

/** The Account fields the copy needs; structural so tests needn't load api.ts (and the mock). */
type StaleAccount = { name: string; importEnabled: boolean; lastDataChangeAt: string | null; staleDays: number | null };

/** "Bank A 2h ago · Card B 4 days ago": Home's freshness line once an account is stale. */
export const perAccountFreshness = (accounts: StaleAccount[], now: Date = new Date()) =>
  accounts
    .filter((a) => a.importEnabled)
    .map((a) => `${a.name} ${a.lastDataChangeAt ? ageText(a.lastDataChangeAt, now) : "never"}`)
    .join(" · ");

/** Home's banner: one stale account by name, several by count. */
export function staleBannerText(stale: StaleAccount[]): string {
  if (stale.length === 1) return `${stale[0]!.name} hasn't updated for ${stale[0]!.staleDays} days, so recent spending may be missing.`;
  const shortest = Math.min(...stale.map((a) => a.staleDays ?? 0));
  return `${stale.length} accounts haven't updated for ${shortest}+ days, so recent spending may be missing.`;
}
