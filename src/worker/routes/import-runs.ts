import { asc, desc, eq, inArray, ne, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { importRunAccounts, importRuns } from "../db/schema";
import { runImport, type RunDeps } from "../importer";
import { limitParam, parseQuery } from "./query";

const MIN_INTERVAL_MS = 60_000;

/** The latest `limit` runs, or the one run `id`, newest first, each with its per-account rows. */
async function loadRuns(d1: D1Database, by: { limit: number } | { id: number }) {
  const db = drizzle(d1);
  const isWanted = (col: SQLiteColumn): SQL =>
    "id" in by
      ? eq(col, by.id)
      : inArray(col, db.select({ id: importRuns.id }).from(importRuns).orderBy(desc(importRuns.id)).limit(by.limit));
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
      return c.json({ runs: await loadRuns(c.env.DB, { limit: q.data.limit }) });
    })
    .post("/", async (c) => {
      // Any run (cron included) inside the last minute means Lunch Flow's cached data can't have moved.
      // A tap that only hit the lock imported nothing, so it doesn't count.
      const now = (deps.now ?? (() => new Date()))();
      const last = await drizzle(c.env.DB)
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

      // Provider and per-account failures are recorded in the run, not raised as HTTP errors.
      const pending = runImport(c.env, "manual", { ...deps, now: () => now });
      // If the phone disconnects mid-import, keep running so the run is closed and the lease released.
      c.executionCtx.waitUntil(pending);
      const summary = await pending;
      const [run] = await loadRuns(c.env.DB, { id: summary.runId });
      if (summary.status === "skipped_locked") return c.json({ error: "import_running", run }, 409);
      return c.json({ run });
    });
}
