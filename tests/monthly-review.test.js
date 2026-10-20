import test from "node:test";
import assert from "node:assert/strict";
import { monthlyChangeFor, monthlyFinancialReviewFor, spendingDriversFor } from "../js/monthly-review.js";

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

const driverFixture = (overrides={}) => ({
  currentActuals: { rent: 23000, food: 11000, gas: 900, unplanned: 2700 },
  previousActuals: { rent: 23000, food: 6800, gas: 1500, oldCategory: 2000 },
  planLines: [
    { id: "rent", name: "Rent", ruleType: "fixed", budgetAmount: 23000 },
    { id: "food", name: "Food", ruleType: "cap", budgetAmount: 8500 },
    { id: "gas", name: "Gas", ruleType: "cap", budgetAmount: 1200 },
    { id: "electric-reserve", name: "Electricity Reserve", ruleType: "sinking_contribution", budgetAmount: 4000 },
  ],
  categories: [
    { id: "rent", name: "Rent" }, { id: "food", name: "Food" },
    { id: "gas", name: "Gas" }, { id: "unplanned", name: "Medical" },
    { id: "oldCategory", name: "Old Category" },
  ],
  currentTotal: 37600, previousTotal: 33300,
  ...overrides,
});

test("spending drivers rank personal categories by amount and compare individual plans", () => {
  const d = spendingDriversFor(driverFixture());
  assert.deepEqual(d.rows.map(x=>x.id), ["rent", "food", "unplanned", "gas", "oldCategory"]);
  const food = d.rows.find(x=>x.id === "food");
  assert.deepEqual({
    spent: food.spent, previous: food.previous, change: food.change,
    budget: food.budget, variance: food.variance, overBudget: food.overBudget,
  }, {
    spent:11000, previous:6800, change:4200,
    budget:8500, variance:2500, overBudget:true,
  });
  const medical = d.rows.find(x=>x.id === "unplanned");
  assert.equal(medical.name, "Medical");
  assert.equal(medical.budget, null);
  assert.equal(medical.noBudget, true);
  assert.equal(medical.change, 2700);
  assert.equal(d.over[0].id, "food");
  assert.deepEqual(d.movers.map(x=>x.id), ["food", "unplanned", "oldCategory"]);
  assert.equal(d.unassignedCurrent, 0);
  assert.equal(d.unassignedPrevious, 0);
});

test("no prior recorded period means no fake movement or percentage change", () => {
  const d = spendingDriversFor(driverFixture({ previousActuals:null, previousTotal:null }));
  assert.equal(d.hasPrevious, false);
  assert.deepEqual(d.movers, []);
  assert.equal(d.rows.find(x=>x.id === "food").previous, null);
  assert.equal(d.rows.find(x=>x.id === "food").change, null);
  assert.equal(d.unassignedPrevious, null);
});

test("zero versus absent plan are not conflated, and transfers or reserves are not spending categories", () => {
  const d = spendingDriversFor(driverFixture({
    currentActuals: { food: 200, electricReserve: 1200, unplanned: 0 },
    previousActuals: {},
    planLines:[
      { id:"food", name:"Food", ruleType:"cap", budgetAmount:0 },
      { id:"electric-reserve", name:"Electricity Reserve", ruleType:"sinking_contribution", budgetAmount: 4000 },
      { id:"wealth", name:"Wealth", ruleType:"investment_contribution", budgetAmount: 20000 },
    ],
    currentTotal:1400, previousTotal:0,
  }));
  const food = d.rows.find(x=>x.id==="food");
  assert.equal(food.noBudget, false);
  assert.equal(food.budget, 0);
  assert.equal(food.overBudget, true);
  assert.equal(d.rows.find(x=>x.id==="electricReserve").noBudget, true);
  assert.equal(d.rows.some(x=>x.id==="wealth"), false);
});

test("missing category snapshots are disclosed, and inputs never mutated", () => {
  const fixture = driverFixture({ currentTotal: 41000, previousTotal: 33300 });
  const original = structuredClone(fixture);
  const a = spendingDriversFor(fixture);
  const b = spendingDriversFor(fixture);
  assert.equal(a.unassignedCurrent, 3400);
  assert.deepEqual(a,b);
  assert.deepEqual(fixture,original);
  assert.deepEqual(spendingDriversFor().rows, []);
});

test("closed-month historical actuals are preferred as passed; renamed and missing categories degrade safely", () => {
  const d = spendingDriversFor(driverFixture({
    categories:[{ id:"food", name:"Meals & dining" }],
    currentActuals:{food:900, missingPastCategory:300},
    previousActuals:{food:1000, missingPastCategory:500},
    currentTotal:1200, previousTotal:1500,
  }));
  assert.equal(d.rows.find(x=>x.id==="food").name,"Meals & dining");
  assert.equal(d.rows.find(x=>x.id==="missingPastCategory").name,"missingPastCategory");
  assert.equal(d.rows.find(x=>x.id==="missingPastCategory").change,-200);
  assert.equal(d.unassignedCurrent, 0);
});
