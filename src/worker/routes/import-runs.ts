import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { runImport, type RunDeps } from "../importer";
import { limitParam, parseQuery } from "./query";

const MIN_INTERVAL_MS = 60_000;

const RUN_COLUMNS = `id, trigger, started_at AS startedAt, finished_at AS finishedAt, status, error_summary AS errorSummary`;
const RUN_ACCOUNT_COLUMNS = `run_id AS runId, account_id AS accountId, status, http_status AS httpStatus,
  window_from AS windowFrom, window_to AS windowTo, fetched, inserted, updated, vanished_marked AS vanishedMarked,
  error, duration_ms AS durationMs`;

type RunRow = { id: number } & Record<string, unknown>;
type RunAccountRow = { runId: number } & Record<string, unknown>;

/** Runs matching `idFilter` (a subquery or literal list of ids), newest first, each with its per-account rows. */
async function loadRuns(db: D1Database, idFilter: string, ...binds: unknown[]) {
  const [runs, accounts] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT ${RUN_COLUMNS} FROM import_runs WHERE id IN (${idFilter}) ORDER BY id DESC`).bind(...binds),
    db.prepare(`SELECT ${RUN_ACCOUNT_COLUMNS} FROM import_run_accounts WHERE run_id IN (${idFilter}) ORDER BY account_id`).bind(...binds),
  ]);
  return (runs!.results as RunRow[]).map((run) => ({
    ...run,
    accounts: (accounts!.results as RunAccountRow[]).filter((a) => a.runId === run.id),
  }));
}

export function importRunRoutes(deps: RunDeps) {
  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const q = parseQuery(c, z.object({ limit: limitParam(50, 20) }));
      if (!q.ok) return q.res;
      return c.json({ runs: await loadRuns(c.env.DB, "SELECT id FROM import_runs ORDER BY id DESC LIMIT ?1", q.data.limit) });
    })
    .post("/", async (c) => {
      if (!c.req.header("Content-Type")?.startsWith("application/json")) {
        return c.json({ error: "unsupported_media_type" }, 415);
      }

      // Any run (cron included) inside the last minute means Lunch Flow's cached data can't have moved.
      const now = (deps.now ?? (() => new Date()))();
      const last = await c.env.DB.prepare("SELECT started_at FROM import_runs ORDER BY id DESC LIMIT 1").first<{ started_at: string }>();
      const waitMs = last ? Date.parse(last.started_at) + MIN_INTERVAL_MS - now.getTime() : 0;
      if (waitMs > 0) {
        const retryAfterSeconds = Math.ceil(waitMs / 1000);
        c.header("Retry-After", String(retryAfterSeconds));
        return c.json({ error: "rate_limited", retryAfterSeconds }, 429);
      }

      // Provider and per-account failures are recorded in the run, not raised as HTTP errors.
      const summary = await runImport(c.env, "manual", { ...deps, now: () => now });
      const [run] = await loadRuns(c.env.DB, "?1", summary.runId);
      if (summary.status === "skipped_locked") return c.json({ error: "import_running", run }, 409);
      return c.json({ run });
    });
}
