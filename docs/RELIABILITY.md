# Wealth OS reliability contract

This document records the invariants that future releases must preserve. A feature is not complete if it violates one of these rules even when the UI appears correct.

## Financial invariants

1. **Physical transfer is not an expense.** Moving money between the user's own accounts changes account composition, not net worth or monthly spending.
2. **Purpose allocation is not a bank movement.** Virtual bucket allocation may change purpose balances but must never change a physical account balance.
3. **Completed history is immutable by planning changes.** Editing a budget may refresh an open month's plan, but must not rewrite recorded expenses, completed transfers, allocations, reconciliations or closed-month snapshots.
4. **Closed months are read-only until deliberately reopened.**
5. **Tithe is excluded from Core Wealth and Financial Net Worth.**
6. **Cash withdrawal is CTBC → Cash Wallet.** It becomes spending only when a cash expense is recorded.
7. **Reimbursable Special Budget spending stays outside personal budget statistics.** Exact reimbursements, fixed Business Trip allowances and refundable holds are tracked separately; only a final personal shortfall becomes a personal expense and any surplus is routed explicitly.
8. **Month-end sweep uses recorded reality.** Unused caps/buffer and paid fixed-bill differences may feed the sweep; unpaid fixed bills are never assumed to be savings.
9. **Goal routing obeys prerequisites and targets.** Planned-spending monthly targets are funded only when unlocked; remaining wealth capacity continues to core-wealth goals, then investments.
10. **Restore is atomic.** A failed or invalid restore must not partially replace device data.

## Release checklist

Before a release is merged:

- Run `npm run check`.
- Confirm APP_VERSION, service-worker cache, public defaults and README release identity agree.
- Confirm every service-worker precache asset exists.
- Review any data-model migration separately from presentation changes.
- Never use a migration to rewrite completed financial history unless it is a narrowly defined repair with explicit safeguards.
- Verify backup export and restore validation when persistence code changes.
- Verify the installed PWA on iPhone after service-worker or manifest changes.

## Current automated coverage

The Node test suite covers pure accounting calculations, Special Budget / Business Trip accounting and deposit rules, pacing, Activity normalization/grouping, and release integrity.

**v1.20.0 adds actual js/db.js integration tests** using test-only `fake-indexeddb` (in-memory API simulation): database creation, seed preservation, committed CRUD, opening a second connection, full export/restore round trip, invalid backup rejection, atomic rollback on an uncloneable record, undo snapshot recovery, and physical-vs-purpose transfer balance classification. The CI workflow installs only the test dependency and runs all checks before merging.

**v1.20.1 adds shared live-code integration tests** for model migrations v182 (Household/open-versus-closed month) and v190 (metadata-only Special Budgets), explicit closed-month edit guards, guarded open-month plan synchronization, and physical/virtual transfer invariants before and after a sync. Historical transactions, monthly-close snapshots, legacy Special Budgets, and completed transfers are asserted to stay byte-equivalent across upgrades and planning edits.

**v1.20.2 adds atomic Special Budget settlement/undo transactions** with a fresh-IDB check for stale expenses, unresolved deposits, missing exact NTD values, closed funding periods and prior settlement. Concurrent settlement attempts cannot generate duplicate incomes or settled records. A failed write rolls back all generated records together, and completed routing transfers still prevent unsafe undo. Isolated IndexedDB tests cover success and rejection cases.

**Remaining gaps:** end-to-end controller/UI testing of older legacy migrations, month-close/reopen workflows and complete user-interaction tests. Simulated IndexedDB tests do not prove real-device storage durability or replace iPhone physical acceptance.
