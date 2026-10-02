import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { inject } from "vitest";

/** Wipes D1 and re-applies the repo's migrations (which also re-seed import_lock). */
export async function resetDb(): Promise<void> {
  await reset();
  await applyD1Migrations(env.DB, inject("migrations"));
}

// Raw-SQL row builders shared by the schema and importer specs. All values are synthetic.

export const NOW = "2026-10-02T12:00:00.000Z";

type AccountOverrides = { providerAccountId?: string; provider?: string; currency?: string | null };

export async function insertAccount(overrides: AccountOverrides = {}): Promise<number> {
  const { providerAccountId = "1001", provider = "lunchflow", currency = "GBP" } = overrides;
  const row = await env.DB.prepare(
    `INSERT INTO accounts (provider, provider_account_id, name, currency, provider_status, import_enabled, created_at, updated_at)
     VALUES (?1, ?2, 'Test Bank · GBP', ?3, 'ACTIVE', 1, ?4, ?4) RETURNING id`,
  )
    .bind(provider, providerAccountId, currency, NOW)
    .first<{ id: number }>();
  return row!.id;
}

export async function insertRun(trigger = "manual", status = "running"): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO import_runs (trigger, started_at, status) VALUES (?1, ?2, ?3) RETURNING id",
  )
    .bind(trigger, NOW, status)
    .first<{ id: number }>();
  return row!.id;
}

type TxnOverrides = { txnDate?: string; amountMinor?: unknown; isPending?: unknown };

export function insertTransaction(accountId: number, runId: number, providerTxnId: string, overrides: TxnOverrides = {}) {
  const { txnDate = "2026-10-01", amountMinor = -1230, isPending = 0 } = overrides;
  return env.DB.prepare(
    `INSERT INTO transactions (account_id, provider_txn_id, amount_minor, provider_amount, currency, txn_date,
       merchant, description, is_pending, fingerprint, first_seen_at, last_seen_at, updated_at, first_import_run_id)
     VALUES (?1, ?2, ?3, '-12.3', 'GBP', ?4, 'Synthetic Cafe', '', ?5, 'fp', ?6, ?6, ?6, ?7)`,
  )
    .bind(accountId, providerTxnId, amountMinor, txnDate, isPending, NOW, runId)
    .run();
}
