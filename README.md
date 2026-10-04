# Wealth OS — v1.9.0

## Theme selector

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

- App version: **1.9.0**
- Data model: **181**
- Service-worker cache: **wealth-os-v1-9-0**
- Manifest: **manifest-v181.webmanifest**

## Upgrade

Replace the repository files with this package, commit to `main`, wait for GitHub Pages to deploy, then fully close and reopen the installed PWA. Confirm **Settings → Wealth OS v1.9.0 / Data model 181**.
