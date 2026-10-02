import type { IMPORT_TRIGGERS, IMPORT_RUN_STATUSES } from "../db/schema";
import { createClient, type LunchFlowClient, type ProviderAccount } from "./client";
import { CountingDb } from "./db";
import { londonToday } from "./dates";
import { ImportError } from "./errors";
import { claimLock, releaseLock } from "./lock";
import { toMinor } from "./money";
import { accountLabel, normalizeTransaction, type TransactionRow } from "./normalize";
import { backfillChunks, incrementalWindow, type Window } from "./windows";
import {
  bumpLastSeen,
  countMissingPosted,
  disableForeignAccount,
  insertRunAccount,
  markVanished,
  updateAccountStatus,
  upsertAccounts,
  upsertTransactions,
  type AccountRow,
} from "./writes";

const DEFAULT_BACKFILL_DAYS = 90;
const BUDGET_CURRENCY = "GBP";

export type ImportEnv = { DB: D1Database; LUNCHFLOW_API_KEY: string; BACKFILL_DAYS?: string };
export type RunDeps = { fetch?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void> };

export type AccountSummary = {
  accountId: number;
  status: "success" | "failed";
  fetched: number;
  inserted: number;
  updated: number;
  vanishedMarked: number;
  missingPosted: number;
  httpStatus: number | null;
  /** Sanitised, e.g. "server 503"; never provider text. */
  error: string | null;
  durationMs: number;
};

export type RunSummary = {
  runId: number;
  status: (typeof IMPORT_RUN_STATUSES)[number];
  errorSummary: string | null;
  accounts: AccountSummary[];
  statements: number;
  subrequests: number;
};

type Ctx = {
  db: CountingDb;
  client: LunchFlowClient;
  runId: number;
  now: Date;
  nowIso: string;
  today: string;
  backfillDays: number;
};

export function errorText(e: unknown): string {
  if (!(e instanceof ImportError)) return "internal";
  return e.httpStatus === null ? e.kind : `${e.kind} ${e.httpStatus}`;
}

/**
 * One import run: claims the lease, reads Lunch Flow, writes D1, and always releases the
 * lease. One account failing never stops another. Only counts, statuses and durations are
 * logged and stored, never provider payloads.
 */
export async function runImport(env: ImportEnv, trigger: (typeof IMPORT_TRIGGERS)[number], deps: RunDeps = {}): Promise<RunSummary> {
  const started = Date.now();
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const db = new CountingDb(env.DB);
  const client = createClient({ apiKey: env.LUNCHFLOW_API_KEY, fetch: deps.fetch, sleep: deps.sleep });

  const run = await db.first<{ id: number }>(
    db.prepare("INSERT INTO import_runs (trigger, started_at, status) VALUES (?1, ?2, 'running') RETURNING id").bind(trigger, nowIso),
  );
  const runId = run!.id;

  let status: RunSummary["status"] = "failed";
  let errorSummary: string | null = null;
  let locked = false;
  const accounts: AccountSummary[] = [];

  try {
    if (!(await claimLock(db, runId, now))) {
      status = "skipped_locked";
    } else {
      locked = true;
      const n = Number(env.BACKFILL_DAYS);
      const ctx: Ctx = {
        db, client, runId, now, nowIso,
        today: londonToday(now),
        backfillDays: Number.isInteger(n) && n > 0 ? n : DEFAULT_BACKFILL_DAYS,
      };
      accounts.push(...(await importAll(ctx)));
      const ok = accounts.filter((a) => a.status === "success").length;
      status = ok === accounts.length ? "success" : ok === 0 ? "failed" : "partial";
    }
  } catch (e) {
    status = "failed";
    errorSummary = errorText(e);
  } finally {
    // Its own budget: closing the run must work even if the run itself overspent.
    const closing = new CountingDb(env.DB, 3);
    if (locked) await releaseLock(closing, runId);
    await closing.run(
      closing
        .prepare("UPDATE import_runs SET finished_at = ?2, status = ?3, error_summary = ?4 WHERE id = ?1")
        .bind(runId, new Date(now.getTime() + (Date.now() - started)).toISOString(), status, errorSummary),
    );
  }

  const summary: RunSummary = { runId, status, errorSummary, accounts, statements: db.statements + 2, subrequests: client.subrequests };
  console.log(
    JSON.stringify({
      event: "import_run", runId, trigger, status, error: errorSummary, accounts: accounts.length,
      statements: summary.statements, subrequests: summary.subrequests, durationMs: Date.now() - started,
    }),
  );
  return summary;
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
  const providerId = provider.id;

  // Learned this run, kept so a failure after the balance call still records the currency.
  let currency = row.currency;
  let balanceMinor: number | null = null;
  const summary: AccountSummary = {
    accountId: row.id, status: "failed", fetched: 0, inserted: 0, updated: 0, vanishedMarked: 0,
    missingPosted: 0, httpStatus: null, error: null, durationMs: 0,
  };
  let range: Window | null = null;

  try {
    try {
      const balance = await client.balance(providerId);
      currency ??= balance.currency;
      balanceMinor = toMinor(balance.amount, balance.currency).minor;
    } catch (e) {
      // The balance is only for display. Without a currency, though, we can't import.
      if (currency === null) throw e;
    }
    const label = accountLabel(provider, currency);

    if (row.currency === null && currency !== BUDGET_CURRENCY) {
      await db.run(disableForeignAccount(db, { accountId: row.id, now: nowIso, currency: currency!, label, balanceMinor }));
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
    const byId = new Map<string, TransactionRow>();
    for (const w of windows) {
      const fetched = await client.transactions(providerId, w);
      summary.fetched += fetched.length;
      for (const t of fetched) {
        const normalised = normalizeTransaction(t, row.id, currency!);
        byId.set(normalised.provider_txn_id, normalised);
      }
    }
    const rows = [...byId.values()];
    const ids = [...byId.keys()];

    const upserts = upsertTransactions(db, row.id, runId, nowIso, rows);
    const bumps = bumpLastSeen(db, row.id, nowIso, ids);
    const results = await db.batch([
      countMissingPosted(db, row.id, range, ids),
      ...upserts,
      ...bumps,
      markVanished(db, row.id, nowIso, range, ids),
      updateAccountStatus(db, {
        accountId: row.id, now: nowIso, ok: true, error: null, currency, enabled: currency === BUDGET_CURRENCY,
        label, balanceMinor,
        backfillCursor: backfill?.nextCursor ?? null,
        backfillComplete: backfill ? backfill.complete : null,
      }),
    ]);

    summary.missingPosted = (results[0]!.results[0] as { n: number }).n;
    for (const r of results.slice(1, 1 + upserts.length)) {
      const inserted = (r.results as { inserted: number }[]).filter((x) => x.inserted === 1).length;
      summary.inserted += inserted;
      summary.updated += r.results.length - inserted;
    }
    summary.vanishedMarked = results[1 + upserts.length + bumps.length]!.meta.changes;
    summary.status = "success";
    summary.httpStatus = 200;
  } catch (e) {
    summary.error = errorText(e);
    summary.httpStatus = e instanceof ImportError ? e.httpStatus : null;
    await db.run(
      updateAccountStatus(db, {
        accountId: row.id, now: nowIso, ok: false, error: summary.error, currency, enabled: currency === BUDGET_CURRENCY,
        label: accountLabel(provider, currency), balanceMinor, backfillCursor: null, backfillComplete: null,
      }),
    );
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
