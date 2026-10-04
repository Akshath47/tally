import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { IMPORT_RUN_STATUSES } from "../src/worker/db/schema";
import { insertAccount, insertRun, insertTransaction, NOW, resetDb } from "./db";

// Exercises the migrated D1 schema with raw SQL, so these hold whatever writes to it.
// All values are synthetic.

describe("schema", () => {
  let accountId: number;
  let runId: number;

  beforeEach(async () => {
    // Storage persists across tests in a file, so each test starts from freshly migrated tables.
    await resetDb();
    accountId = await insertAccount();
    runId = await insertRun();
  });

  it("stores a transaction with an integer amount and its date unchanged", async () => {
    await insertTransaction(accountId, runId, "t1");
    const row = await env.DB.prepare("SELECT amount_minor, txn_date, typeof(amount_minor) AS t FROM transactions").first();
    expect(row).toEqual({ amount_minor: -1230, txn_date: "2026-10-01", t: "integer" });
  });

  it("rejects a second row with the same provider transaction id in the same account", async () => {
    await insertTransaction(accountId, runId, "dup");
    await expect(insertTransaction(accountId, runId, "dup")).rejects.toThrow(/UNIQUE/);
  });

  it("allows the same provider transaction id in different accounts", async () => {
    const other = await insertAccount({ providerAccountId: "1002" });
    await insertTransaction(accountId, runId, "same");
    await expect(insertTransaction(other, runId, "same")).resolves.toBeDefined();
  });

  it("rejects a transaction for an unknown account", async () => {
    await expect(insertTransaction(9999, runId, "orphan")).rejects.toThrow(/FOREIGN KEY/);
  });

  it.each(["2026-10-01T23:30:00Z", "01/10/2026", "2026-1-1", "2026-13-45", "2026-02-30", "0000-00-00"])(
    "rejects txn_date %s that isn't a real YYYY-MM-DD date",
    async (txnDate) => {
      await expect(insertTransaction(accountId, runId, "bad-date", { txnDate })).rejects.toThrow(/CHECK/);
    },
  );

  it.each([-1230.0000000000002, "-12.30"])("rejects a non-integer amount_minor %s", async (amountMinor) => {
    await expect(insertTransaction(accountId, runId, "bad-amount", { amountMinor })).rejects.toThrow(/CHECK/);
  });

  it.each([2, "false", "true"])("rejects is_pending %s that isn't 0 or 1", async (isPending) => {
    await expect(insertTransaction(accountId, runId, "bad-bool", { isPending })).rejects.toThrow(/CHECK/);
  });

  it("rejects a provider other than lunchflow", async () => {
    await expect(insertAccount({ providerAccountId: "2001", provider: "LunchFlow" })).rejects.toThrow(/CHECK/);
  });

  it("records an account before its currency is known", async () => {
    await expect(insertAccount({ providerAccountId: "2002", currency: null })).resolves.toBeTypeOf("number");
  });

  it("rejects a duplicate provider account", async () => {
    await expect(insertAccount({ providerAccountId: "1001" })).rejects.toThrow(/UNIQUE/);
  });

  it("starts an account out of review, unmerged and with no backfill floor", async () => {
    const row = await env.DB.prepare("SELECT needs_review, merged_into_account_id, backfill_floor_date FROM accounts WHERE id = ?1")
      .bind(accountId)
      .first();
    expect(row).toEqual({ needs_review: 0, merged_into_account_id: null, backfill_floor_date: null });
  });

  const setAccount = (column: string, value: unknown) =>
    env.DB.prepare(`UPDATE accounts SET ${column} = ?1 WHERE id = ?2`).bind(value, accountId).run();

  it.each([2, "true"])("rejects needs_review %s that isn't 0 or 1", async (value) => {
    await expect(setAccount("needs_review", value)).rejects.toThrow(/CHECK/);
  });

  it.each(["2026-02-30", "2026-9-1"])("rejects backfill_floor_date %s that isn't a real date", async (value) => {
    await expect(setAccount("backfill_floor_date", value)).rejects.toThrow(/CHECK/);
  });

  it("rejects merging into an unknown account", async () => {
    await expect(setAccount("merged_into_account_id", 9999)).rejects.toThrow(/FOREIGN KEY/);
  });

  it("rejects unknown import run triggers and statuses", async () => {
    await expect(insertRun("webhook")).rejects.toThrow(/CHECK/);
    await expect(insertRun("manual", "done")).rejects.toThrow(/CHECK/);
  });

  it("accepts every documented import run status", async () => {
    for (const status of IMPORT_RUN_STATUSES) {
      await expect(insertRun("cron", status)).resolves.toBeTypeOf("number");
    }
  });

  it("records one result per account per run", async () => {
    const insert = () =>
      env.DB.prepare("INSERT INTO import_run_accounts (run_id, account_id, status) VALUES (?1, ?2, 'success')")
        .bind(runId, accountId)
        .run();
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("ships an unheld import_lock row, so the lease can be claimed with a conditional UPDATE", async () => {
    const claim = await env.DB.prepare(
      "UPDATE import_lock SET holder_run_id = ?1, expires_at = ?2 WHERE id = 1 AND holder_run_id IS NULL",
    )
      .bind(runId, NOW)
      .run();
    expect(claim.meta.changes).toBe(1);
  });

  it("keeps import_lock to a single row with id 1", async () => {
    await expect(env.DB.prepare("INSERT INTO import_lock (id) VALUES (2)").run()).rejects.toThrow(/CHECK/);
  });

  it("indexes transactions by account and date, and by fingerprint", async () => {
    const { results } = await env.DB.prepare(
      `SELECT il.name AS idx, group_concat(ii.name, ',') AS cols
       FROM pragma_index_list('transactions') il, pragma_index_info(il.name) ii
       GROUP BY il.name`,
    ).all<{ idx: string; cols: string }>();
    const columnSets = results.map((r) => r.cols);
    expect(columnSets).toEqual(expect.arrayContaining(["account_id,txn_date", "fingerprint", "account_id,provider_txn_id"]));
  });
});
