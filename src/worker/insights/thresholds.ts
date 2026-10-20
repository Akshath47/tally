// Insight thresholds (docs/phase-2-insights-spec.md, Thresholds), in one place so tuning is a
// one-line change. Money is minor units; a ratio is [numerator, denominator]. STALE_AFTER_DAYS
// lives with the stale check (../budget/stale.ts).

export const PACE_FROM_DAY = 8;
export const UNUSUAL_FROM_DAY = 8;
export const UNUSUAL_RATIO = [3, 2] as const;
export const UNUSUAL_MIN_EXCESS_MINOR = 3_000;
export const UNUSUAL_BASELINE_MONTHS = 3;
export const UNUSUAL_MIN_BASELINE_MONTHS = 2;
export const LARGE_CHARGE_MIN_MINOR = 10_000;
export const LARGE_CHARGE_RATIO = 3;
export const LARGE_CHARGE_MIN_HISTORY = 3;
export const LARGE_CHARGE_LOOKBACK_DAYS = 7;
/** "The previous 6 months" of a merchant's charges. */
export const LARGE_CHARGE_HISTORY_DAYS = 182;
/** At most this many large charges are reported, biggest first. */
export const LARGE_CHARGE_MAX_CANDIDATES = 10;
export const MONTH_CHANGE_MIN_MINOR = 2_500;
export const MONTH_CHANGE_MIN_PCT = 25;
export const MONTH_CHANGE_SHOW_DAYS = 7;
export const MONTH_CHANGE_MAX = 3;
