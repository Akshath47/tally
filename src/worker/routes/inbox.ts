import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { cursorParam, listTransactions } from "../budget/listing";
import { RESOLVED_CTE, isRulablePattern } from "../budget/resolve";
import { limitParam, parseQuery } from "./query";

// What still needs sorting: counted transactions that no override or rule categorises and that
// haven't been excluded. Money in and out both wait here; pending rows too, though not editable.
const INBOX = "r.vanished_at IS NULL AND r.category_id IS NULL AND r.excluded = 0";

const querySchema = z.object({ limit: limitParam(200, 50), cursor: cursorParam.optional() });

export const inboxRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const q = parseQuery(c, querySchema);
    if (!q.ok) return q.res;
    return c.json(await listTransactions(c.env.DB, { where: [INBOX], binds: [], ...q.data, withTotal: true }));
  })
  .get("/merchants", async (c) => {
    // Grouped by lower(trim(merchant)): the pattern of the exact rule that would clear the group.
    // `merchant` is the raw text of the group's latest row (SQLite takes bare columns from the max() row).
    const { results } = await c.env.DB.prepare(
      `WITH ${RESOLVED_CTE}
       SELECT lower(trim(r.merchant)) AS pattern, r.merchant, count(*) AS count,
         sum(COALESCE(r.counted_amount_minor, r.amount_minor)) AS totalMinor, max(r.txn_date) AS latestDate
       FROM resolved r WHERE ${INBOX}
       GROUP BY pattern ORDER BY count DESC, latestDate DESC, pattern`,
    ).all<{ pattern: string }>();
    // A group that can't become a rule (a blank merchant, say) is sorted row by row instead.
    return c.json({ merchants: results.map((g) => ({ ...g, rulable: isRulablePattern(g.pattern) })) });
  });
