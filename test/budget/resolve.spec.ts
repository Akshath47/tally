import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { INBOX, RESOLVED_CTE, normalizePattern } from "../../src/worker/budget/resolve";
import { resetDb } from "../db";
import { SEEDED, insertOverride, insertRule, ledger } from "./helpers";

// Category resolution: override, then the best merchant rule, then none. All data is synthetic.

type Resolved = { category_id: number | null; category_source: string | null; rule_id: number | null };

const resolve = (id: number) =>
  env.DB.prepare(`WITH ${RESOLVED_CTE} SELECT category_id, category_source, rule_id FROM resolved WHERE id = ?1`)
    .bind(id)
    .first<Resolved>();

let L: Awaited<ReturnType<typeof ledger>>;
let a1: number;
let a2: number;

beforeEach(async () => {
  await resetDb();
  L = await ledger();
  [a1, a2] = L.accounts;
});

describe("resolved", () => {
  it("leaves a transaction no rule matches uncategorised", async () => {
    const t = await L.txn(a1, { merchant: "Unmatched Shop" });
    await insertRule("contains", "cafe", SEEDED.eatingOut);
    expect(await resolve(t)).toEqual({ category_id: null, category_source: null, rule_id: null });
  });

  it("puts an override above every rule", async () => {
    const t = await L.txn(a1, { merchant: "Synthetic Cafe" });
    await insertRule("exact", "synthetic cafe", SEEDED.eatingOut, a1);
    await insertOverride(t, { category_id: SEEDED.clothes });
    expect(await resolve(t)).toEqual({ category_id: SEEDED.clothes, category_source: "override", rule_id: null });
  });

  it("follows the rules when an override sets no category", async () => {
    const t = await L.txn(a1, { merchant: "Synthetic Cafe" });
    const rule = await insertRule("exact", "synthetic cafe", SEEDED.eatingOut);
    await insertOverride(t, { excluded: 1 });
    expect(await resolve(t)).toEqual({ category_id: SEEDED.eatingOut, category_source: "rule", rule_id: rule });
  });

  it("ranks account-scoped exact > any-account exact > account-scoped contains > any-account contains", async () => {
    const t = await L.txn(a1, { merchant: "Synthetic Cafe" });
    const anyContains = await insertRule("contains", "cafe", SEEDED.other);
    expect((await resolve(t))!.rule_id).toBe(anyContains);
    const scopedContains = await insertRule("contains", "cafe", SEEDED.shopping, a1);
    expect((await resolve(t))!.rule_id).toBe(scopedContains);
    const anyExact = await insertRule("exact", "synthetic cafe", SEEDED.groceries);
    expect((await resolve(t))!.rule_id).toBe(anyExact);
    const scopedExact = await insertRule("exact", "synthetic cafe", SEEDED.eatingOut, a1);
    expect(await resolve(t)).toEqual({ category_id: SEEDED.eatingOut, category_source: "rule", rule_id: scopedExact });
  });

  it("prefers the longer contains pattern, then the older rule", async () => {
    const t = await L.txn(a1, { merchant: "Synthetic Cafe Bar" });
    await insertRule("contains", "cafe", SEEDED.other);
    const longer = await insertRule("contains", "cafe bar", SEEDED.eatingOut);
    expect((await resolve(t))!.rule_id).toBe(longer);

    // Two 4-character patterns that both match: the older one wins.
    const t2 = await L.txn(a1, { merchant: "Bar Deli" });
    const older = await insertRule("contains", "ar d", SEEDED.shopping);
    await insertRule("contains", "r de", SEEDED.groceries);
    expect((await resolve(t2))!.rule_id).toBe(older);
  });

  it("ignores a rule scoped to another account", async () => {
    const t = await L.txn(a1, { merchant: "Synthetic Cafe" });
    await insertRule("exact", "synthetic cafe", SEEDED.eatingOut, a2);
    expect((await resolve(t))!.category_id).toBeNull();
  });

  it("matches % and _ in a contains pattern literally", async () => {
    const wild = await L.txn(a1, { merchant: "Shop 50% off" });
    const plain = await L.txn(a1, { merchant: "Shop 50 off" });
    await insertRule("contains", "50%", SEEDED.shopping);
    await insertRule("contains", "a_b", SEEDED.other);
    const underscore = await L.txn(a1, { merchant: "Shop axb" });
    expect((await resolve(wild))!.category_id).toBe(SEEDED.shopping);
    expect((await resolve(plain))!.category_id).toBeNull();
    expect((await resolve(underscore))!.category_id).toBeNull();
  });

  it("matches an exact rule made from merchant text with non-ASCII letters and spaces", async () => {
    const t = await L.txn(a1, { merchant: "  CAFÉ NERO " });
    await insertRule("exact", normalizePattern("CAFÉ Nero  "), SEEDED.eatingOut);
    expect((await resolve(t))!.category_id).toBe(SEEDED.eatingOut);
  });

  it("re-sorts existing transactions when a rule is added, leaving overridden ones alone", async () => {
    const plain = await L.txn(a1, { merchant: "Synthetic Grocer" });
    const overridden = await L.txn(a1, { merchant: "Synthetic Grocer" });
    await insertOverride(overridden, { category_id: SEEDED.shopping });
    await insertRule("exact", "synthetic grocer", SEEDED.groceries);
    expect((await resolve(plain))!.category_id).toBe(SEEDED.groceries);
    expect((await resolve(overridden))!.category_id).toBe(SEEDED.shopping);
  });

  it("categorises pending and vanished transactions by rule too", async () => {
    const pending = await L.txn(a1, { merchant: "Synthetic Cafe", isPending: true });
    const vanished = await L.txn(a1, { merchant: "Synthetic Cafe", vanished: true });
    await insertRule("exact", "synthetic cafe", SEEDED.eatingOut);
    expect((await resolve(pending))!.category_id).toBe(SEEDED.eatingOut);
    expect((await resolve(vanished))!.category_id).toBe(SEEDED.eatingOut);
  });
});

// D1's free tier allows 5M rows read a day, so resolving one row mustn't resolve the history.
describe("resolved: rows read", () => {
  it("resolves one transaction, or the ones to sort, without reading the rest", async () => {
    // 600 transactions across 120 merchants, and 80 rules of each match type that match none of them.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
       INSERT INTO transactions (account_id, provider_txn_id, amount_minor, provider_amount, currency, txn_date,
         merchant, description, is_pending, fingerprint, first_seen_at, last_seen_at, updated_at, first_import_run_id)
       SELECT ?1, 'bulk' || i, -100, '-1', 'GBP', '2026-09-01', 'Synthetic Merchant ' || (i % 120), '', 0, 'fp', ?2, ?2, ?2,
         (SELECT min(id) FROM import_runs)
       FROM n`,
    )
      .bind(a1, "2026-10-01T00:00:00.000Z")
      .run();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 80)
       INSERT INTO merchant_rules (match_type, pattern, account_id, category_id, created_at, updated_at)
       SELECT m.t, 'no match ' || i, NULL, ?1, ?2, ?2 FROM n, (SELECT 'exact' AS t UNION ALL SELECT 'contains') m`,
    )
      .bind(SEEDED.other, "2026-10-01T00:00:00.000Z")
      .run();
    await insertRule("contains", "merchant 1", SEEDED.shopping);

    const all = await env.DB.prepare(`WITH ${RESOLVED_CTE} SELECT count(*) AS n FROM resolved WHERE category_id IS NOT NULL`).run<{ n: number }>();
    // Merchants 1, 10–19 and 100–119 contain "merchant 1": 31 merchants × 5 transactions.
    expect(all.results[0]!.n).toBe(155);

    const one = await env.DB.prepare(`WITH ${RESOLVED_CTE} SELECT category_id FROM resolved WHERE id = ?1`).bind(300).run();
    expect(one.meta.rows_read).toBeLessThan(10);

    const inbox = await env.DB.prepare(`WITH ${RESOLVED_CTE} SELECT count(*) AS n FROM resolved r WHERE ${INBOX}`).run<{ n: number }>();
    expect(inbox.results[0]!.n).toBe(600 - 155);
    // A few rows per transaction to sort; matching every merchant against every rule cost ~13k.
    expect(inbox.meta.rows_read).toBeLessThan(5 * 445);
  });
});

describe("normalizePattern", () => {
  it.each(["  Synthetic CAFE  ", "CAFÉ Nero", "\tTabbed SHOP\t", "ÄBC Straße", "  ", "MiXeD 123 _%"])(
    "agrees with SQLite's lower(trim(x)) for %j",
    async (text) => {
      const sqlite = await env.DB.prepare("SELECT lower(trim(?1)) AS v").bind(text).first<{ v: string }>();
      expect(normalizePattern(text)).toBe(sqlite!.v);
    },
  );
});
