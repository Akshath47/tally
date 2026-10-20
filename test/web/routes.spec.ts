import { describe, expect, it } from "vitest";
import { backOf, homeHref, lineHref, merchantHref, newAccountHref, parseRoute, reviewHref, tabOf } from "../../src/web/routes";

describe("parseRoute", () => {
  it.each([
    ["/transactions", "transactions"],
    ["/transactions/", "transactions"],
    ["/budget", "budget"],
    ["/to-sort", "toSort"],
    ["/categories", "categories"],
    ["/rules", "rules"],
    ["/accounts", "accounts"],
    ["/nope", "notFound"],
    ["/accounts/0/review", "notFound"],
    ["/accounts/abc/review", "notFound"],
    ["/spending/2026-10/0", "notFound"],
    ["/spending/2026-13/1", "notFound"],
    ["/spending/2026-10/food", "notFound"],
    ["/spending/2026-10/constructor", "notFound"],
    ["/insights", "insights"],
    ["/insights/trends", "trends"],
    ["/insights/review/2026-13", "notFound"],
    ["/merchants/", "notFound"],
    ["/merchants/%E0%A4%A", "notFound"],
  ])("%s → %s", (path, screen) => {
    expect(parseRoute(path).screen).toBe(screen);
  });

  it("reads the account id of the review screen", () => {
    expect(parseRoute(newAccountHref(12))).toEqual({ screen: "newAccount", accountId: 12 });
  });

  it("reads the month and category of a Home line", () => {
    expect(parseRoute(lineHref("2026-10", 4), "2026-10-15")).toEqual({ screen: "line", month: "2026-10", category: 4 });
    expect(parseRoute(lineHref("2026-09", "misc"), "2026-10-15")).toEqual({ screen: "line", month: "2026-09", category: "misc" });
    for (const category of ["uncategorised-pending", "posted", "pending"] as const) {
      expect(parseRoute(lineHref("2026-10", category), "2026-10-15")).toEqual({ screen: "line", month: "2026-10", category });
    }
  });

  it("reads a past month's Home, and refuses a future or malformed one", () => {
    expect(parseRoute(homeHref("2025-09", "2026-10-15"), "2026-10-15")).toEqual({ screen: "home", month: "2025-09" });
    expect(parseRoute("/months/2026-10", "2026-10-15")).toEqual({ screen: "home", month: "2026-10" });
    expect(parseRoute("/months/2026-11", "2026-10-31").screen).toBe("notFound");
    expect(parseRoute("/months/2026-13", "2026-10-15").screen).toBe("notFound");
    expect(parseRoute("/", "2026-10-15")).toEqual({ screen: "home", month: "2026-10" });
  });

  it("puts the current month's Home at /", () => {
    expect(homeHref("2026-10", "2026-10-15")).toBe("/");
    expect(homeHref("2026-09", "2026-10-15")).toBe("/months/2026-09");
  });

  it("refuses a Home line in a future month, which the API would refuse too", () => {
    expect(parseRoute(lineHref("2026-11", 4), "2026-10-31").screen).toBe("notFound");
  });
});

describe("insights routes", () => {
  const today = "2026-10-15";

  it("reviews completed months only", () => {
    expect(parseRoute(reviewHref("2026-09"), today)).toEqual({ screen: "review", month: "2026-09" });
    expect(parseRoute(reviewHref("2025-12"), today)).toEqual({ screen: "review", month: "2025-12" });
    expect(parseRoute(reviewHref("2026-10"), today).screen).toBe("notFound");
    expect(parseRoute(reviewHref("2026-11"), today).screen).toBe("notFound");
  });

  it("round-trips merchant keys with URL-special characters", () => {
    for (const key of ["via roma kitchen", "50% off & more", "a/b", "café #1?", ".", "..", "a.b"]) {
      expect(parseRoute(merchantHref(key), today)).toEqual({ screen: "merchant", key });
    }
    expect(parseRoute(merchantHref("x".repeat(201)), today).screen).toBe("notFound");
  });

  it("puts Insights in the tab bar and its screens behind back links", () => {
    expect(tabOf({ screen: "insights" })).toBe("insights");
    expect(tabOf({ screen: "trends" })).toBeNull();
    expect(backOf({ screen: "review", month: "2026-09" }, today)).toEqual({ href: "/insights", label: "Insights" });
    expect(backOf({ screen: "trends" }, today)).toEqual({ href: "/insights", label: "Insights" });
  });

  it("sends Merchant back to wherever it was opened from", () => {
    const merchant = { screen: "merchant" as const, key: "shop" };
    expect(backOf(merchant, today, "/insights/review/2026-09")).toEqual({ href: "/insights/review/2026-09", label: "September review" });
    expect(backOf(merchant, today, "/transactions")).toEqual({ href: "/transactions", label: "Transactions" });
    expect(backOf(merchant, today, "/")).toEqual({ href: "/", label: "Home" });
    expect(backOf(merchant, today, "/to-sort")).toEqual({ href: "/to-sort", label: "To sort" });
    expect(backOf(merchant, today, null)).toEqual({ href: "/insights", label: "Insights" });
    expect(backOf(merchant, today, "/nope")).toEqual({ href: "/insights", label: "Insights" });
  });
});

describe("navigation shape", () => {
  it("shows the tab bar only on tab screens", () => {
    expect(tabOf({ screen: "home", month: "2025-09" })).toBe("home");
    expect(tabOf({ screen: "budget" })).toBe("budget");
    expect(tabOf({ screen: "toSort" })).toBeNull();
    expect(tabOf({ screen: "newAccount", accountId: 1 })).toBeNull();
  });

  it("sends each pushed screen back to its parent", () => {
    expect(backOf({ screen: "toSort" })).toEqual({ href: "/", label: "Home" });
    expect(backOf({ screen: "accounts" })).toEqual({ href: "/", label: "Home" });
    expect(backOf({ screen: "line", month: "2026-10", category: 4 }, "2026-10-15")).toEqual({ href: "/", label: "Home" });
    // A past month's line goes back to that month, not to today's Home.
    expect(backOf({ screen: "line", month: "2025-09", category: 4 }, "2026-10-15")).toEqual({ href: "/months/2025-09", label: "September 2025" });
    expect(backOf({ screen: "categories" })).toEqual({ href: "/budget", label: "Budget" });
    expect(backOf({ screen: "rules" })).toEqual({ href: "/budget", label: "Budget" });
    expect(backOf({ screen: "newAccount", accountId: 3 })).toEqual({ href: "/accounts", label: "Accounts" });
  });
});
