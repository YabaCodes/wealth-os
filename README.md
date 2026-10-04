# Wealth OS — v1.10.1

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

- App version: **1.10.1**
- Data model: **181**
- Service-worker cache: **wealth-os-v1-10-1**
- Manifest: **manifest.webmanifest**

## Upgrade

Replace the repository files with this package, commit to `main`, wait for GitHub Pages to deploy, then fully close and reopen the installed PWA. Confirm **Settings → Wealth OS v1.10.1 / Data model 181**.
