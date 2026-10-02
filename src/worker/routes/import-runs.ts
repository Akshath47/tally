import { and, asc, desc, gte, inArray, isNotNull, ne, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { importLock, importRunAccounts, importRuns } from "../db/schema";
import { runImport, type RunDeps } from "../importer";
import { limitParam, parseQuery } from "./query";

const MIN_INTERVAL_MS = 60_000;

/** The latest `limit` runs, newest first, each with its per-account rows. */
async function loadRuns(d1: D1Database, limit: number) {
  const db = drizzle(d1);
  const isWanted = (col: SQLiteColumn): SQL =>
    inArray(col, db.select({ id: importRuns.id }).from(importRuns).orderBy(desc(importRuns.id)).limit(limit));
  const [runs, accounts] = await db.batch([
    db.select().from(importRuns).where(isWanted(importRuns.id)).orderBy(desc(importRuns.id)),
    db.select().from(importRunAccounts).where(isWanted(importRunAccounts.runId)).orderBy(asc(importRunAccounts.accountId)),
  ]);
  return runs.map((run) => ({ ...run, accounts: accounts.filter((a) => a.runId === run.id) }));
}

export function importRunRoutes(deps: RunDeps) {
  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const q = parseQuery(c, z.object({ limit: limitParam(50, 20) }));
      if (!q.ok) return q.res;
      return c.json({ runs: await loadRuns(c.env.DB, q.data.limit) });
    })
    .post("/", async (c) => {
      const db = drizzle(c.env.DB);
      const now = (deps.now ?? (() => new Date()))();

      // Any run (cron included) inside the last minute means Lunch Flow's cached data can't have moved.
      // A tap that only hit the lock imported nothing, so it doesn't count.
      const last = await db
        .select({ startedAt: importRuns.startedAt })
        .from(importRuns)
        .where(ne(importRuns.status, "skipped_locked"))
        .orderBy(desc(importRuns.id))
        .get();
      const waitMs = last ? Date.parse(last.startedAt) + MIN_INTERVAL_MS - now.getTime() : 0;
      if (waitMs > 0) {
        const retryAfterSeconds = Math.ceil(waitMs / 1000);
        c.header("Retry-After", String(retryAfterSeconds));
        return c.json({ error: "rate_limited", retryAfterSeconds }, 429);
      }

      // The inverse of claimLock's condition. If a cron run claims the lock between this check
      // and ours, our run records itself as skipped_locked, which the UI sees when it polls.
      const held = await db
        .select({ id: importLock.id })
        .from(importLock)
        .where(and(isNotNull(importLock.holderRunId), gte(importLock.expiresAt, now.toISOString())))
        .get();
      if (held) return c.json({ error: "import_running" }, 409);

      // Answer now and import in the background, so the phone can leave or close the app.
      // waitUntil keeps the Worker alive for up to 30 s after the response; a run cut off
      // past that is marked abandoned by the next run. Failures are recorded in the run.
      c.executionCtx.waitUntil(runImport(c.env, "manual", { ...deps, now: () => now }));
      return c.json({ status: "started" }, 202);
    });
}
