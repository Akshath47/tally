import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiErrorText, createCategory, createRule, deleteRule, updateCategory, updateRule, type Category, type CategoryKind, type MatchType, type Rule } from "../api";
import { LoadError, PushedScreen } from "../components/Screen";
import { Button, Dots, FieldError, Segmented, SectionLabel, Skeleton, inputClass, segmentClass, segmentGroupClass } from "../components/ui";
import { londonToday, monthOf } from "../dates";
import { formatMoney } from "../format";
import { formatPounds } from "../money";
import { KINDS, pickerOrder, useAccounts, useBudget, useCategories, useRules, useSummary } from "../queries";
import { isRulablePattern, normalizePattern } from "../../worker/budget/resolve";
import { Link } from "../router";
import type { Back } from "../routes";

// Categories and merchant rules (docs/ui-design.md). Categories are archived, never deleted.

// Rules' bad_request is about the pattern, which the client also checks before sending.
const RULE_ERRORS = { bad_request: "Use 1 to 100 characters, with no spaces at either end." };
const kindOptions = KINDS.map((k) => ({ value: k.kind, label: k.label }));

function Tabs({ active }: { active: "categories" | "rules" }) {
  const tab = (href: string, label: string, on: boolean) => (
    <Link href={href} aria-current={on ? "page" : undefined} className={segmentClass(on)}>
      {label}
    </Link>
  );
  return (
    <nav aria-label="Categories and rules" className={`mx-4 mt-3 ${segmentGroupClass}`}>
      {tab("/categories", "Categories", active === "categories")}
      {tab("/rules", "Merchant rules", active === "rules")}
    </nav>
  );
}

// --- Categories ---------------------------------------------------------------------------------

function CategoryEditor({ category, allocationMinor, ruleCount, onDone }: { category: Category; allocationMinor: number; ruleCount: number; onDone: () => void }) {
  const [name, setName] = useState(category.name);
  const [kind, setKind] = useState(category.kind);
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: (patch: { name?: string; kind?: CategoryKind; archived?: boolean }) => updateCategory(category.id, patch),
    onSuccess: onDone,
  });
  const givesBack = allocationMinor > 0 ? ` Its ${formatPounds(allocationMinor)} allocation goes back to Misc from this month.` : "";

  if (confirming) {
    return (
      <div role="alertdialog" aria-labelledby={`archive-${category.id}`} className="flex flex-col gap-2.5 border-b border-divider bg-over-tint px-3.5 pt-3 pb-3.5 last:border-b-0">
        <div id={`archive-${category.id}`} className="font-medium">
          Archive “{category.name}”?
        </div>
        <p className="text-[12.5px] leading-normal text-fg/75">
          It disappears from category pickers and budget settings. Its transactions{ruleCount > 0 ? ` and ${ruleCount} merchant ${ruleCount === 1 ? "rule" : "rules"}` : ""} keep pointing at it, so nothing moves.
          {givesBack} You can unarchive it any time.
        </p>
        {save.isError && <FieldError>{apiErrorText(save.error)}</FieldError>}
        <div className="flex justify-end gap-2">
          <Button kind="secondary" onClick={() => setConfirming(false)}>
            Keep
          </Button>
          <button type="button" className="min-h-11 rounded-button bg-over px-5 font-medium text-canvas disabled:opacity-50" disabled={save.isPending} onClick={() => save.mutate({ archived: true })}>
            Archive category
          </button>
        </div>
      </div>
    );
  }

  const trimmed = name.trim();
  return (
    <form
      className="flex flex-col gap-2.5 border-b border-divider bg-raised/50 px-3.5 pt-3 pb-3.5 last:border-b-0"
      onSubmit={(e) => {
        e.preventDefault();
        const patch = { ...(trimmed !== category.name ? { name: trimmed } : {}), ...(kind !== category.kind ? { kind } : {}) };
        if (Object.keys(patch).length === 0) onDone();
        else save.mutate(patch);
      }}
    >
      <label htmlFor={`rename-${category.id}`} className="text-xs text-muted">
        Rename “{category.name}”
      </label>
      <input id={`rename-${category.id}`} className={inputClass} value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
      <span className="text-xs text-muted">Kind</span>
      <Segmented label="Kind" value={kind} options={kindOptions} onChange={setKind} />
      {category.kind === "budgeted" && kind !== "budgeted" && givesBack && <p className="text-[12.5px] text-muted">{givesBack.trim()}</p>}
      {save.isError && <FieldError>{apiErrorText(save.error)}</FieldError>}
      <div className="flex items-center gap-2">
        <button type="button" className="min-h-11 px-1 text-over-fg" onClick={() => setConfirming(true)}>
          Archive
        </button>
        <span className="flex-1" />
        <Button kind="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={trimmed === "" || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function NewCategory({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CategoryKind>("budgeted");
  const create = useMutation({
    mutationFn: () => createCategory({ name: name.trim(), kind }),
    onSuccess: onDone,
  });
  return (
    <form
      className="mx-4 mt-3 flex flex-col gap-2.5 rounded-card border border-divider bg-surface p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <label htmlFor="new-category" className="text-xs text-muted">
        New category
      </label>
      <input id="new-category" className={inputClass} value={name} maxLength={50} autoFocus onChange={(e) => setName(e.target.value)} />
      <Segmented label="Kind" value={kind} options={kindOptions} onChange={setKind} />
      {create.isError && <FieldError>{apiErrorText(create.error)}</FieldError>}
      <div className="flex justify-end gap-2">
        <Button kind="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={name.trim() === "" || create.isPending}>
          Add
        </Button>
      </div>
    </form>
  );
}

function Row({ name, sub, action }: { name: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-[53px] items-center gap-2.5 border-b border-divider pr-1.5 pl-3.5 last:border-b-0">
      <span className="flex-1">{name}</span>
      {sub && <span className="text-[12.5px] text-muted">{sub}</span>}
      {action ?? <span className="w-11" />}
    </div>
  );
}

export function Categories({ back }: { back: Back }) {
  const categories = useCategories();
  const budget = useBudget();
  const rules = useRules();
  const summary = useSummary(monthOf(londonToday()));
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const unarchive = useMutation({ mutationFn: (id: number) => updateCategory(id, { archived: false }) });

  const allocation = new Map(budget.data?.categories.map((c) => [c.categoryId, c.allocatedMinor]));
  const spent = new Map(summary.data?.categories.map((c) => [c.categoryId, c.spentMinor]));
  const ruleCounts = new Map<number, number>();
  for (const r of rules.data ?? []) ruleCounts.set(r.categoryId, (ruleCounts.get(r.categoryId) ?? 0) + 1);
  const all = categories.data?.all ?? [];
  const ordered = pickerOrder(all);
  const archived = all.filter((c) => c.archived);

  const subOf = (c: Category) => {
    if (c.kind === "budgeted") return (allocation.get(c.id) ?? 0) > 0 ? `${formatPounds(allocation.get(c.id)!)} allocated` : undefined;
    if (c.kind === "tracked") return spent.has(c.id) ? `${formatMoney(spent.get(c.id)!, "GBP")} this month` : undefined;
    return undefined;
  };

  return (
    <PushedScreen
      back={back}
      title="Categories"
      action={
        <button type="button" className="min-h-11 px-2 text-[15px] font-medium text-accent-fg" onClick={() => setAdding(true)}>
          + New
        </button>
      }
    >
      <Tabs active="categories" />
      {adding && <NewCategory onDone={() => setAdding(false)} />}
      {categories.isPending ? (
        <div className="mx-4 mt-5 flex flex-col gap-3">
          <Skeleton className="h-[220px] rounded-card" />
          <Skeleton className="h-[120px] rounded-card" />
        </div>
      ) : categories.isError ? (
        <LoadError what="categories" onRetry={() => void categories.refetch()} />
      ) : (
        KINDS.map(({ kind, label, about }) => {
          const list = ordered.filter((c) => c.kind === kind);
          return (
            <section key={kind} aria-labelledby={`kind-${kind}`}>
              <div className="px-5 pt-5 pb-2">
                <SectionLabel id={`kind-${kind}`}>
                  {label} · {list.length + (kind === "budgeted" ? 1 : 0)}
                </SectionLabel>
                <p className="text-[12.5px] text-muted">{about}</p>
              </div>
              <div className="mx-4 overflow-hidden rounded-card border border-divider bg-surface">
                {list.map((c) =>
                  editing === c.id ? (
                    <CategoryEditor key={c.id} category={c} allocationMinor={allocation.get(c.id) ?? 0} ruleCount={ruleCounts.get(c.id) ?? 0} onDone={() => setEditing(null)} />
                  ) : (
                    <Row
                      key={c.id}
                      name={c.name}
                      sub={subOf(c)}
                      action={
                        <button type="button" aria-label={`Edit ${c.name}`} className="grid size-11 place-items-center rounded-button text-muted hover:bg-raised hover:text-fg" onClick={() => setEditing(c.id)}>
                          <Dots size={16} />
                        </button>
                      }
                    />
                  ),
                )}
                {kind === "budgeted" && <Row name="Misc" sub="unallocated · built in" />}
              </div>
            </section>
          );
        })
      )}

      {archived.length > 0 && (
        <div className="mx-5 mt-3">
          <button type="button" aria-expanded={showArchived} className="min-h-11 text-sm text-muted hover:text-fg" onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
          </button>
          {showArchived && (
            <div className="-mx-1 overflow-hidden rounded-card border border-divider bg-surface">
              {archived.map((c) => (
                <Row
                  key={c.id}
                  name={c.name}
                  sub={KINDS.find((k) => k.kind === c.kind)!.label}
                  action={
                    <button type="button" className="min-h-11 px-2.5 text-sm font-medium text-accent-fg" disabled={unarchive.isPending} onClick={() => unarchive.mutate(c.id)}>
                      Unarchive
                    </button>
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mx-5 mt-2 mb-6">
        <Link href="/accounts" className="inline-flex min-h-11 items-center text-sm text-accent-fg">
          Account status
        </Link>
      </div>
    </PushedScreen>
  );
}

// --- Merchant rules -------------------------------------------------------------------------------

function RuleEditor({ rule, categories, onDone }: { rule: Rule | null; categories: Category[]; onDone: () => void }) {
  const [matchType, setMatchType] = useState<MatchType>(rule?.matchType ?? "contains");
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [categoryId, setCategoryId] = useState<number | "">(rule?.categoryId ?? "");
  const save = useMutation({
    mutationFn: () => {
      const input = { matchType, pattern, categoryId: Number(categoryId) };
      return rule ? updateRule(rule.id, input) : createRule(input);
    },
    onSuccess: onDone,
  });
  const remove = useMutation({ mutationFn: () => deleteRule(rule!.id), onSuccess: onDone });
  // A rule's own category stays pickable even if it has been archived since.
  const options = categories.filter((c) => !c.archived || c.id === rule?.categoryId);
  const error = save.isError ? apiErrorText(save.error, RULE_ERRORS) : remove.isError ? apiErrorText(remove.error) : null;
  const patternProblem = pattern !== "" && !isRulablePattern(normalizePattern(pattern)) ? RULE_ERRORS.bad_request : null;

  return (
    <form
      className="flex flex-col gap-2.5 border-b border-divider bg-raised/50 p-3.5 last:border-b-0"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="text-[12.5px] text-muted">{rule ? "Editing rule" : "New rule"}</div>
      <span>Match</span>
      <Segmented
        label="Match"
        value={matchType}
        options={[
          { value: "exact", label: "Exact name" },
          { value: "contains", label: "Name contains" },
        ]}
        onChange={setMatchType}
      />
      <p className="text-xs text-muted">Contains catches variations like “CITY CABS LTD” or “City Cabs 0412”. Exact matches the merchant name only.</p>
      <label htmlFor="rule-pattern">Text to match</label>
      <input id="rule-pattern" className={inputClass} value={pattern} maxLength={100} autoCapitalize="none" onChange={(e) => setPattern(e.target.value)} />
      <label htmlFor="rule-category">Category</label>
      <select id="rule-category" className={`${inputClass} [color-scheme:dark]`} value={categoryId} onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))}>
        <option value="" disabled>
          Pick a category
        </option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.archived ? " (archived)" : ""}
          </option>
        ))}
      </select>
      {rule && (
        <p className="rounded-input border border-divider bg-canvas/40 px-3 py-2.5 text-[13px] leading-normal text-fg/85">
          Decides {rule.transactionCount} {rule.transactionCount === 1 ? "transaction" : "transactions"} now. Saving re-sorts every matching transaction you haven't edited by hand.
        </p>
      )}
      {(patternProblem ?? error) && <FieldError>{patternProblem ?? error}</FieldError>}
      <div className="flex items-center gap-2">
        {rule && (
          <button type="button" className="min-h-11 px-1 text-over-fg disabled:opacity-50" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Delete rule
          </button>
        )}
        <span className="flex-1" />
        <Button kind="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={pattern.trim() === "" || patternProblem !== null || categoryId === "" || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function Rules({ back }: { back: Back }) {
  const rules = useRules();
  const categories = useCategories();
  const accounts = useAccounts();
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const all = pickerOrder(categories.data?.all ?? []).concat((categories.data?.all ?? []).filter((c) => c.archived));

  return (
    <PushedScreen
      back={back}
      title="Categories"
      action={
        <button type="button" className="min-h-11 px-2 text-[15px] font-medium text-accent-fg" onClick={() => setEditing("new")}>
          + Rule
        </button>
      }
    >
      <Tabs active="rules" />
      <p className="mx-5 mt-3.5 text-[13.5px] leading-normal text-muted">
        A rule sets the category for every transaction from that merchant, past and future. Transactions you've edited by hand keep their own category.
      </p>
      {rules.isPending ? (
        <Skeleton className="mx-4 mt-3 h-[200px] rounded-card" />
      ) : rules.isError ? (
        <LoadError what="rules" onRetry={() => void rules.refetch()} />
      ) : (
        <div className="mx-4 mt-3 mb-6 overflow-hidden rounded-card border border-divider bg-surface">
          {editing === "new" && <RuleEditor rule={null} categories={all} onDone={() => setEditing(null)} />}
          {rules.data.length === 0 && editing !== "new" && <p className="px-3.5 py-4 text-muted">No rules yet. Filing a merchant in To sort makes one.</p>}
          {rules.data.map((r) =>
            editing === r.id ? (
              <RuleEditor key={r.id} rule={r} categories={all} onDone={() => setEditing(null)} />
            ) : (
              <button key={r.id} type="button" className="flex min-h-[60px] w-full items-center gap-2.5 border-b border-divider px-3.5 py-2.5 text-left last:border-b-0 hover:bg-raised" onClick={() => setEditing(r.id)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.pattern}</span>
                  <span className="block text-[12.5px] text-muted">
                    {r.matchType === "exact" ? "Exact" : "Contains"} · {r.transactionCount} {r.transactionCount === 1 ? "transaction" : "transactions"}
                    {r.accountId !== null && ` · ${accounts.data?.byId.get(r.accountId)?.name ?? "one account"} only`}
                  </span>
                </span>
                <span className="text-muted" aria-hidden="true">
                  →
                </span>
                <span className="rounded-lg bg-accent-tint px-2.5 py-1 text-sm text-accent-fg">{categories.data?.byId.get(r.categoryId)?.name ?? "Category"}</span>
              </button>
            ),
          )}
        </div>
      )}
    </PushedScreen>
  );
}
