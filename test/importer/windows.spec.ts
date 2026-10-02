import { describe, expect, it } from "vitest";
import { backfillChunks, incrementalWindow } from "../../src/worker/importer/windows";

const TODAY = "2026-10-02";

describe("incrementalWindow", () => {
  it("covers the last 14 days including today", () => {
    expect(incrementalWindow(TODAY)).toEqual({ from: "2026-09-19", to: "2026-10-02" });
  });
});

describe("backfillChunks", () => {
  it("starts just before the incremental window when there is no cursor", () => {
    const r = backfillChunks(null, TODAY, 730);
    expect(r.chunks[0]).toEqual({ from: "2026-08-19", to: "2026-09-18" });
  });

  it("returns at most 2 contiguous 31-day chunks and the new cursor", () => {
    const r = backfillChunks(null, TODAY, 730);
    expect(r.chunks).toEqual([
      { from: "2026-08-19", to: "2026-09-18" },
      { from: "2026-07-19", to: "2026-08-18" },
    ]);
    expect(r.nextCursor).toBe("2026-07-19");
    expect(r.complete).toBe(false);
  });

  it("resumes from the stored cursor", () => {
    const r = backfillChunks("2026-07-19", TODAY, 730);
    expect(r.chunks[0]).toEqual({ from: "2026-06-18", to: "2026-07-18" });
  });

  it("clamps the last chunk to the floor and marks the backfill complete", () => {
    // floor = 2026-10-02 - 60d = 2026-08-03
    const r = backfillChunks(null, TODAY, 60);
    expect(r.chunks).toEqual([
      { from: "2026-08-19", to: "2026-09-18" },
      { from: "2026-08-03", to: "2026-08-18" },
    ]);
    expect(r.nextCursor).toBe("2026-08-03");
    expect(r.complete).toBe(true);
  });

  it("does nothing once the cursor has reached the floor", () => {
    const r = backfillChunks("2026-08-03", TODAY, 60);
    expect(r).toEqual({ chunks: [], nextCursor: "2026-08-03", complete: true });
  });

  it("is complete immediately when BACKFILL_DAYS fits inside the incremental window", () => {
    expect(backfillChunks(null, TODAY, 10)).toEqual({ chunks: [], nextCursor: "2026-09-19", complete: true });
  });

  it("reaches the floor of a 730-day backfill in 12 runs", () => {
    let cursor: string | null = null;
    let runs = 0;
    for (let complete = false; !complete; runs++) {
      const r = backfillChunks(cursor, TODAY, 730);
      cursor = r.nextCursor;
      complete = r.complete;
    }
    expect(runs).toBe(12);
    expect(cursor).toBe("2024-10-02");
  });
});
