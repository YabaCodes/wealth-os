import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateExpenses,
  allocateGoalSurplus,
  buildBudgetPlan,
  calculateSweep,
  forecastMonthsToTarget,
  simulateWealthStrategy,
} from "../js/calc.js";

test("budget plan preserves the payday allocation equation", () => {
  const categories = [
    { id: "tithe", active: true, sort: 1, ruleType: "percentage", defaultAmount: 10 },
    { id: "fixed", active: true, sort: 2, ruleType: "fixed", defaultAmount: 37676 },
    { id: "caps", active: true, sort: 3, ruleType: "cap", defaultAmount: 15700 },
    { id: "reserve", active: true, sort: 4, ruleType: "sinking_contribution", defaultAmount: 4400 },
    { id: "buffer", active: true, sort: 5, ruleType: "buffer", defaultAmount: 3000 },
  ];
  const plan = buildBudgetPlan({ income: 79721, categories, settings: {} });
  assert.equal(plan.tithe, 7972.1);
  assert.equal(plan.fixed, 37676);
  assert.equal(plan.caps, 15700);
  assert.equal(plan.sinking, 4400);
  assert.equal(plan.buffer, 3000);
  assert.ok(Math.abs(plan.assignedBeforeWealth + plan.immediateWealth - plan.salary) < 1e-9);
  assert.ok(Math.abs(plan.immediateWealth - 10972.9) < 1e-9);
});

test("month-end sweep nets flexible underspend, overspend and paid bill differences", () => {
  const budgetLines = [
    { id: "food", ruleType: "cap", budgetAmount: 10000 },
    { id: "social", ruleType: "cap", budgetAmount: 3000 },
    { id: "buffer", ruleType: "buffer", budgetAmount: 3000 },
    { id: "phone", ruleType: "fixed", budgetAmount: 799 },
    { id: "wifi", ruleType: "fixed", budgetAmount: 899 },
    { id: "unpaid", ruleType: "fixed", budgetAmount: 1000 },
  ];
  const result = calculateSweep({
    budgetLines,
    expenseTotals: { food: 8500, social: 3400, phone: 790, wifi: 910 },
    includeFixedBills: true,
  });
  assert.deepEqual(result, {
    grossUnused: 4509,
    deficits: 411,
    billSavings: 9,
    billOverages: 11,
    available: 4098,
    net: 4098,
  });
});

test("goal routing unlocks the monthly travel target then continues the emergency fund", () => {
  const goals = [
    { id: "em", name: "Emergency Fund", bucketId: "emergency", type: "core_wealth", targetAmount: 300000, priority: 1, status: "active" },
    {
      id: "travel",
      name: "Home Travel",
      bucketId: "home-trip",
      type: "planned_spending",
      targetAmount: 100000,
      monthlyTarget: 10000,
      prerequisiteGoalId: "em",
      prerequisiteAmount: 200000,
      priority: 2,
      status: "active",
    },
  ];
  const allocations = allocateGoalSurplus({
    amount: 11073,
    goals,
    bucketBalances: { emergency: 205000, "home-trip": 0 },
  });
  assert.deepEqual(allocations.map(({ goalId, amount, destination }) => ({ goalId, amount, destination })), [
    { goalId: "travel", amount: 10000, destination: "bucket" },
    { goalId: "em", amount: 1073, destination: "bucket" },
  ]);
});

test("surplus routes to investments only after eligible cash goals are full", () => {
  const goals = [
    { id: "em", name: "Emergency Fund", bucketId: "emergency", type: "core_wealth", targetAmount: 300000, priority: 1, status: "active" },
    {
      id: "travel",
      name: "Home Travel",
      bucketId: "home-trip",
      type: "planned_spending",
      targetAmount: 100000,
      monthlyTarget: 10000,
      prerequisiteGoalId: "em",
      prerequisiteAmount: 200000,
      priority: 2,
      status: "active",
    },
  ];
  const allocations = allocateGoalSurplus({
    amount: 5000,
    goals,
    bucketBalances: { emergency: 300000, "home-trip": 100000 },
  });
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].destination, "investment");
  assert.equal(allocations[0].accountId, "ibkr");
  assert.equal(allocations[0].amount, 5000);
});

test("expense aggregation excludes deleted records and other funding months", () => {
  const totals = aggregateExpenses(
    [
      { budgetPeriodId: "2026-10", categoryId: "food", amount: 100 },
      { budgetPeriodId: "2026-10", categoryId: "food", amount: 50, deletedAt: "x" },
      { budgetPeriodId: "2026-10", categoryId: "transport", amount: 25 },
      { budgetPeriodId: "2026-11", categoryId: "food", amount: 999 },
    ],
    "2026-10",
  );
  assert.deepEqual(totals, { food: 100, transport: 25 });
});

test("wealth simulation does not route travel money before the emergency unlock is reached", () => {
  const result = simulateWealthStrategy({
    emergencyStart: 195000,
    travelStart: 0,
    investmentStart: 0,
    monthlyCapacity: 11073,
    annualReturn: 0,
    emergencyUnlock: 200000,
    emergencyTarget: 300000,
    travelTarget: 100000,
    travelMonthly: 10000,
    months: 2,
  });
  assert.equal(result.events.travelUnlockMonth, 1);
  assert.equal(result.travel, 10000);
  assert.equal(result.emergency, 207146);
});

test("forecastMonthsToTarget handles completed and impossible targets", () => {
  assert.equal(forecastMonthsToTarget({ start: 100, monthly: 10, annualReturn: 0, target: 100 }), 0);
  assert.equal(forecastMonthsToTarget({ start: 0, monthly: 0, annualReturn: 0, target: 100 }), Infinity);
  assert.equal(forecastMonthsToTarget({ start: 0, monthly: 25, annualReturn: 0, target: 100 }), 4);
});
