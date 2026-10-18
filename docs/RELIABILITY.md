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

**Remaining gaps:** broader end-to-end app migration and month-close tests, open-month budget synchronization, UI and iPhone Safari flows, and Special Budget settlement/undo integration. Simulated IndexedDB tests do not prove real-device storage durability or replace iPhone physical acceptance.
