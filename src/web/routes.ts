// Every screen and its URL. Tab screens show the tab bar; pushed screens replace it with a back link.

export type Tab = "home" | "transactions" | "budget";

export type Route =
  | { screen: Tab | "toSort" | "categories" | "rules" | "accounts" | "notFound" }
  | { screen: "newAccount"; accountId: number };

export const TABS: { tab: Tab; href: string; label: string }[] = [
  { tab: "home", href: "/", label: "Home" },
  { tab: "transactions", href: "/transactions", label: "Transactions" },
  { tab: "budget", href: "/budget", label: "Budget" },
];

const STATIC: Record<string, Route["screen"]> = {
  "/": "home",
  "/transactions": "transactions",
  "/budget": "budget",
  "/to-sort": "toSort",
  "/categories": "categories",
  "/rules": "rules",
  "/accounts": "accounts",
};

export function parseRoute(pathname: string): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const screen = STATIC[path];
  if (screen && screen !== "newAccount") return { screen };
  const review = /^\/accounts\/([1-9]\d{0,8})\/review$/.exec(path);
  return review ? { screen: "newAccount", accountId: Number(review[1]) } : { screen: "notFound" };
}

export const newAccountHref = (accountId: number) => `/accounts/${accountId}/review`;

/** The tab a route belongs to, or null for a pushed screen (no tab bar). */
export function tabOf(route: Route): Tab | null {
  return route.screen === "home" || route.screen === "transactions" || route.screen === "budget" ? route.screen : null;
}

/** Where each pushed screen's back link goes (docs/ui-design.md, Navigation). */
export function backOf(route: Route): { href: string; label: string } {
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
