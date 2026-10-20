import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sendDigest, type DigestPreview, type Transaction } from "../api";
import { TabScreen } from "../components/Screen";
import { ScreenError } from "../components/ScreenError";
import { ToSortChip } from "../components/ToSortChip";
import { TransactionSheet } from "../components/TransactionSheet";
import { ArrowUp, Check, ChevronRight, Clock, Flag, SectionLabel, Skeleton, Spinner, Warning, cardClass as card } from "../components/ui";
import { addDays, addMonths, daysInMonth, londonToday, monthName, monthOf } from "../dates";
import { daysOfPreviousMonth, iconOf, insightWords, isMonthChangeOnly, londonDayTime, targetOf, toneOf, weekRange, type Insight, type InsightIcon, type Names, type Tone } from "../insights";
import { categoryName } from "../lines";
import { projectedMinor } from "../../worker/analytics/math";
import { formatPounds } from "../money";
import { ageText, fraction } from "../pace";
import { merchantQuery, useAccounts, useCategories, useDigestPreview, useSummary } from "../queries";
import { Link, navigate } from "../router";
import { TRENDS_HREF, lineHref, merchantHref, reviewHref } from "../routes";

// The weekly glance (docs/insights-ui-brief.md, Screen 1): this week so far, what's worth a look,
// and the way into the Monthly review and Trends. Figures come from the digest preview and the
// insights, so the tab and the Sunday email say the same thing.

const CALENDAR = (
  <>
    <rect x="4" y="5" width="16" height="15" rx="2" />
    <path d="M4 10h16M9 3v4M15 3v4" />
  </>
);

/** "Updated 3h ago · both accounts", amber when an account is stale. */
function Freshness({ preview, failed }: { preview: DigestPreview | undefined; failed: boolean }) {
  const accounts = useAccounts();
  const enabled = accounts.data?.all.filter((a) => a.importEnabled).length ?? 0;
  if (!preview && !failed) {
    return (
      <span role="status" className="inline-flex min-h-[30px] items-center gap-1.5 text-[12.5px] text-muted">
        <Spinner size={12} />
        Loading insights…
      </span>
    );
  }
  const stale = !failed && (preview?.staleAccountIds.length ?? 0) > 0;
  const scope = enabled === 2 ? " · both accounts" : enabled > 2 ? ` · ${enabled} accounts` : "";
  const text = failed ? "Couldn't refresh" : preview?.lastDataChangeAt ? `Updated ${ageText(preview.lastDataChangeAt)}${scope}` : "Not imported yet";
  return (
    <Link href="/accounts" className="inline-flex min-h-[30px] items-center gap-1.5 text-[12.5px] text-muted hover:text-fg">
      <span className={`size-1.5 shrink-0 rounded-full ${failed ? "bg-over" : stale ? "bg-warn" : "bg-accent"}`} aria-hidden="true" />
      {text}
      {stale && <span className="text-warn-fg">· an account is stale</span>}
    </Link>
  );
}

/** A flagged category: Over, On course to go over, or Near limit (the brief's copy). */
/** `today` is the preview's own (its weekEnd), so the projection matches the server's status. */
function CategoryFlag({ c, today }: { c: DigestPreview["categories"][number]; today: string }) {
  if (c.status === "over")
    return (
      <Flag tone="over">
        <ArrowUp size={10} />
        {formatPounds(c.spentMinor - c.allocatedMinor)} over
      </Flag>
    );
  if (c.status === "projected_over") {
    const projected = projectedMinor(c.spentMinor, Number(today.slice(8, 10)), daysInMonth(monthOf(today)));
    return <Flag tone="warn">on course for {formatPounds(projected - c.allocatedMinor)} over</Flag>;
  }
  return <Flag tone="warn">{formatPounds(c.allocatedMinor - c.spentMinor)} left</Flag>;
}

const STATUS_ORDER = { over: 0, projected_over: 1, near: 2, ok: 3 } as const;

function EmailLine({ lastSend, today }: { lastSend: DigestPreview["lastSend"]; today: string }) {
  // A send only settles the latest digest_sends row, so the cached preview is patched to match
  // rather than re-read (the preview is the app's heaviest read), and nothing else is touched.
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: sendDigest,
    meta: { invalidate: false },
    onSuccess: () =>
      qc.setQueryData<DigestPreview>(["digest", "preview"], (p) => (p?.lastSend ? { ...p, lastSend: { ...p.lastSend, status: "sent", sentAt: new Date().toISOString() } } : p)),
  });
  const sent = send.isSuccess;
  if (lastSend?.status === "failed" && !sent) {
    return (
      <span className="flex basis-full items-center justify-between gap-2 text-[11.5px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Warning size={14} className="shrink-0 text-warn-fg" />
          {send.isError ? "Still couldn't send it. Try again later." : "Last Sunday's email didn't send"}
        </span>
        <button type="button" className="min-h-11 px-1 text-[13.5px] font-medium text-accent-fg disabled:opacity-50" disabled={send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? "Sending…" : "Send now"}
        </button>
      </span>
    );
  }
  if (sent) return <span className="text-[11.5px] text-muted">Weekly email · sent just now</span>;
  if (lastSend?.status === "sending") return <span className="text-[11.5px] text-muted">Weekly email · sending now</span>;
  if (!lastSend?.sentAt) return <span className="text-[11.5px] text-muted">Weekly email goes out Sundays at 18:00</span>;
  return (
    <span className="text-[11.5px] leading-snug text-muted">
      Weekly email · last sent
      <br />
      {londonDayTime(lastSend.sentAt, today)}
    </span>
  );
}

/** Dated by the preview itself (its weekEnd is the server's today), so figures and labels agree. */
function ThisWeek({ p, names }: { p: DigestPreview; names: Names }) {
  const today = p.weekEnd;
  const month = p.month.month;
  const m = p.month;
  const flagged = p.categories.filter((c) => c.status !== "ok").sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const earlier = p.spansMonths ? daysOfPreviousMonth(p.weekStart, today) : 0;
  const soFar = today < addDays(p.weekStart, 6);
  return (
    <section className={`mx-4 mt-3 px-4 pt-4 pb-1.5 ${card}`} aria-labelledby="week-h">
      <div className="flex items-baseline justify-between">
        <SectionLabel id="week-h">This week</SectionLabel>
        <span className="text-[12.5px] text-muted">
          {weekRange(p.weekStart, today)}
          {soFar && " · so far"}
        </span>
      </div>

      <div className="mt-2.5 flex items-end justify-between gap-4">
        <div>
          {p.weekPendingSpentMinor > 0 && <div className="text-xs text-muted">at least</div>}
          <div className="text-[44px] leading-[1.05] font-extralight tracking-[-0.035em]">{formatPounds(p.weekSpentMinor)}</div>
          {p.weekPendingSpentMinor > 0 && <div className="mt-1 text-xs text-muted">includes {formatPounds(p.weekPendingSpentMinor)} pending</div>}
          {earlier > 0 && (
            <div className="mt-1 text-xs text-muted">
              Includes {earlier === 1 ? "1 day" : `${earlier} days`} of {monthName(addMonths(month, -1))}
            </div>
          )}
        </div>
      </div>

      {m.overallMinor !== null && m.leftMinor !== null ? (
        <>
          <div className="mt-4 flex h-1 gap-px overflow-hidden rounded-full bg-line" aria-hidden="true">
            <div className={m.leftMinor < 0 ? "bg-over" : "bg-accent"} style={{ width: `${fraction(m.spentMinor - m.pendingSpentMinor, m.overallMinor) * 100}%` }} />
            {m.pendingSpentMinor > 0 && m.leftMinor >= 0 && <div className="hatch" style={{ width: `${fraction(m.pendingSpentMinor, m.overallMinor) * 100}%` }} />}
          </div>
          <p className="mt-[9px] text-[13.5px] leading-normal">
            <span className="font-medium">{formatPounds(m.spentMinor)}</span> <span className="text-muted">of {formatPounds(m.overallMinor)} this month ·</span>{" "}
            {m.leftMinor >= 0 ? <span className="font-medium">{formatPounds(m.leftMinor)} left</span> : <span className="font-medium text-over-fg">{formatPounds(-m.leftMinor)} over</span>}
            {m.perWeekMinor !== null && m.leftMinor > 0 && (
              <>
                <br />
                <span className="text-muted">
                  {formatPounds(m.perWeekMinor)}/week for the rest of {monthName(month)}
                </span>
              </>
            )}
          </p>
          <ul className="mt-3">
            {flagged.length === 0 ? (
              <li className="flex min-h-11 items-center gap-2 border-t border-divider text-[13.5px] text-fg/90">
                <Check size={16} className="text-accent-fg" />
                All categories on track
              </li>
            ) : (
              flagged.map((c) => (
                <li key={c.categoryId ?? "misc"}>
                  <Link href={lineHref(month, c.categoryId ?? "misc")} className="-mx-4 flex min-h-11 items-center gap-2 border-t border-divider px-4 text-sm hover:bg-raised/50">
                    <span>{names.category(c.categoryId)}</span>
                    <CategoryFlag c={c} today={today} />
                    <span className="ml-auto">
                      <span className={`font-medium ${c.status === "over" ? "text-over-fg" : ""}`}>{formatPounds(c.spentMinor)}</span>{" "}
                      <span className="text-muted">/ {formatPounds(c.allocatedMinor)}</span>
                    </span>
                  </Link>
                </li>
              ))
            )}
          </ul>
        </>
      ) : (
        <>
          <p className="mt-2.5 text-[13.5px]">
            <span className="font-medium">{formatPounds(m.spentMinor)}</span> <span className="text-muted">spent in {monthName(month)} so far</span>
          </p>
          <Link href="/budget" className="-mx-4 mt-3 flex min-h-11 items-center gap-2 border-t border-divider px-4 py-2.5 text-[13.5px] leading-snug hover:bg-raised/50">
            <span className="flex-1">Set a budget to see what's left and how each category is doing</span>
            <ChevronRight size={16} className="text-muted" />
          </Link>
        </>
      )}

      {/* A failed send takes the whole row, and the chip moves under it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2.5 border-t border-divider pt-2 pb-1">
        <EmailLine lastSend={p.lastSend} today={today} />
        {p.inboxCount > 0 && (
          <span className="ml-auto">
            <ToSortChip count={p.inboxCount} />
          </span>
        )}
      </div>
    </section>
  );
}

const TONE: Record<Tone, string> = { over: "bg-over-tint text-over-fg", warn: "bg-warn-tint text-warn-fg", neutral: "bg-raised text-fg/80" };

const ICON_PATHS: Record<InsightIcon, ReactNode> = {
  over: <path d="M12 19V5M6 11l6-6 6 6" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  projected: (
    <>
      <path d="M4 18l6-6 4 3 6-7" />
      <path d="M15 8h5v5" strokeDasharray="2 2.5" />
    </>
  ),
  high: (
    <>
      <path d="M4.5 16a8 8 0 1 1 15 0" />
      <path d="M12 13l4-4" />
    </>
  ),
  charge: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </>
  ),
  stale: <path d="M12 4l9 16H3l9-16zM12 10v4M12 17h.01" />,
};

function InsightIconBox({ item }: { item: Insight }) {
  const icon = iconOf(item);
  // A month change's arrow carries its direction: amber up, sage down.
  const colour = icon === "up" ? "text-warn-fg" : icon === "down" ? "text-accent-fg" : "";
  return (
    <span className={`grid size-[34px] shrink-0 place-items-center rounded-[10px] ${TONE[toneOf(item)]} ${colour}`}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {ICON_PATHS[icon]}
      </svg>
    </span>
  );
}

function InsightRow({ item, names, today, onCharge }: { item: Insight; names: Names; today: string; onCharge: (transactionId: number, merchantKey: string) => void }) {
  const words = insightWords(item, names, today);
  const target = targetOf(item, today);
  const body = (
    <>
      <InsightIconBox item={item} />
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] leading-snug font-medium">{words.headline}</span>
        <span className="mt-[3px] block text-[12.5px] leading-snug text-muted">{words.detail}</span>
      </span>
      <ChevronRight size={15} className="mt-[9px] shrink-0 text-subtle" />
    </>
  );
  const row = "flex w-full items-start gap-3 p-3.5 text-left";
  return (
    <li className={card}>
      {"href" in target ? (
        <Link href={target.href} className={row}>
          {body}
        </Link>
      ) : (
        <button type="button" className={`${row} pb-1.5`} onClick={() => onCharge(target.transactionId, target.merchantKey)}>
          {body}
        </button>
      )}
      {item.type === "large_charge" && (
        <Link href={merchantHref(item.merchantKey)} className="mb-1 ml-[60px] inline-flex min-h-10 items-center text-[13px] text-accent-fg">
          All from {item.name}
        </Link>
      )}
    </li>
  );
}

function WorthALook({ items, names, asOf }: { items: Insight[]; names: Names; asOf: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Transaction | null>(null);
  const early = Number(asOf.slice(8, 10)) < 8;
  const lastMonth = addMonths(monthOf(asOf), -1);

  // A large charge opens its own transaction. There's no single-transaction route, but the
  // charge is within the last week, so it's in its merchant's 20 most recent.
  const openCharge = async (transactionId: number, merchantKey: string) => {
    try {
      const m = await qc.fetchQuery(merchantQuery(merchantKey));
      const t = m.recent.find((r) => r.id === transactionId);
      if (t) setOpen(t);
      else navigate(merchantHref(merchantKey));
    } catch {
      navigate(merchantHref(merchantKey));
    }
  };

  return (
    <>
      {items.length > 0 ? (
        <section aria-labelledby="look-h">
          <div className="mx-5 mt-6 mb-2 flex items-baseline justify-between">
            <SectionLabel id="look-h">Worth a look</SectionLabel>
            <span className="text-xs text-muted">{isMonthChangeOnly(items) ? `${monthName(lastMonth)} vs ${monthName(addMonths(lastMonth, -1))}` : `${items.length} this month`}</span>
          </div>
          <ul className="mx-4 flex flex-col gap-2">
            {items.map((item) => (
              <InsightRow key={item.id} item={item} names={names} today={asOf} onCharge={(id, key) => void openCharge(id, key)} />
            ))}
          </ul>
        </section>
      ) : (
        !early && (
          <div className="mx-8 mt-9 flex flex-col items-center gap-2 text-center">
            <span className="grid size-14 place-items-center rounded-full border border-accent/30 bg-accent-tint/60 text-accent-fg" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12h4l2-4 3 8 2-4h7" />
              </svg>
            </span>
            <h2 className="mt-2 text-[19px] font-light">Nothing stands out this month</h2>
            <p className="text-[13px] leading-normal text-muted">Spending is in line with your budget and your usual months. Anything worth a look will show up here.</p>
          </div>
        )
      )}
      {early && (
        <p className="mx-5 mt-4 flex items-start gap-2 text-[12.5px] leading-normal text-muted">
          <Clock size={14} className="mt-0.5 shrink-0" />
          Projections start on the 8th, once there's enough of the month to go on.
        </p>
      )}
      <TransactionSheet txn={open} onClose={() => setOpen(null)} />
    </>
  );
}

function Entry({ href, title, subtitle, icon }: { href: string; title: string; subtitle: string; icon: ReactNode }) {
  return (
    <li className="border-b border-divider last:border-b-0">
      <Link href={href} className="flex min-h-[60px] items-center gap-3 px-4 hover:bg-raised/50">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-raised text-fg/80" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            {icon}
          </svg>
        </span>
        <span className="flex-1">
          <span className="block text-[14.5px] font-medium">{title}</span>
          <span className="block text-[12.5px] text-muted">{subtitle}</span>
        </span>
        <ChevronRight size={15} className="text-subtle" />
      </Link>
    </li>
  );
}

/** Monthly review (when there's a completed month to review) and Trends. */
function Entries({ today }: { today: string }) {
  const month = monthOf(today);
  const last = addMonths(month, -1);
  // Last month's summary (cheap, and shared with Home) says whether there's a month to review.
  // Until it loads, assume there is: it's the usual case, and the row just links on.
  const summary = useSummary(last);
  const hasLast = summary.data ? summary.data.spentMinor !== 0 || summary.data.trackedMinor !== 0 || summary.data.categories.some((c) => c.spentMinor !== 0) : true;
  return (
    <>
      {!hasLast && (
        <p className="mx-5 mt-5 flex items-start gap-2 text-[12.5px] leading-normal text-muted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="mt-0.5 shrink-0">
            {CALENDAR}
          </svg>
          Monthly reviews and comparisons start once there's a full previous month. Your first one will be {monthName(month)}'s, from 1 {monthName(addMonths(month, 1))}.
        </p>
      )}
      <ul className={`mx-4 mt-6 overflow-hidden ${card}`}>
        {hasLast && (
          <Entry
            href={reviewHref(last)}
            title={`${monthName(last)} review`}
            subtitle={`Compared with ${monthName(addMonths(last, -1))}`}
            icon={CALENDAR}
          />
        )}
        <Entry href={TRENDS_HREF} title="Trends" subtitle="Last 6 months" icon={<path d="M6 19v-6M10 19V9M14 19v-8M18 19V6" />} />
      </ul>
    </>
  );
}

function Loading() {
  return (
    <div aria-busy="true">
      <div className={`mx-4 mt-3 flex flex-col gap-3 bg-surface/60 p-4 ${card}`}>
        <div className="flex justify-between">
          <Skeleton className="h-3 w-[70px]" />
          <Skeleton className="h-3 w-[150px]" />
        </div>
        <Skeleton className="h-10 w-[120px]" />
        <Skeleton className="mt-2 h-1" />
        <Skeleton className="h-3 w-[230px]" />
        <Skeleton className="h-3 w-[160px]" />
      </div>
      <Skeleton className="mx-5 mt-7 h-3 w-[90px]" />
      <div className="mx-4 mt-3 flex flex-col gap-2">
        {["w-[200px]", "w-[225px]", "w-[170px]"].map((w) => (
          <div key={w} className={`flex gap-3 bg-surface/60 p-3.5 ${card}`}>
            <Skeleton className="size-[34px] rounded-[10px]" />
            <div className="flex flex-1 flex-col gap-2 pt-1">
              <Skeleton className={`h-3 ${w}`} />
              <Skeleton className="h-2.5 w-[140px]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Insights() {
  const today = londonToday();
  const preview = useDigestPreview();
  const byId = useCategories().data?.byId;
  const accounts = useAccounts().data?.byId;
  const account = (id: number) => accounts?.get(id)?.name ?? "An account";
  // The week card's uncategorised line is Misc; the insights' own words call it Uncategorised.
  const names: Names = { category: (id) => categoryName(id, byId, "Misc"), account };
  const insightNames: Names = { category: (id) => categoryName(id, byId), account };
  const p = preview.data;

  return (
    <TabScreen title="Insights" titleExtra={<Freshness preview={p} failed={preview.isError} />}>
      {p ? (
        <>
          <ThisWeek p={p} names={names} />
          {/* The preview carries the same insights as GET /api/insights, worked out for its weekEnd (today). */}
          <WorthALook items={p.insights} names={insightNames} asOf={p.weekEnd} />
          <Entries today={today} />
        </>
      ) : preview.isError ? (
        // Only when there's nothing to show: a failed background refetch keeps the figures.
        <ScreenError what="insights" error={preview.error} at={preview.errorUpdatedAt} onRetry={() => void preview.refetch()} retrying={preview.isFetching} />
      ) : (
        <Loading />
      )}
    </TabScreen>
  );
}
