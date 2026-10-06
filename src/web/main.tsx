import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./api";
import { App } from "./App";
import "./index.css";

// Every successful write refreshes what's loaded (the import runs aside: no write changes
// them), so each screen doesn't have to remember to. A write whose screen updates its own
// queries from the response sets `meta: { refetch: "none" }`: everything is still marked stale,
// but nothing refetches until it's next shown (D1 bills every row a refetch reads). Between
// writes, data stays fresh for 30 s rather than refetching on every tab switch, and returning
// to the app doesn't refetch: the import watcher refreshes after imports. One retry, and none for
// a client error: a 4xx won't change on retry, and the screens show their error state sooner.
const queryClient: QueryClient = new QueryClient({
  mutationCache: new MutationCache({
    // Not returned: TanStack would wait for every refetch before the screen's own onSuccess runs.
    onSuccess: (_data, _variables, _context, mutation) => {
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] !== "import-runs",
        refetchType: mutation.meta?.refetch === "none" ? "none" : "active",
      });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500),
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
