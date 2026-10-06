import { memo, useMemo, useState, type ReactNode } from "react";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import type { Account, Category, Page, Transaction } from "../api";
import { formatShortDate, londonToday } from "../dates";
import { merchantLabel } from "../format";
import { formatSigned, formatUnsigned } from "../money";
import { countsAs, isEdited } from "../overrides";
import { useAccounts, useCategories } from "../queries";
import { LoadError } from "./Screen";
import { TransactionSheet } from "./TransactionSheet";
import { AccountBadge, Button, Clock, Pencil, Skeleton } from "./ui";

// A paged list of transactions in day groups, with the editor sheet: the Transactions tab and a
// Home line's screen (docs/ui-design.md).

const counted = (t: Transaction) => t.countedAmountMinor ?? t.amountMinor;

const Row = memo(function Row({ t, account, category, onOpen }: { t: Transaction; account: Account | undefined; category: Category | undefined; onOpen: (t: Transaction) => void }) {
  const excluded = countsAs(t, category?.kind) === "none";
  const merchant = merchantLabel(t);
  const amountChanged = t.countedAmountMinor !== null && t.countedAmountMinor !== t.amountMinor;
  return (
    <li>
      <button type="button" className="flex min-h-[62px] w-full items-center gap-3 border-b border-divider px-5 py-2.5 text-left hover:bg-surface" onClick={() => onOpen(t)}>
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-line bg-surface text-[13px] font-medium text-fg/80" aria-hidden="true">
          {merchant.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{merchant}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted">
            <AccountBadge account={account} />
            <span>
              {category?.name ?? "Uncategorised"}
              {excluded ? " · excluded" : category?.kind === "tracked" ? " · tracked" : ""}
            </span>
            {t.isPending && (
              <span className="inline-flex items-center gap-1 text-fg/80">
                <Clock size={12} />
                Pending
              </span>
            )}
            {isEdited(t) && (
              <span className="inline-flex items-center gap-1 text-accent-fg">
                <Pencil size={11} />
                Edited
              </span>
            )}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className={`block ${t.isPending ? "text-muted italic" : excluded ? "text-muted" : ""}`}>{formatSigned(counted(t), t.currency)}</span>
          {amountChanged && <span className="block text-xs text-muted line-through">{formatUnsigned(t.amountMinor, t.currency)}</span>}
        </span>
      </button>
    </li>
  );
});

type Days = { date: string; list: Transaction[]; total: number }[];

/** Rows grouped by `dateOf`, newest day first, each with the day's counted total. */
function groupDays(rows: Transaction[], dateOf: (t: Transaction) => string, byId: Map<number, Category> | undefined): Days {
  const days = new Map<string, { list: Transaction[]; total: number }>();
  for (const t of rows) {
    const date = dateOf(t);
    const day = days.get(date) ?? { list: [], total: 0 };
    day.list.push(t);
    // The total leaves out rows that don't count as spending at all.
    if (countsAs(t, t.categoryId === null ? undefined : byId?.get(t.categoryId)?.kind) !== "none") day.total += counted(t);
    days.set(date, day);
  }
  // The API sorts by bank date, so a row counted on another date can arrive out of order.
  return [...days].map(([date, d]) => ({ date, ...d })).sort((a, b) => b.date.localeCompare(a.date));
}

const bankDate = (t: Transaction) => t.txnDate;

type Props = {
  query: UseInfiniteQueryResult<InfiniteData<Page<Transaction>>>;
  /** Which loaded rows to show. Module-level, so the grouping stays memoised. */
  keep?: (t: Transaction) => boolean;
  /** Which date a row is grouped under: its bank date unless given. Module-level too. */
  dateOf?: (t: Transaction) => string;
  empty: string;
  /** Appended to the count line. */
  extra?: ReactNode;
};

export function TransactionList({ query, keep, dateOf = bankDate, empty, extra }: Props) {
  const today = londonToday();
  const categories = useCategories();
  const accounts = useAccounts();
  const [open, setOpen] = useState<Transaction | null>(null);
  const byId = categories.data?.byId;

  const rows = useMemo(() => {
    const all = query.data?.pages.flatMap((p) => p.transactions) ?? [];
    return keep ? all.filter(keep) : all;
  }, [query.data, keep]);
  const days = useMemo(() => groupDays(rows, dateOf, byId), [rows, dateOf, byId]);
  const complete = query.data !== undefined && !query.hasNextPage;

  return (
    <>
      {query.isError ? (
        <LoadError what="transactions" onRetry={() => void query.refetch()} />
      ) : query.isPending ? (
        <div className="mt-4 flex flex-col gap-3 px-5" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : (
        <>
          <p className="mx-5 mt-2.5 text-[13px] text-muted">
            {rows.length === 0 ? empty : `${rows.length}${complete ? "" : "+"} ${rows.length === 1 ? "transaction" : "transactions"}`}
            {extra}
          </p>
          {days.map(({ date, list, total }) => (
            <section key={date} aria-label={formatShortDate(date)}>
              <div className="flex items-baseline justify-between px-5 pt-5 pb-1.5 text-[11.5px] font-medium tracking-[0.08em] text-muted uppercase">
                <h2>{date === today ? `Today · ${formatShortDate(date)}` : formatShortDate(date)}</h2>
                <span className="tracking-normal normal-case">{formatSigned(total, "GBP")}</span>
              </div>
              <ul>
                {list.map((t) => (
                  <Row key={t.id} t={t} account={accounts.data?.byId.get(t.accountId)} category={t.categoryId === null ? undefined : byId?.get(t.categoryId)} onOpen={setOpen} />
                ))}
              </ul>
            </section>
          ))}
          {query.hasNextPage && (
            <div className="px-5 pt-4">
              <Button kind="secondary" className="w-full" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {query.isFetchingNextPage ? "Loading…" : "Show more"}
              </Button>
            </div>
          )}
        </>
      )}
      <TransactionSheet txn={open} onClose={() => setOpen(null)} />
    </>
  );
}
