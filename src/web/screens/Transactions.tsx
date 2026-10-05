import { useState } from "react";
import type { Category, Transaction } from "../api";
import { TabScreen } from "../components/Screen";
import { TransactionSheet } from "../components/TransactionSheet";
import { AccountBadge, Button, ChevronLeft, ChevronRight, Clock, Pencil, Skeleton } from "../components/ui";
import { addMonths, formatShortDate, londonToday, monthName, monthOf } from "../dates";
import { merchantLabel } from "../format";
import { formatPounds, formatSigned, formatUnsigned } from "../money";
import { useAccounts, useCategories, useMonthTransactions, useSummary } from "../queries";

// The month's transactions by bank date (docs/ui-design.md, Transactions). Search and filters
// are a later backend slice.

const isEdited = (t: Transaction) => t.categorySource === "override" || t.excluded || t.countedAmountMinor !== null || t.countedDate !== null || t.note !== null;
const isExcluded = (t: Transaction, c: Category | undefined) => t.excluded || c?.kind === "excluded";
const counted = (t: Transaction) => t.countedAmountMinor ?? t.amountMinor;

function Row({ t, category, onOpen }: { t: Transaction; category: Category | undefined; onOpen: () => void }) {
  const accounts = useAccounts();
  const excluded = isExcluded(t, category);
  const merchant = merchantLabel(t);
  const amountChanged = t.countedAmountMinor !== null && t.countedAmountMinor !== t.amountMinor;
  return (
    <li>
      <button type="button" className="flex min-h-[62px] w-full items-center gap-3 border-b border-divider px-5 py-2.5 text-left hover:bg-surface" onClick={onOpen}>
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-line bg-surface text-[13px] font-medium text-fg/80" aria-hidden="true">
          {merchant.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{merchant}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted">
            <AccountBadge account={accounts.data?.byId.get(t.accountId)} />
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
}

export function Transactions() {
  const current = monthOf(londonToday());
  const today = londonToday();
  const [month, setMonth] = useState(current);
  const txns = useMonthTransactions(month);
  const summary = useSummary(month);
  const categories = useCategories();
  const [open, setOpen] = useState<Transaction | null>(null);

  // Replaced pending rows no longer count, and their posted versions are listed.
  const rows = (txns.data?.pages.flatMap((p) => p.transactions) ?? []).filter((t) => t.vanishedAt === null);
  const categoryOf = (t: Transaction) => (t.categoryId === null ? undefined : categories.data?.byId.get(t.categoryId));
  const days = new Map<string, Transaction[]>();
  for (const t of rows) days.set(t.txnDate, [...(days.get(t.txnDate) ?? []), t]);
  const complete = txns.data !== undefined && !txns.hasNextPage;

  return (
    <TabScreen
      title="Transactions"
      action={
        <div className="flex items-center" role="group" aria-label="Month">
          <button type="button" aria-label="Previous month" className="grid size-11 place-items-center text-fg/80" onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft size={18} />
          </button>
          <span className="min-w-9 text-center" aria-live="polite">
            {monthName(month).slice(0, 3)}
            {month.slice(0, 4) !== current.slice(0, 4) && ` ${month.slice(0, 4)}`}
          </span>
          <button type="button" aria-label="Next month" className="grid size-11 place-items-center text-fg/80 disabled:opacity-30" disabled={month >= current} onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight size={18} />
          </button>
        </div>
      }
    >
      {txns.isError ? (
        <p role="alert" className="mx-5 mt-4 text-over-fg">
          Couldn't load transactions.{" "}
          <button type="button" className="min-h-11 font-medium text-accent-fg underline" onClick={() => void txns.refetch()}>
            Try again
          </button>
        </p>
      ) : txns.isPending ? (
        <div className="mt-4 flex flex-col gap-3 px-5" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : (
        <>
          <p className="mx-5 mt-2.5 text-[13px] text-muted">
            {rows.length === 0 ? "No transactions this month" : `${rows.length}${complete ? "" : "+"} ${rows.length === 1 ? "transaction" : "transactions"}`}
            {summary.data && ` · ${formatPounds(summary.data.spentMinor)} counted towards budget`}
          </p>
          {[...days].map(([date, list]) => (
            <section key={date} aria-label={formatShortDate(date)}>
              <div className="flex items-baseline justify-between px-5 pt-5 pb-1.5 text-[11.5px] font-medium tracking-[0.08em] text-muted uppercase">
                <h2>{date === today ? `Today · ${formatShortDate(date)}` : formatShortDate(date)}</h2>
                <span className="tracking-normal normal-case">{formatSigned(list.filter((t) => !isExcluded(t, categoryOf(t))).reduce((sum, t) => sum + counted(t), 0), "GBP")}</span>
              </div>
              <ul>
                {list.map((t) => (
                  <Row key={t.id} t={t} category={categoryOf(t)} onOpen={() => setOpen(t)} />
                ))}
              </ul>
            </section>
          ))}
          {txns.hasNextPage && (
            <div className="px-5 pt-4">
              <Button kind="secondary" className="w-full" onClick={() => void txns.fetchNextPage()} disabled={txns.isFetchingNextPage}>
                {txns.isFetchingNextPage ? "Loading…" : "Show more"}
              </Button>
            </div>
          )}
        </>
      )}
      <TransactionSheet txn={open} onClose={() => setOpen(null)} />
    </TabScreen>
  );
}
