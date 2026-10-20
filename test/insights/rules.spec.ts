import { describe, expect, it } from "vitest";
import type { SpendRow } from "../../src/worker/analytics/spend";
import { buildInsights, type Charge, type Insight, type InsightInput } from "../../src/worker/insights/rules";

// All figures are synthetic. October 2026 has 31 days.

const row = (categoryId: number | null, spentMinor: number, kind: SpendRow["kind"] = categoryId === null ? null : "budgeted"): SpendRow => ({
  month: "2026-10", categoryId, kind, spentMinor, pendingSpentMinor: 0,
});
const on = (today: string) => ({ today, now: new Date(`${today}T12:00:00Z`) });
const input = (over: Partial<InsightInput> = {}): InsightInput => ({
  ...on("2026-10-15"),
  budget: { overallMinor: null, allocations: [] },
  monthSpend: [],
  baseline: [],
  lastMonth: { month: "2026-09", hasData: true, rows: [] },
  previousMonth: { month: "2026-08", hasData: true, rows: [] },
  charges: [],
  accounts: [],
  ...over,
});
const allocated = (categoryId: number, allocatedMinor: number) => ({ overallMinor: 1_000_000, allocations: [{ categoryId, allocatedMinor }] });
const baseline = (...months: (number | null)[]) =>
  months.map((spent, i) => ({ month: `2026-0${9 - i}`, hasData: spent !== null, rows: spent === null ? [] : [row(1, spent)] }));
const charge = (over: Partial<Charge> = {}): Charge => ({
  transactionId: 7, merchantKey: "shop", name: "Shop", spentMinor: 10_000, countedDate: "2026-10-13", isPending: false, earlierCount: 0, earlierSpentMinor: 0, ...over,
});
const only = (items: Insight[], type: Insight["type"]) => items.filter((i) => i.type === type);

describe("pace", () => {
  it("is over from day 1 once spend passes the allocation", () => {
    const items = buildInsights(input({ ...on("2026-10-01"), budget: allocated(1, 10_000), monthSpend: [row(1, 10_001)] }));
    expect(only(items, "pace")).toEqual([
      { id: "pace:category:1:2026-10", type: "pace", severity: "over", state: "over", categoryId: 1, spentMinor: 10_001, allocatedMinor: 10_000, projectedMinor: 310_031 },
    ]);
  });

  it("doesn't project on day 7, and does on day 8", () => {
    expect(only(buildInsights(input({ ...on("2026-10-07"), budget: allocated(1, 10_000), monthSpend: [row(1, 3_000)] })), "pace")).toEqual([]);
    expect(only(buildInsights(input({ ...on("2026-10-08"), budget: allocated(1, 10_000), monthSpend: [row(1, 3_000)] })), "pace")).toEqual([
      { id: "pace:category:1:2026-10", type: "pace", severity: "warn", state: "projected_over", categoryId: 1, spentMinor: 3_000, allocatedMinor: 10_000, projectedMinor: 11_625 },
    ]);
  });

  it("projects the overall budget from budget spend only, never tracked", () => {
    const items = buildInsights(input({ budget: { overallMinor: 100_000, allocations: [] }, monthSpend: [row(1, 60_000), row(9, 50_000, "tracked")] }));
    expect(only(items, "pace")).toMatchObject([{ categoryId: null, state: "projected_over", spentMinor: 60_000, projectedMinor: 124_000 }]);
  });

  it("ignores a zero allocation", () => {
    expect(only(buildInsights(input({ budget: allocated(1, 0), monthSpend: [row(1, 500)] })), "pace")).toEqual([]);
  });
});

describe("unusual_category", () => {
  it("fires at exactly 1.5× the baseline and £30 above it", () => {
    const items = buildInsights(input({ baseline: baseline(6_000, 6_000, 6_000), monthSpend: [row(1, 9_000)] }));
    expect(only(items, "unusual_category")).toEqual([
      { id: "unusual:1:2026-10", type: "unusual_category", severity: "warn", categoryId: 1, spentMinor: 9_000, baselineMinor: 6_000 },
    ]);
  });

  it("stays silent just under either edge", () => {
    expect(only(buildInsights(input({ baseline: baseline(6_000, 6_000, 6_000), monthSpend: [row(1, 8_999)] })), "unusual_category")).toEqual([]);
    expect(only(buildInsights(input({ baseline: baseline(2_000, 2_000, 2_000), monthSpend: [row(1, 4_999)] })), "unusual_category")).toEqual([]);
    expect(only(buildInsights(input({ baseline: baseline(2_000, 2_000, 2_000), monthSpend: [row(1, 5_000)] })), "unusual_category")).toHaveLength(1);
  });

  it("averages only the baseline months with data, and needs two of them", () => {
    expect(only(buildInsights(input({ baseline: baseline(4_000, null, null), monthSpend: [row(1, 20_000)] })), "unusual_category")).toEqual([]);
    expect(only(buildInsights(input({ baseline: baseline(4_000, 2_000, null), monthSpend: [row(1, 20_000)] })), "unusual_category")).toMatchObject([
      { baselineMinor: 3_000 },
    ]);
  });

  it("doesn't fire before day 8", () => {
    expect(only(buildInsights(input({ ...on("2026-10-07"), baseline: baseline(1_000, 1_000, 1_000), monthSpend: [row(1, 20_000)] })), "unusual_category")).toEqual([]);
  });

  it("never takes a refund-heavy history as a negative usual level", () => {
    const items = buildInsights(input({ baseline: baseline(-3_000, -3_000, -3_000), monthSpend: [row(1, 3_000)] }));
    expect(only(items, "unusual_category")).toMatchObject([{ spentMinor: 3_000, baselineMinor: 0 }]);
    expect(only(buildInsights(input({ baseline: baseline(-3_000, -3_000, -3_000), monthSpend: [row(1, 2_999)] })), "unusual_category")).toEqual([]);
  });

  it("skips a category that already has a pace item, and words uncategorised as its own key", () => {
    const items = buildInsights(input({ budget: allocated(1, 5_000), baseline: [
      { month: "2026-09", hasData: true, rows: [row(1, 1_000), row(null, 1_000)] },
      { month: "2026-08", hasData: true, rows: [row(1, 1_000), row(null, 1_000)] },
    ], monthSpend: [row(1, 9_000), row(null, 9_000)] }));
    expect(only(items, "pace")).toHaveLength(1);
    expect(only(items, "unusual_category").map((i) => i.id)).toEqual(["unusual:uncategorised:2026-10"]);
  });
});

describe("large_charge", () => {
  it("fires for a new merchant at £100, not at £99.99", () => {
    expect(only(buildInsights(input({ charges: [charge()] })), "large_charge")).toEqual([
      { id: "large:7", type: "large_charge", severity: "info", transactionId: 7, merchantKey: "shop", name: "Shop", spentMinor: 10_000, merchantAverageMinor: null, countedDate: "2026-10-13", isPending: false },
    ]);
    expect(only(buildInsights(input({ charges: [charge({ spentMinor: 9_999 })] })), "large_charge")).toEqual([]);
  });

  it("never fires with 1 or 2 earlier charges", () => {
    expect(only(buildInsights(input({ charges: [charge({ spentMinor: 100_000, earlierCount: 2, earlierSpentMinor: 200 })] })), "large_charge")).toEqual([]);
  });

  it("fires at exactly 3× the average of 3+ earlier charges", () => {
    expect(only(buildInsights(input({ charges: [charge({ spentMinor: 12_000, earlierCount: 3, earlierSpentMinor: 12_000 })] })), "large_charge")).toMatchObject([
      { merchantAverageMinor: 4_000 },
    ]);
    expect(only(buildInsights(input({ charges: [charge({ spentMinor: 11_999, earlierCount: 3, earlierSpentMinor: 12_000 })] })), "large_charge")).toEqual([]);
  });
});

describe("month_change", () => {
  const months = (last: SpendRow[], previous: SpendRow[]) => ({
    lastMonth: { month: "2026-09", hasData: true, rows: last },
    previousMonth: { month: "2026-08", hasData: true, rows: previous },
  });

  it("shows on day 7 and not on day 8", () => {
    expect(only(buildInsights(input({ ...on("2026-10-07"), ...months([row(1, 5_000)], [row(1, 1_000)]) })), "month_change")).toEqual([
      { id: "month_change:1:2026-09", type: "month_change", severity: "info", categoryId: 1, month: "2026-09", spentMinor: 5_000, previousSpentMinor: 1_000, changeMinor: 4_000 },
    ]);
    expect(only(buildInsights(input({ ...on("2026-10-08"), ...months([row(1, 5_000)], [row(1, 1_000)]) })), "month_change")).toEqual([]);
  });

  it("needs £25 and 25%, with £0 the month before qualifying on £25 alone", () => {
    const at = on("2026-10-03");
    expect(only(buildInsights(input({ ...at, ...months([row(1, 2_500)], []) })), "month_change")).toHaveLength(1);
    expect(only(buildInsights(input({ ...at, ...months([row(1, 2_499)], []) })), "month_change")).toEqual([]);
    expect(only(buildInsights(input({ ...at, ...months([row(1, 12_500)], [row(1, 10_000)]) })), "month_change")).toHaveLength(1);
    expect(only(buildInsights(input({ ...at, ...months([row(1, 12_600)], [row(1, 10_100)]) })), "month_change")).toEqual([]);
  });

  it("keeps the 3 biggest changes, biggest first, and stays silent without the month before", () => {
    const at = on("2026-10-03");
    const items = buildInsights(input({ ...at, ...months([row(1, 3_000), row(2, 9_000), row(3, 0), row(4, 5_000)], [row(3, 7_000)]) }));
    expect(only(items, "month_change").map((i) => (i as { categoryId: number }).categoryId)).toEqual([2, 3, 4]);
    expect(only(buildInsights(input({ ...at, lastMonth: { month: "2026-09", hasData: true, rows: [row(1, 9_000)] }, previousMonth: { month: "2026-08", hasData: false, rows: [] } })), "month_change")).toEqual([]);
  });
});

describe("ranking", () => {
  const stale = { accounts: [{ id: 2, lastDataChangeAt: "2026-10-01T09:00:00Z" }] };

  it("mid-month: stale, over, projected, unusual, large charge", () => {
    const items = buildInsights(input({
      ...stale,
      budget: { overallMinor: 1_000_000, allocations: [{ categoryId: 1, allocatedMinor: 1_000 }, { categoryId: 2, allocatedMinor: 10_000 }] },
      monthSpend: [row(1, 2_000), row(2, 6_000), row(3, 9_000)],
      baseline: [{ month: "2026-09", hasData: true, rows: [row(3, 1_000)] }, { month: "2026-08", hasData: true, rows: [row(3, 1_000)] }],
      charges: [charge()],
    }));
    expect(items.map((i) => (i.type === "pace" ? `pace:${i.state}` : i.type))).toEqual([
      "stale_account", "pace:over", "pace:projected_over", "unusual_category", "large_charge",
    ]);
  });

  it("early in the month: stale, over, large charge, month change", () => {
    const items = buildInsights(input({
      ...on("2026-10-03"),
      // 5 London days before the 3rd.
      accounts: [{ id: 2, lastDataChangeAt: "2026-09-28T09:00:00Z" }],
      budget: allocated(1, 1_000),
      monthSpend: [row(1, 2_000)],
      charges: [charge()],
      lastMonth: { month: "2026-09", hasData: true, rows: [row(4, 9_000)] },
    }));
    expect(items.map((i) => i.type)).toEqual(["stale_account", "pace", "large_charge", "month_change"]);
  });
});
