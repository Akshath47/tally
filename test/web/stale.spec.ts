import { describe, expect, it } from "vitest";
import { freshnessAge, perAccountFreshness, staleBannerText } from "../../src/web/stale";

// Synthetic accounts only.
type Fields = { importEnabled: boolean; lastDataChangeAt: string | null; staleDays: number | null };
const account = (id: number, name: string, over: Partial<Fields> = {}) => ({ id, name, importEnabled: true, lastDataChangeAt: null, staleDays: null, ...over });

describe("freshnessAge", () => {
  const now = new Date("2026-10-15T08:00:00Z");
  it("uses elapsed time for a fresh account", () => {
    expect(freshnessAge(account(1, "Bank A", { lastDataChangeAt: "2026-10-15T06:00:00Z", staleDays: 0 }), now)).toBe("2h ago");
  });
  it("uses the Worker's London-day count for a stale account, matching the banner", () => {
    // 81 hours elapsed, but 11 Oct → 15 Oct in London is 4 days.
    expect(freshnessAge(account(2, "Card B", { lastDataChangeAt: "2026-10-11T22:30:00Z", staleDays: 4 }), now)).toBe("4 days ago");
  });
  it("says never for an account with no data change", () => expect(freshnessAge(account(3, "C"), now)).toBe("never"));
});

describe("perAccountFreshness", () => {
  it("names each enabled account with its age", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const accounts = [
      account(1, "Bank A", { lastDataChangeAt: "2026-10-15T10:00:00Z", staleDays: 0 }),
      account(2, "Card B", { lastDataChangeAt: "2026-10-11T09:00:00Z", staleDays: 4 }),
      account(3, "Old C", { importEnabled: false }),
    ];
    expect(perAccountFreshness(accounts, now)).toBe("Bank A 2h ago · Card B 4 days ago");
  });
  it("is empty when the accounts haven't loaded", () => expect(perAccountFreshness([])).toBe(""));
});

describe("staleBannerText", () => {
  it("names one stale account", () => {
    expect(staleBannerText([2], [account(1, "Bank A", { staleDays: 0 }), account(2, "Card B", { staleDays: 4 })])).toBe(
      "Card B hasn't updated for 4 days, so recent spending may be missing.",
    );
  });
  it("counts several, from the shortest wait", () => {
    expect(staleBannerText([1, 2], [account(1, "Bank A", { staleDays: 6 }), account(2, "Card B", { staleDays: 4 })])).toBe(
      "2 accounts haven't updated for 4+ days, so recent spending may be missing.",
    );
  });
  it("still warns before the accounts have loaded", () => {
    expect(staleBannerText([2], [])).toBe("An account hasn't updated for 4+ days, so recent spending may be missing.");
    expect(staleBannerText([1, 2], [])).toBe("2 accounts haven't updated for 4+ days, so recent spending may be missing.");
  });
  it("never shows a day count the cached accounts no longer back up", () => {
    // The accounts cache predates the summary: account 2 was at 3 days, or disabled (null).
    expect(staleBannerText([2], [account(2, "Card B", { staleDays: 3 })])).toBe("An account hasn't updated for 4+ days, so recent spending may be missing.");
    expect(staleBannerText([1, 2], [account(1, "Bank A", { staleDays: 5 }), account(2, "Card B", { staleDays: null })])).toBe(
      "2 accounts haven't updated for 4+ days, so recent spending may be missing.",
    );
  });
});
