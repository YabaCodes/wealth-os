# Wealth OS — v1.19.1

## v1.19.1 — Special Budget tracker polish

- Business Trip detail now has two dedicated tracker sections: **Exact reimbursement** and **Flexible allowance**.
- Exact-reimbursement categories show their recorded NTD totals and share of exact reimbursable spending.
- Flexible allowance shows pooled allowance usage, a spending bar with the trip-time marker, per-category usage, average daily spend, safe remaining pace, projection and expected trip result.
- The reimbursement action stacks safely on mobile so the button no longer overlaps its status text.
- Special Budget **Activity** now appears at the end of the detail view.

## v1.19.0 — Special Budgets and Business Trips

This release expands the former Special Projects feature into a planning, pacing and reimbursement system while keeping those records isolated from the normal monthly budget.

### Special Budget creation
- Choose **Business Trip** or **Custom Budget**.
- Business Trips capture destination, business purpose, departure/return dates, daily allowance, default currency, main payment method and reimbursement account.
- Business Trips automatically create exact-reimbursement categories (VISA, visa delivery, car rental, hotel, SIM, FX fee, train, Uber, city tax, parking and gas) and flexible categories (Personal Expenses, Food, Shopping and Others).
- Custom Budgets can define exact-reimbursement, flexible/capped and tracking-only categories.

### Business Trip allowance and pacing
- Departure day + return day together count as one allowance day.
- The full daily allowance is treated as a fixed entitlement regardless of actual flexible spending.
- Flexible categories share one pooled allowance across the trip.
- Trip detail shows flexible spending vs allowance, remaining allowance, elapsed allowance time, projected flexible spend, safe remaining daily pace and expected final trip result.

### Refundable deposits
- A refundable deposit/card hold is recorded separately from expenses.
- Pending or fully refunded holds do not count as trip spending or expected reimbursement.
- Settlement is blocked while a deposit is unresolved.
- A partially or fully retained deposit becomes a real expense only after the retained amount and category are confirmed.

### Trip Wallet
- A Special Budget can optionally reserve part of CTBC operating cash in a virtual Trip Wallet.
- The reserve does not create a fake bank transfer or change the physical CTBC balance.
- Wealth view shows the active Special Budget reserve and available operating cash after those reserves.

### Reimbursement and legacy conversion
- Business Trip expected reimbursement = exact reimbursable expenses + full fixed allowance.
- Settlement still records only the final personal surplus or shortfall in the normal ledger.
- Existing legacy Special Projects can be deliberately converted to Business Trips without duplicating expense rows; original amounts, exact NTD amounts, dates and payment methods are preserved while categories are mapped into the new model.
- CSV export now includes reimbursement treatment, entry type and refundable-deposit status.

## v1.18.0 — reliability foundation

This release hardens the existing app without changing financial calculations or redesigning the UI.

### Hardening phase 2 — controlled modularization

- Special-project accounting helpers now live in `js/projects.js` instead of the main app controller.
- The extracted module contains no DOM or IndexedDB access, so its calculations can be regression-tested directly.
- Dedicated tests protect project filtering, NTD valuation, missing-conversion detection, payment-method subtotals and original-currency totals.
- `app.js` keeps only thin adapters to current state, so project UI and settlement behavior remain unchanged.

### Hardening phase 3 — budget pacing extraction

- Flexible-budget pace, per-category pace status, irregular-cap handling and spending projections now live in `js/pacing.js`.
- The module receives expense rows as input instead of reading IndexedDB or app state directly.
- Deterministic tests pin month-day calculations, current/past/future month handling, pacing thresholds and expense cutoffs.
- Home, Budget and Insights keep their existing UI while using the extracted calculations.

### Hardening phase 4 — Activity transformation extraction

- Activity normalization for expenses, income and transfers now lives in `js/activity.js`.
- Search/filter logic, purpose-only transfer classification and daily grouping/totals are now pure/testable helpers.
- Day labels (Today / Yesterday / dated headings) are deterministic in tests.
- Activity rendering and row actions remain in `app.js`, so the visible UI and behavior remain unchanged.

- **Automated accounting tests.** Core budget-plan, month-end sweep, goal-routing, forecasting and expense-aggregation rules are covered with deterministic Node tests.
- **Release consistency tests.** CI verifies that the app version, public defaults, README release heading and service-worker cache version agree, and that every service-worker cached asset exists.
- **Syntax checks.** Every JavaScript source file and the service worker are syntax-checked before tests run.
- **GitHub Actions CI.** Every pull request and push runs the same reliability check automatically.
- **Release metadata self-heal.** On launch, the settings metadata is synchronized to the running app/data-model version after migrations complete. This fixes stale version metadata in backups without touching balances, transactions, transfers, allocations, budgets or month-close snapshots.
- **Documented financial invariants.** `docs/RELIABILITY.md` records the rules future changes must preserve.

No balances, transactions, budget plans, transfers, reconciliations, projects, settlements or closed-month snapshots are rewritten by this release.

## v1.17.0 — the week on Home, a month-end summary, tidier Wealth and Budget

- **This week on Home.** Inside *October so far*, seven small bars show what went on everyday flexible spending each day, against a dashed line for an even daily share of those caps (gas and water, billed irregularly, are left out). A day above the line turns amber. The line above says the week's total and the daily amount that keeps you on pace; ‹ › step through the weeks of the month. **Tap a day** and Latest activity shows that day's entries and what you spent; *Show latest* goes back.
- **Month-end summary.** Closing a month now opens a short summary: how much went to wealth (and how much of it was the month-end sweep), what you spent against the plan, bills paid, caps under and over (every cap that went over, then your three biggest savings), and the Emergency Fund bar moving from where it began the month to where it is now. *Done* closes it.
- **Goal reached.** When a save takes a goal to its target, a note follows the save message: *Emergency Fund reached its target · NT$300,000*.
- **Wealth tab.** Each account card keeps its main button (*Update Balance*, or *Withdraw Cash* for the wallet) with **More** beside it for the rest (Audit Trail, Add Adjustment, Deposit Cash, Count Cash, Reallocate Purpose).
- **Budget tab.** The big red *Delete funding month* card is gone from the bottom. The month picker has a **⋯** with Month-End Review, Reopen (for a closed month) and *Delete <month>…*, which still shows what it would remove before anything happens.
- On 320 px phones the month card's numbers stay on one line ("NT$62,000", not "NT$62,00 / 0").
- No change to any stored record, calculation, backup or CSV export.

## v1.16.0 — smoother to use

- **No more browser pop-ups.** Every question (delete an entry, discard what you typed, close the month with a bill unpaid, restore a backup, delete a funding month…) is now the app's own sheet with clear buttons such as *Delete* / *Cancel* or *Discard* / *Keep editing*. Tapping outside it means no. The grey "yabacodes.github.io says…" boxes are gone.
- **Problems show where you typed.** If something can't be saved ("From and to accounts must be different…"), the reason appears in red above the pop-up's button and everything you entered stays. Other problems get the app's own message sheet.
- **You see what you saved.** A short message at the top: *Food · NT$150 saved · NT$6,445 left*, *Phone paid · NT$790*, *Food · NT$300 saved · NT$320 over* (in red), *Income saved*, *Transfer completed*, *October closed*, and so on. The new entry glows briefly in Latest activity and Activity, and the spending bar and ring move from where they were to where they are now.
- **Motion and press feedback.** Buttons, category tiles, tabs and + give slightly under your finger; the chosen category's picture pops. Pop-ups slide up from the bottom with the page fading behind, and stay above the keyboard while you type. The Budget ring sweeps round and the bars (flexible spending, Emergency Fund, caps, the paycheck split, goals) fill once when you open a screen; bars further down fill as you scroll to them. Opening or closing a pop-up doesn't replay it. Reduce Motion turns all of it off.
- **Activity, grouped by day.** Today / Yesterday / Tue, Oct 13 headings with what you spent (and received) that day. Each entry is two short lines: the category and your note, then the account. The "Physical expense" label is gone from ordinary entries. The list starts at the top; Withdraw cash and Special projects stay as one compact row, and active projects show under it.
- No change to any stored record, calculation, backup or CSV export.

## v1.15.0 — the new Budget

- **Flexible spending ring:** what you've spent from your flexible caps, in each category's colour, with the amber **today's mark**, how much is left in the middle, the same *On pace / Ahead of pace / Over* line as Home, and Spent / Remaining tiles.
- **Where your paycheck goes:** one bar splitting the paycheck into Tithe, Fixed bills, Flexible caps, Reserves, Operating buffer and Wealth, with a row for each showing how it stands (Allocated, 3 of 4 paid, 40% used, Funded, Held, Transferred, or what's still to do), and the month-end sweep so far. It replaces the six summary cards and Monthly flow. If the plan ever assigns more than the paycheck, it says so.
- **Fixed bills:** one list with pictures; ✓ once paid, with the date and any difference ("Paid Oct 6 · NT$9 under NT$799"), or a **Record** button for a bill still to pay.
- **Flexible caps:** each cap with its picture, what's left, its own bar and today's mark, and a status: On pace, NT$… ahead of today's mark, or Over by NT$… in red. Gas, water and electricity say *Billed irregularly* instead of a pace.
- **Headers:** every tab now uses Home's style: "Wealth OS" above the page name (Budget, Activity, Wealth).
- Home and Budget share one pace calculation, so their numbers always agree. No change to any stored record or calculation.

## v1.14.0 — the new Home

- **Greeting header:** "Wealth OS" with Good morning / afternoon / evening.
- **Wealth card** (dark): Core Wealth, how much went to wealth this month, Net worth and Non-core funds, and Emergency Fund progress with whether it's your current priority. It replaces the four separate number cards. Privacy mode hides every amount on it.
- **"October so far":** Income, Spent and the share that went to wealth, then flexible spending against your caps with an amber **today's mark** (where you'd be if the caps were spread evenly over the month): *On pace · NT$336 under today's mark*, *Ahead of pace · … over*, or *Over* when the caps are used up. Month-End Review and New Paycheck sit at the bottom of this card.
- **Next step:** a slimmer card. Once payday is done it simply says *Payday done · keep recording* with the month-end sweep so far; when something needs doing (a payday transfer, a pending transfer, supplemental income to route, a closed month) it shows the amount and the button as before.
- **Latest activity:** the last five entries of the month with their category pictures, and *See all* for the Activity tab.
- Quick capture, the separate Income/Spent/Wealth cards, the two-cap Flexible budget card and Monthly flow are gone from Home: the + button, the new cards and the Budget tab cover them.
- No change to any stored record or calculation.

## v1.13.1 — layout fixes

- **Date fields on iPhone** (expense, income, transfer, paycheck, reconciliation, goals and the rest) no longer stick out past the right edge of their sheet, and their date reads from the left like every other field. iPhone Safari gives date and month fields a minimum width of their own; they now shrink to the column.
- Two-column forms keep both columns equal and inside the card, however wide a field is.
- **Category tiles** show long names on two lines ("Dating / Social", "Family Support", "Sister's Rent") instead of cutting them off.
- New pictures for categories you add: subscriptions (Apple One, iCloud, Netflix, Spotify…) get a repeat icon; family support (Family, Parents, Support…) gets a heart.
- Checked every tab and 40+ pop-ups at 390 px and 320 px: nothing sticks out of its card or sheet and no text is cut off.

## v1.13.0 — the + button and category pictures

- **Bottom bar:** Home · Budget · **+** · Activity · Wealth. The + sits in line with the other icons and opens **New entry**: Expense, Income or Transfer in one place, with Withdraw cash and Special projects underneath.
- **Expense form:** a large amount field and a grid of category tiles, each with its own picture and colour: everyday caps first, then fixed bills, then reserve-funded expenses, plus Project. The line above the grid says how much is left in the chosen category this month (or that a bill is already paid). The note field stays; *Pay from a savings bucket* is one tap away. Editing an expense or recording a bill uses the same form.
- **Activity:** every entry shows its category picture; expenses are no longer red (red is kept for overspending), income stays green. The large Add cards are replaced by the + button; Withdraw cash and Special projects stay as small buttons.
- **Wealth** now holds **Overview · Goals · Insights** in a switch at the top, so the bar needs only four tabs.
- Categories you add get a matching picture from their name (for example "Laundry" gets the household one); anything else gets a tag.
- No change to any stored record or calculation.

## v1.12.0 — bills, Household and the sweep

- **Fixed bills:** a bill is ✓ paid as soon as you record a payment for it, even when the charge differs from the budget (NT$790 or NT$810 on a NT$799 phone plan). The line still shows both amounts and the difference: `NT$790 of NT$799 · paid · NT$9 under`. *x of y covered*, the Fixed summary on Budget and Month-End Review use the same rule; Month-End only flags bills with nothing recorded.
- **Bill differences in the sweep:** once a bill is recorded, what you saved on it is added to the month-end sweep and an overcharge is taken off it, so small differences no longer sit unnoticed in the operating account. A bill with nothing recorded is never swept.
- **Household:** a new flexible cap for laundry, toiletries and cleaning supplies, between Water and Miscellaneous. It starts at NT$0: set the amount in **Settings → Budget rules**. As a capped budget it is planned at payday, and whatever you don't spend comes back in the month-end sweep.
- **Budget changes after payday:** if a change lowers this month's wealth plan after payday has already moved the old amount (for example, adding Household mid-month with *Apply to* this month), the sweep is reduced by the difference, so the month never sends more to wealth than you actually have. Month-End Review explains the adjustment.
- Months closed before v1.12 keep exactly the numbers they were closed with. No stored transaction, transfer or allocation is changed.

## v1.11.0 — refinements

- **Month picker:** Home and Budget show `‹ November 2026 · Open ›` on its own row; tap the month to pick another. The month name is no longer cut off ("November 2026 · fu…"), and Home no longer shows the month twice.
- **Section titles** stay on one line; their helper text sits underneath instead of squeezing the title onto two lines.
- **Money and dates:** negative amounts read `−NT$180` (not `NT$-180`), an overspent cap reads `NT$320 over` (not `NT$-320 left`), and dates read `Oct 4` (with the year when it isn't this year) instead of `2026-10-04`.
- **Activity:** each entry has one ⋯ button (Repeat, Edit, Complete, Route as they apply, with Delete set apart) instead of small text links.
- **Goals:** *Add Contribution* and *Edit Goal* sit side by side.
- No change to any stored record or calculation: every figure on every tab and pop-up was checked against v1.9.0.

## v1.10.1

- *New Paycheck* (Home → Monthly flow) stays visible but inactive until the last 7 days of your latest funding month, with a note showing the date it opens. It is active straight away once that month has ended or been closed. A paycheck received at month-end funds the next month, so it shouldn't be entered mid-month.


## v1.10.0 — reliability and setup

**Fixes**
- **Next funding month:** after the first month there was no way to enter the next paycheck. *New Paycheck* is now under Home → Monthly flow, and when every month is closed Home shows *Enter Paycheck*. The funding month defaults to the month after your latest one.
- **Icons and offline mode:** since v1.7.3 the app pointed to `wealth-os-v173-*` icon files that were never uploaded, so the service worker could not install (no offline mode) and a fresh *Add to Home Screen* got no icon. It now uses the `icon-*.png` files. The service worker also fetches fresh files on each release and only caches successful responses.
- **Restore:** a backup is checked before anything is replaced (an empty or unrelated file used to wipe everything). The confirmation shows what is on the device and what is in the backup, the replacement happens in one step, and *Settings → Undo restore* puts your previous data back.
- **Backups:** Home shows a reminder when you have never backed up or the last backup is older than 14 days (*Remind me later* hides it for 3 days). On a phone, *Export Backup* opens the share sheet (*Save to Files*), and the backup date is only recorded when the export happens.
- **Layout:** the month selector made Home 18–34px wider than the phone, pushing every pop-up past the screen edge; budget rows overflowed on 320px phones. Both fixed.
- **Forms:** fields are 16px on touch screens so iPhone no longer zooms in. Tapping outside a pop-up you have typed in asks before discarding.
- **Accessibility:** labelled Settings button, month selector, forecast inputs and budget-rule fields; readable contrast for tab labels and the Next action card.

**New: Settings → Categories & funds**
- *Budget categories:* add fixed monthly bills or flexible spending caps, rename them, change type or amount, and archive ones you no longer use (past expenses keep them). Saving can refresh the selected open month, like Budget rules.
- *Savings funds:* add a planned-use fund (held in E.SUN, counted in Financial Net Worth, not Core Wealth) with a target and optional monthly amount; it gets its own goal and spending category. Funds can be renamed, and archived once their balance is zero.
- Home's *Flexible budget* card now shows your two largest spending caps instead of two fixed names.
- Not included: adding a new bank or brokerage account. Payday routing is built around CTBC → E.SUN, so that needs its own change.

**Privacy:** `js/defaults.js` (used only for a brand-new install) no longer contains personal amounts or budget lines; your real data lives on your phone and in your backups. Earlier versions of the file remain in the repository's public commit history.

**Unchanged:** every balance, transaction, budget, transfer, reconciliation, project, settlement and closed-month snapshot. The data model stays at 181.


## Theme selector (v1.9.0)

v1.9.0 adds **Settings → Appearance → Theme** with three options:

- **System** (default) follows the iPhone's light or dark setting and switches with it.
- **Light** is the existing look, unchanged.
- **Dark** is a matching dark version of the same minimal design.

The choice applies immediately, is saved with your other settings (and in backups), and is applied before the first screen is drawn, so there is no white flash on launch.

This release changes presentation only. No balances, transactions, budgets, transfers, reconciliations, projects, settlements or closed-month snapshots are modified. The data model stays at 181.


## Selective Privacy Mode (v1.8.1)

v1.8.1 narrows the eye-button privacy behavior so Wealth OS stays useful while sensitive balances are hidden.

### Hidden when Privacy Mode is ON

- Core Wealth
- Financial Net Worth
- Non-Core Funds
- CTBC, E.SUN, Cash Wallet and IBKR balances
- Emergency Fund and other goal balances
- regular income totals
- wealth-contribution totals and wealth-capacity figures
- sensitive month-end snapshot balances
- current/forecast wealth totals in Insights

### Always visible

- budget amounts and category caps
- actual category spending and remaining budget
- fixed-obligation amounts
- Activity transaction amounts
- expense history
- Spending Pace Insights, including expected-by-now, projected spend and safe daily spend
- Special Project/trip expense amounts and reimbursement tracking
- percentages, progress bars, dates and status indicators

This means Privacy Mode protects the size of your wealth and account balances without making normal budgeting, expense entry or project tracking difficult to use.

## Accounting behavior

This release changes presentation only. It does **not** modify balances, transactions, budget plans, transfers, reconciliations, projects, settlements or closed-month snapshots.

## Release identity

- App version: **1.18.0**
- Data model: **182**
- Service-worker cache: **wealth-os-v1-18-0**
- Manifest: **manifest.webmanifest**

## Upgrade

Replace the repository files with this package, commit to `main`, wait for GitHub Pages to deploy, then fully close and reopen the installed PWA. Confirm **Settings → Wealth OS v1.18.0 / Data model 182**.
