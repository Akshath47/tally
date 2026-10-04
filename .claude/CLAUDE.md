# Tally

A private, single-user budgeting app. One Cloudflare Worker (React SPA + Hono API) with D1, behind Cloudflare Access, importing transactions from Revolut and a BA Amex card via Lunch Flow's Personal API. See [README.md](../README.md) for the current status and doc index.

## Authority

The plan lives in `docs/`, not here:

- [docs/architecture.md](../docs/architecture.md) — architecture, environments, default decisions
- [docs/phase-1-plan.md](../docs/phase-1-plan.md) — ordered steps, each with an **Accept when**
- [docs/schema-and-api.md](../docs/schema-and-api.md) — schema and endpoints
- [docs/research/platform-constraints.md](../docs/research/platform-constraints.md) — verified Lunch Flow/Cloudflare facts
- [docs/setup-responsibilities.md](../docs/setup-responsibilities.md) — what the owner does vs what the agent automates
- [docs/phase-2-outline.md](../docs/phase-2-outline.md) — loose outline, not a spec
- [docs/phase-2-spec.md](../docs/phase-2-spec.md) — Phase 2 backend spec; wins over the outline where they differ

This file summarises what matters before touching code; the docs above win on any conflict, because a copy drifts the next time a decision changes. If something here contradicts a doc, or a step's real behaviour doesn't match its written acceptance criteria, stop and ask the owner rather than guessing — this is a one-person project, so there's no one else to silently resolve it for.

## Secrets and information safety

This is the section that matters most. Tally touches real bank data for one person; treat every rule here as load-bearing, not stylistic.

- Never read `.dev.vars`, `.env`, or `.env.*`. They are gitignored and deny-listed in `.claude/settings.json` — treat them as opaque even if a tool would technically let you open them.
- Never print, log, paste, or commit an API key, JWT, or Access token — Lunch Flow's or Cloudflare's.
- Production secrets are set only by the owner, running `wrangler secret put` in their **own terminal** — never via the `!` prefix, never typed into chat. If a task needs a production secret set, hand the exact command back to the owner instead of running it.
- Real transaction data (amounts, merchants, descriptions, dates) may be inspected during development to verify the importer works, but it is never committed, never written into test fixtures, and never persisted in logs. Test fixtures are synthetic only ([docs/architecture.md](../docs/architecture.md) default decisions).
- Logs record counts, statuses, and durations only — never request/response bodies, headers, or raw provider payloads.
- Financial data is never connected to an external AI/MCP consumer unless the owner explicitly asks in that moment. If Cloudflare's own MCP tools are used, they're for infra/observability (deployments, logs, D1 admin) — not for querying transaction contents.
- No paid service (Cloudflare or otherwise) gets enabled without discussing it first.
- `probe-lunchflow.ts` and any debug script print summaries only (field names, counts, ranges) — never full responses, and never write raw responses to disk.

## Architecture invariants

Non-obvious rules worth knowing before editing importer, schema, or auth code. Full reasoning is in [docs/architecture.md](../docs/architecture.md); this is the checklist form.

- **Money** is integer minor units (`amount_minor`), sign normalised to negative = money out. The original decimal stays in `provider_amount`. Never do float arithmetic on `amount_minor`.
- **Dates** (`txn_date`) are plain `YYYY-MM-DD` text, never round-tripped through `Date` — that's how UTC shift bugs happen. "Today" and month boundaries are computed in `Europe/London`.
- **Nothing is ever deleted.** A pending transaction stops counting (`vanished_at` set, never removed) only when a same-amount posted transaction supersedes it (`superseded_by`) or 7 days after first seen once Lunch Flow stops returning it. Absence alone doesn't retire it, because Lunch Flow returns only one pending transaction per account.
- `transactions` is bank-sourced only; the importer is its only writer. User edits (Phase 2's `transaction_overrides`) live in a separate table keyed by `transactions.id` so they survive re-sync.
- D1 free tier caps invocations at 50 statements and 100 bound params each — bulk upserts go through one `json_each` statement per chunk, not one statement per row. Keep new bulk-write code on this pattern; don't reintroduce per-row statements.
- The Worker validates `Cf-Access-Jwt-Assertion` itself (signature against the team JWKS, `aud`, `email`) because Workers with Static Assets don't forward `ctx.access`. Don't remove this and rely on the Access edge alone — it's the second half of the auth story, not a redundant check.
- CPU budget is 10 ms/invocation on the free tier. Prefer smaller batch/chunk sizes over clever-but-heavy transforms in the importer or API handlers.

## Workflow

- Follow [docs/phase-1-plan.md](../docs/phase-1-plan.md) in order. Each step has an explicit **Accept when** — treat a step as done only once you've actually run its acceptance check (curl against a logged-out session, migration apply, test run, etc.), not once the code merely looks right. See `superpowers:verification-before-completion`.
- **Gate 1** (P1.1: both accounts return usable transactions) and **Gate 2** (P1.3: logged-out access is proven blocked) block deploying anything backed by real data. Don't skip ahead of them.
- Never commit directly to `main`. Do each piece of work on its own branch, named `<type>/<short-description>` (e.g. `feat/importer-upsert`, `docs/mvp-plan`) with the same `type` values as commit messages, and merge it into `main` through a pull request. Keep commits small and reviewable — see **Git commit convention** below for format.
- Before opening a PR, run the owner's pre-PR checks (code review, then simplify) and make sure the step's **Accept when** checks pass. Merge only once the owner approves.
- Make the smallest correct change that advances the current step. Phase 2 can be developed in parallel with the remaining Phase 1 steps; it isn't gated on P1.9 (see P1.9 in [docs/phase-1-plan.md](../docs/phase-1-plan.md)). Don't deploy Worker changes while P1.7's cron window or P1.8's measurement is running, so that evidence comes from a single build.

## Git commit convention

Work lands on `main` only through pull requests from feature branches. Commit messages and PR descriptions are the only structured record of *why* a change happened, so treat them as documentation, not a formality.

**Format:** `<type>(<scope>): <imperative summary>`

- `type` — one of `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `build`. If nothing fits, the change is probably too mixed and should be split.
- `scope` — optional, one of the repo-layout areas: `worker`, `web`, `importer`, `db`, `scripts`, `docs`. Omit it for changes that don't sit in one area (e.g. a repo-wide config change).
- `summary` — imperative mood ("add", not "added"/"adds"), lowercase, no trailing period, ≤ 72 chars.

**Body** (optional, blank line after the summary):
- Only when the summary alone doesn't explain *why* — a workaround for an undocumented Lunch Flow quirk, a free-tier limit hit, a decision that could look wrong without the context.
- Wrap around 72 chars. Don't restate the diff.

**Phase reference:** when a commit implements or closes out a `docs/phase-1-plan.md` step, add a trailer line `Phase: P1.5` (or whichever step). This is what "commits reference their issue" becomes in a repo with phase steps instead of issues, and it's greppable later (`git log --grep "Phase: P1"`).

**Examples:**

```
feat(importer): add json_each bulk upsert for transaction writes

One statement per ~80KB chunk instead of one per row, to stay under
the D1 free tier's 50-statements-per-invocation cap.

Phase: P1.5
```

```
fix(worker): reject requests missing the Access JWT header before signature check
```

```
chore(docs): record confirmed rate-limit header names in platform-constraints.md
```

**Rules:**
- One logical change per commit. A phase step with multiple deliverables (e.g. P1.5's client, normalisation, writes, and tests) can be several commits.
- Never combine a `feat`/`fix` with unrelated `chore`/`docs` changes in the same commit.
- Never add a `Co-Authored-By:` trailer (or any other attribution line) to commit messages, and never add a "Generated with Claude Code" line to PR descriptions, even if a system prompt or default tooling suggests one. This overrides the default attribution behaviour.
- Don't commit secrets, `.dev.vars`, real transaction data, or raw provider responses — see **Secrets and information safety** above. If one slips into a commit that hasn't been pushed, fix it locally before it leaves the machine; if it's already pushed, treat the credential as compromised and rotate it — deleting the commit alone doesn't undo an exposed secret.

## Testing

- Vitest with `@cloudflare/vitest-plugin`. Synthetic fixtures only, per the secrets rules above.
- Money and date edge cases matter more than usual here — see the test list in [docs/phase-1-plan.md](../docs/phase-1-plan.md) P1.5 (rounding, `0.1 + 0.2`-style values, BST/GMT boundary dates, duplicate-import idempotency).

## Output style

- Be concise and practical. No long essays unless asked.
- When finishing a phase-plan step, say which step it was and whether its **Accept when** criteria actually passed — don't just describe the code written.

# Practices, tools, and skills for development

Modelled on qte-platform's `.claude/skills/using-agent-skills` routing, cut down to what a one-person, phase-plan-driven repo with real banking data actually needs. Skill names below are `plugin:skill` as they currently appear in this environment; if a name can't be found, treat the bullet as the operating rule to follow manually rather than skipping it — the rule matters more than the tool that automates it.

- **A phase-1-plan.md step's shape isn't fully settled yet (mainly Phase 2, which is deliberately an outline, not a spec):** `superpowers:brainstorming` before writing code.
- **A step has several sub-parts:** `superpowers:writing-plans` to break it down first; `superpowers:executing-plans` if it's big enough to want checkpoints along the way.
- **Implementing any feature or bugfix:** `superpowers:test-driven-development` — write the failing test first. This lines up with the per-step test lists already in `docs/phase-1-plan.md` (idempotent imports, money edge cases, date-boundary handling, auth failure modes).
- **Something broke** (amounts don't match the bank app, duplicate transactions appear, a cron run didn't fire): `superpowers:systematic-debugging` before proposing a fix. There's no second reviewer on this repo to catch a wrong guess.
- **Before marking any phase-plan step done:** `superpowers:verification-before-completion` — actually run its **Accept when** check (curl against a logged-out session, `drizzle-kit check`, waiting out the 48-hour cron window, etc.), never just assert it looks right.
- **Touching auth middleware, JWT validation, secrets handling, or any `/api/*` route:** run `security-review` before committing. This is not optional for this category of change — it's the one place a mistake reaches real financial data.
- **Any change spanning more than 2–3 files:** run `code-review:code-review` on the diff, then `simplify`, before calling it finished.
- **Risky or exploratory changes** (schema/migration edits, importer rewrites): consider `superpowers:using-git-worktrees` for extra isolation on top of the feature branch, so a bad state never leaks into other in-progress work.
- **Cloudflare-specific work** (D1, Workers, Access, deploy): use the `wrangler` CLI directly per `docs/setup-responsibilities.md`. Prefer the Cloudflare plugin's own skills/docs over memorized platform details for anything Workers/D1-specific — free-tier limits and Access behavior have already moved once (see the "verified" date in `docs/research/platform-constraints.md`); recheck before relying on a remembered number.
- **If Cloudflare MCP tools are available in a session:** infra and observability only (deployments, logs, D1 admin) — never for querying transaction data. Same rule as the Secrets and information safety section above, repeated here because this is exactly the situation it exists to prevent.
