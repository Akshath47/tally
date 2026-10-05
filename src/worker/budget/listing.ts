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

function toTransaction(r: Row) {
  const t = { ...r, isPending: r.isPending === 1, excluded: r.excluded === 1, editable: r.editable === 1 };
  delete t.total;
  return t as Omit<typeof t, "total">;
}

export type Transaction = ReturnType<typeof toTransaction>;

/** On `transactions t`: pending and vanished rows can't be edited (docs/phase1-assessment.md). */
export const EDITABLE = "t.is_pending = 0 AND t.vanished_at IS NULL";

const COLUMNS = `t.id, t.account_id AS accountId, t.amount_minor AS amountMinor, t.currency, t.txn_date AS txnDate,
  t.merchant, t.description, t.is_pending AS isPending, t.vanished_at AS vanishedAt, t.first_seen_at AS firstSeenAt,
  r.category_id AS categoryId, r.category_source AS categorySource, r.excluded,
  r.counted_amount_minor AS countedAmountMinor, r.counted_date AS countedDate, r.note,
  (${EDITABLE}) AS editable`;

type ListOptions = {
  /** Static SQL conditions on `t` (transactions) and `r` (resolved), with `?` placeholders in `binds` order. */
  where: string[];
  binds: unknown[];
  limit: number;
  cursor?: Cursor;
  /** Also count every row matching `where`, regardless of the page. */
  withTotal?: boolean;
};

/**
 * Newest first, keyset-paged. Each call evaluates RESOLVED_CTE once; the total is a window
 * count in the same statement rather than a second query, which would resolve everything again.
 */
export async function listTransactions(db: D1Database, opts: ListOptions): Promise<{ transactions: Transaction[]; nextCursor: string | null; total: number }> {
  const where = opts.where.length ? `WHERE ${opts.where.join(" AND ")}` : "";
  const total = opts.withTotal ? ", count(*) OVER () AS total" : "";
  const cursor = opts.cursor ? "WHERE txnDate < ? OR (txnDate = ? AND id < ?)" : "";
  const cursorBinds = opts.cursor ? [opts.cursor.date, opts.cursor.date, opts.cursor.id] : [];
  // One extra row tells us whether there is a next page.
  const { results } = await db
    .prepare(
      `WITH ${RESOLVED_CTE},
         listed AS (SELECT ${COLUMNS}${total} FROM resolved r JOIN transactions t ON t.id = r.id ${where})
       SELECT * FROM listed ${cursor} ORDER BY txnDate DESC, id DESC LIMIT ?`,
    )
    .bind(...opts.binds, ...cursorBinds, opts.limit + 1)
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
  const { transactions } = await listTransactions(db, { where: ["t.id = ?"], binds: [id], limit: 1 });
  return transactions[0] ?? null;
}
