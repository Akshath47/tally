import { describe, expect, it } from "vitest";
import { floorDiv, projectedMinor } from "../../src/worker/analytics/math";
import { monthsEnding } from "../../src/worker/importer/dates";

describe("floorDiv", () => {
  it.each([
    [7, 2, 3],
    [6, 2, 3],
    [-1, 2, -1],
    [-7, 2, -4],
    [0, 5, 0],
    [2001, 2, 1000],
  ])("%i ÷ %i → %i", (a, b, q) => expect(floorDiv(a, b)).toBe(q));
});

describe("projectedMinor", () => {
  it("floors spend × days in month ÷ day of month", () => expect(projectedMinor(1001, 3, 31)).toBe(10343));
  it("is the spend itself on the last day", () => expect(projectedMinor(5000, 30, 30)).toBe(5000));
});

describe("monthsEnding", () => {
  it("lists the months up to and including the last, oldest first, across a year", () =>
    expect(monthsEnding("2026-02", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]));
});
