import { useState } from "react";
import type { Transaction } from "../api";
import { TabScreen } from "../components/Screen";
import { TransactionList } from "../components/TransactionList";
import { ChevronLeft, ChevronRight } from "../components/ui";
import { addMonths, londonToday, monthName, monthOf, yearSuffix } from "../dates";
import { formatPounds } from "../money";
import { useMonthTransactions, useSummary } from "../queries";

// The month's transactions by bank date (docs/ui-design.md, Transactions). Search and filters
// are a later backend slice.

/** Replaced pending rows no longer count, and their posted versions are listed. */
const notVanished = (t: Transaction) => t.vanishedAt === null;

export function Transactions() {
  const current = monthOf(londonToday());
  const [month, setMonth] = useState(current);
  const txns = useMonthTransactions(month);
  const summary = useSummary(month);

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
            {yearSuffix(month, current)}
          </span>
          <button type="button" aria-label="Next month" className="grid size-11 place-items-center text-fg/80 disabled:opacity-30" disabled={month >= current} onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight size={18} />
          </button>
        </div>
      }
    >
      <TransactionList
        query={txns}
        keep={notVanished}
        empty="No transactions this month"
        extra={summary.data && ` · ${formatPounds(summary.data.spentMinor)} counted towards budget`}
      />
    </TabScreen>
  );
}
