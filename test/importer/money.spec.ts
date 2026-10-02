import { describe, expect, it } from "vitest";
import { ImportError } from "../../src/worker/importer/errors";
import { toMinor } from "../../src/worker/importer/money";

describe("toMinor", () => {
  it.each([
    [12.3, "GBP", 1230],
    [-0.01, "GBP", -1],
    [1234.56, "GBP", 123456],
    [0, "GBP", 0],
    [-0, "GBP", 0],
    [21.6, "USD", 2160],
    [100, "GBP", 10000],
  ])("converts %s %s to %s minor units", (amount, currency, minor) => {
    expect(toMinor(amount, currency)).toEqual({ minor, providerAmount: String(amount === 0 ? 0 : amount) });
  });

  it("keeps the original decimal as text", () => {
    expect(toMinor(-12.3, "GBP").providerAmount).toBe("-12.3");
  });

  it.each([0.1 + 0.2, 1.234, -0.001])("flags %s as having more decimals than GBP allows", (amount) => {
    expect(() => toMinor(amount, "GBP")).toThrowError(expect.objectContaining({ kind: "precision" }));
  });

  it.each([1e-7, 1e21, Number.NaN, Infinity, 2 ** 60])("rejects %s", (amount) => {
    expect(() => toMinor(amount, "GBP")).toThrow(ImportError);
  });

  it("rejects an unknown currency", () => {
    expect(() => toMinor(1, "XYZ")).toThrowError(expect.objectContaining({ kind: "invalid_response" }));
  });
});
