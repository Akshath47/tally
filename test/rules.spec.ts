import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker";
import { RESOLVED_CTE } from "../src/worker/budget/resolve";
import { resetDb } from "./db";
import { SEEDED, insertOverride, ledger } from "./budget/helpers";

// Requests go to localhost, where the local-dev auth bypass applies. All data is synthetic.

const ORIGIN = "http://localhost";
const app = createApp();
type Rule = { id: number; matchType: string; pattern: string; accountId: number | null; categoryId: number; transactionCount?: number };

const send = (method: string, path: string, body?: unknown) =>
  app.request(
    `${ORIGIN}${path}`,
    { method, headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
const list = async () => ((await (await app.request(`${ORIGIN}/api/rules`, {}, env)).json()) as { rules: Rule[] }).rules;
const create = (body: unknown) => send("POST", "/api/rules", body);
const createdRule = async (body: unknown) => ((await (await create(body)).json()) as { rule: Rule }).rule;
const categoryOf = async (id: number) =>
  (await env.DB.prepare(`WITH ${RESOLVED_CTE} SELECT category_id FROM resolved WHERE id = ?1`).bind(id).first<{ category_id: number | null }>())!.category_id;

let L: Awaited<ReturnType<typeof ledger>>;
let a1: number;

beforeEach(async () => {
  await resetDb();
  L = await ledger();
  [a1] = L.accounts;
});

describe("POST /api/rules", () => {
  it("creates a rule with its pattern normalised", async () => {
    const res = await create({ matchType: "exact", pattern: "  Synthetic CAFE ", categoryId: SEEDED.eatingOut });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { rule: Rule }).rule).toEqual({
      id: 1, matchType: "exact", pattern: "synthetic cafe", accountId: null, categoryId: SEEDED.eatingOut,
    });
  });

  it("refuses a duplicate, including a second any-account rule", async () => {
    await create({ matchType: "contains", pattern: "cafe", categoryId: SEEDED.eatingOut });
    const res = await create({ matchType: "contains", pattern: " CAFE", categoryId: SEEDED.other });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "rule_exists" });
    // The same pattern scoped to an account is a different rule.
    expect((await create({ matchType: "contains", pattern: "cafe", accountId: a1, categoryId: SEEDED.other })).status).toBe(201);
  });

  it("refuses an archived category", async () => {
    await env.DB.prepare("UPDATE categories SET archived_at = '2026-10-01T00:00:00.000Z' WHERE id = ?1").bind(SEEDED.other).run();
    const res = await create({ matchType: "exact", pattern: "x", categoryId: SEEDED.other });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "category_archived" });
  });

  it("returns 404 for an unknown category, an unknown account or a merged one", async () => {
    expect((await create({ matchType: "exact", pattern: "x", categoryId: 999 })).status).toBe(404);
    expect((await create({ matchType: "exact", pattern: "x", accountId: 999, categoryId: SEEDED.other })).status).toBe(404);
    const [, a2] = L.accounts;
    await env.DB.prepare("UPDATE accounts SET merged_into_account_id = ?1 WHERE id = ?2").bind(a1, a2).run();
    expect((await create({ matchType: "exact", pattern: "x", accountId: a2, categoryId: SEEDED.other })).status).toBe(404);
  });

  it.each([
    { matchType: "exact", pattern: "   ", categoryId: 1 },
    { matchType: "exact", pattern: "x".repeat(101), categoryId: 1 },
    { matchType: "starts_with", pattern: "x", categoryId: 1 },
    { matchType: "exact", categoryId: 1 },
    { matchType: "exact", pattern: "x", categoryId: "1" },
    { matchType: "exact", pattern: "x", accountId: 0, categoryId: 1 },
  ])("rejects %j", async (body) => {
    expect((await create(body)).status).toBe(400);
  });
});

describe("GET /api/rules", () => {
  it("counts the transactions each rule decides, leaving out vanished and overridden ones", async () => {
    await L.txn(a1, { merchant: "Synthetic Cafe" });
    await L.txn(a1, { merchant: "Synthetic Cafe", isPending: true });
    await L.txn(a1, { merchant: "Synthetic Cafe", vanished: true });
    const overridden = await L.txn(a1, { merchant: "Synthetic Cafe" });
    await insertOverride(overridden, { category_id: SEEDED.shopping });
    // Only an excluded flag: the rule still decides the category.
    const excluded = await L.txn(a1, { merchant: "Synthetic Cafe" });
    await insertOverride(excluded, { excluded: 1 });
    await L.txn(a1, { merchant: "Synthetic Cafe Bar" });

    const exact = await createdRule({ matchType: "exact", pattern: "synthetic cafe", categoryId: SEEDED.eatingOut });
    const contains = await createdRule({ matchType: "contains", pattern: "cafe", categoryId: SEEDED.other });
    const unused = await createdRule({ matchType: "exact", pattern: "nothing here", categoryId: SEEDED.other });

    expect((await list()).map((r) => [r.id, r.transactionCount])).toEqual([
      [exact.id, 3],
      [contains.id, 1],
      [unused.id, 0],
    ]);
  });
});

describe("PATCH /api/rules/:id", () => {
  it("moves the rule's transactions to its new category", async () => {
    const t = await L.txn(a1, { merchant: "Synthetic Cafe" });
    const rule = await createdRule({ matchType: "exact", pattern: "synthetic cafe", categoryId: SEEDED.eatingOut });
    const res = await send("PATCH", `/api/rules/${rule.id}`, { categoryId: SEEDED.groceries });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rule: Rule }).rule).toMatchObject({ categoryId: SEEDED.groceries, pattern: "synthetic cafe" });
    expect(await categoryOf(t)).toBe(SEEDED.groceries);
  });

  it("changes the pattern and scope, and can clear the scope again", async () => {
    const rule = await createdRule({ matchType: "exact", pattern: "a", accountId: a1, categoryId: SEEDED.other });
    let res = await send("PATCH", `/api/rules/${rule.id}`, { matchType: "contains", pattern: " B " });
    expect(((await res.json()) as { rule: Rule }).rule).toMatchObject({ matchType: "contains", pattern: "b", accountId: a1 });
    res = await send("PATCH", `/api/rules/${rule.id}`, { accountId: null });
    expect(((await res.json()) as { rule: Rule }).rule.accountId).toBeNull();
  });

  it("refuses a change that duplicates another rule", async () => {
    await create({ matchType: "exact", pattern: "a", categoryId: SEEDED.other });
    const b = await createdRule({ matchType: "exact", pattern: "b", categoryId: SEEDED.other });
    const res = await send("PATCH", `/api/rules/${b.id}`, { pattern: "A" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "rule_exists" });
  });

  it("returns 404 for an unknown rule or category, and 400 for an empty change", async () => {
    const rule = await createdRule({ matchType: "exact", pattern: "a", categoryId: SEEDED.other });
    expect((await send("PATCH", "/api/rules/999", { pattern: "x" })).status).toBe(404);
    expect((await send("PATCH", `/api/rules/${rule.id}`, { categoryId: 999 })).status).toBe(404);
    expect((await send("PATCH", `/api/rules/${rule.id}`, {})).status).toBe(400);
  });
});

describe("DELETE /api/rules/:id", () => {
  it("returns the rule's transactions to uncategorised", async () => {
    const t = await L.txn(a1, { merchant: "Synthetic Cafe" });
    const rule = await createdRule({ matchType: "exact", pattern: "synthetic cafe", categoryId: SEEDED.eatingOut });
    const res = await send("DELETE", `/api/rules/${rule.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await categoryOf(t)).toBeNull();
    expect((await send("DELETE", `/api/rules/${rule.id}`)).status).toBe(404);
  });
});
