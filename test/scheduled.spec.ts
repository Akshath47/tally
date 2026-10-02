import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { resetDb } from "./db";
import { AMEX, REVOLUT, txn, world } from "./fixtures/lunchflow";

// The cron path through the real Worker export, against a synthetic Lunch Flow.

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

it("a cron trigger imports both accounts as a 'cron' run", async () => {
  const w = world([REVOLUT, AMEX]);
  w.txns[1] = [txn(1, "r1")];
  w.txns[2] = [txn(2, "a1")];
  vi.spyOn(globalThis, "fetch").mockImplementation(w.fetch);

  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);

  const runs = await env.DB.prepare("SELECT trigger, status, finished_at FROM import_runs").all<{ trigger: string; status: string; finished_at: string | null }>();
  expect(runs.results).toEqual([{ trigger: "cron", status: "success", finished_at: expect.any(String) }]);
  const txns = await env.DB.prepare("SELECT count(*) AS n FROM transactions").first<{ n: number }>();
  expect(txns!.n).toBe(2);
  // The run let go of the lease, so the next hour's cron can claim it.
  const lock = await env.DB.prepare("SELECT holder_run_id FROM import_lock WHERE id = 1").first<{ holder_run_id: number | null }>();
  expect(lock!.holder_run_id).toBeNull();
});
