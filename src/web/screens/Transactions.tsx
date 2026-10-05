import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getTransactions, type Transaction } from "../api";
import { QueryStatus, TabScreen } from "../components/Screen";
import { Sheet } from "../components/Sheet";
import { formatShortDate } from "../dates";
import { formatMoney, merchantLabel, transactionStatus } from "../format";

// A plain list until the Transactions step; rows open the bottom sheet.

const LIMIT = 50;

function TransactionSheet({ txn, onDismiss }: { txn: Transaction | null; onDismiss: () => void }) {
  return (
    <Sheet open={txn !== null} onDismiss={onDismiss} labelledBy="txn-sheet-title">
      {txn && (
        <div className="flex flex-col gap-4 overflow-y-auto px-4 pt-3 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="txn-sheet-title" className="truncate text-[19px] font-medium">
                {merchantLabel(txn)}
              </h2>
              <p className="text-meta text-muted">
                {transactionStatus(txn)} · {formatShortDate(txn.txnDate)}
              </p>
            </div>
            <p className={`text-[28px] font-extralight ${txn.isPending ? "text-muted italic" : ""}`}>{formatMoney(txn.amountMinor, txn.currency)}</p>
          </div>
          <button type="button" className="min-h-[52px] rounded-button border border-divider bg-raised font-medium" onClick={onDismiss}>
            Close
          </button>
        </div>
      )}
    </Sheet>
  );
}

export function Transactions() {
  const txns = useQuery({ queryKey: ["transactions", "list"], queryFn: () => getTransactions({ limit: LIMIT }) });
  const [open, setOpen] = useState<Transaction | null>(null);

  return (
    <TabScreen title="Transactions">
      <div className="mx-5">
        <QueryStatus query={txns} what="transactions" empty={txns.data?.transactions.length === 0 && "No transactions yet."} />
      </div>
      <ul className="mx-4 mt-3 divide-y divide-divider overflow-hidden rounded-card border border-divider bg-surface">
        {txns.data?.transactions.map((t) => {
          const status = transactionStatus(t);
          return (
          // A vanished row no longer counts; it's struck through so it doesn't read as a duplicate charge.
          <li key={t.id} className={t.vanishedAt ? "line-through opacity-50" : undefined}>
            <button type="button" className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-2 text-left hover:bg-raised" onClick={() => setOpen(t)}>
              <span className="min-w-0">
                <span className="block truncate">{merchantLabel(t)}</span>
                <span className="block text-meta text-muted">
                  {formatShortDate(t.txnDate)}
                  {status !== "Posted" && ` · ${status}`}
                </span>
              </span>
              <span className={`shrink-0 ${t.isPending ? "text-muted italic" : ""}`}>{formatMoney(t.amountMinor, t.currency)}</span>
            </button>
          </li>
          );
        })}
      </ul>
      <TransactionSheet txn={open} onDismiss={() => setOpen(null)} />
    </TabScreen>
  );
}
