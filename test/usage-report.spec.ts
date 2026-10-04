import { describe, expect, it } from "vitest";
import {
  percentile,
  summariseCron,
  summariseD1,
  summariseStatuses,
  verdicts,
  type CronRow,
} from "../scripts/usage-report/report";

// Synthetic analytics rows only.

const cronRun = (cpuTimeUs: number, status = "success", datetime = "2026-10-03T01:00:00Z"): CronRow => ({ datetime, cpuTimeUs, status });

describe("percentile (nearest rank)", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("picks the nearest-rank value", () => {
    expect(percentile(hundred, 0.5)).toBe(50);
    expect(percentile(hundred, 0.99)).toBe(99);
    expect(percentile(hundred, 1)).toBe(100);
  });

  it("returns the only value for a single sample", () => {
    expect(percentile([4.2], 0.99)).toBe(4.2);
  });

  it("returns null with no samples", () => {
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("summariseCron", () => {
  it("reports CPU in ms and the heaviest runs first", () => {
    const rows = [1000, 6000, 2500, 3000, 1500, 4000].map((us, i) => cronRun(us, "success", `2026-10-03T0${i}:00:00Z`));
    const s = summariseCron(rows);
    expect(s).toMatchObject({ runs: 6, p50Ms: 2.5, p99Ms: 6, maxMs: 6 });
    expect(s.heaviest.map((r) => r.cpuTimeUs)).toEqual([6000, 4000, 3000, 2500, 1500]);
  });

  it("counts runs that didn't succeed by status", () => {
    const s = summariseCron([cronRun(1000), cronRun(9000, "exceededCpu"), cronRun(500, "exceededCpu"), cronRun(700, "scriptThrewException")]);
    expect(s.nonSuccess).toEqual({ exceededCpu: 2, scriptThrewException: 1 });
  });

  it("has no CPU figures when there are no runs", () => {
    expect(summariseCron([])).toEqual({ runs: 0, p50Ms: null, p99Ms: null, maxMs: null, heaviest: [], nonSuccess: {} });
  });
});

describe("summariseStatuses", () => {
  it("totals requests and errors and finds the heaviest invocation", () => {
    const s = summariseStatuses([
      { status: "success", requests: 40, errors: 0, cpuTimeP50: 900, cpuTimeP99: 2000, cpuTimeMax: 2500 },
      { status: "clientDisconnected", requests: 2, errors: 0, cpuTimeP50: 300, cpuTimeP99: 400, cpuTimeMax: 450 },
      { status: "scriptThrewException", requests: 1, errors: 1, cpuTimeP50: 100, cpuTimeP99: 100, cpuTimeMax: 100 },
    ]);
    expect(s).toEqual({ requests: 43, errors: 1, maxMs: 2.5 });
  });

  it("has no max without invocations", () => {
    expect(summariseStatuses([]).maxMs).toBeNull();
  });
});

describe("summariseD1", () => {
  const window = { since: "2026-10-01T18:22:00.000Z", until: "2026-10-03T14:00:00.000Z" };

  it("orders days oldest first", () => {
    const days = summariseD1(
      [
        { date: "2026-10-03", rowsRead: 900, rowsWritten: 120 },
        { date: "2026-10-02", rowsRead: 20_000, rowsWritten: 2_500 },
      ],
      window,
    );
    expect(days.map((d) => [d.date, d.rowsWritten])).toEqual([
      ["2026-10-02", 2_500],
      ["2026-10-03", 120],
    ]);
  });

  it("flags the window's first and last UTC days, which it only partly covers", () => {
    const days = summariseD1(
      ["2026-10-01", "2026-10-02", "2026-10-03"].map((date) => ({ date, rowsRead: 1, rowsWritten: 1 })),
      window,
    );
    expect(days.map((d) => [d.date, d.partial])).toEqual([
      ["2026-10-01", true],
      ["2026-10-02", false],
      ["2026-10-03", true],
    ]);
  });
});

describe("verdicts", () => {
  const window = { since: "2026-10-02T00:00:00.000Z", until: "2026-10-03T00:00:00.000Z" };
  const d1Ok = summariseD1([{ date: "2026-10-02", rowsRead: 1, rowsWritten: 4_999 }], window);
  const noHttp = summariseStatuses([]);
  const result = (v: ReturnType<typeof verdicts>, check: string) => v.find((x) => x.check === check)!.result;

  it("passes just under the limits", () => {
    const v = verdicts(summariseCron([cronRun(6_900)]), noHttp, d1Ok);
    expect(v.map((x) => x.result)).toEqual(["pass", "pass", "pass"]);
  });

  it("fails import P99 at exactly 7 ms (the limit is strict)", () => {
    expect(result(verdicts(summariseCron([cronRun(7_000)]), noHttp, d1Ok), "cron import P99 CPU")).toBe("fail");
  });

  it("fails the heaviest run at 10 ms", () => {
    expect(result(verdicts(summariseCron([cronRun(10_000)]), noHttp, d1Ok), "heaviest run CPU")).toBe("fail");
  });

  it("counts a heavy manual (HTTP) import towards the heaviest run", () => {
    const http = summariseStatuses([{ status: "success", requests: 3, errors: 0, cpuTimeP50: 1_000, cpuTimeP99: 9_000, cpuTimeMax: 12_000 }]);
    expect(result(verdicts(summariseCron([cronRun(2_000)]), http, d1Ok), "heaviest run CPU")).toBe("fail");
  });

  it("fails D1 writes at 5% of the daily allowance", () => {
    const d1 = summariseD1([{ date: "2026-10-02", rowsRead: 1, rowsWritten: 5_000 }], window);
    expect(result(verdicts(summariseCron([cronRun(1_000)]), noHttp, d1), "daily D1 writes")).toBe("fail");
  });

  it("never passes without data", () => {
    const v = verdicts(summariseCron([]), noHttp, []);
    expect(v.map((x) => x.result)).toEqual(["not enough data", "not enough data", "not enough data"]);
  });
});
