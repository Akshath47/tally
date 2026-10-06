import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { runImport } from "../../src/worker/importer";
import { MATCHES_DRIFT_SQL, MATCH_TRIGGERS_SQL, REBUILD_MATCHES_SQL } from "../../src/worker/budget/matches";
import { NOW, resetDb } from "../db";
import { AMEX, REVOLUT, txn, world } from "../fixtures/lunchflow";
import { SEEDED, insertRule, ledger } from "./helpers";

// Stored merchant matches, kept current by triggers (src/worker/budget/matches.ts). All data
// is synthetic.

const matchOf = async (accountId: number, merchant: string) =>
  (await env.DB.prepare("SELECT rule_id FROM merchant_matches WHERE account_id = ?1 AND merchant = ?2")
    .bind(accountId, merchant)
    .first<{ rule_id: number | null }>()) ?? "missing";

const drift = async () => (await env.DB.prepare(MATCHES_DRIFT_SQL).first<{ n: number }>())!.n;

const matchCount = async () => (await env.DB.prepare("SELECT count(*) AS n FROM merchant_matches").first<{ n: number }>())!.n;

// Comments and statement breakpoints dropped, and the trailing semicolon.
const statementOf = (query: string) =>
  query
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .trim()
    .replace(/;$/, "");

let L: Awaited<ReturnType<typeof ledger>>;
let a1: number;
let a2: number;

beforeEach(async () => {
  await resetDb();
  L = await ledger();
  [a1, a2] = L.accounts;
});

describe("the migration", () => {
  it("is the fill and the triggers from matches.ts, verbatim", () => {
    const migration = inject("migrations").find((m) => m.name.startsWith("0007_"))!;
    expect(migration.queries.map(statementOf)).toEqual([REBUILD_MATCHES_SQL, ...MATCH_TRIGGERS_SQL]);
  });

  it("leaves every trigger in place after all migrations", async () => {
    // A later migration that rebuilds transactions or merchant_rules would drop them silently.
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "merchant_matches_rule_delete",
      "merchant_matches_rule_insert",
      "merchant_matches_rule_update",
      "merchant_matches_transaction_insert",
      "merchant_matches_transaction_update",
    ]);
  });
});

describe("transaction triggers", () => {
  it("match a new merchant when its first transaction arrives", async () => {
    const rule = await insertRule("exact", "synthetic cafe", SEEDED.eatingOut);
    await L.txn(a1, { merchant: "Synthetic Cafe" });
    await L.txn(a1, { merchant: "Unmatched Shop" });
    expect(await matchOf(a1, "Synthetic Cafe")).toEqual({ rule_id: rule });
    expect(await matchOf(a1, "Unmatched Shop")).toEqual({ rule_id: null });
  });

  it("keep one row per account and merchant", async () => {
    await L.txn(a1, { merchant: "Synthetic Cafe" });
    await L.txn(a1, { merchant: "Synthetic Cafe" });
    await L.txn(a2, { merchant: "Synthetic Cafe" });
    expect(await matchCount()).toBe(2);
  });

  it("match the new merchant text when an upsert changes it", async () => {
    const rule = await insertRule("contains", "grocer", SEEDED.groceries);
    const id = await L.txn(a1, { merchant: "PENDING CARD TXN" });
    await env.DB.prepare("UPDATE transactions SET merchant = 'Synthetic Grocer', updated_at = ?2 WHERE id = ?1").bind(id, NOW).run();
    expect(await matchOf(a1, "Synthetic Grocer")).toEqual({ rule_id: rule });
    // The old text's row stays; nothing is deleted, and it's harmless.
    expect(await matchOf(a1, "PENDING CARD TXN")).toEqual({ rule_id: null });
  });
});

describe("the importer", () => {
  it("leaves every imported merchant matched, a posted rename included", async () => {
    await resetDb();
    const rule = await insertRule("contains", "grocer", SEEDED.groceries);
    const w = world([REVOLUT, AMEX]);
    w.txns[1] = [txn(1, "r1", { merchant: "Synthetic Grocer", date: "2026-10-01" }), txn(1, "r2", { merchant: "CARD TXN", isPending: true })];
    w.txns[2] = [txn(2, "a1", { merchant: "Synthetic Cafe", date: "2026-09-30" })];
    let minute = 0;
    const run = () =>
      runImport({ DB: env.DB, LUNCHFLOW_API_KEY: "test-key", BACKFILL_DAYS: "20" }, "manual", {
        fetch: w.fetch,
        now: () => new Date(Date.parse("2026-10-02T12:00:00.000Z") + minute++ * 60_000),
        sleep: async () => {},
      });
    expect((await run()).status).toBe("success");
    // The pending row posts under the same id with new merchant text.
    w.txns[1]![1] = txn(1, "r2", { merchant: "Synthetic Grocer Ltd" });
    expect((await run()).status).toBe("success");
    expect(await drift()).toBe(0);
    expect(await matchOf(1, "Synthetic Grocer Ltd")).toEqual({ rule_id: rule });
  });
});

describe("rule triggers", () => {
  it("re-match the merchants a new exact rule names, in its scope only", async () => {
    await L.txn(a1, { merchant: "  Synthetic CAFE " });
    await L.txn(a2, { merchant: "Synthetic Cafe" });
    const scoped = await insertRule("exact", "synthetic cafe", SEEDED.eatingOut, a1);
    expect(await matchOf(a1, "  Synthetic CAFE ")).toEqual({ rule_id: scoped });
    expect(await matchOf(a2, "Synthetic Cafe")).toEqual({ rule_id: null });
  });

  it("re-match the merchants a new contains rule matches, keeping better matches", async () => {
    await L.txn(a1, { merchant: "Synthetic Cafe Bar" });
    await L.txn(a1, { merchant: "Synthetic Cafe" });
    const exact = await insertRule("exact", "synthetic cafe", SEEDED.groceries);
    const contains = await insertRule("contains", "cafe", SEEDED.eatingOut);
    expect(await matchOf(a1, "Synthetic Cafe Bar")).toEqual({ rule_id: contains });
    expect(await matchOf(a1, "Synthetic Cafe")).toEqual({ rule_id: exact });
  });

  it("re-match when a rule's pattern, type or scope changes", async () => {
    await L.txn(a1, { merchant: "Synthetic Cafe" });
    await L.txn(a1, { merchant: "Synthetic Deli" });
    const rule = await insertRule("exact", "synthetic cafe", SEEDED.eatingOut);
    await env.DB.prepare("UPDATE merchant_rules SET pattern = 'synthetic deli' WHERE id = ?1").bind(rule).run();
    expect(await matchOf(a1, "Synthetic Cafe")).toEqual({ rule_id: null });
    expect(await matchOf(a1, "Synthetic Deli")).toEqual({ rule_id: rule });

    await env.DB.prepare("UPDATE merchant_rules SET match_type = 'contains', pattern = 'synthetic' WHERE id = ?1").bind(rule).run();
    expect(await matchOf(a1, "Synthetic Cafe")).toEqual({ rule_id: rule });

    await env.DB.prepare("UPDATE merchant_rules SET account_id = ?2 WHERE id = ?1").bind(rule, a2).run();
    expect(await matchOf(a1, "Synthetic Cafe")).toEqual({ rule_id: null });
  });

  it("leave matches alone when only a rule's category changes", async () => {
    await L.txn(a1, { merchant: "Synthetic Cafe" });
    const rule = await insertRule("exact", "synthetic cafe", SEEDED.eatingOut);
    const res = await env.DB.prepare("UPDATE merchant_rules SET category_id = ?2 WHERE id = ?1").bind(rule, SEEDED.groceries).run();
    // The rule row only: the trigger's WHEN skips it.
    expect(res.meta.rows_written).toBeLessThanOrEqual(2);
    expect(await matchOf(a1, "Synthetic Cafe")).toEqual({ rule_id: rule });
  });

  it("fall back to the next best rule when the matched one is deleted", async () => {
    await L.txn(a1, { merchant: "Synthetic Cafe" });
    const contains = await insertRule("contains", "cafe", SEEDED.other);
    const exact = await insertRule("exact", "synthetic cafe", SEEDED.eatingOut);
    expect(await matchOf(a1, "Synthetic Cafe")).toEqual({ rule_id: exact });
    await env.DB.prepare("DELETE FROM merchant_rules WHERE id = ?1").bind(exact).run();
    expect(await matchOf(a1, "Synthetic Cafe")).toEqual({ rule_id: contains });
    await env.DB.prepare("DELETE FROM merchant_rules WHERE id = ?1").bind(contains).run();
    expect(await matchOf(a1, "Synthetic Cafe")).toEqual({ rule_id: null });
  });

  it("re-match only the named merchants for an exact rule, not every merchant", async () => {
    for (let i = 0; i < 50; i++) await L.txn(a1, { merchant: `Synthetic Merchant ${i}` });
    const res = await env.DB.prepare(
      "INSERT INTO merchant_rules (match_type, pattern, category_id, created_at, updated_at) VALUES ('exact', 'synthetic merchant 7', ?1, ?2, ?2)",
    )
      .bind(SEEDED.other, NOW)
      .run();
    expect(res.meta.rows_read).toBeLessThan(50);
  });
});

describe("rebuild and drift", () => {
  it("rebuild restores matches that were tampered with", async () => {
    await L.txn(a1, { merchant: "Synthetic Cafe" });
    await insertRule("exact", "synthetic cafe", SEEDED.eatingOut);
    await env.DB.prepare("UPDATE merchant_matches SET rule_id = NULL").run();
    expect(await drift()).toBe(1);
    await env.DB.prepare(REBUILD_MATCHES_SQL).run();
    expect(await drift()).toBe(0);
  });

  it("counts a transaction whose merchant has no match row", async () => {
    await L.txn(a1, { merchant: "Synthetic Cafe" });
    await env.DB.prepare("DELETE FROM merchant_matches").run();
    expect(await drift()).toBe(1);
  });

  // The oracle is MATCHES_DRIFT_SQL itself: it matches every merchant from scratch with the
  // precedence the old read-time CTE used, so any trigger that misses a case shows as drift.
  it("never drifts across random rule and transaction changes", async () => {
    // mulberry32: deterministic, and well mixed in every bit.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * n);
    };
    const words = ["ab", "abc", "bc", "cd", "abcd", "b c", "AB", " ab "];
    const merchant = () => `${words[rand(words.length)]} ${words[rand(words.length)]}`;
    const pattern = () => words[rand(4)]!.toLowerCase().trim() + (rand(2) ? " " + words[rand(4)]!.toLowerCase().trim() : "");
    const accountOf = () => [a1, a2, null][rand(3)] ?? null;
    const ids: number[] = [];
    const seen = new Set<string>();

    for (let step = 0; step < 300; step++) {
      // Rule edits and deletes need a rule; until there is one they add a rule instead.
      const op = ids.length === 0 && rand(8) >= 4 ? 3 : rand(8);
      if (op === 0 || op === 1) {
        await L.txn(rand(2) ? a1 : a2, { merchant: merchant() });
      } else if (op === 2) {
        const id = (await env.DB.prepare("SELECT id FROM transactions ORDER BY random() LIMIT 1").first<{ id: number }>())!.id;
        await env.DB.prepare("UPDATE transactions SET merchant = ?2 WHERE id = ?1").bind(id, merchant()).run();
      } else if (op === 3 || op === 6 || ids.length === 0) {
        const row = await env.DB.prepare(
          `INSERT INTO merchant_rules (match_type, pattern, account_id, category_id, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT DO NOTHING RETURNING id`,
        )
          .bind(rand(2) ? "exact" : "contains", pattern(), accountOf(), SEEDED.other, NOW)
          .first<{ id: number }>();
        if (row) ids.push(row.id);
      } else if (op === 4 || op === 5) {
        const id = ids[rand(ids.length)]!;
        await env.DB.prepare("UPDATE OR IGNORE merchant_rules SET match_type = ?2, pattern = ?3, account_id = ?4 WHERE id = ?1")
          .bind(id, rand(2) ? "exact" : "contains", pattern(), accountOf())
          .run();
      } else {
        const [id] = ids.splice(rand(ids.length), 1);
        await env.DB.prepare("DELETE FROM merchant_rules WHERE id = ?1").bind(id).run();
      }
      expect(await drift(), `after step ${step}`).toBe(0);
      const { results } = await env.DB.prepare(
        "SELECT DISTINCT COALESCE(r.match_type, 'none') AS kind FROM merchant_matches mm LEFT JOIN merchant_rules r ON r.id = mm.rule_id",
      ).all<{ kind: string }>();
      for (const r of results) seen.add(r.kind);
    }
    // The run had merchants matched by each rule type, and unmatched ones.
    expect([...seen].sort()).toEqual(["contains", "exact", "none"]);
  });
});
