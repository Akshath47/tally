import { useState } from "react";
import type { Transaction } from "../api";
import { TabScreen } from "../components/Screen";
import { TransactionList } from "../components/TransactionList";
import { MonthStepper } from "../components/MonthStepper";
import { londonToday, monthName, monthOf, yearSuffix } from "../dates";
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
        <MonthStepper month={month} current={current} onStep={setMonth}>
          <span className="min-w-9 text-center" aria-live="polite">
            {monthName(month).slice(0, 3)}
            {yearSuffix(month, current)}
          </span>
        </MonthStepper>
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
