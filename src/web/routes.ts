import { londonToday, monthName, monthOf, monthTitle } from "./dates";
import { NAMED_LINES, isNamedLine } from "../worker/budget/lines";
import type { LineCategory } from "./lines";

// Every screen and its URL. Tab screens show the tab bar; pushed screens replace it with a back link.

export type Tab = "home" | "transactions" | "insights" | "budget";

export type Route =
  | { screen: Exclude<Tab, "home"> | "toSort" | "categories" | "rules" | "accounts" | "notFound" }
  /** Home for a month; `/` is the current one. */
  | { screen: "home"; month: string }
  | { screen: "newAccount"; accountId: number }
  | { screen: "line"; month: string; category: LineCategory }
  /** A completed month's review against the month before. */
  | { screen: "review"; month: string }
  | { screen: "trends" }
  /** One merchant's history, by merchant key (lower(trim(merchant))). */
  | { screen: "merchant"; key: string };

export const TABS: { tab: Tab; href: string; label: string }[] = [
  { tab: "home", href: "/", label: "Home" },
  { tab: "transactions", href: "/transactions", label: "Transactions" },
  { tab: "insights", href: "/insights", label: "Insights" },
  { tab: "budget", href: "/budget", label: "Budget" },
];

export type Back = { href: string; label: string };

const STATIC: Record<string, Exclude<Route["screen"], "home" | "newAccount" | "line" | "review" | "merchant">> = {
  "/transactions": "transactions",
  "/insights": "insights",
  "/insights/trends": "trends",
  "/budget": "budget",
  "/to-sort": "toSort",
  "/categories": "categories",
  "/rules": "rules",
  "/accounts": "accounts",
};

const MONTH = "\\d{4}-(?:0[1-9]|1[0-2])";
const HOME_PATH = new RegExp(`^/months/(${MONTH})$`);
const REVIEW_PATH = new RegExp(`^/insights/review/(${MONTH})$`);
const LINE_PATH = new RegExp(`^/spending/(${MONTH})/(${NAMED_LINES.join("|")}|[1-9]\\d{0,8})$`);

/** A merchant key from its URL segment, or null when it's malformed or empty (the API would 400). */
function decodeKey(segment: string): string | null {
  try {
    const key = decodeURIComponent(segment);
    return key.length > 0 && key.length <= 200 ? key : null;
  } catch {
    return null;
  }
}

/** `today` is the London date, for refusing a future month (the API would only 400). */
export function parseRoute(pathname: string, today = londonToday()): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/") return { screen: "home", month: monthOf(today) };
  const screen = STATIC[path];
  if (screen) return { screen };
  const accountReview = /^\/accounts\/([1-9]\d{0,8})\/review$/.exec(path);
  if (accountReview) return { screen: "newAccount", accountId: Number(accountReview[1]) };
  const review = REVIEW_PATH.exec(path);
  // Completed months only: the current month's progress is the Insights tab's.
  if (review) return review[1]! < monthOf(today) ? { screen: "review", month: review[1]! } : { screen: "notFound" };
  const merchant = /^\/merchants\/([^/]+)$/.exec(path);
  if (merchant) {
    const key = decodeKey(merchant[1]!);
    return key ? { screen: "merchant", key } : { screen: "notFound" };
  }
  const home = HOME_PATH.exec(path);
  if (home) return home[1]! > monthOf(today) ? { screen: "notFound" } : { screen: "home", month: home[1]! };
  const line = LINE_PATH.exec(path);
  if (!line || line[1]! > monthOf(today)) return { screen: "notFound" };
  const category = line[2]!;
  return { screen: "line", month: line[1]!, category: isNamedLine(category) ? category : Number(category) };
}

export const newAccountHref = (accountId: number) => `/accounts/${accountId}/review`;
/** Home for `month` (YYYY-MM): `/` for the current month, so the tab's own link stays put. */
export const homeHref = (month: string, today = londonToday()) => (month === monthOf(today) ? "/" : `/months/${month}`);
/** A Home line's transactions in `month` (YYYY-MM). */
export const lineHref = (month: string, category: LineCategory) => `/spending/${month}/${category}`;

/** A completed month's review. */
export const reviewHref = (month: string) => `/insights/review/${month}`;
export const TRENDS_HREF = "/insights/trends";
/** A merchant's screen; the key is encoded, so `%`, `&` and `/` survive the URL. */
export const merchantHref = (key: string) => `/merchants/${encodeURIComponent(key).replace(/\./g, "%2E")}`;

/** The tab a route belongs to, or null for a pushed screen (no tab bar). */
export const tabOf = (route: Route): Tab | null => TABS.find((t) => t.tab === route.screen)?.tab ?? null;

/** What a back link to `path` says, for screens that go back to wherever they were opened from. */
function labelOf(path: string, today: string): string | null {
  const route = parseRoute(path, today);
  switch (route.screen) {
    case "home":
      return route.month === monthOf(today) ? "Home" : monthTitle(route.month, today);
    case "transactions":
      return "Transactions";
    case "insights":
      return "Insights";
    case "trends":
      return "Trends";
    case "review":
      return `${monthName(route.month)} review`;
    case "toSort":
      return "To sort";
    case "budget":
      return "Budget";
    case "accounts":
      return "Accounts";
    case "categories":
      return "Categories";
    case "rules":
      return "Merchant rules";
    case "line":
    case "newAccount":
    case "merchant":
      return "Back";
    default:
      return null;
  }
}

/**
 * Where each pushed screen's back link goes (docs/ui-design.md, Navigation). `from` is the path
 * the screen was opened from, if known: Merchant goes back there.
 */
export function backOf(route: Route, today = londonToday(), from?: string | null): Back {
  switch (route.screen) {
    case "review":
    case "trends":
      return { href: "/insights", label: "Insights" };
    case "merchant": {
      const label = from ? labelOf(from, today) : null;
      return label && from ? { href: from, label } : { href: "/insights", label: "Insights" };
    }
    case "line": {
      // Back to the month the line is in; a past month's back link names it.
      const href = homeHref(route.month, today);
      return { href, label: href === "/" ? "Home" : monthTitle(route.month, today) };
    }
    case "categories":
    case "rules":
      return { href: "/budget", label: "Budget" };
    case "newAccount":
      return { href: "/accounts", label: "Accounts" };
    default:
      return { href: "/", label: "Home" };
  }
}
