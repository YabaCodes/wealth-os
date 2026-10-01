# Wealth OS — v1.7.2

A local-first PWA for paycheck allocation, budgeting, account reconciliation, purpose buckets, wealth tracking, goals, month close, and financial planning.

## Release focus

v1.7.2 is an **iPhone Home Screen icon cache-busting patch**. It does not change the accounting engine or any financial records.

The v1.7.1 artwork was correct, but it reused the same icon filenames (`icon-180.png`, `icon-192.png`, etc.). Safari/iOS can retain those icon URLs aggressively even after the Home Screen web app is removed and added again.

## What changed

### Unique icon URLs

The selected Wealth OS logo is now published with completely new filenames:

- `icons/wealth-os-v172-32.png`
- `icons/wealth-os-v172-180.png`
- `icons/wealth-os-v172-192.png`
- `icons/wealth-os-v172-512.png`
- `icons/wealth-os-v172-1024.png`

`index.html` now points the Apple touch icon directly to the new 180 px filename.

### New manifest URL

The PWA now uses `manifest-v172.webmanifest` instead of reusing the old manifest URL. The manifest includes 192, 512 and high-resolution 1024 px opaque full-bleed icons and an explicit app `id`.

### New service-worker cache

The cache is now `wealth-os-v1-7-2` and references only the new icon/manifest URLs.

## Data safety

The v1.7.2 migration advances Settings to **Data model 172** only. It does not modify balances, transactions, allocations, reconciliations, goals, months, snapshots, or investment records.

## Upgrade

1. Replace/upload the v1.7.2 repository files and commit to `main`.
2. Wait for GitHub Pages to finish deploying.
3. Open Wealth OS in normal Safari and refresh once.
4. Open Settings and confirm **Wealth OS v1.7.2 / Data model 172**.
5. Optional verification before re-adding: open `icons/wealth-os-v172-180.png` from the deployed site and confirm the teal/navy Wealth OS symbol appears.
6. Remove the existing Wealth OS Home Screen web app.
7. From the refreshed Safari page, choose **Add to Home Screen** again.

Because the icon and manifest URLs are new, iOS should no longer be able to satisfy the request with the old `W` icon cached under the previous filenames.
