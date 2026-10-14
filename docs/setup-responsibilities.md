# Setup: owner vs agent

## Owner actions (credentials never go into chat, logs or git)

1. **Lunch Flow**
   - Start the trial and connect Revolut and BA Amex. Bank auth happens on the banks' own sites.
   - Create the `tally-prod` and `tally-dev` API destinations and set **Account Access** on each.
2. **Cloudflare**
   - Create an account and a Zero Trust org on the Free plan. The onboarding may ask for a payment method even at $0; this hasn't been verified.
3. Run `npx wrangler login` in your own terminal.
4. **Local dev values:** put `LUNCHFLOW_API_KEY=<dev key>`, `ALLOWED_EMAIL`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `.dev.vars`.
   - The agent may create the file with the variable names only.
   - The agent never reads it.
5. **Production secrets:** run `npx wrangler secret put <NAME>` for each name under `secrets.required` in `wrangler.jsonc`, in your **own terminal**, not with the `!` prefix, so the value never reaches the agent session. `wrangler deploy` fails while one is missing.
6. **Access** (done 2026-09-30)
   - Enabled Access on the `tally` Worker with scope All traffic, the **Cloudflare account** policy and a 7-day session.
   - The Access AUD tag and the team domain (from the login redirect) aren't secret, but they're Worker secrets rather than `wrangler.jsonc` vars so the public repo doesn't name the login page.
   - Recommended: turn on 2FA for the Cloudflare account.
7. **Analytics token:** create a scoped **Account Analytics: Read** API token for `scripts/usage-report.ts`. Add `export CLOUDFLARE_ANALYTICS_TOKEN=...` and `export CLOUDFLARE_ACCOUNT_ID=...` to your shell profile (`~/.zshrc`) yourself, never via chat. The account id isn't secret (`wrangler whoami`).
8. **Verification**
   - Compare the sample transactions with the Revolut and Amex apps.
   - Log in on the iPhone in Safari and from a Home Screen shortcut.

## Agent automates

- Repo scaffold, `wrangler.jsonc`, lint, typecheck and test setup, and `.claude/settings.json` deny rules.
- `wrangler d1 create`, Drizzle schema, and migration generation and application.
- `scripts/probe-lunchflow.ts` and `docs/lunchflow-findings.md`.
- Importer, API, minimal UI and tests.
- `wrangler deploy`.
- Logged-out `curl` access checks.
- Cron verification queries.
- `scripts/usage-report.ts` and the free-tier report.
- `docs/phase1-assessment.md`.

## Guardrails

- The agent may inspect real transaction descriptions, dates and amounts during development.
- Real transactions are never committed. Test fixtures are synthetic.
- Financial data is never connected to an AI/MCP consumer unless the owner explicitly asks. Cloudflare MCP, if used, is for infrastructure and observability only.
- No paid Cloudflare services are enabled without discussing it first.
