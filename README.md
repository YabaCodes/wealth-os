# Wealth OS — v1.3.2

A local-first PWA for paycheck allocation, monthly budgeting, virtual sinking funds, wealth contributions, transfers, goals, investments and month-end reconciliation.

## What this build includes

- Exact take-home salary entry each month — no assumed salary for live budgeting.
- Pay date and funding month are separate, so a paycheck received on the last working day can fund the following month.
- Budget rule types: percentage, fixed, flexible cap, sinking-fund contribution and operating buffer.
- Current default plan:
  - Tithe: 10%
  - Rent: NT$23,000
  - Sister's rent: NT$7,600
  - Family support: NT$3,500
  - SIM: NT$799
  - Wi-Fi: NT$899
  - Gym: NT$1,088
  - Apple One: NT$390
  - iCloud: NT$300
  - Food cap: NT$10,000
  - Dating/social cap: NT$3,000
  - Transportation: NT$1,100
  - Gas: NT$200
  - Water: NT$400
  - Miscellaneous: NT$1,000
  - Electricity reserve: NT$4,400/month
  - Operating buffer: NT$3,000
- Physical accounts: CTBC, E.SUN and IBKR.
- E.SUN virtual buckets keep Tithe, Emergency Fund, Home Travel and Equipment Fund separate even though the bank sees one balance. Electricity Reserve is a virtual reserve held inside CTBC Operating.
- Planned transfers do not change balances until marked completed.
- Manual transfers can be recorded and assigned to a virtual bucket.
- Actual expense entry with budget-vs-actual tracking.
- Individual expense deletion via soft-delete.
- Reserve-funded expenses, such as Electricity Bill, consume the reserve bucket once.
- Month-end sweep of unused flexible budgets and operating buffer.
- Duplicate month-end sweeps are prevented.
- Emergency goal: NT$300,000.
- Home Travel goal: NT$100,000; becomes eligible once Emergency Fund reaches NT$200,000; target contribution NT$10,000/month, with remaining surplus continuing to Emergency Fund.
- IBKR portfolio snapshots and editable USD/TWD exchange rate.
- Core Wealth versus Financial Net Worth.
- Simple long-term forecast and salary scenario test.
- JSON backup and restore.
- Works offline after installation through its service worker.

## Important first-use step

The app is seeded with:

- CTBC opening cash: NT$34,850
- E.SUN opening balance: NT$55,000
- E.SUN Tithe virtual bucket: NT$55,000
- IBKR opening portfolio: US$3,536

The NT$34,850 is initially physical operating cash, so it appears in Financial Net Worth but not Core Wealth/Emergency Fund until you deliberately reserve it.

If you physically move the NT$34,850 from CTBC to E.SUN as your starting Emergency Fund, open **Activity → + Transfer**, record CTBC → E.SUN for NT$34,850, choose **Emergency Fund** as the purpose, and mark the transfer completed. The app will then show E.SUN as containing both tithe and wealth savings while keeping the two virtual balances separate.

If your actual physical bank balances differ, use the project only after reconciling the opening balances or edit the defaults before your first live month.

## Run locally

Because the app uses ES modules and a service worker, serve it over HTTP rather than opening `index.html` directly.

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## GitHub Pages

1. Create a new GitHub repository.
2. Upload the contents of this folder to the repository root.
3. Commit/push to `main`.
4. In GitHub: **Settings → Pages → Deploy from a branch**.
5. Select `main` and `/ (root)`.
6. Open the generated Pages URL.
7. On iPhone/iPad Safari: **Share → Add to Home Screen**.

All asset paths are relative, so the app works from a GitHub Pages repository subpath.

## Data privacy

v1 has no server or bank connection. Records are stored in IndexedDB in the browser/PWA installation. Use **Settings → Export Backup** regularly. Clearing browser/site data can erase local records if you do not have a backup.

## v1 limitations / next logical upgrades

- No cross-device sync yet.
- No automatic bank or IBKR connection.
- Bonus/windfall allocation is recorded but not yet governed by a dedicated configurable allocation policy; use manual transfers for these in v1.
- Recurring fixed obligations are budgeted automatically but do not yet have a separate Expected/Paid workflow.
- Goal-rule editing UI is limited; the underlying model already supports the current Emergency/Home Travel dependency.

## Revision 1.1 — 2026-09-29

This revision keeps the original local data model and adds the requested interface/reconciliation improvements:

- Home now shows Core Wealth, Financial Net Worth, and Non-Core Funds.
- Activity uses three structured action cards with consistent outline icons and explanations.
- All six bottom tabs now use one monochrome SVG icon system.
- Bottom navigation supports iPhone safe areas and rounded screen corners.
- E.SUN has an Update Balance flow for recording the exact bank balance.
- E.SUN has an explicit Add Adjustment flow for ledger corrections; adjustments never silently reassign virtual buckets.
- E.SUN now displays bank balance, expected ledger balance, virtual allocation total, bank-vs-ledger difference, and unassigned balance.
- IndexedDB schema upgraded from version 1 to version 2 to add the `adjustments` store. Existing local data is preserved during the upgrade.
- Service worker cache upgraded and old caches are cleared on activation so GitHub Pages/PWA updates propagate more reliably.

### Updating an existing GitHub Pages installation

Replace the files in the repository root with the files from this revision, keeping the same folder structure (`js/`, `icons/`, etc.). Commit the changes to `main`. GitHub Pages will redeploy automatically. Because this PWA uses a service worker, the first launch after deployment may still show the previous version briefly; close and reopen the installed PWA after the new service worker activates.


## Revision 1.2 — 2026-09-29

This revision focuses on daily usability and bank-to-ledger accuracy:

- E.SUN balance updates now immediately detect money that has no virtual purpose.
- Unassigned E.SUN money can be assigned to one bucket, split across several buckets, or left partially unassigned.
- If virtual allocations exceed the actual E.SUN balance, allocations can be explicitly reduced.
- Bank reconciliation and purpose allocation are shown as separate statuses; E.SUN only shows fully reconciled when both are clean.
- CTBC now has the same actual-balance update and explicit adjustment workflow as E.SUN.
- Reconciled CTBC bank balances are used in Financial Net Worth while transaction-ledger differences remain visible until resolved.
- Wealth now includes an Account Health summary for CTBC, E.SUN and IBKR.
- Budget is now a monthly Plan vs Actual dashboard with Income, Fixed, Flexible, Reserves, Wealth and Buffer summary cards.
- Budget categories now include progress bars, actual/funded amounts and remaining/over-budget amounts.
- Activity now supports filters for All, Expenses, Income and Transfers.
- Expenses and income can be edited or deleted. Manual transfers can be edited or deleted. System-generated payday/sweep transfers remain protected from accidental editing.
- E.SUN purpose assignments are recorded as internal allocation events, not expenses, so physical account balances are unchanged.
- Service-worker cache version bumped to v1.2 for more reliable GitHub Pages/PWA refreshes.

### Recommended validation after upgrading

1. Open **Wealth** and update the exact CTBC and E.SUN balances from the banking apps.
2. If E.SUN shows unassigned money, use **Assign Money** and tell Wealth OS what that amount is for.
3. If either bank shows a Bank vs Ledger difference, first confirm it is not a missing expense, income or transfer; otherwise use **Add Adjustment** with a reason.
4. Open **Budget** and verify the current month Plan vs Actual values.
5. Add one small test expense, income and transfer, then confirm the Activity filters and edit/delete controls behave as expected.


## Revision 1.2.1 — 2026-09-29

This patch adds a safe way to test the paycheck workflow without leaving a fake funding month behind:

- Budget now includes **Funding month controls** with **Delete Month**.
- Deleting an open funding month removes its period-linked income entries, expenses, planned transfers, and transfer allocations so the same month can be created again.
- Account reconciliations, account adjustments, IBKR snapshots, and unrelated transactions are preserved.
- Deletion is blocked for closed months.
- Deletion is also blocked when the month has completed transfers, so Wealth OS never silently reverses money that may have actually moved between accounts.
- Service-worker cache version updated so the installed PWA picks up the patch.

For a test paycheck, create the funding month, explore the budget and planned transfer, **do not mark the transfer completed**, then use **Budget → Funding month controls → Delete Month** when finished.

## Revision 1.3 — 2026-09-29

This revision adds the next control layer: month close, goal management and strategy-based forecasting.

### Month close and historical integrity

- Month-End Review now uses a checklist for payday funding, pending transfers, CTBC reconciliation, E.SUN reconciliation/purpose allocation, fixed obligations and the month-end sweep.
- A month cannot close while planned transfers are pending, the sweep is still available, payday tithe/reserve funding is incomplete, or bank/purpose reconciliation is unresolved.
- Fixed obligations that are not fully recorded are shown as an explicit warning before close.
- Closed months are read-only. Expense, income and transfer edits/deletes tied to a closed month are blocked.
- Closed months can be intentionally reopened for corrections. Reopened months clearly warn if the previously completed sweep is now too large for the revised budget.
- Month-close snapshots now store income, expenses, contribution totals, ending Core Wealth, ending Financial Net Worth, account values and category actuals.
- New funding months store their original budget plan snapshot so later Settings changes do not rewrite that month's plan.
- The system-generated funding paycheck is protected from direct edit/delete; use Delete Funding Month before completed transfers if the paycheck setup itself was a test or mistake.
- Planned transfers now appear in Activity and can be completed from there; user-created planned manual/goal transfers can also be deleted before completion.
- If new activity makes a previous bank reconciliation stale, Financial Net Worth falls back to the current transaction-ledger estimate until the bank is checked again, preventing stale bank balances from double-counting transfers.

### Goals

- Goals now have richer status cards with progress, remaining amount, target date and routing logic.
- Goal targets, dates, monthly targets and status can be edited.
- Manual goal contributions can be recorded as planned or completed transfers.
- The existing routing policy is explicit: build Emergency Fund first; after the Emergency Fund reaches the Home Travel unlock threshold, fund Home Travel at its monthly target while continuing Emergency; once the Emergency Fund target is complete, remaining surplus becomes investable.

### Investment routing

- Goal-allocation logic now routes surplus beyond completed core cash goals to IBKR instead of overfilling Emergency Fund or Home Travel.
- Payday and month-end sweep logic can create a separate CTBC → IBKR planned transfer when the strategy reaches that stage.
- Core-wealth contribution reporting counts completed investment transfers as well as Emergency Fund contributions.
- IBKR valuation remains snapshot-driven; completed transfers after the latest snapshot are temporarily layered onto the portfolio estimate until the next IBKR snapshot replaces it.

### Forecast

- Forecast now models the actual strategy rather than applying one return assumption to all Core Wealth.
- Emergency Fund cash is modeled at 0% return; the investment return assumption applies only to investments.
- Home Travel funding is modeled after its Emergency Fund unlock threshold and monthly contribution rule.
- Forecast shows projected timing for the Home Travel unlock, Emergency Fund completion, Home Travel completion, Core Wealth milestones, and 1/3/5/10-year checkpoints.
- Scenario Lab now supports take-home salary, investment return and an extra monthly wealth contribution without changing live budget data.

### Recommended validation

1. Create a disposable test funding month.
2. Complete its payday transfer, then update CTBC/E.SUN balances and purpose allocations.
3. Record fixed and flexible expenses.
4. Open **Month-End Review** and verify each checklist item reacts correctly.
5. Create and complete a sweep, reconcile the bank balances again, then close the month.
6. Verify the month is read-only; reopen it and confirm editing becomes available again.
7. Delete the disposable test month only if no completed transfers remain, or restore a pre-test backup.



## Revision 1.3.1 — 2026-09-30

This patch fixes the first live-payday issues found during real use:

- Date fields now default to the device's **local calendar date** instead of UTC, preventing Taiwan-morning entries from defaulting to the previous day.
- Electricity Reserve now remains physically in **CTBC Operating**. It is recorded as an internal CTBC purpose allocation, so no CTBC → E.SUN transfer is required.
- Electricity Reserve is no longer part of E.SUN virtual composition and is not double-counted in Financial Net Worth.
- Payday bank-transfer requirements are now derived from the funding plan **minus items already completed**. A separately completed tithe transfer therefore reduces the next action immediately instead of leaving an obsolete combined transfer.
- The Home **Next action** card shows only the remaining amount for the next destination, with a purpose breakdown.
- New funding months no longer create a single combined planned payday transfer. The app creates the actual completed transfer only after the user confirms the exact remaining amount was physically moved.
- Existing uncompleted v1.3 payday/investment plans are migrated away automatically; completed real transfers are preserved.
- CTBC-hosted reserves are automatically funded as virtual purpose allocations when a paycheck creates the funding month.
- Bank balances now roll forward from the last exact reconciliation using recorded ledger activity. For example, after recording a completed NT$7,972 CTBC → E.SUN tithe transfer, E.SUN's tracked current balance increases by NT$7,972 automatically while retaining the prior bank-check baseline.
- Wealth labels clarify when a tracked current balance includes recorded activity since the last exact bank check.

For the September 30 live-payday case, after the existing NT$7,972 tithe transfer is recognized, the remaining E.SUN payday action should be the **NT$11,073 Emergency Fund contribution**. The NT$4,400 Electricity Reserve remains in CTBC and requires no bank transfer.


## Revision 1.3.2 — 2026-09-30

This patch fixes E.SUN purpose-allocation reconciliation semantics:

- A saved bank reconciliation now becomes the authoritative physical-balance baseline. The old pre-reconciliation difference is no longer carried forward forever as a false current mismatch.
- E.SUN/CTBC purpose allocations are explicitly non-physical records. They can change virtual buckets but cannot change physical bank balances.
- Physical account calculations defensively ignore all internal/purpose-only allocation records, including historical records created by older app versions.
- A narrow one-time repair removes a duplicated E.SUN purpose allocation only when it exactly matches the prior reconciliation gap and an identical allocation record exists. Legitimate distinct allocations are left untouched.
- Existing real physical transfers (such as the NT$7,972 CTBC → E.SUN tithe transfer) are preserved and continue to roll the tracked bank balance forward.
- The PWA cache version is bumped so installed Home Screen apps receive the patch.

For the live September 30 case, the expected post-patch result is E.SUN tracked/ledger balance NT$67,472 after the recorded NT$7,972 tithe transfer, with the original NT$4,500 categorized as tithe without creating another bank movement.

## Revision 1.3.3 — 2026-09-30

This patch corrects the remaining E.SUN reconciliation-baseline double count found during live use:

- A bank reconciliation is now a true **authoritative physical baseline**. Tracked CTBC/E.SUN balances roll forward only with physical activity that occurred after the latest bank check.
- Historical adjustments or corrections that were already reflected in the checked bank balance are no longer added again after reconciliation.
- Saving a new bank reconciliation now stores the currently tracked ledger balance as the expected value, so future reconciliations chain cleanly from the previous verified baseline.
- Financial Net Worth uses the same post-reconciliation physical-activity logic, keeping dashboard and Wealth calculations consistent.
- The v1.3.3 migration re-runs the narrow duplicate E.SUN purpose-allocation repair using the corrected tracked bank balance. If the virtual ledger is over by exactly the prior reconciliation gap and two identical matching allocations exist, only the duplicate is retired.
- Purpose-only allocations remain non-physical and never change a bank balance.

For the live September 30 case, the correct E.SUN state after the NT$7,972 salary tithe and NT$11,073 Emergency Fund transfer is:

- Confirmed prior E.SUN baseline: NT$59,500
- Salary tithe transfer: +NT$7,972
- Emergency Fund transfer: +NT$11,073
- **Tracked E.SUN balance: NT$78,545**
- Tithe virtual balance: NT$67,472
- Emergency Fund virtual balance: NT$11,073
- **Virtual total: NT$78,545**
