import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { CATEGORY_KINDS, MATCH_TYPES } from "../src/worker/db/schema";
import { insertAccount, insertRun, insertTransaction, NOW, resetDb } from "./db";

// The Phase 2 tables (categories, rules, overrides, budgets), exercised with raw SQL like
// schema.spec.ts, so the CHECKs hold whatever writes to them. All values are synthetic.

const insertCategory = (name: unknown, kind: unknown = "budgeted") =>
  env.DB.prepare("INSERT INTO categories (name, kind, created_at, updated_at) VALUES (?1, ?2, ?3, ?3) RETURNING id")
    .bind(name, kind, NOW)
    .first<{ id: number }>()
    .then((row) => row!.id);

const insertRule = (matchType: unknown, pattern: string, accountId: number | null, categoryId: number) =>
  env.DB.prepare(
    `INSERT INTO merchant_rules (match_type, pattern, account_id, category_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  )
    .bind(matchType, pattern, accountId, categoryId, NOW)
    .run();

const insertOverride = (transactionId: number, fields: Record<string, unknown> = {}) => {
  const columns = ["transaction_id", "updated_at", ...Object.keys(fields)];
  const placeholders = columns.map((_, i) => `?${i + 1}`).join(", ");
  return env.DB.prepare(`INSERT INTO transaction_overrides (${columns.join(", ")}) VALUES (${placeholders})`)
    .bind(transactionId, NOW, ...Object.values(fields))
    .run();
};

const insertMonthlyBudget = (effectiveMonth: unknown, amountMinor: unknown) =>
  env.DB.prepare("INSERT INTO monthly_budgets (effective_month, amount_minor, updated_at) VALUES (?1, ?2, ?3)")
    .bind(effectiveMonth, amountMinor, NOW)
    .run();

const insertCategoryBudget = (categoryId: number, effectiveMonth: unknown, amountMinor: unknown) =>
  env.DB.prepare(
    "INSERT INTO category_budgets (category_id, effective_month, amount_minor, updated_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(categoryId, effectiveMonth, amountMinor, NOW)
    .run();

describe("phase 2 schema", () => {
  let accountId: number;
  let transactionId: number;
  let categoryId: number;

  beforeEach(async () => {
    await resetDb();
    accountId = await insertAccount();
    const runId = await insertRun();
    transactionId = await insertTransaction(accountId, runId, "t1");
    categoryId = await insertCategory("Synthetic category");
  });

  describe("categories", () => {
    it.each(["Budgeted", "income", ""])("rejects kind %j", async (kind) => {
      await expect(insertCategory("Another category", kind)).rejects.toThrow(/CHECK/);
    });

    it("accepts every documented kind", async () => {
      for (const kind of CATEGORY_KINDS) {
        await expect(insertCategory(`Kind ${kind}`, kind)).resolves.toBeTypeOf("number");
      }
    });

    it("rejects a name that differs from an existing one only by case", async () => {
      await expect(insertCategory("synthetic CATEGORY")).rejects.toThrow(/UNIQUE/);
    });

    it.each(["", " Padded", "Padded "])("rejects the empty or untrimmed name %j", async (name) => {
      await expect(insertCategory(name)).rejects.toThrow(/CHECK/);
    });

    it("finds a category by name in any case with a plain equality", async () => {
      const row = await env.DB.prepare("SELECT id FROM categories WHERE name = ?1").bind("SYNTHETIC category").first();
      expect(row).toEqual({ id: categoryId });
    });
  });

  describe("merchant_rules", () => {
    it.each(["regex", "Exact"])("rejects match_type %j", async (matchType) => {
      await expect(insertRule(matchType, "abc", null, categoryId)).rejects.toThrow(/CHECK/);
    });

    it("accepts every documented match type", async () => {
      for (const matchType of MATCH_TYPES) {
        await expect(insertRule(matchType, "abc", null, categoryId)).resolves.toBeDefined();
      }
    });

    it("rejects a second any-account rule with the same match type and pattern", async () => {
      await insertRule("exact", "abc", null, categoryId);
      await expect(insertRule("exact", "abc", null, categoryId)).rejects.toThrow(/UNIQUE/);
    });

    it("rejects a second rule with the same match type and pattern for the same account", async () => {
      await insertRule("exact", "abc", accountId, categoryId);
      await expect(insertRule("exact", "abc", accountId, categoryId)).rejects.toThrow(/UNIQUE/);
    });

    it("allows the same pattern once for any account and once scoped to an account", async () => {
      await insertRule("exact", "abc", null, categoryId);
      await expect(insertRule("exact", "abc", accountId, categoryId)).resolves.toBeDefined();
    });

    // An empty contains pattern would match every merchant.
    it.each(["", "Abc", " abc", "abc "])("rejects the empty or unnormalised pattern %j", async (pattern) => {
      await expect(insertRule("contains", pattern, null, categoryId)).rejects.toThrow(/CHECK/);
    });

    it.each([
      ["any-account", () => null],
      ["account-scoped", () => accountId],
    ])("upserts an %s rule on its match type, pattern and account scope", async (_, scope) => {
      const otherCategoryId = await insertCategory("Other synthetic category");
      const upsert = (catId: number) =>
        env.DB.prepare(
          `INSERT INTO merchant_rules (match_type, pattern, account_id, category_id, created_at, updated_at)
           VALUES ('exact', 'abc', ?1, ?2, ?3, ?3)
           ON CONFLICT (match_type, pattern, account_scope) DO UPDATE SET category_id = excluded.category_id`,
        )
          .bind(scope(), catId, NOW)
          .run();
      await upsert(categoryId);
      await upsert(otherCategoryId);
      const { results } = await env.DB.prepare("SELECT category_id FROM merchant_rules").all();
      expect(results).toEqual([{ category_id: otherCategoryId }]);
    });

    it("rejects an unknown category or account", async () => {
      await expect(insertRule("exact", "abc", null, 9999)).rejects.toThrow(/FOREIGN KEY/);
      await expect(insertRule("exact", "abc", 9999, categoryId)).rejects.toThrow(/FOREIGN KEY/);
    });
  });

  describe("transaction_overrides", () => {
    it("defaults to not excluded, with every other field following the bank", async () => {
      await insertOverride(transactionId);
      const row = await env.DB.prepare(
        "SELECT category_id, excluded, counted_amount_minor, counted_date, note FROM transaction_overrides",
      ).first();
      expect(row).toEqual({ category_id: null, excluded: 0, counted_amount_minor: null, counted_date: null, note: null });
    });

    it.each([2, "true"])("rejects excluded %j", async (excluded) => {
      await expect(insertOverride(transactionId, { excluded })).rejects.toThrow(/CHECK/);
    });

    it.each([12.5, "-12.30"])("rejects counted_amount_minor %j", async (value) => {
      await expect(insertOverride(transactionId, { counted_amount_minor: value })).rejects.toThrow(/CHECK/);
    });

    it.each(["2026-02-30", "2026-9-1", "2026-10-01T00:00:00Z"])("rejects counted_date %j", async (value) => {
      await expect(insertOverride(transactionId, { counted_date: value })).rejects.toThrow(/CHECK/);
    });

    it.each([["ASCII", "a"], ["non-ASCII", "é"]])("accepts a 500-character %s note", async (_, char) => {
      await expect(insertOverride(transactionId, { note: char.repeat(500) })).resolves.toBeDefined();
    });

    it("rejects a 501-character note", async () => {
      await expect(insertOverride(transactionId, { note: "a".repeat(501) })).rejects.toThrow(/CHECK/);
    });

    it("rejects a note that isn't text", async () => {
      await expect(insertOverride(transactionId, { note: new Uint8Array([104, 105]).buffer })).rejects.toThrow(/CHECK/);
    });

    it("rejects a second override for the same transaction", async () => {
      await insertOverride(transactionId);
      await expect(insertOverride(transactionId)).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    });

    it("rejects an unknown transaction or category", async () => {
      await expect(insertOverride(9999)).rejects.toThrow(/FOREIGN KEY/);
      await expect(insertOverride(transactionId, { category_id: 9999 })).rejects.toThrow(/FOREIGN KEY/);
    });
  });

  describe("monthly_budgets", () => {
    it("accepts a YYYY-MM month with a positive integer amount", async () => {
      await expect(insertMonthlyBudget("2026-10", 150000)).resolves.toBeDefined();
    });

    it.each(["2026-13", "2026-1", "2026-10-01", 202610, "2026-00"])("rejects effective_month %j", async (month) => {
      await expect(insertMonthlyBudget(month, 150000)).rejects.toThrow(/CHECK/);
    });

    it.each([0, -100, 12.5, "-12.30"])("rejects amount_minor %j", async (amount) => {
      await expect(insertMonthlyBudget("2026-10", amount)).rejects.toThrow(/CHECK/);
    });

    it("rejects a second row for the same month", async () => {
      await insertMonthlyBudget("2026-10", 150000);
      await expect(insertMonthlyBudget("2026-10", 160000)).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    });
  });

  describe("category_budgets", () => {
    it("accepts a zero allocation, which removes it from that month on", async () => {
      await expect(insertCategoryBudget(categoryId, "2026-10", 0)).resolves.toBeDefined();
    });

    it.each([-1, 1.5])("rejects amount_minor %j", async (amount) => {
      await expect(insertCategoryBudget(categoryId, "2026-10", amount)).rejects.toThrow(/CHECK/);
    });

    it.each(["2026-13", "2026-10-01"])("rejects effective_month %j", async (month) => {
      await expect(insertCategoryBudget(categoryId, month, 100)).rejects.toThrow(/CHECK/);
    });

    it("rejects a second allocation for the same category and month", async () => {
      await insertCategoryBudget(categoryId, "2026-10", 100);
      await expect(insertCategoryBudget(categoryId, "2026-10", 200)).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    });

    it("rejects an unknown category", async () => {
      await expect(insertCategoryBudget(9999, "2026-10", 100)).rejects.toThrow(/FOREIGN KEY/);
    });
  });
});

describe("category seed", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("ships the spec's 14 starting categories, unarchived, in order", async () => {
    const { results } = await env.DB.prepare("SELECT name, kind, archived_at FROM categories ORDER BY id").all();
    const seeded = (kind: string, names: string[]) => names.map((name) => ({ name, kind, archived_at: null }));
    expect(results).toEqual([
      ...seeded("budgeted", ["Groceries", "Eating out", "Transport", "Bills", "Shopping", "Entertainment", "Health", "Other"]),
      ...seeded("tracked", ["Clothes", "Travel"]),
      ...seeded("excluded", ["Savings", "Investments", "Card repayment", "Income"]),
    ]);
  });

  it("stamps the seeded rows with ISO-8601 UTC timestamps", async () => {
    const { results } = await env.DB.prepare("SELECT created_at, updated_at FROM categories").all<{
      created_at: string;
      updated_at: string;
    }>();
    expect(results).toHaveLength(14);
    for (const row of results) {
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(row.updated_at).toBe(row.created_at);
    }
  });

  it("rejects a new category that matches a seeded name in another case", async () => {
    await expect(insertCategory("groceries")).rejects.toThrow(/UNIQUE/);
  });
});
