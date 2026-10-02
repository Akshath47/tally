import { Hono } from "hono";
import type { AppEnv } from "../auth";

type AccountRow = { importEnabled: number; backfillComplete: number } & Record<string, unknown>;

// Provider and connection ids stay server-side; the UI only needs the label and status fields.
export const accountRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, institution_name AS institutionName, provider_status AS providerStatus, currency,
       balance_minor AS balanceMinor, balance_fetched_at AS balanceFetchedAt, import_enabled AS importEnabled,
       last_import_attempt_at AS lastImportAttemptAt, last_import_success_at AS lastImportSuccessAt,
       last_import_error AS lastImportError, consecutive_failures AS consecutiveFailures,
       last_data_change_at AS lastDataChangeAt, newest_txn_date AS newestTxnDate, backfill_complete AS backfillComplete
     FROM accounts ORDER BY id`,
  ).all<AccountRow>();

  const accounts = results.map((a) => ({ ...a, importEnabled: a.importEnabled === 1, backfillComplete: a.backfillComplete === 1 }));
  return c.json({ accounts });
});
