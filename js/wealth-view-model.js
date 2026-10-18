// Pure read-side view models for Wealth Overview and Goals.
// Inputs are in-memory snapshots only. No DOM, IndexedDB or mutable app state.
import { money } from "./calc.js";

export function goalBalanceFor(goal, bucketBalances) {
  return Number(bucketBalances[goal.bucketId] || 0);
}

export function goalStatusFor(goal, goals, bucketBalances) {
  const balance = goalBalanceFor(goal, bucketBalances);
  const target = Number(goal.targetAmount || 0);
  if (target > 0 && balance >= target) return { key: "complete", label: "Complete", className: "good-tag" };
  if (goal.status === "paused") return { key: "paused", label: "Paused", className: "" };
  if (goal.prerequisiteGoalId) {
    const prerequisite = goals.find((g) => g.id === goal.prerequisiteGoalId);
    if (prerequisite && goalBalanceFor(prerequisite, bucketBalances) < Number(goal.prerequisiteAmount || 0))
      return { key: "waiting", label: "Waiting", className: "warn-tag" };
  }
  return { key: "active", label: "Active", className: "good-tag" };
}

export function goalProgressFor(goal, bucketBalances) {
  const balance = goalBalanceFor(goal, bucketBalances);
  const target = Number(goal.targetAmount || 0);
  return {
    balance,
    target,
    progress: target ? Math.min(1, balance / target) : 0,
    remaining: Math.max(0, target - balance),
  };
}

export function recentHistoryFor(records, count = 3) {
  return records.slice(-count);
}

export function averageCoreContributionFor(records) {
  const rows = records.filter((row) => row.regularIncome > 0);
  return rows.length ? rows.reduce((sum, row) => sum + row.wealthContribution, 0) / rows.length : 0;
}

export function averageGoalContributionFor(records, bucketId, completedAllocation) {
  if (!records.length) return 0;
  return records.reduce((sum, row) => sum + completedAllocation(row.id, bucketId), 0) / records.length;
}

// Keeping a supplied reference date makes forecasts deterministic in the test suite.
export function dateAfterMonthsFor(months, referenceDate = new Date()) {
  if (months === null || months === undefined || !isFinite(months)) return "—";
  const date = new Date(referenceDate);
  date.setDate(1);
  date.setMonth(date.getMonth() + Math.max(0, Math.ceil(months)));
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(date);
}

export function goalPaceTextFor({
  goal, bucketBalances, recentHistory, completedAllocation, fallbackPace,
  referenceDate = new Date(),
}) {
  const balance = goalBalanceFor(goal, bucketBalances);
  const remaining = Math.max(0, Number(goal.targetAmount || 0) - balance);
  if (remaining <= 0) return "Complete";
  let pace = averageGoalContributionFor(recentHistory, goal.bucketId, completedAllocation);
  if (goal.id === "goal-emergency" && pace <= 0) pace = fallbackPace();
  if (pace <= 0) return "Need contribution history";
  const months = Math.ceil(remaining / pace);
  return `At current pace: ${dateAfterMonthsFor(months, referenceDate)} · ~${money(pace)}/mo`;
}

export function wealthAccountLabels({ ct, cash, es, specialBudgetReserve }) {
  const operatingAvailable = Number(ct.actual || 0) - specialBudgetReserve;
  const ctStatus = !ct.verified ? "Not checked" : Math.abs(ct.difference) < 0.5 ? "Reconciled" : "Ledger mismatch";
  const ctStatusClass = !ct.verified ? "" : Math.abs(ct.difference) < 0.5 ? " good-tag" : " warn-tag";
  const cashStatus = cash.actual < -0.5 ? "Negative balance" : cash.verified ? "Counted" : "Tracked";
  const cashStatusClass = cash.actual < -0.5 ? " warn-tag" : cash.verified ? " good-tag" : "";
  let esStatus = "Not checked";
  let esStatusClass = "";
  if (es.verified) {
    if (es.bankOk && es.allocationOk) {
      esStatus = "Fully reconciled";
      esStatusClass = " good-tag";
    } else if (!es.bankOk && !es.allocationOk) {
      esStatus = "2 items to resolve";
      esStatusClass = " warn-tag";
    } else if (!es.bankOk) {
      esStatus = "Ledger mismatch";
      esStatusClass = " warn-tag";
    } else {
      esStatus = "Allocation needed";
      esStatusClass = " warn-tag";
    }
  }
  const allocationText = es.allocationOk
    ? "Complete"
    : es.unassigned > 0
      ? `${money(es.unassigned)} unassigned`
      : `${money(Math.abs(es.unassigned))} over-allocated`;
  return {
    operatingAvailable,
    ctStatus, ctStatusClass,
    cashStatus, cashStatusClass,
    esStatus, esStatusClass,
    allocationText,
  };
}
