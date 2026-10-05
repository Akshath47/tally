import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError, putOverallBudget, type Category, type MonthSummary } from "../api";
import { TabScreen } from "../components/Screen";
import { AccountBadge, ArrowUp, Button, Check, ChevronRight, FieldError, Flag, Refresh, Skeleton, Spinner } from "../components/ui";
import { addMonths, londonToday, monthName, monthOf } from "../dates";
import { formatTimestamp } from "../format";
import { formatPounds, parseMoneyInput } from "../money";
import { ageText, barState, fraction, remainingText } from "../pace";
import { useAccounts, useCategories, usePreviousSummaries, useSummary } from "../queries";
import { Link } from "../router";
import { lineHref, type LineCategory } from "../routes";

// The five-second glance (docs/ui-design.md, Home).

const RING_R = 88;
const RING_C = 2 * Math.PI * RING_R;

function ToSortChip({ count }: { count: number }) {
  return (
    <Link href="/to-sort" className="flex min-h-11 items-center" aria-label={`${count} to sort`}>
      <span className="inline-flex h-9 items-center gap-[7px] rounded-full border border-accent/35 bg-accent-tint px-[13px] text-[13px] font-medium text-accent-fg">
        <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-[5px] text-[10.5px] font-semibold text-on-accent">{count}</span>
        to sort
      </span>
    </Link>
  );
}

function SettingsLink() {
  return (
    <Link href="/categories" aria-label="Categories and settings" className="grid size-11 place-items-center rounded-button text-fg/85 hover:bg-raised hover:text-fg">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
    </Link>
  );
}

/** "Updated 3h ago · both accounts", or the loading / failed line. */
function Freshness({ summary, enabledAccounts }: { summary: ReturnType<typeof useSummary>; enabledAccounts: number }) {
  let dot = "bg-accent";
  let text: string;
  if (summary.isPending) {
    text = "Loading your budget…";
  } else if (summary.isError) {
    dot = "bg-over";
    text = summary.data ? `Couldn't refresh · last loaded ${formatTimestamp(new Date(summary.dataUpdatedAt).toISOString())}` : "Couldn't refresh";
  } else {
    const at = summary.data.lastDataChangeAt;
    const scope = enabledAccounts === 2 ? " · both accounts" : enabledAccounts > 2 ? ` · ${enabledAccounts} accounts` : "";
    text = at ? `Updated ${ageText(at)}${scope}` : "Not imported yet";
  }
  return (
    <Link href="/accounts" className="inline-flex min-h-[30px] items-center gap-1.5 text-[12.5px] text-muted hover:text-fg" role={summary.isPending ? "status" : undefined}>
      {summary.isPending ? <Spinner size={12} /> : <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />}
      {text}
    </Link>
  );
}

function Ring({ postedMinor, pendingMinor, overallMinor }: { postedMinor: number; pendingMinor: number; overallMinor: number }) {
  const over = postedMinor + pendingMinor > overallMinor;
  const posted = fraction(postedMinor, overallMinor) * RING_C;
  const pending = Math.min(fraction(pendingMinor, overallMinor) * RING_C, RING_C - posted);
  return (
    <svg width="200" height="200" viewBox="0 0 200 200" aria-hidden="true" className="-rotate-90">
      <defs>
        <pattern id="ring-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" className="fill-accent/30" />
          <rect width="2" height="5" className="fill-accent" />
        </pattern>
      </defs>
      <circle cx="100" cy="100" r={RING_R} fill="none" strokeWidth="9" className="stroke-line" />
      {over ? (
        <circle cx="100" cy="100" r={RING_R} fill="none" strokeWidth="9" className="stroke-over" />
      ) : (
        <>
          <circle cx="100" cy="100" r={RING_R} fill="none" strokeWidth="9" className="stroke-accent" strokeDasharray={`${posted} ${RING_C}`} />
          {pending > 0 && <circle cx="100" cy="100" r={RING_R} fill="none" strokeWidth="9" stroke="url(#ring-hatch)" strokeDasharray={`${pending} ${RING_C}`} strokeDashoffset={-posted} />}
        </>
      )}
    </svg>
  );
}

function Pace({ s }: { s: MonthSummary & { leftMinor: number } }) {
  if (s.daysRemaining === null || s.perWeekMinor === null) return null;
  if (s.leftMinor <= 0) {
    const toGo = s.daysRemaining === 1 ? "today to go" : `${s.daysRemaining} days to go`;
    return <p className="mt-3 text-center text-muted">Budget used up with {toGo}. Anything more adds to the overspend.</p>;
  }
  return (
    <p className="mt-3 text-center">
      <span className="font-medium">{formatPounds(s.perWeekMinor)}/week</span>{" "}
      <span className="text-muted">{s.daysRemaining === 1 ? "for today" : `for the remaining ${remainingText(s.daysRemaining)}`}</span>
    </p>
  );
}

function Pills({ s }: { s: MonthSummary }) {
  if (s.pendingSpentMinor === 0) return <p className="mt-3 text-center text-meta text-muted">No pending charges</p>;
  const pill = "inline-flex h-8 items-center gap-[7px] rounded-full border border-divider bg-surface px-3 text-[12.5px]";
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-2 px-5">
      <span className={pill}>
        <span className="size-[9px] rounded-[3px] bg-accent" aria-hidden="true" />
        Posted <span className="font-medium">{formatPounds(s.spentMinor - s.pendingSpentMinor)}</span>
      </span>
      {/* Lunch Flow doesn't send every pending charge, so this is a lower bound. */}
      <Link href="/transactions" className={`${pill} min-h-11 border-transparent bg-transparent p-0`}>
        <span className={pill}>
          <span className="hatch size-[9px] rounded-[3px]" aria-hidden="true" />
          Pending <span className="text-muted">at least</span> <span className="font-medium">{formatPounds(s.pendingSpentMinor)}</span>
        </span>
      </Link>
    </div>
  );
}

export type Line = { category: LineCategory; name: string; note?: string; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number };

/** Budgeted categories with an allocation, biggest first, then Misc: the unallocated pot. */
export function budgetLines(s: MonthSummary, byId: Map<number, Category>): Line[] {
  const lines: Line[] = [];
  const misc: Line = { category: "misc", name: "Misc", note: "unallocated", spentMinor: 0, pendingSpentMinor: 0, allocatedMinor: s.miscMinor ?? 0 };
  for (const c of s.categories) {
    if (c.kind === "tracked") continue;
    if (c.categoryId !== null && c.allocatedMinor > 0) {
      lines.push({ ...c, category: c.categoryId, name: byId.get(c.categoryId)?.name ?? "Category" });
    } else {
      misc.spentMinor += c.spentMinor;
      misc.pendingSpentMinor += c.pendingSpentMinor;
    }
  }
  lines.sort((a, b) => b.allocatedMinor - a.allocatedMinor);
  if (misc.allocatedMinor > 0 || misc.spentMinor !== 0) lines.push(misc);
  return lines;
}

/** Taps through to the transactions that counted towards the line. */
function CategoryRow({ line, month }: { line: Line; month: string }) {
  const state = barState(line.spentMinor, line.allocatedMinor);
  const posted = fraction(line.spentMinor - line.pendingSpentMinor, line.allocatedMinor);
  const pending = Math.min(fraction(line.pendingSpentMinor, line.allocatedMinor), 1 - posted);
  const fill = { ok: "bg-accent", near: "bg-warn", over: "bg-over" }[state];
  return (
    <li className="border-b border-divider last:border-b-0">
      <Link href={lineHref(month, line.category)} className="-mx-4 flex flex-col gap-2 px-4 py-[11px] hover:bg-raised/50">
      <div className="flex items-center gap-2">
        <span>{line.name}</span>
        {line.note && <span className="text-[11.5px] text-muted">{line.note}</span>}
        {state === "near" && <Flag tone="warn">{formatPounds(line.allocatedMinor - line.spentMinor)} left</Flag>}
        {state === "over" && (
          <Flag tone="over">
            <ArrowUp size={10} />
            {formatPounds(line.spentMinor - line.allocatedMinor)} over
          </Flag>
        )}
        <span className="ml-auto whitespace-nowrap">
          <span className={`font-medium ${state === "over" ? "text-over-fg" : ""}`}>{formatPounds(line.spentMinor)}</span>{" "}
          <span className="text-muted">/ {formatPounds(line.allocatedMinor)}</span>
        </span>
        <ChevronRight size={14} className="-mr-1 shrink-0 text-muted" />
      </div>
      <div className="flex h-1 gap-px overflow-hidden rounded-sm bg-line" aria-hidden="true">
        {state === "over" ? (
          <div className="w-full bg-over" />
        ) : (
          <>
            {posted > 0 && <div className={fill} style={{ width: `${posted * 100}%` }} />}
            {pending > 0 && <div className={state === "near" ? "hatch-warn" : "hatch"} style={{ width: `${pending * 100}%` }} />}
          </>
        )}
      </div>
      </Link>
    </li>
  );
}

function Dashboard({ s, byId }: { s: MonthSummary & { overallMinor: number; leftMinor: number }; byId: Map<number, Category> }) {
  const over = s.leftMinor < 0;
  const lines = budgetLines(s, byId);
  return (
    <>
      <div className="flex flex-col items-center px-5 pt-1.5">
        <div className="relative size-[200px]">
          <Ring postedMinor={s.spentMinor - s.pendingSpentMinor} pendingMinor={s.pendingSpentMinor} overallMinor={s.overallMinor} />
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <div className="text-xs text-muted">Spent in {monthName(s.month)}</div>
            <div className="text-[46px] leading-[1.1] font-extralight tracking-[-0.035em]">{formatPounds(s.spentMinor)}</div>
            <div className={`mt-0.5 text-sm ${over ? "text-over-fg" : ""}`}>
              {over ? `${formatPounds(-s.leftMinor)} over this month` : `${formatPounds(s.leftMinor)} left this month`}
            </div>
            <div className="mt-0.5 text-[11.5px] text-muted">of {formatPounds(s.overallMinor)}</div>
          </div>
        </div>
        <Pace s={s} />
      </div>
      <Pills s={s} />
      {lines.length > 0 && (
        <section className="mx-5 mt-[22px]" aria-labelledby="home-categories">
          <h2 id="home-categories" className="text-base font-medium">
            Categories
          </h2>
          <ul className="mt-2 rounded-card border border-divider bg-surface px-4 py-0.5">
            {lines.map((l) => (
              <CategoryRow key={l.category} line={l} month={s.month} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Loading() {
  return (
    <div aria-busy="true">
      <div className="flex flex-col items-center pt-1.5">
        <div className="relative grid size-[200px] place-items-center">
          <svg width="200" height="200" viewBox="0 0 200 200" aria-hidden="true" className="absolute inset-0">
            <circle cx="100" cy="100" r={RING_R} fill="none" strokeWidth="9" className="stroke-surface" />
          </svg>
          <div className="flex flex-col items-center gap-2.5">
            <Skeleton className="h-[34px] w-[120px]" />
            <Skeleton className="h-3 w-[90px]" />
          </div>
        </div>
        <Skeleton className="mt-4 h-3 w-[200px]" />
      </div>
      <div className="mt-4 flex justify-center gap-2">
        <Skeleton className="h-8 w-[110px] rounded-full" />
        <Skeleton className="h-8 w-[140px] rounded-full" />
      </div>
      <div className="mx-5 mt-[26px] flex flex-col gap-5 rounded-card border border-divider bg-surface/60 px-4 py-3.5">
        {["w-[70px]", "w-[90px]", "w-20", "w-[60px]"].map((w) => (
          <div key={w} className="flex flex-col gap-[9px]">
            <div className="flex justify-between">
              <Skeleton className={`h-3 ${w}`} />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadError({ error, at, onRetry, retrying }: { error: unknown; at: number; onRetry: () => void; retrying: boolean }) {
  const status = error instanceof ApiError ? error.status : null;
  return (
    <div role="alert" className="mx-6 mt-[110px] flex flex-col items-center gap-2.5 text-center">
      <span className="grid size-16 place-items-center rounded-full border border-over/40 bg-over-tint text-over-fg">
        <Refresh size={26} />
      </span>
      <h2 className="mt-2 text-[22px] font-light">Tally couldn't load your budget</h2>
      <p className="text-[13.5px] leading-normal text-muted">
        {status ? "The server didn't respond." : "Tally couldn't reach the server."} Your data is safe and nothing was changed. Check your connection and try again.
      </p>
      <Button className="mt-2.5 min-h-[50px] px-7" onClick={onRetry} disabled={retrying}>
        {retrying ? "Trying…" : "Try again"}
      </Button>
      <Link href="/accounts" className="inline-flex min-h-11 items-center text-[13.5px] text-accent-fg">
        Check account status
      </Link>
      <div className="text-[11.5px] text-subtle">
        {status ? `Error ${status}` : "No connection"} · {formatTimestamp(new Date(at).toISOString())}
      </div>
    </div>
  );
}

function FirstRun({ s, month }: { s: MonthSummary; month: string }) {
  const accounts = useAccounts();
  const [lastMonth, monthBefore] = usePreviousSummaries(month);
  const [text, setText] = useState("");
  const amount = parseMoneyInput(text);
  const save = useMutation({ mutationFn: putOverallBudget });
  const enabled = accounts.data?.all.filter((a) => a.importEnabled) ?? [];

  return (
    <>
      {enabled.length > 0 && (
        <div className="mx-4 mt-3.5 flex items-center gap-2.5 rounded-button border border-accent/20 bg-accent-tint/70 px-3.5 py-[11px] text-[12.5px] leading-snug">
          <Check size={16} className="shrink-0 text-accent-fg" />
          <span className="flex flex-wrap items-center gap-1">
            {enabled.map((a, i) => (
              <span key={a.id} className="inline-flex items-center gap-1">
                {i > 0 && (i === enabled.length - 1 ? "and " : ", ")}
                <AccountBadge account={a} />
              </span>
            ))}
            connected
          </span>
        </div>
      )}
      <div className="relative mx-auto mt-[22px] grid size-[150px] place-items-center">
        <svg width="150" height="150" viewBox="0 0 150 150" aria-hidden="true" className="absolute inset-0">
          <circle cx="75" cy="75" r="66" fill="none" strokeWidth="7" strokeDasharray="3 7" className="stroke-line" />
        </svg>
        <span className="text-center text-[12.5px] leading-snug text-muted">
          No budget
          <br />
          yet
        </span>
      </div>
      <form
        className="mx-4 mt-[22px] rounded-card border border-divider bg-surface p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (amount) save.mutate(amount);
        }}
      >
        <label htmlFor="first-budget" className="font-medium">
          How much do you want to spend each month?
        </label>
        <p className="mt-1 text-[12.5px] leading-normal text-muted">One figure for everything, bills included. You can split it into categories next.</p>
        <div className="mt-3 flex items-baseline gap-1 border-b border-accent pb-1">
          <span className="text-[32px] font-extralight text-muted">£</span>
          <input
            id="first-budget"
            inputMode="decimal"
            autoComplete="off"
            placeholder="1,800"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full bg-transparent p-0 text-[42px] font-extralight tracking-[-0.03em] outline-none placeholder:text-muted/50"
          />
        </div>
        {lastMonth?.data && monthBefore?.data && (
          <p className="mt-2.5 text-[12.5px] text-muted">
            For reference: you spent {formatPounds(lastMonth.data.spentMinor)} in {monthName(addMonths(month, -1))} and {formatPounds(monthBefore.data.spentMinor)} in{" "}
            {monthName(addMonths(month, -2))}.
          </p>
        )}
        <div className="mt-2 empty:hidden">
          {text !== "" && !amount && <FieldError>Enter an amount in pounds, like 1,800 or 1800.50.</FieldError>}
          {save.isError && <FieldError>Couldn't save the budget. Try again.</FieldError>}
        </div>
        <Button type="submit" className="mt-3.5 min-h-[52px] w-full text-[15.5px]" disabled={!amount || save.isPending}>
          {save.isPending ? "Saving…" : "Set budget"}
        </Button>
      </form>
      <ol className="mx-[22px] mt-[18px] flex flex-col">
        {["Set your monthly budget", "Allocate to categories (optional)", `Sort ${s.inboxCount} uncategorised transactions`].map((step, i) => (
          <li key={step} className={`flex min-h-9 items-center gap-3 ${i === 0 ? "" : "text-muted"}`}>
            <span className={`grid size-[22px] place-items-center rounded-full border text-[11px] ${i === 0 ? "border-accent text-accent-fg" : "border-line"}`}>{i + 1}</span>
            {step}
          </li>
        ))}
      </ol>
    </>
  );
}

export function Home() {
  const month = monthOf(londonToday());
  const summary = useSummary(month);
  const categories = useCategories();
  const accounts = useAccounts();
  const s = summary.data;
  const enabledAccounts = accounts.data?.all.filter((a) => a.importEnabled).length ?? 0;

  if (s && s.overallMinor === null) {
    return (
      <>
        <header className="pt-safe px-5">
          <div className="text-[13px] text-muted">Welcome to Tally</div>
          <h1 className="mt-0.5 text-title">Set your budget</h1>
        </header>
        <FirstRun s={s} month={month} />
      </>
    );
  }

  return (
    <TabScreen
      title={monthName(month)}
      titleExtra={<Freshness summary={summary} enabledAccounts={enabledAccounts} />}
      action={
        <div className="flex items-center gap-1">
          {s && s.inboxCount > 0 && <ToSortChip count={s.inboxCount} />}
          <SettingsLink />
        </div>
      }
    >
      {s && s.overallMinor !== null && s.leftMinor !== null ? (
        <Dashboard s={{ ...s, overallMinor: s.overallMinor, leftMinor: s.leftMinor }} byId={categories.data?.byId ?? new Map()} />
      ) : summary.isError ? (
        <LoadError error={summary.error} at={summary.errorUpdatedAt} onRetry={() => void summary.refetch()} retrying={summary.isFetching} />
      ) : (
        <Loading />
      )}
    </TabScreen>
  );
}
