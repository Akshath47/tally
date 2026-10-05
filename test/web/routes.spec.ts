import { describe, expect, it } from "vitest";
import { backOf, lineHref, newAccountHref, parseRoute, tabOf } from "../../src/web/routes";

describe("parseRoute", () => {
  it.each([
    ["/", "home"],
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
  ])("%s → %s", (path, screen) => {
    expect(parseRoute(path).screen).toBe(screen);
  });

  it("reads the account id of the review screen", () => {
    expect(parseRoute(newAccountHref(12))).toEqual({ screen: "newAccount", accountId: 12 });
  });

  it("reads the month and category of a Home line", () => {
    expect(parseRoute(lineHref("2026-10", 4))).toEqual({ screen: "line", month: "2026-10", category: 4 });
    expect(parseRoute(lineHref("2026-09", "misc"))).toEqual({ screen: "line", month: "2026-09", category: "misc" });
  });
});

describe("navigation shape", () => {
  it("shows the tab bar only on tab screens", () => {
    expect(tabOf({ screen: "home" })).toBe("home");
    expect(tabOf({ screen: "budget" })).toBe("budget");
    expect(tabOf({ screen: "toSort" })).toBeNull();
    expect(tabOf({ screen: "newAccount", accountId: 1 })).toBeNull();
  });

  it("sends each pushed screen back to its parent", () => {
    expect(backOf({ screen: "toSort" })).toEqual({ href: "/", label: "Home" });
    expect(backOf({ screen: "accounts" })).toEqual({ href: "/", label: "Home" });
    expect(backOf({ screen: "line", month: "2026-10", category: 4 })).toEqual({ href: "/", label: "Home" });
    expect(backOf({ screen: "categories" })).toEqual({ href: "/budget", label: "Budget" });
    expect(backOf({ screen: "rules" })).toEqual({ href: "/budget", label: "Budget" });
    expect(backOf({ screen: "newAccount", accountId: 3 })).toEqual({ href: "/accounts", label: "Accounts" });
  });
});
