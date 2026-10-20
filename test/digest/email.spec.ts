import { describe, expect, it } from "vitest";
import type { Digest } from "../../src/worker/digest/content";
import { escapeHtml, renderDigestEmail, weekRange } from "../../src/worker/digest/email";
import type { Insight } from "../../src/worker/insights/rules";
import type { Names } from "../../src/worker/insights/wording";

// Synthetic figures and names only.

const names: Names = { category: (id) => (id === null ? "Uncategorised" : "Groceries"), account: () => "Card B" };
const charge = (name: string, id = 1): Insight => ({
  id: `large:${id}`, type: "large_charge", severity: "info", transactionId: id, merchantKey: "k", name, spentMinor: 12_000, merchantAverageMinor: null, countedDate: "2026-10-14", isPending: false,
});
const digest = (over: Partial<Digest> = {}): Digest => ({
  weekStart: "2026-10-12", weekEnd: "2026-10-18", spansMonths: false, weekSpentMinor: 23_000, weekPendingSpentMinor: 0,
  month: { month: "2026-10", spentMinor: 100_300, pendingSpentMinor: 0, overallMinor: 144_000, leftMinor: 43_700, perWeekMinor: 19_100, daysRemaining: 14 },
  categories: [{ categoryId: 1, spentMinor: 9_000, allocatedMinor: 10_000, status: "near" }, { categoryId: null, spentMinor: 1_800, allocatedMinor: 90_000, status: "ok" }],
  insights: [], inboxCount: 11, staleAccountIds: [], lastDataChangeAt: "2026-10-18T14:00:00.000Z", lastSend: null, ...over,
});
const render = (over: Partial<Digest> = {}) => renderDigestEmail(digest(over), names, "https://tally.example.workers.dev");

describe("weekRange", () => {
  it("shares the month when it can", () => expect(weekRange("2026-10-12", "2026-10-18")).toBe("12–18 Oct"));
  it("names both months across a boundary", () => expect(weekRange("2026-09-28", "2026-10-04")).toBe("28 Sep – 4 Oct"));
  it("shows no year across New Year", () => expect(weekRange("2026-12-28", "2027-01-03")).toBe("28 Dec – 3 Jan"));
  it("is one date for a Monday", () => expect(weekRange("2026-10-12", "2026-10-12")).toBe("12 Oct"));
});

describe("renderDigestEmail", () => {
  it("keeps figures out of the subject", () => {
    const { subject } = render();
    expect(subject).toBe("Your week in Tally · 12–18 Oct");
    expect(subject).not.toMatch(/£|\d{3}/);
  });

  it("puts the figures in order in the text part", () => {
    const { text } = render();
    expect(text).toContain("This week: £230 spent");
    expect(text).toContain("October so far: £1,003 of £1,440 · £437 left · £191/week for the rest of the month");
    expect(text).toContain("Groceries: £90 / £100 · Near limit");
    expect(text).toContain("Misc: £18 / £900 · On track");
    expect(text).toContain("11 transactions to sort");
    expect(text).toContain("Open Tally: https://tally.example.workers.dev");
    expect(text.indexOf("This week")).toBeLessThan(text.indexOf("Groceries:"));
  });

  it("says 'at least' with pending spend, and notes a week crossing months", () => {
    const { text } = render({ weekPendingSpentMinor: 500, spansMonths: true, weekStart: "2026-09-28", weekEnd: "2026-10-04" });
    expect(text).toContain("This week: at least £230 spent");
    expect(text).toContain("Includes the end of September.");
  });

  it("words a month with no budget without left or pace", () => {
    const { text } = render({ month: { month: "2026-10", spentMinor: 5_000, pendingSpentMinor: 0, overallMinor: null, leftMinor: null, perWeekMinor: null, daysRemaining: 14 }, categories: [] });
    expect(text).toContain("October so far: £50 spent · no budget set");
    expect(text).not.toContain("CATEGORIES");
  });

  it("shows the top 5 insights and counts the rest", () => {
    const insights = Array.from({ length: 7 }, (_, i) => charge(`Shop ${i}`, i));
    const { text } = render({ insights });
    expect(text).toContain("£120.00 at Shop 4");
    expect(text).not.toContain("Shop 5");
    expect(text).toContain("and 2 more in Tally");
  });

  it("escapes untrusted merchant text in the HTML part only", () => {
    const { html, text } = render({ insights: [charge(`<img src=x onerror="alert(1)">`)] });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(text).toContain(`<img src=x onerror="alert(1)">`);
  });

  it("declares UTF-8, for £ and dashes", () => expect(render().html).toContain('<meta charset="utf-8">'));

  it("leaves out the freshness line before any data has changed", () => {
    expect(render({ lastDataChangeAt: null }).text).not.toContain("Data last changed");
  });

  it("escapes the five HTML characters", () => expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;"));
});
