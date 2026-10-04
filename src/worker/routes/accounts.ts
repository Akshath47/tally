import { asc, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { accounts } from "../db/schema";
import { BUDGET_CURRENCY } from "../importer";
import { idParam, parseBody } from "./query";

type ReviewRow = {
  id: number;
  provider_account_id: string;
  provider_connection_id: string | null;
  provider_status: string;
  currency: string | null;
  needs_review: number;
  merged_into_account_id: number | null;
};

const loadAccount = (db: D1Database, id: number) =>
  db
    .prepare(
      `SELECT id, provider_account_id, provider_connection_id, provider_status, currency, needs_review, merged_into_account_id
       FROM accounts WHERE id = ?1`,
    )
    .bind(id)
    .first<ReviewRow>();

const awaitingReview = (a: ReviewRow) => a.needs_review === 1 && a.merged_into_account_id === null;

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
    return c.json({ accounts: rows });
  })
  // The owner says an account awaiting review is genuinely new: import it from the next run.
  .post("/:id/enable", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad_request" }, 400);
    const account = await loadAccount(c.env.DB, id);
    if (!account) return c.json({ error: "not_found" }, 404);
    if (!awaitingReview(account)) return c.json({ error: "not_awaiting_review" }, 409);
    if (account.currency !== BUDGET_CURRENCY) return c.json({ error: "not_importable" }, 409);

    await c.env.DB.prepare("UPDATE accounts SET needs_review = 0, import_enabled = 1, updated_at = ?2 WHERE id = ?1")
      .bind(id, new Date().toISOString())
      .run();
    return c.json({ ok: true });
  })
  /**
   * The owner says an account awaiting review is a reconnect of `intoAccountId`. The two rows
   * swap provider ids in one atomic batch: the target imports from the new id from the next run,
   * keeping its history and overrides, and the review row keeps the target's old id, disabled,
   * so that id is never treated as new again. The target catches up from 7 days before its
   * newest transaction; if Lunch Flow kept the transaction ids, the overlap adds no rows.
   */
  .post("/:id/link", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad_request" }, 400);
    const body = await parseBody(c, z.object({ intoAccountId: z.number().int().positive() }));
    if (!body.ok) return body.res;

    const [held, target] = await Promise.all([loadAccount(c.env.DB, id), loadAccount(c.env.DB, body.data.intoAccountId)]);
    if (!held || !target) return c.json({ error: "not_found" }, 404);
    if (!awaitingReview(held)) return c.json({ error: "not_awaiting_review" }, 409);
    if (target.id === held.id || target.needs_review === 1 || target.merged_into_account_id !== null || target.currency !== held.currency) {
      return c.json({ error: "invalid_link_target" }, 409);
    }

    const now = new Date().toISOString();
    await c.env.DB.batch([
      // Frees the new provider id; UNIQUE(provider, provider_account_id) holds after each statement.
      c.env.DB.prepare("UPDATE accounts SET provider_account_id = 'linking:' || id, updated_at = ?2 WHERE id = ?1").bind(held.id, now),
      c.env.DB.prepare(
        `UPDATE accounts SET provider_account_id = ?3, provider_connection_id = ?4, provider_status = ?5,
           import_enabled = 1, last_import_error = NULL, consecutive_failures = 0,
           backfill_complete = 0, backfill_cursor_date = NULL,
           backfill_floor_date = CASE WHEN newest_txn_date IS NULL THEN NULL ELSE date(newest_txn_date, '-7 days') END,
           updated_at = ?2
         WHERE id = ?1`,
      ).bind(target.id, now, held.provider_account_id, held.provider_connection_id, held.provider_status),
      c.env.DB.prepare(
        `UPDATE accounts SET provider_account_id = ?3, merged_into_account_id = ?4, needs_review = 0, import_enabled = 0, updated_at = ?2
         WHERE id = ?1`,
      ).bind(held.id, now, target.provider_account_id, target.id),
    ]);
    return c.json({ ok: true });
  });
