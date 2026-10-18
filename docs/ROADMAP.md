# Wealth OS Roadmap

## Current release track

### v1.18 — Reliability and controlled modularization
Completed:
- Reliability foundation and CI safety net.
- Special Project pure accounting extraction.
- Budget/spending pace extraction.
- Activity normalization, search/filter and daily grouping extraction.

### v1.19 — Special Budgets
Completed:
- Business Trip template with exact reimbursement and fixed daily allowance.
- Custom Special Budget template.
- Refundable deposit/hold tracking and resolution.
- Optional Trip Wallet reserve from operating cash.
- Business Trip pacing, expected reimbursement and projected surplus/shortfall.
- Deliberate conversion of existing legacy Special Projects without duplicating records.

### v1.19.1 — Tracker layout and reimbursement overlap
Completed: responsive reimbursement actions, separate exact/flexible trackers, Activity last.

### v1.19.2 — Composition tracker polish
Completed and accepted on iPhone:
- Move Add Entry to the top of Business Trip detail.
- Exact reimbursement: 100% stacked claims composition; no remaining-spend impression.
- Flexible allowance: category composition + remaining allowance + trip-time marker.
- Preserve all persisted financial data and settlement rules.

### v1.19.3 — Entry form default category
Completed; merged and physically accepted:
- New Business Trip and Special Budget entries prefer Food when the category exists.
- Editing an existing expense preserves its saved category.
- No data model or accounting changes.

## Reliability continuation

### v1.20.0 — IndexedDB and restore integration foundation
Completed, merged and physically accepted (all six iPhone checks PASS):
- Isolated IndexedDB integration harness using dev-only fake-indexeddb.
- Real db.js CRUD, seed, export/import, undo snapshot and atomic restore regression tests.
- Abort import transaction if any record fails synchronously during IDB put.
- Basic account-transfer balance classification.
- Keep IndexedDB schema 3 and financial data model 190 unchanged.

### v1.20.1 — Financial history regression coverage
Completed, merged and physically accepted:
- Test real IndexedDB migrations v182 Household and v190 Special Budget metadata including repeat upgrades and frozen history.
- Test shared closed-month guard and open-month sync persisted writes without mutating completed records.
- Test bank movement versus virtual allocation accounting before/after budget sync.
- Keep model 190 and IndexedDB schema 3 unchanged.

### v1.20.2 — Special Budget settlement and undo safety
Completed, merged and physically accepted:
- Commit and undo related project, personal-ledger, transfer and allocation rows in a single atomic IndexedDB transaction.
- Reject duplicate submissions, unresolved deposits, missing NTD amounts, stale amounts, closed funding periods and accidental partial writes.
- Keep full Business Trip reimbursement and allowance calculation semantics unchanged.
- Add integration tests with synthetic projects and no live data modification.

### v1.20.3 — Wealth and Goals read-side modularization
Implementation in review; iPhone acceptance pending:
- Extract goal progress, status, prerequisite and contribution pace display models from app.js to a pure module.
- Extract Wealth Overview account-health tags and virtual operating-cash availability to the same module.
- Add deterministic tests without changing views, account balances, postings, IndexedDB storage or migrations.
- Keep all new module imports available in the offline PWA service-worker cache.

### Follow-on priorities
1. Continue targeted coverage and incremental module extraction only where it measurably lowers risk.
2. Retain physical iPhone acceptance and external backup requirements for every release.

Persistence, migrations and restore code must not be aggressively refactored without a passing integration safety net.
