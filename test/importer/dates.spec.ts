import { describe, expect, it } from "vitest";
import { addDays, isYmd, londonToday } from "../../src/worker/importer/dates";

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
