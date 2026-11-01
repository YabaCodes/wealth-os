# Wealth OS — v1.23.3

## v1.23.3 — Business Trip payment sources and E.SUN card-funding guide

- Each **Business Trip → Payment sources** now has a compact composition bar showing **E.SUN Credit Card, CTBC Operating, Cash and Other**, with recorded NTD amounts and percentages. Legacy Trip Wallet entries, when present, are shown separately from physical cash.
- Uses each existing recorded expense's **paymentMethod** and the existing `effectiveTwd()` calculation, ensuring consistency with exact/flexible reimbursements and settlement calculations. All amounts are read-only; no ledger reclassification or physical-bank movement is created.
- **Pending refundable deposits** are identified separately as temporary holds, excluded from final trip costs and the E.SUN card funding estimate. Refunded deposits count as zero; partially retained/retained deposits count only the retained amount. Missing NTD conversions are highlighted rather than assumed to be zero-cost.
- A card-funding section shows recorded **trip-specific E.SUN credit-card costs** and, if the reimbursement destination is CTBC, presents them as a **CTBC → E.SUN planning amount**. It clearly requires checking actual posted card transactions, refunds, the credit-card statement, and any partial transfers already made. This is **not** a true card statement balance and **does not** initiate or automatically record any transfer.
- For settled trips, uses the settlement's saved `cardPaidTwd` when present and explains that the existing card-funding confirmation is manually marked, **not verified** bank settlement. Existing settlement and post-settlement card-funding workflow is preserved.
- Accessible, privacy-masked NTD values and responsive Light/Dark source chart. All funds, categories, Business Trip entries and data stores remain unchanged.
- Unit and Playwright desktop/mobile browser tests verify mixed payment sources, pending/refunded/partially retained holds, missing conversions, CTBC guidance, confirmed funding labels, display privacy and financial data immutability.
- **Financial Data Model 190** and **IndexedDB schema 3** unchanged. App identity and PWA cache version updated to **v1.23.3**.

**Dependency:** v1.23.2 (Quick Insights) is a separate open PR. This revision is stacked on v1.23.2 and must be merged only after v1.23.2 passes its manual merge/iPhone acceptance process.



## v1.23.2 — Monthly Review Quick Insights

- **Home → Spending drivers:** shows a compact two-category personal spending preview for the selected funding month, highlighting the largest **flexible and unplanned expense categories**, not recurring fixed obligations like rent. Displays a truthful empty state when flexible spending is absent, or an unavailable-data explanation when old totals have no category breakdown.
- **See spending drivers:** opens the existing **Monthly Financial Review** and immediately scrolls/focuses the real **Spending drivers** section inside the modal (accessible keyboard/VoiceOver focus target). No duplicate screen or extra bottom tab.
- **Budget → Spending Drivers:** visible direct shortcut adjacent to the existing Monthly Financial Review action, retaining the selected funding period including historically closed months. The ordinary Monthly Financial Review button continues opening at the top as before.
- Reuses the accepted read-only `spendingDriversFor()` calculation and selected-month `periodRecord().actuals`, which prefers immutable closed-month snapshots, plus that period's plan. Personal expense categories never include bank transfers, virtual allocations, or unsettled reimbursable Business Trip spend.
- All currency values use the existing app privacy-masking helper. Preview cards and shortcut buttons are responsive in light/dark modes and narrow iPhone widths.
- Pure-model regression tests and desktop/mobile real-browser acceptance verify preview ranking, no-spend/unknown-history states, direct section focus, selected-month preservation, closed history, privacy, no IndexedDB writes, and theme compatibility.
- **Financial data model remains 190; IndexedDB schema remains 3.** No accounting, transactions, routing, reconciliation, month-close, migration, or data-store changes. Version and service-worker cache advance to **v1.23.2**.



## v1.23.1 — Monthly Spending Drivers

- Expands the existing **Monthly Financial Review** (Home → Monthly Review, or Budget → Monthly Financial Review) with a **Spending drivers** section: personal spending ranked by category, category-specific fixed/cap plan usage, over-budget amounts, and up to three largest month-over-month category changes.
- Each category has a **View activity** shortcut, which opens the existing Activity screen filtered to **that exact category and funding month**. A visible **Clear filter** restores ordinary Activity; no new personal data is saved by opening the drill-down. Existing Activity edit permissions remain unchanged.
- The pure `spendingDriversFor()` view-model uses actual, recorded **personal expense category totals** from `periodRecord().actuals` and the selected month's **snapshot budget lines**. Closed-month snapshots take precedence where available. Comparisons use the actual **previous recorded funding month**, not an assumed calendar month.
- For old closed months with a total spending value but missing/incomplete category snapshots, the app explicitly states **historical category detail is unavailable** and suppresses invented category deltas. A missing category budget is displayed as **No category plan**, not zero budget. Spending outside the available breakdown is disclosed instead of silently hidden.
- Own-account transfers, virtual allocations and unsettled reimbursable Business Trip ledger entries are **never classified as personal expense**. No changes to data entry, posting, settlement, month-close, restore, forecasting or goal funding.
- Responsive bar-and-row layout, dark-mode contrast and privacy-masked currency figures; existing Monthly Review and bottom navigation unchanged.
- New pure unit tests and real desktop/mobile Chromium scenarios verify sorting, overspending, empty/missing historical breakdown, exact category/month Activity filter, read-only IndexedDB state, dark mode and privacy.
- **Financial data model 190 / IndexedDB schema 3 unchanged.** App and service worker cache advance to **v1.23.1**.



## v1.23.0 — Monthly Financial Review

- Opens **Monthly Financial Review** from Home's current-month actions or the Budget page for a selected funding month, without adding clutter to the bottom navigation.
- One read-only review consolidates **total recorded personal expenses**, fixed/flexible category-plan comparison (and personal expenses outside those planned categories), **completed versus planned core wealth funding**, fixed-bill payment recording, and absolute **previous-recorded-month comparisons** for spending, wealth funding and income.
- For **open months**, reuses the exact production **month-close readiness gate** for hard blockers, bank checks and E.SUN purpose status; unpaid fixed bills are labelled manual-confirmation warnings, not invented hard blockers. Shortcuts lead to the existing Budget, Activity, Wealth and Month-End Review screens. No "close" or transfer action is performed from the review itself.
- For **closed months**, displays persisted month-end snapshot amounts where available; does **not** apply present-day bank reconciliation status retroactively to closed history. Comparison month is labeled explicitly (not assumed to be the previous calendar month).
- Personal spending excludes account-to-account physical transfers, virtual bucket reallocations and unsettled Business Trip reimbursement activity by reusing the app's existing `totalExpenses()` / `periodRecord()` calculations. A settled personal entry is counted only according to existing ledger behavior.
- Pure read-only `js/monthly-review.js`, regression tests for classification, risk messages, snapshot states and comparisons, and real desktop/mobile Chromium UI tests for no writes, navigation, theme, privacy and small viewport.
- No budget, account, close-readiness, transfer or restore logic is changed. Financial data model stays **190**, IndexedDB schema stays **3**. Version and service-worker cache advance to **v1.23.0**; new JS asset is included in offline precache.



## v1.22.3 — Goals Portfolio & Next Actions

- Adds a compact **Goals Portfolio** section above the existing savings what-if and target-date planners under Wealth → Goals.
- Displays the next actionable goal according to saved priority and prerequisites, current saved progress, a plain-language next action, and other goals with **Complete / Paused / Waiting / No deadline / No recorded pace / Recorded pace meets target / Below target pace / Deadline needs review** health labels.
- Deadline health uses **saved target dates** and the same completed-allocation history/month-end timing as the existing target-date planner; it is not an independent routing or guaranteed-return projection.
- Adds a **single shared funding comparison**: sum of monthly funding needs for all eligible active goals with valid deadlines versus one existing open month's planned `immediateWealth` amount. Warn if required total exceeds that amount, or if some active goals lack usable deadlines. Never claim affordability when the plan is unknown or when unmodeled goals also compete for funds.
- An **Open planner** shortcut selects the corresponding goal and switches to the saved target date, if present. No new automated transfers, allocations, goal edits or local persistence of UI selections.
- Responsive iPhone layout and theme-aware accessible status colors in light/dark mode; existing Goals cards, planners, routing strategy and historical financial records remain intact.
- Pure-model regression tests and real-browser desktop/mobile tests verify statuses, prioritization, shared funding, planner shortcuts, privacy masking, no financial data writes and layout.
- Version **1.22.3**; financial data model **190** and IndexedDB schema **3** unchanged.



## v1.22.2 — Goal Target-Date Planner

- In **Wealth → Goals → Goal funding scenario**, switch between the previous **Extra monthly** illustration and new **Reach by date** mode. The goal selector is shared. Date and mode inputs are temporary, not saved.
- Choose a desired completion date to estimate **minimum monthly funding required** (rounded up to a whole NT dollar), additional funding versus average completed allocations, and an illustrative ETA based on the currently planned monthly wealth-funding amount.
- **Explicit timing:** the calculation counts complete future month-end contributions starting next calendar month. A deadline before the end of a month does **not** count that month's deposit. Does not compound investment returns.
- **Feasibility comparison, not an affordability guarantee:** reads an existing open funding month's `planSnapshot.immediateWealth` as a *shared wealth-funding reference*. Displays a warning when the requirement exceeds it, a qualified within-plan message when it fits, or **capacity unknown** when no usable funding plan exists. Other goals and investments compete for this amount; the feature never treats gross salary as disposable funds.
- Missing/invalid dates, already-complete, paused and prerequisite-locked goals show no actionable monthly requirement or estimated achievement date. Reuses the existing Goals read-only model without changing its original Extra Monthly behavior.
- Adds pure deterministic unit tests for date boundaries, round-up, waiting/paused states, no history, missing/zero capacity and absence of data mutations; desktop/mobile real-browser UI acceptance covers switching modes, warning states, privacy masking, Dark mode and unchanged exported IndexedDB data.
- **Data model remains 190 and IndexedDB schema 3.** No migrations, transactions, transfers, goal edits, automatic allocation, routing, or persistent planner settings are introduced. App and service-worker cache advance to **v1.22.2**.



## v1.22.1 — Goals scenario planner dark-mode contrast hotfix

- Fixes the **With Additional Contribution** ETA result tile being a pale mint background with unreadable light text on an iPhone in Dark mode.
- Uses Wealth OS's existing `html[data-theme="dark"]` theme selector, honoring both explicit Dark and device-following System settings. In Dark mode, the highlighted tile uses a dark emerald background with high-contrast readable label and ETA.
- Ensures matching contrast in Light mode for both the label and the projected date, and improves Dark-mode readability of supporting labels, scenario explanation, and disclaimer.
- Adds actual Chromium desktop/mobile UI tests checking computed foreground/background color contrast (WCAG AA 4.5:1 threshold) for the ETA, small label and supporting explanation in Light, Dark, and System-Dark modes, including after interactive input.
- **Styles and release identity only.** No changes to goals, preview calculations, transaction posting, stored records, migrations or service-worker precached assets.
- Financial data model **190** and IndexedDB schema **3** unchanged. Installed iPhone Safari acceptance remains required.



## v1.22.0 — Read-only Goal Contribution Scenario Planner

- Adds a **What if I save more?** panel to the Goals screen, letting the user select any visible savings goal and enter an additional hypothetical amount per month.
- Compares the goal's remaining target and its **actual completed average allocation over the latest three funding months** against a simplified hypothetical pace (recorded pace + extra/month). Shows the baseline ETA, scenario ETA and possible months saved.
- Explicitly handles goals that are paused, waiting for prerequisites, already complete, or missing a target. It does not promise an unlock date, redistribute other goals' funds, or assume the additional contribution will automatically occur.
- Pure, deterministic calculator `goalWhatIfFor()` shares the existing Goals view-model module. Unit tests check projections, rounding, no history, prerequisite enforcement, negative/invalid inputs, large-value bounds and non-mutation.
- Desktop/mobile Playwright tests exercise the real selector and number input, privacy mode, screen reload reset and unchanged exported financial records.
- **Preview only:** user inputs are ephemeral, not saved; no transfers, category changes, financial forecasts, balances or real transactions are created.
- App version **1.22.0**; **financial data model remains 190 and IndexedDB schema remains 3**. The current PWA interface and existing Goals cards retain their previous behavior.



## v1.21.2 — Automated browser acceptance safety net

- Introduces real **Playwright Chromium** tests of the installed PWA's ordinary HTML controls and browser IndexedDB, running on a **localhost-only server in GitHub Actions**. Uses desktop and mobile Chromium viewports; mobile emulation is **not** physical iPhone Safari acceptance.
- Isolated scenarios cover Settings release identification, navigation, expense entry/persistence, closed-month edit restrictions, actual synthetic month-close and reopen, Business Trip pending deposits and Food default, settlement/undo, and safe rejection of invalid backup upload.
- Synthetic fixture data is generated using the existing public default records plus dedicated test records in each test's private browser context. No connection to a deployed site, no real financial data, no test-only production hooks.
- New CI browser job is separate from the existing syntax/accounting/IndexedDB check job; it installs Playwright Chromium in CI and uploads traces/screenshots if a scenario fails.
- **No app functionality or styling changes**, no persistence migrations; **data model remains 190 and IndexedDB schema remains 3**. Release metadata and service-worker cache identity advance to 1.21.2; browser test scripts are never included in the production PWA precache.
- Maintain the usual review/merge and physical iPhone acceptance gate.



## v1.21.1 — Reconciliation roll-forward and net-worth regression protection

- Deduplicates existing read-only **bank-check roll-forward logic** previously duplicated in `js/app.js` and `js/db.js` into shared `js/reconciliation.js`. Both the Wealth Overview account snapshots and `wealthMetrics()` now calculate from the same rules.
- Preserves the original bank baseline behavior: transactions dated before a reconciliation are never counted twice, same-day entries count only if recorded after that check, completed physical transfers move actual account balances, and virtual/purpose-only or pending transfers do not.
- E.SUN still shows **physical balance versus purpose-bucket allocation**, including unassigned/overallocated statuses. Tithe bucket remains excluded from Core Wealth and Financial Net Worth.
- Adds integration tests against actual IndexedDB reads for cross-account CTBC/E.SUN/Cash Wallet transfers, later income and expenses, historical adjustments, newer bank-check resets, deleted records, time/date boundaries, E.SUN virtual allocation, and consistency with net worth.
- Does not change account balances, posted transactions, reconciliation records or historical months. No write-side changes, new UI elements or schema migrations. **Data model remains 190; IndexedDB schema remains 3.**
- Shared module is included in service-worker precache and syntax checks. iPhone physical acceptance required.



## v1.21.0 — Month-Close & Reconciliation Assurance

- **Close/reopen persistence is atomic:** period state and month-end snapshot are now committed together in a single IndexedDB transaction, preventing half-closed months after storage errors. Reopening likewise updates the period and its snapshot status in one transaction while retaining the audited financial snapshot.
- **Duplicate and stale closes rejected:** a previously closed month cannot be silently closed again, and a funding month changed since the close preview requires a refreshed close confirmation. Intentional reopening allows a later corrected close and new replacement snapshot.
- **Original accounting and UI behavior preserved:** all existing close-readiness blockers, bank-check requirements, sweep, tithe, payday, reserve funding, and optional unpaid fixed-bill confirmation remain unchanged. Their readiness gate is now shared by the UI and tests.
- **Synthetic integration tests:** validate readiness blockers, committed snapshots, concurrent duplicate closes, stale forms, fail-atomic rollback, reopen/reclose, closed-month budget sync protection, and physical-vs-purpose transfers including Cash Wallet.
- No new financial calculations, schema migrations, or personal data changes; only save/reopen transaction boundaries improve. **Data model stays 190 and IndexedDB schema stays 3.** New module is precached for offline PWA support.
- CI must pass before PR merge and installed iPhone PWA acceptance is required. Do not close/reopen a real funding month merely to test this release.



## v1.20.3 — Wealth and Goals view-model modularization

- Extracts read-only **Wealth Overview** and **Goals** presentation calculations from the large `js/app.js` controller into `js/wealth-view-model.js`.
- Shared view models compute: goal balance/progress/status and prerequisites, recent contribution history, average core/goal funding pace, forecast month label/goal pace text, available CTBC operating cash after virtual Trip Wallet reserves, bank reconciliation tags, Cash Wallet status, and E.SUN bank/purpose allocation labels.
- Keeps the existing HTML templates, numbers, labels, color classes, goal forecasts, tabs and underlying financial calculations unchanged. Only their data sources are modularized.
- Adds targeted `tests/wealth-view-model.test.js` covering completion/paused/waiting goals, capped progress, recent-history averaging, forecasts, missing contribution history, reconciled versus mismatched accounts, virtual reserve availability, and E.SUN unassigned/over-allocated status.
- No IndexedDB writes or migrations. **Data model remains 190; IndexedDB schema remains 3.** No actual bank balances or personal finance records are included in the test fixtures.
- New module included in the offline service-worker precache and syntax checks. Installed iPhone PWA acceptance remains required.



## v1.20.2 — Atomic Special Budget Settlement & Undo

- Settlement now persists its project status, company reimbursement summary and generated personal income/shortfall/transfer/allocations in **one IndexedDB transaction**. If any write fails, all writes roll back together rather than leaving a partially settled project.
- The same atomic protection applies when undoing a settlement. A completed surplus transfer still **blocks Undo** until the user handles the real bank movement, as before.
- The transaction re-checks current saved data to reject **duplicate submissions**, changed expenses, incomplete NTD amounts, pending refundable deposits, mismatched reimbursement totals and funding months that closed after opening the form.
- Reimbursement calculations remain unchanged: Business Trip full fixed allowance is independent of flexible spending; exact expenses are reimbursed at recorded amounts; pending deposits are excluded; only final surplus/shortfall flows into the personal ledger.
- New isolated IndexedDB integration tests exercise successful settlement and undo, concurrent submissions, pending deposits, shortfalls, exact break-even, stale data, completed transfers and fail-atomic rollback on malformed generated records.
- No UI redesign or migration. **Data model 190 / IndexedDB schema 3** remain unchanged. Existing financial records are not rewritten by this upgrade.
- New settlement module is included in the service-worker precache and syntax checks. Physical iPhone acceptance remains required.



## v1.20.1 — Financial history, migration and month-close regression protection

- Adds automated integration tests that exercise **real IndexedDB persistence** for the v1.12 Household category migration (data model 182) and v1.19 Special Budget metadata migration (data model 190).
- Confirms historical upgrades are **idempotent**: re-running them does not duplicate categories, change completed financial records, rewrite closed-month snapshots, or reclassify legacy Special Budget expenses.
- Shares the existing **closed-month edit guard** across the live app and test suite; month-linked expense, income, transfer and goal contribution edits remain blocked until a month is reopened.
- Extracts only the **open-month budget sync** operation into a tested module. It refreshes the selected open month’s plan/routing preview without rewriting actual transactions, recorded transfer allocations, reconciliations or closed-month summaries. It also rechecks persisted period state before writing to avoid changing a period that has since closed.
- Tests that real completed physical transfers move bank-account balances, planned transfers do not, and purpose-only allocations affect virtual bucket balances without moving bank balances, even after plan sync.
- Exports the tested migrations and period safety functions without changing their established successful behavior. Existing UI and finance flows remain unchanged.
- No personal data or live device records are modified by the tests. **Financial data model remains 190; IndexedDB database schema remains version 3.**
- The new modules are included in JavaScript syntax checks and service-worker precaching for offline iPhone operation.



## v1.20.0 — IndexedDB persistence and restore safety test foundation

- Adds automated **IndexedDB integration tests** that execute the actual `js/db.js` persistence and restore functions against an isolated in-memory IndexedDB implementation (test-only `fake-indexeddb@6.2.5`).
- Tests store creation/seeding, committed CRUD operations and reopening a fresh database module connection, complete export/import round trips, rejection of damaged backups, Undo Restore, and virtual versus physical transfer balance classification.
- Tests a structurally valid backup with an **uncloneable record**: the restore must abort the IndexedDB transaction, including any queued store clears, so existing financial records remain unchanged.
- Fixes that edge case by explicitly aborting the restore transaction if `IDBObjectStore.put()` fails synchronously; successful backup restore behavior remains unchanged.
- CI installs the pinned **development-only** test dependency and executes `npm run check`, combining existing calculation checks with new storage integration tests.
- All sample transactions in tests are synthetic. No personal data, real financial amounts, existing IndexedDB stores or migrations were added or modified. No UI redesign.
- **Data model stays 190**, underlying IndexedDB schema version stays 3; iPhone physical acceptance still required.



## v1.19.3 — Food as the default Special Budget category

- Opening **Add Entry** for a Business Trip now preselects **Food**, the most frequently used category, instead of the first exact-reimbursement category.
- Custom and legacy Special Budgets also preselect **Food** if a Food category is configured; if not, they retain the prior first-category fallback.
- Editing an existing entry keeps its recorded category selection, including exact reimbursement categories. All categories remain available for manual selection.
- Only the form's initial selection changes. No stored records, accounting totals, reimbursement treatment, deposits, settlements, IndexedDB schema or financial data are migrated.
- Data model stays at **190**. Reliability CI and installed iPhone PWA acceptance are required.



## v1.19.2 — clearer Business Trip composition trackers

- **Add Entry now appears directly below the Business Trip header**, before trackers and reimbursement details, so travel spending can be recorded without scrolling to the bottom.
- **Exact reimbursement shows a single 100% horizontal composition bar** of confirmed claim amounts by category, plus a corresponding amounts-and-percentages legend. There is no remaining-budget segment and no per-category progress bar: these categories are claims, not spending limits.
- **Flexible allowance shows one stacked category-spending bar against the shared trip allowance.** Colored segments show spending per category; gray indicates remaining allowance. The amber marker still shows elapsed trip allowance time. When spending exceeds the allowance, the bar explicitly normalizes to spent total, shows the overage, and retains each category's true percentage of the allowance in the legend.
- Pending refundable holds remain excluded from the claim/spending bars until resolved.
- Retains the existing trip allowance, reimbursement, settlement, privacy, offline behavior, IndexedDB model **190** and financial record history. This is a presentation release with pure composition-math tests.
- Physical iPhone PWA acceptance is required after deployment.



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
