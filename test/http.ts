import { env } from "cloudflare:workers";
import { createApp } from "../src/worker";

// Requests to the app as the SPA sends them. They go to localhost, where the local-dev auth
// bypass applies (auth itself is covered by auth.spec.ts).

export const ORIGIN = "http://localhost";
export const app = createApp();

export const get = (path: string) => app.request(`${ORIGIN}${path}`, {}, env);

/** A state-changing request, with the Origin and JSON content type the API requires. */
export const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(
    `${ORIGIN}${path}`,
    { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
