import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { CountingDb } from "../../src/worker/importer/db";
import { claimLock, releaseLock } from "../../src/worker/importer/lock";
import { insertRun, resetDb } from "../db";

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

describe("import lock", () => {
  const NOW = new Date("2026-10-02T12:00:00.000Z");

  it("is claimed by the first run and refused to the second", async () => {
    const db = new CountingDb(env.DB, 40);
    const [a, b] = [await insertRun(), await insertRun()];
    expect(await claimLock(db, a, NOW)).toBe(true);
    expect(await claimLock(db, b, NOW)).toBe(false);
  });

  it("is a 10 minute lease: free again once it expires", async () => {
    const db = new CountingDb(env.DB, 40);
    const [a, b] = [await insertRun(), await insertRun()];
    await claimLock(db, a, NOW);
    expect(await claimLock(db, b, new Date(NOW.getTime() + 9 * 60_000))).toBe(false);
    expect(await claimLock(db, b, new Date(NOW.getTime() + 10 * 60_000 + 1))).toBe(true);
  });

  it("takes a shorter lease when the run passes one", async () => {
    const db = new CountingDb(env.DB, 40);
    const [a, b] = [await insertRun(), await insertRun()];
    await claimLock(db, a, NOW, 55_000);
    expect(await claimLock(db, b, new Date(NOW.getTime() + 55_001))).toBe(true);
  });

  it("is released only by its holder", async () => {
    const db = new CountingDb(env.DB, 40);
    const [a, b] = [await insertRun(), await insertRun()];
    await claimLock(db, a, NOW);
    await db.run(releaseLock(db, b));
    expect(await claimLock(db, b, NOW)).toBe(false);
    await db.run(releaseLock(db, a));
    expect(await claimLock(db, b, NOW)).toBe(true);
  });
});
