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
