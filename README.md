# Wealth OS — v1.6.1

A local-first PWA for paycheck allocation, monthly budgeting, account reconciliation, virtual purpose buckets, wealth contributions, goals, investments, month-end close, and personal financial planning.

## Release focus

v1.6.1 is a focused **annual Tithe reporting correction**. It does not change your balances, transactions, reconciliations, funding months, goals, or virtual-bucket history.

## Fixed in v1.6.1

### Tithe annual summary now counts contributions, not bookkeeping corrections

The Forecast screen previously used every positive Tithe allocation in the selected year. That could overstate the annual total when an existing E.SUN balance was reclassified, corrected, or later reversed.

The summary now reports **Tithe contributed** as the net new Tithe additions recorded during the year. It:

- includes genuine physical Tithe transfers
- includes direct assignment of previously unassigned Tithe cash
- nets later reductions/reversals against those assignments
- excludes pure purpose reallocations between existing E.SUN buckets

For the current 2026 records discussed during testing, this means the annual total should represent the genuine NT$4,500 bonus tithe plus the NT$7,972 salary tithe, rather than counting the old NT$4,500 correction twice.

### Wording clarified

The annual card is renamed from **Tithe allocated** to **Tithe contributed** so the metric describes new money contributed to Tithe during the year, not the current Tithe balance or all virtual-ledger activity.

## Data safety

The v1.6.1 migration only updates the installed app/data-model version. It does **not** modify or delete financial ledger records. Existing correction and reallocation records remain visible in the audit trail; the annual summary simply interprets them correctly.

## Upgrade from v1.6

1. Replace the existing repository files with the v1.6.1 files.
2. Commit to `main` and wait for GitHub Pages deployment.
3. Fully close the installed Home Screen PWA.
4. Reopen it.
5. Open **Settings** and confirm:
   - **Wealth OS v1.6.1**
   - **Data model 161**

Your IndexedDB data remains on the same GitHub Pages origin.

## Recommended checks

1. Confirm CTBC and E.SUN balances are unchanged.
2. Confirm E.SUN Tithe and Emergency Fund bucket balances are unchanged.
3. Open **Forecast → 2026 recorded summary**.
4. Confirm the card says **Tithe contributed**.
5. With the current test history, the expected value is **NT$12,472** if the only genuine 2026 Tithe contributions are NT$4,500 and NT$7,972.
6. Confirm **Emergency added** remains NT$11,073 and other annual metrics are unchanged.
