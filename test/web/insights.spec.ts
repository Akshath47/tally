import { describe, expect, it } from "vitest";
import { iconOf, isMonthChangeOnly, targetOf, toneOf, weekRange, type Insight } from "../../src/web/insights";

// Synthetic figures. The wording itself is the Worker's, tested in test/insights/wording.spec.ts.

const base = { id: "x" };
const pace = (over: Partial<Extract<Insight, { type: "pace" }>> = {}): Insight => ({ ...base, type: "pace", severity: "over", state: "over", categoryId: 2, spentMinor: 18_400, allocatedMinor: 16_000, projectedMinor: 0, ...over });
const charge: Extract<Insight, { type: "large_charge" }> = { ...base, type: "large_charge", severity: "info", transactionId: 9, merchantKey: "halden audio", name: "Halden Audio", spentMinor: 24_000, merchantAverageMinor: null, countedDate: "2026-10-13", isPending: false };
const change = (changeMinor: number): Insight => ({ ...base, type: "month_change", severity: "info", categoryId: 3, month: "2026-09", spentMinor: 13_200, previousSpentMinor: 8_700, changeMinor });

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

  it("week ranges, within a month and across two", () => {
    expect(weekRange("2026-10-12", "2026-10-16")).toBe("Mon 12 – Sun 18 Oct");
    expect(weekRange("2026-09-28", "2026-10-02")).toBe("Mon 28 Sep – Sun 4 Oct");
  });
});

describe("week card helpers", () => {
  it("formats a send time in London, across the clock change", async () => {
    const { londonDayTime } = await import("../../src/web/insights");
    expect(londonDayTime("2026-10-11T17:00:00Z", "2026-10-16")).toBe("Sun 11 Oct, 18:00");
    expect(londonDayTime("2026-11-08T18:00:00Z", "2026-11-10")).toBe("Sun 8 Nov, 18:00");
  });

  it("counts the week's days from the previous month", async () => {
    const { daysOfPreviousMonth } = await import("../../src/web/insights");
    expect(daysOfPreviousMonth("2026-09-28", "2026-10-02")).toBe(3);
    expect(daysOfPreviousMonth("2026-10-12", "2026-10-16")).toBe(0);
  });
});
