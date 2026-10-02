import type { ProviderAccount, ProviderTransaction } from "./client";
import { ImportError } from "./errors";
import { toMinor } from "./money";

/** A transaction in the shape the json_each upsert reads. Booleans are 0/1 for the SQL CHECKs. */
export type TransactionRow = {
  provider_txn_id: string;
  amount_minor: number;
  provider_amount: string;
  currency: string;
  txn_date: string;
  merchant: string;
  description: string;
  is_pending: 0 | 1;
  fingerprint: string;
};

const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;

/** Display label for an account. Revolut's `name` is its IBAN, which must never be stored. */
export function accountLabel(account: Pick<ProviderAccount, "name" | "institution_name">, currency: string | null): string {
  const compact = account.name.replace(/\s+/g, "").toUpperCase();
  if (!IBAN.test(compact)) return `${account.institution_name} · ${account.name}`;
  const parts = [account.institution_name, currency, `••${compact.slice(-4)}`];
  return parts.filter(Boolean).join(" · ");
}

/** Sign is already negative = money out for both institutions (docs/lunchflow-findings.md), so none is flipped. */
export function normalizeTransaction(t: ProviderTransaction, accountId: number, accountCurrency: string): TransactionRow {
  if (t.currency !== accountCurrency) throw new ImportError("invalid_response");
  const { minor, providerAmount } = toMinor(t.amount, t.currency);
  const text = `${t.merchant} ${t.description}`.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  return {
    provider_txn_id: t.id,
    amount_minor: minor,
    provider_amount: providerAmount,
    currency: t.currency,
    txn_date: t.date,
    merchant: t.merchant,
    description: t.description,
    is_pending: t.isPending ? 1 : 0,
    fingerprint: `${accountId}|${t.date}|${minor}|${text}`,
  };
}
