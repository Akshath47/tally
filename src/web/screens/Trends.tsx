import type { TrendCategory, TrendMonth, Trends as TrendsData } from "../api";
import { PushedScreen } from "../components/Screen";
import { ScreenError } from "../components/ScreenError";
import { Skeleton } from "../components/ui";
import { londonToday, monthName, monthOf } from "../dates";
import { ordinal } from "../insights";
import { formatPounds } from "../money";
import { fraction } from "../pace";
import { useCategories, useTrends } from "../queries";
import { Link } from "../router";
import { homeHref, lineHref, type Back } from "../routes";

// Six months: this one and the 5 before (docs/insights-ui-brief.md, Screen 3). Budget spend per
// month with the budget marked, the current month part-way, then each category's shape.

const card = "rounded-card border border-divider bg-surface";
const label = "text-[11.5px] font-medium tracking-[0.08em] text-muted uppercase";
const short = (month: string) => monthName(month).slice(0, 3);

/** Mean of the completed months with data, floored; null when there are none. */
function average(months: TrendMonth[]): number | null {
  const done = months.filter((m) => !m.partial && m.hasData);
  return done.length ? Math.floor(done.reduce((a, m) => a + m.spentMinor, 0) / done.length) : null;
}

function MonthColumn({ m, max, today }: { m: TrendMonth; max: number; today: string }) {
  const name = monthName(m.month);
  if (!m.hasData) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-line text-center text-[10.5px] leading-snug text-subtle" aria-label={`${name}: no data`}>
        no
        <br />
        data
      </div>
    );
  }
  const overall = m.overallMinor;
  const over = overall !== null && m.spentMinor > overall;
  const posted = m.spentMinor - m.pendingSpentMinor;
  const describe = m.partial
    ? `${name} so far: ${m.pendingSpentMinor > 0 ? "at least " : ""}${formatPounds(m.spentMinor)}${m.pendingSpentMinor > 0 ? `, including ${formatPounds(m.pendingSpentMinor)} pending` : ""}`
    : over
      ? `${name}: ${formatPounds(m.spentMinor)}, ${formatPounds(m.spentMinor - overall)} over`
      : `${name}: ${formatPounds(m.spentMinor)}${overall !== null ? ` of ${formatPounds(overall)}` : ""}`;
  const pct = (minor: number) => `${fraction(Math.max(0, minor), max) * 100}%`;
  return (
    <Link href={homeHref(m.month, today)} aria-label={describe} className="relative flex h-full flex-col justify-end gap-[2px] rounded-lg hover:brightness-115">
      {/* Each month's own budget, so a change of budget is drawn where it happened. */}
      {overall !== null && <span className="pointer-events-none absolute -inset-x-1 z-10 border-t border-dashed border-fg/60" style={{ bottom: pct(overall) }} aria-hidden="true" />}
      {m.partial ? (
        <>
          {m.pendingSpentMinor > 0 && <span className="hatch block rounded-t-[5px]" style={{ height: pct(m.pendingSpentMinor) }} />}
          <span className={`block bg-accent ${m.pendingSpentMinor > 0 ? "rounded-b-[2px]" : "rounded-t-[5px] rounded-b-[2px]"}`} style={{ height: pct(posted) }} />
        </>
      ) : over ? (
        <>
          <span className="block rounded-t-[5px] bg-over" style={{ height: pct(m.spentMinor - overall) }} />
          <span className="block rounded-b-[2px] bg-past" style={{ height: pct(overall) }} />
        </>
      ) : (
        <span className="block rounded-t-[5px] rounded-b-[2px] bg-past" style={{ height: pct(m.spentMinor) }} />
      )}
    </Link>
  );
}

function TotalChart({ t, today }: { t: TrendsData; today: string }) {
  const months = t.months;
  const current = months[months.length - 1]!;
  const budget = [...months].reverse().find((m) => m.overallMinor !== null)?.overallMinor ?? null;
  const max = Math.max(1, ...months.map((m) => Math.max(m.spentMinor, m.overallMinor ?? 0)));
  const avg = average(months);
  const done = months.filter((m) => !m.partial && m.hasData);
  const firstWithData = months.find((m) => m.hasData);

  return (
    <section className={`mx-4 mt-4 px-4 pt-4 pb-3.5 ${card}`} aria-labelledby="total-h">
      <div className="flex items-baseline justify-between">
        <h2 id="total-h" className={label}>
          Budget spend
        </h2>
        {budget !== null && (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted">
            <span className="w-3.5 border-t border-dashed border-fg/60" aria-hidden="true" />
            Budget {formatPounds(budget)}
          </span>
        )}
      </div>
      {avg === null ? (
        <p className="mt-2 text-[13.5px] text-muted">Average after your first full month</p>
      ) : (
        <div className="mt-1.5">
          <div className="text-xs text-muted">Average</div>
          <div className="text-[32px] leading-[1.1] font-extralight tracking-[-0.03em]">
            {formatPounds(avg)} <span className="text-sm font-normal tracking-normal text-muted">/ month</span>
          </div>
          <div className="mt-0.5 text-xs text-muted">
            over {done.length === 1 ? monthName(done[0]!.month) : `${monthName(done[0]!.month)} to ${monthName(done[done.length - 1]!.month)}`}, the completed {done.length === 1 ? "month" : "months"}
          </div>
        </div>
      )}

      <div className="mt-[18px]">
        <div className="grid h-[190px] grid-cols-6 items-end gap-2.5">
          {months.map((m) => (
            <MonthColumn key={m.month} m={m} max={max} today={today} />
          ))}
        </div>
        <div className="mt-2 grid grid-cols-6 gap-2.5 text-center text-[11.5px] leading-snug text-muted" aria-hidden="true">
          {months.map((m) => {
            const over = m.overallMinor !== null && m.spentMinor > m.overallMinor && !m.partial;
            return (
              <span key={m.month} className={m.partial ? "font-medium text-fg" : over ? "text-over-fg" : ""}>
                {short(m.month)}
                <br />
                {m.partial ? <span className="font-normal text-accent-fg">{done.length ? "so far" : formatPounds(m.spentMinor)}</span> : m.hasData ? formatPounds(m.spentMinor) : ""}
              </span>
            );
          })}
        </div>
      </div>
      <p className="mt-3.5 text-[12.5px] leading-normal text-muted">
        {firstWithData && firstWithData.month !== months[0]!.month && `Tally's history starts in ${monthName(firstWithData.month)}, so earlier months have no data. `}
        {monthName(current.month)} is part-way: {current.pendingSpentMinor > 0 ? "at least " : ""}
        {formatPounds(current.spentMinor)} by the {ordinal(Number(today.slice(8, 10)))}
        {current.pendingSpentMinor > 0 ? ", hatched part pending" : ""}. Tap a month to open it on Home.
      </p>
    </section>
  );
}

function Spark({ series }: { series: number[] }) {
  const max = Math.max(1, ...series);
  return (
    <span className="grid h-[30px] shrink-0 grid-cols-[repeat(6,8px)] items-end gap-[3px]" aria-hidden="true">
      {series.map((v, i) => (
        <span key={i} className={`block rounded-[2px] ${i === series.length - 1 ? "bg-accent" : "bg-previous"}`} style={{ height: `${fraction(Math.max(0, v), max) * 100}%` }} />
      ))}
    </span>
  );
}

function CategoryRows({ rows, months, today, name, withShape }: { rows: TrendCategory[]; months: TrendMonth[]; today: string; name: (id: number | null) => string; withShape: boolean }) {
  const current = monthOf(today);
  return rows.map((c) => {
    const now = c.series[c.series.length - 1] ?? 0;
    const shape = c.series.map((v, i) => `${monthName(months[i]!.month)} ${formatPounds(v)}`).join(", ");
    return (
      <li key={c.categoryId ?? "uncategorised"} className="border-b border-divider last:border-b-0">
        <Link
          href={c.categoryId === null ? "/to-sort" : lineHref(current, c.categoryId)}
          aria-label={withShape ? `${name(c.categoryId)}: ${shape}${c.averageMinor !== null ? `, average ${formatPounds(c.averageMinor)}` : ""}` : undefined}
          className={`flex items-center gap-3 ${withShape ? "min-h-16 py-2" : "min-h-[52px]"}`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14.5px]">{name(c.categoryId)}</span>
            {withShape && c.averageMinor !== null && <span className="mt-0.5 block text-xs text-muted">avg {formatPounds(c.averageMinor)}</span>}
          </span>
          {withShape && <Spark series={c.series} />}
          <span className={withShape ? "w-[68px] text-right" : ""}>
            <span className="block text-[14.5px] font-medium">{formatPounds(now)}</span>
            {withShape && <span className="block text-[11.5px] text-muted">{short(current)} so far</span>}
          </span>
        </Link>
      </li>
    );
  });
}

function Body({ t, today }: { t: TrendsData; today: string }) {
  const byId = useCategories().data?.byId;
  const name = (id: number | null) => (id === null ? "Uncategorised" : (byId?.get(id)?.name ?? "Category"));
  const withShape = average(t.months) !== null;
  const months = t.months;
  // Biggest by average (or by this month before there's one), Uncategorised last.
  const order = (a: TrendCategory, b: TrendCategory) =>
    (a.categoryId === null ? 1 : 0) - (b.categoryId === null ? 1 : 0) || (b.averageMinor ?? b.series[5] ?? 0) - (a.averageMinor ?? a.series[5] ?? 0);
  const spending = t.categories.filter((c) => c.kind !== "tracked" && c.series.some((v) => v !== 0)).sort(order);
  const tracked = t.categories.filter((c) => c.kind === "tracked" && c.series.some((v) => v !== 0)).sort(order);
  const lastDone = [...months].reverse().find((m) => !m.partial && m.hasData);

  return (
    <>
      <TotalChart t={t} today={today} />
      {lastDone && lastDone.trackedMinor > 0 && (
        <p className="mx-5 mt-2.5 text-[12.5px] text-muted">
          Tracked spend isn't in these totals · {formatPounds(lastDone.trackedMinor)} in {monthName(lastDone.month)}
        </p>
      )}

      {spending.length > 0 && (
        <section className="mt-6">
          <div className="mx-5 mb-2 flex items-baseline justify-between">
            <h2 className={label}>{withShape ? "By category" : `By category · ${monthName(monthOf(today))} so far`}</h2>
            {withShape && (
              <span className="inline-flex gap-3 text-[11.5px] text-muted">
                <span className="inline-flex items-center gap-[5px]">
                  <span className="size-2 rounded-[2px] bg-previous" aria-hidden="true" />
                  {short(months[0]!.month)}–{short(months[4]!.month)}
                </span>
                <span className="inline-flex items-center gap-[5px]">
                  <span className="size-2 rounded-[2px] bg-accent" aria-hidden="true" />
                  {short(months[5]!.month)}
                </span>
              </span>
            )}
          </div>
          <ul className={`mx-4 px-4 ${card}`}>
            <CategoryRows rows={spending} months={months} today={today} name={name} withShape={withShape} />
          </ul>
        </section>
      )}

      {tracked.length > 0 && (
        <section className="mt-5">
          <h2 className={`mx-5 mb-2 ${label}`}>Tracked · not in the total</h2>
          <ul className="mx-4 rounded-card border border-dashed border-line px-4">
            <CategoryRows rows={tracked} months={months} today={today} name={name} withShape={withShape} />
          </ul>
        </section>
      )}
    </>
  );
}

function Loading() {
  return (
    <div aria-busy="true">
      <div className={`mx-4 mt-4 flex flex-col gap-3 bg-surface/60 p-4 ${card}`}>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-36" />
        <div className="mt-3 grid h-[150px] grid-cols-6 items-end gap-2.5">
          {["h-[60%]", "h-[70%]", "h-[65%]", "h-[80%]", "h-[72%]", "h-[45%]"].map((h, i) => (
            <Skeleton key={i} className={h} />
          ))}
        </div>
      </div>
      <div className={`mx-4 mt-7 flex flex-col gap-5 bg-surface/60 px-4 py-4 ${card}`}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-5" />
        ))}
      </div>
    </div>
  );
}

export function Trends({ back }: { back: Back }) {
  const today = londonToday();
  const trends = useTrends();
  return (
    <PushedScreen back={back} title="Trends">
      <p className="mx-5 mt-1 text-[13px] text-muted">Last 6 months</p>
      {trends.data ? (
        <Body t={trends.data} today={today} />
      ) : trends.isError ? (
        <ScreenError what="trends" error={trends.error} at={trends.errorUpdatedAt} onRetry={() => void trends.refetch()} retrying={trends.isFetching} />
      ) : (
        <Loading />
      )}
    </PushedScreen>
  );
}
