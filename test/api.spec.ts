import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker";
import { insertAccount, insertRun, insertTransaction, resetDb } from "./db";
import { txn, world, type WorldAccount } from "./fixtures/lunchflow";

// Requests go to localhost, where the local-dev auth bypass applies (Vitest runs with
// import.meta.env.DEV = true); auth itself is covered by auth.spec.ts. All data is synthetic.

const ORIGIN = "http://localhost";
const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const REVOLUT: WorldAccount = { id: 1, name: "GB29NWBK60161331926819", institution: "Revolut", currency: "GBP" };
const AMEX: WorldAccount = { id: 2, name: "Synthetic Rewards Card", institution: "Test Amex", currency: "GBP" };

let clock: number;
let w: ReturnType<typeof world>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  clock = T0;
  w = world([REVOLUT, AMEX]);
  w.txns[1] = [txn(1, "r1", { amount: -12.3, date: "2026-10-01" }), txn(1, "r2", { amount: 5, date: "2026-09-30", isPending: true })];
  w.txns[2] = [txn(2, "a1", { amount: -50, date: "2026-09-29" })];
  app = createApp({ importDeps: { fetch: w.fetch, now: () => new Date(clock), sleep: async () => {} } });
});

const get = (path: string) => app.request(`${ORIGIN}${path}`, {}, env);
const getJson = async <T>(path: string) => (await (await get(path)).json()) as T;

function postImport(headers: Record<string, string> = { "Content-Type": "application/json" }) {
  const init = { method: "POST", headers: { Origin: ORIGIN, ...headers }, body: "{}" };
  return app.request(`${ORIGIN}/api/import-runs`, init, env, createExecutionContext());
}

type Run = { id: number; trigger: string; status: string; accounts: { accountId: number; status: string; inserted: number }[] };

describe("POST /api/import-runs", () => {
  it("runs a manual import and returns the run with per-account results", async () => {
    const res = await postImport();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: Run };
    expect(body.run).toMatchObject({ trigger: "manual", status: "success" });
    expect(body.run.accounts.map((a) => [a.accountId, a.status, a.inserted])).toEqual([
      [1, "success", 2],
      [2, "success", 1],
    ]);
  });

  it("returns a friendly 429 with Retry-After when the last run started under 60 s ago", async () => {
    expect((await postImport()).status).toBe(200);
    clock += 30_000;
    const res = await postImport();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 30 });
    // No run row is created for a rejected tap.
    expect((await env.DB.prepare("SELECT count(*) AS n FROM import_runs").first<{ n: number }>())!.n).toBe(1);
  });

  it("allows another import once 60 s have passed", async () => {
    await postImport();
    clock += 60_000;
    expect((await postImport()).status).toBe(200);
  });

  it("counts a recent cron run towards the 60 s limit", async () => {
    await env.DB.prepare("INSERT INTO import_runs (trigger, started_at, status) VALUES ('cron', ?1, 'success')")
      .bind(new Date(T0 - 10_000).toISOString())
      .run();
    expect((await postImport()).status).toBe(429);
  });

  it("returns 409 when another run holds the import lock", async () => {
    const holder = await insertRun("cron", "running");
    await env.DB.prepare("UPDATE import_lock SET holder_run_id = ?1, expires_at = ?2 WHERE id = 1")
      .bind(holder, new Date(T0 + 300_000).toISOString())
      .run();
    // The holder started long enough ago not to trip the 60 s limit.
    await env.DB.prepare("UPDATE import_runs SET started_at = ?2 WHERE id = ?1").bind(holder, new Date(T0 - 120_000).toISOString()).run();

    const res = await postImport();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; run: Run };
    expect(body.error).toBe("import_running");
    expect(body.run.status).toBe("skipped_locked");

    // That tap imported nothing, so tapping again straight away is another 409, not a 429.
    clock += 5_000;
    expect((await postImport()).status).toBe(409);
  });

  it("rejects a POST that isn't JSON (415)", async () => {
    expect((await postImport({ "Content-Type": "text/plain" })).status).toBe(415);
  });

  it("reports provider failures in the run rather than as an HTTP error", async () => {
    w.accountsReply = { status: 500 };
    const res = await postImport();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { run: Run }).run.status).toBe("failed");
  });
});

describe("GET /api/import-runs", () => {
  it("lists recent runs newest first with per-account results", async () => {
    await postImport();
    clock += 60_000;
    await postImport();

    const body = await getJson<{ runs: Run[] }>("/api/import-runs");
    expect(body.runs.map((r) => r.id)).toEqual([2, 1]);
    expect(body.runs[1]!.accounts.map((a) => a.inserted)).toEqual([2, 1]);
    expect(body.runs[0]!.accounts.map((a) => a.inserted)).toEqual([0, 0]);
  });

  it("honours limit", async () => {
    for (let i = 0; i < 3; i++) await insertRun("cron", "success");
    const body = await getJson<{ runs: Run[] }>("/api/import-runs?limit=2");
    expect(body.runs.map((r) => r.id)).toEqual([3, 2]);
  });

  it.each(["0", "51", "abc", "1.5"])("rejects limit=%s (400)", async (limit) => {
    const res = await get(`/api/import-runs?limit=${limit}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });
});

describe("GET /api/accounts", () => {
  it("returns accounts with import status fields and no provider ids", async () => {
    await postImport();
    const body = await getJson<{ accounts: Record<string, unknown>[] }>("/api/accounts");
    expect(body.accounts).toHaveLength(2);
    expect(body.accounts[0]).toEqual({
      id: 1,
      name: expect.any(String),
      institutionName: "Revolut",
      providerStatus: "ACTIVE",
      currency: "GBP",
      balanceMinor: 10050,
      balanceFetchedAt: "2026-10-02T12:00:00.000Z",
      importEnabled: true,
      lastImportAttemptAt: "2026-10-02T12:00:00.000Z",
      lastImportSuccessAt: "2026-10-02T12:00:00.000Z",
      lastImportError: null,
      consecutiveFailures: 0,
      lastDataChangeAt: "2026-10-02T12:00:00.000Z",
      newestTxnDate: "2026-10-01",
      backfillComplete: false,
    });
    // The display label never carries the raw IBAN.
    expect(body.accounts[0]!.name).not.toContain("GB29NWBK");
  });
});

describe("GET /api/transactions", () => {
  type Txn = { id: number; accountId: number; txnDate: string; amountMinor: number; isPending: boolean };
  type Page = { transactions: Txn[]; nextCursor: string | null };

  let acc1: number;
  let acc2: number;

  beforeEach(async () => {
    acc1 = await insertAccount({ providerAccountId: "1001" });
    acc2 = await insertAccount({ providerAccountId: "1002" });
    const run = await insertRun();
    // Two rows share 2026-09-30 to exercise the id tiebreak.
    await insertTransaction(acc1, run, "t1", { txnDate: "2026-09-28" });
    await insertTransaction(acc1, run, "t2", { txnDate: "2026-09-30", isPending: 1 });
    await insertTransaction(acc2, run, "t3", { txnDate: "2026-09-30" });
    await insertTransaction(acc1, run, "t4", { txnDate: "2026-10-01" });
  });

  it("lists newest first, ties broken by id, with camelCase fields", async () => {
    const body = await getJson<Page>("/api/transactions");
    expect(body.transactions.map((t) => [t.txnDate, t.id])).toEqual([
      ["2026-10-01", 4],
      ["2026-09-30", 3],
      ["2026-09-30", 2],
      ["2026-09-28", 1],
    ]);
    expect(body.transactions[2]).toMatchObject({ accountId: acc1, amountMinor: -1230, isPending: true });
    expect(body.nextCursor).toBeNull();
  });

  it("filters by account", async () => {
    const body = await getJson<Page>(`/api/transactions?account_id=${acc2}`);
    expect(body.transactions.map((t) => t.id)).toEqual([3]);
  });

  it("filters by an inclusive date range", async () => {
    const body = await getJson<Page>("/api/transactions?from=2026-09-29&to=2026-09-30");
    expect(body.transactions.map((t) => t.id)).toEqual([3, 2]);
  });

  it("pages with a cursor without skipping or repeating rows", async () => {
    const first = await getJson<Page>("/api/transactions?limit=2");
    expect(first.transactions.map((t) => t.id)).toEqual([4, 3]);
    expect(first.nextCursor).not.toBeNull();

    const second = await getJson<Page>(`/api/transactions?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.transactions.map((t) => t.id)).toEqual([2, 1]);
    expect(second.nextCursor).toBeNull();
  });

  it.each([
    "limit=201",
    "limit=0",
    "account_id=abc",
    "from=2026-02-30",
    "to=yesterday",
    "cursor=garbage",
    "cursor=2026-13-01_5",
  ])("rejects %s (400)", async (query) => {
    const res = await get(`/api/transactions?${query}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });
});
