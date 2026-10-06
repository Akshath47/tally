import { describe, expect, it } from "vitest";
import { addDays, addMonths, daysInMonth, daysRemaining, formatDayMonth, formatShortDate, londonToday, monthName, yearSuffix } from "../../src/web/dates";

describe("londonToday", () => {
  it.each([
    // BST starts 29 Mar 2026: late UTC evening is already the next day in London.
    ["2026-03-31T23:30:00Z", "2026-04-01"],
    ["2026-06-30T23:00:00Z", "2026-07-01"],
    ["2026-06-30T22:59:59Z", "2026-06-30"],
    // GMT: London matches UTC.
    ["2026-12-31T23:59:59Z", "2026-12-31"],
    ["2027-01-01T00:00:00Z", "2027-01-01"],
    // BST ends 25 Oct 2026 at 01:00 UTC.
    ["2026-10-25T00:30:00Z", "2026-10-25"],
    ["2026-10-31T23:30:00Z", "2026-10-31"],
  ])("%s → %s", (iso, expected) => {
    expect(londonToday(new Date(iso))).toBe(expected);
  });
});

describe("month arithmetic", () => {
  it.each([
    ["2026-01", 31],
    ["2026-02", 28],
    ["2028-02", 29],
    ["2100-02", 28],
    ["2000-02", 29],
    ["2026-04", 30],
    ["2026-10", 31],
  ])("daysInMonth(%s) = %i", (month, days) => {
    expect(daysInMonth(month)).toBe(days);
  });

  it("counts today in the days remaining", () => {
    expect(daysRemaining("2026-10-31")).toBe(1);
    expect(daysRemaining("2026-10-01")).toBe(31);
    expect(daysRemaining("2026-02-15")).toBe(14);
  });

  it("moves across year edges", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-10", -13)).toBe("2025-09");
  });

  it("adds days across month and DST edges without shifting", () => {
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-10-25", -1)).toBe("2026-10-24");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("display dates", () => {
  const today = "2026-10-06";

  it.each([
    ["2026-10-15", "Thu 15 Oct"],
    ["2026-10-01", "Thu 1 Oct"],
    ["2026-03-29", "Sun 29 Mar"],
    ["2026-01-01", "Thu 1 Jan"],
    ["2026-12-31", "Thu 31 Dec"],
    // Outside this year the year is shown: history goes back about two years.
    ["2025-12-31", "Wed 31 Dec 2025"],
    ["2024-10-15", "Tue 15 Oct 2024"],
    ["2028-02-29", "Tue 29 Feb 2028"],
    ["2027-01-01", "Fri 1 Jan 2027"],
  ])("%s → %s", (date, expected) => {
    expect(formatShortDate(date, today)).toBe(expected);
  });

  it("adds the year to dates and months outside today's year", () => {
    expect(formatDayMonth("2026-09-03", today)).toBe("3 Sep");
    expect(formatDayMonth("2025-09-03", today)).toBe("3 Sep 2025");
    expect(yearSuffix("2026-03", "2026-10")).toBe("");
    expect(yearSuffix("2024-11", "2026-10")).toBe(" 2024");
    expect(monthName("2026-10")).toBe("October");
  });
});
