import { env } from "cloudflare:workers";
import { beforeAll, describe, it } from "vitest";
import { createApp } from "../src/worker";
import { runImport } from "../src/worker/importer";
import { AMEX, REVOLUT, txn, world } from "./fixtures/lunchflow";
import { resetDb } from "./db";

// Exploratory probe, not a regression test: how many rows D1 bills (meta.rows_read) for each
// API call the UI makes, and for a cron import, on a synthetic ledger about the size of two
// years of two accounts. It asserts nothing; run it with --reporter=verbose to see the table
// (docs/research/d1-rows-read.md). All data is synthetic.

const ORIGIN = "http://localhost";
const app = createApp();

let rowsRead = 0;
const counted = (meta: { rows_read?: number } | undefined) => (rowsRead += meta?.rows_read ?? 0);

const real = new WeakMap<object, D1PreparedStatement>();
function wrapStmt(stmt: D1PreparedStatement): D1PreparedStatement {
  const w = {
    bind: (...v: unknown[]) => wrapStmt(stmt.bind(...v)),
    all: async () => {
      const r = await stmt.all();
      counted(r.meta);
      return r;
    },
    run: async () => {
      const r = await stmt.run();
      counted(r.meta);
      return r;
    },
    first: async (col?: string) => {
      const r = await stmt.all<Record<string, unknown>>();
      counted(r.meta);
      const row = r.results[0] ?? null;
      return col ? (row?.[col] ?? null) : row;
    },
    raw: async () => {
      const r = await stmt.all<Record<string, unknown>>();
      counted(r.meta);
      return r.results.map((row) => Object.values(row));
    },
  } as unknown as D1PreparedStatement;
  real.set(w, stmt);
  return w;
}
const DB = {
  prepare: (sql: string) => wrapStmt(env.DB.prepare(sql)),
  batch: async (stmts: D1PreparedStatement[]) => {
    const rs = await env.DB.batch(stmts.map((s) => real.get(s) ?? s));
    for (const r of rs) counted(r.meta);
    return rs;
  },
  exec: (q: string) => env.DB.exec(q),
} as unknown as D1Database;
const probeEnv = { ...env, DB };

async function measure(method: string, path: string, body?: unknown) {
  rowsRead = 0;
  const res = await app.request(
    `${ORIGIN}${path}`,
    method === "GET" ? {} : { method, headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    probeEnv,
  );
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return { json: (await res.json()) as Record<string, unknown>, rowsRead };
}

// Deterministic PRNG so runs compare.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const N_TXNS = 4000;
const N_MERCHANTS = Math.round(N_TXNS / 8);
const N_EXACT_RULES = 150;
const N_CONTAINS_RULES = 10;
const N_OVERRIDES = 200;

async function seedLedger() {
  const now = "2026-10-05T12:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO accounts (provider, provider_account_id, name, currency, provider_status, import_enabled, created_at, updated_at, last_data_change_at)
       VALUES ('lunchflow', 'a1', 'Bank A', 'GBP', 'ACTIVE', 1, ?1, ?1, ?1), ('lunchflow', 'a2', 'Card B', 'GBP', 'ACTIVE', 1, ?1, ?1, ?1)`,
    ).bind(now),
    env.DB.prepare("INSERT INTO import_runs (trigger, started_at, finished_at, status) VALUES ('cron', ?1, ?1, 'success')").bind(now),
  ]);
  const rows = [];
  const start = Date.parse("2024-10-05");
  for (let i = 0; i < N_TXNS; i++) {
    // Zipf-ish: a few merchants dominate.
    const m = Math.floor(N_MERCHANTS * rand() ** 2.5);
    const day = new Date(start + Math.floor(rand() * 730) * 86_400_000).toISOString().slice(0, 10);
    rows.push({ a: 1 + (i % 2), p: `t${i}`, amt: -Math.floor(rand() * 8000) - 100, d: day, m: `Synthetic Merchant ${m}` });
  }
  for (let i = 0; i < rows.length; i += 500) {
    await env.DB.prepare(
      `INSERT INTO transactions (account_id, provider_txn_id, amount_minor, provider_amount, currency, txn_date, merchant, description,
         is_pending, fingerprint, first_seen_at, last_seen_at, updated_at, first_import_run_id)
       SELECT j.value->>'a', j.value->>'p', j.value->>'amt', '0', 'GBP', j.value->>'d', j.value->>'m', '', 0, 'fp', ?2, ?2, ?2, 1
       FROM json_each(?1) j`,
    )
      .bind(JSON.stringify(rows.slice(i, i + 500)), now)
      .run();
  }
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
     INSERT INTO merchant_rules (match_type, pattern, category_id, created_at, updated_at)
     SELECT 'exact', 'synthetic merchant ' || i, 1 + i % 8, ?1, ?1 FROM n`,
  )
    .bind(now, N_EXACT_RULES)
    .run();
  for (let i = 0; i < N_CONTAINS_RULES; i++)
    await env.DB.prepare(
      "INSERT INTO merchant_rules (match_type, pattern, category_id, created_at, updated_at) VALUES ('contains', ?1, 2, ?2, ?2)",
    )
      .bind(`merchant ${400 + i * 7}`, now)
      .run();
  await env.DB.prepare(
    `INSERT INTO transaction_overrides (transaction_id, category_id, updated_at)
     SELECT id, 3, ?1 FROM transactions WHERE id % ?2 = 0 LIMIT ?3`,
  )
    .bind(now, Math.floor(N_TXNS / N_OVERRIDES), N_OVERRIDES)
    .run();
  await env.DB.prepare("INSERT INTO monthly_budgets (effective_month, amount_minor, updated_at) VALUES ('2026-10', 200000, ?1)").bind(now).run();
}

describe(`rows_read per API call (${N_TXNS} transactions)`, () => {
  beforeAll(async () => {
    await resetDb();
    await seedLedger();
  });

  it("reports", async () => {
    const table: [string, number][] = [];
    const record = async (label: string, method: string, path: string, body?: unknown) => {
      const r = await measure(method, path, body);
      table.push([label, r.rowsRead]);
      return r.json;
    };
    const counts = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM transactions) t, (SELECT count(DISTINCT account_id || merchant) FROM transactions) m, (SELECT count(*) FROM merchant_rules) r",
    ).first();
    console.log("ledger", counts);

    await record("GET /api/categories", "GET", "/api/categories");
    await record("GET /api/accounts", "GET", "/api/accounts");
    await record("GET /api/budget", "GET", "/api/budget");
    await record("GET /api/import-runs", "GET", "/api/import-runs?limit=10");
    await record("GET /api/months/2026-10/summary", "GET", "/api/months/2026-10/summary");
    await record("GET /api/rules", "GET", "/api/rules");
    const inbox = (await record("GET /api/inbox?limit=100", "GET", "/api/inbox?limit=100")) as { transactions: { id: number }[] };
    await record("GET /api/inbox/merchants", "GET", "/api/inbox/merchants");
    await record("GET /api/transactions (one month, 100)", "GET", "/api/transactions?limit=100&from=2026-09-01&to=2026-09-30");
    await record("GET /api/months/:month/transactions (a line)", "GET", "/api/months/2026-09/transactions?category=1");
    const id = inbox.transactions[0]!.id;
    await record("PUT /api/transactions/:id/override", "PUT", `/api/transactions/${id}/override`, { categoryId: 4 });
    await record("POST /api/rules", "POST", "/api/rules", { matchType: "exact", pattern: "synthetic merchant 300", categoryId: 2 });

    // What one tap costs once the global invalidate-on-every-write refetches the open screen
    // (src/web/main.tsx). Only active queries refetch at once; the rest refetch on next visit.
    const screen = async (paths: string[]) => {
      let n = 0;
      for (const p of paths) n += (await measure("GET", p)).rowsRead;
      return n;
    };
    const refs = ["/api/categories", "/api/accounts", "/api/budget"];
    const toSort = await screen(["/api/inbox/merchants", "/api/inbox?limit=100", ...refs]);
    const fileGroup = (await measure("POST", "/api/rules", { matchType: "exact", pattern: "synthetic merchant 301", categoryId: 2 })).rowsRead + toSort;
    const fileRow = (await measure("PUT", `/api/transactions/${inbox.transactions[1]!.id}/override`, { categoryId: 4 })).rowsRead + toSort;
    const home = await screen(["/api/months/2026-10/summary", "/api/months/2026-09/summary", "/api/months/2026-08/summary", "/api/categories", "/api/accounts"]);
    const categories = await screen(["/api/rules", "/api/months/2026-10/summary", ...refs]);
    const transactions = await screen(["/api/transactions?limit=100&from=2026-10-01&to=2026-10-31", "/api/months/2026-10/summary", "/api/categories", "/api/accounts"]);
    table.push(
      ["", 0],
      ["To sort: file a merchant group (+ refetch)", fileGroup],
      ["To sort: file one row (+ refetch)", fileRow],
      ["Open Home (3 month summaries)", home],
      ["Open Categories", categories],
      ["Open Transactions (one month)", transactions],
    );
    console.log(table.map(([l, n]) => (l ? `${l.padEnd(44)} ${String(n).padStart(9)}` : "")).join("\n"));
  });
});

describe(`rows_read per cron import (${N_TXNS} transactions over 2 years)`, () => {
  it("reports", async () => {
    await resetDb();
    const w = world([REVOLUT, AMEX]);
    const start = Date.parse("2024-10-06");
    w.txns[1] = [];
    w.txns[2] = [];
    for (let i = 0; i < N_TXNS; i++) {
      const a = 1 + (i % 2);
      const date = new Date(start + Math.floor(rand() * 730) * 86_400_000).toISOString().slice(0, 10);
      w.txns[a]!.push(txn(a, `x${i}`, { amount: -(1 + Math.floor(rand() * 80)), date, merchant: `Synthetic Merchant ${Math.floor(N_MERCHANTS * rand() ** 2.5)}` }));
    }
    let t = Date.parse("2026-10-05T12:00:00.000Z");
    const go = async () => {
      rowsRead = 0;
      const s = await runImport({ DB, LUNCHFLOW_API_KEY: "test-key", BACKFILL_DAYS: "730" }, "cron", {
        fetch: w.fetch,
        now: () => new Date((t += 60_000)),
        sleep: async () => {},
      });
      return { status: s.status, rowsRead };
    };
    const backfill: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await go();
      backfill.push(r.rowsRead);
      t += 3 * 3600_000;
    }
    const steady = await go();
    const stored = await env.DB.prepare("SELECT count(*) AS n FROM transactions").first();
    console.log("stored", stored, "backfill runs rows_read", backfill.join(", "), "\nsteady-state cron run", steady);
  });
});
