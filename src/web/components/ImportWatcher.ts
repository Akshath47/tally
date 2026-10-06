import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRuns, type RunStatus } from "../api";

const RUN_LIMIT = 10;
const POLL_MS = 2_000;
// Statuses after which the run may have changed accounts and transactions.
const FINISHED = new Set<RunStatus>(["success", "partial", "failed"]);

export const useImportRuns = () =>
  useQuery({
    queryKey: ["import-runs"],
    queryFn: () => getRuns(RUN_LIMIT),
    refetchInterval: (q) => (q.state.data?.importing ? POLL_MS : false),
    // The one query that refetches on returning to the app (a few rows): a cron run that
    // finished meanwhile is how the watcher knows to refresh everything else.
    refetchOnWindowFocus: true,
  });

export const lastFinishedRun = (runs: Awaited<ReturnType<typeof getRuns>> | undefined) => runs?.runs.find((r) => FINISHED.has(r.status));

/**
 * Called once from the app shell: when a run (manual or cron) finishes, everything derived from
 * transactions may be stale, whichever screen is open.
 */
export function useImportWatcher() {
  const queryClient = useQueryClient();
  const runs = useImportRuns();
  const lastFinished = lastFinishedRun(runs.data);
  const finishedKey = lastFinished ? `${lastFinished.id}:${lastFinished.status}` : null;
  // undefined until the runs first load; a finished run seen after that refreshes, the first ever included.
  const seenKey = useRef<string | null | undefined>(undefined);
  const loaded = runs.data !== undefined;
  useEffect(() => {
    if (!loaded) return;
    if (seenKey.current !== undefined && finishedKey !== null && seenKey.current !== finishedKey) {
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "import-runs" });
    }
    seenKey.current = finishedKey;
  }, [loaded, finishedKey, queryClient]);
}
