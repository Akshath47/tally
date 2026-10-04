// Shared by the scripts that read Cloudflare's GraphQL Analytics API. Needs
// CLOUDFLARE_ANALYTICS_TOKEN (a read-only Account Analytics token, exported in the owner's
// shell) and CLOUDFLARE_ACCOUNT_ID. The token is never printed.

import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const TOKEN = process.env.CLOUDFLARE_ANALYTICS_TOKEN;

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
if (!TOKEN || !ACCOUNT) fail("Set CLOUDFLARE_ANALYTICS_TOKEN and CLOUDFLARE_ACCOUNT_ID in your shell first.");

export async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) fail(`Analytics API answered HTTP ${res.status}.`);
  const body = (await res.json()) as { data: T | null; errors: { message: string }[] | null };
  // A wrong-scope token still gets 200, with the reason in `errors`.
  if (body.errors?.length) fail(`Analytics API errors:\n${body.errors.map((e) => `  - ${e.message}`).join("\n")}`);
  return body.data!;
}

/** The Worker's name and its DB binding's database, from wrangler.jsonc so neither is duplicated here. */
export function workerConfig() {
  const { rawConfig } = experimental_readRawConfig({ config: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)) });
  const db = rawConfig.d1_databases?.find((d: { binding: string }) => d.binding === "DB")?.database_id;
  if (!rawConfig.name || !db) fail("wrangler.jsonc needs a name and a DB binding with a database_id.");
  return { scriptName: rawConfig.name, databaseId: db };
}
