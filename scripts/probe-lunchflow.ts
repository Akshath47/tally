// P1.1 Lunch Flow Personal API probe.
//
// Run:  node --env-file=.dev.vars scripts/probe-lunchflow.ts [--sample]
//
// Prints summaries only: field names/types, counts, date ranges, sign
// distribution, pending counts, total-vs-length, timings and response header
// names. Never prints the API key or full response bodies. `--sample` also
// prints the newest 20 transactions per account for comparison with the bank
// apps. Pending transactions (id, date, amount only) are snapshotted to the
// gitignored .probe/ directory so a later run can diff pending -> posted.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const BASE = "https://lunchflow.app/api/v1";
const KEY = process.env.LUNCHFLOW_API_KEY;
const SAMPLE = process.argv.includes("--sample");
const SNAPSHOT_DIR = ".probe";
const SNAPSHOT_FILE = `${SNAPSHOT_DIR}/pending-snapshot.json`;
// Header values worth seeing for caching / rate limits; everything else is name-only.
const SHOW_HEADER_VALUE = /ratelimit|retry-after|cache|^age$|etag|last-modified|^date$/i;

if (!KEY) {
  console.error("LUNCHFLOW_API_KEY is not set. Run with --env-file=.dev.vars");
  process.exit(1);
}

type Json = any;
type Call = { status: number; ms: number; body: Json; headers: Record<string, string | null> };

const headerNamesSeen = new Set<string>();

async function call(path: string, key = KEY!): Promise<Call> {
  const started = Date.now();
  const res = await fetch(BASE + path, {
    headers: { "x-api-key": key, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const ms = Date.now() - started;
  const headers: Record<string, string | null> = {};
  res.headers.forEach((value, name) => {
    headerNamesSeen.add(name);
    headers[name] = SHOW_HEADER_VALUE.test(name) ? value : null;
  });
  const text = await res.text();
  let body: Json = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJsonBodyLength: text.length };
  }
  await new Promise((r) => setTimeout(r, 400)); // stay gentle: rate limits are undocumented
  return { status: res.status, ms, body, headers };
}

function describeSchema(rows: Json[]): Record<string, string> {
  const fields: Record<string, { types: Set<string>; nulls: number; empties: number }> = {};
  for (const row of rows) {
    for (const [k, v] of Object.entries(row ?? {})) {
      const f = (fields[k] ??= { types: new Set(), nulls: 0, empties: 0 });
      f.types.add(v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
      if (v === null || v === undefined) f.nulls++;
      if (v === "") f.empties++;
    }
  }
  const out: Record<string, string> = {};
  for (const [k, f] of Object.entries(fields)) {
    const missing = rows.length - rows.filter((r) => r && k in r).length;
    out[k] = `${[...f.types].join("|")}  nulls=${f.nulls} empty=${f.empties} missing=${missing}`;
  }
  return out;
}

function decimals(n: number): number {
  const s = String(n);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

function idShape(ids: string[]): string {
  const lengths = new Set(ids.map((id) => String(id).length));
  const patterns = new Set(
    ids.map((id) =>
      /^[0-9]+$/.test(id) ? "numeric"
      : /^[0-9a-f-]{36}$/i.test(id) ? "uuid"
      : /^[0-9a-f]+$/i.test(id) ? "hex"
      : "other",
    ),
  );
  const dupes = ids.length - new Set(ids).size;
  return `patterns=${[...patterns].join(",")} lengths=${[...lengths].slice(0, 5).join(",")} duplicateIds=${dupes}`;
}

function summariseTransactions(label: string, c: Call) {
  const txns: Json[] = c.body?.transactions ?? [];
  const dates = txns.map((t) => t.date).filter(Boolean).sort();
  const amounts = txns.map((t) => t.amount).filter((a) => typeof a === "number");
  console.log(`  [${label}] HTTP ${c.status} ${c.ms}ms  returned=${txns.length} total=${c.body?.total}` +
    (typeof c.body?.total === "number" && c.body.total !== txns.length ? "  <-- total != length (truncation/pagination?)" : ""));
  if (c.status !== 200) {
    console.log(`    error body keys=${Object.keys(c.body ?? {}).join(",")} error=${c.body?.error} message=${c.body?.message}`);
    return txns;
  }
  if (!txns.length) return txns;
  console.log(`    dates ${dates[0]} .. ${dates[dates.length - 1]}`);
  console.log(`    amounts: negative=${amounts.filter((a) => a < 0).length} positive=${amounts.filter((a) => a > 0).length} zero=${amounts.filter((a) => a === 0).length} maxDecimals=${amounts.length ? Math.max(...amounts.map(decimals)) : "n/a"} nonNumericAmounts=${txns.length - amounts.length}`);
  console.log(`    currencies=${[...new Set(txns.map((t) => t.currency))].join(",")} pending=${txns.filter((t) => t.isPending).length}`);
  console.log(`    ids: ${idShape(txns.map((t) => String(t.id)))}`);
  const dateFormats = new Set(txns.map((t) => (/^\d{4}-\d{2}-\d{2}$/.test(t.date) ? "YYYY-MM-DD" : String(t.date).slice(0, 25))));
  console.log(`    date formats=${[...dateFormats].join(" | ")}`);
  return txns;
}

// A posted transaction that plausibly is a previously pending one: same amount, date within 5 days.
function isLookalike(posted: Json, pending: Json): boolean {
  return !posted.isPending && posted.amount === pending.amount &&
    Math.abs(Date.parse(posted.date) - Date.parse(pending.date)) <= 5 * 864e5;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`Lunch Flow probe  ${new Date().toISOString()}\n`);

  // 1. Accounts
  const acc = await call("/accounts");
  const accounts: Json[] = acc.body?.accounts ?? [];
  console.log(`GET /accounts  HTTP ${acc.status} ${acc.ms}ms  returned=${accounts.length} total=${acc.body?.total}`);
  console.log("  top-level keys:", Object.keys(acc.body ?? {}).join(", "));
  console.log("  account schema:", describeSchema(accounts));
  for (const a of accounts) {
    console.log(`  - id=${a.id} conn=${a.connection_id} "${a.name}" @ ${a.institution_name} provider=${a.provider} ${a.currency} status=${a.status}`);
  }

  const previous = existsSync(SNAPSHOT_FILE) ? JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) : null;
  const snapshot: Record<string, { takenAt: string; pending: Json[] }> = {};

  // 2. Per-account transactions
  for (const a of accounts) {
    console.log(`\n=== Account ${a.id} "${a.name}" (${a.institution_name})`);

    const def = await call(`/accounts/${a.id}/transactions`);
    const defTxns = summariseTransactions("default (no params)", def);
    if (defTxns.length) console.log("    transaction schema:", describeSchema(defTxns));

    const pend = await call(`/accounts/${a.id}/transactions?include_pending=true`);
    const pendTxns = summariseTransactions("include_pending=true", pend);

    const deep = await call(`/accounts/${a.id}/transactions?include_pending=true&from=${isoDaysAgo(730)}&to=${isoDaysAgo(0)}`);
    summariseTransactions("from=-730d", deep);

    const win = await call(`/accounts/${a.id}/transactions?from=${isoDaysAgo(14)}&to=${isoDaysAgo(0)}`);
    summariseTransactions("from=-14d (incremental window)", win);

    const bal = await call(`/accounts/${a.id}/balance`);
    console.log(`  [balance] HTTP ${bal.status} ${bal.ms}ms  keys=${Object.keys(bal.body ?? {}).join(",")}  schema=${JSON.stringify(describeSchema([bal.body?.balance ?? bal.body]))}`);

    if (pend.status !== 200) {
      // Keep the previous baseline rather than overwriting it with an empty one.
      if (previous?.[a.id]) snapshot[a.id] = previous[a.id];
      console.log("  [pending diff] skipped: include_pending call failed, previous snapshot kept");
      continue;
    }

    const pending = pendTxns.filter((t) => t.isPending);
    // Minimal snapshot for the pending -> posted diff: id, date, amount only.
    const slim = (t: Json) => ({ id: String(t.id), date: t.date, amount: t.amount });
    snapshot[a.id] = { takenAt: new Date().toISOString(), pending: pending.map(slim) };

    if (previous?.[a.id]) {
      const nowIds = new Set(pendTxns.map((t) => String(t.id)));
      const prevPending: Json[] = previous[a.id].pending;
      const stillPending = prevPending.filter((p) => pendTxns.some((t) => String(t.id) === p.id && t.isPending));
      const nowPosted = prevPending.filter((p) => pendTxns.some((t) => String(t.id) === p.id && !t.isPending));
      const vanished = prevPending.filter((p) => !nowIds.has(p.id));
      const vanishedWithLookalike = vanished.filter((p) => pendTxns.some((t) => isLookalike(t, p)));
      console.log(`  [pending diff vs ${previous[a.id].takenAt}] previouslyPending=${prevPending.length} stillPending=${stillPending.length} sameIdNowPosted=${nowPosted.length} vanished=${vanished.length} vanishedButPostedLookalike=${vanishedWithLookalike.length}`);
      // Does the date move when a pending transaction posts? (booking vs purchase date)
      for (const p of [...nowPosted, ...vanishedWithLookalike]) {
        const posted = pendTxns.find((t) => (!t.isPending && String(t.id) === p.id) || isLookalike(t, p));
        if (posted) console.log(`    pending ${p.date} -> posted ${posted.date} (shift ${(Date.parse(posted.date) - Date.parse(p.date)) / 864e5}d, id ${String(posted.id) === p.id ? "same" : "changed"})`);
      }
    }

    if (SAMPLE) {
      console.log("  newest 20 (date | amount currency | pending | merchant | description):");
      for (const t of [...pendTxns].sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 20)) {
        console.log(`    ${t.date} | ${t.amount} ${t.currency} | ${t.isPending ? "P" : " "} | ${t.merchant} | ${t.description}`);
      }
    }
  }

  // 3. Error shapes
  console.log("\n=== Error shapes");
  const badKey = await call("/accounts", "invalid-key-for-probe");
  console.log(`  invalid key: HTTP ${badKey.status} keys=${Object.keys(badKey.body ?? {}).join(",")} error=${badKey.body?.error} message=${badKey.body?.message}`);
  const badAcc = await call("/accounts/999999999/transactions");
  console.log(`  unknown account: HTTP ${badAcc.status} keys=${Object.keys(badAcc.body ?? {}).join(",")} error=${badAcc.body?.error} message=${badAcc.body?.message}`);
  if (accounts.length) {
    const badDate = await call(`/accounts/${accounts[0].id}/transactions?from=not-a-date`);
    console.log(`  bad date param: HTTP ${badDate.status} body=${JSON.stringify(badDate.body).slice(0, 300)}`);
  }

  // 4. Headers
  console.log("\n=== Response header names seen:", [...headerNamesSeen].sort().join(", "));
  console.log("  cache/rate-limit header values (from last accounts call):",
    JSON.stringify(Object.fromEntries(Object.entries(acc.headers).filter(([, v]) => v !== null))));

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  console.log(`\nPending snapshot written to ${SNAPSHOT_FILE} (gitignored). Re-run in 1-2 days to diff.`);
}

main().catch((err) => {
  console.error("Probe failed:", err?.name, err?.message);
  process.exit(1);
});
