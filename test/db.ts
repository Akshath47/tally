import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { inject } from "vitest";

/** Wipes D1 and re-applies the repo's migrations (which also re-seed import_lock). */
export async function resetDb(): Promise<void> {
  await reset();
  await applyD1Migrations(env.DB, inject("migrations"));
}
