import test from "node:test";
import assert from "node:assert/strict";
import {
  goalBalanceFor, goalStatusFor, goalProgressFor,
  recentHistoryFor, averageCoreContributionFor, averageGoalContributionFor,
  dateAfterMonthsFor, goalPaceTextFor, wealthAccountLabels,
} from "../js/wealth-view-model.js";

const goals = [
  { id: "goal-emergency", name: "Emergency Fund", bucketId: "emergency",
    targetAmount: 300000, status: "active" },
  { id: "goal-home-trip", name: "Home Travel", bucketId: "home-trip",
    targetAmount: 100000, status: "active", prerequisiteGoalId: "goal-emergency",
    prerequisiteAmount: 200000 },
  { id: "goal-equipment", name: "Equipment", bucketId: "equipment",
    targetAmount: 40000, status: "paused" },
];
const reference = new Date(2026, 9, 18);

test("goal status uses target completion before paused/prerequisite, without mutating records", () => {
  const balances = { emergency: 195000, "home-trip": 0, equipment: 200 };
  const before = JSON.stringify([goals, balances]);
  assert.deepEqual(goalStatusFor(goals[0], goals, balances),
    { key: "active", label: "Active", className: "good-tag" });
  assert.deepEqual(goalStatusFor(goals[1], goals, balances),
    { key: "waiting", label: "Waiting", className: "warn-tag" });
  assert.deepEqual(goalStatusFor(goals[2], goals, balances),
    { key: "paused", label: "Paused", className: "" });

  const reached = { ...balances, emergency: 300000, equipment: 40000 };
  assert.equal(goalStatusFor(goals[0], goals, reached).key, "complete");
  assert.equal(goalStatusFor(goals[1], goals, reached).key, "active");
  assert.equal(goalStatusFor(goals[2], goals, reached).key, "complete");
  assert.equal(JSON.stringify([goals, balances]), before);
});

test("goal progress preserves balance, capped percentage and zero-target behavior", () => {
  assert.equal(goalBalanceFor(goals[0], { emergency: 205000 }), 205000);
  assert.deepEqual(goalProgressFor(goals[0], { emergency: 205000 }), {
    balance: 205000, target: 300000, progress: 205000 / 300000, remaining: 95000,
  });
  assert.deepEqual(goalProgressFor(goals[0], { emergency: 330000 }), {
    balance: 330000, target: 300000, progress: 1, remaining: 0,
  });
  assert.deepEqual(goalProgressFor({ bucketId: "unknown", targetAmount: 0 }, {}), {
    balance: 0, target: 0, progress: 0, remaining: 0,
  });
});

test("recent funding history uses the last N months and ignores months without regular income for pace", () => {
  const rows = [
    { id: "2026-06", regularIncome: 80000, wealthContribution: 9000 },
    { id: "2026-07", regularIncome: 81000, wealthContribution: 12000 },
    { id: "2026-08", regularIncome: 0, wealthContribution: 90000 },
    { id: "2026-09", regularIncome: 82000, wealthContribution: 15000 },
    { id: "2026-10", regularIncome: 83000, wealthContribution: 18000 },
  ];
  const snapshot = structuredClone(rows);
  const history = recentHistoryFor(rows);
  assert.deepEqual(history.map((r) => r.id), ["2026-08", "2026-09", "2026-10"]);
  assert.equal(averageCoreContributionFor(history), 16500);
  assert.equal(averageCoreContributionFor([{ regularIncome: 0, wealthContribution: 999 }]), 0);
  assert.deepEqual(rows, snapshot);
});

test("goal contribution averages over last N months, including zero-contribution months", () => {
  const history = [
    { id: "2026-08" }, { id: "2026-09" }, { id: "2026-10" },
  ];
  const amounts = { "2026-08": 10000, "2026-09": 0, "2026-10": 5000 };
  assert.equal(averageGoalContributionFor(history, "emergency", (id, bucket) =>
    bucket === "emergency" ? amounts[id] : 0), 5000);
  assert.equal(averageGoalContributionFor([], "emergency", () => 1000), 0);
});

test("goal forecast dates and pace messages preserve wording and fallback logic", () => {
  assert.equal(dateAfterMonthsFor(0, reference), "Oct 2026");
  assert.equal(dateAfterMonthsFor(1.1, reference), "Dec 2026");
  assert.equal(dateAfterMonthsFor(Infinity, reference), "—");
  assert.equal(dateAfterMonthsFor(null, reference), "—");
  let fallbackCalls = 0;
  const completed = goalPaceTextFor({
    goal: goals[0], bucketBalances: { emergency: 300000 }, recentHistory: [],
    completedAllocation: () => 0, fallbackPace: () => { fallbackCalls++; return 10000; },
    referenceDate: reference,
  });
  assert.equal(completed, "Complete");
  assert.equal(fallbackCalls, 0);
  const emergency = goalPaceTextFor({
    goal: goals[0], bucketBalances: { emergency: 195000 }, recentHistory: [],
    completedAllocation: () => 0, fallbackPace: () => { fallbackCalls++; return 5000; },
    referenceDate: reference,
  });
  assert.equal(emergency, "At current pace: Jul 2028 · ~NT$5,000/mo");
  assert.equal(fallbackCalls, 1);
  const noHistory = goalPaceTextFor({
    goal: goals[1], bucketBalances: { "home-trip": 0 }, recentHistory: [],
    completedAllocation: () => 0, fallbackPace: () => { throw new Error("Only Emergency should fall back"); },
    referenceDate: reference,
  });
  assert.equal(noHistory, "Need contribution history");
});

test("Wealth Overview reconciled and unchecked account labels preserve existing wording", () => {
  const labels = wealthAccountLabels({
    ct: { actual: 80000, verified: true, difference: 0 },
    cash: { actual: 1000, verified: false },
    es: { verified: true, bankOk: true, allocationOk: true, unassigned: 0 },
    specialBudgetReserve: 15000,
  });
  assert.deepEqual(labels, {
    operatingAvailable: 65000,
    ctStatus: "Reconciled", ctStatusClass: " good-tag",
    cashStatus: "Tracked", cashStatusClass: "",
    esStatus: "Fully reconciled", esStatusClass: " good-tag",
    allocationText: "Complete",
  });
  const notChecked = wealthAccountLabels({
    ct: { actual: 0, verified: false, difference: 0 },
    cash: { actual: 0, verified: false },
    es: { verified: false, bankOk: false, allocationOk: false, unassigned: 0 },
    specialBudgetReserve: 0,
  });
  assert.equal(notChecked.ctStatus, "Not checked");
  assert.equal(notChecked.esStatus, "Not checked");
  assert.equal(notChecked.esStatusClass, "");
});

test("E.SUN allocation health distinguishes bank and purpose mismatches without hiding the shortfall", () => {
  const base = {
    ct: { actual: 10000, verified: true, difference: 500 },
    cash: { actual: -100, verified: true },
    specialBudgetReserve: 15000,
  };
  const both = wealthAccountLabels({
    ...base,
    es: { verified: true, bankOk: false, allocationOk: false, unassigned: -500 },
  });
  assert.equal(both.operatingAvailable, -5000); // negative means oversubscribed virtual reserves
  assert.equal(both.ctStatus, "Ledger mismatch");
  assert.equal(both.ctStatusClass, " warn-tag");
  assert.equal(both.cashStatus, "Negative balance");
  assert.equal(both.esStatus, "2 items to resolve");
  assert.equal(both.allocationText, "NT$500 over-allocated");
  const bankOnly = wealthAccountLabels({
    ...base,
    es: { verified: true, bankOk: false, allocationOk: true, unassigned: 0 },
  });
  assert.equal(bankOnly.esStatus, "Ledger mismatch");
  const allocationOnly = wealthAccountLabels({
    ...base,
    es: { verified: true, bankOk: true, allocationOk: false, unassigned: 2100 },
  });
  assert.equal(allocationOnly.esStatus, "Allocation needed");
  assert.equal(allocationOnly.allocationText, "NT$2,100 unassigned");
});
