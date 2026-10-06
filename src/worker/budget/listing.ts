import { z } from "zod";
import { RESOLVED_CTE } from "./resolve";

// The transaction list shared by /api/transactions, the inbox and the override responses: the
// bank fields plus each row's resolved category and override fields (docs/phase-2-spec.md, API).

// Opaque to the client: the (txn_date, id) of the last row served, for keyset paging.
export const cursorParam = z
  .string()
  .regex(/^[^_]+_[1-9]\d*$/)
  .transform((s) => {
    const [date, id] = s.split("_");
    return { date: date!, id: Number(id) };
  })
  .pipe(z.object({ date: z.iso.date(), id: z.number().int() }));

export type Cursor = z.infer<typeof cursorParam>;

type Row = {
  id: number;
  accountId: number;
  amountMinor: number;
  currency: string;
  txnDate: string;
  merchant: string;
  description: string;
  isPending: number;
  vanishedAt: string | null;
  firstSeenAt: string;
  categoryId: number | null;
  categorySource: "override" | "rule" | null;
  excluded: number;
  countedAmountMinor: number | null;
  countedDate: string | null;
  note: string | null;
  editable: number;
  total?: number;
};

// Built field by field: the page's `total` stays off the rows, and D1's 0/1 become booleans.
const toTransaction = (r: Row) => ({
  id: r.id,
  accountId: r.accountId,
  amountMinor: r.amountMinor,
  currency: r.currency,
  txnDate: r.txnDate,
  merchant: r.merchant,
  description: r.description,
  isPending: r.isPending === 1,
  vanishedAt: r.vanishedAt,
  firstSeenAt: r.firstSeenAt,
  categoryId: r.categoryId,
  categorySource: r.categorySource,
  excluded: r.excluded === 1,
  countedAmountMinor: r.countedAmountMinor,
  countedDate: r.countedDate,
  note: r.note,
  editable: r.editable === 1,
});

export type Transaction = ReturnType<typeof toTransaction>;

/** On the transactions (or resolved) row aliased `alias`: pending and vanished rows can't be edited (docs/phase1-assessment.md). */
export const editable = (alias: string) => `${alias}.is_pending = 0 AND ${alias}.vanished_at IS NULL`;

const COLUMNS = `r.id, r.account_id AS accountId, r.amount_minor AS amountMinor, r.currency, r.txn_date AS txnDate,
  r.merchant, r.description, r.is_pending AS isPending, r.vanished_at AS vanishedAt, r.first_seen_at AS firstSeenAt,
  r.category_id AS categoryId, r.category_source AS categorySource, r.excluded,
  r.counted_amount_minor AS countedAmountMinor, r.counted_date AS countedDate, r.note,
  (${editable("r")}) AS editable`;

type ListOptions = {
  /**
   * `[sql, ...binds]`: a static condition on `r` (resolved), and a value per `?`. Something here
   * should let SQLite seek (see RESOLVED_CTE); with nothing, a page walks the date index.
   */
  where: [sql: string, ...binds: unknown[]][];
  limit: number;
  cursor?: Cursor;
  /** Also count every row matching `where`, regardless of the page. */
  withTotal?: boolean;
  /** Join each row's category as `c`, for conditions on its kind. Off by default: it's a lookup per row. */
  withCategory?: boolean;
};

/**
 * Newest first, keyset-paged. The total is a window count over the rows `where` matches, in the
 * same statement.
 */
export async function listTransactions(db: D1Database, opts: ListOptions): Promise<{ transactions: Transaction[]; nextCursor: string | null; total: number }> {
  const where = opts.where.length ? `WHERE ${opts.where.map(([sql]) => sql).join(" AND ")}` : "";
  const binds = opts.where.flatMap(([, ...values]) => values);
  const total = opts.withTotal ? ", count(*) OVER () AS total" : "";
  const category = opts.withCategory ? "LEFT JOIN categories c ON c.id = r.category_id" : "";
  const cursor = opts.cursor ? "WHERE (txnDate, id) < (?, ?)" : "";
  const cursorBinds = opts.cursor ? [opts.cursor.date, opts.cursor.id] : [];
  // One extra row tells us whether there is a next page.
  const { results } = await db
    .prepare(
      `WITH ${RESOLVED_CTE},
         listed AS (SELECT ${COLUMNS}${total} FROM resolved r ${category} ${where})
       SELECT * FROM listed ${cursor} ORDER BY txnDate DESC, id DESC LIMIT ?`,
    )
    .bind(...binds, ...cursorBinds, opts.limit + 1)
    .all<Row>();

  // A later page is only empty if its rows changed since the previous one; count from the start.
  if (opts.withTotal && opts.cursor && results.length === 0) {
    return { transactions: [], nextCursor: null, total: (await listTransactions(db, { ...opts, cursor: undefined, limit: 1 })).total };
  }
  const page = results.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    transactions: page.map(toTransaction),
    nextCursor: results.length > opts.limit && last ? `${last.txnDate}_${last.id}` : null,
    total: results[0]?.total ?? 0,
  };
}

export async function getTransaction(db: D1Database, id: number): Promise<Transaction | null> {
  const { transactions } = await listTransactions(db, { where: [["r.id = ?", id]], limit: 1 });
  return transactions[0] ?? null;
}
