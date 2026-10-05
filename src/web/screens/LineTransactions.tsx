import { PushedScreen } from "../components/Screen";
import { TransactionList } from "../components/TransactionList";
import type { Transaction } from "../api";
import { monthName } from "../dates";
import { budgetLines, type LineCategory } from "../lines";
import { formatPounds } from "../money";
import { useCategories, useLineTransactions, useSummary } from "../queries";
import type { Back } from "../routes";

// The transactions that counted towards one Home line in a month: a category, or Misc. The
// figures come from the month summary, as on Home, so they match the row that was tapped.

/** Rows count in the month of their counted date, so they're grouped by it too. */
const countedDate = (t: Transaction) => t.countedDate ?? t.txnDate;

export function LineTransactions({ back, month, category }: { back: Back; month: string; category: LineCategory }) {
  const txns = useLineTransactions(month, category);
  const summary = useSummary(month);
  const byId = useCategories().data?.byId;

  const line = summary.data && byId ? budgetLines(summary.data, byId).find((l) => l.category === category) : undefined;
  const name = line?.name ?? (category === "misc" ? "Misc" : (byId?.get(category)?.name ?? "Category"));

  return (
    <PushedScreen back={back} title={name}>
      <p className="mx-5 mt-1 text-[13px] text-muted">
        {monthName(month)}
        {line && ` · ${formatPounds(line.spentMinor)} of ${formatPounds(line.allocatedMinor)}`}
        {category === "misc" && " · uncategorised and unallocated spending"}
      </p>
      <TransactionList query={txns} dateOf={countedDate} empty="Nothing counted here this month" />
    </PushedScreen>
  );
}
