// Synthetic seed for the dev mock. Every merchant, amount and date is invented; dates are
// offsets from today so the current month always has activity. Never put real bank data here.

/** [days before today, account id, merchant, amount in minor units (bank sign), pending]. */
export type SeedTxn = [daysAgo: number, accountId: number, merchant: string, amountMinor: number, pending?: boolean];

export const SEED_ACCOUNTS = [
  { id: 1, name: "Revolut", institutionName: "Revolut", hoursSinceChange: 3 },
  { id: 2, name: "BA Amex", institutionName: "American Express", hoursSinceChange: 3 },
] as const;

/** Lunch Flow started sending this one: awaiting review, nothing imported. */
export const SEED_NEW_ACCOUNT = { id: 3, name: "American Express ••5326", institutionName: "American Express" } as const;

// Same names, kinds and order as migrations/0005_seed_categories.sql, so the ids match a
// freshly migrated local D1 in "missing" mode.
export const SEED_CATEGORIES = [
  ["Groceries", "budgeted"],
  ["Eating out", "budgeted"],
  ["Transport", "budgeted"],
  ["Bills", "budgeted"],
  ["Shopping", "budgeted"],
  ["Entertainment", "budgeted"],
  ["Health", "budgeted"],
  ["Other", "budgeted"],
  ["Clothes", "tracked"],
  ["Travel", "tracked"],
  ["Savings", "excluded"],
  ["Investments", "excluded"],
  ["Card repayment", "excluded"],
  ["Income", "excluded"],
] as const;

/** [match type, pattern, category id]. */
export const SEED_RULES = [
  ["exact", "fernway energy", 4],
  ["exact", "northgate lettings", 4],
  ["exact", "harbour mobile", 4],
  ["exact", "greenleaf grocers", 1],
  ["exact", "the copper kettle", 2],
  ["contains", "metro rail", 3],
  ["exact", "acme payroll", 14],
  ["contains", "card payment", 13],
  ["exact", "loomline", 9],
] as const;

/** Overall figure and allocations by category id, effective from the current month. */
export const SEED_BUDGET = { overallMinor: 144_000, allocations: { 4: 52_000, 1: 24_000, 2: 16_000, 3: 9_600 } as Record<number, number> };

export const SEED_TRANSACTIONS: SeedTxn[] = [
  [0, 1, "Northside Pharmacy", -849, true],
  [0, 2, "Via Roma Kitchen", -4250, true],
  [1, 1, "Metro Rail Ticket", -380, true],
  [0, 2, "Harlow's Market", -2360],
  [1, 1, "Greenleaf Grocers", -4512],
  [1, 1, "City Cabs", -1460],
  [2, 2, "The Copper Kettle", -1890],
  [3, 2, "Harlow's Market", -3115],
  [3, 1, "Metro Rail", -640],
  [4, 1, "Brightside Books", -1299],
  [5, 1, "City Cabs", -1720],
  [5, 2, "Greenleaf Grocers", -6230],
  [6, 1, "Harlow's Market", -1240],
  [6, 2, "Via Roma Kitchen", -6400],
  [7, 1, "Loomline", -4800],
  [8, 1, "Metro Rail", -640],
  [8, 2, "The Copper Kettle", -2340],
  [9, 1, "City Cabs", -1000],
  [9, 2, "Harlow's Market", -1925],
  [10, 1, "Fernway Energy", -9400],
  [10, 1, "Brightside Books", -899],
  [11, 1, "Northgate Lettings", -52_500],
  [11, 1, "Acme Payroll", 310_000],
  [12, 1, "Harbour Mobile", -2100],
  [12, 2, "Greenleaf Grocers", -3876],
  [13, 1, "Amex Card Payment", -48_210],
  [13, 2, "Card Payment Received", 48_210],
  [14, 2, "Pinecrest Cinema", -2450],
  [15, 1, "Metro Rail", -640],
  [16, 2, "The Copper Kettle", -1560],
  [18, 1, "Greenleaf Grocers", -5120],
  [20, 2, "Via Roma Kitchen", -3800],
  [22, 1, "Metro Rail", -1280],
  [25, 2, "Greenleaf Grocers", -4410],
  [28, 1, "Pinecrest Cinema", -1800],
  [31, 1, "Fernway Energy", -9100],
  [33, 1, "Northgate Lettings", -52_500],
  [35, 2, "Harlow's Market", -2210],
];

/** A new merchant's big charge this week, so the Insights tab has a large charge to show. */
export const SEED_LARGE_CHARGE: SeedTxn = [3, 2, "Halden Audio", -24_000];

/**
 * Older synthetic history, so Trends and the Monthly review have months to show: the same
 * spending every month on these days, scaled per month. [day of month, account, merchant, amount].
 */
export const HISTORY_MONTHLY: [day: number, accountId: number, merchant: string, amountMinor: number][] = [
  [1, 1, "Northgate Lettings", -52_500],
  [3, 1, "Fernway Energy", -9_200],
  [5, 1, "Harbour Mobile", -2_100],
  [2, 1, "Greenleaf Grocers", -4_800],
  [9, 2, "Greenleaf Grocers", -5_600],
  [16, 1, "Greenleaf Grocers", -4_300],
  [23, 2, "Greenleaf Grocers", -6_100],
  [6, 2, "Harlow's Market", -2_200],
  [19, 2, "Harlow's Market", -1_900],
  [7, 2, "Via Roma Kitchen", -4_200],
  [21, 2, "Via Roma Kitchen", -3_600],
  [11, 2, "The Copper Kettle", -1_800],
  [25, 2, "The Copper Kettle", -2_400],
  [4, 1, "Metro Rail", -640],
  [12, 1, "Metro Rail", -1_280],
  [18, 1, "City Cabs", -1_500],
  [26, 1, "Metro Rail", -640],
  [14, 1, "Pinecrest Cinema", -2_200],
  [10, 1, "Brightside Books", -1_100],
  [28, 1, "Acme Payroll", 310_000],
];

/** Percent of HISTORY_MONTHLY each month spends, from 1 month back to 5. */
export const HISTORY_SCALE = [100, 92, 112, 118, 96];

/** Tracked clothes spending in some months back: [months back, day, amount]. */
export const HISTORY_EXTRA: [monthsBack: number, day: number, accountId: number, merchant: string, amountMinor: number][] = [
  [1, 15, 1, "Loomline", -8_500],
  [3, 20, 1, "Loomline", -4_000],
  [2, 13, 2, "Fernhill Garden Centre", -1_600],
  [3, 8, 2, "Fernhill Garden Centre", -1_400],
  [4, 17, 2, "Fernhill Garden Centre", -1_900],
];

/** Budgets take effect this many months back, so the oldest history months show "no budget". */
export const BUDGET_MONTHS_BACK = 3;
