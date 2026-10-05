import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAccounts, getBudget, getCategories, getInbox, getInboxMerchants, getMonthSummary, getRules, getTransactions, type Account, type Category } from "./api";
import { addMonths, daysInMonth } from "./dates";

// Shared queries. Every write invalidates everything: the app is small and one person's, and
// a rule or override changes the summary, the inbox and the lists at once.

const PAGE = 100;

export const useSummary = (month: string) => useQuery({ queryKey: ["summary", month], queryFn: () => getMonthSummary(month) });
export const useBudget = () => useQuery({ queryKey: ["budget"], queryFn: getBudget });
export const useRules = () => useQuery({ queryKey: ["rules"], queryFn: getRules, select: (d) => d.rules });
export const useInboxMerchants = () => useQuery({ queryKey: ["inbox", "merchants"], queryFn: getInboxMerchants, select: (d) => d.merchants });

export const useCategories = () =>
  useQuery({
    queryKey: ["categories"],
    queryFn: getCategories,
    select: (d) => ({ all: d.categories, byId: new Map(d.categories.map((c) => [c.id, c])), active: d.categories.filter((c) => !c.archived) }),
  });

export const useAccounts = () =>
  useQuery({
    queryKey: ["accounts"],
    queryFn: getAccounts,
    select: (d) => ({ all: d.accounts, byId: new Map<number, Account>(d.accounts.map((a) => [a.id, a])) }),
  });

export const useInbox = () =>
  useInfiniteQuery({
    queryKey: ["inbox", "list"],
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

/** Spent in each of the two months before `month`, for first-run reference. */
export const usePreviousSpend = (month: string, enabled: boolean) =>
  useQuery({
    queryKey: ["summary", "previous", month],
    enabled,
    queryFn: async () => Promise.all([1, 2].map((n) => getMonthSummary(addMonths(month, -n)))),
  });

export function useInvalidateAll() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries();
}

/** Budgeted, unarchived categories first, as pickers list them. */
export function pickerOrder(categories: Category[]): Category[] {
  const rank = { budgeted: 0, tracked: 1, excluded: 2 } as const;
  return categories.filter((c) => !c.archived).sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
}
