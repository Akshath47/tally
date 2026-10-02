import { z } from "zod";
import { isYmd } from "./dates";
import { ImportError } from "./errors";
import type { Window } from "./windows";

const BASE_URL = "https://lunchflow.app/api/v1";
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const BACKOFF_MS = 500;
const RETRY_AFTER_CAP_MS = 10_000;
// Free tier allows 50 subrequests per invocation; a run needs about 5-10, so 20 leaves room for retries.
export const SUBREQUEST_CAP = 20;

const AccountSchema = z.object({
  id: z.number().int(),
  connection_id: z.number().int().nullish(),
  name: z.string(),
  institution_name: z.string(),
  status: z.string(),
});

const TransactionSchema = z.object({
  id: z.string().min(1),
  accountId: z.number().int(),
  amount: z.number().finite(),
  currency: z.string().min(1),
  date: z.string().refine(isYmd),
  merchant: z.string(),
  description: z.string(),
  isPending: z.boolean(),
});

const AccountsResponse = z.object({ accounts: z.array(AccountSchema) });
const TransactionsResponse = z.object({ transactions: z.array(TransactionSchema) });
const BalanceResponse = z.object({ balance: z.object({ amount: z.number().finite(), currency: z.string().min(1) }) });

export type ProviderAccount = z.infer<typeof AccountSchema>;
export type ProviderTransaction = z.infer<typeof TransactionSchema>;
export type ProviderBalance = z.infer<typeof BalanceResponse>["balance"];

export type ClientDeps = {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export function createClient({ apiKey, fetch: fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: ClientDeps) {
  let subrequests = 0;

  async function attempt<T>(path: string, schema: z.ZodType<T>): Promise<T | { retryAfterMs: number | null; error: ImportError }> {
    if (subrequests >= SUBREQUEST_CAP) throw new ImportError("budget");
    subrequests++;

    let res: Response;
    try {
      res = await fetchImpl(BASE_URL + path, {
        headers: { "x-api-key": apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e instanceof DOMException && e.name === "TimeoutError";
      return { retryAfterMs: null, error: new ImportError(timedOut ? "timeout" : "network") };
    }

    if (res.ok) {
      const parsed = schema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new ImportError("invalid_response", res.status);
      return parsed.data;
    }

    // Error bodies are never read: provider text must not reach logs or the database.
    await res.body?.cancel();
    const { status } = res;
    if (status === 401 || status === 403) throw new ImportError("config", status);
    if (status === 404) throw new ImportError("not_found", status);
    if (status === 429) return { retryAfterMs: parseRetryAfter(res.headers.get("retry-after")), error: new ImportError("rate_limited", status) };
    if (status >= 500) return { retryAfterMs: null, error: new ImportError("server", status) };
    throw new ImportError("invalid_response", status);
  }

  async function request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    for (let retry = 0; ; retry++) {
      const result = await attempt(path, schema);
      if (!isRetryable(result)) return result;
      if (retry === MAX_RETRIES) throw result.error;
      await sleep(result.retryAfterMs ?? BACKOFF_MS * 2 ** retry);
    }
  }

  return {
    get subrequests() {
      return subrequests;
    },
    async accounts(): Promise<ProviderAccount[]> {
      return (await request("/accounts", AccountsResponse)).accounts;
    },
    async balance(accountId: number): Promise<ProviderBalance> {
      return (await request(`/accounts/${accountId}/balance`, BalanceResponse)).balance;
    },
    /** Always bounded by a window, since an unbounded call returns the account's whole history. */
    async transactions(accountId: number, window: Window): Promise<ProviderTransaction[]> {
      const query = new URLSearchParams({ from: window.from, to: window.to, include_pending: "true" });
      return (await request(`/accounts/${accountId}/transactions?${query}`, TransactionsResponse)).transactions;
    },
  };
}

export type LunchFlowClient = ReturnType<typeof createClient>;

function isRetryable(r: unknown): r is { retryAfterMs: number | null; error: ImportError } {
  return typeof r === "object" && r !== null && "error" in r && r.error instanceof ImportError;
}

function parseRetryAfter(header: string | null): number | null {
  const seconds = header !== null && /^\d+$/.test(header) ? Number(header) : null;
  return seconds === null ? null : Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}
