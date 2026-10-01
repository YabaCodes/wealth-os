# Wealth OS — v1.7.1

A local-first PWA for paycheck allocation, monthly budgeting, account reconciliation, virtual purpose buckets, wealth contributions, goals, investments, month-end close, and personal financial planning.

## Release focus

v1.7.1 is a **branding / PWA icon update**. It integrates the selected Wealth OS wealth-symbol logo without changing the accounting engine or any financial data.

## What is new in v1.7.1

### New Wealth OS app icon

The selected teal/navy wealth-symbol artwork is now used for:

- iPhone/iPad Home Screen via `apple-touch-icon`
- PWA manifest icons
- browser/favicon display
- Android/other installable PWA surfaces that use the web manifest

The source artwork is cropped to a full-bleed square before resizing so the operating system can apply its own rounded icon mask without leaving white corner artifacts.

Included icon assets:

- `icons/icon-32.png`
- `icons/icon-180.png`
- `icons/icon-192.png`
- `icons/icon-512.png`
- `icons/icon-1024.png`

### PWA cache refresh

The service-worker cache is bumped to `wealth-os-v1-7-1` and includes the new PNG icon assets.

## Data safety

The v1.7.1 migration advances the installed build to **Data model 171** only so Settings can confirm the deployed release. It does **not** alter:

- CTBC or E.SUN balances
- income or expenses
- transfers
- virtual allocations
- reconciliations or adjustments
- goals
- funding months
- snapshots
- IBKR records

## Upgrade from v1.7

1. Replace the existing repository files with the v1.7.1 files.
2. Commit to `main` and wait for GitHub Pages deployment.
3. Fully close and reopen the installed PWA.
4. Open **Settings** and confirm:
   - **Wealth OS v1.7.1**
   - **Data model 171**
5. Confirm your financial balances are unchanged.

### Important for the iPhone Home Screen icon

iOS can keep the old icon cached even after the website updates. If the Home Screen still shows the old `W` icon after deployment, remove only the Home Screen shortcut/app icon and add the site to Home Screen again. Your Wealth OS IndexedDB data remains associated with the same GitHub Pages origin, but exporting a JSON backup first is still recommended before removing/re-adding the PWA.

## Recommended verification

After deployment:

1. Confirm Settings reports v1.7.1 / Data model 171.
2. Confirm CTBC, E.SUN, Tithe, Emergency Fund, IBKR, and the current funding month are unchanged.
3. Confirm the new Wealth OS icon appears after re-adding the PWA to the Home Screen if iOS retained the old cached icon.
