import { describe, expect, it } from "vitest";
import { formatPounds, formatSigned, formatUnsigned, minorToInput, parseMoneyInput, poundsInput } from "../../src/web/money";

describe("parseMoneyInput", () => {
  it.each([
    ["12", 1200],
    ["12.3", 1230],
    ["12.30", 1230],
    ["0.1", 10],
    ["0.30", 30],
    [".", null],
    ["£1,234.56", 123456],
    ["  £ 64 ", 6400],
    ["1800", 180000],
    ["12.", 1200],
    ["0", 0],
    ["", null],
    ["12.345", null],
    ["-5", null],
    ["1,23", null],
    ["1e3", null],
    ["abc", null],
    ["99999999999999999", null],
  ])("%j → %j", (text, minor) => {
    expect(parseMoneyInput(text)).toBe(minor);
  });

  it("never goes through a float", () => {
    // 0.1 + 0.2 territory: 0.29 * 100 is 28.999… as a float.
    expect(parseMoneyInput("0.29")).toBe(29);
    expect(parseMoneyInput("1.15")).toBe(115);
    expect(parseMoneyInput("4.35")).toBe(435);
  });
});

describe("formatting", () => {
  it.each([
    [3200, "32.00"],
    [5, "0.05"],
    [-1999, "19.99"],
    [0, "0.00"],
  ])("minorToInput(%i) = %s", (minor, text) => {
    expect(minorToInput(minor)).toBe(text);
  });

  it.each([
    [180_000, "1,800"],
    [180_050, "1,800.50"],
    [12_000, "120"],
    [123_456_700, "1,234,567"],
    [5, "0.05"],
  ])("poundsInput(%i) = %s and reads back", (minor, text) => {
    expect(poundsInput(minor)).toBe(text);
    expect(parseMoneyInput(text)).toBe(minor);
  });

  it.each([
    [125_440, "£1,254"],
    [125_450, "£1,255"],
    [180_000, "£1,800"],
    [49, "£0"],
    [50, "£1"],
    [-11_200, "−£112"],
    [-49, "£0"],
  ])("formatPounds(%i) = %s", (minor, text) => {
    expect(formatPounds(minor)).toBe(text);
  });

  it("signs feed amounts with a real minus", () => {
    expect(formatSigned(-1420, "GBP")).toBe("−£14.20");
    expect(formatSigned(310_000, "GBP")).toBe("+£3,100.00");
    expect(formatSigned(0, "GBP")).toBe("£0.00");
    expect(formatUnsigned(-2360, "GBP")).toBe("£23.60");
  });
});
