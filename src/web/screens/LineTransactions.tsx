import { PushedScreen } from "../components/Screen";
import { TransactionList } from "../components/TransactionList";
import type { Transaction } from "../api";
import { monthName } from "../dates";
import { LINE_NAMES, findLine, isLowerBound, type LineCategory } from "../lines";
import { formatPounds } from "../money";
import { useCategories, useLineTransactions, useSummary } from "../queries";
import type { Back } from "../routes";

// The transactions that counted towards one Home line in a month: a category, Misc, uncategorised
// pending charges, or a Posted or Pending pill. The figures come from the month summary, as on
// Home, so they match what was tapped: "£spent of £allocated", or the amount ("at least" for pending).

/** Rows count in the month of their counted date, so they're grouped by it too. */
const countedDate = (t: Transaction) => t.countedDate ?? t.txnDate;

export function LineTransactions({ back, month, category }: { back: Back; month: string; category: LineCategory }) {
  const txns = useLineTransactions(month, category);
  const summary = useSummary(month);
  const byId = useCategories().data?.byId;

  const line = summary.data && byId ? findLine(summary.data, byId, category) : undefined;
  const name = line?.name ?? (typeof category === "number" ? (byId?.get(category)?.name ?? "Category") : LINE_NAMES[category]);
  const amount = line && (line.allocatedMinor !== null ? `${formatPounds(line.spentMinor)} of ${formatPounds(line.allocatedMinor)}` : `${isLowerBound(category) ? "at least " : ""}${formatPounds(line.spentMinor)}`);

  return (
    <PushedScreen back={back} title={name}>
      <p className="mx-5 mt-1 text-[13px] text-muted">
        {monthName(month)}
        {amount && ` · ${amount}`}
        {category === "misc" && " · posted uncategorised and unallocated spending"}
        {category === "uncategorised-pending" && " · you can sort these once they post"}
        {category === "posted" && " · counted towards budget"}
        {category === "pending" && " · counted towards budget, some may arrive late"}
      </p>
      <TransactionList query={txns} dateOf={countedDate} empty="Nothing counted here this month" />
    </PushedScreen>
  );
}
