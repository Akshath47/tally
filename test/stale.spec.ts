import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staleDays } from "../src/worker/budget/stale";
import { insertAccount, resetDb } from "./db";
import { get } from "./http";

// All data is synthetic.

const setChange = (id: number, at: string | null) =>
  env.DB.prepare("UPDATE accounts SET last_data_change_at = ?1 WHERE id = ?2").bind(at, id).run();

describe("staleDays", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  it.each([
    ["2026-10-15T01:00:00Z", 0],
    ["2026-10-12T00:30:00Z", 3],
    ["2026-10-11T23:30:00Z", 3], // already 12 Oct in London (BST)
    ["2026-10-11T22:30:00Z", 4], // still 11 Oct in London
  ])("%s → %i London days", (at, days) => expect(staleDays(at, now)).toBe(days));

  it("is null when the account has never changed", () => expect(staleDays(null, now)).toBeNull());

  it("counts London days across the clocks going back on 25 Oct", () => {
    // 25 Oct 00:30 BST → 28 Oct 23:30 GMT.
    expect(staleDays("2026-10-24T23:30:00Z", new Date("2026-10-28T23:30:00Z"))).toBe(3);
  });
});

describe("stale accounts in the API", () => {
  beforeEach(async () => {
    await resetDb();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  async function fourAccounts() {
    const [fresh, stale, never, disabled] = [
      await insertAccount({ providerAccountId: "1" }),
      await insertAccount({ providerAccountId: "2" }),
      await insertAccount({ providerAccountId: "3" }),
      await insertAccount({ providerAccountId: "4" }),
    ];
    await setChange(fresh, "2026-10-12T09:00:00Z");
    await setChange(stale, "2026-10-11T09:00:00Z");
    await setChange(never, null);
    await setChange(disabled, "2026-09-01T09:00:00Z");
    await env.DB.prepare("UPDATE accounts SET import_enabled = 0 WHERE id = ?1").bind(disabled).run();
    return { fresh, stale, never, disabled };
  }

  it("GET /api/accounts flags an enabled account from 4 London days without new data", async () => {
    const { fresh, stale, never, disabled } = await fourAccounts();
    const body = (await (await get("/api/accounts")).json()) as { accounts: { id: number; stale: boolean; staleDays: number | null }[] };
    expect(body.accounts.map(({ id, stale, staleDays }) => ({ id, stale, staleDays }))).toEqual([
      { id: fresh, stale: false, staleDays: 3 },
      { id: stale, stale: true, staleDays: 4 },
      { id: never, stale: false, staleDays: null },
      { id: disabled, stale: false, staleDays: null },
    ]);
  });

  it("the current month's summary lists stale enabled accounts, and a past month lists none", async () => {
    const { stale } = await fourAccounts();
    const current = (await (await get("/api/months/2026-10/summary")).json()) as { staleAccountIds: number[]; lastDataChangeAt: string };
    expect(current.staleAccountIds).toEqual([stale]);
    // The latest change across enabled accounts, ignoring the disabled one.
    expect(current.lastDataChangeAt).toBe("2026-10-12T09:00:00Z");
    const past = (await (await get("/api/months/2026-09/summary")).json()) as { staleAccountIds: number[] };
    expect(past.staleAccountIds).toEqual([]);
  });
});
