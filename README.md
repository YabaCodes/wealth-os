# Wealth OS — v1.7.4

## Budget Sync + Spending Insights

v1.7.4 keeps the v1.7.3 accounting model intact and adds two usability improvements.

### Current-month budget sync
- Settings remain the default template for future funding months.
- When the selected funding month is still open, **Apply changes to the current month** can refresh that month's saved budget plan.
- Existing expenses, income, transfers, reconciliations, allocations and closed months are never rewritten.
- This fixes cases such as raising Family Support from NT$3,500 to NT$3,600 while October is already active.
- Rebuilding the open plan also refreshes the planned immediate-wealth target; completed transfers remain historical facts and are not reversed automatically.

### Spending pace insights
The bottom **Forecast** tab is now labeled **Insights** and starts with a Spending Pace section for flexible capped categories. Each category shows:
- monthly cap and spending to date
- budget used vs month elapsed
- expected spend by today on an even calendar pace
- current run-rate projection for month end
- safe daily spending for the remaining days
- status: Under pace, On track, Ahead of pace, Watch pace, Likely over, or Over budget
- forecast confidence that is deliberately softer during the first five days of the month
- a compact cumulative-spending chart showing target pace, actual spending, and current projection

Daily pace is directional for irregular categories such as Gas or Water; it is most useful for recurring flexible spending such as Food and Transportation.

### Release metadata
- App version: **1.7.4**
- Data model: **174**
- Service-worker cache: **wealth-os-v1-7-4**
- Manifest: **manifest-v174.webmanifest**
- No automatic financial-record migrations are performed.

### Upgrade
Replace the repository files with this package, commit to `main`, wait for GitHub Pages to deploy, then fully close and reopen the installed PWA. Confirm **Settings → Wealth OS v1.7.4 / Data model 174**.
