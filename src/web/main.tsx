import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./api";
import { App } from "./App";
import "./index.css";

// One retry, and none for a client error: a 4xx won't change on retry, and the screens show
// their error state sooner.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500) },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
