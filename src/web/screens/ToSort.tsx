import { useMemo, useState } from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { apiErrorText, createRule, deleteRule, getInbox, putOverride, type Category, type InboxMerchant, type Transaction } from "../api";
import { LoadError, PushedScreen } from "../components/Screen";
import { Sheet } from "../components/Sheet";
import { CategoryPicker, TransactionSheet } from "../components/TransactionSheet";
import { AccountBadge, Button, ChevronDown, ChevronRight, ErrorBanner, Lock, SectionLabel, Segmented, Skeleton, Toast, type ToastState } from "../components/ui";
import { formatDayMonth, formatShortDate } from "../dates";
import { inGroup, withoutGroup, withoutRow, withoutRows } from "../inbox";
import { merchantLabel } from "../format";
import { formatUnsigned } from "../money";
import { overrideOf } from "../overrides";
import { pickerOrder, useAccounts, useBudget, useCategories, useInbox, useInboxMerchants } from "../queries";
import { Link } from "../router";
import type { Back } from "../routes";
import { normalizePattern } from "../../worker/budget/resolve";
import { ageText } from "../pace";

// The weekly tidy-up (docs/ui-design.md, To sort). By merchant, one tap makes an exact rule that
// files the whole group and future ones; by date, one tap files just that transaction.

const CHIPS = 3;

type InboxPages = InfiniteData<Awaited<ReturnType<typeof getInbox>>, string | null>;

/** What the picker is choosing a category for. */
type Target = { kind: "group"; group: InboxMerchant; count: number } | { kind: "row"; row: Transaction };

const chip = "inline-flex min-h-11 shrink-0 items-center rounded-full border border-line bg-surface px-[15px] text-sm hover:border-muted";

function Chips({ choices, onPick, onMore }: { choices: Category[]; onPick: (c: Category) => void; onMore: () => void }) {
  return (
    <div className="-mx-3.5 flex gap-2 overflow-x-auto px-3.5 pb-0.5">
      {choices.map((c) => (
        <button key={c.id} type="button" className={chip} onClick={() => onPick(c)}>
          {c.name}
        </button>
      ))}
      <button type="button" className={chip} onClick={onMore}>
        More…
      </button>
    </div>
  );
}

function dateRange(rows: Transaction[]) {
  if (rows.length === 0) return "";
  const first = rows[rows.length - 1]!.txnDate;
  const last = rows[0]!.txnDate;
  return first === last ? formatDayMonth(last) : `${formatDayMonth(first)} – ${formatDayMonth(last)}`;
}

export function ToSort({ back }: { back: Back }) {
  const merchants = useInboxMerchants();
  const inbox = useInbox();
  const accounts = useAccounts();
  const categories = useCategories();
  const budget = useBudget();
  const [byDate, setByDate] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [open, setOpen] = useState<Transaction | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // One pass over the loaded inbox rows: posted rows by group pattern, pending ones apart.
  const { posted, pending, byPattern } = useMemo(() => {
    const rows = inbox.data?.pages.flatMap((p) => p.transactions) ?? [];
    const byPattern = new Map<string, { posted: Transaction[]; pending: number }>();
    for (const r of rows) {
      const pattern = normalizePattern(r.merchant);
      const entry = byPattern.get(pattern) ?? { posted: [], pending: 0 };
      if (r.editable) entry.posted.push(r);
      else entry.pending += 1;
      byPattern.set(pattern, entry);
    }
    return { posted: rows.filter((r) => r.editable), pending: rows.filter((r) => !r.editable), byPattern };
  }, [inbox.data]);
  const rowsOf = (g: InboxMerchant) => byPattern.get(g.pattern)?.posted ?? [];
  // Groups count pending rows too; those wait in the pending section until they post.
  const groups = (merchants.data ?? []).map((g) => ({ g, count: g.count - (byPattern.get(g.pattern)?.pending ?? 0) })).filter(({ count }) => count > 0);
  const postedTotal = Math.max((inbox.data?.pages[0]?.total ?? 0) - pending.length, 0);

  // Biggest allocations first: the likeliest homes for an unsorted purchase.
  const allocation = new Map(budget.data?.categories.map((c) => [c.categoryId, c.allocatedMinor]));
  const choices = pickerOrder(categories.data?.all ?? [])
    .filter((c) => c.kind === "budgeted")
    .sort((a, b) => (allocation.get(b.id) ?? 0) - (allocation.get(a.id) ?? 0))
    .slice(0, CHIPS);

  const queryClient = useQueryClient();
  /**
   * A filing's own result, applied to the loaded inbox and groups (src/web/inbox.ts). Its
   * mutation has `meta: { refetch: "none" }`, so the backlog isn't read again on every tap; the
   * inbox is marked stale again here, so it refetches on the next visit.
   */
  const settle = async (drop: (t: Transaction) => boolean, removed: number, groups: (g: InboxMerchant[]) => InboxMerchant[]) => {
    // A refetch already in flight would overwrite this with the rows before the filing.
    await queryClient.cancelQueries({ queryKey: ["inbox"] });
    queryClient.setQueryData<InboxPages>(["inbox", "list"], (d) => d && withoutRows(d, drop, removed));
    queryClient.setQueryData<{ merchants: InboxMerchant[] }>(["inbox", "merchants"], (d) => d && { merchants: groups(d.merchants) });
    void queryClient.invalidateQueries({ queryKey: ["inbox"], refetchType: "none" });
  };

  const fail = (e: unknown) => setFailed(apiErrorText(e, {}, "Couldn't file that. Check your connection and try again."));
  // Toast actions (Undo, Always) go through a mutation too, so they refresh the screens like any write.
  const followUp = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: () => setFailed(null), onError: fail });

  const fileGroup = useMutation({
    mutationFn: ({ group, category }: { group: InboxMerchant; category: Category; count: number }) => createRule({ matchType: "exact", pattern: group.pattern, categoryId: category.id }),
    meta: { refetch: "none" },
    onSuccess: ({ rule }, { group, category, count }) => {
      setFailed(null);
      // The any-account exact rule files the whole group, pending rows included.
      void settle(inGroup(group.pattern), group.count, (gs) => withoutGroup(gs, group.pattern));
      setToast({
        text: `Rule added: ${group.merchant} → ${category.name}. ${count === 1 ? "Filed." : `All ${count} filed.`}`,
        actions: [{ label: "Undo", run: () => followUp.mutate(() => deleteRule(rule.id)) }],
      });
    },
    onError: fail,
  });

  const fileRow = useMutation({
    mutationFn: ({ row, category }: { row: Transaction; category: Category }) => putOverride(row.id, { ...overrideOf(row), categoryId: category.id }),
    meta: { refetch: "none" },
    onSuccess: (_, { row, category }) => {
      setFailed(null);
      void settle((t) => t.id === row.id, 1, (gs) => withoutRow(gs, row));
      const undo = { label: "Undo", run: () => followUp.mutate(() => putOverride(row.id, overrideOf(row))) };
      const always = {
        label: "Always",
        run: () =>
          followUp.mutate(() => putOverride(row.id, { ...overrideOf(row), categoryId: category.id, applyToMerchant: true }), {
            onSuccess: () => setToast({ text: `All ${merchantLabel(row)} transactions now go to ${category.name}.`, actions: [] }),
          }),
      };
      setToast({ text: `${merchantLabel(row)} filed under ${category.name} (just this one)`, actions: [always, undo] });
    },
    onError: fail,
  });

  const pick = (t: Target, category: Category) => {
    setTarget(null);
    if (t.kind === "group") fileGroup.mutate({ group: t.group, category, count: t.count });
    else fileRow.mutate({ row: t.row, category });
  };

  const loading = merchants.isPending || inbox.isPending;
  const error = merchants.isError || inbox.isError;
  const accountOf = (id: number) => accounts.data?.byId.get(id);
  const lastChange = (accounts.data?.all ?? []).reduce<string | null>((max, a) => (a.importEnabled && a.lastDataChangeAt && (!max || a.lastDataChangeAt > max) ? a.lastDataChangeAt : max), null);

  return (
    <PushedScreen back={back} title="To sort">
      <div className="mx-5 -mt-1 flex flex-wrap items-baseline justify-between gap-x-3">
        {lastChange ? (
          <Link href="/accounts" className="inline-flex min-h-[30px] items-center gap-1.5 text-[12.5px] text-muted hover:text-fg">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
            Updated {ageText(lastChange)}
          </Link>
        ) : (
          <span />
        )}
        {!loading && postedTotal > 0 && (
          <span className="text-sm font-medium text-accent-fg">
            {postedTotal} to sort · {groups.length} {groups.length === 1 ? "merchant" : "merchants"}
          </span>
        )}
      </div>

      <Segmented
        className="mx-4 mt-2"
        label="Group transactions"
        value={byDate ? "date" : "merchant"}
        options={[
          { value: "merchant", label: "By merchant" },
          { value: "date", label: "By date" },
        ]}
        onChange={(v) => setByDate(v === "date")}
      />

      {failed && <ErrorBanner className="mx-4 mt-3">{failed}</ErrorBanner>}

      <div className="flex flex-col gap-2.5 px-4 pt-3">
        {loading ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-[170px] rounded-card" />)
        ) : error ? (
          <LoadError what="what's left to sort" onRetry={() => void Promise.all([merchants.refetch(), inbox.refetch()])} />
        ) : postedTotal === 0 ? (
          <div className="rounded-card border border-divider bg-surface px-5 py-7 text-center">
            <div className="text-[17px]">All sorted</div>
            <p className="mt-1 text-[13.5px] leading-normal text-muted">Your category totals are now up to date. This screen closes until new uncategorised transactions arrive.</p>
            <Link href="/" className="mt-3.5 flex min-h-12 items-center justify-center rounded-button bg-accent text-[15px] font-medium text-on-accent">
              Back to Home
            </Link>
          </div>
        ) : byDate ? (
          posted.map((row) => (
            <article key={row.id} className="flex flex-col gap-2.5 rounded-card border border-divider bg-surface p-3.5">
              <button type="button" className="-m-1 flex items-start gap-2.5 rounded-input p-1 text-left hover:bg-raised" onClick={() => setOpen(row)}>
                <div className="min-w-0 flex-1">
                  <div className="text-base font-medium break-words">{merchantLabel(row)}</div>
                  <div className="mt-[3px] flex items-center gap-1.5 text-[12.5px] text-muted">
                    {formatShortDate(row.txnDate)} <AccountBadge account={accountOf(row.accountId)} />
                  </div>
                </div>
                <div className="text-base">{formatUnsigned(row.countedAmountMinor ?? row.amountMinor, row.currency)}</div>
              </button>
              <Chips choices={choices} onPick={(c) => pick({ kind: "row", row }, c)} onMore={() => setTarget({ kind: "row", row })} />
            </article>
          ))
        ) : (
          groups.map(({ g, count }) => {
            const groupRows = rowsOf(g);
            const isOpen = expanded.includes(g.pattern) || !g.rulable;
            const accountIds = [...new Set(groupRows.map((r) => r.accountId))];
            return (
              <article key={g.pattern} className="flex flex-col gap-2 rounded-card border border-divider bg-surface px-3.5 pt-3.5 pb-3">
                <div className="flex items-start gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-medium break-words">{g.merchant || "Unknown merchant"}</span>
                      {count > 1 && <span className="rounded-md bg-accent-tint px-[7px] py-px text-[11.5px] font-medium text-accent-fg">×{count}</span>}
                    </div>
                    <div className="mt-[3px] flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
                      <span>{dateRange(groupRows) || `Latest ${formatDayMonth(g.latestDate)}`}</span>
                      {accountIds.map((id) => (
                        <AccountBadge key={id} account={accountOf(id)} />
                      ))}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-base">{formatUnsigned(g.totalMinor, "GBP")}</div>
                    <div className="text-[11.5px] text-muted">{g.totalMinor > 0 ? "money in" : "total"}</div>
                  </div>
                </div>
                {g.rulable ? (
                  <>
                    <p className="text-[12.5px] text-muted">
                      {count === 1 ? "One tap makes a rule and files it, plus future ones." : `One tap makes a rule and files all ${count}, plus future ones.`} Open the list to file one on its own.
                    </p>
                    <Chips choices={choices} onPick={(c) => pick({ kind: "group", group: g, count }, c)} onMore={() => setTarget({ kind: "group", group: g, count })} />
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      className="inline-flex min-h-11 items-center gap-1 self-start text-[13px] font-medium text-accent-fg"
                      onClick={() => setExpanded((e) => (isOpen ? e.filter((p) => p !== g.pattern) : [...e, g.pattern]))}
                    >
                      {isOpen ? "Hide transactions" : `Show ${count} ${count === 1 ? "transaction" : "transactions"}`}
                      <ChevronDown size={14} className={isOpen ? "rotate-180" : ""} />
                    </button>
                  </>
                ) : (
                  <p className="text-[12.5px] text-muted">This merchant's name can't be used for a rule, so file its transactions one by one.</p>
                )}
                {isOpen && (
                  <ul className="border-t border-divider">
                    {groupRows.map((r) => (
                      <li key={r.id}>
                        <button type="button" className="flex min-h-[46px] w-full items-center gap-2.5 border-b border-divider px-1 text-left text-[14.5px] last:border-b-0 hover:bg-raised" onClick={() => setOpen(r)}>
                          <span className="flex-1">{formatShortDate(r.txnDate)}</span>
                          <AccountBadge account={accountOf(r.accountId)} />
                          <span className="w-[72px] text-right">{formatUnsigned(r.countedAmountMinor ?? r.amountMinor, r.currency)}</span>
                          <ChevronRight size={14} className="text-subtle" />
                        </button>
                      </li>
                    ))}
                    {groupRows.length < count && inbox.hasNextPage && (
                      <li>
                        <button type="button" className="min-h-11 text-[13px] font-medium text-accent-fg" onClick={() => void inbox.fetchNextPage()}>
                          {inbox.isFetchingNextPage ? "Loading…" : "Load older transactions"}
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </article>
            );
          })
        )}
        {byDate && inbox.hasNextPage && (
          <Button kind="secondary" onClick={() => void inbox.fetchNextPage()} disabled={inbox.isFetchingNextPage}>
            {inbox.isFetchingNextPage ? "Loading…" : "Show older"}
          </Button>
        )}
      </div>

      {pending.length > 0 && (
        <section aria-labelledby="to-sort-pending">
          <div className="flex items-center gap-2 px-5 pt-[22px] pb-2">
            <SectionLabel id="to-sort-pending">Pending · {pending.length}</SectionLabel>
            <span className="text-xs text-muted">Can be sorted once they post</span>
          </div>
          <ul className="mx-4 mb-6 rounded-card border border-divider bg-surface px-3.5">
            {pending.map((r) => (
              <li key={r.id}>
                <button type="button" className="flex min-h-[58px] w-full items-center gap-2.5 border-b border-divider text-left last:border-b-0" onClick={() => setOpen(r)}>
                  <Lock size={15} className="text-muted" />
                  <span className="sr-only">Locked:</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{merchantLabel(r)}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted">
                      Pending since {formatShortDate(r.txnDate)} <AccountBadge account={accountOf(r.accountId)} />
                    </span>
                  </span>
                  <span className="text-muted italic">{formatUnsigned(r.amountMinor, r.currency)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Sheet open={target !== null} onDismiss={() => setTarget(null)} labelledBy="txn-sheet-title" full>
        {target && (
          <CategoryPicker current={null} categories={pickerOrder(categories.data?.all ?? [])} onBack={() => setTarget(null)} onPick={(id) => {
            const category = id === null ? undefined : categories.data?.byId.get(id);
            if (category) pick(target, category);
          }} />
        )}
      </Sheet>
      <TransactionSheet txn={open} onClose={() => setOpen(null)} />
      <Toast toast={toast} onDone={() => setToast(null)} />
    </PushedScreen>
  );
}
