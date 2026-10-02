import { memo, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, getAccounts, getRuns, getTransactions, startImport, type Account, type ImportRun, type RunStatus } from "./api";
import { formatMoney, formatTimestamp } from "./format";

const RUN_LIMIT = 10;
const TXN_LIMIT = 100;
const POLL_MS = 2_000;
// Statuses after which the run may have changed accounts and transactions.
const FINISHED = new Set<RunStatus>(["success", "partial", "failed"]);
const RUN_STATUS_COLOUR: Partial<Record<RunStatus, string>> = { success: "text-green-700", failed: "text-red-700" };

function importMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    const wait = Number(error.body?.retryAfterSeconds);
    return `Imported less than a minute ago. Try again in ${Number.isFinite(wait) ? wait : 60}s.`;
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
        className="w-full rounded bg-black px-4 py-3 font-medium text-white disabled:opacity-50"
        disabled={busy}
        onClick={() => mutation.mutate()}
      >
        {busy ? "Importing…" : "Import from Lunch Flow"}
      </button>
      {importing ? (
        <p className="mt-2 text-sm text-gray-600">Importing in the background. You can leave the app; results show up here.</p>
      ) : (
        <>
          {failedToStart && <p className="mt-2 text-sm text-amber-700">{importMessage(mutation.error)}</p>}
          {lastFinished && (
            <p className="mt-2 text-sm text-gray-600">
              Last import {formatTimestamp(lastFinished.startedAt)}:{" "}
              <span className={RUN_STATUS_COLOUR[lastFinished.status] ?? "text-amber-700"}>{lastFinished.status}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

function AccountCard({ account }: { account: Account }) {
  return (
    <li className="rounded border p-3 text-sm">
      <p className="font-medium">{account.name}</p>
      <p className="text-gray-600">
        {account.institutionName ?? "Unknown institution"} · {account.providerStatus}
        {!account.importEnabled && " · not imported"}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-gray-500">Last import</dt>
        <dd>{formatTimestamp(account.lastImportSuccessAt)}</dd>
        <dt className="text-gray-500">Newest txn</dt>
        <dd>{account.newestTxnDate ?? "none"}</dd>
        <dt className="text-gray-500">Last change</dt>
        <dd>{formatTimestamp(account.lastDataChangeAt)}</dd>
        {account.lastImportError && (
          <>
            <dt className="text-gray-500">Last error</dt>
            <dd className="text-red-700">{account.lastImportError}</dd>
          </>
        )}
      </dl>
    </li>
  );
}

/** The loading / error / empty line shown above a list. */
function QueryStatus({ query, what, empty }: { query: { isPending: boolean; isError: boolean }; what: string; empty: string | false }) {
  if (query.isPending) return <p className="mt-2 text-sm text-gray-600">Loading…</p>;
  if (query.isError) return <p className="mt-2 text-sm text-red-700">Couldn't load {what}.</p>;
  return empty ? <p className="mt-2 text-sm text-gray-600">{empty}</p> : null;
}

function RunRow({ run }: { run: ImportRun }) {
  const inserted = run.accounts.reduce((n, a) => n + a.inserted, 0);
  const updated = run.accounts.reduce((n, a) => n + a.updated, 0);
  const errorText = [run.errorSummary, ...run.accounts.filter((a) => a.error).map((a) => `#${a.accountId}: ${a.error}`)]
    .filter(Boolean)
    .join("; ");
  return (
    <li className="py-2 text-sm">
      <span>{formatTimestamp(run.startedAt)}</span> · <span>{run.trigger}</span> ·{" "}
      <span className={RUN_STATUS_COLOUR[run.status] ?? "text-amber-700"}>{run.status}</span>
      <span className="text-gray-600">
        {" "}
        · +{inserted} new, {updated} changed
      </span>
      {errorText && <p className="text-red-700">{errorText}</p>}
    </li>
  );
}

// Memoised: the runs poll re-renders App every 2 s while importing, and this list is the heaviest part.
const Transactions = memo(function Transactions({ accounts }: { accounts: Account[] }) {
  const [accountId, setAccountId] = useState<number | null>(null);
  const txns = useQuery({
    queryKey: ["transactions", accountId],
    queryFn: () => getTransactions(TXN_LIMIT, accountId),
  });
  const names = new Map(accounts.map((a) => [a.id, a.name]));

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Transactions</h2>
        <select
          className="rounded border px-2 py-1 text-sm"
          value={accountId ?? ""}
          onChange={(e) => setAccountId(e.target.value === "" ? null : Number(e.target.value))}
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <QueryStatus query={txns} what="transactions" empty={txns.data?.transactions.length === 0 && "No transactions yet."} />
      <ul className="mt-2 divide-y">
        {txns.data?.transactions.map((t) => (
          <li key={t.id} className={`flex justify-between gap-3 py-2 text-sm ${t.vanishedAt ? "opacity-50 line-through" : ""}`}>
            <div className="min-w-0">
              <p className="truncate">{t.merchant || t.description || "—"}</p>
              <p className="text-xs text-gray-500">
                {t.txnDate}
                {accountId === null && ` · ${names.get(t.accountId) ?? `#${t.accountId}`}`}
                {t.isPending && " · pending"}
                {t.vanishedAt && " · vanished"}
              </p>
            </div>
            <span className={`shrink-0 tabular-nums ${t.amountMinor < 0 ? "" : "text-green-700"}`}>
              {formatMoney(t.amountMinor, t.currency)}
            </span>
          </li>
        ))}
      </ul>
      {txns.data?.nextCursor && <p className="mt-2 text-xs text-gray-500">Showing the latest {TXN_LIMIT}.</p>}
    </section>
  );
});

export function App() {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAccounts });

  const runs = useQuery({
    queryKey: ["import-runs"],
    queryFn: () => getRuns(RUN_LIMIT),
    refetchInterval: (q) => (q.state.data?.importing ? POLL_MS : false),
  });
  const importing = runs.data?.importing ?? false;

  // When a run (manual or cron) finishes, the cards and list may be stale.
  const lastFinished = runs.data?.runs.find((r) => FINISHED.has(r.status));
  const finishedKey = lastFinished ? `${lastFinished.id}:${lastFinished.status}` : null;
  const seenKey = useRef<string | null>(null);
  useEffect(() => {
    if (finishedKey === null) return;
    if (seenKey.current !== null && seenKey.current !== finishedKey) {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["transactions"] });
    }
    seenKey.current = finishedKey;
  }, [finishedKey, queryClient]);

  const refreshRuns = () => void queryClient.invalidateQueries({ queryKey: ["import-runs"] });

  return (
    <main className="mx-auto max-w-md p-4 font-sans">
      <h1 className="text-xl font-semibold">Tally</h1>

      <ImportButton importing={importing} lastFinished={lastFinished} onSettled={refreshRuns} />

      <section className="mt-6">
        <h2 className="font-semibold">Accounts</h2>
        <QueryStatus query={accounts} what="accounts" empty={accounts.data?.accounts.length === 0 && "No accounts yet. Run an import."} />
        <ul className="mt-2 space-y-2">
          {accounts.data?.accounts.map((a) => <AccountCard key={a.id} account={a} />)}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="font-semibold">Recent imports</h2>
        <QueryStatus query={runs} what="import runs" empty={runs.data?.runs.length === 0 && "No imports yet."} />
        <ul className="mt-2 divide-y">{runs.data?.runs.map((r) => <RunRow key={r.id} run={r} />)}</ul>
      </section>

      <Transactions accounts={accounts.data?.accounts ?? []} />
    </main>
  );
}
