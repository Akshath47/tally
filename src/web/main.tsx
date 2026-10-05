import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./api";
import { App } from "./App";
import "./index.css";

// Every successful write refreshes what's loaded (the import runs aside: no write changes
// them), so each screen doesn't have to remember to. Between writes, data stays fresh for 30 s
// rather than refetching on every tab switch; the import watcher refreshes after imports.
// One retry, and none for a client error: a 4xx won't change on retry, and the screens show
// their error state sooner.
const queryClient: QueryClient = new QueryClient({
  mutationCache: new MutationCache({
    onSuccess: () => queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "import-runs" }),
  }),
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500) },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
