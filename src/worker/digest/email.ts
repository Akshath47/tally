import { formatDayMonth, formatPounds, formatTimestamp, monthName } from "../display";
import { insightWords, type Names } from "../insights/wording";
import type { CategoryStatus, Digest } from "./content";

// The weekly digest email (docs/insights-ui-brief.md, The weekly email): plain text plus simple
// inline-styled HTML, no images or remote content. Every string is built as plain text first and
// escaped exactly once when the HTML is assembled, so merchant names can't inject markup.

export const DIGEST_INSIGHTS_SHOWN = 5;

const STATUS_WORD: Record<CategoryStatus, string> = { over: "Over", projected_over: "On course to go over", near: "Near limit", ok: "On track" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** "12–18 Oct", "28 Sep – 4 Oct" across months, or "12 Oct" on a Monday. Always this week, so never a year. */
export function weekRange(from: string, to: string): string {
  // Each date as its own "today", so neither end gains a year across New Year.
  if (from === to) return formatDayMonth(to, to);
  return from.slice(0, 7) === to.slice(0, 7) ? `${Number(from.slice(8, 10))}–${formatDayMonth(to, to)}` : `${formatDayMonth(from, from)} – ${formatDayMonth(to, to)}`;
}

type Line = { main: string; sub?: string };
type Block = { heading?: string; lines: Line[] };

function blocks(d: Digest, names: Names): Block[] {
  const m = d.month;
  const month = monthName(m.month);
  const out: Block[] = [
    {
      lines: [
        { main: `This week: ${d.weekPendingSpentMinor > 0 ? "at least " : ""}${formatPounds(d.weekSpentMinor)} spent` },
        ...(d.spansMonths ? [{ main: `Includes the end of ${monthName(d.weekStart.slice(0, 7))}.` }] : []),
      ],
    },
    {
      lines: [
        {
          main:
            m.overallMinor === null || m.leftMinor === null
              ? `${month} so far: ${formatPounds(m.spentMinor)} spent · no budget set`
              : `${month} so far: ${formatPounds(m.spentMinor)} of ${formatPounds(m.overallMinor)} · ` +
                (m.leftMinor >= 0 ? `${formatPounds(m.leftMinor)} left` : `${formatPounds(-m.leftMinor)} over`) +
                (m.perWeekMinor !== null && m.leftMinor > 0 ? ` · ${formatPounds(m.perWeekMinor)}/week for the rest of the month` : ""),
        },
      ],
    },
  ];
  if (d.categories.length > 0) {
    out.push({
      heading: "Categories",
      lines: d.categories.map((l) => ({
        main: `${l.categoryId === null ? "Misc" : names.category(l.categoryId)}: ${formatPounds(l.spentMinor)} / ${formatPounds(l.allocatedMinor)} · ${STATUS_WORD[l.status]}`,
      })),
    });
  }
  if (d.insights.length > 0) {
    const more = d.insights.length - DIGEST_INSIGHTS_SHOWN;
    out.push({
      heading: "Worth a look",
      lines: [
        ...d.insights.slice(0, DIGEST_INSIGHTS_SHOWN).map((i) => {
          const w = insightWords(i, names, d.weekEnd);
          return { main: w.headline, sub: w.detail };
        }),
        ...(more > 0 ? [{ main: `and ${more} more in Tally` }] : []),
      ],
    });
  }
  out.push({
    lines: [
      ...(d.inboxCount > 0 ? [{ main: `${d.inboxCount} transaction${d.inboxCount === 1 ? "" : "s"} to sort` }] : []),
      ...(d.lastDataChangeAt ? [{ main: `Data last changed ${formatTimestamp(d.lastDataChangeAt)}` }] : []),
    ],
  });
  return out;
}

const textOf = (bs: Block[], appUrl: string) =>
  [...bs.map((b) => [...(b.heading ? [b.heading.toUpperCase()] : []), ...b.lines.map((l) => (l.sub ? `${l.main}\n  ${l.sub}` : l.main))].join("\n")), `Open Tally: ${appUrl}`].join("\n\n");

const htmlOf = (bs: Block[], appUrl: string) =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45">` +
  `<div style="max-width:600px;margin:0 auto"><h1 style="font-size:20px;font-weight:500;margin:0 0 16px">Your week in Tally</h1>` +
  bs
    .map(
      (b) =>
        (b.heading ? `<h2 style="font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin:20px 0 8px">${escapeHtml(b.heading)}</h2>` : "") +
        b.lines.map((l) => `<p style="margin:0 0 8px">${l.sub ? `<strong>${escapeHtml(l.main)}</strong><br>${escapeHtml(l.sub)}` : escapeHtml(l.main)}</p>`).join(""),
    )
    .join("") +
  `<p style="margin:20px 0 0"><a href="${escapeHtml(appUrl)}">Open Tally</a></p></div></body></html>`;

export function renderDigestEmail(d: Digest, names: Names, appUrl: string) {
  const bs = blocks(d, names);
  return { subject: `Your week in Tally · ${weekRange(d.weekStart, d.weekEnd)}`, text: textOf(bs, appUrl), html: htmlOf(bs, appUrl) };
}
