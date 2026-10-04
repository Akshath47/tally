import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountingDb } from "../../src/worker/importer/db";
import { claimLock } from "../../src/worker/importer/lock";
import { startImport } from "../../src/worker/importer/run";
import { insertRun, resetDb } from "../db";
import { AMEX, REVOLUT, accountJson, txn, world, type WorldAccount } from "../fixtures/lunchflow";

// All data is synthetic. "Today" is 2026-10-02 in London, so the incremental window is
// 2026-09-19..2026-10-02.

const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const POCKET: WorldAccount = { id: 3, name: "GB00POCK00000000000003", institution: "Revolut", currency: "USD" };
// Lunch Flow's id for a bank connection made after Tally's first import, e.g. a reconnect.
const LATER: WorldAccount = { id: 4, name: "Synthetic Reconnected Card", institution: "Test Amex", currency: "GBP" };

let minute = 0;

type World = ReturnType<typeof world>;

type RunOpts = { trigger?: "cron" | "manual"; backfillDays?: string; budgetMs?: number };

function start(w: World, opts: RunOpts = {}) {
  return startImport(
    { DB: env.DB, LUNCHFLOW_API_KEY: "test-key", BACKFILL_DAYS: opts.backfillDays ?? "20" },
    opts.trigger ?? "manual",
    { fetch: w.fetch, now: () => new Date(T0 + minute++ * 60_000), sleep: async () => {}, budgetMs: opts.budgetMs },
  );
}

const run = async (w: World, opts: RunOpts = {}) => (await start(w, opts)).finished;

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM (${sql})`).bind(...binds).first<{ n: number }>())!.n;

const rows = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).all();

beforeEach(async () => {
  await resetDb();
  minute = 0;
});

afterEach(() => vi.restoreAllMocks());

function basicWorld() {
  const w = world([REVOLUT, AMEX]);
  w.txns[1] = [
    txn(1, "r1", { amount: -12.3, date: "2026-10-01" }),
    txn(1, "r2", { amount: -0.01, date: "2026-09-30" }),
    txn(1, "r3", { amount: 1234.56, date: "2026-09-25" }),
  ];
  w.txns[2] = [txn(2, "a1", { amount: -50, date: "2026-10-01", description: "Synthetic purchase" })];
  return w;
}

describe("runImport: idempotency", () => {
  it("imports both accounts, then a second identical run inserts and updates nothing", async () => {
    const w = basicWorld();
    const first = await run(w);
    expect(first.status).toBe("success");
    expect(first.accounts.map((a) => [a.accountId, a.inserted, a.updated])).toEqual([
      [1, 3, 0],
      [2, 1, 0],
    ]);

    const second = await run(w);
    expect(second.status).toBe("success");
    expect(second.accounts.map((a) => [a.inserted, a.updated, a.vanishedMarked])).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(await count("SELECT 1 FROM transactions")).toBe(4);
  });

  it("stores money as integer minor units and keeps the original decimal", async () => {
    await run(basicWorld());
    const r = await rows("SELECT provider_txn_id, amount_minor, provider_amount, txn_date FROM transactions WHERE account_id = 1 ORDER BY provider_txn_id");
    expect(r.results).toEqual([
      { provider_txn_id: "r1", amount_minor: -1230, provider_amount: "-12.3", txn_date: "2026-10-01" },
      { provider_txn_id: "r2", amount_minor: -1, provider_amount: "-0.01", txn_date: "2026-09-30" },
      { provider_txn_id: "r3", amount_minor: 123456, provider_amount: "1234.56", txn_date: "2026-09-25" },
    ]);
  });

  it("a changed amount is exactly one update", async () => {
    const w = basicWorld();
    await run(w);
    w.txns[1]![0] = txn(1, "r1", { amount: -13.3, date: "2026-10-01" });
    const second = await run(w);
    expect(second.accounts[0]).toMatchObject({ inserted: 0, updated: 1 });
    const row = await env.DB.prepare("SELECT amount_minor FROM transactions WHERE provider_txn_id = 'r1'").first();
    expect(row).toEqual({ amount_minor: -1330 });
  });

  it("leaves an unchanged row completely untouched", async () => {
    const w = basicWorld();
    await run(w);
    const read = () => env.DB.prepare("SELECT * FROM transactions WHERE provider_txn_id = 'r1'").first();
    const before = await read();
    await run(w);
    expect(await read()).toEqual(before);
  });

  it("moves last_seen_at only when the row changes, and never first_seen_at", async () => {
    const w = basicWorld();
    const first = await run(w);
    const read = () =>
      env.DB.prepare("SELECT first_seen_at, last_seen_at, first_import_run_id FROM transactions WHERE provider_txn_id = 'r1'").first<{
        first_seen_at: string;
        last_seen_at: string;
        first_import_run_id: number;
      }>();
    const inserted = (await read())!;
    expect(inserted.last_seen_at).toBe(inserted.first_seen_at);

    w.txns[1]![0] = txn(1, "r1", { amount: -13.3, date: "2026-10-01" });
    await run(w);
    const changed = (await read())!;
    expect(changed.first_seen_at).toBe(inserted.first_seen_at);
    expect(changed.last_seen_at > inserted.last_seen_at).toBe(true);
    expect(changed.first_import_run_id).toBe(first.runId);
  });
});

describe("runImport: nothing is ever deleted", () => {
  it("a partial response deletes nothing", async () => {
    const w = basicWorld();
    await run(w);
    w.txns[1] = [w.txns[1]![0]!];
    const second = await run(w);
    expect(second.status).toBe("success");
    expect(await count("SELECT 1 FROM transactions WHERE account_id = 1")).toBe(3);
  });

  it("logs, but does not act on, posted transactions that went missing", async () => {
    const w = basicWorld();
    await run(w);
    w.txns[1] = [w.txns[1]![0]!];
    const log = vi.spyOn(console, "log");
    await run(w);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"import_account"'));
    expect(lines.some((l) => l.includes('"missingPosted":2'))).toBe(true);
    expect(await count("SELECT 1 FROM transactions WHERE vanished_at IS NOT NULL")).toBe(0);
  });

  it("never marks a posted transaction as vanished", async () => {
    const w = basicWorld();
    await run(w);
    w.txns[1] = [];
    await run(w);
    expect(await count("SELECT 1 FROM transactions WHERE vanished_at IS NOT NULL")).toBe(0);
  });
});

const pendingRow = (id: string) =>
  env.DB.prepare("SELECT id, vanished_at, superseded_by FROM transactions WHERE provider_txn_id = ?1").bind(id).first<{
    id: number;
    vanished_at: string | null;
    superseded_by: number | null;
  }>();

describe("runImport: pending transactions", () => {
  const DAY_MINUTES = 24 * 60;

  function pendingWorld() {
    const w = basicWorld();
    w.txns[2] = [...w.txns[2]!, txn(2, "pend", { amount: -9.99, date: "2026-09-30", isPending: true })];
    return w;
  }

  it("keeps counting a pending transaction the provider stops returning", async () => {
    const w = pendingWorld();
    await run(w);
    w.txns[2] = [w.txns[2]![0]!];
    expect((await run(w)).accounts[1]).toMatchObject({ vanishedMarked: 0 });
    expect(await pendingRow("pend")).toMatchObject({ vanished_at: null, superseded_by: null });
  });

  it("retires a pending transaction when a same-amount posted one arrives, and links them", async () => {
    const w = pendingWorld();
    await run(w);
    // The posted version has a new id and the booking date; the pending one is gone.
    w.txns[2] = [w.txns[2]![0]!, txn(2, "posted-hex", { amount: -9.99, date: "2026-10-01" })];
    expect((await run(w)).accounts[1]).toMatchObject({ inserted: 1, vanishedMarked: 1 });
    const postedId = (await pendingRow("posted-hex"))!.id;
    const pend = await pendingRow("pend");
    expect(pend!.superseded_by).toBe(postedId);
    expect(pend!.vanished_at).not.toBeNull();

    // Already-retired rows aren't counted again.
    expect((await run(w)).accounts[1]!.vanishedMarked).toBe(0);
  });

  it("does not supersede a pending transaction the provider still returns", async () => {
    const w = pendingWorld();
    await run(w);
    // Still pending at the bank, next to an unrelated posted charge of the same amount.
    w.txns[2] = [...w.txns[2]!, txn(2, "other-hex", { amount: -9.99, date: "2026-10-01" })];
    expect((await run(w)).accounts[1]).toMatchObject({ inserted: 1, vanishedMarked: 0 });
    expect(await pendingRow("pend")).toMatchObject({ vanished_at: null, superseded_by: null });
  });

  it("revives a superseded pending transaction the provider returns again, and frees its posted match", async () => {
    const w = pendingWorld();
    await run(w);
    const pend = w.txns[2]![1]!;
    w.txns[2] = [w.txns[2]![0]!, txn(2, "posted-hex", { amount: -9.99, date: "2026-10-01" })];
    await run(w);

    w.txns[2] = [...w.txns[2]!, pend];
    expect((await run(w)).accounts[1]).toMatchObject({ updated: 1, vanishedMarked: 0 });
    expect(await pendingRow("pend")).toMatchObject({ vanished_at: null, superseded_by: null });

    // Gone again: the freed posted row supersedes it again.
    w.txns[2] = [w.txns[2]![0]!, w.txns[2]![1]!];
    expect((await run(w)).accounts[1]).toMatchObject({ vanishedMarked: 1 });
    expect((await pendingRow("pend"))!.superseded_by).toBe((await pendingRow("posted-hex"))!.id);
  });

  it("records a run that only retires pending rows as a data change", async () => {
    const w = pendingWorld();
    await run(w);
    w.txns[2] = [w.txns[2]![0]!];
    minute += 8 * DAY_MINUTES;
    expect((await run(w)).accounts[1]).toMatchObject({ inserted: 0, updated: 0, vanishedMarked: 1 });
    const account = await env.DB.prepare("SELECT last_data_change_at FROM accounts WHERE id = 2").first<{ last_data_change_at: string }>();
    expect(account!.last_data_change_at).toBe((await pendingRow("pend"))!.vanished_at);
  });

  it("expires a pending transaction dated outside the fetched windows 7 days after first seen", async () => {
    const w = pendingWorld();
    // Dated before the incremental window: Lunch Flow can't return it, so it would otherwise count forever.
    w.txns[2] = [w.txns[2]![0]!, txn(2, "pend", { amount: -9.99, date: "2026-09-10", isPending: true })];
    await run(w, { backfillDays: "30" });
    minute += 8 * DAY_MINUTES;
    expect((await run(w, { backfillDays: "30" })).accounts[1]).toMatchObject({ vanishedMarked: 1 });
  });

  it("keeps it counted next to a different-amount posted one until it expires 7 days after first seen", async () => {
    const w = pendingWorld();
    await run(w);
    w.txns[2] = [w.txns[2]![0]!, txn(2, "posted-hex", { amount: -10.5, date: "2026-10-01" })];
    expect((await run(w)).accounts[1]).toMatchObject({ vanishedMarked: 0 });
    expect(await pendingRow("pend")).toMatchObject({ vanished_at: null });

    minute += 6 * DAY_MINUTES;
    expect((await run(w)).accounts[1]).toMatchObject({ vanishedMarked: 0 });

    minute += 2 * DAY_MINUTES;
    expect((await run(w)).accounts[1]).toMatchObject({ vanishedMarked: 1 });
    expect(await pendingRow("pend")).toMatchObject({ superseded_by: null });
    expect((await pendingRow("pend"))!.vanished_at).not.toBeNull();
  });

  it("does not expire a pending transaction the provider still returns, and revives an expired one that comes back", async () => {
    const w = pendingWorld();
    await run(w);
    minute += 8 * DAY_MINUTES;
    expect((await run(w)).accounts[1]).toMatchObject({ vanishedMarked: 0 });

    const pend = w.txns[2]![1]!;
    w.txns[2] = [w.txns[2]![0]!];
    expect((await run(w)).accounts[1]).toMatchObject({ vanishedMarked: 1 });

    w.txns[2] = [...w.txns[2]!, pend];
    expect((await run(w)).accounts[1]).toMatchObject({ updated: 1, vanishedMarked: 0 });
    expect(await pendingRow("pend")).toMatchObject({ vanished_at: null });
  });
});

describe("runImport: pending transactions without an id", () => {
  it("imports one, keeps re-imports idempotent, and retires it when the posted version arrives", async () => {
    const w = basicWorld();
    const noId = txn(2, null, { amount: -9.99, date: "2026-10-01", isPending: true, merchant: "Synthetic Shop" });
    w.txns[2] = [...w.txns[2]!, noId];
    expect((await run(w)).accounts[1]).toMatchObject({ inserted: 2, updated: 0 });
    expect(await count("SELECT 1 FROM transactions WHERE provider_txn_id LIKE 'nullid:%'")).toBe(1);

    expect((await run(w)).accounts[1]).toMatchObject({ inserted: 0, updated: 0 });

    w.txns[2] = [w.txns[2]![0]!, txn(2, "posted-hex", { amount: -9.99, date: "2026-10-02", merchant: "Synthetic Shop" })];
    expect((await run(w)).accounts[1]).toMatchObject({ inserted: 1, vanishedMarked: 1 });
    expect(await count("SELECT 1 FROM transactions WHERE provider_txn_id LIKE 'nullid:%' AND vanished_at IS NOT NULL")).toBe(1);
  });
});

describe("runImport: locking and failures", () => {
  it("a run started while another holds the lease is skipped_locked and calls nothing", async () => {
    const w = basicWorld();
    await insertRun("cron");
    await env.DB.prepare("UPDATE import_lock SET holder_run_id = 1, expires_at = '2026-10-02T12:30:00.000Z' WHERE id = 1").run();

    const res = await run(w);
    expect(res.status).toBe("skipped_locked");
    expect(w.calls).toHaveLength(0);
    const holder = await env.DB.prepare("SELECT holder_run_id FROM import_lock").first();
    expect(holder).toEqual({ holder_run_id: 1 });
  });

  it("releases the lease after a run, so the next one proceeds", async () => {
    const w = basicWorld();
    await run(w);
    expect(await env.DB.prepare("SELECT holder_run_id FROM import_lock").first()).toEqual({ holder_run_id: null });
    expect((await run(w)).status).toBe("success");
  });

  it("takes over an expired lease and marks the cut-off run that held it as abandoned", async () => {
    // A manual import cancelled mid-run (e.g. past the 30 s waitUntil limit) never reached its finally.
    const started = new Date(T0 - 20 * 60_000);
    const dead = await insertRun("manual", "running", started.toISOString());
    await claimLock(new CountingDb(env.DB), dead, started);

    expect((await run(basicWorld())).status).toBe("success");
    const row = await env.DB.prepare("SELECT status, error_summary, finished_at FROM import_runs WHERE id = ?1").bind(dead).first();
    expect(row).toEqual({ status: "failed", error_summary: "abandoned", finished_at: "2026-10-02T12:00:00.000Z" });
  });

  it("leaves a recently started run alone, since it may still be about to claim", async () => {
    const fresh = await insertRun("manual", "running", new Date(T0 - 5_000).toISOString());
    expect((await run(basicWorld())).status).toBe("success");
    expect(await env.DB.prepare("SELECT status FROM import_runs WHERE id = ?1").bind(fresh).first()).toEqual({ status: "running" });
  });

  it("ends a run that exceeds its time budget as failed/timeout and releases the lease", async () => {
    const w = basicWorld();
    const res = await run(w, { budgetMs: 0 });
    expect(res).toMatchObject({ status: "failed", errorSummary: "timeout" });
    expect(w.calls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT holder_run_id FROM import_lock").first()).toEqual({ holder_run_id: null });
  });

  it("holds a lease sized to its budget, so a cut-off run frees the lock within a minute", async () => {
    const started = await start(basicWorld(), { budgetMs: 25_000 });
    const lock = await env.DB.prepare("SELECT holder_run_id, expires_at FROM import_lock").first();
    expect(lock).toEqual({ holder_run_id: started.runId, expires_at: "2026-10-02T12:00:55.000Z" });
    await started.finished;
  });

  it("a 5xx on one account retries, records the error, keeps its rows, and does not stop the other", async () => {
    const w = basicWorld();
    await run(w);
    w.txns[2] = [...w.txns[2]!, txn(2, "a2", { date: "2026-10-02" })];
    w.txnReply[1] = { status: 503, body: {} };

    const before = w.calls.length;
    const res = await run(w);
    expect(res.status).toBe("partial");
    expect(res.accounts[0]).toMatchObject({ accountId: 1, status: "failed", error: "server 503" });
    expect(res.accounts[1]).toMatchObject({ accountId: 2, status: "success", inserted: 1 });
    expect(await count("SELECT 1 FROM transactions WHERE account_id = 1")).toBe(3);
    expect(w.calls.slice(before).filter((c) => c.path.endsWith("/1/transactions"))).toHaveLength(3);

    const a = await env.DB.prepare("SELECT last_import_error, consecutive_failures FROM accounts WHERE id = 1").first();
    expect(a).toEqual({ last_import_error: "server 503", consecutive_failures: 1 });
  });

  it("recovers: a later success clears the error and the failure count", async () => {
    const w = basicWorld();
    w.txnReply[1] = { status: 503, body: {} };
    await run(w);
    w.txnReply[1] = undefined;
    await run(w);
    const a = await env.DB.prepare("SELECT last_import_error, consecutive_failures, last_import_success_at FROM accounts WHERE id = 1").first<{
      last_import_error: string | null;
      consecutive_failures: number;
      last_import_success_at: string | null;
    }>();
    expect(a!.last_import_error).toBeNull();
    expect(a!.consecutive_failures).toBe(0);
    expect(a!.last_import_success_at).not.toBeNull();
  });

  it("a 401 does not retry and sets the account's error", async () => {
    const w = basicWorld();
    w.txnReply[1] = { status: 401, body: {} };
    const res = await run(w);
    expect(w.calls.filter((c) => c.path.endsWith("/1/transactions"))).toHaveLength(1);
    expect(res.accounts[0]).toMatchObject({ status: "failed", error: "config 401" });
    const a = await env.DB.prepare("SELECT last_import_error FROM accounts WHERE id = 1").first();
    expect(a).toEqual({ last_import_error: "config 401" });
  });

  it("fails the whole run, with no account or transaction writes, if the accounts call fails", async () => {
    const w = basicWorld();
    w.accountsReply = { status: 403, body: {} };
    const res = await run(w);
    expect(res.status).toBe("failed");
    expect(await count("SELECT 1 FROM accounts")).toBe(0);
    expect(await count("SELECT 1 FROM transactions")).toBe(0);
    const r = await env.DB.prepare("SELECT status, error_summary FROM import_runs").first();
    expect(r).toEqual({ status: "failed", error_summary: "config 403" });
  });

  it("a 3-decimal amount fails that account with no writes for it", async () => {
    const w = basicWorld();
    w.txns[1] = [...w.txns[1]!, txn(1, "bad", { amount: 1.234 })];
    const res = await run(w);
    expect(res.accounts[0]).toMatchObject({ status: "failed", error: "precision" });
    expect(await count("SELECT 1 FROM transactions WHERE account_id = 1")).toBe(0);
    expect(res.accounts[1]).toMatchObject({ status: "success", inserted: 1 });
  });

  it("an invalid response writes nothing for the account", async () => {
    const w = basicWorld();
    w.txnReply[1] = { body: { transactions: [{ id: "x" }], total: 1 } };
    const res = await run(w);
    expect(res.accounts[0]).toMatchObject({ status: "failed", error: "invalid_response 200" });
    expect(await count("SELECT 1 FROM transactions WHERE account_id = 1")).toBe(0);
  });

  it("a failed balance call on a known account is not fatal", async () => {
    const w = basicWorld();
    await run(w);
    w.balanceReply[1] = { status: 503, body: {} };
    const res = await run(w);
    expect(res.accounts[0]!.status).toBe("success");
  });

  it("a failed balance call on a never-imported account fails it, since its currency is unknown", async () => {
    const w = basicWorld();
    w.balanceReply[1] = { status: 503, body: {} };
    const res = await run(w);
    expect(res.accounts[0]).toMatchObject({ status: "failed", error: "server 503" });
    expect(await count("SELECT 1 FROM transactions WHERE account_id = 1")).toBe(0);
  });

  it("records the run, its trigger and per-account results", async () => {
    const w = basicWorld();
    const res = await run(w, { trigger: "cron" });
    const r = await env.DB.prepare("SELECT trigger, status, finished_at FROM import_runs WHERE id = ?").bind(res.runId).first<{
      trigger: string;
      status: string;
      finished_at: string | null;
    }>();
    expect(r).toMatchObject({ trigger: "cron", status: "success" });
    expect(r!.finished_at).not.toBeNull();
    const per = await rows("SELECT account_id, status, fetched, inserted, updated, window_from, window_to FROM import_run_accounts ORDER BY account_id");
    expect(per.results[0]).toMatchObject({ account_id: 1, status: "success", fetched: 3, inserted: 3, updated: 0, window_to: "2026-10-02" });
  });
});

describe("runImport: accounts", () => {
  it("never stores the IBAN as the account name", async () => {
    await run(basicWorld());
    const a = await env.DB.prepare("SELECT name FROM accounts WHERE id = 1").first<{ name: string }>();
    expect(a!.name).toBe("Revolut · GBP · ••6819");
    expect(await count("SELECT 1 FROM accounts WHERE name LIKE '%GB29%'")).toBe(0);
  });

  it("keeps the label stable across runs", async () => {
    const w = basicWorld();
    await run(w);
    await run(w);
    const a = await env.DB.prepare("SELECT name FROM accounts WHERE id = 1").first();
    expect(a).toEqual({ name: "Revolut · GBP · ••6819" });
  });

  it("learns currency and balance from the balance endpoint", async () => {
    await run(basicWorld());
    const a = await env.DB.prepare("SELECT currency, balance_minor, import_enabled FROM accounts WHERE id = 1").first();
    expect(a).toEqual({ currency: "GBP", balance_minor: 10050, import_enabled: 1 });
  });

  it("leaves a non-GBP account disabled and never fetches its transactions", async () => {
    const w = world([REVOLUT, AMEX, POCKET]);
    w.txns[3] = [txn(3, "usd1", { currency: "USD", amount: -21.6, date: "2026-10-01" })];
    const res = await run(w);
    expect(res.accounts.map((a) => a.accountId)).toEqual([1, 2]);
    expect(await env.DB.prepare("SELECT currency, import_enabled FROM accounts WHERE id = 3").first()).toEqual({
      currency: "USD",
      import_enabled: 0,
    });
    expect(w.calls.some((c) => c.path.includes("/3/transactions"))).toBe(false);
    expect(await count("SELECT 1 FROM transactions WHERE account_id = 3")).toBe(0);

    // Once known, a disabled account isn't contacted at all.
    const before = w.calls.length;
    await run(w);
    expect(w.calls.slice(before).some((c) => c.path.includes("/3/"))).toBe(false);
  });

  it("does not re-enable an account the owner switched off", async () => {
    const w = basicWorld();
    await run(w);
    await env.DB.prepare("UPDATE accounts SET import_enabled = 0 WHERE id = 2").run();
    const before = w.calls.length;
    const res = await run(w);
    expect(res.accounts.map((a) => a.accountId)).toEqual([1]);
    expect(w.calls.slice(before).some((c) => c.path.includes("/2/"))).toBe(false);
  });

  it("tracks the newest transaction date and the last data change", async () => {
    const w = basicWorld();
    const first = await run(w);
    const a = await env.DB.prepare("SELECT newest_txn_date, last_data_change_at FROM accounts WHERE id = 1").first<{
      newest_txn_date: string;
      last_data_change_at: string;
    }>();
    expect(a!.newest_txn_date).toBe("2026-10-01");
    const changedAt = a!.last_data_change_at;
    expect(changedAt).not.toBeNull();

    await run(w);
    const b = await env.DB.prepare("SELECT last_data_change_at FROM accounts WHERE id = 1").first();
    expect(b).toEqual({ last_data_change_at: changedAt });
    expect(first.status).toBe("success");
  });
});

describe("runImport: new accounts after the first import", () => {
  /** Lists only `accounts` in the provider's /accounts response, so a later run can add one. */
  const listOnly = (w: World, accounts: WorldAccount[]) => {
    w.accountsReply = {
      body: { accounts: accounts.map((a) => accountJson(a.id, { name: a.name, institution_name: a.institution })), total: accounts.length },
    };
  };
  const account = (id: number) =>
    env.DB.prepare("SELECT currency, needs_review, import_enabled FROM accounts WHERE provider_account_id = ?1").bind(String(id)).first();
  const fetchedTxns = (w: World, id: number, since = 0) => w.calls.slice(since).some((c) => c.path.endsWith(`/accounts/${id}/transactions`));

  function laterWorld(extra: WorldAccount = LATER) {
    const w = world([REVOLUT, AMEX, extra]);
    w.txns[1] = [txn(1, "r1", { date: "2026-10-01" })];
    w.txns[2] = [txn(2, "a1", { date: "2026-10-01" })];
    w.txns[extra.id] = [txn(extra.id, "n1", { date: "2026-10-01", currency: extra.currency })];
    return w;
  }

  it("holds a GBP account that appears later for review instead of importing it", async () => {
    const w = laterWorld();
    listOnly(w, [REVOLUT, AMEX]);
    await run(w);
    w.accountsReply = undefined;

    const before = w.calls.length;
    const res = await run(w);
    expect(res.status).toBe("success");
    expect(res.accounts.map((a) => a.accountId)).toEqual([1, 2]);
    expect(await account(4)).toEqual({ currency: "GBP", needs_review: 1, import_enabled: 0 });
    expect(fetchedTxns(w, 4, before)).toBe(false);
    expect(await count("SELECT 1 FROM transactions WHERE provider_txn_id = 'n1'")).toBe(0);
    expect(await count("SELECT 1 FROM import_run_accounts r JOIN accounts a ON a.id = r.account_id WHERE a.provider_account_id = '4'")).toBe(0);

    // It stays held on later runs, and isn't contacted at all once its currency is known.
    const again = w.calls.length;
    await run(w);
    expect(w.calls.slice(again).some((c) => c.path.includes("/accounts/4/"))).toBe(false);
  });

  it("retries a held account's failed balance call without importing it", async () => {
    const w = laterWorld();
    listOnly(w, [REVOLUT, AMEX]);
    await run(w);
    w.accountsReply = undefined;

    w.balanceReply[4] = { status: 503, body: {} };
    await run(w);
    expect(await account(4)).toEqual({ currency: null, needs_review: 1, import_enabled: 0 });

    w.balanceReply[4] = undefined;
    await run(w);
    expect(await account(4)).toEqual({ currency: "GBP", needs_review: 1, import_enabled: 0 });
    expect(fetchedTxns(w, 4)).toBe(false);
  });

  it("disables a non-GBP account that appears later without asking for review", async () => {
    const w = laterWorld(POCKET);
    listOnly(w, [REVOLUT, AMEX]);
    await run(w);
    w.accountsReply = undefined;

    await run(w);
    expect(await account(3)).toEqual({ currency: "USD", needs_review: 0, import_enabled: 0 });
  });

  it("still enables a first-import account whose currency was only learned on a later run", async () => {
    const w = basicWorld();
    w.balanceReply[2] = { status: 503, body: {} };
    await run(w);
    w.balanceReply[2] = undefined;

    const res = await run(w);
    expect(await account(2)).toEqual({ currency: "GBP", needs_review: 0, import_enabled: 1 });
    expect(res.accounts.find((a) => a.accountId === 2)).toMatchObject({ status: "success", inserted: 1 });
  });

  it("stops an account's backfill at its floor date", async () => {
    const w = world([REVOLUT]);
    w.txns[1] = [txn(1, "recent", { date: "2026-10-01" }), txn(1, "catch-up", { date: "2026-09-05" }), txn(1, "old", { date: "2026-08-20" })];
    await env.DB.prepare(
      `INSERT INTO accounts (provider, provider_account_id, name, currency, provider_status, import_enabled, backfill_floor_date, created_at, updated_at)
       VALUES ('lunchflow', '1', 'Revolut · GBP · ••6819', 'GBP', 'ACTIVE', 1, '2026-09-01', ?1, ?1)`,
    )
      .bind("2026-10-01T00:00:00.000Z")
      .run();

    await run(w, { backfillDays: "730" });
    const windows = w.calls.filter((c) => c.path.endsWith("/transactions")).map((c) => c.query.get("from"));
    expect(windows.every((from) => from! >= "2026-09-01")).toBe(true);
    expect(await count("SELECT 1 FROM transactions WHERE provider_txn_id IN ('recent', 'catch-up')")).toBe(2);
    expect(await count("SELECT 1 FROM transactions WHERE provider_txn_id = 'old'")).toBe(0);
    expect(await env.DB.prepare("SELECT backfill_complete FROM accounts").first()).toEqual({ backfill_complete: 1 });
  });
});

describe("runImport: backfill", () => {
  it("walks back two 31-day chunks per run, imports history, and completes at the floor", async () => {
    const w = world([REVOLUT]);
    // BACKFILL_DAYS=100 → floor 2026-06-24. Run 1 covers 07-19..10-02, run 2 reaches the floor.
    w.txns[1] = [
      txn(1, "recent", { date: "2026-10-01" }),
      txn(1, "mid", { date: "2026-08-10" }),
      txn(1, "older", { date: "2026-07-25" }),
      txn(1, "floor", { date: "2026-06-30" }),
      txn(1, "too-old", { date: "2026-06-01" }),
    ];
    const first = await run(w, { backfillDays: "100" });
    expect(first.accounts[0]!.inserted).toBe(3);
    expect(await env.DB.prepare("SELECT backfill_cursor_date, backfill_complete FROM accounts").first()).toEqual({
      backfill_cursor_date: "2026-07-19",
      backfill_complete: 0,
    });

    const second = await run(w, { backfillDays: "100" });
    expect(second.accounts[0]!.inserted).toBe(1);
    expect(await env.DB.prepare("SELECT backfill_cursor_date, backfill_complete FROM accounts").first()).toEqual({
      backfill_cursor_date: "2026-06-24",
      backfill_complete: 1,
    });
    expect(await count("SELECT 1 FROM transactions WHERE provider_txn_id = 'too-old'")).toBe(0);

    // Once complete, only the incremental window is fetched.
    const before = w.calls.length;
    await run(w, { backfillDays: "100" });
    expect(w.calls.slice(before).filter((c) => c.path.endsWith("/transactions"))).toHaveLength(1);
  });

  it("treats only the windows it fetched as covered: rows in the already-backfilled gap are left alone", async () => {
    const w = world([REVOLUT]);
    // Run 1 covers 07-19..10-02. On run 2 the fetched windows are the incremental one
    // (09-19..10-02) and older chunks, leaving 07-19..09-18 unfetched.
    w.txns[1] = [
      txn(1, "gap-pending", { amount: -5, date: "2026-08-10", isPending: true }),
      txn(1, "gap-posted", { date: "2026-08-11" }),
      txn(1, "recent", { date: "2026-10-01" }),
    ];
    await run(w, { backfillDays: "100" });

    const second = await run(w, { backfillDays: "100" });
    expect(second.accounts[0]).toMatchObject({ vanishedMarked: 0, missingPosted: 0 });
    expect(await count("SELECT 1 FROM transactions WHERE vanished_at IS NOT NULL")).toBe(0);
  });

  it("only advances the backfill cursor when the account's writes succeed", async () => {
    const w = world([REVOLUT]);
    w.txns[1] = [txn(1, "x", { date: "2026-10-01" })];
    w.txnReply[1] = { status: 503, body: {} };
    await run(w, { backfillDays: "100" });
    expect(await env.DB.prepare("SELECT backfill_cursor_date FROM accounts").first()).toEqual({ backfill_cursor_date: null });
  });
});

describe("runImport: budgets", () => {
  it("stays under 40 D1 statements and the subrequest cap on a first backfill run with three accounts", async () => {
    const w = world([REVOLUT, AMEX, POCKET]);
    w.txns[1] = [txn(1, "a", { date: "2026-10-01" }), txn(1, "b", { date: "2026-08-01" }), txn(1, null, { amount: -1, date: "2026-09-30", isPending: true })];
    w.txns[2] = [txn(2, "c", { date: "2026-09-25" }), txn(2, null, { amount: -2, date: "2026-09-30", isPending: true })];
    const res = await run(w, { backfillDays: "730" });
    expect(res.status).toBe("success");
    expect(res.statements).toBeLessThan(40);

    // Still backfilling, and both pending rows are superseded, so each account also writes the retire statements.
    w.txns[1] = [...w.txns[1]!.slice(0, 2), txn(1, "a2", { amount: -1, date: "2026-10-01" })];
    w.txns[2] = [w.txns[2]![0]!, txn(2, "c2", { amount: -2, date: "2026-10-01" })];
    const second = await run(w, { backfillDays: "730" });
    expect(second.accounts.map((a) => a.vanishedMarked)).toEqual([1, 1]);
    expect(second.statements).toBeLessThan(40);
    expect(res.subrequests).toBeLessThanOrEqual(20);
  });

  it("logs counts, statuses and durations only", async () => {
    const w = basicWorld();
    const log = vi.spyOn(console, "log");
    await run(w);
    const text = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain('"import_run"');
    for (const secret of ["test-key", "Synthetic Cafe", "GB29NWBK", "Synthetic purchase"]) {
      expect(text).not.toContain(secret);
    }
  });
});
