import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { getTransaction } from "../budget/listing";
import { NOTE_MAX_LENGTH } from "../db/schema";
import { idParam, parseBody } from "./query";

// The owner's edits to one transaction (docs/phase-2-spec.md, API). They live apart from the
// bank-sourced row, so a re-sync never touches them.

// PUT replaces the whole override: a field left out goes back to its default, and an override
// with every field at its default is removed. An empty note is no note.
const bodySchema = z
  .object({
    categoryId: z.int().positive().nullable().default(null),
    excluded: z.boolean().default(false),
    // z.int() is a safe integer; the client converts typed decimals with string arithmetic.
    countedAmountMinor: z.int().nullable().default(null),
    countedDate: z.iso.date().nullable().default(null),
    // Untrusted text; React escapes it.
    note: z
      .string()
      .max(NOTE_MAX_LENGTH)
      .nullable()
      .default(null)
      .transform((n) => n || null),
    applyToMerchant: z.boolean().default(false),
  })
  .refine((b) => !b.applyToMerchant || b.categoryId !== null);

type State = {
  editable: number;
  account_id: number;
  // What an exact rule for this merchant must equal: it's matched against lower(trim(merchant)).
  pattern: string;
  current_category_id: number | null;
  // Null when the requested category doesn't exist (or none was requested).
  category_archived: number | null;
};

const readState = (db: D1Database, id: number, categoryId: number | null) =>
  db
    .prepare(
      `SELECT t.is_pending = 0 AND t.vanished_at IS NULL AS editable, t.account_id, lower(trim(t.merchant)) AS pattern,
         o.category_id AS current_category_id,
         (SELECT archived_at IS NOT NULL FROM categories WHERE id = ?2) AS category_archived
       FROM transactions t LEFT JOIN transaction_overrides o ON o.transaction_id = t.id
       WHERE t.id = ?1`,
    )
    .bind(id, categoryId)
    .first<State>();

const notEditable = { error: "not_editable" } as const;

export const overrideRoutes = new Hono<AppEnv>()
  .put("/:id/override", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad_request" }, 400);
    const body = await parseBody(c, bodySchema);
    if (!body.ok) return body.res;
    const { categoryId, excluded, countedAmountMinor, countedDate, note, applyToMerchant } = body.data;
    const db = c.env.DB;

    const state = await readState(db, id, categoryId);
    if (!state) return c.json({ error: "not_found" }, 404);
    if (!state.editable) return c.json(notEditable, 409);
    if (categoryId !== null) {
      if (state.category_archived === null) return c.json({ error: "not_found" }, 404);
      // Pickers hide archived categories, but a full-form PUT may resend the one already set.
      // A rule can't point at an archived category at all (as POST /api/rules).
      if (state.category_archived === 1 && (applyToMerchant || categoryId !== state.current_category_id)) {
        return c.json({ error: "category_archived" }, 409);
      }
    }
    if (applyToMerchant && state.pattern === "") return c.json({ error: "no_merchant" }, 409);

    const now = new Date().toISOString();
    const overrideCategoryId = applyToMerchant ? null : categoryId;
    const isDefault = overrideCategoryId === null && !excluded && countedAmountMinor === null && countedDate === null && note === null;
    const statements: D1PreparedStatement[] = [];

    if (applyToMerchant) {
      // The exact rule that decides this row: this account's own one if it has one (it outranks
      // an any-account rule), otherwise the any-account rule, created if missing.
      statements.push(
        db
          .prepare("UPDATE merchant_rules SET category_id = ?1, updated_at = ?2 WHERE match_type = 'exact' AND pattern = ?3 AND account_id = ?4")
          .bind(categoryId, now, state.pattern, state.account_id),
        db
          .prepare(
            `INSERT INTO merchant_rules (match_type, pattern, account_id, category_id, created_at, updated_at)
             SELECT 'exact', ?1, NULL, ?2, ?3, ?3
             WHERE NOT EXISTS (SELECT 1 FROM merchant_rules WHERE match_type = 'exact' AND pattern = ?1 AND account_id = ?4)
             ON CONFLICT (match_type, pattern, account_scope) DO UPDATE SET category_id = excluded.category_id, updated_at = excluded.updated_at`,
          )
          .bind(state.pattern, categoryId, now, state.account_id),
      );
    }
    statements.push(
      isDefault
        ? db.prepare("DELETE FROM transaction_overrides WHERE transaction_id = ?1").bind(id)
        : db
            .prepare(
              // Guarded again here, in case the row stopped being editable since it was read.
              `INSERT INTO transaction_overrides (transaction_id, category_id, excluded, counted_amount_minor, counted_date, note, updated_at)
               SELECT id, ?2, ?3, ?4, ?5, ?6, ?7 FROM transactions WHERE id = ?1 AND is_pending = 0 AND vanished_at IS NULL
               ON CONFLICT (transaction_id) DO UPDATE SET category_id = excluded.category_id, excluded = excluded.excluded,
                 counted_amount_minor = excluded.counted_amount_minor, counted_date = excluded.counted_date,
                 note = excluded.note, updated_at = excluded.updated_at`,
            )
            .bind(id, overrideCategoryId, excluded ? 1 : 0, countedAmountMinor, countedDate, note, now),
    );
    const results = await db.batch(statements);
    if (!isDefault && results.at(-1)!.meta.changes === 0) return c.json(notEditable, 409);
    return c.json({ transaction: await getTransaction(db, id) });
  })
  .delete("/:id/override", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad_request" }, 400);
    const db = c.env.DB;
    const state = await readState(db, id, null);
    if (!state) return c.json({ error: "not_found" }, 404);
    if (!state.editable) return c.json(notEditable, 409);
    await db.prepare("DELETE FROM transaction_overrides WHERE transaction_id = ?1").bind(id).run();
    return c.json({ transaction: await getTransaction(db, id) });
  });
