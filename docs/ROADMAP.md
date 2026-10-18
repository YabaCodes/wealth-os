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
Implementation prepared; GitHub CI and physical iPhone acceptance required:
- Isolated IndexedDB integration harness using dev-only fake-indexeddb.
- Real db.js CRUD, seed, export/import, undo snapshot and atomic restore regression tests.
- Abort import transaction if any record fails synchronously during IDB put.
- Basic account-transfer balance classification.
- Keep IndexedDB schema 3 and financial data model 190 unchanged.

### Follow-on priorities
1. v1.20.1 — integration coverage for app migration paths, physical-vs-purpose transfer workflows, closed-month protections and open-month plan sync.
2. v1.20.2 — Special Budget settlement, undo and reimbursement integration tests.
3. v1.20.3 — controlled modularization of Wealth/goal presentation and read-only helpers, protected by established tests.

Persistence, migrations and restore code must not be aggressively refactored without a passing integration safety net.
