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
PR prepared; physical iPhone acceptance pending:
- New Business Trip and Special Budget entries prefer Food when the category exists.
- Editing an existing expense preserves its saved category.
- No data model or accounting changes.

## Resume after v1.19.3 physical acceptance

After v1.19.3 is physically accepted, return to the controlled hardening work that was underway before the feature request:

1. Continue low-risk modularization with Wealth/goal presentation and read-side helpers.
2. Add persistence/integration test infrastructure before refactoring IndexedDB-heavy code.
3. Add regression coverage for migrations, especially legacy transfer/accounting repairs and the current data-model migration path.
4. Add backup/restore atomicity tests.
5. Add closed-month edit-protection integration tests.
6. Add physical-vs-purpose transfer integration tests.
7. Add open-month plan-sync tests proving completed financial history is never rewritten.
8. Expand Special Budget settlement/undo integration coverage.

Persistence, migrations and restore code should not be aggressively refactored until the integration safety net exists.
