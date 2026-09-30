# Wealth OS — v1.5

A local-first PWA for paycheck allocation, monthly budgeting, account reconciliation, virtual purpose buckets, wealth contributions, goals, investments, month-end close, and financial planning insights.

## Release focus

v1.5 is an **Insights & Planning** release built on the v1.4 reliability model. It adds historical interpretation, contribution-rate tracking, scenario planning, goal pace estimates, and a deliberate routing workflow for supplemental income.

The v1.5 upgrade does **not** rewrite balances, reconciliations, transactions, allocations, goals, or funding months. The migration only adds the new planning assumptions and records the new app/data-model version.

## New in v1.5

### 1. Contribution-rate tracking

Wealth OS now calculates:

**Core Wealth contributed ÷ regular take-home income**

You can see:

- current-month contribution rate
- recent average contribution rate
- completed Core Wealth contribution amount
- contribution-rate history across funding months

The Home screen also shows the current contribution rate underneath **Wealth contributed**.

### 2. Monthly comparison

Once at least two funding months exist, the Forecast tab compares the latest month with the previous month for:

- total income
- actual spending
- Core Wealth contributed
- contribution rate

Until enough history exists, the app explicitly says that another month is needed instead of inventing a trend.

### 3. Flexible-spending trends

Food, Dating / Social, Transportation, Gas, Water, and Miscellaneous can be compared against recent history.

Once at least two funding months exist, Wealth OS shows:

- current spending
- recent average spending
- the current monthly cap
- visual indication when the recent average is consistently high or comfortably below the cap

The recent average uses up to the latest three funding months.

### 4. Core Wealth history

The Forecast tab now builds a Core Wealth trend from:

- closed-month snapshots, plus
- the current funding month when available

The app waits for enough snapshots before drawing a trend.

### 5. Annual recorded summary

The current-year summary shows the information actually recorded in Wealth OS:

- total income
- actual expenses
- Tithe allocated
- Emergency Fund additions
- transfers into IBKR
- Core Wealth contributed
- recorded net-worth change when enough snapshots exist

Internal purpose reclassifications (for example, moving already-held E.SUN money from one virtual bucket to another) are not counted as new Core Wealth contributions.

This is a Wealth OS record summary, not a bank-generated tax statement.

### 6. Goal pace estimates

Goal cards now show a pace estimate where sufficient information exists.

Examples:

- `At current pace: Mar 2027 · ~NT$11,000/mo`
- `Expected unlock: Jun 2027`
- `Need contribution history`

Emergency Fund pace uses recent completed Core Wealth contributions, falling back to the current funding plan when there is not yet enough history.

### 7. Three planning scenarios

Forecast now separates **salary growth** from **investment return**.

Three scenarios are shown:

- Conservative
- Base
- Aggressive

Default assumptions are:

| Scenario | Investment return | Annual salary growth |
| --- | ---: | ---: |
| Conservative | 4% | 1% |
| Base | 7% | 3% |
| Aggressive | 9% | 5% |

The existing **Raise → Wealth %** setting controls how much of modeled future salary increases becomes additional monthly wealth capacity. The current default remains 75%.

All assumptions are editable in **Settings**.

### 8. Improved Scenario Lab

The Scenario Lab can now vary independently:

- starting take-home salary
- annual salary growth
- annual investment return
- extra monthly wealth contribution

The simulation keeps Emergency Fund cash at 0% investment return and applies investment returns only to invested capital. When real paycheck history exists, the latest regular take-home amount is used as the starting salary; the Settings value is only a fallback before paycheck history exists.

### 9. Supplemental-income routing assistant

When recording a new non-regular income item, Wealth OS can open a routing assistant.

Supported income types include:

- Bonus
- Reimbursement
- Asset Sale
- Gift / Windfall
- Other Income

The workflow asks whether the income is **Tithe eligible** and then lets you decide what the after-tithe money should do:

- Current wealth priority
- Emergency Fund
- Home Travel Fund
- Equipment Fund
- Investments
- Keep in operating cash

The assistant creates **planned transfers only** for physical bank movements. It does not silently move money or mark a transfer completed.

If the income already lands in the same physical account as its selected virtual bucket, the app records a virtual allocation with **NT$0 physical bank impact**.

### 10. Supplemental-income tithe checks

The monthly Tithe target now reflects all **Tithe-eligible income** linked to the funding month, not only the regular paycheck.

For example:

- salary: NT$80,000
- bonus: NT$20,000 and marked Tithe eligible
- Tithe rate: 10%

Monthly Tithe target becomes **NT$10,000**.

Month Close will flag missing Tithe allocation when Tithe-eligible supplemental income has been recorded but not fully allocated.

### 11. Supplemental-income Next Action

If a non-regular income item still needs routing, the Home screen can surface it as the next action after higher-priority pending bank transfers are clear.

## Core accounting rules remain unchanged

### Expense
Money consumed for goods, services or obligations. Expenses reduce account cash and budget remaining.

### Physical transfer
Money moves from one account to another. Net worth does not change merely because the location changes.

### Virtual allocation
Money stays in the same physical account but receives a purpose. A virtual allocation never changes the physical bank balance.

### Reconciliation
A verified bank balance becomes the authoritative physical baseline. Recorded physical activity after the check rolls the balance forward.

### Adjustment
Use only when a real unexplained bank movement cannot be represented more accurately as income, expense, or transfer.

## Current account structure

### CTBC Operating
Salary and day-to-day operating cash.

Electricity Reserve remains a **virtual reserve inside CTBC** and requires no CTBC → E.SUN transfer.

### E.SUN Reserved
One physical bank balance separated virtually into:

- Tithe
- Emergency Fund
- Home Travel Fund
- Equipment Fund

### IBKR
Tracked through portfolio snapshots and recorded investment contributions.

## Current wealth-routing strategy

1. Build Emergency Fund toward NT$300,000.
2. Once Emergency Fund reaches NT$200,000, Home Travel becomes eligible for NT$10,000/month while remaining capacity continues toward Emergency Fund.
3. Once Emergency Fund reaches its target, remaining wealth capacity can route to investments.

## Upgrade from v1.4

1. Export a backup from Wealth OS if desired.
2. Replace the repository files with the v1.5 files.
3. Commit to `main` and wait for GitHub Pages deployment.
4. Fully close the installed Home Screen PWA.
5. Reopen the PWA.
6. Open **Settings** and verify:
   - **Wealth OS v1.5**
   - **Data model 150**

Existing IndexedDB data stays on the same GitHub Pages origin.

## Recommended first checks

1. Confirm CTBC and E.SUN balances are unchanged from v1.4.
2. Confirm Settings shows v1.5 / data model 150.
3. Open **Forecast** and verify the new Insights & Forecast screen appears.
4. Confirm the current contribution rate reflects completed Core Wealth transfers only.
5. Add a small test supplemental income and use the routing assistant if you want to test that flow; delete any uncompleted planned routing transfer afterward if it was only a test.

## Notes on history

The analytics deliberately become more useful over time:

- one funding month: current-month metrics are available
- two funding months: monthly comparison and category trend logic becomes meaningful
- several months: recent averages and trend charts become more informative
- closed months: provide stable month-end Core Wealth and Financial Net Worth snapshots

Wealth OS does not fabricate missing historical data.

## PWA and data notes

- Local-first; no backend required.
- Data is stored in browser IndexedDB.
- Internal transfers are not expenses.
- Virtual allocations are not physical bank movements.
- Closed months remain protected unless intentionally reopened.
- JSON backup / restore remains supported.
- iPhone safe-area handling remains enabled.
