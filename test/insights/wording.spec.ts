import { describe, expect, it } from "vitest";
import type { Insight } from "../../src/worker/insights/rules";
import { insightWords, type Names } from "../../src/worker/insights/wording";

// Synthetic names and figures. The copy matches docs/insights-ui-brief.md.

const names: Names = {
  category: (id) => (id === null ? "Uncategorised" : ({ 1: "Groceries", 2: "Eating out", 3: "Transport" } as Record<number, string>)[id]!),
  account: () => "Card B",
};
const words = (item: Insight, today = "2026-10-12") => insightWords(item, names, today);
const base = { id: "x" };

describe("insightWords", () => {
  it("stale account", () =>
    expect(words({ ...base, type: "stale_account", severity: "warn", accountId: 2, staleDays: 5 })).toEqual({
      headline: "Card B hasn't updated for 5 days",
      detail: "Recent spending may be missing.",
    }));

  it("shows pence when over by less than £1, never £0", () => {
    const pace = { ...base, type: "pace" as const, severity: "over" as const, state: "over" as const, categoryId: 2, spentMinor: 10_001, allocatedMinor: 10_000, projectedMinor: 0 };
    expect(words(pace).headline).toBe("Eating out is £0.01 over");
    expect(words({ ...pace, severity: "warn", state: "projected_over", spentMinor: 5_000, projectedMinor: 10_040 }).headline).toBe("Eating out is on course to end £0.40 over");
  });

  it("pace over, for a category and for the whole budget", () => {
    const pace = { ...base, type: "pace" as const, severity: "over" as const, state: "over" as const, spentMinor: 18_400, allocatedMinor: 16_000, projectedMinor: 0 };
    expect(words({ ...pace, categoryId: 2 })).toEqual({ headline: "Eating out is £24 over", detail: "£184 of £160 this month" });
    expect(words({ ...pace, categoryId: null, spentMinor: 153_000, allocatedMinor: 144_000 })).toEqual({ headline: "£90 over this month's budget", detail: "£1,530 of £1,440" });
  });

  it("pace projected, for a category and for the whole budget", () => {
    const pace = { ...base, type: "pace" as const, severity: "warn" as const, state: "projected_over" as const };
    expect(words({ ...pace, categoryId: 2, spentMinor: 9_600, allocatedMinor: 16_000, projectedMinor: 20_000 })).toEqual({
      headline: "Eating out is on course to end £40 over",
      detail: "£96 by the 12th, £160 allocated",
    });
    expect(words({ ...pace, categoryId: null, spentMinor: 76_000, allocatedMinor: 144_000, projectedMinor: 156_000 }, "2026-10-16")).toEqual({
      headline: "On course to end the month £120 over",
      detail: "£760 by the 16th, £1,440 budget",
    });
  });

  it("unusual category", () =>
    expect(words({ ...base, type: "unusual_category", severity: "warn", categoryId: 1, spentMinor: 21_000, baselineMinor: 12_000 }, "2026-10-16")).toEqual({
      headline: "Groceries is running high",
      detail: "£210 so far, usually about £120 by the 16th",
    }));

  it("large charge: new, out of line, and pending", () => {
    const charge = { ...base, type: "large_charge" as const, severity: "info" as const, transactionId: 1, merchantKey: "halden audio", name: "Halden Audio", spentMinor: 24_000, countedDate: "2026-10-13", isPending: false };
    expect(words({ ...charge, merchantAverageMinor: null }, "2026-10-15")).toEqual({ headline: "£240.00 at Halden Audio", detail: "New merchant · Tue 13 Oct" });
    expect(words({ ...charge, merchantAverageMinor: 5_800 })).toEqual({ headline: "£240.00 at Halden Audio", detail: "About 4× your usual £58.00 there" });
    expect(words({ ...charge, merchantAverageMinor: null, isPending: true }, "2026-10-15").detail).toBe("Pending · New merchant · Tue 13 Oct");
  });

  it("month change, up and down", () => {
    const change = { ...base, type: "month_change" as const, severity: "info" as const, month: "2026-09" };
    expect(words({ ...change, categoryId: 3, spentMinor: 13_200, previousSpentMinor: 8_700, changeMinor: 4_500 })).toEqual({
      headline: "Transport up £45 in September",
      detail: "£132, from £87 in August",
    });
    expect(words({ ...change, categoryId: null, spentMinor: 1_000, previousSpentMinor: 6_000, changeMinor: -5_000 }).headline).toBe("Uncategorised down £50 in September");
  });
});
