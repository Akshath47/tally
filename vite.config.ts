import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// The Worker's local-dev auth bypass (src/worker/auth.ts) admits any request that reaches
// `vite dev`, and the Worker can't see the real client address (a spoofed Host header looks
// like localhost). So the dev server must never listen beyond this machine, e.g. via --host.
function loopbackOnlyDevServer(): Plugin {
  return {
    name: "tally:loopback-only-dev-server",
    apply: (_, env) => env.command === "serve" && !env.isPreview,
    configResolved({ server }) {
      if (server.host !== undefined && !LOOPBACK_HOSTS.has(String(server.host))) {
        throw new Error(`vite dev must stay on localhost (got host: ${String(server.host)}); the dev auth bypass would admit anyone who can reach it.`);
      }
    },
  };
}

export default defineConfig({
  plugins: [loopbackOnlyDevServer(), react(), tailwindcss(), cloudflare()],
});
