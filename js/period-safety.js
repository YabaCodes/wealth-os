// Period-linked editing and budget-plan refresh; no UI or side effects outside periods.
// The guard and persisted sync are shared by the app and IndexedDB regression tests.
import { getOne, put } from "./db.js";
import { buildBudgetPlan, allocateGoalSurplus } from "./calc.js";

export function isClosedPeriod(periods, periodId) {
  return (periods || []).some((period) => period.id === periodId && period.state === "closed");
}

export function assertPeriodEditable(periods, periodId, label = (id) => id) {
  if (periodId && isClosedPeriod(periods, periodId)) {
    throw new Error(`${label(periodId)} is closed. Reopen the month before changing period-linked records.`);
  }
}

/**
 * Refresh ONLY a persisted open funding month's plan and payday routing preview.
 * Nothing in incomes, expenses, transfers, allocations, reconciliations, or
 * monthlyCloses is written. Recheck persisted state to reject stale open views.
 */
export async function syncOpenMonthPlanPersisted({
  selected, categories, settings, stamp, salary, goals, buckets,
  bucketBalances, completedAllocationToBucket,
}) {
  if (!selected || selected.state === "closed") return false;
  const persisted = await getOne("periods", selected.id);
  if (!persisted || persisted.state === "closed") return false;

  const newPlan = buildBudgetPlan({ income: salary, categories, settings });
  const preBalances = { ...bucketBalances };
  for (const b of buckets) {
    preBalances[b.id] = Number(preBalances[b.id] || 0) -
      Number(completedAllocationToBucket(b.id) || 0);
  }
  const goalAllocs = allocateGoalSurplus({
    amount: Math.max(0, Math.round(newPlan.immediateWealth)),
    goals,
    bucketBalances: preBalances,
  });
  await put("periods", {
    ...persisted,
    planSnapshot: newPlan,
    paydayRoutingSnapshot: {
      goalAllocs: goalAllocs.map((a) => ({ ...a })),
      createdAt: stamp,
      reason: "budget_sync",
    },
    budgetRulesUpdatedAt: stamp,
    budgetRevision: Number(persisted.budgetRevision || 0) + 1,
    updatedAt: stamp,
  });
  return true;
}
