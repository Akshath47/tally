// Built once and reused: constructing Intl formatters is the expensive part.
const timestampFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" });
const moneyFormats = new Map<string, { fmt: Intl.NumberFormat; exponent: number }>();

function moneyFormat(currency: string) {
  let entry = moneyFormats.get(currency);
  if (!entry) {
    const fmt = new Intl.NumberFormat("en-GB", { style: "currency", currency });
    entry = { fmt, exponent: fmt.resolvedOptions().maximumFractionDigits ?? 2 };
    moneyFormats.set(currency, entry);
  }
  return entry;
}

/**
 * Formats integer minor units without dividing as a float: the decimal string is built
 * from the integer's digits and handed to Intl, which formats decimal strings exactly.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const { fmt, exponent } = moneyFormat(currency);
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, "0");
  const decimal = exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  return fmt.format(`${amountMinor < 0 ? "-" : ""}${decimal}` as `${number}`);
}

/** ISO-8601 UTC timestamp → London wall-clock time. Never used for txn_date. */
export function formatTimestamp(iso: string | null): string {
  return iso ? timestampFormat.format(new Date(iso)) : "never";
}
