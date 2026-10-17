import { describe, expect, it } from "vitest";
import { iconOf, insightWords, isMonthChangeOnly, ordinal, targetOf, toneOf, weekRange, type Insight, type Names } from "../../src/web/insights";

// Synthetic names and figures. The wording cases are P2.10's (docs/insights-plan.md, Task 4), so
// the stand-in says exactly what the Worker's module will.

const names: Names = {
  category: (id) => (id === null ? "Uncategorised" : ({ 1: "Groceries", 2: "Eating out", 3: "Transport" } as Record<number, string>)[id]!),
  account: () => "Card B",
};
const words = (item: Insight, today = "2026-10-12") => insightWords(item, names, today);
const base = { id: "x" };
const pace = (over: Partial<Extract<Insight, { type: "pace" }>> = {}): Insight => ({ ...base, type: "pace", severity: "over", state: "over", categoryId: 2, spentMinor: 18_400, allocatedMinor: 16_000, projectedMinor: 0, ...over });
const charge: Extract<Insight, { type: "large_charge" }> = { ...base, type: "large_charge", severity: "info", transactionId: 9, merchantKey: "halden audio", name: "Halden Audio", spentMinor: 24_000, merchantAverageMinor: null, countedDate: "2026-10-13", isPending: false };
const change = (changeMinor: number): Insight => ({ ...base, type: "month_change", severity: "info", categoryId: 3, month: "2026-09", spentMinor: 13_200, previousSpentMinor: 8_700, changeMinor });

describe("insightWords", () => {
  it("stale account", () =>
    expect(words({ ...base, type: "stale_account", severity: "warn", accountId: 2, staleDays: 5 })).toEqual({ headline: "Card B hasn't updated for 5 days", detail: "Recent spending may be missing." }));

  it("pace over, for a category and for the whole budget", () => {
    expect(words(pace())).toEqual({ headline: "Eating out is £24 over", detail: "£184 of £160 this month" });
    expect(words(pace({ categoryId: null, spentMinor: 153_000, allocatedMinor: 144_000 }))).toEqual({ headline: "£90 over this month's budget", detail: "£1,530 of £1,440" });
  });

  it("pace projected, for a category and for the whole budget", () => {
    const projected = { severity: "warn" as const, state: "projected_over" as const };
    expect(words(pace({ ...projected, spentMinor: 9_600, allocatedMinor: 16_000, projectedMinor: 20_000 }))).toEqual({ headline: "Eating out is on course to end £40 over", detail: "£96 by the 12th, £160 allocated" });
    expect(words(pace({ ...projected, categoryId: null, spentMinor: 76_000, allocatedMinor: 144_000, projectedMinor: 156_000 }), "2026-10-16")).toEqual({
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
    expect(words(charge, "2026-10-15")).toEqual({ headline: "£240.00 at Halden Audio", detail: "New merchant · Tue 13 Oct" });
    expect(words({ ...charge, merchantAverageMinor: 5_800 })).toEqual({ headline: "£240.00 at Halden Audio", detail: "About 4× your usual £58.00 there" });
    expect(words({ ...charge, isPending: true }, "2026-10-15").detail).toBe("Pending · New merchant · Tue 13 Oct");
  });

  it("month change, up and down", () => {
    expect(words(change(4_500))).toEqual({ headline: "Transport up £45 in September", detail: "£132, from £87 in August" });
    expect(words({ ...change(-5_000), categoryId: null } as Insight).headline).toBe("Uncategorised down £50 in September");
  });
});

describe("how the tab shows them", () => {
  it("tones and icons follow severity and type", () => {
    expect([toneOf(pace()), toneOf(pace({ severity: "warn", state: "projected_over" })), toneOf(charge)]).toEqual(["over", "warn", "neutral"]);
    expect([iconOf(pace()), iconOf(pace({ state: "projected_over" })), iconOf(change(1)), iconOf(change(-1)), iconOf(charge)]).toEqual(["over", "projected", "up", "down", "charge"]);
  });

  it("targets the brief's screens", () => {
    const today = "2026-10-16";
    expect(targetOf(pace(), today)).toEqual({ href: "/spending/2026-10/2" });
    expect(targetOf(pace({ categoryId: null }), today)).toEqual({ href: "/" });
    expect(targetOf({ ...base, type: "unusual_category", severity: "warn", categoryId: null, spentMinor: 1, baselineMinor: 1 }, today)).toEqual({ href: "/to-sort" });
    expect(targetOf({ ...base, type: "stale_account", severity: "warn", accountId: 2, staleDays: 4 }, today)).toEqual({ href: "/accounts" });
    expect(targetOf(change(1), today)).toEqual({ href: "/insights/review/2026-09" });
    expect(targetOf(charge, today)).toEqual({ transactionId: 9, merchantKey: "halden audio" });
  });

  it("knows when only month changes are showing", () => {
    expect(isMonthChangeOnly([change(1), change(-1)])).toBe(true);
    expect(isMonthChangeOnly([change(1), charge])).toBe(false);
    expect(isMonthChangeOnly([])).toBe(false);
  });

  it("ordinals", () => expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]));

  it("week ranges, within a month and across two", () => {
    expect(weekRange("2026-10-12", "2026-10-16")).toBe("Mon 12 – Sun 18 Oct");
    expect(weekRange("2026-09-28", "2026-10-02")).toBe("Mon 28 Sep – Sun 4 Oct");
  });
});
