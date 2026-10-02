import { describe, expect, it } from "vitest";
import { SUBREQUEST_CAP, createClient } from "../../src/worker/importer/client";
import { ImportError } from "../../src/worker/importer/errors";
import { accountJson, fakeFetch, txn } from "../fixtures/lunchflow";

function setup(routes: Parameters<typeof fakeFetch>[0], deadline?: number) {
  const f = fakeFetch(routes);
  const sleeps: number[] = [];
  const client = createClient({
    apiKey: "test-key",
    fetch: f.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    deadline,
  });
  return { client, calls: f.calls, sleeps };
}

async function kindOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof ImportError) return { kind: e.kind, httpStatus: e.httpStatus };
    throw e;
  }
  return null;
}

describe("lunch flow client", () => {
  it("sends the key in x-api-key and passes the date window and include_pending", async () => {
    const { client, calls } = setup({
      "/accounts/7/transactions": { body: { transactions: [txn(7, "a")], total: 1 } },
    });
    const rows = await client.transactions(7, { from: "2026-09-19", to: "2026-10-02" });
    expect(rows).toHaveLength(1);
    expect(calls[0]!.headers.get("x-api-key")).toBe("test-key");
    expect(calls[0]!.query.get("from")).toBe("2026-09-19");
    expect(calls[0]!.query.get("to")).toBe("2026-10-02");
    expect(calls[0]!.query.get("include_pending")).toBe("true");
  });

  it("accepts a transaction whose id is null (Amex pending)", async () => {
    const { client } = setup({
      "/accounts/1/transactions": { body: { transactions: [txn(1, null, { isPending: true })], total: 1 } },
    });
    expect((await client.transactions(1, { from: "2026-09-19", to: "2026-10-02" }))[0]!.id).toBeNull();
  });

  it("parses accounts that omit currency", async () => {
    const { client } = setup({ "/accounts": { body: { accounts: [accountJson(1)], total: 1 } } });
    expect((await client.accounts())[0]).toMatchObject({ id: 1, institution_name: "Test Bank" });
  });

  it("parses a balance with its currency", async () => {
    const { client } = setup({ "/accounts/1/balance": { body: { balance: { amount: 10.5, currency: "GBP" } } } });
    expect(await client.balance(1)).toEqual({ amount: 10.5, currency: "GBP" });
  });

  it("retries a 5xx twice, then fails with kind=server", async () => {
    const { client, calls, sleeps } = setup({ "/accounts": { status: 503, body: { error: "x" } } });
    expect(await kindOf(client.accounts())).toEqual({ kind: "server", httpStatus: 503 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("recovers when a retry succeeds", async () => {
    const { client, calls } = setup({
      "/accounts": [{ status: 500 }, { body: { accounts: [accountJson(1)], total: 1 } }],
    });
    await expect(client.accounts()).resolves.toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("caps Retry-After at 10 seconds", async () => {
    const { client, sleeps } = setup({ "/accounts": { status: 429, headers: { "retry-after": "60" }, body: {} } });
    expect(await kindOf(client.accounts())).toEqual({ kind: "rate_limited", httpStatus: 429 });
    expect(sleeps.length).toBe(2);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(10_000);
    expect(sleeps[0]).toBe(10_000);
  });

  it.each([401, 403])("does not retry a %s and reports a config error", async (status) => {
    const { client, calls } = setup({
      "/accounts": { status, body: { error: "Forbidden", message: "Invalid credentials." } },
    });
    expect(await kindOf(client.accounts())).toEqual({ kind: "config", httpStatus: status });
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 404", async () => {
    const { client, calls } = setup({ "/accounts/9/balance": { status: 404, body: { error: "Not Found" } } });
    expect(await kindOf(client.balance(9))).toEqual({ kind: "not_found", httpStatus: 404 });
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 400 whose error is an object (zod-style body)", async () => {
    const { client, calls } = setup({
      "/accounts/1/transactions": { status: 400, body: { success: false, error: { name: "ZodError", issues: [] } } },
    });
    expect(await kindOf(client.transactions(1, { from: "2026-09-19", to: "2026-10-02" }))).toEqual({
      kind: "invalid_response",
      httpStatus: 400,
    });
    expect(calls).toHaveLength(1);
  });

  it("treats a response that fails validation as invalid_response without retrying", async () => {
    const { client, calls } = setup({
      "/accounts/1/transactions": { body: { transactions: [{ ...txn(1, "a"), amount: "12.3" }], total: 1 } },
    });
    expect(await kindOf(client.transactions(1, { from: "2026-09-19", to: "2026-10-02" }))).toEqual({
      kind: "invalid_response",
      httpStatus: 200,
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects a transaction with a malformed date", async () => {
    const { client } = setup({
      "/accounts/1/transactions": { body: { transactions: [txn(1, "a", { date: "2026-10-01T23:30:00Z" })], total: 1 } },
    });
    expect((await kindOf(client.transactions(1, { from: "2026-09-19", to: "2026-10-02" })))?.kind).toBe("invalid_response");
  });

  it("retries network errors, then reports kind=network", async () => {
    const { client, calls } = setup({ "/accounts": { throws: new TypeError("fetch failed") } });
    expect(await kindOf(client.accounts())).toEqual({ kind: "network", httpStatus: null });
    expect(calls).toHaveLength(3);
  });

  it("reports a timeout as kind=timeout", async () => {
    const { client } = setup({ "/accounts": { throws: new DOMException("The operation timed out.", "TimeoutError") } });
    expect((await kindOf(client.accounts()))?.kind).toBe("timeout");
  });

  it("fails with kind=timeout, without calling, once the deadline has passed", async () => {
    const { client, calls } = setup({ "/accounts": { body: { accounts: [], total: 0 } } }, Date.now() - 1);
    expect(await kindOf(client.accounts())).toEqual({ kind: "timeout", httpStatus: null });
    expect(calls).toHaveLength(0);
  });

  it("gives up instead of backing off past the deadline", async () => {
    // The first backoff is 500 ms; the deadline leaves less than that.
    const { client, calls, sleeps } = setup({ "/accounts": { status: 503 } }, Date.now() + 200);
    expect(await kindOf(client.accounts())).toEqual({ kind: "server", httpStatus: 503 });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("stops at the subrequest cap", async () => {
    const { client } = setup({ "/accounts": { body: { accounts: [], total: 0 } } });
    for (let i = 0; i < SUBREQUEST_CAP; i++) await client.accounts();
    expect((await kindOf(client.accounts()))?.kind).toBe("budget");
    expect(client.subrequests).toBe(SUBREQUEST_CAP);
  });

  it("counts retries as subrequests", async () => {
    const { client } = setup({ "/accounts": [{ status: 500 }, { body: { accounts: [], total: 0 } }] });
    await client.accounts();
    expect(client.subrequests).toBe(2);
  });
});
