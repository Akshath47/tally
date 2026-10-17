import { useInfiniteQuery, useQueries, useQuery, type InfiniteData } from "@tanstack/react-query";
import { getAccounts, getBudget, getCategories, getDigestPreview, getInbox, getInboxMerchants, getInsights, getLineTransactions, getMerchant, getMonthSummary, getReview, getRules, getTransactions, getTrends, type Account, type Category, type CategoryKind } from "./api";
import type { LineCategory } from "./lines";
import { addMonths, daysInMonth } from "./dates";

// Shared queries. Every successful write invalidates the cache (main.tsx): the app is one
// person's, and a rule or override changes the summary, the inbox and the lists at once.

const PAGE = 100;

/** The category kinds in display order, with what each means. */
export const KINDS: { kind: CategoryKind; label: string; about: string }[] = [
  { kind: "budgeted", label: "Budgeted", about: "Counts against your monthly budget" },
  { kind: "tracked", label: "Tracked", about: "Shown in spending, never counts against the budget" },
  { kind: "excluded", label: "Excluded", about: "Not spending at all: hidden from totals" },
];

const summaryQuery = (month: string) => ({ queryKey: ["summary", month], queryFn: () => getMonthSummary(month) });

// Selects live at module level so TanStack memoises their results per data change.
const selectRules = (d: Awaited<ReturnType<typeof getRules>>) => d.rules;
const selectMerchants = (d: Awaited<ReturnType<typeof getInboxMerchants>>) => d.merchants;
const selectCategories = (d: { categories: Category[] }) => ({ all: d.categories, byId: new Map(d.categories.map((c) => [c.id, c])) });
const selectAccounts = (d: { accounts: Account[] }) => ({ all: d.accounts, byId: new Map(d.accounts.map((a) => [a.id, a])) });

export const useSummary = (month: string) => useQuery(summaryQuery(month));
export const useBudget = () => useQuery({ queryKey: ["budget"], queryFn: getBudget });
export const useRules = () => useQuery({ queryKey: ["rules"], queryFn: getRules, select: selectRules });
/** The inbox's keys, for screens that update it from a write's response (To sort). */
export const INBOX_LIST_KEY = ["inbox", "list"] as const;
export const INBOX_MERCHANTS_KEY = ["inbox", "merchants"] as const;
export type InboxPages = InfiniteData<Awaited<ReturnType<typeof getInbox>>, string | null>;

export const useInboxMerchants = () => useQuery({ queryKey: INBOX_MERCHANTS_KEY, queryFn: getInboxMerchants, select: selectMerchants });
export const useCategories = () => useQuery({ queryKey: ["categories"], queryFn: getCategories, select: selectCategories });
export const useAccounts = () => useQuery({ queryKey: ["accounts"], queryFn: getAccounts, select: selectAccounts });

export const useInbox = () =>
  useInfiniteQuery({
    queryKey: INBOX_LIST_KEY,
    queryFn: ({ pageParam }) => getInbox({ limit: PAGE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

/** A month's transactions by bank date, newest first. */
export const useMonthTransactions = (month: string) =>
  useInfiniteQuery({
    queryKey: ["transactions", month],
    queryFn: ({ pageParam }) => getTransactions({ limit: PAGE, from: `${month}-01`, to: `${month}-${daysInMonth(month)}`, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

/** The rows behind one Home line, newest first by bank date. */
export const useLineTransactions = (month: string, category: LineCategory) =>
  useInfiniteQuery({
    queryKey: ["transactions", month, "line", category],
    queryFn: ({ pageParam }) => getLineTransactions(month, category, { limit: PAGE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

/** The summaries of the two months before `month`, sharing the cache with useSummary. */
export const usePreviousSummaries = (month: string) => useQueries({ queries: [1, 2].map((n) => summaryQuery(addMonths(month, -n))) });

// Insights (P2.9–P2.11).

export const useInsights = () => useQuery({ queryKey: ["insights"], queryFn: getInsights });
export const useDigestPreview = () => useQuery({ queryKey: ["digest", "preview"], queryFn: getDigestPreview });
export const useReview = (month: string) => useQuery({ queryKey: ["review", month], queryFn: () => getReview(month) });
export const useTrends = () => useQuery({ queryKey: ["trends"], queryFn: getTrends });
export const useMerchant = (key: string) => useQuery({ queryKey: ["merchant", key], queryFn: () => getMerchant(key) });

/** Active categories in picker order: by kind, then name. */
export function pickerOrder(categories: Category[]): Category[] {
  const rank = (c: Category) => KINDS.findIndex((k) => k.kind === c.kind);
  return categories.filter((c) => !c.archived).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
