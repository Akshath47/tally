# Design files

The screen designs behind [../ui-design.md](../ui-design.md), kept in the repo so the UI can be built without access to the original canvas (a private artifact: <https://claude.ai/artifact/NtWiFpP439EPM98ryVMVE3>).

All amounts, merchants and dates are invented.

## What's here

- `screenshots/`: one PNG per screen or state at 2× (390 px wide screens, so 780 px images). **Start here** to see what each screen should look like.
- `canvas/`: the source of each screen (`*.dc.html`) plus `canvas.json`, the canvas layout (which screen sits where, and its title). Read these for exact values: padding, font sizes and weights, colours, border radii, and the final wording.

| Screen | File |
|---|---|
| Style: colour tokens and type scale | `Palettes` |
| Home (11 to sort, pending, one category over) | `Main` |
| To sort, grouped by merchant (opened from the Home chip) | `Inbox` |
| Transaction editor (bottom sheet, overridden amount and date) | `Editor` |
| Budget settings | `Budget` |
| Budget settings, over-allocated | `BudgetError` |
| Transactions | `Transactions` |
| Pending transaction, read-only sheet | `EditorPending` |
| Categories (full scroll, with rename and archive inline) | `Categories` |
| Merchant rules (editing a rule) | `Rules` |
| Accounts (Amex stale, new account found) | `Accounts` |
| New account found: link or keep separate | `NewAccount` |
| Monthly review (full scroll, later slice) | `Review` |
| First run, no budget yet | `FirstRun` |
| Home: over budget, stale Amex, nothing to sort (no chip) | `HomeOver` |
| Home: loading | `Loading` |
| Home: error | `Error` |

## Reading the `.dc.html` files

They're the canvas's own format, not app code:

- **They don't render if you open them directly.** `{{name}}` placeholders, `<sc-for>` (a loop) and `<sc-if>` (a condition) are filled in by the canvas runtime, which isn't in this repo. The screenshots show the rendered result.
- **Layout and styling are inline** (`style="…"`), with shared rules in the `<helmet><style>` block at the top. Translate them into Tailwind classes and the theme tokens; don't copy the hex values by hand.
- **The `<script>` at the bottom is throwaway prototype logic** (fake data, demo state). It shows the intended behaviour, e.g. the over-allocation maths in `Budget`, but the real logic belongs to the API in [../phase-2-spec.md](../phase-2-spec.md).
- **Text in the markup is the agreed copy.** Use it as written unless [../ui-design.md](../ui-design.md) says otherwise.

## Keeping them current

[../ui-design.md](../ui-design.md) is the written spec and wins over these files if they ever disagree. When the canvas changes, re-export the changed files here and retake their screenshots, so the two don't drift.
