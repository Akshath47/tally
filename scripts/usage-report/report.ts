// P1.8 usage report: turns already-fetched Cloudflare analytics rows into summaries and
// pass/fail verdicts. No Node or network code, so the Workers-pool tests can import it.

/** One cron invocation from `workersInvocationsScheduled`. */
export type CronRow = { datetime: string; cpuTimeUs: number; status: string };
/**
 * One `workersInvocationsAdaptive` group, grouped by status. CPU figures are in µs. The
 * dataset has no trigger dimension, so these cover HTTP requests and cron runs together.
 */
export type StatusGroup = { status: string; requests: number; errors: number; cpuTimeP50: number; cpuTimeP99: number; cpuTimeMax: number };
/** One `d1AnalyticsAdaptiveGroups` row, grouped by UTC date. */
export type D1Day = { date: string; rowsRead: number; rowsWritten: number };

/** Free-tier allowances (docs/research/platform-constraints.md) and P1.8's thresholds. */
export const LIMITS = {
  importP99Ms: 7,
  heaviestRunMs: 10,
  d1WritesPerDay: 100_000,
  // P1.8: daily writes stay under 5% of the allowance.
  d1WritesBudget: 5_000,
  d1ReadsPerDay: 5_000_000,
};

/** Nearest-rank percentile, so the result is always a value that was actually measured. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  return sortedAsc[Math.max(0, Math.ceil(p * sortedAsc.length) - 1)]!;
}

export function summariseCron(rows: CronRow[]) {
  const byCpu = [...rows].sort((a, b) => b.cpuTimeUs - a.cpuTimeUs);
  const ms = byCpu.map((r) => r.cpuTimeUs / 1000).reverse();
  const nonSuccess: Record<string, number> = {};
  for (const r of rows) if (r.status !== "success") nonSuccess[r.status] = (nonSuccess[r.status] ?? 0) + 1;
  return {
    runs: rows.length,
    p50Ms: percentile(ms, 0.5),
    p99Ms: percentile(ms, 0.99),
    maxMs: ms.at(-1) ?? null,
    heaviest: byCpu.slice(0, 5),
    nonSuccess,
  };
}

export function summariseStatuses(groups: StatusGroup[]) {
  return {
    requests: groups.reduce((n, g) => n + g.requests, 0),
    errors: groups.reduce((n, g) => n + g.errors, 0),
    maxMs: groups.length === 0 ? null : Math.max(...groups.map((g) => g.cpuTimeMax)) / 1000,
  };
}

/**
 * Oldest day first. D1 reports whole UTC days, so the window's first and last days are
 * marked partial: they include activity outside the window, and the last may still be filling up.
 */
export function summariseD1(days: D1Day[], window: { since: string; until: string }) {
  const edges = new Set([window.since.slice(0, 10), window.until.slice(0, 10)]);
  return [...days].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, partial: edges.has(d.date) }));
}

export type Verdict = { check: string; value: string; limit: string; result: "pass" | "fail" | "not enough data" };

function verdict(check: string, value: number | null, limit: number, unit: string): Verdict {
  return {
    check,
    value: value === null ? "n/a" : `${value} ${unit}`,
    limit: `< ${limit} ${unit}`,
    result: value === null ? "not enough data" : value < limit ? "pass" : "fail",
  };
}

/**
 * P1.8's three acceptance checks. Missing data is never a pass. P99 is cron-only (HTTP
 * figures mix in light page loads), but the heaviest run also counts HTTP invocations,
 * since a manual import runs the same importer, backfill included.
 */
export function verdicts(
  cron: ReturnType<typeof summariseCron>,
  invocations: ReturnType<typeof summariseStatuses>,
  d1: ReturnType<typeof summariseD1>,
): Verdict[] {
  const maxWrites = d1.length === 0 ? null : Math.max(...d1.map((d) => d.rowsWritten));
  const maxes = [cron.maxMs, invocations.maxMs].filter((v) => v !== null);
  return [
    verdict("cron import P99 CPU", cron.p99Ms, LIMITS.importP99Ms, "ms"),
    verdict("heaviest run CPU", maxes.length === 0 ? null : Math.max(...maxes), LIMITS.heaviestRunMs, "ms"),
    verdict("daily D1 writes", maxWrites, LIMITS.d1WritesBudget, "rows"),
  ];
}
