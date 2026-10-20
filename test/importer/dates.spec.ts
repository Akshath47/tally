import { describe, expect, it } from "vitest";
import { addDays, daysBetween, daysInMonth, isYmd, londonMonth, londonToday } from "../../src/worker/importer/dates";

describe("londonToday", () => {
  it("is the next calendar day at 23:30 UTC during BST", () => {
    expect(londonToday(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
  });

  it("is the same calendar day at 23:30 UTC during GMT", () => {
    expect(londonToday(new Date("2026-12-01T23:30:00Z"))).toBe("2026-12-01");
  });

  it("switches at the last-Sunday-of-March changeover (01:00 UTC)", () => {
    expect(londonToday(new Date("2026-03-28T23:30:00Z"))).toBe("2026-03-28");
    expect(londonToday(new Date("2026-03-29T00:59:00Z"))).toBe("2026-03-29");
    expect(londonToday(new Date("2026-03-29T23:30:00Z"))).toBe("2026-03-30");
  });

  it("switches at the last-Sunday-of-October changeover", () => {
    expect(londonToday(new Date("2026-10-24T23:30:00Z"))).toBe("2026-10-25");
    expect(londonToday(new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-25");
  });
});

describe("londonMonth", () => {
  it.each([
    ["2026-03-31T23:30:00Z", "2026-04"], // BST: already 1 April in London
    ["2026-10-31T23:30:00Z", "2026-10"], // GMT: still 31 October
    ["2026-12-31T23:59:00Z", "2026-12"],
    ["2027-01-01T00:00:00Z", "2027-01"],
  ])("%s is %s", (iso, month) => {
    expect(londonMonth(new Date(iso))).toBe(month);
  });
});

describe("daysInMonth", () => {
  it.each([
    ["2026-02", 28],
    ["2024-02", 29],
    ["2026-04", 30],
    ["2026-10", 31],
    ["2026-12", 31],
  ])("%s has %i days", (month, days) => {
    expect(daysInMonth(month)).toBe(days);
  });
});

describe("daysInMonth rejects", () => {
  it.each(["2026-00", "2026-13", "2026-1", "2026-10-01"])("%s", (month) => {
    expect(() => daysInMonth(month)).toThrow();
  });
});

describe("addDays", () => {
  it.each([
    ["2026-10-02", -13, "2026-09-19"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2024-03-01", -1, "2024-02-29"],
    ["2026-01-01", -1, "2025-12-31"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-10-25", 0, "2026-10-25"],
    // Calendar arithmetic across the clock change must not shift by an hour's worth of day.
    ["2026-03-29", 1, "2026-03-30"],
    ["2026-10-25", -1, "2026-10-24"],
  ])("%s %+d days is %s", (ymd, days, expected) => {
    expect(addDays(ymd, days)).toBe(expected);
  });
});

describe("isYmd", () => {
  it.each(["2026-10-02", "2024-02-29"])("accepts %s", (v) => expect(isYmd(v)).toBe(true));
  it.each(["2026-10-02T00:00:00Z", "2026-1-2", "2026-02-30", "2025-02-29", "", "02/10/2026"])("rejects %s", (v) =>
    expect(isYmd(v)).toBe(false),
  );
});

describe("daysBetween", () => {
  it.each([
    ["2026-10-11", "2026-10-15", 4],
    ["2026-10-15", "2026-10-15", 0],
    ["2026-10-15", "2026-10-11", -4],
    ["2026-02-27", "2026-03-01", 2],
    ["2024-02-28", "2024-03-01", 2],
  ])("%s → %s is %i", (from, to, days) => expect(daysBetween(from, to)).toBe(days));

  it("rejects an impossible date", () => expect(() => daysBetween("2026-02-30", "2026-03-01")).toThrow());
});
