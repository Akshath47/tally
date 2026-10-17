import { describe, expect, it } from "vitest";
import { perAccountFreshness, staleBannerText } from "../../src/web/stale";

// Synthetic accounts only.
type Fields = { importEnabled: boolean; lastDataChangeAt: string | null; staleDays: number | null };
const account = (name: string, over: Partial<Fields> = {}) => ({ name, importEnabled: true, lastDataChangeAt: null, staleDays: null, ...over });

describe("perAccountFreshness", () => {
  it("names each enabled account with its age", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const accounts = [
      account("Bank A", { lastDataChangeAt: "2026-10-15T10:00:00Z" }),
      account("Card B", { lastDataChangeAt: "2026-10-11T09:00:00Z" }),
      account("Old C", { importEnabled: false }),
    ];
    expect(perAccountFreshness(accounts, now)).toBe("Bank A 2h ago · Card B 4 days ago");
  });
});

describe("staleBannerText", () => {
  it("names one stale account", () => {
    expect(staleBannerText([account("Card B", { staleDays: 4 })])).toBe(
      "Card B hasn't updated for 4 days, so recent spending may be missing.",
    );
  });
  it("counts several, from the shortest wait", () => {
    expect(staleBannerText([account("Bank A", { staleDays: 6 }), account("Card B", { staleDays: 4 })])).toBe(
      "2 accounts haven't updated for 4+ days, so recent spending may be missing.",
    );
  });
});
