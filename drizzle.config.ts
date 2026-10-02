import { defineConfig } from "drizzle-kit";

// Generates SQL only; `wrangler d1 migrations apply` applies it, locally and remotely.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/worker/db/schema.ts",
  out: "./migrations",
});
