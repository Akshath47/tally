import type { ReactNode } from "react";
import type { MonthReview, ReviewCategory } from "../api";
import { MonthStepper } from "../components/MonthStepper";
import { PushedScreen } from "../components/Screen";
import { ScreenError } from "../components/ScreenError";
import { Flag, Skeleton } from "../components/ui";
import { addMonths, londonToday, monthName, monthOf, monthTitle } from "../dates";
import { formatPounds } from "../money";
import { fraction } from "../pace";
import { useCategories, useReview } from "../queries";
import { Link, navigate } from "../router";
import { lineHref, merchantHref, reviewHref, type Back } from "../routes";

// A completed month against the one before (docs/insights-ui-brief.md, Screen 2). Budgeted
// categories first, then Uncategorised, then tracked categories, which aren't in the total.

const card = "rounded-card border border-divider bg-surface";
const label = "text-[11.5px] font-medium tracking-[0.08em] text-muted uppercase";
const MINUS = "−";

function Tile({ month, totals, previous }: { month: string; totals: MonthReview["totals"]; previous?: boolean }) {
  const { spentMinor, overallMinor } = totals;
  return (
    <div className={`p-3.5 ${card}`}>
      <div className="text-xs text-muted">{monthName(month)}</div>
      <div className={`mt-0.5 text-[30px] font-extralight tracking-[-0.03em] ${previous ? "text-fg/75" : ""}`}>{formatPounds(spentMinor)}</div>
      {overallMinor === null ? (
        <div className="mt-0.5 text-[12.5px] text-muted">No budget</div>
      ) : (
        <>
          <div className="mt-0.5 text-[12.5px] text-muted">of {formatPounds(overallMinor)}</div>
          <div className={`text-[12.5px] ${spentMinor > overallMinor ? "text-over-fg" : "text-accent-fg"}`}>
            {spentMinor > overallMinor ? `${formatPounds(spentMinor - overallMinor)} over` : `${formatPounds(overallMinor - spentMinor)} under`}
          </div>
        </>
      )}
    </div>
  );
}

/** "+£45" in amber when spending went up, "−£20" in sage when it went down, nothing when unchanged. */
function Change({ minor }: { minor: number }) {
  if (minor === 0) return <span className="w-[62px]" />;
  return <span className={`w-[62px] text-right text-[12.5px] ${minor > 0 ? "text-warn-fg" : "text-accent-fg"}`}>{minor > 0 ? `+${formatPounds(minor)}` : `${MINUS}${formatPounds(-minor)}`}</span>;
}

function CategoryRow({ c, name, month, max, hasPrevious, muted }: { c: ReviewCategory; name: string; month: string; max: number; hasPrevious: boolean; muted?: boolean }) {
  const over = c.over && c.allocatedMinor !== null;
  return (
    <li className="border-b border-divider last:border-b-0">
      <Link href={c.categoryId === null ? "/to-sort" : lineHref(month, c.categoryId)} className="-mx-4 flex flex-col gap-1.5 px-4 py-[11px] hover:bg-raised/50">
        <span className="flex items-baseline text-[14.5px]">
          <span className={c.categoryId === null ? "text-fg/80" : ""}>{name}</span>
          {over && (
            <span className="ml-2">
              <Flag tone="over">{formatPounds(c.spentMinor - c.allocatedMinor!)} over</Flag>
            </span>
          )}
          <span className="ml-auto">{formatPounds(c.spentMinor)}</span>
          {hasPrevious && <Change minor={c.changeMinor} />}
        </span>
        <span className={`block h-1 rounded-full ${over ? "bg-over" : "bg-accent"} ${muted ? "opacity-60" : ""}`} style={{ width: `${fraction(Math.max(0, c.spentMinor), max) * 100}%` }} />
        {hasPrevious && <span className="block h-1 rounded-full bg-previous" style={{ width: `${fraction(Math.max(0, c.previousSpentMinor), max) * 100}%` }} />}
      </Link>
    </li>
  );
}

function Section({ title, note, legend, dashed, children }: { title: string; note?: string; legend?: ReactNode; dashed?: boolean; children: ReactNode }) {
  return (
    <section className="mt-[22px]">
      <div className="mx-5 mb-2 flex items-baseline justify-between">
        <h2 className={label}>{title}</h2>
        {legend ?? (note && <span className="text-[11.5px] text-muted">{note}</span>)}
      </div>
      <ul className={`mx-4 px-4 py-0.5 ${dashed ? "rounded-card border border-dashed border-line" : card}`}>{children}</ul>
    </section>
  );
}

function Legend({ month, previous }: { month: string; previous: string }) {
  const key = (swatch: string, text: string) => (
    <span className="inline-flex items-center gap-[5px]">
      <span className={`h-1 w-2.5 rounded-full ${swatch}`} aria-hidden="true" />
      {text}
    </span>
  );
  return (
    <span className="inline-flex gap-3 text-[11.5px] text-muted">
      {key("bg-accent", monthName(month).slice(0, 3))}
      {key("bg-previous", monthName(previous).slice(0, 3))}
    </span>
  );
}

function Body({ r }: { r: MonthReview }) {
  const byId = useCategories().data?.byId;
  const nameOf = (id: number | null) => (id === null ? "Uncategorised" : (byId?.get(id)?.name ?? "Category"));
  const spending = r.categories.filter((c) => c.kind !== "tracked");
  const tracked = r.categories.filter((c) => c.kind === "tracked" && (c.spentMinor !== 0 || c.previousSpentMinor !== 0));
  // Biggest first, Uncategorised last; categories with nothing in either month are left out.
  const budgeted = spending.filter((c) => c.categoryId !== null && (c.spentMinor !== 0 || c.previousSpentMinor !== 0 || c.allocatedMinor !== null)).sort((a, b) => b.spentMinor - a.spentMinor);
  const uncategorised = spending.find((c) => c.categoryId === null && (c.spentMinor !== 0 || c.previousSpentMinor !== 0));
  const rows = uncategorised ? [...budgeted, uncategorised] : budgeted;
  const maxOf = (list: ReviewCategory[]) => Math.max(1, ...list.flatMap((c) => [c.spentMinor, r.hasPrevious ? c.previousSpentMinor : 0]));
  const max = maxOf(rows);

  return (
    <>
      <div className="mx-4 mt-4 grid grid-cols-2 gap-2.5">
        <Tile month={r.month} totals={r.totals} />
        {r.hasPrevious ? (
          <Tile month={r.previousMonth} totals={r.previousTotals} previous />
        ) : (
          <div className="flex flex-col justify-center rounded-card border border-dashed border-line p-3.5 text-[13px] leading-snug text-muted">
            <span className="text-xs">{monthName(r.previousMonth)}</span>
            <span className="mt-1 text-fg/80">Nothing to compare with yet</span>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <Section title="By category" legend={r.hasPrevious ? <Legend month={r.month} previous={r.previousMonth} /> : undefined}>
          {rows.map((c) => (
            <CategoryRow key={c.categoryId ?? "uncategorised"} c={c} name={nameOf(c.categoryId)} month={r.month} max={max} hasPrevious={r.hasPrevious} />
          ))}
        </Section>
      )}
      {!r.hasPrevious && <p className="mx-5 mt-2.5 text-[12.5px] leading-normal text-muted">Changes against the previous month appear from your {monthName(addMonths(r.month, 1))} review.</p>}

      {tracked.length > 0 && (
        <>
          <Section title="Tracked" note="not in the total" dashed>
            {tracked.map((c) => (
              <CategoryRow key={c.categoryId} c={c} name={nameOf(c.categoryId)} month={r.month} max={maxOf(tracked)} hasPrevious={r.hasPrevious} muted />
            ))}
          </Section>
          <p className="mx-5 mt-2 text-[12.5px] text-muted">
            Tracked · not in the total: {formatPounds(r.totals.trackedMinor)}
            {r.hasPrevious && ` (${monthName(r.previousMonth)} ${formatPounds(r.previousTotals.trackedMinor)})`}
          </p>
        </>
      )}

      {r.topMerchants.length > 0 && (
        <section className="mt-6">
          <h2 className={`mx-5 mb-2 ${label}`}>Top merchants</h2>
          <ol className={`mx-4 px-4 ${card}`}>
            {r.topMerchants.map((m, i) => (
              <li key={m.merchantKey} className="border-b border-divider last:border-b-0">
                <Link href={merchantHref(m.merchantKey)} className="flex min-h-[54px] items-center gap-3 text-[14.5px]">
                  <span className="w-[22px] text-[12.5px] text-muted" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.name}</span>
                    <span className="block text-[11.5px] text-muted">{m.visits === 1 ? "1 visit" : `${m.visits} visits`}</span>
                  </span>
                  <span>{formatPounds(m.spentMinor)}</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

function Loading() {
  return (
    <div aria-busy="true">
      <div className="mx-4 mt-4 grid grid-cols-2 gap-2.5">
        {[0, 1].map((i) => (
          <div key={i} className={`flex flex-col gap-2 bg-surface/60 p-3.5 ${card}`}>
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>
      <div className={`mx-4 mt-7 flex flex-col gap-5 bg-surface/60 px-4 py-3.5 ${card}`}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Review({ back, month }: { back: Back; month: string }) {
  const lastCompleted = addMonths(monthOf(londonToday()), -1);
  const review = useReview(month);
  const r = review.data;
  return (
    <PushedScreen
      back={back}
      title={`${monthTitle(month)} review`}
      action={
        <MonthStepper month={month} current={lastCompleted} prevDisabled={r ? !r.hasPrevious : true} onStep={(m) => navigate(reviewHref(m), { replace: true, keepFrom: true })}>
          <span className="min-w-[34px] text-center text-sm">{monthName(month).slice(0, 3)}</span>
        </MonthStepper>
      }
    >
      <p className="mx-5 mt-1 text-[13px] text-muted">{!r ? " " : r.hasPrevious ? `Compared with ${monthName(r.previousMonth)}` : "Your first full month in Tally"}</p>
      {r ? (
        <Body r={r} />
      ) : review.isError ? (
        <ScreenError what="this review" error={review.error} at={review.errorUpdatedAt} onRetry={() => void review.refetch()} retrying={review.isFetching} />
      ) : (
        <Loading />
      )}
    </PushedScreen>
  );
}
