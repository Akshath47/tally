import { asc, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { withStale } from "../budget/stale";
import { enableAccount, isAwaitingReview, linkAccounts, loadAccount } from "../db/account-review";
import { accounts } from "../db/schema";
import { BUDGET_CURRENCY, isLockHeld } from "../importer";
import { idParam, parseBody } from "./query";

// Provider and connection ids stay server-side; the UI only needs the label and status fields.
export const accountRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
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
        needsReview: accounts.needsReview,
      })
      .from(accounts)
      // A merged row only remembers a retired provider id; its history lives on the target.
      .where(isNull(accounts.mergedIntoAccountId))
      .orderBy(asc(accounts.id));
    const now = new Date();
    return c.json({ accounts: rows.map((a) => withStale(a, now)) });
  })
  // The owner says an account awaiting review is genuinely new: import it from the next run.
  .post("/:id/enable", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad_request" }, 400);
    const account = await loadAccount(c.env.DB, id);
    if (!account) return c.json({ error: "not_found" }, 404);
    if (!isAwaitingReview(account)) return c.json({ error: "not_awaiting_review" }, 409);
    if (account.currency !== BUDGET_CURRENCY) return c.json({ error: "not_importable" }, 409);

    const changed = await enableAccount(c.env.DB, id, new Date().toISOString());
    return changed ? c.json({ ok: true }) : c.json({ error: "conflict" }, 409);
  })
  // The owner says an account awaiting review is a reconnect of `intoAccountId` (see linkAccounts).
  .post("/:id/link", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad_request" }, 400);
    const body = await parseBody(c, z.object({ intoAccountId: z.number().int().positive() }));
    if (!body.ok) return body.res;

    const [held, target] = await Promise.all([loadAccount(c.env.DB, id), loadAccount(c.env.DB, body.data.intoAccountId)]);
    if (!held || !target) return c.json({ error: "not_found" }, 404);
    if (!isAwaitingReview(held)) return c.json({ error: "not_awaiting_review" }, 409);
    if (
      target.id === held.id || target.needs_review === 1 || target.merged_into_account_id !== null ||
      held.currency === null || target.currency !== held.currency
    ) {
      return c.json({ error: "invalid_link_target" }, 409);
    }
    // A run in flight has already read the target under its old id; its status write would undo the link's reset.
    const now = new Date();
    if (await isLockHeld(c.env.DB, now)) return c.json({ error: "import_running" }, 409);

    const changed = await linkAccounts(c.env.DB, held, target, now.toISOString());
    return changed ? c.json({ ok: true }) : c.json({ error: "conflict" }, 409);
  });
