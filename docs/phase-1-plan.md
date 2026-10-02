# Phase 1: prove the backend and live connections

**Objective:** a minimal deployed vertical slice that proves:

1. Private, authenticated access works.
2. The backend can call Lunch Flow securely.
3. Both real accounts return usable transactions.
4. Transactions are stored and re-synced without duplicates.
5. Scheduled imports run while the app is closed.
6. The workload fits the Cloudflare free tier.

**Stop gates:**
- **Gate 1 (end of P1.1):** both accounts return usable transactions.
- **Gate 2 (end of P1.3):** logged-out access is proven blocked.

No real data is deployed before Gate 2 passes.

Status: `[ ]` = not started.

---

## [x] P1.0 Accounts and credentials (owner)

- Start the Lunch Flow trial and connect Revolut Personal UK and BA Amex UK. Bank authentication happens on the banks' own sites.
- Create two Lunch Flow API destinations, `tally-prod` and `tally-dev`, and enable both accounts in each one's **Account Access** tab.
- Create a Cloudflare account and a Zero Trust org (Free plan).
- Run `npx wrangler login` in your own terminal.
- Create `.dev.vars` containing `LUNCHFLOW_API_KEY=<dev key>`.

**Accept when:** both accounts show as connected in the Lunch Flow dashboard and `.dev.vars` exists.

## [x] P1.1 Lunch Flow probe (local script, no deployment)

- `scripts/probe-lunchflow.ts` reads the dev key from the environment and prints **summaries only**:
  - field names and types;
  - counts and date ranges;
  - amount signs;
  - pending count;
  - `total` compared with array length;
  - response time;
  - response header *names*;
  - a sample of about 20 transactions for comparison with the bank apps.
- It finds how far history goes by stepping `from` backwards.
- It captures error shapes using a deliberately invalid key and a nonexistent account id.
- It never prints the key, never dumps full responses, and never writes raw responses to disk.
- Run it again 1–2 days later to check freshness and the pending→posted transition.

**Deliverable:** `docs/lunchflow-findings.md`. It covers every "not documented" item in [research/platform-constraints.md](research/platform-constraints.md).

**Accept when (Gate 1):**
- both accounts return transactions that match the bank apps on date, amount and sign;
- the sign convention is recorded for each account;
- pending support is known for each account.

If either account fails, stop and resolve it with Lunch Flow before building further.

## [x] P1.2 Scaffold

- A single Worker containing Vite + React + TS + Tailwind + TanStack Query and Hono.
- `wrangler.jsonc` sets:
  - `assets` with `not_found_handling: "single-page-application"`;
  - `run_worker_first: ["/api/*"]`;
  - the D1 binding;
  - `observability.enabled: true`;
  - one cron trigger;
  - `preview_urls: false`.
- Tooling: ESLint (including a ban on `dangerouslySetInnerHTML`), `tsc --noEmit`, Vitest with `@cloudflare/vitest-plugin`, and a gitleaks pre-commit hook.
- `.claude/settings.json` gets deny rules for reading `.dev.vars` and `.env*`.

**Accept when:** `npm run dev` serves the page and `/api/health` locally, and the empty build deploys.

## [x] P1.3 Access and auth middleware

- Enable Access on the Worker (Workers & Pages → tally → Access) with scope **All traffic**, the **Cloudflare account** policy and a 7-day session. The dialog offers only "Cloudflare account" and "Email domain", and Email domain would admit a whole domain.
- Hono middleware checks, in order:
  1. `Cf-Access-Jwt-Assertion` is present;
  2. the signature is valid against the team JWKS (cached per isolate);
  3. `aud` equals `ACCESS_AUD`;
  4. `email` equals `ALLOWED_EMAIL`.
  
  Anything else gets 401/403. `POST` requests also have their `Origin` checked.
- Local dev: `access.dev` in `wrangler.jsonc` only simulates `ctx.access`, not the `Cf-Access-Jwt-Assertion` header, so it can't exercise this middleware. Instead, the middleware admits localhost requests when `import.meta.env.DEV` is true. That branch is compiled out of production builds, and `vite.config.ts` refuses to run `vite dev` on a non-loopback host.

**Accept when (Gate 2):**
- Logged out, `curl` on `/`, `/api/health`, `/api/accounts` and `POST /api/import-runs` returns an Access redirect or 403. It never returns JSON.
- Preview/version URLs are disabled or don't serve content.
- Unit tests pass for a missing JWT, a bad signature, a wrong `aud`/issuer, a wrong or missing email and an expired token.
- The local-dev bypass (localhost only, `import.meta.env.DEV`) is absent from the production bundle.
- Login works in iPhone Safari **and** from a Home Screen shortcut in standalone mode.

## [x] P1.4 Schema and migrations

- Drizzle schema as in [schema-and-api.md](schema-and-api.md).
- Generate migrations with `drizzle-kit generate` and apply them with `wrangler d1 migrations apply` locally and then remotely.

**Accept when:** migrations apply cleanly to both databases and `drizzle-kit check` passes.

## [x] P1.5 Importer (the core)

**Client**
- Responses are validated with `zod`. An invalid response is an error for that account and results in **no writes**.
- 20 s timeout (`AbortSignal.timeout`).
- Up to 2 retries on network errors, 429 and 5xx, with backoff and `Retry-After` capped at 10 s.
- No retries on 401/403/404; these are flagged as configuration or reconnection errors.

**Normalisation**
- Decimal-to-minor-unit conversion uses each currency's exponent (GBP = 2). Values with more decimal places than the currency allows are flagged.
- Amounts are stored as **negative = money out / more owed**, which P1.1 found both institutions already use, so no per-account sign flip is applied. The original decimal is kept in `provider_amount`.
- `date` is stored as a plain calendar string and never passed through `Date`, to avoid UTC shift bugs.
- "Today" is computed in `Europe/London`.

**Import windows**
- **Incremental:** the last 14 days, re-read on every run to catch late postings and pending→posted changes.
- **Backfill:** bounded 31-day chunks, a maximum of 2 per account per run, with a cursor per account, going back to `BACKFILL_DAYS` (default 90; raise it if P1.1 shows more history).

**Writes**
- Upsert with `json_each` into `UNIQUE(account_id, provider_txn_id)`. Only bank fields that actually changed are updated.
- **Nothing is ever deleted.**
- A pending transaction missing from a *successful* `include_pending=true` window that covers its date gets `vanished_at` set. This is cleared if it reappears.
- Posted transactions that go missing are only counted in the run stats; no action is taken.

**Runs**
- An `import_lock` lease of 10 min, released in `finally`.
- One account failing doesn't stop the other.
- Per-account status is written for every run.
- Logs record counts, statuses and durations only. There are no response bodies or headers, and error text is truncated and sanitised.
- Budget per run: about 5 subrequests and fewer than 40 D1 statements, enforced by a counter in a D1 wrapper.

**Tests (synthetic fixtures only)**
- Importing the same response twice gives 0 inserts and 0 updates the second time.
- A changed amount gives exactly 1 update.
- A partial response deletes nothing.
- A vanished pending transaction is marked, not deleted, and is cleared if it reappears.
- A second run started during a first run is `skipped_locked`.
- A 5xx retries, then records the error while existing rows stay intact.
- A 401 does not retry and sets the account's error.
- Money: `12.3`, `-0.01`, `1234.56`, `0.1 + 0.2`-style values, and 3-decimal input (flagged).
- Dates: a transaction around midnight at a BST/GMT changeover keeps its calendar date.
- The D1 statement count per run stays below 40.

**Accept when:** all tests pass, and a local import against the dev key imports both accounts twice with no duplicates.

## [ ] P1.6 API and minimal UI

- Endpoints as in [schema-and-api.md](schema-and-api.md).
- One screen, with no design polish:
  - account cards showing name, institution, provider status, last successful import, last error and newest transaction date;
  - an **"Import from Lunch Flow"** button;
  - the last 10 import runs;
  - the latest 100 transactions, filterable by account.

**Accept when:** a manual import (`POST /api/import-runs`) from the iPhone updates the cards and the list, and a second tap within 60 s gets a friendly 429.

## [ ] P1.7 Scheduled imports

- Test locally with `wrangler dev --test-scheduled` (`/__scheduled`).
- Deploy with an hourly cron.

**Accept when:**
- `import_runs` shows `trigger='cron'` rows at the expected times for **at least 48 hours** with the app closed;
- no overlapping runs;
- zero duplicates by `(account_id, provider_txn_id)`;
- the fingerprint-duplicate query has been reviewed.

## [ ] P1.8 Free-tier measurement

- `scripts/usage-report.ts` queries the Cloudflare GraphQL Analytics API using a **read-only Account Analytics token**. It reports:
  - Worker CPU time P50/P99/max, split by cron and HTTP;
  - errors, including any exceeded-CPU errors;
  - D1 rows read and written per day.

**Accept when:**
- import P99 CPU is under 7 ms (30% headroom under 10 ms);
- the heaviest backfill run is under 10 ms;
- daily D1 writes are under 5% of the allowance.

If CPU is too high, reduce the chunk size. Moving to a paid plan needs discussion first.

## [ ] P1.9 Verification and assessment

- Check about 20 imported transactions per account against the Revolut and Amex apps: amount, sign, date, merchant and pending state.
- Write `docs/phase1-assessment.md` covering:
  - connection quality;
  - how stale data gets (bank → Lunch Flow → Tally), measured rather than assumed: during the hourly P1.7 window, note the time of a few real purchases on each account and compare with `transactions.first_seen_at` (when the importer first saw it) and when it later posts. Resolution is about an hour; a purchase that takes more than a few hours to appear is the signal for the Phase 2 go/no-go;
  - missing fields;
  - pending behaviour and ID stability;
  - how reconnection shows up;
  - free-tier headroom;
  - blockers;
  - a **go/no-go for Phase 2**.
- Change the cron to every 6 hours.

**Accept when:** the assessment is written and reviewed by the owner.
