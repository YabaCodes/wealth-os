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

**v1.20.3 extracts read-only Wealth/Goals view models** from the UI controller and tests goal progression, prerequisites, contribution pacing, account reconciliation labels, E.SUN virtual allocation states and operating cash after Trip Wallet reserves. Calculations remain side-effect-free, while the UI uses the shared helpers. No physical-bank accounting or database writes were changed.

**v1.21.0 adds a shared close-readiness gate and atomic close/reopen persistence.** The actual UI-generated close snapshot and period state are committed in one IndexedDB transaction; failed writes roll back both records. The transaction rejects duplicate closes and changed period previews. Reopen preserves the existing audit snapshot, and intentional re-close replaces only that month's snapshot. Integration tests cover readiness blockers (pending transfers, tithe, sweep, funding, bank reconciliation), snapshot integrity, interrupted writes and retries, stale edits, closed-month budget-sync rejection, and physical-versus-virtual/cash ledger invariants.

**v1.21.1 shares the reconciliation baseline and roll-forward implementation** between the account-detail UI and the persisted-wealth/net-worth calculation. Synthetic integration tests verify latest check selection, same-day timestamps, excluded historical and deleted entries, Cash Wallet movements, pending/purpose-only transfers, E.SUN allocation imbalances, tithe exclusion and the consistency of account snapshots with net-worth totals. No financial write paths were modified.

**v1.21.2 adds full-browser Playwright acceptance** using synthetic, private-origin IndexedDB fixtures and the normal unmodified app controls. Desktop and mobile Chromium test navigation, expense entry, month close/reopen, pending Business Trip refundable holds, Food category default, settlement and undo, and backup rejection. The new CI browser job runs separately from Node integration tests and retains failure traces and screenshots.

**v1.22.0 adds the first user-facing Goals scenario planner**, deliberately limited to read-only calculations. A hypothetical extra monthly contribution never changes persisted goals, actual allocations, physical accounts, budgets or transfers. Pure unit tests and desktop/mobile Chromium acceptance cover forecast arithmetic, goal prerequisite/paused/completed constraints, no writes, ephemeral inputs and privacy-mode masking.

**v1.22.1 adds computed style accessibility regression coverage** to the Goals what-if browser tests: small labels, highlighted ETA values and supporting copy must meet a minimum 4.5:1 foreground/background contrast in Light, explicit Dark and System-Dark themes. The fix is CSS-only apart from release identifiers.

**v1.22.2 extends the read-only Goals scenario planner with target-date funding math.** Unit tests assert explicit month-end timing, correct contribution counts and rounding, already-complete/paused/waiting safeguards, and a budget-reference warning rather than an affordability guarantee. Desktop/mobile browser acceptance verifies no IndexedDB changes from selecting dates or hypothetical planning modes, including in Dark/privacy modes.

**v1.22.3 adds a read-only Goals portfolio**, using saved priorities, completed allocation pace, target-date model and one shared monthly wealth-funding reference. Unit tests prevent double-counting planned capacity across active goals, including missing/locked/paused deadline states. Desktop/mobile browser tests check navigation to the existing planner, full financial-record immutability, dark mode and privacy masking.

**Remaining gaps:** exhaustive UI/controller flows, older historical migrations, and real iPhone Safari/WebKit behavior. Neither simulated IndexedDB nor Chromium mobile emulation proves device storage durability; physical iPhone acceptance remains required.
