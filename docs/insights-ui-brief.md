# Insights UI brief

What the new screens need to show, for the owner's design agent. It covers the Insights tab, Monthly review, Trends, Merchant and the weekly digest email. It says **what** each screen contains, what each element opens, and every state. Layout, hierarchy and charts are left to the design.

The data and rules behind every figure are in [phase-2-insights-spec.md](phase-2-insights-spec.md). The existing screens and visual system are in [ui-design.md](ui-design.md), and the new screens follow it. All names, amounts and dates below are invented.

## Context in one paragraph

Tally is a single-user, dark-mode, mobile-first budgeting PWA (iPhone, 390 × 844 first). It tracks one monthly budget allocated to categories, with the rest as Misc. Home answers "how much is left", Transactions lists everything, and Budget sets the figures. The new **Insights** tab answers "how is this week going, what should I watch, and how do months compare". The owner opens Tally for a daily glance, a weekly tidy-up and a monthly review.

## Visual system (unchanged)

Use [ui-design.md](ui-design.md) as is: dark only, charcoal and sage, thin large numerals, 18 px card radius, 44 px touch targets, thin line icons, no emoji. The tokens that matter most here:

| Token | Hex | Use here |
|---|---|---|
| `bg` / `surface` / `raised` | `#141516` / `#1D1F20` / `#242628` | Screen, cards, inputs |
| `text` / `muted` | `#E6E7E9` / `#8F9498` | Primary and secondary text |
| `accent` / `accent-text` | `#8FA89A` / `#A9C0B3` | This month's bars, links, on-track, "down" changes |
| `warn` / `warn-text` / `warn-tint` | `#C9A26A` / `#D8B47F` / `#2C261C` | Projected over, running high, stale data, "up" changes |
| `over` / `over-text` / `over-tint` | `#C7837B` / `#D6968E` / `#2E2120` | Over budget |
| `line` | `#2B2E30` | Chart tracks, the previous month's bars (grey) |

Pending spend is drawn **hatched** everywhere, as on Home. Any figure that includes pending reads "at least £…" or carries a short note, because pending charges can arrive late.

**Money and dates:** `£1,003` for budget-scale figures, `£18.88` for single transactions, `−£11.36` in feeds. Dates are `Thu 15 Oct` or `15 Oct`, and the year only appears outside the current year.

## Navigation change

- **Four tabs: Home, Transactions, Insights, Budget.** Insights gets a thin line icon (e.g. a small chart or spark).
- Optional, the designer's call: a small dot on the Insights tab when there's an over or warn insight.
- New pushed screens (back link, no tab bar): **Monthly review**, **Trends**, **Merchant**.
- Merchant can also be opened from outside the tab: the transaction editor and the pending sheet get a quiet "All from <merchant>" link.

## Screen 1: Insights (tab root)

The weekly glance. From top to bottom, in this order unless the design argues otherwise:

### Header
- Title "Insights" and the same freshness line as Home ("Updated 3h ago · both accounts"). It goes amber when an account is stale.

### "This week" card
The same content as the Sunday email, live.

- Week range: "Mon 12 – Sun 18 Oct · so far".
- **Spent this week**, large ("£230"). Reads "at least" when pending is included. If the week crosses into a new month, a small note: "Includes 2 days of September".
- Month line: "£1,003 of £1,440 this month · £437 left · £191/week for the rest of October".
- Category status: only the flagged categories, each with its name, "£spent / £allocated" and a flag: **Over** (brick, "↑ £10 over"), **On course to go over** (amber, "on course for £40 over"), **Near limit** (amber, "£11 left"). When nothing's flagged: "All categories on track".
- "11 to sort" chip when the count is above 0. It opens To sort.
- A small footer line: "Weekly email · last sent Sun 11 Oct, 18:00". Failed state: "Last Sunday's email didn't send", with a "Send now" text button. Never sent yet: "Weekly email goes out Sundays at 18:00".

### Insights list
One card or row per insight, ranked by the server. Each has a tone (brick, amber or neutral), a one-line headline, one supporting line, and a tap target. All of them are shown, usually 0–8.

| Type | Tone | Headline / supporting line (example) | Tap opens |
|---|---|---|---|
| Stale account | amber | "Amex hasn't updated for 5 days" / "Recent card spending may be missing." | Accounts |
| Over budget (category) | brick | "Eating out is £24 over" / "£184 of £160 this month" | That category's transactions for the month |
| Over budget (overall) | brick | "£90 over this month's budget" / "£1,530 of £1,440" | Home |
| On course to go over (category) | amber | "Eating out is on course to end £40 over" / "£96 by the 12th, £160 allocated" | That category's transactions |
| On course to go over (overall) | amber | "On course to end the month £120 over" / "£760 by the 16th, £1,440 budget" | Home |
| Running high | amber | "Groceries is running high" / "£210 so far, usually about £120 by the 16th" | That category's transactions |
| Large charge | neutral | "£240 at Halden Audio" / "New merchant · Tue 13 Oct" or "About 4× your usual £58 there" | The transaction (editor, or pending sheet if pending). A secondary link opens the Merchant screen. |
| Month change | neutral, with an up arrow (amber) or down arrow (sage) | "Transport up £45 in September" / "£132, from £87 in August" | Monthly review for that month |

Notes for the design:
- Projections and "running high" only appear from the 8th of the month, and month changes only in the first 7 days. So the list is naturally short early in the month.
- The headline wording above is the target copy. The app and the email share it.

### Entry rows
- "**September review** · compared with August" opens Monthly review for the last completed month.
- "**Trends** · last 6 months" opens Trends.

### States
- **Nothing stands out:** a calm empty state in place of the list, e.g. "Nothing stands out this month". This week and the entries still show.
- **Early in the month (before the 8th), nothing to show:** "Projections start on the 8th, once there's enough of the month to go on."
- **Not enough history (first month of data):** no review entry; Trends still opens; a note that comparisons start once there's a full previous month.
- **No budget set:** This week shows spend only, with no "left" or pace and no category status, plus a link to Budget.
- **Loading:** skeletons for the This week card and 3 list rows. The shimmer respects reduced motion.
- **Error:** "Tally couldn't load insights", reassurance that nothing changed, and "Try again". Same pattern as Home.

## Screen 2: Monthly review (pushed)

Already sketched in ui-design.md ("Monthly review"). This firms up what it holds. Completed months only.

- Back link "‹ Insights". Title "September review", subtitle "Compared with August".
- Month stepper ‹ ›: steps through completed months. › is disabled on the last completed month, and ‹ on the first month of history.
- **Two tiles:** this month's spend against its budget ("£1,380 of £1,440 · £60 under") and last month's ("£1,512 of £1,440 · £72 over"). Without a budget that month, a tile shows spend only, with "No budget".
- **Per category** (budgeted categories, uncategorised, then tracked, with tracked clearly marked as not in the total):
  - paired bars: this month (sage) and last month (grey)
  - this month's amount, and the change: "+£45" in amber when up, "−£20" in sage when down, nothing when unchanged
  - an over-budget flag when the category went over its allocation
  - tap opens that category's transactions for the month (the existing Category transactions screen)
- **Tracked line:** "Tracked · not in the total: £180 (August £95)".
- **Top 5 merchants:** name, spend, "6 visits". Tap opens Merchant.

States:
- **No previous month** (first month of history): tiles and bars show this month only, with no changes; note "Nothing to compare with yet".
- Loading and error, as on Insights.

## Screen 3: Trends (pushed)

Six months: the current month and the 5 before.

- Back link "‹ Insights". Title "Trends", subtitle "Last 6 months".
- **Total chart:** budget spend per month, with each month's budget marked where one exists. The current month is visibly **partial** (e.g. "so far", hatched pending). Tracked spend is optional and secondary, and never stacked into the total.
- **Average:** "Average £1,410 / month", over completed months only.
- **Per category:** one row or small chart per spending category with spend in the window. Each shows its 6-month shape, this month so far, and its average ("Eating out · avg £165"). Tap opens that category's transactions for the selected month, or for the current month if none is selected.
- **Tapping a month** in the total chart opens that month on Home (`/months/:month`), or the current Home for the current month.

States:
- **Months before history starts:** drawn as empty ("no data"), never as £0.
- **Only the current month has data:** the chart still shows; average reads "Average after your first full month".
- Loading and error.

## Screen 4: Merchant (pushed)

One merchant across both accounts.

- Back link to wherever it came from. The merchant's initial tile and name (untrusted text, truncate long names).
- **Category:** the rule's category as a tag ("Eating out · rule"), or "No rule · goes to To sort". Tap opens Merchant rules.
- **Account badges** (Revolut, Amex) and "First seen 3 Mar".
- **6-month history:** spend per month, aligned with Trends, with visits ("4 visits") per month.
- **Summary figures:** "£412 in 6 months · 23 visits · £17.91 average".
- **Recent:** the last 20 transactions, same rows as Transactions (pending, edited and excluded markers included). A row opens the editor, or the pending sheet if pending.

States:
- **One visit only:** history and summary still show, with "First visit" instead of the average.
- **Not found** (e.g. a stale link): "No transactions from this merchant" and a back link.
- Loading and error.

## Existing screens now backed by data

These states are already designed in ui-design.md. They only need checking against the final threshold:

- **Home, stale data:** amber dot and banner ("Amex hasn't updated for 4 days, so recent card spending may be missing."). This shows from **4 days** without new data.
- **Accounts, stale account:** amber border and warning box, from 4 days.
- **Transaction editor and pending sheet:** add the "All from <merchant>" link (above).

## The weekly email

Sent Sundays at 18:00 to the owner only. It's designed as a simple HTML email that also reads well as plain text.

- **Constraints:** single column, max about 600 px wide, inline styles only, no images, no web fonts, no remote content. It must read in both light and dark mail clients, so don't rely on the app's dark background. The subject has **no figures**.
- **Subject:** "Your week in Tally · 12–18 Oct".
- **Body, in order:**
  1. "This week: £230 spent" (with "at least" if pending), and the cross-month note if it applies.
  2. "October so far: £1,003 of £1,440 · £437 left · £191/week for the rest of the month".
  3. Category status: every allocated category plus Misc, with spent / allocated and a word flag (Over, On course to go over, Near limit, On track). Colour may support the flags but must never be the only signal.
  4. Insights: the same headlines and supporting lines as the app, top 5, with "and 2 more in Tally" if there are more.
  5. "11 transactions to sort", if any. Stale-account warnings, if any.
  6. The data freshness line ("Data last changed Sun 18 Oct, 15:00") and an "Open Tally" link.
- **Plain-text version:** the same content as short lines, no tables.
