import type { CATEGORY_KINDS, IMPORT_RUN_STATUSES, IMPORT_TRIGGERS, MATCH_TYPES } from "../worker/db/schema";

// Request and response shapes from docs/schema-and-api.md and src/worker/routes. Money is
// integer minor units. Budget and spend figures are positive = spend; transaction amounts keep
// the bank sign. Months are YYYY-MM, dates YYYY-MM-DD. Bank text (merchant, description, note)
// is untrusted and only ever rendered as text.

export type RunStatus = (typeof IMPORT_RUN_STATUSES)[number];
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export type MatchType = (typeof MATCH_TYPES)[number];

export type Account = {
  id: number;
  name: string;
  institutionName: string | null;
  providerStatus: string;
  currency: string | null;
  balanceMinor: number | null;
  balanceFetchedAt: string | null;
  importEnabled: boolean;
  lastImportAttemptAt: string | null;
  lastImportSuccessAt: string | null;
  lastImportError: string | null;
  consecutiveFailures: number;
  lastDataChangeAt: string | null;
  newestTxnDate: string | null;
  backfillComplete: boolean;
  needsReview: boolean;
};

export type ImportRun = {
  id: number;
  trigger: (typeof IMPORT_TRIGGERS)[number];
  startedAt: string;
  status: RunStatus;
  errorSummary: string | null;
  accounts: { accountId: number; status: string; inserted: number; updated: number; error: string | null }[];
};

export type Category = { id: number; name: string; kind: CategoryKind; archived: boolean };

export type Rule = {
  id: number;
  matchType: MatchType;
  pattern: string;
  accountId: number | null;
  categoryId: number;
  /** Counted transactions this rule currently decides, overridden ones excluded. */
  transactionCount: number;
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
  firstSeenAt: string;
  // P2.4 additions.
  categoryId: number | null;
  categorySource: "override" | "rule" | null;
  /** False for pending or vanished rows. */
  editable: boolean;
  // The override fields; null = the bank value, or no override category (follow the rules).
  excluded: boolean;
  countedAmountMinor: number | null;
  countedDate: string | null;
  note: string | null;
};

export type Page<T> = { transactions: T[]; nextCursor: string | null };

/**
 * PUT /api/transactions/:id/override **replaces** the override: a field left out goes back to
 * its default, and all defaults remove it. `categoryId` is the override's own category; null
 * follows the rules.
 */
export type OverrideInput = {
  categoryId?: number | null;
  excluded?: boolean;
  countedAmountMinor?: number | null;
  countedDate?: string | null;
  note?: string | null;
  /** Puts `categoryId` on this merchant's exact rules instead of on this row. */
  applyToMerchant?: boolean;
};

/** One group from GET /api/inbox/merchants. `totalMinor` sums counted amounts in the bank's sign. */
export type InboxMerchant = {
  /** lower(trim(merchant)): the pattern of the exact rule that would clear the group. */
  pattern: string;
  /** The latest row's text. */
  merchant: string;
  count: number;
  totalMinor: number;
  latestDate: string;
  /** False when no rule can have this pattern; its rows are filed one by one. */
  rulable: boolean;
};

/** GET /api/budget, and the body of both budget PUTs. Null figures until an overall figure is set. */
export type Budget = {
  month: string;
  overallMinor: number | null;
  allocatedMinor: number;
  miscMinor: number | null;
  /** Every budgeted, unarchived category, by id. */
  categories: {
    categoryId: number;
    allocatedMinor: number;
    /** Overall − every other allocation: the most this category can be set to. */
    maxAllocatableMinor: number | null;
  }[];
};

export type SummaryCategory = {
  /** null = uncategorised spend. */
  categoryId: number | null;
  kind: CategoryKind | null;
  spentMinor: number;
  pendingSpentMinor: number;
  allocatedMinor: number;
};

export type MonthSummary = {
  month: string;
  /** null until a budget has been set. */
  overallMinor: number | null;
  allocatedMinor: number;
  miscMinor: number | null;
  spentMinor: number;
  pendingSpentMinor: number;
  leftMinor: number | null;
  /** null for a past month. */
  daysRemaining: number | null;
  perWeekMinor: number | null;
  categories: SummaryCategory[];
  trackedMinor: number;
  inboxCount: number;
  lastDataChangeAt: string | null;
};

/** Error body; the named fields come with the spec's error codes the screens act on. */
export type ApiErrorBody = {
  error: string;
  /** 422 over_allocated */
  maxAllocatableMinor?: number;
  /** 422 below_allocated */
  minOverallMinor?: number;
  /** 429 rate_limited */
  retryAfterSeconds?: number;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    super(`HTTP ${status}`);
  }
}

// Dev-only synthetic backend (src/web/mock). `import.meta.env.DEV` is the literal false in a
// production build, so this branch, and with it the mock chunk, is dropped from the bundle.
const mock = import.meta.env.DEV && import.meta.env.VITE_MOCK_API ? import("./mock") : null;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await (mock ? (await mock).handle(path, init) : fetch(path, init));
  const body = (await res.json().catch(() => null)) as T | null;
  // A 2xx without JSON is usually the Access login page after the session expired.
  if (!res.ok || body === null) throw new ApiError(res.status, body as ApiErrorBody | null);
  return body;
}

/** State-changing requests must be JSON so they need a CORS preflight (src/worker/index.ts). */
const send = <T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body: unknown = {}) =>
  request<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const query = (params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

// Accounts and imports (Phase 1, P2.1).

export const getAccounts = () => request<{ accounts: Account[] }>("/api/accounts");
export const linkAccount = (id: number, intoAccountId: number) => send<{ ok: true }>("POST", `/api/accounts/${id}/link`, { intoAccountId });
export const enableAccount = (id: number) => send<{ ok: true }>("POST", `/api/accounts/${id}/enable`);

/** `importing` comes from the import lease, so it's right even when a cut-off run's row still says running. */
export const getRuns = (limit: number) => request<{ runs: ImportRun[]; importing: boolean }>(`/api/import-runs${query({ limit })}`);
/** 202: the run exists and carries on in the background; watch it via getRuns. */
export const startImport = () => send<{ status: "started"; runId: number }>("POST", "/api/import-runs");

// Categories and rules (P2.3).

export const getCategories = () => request<{ categories: Category[] }>("/api/categories");
export const createCategory = (input: { name: string; kind: CategoryKind }) => send<{ category: Category }>("POST", "/api/categories", input);
export const updateCategory = (id: number, input: { name?: string; kind?: CategoryKind; archived?: boolean }) =>
  send<{ category: Category }>("PATCH", `/api/categories/${id}`, input);

type RuleInput = { matchType: MatchType; pattern: string; accountId?: number | null; categoryId: number };
type RuleRow = Omit<Rule, "transactionCount">;
export const getRules = () => request<{ rules: Rule[] }>("/api/rules");
export const createRule = (input: RuleInput) => send<{ rule: RuleRow }>("POST", "/api/rules", input);
export const updateRule = (id: number, input: Partial<RuleInput>) => send<{ rule: RuleRow }>("PATCH", `/api/rules/${id}`, input);
export const deleteRule = (id: number) => send<{ ok: true }>("DELETE", `/api/rules/${id}`);

// Transactions, overrides and the inbox (P2.4).

export const getTransactions = (params: { limit: number; accountId?: number | null; from?: string; to?: string; cursor?: string | null }) =>
  request<Page<Transaction>>(
    `/api/transactions${query({ limit: params.limit, account_id: params.accountId, from: params.from, to: params.to, cursor: params.cursor })}`,
  );
export const putOverride = (id: number, input: OverrideInput) => send<{ transaction: Transaction }>("PUT", `/api/transactions/${id}/override`, input);
export const deleteOverride = (id: number) => send<{ transaction: Transaction }>("DELETE", `/api/transactions/${id}/override`);

/** Counted, uncategorised, not-excluded rows, money in and out, pending included. `total` counts every page. */
export const getInbox = (params: { limit: number; cursor?: string | null }) =>
  request<Page<Transaction> & { total: number }>(`/api/inbox${query(params)}`);
export const getInboxMerchants = () => request<{ merchants: InboxMerchant[] }>("/api/inbox/merchants");

// Budgets and the month summary (P2.5, P2.6). Budget writes take effect from the current London month.

export const getBudget = () => request<Budget>("/api/budget");
/** 422 below_allocated carries minOverallMinor. */
export const putOverallBudget = (amountMinor: number) => send<Budget>("PUT", "/api/budget/overall", { amountMinor });
/** 409 overall_budget_not_set; 422 over_allocated carries maxAllocatableMinor. */
export const putCategoryBudget = (categoryId: number, amountMinor: number) =>
  send<Budget>("PUT", `/api/budget/categories/${categoryId}`, { amountMinor });

export const getMonthSummary = (month: string) => request<MonthSummary>(`/api/months/${month}/summary`);
