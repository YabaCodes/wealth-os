# Wealth OS Roadmap

## Current release track

### v1.18 — Reliability and controlled modularization
Completed:
- Reliability foundation and CI safety net.
- Special Project pure accounting extraction.
- Budget/spending pace extraction.
- Activity normalization, search/filter and daily grouping extraction.

### v1.19 — Special Budgets
Completed:
- Business Trip template with exact reimbursement and fixed daily allowance.
- Custom Special Budget template.
- Refundable deposit/hold tracking and resolution.
- Optional Trip Wallet reserve from operating cash.
- Business Trip pacing, expected reimbursement and projected surplus/shortfall.
- Deliberate conversion of existing legacy Special Projects without duplicating records.

### v1.19.1 — Tracker layout and reimbursement overlap
Completed: responsive reimbursement actions, separate exact/flexible trackers, Activity last.

### v1.19.2 — Composition tracker polish
Completed and accepted on iPhone:
- Move Add Entry to the top of Business Trip detail.
- Exact reimbursement: 100% stacked claims composition; no remaining-spend impression.
- Flexible allowance: category composition + remaining allowance + trip-time marker.
- Preserve all persisted financial data and settlement rules.

### v1.19.3 — Entry form default category
Completed; merged and physically accepted:
- New Business Trip and Special Budget entries prefer Food when the category exists.
- Editing an existing expense preserves its saved category.
- No data model or accounting changes.

## Reliability continuation

### v1.20.0 — IndexedDB and restore integration foundation
Completed, merged and physically accepted (all six iPhone checks PASS):
- Isolated IndexedDB integration harness using dev-only fake-indexeddb.
- Real db.js CRUD, seed, export/import, undo snapshot and atomic restore regression tests.
- Abort import transaction if any record fails synchronously during IDB put.
- Basic account-transfer balance classification.
- Keep IndexedDB schema 3 and financial data model 190 unchanged.

### v1.20.1 — Financial history regression coverage
Completed, merged and physically accepted:
- Test real IndexedDB migrations v182 Household and v190 Special Budget metadata including repeat upgrades and frozen history.
- Test shared closed-month guard and open-month sync persisted writes without mutating completed records.
- Test bank movement versus virtual allocation accounting before/after budget sync.
- Keep model 190 and IndexedDB schema 3 unchanged.

### v1.20.2 — Special Budget settlement and undo safety
Completed, merged and physically accepted:
- Commit and undo related project, personal-ledger, transfer and allocation rows in a single atomic IndexedDB transaction.
- Reject duplicate submissions, unresolved deposits, missing NTD amounts, stale amounts, closed funding periods and accidental partial writes.
- Keep full Business Trip reimbursement and allowance calculation semantics unchanged.
- Add integration tests with synthetic projects and no live data modification.

### v1.20.3 — Wealth and Goals read-side modularization
**Completed, PR #19 merged and physically accepted on iPhone (2026-10-18; six of six checks PASS):**
- Extract goal progress, status, prerequisite and contribution pace display models from app.js to a pure module.
- Extract Wealth Overview account-health tags and virtual operating-cash availability to the same module.
- Add deterministic tests without changing views, account balances, postings, IndexedDB storage or migrations.
- Keep all new module imports available in the offline PWA service-worker cache.

### v1.20 reliability series — acceptance record (2026-10-18)

All planned v1.20.0–v1.20.3 revisions are merged and physically accepted:

| Revision | Milestone | Acceptance |
| --- | --- | --- |
| v1.20.0 | IndexedDB integration and restore atomicity | Six iPhone checks PASS |
| v1.20.1 | Migration, closed-month and budget-sync regression safety | User-confirmed PASS |
| v1.20.2 | Atomic Special Budget settlement and undo | User-confirmed PASS |
| v1.20.3 | Wealth/Goals read-only view-model modularization | Six iPhone checks PASS; see [PR #19 acceptance record](https://github.com/YabaCodes/wealth-os/pull/19#issuecomment-6252912555) |

For v1.20.3, checks covered version/data model, Wealth balances/reconciliation, Goals status/pace, Insights projections, Business Trip trackers/Food default, and data persistence/backup export after reopening. No acceptance defects were reported. The **financial data model remains 190** and the **IndexedDB database schema remains 3**.

## v1.21.0 — Month-Close & Reconciliation Assurance

**Status: completed, PR #21 merged and physically accepted (2026-10-18).** Prioritize end-to-end confidence in the month-close/reopen path before expanding accounting features.

1. Completed: extract the live close-readiness decision gate for direct testing without changing its blocker calculations or display wording.
2. Completed: atomically persist the period closed flag and complete audit snapshot; atomically reopen both records while preserving the financial snapshot.
3. Completed: reject concurrent duplicate closes and stale period previews; support intentional reopen and reclose with a corrected snapshot.
4. Completed: test pending transfers, sweep, tithe, payday/reserve funding and bank reconciliation blockers using the shared production decision gate. Unpaid fixed obligations remain a manual-confirmation warning.
5. Completed: isolated IndexedDB tests cover Cash Wallet withdrawals and physical versus virtual CTBC/E.SUN account movements, plus refusal to resync a closed month's plan.
6. Still outstanding: complete browser-driven month-close UI tests and all historical reconciliation roll-forward variants; preserve as follow-on testing priorities.

**Release gate:** automated CI green, no existing-ledger mutation/migration, reproducible closed-month snapshot assertions, and manual iPhone acceptance following an external backup.

## v1.21.1 — Reconciliation Roll-Forward Protection

**Status: completed, PR #22 merged and physically accepted (2026-10-18).**

- Consolidate duplicate bank-reconciliation read logic used by Wealth Overview and Wealth Metrics into one pure module, without modifying current calculation semantics.
- Regression-test bank-check baseline selection, same-day record timestamps, older adjustments, later income/expenses, Cash Wallet, completed physical transfers and pending/virtual transfers.
- Verify E.SUN physical bank balances versus virtual allocations and ensure tithe remains excluded from net worth.
- Preserve personal financial records, account balances, the current UI, data model 190 and IndexedDB schema 3.
- Continue to require passing CI, external backup and installed iPhone acceptance.

## v1.21.2 — Browser-Level UI Acceptance

**Status: PR #23 merged and physical iPhone acceptance confirmed (2026-10-18).**

- Add Playwright Chromium browser tests for real app controls across desktop/mobile viewports.
- Test synthetic month-close/reopen and historical immutability, expense capture, Business Trip deposit gating and actual settlement/undo, and invalid backup restore.
- Run browser tests against a localhost static server using isolated IndexedDB and browser contexts; never touch a real user profile or GitHub Pages deployment.
- Keep all existing finance calculations, UI layout, data model 190 and IndexedDB schema 3 unchanged.
- After passing CI and manual merge, require iPhone physical smoke acceptance. The browser tests are an additional safeguard, **not** a substitute for Safari acceptance.

## v1.22.0 — User-Facing Wealth & Goals Improvements

**Status: PR #24 merged; user confirms the planner functions correctly, with a Dark-mode contrast defect requiring v1.22.1.**

- Add a read-only **What if I save more?** planner to Goals for an extra hypothetical monthly contribution to one selected goal.
- Compare actual recorded goal allocation pace (last three funding months) with the hypothetical pace; show current and illustrative completion dates and possible months saved.
- Respect waiting prerequisite, paused, complete and no-target states. Do not imply the extra amount is automatically routed, or create a saved plan or transfer.
- Cover input changes, privacy masking, no database writes and reload-reset behavior in desktop/mobile browser tests, plus deterministic calculation unit tests.
- Keep financial data model 190, IndexedDB schema 3, existing goals, transaction history and all prior reporting unchanged.

## v1.22.1 — Dark-mode Goals planner contrast

**Status: PR #25 merged and user confirmed the iPhone dark-mode contrast fix (2026-10-19); accepted.**

- Fix the light mint-highlight tile and its unreadable value/label when the Goals planner is viewed in Dark mode.
- Support manually selected Dark and device-based System Dark through the app's actual theme selector.
- Improve contrast of planner supporting copy while preserving Light-mode appearance, financial forecasts and stored records.
- Cover foreground/background contrast in desktop/mobile real-browser tests. No app calculation or IndexedDB changes.

## v1.22.2 — Goals target-date funding planner

**Status: completed, PR #26 merged and six physical iPhone checks PASS (2026-10-19).**

- Add a toggle to the existing Goals scenario planner for a **Reach by date** mode, alongside Extra Monthly.
- Count future end-of-calendar-month contributions, starting next month, only if their due date is on or before the selected target date.
- Report goal funding required per month, additional versus actual completed pace, baseline ETA and an all-to-one-goal budget-based illustration.
- Compare required amount to the currently open month's planned **shared wealth-funding amount**, with a clear above-plan warning, conditional within-plan message, or capacity-unknown state. Never imply the amount is guaranteed free cash or override goal prerequisites.
- Preserve no-write behavior for hypothetical inputs, show masked financial values in privacy mode, and maintain Dark-mode readability.
- Protect with unit and actual desktop/mobile Chromium tests; require iPhone acceptance before marking complete.

## v1.22.3 — Goals Portfolio & Next Actions

**Status: completed, PR #27 merged and all six physical iPhone acceptance checks PASS (2026-10-19).**

- Add a read-only Goals portfolio for saved priorities, progress, goal health and the next action, above existing individual goal cards and planning tools.
- Interpret stored target-date health from actual completed goal allocations, including paused/waiting/complete states and no-history or missing-deadline cases.
- Compute one **shared** planned wealth-funding comparison, summing current active dated-goal requirements without double-counting the same plan capacity. Incomplete/undated goals prevent an affordability conclusion.
- Offer an **Open planner** shortcut that selects the goal and saved deadline, without transferring funds, changing goals or recording hypothetical numbers.
- Protect existing privacy masking and dark-mode contrast with desktop/mobile browser tests; preserve financial data model 190 and IndexedDB schema 3.

## v1.23.0 — Monthly Financial Review

**Status: completed, PR #28 merged and all six physical iPhone acceptance checks PASS (2026-10-20).**

- Consolidate recorded personal spending, tracked fixed/flexible budget status, completed versus planned wealth funding, fixed-bill status, and prior-recorded-month comparisons in an accessible on-demand review from Home and Budget.
- For open months, reuse the current shared month-close hard blocker and bank/purpose reconciliation gate; warn about missing fixed payments without inventing hard blockers.
- For closed months, use existing persisted close snapshots when available and never project current bank checks onto historical close records.
- Provide shortcuts to **existing** Budget, Activity, Wealth and Month-End Review controls; review is read-only and does not save, sweep, transfer, or close.
- Cover mathematical and accounting classification, combined history, navigation, theme/privacy and IndexedDB immutability with Node and Playwright desktop/mobile tests. Data Model 190 and IndexedDB schema 3 unchanged.

## v1.23.1 — Monthly Spending Drivers

**Status: completed, PR #29 merged and six physical iPhone acceptance checks PASS (2026-10-20).**

- Extend the accepted Monthly Financial Review with ranked **personal expense** drivers by category and exact category plan overages, plus largest category spending changes against the previous **recorded** funding month.
- Use current and historical category actuals from existing period snapshot semantics. When old closed months contain a spending total but no complete category breakdown, explicitly suppress misleading per-category deltas.
- Category drill-down leads to the existing Activity screen filtered to exact category and funding month, with clear/reset control; no new write paths.
- Exclude physical transfers, purpose allocations and unsettled Business Trips from personal spending; respect existing privacy, dark mode and mobile layout.
- Verify immutability, accurate amounts, prior-month snapshots, drill-down navigation and release version with Node and Chromium desktop/mobile tests. Keep model 190 / IndexedDB schema 3.

## v1.23.2 — Monthly Review Quick Insights

**Status: implementation under review; physical iPhone acceptance pending.**

- Add a compact **Home spending preview** for the top two flexible/unplanned personal expense categories for the currently selected funding month, excluding fixed obligations from the preview only.
- Add a one-tap **See spending drivers** shortcut on Home and **Spending Drivers** shortcut on Budget; opening the existing Monthly Financial Review should position/focus the Spending drivers section, while ordinary Monthly Financial Review access remains at its top.
- Respect selected open/closed month and its persisted historical actuals, show honest empty/unavailable states, and preserve privacy, dark mode, offline behavior and no-write accounting.
- Validate pure model outputs and real desktop/mobile UI navigation, proper focus, period retention and IndexedDB immutability. Data Model 190 / IndexedDB schema 3 unchanged.

## v1.23.3 — Business Trip Payment Sources and Credit-Card Funding

**Status: in review; depends on v1.23.2 merge and physical iPhone acceptance.**

- A payment-source composition bar and amounts for E.SUN Credit Card, CTBC Operating, Cash, Other and legacy Trip Wallet on each Business Trip.
- A read-only **CTBC → E.SUN** card-funding planning amount based on recorded trip card-paid costs, distinct from the full credit-card statement balance and any manually funded partial transfers.
- Pending refundable holds shown separately from counted trip costs; retained deposit amounts counted only after resolution, and missing NTD conversions clearly disclosed.
- Preserve the existing settled project's manual card-clearing confirmation; never claim bank payment is verified.
- Pure deterministic tests and desktop/mobile Playwright synthetic trip tests. No transfers, category reclassification or account postings; Data Model 190, IndexedDB schema 3.

### Later candidates (not committed)

- Extended browser scenarios and failure/retry coverage, with synthetic data.
- Optional recurring contribution workflow only after explicit authorization and financial safety review.
- Additional modularization where tests show it reduces change risk.

Persistence, migrations and restore code must not be aggressively refactored without a passing integration safety net.
