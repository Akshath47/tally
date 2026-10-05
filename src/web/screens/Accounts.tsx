import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, getAccounts, startImport, type Account, type ImportRun, type RunStatus } from "../api";
import { lastFinishedRun, useImportRuns } from "../components/ImportWatcher";
import { PushedScreen, QueryStatus } from "../components/Screen";
import type { Back } from "../routes";
import { formatTimestamp } from "../format";

// Phase 1's status page, kept working under the new shell until the Accounts design lands.

const RUN_STATUS_COLOUR: Partial<Record<RunStatus, string>> = { success: "text-accent-fg", failed: "text-over-fg" };

function importMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    const wait = error.body?.retryAfterSeconds;
    return `Imported less than a minute ago. Try again in ${wait ?? 60}s.`;
  }
  return "Import failed to start. Try again later.";
}

/**
 * The import runs on the server after a 202, so the button only kicks it off. Whether one is
 * in progress, and how the last one ended, come from the runs list, which survives leaving
 * or reopening the app.
 */
function ImportButton({ importing, lastFinished, onSettled }: { importing: boolean; lastFinished: ImportRun | undefined; onSettled: () => void }) {
  // Every outcome refreshes the runs: a 202 shows the new run, a 409 or 429 may reveal one in progress.
  const mutation = useMutation({ mutationFn: startImport, onSettled });
  const busy = mutation.isPending || importing;
  // A 409 just means an import is already running, which the polling then shows.
  const failedToStart = mutation.isError && !(mutation.error instanceof ApiError && mutation.error.status === 409);

  return (
    <div className="mt-4">
      <button
        type="button"
        className="min-h-11 w-full rounded-button bg-accent px-4 font-semibold text-on-accent disabled:opacity-50"
        disabled={busy}
        onClick={() => mutation.mutate()}
      >
        {busy ? "Importing…" : "Import from Lunch Flow"}
      </button>
      {importing ? (
        <p className="mt-2 text-meta text-muted">Importing in the background. You can leave the app; results show up here.</p>
      ) : (
        <>
          {failedToStart && <p className="mt-2 text-meta text-warn-fg">{importMessage(mutation.error)}</p>}
          {lastFinished && (
            <p className="mt-2 text-meta text-muted">
              Last import {formatTimestamp(lastFinished.startedAt)}:{" "}
              <span className={RUN_STATUS_COLOUR[lastFinished.status] ?? "text-warn-fg"}>{lastFinished.status}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

function AccountCard({ account }: { account: Account }) {
  return (
    <li className="rounded-card border border-divider bg-surface p-4">
      <p className="font-medium">{account.name}</p>
      <p className="text-meta text-muted">
        {account.institutionName ?? "Unknown institution"} · {account.providerStatus}
        {account.needsReview ? " · awaiting review" : !account.importEnabled && " · not imported"}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta">
        <dt className="text-muted">Last import</dt>
        <dd>{formatTimestamp(account.lastImportSuccessAt)}</dd>
        <dt className="text-muted">Newest txn</dt>
        <dd>{account.newestTxnDate ?? "none"}</dd>
        <dt className="text-muted">Last change</dt>
        <dd>{formatTimestamp(account.lastDataChangeAt)}</dd>
        {account.lastImportError && (
          <>
            <dt className="text-muted">Last error</dt>
            <dd className="text-over-fg">{account.lastImportError}</dd>
          </>
        )}
      </dl>
    </li>
  );
}

function RunRow({ run }: { run: ImportRun }) {
  const inserted = run.accounts.reduce((n, a) => n + a.inserted, 0);
  const updated = run.accounts.reduce((n, a) => n + a.updated, 0);
  const errorText = [run.errorSummary, ...run.accounts.filter((a) => a.error).map((a) => `#${a.accountId}: ${a.error}`)]
    .filter(Boolean)
    .join("; ");
  return (
    <li className="py-2 text-meta">
      <span>{formatTimestamp(run.startedAt)}</span> · <span>{run.trigger}</span> ·{" "}
      <span className={RUN_STATUS_COLOUR[run.status] ?? "text-warn-fg"}>{run.status}</span>
      <span className="text-muted">
        {" "}
        · +{inserted} new, {updated} changed
      </span>
      {errorText && <p className="text-over-fg">{errorText}</p>}
    </li>
  );
}

export function Accounts({ back }: { back: Back }) {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAccounts });
  // The shell's import watcher refreshes everything when a run finishes; this only reads the runs.
  const runs = useImportRuns();
  const importing = runs.data?.importing ?? false;
  const lastFinished = lastFinishedRun(runs.data);

  const refreshRuns = () => void queryClient.invalidateQueries({ queryKey: ["import-runs"] });

  return (
    <PushedScreen back={back} title="Accounts">
      <div className="px-4 pb-8">
        <ImportButton importing={importing} lastFinished={lastFinished} onSettled={refreshRuns} />

        <section className="mt-6">
          <h2 className="mx-1 font-medium">Accounts</h2>
          <QueryStatus query={accounts} what="accounts" empty={accounts.data?.accounts.length === 0 && "No accounts yet. Run an import."} />
          <ul className="mt-2 space-y-2">
            {accounts.data?.accounts.map((a) => <AccountCard key={a.id} account={a} />)}
          </ul>
        </section>

        <section className="mt-6">
          <h2 className="mx-1 font-medium">Recent imports</h2>
          <QueryStatus query={runs} what="import runs" empty={runs.data?.runs.length === 0 && "No imports yet."} />
          <ul className="mt-2 divide-y divide-divider">{runs.data?.runs.map((r) => <RunRow key={r.id} run={r} />)}</ul>
        </section>
      </div>
    </PushedScreen>
  );
}
