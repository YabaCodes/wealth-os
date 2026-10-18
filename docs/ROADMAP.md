# Wealth OS Roadmap

## Current release track

### v1.18 — Reliability and controlled modularization
Completed:
- Reliability foundation and CI safety net.
- Special Project pure accounting extraction.
- Budget/spending pace extraction.
- Activity normalization, search/filter and daily grouping extraction.

### v1.19 — Special Budgets
In progress:
- Business Trip template with exact reimbursement and fixed daily allowance.
- Custom Special Budget template.
- Refundable deposit/hold tracking and resolution.
- Optional Trip Wallet reserve from operating cash.
- Business Trip pacing, expected reimbursement and projected surplus/shortfall.
- Deliberate conversion of existing legacy Special Projects without duplicating records.

## Resume after v1.19 acceptance

Once v1.19 is physically accepted, return to the controlled hardening work that was underway before the feature request:

1. Continue low-risk modularization with Wealth/goal presentation and read-side helpers.
2. Add persistence/integration test infrastructure before refactoring IndexedDB-heavy code.
3. Add regression coverage for migrations, especially legacy transfer/accounting repairs and the current data-model migration path.
4. Add backup/restore atomicity tests.
5. Add closed-month edit-protection integration tests.
6. Add physical-vs-purpose transfer integration tests.
7. Add open-month plan-sync tests proving completed financial history is never rewritten.
8. Expand Special Budget settlement/undo integration coverage.

Persistence, migrations and restore code should not be aggressively refactored until the integration safety net exists.
