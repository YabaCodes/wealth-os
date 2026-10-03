# Wealth OS — v1.8

## Special Projects + Reimbursements

v1.8 keeps the v1.7.4 budgeting, spending-pace, cash-wallet, privacy and data-health workflows intact and adds an isolated ledger for reimbursable trips or other temporary special-purpose spending.

### Special Projects
- Create a project yourself and give it any title you want.
- Edit the title, dates and default currency while the project is active.
- Access projects from Activity or Home Quick Capture.
- Project expenses stay completely separate from normal monthly Food, Transportation, Social and other budget caps.
- Project expenses also stay outside physical account balances until settlement; Wealth OS uses a net-settlement model rather than creating a separate credit-card account.

### Multi-currency expense tracking
Each project expense stores:
- original amount
- original currency (EUR, TWD, USD, GBP, CHF or JPY)
- exact NTD amount when known
- category (Hotel, Car Rental, Food, Gas, Transport, Business or Other)
- payment method (E.SUN credit card, Cash or Other)
- date and description

For E.SUN card purchases, enter the exact NTD amount from the card notification. For cash expenses, you can leave NTD blank temporarily. Settlement is blocked until every project expense has an NTD equivalent.

### Reimbursement settlement
When the company reimbursement arrives in CTBC, enter the total reimbursement once. Wealth OS compares it with the total project cost and calculates:
- fully reimbursed: no personal-ledger impact
- surplus: only the surplus becomes personal income in CTBC
- shortfall: only the unreimbursed difference becomes a personal Project Shortfall

Gross project reimbursement and card repayment are intentionally netted outside the monthly budget. This avoids mixing reimbursable business spend into personal spending statistics while still making the final personal gain/loss explicit.

### Surplus routing
If the project closes with a surplus, choose to:
- keep it in CTBC Operating
- route it to Emergency Fund
- route it to Home Travel Fund
- route it to Equipment Fund
- route it to Investments

Goal/investment routing is created as a planned transfer and must still be marked completed after you physically move the money.

### E.SUN card clearing
The project dashboard shows the total NTD value of project expenses paid on the E.SUN credit card. After reimbursement, Wealth OS reminds you to fund E.SUN from CTBC for that card-paid amount. This is tracked as a project workflow confirmation only because the matching credit-card debit is outside Wealth OS and the two movements cancel in the net-settlement model.

### Safety and auditability
- Project settlement can be undone while any generated surplus transfer is still uncompleted.
- Completed real bank transfers are protected from automatic reversal.
- Data Health warns about project expenses missing NTD values and unconfirmed E.SUN card funding.
- Project CSV export is available for reimbursement/audit use.
- JSON backup/restore includes projects, project expenses and settlements.

### Release metadata
- App version: **1.8**
- Data model: **180**
- IndexedDB version: **3**
- Service-worker cache: **wealth-os-v1-8**
- Manifest: **manifest-v180.webmanifest**

### Upgrade
Replace the repository files with this package, commit to `main`, wait for GitHub Pages to deploy, then fully close and reopen the installed PWA. Confirm **Settings → Wealth OS v1.8 / Data model 180**. Existing financial records are not rewritten by this upgrade.
