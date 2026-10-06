import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { editable, getTransaction } from "../budget/listing";
import { isRulablePattern } from "../budget/resolve";
import { NOTE_MAX_LENGTH } from "../db/schema";
import { idParam, parseBody } from "./query";
import { checkRefs } from "./refs";

// The owner's edits to one transaction (docs/phase-2-spec.md, API). They live apart from the
// bank-sourced row, so a re-sync never touches them.

// PUT replaces the whole override: a field left out goes back to its default, and an override
// with every field at its default is removed. An empty note is no note. `categoryId` is the
// override's own category: a row that should keep following the rules sends null.
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
  accountId: number;
  // What an exact rule for this merchant must equal: it's matched against lower(trim(merchant)).
  pattern: string;
  currentCategoryId: number | null;
};

const readState = (db: D1Database, id: number) =>
  db
    .prepare(
      `SELECT ${editable("t")} AS editable, t.account_id AS accountId, lower(trim(t.merchant)) AS pattern,
         o.category_id AS currentCategoryId
       FROM transactions t LEFT JOIN transaction_overrides o ON o.transaction_id = t.id
       WHERE t.id = ?1`,
    )
    .bind(id)
    .first<State>();

/** Why this row can't be edited, or null if it can. */
const refuseEdit = (state: State | null) =>
  !state ? ({ error: "not_found", status: 404 } as const) : !state.editable ? ({ error: "not_editable", status: 409 } as const) : null;

const deleteOverride = (db: D1Database, id: number) => db.prepare("DELETE FROM transaction_overrides WHERE transaction_id = ?1").bind(id);

export const overrideRoutes = new Hono<AppEnv>()
  .put("/:id/override", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad_request" }, 400);
    const body = await parseBody(c, bodySchema);
    if (!body.ok) return body.res;
    const { categoryId, excluded, countedAmountMinor, countedDate, note, applyToMerchant } = body.data;
    const db = c.env.DB;

    const [current, refs] = await Promise.all([readState(db, id), categoryId === null ? null : checkRefs(db, categoryId, undefined)]);
    const refused = refuseEdit(current);
    if (refused) return c.json({ error: refused.error }, refused.status);
    const state = current!;
    // Pickers hide archived categories, but a full-form PUT may resend the override's own one.
    // A rule can't point at an archived category at all (as POST /api/rules).
    const resent = !applyToMerchant && categoryId === state.currentCategoryId;
    if (refs && !(refs.error === "category_archived" && resent)) return c.json({ error: refs.error }, refs.status);
    // The rules editor must be able to save the rule later.
    if (applyToMerchant && !isRulablePattern(state.pattern)) return c.json({ error: "merchant_not_rulable" }, 409);

    const now = new Date().toISOString();
    const overrideCategoryId = applyToMerchant ? null : categoryId;
    const isDefault = overrideCategoryId === null && !excluded && countedAmountMinor === null && countedDate === null && note === null;
    const statements: D1PreparedStatement[] = [];

    if (applyToMerchant) {
      // The any-account exact rule, so every account follows, plus this account's own exact rule
      // if it has one: that outranks the any-account rule, and this row must follow too.
      statements.push(
        db
          .prepare(
            `INSERT INTO merchant_rules (match_type, pattern, account_id, category_id, created_at, updated_at)
             VALUES ('exact', ?1, NULL, ?2, ?3, ?3)
             ON CONFLICT (match_type, pattern, account_scope) DO UPDATE SET category_id = excluded.category_id, updated_at = excluded.updated_at`,
          )
          .bind(state.pattern, categoryId, now),
        db
          .prepare("UPDATE merchant_rules SET category_id = ?1, updated_at = ?2 WHERE match_type = 'exact' AND pattern = ?3 AND account_id = ?4")
          .bind(categoryId, now, state.pattern, state.accountId),
      );
    }
    statements.push(
      isDefault
        ? deleteOverride(db, id)
        : db
            .prepare(
              `INSERT INTO transaction_overrides (transaction_id, category_id, excluded, counted_amount_minor, counted_date, note, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
               ON CONFLICT (transaction_id) DO UPDATE SET category_id = excluded.category_id, excluded = excluded.excluded,
                 counted_amount_minor = excluded.counted_amount_minor, counted_date = excluded.counted_date,
                 note = excluded.note, updated_at = excluded.updated_at`,
            )
            .bind(id, overrideCategoryId, excluded ? 1 : 0, countedAmountMinor, countedDate, note, now),
    );
    // One batch, so the rule and the override land together or not at all.
    await db.batch(statements);
    return c.json({ transaction: await getTransaction(db, id) });
  })
  .delete("/:id/override", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad_request" }, 400);
    const db = c.env.DB;
    const refused = refuseEdit(await readState(db, id));
    if (refused) return c.json({ error: refused.error }, refused.status);
    await deleteOverride(db, id).run();
    return c.json({ transaction: await getTransaction(db, id) });
  });
