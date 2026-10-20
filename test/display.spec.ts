import { describe, expect, it } from "vitest";
import { formatPounds, formatShortDate, ordinal } from "../src/worker/display";

describe("ordinal", () => {
  it.each([
    [1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [11, "11th"], [12, "12th"], [13, "13th"], [21, "21st"], [22, "22nd"], [23, "23rd"], [31, "31st"],
  ])("%i → %s", (n, s) => expect(ordinal(n)).toBe(s));
});

describe("moved formatters", () => {
  it("still format as the web did", () => {
    expect(formatPounds(100_340)).toBe("£1,003");
    expect(formatShortDate("2026-10-15", "2026-10-16")).toBe("Thu 15 Oct");
  });
});
