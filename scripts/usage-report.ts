// P1.8 free-tier usage report.
//
// Run:  node scripts/usage-report.ts [--since <ISO>] [--until <ISO>] [--schema]
//
// Needs the env vars in scripts/lib/cloudflare.ts. Reports Worker CPU for cron runs and all
// invocations, invocation statuses, and D1 rows read/written per UTC day, then P1.8's
// verdicts. The window defaults to the last 24 hours and can't exceed 7 days, the cron
// dataset's maximum (verified with --schema, 2026-10-03). `--schema` prints each dataset's
// available fields instead, to check the queries below against the live API.

import { parseArgs } from "node:util";
import { fail, gql, workerConfig } from "./lib/cloudflare.ts";
import { LIMITS, summariseCron, summariseD1, summariseStatuses, verdicts, type CronRow, type D1Day, type StatusGroup } from "./usage-report/report.ts";

const MAX_WINDOW_MS = 7 * 24 * 3_600_000;
const CRON_LIMIT = 1000;
const GROUP_LIMIT = 100;

const { values: args } = parseArgs({ options: { since: { type: "string" }, until: { type: "string" }, schema: { type: "boolean" } } });

const DATASETS = ["workersInvocationsScheduled", "workersInvocationsAdaptive", "d1AnalyticsAdaptiveGroups"] as const;

async function printSchema() {
  type Settings = Record<string, { availableFields: string[]; maxDuration: number; notOlderThan: number; maxPageSize: number }>;
  const fields = "availableFields maxDuration notOlderThan maxPageSize";
  const data = await gql<{ viewer: { accounts: { settings: Settings }[] } }>(
    `query ($a: string!) { viewer { accounts(filter: { accountTag: $a }) { settings { ${DATASETS.map((d) => `${d} { ${fields} }`).join(" ")} } } } }`
  );
  for (const [name, s] of Object.entries(data.viewer.accounts[0]!.settings)) {
    console.log(`${name}  (maxDuration ${s.maxDuration}s, notOlderThan ${s.notOlderThan}s, maxPageSize ${s.maxPageSize})`);
    for (const f of s.availableFields) console.log(`  ${f}`);
  }
}

function window() {
  const until = args.until ? new Date(args.until) : new Date();
  const since = args.since ? new Date(args.since) : new Date(until.getTime() - 24 * 3_600_000);
  if (Number.isNaN(until.getTime()) || Number.isNaN(since.getTime())) fail("--since/--until must be ISO timestamps.");
  if (since >= until) fail("--since must be before --until.");
  if (until.getTime() - since.getTime() > MAX_WINDOW_MS) fail("The window can't exceed 7 days.");
  return { since: since.toISOString(), until: until.toISOString() };
}

type Report = {
  viewer: {
    accounts: {
      cron: CronRow[];
      invocations: {
        dimensions: { status: string };
        sum: { requests: number; errors: number };
        quantiles: { cpuTimeP50: number; cpuTimeP99: number };
        max: { cpuTime: number };
      }[];
      d1: { dimensions: { date: string }; sum: { rowsRead: number; rowsWritten: number } }[];
    }[];
  };
};

const REPORT_QUERY = `query ($a: string!, $script: string!, $since: Time!, $until: Time!, $sinceDate: Date!, $untilDate: Date!, $db: string!) {
  viewer { accounts(filter: { accountTag: $a }) {
    cron: workersInvocationsScheduled(limit: ${CRON_LIMIT}, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
      datetime cpuTimeUs status
    }
    invocations: workersInvocationsAdaptive(limit: ${GROUP_LIMIT}, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
      dimensions { status } sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 } max { cpuTime }
    }
    d1: d1AnalyticsAdaptiveGroups(limit: ${GROUP_LIMIT}, filter: { databaseId: $db, date_geq: $sinceDate, date_leq: $untilDate }) {
      dimensions { date } sum { rowsRead rowsWritten }
    }
  } }
}`;

const ms = (v: number | null) => (v === null ? "n/a" : `${v.toFixed(2)} ms`);

async function printReport() {
  const { since, until } = window();
  const { scriptName, databaseId } = workerConfig();
  const data = await gql<Report>(REPORT_QUERY, {
    script: scriptName, since, until, sinceDate: since.slice(0, 10), untilDate: until.slice(0, 10), db: databaseId,
  });
  const acct = data.viewer.accounts[0]!;
  if (acct.cron.length === CRON_LIMIT || acct.invocations.length === GROUP_LIMIT || acct.d1.length === GROUP_LIMIT) {
    console.warn("WARNING: a result hit its row limit, so the figures below cover only part of the window.\n");
  }

  const cron = summariseCron(acct.cron);
  const groups: StatusGroup[] = acct.invocations.map((g) => ({ status: g.dimensions.status, ...g.sum, ...g.quantiles, cpuTimeMax: g.max.cpuTime }));
  const statuses = summariseStatuses(groups);
  const d1Days: D1Day[] = acct.d1.map((d) => ({ date: d.dimensions.date, ...d.sum }));
  const d1 = summariseD1(d1Days, { since, until });

  console.log(`Window ${since} .. ${until}\n`);
  console.log(`Cron runs: ${cron.runs}   CPU P50 ${ms(cron.p50Ms)}   P99 ${ms(cron.p99Ms)}   max ${ms(cron.maxMs)}`);
  if (Object.keys(cron.nonSuccess).length) console.log(`  not success: ${JSON.stringify(cron.nonSuccess)}`);
  console.log("  heaviest:");
  for (const r of cron.heaviest) console.log(`    ${r.datetime}  ${ms(r.cpuTimeUs / 1000)}  ${r.status}`);

  // The API has no trigger dimension here, so HTTP requests and cron runs are counted together.
  console.log(`\nAll invocations, HTTP and cron together (sampled): ${statuses.requests} requests, ${statuses.errors} errors`);
  for (const g of groups) {
    console.log(
      `  ${g.status.padEnd(24)} ${String(g.requests).padStart(6)}   CPU P50 ${ms(g.cpuTimeP50 / 1000)}   P99 ${ms(g.cpuTimeP99 / 1000)}   max ${ms(g.cpuTimeMax / 1000)}`,
    );
  }

  console.log(`\nD1 per UTC day (allowance ${LIMITS.d1ReadsPerDay.toLocaleString("en-GB")} read / ${LIMITS.d1WritesPerDay.toLocaleString("en-GB")} written):`);
  for (const d of d1) {
    console.log(`  ${d.date}${d.partial ? "*" : " "}  read ${String(d.rowsRead).padStart(9)}   written ${String(d.rowsWritten).padStart(7)} (${((d.rowsWritten / LIMITS.d1WritesPerDay) * 100).toFixed(2)}%)`);
  }
  if (d1.some((d) => d.partial)) console.log("  * whole UTC day, only partly inside the window (or still filling up)");

  console.log("\nP1.8 verdicts:");
  for (const v of verdicts(cron, statuses, d1)) console.log(`  ${v.check.padEnd(20)} ${v.value.padStart(12)}  (${v.limit})  ${v.result}`);
}

await (args.schema ? printSchema() : printReport());
