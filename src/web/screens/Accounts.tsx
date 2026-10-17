import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, startImport, type Account, type ImportRun, type RunStatus } from "../api";
import { lastFinishedRun, useImportRuns } from "../components/ImportWatcher";
import { LoadError, PushedScreen } from "../components/Screen";
import { AccountBadge, Button, ChevronRight, Skeleton } from "../components/ui";
import { formatShortDate } from "../dates";
import { formatTimestamp } from "../format";
import { useAccounts } from "../queries";
import { freshnessAge } from "../stale";
import { Link } from "../router";
import { newAccountHref, type Back } from "../routes";

// Account status (docs/ui-design.md, Accounts). Stale accounts come from the Worker's `stale` flag (docs/phase-2-insights-spec.md).

const RUN_TEXT: Partial<Record<RunStatus, string>> = { success: "done", partial: "some accounts failed", failed: "failed" };

function importMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return `Imported less than a minute ago. Try again in ${error.body?.retryAfterSeconds ?? 60}s.`;
  return "The import didn't start. Try again later.";
}

/**
 * The import runs on the server after a 202, so the button only kicks it off. Whether one is
 * in progress, and how the last one ended, come from the runs list; the shell's import watcher
 * refreshes every screen when it finishes.
 */
function ImportNow({ importing, lastFinished }: { importing: boolean; lastFinished: ImportRun | undefined }) {
  const queryClient = useQueryClient();
  // Every outcome refreshes the runs: a 202 shows the new run, a 409 or 429 may reveal one in progress.
  const mutation = useMutation({ mutationFn: startImport, onSettled: () => void queryClient.invalidateQueries({ queryKey: ["import-runs"] }) });
  const busy = mutation.isPending || importing;
  // A 409 just means an import is already running, which the polling then shows.
  const failedToStart = mutation.isError && !(mutation.error instanceof ApiError && mutation.error.status === 409);
  return (
    <div className="mx-4 mt-3">
      <Button kind="secondary" className="w-full" disabled={busy} onClick={() => mutation.mutate()}>
        {busy ? "Checking Lunch Flow…" : "Check for new transactions"}
      </Button>
      <p className="mt-1.5 px-1 text-[12.5px] text-muted" role="status">
        {importing && "Importing in the background. You can leave this screen."}
        {!importing && failedToStart && importMessage(mutation.error)}
        {!importing && !failedToStart && lastFinished && `Last check ${formatTimestamp(lastFinished.startedAt)}: ${RUN_TEXT[lastFinished.status] ?? lastFinished.status}`}
      </p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 border-t border-divider text-[14.5px]">
      <span className="text-muted">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function AccountCard({ account }: { account: Account }) {
  const failing = account.lastImportError !== null;
  const stale = account.importEnabled && !failing && account.stale;
  const status = !account.importEnabled
    ? { text: "Not imported", dot: "bg-muted", tone: "text-muted" }
    : failing
      ? { text: "Import failing", dot: "bg-over", tone: "text-over-fg" }
      : stale
        ? { text: "No new data", dot: "bg-warn", tone: "text-warn-fg" }
        : { text: "Up to date", dot: "bg-accent", tone: "text-accent-fg" };
  const updated = account.lastDataChangeAt;
  return (
    <li className={`rounded-card border bg-surface px-4 pt-3.5 pb-1 ${failing ? "border-over/40" : stale ? "border-warn/40" : "border-divider"}`}>
      <div className="flex items-center gap-2.5 pb-2.5">
        <AccountBadge account={account} />
        <span className="min-w-0 flex-1 truncate font-medium">{account.name}</span>
        <span className={`inline-flex items-center gap-1.5 text-[13px] ${status.tone}`}>
          <span className={`size-1.5 rounded-full ${status.dot}`} aria-hidden="true" />
          {status.text}
        </span>
      </div>
      {failing && <p className="mb-2.5 rounded-input bg-over-tint px-3 py-2.5 text-[13px] leading-normal text-over-fg">Last import failed: {account.lastImportError}</p>}
      {stale && (
        <div className="mb-2.5 rounded-input bg-warn-tint px-3 py-2.5 text-[13px] leading-normal text-warn-fg">
          <p>
            No new data for {account.staleDays} days, so Tally's totals may be missing recent spending. If the bank connection has dropped,
            reconnect it in Lunch Flow.
          </p>
          <a className="mt-1.5 inline-block underline" href="https://www.lunchflow.app" target="_blank" rel="noreferrer">
            Open Lunch Flow
          </a>
        </div>
      )}
      <Detail label="Last updated" value={updated ? `${freshnessAge(account)} · ${formatTimestamp(updated)}` : "Never"} />
      <Detail label="Newest transaction" value={account.newestTxnDate ? formatShortDate(account.newestTxnDate) : "None yet"} />
      {!account.backfillComplete && account.importEnabled && <Detail label="History" value="Still importing" />}
    </li>
  );
}

export function Accounts({ back }: { back: Back }) {
  const accounts = useAccounts();
  const runs = useImportRuns();
  const all = accounts.data?.all ?? [];
  const awaiting = all.filter((a) => a.needsReview);
  const listed = all.filter((a) => !a.needsReview);

  return (
    <PushedScreen back={back} title="Accounts">
      <p className="mx-5 mt-1.5 text-[13.5px] leading-normal text-muted">Tally checks Lunch Flow every 3 hours. Bank data can be up to a day behind.</p>
      <ImportNow importing={runs.data?.importing ?? false} lastFinished={lastFinishedRun(runs.data)} />
      {awaiting.map((a) => (
        <Link key={a.id} href={newAccountHref(a.id)} className="mx-4 mt-3 flex items-center gap-3 rounded-2xl border border-accent/35 bg-accent-tint/60 p-3.5">
          <span className="grid size-[34px] shrink-0 place-items-center rounded-input bg-accent-tint text-xl text-accent-fg" aria-hidden="true">
            +
          </span>
          <span className="flex-1">
            <span className="block font-medium">New account found</span>
            <span className="block text-[13px] text-accent-fg">{a.name} · review before it's imported</span>
          </span>
          <ChevronRight size={16} className="text-muted" />
        </Link>
      ))}
      {accounts.isPending ? (
        <div className="mx-4 mt-3 flex flex-col gap-3">
          <Skeleton className="h-[150px] rounded-card" />
          <Skeleton className="h-[150px] rounded-card" />
        </div>
      ) : accounts.isError ? (
        <LoadError what="accounts" onRetry={() => void accounts.refetch()} />
      ) : listed.length === 0 && awaiting.length === 0 ? (
        <p className="mx-5 mt-4 text-muted">No accounts yet. Check for new transactions to import them from Lunch Flow.</p>
      ) : (
        <ul className="mx-4 mt-3 mb-6 flex flex-col gap-3">
          {listed.map((a) => (
            <AccountCard key={a.id} account={a} />
          ))}
        </ul>
      )}
    </PushedScreen>
  );
}
