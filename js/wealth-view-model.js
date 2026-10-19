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

/**
 * A read-only illustration of extra monthly funding directed to ONE goal.
 *
 * The baseline includes only completed contributions actually recorded against
 * the goal's bucket over the latest available three funding periods. It does
 * not promise that ordinary Wealth OS routing will send the hypothetical extra
 * amount there; no transaction, budget rule or goal state is ever changed.
 */
export function goalWhatIfFor({
  goal, goals = [], bucketBalances = {}, recentHistory = [],
  completedAllocation = () => 0, extraMonthly = 0, referenceDate = new Date(),
}) {
  if (!goal) return null;
  const { balance, target, remaining } = goalProgressFor(goal, bucketBalances);
  const status = goalStatusFor(goal, goals, bucketBalances);
  const recorded = averageGoalContributionFor(recentHistory, goal.bucketId, completedAllocation);
  const baseMonthly = Math.max(0, Number.isFinite(recorded) ? recorded : 0);
  const entered = Number(extraMonthly);
  const extra = Number.isFinite(entered) ? Math.min(1_000_000, Math.max(0, entered)) : 0;
  const scenarioMonthly = baseMonthly + extra;
  const canProject = status.key === "active" && target > 0;
  const baseMonths = canProject && baseMonthly > 0 ? Math.ceil(remaining / baseMonthly) : null;
  const scenarioMonths = canProject && scenarioMonthly > 0 ? Math.ceil(remaining / scenarioMonthly) : null;
  return {
    status: status.key,
    balance,
    target,
    remaining,
    baseMonthly,
    extraMonthly: extra,
    scenarioMonthly,
    baseMonths,
    scenarioMonths,
    baseDate: baseMonths === null ? null : dateAfterMonthsFor(baseMonths, referenceDate),
    scenarioDate: scenarioMonths === null ? null : dateAfterMonthsFor(scenarioMonths, referenceDate),
    monthsSaved: baseMonths === null || scenarioMonths === null ? null : Math.max(0, baseMonths - scenarioMonths),
  };
}

/**
 * Target-date funding illustration, with deposits assumed at the END of each
 * calendar month, starting the month after the reference date.
 * A date earlier than that month's final day cannot count that month's deposit.
 * This planner never modifies an account or the user's routing rules.
 */
export function goalTargetDateFor({
  goal, goals = [], bucketBalances = {}, recentHistory = [],
  completedAllocation = () => 0, deadline = "",
  monthlyCapacity = null, referenceDate = new Date(),
}) {
  if (!goal) return null;
  const { balance, target, remaining } = goalProgressFor(goal, bucketBalances);
  const status = goalStatusFor(goal, goals, bucketBalances).key;
  const recorded = averageGoalContributionFor(recentHistory, goal.bucketId, completedAllocation);
  const recordedMonthly = Math.max(0, Number.isFinite(recorded) ? recorded : 0);
  const capacity = monthlyCapacity !== null && monthlyCapacity !== undefined &&
    Number.isFinite(Number(monthlyCapacity)) && Number(monthlyCapacity) >= 0
      ? Number(monthlyCapacity) : null;
  const basic = {
    status, balance, target, remaining, recordedMonthly,
    capacity, deadline, months: 0, requiredMonthly: null,
    additionalMonthly: null, capacityGap: null, feasibility: "unknown",
    recordedDate: null, capacityDate: null, reason: null,
  };
  // Invalid date and locked goals must NEVER suggest a feasible funding date.
  if (status === "complete") return { ...basic, reason: "complete" };
  if (status === "paused") return { ...basic, reason: "paused" };
  if (status === "waiting") return { ...basic, reason: "waiting" };
  if (!(target > 0)) return { ...basic, reason: "no-target" };
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(String(deadline));
  if (!match) return { ...basic, reason: "invalid-date" };
  const [, ys, ms, ds] = match;
  const year = Number(ys), month = Number(ms), day = Number(ds);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 ||
      day < 1 || day > new Date(year, month, 0).getDate())
    return { ...basic, reason: "invalid-date" };
  const ref = new Date(referenceDate);
  if (!Number.isFinite(ref.getTime()))
    return { ...basic, reason: "invalid-date" };
  const finalDay = new Date(year, month, 0).getDate();
  // If the deadline is mid-month, that month's end-of-month contribution
  // would arrive too late. Only complete future month-ends are eligible.
  const months = Math.max(0,
    (year - ref.getFullYear()) * 12 + month - (ref.getMonth() + 1) -
    (day < finalDay ? 1 : 0));
  if (months < 1) return { ...basic, months, reason: "no-paydays" };
  const requiredMonthly = Math.ceil(remaining / months);
  const additionalMonthly = Math.max(0, requiredMonthly - recordedMonthly);
  const capacityGap = capacity === null ? null : Math.max(0, requiredMonthly - capacity);
  const feasibility = capacity === null ? "unknown" :
    requiredMonthly > capacity ? "above-plan" : "within-plan";
  return {
    ...basic, months, requiredMonthly, additionalMonthly, capacityGap, feasibility,
    recordedDate: recordedMonthly > 0
      ? dateAfterMonthsFor(Math.ceil(remaining / recordedMonthly), ref) : null,
    capacityDate: capacity > 0
      ? dateAfterMonthsFor(Math.ceil(remaining / capacity), ref) : null,
    reason: null,
  };
}
