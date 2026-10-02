import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { accounts } from "../db/schema";

// Provider and connection ids stay server-side; the UI only needs the label and status fields.
export const accountRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const rows = await drizzle(c.env.DB)
    .select({
      id: accounts.id,
      name: accounts.name,
      institutionName: accounts.institutionName,
      providerStatus: accounts.providerStatus,
      currency: accounts.currency,
      balanceMinor: accounts.balanceMinor,
      balanceFetchedAt: accounts.balanceFetchedAt,
      importEnabled: accounts.importEnabled,
      lastImportAttemptAt: accounts.lastImportAttemptAt,
      lastImportSuccessAt: accounts.lastImportSuccessAt,
      lastImportError: accounts.lastImportError,
      consecutiveFailures: accounts.consecutiveFailures,
      lastDataChangeAt: accounts.lastDataChangeAt,
      newestTxnDate: accounts.newestTxnDate,
      backfillComplete: accounts.backfillComplete,
    })
    .from(accounts)
    .orderBy(asc(accounts.id));
  return c.json({ accounts: rows });
});
