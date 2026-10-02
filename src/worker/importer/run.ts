import type { IMPORT_TRIGGERS, IMPORT_RUN_STATUSES } from "../db/schema";
import { createClient, type LunchFlowClient, type ProviderAccount } from "./client";
import { CountingDb } from "./db";
import { londonToday } from "./dates";
import { ImportError } from "./errors";
import { claimLock, closeAbandonedRuns, releaseLock } from "./lock";
import { toMinor } from "./money";
import { accountLabel, normalizeTransaction, type TransactionRow } from "./normalize";
import { backfillChunks, coveredRanges, incrementalWindow, type Window } from "./windows";
import {
  countMissingPosted,
  disableForeignAccount,
  insertRunAccount,
  markVanished,
  updateAccountStatus,
  upsertAccounts,
  upsertTransactions,
  type AccountOutcome,
  type AccountRow,
  type AccountSummary,
} from "./writes";

export type { AccountSummary };

const DEFAULT_BACKFILL_DAYS = 90;
const BUDGET_CURRENCY = "GBP";

export type ImportEnv = { DB: D1Database; LUNCHFLOW_API_KEY: string; BACKFILL_DAYS?: string };
export type RunDeps = {
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock budget for provider calls, so a run ends cleanly before the runtime would cut it off. */
  budgetMs?: number;
};

export type RunSummary = {
  runId: number;
  status: (typeof IMPORT_RUN_STATUSES)[number];
  errorSummary: string | null;
  accounts: AccountSummary[];
  statements: number;
  subrequests: number;
};

/** A run that exists and has tried for the lease; `finished` settles when it has been closed. */
export type StartedImport = { runId: number; locked: boolean; finished: Promise<RunSummary> };

type Ctx = {
  db: CountingDb;
  client: LunchFlowClient;
  runId: number;
  nowIso: string;
  today: string;
  backfillDays: number;
};

function errorText(e: unknown): string {
  if (!(e instanceof ImportError)) return "internal";
  return e.httpStatus === null ? e.kind : `${e.kind} ${e.httpStatus}`;
}

function parseBackfillDays(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BACKFILL_DAYS;
}

/**
 * Creates the run and tries to claim the lease, then carries on in `finished`: it imports if
 * it holds the lease, otherwise closes the run as skipped_locked. Only creating the run can
 * reject here. One account failing never stops another, and the lease is always released.
 * Only counts, statuses and durations are logged and stored, never provider payloads.
 */
export async function startImport(env: ImportEnv, trigger: (typeof IMPORT_TRIGGERS)[number], deps: RunDeps = {}): Promise<StartedImport> {
  const started = Date.now();
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const db = new CountingDb(env.DB);
  const deadline = deps.budgetMs === undefined ? undefined : started + deps.budgetMs;
  const client = createClient({ apiKey: env.LUNCHFLOW_API_KEY, fetch: deps.fetch, sleep: deps.sleep, deadline });

  const run = await db.first<{ id: number }>(
    db.prepare("INSERT INTO import_runs (trigger, started_at, status) VALUES (?1, ?2, 'running') RETURNING id").bind(trigger, nowIso),
  );
  const runId = run!.id;
  const claim = await claimLock(db, runId, now).then(
    (ok) => ({ ok, error: null as unknown }),
    (error: unknown) => ({ ok: false, error }),
  );

  const finished = (async (): Promise<RunSummary> => {
    // Its own budget: closing the run must work even if the run itself overspent.
    const closing = new CountingDb(env.DB, 3);
    let status: RunSummary["status"] = "failed";
    let errorSummary: string | null = null;
    const accounts: AccountSummary[] = [];

    try {
      if (claim.error !== null) throw claim.error;
      if (!claim.ok) {
        status = "skipped_locked";
      } else {
        await closeAbandonedRuns(db, runId, now);
        const ctx: Ctx = { db, client, runId, nowIso, today: londonToday(now), backfillDays: parseBackfillDays(env.BACKFILL_DAYS) };
        accounts.push(...(await importAll(ctx)));
        const ok = accounts.filter((a) => a.status === "success").length;
        status = ok === accounts.length ? "success" : ok === 0 ? "failed" : "partial";
      }
    } catch (e) {
      status = "failed";
      errorSummary = errorText(e);
    } finally {
      if (claim.ok) await releaseLock(closing, runId);
      await closing.run(
        closing
          .prepare("UPDATE import_runs SET finished_at = ?2, status = ?3, error_summary = ?4 WHERE id = ?1")
          .bind(runId, new Date(now.getTime() + (Date.now() - started)).toISOString(), status, errorSummary),
      );
    }

    const summary: RunSummary = { runId, status, errorSummary, accounts, statements: db.statements + closing.statements, subrequests: client.subrequests };
    console.log(
      JSON.stringify({
        event: "import_run", runId, trigger, status, error: errorSummary, accounts: accounts.length,
        statements: summary.statements, subrequests: summary.subrequests, durationMs: Date.now() - started,
      }),
    );
    return summary;
  })();

  return { runId, locked: claim.ok, finished };
}

/** Starts a run and waits for it to close. */
export async function runImport(env: ImportEnv, trigger: (typeof IMPORT_TRIGGERS)[number], deps: RunDeps = {}): Promise<RunSummary> {
  return (await startImport(env, trigger, deps)).finished;
}

async function importAll(ctx: Ctx): Promise<AccountSummary[]> {
  const { db, client, nowIso } = ctx;
  const providerAccounts = await client.accounts();

  // Known currencies first, so the label (which includes the currency) is stable across runs.
  const known = await db.all<{ provider_account_id: string; currency: string | null }>(
    db.prepare("SELECT provider_account_id, currency FROM accounts WHERE provider = 'lunchflow'"),
  );
  const currencyById = new Map(known.results.map((r) => [r.provider_account_id, r.currency]));

  const stored = await db.all<AccountRow>(
    upsertAccounts(
      db,
      nowIso,
      providerAccounts.map((a) => ({
        id: a.id,
        connection_id: a.connection_id ?? null,
        name: accountLabel(a, currencyById.get(String(a.id)) ?? null),
        institution_name: a.institution_name,
        status: a.status,
      })),
    ),
  );

  const providerById = new Map(providerAccounts.map((a) => [String(a.id), a]));
  const summaries: AccountSummary[] = [];
  const todo = stored.results
    .filter((r) => r.import_enabled === 1 || r.currency === null)
    .sort((a, b) => a.id - b.id);

  for (const row of todo) {
    const summary = await importAccount(ctx, row, providerById.get(row.provider_account_id)!);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/** Returns null when the account was only recorded (non-GBP) and nothing was attempted. */
async function importAccount(ctx: Ctx, row: AccountRow, provider: ProviderAccount): Promise<AccountSummary | null> {
  const { db, client, runId, nowIso, today } = ctx;
  const started = Date.now();

  // Learned this run, kept so a failure after the balance call still records the currency.
  let currency = row.currency;
  let balanceMinor: number | null = null;
  const summary: AccountSummary = {
    accountId: row.id, status: "failed", fetched: 0, inserted: 0, updated: 0, vanishedMarked: 0,
    missingPosted: 0, httpStatus: null, error: null, durationMs: 0,
  };
  let range: Window | null = null;

  // The status write is the same on success and failure apart from these fields.
  const statusUpdate = (o: Pick<AccountOutcome, "ok" | "error" | "backfillCursor" | "backfillComplete">) =>
    updateAccountStatus(db, {
      accountId: row.id, now: nowIso, currency, enabled: currency === BUDGET_CURRENCY,
      label: accountLabel(provider, currency), balanceMinor, ...o,
    });

  try {
    try {
      const balance = await client.balance(provider.id);
      currency ??= balance.currency;
      balanceMinor = toMinor(balance.amount, balance.currency).minor;
    } catch (e) {
      // The balance is only for display. Without a currency, though, we can't import.
      if (currency === null) throw e;
    }
    // Non-null: the catch above rethrows whenever no currency is known.
    const accountCurrency = currency!;

    if (row.currency === null && accountCurrency !== BUDGET_CURRENCY) {
      await db.run(
        disableForeignAccount(db, { accountId: row.id, now: nowIso, currency: accountCurrency, label: accountLabel(provider, currency), balanceMinor }),
      );
      return null;
    }

    const windows: Window[] = [incrementalWindow(today)];
    let backfill: ReturnType<typeof backfillChunks> | null = null;
    if (row.backfill_complete === 0) {
      backfill = backfillChunks(row.backfill_cursor_date, today, ctx.backfillDays);
      windows.push(...backfill.chunks);
    }
    range = { from: windows[windows.length - 1]!.from, to: today };

    // Everything is fetched and validated before any write, so a bad response writes nothing.
    const fetched = await fetchWindows(client, provider.id, row.id, accountCurrency, windows);
    summary.fetched = fetched.count;

    // Absence only means something inside a range this run fetched in full.
    const checks = coveredRanges(windows).map((r) => ({
      range: r,
      idsJson: JSON.stringify(windows.flatMap((w, i) => (w.from >= r.from && w.to <= r.to ? fetched.idsByWindow[i]! : []))),
    }));

    const upserts = upsertTransactions(db, row.id, runId, nowIso, fetched.rows);
    const results = await db.batch([
      ...checks.map((c) => countMissingPosted(db, row.id, c.range, c.idsJson)),
      ...upserts,
      ...checks.map((c) => markVanished(db, row.id, nowIso, c.range, c.idsJson)),
      statusUpdate({
        ok: true, error: null,
        backfillCursor: backfill?.nextCursor ?? null,
        backfillComplete: backfill ? backfill.complete : null,
      }),
    ]);

    Object.assign(summary, tallyResults(results, checks.length, upserts.length), { status: "success", httpStatus: 200 });
  } catch (e) {
    summary.error = errorText(e);
    summary.httpStatus = e instanceof ImportError ? e.httpStatus : null;
    await db.run(statusUpdate({ ok: false, error: summary.error, backfillCursor: null, backfillComplete: null }));
  }

  summary.durationMs = Date.now() - started;
  await db.run(insertRunAccount(db, { runId, ...summary, window: range }));
  console.log(
    JSON.stringify({
      event: "import_account", runId, accountId: row.id, status: summary.status, fetched: summary.fetched,
      inserted: summary.inserted, updated: summary.updated, vanishedMarked: summary.vanishedMarked,
      missingPosted: summary.missingPosted, error: summary.error, durationMs: summary.durationMs,
    }),
  );
  return summary;
}

async function fetchWindows(client: LunchFlowClient, providerId: number, accountId: number, currency: string, windows: Window[]) {
  const byId = new Map<string, TransactionRow>();
  const idsByWindow: string[][] = [];
  let count = 0;
  for (const w of windows) {
    const fetched = await client.transactions(providerId, w);
    count += fetched.length;
    const ids: string[] = [];
    for (const t of fetched) {
      const normalised = normalizeTransaction(t, accountId, currency);
      byId.set(normalised.provider_txn_id, normalised);
      ids.push(normalised.provider_txn_id);
    }
    idsByWindow.push(ids);
  }
  return { rows: [...byId.values()], idsByWindow, count };
}

/** Reads the batch results back in the order run.ts laid the statements out. */
function tallyResults(results: D1Result[], checks: number, upserts: number) {
  const sum = (rs: D1Result[], pick: (r: D1Result) => number) => rs.reduce((total, r) => total + pick(r), 0);
  const upsertResults = results.slice(checks, checks + upserts);
  const inserted = sum(upsertResults, (r) => (r.results as { inserted: number }[]).filter((x) => x.inserted === 1).length);
  const vanishFrom = checks + upserts;
  return {
    missingPosted: sum(results.slice(0, checks), (r) => (r.results[0] as { n: number }).n),
    inserted,
    updated: sum(upsertResults, (r) => r.results.length) - inserted,
    vanishedMarked: sum(results.slice(vanishFrom, vanishFrom + checks), (r) => r.meta.changes),
  };
}
