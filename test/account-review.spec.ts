import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker";
import { runImport } from "../src/worker/importer";
import { NOW, resetDb } from "./db";
import { AMEX, REVOLUT, accountJson, txn, world, type WorldAccount } from "./fixtures/lunchflow";

// A reconnect gives the Amex a new Lunch Flow id (4). Tally ids: Revolut 1, Amex 2, the new id 3.
// Requests go to localhost, where the local-dev auth bypass applies. All data is synthetic.

const ORIGIN = "http://localhost";
const RECONNECTED: WorldAccount = { id: 4, name: "Synthetic Rewards Card", institution: "Test Amex", currency: "GBP" };
const HELD = 3;

let w: ReturnType<typeof world>;
const app = createApp();

const listOnly = (accounts: WorldAccount[]) => {
  w.accountsReply = {
    body: { accounts: accounts.map((a) => accountJson(a.id, { name: a.name, institution_name: a.institution })), total: accounts.length },
  };
};
const importNow = () =>
  runImport({ DB: env.DB, LUNCHFLOW_API_KEY: "test-key", BACKFILL_DAYS: "730" }, "cron", {
    fetch: w.fetch,
    now: () => new Date(NOW),
    sleep: async () => {},
  });
const post = (path: string, body: unknown = {}) =>
  app.request(`${ORIGIN}${path}`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
const link = (id: number | string, intoAccountId: unknown) => post(`/api/accounts/${id}/link`, { intoAccountId });
const enable = (id: number | string) => post(`/api/accounts/${id}/enable`);
const listed = async () => ((await (await app.request(`${ORIGIN}/api/accounts`, {}, env)).json()) as { accounts: { id: number; needsReview: boolean }[] }).accounts;
const accountRows = () => env.DB.prepare("SELECT * FROM accounts ORDER BY id").all().then((r) => r.results);
const count = async (sql: string) => (await env.DB.prepare(`SELECT count(*) AS n FROM (${sql})`).first<{ n: number }>())!.n;
const fetchedFrom = (id: number, since: number) => w.calls.slice(since).some((c) => c.path.includes(`/accounts/${id}/`));

beforeEach(async () => {
  await resetDb();
  w = world([REVOLUT, AMEX, RECONNECTED]);
  w.txns[1] = [txn(1, "r1", { date: "2026-10-01" })];
  w.txns[2] = [txn(2, "a1", { date: "2026-10-01" })];
  // Same transaction ids as before the reconnect, plus one new purchase.
  w.txns[4] = [txn(4, "a1", { date: "2026-10-01" }), txn(4, "a2", { date: "2026-10-02" })];

  listOnly([REVOLUT, AMEX]);
  await importNow();
  // After the reconnect Lunch Flow lists the new id alongside the old one.
  w.accountsReply = undefined;
  await importNow();
});

describe("GET /api/accounts", () => {
  it("flags the account awaiting review", async () => {
    expect((await listed()).map((a) => [a.id, a.needsReview])).toEqual([
      [1, false],
      [2, false],
      [HELD, true],
    ]);
  });
});

describe("POST /api/accounts/:id/enable", () => {
  it("imports it as a new account from the next run", async () => {
    const res = await enable(HELD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    await importNow();
    expect(await count(`SELECT 1 FROM transactions WHERE account_id = ${HELD}`)).toBe(2);
    expect((await listed()).find((a) => a.id === HELD)!.needsReview).toBe(false);
  });

  it("refuses an account that isn't awaiting review", async () => {
    const before = await accountRows();
    const res = await enable(1);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_awaiting_review" });
    expect(await accountRows()).toEqual(before);
  });

  it("refuses an account whose currency isn't GBP yet", async () => {
    await env.DB.prepare(`UPDATE accounts SET currency = NULL WHERE id = ${HELD}`).run();
    const res = await enable(HELD);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_importable" });
  });

  it("returns 404 for an unknown account and 400 for a bad id", async () => {
    expect((await enable(999)).status).toBe(404);
    expect((await enable("abc")).status).toBe(400);
  });
});

describe("POST /api/accounts/:id/link", () => {
  it("imports the new provider id into the existing account without duplicating its history", async () => {
    const res = await link(HELD, 2);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const before = w.calls.length;
    await importNow();
    expect(fetchedFrom(4, before)).toBe(true);
    const rows = await env.DB.prepare("SELECT account_id, provider_txn_id FROM transactions WHERE account_id <> 1 ORDER BY provider_txn_id").all();
    expect(rows.results).toEqual([
      { account_id: 2, provider_txn_id: "a1" },
      { account_id: 2, provider_txn_id: "a2" },
    ]);
  });

  it("hides the merged row and never treats the old provider id as new again", async () => {
    await link(HELD, 2);
    expect((await listed()).map((a) => a.id)).toEqual([1, 2]);

    // Lunch Flow still lists the old id (2): no new row appears and it isn't fetched.
    const before = w.calls.length;
    await importNow();
    expect(await count("SELECT 1 FROM accounts")).toBe(3);
    expect(fetchedFrom(2, before)).toBe(false);
  });

  it("catches up from 7 days before the account's newest transaction", async () => {
    await link(HELD, 2);
    const row = await env.DB.prepare("SELECT backfill_floor_date, backfill_complete, import_enabled FROM accounts WHERE id = 2").first();
    expect(row).toEqual({ backfill_floor_date: "2026-09-24", backfill_complete: 0, import_enabled: 1 });
  });

  it("gives an account with no transactions a full backfill", async () => {
    await env.DB.prepare("UPDATE accounts SET newest_txn_date = NULL WHERE id = 2").run();
    await link(HELD, 2);
    const row = await env.DB.prepare("SELECT backfill_floor_date FROM accounts WHERE id = 2").first();
    expect(row).toEqual({ backfill_floor_date: null });
  });

  describe("refuses, changing nothing", () => {
    const refuses = async (id: number, into: number, error: string) => {
      const before = await accountRows();
      const res = await link(id, into);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error });
      expect(await accountRows()).toEqual(before);
    };

    it("a link into itself", () => refuses(HELD, HELD, "invalid_link_target"));

    it("a link into another account awaiting review", async () => {
      await env.DB.prepare("UPDATE accounts SET needs_review = 1 WHERE id = 1").run();
      await refuses(HELD, 1, "invalid_link_target");
    });

    it("a link into a merged row", async () => {
      await env.DB.prepare(`UPDATE accounts SET merged_into_account_id = 1 WHERE id = 2`).run();
      await refuses(HELD, 2, "invalid_link_target");
    });

    it("a link into an account in another currency", async () => {
      await env.DB.prepare("UPDATE accounts SET currency = 'USD' WHERE id = 2").run();
      await refuses(HELD, 2, "invalid_link_target");
    });

    it("a second link of the same account", async () => {
      await link(HELD, 2);
      await refuses(HELD, 1, "not_awaiting_review");
    });

    it("a link from an account that isn't awaiting review", () => refuses(1, 2, "not_awaiting_review"));
  });

  it("returns 404 for unknown accounts and 400 for a bad body", async () => {
    expect((await link(999, 2)).status).toBe(404);
    expect((await link(HELD, 999)).status).toBe(404);
    expect((await link(HELD, "x")).status).toBe(400);
    expect((await link("abc", 2)).status).toBe(400);
    const bad = await app.request(
      `${ORIGIN}/api/accounts/${HELD}/link`,
      { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{" },
      env,
    );
    expect(bad.status).toBe(400);
  });
});
