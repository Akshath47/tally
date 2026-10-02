const TIME_ZONE = "Europe/London";

/**
 * Formats integer minor units without dividing as a float: the decimal string is built
 * from the integer's digits and handed to Intl, which formats decimal strings exactly.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const fmt = new Intl.NumberFormat("en-GB", { style: "currency", currency });
  const exponent = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, "0");
  const decimal = exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  return fmt.format(`${amountMinor < 0 ? "-" : ""}${decimal}` as `${number}`);
}

/** ISO-8601 UTC timestamp → London wall-clock time. Never used for txn_date. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-GB", { timeZone: TIME_ZONE, dateStyle: "medium", timeStyle: "short" });
}
