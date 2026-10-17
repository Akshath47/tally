import { useState } from "react";
import { ApiError, type MerchantHistory, type Transaction } from "../api";
import { ScreenError } from "../components/ScreenError";
import { TransactionSheet } from "../components/TransactionSheet";
import { AccountBadge, ChevronRight, Clock, Pencil, Skeleton } from "../components/ui";
import { formatDayMonth, formatShortDate, londonToday, monthName } from "../dates";
import { formatPounds, formatSigned, formatUnsigned } from "../money";
import { countsAs, isEdited } from "../overrides";
import { fraction } from "../pace";
import { useAccounts, useCategories, useMerchant } from "../queries";
import { BackLink, Link } from "../router";
import type { Back } from "../routes";

// One merchant across both accounts (docs/insights-ui-brief.md, Screen 4): its rule, six months
// aligned with Trends, and its last 20 transactions. The name is bank text: untrusted, truncated.

const card = "rounded-card border border-divider bg-surface";
const label = "text-[11.5px] font-medium tracking-[0.08em] text-muted uppercase";
const counted = (t: Transaction) => t.countedAmountMinor ?? t.amountMinor;

function Header({ m }: { m: MerchantHistory }) {
  const accounts = useAccounts().data?.byId;
  return (
    <div className="mx-5 mt-2 flex items-center gap-3.5">
      <span className="grid size-[52px] shrink-0 place-items-center rounded-[15px] border border-line bg-surface text-xl text-fg/80" aria-hidden="true">
        {m.name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0">
        <h1 className="truncate text-[26px] font-light tracking-[-0.02em]">{m.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
          {m.accountIds.map((id) => (
            <AccountBadge key={id} account={accounts?.get(id)} />
          ))}
          {m.firstSeenDate && `First seen ${formatDayMonth(m.firstSeenDate)}`}
        </div>
      </div>
    </div>
  );
}

function RuleTag({ m }: { m: MerchantHistory }) {
  const category = useCategories().data?.byId.get(m.categoryId ?? -1);
  const tag = "inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium";
  return (
    <div className="mx-5 mt-3.5 flex min-h-11 items-center">
      {m.categorySource === "rule" ? (
        <Link href="/rules" className={`${tag} border border-accent/35 bg-accent-tint text-accent-fg`}>
          {category?.name ?? "Category"}
          <span className="font-normal text-muted">· rule</span>
          <ChevronRight size={13} />
        </Link>
      ) : (
        <Link href="/rules" className={`${tag} border border-dashed border-line font-normal text-fg/85`}>
          No rule · goes to To sort
          <ChevronRight size={13} />
        </Link>
      )}
    </div>
  );
}

function Figures({ m }: { m: MerchantHistory }) {
  const fig = (value: string, caption: string) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-[22px] font-extralight tracking-[-0.02em]">{value}</span>
      <span className="text-[11.5px] text-muted">{caption}</span>
    </div>
  );
  return (
    <div className={`mx-4 mt-[18px] grid grid-cols-3 gap-2.5 p-4 ${card}`}>
      {fig(formatPounds(m.windowSpentMinor), "in 6 months")}
      {fig(String(m.windowVisits), m.windowVisits === 1 ? "visit" : "visits")}
      {m.windowVisits > 1 && m.averageChargeMinor !== null ? (
        fig(formatUnsigned(m.averageChargeMinor, "GBP"), "average")
      ) : m.windowVisits === 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="pt-1 text-[14.5px] font-medium">No visits</span>
          <span className="text-[11.5px] text-muted">in the last 6 months</span>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          <span className="pt-1 text-[14.5px] font-medium">First visit</span>
          <span className="text-[11.5px] text-muted">no average yet</span>
        </div>
      )}
    </div>
  );
}

function History({ m }: { m: MerchantHistory }) {
  const max = Math.max(1, ...m.months.map((x) => x.spentMinor));
  const last = m.months.length - 1;
  const describe = m.months.map((x, i) => `${monthName(x.month)}${i === last ? " so far" : ""} ${formatPounds(x.spentMinor)}, ${x.visits === 1 ? "1 visit" : `${x.visits} visits`}`).join("; ");
  return (
    <section className={`mx-4 mt-2.5 p-4 ${card}`} aria-labelledby="hist-h">
      <div className="flex items-baseline justify-between">
        <h2 id="hist-h" className={label}>
          Per month
        </h2>
        <span className="text-[11.5px] text-muted">Same months as Trends</span>
      </div>
      <div role="img" aria-label={describe} className="mt-3.5 grid h-[120px] grid-cols-6 items-end gap-2.5">
        {m.months.map((x, i) =>
          x.spentMinor > 0 ? (
            <div key={x.month} className={`rounded-t-[5px] rounded-b-[2px] ${i === last ? "bg-accent" : "bg-past"}`} style={{ height: `${fraction(x.spentMinor, max) * 100}%` }} />
          ) : (
            <div key={x.month} className="h-px bg-line" />
          ),
        )}
      </div>
      <div className="mt-2 grid grid-cols-6 gap-2.5 text-center text-[11px] leading-[1.45] text-muted" aria-hidden="true">
        {m.months.map((x, i) => (
          <span key={x.month} className={i === last ? "text-accent-fg" : ""}>
            {monthName(x.month).slice(0, 3)}
            {x.visits > 0 && (
              <>
                <br />
                <span className="text-fg">{formatPounds(x.spentMinor)}</span>
                <br />
                {i === last && m.months.slice(0, last).some((p) => p.visits > 0) ? "so far" : x.visits === 1 ? "1 visit" : `${x.visits} visits`}
              </>
            )}
          </span>
        ))}
      </div>
    </section>
  );
}

function Recent({ rows }: { rows: Transaction[] }) {
  const accounts = useAccounts().data?.byId;
  const byId = useCategories().data?.byId;
  const [open, setOpen] = useState<Transaction | null>(null);
  const today = londonToday();
  return (
    <section className="mt-6">
      <div className="mx-5 mb-2 flex items-baseline justify-between">
        <h2 className={label}>Recent</h2>
        {rows.length === 20 && <span className="text-[11.5px] text-muted">Last 20</span>}
      </div>
      <ul className={`mx-4 overflow-hidden ${card}`}>
        {rows.map((t) => {
          const category = t.categoryId === null ? undefined : byId?.get(t.categoryId);
          const excluded = countsAs(t, category?.kind) === "none";
          const changed = t.countedAmountMinor !== null && t.countedAmountMinor !== t.amountMinor;
          return (
            <li key={t.id} className="border-b border-divider last:border-b-0">
              <button type="button" className="flex min-h-[62px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-raised/50" onClick={() => setOpen(t)}>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px]">{formatShortDate(t.countedDate ?? t.txnDate, today)}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                    <AccountBadge account={accounts?.get(t.accountId)} />
                    {category?.name ?? "Uncategorised"}
                    {excluded ? " · excluded" : category?.kind === "tracked" ? " · tracked" : ""}
                    {t.isPending && (
                      <span className="inline-flex items-center gap-1 text-fg/80">
                        <Clock size={11} />
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
                  <span className={`block text-[14.5px] ${t.isPending ? "text-muted italic" : excluded ? "text-muted" : ""}`}>{formatSigned(counted(t), t.currency)}</span>
                  {changed && <span className="block text-[11px] text-muted line-through">{formatUnsigned(t.amountMinor, t.currency)}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <TransactionSheet txn={open} onClose={() => setOpen(null)} />
    </section>
  );
}

function Loading() {
  return (
    <div aria-busy="true">
      <div className="mx-5 mt-2 flex items-center gap-3.5">
        <Skeleton className="size-[52px] rounded-[15px]" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
      </div>
      <Skeleton className="mx-5 mt-5 h-9 w-36 rounded-full" />
      <div className={`mx-4 mt-5 h-[76px] bg-surface/60 ${card}`} />
      <div className={`mx-4 mt-2.5 h-[180px] bg-surface/60 ${card}`} />
    </div>
  );
}

export function Merchant({ back, merchantKey }: { back: Back; merchantKey: string }) {
  const merchant = useMerchant(merchantKey);
  const m = merchant.data;
  const missing = merchant.error instanceof ApiError && merchant.error.status === 404;
  return (
    <>
      <header className="pt-safe pr-3 pl-2">
        <BackLink {...back} />
      </header>
      {m ? (
        <>
          <Header m={m} />
          <RuleTag m={m} />
          <Figures m={m} />
          <History m={m} />
          {m.recent.length > 0 && <Recent rows={m.recent} />}
        </>
      ) : missing ? (
        <div className="mx-8 mt-24 flex flex-col items-center gap-2 text-center">
          <h1 className="text-[22px] font-light">No transactions from this merchant</h1>
          <p className="text-[13.5px] leading-normal text-muted">The link may be out of date, or its transactions were linked to another account.</p>
          <BackLink {...back} />
        </div>
      ) : merchant.isError ? (
        <ScreenError what="this merchant" error={merchant.error} at={merchant.errorUpdatedAt} onRetry={() => void merchant.refetch()} retrying={merchant.isFetching} />
      ) : (
        <Loading />
      )}
    </>
  );
}
