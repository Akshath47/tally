import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { RESOLVED_CTE, isRulablePattern, normalizePattern } from "../budget/resolve";
import { MATCH_TYPES } from "../db/schema";
import { idParam, isUniqueViolation, parseBody } from "./query";

// Merchant rules set a merchant's default category. Rules are resolved when data is read, so
// every change here re-sorts past transactions that have no category override at once.

const COLUMNS = "id, match_type AS matchType, pattern, account_id AS accountId, category_id AS categoryId";
type Rule = { id: number; matchType: string; pattern: string; accountId: number | null; categoryId: number };

// Normalised as SQLite matches it; the stored pattern is what the response shows.
const pattern = z.string().transform(normalizePattern).refine(isRulablePattern);
const fields = {
  matchType: z.enum(MATCH_TYPES),
  pattern,
  accountId: z.number().int().positive().nullable(),
  categoryId: z.number().int().positive(),
};

/** Why a rule can't point at these, or null if it can. A merged account is hidden from the UI, so it counts as unknown. */
export async function checkRefs(db: D1Database, categoryId: number | undefined, accountId: number | null | undefined) {
  const [category, account] = await Promise.all([
    categoryId === undefined ? null : db.prepare("SELECT archived_at FROM categories WHERE id = ?1").bind(categoryId).first<{ archived_at: string | null }>(),
    accountId == null ? null : db.prepare("SELECT 1 FROM accounts WHERE id = ?1 AND merged_into_account_id IS NULL").bind(accountId).first(),
  ]);
  if ((categoryId !== undefined && !category) || (accountId != null && !account)) return { error: "not_found", status: 404 } as const;
  if (category?.archived_at) return { error: "category_archived", status: 409 } as const;
  return null;
}

export const ruleRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    // Only rows a rule decides (no category override) that still count.
    const { results } = await c.env.DB.prepare(
      `WITH ${RESOLVED_CTE},
         counts AS (SELECT rule_id, count(*) AS n FROM resolved WHERE category_source = 'rule' AND vanished_at IS NULL GROUP BY rule_id)
       SELECT r.id, r.match_type AS matchType, r.pattern, r.account_id AS accountId, r.category_id AS categoryId,
         COALESCE(counts.n, 0) AS transactionCount
       FROM merchant_rules r LEFT JOIN counts ON counts.rule_id = r.id
       ORDER BY r.id`,
    ).all<Rule & { transactionCount: number }>();
    return c.json({ rules: results });
  })
  .post("/", async (c) => {
    const body = await parseBody(c, z.object({ ...fields, accountId: fields.accountId.default(null) }));
    if (!body.ok) return body.res;
    const { matchType, pattern: p, accountId, categoryId } = body.data;
    const refused = await checkRefs(c.env.DB, categoryId, accountId);
    if (refused) return c.json({ error: refused.error }, refused.status);
    try {
      const rule = await c.env.DB.prepare(
        `INSERT INTO merchant_rules (match_type, pattern, account_id, category_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING ${COLUMNS}`,
      )
        .bind(matchType, p, accountId, categoryId, new Date().toISOString())
        .first<Rule>();
      return c.json({ rule }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) return c.json({ error: "rule_exists" }, 409);
      throw e;
    }
  })
  .patch("/:id", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad_request" }, 400);
    const body = await parseBody(
      c,
      z.object(fields).partial().refine((b) => Object.values(b).some((v) => v !== undefined)),
    );
    if (!body.ok) return body.res;
    const { matchType, pattern: p, accountId, categoryId } = body.data;
    const current = await c.env.DB.prepare("SELECT category_id, account_id FROM merchant_rules WHERE id = ?1")
      .bind(id)
      .first<{ category_id: number; account_id: number | null }>();
    if (!current) return c.json({ error: "not_found" }, 404);
    // Only references that change are checked, so a full-form edit of a rule whose category was
    // archived since (the spec keeps such rules working) isn't refused for that.
    const refused = await checkRefs(
      c.env.DB,
      categoryId === current.category_id ? undefined : categoryId,
      accountId === current.account_id ? undefined : accountId,
    );
    if (refused) return c.json({ error: refused.error }, refused.status);
    try {
      // accountId: undefined keeps the scope, null makes the rule apply to any account.
      const rule = await c.env.DB.prepare(
        `UPDATE merchant_rules SET match_type = COALESCE(?2, match_type), pattern = COALESCE(?3, pattern),
           account_id = CASE WHEN ?4 = 1 THEN ?5 ELSE account_id END, category_id = COALESCE(?6, category_id), updated_at = ?7
         WHERE id = ?1 RETURNING ${COLUMNS}`,
      )
        .bind(id, matchType ?? null, p ?? null, accountId === undefined ? 0 : 1, accountId ?? null, categoryId ?? null, new Date().toISOString())
        .first<Rule>();
      return rule ? c.json({ rule }) : c.json({ error: "not_found" }, 404);
    } catch (e) {
      if (isUniqueViolation(e)) return c.json({ error: "rule_exists" }, 409);
      throw e;
    }
  })
  .delete("/:id", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad_request" }, 400);
    const res = await c.env.DB.prepare("DELETE FROM merchant_rules WHERE id = ?1").bind(id).run();
    return res.meta.changes === 1 ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });
