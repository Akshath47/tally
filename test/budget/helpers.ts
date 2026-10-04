import { env } from "cloudflare:workers";
import { NOW, insertAccount, insertRun } from "../db";

// Raw-SQL row builders for the Phase 2 specs. All values are synthetic.

/** Seeded category ids (0005_seed_categories.sql, inserted in this order). */
export const SEEDED = { groceries: 1, eatingOut: 2, transport: 3, bills: 4, shopping: 5, other: 8, clothes: 9, income: 14 } as const;

export async function insertCategory(name: string, kind = "budgeted"): Promise<number> {
  const row = await env.DB.prepare("INSERT INTO categories (name, kind, created_at, updated_at) VALUES (?1, ?2, ?3, ?3) RETURNING id")
    .bind(name, kind, NOW)
    .first<{ id: number }>();
  return row!.id;
}

/** `pattern` is stored as given; callers pass it already normalised. */
export async function insertRule(matchType: "exact" | "contains", pattern: string, categoryId: number, accountId: number | null = null): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO merchant_rules (match_type, pattern, account_id, category_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING id`,
  )
    .bind(matchType, pattern, accountId, categoryId, NOW)
    .first<{ id: number }>();
  return row!.id;
}

export function insertOverride(transactionId: number, fields: Record<string, unknown> = {}) {
  const columns = ["transaction_id", "updated_at", ...Object.keys(fields)];
  const placeholders = columns.map((_, i) => `?${i + 1}`).join(", ");
  return env.DB.prepare(`INSERT INTO transaction_overrides (${columns.join(", ")}) VALUES (${placeholders})`)
    .bind(transactionId, NOW, ...Object.values(fields))
    .run();
}

type TxnFields = { merchant?: string; amountMinor?: number; txnDate?: string; isPending?: boolean; vanished?: boolean };

/** A ledger with two accounts and one import run, and a builder for transactions in it. */
export async function ledger() {
  const accounts = [await insertAccount({ providerAccountId: "1001" }), await insertAccount({ providerAccountId: "1002" })] as const;
  const runId = await insertRun();
  let n = 0;
  const txn = async (accountId: number, f: TxnFields = {}): Promise<number> => {
    const row = await env.DB.prepare(
      `INSERT INTO transactions (account_id, provider_txn_id, amount_minor, provider_amount, currency, txn_date,
         merchant, description, is_pending, fingerprint, first_seen_at, last_seen_at, vanished_at, updated_at, first_import_run_id)
       VALUES (?1, ?2, ?3, '0', 'GBP', ?4, ?5, '', ?6, 'fp', ?7, ?7, ?8, ?7, ?9) RETURNING id`,
    )
      .bind(
        accountId, `t${++n}`, f.amountMinor ?? -1000, f.txnDate ?? "2026-10-01", f.merchant ?? "Synthetic Cafe",
        f.isPending ? 1 : 0, NOW, f.vanished ? NOW : null, runId,
      )
      .first<{ id: number }>();
    return row!.id;
  };
  return { accounts, txn };
}
