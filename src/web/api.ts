// Response shapes from src/worker/routes. Bank text (merchant, description) is untrusted
// and only ever rendered as text.

export type Account = {
  id: number;
  name: string;
  institutionName: string | null;
  providerStatus: string;
  currency: string | null;
  importEnabled: boolean;
  lastImportSuccessAt: string | null;
  lastImportError: string | null;
  lastDataChangeAt: string | null;
  newestTxnDate: string | null;
};

export type Transaction = {
  id: number;
  accountId: number;
  amountMinor: number;
  currency: string;
  txnDate: string;
  merchant: string;
  description: string;
  isPending: boolean;
  vanishedAt: string | null;
};

export type ImportRun = {
  id: number;
  trigger: "cron" | "manual";
  startedAt: string;
  status: string;
  errorSummary: string | null;
  accounts: { accountId: number; status: string; inserted: number; updated: number; error: string | null }[];
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown> | null,
  ) {
    super(`HTTP ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // A 2xx without JSON is usually the Access login page after the session expired.
  if (!res.ok || body === null) throw new ApiError(res.status, body);
  return body as T;
}

export const getAccounts = () => request<{ accounts: Account[] }>("/api/accounts");

export const getRuns = (limit: number) => request<{ runs: ImportRun[] }>(`/api/import-runs?limit=${limit}`);

export function getTransactions(limit: number, accountId: number | null) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (accountId !== null) query.set("account_id", String(accountId));
  return request<{ transactions: Transaction[]; nextCursor: string | null }>(`/api/transactions?${query}`);
}

/** 202: the import carries on in the background; watch it via getRuns. */
export const startImport = () =>
  request<{ status: "started" }>("/api/import-runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
