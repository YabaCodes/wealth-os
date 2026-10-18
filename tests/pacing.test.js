import test from "node:test";
import assert from "node:assert/strict";
import {
  monthPaceContext,
  flexPace,
  isIrregularCap,
  capPace,
  spendingPaceStatus,
  spendingPaceFor,
} from "../js/pacing.js";

test("month pace context handles current, past and future funding months", () => {
  const current = monthPaceContext("2026-10", "2026-10-18");
  assert.deepEqual(current, { days: 31, elapsed: 18, remaining: 13, isCurrent: true, isPast: false, isFuture: false });
  assert.equal(monthPaceContext("2026-09", "2026-10-18").elapsed, 30);
  assert.equal(monthPaceContext("2026-11", "2026-10-18").elapsed, 0);
});

test("flexible pace totals only cap lines and preserves the daily mark", () => {
  const result = flexPace(
    { id: "2026-10" },
    { lines: [
      { id: "food", ruleType: "cap", budgetAmount: 10000 },
      { id: "transport", ruleType: "cap", budgetAmount: 1000 },
      { id: "rent", ruleType: "fixed", budgetAmount: 23000 },
    ] },
    { food: 4000, transport: 500, rent: 23000 },
    "2026-10-18",
  );
  assert.equal(result.capsBudget, 11000);
  assert.equal(result.capsSpent, 4500);
  assert.equal(result.todaysMark, 11000 * 18 / 31);
  assert.equal(result.tone, "good");
});

test("irregular caps are not judged by daily pacing", () => {
  assert.equal(isIrregularCap({ id: "gas", name: "Gas" }), true);
  assert.equal(isIrregularCap({ id: "x", name: "Electricity reserve" }), true);
  assert.equal(capPace({ id: "gas", name: "Gas", budgetAmount: 200 }, 100, { isCurrent: true, isPast: false, elapsed: 18, days: 31 }).noMark, true);
});

test("spending status keeps early-month and established-month thresholds", () => {
  assert.equal(spendingPaceStatus({ spent: 300, budget: 1000, elapsed: 3, days: 30 }).label, "Watch pace");
  assert.equal(spendingPaceStatus({ spent: 500, budget: 1000, elapsed: 15, days: 30 }).label, "On track");
  assert.equal(spendingPaceStatus({ spent: 1100, budget: 1000, elapsed: 15, days: 30 }).label, "Over budget");
});

test("spending pace excludes deleted, other-category and future-day expenses", () => {
  const expenses = [
    { budgetPeriodId: "2026-10", categoryId: "food", date: "2026-10-05", amount: 1000 },
    { budgetPeriodId: "2026-10", categoryId: "food", date: "2026-10-19", amount: 9000 },
    { budgetPeriodId: "2026-10", categoryId: "food", date: "2026-10-06", amount: 500, deletedAt: "x" },
    { budgetPeriodId: "2026-10", categoryId: "transport", date: "2026-10-06", amount: 999 },
  ];
  const pace = spendingPaceFor("2026-10", { id: "food", budgetAmount: 10000 }, expenses, "2026-10-18");
  assert.equal(pace.spent, 1000);
  assert.equal(pace.remainingBudget, 9000);
  assert.equal(pace.expenses.length, 1);
  assert.equal(pace.confidence, "Moderate");
});
