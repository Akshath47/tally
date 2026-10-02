import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { CountingDb } from "../../src/worker/importer/db";
import { claimLock, releaseLock } from "../../src/worker/importer/lock";
import { resetDb } from "../db";

beforeEach(resetDb);

describe("CountingDb", () => {
  it("counts every executed statement, including each one inside a batch", async () => {
    const db = new CountingDb(env.DB, 40);
    await db.run(db.prepare("SELECT 1"));
    await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2"), db.prepare("SELECT 3")]);
    expect(db.statements).toBe(4);
  });

  it("refuses to execute past the budget, before touching D1", async () => {
    const db = new CountingDb(env.DB, 2);
    await db.run(db.prepare("SELECT 1"));
    await expect(db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2")])).rejects.toMatchObject({ kind: "budget" });
    expect(db.statements).toBe(1);
  });

  it("returns first() and all() rows", async () => {
    const db = new CountingDb(env.DB, 40);
    expect(await db.first<{ n: number }>(db.prepare("SELECT 5 AS n"))).toEqual({ n: 5 });
    expect((await db.all<{ n: number }>(db.prepare("SELECT 5 AS n"))).results).toEqual([{ n: 5 }]);
  });
});

async function newRun(): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO import_runs (trigger, started_at, status) VALUES ('manual', '2026-10-02T12:00:00.000Z', 'running') RETURNING id",
  ).first<{ id: number }>();
  return row!.id;
}

describe("import lock", () => {
  const NOW = new Date("2026-10-02T12:00:00.000Z");

  it("is claimed by the first run and refused to the second", async () => {
    const db = new CountingDb(env.DB, 40);
    const [a, b] = [await newRun(), await newRun()];
    expect(await claimLock(db, a, NOW)).toBe(true);
    expect(await claimLock(db, b, NOW)).toBe(false);
  });

  it("is a 10 minute lease: free again once it expires", async () => {
    const db = new CountingDb(env.DB, 40);
    const [a, b] = [await newRun(), await newRun()];
    await claimLock(db, a, NOW);
    expect(await claimLock(db, b, new Date(NOW.getTime() + 9 * 60_000))).toBe(false);
    expect(await claimLock(db, b, new Date(NOW.getTime() + 10 * 60_000 + 1))).toBe(true);
  });

  it("is released only by its holder", async () => {
    const db = new CountingDb(env.DB, 40);
    const [a, b] = [await newRun(), await newRun()];
    await claimLock(db, a, NOW);
    await releaseLock(db, b);
    expect(await claimLock(db, b, NOW)).toBe(false);
    await releaseLock(db, a);
    expect(await claimLock(db, b, NOW)).toBe(true);
  });
});
