// Finds runs Cloudflare stopped (or that otherwise didn't finish) from already-fetched rows.
// No Node or network code, so the Workers-pool tests can import it.

import type { CronRow } from "../usage-report/report";

/** `workersInvocationsAdaptive` grouped by UTC date and status. Covers HTTP and cron together. */
export type Invocation = { date: string; status: string; requests: number };
export type ImportRun = { id: number; trigger: string; startedAt: string; status: string; errorSummary: string | null };
export type Problem = { when: string; what: string };

// A client hanging up mid-request is the client's doing, not a failed run.
const HEALTHY = new Set(["success", "clientDisconnected"]);
// Longer than any run can live (the cron lease is 10 min), so a run still 'running' was cut off.
const STUCK_AFTER_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

/** The lookback split into windows of at most 7 days, the cron dataset's per-query maximum. */
export function weeklyWindows(until: Date, days: number): { since: string; until: string }[] {
  const windows = [];
  for (let end = until.getTime(), start = end - days * DAY_MS; start < end; ) {
    const next = Math.min(start + 7 * DAY_MS, end);
    windows.push({ since: new Date(start).toISOString(), until: new Date(next).toISOString() });
    start = next;
  }
  return windows;
}

/** Everything that didn't finish normally, oldest first. Empty means all clear. */
export function findProblems(cron: CronRow[], invocations: Invocation[], runs: ImportRun[], now: Date): Problem[] {
  const problems: Problem[] = [];
  // The all-invocations data counts cron runs too, so failed cron runs are taken off it
  // (per UTC day and status) to leave the HTTP requests.
  const cronFailures = new Map<string, number>();
  for (const c of cron) {
    if (HEALTHY.has(c.status)) continue;
    problems.push({ when: c.datetime, what: `cron run ended with status ${c.status} (${(c.cpuTimeUs / 1000).toFixed(1)} ms CPU)` });
    const key = `${c.datetime.slice(0, 10)}|${c.status}`;
    cronFailures.set(key, (cronFailures.get(key) ?? 0) + 1);
  }
  // A day can come back split across two query windows, so add it up first.
  const failedByDay = new Map<string, number>();
  for (const i of invocations) {
    if (!HEALTHY.has(i.status)) failedByDay.set(`${i.date}|${i.status}`, (failedByDay.get(`${i.date}|${i.status}`) ?? 0) + i.requests);
  }
  for (const [key, requests] of failedByDay) {
    const http = requests - (cronFailures.get(key) ?? 0);
    const [date, status] = key.split("|");
    if (http > 0) problems.push({ when: date!, what: `${http} HTTP requests ended with status ${status}` });
  }
  for (const r of runs) {
    if (r.errorSummary === "abandoned") {
      problems.push({ when: r.startedAt, what: `${r.trigger} import run ${r.id} was cut off before it finished (abandoned)` });
    } else if (r.status === "running" && now.getTime() - Date.parse(r.startedAt) > STUCK_AFTER_MS) {
      problems.push({ when: r.startedAt, what: `${r.trigger} import run ${r.id} is still marked running` });
    }
  }
  return problems.sort((a, b) => a.when.localeCompare(b.when));
}
