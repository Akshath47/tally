import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError, deleteOverride, putOverride, type Account, type Category, type Transaction } from "../api";
import { formatShortDate, monthName, monthOf } from "../dates";
import { merchantLabel } from "../format";
import { formatUnsigned, minorToInput } from "../money";
import { buildOverride, draftOf, type Draft } from "../overrides";
import { pickerOrder, useAccounts, useCategories, useInvalidateAll } from "../queries";
import { Sheet } from "./Sheet";
import { AccountBadge, ChevronLeft, ChevronRight, Info, Lock, Pencil } from "./ui";

// The transaction editor and the read-only sheet for pending or replaced rows (docs/ui-design.md).

const KIND_LABEL = { budgeted: "Budgeted", tracked: "Tracked", excluded: "Excluded" } as const;

const SAVE_ERRORS: Record<string, string> = {
  not_editable: "This transaction can't be edited any more. It may have been replaced by its posted version.",
  category_archived: "That category is archived. Pick another one.",
  merchant_not_rulable: "This merchant's name can't be used for a rule, so only this transaction can change.",
};

const errorText = (e: unknown) => (e instanceof ApiError && e.body && SAVE_ERRORS[e.body.error]) || "Couldn't save. Check your connection and try again.";

/** Whether and how a row counts, in the words the read-only sheet uses. */
function countsText(t: Transaction, category: Category | undefined) {
  if (t.vanishedAt) return "No, it was replaced";
  if (t.excluded || category?.kind === "excluded") return "No";
  if (category?.kind === "tracked") return "No, tracked only";
  if (category) return `Yes, as ${category.name}`;
  return (t.countedAmountMinor ?? t.amountMinor) < 0 ? "Yes, as Misc for now" : "No, money in waits to be sorted";
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-[50px] items-center justify-between gap-3 border-b border-divider px-3.5 last:border-b-0">
      <span>{label}</span>
      <span className="text-right text-muted">{value}</span>
    </div>
  );
}

function ReadOnly({ t, account, category, onClose }: { t: Transaction; account: Account | undefined; category: Category | undefined; onClose: () => void }) {
  const amount = formatUnsigned(t.countedAmountMinor ?? t.amountMinor, t.currency);
  const month = monthName(monthOf(t.countedDate ?? t.txnDate));
  return (
    <div className="flex flex-col gap-3.5 overflow-y-auto px-4 pt-2 pb-4">
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 id="txn-sheet-title" className="text-xl font-medium break-words">
            {merchantLabel(t)}
          </h2>
          <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted">
            <AccountBadge account={account} />
            {t.vanishedAt ? "Replaced by its posted version" : `Pending since ${formatShortDate(t.txnDate)}`}
          </div>
        </div>
        <div className="text-[28px] font-extralight text-fg/80 italic">{amount}</div>
      </div>
      <div className="flex items-start gap-2.5 rounded-button border border-line bg-surface px-3.5 py-3 text-[13px] leading-normal text-fg/80">
        <Lock size={17} className="mt-px shrink-0" />
        <p>
          {t.vanishedAt
            ? "This pending charge was replaced when the bank posted it, so it no longer counts. The posted version is the one to edit."
            : `Pending transactions can't be edited. It already counts towards ${month}'s spend. Once ${account?.name ?? "the bank"} posts it, usually in 1 to 3 days, ${category ? "it can be edited" : "it shows up in To sort"}.`}
        </p>
      </div>
      <div className="overflow-hidden rounded-2xl border border-divider bg-surface" aria-label="Details, read-only">
        <ReadOnlyRow label="Category" value={category?.name ?? "Uncategorised"} />
        <ReadOnlyRow label="Counts towards spend" value={countsText(t, category)} />
        <ReadOnlyRow label="Amount" value={amount} />
        <ReadOnlyRow label="Date" value={formatShortDate(t.txnDate)} />
      </div>
      <button type="button" className="mt-4 min-h-[52px] rounded-button border border-line bg-raised text-[15.5px] font-medium" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[54px] items-center gap-3 border-b border-divider px-3.5 py-2 last:border-b-0">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="w-[118px] shrink-0">
          {label}
        </label>
      ) : (
        <span className="w-[118px] shrink-0">{label}</span>
      )}
      {children}
    </div>
  );
}

const inputClass = "h-10 w-full rounded-[10px] border border-line bg-raised px-2.5 text-[15px] focus:border-accent focus:outline-2 focus:outline-offset-1 focus:outline-accent";

export function CategoryPicker({ current, categories, onPick, onBack }: { current: number | null; categories: Category[]; onPick: (id: number | null) => void; onBack: () => void }) {
  const kinds = ["budgeted", "tracked", "excluded"] as const;
  return (
    <>
      <div className="flex items-center px-2 pt-0.5">
        <button type="button" className="inline-flex min-h-11 items-center gap-0.5 px-2 text-[15.5px] text-accent-fg" onClick={onBack}>
          <ChevronLeft size={18} />
          Back
        </button>
        <h2 id="txn-sheet-title" className="flex-1 pr-16 text-center text-[15.5px] font-medium">
          Category
        </h2>
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pt-2 pb-6">
        {kinds.map((kind) => {
          const list = categories.filter((c) => c.kind === kind);
          if (list.length === 0) return null;
          return (
            <section key={kind}>
              <h3 className="mb-1.5 px-1 text-[11.5px] font-medium tracking-[0.08em] text-muted uppercase">{KIND_LABEL[kind]}</h3>
              <div className="overflow-hidden rounded-2xl border border-divider bg-surface">
                {list.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={c.id === current}
                    className={`flex min-h-12 w-full items-center justify-between border-b border-divider px-3.5 text-left last:border-b-0 ${c.id === current ? "bg-accent-tint text-accent-fg" : "hover:bg-raised"}`}
                    onClick={() => onPick(c.id)}
                  >
                    {c.name}
                    {c.id === current && <span className="text-meta">Selected</span>}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function Editor({ t, account, categories, byId, onClose, onSaved }: {
  t: Transaction;
  account: Account | undefined;
  categories: Category[];
  byId: Map<number, Category>;
  onClose: () => void;
  onSaved?: (t: Transaction) => void;
}) {
  const invalidateAll = useInvalidateAll();
  const bankAmount = formatUnsigned(t.amountMinor, t.currency);
  const [draft, setDraft] = useState<Draft>(() => draftOf(t, minorToInput(t.countedAmountMinor ?? t.amountMinor)));
  const [picking, setPicking] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const shownCategoryId = draft.categoryId === undefined ? t.categoryId : draft.categoryId;
  const category = shownCategoryId === null ? undefined : byId.get(shownCategoryId);
  const merchant = merchantLabel(t);
  const built = buildOverride(t, draft);
  const edited = t.categorySource === "override" || t.excluded || t.countedAmountMinor !== null || t.countedDate !== null || t.note !== null;
  const amountOrDateChanged = "body" in built ? built.body.countedAmountMinor !== null || built.body.countedDate !== null : true;
  const newMonth = monthOf(draft.date) !== monthOf(t.txnDate) && /^\d{4}-\d{2}-\d{2}$/.test(draft.date);

  const done = (next: Transaction) => {
    void invalidateAll();
    onSaved?.(next);
    onClose();
  };
  const save = useMutation({ mutationFn: () => putOverride(t.id, "body" in built ? built.body : {}), onSuccess: (r) => done(r.transaction) });
  const reset = useMutation({ mutationFn: () => deleteOverride(t.id), onSuccess: (r) => done(r.transaction) });
  const busy = save.isPending || reset.isPending;
  const error = save.isError ? errorText(save.error) : reset.isError ? errorText(reset.error) : null;

  if (picking) {
    return (
      <CategoryPicker
        current={shownCategoryId}
        categories={categories}
        onBack={() => setPicking(false)}
        onPick={(id) => {
          set({ categoryId: id });
          setPicking(false);
        }}
      />
    );
  }

  return (
    <>
      <div className="flex items-center justify-between px-2 pt-0.5">
        <button type="button" className="min-h-11 px-3 text-[15.5px] text-accent-fg" onClick={onClose}>
          Cancel
        </button>
        <h2 id="txn-sheet-title" className="text-[15.5px] font-medium">
          Edit transaction
        </h2>
        <button type="button" className="min-h-11 px-3 text-[15.5px] font-semibold text-accent-fg disabled:opacity-40" disabled={!("body" in built) || busy} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-2 pb-6">
        <div className="flex items-end justify-between gap-3 px-1 pt-1">
          <div className="min-w-0">
            <div className="text-xl font-medium tracking-[-0.01em] break-words">{merchant}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
              <AccountBadge account={account} />
              Posted {formatShortDate(t.txnDate)}
              {edited && (
                <span className="inline-flex items-center gap-1 rounded-md bg-accent-tint px-[7px] py-0.5 text-[11px] font-medium text-accent-fg">
                  <Pencil size={10} />
                  Edited
                </span>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[28px] font-extralight tracking-[-0.02em]">{"body" in built ? formatUnsigned(built.body.countedAmountMinor ?? t.amountMinor, t.currency) : "—"}</div>
            <div className="text-[11.5px] text-muted">counted</div>
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded-button border border-over/40 bg-over-tint px-3.5 py-3 text-[13px] text-over-fg">
            {error}
          </p>
        )}

        {amountOrDateChanged && "body" in built && (
          <div className="flex items-start gap-2.5 rounded-button border border-accent/20 bg-accent-tint/70 px-3.5 py-3">
            <Info size={17} className="mt-px shrink-0 text-accent-fg" />
            <p className="flex-1 text-[13px] leading-normal text-fg/85">
              From the bank: <span className="font-semibold">{bankAmount}</span> on <span className="font-semibold">{formatShortDate(t.txnDate)}</span>. Your amount and date are used instead.
            </p>
            <button type="button" className="min-h-8 px-1 text-[13px] font-medium text-accent-fg" onClick={() => set({ amountText: minorToInput(t.amountMinor), date: t.txnDate })}>
              Reset
            </button>
          </div>
        )}

        <div className="overflow-hidden rounded-2xl border border-divider bg-surface">
          <button type="button" className="flex min-h-[54px] w-full items-center gap-3 border-b border-divider px-3.5 text-left hover:bg-raised" onClick={() => setPicking(true)}>
            <span className="w-[118px] shrink-0">Category</span>
            <span className={`flex-1 text-right text-[15px] ${category ? "" : "text-muted"}`}>{category?.name ?? "Uncategorised"}</span>
            <ChevronRight size={15} className="text-subtle" />
          </button>
          <div className="flex min-h-[54px] items-center gap-3 border-b border-divider px-3.5 py-2">
            <div className="flex-1">
              <div id="count-in-budget">Count in budget</div>
              <div className="text-[11.5px] text-muted">{draft.countInBudget ? (category ? `Counts against ${category.name}` : "Counts against Misc") : "Shown in spending, not in the budget"}</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={draft.countInBudget}
              aria-labelledby="count-in-budget"
              className={`flex h-[31px] w-[51px] shrink-0 rounded-full p-0.5 transition-colors ${draft.countInBudget ? "justify-end bg-accent" : "justify-start bg-line"}`}
              onClick={() => set({ countInBudget: !draft.countInBudget })}
            >
              <span className="size-[27px] rounded-full bg-fg shadow" />
            </button>
          </div>
          <Field label="Counted amount" htmlFor="counted-amount">
            <div className="flex flex-1 flex-col gap-[3px]">
              <div className="relative">
                <span className="absolute top-2.5 left-2.5 text-[15px] text-muted">£</span>
                <input id="counted-amount" inputMode="decimal" autoComplete="off" value={draft.amountText} onChange={(e) => set({ amountText: e.target.value })} className={`${inputClass} pl-[22px] text-right`} />
              </div>
              <span className="text-right text-[11.5px] text-muted">Bank: {bankAmount}</span>
            </div>
          </Field>
          <Field label="Counted date" htmlFor="counted-date">
            <div className="flex flex-1 flex-col gap-[3px]">
              <input id="counted-date" type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} className={`${inputClass} text-right [color-scheme:dark]`} />
              <span className="text-right text-[11.5px] text-muted">
                Bank: {formatShortDate(t.txnDate)}
                {newMonth && ` · now counts in ${monthName(monthOf(draft.date))}`}
              </span>
            </div>
          </Field>
          <div className="flex items-start gap-3 px-3.5 py-3">
            <label htmlFor="txn-note" className="w-[118px] shrink-0 pt-2">
              Note
            </label>
            <textarea id="txn-note" rows={2} maxLength={500} value={draft.note} onChange={(e) => set({ note: e.target.value })} className={`${inputClass} h-16 resize-none py-2 leading-snug`} />
          </div>
        </div>

        <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border bg-surface px-3.5 py-[13px] ${draft.applyToMerchant ? "border-accent/50" : "border-divider"}`}>
          <input
            type="checkbox"
            checked={draft.applyToMerchant}
            disabled={shownCategoryId === null}
            onChange={(e) => set({ applyToMerchant: e.target.checked })}
            className="mt-px size-[22px] shrink-0 accent-accent"
          />
          <span>
            <span className="block text-[15px] font-medium">Use for all {merchant}</span>
            <span className="mt-[3px] block text-[12.5px] leading-normal text-muted">
              {shownCategoryId === null
                ? "Pick a category first to use it for every transaction from this merchant."
                : draft.applyToMerchant
                  ? `All ${merchant} transactions go to ${category?.name}: the earlier ones you haven't edited, and every new one. Ones you've edited by hand keep their category.`
                  : `Only this transaction changes. Other ${merchant} transactions stay as they are.`}
            </span>
          </span>
        </label>
        {"error" in built && (
          <p role="alert" className="px-1 text-[12.5px] text-over-fg">
            {built.error}
          </p>
        )}

        {edited && (
          <button type="button" className="min-h-12 rounded-button border border-line text-[14.5px] font-medium text-over-fg disabled:opacity-50" disabled={busy} onClick={() => reset.mutate()}>
            {reset.isPending ? "Resetting…" : "Reset all changes to bank values"}
          </button>
        )}
      </div>
    </>
  );
}

/** Opens the editor for an editable row, or the read-only sheet for a pending or replaced one. */
export function TransactionSheet({ txn, onClose, onSaved }: { txn: Transaction | null; onClose: () => void; onSaved?: (t: Transaction) => void }) {
  const accounts = useAccounts();
  const categories = useCategories();
  const byId = categories.data?.byId ?? new Map<number, Category>();
  return (
    <Sheet open={txn !== null} onDismiss={onClose} labelledBy="txn-sheet-title" full={txn?.editable ?? false}>
      {txn &&
        (txn.editable ? (
          <Editor
            key={txn.id}
            t={txn}
            account={accounts.data?.byId.get(txn.accountId)}
            categories={pickerOrder(categories.data?.all ?? [])}
            byId={byId}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : (
          <ReadOnly t={txn} account={accounts.data?.byId.get(txn.accountId)} category={txn.categoryId === null ? undefined : byId.get(txn.categoryId)} onClose={onClose} />
        ))}
    </Sheet>
  );
}
