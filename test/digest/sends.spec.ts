import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { NOW, resetDb } from "../db";

beforeEach(resetDb);

it("keeps one row per week and only known statuses", async () => {
  const insert = (week: string, status: string) =>
    env.DB.prepare("INSERT INTO digest_sends (week_start, status, attempted_at) VALUES (?1, ?2, ?3)").bind(week, status, NOW).run();
  await insert("2026-10-12", "sending");
  await expect(insert("2026-10-12", "sent")).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
  await expect(insert("2026-10-19", "bogus")).rejects.toThrow(/CHECK/);
});
