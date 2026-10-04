import { describe, expect, it } from "vitest";
import { findProblems, weeklyWindows, type ImportRun } from "../scripts/check-terminations/problems";

// Synthetic analytics and import-run rows only.

const NOW = new Date("2026-10-04T18:00:00.000Z");
const run = (overrides: Partial<ImportRun>): ImportRun => ({
  id: 1, trigger: "cron", startedAt: "2026-10-04T10:00:00.000Z", status: "success", errorSummary: null, ...overrides,
});

describe("weeklyWindows", () => {
  it("splits the lookback into windows of at most 7 days, oldest first", () => {
    expect(weeklyWindows(NOW, 10)).toEqual([
      { since: "2026-09-24T18:00:00.000Z", until: "2026-10-01T18:00:00.000Z" },
      { since: "2026-10-01T18:00:00.000Z", until: "2026-10-04T18:00:00.000Z" },
    ]);
  });

  it("uses one window when the lookback fits in a week", () => {
    expect(weeklyWindows(NOW, 7)).toEqual([{ since: "2026-09-27T18:00:00.000Z", until: "2026-10-04T18:00:00.000Z" }]);
  });
});

describe("findProblems", () => {
  it("is empty when every run and request succeeded", () => {
    const problems = findProblems(
      [{ datetime: "2026-10-04T10:00:14Z", cpuTimeUs: 40_000, status: "success" }],
      [{ date: "2026-10-04", status: "success", requests: 30 }, { date: "2026-10-04", status: "clientDisconnected", requests: 2 }],
      [run({})],
      NOW,
    );
    expect(problems).toEqual([]);
  });

  it("reports a cron run Cloudflare stopped", () => {
    const problems = findProblems([{ datetime: "2026-10-04T10:00:14Z", cpuTimeUs: 61_000, status: "exceededResources" }], [], [], NOW);
    expect(problems).toEqual([{ when: "2026-10-04T10:00:14Z", what: "cron run ended with status exceededResources (61.0 ms CPU)" }]);
  });

  it("reports requests of any kind that didn't succeed, per day", () => {
    const problems = findProblems([], [{ date: "2026-10-03", status: "exceededResources", requests: 2 }], [], NOW);
    expect(problems).toEqual([{ when: "2026-10-03", what: "2 invocations (HTTP or cron) ended with status exceededResources" }]);
  });

  it("reports an import run that was cut off and closed as abandoned", () => {
    const problems = findProblems([], [], [run({ id: 7, trigger: "manual", status: "failed", errorSummary: "abandoned" })], NOW);
    expect(problems).toEqual([{ when: "2026-10-04T10:00:00.000Z", what: "manual import run 7 was cut off before it finished (abandoned)" }]);
  });

  it("reports an import run still marked running long after it started", () => {
    const problems = findProblems([], [], [run({ id: 8, status: "running", startedAt: "2026-10-04T17:00:00.000Z" })], NOW);
    expect(problems).toEqual([{ when: "2026-10-04T17:00:00.000Z", what: "cron import run 8 is still marked running" }]);
  });

  it("ignores an import run that is running right now", () => {
    expect(findProblems([], [], [run({ status: "running", startedAt: "2026-10-04T17:55:00.000Z" })], NOW)).toEqual([]);
  });

  it("lists problems oldest first", () => {
    const problems = findProblems(
      [{ datetime: "2026-10-04T10:00:14Z", cpuTimeUs: 61_000, status: "exceededResources" }],
      [{ date: "2026-10-02", status: "scriptThrewException", requests: 1 }],
      [],
      NOW,
    );
    expect(problems.map((p) => p.when)).toEqual(["2026-10-02", "2026-10-04T10:00:14Z"]);
  });
});
