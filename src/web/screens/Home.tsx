import { useQuery } from "@tanstack/react-query";
import { getMonthSummary } from "../api";
import { londonToday, monthName, monthOf } from "../dates";
import { formatTimestamp } from "../format";
import { TabScreen } from "../components/Screen";
import { Link } from "../router";

// The header only; the ring, pills and categories come with the Home step.

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

export function Home() {
  const month = monthOf(londonToday());
  const summary = useQuery({ queryKey: ["summary", month], queryFn: () => getMonthSummary(month) });
  const inboxCount = summary.data?.inboxCount ?? 0;

  return (
    <TabScreen
      title={monthName(month)}
      titleExtra={
        <Link href="/accounts" className="inline-flex min-h-[30px] items-center gap-1.5 text-[12.5px] text-muted hover:text-fg">
          <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
          {summary.isPending ? "Loading your budget…" : summary.isError ? "Couldn't refresh" : `Updated ${formatTimestamp(summary.data.lastDataChangeAt)}`}
        </Link>
      }
      action={
        <div className="flex items-center gap-1">
          {inboxCount > 0 && <ToSortChip count={inboxCount} />}
          <SettingsLink />
        </div>
      }
    />
  );
}
