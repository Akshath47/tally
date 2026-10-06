import { londonToday, monthOf } from "./dates";
import { NAMED_LINES, isNamedLine } from "../worker/budget/lines";
import type { LineCategory } from "./lines";

// Every screen and its URL. Tab screens show the tab bar; pushed screens replace it with a back link.

export type Tab = "home" | "transactions" | "budget";

export type Route =
  | { screen: Tab | "toSort" | "categories" | "rules" | "accounts" | "notFound" }
  | { screen: "newAccount"; accountId: number }
  | { screen: "line"; month: string; category: LineCategory };

export const TABS: { tab: Tab; href: string; label: string }[] = [
  { tab: "home", href: "/", label: "Home" },
  { tab: "transactions", href: "/transactions", label: "Transactions" },
  { tab: "budget", href: "/budget", label: "Budget" },
];

export type Back = { href: string; label: string };

const STATIC: Record<string, Exclude<Route["screen"], "newAccount" | "line">> = {
  "/": "home",
  "/transactions": "transactions",
  "/budget": "budget",
  "/to-sort": "toSort",
  "/categories": "categories",
  "/rules": "rules",
  "/accounts": "accounts",
};

const LINE_PATH = new RegExp(`^/spending/(\\d{4}-(?:0[1-9]|1[0-2]))/(${NAMED_LINES.join("|")}|[1-9]\\d{0,8})$`);

/** `today` is the London date, for refusing a future month (the API would only 400). */
export function parseRoute(pathname: string, today = londonToday()): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const screen = STATIC[path];
  if (screen) return { screen };
  const review = /^\/accounts\/([1-9]\d{0,8})\/review$/.exec(path);
  if (review) return { screen: "newAccount", accountId: Number(review[1]) };
  const line = LINE_PATH.exec(path);
  if (!line || line[1]! > monthOf(today)) return { screen: "notFound" };
  const category = line[2]!;
  return { screen: "line", month: line[1]!, category: isNamedLine(category) ? category : Number(category) };
}

export const newAccountHref = (accountId: number) => `/accounts/${accountId}/review`;
/** A Home line's transactions in `month` (YYYY-MM). */
export const lineHref = (month: string, category: LineCategory) => `/spending/${month}/${category}`;

/** The tab a route belongs to, or null for a pushed screen (no tab bar). */
export const tabOf = (route: Route): Tab | null => TABS.find((t) => t.tab === route.screen)?.tab ?? null;

/** Where each pushed screen's back link goes (docs/ui-design.md, Navigation). */
export function backOf(route: Route): Back {
  switch (route.screen) {
    case "categories":
    case "rules":
      return { href: "/budget", label: "Budget" };
    case "newAccount":
      return { href: "/accounts", label: "Accounts" };
    default:
      return { href: "/", label: "Home" };
  }
}
