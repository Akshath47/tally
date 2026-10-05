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
  const seenKey = useRef<string | null>(null);
  useEffect(() => {
    if (finishedKey === null) return;
    if (seenKey.current !== null && seenKey.current !== finishedKey) {
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "import-runs" });
    }
    seenKey.current = finishedKey;
  }, [finishedKey, queryClient]);
}
