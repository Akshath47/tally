import { describe, expect, it } from "vitest";
import { ageText, barState, fraction, remainingText } from "../../src/web/pace";

describe("barState", () => {
  it.each([
    [21_400, 30_000, "ok"],
    [18_600, 20_000, "near"],
    [18_000, 20_000, "near"],
    [17_999, 20_000, "ok"],
    [20_000, 20_000, "near"],
    [13_200, 12_000, "over"],
    [100, 0, "over"],
    [0, 0, "ok"],
    [-500, 10_000, "ok"],
  ])("%i of %i → %s", (spent, allocated, state) => {
    expect(barState(spent, allocated)).toBe(state);
  });
});

describe("remainingText", () => {
  it.each([
    [16, "2.3 weeks"],
    [31, "4.4 weeks"],
    [7, "1.0 weeks"],
    [5, "5 days"],
    [1, "today"],
  ])("%i days → %s", (days, text) => {
    expect(remainingText(days)).toBe(text);
  });
});

describe("fraction", () => {
  it("clamps to 0–1", () => {
    expect(fraction(50, 100)).toBe(0.5);
    expect(fraction(150, 100)).toBe(1);
    expect(fraction(-5, 100)).toBe(0);
    expect(fraction(5, 0)).toBe(1);
    expect(fraction(0, 0)).toBe(0);
  });
});

describe("ageText", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  it.each([
    ["2026-10-16T11:59:30Z", "just now"],
    ["2026-10-16T11:48:00Z", "12 min ago"],
    ["2026-10-16T09:00:00Z", "3h ago"],
    ["2026-10-15T11:00:00Z", "1 day ago"],
    ["2026-10-12T11:00:00Z", "4 days ago"],
  ])("%s → %s", (iso, text) => {
    expect(ageText(iso, now)).toBe(text);
  });
});
