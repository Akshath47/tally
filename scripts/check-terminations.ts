// Checks whether Cloudflare stopped any Worker run (cron or HTTP), or any import didn't finish.
//
// Run:  node scripts/check-terminations.ts [--days <n>]   (default 30; max 90, the analytics retention)
//
// Prints "All clear" or each problem, and exits 1 when there are any. Reads Cloudflare's
// analytics (needs the env vars in scripts/lib/cloudflare.ts) and import_runs in the remote
// D1 through wrangler. Prints times, ids and statuses only.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findProblems, weeklyWindows, type ImportRun, type Invocation } from "./check-terminations/problems.ts";
import { fail, gql, workerConfig } from "./lib/cloudflare.ts";
import type { CronRow } from "./usage-report/report.ts";

const RETENTION_DAYS = 90;
// The datasets' maxPageSize (scripts/usage-report.ts --schema).
const LIMIT = 10_000;

const { values: args } = parseArgs({ options: { days: { type: "string", default: "30" } } });
const days = Number(args.days);
if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) {
  fail(`--days must be a whole number from 1 to ${RETENTION_DAYS} (Cloudflare keeps analytics for ${RETENTION_DAYS} days).`);
}

type Week = {
  viewer: {
    accounts: { cron: CronRow[]; invocations: { dimensions: { date: string; status: string }; sum: { requests: number } }[] }[];
  };
};

const FILTER = "{ scriptName: $script, datetime_geq: $since, datetime_lt: $until }";
const QUERY = `query ($a: string!, $script: string!, $since: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    cron: workersInvocationsScheduled(limit: ${LIMIT}, filter: ${FILTER}) {
      datetime cpuTimeUs status
    }
    invocations: workersInvocationsAdaptive(limit: ${LIMIT}, filter: ${FILTER}) {
      dimensions { date status } sum { requests }
    }
  } }
}`;

/** Import runs that were cut off, or are still marked running, from the remote D1. */
function importRuns(since: string): ImportRun[] {
  // `since` is an ISO timestamp this script built, never user text.
  const sql = `SELECT id, trigger, started_at AS startedAt, status, error_summary AS errorSummary FROM import_runs
    WHERE started_at >= '${since}' AND (error_summary = 'abandoned' OR status = 'running')`;
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--remote", "--json", `--command=${sql}`], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (JSON.parse(out) as { results: ImportRun[] }[])[0]!.results;
}

const now = new Date();
const { scriptName } = workerConfig();
const windows = weeklyWindows(now, days);
const cron: CronRow[] = [];
const invocations: Invocation[] = [];
for (const w of windows) {
  const acct = (await gql<Week>(QUERY, { script: scriptName, since: w.since, until: w.until })).viewer.accounts[0]!;
  if (acct.cron.length === LIMIT || acct.invocations.length === LIMIT) console.warn(`WARNING: results from ${w.since} hit the row limit.`);
  cron.push(...acct.cron);
  invocations.push(...acct.invocations.map((g) => ({ ...g.dimensions, requests: g.sum.requests })));
}
const problems = findProblems(cron, invocations, importRuns(windows[0]!.since), now);

const requests = invocations.reduce((n, i) => n + i.requests, 0);
console.log(`Last ${days} days: ${cron.length} cron runs and ${requests} invocations in Cloudflare's analytics, plus import runs in D1.`);
if (problems.length === 0) {
  console.log("All clear: Cloudflare stopped nothing and every import finished.");
} else {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log(`  ${p.when}  ${p.what}`);
  process.exitCode = 1;
}
