// P1.8 usage report: turns already-fetched Cloudflare analytics rows into summaries and
// pass/fail verdicts. No Node or network code, so the Workers-pool tests can import it.

/** One cron invocation from `workersInvocationsScheduled`. */
export type CronRow = { datetime: string; cpuTimeUs: number; status: string };
/** One `workersInvocationsAdaptive` group, grouped by status. CPU quantiles are in µs. */
export type StatusGroup = { status: string; requests: number; errors: number; cpuTimeP50: number; cpuTimeP99: number };
/** One `d1AnalyticsAdaptiveGroups` row, grouped by UTC date. */
export type D1Day = { date: string; rowsRead: number; rowsWritten: number };

/** Free-tier allowances (docs/research/platform-constraints.md) and P1.8's thresholds. */
export const LIMITS = {
  importP99Ms: 7,
  heaviestRunMs: 10,
  d1WritesPerDay: 100_000,
  d1WriteShare: 0.05,
  d1ReadsPerDay: 5_000_000,
};

/** Nearest-rank percentile, so the result is always a value that was actually measured. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  return sortedAsc[Math.max(0, Math.ceil(p * sortedAsc.length) - 1)]!;
}

export function summariseCron(rows: CronRow[]) {
  const ms = rows.map((r) => r.cpuTimeUs / 1000).sort((a, b) => a - b);
  const nonSuccess: Record<string, number> = {};
  for (const r of rows) if (r.status !== "success") nonSuccess[r.status] = (nonSuccess[r.status] ?? 0) + 1;
  return {
    runs: rows.length,
    p50Ms: percentile(ms, 0.5),
    p99Ms: percentile(ms, 0.99),
    maxMs: ms.at(-1) ?? null,
    heaviest: [...rows].sort((a, b) => b.cpuTimeUs - a.cpuTimeUs).slice(0, 5),
    nonSuccess,
  };
}

export function summariseStatuses(groups: StatusGroup[]) {
  const byStatus: Record<string, number> = {};
  let requests = 0;
  let errors = 0;
  for (const g of groups) {
    byStatus[g.status] = (byStatus[g.status] ?? 0) + g.requests;
    requests += g.requests;
    errors += g.errors;
  }
  return { requests, errors, byStatus };
}

/** Oldest day first. `today` (UTC) is still filling up, so it's marked partial. */
export function summariseD1(days: D1Day[], today: string) {
  return [...days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      day: d.date,
      rowsRead: d.rowsRead,
      rowsWritten: d.rowsWritten,
      writeShare: d.rowsWritten / LIMITS.d1WritesPerDay,
      partial: d.date === today,
    }));
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

/** P1.8's three acceptance checks. Missing data is never a pass. */
export function verdicts(cron: ReturnType<typeof summariseCron>, d1: ReturnType<typeof summariseD1>): Verdict[] {
  const maxWrites = d1.length === 0 ? null : Math.max(...d1.map((d) => d.rowsWritten));
  return [
    verdict("import P99 CPU", cron.p99Ms, LIMITS.importP99Ms, "ms"),
    verdict("heaviest run CPU", cron.maxMs, LIMITS.heaviestRunMs, "ms"),
    verdict("daily D1 writes", maxWrites, LIMITS.d1WritesPerDay * LIMITS.d1WriteShare, "rows"),
  ];
}
