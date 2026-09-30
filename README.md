# Wealth OS — v1.4

A local-first PWA for paycheck allocation, monthly budgeting, account reconciliation, virtual purpose buckets, wealth contributions, goals, investments and month-end close.

## Release focus

v1.4 is a **reliability and auditability release**. It is intentionally conservative: upgrading from v1.3.3 to v1.4 does **not** automatically rewrite balances, transactions, reconciliations, allocations, goals or funding months. The v1.4 migration only records the new app/data-model version.

The main objective is to make every important balance explainable and every correction explicit.

## New in v1.4

### 1. Visible app version and backup status

Settings now shows:

- Installed build: **Wealth OS v1.4**
- Data model: **140**
- Last backup time
- Export Backup / Restore Backup controls

This makes it easy to confirm that the Home Screen PWA has actually refreshed to the intended version.

### 2. CTBC and E.SUN audit trails

From **Wealth → Audit Trail** or **Settings → Reliability tools**, each bank account can be inspected as two separate ledgers:

**Physical bank trail**
- verified bank baseline
- income after that baseline
- expenses after that baseline
- physical transfers in/out
- explicit account adjustments
- running tracked bank balance

**Purpose ledger**
- current virtual bucket balances
- purpose-allocation history
- clear labels showing whether an event was:
  - a physical bank transfer + purpose allocation, or
  - a virtual-only allocation with **NT$0 bank impact**

The audit screen also shows a raw historical ledger cross-check. If the old raw ledger differs from the verified bank trail, the verified bank baseline remains authoritative and the app warns you rather than silently creating a correction.

### 3. Reversible virtual allocations

Manual virtual-purpose allocations can now be reversed from the audit trail.

A reversal:
- creates a new audit record instead of deleting history
- changes virtual buckets only
- has **no physical bank impact**
- is blocked if reversing it would push a bucket below zero
- cannot reverse protected system-generated allocations

### 4. E.SUN purpose reallocation

A new **Reallocate Purpose** action lets you move existing E.SUN money from one virtual bucket to another without changing the physical E.SUN bank balance.

Example:

- Tithe −NT$5,000
- Emergency Fund +NT$5,000
- E.SUN bank balance impact: **NT$0**

This is the correct tool when the money already exists in E.SUN but its purpose was classified incorrectly.

### 5. Safer bank reconciliation

**Update Balance** is now a two-step process:

1. Enter the exact balance shown by the bank.
2. Review the impact before saving the new baseline.

The preview shows:
- current tracked balance
- bank balance entered
- difference being acknowledged
- date checked
- E.SUN purpose-allocation impact, when applicable

Saving a reconciliation creates a new verified bank baseline only. It does not create a fake expense, income or transfer.

### 6. Transfer impact previews

Before confirming payday or planned transfers, Wealth OS now explicitly shows:

- physical source account decrease
- physical destination account increase
- virtual bucket increase, when applicable
- **spending impact: NT$0**

Manual bank transfers also go through a review screen before being saved.

### 7. Clear physical vs virtual labels in Activity

Activity now describes records as:

- **Physical expense**
- **Physical income**
- **Physical bank transfer**
- **Virtual only · bank impact NT$0**

This reduces the chance of treating an allocation as new money or treating a transfer as spending.

### 8. Reconciliation date reliability fix

Post-reconciliation income roll-forward now uses the income's actual `dateReceived` field. This ensures salary or other income recorded after a bank check is included correctly in the tracked account balance.

## Core accounting rules

Wealth OS keeps these concepts separate:

### Expense
Money consumed for goods, services or obligations. Expenses reduce account cash and budget remaining.

### Physical transfer
Money moves from one account to another. Net worth does not change merely because the location changes.

### Virtual allocation
Money stays in the same physical bank account but receives a purpose such as Tithe, Emergency Fund or Electricity Reserve. A virtual allocation must never change the physical account balance.

### Reconciliation
A verified bank balance becomes the authoritative physical baseline. Recorded physical activity after that check rolls the balance forward.

### Adjustment
Used only when a real unexplained bank change cannot be represented more accurately as income, expense or transfer.

## Current account structure

### CTBC Operating
Used for salary and day-to-day operating cash.

Electricity Reserve is a **virtual reserve inside CTBC**, so funding it does not require a bank transfer.

### E.SUN Reserved
Physically one bank balance, separated virtually into:

- Tithe
- Emergency Fund
- Home Travel Fund
- Equipment Fund

### IBKR
Tracked using portfolio snapshots and investment contributions.

## Current monthly budget defaults

- Tithe: 10% of eligible income
- Rent: NT$23,000
- Sister's rent: NT$7,600
- Family support: NT$3,500
- SIM: NT$799
- Wi-Fi: NT$899
- Gym: NT$1,088
- Apple One: NT$390
- iCloud: NT$300
- Food: NT$10,000 cap
- Dating / Social: NT$3,000 cap
- Transportation: NT$1,100
- Gas: NT$200
- Water: NT$400
- Miscellaneous: NT$1,000
- Electricity Reserve: NT$4,400
- Operating Buffer: NT$3,000

Funding months store a snapshot of the rules used when the paycheck was entered. Changing Settings later does not rewrite old monthly plans.

## Wealth routing

The current strategy remains:

1. Build Emergency Fund toward NT$300,000.
2. Once Emergency Fund reaches NT$200,000, Home Travel becomes eligible for NT$10,000/month while remaining capacity continues to Emergency Fund.
3. After the Emergency Fund target is complete, remaining wealth capacity can route to investments.

## Upgrade from v1.3.3

1. Back up Wealth OS first if desired.
2. Replace the repository files with the v1.4 files.
3. Commit to `main` and wait for GitHub Pages to redeploy.
4. Fully close the installed Home Screen PWA.
5. Reopen it.
6. Open **Settings** and verify it says **Wealth OS v1.4** and **Data model 140**.

Your existing IndexedDB data remains on the same GitHub Pages origin.

## Recommended first checks after upgrading

1. Open **Wealth** and confirm CTBC and E.SUN balances are unchanged from v1.3.3.
2. Open **E.SUN Audit Trail** and verify physical transfers and virtual allocations are shown separately.
3. Open **Settings** and confirm the v1.4 version indicator.
4. Export a backup and confirm the Last Backup value updates.
5. The next time you update a bank balance, verify the new review screen appears before the baseline is saved.

## PWA and data notes

- Local-first; no backend is required.
- Data is stored in browser IndexedDB.
- Internal transfers are not expenses.
- Virtual allocations are not physical bank movements.
- Closed months remain protected unless intentionally reopened.
- JSON backup/restore remains supported.
- iPhone safe-area handling remains enabled for the bottom navigation and Home indicator.
