import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiErrorText, enableAccount, linkAccount, type Account } from "../api";
import { PushedScreen } from "../components/Screen";
import { AccountBadge, Button, Check, ErrorBanner, SectionLabel, Skeleton, Warning, badgeOf } from "../components/ui";
import { addDays, formatDayMonth, formatShortDate } from "../dates";
import { useAccounts } from "../queries";
import { Link } from "../router";
import type { Back } from "../routes";

// Reviewing an account Lunch Flow started sending (docs/ui-design.md, New account found; P2.1):
// link it to the account it reconnects, or import it as a new one. Nothing is imported until then.

type Choice = { kind: "link"; intoId: number } | { kind: "new" };

/** The enabled account this one most likely reconnects: same currency, same kind of card. */
function likelyMatch(held: Account, candidates: Account[]) {
  return candidates.find((c) => c.currency === held.currency && badgeOf(c).label === badgeOf(held).label);
}

function linkPreview(target: Account) {
  if (!target.backfillComplete || !target.newestTxnDate) {
    return `${target.name} hadn't finished importing its history, so Tally fetches all of it again and files everything under ${target.name}. Transactions it already has are de-duplicated if Lunch Flow kept their ids.`;
  }
  return `Tally will fetch from ${formatDayMonth(addDays(target.newestTxnDate, -7))}, 7 days before ${target.name}'s newest transaction, and file everything under ${target.name}. If Lunch Flow kept the transaction ids, that overlap is de-duplicated automatically. If not, up to 7 days may appear twice and you exclude the doubles by hand.`;
}

function Radio({ on, title, body, onSelect, disabled }: { on: boolean; title: string; body: string; onSelect: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      className={`flex w-full items-start gap-3 rounded-2xl border bg-surface p-3.5 text-left disabled:opacity-50 ${on ? "border-[1.5px] border-accent/70" : "border-divider"}`}
      onClick={onSelect}
    >
      <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-[1.5px] ${on ? "border-accent" : "border-muted/60"}`} aria-hidden="true">
        {on && <span className="size-2.5 rounded-full bg-accent" />}
      </span>
      <span>
        <span className="block text-[15px] font-medium">{title}</span>
        <span className="mt-[3px] block text-[12.5px] leading-normal text-muted">{body}</span>
      </span>
    </button>
  );
}

export function NewAccount({ back, accountId }: { back: Back; accountId: number }) {
  const accounts = useAccounts();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [done, setDone] = useState<{ choice: Choice; name: string } | null>(null);

  const held = accounts.data?.byId.get(accountId);
  const candidates = (accounts.data?.all ?? []).filter((a) => a.id !== accountId && a.importEnabled && !a.needsReview);
  const match = held ? likelyMatch(held, candidates) : undefined;
  const linkable = candidates.filter((c) => c.currency === held?.currency);
  const selected = choice ?? (match ? { kind: "link" as const, intoId: match.id } : null);
  const target = selected?.kind === "link" ? candidates.find((c) => c.id === selected.intoId) : undefined;

  const confirm = useMutation({
    mutationFn: (c: Choice) => (c.kind === "link" ? linkAccount(accountId, c.intoId) : enableAccount(accountId)),
    onSuccess: (_, c) => {
      setDone({ choice: c, name: c.kind === "link" ? (target?.name ?? "the account") : (held?.name ?? "the account") });
    },
  });
  const error = confirm.isError ? apiErrorText(confirm.error) : null;

  if (done) {
    return (
      <PushedScreen back={back} title={done.choice.kind === "link" ? "Linked" : "Added"}>
        <div className="mx-4 mt-4 flex flex-col items-center gap-3 rounded-card border border-divider bg-surface px-5 py-7 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-accent-tint text-accent-fg">
            <Check size={22} />
          </span>
          {done.choice.kind === "link" ? (
            <>
              <p className="text-[17px]">New transactions now go under {done.name}</p>
              <p className="text-[13.5px] leading-normal text-muted">The next import catches up. If Lunch Flow didn't keep the transaction ids, check the last week in Transactions for doubles and exclude them.</p>
              <Link href="/transactions" className="inline-flex min-h-11 items-center text-accent-fg">
                Check Transactions
              </Link>
            </>
          ) : (
            <>
              <p className="text-[17px]">{done.name} is now part of your budget</p>
              <p className="text-[13.5px] leading-normal text-muted">The next import brings in its full history. Anything without a rule goes to To sort.</p>
            </>
          )}
          <Link href="/accounts" className="mt-1 flex min-h-12 w-full items-center justify-center rounded-button bg-accent font-medium text-on-accent">
            Back to accounts
          </Link>
        </div>
      </PushedScreen>
    );
  }

  return (
    <PushedScreen back={back} title="New account found">
      <p className="mx-5 mt-1.5 text-[13px] leading-normal text-muted">
        Lunch Flow started sending a new account. Tally hasn't imported anything from it yet, so your totals are unchanged until you decide what it is.
      </p>
      {accounts.isPending ? (
        <Skeleton className="mx-4 mt-4 h-[140px] rounded-card" />
      ) : !held || !held.needsReview ? (
        <div className="mx-4 mt-4 rounded-card border border-divider bg-surface px-5 py-6 text-center">
          <p>{held ? "This account has already been reviewed." : "This account isn't waiting for review."}</p>
          <Link href="/accounts" className="mt-2 inline-flex min-h-11 items-center text-accent-fg">
            Back to accounts
          </Link>
        </div>
      ) : (
        <div className="pb-32">
          <div className="mx-4 mt-4 rounded-card border border-divider bg-surface px-4 pt-3.5 pb-1">
            <div className="flex items-center gap-2 pb-2.5">
              <AccountBadge account={held} />
              <span className="text-[15px] font-medium">{held.name}</span>
            </div>
            <div className="flex min-h-[42px] items-center justify-between border-t border-divider text-[14.5px]">
              <span className="text-muted">Imported</span>
              <span>Nothing yet</span>
            </div>
            {match && (
              <div className="flex min-h-[42px] items-center justify-between gap-3 border-t border-divider text-[14.5px]">
                <span className="text-muted">Looks like</span>
                <span className="text-right text-accent-fg">{match.name} (name and currency match)</span>
              </div>
            )}
          </div>

          <div className="mx-5 mt-[18px] mb-2">
            <SectionLabel>What is it?</SectionLabel>
          </div>
          <div role="radiogroup" aria-label="What is it?" className="mx-4 flex flex-col gap-2.5">
            <Radio
              on={selected?.kind === "link"}
              title="Link to an existing account"
              body="It's a card or account you already had, reconnected. New transactions are filed under the old account, and its history isn't imported a second time."
              disabled={linkable.length === 0}
              onSelect={() => setChoice({ kind: "link", intoId: (match ?? linkable[0])!.id })}
            />
            {selected?.kind === "link" && (
              <div className="ml-8 flex flex-col gap-2" role="radiogroup" aria-label="Which account">
                {candidates.map((c) => {
                  const on = selected.intoId === c.id;
                  const sameCurrency = c.currency === held.currency;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={!sameCurrency}
                      className={`flex min-h-[52px] items-center gap-2.5 rounded-[12px] border px-3 py-2.5 text-left disabled:opacity-50 ${on ? "border-accent/40 bg-accent-tint/70" : "border-divider bg-surface"}`}
                      onClick={() => setChoice({ kind: "link", intoId: c.id })}
                    >
                      <AccountBadge account={c} />
                      <span className="flex-1">
                        <span className="block text-sm">{c.name}</span>
                        <span className="block text-[11.5px] text-muted">
                          {sameCurrency ? (c.newestTxnDate ? `Newest transaction ${formatShortDate(c.newestTxnDate)}` : "No transactions yet") : `Different currency (${c.currency ?? "unknown"})`}
                        </span>
                      </span>
                      {on && <Check size={16} className="text-accent-fg" />}
                    </button>
                  );
                })}
                {target && (
                  <p className="rounded-[12px] border border-divider bg-surface px-3.5 py-3 text-[13px] leading-normal text-fg/85">{linkPreview(target)}</p>
                )}
                {target && badgeOf(target).label !== badgeOf(held).label && (
                  <p className="flex items-start gap-2 rounded-[12px] border border-warn/40 bg-warn-tint px-3.5 py-3 text-[13px] leading-normal text-warn-fg">
                    <Warning size={16} className="mt-px shrink-0" />
                    This doesn't look like the same kind of account as {target.name}. Linking files all its transactions under {target.name}.
                  </p>
                )}
              </div>
            )}
            <Radio
              on={selected?.kind === "new"}
              title="It's a new account"
              body="Keep it separate. Tally imports its full history and it starts counting. Anything without a rule goes to To sort."
              onSelect={() => setChoice({ kind: "new" })}
            />
          </div>
          {error && <ErrorBanner className="mx-4 mt-3">{error}</ErrorBanner>}
          <div className="fixed inset-x-0 bottom-0 mx-auto max-w-lg bg-gradient-to-t from-canvas from-70% px-4 pt-6 pb-safe">
            <Button className="mb-2 min-h-[52px] w-full text-[15.5px]" disabled={!selected || (selected.kind === "link" && !target) || confirm.isPending} onClick={() => selected && confirm.mutate(selected)}>
              {confirm.isPending ? "Saving…" : selected?.kind === "new" ? "Add as a new account" : target ? `Link to ${target.name}` : "Choose what it is"}
            </Button>
          </div>
        </div>
      )}
    </PushedScreen>
  );
}
