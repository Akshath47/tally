import { describe, expect, it } from "vitest";
import { formatMoney, formatTimestamp } from "../../src/web/format";

describe("formatMoney", () => {
  it.each([
    [-1230, "GBP", "-£12.30"],
    [1, "GBP", "£0.01"],
    [-1, "GBP", "-£0.01"],
    [0, "GBP", "£0.00"],
    [123456, "GBP", "£1,234.56"],
    // 0.1 + 0.2 territory: built from digits, never divided as a float.
    [30, "GBP", "£0.30"],
    [900719925474099, "GBP", "£9,007,199,254,740.99"],
    [-500, "JPY", "-JP¥500"],
    [1234, "USD", "US$12.34"],
  ])("%i %s → %s", (minor, currency, expected) => {
    expect(formatMoney(minor, currency)).toBe(expected);
  });
});

describe("formatTimestamp", () => {
  it("shows London time across the BST boundary", () => {
    expect(formatTimestamp("2026-10-02T12:00:00.000Z")).toBe("2 Oct 2026, 13:00");
    expect(formatTimestamp("2026-12-02T12:00:00.000Z")).toBe("2 Dec 2026, 12:00");
  });

  it("says never for a missing timestamp", () => {
    expect(formatTimestamp(null)).toBe("never");
  });
});
