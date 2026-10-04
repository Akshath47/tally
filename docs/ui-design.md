# Mobile UI design spec

The agreed design for Tally's Phase 2 screens, from a design session with the owner on 2026-10-04. The canvas with every screen and state is a private artifact: <https://claude.ai/artifact/NtWiFpP439EPM98ryVMVE3>. This doc is the written record of it, so the build doesn't depend on the canvas staying around.

[phase-2-spec.md](phase-2-spec.md) stays the authority on data, budgeting rules and the API. This doc covers what the screens show and how they behave. Where the design asks for something the spec doesn't do yet, it's listed under [Differences from the backend spec](#differences-from-the-backend-spec) for the owner to settle.

All amounts, merchants and dates below and on the canvas are invented.

## Target

- iPhone home-screen PWA, standalone display. Designed at 390 × 844 first.
- React 19 + Tailwind CSS v4.
- **Dark mode only.** No light theme, no `prefers-color-scheme` switch.
- Leave room for the top safe area (about 52 px above the screen title) and the home indicator (about 30 px under the tab bar). Don't draw a fake status bar.

## Visual style

Charcoal and sage, low saturation, nothing neon. Big numbers are thin; small text stays at regular weight so it reads on a dark background.

### Colour tokens

| Token | Hex | Use |
|---|---|---|
| `bg` | `#141516` | Screen background |
| `surface` | `#1D1F20` | Cards, grouped lists |
| `raised` | `#242628` | Inputs, secondary buttons |
| `sheet` | `#17181A` | Bottom-sheet background |
| `line` | `#2B2E30` | Progress tracks, input borders |
| `divider` | `#26292B` | Card borders, row dividers |
| `text` | `#E6E7E9` | Primary text |
| `muted` | `#8F9498` | Secondary text, labels |
| `muted-2` | `#7E8388` | Inactive tab labels |
| `accent` | `#8FA89A` | Sage: on-track bars, ring, primary buttons, focus ring |
| `accent-text` | `#A9C0B3` | Links and active tab on dark |
| `accent-tint` | `#222A26` | Suggested chip, selected state, "Edited" tag |
| `on-accent` | `#121513` | Text on sage buttons |
| `warn` | `#C9A26A` | Near limit, stale data |
| `warn-text` / `warn-tint` | `#D8B47F` / `#2C261C` | Near-limit flag |
| `over` | `#C7837B` | Over budget, errors, destructive actions |
| `over-text` / `over-tint` | `#D6968E` / `#2E2120` | Over flag, error text |
| `acct-rev` | `#2E3133` bg, `#D5D7DA` text | Revolut badge |
| `acct-amex` | `#24303A` bg, `#A8BACB` text | Amex badge |

Warning colours are the same everywhere, so "near limit" and "over" always look the same. State is never shown by colour alone: there's always a text flag ("£14 left", "£12 over") as well.

Pending amounts use a diagonal hatch of the bar colour, e.g. `repeating-linear-gradient(135deg, #8FA89A 0 2px, #3A4540 2px 5px)`.

### Type

[Manrope](https://fonts.google.com/specimen/Manrope) from Google Fonts, weights 200–600. Amounts use tabular figures (`font-variant-numeric: tabular-nums`).

| Role | Weight | Size |
|---|---|---|
| Headline amount (ring centre) | 200 | 44–46 px |
| Screen title | 300 | 30 px |
| Sheet amount | 200 | 28 px |
| Emphasis (merchant, section heading) | 500 | 16 px |
| Body, list rows | 400 | 14.5 px |
| Meta (freshness, dates, hints) | 400 | 12–12.5 px, `muted` |
| Uppercase section labels | 500 | 11.5 px, 0.08em tracking |

### Shape and controls

- Card radius 18 px, inputs 10–11 px, buttons 12–14 px, chips fully rounded.
- Donut ring: 9 px stroke on a 200 px ring. Category bars: 4 px.
- Touch targets at least 44 px. Category chips are 44 px tall.
- Icons: thin stroke (1.5 px) line icons, no emoji.
- Real `<button>`, `<a>`, `<input>` and `<label>` elements; icon-only buttons get an `aria-label`.

### Money and dates

- Show money as `£1,254` for budget figures and `£23.60` for transactions. Money out shows as `−£14.20` in feeds; income and refunds as `+£…`.
- Short dates in the UI: `Thu 15 Oct`, `15 Oct`.
- These are display rules only. Storage stays as in [architecture.md](architecture.md) (integer minor units, `YYYY-MM-DD` text).

## Navigation

- **Three tabs: Home, Transactions, Budget.** No Inbox tab.
- **"To sort" is reachable only from Home.** Home shows an "11 to sort" chip (count of uncategorised posted transactions) next to the settings icon. The chip appears only when the count is above zero. With nothing to sort there's no chip and no way into the screen.
- Pushed screens (back link, no tab bar): To sort, Categories, Merchant rules, Accounts, New account found, Monthly review.
- Home's settings icon goes to Categories. The freshness line goes to Accounts. "September review" goes to Monthly review.
- The transaction editor and the pending view are bottom sheets over Transactions.

## Screens

### Home

The five-second glance.

- Header: month name, freshness line ("Updated 3h ago · both accounts", sage dot), "to sort" chip when needed, settings icon.
- Hollow donut of the month's budget. Solid sage = posted spend, hatched = pending. Centre: "Spent in October", the **spent** amount large, "£546 left this month", "of £1,800".
- Pace line under the ring: "£239/week for the remaining 2.3 weeks".
- Two pills: "Posted £1,166" and "Pending £88 · 3 charges" (taps to Transactions).
- Categories card: one row per budgeted category plus Misc, each "£spent / £allocated" with a bar. Pending spend is hatched inside the bar. Near limit gets an amber "£14 left" flag; over gets a brick "↑ £12 over" flag and a full brick bar. Misc is labelled "unallocated".

States:
- **Over budget overall:** ring fully brick, "£112 over this month" in `over-text`, pace line replaced with "Budget used up with 5 days to go…".
- **Stale data:** amber dot on the freshness line, which names each account ("Revolut 2h ago · Amex 4 days ago"), and an amber banner: "Amex hasn't updated for 4 days, so recent card spending may be missing." with a link to Accounts.
- **No pending:** "No pending charges" in place of the pills.
- **Loading:** skeletons for the ring centre, pills and category rows, with "Loading your budget…" in the freshness line. The shimmer stops under `prefers-reduced-motion`.
- **Error:** "Tally couldn't load your budget", reassurance that nothing changed, a "Try again" button, a link to account status and a small error code and time. The freshness line turns brick: "Couldn't refresh · last loaded …".
- **First run (no budget yet):** "Welcome to Tally / Set your budget", a confirmation that both accounts are connected and how many transactions were imported, an empty dashed ring, a single "How much do you want to spend each month?" input with last two months' spend for reference, a "Set budget" button, and a 3-step checklist (set budget, allocate, sort).

### To sort

The weekly tidy-up, opened from the Home chip.

- Back link "‹ Home", title "To sort", count ("11 to sort · 5 merchants") and freshness line.
- Toggle: **By merchant** (default) / **By date**.
- **By merchant:** one card per merchant with ×count, date range, account badges and total. A row of category chips: the suggested one first (sage tint), two alternatives, then "More…". **One tap creates a merchant rule** (`POST /api/rules`), which files every transaction in the group and future ones from that merchant. The hint says so: "One tap makes a rule and files all 4, plus future ones." "Show N transactions" expands the group; each row opens the editor to change just that one.
- After a group tap, a toast: "Rule added: Harlow's Market → Groceries. All 4 filed." with **Undo**, which deletes the rule and puts the group back.
- **By date:** one card per transaction with the same chips; a tap files just that one as an override. Its toast ("Harlow's Market filed under Groceries (just this one)") offers **Always**, which creates the rule and files the rest of that merchant too, and **Undo**.
- Pending section at the bottom: locked rows (lock icon, italic muted amount, "Pending since Wed"). They open the read-only pending sheet and can't be filed.
- When the last group is filed: "All sorted", "Your category totals are now up to date", and a "Back to Home" button. The chip disappears from Home.

### Transactions

- Title, month switcher (‹ Oct ›, next disabled for the current month).
- Search field: "Merchant, amount or category".
- Filter chips: All, Revolut, Amex, Pending, Edited, Category ▾.
- Summary line: "68 transactions · £1,254 counted towards budget".
- Grouped by day with a day total ("Today · Fri 16 Oct", "−£56.50").
- Row: merchant initial tile, merchant, account badge, category, amount on the right. Markers:
  - **Pending:** clock icon + "Pending", amount italic and muted. Opens the read-only sheet.
  - **Edited:** pencil icon + "Edited" in sage, counted amount with the bank amount struck through underneath.
  - **Tracked:** "One-offs · tracked".
  - **Excluded:** "Card repayment · excluded" / "Income · excluded", amount muted.
- No sorting UI on this screen.

### Transaction editor (bottom sheet)

- Header: Cancel · "Edit transaction" · Save.
- Merchant, account badge, "Posted", "Edited" tag, counted amount (large) with "counted" under it.
- When anything is overridden, an info box: "From the bank: £64.00 on Thu 1 Oct. Your amount and date are used instead." with **Reset**.
- Grouped fields: Category (opens a picker) · Count in budget (switch; off = "Shown in spending, not in the budget") · Counted amount (with "Bank: £64.00") · Counted date (with "Bank: Thu 1 Oct · now counts in September") · Note.
- Checkbox **"Use for all <merchant>"**, unticked by default.
  - Off: "Only this transaction changes. The 5 other Via Roma Kitchen transactions stay as they are."
  - On: "All Via Roma Kitchen transactions go to Eating out: the 5 earlier ones you haven't edited, and every new one. Ones you've edited by hand keep their category."
- "Reset all changes to bank values" as a quiet destructive button at the bottom.

### Pending transaction (read-only sheet)

- Merchant, account, "Pending since Wed 14 Oct", amount in italic.
- Lock banner: "Pending transactions can't be edited. It already counts towards October's spend. Once Revolut posts it, usually in 1 to 3 days, it shows up in To sort."
- Read-only list: Category, Counts towards spend, Amount, Date. A single Close button.

### Budget settings

Live, with autosave status in the header ("Saved · applies from October" in sage, or "Not saved · fix the allocation below" in brick).

1. **Monthly budget:** one large input. Helper: "Everything you spend in a calendar month, bills included. Starts fresh on the 1st, nothing rolls over."
2. **Allocate to categories:** a stacked bar of allocations in sage shades over a hatched track, "£1,270 of £1,800 allocated" and **"£530 unallocated (Misc)"**. One row per budgeted category with a £ input, then a read-only Misc row showing the remainder, then "+ Allocate to another category". Footnote: only budgeted categories appear here.

Over-allocation (validation stays on the client and the server):
- Editing a category past the total marks that row brick and shows: **"You can allocate at most £530 more (Transport up to £650). Allocations can't exceed your £1,800 budget."** The readout switches to "£110 over-allocated", Misc shows £0, and a marker on the bar shows where the budget ends. Nothing is saved.
- Lowering the total below the allocations shows, under the total: "Your allocations add up to £1,270. Set at least £1,270, or lower an allocation first."

### Categories

- Back to Budget, "+ New", segmented control **Categories / Merchant rules**.
- Three groups, each with a one-line explanation:
  - **Budgeted:** counts against your monthly budget (shows each allocation). Misc is built in and can't be deleted.
  - **Tracked:** shown in spending, never counts against the budget (shows this month's spend).
  - **Excluded:** not spending at all (Savings, Investments, Card repayments, Income).
- Each row has a "…" button. Editing expands the row inline: rename field, Budgeted / Tracked / Excluded selector, Archive, Cancel, Save.
- Categories are archived, never deleted. Archive confirms inline: "Archive 'Gifts'? It disappears from category pickers and budget settings. Its 4 transactions and 1 merchant rule keep pointing at it, so nothing moves. You can unarchive it any time." Archiving a budgeted category sets its allocation to 0 from this month (spec).
- "Show archived (2)" at the bottom lists archived categories, each with Unarchive.

### Merchant rules

- Explanation: "A rule sets the category for every transaction from that merchant, past and future. Transactions you've edited by hand keep their own category."
- List of rules: merchant, "Exact · 27 transactions · from To sort", → category tag. Rules made from To sort or "Use for all" are exact; contains rules are made here.
- Editing a rule: a **Match** choice (Exact name / Name contains, with a hint that contains catches variations like "CITY CABS LTD"), the text to match, category picker, an impact line ("Applies to 14 City Cabs transactions: 3 waiting in To sort, 11 already sorted. 1 you edited by hand stays as it is."), Delete rule, Cancel, Save.

### Accounts

- "Tally checks Lunch Flow twice a day. Bank data can be up to a day behind."
- A sage banner when a new account has been found, linking to the review screen.
- One card per account: badge, name, status (sage "Up to date" or amber "No new data"), last updated, newest transaction, history size.
- Stale account (no new data for several days): amber border and a warning box explaining totals may be missing spend and suggesting a reconnect in Lunch Flow, with "Open Lunch Flow" and "Link new account".

### New account found

- "Lunch Flow started sending a new account. Tally hasn't imported anything from it yet, so your totals are unchanged until you decide what it is."
- Account card: name and last digits, first seen, "Imported: Nothing yet", and a "Looks like BA Amex (name and currency match)" hint.
- Two choices:
  - **Link to an existing account:** pick the old account, then a preview that matches the spec's link behaviour: "Tally will fetch from 4 Oct, 7 days before BA Amex's newest transaction, and file everything under BA Amex. If Lunch Flow kept the transaction ids, that overlap is de-duplicated automatically. If not, up to 7 days may appear twice and you exclude the doubles by hand." A mismatch (e.g. Amex → Revolut) shows a warning instead. No date-and-amount matching: identical same-day purchases are real.
  - **It's a new account:** keep it separate. Tally imports its full history and it starts counting; anything without a rule goes to To sort.
- The confirm button names the action ("Link to BA Amex" / "Add as a new account"). A done screen confirms what happened; after a link it suggests checking the last week in Transactions for doubles.

### Monthly review (later slice)

- "September review · Compared with August".
- Two tiles: this month's spend vs budget, last month's.
- Per category: paired bars (sage = this month, grey = last month), the amount and the change (amber when up, sage when down). Over-budget categories get a flag.
- A line for tracked categories, then top 5 merchants with visit counts.

## Behaviour rules agreed in the design session

1. **Overall budget first, then allocations.** Misc is always the unallocated remainder. Allocations can never exceed the overall figure.
2. **Merchant rules apply to all transactions from that merchant that haven't been edited by hand, past and future.** A transaction with its own category override keeps it.
3. **Changing one transaction's category never moves the others** unless the owner ticks "Use for all <merchant>" in the editor or taps "Always" after filing a single transaction.
4. **Filing a whole merchant group in To sort creates a rule.** Undo deletes it. Filing one transaction is an override.
5. **Pending transactions are visible everywhere but can't be edited or filed**, matching the spec.
6. **A newly found account isn't imported until the owner reviews it**, so it can't affect totals. Categories are archived, never deleted.
7. **To sort can only be opened while there's something to sort.**

## Mapping to the backend spec

Most of the design already matches [phase-2-spec.md](phase-2-spec.md):

- Budget shape, category kinds, Misc and the allocation errors: `GET/PUT /api/budget…`, with `over_allocated` (`maxAllocatableMinor`) and `below_allocated` (`minOverallMinor`) driving the two error messages.
- Home: `GET /api/months/:month/summary` (`spentMinor`, `pendingSpentMinor`, `leftMinor`, `perWeekMinor`, `categories[]`, `inboxCount` for the chip, `lastDataChangeAt` for freshness).
- To sort: `GET /api/inbox` and `GET /api/inbox/merchants`.
- "Use for all <merchant>": `applyToMerchant: true` on `PUT /api/transactions/:id/override`.
- Rules re-sorting past transactions without an override: categories resolved at read time.
- New account found: `GET /api/accounts`, `POST /api/accounts/:id/link` and `…/enable` (P2.1).
- Transactions search and filters, stale-data warnings and Monthly review are later slices in the spec (Insights, Stale-data warnings).

## Differences from the backend spec

None. Four earlier differences were settled on 2026-10-04 in the spec's favour: a group tap in To sort creates a rule, categories are archived rather than deleted, the link preview describes the spec's 7-day overlap instead of date-and-amount matching, and the rules editor offers exact and contains matching.

## Open questions

- Whether "Use for all" should also be offered when editing a rule's category from Categories, or only from the editor and To sort.
- How long a stale account waits before the warning shows. The design uses 4 days, matching the example.
