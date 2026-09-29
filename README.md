# Wealth OS — v1.2.1

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
- E.SUN virtual buckets keep Tithe, Emergency Fund, Electricity Reserve, Home Travel and Equipment Fund separate even though the bank sees one balance.
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
