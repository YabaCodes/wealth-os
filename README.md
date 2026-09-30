# Wealth OS — v1.6

A local-first PWA for paycheck allocation, monthly budgeting, account reconciliation, virtual purpose buckets, wealth contributions, goals, investments, month-end close, and personal financial planning.

## Release focus

v1.6 is a **Quality-of-Life & Local Automation** release. It reduces repetitive entry work without changing the accounting model that was stabilized in v1.4 and expanded with insights in v1.5.

The v1.6 migration does **not** create, delete, reclassify, or rewrite any financial transactions, balances, reconciliations, virtual allocations, goals, or funding months. It only updates the app/data-model version.

## New in v1.6

### 1. Home quick capture

The Home screen now includes compact shortcuts for:

- Expense
- Income
- Transfer

It also shows the three most recent entries for the selected funding month, so routine entry does not require opening Activity first.

### 2. One-tap fixed-obligation workflow

The Budget screen now has a **Fixed obligations** checklist.

For each fixed item, Wealth OS shows:

- planned amount
- amount already recorded
- whether it is paid, partially recorded, or still outstanding
- the exact remaining amount

For an outstanding obligation, **Record NT$…** opens a prefilled expense form for the remaining amount. The entry is not saved until you confirm it.

This is designed for recurring items such as Rent, Sister's Rent, Family Support, SIM, Wi-Fi, Gym, Apple One, and iCloud.

### 3. Repeat expense

Expenses in Activity now have a **Repeat** action.

Repeat opens a new expense entry with the previous:

- amount
- category
- account
- funding bucket
- description

The date defaults to **today**, and the new entry goes to the currently open funding month. It does not duplicate the old record automatically.

### 4. Activity search

Activity can now be searched by:

- description
- category/title
- account or ledger
- date text

Search works together with the existing All / Expenses / Income / Transfers filters.

### 5. CSV exports

Settings now includes two spreadsheet-friendly exports:

**Activity CSV**
- date
- type
- status
- title
- description
- account / ledger
- amount
- funding month

**Monthly CSV**
- funding month
- state
- regular income
- total income
- expenses
- Core Wealth contribution
- contribution rate
- Core Wealth
- Financial Net Worth

These exports do not replace the full JSON backup. JSON remains the restore format.

### 6. Backup freshness indicator

Settings now shows whether the last JSON backup is:

- today
- a certain number of days old
- more than 30 days old
- not yet created

This is informational only; Wealth OS does not upload your data anywhere.

### 7. Safer entry-period behavior

Quick-entry and Repeat actions use an **open funding month**. If the currently viewed month is closed, Wealth OS uses the latest open month instead of attempting to write into a locked period.

### 8. Version-safe migration chain

The v1.5 migration is now explicitly pinned to data model 150 before v1.6 advances to model 160. This prevents a later global version constant from accidentally causing an older migration to claim the newer model version.

## Accounting rules remain unchanged

### Expense
Money actually consumed for goods, services, or obligations. It reduces the relevant physical account and budget remaining.

### Physical transfer
Money moves between physical accounts. It is not spending and does not change net worth by itself.

### Virtual allocation
Money stays in the same physical account but receives a purpose. Virtual allocations never change bank balances.

### Reconciliation
A verified bank balance is the authoritative physical baseline. Recorded physical activity after that check rolls the tracked balance forward.

### Electricity Reserve
The Electricity Reserve remains a **virtual reserve inside CTBC Operating**. It is not transferred to E.SUN.

### E.SUN
E.SUN remains one physical account with virtual purpose buckets such as:

- Tithe
- Emergency Fund
- Home Travel Fund
- Equipment Fund

## Upgrade from v1.5

1. Export a JSON backup if desired.
2. Replace the existing repository files with the v1.6 files.
3. Commit to `main` and wait for GitHub Pages deployment.
4. Fully close the installed Home Screen PWA.
5. Reopen it.
6. Open **Settings** and confirm:
   - **Wealth OS v1.6**
   - **Data model 160**

Your IndexedDB data remains on the same GitHub Pages origin.

## Recommended first checks

1. Confirm CTBC and E.SUN balances are unchanged.
2. Confirm Settings shows v1.6 / data model 160.
3. On Home, test the three Quick Capture buttons without saving if you only want to inspect them.
4. In Budget, verify already-recorded Rent / Sister's Rent items appear as paid and outstanding fixed obligations show the correct remaining amount.
5. In Activity, use Repeat on a small expense and confirm the new form defaults to today's date.
6. Test Activity search.
7. Export both CSV files and confirm they open correctly in your spreadsheet app.

## Data safety

- Local-first; no backend required.
- JSON backup remains the authoritative portable backup.
- CSV files are for analysis/export only and cannot restore the app.
- v1.6 does not modify existing financial ledger records during migration.
