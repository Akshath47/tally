import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, getAccounts, getRuns, getTransactions, startImport, type Account, type ImportRun } from "./api";
import { formatMoney, formatTimestamp } from "./format";

const RUN_LIMIT = 10;
const TXN_LIMIT = 100;

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

function ImportButton() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: startImport,
    onSettled: () => queryClient.invalidateQueries(),
  });

  return (
    <div className="mt-4">
      <button
        type="button"
        className="w-full rounded bg-black px-4 py-3 font-medium text-white disabled:opacity-50"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? "Importing…" : "Import from Lunch Flow"}
      </button>
      {mutation.isError && <p className="mt-2 text-sm text-amber-700">{importMessage(mutation.error)}</p>}
      {mutation.isSuccess && <p className="mt-2 text-sm text-gray-600">Import finished: {mutation.data.run.status}.</p>}
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

function RunRow({ run }: { run: ImportRun }) {
  const inserted = run.accounts.reduce((n, a) => n + a.inserted, 0);
  const updated = run.accounts.reduce((n, a) => n + a.updated, 0);
  const errors = run.accounts.filter((a) => a.error).map((a) => `#${a.accountId}: ${a.error}`);
  return (
    <li className="py-2 text-sm">
      <span>{formatTimestamp(run.startedAt)}</span> · <span>{run.trigger}</span> ·{" "}
      <span className={run.status === "success" ? "text-green-700" : "text-red-700"}>{run.status}</span>
      <span className="text-gray-600">
        {" "}
        · +{inserted} new, {updated} changed
      </span>
      {(run.errorSummary || errors.length > 0) && (
        <p className="text-red-700">{[run.errorSummary, ...errors].filter(Boolean).join("; ")}</p>
      )}
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
      {txns.isPending && <p className="mt-2 text-sm text-gray-600">Loading…</p>}
      {txns.isError && <p className="mt-2 text-sm text-red-700">Couldn't load transactions.</p>}
      {txns.data && txns.data.transactions.length === 0 && <p className="mt-2 text-sm text-gray-600">No transactions yet.</p>}
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
    </section>
  );
}

export function App() {
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAccounts });
  const runs = useQuery({ queryKey: ["import-runs"], queryFn: () => getRuns(RUN_LIMIT) });

  return (
    <main className="mx-auto max-w-md p-4 font-sans">
      <h1 className="text-xl font-semibold">Tally</h1>

      <ImportButton />

      <section className="mt-6">
        <h2 className="font-semibold">Accounts</h2>
        {accounts.isPending && <p className="mt-2 text-sm text-gray-600">Loading…</p>}
        {accounts.isError && <p className="mt-2 text-sm text-red-700">Couldn't load accounts.</p>}
        {accounts.data && accounts.data.accounts.length === 0 && (
          <p className="mt-2 text-sm text-gray-600">No accounts yet. Run an import.</p>
        )}
        <ul className="mt-2 space-y-2">
          {accounts.data?.accounts.map((a) => <AccountCard key={a.id} account={a} />)}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="font-semibold">Recent imports</h2>
        {runs.isError && <p className="mt-2 text-sm text-red-700">Couldn't load import runs.</p>}
        <ul className="mt-2 divide-y">{runs.data?.runs.map((r) => <RunRow key={r.id} run={r} />)}</ul>
      </section>

      <Transactions accounts={accounts.data?.accounts ?? []} />
    </main>
  );
}
