import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/worker";
import { resetDb } from "./db";
import { SEEDED } from "./budget/helpers";

// Requests go to localhost, where the local-dev auth bypass applies. All data is synthetic.

const ORIGIN = "http://localhost";
const app = createApp();
type Category = { id: number; name: string; kind: string; archived: boolean };

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(
    `${ORIGIN}${path}`,
    { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
const list = async () => ((await (await app.request(`${ORIGIN}/api/categories`, {}, env)).json()) as { categories: Category[] }).categories;
const create = (body: unknown) => send("POST", "/api/categories", body);
const patch = (id: number | string, body: unknown) => send("PATCH", `/api/categories/${id}`, body);

beforeEach(resetDb);

describe("GET /api/categories", () => {
  it("lists the seeded categories in order, with their kinds", async () => {
    const all = await list();
    expect(all).toHaveLength(14);
    expect(all[0]).toEqual({ id: SEEDED.groceries, name: "Groceries", kind: "budgeted", archived: false });
    expect(all.find((c) => c.name === "Clothes")!.kind).toBe("tracked");
    expect(all.find((c) => c.name === "Income")!.kind).toBe("excluded");
  });
});

describe("POST /api/categories", () => {
  it("creates a category with a trimmed name", async () => {
    const res = await create({ name: "  Pets ", kind: "budgeted" });
    expect(res.status).toBe(201);
    const { category } = (await res.json()) as { category: Category };
    expect(category).toEqual({ id: 15, name: "Pets", kind: "budgeted", archived: false });
    expect((await list()).at(-1)).toEqual(category);
  });

  it("refuses a name another category has, in any case", async () => {
    const res = await create({ name: "groceries", kind: "tracked" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "name_taken" });
  });

  it.each([
    { name: "Pets", kind: "monthly" },
    { name: "   ", kind: "budgeted" },
    { name: "x".repeat(51), kind: "budgeted" },
    { kind: "budgeted" },
    { name: 7, kind: "budgeted" },
  ])("rejects %j", async (body) => {
    expect((await create(body)).status).toBe(400);
  });

  it("rejects a cross-site request and a non-JSON body", async () => {
    expect((await send("POST", "/api/categories", { name: "Pets", kind: "budgeted" }, { Origin: "https://evil.example" })).status).toBe(403);
    const plain = await app.request(`${ORIGIN}/api/categories`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "text/plain" }, body: "{}" }, env);
    expect(plain.status).toBe(415);
  });
});

describe("PATCH /api/categories/:id", () => {
  it("renames a category, including to a different case of its own name", async () => {
    let res = await patch(SEEDED.groceries, { name: "Food shop" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { category: Category }).category.name).toBe("Food shop");
    res = await patch(SEEDED.groceries, { name: "FOOD SHOP" });
    expect(res.status).toBe(200);
  });

  it("refuses another category's name in any case", async () => {
    const res = await patch(SEEDED.groceries, { name: "eating OUT" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "name_taken" });
  });

  it("changes the kind", async () => {
    const res = await patch(SEEDED.shopping, { kind: "tracked" });
    expect(((await res.json()) as { category: Category }).category).toMatchObject({ kind: "tracked" });
  });

  it("archives and unarchives, keeping archived categories in the list", async () => {
    await patch(SEEDED.other, { archived: true });
    expect((await list()).find((c) => c.id === SEEDED.other)!.archived).toBe(true);
    await patch(SEEDED.other, { archived: false });
    expect((await list()).find((c) => c.id === SEEDED.other)!.archived).toBe(false);
  });

  it("keeps the archive time when archiving twice", async () => {
    await patch(SEEDED.other, { archived: true });
    const first = await env.DB.prepare("SELECT archived_at FROM categories WHERE id = ?1").bind(SEEDED.other).first();
    await patch(SEEDED.other, { archived: true, name: "Misc things" });
    expect(await env.DB.prepare("SELECT archived_at FROM categories WHERE id = ?1").bind(SEEDED.other).first()).toEqual(first);
  });

  it("returns 404 for an unknown category, and 400 for a bad id or body", async () => {
    expect((await patch(999, { name: "X" })).status).toBe(404);
    expect((await patch("abc", { name: "X" })).status).toBe(400);
    expect((await patch(SEEDED.groceries, {})).status).toBe(400);
    expect((await patch(SEEDED.groceries, { kind: "weekly" })).status).toBe(400);
    expect((await patch(SEEDED.groceries, { archived: "yes" })).status).toBe(400);
  });
});
