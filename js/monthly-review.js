// v1.23.0 — read-only monthly financial review.
// Inputs are derived from the SAME period, plan, reconciliations and close
// readiness paths used by Budget / Wealth / Month-End Review.
// No DOM, IndexedDB, account movements or forecast write operations.
const safe = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;

export function monthlyChangeFor(current, previous) {
  if (previous === null || previous === undefined) return null;
  const from = safe(previous), to = safe(current);
  const delta = to - from;
  return {
    previous: from, current: to, delta,
    percent: Math.abs(from) > 0.005 ? (delta / Math.abs(from)) * 100 : null,
  };
}

export function monthlyFinancialReviewFor({
  period, plan, periodRecord, previousRecord = null, actuals = {},
  completedWealth = 0, personalExpenses = 0,
  closeReadiness = null, accountChecks = null,
}) {
  if (!period) return null;
  const closed = period.state === "closed";
  const lines = Array.isArray(plan?.lines) ? plan.lines : [];
  const spendingLines = lines.filter((l) => ["fixed", "cap"].includes(l.ruleType));
  const trackedBudget = spendingLines.reduce((s, l) => s + Math.max(0, safe(l.budgetAmount)), 0);
  const trackedSpent = spendingLines.reduce((s, l) => s + safe(actuals[l.id]), 0);
  const totalSpent = safe(personalExpenses);
  const outsideTracked = Math.max(0, totalSpent - trackedSpent);
  const fixedLines = lines.filter((l) => l.ruleType === "fixed");
  const unpaidFixed = fixedLines.filter((l) => !(safe(actuals[l.id]) > 0.5));
  const wealthPlanned = Math.max(0, safe(plan?.immediateWealth));
  const wealthDone = Math.max(0, safe(completedWealth));
  const wealthRemaining = Math.max(0, wealthPlanned - wealthDone);
  const overBudget = trackedBudget > 0 && trackedSpent > trackedBudget + 0.5;
  const hasSpendingPlan = spendingLines.length > 0 && trackedBudget > 0;
  const spendingStatus = !hasSpendingPlan ? "No spending baseline"
    : overBudget ? "Above planned categories" : "Within planned categories";
  const savingsStatus = wealthPlanned <= 0 ? "No planned wealth funding"
    : wealthDone + 0.5 >= wealthPlanned ? "Planned wealth funding met"
    : "Wealth funding in progress";
  const blockers = closed ? [] : [...(closeReadiness?.hardBlockers || [])].map(String);
  const attention = [];
  if (!closed) {
    if (overBudget) attention.push({
      kind: "spending", tone: "warn",
      text: "Tracked fixed and flexible categories exceed their combined plan.",
      destination: "budget",
    });
    if (unpaidFixed.length) attention.push({
      kind: "fixed", tone: "info",
      text: `${unpaidFixed.length} of ${fixedLines.length} fixed bills have no recorded payment.`,
      destination: "budget",
    });
    if (wealthRemaining > 0.5 && wealthPlanned > 0) attention.push({
      kind: "wealth", tone: "info",
      text: "Planned wealth funding is not yet fully recorded.",
      destination: "budget",
    });
    if (blockers.length) attention.push({
      kind: "close", tone: "warn",
      text: `${blockers.length} hard month-close blocker${blockers.length === 1 ? "" : "s"} require review.`,
      destination: "close",
    });
    else if (closeReadiness?.ready) attention.push({
      kind: "close", tone: "good",
      text: "No hard month-close blockers currently detected. Confirm warnings before closing.",
      destination: "close",
    });
  }
  const account = closed ? null : accountChecks;
  const checks = account ? {
    ctbc: account.ctbc?.verified === true && Math.abs(safe(account.ctbc.difference)) < 0.5
      ? "Reconciled" : "Needs bank check",
    esun: account.esun?.verified === true && account.esun.bankOk === true && account.esun.allocationOk === true
      ? "Reconciled" : "Needs bank/purpose check",
  } : null;
  const previous = previousRecord ? {
    id: previousRecord.id,
    spending: monthlyChangeFor(totalSpent, previousRecord.expenses),
    wealth: monthlyChangeFor(wealthDone, previousRecord.wealthContribution),
    income: monthlyChangeFor(safe(periodRecord?.regularIncome), previousRecord.regularIncome),
  } : null;
  return {
    periodId: period.id, closed, snapshotBased: closed,
    spending: {
      total: totalSpent, trackedSpent, trackedBudget,
      outsideTracked, overBudget, status: spendingStatus, hasSpendingPlan,
    },
    savings: { planned: wealthPlanned, completed: wealthDone, remaining: wealthRemaining, status: savingsStatus },
    fixed: { total: fixedLines.length, paid: fixedLines.length - unpaidFixed.length, unpaid: unpaidFixed.length },
    account: checks, blockers, ready: closed ? null : !!closeReadiness?.ready,
    attention, previous,
  };
}

/**
 * Read-only personal spending drivers by category, using periodRecord.actuals
 * (historical close snapshot where available) and the CURRENT funding month's
 * frozen planSnapshot lines. No transfers, special-budget ledger or bucket
 * allocations are inputs to this function.
 */
export function spendingDriversFor({
  currentActuals = {}, previousActuals = null, planLines = [],
  categories = [], currentTotal = null, previousTotal = null,
} = {}) {
  const current = currentActuals && typeof currentActuals === "object" ? currentActuals : {};
  const suppliedPrevious = previousActuals && typeof previousActuals === "object" ? previousActuals : null;
  // Older close snapshots may store the personal spending total but have no
  // per-category historical breakdown. Never manufacture category increases
  // by treating that missing breakdown as NT$0 spent previously.
  const previousCovered = suppliedPrevious && (previousTotal === null ||
    Math.abs(Object.values(suppliedPrevious).reduce((n,v) => n + safe(v),0) - safe(previousTotal)) <= 0.5);
  const hasPrevious = !!previousCovered;
  const previous = hasPrevious ? suppliedPrevious : {};
  const names = new Map(categories.map((c) => [String(c.id), String(c.name || c.id)]));
  const planned = new Map();
  for (const line of planLines) {
    if (!line?.id || !["fixed", "cap"].includes(line.ruleType)) continue;
    const id = String(line.id);
    const amount = Math.max(0, safe(line.budgetAmount));
    planned.set(id, (planned.get(id) || 0) + amount);
    if (!names.has(id)) names.set(id, String(line.name || id));
  }
  const ids = new Set([...planned.keys(), ...Object.keys(current), ...Object.keys(previous)]);
  const rows = [...ids].map((id) => {
    const spent = safe(current[id]);
    const earlier = hasPrevious ? safe(previous[id]) : null;
    const change = hasPrevious ? spent - earlier : null;
    const budget = planned.has(id) ? planned.get(id) : null;
    const variance = budget === null ? null : spent - budget;
    return {
      id, name: names.get(id) || id, spent, previous: earlier, change,
      budget, variance, overBudget: variance !== null && variance > 0.5,
      noBudget: budget === null,
    };
  }).filter((r) => r.budget !== null || Math.abs(r.spent) > 0.5 ||
    (hasPrevious && Math.abs(r.previous) > 0.5));
  rows.sort((a,b) => b.spent - a.spent ||
    Math.abs(b.change || 0) - Math.abs(a.change || 0) || a.name.localeCompare(b.name));
  const movers = hasPrevious ? rows.filter((r) => Math.abs(r.change) > 0.5)
    .sort((a,b) => Math.abs(b.change) - Math.abs(a.change) ||
      a.name.localeCompare(b.name)).slice(0,3) : [];
  const over = rows.filter((r) => r.overBudget).sort((a,b) => b.variance - a.variance);
  const shownSpent = rows.reduce((sum,r) => sum + r.spent,0);
  return {
    rows, movers, over,
    hasPrevious,
    categoriesCount: rows.filter((r) => Math.abs(r.spent) > 0.5).length,
    shownSpent,
    unassignedCurrent: currentTotal === null ? null : safe(currentTotal) - shownSpent,
    unassignedPrevious: !hasPrevious || previousTotal === null ? null :
      safe(previousTotal) - rows.reduce((sum,r) => sum + safe(r.previous),0),
  };
}

/**
 * Compact Home insight, sourced only from the same personal-category totals and
 * frozen period plan as Spending Drivers. Excludes fixed obligations to surface
 * controllable flexible/unplanned spending rather than always ranking rent #1.
 * No history, posting, database or UI dependencies.
 */
export function spendingQuickInsightsFor({
  actuals = {}, planLines = [], categories = [], personalTotal = 0,
  maxItems = 2,
} = {}) {
  const detail = spendingDriversFor({
    currentActuals: actuals, previousActuals: null,
    planLines, categories, currentTotal: personalTotal,
  });
  const fixed = new Set([
    ...planLines.filter((r) => r?.ruleType === "fixed").map((r) => String(r.id)),
    ...categories.filter((r) => r?.ruleType === "fixed").map((r) => String(r.id)),
  ]);
  const variable = detail.rows.filter((r) => !fixed.has(r.id) && r.spent > 0.5);
  const top = variable.slice(0, Math.max(0, Math.min(5, Math.floor(safe(maxItems)))));
  const overBudgetCount = variable.filter((r) => r.overBudget).length;
  const amountUncategorized = detail.unassignedCurrent;
  const hasSpending = safe(personalTotal) > 0.5;
  return {
    top: top.map(({ id, name, spent, budget, overBudget, variance }) =>
      ({ id, name, spent, budget, overBudget, variance })),
    overBudgetCount,
    status: top.length ? "ready" : hasSpending && detail.rows.every((r) => r.spent <= 0.5)
      ? "unavailable" : "empty",
    amountUncategorized,
  };
}
