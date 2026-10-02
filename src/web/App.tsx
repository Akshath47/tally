import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, getAccounts, getRuns, getTransactions, startImport, type Account, type ImportRun } from "./api";
import { formatMoney, formatTimestamp } from "./format";

const RUN_LIMIT = 10;
const TXN_LIMIT = 100;
const POLL_MS = 2_000;
// After a 202 the run's row may not exist yet; keep polling this long for it to appear.
const KICK_MS = 10_000;
// The importer's lease. A run still "running" after this was cut off and will be marked abandoned.
const STALE_MS = 10 * 60_000;

/** Server timestamps are compared with the fetch time, not render time, to keep render pure. */
function isImporting(data: { runs: ImportRun[] } | undefined, fetchedAt: number): boolean {
  const latest = data?.runs[0];
  return latest?.status === "running" && fetchedAt - Date.parse(latest.startedAt) < STALE_MS;
}

function importMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      const wait = Number(error.body?.retryAfterSeconds);
      return `Imported less than a minute ago. Try again in ${Number.isFinite(wait) ? wait : 60}s.`;
    }
    if (error.status === 409) return "Another import is already running. Try again shortly.";
  }
  return "Import failed to start. Try again later.";
}

/**
 * The import runs on the server after a 202, so the button only kicks it off. Whether one is
 * in progress comes from the runs list, which survives leaving or reopening the app.
 */
function ImportButton({ importing, onStarted }: { importing: boolean; onStarted: () => void }) {
  const mutation = useMutation({
    mutationFn: startImport,
    onSuccess: onStarted,
    // A 409 means some other run (e.g. cron) is in progress, so watch that one instead.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) onStarted();
    },
  });
  const busy = mutation.isPending || importing;

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
        mutation.isError && <p className="mt-2 text-sm text-amber-700">{importMessage(mutation.error)}</p>
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

const RUN_STATUS_COLOUR: Record<string, string> = { success: "text-green-700", failed: "text-red-700" };

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

function Transactions({ accounts }: { accounts: Account[] }) {
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
}

export function App() {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAccounts });

  // Set on a 202/409 so polling starts before the new run's row is visible.
  const kickedAt = useRef<number | null>(null);
  const runs = useQuery({
    queryKey: ["import-runs"],
    queryFn: () => getRuns(RUN_LIMIT),
    refetchInterval: (q) => {
      const justKicked = kickedAt.current !== null && Date.now() - kickedAt.current < KICK_MS;
      return justKicked || isImporting(q.state.data, q.state.dataUpdatedAt) ? POLL_MS : false;
    },
  });
  const importing = isImporting(runs.data, runs.dataUpdatedAt);

  // Whenever the latest run appears or changes status (manual or cron), the cards and list may be stale.
  const latest = runs.data?.runs[0];
  const latestKey = latest ? `${latest.id}:${latest.status}` : null;
  const seenKey = useRef<string | null>(null);
  useEffect(() => {
    if (latestKey === null) return;
    if (seenKey.current !== null && seenKey.current !== latestKey) {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["transactions"] });
    }
    seenKey.current = latestKey;
  }, [latestKey, queryClient]);

  const onStarted = () => {
    kickedAt.current = Date.now();
    void queryClient.invalidateQueries({ queryKey: ["import-runs"] });
  };

  return (
    <main className="mx-auto max-w-md p-4 font-sans">
      <h1 className="text-xl font-semibold">Tally</h1>

      <ImportButton importing={importing} onStarted={onStarted} />

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
