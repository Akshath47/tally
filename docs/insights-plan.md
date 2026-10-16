# Insights, analytics and weekly digest implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stale-data flags, a monthly review, 6-month trends, merchant history, rule-based insights and a Sunday 18:00 email digest to Tally's API, plus Home and Accounts' already-designed stale states.

**Architecture:** Everything is computed on read in SQL from the same `RESOLVED_CTE` and `COUNTS` filters the month summary uses, seeking by date range or merchant key so D1's rows-read stays small. Insights are pure TypeScript rules over those aggregates. The digest reuses the summary, the insights and one shared wording module, and sends through a Cloudflare `send_email` binding to the owner's verified address only.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite) with Drizzle migrations, zod, Vitest with `@cloudflare/vitest-plugin`, React 19 for the stale states.

**Spec:** [phase-2-insights-spec.md](phase-2-insights-spec.md) (data, rules, API); [insights-ui-brief.md](insights-ui-brief.md) (screens, for P2.12). Read both before starting.

## Global Constraints

- Money is integer minor units, **positive = spend** in every new response; no float arithmetic on amounts. Divisions floor via `floorDiv`; ratios compare by cross-multiplying.
- Dates are `YYYY-MM-DD` text and never round-trip through `Date`; months `YYYY-MM`. "Today", weeks (Monday–Sunday) and months are `Europe/London`.
- Every figure counts the same rows as the month summary: `r.vanished_at IS NULL AND COUNTS`, by counted date (`counted_date ?? txn_date`).
- No read scans the whole history: seek by date range (`IN_DATES`) or merchant key (`OF_MERCHANT`). Each statement ≤ 100 bound params; each request ≤ 50 statements.
- Synthetic test data only. Logs record counts, statuses and durations, never bodies, subjects with figures, or addresses.
- The digest sends only to `ALLOWED_EMAIL`, from `DIGEST_FROM`. No paid Cloudflare feature is enabled.
- Thresholds live in `src/worker/insights/thresholds.ts` (plus `STALE_AFTER_DAYS` in `src/worker/budget/stale.ts`).
- Each slice is its own branch (`feat/stale-data`, `feat/analytics-api`, `feat/insights`, `feat/weekly-digest`) merged by PR after the owner's pre-PR checks; commits follow CLAUDE.md with a `Phase: P2.x` trailer.
- Run a single spec with `npx vitest run <path>`; the whole suite with `npm run check` (typecheck, lint, tests).

## Review Focus

1. **Refund-heavy categories** (net spend ≤ 0 in baseline months): "running high" must never report a negative usual level. Test in P2.10 Task 2.
2. **A pending large charge that's later superseded** (`vanished_at` set): it must stop being an insight. Test in P2.10 Task 3.
3. **Merchant keys with URL-special characters** (`%`, `&`, `/`): `GET /api/merchants?key=` must match them literally. Test in P2.9 Task 4.
4. **The digest when no budget is set** (e.g. the 1st of a month before the owner sets one): no "left", no pace, no category lines, no crash. Test in P2.11 Task 2.
5. **An edited `counted_date` moving a row across a week or month edge**: week spend, trends and reviews follow the counted date, not the bank date. Test in P2.9 Task 1 (shared `IN_DATES`) and P2.11 Task 2 (week spend).

---

# P2.8 Stale data

Branch: `git checkout main && git pull && git checkout -b feat/stale-data`

### Task 1: Extract the month summary into a module

No behaviour change: the digest (P2.11) needs the summary without an HTTP round trip.

**Files:**
- Create: `src/worker/budget/summary.ts`
- Modify: `src/worker/routes/months.ts` (summary handler and its constants)
- Test: `test/summary.spec.ts` (unchanged; it proves the move)

**Interfaces:**
- Produces: `readMonthSummary(db: D1Database, month: string, now: Date): Promise<MonthSummary>`; `type MonthSummary`; `type SummaryLine = { categoryId: number | null; kind: string | null; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number }`.

- [ ] **Step 1: Create `src/worker/budget/summary.ts`** by moving `MONTH_SQL`, `INBOX_COUNT_SQL`, `Group`, `Line` (renamed `SummaryLine`), `perWeek` and the handler body out of `months.ts`:

```ts
import { daysInMonth, londonMonth, londonToday } from "../importer/dates";
import { readBudget, sumAllocated } from "./effective";
import { COUNTS, INBOX, IN_MONTH, RESOLVED_CTE, inMonthBinds } from "./resolve";

// Everything the home screen needs for one month (docs/phase-2-spec.md, "What a transaction
// counts as" and "Budget figures for a month"). Spend is positive = money out, so a refund is
// negative spend. Aggregation is in SQL: four statements, each reading only the month's rows,
// the transactions still to sort, or a handful of budget and account rows. The summary route and
// the weekly digest share it.

// One row per category_id among the counted rows (vanished_at IS NULL) that count in the month
// (of counted_date ?? txn_date). Binds: inMonthBinds(month).
const MONTH_SQL = `WITH ${RESOLVED_CTE}
SELECT r.category_id, c.kind,
  sum(-COALESCE(r.counted_amount_minor, r.amount_minor)) AS spent,
  COALESCE(sum(CASE WHEN r.is_pending = 1 THEN -COALESCE(r.counted_amount_minor, r.amount_minor) END), 0) AS pending
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE r.vanished_at IS NULL AND ${IN_MONTH} AND ${COUNTS}
GROUP BY r.category_id`;

// The inbox spans every month.
const INBOX_COUNT_SQL = `WITH ${RESOLVED_CTE} SELECT count(*) AS n FROM resolved r WHERE ${INBOX}`;

type Group = { category_id: number | null; kind: string | null; spent: number; pending: number };
export type SummaryLine = { categoryId: number | null; kind: string | null; spentMinor: number; pendingSpentMinor: number; allocatedMinor: number };

/** Integer division, so the per-week figure is floored exactly. */
const perWeek = (leftMinor: number, daysRemaining: number) =>
  leftMinor > 0 ? Number((BigInt(leftMinor) * 7n) / BigInt(daysRemaining)) : 0;

/** The month summary for `month` (no later than the current London month at `now`). */
export async function readMonthSummary(db: D1Database, month: string, now: Date) {
  const current = londonMonth(now);
  const [budget, groups, inbox, freshness] = await Promise.all([
    readBudget(db, month),
    db.prepare(MONTH_SQL).bind(...inMonthBinds(month)).all<Group>(),
    db.prepare(INBOX_COUNT_SQL).first<{ n: number }>(),
    db.prepare("SELECT max(last_data_change_at) AS at FROM accounts WHERE import_enabled = 1").first<{ at: string | null }>(),
  ]);

  // Every category with a counting row this month, or an allocation above 0.
  const lines = new Map<number | null, SummaryLine>();
  for (const g of groups.results) {
    lines.set(g.category_id, { categoryId: g.category_id, kind: g.kind, spentMinor: g.spent, pendingSpentMinor: g.pending, allocatedMinor: 0 });
  }
  for (const a of budget.allocations) {
    if (a.allocatedMinor === 0) continue;
    const existing = lines.get(a.categoryId);
    if (existing) existing.allocatedMinor = a.allocatedMinor;
    else lines.set(a.categoryId, { categoryId: a.categoryId, kind: "budgeted", spentMinor: 0, pendingSpentMinor: 0, allocatedMinor: a.allocatedMinor });
  }
  const categories = [...lines.values()].sort((x, y) => (x.categoryId ?? Infinity) - (y.categoryId ?? Infinity));

  // Lines are budgeted, tracked or Uncategorised (COUNTS drops the rest); all but tracked are budget spend.
  let spentMinor = 0;
  let pendingSpentMinor = 0;
  let trackedMinor = 0;
  for (const l of categories) {
    if (l.kind === "tracked") trackedMinor += l.spentMinor;
    else {
      spentMinor += l.spentMinor;
      pendingSpentMinor += l.pendingSpentMinor;
    }
  }

  const { overallMinor } = budget;
  const allocatedMinor = sumAllocated(budget);
  const leftMinor = overallMinor === null ? null : overallMinor - spentMinor;
  // Pacing is for the current month only; today counts as a day remaining.
  const daysRemaining = month === current ? daysInMonth(month) - Number(londonToday(now).slice(8)) + 1 : null;

  return {
    month,
    overallMinor,
    allocatedMinor,
    miscMinor: overallMinor === null ? null : overallMinor - allocatedMinor,
    spentMinor,
    pendingSpentMinor,
    leftMinor,
    daysRemaining,
    perWeekMinor: daysRemaining === null || leftMinor === null ? null : perWeek(leftMinor, daysRemaining),
    categories,
    trackedMinor,
    inboxCount: inbox?.n ?? 0,
    lastDataChangeAt: freshness?.at ?? null,
  };
}

export type MonthSummary = Awaited<ReturnType<typeof readMonthSummary>>;
```

- [ ] **Step 2: Shrink the route** in `src/worker/routes/months.ts`. Delete the moved code and the file-top summary comment, keep `monthParam`, `BUDGET_SPEND`, `LINES`, `CATEGORY_LINE`, `lineQuery` and the `/:month/transactions` handler, and replace the summary handler with:

```ts
export const monthRoutes = new Hono<AppEnv>().get("/:month/summary", async (c) => {
  const now = new Date();
  const month = monthParam(c, londonMonth(now));
  if (month === null) return c.json({ error: "bad_request" }, 400);
  return c.json(await readMonthSummary(c.env.DB, month, now));
})
```

Add `import { readMonthSummary } from "../budget/summary";` and delete the imports ESLint now reports unused (`readBudget`, `sumAllocated`, `INBOX`, `RESOLVED_CTE`, `daysInMonth`, `londonToday`).

- [ ] **Step 3: Run** `npx vitest run test/summary.spec.ts test/month-transactions.spec.ts test/rows-read.spec.ts` — expected PASS, including "runs 4 D1 statements".
- [ ] **Step 4: Run** `npm run check` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/worker/budget/summary.ts src/worker/routes/months.ts
git commit -m "refactor(worker): move the month summary into its own module

The weekly digest needs the same figures without an HTTP round trip.

Phase: P2.8"
```

### Task 2: Stale flags on accounts and the month summary

**Files:**
- Modify: `src/worker/importer/dates.ts` (add `daysBetween`)
- Create: `src/worker/budget/stale.ts`
- Modify: `src/worker/routes/accounts.ts`, `src/worker/budget/summary.ts`
- Modify: `docs/schema-and-api.md` (accounts and summary fields), `docs/ui-design.md` (Open questions: stale wait is 4 days)
- Test: `test/importer/dates.spec.ts` (append), create `test/stale.spec.ts`

**Interfaces:**
- Produces: `daysBetween(from: string, to: string): number`; `STALE_AFTER_DAYS = 4`; `staleDays(lastDataChangeAt: string | null, now: Date): number | null`; `isStale(days: number | null): boolean`; `type AccountFreshness = { id: number; lastDataChangeAt: string | null }`; `ENABLED_FRESHNESS_SQL`; `staleIds(rows: AccountFreshness[], now: Date): number[]`; `latestChange(rows: AccountFreshness[]): string | null`. `GET /api/accounts` rows gain `stale: boolean`, `staleDays: number | null`; `MonthSummary` gains `staleAccountIds: number[]`.

- [ ] **Step 1: Write the failing tests.** Append to `test/importer/dates.spec.ts` (add `daysBetween` to its import from `../../src/worker/importer/dates`):

```ts
describe("daysBetween", () => {
  it.each([
    ["2026-10-11", "2026-10-15", 4],
    ["2026-10-15", "2026-10-15", 0],
    ["2026-10-15", "2026-10-11", -4],
    ["2026-02-27", "2026-03-01", 2],
    ["2024-02-28", "2024-03-01", 2],
  ])("%s → %s is %i", (from, to, days) => expect(daysBetween(from, to)).toBe(days));

  it("rejects an impossible date", () => expect(() => daysBetween("2026-02-30", "2026-03-01")).toThrow());
});
```

Create `test/stale.spec.ts`:

```ts
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staleDays } from "../src/worker/budget/stale";
import { insertAccount, resetDb } from "./db";
import { get } from "./http";

// All data is synthetic.

const setChange = (id: number, at: string | null) =>
  env.DB.prepare("UPDATE accounts SET last_data_change_at = ?1 WHERE id = ?2").bind(at, id).run();

describe("staleDays", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  it.each([
    ["2026-10-15T01:00:00Z", 0],
    ["2026-10-12T00:30:00Z", 3],
    ["2026-10-11T23:30:00Z", 3], // already 12 Oct in London (BST)
    ["2026-10-11T22:30:00Z", 4], // still 11 Oct in London
  ])("%s → %i London days", (at, days) => expect(staleDays(at, now)).toBe(days));

  it("is null when the account has never changed", () => expect(staleDays(null, now)).toBeNull());

  it("counts London days across the clocks going back on 25 Oct", () => {
    // 25 Oct 00:30 BST → 28 Oct 23:30 GMT.
    expect(staleDays("2026-10-24T23:30:00Z", new Date("2026-10-28T23:30:00Z"))).toBe(3);
  });
});

describe("stale accounts in the API", () => {
  beforeEach(async () => {
    await resetDb();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  async function fourAccounts() {
    const [fresh, stale, never, disabled] = [
      await insertAccount({ providerAccountId: "1" }),
      await insertAccount({ providerAccountId: "2" }),
      await insertAccount({ providerAccountId: "3" }),
      await insertAccount({ providerAccountId: "4" }),
    ];
    await setChange(fresh, "2026-10-12T09:00:00Z");
    await setChange(stale, "2026-10-11T09:00:00Z");
    await setChange(never, null);
    await setChange(disabled, "2026-09-01T09:00:00Z");
    await env.DB.prepare("UPDATE accounts SET import_enabled = 0 WHERE id = ?1").bind(disabled).run();
    return { fresh, stale, never, disabled };
  }

  it("GET /api/accounts flags an enabled account from 4 London days without new data", async () => {
    const { fresh, stale, never, disabled } = await fourAccounts();
    const body = (await (await get("/api/accounts")).json()) as { accounts: { id: number; stale: boolean; staleDays: number | null }[] };
    expect(body.accounts.map(({ id, stale, staleDays }) => ({ id, stale, staleDays }))).toEqual([
      { id: fresh, stale: false, staleDays: 3 },
      { id: stale, stale: true, staleDays: 4 },
      { id: never, stale: false, staleDays: null },
      { id: disabled, stale: false, staleDays: null },
    ]);
  });

  it("the current month's summary lists stale enabled accounts, and a past month lists none", async () => {
    const { stale } = await fourAccounts();
    const current = (await (await get("/api/months/2026-10/summary")).json()) as { staleAccountIds: number[]; lastDataChangeAt: string };
    expect(current.staleAccountIds).toEqual([stale]);
    // The latest change across enabled accounts, ignoring the disabled one.
    expect(current.lastDataChangeAt).toBe("2026-10-12T09:00:00Z");
    const past = (await (await get("/api/months/2026-09/summary")).json()) as { staleAccountIds: number[] };
    expect(past.staleAccountIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/stale.spec.ts test/importer/dates.spec.ts` — expected FAIL (`daysBetween` / `staleDays` not exported).

- [ ] **Step 3: Implement.** Append to `src/worker/importer/dates.ts`:

```ts
/** Whole days from `from` to `to`, both YYYY-MM-DD; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b || !isYmd(from) || !isYmd(to)) throw new Error("daysBetween: not a YYYY-MM-DD date");
  return (Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86_400_000;
}
```

Create `src/worker/budget/stale.ts`:

```ts
import { daysBetween, londonToday } from "../importer/dates";

// Stale data (docs/phase-2-insights-spec.md): an enabled account whose data hasn't changed for
// STALE_AFTER_DAYS London days or more. An account that's only quiet looks stale too; accepted,
// since "hasn't updated" is still true.

export const STALE_AFTER_DAYS = 4;

export type AccountFreshness = { id: number; lastDataChangeAt: string | null };

/** The enabled accounts' last data change: the one statement stale checks need. */
export const ENABLED_FRESHNESS_SQL =
  "SELECT id, last_data_change_at AS lastDataChangeAt FROM accounts WHERE import_enabled = 1 ORDER BY id";

/** Whole London days since `lastDataChangeAt` (an ISO timestamp), or null when it's never been set. */
export function staleDays(lastDataChangeAt: string | null, now: Date): number | null {
  return lastDataChangeAt === null ? null : daysBetween(londonToday(new Date(lastDataChangeAt)), londonToday(now));
}

export const isStale = (days: number | null) => days !== null && days >= STALE_AFTER_DAYS;

/** Ids of the stale accounts among `rows`. */
export const staleIds = (rows: AccountFreshness[], now: Date) => rows.filter((r) => isStale(staleDays(r.lastDataChangeAt, now))).map((r) => r.id);

/** The latest last data change among `rows` (ISO timestamps sort as text), or null. */
export const latestChange = (rows: AccountFreshness[]) =>
  rows.reduce<string | null>((max, r) => (r.lastDataChangeAt !== null && (max === null || r.lastDataChangeAt > max) ? r.lastDataChangeAt : max), null);
```

In `src/worker/routes/accounts.ts`, import `isStale, staleDays` from `../budget/stale` and change the `GET /` return to:

```ts
    // Only enabled accounts can be stale: a disabled one isn't expected to change.
    const now = new Date();
    return c.json({
      accounts: rows.map((a) => {
        const days = a.importEnabled ? staleDays(a.lastDataChangeAt, now) : null;
        return { ...a, stale: isStale(days), staleDays: days };
      }),
    });
```

In `src/worker/budget/summary.ts`, import `ENABLED_FRESHNESS_SQL, latestChange, staleIds, type AccountFreshness` from `./stale`; replace the fourth `Promise.all` entry with `db.prepare(ENABLED_FRESHNESS_SQL).all<AccountFreshness>(),` and the return's last field with:

```ts
    lastDataChangeAt: latestChange(freshness.results),
    // Stale warnings are about now, so only the current month carries them.
    staleAccountIds: month === current ? staleIds(freshness.results, now) : [],
```

- [ ] **Step 4: Run** `npx vitest run test/stale.spec.ts test/importer/dates.spec.ts test/summary.spec.ts test/account-review.spec.ts` — expected PASS (the summary still runs 4 statements). If a `summary.spec.ts` or `account-review.spec.ts` assertion compares a whole response with `toEqual`, add `staleAccountIds: []` (summary) or `stale`/`staleDays` (accounts) to its expected value.
- [ ] **Step 5: Docs.** In `docs/schema-and-api.md`, add `stale` and `staleDays` to the `GET /api/accounts` row description and `staleAccountIds` to the summary response, citing phase-2-insights-spec.md. In `docs/ui-design.md` → Open questions, replace the stale-wait bullet with "Settled: a stale account warns after 4 days without new data (phase-2-insights-spec.md)."
- [ ] **Step 6: Run** `npm run check`, then `security-review` (touches `/api/*`).
- [ ] **Step 7: Commit**

```bash
git add src/worker/importer/dates.ts src/worker/budget/stale.ts src/worker/routes/accounts.ts src/worker/budget/summary.ts test/stale.spec.ts test/importer/dates.spec.ts
git commit -m "feat(worker): flag accounts with no new data for 4 days

Phase: P2.8"
git add docs/schema-and-api.md docs/ui-design.md
git commit -m "docs: record the stale-account fields and settle the 4-day wait"
```

### Task 3: Home and Accounts stale states

Builds the states already designed in `docs/ui-design.md` (Home → Stale data; Accounts → Stale account).

**Files:**
- Modify: `src/web/api.ts` (`Account`, `MonthSummary` types)
- Create: `src/web/stale.ts`
- Modify: `src/web/screens/Home.tsx` (`Freshness`, banner), `src/web/screens/Accounts.tsx` (`AccountCard`)
- Modify: `src/web/mock/index.ts` (stale fields, `?mock=stale`)
- Modify: `test/tsconfig.json` (include `../src/web/stale.ts`)
- Test: create `test/web/stale.spec.ts`

**Interfaces:**
- Consumes: `stale`, `staleDays` on accounts; `staleAccountIds` on the summary; `staleDays`, `isStale` from `src/worker/budget/stale.ts` (mock only).
- Produces: `perAccountFreshness(accounts: Account[], now?: Date): string`; `staleBannerText(stale: Account[]): string`.

- [ ] **Step 1: Write the failing test** `test/web/stale.spec.ts`, and add `"../src/web/stale.ts"` to `include` in `test/tsconfig.json`:

```ts
import { describe, expect, it } from "vitest";
import type { Account } from "../../src/web/api";
import { perAccountFreshness, staleBannerText } from "../../src/web/stale";

// Synthetic accounts only.
const account = (id: number, name: string, over: Partial<Account> = {}): Account => ({
  id, name, institutionName: null, providerStatus: "ACTIVE", currency: "GBP", balanceMinor: null, balanceFetchedAt: null,
  importEnabled: true, lastImportAttemptAt: null, lastImportSuccessAt: null, lastImportError: null, consecutiveFailures: 0,
  lastDataChangeAt: null, newestTxnDate: null, backfillComplete: true, needsReview: false, stale: false, staleDays: null, ...over,
});

describe("perAccountFreshness", () => {
  it("names each enabled account with its age", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const accounts = [
      account(1, "Bank A", { lastDataChangeAt: "2026-10-15T10:00:00Z" }),
      account(2, "Card B", { lastDataChangeAt: "2026-10-11T09:00:00Z" }),
      account(3, "Old C", { importEnabled: false }),
    ];
    expect(perAccountFreshness(accounts, now)).toBe("Bank A 2h ago · Card B 4 days ago");
  });
});

describe("staleBannerText", () => {
  it("names one stale account", () => {
    expect(staleBannerText([account(2, "Card B", { stale: true, staleDays: 4 })])).toBe(
      "Card B hasn't updated for 4 days, so recent spending may be missing.",
    );
  });
  it("counts several, from the shortest wait", () => {
    expect(staleBannerText([account(1, "Bank A", { stale: true, staleDays: 6 }), account(2, "Card B", { stale: true, staleDays: 4 })])).toBe(
      "2 accounts haven't updated for 4+ days, so recent spending may be missing.",
    );
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/web/stale.spec.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement.** In `src/web/api.ts`, add to `Account` after `needsReview`:

```ts
  /** No new data for 4+ London days (enabled accounts only). */
  stale: boolean;
  /** Whole days since the last data change; null if never, or for a disabled account. */
  staleDays: number | null;
```

and to `MonthSummary` after `lastDataChangeAt`:

```ts
  /** Enabled accounts with no new data for 4+ days; always empty for a past month. */
  staleAccountIds: number[];
```

Create `src/web/stale.ts`:

```ts
import type { Account } from "./api";
import { ageText } from "./pace";

// Stale-data copy (docs/ui-design.md, Home and Accounts). The Worker decides which accounts are
// stale (docs/phase-2-insights-spec.md); these only word it.

/** "Bank A 2h ago · Card B 4 days ago": Home's freshness line once an account is stale. */
export const perAccountFreshness = (accounts: Account[], now: Date = new Date()) =>
  accounts
    .filter((a) => a.importEnabled)
    .map((a) => `${a.name} ${a.lastDataChangeAt ? ageText(a.lastDataChangeAt, now) : "never"}`)
    .join(" · ");

/** Home's banner: one stale account by name, several by count. */
export function staleBannerText(stale: Account[]): string {
  if (stale.length === 1) return `${stale[0]!.name} hasn't updated for ${stale[0]!.staleDays} days, so recent spending may be missing.`;
  const shortest = Math.min(...stale.map((a) => a.staleDays ?? 0));
  return `${stale.length} accounts haven't updated for ${shortest}+ days, so recent spending may be missing.`;
}
```

In `src/web/screens/Home.tsx`:
1. Import `type Account` from `../api` and `perAccountFreshness, staleBannerText` from `../stale`.
2. Change `Freshness`'s props to `{ summary: ReturnType<typeof useSummary>; accounts: Account[] }`, derive `const enabledAccounts = accounts.filter((a) => a.importEnabled).length;` inside, and replace the final `else` branch with:

```tsx
  } else if (summary.data.staleAccountIds.length > 0) {
    dot = "bg-warn";
    text = perAccountFreshness(accounts);
  } else {
    const at = summary.data.lastDataChangeAt;
    const scope = enabledAccounts === 2 ? " · both accounts" : enabledAccounts > 2 ? ` · ${enabledAccounts} accounts` : "";
    text = at ? `Updated ${ageText(at)}${scope}` : "Not imported yet";
  }
```

3. Add below `Freshness`:

```tsx
/** The amber stale-data banner (docs/ui-design.md, Home → Stale data). */
function StaleBanner({ stale }: { stale: Account[] }) {
  return (
    <Link href="/accounts" className="mx-4 mt-3 flex items-start gap-2 rounded-input bg-warn-tint px-3 py-2.5 text-[13px] leading-normal text-warn-fg">
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />
      <span>
        {staleBannerText(stale)} <span className="underline">Accounts</span>
      </span>
    </Link>
  );
}
```

4. In the screen component (where `enabledAccounts` is computed today, around line 478), replace that line with `const allAccounts = accounts.data?.all ?? [];` and `const stale = allAccounts.filter((a) => s?.staleAccountIds.includes(a.id));`; pass `accounts={allAccounts}` to `<Freshness>`; and render `{isCurrent && stale.length > 0 && <StaleBanner stale={stale} />}` as the first child inside `<TabScreen>`, before the dashboard conditional.

In `src/web/screens/Accounts.tsx`: change the top comment's second sentence to "Stale accounts come from the Worker's `stale` flag (docs/phase-2-insights-spec.md)." In `AccountCard`, replace the `status` and `<li className=…>` lines and add the warning box after the failing message:

```tsx
  const stale = account.importEnabled && !failing && account.stale;
  const status = !account.importEnabled
    ? { text: "Not imported", dot: "bg-muted", tone: "text-muted" }
    : failing
      ? { text: "Import failing", dot: "bg-over", tone: "text-over-fg" }
      : stale
        ? { text: "No new data", dot: "bg-warn", tone: "text-warn-fg" }
        : { text: "Up to date", dot: "bg-accent", tone: "text-accent-fg" };
```

```tsx
    <li className={`rounded-card border bg-surface px-4 pt-3.5 pb-1 ${failing ? "border-over/40" : stale ? "border-warn/40" : "border-divider"}`}>
```

```tsx
      {stale && (
        <div className="mb-2.5 rounded-input bg-warn-tint px-3 py-2.5 text-[13px] leading-normal text-warn-fg">
          <p>
            No new data for {account.staleDays} days, so Tally's totals may be missing recent spending. If the bank connection has dropped,
            reconnect it in Lunch Flow.
          </p>
          <a className="mt-1.5 inline-block underline" href="https://www.lunchflow.app" target="_blank" rel="noreferrer">
            Open Lunch Flow
          </a>
        </div>
      )}
```

In `src/web/mock/index.ts`:
1. Import `isStale, staleDays` from `../../worker/budget/stale`.
2. Add `stale: false, staleDays: null,` to `ACCOUNT_DEFAULTS`.
3. Above the handlers add:

```ts
/** Stale flags as the Worker computes them (docs/phase-2-insights-spec.md). */
function withStale(a: Account): Account {
  const days = a.importEnabled ? staleDays(a.lastDataChangeAt, new Date()) : null;
  return { ...a, stale: isStale(days), staleDays: days };
}
```

4. In the `GET /api/accounts` handler, map with `withStale`: `ok({ accounts: accounts.filter((a) => a.importEnabled || a.needsReview).map(withStale) })`.
5. In `summary()`'s returned object, after `lastDataChangeAt`, add `staleAccountIds: month === monthOf(today) ? accounts.map(withStale).filter((a) => a.stale).map((a) => a.id) : [],`.
6. Add `"stale" (one account without new data for 5 days),` to the scenario doc comment, and after the `"over"` block: `if (scenario === "stale") accounts[1]!.lastDataChangeAt = hoursAgo(5 * 24);`.

- [ ] **Step 4: Run** `npx vitest run test/web/stale.spec.ts` — expected PASS. Then `npm run check` — expected PASS.
- [ ] **Step 5: Look at it.** Use the `run` skill: `npm run dev`, open `/?mock=stale` at 390 × 844. Expect an amber dot with "Bank … · Card … 5 days ago", the amber banner linking to Accounts, and on `/accounts` the amber "No new data" card with the warning box. Then open `/?mock=` (clears the scenario) and confirm the normal sage line.
- [ ] **Step 6: Commit**

```bash
git add src/web/api.ts src/web/stale.ts src/web/screens/Home.tsx src/web/screens/Accounts.tsx src/web/mock/index.ts test/web/stale.spec.ts test/tsconfig.json
git commit -m "feat(web): show stale accounts on Home and Accounts

Phase: P2.8"
```

### Task 4: Pre-PR checks and PR

- [ ] Run `code-review` (CLAUDE.md's pre-PR review), fix what it finds, then `simplify`. `security-review` already ran in Task 2.
- [ ] Push and open a PR `feat: flag stale accounts` with the **Accept when** below in its description. Merge only on the owner's approval.

**Accept when (P2.8):** `npm run check` passes; `?mock=stale` shows the designed Home and Accounts states; after deploy, the owner opens `/api/accounts` in a logged-in browser and sees `stale`/`staleDays` on each enabled account.

---

# P2.9 Analytics API

Branch: `git checkout main && git pull && git checkout -b feat/analytics-api`

### Task 1: Date-range spend, month helpers and integer maths

**Files:**
- Modify: `src/worker/budget/resolve.ts` (`IN_DATES`; `IN_MONTH` becomes a case of it)
- Modify: `src/worker/importer/dates.ts` (move `addMonths` here from web; add `monthsEnding`)
- Modify: `src/web/dates.ts` (re-export `addMonths`)
- Create: `src/worker/analytics/math.ts`, `src/worker/analytics/spend.ts`
- Test: create `test/analytics/math.spec.ts`, `test/analytics/spend.spec.ts`; existing `test/web/dates.spec.ts` covers `addMonths`

**Interfaces:**
- Produces: `IN_DATES`, `inDatesBinds(from: string, to: string): string[]`; `addMonths(month: string, n: number): string`; `monthsEnding(last: string, count: number): string[]` (oldest first); `floorDiv(a: number, b: number): number` (b > 0); `projectedMinor(spentMinor: number, dom: number, dim: number): number`; `type SpendRow = { month: string; categoryId: number | null; kind: "budgeted" | "tracked" | null; spentMinor: number; pendingSpentMinor: number }`; `spendByMonth(db, from, to): Promise<SpendRow[]>`; `budgetSpend(rows)`, `pendingBudgetSpend(rows)`, `trackedSpend(rows)`: `number`; `firstDataMonth(db): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests.** `test/analytics/math.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { floorDiv, projectedMinor } from "../../src/worker/analytics/math";
import { monthsEnding } from "../../src/worker/importer/dates";

describe("floorDiv", () => {
  it.each([
    [7, 2, 3],
    [6, 2, 3],
    [-1, 2, -1],
    [-7, 2, -4],
    [0, 5, 0],
    [2001, 2, 1000],
  ])("%i ÷ %i → %i", (a, b, q) => expect(floorDiv(a, b)).toBe(q));
});

describe("projectedMinor", () => {
  it("floors spend × days in month ÷ day of month", () => expect(projectedMinor(1001, 3, 31)).toBe(10343));
  it("is the spend itself on the last day", () => expect(projectedMinor(5000, 30, 30)).toBe(5000));
});

describe("monthsEnding", () => {
  it("lists the months up to and including the last, oldest first, across a year", () =>
    expect(monthsEnding("2026-02", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]));
});
```

`test/analytics/spend.spec.ts`:

```ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { budgetSpend, firstDataMonth, spendByMonth, trackedSpend } from "../../src/worker/analytics/spend";
import { SEEDED, insertOverride, insertRule, ledger } from "../budget/helpers";
import { resetDb } from "../db";

// All data is synthetic.

let a: number;
let txn: Awaited<ReturnType<typeof ledger>>["txn"];

beforeEach(async () => {
  await resetDb();
  const l = await ledger();
  a = l.accounts[0];
  txn = l.txn;
  await insertRule("exact", "grocer", SEEDED.groceries);
  await insertRule("exact", "outfitter", SEEDED.clothes);
  await insertRule("exact", "salary", SEEDED.income);
});

describe("spendByMonth", () => {
  it("groups counted spend by month and category, with pending apart", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-09-30" });
    await txn(a, { merchant: "Grocer", amountMinor: -500, txnDate: "2026-10-01", isPending: true });
    await txn(a, { merchant: "Outfitter", amountMinor: -2_000, txnDate: "2026-10-02" });
    await txn(a, { merchant: "Salary", amountMinor: 300_000, txnDate: "2026-10-02" });
    await txn(a, { merchant: "Unknown shop", amountMinor: -700, txnDate: "2026-10-03" });
    await txn(a, { merchant: "Unknown sender", amountMinor: 900, txnDate: "2026-10-03" });
    const rows = await spendByMonth(env.DB, "2026-09-01", "2026-10-31");
    expect(rows).toEqual([
      { month: "2026-09", categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 1_000, pendingSpentMinor: 0 },
      { month: "2026-10", categoryId: null, kind: null, spentMinor: 700, pendingSpentMinor: 0 },
      { month: "2026-10", categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 500, pendingSpentMinor: 500 },
      { month: "2026-10", categoryId: SEEDED.clothes, kind: "tracked", spentMinor: 2_000, pendingSpentMinor: 0 },
    ]);
    const october = rows.filter((r) => r.month === "2026-10");
    expect(budgetSpend(october)).toBe(1_200);
    expect(trackedSpend(october)).toBe(2_000);
  });

  it("follows the counted date, not the bank date, at both ends of the range", async () => {
    const movedIn = await txn(a, { merchant: "Grocer", amountMinor: -100, txnDate: "2026-09-30" });
    const movedOut = await txn(a, { merchant: "Grocer", amountMinor: -200, txnDate: "2026-10-31" });
    await insertOverride(movedIn, { counted_date: "2026-10-01" });
    await insertOverride(movedOut, { counted_date: "2026-11-01" });
    expect(await spendByMonth(env.DB, "2026-10-01", "2026-10-31")).toEqual([
      { month: "2026-10", categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 100, pendingSpentMinor: 0 },
    ]);
    // A week-sized range follows the counted date too (the digest's week spend uses it).
    expect(await spendByMonth(env.DB, "2026-10-26", "2026-11-01")).toEqual([
      { month: "2026-11", categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 200, pendingSpentMinor: 0 },
    ]);
  });

  it("ignores vanished rows and excluded overrides", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -100, txnDate: "2026-10-05", vanished: true });
    const excluded = await txn(a, { merchant: "Grocer", amountMinor: -200, txnDate: "2026-10-05" });
    await insertOverride(excluded, { excluded: 1 });
    expect(await spendByMonth(env.DB, "2026-10-01", "2026-10-31")).toEqual([]);
  });
});

describe("firstDataMonth", () => {
  it("is null on an empty ledger and the earliest month otherwise", async () => {
    expect(await firstDataMonth(env.DB)).toBeNull();
    await txn(a, { txnDate: "2025-03-14" });
    await txn(a, { txnDate: "2026-01-02" });
    expect(await firstDataMonth(env.DB)).toBe("2025-03");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/analytics` — expected FAIL (modules missing).

- [ ] **Step 3: Implement.** In `src/worker/budget/resolve.ts`, replace `IN_MONTH` and `inMonthBinds` with:

```ts
/**
 * On `resolved r`: the rows counted from `from` to `to` inclusive, by `counted_date ?? txn_date`;
 * bind inDatesBinds(from, to). The first condition only narrows: it lets SQLite seek the range's
 * bank dates and the overrides that count a row in it. The second is the exact rule.
 */
export const IN_DATES = `(r.txn_date BETWEEN ? AND ? OR r.id IN (SELECT transaction_id FROM transaction_overrides WHERE counted_date BETWEEN ? AND ?))
  AND COALESCE(r.counted_date, r.txn_date) BETWEEN ? AND ?`;

/** IN_DATES's binds. A bound past a month's last day (e.g. -31 in April) still sorts correctly as text. */
export const inDatesBinds = (from: string, to: string) => [from, to, from, to, from, to];

/** On `resolved r`: the rows counted in a month; bind inMonthBinds(month). */
export const IN_MONTH = IN_DATES;

/** IN_MONTH's binds. Every date in a month sorts between its -01 and -31. */
export const inMonthBinds = (month: string) => inDatesBinds(`${month}-01`, `${month}-31`);
```

Move `addMonths` from `src/web/dates.ts` to the end of `src/worker/importer/dates.ts`, unchanged except for its doc comment, and add `monthsEnding`:

```ts
/** The month `n` months after `month` (YYYY-MM); a negative `n` goes back. */
export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** The `count` months ending with `last`, oldest first. */
export const monthsEnding = (last: string, count: number) => Array.from({ length: count }, (_, i) => addMonths(last, i - count + 1));
```

In `src/web/dates.ts`, delete the local `addMonths`, add it to the import from `../worker/importer/dates`, and to the `export { addDays, daysInMonth, isYmd }` line (`export { addDays, addMonths, daysInMonth, isYmd };`). Remove `splitMonth` only if nothing else uses it.

Create `src/worker/analytics/math.ts`:

```ts
// Integer arithmetic for figures derived from minor units (docs/phase-2-insights-spec.md):
// divisions floor, nothing goes through a float.

/** a ÷ b rounded down (towards −∞), for safe integers and b > 0. */
export function floorDiv(a: number, b: number): number {
  const q = BigInt(a) / BigInt(b);
  return Number(BigInt(a) % BigInt(b) < 0n ? q - 1n : q);
}

/** Spend by the month's end at this rate: floor(spent × days in month ÷ day of month). */
export const projectedMinor = (spentMinor: number, dom: number, dim: number) => floorDiv(spentMinor * dim, dom);
```

Create `src/worker/analytics/spend.ts`:

```ts
import { COUNTS, IN_DATES, RESOLVED_CTE, inDatesBinds } from "../budget/resolve";

// Spend by counted month and category: the figure every analytics view and insight is built
// from. The same rows the month summary counts (COUNTS), so the views always agree with Home.

const SPEND_SQL = `WITH ${RESOLVED_CTE}
SELECT substr(COALESCE(r.counted_date, r.txn_date), 1, 7) AS month, r.category_id AS categoryId, c.kind,
  sum(-COALESCE(r.counted_amount_minor, r.amount_minor)) AS spentMinor,
  COALESCE(sum(CASE WHEN r.is_pending = 1 THEN -COALESCE(r.counted_amount_minor, r.amount_minor) END), 0) AS pendingSpentMinor
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE r.vanished_at IS NULL AND ${IN_DATES} AND ${COUNTS}
GROUP BY month, r.category_id
ORDER BY month, r.category_id`;

export type SpendRow = { month: string; categoryId: number | null; kind: "budgeted" | "tracked" | null; spentMinor: number; pendingSpentMinor: number };

/** Spend counted from `from` to `to` (YYYY-MM-DD, inclusive), one row per month and category. One statement. */
export async function spendByMonth(db: D1Database, from: string, to: string): Promise<SpendRow[]> {
  const { results } = await db.prepare(SPEND_SQL).bind(...inDatesBinds(from, to)).all<SpendRow>();
  return results;
}

/** Budget spend (budgeted and uncategorised; tracked never counts) among `rows`. */
export const budgetSpend = (rows: SpendRow[]) => rows.reduce((sum, r) => (r.kind === "tracked" ? sum : sum + r.spentMinor), 0);

/** The pending part of budgetSpend. */
export const pendingBudgetSpend = (rows: SpendRow[]) => rows.reduce((sum, r) => (r.kind === "tracked" ? sum : sum + r.pendingSpentMinor), 0);

/** Tracked spend among `rows`. */
export const trackedSpend = (rows: SpendRow[]) => rows.reduce((sum, r) => (r.kind === "tracked" ? sum + r.spentMinor : sum), 0);

/** The month of the earliest transaction (one seek on transactions_txn_date_idx), or null with none. */
export async function firstDataMonth(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT substr(min(txn_date), 1, 7) AS month FROM transactions").first<{ month: string | null }>();
  return row?.month ?? null;
}
```

- [ ] **Step 4: Run** `npx vitest run test/analytics test/summary.spec.ts test/month-transactions.spec.ts test/web/dates.spec.ts test/rows-read.spec.ts` — expected PASS (`IN_MONTH` behaves as before).
- [ ] **Step 5: Run** `npm run check`.
- [ ] **Step 6: Commit**

```bash
git add src/worker/budget/resolve.ts src/worker/importer/dates.ts src/web/dates.ts src/worker/analytics test/analytics
git commit -m "feat(worker): add spend by month and category over a date range

Phase: P2.9"
```

### Task 2: `GET /api/months/:month/review`

**Files:**
- Create: `src/worker/analytics/review.ts`
- Modify: `src/worker/routes/months.ts` (add the route)
- Test: create `test/analytics/review.spec.ts`

**Interfaces:**
- Consumes: `spendByMonth`, `budgetSpend`, `trackedSpend` (Task 1); `readBudget` (`src/worker/budget/effective.ts`); `addMonths`.
- Produces: `readReview(db: D1Database, month: string): Promise<Review>`, shaped as the spec's review response.

- [ ] **Step 1: Write the failing test** `test/analytics/review.spec.ts`:

```ts
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAllocation, insertOverall } from "../budget/budget-rows";
import { SEEDED, insertRule, ledger } from "../budget/helpers";
import { NOW, resetDb } from "../db";
import { get } from "../http";

// All data is synthetic.

type Review = {
  month: string;
  previousMonth: string;
  totals: { spentMinor: number; overallMinor: number | null; trackedMinor: number };
  previousTotals: { spentMinor: number; overallMinor: number | null; trackedMinor: number };
  categories: { categoryId: number | null; kind: string | null; spentMinor: number; previousSpentMinor: number; changeMinor: number; allocatedMinor: number | null; over: boolean }[];
  topMerchants: { merchantKey: string; name: string; spentMinor: number; visits: number }[];
  hasPrevious: boolean;
};

let accounts: readonly [number, number];
let txn: Awaited<ReturnType<typeof ledger>>["txn"];
const review = async (month: string) => (await (await get(`/api/months/${month}/review`)).json()) as Review;

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  ({ accounts, txn } = await ledger());
  await insertRule("exact", "grocer", SEEDED.groceries);
  await insertRule("exact", "outfitter", SEEDED.clothes);
});
afterEach(() => vi.useRealTimers());

describe("GET /api/months/:month/review", () => {
  it.each(["2026-10", "2026-11", "2026-13", "2026-9"])("is 400 for %s (current, future or malformed)", async (month) => {
    expect((await get(`/api/months/${month}/review`)).status).toBe(400);
  });

  it("compares a completed month with the one before", async () => {
    await insertOverall("2026-08", 100_000);
    await insertOverall("2026-09", 120_000);
    await insertAllocation(SEEDED.groceries, "2026-09", 1_000);
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -800, txnDate: "2026-08-10" });
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_500, txnDate: "2026-09-10" });
    await txn(accounts[0], { merchant: "Outfitter", amountMinor: -4_000, txnDate: "2026-09-12" });
    await txn(accounts[0], { merchant: "Unknown shop", amountMinor: -300, txnDate: "2026-08-20" });
    const r = await review("2026-09");
    expect(r).toMatchObject({
      month: "2026-09",
      previousMonth: "2026-08",
      totals: { spentMinor: 1_500, overallMinor: 120_000, trackedMinor: 4_000 },
      previousTotals: { spentMinor: 1_100, overallMinor: 100_000, trackedMinor: 0 },
      hasPrevious: true,
    });
    expect(r.categories).toEqual([
      { categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 1_500, previousSpentMinor: 800, changeMinor: 700, allocatedMinor: 1_000, over: true },
      { categoryId: SEEDED.clothes, kind: "tracked", spentMinor: 4_000, previousSpentMinor: 0, changeMinor: 4_000, allocatedMinor: null, over: false },
      { categoryId: null, kind: null, spentMinor: 0, previousSpentMinor: 300, changeMinor: -300, allocatedMinor: null, over: false },
    ]);
  });

  it("ranks the top 5 merchants by spend, one key across both accounts, named by the latest text", async () => {
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-09-02" });
    await txn(accounts[1], { merchant: "GROCER ", amountMinor: -500, txnDate: "2026-09-20" });
    await txn(accounts[0], { merchant: "Grocer", amountMinor: 200, txnDate: "2026-09-10" }); // a refund: less spend, not a visit
    for (const [i, amount] of [900, 800, 700, 600, 100].entries()) {
      await txn(accounts[0], { merchant: `Shop ${i}`, amountMinor: -amount, txnDate: "2026-09-05" });
    }
    const r = await review("2026-09");
    expect(r.topMerchants).toEqual([
      { merchantKey: "grocer", name: "GROCER ", spentMinor: 1_300, visits: 2 },
      { merchantKey: "shop 0", name: "Shop 0", spentMinor: 900, visits: 1 },
      { merchantKey: "shop 1", name: "Shop 1", spentMinor: 800, visits: 1 },
      { merchantKey: "shop 2", name: "Shop 2", spentMinor: 700, visits: 1 },
      { merchantKey: "shop 3", name: "Shop 3", spentMinor: 600, visits: 1 },
    ]);
  });

  it("says there's nothing to compare in the first month of history", async () => {
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-09-02" });
    expect(await review("2026-09")).toMatchObject({ hasPrevious: false, previousTotals: { spentMinor: 0, overallMinor: null, trackedMinor: 0 } });
  });

  it("lists an archived category's spend without an allocation", async () => {
    await insertOverall("2026-09", 100_000);
    await insertAllocation(SEEDED.groceries, "2026-09", 1_000);
    await env.DB.prepare("UPDATE categories SET archived_at = ?1 WHERE id = ?2").bind(NOW, SEEDED.groceries).run();
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_500, txnDate: "2026-09-10" });
    expect((await review("2026-09")).categories).toEqual([
      { categoryId: SEEDED.groceries, kind: "budgeted", spentMinor: 1_500, previousSpentMinor: 0, changeMinor: 1_500, allocatedMinor: null, over: false },
    ]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/analytics/review.spec.ts` — expected FAIL (404, route missing).

- [ ] **Step 3: Implement** `src/worker/analytics/review.ts`:

```ts
import { readBudget } from "../budget/effective";
import { COUNTS, IN_MONTH, RESOLVED_CTE, inMonthBinds } from "../budget/resolve";
import { addMonths } from "../importer/dates";
import { budgetSpend, spendByMonth, trackedSpend, type SpendRow } from "./spend";

// The Monthly review (docs/phase-2-insights-spec.md): a completed month against the one before.

const TOP_MERCHANTS = 5;

// Budget and tracked spend by merchant key in one month. A bare column beside max() takes its
// value from the row holding the max, so `name` is the text of the key's latest transaction.
const TOP_MERCHANTS_SQL = `WITH ${RESOLVED_CTE}
SELECT lower(trim(r.merchant)) AS merchantKey, r.merchant AS name, max(r.txn_date) AS latest,
  sum(-COALESCE(r.counted_amount_minor, r.amount_minor)) AS spentMinor,
  sum(COALESCE(r.counted_amount_minor, r.amount_minor) < 0) AS visits
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE r.vanished_at IS NULL AND ${IN_MONTH} AND ${COUNTS}
GROUP BY merchantKey
HAVING spentMinor > 0
ORDER BY spentMinor DESC, merchantKey
LIMIT ${TOP_MERCHANTS}`;

type Totals = { spentMinor: number; overallMinor: number | null; trackedMinor: number };
export type ReviewCategory = {
  categoryId: number | null;
  kind: SpendRow["kind"];
  spentMinor: number;
  previousSpentMinor: number;
  changeMinor: number;
  allocatedMinor: number | null;
  over: boolean;
};

const totals = (rows: SpendRow[], overallMinor: number | null): Totals => ({ spentMinor: budgetSpend(rows), overallMinor, trackedMinor: trackedSpend(rows) });

/** `month` must be a completed month. Five statements. */
export async function readReview(db: D1Database, month: string) {
  const previousMonth = addMonths(month, -1);
  const [spend, budget, previousBudget, merchants] = await Promise.all([
    spendByMonth(db, `${previousMonth}-01`, `${month}-31`),
    readBudget(db, month),
    readBudget(db, previousMonth),
    db.prepare(TOP_MERCHANTS_SQL).bind(...inMonthBinds(month)).all<{ merchantKey: string; name: string; spentMinor: number; visits: number }>(),
  ]);
  const thisRows = spend.filter((r) => r.month === month);
  const previousRows = spend.filter((r) => r.month === previousMonth);

  // readBudget lists unarchived budgeted categories, so an archived one has no allocation here.
  const allocations = new Map<number | null, number>(budget.allocations.filter((a) => a.allocatedMinor > 0).map((a) => [a.categoryId, a.allocatedMinor]));
  const lines = new Map<number | null, ReviewCategory>();
  const line = (categoryId: number | null, kind: SpendRow["kind"]) => {
    let l = lines.get(categoryId);
    if (!l) {
      l = { categoryId, kind, spentMinor: 0, previousSpentMinor: 0, changeMinor: 0, allocatedMinor: allocations.get(categoryId) ?? null, over: false };
      lines.set(categoryId, l);
    }
    return l;
  };
  for (const r of thisRows) line(r.categoryId, r.kind).spentMinor = r.spentMinor;
  for (const r of previousRows) line(r.categoryId, r.kind).previousSpentMinor = r.spentMinor;
  for (const id of allocations.keys()) line(id, "budgeted");

  return {
    month,
    previousMonth,
    totals: totals(thisRows, budget.overallMinor),
    previousTotals: totals(previousRows, previousBudget.overallMinor),
    categories: [...lines.values()]
      .map((l) => ({ ...l, changeMinor: l.spentMinor - l.previousSpentMinor, over: l.allocatedMinor !== null && l.spentMinor > l.allocatedMinor }))
      .sort((x, y) => (x.categoryId ?? Infinity) - (y.categoryId ?? Infinity)),
    topMerchants: merchants.results.map(({ merchantKey, name, spentMinor, visits }) => ({ merchantKey, name, spentMinor, visits })),
    hasPrevious: previousRows.length > 0,
  };
}

export type Review = Awaited<ReturnType<typeof readReview>>;
```

In `src/worker/routes/months.ts`, import `readReview` and chain after the summary route:

```ts
  // Completed months only: the current month's progress is what insights cover.
  .get("/:month/review", async (c) => {
    const current = londonMonth(new Date());
    const month = monthParam(c, current);
    if (month === null || month === current) return c.json({ error: "bad_request" }, 400);
    return c.json(await readReview(c.env.DB, month));
  })
```

- [ ] **Step 4: Run** `npx vitest run test/analytics/review.spec.ts` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/worker/analytics/review.ts src/worker/routes/months.ts test/analytics/review.spec.ts
git commit -m "feat(worker): add the monthly review route

Phase: P2.9"
```

### Task 3: `GET /api/trends`

**Files:**
- Create: `src/worker/analytics/trends.ts`, `src/worker/routes/trends.ts`
- Modify: `src/worker/index.ts` (mount `/trends`)
- Test: create `test/analytics/trends.spec.ts`

**Interfaces:**
- Consumes: `spendByMonth`, `budgetSpend`, `pendingBudgetSpend`, `trackedSpend`, `firstDataMonth`, `floorDiv`, `monthsEnding`, `effectiveOverallSql`.
- Produces: `TREND_MONTHS = 6`; `readTrends(db: D1Database, now: Date)`; `trendRoutes`.

- [ ] **Step 1: Write the failing test** `test/analytics/trends.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertOverall } from "../budget/budget-rows";
import { SEEDED, insertRule, ledger } from "../budget/helpers";
import { resetDb } from "../db";
import { get } from "../http";

// All data is synthetic.

type Trends = {
  months: { month: string; partial: boolean; hasData: boolean; spentMinor: number; pendingSpentMinor: number; overallMinor: number | null; trackedMinor: number }[];
  categories: { categoryId: number | null; kind: string | null; series: number[]; averageMinor: number | null }[];
};
const trends = async () => (await (await get("/api/trends")).json()) as Trends;

let a: number;
let txn: Awaited<ReturnType<typeof ledger>>["txn"];

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  const l = await ledger();
  a = l.accounts[0];
  txn = l.txn;
  await insertRule("exact", "grocer", SEEDED.groceries);
  await insertRule("exact", "outfitter", SEEDED.clothes);
});
afterEach(() => vi.useRealTimers());

describe("GET /api/trends", () => {
  it("covers the current month and the 5 before, oldest first", async () => {
    await insertOverall("2026-09", 150_000);
    await txn(a, { merchant: "Grocer", amountMinor: -1_001, txnDate: "2026-08-03" });
    await txn(a, { merchant: "Grocer", amountMinor: -5_000, txnDate: "2026-10-02", isPending: true });
    await txn(a, { merchant: "Outfitter", amountMinor: -2_000, txnDate: "2026-09-09" });
    const t = await trends();
    expect(t.months.map((m) => m.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(t.months.map((m) => [m.hasData, m.partial])).toEqual([[false, false], [false, false], [false, false], [true, false], [true, false], [true, true]]);
    expect(t.months[5]).toEqual({ month: "2026-10", partial: true, hasData: true, spentMinor: 5_000, pendingSpentMinor: 5_000, overallMinor: 150_000, trackedMinor: 0 });
    expect(t.months[3]!.overallMinor).toBeNull();
    expect(t.months[4]).toMatchObject({ spentMinor: 0, trackedMinor: 2_000, overallMinor: 150_000 });
  });

  it("aligns every series and averages completed months with data, floored", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -1_001, txnDate: "2026-08-03" });
    await txn(a, { merchant: "Grocer", amountMinor: -5_000, txnDate: "2026-10-02" });
    await txn(a, { merchant: "Unknown shop", amountMinor: -300, txnDate: "2026-09-04" });
    const { categories } = await trends();
    expect(categories).toEqual([
      // Aug and Sep have data; Oct is partial and left out: (1001 + 0) ÷ 2.
      { categoryId: SEEDED.groceries, kind: "budgeted", series: [0, 0, 0, 1_001, 0, 5_000], averageMinor: 500 },
      { categoryId: null, kind: null, series: [0, 0, 0, 0, 300, 0], averageMinor: 150 },
    ]);
  });

  it("has a null average when only the current month has data", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -500, txnDate: "2026-10-02" });
    expect((await trends()).categories[0]!.averageMinor).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/analytics/trends.spec.ts` — expected FAIL (404).

- [ ] **Step 3: Implement** `src/worker/analytics/trends.ts`:

```ts
import { effectiveOverallSql } from "../budget/effective";
import { londonMonth, monthsEnding } from "../importer/dates";
import { floorDiv } from "./math";
import { budgetSpend, firstDataMonth, pendingBudgetSpend, spendByMonth, trackedSpend, type SpendRow } from "./spend";

// Trends (docs/phase-2-insights-spec.md): the current month and the 5 before, three statements.

export const TREND_MONTHS = 6;

// The overall budget in effect in each month of a JSON array of YYYY-MM strings.
const OVERALL_BY_MONTH_SQL = `SELECT m.value AS month, ${effectiveOverallSql("m.value")} AS overallMinor FROM json_each(?1) m`;

export async function readTrends(db: D1Database, now: Date) {
  const current = londonMonth(now);
  const months = monthsEnding(current, TREND_MONTHS);
  const [spend, overall, first] = await Promise.all([
    spendByMonth(db, `${months[0]}-01`, `${current}-31`),
    db.prepare(OVERALL_BY_MONTH_SQL).bind(JSON.stringify(months)).all<{ month: string; overallMinor: number | null }>(),
    firstDataMonth(db),
  ]);
  const overallOf = new Map(overall.results.map((r) => [r.month, r.overallMinor]));
  const hasData = (m: string) => first !== null && m >= first;
  const rowsOf = (m: string) => spend.filter((r) => r.month === m);
  // The average skips the partial month and months before the history starts.
  const averaged = months.filter((m) => m !== current && hasData(m));

  const kinds = new Map<number | null, SpendRow["kind"]>();
  for (const r of spend) kinds.set(r.categoryId, r.kind);

  return {
    months: months.map((m) => ({
      month: m,
      partial: m === current,
      hasData: hasData(m),
      spentMinor: budgetSpend(rowsOf(m)),
      pendingSpentMinor: pendingBudgetSpend(rowsOf(m)),
      overallMinor: overallOf.get(m) ?? null,
      trackedMinor: trackedSpend(rowsOf(m)),
    })),
    categories: [...kinds]
      .sort(([x], [y]) => (x ?? Infinity) - (y ?? Infinity))
      .map(([categoryId, kind]) => {
        const series = months.map((m) => spend.find((r) => r.month === m && r.categoryId === categoryId)?.spentMinor ?? 0);
        const total = averaged.reduce((sum, m) => sum + series[months.indexOf(m)]!, 0);
        return { categoryId, kind, series, averageMinor: averaged.length === 0 ? null : floorDiv(total, averaged.length) };
      }),
  };
}

export type Trends = Awaited<ReturnType<typeof readTrends>>;
```

Create `src/worker/routes/trends.ts`:

```ts
import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { readTrends } from "../analytics/trends";

export const trendRoutes = new Hono<AppEnv>().get("/", async (c) => c.json(await readTrends(c.env.DB, new Date())));
```

In `src/worker/index.ts`, import `trendRoutes` and add `app.route("/trends", trendRoutes);` after the months route.

- [ ] **Step 4: Run** `npx vitest run test/analytics/trends.spec.ts` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/worker/analytics/trends.ts src/worker/routes/trends.ts src/worker/index.ts test/analytics/trends.spec.ts
git commit -m "feat(worker): add the 6-month trends route

Phase: P2.9"
```

### Task 4: `GET /api/merchants?key=`

**Files:**
- Create: `src/worker/analytics/merchant.ts`, `src/worker/routes/merchants.ts`
- Modify: `src/worker/index.ts` (mount `/merchants`)
- Test: create `test/analytics/merchant.spec.ts`

**Interfaces:**
- Consumes: `listTransactions` (`src/worker/budget/listing.ts`), `COUNTS`, `RESOLVED_CTE`, `floorDiv`, `monthsEnding`, `TREND_MONTHS`.
- Produces: `OF_MERCHANT` (a `[sql]` condition on `resolved r` with one `?` for the key; P2.10 reuses it); `readMerchant(db, key, now)` returning the spec's shape or `null`; `merchantRoutes`.

- [ ] **Step 1: Write the failing test** `test/analytics/merchant.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEEDED, insertOverride, insertRule, ledger } from "../budget/helpers";
import { resetDb } from "../db";
import { get } from "../http";

// All data is synthetic.

type Merchant = {
  merchantKey: string;
  name: string;
  categoryId: number | null;
  categorySource: "rule" | null;
  accountIds: number[];
  firstSeenDate: string | null;
  months: { month: string; spentMinor: number; visits: number }[];
  windowSpentMinor: number;
  windowVisits: number;
  averageChargeMinor: number | null;
  recent: { id: number; excluded: boolean }[];
};
const merchant = (key: string) => get(`/api/merchants?key=${encodeURIComponent(key)}`);

let accounts: readonly [number, number];
let txn: Awaited<ReturnType<typeof ledger>>["txn"];

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  ({ accounts, txn } = await ledger());
});
afterEach(() => vi.useRealTimers());

describe("GET /api/merchants", () => {
  it("is 404 for an unknown key and 400 for an empty or overlong one", async () => {
    expect((await merchant("nobody")).status).toBe(404);
    expect((await get("/api/merchants?key=")).status).toBe(400);
    expect((await get("/api/merchants")).status).toBe(400);
    expect((await merchant("x".repeat(201))).status).toBe(400);
  });

  it("matches keys with URL-special characters literally", async () => {
    await txn(accounts[0], { merchant: "50% & Co/UK", amountMinor: -1_000, txnDate: "2026-10-02" });
    await txn(accounts[0], { merchant: "50X & Co/UK", amountMinor: -1_000, txnDate: "2026-10-02" });
    const res = await merchant("50% & co/uk");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Merchant).windowVisits).toBe(1);
  });

  it("joins both accounts under one key, aligned with trends, with a floored average", async () => {
    await insertRule("exact", "grocer", SEEDED.groceries);
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-02-14" }); // before the window
    await txn(accounts[0], { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-09-03" });
    await txn(accounts[1], { merchant: "GROCER ", amountMinor: -1_001, txnDate: "2026-10-04" });
    const m = (await (await merchant("grocer")).json()) as Merchant;
    expect(m).toMatchObject({
      merchantKey: "grocer",
      name: "GROCER ",
      categoryId: SEEDED.groceries,
      categorySource: "rule",
      accountIds: [accounts[0], accounts[1]],
      firstSeenDate: "2026-02-14",
      windowSpentMinor: 2_001,
      windowVisits: 2,
      averageChargeMinor: 1_000,
    });
    expect(m.months.map((x) => x.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(m.months.slice(4)).toEqual([
      { month: "2026-09", spentMinor: 1_000, visits: 1 },
      { month: "2026-10", spentMinor: 1_001, visits: 1 },
    ]);
  });

  it("takes the category from the rule, not from an override, and null without a rule", async () => {
    await insertRule("exact", "grocer", SEEDED.groceries);
    const id = await txn(accounts[0], { merchant: "Grocer", txnDate: "2026-10-02" });
    await insertOverride(id, { category_id: SEEDED.eatingOut });
    expect((await (await merchant("grocer")).json()) as Merchant).toMatchObject({ categoryId: SEEDED.groceries, categorySource: "rule" });
    await txn(accounts[0], { merchant: "Corner shop", txnDate: "2026-10-02" });
    expect((await (await merchant("corner shop")).json()) as Merchant).toMatchObject({ categoryId: null, categorySource: null });
  });

  it("lists the 20 most recent rows newest first, excluded ones included, vanished ones not", async () => {
    const ids: number[] = [];
    for (let d = 1; d <= 22; d++) ids.push(await txn(accounts[0], { merchant: "Cafe", txnDate: `2026-09-${String(d).padStart(2, "0")}` }));
    await insertOverride(ids[21]!, { excluded: 1 });
    await txn(accounts[0], { merchant: "Cafe", txnDate: "2026-09-30", vanished: true });
    const m = (await (await merchant("cafe")).json()) as Merchant;
    expect(m.recent).toHaveLength(20);
    expect(m.recent[0]).toMatchObject({ id: ids[21], excluded: true });
    expect(m.recent[19]!.id).toBe(ids[2]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/analytics/merchant.spec.ts` — expected FAIL (404 everywhere).

- [ ] **Step 3: Implement** `src/worker/analytics/merchant.ts`:

```ts
import { listTransactions } from "../budget/listing";
import { COUNTS, RESOLVED_CTE } from "../budget/resolve";
import { londonMonth, monthsEnding } from "../importer/dates";
import { floorDiv } from "./math";
import { TREND_MONTHS } from "./trends";

// One merchant's history across both accounts (docs/phase-2-insights-spec.md, Merchant). A
// merchant is its key, lower(trim(merchant)), the text exact rules match. Every read seeks the
// key's (account, merchant) pairs through merchant_matches_key_idx, never the whole history.

/** On `resolved r`: the rows whose merchant has the key bound here (one `?`). */
export const OF_MERCHANT = "(r.account_id, r.merchant) IN (SELECT account_id, merchant FROM merchant_matches WHERE merchant_key = ?)";

const RECENT = 20;

// The latest row's text, and the category its match's rule gives a new transaction.
const IDENTITY_SQL = `SELECT t.merchant AS name, mr.category_id AS categoryId
FROM merchant_matches m
JOIN transactions t ON t.account_id = m.account_id AND t.merchant = m.merchant
LEFT JOIN merchant_rules mr ON mr.id = m.rule_id
WHERE m.merchant_key = ?1 AND t.vanished_at IS NULL
ORDER BY t.txn_date DESC, t.id DESC LIMIT 1`;

const ACCOUNTS_SQL = "SELECT DISTINCT account_id AS id FROM merchant_matches WHERE merchant_key = ?1 ORDER BY account_id";

// Counted spend and visits per month over the merchant's whole history (one merchant is small).
const MONTHS_SQL = `WITH ${RESOLVED_CTE}
SELECT substr(COALESCE(r.counted_date, r.txn_date), 1, 7) AS month,
  min(COALESCE(r.counted_date, r.txn_date)) AS first,
  sum(-COALESCE(r.counted_amount_minor, r.amount_minor)) AS spentMinor,
  sum(COALESCE(r.counted_amount_minor, r.amount_minor) < 0) AS visits
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE ${OF_MERCHANT} AND r.vanished_at IS NULL AND ${COUNTS}
GROUP BY month`;

/** The merchant with this key, or null when no (unvanished) transaction has it. Four statements. */
export async function readMerchant(db: D1Database, key: string, now: Date) {
  const window = monthsEnding(londonMonth(now), TREND_MONTHS);
  const [identity, accountRows, monthRows, recent] = await Promise.all([
    db.prepare(IDENTITY_SQL).bind(key).first<{ name: string; categoryId: number | null }>(),
    db.prepare(ACCOUNTS_SQL).bind(key).all<{ id: number }>(),
    db.prepare(MONTHS_SQL).bind(key).all<{ month: string; first: string; spentMinor: number; visits: number }>(),
    listTransactions(db, { where: [[OF_MERCHANT, key], ["r.vanished_at IS NULL"]], limit: RECENT, withCategory: true }),
  ]);
  if (!identity) return null;

  const byMonth = new Map(monthRows.results.map((r) => [r.month, r]));
  const months = window.map((month) => ({ month, spentMinor: byMonth.get(month)?.spentMinor ?? 0, visits: byMonth.get(month)?.visits ?? 0 }));
  const windowSpentMinor = months.reduce((sum, m) => sum + m.spentMinor, 0);
  const windowVisits = months.reduce((sum, m) => sum + m.visits, 0);
  return {
    merchantKey: key,
    name: identity.name,
    categoryId: identity.categoryId,
    categorySource: identity.categoryId === null ? null : ("rule" as const),
    accountIds: accountRows.results.map((r) => r.id),
    // Null when every row is excluded: nothing of theirs has counted.
    firstSeenDate: monthRows.results.reduce<string | null>((min, r) => (min === null || r.first < min ? r.first : min), null),
    months,
    windowSpentMinor,
    windowVisits,
    averageChargeMinor: windowVisits === 0 ? null : floorDiv(windowSpentMinor, windowVisits),
    recent: recent.transactions,
  };
}
```

Create `src/worker/routes/merchants.ts`:

```ts
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { readMerchant } from "../analytics/merchant";
import { parseQuery } from "./query";

// Keys come from the API's own responses (merchantKey); one that matches nothing is a 404.
const merchantQuery = z.object({ key: z.string().min(1).max(200) });

export const merchantRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const q = parseQuery(c, merchantQuery);
  if (!q.ok) return q.res;
  const merchant = await readMerchant(c.env.DB, q.data.key, new Date());
  return merchant ? c.json(merchant) : c.json({ error: "not_found" }, 404);
});
```

In `src/worker/index.ts`, import `merchantRoutes` and add `app.route("/merchants", merchantRoutes);`.

- [ ] **Step 4: Run** `npx vitest run test/analytics/merchant.spec.ts` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/worker/analytics/merchant.ts src/worker/routes/merchants.ts src/worker/index.ts test/analytics/merchant.spec.ts
git commit -m "feat(worker): add the merchant history route

Phase: P2.9"
```

### Task 5: Rows-read budgets, docs, pre-PR checks

**Files:**
- Modify: `test/rows-read.spec.ts`, `docs/schema-and-api.md`

- [ ] **Step 1: Add the measurements** to `test/rows-read.spec.ts`, after the `misc` line:

```ts
    const review = await record("GET /api/months/2026-09/review", "GET", "/api/months/2026-09/review");
    const trends = await record("GET /api/trends", "GET", "/api/trends");
    // Merchant 0 is the busiest under the Zipf-ish draw.
    const merchant = await record("GET /api/merchants (busiest)", "GET", `/api/merchants?key=${encodeURIComponent("synthetic merchant 0")}`);
```

and with the other assertions:

```ts
    // Analytics read only their months or their merchant (docs/phase-2-insights-spec.md, Rows read).
    expect(review.rowsRead).toBeLessThan(2_000);
    expect(trends.rowsRead).toBeLessThan(5_000);
    expect(merchant.rowsRead).toBeLessThan(1_000);
```

- [ ] **Step 2: Run** `npx vitest run test/rows-read.spec.ts --silent=false --reporter=verbose` and read the table. Expected PASS. **If a ceiling fails, stop and report the figure to the owner** rather than raising the ceiling — it means a read isn't seeking.
- [ ] **Step 3: Docs.** Add the three endpoints to `docs/schema-and-api.md`'s API table, each pointing to phase-2-insights-spec.md for its response.
- [ ] **Step 4: Run** `npm run check`, then `security-review`.
- [ ] **Step 5: Commit**

```bash
git add test/rows-read.spec.ts
git commit -m "test: pin rows read for the review, trends and merchant routes

Phase: P2.9"
git add docs/schema-and-api.md
git commit -m "docs: record the analytics endpoints"
```

- [ ] **Step 6:** Run `code-review`, fix findings, then `simplify`. Push, open the PR `feat: add review, trends and merchant analytics` with the Accept-when, and merge only on approval.

**Accept when (P2.9):** `npm run check` passes including the rows-read ceilings; after deploy, the owner opens `/api/months/<last month>/review` and `/api/trends` in a logged-in browser and confirms the review's `totals.spentMinor` equals Home's spent for that month, and the trend's months line up with Home's past months.

---

# P2.10 Insights

Branch: `git checkout main && git pull && git checkout -b feat/insights`

### Task 1: Move display formatters into the worker

The wording module (Task 4) is shared by the web app and the digest, and Worker code can't import from `src/web` (`tsconfig.worker.json`). Same pattern as `src/web/dates.ts` re-exporting `src/worker/importer/dates.ts`. No behaviour change.

**Files:**
- Create: `src/worker/display.ts`
- Modify: `src/web/format.ts`, `src/web/money.ts`, `src/web/dates.ts` (delete the moved definitions; re-export)
- Test: create `test/display.spec.ts`; existing `test/web/format.spec.ts`, `money.spec.ts`, `dates.spec.ts` prove the move

**Interfaces:**
- Produces (from `src/worker/display.ts`): `MINUS`, `formatMoney(amountMinor, currency)`, `formatPounds(minor)`, `formatTimestamp(iso | null)`, `monthName(month)`, `yearSuffix(dateOrMonth, today?)`, `formatDayMonth(date, today?)`, `formatShortDate(date, today?)`, `ordinal(n)`.

- [ ] **Step 1: Write the failing test** `test/display.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatPounds, formatShortDate, ordinal } from "../src/worker/display";

describe("ordinal", () => {
  it.each([
    [1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [11, "11th"], [12, "12th"], [13, "13th"], [21, "21st"], [22, "22nd"], [23, "23rd"], [31, "31st"],
  ])("%i → %s", (n, s) => expect(ordinal(n)).toBe(s));
});

describe("moved formatters", () => {
  it("still format as the web did", () => {
    expect(formatPounds(100_340)).toBe("£1,003");
    expect(formatShortDate("2026-10-15", "2026-10-16")).toBe("Thu 15 Oct");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/display.spec.ts` — expected FAIL (module missing).
- [ ] **Step 3: Create `src/worker/display.ts`.** Move these definitions **verbatim** (bodies unchanged) and export them: from `src/web/format.ts` → `timestampFormat`, `moneyFormats`, `moneyFormat`, `formatMoney`, `formatTimestamp`; from `src/web/money.ts` → `MINUS` (now exported), `poundsFormat`, `formatPounds`; from `src/web/dates.ts` → `MONTHS`, `WEEKDAYS`, `weekday`, `yearSuffix`, `monthName`, `formatDayMonth`, `formatShortDate`, plus private copies of the one-line helpers they use (`splitMonth`, `monthOf`); leave the web's own copies of those in place, since other web code imports them. Then:
  - `yearSuffix`'s default becomes `today: string = londonToday(new Date())`, with `londonToday` imported from `./importer/dates`.
  - Head the file with: `// Display formatting shared by the web app and the weekly digest (docs/phase-2-insights-spec.md). Pure, Intl-only, no DOM: Worker code can import it, and src/web re-exports it.`
  - Append:

```ts
/** 1 → "1st", 12 → "12th", 22 → "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th");
  return `${n}${suffix}`;
}
```

- [ ] **Step 4: Re-export from web.** In `src/web/format.ts`, keep `merchantLabel` and add `export { formatMoney, formatTimestamp } from "../worker/display";`. In `src/web/money.ts`, import `{ MINUS, formatMoney } from "../worker/display"` instead of `./format` and the local `MINUS`, and add `export { formatPounds } from "../worker/display";`. In `src/web/dates.ts`, import what its remaining functions use (e.g. `monthName`, `yearSuffix` for `monthTitle`) from `../worker/display` and re-export `formatDayMonth, formatShortDate, monthName, yearSuffix`. Nothing that imports these from `src/web/*` changes.
- [ ] **Step 5: Run** `npx vitest run test/display.spec.ts test/web` then `npm run check` — expected PASS. Also `npm run build` (the SPA still bundles).
- [ ] **Step 6: Commit**

```bash
git add src/worker/display.ts src/web/format.ts src/web/money.ts src/web/dates.ts test/display.spec.ts
git commit -m "refactor: move display formatters where the worker can use them

The weekly digest words insights the same way the app does, and Worker
code can't import from src/web.

Phase: P2.10"
```

### Task 2: Thresholds and insight rules

Pure functions over aggregates; no D1.

**Files:**
- Create: `src/worker/insights/thresholds.ts`, `src/worker/insights/rules.ts`
- Test: create `test/insights/rules.spec.ts`

**Interfaces:**
- Consumes: `floorDiv`, `projectedMinor` (P2.9); `budgetSpend`, `type SpendRow` (P2.9); `type BudgetRows`; `staleDays`, `isStale`, `type AccountFreshness` (P2.8); `daysInMonth`.
- Produces: `type Insight` (union below); `type Charge`; `type MonthSpend = { month: string; hasData: boolean; rows: SpendRow[] }`; `type InsightInput`; `buildInsights(input: InsightInput): Insight[]`.

- [ ] **Step 1: Write the failing test** `test/insights/rules.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SpendRow } from "../../src/worker/analytics/spend";
import { buildInsights, type Charge, type Insight, type InsightInput } from "../../src/worker/insights/rules";

// All figures are synthetic. October 2026 has 31 days.

const row = (categoryId: number | null, spentMinor: number, kind: SpendRow["kind"] = categoryId === null ? null : "budgeted"): SpendRow => ({
  month: "2026-10", categoryId, kind, spentMinor, pendingSpentMinor: 0,
});
const on = (today: string) => ({ today, now: new Date(`${today}T12:00:00Z`) });
const input = (over: Partial<InsightInput> = {}): InsightInput => ({
  ...on("2026-10-15"),
  budget: { overallMinor: null, allocations: [] },
  monthSpend: [],
  baseline: [],
  lastMonth: { month: "2026-09", hasData: true, rows: [] },
  previousMonth: { month: "2026-08", hasData: true, rows: [] },
  charges: [],
  accounts: [],
  ...over,
});
const allocated = (categoryId: number, allocatedMinor: number) => ({ overallMinor: 1_000_000, allocations: [{ categoryId, allocatedMinor }] });
const baseline = (...months: (number | null)[]) =>
  months.map((spent, i) => ({ month: `2026-0${9 - i}`, hasData: spent !== null, rows: spent === null ? [] : [row(1, spent)] }));
const charge = (over: Partial<Charge> = {}): Charge => ({
  transactionId: 7, merchantKey: "shop", name: "Shop", spentMinor: 10_000, countedDate: "2026-10-13", isPending: false, earlierCount: 0, earlierSpentMinor: 0, ...over,
});
const only = (items: Insight[], type: Insight["type"]) => items.filter((i) => i.type === type);

describe("pace", () => {
  it("is over from day 1 once spend passes the allocation", () => {
    const items = buildInsights(input({ ...on("2026-10-01"), budget: allocated(1, 10_000), monthSpend: [row(1, 10_001)] }));
    expect(only(items, "pace")).toEqual([
      { id: "pace:category:1:2026-10", type: "pace", severity: "over", state: "over", categoryId: 1, spentMinor: 10_001, allocatedMinor: 10_000, projectedMinor: 310_031 },
    ]);
  });

  it("doesn't project on day 7, and does on day 8", () => {
    expect(only(buildInsights(input({ ...on("2026-10-07"), budget: allocated(1, 10_000), monthSpend: [row(1, 3_000)] })), "pace")).toEqual([]);
    expect(only(buildInsights(input({ ...on("2026-10-08"), budget: allocated(1, 10_000), monthSpend: [row(1, 3_000)] })), "pace")).toEqual([
      { id: "pace:category:1:2026-10", type: "pace", severity: "warn", state: "projected_over", categoryId: 1, spentMinor: 3_000, allocatedMinor: 10_000, projectedMinor: 11_625 },
    ]);
  });

  it("projects the overall budget from budget spend only, never tracked", () => {
    const items = buildInsights(input({ budget: { overallMinor: 100_000, allocations: [] }, monthSpend: [row(1, 60_000), row(9, 50_000, "tracked")] }));
    expect(only(items, "pace")).toMatchObject([{ categoryId: null, state: "projected_over", spentMinor: 60_000, projectedMinor: 124_000 }]);
  });

  it("ignores a zero allocation", () => {
    expect(only(buildInsights(input({ budget: allocated(1, 0), monthSpend: [row(1, 500)] })), "pace")).toEqual([]);
  });
});

describe("unusual_category", () => {
  it("fires at exactly 1.5× the baseline and £30 above it", () => {
    const items = buildInsights(input({ baseline: baseline(6_000, 6_000, 6_000), monthSpend: [row(1, 9_000)] }));
    expect(only(items, "unusual_category")).toEqual([
      { id: "unusual:1:2026-10", type: "unusual_category", severity: "warn", categoryId: 1, spentMinor: 9_000, baselineMinor: 6_000 },
    ]);
  });

  it("stays silent just under either edge", () => {
    expect(only(buildInsights(input({ baseline: baseline(6_000, 6_000, 6_000), monthSpend: [row(1, 8_999)] })), "unusual_category")).toEqual([]);
    expect(only(buildInsights(input({ baseline: baseline(2_000, 2_000, 2_000), monthSpend: [row(1, 4_999)] })), "unusual_category")).toEqual([]);
    expect(only(buildInsights(input({ baseline: baseline(2_000, 2_000, 2_000), monthSpend: [row(1, 5_000)] })), "unusual_category")).toHaveLength(1);
  });

  it("averages only the baseline months with data, and needs two of them", () => {
    expect(only(buildInsights(input({ baseline: baseline(4_000, null, null), monthSpend: [row(1, 20_000)] })), "unusual_category")).toEqual([]);
    expect(only(buildInsights(input({ baseline: baseline(4_000, 2_000, null), monthSpend: [row(1, 20_000)] })), "unusual_category")).toMatchObject([
      { baselineMinor: 3_000 },
    ]);
  });

  it("doesn't fire before day 8", () => {
    expect(only(buildInsights(input({ ...on("2026-10-07"), baseline: baseline(1_000, 1_000, 1_000), monthSpend: [row(1, 20_000)] })), "unusual_category")).toEqual([]);
  });

  it("never takes a refund-heavy history as a negative usual level", () => {
    const items = buildInsights(input({ baseline: baseline(-3_000, -3_000, -3_000), monthSpend: [row(1, 3_000)] }));
    expect(only(items, "unusual_category")).toMatchObject([{ spentMinor: 3_000, baselineMinor: 0 }]);
    expect(only(buildInsights(input({ baseline: baseline(-3_000, -3_000, -3_000), monthSpend: [row(1, 2_999)] })), "unusual_category")).toEqual([]);
  });

  it("skips a category that already has a pace item, and words uncategorised as its own key", () => {
    const items = buildInsights(input({ budget: allocated(1, 5_000), baseline: [
      { month: "2026-09", hasData: true, rows: [row(1, 1_000), row(null, 1_000)] },
      { month: "2026-08", hasData: true, rows: [row(1, 1_000), row(null, 1_000)] },
    ], monthSpend: [row(1, 9_000), row(null, 9_000)] }));
    expect(only(items, "pace")).toHaveLength(1);
    expect(only(items, "unusual_category").map((i) => i.id)).toEqual(["unusual:uncategorised:2026-10"]);
  });
});

describe("large_charge", () => {
  it("fires for a new merchant at £100, not at £99.99", () => {
    expect(only(buildInsights(input({ charges: [charge()] })), "large_charge")).toEqual([
      { id: "large:7", type: "large_charge", severity: "info", transactionId: 7, merchantKey: "shop", name: "Shop", spentMinor: 10_000, merchantAverageMinor: null, countedDate: "2026-10-13", isPending: false },
    ]);
    expect(only(buildInsights(input({ charges: [charge({ spentMinor: 9_999 })] })), "large_charge")).toEqual([]);
  });

  it("never fires with 1 or 2 earlier charges", () => {
    expect(only(buildInsights(input({ charges: [charge({ spentMinor: 100_000, earlierCount: 2, earlierSpentMinor: 200 })] })), "large_charge")).toEqual([]);
  });

  it("fires at exactly 3× the average of 3+ earlier charges", () => {
    expect(only(buildInsights(input({ charges: [charge({ spentMinor: 12_000, earlierCount: 3, earlierSpentMinor: 12_000 })] })), "large_charge")).toMatchObject([
      { merchantAverageMinor: 4_000 },
    ]);
    expect(only(buildInsights(input({ charges: [charge({ spentMinor: 11_999, earlierCount: 3, earlierSpentMinor: 12_000 })] })), "large_charge")).toEqual([]);
  });
});

describe("month_change", () => {
  const months = (last: SpendRow[], previous: SpendRow[]) => ({
    lastMonth: { month: "2026-09", hasData: true, rows: last },
    previousMonth: { month: "2026-08", hasData: true, rows: previous },
  });

  it("shows on day 7 and not on day 8", () => {
    expect(only(buildInsights(input({ ...on("2026-10-07"), ...months([row(1, 5_000)], [row(1, 1_000)]) })), "month_change")).toEqual([
      { id: "month_change:1:2026-09", type: "month_change", severity: "info", categoryId: 1, month: "2026-09", spentMinor: 5_000, previousSpentMinor: 1_000, changeMinor: 4_000 },
    ]);
    expect(only(buildInsights(input({ ...on("2026-10-08"), ...months([row(1, 5_000)], [row(1, 1_000)]) })), "month_change")).toEqual([]);
  });

  it("needs £25 and 25%, with £0 the month before qualifying on £25 alone", () => {
    const at = on("2026-10-03");
    expect(only(buildInsights(input({ ...at, ...months([row(1, 2_500)], []) })), "month_change")).toHaveLength(1);
    expect(only(buildInsights(input({ ...at, ...months([row(1, 2_499)], []) })), "month_change")).toEqual([]);
    expect(only(buildInsights(input({ ...at, ...months([row(1, 12_500)], [row(1, 10_000)]) })), "month_change")).toHaveLength(1);
    expect(only(buildInsights(input({ ...at, ...months([row(1, 12_600)], [row(1, 10_100)]) })), "month_change")).toEqual([]);
  });

  it("keeps the 3 biggest changes, biggest first, and stays silent without the month before", () => {
    const at = on("2026-10-03");
    const items = buildInsights(input({ ...at, ...months([row(1, 3_000), row(2, 9_000), row(3, 0), row(4, 5_000)], [row(3, 7_000)]) }));
    expect(only(items, "month_change").map((i) => (i as { categoryId: number }).categoryId)).toEqual([2, 3, 4]);
    expect(only(buildInsights(input({ ...at, lastMonth: { month: "2026-09", hasData: true, rows: [row(1, 9_000)] }, previousMonth: { month: "2026-08", hasData: false, rows: [] } })), "month_change")).toEqual([]);
  });
});

describe("ranking", () => {
  const stale = { accounts: [{ id: 2, lastDataChangeAt: "2026-10-01T09:00:00Z" }] };

  it("mid-month: stale, over, projected, unusual, large charge", () => {
    const items = buildInsights(input({
      ...stale,
      budget: { overallMinor: 1_000_000, allocations: [{ categoryId: 1, allocatedMinor: 1_000 }, { categoryId: 2, allocatedMinor: 10_000 }] },
      monthSpend: [row(1, 2_000), row(2, 6_000), row(3, 9_000)],
      baseline: [{ month: "2026-09", hasData: true, rows: [row(3, 1_000)] }, { month: "2026-08", hasData: true, rows: [row(3, 1_000)] }],
      charges: [charge()],
    }));
    expect(items.map((i) => (i.type === "pace" ? `pace:${i.state}` : i.type))).toEqual([
      "stale_account", "pace:over", "pace:projected_over", "unusual_category", "large_charge",
    ]);
  });

  it("early in the month: stale, over, large charge, month change", () => {
    const items = buildInsights(input({
      ...on("2026-10-03"),
      ...stale,
      budget: allocated(1, 1_000),
      monthSpend: [row(1, 2_000)],
      charges: [charge()],
      lastMonth: { month: "2026-09", hasData: true, rows: [row(4, 9_000)] },
    }));
    expect(items.map((i) => i.type)).toEqual(["stale_account", "pace", "large_charge", "month_change"]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/insights/rules.spec.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement** `src/worker/insights/thresholds.ts`:

```ts
// Insight thresholds (docs/phase-2-insights-spec.md, Thresholds), in one place so tuning is a
// one-line change. Money is minor units; a ratio is [numerator, denominator]. STALE_AFTER_DAYS
// lives with the stale check (../budget/stale.ts).

export const PACE_FROM_DAY = 8;
export const UNUSUAL_FROM_DAY = 8;
export const UNUSUAL_RATIO = [3, 2] as const;
export const UNUSUAL_MIN_EXCESS_MINOR = 3_000;
export const UNUSUAL_BASELINE_MONTHS = 3;
export const UNUSUAL_MIN_BASELINE_MONTHS = 2;
export const LARGE_CHARGE_MIN_MINOR = 10_000;
export const LARGE_CHARGE_RATIO = 3;
export const LARGE_CHARGE_MIN_HISTORY = 3;
export const LARGE_CHARGE_LOOKBACK_DAYS = 7;
/** "The previous 6 months" of a merchant's charges. */
export const LARGE_CHARGE_HISTORY_DAYS = 182;
/** Caps the per-candidate history reads, so a request stays well under D1's 50 statements. */
export const LARGE_CHARGE_MAX_CANDIDATES = 10;
export const MONTH_CHANGE_MIN_MINOR = 2_500;
export const MONTH_CHANGE_MIN_PCT = 25;
export const MONTH_CHANGE_SHOW_DAYS = 7;
export const MONTH_CHANGE_MAX = 3;
```

`src/worker/insights/rules.ts`:

```ts
import { floorDiv, projectedMinor } from "../analytics/math";
import { budgetSpend, type SpendRow } from "../analytics/spend";
import type { BudgetRows } from "../budget/effective";
import { isStale, staleDays, type AccountFreshness } from "../budget/stale";
import { daysInMonth } from "../importer/dates";
import * as T from "./thresholds";

// Insights (docs/phase-2-insights-spec.md): fixed rules over figures read elsewhere (./read.ts).
// Pure, so every rule is tested at its edges without D1. Words live in ./wording.ts.

export type Insight =
  | { id: string; type: "stale_account"; severity: "warn"; accountId: number; staleDays: number }
  | {
      id: string;
      type: "pace";
      severity: "over" | "warn";
      state: "over" | "projected_over";
      /** null = the whole budget. */
      categoryId: number | null;
      spentMinor: number;
      allocatedMinor: number;
      projectedMinor: number;
    }
  | { id: string; type: "unusual_category"; severity: "warn"; categoryId: number | null; spentMinor: number; baselineMinor: number }
  | {
      id: string;
      type: "large_charge";
      severity: "info";
      transactionId: number;
      merchantKey: string;
      name: string;
      spentMinor: number;
      /** null = a new merchant. */
      merchantAverageMinor: number | null;
      countedDate: string;
      isPending: boolean;
    }
  | { id: string; type: "month_change"; severity: "info"; categoryId: number | null; month: string; spentMinor: number; previousSpentMinor: number; changeMinor: number };

type Of<K extends Insight["type"]> = Extract<Insight, { type: K }>;

/** A candidate large charge and the merchant's earlier charges in the history window. */
export type Charge = {
  transactionId: number;
  merchantKey: string;
  name: string;
  spentMinor: number;
  countedDate: string;
  isPending: boolean;
  earlierCount: number;
  earlierSpentMinor: number;
};

/** One month's spend rows, and whether the month is within the ledger's history. */
export type MonthSpend = { month: string; hasData: boolean; rows: SpendRow[] };

export type InsightInput = {
  now: Date;
  /** London, YYYY-MM-DD. */
  today: string;
  /** The current month's. */
  budget: BudgetRows;
  /** The current month's. */
  monthSpend: SpendRow[];
  /** The previous UNUSUAL_BASELINE_MONTHS months, each from day 1 to today's day of month. */
  baseline: MonthSpend[];
  /** The last two completed months, whole (only read while month changes show). */
  lastMonth: MonthSpend;
  previousMonth: MonthSpend;
  charges: Charge[];
  accounts: AccountFreshness[];
};

const spentIn = (rows: SpendRow[], categoryId: number | null) => rows.find((r) => r.categoryId === categoryId)?.spentMinor ?? 0;
const keyOf = (categoryId: number | null) => categoryId ?? "uncategorised";
const dayOf = (today: string) => Number(today.slice(8, 10));

function staleItems({ accounts, now }: InsightInput): Of<"stale_account">[] {
  return accounts
    .flatMap((a) => {
      const days = staleDays(a.lastDataChangeAt, now);
      return days !== null && isStale(days) ? [{ id: `stale:${a.id}`, type: "stale_account" as const, severity: "warn" as const, accountId: a.id, staleDays: days }] : [];
    })
    .sort((x, y) => y.staleDays - x.staleDays);
}

function paceItems({ budget, monthSpend, today }: InsightInput): Of<"pace">[] {
  const month = today.slice(0, 7);
  const dom = dayOf(today);
  const dim = daysInMonth(month);
  const targets: [number | null, number, number][] = budget.allocations.map((a) => [a.categoryId, spentIn(monthSpend, a.categoryId), a.allocatedMinor]);
  if (budget.overallMinor !== null) targets.unshift([null, budgetSpend(monthSpend), budget.overallMinor]);
  return targets.flatMap(([categoryId, spentMinor, allocatedMinor]): Of<"pace">[] => {
    if (allocatedMinor <= 0) return [];
    const projected = projectedMinor(spentMinor, dom, dim);
    const base = { id: `pace:${categoryId === null ? "overall" : `category:${categoryId}`}:${month}`, type: "pace" as const, categoryId, spentMinor, allocatedMinor, projectedMinor: projected };
    if (spentMinor > allocatedMinor) return [{ ...base, severity: "over", state: "over" }];
    if (dom >= T.PACE_FROM_DAY && projected > allocatedMinor) return [{ ...base, severity: "warn", state: "projected_over" }];
    return [];
  });
}

function unusualItems({ monthSpend, baseline, today }: InsightInput, paced: Set<number>): Of<"unusual_category">[] {
  const months = baseline.filter((b) => b.hasData);
  if (dayOf(today) < T.UNUSUAL_FROM_DAY || months.length < T.UNUSUAL_MIN_BASELINE_MONTHS) return [];
  const [num, den] = T.UNUSUAL_RATIO;
  return monthSpend
    .flatMap((r): Of<"unusual_category">[] => {
      if (r.categoryId !== null && paced.has(r.categoryId)) return [];
      // Refunds can net a month below zero; the usual level is never taken as less than nothing.
      const baselineMinor = Math.max(0, floorDiv(months.reduce((sum, m) => sum + spentIn(m.rows, r.categoryId), 0), months.length));
      const fires = r.spentMinor * den >= baselineMinor * num && r.spentMinor - baselineMinor >= T.UNUSUAL_MIN_EXCESS_MINOR;
      return fires
        ? [{ id: `unusual:${keyOf(r.categoryId)}:${today.slice(0, 7)}`, type: "unusual_category", severity: "warn", categoryId: r.categoryId, spentMinor: r.spentMinor, baselineMinor }]
        : [];
    })
    .sort((x, y) => y.spentMinor - y.baselineMinor - (x.spentMinor - x.baselineMinor));
}

function largeChargeItems({ charges }: InsightInput): Of<"large_charge">[] {
  return charges
    .flatMap((ch): Of<"large_charge">[] => {
      const isNew = ch.earlierCount === 0;
      // spent ≥ 3 × (earlier ÷ count), cross-multiplied.
      const outOfLine = ch.earlierCount >= T.LARGE_CHARGE_MIN_HISTORY && ch.spentMinor * ch.earlierCount >= T.LARGE_CHARGE_RATIO * ch.earlierSpentMinor;
      if (ch.spentMinor < T.LARGE_CHARGE_MIN_MINOR || !(isNew || outOfLine)) return [];
      return [{
        id: `large:${ch.transactionId}`, type: "large_charge", severity: "info", transactionId: ch.transactionId, merchantKey: ch.merchantKey, name: ch.name,
        spentMinor: ch.spentMinor, merchantAverageMinor: isNew ? null : floorDiv(ch.earlierSpentMinor, ch.earlierCount), countedDate: ch.countedDate, isPending: ch.isPending,
      }];
    })
    .sort((x, y) => y.spentMinor - x.spentMinor);
}

function monthChangeItems({ lastMonth, previousMonth, today }: InsightInput): Of<"month_change">[] {
  if (dayOf(today) > T.MONTH_CHANGE_SHOW_DAYS || !lastMonth.hasData || !previousMonth.hasData) return [];
  const ids = new Set([...lastMonth.rows, ...previousMonth.rows].map((r) => r.categoryId));
  return [...ids]
    .flatMap((categoryId): Of<"month_change">[] => {
      const spentMinor = spentIn(lastMonth.rows, categoryId);
      const previousSpentMinor = spentIn(previousMonth.rows, categoryId);
      const changeMinor = spentMinor - previousSpentMinor;
      const big = Math.abs(changeMinor) >= T.MONTH_CHANGE_MIN_MINOR && Math.abs(changeMinor) * 100 >= T.MONTH_CHANGE_MIN_PCT * Math.abs(previousSpentMinor);
      return big
        ? [{ id: `month_change:${keyOf(categoryId)}:${lastMonth.month}`, type: "month_change", severity: "info", categoryId, month: lastMonth.month, spentMinor, previousSpentMinor, changeMinor }]
        : [];
    })
    .sort((x, y) => Math.abs(y.changeMinor) - Math.abs(x.changeMinor))
    .slice(0, T.MONTH_CHANGE_MAX);
}

/** Today's insights, ranked (docs/phase-2-insights-spec.md, Ranking). */
export function buildInsights(input: InsightInput): Insight[] {
  const pace = paceItems(input);
  const paced = new Set(pace.flatMap((p) => (p.categoryId === null ? [] : [p.categoryId])));
  return [
    ...staleItems(input),
    ...pace.filter((p) => p.state === "over").sort((x, y) => y.spentMinor - y.allocatedMinor - (x.spentMinor - x.allocatedMinor)),
    ...pace.filter((p) => p.state === "projected_over").sort((x, y) => y.projectedMinor - y.allocatedMinor - (x.projectedMinor - x.allocatedMinor)),
    ...unusualItems(input, paced),
    ...largeChargeItems(input),
    ...monthChangeItems(input),
  ];
}
```

- [ ] **Step 4: Run** `npx vitest run test/insights/rules.spec.ts` — expected PASS. (`projectedMinor` for 10,001 on day 1 is 310,031: 10,001 × 31.)
- [ ] **Step 5: Commit**

```bash
git add src/worker/insights/thresholds.ts src/worker/insights/rules.ts test/insights/rules.spec.ts
git commit -m "feat(worker): add the insight rules and thresholds

Phase: P2.10"
```

### Task 3: Read insight inputs and `GET /api/insights`

**Files:**
- Create: `src/worker/insights/read.ts`, `src/worker/routes/insights.ts`
- Modify: `src/worker/index.ts` (mount `/insights`)
- Test: create `test/insights/route.spec.ts`

**Interfaces:**
- Consumes: `readBudget`; `spendByMonth`, `firstDataMonth`; `OF_MERCHANT`; `ENABLED_FRESHNESS_SQL`; `IN_DATES`, `inDatesBinds`, `COUNTS`, `RESOLVED_CTE`; `addDays`, `addMonths`, `daysInMonth`, `londonToday`; `buildInsights`, types from Task 2.
- Produces: `readInsightInput(db: D1Database, now: Date): Promise<InsightInput>` (at most 9 + `LARGE_CHARGE_MAX_CANDIDATES` statements); `insightRoutes` returning `{ asOf, items }`.

- [ ] **Step 1: Write the failing test** `test/insights/route.spec.ts`:

```ts
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAllocation, insertOverall } from "../budget/budget-rows";
import { SEEDED, insertRule, ledger } from "../budget/helpers";
import { resetDb } from "../db";
import { get } from "../http";

// All data is synthetic. "Today" is Thu 15 Oct 2026 unless a test moves it.

type Body = { asOf: string; items: Record<string, unknown>[] };
const insights = async () => (await (await get("/api/insights")).json()) as Body;
const at = (iso: string) => vi.setSystemTime(new Date(iso));

let a: number;
let txn: Awaited<ReturnType<typeof ledger>>["txn"];

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-15T12:00:00Z");
  const l = await ledger();
  a = l.accounts[0];
  txn = l.txn;
  await insertRule("exact", "grocer", SEEDED.groceries);
  await env.DB.prepare("UPDATE accounts SET last_data_change_at = ?1").bind("2026-10-15T09:00:00Z").run();
});
afterEach(() => vi.useRealTimers());

describe("GET /api/insights", () => {
  it("is an empty list on an empty ledger", async () => {
    expect(await insights()).toEqual({ asOf: "2026-10-15", items: [] });
  });

  it("reports a category over its allocation", async () => {
    await insertOverall("2026-10", 1_000_000);
    await insertAllocation(SEEDED.groceries, "2026-10", 1_000);
    await txn(a, { merchant: "Grocer", amountMinor: -1_500, txnDate: "2026-10-03" });
    expect((await insights()).items).toContainEqual(expect.objectContaining({ type: "pace", state: "over", categoryId: SEEDED.groceries, spentMinor: 1_500 }));
  });

  it("averages the baseline over days 1 to today's day only", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -100, txnDate: "2026-06-20" }); // history starts in June
    for (const m of ["07", "08", "09"]) await txn(a, { merchant: "Grocer", amountMinor: -4_000, txnDate: `2026-${m}-10` });
    await txn(a, { merchant: "Grocer", amountMinor: -9_000, txnDate: "2026-09-20" }); // after day 15: not in the baseline
    await txn(a, { merchant: "Grocer", amountMinor: -7_000, txnDate: "2026-10-04" });
    expect((await insights()).items).toContainEqual(expect.objectContaining({ type: "unusual_category", categoryId: SEEDED.groceries, spentMinor: 7_000, baselineMinor: 4_000 }));
  });

  it("flags a new merchant's large charge in the last 7 days, not one 8 days ago", async () => {
    const recent = await txn(a, { merchant: "Big shop", amountMinor: -15_000, txnDate: "2026-10-09" });
    await txn(a, { merchant: "Old shop", amountMinor: -15_000, txnDate: "2026-10-08" });
    const items = (await insights()).items.filter((i) => i.type === "large_charge");
    expect(items).toEqual([expect.objectContaining({ transactionId: recent, merchantKey: "big shop", name: "Big shop", merchantAverageMinor: null, isPending: false })]);
  });

  it("counts a merchant's earlier charges within 182 days only", async () => {
    // 3 earlier charges of £20 would make £60+ out of line, but one is 183 days back, so only 2 count.
    for (const d of ["2026-04-11", "2026-08-01", "2026-09-01"]) await txn(a, { merchant: "Cafe", amountMinor: -2_000, txnDate: d });
    await txn(a, { merchant: "Cafe", amountMinor: -20_000, txnDate: "2026-10-11" });
    expect((await insights()).items.filter((i) => i.type === "large_charge")).toEqual([]);
    await txn(a, { merchant: "Cafe", amountMinor: -2_000, txnDate: "2026-04-12" }); // exactly 182 days before
    expect((await insights()).items.filter((i) => i.type === "large_charge")).toEqual([
      expect.objectContaining({ spentMinor: 20_000, merchantAverageMinor: 2_000 }),
    ]);
  });

  it("drops a pending large charge once it's vanished, and keeps a live one marked pending", async () => {
    await txn(a, { merchant: "Big shop", amountMinor: -20_000, txnDate: "2026-10-12", isPending: true, vanished: true });
    expect((await insights()).items.filter((i) => i.type === "large_charge")).toEqual([]);
    await txn(a, { merchant: "Big shop", amountMinor: -20_000, txnDate: "2026-10-13", isPending: true });
    expect((await insights()).items.filter((i) => i.type === "large_charge")).toEqual([expect.objectContaining({ isPending: true })]);
  });

  it("reports a stale account first", async () => {
    await env.DB.prepare("UPDATE accounts SET last_data_change_at = ?1 WHERE id = ?2").bind("2026-10-10T09:00:00Z", a).run();
    await txn(a, { merchant: "Big shop", amountMinor: -20_000, txnDate: "2026-10-12" });
    const { items } = await insights();
    expect(items[0]).toMatchObject({ type: "stale_account", accountId: a, staleDays: 5 });
  });

  it("compares the last two whole months in the first week", async () => {
    at("2026-10-03T12:00:00Z");
    await txn(a, { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-08-10" });
    await txn(a, { merchant: "Grocer", amountMinor: -6_000, txnDate: "2026-09-28" });
    expect((await insights()).items).toContainEqual(expect.objectContaining({ type: "month_change", month: "2026-09", spentMinor: 6_000, previousSpentMinor: 1_000 }));
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/insights/route.spec.ts` — expected FAIL (404).

- [ ] **Step 3: Implement** `src/worker/insights/read.ts`:

```ts
import { OF_MERCHANT } from "../analytics/merchant";
import { firstDataMonth, spendByMonth, type SpendRow } from "../analytics/spend";
import { readBudget } from "../budget/effective";
import { COUNTS, IN_DATES, RESOLVED_CTE, inDatesBinds } from "../budget/resolve";
import { ENABLED_FRESHNESS_SQL, type AccountFreshness } from "../budget/stale";
import { addDays, addMonths, daysInMonth, londonToday } from "../importer/dates";
import type { Charge, InsightInput } from "./rules";
import * as T from "./thresholds";

// Reads what buildInsights needs: each figure seeks its own months or merchant.

const SPEND = "-COALESCE(r.counted_amount_minor, r.amount_minor)";
const COUNTED_DATE = "COALESCE(r.counted_date, r.txn_date)";

// Counting charges in the lookback window big enough to be a large_charge, biggest first.
// Binds: inDatesBinds(from, to), then the minimum.
const CANDIDATES_SQL = `WITH ${RESOLVED_CTE}
SELECT r.id AS transactionId, lower(trim(r.merchant)) AS merchantKey, r.merchant AS name, ${SPEND} AS spentMinor,
  ${COUNTED_DATE} AS countedDate, r.is_pending AS isPending
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE r.vanished_at IS NULL AND ${IN_DATES} AND ${COUNTS} AND ${SPEND} >= ?
ORDER BY spentMinor DESC, r.id
LIMIT ${T.LARGE_CHARGE_MAX_CANDIDATES}`;

// The merchant's counting charges before this one, back to the history window's start.
// Binds: merchant key, window start, the charge's date (twice), the charge's id.
const HISTORY_SQL = `WITH ${RESOLVED_CTE}
SELECT count(*) AS n, COALESCE(sum(${SPEND}), 0) AS spent
FROM resolved r LEFT JOIN categories c ON c.id = r.category_id
WHERE ${OF_MERCHANT} AND r.vanished_at IS NULL AND ${COUNTS} AND ${SPEND} > 0
  AND ${COUNTED_DATE} >= ? AND (${COUNTED_DATE} < ? OR (${COUNTED_DATE} = ? AND r.id < ?))`;

/** Day `day` of `month`, capped at the month's last day. */
const dayIn = (month: string, day: number) => `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;

export async function readInsightInput(db: D1Database, now: Date): Promise<InsightInput> {
  const today = londonToday(now);
  const month = today.slice(0, 7);
  const dom = Number(today.slice(8, 10));
  const previous = Array.from({ length: T.UNUSUAL_BASELINE_MONTHS }, (_, i) => addMonths(month, -(i + 1)));
  const [lastMonth, monthBefore] = [addMonths(month, -1), addMonths(month, -2)];

  const [budget, monthSpend, baselineRows, changeRows, candidates, accounts, first] = await Promise.all([
    readBudget(db, month),
    spendByMonth(db, `${month}-01`, `${month}-31`),
    Promise.all(previous.map((m) => spendByMonth(db, `${m}-01`, dayIn(m, dom)))),
    // Month changes only show in the first week, so the whole months are only read then.
    dom <= T.MONTH_CHANGE_SHOW_DAYS ? spendByMonth(db, `${monthBefore}-01`, `${lastMonth}-31`) : Promise.resolve([] as SpendRow[]),
    db
      .prepare(CANDIDATES_SQL)
      .bind(...inDatesBinds(addDays(today, 1 - T.LARGE_CHARGE_LOOKBACK_DAYS), today), T.LARGE_CHARGE_MIN_MINOR)
      .all<Omit<Charge, "isPending" | "earlierCount" | "earlierSpentMinor"> & { isPending: number }>(),
    db.prepare(ENABLED_FRESHNESS_SQL).all<AccountFreshness>(),
    firstDataMonth(db),
  ]);

  const charges = await Promise.all(
    candidates.results.map(async (c): Promise<Charge> => {
      const h = await db
        .prepare(HISTORY_SQL)
        .bind(c.merchantKey, addDays(c.countedDate, -T.LARGE_CHARGE_HISTORY_DAYS), c.countedDate, c.countedDate, c.transactionId)
        .first<{ n: number; spent: number }>();
      return { ...c, isPending: c.isPending === 1, earlierCount: h?.n ?? 0, earlierSpentMinor: h?.spent ?? 0 };
    }),
  );

  const hasData = (m: string) => first !== null && m >= first;
  const spendOf = (m: string, rows: SpendRow[]) => ({ month: m, hasData: hasData(m), rows: rows.filter((r) => r.month === m) });
  return {
    now,
    today,
    budget,
    monthSpend,
    baseline: previous.map((m, i) => spendOf(m, baselineRows[i]!)),
    lastMonth: spendOf(lastMonth, changeRows),
    previousMonth: spendOf(monthBefore, changeRows),
    charges,
    accounts: accounts.results,
  };
}
```

`src/worker/routes/insights.ts`:

```ts
import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { londonToday } from "../importer/dates";
import { readInsightInput } from "../insights/read";
import { buildInsights } from "../insights/rules";

export const insightRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const now = new Date();
  return c.json({ asOf: londonToday(now), items: buildInsights(await readInsightInput(c.env.DB, now)) });
});
```

In `src/worker/index.ts`, import `insightRoutes` and add `app.route("/insights", insightRoutes);`.

- [ ] **Step 4: Run** `npx vitest run test/insights` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/worker/insights/read.ts src/worker/routes/insights.ts src/worker/index.ts test/insights/route.spec.ts
git commit -m "feat(worker): add the insights route

Phase: P2.10"
```

### Task 4: Shared insight wording

**Files:**
- Create: `src/worker/insights/wording.ts`
- Test: create `test/insights/wording.spec.ts`

**Interfaces:**
- Consumes: `type Insight` (Task 2); `formatMoney`, `formatPounds`, `formatShortDate`, `monthName`, `ordinal` (Task 1); `addMonths`, `floorDiv`.
- Produces: `type Names = { category: (id: number | null) => string; account: (id: number) => string }`; `type Words = { headline: string; detail: string }`; `insightWords(item: Insight, names: Names, today: string): Words`. P2.11's email and P2.12's Insights tab both call it.

- [ ] **Step 1: Write the failing test** `test/insights/wording.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Insight } from "../../src/worker/insights/rules";
import { insightWords, type Names } from "../../src/worker/insights/wording";

// Synthetic names and figures. The copy matches docs/insights-ui-brief.md.

const names: Names = {
  category: (id) => (id === null ? "Uncategorised" : ({ 1: "Groceries", 2: "Eating out", 3: "Transport" } as Record<number, string>)[id]!),
  account: () => "Card B",
};
const words = (item: Insight, today = "2026-10-12") => insightWords(item, names, today);
const base = { id: "x" };

describe("insightWords", () => {
  it("stale account", () =>
    expect(words({ ...base, type: "stale_account", severity: "warn", accountId: 2, staleDays: 5 })).toEqual({
      headline: "Card B hasn't updated for 5 days",
      detail: "Recent spending may be missing.",
    }));

  it("pace over, for a category and for the whole budget", () => {
    const pace = { ...base, type: "pace" as const, severity: "over" as const, state: "over" as const, spentMinor: 18_400, allocatedMinor: 16_000, projectedMinor: 0 };
    expect(words({ ...pace, categoryId: 2 })).toEqual({ headline: "Eating out is £24 over", detail: "£184 of £160 this month" });
    expect(words({ ...pace, categoryId: null, spentMinor: 153_000, allocatedMinor: 144_000 })).toEqual({ headline: "£90 over this month's budget", detail: "£1,530 of £1,440" });
  });

  it("pace projected, for a category and for the whole budget", () => {
    const pace = { ...base, type: "pace" as const, severity: "warn" as const, state: "projected_over" as const };
    expect(words({ ...pace, categoryId: 2, spentMinor: 9_600, allocatedMinor: 16_000, projectedMinor: 20_000 })).toEqual({
      headline: "Eating out is on course to end £40 over",
      detail: "£96 by the 12th, £160 allocated",
    });
    expect(words({ ...pace, categoryId: null, spentMinor: 76_000, allocatedMinor: 144_000, projectedMinor: 156_000 }, "2026-10-16")).toEqual({
      headline: "On course to end the month £120 over",
      detail: "£760 by the 16th, £1,440 budget",
    });
  });

  it("unusual category", () =>
    expect(words({ ...base, type: "unusual_category", severity: "warn", categoryId: 1, spentMinor: 21_000, baselineMinor: 12_000 }, "2026-10-16")).toEqual({
      headline: "Groceries is running high",
      detail: "£210 so far, usually about £120 by the 16th",
    }));

  it("large charge: new, out of line, and pending", () => {
    const charge = { ...base, type: "large_charge" as const, severity: "info" as const, transactionId: 1, merchantKey: "halden audio", name: "Halden Audio", spentMinor: 24_000, countedDate: "2026-10-13", isPending: false };
    expect(words({ ...charge, merchantAverageMinor: null }, "2026-10-15")).toEqual({ headline: "£240.00 at Halden Audio", detail: "New merchant · Tue 13 Oct" });
    expect(words({ ...charge, merchantAverageMinor: 5_800 })).toEqual({ headline: "£240.00 at Halden Audio", detail: "About 4× your usual £58.00 there" });
    expect(words({ ...charge, merchantAverageMinor: null, isPending: true }, "2026-10-15").detail).toBe("Pending · New merchant · Tue 13 Oct");
  });

  it("month change, up and down", () => {
    const change = { ...base, type: "month_change" as const, severity: "info" as const, month: "2026-09" };
    expect(words({ ...change, categoryId: 3, spentMinor: 13_200, previousSpentMinor: 8_700, changeMinor: 4_500 })).toEqual({
      headline: "Transport up £45 in September",
      detail: "£132, from £87 in August",
    });
    expect(words({ ...change, categoryId: null, spentMinor: 1_000, previousSpentMinor: 6_000, changeMinor: -5_000 }).headline).toBe("Uncategorised down £50 in September");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/insights/wording.spec.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement** `src/worker/insights/wording.ts`:

```ts
import { floorDiv } from "../analytics/math";
import { formatMoney, formatPounds, formatShortDate, monthName, ordinal } from "../display";
import { addMonths } from "../importer/dates";
import type { Insight } from "./rules";

// What each insight says (docs/insights-ui-brief.md), shared by the Insights tab and the weekly
// email so they never disagree. Pure: names come from the caller. Budget figures are whole
// pounds; a single charge shows pence, as transactions do everywhere.

export type Names = { category: (id: number | null) => string; account: (id: number) => string };
export type Words = { headline: string; detail: string };

const gbp = (minor: number) => formatMoney(minor, "GBP");

export function insightWords(item: Insight, names: Names, today: string): Words {
  const byToday = `by the ${ordinal(Number(today.slice(8, 10)))}`;
  switch (item.type) {
    case "stale_account":
      return { headline: `${names.account(item.accountId)} hasn't updated for ${item.staleDays} days`, detail: "Recent spending may be missing." };
    case "pace": {
      const spent = formatPounds(item.spentMinor);
      const limit = formatPounds(item.allocatedMinor);
      if (item.state === "over") {
        const over = formatPounds(item.spentMinor - item.allocatedMinor);
        return item.categoryId === null
          ? { headline: `${over} over this month's budget`, detail: `${spent} of ${limit}` }
          : { headline: `${names.category(item.categoryId)} is ${over} over`, detail: `${spent} of ${limit} this month` };
      }
      const over = formatPounds(item.projectedMinor - item.allocatedMinor);
      return item.categoryId === null
        ? { headline: `On course to end the month ${over} over`, detail: `${spent} ${byToday}, ${limit} budget` }
        : { headline: `${names.category(item.categoryId)} is on course to end ${over} over`, detail: `${spent} ${byToday}, ${limit} allocated` };
    }
    case "unusual_category":
      return {
        headline: `${names.category(item.categoryId)} is running high`,
        detail: `${formatPounds(item.spentMinor)} so far, usually about ${formatPounds(item.baselineMinor)} ${byToday}`,
      };
    case "large_charge": {
      const pending = item.isPending ? "Pending · " : "";
      const headline = `${gbp(item.spentMinor)} at ${item.name}`;
      if (item.merchantAverageMinor === null) return { headline, detail: `${pending}New merchant · ${formatShortDate(item.countedDate, today)}` };
      // Rounded to the nearest whole multiple: floor((2 × spent + average) ÷ (2 × average)).
      const times = floorDiv(2 * item.spentMinor + item.merchantAverageMinor, 2 * item.merchantAverageMinor);
      return { headline, detail: `${pending}About ${times}× your usual ${gbp(item.merchantAverageMinor)} there` };
    }
    case "month_change":
      return {
        headline: `${names.category(item.categoryId)} ${item.changeMinor > 0 ? "up" : "down"} ${formatPounds(Math.abs(item.changeMinor))} in ${monthName(item.month)}`,
        detail: `${formatPounds(item.spentMinor)}, from ${formatPounds(item.previousSpentMinor)} in ${monthName(addMonths(item.month, -1))}`,
      };
  }
}
```

- [ ] **Step 4: Run** `npx vitest run test/insights/wording.spec.ts` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/worker/insights/wording.ts test/insights/wording.spec.ts
git commit -m "feat(worker): add insight wording shared by the app and the digest

Phase: P2.10"
```

### Task 5: Rows read, docs, pre-PR checks

**Files:**
- Modify: `test/rows-read.spec.ts`, `docs/schema-and-api.md`, `docs/insights-ui-brief.md` (large-charge copy shows pence)

- [ ] **Step 1:** In `test/rows-read.spec.ts`, after the analytics measurements add `const insights = await record("GET /api/insights", "GET", "/api/insights");` and with the assertions `expect(insights.rowsRead).toBeLessThan(6_000);`. Run it verbose. **If it fails, report the figure to the owner instead of raising the ceiling.**
- [ ] **Step 2: Docs.** Add `GET /api/insights` to `docs/schema-and-api.md`. In `docs/insights-ui-brief.md`'s insight table, change the large-charge example to "£240.00 at Halden Audio" / "About 4× your usual £58.00 there" (single charges show pence; `insightWords` is now the source of the copy).
- [ ] **Step 3:** `npm run check`, then `security-review`.
- [ ] **Step 4: Commit**

```bash
git add test/rows-read.spec.ts
git commit -m "test: pin rows read for the insights route

Phase: P2.10"
git add docs/schema-and-api.md docs/insights-ui-brief.md
git commit -m "docs: record the insights endpoint and its charge wording"
```

- [ ] **Step 5:** `code-review`, fix, `simplify`. Push; open PR `feat: add rule-based insights`; merge on approval.

**Accept when (P2.10):** `npm run check` passes including the rows-read ceiling; after deploy, the owner opens `/api/insights` in a logged-in browser and confirms each item matches what Home and Transactions show (e.g. an over-budget category really is over).

---

# P2.11 Weekly digest

Branch: `git checkout main && git pull && git checkout -b feat/weekly-digest`

### Task 0 (owner): Sending domain

Can start any time; Task 6 needs it done. All steps in the owner's own browser or terminal.

- [ ] In Namecheap, note every DNS record for the website's domain. In Cloudflare, **Add a domain** (Free plan), check those records were imported and fix any that weren't, then switch the nameservers at Namecheap to the two Cloudflare gives. Confirm the website still loads once the zone shows Active.
- [ ] In the zone, enable **Email Routing**, and under Destination addresses verify the address `ALLOWED_EMAIL` holds (click the link Cloudflare emails).
- [ ] Choose the sender (e.g. `tally@<domain>`) — it goes in `DIGEST_FROM` in Task 6.

### Task 1: Week helpers and the `digest_sends` table

**Files:**
- Modify: `src/worker/importer/dates.ts` (`mondayOf`, `londonHour`)
- Modify: `src/worker/db/schema.ts` (`digestSends`)
- Create: `migrations/0008_digest_sends.sql` (generated) and its `migrations/meta` snapshot
- Test: `test/importer/dates.spec.ts` (append), create `test/digest/sends.spec.ts`

**Interfaces:**
- Produces: `mondayOf(date: string): string`; `londonHour(now: Date): number`; table `digest_sends(week_start PK, status 'sending'|'sent'|'failed', attempted_at, sent_at, error)`; `DIGEST_SEND_STATUSES`.

- [ ] **Step 1: Write the failing tests.** Append to `test/importer/dates.spec.ts` (import `londonHour, mondayOf`):

```ts
describe("mondayOf", () => {
  it.each([
    ["2026-10-12", "2026-10-12"], // Monday
    ["2026-10-18", "2026-10-12"], // Sunday
    ["2026-10-01", "2026-09-28"], // across a month
    ["2027-01-01", "2026-12-28"], // across a year
  ])("%s → %s", (date, monday) => expect(mondayOf(date)).toBe(monday));
});

describe("londonHour", () => {
  it.each([
    ["2026-10-18T17:00:00Z", 18], // BST
    ["2026-10-18T18:00:00Z", 19],
    ["2026-10-25T17:00:00Z", 17], // the clocks went back at 01:00Z that morning
    ["2026-10-25T18:00:00Z", 18],
    ["2026-03-29T17:00:00Z", 18], // the clocks went forward at 01:00Z that morning
    ["2026-11-01T18:00:00Z", 18], // GMT
  ])("%s → %i", (iso, hour) => expect(londonHour(new Date(iso))).toBe(hour));
});
```

`test/digest/sends.spec.ts`:

```ts
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { NOW, resetDb } from "../db";

beforeEach(resetDb);

it("keeps one row per week and only known statuses", async () => {
  const insert = (week: string, status: string) =>
    env.DB.prepare("INSERT INTO digest_sends (week_start, status, attempted_at) VALUES (?1, ?2, ?3)").bind(week, status, NOW).run();
  await insert("2026-10-12", "sending");
  await expect(insert("2026-10-12", "sent")).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
  await expect(insert("2026-10-19", "bogus")).rejects.toThrow(/CHECK/);
});
```

- [ ] **Step 2: Run** `npx vitest run test/importer/dates.spec.ts test/digest/sends.spec.ts` — expected FAIL.
- [ ] **Step 3: Implement.** Append to `src/worker/importer/dates.ts`:

```ts
/** The Monday on or before `date`; weeks run Monday to Sunday (docs/phase-2-insights-spec.md). */
export function mondayOf(date: string): string {
  const p = parts(date);
  if (!p || !isYmd(date)) throw new Error("mondayOf: not a YYYY-MM-DD date");
  const weekday = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

const londonHourFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hourCycle: "h23" });

/** The hour (0–23) on a London clock at `now`. */
export const londonHour = (now: Date) => Number(londonHourFormat.format(now));
```

Add to `src/worker/db/schema.ts`, after `merchantMatches`:

```ts
// Weekly digest sends (docs/phase-2-insights-spec.md, Sending): one row per week, claimed before
// sending so a retried cron can't send twice. Status only, never the email's content.
export const DIGEST_SEND_STATUSES = ["sending", "sent", "failed"] as const;
export const digestSends = sqliteTable(
  "digest_sends",
  {
    // The week's Monday, YYYY-MM-DD.
    weekStart: text("week_start").primaryKey(),
    status: text("status", { enum: DIGEST_SEND_STATUSES }).notNull(),
    attemptedAt: text("attempted_at").notNull(),
    sentAt: text("sent_at"),
    // An Email Service error code (E_…), never a message: messages can carry addresses.
    error: text("error"),
  },
  (t) => [check("digest_sends_status_ck", isOneOf(t.status, DIGEST_SEND_STATUSES))],
);
```

Run `npm run db:generate -- --name digest_sends`, read the generated `migrations/0008_digest_sends.sql` (one `CREATE TABLE` with the CHECK), then `npm run db:check`.

- [ ] **Step 4: Run** `npx vitest run test/importer/dates.spec.ts test/digest/sends.spec.ts test/schema.spec.ts` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/worker/importer/dates.ts src/worker/db/schema.ts migrations test/importer/dates.spec.ts test/digest/sends.spec.ts
git commit -m "feat(db): add digest_sends to send the weekly digest once

Phase: P2.11"
```

### Task 2: Digest content and `GET /api/digest/preview`

**Files:**
- Create: `src/worker/digest/content.ts`, `src/worker/routes/digest.ts`
- Modify: `src/worker/index.ts` (mount `/digest`)
- Test: create `test/digest/content.spec.ts`

**Interfaces:**
- Consumes: `readMonthSummary` (P2.8); `spendByMonth`, `budgetSpend`, `pendingBudgetSpend`, `projectedMinor` (P2.9); `readInsightInput`, `buildInsights`, `PACE_FROM_DAY` (P2.10); `mondayOf`.
- Produces: `type CategoryStatus = "ok" | "near" | "over" | "projected_over"`; `lineStatus(spentMinor, allocatedMinor, today): CategoryStatus`; `type Digest`; `readDigest(db: D1Database, now: Date): Promise<Digest>` (about 26 statements); `digestRoutes` (preview now; send in Task 4).

- [ ] **Step 1: Write the failing test** `test/digest/content.spec.ts`:

```ts
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineStatus } from "../../src/worker/digest/content";
import { insertAllocation, insertOverall } from "../budget/budget-rows";
import { SEEDED, insertOverride, insertRule, ledger } from "../budget/helpers";
import { NOW, resetDb } from "../db";
import { get } from "../http";

// All data is synthetic. "Today" is Thu 15 Oct 2026 unless a test moves it; its week began Mon 12 Oct.

type Digest = {
  weekStart: string; weekEnd: string; spansMonths: boolean; weekSpentMinor: number; weekPendingSpentMinor: number;
  month: { month: string; spentMinor: number; overallMinor: number | null; leftMinor: number | null; perWeekMinor: number | null; daysRemaining: number | null };
  categories: { categoryId: number | null; spentMinor: number; allocatedMinor: number; status: string }[];
  insights: { type: string }[]; inboxCount: number; staleAccountIds: number[]; lastDataChangeAt: string | null;
  lastSend: { weekStart: string; status: string; sentAt: string | null } | null;
};
const preview = async () => (await (await get("/api/digest/preview")).json()) as Digest;
const at = (iso: string) => vi.setSystemTime(new Date(iso));

let a: number;
let txn: Awaited<ReturnType<typeof ledger>>["txn"];

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-15T12:00:00Z");
  const l = await ledger();
  a = l.accounts[0];
  txn = l.txn;
  await insertRule("exact", "grocer", SEEDED.groceries);
  await insertRule("exact", "outfitter", SEEDED.clothes);
});
afterEach(() => vi.useRealTimers());

describe("lineStatus", () => {
  it.each([
    [10_001, 10_000, "2026-10-02", "over"],
    [9_000, 10_000, "2026-10-15", "projected_over"], // 9000 × 31 ÷ 15 = 18600
    [9_000, 10_000, "2026-10-03", "near"], // too early to project
    [3_000, 10_000, "2026-10-15", "ok"], // projects 6200
    [0, 0, "2026-10-15", "ok"],
    [100, 0, "2026-10-15", "over"],
  ])("%i of %i on %s → %s", (spent, allocated, today, status) => expect(lineStatus(spent, allocated, today)).toBe(status));
});

describe("GET /api/digest/preview", () => {
  it("sums budget spend counted Monday to today, by counted date", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-10-11" }); // Sunday before: out
    await txn(a, { merchant: "Grocer", amountMinor: -2_000, txnDate: "2026-10-12" });
    await txn(a, { merchant: "Grocer", amountMinor: -300, txnDate: "2026-10-15", isPending: true });
    await txn(a, { merchant: "Outfitter", amountMinor: -9_000, txnDate: "2026-10-13" }); // tracked: out
    const moved = await txn(a, { merchant: "Grocer", amountMinor: -400, txnDate: "2026-10-09" });
    await insertOverride(moved, { counted_date: "2026-10-13" }); // counted in the week
    const d = await preview();
    expect(d).toMatchObject({ weekStart: "2026-10-12", weekEnd: "2026-10-15", spansMonths: false, weekSpentMinor: 2_700, weekPendingSpentMinor: 300 });
  });

  it("spans two months at the start of October and keeps the month figures to October", async () => {
    at("2026-10-01T12:00:00Z");
    await txn(a, { merchant: "Grocer", amountMinor: -1_000, txnDate: "2026-09-29" });
    await txn(a, { merchant: "Grocer", amountMinor: -500, txnDate: "2026-10-01" });
    const d = await preview();
    expect(d).toMatchObject({ weekStart: "2026-09-28", spansMonths: true, weekSpentMinor: 1_500, month: { month: "2026-10", spentMinor: 500 } });
  });

  it("lists each allocated category, then Misc of posted uncategorised and unallocated spend", async () => {
    await insertOverall("2026-10", 100_000);
    await insertAllocation(SEEDED.groceries, "2026-10", 10_000);
    await txn(a, { merchant: "Grocer", amountMinor: -9_000, txnDate: "2026-10-05" });
    await txn(a, { merchant: "Unknown shop", amountMinor: -700, txnDate: "2026-10-05" });
    await txn(a, { merchant: "Unknown shop", amountMinor: -200, txnDate: "2026-10-14", isPending: true }); // pending: not in Misc
    await insertRule("exact", "cab", SEEDED.transport); // budgeted, no allocation: Misc
    await txn(a, { merchant: "Cab", amountMinor: -1_100, txnDate: "2026-10-06" });
    expect((await preview()).categories).toEqual([
      { categoryId: SEEDED.groceries, spentMinor: 9_000, allocatedMinor: 10_000, status: "projected_over" },
      { categoryId: null, spentMinor: 1_800, allocatedMinor: 90_000, status: "ok" },
    ]);
  });

  it("works with no budget set: no left, no pace, no category lines", async () => {
    await txn(a, { merchant: "Grocer", amountMinor: -9_000, txnDate: "2026-10-05" });
    const d = await preview();
    expect(d.month).toMatchObject({ overallMinor: null, leftMinor: null, perWeekMinor: null, spentMinor: 9_000 });
    expect(d.categories).toEqual([]);
  });

  it("includes the insights, the to-sort count and the latest send", async () => {
    await insertOverall("2026-10", 1_000);
    await txn(a, { merchant: "Unknown shop", amountMinor: -5_000, txnDate: "2026-10-05" });
    expect(await preview()).toMatchObject({ inboxCount: 1, lastSend: null, insights: [{ type: "pace" }] });
    await env.DB.prepare("INSERT INTO digest_sends (week_start, status, attempted_at, sent_at) VALUES ('2026-10-05', 'sent', ?1, ?1)").bind(NOW).run();
    expect((await preview()).lastSend).toEqual({ weekStart: "2026-10-05", status: "sent", sentAt: NOW });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/digest/content.spec.ts` — expected FAIL.

- [ ] **Step 3: Implement** `src/worker/digest/content.ts`:

```ts
import { projectedMinor } from "../analytics/math";
import { budgetSpend, pendingBudgetSpend, spendByMonth } from "../analytics/spend";
import { readMonthSummary, type MonthSummary } from "../budget/summary";
import { daysInMonth, londonToday, mondayOf } from "../importer/dates";
import { readInsightInput } from "../insights/read";
import { buildInsights } from "../insights/rules";
import { PACE_FROM_DAY } from "../insights/thresholds";

// The weekly digest's content (docs/phase-2-insights-spec.md, Weekly digest): the preview route
// returns it, and the email renders it.

export type CategoryStatus = "ok" | "near" | "over" | "projected_over";

/** Home's flags (over; near from 90%), plus the pace projection from PACE_FROM_DAY. */
export function lineStatus(spentMinor: number, allocatedMinor: number, today: string): CategoryStatus {
  if (spentMinor > allocatedMinor) return "over";
  const dom = Number(today.slice(8, 10));
  if (allocatedMinor > 0 && dom >= PACE_FROM_DAY && projectedMinor(spentMinor, dom, daysInMonth(today.slice(0, 7))) > allocatedMinor) return "projected_over";
  return allocatedMinor > 0 && spentMinor * 10 >= allocatedMinor * 9 ? "near" : "ok";
}

/**
 * Each allocated budgeted category, then Misc as Home draws it: posted uncategorised spend plus
 * budgeted categories without an allocation (archived ones included). None without a budget.
 */
function digestLines(s: MonthSummary, today: string) {
  if (s.miscMinor === null) return [];
  const allocated = s.categories.filter((l) => l.kind === "budgeted" && l.allocatedMinor > 0);
  const miscSpent = s.categories.reduce(
    (sum, l) => (l.categoryId === null ? sum + l.spentMinor - l.pendingSpentMinor : l.kind === "budgeted" && l.allocatedMinor === 0 ? sum + l.spentMinor : sum),
    0,
  );
  return [
    ...allocated.map((l) => ({ categoryId: l.categoryId, spentMinor: l.spentMinor, allocatedMinor: l.allocatedMinor, status: lineStatus(l.spentMinor, l.allocatedMinor, today) })),
    { categoryId: null, spentMinor: miscSpent, allocatedMinor: s.miscMinor, status: lineStatus(miscSpent, s.miscMinor, today) },
  ];
}

const LAST_SEND_SQL = "SELECT week_start AS weekStart, status, sent_at AS sentAt FROM digest_sends ORDER BY week_start DESC LIMIT 1";

/** This week's digest, Monday to today in London. */
export async function readDigest(db: D1Database, now: Date) {
  const today = londonToday(now);
  const weekStart = mondayOf(today);
  const [summary, week, insightInput, lastSend] = await Promise.all([
    readMonthSummary(db, today.slice(0, 7), now),
    spendByMonth(db, weekStart, today),
    readInsightInput(db, now),
    db.prepare(LAST_SEND_SQL).first<{ weekStart: string; status: string; sentAt: string | null }>(),
  ]);
  return {
    weekStart,
    weekEnd: today,
    spansMonths: weekStart.slice(0, 7) !== today.slice(0, 7),
    weekSpentMinor: budgetSpend(week),
    weekPendingSpentMinor: pendingBudgetSpend(week),
    month: {
      month: summary.month,
      spentMinor: summary.spentMinor,
      pendingSpentMinor: summary.pendingSpentMinor,
      overallMinor: summary.overallMinor,
      leftMinor: summary.leftMinor,
      perWeekMinor: summary.perWeekMinor,
      daysRemaining: summary.daysRemaining,
    },
    categories: digestLines(summary, today),
    insights: buildInsights(insightInput),
    inboxCount: summary.inboxCount,
    staleAccountIds: summary.staleAccountIds,
    lastDataChangeAt: summary.lastDataChangeAt,
    lastSend: lastSend ?? null,
  };
}

export type Digest = Awaited<ReturnType<typeof readDigest>>;
```

`src/worker/routes/digest.ts`:

```ts
import { Hono } from "hono";
import type { AppEnv } from "../auth";
import { readDigest } from "../digest/content";

// The weekly digest (docs/phase-2-insights-spec.md). The preview is the email's content, live.
export const digestRoutes = new Hono<AppEnv>().get("/preview", async (c) => c.json(await readDigest(c.env.DB, new Date())));
```

In `src/worker/index.ts`, import `digestRoutes` and add `app.route("/digest", digestRoutes);`.

- [ ] **Step 4: Run** `npx vitest run test/digest/content.spec.ts` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/worker/digest/content.ts src/worker/routes/digest.ts src/worker/index.ts test/digest/content.spec.ts
git commit -m "feat(worker): add the weekly digest preview

Phase: P2.11"
```

### Task 3: Render the email

**Files:**
- Create: `src/worker/digest/email.ts`
- Test: create `test/digest/email.spec.ts`

**Interfaces:**
- Consumes: `type Digest`, `type CategoryStatus` (Task 2); `insightWords`, `type Names` (P2.10); `formatDayMonth`, `formatPounds`, `formatTimestamp`, `monthName` (P2.10 Task 1).
- Produces: `DIGEST_INSIGHTS_SHOWN = 5`; `escapeHtml(s: string): string`; `weekRange(from: string, to: string): string`; `renderDigestEmail(d: Digest, names: Names, appUrl: string): { subject: string; text: string; html: string }`.

- [ ] **Step 1: Write the failing test** `test/digest/email.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Digest } from "../../src/worker/digest/content";
import { escapeHtml, renderDigestEmail, weekRange } from "../../src/worker/digest/email";
import type { Insight } from "../../src/worker/insights/rules";
import type { Names } from "../../src/worker/insights/wording";

// Synthetic figures and names only.

const names: Names = { category: (id) => (id === null ? "Uncategorised" : "Groceries"), account: () => "Card B" };
const charge = (name: string, id = 1): Insight => ({
  id: `large:${id}`, type: "large_charge", severity: "info", transactionId: id, merchantKey: "k", name, spentMinor: 12_000, merchantAverageMinor: null, countedDate: "2026-10-14", isPending: false,
});
const digest = (over: Partial<Digest> = {}): Digest => ({
  weekStart: "2026-10-12", weekEnd: "2026-10-18", spansMonths: false, weekSpentMinor: 23_000, weekPendingSpentMinor: 0,
  month: { month: "2026-10", spentMinor: 100_300, pendingSpentMinor: 0, overallMinor: 144_000, leftMinor: 43_700, perWeekMinor: 19_100, daysRemaining: 14 },
  categories: [{ categoryId: 1, spentMinor: 9_000, allocatedMinor: 10_000, status: "near" }, { categoryId: null, spentMinor: 1_800, allocatedMinor: 90_000, status: "ok" }],
  insights: [], inboxCount: 11, staleAccountIds: [], lastDataChangeAt: "2026-10-18T14:00:00.000Z", lastSend: null, ...over,
});
const render = (over: Partial<Digest> = {}) => renderDigestEmail(digest(over), names, "https://tally.example.workers.dev");

describe("weekRange", () => {
  it("shares the month when it can", () => expect(weekRange("2026-10-12", "2026-10-18")).toBe("12–18 Oct"));
  it("names both months across a boundary", () => expect(weekRange("2026-09-28", "2026-10-04")).toBe("28 Sep – 4 Oct"));
});

describe("renderDigestEmail", () => {
  it("keeps figures out of the subject", () => {
    const { subject } = render();
    expect(subject).toBe("Your week in Tally · 12–18 Oct");
    expect(subject).not.toMatch(/£|\d{3}/);
  });

  it("puts the figures in order in the text part", () => {
    const { text } = render();
    expect(text).toContain("This week: £230 spent");
    expect(text).toContain("October so far: £1,003 of £1,440 · £437 left · £191/week for the rest of the month");
    expect(text).toContain("Groceries: £90 / £100 · Near limit");
    expect(text).toContain("Misc: £18 / £900 · On track");
    expect(text).toContain("11 transactions to sort");
    expect(text).toContain("Open Tally: https://tally.example.workers.dev");
    expect(text.indexOf("This week")).toBeLessThan(text.indexOf("Groceries:"));
  });

  it("says 'at least' with pending spend, and notes a week crossing months", () => {
    const { text } = render({ weekPendingSpentMinor: 500, spansMonths: true, weekStart: "2026-09-28", weekEnd: "2026-10-04" });
    expect(text).toContain("This week: at least £230 spent");
    expect(text).toContain("Includes the end of September.");
  });

  it("words a month with no budget without left or pace", () => {
    const { text } = render({ month: { month: "2026-10", spentMinor: 5_000, pendingSpentMinor: 0, overallMinor: null, leftMinor: null, perWeekMinor: null, daysRemaining: 14 }, categories: [] });
    expect(text).toContain("October so far: £50 spent · no budget set");
    expect(text).not.toContain("CATEGORIES");
  });

  it("shows the top 5 insights and counts the rest", () => {
    const insights = Array.from({ length: 7 }, (_, i) => charge(`Shop ${i}`, i));
    const { text } = render({ insights });
    expect(text).toContain("£120.00 at Shop 4");
    expect(text).not.toContain("Shop 5");
    expect(text).toContain("and 2 more in Tally");
  });

  it("escapes untrusted merchant text in the HTML part only", () => {
    const { html, text } = render({ insights: [charge(`<img src=x onerror="alert(1)">`)] });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(text).toContain(`<img src=x onerror="alert(1)">`);
  });

  it("escapes the five HTML characters", () => expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;"));
});
```

- [ ] **Step 2: Run** `npx vitest run test/digest/email.spec.ts` — expected FAIL.

- [ ] **Step 3: Implement** `src/worker/digest/email.ts`:

```ts
import { formatDayMonth, formatPounds, formatTimestamp, monthName } from "../display";
import { insightWords, type Names } from "../insights/wording";
import type { CategoryStatus, Digest } from "./content";

// The weekly digest email (docs/insights-ui-brief.md, The weekly email): plain text plus simple
// inline-styled HTML, no images or remote content. Every string is built as plain text first and
// escaped exactly once when the HTML is assembled, so merchant names can't inject markup.

export const DIGEST_INSIGHTS_SHOWN = 5;

const STATUS_WORD: Record<CategoryStatus, string> = { over: "Over", projected_over: "On course to go over", near: "Near limit", ok: "On track" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** "12–18 Oct", or "28 Sep – 4 Oct" across months. The digest is always this week, so no year. */
export const weekRange = (from: string, to: string) =>
  from.slice(0, 7) === to.slice(0, 7) ? `${Number(from.slice(8, 10))}–${formatDayMonth(to, to)}` : `${formatDayMonth(from, to)} – ${formatDayMonth(to, to)}`;

type Line = { main: string; sub?: string };
type Block = { heading?: string; lines: Line[] };

function blocks(d: Digest, names: Names): Block[] {
  const m = d.month;
  const month = monthName(m.month);
  const out: Block[] = [
    {
      lines: [
        { main: `This week: ${d.weekPendingSpentMinor > 0 ? "at least " : ""}${formatPounds(d.weekSpentMinor)} spent` },
        ...(d.spansMonths ? [{ main: `Includes the end of ${monthName(d.weekStart.slice(0, 7))}.` }] : []),
      ],
    },
    {
      lines: [
        {
          main:
            m.overallMinor === null || m.leftMinor === null
              ? `${month} so far: ${formatPounds(m.spentMinor)} spent · no budget set`
              : `${month} so far: ${formatPounds(m.spentMinor)} of ${formatPounds(m.overallMinor)} · ` +
                (m.leftMinor >= 0 ? `${formatPounds(m.leftMinor)} left` : `${formatPounds(-m.leftMinor)} over`) +
                (m.perWeekMinor !== null && m.leftMinor > 0 ? ` · ${formatPounds(m.perWeekMinor)}/week for the rest of the month` : ""),
        },
      ],
    },
  ];
  if (d.categories.length > 0) {
    out.push({
      heading: "Categories",
      lines: d.categories.map((l) => ({
        main: `${l.categoryId === null ? "Misc" : names.category(l.categoryId)}: ${formatPounds(l.spentMinor)} / ${formatPounds(l.allocatedMinor)} · ${STATUS_WORD[l.status]}`,
      })),
    });
  }
  if (d.insights.length > 0) {
    const more = d.insights.length - DIGEST_INSIGHTS_SHOWN;
    out.push({
      heading: "Worth a look",
      lines: [
        ...d.insights.slice(0, DIGEST_INSIGHTS_SHOWN).map((i) => {
          const w = insightWords(i, names, d.weekEnd);
          return { main: w.headline, sub: w.detail };
        }),
        ...(more > 0 ? [{ main: `and ${more} more in Tally` }] : []),
      ],
    });
  }
  out.push({
    lines: [
      ...(d.inboxCount > 0 ? [{ main: `${d.inboxCount} transaction${d.inboxCount === 1 ? "" : "s"} to sort` }] : []),
      { main: `Data last changed ${formatTimestamp(d.lastDataChangeAt)}` },
    ],
  });
  return out;
}

const textOf = (bs: Block[], appUrl: string) =>
  [...bs.map((b) => [...(b.heading ? [b.heading.toUpperCase()] : []), ...b.lines.map((l) => (l.sub ? `${l.main}\n  ${l.sub}` : l.main))].join("\n")), `Open Tally: ${appUrl}`].join("\n\n");

const htmlOf = (bs: Block[], appUrl: string) =>
  `<!doctype html><html><body style="margin:0;padding:16px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45">` +
  `<div style="max-width:600px;margin:0 auto"><h1 style="font-size:20px;font-weight:500;margin:0 0 16px">Your week in Tally</h1>` +
  bs
    .map(
      (b) =>
        (b.heading ? `<h2 style="font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin:20px 0 8px">${escapeHtml(b.heading)}</h2>` : "") +
        b.lines.map((l) => `<p style="margin:0 0 8px">${l.sub ? `<strong>${escapeHtml(l.main)}</strong><br>${escapeHtml(l.sub)}` : escapeHtml(l.main)}</p>`).join(""),
    )
    .join("") +
  `<p style="margin:20px 0 0"><a href="${escapeHtml(appUrl)}">Open Tally</a></p></div></body></html>`;

export function renderDigestEmail(d: Digest, names: Names, appUrl: string) {
  const bs = blocks(d, names);
  return { subject: `Your week in Tally · ${weekRange(d.weekStart, d.weekEnd)}`, text: textOf(bs, appUrl), html: htmlOf(bs, appUrl) };
}
```

- [ ] **Step 4: Run** `npx vitest run test/digest/email.spec.ts` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add src/worker/digest/email.ts test/digest/email.spec.ts
git commit -m "feat(worker): render the weekly digest email

Phase: P2.11"
```

### Task 4: Send it — cron, claim, manual send, config

**Files:**
- Create: `src/worker/digest/send.ts`
- Modify: `src/worker/index.ts` (`scheduled` routing), `src/worker/routes/digest.ts` (`POST /send`)
- Modify: `wrangler.jsonc`, `vitest.config.ts`, `worker-configuration.d.ts` (regenerated)
- Test: create `test/digest/send.spec.ts`

**Interfaces:**
- Consumes: `readDigest` (Task 2), `renderDigestEmail` (Task 3), `londonHour`, `londonToday`, `mondayOf`, `type Names`.
- Produces: `DIGEST_CRON = "0 17,18 * * SUN"`, `DIGEST_HOUR = 18`; `deliverDigest(env: DigestEnv, now: Date, trigger: "cron" | "manual"): Promise<{ ok: true } | { ok: false; error: string }>`; `runScheduledDigest(env: DigestEnv, now: Date): Promise<"disabled" | "not_send_hour" | "already_claimed" | "sent" | "failed">`.

- [ ] **Step 1: Config.** In `wrangler.jsonc`:
  - in `vars`, add `"DIGEST_ENABLED": "false"` with the comment `// "true" once the owner's sending domain is set up (docs/phase-2-insights-spec.md, Owner setup).`
  - add `"DIGEST_FROM"` and `"APP_URL"` to `secrets.required`, extending the comment: `DIGEST_FROM is the digest's sender on the owner's domain; APP_URL is the app's own URL for the email's link. Both stay out of this public file.`
  - add `"send_email": [{ "name": "DIGEST_EMAIL" }],` with the comment `// The weekly digest. No allowed_destination_addresses here: that would publish the address. The code sends only to ALLOWED_EMAIL, and the free plan only delivers to verified destinations.`
  - change `crons` to `["0 */3 * * *", "0 17,18 * * SUN"]`, extending the comment: `The second is the weekly digest: 17:00 and 18:00 UTC on Sundays, of which exactly one is 18:00 in London (src/worker/digest/send.ts).`

  In `vitest.config.ts`, add `DIGEST_FROM: "tally@example.com", APP_URL: "https://tally.example.workers.dev"` to `miniflare.bindings`. Run `npm run cf-typegen` and check `worker-configuration.d.ts` now has `DIGEST_EMAIL: SendEmail`, `DIGEST_FROM`, `APP_URL` and `DIGEST_ENABLED` on `Env` (and still declares `EmailMessageBuilder`).

- [ ] **Step 2: Write the failing test** `test/digest/send.spec.ts`:

```ts
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIGEST_CRON, runScheduledDigest } from "../../src/worker/digest/send";
import worker from "../../src/worker/index";
import { resetDb } from "../db";
import { send } from "../http";

// A fake send_email binding records what would have gone out. All data is synthetic.

type Sent = { from: string; to: string; subject: string; text: string; html: string };
let sent: Sent[];
let fail: Error | null;
const fakeEnv = (over: Partial<Env> = {}): Env =>
  ({
    ...env,
    DIGEST_ENABLED: "true",
    DIGEST_EMAIL: {
      send: async (m: Sent) => {
        if (fail) throw fail;
        sent.push(m);
        return { messageId: "m1" };
      },
    },
    ...over,
  }) as unknown as Env;
const sends = () => env.DB.prepare("SELECT week_start, status, error FROM digest_sends ORDER BY week_start").all();

beforeEach(async () => {
  await resetDb();
  sent = [];
  fail = null;
});
afterEach(() => vi.restoreAllMocks());

describe("runScheduledDigest", () => {
  it.each([
    ["2026-10-18T17:00:00Z", "sent"], // 18:00 BST
    ["2026-10-18T18:00:00Z", "not_send_hour"], // 19:00 BST
    ["2026-10-25T17:00:00Z", "not_send_hour"], // the clocks went back that morning: 17:00 GMT
    ["2026-10-25T18:00:00Z", "sent"],
    ["2026-11-01T17:00:00Z", "not_send_hour"],
    ["2026-11-01T18:00:00Z", "sent"], // 18:00 GMT
  ])("at %s → %s", async (iso, outcome) => {
    expect(await runScheduledDigest(fakeEnv(), new Date(iso))).toBe(outcome);
    expect(sent).toHaveLength(outcome === "sent" ? 1 : 0);
  });

  it("sends once a week to ALLOWED_EMAIL from DIGEST_FROM, with no figures in the subject", async () => {
    const now = new Date("2026-10-18T17:00:00Z");
    expect(await runScheduledDigest(fakeEnv(), now)).toBe("sent");
    expect(await runScheduledDigest(fakeEnv(), now)).toBe("already_claimed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "tally@example.com", to: "owner@example.com", subject: "Your week in Tally · 12–18 Oct" });
    expect((await sends()).results).toEqual([{ week_start: "2026-10-12", status: "sent", error: null }]);
  });

  it("records a failed send by its code and logs neither the body nor the address", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    fail = Object.assign(new Error("delivery to owner@example.com failed"), { code: "E_DELIVERY_FAILED" });
    expect(await runScheduledDigest(fakeEnv(), new Date("2026-10-18T17:00:00Z"))).toBe("failed");
    expect((await sends()).results).toEqual([{ week_start: "2026-10-12", status: "failed", error: "E_DELIVERY_FAILED" }]);
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain('"status":"failed"');
    expect(logged).not.toMatch(/owner@example\.com|£|Your week/);
  });

  it("does nothing while disabled", async () => {
    expect(await runScheduledDigest(fakeEnv({ DIGEST_ENABLED: "false" } as Partial<Env>), new Date("2026-10-18T17:00:00Z"))).toBe("disabled");
    expect(sent).toEqual([]);
    expect((await sends()).results).toEqual([]);
  });
});

describe("scheduled()", () => {
  it("routes the digest cron to the digest and not to an import", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: DIGEST_CRON, scheduledTime: Date.parse("2026-10-18T17:00:00Z") }), fakeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(sent).toHaveLength(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM import_runs").first()).toEqual({ n: 0 });
  });
});

describe("POST /api/digest/send", () => {
  it("sends now and leaves the weekly claim alone", async () => {
    const res = await send("POST", "/api/digest/send", {}, {}, fakeEnv());
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect((await sends()).results).toEqual([]);
  });

  it("answers 502 when the send fails", async () => {
    fail = Object.assign(new Error("x"), { code: "E_RATE_LIMIT_EXCEEDED" });
    const res = await send("POST", "/api/digest/send", {}, {}, fakeEnv());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "send_failed" });
  });
});
```

- [ ] **Step 3: Run** `npx vitest run test/digest/send.spec.ts` — expected FAIL.

- [ ] **Step 4: Implement** `src/worker/digest/send.ts`:

```ts
import { londonHour, londonToday, mondayOf } from "../importer/dates";
import type { Names } from "../insights/wording";
import { readDigest } from "./content";
import { renderDigestEmail } from "./email";

// Sends the weekly digest (docs/phase-2-insights-spec.md, Sending), only ever to ALLOWED_EMAIL:
// the verified destination Cloudflare delivers to for free. Logs carry status, duration and
// counts, never the email, its subject or the address.

/** Must match the digest cron in wrangler.jsonc. Cron is UTC; DIGEST_HOUR is London's. */
export const DIGEST_CRON = "0 17,18 * * SUN";
export const DIGEST_HOUR = 18;

export type DigestEnv = Pick<Env, "DB" | "DIGEST_EMAIL" | "DIGEST_FROM" | "APP_URL" | "ALLOWED_EMAIL" | "DIGEST_ENABLED">;
export type Delivery = { ok: true } | { ok: false; error: string };

async function readNames(db: D1Database): Promise<Names> {
  const [categories, accounts] = await Promise.all([
    db.prepare("SELECT id, name FROM categories").all<{ id: number; name: string }>(),
    db.prepare("SELECT id, name FROM accounts").all<{ id: number; name: string }>(),
  ]);
  const category = new Map(categories.results.map((r) => [r.id, r.name]));
  const account = new Map(accounts.results.map((r) => [r.id, r.name]));
  return {
    category: (id) => (id === null ? "Uncategorised" : (category.get(id) ?? "A category")),
    account: (id) => account.get(id) ?? "An account",
  };
}

/** An Email Service error's code (E_…), never its message, which can carry addresses. */
const errorCode = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" && /^E_[A-Z_]{1,60}$/.test(e.code) ? e.code : "unknown";

/** Builds this week's digest and sends it to the owner. Never throws. */
export async function deliverDigest(env: DigestEnv, now: Date, trigger: "cron" | "manual"): Promise<Delivery> {
  const started = Date.now();
  let counts = { insights: 0, categories: 0 };
  let result: Delivery;
  try {
    const [digest, names] = await Promise.all([readDigest(env.DB, now), readNames(env.DB)]);
    counts = { insights: digest.insights.length, categories: digest.categories.length };
    await env.DIGEST_EMAIL.send({ from: env.DIGEST_FROM, to: env.ALLOWED_EMAIL, ...renderDigestEmail(digest, names, env.APP_URL) });
    result = { ok: true };
  } catch (e) {
    result = { ok: false, error: errorCode(e) };
  }
  console.log(JSON.stringify({ event: "digest_send", trigger, status: result.ok ? "sent" : "failed", error: result.ok ? undefined : result.error, durationMs: Date.now() - started, ...counts }));
  return result;
}

/** The Sunday cron: claims the week, then sends once, at 18:00 London. */
export async function runScheduledDigest(env: DigestEnv, now: Date) {
  if (env.DIGEST_ENABLED !== "true") return "disabled" as const;
  // The cron fires at 17:00 and 18:00 UTC; exactly one of them is 18:00 in London.
  if (londonHour(now) !== DIGEST_HOUR) return "not_send_hour" as const;
  const weekStart = mondayOf(londonToday(now));
  const claim = await env.DB.prepare("INSERT INTO digest_sends (week_start, status, attempted_at) VALUES (?1, 'sending', ?2) ON CONFLICT (week_start) DO NOTHING")
    .bind(weekStart, now.toISOString())
    .run();
  if (claim.meta.changes === 0) return "already_claimed" as const;
  const result = await deliverDigest(env, now, "cron");
  await env.DB.prepare("UPDATE digest_sends SET status = ?2, sent_at = ?3, error = ?4 WHERE week_start = ?1")
    .bind(weekStart, result.ok ? "sent" : "failed", result.ok ? new Date().toISOString() : null, result.ok ? null : result.error)
    .run();
  return result.ok ? ("sent" as const) : ("failed" as const);
}
```

In `src/worker/routes/digest.ts`, import `deliverDigest` and chain:

```ts
  // By hand: for the acceptance check and re-sending a failed week. Doesn't touch the weekly claim.
  .post("/send", async (c) => {
    const result = await deliverDigest(c.env, new Date(), "manual");
    return result.ok ? c.json({ ok: true }) : c.json({ error: "send_failed" }, 502);
  });
```

In `src/worker/index.ts`, import `DIGEST_CRON, runScheduledDigest` from `./digest/send` and replace `scheduled`:

```ts
  async scheduled(controller, env, ctx) {
    // Two crons (wrangler.jsonc): the weekly digest's, and the import's.
    if (controller.cron === DIGEST_CRON) ctx.waitUntil(runScheduledDigest(env, new Date(controller.scheduledTime)));
    // runImport records its own failures; it never throws for a provider or per-account error.
    else ctx.waitUntil(runImport(env, "cron"));
  },
```

- [ ] **Step 5: Run** `npx vitest run test/digest test/scheduled.spec.ts` — expected PASS. Then `npm run check`.
- [ ] **Step 6: Commit**

```bash
git add src/worker/digest/send.ts src/worker/routes/digest.ts src/worker/index.ts wrangler.jsonc vitest.config.ts worker-configuration.d.ts test/digest/send.spec.ts
git commit -m "feat(worker): send the weekly digest on Sundays at 18:00 London

Sends only to the owner's verified address, which Cloudflare Email
Service delivers free on Workers Free. Off until DIGEST_ENABLED is set.

Phase: P2.11"
```

### Task 5: Rows read, docs, pre-PR checks

**Files:**
- Modify: `test/rows-read.spec.ts`, `docs/schema-and-api.md`, `docs/architecture.md` (Scheduling), `docs/setup-responsibilities.md` (owner setup and secrets), `README.md` (Running it: the two new secrets)

- [ ] **Step 1:** In `test/rows-read.spec.ts` add `const digest = await record("GET /api/digest/preview", "GET", "/api/digest/preview");` and `expect(digest.rowsRead).toBeLessThan(8_000);`. Run verbose; report instead of raising if it fails.
- [ ] **Step 2: Docs.** `schema-and-api.md`: the `digest_sends` table and the two digest routes. `architecture.md` → Scheduling: the second cron and why it fires twice. `setup-responsibilities.md`: Task 0's steps and `wrangler secret put DIGEST_FROM` / `APP_URL`, in the owner's column. `README.md` → Running it: list `DIGEST_FROM` and `APP_URL` with the other secrets, and note that `DIGEST_ENABLED` defaults to off.
- [ ] **Step 3:** `npm run check`, then `security-review` (new POST route, outbound email, untrusted text in HTML).
- [ ] **Step 4: Commit**

```bash
git add test/rows-read.spec.ts
git commit -m "test: pin rows read for the digest preview

Phase: P2.11"
git add docs/schema-and-api.md docs/architecture.md docs/setup-responsibilities.md README.md
git commit -m "docs: record the weekly digest, its cron and its setup"
```

- [ ] **Step 5:** `code-review`, fix, `simplify`. Push; open PR `feat: send a weekly digest email`; merge on approval.

### Task 6: Deploy and acceptance (owner and agent)

- [ ] **Owner:** after Task 0, in your own terminal: `wrangler secret put DIGEST_FROM` and `wrangler secret put APP_URL`. Also add both to your `.dev.vars` so `npm run dev` has them.
- [ ] **Agent, with the owner's go-ahead:** `npm run db:migrate:remote`, then `npm run deploy` (`DIGEST_ENABLED` is still `"false"`).
- [ ] **Owner:** in the logged-in app, open the browser console and run `await (await fetch("/api/digest/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()`. Expect `{ ok: true }` and the email in your inbox. If it's `send_failed`, the agent reads the `digest_send` log line's `error` with `wrangler tail`: `E_SENDER_NOT_VERIFIED` or `E_SENDER_DOMAIN_NOT_AVAILABLE` means the domain must also be onboarded to Email Sending (dashboard → Email Service → Email Sending, or `wrangler email sending enable <domain>` in your terminal). Confirm on the pricing page that verified-destination sends stay free before doing it, then retry.
- [ ] **Agent:** set `DIGEST_ENABLED` to `"true"` in `wrangler.jsonc`, commit `chore(worker): turn on the weekly digest` with `Phase: P2.11` on a branch, PR, merge on approval, deploy.
- [ ] **After the next Sunday:** `wrangler d1 execute tally-prod --remote --command "SELECT week_start, status, sent_at, error FROM digest_sends"` (status only, no financial data) shows `sent` for that week, and the email arrived at 18:00 London. Measure the digest cron's CPU the way P1.8 did (`scripts/usage-report.ts`, `workersInvocationsScheduled` filtered to the digest cron).

**Accept when (P2.11):** `npm run check` passes; a manual send arrives; the next Sunday's email arrives at 18:00 London with one `sent` row for the week; the digest cron's CPU is under 10 ms.

---

# P2.12 Insights UI

Depends on the owner's designs from [insights-ui-brief.md](insights-ui-brief.md). **Its plan is written once the designs exist**, because component structure, charts and layout follow from them, and planning screens in advance would be guessing. It will cover:

- the fourth tab and its routes (`/insights`, `/insights/review/:month`, `/insights/trends`, `/merchants/:key`);
- `src/web/api.ts` types and fetchers for the P2.9–P2.11 endpoints, and `src/web/queries.ts` hooks;
- mock handlers in `src/web/mock/index.ts` for each new endpoint, with `?mock=` scenarios for the brief's states;
- the Insights tab (This week from `/api/digest/preview`, the list worded by `insightWords`, "Send now" on a failed digest), Monthly review, Trends and Merchant screens, the "All from <merchant>" link in the transaction sheets;
- `docs/ui-design.md` updated to four tabs.

Before it starts, check the `dataviz` and `frontend-design` skills for the charts.
