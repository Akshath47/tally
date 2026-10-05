import { useMemo, useState } from "react";
import type { Transaction } from "../api";
import { LoadError, PushedScreen } from "../components/Screen";
import { TransactionSheet } from "../components/TransactionSheet";
import { monthName } from "../dates";
import { formatPounds } from "../money";
import { useCategories, useLineTransactions, useSummary } from "../queries";
import type { Back, LineCategory } from "../routes";
import { budgetLines } from "./Home";
import { ShowMore, TransactionDays, TransactionsLoading } from "./Transactions";

// The transactions that counted towards one Home line in a month: a category, or Misc. The
// figures come from the month summary, as on Home, so they match the row that was tapped.

export function Line({ back, month, category }: { back: Back; month: string; category: LineCategory }) {
  const txns = useLineTransactions(month, category);
  const summary = useSummary(month);
  const categories = useCategories();
  const [open, setOpen] = useState<Transaction | null>(null);

  const byId = categories.data?.byId;
  const line = summary.data && byId ? budgetLines(summary.data, byId).find((l) => l.category === category) : undefined;
  const name = line?.name ?? (category === "misc" ? "Misc" : (byId?.get(category)?.name ?? "Category"));
  const rows = useMemo(() => txns.data?.pages.flatMap((p) => p.transactions) ?? [], [txns.data]);
  const complete = txns.data !== undefined && !txns.hasNextPage;

  return (
    <PushedScreen back={back} title={name}>
      <p className="mx-5 mt-1 text-[13px] text-muted">
        {monthName(month)}
        {line && ` · ${formatPounds(line.spentMinor)} of ${formatPounds(line.allocatedMinor)}`}
        {category === "misc" && " · uncategorised and unallocated spending"}
      </p>
      {txns.isError ? (
        <LoadError what="transactions" onRetry={() => void txns.refetch()} />
      ) : txns.isPending ? (
        <TransactionsLoading />
      ) : (
        <>
          <p className="mx-5 mt-2.5 text-[13px] text-muted">
            {rows.length === 0 ? "Nothing counted here this month" : `${rows.length}${complete ? "" : "+"} ${rows.length === 1 ? "transaction" : "transactions"}`}
          </p>
          <TransactionDays rows={rows} onOpen={setOpen} />
          {txns.hasNextPage && <ShowMore onClick={() => void txns.fetchNextPage()} loading={txns.isFetchingNextPage} />}
        </>
      )}
      <TransactionSheet txn={open} onClose={() => setOpen(null)} />
    </PushedScreen>
  );
}
