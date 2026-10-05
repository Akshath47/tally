// The editor's rules for building an override. PUT /api/transactions/:id/override replaces the
// whole override, so every write starts from the row's current override fields.

import { parseMoneyInput } from "./money";

type Row = {
  amountMinor: number;
  txnDate: string;
  categoryId: number | null;
  categorySource: "override" | "rule" | null;
  excluded: boolean;
  countedAmountMinor: number | null;
  countedDate: string | null;
  note: string | null;
};

export type OverrideBody = {
  categoryId: number | null;
  excluded: boolean;
  countedAmountMinor: number | null;
  countedDate: string | null;
  note: string | null;
  applyToMerchant?: boolean;
};

/** The row's override as it stands. A rule's category isn't part of it: that row follows the rules. */
export const overrideOf = (t: Row): OverrideBody => ({
  categoryId: t.categorySource === "override" ? t.categoryId : null,
  excluded: t.excluded,
  countedAmountMinor: t.countedAmountMinor,
  countedDate: t.countedDate,
  note: t.note,
});

export type Draft = {
  /** The category picked in the editor (null = none), or undefined when it wasn't touched. */
  categoryId?: number | null;
  countInBudget: boolean;
  /** Typed amount, unsigned: the bank's sign is kept. */
  amountText: string;
  date: string;
  note: string;
  applyToMerchant: boolean;
};

export const draftOf = (t: Row, amountText: string): Draft => ({
  countInBudget: !t.excluded,
  amountText,
  date: t.countedDate ?? t.txnDate,
  note: t.note ?? "",
  applyToMerchant: false,
});

/**
 * The PUT body for a draft, or a reason it can't be sent. Values equal to the bank's are sent
 * as null, so an edit put back by hand stops counting as an override.
 */
export function buildOverride(t: Row, d: Draft): { body: OverrideBody } | { error: string } {
  const typed = parseMoneyInput(d.amountText);
  if (typed === null) return { error: "Enter the amount in pounds, like 32.00." };
  const signed = t.amountMinor < 0 ? -typed : typed;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return { error: "Pick a date." };
  if (d.note.length > 500) return { error: "Keep the note under 500 characters." };
  // Untouched, the category stays as it is: the override's own, or for "use for all", the one shown.
  const picked = d.categoryId !== undefined ? d.categoryId : d.applyToMerchant ? t.categoryId : overrideOf(t).categoryId;
  if (d.applyToMerchant && picked === null) return { error: "Pick a category to use for every transaction from this merchant." };
  return {
    body: {
      categoryId: picked,
      excluded: !d.countInBudget,
      countedAmountMinor: signed === t.amountMinor ? null : signed,
      countedDate: d.date === t.txnDate ? null : d.date,
      note: d.note.trim() === "" ? null : d.note,
      ...(d.applyToMerchant ? { applyToMerchant: true } : {}),
    },
  };
}
