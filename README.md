# Wealth OS — v1.7

A local-first PWA for paycheck allocation, monthly budgeting, account reconciliation, virtual purpose buckets, wealth contributions, goals, investments, month-end close, and personal financial planning.

## Release focus

v1.7 is the **Month Operations & Data Health** release. It strengthens the end-of-month workflow and makes historical data easier to trust without changing any existing financial balances or transactions during the upgrade.

## What is new in v1.7

### Guided five-step month close

The Month-End Review now walks through the close in a fixed order:

1. Transactions and recurring obligations
2. Payday allocations
3. CTBC / E.SUN reconciliation
4. Month-end sweep
5. Snapshot and lock

The app still blocks closure when required transfers, reconciliation, or sweep work is incomplete. Missing fixed obligations remain visible for explicit review rather than being silently converted into expenses.

### Rich month-end snapshots

When a month is closed, Wealth OS now stores a richer read-only snapshot containing:

- regular and total income
- expenses
- Core Wealth contribution and contribution rate
- ending Core Wealth
- ending Financial Net Worth
- CTBC tracked balance
- E.SUN tracked balance
- IBKR value in TWD
- all virtual bucket balances
- Emergency Fund, Tithe, Home Travel and Electricity Reserve balances
- FX rate used at close
- budget plan and category actuals
- a Data Health summary

This makes future trend and year-over-year reporting less dependent on reconstructing old balances from today's ledger.

### Data Health

Settings now includes **Data Health**. It is a read-only diagnostic that checks for:

- missing or stale CTBC/E.SUN reconciliations
- E.SUN purpose-allocation mismatch
- negative virtual buckets
- planned transfers still pending
- supplemental income that still needs routing
- exact duplicate-record patterns
- old funding months that are still open
- closed months missing a close snapshot
- stale or missing JSON backup

Data Health never changes or deletes records automatically. It tells you what needs review and links to the relevant account audit where appropriate.

### Funding-month navigation

Month selectors now include older/newer controls so you can move through funding months without reopening the dropdown each time. Month state remains visible in the selector.

### Recurring-obligation clarity

The Budget screen now labels fixed items as **Recurring obligations**. They automatically appear as expectations in each new funding month, but Wealth OS still creates a real expense only when you record the payment. This preserves the rule that planned obligations are not fake spending.

### Forecast transparency

The Forecast screen now shows exactly what the Base forecast is using before presenting milestone dates:

- take-home salary baseline
- current Emergency Fund
- starting monthly wealth capacity
- Emergency Fund target
- NT$200,000 Home Travel unlock threshold
- Home Travel monthly routing after unlock
- current investment balance
- percentage of future salary raises captured into wealth

It also explicitly states that Emergency Fund cash earns 0% in the model and investment-return assumptions apply only to IBKR.

## Data safety

The v1.7 migration advances the installed build to **Data model 170** and marks existing fixed-budget categories as monthly expected obligations. It does **not** alter:

- CTBC or E.SUN balances
- income or expenses
- transfers
- purpose allocations
- reconciliations or adjustments
- goals
- existing funding months
- IBKR snapshots

Existing closed-month snapshots remain valid. New richer snapshot fields are added only when a month is closed under v1.7.

## Upgrade from v1.6.1

1. Replace the existing repository files with the v1.7 files.
2. Commit to `main` and wait for GitHub Pages deployment.
3. Fully close the installed Home Screen PWA.
4. Reopen it.
5. Open **Settings** and confirm:
   - **Wealth OS v1.7**
   - **Data model 170**
6. Confirm CTBC, E.SUN, Tithe, Emergency Fund and IBKR values are unchanged.
7. Open **Settings → Data Health** and review the result.

Your IndexedDB data remains on the same GitHub Pages origin.

## Recommended first test

Do not close the real October month early. Instead:

1. Open **Budget → Month-End Review** and inspect the five-step checklist.
2. Confirm the snapshot preview matches the current ledger.
3. Open **Settings → Data Health** and confirm any warnings are understandable and actionable.
4. Continue using October normally.
5. At actual month-end, reconcile CTBC and E.SUN, complete the sweep, then save the snapshot and close the month.
