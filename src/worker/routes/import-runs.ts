import { asc, desc, inArray, ne, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { importRunAccounts, importRuns } from "../db/schema";
import { startImport, type RunDeps } from "../importer";
import { limitParam, parseQuery } from "./query";

const MIN_INTERVAL_MS = 60_000;
// waitUntil allows 30 s after the response; leave room to write and close the run.
const MANUAL_BUDGET_MS = 25_000;

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
      const now = (deps.now ?? (() => new Date()))();

      // Any run (cron included) inside the last minute means Lunch Flow's cached data can't have moved.
      // A tap that only hit the lock imported nothing, so it doesn't count.
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

      // The run row and the lease claim happen before answering, so a poll straight after sees
      // the run. The import itself carries on in waitUntil, so the phone can leave or close the
      // app. A run cut off anyway is marked abandoned by a later run.
      const started = await startImport(c.env, "manual", { ...deps, now: () => now, budgetMs: MANUAL_BUDGET_MS });
      c.executionCtx.waitUntil(
        started.finished.catch((e: unknown) => {
          console.error(JSON.stringify({ event: "import_run_unclosed", runId: started.runId, name: e instanceof Error ? e.name : "unknown" }));
        }),
      );
      if (!started.locked) return c.json({ error: "import_running" }, 409);
      return c.json({ status: "started", runId: started.runId }, 202);
    });
}
