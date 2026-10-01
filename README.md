# Wealth OS — v1.7.3

A local-first PWA for budgeting, account reconciliation, cash handling, purpose buckets, wealth tracking, goals, month close, and financial planning.

## Release focus

v1.7.3 adds **Cash Wallet** and **Privacy Mode**. Existing financial records are not rewritten.

## Cash Wallet

Cash is treated as a physical account, not an expense category.

- **Withdraw Cash:** CTBC Operating → Cash Wallet. Spending impact: NT$0.
- **Spend Cash:** choose **Cash Wallet** as the account on an expense. Only then does the amount count as spending.
- **Deposit Cash:** Cash Wallet → CTBC Operating. Income impact: NT$0.
- Cash Wallet can only move to/from **CTBC Operating** through the dedicated cash controls.
- You can use **Count Cash** to establish an exact physical-cash baseline when needed.
- If an ATM fee exists, record the fee separately as a real expense.

Cash Wallet is included in Financial Net Worth because moving money from CTBC to cash does not change total wealth.

## Privacy Mode

A persistent eye/eye-off control now appears beside Settings.

When Privacy Mode is enabled, displayed currency amounts are masked across the app while labels, dates, percentages, progress bars and statuses remain visible. The preference is stored locally and remains active when the PWA is reopened.

Form inputs are not altered, so normal data entry still works.

## Data model

- App version: **1.7.3**
- Data model: **173**
- A zero-balance `Cash Wallet` account is added if it does not already exist.
- `privacyMode` is added to local Settings.
- Existing balances, transactions, allocations, reconciliations, goals and funding months are left unchanged.

## Upgrade

1. Replace the repository files with this release and commit to `main`.
2. Wait for GitHub Pages to deploy.
3. Fully close and reopen the Home Screen PWA.
4. Confirm **Settings → Wealth OS v1.7.3 / Data model 173**.
5. Open **Wealth → Cash Wallet**. It should start at **NT$0** unless you record a withdrawal.
6. Test Privacy Mode with the eye icon in the top-right header.

## Quick cash test

1. Record a NT$1,000 cash withdrawal.
2. CTBC should fall by NT$1,000 and Cash Wallet should rise by NT$1,000.
3. Financial Net Worth should not change.
4. Record a NT$200 Food expense using Cash Wallet.
5. Cash Wallet should become NT$800 and expenses should increase by NT$200.
