import test from "node:test";
import assert from "node:assert/strict";
import { monthlyChangeFor, monthlyFinancialReviewFor } from "../js/monthly-review.js";

const plan = {
  salary: 80000, immediateWealth: 18000,
  lines: [
    { id: "rent", name: "Rent", ruleType: "fixed", budgetAmount: 23000 },
    { id: "gym", name: "Gym", ruleType: "fixed", budgetAmount: 1200 },
    { id: "food", name: "Food", ruleType: "cap", budgetAmount: 8500 },
    { id: "internet", name: "Internet", ruleType: "cap", budgetAmount: 900 },
    { id: "reserve", name: "Reserve", ruleType: "sinking_contribution", budgetAmount: 3000 },
  ],
};
const baseline = (overrides = {}) => ({
  period: { id: "2026-10", state: "funded" }, plan,
  periodRecord: { id: "2026-10", regularIncome: 80000 },
  actuals: { rent: 23000, gym: 1200, food: 9000, internet: 900, reserve: 3000 },
  personalExpenses: 36100, completedWealth: 12000,
  previousRecord: { id: "2026-09", regularIncome: 76000, expenses: 31000, wealthContribution: 9000 },
  closeReadiness: {
    ready: false,
    hardBlockers: ["bank reconciliation incomplete", "pending transfer"],
  },
  accountChecks: {
    ctbc: { verified: true, difference: 0 }, esun: { verified: false, bankOk: false, allocationOk: false },
  },
  ...overrides,
});

test("separates tracked categories from total personal spending; reserves not treated as expenses", () => {
  const x = monthlyFinancialReviewFor(baseline());
  assert.equal(x.spending.total, 36100);
  assert.equal(x.spending.trackedBudget, 33600);
  assert.equal(x.spending.trackedSpent, 34100);
  assert.equal(x.spending.outsideTracked, 2000);
  assert.equal(x.spending.overBudget, true);
  assert.equal(x.spending.status, "Above planned categories");
  assert.equal(x.fixed.total, 2);
  assert.equal(x.fixed.paid, 2);
  assert.equal(x.savings.planned, 18000);
  assert.equal(x.savings.completed, 12000);
  assert.equal(x.savings.remaining, 6000);
  assert.deepEqual(x.blockers, ["bank reconciliation incomplete", "pending transfer"]);
  assert.equal(x.account.ctbc, "Reconciled");
  assert.equal(x.account.esun, "Needs bank/purpose check");
  assert.ok(x.attention.some((a) => a.kind === "spending"));
  assert.ok(x.attention.some((a) => a.kind === "close"));
});

test("completed transfers are only counted if passed as existing core-wealth funding", () => {
  const x = monthlyFinancialReviewFor(baseline({
    // Synthetic own-account movement is NOT included in personalExpenses.
    personalExpenses: 34100,
    completedWealth: 12000,
    actuals: { rent: 23000, gym: 1200, food: 9000, internet: 900 },
  }));
  assert.equal(x.spending.total, 34100);
  assert.equal(x.savings.completed, 12000);
  assert.equal(x.spending.outsideTracked, 0);
});

test("no fixed payment is a warning; close readiness uses only shared hard blockers", () => {
  const x = monthlyFinancialReviewFor(baseline({
    actuals: { rent: 23000, food: 1000 },
    closeReadiness: { ready: true, hardBlockers: [] },
  }));
  assert.equal(x.fixed.unpaid, 1);
  assert.equal(x.ready, true);
  assert.deepEqual(x.blockers, []);
  assert.ok(x.attention.some((a) => a.kind === "fixed"));
  assert.ok(x.attention.some((a) => a.kind === "close" && a.tone === "good"));
});

test("closed periods have no live bank checks, close blockers or action prompts", () => {
  const x = monthlyFinancialReviewFor(baseline({
    period: { id: "2026-09", state: "closed" },
    closeReadiness: { ready: false, hardBlockers: ["ignore from live month"] },
  }));
  assert.equal(x.closed, true);
  assert.equal(x.snapshotBased, true);
  assert.equal(x.ready, null);
  assert.equal(x.account, null);
  assert.deepEqual(x.blockers, []);
  assert.deepEqual(x.attention, []);
});

test("previous month absolute deltas do not invent a percentage baseline or mistake positive wealth for an expense", () => {
  const x = monthlyFinancialReviewFor(baseline());
  assert.equal(x.previous.id, "2026-09");
  assert.equal(x.previous.spending.delta, 5100);
  assert.equal(x.previous.wealth.delta, 3000);
  assert.equal(x.previous.income.delta, 4000);
  assert.equal(monthlyChangeFor(1000, 0).percent, null);
  assert.equal(monthlyChangeFor(1000, null), null);
  assert.equal(monthlyChangeFor(0, 1000).delta, -1000);
  assert.equal(monthlyFinancialReviewFor(baseline({ previousRecord: null })).previous, null);
});

test("missing plan and financial data remain conservative and do not modify original inputs", () => {
  const fixture = baseline({
    plan: { salary: 0, immediateWealth: 0, lines: [] },
    actuals: {}, previousRecord: null,
    personalExpenses: 3500, completedWealth: 0,
    closeReadiness: { ready: false, hardBlockers: ["bank check"] },
    accountChecks: null,
  });
  const frozen = structuredClone(fixture);
  const x = monthlyFinancialReviewFor(fixture);
  assert.equal(x.spending.hasSpendingPlan, false);
  assert.equal(x.spending.status, "No spending baseline");
  assert.equal(x.savings.status, "No planned wealth funding");
  assert.equal(x.spending.outsideTracked, 3500);
  assert.deepEqual(fixture, frozen);
  assert.equal(monthlyFinancialReviewFor({ period: null }), null);
});
