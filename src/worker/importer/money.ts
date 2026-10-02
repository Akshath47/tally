import { ImportError } from "./errors";

// Minor-unit exponent per currency. An unlisted currency is an error rather than a guess.
const EXPONENTS: Record<string, number> = { GBP: 2, USD: 2, EUR: 2 };

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Converts a provider decimal to integer minor units by string arithmetic, never float
 * multiplication. Amounts with more decimals than the currency allows (including float
 * noise like 0.1 + 0.2) throw `precision` so the account is flagged instead of rounded.
 */
export function toMinor(amount: number, currency: string): { minor: number; providerAmount: string } {
  const exponent = EXPONENTS[currency];
  if (exponent === undefined) throw new ImportError("invalid_response");

  // String(n) switches to exponent notation outside 1e-7..1e21; those aren't real bank amounts.
  const providerAmount = String(amount);
  const match = DECIMAL.exec(providerAmount);
  if (!Number.isFinite(amount) || !match) throw new ImportError("invalid_response");

  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > exponent) throw new ImportError("precision");

  const magnitude = Number(whole + fraction.padEnd(exponent, "0"));
  if (!Number.isSafeInteger(magnitude)) throw new ImportError("invalid_response");

  return { minor: magnitude === 0 || sign === "" ? magnitude : -magnitude, providerAmount };
}
