// Dev-only, in-memory stand-in for the API, on synthetic data (./data.ts). It follows the
// rules in docs/phase-2-spec.md closely enough to drive the screens, but the Worker stays the
// authority: this is never a reference for how the backend behaves.

import type { Account, Budget, Category, CategoryKind, ImportRun, InboxMerchant, MatchType, MonthSummary, OverrideInput, Rule, SummaryCategory, Transaction } from "../api";
import { addDays, daysRemaining, londonToday, monthOf } from "../dates";
import { normalizePattern as normalize } from "../../worker/budget/resolve";
import { SEED_ACCOUNTS, SEED_BUDGET, SEED_CATEGORIES, SEED_NEW_ACCOUNT, SEED_RULES, SEED_TRANSACTIONS } from "./data";

// Only reachable through api.ts's `import.meta.env.DEV` branch. If a production build ever
// pulls this in anyway, it fails loudly instead of serving fake data.
if (!import.meta.env.DEV) throw new Error("The mock API must never be part of a production build.");

type Override = Required<Pick<OverrideInput, "categoryId" | "excluded" | "countedAmountMinor" | "countedDate" | "note">>;
type BankTxn = Omit<Transaction, "categoryId" | "categorySource" | "editable" | "excluded" | "countedAmountMinor" | "countedDate" | "note">;
type RuleRow = Omit<Rule, "transactionCount">;

const LATENCY_MS = 250;
const HOUR_MS = 3_600_000;

// --- State -----------------------------------------------------------------------------------

const today = londonToday();
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR_MS).toISOString();

const ACCOUNT_DEFAULTS = {
  providerStatus: "ACTIVE",
  currency: "GBP",
  balanceMinor: null,
  balanceFetchedAt: null,
  lastImportError: null,
  consecutiveFailures: 0,
} satisfies Partial<Account>;

const accounts: Account[] = [
  ...SEED_ACCOUNTS.map((a) => ({
    ...ACCOUNT_DEFAULTS,
    id: a.id,
    name: a.name,
    institutionName: a.institutionName,
    importEnabled: true,
    lastImportAttemptAt: hoursAgo(a.hoursSinceChange),
    lastImportSuccessAt: hoursAgo(a.hoursSinceChange),
    lastDataChangeAt: hoursAgo(a.hoursSinceChange),
    newestTxnDate: today,
    backfillComplete: true,
    needsReview: false,
  })),
  {
    ...ACCOUNT_DEFAULTS,
    ...SEED_NEW_ACCOUNT,
    importEnabled: false,
    lastImportAttemptAt: null,
    lastImportSuccessAt: null,
    lastDataChangeAt: null,
    newestTxnDate: null,
    backfillComplete: false,
    needsReview: true,
  },
];

const categories: Category[] = SEED_CATEGORIES.map(([name, kind], i) => ({ id: i + 1, name, kind, archived: false }));

let nextRuleId = 1;
const rules: RuleRow[] = SEED_RULES.map(([matchType, pattern, categoryId]) => ({ id: nextRuleId++, matchType, pattern, accountId: null, categoryId }));

const transactions: BankTxn[] = SEED_TRANSACTIONS.map(([daysAgo, accountId, merchant, amountMinor, pending], i) => ({
  id: 1000 + i,
  accountId,
  amountMinor,
  currency: "GBP",
  txnDate: addDays(today, -daysAgo),
  merchant,
  description: merchant.toUpperCase(),
  isPending: pending ?? false,
  vanishedAt: null,
  firstSeenAt: hoursAgo(daysAgo * 24),
})).sort((a, b) => b.txnDate.localeCompare(a.txnDate) || b.id - a.id);

const overrides = new Map<number, Override>();
const budget = { overallMinor: SEED_BUDGET.overallMinor as number | null, allocations: new Map(Object.entries(SEED_BUDGET.allocations).map(([id, v]) => [Number(id), v])) };

// --- Rules (docs/phase-2-spec.md, Rules) -------------------------------------------------------


function matchRule(txn: BankTxn): RuleRow | undefined {
  const merchant = normalize(txn.merchant);
  const tier = (r: RuleRow) => (r.matchType === "exact" ? 0 : 2) + (r.accountId === null ? 1 : 0);
  return rules
    .filter((r) => (r.accountId === null || r.accountId === txn.accountId) && (r.matchType === "exact" ? merchant === r.pattern : merchant.includes(r.pattern)))
    .sort((a, b) => tier(a) - tier(b) || b.pattern.length - a.pattern.length || a.id - b.id)[0];
}

function resolve(txn: BankTxn): Transaction {
  const o = overrides.get(txn.id);
  const rule = matchRule(txn);
  const categoryId = o?.categoryId ?? rule?.categoryId ?? null;
  return {
    ...txn,
    categoryId,
    categorySource: o?.categoryId != null ? "override" : rule ? "rule" : null,
    editable: !txn.isPending && txn.vanishedAt === null,
    excluded: o?.excluded ?? false,
    countedAmountMinor: o?.countedAmountMinor ?? null,
    countedDate: o?.countedDate ?? null,
    note: o?.note ?? null,
  };
}

const kindOf = (categoryId: number | null): CategoryKind | null => categories.find((c) => c.id === categoryId)?.kind ?? null;
const isInbox = (t: Transaction) => t.vanishedAt === null && t.categoryId === null && !t.excluded;

function allocated() {
  let sum = 0;
  for (const c of categories) if (c.kind === "budgeted" && !c.archived) sum += budget.allocations.get(c.id) ?? 0;
  return sum;
}

/** Whether a resolved row counts in `month`, as the Worker's COUNTS decides. */
function countsIn(t: Transaction, month: string): boolean {
  if (t.vanishedAt !== null || t.excluded || monthOf(t.countedDate ?? t.txnDate) !== month) return false;
  const kind = kindOf(t.categoryId);
  return kind === "budgeted" || kind === "tracked" || (t.categoryId === null && (t.countedAmountMinor ?? t.amountMinor) < 0);
}

/** Home's Misc: posted uncategorised spend, plus budgeted categories without an allocation. */
function inMisc(t: Transaction): boolean {
  const c = findCategory(t.categoryId);
  return (t.categoryId === null && !t.isPending) || (c?.kind === "budgeted" && (c.archived || !budget.allocations.get(c.id)));
}

/** Home's Pending: uncategorised pending charges. */
const inPending = (t: Transaction) => t.categoryId === null && t.isPending;

function summary(month: string): MonthSummary {
  const byCategory = new Map<number | null, SummaryCategory>();
  const entry = (categoryId: number | null) => {
    let e = byCategory.get(categoryId);
    if (!e) byCategory.set(categoryId, (e = { categoryId, kind: kindOf(categoryId), spentMinor: 0, pendingSpentMinor: 0, allocatedMinor: 0 }));
    return e;
  };
  let spent = 0;
  let pending = 0;
  let tracked = 0;
  const resolved = transactions.map(resolve);
  for (const t of resolved) {
    if (!countsIn(t, month)) continue;
    const amount = t.countedAmountMinor ?? t.amountMinor;
    const kind = kindOf(t.categoryId);
    const e = entry(t.categoryId);
    e.spentMinor -= amount;
    if (t.isPending) e.pendingSpentMinor -= amount;
    if (kind === "tracked") {
      tracked -= amount;
    } else {
      spent -= amount;
      if (t.isPending) pending -= amount;
    }
  }
  for (const c of categories) {
    const allocation = budget.allocations.get(c.id);
    if (c.kind === "budgeted" && !c.archived && allocation) entry(c.id).allocatedMinor = allocation;
  }

  const { overallMinor: overall, allocatedMinor, miscMinor } = getBudget();
  const left = overall === null ? null : overall - spent;
  const days = month === monthOf(today) ? daysRemaining(today) : null;
  return {
    month,
    overallMinor: overall,
    allocatedMinor,
    miscMinor,
    spentMinor: spent,
    pendingSpentMinor: pending,
    leftMinor: left,
    daysRemaining: days,
    perWeekMinor: days === null || left === null ? null : left > 0 ? Math.floor((left * 7) / days) : 0,
    // By id, with Uncategorised last.
    categories: [...byCategory.values()].sort((x, y) => (x.categoryId ?? Infinity) - (y.categoryId ?? Infinity)),
    trackedMinor: tracked,
    inboxCount: resolved.filter(isInbox).length,
    lastDataChangeAt: accounts.filter((a) => a.importEnabled).reduce<string | null>((max, a) => (a.lastDataChangeAt && (!max || a.lastDataChangeAt > max) ? a.lastDataChangeAt : max), null),
  };
}

function getBudget(): Budget {
  const overall = budget.overallMinor;
  const allocatedMinor = allocated();
  const misc = overall === null ? null : overall - allocatedMinor;
  return {
    month: monthOf(today),
    overallMinor: overall,
    allocatedMinor,
    miscMinor: misc,
    categories: categories
      .filter((c) => c.kind === "budgeted" && !c.archived)
      .map((c) => {
        const allocatedMinor = budget.allocations.get(c.id) ?? 0;
        return { categoryId: c.id, allocatedMinor, maxAllocatableMinor: misc === null ? null : misc + allocatedMinor };
      }),
  };
}

// --- HTTP plumbing -----------------------------------------------------------------------------

type Body = Record<string, unknown>;
type Reply = { status: number; body: unknown };
type Handler = (match: RegExpExecArray, url: URL, body: Body) => Reply;

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const fail = (status: number, error: string, extra: Body = {}): Reply => ({ status, body: { error, ...extra } });

const isAmount = (v: unknown): v is number => Number.isSafeInteger(v);

function page<T extends { txnDate: string; id: number }>(rows: T[], url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const cursor = url.searchParams.get("cursor");
  const start = cursor ? rows.findIndex((r) => `${r.txnDate}_${r.id}` === cursor) + 1 : 0;
  const slice = rows.slice(start, start + limit);
  const last = slice[slice.length - 1];
  return { transactions: slice, nextCursor: start + limit < rows.length && last ? `${last.txnDate}_${last.id}` : null };
}

const findCategory = (id: unknown) => categories.find((c) => c.id === id);

const NO_OVERRIDE: Override = { categoryId: null, excluded: false, countedAmountMinor: null, countedDate: null, note: null };

/** The transaction an override write may change, or the error reply. */
function editableTxn(id: number): BankTxn | Reply {
  const txn = transactions.find((t) => t.id === id);
  if (!txn) return fail(404, "not_found");
  if (txn.isPending || txn.vanishedAt !== null) return fail(409, "not_editable");
  return txn;
}

function upsertMerchantRule(merchant: string, categoryId: number) {
  const pattern = normalize(merchant);
  const existing = rules.find((r) => r.matchType === "exact" && r.pattern === pattern && r.accountId === null);
  if (existing) existing.categoryId = categoryId;
  else rules.push({ id: nextRuleId++, matchType: "exact", pattern, accountId: null, categoryId });
}

/** [method, path pattern, handler]. */
const ROUTES: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/accounts$/, () => ok({ accounts: accounts.filter((a) => a.importEnabled || a.needsReview) })],
  ["POST", /^\/api\/accounts\/(\d+)\/enable$/, (m) => {
    const a = accounts.find((x) => x.id === Number(m[1]));
    if (!a) return fail(404, "not_found");
    if (!a.needsReview) return fail(409, "not_awaiting_review");
    Object.assign(a, { needsReview: false, importEnabled: true });
    return ok({ ok: true });
  }],
  ["POST", /^\/api\/accounts\/(\d+)\/link$/, (m, _u, body) => {
    const held = accounts.find((x) => x.id === Number(m[1]));
    const target = accounts.find((x) => x.id === body.intoAccountId);
    if (!held || !target) return fail(404, "not_found");
    if (!held.needsReview) return fail(409, "not_awaiting_review");
    if (target.needsReview || target.id === held.id) return fail(409, "invalid_link_target");
    accounts.splice(accounts.indexOf(held), 1);
    return ok({ ok: true });
  }],
  ["GET", /^\/api\/import-runs$/, () => {
    const runs: ImportRun[] = [{ id: 1, trigger: "cron", startedAt: hoursAgo(3), status: "success", errorSummary: null, accounts: SEED_ACCOUNTS.map((a) => ({ accountId: a.id, status: "success", inserted: 2, updated: 0, error: null })) }];
    return ok({ runs, importing: false });
  }],
  ["POST", /^\/api\/import-runs$/, () => fail(429, "rate_limited", { retryAfterSeconds: 60 })],

  ["GET", /^\/api\/categories$/, () => ok({ categories })],
  ["POST", /^\/api\/categories$/, (_m, _u, body) => {
    const name = String(body.name ?? "").trim();
    if (!name) return fail(400, "bad_request");
    if (categories.some((c) => normalize(c.name) === normalize(name))) return fail(409, "name_taken");
    const category: Category = { id: categories.length + 1, name, kind: body.kind as CategoryKind, archived: false };
    categories.push(category);
    return ok({ category }, 201);
  }],
  ["PATCH", /^\/api\/categories\/(\d+)$/, (m, _u, body) => {
    const c = findCategory(Number(m[1]));
    if (!c) return fail(404, "not_found");
    if (typeof body.name === "string" && categories.some((x) => x !== c && normalize(x.name) === normalize(body.name as string))) return fail(409, "name_taken");
    if (typeof body.name === "string") c.name = body.name.trim();
    if (body.kind) c.kind = body.kind as CategoryKind;
    if (typeof body.archived === "boolean") c.archived = body.archived;
    if (c.kind !== "budgeted" || c.archived) budget.allocations.delete(c.id);
    return ok({ category: c });
  }],

  ["GET", /^\/api\/rules$/, () => {
    const counts = new Map<number, number>();
    for (const t of transactions) {
      const rule = t.vanishedAt === null && overrides.get(t.id)?.categoryId == null ? matchRule(t) : undefined;
      if (rule) counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
    }
    return ok({ rules: rules.map((r) => ({ ...r, transactionCount: counts.get(r.id) ?? 0 })) });
  }],
  ["POST", /^\/api\/rules$/, (_m, _u, body) => {
    const pattern = normalize(String(body.pattern ?? ""));
    const accountId = (body.accountId as number | null | undefined) ?? null;
    if (!pattern || !findCategory(body.categoryId)) return fail(400, "bad_request");
    if (rules.some((r) => r.matchType === body.matchType && r.pattern === pattern && r.accountId === accountId)) return fail(409, "rule_exists");
    const rule: RuleRow = { id: nextRuleId++, matchType: body.matchType as MatchType, pattern, accountId, categoryId: body.categoryId as number };
    rules.push(rule);
    return ok({ rule }, 201);
  }],
  ["PATCH", /^\/api\/rules\/(\d+)$/, (m, _u, body) => {
    const rule = rules.find((r) => r.id === Number(m[1]));
    if (!rule) return fail(404, "not_found");
    if (body.matchType) rule.matchType = body.matchType as MatchType;
    if (typeof body.pattern === "string") rule.pattern = normalize(body.pattern);
    if (body.accountId !== undefined) rule.accountId = body.accountId as number | null;
    if (body.categoryId !== undefined) rule.categoryId = body.categoryId as number;
    return ok({ rule });
  }],
  ["DELETE", /^\/api\/rules\/(\d+)$/, (m) => {
    const i = rules.findIndex((r) => r.id === Number(m[1]));
    if (i < 0) return fail(404, "not_found");
    rules.splice(i, 1);
    return ok({ ok: true });
  }],

  ["GET", /^\/api\/transactions$/, (_m, url) => {
    const accountId = url.searchParams.get("account_id");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const rows = transactions
      .filter((t) => (!accountId || t.accountId === Number(accountId)) && (!from || t.txnDate >= from) && (!to || t.txnDate <= to))
      .map(resolve);
    return ok(page(rows, url));
  }],
  ["PUT", /^\/api\/transactions\/(\d+)\/override$/, (m, _u, body) => {
    const txn = editableTxn(Number(m[1]));
    if ("status" in txn) return txn;
    if ((body.countedAmountMinor != null && !isAmount(body.countedAmountMinor)) || (body.categoryId != null && !findCategory(body.categoryId))) return fail(400, "bad_request");
    // Replaces the whole override, as the Worker does.
    const next: Override = { ...NO_OVERRIDE };
    for (const key of Object.keys(NO_OVERRIDE) as (keyof Override)[]) {
      if (body[key] !== undefined) (next as Body)[key] = body[key];
    }
    if (next.note === "") next.note = null;
    if (body.applyToMerchant === true) {
      if (next.categoryId === null) return fail(400, "bad_request");
      upsertMerchantRule(txn.merchant, next.categoryId);
      next.categoryId = null;
    }
    if ((Object.keys(NO_OVERRIDE) as (keyof Override)[]).every((k) => next[k] === NO_OVERRIDE[k])) overrides.delete(txn.id);
    else overrides.set(txn.id, next);
    return ok({ transaction: resolve(txn) });
  }],
  ["DELETE", /^\/api\/transactions\/(\d+)\/override$/, (m) => {
    const txn = editableTxn(Number(m[1]));
    if ("status" in txn) return txn;
    overrides.delete(txn.id);
    return ok({ transaction: resolve(txn) });
  }],
  ["GET", /^\/api\/inbox$/, (_m, url) => {
    const rows = transactions.map(resolve).filter(isInbox);
    return ok({ ...page(rows, url), total: rows.length });
  }],
  ["GET", /^\/api\/inbox\/merchants$/, () => {
    const groups = new Map<string, InboxMerchant>();
    for (const t of transactions.map(resolve)) {
      if (!isInbox(t)) continue;
      const pattern = normalize(t.merchant);
      const g = groups.get(pattern) ?? { pattern, merchant: t.merchant, count: 0, totalMinor: 0, latestDate: t.txnDate, rulable: pattern.length > 0 && pattern.length <= 100 };
      g.count += 1;
      g.totalMinor += t.countedAmountMinor ?? t.amountMinor;
      if (t.txnDate > g.latestDate) Object.assign(g, { latestDate: t.txnDate, merchant: t.merchant });
      groups.set(pattern, g);
    }
    return ok({ merchants: [...groups.values()].sort((a, b) => b.count - a.count || b.latestDate.localeCompare(a.latestDate)) });
  }],

  ["GET", /^\/api\/budget$/, () => ok(getBudget())],
  ["PUT", /^\/api\/budget\/overall$/, (_m, _u, body) => {
    if (!isAmount(body.amountMinor) || body.amountMinor <= 0) return fail(400, "bad_request");
    if (body.amountMinor < allocated()) return fail(422, "below_allocated", { minOverallMinor: allocated() });
    budget.overallMinor = body.amountMinor;
    return ok(getBudget());
  }],
  ["PUT", /^\/api\/budget\/categories\/(\d+)$/, (m, _u, body) => {
    const c = findCategory(Number(m[1]));
    if (!isAmount(body.amountMinor) || body.amountMinor < 0) return fail(400, "bad_request");
    if (!c) return fail(404, "not_found");
    if (budget.overallMinor === null) return fail(409, "overall_budget_not_set");
    if (c.archived) return fail(409, "category_archived");
    if (c.kind !== "budgeted") return fail(409, "category_not_budgeted");
    const others = allocated() - (budget.allocations.get(c.id) ?? 0);
    const current = budget.allocations.get(c.id) ?? 0;
    // A cut is always allowed, so an over-allocated budget can be brought back under.
    if (body.amountMinor > current && others + body.amountMinor > budget.overallMinor) return fail(422, "over_allocated", { maxAllocatableMinor: budget.overallMinor - others });
    if (body.amountMinor === 0) budget.allocations.delete(c.id);
    else budget.allocations.set(c.id, body.amountMinor);
    return ok(getBudget());
  }],

  ["GET", /^\/api\/months\/(\d{4}-(?:0[1-9]|1[0-2]))\/summary$/, (m) => (m[1]! > monthOf(today) ? fail(400, "bad_request") : ok(summary(m[1]!)))],
  ["GET", /^\/api\/months\/(\d{4}-(?:0[1-9]|1[0-2]))\/transactions$/, (m, url) => {
    const month = m[1]!;
    const category = url.searchParams.get("category");
    const id = Number(category);
    if (month > monthOf(today) || (category !== "misc" && category !== "pending" && !(Number.isInteger(id) && id > 0))) return fail(400, "bad_request");
    const inLine = category === "misc" ? inMisc : category === "pending" ? inPending : (t: Transaction) => t.categoryId === id;
    const rows = transactions.map(resolve).filter((t) => countsIn(t, month) && inLine(t));
    return ok(page(rows, url));
  }],
];

/**
 * Screen states to review, picked with `?mock=<scenario>` on any URL and kept for the tab:
 * "firstrun" (no budget yet), "over" (spent past the budget), "error" (the summary fails),
 * "slow" (5 s latency, to see loading states).
 */
const scenario = (() => {
  const fromUrl = new URLSearchParams(window.location.search).get("mock");
  try {
    if (fromUrl !== null) sessionStorage.setItem("tally-mock", fromUrl);
    return sessionStorage.getItem("tally-mock") ?? "";
  } catch {
    return fromUrl ?? "";
  }
})();
if (scenario === "firstrun") {
  budget.overallMinor = null;
  budget.allocations.clear();
}
if (scenario === "over") {
  budget.overallMinor = 20_000;
  budget.allocations = new Map([[4, 5_000], [1, 6_000], [2, 3_000], [3, 4_000]]);
}

/** The mock's reply for any /api request. */
export function handle(path: string, init: RequestInit | undefined): Promise<Response> {
  const url = new URL(path, window.location.origin);
  const method = init?.method ?? "GET";
  let reply: Reply = fail(404, "not_found");
  for (const [routeMethod, pattern, handler] of ROUTES) {
    const match = routeMethod === method ? pattern.exec(url.pathname) : null;
    if (!match) continue;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Body) : {};
    reply = scenario === "error" && url.pathname.endsWith("/summary") ? fail(500, "internal") : handler(match, url, body);
    break;
  }
  // Serialised, so the screens never hold references into the mock's state.
  const response = new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  return new Promise((r) => setTimeout(() => r(response), scenario === "slow" ? 5_000 : LATENCY_MS));
}
