import { useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, putCategoryBudget, putOverallBudget, type Budget as BudgetData } from "../api";
import { LoadError, TabScreen } from "../components/Screen";
import { FieldError, Skeleton } from "../components/ui";
import { monthName } from "../dates";
import { formatPounds, parseMoneyInput, poundsInput } from "../money";
import { useBudget, useCategories } from "../queries";
import { Link } from "../router";

// Budget settings (docs/ui-design.md): the overall figure first, then allocations, with Misc as
// the live unallocated remainder. Each field saves when it's left; the server re-checks every
// limit, and its 422s carry the figures the errors quote.

/** Sage shades for the allocation segments and their row dots, biggest allocation first. */
const SHADES = ["bg-accent", "bg-accent/80", "bg-accent/65", "bg-accent/50", "bg-accent/40", "bg-accent/30"];

type Drafts = Record<number, string>;

const withoutDraft = (id: number) => (drafts: Drafts) => Object.fromEntries(Object.entries(drafts).filter(([k]) => Number(k) !== id));

function BudgetForm({ budget }: { budget: BudgetData }) {
  const queryClient = useQueryClient();
  const categories = useCategories();
  const [overallText, setOverallText] = useState(budget.overallMinor === null ? "" : poundsInput(budget.overallMinor));
  const [drafts, setDrafts] = useState<Drafts>({});
  // Categories added with "+ Allocate to another category" in this visit, shown even at £0.
  const [added, setAdded] = useState<number[]>([]);
  const [picking, setPicking] = useState(false);
  const [serverError, setServerError] = useState<{ field: "overall" | number; text: string } | null>(null);

  // The PUTs answer with the new budget, so it's shown at once; the shell refreshes the rest.
  const onSaved = (next: BudgetData) => queryClient.setQueryData(["budget"], next);
  const saveOverall = useMutation({
    mutationFn: putOverallBudget,
    onSuccess: (next) => {
      setServerError(null);
      onSaved(next);
    },
    onError: (e) =>
      setServerError({
        field: "overall",
        text:
          e instanceof ApiError && e.body?.minOverallMinor !== undefined
            ? belowAllocatedText(e.body.minOverallMinor)
            : "Couldn't save the budget. Try again.",
      }),
  });
  const saveCategory = useMutation({
    mutationFn: ({ id, amount }: { id: number; amount: number }) => putCategoryBudget(id, amount),
    onSuccess: (next, { id }) => {
      setServerError(null);
      setDrafts(withoutDraft(id));
      onSaved(next);
    },
    onError: (e, { id }) => {
      const name = categories.data?.byId.get(id)?.name ?? "This category";
      const saved = budget.categories.find((c) => c.categoryId === id)?.allocatedMinor ?? 0;
      const max = e instanceof ApiError ? e.body?.maxAllocatableMinor : undefined;
      setServerError({ field: id, text: max !== undefined ? overAllocatedText(name, max, saved, budget.overallMinor ?? 0) : "Couldn't save this allocation. Try again." });
    },
  });

  const overallDraft = overallText.trim() === "" ? null : parseMoneyInput(overallText);
  const overall = overallDraft ?? budget.overallMinor ?? 0;
  const amountOf = (id: number, saved: number) => (drafts[id] === undefined ? saved : (parseMoneyInput(drafts[id]) ?? saved));
  const rows = budget.categories
    .filter((c) => c.allocatedMinor > 0 || drafts[c.categoryId] !== undefined || added.includes(c.categoryId))
    .map((c) => ({ ...c, amount: amountOf(c.categoryId, c.allocatedMinor), name: categories.data?.byId.get(c.categoryId)?.name ?? "Category" }))
    .sort((a, b) => b.allocatedMinor - a.allocatedMinor || a.name.localeCompare(b.name));
  const allocated = rows.reduce((sum, r) => sum + r.amount, 0);
  const unallocated = overall - allocated;
  const over = unallocated < 0;
  const unlisted = budget.categories.filter((c) => !rows.some((r) => r.categoryId === c.categoryId));

  // Client-side checks mirror the server's, so nothing invalid is sent.
  // Client checks block a save; a server error is shown until the next attempt but never blocks one.
  const overallClientError = (() => {
    if (overallText.trim() !== "" && overallDraft === null) return "Enter an amount in pounds, like 1,500.";
    if (overallDraft !== null && overallDraft <= 0) return "Set a budget above £0.";
    if (overallDraft !== null && overallDraft < budget.allocatedMinor) return belowAllocatedText(budget.allocatedMinor);
    return null;
  })();
  const overallError = overallClientError ?? (serverError?.field === "overall" ? serverError.text : null);
  const rowClientError = (r: (typeof rows)[number]) => {
    const text = drafts[r.categoryId];
    if (text !== undefined && text.trim() !== "" && parseMoneyInput(text) === null) return "Enter an amount in pounds, like 120.";
    if (budget.overallMinor !== null && r.amount > r.allocatedMinor && r.maxAllocatableMinor !== null && r.amount > r.maxAllocatableMinor) {
      return overAllocatedText(r.name, r.maxAllocatableMinor, r.allocatedMinor, budget.overallMinor);
    }
    return null;
  };
  const rowError = (r: (typeof rows)[number]) => rowClientError(r) ?? (serverError?.field === r.categoryId ? serverError.text : null);
  const anyRowError = rows.some((r) => rowError(r) !== null);
  const saving = saveOverall.isPending || saveCategory.isPending;

  const commitOverall = () => {
    if (overallClientError || overallDraft === null || overallDraft === budget.overallMinor) return;
    saveOverall.mutate(overallDraft);
  };
  const commitRow = (r: (typeof rows)[number]) => {
    const text = drafts[r.categoryId];
    if (text === undefined || rowClientError(r)) return;
    const amount = text.trim() === "" ? 0 : parseMoneyInput(text);
    if (amount === null) return;
    if (amount === r.allocatedMinor) setDrafts(withoutDraft(r.categoryId));
    else saveCategory.mutate({ id: r.categoryId, amount });
  };

  const status = (() => {
    if (overallError) return { text: "Not saved · fix the budget above", ...TONE.over };
    if (anyRowError) return { text: "Not saved · fix the allocation below", ...TONE.over };
    if (saving) return { text: "Saving…", ...TONE.muted };
    if (budget.overallMinor === null) return { text: "Not set yet", ...TONE.muted };
    return { text: `Saved · applies from ${monthName(budget.month)}`, ...TONE.ok };
  })();

  const scale = Math.max(overall, allocated, 1);
  const enterCommits = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  return (
    <TabScreen
      title="Budget"
      titleExtra={
        <p role="status" className={`mt-1 flex items-center gap-1.5 text-[12.5px] ${status.tone}`}>
          <span className={`size-1.5 rounded-full ${status.dot}`} aria-hidden="true" />
          {status.text}
        </p>
      }
      action={
        <Link href="/categories" className="inline-flex min-h-11 items-center px-1 text-accent-fg">
          Categories
        </Link>
      }
    >
      <section className="mx-4 mt-3.5 rounded-card border border-divider bg-surface px-4 pt-3.5 pb-4">
        <div className="flex items-center gap-2">
          <Step n={1} />
          <label htmlFor="budget-overall" className="font-medium">
            Monthly budget
          </label>
        </div>
        <div className={`mt-2 flex items-baseline gap-1 border-b pb-1 ${overallError ? "border-over" : "border-line focus-within:border-accent"}`}>
          <span className="text-[32px] font-extralight text-muted">£</span>
          <input
            id="budget-overall"
            inputMode="decimal"
            autoComplete="off"
            placeholder="1,500"
            value={overallText}
            aria-invalid={overallError !== null}
            aria-describedby={overallError ? "budget-overall-error" : undefined}
            onChange={(e) => {
              setOverallText(e.target.value);
              if (serverError?.field === "overall") setServerError(null);
            }}
            onBlur={commitOverall}
            onKeyDown={enterCommits}
            className="w-full bg-transparent p-0 text-[42px] font-extralight tracking-[-0.03em] outline-none placeholder:text-muted/50"
          />
        </div>
        {overallError && (
          <div className="pt-2 pb-2.5">
            <FieldError id="budget-overall-error">{overallError}</FieldError>
          </div>
        )}
        <p className="mt-2 text-[12.5px] leading-normal text-muted">Everything you spend in a calendar month, bills included. Starts fresh on the 1st, nothing rolls over.</p>
      </section>

      <section className="mx-4 mt-3 rounded-card border border-divider bg-surface px-4 pt-3.5 pb-1.5" aria-labelledby="budget-allocate">
        <div className="flex items-center gap-2">
          <Step n={2} />
          <h2 id="budget-allocate" className="font-medium">
            Allocate to categories
          </h2>
        </div>
        {budget.overallMinor === null ? (
          <p className="mt-2 pb-3 text-[12.5px] text-muted">Set your monthly budget first, then split it into categories here.</p>
        ) : (
          <>
            <div className="relative mt-3.5">
              <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                {rows.map((r, i) =>
                  r.amount > 0 ? <div key={r.categoryId} className={rowError(r) ? "bg-over" : SHADES[i % SHADES.length]} style={{ width: `${(r.amount / scale) * 100}%` }} /> : null,
                )}
                {!over && unallocated > 0 && <div className="hatch flex-1 opacity-25" />}
              </div>
              {over && <div className="absolute -top-[5px] -bottom-[5px] w-0.5 bg-fg" style={{ left: `${(overall / scale) * 100}%` }} aria-hidden="true" />}
            </div>
            <div className="mt-[9px] flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="text-[12.5px] text-muted">
                {formatPounds(allocated)} of {formatPounds(overall)} allocated
              </span>
              <span className={`font-medium ${over ? "text-over-fg" : ""}`}>{over ? `${formatPounds(-unallocated)} over-allocated` : `${formatPounds(unallocated)} unallocated (Misc)`}</span>
            </div>

            <ul className="mt-1.5">
              {rows.map((r, i) => {
                const error = rowError(r);
                const inputId = `alloc-${r.categoryId}`;
                return (
                  <li key={r.categoryId} className="border-b border-divider">
                    <div className="flex items-center gap-3 py-[9px]">
                      <span className={`size-[9px] shrink-0 rounded-[3px] ${error ? "bg-over" : SHADES[i % SHADES.length]}`} aria-hidden="true" />
                      <label htmlFor={inputId} className="min-w-0 flex-1">
                        {r.name}
                      </label>
                      <span
                        className={`flex h-[42px] w-[118px] shrink-0 items-center gap-0.5 rounded-input border bg-raised px-2.5 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent ${error ? "border-over" : "border-line"}`}
                      >
                        <span className="text-[15px] text-muted">£</span>
                        <input
                          id={inputId}
                          inputMode="decimal"
                          autoComplete="off"
                          value={drafts[r.categoryId] ?? poundsInput(r.allocatedMinor)}
                          aria-invalid={error !== null}
                          aria-describedby={error ? `${inputId}-error` : undefined}
                          onChange={(e) => {
                            const value = e.target.value;
                            setDrafts((d) => ({ ...d, [r.categoryId]: value }));
                            if (serverError?.field === r.categoryId) setServerError(null);
                          }}
                          onBlur={() => commitRow(r)}
                          onKeyDown={enterCommits}
                          className="w-full bg-transparent p-0 text-right text-base outline-none"
                        />
                      </span>
                    </div>
                    {error && (
                      <div className="pb-2.5">
                        <FieldError id={`${inputId}-error`}>{error}</FieldError>
                      </div>
                    )}
                  </li>
                );
              })}
              <li className="flex items-center gap-3 pt-[11px] pb-1">
                <span className="hatch size-[9px] shrink-0 rounded-[3px] opacity-60" aria-hidden="true" />
                <div className="flex-1">
                  <div>Misc</div>
                  <div className="text-[11.5px] text-muted">Whatever is unallocated</div>
                </div>
                <span className={`w-[118px] pr-[11px] text-right text-base ${over ? "text-over-fg" : ""}`}>{formatPounds(Math.max(unallocated, 0))}</span>
              </li>
            </ul>

            {unlisted.length > 0 &&
              (picking ? (
                <div className="mt-2.5 flex flex-wrap gap-2" role="group" aria-label="Allocate to another category">
                  {unlisted.map((c) => (
                    <button
                      key={c.categoryId}
                      type="button"
                      className="min-h-11 rounded-full border border-line bg-surface px-4"
                      onClick={() => {
                        setAdded((a) => [...a, c.categoryId]);
                        setDrafts((d) => ({ ...d, [c.categoryId]: "" }));
                        setPicking(false);
                        requestAnimationFrame(() => document.getElementById(`alloc-${c.categoryId}`)?.focus());
                      }}
                    >
                      {categories.data?.byId.get(c.categoryId)?.name ?? "Category"}
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  className="mt-2.5 min-h-[46px] w-full rounded-[12px] border border-dashed border-line font-medium text-accent-fg hover:border-accent"
                  onClick={() => setPicking(true)}
                >
                  + Allocate to another category
                </button>
              ))}
          </>
        )}
        <p className="mt-2.5 mb-2 text-xs leading-normal text-muted">Only budgeted categories appear here. Tracked and excluded ones never count against your budget.</p>
      </section>
    </TabScreen>
  );
}

const TONE = {
  over: { tone: "text-over-fg", dot: "bg-over" },
  muted: { tone: "text-muted", dot: "bg-muted" },
  ok: { tone: "text-accent-fg", dot: "bg-accent" },
};

const belowAllocatedText = (minMinor: number) => `Your allocations add up to ${formatPounds(minMinor)}. Set at least ${formatPounds(minMinor)}, or lower an allocation first.`;

function overAllocatedText(name: string, maxMinor: number, savedMinor: number, overallMinor: number) {
  return `You can allocate at most ${formatPounds(Math.max(maxMinor - savedMinor, 0))} more (${name} up to ${formatPounds(maxMinor)}). Allocations can't exceed your ${formatPounds(overallMinor)} budget.`;
}

const Step = ({ n }: { n: number }) => (
  <span className="inline-grid size-5 place-items-center rounded-full border border-muted/50 text-[11px] font-medium text-fg/80" aria-hidden="true">
    {n}
  </span>
);

export function Budget() {
  const budget = useBudget();
  if (budget.data) return <BudgetForm budget={budget.data} />;
  return (
    <TabScreen title="Budget">
      {budget.isError ? (
        <LoadError what="your budget" onRetry={() => void budget.refetch()} />
      ) : (
        <div className="mx-4 mt-3.5 flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-[150px] rounded-card" />
          <Skeleton className="h-[320px] rounded-card" />
        </div>
      )}
    </TabScreen>
  );
}
