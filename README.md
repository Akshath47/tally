# Tally

A private, mobile-first personal budgeting app. It combines transactions from a Revolut Personal UK account and a British Airways American Express UK card, which reach it through Lunch Flow's Personal REST API. Spending is tracked against configurable monthly budgets.

Only one person uses it. It runs on a single Cloudflare Worker (React SPA + Hono API) with D1, behind Cloudflare Access.

**Status:** Phase 1 is done: the importer, a minimal UI and 3-hourly scheduled imports are deployed behind Cloudflare Access ([docs/phase1-assessment.md](docs/phase1-assessment.md)). Phase 2, budgeting, is next.

## Plan

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Architecture, environments, repo layout, default decisions |
| [docs/research/platform-constraints.md](docs/research/platform-constraints.md) | Verified Lunch Flow API facts, open questions, Cloudflare free-tier limits (with sources) |
| [docs/phase-1-plan.md](docs/phase-1-plan.md) | Ordered Phase 1 steps with deliverables and acceptance criteria |
| [docs/schema-and-api.md](docs/schema-and-api.md) | Minimal Phase 1 D1 schema and API endpoints |
| [docs/setup-responsibilities.md](docs/setup-responsibilities.md) | What the owner does personally vs what the agent automates |
| [docs/estimates-and-risks.md](docs/estimates-and-risks.md) | Time estimate and main uncertainties |
| [docs/lunchflow-findings.md](docs/lunchflow-findings.md) | Observed Lunch Flow API behaviour for the owner's accounts (P1.1) |
| [docs/phase1-assessment.md](docs/phase1-assessment.md) | End-of-Phase-1 assessment: freshness, pending behaviour, what Phase 2 must allow for (P1.9) |
| [docs/phase-2-outline.md](docs/phase-2-outline.md) | Phase 2 outline, kept loose so the product can evolve |

## Repository layout

```
wrangler.jsonc  drizzle.config.ts      (created in P1.2)
migrations/                            Drizzle-generated D1 migrations
src/worker/index.ts                    Hono app + scheduled() handler
src/worker/auth.ts                     Cloudflare Access JWT middleware
src/worker/routes/                     /api/* route handlers
src/worker/db/schema.ts                Drizzle schema
src/worker/importer/                   client, normalize, upsert, lock, run
src/web/                               React SPA
scripts/probe-lunchflow.ts             P1.1 API probe (prints summaries only)
scripts/cron-report.sql                P1.7 cron, overlap and duplicate checks (no text)
scripts/usage-report.ts                P1.8 free-tier usage report
scripts/check-terminations.ts          Lists runs Cloudflare stopped or imports that didn't finish
test/                                  Vitest (workers pool), synthetic fixtures only
docs/                                  Plan, findings, assessments
```

## Secrets

- `.dev.vars` (local Lunch Flow dev key) is gitignored and must never be read by agents or tools.
- The production key lives only in `wrangler secret`.
- Never commit, paste or log credentials.
