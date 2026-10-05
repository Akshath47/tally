// Money stays integer minor units (pence). Typed amounts become minor units by string
// arithmetic, never through a float, as docs/phase-2-spec.md asks.

import { formatMoney } from "./format";

const MINUS = "−";

/**
 * A typed amount ("12", "12.5", "£1,234.56") as positive minor units, or null when it isn't a
 * plain amount with at most two decimals. Signs are refused: the screens decide the sign.
 */
export function parseMoneyInput(text: string): number | null {
  const cleaned = text.trim().replace(/^£\s*/, "");
  // Thousands separators only between groups of three digits.
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.replace(/,/g, "").split(".");
  const minor = Number(`${whole}${fraction.padEnd(2, "0")}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units as an input's text: 3200 → "32.00". Sign dropped. */
export function minorToInput(minor: number): string {
  const digits = String(Math.abs(minor)).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** A budget input's text: "1,800", or "1,800.50" when there are pence. parseMoneyInput reads both back. */
export function poundsInput(minor: number): string {
  const [whole, pence] = minorToInput(minor).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+$)/g, ",");
  return pence === "00" ? grouped : `${grouped}.${pence}`;
}

const poundsFormat = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0, minimumFractionDigits: 0 });

/** Budget figures in whole pounds, rounded half away from zero: 125_440 → "£1,254", −1_250 → "−£13". */
export function formatPounds(minor: number): string {
  const abs = Math.abs(minor);
  const pounds = (abs - (abs % 100)) / 100 + (abs % 100 >= 50 ? 1 : 0);
  return `${minor < 0 && pounds > 0 ? MINUS : ""}${poundsFormat.format(pounds)}`;
}

/** A transaction amount as feeds show it: money out "−£14.20", money in "+£14.20". */
export function formatSigned(amountMinor: number, currency: string): string {
  const abs = formatMoney(Math.abs(amountMinor), currency);
  return amountMinor < 0 ? `${MINUS}${abs}` : amountMinor > 0 ? `+${abs}` : abs;
}

/** An amount without its sign: "£23.60". */
export const formatUnsigned = (amountMinor: number, currency: string) => formatMoney(Math.abs(amountMinor), currency);
