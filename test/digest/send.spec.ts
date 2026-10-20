import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIGEST_CRON, deliverDigest, runScheduledDigest } from "../../src/worker/digest/send";
import worker from "../../src/worker/index";
import { resetDb } from "../db";
import { send } from "../http";

// A fake send_email binding records what would have gone out. All data is synthetic.

type Sent = { from: string; to: string; subject: string; text: string; html: string };
let sent: Sent[];
let fail: Error | null;
const fakeEnv = (over: Partial<Env> = {}): Env =>
  ({
    ...env,
    DIGEST_ENABLED: "true",
    DIGEST_EMAIL: {
      send: async (m: Sent) => {
        if (fail) throw fail;
        sent.push(m);
        return { messageId: "m1" };
      },
    },
    ...over,
  }) as unknown as Env;
const sends = () => env.DB.prepare("SELECT week_start, status, error FROM digest_sends ORDER BY week_start").all();

beforeEach(async () => {
  await resetDb();
  sent = [];
  fail = null;
});
afterEach(() => vi.restoreAllMocks());

describe("runScheduledDigest", () => {
  it.each([
    ["2026-10-18T17:00:00Z", "sent"], // 18:00 BST
    ["2026-10-18T18:00:00Z", "not_send_hour"], // 19:00 BST
    ["2026-10-25T17:00:00Z", "not_send_hour"], // the clocks went back that morning: 17:00 GMT
    ["2026-10-25T18:00:00Z", "sent"],
    ["2026-11-01T17:00:00Z", "not_send_hour"],
    ["2026-11-01T18:00:00Z", "sent"], // 18:00 GMT
  ])("at %s → %s", async (iso, outcome) => {
    expect(await runScheduledDigest(fakeEnv(), new Date(iso))).toBe(outcome);
    expect(sent).toHaveLength(outcome === "sent" ? 1 : 0);
  });

  it("sends once a week to ALLOWED_EMAIL from DIGEST_FROM, with no figures in the subject", async () => {
    const now = new Date("2026-10-18T17:00:00Z");
    expect(await runScheduledDigest(fakeEnv(), now)).toBe("sent");
    expect(await runScheduledDigest(fakeEnv(), now)).toBe("already_claimed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "tally@example.com", to: "owner@example.com", subject: "Your week in Tally · 12–18 Oct" });
    expect((await sends()).results).toEqual([{ week_start: "2026-10-12", status: "sent", error: null }]);
  });

  it("records a failed send by its code and logs neither the body nor the address", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    fail = Object.assign(new Error("delivery to owner@example.com failed"), { code: "E_DELIVERY_FAILED" });
    expect(await runScheduledDigest(fakeEnv(), new Date("2026-10-18T17:00:00Z"))).toBe("failed");
    expect((await sends()).results).toEqual([{ week_start: "2026-10-12", status: "failed", error: "E_DELIVERY_FAILED" }]);
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain('"status":"failed"');
    expect(logged).not.toMatch(/owner@example\.com|£|Your week/);
  });

  it("does nothing while disabled", async () => {
    expect(await runScheduledDigest(fakeEnv({ DIGEST_ENABLED: "false" } as Partial<Env>), new Date("2026-10-18T17:00:00Z"))).toBe("disabled");
    expect(sent).toEqual([]);
    expect((await sends()).results).toEqual([]);
  });
});

describe("scheduled()", () => {
  it("routes the digest cron to the digest and not to an import", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: DIGEST_CRON, scheduledTime: Date.parse("2026-10-18T17:00:00Z") }), fakeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(sent).toHaveLength(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM import_runs").first()).toEqual({ n: 0 });
  });
});

describe("POST /api/digest/send", () => {
  it("sends now and leaves the weekly claim alone", async () => {
    const res = await send("POST", "/api/digest/send", {}, {}, fakeEnv());
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect((await sends()).results).toEqual([]);
  });

  it("marks the latest failed week as sent once a manual send works", async () => {
    await env.DB.prepare("INSERT INTO digest_sends (week_start, status, attempted_at, error) VALUES ('2026-10-12', 'failed', '2026-10-18T17:00:00Z', 'E_DELIVERY_FAILED')").run();
    expect((await send("POST", "/api/digest/send", {}, {}, fakeEnv())).status).toBe(200);
    expect((await sends()).results).toEqual([{ week_start: "2026-10-12", status: "sent", error: null }]);
  });

  it("answers 502 when the send fails", async () => {
    fail = Object.assign(new Error("x"), { code: "E_RATE_LIMIT_EXCEEDED" });
    const res = await send("POST", "/api/digest/send", {}, {}, fakeEnv());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "send_failed" });
  });
});

describe("deliverDigest", () => {
  it("tells a digest it couldn't build apart from a failed delivery", async () => {
    const broken = { prepare: () => { throw new Error("d1 down"); } } as unknown as D1Database;
    expect(await deliverDigest(fakeEnv({ DB: broken }), new Date("2026-10-18T17:00:00Z"), "manual")).toEqual({ ok: false, error: "build_failed" });
    expect(sent).toEqual([]);
  });
});
