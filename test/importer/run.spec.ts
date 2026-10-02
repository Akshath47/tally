import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImport } from "../../src/worker/importer/run";
import { resetDb } from "../db";
import { txn, world, type WorldAccount } from "../fixtures/lunchflow";

// All data is synthetic. "Today" is 2026-10-02 in London, so the incremental window is
// 2026-09-19..2026-10-02.

const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const REVOLUT: WorldAccount = { id: 1, name: "GB29NWBK60161331926819", institution: "Revolut", currency: "GBP" };
const AMEX: WorldAccount = { id: 2, name: "Synthetic Rewards Card", institution: "Test Amex", currency: "GBP" };
const POCKET: WorldAccount = { id: 3, name: "GB00POCK00000000000003", institution: "Revolut", currency: "USD" };

let minute = 0;

type World = ReturnType<typeof world>;

function run(w: World, opts: { trigger?: "cron" | "manual"; backfillDays?: string } = {}) {
  return runImport(
    { DB: env.DB, LUNCHFLOW_API_KEY: "test-key", BACKFILL_DAYS: opts.backfillDays ?? "20" },
    opts.trigger ?? "manual",
    { fetch: w.fetch, now: () => new Date(T0 + minute++ * 60_000), sleep: async () => {} },
  );
}

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

  it("bumps last_seen_at on every run without counting it as an update", async () => {
    const w = basicWorld();
    await run(w);
    const before = await env.DB.prepare("SELECT last_seen_at, updated_at FROM transactions WHERE provider_txn_id = 'r1'").first<{
      last_seen_at: string;
      updated_at: string;
    }>();
    const second = await run(w);
    const after = await env.DB.prepare("SELECT last_seen_at, updated_at FROM transactions WHERE provider_txn_id = 'r1'").first<{
      last_seen_at: string;
      updated_at: string;
    }>();
    expect(second.accounts[0]).toMatchObject({ inserted: 0, updated: 0 });
    expect(after!.last_seen_at > before!.last_seen_at).toBe(true);
    expect(after!.updated_at).toBe(before!.updated_at);
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

  it("marks a pending transaction that vanished, keeps the row, and clears it if it reappears", async () => {
    const w = basicWorld();
    const pending = txn(2, "pend", { amount: -9.99, date: "2026-09-30", isPending: true });
    w.txns[2] = [...w.txns[2]!, pending];
    await run(w);

    // Pending → posted arrives under a new id with the booking date.
    w.txns[2] = [w.txns[2]![0]!, txn(2, "posted-hex", { amount: -9.99, date: "2026-10-01" })];
    const second = await run(w);
    expect(second.accounts[1]).toMatchObject({ inserted: 1, vanishedMarked: 1 });
    const gone = await env.DB.prepare("SELECT vanished_at, is_pending FROM transactions WHERE provider_txn_id = 'pend'").first<{
      vanished_at: string | null;
      is_pending: number;
    }>();
    expect(gone!.vanished_at).not.toBeNull();
    expect(gone!.is_pending).toBe(1);

    // Already-marked rows aren't counted again.
    expect((await run(w)).accounts[1]!.vanishedMarked).toBe(0);

    w.txns[2] = [...w.txns[2]!, pending];
    const back = await run(w);
    expect(back.accounts[1]).toMatchObject({ inserted: 0, updated: 1 });
    expect(await count("SELECT 1 FROM transactions WHERE provider_txn_id = 'pend' AND vanished_at IS NULL")).toBe(1);
  });

  it("never marks a posted transaction as vanished", async () => {
    const w = basicWorld();
    await run(w);
    w.txns[1] = [];
    await run(w);
    expect(await count("SELECT 1 FROM transactions WHERE vanished_at IS NOT NULL")).toBe(0);
  });

  it("does not mark pending transactions dated outside the fetched window", async () => {
    const w = basicWorld();
    await run(w);
    // Dated beyond the 20-day backfill floor (2026-09-12), so no fetched window covers it.
    await env.DB.prepare(
      `INSERT INTO transactions (account_id, provider_txn_id, amount_minor, provider_amount, currency, txn_date, merchant, description, is_pending, fingerprint, first_seen_at, last_seen_at, updated_at, first_import_run_id)
       VALUES (1, 'ancient-pend', -100, '-1', 'GBP', '2026-01-01', 'x', '', 1, 'fp', 'x', 'x', 'x', 1)`,
    ).run();
    await run(w);
    expect(await count("SELECT 1 FROM transactions WHERE provider_txn_id = 'ancient-pend' AND vanished_at IS NULL")).toBe(1);
  });
});

describe("runImport: locking and failures", () => {
  it("a run started while another holds the lease is skipped_locked and calls nothing", async () => {
    const w = basicWorld();
    await env.DB.prepare(
      "INSERT INTO import_runs (trigger, started_at, status) VALUES ('cron', '2026-10-02T12:00:00.000Z', 'running')",
    ).run();
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
    w.txns[1] = [txn(1, "a", { date: "2026-10-01" }), txn(1, "b", { date: "2026-08-01" })];
    w.txns[2] = [txn(2, "c", { date: "2026-09-25" })];
    const res = await run(w, { backfillDays: "730" });
    expect(res.status).toBe("success");
    expect(res.statements).toBeLessThan(40);
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
